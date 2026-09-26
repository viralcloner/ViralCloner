/**
 * Chinese AI Models Smart Queue System
 *
 * Unified queue for popular Chinese AI models:
 * - DeepSeek (deepseek-chat, deepseek-coder, deepseek-reasoner)
 * - Qwen (qwen-max, qwen-plus, qwen-turbo, qwen-vl-max)
 * - Zhipu AI / GLM (glm-4, glm-4v)
 * - Moonshot (moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k)
 *
 * Rate limits vary by provider:
 * - DeepSeek: 60 RPM free, higher for paid
 * - Qwen: 60 RPM free tier
 * - Zhipu: 100 RPM
 * - Moonshot: 60 RPM
 */

const fetch = require("node-fetch");
const { readKey, trackAIUsage } = require("./utils");

// Provider endpoints
const PROVIDERS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    headerKey: "Authorization",
    headerFormat: "Bearer",
    defaultRPM: 60,
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    headerKey: "Authorization",
    headerFormat: "Bearer",
    defaultRPM: 60,
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    headerKey: "Authorization",
    headerFormat: "Bearer",
    defaultRPM: 100,
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    headerKey: "Authorization",
    headerFormat: "Bearer",
    defaultRPM: 60,
  },
};

// Model to provider mapping
const MODEL_PROVIDER_MAP = {
  // DeepSeek models (Latest V3.x series)
  "deepseek-v3.2": "deepseek",
  "deepseek-v3.2-exp": "deepseek",
  "deepseek-v3.1": "deepseek",
  "deepseek-r1": "deepseek",
  "deepseek-r1-0528": "deepseek",
  "deepseek-chat": "deepseek",
  "deepseek-coder": "deepseek",
  "deepseek-reasoner": "deepseek",
  // Qwen models (Alibaba Tongyi)
  "qwen3-max": "qwen",
  "qwen-plus": "qwen",
  "qwen-flash": "qwen",
  "qwen-turbo": "qwen",
  "qwen3-vl-plus": "qwen",
  "qwq-plus": "qwen",
  "qwen3-coder-plus": "qwen",
  "qwen-max": "qwen",
  "qwen-max-longcontext": "qwen",
  "qwen-vl-max": "qwen",
  "qwen-vl-plus": "qwen",
  // Zhipu / GLM models (Latest 4.x series)
  "glm-4.7": "zhipu",
  "glm-4.6": "zhipu",
  "glm-4.5": "zhipu",
  "glm-4.5-air": "zhipu",
  "glm-4": "zhipu",
  "glm-4v": "zhipu",
  "glm-4-flash": "zhipu",
  // Moonshot/Kimi models
  "kimi-k2-thinking": "moonshot",
  "Moonshot-Kimi-K2-Instruct": "moonshot",
  "moonshot-v1-8k": "moonshot",
  "moonshot-v1-32k": "moonshot",
  "moonshot-v1-128k": "moonshot",
  // MiniMax models
  "MiniMax-M2.1": "qwen", // MiniMax uses similar API structure, route through Qwen for now
};

function getProviderFromModel(model) {
  return MODEL_PROVIDER_MAP[model] || "deepseek"; // Default to deepseek
}

function estimateTokens(text, image = null) {
  let tokens = Math.ceil(text.length / 4);
  if (image) tokens += 800;
  tokens += Math.min(4000, Math.max(500, tokens));
  return Math.ceil(tokens * 1.2);
}

/**
 * Per-key state tracking
 */
class KeyState {
  constructor(apiKey, label, provider) {
    this.apiKey = apiKey;
    this.label = label;
    this.provider = provider;
    this.requestsThisMinute = 0;
    this.minuteStartTime = Date.now();
    this.maxRPM = PROVIDERS[provider]?.defaultRPM || 60;
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
    this.maxRPM = Math.max(10, Math.floor(this.maxRPM * 0.8));
  }

