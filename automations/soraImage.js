/**
 * Sora Image Generation Module
 *
 * Generates images using OpenAI's Sora (sora.chatgpt.com) via browser automation.
 * Reuses OpenAI browser profiles (same as ChatGPT Image) for authentication.
 * Supports multi-variant output (1-4 images per prompt) with user selection.
 * Includes queue system for concurrent prompt processing.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const { app } = require("electron");
const { readKey, moveToPermStorage, moveMultipleToPermStorage } = require("../lib/utils");
const { startVCBrowser, isVCBrowserInstalled } = require("../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../lib/cdpFingerprint");

// ============ CONFIGURATION ============
const DEFAULT_MAX_CONCURRENT = 3;           // Default concurrent requests (matches UI default)
const POLL_INTERVAL_MS = 3000;              // Poll every 3 seconds
const MAX_POLL_ATTEMPTS = 100;              // ~5 minutes with 3s intervals
const DEFAULT_TIMEOUT_S = 300;              // 5 min default timeout
const BROWSER_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // Close browser after 2min idle
const SESSION_REUSE_MAX_AGE_MS = 10 * 60 * 1000; // Max 10min per session before refresh
const UPLOAD_MAX_RETRIES = 5;               // Max retries for rate-limited uploads
const UPLOAD_INITIAL_BACKOFF_MS = 5000;     // Initial backoff for 429 errors (5s)
const REQUEST_DELAY_MS = 3000;              // Delay between dispatching requests
const PROFILE_RATE_LIMIT_MS = 5000;         // Min 5 seconds between requests per profile

function diagLog(message) {
  console.log(`[Sora Image] ${message}`);
}

// ============ SIZE PRESETS ============
const SIZE_MAP = {
  "480x720": { width: 480, height: 720 },   // Portrait (Pinterest-style)
  "720x480": { width: 720, height: 480 },   // Landscape
  "720x720": { width: 720, height: 720 },   // Square
  "1024x1024": { width: 1024, height: 1024 }, // Large square
};

// ============ BROWSER SESSION MANAGER ============
class BrowserSessionManager {
  constructor() {
    this.sessions = new Map(); // profileId -> { client, Runtime, Page, Network, Browser, debuggingPort, createdAt, lastUsed, idleTimer }
    this.sessionLocks = new Map(); // profileId -> Promise (serialises browser launches)
  }

  /**
   * Get or create a browser session for the given profile.
   * Sessions are reused across requests for efficiency.
   */
  async getSession(profileId) {
    // Check existing session
    const existing = this.sessions.get(profileId);
    if (existing) {
      // Check if session is still alive and not too old
      const age = Date.now() - existing.createdAt;
      if (age < SESSION_REUSE_MAX_AGE_MS) {
        this._resetIdleTimer(profileId);
        existing.lastUsed = Date.now();
        return existing;
      } else {
        diagLog(`Session for ${profileId} expired (age: ${Math.round(age / 1000)}s), recycling`);
        await this.closeSession(profileId);
      }
    }

    // Serialise browser launches per profile to avoid race conditions
    if (this.sessionLocks.has(profileId)) {
      await this.sessionLocks.get(profileId);
      // After waiting, the session may have been created
      const afterWait = this.sessions.get(profileId);
      if (afterWait) {
        this._resetIdleTimer(profileId);
        afterWait.lastUsed = Date.now();
        return afterWait;
      }
    }

    let resolveLock;
    const lockPromise = new Promise((r) => { resolveLock = r; });
    this.sessionLocks.set(profileId, lockPromise);

    try {
      const session = await this._createSession(profileId);
      this.sessions.set(profileId, session);
      this._resetIdleTimer(profileId);
      return session;
    } finally {
      this.sessionLocks.delete(profileId);
      resolveLock();
    }
  }

  async _createSession(profileId) {
    diagLog(`Creating new browser session for profile: ${profileId}`);

    if (!isVCBrowserInstalled()) {
      throw new Error("VCBrowser is not installed. Please download it from Settings.");
    }

    const fingerprint = getConsistentFingerprintForProfile(profileId);

    // Update to VCBrowser's actual version
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(
          /Chrome\/[\d.]+/,
          `Chrome/${vcVersion.full}`
        );
      }
    } catch (_) {}

    const browserResult = await startVCBrowser(
      profileId,
      fingerprint,
      "https://sora.chatgpt.com/library",
      null,  // proxy
      true,  // headless
      true   // automationMode
    );

    if (!browserResult || !browserResult.client) {
      throw new Error("Failed to start VCBrowser or get CDP client");
    }

    diagLog(`VCBrowser started for profile ${profileId}, port: ${browserResult.debuggingPort}`);

    const client = browserResult.client;
    const { Runtime, Page, Network, Browser } = client;

    await Promise.all([
      Runtime.enable(),
      Page.enable(),
      Network.enable(),
    ]);

    // Wait for page to be ready
    await this._waitForPageReady(Runtime, 30000);

    // Verify we're logged in by checking for auth
    const authCheck = await this._checkAuth(Runtime);
    if (!authCheck.loggedIn) {
      // Try navigating to library again and wait
      await Page.navigate({ url: "https://sora.chatgpt.com/library" });
      await new Promise((r) => setTimeout(r, 5000));
      const retryCheck = await this._checkAuth(Runtime);
      if (!retryCheck.loggedIn) {
        throw new Error(
          `Sora profile ${profileId} is not logged in. Please re-connect the OpenAI profile in Settings.`
        );
      }
    }

    diagLog(`Session authenticated for profile ${profileId}`);

    return {
      profileId,
      client,
      Runtime,
      Page,
      Network,
      Browser,
      debuggingPort: browserResult.debuggingPort,
      browserResult,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      idleTimer: null,
    };
  }

  async _waitForPageReady(Runtime, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { result } = await Runtime.evaluate({
          expression: "document.readyState",
          returnByValue: true,
        });
        if (result.value === "complete" || result.value === "interactive") {
          // Extra wait for SPA to initialise
          await new Promise((r) => setTimeout(r, 3000));
          return;
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 500));
    }
    diagLog("Page readyState timeout - proceeding anyway");
  }

  async _checkAuth(Runtime) {
    try {
      // Try fetching the session endpoint
      const { result } = await Runtime.evaluate({
        expression: `
          (async () => {
            try {
              const resp = await fetch('https://sora.chatgpt.com/api/auth/session', { credentials: 'include' });
              const data = await resp.json();
              return JSON.stringify({ loggedIn: !!data.accessToken, user: data.user?.email || null });
            } catch (e) {
              return JSON.stringify({ loggedIn: false, error: e.message });
            }
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });
      return JSON.parse(result.value);
    } catch (e) {
      diagLog(`Auth check failed: ${e.message}`);
      return { loggedIn: false };
    }
  }

  _resetIdleTimer(profileId) {
    const session = this.sessions.get(profileId);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      diagLog(`Idle timeout reached for profile ${profileId}, closing session`);
      this.closeSession(profileId).catch(() => {});
    }, BROWSER_IDLE_TIMEOUT_MS);
  }

  async closeSession(profileId) {
    const session = this.sessions.get(profileId);
    if (!session) return;

    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(profileId);

    try {
      const browserProcess = session.browserResult?.chromeProcess || session.browserResult?.process;
      if (browserProcess) {
        browserProcess.kill();
      } else if (session.client) {
        await session.Browser.close().catch(() => {});
      }
    } catch (e) {
      diagLog(`Error closing session for ${profileId}: ${e.message}`);
    }
    diagLog(`Session closed for profile ${profileId}`);
  }

  async closeAllSessions() {
    const profileIds = Array.from(this.sessions.keys());
    for (const pid of profileIds) {
      await this.closeSession(pid);
    }
    diagLog("All sessions closed");
  }
}

// ============ SORA IMAGE QUEUE MANAGER ============
class SoraImageQueueManager {
  constructor() {
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = DEFAULT_MAX_CONCURRENT;
    this.schedulerRunning = false;
    this.sessionManager = new BrowserSessionManager();
    this.profileLastRequestTime = new Map(); // profileId -> timestamp of last request start
    this.profileRateLimitLocks = new Map();  // profileId -> Promise (to serialize rate limit checks)
    this.exhaustedProfiles = new Map();       // profileId -> { exhaustedAt, reason }
    this.stoppedWorkflows = new Set();        // workflowIds that have been stopped
    this.activeWorkflowRequests = new Set();  // request objects currently being processed
  }

  /**
   * Check if a workflow has been stopped. Throws if stopped to bail out of active processing.
   */
  _checkAborted(workflowId) {
    if (workflowId !== null && workflowId !== undefined && this.stoppedWorkflows.has(String(workflowId))) {
      throw new Error("Workflow stopped by user");
    }
  }

  async _wait(ms, abortSignal = null) {
    if (!abortSignal) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (abortSignal.aborted) throw new Error("Workflow stopped by user");

    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(new Error("Workflow stopped by user"));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Mark a profile as exhausted (daily limit reached).
   */
  markProfileExhausted(profileId, reason = 'Daily limit reached') {
    diagLog(`Profile ${profileId} marked as EXHAUSTED: ${reason}`);
    this.exhaustedProfiles.set(profileId, {
      exhaustedAt: Date.now(),
      reason,
    });
  }

  /**
   * Check if a profile is exhausted.
   * Profiles are considered exhausted for 24 hours.
   */
  isProfileExhausted(profileId) {
    const entry = this.exhaustedProfiles.get(profileId);
    if (!entry) return false;
    
    // Auto-expire after 24 hours
    const EXHAUSTION_TTL_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - entry.exhaustedAt > EXHAUSTION_TTL_MS) {
      this.exhaustedProfiles.delete(profileId);
      diagLog(`Profile ${profileId} exhaustion expired (24h), now available`);
      return false;
    }
    return true;
  }

  /**
   * Get list of exhausted profile IDs.
   */
  getExhaustedProfiles() {
    const exhausted = [];
    for (const [profileId, entry] of this.exhaustedProfiles.entries()) {
      if (this.isProfileExhausted(profileId)) {
        exhausted.push(profileId);
      }
    }
    return exhausted;
  }

  /**
   * Clear exhaustion status for a profile (e.g., manual reset).
   */
  clearExhaustion(profileId) {
    if (this.exhaustedProfiles.has(profileId)) {
      this.exhaustedProfiles.delete(profileId);
      diagLog(`Profile ${profileId} exhaustion cleared manually`);
    }
  }

  /**
   * Wait for rate limit if needed for a profile.
   * Ensures at least PROFILE_RATE_LIMIT_MS between requests to the same profile.
   * Uses a lock to serialize concurrent requests to the same profile.
   */
  async _waitForProfileRateLimit(profileId, workflowId = null, abortSignal = null) {
    // Wait for any existing lock on this profile
    while (this.profileRateLimitLocks.has(profileId)) {
      await this.profileRateLimitLocks.get(profileId);
      this._checkAborted(workflowId);
    }

    // Create a lock for this profile
    let releaseLock;
    const lockPromise = new Promise((r) => { releaseLock = r; });
    this.profileRateLimitLocks.set(profileId, lockPromise);

    try {
      const lastTime = this.profileLastRequestTime.get(profileId) || 0;
      const elapsed = Date.now() - lastTime;
      const waitMs = PROFILE_RATE_LIMIT_MS - elapsed;
      
      if (waitMs > 0) {
        diagLog(`Rate limit: waiting ${Math.round(waitMs / 1000)}s before next request for profile ${profileId}`);
        await this._wait(waitMs, abortSignal);
      }

      this._checkAborted(workflowId);
      
      // Mark the start time of this request
      this.profileLastRequestTime.set(profileId, Date.now());
    } finally {
      // Release the lock
      this.profileRateLimitLocks.delete(profileId);
      releaseLock();
    }
  }

  /**
   * Load settings - always refresh to pick up user changes.
   */
  async _loadSettings() {
    try {
      const settings = (await readKey("automationSettings")) || {};
      const rawValue = settings.soraMaxConcurrent;
      
      // Parse and validate the value
      let parsedMax;
      if (typeof rawValue === 'number') {
        parsedMax = rawValue;
      } else if (typeof rawValue === 'string') {
        parsedMax = parseInt(rawValue, 10);
      } else {
        parsedMax = NaN;
      }
      
      // Validate range (1-10), fallback to default if invalid
      if (!isNaN(parsedMax) && parsedMax >= 1 && parsedMax <= 10) {
        this.maxConcurrent = parsedMax;
        diagLog(`Using soraMaxConcurrent: ${this.maxConcurrent}`);
      } else {
        diagLog(`Invalid soraMaxConcurrent value (raw=${rawValue}, parsed=${parsedMax}), using default: ${DEFAULT_MAX_CONCURRENT}`);
        this.maxConcurrent = DEFAULT_MAX_CONCURRENT;
      }
    } catch (e) {
      diagLog(`Failed to load settings: ${e.message}, using default: ${DEFAULT_MAX_CONCURRENT}`);
      this.maxConcurrent = DEFAULT_MAX_CONCURRENT;
    }
  }

  /**
   * Get the device ID from browser cookies (oai-did).
   * Falls back to generating a UUID if not found.
   */
  async _getDeviceId(session) {
    try {
      const { result } = await session.Runtime.evaluate({
        expression: `
          (function() {
            const match = document.cookie.match(/oai-did=([^;]+)/);
            return match ? match[1] : null;
          })()
        `,
        returnByValue: true,
      });
      if (result.value) return result.value;
    } catch (_) {}
    // Fallback to a generated UUID
    return crypto.randomUUID();
  }

  /**
   * Get the access token (JWT) from Sora's auth session.
   * This is required for the Authorization: Bearer header.
   */
  async _getAccessToken(session) {
    try {
      const { result } = await session.Runtime.evaluate({
        expression: `
          (async () => {
            try {
              const resp = await fetch('https://sora.chatgpt.com/api/auth/session', { credentials: 'include' });
              const data = await resp.json();
              return data.accessToken || null;
            } catch (e) {
              return null;
            }
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.value) {
        diagLog('Access token retrieved successfully');
        return result.value;
      }
    } catch (e) {
      diagLog(`Failed to get access token: ${e.message}`);
    }
    return null;
  }

  /**
   * Get sentinel token from Sora's security system.
   * This involves calling the sentinel API and solving a proof-of-work challenge.
   * Returns the token object to include in openai-sentinel-token header.
   */
  async _getSentinelToken(session, flow = "sora_create_task") {
    const deviceId = await this._getDeviceId(session);

    // Try to find Sora's internal sentinel generator first
    // Many Next.js apps expose internal functions we can use
    const { result: internalResult } = await session.Runtime.evaluate({
      expression: `
        (async () => {
          try {
            // Check if there's a global sentinel handler we can use
            // Sora may have a __SENTINEL__ or similar global
            if (window.__sentinel_token_generator) {
              const token = await window.__sentinel_token_generator('${flow}');
              return JSON.stringify({ internal: true, token });
            }
            
            // Check for Next.js internal router with auth handling
            if (window.__NEXT_DATA__?.props?.pageProps?.accessToken) {
              // Store for later use
              window.__sora_access_token = window.__NEXT_DATA__.props.pageProps.accessToken;
            }
            
            return JSON.stringify({ internal: false });
          } catch (e) {
            return JSON.stringify({ internal: false, error: e.message });
          }
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const internalData = JSON.parse(internalResult.value);
    if (internalData.internal && internalData.token) {
      diagLog('Using internal sentinel token generator');
      return internalData.token;
    }

    // Step 1: Try Sora's own sentinel endpoint first, fallback to chatgpt.com
    const { result: sentinelResult } = await session.Runtime.evaluate({
      expression: `
        (async () => {
          try {
            const deviceId = ${JSON.stringify(deviceId)};
            const flow = ${JSON.stringify(flow)};
            
            // Generate fingerprint data matching Sora's format
            const fp = [
              3000,
              new Date().toString(),
              (Date.now() % 1000000000),
              Math.floor(Math.random() * 100),
              navigator.userAgent,
              "https://sora-cdn.oaistatic.com/_next/static/chunks/webpack-1a072b0e87eb34d9.js",
              null,
              navigator.language,
              navigator.languages.join(','),
              Math.floor(Math.random() * 100),
              "getInterestGroupAdAuctionData∞function getInterestGroupAdAuctionData() { [native code] }",
              "__reactContainer$" + Math.random().toString(36).substr(2, 11),
              "event",
              performance.now(),
              crypto.randomUUID(),
              "",
              8,
              Date.now(),
              0, 0, 0, 0, 0, 0, 0
            ];
            
            // Encode using Sora's format: gAAAAA + base64 + ~S suffix
            const jsonStr = JSON.stringify(fp);
            const b64 = btoa(unescape(encodeURIComponent(jsonStr)));
            const p = "gAAAAA" + b64.replace(/=/g, '') + "~S";
            
            // Try multiple sentinel endpoints
            const endpoints = [
              '/backend-api/sentinel/req',           // Sora's own endpoint (same origin)
              'https://sora.chatgpt.com/backend-api/sentinel/req',
              'https://chatgpt.com/backend-api/sentinel/req'
            ];
            
            let sentinelData = null;
            let lastError = null;
            
            for (const endpoint of endpoints) {
              try {
                const resp = await fetch(endpoint, {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'text/plain;charset=UTF-8'
                  },
                  credentials: 'include',
                  body: JSON.stringify({ p, id: deviceId, flow })
                });
                
                if (resp.ok) {
                  sentinelData = await resp.json();
                  console.log('[Sora] Sentinel endpoint success:', endpoint);
                  break;
                } else {
                  lastError = endpoint + ' returned ' + resp.status;
                }
              } catch (e) {
                lastError = endpoint + ': ' + e.message;
              }
            }
            
            if (!sentinelData) {
              return JSON.stringify({ error: true, message: 'All sentinel endpoints failed: ' + lastError });
            }
            
            // If proof-of-work is required, solve it
            let pow = "";
            if (sentinelData.proofofwork?.required && sentinelData.proofofwork.seed && sentinelData.proofofwork.difficulty) {
              const seed = sentinelData.proofofwork.seed;
              const diff = parseInt(sentinelData.proofofwork.difficulty, 16);
              const encoder = new TextEncoder();
              
              // Find valid nonce
              for (let nonce = 0; nonce < 5000000; nonce++) {
                const input = seed + "." + nonce;
                const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
                const hash = new Uint8Array(hashBuf);
                const val = (hash[0] << 16) | (hash[1] << 8) | hash[2];
                if (val < diff) {
                  // Encode proof string - format is base64 of answer data
                  const proofData = {
                    a: input,
                    n: nonce,
                    h: Array.from(hash.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')
                  };
                  pow = btoa(JSON.stringify(proofData));
                  console.log('[Sora] PoW solved at nonce', nonce);
                  break;
                }
              }
            }
            
            return JSON.stringify({
              success: true,
              sentinelToken: {
                p: p,
                t: pow,
                c: sentinelData.token,
                id: deviceId,
                flow: flow
              },
              turnstileRequired: !!sentinelData.turnstile?.required
            });
          } catch (e) {
            return JSON.stringify({ error: true, message: e.message, stack: e.stack?.substring(0, 200) });
          }
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const sentinelData = JSON.parse(sentinelResult.value);
    if (sentinelData.error) {
      diagLog(`Sentinel request error: ${JSON.stringify(sentinelData)}`);
      // Return null - we'll try without sentinel token (may fail)
      return null;
    }

    if (sentinelData.success && sentinelData.sentinelToken) {
      diagLog(`Sentinel token generated. Turnstile required: ${sentinelData.turnstileRequired}`);
      return sentinelData.sentinelToken;
    }

    diagLog(`Sentinel generation failed: ${JSON.stringify(sentinelData)}`);
    return null;
  }

  /**
   * Upload a reference image to Sora's backend with retry logic for rate limits.
   * Reads the local file, base64-encodes it, and uploads via the browser context.
   * Includes sentinel token for security.
   * Returns the upload_media_id.
   * @param {Object} session - Browser session
   * @param {string} imagePath - Path to local image file
   * @param {string} accessToken - Bearer token for authorization
   */
  async uploadImage(session, imagePath, accessToken, workflowId = null, abortSignal = null) {
    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }

    const fileBuffer = fs.readFileSync(imagePath);
    const base64Data = fileBuffer.toString("base64");
    const ext = path.extname(imagePath).toLowerCase().replace(".", "") || "png";
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
      : "image/png";
    const fileName = path.basename(imagePath);

    diagLog(`Uploading reference image: ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB, ${mimeType})`);

    let lastError = null;
    let backoffMs = UPLOAD_INITIAL_BACKOFF_MS;

    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      this._checkAborted(workflowId);

      // Get fresh sentinel token for each attempt (they may expire)
      const sentinelToken = await this._getSentinelToken(session, "sora_create_task");
      const sentinelHeader = sentinelToken ? JSON.stringify(sentinelToken) : "";
      const deviceId = sentinelToken?.id || await this._getDeviceId(session);

      const { result } = await session.Runtime.evaluate({
        expression: `
          (async () => {
            try {
              const base64 = ${JSON.stringify(base64Data)};
              const binaryStr = atob(base64);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
              const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });

              const formData = new FormData();
              formData.append('file', blob, ${JSON.stringify(fileName)});
              formData.append('file_name', ${JSON.stringify(fileName)});

              const headers = {
                'authorization': 'Bearer ' + ${JSON.stringify(accessToken)},
                'oai-device-id': ${JSON.stringify(deviceId)},
                'oai-language': navigator.language || 'en-US'
              };
              
              // Add sentinel token if available
              const sentinelHeader = ${JSON.stringify(sentinelHeader)};
              if (sentinelHeader) {
                headers['openai-sentinel-token'] = sentinelHeader;
              }

              const resp = await fetch('/backend/uploads', {
                method: 'POST',
                headers: headers,
                credentials: 'include',
                body: formData
              });
              
              // Include retry-after header in response for rate limit handling
              const retryAfter = resp.headers.get('retry-after');
              
              if (!resp.ok) {
                const text = await resp.text();
                return JSON.stringify({ error: true, status: resp.status, body: text, retryAfter: retryAfter });
              }
              const data = await resp.json();
              return JSON.stringify(data);
            } catch (e) {
              return JSON.stringify({ error: true, message: e.message });
            }
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });

      const data = JSON.parse(result.value);
      
      if (!data.error && data.id) {
        diagLog(`Image uploaded: ${data.id} (${data.width}x${data.height})`);
        return data.id;
      }

      // Check if it's a rate limit error (429)
      if (data.status === 429) {
        // Parse the error body to check for daily quota limit
        let errorBody = {};
        try {
          errorBody = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
        } catch (_) {}

        // Daily quota limit - do NOT retry, mark profile as exhausted
        if (errorBody?.error?.code === 'too_many_daily_tasks') {
          const dailyLimit = errorBody?.error?.details?.num_tasks || 50;
          this.markProfileExhausted(session.profileId, `Daily limit reached (${dailyLimit}/24h)`);
          const err = new Error(`DAILY_LIMIT_REACHED:${session.profileId}:${dailyLimit}`);
          err.isDailyLimit = true;
          err.profileId = session.profileId;
          err.dailyLimit = dailyLimit;
          throw err;
        }

        // Parse retry-after header if present (could be seconds or a date)
        let waitMs = backoffMs;
        if (data.retryAfter) {
          const retryAfterSec = parseInt(data.retryAfter, 10);
          if (!isNaN(retryAfterSec)) {
            waitMs = Math.max(retryAfterSec * 1000, backoffMs);
          }
        }

        if (attempt < UPLOAD_MAX_RETRIES) {
          diagLog(`Upload rate limited (429), attempt ${attempt}/${UPLOAD_MAX_RETRIES}. Waiting ${Math.round(waitMs / 1000)}s before retry...`);
          await this._wait(waitMs, abortSignal);
          // Exponential backoff: double the wait time for next attempt, max 60s
          backoffMs = Math.min(backoffMs * 2, 60000);
          continue;
        }
      }

      // Non-retryable error or max retries reached
      lastError = `Sora image upload failed: ${data.status || ""} ${data.body || data.message || "Unknown error"}`;
      
      // For non-429 errors, don't retry
      if (data.status && data.status !== 429) {
        throw new Error(lastError);
      }
    }

    throw new Error(lastError || "Sora image upload failed after max retries");
  }

  /**
   * Submit a Sora image task from within the browser context with retry logic.
   * Gets sentinel token first, then makes the video_gen request.
   * When uploadMediaId is provided, uses "remix" operation instead of "simple_compose".
   * @param {Object} session - Browser session
   * @param {string} prompt - Generation prompt
   * @param {number} nVariants - Number of images to generate
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @param {string} uploadMediaId - Optional media ID for remix mode
   * @param {string} accessToken - Bearer token for authorization
   */
  async submitTask(session, prompt, nVariants, width, height, uploadMediaId = null, accessToken, workflowId = null, abortSignal = null) {
    const isRemix = !!uploadMediaId;
    const inpaintItems = isRemix
      ? [{
          type: "image",
          frame_index: 0,
          preset_id: null,
          generation_id: null,
          upload_media_id: uploadMediaId,
          uploaded_file_id: null,
          source_start_frame: 0,
          source_end_frame: 0,
          crop_bounds: null,
          cameo_file_id: null,
        }]
      : [];

    const payloadObj = {
      type: "image_gen",
      operation: isRemix ? "remix" : "simple_compose",
      prompt,
      n_variants: nVariants,
      width,
      height,
      n_frames: 1,
      inpaint_items: inpaintItems,
      ...(isRemix ? { model: "turbo", is_storyboard: false } : {}),
    };
    const payload = JSON.stringify(payloadObj);

    let lastError = null;
    let backoffMs = UPLOAD_INITIAL_BACKOFF_MS;

    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      this._checkAborted(workflowId);

      // Get sentinel token for this request
      const sentinelToken = await this._getSentinelToken(session, "sora_create_task");
      const sentinelHeader = sentinelToken ? JSON.stringify(sentinelToken) : "";
      const deviceId = sentinelToken?.id || await this._getDeviceId(session);

      const { result } = await session.Runtime.evaluate({
        expression: `
          (async () => {
            try {
              const headers = {
                'Content-Type': 'application/json',
                'authorization': 'Bearer ' + ${JSON.stringify(accessToken)},
                'oai-device-id': ${JSON.stringify(deviceId)},
                'oai-language': navigator.language || 'en-US'
              };
              
              // Add sentinel token if available
              const sentinelHeader = ${JSON.stringify(sentinelHeader)};
              if (sentinelHeader) {
                headers['openai-sentinel-token'] = sentinelHeader;
              }
              
              const resp = await fetch('/backend/video_gen', {
                method: 'POST',
                headers: headers,
                credentials: 'include',
                body: ${JSON.stringify(payload)}
              });
              
              const retryAfter = resp.headers.get('retry-after');
              
              if (!resp.ok) {
                const text = await resp.text();
                return JSON.stringify({ error: true, status: resp.status, body: text, retryAfter: retryAfter });
              }
              const data = await resp.json();
              return JSON.stringify(data);
            } catch (e) {
              return JSON.stringify({ error: true, message: e.message });
            }
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });

      const data = JSON.parse(result.value);
      
      if (!data.error && data.id) {
        diagLog(`Task submitted: ${data.id} (${isRemix ? "remix" : "simple_compose"}, prompt: "${prompt.substring(0, 50)}...")`);
        return data.id;
      }

      // Check if it's a rate limit error (429)
      if (data.status === 429) {
        // Parse the error body to check for daily quota limit
        let errorBody = {};
        try {
          errorBody = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
        } catch (_) {}

        // Daily quota limit - do NOT retry, mark profile as exhausted
        if (errorBody?.error?.code === 'too_many_daily_tasks') {
          const dailyLimit = errorBody?.error?.details?.num_tasks || 50;
          this.markProfileExhausted(session.profileId, `Daily limit reached (${dailyLimit}/24h)`);
          const err = new Error(`DAILY_LIMIT_REACHED:${session.profileId}:${dailyLimit}`);
          err.isDailyLimit = true;
          err.profileId = session.profileId;
          err.dailyLimit = dailyLimit;
          throw err;
        }

        let waitMs = backoffMs;
        if (data.retryAfter) {
          const retryAfterSec = parseInt(data.retryAfter, 10);
          if (!isNaN(retryAfterSec)) {
            waitMs = Math.max(retryAfterSec * 1000, backoffMs);
          }
        }

        if (attempt < UPLOAD_MAX_RETRIES) {
          diagLog(`Task submit rate limited (429), attempt ${attempt}/${UPLOAD_MAX_RETRIES}. Waiting ${Math.round(waitMs / 1000)}s before retry...`);
          await this._wait(waitMs, abortSignal);
          backoffMs = Math.min(backoffMs * 2, 60000);
          continue;
        }
      }

      lastError = `Sora task submission failed: ${data.status || ""} ${data.body || data.message || "Unknown error"}`;
      
      if (data.status && data.status !== 429) {
        throw new Error(lastError);
      }
    }

    throw new Error(lastError || "Sora task submission failed after max retries");
  }

  /**
   * Poll task status until succeeded or failed.
   * Requires access token for authorization.
   */
  async pollTask(session, taskId, timeoutMs, accessToken, workflowId = null, abortSignal = null) {
    const start = Date.now();
    const maxAttempts = Math.ceil(timeoutMs / POLL_INTERVAL_MS);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Sora task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }

      // Check if workflow was stopped during polling
      this._checkAborted(workflowId);

      // Reset idle timer to keep session alive during polling
      this.sessionManager._resetIdleTimer(session.profileId);

      await this._wait(POLL_INTERVAL_MS, abortSignal);

      try {
        const { result } = await session.Runtime.evaluate({
          expression: `
            (async () => {
              try {
                const resp = await fetch('/backend/v2/recent_tasks?limit=5', {
                  credentials: 'include',
                  headers: {
                    'authorization': 'Bearer ' + ${JSON.stringify(accessToken)}
                  }
                });
                if (!resp.ok) return JSON.stringify({ pollError: true, status: resp.status });
                const data = await resp.json();
                return JSON.stringify(data);
              } catch (e) {
                return JSON.stringify({ pollError: true, message: e.message });
              }
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });

        const data = JSON.parse(result.value);
        if (data.pollError) {
          diagLog(`Poll error for ${taskId}: ${data.status || data.message}`);
          continue;
        }

        const task = (data.task_responses || []).find((t) => t.id === taskId);
        if (!task) {
          diagLog(`Task ${taskId} not found in recent_tasks (attempt ${attempt + 1}), retrying...`);
          continue;
        }

        if (task.status === "succeeded") {
          diagLog(`Task ${taskId} succeeded with ${(task.generations || []).length} generation(s)`);
          return task;
        }

        if (task.status === "failed") {
          const reason = task.failure_reason || "Unknown failure";
          throw new Error(`Sora task ${taskId} failed: ${reason}`);
        }

        // Still running
        const pct = task.progress_pct ? `${Math.round(task.progress_pct * 100)}%` : "?";
        if (attempt % 5 === 0) {
          diagLog(`Task ${taskId} status: ${task.status}, progress: ${pct}`);
        }
      } catch (e) {
        if (e.message.includes("failed:") || e.message.includes("timed out")) throw e;
        diagLog(`Poll iteration error for ${taskId}: ${e.message}`);
      }
    }

    throw new Error(`Sora task ${taskId} timed out after ${maxAttempts} poll attempts`);
  }

  /**
   * Download images from completed task generations.
   * Returns array of permanent file paths.
   */
  async downloadImages(generations, workflowId = null, prompt = null) {
    const urls = [];

    for (const gen of generations) {
      // Prefer the source encoding URL (higher quality), fall back to the main URL
      const url =
        gen.encodings?.source?.path ||
        gen.url ||
        gen.encodings?.thumbnail?.path;

      if (url) {
        urls.push(url);
      } else {
        diagLog(`Generation ${gen.id} has no downloadable URL, skipping`);
      }
    }

    if (urls.length === 0) {
      throw new Error("No downloadable images found in Sora task result");
    }

    // Check if AI image cleaning is enabled
    const automationSettings = await readKey('automationSettings') || {};
    const cleanAI = automationSettings.aiImageCleaning !== false; // Default true
    
    // Get image metadata settings for fake EXIF injection
    const imageMetadataSettings = await readKey('imageMetadataSettings') || {};

    // Download each image and save to permanent storage
    const permanentPaths = [];
    for (const url of urls) {
      this._checkAborted(workflowId);

      try {
        const response = await fetch(url, { timeout: 60000 });
        if (!response.ok) {
          diagLog(`Failed to download image: HTTP ${response.status} for ${url.substring(0, 80)}`);
          continue;
        }

        const buffer = await response.buffer();
        const ext = url.includes(".webp") ? "webp" : url.includes(".png") ? "png" : "webp";
        const tempName = `sora_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
        const tempDir = path.join(app.getPath("userData"), "Uploads", "Temp");
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, tempName);
        fs.writeFileSync(tempPath, buffer);

        // Clean AI metadata if enabled (defeats Pinterest AI detection)
        // Also pass metadata settings for fake EXIF injection
        // Also pass nodeType for SEO metadata generation if enabled
        const moveResult = await moveToPermStorage(tempPath, { 
          cleanAI,
          injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
          nodeType: 'soraimage',
          workflowId,
          prompt
        });
        if (moveResult.success) {
          permanentPaths.push(moveResult.permanentPath);
          diagLog(`Image saved: ${moveResult.permanentPath}`);
        } else {
          diagLog(`Failed to move to perm storage: ${moveResult.error}`);
        }

        // Cleanup temp
        try { fs.unlinkSync(tempPath); } catch (_) {}
      } catch (e) {
        diagLog(`Error downloading image from ${url.substring(0, 80)}: ${e.message}`);
      }
    }

    if (permanentPaths.length === 0) {
      throw new Error("All image downloads failed");
    }

    return permanentPaths;
  }

  /**
   * Process a single queued request end-to-end.
   */
  async processRequest(request) {
    const { prompt, nVariants, width, height, profileId, timeoutMs, imagePath, workflowId, abortController } = request;
    const abortSignal = abortController.signal;

    // Check if already stopped before starting
    this._checkAborted(workflowId);

    // Get or create browser session
    const session = await this.sessionManager.getSession(profileId);

    if (abortSignal.aborted || this.stoppedWorkflows.has(String(workflowId))) {
      const usedByAnotherWorkflow = Array.from(this.activeWorkflowRequests).some(
        (activeRequest) => activeRequest !== request &&
          activeRequest.profileId === profileId &&
          String(activeRequest.workflowId) !== String(workflowId)
      );
      if (!usedByAnotherWorkflow) {
        await this.sessionManager.closeSession(profileId);
      }
      throw new Error("Workflow stopped by user");
    }

    // Get access token once for all requests in this process
    const accessToken = await this._getAccessToken(session);
    if (!accessToken) {
      throw new Error("Failed to get access token. Please re-connect the OpenAI profile in Settings.");
    }

    this._checkAborted(workflowId);

    // Upload reference image if provided (with rate limiting)
    let uploadMediaId = null;
    if (imagePath) {
      // Rate limit BEFORE upload
      await this._waitForProfileRateLimit(profileId, workflowId, abortSignal);
      this._checkAborted(workflowId);
      uploadMediaId = await this.uploadImage(session, imagePath, accessToken, workflowId, abortSignal);
    }

    this._checkAborted(workflowId);

    // Rate limit BEFORE task submission
    await this._waitForProfileRateLimit(profileId, workflowId, abortSignal);
    
    this._checkAborted(workflowId);

    // Submit the task
    const taskId = await this.submitTask(session, prompt, nVariants, width, height, uploadMediaId, accessToken, workflowId, abortSignal);

    this._checkAborted(workflowId);

    // Poll until completed (pass access token for auth)
    const completedTask = await this.pollTask(session, taskId, timeoutMs, accessToken, workflowId, abortSignal);

    this._checkAborted(workflowId);

    // Check moderation
    if (completedTask.moderation_result?.type !== "passed") {
      throw new Error(
        `Sora content moderation blocked generation: ${completedTask.moderation_result?.code || "policy_violation"}`
      );
    }

    // Download images from generations
    const generations = completedTask.generations || [];
    if (generations.length === 0) {
      throw new Error("Sora task succeeded but returned no generations");
    }

    const imagePaths = await this.downloadImages(generations, workflowId, prompt);
    return imagePaths;
  }

  /**
   * Main scheduler loop — dispatches requests up to maxConcurrent.
   * Dispatches initial batch immediately, then adds delays between subsequent dispatches.
   */
  async runScheduler() {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;

    // Always reload settings at scheduler start
    await this._loadSettings();
    diagLog(`Scheduler started with maxConcurrent: ${this.maxConcurrent}`);

    let initialBatchDispatched = 0;

    while (this.queue.length > 0) {
      if (this.activeRequests >= this.maxConcurrent) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const request = this.queue.shift();
      if (!request) break;

      this.activeRequests++;
      this.activeWorkflowRequests.add(request);
      initialBatchDispatched++;

      diagLog(`Dispatching request ${initialBatchDispatched} (active: ${this.activeRequests}/${this.maxConcurrent}, queue: ${this.queue.length})`);

      this.processRequest(request)
        .then((result) => request.resolve(result))
        .catch((error) => request.reject(
          request.abortController.signal.aborted
            ? new Error("Workflow stopped by user")
            : error
        ))
        .finally(() => {
          this.activeRequests--;
          this.activeWorkflowRequests.delete(request);
        });

      // Only add delay after initial batch is dispatched to avoid rate limits on subsequent requests
      if (initialBatchDispatched >= this.maxConcurrent && this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      }
    }

    this.schedulerRunning = false;
    diagLog(`Scheduler finished (dispatched: ${initialBatchDispatched})`);
  }

  /**
   * Enqueue a Sora image generation request.
   * Returns Promise<string[]> (array of permanent image file paths).
   */
  enqueue(prompt, nVariants, width, height, profileId, timeoutMs, imagePath = null, workflowId = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        prompt,
        nVariants,
        width,
        height,
        profileId,
        timeoutMs,
        imagePath,
        workflowId,
        abortController: new AbortController(),
        resolve,
        reject,
        createdAt: Date.now(),
      });

      diagLog(`Enqueued request (queue: ${this.queue.length}, active: ${this.activeRequests}, maxConcurrent: ${this.maxConcurrent})`);

      if (!this.schedulerRunning) {
        setImmediate(() => this.runScheduler());
      }
    });
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      maxConcurrent: this.maxConcurrent,
      activeSessions: this.sessionManager.sessions.size,
    };
  }

  /**
   * Stop all pending and active requests for a workflow (called when workflow is stopped).
   */
  stopWorkflowQueues(workflowId) {
    const workflowIdString = String(workflowId);

    // Mark workflow as stopped so active requests will bail out
    this.stoppedWorkflows.add(workflowIdString);

    // Remove pending requests for this workflow from queue
    const remaining = [];
    let rejected = 0;
    while (this.queue.length > 0) {
      const req = this.queue.shift();
      if (String(req.workflowId) === workflowIdString) {
        req.abortController.abort();
        req.reject(new Error("Workflow stopped by user"));
        rejected++;
      } else {
        remaining.push(req);
      }
    }
    // Re-add requests from other workflows
    this.queue.push(...remaining);

    const affectedProfiles = new Set();
    for (const request of this.activeWorkflowRequests) {
      if (String(request.workflowId) === workflowIdString) {
        request.abortController.abort();
        affectedProfiles.add(request.profileId);
      }
    }

    for (const profileId of affectedProfiles) {
      const usedByAnotherWorkflow = Array.from(this.activeWorkflowRequests).some(
        (request) => request.profileId === profileId && String(request.workflowId) !== workflowIdString
      );
      if (!usedByAnotherWorkflow) {
        this.sessionManager.closeSession(profileId).catch(() => {});
      }
    }

    diagLog(`Stop requested for workflow ${workflowId} — rejected ${rejected} pending, ${this.activeRequests} active requests will be aborted`);

    // Auto-clear the stopped flag after 5 minutes (safety net)
    setTimeout(() => {
      this.stoppedWorkflows.delete(workflowIdString);
    }, 5 * 60 * 1000);
  }

  clearWorkflowStateForRerun(workflowId) {
    diagLog(`Clearing state for rerun of workflow: ${workflowId}`);
    // Clear the stopped flag so the workflow can run again
    this.stoppedWorkflows.delete(String(workflowId));
  }

  async closeAllSessions() {
    await this.sessionManager.closeAllSessions();
  }
}

