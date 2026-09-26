const { dialog, app } = require("electron");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const sharp = require("sharp");
const { ssim } = require("ssim.js");
const { generateRandomString, readKey } = require("../lib/utils");

/**
 * Convert a title into a URL/filename-safe slug.
 * "Burger Recipe!" -> "burger-recipe". Returns "" if nothing usable remains
 * (e.g. titles in non-latin scripts), so callers can fall back to the index.
 */
function slugifyTitle(title, maxLen = 60) {
  if (!title || typeof title !== "string") return "";
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

/**
 * ============================================================================
 * PERCEPTUAL HASH (pHash) WITH DCT - Industry Standard (Facebook/Google style)
 * ============================================================================
 * This implementation uses Discrete Cosine Transform (DCT), the same approach
 * used by Facebook's PDQ hash and other major platforms for image similarity.
 * 
 * How it works:
 * 1. Resize image to 32x32 (captures enough detail)
 * 2. Convert to grayscale
 * 3. Apply 2D DCT (Discrete Cosine Transform) - like JPEG compression
 * 4. Take top-left 8x8 block (low frequencies = overall structure)
 * 5. Create 64-bit hash based on median comparison
 * 
 * This detects ACTUAL visual similarity, not just color similarity.
 * Two images need similar structure/edges/layout to match.
 */

/**
 * Calculate SSIM (Structural Similarity Index) between two images
 * SSIM is designed to match human perception of image similarity
 * Returns similarity percentage (0-100)
 */
const SSIM_SIZE = 256; // Size to resize images for SSIM comparison

async function calculateSSIM(imagePath1, imagePath2) {
  try {
    // Load and resize both images to same dimensions, convert to grayscale
    const [img1Data, img2Data] = await Promise.all([
      sharp(imagePath1)
        .resize(SSIM_SIZE, SSIM_SIZE, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(imagePath2)
        .resize(SSIM_SIZE, SSIM_SIZE, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);

    // Convert raw buffers to format expected by ssim.js
    // ssim.js expects { data: Uint8Array, width, height, channels }
    const ssimResult = ssim(
      {
        data: new Uint8Array(img1Data.data),
        width: SSIM_SIZE,
        height: SSIM_SIZE,
        channels: 1,
      },
      {
        data: new Uint8Array(img2Data.data),
        width: SSIM_SIZE,
        height: SSIM_SIZE,
        channels: 1,
      }
    );

    // mssim is the mean SSIM value (0-1 scale)
    return ssimResult.mssim * 100;
  } catch (error) {
    console.warn("Error calculating SSIM:", error.message);
    return null;
  }
}

/**
 * Calculate perceptual hash similarity between two images using hybrid approach
 * Combines SSIM (human perception) with DCT-based pHash (structural patterns)
 * Returns similarity percentage (0-100) where 100 means visually identical
 * 
 * Scores are normalized so that completely unrelated images score near 0%
 * and identical/near-identical images score near 100%.
 */
async function calculateImageSimilarity(imagePath1, imagePath2) {
  try {
    if (!imagePath1 || !imagePath2) return null;

    // Check both files exist
    try {
      await fsp.access(imagePath1);
      await fsp.access(imagePath2);
    } catch {
      return null;
    }

    // Quick check: identical file hashes means identical images
    const hash1 = await getFileHash(imagePath1);
    const hash2 = await getFileHash(imagePath2);

    if (hash1 === hash2) {
      return 100; // Identical files
    }

    // Calculate both SSIM and pHash in parallel for hybrid scoring
    const [ssimScore, pHashResult] = await Promise.all([
      calculateSSIM(imagePath1, imagePath2),
      (async () => {
        const pHash1 = await calculateDCTHash(imagePath1);
        const pHash2 = await calculateDCTHash(imagePath2);
        if (!pHash1 || !pHash2) return null;
        return calculateHashSimilarity(pHash1, pHash2);
      })(),
    ]);

    // Normalize scores to use the full 0-100 range:
    // - pHash raw ~50% for random images (50% bits match by chance), ~100% for identical
    //   Remap: 50% → 0%, 100% → 100%
    // - SSIM raw ~30-40% for unrelated images, ~100% for identical
    //   Remap: 35% → 0%, 100% → 100%
    const normalizePHash = (raw) => Math.max(0, Math.min(100, ((raw - 50) / 50) * 100));
    const normalizeSSIM = (raw) => Math.max(0, Math.min(100, ((raw - 35) / 65) * 100));

    let normalizedSSIM = ssimScore !== null ? normalizeSSIM(ssimScore) : null;
    let normalizedPHash = pHashResult !== null ? normalizePHash(pHashResult) : null;

    // If SSIM failed, fall back to pHash only
    if (normalizedSSIM === null) {
      return normalizedPHash !== null ? Math.round(normalizedPHash) : null;
    }

    // If pHash failed, use SSIM only
    if (normalizedPHash === null) {
      return Math.round(normalizedSSIM);
    }

    // Hybrid scoring: SSIM weighted 60% (human perception), pHash 40% (structure)
    const hybridScore = normalizedSSIM * 0.6 + normalizedPHash * 0.4;
    return Math.round(Math.max(0, Math.min(100, hybridScore)));
  } catch (error) {
    console.warn("Error calculating image similarity:", error.message);
    return null;
  }
}

/**
 * Pre-compute DCT coefficients for efficiency (cosine values)
 */
const DCT_SIZE = 32;
const HASH_SIZE = 8;
let dctCoefficients = null;

function initDCTCoefficients() {
  if (dctCoefficients) return dctCoefficients;
  
  dctCoefficients = [];
  for (let i = 0; i < DCT_SIZE; i++) {
    dctCoefficients[i] = [];
    for (let j = 0; j < DCT_SIZE; j++) {
      dctCoefficients[i][j] = Math.cos((Math.PI / DCT_SIZE) * (j + 0.5) * i);
    }
  }
  return dctCoefficients;
}

/**
 * Apply 1D DCT to a row/column
 */
function dct1D(input, coeffs) {
  const n = input.length;
  const output = new Array(n);
  
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i] * coeffs[k][i];
    }
    // Apply normalization factor
    const scale = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    output[k] = sum * scale;
  }
  return output;
}

/**
 * Apply 2D DCT to image matrix
 */
function dct2D(matrix, size, coeffs) {
  // First apply DCT to rows
  const rowDCT = [];
  for (let i = 0; i < size; i++) {
    rowDCT[i] = dct1D(matrix[i], coeffs);
  }
  
  // Then apply DCT to columns
  const result = [];
  for (let i = 0; i < size; i++) {
    result[i] = [];
  }
  
  for (let j = 0; j < size; j++) {
    const column = [];
    for (let i = 0; i < size; i++) {
      column[i] = rowDCT[i][j];
    }
    const colDCT = dct1D(column, coeffs);
    for (let i = 0; i < size; i++) {
      result[i][j] = colDCT[i];
    }
  }
  
  return result;
}

/**
 * Calculate DCT-based perceptual hash (pHash)
 * This is the industry-standard approach used by Facebook, Google, etc.
 * Returns a 64-bit hash as an array of 0s and 1s
 */
async function calculateDCTHash(imagePath) {
  try {
    // Initialize DCT coefficients if not done
    const coeffs = initDCTCoefficients();
    
    // Resize to 32x32 and convert to grayscale
    const { data } = await sharp(imagePath)
      .resize(DCT_SIZE, DCT_SIZE, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Convert to 2D matrix
    const matrix = [];
    for (let i = 0; i < DCT_SIZE; i++) {
      matrix[i] = [];
      for (let j = 0; j < DCT_SIZE; j++) {
        matrix[i][j] = data[i * DCT_SIZE + j];
      }
    }

    // Apply 2D DCT
    const dctMatrix = dct2D(matrix, DCT_SIZE, coeffs);

    // Extract top-left 8x8 block (low frequencies = overall structure)
    // Skip [0][0] as it's just the average brightness (DC component)
    const lowFreq = [];
    for (let i = 0; i < HASH_SIZE; i++) {
      for (let j = 0; j < HASH_SIZE; j++) {
        if (i === 0 && j === 0) continue; // Skip DC component
        lowFreq.push(dctMatrix[i][j]);
      }
    }

    // Calculate median of low frequency values
    const sorted = [...lowFreq].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Create hash: 1 if value >= median, 0 otherwise
    // This creates a 63-bit hash (64 minus the DC component)
    const hash = [];
    for (let i = 0; i < HASH_SIZE; i++) {
      for (let j = 0; j < HASH_SIZE; j++) {
        if (i === 0 && j === 0) {
          hash.push(0); // Placeholder for DC component
          continue;
        }
        hash.push(dctMatrix[i][j] >= median ? 1 : 0);
      }
    }

    return hash;
  } catch (error) {
    console.warn("Error calculating DCT hash:", error.message);
    return null;
  }
}

/**
 * Calculate similarity percentage between two perceptual hashes
 * Uses Hamming distance - counts matching bits
 */
function calculateHashSimilarity(hash1, hash2) {
  if (hash1.length !== hash2.length) return 0;

  let matchingBits = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] === hash2[i]) {
      matchingBits++;
    }
  }

  return Math.round((matchingBits / hash1.length) * 100);
}

