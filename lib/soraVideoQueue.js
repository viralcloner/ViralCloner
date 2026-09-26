/**
 * Sora Video Queue Manager
 *
 * Handles OpenAI Videos API (/v1/videos) with key rotation,
 * rate limiting, concurrency control, and progress polling.
 */

const fetch = require("node-fetch");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const { readKey, trackAIUsage } = require("./utils");

const POLL_INTERVAL = 10000; // 10 seconds between status polls
const DEFAULT_TIMEOUT = 600000; // 10 minutes default

/**
 * Per-key state for rate limit tracking
 */
class KeyState {
  constructor(apiKey, label) {
    this.apiKey = apiKey;
    this.label = label;
    this.inFlightRequests = 0;
    this.errorCooldownUntil = 0;
    this.requestsRemaining = 100;
    this.requestResetTime = 0;
  }

  updateFromHeaders(headers) {
    if (headers["x-ratelimit-remaining-requests"]) {
      this.requestsRemaining = parseInt(headers["x-ratelimit-remaining-requests"]);
    }
    if (headers["x-ratelimit-reset-requests"]) {
      const resetSec = parseFloat(headers["x-ratelimit-reset-requests"]) || 0;
      this.requestResetTime = Date.now() + resetSec * 1000;
    }
    this.errorCooldownUntil = 0;
  }

  markRateLimited(retryMs) {
    this.errorCooldownUntil = Date.now() + retryMs;
    this.requestsRemaining = 0;
  }

  isAvailable() {
    const now = Date.now();
    if (this.errorCooldownUntil > now) return false;
    if (this.requestsRemaining < 1 && this.requestResetTime > now) return false;
    return true;
  }

  getWaitTime() {
    const now = Date.now();
    let wait = 0;
    if (this.errorCooldownUntil > now) wait = Math.max(wait, this.errorCooldownUntil - now);
    if (this.requestsRemaining < 1) wait = Math.max(wait, this.requestResetTime - now);
    return Math.max(0, wait);
  }
}

class SoraVideoQueueManager {
  constructor() {
    this.keys = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = 2;
    this.schedulerRunning = false;
    this.lastKeysRefresh = 0;
    this.cachedKeys = null;
    this.settingsLoaded = false;
  }

  async loadSettings() {
    if (this.settingsLoaded) return;
    try {
      const automationSettings = (await readKey("automationSettings")) || {};
      this.maxConcurrent = automationSettings.soraVideoMaxConcurrent || 2;
      console.log(`[Sora Video Queue] Max concurrent: ${this.maxConcurrent}`);
      this.settingsLoaded = true;
    } catch (error) {
      console.error("[Sora Video Queue] Error loading settings:", error.message);
    }
  }

  async getKeys() {
    const now = Date.now();
    if (this.cachedKeys && now - this.lastKeysRefresh < 10000) {
      return this.cachedKeys;
    }

    const openaiKeys = (await readKey("openaiKeys")) || {};

    // Sync keys map
    for (const apiKey of this.keys.keys()) {
      if (!openaiKeys[apiKey]) this.keys.delete(apiKey);
    }
    for (const [apiKey, keyData] of Object.entries(openaiKeys)) {
      if (!this.keys.has(apiKey)) {
        const label = typeof keyData === "object" ? keyData.label : keyData;
        this.keys.set(apiKey, new KeyState(apiKey, label));
      }
    }

    this.lastKeysRefresh = now;
    this.cachedKeys = this.keys;
    return this.keys;
  }

  async findAvailableKey() {
    const keys = await this.getKeys();
    if (keys.size === 0) return { key: null, state: null, waitMs: 0 };

    let bestKey = null;
    let bestState = null;
    let minWait = Infinity;

    for (const [apiKey, state] of keys) {
      if (state.isAvailable() && state.inFlightRequests < 2) {
        if (!bestState || state.inFlightRequests < bestState.inFlightRequests) {
          bestKey = apiKey;
          bestState = state;
        }
      } else {
        minWait = Math.min(minWait, state.getWaitTime());
      }
    }

    return {
      key: bestKey,
      state: bestState,
      waitMs: bestKey ? 0 : Math.max(500, Math.min(minWait, 10000)),
    };
  }

