/**
 * Gemini Image Generation Module
 *
 * Generates images using Google Gemini (gemini.google.com) via browser automation.
 * Uses connected Google profiles for authentication with load balancing.
 * Includes queue system, workflow management, and proper resource cleanup.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain } = require("electron");
const { readKey, updateData, moveToPermStorage, killProfileBrowser } = require("../lib/utils");
const {
  startVCBrowser,
  isVCBrowserInstalled,
} = require("../lib/VCBrowserManager");
const {
  getConsistentFingerprintForProfile,
  getVCBrowserVersion,
} = require("../lib/cdpFingerprint");

// ============ CONFIGURATION ============
const MAX_CONCURRENT = 1; // Max concurrent requests per Google profile
const REQUEST_DELAY_MS = 2000; // Delay between requests (2s)
const BROWSER_CLOSE_COOLDOWN_MS = 3000; // Wait 3s after browser close before new launch
const IMAGE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes timeout for image generation
const PAGE_LOAD_TIMEOUT_MS = 30000; // 30s for page load
const CREATE_IMAGE_CLICK_TIMEOUT_MS = 10000; // 10s to find and click "Create image" button
const PROMPT_INPUT_TIMEOUT_MS = 30000; // 30s to find prompt input
const SEND_BUTTON_TIMEOUT_MS = 10000; // 10s to find and click send button
const IMAGE_POLL_INTERVAL_MS = 3000; // Poll for image every 3s
const IMAGE_POLL_MAX_ATTEMPTS = 100; // ~5 minutes of polling
const GEMINI_APP_URL = "https://gemini.google.com/images?hl=en";
const GOOGLE_SITES_AUTH_CHECK_URL = "https://sites.google.com/new";
const RATE_LIMIT_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// Temp directory for downloaded images
const TEMP_DIR = path.join(app.getPath("userData"), "Uploads", "Temp");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function diagLog(message) {
  console.log(`[Gemini Image] ${message}`);
}

// ============ STATE MANAGEMENT ============
const profileQueues = new Map(); // profileId -> { queue: [], activeCount: 0, lastRequestTime: 0, processing: false }
const pendingRequests = new Map(); // requestKey -> { prompt, workflowId, resolve, profileId, startTime }
const workflowRequests = new Map(); // workflowId -> Set of requestKeys
const lastBrowserCloseTime = new Map(); // profileId -> timestamp
let requestCounter = 0;

// ============ DISCONNECTION TRACKING ============
const geminiDisconnectedState = new Map(); // profileId -> { blocked: boolean, since: timestamp }

// Queue of disconnected profiles for UI notification (show one at a time with count)
const disconnectedProfileQueue = [];

// ============ RATE LIMIT TRACKING ============
// profileId -> { limited: true, since: timestamp, until: timestamp }
const geminiRateLimitedState = new Map();

// Load persisted rate limits from storage on startup
(async function loadPersistedRateLimits() {
  try {
    const stored = (await readKey("geminiImageRateLimits")) || {};
    const now = Date.now();
    for (const [profileId, entry] of Object.entries(stored)) {
      if (entry && entry.until && entry.until > now) {
        geminiRateLimitedState.set(profileId, { limited: true, since: entry.since, until: entry.until });
        console.log(`[Gemini Image] Loaded rate limit for profile ${profileId.substring(0, 8)}..., expires in ${Math.round((entry.until - now) / 60000)} min`);
      }
    }
  } catch (err) {
    console.error("[Gemini Image] Failed to load persisted rate limits:", err.message);
  }
})();

function isGeminiRateLimited(profileId) {
  const state = geminiRateLimitedState.get(profileId);
  if (!state || !state.limited) return false;
  // Auto-expire: if 6 hours have passed, treat as no longer limited
  if (Date.now() >= state.until) {
    geminiRateLimitedState.delete(profileId);
    return false;
  }
  return true;
}

function getRateLimitedGeminiProfiles() {
  const limited = [];
  for (const [profileId, state] of geminiRateLimitedState.entries()) {
    if (state.limited && Date.now() < state.until) limited.push(profileId);
  }
  return limited;
}

async function limitGeminiProfile(profileId) {
  const since = Date.now();
  const until = since + RATE_LIMIT_DURATION_MS;

  if (isGeminiRateLimited(profileId)) return; // Already limited

  console.log(`[Gemini Image] Rate-limiting profile ${profileId.substring(0, 8)}... for 6 hours (until ${new Date(until).toISOString()})`);
  geminiRateLimitedState.set(profileId, { limited: true, since, until });

  // Persist to storage
  try {
    const stored = (await readKey("geminiImageRateLimits")) || {};
    stored[profileId] = { since, until };
    await updateData("geminiImageRateLimits", stored);
  } catch (err) {
    console.error("[Gemini Image] Failed to persist rate limit:", err.message);
  }

  // Broadcast to UI
  const rateLimitedProfiles = getRateLimitedGeminiProfiles();
  broadcastToRenderers("gemini-image-rate-limited", {
    profileId,
    until,
    rateLimitedCount: rateLimitedProfiles.length,
    allRateLimitedProfiles: rateLimitedProfiles,
  });

  // System notification
  try {
    const systemNotifications = require("../lib/systemNotifications");
    systemNotifications.sendNotification("geminiImageRateLimited", { profileId });
  } catch (err) {
    console.error("[Gemini Image] Failed to send system notification:", err.message);
  }

  // Telegram notification
  try {
    const telegramNotifications = require("../lib/telegramNotifications");
    telegramNotifications.sendNotification("geminiImageRateLimited", { profileId });
  } catch (err) {
    console.error("[Gemini Image] Failed to send Telegram notification:", err.message);
  }

  // Schedule auto-unblock after 6 hours
  setTimeout(async () => {
    const state = geminiRateLimitedState.get(profileId);
    if (state && state.until === until) {
      console.log(`[Gemini Image] Rate limit expired for profile ${profileId.substring(0, 8)}...`);
      geminiRateLimitedState.delete(profileId);

      // Remove from persisted storage
      try {
        const stored = (await readKey("geminiImageRateLimits")) || {};
        delete stored[profileId];
        await updateData("geminiImageRateLimits", stored);
      } catch (_) {}

      broadcastToRenderers("gemini-image-rate-limit-expired", { profileId });
    }
  }, RATE_LIMIT_DURATION_MS);
}

function broadcastToRenderers(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    } catch (_) {}
  }
}

function isGeminiBlocked(profileId) {
  return !!(geminiDisconnectedState.get(profileId)?.blocked);
}

function getBlockedGeminiProfiles() {
  const blocked = [];
  for (const [profileId, state] of geminiDisconnectedState.entries()) {
    if (state.blocked) blocked.push(profileId);
  }
  return blocked;
}

function getBlockedGeminiProfileCount() {
  return getBlockedGeminiProfiles().length;
}

async function blockGeminiProfile(profileId) {
  const prev = geminiDisconnectedState.get(profileId) || {};
  if (!prev.blocked) {
    console.log(
      `[Gemini Image] Blocking profile ${profileId} due to disconnection`
    );
    geminiDisconnectedState.set(profileId, {
      blocked: true,
      since: Date.now(),
    });
    // Kill any open non-headless browser window for this profile
    killProfileBrowser(profileId);

    // Update profile status in storage
    try {
      const googleProfiles = (await readKey("googleProfiles")) || {};
      if (googleProfiles[profileId]) {
        googleProfiles[profileId].status = "disconnected";
        await updateData("googleProfiles", googleProfiles);
      }
    } catch (err) {
      console.error(
        "[Gemini Image] Failed to update profile status:",
        err.message
      );
    }

    // Add to queue if not already present
    if (!disconnectedProfileQueue.includes(profileId)) {
      disconnectedProfileQueue.push(profileId);
    }

    const blockedProfiles = getBlockedGeminiProfiles();
    const payload = {
      profileId,
      blockedCount: blockedProfiles.length,
      allBlockedProfiles: blockedProfiles,
    };

    broadcastToRenderers("google-account-disconnected", payload);

    // Send system notification
    try {
      const systemNotifications = require("../lib/systemNotifications");
      systemNotifications.sendNotification("googleDisconnected", {
        profileId,
      });
    } catch (err) {
      console.error(
        "[Gemini Image] Failed to send system notification:",
        err.message
      );
    }

    // Send Telegram notification
    try {
      const telegramNotifications = require("../lib/telegramNotifications");
      telegramNotifications.sendNotification("googleDisconnected", {
        profileId,
      });
    } catch (err) {
      console.error(
        "[Gemini Image] Failed to send Telegram notification:",
        err.message
      );
    }
  }
}

async function unblockGeminiProfile(profileId) {
  const prev = geminiDisconnectedState.get(profileId);
  if (prev?.blocked) {
    console.log(
      `[Gemini Image] Unblocking profile ${profileId} - reconnected`
    );
    geminiDisconnectedState.set(profileId, { blocked: false });

    // Update profile status in storage
    try {
      const googleProfiles = (await readKey("googleProfiles")) || {};
      if (googleProfiles[profileId]) {
        googleProfiles[profileId].status = "connected";
        await updateData("googleProfiles", googleProfiles);
      }
    } catch (err) {
      console.error(
        "[Gemini Image] Failed to update profile status:",
        err.message
      );
    }

    // Remove from queue
    const queueIdx = disconnectedProfileQueue.indexOf(profileId);
    if (queueIdx !== -1) {
      disconnectedProfileQueue.splice(queueIdx, 1);
    }

    const blockedProfiles = getBlockedGeminiProfiles();
    const payload = {
      profileId,
      blockedCount: blockedProfiles.length,
      allBlockedProfiles: blockedProfiles,
      // Tell the frontend which profile to show next (if any)
      nextProfileId: disconnectedProfileQueue.length > 0 ? disconnectedProfileQueue[0] : null,
    };

    broadcastToRenderers("google-account-reconnected", payload);

    // Send system notification
    try {
      const systemNotifications = require("../lib/systemNotifications");
      systemNotifications.sendNotification("googleReconnected", {
        profileId,
      });
    } catch (err) {
      console.error(
        "[Gemini Image] Failed to send system notification:",
        err.message
      );
    }

    // Send Telegram notification
    try {
      const telegramNotifications = require("../lib/telegramNotifications");
      telegramNotifications.sendNotification("googleReconnected", {
        profileId,
      });
    } catch (err) {
      console.error(
        "[Gemini Image] Failed to send Telegram notification:",
        err.message
      );
    }

    // Resume queue processing for this profile
    processQueue(profileId);
  }
}

async function areAllGeminiProfilesBlocked() {
  const enabled = await getEnabledProfiles();
  if (enabled.length === 0) return true;
  for (const profileId of enabled) {
    if (!isGeminiBlocked(profileId)) return false;
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
  return `gemini:${profileId}:${Date.now()}:${++requestCounter}`;
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
        console.log(`[Gemini Image] Waiting ${waitTime}ms before next request...`);
        await new Promise((r) => setTimeout(r, waitTime));
      }

      // Wait for browser close cooldown
      const lastCloseTime = lastBrowserCloseTime.get(profileId) || 0;
      const timeSinceClose = Date.now() - lastCloseTime;
      if (lastCloseTime > 0 && timeSinceClose < BROWSER_CLOSE_COOLDOWN_MS) {
        const cooldownWait = BROWSER_CLOSE_COOLDOWN_MS - timeSinceClose;
        console.log(`[Gemini Image] Waiting ${cooldownWait}ms for browser cooldown...`);
        await new Promise((r) => setTimeout(r, cooldownWait));
      }

      if (queueData.activeCount >= MAX_CONCURRENT) break;

      const task = queueData.queue.shift();
      if (!task) continue;

      queueData.activeCount++;
      queueData.lastRequestTime = Date.now();

      console.log(
        `[Gemini Image] Processing request for ${profileId.substring(0, 8)}... Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`
      );

      // Execute in background
      executeImageRequest(
        task.requestKey,
        task.profileId,
        task.prompt,
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

  // Clean up from workflow tracking
  for (const [workflowId, requestKeys] of workflowRequests.entries()) {
    requestKeys.delete(requestKey);
    if (requestKeys.size === 0) {
      workflowRequests.delete(workflowId);
    }
  }

  console.log(
    `[Gemini Image] Request complete. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`
  );

  // Process next in queue
  processQueue(profileId);
}

// ============ PUBLIC API ============

/**
 * Get all connected Google profiles that are enabled for Gemini Image
 * @returns {Array<string>} Array of connected profile IDs
 */
