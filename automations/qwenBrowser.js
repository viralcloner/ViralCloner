/**
 * Qwen AI (Browser) Automation Node
 *
 * Runs chat requests through a real, logged-in VCBrowser session (see
 * lib/qwenBrowserSession.js) rather than a third-party HTTP proxy. Issuing the
 * request from inside the actual Qwen page means Alibaba's in-page anti-bot SDK
 * attaches valid `bx-ua` / `bx-umidtoken` headers automatically, which is what
 * keeps the WAF (`RGV587_ERROR` / `x5sec`) from challenging. When a challenge
 * does appear it is solved inside the same session and the request is retried.
 *
 * Flow per request:
 *  1. Load a connected profile (round-robin with concurrency control)
 *  2. Hand the prompt (and optional image) to that profile's browser session
 *  3. The session types into the composer, captures the streamed answer,
 *     solving the slider captcha in-place if needed
 *  4. Return the assembled text
 */

const { readKey, updateData } = require('../lib/utils');
const qwenSession = require('../lib/qwenBrowserSession');

// ─── Mark Profile Expired ─────────────────────────────────────────────────────

async function markProfileExpired(profileId) {
  try {
    const profiles = (await readKey('qwenBrowserProfiles')) || {};
    if (profiles[profileId]) {
      profiles[profileId].status = 'expired';
      await updateData('qwenBrowserProfiles', profiles);
    }
  } catch (_) {}
}

// ─── Public Entry Point ───────────────────────────────────────────────────────

/**
 * Qwen AI (Browser) node
 *
 * Requests are handed to the centralized scheduler in lib/qwenBrowserSession.js,
 * which queues them and spreads them across all connected profiles (one in-flight
 * request per profile, concurrent across profiles). This scales to hundreds of
 * queued requests without us managing concurrency here.
 *
 * @param {string}      prompt        The final prompt text
 * @param {string|null} imagePath     Optional local image file path
 * @param {object}      options       { model, thinkingEnabled, temperature, maxTokens, searchEnabled }
 * @param {string|null} pinnedProfileId  Force a specific profile (for test calls)
 * @returns {{ success: boolean, value: string }}
 */
async function qwenBrowser(prompt, imagePath, options, pinnedProfileId = null) {
  if (!prompt || !prompt.trim()) {
    return { success: false, value: 'Prompt is required' };
  }

  const profiles = (await readKey('qwenBrowserProfiles')) || {};
  const connected = Object.keys(profiles).filter(
    (id) => profiles[id].status === 'connected'
  );

  if (connected.length === 0) {
    return {
      success: false,
      value: 'No Qwen Browser profile connected. Please connect an account in Settings.',
    };
  }

  // A pinned profile (test calls) forces a single profile; otherwise the
  // scheduler picks any free connected profile.
  const pin = pinnedProfileId && connected.includes(pinnedProfileId) ? pinnedProfileId : null;

  let result;
  try {
    result = await qwenSession.chat(pin, {
      prompt,
      imagePath: imagePath || null,
      options: options || {},
      // Test calls can request a visible browser; automations run hidden.
      visible: !!(options && options.visible),
      log: (m) => console.log(`[Qwen Browser] ${m}`),
    });
  } catch (err) {
    return { success: false, value: `Qwen Browser request failed: ${err.message}` };
  }

  // A session/auth failure means the saved credentials are stale.
  if (result && result.expired) {
    await markProfileExpired(result.profileId || pin);
    return { success: false, value: result.value };
  }

  if (!result || !result.success) {
    return { success: false, value: (result && result.value) || 'Qwen request failed.' };
  }

  if (!result.value) {
    return { success: false, value: 'Qwen returned an empty response' };
  }

  // Strip markdown code fence wrappers (e.g. ```html ... ``` or ``` ... ```)
  const stripped = result.value
    .trim()
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  return { success: true, value: stripped };
}

module.exports = { qwenBrowser };
