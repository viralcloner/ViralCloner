/**
 * OpenAI Smart Queue System v3
 *
 * Simple, efficient queue with single scheduler loop.
 * No busy-waiting, no thundering herd, minimal CPU usage.
 */

const fetch = require("node-fetch");
const fs = require("fs");
const sharp = require("sharp");
const { fileURLToPath } = require("url");
const { readKey, trackAIUsage } = require("./utils");

// Image optimization settings for OpenAI Vision API
// Aggressive compression to dramatically reduce token usage (~37K → ~2-3K tokens)
// 512px is sufficient for most vision tasks (policy checks, descriptions, classifications)
const MAX_IMAGE_DIMENSION = 512;
const JPEG_QUALITY = 70; // Aggressive compression for token savings
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
const IMAGE_DOWNLOAD_ATTEMPTS = 3;

/**
 * Optimize a base64 image for OpenAI Vision API
 * - Resizes to max 512px on longest side (sufficient for most vision tasks)
 * - Compresses to JPEG at 70% quality for maximum token savings
 * - Returns original if optimization fails
 * @param {string} base64Url - Base64 data URL (data:image/xxx;base64,...)
 * @returns {Promise<string>} - Optimized base64 data URL
 */
async function optimizeImageForVision(base64Url) {
  try {
    // Extract base64 data and mime type
    const matches = base64Url.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
    if (!matches) {
      // Not a valid base64 image URL, return as-is
      return base64Url;
    }

    const [, format, base64Data] = matches;
    const inputBuffer = Buffer.from(base64Data, "base64");

    // Get image metadata
    const metadata = await sharp(inputBuffer).metadata();
    const { width, height, hasAlpha } = metadata;

    // Calculate new dimensions maintaining aspect ratio
    let newWidth = width;
    let newHeight = height;

    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      if (width > height) {
        newWidth = MAX_IMAGE_DIMENSION;
        newHeight = Math.round((height / width) * MAX_IMAGE_DIMENSION);
      } else {
        newHeight = MAX_IMAGE_DIMENSION;
        newWidth = Math.round((width / height) * MAX_IMAGE_DIMENSION);
      }
    }

    // Process image with sharp
    let sharpInstance = sharp(inputBuffer).resize(newWidth, newHeight, {
      fit: "inside",
      withoutEnlargement: true,
    });

    let outputBuffer;
    let outputFormat;

    // Use PNG if image has transparency, otherwise JPEG for better compression
    if (hasAlpha && (format === "png" || format === "webp")) {
      outputBuffer = await sharpInstance.png({ quality: 80 }).toBuffer();
      outputFormat = "png";
    } else {
      outputBuffer = await sharpInstance
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      outputFormat = "jpeg";
    }

    const optimizedBase64 = `data:image/${outputFormat};base64,${outputBuffer.toString("base64")}`;

    // Log optimization results for debugging
    const savings = Math.round(
      ((inputBuffer.length - outputBuffer.length) / inputBuffer.length) * 100
    );
    console.log(
      `[OpenAI Queue] Image optimized: ${width}x${height} → ${newWidth}x${newHeight}, ` +
        `${Math.round(inputBuffer.length / 1024)}KB → ${Math.round(outputBuffer.length / 1024)}KB (${savings}% smaller)`
    );

    return optimizedBase64;
  } catch (error) {
    // If optimization fails, return original image
    console.warn("[OpenAI Queue] Image optimization failed, using original:", error.message);
    return base64Url;
  }
}

async function imageBufferToDataUrl(buffer, sourceLabel) {
  if (!buffer.length) {
    throw new Error(`${sourceLabel} returned an empty file`);
  }
  if (buffer.length > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`${sourceLabel} exceeds the 25 MB image limit`);
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    throw new Error(`${sourceLabel} did not return a valid image: ${error.message}`);
  }

  const mimeTypes = {
    avif: "image/avif",
    gif: "image/gif",
    heif: "image/heif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    tiff: "image/tiff",
    webp: "image/webp",
  };
  const mimeType = mimeTypes[metadata.format] || "image/jpeg";
  return optimizeImageForVision(`data:${mimeType};base64,${buffer.toString("base64")}`);
}