/**
 * Get MD5 hash of a file
 */
async function getFileHash(filePath) {
  const buffer = await fsp.readFile(filePath);
  return crypto.createHash("md5").update(buffer).digest("hex");
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const request = protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(dest);
      response.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(resolve));
    });

    request.on("error", reject);
  });
}

// Recursively search for a file by name in a directory (with depth limit)
async function findFileInDirectory(
  dirPath,
  fileName,
  maxDepth = 3,
  currentDepth = 0,
) {
  try {
    if (!fs.existsSync(dirPath)) return null;
    if (currentDepth > maxDepth) return null;

    const entries = await fsp.readdir(dirPath, { withFileTypes: true });

    // First check files at this level (faster)
    for (const entry of entries) {
      if (!entry.isDirectory() && entry.name === fileName) {
        return path.join(dirPath, entry.name);
      }
    }

    // Then recurse into directories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(dirPath, entry.name);
        const found = await findFileInDirectory(
          fullPath,
          fileName,
          maxDepth,
          currentDepth + 1,
        );
        if (found) return found;
      }
    }

    return null;
  } catch (error) {
    console.warn(`Error searching directory ${dirPath}:`, error.message);
    return null;
  }
}

/**
 * Resolve an image path to an absolute path, checking multiple locations
 * @param {string} imagePath - The image path (can be URL, absolute, or relative)
 * @param {string} imagesFolder - The Images folder path
 * @param {string} uploadsTemp - The Uploads/Temp folder path
 * @param {string} destPath - Destination path for downloaded/copied file
 * @returns {Promise<string|null>} - Resolved absolute path or null if not found
 */
