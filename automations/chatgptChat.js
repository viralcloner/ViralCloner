/**
 * ChatGPT Chat Module
 * Uses browser automation to interact with ChatGPT's chat interface
 * Includes queue system, workflow management, and proper resource cleanup
 * 
 * Input: text (required), image (optional local path)
 * Output: text (ChatGPT's response)
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { readKey } = require('../lib/utils');
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getLatestChromeVersion } = require('../lib/cdpFingerprint');

// ============ CONFIGURATION ============
const MAX_CONCURRENT = 1;                    // Max concurrent requests per ChatGPT profile
const REQUEST_DELAY_MS = 3000;               // Delay between requests (3s)
const CHAT_TIMEOUT_MS = 3 * 60 * 1000;       // 3 minutes timeout for chat response
const CONVERSATION_REDIRECT_TIMEOUT_MS = 35000; // 35s for redirect to conversation
const BROWSER_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes idle before closing browser

// Rate limit handling
const RATE_LIMIT_DEFAULT_WAIT_MS = 3 * 60 * 1000;  // 3 minutes default wait
const RATE_LIMIT_MAX_RETRIES = 2;                  // Max retry attempts after rate limit wait

// ============ STATE MANAGEMENT ============
// Queue system per profile: { queue: [], activeCount: 0, lastRequestTime: 0, processing: false }
const profileQueues = new Map();

// Browser sessions per profile: { browserResult, client, Runtime, Page, Network, DOM, Browser, idleTimer, lastActivity, capturedAuthHeaders }
const browserSessions = new Map();

// Pending requests: requestKey -> { prompt, workflowId, resolve, reject, profileId, startTime }
const pendingRequests = new Map();

// Workflow tracking: workflowId -> Set of requestKeys
const workflowRequests = new Map();

// AbortControllers for rate-limit sleeps: requestKey -> AbortController
// Used to interrupt sleep when workflow is stopped/rerun
const rateLimitAbortControllers = new Map();

// Request counter for unique keys
let requestCounter = 0;

// ============ BROWSER SESSION MANAGEMENT ============

/**
 * Get or create a browser session for a profile
 * Reuses existing sessions and resets the idle timeout
 */
async function getBrowserSession(profileId) {
    // Check if we have an existing valid session
    if (browserSessions.has(profileId)) {
        const session = browserSessions.get(profileId);
        
        // Verify session is still valid
        try {
            const testResult = await session.Runtime.evaluate({
                expression: 'window.location.href',
                returnByValue: true,
                timeout: 5000
            });
            
            if (testResult.result?.value) {
                console.log(`[ChatGPT Chat] Reusing existing browser session for ${profileId.substring(0, 8)}...`);
                resetIdleTimer(profileId);
                return session;
            }
        } catch (e) {
            console.log(`[ChatGPT Chat] Existing session invalid for ${profileId.substring(0, 8)}..., creating new one`);
            await closeBrowserSession(profileId);
        }
    }
    
    // Create new session
    console.log(`[ChatGPT Chat] Creating new browser session for ${profileId.substring(0, 8)}...`);
    const session = await createBrowserSession(profileId);
    
    if (session) {
        browserSessions.set(profileId, session);
        resetIdleTimer(profileId);
    }
    
    return session;
}

/**
 * Create a new browser session for a profile
 */