  markSuccess() {
    this.consecutiveErrors = 0;
    if (this.maxRPM < PROVIDERS[this.provider]?.defaultRPM * 2) {
      this.maxRPM = Math.min(PROVIDERS[this.provider]?.defaultRPM * 2 || 120, this.maxRPM + 2);
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
 * Chinese AI Queue Manager
 */
class ChineseAIQueueManager {
  constructor() {
    this.keys = new Map(); // provider -> Map<apiKey, KeyState>
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = 10;
    this.schedulerRunning = false;
    this.lastKeysRefresh = 0;
    this.cachedKeys = null;
  }

  async getKeys() {
    const now = Date.now();
    if (this.cachedKeys && now - this.lastKeysRefresh < 10000) {
      return this.cachedKeys;
    }

    const chineseaiKeys = (await readKey("chineseaiKeys")) || {};
    
    // Initialize provider maps if needed
    for (const provider of Object.keys(PROVIDERS)) {
      if (!this.keys.has(provider)) {
        this.keys.set(provider, new Map());
      }
    }

    // Clear old keys
    for (const [provider, providerKeys] of this.keys) {
      for (const apiKey of providerKeys.keys()) {
        if (!chineseaiKeys[apiKey]) {
          providerKeys.delete(apiKey);
        }
      }
    }

    // Add new keys
    for (const [apiKey, keyData] of Object.entries(chineseaiKeys)) {
      const label = typeof keyData === "object" ? keyData.label : keyData;
      const provider = typeof keyData === "object" ? keyData.provider : "deepseek";
      
      const providerKeys = this.keys.get(provider) || new Map();
      if (!providerKeys.has(apiKey)) {
        providerKeys.set(apiKey, new KeyState(apiKey, label, provider));
      }
      this.keys.set(provider, providerKeys);
    }

    this.lastKeysRefresh = now;
    this.cachedKeys = this.keys;
    return this.keys;
  }

  async findAvailableKey(provider) {
    const keys = await this.getKeys();
    const providerKeys = keys.get(provider);
    
    if (!providerKeys || providerKeys.size === 0) {
      return { key: null, state: null, waitMs: 0 };
    }

    let bestKey = null;
    let bestState = null;
    let minWait = Infinity;

    for (const [apiKey, state] of providerKeys) {
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
    const provider = getProviderFromModel(model);
    const providerConfig = PROVIDERS[provider];
    
    if (!providerConfig) {
      throw new Error(`Unknown provider for model: ${model}`);
    }

    const { key, state } = await this.findAvailableKey(provider);

    if (!key || !state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;
    state.recordRequest();

    // Build messages (OpenAI-compatible format)
    const messages = [];
    
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    // Handle vision models
    const isVisionModel = model.includes("-vl-") || model.includes("glm-4v");
    
    if (image && isVisionModel) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: image } },
        ],
      });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const body = {
      model,
      messages,
      max_tokens: maxTokens || 4096,
    };

    if (temperature !== undefined && temperature !== null) {
      body.temperature = temperature;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const endpoint = `${providerConfig.baseUrl}/chat/completions`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [providerConfig.headerKey]: `${providerConfig.headerFormat} ${key}`,
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
        // Check for rate limit errors in body
        if (err.error?.code === "rate_limit_exceeded" || err.code === 429) {
          state.markRateLimited(60000);
          throw new Error(`RATE_LIMITED:60000`);
        }
        throw new Error(
          `${provider} API error: ${response.status} - ${JSON.stringify(err)}`
        );
      }

      state.markSuccess();
      const data = await response.json();

      // Track AI usage (async, non-blocking)
      const requestType = image ? 'vision' : 'text';
      trackAIUsage('chineseai', model, data.usage, requestType).catch(() => {});

      return {
        message: data.choices?.[0]?.message?.content || "",
        usage: data.usage,
        model: data.model || model,
        provider,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`${provider} request timed out after ${timeout}ms`);
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
    throw new Error("Chinese AI Queue: Max retries exceeded");
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
          `[Chinese AI Queue] Queue size: ${this.queue.length}, Active: ${this.activeRequests}`
        );
      }

      if (!this.schedulerRunning) {
        setImmediate(() => this.runScheduler());
      }
    });
  }

  getStats() {
    const stats = {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      providers: {},
    };

    for (const [provider, providerKeys] of this.keys) {
      stats.providers[provider] = Array.from(providerKeys.values()).map((s) => ({
        label: s.label || "key",
        requestsThisMinute: s.requestsThisMinute,
        maxRPM: s.maxRPM,
        inFlight: s.inFlightRequests,
      }));
    }

    return stats;
  }
}

const queueManager = new ChineseAIQueueManager();

module.exports = {
  queueManager,
  PROVIDERS,
  MODEL_PROVIDER_MAP,
  async executeChineseAIRequest(prompt, model, temperature, image, systemPrompt, maxTokens, timeoutMs) {
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
  getChineseAIQueueStats() {
    return queueManager.getStats();
  },
};
