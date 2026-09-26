const fetch = require("node-fetch");
const fs = require("fs/promises");
const { readKey } = require("../lib/utils");
const { executeOpenAIRequest, getQueueStats } = require("../lib/openaiQueue");

async function getTimeoutFromSettings(settingName, defaultSeconds) {
  try {
    const automationSettings = (await readKey("automationSettings")) || {};
    return (automationSettings[settingName] || defaultSeconds) * 1000; // Convert to milliseconds
  } catch (error) {
    console.error(`Error reading timeout setting ${settingName}:`, error);
    return defaultSeconds * 1000; // Return default in milliseconds
  }
}

function withNodeTimeout(promise, timeoutMs, nodeType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${nodeType} operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
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
 * OpenAI Chat Completion with Rate-Limited Queue
 * Uses the queue manager to handle multiple API keys and prevent rate limiting
 * @param {string} apiKey - Ignored, queue manager handles key selection
 * @param {string} model - The model to use
 * @param {string} prompt - The prompt to send
 * @param {number} temperature - Temperature for generation (default 1)
 * @param {string|null} image - Base64 image or null
 * @param {number|null} timeoutOverride - Optional timeout in ms (for large operations like FB Analytics)
 */
async function openAi(apiKey, model, prompt, temperature = 1, image = null, timeoutOverride = null) {
  // apiKey parameter is now ignored - queue manager handles key selection
  if (!model) return { success: false, value: "Model is required" };
  if (!prompt) return { success: false, value: "Prompt is required" };

  // Get timeout for the actual API request (not queue wait time)
  // Minimum 120 seconds (2 min) to handle complex prompts
  // timeoutOverride allows callers to specify longer timeouts for large operations
  let timeoutMs = timeoutOverride || await getTimeoutFromSettings("openaiTimeout", 600);
  if (timeoutMs < 120000) {
    timeoutMs = 120000; // Enforce minimum 2 minutes
  }

  try {
    // Use the queue manager which handles rate limiting and key rotation
    // The queue handles its own internal timeout for the API call
    const result = await executeOpenAIRequest(
      prompt,
      model,
      temperature,
      image,
      timeoutMs,
    );

    if (!result.message) {
      return { success: false, value: "No message returned from OpenAI" };
    }

    return { success: true, value: cleanCodeBlock(result.message) };
  } catch (error) {
    return { success: false, value: `OpenAI request failed: ${error.message}` };
  }
}

async function generateImage(
  apiKey,
  prompt,
  size = "1024x1024",
  quality = "standard",
) {
  const operation = async () => {
    if (!apiKey) return { success: false, value: "API key is required" };
    if (!prompt) return { success: false, value: "Prompt is required" };

    const endpoint = "https://api.openai.com/v1/images/generations";

    const body = {
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: size,
      quality: quality,
      response_format: "url",
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          value: `OpenAI API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`,
        };
      }

      const data = await response.json();
      const imageUrl = data.data?.[0]?.url;

      if (!imageUrl) {
        return { success: false, value: "No image URL returned from OpenAI" };
      }

      // Download the image and convert to base64
      try {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          return {
            success: false,
            value: `Failed to download generated image: ${imageResponse.statusText}`,
          };
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = `data:image/png;base64,${buffer.toString("base64")}`;

        return { success: true, value: base64Image };
      } catch (downloadError) {
        return {
          success: false,
          value: `Failed to convert image to base64: ${downloadError.message}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        value: `OpenAI image generation failed: ${error.message}`,
      };
    }
  };

  const timeoutMs = await getTimeoutFromSettings("openaiTimeout", 600);
  return withNodeTimeout(operation(), timeoutMs, "OpenAI Image Generation");
}

async function generatePollinationsImage(
  prompt,
  width = 1024,
  height = 1024,
  model = "flux-realism",
  negativePrompt = "",
  maxRetries = 5,
) {
  const operation = async () => {
    if (!prompt) return { success: false, value: "Prompt is required" };

    // Generate a random seed
    const seed = Math.floor(Math.random() * 1000000000);

    // URL encode the prompt and negative prompt
    const encodedPrompt = encodeURIComponent(prompt);
    const encodedNegativePrompt = encodeURIComponent(
      negativePrompt || "worst quality, blurry",
    );

    let lastError = null;

    // Try multiple times with different seeds in case of errors
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Generate new seed for each retry
        const retrySeed = seed + attempt;
        const retryUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${retrySeed}&model=${model}&negative_prompt=${encodedNegativePrompt}&nologo=true`;

        // Download the image directly and convert to base64
        const response = await fetch(retryUrl, { timeout: 30000 });

        if (response.ok) {
          // Download and convert to base64
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const base64Image = `data:image/png;base64,${buffer.toString("base64")}`;

          return { success: true, value: base64Image };
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;

        // Wait a bit before retrying
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      } catch (error) {
        lastError = error.message;

        // Wait a bit before retrying
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return {
      success: false,
      value: `Pollinations AI image generation failed after ${maxRetries} attempts. Last error: ${lastError}`,
    };
  };

  const timeoutMs = await getTimeoutFromSettings("openaiTimeout", 600);
  return withNodeTimeout(
    operation(),
    timeoutMs,
    "Pollinations AI Image Generation",
  );
}

module.exports = { openAi, generateImage, generatePollinationsImage };
