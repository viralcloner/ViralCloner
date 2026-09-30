const { attachChatGPTReferenceImage } = require('../lib/chatgptReferenceUpload');
const { collectGeneratedImages } = require('../lib/chatgptGeneratedImages');
/**
 * ChatGPT Image Generation Module
 * Uses browser automation to interact with ChatGPT's image generation
 * Includes queue system, workflow management, and proper resource cleanup
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { readKey, updateData, moveToPermStorage } = require('../lib/utils');
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('../lib/cdpFingerprint');

// ============ CONFIGURATION ============
const MAX_CONCURRENT = 1;                    // Max concurrent requests per ChatGPT profile
const REQUEST_DELAY_MS = 1500;               // Delay between requests (1.5s - reduced from 3s for perf)
const BROWSER_CLOSE_COOLDOWN_MS = 3000;      // Wait 3s after browser close before launching new one (prevents EBUSY)
const IMAGE_REFRESH_INTERVAL_MS = 60 * 1000; // Recover a stalled ChatGPT UI while waiting
const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;      // 5 minutes timeout for image generation (complex prompts need more time)
const CONVERSATION_REDIRECT_TIMEOUT_MS = 35000; // 35s for redirect to conversation
const MIN_IMAGE_SIZE_BYTES = 500 * 1024;     // Minimum 500KB - valid ChatGPT images are usually 1.5MB+
const IMAGE_DOWNLOAD_RETRY_DELAY_MS = 2000;  // Wait 2s between download retries (reduced from 3s)
const MAX_IMAGE_DOWNLOAD_RETRIES = 5;        // Retry downloading up to 5 times

// Rate limit handling
// Note: Rate limit wait time is ADDED to IMAGE_TIMEOUT_MS, not included in it
// So worst case: (10 min wait + 5 min gen) × 2 retries = ~30 minutes max
// The workflow node will NOT timeout during rate limit wait because the wait
// happens in executeWithRateLimitRetry() which is outside the image generation timeout
const RATE_LIMIT_DEFAULT_WAIT_MS = 10 * 60 * 1000;  // 10 minutes default if we can't parse the wait time
const RATE_LIMIT_CHECK_INTERVAL = 5;               // Check for rate limit every N polls
const RATE_LIMIT_MAX_RETRIES = 2;                  // Max retry attempts after rate limit wait

// Temp directory for downloaded images
const TEMP_DIR = path.join(app.getPath('userData'), 'Uploads', 'Temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function diagLog(message) {
    console.log(`[ChatGPT Image] ${message}`);
}

function getActiveImageBlock(profileData) {
    const blockedUntil = profileData?.imageBlockedUntil;
    if (!blockedUntil) return null;

    const blockedUntilMs = Date.parse(blockedUntil);
    if (!Number.isFinite(blockedUntilMs) || blockedUntilMs <= Date.now()) return null;

    return {
        blockedUntil,
        reason: profileData.imageBlockedReason || 'ChatGPT image generation limit reached'
    };
}

async function saveImageBlock(profileId, blockInfo) {
    const openaiProfiles = readKey('openaiProfiles') || {};
    const profile = openaiProfiles[profileId];
    if (!profile) return;

    profile.imageBlockedUntil = blockInfo.blockedUntil;
    profile.imageBlockedReason = blockInfo.reason;
    profile.imageBlockedAt = new Date().toISOString();
    profile.imageGenerationStatus = 'blocked';
    await updateData('openaiProfiles', openaiProfiles);
    console.warn(`[ChatGPT Image] Profile ${profileId.substring(0, 8)}... blocked until ${blockInfo.blockedUntil}`);
}

async function checkImageGenerationAvailability(Runtime) {
    const result = await Runtime.evaluate({
        expression: `
(async function() {
    try {
        const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
        if (!sessionResponse.ok) {
            return { checked: false, error: 'Session HTTP ' + sessionResponse.status };
        }
        const session = await sessionResponse.json();
        if (!session.accessToken) return { checked: false, error: 'No access token' };

        const deviceMatch = document.cookie.match(/(?:^|;\\s*)oai-did=([^;]+)/);
        const headers = {
            'accept': '*/*',
            'authorization': 'Bearer ' + session.accessToken,
            'content-type': 'application/json',
            'oai-language': navigator.language || 'en-US',
            'x-openai-target-path': '/backend-api/conversation/init',
            'x-openai-target-route': '/backend-api/conversation/init'
        };
        if (deviceMatch) headers['oai-device-id'] = decodeURIComponent(deviceMatch[1]);

        const response = await fetch('/backend-api/conversation/init', {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
                requested_default_model: null,
                conversation_id: null,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                timezone_offset_min: new Date().getTimezoneOffset(),
                conversation_origin: null
            })
        });
        if (!response.ok) return { checked: false, error: 'Init HTTP ' + response.status };

        const data = await response.json();
        const blockedFeature = (data.blocked_features || []).find(function(feature) {
            return feature.name === 'image_gen';
        });
        const limitProgress = (data.limits_progress || []).find(function(limit) {
            return limit.feature_name === 'image_gen' && Number(limit.remaining) <= 0;
        });
        const blockedUntil = blockedFeature?.resets_after || limitProgress?.reset_after || null;

        return {
            checked: true,
            blocked: !!(blockedFeature || limitProgress),
            blockedUntil,
            reason: blockedFeature?.description || 'ChatGPT image generation limit reached'
        };
    } catch (error) {
        return { checked: false, error: error.message };
    }
})()`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 30000
    });

    return result.result?.value || { checked: false, error: 'No availability response' };
}

// ============ STATE MANAGEMENT ============
// Queue system per profile: { queue: [], activeCount: 0, lastRequestTime: 0, processing: false }
const profileQueues = new Map();

// Pending requests: requestKey -> { prompt, workflowId, resolve, reject, profileId, startTime }
const pendingRequests = new Map();

// Workflow tracking: workflowId -> Set of requestKeys
const workflowRequests = new Map();

// AbortControllers for rate-limit sleeps: requestKey -> AbortController
// Used to interrupt sleep when workflow is stopped/rerun
const rateLimitAbortControllers = new Map();

// Cancellation state and browser handles for active requests.
const requestAbortControllers = new Map();
const activeRequestBrowsers = new Map();

// Track when each profile's browser was last closed (for cooldown period)
// Prevents launching new browser too quickly after close (causes EBUSY file lock errors)
const lastBrowserCloseTime = new Map();

// Request counter for unique keys
let requestCounter = 0;

// ============ QUEUE MANAGEMENT ============

function getProfileQueue(profileId) {
    if (!profileQueues.has(profileId)) {
        profileQueues.set(profileId, { 
            queue: [], 
            activeCount: 0, 
            lastRequestTime: 0, 
            processing: false 
        });
    }
    return profileQueues.get(profileId);
}

function generateRequestKey(profileId) {
    return `${profileId}:${Date.now()}:${++requestCounter}`;
}

async function processQueue(profileId) {
    const queueData = getProfileQueue(profileId);
    
    // Prevent concurrent processQueue executions
    if (queueData.processing) return;
    queueData.processing = true;
    
    try {
        while (queueData.queue.length > 0 && queueData.activeCount < MAX_CONCURRENT) {
            const now = Date.now();
            const timeSinceLastRequest = now - queueData.lastRequestTime;
            
            // Respect delay between requests
            if (queueData.lastRequestTime > 0 && timeSinceLastRequest < REQUEST_DELAY_MS) {
                const waitTime = REQUEST_DELAY_MS - timeSinceLastRequest;
                console.log(`[ChatGPT Image] Waiting ${waitTime}ms before next request...`);
                await new Promise(r => setTimeout(r, waitTime));
            }
            
            // Wait for browser close cooldown (prevents EBUSY errors from profile file locks)
            const lastCloseTime = lastBrowserCloseTime.get(profileId) || 0;
            const timeSinceClose = Date.now() - lastCloseTime;
            if (lastCloseTime > 0 && timeSinceClose < BROWSER_CLOSE_COOLDOWN_MS) {
                const cooldownWait = BROWSER_CLOSE_COOLDOWN_MS - timeSinceClose;
                console.log(`[ChatGPT Image] Waiting ${cooldownWait}ms for browser cooldown (profile file release)...`);
                await new Promise(r => setTimeout(r, cooldownWait));
            }
            
            // Double-check capacity after waiting
            if (queueData.activeCount >= MAX_CONCURRENT) break;
            
            const task = queueData.queue.shift();
            
            // Skip null placeholders (will be filled in shortly by startImageRequest)
            if (!task) {
                // Put it back and wait a bit for it to be filled
                if (task === null) {
                    queueData.queue.unshift(null);
                    await new Promise(r => setTimeout(r, 10));
                }
                continue;
            }
            
            queueData.activeCount++;
            queueData.lastRequestTime = Date.now();
            
            console.log(`[ChatGPT Image] Processing request for ${profileId.substring(0, 8)}... Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
            
            // Execute with rate limit retry wrapper - runs in background
            executeWithRateLimitRetry(task, 0);
        }
    } finally {
        queueData.processing = false;
    }
}

