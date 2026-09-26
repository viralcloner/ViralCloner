/**
 * VC Audio Transcription
 *
 * Transcribes audio/video files to word-level timestamped text
 * using OpenAI Whisper API. Supports extracting audio from video
 * files via FFmpeg before transcription.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const FormData = require("form-data");
const { app } = require("electron");
const { readKey } = require("./utils");
const { getFFmpegPath, getFFprobePath } = require("./ffmpegManager");

const MAX_WHISPER_SIZE = 25 * 1024 * 1024; // 25MB Whisper limit

/**
 * Get an available OpenAI API key from storage.
 * @returns {Promise<string|null>}
 */
async function getOpenAIKey() {
  const openaiKeys = (await readKey("openaiKeys")) || {};
  const keys = Object.keys(openaiKeys);
  if (keys.length === 0) return null;
  return keys[0];
}

/**
 * Extract audio from a video or audio file to a temporary WAV file.
 * @param {string} inputPath - Path to the video/audio file
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
async function extractAudio(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    return { success: false, error: "Input file not found" };
  }

  const ffmpegPath = getFFmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    return { success: false, error: "FFmpeg not found. Please install FFmpeg first." };
  }

  const tempDir = path.join(app.getPath("userData"), "Temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const outputPath = path.join(tempDir, `audio_extract_${timestamp}_${randomStr}.wav`);

  return new Promise((resolve) => {
    const args = [
      "-i", inputPath,
      "-vn",                    // No video
      "-acodec", "pcm_s16le",  // PCM 16-bit
      "-ar", "16000",          // 16kHz (Whisper optimal)
      "-ac", "1",              // Mono
      "-y",                    // Overwrite
      outputPath,
    ];

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderrData = "";

    proc.stderr.on("data", (d) => {
      stderrData += d.toString();
    });

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        console.log("[Transcription] Audio extracted:", outputPath);
        resolve({ success: true, path: outputPath });
      } else {
        console.error("[Transcription] FFmpeg extraction failed:", stderrData.slice(-500));
        resolve({ success: false, error: "Failed to extract audio from file" });
      }
    });

    proc.on("error", (err) => {
      console.error("[Transcription] FFmpeg spawn error:", err);
      resolve({ success: false, error: `FFmpeg error: ${err.message}` });
    });
  });
}

/**
 * Probe a file to check if it has an audio stream.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function hasAudioStream(filePath) {
  const ffprobePath = getFFprobePath();
  if (!ffprobePath || !fs.existsSync(ffprobePath)) return false;

  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      "-v", "quiet",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      filePath,
    ], { windowsHide: true });

    let output = "";
    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.on("close", () => resolve(output.trim().length > 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Transcribe an audio or video file using OpenAI Whisper API.
 * Returns word-level timestamps.
 *
 * @param {string} filePath - Path to audio/video file
 * @param {string} [language] - Optional language code (e.g., "en", "fr", "ar")
 * @param {number} [timeoutMs=180000] - Timeout in milliseconds
 * @returns {Promise<{success: boolean, words?: Array<{text: string, start: number, end: number}>, fullText?: string, language?: string, error?: string}>}
 */
async function transcribeAudio(filePath, language, timeoutMs = 180000) {
  console.log("[Transcription] Starting transcription for:", filePath);

  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: "File not found" };
  }

  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return { success: false, error: "No OpenAI API key configured. Add one in Settings → API Keys." };
  }

  let audioPath = filePath;
  let tempAudioPath = null;

  // Check if input is video — extract audio first
  const ext = path.extname(filePath).toLowerCase();
  const videoExts = [".mp4", ".avi", ".mkv", ".mov", ".webm", ".flv", ".wmv"];
  if (videoExts.includes(ext)) {
    const hasAudio = await hasAudioStream(filePath);
    if (!hasAudio) {
      return { success: false, error: "Video file has no audio track" };
    }
    const extraction = await extractAudio(filePath);
    if (!extraction.success) {
      return { success: false, error: extraction.error };
    }
    audioPath = extraction.path;
    tempAudioPath = extraction.path;
  }

  // Check file size
  const stats = fs.statSync(audioPath);
  if (stats.size > MAX_WHISPER_SIZE) {
    if (tempAudioPath) safeDelete(tempAudioPath);
    return { success: false, error: `Audio file is too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Maximum is 25MB.` };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const form = new FormData();
    form.append("file", fs.createReadStream(audioPath), {
      filename: path.basename(audioPath),
      contentType: "audio/wav",
    });
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (language) {
      form.append("language", language);
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[Transcription] API error:", response.status, errorBody);
      if (tempAudioPath) safeDelete(tempAudioPath);
      return { success: false, error: `Whisper API error (${response.status}): ${errorBody.substring(0, 200)}` };
    }

    const data = await response.json();

    // Extract word-level timestamps
    let words = [];
    if (data.words && Array.isArray(data.words)) {
      words = data.words.map((w) => ({
        text: w.word?.trim() || w.text?.trim() || "",
        start: w.start || 0,
        end: w.end || 0,
      })).filter((w) => w.text.length > 0);
    }

    // Fallback: extract words from segments if top-level words array is missing
    if (words.length === 0 && data.segments && Array.isArray(data.segments)) {
      for (const seg of data.segments) {
        if (seg.words && Array.isArray(seg.words)) {
          for (const w of seg.words) {
            const text = (w.word || w.text || "").trim();
            if (text.length > 0) {
              words.push({ text, start: w.start || 0, end: w.end || 0 });
            }
          }
        }
      }
    }

    // Merge single-character fragments into proper words.
    // Some Whisper responses or edge-tts WordBoundary events return
    // individual characters instead of whole words.
    if (words.length > 0) {
      const merged = [];
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        // A fragment is a single non-space character that isn't standalone punctuation
        const isFragment = w.text.length === 1 && /[a-zA-Z\u00C0-\u024F\u0600-\u06FF\u4e00-\u9fff]/.test(w.text);
        if (isFragment && merged.length > 0) {
          const prev = merged[merged.length - 1];
          // Merge if this character follows closely (< 0.3s gap)
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

    if (tempAudioPath) safeDelete(tempAudioPath);

    console.log(`[Transcription] Complete: ${words.length} words, language: ${data.language || "unknown"}`);

    return {
      success: true,
      words,
      fullText: data.text || "",
      language: data.language || language || "unknown",
    };
  } catch (error) {
    if (tempAudioPath) safeDelete(tempAudioPath);

    if (error.name === "AbortError") {
      return { success: false, error: `Transcription timed out after ${timeoutMs / 1000}s` };
    }
    console.error("[Transcription] Error:", error);
    return { success: false, error: `Transcription failed: ${error.message || String(error)}` };
  }
}

function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn("[Transcription] Cleanup failed:", e.message);
  }
}

module.exports = { transcribeAudio, extractAudio };
