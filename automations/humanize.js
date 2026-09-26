/**
 * Humanize
 *
 * Rewrites AI-generated text so it sounds more natural using the AI Humanize
 * service. Takes one text input and produces one text output.
 */

const { humanizeText } = require("../lib/aiHumanizer");

/**
 * Humanizes a single text string.
 *
 * @param {string} text - The text to humanize
 * @returns {Promise<{success: boolean, value: string}>}
 */
async function humanize(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return { success: false, value: "Text is required" };
  }

  try {
    const result = await humanizeText(normalized, { maxAttempts: 6 });
    if (!result || !result.text) {
      return { success: false, value: "Humanization returned no text" };
    }
    return { success: true, value: result.text };
  } catch (error) {
    return { success: false, value: error.message || "Humanization failed" };
  }
}

module.exports = { humanize };