function getConnectedProfiles() {
  const googleProfiles = readKey("googleProfiles") || {};
  const allProfiles = Object.entries(googleProfiles);
  const connectedProfiles = allProfiles
    .filter(([name, data]) => data?.status === "connected")
    .map(([name]) => name);

  console.log(
    `[Gemini Image] getConnectedProfiles: Found ${allProfiles.length} total, ${connectedProfiles.length} connected`
  );

  return connectedProfiles;
}

/**
 * Get enabled profiles for Gemini Image (respects settings)
 * @returns {Promise<Array<string>>} Array of enabled profile IDs
 */
async function getEnabledProfiles() {
  const connectedProfiles = getConnectedProfiles();
  const enabledGeminiImageProfiles =
    (await readKey("enabledGeminiImageProfiles")) || [];

  // If no profiles explicitly enabled, default to all connected (backward compat)
  const enabledProfiles =
    enabledGeminiImageProfiles.length > 0
      ? connectedProfiles.filter((id) =>
          enabledGeminiImageProfiles.includes(id)
        )
      : connectedProfiles;

  return enabledProfiles;
}

/**
 * Select the best profile for a new request using load balancing
 * @returns {{profileId: string, queueData: Object, placeholderIndex: number}|null}
 */
function selectBestProfileAndReserve(enabledProfiles) {
  if (enabledProfiles.length === 0) {
    console.log("[Gemini Image] selectBestProfile: No enabled profiles!");
    return null;
  }

  let bestProfile = enabledProfiles[0];
  let minLoad = Infinity;
  let bestQueueData = getProfileQueue(enabledProfiles[0]);

  for (const profileId of enabledProfiles) {
    const queueData = getProfileQueue(profileId);
    const load = queueData.activeCount + queueData.queue.length;

    if (load < minLoad) {
      minLoad = load;
      bestProfile = profileId;
      bestQueueData = queueData;
    }
  }

  // Reserve slot immediately
  const placeholderIndex = bestQueueData.queue.length;
  bestQueueData.queue.push(null);

  console.log(
    `[Gemini Image] selectBestProfile: Selected ${bestProfile.substring(0, 8)}... (load: ${minLoad}) from ${enabledProfiles.length} profiles`
  );

  return { profileId: bestProfile, queueData: bestQueueData, placeholderIndex };
}

