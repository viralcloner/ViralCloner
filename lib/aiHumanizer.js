const axios = require("axios");

const DEFAULT_API_BASE_URL = process.env.VIRALCLONER_HUMANIZER_URL || "";
const API_KEY = process.env.VIRALCLONER_HUMANIZER_KEY || "";
const MIN_WORDS = 30;
const MAX_CHARS = 50000;
const MAX_HUMANIZE_ATTEMPTS = 6;
const ORIGINALITY_THRESHOLD = 10;
const RETRYABLE_REASONS = new Set([
  "network_error",
  "request_timeout",
  "upstream_http_429",
  "upstream_http_502",
  "upstream_http_503",
  "upstream_http_504",
]);

class AIHumanizerError extends Error {
  constructor(message, reason = "request_failed", status = null) {
    super(message);
    this.name = "AIHumanizerError";
    this.reason = reason;
    this.status = status;
  }
}

function countWords(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function getApiConfig() {
  if (!DEFAULT_API_BASE_URL) throw new AIHumanizerError("Configure your own humanizer endpoint with VIRALCLONER_HUMANIZER_URL.");
  require("./networkPolicy").assertAllowedUrl(DEFAULT_API_BASE_URL);
  return {
    apiKey: API_KEY,
    baseUrl: DEFAULT_API_BASE_URL,
  };
}

function validateText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) throw new AIHumanizerError("Text is required.", "invalid_text");
  if (normalized.length > MAX_CHARS) {
    throw new AIHumanizerError("Text must not exceed 50,000 characters.", "text_too_long");
  }
  if (countWords(normalized) < MIN_WORDS) {
    throw new AIHumanizerError("Text must contain at least 30 words.", "text_too_short", 422);
  }
  return normalized;
}

function waitForRetry(signal, delayMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new AIHumanizerError("Text humanization was cancelled.", "cancelled"));
    }, { once: true });
  });
}

function normalizeResult(data) {
  const text = String(data?.text || "").trim();
  if (!text) throw new AIHumanizerError("AI Humanize API returned no humanized text.", "empty_response");

  const exactScore = data?.aiScore === null || data?.aiScore === undefined
    ? null
    : String(data.aiScore);
  const scoreValue = exactScore !== null && Number.isFinite(Number(exactScore))
    ? Number(exactScore)
    : null;
  const finalWords = Number.isFinite(Number(data?.words)) ? Number(data.words) : countWords(text);

  return {
    text,
    language: data?.language || null,
    words: data?.words ?? String(finalWords),
    finalWords,
    aiScore: exactScore,
    finalAiScore: exactScore,
    aiScoreValue: scoreValue,
    done: true,
  };
}

function normalizeAiScore(data) {
  const exactScore = data?.aiScore === null || data?.aiScore === undefined
    ? null
    : String(data.aiScore);
  if (exactScore === null || !Number.isFinite(Number(exactScore))) {
    throw new AIHumanizerError("AI Humanize API returned no originality score.", "empty_score_response");
  }

  return {
    originalityScore: exactScore,
    originalityScoreValue: Number(exactScore),
  };
}

function mapRequestError(error) {
  if (error instanceof AIHumanizerError) return error;
  if (axios.isCancel(error) || error?.code === "ERR_CANCELED") {
    return new AIHumanizerError("Text humanization was cancelled.", "cancelled");
  }

  const status = Number(error?.response?.status || 0) || null;
  const detail = error?.response?.data?.detail;
  const detailMessage = Array.isArray(detail)
    ? detail.map((item) => item?.msg).filter(Boolean).join("; ")
    : (typeof detail === "string" ? detail : "");
  const retryAfterSeconds = Number(error?.response?.headers?.["retry-after"]);
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, 30000)
    : null;

  if (status === 401) return new AIHumanizerError("AI Humanize API rejected its API key.", "unauthorized", status);
  if (status === 422) return new AIHumanizerError(detailMessage || "Text must contain at least 30 words.", "invalid_provider_request", status);
  if (status === 429) {
    const mapped = new AIHumanizerError("AI Humanize API is at capacity.", "upstream_http_429", status);
    mapped.retryAfterMs = retryAfterMs;
    return mapped;
  }
  if (status === 502) return new AIHumanizerError("AI Humanize API could not process the request upstream.", "upstream_http_502", status);
  if (status === 503) {
    const mapped = new AIHumanizerError("AI Humanize API is recovering its browser session.", "upstream_http_503", status);
    mapped.retryAfterMs = retryAfterMs;
    return mapped;
  }
  if (status === 504) return new AIHumanizerError("AI Humanize API timed out while processing the request.", "upstream_http_504", status);
  if (status) return new AIHumanizerError(`AI Humanize API returned HTTP ${status}.`, `upstream_http_${status}`, status);
  if (error?.code === "ECONNABORTED") return new AIHumanizerError("AI Humanize API request timed out.", "request_timeout");
  return new AIHumanizerError(error?.message || "Could not reach the AI Humanize API.", "network_error");
}

