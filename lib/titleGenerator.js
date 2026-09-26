/**
 * Title Generator Module
 *
 * Generates a short, catchy title from a piece of post text (e.g. a Facebook
 * post caption) using a chosen AI provider/model. The generated title is
 * written in the SAME language as the source text.
 *
 * Used by the Facebook Output node when "Auto-generate title from text" is
 * enabled in Automation settings and no title is connected to the node.
 *
 * The provider/model is chosen in Automation settings (autoTitleProvider /
 * autoTitleModel). When no provider is selected, the module auto-resolves the
 * best available provider (VC AI first, then any keyed provider).
 */

const { readKey } = require("./utils");

const TIMEOUT_MS = 60000;
const MAX_INPUT_CHARS = 1500;

// AI providers (lazy-loaded to avoid startup cost). Mirrors the dispatch used
// by the Facebook Groups scheduler so every provider the user can connect is
// supported (API + browser based). All these automation functions return
// { success, value }.
const AI_PROVIDERS = {
  vcai:            () => require("../automations/vcai").vcai,
  openai:          () => require("../automations/openai").openAi,
  googleai:        () => require("../automations/googleai").googleAI,
  anthropic:       () => require("../automations/anthropic").anthropic,
  openrouter:      () => require("../automations/openrouter").openRouter,
  chineseai:       () => require("../automations/chineseai").chineseAI,
  // aliases so deepseek/qwen/zhipu/moonshot all route through chineseai (API)
  deepseek:        () => require("../automations/chineseai").chineseAI,
  qwen:            () => require("../automations/chineseai").chineseAI,
  zhipu:           () => require("../automations/chineseai").chineseAI,
  moonshot:        () => require("../automations/chineseai").chineseAI,
  // browser-based (no API key / model needed)
  deepseekbrowser: () => require("../automations/deepseekBrowser").deepseekBrowser,
  qwenbrowser:     () => require("../automations/qwenBrowser").qwenBrowser,
};

// Default model when a provider needs one but none was supplied.
const DEFAULT_MODELS = {
  openai:    "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
  googleai:  "gemini-2.0-flash",
  deepseek:  "deepseek-chat",
  qwen:      "qwen-plus",
  zhipu:     "glm-4-flash",
  moonshot:  "moonshot-v1-8k",
};

/**
 * Build the language-aware prompt used to generate the title.
 * @param {string} text - The post text to summarise into a title.
 * @returns {string}
 */
function buildPrompt(text) {
  const snippet = String(text).slice(0, MAX_INPUT_CHARS);
  return `You are a social media copywriter. Read the post below and write ONE short, catchy title for it.

Strict rules:
- Maximum 8 words.
- Write the title in the EXACT SAME LANGUAGE as the post. Do NOT translate it.
- Do NOT add quotes, hashtags, emojis, markdown, or any explanation.
- Respond with ONLY the title text, nothing else.

Post:
"""
${snippet}
"""`;
}

/**
 * Clean up the raw AI response into a usable title.
 * @param {string} raw
 * @returns {string}
 */
function cleanTitle(raw) {
  if (!raw) return "";
  let title = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "") // strip reasoning blocks
    .replace(/[\r\n]+/g, " ")
    .trim();

  // Remove a leading "Title:" / "Titre:" / "العنوان:" style label
  title = title.replace(/^\s*(title|titre|العنوان)\s*[:\-–]\s*/i, "");

  // Remove surrounding quotes/brackets
  title = title.replace(/^["'“”«»\[\(]+|["'“”«»\]\)]+$/g, "").trim();

  if (title.length > 120) {
    title = title.slice(0, 117).trim() + "...";
  }
  return title;
}

/**
 * Determine the preferred AI provider order based on configured credentials.
 * VC AI (built-in, no key required) is tried first, then any keyed provider.
 * @returns {string[]} ordered list of provider ids to try
 */
function resolveProviderOrder() {
  const order = [];
  try {
    const hasKeys = (o) => o && Object.keys(o).length > 0;
    if (hasKeys(readKey("openaiKeys"))) order.push("openai");
    if (hasKeys(readKey("anthropicKeys"))) order.push("anthropic");
    if (hasKeys(readKey("googleaiKeys"))) order.push("googleai");
    if (hasKeys(readKey("openrouterKeys"))) order.push("openrouter");
    if (hasKeys(readKey("chineseaiKeys"))) order.push("chineseai");
  } catch (_) {
    /* ignore — VC AI fallback remains */
  }
  return order;
}

/**
 * Run the prompt against a single provider and return the raw response text.
 * @param {string} provider - provider id (e.g. "openai", "deepseek", "vcai")
 * @param {string} model - model id (ignored by browser/vcai providers)
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callProvider(provider, model, prompt) {
  const p = String(provider || "").toLowerCase();
  const factory = AI_PROVIDERS[p];
  if (!factory) throw new Error(`Unknown AI provider: ${provider}`);
  const call = factory();
  const chosenModel = model || DEFAULT_MODELS[p] || "";

  let result;
  if (p === "vcai") {
    // vcai(model, prompt, temperature, image, systemPrompt, maxTokens, timeoutOverride)
    result = await call("", prompt, 0.7, null, null, 60, TIMEOUT_MS);
  } else if (p === "openai") {
    // openAi(apiKey, model, prompt, temperature) — apiKey ignored by queue
    result = await call(null, chosenModel || "gpt-4o-mini", prompt, 0.7);
  } else if (p === "deepseekbrowser") {
    // deepseekBrowser(prompt, ...) — no model/key
    result = await call(prompt, false, false);
  } else if (p === "qwenbrowser") {
    // qwenBrowser(prompt, imagePath, options) — no model/key
    result = await call(prompt, null, {});
  } else {
    // googleai / anthropic / openrouter / chineseai|deepseek|qwen|zhipu|moonshot
    // signature: fn(model, prompt, temperature)
    result = await call(chosenModel, prompt, 0.7);
  }

  if (!result || !result.success) {
    throw new Error(result && result.value ? result.value : `${provider} returned no response`);
  }
  return result.value;
}

/**
 * Generate a short title from post text, matching the text's language.
 *
 * If a provider is supplied, it is used exclusively. Otherwise the best
 * available provider is auto-resolved and tried in order.
 *
 * @param {string|string[]} text - The post text (string or array of strings).
 * @param {{provider?: string, model?: string}} [options] - Chosen provider/model.
 * @returns {Promise<string|null>} The generated title, or null if it could not be generated.
 */
async function generateTitleFromText(text, options = {}) {
  const source = Array.isArray(text) ? text.filter(Boolean).join("\n") : text;
  if (!source || !String(source).trim()) return null;

  const prompt = buildPrompt(source);
  const chosenProvider = String(options.provider || "").toLowerCase().trim();
  const chosenModel = options.model || "";

  // Build the ordered list of providers to try.
  let providers;
  if (chosenProvider && AI_PROVIDERS[chosenProvider]) {
    providers = [chosenProvider];
  } else {
    providers = resolveProviderOrder();
  }

  for (const provider of providers) {
    try {
      const modelForProvider = provider === chosenProvider ? chosenModel : "";
      const raw = await callProvider(provider, modelForProvider, prompt);
      const title = cleanTitle(raw);
      if (title) {
        console.log(`[TitleGenerator] Generated title via ${provider}: "${title}"`);
        return title;
      }
    } catch (err) {
      console.warn(`[TitleGenerator] ${provider} failed: ${err.message}`);
      // try next provider (auto mode) or give up (explicit provider)
    }
  }

  console.warn("[TitleGenerator] All providers failed to generate a title");
  return null;
}

module.exports = { generateTitleFromText };