async function resolveImagePath(
  imagePath,
  imagesFolder,
  uploadsTemp,
  destPath = null,
) {
  if (!imagePath) return null;

  try {
    // If it's a URL, download it
    if (/^https?:\/\//i.test(imagePath)) {
      if (!destPath) return null;
      await downloadFile(imagePath, destPath);
      return destPath;
    }

    const baseName = path.basename(imagePath);
    const locationsToTry = [];

    // 1. Original path if absolute
    if (path.isAbsolute(imagePath)) {
      locationsToTry.push(imagePath);
    }

    // 2. Images folder with basename
    locationsToTry.push(path.join(imagesFolder, baseName));

    // 3. Images folder with full relative path
    if (!path.isAbsolute(imagePath)) {
      locationsToTry.push(path.join(imagesFolder, imagePath));
    }

    // 4. Uploads/Temp with basename
    locationsToTry.push(path.join(uploadsTemp, baseName));

    // 5. Search for output_* prefixed version in Images
    locationsToTry.push(path.join(imagesFolder, `output_*_${baseName}`));

    for (const tryPath of locationsToTry) {
      // Handle wildcard pattern
      if (tryPath.includes("*")) {
        const dir = path.dirname(tryPath);
        const pattern = path.basename(tryPath);
        try {
          const files = await fsp.readdir(dir);
          const regex = new RegExp("^" + pattern.replace("*", ".*") + "$");
          const match = files.find((f) => regex.test(f));
          if (match) {
            const matchPath = path.join(dir, match);
            if (destPath) {
              await fsp.copyFile(matchPath, destPath);
              return destPath;
            }
            return matchPath;
          }
        } catch {}
        continue;
      }

      try {
        await fsp.access(tryPath);
        if (destPath) {
          await fsp.copyFile(tryPath, destPath);
          return destPath;
        }
        return tryPath;
      } catch {
        // Continue to next location
      }
    }

    // Last resort: recursive search in Uploads/Temp
    const foundInTemp = await findFileInDirectory(uploadsTemp, baseName, 2);
    if (foundInTemp) {
      if (destPath) {
        await fsp.copyFile(foundInTemp, destPath);
        return destPath;
      }
      return foundInTemp;
    }

    return null;
  } catch (error) {
    console.warn("Error resolving image path:", imagePath, error.message);
    return null;
  }
}

