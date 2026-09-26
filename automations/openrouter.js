/**
 * OpenRouter Automation Node
 *
 * Provides access to all AI models through OpenRouter's unified API.
 * Supports: GPT-4, Claude, Gemini, Llama, Mistral, and 100+ other models.
 */

const { readKey } = require("../lib/utils");
const { executeOpenRouterRequest, getOpenRouterQueueStats } = require("../lib/openrouterQueue");

async function getTimeoutFromSettings(settingName, defaultSeconds) {
  try {
    const automationSettings = (await readKey("automationSettings")) || {};
    return (automationSettings[settingName] || defaultSeconds) * 1000;
  } catch (error) {
    console.error(`Error reading timeout setting ${settingName}:`, error);
    return defaultSeconds * 1000;
  }
}

function cleanCodeBlock(str) {
  return str
    .replace(/^```[a-zA-Z]*\s*/gm, "")
    .replace(/\s*```$/gm, "")
    .replace(/^\s*#{2,}\s*/gm, "")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * OpenRouter Chat Completion with Rate-Limited Queue
 * Supports all models available on OpenRouter
 */
/**
 * @param {number|null} timeoutOverride - Optional timeout in ms (for large operations like FB Analytics)
 */
async function openRouter(model, prompt, temperature = 1, image = null, systemPrompt = null, maxTokens = 4096, timeoutOverride = null) {
  if (!model) return { success: false, value: "Model is required" };
  if (!prompt) return { success: false, value: "Prompt is required" };

  const timeoutMs = timeoutOverride || await getTimeoutFromSettings("openrouterTimeout", 600);

  try {
    const result = await executeOpenRouterRequest(
      prompt,
      model,
      temperature,
      image,
      systemPrompt,
      maxTokens,
      timeoutMs
    );

    if (!result.message) {
      return { success: false, value: "No message returned from OpenRouter" };
    }

    return { success: true, value: cleanCodeBlock(result.message) };
  } catch (error) {
    return { success: false, value: `OpenRouter request failed: ${error.message}` };
  }
}

module.exports = { openRouter, getOpenRouterQueueStats };
