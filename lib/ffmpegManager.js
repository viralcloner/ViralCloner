/**
 * FFmpeg Manager - Downloads and manages ffmpeg/ffprobe binaries
 * Stored in userData/ffmpeg/
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fss = require("fs");
const https = require("https");
const { execFile } = require("child_process");

const FFMPEG_DIR = path.join(app.getPath("userData"), "ffmpeg");

// Platform-specific download URLs (BtbN builds for Windows)
const FFMPEG_RELEASE_URL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

function getFFmpegPath() {
  return path.join(FFMPEG_DIR, "bin", "ffmpeg.exe");
}

function getFFprobePath() {
  return path.join(FFMPEG_DIR, "bin", "ffprobe.exe");
}

/**
 * Check if ffmpeg is available and working
 */
async function checkFFmpeg() {
  const ffmpegPath = getFFmpegPath();
  try {
    await fs.access(ffmpegPath, fs.constants.X_OK);
    // Verify it actually runs
    return new Promise((resolve) => {
      execFile(ffmpegPath, ["-version"], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve({ installed: false, error: err.message });
        } else {
          const versionMatch = stdout.match(/ffmpeg version (\S+)/);
          resolve({
            installed: true,
            version: versionMatch ? versionMatch[1] : "unknown",
            path: ffmpegPath,
          });
        }
      });
    });
  } catch {
    return { installed: false };
  }
}

/**
 * Download ffmpeg with progress reporting
 * @param {Function} onProgress - (percent, downloadedMB, totalMB) callback
 */
async function downloadFFmpeg(onProgress) {
  await fs.mkdir(FFMPEG_DIR, { recursive: true });

  const zipPath = path.join(FFMPEG_DIR, "ffmpeg.zip");

  // Follow redirects and download
  await downloadWithRedirects(FFMPEG_RELEASE_URL, zipPath, onProgress);

  // Extract
  if (onProgress) onProgress(-1, 0, 0); // -1 signals extracting phase

  const extract = require("extract-zip");
  const extractDir = path.join(FFMPEG_DIR, "_extracted");
  await fs.mkdir(extractDir, { recursive: true });
  await extract(zipPath, { dir: extractDir });

  // Find ffmpeg and ffprobe binaries in extracted content
  const binDir = path.join(FFMPEG_DIR, "bin");
  await fs.mkdir(binDir, { recursive: true });

  // Recursively find the binaries
  async function findBinaries(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await findBinaries(fullPath);
      } else if (entry.name === "ffmpeg.exe" || entry.name === "ffprobe.exe") {
        await fs.copyFile(fullPath, path.join(binDir, entry.name));
      }
    }
  }
  await findBinaries(extractDir);

  // Cleanup zip and extracted directory
  await fs.unlink(zipPath).catch(() => {});
  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});

  // Verify
  const check = await checkFFmpeg();
  if (!check.installed) {
    throw new Error("FFmpeg extraction failed - binary not working");
  }

  return check;
}

/**
 * Download with redirect following (GitHub releases redirect to CDN)
 */
function downloadWithRedirects(url, destPath, onProgress, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function doRequest(currentUrl, redirectCount) {
      if (redirectCount > maxRedirects) {
        return reject(new Error("Too many redirects"));
      }

      const parsedUrl = new URL(currentUrl);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { "User-Agent": "ViralCloner/1.0" },
      };

      https
        .get(options, (res) => {
          // Follow redirects
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume(); // consume response
            return doRequest(res.headers.location, redirectCount + 1);
          }

          if (res.statusCode !== 200) {
            res.resume();
            return reject(
              new Error(`Download failed with status ${res.statusCode}`)
            );
          }

          const totalBytes = parseInt(res.headers["content-length"], 10) || 0;
          let downloadedBytes = 0;

          const writeStream = fss.createWriteStream(destPath);

          res.on("data", (chunk) => {
            downloadedBytes += chunk.length;
            if (onProgress && totalBytes > 0) {
              const percent = Math.round(
                (downloadedBytes / totalBytes) * 100
              );
              const downloadedMB = (downloadedBytes / 1048576).toFixed(1);
              const totalMB = (totalBytes / 1048576).toFixed(1);
              onProgress(percent, downloadedMB, totalMB);
            }
          });

          res.pipe(writeStream);

          writeStream.on("finish", () => {
            writeStream.close();
            resolve();
          });

          writeStream.on("error", (err) => {
            writeStream.close();
            fs.unlink(destPath).catch(() => {});
            reject(err);
          });
        })
        .on("error", (err) => {
          reject(err);
        });
    }

    doRequest(url, 0);
  });
}

/**
 * Remove ffmpeg installation
 */
async function removeFFmpeg() {
  try {
    await fs.rm(FFMPEG_DIR, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  checkFFmpeg,
  downloadFFmpeg,
  removeFFmpeg,
  getFFmpegPath,
  getFFprobePath,
};