async function exportFlowImages(posts, webContents = null) {
  if (!Array.isArray(posts) || posts.length === 0) return false;

  // Whether to use the post title as a slug in exported image filenames
  // (e.g. "1-burger-recipe.jpg"). Numbers stay first to keep files sorted.
  let useTitleSlug = false;
  try {
    const autoSettings = await readKey("automationSettings");
    useTitleSlug = !!(autoSettings && autoSettings.useTitleSlugInImageName);
  } catch (e) {
    /* ignore — default to numeric filenames */
  }

  const tempFolder = path.join(
    app.getPath("userData"),
    "Uploads",
    "Temp",
    generateRandomString(10),
  );
  await fsp.mkdir(tempFolder, { recursive: true });

  // Images folder where workflow images are stored
  const imagesFolder = path.join(app.getPath("userData"), "Images");
  // Uploads/Temp folder where temp images may be stored
  const uploadsTemp = path.join(app.getPath("userData"), "Uploads", "Temp");

  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Select folder to save images",
  });

  if (canceled || !filePaths.length) return false;

  // Notify renderer that processing is starting (after folder selection)
  if (webContents) {
    try {
      webContents.send("export-processing-started");
    } catch (e) {
      console.warn(
        "Could not send export-processing-started event:",
        e.message,
      );
    }
  }

  const localFiles = [];
  const newPosts = [];

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    console.log(`[EXPORT ${i + 1}/${posts.length}] Processing: ${post.image || post.video || post.videoUrl || '(no media)'}`);
    if (post.originalImage) {
      console.log(`[EXPORT ${i + 1}] Original image: ${post.originalImage}`);
    }

    try {
      let hasImageFile = false;
      let hasVideoFile = false;

      // --- IMAGE HANDLING ---
      let newTempPath = null;
      let newFileName = null;
      let originalImagePath = null;
      let originalFileName = null;
      let similarity = null;
      let exportIndex = null;

      if (post.image) {
        // First resolve the source path without copying to get the actual file extension
        const sourcePath = await resolveImagePath(
          post.image,
          imagesFolder,
          uploadsTemp,
          null, // Don't copy yet
        );
        if (sourcePath) {
          const actualExt = path.extname(sourcePath) || '.png';
          // Optionally prefix the filename with a slug built from the post title,
          // keeping the index first so files stay naturally sorted.
          let baseName = `${i + 1}`;
          if (useTitleSlug && post.title) {
            const slug = slugifyTitle(post.title);
            if (slug) baseName = `${i + 1}-${slug}`;
          }
          newFileName = `${baseName}${actualExt}`;
          newTempPath = path.join(tempFolder, newFileName);
          await fsp.copyFile(sourcePath, newTempPath);
          console.log(`[EXPORT ${i + 1}] ✓ Generated image resolved (${actualExt})`);
          hasImageFile = true;

          // Original image
          const origExt = actualExt;
          originalFileName = `original_${i + 1}${origExt}`;
          const originalTempPath = path.join(tempFolder, originalFileName);

          if (post.originalImage) {
            originalImagePath = await resolveImagePath(
              post.originalImage,
              imagesFolder,
              uploadsTemp,
              originalTempPath,
            );
            if (originalImagePath) {
              console.log(`[EXPORT ${i + 1}] ✓ Original image resolved`);
              similarity = await calculateImageSimilarity(
                originalTempPath,
                newTempPath,
              );
              if (similarity !== null) {
                console.log(`[EXPORT ${i + 1}] Similarity: ${similarity}%`);
              }
            } else {
              console.log(`[EXPORT ${i + 1}] ⚠ Original image not found, skipping comparison`);
              originalFileName = null;
            }
          } else {
            originalFileName = null;
          }

          localFiles.push(newTempPath);
          exportIndex = i + 1;
        }
      }

      // --- VIDEO HANDLING ---
      const videoSource = post.video || post.videoUrl || null;
      let videoTempPath = null;
      let videoFileName = null;

      if (videoSource && !videoSource.startsWith("http")) {
        // Local video file — resolve and copy to export folder
        const videoExt = path.extname(videoSource) || '.mp4';
        videoFileName = `video_${i + 1}${videoExt}`;
        videoTempPath = path.join(tempFolder, videoFileName);

        try {
          // Try direct path first
          if (fs.existsSync(videoSource)) {
            await fsp.copyFile(videoSource, videoTempPath);
            hasVideoFile = true;
            localFiles.push(videoTempPath);
            console.log(`[EXPORT ${i + 1}] ✓ Video file copied`);
          } else {
            // Try resolving like an image (check Images/ and Uploads/Temp/ folders)
            const resolved = await resolveImagePath(videoSource, imagesFolder, uploadsTemp, null);
            if (resolved) {
              await fsp.copyFile(resolved, videoTempPath);
              hasVideoFile = true;
              localFiles.push(videoTempPath);
              console.log(`[EXPORT ${i + 1}] ✓ Video file resolved and copied`);
            } else {
              console.log(`[EXPORT ${i + 1}] ⚠ Video file not found: ${videoSource}`);
              videoTempPath = null;
              videoFileName = null;
            }
          }
        } catch (videoErr) {
          console.warn(`[EXPORT ${i + 1}] Video copy failed:`, videoErr.message);
          videoTempPath = null;
          videoFileName = null;
        }
      }

      // Skip if neither image nor video was resolved
      if (!hasImageFile && !hasVideoFile) {
        if (post.image) {
          throw new Error(`Generated image file not found: ${post.image}`);
        }
        // Video-only with external URL — still include the post with the URL
        if (videoSource && videoSource.startsWith("http")) {
          // External video URL, just pass it through
        } else {
          throw new Error(`No media files found for post ${i + 1}`);
        }
      }

      const postData = {
        type: post.type,
        image: newFileName,
        imagePath: newTempPath,
        originalImage: originalImagePath ? originalFileName : null,
        originalImagePath: originalImagePath || null,
        similarity: similarity,
        postId: post.postId || null,
        exportIndex: exportIndex,
        video: videoFileName || (videoSource && videoSource.startsWith("http") ? null : null),
        videoPath: videoTempPath,
        videoUrl: (videoSource && videoSource.startsWith("http")) ? videoSource : null,
        videoFileName: videoFileName || (videoSource ? path.basename(videoSource) : null),
      };

      if (post.type === "facebook") {
        postData.text = post.text;
        postData.title = post.title || null;
      } else {
        postData.title = post.title;
        postData.description = post.description;
      }

      newPosts.push(postData);
    } catch (err) {
      // Log which media failed and why
      console.warn(`Failed to process media for post ${i + 1}:`, {
        imagePath: post.image,
        video: post.video || post.videoUrl,
        error: err.message,
      });
      // Skip if any step fails
      continue;
    }
  }

  if (localFiles.length === 0 && newPosts.length === 0) {
    console.warn("No valid media to export.");
    console.warn("Total posts attempted:", posts.length);
    console.warn("Media that failed processing were logged above");
    
    // Check if files were in Temp folder (likely cleaned up)
    const wasTempFolder = posts.some(p => p.image && (p.image.includes('Temp') || p.image.includes('temp')));
    const errorMessage = wasTempFolder
      ? "No valid media to export. The files were stored in a temporary folder and have been automatically cleaned up. You will need to rerun this workflow to regenerate them."
      : "No valid media to export. This may be because files were cleaned up or moved. Please check the console for details about which posts failed.";
    
    return {
      error: errorMessage,
    };
  }

  const destFolderName = `exported_media_${Date.now()}`;
  const targetFolder = path.join(filePaths[0], destFolderName);
  await fsp.mkdir(targetFolder, { recursive: true });

  for (const filePath of localFiles) {
    const dest = path.join(targetFolder, path.basename(filePath));
    await fsp.copyFile(filePath, dest);
  }

  // Return posts with the export folder path
  return {
    posts: newPosts,
    exportPath: targetFolder,
  };
}

module.exports = { exportFlowImages };
