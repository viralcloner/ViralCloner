/**
 * VC Text To Speech
 *
 * Converts text to speech audio using Microsoft Edge TTS voices.
 * Returns the local file path of the generated MP3 audio.
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/**
 * Converts text to speech and saves as MP3.
 *
 * @param {string} text - The text to convert to speech
 * @param {string} voice - The voice ShortName (e.g. "en-US-EmmaMultilingualNeural")
 * @param {number} [timeoutMs=120000] - Maximum time to wait for synthesis
 * @returns {Promise<{success: boolean, value: string}>} - Result with local file path or error message
 */
async function textToSpeech(text, voice, timeoutMs = 120000) {
  console.log("[TextToSpeech] Synthesizing with voice:", voice);

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return { success: false, value: "Text input is required" };
  }

  if (!voice || typeof voice !== "string") {
    return { success: false, value: "Voice selection is required" };
  }

  // Create audio directory
  const audioDir = path.join(app.getPath("userData"), "Audio");
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  // Generate unique filename
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const filename = `tts_${timestamp}_${randomStr}.mp3`;
  const filePath = path.join(audioDir, filename);

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve({
        success: false,
        value: `TTS synthesis timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    (async () => {
      try {
        const { EdgeTTS } = await import("edge-tts-universal");
        const tts = new EdgeTTS(text.trim(), voice);
        const result = await tts.synthesize();

        const audioBuffer = Buffer.from(await result.audio.arrayBuffer());

        if (!audioBuffer || audioBuffer.length === 0) {
          clearTimeout(timeoutId);
          return resolve({
            success: false,
            value: "No audio data received from TTS service",
          });
        }

        fs.writeFileSync(filePath, audioBuffer);
        clearTimeout(timeoutId);

        // Extract word-level timing from edge-tts word boundaries
        let words = [];
        if (result.subtitle && Array.isArray(result.subtitle)) {
          words = result.subtitle.map((wb) => ({
            text: wb.text,
            start: wb.offset / 1e7,
            end: (wb.offset + wb.duration) / 1e7,
          }));

          // Merge single-character fragments into proper words.
          // edge-tts WordBoundary events can return individual characters.
          const merged = [];
          for (let i = 0; i < words.length; i++) {
            const w = words[i];
            const isFragment = w.text.length === 1 && /[a-zA-Z\u00C0-\u024F\u0600-\u06FF]/.test(w.text);
            if (isFragment && merged.length > 0) {
              const prev = merged[merged.length - 1];
              if (w.start - prev.end < 0.3) {
                prev.text += w.text;
                prev.end = w.end;
                continue;
              }
            }
            merged.push({ text: w.text, start: w.start, end: w.end });
          }
          words = merged;
        }

        console.log(
          "[TextToSpeech] Audio saved:",
          filePath,
          `(${(audioBuffer.length / 1024).toFixed(1)} KB, ${words.length} word boundaries)`,
        );
        resolve({ success: true, value: filePath, words });
      } catch (error) {
        clearTimeout(timeoutId);
        console.error("[TextToSpeech] Error:", error);
        resolve({
          success: false,
          value: `TTS synthesis failed: ${error.message || String(error)}`,
        });
      }
    })();
  });
}

/**
 * Fetches all available TTS voices from Microsoft Edge service.
 * Results are cached after first fetch.
 *
 * @returns {Promise<Array>} Array of voice objects with ShortName, FriendlyName, Gender, Locale
 */
let cachedVoices = null;
async function getTTSVoices() {
  if (cachedVoices) return cachedVoices;

  try {
    const { VoicesManager } = await import("edge-tts-universal");
    const voicesManager = await VoicesManager.create();
    const allVoices = voicesManager.find({});

    cachedVoices = allVoices.map((v) => ({
      ShortName: v.ShortName,
      FriendlyName: v.FriendlyName,
      Gender: v.Gender,
      Locale: v.Locale,
    }));

    console.log(`[TextToSpeech] Loaded ${cachedVoices.length} TTS voices`);
    return cachedVoices;
  } catch (error) {
    console.error("[TextToSpeech] Failed to fetch voices:", error);
    return [];
  }
}

module.exports = { textToSpeech, getTTSVoices };
