const axios = require("axios");

const HISTORY_POINTS = 53; // 365-day weekly chart, followed by forecasts when present.
const MAX_BRANCHES = 12;
const normalizeTerm = term => term.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

function scoreTrend(item, { allowNonRising = false } = {}) {
  if (!item || typeof item.term !== "string" || !item.term.trim() || item.term.length > 200 || !Array.isArray(item.counts)) return null;
  if (item.hasPrediction && item.counts.length <= HISTORY_POINTS) return null;
  const history = item.hasPrediction ? item.counts.slice(0, HISTORY_POINTS) : item.counts;
  if (history.length < 8 || history.length > HISTORY_POINTS) return null;
  // Missing data is not zero interest. Reject incomplete recent windows.
  const recent = history.slice(-8);
  if (recent.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) return null;
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const previousAverage = mean(recent.slice(0, 4));
  const recentAverage = mean(recent.slice(4));
  const delta = recentAverage - previousAverage;
  const growth = delta / Math.max(previousAverage, 1);
  const isRising = recentAverage >= 2 && delta >= 1 && growth >= 0.1 && recent[7] >= recentAverage * 0.8;
  // Flat or easing charts can still have substantial current interest. Keep
  // these as a fallback, but never turn zero/missing activity into a keyword.
  if (recentAverage <= 0 || recent[7] <= 0 || (!isRising && !allowNonRising)) return null;
  // Counts are relative chart interest, not absolute search volumes.
  const score = Math.min(growth, 5) * 40 + delta + recentAverage * 0.25;
  const activityScore = recentAverage * 0.6 + recent[7] * 0.4;
  return { term: item.term.trim(), score, activityScore, isRising, growthPercent: Math.round(growth * 100), recentAverage, previousAverage };
}

async function discoverTrendingKeywords(seed, { signal, get = axios.get, now = new Date() } = {}) {
  if (typeof seed !== "string" || !seed.trim() || seed.length > 200) throw new Error("invalid_keyword");
  const seedKey = normalizeTerm(seed);
  const endDate = now.toISOString().slice(0, 10);
  const fetchTerms = async term => {
    signal?.throwIfAborted();
    const response = await get("https://trends.pinterest.com/related_terms/", {
      params: { requestTerm: term, country: "US", endDate, aggregation: "2", lookback: "365", shouldMock: "false" },
      headers: { accept: "application/json", "x-new-site": "true",
        referer: `https://trends.pinterest.com/detail/?country=US&terms=${encodeURIComponent(term)}`,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" },
      timeout: 10000, maxContentLength: 1024 * 1024, signal,
    });
    signal?.throwIfAborted();
    if (!Array.isArray(response.data)) throw new Error("invalid_trends_response");
    return response.data.slice(0, 100).filter(item => item && typeof item.term === "string" && item.term.trim() && item.term.length <= 200);
  };
  const first = await fetchTerms(seed.trim());
  const candidates = new Map();
  const add = items => {
    for (const item of items) {
      const key = normalizeTerm(item.term);
      if (key !== seedKey && !candidates.has(key)) candidates.set(key, item);
    }
  };
  add(first);
  const branches = [...candidates.values()].slice(0, MAX_BRANCHES);
  let failedBranches = 0;
  // Three bounded workers fetch the second level; no recursive expansion.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, branches.length) }, async () => {
    while (next < branches.length) {
      signal?.throwIfAborted();
      const branch = branches[next++];
      try { add(await fetchTerms(branch.term)); }
      catch (error) {
        if (signal?.aborted) throw error;
        failedBranches++;
      }
    }
  }));
  const analyzed = [...candidates.values()].map(item => scoreTrend(item, { allowNonRising: true })).filter(Boolean);
  const rising = analyzed.filter(item => item.isRising)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const active = analyzed.filter(item => !item.isRising)
    .sort((a, b) => b.activityScore - a.activityScore || a.term.localeCompare(b.term));
  const keywords = rising.length ? rising.slice(0, 6) : active.slice(0, 6);
  if (rising.length && keywords.length < 4) {
    keywords.push(...active.slice(0, 4 - keywords.length));
  }
  const selectionMode = !rising.length ? "active" : keywords.some(item => !item.isRising) ? "mixed" : "rising";
  return { keywords, selectionMode, country: "US", endDate, candidatesAnalyzed: candidates.size, partial: failedBranches > 0 };
}

module.exports = { discoverTrendingKeywords, scoreTrend };