  /**
   * Create a video generation job
   */
  async createVideoJob(apiKey, prompt, model, size, seconds, imagePath) {
    const hasImage = imagePath && fs.existsSync(imagePath);

    if (hasImage) {
      // Multipart form-data with image reference
      const boundary = `----SoraVideo${crypto.randomBytes(16).toString("hex")}`;
      const imageBuffer = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
      const mimeType = mimeMap[ext] || "image/jpeg";
      const fileName = path.basename(imagePath);

      const parts = [];
      // Text fields
      for (const [field, val] of [["prompt", prompt], ["model", model], ["size", size], ["seconds", seconds]]) {
        parts.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${val}\r\n`
        );
      }
      // File field
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="input_reference"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      );

      const bodyBuffers = [
        ...parts.slice(0, -1).map((p) => Buffer.from(p)),
        Buffer.from(parts[parts.length - 1]),
        imageBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ];
      const body = Buffer.concat(bodyBuffers);

      const response = await fetch("https://api.openai.com/v1/videos", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length.toString(),
        },
        body,
      });

      return { response };
    } else {
      // JSON body (no image)
      const response = await fetch("https://api.openai.com/v1/videos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ prompt, model, size, seconds }),
      });

      return { response };
    }
  }

  /**
   * Poll video status until completed or failed
   */
  async pollVideoStatus(apiKey, videoId, timeoutMs, onProgress) {
    const startTime = Date.now();

    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Video generation timed out after ${Math.round(timeoutMs / 1000)}s`);
      }

      const response = await fetch(`https://api.openai.com/v1/videos/${videoId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Poll error: ${response.status} - ${JSON.stringify(err)}`);
      }

      const video = await response.json();

      if (onProgress) {
        onProgress({
          status: video.status,
          progress: video.progress || 0,
        });
      }

      if (video.status === "completed") {
        return video;
      }
      if (video.status === "failed") {
        const errMsg = video.error?.message || video.error?.code || "Unknown error";
        throw new Error(`Video generation failed: ${errMsg}`);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }

