/**
 * Facebook Post Scraper (Simple Version)
 * 
 * A lightweight scraper that extracts post content directly from the DOM.
 * Focuses on reliability over complexity - extracts text and images from HTML elements.
 * 
 * Supports URL formats:
 * - https://www.facebook.com/permalink.php?story_fbid=pfbid...&id=123456
 * - https://www.facebook.com/pagename/posts/pfbid...
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const { readKey } = require("../lib/utils");
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('../lib/cdpFingerprint');

// Simple ID generator for filenames
const genId = (n = 10) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

// ============================================
// SESSION MANAGER - Reuses browser across requests
// ============================================

let requestQueue = Promise.resolve();

const browserSession = {
    client: null,
    chromeProcess: null,
    profileName: null,
    debuggingPort: null,
    idleTimer: null,
    isClosing: false
};

const profileCooldowns = new Map();
const COOLDOWN_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const IDLE_TIMEOUT_MS = 60 * 1000; // 1 minute idle timeout

function isProfileOnCooldown(profileName) {
    const cooldownEnd = profileCooldowns.get(profileName);
    if (!cooldownEnd) return false;
    
    if (Date.now() >= cooldownEnd) {
        profileCooldowns.delete(profileName);
        return false;
    }
    return true;
}

function setProfileCooldown(profileName) {
    profileCooldowns.set(profileName, Date.now() + COOLDOWN_DURATION_MS);
    console.log(`[FBScraperSimple] Profile "${profileName}" on 10-minute cooldown`);
}

function resetIdleTimer() {
    if (browserSession.idleTimer) {
        clearTimeout(browserSession.idleTimer);
    }
    browserSession.idleTimer = setTimeout(() => {
        console.log('[FBScraperSimple] Idle timeout, closing browser');
        closeBrowserSession();
    }, IDLE_TIMEOUT_MS);
}

async function closeBrowserSession() {
    if (browserSession.isClosing) return;
    browserSession.isClosing = true;
    
    if (browserSession.idleTimer) {
        clearTimeout(browserSession.idleTimer);
        browserSession.idleTimer = null;
    }
    
    try {
        if (browserSession.client && !browserSession.client._disconnected) {
            await browserSession.client.close();
        }
    } catch (e) {}
    
    try {
        if (browserSession.chromeProcess && !browserSession.chromeProcess.killed) {
            browserSession.chromeProcess.kill();
        }
    } catch (e) {}
    
    browserSession.client = null;
    browserSession.chromeProcess = null;
    browserSession.profileName = null;
    browserSession.debuggingPort = null;
    browserSession.isClosing = false;
}

/**
 * Get available spy profiles that aren't on cooldown
 * spyProfiles is stored as an object: { "profileName": { proxy: {...} }, ... }
 */
async function getAvailableProfiles() {
    const spyProfiles = await readKey("spyProfiles");
    
    // spyProfiles is an object, not an array
    if (!spyProfiles || typeof spyProfiles !== 'object') {
        console.log('[FBScraperSimple] No spy profiles found');
        return [];
    }
    
    // Convert object to array of { name, proxy }
    const profilesList = Object.keys(spyProfiles).map(name => ({
        name: name,
        profileName: name, // alias for compatibility
        proxy: spyProfiles[name]?.proxy || null
    }));
    
    if (profilesList.length === 0) {
        console.log('[FBScraperSimple] No spy profiles configured');
        return [];
    }
    
    // Filter out profiles on cooldown
    const available = profilesList.filter(p => !isProfileOnCooldown(p.name));
    console.log(`[FBScraperSimple] ${available.length}/${profilesList.length} profiles available`);
    
    return available;
}

/**
 * Extract post ID from Facebook URL for comparison
 */
function extractPostId(url) {
    if (!url) return null;
    // Match pfbid format
    const pfbidMatch = url.match(/pfbid[A-Za-z0-9]+/);
    if (pfbidMatch) return pfbidMatch[0];
    // Match story_fbid format
    const storyMatch = url.match(/story_fbid=(\d+)/);
    if (storyMatch) return storyMatch[1];
    // Match /posts/ format
    const postsMatch = url.match(/\/posts\/(\d+)/);
    if (postsMatch) return postsMatch[1];
    return url;
}

/**
 * Get or create a browser session
 */