async function downloadImageForVision(url) {
  let lastError;

  for (let attempt = 1; attempt <= IMAGE_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
        size: MAX_SOURCE_IMAGE_BYTES,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      return await response.buffer();
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      if (!retryable || attempt === IMAGE_DOWNLOAD_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  throw new Error(`could not be downloaded after ${IMAGE_DOWNLOAD_ATTEMPTS} attempts: ${lastError?.message || "Unknown error"}`);
}

async function prepareImageForVision(imageInput) {
  if (typeof imageInput !== "string" || !imageInput.trim()) {
    throw new Error("Image input must be a non-empty URL, file path, or data URL");
  }

  const image = imageInput.trim();
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(image)) {
    return optimizeImageForVision(image);
  }

  if (/^https?:\/\//i.test(image)) {
    const buffer = await downloadImageForVision(image);
    return imageBufferToDataUrl(buffer, "Remote image");
  }

  let filePath = image;
  if (/^file:\/\//i.test(image)) {
    try {
      filePath = fileURLToPath(image);
    } catch (error) {
      throw new Error(`Invalid image file URL: ${error.message}`);
    }
  }

  if (!fs.existsSync(filePath)) {
    throw new Error("Image input is not an accessible URL or local file");
  }

  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) throw new Error("Image input does not point to a file");
  if (stats.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("Local image exceeds the 25 MB image limit");

  const buffer = await fs.promises.readFile(filePath);
  return imageBufferToDataUrl(buffer, "Local image");
}

// Simple token estimation (fast, no external libs needed for estimation)
function estimateTokens(text, image = null) {
  // ~4 chars per token for English
  let tokens = Math.ceil((text?.length || 0) / 4);
  // Vision models use more tokens for images - support array of images
  if (image) {
    const imageCount = Array.isArray(image) ? image.length : 1;
    tokens += 800 * imageCount;
  }
  // Add estimated response
  tokens += Math.min(4000, Math.max(500, tokens));
  return Math.ceil(tokens * 1.2);
}

// Parse duration string like "1s", "6m0s" to milliseconds
function parseDuration(duration) {
  if (!duration) return 0;
  let ms = 0;
  const minMatch = duration.match(/(\d+)m/);
  const secMatch = duration.match(/(\d+(?:\.\d+)?)s/);
  if (minMatch) ms += parseInt(minMatch[1]) * 60 * 1000;
  if (secMatch) ms += parseFloat(secMatch[1]) * 1000;
  return ms;
}

/**
 * Per-key state tracking
 */
class KeyState {
  constructor(apiKey, label) {
    this.apiKey = apiKey;
    this.label = label;
    this.tokensRemaining = 30000;
    this.requestsRemaining = 500;
    this.tokenResetTime = 0;
    this.requestResetTime = 0;
    this.inFlightRequests = 0;
    this.errorCooldownUntil = 0;
  }

  updateFromHeaders(headers) {
    const now = Date.now();
    if (headers["x-ratelimit-remaining-tokens"]) {
      this.tokensRemaining = parseInt(headers["x-ratelimit-remaining-tokens"]);
    }
    if (headers["x-ratelimit-remaining-requests"]) {
      this.requestsRemaining = parseInt(
        headers["x-ratelimit-remaining-requests"],
      );
    }
    if (headers["x-ratelimit-reset-tokens"]) {
      this.tokenResetTime =
        now + parseDuration(headers["x-ratelimit-reset-tokens"]);
    }
    if (headers["x-ratelimit-reset-requests"]) {
      this.requestResetTime =
        now + parseDuration(headers["x-ratelimit-reset-requests"]);
    }
    this.errorCooldownUntil = 0;
  }

  markRateLimited(retryMs) {
    this.errorCooldownUntil = Date.now() + retryMs;
    this.tokensRemaining = 0;
  }

  isAvailable(estimatedTokens) {
    const now = Date.now();
    if (this.errorCooldownUntil > now) return false;
    if (this.tokensRemaining < estimatedTokens && this.tokenResetTime > now)
      return false;
    if (this.requestsRemaining < 1 && this.requestResetTime > now) return false;
    return true;
  }

  getWaitTime(estimatedTokens) {
    const now = Date.now();
    let wait = 0;
    if (this.errorCooldownUntil > now)
      wait = Math.max(wait, this.errorCooldownUntil - now);
    if (this.tokensRemaining < estimatedTokens)
      wait = Math.max(wait, this.tokenResetTime - now);
    if (this.requestsRemaining < 1)
      wait = Math.max(wait, this.requestResetTime - now);
    return Math.max(0, wait);
  }
}

/**
 * Simple Queue Manager - Single scheduler, no busy loops
 */
class OpenAIQueueManager {
  constructor() {
    this.keys = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = 15; // Default, will be loaded from settings
    this.schedulerRunning = false;
    this.schedulerTimer = null;
    this.lastKeysRefresh = 0;
    this.cachedKeys = null;
    this.settingsLoaded = false;
  }

  // Load max concurrent from settings
  async loadSettings() {
    if (this.settingsLoaded) return;
    try {
      const automationSettings = (await readKey("automationSettings")) || {};
      // Use openaiMaxConcurrent setting, default to 15 for single key high-speed usage
      this.maxConcurrent = automationSettings.openaiMaxConcurrent || 15;
      console.log(`[OpenAI Queue] Max concurrent requests set to: ${this.maxConcurrent}`);
      this.settingsLoaded = true;
    } catch (error) {
      console.error("[OpenAI Queue] Error loading settings:", error);
      this.maxConcurrent = 15;
    }
  }

  // Get keys with caching
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

  // Find available key
  async findAvailableKey(estimatedTokens) {
    const keys = await this.getKeys();
    if (keys.size === 0) return { key: null, state: null, waitMs: 0 };

    let bestKey = null;
    let bestState = null;
    let minWait = Infinity;

    for (const [apiKey, state] of keys) {
      if (state.isAvailable(estimatedTokens) && state.inFlightRequests < 3) {
        if (!bestState || state.tokensRemaining > bestState.tokensRemaining) {
          bestKey = apiKey;
          bestState = state;
        }
      } else {
        minWait = Math.min(minWait, state.getWaitTime(estimatedTokens));
      }
    }

    return {
      key: bestKey,
      state: bestState,
      waitMs: bestKey ? 0 : Math.max(100, Math.min(minWait, 5000)),
    };
  }

  // Execute single API call
  async executeOne(request) {
    const { prompt, model, temperature, image, timeout, estimatedTokens } =
      request;
    const { key, state } = await this.findAvailableKey(estimatedTokens);

    if (!key || !state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;

    // Build content array - supports single image, array of images, or no images
    // Optimize images before sending to reduce payload size and improve speed
    let contentArray = [{ type: "text", text: prompt }];
    if (image) {
      const images = Array.isArray(image) ? image : [image];
      // Materialize images locally so OpenAI never has to fetch unreliable third-party URLs.
      let optimizedImages;
      try {
        optimizedImages = await Promise.all(
          images.map((imageInput) => prepareImageForVision(imageInput))
        );
      } catch (error) {
        state.inFlightRequests--;
        throw new Error(`Unable to prepare image for OpenAI: ${error.message}`);
      }
      optimizedImages.forEach(imgUrl => {
        contentArray.push({ type: "image_url", image_url: { url: imgUrl } });
      });
    }

    // Check if this is an o-series reasoning model (o1, o3, o4, etc.) or gpt-5-nano
    // These models don't support temperature and require max_completion_tokens instead of max_tokens
    const isReasoningModel = /^o[134]-|^o[134]$/.test(model);
    const isNanoModel = /^gpt-5-nano/.test(model);

    const body = {
      model,
      messages: [
        {
          role: "user",
          content: contentArray,
        },
      ],
      // Reasoning models consume tokens for internal thinking + output — use a larger budget
      // so they don't exhaust the limit on reasoning before producing any output
      max_completion_tokens: (isReasoningModel || isNanoModel) ? 32000 : 16000,
    };

    // Only add temperature for non-reasoning models (o-series and gpt-5-nano don't support it)
    if (!isReasoningModel && !isNanoModel) {
      body.temperature = temperature;
    }

    // For gpt-5-nano: use low reasoning effort — simple tasks don't need heavy reasoning,
    // and keeping reasoning tokens low ensures there's plenty of budget left for output
    if (isNanoModel) {
      body.reasoning_effort = "low";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      const headers = {};
      response.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      if (response.status === 429) {
        const retryMs = headers["retry-after"]
          ? parseInt(headers["retry-after"]) * 1000
          : 5000;
        state.markRateLimited(retryMs);
        throw new Error(`RATE_LIMITED:${retryMs}`);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(
          `OpenAI API error: ${response.status} - ${JSON.stringify(err)}`,
        );
      }

      state.updateFromHeaders(headers);
      const data = await response.json();

      // Debug log for troubleshooting response structure issues
      if (!data.choices?.[0]?.message?.content) {
        console.error('[OpenAI Queue] Unexpected response structure:', JSON.stringify(data, null, 2));
      }

      // Track AI usage (async, non-blocking)
      const requestType = image ? 'vision' : 'text';
      trackAIUsage('openai', model, data.usage, requestType).catch(() => {});

      return {
        message: data.choices?.[0]?.message?.content,
        usage: data.usage,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`OpenAI request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      state.inFlightRequests--;
    }
  }

  // Process one request with retry for rate limits
  async processRequest(request) {
    const startTime = Date.now();
    const maxApiRetries = 60; // Max retries for actual API rate limit errors
    let apiRetries = 0;
    
    // Queue timeout: wait up to 2x the request timeout for a key to become available
    // This allows requests to wait in queue during high load without failing prematurely
    const queueTimeoutMs = Math.max(request.timeout * 2, 300000); // At least 5 minutes
    
    while (true) {
      // Check if we've been waiting too long in queue
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > queueTimeoutMs) {
        throw new Error(`OpenAI Queue: Timeout waiting for available API key (waited ${Math.round(elapsedMs/1000)}s)`);
      }
      
      try {
        return await this.executeOne(request);
      } catch (error) {
        if (error.message === "NO_KEY_AVAILABLE") {
          // No key available - wait and retry (this is queue wait, not an API error)
          // Use exponential backoff with jitter to prevent thundering herd
          const baseWait = Math.min(1000 * Math.pow(1.5, Math.floor(elapsedMs / 10000)), 5000);
          const jitter = Math.random() * 500;
          await new Promise((r) => setTimeout(r, baseWait + jitter));
          continue;
        }
        if (error.message.startsWith("RATE_LIMITED:")) {
          // API rate limit - this counts against retries
          apiRetries++;
          if (apiRetries >= maxApiRetries) {
            throw new Error(`OpenAI Queue: Max API retries exceeded (${apiRetries} rate limit errors)`);
          }
          const waitMs = parseInt(error.message.split(":")[1]);
          console.log(`[OpenAI Queue] Rate limited, waiting ${waitMs}ms (retry ${apiRetries}/${maxApiRetries})`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw error;
      }
    }
  }

  // Single scheduler loop
  async runScheduler() {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;
    
    // Load settings on first run
    await this.loadSettings();

    while (this.queue.length > 0) {
      // Don't exceed max concurrent
      if (this.activeRequests >= this.maxConcurrent) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const request = this.queue.shift();
      if (!request) break;

      this.activeRequests++;

      // Fire and forget - don't await
      this.processRequest(request)
        .then((result) => request.resolve(result))
        .catch((error) => request.reject(error))
        .finally(() => {
          this.activeRequests--;
        });

      // Small delay between dispatches to prevent overwhelming
      await new Promise((r) => setTimeout(r, 50));
    }

    this.schedulerRunning = false;
  }

  // Enqueue a request
  enqueue(prompt, model, temperature, image, timeout) {
    return new Promise((resolve, reject) => {
      const estimatedTokens = estimateTokens(prompt, image);

      this.queue.push({
        prompt,
        model,
        temperature,
        image,
        timeout,
        estimatedTokens,
        resolve,
        reject,
        createdAt: Date.now(),
      });

      // Log occasionally
      if (this.queue.length === 1 || this.queue.length % 100 === 0) {
        console.log(
          `[OpenAI Queue] Queue size: ${this.queue.length}, Active: ${this.activeRequests}`,
        );
      }

      // Start scheduler if not running
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
        tokensRemaining: s.tokensRemaining,
        inFlight: s.inFlightRequests,
      })),
    };
  }
}

const queueManager = new OpenAIQueueManager();

module.exports = {
  queueManager,
  async executeOpenAIRequest(prompt, model, temperature, image, timeoutMs) {
    return await queueManager.enqueue(
      prompt,
      model,
      temperature,
      image,
      timeoutMs,
    );
  },
  getQueueStats() {
    return queueManager.getStats();
  },
};
