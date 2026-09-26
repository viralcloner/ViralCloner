/**
 * Google AI (Gemini) Smart Queue System
 *
 * Handles rate limiting and key rotation for Google AI API.
 * Rate limits:
 * - Free tier: 60 requests/minute, 1M tokens/day
 * - Paid tier: 1000 requests/minute
 * 
 * Uses RPM (requests per minute) based rate limiting
 */

const fetch = require("node-fetch");
const { readKey, trackAIUsage } = require("./utils");

// Token estimation for Gemini
function estimateTokens(text, image = null) {
  let tokens = Math.ceil(text.length / 4);
  if (image) tokens += 258; // Gemini image tokens
  tokens += Math.min(4000, Math.max(500, tokens));
  return Math.ceil(tokens * 1.2);
}

/**
 * Per-key state tracking for Google AI
 */
class KeyState {
  constructor(apiKey, label) {
    this.apiKey = apiKey;
    this.label = label;
    this.requestsThisMinute = 0;
    this.minuteStartTime = Date.now();
    this.maxRPM = 60; // Default free tier, will increase if paid
    this.inFlightRequests = 0;
    this.errorCooldownUntil = 0;
    this.consecutiveErrors = 0;
  }

  resetMinuteIfNeeded() {
    const now = Date.now();
    if (now - this.minuteStartTime >= 60000) {
      this.requestsThisMinute = 0;
      this.minuteStartTime = now;
    }
  }

  recordRequest() {
    this.resetMinuteIfNeeded();
    this.requestsThisMinute++;
  }

  markRateLimited(retryMs) {
    this.errorCooldownUntil = Date.now() + retryMs;
    this.consecutiveErrors++;
    // Reduce RPM estimate on rate limit
    this.maxRPM = Math.max(10, Math.floor(this.maxRPM * 0.8));
  }

  markSuccess() {
    this.consecutiveErrors = 0;
    // Gradually increase RPM limit if successful
    if (this.maxRPM < 1000) {
      this.maxRPM = Math.min(1000, this.maxRPM + 5);
    }
  }

  isAvailable() {
    const now = Date.now();
    if (this.errorCooldownUntil > now) return false;
    this.resetMinuteIfNeeded();
    if (this.requestsThisMinute >= this.maxRPM) return false;
    return true;
  }

  getWaitTime() {
    const now = Date.now();
    if (this.errorCooldownUntil > now) {
      return this.errorCooldownUntil - now;
    }
    this.resetMinuteIfNeeded();
    if (this.requestsThisMinute >= this.maxRPM) {
      return 60000 - (now - this.minuteStartTime);
    }
    return 0;
  }
}

/**
 * Google AI Queue Manager
 */
class GoogleAIQueueManager {
  constructor() {
    this.keys = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = 8;
    this.schedulerRunning = false;
    this.lastKeysRefresh = 0;
    this.cachedKeys = null;
  }

