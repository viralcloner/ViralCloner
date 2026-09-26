const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const SIGHTENGINE_ENDPOINT = "https://api.sightengine.com/1.0/check.json";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const scoreCache = new Map();

async function requestSightengineScore(resolvedPath, mimeType) {
  const form = new FormData();
  form.append("media", fs.createReadStream(resolvedPath), {
    filename: path.basename(resolvedPath),
    contentType: mimeType,
  });
  form.append("models", "genai,deepfake");
  form.append("opt_generators", "on");

  const response = await axios.post(SIGHTENGINE_ENDPOINT, form, {
    headers: {
      ...form.getHeaders(),
      Accept: "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7,es;q=0.6,ar;q=0.5",
      Origin: "https://sightengine.com",
      Priority: "u=1, i",
      Referer: "https://sightengine.com/",
      "Sec-CH-UA": '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
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

  const payload = typeof response.data === "string"
    ? JSON.parse(response.data)
    : response.data;
  if (payload?.status !== "success") {
    throw new Error(
      payload?.error?.message ||
      payload?.error ||
      "Sightengine score is unavailable",
    );
  }

  const aiGenerated = Number(payload?.type?.ai_generated);
  if (!Number.isFinite(aiGenerated)) {
    throw new Error("Sightengine returned an invalid image score");
  }

  const toPercent = (probability) => {
    const value = Number(probability);
    return Number.isFinite(value)
      ? Math.max(0, Math.min(100, value * 100))
      : null;
  };
  const generatorScores = Object.fromEntries(
    Object.entries(payload?.type?.ai_generators || {})
      .map(([generator, probability]) => [generator, toPercent(probability)])
      .filter(([, probability]) => probability !== null),
  );
  const rankedGenerators = Object.entries(generatorScores)
    .sort(([, leftScore], [, rightScore]) => rightScore - leftScore);
  const score = toPercent(aiGenerated);

  return {
    success: true,
    score,
    humanScore: Math.max(0, Math.min(100, 100 - score)),
    deepfakeScore: toPercent(payload?.type?.deepfake),
    generatorScores,
    likelyGenerator: rankedGenerators[0]?.[0] || null,
    likelyGeneratorScore: rankedGenerators[0]?.[1] ?? null,
    verdict: score >= 50 ? "ai_generated" : "likely_human",
    model: "Sightengine GenAI",
    modelId: "sightengine/genai",
    requestId: payload?.request?.id || null,
  };
}

async function scoreSightengineImage(imagePath) {
  if (typeof imagePath !== "string" || !imagePath.trim()) {
    throw new Error("An image path is required");
  }

  const resolvedPath = path.resolve(imagePath);
  const mimeType = MIME_TYPES[path.extname(resolvedPath).toLowerCase()];
  if (!mimeType) {
    throw new Error("Sightengine scoring supports JPEG, PNG, and WebP images only");
  }

  const stat = await fsp.stat(resolvedPath);
  if (!stat.isFile()) throw new Error("Image file not found");
  if (stat.size <= 0) throw new Error("Image file is empty");
  if (stat.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 25 MB scoring limit");

  const cacheKey = `${resolvedPath}:${stat.size}:${stat.mtimeMs}`;
  if (scoreCache.has(cacheKey)) return scoreCache.get(cacheKey);

  const request = requestSightengineScore(resolvedPath, mimeType).catch((error) => {
    scoreCache.delete(cacheKey);
    throw error;
  });
  scoreCache.set(cacheKey, request);
  return request;
}

module.exports = { scoreSightengineImage };