async function requestHumanization(text, { signal } = {}) {
  const normalized = validateText(text);
  const { apiKey, baseUrl } = getApiConfig();

  try {
    const response = await axios.post(
      `${baseUrl}/humanize`,
      { text: normalized },
      {
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        signal,
        timeout: 305000,
      },
    );
    return normalizeResult(response.data);
  } catch (error) {
    throw mapRequestError(error);
  }
}

async function scoreText(text, { signal } = {}) {
  const normalized = validateText(text);
  const { apiKey, baseUrl } = getApiConfig();

  try {
    const response = await axios.post(
      `${baseUrl}/ai-score`,
      { text: normalized },
      {
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        signal,
        timeout: 120000,
      },
    );
    return normalizeAiScore(response.data);
  } catch (error) {
    throw mapRequestError(error);
  }
}

async function humanizeText(text, { maxAttempts = 1, signal } = {}) {
  const attemptsLimit = Math.min(
    MAX_HUMANIZE_ATTEMPTS,
    Math.max(1, Math.trunc(Number(maxAttempts)) || 1),
  );
  let currentText = validateText(text);
  let bestResult = null;
  let lastError = null;
  let attemptsUsed = 0;
  const attempts = [];
  let stoppedBelowThreshold = false;

  for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
    attemptsUsed = attempt;
    try {
      const result = await requestHumanization(currentText, { signal });
      let originality = { originalityScore: null, originalityScoreValue: null };
      try {
        originality = await scoreText(result.text, { signal });
      } catch (error) {
        if (error.reason === "cancelled") throw error;
        console.warn(`[AITextHumanizer] Originality score unavailable for attempt ${attempt}:`, error.message);
      }

      const scoredResult = { ...result, ...originality };
      const score = scoredResult.originalityScoreValue;
      attempts.push({
        attempt,
        originalityScore: score,
        exactOriginalityScore: scoredResult.originalityScore,
        aiScore: result.aiScoreValue,
        exactAiScore: result.finalAiScore,
      });
      const bestScore = bestResult?.originalityScoreValue;
      if (!bestResult || (score !== null && (bestScore === null || bestScore === undefined || score < bestScore))) {
        bestResult = scoredResult;
      }
      currentText = result.text;
      if (score === null) break;
      if (score !== null && score < ORIGINALITY_THRESHOLD) {
        stoppedBelowThreshold = true;
        break;
      }
    } catch (error) {
      if (error.reason === "cancelled") throw error;
      lastError = error;
      const canRetry = RETRYABLE_REASONS.has(error.reason) && attempt < attemptsLimit;
      if (canRetry) {
        console.warn(`[AITextHumanizer] Attempt ${attempt} failed; retrying:`, error.message);
        await waitForRetry(signal, error.retryAfterMs || Math.min(attempt * 750, 3000));
        continue;
      }
      if (!bestResult) throw error;
      console.warn(`[AITextHumanizer] Attempt ${attempt} failed; returning the best completed result:`, error.message);
      break;
    }
  }

  if (!bestResult) {
    throw lastError || new AIHumanizerError("The text could not be humanized.", "request_failed");
  }

  return {
    ...bestResult,
    attemptCount: attemptsUsed,
    attempts,
    maxAttempts: attemptsLimit,
    stoppedBelowThreshold,
  };
}

async function humanizeTexts(texts, { signal, concurrency = 3, onProgress } = {}) {
  const inputs = Array.isArray(texts) ? texts.map((text) => String(text || "").trim()) : [];
  if (!inputs.length || inputs.length > 1000) {
    throw new AIHumanizerError("Provide between 1 and 1,000 text outputs.", "invalid_texts");
  }

  const results = new Array(inputs.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(Math.max(1, Math.trunc(concurrency) || 1), inputs.length);

  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw new AIHumanizerError("Text humanization was cancelled.", "cancelled");
      const index = nextIndex++;
      if (index >= inputs.length) return;

      try {
        results[index] = await humanizeText(inputs[index], {
          signal,
          maxAttempts: MAX_HUMANIZE_ATTEMPTS,
        });
      } catch (error) {
        if (error.reason === "cancelled") throw error;
        if ([
          "text_too_short",
          "invalid_provider_request",
          "network_error",
          "request_timeout",
          "upstream_http_429",
          "upstream_http_502",
          "upstream_http_503",
          "upstream_http_504",
        ].includes(error.reason)) {
          results[index] = {
            text: inputs[index],
            language: null,
            words: String(countWords(inputs[index])),
            finalWords: countWords(inputs[index]),
            aiScore: null,
            finalAiScore: null,
            aiScoreValue: null,
            done: false,
            humanizeFailed: true,
            humanizeError: error.message,
          };
        } else {
          throw error;
        }
      }

      completed++;
      onProgress?.({ completed, index, result: results[index] });
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const failedOutputs = results
    .map((result, index) => result?.humanizeFailed ? index + 1 : null)
    .filter(Boolean);
  return { results, failedCount: failedOutputs.length, failedOutputs };
}

module.exports = {
  AIHumanizerError,
  MAX_HUMANIZE_ATTEMPTS,
  MIN_WORDS,
  ORIGINALITY_THRESHOLD,
  countWords,
  humanizeText,
  humanizeTexts,
  scoreText,
};