async function createBrowserSession(profileId) {
    // Check if VCBrowser is installed
    if (!isVCBrowserInstalled()) {
        return null;
    }
    
    // Generate consistent fingerprint for the profile
    const fingerprint = getConsistentFingerprintForProfile(profileId);
    
    // Update to latest Chrome version
    try {
        const latestVersion = await getLatestChromeVersion();
        if (fingerprint.userAgent && latestVersion?.full) {
            fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${latestVersion.full}`);
        }
    } catch (e) { /* use fallback */ }
    
    // Start VCBrowser with the profile
    const browserResult = await startVCBrowser(
        profileId, 
        fingerprint,
        'https://chatgpt.com/', 
        null,           // proxy
        true,           // headless
        true            // automationMode
    );
    
    if (!browserResult || !browserResult.client) {
        return null;
    }
    
    console.log('[ChatGPT Chat] VCBrowser started, port:', browserResult.debuggingPort);
    
    const client = browserResult.client;
    const { Runtime, Page, Network, Browser, DOM } = client;
    
    await Promise.all([
        Runtime.enable(),
        Page.enable(),
        Network.enable(),
        DOM.enable()
    ]);
    
    // Grant clipboard permissions
    try {
        await Browser.grantPermissions({
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            origin: 'https://chatgpt.com'
        });
    } catch (permErr) {
        console.log('[ChatGPT Chat] Permission grant warning:', permErr.message);
    }
    
    // Set up auth header capture
    const capturedAuthHeaders = {
        authorization: null,
        oaiDeviceId: null,
        oaiClientBuildNumber: null,
        oaiClientVersion: null,
        oaiLanguage: null
    };
    
    // Listen for API requests to capture auth headers
    Network.requestWillBeSent((params) => {
        const url = params.request?.url || '';
        const headers = params.request?.headers || {};
        
        if (url.includes('/backend-api/')) {
            if (headers['authorization'] || headers['Authorization']) {
                capturedAuthHeaders.authorization = headers['authorization'] || headers['Authorization'];
            }
            if (headers['oai-device-id']) {
                capturedAuthHeaders.oaiDeviceId = headers['oai-device-id'];
            }
            if (headers['oai-client-build-number']) {
                capturedAuthHeaders.oaiClientBuildNumber = headers['oai-client-build-number'];
            }
            if (headers['oai-client-version']) {
                capturedAuthHeaders.oaiClientVersion = headers['oai-client-version'];
            }
            if (headers['oai-language']) {
                capturedAuthHeaders.oaiLanguage = headers['oai-language'];
            }
        }
    });
    
    return {
        browserResult,
        client,
        Runtime,
        Page,
        Network,
        DOM,
        Browser,
        capturedAuthHeaders,
        idleTimer: null,
        lastActivity: Date.now()
    };
}

/**
 * Reset the idle timer for a browser session
 */
function resetIdleTimer(profileId) {
    const session = browserSessions.get(profileId);
    if (!session) return;
    
    // Clear existing timer
    if (session.idleTimer) {
        clearTimeout(session.idleTimer);
    }
    
    // Set new timer
    session.idleTimer = setTimeout(() => {
        // Check if there are active requests before closing
        const queueData = profileQueues.get(profileId);
        if (queueData && queueData.activeCount > 0) {
            console.log(`[ChatGPT Chat] Browser has ${queueData.activeCount} active requests, resetting idle timer`);
            resetIdleTimer(profileId); // Reset timer instead of closing
            return;
        }
        
        console.log(`[ChatGPT Chat] Browser idle timeout reached for ${profileId.substring(0, 8)}..., closing session`);
        closeBrowserSession(profileId);
    }, BROWSER_IDLE_TIMEOUT_MS);
    
    session.lastActivity = Date.now();
}

/**
 * Close a browser session for a profile
 */
async function closeBrowserSession(profileId) {
    const session = browserSessions.get(profileId);
    if (!session) return;
    
    console.log(`[ChatGPT Chat] Closing browser session for ${profileId.substring(0, 8)}...`);
    
    // Clear timer
    if (session.idleTimer) {
        clearTimeout(session.idleTimer);
    }
    
    // Close browser
    try {
        if (session.browserResult?.client && session.browserResult?.debuggingPort) {
            try {
                const WebSocket = require('ws');
                const debugUrl = `http://localhost:${session.browserResult.debuggingPort}/json/version`;
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
                    console.log('[ChatGPT Chat] Browser closed gracefully via CDP');
                } else {
                    throw new Error('No WebSocket URL available');
                }
            } catch (closeErr) {
                console.log('[ChatGPT Chat] Graceful close failed, using fallback:', closeErr.message);
                if (session.browserResult.client) {
                    await session.browserResult.client.close().catch(() => {});
                }
                if (session.browserResult.chromeProcess) {
                    session.browserResult.chromeProcess.kill();
                }
            }
        } else if (session.browserResult?.chromeProcess) {
            session.browserResult.chromeProcess.kill();
            console.log('[ChatGPT Chat] Browser closed (hard kill - no CDP)');
        }
    } catch (e) {
        console.error('[ChatGPT Chat] Error closing browser:', e.message);
    }
    
    browserSessions.delete(profileId);
}

/**
 * Close all browser sessions (for cleanup)
 */
async function closeAllBrowserSessions() {
    console.log(`[ChatGPT Chat] Closing all browser sessions (${browserSessions.size} active)...`);
    const closePromises = [];
    for (const profileId of browserSessions.keys()) {
        closePromises.push(closeBrowserSession(profileId));
    }
    await Promise.all(closePromises);
}

/**
 * Navigate browser session back to ChatGPT home page
 */