const queueManager = new SoraImageQueueManager();

// ============ PUBLIC API ============

/**
 * Sora Image Generation with Queue
 *
 * @param {string} prompt - The image generation prompt
 * @param {number} nVariants - Number of image variants to generate (1-4)
 * @param {string} size - Size string like "480x720", "720x480", "720x720", "1024x1024"
 * @param {string} profileId - OpenAI browser profile ID to use
 * @param {string|null} imagePath - Optional reference image path for remix mode
 * @returns {{ success: boolean, value: string[]|string }} Array of image paths on success
 */
async function soraImage(prompt, nVariants = 1, size = "480x720", profileId = null, imagePath = null, workflowId = null) {
  if (!prompt) return { success: false, value: "Prompt is required" };

  if (!profileId) {
    return { success: false, value: "No OpenAI browser profile specified. Please connect an OpenAI profile in Settings." };
  }

  // Check if profile is already exhausted (daily limit) - fail fast
  if (queueManager.isProfileExhausted(profileId)) {
    const entry = queueManager.exhaustedProfiles.get(profileId);
    diagLog(`Profile ${profileId} is exhausted, failing fast: ${entry?.reason}`);
    return { success: false, value: `DAILY_LIMIT_REACHED:${profileId}:50` };
  }

  // Parse size
  const dims = SIZE_MAP[size];
  if (!dims) {
    return { success: false, value: `Invalid size: ${size}. Use one of: ${Object.keys(SIZE_MAP).join(", ")}` };
  }

  // Get timeout from settings
  let timeoutMs;
  try {
    const settings = (await readKey("automationSettings")) || {};
    timeoutMs = (settings.soraTimeout || DEFAULT_TIMEOUT_S) * 1000;
  } catch (_) {
    timeoutMs = DEFAULT_TIMEOUT_S * 1000;
  }

  nVariants = Math.max(1, Math.min(4, nVariants));

  try {
    // Resolve image path if it's an array (take first element)
    let resolvedImagePath = imagePath;
    if (Array.isArray(resolvedImagePath)) {
      resolvedImagePath = resolvedImagePath[0] || null;
    }
    if (resolvedImagePath) {
      diagLog(`Reference image provided: ${resolvedImagePath} (remix mode)`);
    }

    const imagePaths = await queueManager.enqueue(
      prompt,
      nVariants,
      dims.width,
      dims.height,
      profileId,
      timeoutMs,
      resolvedImagePath,
      workflowId
    );

    diagLog(`Generation complete: ${imagePaths.length} image(s)`);
    return { success: true, value: imagePaths };
  } catch (error) {
    diagLog(`Generation failed: ${error.message}`);
    return { success: false, value: `Sora Image failed: ${error.message}` };
  }
}

function getSoraImageQueueStats() {
  return queueManager.getStats();
}

function stopWorkflowQueues(workflowId) {
  queueManager.stopWorkflowQueues(workflowId);
}

function clearWorkflowStateForRerun(workflowId) {
  queueManager.clearWorkflowStateForRerun(workflowId);
}

async function closeAllSessions() {
  await queueManager.closeAllSessions();
}

/**
 * Check if a profile has hit its daily limit.
 */
function isProfileExhausted(profileId) {
  return queueManager.isProfileExhausted(profileId);
}

/**
 * Get list of all exhausted profile IDs.
 */
function getExhaustedProfiles() {
  return queueManager.getExhaustedProfiles();
}

/**
 * Clear exhaustion status for a profile.
 */
function clearProfileExhaustion(profileId) {
  queueManager.clearExhaustion(profileId);
}

module.exports = {
  soraImage,
  getSoraImageQueueStats,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
  closeAllSessions,
  isProfileExhausted,
  getExhaustedProfiles,
  clearProfileExhaustion,
};
