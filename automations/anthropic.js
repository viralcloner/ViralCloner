/**
 * Anthropic (Claude) Automation Node
 *
 * Provides access to Anthropic's Claude models.
 * Models: claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022, claude-3-opus-20240229
 */

const { readKey } = require("../lib/utils");
const { executeAnthropicRequest, getAnthropicQueueStats } = require("../lib/anthropicQueue");

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
 * Anthropic Claude Chat Completion with Rate-Limited Queue
 * @param {number|null} timeoutOverride - Optional timeout in ms (for large operations like FB Analytics)
 */
async function anthropic(model, prompt, temperature = 1, image = null, systemPrompt = null, maxTokens = 4096, timeoutOverride = null) {
  if (!model) return { success: false, value: "Model is required" };
  if (!prompt) return { success: false, value: "Prompt is required" };

  const timeoutMs = timeoutOverride || await getTimeoutFromSettings("anthropicTimeout", 600);

  try {
    const result = await executeAnthropicRequest(
      prompt,
      model,
      temperature,
      image,
      systemPrompt,
      maxTokens,
      timeoutMs
    );

    if (!result.message) {
      return { success: false, value: "No message returned from Anthropic" };
    }

    return { success: true, value: cleanCodeBlock(result.message) };
  } catch (error) {
    return { success: false, value: `Anthropic request failed: ${error.message}` };
  }
}

module.exports = { anthropic, getAnthropicQueueStats };
