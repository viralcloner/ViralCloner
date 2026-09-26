/**
 * Google AI (Gemini) Automation Node
 *
 * Provides access to Google's Gemini models for text and image generation.
 * LLM Models: gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash
 * Image Models: imagen-3.0-generate-001
 */

const { readKey } = require("../lib/utils");
const { 
  executeGoogleAIRequest, 
  executeGoogleAIImageRequest,
  getGoogleAIQueueStats 
} = require("../lib/googleAIQueue");

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
 * Google AI (Gemini) Chat Completion with Rate-Limited Queue
 * @param {number|null} timeoutOverride - Optional timeout in ms (for large operations like FB Analytics)
 */
async function googleAI(model, prompt, temperature = 1, image = null, systemPrompt = null, maxTokens = 8192, timeoutOverride = null) {
  if (!model) return { success: false, value: "Model is required" };
  if (!prompt) return { success: false, value: "Prompt is required" };

  const timeoutMs = timeoutOverride || await getTimeoutFromSettings("googleaiTimeout", 600);

  try {
    const result = await executeGoogleAIRequest(
      prompt,
      model,
      temperature,
      image,
      systemPrompt,
      maxTokens,
      timeoutMs
    );

    if (!result.message) {
      return { success: false, value: "No message returned from Google AI" };
    }

    return { success: true, value: cleanCodeBlock(result.message) };
  } catch (error) {
    return { success: false, value: `Google AI request failed: ${error.message}` };
  }
}

/**
 * Google AI Image Generation (Imagen)
 */
async function googleAIImage(prompt, model = "imagen-3.0-generate-001", aspectRatio = "1:1") {
  if (!prompt) return { success: false, value: "Prompt is required" };

  const timeoutMs = await getTimeoutFromSettings("googleaiTimeout", 300);

  try {
    const result = await executeGoogleAIImageRequest(
      prompt,
      model,
      aspectRatio,
      timeoutMs
    );

    if (!result.image) {
      return { success: false, value: "No image returned from Google AI" };
    }

    return { success: true, value: result.image };
  } catch (error) {
    return { success: false, value: `Google AI image generation failed: ${error.message}` };
  }
}

module.exports = { googleAI, googleAIImage, getGoogleAIQueueStats };