/**
 * Queue an image generation request
 * @param {string} prompt - The image prompt
 * @param {string} imagePath - Optional reference image path
 * @param {string} workflowId - Workflow ID for cleanup tracking
 * @returns {Promise<{success: boolean, value: string, code?: string}>}
 */
async function startImageRequest(prompt, imagePath = null, workflowId = null) {
  try {
    const enabledProfiles = await getEnabledProfiles();

    // Filter out blocked (disconnected) and rate-limited profiles
    let availableProfiles = enabledProfiles.filter(
      (id) => !isGeminiBlocked(id) && !isGeminiRateLimited(id)
    );

    // If the explicit enabled list is exhausted (all rate-limited/disconnected),
    // fall back to ALL connected profiles that are still usable — this handles the
    // case where new accounts were added but weren't in the saved enabledGeminiImageProfiles list.
    if (availableProfiles.length === 0) {
      const allConnected = getConnectedProfiles();
      const fallback = allConnected.filter(
        (id) => !isGeminiBlocked(id) && !isGeminiRateLimited(id)
      );
      if (fallback.length > 0) {
        console.log(
          `[Gemini Image] Enabled list exhausted, falling back to ${fallback.length} other connected profile(s)`
        );
        availableProfiles = fallback;
      }
    }

    // All usable profiles are exhausted — report the most helpful reason
    if (availableProfiles.length === 0) {
      const allConnected = getConnectedProfiles();

      if (allConnected.length === 0) {
        return {
          success: false,
          code: "NO_PROFILE",
          value:
            "No connected Google profile found. Please connect a Google account in Settings.",
        };
      }

      const allRateLimited = allConnected.every((id) => isGeminiRateLimited(id));
      const allDisconnected = allConnected.every((id) => isGeminiBlocked(id));

      if (allRateLimited) {
        return {
          success: false,
          code: "ALL_RATE_LIMITED",
          value:
            "All Google profiles have hit the Gemini image daily limit. They will be available again in up to 6 hours.",
          allRateLimited: true,
        };
      }

      if (allDisconnected) {
        return {
          success: false,
          code: "ALL_DISCONNECTED",
          value:
            "All Google profiles are disconnected. Please reconnect at least one profile.",
          allDisconnected: true,
        };
      }

      return {
        success: false,
        code: "ALL_UNAVAILABLE",
        value:
          "All Google profiles are either disconnected or rate-limited. Please reconnect or wait for the rate limit to expire.",
      };
    }

    const selection = selectBestProfileAndReserve(availableProfiles);
    if (!selection) {
      return {
        success: false,
        code: "NO_PROFILE",
        value:
          "No connected Google profile found. Please connect a Google account in Settings.",
      };
    }

    const { profileId: selectedProfile, queueData, placeholderIndex } = selection;
    const requestKey = generateRequestKey(selectedProfile);

    return new Promise((resolve) => {
      const task = {
        requestKey,
        profileId: selectedProfile,
        prompt,
        imagePath,
        workflowId,
        resolve,
      };

      // Track in pending requests
      pendingRequests.set(requestKey, {
        prompt,
        imagePath,
        workflowId,
        profileId: selectedProfile,
        startTime: Date.now(),
        resolve,
      });

      // Track in workflow requests
      if (workflowId) {
        if (!workflowRequests.has(workflowId)) {
          workflowRequests.set(workflowId, new Set());
        }
        workflowRequests.get(workflowId).add(requestKey);
      }

      // Replace placeholder or push to queue
      if (
        placeholderIndex >= 0 &&
        placeholderIndex < queueData.queue.length &&
        queueData.queue[placeholderIndex] === null
      ) {
        queueData.queue[placeholderIndex] = task;
      } else {
        queueData.queue.push(task);
      }

      console.log(
        `[Gemini Image] Request queued. Profile: ${selectedProfile.substring(0, 8)}..., Queue: ${queueData.queue.length}, Active: ${queueData.activeCount}`
      );

      processQueue(selectedProfile);
    });
  } catch (error) {
    console.error("[Gemini Image] Error in startImageRequest:", error);
    return {
      success: false,
      code: "ERROR",
      value: error.message || String(error),
    };
  }
}

/**
 * Stop all requests for a workflow
 * @param {string} workflowId - The workflow ID to stop
 */
function stopWorkflowQueues(workflowId) {
  console.log(
    `[Gemini Image] Stopping all requests for workflow ${workflowId}...`
  );
  let removedFromQueue = 0;
  let removedPending = 0;

  const requestKeys = workflowRequests.get(workflowId) || new Set();

  // Remove from profile queues
  for (const [profileId, queueData] of profileQueues.entries()) {
    const itemsToRemove = queueData.queue.filter(
      (item) => item && item.workflowId === workflowId
    );
    queueData.queue = queueData.queue.filter(
      (item) => !item || item.workflowId !== workflowId
    );

    for (const item of itemsToRemove) {
      item.resolve({
        success: false,
        code: "WORKFLOW_STOPPED",
        value: "Workflow was stopped",
      });
      pendingRequests.delete(item.requestKey);
      removedFromQueue++;
    }
  }

  // Cancel pending/active requests
  for (const requestKey of requestKeys) {
    const request = pendingRequests.get(requestKey);
    if (request) {
      request.resolve({
        success: false,
        code: "WORKFLOW_STOPPED",
        value: "Workflow was stopped",
      });
      pendingRequests.delete(requestKey);
      removedPending++;
    }
  }

  workflowRequests.delete(workflowId);
  console.log(
    `[Gemini Image] Workflow ${workflowId} cleanup: removed ${removedFromQueue} queued + ${removedPending} pending`
  );
}

/**
 * Clear workflow state for rerun
 * @param {string} workflowId - The workflow ID to clear
 */
function clearWorkflowStateForRerun(workflowId) {
  console.log(
    `[Gemini Image] Clearing state for workflow ${workflowId} rerun...`
  );
  const hadEntry = workflowRequests.delete(workflowId);
  if (hadEntry) {
    console.log(
      `[Gemini Image] Cleared workflowRequests entry for workflow ${workflowId}`
    );
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
        maxConcurrent: MAX_CONCURRENT,
      },
    };
  }

  const status = {};
  for (const [id, data] of profileQueues.entries()) {
    status[id] = {
      queued: data.queue.length,
      active: data.activeCount,
      maxConcurrent: MAX_CONCURRENT,
    };
  }
  return status;
}

