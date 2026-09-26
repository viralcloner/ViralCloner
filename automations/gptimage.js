/**
 * GPT-Image Automation Node
 *
 * Generates images using OpenAI's GPT-Image models (gpt-image-1, gpt-image-1.5).
 * Successor to DALL-E with improved instruction following.
 */

const fetch = require("node-fetch");
const { readKey, moveToPermStorage, trackAIUsage } = require("../lib/utils");

// Simple queue for GPT-Image to handle rate limits
class GPTImageQueueManager {
  constructor() {
    this.keys = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = 3; // Conservative for image generation
    this.schedulerRunning = false;
    this.lastKeysRefresh = 0;
    this.cachedKeys = null;
  }

  async getKeys() {
    const now = Date.now();
    if (this.cachedKeys && now - this.lastKeysRefresh < 10000) {
      return this.cachedKeys;
    }

    // Reuse OpenAI keys for GPT-Image
    const openaiKeys = (await readKey("openaiKeys")) || {};

    for (const apiKey of this.keys.keys()) {
      if (!openaiKeys[apiKey]) this.keys.delete(apiKey);
    }
    for (const [apiKey, keyData] of Object.entries(openaiKeys)) {
      if (!this.keys.has(apiKey)) {
        const label = typeof keyData === "object" ? keyData.label : keyData;
        this.keys.set(apiKey, {
          apiKey,
          label,
          inFlightRequests: 0,
          errorCooldownUntil: 0,
          requestsThisMinute: 0,
          minuteStartTime: now,
        });
      }
    }

    this.lastKeysRefresh = now;
    this.cachedKeys = this.keys;
    return this.keys;
  }

  async findAvailableKey() {
    const keys = await this.getKeys();
    if (keys.size === 0) return null;

    const now = Date.now();
    let bestKey = null;
    let bestState = null;

    for (const [apiKey, state] of keys) {
      // Reset minute counter if needed
      if (now - state.minuteStartTime >= 60000) {
        state.requestsThisMinute = 0;
        state.minuteStartTime = now;
      }

      // Skip if in cooldown
      if (state.errorCooldownUntil > now) continue;
      
      // Skip if too many in-flight
      if (state.inFlightRequests >= 2) continue;

      // Skip if hit rate limit (5 images per minute per key is safe)
      if (state.requestsThisMinute >= 5) continue;

      if (!bestState || state.requestsThisMinute < bestState.requestsThisMinute) {
        bestKey = apiKey;
        bestState = state;
      }
    }

    return bestState;
  }

  async executeOne(request) {
    const { prompt, model, size, quality, format, timeout } = request;
    const state = await this.findAvailableKey();

    if (!state) {
      throw new Error("NO_KEY_AVAILABLE");
    }

    state.inFlightRequests++;
    state.requestsThisMinute++;

    const body = {
      model: model || "gpt-image-1",
      prompt,
      n: 1,
      size: size || "1024x1024",
      quality: quality || "standard",
      response_format: "b64_json", // Get base64 directly
    };

    if (format) {
      body.output_format = format;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        state.errorCooldownUntil = Date.now() + 60000;
        throw new Error("RATE_LIMITED:60000");
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(
          `GPT-Image API error: ${response.status} - ${JSON.stringify(err)}`
        );
      }

      const data = await response.json();
      const imageData = data.data?.[0]?.b64_json;

      if (!imageData) {
        throw new Error("No image data returned from GPT-Image");
      }

      // Track AI usage for image generation (async, non-blocking)
      trackAIUsage('gptimage', model || "gpt-image-1", null, 'image_generation').catch(() => {});

      // Return as data URL
      const mimeType = format === "webp" ? "image/webp" : format === "jpeg" ? "image/jpeg" : "image/png";
      return {
        image: `data:${mimeType};base64,${imageData}`,
        model: model || "gpt-image-1",
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`GPT-Image request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      state.inFlightRequests--;
    }
  }

  async processRequest(request) {
    let retries = 0;
    while (retries < 30) {
      try {
        return await this.executeOne(request);
      } catch (error) {
        if (error.message === "NO_KEY_AVAILABLE") {
          await new Promise((r) => setTimeout(r, 2000));
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
    throw new Error("GPT-Image Queue: Max retries exceeded");
  }

  async runScheduler() {
    if (this.schedulerRunning) return;
    this.schedulerRunning = true;

    while (this.queue.length > 0) {
      if (this.activeRequests >= this.maxConcurrent) {
        await new Promise((r) => setTimeout(r, 200));
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

      // Longer delay for image generation
      await new Promise((r) => setTimeout(r, 500));
    }

    this.schedulerRunning = false;
  }

  enqueue(prompt, model, size, quality, format, timeout) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        prompt,
        model,
        size,
        quality,
        format,
        timeout,
        resolve,
        reject,
        createdAt: Date.now(),
      });

      if (this.queue.length === 1 || this.queue.length % 50 === 0) {
        console.log(
          `[GPT-Image Queue] Queue size: ${this.queue.length}, Active: ${this.activeRequests}`
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
        inFlight: s.inFlightRequests,
      })),
    };
  }
}

const queueManager = new GPTImageQueueManager();

async function getTimeoutFromSettings(settingName, defaultSeconds) {
  try {
    const automationSettings = (await readKey("automationSettings")) || {};
    return (automationSettings[settingName] || defaultSeconds) * 1000;
  } catch (error) {
    console.error(`Error reading timeout setting ${settingName}:`, error);
    return defaultSeconds * 1000;
  }
}

/**
 * GPT-Image Generation with Rate-Limited Queue
 * Uses OpenAI API keys
 */
async function gptImage(prompt, model = "gpt-image-1", size = "1024x1024", quality = "standard", format = "png", workflowId = null) {
  if (!prompt) return { success: false, value: "Prompt is required" };

  const timeoutMs = await getTimeoutFromSettings("gptimageTimeout", 300);

  try {
    const result = await queueManager.enqueue(
      prompt,
      model,
      size,
      quality,
      format,
      timeoutMs
    );

    if (!result.image) {
      return { success: false, value: "No image returned from GPT-Image" };
    }

    // Check if AI image cleaning is enabled
    const automationSettings = await readKey('automationSettings') || {};
    const cleanAI = automationSettings.aiImageCleaning !== false; // Default true
    
    // Get image metadata settings for fake EXIF injection
    const imageMetadataSettings = await readKey('imageMetadataSettings') || {};

    // CRITICAL: Move data URL to permanent storage to prevent cleanup deletion
    // GPT-Image returns a data URL which needs to be saved as a file
    // Also clean AI metadata if enabled (defeats Pinterest AI detection)
    // Also pass metadata settings for fake EXIF injection
    // Also pass nodeType for SEO metadata generation if enabled
    const moveResult = await moveToPermStorage(result.image, { 
      cleanAI,
      injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
      nodeType: 'gptimage',
      workflowId,
      prompt
    });
    if (moveResult.success) {
      console.log("[GPT-Image] Saved to permanent storage:", moveResult.permanentPath);
      return { success: true, value: moveResult.permanentPath };
    }
    
    // Fallback to returning data URL if save failed (workflow can still use it)
    console.warn("[GPT-Image] Failed to save to permanent storage:", moveResult.error);
    return { success: true, value: result.image };
  } catch (error) {
    return { success: false, value: `GPT-Image request failed: ${error.message}` };
  }
}

function getGPTImageQueueStats() {
  return queueManager.getStats();
}

module.exports = { gptImage, getGPTImageQueueStats };
