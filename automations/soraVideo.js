const { readKey } = require("../lib/utils");
const { executeSoraVideoRequest } = require("../lib/soraVideoQueue");

async function getTimeoutFromSettings() {
  try {
    const automationSettings = (await readKey("automationSettings")) || {};
    return (automationSettings.soraVideoTimeout || 600) * 1000;
  } catch (error) {
    return 600000; // 10 minutes default
  }
}

/**
 * Generate a video using OpenAI's Sora Video API
 * @param {string} prompt - Text prompt describing the video
 * @param {string} model - Model name (sora-2 or sora-2-pro)
 * @param {string} size - Output resolution (e.g. 1280x720)
 * @param {string} seconds - Clip duration (4, 8, or 12)
 * @param {string|null} imagePath - Optional reference image path
 * @param {function|null} onProgress - Progress callback
 * @returns {{ success: boolean, value: string }}
 */
async function soraVideo(prompt, model, size, seconds, imagePath = null, onProgress = null) {
  if (!prompt) return { success: false, value: "Prompt is required" };
  if (!model) return { success: false, value: "Model is required" };

  const timeoutMs = await getTimeoutFromSettings();

  try {
    const result = await executeSoraVideoRequest(
      prompt,
      model,
      size || "1280x720",
      seconds || "4",
      imagePath,
      timeoutMs,
      onProgress
    );

    if (!result.filePath) {
      return { success: false, value: "No video file returned" };
    }

    return { success: true, value: result.filePath };
  } catch (error) {
    return { success: false, value: `Sora Video failed: ${error.message}` };
  }
}

module.exports = { soraVideo };