  async getKeys() {
    const now = Date.now();
    if (this.cachedKeys && now - this.lastKeysRefresh < 10000) {
      return this.cachedKeys;
    }

    const googleaiKeys = (await readKey("googleaiKeys")) || {};

    for (const apiKey of this.keys.keys()) {
      if (!googleaiKeys[apiKey]) this.keys.delete(apiKey);
    }
    for (const [apiKey, keyData] of Object.entries(googleaiKeys)) {
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
      if (state.isAvailable() && state.inFlightRequests < 3) {
        if (!bestState || state.requestsThisMinute < bestState.requestsThisMinute) {
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
      waitMs: bestKey ? 0 : Math.max(100, Math.min(minWait, 5000)),
    };
  }

  async executeOne(request) {
    const { prompt, model, temperature, image, systemPrompt, maxTokens, timeout } = request;
    const { key, state } = await this.findAvailableKey();

    if (!key || !state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;
    state.recordRequest();

    // Build request for Gemini API
    const contents = [];
    
    const userParts = [];
    if (prompt) {
      userParts.push({ text: prompt });
    }
    if (image) {
      // Support base64 or URL
      if (image.startsWith("data:")) {
        const [meta, base64Data] = image.split(",");
        const mimeType = meta.match(/data:([^;]+)/)?.[1] || "image/jpeg";
        userParts.push({
          inlineData: {
            mimeType,
            data: base64Data,
          },
        });
      } else {
        // For URLs, we need to fetch and convert to base64
        try {
          const imgResponse = await fetch(image);
          const buffer = await imgResponse.buffer();
          const base64 = buffer.toString("base64");
          const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
          userParts.push({
            inlineData: {
              mimeType: contentType,
              data: base64,
            },
          });
        } catch (e) {
          console.warn("[GoogleAI] Failed to fetch image:", e.message);
        }
      }
    }

    contents.push({ role: "user", parts: userParts });

    const body = {
      contents,
      generationConfig: {
        temperature: temperature || 1,
        maxOutputTokens: maxTokens || 8192,
      },
    };

    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Use the correct endpoint format for Gemini
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryMs = 60000; // Wait 1 minute on rate limit
        state.markRateLimited(retryMs);
        throw new Error(`RATE_LIMITED:${retryMs}`);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // Check for quota errors
        if (err.error?.code === 429 || err.error?.status === "RESOURCE_EXHAUSTED") {
          state.markRateLimited(60000);
          throw new Error(`RATE_LIMITED:60000`);
        }
        throw new Error(
          `Google AI API error: ${response.status} - ${JSON.stringify(err)}`
        );
      }

      state.markSuccess();
      const data = await response.json();

      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
      // Track AI usage (async, non-blocking)
      const requestType = image ? 'vision' : 'text';
      trackAIUsage('googleai', model, data.usageMetadata, requestType).catch(() => {});

      return {
        message: content,
        usage: data.usageMetadata,
        model: model,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`Google AI request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      state.inFlightRequests--;
    }
  }

  async executeImageGeneration(request) {
    const { prompt, model, aspectRatio, timeout } = request;
    const { key, state } = await this.findAvailableKey();

    if (!key || !state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;
    state.recordRequest();

    const body = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: aspectRatio || "1:1",
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Imagen endpoint
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${key}`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        state.markRateLimited(60000);
        throw new Error(`RATE_LIMITED:60000`);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(
          `Google AI Image API error: ${response.status} - ${JSON.stringify(err)}`
        );
      }

      state.markSuccess();
      const data = await response.json();

      // Return base64 image
      const imageData = data.predictions?.[0]?.bytesBase64Encoded;
      if (!imageData) {
        throw new Error("No image data returned from Google AI");
      }

      // Track AI usage for image generation (async, non-blocking)
      trackAIUsage('googleai', model, null, 'image_generation').catch(() => {});

      return {
        image: `data:image/png;base64,${imageData}`,
        model: model,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`Google AI image request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      state.inFlightRequests--;
    }
  }

  async processRequest(request) {
    let retries = 0;
    while (retries < 50) {
      try {
        if (request.isImageGeneration) {
          return await this.executeImageGeneration(request);
        }
        return await this.executeOne(request);
      } catch (error) {
        if (error.message === "NO_KEY_AVAILABLE") {
          await new Promise((r) => setTimeout(r, 1000));
          retries++;
          continue;
        }
        if (error.message.startsWith("RATE_LIMITED:")) {
          const waitMs = parseInt(error.message.split(":")[1]);
          await new Promise((r) => setTimeout(r, waitMs));
          retries++;
          continue;
        }
        throw error;
      }
    }
    throw new Error("Google AI Queue: Max retries exceeded");
  }

  async runScheduler() {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;

    while (this.queue.length > 0) {
      if (this.activeRequests >= this.maxConcurrent) {
        await new Promise((r) => setTimeout(r, 100));
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

      await new Promise((r) => setTimeout(r, 50));
    }

    this.schedulerRunning = false;
  }

  enqueue(prompt, model, temperature, image, systemPrompt, maxTokens, timeout, isImageGeneration = false, aspectRatio = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        prompt,
        model,
        temperature,
        image,
        systemPrompt,
        maxTokens,
        timeout,
        isImageGeneration,
        aspectRatio,
        resolve,
        reject,
        createdAt: Date.now(),
      });

      if (this.queue.length === 1 || this.queue.length % 100 === 0) {
        console.log(
          `[Google AI Queue] Queue size: ${this.queue.length}, Active: ${this.activeRequests}`
        );
      }

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
        requestsThisMinute: s.requestsThisMinute,
        maxRPM: s.maxRPM,
        inFlight: s.inFlightRequests,
      })),
    };
  }
}

const queueManager = new GoogleAIQueueManager();

module.exports = {
  queueManager,
  async executeGoogleAIRequest(prompt, model, temperature, image, systemPrompt, maxTokens, timeoutMs) {
    return await queueManager.enqueue(
      prompt,
      model,
      temperature,
      image,
      systemPrompt,
      maxTokens,
      timeoutMs,
      false
    );
  },
  async executeGoogleAIImageRequest(prompt, model, aspectRatio, timeoutMs) {
    return await queueManager.enqueue(
      prompt,
      model,
      null,
      null,
      null,
      null,
      timeoutMs,
      true,
      aspectRatio
    );
  },
  getGoogleAIQueueStats() {
    return queueManager.getStats();
  },
};