async function navigateToHome(session) {
    try {
        await session.Page.navigate({ url: 'https://chatgpt.com/' });
        
        // Wait for navigation to complete
        await new Promise(r => setTimeout(r, 2000));
        
        // Wait for page to be ready
        await session.Runtime.evaluate({
            expression: `new Promise(r => {
                if (document.readyState === 'complete') r();
                else window.addEventListener('load', r);
            })`,
            awaitPromise: true,
            timeout: 10000
        });
        
        // Additional wait for React hydration
        await new Promise(r => setTimeout(r, 3000));
        
        return true;
    } catch (e) {
        console.log('[ChatGPT Chat] Error navigating to home:', e.message);
        return false;
    }
}

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
    return `chat:${profileId}:${Date.now()}:${++requestCounter}`;
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
                console.log(`[ChatGPT Chat] Waiting ${waitTime}ms before next request...`);
                await new Promise(r => setTimeout(r, waitTime));
            }
            
            // Double-check capacity after waiting
            if (queueData.activeCount >= MAX_CONCURRENT) break;
            
            const task = queueData.queue.shift();
            
            // Skip null placeholders
            if (!task) {
                if (task === null) {
                    queueData.queue.unshift(null);
                    await new Promise(r => setTimeout(r, 10));
                }
                continue;
            }
            
            queueData.activeCount++;
            queueData.lastRequestTime = Date.now();
            
            console.log(`[ChatGPT Chat] Processing request for ${profileId.substring(0, 8)}... Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
            
            // Execute with rate limit retry wrapper
            executeWithRateLimitRetry(task, 0);
        }
    } finally {
        queueData.processing = false;
    }
}

function onRequestComplete(profileId, requestKey) {
    const queueData = getProfileQueue(profileId);
    queueData.activeCount = Math.max(0, queueData.activeCount - 1);
    
    // Check if this request is in rate limit wait (will be retried)
    // Don't clean up state - the rate limit sleep code will check pendingRequests
    const request = pendingRequests.get(requestKey);
    if (request?.isRateLimitWait) {
        console.log(`[ChatGPT Chat] Request in rate limit wait, preserving state for retry. Active: ${queueData.activeCount}/${MAX_CONCURRENT}`);
        // Still process the queue since this slot is now free (browser closed)
        processQueue(profileId);
        return;
    }
    
    // Full cleanup for completed requests
    pendingRequests.delete(requestKey);
    
    // Clean up any lingering rate-limit abort controller
    if (rateLimitAbortControllers.has(requestKey)) {
        rateLimitAbortControllers.delete(requestKey);
    }
    
    // Clean up from workflow tracking
    for (const [workflowId, requestKeys] of workflowRequests.entries()) {
        requestKeys.delete(requestKey);
        if (requestKeys.size === 0) {
            workflowRequests.delete(workflowId);
        }
    }
    
    console.log(`[ChatGPT Chat] Request complete. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
    
    // Process next in queue
    processQueue(profileId);
}

/**
 * Execute chat request with automatic rate limit retry
 */
async function executeWithRateLimitRetry(task, retryCount) {
    const { requestKey, profileId, prompt, imagePath, workflowId, resolve } = task;
    
    const wrappedResolve = async (result) => {
        // Check if this is a rate limit error
        if (!result.success && result.value?.startsWith?.('RATE_LIMITED:')) {
            const waitMs = parseInt(result.value.split(':')[1]) || RATE_LIMIT_DEFAULT_WAIT_MS;
            const waitMinutes = Math.ceil(waitMs / 60000);
            
            if (retryCount < RATE_LIMIT_MAX_RETRIES) {
                console.log(`[ChatGPT Chat] Rate limited! Waiting ${waitMinutes} minutes before retry ${retryCount + 1}/${RATE_LIMIT_MAX_RETRIES}...`);
                
                pendingRequests.set(requestKey, {
                    prompt,
                    imagePath,
                    workflowId,
                    profileId,
                    startTime: Date.now(),
                    resolve,
                    isRateLimitWait: true
                });
                
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
                const actualWaitMs = waitMs + 10000;
                let wasAborted = false;
                try {
                    await new Promise((sleepResolve, sleepReject) => {
                        const timeoutId = setTimeout(sleepResolve, actualWaitMs);
                        abortController.signal.addEventListener('abort', () => {
                            clearTimeout(timeoutId);
                            sleepReject(new Error('ABORTED'));
                        });
                    });
                } catch (sleepErr) {
                    if (sleepErr.message === 'ABORTED') {
                        wasAborted = true;
                        console.log('[ChatGPT Chat] Rate limit sleep was interrupted (workflow stopped/rerun)');
                    } else {
                        throw sleepErr;
                    }
                } finally {
                    rateLimitAbortControllers.delete(requestKey);
                }
                
                // Check if workflow was stopped during the wait
                if (wasAborted || !pendingRequests.has(requestKey)) {
                    console.log('[ChatGPT Chat] Workflow was stopped during rate limit wait');
                    // Don't call resolve() here - stopWorkflowQueues already resolved it
                    return;
                }
                
                console.log(`[ChatGPT Chat] Rate limit wait complete, retrying...`);
                executeWithRateLimitRetry(task, retryCount + 1);
                return;
            }
            
            console.log(`[ChatGPT Chat] Rate limit max retries (${RATE_LIMIT_MAX_RETRIES}) exceeded`);
            resolve({
                success: false,
                code: 'RATE_LIMITED',
                value: `Rate limited by ChatGPT after ${retryCount} retries.`
            });
            return;
        }
        
        resolve(result);
    };
    
    executeChatRequest(requestKey, profileId, prompt, imagePath, workflowId, wrappedResolve);
}

// ============ PUBLIC API ============

/**
 * Get all connected ChatGPT profiles
 * @returns {Array<string>} Array of connected profile IDs
 */
