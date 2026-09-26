const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");
const { app } = require("electron");
const { getFFmpegPath, getFFprobePath } = require("../lib/ffmpegManager");

/**
 * Extracts a frame from a video and saves it as an image.
 *
 * @param {string} videoPath - Path to the video file
 * @param {string} frameMode - "first", "last", or "specific"
 * @param {number} [frameNumber=1] - Frame number to extract (used when frameMode is "specific")
 * @param {number} [timeoutMs=60000] - Maximum time to wait
 * @returns {Promise<{success: boolean, value: string}>}
 */
async function videoToImage(videoPath, frameMode, frameNumber = 1, timeoutMs = 60000) {
  if (!videoPath) {
    return { success: false, value: "Video path is required" };
  }

  try {
    await fs.access(videoPath);
  } catch {
    return { success: false, value: "Video file not found: " + videoPath };
  }

  const ffmpegPath = getFFmpegPath();
  const ffprobePath = getFFprobePath();

  try {
    await fs.access(ffmpegPath);
  } catch {
    return { success: false, value: "FFmpeg not found. Please install FFmpeg from Settings." };
  }

  const downloadsDir = path.join(app.getPath("userData"), "Downloads");
  await fs.mkdir(downloadsDir, { recursive: true });
  const outputPath = path.join(downloadsDir, `frame_${Date.now()}.png`);

  try {
    if (frameMode === "last") {
      // Get video duration first
      const metadata = await getVideoDuration(ffprobePath, videoPath);
      if (!metadata.success) {
        return { success: false, value: metadata.error };
      }
      // Seek to near the end and extract the last frame
      const seekTime = Math.max(0, metadata.duration - 0.1);
      await extractFrameAtTime(ffmpegPath, videoPath, outputPath, seekTime, true, timeoutMs);
    } else if (frameMode === "specific") {
      const num = parseInt(frameNumber, 10);
      if (isNaN(num) || num < 1) {
        return { success: false, value: "Frame number must be a positive integer" };
      }
      // Get FPS to calculate timestamp
      const metadata = await getVideoDuration(ffprobePath, videoPath);
      if (!metadata.success) {
        return { success: false, value: metadata.error };
      }
      const timestamp = (num - 1) / metadata.fps;
      if (timestamp > metadata.duration) {
        return { success: false, value: `Frame ${num} is beyond video duration (${Math.round(metadata.duration * metadata.fps)} total frames)` };
      }
      await extractFrameAtTime(ffmpegPath, videoPath, outputPath, timestamp, false, timeoutMs);
    } else {
      // Default: first frame
      await extractFrameAtTime(ffmpegPath, videoPath, outputPath, 0, false, timeoutMs);
    }

    // Verify output exists
    await fs.access(outputPath);
    return { success: true, value: outputPath };
  } catch (err) {
    return { success: false, value: "Frame extraction failed: " + err.message };
  }
}

function getVideoDuration(ffprobePath, videoPath) {
  return new Promise((resolve) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      videoPath
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
          const videoStream = (data.streams || []).find((s) => s.codec_type === "video");
          const duration = parseFloat(data.format?.duration) || 0;
          const rate = videoStream?.r_frame_rate || "30/1";
          const parts = rate.split("/");
          const fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(rate) || 30;
          resolve({ success: true, duration, fps });
        } catch {
          resolve({ success: false, error: "Failed to parse video metadata" });
        }
      } else {
        resolve({ success: false, error: stderr || "FFprobe failed" });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

function extractFrameAtTime(ffmpegPath, videoPath, outputPath, timestamp, lastFrame, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ["-y"];

    if (timestamp > 0) {
      args.push("-ss", String(timestamp));
    }

    args.push("-i", videoPath);

    if (lastFrame) {
      // Seek near end, then use -sseof for the very last frame
      args.length = 0;
      args.push("-y", "-sseof", "-0.1", "-i", videoPath, "-frames:v", "1", "-update", "1", outputPath);
    } else {
      args.push("-frames:v", "1", outputPath);
    }

    const proc = spawn(ffmpegPath, args);
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Frame extraction timed out"));
    }, timeoutMs);

    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `FFmpeg exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { videoToImage };
