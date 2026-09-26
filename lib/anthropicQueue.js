/**
 * Anthropic (Claude) Smart Queue System
 *
 * Handles rate limiting and key rotation for Anthropic API.
 * Rate limits vary by tier:
 * - Tier 1: 60 RPM, 60K tokens/minute
 * - Tier 2: 1000 RPM, 80K tokens/minute
 * - Tier 3: 2000 RPM, 160K tokens/minute
 * - Tier 4: 4000 RPM, 400K tokens/minute
 *
 * Uses anthropic-ratelimit-* headers for tracking
 */

const fetch = require("node-fetch");
const { readKey, trackAIUsage } = require("./utils");

// Token estimation (same approach as OpenAI)
function estimateTokens(text, image = null) {
  let tokens = Math.ceil(text.length / 4);
  if (image) tokens += 1600; // Claude vision is expensive
  tokens += Math.min(4000, Math.max(500, tokens));
  return Math.ceil(tokens * 1.2);
}

/**
 * Per-key state tracking for Anthropic
 */
class KeyState {
  constructor(apiKey, label) {
    this.apiKey = apiKey;
    this.label = label;
    this.requestsRemaining = 60; // Default tier 1
    this.tokensRemaining = 60000;
    this.requestResetTime = 0;
    this.tokenResetTime = 0;
    this.inFlightRequests = 0;
    this.errorCooldownUntil = 0;
  }

  updateFromHeaders(headers) {
    const now = Date.now();
    
    // Anthropic uses anthropic-ratelimit-* headers
    if (headers["anthropic-ratelimit-requests-remaining"]) {
      this.requestsRemaining = parseInt(headers["anthropic-ratelimit-requests-remaining"]);
    }
    if (headers["anthropic-ratelimit-tokens-remaining"]) {
      this.tokensRemaining = parseInt(headers["anthropic-ratelimit-tokens-remaining"]);
    }
    if (headers["anthropic-ratelimit-requests-reset"]) {
      // ISO 8601 timestamp
      this.requestResetTime = new Date(headers["anthropic-ratelimit-requests-reset"]).getTime();
    }
    if (headers["anthropic-ratelimit-tokens-reset"]) {
      this.tokenResetTime = new Date(headers["anthropic-ratelimit-tokens-reset"]).getTime();
    }
    this.errorCooldownUntil = 0;
  }

  markRateLimited(retryMs) {
    this.errorCooldownUntil = Date.now() + retryMs;
    this.requestsRemaining = 0;
    this.tokensRemaining = 0;
  }

  isAvailable(estimatedTokens) {
    const now = Date.now();
    if (this.errorCooldownUntil > now) return false;
    if (this.requestsRemaining < 1 && this.requestResetTime > now) return false;
    if (this.tokensRemaining < estimatedTokens && this.tokenResetTime > now) return false;
    return true;
  }

  getWaitTime(estimatedTokens) {
    const now = Date.now();
    let wait = 0;
    if (this.errorCooldownUntil > now)
      wait = Math.max(wait, this.errorCooldownUntil - now);
    if (this.requestsRemaining < 1)
      wait = Math.max(wait, this.requestResetTime - now);
    if (this.tokensRemaining < estimatedTokens)
      wait = Math.max(wait, this.tokenResetTime - now);
    return Math.max(0, wait);
  }
}

/**
 * Anthropic Queue Manager
 */
class AnthropicQueueManager {
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

    const anthropicKeys = (await readKey("anthropicKeys")) || {};

    for (const apiKey of this.keys.keys()) {
      if (!anthropicKeys[apiKey]) this.keys.delete(apiKey);
    }
    for (const [apiKey, keyData] of Object.entries(anthropicKeys)) {
      if (!this.keys.has(apiKey)) {
        const label = typeof keyData === "object" ? keyData.label : keyData;
        this.keys.set(apiKey, new KeyState(apiKey, label));
      }
    }

    this.lastKeysRefresh = now;
    this.cachedKeys = this.keys;
    return this.keys;
  }

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

  async executeOne(request) {
    const { prompt, model, temperature, image, systemPrompt, maxTokens, timeout, estimatedTokens } = request;
    const { key, state } = await this.findAvailableKey(estimatedTokens);

    if (!key || !state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;

    // Build messages for Claude API
    const messages = [];
    
    const userContent = [];
    
    if (image) {
      // Claude supports base64 images
      if (image.startsWith("data:")) {
        const [meta, base64Data] = image.split(",");
        const mediaType = meta.match(/data:([^;]+)/)?.[1] || "image/jpeg";
        userContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64Data,
          },
        });
      } else {
        // URL - need to fetch and convert
        try {
          const imgResponse = await fetch(image);
          const buffer = await imgResponse.buffer();
          const base64 = buffer.toString("base64");
          const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
          userContent.push({
            type: "image",
            source: {
              type: "base64",
              media_type: contentType,
              data: base64,
            },
          });
        } catch (e) {
          console.warn("[Anthropic] Failed to fetch image:", e.message);
        }
      }
    }

    userContent.push({ type: "text", text: prompt });
    messages.push({ role: "user", content: userContent });

    const body = {
      model,
      messages,
      max_tokens: maxTokens || 4096,
    };

    if (temperature !== undefined && temperature !== null) {
      body.temperature = temperature;
    }

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const headers = {};
      response.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      if (response.status === 429) {
        const retryAfter = headers["retry-after"];
        const retryMs = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
        state.markRateLimited(retryMs);
        throw new Error(`RATE_LIMITED:${retryMs}`);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (err.error?.type === "rate_limit_error") {
          state.markRateLimited(60000);
          throw new Error(`RATE_LIMITED:60000`);
        }
        throw new Error(
          `Anthropic API error: ${response.status} - ${JSON.stringify(err)}`
        );
      }

      state.updateFromHeaders(headers);
      const data = await response.json();

      const content = data.content?.[0]?.text || "";
      
      // Track AI usage (async, non-blocking)
      const requestType = image ? 'vision' : 'text';
      trackAIUsage('anthropic', model, data.usage, requestType).catch(() => {});

      return {
        message: content,
        usage: data.usage,
        model: data.model,
        stopReason: data.stop_reason,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`Anthropic request timed out after ${timeout}ms`);
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
    throw new Error("Anthropic Queue: Max retries exceeded");
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

  enqueue(prompt, model, temperature, image, systemPrompt, maxTokens, timeout) {
    return new Promise((resolve, reject) => {
      const estimatedTokens = estimateTokens(prompt, image);

      this.queue.push({
        prompt,
        model,
        temperature,
        image,
        systemPrompt,
        maxTokens,
        timeout,
        estimatedTokens,
        resolve,
        reject,
        createdAt: Date.now(),
      });

      if (this.queue.length === 1 || this.queue.length % 100 === 0) {
        console.log(
          `[Anthropic Queue] Queue size: ${this.queue.length}, Active: ${this.activeRequests}`
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
        requestsRemaining: s.requestsRemaining,
        tokensRemaining: s.tokensRemaining,
        inFlight: s.inFlightRequests,
      })),
    };
  }
}

const queueManager = new AnthropicQueueManager();

module.exports = {
  queueManager,
  async executeAnthropicRequest(prompt, model, temperature, image, systemPrompt, maxTokens, timeoutMs) {
    return await queueManager.enqueue(
      prompt,
      model,
      temperature,
      image,
      systemPrompt,
      maxTokens,
      timeoutMs
    );
  },
  getAnthropicQueueStats() {
    return queueManager.getStats();
  },
};