async function getOrCreateBrowserSession(targetUrl, preferredProfileId = null) {
    resetIdleTimer();
    
    const targetPostId = extractPostId(targetUrl);
    console.log('[FBScraperSimple] Target post ID:', targetPostId);
    
    // Check if existing session is still valid AND matches preferred profile (if specified)
    if (browserSession.client && !browserSession.client._disconnected && browserSession.profileName) {
        // If a specific profile is requested and doesn't match current, close session
        if (preferredProfileId && browserSession.profileName !== preferredProfileId) {
            console.log('[FBScraperSimple] Closing session - different profile requested');
            await closeBrowserSession();
        } else if (!isProfileOnCooldown(browserSession.profileName)) {
            try {
                const { Page, Runtime } = browserSession.client;
                
                console.log('[FBScraperSimple] Reusing session, clearing page first...');
                
                // CRITICAL: Navigate to blank page first to clear the DOM completely
                // Facebook uses SPA navigation that doesn't clear old content
                await Page.navigate({ url: 'about:blank' });
                await new Promise(r => setTimeout(r, 500));
                
                // Now navigate to target URL
                console.log('[FBScraperSimple] Navigating to:', targetUrl);
                await Page.navigate({ url: targetUrl });
                
                // Wait for page to load (5 seconds base)
                await new Promise(r => setTimeout(r, 5000));
                
                // Verify URL
                const urlResult = await Runtime.evaluate({ expression: 'window.location.href' });
                const currentUrl = urlResult.result?.value || '';
                console.log('[FBScraperSimple] Current URL:', currentUrl);
                
                // Verify we're on the correct post
                if (!currentUrl.includes(targetPostId)) {
                    console.log('[FBScraperSimple] Wrong URL, waiting more...');
                    await new Promise(r => setTimeout(r, 3000));
                }
                
                // Check for checkpoint/login
                const finalResult = await Runtime.evaluate({ expression: 'window.location.href' });
                const finalUrl = finalResult.result?.value || '';
                
                if (finalUrl.includes('checkpoint') || finalUrl.includes('login')) {
                    console.log('[FBScraperSimple] Checkpoint detected');
                    setProfileCooldown(browserSession.profileName);
                    await closeBrowserSession();
                } else {
                    return { success: true, client: browserSession.client };
                }
            } catch (e) {
                console.log('[FBScraperSimple] Session reuse failed:', e.message);
                await closeBrowserSession();
            }
        } else {
            await closeBrowserSession();
        }
    }
    
    // Get available profiles
    let profiles = await getAvailableProfiles();
    if (profiles.length === 0) {
        return { success: false, error: 'No spy profiles available' };
    }
    
    // If a specific profile is requested, prioritize it
    if (preferredProfileId) {
        const preferredProfile = profiles.find(p => p.name === preferredProfileId || p.id === preferredProfileId);
        if (preferredProfile) {
            // Move preferred profile to front
            profiles = [preferredProfile, ...profiles.filter(p => p !== preferredProfile)];
            console.log(`[FBScraperSimple] Using preferred profile: ${preferredProfileId}`);
        } else {
            console.log(`[FBScraperSimple] Preferred profile ${preferredProfileId} not available, using fallback`);
        }
    }
    
    // Try each profile
    for (const profile of profiles) {
        try {
            console.log(`[FBScraperSimple] Trying profile: ${profile.name}`);
            
            // Get fingerprint for this profile
            const fingerprint = getConsistentFingerprintForProfile(profile.name);
            
            // Update to VCBrowser's actual version to avoid fingerprint detection
            try {
              const vcVersion = getVCBrowserVersion();
              if (fingerprint.userAgent && vcVersion?.full) {
                fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
              }
            } catch (e) { /* use fallback */ }
            
            // startVCBrowser(profileName, fingerprint, url, proxy, headless, automationMode)
            const result = await startVCBrowser(
                profile.name,
                fingerprint,
                targetUrl,
                profile.proxy || null,
                true,   // headless
                true    // automationMode
            );
            
            if (!result || !result.client) {
                console.log(`[FBScraperSimple] Profile ${profile.name} failed to connect`);
                continue;
            }
            
            const { client, chromeProcess, debuggingPort } = result;
            const { Runtime } = client;
            
            console.log('[FBScraperSimple] VCBrowser connected on port:', debuggingPort);
            
            // Wait for page to load (don't use Page.loadEventFired - it waits for NEXT load)
            await new Promise(r => setTimeout(r, 5000));
            
            // Check for checkpoint
            const urlResult = await Runtime.evaluate({ expression: 'window.location.href' });
            const currentUrl = urlResult.result?.value || '';
            
            if (currentUrl.includes('checkpoint') || currentUrl.includes('login')) {
                console.log('[FBScraperSimple] Checkpoint/login detected');
                setProfileCooldown(profile.name);
                try { await client.close(); } catch (e) {}
                try { chromeProcess.kill(); } catch (e) {}
                continue;
            }
            
            // Success - save session
            browserSession.client = client;
            browserSession.chromeProcess = chromeProcess;
            browserSession.profileName = profile.name;
            browserSession.debuggingPort = debuggingPort;
            
            return { success: true, client };
            
        } catch (e) {
            console.log(`[FBScraperSimple] Profile ${profile.name} failed:`, e.message);
            continue;
        }
    }
    
    return { success: false, error: 'All profiles failed or on cooldown' };
}

