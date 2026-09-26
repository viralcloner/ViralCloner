const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const ZERO_GPT_IMAGE_ENDPOINT = "https://api.zerogpt.com/api/image/aiImageDetect";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// The same exported image can appear in Facebook and Pinterest posts. Cache
// the in-flight/completed request so it is uploaded only once per app session.
const scoreCache = new Map();

async function requestZeroGptScore(resolvedPath, mimeType) {
  const form = new FormData();
  form.append("file", fs.createReadStream(resolvedPath), {
    filename: path.basename(resolvedPath),
    contentType: mimeType,
  });

  const response = await axios.post(ZERO_GPT_IMAGE_ENDPOINT, form, {
    headers: {
      ...form.getHeaders(),
      Accept: "application/json, text/plain, */*",
      Origin: "https://www.zerogpt.com",
      Referer: "https://www.zerogpt.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.0.0 Safari/537.36",
    },
    timeout: 120000,
    maxContentLength: MAX_IMAGE_BYTES + 1024 * 1024,
    maxBodyLength: MAX_IMAGE_BYTES + 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const payload = response.data;
  if (!payload || payload.success !== true) {
    throw new Error(payload?.message || payload?.error || "ZeroGPT rejected the image");
  }

  const details = payload.data?.result_details || {};
  const score = Number(payload.data?.result ?? details.confidence);
  if (!Number.isFinite(score)) {
    throw new Error("ZeroGPT returned an invalid image score");
  }

  return {
    success: true,
    score: Math.max(0, Math.min(100, score)),
    classification: details.final_result || null,
    confidence: Number.isFinite(Number(details.confidence))
      ? Number(details.confidence)
      : score,
    stored: Boolean(details.moderation?.stored),
  };
}

async function scoreZeroGptImage(imagePath) {
  if (typeof imagePath !== "string" || !imagePath.trim()) {
    throw new Error("An image path is required");
  }

  const resolvedPath = path.resolve(imagePath);
  const extension = path.extname(resolvedPath).toLowerCase();
  const mimeType = MIME_TYPES[extension];
  if (!mimeType) {
    throw new Error("ZeroGPT scoring supports JPEG, PNG, and WebP images only");
  }

  const stat = await fsp.stat(resolvedPath);
  if (!stat.isFile()) throw new Error("Image file not found");
  if (stat.size <= 0) throw new Error("Image file is empty");
  if (stat.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 25 MB scoring limit");

  const cacheKey = `${resolvedPath}:${stat.size}:${stat.mtimeMs}`;
  if (scoreCache.has(cacheKey)) return scoreCache.get(cacheKey);

  const request = requestZeroGptScore(resolvedPath, mimeType).catch((error) => {
    scoreCache.delete(cacheKey);
    throw error;
  });
  scoreCache.set(cacheKey, request);
  return request;
}

module.exports = { scoreZeroGptImage };
