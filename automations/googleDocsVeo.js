/**
 * Google Docs Veo 3.1 Video Generation Module
 *
 * Generates videos using Google Veo 3.1 (docs.google.com/videos) via browser automation.
 * Supports text-to-video and image+text-to-video modes.
 * Uses connected Google profiles for authentication with load balancing.
 * Includes queue system, workflow management, and proper resource cleanup.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { app, BrowserWindow, ipcMain } = require("electron");
const { readKey, updateData, killProfileBrowser } = require("../lib/utils");
const {
  startVCBrowser,
  isVCBrowserInstalled,
} = require("../lib/VCBrowserManager");
const {
  getConsistentFingerprintForProfile,
  getVCBrowserVersion,
} = require("../lib/cdpFingerprint");
const { getFFmpegPath, getFFprobePath } = require("../lib/ffmpegManager");
const { execFile } = require("child_process");

// ============ CONFIGURATION ============
const MAX_CONCURRENT = 1; // Max concurrent requests per Google profile
const REQUEST_DELAY_MS = 3000; // Delay between requests (3s)
const BROWSER_CLOSE_COOLDOWN_MS = 3000; // Wait 3s after browser close before new launch
const VIDEO_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes timeout for video generation
const PAGE_LOAD_TIMEOUT_MS = 30000; // 30s for page load
const VIDEOGEN_BUTTON_TIMEOUT_MS = 15000; // 15s to find videogen button
const TEXTAREA_TIMEOUT_MS = 15000; // 15s for textarea to appear
const VIDEO_POLL_INTERVAL_MS = 5000; // Poll for video every 5s
const VIDEO_POLL_MAX_ATTEMPTS = 120; // ~10 minutes of polling

// Temp & output directories
const TEMP_DIR = path.join(app.getPath("userData"), "Uploads", "Temp");
const VIDEOS_DIR = path.join(app.getPath("userData"), "Videos");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

function diagLog(message) {
  console.log(`[Veo 3.1] ${message}`);
}

// ============ STATE MANAGEMENT ============
const profileQueues = new Map(); // profileId -> { queue: [], activeCount: 0, lastRequestTime: 0, processing: false }
const pendingRequests = new Map(); // requestKey -> { prompt, workflowId, resolve, profileId, startTime }
const workflowRequests = new Map(); // workflowId -> Set of requestKeys
const lastBrowserCloseTime = new Map(); // profileId -> timestamp
let requestCounter = 0;

// ============ DISCONNECTION TRACKING ============
const veoDisconnectedState = new Map(); // profileId -> { blocked: boolean, since: timestamp }

function broadcastToRenderers(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    } catch (_) {}
  }
}

function isVeoBlocked(profileId) {
  return !!(veoDisconnectedState.get(profileId)?.blocked);
}

function getBlockedVeoProfiles() {
  const blocked = [];
  for (const [profileId, state] of veoDisconnectedState.entries()) {
    if (state.blocked) blocked.push(profileId);
  }
  return blocked;
}

function getBlockedVeoProfileCount() {
  return getBlockedVeoProfiles().length;
}

async function blockVeoProfile(profileId) {
  const prev = veoDisconnectedState.get(profileId) || {};
  if (!prev.blocked) {
    console.log(`[Veo 3.1] Blocking profile ${profileId} due to disconnection`);
    veoDisconnectedState.set(profileId, { blocked: true, since: Date.now() });
    // Kill any open non-headless browser window for this profile
    killProfileBrowser(profileId);

    try {
      const googleProfiles = (await readKey("googleProfiles")) || {};
      if (googleProfiles[profileId]) {
        googleProfiles[profileId].status = "disconnected";
        await updateData("googleProfiles", googleProfiles);
      }
    } catch (err) {
      console.error("[Veo 3.1] Failed to update profile status:", err.message);
    }

    const blockedProfiles = getBlockedVeoProfiles();
    const payload = {
      profileId,
      blockedCount: blockedProfiles.length,
      allBlockedProfiles: blockedProfiles,
      source: "veo",
    };
    broadcastToRenderers("google-account-disconnected", payload);

    try {
      const systemNotifications = require("../lib/systemNotifications");
      systemNotifications.sendNotification("googleDisconnected", { profileId });
    } catch (_) {}

    try {
      const telegramNotifications = require("../lib/telegramNotifications");
      telegramNotifications.sendNotification("googleDisconnected", { profileId });
    } catch (_) {}
  }
}

async function unblockVeoProfile(profileId) {
  const prev = veoDisconnectedState.get(profileId);
  if (prev?.blocked) {
    console.log(`[Veo 3.1] Unblocking profile ${profileId} - reconnected`);
    veoDisconnectedState.set(profileId, { blocked: false });

    try {
      const googleProfiles = (await readKey("googleProfiles")) || {};
      if (googleProfiles[profileId]) {
        googleProfiles[profileId].status = "connected";
        await updateData("googleProfiles", googleProfiles);
      }
    } catch (_) {}

    const blockedProfiles = getBlockedVeoProfiles();
    broadcastToRenderers("google-account-reconnected", {
      profileId,
      blockedCount: blockedProfiles.length,
      allBlockedProfiles: blockedProfiles,
      source: "veo",
    });

    try {
      const systemNotifications = require("../lib/systemNotifications");
      systemNotifications.sendNotification("googleReconnected", { profileId });
    } catch (_) {}

    try {
      const telegramNotifications = require("../lib/telegramNotifications");
      telegramNotifications.sendNotification("googleReconnected", { profileId });
    } catch (_) {}
  }
}

async function areAllVeoProfilesBlocked() {
  const enabled = await getEnabledProfiles();
  if (enabled.length === 0) return true;
  for (const profileId of enabled) {
    if (!isVeoBlocked(profileId)) return false;
  }
  return true;
}

// ============ QUEUE MANAGEMENT ============

function getProfileQueue(profileId) {
  if (!profileQueues.has(profileId)) {
    profileQueues.set(profileId, {
      queue: [],
      activeCount: 0,
      lastRequestTime: 0,
      processing: false,
    });
  }
  return profileQueues.get(profileId);
}

function generateRequestKey(profileId) {
  return `veo:${profileId}:${Date.now()}:${++requestCounter}`;
}

async function processQueue(profileId) {
  const queueData = getProfileQueue(profileId);
  if (queueData.processing) return;
  queueData.processing = true;

  try {
    while (queueData.queue.length > 0 && queueData.activeCount < MAX_CONCURRENT) {
      const now = Date.now();
      const timeSinceLastRequest = now - queueData.lastRequestTime;

      if (queueData.lastRequestTime > 0 && timeSinceLastRequest < REQUEST_DELAY_MS) {
        const waitTime = REQUEST_DELAY_MS - timeSinceLastRequest;
        diagLog(`Waiting ${waitTime}ms before next request...`);
        await new Promise((r) => setTimeout(r, waitTime));
      }

      const lastCloseTime = lastBrowserCloseTime.get(profileId) || 0;
      const timeSinceClose = Date.now() - lastCloseTime;
      if (lastCloseTime > 0 && timeSinceClose < BROWSER_CLOSE_COOLDOWN_MS) {
        const cooldownWait = BROWSER_CLOSE_COOLDOWN_MS - timeSinceClose;
        diagLog(`Waiting ${cooldownWait}ms for browser cooldown...`);
        await new Promise((r) => setTimeout(r, cooldownWait));
      }

      if (queueData.activeCount >= MAX_CONCURRENT) break;

      const task = queueData.queue.shift();
      if (!task) continue;

      queueData.activeCount++;
      queueData.lastRequestTime = Date.now();

      diagLog(`Processing request for ${profileId.substring(0, 8)}... Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);

      executeVideoRequest(
        task.requestKey,
        task.profileId,
        task.prompt,
        task.aspectRatio,
        task.mode,
        task.imagePath,
        task.workflowId,
        task.resolve
      );
    }
  } finally {
    queueData.processing = false;
  }
}

function onRequestComplete(profileId, requestKey) {
  const queueData = getProfileQueue(profileId);
  queueData.activeCount = Math.max(0, queueData.activeCount - 1);
  pendingRequests.delete(requestKey);

  for (const [workflowId, requestKeys] of workflowRequests.entries()) {
    requestKeys.delete(requestKey);
    if (requestKeys.size === 0) workflowRequests.delete(workflowId);
  }

  diagLog(`Request complete. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
  processQueue(profileId);
}

// ============ PUBLIC API ============

function getConnectedProfiles() {
  const googleProfiles = readKey("googleProfiles") || {};
  return Object.entries(googleProfiles)
    .filter(([_, data]) => data?.status === "connected")
    .map(([name]) => name);
}

async function getEnabledProfiles() {
  const connectedProfiles = getConnectedProfiles();
  const enabledVeoProfiles = (await readKey("enabledVeoProfiles")) || [];

  return enabledVeoProfiles.length > 0
    ? connectedProfiles.filter((id) => enabledVeoProfiles.includes(id))
    : connectedProfiles;
}

function selectBestProfileAndReserve(enabledProfiles) {
  if (enabledProfiles.length === 0) return null;

  // Find the minimum load across all profiles
  let minLoad = Infinity;
  const candidates = [];

  for (const profileId of enabledProfiles) {
    const queueData = getProfileQueue(profileId);
    const load = queueData.activeCount + queueData.queue.length;
    if (load < minLoad) {
      minLoad = load;
      candidates.length = 0;
      candidates.push({ profileId, queueData });
    } else if (load === minLoad) {
      candidates.push({ profileId, queueData });
    }
  }

  // Pick randomly among profiles with equal (lowest) load
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  const { profileId: bestProfile, queueData: bestQueueData } = selected;

  const placeholderIndex = bestQueueData.queue.length;
  bestQueueData.queue.push(null);

  diagLog(`Selected profile ${bestProfile.substring(0, 8)}... (load: ${minLoad}) from ${enabledProfiles.length} profiles (${candidates.length} tied)`);
  return { profileId: bestProfile, queueData: bestQueueData, placeholderIndex };
}

/**
 * Queue a video generation request
 * @param {string} prompt - The video prompt
 * @param {string} aspectRatio - "landscape" or "portrait"
 * @param {string} mode - "text-to-video" or "image-text-to-video"
 * @param {string|null} imagePath - Optional image path for image+text mode
 * @param {string|null} workflowId - Workflow ID for cleanup tracking
 * @returns {Promise<{success: boolean, value: string, code?: string}>}
 */