function getConnectedProfiles() {
    const openaiProfiles = readKey('openaiProfiles') || {};
    const allProfiles = Object.entries(openaiProfiles);
    const connectedProfiles = allProfiles
        .filter(([name, data]) => {
            // Must be connected
            if (data?.status !== 'connected') return false;
            // Must have 'chat' capability (default to true for backward compatibility)
            const capabilities = data?.capabilities || ['image', 'chat'];
            return capabilities.includes('chat');
        })
        .map(([name]) => name);
    
    console.log(`[ChatGPT Chat] getConnectedProfiles: Found ${allProfiles.length} total profiles, ${connectedProfiles.length} connected with chat capability`);
    
    return connectedProfiles;
}

/**
 * Select the best profile for a new request using load balancing
 */
function selectBestProfileAndReserve() {
    const connectedProfiles = getConnectedProfiles();
    
    if (connectedProfiles.length === 0) {
        console.log('[ChatGPT Chat] selectBestProfile: No connected profiles available!');
        return null;
    }
    
    let bestProfile = connectedProfiles[0];
    let minLoad = Infinity;
    let bestQueueData = getProfileQueue(connectedProfiles[0]);
    
    for (const profileId of connectedProfiles) {
        const queueData = getProfileQueue(profileId);
        const load = queueData.activeCount + queueData.queue.length;
        
        if (load < minLoad) {
            minLoad = load;
            bestProfile = profileId;
            bestQueueData = queueData;
        }
    }
    
    const placeholderIndex = bestQueueData.queue.length;
    bestQueueData.queue.push(null);
    
    console.log(`[ChatGPT Chat] selectBestProfile: Selected ${bestProfile.substring(0, 8)}... (load was: ${minLoad}, now: ${minLoad + 1})`);
    
    return { profileId: bestProfile, queueData: bestQueueData, placeholderIndex };
}

/**
 * Queue a chat request
 * @param {string} prompt - The chat prompt/message
 * @param {string} imagePath - Optional reference image path
 * @param {string} profileId - ChatGPT profile name (optional, auto-selects best profile)
 * @param {string} workflowId - Workflow ID for cleanup tracking (optional)
 * @returns {Promise<{success: boolean, value: string, code?: string}>}
 */