/**
 * Download an image from URL
 */
async function downloadImage(imageUrl) {
    try {
        const userDataPath = app.getPath("userData");
        const downloadsDir = path.join(userDataPath, "Downloads");
        
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        
        const filename = `fb_${genId(12)}.jpg`;
        const localPath = path.join(downloadsDir, filename);
        
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/*',
                'Referer': 'https://www.facebook.com/'
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        
        fs.writeFileSync(localPath, response.data);
        return { success: true, localPath };
        
    } catch (e) {
        console.log('[FBScraperSimple] Download error:', e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Get full-size image URL by modifying stp parameter
 */
function getFullSizeImageUrl(url) {
    if (!url) return url;
    // Remove size constraints from stp parameter
    return url.replace(/stp=dst-jpg[^&]*/, 'stp=dst-jpg');
}

/**
 * Main scraping function - extracts text and image from Facebook post
 * 
 * @param {string} postUrl - Facebook post URL
 * @returns {Promise<{success: boolean, text?: string, imageUrl?: string, localPath?: string, error?: string}>}
 */
async function scrapeFacebookPost(postUrl, profileId = null) {
    return new Promise((resolve) => {
        requestQueue = requestQueue.then(async () => {
            try {
                const result = await _scrapeFacebookPostInternal(postUrl, profileId);
                resolve(result);
            } catch (e) {
                resolve({ success: false, error: e.message });
            }
        });
    });
}

async function _scrapeFacebookPostInternal(postUrl, profileId = null) {
    console.log('[FBScraperSimple] Scraping:', postUrl, 'with profile:', profileId || 'auto');
    
    // Check if VCBrowser is installed
    if (!isVCBrowserInstalled()) {
        return { success: false, error: 'VCBrowser not installed' };
    }
    
    // Get or create browser session (pass profileId for profile selection)
    const sessionResult = await getOrCreateBrowserSession(postUrl, profileId);
    if (!sessionResult.success) {
        return { success: false, error: sessionResult.error };
    }
    
    const { client } = sessionResult;
    const { Runtime } = client;
    
    try {
        // Verify we're on the correct page
        const urlCheck = await Runtime.evaluate({ expression: 'window.location.href' });
        console.log('[FBScraperSimple] Extracting from URL:', urlCheck.result?.value);
        
        // Wait a bit more for dynamic content to load
        await new Promise(r => setTimeout(r, 2000));
        
        // Extract text from DOM - use LAST element (popup/modal is rendered last)
        const textResult = await Runtime.evaluate({
            expression: `
                (() => {
                    // Primary: story_message container - get LAST one (popup is last in DOM)
                    const storyMessages = document.querySelectorAll('[data-ad-rendering-role="story_message"]');
                    const storyMessage = storyMessages.length > 0 ? storyMessages[storyMessages.length - 1] : null;
                    
                    if (storyMessage) {
                        // Get all text from divs with dir="auto"
                        const textDivs = storyMessage.querySelectorAll('div[dir="auto"]');
                        const texts = [];
                        for (const div of textDivs) {
                            const text = div.textContent.trim();
                            if (text && text.length > 0) {
                                texts.push(text);
                            }
                        }
                        if (texts.length > 0) {
                            return texts.join('\\n');
                        }
                        // Fallback: all text content
                        const text = storyMessage.textContent.trim();
                        if (text.length > 0) return text;
                    }
                    
                    // Fallback: data-ad-comet-preview="message" - get LAST one
                    const cometMessages = document.querySelectorAll('[data-ad-comet-preview="message"]');
                    const cometMessage = cometMessages.length > 0 ? cometMessages[cometMessages.length - 1] : null;
                    
                    if (cometMessage) {
                        const textDivs = cometMessage.querySelectorAll('div[dir="auto"]');
                        const texts = [];
                        for (const div of textDivs) {
                            const text = div.textContent.trim();
                            if (text && text.length > 0) {
                                texts.push(text);
                            }
                        }
                        if (texts.length > 0) {
                            return texts.join('\\n');
                        }
                    }
                    
                    return null;
                })()
            `,
            returnByValue: true
        });
        
        const postText = textResult.result?.value || null;
        console.log('[FBScraperSimple] Extracted text:', postText ? postText.substring(0, 100) + '...' : 'none');
        
        // Extract image from DOM - get LAST feedImage (popup/modal is rendered last)
        const imageResult = await Runtime.evaluate({
            expression: `
                (() => {
                    // Simply get ALL feedImage elements and take the LAST one
                    const feedImages = document.querySelectorAll('img[data-imgperflogname="feedImage"]');
                    console.log('[FBScraper] feedImages found:', feedImages.length);
                    
                    if (feedImages.length > 0) {
                        // Get the LAST one (popup is last in DOM)
                        const img = feedImages[feedImages.length - 1];
                        console.log('[FBScraper] Last feedImage src:', img.src);
                        if (img.src) {
                            return img.src;
                        }
                    }
                    
                    // Fallback: get last scontent image
                    const allImages = document.querySelectorAll('img[src*="scontent"]');
                    console.log('[FBScraper] scontent images found:', allImages.length);
                    if (allImages.length > 0) {
                        const img = allImages[allImages.length - 1];
                        return img.src;
                    }
                    
                    return null;
                })()
            `,
            returnByValue: true
        });
        
        let imageUrl = imageResult.result?.value || null;
        console.log('[FBScraperSimple] Extracted image:', imageUrl ? imageUrl.substring(0, 80) + '...' : 'none');
        
        // If no text and no image, something went wrong
        if (!postText && !imageUrl) {
            return { success: false, error: 'Could not extract post content' };
        }
        
        // Try to download the image
        let localPath = null;
        if (imageUrl) {
            // Try original URL first
            let downloadResult = await downloadImage(imageUrl);
            
            // If failed, try full-size URL
            if (!downloadResult.success) {
                const fullSizeUrl = getFullSizeImageUrl(imageUrl);
                if (fullSizeUrl !== imageUrl) {
                    downloadResult = await downloadImage(fullSizeUrl);
                }
            }
            
            if (downloadResult.success) {
                localPath = downloadResult.localPath;
            }
        }
        
        return {
            success: true,
            text: postText,
            imageUrl: imageUrl,
            localPath: localPath
        };
        
    } catch (error) {
        console.error('[FBScraperSimple] Error:', error.message);
        
        if (browserSession.profileName) {
            setProfileCooldown(browserSession.profileName);
        }
        await closeBrowserSession();
        
        return { success: false, error: error.message };
    }
}

/**
 * Close the browser session manually
 */
async function closeSession() {
    await closeBrowserSession();
}

// ============================================================================
// COMPATIBILITY LAYER - Functions to match old facebookScraper.js API
// ============================================================================

/**
 * Extract Facebook post image (compatibility wrapper)
 * Old signature: extractFacebookPostImage(postUrl, timeoutMs)
 * @param {string} postUrl - The Facebook post URL
 * @param {number} timeoutMs - Timeout in milliseconds (not used currently)
 * @param {string|null} profileId - Optional specific profile ID to use
 * @returns {Promise<{success: boolean, value?: string, localPath?: string, error?: string}>}
 */
async function extractFacebookPostImage(postUrl, timeoutMs = 60000, profileId = null) {
    const result = await scrapeFacebookPost(postUrl, profileId);
    if (result.success) {
        return {
            success: true,
            value: result.imageUrl || null,
            localPath: result.localPath || null
        };
    }
    return {
        success: false,
        value: result.error || 'Failed to extract image',
        error: result.error
    };
}

/**
 * Extract full Facebook post (compatibility wrapper)
 * Old signature: extractFacebookPost(postUrl, timeoutMs)
 * @returns {Promise<{success: boolean, text?: string, imageUrl?: string, localPath?: string, error?: string}>}
 */
async function extractFacebookPost(postUrl, timeoutMs = 60000) {
    return await scrapeFacebookPost(postUrl);
}

/**
 * Validate spy profiles (check if any are available)
 * @returns {Promise<{valid: boolean, error?: string, errorType?: string}>}
 */
async function validateSpyProfiles() {
    const profiles = await getAvailableProfiles();
    if (profiles.length === 0) {
        // Check if there are ANY profiles (even on cooldown)
        const spyProfiles = await readKey("spyProfiles");
        if (!spyProfiles || Object.keys(spyProfiles).length === 0) {
            return {
                valid: false,
                error: 'No spy profiles configured. Please add at least one spy profile.',
                errorType: 'no_profiles'
            };
        }
        return {
            valid: false,
            error: 'All spy profiles are on cooldown or blocked. Please wait or add more profiles.',
            errorType: 'all_profiles_blocked'
        };
    }
    return { valid: true };
}

/**
 * Download Facebook image (compatibility wrapper)
 */
async function downloadFacebookImage(imageUrl) {
    return await downloadImage(imageUrl);
}

module.exports = {
    // New API
    scrapeFacebookPost,
    closeSession,
    
    // Compatibility with old facebookScraper.js
    extractFacebookPostImage,
    extractFacebookPost,
    validateSpyProfiles,
    getFullSizeImageUrl,
    downloadFacebookImage,
    closeBrowserSession,    // For cleanup on app exit
    isProfileOnCooldown,
    setProfileCooldown
};
