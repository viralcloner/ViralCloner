/**
 * OpenRouter Smart Queue System
 *
 * Handles rate limiting and key rotation for OpenRouter API.
 * OpenRouter provides access to all major AI models through a unified API.
 * Rate limits: 200 requests/minute free tier, varies by model
 */

const fetch = require("node-fetch");
const { readKey, trackAIUsage } = require("./utils");

// Token estimation (same as OpenAI - ~4 chars per token)
function estimateTokens(text, image = null) {
  let tokens = Math.ceil(text.length / 4);
  if (image) tokens += 800;
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
 * Per-key state tracking for OpenRouter
 */
class KeyState {
  constructor(apiKey, label) {
    this.apiKey = apiKey;
    this.label = label;
    this.requestsRemaining = 200; // OpenRouter default
    this.requestResetTime = 0;
    this.inFlightRequests = 0;
    this.errorCooldownUntil = 0;
    this.creditsRemaining = Infinity; // Track credits if available
  }

  updateFromHeaders(headers) {
    const now = Date.now();
    // OpenRouter uses x-ratelimit-* headers
    if (headers["x-ratelimit-remaining"]) {
      this.requestsRemaining = parseInt(headers["x-ratelimit-remaining"]);
    }
    if (headers["x-ratelimit-reset"]) {
      // OpenRouter returns Unix timestamp
      const resetTime = parseInt(headers["x-ratelimit-reset"]) * 1000;
      this.requestResetTime = resetTime;
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
    if (this.errorCooldownUntil > now)
      wait = Math.max(wait, this.errorCooldownUntil - now);
    if (this.requestsRemaining < 1)
      wait = Math.max(wait, this.requestResetTime - now);
    return Math.max(0, wait);
  }
}

/**
 * OpenRouter Queue Manager
 */
class OpenRouterQueueManager {
  constructor() {
    this.keys = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = 10; // OpenRouter can handle more concurrent requests
    this.schedulerRunning = false;
    this.lastKeysRefresh = 0;
    this.cachedKeys = null;
    this.modelsCache = null;
    this.modelsCacheTime = 0;
  }

  async getKeys() {
    const now = Date.now();
    if (this.cachedKeys && now - this.lastKeysRefresh < 10000) {
      return this.cachedKeys;
    }

    const openrouterKeys = (await readKey("openrouterKeys")) || {};

    for (const apiKey of this.keys.keys()) {
      if (!openrouterKeys[apiKey]) this.keys.delete(apiKey);
    }
    for (const [apiKey, keyData] of Object.entries(openrouterKeys)) {
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
      if (state.isAvailable() && state.inFlightRequests < 5) {
        if (!bestState || state.requestsRemaining > bestState.requestsRemaining) {
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

  async fetchModels(forceRefresh = false) {
    const now = Date.now();
    // Cache models for 1 hour
    if (!forceRefresh && this.modelsCache && now - this.modelsCacheTime < 3600000) {
      return this.modelsCache;
    }

    const keys = await this.getKeys();
    if (keys.size === 0) return [];

    const firstKey = keys.keys().next().value;

    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${firstKey}`,
        },
      });

      if (!response.ok) {
        console.error("[OpenRouter] Failed to fetch models:", response.status);
        return this.modelsCache || [];
      }

      const data = await response.json();
      this.modelsCache = data.data || [];
      this.modelsCacheTime = now;
      return this.modelsCache;
    } catch (error) {
      console.error("[OpenRouter] Error fetching models:", error.message);
      return this.modelsCache || [];
    }
  }

  async executeOne(request) {
    const { prompt, model, temperature, image, systemPrompt, maxTokens, timeout } = request;
    const { key, state } = await this.findAvailableKey();

    if (!key || !state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;

    const messages = [];
    
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    messages.push({
      role: "user",
      content: image
        ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image } },
          ]
        : prompt,
    });

    // Check if this is an OpenAI o-series reasoning model via OpenRouter
    // These models don't support temperature and require max_completion_tokens
    const isOpenAIReasoningModel = model.startsWith('openai/') && /o[134]-|o[134]$/.test(model);

    const body = {
      model,
      messages,
      // Use max_completion_tokens for better compatibility (required for OpenAI o-series)
      max_completion_tokens: maxTokens || 4096,
    };

    // Only add temperature for non-reasoning models
    if (!isOpenAIReasoningModel) {
      body.temperature = temperature || 1;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://github.com/viralcloner/ViralCloner",
          "X-Title": "ViralCloner",
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
        const retryMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
        state.markRateLimited(retryMs);
        throw new Error(`RATE_LIMITED:${retryMs}`);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(
          `OpenRouter API error: ${response.status} - ${JSON.stringify(err)}`
        );
      }

      state.updateFromHeaders(headers);
      const data = await response.json();

      // Track AI usage (async, non-blocking)
      const requestType = image ? 'vision' : 'text';
      trackAIUsage('openrouter', model, data.usage, requestType).catch(() => {});

      return {
        message: data.choices?.[0]?.message?.content,
        usage: data.usage,
        model: data.model,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`OpenRouter request timed out after ${timeout}ms`);
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
    throw new Error("OpenRouter Queue: Max retries exceeded");
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
      this.queue.push({
        prompt,
        model,
        temperature,
        image,
        systemPrompt,
        maxTokens,
        timeout,
        resolve,
        reject,
        createdAt: Date.now(),
      });

      if (this.queue.length === 1 || this.queue.length % 100 === 0) {
        console.log(
          `[OpenRouter Queue] Queue size: ${this.queue.length}, Active: ${this.activeRequests}`
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
        inFlight: s.inFlightRequests,
      })),
    };
  }
}

const queueManager = new OpenRouterQueueManager();

module.exports = {
  queueManager,
  async executeOpenRouterRequest(prompt, model, temperature, image, systemPrompt, maxTokens, timeoutMs) {
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
  async fetchOpenRouterModels(forceRefresh = false) {
    return await queueManager.fetchModels(forceRefresh);
  },
  getOpenRouterQueueStats() {
    return queueManager.getStats();
  },
};