function onRequestComplete(profileId, requestKey) {
    const queueData = getProfileQueue(profileId);
    const shortKey = requestKey.substring(0, 20);
    
    diagLog(`onRequestComplete ENTER - requestKey: ${shortKey}, profileId: ${profileId?.substring(0, 8)}, activeCount: ${queueData.activeCount}`);
    
    // Check if this request is in rate limit wait (will be retried)
    // Keep the slot reserved - don't decrement activeCount, don't process queue
    // The retry will reuse this slot when it starts the new browser
    const request = pendingRequests.get(requestKey);
    if (request?.isRateLimitWait) {
        diagLog(`onRequestComplete RATE_LIMIT_WAIT - requestKey: ${shortKey}, keeping slot reserved`);
        console.log(`[ChatGPT Image] Request in rate limit wait, keeping slot reserved for retry. Active: ${queueData.activeCount}/${MAX_CONCURRENT}`);
        // DON'T decrement activeCount - slot is reserved for retry
        // DON'T process queue - we're not releasing a slot
        return;
    }
    
    // Normal completion - now decrement activeCount
    queueData.activeCount = Math.max(0, queueData.activeCount - 1);
    diagLog(`onRequestComplete DECREMENT - requestKey: ${shortKey}, newActiveCount: ${queueData.activeCount}`);
    
    // Full cleanup for completed requests
    pendingRequests.delete(requestKey);
    
    // Clean up any lingering rate-limit abort controller
    if (rateLimitAbortControllers.has(requestKey)) {
        rateLimitAbortControllers.delete(requestKey);
    }
    requestAbortControllers.delete(requestKey);
    activeRequestBrowsers.delete(requestKey);
    
    // Clean up from workflow tracking
    for (const [workflowId, requestKeys] of workflowRequests.entries()) {
        requestKeys.delete(requestKey);
        if (requestKeys.size === 0) {
            workflowRequests.delete(workflowId);
        }
    }
    
    diagLog(`onRequestComplete DONE - requestKey: ${shortKey}, active: ${queueData.activeCount}, queued: ${queueData.queue.length}`);
    console.log(`[ChatGPT Image] Request complete. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
    
    // Process next in queue
    processQueue(profileId);
}

/**
 * Execute image request with automatic rate limit retry
 * If rate limited, waits the specified time and retries
 * @param {Object} task - The task object with requestKey, profileId, prompt, etc.
 * @param {number} retryCount - Current retry attempt number
 */
async function executeWithRateLimitRetry(task, retryCount) {
    const { requestKey, profileId, prompt, imagePath, workflowId, resolve } = task;
    const shortKey = requestKey.substring(0, 20);
    
    diagLog(`executeWithRateLimitRetry ENTRY - requestKey: ${shortKey}, retryCount: ${retryCount}, workflowId: ${workflowId}, profileId: ${profileId?.substring(0, 8)}`);
    
    // Create a wrapper that catches rate limit errors
    const wrappedResolve = async (result) => {
        diagLog(`wrappedResolve CALLED - requestKey: ${shortKey}, success: ${result.success}, code: ${result.code}, valuePreview: ${String(result.value).substring(0, 100)}`);
        // Check if this is a rate limit error
        if (!result.success && result.value?.startsWith?.('RATE_LIMITED:')) {
            const waitMs = parseInt(result.value.split(':')[1]) || RATE_LIMIT_DEFAULT_WAIT_MS;
            const waitMinutes = Math.ceil(waitMs / 60000);
            
            diagLog(`RATE_LIMIT detected in wrappedResolve - requestKey: ${shortKey}, waitMs: ${waitMs}, waitMinutes: ${waitMinutes}, retryCount: ${retryCount}/${RATE_LIMIT_MAX_RETRIES}`);
            
            if (retryCount < RATE_LIMIT_MAX_RETRIES) {
                diagLog(`Starting rate limit wait - requestKey: ${shortKey}, waitMinutes: ${waitMinutes}, retry: ${retryCount + 1}/${RATE_LIMIT_MAX_RETRIES}`);
                console.log(`[ChatGPT Image] Rate limited! Waiting ${waitMinutes} minutes before retry ${retryCount + 1}/${RATE_LIMIT_MAX_RETRIES}...`);
                
                // Re-add to pendingRequests before waiting (it was removed by onRequestComplete in finally block)
                // This allows stopWorkflowQueues to properly cancel the request during the wait
                pendingRequests.set(requestKey, {
                    prompt,
                    imagePath,
                    workflowId,
                    profileId,
                    startTime: Date.now(),
                    resolve,
                    isRateLimitWait: true
                });
                
                // Also re-add to workflow tracking if applicable
                if (workflowId) {
                    if (!workflowRequests.has(workflowId)) {
                        workflowRequests.set(workflowId, new Set());
                    }
                    workflowRequests.get(workflowId).add(requestKey);
                }
                
                // Create AbortController for interruptible sleep
                const abortController = new AbortController();
                rateLimitAbortControllers.set(requestKey, abortController);
                
                // Wait the specified time (add a small buffer) - INTERRUPTIBLE
                const actualWaitMs = waitMs + 10000; // Add 10 seconds buffer
                const sleepStartTime = Date.now();
                let wasAborted = false;
                
                diagLog(`SLEEP_START - requestKey: ${shortKey}, actualWaitMs: ${actualWaitMs}, expectedEndTime: ${new Date(Date.now() + actualWaitMs).toISOString()}`);
                
                try {
                    await new Promise((sleepResolve, sleepReject) => {
                        const timeoutId = setTimeout(sleepResolve, actualWaitMs);
                        
                        // Heartbeat logging every 30 seconds during sleep
                        const heartbeatInterval = setInterval(() => {
                            const elapsed = Math.round((Date.now() - sleepStartTime) / 1000);
                            const remaining = Math.round((actualWaitMs - (Date.now() - sleepStartTime)) / 1000);
                            diagLog(`SLEEP_HEARTBEAT - requestKey: ${shortKey}, elapsed: ${elapsed}s, remaining: ${remaining}s, pendingExists: ${pendingRequests.has(requestKey)}`);
                        }, 30000);
                        
                        abortController.signal.addEventListener('abort', () => {
                            clearTimeout(timeoutId);
                            clearInterval(heartbeatInterval);
                            sleepReject(new Error('ABORTED'));
                        });
                        
                        // Clear heartbeat when sleep completes normally
                        const originalResolve = sleepResolve;
                        sleepResolve = () => {
                            clearInterval(heartbeatInterval);
                            originalResolve();
                        };
                        
                        // Re-set the timeout with the wrapped resolve
                        clearTimeout(timeoutId);
                        setTimeout(sleepResolve, actualWaitMs);
                    });
                    
                    diagLog(`SLEEP_COMPLETED - requestKey: ${shortKey}, actualDuration: ${Date.now() - sleepStartTime}ms`);
                    
                } catch (sleepErr) {
                    if (sleepErr.message === 'ABORTED') {
                        wasAborted = true;
                        diagLog(`SLEEP_ABORTED - requestKey: ${shortKey}, duration: ${Date.now() - sleepStartTime}ms`);
                        console.log('[ChatGPT Image] Rate limit sleep was interrupted (workflow stopped/rerun)');
                    } else {
                        diagLog(`SLEEP_ERROR - requestKey: ${shortKey}, error: ${sleepErr.message}`);
                        throw sleepErr;
                    }
                } finally {
                    rateLimitAbortControllers.delete(requestKey);
                }
                
                // Check if workflow was stopped during the wait
                diagLog(`POST_SLEEP_CHECK - requestKey: ${shortKey}, wasAborted: ${wasAborted}, pendingExists: ${pendingRequests.has(requestKey)}`);
                
                if (wasAborted || !pendingRequests.has(requestKey)) {
                    diagLog(`WORKFLOW_STOPPED_DURING_WAIT - requestKey: ${shortKey}, returning without retry`);
                    console.log('[ChatGPT Image] Workflow was stopped during rate limit wait');
                    // Don't call resolve() here - stopWorkflowQueues already resolved it
                    return;
                }
                
                console.log(`[ChatGPT Image] Rate limit wait complete, retrying...`);
                
                // Clear the rate limit wait flag so future onRequestComplete calls work correctly
                const existingRequest = pendingRequests.get(requestKey);
                if (existingRequest) {
                    existingRequest.isRateLimitWait = false;
                    diagLog(`CLEARED_RATE_LIMIT_FLAG - requestKey: ${shortKey}`);
                } else {
                    diagLog(`WARNING: existingRequest NOT_FOUND when clearing flag - requestKey: ${shortKey}`);
                }
                
                // Retry with incremented count
                diagLog(`RETRY_CALL - requestKey: ${shortKey}, newRetryCount: ${retryCount + 1}`);
                executeWithRateLimitRetry(task, retryCount + 1);
                return;
            }
            
            // Max retries exceeded
            diagLog(`MAX_RETRIES_EXCEEDED - requestKey: ${shortKey}, retryCount: ${retryCount}`);
            console.log(`[ChatGPT Image] Rate limit max retries (${RATE_LIMIT_MAX_RETRIES}) exceeded`);
            
            // CRITICAL: Clear the rate limit wait flag so onRequestComplete properly frees the slot
            // Without this, the slot stays reserved forever and the profile is permanently stuck
            const failedRequest = pendingRequests.get(requestKey);
            if (failedRequest) {
                failedRequest.isRateLimitWait = false;
                diagLog(`MAX_RETRIES_FLAG_CLEARED - requestKey: ${shortKey}`);
            }
            
            resolve({
                success: false,
                code: 'RATE_LIMITED',
                value: `Rate limited by ChatGPT. Waited ${waitMinutes} minutes but still limited after ${retryCount} retries.`
            });
            return;
        }
        
        // Not a rate limit error, pass through normally
        diagLog(`RESOLVE_FINAL - requestKey: ${shortKey}, success: ${result.success}, code: ${result.code}`);
        resolve(result);
    };
    
    // Execute the actual request with our wrapper
    diagLog(`CALLING_executeImageRequest - requestKey: ${shortKey}, profileId: ${profileId?.substring(0, 8)}`);
    executeImageRequest(requestKey, profileId, prompt, imagePath, workflowId, wrappedResolve);
}

// ============ PUBLIC API ============

/**
 * Get all connected ChatGPT profiles
 * @returns {Array<string>} Array of connected profile IDs
 */
function getConnectedProfiles() {
    const openaiProfiles = readKey('openaiProfiles') || {};
    const allProfiles = Object.entries(openaiProfiles);
    let clearedExpiredBlock = false;
    const connectedProfiles = allProfiles
        .filter(([name, data]) => {
            // Must be connected
            if (data?.status !== 'connected') return false;
            // Must have 'image' capability (default to true for backward compatibility)
            const capabilities = data?.capabilities || ['image', 'chat'];
            if (!capabilities.includes('image')) return false;
            if (getActiveImageBlock(data)) return false;

            if (data.imageBlockedUntil || data.imageGenerationStatus === 'blocked') {
                delete data.imageBlockedUntil;
                delete data.imageBlockedReason;
                delete data.imageBlockedAt;
                data.imageGenerationStatus = 'available';
                clearedExpiredBlock = true;
            }
            return true;
        })
        .map(([name]) => name);

    if (clearedExpiredBlock) {
        updateData('openaiProfiles', openaiProfiles);
    }
    
    console.log(`[ChatGPT Image] getConnectedProfiles: Found ${allProfiles.length} total profiles, ${connectedProfiles.length} connected with image capability:`, 
        connectedProfiles.map(id => {
            const queueData = profileQueues.get(id);
            const load = queueData ? (queueData.activeCount + queueData.queue.length) : 0;
            return `${id.substring(0, 8)}... (load: ${load})`;
        }).join(', ') || 'none'
    );
    
    return connectedProfiles;
}

/**
 * Select the best profile for a new request using load balancing
 * Picks the profile with the least load (active + queued requests)
 * Immediately reserves a slot by adding a placeholder to the queue
 * @returns {{profileId: string, queueData: Object, placeholderIndex: number}|null} 
 *          The best profile ID, its queue data, and placeholder index, or null if none connected
 */
function selectBestProfileAndReserve() {
    const connectedProfiles = getConnectedProfiles();
    
    if (connectedProfiles.length === 0) {
        console.log('[ChatGPT Image] selectBestProfile: No connected profiles available!');
        return null;
    }
    
    // Find the profile with the least load (active + queued)
    let bestProfile = connectedProfiles[0];
    let minLoad = Infinity;
    let bestQueueData = getProfileQueue(connectedProfiles[0]);
    
    const loadReport = [];
    for (const profileId of connectedProfiles) {
        const queueData = getProfileQueue(profileId);
        const load = queueData.activeCount + queueData.queue.length;
        loadReport.push(`${profileId.substring(0, 8)}...: active=${queueData.activeCount}, queued=${queueData.queue.length}, total=${load}`);
        
        if (load < minLoad) {
            minLoad = load;
            bestProfile = profileId;
            bestQueueData = queueData;
        }
    }
    
    // IMMEDIATELY reserve a slot by adding a placeholder to prevent race conditions
    // This ensures the next call to this function sees an incremented load
    const placeholderIndex = bestQueueData.queue.length;
    bestQueueData.queue.push(null); // Placeholder, will be replaced with actual task
    
    if (connectedProfiles.length > 1) {
        console.log(`[ChatGPT Image] selectBestProfile: Load distribution:\n  - ${loadReport.join('\n  - ')}`);
    }
    console.log(`[ChatGPT Image] selectBestProfile: Selected ${bestProfile.substring(0, 8)}... (load was: ${minLoad}, now: ${minLoad + 1}) from ${connectedProfiles.length} profiles`);
    
    return { profileId: bestProfile, queueData: bestQueueData, placeholderIndex };
}

/**
 * Queue an image generation request
 * @param {string} prompt - The image prompt
 * @param {string} imagePath - Optional reference image path for similar image generation
 * @param {string} profileId - ChatGPT profile name (optional, auto-selects best profile if not specified)
 * @param {string} workflowId - Workflow ID for cleanup tracking (optional)
 * @returns {Promise<{success: boolean, value: string, code?: string}>}
 */
async function startImageRequest(prompt, imagePath = null, profileId = null, workflowId = null) {
    try {
        // Get OpenAI profile to use
        const openaiProfiles = readKey('openaiProfiles') || {};
        
        let selectedProfile = profileId;
        let queueData = null;
        let placeholderIndex = -1;
        
        if (!selectedProfile) {
            // Use load balancing to select the best profile
            // This also reserves a slot immediately by adding a placeholder (prevents race conditions)
            const selection = selectBestProfileAndReserve();
            if (!selection) {
                const imageProfiles = Object.entries(openaiProfiles).filter(([, data]) => {
                    const capabilities = data?.capabilities || ['image', 'chat'];
                    return data?.status === 'connected' && capabilities.includes('image');
                });
                const activeBlocks = imageProfiles
                    .map(([name, data]) => ({ name, ...getActiveImageBlock(data) }))
                    .filter(block => block.blockedUntil)
                    .sort((a, b) => Date.parse(a.blockedUntil) - Date.parse(b.blockedUntil));

                if (imageProfiles.length > 0 && activeBlocks.length === imageProfiles.length) {
                    return {
                        success: false,
                        code: 'ALL_PROFILES_IMAGE_BLOCKED',
                        value: `All connected ChatGPT image profiles are blocked. Next profile unlocks at ${activeBlocks[0].blockedUntil}`
                    };
                }
                return { 
                    success: false, 
                    code: 'NO_PROFILE',
                    value: 'No connected ChatGPT profile found' 
                };
            }
            selectedProfile = selection.profileId;
            queueData = selection.queueData;
            placeholderIndex = selection.placeholderIndex;
        } else {
            // Verify profile exists and is connected
            if (!openaiProfiles[selectedProfile] || openaiProfiles[selectedProfile].status !== 'connected') {
                return { 
                    success: false, 
                    code: 'PROFILE_NOT_CONNECTED',
                    value: `ChatGPT profile "${selectedProfile}" is not connected` 
                };
            }
            const activeBlock = getActiveImageBlock(openaiProfiles[selectedProfile]);
            if (activeBlock) {
                return {
                    success: false,
                    code: 'PROFILE_IMAGE_BLOCKED',
                    value: `ChatGPT image generation is blocked for profile "${selectedProfile}" until ${activeBlock.blockedUntil}`
                };
            }
            queueData = getProfileQueue(selectedProfile);
            placeholderIndex = -1; // No placeholder, will push instead
        }
        
        const requestKey = generateRequestKey(selectedProfile);
        
        // Create promise that will be resolved when request completes
        return new Promise((resolve) => {
            const task = {
                requestKey,
                profileId: selectedProfile,
                prompt,
                imagePath,
                workflowId,
                resolve
            };
            
            // Track in pending requests
            pendingRequests.set(requestKey, {
                prompt,
                imagePath,
                workflowId,
                profileId: selectedProfile,
                startTime: Date.now(),
                resolve
            });
            requestAbortControllers.set(requestKey, new AbortController());
            
            // Track in workflow requests
            if (workflowId) {
                if (!workflowRequests.has(workflowId)) {
                    workflowRequests.set(workflowId, new Set());
                }
                workflowRequests.get(workflowId).add(requestKey);
            }
            
            // Replace placeholder or push to queue
            if (placeholderIndex >= 0 && placeholderIndex < queueData.queue.length && queueData.queue[placeholderIndex] === null) {
                queueData.queue[placeholderIndex] = task;
            } else {
                // Fallback: push to queue (for manually specified profiles or if placeholder was somehow consumed)
                queueData.queue.push(task);
            }
            
            console.log(`[ChatGPT Image] Request queued. Profile: ${selectedProfile.substring(0, 8)}..., Queue size: ${queueData.queue.length}, Active: ${queueData.activeCount}`);
            
            // Start processing
            processQueue(selectedProfile);
        });
        
    } catch (error) {
        console.error('[ChatGPT Image] Error in startImageRequest:', error);
        return { 
            success: false, 
            code: 'ERROR',
            value: error.message || String(error) 
        };
    }
}

/**
 * Stop all requests for a workflow
 * @param {string} workflowId - The workflow ID to stop
 */
function stopWorkflowQueues(workflowId) {
    console.log(`[ChatGPT Image] Stopping all requests for workflow ${workflowId}...`);
    let removedFromQueue = 0;
    let removedPending = 0;
    let abortedRateLimitSleeps = 0;
    const workflowIdString = String(workflowId);
    
    // Collect by normalized workflow ID because IPC and database paths may use
    // different string/number representations of the same ID.
    const requestKeys = new Set();
    for (const [trackedWorkflowId, trackedRequestKeys] of workflowRequests.entries()) {
        if (String(trackedWorkflowId) === workflowIdString) {
            for (const requestKey of trackedRequestKeys) requestKeys.add(requestKey);
        }
    }
    for (const [requestKey, request] of pendingRequests.entries()) {
        if (String(request.workflowId) === workflowIdString) requestKeys.add(requestKey);
    }
    
    // FIRST: Abort any rate-limit sleeps for this workflow's requests
    // This must happen BEFORE deleting from pendingRequests to prevent race conditions
    for (const requestKey of requestKeys) {
        const requestAbortController = requestAbortControllers.get(requestKey);
        if (requestAbortController && !requestAbortController.signal.aborted) {
            requestAbortController.abort();
        }

        const abortController = rateLimitAbortControllers.get(requestKey);
        if (abortController) {
            console.log(`[ChatGPT Image] Aborting rate-limit sleep for request ${requestKey.substring(0, 20)}...`);
            abortController.abort();
            rateLimitAbortControllers.delete(requestKey);
            abortedRateLimitSleeps++;
        }
    }
    
    // Remove from profile queues (waiting items)
    for (const [profileId, queueData] of profileQueues.entries()) {
        const originalLength = queueData.queue.length;
        
        // Filter out items belonging to this workflow
        const itemsToRemove = queueData.queue.filter(item => item && String(item.workflowId) === workflowIdString);
        queueData.queue = queueData.queue.filter(item => !item || String(item.workflowId) !== workflowIdString);
        
        // Resolve removed items as stopped
        for (const item of itemsToRemove) {
            item.resolve({
                success: false,
                code: 'WORKFLOW_STOPPED',
                value: 'Workflow was stopped'
            });
            pendingRequests.delete(item.requestKey);
            removedFromQueue++;
        }
        
        if (originalLength !== queueData.queue.length) {
            console.log(`[ChatGPT Image] Removed ${originalLength - queueData.queue.length} items from ${profileId} queue`);
        }
    }
    
    // Cancel pending/active requests
    for (const requestKey of requestKeys) {
        const request = pendingRequests.get(requestKey);
        if (request) {
            // If this request was in rate limit wait, we kept its slot reserved
            // Now we need to free it since the workflow is stopping
            if (request.isRateLimitWait && request.profileId) {
                const queueData = getProfileQueue(request.profileId);
                queueData.activeCount = Math.max(0, queueData.activeCount - 1);
                console.log(`[ChatGPT Image] Freed rate-limit reserved slot for ${request.profileId.substring(0, 8)}... Active: ${queueData.activeCount}`);
            }
            
            request.resolve({
                success: false,
                code: 'WORKFLOW_STOPPED',
                value: 'Workflow was stopped'
            });
            pendingRequests.delete(requestKey);
            removedPending++;
        }

        const browserResult = activeRequestBrowsers.get(requestKey);
        if (browserResult) {
            console.log(`[ChatGPT Image] Terminating active browser for request ${requestKey.substring(0, 20)}...`);
            try {
                browserResult.chromeProcess?.kill();
            } catch (closeError) {
                console.warn('[ChatGPT Image] Could not terminate active browser process:', closeError.message);
            }
            browserResult.client?.close().catch(() => {});
            activeRequestBrowsers.delete(requestKey);
        }

        requestAbortControllers.delete(requestKey);
    }
    
    // Clean up workflow tracking
    for (const trackedWorkflowId of workflowRequests.keys()) {
        if (String(trackedWorkflowId) === workflowIdString) {
            workflowRequests.delete(trackedWorkflowId);
        }
    }
    
    console.log(`[ChatGPT Image] Workflow ${workflowId} cleanup complete: removed ${removedFromQueue} queued + ${removedPending} pending + ${abortedRateLimitSleeps} rate-limit sleeps aborted`);
}

/**
 * Clear workflow state for rerun - clears tracking entries without aborting active operations
 * This prevents "Workflow stopped by user" errors on immediate reruns
 * @param {string} workflowId - The workflow ID to clear state for
 */
function clearWorkflowStateForRerun(workflowId) {
    console.log(`[ChatGPT Image] Clearing state for workflow ${workflowId} rerun...`);
    
    // Clear workflow tracking entry (don't abort or resolve - just remove tracking)
    const hadEntry = workflowRequests.delete(workflowId);
    if (hadEntry) {
        console.log(`[ChatGPT Image] Cleared workflowRequests entry for workflow ${workflowId}`);
    }
    
    // Note: We don't clear rateLimitAbortControllers here because those are keyed by requestKey, 
    // not workflowId, and we don't want to abort rate-limit waits that might be for other workflows
}

/**
 * Get queue status for monitoring
 * @param {string} profileId - Optional specific profile
 * @returns {Object} Queue status
 */
function getQueueStatus(profileId = null) {
    if (profileId) {
        const data = getProfileQueue(profileId);
        return {
            [profileId]: {
                queued: data.queue.length,
                active: data.activeCount,
                maxConcurrent: MAX_CONCURRENT
            }
        };
    }
    
    const status = {};
    for (const [id, data] of profileQueues.entries()) {
        status[id] = {
            queued: data.queue.length,
            active: data.activeCount,
            maxConcurrent: MAX_CONCURRENT
        };
    }
    return status;
}

// ============ INTERNAL EXECUTION ============

/**
 * Delete a ChatGPT conversation.
 * @param {Object} Runtime - CDP Runtime domain
 * @param {string} conversationId - The conversation ID to delete
 * @param {Object} authHeaders - Captured auth headers
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteConversation(Runtime, conversationId, authHeaders) {
    if (!conversationId) {
        return { success: false, error: 'No conversation ID provided' };
    }
    
    console.log('[ChatGPT Image] Deleting conversation:', conversationId);
    
    try {
        const deletePath = `/backend-api/conversation/id/${conversationId}`;
        const headersJson = JSON.stringify({
            'Accept': '*/*',
            ...(authHeaders?.authorization ? { 'authorization': authHeaders.authorization } : {}),
            ...(authHeaders?.oaiDeviceId ? { 'oai-device-id': authHeaders.oaiDeviceId } : {}),
            ...(authHeaders?.oaiClientBuildNumber ? { 'oai-client-build-number': authHeaders.oaiClientBuildNumber } : {}),
            ...(authHeaders?.oaiClientVersion ? { 'oai-client-version': authHeaders.oaiClientVersion } : {}),
            ...(authHeaders?.oaiLanguage ? { 'oai-language': authHeaders.oaiLanguage } : {}),
            'x-openai-target-path': deletePath,
            'x-openai-target-route': '/backend-api/conversation/id/{conversation_id}'
        });
        const deleteUrl = `https://chatgpt.com${deletePath}`;
        const legacyUrl = `https://chatgpt.com/backend-api/conversation/${conversationId}`;
        
        const result = await Runtime.evaluate({
            expression: `
(async function() {
    const headers = ${headersJson};
    var lastError = null;

    // ChatGPT's current web client permanently deletes conversations with this endpoint.
    // Retry transient failures while the authenticated browser session is still alive.
    for (var attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch('${deleteUrl}', {
                method: 'DELETE',
                credentials: 'include',
                headers: headers
            });
            if (response.ok) {
                return { success: true, status: response.status, method: 'DELETE', attempt: attempt };
            }
            lastError = 'DELETE HTTP ' + response.status;
            if (response.status < 500 && response.status !== 429) break;
        } catch (e) {
            lastError = 'DELETE ' + e.message;
        }
        await new Promise(function(resolve) { setTimeout(resolve, attempt * 500); });
    }

    // Compatibility fallback for accounts still served by the former hide endpoint.
    try {
        const legacyHeaders = Object.assign({}, headers, { 'Content-Type': 'application/json' });
        delete legacyHeaders['x-openai-target-path'];
        delete legacyHeaders['x-openai-target-route'];
        const response = await fetch('${legacyUrl}', {
            method: 'PATCH',
            credentials: 'include',
            headers: legacyHeaders,
            body: JSON.stringify({ is_visible: false })
        });
        if (response.ok) {
            return { success: true, status: response.status, method: 'PATCH_FALLBACK' };
        }
        // If neither endpoint can find it, the conversation is already absent.
        if (response.status === 404 && lastError === 'DELETE HTTP 404') {
            return { success: true, status: 404, method: 'ALREADY_ABSENT' };
        }
        return { success: false, error: lastError + '; PATCH HTTP ' + response.status };
    } catch (e) {
        return { success: false, error: (lastError ? lastError + '; ' : '') + 'PATCH ' + e.message };
    }
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: 30000
        });
        
        const deleteResult = result.result?.value;
        if (deleteResult?.success) {
            console.log('[ChatGPT Image] Conversation deleted successfully via', deleteResult.method);
        } else {
            console.log('[ChatGPT Image] Conversation deletion result:', deleteResult?.error || JSON.stringify(deleteResult));
        }
        return deleteResult || { success: false, error: 'No result' };
    } catch (e) {
        console.error('[ChatGPT Image] Error deleting conversation:', e.message);
        return { success: false, error: e.message };
    }
}

async function executeImageRequest(requestKey, profileId, prompt, imagePath, workflowId, resolve) {
    let browserResult = null;
    const requestAbortController = requestAbortControllers.get(requestKey);
    const isCancelled = () => requestAbortController?.signal.aborted || !pendingRequests.has(requestKey);
    let ourConversationId = null;  // Track for cleanup
    let conversationSubmitted = false;
    let deferredResult = null;
    const completeRequest = (result) => {
        // Deliver the result from finally, after conversation cleanup has run.
        if (!deferredResult) deferredResult = result;
    };
    const capturedAuthHeaders = {
        authorization: null,
        oaiDeviceId: null,
        oaiClientBuildNumber: null,
        oaiClientVersion: null,
        oaiLanguage: null
    };
    
    try {
        console.log('[ChatGPT Image] Starting image generation...');
        console.log('[ChatGPT Image] Profile:', profileId);
        console.log('[ChatGPT Image] Prompt:', prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''));
        if (imagePath) {
            console.log('[ChatGPT Image] Reference image:', imagePath);
        }
        
        // Check if request was cancelled before starting
        if (isCancelled()) {
            console.log('[ChatGPT Image] Request was cancelled before execution');
            return;
        }
        
        // Check if VCBrowser is installed
        if (!isVCBrowserInstalled()) {
            completeRequest({
                success: false, 
                code: 'VCBROWSER_NOT_INSTALLED',
                value: 'VCBrowser is not installed' 
            });
            return;
        }
        
        // Generate consistent fingerprint for the profile
        const fingerprint = getConsistentFingerprintForProfile(profileId);
        
        // Update to VCBrowser's actual version to avoid fingerprint detection
        try {
          const vcVersion = getVCBrowserVersion();
          if (fingerprint.userAgent && vcVersion?.full) {
            fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
          }
        } catch (e) { /* use fallback */ }
        
        // Start VCBrowser with the profile (automationMode=true to auto-grant permissions)
        browserResult = await startVCBrowser(
            profileId, 
            fingerprint,
            'https://chatgpt.com/images', 
            null,           // proxy
            true,          // headless
            true            // automationMode - auto-grant permissions
        );

        if (browserResult) {
            activeRequestBrowsers.set(requestKey, browserResult);
        }

        if (isCancelled()) {
            console.log('[ChatGPT Image] Request was cancelled while browser was starting');
            return;
        }
        
        if (!browserResult || !browserResult.client) {
            completeRequest({
                success: false, 
                code: 'BROWSER_FAILED',
                value: 'Failed to start VCBrowser or get CDP client' 
            });
            return;
        }
        
        console.log('[ChatGPT Image] VCBrowser started, port:', browserResult.debuggingPort);
        
        const client = browserResult.client;
        const { Runtime, Page, Network, Browser } = client;
        
        await Promise.all([
            Runtime.enable(),
            Page.enable(),
            Network.enable()
        ]);

        // Start tracking before submission so cleanup still has the auth details and
        // conversation ID when generation fails during or immediately after navigation.
        Network.requestWillBeSent((params) => {
            const url = params.request?.url || '';
            const headers = params.request?.headers || {};

            if (url.includes('/backend-api/')) {
                if (!capturedAuthHeaders.authorization && (headers['authorization'] || headers['Authorization'])) {
                    capturedAuthHeaders.authorization = headers['authorization'] || headers['Authorization'];
                    console.log('[ChatGPT Image] Captured authorization token');
                }
                capturedAuthHeaders.oaiDeviceId ||= headers['oai-device-id'] || null;
                capturedAuthHeaders.oaiClientBuildNumber ||= headers['oai-client-build-number'] || null;
                capturedAuthHeaders.oaiClientVersion ||= headers['oai-client-version'] || null;
                capturedAuthHeaders.oaiLanguage ||= headers['oai-language'] || null;
            }

            if (conversationSubmitted && !ourConversationId) {
                const idMatch = url.match(/(?:\/conversation(?:\/id)?\/|[?&]conversation_id=)([a-f0-9-]{36})(?:[/?&#]|$)/i);
                if (idMatch) {
                    ourConversationId = idMatch[1];
                    console.log('[ChatGPT Image] Captured conversation ID from network:', ourConversationId);
                }
            }
        });
        
        // Grant clipboard permissions specifically for ChatGPT
        try {
            await Browser.grantPermissions({
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
                origin: 'https://chatgpt.com'
            });
            console.log('[ChatGPT Image] Granted clipboard permissions for chatgpt.com');
        } catch (permErr) {
            console.log('[ChatGPT Image] Permission grant warning:', permErr.message);
        }
        
        // Install a persistent popup-dismissal watcher in the page.
        // It runs every 500ms and clicks any visible close button (e.g. onboarding/upsell popups)
        // so they never block the automation from filling inputs or clicking submit.
        try {
            await Runtime.evaluate({
                expression: `
(function() {
    if (window.__vcPopupDismisserActive) return;
    window.__vcPopupDismisserActive = true;
    window.__vcPopupDismisserInterval = setInterval(function() {
        try {
            var btn = document.querySelector('button[data-testid="close-button"]');
            if (btn && btn.offsetParent !== null) {
                console.log('[ChatGPT Image] Dismissing popup close button');
                btn.click();
            }
        } catch(e) {}
    }, 500);
})()`,
                returnByValue: true
            });
            console.log('[ChatGPT Image] Popup dismissal watcher installed');
        } catch (watcherErr) {
            console.log('[ChatGPT Image] Could not install popup dismissal watcher:', watcherErr.message);
        }

        // Wait for page to fully load and React to hydrate
        console.log('[ChatGPT Image] Waiting for page to load...');
        await new Promise(r => setTimeout(r, 3000));
        
        // Check if cancelled
        if (isCancelled()) {
            console.log('[ChatGPT Image] Request cancelled during page load');
            return;
        }
        
        // Wait for document ready state
        await Runtime.evaluate({
            expression: `new Promise(r => {
                if (document.readyState === 'complete') r();
                else window.addEventListener('load', r);
            })`,
            awaitPromise: true,
            timeout: 15000
        });
        
        // Additional wait for React hydration
        console.log('[ChatGPT Image] Waiting for React hydration...');
        await new Promise(r => setTimeout(r, 5000));

        const availability = await checkImageGenerationAvailability(Runtime);
        if (availability.checked && availability.blocked) {
            if (availability.blockedUntil) {
                await saveImageBlock(profileId, availability);
            }
            completeRequest({
                success: false,
                code: 'IMAGE_LIMIT_BLOCKED',
                value: availability.blockedUntil
                    ? `ChatGPT image generation limit reached. Profile blocked until ${availability.blockedUntil}`
                    : availability.reason
            });
            return;
        }
        if (!availability.checked) {
            console.warn('[ChatGPT Image] Could not check image generation availability:', availability.error);
        }
        
        // Debug: Check current URL and page state
        const pageInfo = await Runtime.evaluate({
            expression: `JSON.stringify({ url: window.location.href, title: document.title, bodyLength: document.body?.innerHTML?.length || 0 })`
        });
        console.log('[ChatGPT Image] Page info:', pageInfo.result?.value);
        
        // Step 1: Wait for the ProseMirror editor with extended polling
        console.log('[ChatGPT Image] Looking for input field...');
        const waitForInput = await Runtime.evaluate({
            expression: `
(async function() {
    const selectors = [
        '#prompt-textarea',
        '.ProseMirror',
        'div[contenteditable="true"]',
        '[data-virtualkeyboard="true"]'
    ];
    
    for (let attempt = 0; attempt < 40; attempt++) {
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && (el.contentEditable === 'true' || el.getAttribute('contenteditable') === 'true')) {
                console.log('[ChatGPT] Found input:', sel, 'attempt:', attempt);
                return { found: true, selector: sel, attempt };
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }
    
    // Debug: what's on the page
    const all = document.querySelectorAll('*');
    const contentEditables = Array.from(all).filter(e => e.contentEditable === 'true' || e.getAttribute('contenteditable') === 'true');
    const debug = contentEditables.slice(0, 5).map(e => ({ tag: e.tagName, id: e.id, class: (e.className || '').substring(0, 50) }));
    
    return { found: false, debug, totalContentEditable: contentEditables.length };
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: 30000
        });
        
        const inputResult = waitForInput.result?.value;
        console.log('[ChatGPT Image] Input search result:', JSON.stringify(inputResult));
        
        if (!inputResult?.found) {
            completeRequest({
                success: false, 
                code: 'INPUT_NOT_FOUND',
                value: 'Could not find ChatGPT input field. Debug: ' + JSON.stringify(inputResult?.debug || [])
            });
            return;
        }
        
        const inputSelector = inputResult.selector;
        console.log('[ChatGPT Image] Found input with selector:', inputSelector, 'on attempt:', inputResult.attempt);
        
        // Step 2: Attach the requested reference image before entering the prompt.
        if (imagePath) {
            if (!fs.existsSync(imagePath)) throw new Error('Reference image file not found');
            console.log('[ChatGPT Image] Attaching reference image...');
            await attachChatGPTReferenceImage(client, imagePath);
            // The send-button wait below also waits for upload processing.
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // Step 3: Fill the prompt (with retry for "Promise was collected" errors)
        const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        const escapedSelector = inputSelector.replace(/'/g, "\\'");
        
        console.log('[ChatGPT Image] Filling prompt with selector:', inputSelector);
        
        const fillPromptExpression = `
(async function() {
    const editor = document.querySelector('${escapedSelector}');
    if (!editor) return { success: false };
    
    const text = \`${escapedPrompt}\`;
    editor.focus();
    editor.innerHTML = '';
    
    try {
        await navigator.clipboard.writeText(text);
        document.execCommand('paste');
        await new Promise(r => setTimeout(r, 300));
    } catch (e) {}
    
    if (!editor.textContent || editor.textContent.trim() === '') {
        editor.focus();
        document.execCommand('insertText', false, text);
        await new Promise(r => setTimeout(r, 300));
    }
    
    if (!editor.textContent || editor.textContent.trim() === '') {
        const p = editor.querySelector('p') || editor;
        p.textContent = text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
    }
    
    console.log('Text filled, length:', editor.textContent?.length);
    return { success: true, length: editor.textContent?.length };
})()`;

        // Retry up to 3 times for "Promise was collected" errors
        let promptFillSuccess = false;
        for (let fillAttempt = 1; fillAttempt <= 3; fillAttempt++) {
            try {
                await Runtime.evaluate({
                    expression: fillPromptExpression,
                    awaitPromise: true,
                    returnByValue: true,
                    timeout: 10000
                });
                promptFillSuccess = true;
                break;
            } catch (fillError) {
                const errorMsg = fillError.message || String(fillError);
                console.log(`[ChatGPT Image] Prompt fill attempt ${fillAttempt}/3 failed:`, errorMsg);
                
                if (errorMsg.includes('Promise was collected') || errorMsg.includes('context was destroyed')) {
                    // Wait a bit before retrying - page might be in transition
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                // For other errors, throw immediately
                throw fillError;
            }
        }
        
        if (!promptFillSuccess) {
            completeRequest({
                success: false, 
                code: 'PROMPT_FILL_FAILED',
                value: 'Failed to fill prompt after 3 attempts - page may have navigated during input' 
            });
            return;
        }
        
        await new Promise(r => setTimeout(r, 500));

        if (isCancelled()) {
            console.log('[ChatGPT Image] Request cancelled before prompt submission');
            return;
        }
        
        // Step 3: Click submit (with retry for slow uploads)
        console.log('[ChatGPT Image] Waiting for submit button to be enabled...');
        conversationSubmitted = true;
        const clickResult = await Runtime.evaluate({
            expression: `
(async function() {
    const maxAttempts = 120; // Wait up to 60 seconds for button to be enabled
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // ChatGPT rolls out different composers per account. Prefer the active
        // prompt's form and semantic send controls, not changing CSS classes.
        const prompt = document.querySelector('#prompt-textarea');
        const composerForm = prompt && prompt.closest('form');
        const scope = composerForm || document;
        const sendSelectors = [
            '#composer-submit-button',
            'button[data-testid="send-button"]',
            'button[type="submit"][aria-label="Send" i]',
            'button[aria-label="Send prompt" i]',
            'button[aria-label="Send message" i]',
            'button[type="submit"][aria-label="Envoyer" i]'
        ];
        // Submit semantics work across composer languages. Only use this broad
        // fallback inside the prompt's form, never on unrelated page forms.
        if (composerForm) sendSelectors.push('button[type="submit"]');
        const candidates = Array.from(scope.querySelectorAll(sendSelectors.join(','))).filter(function(candidate) {
            const style = window.getComputedStyle(candidate);
            const label = candidate.getAttribute('aria-label') || '';
            return candidate.getClientRects().length > 0 &&
                style.visibility !== 'hidden' && style.display !== 'none' &&
                candidate.getAttribute('data-testid') !== 'stop-button' &&
                !/^(?:stop|arrêter|arreter|interrompre)(?:\\s|$)/i.test(label);
        });
        const isEnabled = function(candidate) {
            return !candidate.matches(':disabled') &&
                candidate.getAttribute('aria-disabled') !== 'true';
        };
        const button = candidates.find(isEnabled) || candidates[0];
        if (!button) {
            if (attempt === maxAttempts - 1) return { success: false, error: 'Submit button not found' };
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        if (isEnabled(button)) {
            const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
            const existingImages = (${collectGeneratedImages.toString()})().images;
            button.click();
            return { success: true, attempts: attempt, assistantCount, imageCount: existingImages.length, existingImages };
        }
        // Log progress every 10 attempts (5 seconds)
        if (attempt > 0 && attempt % 10 === 0) {
            console.log('[ChatGPT] Still waiting for submit button... attempt', attempt);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Submit button remained disabled (image may still be uploading)' };
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: 65000
        });
        
        console.log('[ChatGPT Image] Submit result:', JSON.stringify(clickResult.result?.value));
        
        if (!clickResult.result?.value?.success) {
            completeRequest({
                success: false, 
                code: 'SUBMIT_FAILED',
                value: clickResult.result?.value?.error || 'Failed to submit prompt' 
            });
            return;
        }
        
        // Step 4: Wait for a conversation URL or generation starting on the current page.
        // ChatGPT can now keep image requests on /images instead of navigating to /c/<id>.
        console.log('[ChatGPT Image] Waiting for conversation or image generation to start...');
        const submitState = clickResult.result.value;
        const preSubmitImageIds = (submitState.existingImages || []).map(image => image.id).filter(Boolean);
        const preSubmitImageUrls = (submitState.existingImages || []).map(image => image.src).filter(Boolean);
        const conversationWaitStart = Date.now();
        const conversationObservationMs = Math.min(CONVERSATION_REDIRECT_TIMEOUT_MS, 10000);
        let conversationResult = null;

        while (Date.now() - conversationWaitStart < conversationObservationMs) {
            if (ourConversationId) {
                conversationResult = { success: true, method: 'network', url: null };
                break;
            }

            try {
                const stateResult = await Runtime.evaluate({
                    expression: `
(function() {
    const url = window.location.href;
    const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    const imageCount = (${collectGeneratedImages.toString()})().count;
    const stopButton = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="stop"]');
    return {
        url,
        redirected: /\\/c\\//.test(url),
        responseStarted: assistantCount > ${submitState.assistantCount || 0} ||
            imageCount > ${submitState.imageCount || 0} ||
            !!(stopButton && stopButton.offsetParent !== null)
    };
})()`,
                    returnByValue: true,
                    timeout: 5000
                });
                const state = stateResult.result?.value;
                if (state?.redirected || state?.responseStarted) {
                    conversationResult = {
                        success: true,
                        method: state.redirected ? 'redirect' : 'same_page',
                        url: state.url
                    };
                    break;
                }
            } catch (stateError) {
                const message = stateError.message || String(stateError);
                if (!message.includes('context was destroyed') && !message.includes('Promise was collected')) {
                    console.log('[ChatGPT Image] Conversation state check warning:', message);
                }
            }

            await new Promise(r => setTimeout(r, 500));
        }

        if (!conversationResult?.success) {
            let currentUrl = null;
            try {
                const currentUrlResult = await Runtime.evaluate({
                    expression: 'window.location.href',
                    returnByValue: true,
                    timeout: 5000
                });
                currentUrl = currentUrlResult.result?.value || null;
            } catch (_) {}

            conversationResult = {
                success: true,
                method: 'unconfirmed_submit',
                url: currentUrl
            };
            console.warn('[ChatGPT Image] No redirect or generation indicator detected; continuing with image polling');
        }
        
        const conversationUrl = conversationResult.url;
        console.log('[ChatGPT Image] Conversation detected via:', conversationResult.method, 'URL:', conversationUrl || 'not available');
        
        // Extract conversation_id from URL (format: https://chatgpt.com/c/xxxx-xxxx-xxxx-xxxx)
        const conversationIdMatch = conversationUrl?.match(/\/c\/([a-f0-9-]+)/i);
        ourConversationId = conversationIdMatch ? conversationIdMatch[1] : ourConversationId;
        console.log('[ChatGPT Image] Our conversation ID:', ourConversationId);
        
        if (!ourConversationId) {
            console.log('[ChatGPT Image] Warning: Could not extract conversation ID from URL');
        }
        
        console.log('[ChatGPT Image] Network listener active for auth and cleanup tracking');
        
        // Read both legacy cards and the new generated-image gallery. The same
        // reader captured the pre-submit baseline so older gallery images are excluded.
        async function scrapeGeneratedImages() {
            try {
                const result = await Runtime.evaluate({
                    expression: `(${collectGeneratedImages.toString()})(${JSON.stringify(preSubmitImageIds)}, ${JSON.stringify(preSubmitImageUrls)})`,
                    returnByValue: true,
                    timeout: 10000
                });
                return result.result?.value || { found: false };
            } catch (e) {
                return { found: false, error: e.message };
            }
        }

        // Check for rate limit by fetching the conversation API
        async function checkForRateLimitViaAPI() {
            if (!ourConversationId) return { rateLimited: false };
            
            try {
                // Build headers for the API call
                const headersJson = JSON.stringify({
                    ...(capturedAuthHeaders.authorization ? { 'authorization': capturedAuthHeaders.authorization } : {}),
                    ...(capturedAuthHeaders.oaiDeviceId ? { 'oai-device-id': capturedAuthHeaders.oaiDeviceId } : {}),
                    ...(capturedAuthHeaders.oaiClientBuildNumber ? { 'oai-client-build-number': capturedAuthHeaders.oaiClientBuildNumber } : {}),
                    ...(capturedAuthHeaders.oaiClientVersion ? { 'oai-client-version': capturedAuthHeaders.oaiClientVersion } : {}),
                    ...(capturedAuthHeaders.oaiLanguage ? { 'oai-language': capturedAuthHeaders.oaiLanguage } : {})
                });
                
                const conversationUrl = `https://chatgpt.com/backend-api/conversation/${ourConversationId}`;
                
                const result = await Runtime.evaluate({
                    expression: `
(async function() {
    try {
        const headers = ${headersJson};
        const response = await fetch('${conversationUrl}', { 
            credentials: 'include',
            headers: headers
        });
        if (!response.ok) return { rateLimited: false, error: 'HTTP ' + response.status };
        const data = await response.json();
        
        // Look through mapping for rate limit messages
        if (data.mapping) {
            for (const [nodeId, node] of Object.entries(data.mapping)) {
                const msg = node.message;
                if (!msg) continue;
                
                // Check for rate limit indicators
                const isError = msg.metadata?.is_error === true;
                const isImageGen = msg.metadata?.async_task_type === 'image_gen';
                const content = msg.content?.parts?.[0];
                
                if (typeof content === 'string' && content.includes('generating images too quickly')) {
                    // Extract wait time from message (e.g., "wait for 5 minutes")
                    const waitMatch = content.match(/wait\s+(?:for\s+)?(\\d+)\\s*(?:minute|min)/i);
                    const waitMinutes = waitMatch ? parseInt(waitMatch[1]) : 3;
                    
                    return {
                        rateLimited: true,
                        waitMinutes: waitMinutes,
                        message: content.substring(0, 200),
                        isError: isError,
                        isImageGen: isImageGen
                    };
                }
            }
        }
        
        return { rateLimited: false };
    } catch (e) {
        return { rateLimited: false, error: e.message };
    }
})()`,
                    awaitPromise: true,
                    returnByValue: true,
                    timeout: 10000
                });
                
                return result.result?.value || { rateLimited: false };
            } catch (e) {
                console.log('[ChatGPT Image] Rate limit check error:', e.message);
                return { rateLimited: false, error: e.message };
            }
        }
        
        // Try to extract auth token from page if not captured from network
        async function ensureAuthHeaders() {
            if (capturedAuthHeaders.authorization) {
                console.log('[ChatGPT Image] Using captured authorization token');
                return;
            }
            
            console.log('[ChatGPT Image] Attempting to extract auth token from page...');
            try {
                const authResult = await Runtime.evaluate({
                    expression: `
(async function() {
    try {
        // Method 1: Try to access __NEXT_DATA__ which sometimes has auth info
        const nextData = document.getElementById('__NEXT_DATA__');
        if (nextData) {
            try {
                const data = JSON.parse(nextData.textContent);
                if (data?.props?.pageProps?.accessToken) {
                    return { success: true, token: data.props.pageProps.accessToken, method: '__NEXT_DATA__' };
                }
            } catch (e) {}
        }
        
        // Method 2: Try to get token from session endpoint
        try {
            const sessionResp = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
            if (sessionResp.ok) {
                const session = await sessionResp.json();
                if (session?.accessToken) {
                    return { success: true, token: session.accessToken, method: 'session' };
                }
            }
        } catch (e) {}
        
        // Method 3: Intercept fetch by patching and making a request
        const originalFetch = window.fetch;
        let capturedToken = null;
        
        window.fetch = function(...args) {
            const request = args[1] || {};
            const headers = request.headers || {};
            
            // Check if this is an object with entries method (Headers object or plain object)
            if (headers.get && typeof headers.get === 'function') {
                const auth = headers.get('authorization');
                if (auth) capturedToken = auth;
            } else if (typeof headers === 'object') {
                if (headers.authorization || headers.Authorization) {
                    capturedToken = headers.authorization || headers.Authorization;
                }
            }
            
            return originalFetch.apply(this, args);
        };
        
        // Trigger an API call that should include auth
        try {
            await fetch('https://chatgpt.com/backend-api/me', { credentials: 'include' });
        } catch (e) {}
        
        // Restore original fetch
        window.fetch = originalFetch;
        
        if (capturedToken) {
            return { success: true, token: capturedToken.replace('Bearer ', ''), method: 'fetch_intercept' };
        }
        
        return { success: false, message: 'Could not extract token' };
    } catch (e) {
        return { success: false, error: e.message };
    }
})()`,
                    awaitPromise: true,
                    returnByValue: true,
                    timeout: 10000
                });
                
                const result = authResult.result?.value;
                if (result?.success && result?.token) {
                    capturedAuthHeaders.authorization = result.token.startsWith('Bearer ') ? result.token : 'Bearer ' + result.token;
                    console.log('[ChatGPT Image] Extracted auth token via:', result.method);
                } else {
                    console.log('[ChatGPT Image] Auth extraction result:', result?.message || result?.error);
                }
            } catch (e) {
                console.log('[ChatGPT Image] Auth extraction failed:', e.message);
            }
            
            // Also try to get oai-device-id from cookies if not captured
            if (!capturedAuthHeaders.oaiDeviceId) {
                try {
                    const deviceIdResult = await Runtime.evaluate({
                        expression: `
(function() {
    const match = document.cookie.match(/oai-did=([^;]+)/);
    return match ? match[1] : null;
})()`,
                        returnByValue: true
                    });
                    if (deviceIdResult.result?.value) {
                        capturedAuthHeaders.oaiDeviceId = deviceIdResult.result.value;
                        console.log('[ChatGPT Image] Extracted oai-device-id from cookie');
                    }
                } catch (e) {}
            }
        }
        
        // Ensure we have auth headers before polling
        await ensureAuthHeaders();
        
        // Step 5: Wait for the generated image by scraping the conversation DOM
        console.log('[ChatGPT Image] Waiting for image generation (DOM scraping)...');
        console.log('[ChatGPT Image] Auth headers captured:', !!capturedAuthHeaders.authorization, 'Device ID:', !!capturedAuthHeaders.oaiDeviceId);
        diagLog(`POLLING_START - requestKey: ${requestKey.substring(0, 20)}, conversationId: ${ourConversationId}, hasAuth: ${!!capturedAuthHeaders.authorization}`);
        
        var imageUrl;
        try {
            imageUrl = await new Promise((resolveImage, rejectImage) => {
            let resolved = false;
            let pollCount = 0;
            let pollTimer = null;
            let lastImageSet = '';
            let lastImageCount = 0;
            let lastPageRefreshAt = Date.now();
            let stablePolls = 0; // consecutive polls where the ready image set stayed unchanged
            const shortKey = requestKey.substring(0, 20);
            
            const totalTimeout = setTimeout(() => {
                if (resolved) return;
                diagLog(`POLLING_TIMEOUT - requestKey: ${shortKey}, pollCount: ${pollCount}, lastImageCount: ${lastImageCount}`);
                resolved = true;
                if (pollTimer) clearTimeout(pollTimer);
                rejectImage(new Error('Timeout waiting for image'));
            }, IMAGE_TIMEOUT_MS);
            
            // Active polling function - scrapes generated image cards from the DOM every 2 seconds
            const pollForImage = async () => {
                if (resolved) return;
                
                // Check cancellation
                if (isCancelled()) {
                    diagLog(`POLL_CANCELLED - requestKey: ${shortKey}, pollCount: ${pollCount}`);
                    console.log('[ChatGPT Image] Request was cancelled during image wait');
                    resolved = true;
                    clearTimeout(totalTimeout);
                    rejectImage(new Error('Request was cancelled'));
                    return;
                }
                
                pollCount++;
                
                // Log every 15 polls (30 seconds) for tracking
                if (pollCount % 15 === 0) {
                    diagLog(`POLL_STATUS - requestKey: ${shortKey}, pollCount: ${pollCount}, lastImageCount: ${lastImageCount}, resolved: ${resolved}`);
                }
                
                // Check for rate limit every N polls (or on first poll after some time has passed)
                if (pollCount === 3 || (pollCount > 3 && pollCount % RATE_LIMIT_CHECK_INTERVAL === 0)) {
                    const rateLimitCheck = await checkForRateLimitViaAPI();
                    if (resolved) return;
                    if (rateLimitCheck.rateLimited) {
                        diagLog(`POLL_RATE_LIMITED - requestKey: ${shortKey}, pollCount: ${pollCount}, waitMinutes: ${rateLimitCheck.waitMinutes}, message: ${rateLimitCheck.message?.substring(0, 100)}`);
                        console.log('[ChatGPT Image] Rate limit detected via API:', rateLimitCheck.message);
                        console.log('[ChatGPT Image] Wait time:', rateLimitCheck.waitMinutes, 'minutes');
                        resolved = true;
                        clearTimeout(totalTimeout);
                        // Return special error with wait time in milliseconds
                        rejectImage(new Error(`RATE_LIMITED:${rateLimitCheck.waitMinutes * 60 * 1000}`));
                        return;
                    }
                }
                
                // Scrape generated image cards from the DOM
                const domResult = await scrapeGeneratedImages();
                if (resolved) return;
                if (isCancelled()) {
                    resolved = true;
                    clearTimeout(totalTimeout);
                    rejectImage(new Error('Request was cancelled'));
                    return;
                }
                let imageReady = false;

                if (domResult?.found && domResult.images.length > 0) {
                    const allLoaded = domResult.images.every(img => img.complete);
                    const allOverlay = domResult.images.every(img => img.hasOverlay);
                    // Ready when generation stopped AND (all <img> fully loaded OR overlay actions rendered)
                    const ready = !domResult.generating && (allLoaded || allOverlay);
                    imageReady = ready;
                    
                    const imageSet = JSON.stringify(domResult.images.map(img => [img.id, img.src]));
                    if (ready && imageSet === lastImageSet) {
                        stablePolls++;
                    } else {
                        stablePolls = 0;
                    }
                    lastImageSet = imageSet;
                    lastImageCount = domResult.count;

                    // Accept once the image set stayed stable across 2 consecutive polls
                    // (guards against grabbing a card while more images are still being added)
                    if (ready && stablePolls >= 1) {
                        const lastImage = domResult.images[domResult.images.length - 1];
                        diagLog(`IMAGE_READY - requestKey: ${shortKey}, imageId: ${lastImage.id}, imageCount: ${domResult.count}, pollCount: ${pollCount}`);
                        console.log('[ChatGPT Image] Image ready! card id:', lastImage.id, '(' + domResult.count + ' image(s) in conversation)');
                        resolved = true;
                        clearTimeout(totalTimeout);
                        resolveImage(lastImage.src);
                        return;
                    }

                    if (pollCount % 5 === 1) {
                        console.log('[ChatGPT Image] Still generating... images found:', domResult.count, 'generating:', domResult.generating, 'allLoaded:', allLoaded, 'allOverlay:', allOverlay, '(poll #' + pollCount + ')');
                    }
                } else {
                    // No image cards rendered yet
                    stablePolls = 0;
                    lastImageSet = '';
                    lastImageCount = 0;
                    if (pollCount % 5 === 1) {
                        console.log('[ChatGPT Image] Waiting for generated image to appear in DOM... (poll #' + pollCount + ')');
                    }
                }
                
                // Refresh only while pending, before choosing a blob URL for download.
                // Do not resubmit the prompt or reset the overall generation timeout.
                let nextPollDelay = 2000;
                if (!resolved && !isCancelled() && !imageReady &&
                    Date.now() - lastPageRefreshAt >= IMAGE_REFRESH_INTERVAL_MS) {
                    lastPageRefreshAt = Date.now();
                    lastImageSet = '';
                    lastImageCount = 0;
                    stablePolls = 0;
                    try {
                        console.log('[ChatGPT Image] Refreshing pending generation after 60 seconds...');
                        // /images may not restore an in-flight conversation on reload.
                        // Reopen its conversation when the response supplied an ID.
                        if (ourConversationId && /^[a-f0-9-]{36}$/i.test(ourConversationId)) {
                            await Page.navigate({ url: 'https://chatgpt.com/c/' + ourConversationId });
                        } else {
                            await Page.reload({ ignoreCache: true });
                        }
                        nextPollDelay = 5000; // Allow the refreshed page to hydrate.
                    } catch (refreshError) {
                        console.warn('[ChatGPT Image] Page refresh failed; continuing image checks:', refreshError.message);
                    }
                }

                if (!resolved) {
                    pollTimer = setTimeout(pollForImage, nextPollDelay);
                }
            };
            
            // Start polling after a short delay (give the page time to start rendering)
            pollTimer = setTimeout(pollForImage, 3000);
        });
        } catch (pollError) {
            // Check if this is a rate limit error
            const errorMsg = pollError.message || String(pollError);
            diagLog(`POLL_ERROR_CAUGHT - requestKey: ${requestKey.substring(0, 20)}, errorMsg: ${errorMsg.substring(0, 150)}`);
            
            if (errorMsg.startsWith('RATE_LIMITED:')) {
                diagLog(`POLL_RATE_LIMIT_PASSING - requestKey: ${requestKey.substring(0, 20)}, setting isRateLimitWait flag`);
                console.log('[ChatGPT Image] Rate limit error caught, passing to retry handler');
                
                // CRITICAL: Set flag before completing so the async retry wrapper sees it.
                const existingRequest = pendingRequests.get(requestKey);
                if (existingRequest) {
                    existingRequest.isRateLimitWait = true;
                    diagLog(`RATE_LIMIT_FLAG_SET - requestKey: ${requestKey.substring(0, 20)}, flag set successfully`);
                } else {
                    diagLog(`RATE_LIMIT_FLAG_FAILED - requestKey: ${requestKey.substring(0, 20)}, existingRequest NOT FOUND`);
                }
                
                completeRequest({
                    success: false, 
                    code: 'RATE_LIMITED',
                    value: errorMsg 
                });
                return;
            }
            // Other errors
            diagLog(`POLL_ERROR_OTHER - requestKey: ${requestKey.substring(0, 20)}, resolving with error`);
            console.log('[ChatGPT Image] Polling error:', errorMsg);
            completeRequest({
                success: false, 
                code: 'POLLING_ERROR',
                value: errorMsg 
            });
            return;
        }
        
        console.log('[ChatGPT Image] Image URL:', imageUrl);
        
        // Check if this is a rate limit error that propagated through
        if (!imageUrl && pendingRequests.has(requestKey)) {
            // The promise was rejected but we're still pending - this shouldn't happen normally
            console.log('[ChatGPT Image] Unexpected state: no image URL but request still pending');
        }
        
        // Download the image through the browser (authenticated session) with retry logic
        // ChatGPT sometimes returns partial/placeholder images if downloaded too quickly
        console.log('[ChatGPT Image] Downloading image via browser (with size validation)...');
        
        let downloadResult = null;
        let downloadAttempt = 0;
        let lastError = null;
        
        while (downloadAttempt < MAX_IMAGE_DOWNLOAD_RETRIES) {
            downloadAttempt++;
            
            // Wait before retry (except first attempt)
            if (downloadAttempt > 1) {
                console.log(`[ChatGPT Image] Waiting ${IMAGE_DOWNLOAD_RETRY_DELAY_MS}ms before retry ${downloadAttempt}/${MAX_IMAGE_DOWNLOAD_RETRIES}...`);
                await new Promise(r => setTimeout(r, IMAGE_DOWNLOAD_RETRY_DELAY_MS));
            }
            
            const attemptResult = await Runtime.evaluate({
                expression: `
(async function() {
    try {
        // Blob URLs must be fetched here, in the page that created them.
        const response = await fetch(${JSON.stringify(imageUrl)}, { credentials: 'include' });
        if (!response.ok) {
            return { success: false, error: 'HTTP ' + response.status };
        }
        
        // Get content-length header if available
        const contentLength = response.headers.get('content-length');
        
        const blob = await response.blob();
        const blobSize = blob.size;
        
        console.log('[ChatGPT] Downloaded blob size:', blobSize, 'Content-Length header:', contentLength);
        
        const reader = new FileReader();
        return new Promise((resolve) => {
            reader.onloadend = () => {
                resolve({ 
                    success: true, 
                    dataUrl: reader.result, 
                    size: blobSize,
                    contentLength: contentLength ? parseInt(contentLength) : null
                });
            };
            reader.onerror = () => {
                resolve({ success: false, error: 'Failed to read blob' });
            };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
})()`,
                awaitPromise: true,
                returnByValue: true,
                timeout: 60000
            });
            
            const result = attemptResult.result?.value;
            
            if (!result?.success) {
                lastError = result?.error || 'Unknown error';
                console.log(`[ChatGPT Image] Download attempt ${downloadAttempt} failed: ${lastError}`);
                continue;
            }
            
            const imageSize = result.size || 0;
            console.log(`[ChatGPT Image] Attempt ${downloadAttempt}: Downloaded ${imageSize} bytes (${(imageSize / 1024).toFixed(1)} KB)`);
            
            // Check if image size is valid (ChatGPT images are typically 1.5MB-2.5MB)
            if (imageSize < MIN_IMAGE_SIZE_BYTES) {
                lastError = `Image too small: ${imageSize} bytes (expected at least ${MIN_IMAGE_SIZE_BYTES} bytes). Image may still be generating.`;
                console.log(`[ChatGPT Image] ${lastError}`);
                
                // On last attempt, still save it but warn
                if (downloadAttempt >= MAX_IMAGE_DOWNLOAD_RETRIES) {
                    console.log('[ChatGPT Image] Max retries reached, using small image anyway...');
                    downloadResult = result;
                }
                continue;
            }
            
            // Valid image size
            console.log(`[ChatGPT Image] Valid image size: ${(imageSize / 1024 / 1024).toFixed(2)} MB`);
            downloadResult = result;
            break;
        }
        
        if (!downloadResult) {
            completeRequest({
                success: false, 
                code: 'DOWNLOAD_FAILED',
                value: 'Failed to download image after ' + MAX_IMAGE_DOWNLOAD_RETRIES + ' attempts: ' + (lastError || 'Unknown error')
            });
            return;
        }
        
        // Save the base64 data to file (initially in temp)
        const dataUrl = downloadResult.dataUrl;
        const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const filename = `chatgpt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
        const tempImagePath = path.join(TEMP_DIR, filename);
        
        fs.writeFileSync(tempImagePath, base64Data, 'base64');
        console.log('[ChatGPT Image] Image saved to temp:', tempImagePath, '- Size:', (downloadResult.size / 1024 / 1024).toFixed(2), 'MB');
        
        // Check if AI image cleaning is enabled
        const automationSettings = await readKey('automationSettings') || {};
        const cleanAI = automationSettings.aiImageCleaning !== false; // Default true
        
        // Get image metadata settings for fake EXIF injection
        const imageMetadataSettings = await readKey('imageMetadataSettings') || {};
        
        // CRITICAL: Move to permanent storage to prevent cleanup deletion after 24h
        // Also clean AI metadata if enabled (defeats Pinterest AI detection)
        // Also pass metadata settings for fake EXIF injection
        // Also pass nodeType for SEO metadata generation if enabled
        const moveResult = await moveToPermStorage(tempImagePath, { 
            cleanAI,
            injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
            nodeType: 'chatgptimage',
            workflowId,
            prompt
        });
        const finalImagePath = moveResult.success ? moveResult.permanentPath : tempImagePath;
        
        if (moveResult.success) {
            console.log('[ChatGPT Image] Moved to permanent storage:', finalImagePath);
            // Clean up temp file
            try { fs.unlinkSync(tempImagePath); } catch (_) {}
        } else {
            console.warn('[ChatGPT Image] Failed to move to permanent storage, using temp path:', moveResult.error);
        }
        
        completeRequest({
            success: true, 
            code: 'OK',
            value: finalImagePath,
            imageUrl,
            conversationUrl
        });
        diagLog(`SUCCESS - requestKey: ${requestKey.substring(0, 20)}, imagePath: ${finalImagePath}`);
        
    } catch (error) {
        diagLog(`EXECUTE_ERROR - requestKey: ${requestKey.substring(0, 20)}, error: ${error.message || String(error)}`);
        console.error('[ChatGPT Image] Error:', error);
        completeRequest({
            success: false, 
            code: 'ERROR',
            value: error.message || String(error) 
        });
    } finally {
        diagLog(`FINALLY_BLOCK_ENTER - requestKey: ${requestKey.substring(0, 20)}, hasConversationId: ${!!ourConversationId}, hasBrowser: ${!!browserResult}`);
        
        // Recover the ID from the final URL on every post-submit terminal path. The
        // redirect waiter itself can fail after ChatGPT has already created/navigated.
        if (browserResult?.client && conversationSubmitted && !ourConversationId) {
            try {
                const { Runtime } = browserResult.client;
                for (let attempt = 0; attempt < 6 && !ourConversationId; attempt++) {
                    const currentUrl = await Runtime.evaluate({
                        expression: 'window.location.href',
                        returnByValue: true
                    });
                    const url = currentUrl.result?.value || '';
                    const idMatch = url.match(/\/c\/([a-f0-9-]{36})(?:[/?#]|$)/i);
                    if (idMatch) {
                        ourConversationId = idMatch[1];
                        console.log('[ChatGPT Image] Recovered conversation ID during cleanup:', ourConversationId);
                        break;
                    }
                    if (attempt < 5) await new Promise(r => setTimeout(r, 500));
                }
            } catch (idErr) {
                console.log('[ChatGPT Image] Could not recover conversation ID during cleanup:', idErr.message);
            }
        }

        // Delete before closing the browser so its authenticated session remains usable.
        if (browserResult?.client && ourConversationId) {
            try {
                const deleteResult = await deleteConversation(browserResult.client.Runtime, ourConversationId, capturedAuthHeaders);
                if (!deleteResult.success) {
                    console.error('[ChatGPT Image] Conversation cleanup failed:', deleteResult.error);
                }
            } catch (deleteErr) {
                console.error('[ChatGPT Image] Error during conversation cleanup:', deleteErr.message);
            }
        } else if (conversationSubmitted) {
            console.warn('[ChatGPT Image] Conversation cleanup could not run because no conversation ID was discovered');
        }

        // Do not report terminal success/failure until the conversation delete attempt
        // has completed. The retry wrapper is intentionally not awaited because a
        // rate-limit result starts its own long, interruptible wait.
        if (deferredResult) {
            resolve(deferredResult);
            deferredResult = null;
        }
        
        // ALWAYS clean up browser - use graceful close to preserve cookies/session
        if (browserResult) {
            try {
                if (browserResult.client && browserResult.debuggingPort) {
                    // Graceful close via CDP - allows Chrome to flush cookies to disk
                    console.log('[ChatGPT Image] Closing browser gracefully...');
                    try {
                        const WebSocket = require('ws');
                        const debugUrl = `http://localhost:${browserResult.debuggingPort}/json/version`;
                        const res = await fetch(debugUrl);
                        const info = await res.json();
                        const browserWsUrl = info.webSocketDebuggerUrl;
                        
                        if (browserWsUrl) {
                            const ws = new WebSocket(browserWsUrl);
                            await new Promise((resolve, reject) => {
                                ws.on('open', () => {
                                    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
                                    setTimeout(() => {
                                        ws.close();
                                        resolve();
                                    }, 500);
                                });
                                ws.on('error', reject);
                                setTimeout(reject, 3000);
                            });
                            console.log('[ChatGPT Image] Browser closed gracefully via CDP');
                        } else {
                            throw new Error('No WebSocket URL available');
                        }
                    } catch (closeErr) {
                        console.log('[ChatGPT Image] Graceful close failed, using fallback:', closeErr.message);
                        if (browserResult.client) {
                            await browserResult.client.close().catch(() => {});
                        }
                        if (browserResult.chromeProcess) {
                            browserResult.chromeProcess.kill();
                        }
                    }
                } else if (browserResult.chromeProcess) {
                    // Fallback to hard kill if no CDP available
                    browserResult.chromeProcess.kill();
                    console.log('[ChatGPT Image] Browser closed (hard kill - no CDP)');
                }
            } catch (e) {
                console.error('[ChatGPT Image] Error closing browser:', e.message);
            }
            
            // Record browser close time for cooldown period
            lastBrowserCloseTime.set(profileId, Date.now());
        }

        activeRequestBrowsers.delete(requestKey);
        requestAbortControllers.delete(requestKey);
        
        // Mark request as complete
        onRequestComplete(profileId, requestKey);
    }
}

module.exports = {
    startImageRequest,
    stopWorkflowQueues,
    clearWorkflowStateForRerun,
    getQueueStatus,
    getConnectedProfiles,
    
    // Expose config for external reading
    get MAX_CONCURRENT() { return MAX_CONCURRENT; },
    
    // Get effective max concurrency (1 per connected profile)
    getEffectiveMaxConcurrent() {
        const connectedCount = getConnectedProfiles().length;
        return Math.max(1, connectedCount); // At least 1, or number of connected profiles
    }
};