async function startVideoRequest(prompt, aspectRatio = "landscape", mode = "text-to-video", imagePath = null, workflowId = null) {
  const maxRetries = Math.max(0, parseInt(await readKey("veoNoAudioRetries") || "3", 10));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await _singleVideoRequest(prompt, aspectRatio, mode, imagePath, workflowId);

    if (!result.success) return result;

    // Check if the video has audio
    const hasAudio = await videoHasAudio(result.value);
    if (hasAudio) {
      return result;
    }

    // No audio detected
    if (attempt < maxRetries) {
      console.log(`[Veo 3.1] Video has no audio (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`);
      // Delete the silent video
      try { fs.unlinkSync(result.value); } catch (_) {}
    } else {
      console.log(`[Veo 3.1] Video has no audio after ${maxRetries + 1} attempts, returning as-is`);
      return result;
    }
  }
}

async function _singleVideoRequest(prompt, aspectRatio = "landscape", mode = "text-to-video", imagePath = null, workflowId = null) {
  try {
    const enabledProfiles = await getEnabledProfiles();
    const availableProfiles = enabledProfiles.filter((id) => !isVeoBlocked(id));

    if (availableProfiles.length === 0 && enabledProfiles.length > 0) {
      return {
        success: false,
        code: "ALL_DISCONNECTED",
        value: "All Google profiles are disconnected. Please reconnect at least one profile.",
        allDisconnected: true,
      };
    }

    const selection = selectBestProfileAndReserve(availableProfiles);
    if (!selection) {
      const connectedProfiles = getConnectedProfiles();
      if (connectedProfiles.length > 0) {
        return {
          success: false,
          code: "NO_ENABLED_PROFILES",
          value: "No Google profiles are enabled for Veo 3.1. Please enable at least one profile in Settings > Veo 3.1.",
        };
      }
      return {
        success: false,
        code: "NO_PROFILE",
        value: "No connected Google profile found. Please connect a Google account in Settings.",
      };
    }

    const { profileId: selectedProfile, queueData, placeholderIndex } = selection;
    const requestKey = generateRequestKey(selectedProfile);

    return new Promise((resolve) => {
      const task = {
        requestKey,
        profileId: selectedProfile,
        prompt,
        aspectRatio,
        mode,
        imagePath,
        workflowId,
        resolve,
      };

      pendingRequests.set(requestKey, {
        prompt,
        workflowId,
        profileId: selectedProfile,
        startTime: Date.now(),
        resolve,
      });

      if (workflowId) {
        if (!workflowRequests.has(workflowId)) workflowRequests.set(workflowId, new Set());
        workflowRequests.get(workflowId).add(requestKey);
      }

      if (placeholderIndex >= 0 && placeholderIndex < queueData.queue.length && queueData.queue[placeholderIndex] === null) {
        queueData.queue[placeholderIndex] = task;
      } else {
        queueData.queue.push(task);
      }

      diagLog(`Request queued. Profile: ${selectedProfile.substring(0, 8)}..., Queue: ${queueData.queue.length}, Active: ${queueData.activeCount}`);
      processQueue(selectedProfile);
    });
  } catch (error) {
    console.error("[Veo 3.1] Error in startVideoRequest:", error);
    return { success: false, code: "ERROR", value: error.message || String(error) };
  }
}

