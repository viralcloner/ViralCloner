/**
 * Video Exporter - Renders project to video file using ffmpeg
 * Supports MP4 (H.264) and WebM (VP9) output
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fss = require("fs");
const { spawn } = require("child_process");
const { getFFmpegPath, getFFprobePath } = require("./ffmpegManager");

let activeExport = null;

/**
 * Export a video project to file
 * @param {Object} project - Full project data with tracks, settings
 * @param {Object} exportSettings - { format, quality, width, height, fps, outputPath }
 * @param {Function} onProgress - (percent, currentFrame, totalFrames) callback
 * @returns {Promise<{success: boolean, outputPath?: string, error?: string}>}
 */
async function exportVideo(project, exportSettings, onProgress) {
  const {
    format = "mp4",
    quality = "high",
    width,
    height,
    fps = 30,
    outputPath,
  } = exportSettings;

  const projWidth = width || project.settings?.width || 1920;
  const projHeight = height || project.settings?.height || 1080;
  const projFps = fps || project.settings?.fps || 30;

  // Calculate total duration from all clips
  let totalDuration = 0;
  for (const track of project.tracks || []) {
    for (const clip of track.clips || []) {
      const clipEnd = (clip.startTime || 0) + (clip.duration || 0);
      if (clipEnd > totalDuration) totalDuration = clipEnd;
    }
  }

  if (totalDuration <= 0) {
    return { success: false, error: "No content to export" };
  }

  const totalFrames = Math.ceil(totalDuration * projFps);
  const ffmpegPath = getFFmpegPath();

  try {
    await fs.access(ffmpegPath);
  } catch {
    return { success: false, error: "FFmpeg not found. Please download it first." };
  }

  // Build ffmpeg arguments
  const args = buildFFmpegArgs({
    format,
    quality,
    width: projWidth,
    height: projHeight,
    fps: projFps,
    totalDuration,
    outputPath,
    project,
  });

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeExport = { process: proc, cancelled: false };

    let stderrData = "";

    proc.stderr.on("data", (data) => {
      stderrData += data.toString();

      // Parse progress from ffmpeg stderr
      const timeMatch = data.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (timeMatch && onProgress) {
        const timeSec =
          parseInt(timeMatch[1]) * 3600 +
          parseInt(timeMatch[2]) * 60 +
          parseInt(timeMatch[3]) +
          parseInt(timeMatch[4]) / 100;
        const percent = Math.min(
          100,
          Math.round((timeSec / totalDuration) * 100)
        );
        const currentFrame = Math.round(timeSec * projFps);
        onProgress(percent, currentFrame, totalFrames);
      }
    });

    proc.on("close", (code) => {
      activeExport = null;

      if (code === 0) {
        resolve({ success: true, outputPath });
      } else if (activeExport?.cancelled) {
        resolve({ success: false, error: "Export cancelled" });
      } else {
        // Extract useful error from stderr
        const errorLines = stderrData
          .split("\n")
          .filter((l) => l.includes("Error") || l.includes("error"))
          .slice(-3)
          .join("\n");
        resolve({
          success: false,
          error: errorLines || `FFmpeg exited with code ${code}`,
        });
      }
    });

    proc.on("error", (err) => {
      activeExport = null;
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Build ffmpeg command-line arguments from project data
 */
function buildFFmpegArgs(opts) {
  const {
    format,
    quality,
    width,
    height,
    fps,
    totalDuration,
    outputPath,
    project,
  } = opts;

  const args = ["-y"]; // Overwrite output

  // Collect media and audio clips from visible tracks (track order = z-order)
  const mediaClips = [];
  const audioClips = [];

  for (const track of project.tracks || []) {
    if (!track.visible) continue;
    for (const clip of track.clips || []) {
      if ((clip.type === "video" || clip.type === "image") && clip.source) {
        mediaClips.push(clip);
      } else if (clip.type === "audio" && clip.source) {
        audioClips.push(clip);
      }
    }
  }

  // Input 0: Background color canvas (always present as base layer)
  const bgColor = (project.settings?.backgroundColor || "#000000").replace("#", "0x");
  args.push(
    "-f", "lavfi", "-i",
    `color=c=${bgColor}:s=${width}x${height}:r=${fps}:d=${totalDuration}`
  );

  // Inputs 1..N: media clips
  for (const clip of mediaClips) {
    if (clip.type === "image") {
      args.push("-loop", "1", "-t", String(clip.duration || 5));
    }
    args.push("-i", clip.source);
  }

  // Inputs N+1..M: audio clips
  const audioStartIdx = 1 + mediaClips.length;
  for (const clip of audioClips) {
    args.push("-i", clip.source);
  }

  // Build filter_complex for compositing video clips at their positions
  const filterParts = [];

  if (mediaClips.length > 0) {
    let lastLabel = "0:v";

    for (let i = 0; i < mediaClips.length; i++) {
      const clip = mediaClips[i];
      const inputIdx = i + 1;
      // Ensure even dimensions for codec compatibility
      const clipW = Math.round(clip.size?.width || width) & ~1;
      const clipH = Math.round(clip.size?.height || height) & ~1;
      const x = Math.round(clip.position?.x || 0);
      const y = Math.round(clip.position?.y || 0);
      const startTime = clip.startTime || 0;
      const endTime = startTime + (clip.duration || 5);

      // Scale input to the clip's displayed size on canvas
      filterParts.push(`[${inputIdx}:v]scale=${clipW}:${clipH}[s${i}]`);

      // Overlay at the clip's canvas position, enabled only during clip time range
      const outLabel = i < mediaClips.length - 1 ? `v${i}` : "vout";
      filterParts.push(
        `[${lastLabel}][s${i}]overlay=${x}:${y}:enable='between(t,${startTime.toFixed(3)},${endTime.toFixed(3)})'[${outLabel}]`
      );
      lastLabel = outLabel;
    }
  }

  // Audio filter: position each audio clip at its timeline start time
  if (audioClips.length > 0) {
    for (let i = 0; i < audioClips.length; i++) {
      const clip = audioClips[i];
      const inputIdx = audioStartIdx + i;
      const delayMs = Math.round((clip.startTime || 0) * 1000);
      const dur = clip.duration || 5;
      filterParts.push(
        `[${inputIdx}:a]atrim=0:${dur},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[a${i}]`
      );
    }
    if (audioClips.length === 1) {
      filterParts.push(`[a0]apad=whole_dur=${totalDuration}[aout]`);
    } else {
      const labels = audioClips.map((_, i) => `[a${i}]`).join("");
      filterParts.push(
        `${labels}amix=inputs=${audioClips.length}:duration=longest[aout]`
      );
    }
  }

  // Apply filter_complex if we have any filters
  if (filterParts.length > 0) {
    args.push("-filter_complex", filterParts.join(";"));
  }

  // Map video output
  if (mediaClips.length > 0) {
    args.push("-map", "[vout]");
  } else {
    args.push("-map", "0:v");
  }

  // Map audio output
  if (audioClips.length > 0) {
    args.push("-map", "[aout]");
  }

  // Video codec settings
  if (format === "mp4") {
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
    // Higher CRF values (visually transparent) + slower presets massively cut
    // file size versus the old crf 18 / veryfast combo, with no perceptible loss.
    const crfMap = { low: "30", medium: "26", high: "23", ultra: "19" };
    args.push("-crf", crfMap[quality] || "23");
    args.push("-preset", quality === "ultra" ? "slow" : "medium");
    args.push("-movflags", "+faststart");
  } else if (format === "webm") {
    args.push("-c:v", "libvpx-vp9");
    const crfMap = { low: "42", medium: "36", high: "32", ultra: "24" };
    args.push("-crf", crfMap[quality] || "33");
    args.push("-b:v", "0");
    args.push("-row-mt", "1");
  }

  // Audio codec
  if (audioClips.length > 0) {
    if (format === "mp4") {
      args.push("-c:a", "aac", "-b:a", "192k");
    } else {
      args.push("-c:a", "libopus", "-b:a", "128k");
    }
  } else {
    args.push("-an");
  }

  args.push("-r", String(fps));
  args.push("-t", String(totalDuration));
  args.push(outputPath);

  return args;
}

/**
 * Cancel an active export (supports both legacy and frame-based modes)
 */
function cancelExport() {
  const target = activeExport || activeFrameExport;
  if (target && target.process) {
    target.cancelled = true;
    target.process.kill("SIGKILL");
    activeExport = null;
    activeFrameExport = null;
    return { success: true };
  }
  return { success: false, error: "No active export" };
}

// ============================================
// Frame-by-frame export (canvas-rendered pipeline)
// ============================================

let activeFrameExport = null;

/**
 * Start a frame-by-frame export: spawns ffmpeg with image2pipe stdin for video
 * and file-based inputs for audio clips.
 * @param {Object} settings - { width, height, fps, format, quality, outputPath, audioClips, totalDuration }
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function startFrameExport(settings) {
  const {
    width,
    height,
    fps,
    format = "mp4",
    quality = "high",
    outputPath,
    audioClips = [],
    totalDuration,
  } = settings;

  const ffmpegPath = getFFmpegPath();
  try {
    await fs.access(ffmpegPath);
  } catch {
    return { success: false, error: "FFmpeg not found. Please download it first." };
  }

  // Validate audio files exist
  const validAudioClips = [];
  for (const clip of audioClips) {
    try {
      await fs.access(clip.source);
      validAudioClips.push(clip);
    } catch {
      console.warn(`[VideoExporter] Audio file not found, skipping: ${clip.source}`);
    }
  }

  // Reject if an export is already in progress (prevents global state overwrite)
  if (activeFrameExport) {
    return { success: false, error: "Another export is already in progress" };
  }

  const hasAudio = validAudioClips.length > 0;
  // If we have audio, pipe video to a temp file first and merge audio in a second pass.
  // This avoids the FFmpeg issue where filter_complex can't bind when image2pipe
  // stdin hasn't provided frames yet (stream parameters unknown).
  const videoOutputPath = hasAudio ? outputPath + ".tmp_video." + (format === "webm" ? "webm" : "mp4") : outputPath;

  const args = ["-y"]; // Overwrite output

  // Video input: JPEG frames piped on stdin
  args.push("-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(fps), "-i", "pipe:0");

  // Video codec settings
  if (format === "mp4") {
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
    // Higher CRF values (visually transparent) + slower presets massively cut
    // file size versus the old crf 18 / veryfast combo, with no perceptible loss.
    const crfMap = { low: "30", medium: "26", high: "23", ultra: "19" };
    args.push("-crf", crfMap[quality] || "23");
    args.push("-preset", quality === "ultra" ? "slow" : "medium");
  } else if (format === "webm") {
    args.push("-c:v", "libvpx-vp9");
    const crfMap = { low: "42", medium: "36", high: "32", ultra: "24" };
    args.push("-crf", crfMap[quality] || "33");
    args.push("-b:v", "0");
    args.push("-row-mt", "1");
  }

  // No audio in the pipe phase — audio is merged in a second pass
  args.push("-an");
  // Note: do NOT pass -t here. Duration is controlled by the number of frames
  // the frontend sends + stdin.end() in finishFrameExport(). Using -t causes
  // FFmpeg to exit (code 0) before all frames are consumed during backpressure,
  // producing false "FFmpeg exited during write (code 0)" errors.
  args.push(videoOutputPath);

  const proc = spawn(ffmpegPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  activeFrameExport = {
    process: proc, cancelled: false, stderrData: "", exited: false, exitCode: null,
    // Audio merge metadata (used in finishFrameExport)
    hasAudio,
    audioClips: validAudioClips,
    videoOutputPath,
    finalOutputPath: outputPath,
    totalDuration,
    format,
  };

  proc.stderr.on("data", (data) => {
    activeFrameExport.stderrData += data.toString();
  });

  proc.on("close", (code) => {
    if (activeFrameExport) {
      activeFrameExport.exited = true;
      activeFrameExport.exitCode = code;
      if (code !== 0) {
        console.error(`[VideoExporter] FFmpeg video pipe exited with code ${code}`);
        const relevant = activeFrameExport.stderrData.split("\n")
          .filter(l => l.includes("Error") || l.includes("error") || l.includes("Invalid") || l.includes("No such"))
          .slice(-5);
        if (relevant.length) console.error("[VideoExporter] FFmpeg stderr:", relevant.join("\n"));
      }
    }
  });

  // Handle stdin errors (e.g. pipe broken because ffmpeg crashed)
  proc.stdin.on("error", () => {});

  // Wait briefly to check if FFmpeg exits immediately (e.g., bad arguments).
  // Race between a 50ms safety window and an early-exit event — whichever
  // fires first. This cuts the unconditional wait from 300ms down to ~50ms
  // in the normal case while still catching immediate crashes.
  await Promise.race([
    new Promise((resolve) => proc.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);

  if (activeFrameExport?.exited) {
    const stderrLines = (activeFrameExport.stderrData || "")
      .split("\n")
      .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid") || l.includes("No such") || l.includes("not found"))
      .slice(-5)
      .join(" | ");
    const code = activeFrameExport.exitCode;
    activeFrameExport = null;
    return { success: false, error: `FFmpeg failed to start (code ${code})${stderrLines ? ": " + stderrLines : ""}` };
  }

  return { success: true };
}

/**
 * Write a single JPEG frame to the active frame export's stdin
 * Handles backpressure automatically.
 * @param {Buffer|Uint8Array} frameBuffer - Raw JPEG data
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function writeExportFrame(frameBuffer) {
  return new Promise((resolve) => {
    if (!activeFrameExport || !activeFrameExport.process) {
      return resolve({ success: false, error: "No active export" });
    }

    if (activeFrameExport.exited) {
      // If FFmpeg exited with code 0, it finished successfully — signal the
      // frontend to stop sending frames rather than treating it as an error.
      if (activeFrameExport.exitCode === 0) {
        return resolve({ success: true, done: true });
      }
      const stderrLines = (activeFrameExport.stderrData || "")
        .split("\n")
        .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid") || l.includes("No such"))
        .slice(-5)
        .join(" | ");
      return resolve({ success: false, error: `FFmpeg exited unexpectedly (code ${activeFrameExport.exitCode})${stderrLines ? ": " + stderrLines : ""}` });
    }

    const proc = activeFrameExport.process;

    try {
      const buf = Buffer.isBuffer(frameBuffer)
        ? frameBuffer
        : Buffer.from(frameBuffer);
      const canContinue = proc.stdin.write(buf);

      if (canContinue) {
        resolve({ success: true });
      } else {
        // Back-pressure: wait for drain, but also handle process death
        let resolved = false;
        const onDrain = () => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve({ success: true });
        };
        const onClose = (code) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          // If FFmpeg exited with code 0 during backpressure, it finished
          // encoding all it needed — signal the frontend to stop, not error.
          if (code === 0) {
            resolve({ success: true, done: true });
            return;
          }
          const stderrLines = (activeFrameExport?.stderrData || "")
            .split("\n")
            .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid") || l.includes("No such"))
            .slice(-5)
            .join(" | ");
          resolve({ success: false, error: `FFmpeg exited during write (code ${code})${stderrLines ? ": " + stderrLines : ""}` });
        };
        const onError = (err) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve({ success: false, error: err.message });
        };
        const cleanup = () => {
          proc.stdin.removeListener("drain", onDrain);
          proc.removeListener("close", onClose);
          proc.removeListener("error", onError);
        };

        proc.stdin.once("drain", onDrain);
        proc.once("close", onClose);
        proc.once("error", onError);
      }
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

/**
 * Close stdin and wait for ffmpeg to finish encoding.
 * If audio clips were provided, runs a second FFmpeg pass to merge audio.
 * @returns {Promise<{success: boolean, outputPath?: string, error?: string}>}
 */
function finishFrameExport() {
  return new Promise((resolve) => {
    if (!activeFrameExport || !activeFrameExport.process) {
      return resolve({ success: false, error: "No active export" });
    }

    const proc = activeFrameExport.process;
    const exportState = activeFrameExport;

    // If FFmpeg already exited, handle immediately
    if (exportState.exited) {
      activeFrameExport = null;
      if (exportState.cancelled) {
        return resolve({ success: false, error: "Export cancelled" });
      } else if (exportState.exitCode === 0) {
        // Video pipe done — check if we need audio merge
        return resolveWithAudioMerge(exportState, resolve);
      } else {
        const errorLines = (exportState.stderrData || "")
          .split("\n")
          .filter((l) => l.includes("Error") || l.includes("error"))
          .slice(-3)
          .join("\n");
        return resolve({
          success: false,
          error: errorLines || `FFmpeg exited with code ${exportState.exitCode}`,
        });
      }
    }

    proc.stdin.end();

    proc.on("close", (code) => {
      activeFrameExport = null;

      if (exportState.cancelled) {
        resolve({ success: false, error: "Export cancelled" });
      } else if (code === 0) {
        // Video pipe done — check if we need audio merge
        resolveWithAudioMerge(exportState, resolve);
      } else {
        const errorLines = (exportState.stderrData || "")
          .split("\n")
          .filter((l) => l.includes("Error") || l.includes("error"))
          .slice(-3)
          .join("\n");
        resolve({
          success: false,
          error: errorLines || `FFmpeg exited with code ${code}`,
        });
      }
    });

    proc.on("error", (err) => {
      activeFrameExport = null;
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * After video pipe finishes, merge audio if needed, then resolve.
 */
async function resolveWithAudioMerge(exportState, resolve) {
  if (!exportState.hasAudio || exportState.audioClips.length === 0) {
    return resolve({ success: true });
  }

  try {
    console.log("[VideoExporter] Video pipe done, merging audio...");
    await mergeAudioWithVideo(exportState);
    // Clean up temp video file
    try { await fs.unlink(exportState.videoOutputPath); } catch {}
    console.log("[VideoExporter] Audio merge complete");
    resolve({ success: true });
  } catch (err) {
    console.error("[VideoExporter] Audio merge failed:", err.message);
    // Clean up temp file on failure too
    try { await fs.unlink(exportState.videoOutputPath); } catch {}
    resolve({ success: false, error: err.message });
  }
}

/**
 * Check if a file actually contains an audio stream using ffprobe.
 */
function probeAudioStream(filePath) {
  return new Promise((resolve) => {
    let ffprobePath;
    try { ffprobePath = getFFprobePath(); } catch { return resolve(false); }

    const proc = spawn(ffprobePath, [
      "-v", "quiet", "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", filePath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", (code) => resolve(code === 0 && stdout.trim().length > 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Second-pass FFmpeg: merge the temp video file with audio clips.
 * Uses -c:v copy so video is NOT re-encoded (fast).
 * Each audio input is verified via ffprobe before inclusion.
 */
function mergeAudioWithVideo(exportState) {
  const { videoOutputPath, finalOutputPath, audioClips, totalDuration, format } = exportState;

  return new Promise(async (resolve, reject) => {
    const ffmpegPath = getFFmpegPath();

    // Verify each audio input actually has an audio stream (in parallel)
    const probeResults = await Promise.all(audioClips.map((clip) => probeAudioStream(clip.source)));
    const verifiedClips = audioClips.filter((clip, i) => {
      if (!probeResults[i]) {
        console.warn(`[VideoExporter] Skipping audio input (no audio stream): ${clip.source}`);
        return false;
      }
      return true;
    });

    if (verifiedClips.length === 0) {
      console.log("[VideoExporter] No valid audio streams found, skipping merge");
      try {
        await fs.rename(videoOutputPath, finalOutputPath);
      } catch {
        await fs.copyFile(videoOutputPath, finalOutputPath);
      }
      return resolve();
    }

    const args = ["-y"];

    // Input 0: temp video file (no pipe — fully seekable)
    args.push("-i", videoOutputPath);

    // Audio file inputs (verified to have audio streams)
    for (const clip of verifiedClips) {
      args.push("-i", clip.source);
    }

    // Audio filter complex
    const filterParts = [];
    for (let i = 0; i < verifiedClips.length; i++) {
      const clip = verifiedClips[i];
      const inputIdx = i + 1; // 0 = video file
      const delayMs = Math.round((clip.startTime || 0) * 1000);
      const trimStart = parseFloat(clip.trimStart) || 0;
      const dur = parseFloat(clip.duration) || 5;
      const vol = parseFloat(clip.volume ?? 1);

      // Build the filter chain for this audio clip
      // When atempoFactor is set, trim the full original audio length before speeding up
      const atempo = parseFloat(clip.atempoFactor) || 0;
      const trimDur = atempo > 1 ? dur * atempo : dur;
      let chain = `[${inputIdx}:a]atrim=${trimStart}:${trimStart + trimDur},asetpts=PTS-STARTPTS`;

      // Apply atempo speed-up if the clip has an atempoFactor > 1
      // FFmpeg atempo supports 0.5–100.0 per instance; chain for extreme values
      if (atempo > 1) {
        let remaining = atempo;
        while (remaining > 1.001) {
          const step = Math.min(remaining, 100.0);
          chain += `,atempo=${step}`;
          remaining /= step;
        }
      }

      chain += `,adelay=${delayMs}|${delayMs},volume=${vol}[a${i}]`;
      filterParts.push(chain);
    }
    if (verifiedClips.length === 1) {
      filterParts.push(`[a0]apad=whole_dur=${totalDuration}[aout]`);
    } else {
      const labels = verifiedClips.map((_, i) => `[a${i}]`).join("");
      filterParts.push(
        `${labels}amix=inputs=${verifiedClips.length}:duration=longest[aout]`
      );
    }

    args.push("-filter_complex", filterParts.join(";"));
    args.push("-map", "0:v", "-map", "[aout]");

    // Copy video (no re-encode), encode audio only
    args.push("-c:v", "copy");
    if (format === "mp4") {
      args.push("-c:a", "aac", "-b:a", "160k");
      args.push("-movflags", "+faststart");
    } else {
      args.push("-c:a", "libopus", "-b:a", "128k");
    }

    args.push("-t", String(totalDuration));
    args.push(finalOutputPath);

    console.log("[VideoExporter] Audio merge cmd:", args.join(" "));

    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errorLines = stderr
          .split("\n")
          .filter((l) => l.includes("Error") || l.includes("error") || l.includes("Invalid"))
          .slice(-5)
          .join(" | ");
        reject(new Error(`Audio merge failed (code ${code})${errorLines ? ": " + errorLines : ""}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

/**
 * Get video file metadata using ffprobe
 */
async function getVideoMetadata(filePath) {
  const ffprobePath = getFFprobePath();

  try {
    await fs.access(ffprobePath);
  } catch {
    return { success: false, error: "FFprobe not found" };
  }

  return new Promise((resolve) => {
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ];

    const proc = spawn(ffprobePath, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout);
          const videoStream = (data.streams || []).find(
            (s) => s.codec_type === "video"
          );
          const audioStream = (data.streams || []).find(
            (s) => s.codec_type === "audio"
          );

          resolve({
            success: true,
            duration: parseFloat(data.format?.duration) || 0,
            width: videoStream?.width || 0,
            height: videoStream?.height || 0,
            fps: (() => {
                const rate = videoStream?.r_frame_rate || "30/1";
                const parts = rate.split("/");
                return parts.length === 2
                  ? parseInt(parts[0]) / parseInt(parts[1])
                  : parseFloat(rate) || 30;
              })(),
            codec: videoStream?.codec_name || "",
            hasAudio: !!audioStream,
            fileSize: parseInt(data.format?.size) || 0,
          });
        } catch (err) {
          resolve({ success: false, error: "Failed to parse metadata" });
        }
      } else {
        resolve({ success: false, error: stderr || `ffprobe error code ${code}` });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Decode a video clip to an EVEN constant-frame-rate JPEG sequence using FFmpeg.
 *
 * This is the smooth-export path: instead of seeking an HTML <video> element per
 * output frame (imprecise for VFR / odd-fps AI videos, which causes periodic
 * freezes), FFmpeg's `fps` filter resamples the source to exactly `fps` evenly
 * spaced frames. The renderer then draws frame N directly — no browser seeking.
 *
 * @param {Object} opts
 * @param {string} opts.source - Absolute path to the source video
 * @param {number} [opts.trimStart=0] - Seconds to skip from the start of the source
 * @param {number} opts.duration - Seconds of the clip to extract
 * @param {number} opts.fps - Target (export) frame rate
 * @param {number} [opts.maxWidth] - Cap output width (scaled, aspect preserved)
 * @param {number} [opts.maxHeight] - Cap output height (scaled, aspect preserved)
 * @returns {Promise<{success: boolean, dir?: string, frameCount?: number, error?: string}>}
 */
async function extractVideoFramesCFR(opts = {}) {
  const {
    source,
    trimStart = 0,
    duration,
    fps,
    maxWidth = 0,
    maxHeight = 0,
  } = opts;

  if (!source || !duration || duration <= 0 || !fps || fps <= 0) {
    return { success: false, error: "Invalid extraction parameters" };
  }

  const ffmpegPath = getFFmpegPath();
  try {
    await fs.access(ffmpegPath);
  } catch {
    return { success: false, error: "FFmpeg not found" };
  }
  try {
    await fs.access(source);
  } catch {
    return { success: false, error: "Source video not found" };
  }

  // Unique temp dir for this clip's frames
  const baseTmp = app ? app.getPath("temp") : require("os").tmpdir();
  const dir = path.join(
    baseTmp,
    `ve_frames_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    return { success: false, error: `Failed to create temp dir: ${err.message}` };
  }

  // Build the scale filter (only downscale, never upscale; keep even dims).
  const filters = [`fps=${fps}`];
  if (maxWidth > 0 && maxHeight > 0) {
    filters.push(
      `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`,
      `scale=trunc(iw/2)*2:trunc(ih/2)*2`
    );
  }

  const args = [
    "-y",
    // -ss before -i = fast seek to the trim point
    "-ss",
    String(trimStart),
    "-i",
    source,
    "-t",
    String(duration),
    "-an",
    "-vf",
    filters.join(","),
    "-q:v",
    "2", // near-lossless intermediate JPEG quality
    "-start_number",
    "0",
    path.join(dir, "f_%06d.jpg"),
  ];

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
    proc.on("close", async (code) => {
      if (code !== 0) {
        try { await cleanupExtractedFrames(dir); } catch (_) {}
        const relevant = stderr
          .split("\n")
          .filter((l) => /error|invalid|no such|not found/i.test(l))
          .slice(-3)
          .join(" | ");
        return resolve({
          success: false,
          error: `FFmpeg frame extraction failed (code ${code})${relevant ? ": " + relevant : ""}`,
        });
      }
      try {
        const files = await fs.readdir(dir);
        const frameCount = files.filter((f) => f.endsWith(".jpg")).length;
        if (frameCount === 0) {
          try { await cleanupExtractedFrames(dir); } catch (_) {}
          return resolve({ success: false, error: "No frames were extracted" });
        }
        resolve({ success: true, dir, frameCount });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  });
}

/**
 * Delete a temp frame directory created by extractVideoFramesCFR.
 * @param {string} dir
 * @returns {Promise<{success: boolean}>}
 */
async function cleanupExtractedFrames(dir) {
  if (!dir) return { success: false };
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return { success: true };
  } catch {
    return { success: false };
  }
}

module.exports = {
  exportVideo,
  cancelExport,
  getVideoMetadata,
  startFrameExport,
  writeExportFrame,
  finishFrameExport,
  extractVideoFramesCFR,
  cleanupExtractedFrames,
};