// ============ INTERNAL EXECUTION ============

/**
 * Execute an image generation request via Gemini browser automation
 */
async function executeImageRequest(
  requestKey,
  profileId,
  prompt,
  imagePath,
  workflowId,
  resolve
) {
  let browserResult = null;

  // Helper to check if this request was cancelled (workflow stopped)
  const isCancelled = () => !pendingRequests.has(requestKey);

  try {
    console.log("[Gemini Image] Starting image generation...");
    console.log("[Gemini Image] Profile:", profileId);
    console.log(
      "[Gemini Image] Prompt:",
      prompt.substring(0, 100) + (prompt.length > 100 ? "..." : "")
    );
    if (imagePath) {
      console.log("[Gemini Image] Reference image:", imagePath);
    }

    // Check if request was cancelled
    if (!pendingRequests.has(requestKey)) {
      console.log("[Gemini Image] Request was cancelled before execution");
      return;
    }

    // Check VCBrowser installed
    if (!isVCBrowserInstalled()) {
      resolve({
        success: false,
        code: "VCBROWSER_NOT_INSTALLED",
        value: "VCBrowser is not installed. Please download it from Settings.",
      });
      return;
    }

    // Generate fingerprint
    const fingerprint = getConsistentFingerprintForProfile(profileId);
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(
          /Chrome\/[\d.]+/,
          `Chrome/${vcVersion.full}`
        );
      }
    } catch (_) {}

    // Start VCBrowser with Google profile
    diagLog(`Starting VCBrowser for profile: ${profileId}`);
    browserResult = await startVCBrowser(
      profileId,
      fingerprint,
      GEMINI_APP_URL,
      null, // proxy
      true, // headless
      true // automationMode
    );

    if (!browserResult || !browserResult.client) {
      resolve({
        success: false,
        code: "BROWSER_FAILED",
        value: "Failed to start VCBrowser or get CDP client",
      });
      return;
    }

    diagLog(
      `VCBrowser started for profile ${profileId}, port: ${browserResult.debuggingPort}`
    );

    if (isCancelled()) throw new Error("Request cancelled after browser start");

    const client = browserResult.client;
    const { Runtime, Page, Network } = client;

    await Promise.all([Runtime.enable(), Page.enable(), Network.enable()]);

    // Step 1: Preflight auth check using the same redirect logic as Google Sites.
    console.log("[Gemini Image] Checking Google account connection state...");
    await Page.navigate({ url: GOOGLE_SITES_AUTH_CHECK_URL });
    await waitForPageReady(Runtime, PAGE_LOAD_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, 800));

    const preflightUrlCheck = await Runtime.evaluate({
      expression: "window.location.href",
      returnByValue: true,
    });
    const preflightUrl = preflightUrlCheck.result?.value || "";
    diagLog(`Preflight URL (sites auth check): ${preflightUrl}`);

    if (
      preflightUrl.includes("accounts.google.com") ||
      preflightUrl.includes("/signin")
    ) {
      await blockGeminiProfile(profileId);
      resolve({
        success: false,
        code: "NOT_LOGGED_IN",
        value: "Account disconnected - profile blocked",
        disconnected: true,
        profileId,
      });
      return;
    }

    // Step 2: Navigate back to Gemini app and continue normal flow.
    console.log("[Gemini Image] Account connected. Loading Gemini app...");
    await Page.navigate({ url: GEMINI_APP_URL });
    await waitForPageReady(Runtime, PAGE_LOAD_TIMEOUT_MS);
    diagLog("Gemini page loaded after auth preflight");

    if (isCancelled()) throw new Error("Request cancelled after page load");

    // Extra wait for SPA to initialize
    await new Promise((r) => setTimeout(r, 3000));

    // Check if we're actually logged in (hard redirect to Google sign-in page)
    const urlCheck = await Runtime.evaluate({
      expression: "window.location.href",
      returnByValue: true,
    });
    const currentUrl = urlCheck.result?.value || "";
    diagLog(`Current URL: ${currentUrl}`);

    if (
      currentUrl.includes("accounts.google.com") ||
      currentUrl.includes("/signin")
    ) {
      // Block this profile due to disconnection
      await blockGeminiProfile(profileId);
      resolve({
        success: false,
        code: "NOT_LOGGED_IN",
        value: "Account disconnected - profile blocked",
        disconnected: true,
        profileId,
      });
      return;
    }

    if (isCancelled()) throw new Error("Request cancelled before prompt entry");

    // Step 3: Diagnostic - dump DOM state to help debug selector issues
    const domDump = await Runtime.evaluate({
      expression: `
  (function() {
    const info = {};
    // All contenteditable elements
    const editables = document.querySelectorAll('[contenteditable="true"]');
    info.contenteditables = Array.from(editables).map(el => ({
      tag: el.tagName,
      classes: el.className,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder'),
      visible: el.offsetParent !== null,
      rect: el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height
    }));
    // All textareas
    const textareas = document.querySelectorAll('textarea');
    info.textareas = Array.from(textareas).map(el => ({
      classes: el.className,
      id: el.id,
      placeholder: el.placeholder,
      ariaLabel: el.getAttribute('aria-label'),
      visible: el.offsetParent !== null,
      rect: el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height
    }));
    // Rich textarea custom elements
    const richTextareas = document.querySelectorAll('rich-textarea, .rich-textarea, .input-area, .text-input, .prompt-input-container');
    info.richTextareas = Array.from(richTextareas).map(el => ({
      tag: el.tagName,
      classes: el.className,
      childCount: el.children.length,
      textContent: el.textContent.substring(0, 200)
    }));
    // ql-editor elements
    const qlEditors = document.querySelectorAll('.ql-editor');
    info.qlEditors = Array.from(qlEditors).map(el => ({
      tag: el.tagName,
      classes: el.className,
      contenteditable: el.getAttribute('contenteditable'),
      visible: el.offsetParent !== null,
      rect: el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height
    }));
    return JSON.stringify(info, null, 2);
  })()`,
      returnByValue: true,
    });
    const domInfo = domDump.result?.value || "failed to dump DOM";
    console.log("[Gemini Image] DOM state before prompt entry:", domInfo);
    diagLog(`DOM state: ${domInfo}`);

    // Step 4: Enter the prompt in the text area
    console.log("[Gemini Image] Entering prompt...");
    // Escape the prompt for safe embedding in JS template literal
    const escapedPrompt = prompt
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");

    const enterPrompt = await Runtime.evaluate({
      expression: `
  (async function() {
    const startTime = Date.now();
    const timeout = ${PROMPT_INPUT_TIMEOUT_MS};
    
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return (rect.width > 0 && rect.height > 0) || el.offsetParent !== null;
    }
    
    // Safe text insertion that bypasses Trusted Types CSP
    function insertTextSafely(el, text) {
      // Method 1: execCommand insertText (bypasses Trusted Types)
      el.focus();
      // Select all existing content first to replace it
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
        
      const inserted = document.execCommand('insertText', false, text);
      if (inserted && el.textContent.includes(text.substring(0, 20))) {
        return 'execCommand';
      }
        
      // Method 2: textContent (no Trusted Types issue since it's plain text)
      try {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (el.textContent.includes(text.substring(0, 20))) {
          return 'textContent';
        }
      } catch(e) {}
        
      // Method 3: Create text node manually
      try {
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(document.createTextNode(text));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (el.textContent.includes(text.substring(0, 20))) {
          return 'createTextNode';
        }
      } catch(e) {}
        
      return null;
    }
    
    while (Date.now() - startTime < timeout) {
      // Try contenteditable selectors
      const ceSelectors = [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div.ql-editor',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][aria-label*="prompt" i]',
        'div[contenteditable="true"][aria-label*="Gemini" i]',
        'div[contenteditable="true"][aria-label*="Enter" i]',
        'div[contenteditable="true"][aria-label*="message" i]',
        'div[contenteditable="true"][data-placeholder]',
        '.input-area div[contenteditable="true"]',
        '.text-input-field_textarea-wrapper div[contenteditable="true"]',
        '.prompt-input-container div[contenteditable="true"]',
        'div[contenteditable="true"]'
      ];
        
      for (const selector of ceSelectors) {
        const el = document.querySelector(selector);
        if (el && isVisible(el)) {
          const method = insertTextSafely(el, \`${escapedPrompt}\`);
          if (method) {
            // Dispatch additional events for framework detection
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            return { success: true, selector: selector, type: 'contenteditable', method: method };
          }
          // Element found but all insertion methods failed
          return { success: false, error: 'Found element ' + selector + ' but all text insertion methods failed (Trusted Types CSP)', needsCDP: true, selector: selector };
        }
      }
        
      // Try textarea elements
      const textareaSelectors = [
        'textarea[aria-label*="prompt" i]',
        'textarea[aria-label*="Gemini" i]',
        'textarea[aria-label*="Enter" i]',
        'textarea[aria-label*="message" i]',
        'textarea[placeholder]',
        '.input-area textarea',
        '.prompt-input-container textarea',
        'textarea'
      ];
        
      for (const selector of textareaSelectors) {
        const el = document.querySelector(selector);
        if (el && isVisible(el)) {
          el.focus();
          // Use native setter to bypass any framework wrappers
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(el, \`${escapedPrompt}\`);
          } else {
            el.value = \`${escapedPrompt}\`;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, selector: selector, type: 'textarea' };
        }
      }
        
      await new Promise(r => setTimeout(r, 1000));
    }
    return { success: false, error: 'Prompt input not found within timeout' };
  })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: PROMPT_INPUT_TIMEOUT_MS + 5000,
    });

    // If JS-level insertion failed due to Trusted Types, use CDP Input.insertText
    if (enterPrompt.result?.value?.needsCDP) {
      console.log("[Gemini Image] Trusted Types blocked JS insertion, using CDP Input.insertText...");
      diagLog("Falling back to CDP Input.insertText due to Trusted Types CSP");
      
      const { Input } = client;
      
      // Focus the element first via JS
      const focusSelector = enterPrompt.result.value.selector;
      await Runtime.evaluate({
        expression: `
(function() {
    const el = document.querySelector('${focusSelector}');
    if (el) {
        el.focus();
        // Select all to clear
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
    }
})()`,
        returnByValue: true,
      });
      
      await new Promise((r) => setTimeout(r, 300));
      
      // Delete any existing content
      await Input.dispatchKeyEvent({ type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await Input.dispatchKeyEvent({ type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await new Promise((r) => setTimeout(r, 200));
      
      // Type the prompt using CDP insertText
      await Input.insertText({ text: prompt });
      await new Promise((r) => setTimeout(r, 500));
      
      // Verify text was entered
      const verifyResult = await Runtime.evaluate({
        expression: `
(function() {
    const el = document.querySelector('${focusSelector}');
    return el ? el.textContent.length > 0 : false;
})()`,
        returnByValue: true,
      });
      
      if (verifyResult.result?.value) {
        console.log("[Gemini Image] Prompt entered via CDP Input.insertText");
        diagLog("Prompt entered via CDP Input.insertText");
      } else {
        resolve({
          success: false,
          code: "PROMPT_FAILED",
          value: "Failed to enter prompt text even via CDP Input.insertText",
        });
        return;
      }
    } else if (!enterPrompt.result?.value?.success) {
      resolve({
        success: false,
        code: "PROMPT_FAILED",
        value:
          enterPrompt.result?.value?.error ||
          "Failed to find prompt input area",
      });
      return;
    }

    console.log(
      `[Gemini Image] Prompt entered via: ${enterPrompt.result?.value?.selector}`
    );
    diagLog("Prompt entered successfully");

    // Small wait for UI to update after typing
    await new Promise((r) => setTimeout(r, 1000));

    if (isCancelled()) throw new Error("Request cancelled after prompt entry");

    // Step 4b: Upload reference image if provided (via synthetic clipboard paste)
    if (imagePath && fs.existsSync(imagePath)) {
      console.log("[Gemini Image] Uploading reference image via clipboard paste:", imagePath);
      diagLog(`Uploading reference image via paste: ${imagePath}`);

      try {
        const { Input } = client;

        // Read image file as base64
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString("base64");
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const fileName = path.basename(imagePath);

        console.log(`[Gemini Image] Image: ${fileName}, ${(imageBuffer.length / 1024).toFixed(1)} KB, ${mimeType}`);

        // Focus the contenteditable input area first
        await Runtime.evaluate({
          expression: `
(function() {
    const selectors = [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div.ql-editor',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().width > 0) {
            el.focus();
            return true;
        }
    }
    return false;
})()`,
          returnByValue: true,
        });

        await new Promise((r) => setTimeout(r, 500));

        // Dispatch a synthetic paste event with the image as a File in the DataTransfer
        // This does NOT touch the system clipboard at all
        const pasteResult = await Runtime.evaluate({
          expression: `
(async function() {
    const base64 = "${base64Image}";
    const mimeType = "${mimeType}";
    const fileName = "${fileName}";
    
    // Convert base64 to binary
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    const file = new File([blob], fileName, { type: mimeType });
    
    // Create a DataTransfer with the file
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    
    // Find the target element to paste into
    const selectors = [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div.ql-editor',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
    ];
    
    let target = null;
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().width > 0) {
            target = el;
            break;
        }
    }
    
    if (!target) {
        return { success: false, error: 'No contenteditable target found for paste' };
    }
    
    target.focus();
    
    // Create and dispatch the paste event
    const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
    });
    
    target.dispatchEvent(pasteEvent);
    
    return { success: true, target: target.tagName + '.' + (target.className || '').substring(0, 30), fileSize: bytes.length };
})()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: 30000,
        });

        if (pasteResult.result?.value?.success) {
          console.log(
            `[Gemini Image] Paste event dispatched to: ${pasteResult.result.value.target} (${(pasteResult.result.value.fileSize / 1024).toFixed(1)} KB)`
          );
          diagLog("Synthetic paste event dispatched");
        } else {
          const pasteError = pasteResult.result?.value?.error || "Unknown paste error";
          console.error("[Gemini Image] Image paste failed:", pasteError);
          diagLog(`Paste failed: ${pasteError}`);
          resolve({
            success: false,
            code: "IMAGE_PASTE_FAILED",
            value: `Failed to paste reference image: ${pasteError}`,
          });
          return;
        }

        // Wait for the consent dialog and handle it
        await new Promise((r) => setTimeout(r, 2000));

        const agreeResult = await Runtime.evaluate({
          expression: `
(async function() {
    for (let i = 0; i < 15; i++) {
        const agreeBtn = document.querySelector('button[data-test-id="upload-image-agree-button"]');
        if (agreeBtn) {
            const rect = agreeBtn.getBoundingClientRect();
            return { 
                success: true, 
                found: true, 
                x: Math.round(rect.x + rect.width / 2), 
                y: Math.round(rect.y + rect.height / 2) 
            };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: true, found: false };
})()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: 12000,
        });

        if (agreeResult.result?.value?.found) {
          const { x, y } = agreeResult.result.value;
          await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          console.log("[Gemini Image] Clicked 'Agree' on consent dialog");
          diagLog("Consent dialog dismissed via CDP click");
          await new Promise((r) => setTimeout(r, 1500));
        }

        // Wait for image upload to complete by checking if the send button becomes enabled
        // While uploading, Gemini disables the send button; it re-enables once the upload finishes
        const uploadCheck = await Runtime.evaluate({
          expression: `
(async function() {
    for (let i = 0; i < 60; i++) {
        const sendBtn = document.querySelector(
            'button.send-button, button[aria-label="Send message"], button[data-test-id="send-button"]'
        );
        if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
            return { success: true, method: 'send-button-enabled', attempts: i };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return { success: false, method: 'timeout' };
})()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: 35000,
        });

        if (uploadCheck.result?.value?.success) {
          console.log(`[Gemini Image] Image upload complete (send button enabled after ${uploadCheck.result.value.attempts} checks)`);
          diagLog("Image upload confirmed via send button state");
        } else {
          console.error("[Gemini Image] Image upload timed out - send button never became enabled");
          diagLog("Upload timed out - failing");
          resolve({
            success: false,
            code: "IMAGE_UPLOAD_TIMEOUT",
            value: "Reference image upload timed out (send button remained disabled)",
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));

      } catch (uploadErr) {
        console.error(
          "[Gemini Image] Image upload failed:",
          uploadErr.message
        );
        diagLog(`Image upload error: ${uploadErr.message}`);
        resolve({
          success: false,
          code: "IMAGE_UPLOAD_FAILED",
          value: `Failed to upload reference image: ${uploadErr.message}`,
        });
        return;
      }
    }

    if (isCancelled()) throw new Error("Request cancelled before sending");

    // Step 4: Set up download directory for full-size image capture
    // Network interception only captures thumbnails; we need to click the
    // "Download full size" button to get the original PNG.
    console.log("[Gemini Image] Setting up download directory...");
    const downloadDir = path.join(
      TEMP_DIR,
      `gemini_dl_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`
    );
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    // Enable CDP download behavior to save files to our directory
    try {
      const { Browser } = client;
      await Browser.setDownloadBehavior({
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
    } catch (dlSetupErr) {
      try {
        await Page.setDownloadBehavior({
          behavior: "allow",
          downloadPath: downloadDir,
        });
      } catch (e2) {
        console.warn(
          "[Gemini Image] Could not set download behavior:",
          e2.message
        );
      }
    }
    diagLog(`Download dir: ${downloadDir}`);

    // Count existing download buttons before sending prompt
    // so we can detect when a NEW one appears after generation
    const preExistingBtnCount = await Runtime.evaluate({
      expression: `document.querySelectorAll('button[data-test-id="download-generated-image-button"], button[aria-label="Download full size image"], button[aria-label="Download full size"]').length`,
      returnByValue: true,
    })
      .then((r) => r.result?.value || 0)
      .catch(() => 0);
    console.log(
      `[Gemini Image] Pre-existing download buttons: ${preExistingBtnCount}`
    );

    if (isCancelled()) throw new Error("Request cancelled before send");

    // Step 5: Press Enter to submit
    console.log("[Gemini Image] Pressing Enter to submit...");

    // Re-focus the editor before pressing Enter
    await Runtime.evaluate({
      expression: `
(function() {
    const selectors = [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div.ql-editor',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().width > 0) {
            el.focus();
            return true;
        }
    }
    return false;
})()`,
      returnByValue: true,
    });

    await new Promise((r) => setTimeout(r, 300));

    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await new Promise((r) => setTimeout(r, 100));
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

    console.log("[Gemini Image] Enter key pressed to submit");
    diagLog("Enter key pressed to submit");

    // Step 6: Wait for image generation (new download button appears)
    console.log("[Gemini Image] Waiting for generated image...");
    diagLog("Waiting for download button to appear (image generation)...");

    let downloadButtonAppeared = false;
    const imageGenStart = Date.now();

    for (let attempt = 0; attempt < IMAGE_POLL_MAX_ATTEMPTS; attempt++) {
      // Check if request was cancelled
      if (isCancelled()) {
        throw new Error("Request cancelled during image wait");
      }

      const domCheck = await Runtime.evaluate({
        expression: `
(function() {
    // Count download buttons — a new one means a new image was generated
    const btns = document.querySelectorAll(
        'button[data-test-id="download-generated-image-button"], ' +
        'button[aria-label="Download full size image"], ' +
        'button[aria-label="Download full size"]'
    );

    // Check for rate limit / daily limit message in the page text
    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
    const rateLimitPhrases = [
        "can't create more images for you today",
        "cannot create more images for you today",
        "reached the limit",
        "image request denied",
        "can't generate more images",
        "cannot generate more images",
        "image generation limit",
        "daily limit"
    ];
    const rateLimited = rateLimitPhrases.some(phrase => bodyText.includes(phrase));

    return { count: btns.length, rateLimited };
})()`,
        returnByValue: true,
        timeout: 10000,
      }).catch(() => ({ result: { value: { count: 0, rateLimited: false } } }));

      // Check again after the evaluate (may have been cancelled while it was running)
      if (isCancelled()) {
        throw new Error("Request cancelled during image wait");
      }

      // Detect rate limit message — fail immediately and mark profile as limited
      if (domCheck.result?.value?.rateLimited) {
        console.log(`[Gemini Image] Daily image limit detected for profile ${profileId.substring(0, 8)}... Marking as rate-limited for 6 hours.`);
        diagLog("Rate limit message detected in DOM");
        await limitGeminiProfile(profileId);
        resolve({
          success: false,
          code: "RATE_LIMITED",
          value: "Gemini has reached the daily image creation limit for this account. The profile will be available again in 6 hours.",
          rateLimited: true,
          profileId,
        });
        return;
      }

      const currentCount = domCheck.result?.value?.count || 0;

      if (currentCount > preExistingBtnCount) {
        downloadButtonAppeared = true;
        console.log(
          `[Gemini Image] New download button detected (${preExistingBtnCount} → ${currentCount}) at attempt ${attempt}`
        );
        diagLog(`Download button appeared at attempt ${attempt}`);
        break;
      }

      if (attempt > 0 && attempt % 10 === 0) {
        console.log(
          `[Gemini Image] Still waiting for image... attempt ${attempt}/${IMAGE_POLL_MAX_ATTEMPTS}`
        );
      }

      // Interruptible sleep: check cancellation every 500ms instead of blocking for the full interval
      const sleepEnd = Date.now() + IMAGE_POLL_INTERVAL_MS;
      while (Date.now() < sleepEnd) {
        await new Promise((r) => setTimeout(r, 500));
        if (isCancelled()) {
          throw new Error("Request cancelled during image wait");
        }
      }
    }

    if (!downloadButtonAppeared) {
      resolve({
        success: false,
        code: "NO_IMAGE",
        value: "No image was generated by Gemini within the time limit",
      });
      return;
    }

    const genDuration = ((Date.now() - imageGenStart) / 1000).toFixed(1);
    console.log(`[Gemini Image] Image generated in ${genDuration}s`);
    diagLog(`Image generated in ${genDuration}s`);

    // Give a moment for the UI to fully render the download button
    await new Promise((r) => setTimeout(r, 2000));

    // Step 7: Click the download button to get the full-size image
    console.log("[Gemini Image] Clicking download button for full-size image...");

    // Snapshot existing files in download dir before clicking
    const existingFiles = new Set(
      fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : []
    );

    const clickDownload = await Runtime.evaluate({
      expression: `
(async function() {
    const selectors = [
        'button[data-test-id="download-generated-image-button"]',
        'button[aria-label="Download full size image"]',
        'button[aria-label="Download full size"]',
        'button[mattooltip="Download full size"]'
    ];

    // Find the LAST matching button (most recent generated image)
    for (const selector of selectors) {
        const buttons = document.querySelectorAll(selector);
        if (buttons.length > 0) {
            const btn = buttons[buttons.length - 1];
            btn.click();
            return { success: true, selector: selector, count: buttons.length };
        }
    }

    return { success: false, error: 'Download button not found' };
})()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });

    if (!clickDownload.result?.value?.success) {
      resolve({
        success: false,
        code: "DOWNLOAD_CLICK_FAILED",
        value:
          clickDownload.result?.value?.error ||
          "Failed to click download button",
      });
      return;
    }

    console.log(
      `[Gemini Image] Download clicked via: ${clickDownload.result?.value?.selector} (${clickDownload.result?.value?.count} buttons found)`
    );
    diagLog("Download button clicked");

    // Wait for the downloaded file to appear in our download directory
    let downloadedFilePath = null;
    const downloadTimeout = 30000; // 30 seconds
    const downloadStart = Date.now();

    while (Date.now() - downloadStart < downloadTimeout) {
      await new Promise((r) => setTimeout(r, 500));

      if (isCancelled()) throw new Error("Request cancelled during file download wait");

      try {
        const currentFiles = fs.readdirSync(downloadDir);
        for (const file of currentFiles) {
          if (
            !existingFiles.has(file) &&
            !file.endsWith(".crdownload") &&
            !file.endsWith(".tmp")
          ) {
            const filePath = path.join(downloadDir, file);
            // Make sure the file has content (not still being written)
            const stat = fs.statSync(filePath);
            if (stat.size > 0) {
              downloadedFilePath = filePath;
              break;
            }
          }
        }
        if (downloadedFilePath) break;
      } catch (_) {
        // Directory might not be ready yet
      }
    }

    if (!downloadedFilePath) {
      resolve({
        success: false,
        code: "DOWNLOAD_TIMEOUT",
        value: "Downloaded file did not appear within 30 seconds",
      });
      return;
    }

    const dlFileSize = fs.statSync(downloadedFilePath).size;
    console.log(
      `[Gemini Image] Downloaded full-size image: ${path.basename(downloadedFilePath)} (${(dlFileSize / 1024).toFixed(1)} KB)`
    );
    diagLog(
      `Downloaded: ${path.basename(downloadedFilePath)}, ${(dlFileSize / 1024).toFixed(1)} KB`
    );

    // Step 8: Remove Gemini watermark via reverse alpha blending
    console.log("[Gemini Image] Step 8: Removing Gemini watermark...");
    const cleanedFilename = `gemini_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`;
    const cleanedPath = path.join(TEMP_DIR, cleanedFilename);

    try {
      const sharp = require("sharp");
      const { removeWatermarkFromBuffer } = await import("@pilio/gemini-watermark-remover/node");

      const inputBuffer = fs.readFileSync(downloadedFilePath);

      async function decodeImageData(buffer) {
        const { data, info } = await sharp(buffer)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return {
          data: new Uint8ClampedArray(data.buffer),
          width: info.width,
          height: info.height,
        };
      }

      async function encodeImageData(imageData) {
        const { data, width, height } = imageData;
        return sharp(Buffer.from(data.buffer), {
          raw: { width, height, channels: 4 },
        })
          .png()
          .toBuffer();
      }

      const result = await removeWatermarkFromBuffer(inputBuffer, {
        mimeType: "image/png",
        decodeImageData,
        encodeImageData,
      });

      fs.writeFileSync(cleanedPath, result.buffer);
      console.log(`[Gemini Image] Watermark removed (applied: ${result.meta?.applied}, tier: ${result.meta?.decisionTier})`);
      diagLog(`Watermark removed via reverse alpha blending, applied: ${result.meta?.applied}`);
    } catch (wmError) {
      console.warn(
        "[Gemini Image] Watermark removal failed (non-fatal):",
        wmError.message
      );
      diagLog(`Watermark removal error: ${wmError.message}`);
      fs.copyFileSync(downloadedFilePath, cleanedPath);
    }

    // Clean up download directory
    try {
      fs.unlinkSync(downloadedFilePath);
      fs.rmdirSync(downloadDir);
    } catch (_) {}

    // Step 9: Move to permanent storage
    const tempImagePath = cleanedPath;
    const fileSize = fs.statSync(tempImagePath).size;
    console.log(
      `[Gemini Image] Image saved to temp: ${tempImagePath} - Size: ${(fileSize / 1024).toFixed(1)} KB`
    );

    // Check if AI image cleaning is enabled
    const automationSettings = (await readKey("automationSettings")) || {};
    const cleanAI = automationSettings.aiImageCleaning !== false;

    // Get image metadata settings
    const imageMetadataSettings =
      (await readKey("imageMetadataSettings")) || {};

    // Move to permanent storage
    const moveResult = await moveToPermStorage(tempImagePath, {
      cleanAI,
      injectMetadata:
        imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
      nodeType: "geminiimage",
      workflowId,
      prompt,
    });

    const finalImagePath = moveResult.success
      ? moveResult.permanentPath
      : tempImagePath;

    if (moveResult.success) {
      console.log(
        "[Gemini Image] Moved to permanent storage:",
        finalImagePath
      );
      try {
        fs.unlinkSync(tempImagePath);
      } catch (_) {}
    } else {
      console.warn(
        "[Gemini Image] Failed to move to permanent storage:",
        moveResult.error
      );
    }

    resolve({
      success: true,
      code: "OK",
      value: finalImagePath,
    });
    diagLog(
      `SUCCESS - requestKey: ${requestKey.substring(0, 20)}, imagePath: ${finalImagePath}`
    );
  } catch (error) {
    diagLog(
      `EXECUTE_ERROR - requestKey: ${requestKey.substring(0, 20)}, error: ${error.message}`
    );
    console.error("[Gemini Image] Error:", error);
    // Only resolve if the request wasn't already resolved by stopWorkflowQueues
    if (!isCancelled()) {
      resolve({
        success: false,
        code: "ERROR",
        value: error.message || String(error),
      });
    } else {
      console.log("[Gemini Image] Request was cancelled, skipping resolve (already resolved by stopWorkflowQueues)");
    }
  } finally {
    diagLog(
      `FINALLY - requestKey: ${requestKey.substring(0, 20)}, hasBrowser: ${!!browserResult}`
    );

    // Delete the Gemini conversation before closing browser
    if (browserResult && browserResult.client) {
      try {
        const { Runtime } = browserResult.client;
        console.log("[Gemini Image] Deleting conversation...");
        diagLog("Deleting conversation...");

        const currentUrlResult = await Runtime.evaluate({
          expression: `window.location.href`,
          returnByValue: true,
          timeout: 5000,
        });
        const currentUrl = currentUrlResult.result?.value || "";
        const urlMatch = currentUrl.match(/\/app\/([a-f0-9]+)/);

        if (urlMatch) {
          const deleteResult = await Runtime.evaluate({
            expression: `
(async function() {
    const convId = '${urlMatch[1]}';

    // Step 1: Find and click the 3-dot menu button
    const convLinks = document.querySelectorAll('a[data-test-id="conversation"]');
    let menuBtn = null;
    for (const link of convLinks) {
        if ((link.getAttribute('href') || '').includes(convId)) {
            const container = link.closest('.conversation-items-container') || link.parentElement;
            menuBtn = container?.querySelector('button[data-test-id="actions-menu-button"]');
            break;
        }
    }
    if (!menuBtn) return { success: false, error: 'Menu button not found for ' + convId };

    menuBtn.click();
    await new Promise(r => setTimeout(r, 1000));

    // Step 2: Click delete in the dropdown menu
    const deleteBtn = document.querySelector('button[data-test-id="delete-button"]');
    if (!deleteBtn) return { success: false, error: 'Delete button not found in menu' };

    deleteBtn.click();
    await new Promise(r => setTimeout(r, 1000));

    // Step 3: Click confirm in the dialog
    const confirmBtn = document.querySelector('button[data-test-id="confirm-button"]');
    if (!confirmBtn) return { success: false, error: 'Confirm button not found in dialog' };

    confirmBtn.click();
    await new Promise(r => setTimeout(r, 2000));
    return { success: true };
})()`,
            awaitPromise: true,
            returnByValue: true,
            timeout: 15000,
          });

          const delVal = deleteResult.result?.value;
          if (delVal?.success) {
            console.log("[Gemini Image] Conversation deleted successfully");
            diagLog("Conversation deleted");
            // Wait for deletion to propagate on server before closing browser
            await new Promise((r) => setTimeout(r, 3000));
          } else {
            console.warn("[Gemini Image] Conversation deletion issue:", delVal?.error || "Unknown");
            diagLog(`Conversation deletion issue: ${delVal?.error || "Unknown"}`);
          }
        } else {
          console.warn("[Gemini Image] No conversation URL to delete (still on home page)");
          diagLog("No conversation URL found");
        }
      } catch (delError) {
        console.warn("[Gemini Image] Conversation deletion failed (non-fatal):", delError.message);
        diagLog(`Conversation deletion error: ${delError.message}`);
      }
    }

    // Close browser gracefully
    if (browserResult) {
      try {
        if (browserResult.client && browserResult.debuggingPort) {
          console.log("[Gemini Image] Closing browser gracefully...");
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
                  ws.send(
                    JSON.stringify({ id: 1, method: "Browser.close" })
                  );
                  setTimeout(() => {
                    ws.close();
                    wsResolve();
                  }, 500);
                });
                ws.on("error", wsReject);
                setTimeout(wsReject, 3000);
              });
              console.log(
                "[Gemini Image] Browser closed gracefully via CDP"
              );
            } else {
              throw new Error("No WebSocket URL available");
            }
          } catch (closeErr) {
            console.log(
              "[Gemini Image] Graceful close failed, using fallback:",
              closeErr.message
            );
            if (browserResult.client) {
              await browserResult.client.close().catch(() => {});
            }
            if (browserResult.chromeProcess) {
              browserResult.chromeProcess.kill();
            }
          }
        } else if (browserResult.chromeProcess) {
          browserResult.chromeProcess.kill();
          console.log("[Gemini Image] Browser closed (hard kill)");
        }
      } catch (e) {
        console.error("[Gemini Image] Error closing browser:", e.message);
      }

      lastBrowserCloseTime.set(profileId, Date.now());
    }

    // Mark request as complete
    onRequestComplete(profileId, requestKey);
  }
}

// ============ HELPERS ============

/**
 * Wait for page readyState to be complete/interactive
 */
async function waitForPageReady(Runtime, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { result } = await Runtime.evaluate({
        expression: "document.readyState",
        returnByValue: true,
      });
      if (
        result.value === "complete" ||
        result.value === "interactive"
      ) {
        return;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  diagLog("Page readyState timeout - proceeding anyway");
}

// ============ IPC HANDLERS ============

// Listen to the shared reconnection event (same channel used by Google Sites modal)
ipcMain.on("google-account-reconnected-manual", (_e, profileId) => {
  if (isGeminiBlocked(profileId)) {
    console.log(
      `[Gemini Image] Reconnection notification for profile: ${profileId}`
    );
    unblockGeminiProfile(profileId);
  }
});

module.exports = {
  startImageRequest,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
  getQueueStatus,
  getConnectedProfiles,
  getEnabledProfiles,
  unblockGeminiProfile,
  isGeminiBlocked,
  getBlockedGeminiProfiles,
  getBlockedGeminiProfileCount,
  isGeminiRateLimited,
  getRateLimitedGeminiProfiles,
  limitGeminiProfile,

  get MAX_CONCURRENT() {
    return MAX_CONCURRENT;
  },

  getEffectiveMaxConcurrent() {
    const connectedCount = getConnectedProfiles().length;
    return Math.max(1, connectedCount);
  },
};