function stopWorkflowQueues(workflowId) {
  diagLog(`Stopping all requests for workflow ${workflowId}...`);
  let removedFromQueue = 0;
  let removedPending = 0;

  for (const [profileId, queueData] of profileQueues.entries()) {
    const itemsToRemove = queueData.queue.filter((item) => item && item.workflowId === workflowId);
    queueData.queue = queueData.queue.filter((item) => !item || item.workflowId !== workflowId);
    for (const item of itemsToRemove) {
      item.resolve({ success: false, code: "WORKFLOW_STOPPED", value: "Workflow was stopped" });
      pendingRequests.delete(item.requestKey);
      removedFromQueue++;
    }
  }

  const requestKeys = workflowRequests.get(workflowId) || new Set();
  for (const requestKey of requestKeys) {
    const request = pendingRequests.get(requestKey);
    if (request) {
      request.resolve({ success: false, code: "WORKFLOW_STOPPED", value: "Workflow was stopped" });
      pendingRequests.delete(requestKey);
      removedPending++;
    }
  }

  workflowRequests.delete(workflowId);
  diagLog(`Workflow ${workflowId} cleanup: removed ${removedFromQueue} queued + ${removedPending} pending`);
}

function clearWorkflowStateForRerun(workflowId) {
  diagLog(`Clearing state for workflow ${workflowId} rerun...`);
  workflowRequests.delete(workflowId);
}

function getQueueStatus(profileId = null) {
  if (profileId) {
    const data = getProfileQueue(profileId);
    return { [profileId]: { queued: data.queue.length, active: data.activeCount, maxConcurrent: MAX_CONCURRENT } };
  }
  const status = {};
  for (const [id, data] of profileQueues.entries()) {
    status[id] = { queued: data.queue.length, active: data.activeCount, maxConcurrent: MAX_CONCURRENT };
  }
  return status;
}

// ============ INTERNAL EXECUTION ============