  /**
   * Download completed video MP4
   */
  async downloadVideo(apiKey, videoId) {
    const response = await fetch(
      `https://api.openai.com/v1/videos/${videoId}/content`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save to temp directory
    const tempDir = path.join(app.getPath("userData"), "Uploads", "Temp");
    await fsPromises.mkdir(tempDir, { recursive: true });
    const fileName = `soravideo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`;
    const filePath = path.join(tempDir, fileName);
    await fsPromises.writeFile(filePath, buffer);

    console.log(`[Sora Video Queue] Downloaded video: ${filePath} (${Math.round(buffer.length / 1024)}KB)`);
    return filePath;
  }

  /**
   * Delete video from OpenAI storage
   */
  async deleteRemoteVideo(apiKey, videoId) {
    try {
      await fetch(`https://api.openai.com/v1/videos/${videoId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      console.log(`[Sora Video Queue] Deleted remote video: ${videoId}`);
    } catch (err) {
      console.warn(`[Sora Video Queue] Failed to delete remote video ${videoId}: ${err.message}`);
    }
  }

  /**
   * Execute a single video generation request end-to-end
   */
  async executeOne(request) {
    const { prompt, model, size, seconds, imagePath, timeout, onProgress } = request;
    const { key, state } = await this.findAvailableKey();

    if (!key || !state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;

    try {
      // Step 1: Create video job
      if (onProgress) onProgress({ status: "creating", progress: 0 });

      const { response } = await this.createVideoJob(key, prompt, model, size, seconds, imagePath);

      const headers = {};
      response.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      if (response.status === 429) {
        const retryMs = headers["retry-after"]
          ? parseInt(headers["retry-after"]) * 1000
          : 30000;
        state.markRateLimited(retryMs);
        throw new Error(`RATE_LIMITED:${retryMs}`);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const errMsg = err.error?.message || JSON.stringify(err);
        throw new Error(`Sora Video API error: ${response.status} - ${errMsg}`);
      }

      state.updateFromHeaders(headers);
      const videoJob = await response.json();
      const videoId = videoJob.id;

      console.log(`[Sora Video Queue] Job created: ${videoId} (model=${model}, size=${size}, seconds=${seconds})`);

      // Step 2: Poll until completion
      if (onProgress) onProgress({ status: "queued", progress: 0 });

      const completedVideo = await this.pollVideoStatus(key, videoId, timeout, onProgress);

      // Step 3: Download MP4
      if (onProgress) onProgress({ status: "downloading", progress: 100 });

      const filePath = await this.downloadVideo(key, videoId);

      // Step 4: Cleanup remote storage
      await this.deleteRemoteVideo(key, videoId);

      // Track usage
      trackAIUsage("openai", model, { total_tokens: 0 }, "video").catch(() => {});

      return { filePath, video: completedVideo };
    } catch (error) {
      throw error;
    } finally {
      state.inFlightRequests--;
    }
  }

  /**
   * Process one request with retry for rate limits
   */
  async processRequest(request) {
    const startTime = Date.now();
    const maxRetries = 10;
    let retries = 0;
    const queueTimeoutMs = Math.max(request.timeout * 2, 600000); // At least 10 min

    while (true) {
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > queueTimeoutMs) {
        throw new Error(`Sora Video Queue: Timeout waiting for available API key (waited ${Math.round(elapsedMs / 1000)}s)`);
      }

      try {
        return await this.executeOne(request);
      } catch (error) {
        if (error.message === "NO_KEY_AVAILABLE") {
          const baseWait = Math.min(2000 * Math.pow(1.5, Math.floor(elapsedMs / 30000)), 15000);
          const jitter = Math.random() * 1000;
          await new Promise((r) => setTimeout(r, baseWait + jitter));
          continue;
        }
        if (error.message.startsWith("RATE_LIMITED:")) {
          retries++;
          if (retries >= maxRetries) {
            throw new Error(`Sora Video Queue: Max retries exceeded (${retries} rate limit errors)`);
          }
          const waitMs = parseInt(error.message.split(":")[1]);
          console.log(`[Sora Video Queue] Rate limited, waiting ${waitMs}ms (retry ${retries}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw error;
      }
    }
  }

  async runScheduler() {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;

    await this.loadSettings();

    while (this.queue.length > 0) {
      if (this.activeRequests >= this.maxConcurrent) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const request = this.queue.shift();
      if (!request) break;

      this.activeRequests++;

      this.processRequest(request)
        .then((result) => request.resolve(result))
        .catch((error) => request.reject(error))
        .finally(() => {
          this.activeRequests--;
        });

      // Longer delay between dispatches (video gen is expensive)
      await new Promise((r) => setTimeout(r, 200));
    }

    this.schedulerRunning = false;
  }

  /**
   * Enqueue a video generation request
   */
  enqueue(prompt, model, size, seconds, imagePath, timeout, onProgress) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        prompt,
        model,
        size,
        seconds,
        imagePath,
        timeout,
        onProgress,
        resolve,
        reject,
        createdAt: Date.now(),
      });

      console.log(`[Sora Video Queue] Queue size: ${this.queue.length}, Active: ${this.activeRequests}`);

      if (!this.schedulerRunning) {
        setImmediate(() => this.runScheduler());
      }
    });
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      keys: Array.from(this.keys.values()).map((s) => ({
        label: s.label || "key",
        inFlight: s.inFlightRequests,
      })),
    };
  }
}

const queueManager = new SoraVideoQueueManager();

module.exports = {
  queueManager,
  async executeSoraVideoRequest(prompt, model, size, seconds, imagePath, timeoutMs, onProgress) {
    return await queueManager.enqueue(prompt, model, size, seconds, imagePath, timeoutMs, onProgress);
  },
  getSoraVideoQueueStats() {
    return queueManager.getStats();
  },
};
