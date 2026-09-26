/**
 * Chinese AI Models Automation Node
 *
 * Provides access to popular Chinese AI models:
 * - DeepSeek: deepseek-chat, deepseek-coder, deepseek-reasoner
 * - Qwen: qwen-max, qwen-plus, qwen-turbo, qwen-vl-max
 * - Zhipu/GLM: glm-4, glm-4v, glm-4-flash
 * - Moonshot: moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k
 */

const { readKey } = require("../lib/utils");
const { executeChineseAIRequest, getChineseAIQueueStats, MODEL_PROVIDER_MAP } = require("../lib/chineseAIQueue");

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
 * Chinese AI Chat Completion with Rate-Limited Queue
 * Automatically routes to the correct provider based on model name
 */
async function chineseAI(model, prompt, temperature = 1, image = null, systemPrompt = null, maxTokens = 4096) {
  if (!model) return { success: false, value: "Model is required" };
  if (!prompt) return { success: false, value: "Prompt is required" };

  // Validate model is supported
  if (!MODEL_PROVIDER_MAP[model]) {
    return { 
      success: false, 
      value: `Unsupported model: ${model}. Supported models: ${Object.keys(MODEL_PROVIDER_MAP).join(", ")}` 
    };
  }

  const timeoutMs = await getTimeoutFromSettings("chineseaiTimeout", 600);

  try {
    const result = await executeChineseAIRequest(
      prompt,
      model,
      temperature,
      image,
      systemPrompt,
      maxTokens,
      timeoutMs
    );

    if (!result.message) {
      return { success: false, value: "No message returned from Chinese AI" };
    }

    return { success: true, value: cleanCodeBlock(result.message) };
  } catch (error) {
    return { success: false, value: `Chinese AI request failed: ${error.message}` };
  }
}

module.exports = { chineseAI, getChineseAIQueueStats, MODEL_PROVIDER_MAP };