async function executeVideoRequest(requestKey, profileId, prompt, aspectRatio, mode, imagePath, workflowId, resolve) {
  let browserResult = null;
  const isCancelled = () => !pendingRequests.has(requestKey);

  try {
    diagLog("Starting video generation...");
    diagLog(`Profile: ${profileId}`);
    diagLog(`Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}`);
    diagLog(`Aspect Ratio: ${aspectRatio}, Mode: ${mode}`);
    if (imagePath) diagLog(`Reference image: ${imagePath}`);

    if (isCancelled()) return;

    if (!isVCBrowserInstalled()) {
      resolve({ success: false, code: "VCBROWSER_NOT_INSTALLED", value: "VCBrowser is not installed. Please download it from Settings." });
      return;
    }

    // Generate fingerprint
    const fingerprint = getConsistentFingerprintForProfile(profileId);
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
      }
    } catch (_) {}

    // Start VCBrowser
    diagLog(`Starting VCBrowser for profile: ${profileId}`);
    browserResult = await startVCBrowser(
      profileId,
      fingerprint,
      "https://docs.google.com/videos/u/0/create?usp=vids_home",
      null,
      true, // headless
      true
    );

    if (!browserResult || !browserResult.client) {
      resolve({ success: false, code: "BROWSER_FAILED", value: "Failed to start VCBrowser or get CDP client" });
      return;
    }

    diagLog(`VCBrowser started, port: ${browserResult.debuggingPort}`);
    if (isCancelled()) throw new Error("Request cancelled after browser start");

    const client = browserResult.client;
    const { Runtime, Page, Network, Input } = client;
    await Promise.all([Runtime.enable(), Page.enable(), Network.enable()]);

    // Get main target ID for tab management
    let mainTargetId = null;
    try {
      const res = await fetch(`http://localhost:${browserResult.debuggingPort}/json/list`);
      const targets = await res.json();
      const mainTarget = targets.find(t => t.type === "page" && t.url.includes("docs.google.com/videos"));
      mainTargetId = mainTarget?.id || targets.find(t => t.type === "page")?.id;
    } catch (_) {}

    // Wait for page load
    diagLog("Waiting for page to load...");
    await waitForPageReady(Runtime, PAGE_LOAD_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 3000));

    // Close any unwanted tabs that opened during load
    await closeUnwantedTabs(browserResult.debuggingPort, mainTargetId, diagLog);

    // Check for error dialog and refresh if needed
    await detectAndRefreshOnError(Runtime, Page, diagLog);

    // Check and dismiss any usage limit banner
    const bannerCheck = await handleVeoUsageBanner(Runtime);
    if (bannerCheck.found) {
      diagLog(`Usage banner detected: ${bannerCheck.message} (remaining: ${bannerCheck.remaining})`);
      if (bannerCheck.rateLimited) {
        diagLog("Profile rate limited - no Veo generations remaining this month");
        resolve({ success: false, code: "RATE_LIMITED", value: `Veo monthly limit reached for this profile. ${bannerCheck.message}`, rateLimited: true, profileId });
        return;
      }
      if (bannerCheck.dismissed) {
        diagLog("Usage banner dismissed");
      }
    }

    // Check auth
    const urlCheck = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
    const currentUrl = urlCheck.result?.value || "";
    diagLog(`Current URL: ${currentUrl}`);

    if (currentUrl.includes("accounts.google.com") || currentUrl.includes("/signin")) {
      await blockVeoProfile(profileId);
      resolve({ success: false, code: "NOT_LOGGED_IN", value: "Account disconnected - profile blocked", disconnected: true, profileId });
      return;
    }

    if (isCancelled()) throw new Error("Request cancelled after auth check");

    // Step 1: Click the "Video generation" getting started button
    diagLog("Looking for video generation button...");
    const clickVideoGen = await Runtime.evaluate({
      expression: `
(async function() {
    const startTime = Date.now();
    const timeout = ${VIDEOGEN_BUTTON_TIMEOUT_MS};
    
    // First, wait for the button to appear
    let btn = null;
    while (Date.now() - startTime < timeout) {
        btn = document.querySelector('button[data-view-id="getting-started-dialog-videogen"]')
           || document.querySelector('button.appsDocsGettingStartedEntryPointSelectionViewButton.videogen');
        if (btn) break;
        await new Promise(r => setTimeout(r, 500));
    }
    if (!btn) return { success: false, error: 'Video generation button not found' };
    
    // Click the button and verify the modal disappears
    for (let attempt = 0; attempt < 5; attempt++) {
        // Use multiple click strategies
        btn.focus();
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.click();
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        
        // Wait and check if the button/modal is gone
        await new Promise(r => setTimeout(r, 1000));
        
        const stillThere = document.querySelector('button[data-view-id="getting-started-dialog-videogen"]')
                        || document.querySelector('button.appsDocsGettingStartedEntryPointSelectionViewButton.videogen');
        if (!stillThere) {
            return { success: true, attempts: attempt + 1 };
        }
        
        // Button still there, try again
        btn = stillThere;
        await new Promise(r => setTimeout(r, 500));
    }
    
    // Button persisted after all attempts
    return { success: false, error: 'Button found but modal did not dismiss after clicking' };
})()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: VIDEOGEN_BUTTON_TIMEOUT_MS + 15000,
    });

    if (!clickVideoGen.result?.value?.success) {
      // The page may directly show the video gen interface
      diagLog(`Video gen button issue: ${clickVideoGen.result?.value?.error || 'unknown'}, checking if already on video gen interface...`);
    } else {
      diagLog(`Clicked video gen button (took ${clickVideoGen.result.value.attempts} attempt(s))`);
    }

    await new Promise((r) => setTimeout(r, 2000));
    if (isCancelled()) throw new Error("Request cancelled after video gen click");

    // Step 2: Wait for textarea and enter prompt
    diagLog("Entering prompt...");
    const escapedPrompt = prompt.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

    const enterPrompt = await Runtime.evaluate({
      expression: `
(async function() {
    const startTime = Date.now();
    const timeout = ${TEXTAREA_TIMEOUT_MS};
    while (Date.now() - startTime < timeout) {
        const textarea = document.querySelector('textarea[aria-describedby="video-gen-disclaimer-banner-text"]');
        if (textarea) {
            textarea.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSetter) {
                nativeSetter.call(textarea, \`${escapedPrompt}\`);
            } else {
                textarea.value = \`${escapedPrompt}\`;
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Prompt textarea not found' };
})()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: TEXTAREA_TIMEOUT_MS + 5000,
    });

    if (!enterPrompt.result?.value?.success) {
      resolve({ success: false, code: "PROMPT_FAILED", value: enterPrompt.result?.value?.error || "Failed to find prompt textarea" });
      return;
    }
    diagLog("Prompt entered");
    await new Promise((r) => setTimeout(r, 500));

    // Step 3: Click the first proceed button (opens aspect ratio panel)
    diagLog("Clicking proceed button...");
    const clickProceed = await Runtime.evaluate({
      expression: `
(async function() {
    for (let i = 0; i < 20; i++) {
        const btn = document.querySelector('button[jscontroller="O626Fe"]');
        if (btn) {
            btn.click();
            return { success: true };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Proceed button not found' };
})()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });

    if (!clickProceed.result?.value?.success) {
      resolve({ success: false, code: "PROCEED_FAILED", value: "Failed to click proceed button" });
      return;
    }
    diagLog("Proceed button clicked");
    await new Promise((r) => setTimeout(r, 1000));

    // Step 4: Select aspect ratio
    diagLog(`Selecting aspect ratio: ${aspectRatio}`);
    const arSelector = aspectRatio === "portrait"
      ? ".docs-icon-crop-9-16-24x24"
      : ".docs-icon-crop-16-9-24x24";

    const selectAR = await Runtime.evaluate({
      expression: `
(async function() {
    for (let i = 0; i < 20; i++) {
        const icon = document.querySelector('${arSelector}');
        if (icon) {
            const li = icon.closest('li[role="menuitemradio"]');
            if (li) {
                li.click();
                return { success: true };
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Aspect ratio option not found' };
})()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });

    if (!selectAR.result?.value?.success) {
      diagLog(`Aspect ratio selection failed: ${selectAR.result?.value?.error}, proceeding with default`);
    } else {
      diagLog("Aspect ratio selected");
    }
    await new Promise((r) => setTimeout(r, 500));

    if (isCancelled()) throw new Error("Request cancelled before mode selection");

    // Step 5: Branch based on mode
    if (mode === "image-text-to-video" && imagePath && fs.existsSync(imagePath)) {
      diagLog("Switching to image+text-to-video mode...");

      // Switch mode dropdown
      const switchMode = await Runtime.evaluate({
        expression: `
(async function() {
    for (let i = 0; i < 20; i++) {
        const dropdown = document.querySelector('div[jscontroller="GPHYJd"] [jsaction]');
        if (dropdown) {
            dropdown.click();
            await new Promise(r => setTimeout(r, 500));
            const options = document.querySelectorAll('ul[jscontroller="uoEu0c"] li[role="option"]');
            if (options.length >= 2) {
                options[1].click(); // Image + text to video option
                return { success: true };
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Mode dropdown not found' };
})()`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 15000,
      });

      if (!switchMode.result?.value?.success) {
        diagLog(`Mode switch failed: ${switchMode.result?.value?.error}, falling back to text-to-video`);
      } else {
        diagLog("Switched to image+text mode");
        await new Promise((r) => setTimeout(r, 1000));

        // Click the image upload button
        const clickUpload = await Runtime.evaluate({
          expression: `
(async function() {
    for (let i = 0; i < 20; i++) {
        const buttons = document.querySelectorAll('button[jscontroller="O626Fe"]');
        if (buttons.length >= 2) {
            buttons[1].click();
            return { success: true };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Upload button not found' };
})()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: 15000,
        });

        if (clickUpload.result?.value?.success) {
          diagLog("Upload button clicked");
        }

        // Accept policy dialog if present
        await new Promise((r) => setTimeout(r, 1000));
        await Runtime.evaluate({
          expression: `
(function() {
    const okBtn = document.querySelector('button[data-mdc-dialog-action="ok"]');
    if (okBtn) { okBtn.click(); return true; }
    return false;
})()`,
          returnByValue: true,
        }).catch(() => {});
        diagLog("Policy dialog check done");
        await new Promise((r) => setTimeout(r, 1000));

        // Use CDP file chooser interception to upload image
        diagLog("Uploading image via CDP file chooser...");
        try {
          await Page.setInterceptFileChooserDialog({ enabled: true });

          // Click the element that triggers the file input
          await Runtime.evaluate({
            expression: `
(function() {
    // Look for file input or upload button in the modal
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) { fileInput.click(); return 'file-input'; }
    // Try clicking any upload-related button
    const uploadBtns = document.querySelectorAll('button');
    for (const btn of uploadBtns) {
        const text = (btn.textContent || '').toLowerCase();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('upload') || text.includes('browse') || text.includes('choose') ||
            label.includes('upload') || label.includes('browse') || label.includes('choose')) {
            btn.click();
            return 'upload-btn';
        }
    }
    return 'none';
})()`,
            returnByValue: true,
          });

          // Wait briefly for the file chooser dialog
          await new Promise((r) => setTimeout(r, 1000));

          // Handle the file chooser
          const absolutePath = path.resolve(imagePath);
          await Page.handleFileChooser({
            action: "accept",
            files: [absolutePath],
          });
          diagLog("File chooser handled - image uploaded");
        } catch (fileChooserErr) {
          diagLog(`File chooser method failed: ${fileChooserErr.message}`);
          // Fallback: try drag-and-drop via synthetic events or other approach
          diagLog("Attempting fallback image upload...");

          const imageBuffer = fs.readFileSync(imagePath);
          const base64Image = imageBuffer.toString("base64");
          const ext = path.extname(imagePath).toLowerCase();
          const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
          const fileName = path.basename(imagePath);

          await Runtime.evaluate({
            expression: `
(async function() {
    const base64 = "${base64Image}";
    const mimeType = "${mimeType}";
    const fileName = "${fileName}";
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const file = new File([blob], fileName, { type: mimeType });
    const dt = new DataTransfer();
    dt.items.add(file);
    // Try setting on any file input
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, method: 'file-input-set' };
    }
    // Try drop event on the modal
    const dropZone = document.querySelector('[class*="upload"], [class*="drop"]') || document.body;
    const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    dropZone.dispatchEvent(dropEvent);
    return { success: true, method: 'drop-event' };
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: 15000,
          });
          diagLog("Fallback image upload attempted");
        }

        await new Promise((r) => setTimeout(r, 3000));

        // Wait for generate button to become enabled
        diagLog("Waiting for generate button to become enabled...");
        const waitGenBtn = await Runtime.evaluate({
          expression: `
(async function() {
    for (let i = 0; i < 120; i++) {
        const btn = document.querySelector('[data-idom-class="videoGenCreationViewGenerateButton"]');
        if (btn && btn.getAttribute('disabled') === null) {
            return { success: true, attempts: i };
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return { success: false, error: 'Generate button remained disabled' };
})()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: 130000,
        });

        if (!waitGenBtn.result?.value?.success) {
          resolve({ success: false, code: "GENERATE_BTN_DISABLED", value: "Generate button remained disabled after image upload" });
          return;
        }
        diagLog(`Generate button enabled after ${waitGenBtn.result.value.attempts} checks`);

        // Click the generate button
        await Runtime.evaluate({
          expression: `
(function() {
    const btn = document.querySelector('[data-idom-class="videoGenCreationViewGenerateButton"]');
    if (btn) btn.click();
})()`,
          returnByValue: true,
        });
        diagLog("Generate button clicked (image+text mode)");
      }
    } else {
      // Text-to-video mode: click the generate/create button (4th button[jscontroller="O626Fe"])
      diagLog("Clicking generate button (text-to-video mode)...");
      const clickGenerate = await Runtime.evaluate({
        expression: `
(async function() {
    for (let i = 0; i < 20; i++) {
        const buttons = document.querySelectorAll('button[jscontroller="O626Fe"]');
        if (buttons.length >= 4) {
            buttons[3].click();
            return { success: true, totalBtns: buttons.length };
        }
        // Fallback: try 3rd button if 4th doesn't exist
        if (buttons.length >= 3) {
            buttons[2].click();
            return { success: true, totalBtns: buttons.length, fallback: true };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, error: 'Generate button not found' };
})()`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 15000,
      });

      if (!clickGenerate.result?.value?.success) {
        resolve({ success: false, code: "GENERATE_FAILED", value: "Failed to click generate button" });
        return;
      }
      diagLog(`Generate button clicked (found ${clickGenerate.result.value.totalBtns} buttons${clickGenerate.result.value.fallback ? ", used fallback" : ""})`);
    }

    if (isCancelled()) throw new Error("Request cancelled after generate click");

    // Close any popup tabs opened by clicking generate
    await new Promise((r) => setTimeout(r, 2000));
    await closeUnwantedTabs(browserResult.debuggingPort, mainTargetId, diagLog);

    // Check for error dialog after tab close and refresh if needed
    await detectAndRefreshOnError(Runtime, Page, diagLog);

    // Check for rate limit banner after clicking generate
    const postGenBanner = await handleVeoUsageBanner(Runtime);
    if (postGenBanner.found) {
      diagLog(`Post-generate banner: ${postGenBanner.message} (remaining: ${postGenBanner.remaining})`);
      if (postGenBanner.rateLimited) {
        resolve({ success: false, code: "RATE_LIMITED", value: `Veo monthly limit reached for this profile. ${postGenBanner.message}`, rateLimited: true, profileId });
        return;
      }
      if (postGenBanner.dismissed) {
        diagLog("Post-generate usage banner dismissed");
      }
    }

    // Step 6: Poll for video completion
    diagLog("Waiting for video generation to complete...");
    const genStartTime = Date.now();
    let videoSrc = null;

    for (let attempt = 0; attempt < VIDEO_POLL_MAX_ATTEMPTS; attempt++) {
      if (isCancelled()) throw new Error("Request cancelled during video generation wait");

      const pollResult = await Runtime.evaluate({
        expression: `
(function() {
    // Look for the generated video element
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
        const classes = video.className || '';
        if (classes.includes('VideoGenerationThumbnail') || 
            classes.includes('videogenerationthumbnail') ||
            classes.includes('SuccessfulVideoGeneration') ||
            classes.includes('InsertableVideoGenerationThumbnail')) {
            return { found: true, src: video.src, classes: classes.substring(0, 100) };
        }
    }
    // Also check by aria-label pattern
    for (const video of videos) {
        const label = video.getAttribute('aria-label') || '';
        if (label.includes('Vidéo générée') || label.includes('Generated video') || label.includes('video')) {
            if (video.src && video.src.startsWith('http')) {
                return { found: true, src: video.src, ariaLabel: label.substring(0, 80) };
            }
        }
    }
    // Check for errors
    const errorEls = document.querySelectorAll('[class*="error"], [class*="Error"]');
    for (const el of errorEls) {
        const text = (el.textContent || '').trim();
        if (text && text.length > 5 && text.length < 500 && 
            (text.toLowerCase().includes('error') || text.toLowerCase().includes('failed') || text.toLowerCase().includes('couldn'))) {
            return { found: false, error: text.substring(0, 200) };
        }
    }
    return { found: false };
})()`,
        returnByValue: true,
        timeout: 10000,
      }).catch(() => ({ result: { value: { found: false } } }));

      const val = pollResult.result?.value;
      if (val?.found && val.src) {
        if (val.src.includes('usercontent.google.com/download')) {
          videoSrc = val.src;
          diagLog(`Video found! src: ${videoSrc}`);
          break;
        } else {
          // Wrong video URL (e.g. gstatic preview), keep polling
          if (attempt % 6 === 0) {
            diagLog(`Ignoring non-download URL: ${val.src.substring(0, 120)}...`);
          }
        }
      }

      if (val?.error) {
        diagLog(`Generation error detected: ${val.error}`);
        resolve({ success: false, code: "GENERATION_ERROR", value: `Video generation failed: ${val.error}` });
        return;
      }

      if (attempt > 0 && attempt % 12 === 0) {
        const elapsed = ((Date.now() - genStartTime) / 1000).toFixed(0);
        diagLog(`Still waiting for video... attempt ${attempt}/${VIDEO_POLL_MAX_ATTEMPTS} (${elapsed}s elapsed)`);
      }

      // Periodically close unwanted tabs (~every 30s)
      if (attempt > 0 && attempt % 6 === 0) {
        await closeUnwantedTabs(browserResult.debuggingPort, mainTargetId, diagLog);
      }

      await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
    }

    if (!videoSrc) {
      resolve({ success: false, code: "NO_VIDEO", value: "No video was generated within the time limit" });
      return;
    }

    const genDuration = ((Date.now() - genStartTime) / 1000).toFixed(1);
    diagLog(`Video generated in ${genDuration}s`);

    // Step 7: Download the video
    diagLog("Downloading video...");

    // Get cookies from the browser for authenticated download
    let cookies = [];
    try {
      const cookieResult = await Network.getCookies({ urls: [videoSrc] });
      cookies = cookieResult.cookies || [];
    } catch (_) {}

    // Also get cookies for the broader google domain
    try {
      const googleCookies = await Network.getCookies({ urls: ["https://docs.google.com"] });
      if (googleCookies.cookies) {
        const existingNames = new Set(cookies.map((c) => c.name));
        for (const c of googleCookies.cookies) {
          if (!existingNames.has(c.name)) cookies.push(c);
        }
      }
    } catch (_) {}

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Get current user agent from the browser
    let userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    try {
      const uaResult = await Runtime.evaluate({ expression: "navigator.userAgent", returnByValue: true });
      if (uaResult.result?.value) userAgent = uaResult.result.value;
    } catch (_) {}

    // Decode HTML entities in src URL
    const decodedSrc = videoSrc.replace(/&amp;/g, "&");

    const videoFilename = `veo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`;
    const videoPath = path.join(VIDEOS_DIR, videoFilename);

    const downloadSuccess = await downloadVideoFile(decodedSrc, videoPath, cookieHeader, userAgent);

    if (!downloadSuccess) {
      // Fallback: try downloading via CDP fetch
      diagLog("Direct download failed, trying CDP fetch...");
      const cdpDownload = await Runtime.evaluate({
        expression: `
(async function() {
    try {
        const resp = await fetch("${decodedSrc.replace(/"/g, '\\"')}", { credentials: 'include' });
        if (!resp.ok) return { success: false, status: resp.status };
        const blob = await resp.blob();
        const reader = new FileReader();
        return new Promise((resolve) => {
            reader.onloadend = () => {
                resolve({ success: true, data: reader.result.split(',')[1], size: blob.size });
            };
            reader.readAsDataURL(blob);
        });
    } catch(e) {
        return { success: false, error: e.message };
    }
})()`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 60000,
      });

      if (cdpDownload.result?.value?.success && cdpDownload.result.value.data) {
        const videoBuffer = Buffer.from(cdpDownload.result.value.data, "base64");
        fs.writeFileSync(videoPath, videoBuffer);
        diagLog(`Video downloaded via CDP fetch: ${videoFilename} (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
      } else {
        resolve({ success: false, code: "DOWNLOAD_FAILED", value: "Failed to download video file" });
        return;
      }
    } else {
      const fileSize = fs.statSync(videoPath).size;
      diagLog(`Video downloaded: ${videoFilename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
    }

    // Step 8: Crop watermark from bottom-right corner
    const croppedPath = await cropVeoWatermark(videoPath, diagLog);
    const finalPath = croppedPath || videoPath;

    resolve({
      success: true,
      code: "OK",
      value: finalPath,
    });
    diagLog(`SUCCESS - Video saved to: ${finalPath}`);

  } catch (error) {
    diagLog(`EXECUTE_ERROR - ${error.message}`);
    console.error("[Veo 3.1] Error:", error);
    if (!isCancelled()) {
      resolve({ success: false, code: "ERROR", value: error.message || String(error) });
    }
  } finally {
    // Close browser gracefully
    if (browserResult) {
      try {
        if (browserResult.client && browserResult.debuggingPort) {
          diagLog("Closing browser gracefully...");
          try {
            const WebSocket = require("ws");
            const debugUrl = `http://localhost:${browserResult.debuggingPort}/json/version`;
            const res = await fetch(debugUrl);
            const info = await res.json();
            const browserWsUrl = info.webSocketDebuggerUrl;

            if (browserWsUrl) {
              const ws = new WebSocket(browserWsUrl);
              await new Promise((wsResolve, wsReject) => {
                ws.on("open", () => {
                  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
                  setTimeout(() => { ws.close(); wsResolve(); }, 500);
                });
                ws.on("error", wsReject);
                setTimeout(wsReject, 3000);
              });
              diagLog("Browser closed gracefully via CDP");
            } else {
              throw new Error("No WebSocket URL");
            }
          } catch (closeErr) {
            diagLog(`Graceful close failed: ${closeErr.message}, using fallback`);
            if (browserResult.client) await browserResult.client.close().catch(() => {});
            if (browserResult.chromeProcess) browserResult.chromeProcess.kill();
          }
        } else if (browserResult.chromeProcess) {
          browserResult.chromeProcess.kill();
        }
      } catch (e) {
        console.error("[Veo 3.1] Error closing browser:", e.message);
      }
      lastBrowserCloseTime.set(profileId, Date.now());
    }

    onRequestComplete(profileId, requestKey);
  }
}

// ============ HELPERS ============

/**
 * Detect Google error dialog and click refresh/reload button if present.
 * The error dialog appears when Google Vids encounters an issue (e.g. after popup tabs are closed).
 * Works in any language by matching the dialog structure.
 */
async function detectAndRefreshOnError(Runtime, Page, diagLog = () => {}) {
  try {
    const result = await Runtime.evaluate({
      expression: `
(function() {
    // Look for the error dialog by its structure
    const dialog = document.querySelector('.javascriptMaterialdesignGm3WizDialog-dialog__surface[role="dialog"]');
    if (!dialog) return { found: false };
    
    // Check if it contains an error-related link (support.google.com/docs/answer/7505592)
    const errorLink = dialog.querySelector('a[href*="support.google.com/docs/answer/7505592"]');
    const hasFatalError = dialog.querySelector('.fatalErrorDialogTextArea') || dialog.querySelector('[jsname="C1y1Td"]');
    
    if (!errorLink && !hasFatalError) return { found: false };
    
    // Found the error dialog - click the refresh/action button
    const actionBtn = dialog.querySelector('.javascriptMaterialdesignGm3WizDialog-dialog__actions button[data-mdc-dialog-action="ok"]');
    if (actionBtn) {
        actionBtn.click();
        return { found: true, clicked: true };
    }
    return { found: true, clicked: false };
})()`,
      returnByValue: true,
      timeout: 5000,
    }).catch(() => ({ result: { value: { found: false } } }));

    const val = result.result?.value;
    if (val?.found) {
      diagLog(`Error dialog detected, ${val.clicked ? "clicked refresh button" : "no refresh button found"}`);
      if (val.clicked) {
        // Wait for page to reload
        diagLog("Waiting for page to reload after error...");
        await new Promise((r) => setTimeout(r, 3000));
        // Wait for page to be ready again
        const waitForReady = `
(async function() {
    const startTime = Date.now();
    while (Date.now() - startTime < 20000) {
        if (document.readyState === 'complete' && !document.querySelector('.javascriptMaterialdesignGm3WizDialog-dialog__surface[role="dialog"]')) {
            return true;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
})()`;
        await Runtime.evaluate({ expression: waitForReady, awaitPromise: true, returnByValue: true, timeout: 25000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
        diagLog("Page reloaded after error");
      }
    }
  } catch (_) {}
}

/**
 * Close unwanted popup tabs opened by Google (support pages, upgrade pages, etc.)
 * Uses the Chrome debugging port HTTP API to find and close non-Vids tabs.
 */
async function closeUnwantedTabs(debuggingPort, mainTargetId, diagLog = () => {}) {
  if (!debuggingPort) return;
  try {
    const res = await fetch(`http://localhost:${debuggingPort}/json/list`);
    const targets = await res.json();
    for (const target of targets) {
      if (target.type !== "page" || target.id === mainTargetId) continue;
      const url = target.url || "";
      if (
        url.includes("support.google.com") ||
        url.includes("one.google.com") ||
        url.includes("veo_upgrade") ||
        url.includes("veo-monthly-limits") ||
        url.includes("accounts.google.com/TOS") ||
        url.includes("myaccount.google.com")
      ) {
        diagLog(`Closing unwanted tab: ${url.substring(0, 100)}`);
        try {
          await fetch(`http://localhost:${debuggingPort}/json/close/${target.id}`);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * Dismiss Veo usage limit banners and detect rate limits.
 * Returns { dismissed: boolean, rateLimited: boolean, remaining: number|null, message: string }
 */
async function handleVeoUsageBanner(Runtime) {
  try {
    const result = await Runtime.evaluate({
      expression: `
(function() {
    // Look for the Veo usage banner
    const banners = document.querySelectorAll('[role="complementary"][data-role-complementary="true"]');
    for (const banner of banners) {
        const text = (banner.textContent || '').trim();
        // Check if this is a Veo usage banner (matches any language)
        if (text.includes('Veo') && (text.includes('fois') || text.includes('time') || text.includes('مر'))) {
            // Extract remaining count - look for a number near "Veo"
            const titleEl = banner.querySelector('[role="heading"]');
            const titleText = titleEl ? titleEl.textContent : text;
            const match = titleText.match(/(\\d+)/);
            const remaining = match ? parseInt(match[1], 10) : null;
            
            // Try to close the banner
            const closeBtn = banner.querySelector('button[data-banner-close-button]');
            if (closeBtn) closeBtn.click();
            
            return { 
                found: true, 
                dismissed: !!closeBtn, 
                remaining: remaining, 
                message: titleText.substring(0, 150),
                rateLimited: remaining === 0
            };
        }
    }
    
    // Also check for limit-reached state (0 remaining or upgrade-only UI)
    const allText = document.body ? document.body.innerText : '';
    if (allText.includes('veo-monthly-limits') || allText.includes('freemium_veo_upgrade')) {
        return { found: true, dismissed: false, remaining: 0, message: 'Usage limit reached', rateLimited: true };
    }
    
    return { found: false };
})()`,
      returnByValue: true,
      timeout: 5000,
    }).catch(() => ({ result: { value: { found: false } } }));

    return result.result?.value || { found: false };
  } catch (_) {
    return { found: false };
  }
}

/**
 * Check if a video file has an audio stream using ffprobe.
 * Returns true if audio is present, false otherwise.
 */
function videoHasAudio(filePath) {
  const ffprobePath = getFFprobePath();
  if (!ffprobePath) return Promise.resolve(true); // Assume audio if ffprobe unavailable

  return new Promise((resolve) => {
    execFile(ffprobePath, [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      filePath,
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        console.error("[Veo 3.1] ffprobe audio check failed:", err.message);
        resolve(true); // Assume audio on error to avoid infinite retries
        return;
      }
      const hasAudio = stdout.trim().length > 0;
      resolve(hasAudio);
    });
  });
}

/**
 * Crop the Veo watermark from the bottom-right corner of the video.
 * Uses ffprobe to get dimensions, then ffmpeg to crop only the watermark area.
 * Returns the cropped file path, or null if cropping fails (original is kept).
 */
async function cropVeoWatermark(videoPath, diagLog = () => {}) {
  const ffmpegPath = getFFmpegPath();
  const ffprobePath = getFFprobePath();
  if (!ffmpegPath || !ffprobePath) {
    diagLog("FFmpeg not available, skipping watermark removal");
    return null;
  }

  try {
    // Get video dimensions with ffprobe
    const dimensions = await new Promise((resolve, reject) => {
      execFile(ffprobePath, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        videoPath,
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(err);
        const parts = stdout.trim().split(",");
        if (parts.length >= 2) {
          resolve({ width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) });
        } else {
          reject(new Error("Could not parse dimensions"));
        }
      });
    });

    const { width, height } = dimensions;
    // Crop off bottom 4% to remove the "Veo" watermark that sits at the bottom-right
    const cropHeight = Math.floor(height * 0.96);
    diagLog(`Video dimensions: ${width}x${height}, cropping to ${width}x${cropHeight} to remove watermark`);

    const ext = path.extname(videoPath);
    const croppedPath = videoPath.replace(ext, `_clean${ext}`);

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        "-i", videoPath,
        "-map", "0",
        "-vf", `crop=${width}:${cropHeight}:0:0`,
        "-c:a", "copy",
        "-y",
        croppedPath,
      ], { timeout: 120000 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // Replace original with cropped version
    fs.unlinkSync(videoPath);
    fs.renameSync(croppedPath, videoPath);
    diagLog(`Watermark removed successfully (cropped ${height - cropHeight}px from bottom)`);
    return videoPath;
  } catch (err) {
    diagLog(`Watermark removal failed: ${err.message}, keeping original`);
    // Clean up temp file if it exists
    const ext = path.extname(videoPath);
    const croppedPath = videoPath.replace(ext, `_clean${ext}`);
    try { fs.unlinkSync(croppedPath); } catch (_) {}
    return null;
  }
}

/**
 * Download video file via HTTPS with cookies and user agent
 */
function downloadVideoFile(url, destPath, cookieHeader, userAgent) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          "Accept": "video/mp4,video/*,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://docs.google.com/",
          "Cookie": cookieHeader,
        },
        timeout: 60000,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // Follow redirect
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            downloadVideoFile(redirectUrl, destPath, cookieHeader, userAgent).then(resolve);
            return;
          }
        }

        if (res.statusCode !== 200) {
          diagLog(`Download failed with status: ${res.statusCode}`);
          resolve(false);
          return;
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve(true);
        });
        fileStream.on("error", () => resolve(false));
      });

      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * Wait for page readyState to be complete/interactive
 */
async function waitForPageReady(Runtime, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { result } = await Runtime.evaluate({ expression: "document.readyState", returnByValue: true });
      if (result.value === "complete" || result.value === "interactive") return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  diagLog("Page readyState timeout - proceeding anyway");
}

// ============ IPC HANDLERS ============

ipcMain.on("veo-account-reconnected-manual", (_e, profileId) => {
  diagLog(`Manual reconnection notification for profile: ${profileId}`);
  unblockVeoProfile(profileId);
});

ipcMain.on("google-account-reconnected-manual", (_e, profileId) => {
  if (isVeoBlocked(profileId)) {
    diagLog(`Shared reconnection notification for profile: ${profileId}`);
    unblockVeoProfile(profileId);
  }
});

module.exports = {
  startVideoRequest,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
  getQueueStatus,
  getConnectedProfiles,
  getEnabledProfiles,
  unblockVeoProfile,
  isVeoBlocked,
  getBlockedVeoProfiles,
  getBlockedVeoProfileCount,

  get MAX_CONCURRENT() {
    return MAX_CONCURRENT;
  },

  getEffectiveMaxConcurrent() {
    const connectedCount = getConnectedProfiles().length;
    return Math.max(1, connectedCount);
  },
};