async function startChatRequest(prompt, imagePath = null, profileId = null, workflowId = null) {
    try {
        const openaiProfiles = readKey('openaiProfiles') || {};
        
        let selectedProfile = profileId;
        let queueData = null;
        let placeholderIndex = -1;
        
        if (!selectedProfile) {
            const selection = selectBestProfileAndReserve();
            if (!selection) {
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
            if (!openaiProfiles[selectedProfile] || openaiProfiles[selectedProfile].status !== 'connected') {
                return { 
                    success: false, 
                    code: 'PROFILE_NOT_CONNECTED',
                    value: `ChatGPT profile "${selectedProfile}" is not connected` 
                };
            }
            queueData = getProfileQueue(selectedProfile);
            placeholderIndex = -1;
        }
        
        const requestKey = generateRequestKey(selectedProfile);
        
        return new Promise((resolve) => {
            const task = {
                requestKey,
                profileId: selectedProfile,
                prompt,
                imagePath,
                workflowId,
                resolve
            };
            
            pendingRequests.set(requestKey, {
                prompt,
                imagePath,
                workflowId,
                profileId: selectedProfile,
                startTime: Date.now(),
                resolve
            });
            
            if (workflowId) {
                if (!workflowRequests.has(workflowId)) {
                    workflowRequests.set(workflowId, new Set());
                }
                workflowRequests.get(workflowId).add(requestKey);
            }
            
            if (placeholderIndex >= 0 && placeholderIndex < queueData.queue.length && queueData.queue[placeholderIndex] === null) {
                queueData.queue[placeholderIndex] = task;
            } else {
                queueData.queue.push(task);
            }
            
            console.log(`[ChatGPT Chat] Request queued. Profile: ${selectedProfile.substring(0, 8)}..., Queue size: ${queueData.queue.length}`);
            
            processQueue(selectedProfile);
        });
        
    } catch (error) {
        console.error('[ChatGPT Chat] Error in startChatRequest:', error);
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
    console.log(`[ChatGPT Chat] Stopping all requests for workflow ${workflowId}...`);
    let removedFromQueue = 0;
    let removedPending = 0;
    let abortedRateLimitSleeps = 0;
    
    const requestKeys = workflowRequests.get(workflowId) || new Set();
    
    // FIRST: Abort any rate-limit sleeps for this workflow's requests
    // This must happen BEFORE deleting from pendingRequests to prevent race conditions
    for (const requestKey of requestKeys) {
        const abortController = rateLimitAbortControllers.get(requestKey);
        if (abortController) {
            console.log(`[ChatGPT Chat] Aborting rate-limit sleep for request ${requestKey.substring(0, 20)}...`);
            abortController.abort();
            rateLimitAbortControllers.delete(requestKey);
            abortedRateLimitSleeps++;
        }
    }
    
    for (const [profileId, queueData] of profileQueues.entries()) {
        const originalLength = queueData.queue.length;
        
        const itemsToRemove = queueData.queue.filter(item => item && item.workflowId === workflowId);
        queueData.queue = queueData.queue.filter(item => !item || item.workflowId !== workflowId);
        
        for (const item of itemsToRemove) {
            item.resolve({
                success: false,
                code: 'WORKFLOW_STOPPED',
                value: 'Workflow was stopped'
            });
            pendingRequests.delete(item.requestKey);
            removedFromQueue++;
        }
    }
    
    for (const requestKey of requestKeys) {
        const request = pendingRequests.get(requestKey);
        if (request) {
            request.resolve({
                success: false,
                code: 'WORKFLOW_STOPPED',
                value: 'Workflow was stopped'
            });
            pendingRequests.delete(requestKey);
            removedPending++;
        }
    }
    
    workflowRequests.delete(workflowId);
    
    console.log(`[ChatGPT Chat] Workflow ${workflowId} cleanup complete: removed ${removedFromQueue} queued + ${removedPending} pending + ${abortedRateLimitSleeps} rate-limit sleeps aborted`);
}

/**
 * Clear workflow state for rerun - clears tracking entries without aborting active operations
 * This prevents "Workflow stopped by user" errors on immediate reruns
 * @param {string} workflowId - The workflow ID to clear state for
 */
function clearWorkflowStateForRerun(workflowId) {
    console.log(`[ChatGPT Chat] Clearing state for workflow ${workflowId} rerun...`);
    
    // Clear workflow tracking entry (don't abort or resolve - just remove tracking)
    const hadEntry = workflowRequests.delete(workflowId);
    if (hadEntry) {
        console.log(`[ChatGPT Chat] Cleared workflowRequests entry for workflow ${workflowId}`);
    }
}

/**
 * Get queue status for monitoring
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
 * Delete a ChatGPT conversation by making it invisible
 */
async function deleteConversation(Runtime, conversationId, authHeaders) {
    if (!conversationId) {
        return { success: false, error: 'No conversation ID provided' };
    }
    
    console.log('[ChatGPT Chat] Deleting conversation:', conversationId);
    
    try {
        const headersJson = JSON.stringify({
            'Content-Type': 'application/json',
            ...(authHeaders?.authorization ? { 'authorization': authHeaders.authorization } : {}),
            ...(authHeaders?.oaiDeviceId ? { 'oai-device-id': authHeaders.oaiDeviceId } : {}),
            ...(authHeaders?.oaiClientBuildNumber ? { 'oai-client-build-number': authHeaders.oaiClientBuildNumber } : {}),
            ...(authHeaders?.oaiClientVersion ? { 'oai-client-version': authHeaders.oaiClientVersion } : {}),
            ...(authHeaders?.oaiLanguage ? { 'oai-language': authHeaders.oaiLanguage } : {})
        });
        
        const deleteUrl = `https://chatgpt.com/backend-api/conversation/${conversationId}`;
        
        const result = await Runtime.evaluate({
            expression: `
(async function() {
    try {
        const headers = ${headersJson};
        const response = await fetch('${deleteUrl}', {
            method: 'PATCH',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify({ is_visible: false })
        });
        
        if (!response.ok) {
            return { success: false, error: 'HTTP ' + response.status };
        }
        
        const data = await response.json();
        return { success: data.success === true, data: data };
    } catch (e) {
        return { success: false, error: e.message };
    }
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: 10000
        });
        
        const deleteResult = result.result?.value;
        if (deleteResult?.success) {
            console.log('[ChatGPT Chat] Conversation deleted successfully');
        } else {
            console.log('[ChatGPT Chat] Conversation deletion result:', deleteResult?.error || JSON.stringify(deleteResult));
        }
        return deleteResult || { success: false, error: 'No result' };
    } catch (e) {
        console.error('[ChatGPT Chat] Error deleting conversation:', e.message);
        return { success: false, error: e.message };
    }
}

async function executeChatRequest(requestKey, profileId, prompt, imagePath, workflowId, resolve) {
    let session = null;
    let ourConversationId = null;
    
    try {
        console.log('[ChatGPT Chat] Starting chat request...');
        console.log('[ChatGPT Chat] Profile:', profileId);
        console.log('[ChatGPT Chat] Prompt:', prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''));
        if (imagePath) {
            console.log('[ChatGPT Chat] Reference image:', imagePath);
        }
        
        // Check if request was cancelled before starting
        if (!pendingRequests.has(requestKey)) {
            console.log('[ChatGPT Chat] Request was cancelled before execution');
            return;
        }
        
        // Get or create browser session (with reuse)
        session = await getBrowserSession(profileId);
        
        if (!session) {
            resolve({ 
                success: false, 
                code: 'BROWSER_FAILED',
                value: 'Failed to get browser session (VCBrowser may not be installed)' 
            });
            return;
        }
        
        const { Runtime, Page, Network, DOM, Browser, capturedAuthHeaders } = session;
        
        // Check if we need to navigate to home (for session reuse)
        const currentUrl = await Runtime.evaluate({
            expression: 'window.location.href',
            returnByValue: true,
            timeout: 5000
        });
        
        const url = currentUrl.result?.value || '';
        if (!url.endsWith('chatgpt.com/') && !url.endsWith('chatgpt.com')) {
            console.log('[ChatGPT Chat] Navigating to ChatGPT home for new conversation...');
            await navigateToHome(session);
        }
        
        // Wait for page to fully load
        console.log('[ChatGPT Chat] Waiting for page to load...');
        await new Promise(r => setTimeout(r, 3000));
        
        // Check if cancelled
        if (!pendingRequests.has(requestKey)) {
            console.log('[ChatGPT Chat] Request cancelled during page load');
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
        console.log('[ChatGPT Chat] Waiting for React hydration...');
        await new Promise(r => setTimeout(r, 5000));
        
        // Debug: Check current URL and page state
        const pageInfo = await Runtime.evaluate({
            expression: `JSON.stringify({ url: window.location.href, title: document.title, bodyLength: document.body?.innerHTML?.length || 0 })`
        });
        console.log('[ChatGPT Chat] Page info:', pageInfo.result?.value);
        
        // Step 1: Wait for the ProseMirror editor
        console.log('[ChatGPT Chat] Looking for input field...');
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
        console.log('[ChatGPT Chat] Input search result:', JSON.stringify(inputResult));
        
        if (!inputResult?.found) {
            resolve({ 
                success: false, 
                code: 'INPUT_NOT_FOUND',
                value: 'Could not find ChatGPT input field. Debug: ' + JSON.stringify(inputResult?.debug || [])
            });
            return;
        }
        
        const inputSelector = inputResult.selector;
        console.log('[ChatGPT Chat] Found input with selector:', inputSelector);
        
        // Step 2: Upload reference image if provided
        if (imagePath && fs.existsSync(imagePath)) {
            console.log('[ChatGPT Chat] Uploading reference image...');
            
            // Click the plus button to open file picker
            const clickPlusResult = await Runtime.evaluate({
                expression: `
(async function() {
    const plusBtn = document.querySelector('#composer-plus-btn');
    if (!plusBtn) return { success: false, error: 'Plus button not found' };
    plusBtn.click();
    await new Promise(r => setTimeout(r, 500));
    return { success: true };
})()`,
                awaitPromise: true,
                returnByValue: true,
                timeout: 5000
            });
            
            if (clickPlusResult.result?.value?.success) {
                await new Promise(r => setTimeout(r, 500));
                
                // Look for file input
                const fileInputResult = await Runtime.evaluate({
                    expression: `
(async function() {
    for (let i = 0; i < 20; i++) {
        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput) {
            return { success: true, found: true };
        }
        await new Promise(r => setTimeout(r, 200));
    }
    return { success: false, error: 'File input not found' };
})()`,
                    awaitPromise: true,
                    returnByValue: true,
                    timeout: 10000
                });
                
                if (fileInputResult.result?.value?.success) {
                    // Get the file input node
                    const doc = await DOM.getDocument();
                    const fileInputNode = await DOM.querySelector({
                        nodeId: doc.root.nodeId,
                        selector: 'input[type="file"]'
                    });
                    
                    if (fileInputNode.nodeId) {
                        // Set files on the input using CDP
                        await DOM.setFileInputFiles({
                            nodeId: fileInputNode.nodeId,
                            files: [imagePath]
                        });
                        console.log('[ChatGPT Chat] Image file set on input');
                        
                        // Wait for upload to process
                        console.log('[ChatGPT Chat] Waiting for image upload to process...');
                        await new Promise(r => setTimeout(r, 3000));
                    }
                } else {
                    console.log('[ChatGPT Chat] Warning: File input not found, continuing without image');
                    // Click somewhere to close the menu
                    await Runtime.evaluate({
                        expression: `document.body.click()`,
                        returnByValue: true
                    });
                    await new Promise(r => setTimeout(r, 300));
                }
            } else {
                console.log('[ChatGPT Chat] Warning: Could not click plus button, continuing without image');
            }
        }
        
        // Step 3: Fill the prompt
        const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        const escapedSelector = inputSelector.replace(/'/g, "\\'");
        
        console.log('[ChatGPT Chat] Filling prompt...');
        
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
                console.log(`[ChatGPT Chat] Prompt fill attempt ${fillAttempt}/3 failed:`, errorMsg);
                
                if (errorMsg.includes('Promise was collected') || errorMsg.includes('context was destroyed')) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                throw fillError;
            }
        }
        
        if (!promptFillSuccess) {
            resolve({ 
                success: false, 
                code: 'PROMPT_FILL_FAILED',
                value: 'Failed to fill prompt after 3 attempts' 
            });
            return;
        }
        
        await new Promise(r => setTimeout(r, 500));
        
        // Step 4: Click submit button
        console.log('[ChatGPT Chat] Waiting for submit button...');
        const clickResult = await Runtime.evaluate({
            expression: `
(async function() {
    const maxAttempts = 120;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const button = document.querySelector('#composer-submit-button');
        if (!button) {
            if (attempt === maxAttempts - 1) return { success: false, error: 'Submit button not found' };
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        if (!button.disabled) {
            button.click();
            return { success: true, attempts: attempt };
        }
        if (attempt > 0 && attempt % 10 === 0) {
            console.log('[ChatGPT] Still waiting for submit button... attempt', attempt);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Submit button remained disabled' };
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: 65000
        });
        
        console.log('[ChatGPT Chat] Submit result:', JSON.stringify(clickResult.result?.value));
        
        if (!clickResult.result?.value?.success) {
            resolve({ 
                success: false, 
                code: 'SUBMIT_FAILED',
                value: clickResult.result?.value?.error || 'Failed to submit prompt' 
            });
            return;
        }
        
        // Step 5: Wait for redirect to conversation OR response starting on current page
        // ChatGPT sometimes doesn't redirect but shows the response on the same page
        console.log('[ChatGPT Chat] Waiting for conversation redirect...');
        const waitForConversation = await Runtime.evaluate({
            expression: `
(async function() {
    return new Promise((resolve) => {
        let attempts = 0;
        const check = () => {
            const url = window.location.href;
            
            // Check if we got redirected to conversation page
            if (url.includes('/c/')) {
                resolve({ success: true, url: url, method: 'redirect' });
                return;
            }
            
            // Check if response is starting on current page (no redirect case)
            const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
            const isStreaming = document.querySelector('[data-testid="stop-button"]') !== null ||
                               document.querySelector('.result-streaming') !== null;
            
            if (assistantMessages.length > 0 || isStreaming) {
                // Response is starting without redirect
                resolve({ success: true, url: url, method: 'no_redirect', reason: 'response_starting' });
                return;
            }
            
            if (attempts++ > 70) {
                // Check one more time for any response content
                if (document.querySelectorAll('[data-message-author-role="assistant"]').length > 0) {
                    resolve({ success: true, url: url, method: 'no_redirect', reason: 'response_found_late' });
                } else {
                    resolve({ success: false, error: 'No conversation redirect or response detected' });
                }
            } else {
                setTimeout(check, 500);
            }
        };
        check();
    });
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: CONVERSATION_REDIRECT_TIMEOUT_MS
        });
        
        if (!waitForConversation.result?.value?.success) {
            resolve({ 
                success: false, 
                code: 'REDIRECT_FAILED',
                value: waitForConversation.result?.value?.error || 'Failed to redirect to conversation page' 
            });
            return;
        }
        
        const conversationResult = waitForConversation.result.value;
        console.log('[ChatGPT Chat] Conversation detected via:', conversationResult.method, 'URL:', conversationResult.url);
        
        // Extract conversation_id from URL if available
        const conversationIdMatch = conversationResult.url.match(/\/c\/([a-f0-9-]+)/i);
        ourConversationId = conversationIdMatch ? conversationIdMatch[1] : null;
        if (ourConversationId) {
            console.log('[ChatGPT Chat] Our conversation ID:', ourConversationId);
        } else {
            console.log('[ChatGPT Chat] No conversation ID (response on main page)');
        }
        
        // Step 6: Wait for and extract the response
        console.log('[ChatGPT Chat] Waiting for response...');
        
        const responseText = await new Promise((resolveResponse, rejectResponse) => {
            let resolved = false;
            let pollCount = 0;
            let pollTimer = null;
            let lastResponseText = '';
            let stableCount = 0;
            
            const totalTimeout = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                if (pollTimer) clearTimeout(pollTimer);
                rejectResponse(new Error('Timeout waiting for response'));
            }, CHAT_TIMEOUT_MS);
            
            // Poll for the response text
            const pollForResponse = async () => {
                if (resolved) return;
                
                // Check cancellation
                if (!pendingRequests.has(requestKey)) {
                    resolved = true;
                    clearTimeout(totalTimeout);
                    rejectResponse(new Error('Request cancelled'));
                    return;
                }
                
                pollCount++;
                
                try {
                    // Extract the assistant's response from the page
                    const extractResult = await Runtime.evaluate({
                        expression: `
(function() {
    // Find all assistant messages
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length === 0) {
        return { found: false, reason: 'no_messages' };
    }
    
    // Get the last assistant message
    const lastMessage = assistantMessages[assistantMessages.length - 1];
    
    // Check if response is still streaming (has streaming indicator)
    const isStreaming = lastMessage.querySelector('.result-streaming') !== null ||
                       lastMessage.querySelector('[class*="streaming"]') !== null ||
                       document.querySelector('[data-testid="stop-button"]') !== null;
    
    // Clone the element to manipulate without affecting the page
    const clone = lastMessage.cloneNode(true);
    
    // Remove UI elements that shouldn't be part of the content (copy buttons, etc.)
    const uiSelectors = [
        'button',
        '[class*="copy"]',
        '[class*="Copy"]', 
        '[data-testid*="copy"]',
        '.flex.items-center',
        '.absolute',
        '[class*="sticky"]',
        'svg',
        '.sr-only'
    ];
    uiSelectors.forEach(sel => {
        clone.querySelectorAll(sel).forEach(el => el.remove());
    });
    
    // Get the markdown content specifically (cleaner extraction)
    const markdownDiv = clone.querySelector('.markdown');
    let finalText = '';
    
    if (markdownDiv) {
        // For code blocks, mark them with a unique separator to preserve structure
        markdownDiv.querySelectorAll('pre code').forEach(codeEl => {
            const codeText = codeEl.textContent || '';
            // Use triple backtick markers for code blocks
            const marker = String.fromCharCode(96, 96, 96); // backticks
            codeEl.textContent = marker + '\\n' + codeText + '\\n' + marker;
        });
        finalText = markdownDiv.textContent || markdownDiv.innerText || '';
    } else {
        finalText = clone.textContent || clone.innerText || '';
    }
    
    // Clean up any remaining UI artifacts
    finalText = finalText
        .replace(/Copier le code/g, '')
        .replace(/Copy code/g, '')
        .replace(/Copied!/g, '')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
    
    return {
        found: true,
        text: finalText,
        isStreaming: isStreaming,
        messageCount: assistantMessages.length
    };
})()`,
                        returnByValue: true,
                        timeout: 5000
                    });
                    
                    const result = extractResult.result?.value;
                    
                    if (result?.found && result?.text) {
                        // Check if response is complete (not streaming and text is stable)
                        if (!result.isStreaming) {
                            // Wait for text to be stable for 2 consecutive polls
                            if (result.text === lastResponseText && result.text.length > 0) {
                                stableCount++;
                                if (stableCount >= 2) {
                                    console.log('[ChatGPT Chat] Response complete, length:', result.text.length);
                                    resolved = true;
                                    clearTimeout(totalTimeout);
                                    resolveResponse(result.text);
                                    return;
                                }
                            } else {
                                stableCount = 0;
                            }
                        }
                        lastResponseText = result.text;
                    }
                    
                    // Log progress periodically
                    if (pollCount % 10 === 0) {
                        console.log(`[ChatGPT Chat] Poll ${pollCount}: streaming=${result?.isStreaming}, length=${result?.text?.length || 0}`);
                    }
                    
                } catch (e) {
                    console.log('[ChatGPT Chat] Poll error:', e.message);
                }
                
                // Continue polling
                pollTimer = setTimeout(pollForResponse, 500);
            };
            
            // Start polling after a short delay
            pollTimer = setTimeout(pollForResponse, 2000);
        });
        
        console.log('[ChatGPT Chat] Got response, length:', responseText.length);
        
        resolve({ 
            success: true, 
            code: 'OK',
            value: responseText,
            conversationUrl: conversationResult?.url || null
        });
        
    } catch (error) {
        console.error('[ChatGPT Chat] Error:', error);
        resolve({ 
            success: false, 
            code: 'ERROR',
            value: error.message || String(error) 
        });
    } finally {
        // Cleanup: delete conversation and prepare browser for reuse
        if (session && ourConversationId) {
            try {
                await deleteConversation(session.Runtime, ourConversationId, session.capturedAuthHeaders);
            } catch (deleteErr) {
                console.log('[ChatGPT Chat] Error during conversation cleanup:', deleteErr.message);
            }
        } else if (session && !ourConversationId) {
            // No conversation ID (response was on main page) - try to extract from current URL
            try {
                const currentUrl = await session.Runtime.evaluate({
                    expression: 'window.location.href',
                    returnByValue: true
                });
                const url = currentUrl.result?.value || '';
                const idMatch = url.match(/\/c\/([a-f0-9-]+)/i);
                if (idMatch) {
                    console.log('[ChatGPT Chat] Found conversation ID in final URL:', idMatch[1]);
                    await deleteConversation(session.Runtime, idMatch[1], session.capturedAuthHeaders);
                } else {
                    console.log('[ChatGPT Chat] No conversation to delete (stayed on main page)');
                }
            } catch (err) {
                console.log('[ChatGPT Chat] Could not check for conversation to delete:', err.message);
            }
        }
        
        // Navigate back to home for next request (browser reuse)
        if (session) {
            try {
                await navigateToHome(session);
                console.log('[ChatGPT Chat] Browser ready for next request');
            } catch (navErr) {
                console.log('[ChatGPT Chat] Error navigating to home:', navErr.message);
            }
            
            // Reset idle timer (browser will close after 2 min of inactivity)
            resetIdleTimer(profileId);
        }
        
        // Mark request as complete
        onRequestComplete(profileId, requestKey);
    }
}

module.exports = {
    startChatRequest,
    stopWorkflowQueues,
    clearWorkflowStateForRerun,
    closeAllBrowserSessions,
    getQueueStatus,
    getConnectedProfiles,
    
    get MAX_CONCURRENT() { return MAX_CONCURRENT; },
    
    getEffectiveMaxConcurrent() {
        const connectedCount = getConnectedProfiles().length;
        return Math.max(1, connectedCount);
    }
};
