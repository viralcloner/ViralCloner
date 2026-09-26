const { getJson } = require("serpapi");
const { readKey, updateData } = require("../lib/utils");

function withNodeTimeout(promise, timeoutMs, nodeType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${nodeType} operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(resolve).catch(reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Select the best available SerpAPI key based on remaining searches.
 * Returns { apiKey, keyData } or null if no keys available.
 */
async function selectBestKey() {
  const keys = (await readKey("serpapiKeys")) || {};
  const entries = Object.entries(keys).filter(
    ([, v]) => v.status === "active"
  );
  if (entries.length === 0) return null;

  // Pick key with the most remaining searches
  let best = null;
  for (const [apiKey, data] of entries) {
    const left = data.searchesLeft ?? Infinity;
    if (!best || left > (best.keyData.searchesLeft ?? Infinity)) {
      best = { apiKey, keyData: data };
    }
  }
  return best;
}

/**
 * Mark a key as exhausted and persist.
 */
async function markKeyExhausted(apiKey) {
  const keys = (await readKey("serpapiKeys")) || {};
  if (keys[apiKey]) {
    keys[apiKey].status = "exhausted";
    keys[apiKey].searchesLeft = 0;
    await updateData("serpapiKeys", keys);
  }
}

/**
 * Decrement the local searchesLeft counter and persist.
 */
async function decrementSearchCount(apiKey) {
  const keys = (await readKey("serpapiKeys")) || {};
  if (keys[apiKey] && typeof keys[apiKey].searchesLeft === "number") {
    keys[apiKey].searchesLeft = Math.max(0, keys[apiKey].searchesLeft - 1);
    await updateData("serpapiKeys", keys);
  }
}

/**
 * SerpAPI Search — automation node entry point.
 *
 * @param {string|null} apiKey   - Ignored; key rotation is handled internally.
 * @param {string}      engine   - SerpAPI engine name (google, bing, youtube, …)
 * @param {string}      query    - Search query from connection input
 * @param {object}      options  - Additional params (location, hl, gl, device, num, start, safe, tbm, advancedParams)
 * @returns {{ success: boolean, value: string }}
 */
async function serpApiSearch(apiKey, engine, query, options = {}) {
  if (!query) return { success: false, value: "Search query is required" };
  if (!engine) return { success: false, value: "Search engine is required" };

  const timeoutMs = 120000; // 2 minutes

  // Build the SerpAPI params object
  const params = { engine, q: query };

  if (options.location && options.location !== "auto" && options.location.trim()) {
    params.location = options.location.trim();
  }
  if (options.hl && options.hl !== "auto") params.hl = options.hl;
  if (options.gl && options.gl !== "auto") params.gl = options.gl;
  if (options.device && options.device !== "desktop") params.device = options.device;
  if (options.num && parseInt(options.num, 10) > 0) params.num = parseInt(options.num, 10);
  if (options.start && parseInt(options.start, 10) > 0) params.start = parseInt(options.start, 10);
  if (options.safe && options.safe !== "off") params.safe = options.safe;
  if (options.tbm && options.tbm.trim()) params.tbm = options.tbm;

  // Merge advanced params (JSON string)
  if (options.advancedParams && options.advancedParams.trim()) {
    try {
      const extra = JSON.parse(options.advancedParams.trim());
      if (typeof extra === "object" && extra !== null) {
        Object.assign(params, extra);
      }
    } catch {
      return { success: false, value: "Invalid JSON in Advanced Params field" };
    }
  }

  // Try up to 3 keys in case the first ones are exhausted
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const selected = await selectBestKey();
    if (!selected) {
      return {
        success: false,
        value: "No SerpAPI keys configured or all keys are exhausted. Add keys in Settings → SerpAPI.",
      };
    }

    params.api_key = selected.apiKey;

    try {
      const result = await withNodeTimeout(
        getJson(params),
        timeoutMs,
        "SerpAPI",
      );

      // Check for SerpAPI-level errors in the response
      if (result.error) {
        if (
          result.error.includes("quota") ||
          result.error.includes("limit") ||
          result.error.includes("exceeded")
        ) {
          console.warn(`[SerpAPI] Key exhausted (${selected.keyData.label}), trying next key...`);
          await markKeyExhausted(selected.apiKey);
          continue;
        }
        return { success: false, value: `SerpAPI error: ${result.error}` };
      }

      // Success — decrement counter and return
      await decrementSearchCount(selected.apiKey);
      return { success: true, value: JSON.stringify(result) };
    } catch (error) {
      const msg = error.message || String(error);
      if (msg.includes("quota") || msg.includes("exceeded") || msg.includes("403")) {
        console.warn(`[SerpAPI] Key error (${selected.keyData.label}): ${msg}, trying next key...`);
        await markKeyExhausted(selected.apiKey);
        continue;
      }
      return { success: false, value: `SerpAPI request failed: ${msg}` };
    }
  }

  return {
    success: false,
    value: "All SerpAPI keys exhausted. Please add more keys or wait for monthly quota reset.",
  };
}

module.exports = { serpApiSearch };
