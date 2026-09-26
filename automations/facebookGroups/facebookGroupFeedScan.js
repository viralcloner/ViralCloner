/**
 * Facebook Group Feed Scan (batched, human-like viral monitoring)
 *
 * Instead of firing one CometSinglePostDialogContentQuery per monitored post
 * (a recognizable bot pattern when many posts are tracked), this opens ONE real
 * browser session with an idle account, navigates to the group, and scrolls the
 * feed like a human while intercepting Facebook's own feed GraphQL responses.
 * Every story's share / reaction / comment counts are harvested in a single pass.
 *
 * Hybrid discovery: scroll the feed first; for any monitored post not seen while
 * scrolling, fall back to visiting its permalink in the SAME warm session.
 *
 * Returns counts for every monitored storyId it could resolve:
 *   { success, counts: { [storyId]: { sharesCount, reactionsCount, commentsCount } },
 *     found: [storyId...], scannedCount, error }
 */

const { startVCBrowser, gracefulCloseVCBrowser } = require("../../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");
const { injectCookiesIfLoggedOut } = require("../../lib/facebookCookieStore");
const { dismissFacebookWarningDialog } = require("./fbDialogHelper");

const MODULE = "[FbGroupFeedScan]";

const rand   = (min, max) => Math.floor(min + Math.random() * (max - min));
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Generic extractor: walk any GraphQL JSON tree and pull every story's
// share / reaction / comment counts, keyed by its numeric post_id. Works for
// both group-feed pagination responses and single-post (permalink) responses.
// ---------------------------------------------------------------------------
function extractFeedbackCounts(json) {
  const out = {}; // postId -> { sharesCount, reactionsCount, commentsCount }
  if (!json || typeof json !== "object") return out;

  // Find the counts that belong to ONE story node, without bleeding into a
  // nested attached/shared story (which carries its own post_id + feedback).
  const countsForStory = (root, rootPid) => {
    let reactions = null, shares = null, comments = null;
    const stack = [root];
    let steps = 0;
    while (stack.length && steps < 20000) {
      steps++;
      const cur = stack.pop();
      if (cur == null || typeof cur !== "object") continue;

      if (shares == null && cur.share_count && typeof cur.share_count.count === "number") {
        shares = cur.share_count.count;
      }
      if (reactions == null && cur.reaction_count && typeof cur.reaction_count.count === "number") {
        reactions = cur.reaction_count.count;
      }
      if (comments == null) {
        const c1 = cur.comment_rendering_instance_for_feed_location?.comments?.total_count;
        const c2 = cur.comment_rendering_instance?.comments?.total_count;
        const c3 = (cur.comment_count && typeof cur.comment_count.total_count === "number") ? cur.comment_count.total_count : null;
        if (c1 != null) comments = c1;
        else if (c2 != null) comments = c2;
        else if (c3 != null) comments = c3;
      }

      for (const k in cur) {
        // Do not descend into an attached/shared story — it has its own counts.
        if (k === "attached_story" || k === "attached_story_with_deep_link") continue;
        const v = cur[k];
        if (v && typeof v === "object") {
          // Skip a nested object that is itself a different story node.
          if (typeof v.post_id === "string" && v.post_id && v.post_id !== rootPid) continue;
          stack.push(v);
        }
      }
    }
    return { reactions, shares, comments };
  };

  const stack = [json];
  let steps = 0;
  while (stack.length && steps < 50000) {
    steps++;
    const cur = stack.pop();
    if (cur == null || typeof cur !== "object") continue;

    const pid = typeof cur.post_id === "string" && /^\d+$/.test(cur.post_id) ? cur.post_id
              : (typeof cur.legacy_story_hideable_id === "string" && /^\d+$/.test(cur.legacy_story_hideable_id) ? cur.legacy_story_hideable_id : null);
    if (pid && (cur.comet_sections || cur.feedback)) {
      const c = countsForStory(cur, pid);
      if (c.shares != null || c.reactions != null || c.comments != null) {
        // The same story is identified by several id forms across FB surfaces:
        // numeric post_id / legacy_story_hideable_id AND the base64 global node
        // id (`id`) — which is exactly the `postId` we store for viral monitors.
        // Key the counts under EVERY available form so any stored id can match.
        const keys = new Set([pid]);
        if (typeof cur.post_id === "string" && /^\d+$/.test(cur.post_id)) keys.add(cur.post_id);
        if (typeof cur.legacy_story_hideable_id === "string" && /^\d+$/.test(cur.legacy_story_hideable_id)) keys.add(cur.legacy_story_hideable_id);
        if (typeof cur.id === "string" && cur.id.length > 16 && !/^\d+$/.test(cur.id)) keys.add(cur.id);
        for (const key of keys) {
          const prev = out[key] || {};
          out[key] = {
            sharesCount:    c.shares    != null ? c.shares    : (prev.sharesCount    ?? null),
            reactionsCount: c.reactions != null ? c.reactions : (prev.reactionsCount ?? null),
            commentsCount:  c.comments  != null ? c.comments  : (prev.commentsCount  ?? null),
          };
        }
      }
    }

    for (const k in cur) {
      const v = cur[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
}

// Parse a (possibly multi-line / streamed) GraphQL response body into counts.
function parseBodyCounts(rawText) {
  const merged = {};
  if (!rawText) return merged;
  const lines = String(rawText).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let json;
    try { json = JSON.parse(trimmed); } catch (_) { continue; }
    const part = extractFeedbackCounts(json);
    for (const pid in part) {
      const cur = merged[pid] || {};
      merged[pid] = {
        sharesCount:    part[pid].sharesCount    != null ? part[pid].sharesCount    : (cur.sharesCount    ?? null),
        reactionsCount: part[pid].reactionsCount != null ? part[pid].reactionsCount : (cur.reactionsCount ?? null),
        commentsCount:  part[pid].commentsCount  != null ? part[pid].commentsCount  : (cur.commentsCount  ?? null),
      };
    }
  }
  return merged;
}

async function facebookGroupFeedScan({
  groupId,
  groupUrl,
  profileId,
  profileData,
  storyIds = [],
  maxScrollRounds = 25,
  onLog = () => {},
}) {
  const log = (msg) => { try { onLog(msg); } catch (_) {} console.log(`${MODULE} ${msg}`); };

  const wanted = new Set((storyIds || []).map(s => String(s)));
  const counts = {}; // storyId -> { sharesCount, reactionsCount, commentsCount }

  if (wanted.size === 0) return { success: true, counts, found: [], scannedCount: 0 };

  // The stored monitor id is a base64 global story id; the feed exposes the same
  // story under several id forms (numeric post_id and base64 node id) whose base64
  // padding / url-safe alphabet may differ. Normalize so any form maps back to the
  // original wanted id without relying on (unreliable) base64→numeric decoding.
  const normId = (s) => String(s).replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const wantedNorm = new Map(); // normalized id -> original wanted storyId
  for (const sid of wanted) wantedNorm.set(normId(sid), sid);
  // Resolve a harvested id to the wanted storyId it belongs to (exact, then normalized).
  const resolveWanted = (pid) => (wanted.has(pid) ? pid : (wantedNorm.get(normId(pid)) || null));

  const cookies = profileData.cookies || [];
  const proxy   = profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== "NULL"
                    ? profileData.proxy : null;

  let fingerprint = profileData.fingerprint;
  if (!fingerprint || Object.keys(fingerprint).length === 0) {
    fingerprint = getConsistentFingerprintForProfile(profileId);
  }
  try {
    const vcVersion = getVCBrowserVersion();
    if (fingerprint.userAgent && vcVersion?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
    }
  } catch (_) {}

  let client = null;
  let chromeProcess = null;

  // Merge freshly captured counts; drop matched ids from `wanted`.
  const mergeCounts = (parsed) => {
    for (const pid in parsed) {
      const sid = resolveWanted(pid);
      if (!sid) {
        // still record it in case an alternate id form matches later
        counts[pid] = { ...(counts[pid] || {}), ...parsed[pid] };
        continue;
      }
      counts[sid] = {
        sharesCount:    parsed[pid].sharesCount    != null ? parsed[pid].sharesCount    : (counts[sid]?.sharesCount    ?? null),
        reactionsCount: parsed[pid].reactionsCount != null ? parsed[pid].reactionsCount : (counts[sid]?.reactionsCount ?? null),
        commentsCount:  parsed[pid].commentsCount  != null ? parsed[pid].commentsCount  : (counts[sid]?.commentsCount  ?? null),
      };
      // Consider it "found" once we have at least one metric for it.
      const c = counts[sid];
      if (c.sharesCount != null || c.reactionsCount != null || c.commentsCount != null) {
        wanted.delete(sid);
      }
    }
  };

  try {
    log(`Launching browser for profile ${profileId} to scan ${storyIds.length} post(s) in group ${groupId}`);

    const startResult = await startVCBrowser(
      profileId,
      fingerprint,
      "about:blank",
      proxy,
      true,  // headless
      true   // automationMode
    );
    if (!startResult || !startResult.client) {
      return { success: false, error: "Failed to start VCBrowser", counts, found: [] };
    }
    client = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network, Input } = client;

    await Network.enable();

    // Track which in-flight requests are GraphQL responses we want to read.
    const graphqlRequests = new Set();
    Network.responseReceived(({ requestId, response }) => {
      try {
        if (response && response.url && response.url.includes("/api/graphql")) {
          graphqlRequests.add(requestId);
        }
      } catch (_) {}
    });
    Network.loadingFinished(async ({ requestId }) => {
      if (!graphqlRequests.has(requestId)) return;
      graphqlRequests.delete(requestId);
      try {
        const { body, base64Encoded } = await Network.getResponseBody({ requestId });
        const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
        const parsed = parseBodyCounts(text);
        if (Object.keys(parsed).length) mergeCounts(parsed);
      } catch (_) { /* body already evicted — ignore */ }
    });

    await injectCookiesIfLoggedOut(Network, cookies, MODULE);

    // ── Navigate to the group feed ───────────────────────────────────────────
    const feedUrl = groupUrl || `https://www.facebook.com/groups/${groupId}`;
    log(`Navigating to group feed: ${feedUrl}`);
    await Page.navigate({ url: feedUrl });
    await sleep(rand(5000, 8000));
    await dismissFacebookWarningDialog(Runtime);

    const urlEval = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
    const currentUrl = urlEval.result?.value || "";
    if (currentUrl.includes("login") || currentUrl.includes("checkpoint")) {
      await gracefulCloseVCBrowser(client, chromeProcess);
      return { success: false, error: "Profile is not logged in to Facebook", counts, found: [] };
    }

    // Let the initial feed query land + be parsed.
    await sleep(rand(2000, 3500));

    // ── Human-like scroll loop ───────────────────────────────────────────────
    let lastHeight = 0;
    let stagnant = 0;
    for (let round = 0; round < maxScrollRounds; round++) {
      if (wanted.size === 0) {
        log(`All ${storyIds.length} monitored post(s) resolved while scrolling — stopping early`);
        break;
      }

      // Random mouse movement (best-effort).
      try {
        if (Input?.dispatchMouseEvent) {
          await Input.dispatchMouseEvent({ type: "mouseMoved", x: rand(150, 1000), y: rand(150, 700) });
        }
      } catch (_) {}

      // Wheel-scroll down with a randomized delta (real wheel telemetry).
      const delta = rand(500, 1100);
      try {
        if (Input?.dispatchMouseEvent) {
          await Input.dispatchMouseEvent({ type: "mouseWheel", x: rand(300, 900), y: rand(300, 600), deltaX: 0, deltaY: delta });
        } else {
          await Runtime.evaluate({ expression: `window.scrollBy(0, ${delta});` });
        }
      } catch (_) {
        try { await Runtime.evaluate({ expression: `window.scrollBy(0, ${delta});` }); } catch (_) {}
      }

      // Variable reading pause.
      await sleep(rand(1500, 4500));

      // Occasionally scroll back up a little, like a human re-reading.
      if (Math.random() < 0.18) {
        try {
          const up = rand(150, 400);
          if (Input?.dispatchMouseEvent) {
            await Input.dispatchMouseEvent({ type: "mouseWheel", x: rand(300, 900), y: rand(300, 600), deltaX: 0, deltaY: -up });
          } else {
            await Runtime.evaluate({ expression: `window.scrollBy(0, ${-up});` });
          }
          await sleep(rand(800, 2000));
        } catch (_) {}
      }

      // Every few rounds, dwell a bit longer.
      if (round > 0 && round % 5 === 0) {
        await sleep(rand(2500, 5000));
      }

      // Detect end-of-feed (no new content over several rounds).
      try {
        const h = await Runtime.evaluate({ expression: "document.body.scrollHeight", returnByValue: true });
        const height = Number(h.result?.value) || 0;
        if (height <= lastHeight + 50) { stagnant++; } else { stagnant = 0; }
        lastHeight = height;
        if (stagnant >= 4) {
          log(`Feed stopped growing — ending scroll after ${round + 1} round(s)`);
          break;
        }
      } catch (_) {}
    }

    // ── Permalink fallback for any post not seen in the feed ─────────────────
    if (wanted.size > 0) {
      const missing = Array.from(wanted);
      log(`${missing.length} post(s) not found while scrolling — visiting permalinks in the same session`);
      for (const sid of missing) {
        try {
          const permalink = `https://www.facebook.com/groups/${groupId}/permalink/${sid}/`;
          await Page.navigate({ url: permalink });
          await sleep(rand(4000, 7000));
          await dismissFacebookWarningDialog(Runtime);
          // small human scroll on the post page
          try {
            if (Input?.dispatchMouseEvent) {
              await Input.dispatchMouseEvent({ type: "mouseWheel", x: rand(300, 900), y: rand(300, 600), deltaX: 0, deltaY: rand(300, 700) });
            }
          } catch (_) {}
          await sleep(rand(1500, 3000));
        } catch (e) {
          log(`Permalink visit failed for ${sid}: ${e.message}`);
        }
      }
    }

    await gracefulCloseVCBrowser(client, chromeProcess);
    client = null; chromeProcess = null;

    const found = (storyIds || []).map(String).filter(sid => {
      const c = counts[sid];
      return c && (c.sharesCount != null || c.reactionsCount != null || c.commentsCount != null);
    });

    log(`Scan complete: resolved ${found.length}/${storyIds.length} post(s)`);
    return { success: true, counts, found, scannedCount: found.length };
  } catch (e) {
    log(`Session error: ${e.message}`);
    try { if (client) await gracefulCloseVCBrowser(client, chromeProcess); } catch (_) {}
    return { success: false, error: e.message, counts, found: [] };
  }
}

// Serialize through the shared per-profile session mutex (see facebookProfileLock).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookGroupFeedScan: (args) => _runProfileExclusive(args && args.profileId, () => facebookGroupFeedScan(args)),
  extractFeedbackCounts,
};
