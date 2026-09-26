/**
 * Facebook Group Post Automation
 *
 * Fast path (no browser): uses stored cookies + plain HTTPS to extract
 * fb_dtsg/lsd/uid and fire ComposerStoryCreateMutation directly.
 *
 * Fallback (browser): if cookies are expired or the HTTP path fails, opens
 * VCBrowser (non-headless), navigates to the group page, and executes the
 * mutation from within the page context via CDP.
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const { startVCBrowser, gracefulCloseVCBrowser } = require("../../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");
const { getFacebookSessionTokens, postGraphQL, buildJazoest, buildProxyAgent, buildSecChUaHeaders, checkProxyReachable, classifyFbError, isAccountLevelBlock } = require("../../lib/facebookHttpSession");
const { getDocId, updateDocId, invalidateDocId, isDocIdError, isDefiniteDocIdError, extractDocIdsFromHtml, updateMany } = require("../../lib/facebookDocIds");
const { dismissFacebookWarningDialog } = require("./fbDialogHelper");
const { buildCommentJsCode } = require("./facebookGroupComment");
const { reportClientError } = require("../../lib/remoteErrorLogger");
const { persistFreshCookies, parseSetCookies, cdpCookiesToStorage, injectCookiesIfLoggedOut, hasValidFbSession } = require("../../lib/facebookCookieStore");

const MODULE = "[FbGroupPost]";
const MUTATION_NAME = "ComposerStoryCreateMutation";

// ---------------------------------------------------------------------------
// Build the default User-Agent from the ACTUAL bundled VCBrowser version so the
// HTTP paths (page fetch / GraphQL / image upload) advertise the SAME Chrome
// version as the browser fingerprint. A Chrome-version mismatch between the
// device fingerprint and the HTTP requests (and the sec-ch-ua hints derived from
// it) is a device-integrity signal that triggers Facebook identity (selfie)
// checkpoints. Keep every surface identical.
// ---------------------------------------------------------------------------
function defaultUserAgent() {
  let full = "142.0.0.0";
  try {
    const v = getVCBrowserVersion();
    if (v && v.full) full = v.full;
  } catch (_) {}
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
}

// ---------------------------------------------------------------------------
// Inject the stored cookie SNAPSHOT into the live browser ONLY when the on-disk
// profile is logged out. The shared guard lives in lib/facebookCookieStore.js
// (injectCookiesIfLoggedOut) so every Facebook action applies the same rule and
// never downgrades a fresh live session with a stale snapshot.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recursively search a parsed GraphQL object for the first value matching a
// predicate. Used to recover post identifiers that Facebook occasionally nests
// deeper in the response (or omits from the top-level story object).
// ---------------------------------------------------------------------------
function _deepFind(node, predicate, seen) {
  seen = seen || new Set();
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  for (const [k, v] of Object.entries(node)) {
    const hit = predicate(k, v, node);
    if (hit != null) return hit;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") {
      const r = _deepFind(v, predicate, seen);
      if (r != null) return r;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract the post identifiers we need from a story_create response.
// Facebook occasionally returns success but omits story.id at the top level
// (~1% of posts) — in that case we deep-walk the whole response for the numeric
// id / feedback id so the first comment can still be attached.
// `extraRoots` carries the @defer streaming fragments (the 2nd+ newline-delimited
// JSON objects) where Facebook increasingly places the story/feedback ids.
// Returns { postId, numericPostId, feedbackId }.
// ---------------------------------------------------------------------------
function extractStoryIds(storyCreate, fullJson, extraRoots) {
  const story = (storyCreate && (storyCreate.story || (storyCreate.story_result && storyCreate.story_result.story))) || null;
  let postId        = (story && (story.id || story.legacy_story_hideable_id)) || null;
  let numericPostId = (story && (story.legacy_story_hideable_id || story.post_id)) || null;
  let feedbackId    = (story && story.feedback && story.feedback.id) || null;

  if (!numericPostId || !feedbackId || !postId) {
    // Search the base response AND every deferred streaming fragment.
    const roots = [storyCreate, fullJson && fullJson.data, fullJson, ...(Array.isArray(extraRoots) ? extraRoots : [])]
      .filter(r => r && typeof r === "object");
    for (const root of roots) {
      if (!feedbackId) {
        feedbackId = _deepFind(root, (k, v) =>
          (k === "feedback" && v && typeof v === "object" && typeof v.id === "string") ? v.id : null);
      }
      if (!numericPostId) {
        numericPostId = _deepFind(root, (k, v) =>
          ((k === "legacy_story_hideable_id" || k === "post_id") && /^\d+$/.test(String(v))) ? String(v) : null);
      }
      if (!postId) {
        postId = _deepFind(root, (k, v) =>
          (k === "id" && typeof v === "string" && v.length > 15) ? v : null);
      }
      if (numericPostId && feedbackId && postId) break;
    }
  }
  return { postId, numericPostId, feedbackId };
}

// ---------------------------------------------------------------------------
// Produce a compact, length-capped snapshot of a raw Facebook response for
// diagnostics. Captured only on failures / the ~1% id-missing case so we can
// see exactly what Facebook returned and fix new variants of the bug.
// ---------------------------------------------------------------------------
function _snapshotResponse(value, max = 6000) {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (s == null) return null;
    return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pull the lightweight session params Facebook embeds in static page HTML so the
// photo upload (and other HTTP-path requests) can mirror a real browser request.
// __dyn/__csr are computed client-side by the bundle and are NOT reliably present
// in the raw HTML, so they are intentionally omitted here — the browser path
// supplies the full set; this only enriches the HTTP fast path with what is safely
// scrapeable (__rev/__hsi/__hs/__spin_*).
// ---------------------------------------------------------------------------
function extractSessionParamsFromHtml(html) {
  const out = {};
  if (!html || typeof html !== "string") return out;
  const grab = (re) => (html.match(re) || [])[1] || null;
  const rev   = grab(/"client_revision":(\d+)/) || grab(/"__spin_r":(\d+)/);
  const hsi   = grab(/"hsi":"(\d+)"/);
  const hs    = grab(/"haste_session":"([^"]+)"/);
  const spinR = grab(/"__spin_r":(\d+)/) || rev;
  const spinB = grab(/"__spin_b":"([^"]+)"/) || grab(/"__spin_b":"?([A-Za-z0-9_]+)"?/);
  const spinT = grab(/"__spin_t":(\d+)/);
  if (rev)   out.__rev = rev;
  if (hsi)   out.__hsi = hsi;
  if (hs)    out.__hs = hs;
  if (spinR) out.__spin_r = spinR;
  if (spinB) out.__spin_b = spinB;
  if (spinT) out.__spin_t = spinT;
  return out;
}

// ---------------------------------------------------------------------------
// Photo upload for new post (upload.facebook.com)
//
// Facebook intermittently soft-throttles this endpoint — returning HTTP 200 with
// an empty payload (no fbid). That single transient response is the #1 cause of
// "post failed" for image posts. `uploadPostImageHttp` therefore retries the
// upload a few times with backoff; the per-attempt worker returns a rich
// { fbid, transient, status, raw } result so the wrapper can tell a retryable
// throttle apart from a permanent block (logged out / checkpoint).
// ---------------------------------------------------------------------------
async function uploadPostImageHttp({ imagePath, tokens, userAgent, proxy, sessionParams = {}, suppressUploadErrorReport = false, outcome = {} }) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;

  const MAX_UPLOAD_TRIES = 3;
  let last = { fbid: null, transient: true, status: 0, raw: "" };
  for (let attempt = 1; attempt <= MAX_UPLOAD_TRIES; attempt++) {
    last = await _uploadPostImageOnce({ imagePath, tokens, userAgent, proxy, sessionParams });
    if (last.fbid) return last.fbid;
    if (!last.transient) break; // permanent block — a retry cannot help
    if (attempt < MAX_UPLOAD_TRIES) {
      console.warn(`${MODULE} Photo upload attempt ${attempt}/${MAX_UPLOAD_TRIES} got no fbid (status ${last.status}) — retrying`);
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));
    }
  }

  // Parse Facebook's error text once for both diagnostics and logged-out detection.
  const parsed = (() => { try { return JSON.parse((last.raw || "").replace(/^for\s*\(;;\);\s*/, "").split("\n")[0]); } catch (_) { return null; } })();
  const fbError = parsed?.errorSummary || parsed?.errorDescription || parsed?.error || null;

  // Signed-out / session-expired upload rejection — tell the caller so it can flag
  // the profile. Neither a retry nor a browser fallback can help a logged-out
  // account, so the post must stop and the profile must be benched.
  if (last.loggedOut) {
    outcome.loggedOut = true;
    outcome.errorMessage = `Profile is not logged in to Facebook${fbError ? ` — ${String(fbError).slice(0, 160)}` : " (photo upload rejected; the account appears signed out)"}.`;
  }

  // All upload attempts failed — report the final raw response for diagnostics
  // (unless the caller asked us to stay quiet, e.g. a mid scheduler-level retry).
  if (!suppressUploadErrorReport) {
    try {
      reportClientError({
        feature: "fb_groups",
        level: "error",
        message: `Photo upload returned no fbid after ${MAX_UPLOAD_TRIES} tries (status ${last.status})${fbError ? `: ${String(fbError).slice(0, 200)}` : ""}`,
        context: { stage: "photo_upload", status: last.status, rawResponse: (last.raw || "").slice(0, 4000) },
      });
    } catch (_) {}
  }
  return null;
}

// Single upload attempt. Resolves { fbid, transient, status, raw }.
//   fbid      → uploaded photo id (success)
//   transient → whether a retry could plausibly succeed (false = permanent block)
async function _uploadPostImageOnce({ imagePath, tokens, userAgent, proxy, sessionParams = {} }) {
  if (!imagePath || !fs.existsSync(imagePath)) return { fbid: null, transient: false, status: 0, raw: "" };

  const { dtsg, lsd, uid, cookieHeader } = tokens;
  const fileBuffer  = fs.readFileSync(imagePath);
  const fileName    = path.basename(imagePath);
  const ext         = fileName.split(".").pop().toLowerCase();
  const mimeMap     = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const contentType = mimeMap[ext] || "image/jpeg";
  const jazoest     = buildJazoest(dtsg);
  const boundary    = "----WebKitFormBoundary" + Math.random().toString(36).slice(2, 18);
  const CRLF        = "\r\n";
  const agent       = proxy ? buildProxyAgent(proxy) : null;

  const textPart = (name, value) => Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`
  );
  const filePart = Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="farr"; filename="${fileName}"${CRLF}Content-Type: ${contentType}${CRLF}${CRLF}`),
    fileBuffer,
    Buffer.from(CRLF),
  ]);
  const bodyBuffer = Buffer.concat([
    textPart("source",        "8"),
    textPart("profile_id",    uid),
    textPart("waterfallxapp", "comet"),
    filePart,
    textPart("upload_id",     "jsc_c_3"),
    Buffer.from(`--${boundary}--${CRLF}`),
  ]);

  const qp = new URLSearchParams({
    av: uid, __aaid: "0", __user: uid, __a: "1", dpr: "1",
    __ccg: "EXCELLENT", __comet_req: "15",
    fb_dtsg: dtsg, jazoest, lsd: lsd || "",
  });
  // Mirror a real browser upload: forward the captured session params. A normal
  // account is accepted with a bare query string, but a flagged / FALLBACK-flow
  // account gets STRICTER validation on upload.facebook.com and rejects the bare
  // request with a 200-and-no-photo-id body ("no fbid" -> post aborted). Sending
  // the same __dyn/__csr/__rev/__hs/__spin_* params the browser sends fixes it.
  const UPLOAD_SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs", "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];
  if (sessionParams && typeof sessionParams === "object") {
    UPLOAD_SESSION_KEYS.forEach(k => { if (sessionParams[k]) qp.set(k, sessionParams[k]); });
  }

  return new Promise((resolve) => {
    const reqOptions = {
      hostname: "upload.facebook.com",
      path: `/ajax/react_composer/attachments/photo/upload?${qp.toString()}`,
      method: "POST",
      headers: {
        "content-type":   `multipart/form-data; boundary=${boundary}`,
        "content-length": bodyBuffer.length,
        "cookie":         cookieHeader,
        "x-fb-lsd":       lsd || "",
        "origin":         "https://www.facebook.com",
        "referer":        "https://www.facebook.com/",
        "user-agent":     userAgent || defaultUserAgent(),
        "accept":         "*/*",
        "accept-language": "en-US,en;q=0.9",
        "priority":       "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "x-asbd-id":      "359341",
        ...buildSecChUaHeaders(userAgent || defaultUserAgent()),
      },
      ...(agent ? { agent } : {}),
    };
    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        for (let line of raw.split("\n")) {
          line = line.trim().replace(/^for\s*\(;;\);\s*/, ""); // strip Facebook's JSONP prefix
          if (!line) continue;
          try { parsed = JSON.parse(line); break; } catch (_) {}
        }
        let fbid = parsed?.payload?.fbid
                || parsed?.payload?.photoID
                || parsed?.payload?.id
                || null;
        // Fallback: Facebook occasionally nests the uploaded photo id deeper in the
        // payload (or returns payload as an array). Deep-walk for the first fbid /
        // photoID before giving up so a present-but-relocated id isn't missed.
        if (!fbid && parsed) {
          fbid = _deepFind(parsed, (k, v) =>
            ((k === "fbid" || k === "photoID" || k === "photo_id") &&
             (typeof v === "string" || typeof v === "number") && String(v).length > 4)
              ? String(v) : null);
        }
        if (fbid) {
          console.log(`${MODULE} Photo uploaded via HTTP, fbid=${fbid}`);
          resolve({ fbid: String(fbid), transient: false, status: res.statusCode, raw });
        } else {
          // Facebook returned 200 (or other) without a photo id. Capture the raw
          // body so the exact failure (rate limit, blocked image, expired session,
          // checkpoint, endpoint change) is recoverable — otherwise the post just
          // silently fails with no diagnostic trail.
          const snippet = (raw || "").slice(0, 800);
          console.warn(`${MODULE} Upload response has no fbid, status=${res.statusCode}`);
          console.warn(`${MODULE} Upload raw response: ${snippet}`);
          // Logged-out / checkpoint responses are permanent — never retry those.
          // Detect a signed-out/session response in English AND French, plus
          // Facebook's "log in to continue" error code family (1357xxx), so the
          // caller can flag the profile instead of treating it as a transient
          // upload throttle and retrying forever.
          const loggedOut = /"__redirect"|\blogin\b|checkpoint|not logged in|connectez-?vous|veuillez vous connecter|non connect|login_required|"error":1357\d{3}/i.test(raw || "");
          const permanent = loggedOut;
          resolve({ fbid: null, transient: !permanent, loggedOut, status: res.statusCode, raw });
        }
      });
      res.on("error", () => resolve({ fbid: null, transient: true, status: res.statusCode || 0, raw: "" }));
    });
    req.on("error", () => resolve({ fbid: null, transient: true, status: 0, raw: "" }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ fbid: null, transient: true, status: 0, raw: "" }); });
    req.write(bodyBuffer);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Photo upload via an IN-PAGE fetch (browser path only)
//
// The Node-side HTTP upload (`uploadPostImageHttp`) works for healthy accounts but
// is rejected at the network layer ("status 0") or with a 200-and-no-photo-id body
// for flagged / FALLBACK-flow accounts — Facebook applies stricter validation to
// upload.facebook.com requests that don't originate from a genuine browser TLS
// session. Running the multipart upload as a `fetch()` INSIDE the live page makes
// the request indistinguishable from the real composer: same TLS fingerprint, same
// live cookies (credentials:"include"), same-site origin (www → upload). Only
// CORS-safelisted headers are sent (no x-fb-lsd / x-asbd-id) so no preflight is
// triggered — exactly mirroring the real composer upload. lsd is passed in the
// query string instead. Returns { fbid, status, raw, loggedOut }.
// ---------------------------------------------------------------------------
async function uploadPhotoInBrowser(Runtime, { imagePath, tokens, sessionParams = {} }) {
  if (!imagePath || !fs.existsSync(imagePath)) return { fbid: null, status: 0, raw: "" };

  const { dtsg, lsd, uid } = tokens;
  const fileBuffer  = fs.readFileSync(imagePath);
  const base64      = fileBuffer.toString("base64");
  const fileName    = path.basename(imagePath);
  const ext         = fileName.split(".").pop().toLowerCase();
  const mimeMap     = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const contentType = mimeMap[ext] || "image/jpeg";
  const jazoest     = buildJazoest(dtsg);

  const qp = new URLSearchParams({
    av: uid, __aaid: "0", __user: uid, __a: "1", dpr: "1",
    __ccg: "EXCELLENT", __comet_req: "15",
    fb_dtsg: dtsg, jazoest, lsd: lsd || "",
  });
  const UPLOAD_SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs", "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];
  if (sessionParams && typeof sessionParams === "object") {
    UPLOAD_SESSION_KEYS.forEach(k => { if (sessionParams[k]) qp.set(k, sessionParams[k]); });
  }
  const url = "https://upload.facebook.com/ajax/react_composer/attachments/photo/upload?" + qp.toString();

  const argv = JSON.stringify({ url, base64, fileName, contentType, uid: String(uid) });
  const expr = `(async () => {
    const A = ${argv};
    try {
      const bin = atob(A.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: A.contentType });
      const fd = new FormData();
      fd.append("source", "8");
      fd.append("profile_id", A.uid);
      fd.append("waterfallxapp", "comet");
      fd.append("farr", blob, A.fileName);
      fd.append("upload_id", "jsc_c_n");
      const res = await fetch(A.url, { method: "POST", body: fd, credentials: "include", headers: { "accept": "*/*" } });
      const text = await res.text();
      return JSON.stringify({ status: res.status, raw: text });
    } catch (e) {
      return JSON.stringify({ status: 0, raw: "", error: String((e && e.message) || e) });
    }
  })()`;

  let out = { status: 0, raw: "" };
  try {
    const evalRes = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
    const v = evalRes?.result?.value;
    out = typeof v === "string" ? JSON.parse(v) : (v || out);
  } catch (e) {
    return { fbid: null, status: 0, raw: "", error: e.message };
  }

  const raw = out.raw || "";
  let parsed = null;
  for (let line of raw.split("\n")) {
    line = line.trim().replace(/^for\s*\(;;\);\s*/, "");
    if (!line) continue;
    try { parsed = JSON.parse(line); break; } catch (_) {}
  }
  let fbid = parsed?.payload?.fbid
          || parsed?.payload?.photoID
          || parsed?.payload?.id
          || null;
  if (!fbid && parsed) {
    fbid = _deepFind(parsed, (k, v) =>
      ((k === "fbid" || k === "photoID" || k === "photo_id") &&
       (typeof v === "string" || typeof v === "number") && String(v).length > 4)
        ? String(v) : null);
  }
  const loggedOut = /"__redirect"|\blogin\b|checkpoint|not logged in|connectez-?vous|veuillez vous connecter|non connect|login_required|"error":1357\d{3}/i.test(raw);
  return { fbid: fbid ? String(fbid) : null, status: out.status || 0, raw, loggedOut };
}

// ---------------------------------------------------------------------------
// Build GraphQL variables for ComposerStoryCreateMutation
// ---------------------------------------------------------------------------
function buildVariables(uid, facebookGroupId, message, photoId = null) {
  const sessionId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
  return {
    input: {
      composer_entry_point: "inline_composer",
      composer_source_surface: "group",
      composer_type: "group",
      logging: { composer_session_id: sessionId },
      source: "WWW",
      message: { ranges: [], text: message },
      with_tags_ids: null,
      inline_activities: [],
      text_format_preset_id: "0",
      group_flair: { flair_id: null },
      ...(photoId ? { attachments: [{ photo: { id: photoId } }] } : {}),
      composed_text: {
        block_data: ["{}"], block_depths: [0], block_types: [0],
        blocks: [message], entities: ["[]"], entity_map: "{}", inline_styles: ["[]"]
      },
      navigation_data: { attribution_id_v2: "CometGroupDiscussionRoot.react,comet.group,via_cold_start," + Date.now() + ",394427,2361831622,," },
      tracking: [null],
      event_share_metadata: { surface: "newsfeed" },
      audience: { to_id: facebookGroupId },
      actor_id: uid,
      client_mutation_id: String(Math.floor(Math.random() * 9) + 1)
    },
    feedLocation: "GROUP", feedbackSource: 0, focusCommentID: null, gridMediaWidth: null, groupID: null,
    scale: 1, privacySelectorRenderLocation: "COMET_STREAM", checkPhotosToReelsUpsellEligibility: false,
    referringStoryRenderLocation: null, renderLocation: "group", useDefaultActor: false,
    inviteShortLinkKey: null, isFeed: false, isFundraiser: false, isFunFactPost: false,
    isGroup: true, isEvent: false, isTimeline: false, isSocialLearning: false,
    isPageNewsFeed: false, isProfileReviews: false, isWorkSharedDraft: false,
    "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
    "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": true,
    "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": true,
    "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
    "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "AUTO_TRANSLATE",
    "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
    "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
    "__relay_internal__pv__IsWorkUserrelayprovider": false,
    "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
    "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": true,
    "__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider": false,
    "__relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider": false,
    "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
    "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider": false,
    "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider": true,
    "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider": true,
    "__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider": false,
    "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider": false,
    "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider": false,
    "__relay_internal__pv__IsMergQAPollsrelayprovider": false,
    "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider": true,
    "__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider": true,
    "__relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider": false,
    "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider": true,
    "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider": 206,
    "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider": false,
    "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider": true,
    "__relay_internal__pv__groups_comet_use_glvrelayprovider": false,
    "__relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider": false,
    "__relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider": false,
    "__relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider": false,
  };
}

// ---------------------------------------------------------------------------
// Fast path: no browser
// ---------------------------------------------------------------------------
async function postViaHttp({ facebookGroupId, groupUrl, message, imagePath, profileId, cookies, userAgent, proxy, suppressUploadErrorReport = false }) {
  const session = await getFacebookSessionTokens(cookies, userAgent, groupUrl, proxy);
  if (!session) return null; // caller will fall back to browser

  const { dtsg, lsd, uid, cookieHeader } = session;

  // Pull the lightweight session params Facebook embeds in the fetched page HTML so
  // the photo upload mirrors a real browser request. __dyn/__csr are computed
  // client-side and not reliably in static HTML; that's fine — they enrich the
  // request when present and the browser fallback supplies the full set otherwise.
  const httpSessionParams = extractSessionParamsFromHtml(session.pageBody);

  // Upload photo if provided
  let photoId = null;
  if (imagePath) {
    const uploadOutcome = {};
    photoId = await uploadPostImageHttp({ imagePath, tokens: session, userAgent, proxy, sessionParams: httpSessionParams, suppressUploadErrorReport, outcome: uploadOutcome });
    if (!photoId) {
      // A signed-out upload rejection is an account problem — surface it as a
      // session error so the scheduler flags the profile. Do NOT fall back to the
      // browser; it would only hit the same logged-out wall.
      if (uploadOutcome.loggedOut) {
        return { success: false, error: uploadOutcome.errorMessage || 'Profile is not logged in to Facebook.', profileId, path: 'http' };
      }
      console.warn(`${MODULE} [HTTP] Image upload failed — falling back to browser`);
      return null; // trigger browser fallback which will retry the upload
    }
  }

  // Simulate human compose time: random 3–8 second delay before submitting.
  // Zero-latency posts are a strong automation signal.
  await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));

  const variables = buildVariables(uid, String(facebookGroupId), message, photoId);

  const docId = getDocId(MUTATION_NAME);
  console.log(`${MODULE} [HTTP] Firing ${MUTATION_NAME} (doc_id: ${docId}) for group ${facebookGroupId}`);

  const resp = await postGraphQL({
    friendlyName: MUTATION_NAME,
    docId,
    variables, dtsg, lsd, uid, cookieHeader,
    referer: groupUrl,
    userAgent,
    proxy,
  });

  const json = resp.json;
  // A clean FB error response means the post was definitively NOT created — that is
  // handled below and is safe to browser-fallback. Any OTHER unusable response on a
  // request that WAS sent is ambiguous (the post may have landed); we must verify
  // rather than blindly fall back to the browser, which would re-post → duplicate.
  const hasCleanError = json && Array.isArray(json.errors) && json.errors.length > 0;
  if ((!resp.ok || !json) && !hasCleanError) {
    if (resp.requestSent) {
      console.warn(`${MODULE} [HTTP] Post sent but response unusable (status ${resp.status}${resp.errorMessage ? ", " + resp.errorMessage : ""}) — ambiguous, verification required`);
      return { ambiguous: true, profileId, path: "http" };
    }
    console.warn(`${MODULE} [HTTP] GraphQL request not sent (status ${resp.status}) — falling back to browser`);
    return null;
  }

  if (json.errors && json.errors.length) {
    const errMsg = json.errors[0]?.message || JSON.stringify(json.errors);
    console.error(`${MODULE} [HTTP] Facebook API error: ${errMsg}`);
    if (isDocIdError(errMsg)) {
      // Only wipe the cached doc_id on a *definite* doc_id error. Transient
      // Facebook errors must never delete a known-good id (that strands every
      // later request on the stale fallback). Still fall back to the browser so
      // it can rescrape a fresh id from the bundle.
      if (isDefiniteDocIdError(errMsg)) invalidateDocId(MUTATION_NAME);
      return null; // fall back to browser to refresh doc_id
    }
    return { success: false, error: "Facebook API error: " + errMsg, profileId, rawResponse: _snapshotResponse(json) };
  }

  // Not-logged-in / session-expired dispatcher error, e.g.
  // {"error":1357001,"errorSummary":"Connectez-vous pour continuer",...}. This is
  // returned INSTEAD of creating the post, so there is NO duplicate risk. Rather
  // than bench the profile from the naked HTTP path (which has no session context
  // and can't tell a transient IP challenge from a real logout), fall back to the
  // browser path — it has the persistent real cookie jar and re-checks the live
  // session to decide whether this is a transient challenge (retry) or a true logout.
  if ((typeof json.error === "number" || json.errorSummary || json.errorDescription) &&
      /"__redirect"|checkpoint|not logged in|connectez-?vous|veuillez vous connecter|non connect|login_required|"error":13\d{5}|please log ?in|log in to continue/i.test(resp.rawText || _snapshotResponse(json) || "")) {
    console.warn(`${MODULE} [HTTP] Login dispatcher error — falling back to browser for a definitive session check`);
    return null;
  }

  const storyCreate = json?.data?.story_create;
  // Deep-extract identifiers — Facebook sometimes omits story.id but nests the
  // numeric id / feedback id deeper in the response, OR streams it in a later
  // @defer fragment (resp.jsonChunks[1+]). The feedback id is exactly what the
  // first comment needs, so prefer it when present.
  const { postId, numericPostId, feedbackId } = extractStoryIds(storyCreate, json, resp.jsonChunks);
  updateDocId(MUTATION_NAME, docId); // confirm this doc_id is still valid
  console.log(`${MODULE} [HTTP] Post success, postId: ${postId}, numericPostId: ${numericPostId}, feedbackId: ${feedbackId ? "yes" : "no"}`);

  // Refresh-back: Facebook rotates `xs`/`fr`/`datr` and returns the new values via
  // Set-Cookie on the page fetch and the GraphQL response. Persist them so the
  // stored snapshot stays in sync and the profile doesn't go stale → "logged out".
  try {
    const rotated = parseSetCookies([
      ...(session.setCookieHeaders || []),
      ...(resp.setCookieHeaders || []),
    ]);
    if (rotated.length) await persistFreshCookies(profileId, rotated);
  } catch (e) {
    console.warn(`${MODULE} [HTTP] Cookie refresh-back failed for ${profileId}: ${e.message}`);
  }

  const httpOut = { success: true, postId, numericPostId, feedbackId, userId: uid, profileId, message };
  // ~1% case: Facebook accepted the post but returned no usable id. Capture the
  // FULL raw response (including any @defer streaming fragments) so the exact
  // shape that defeated extraction is recoverable.
  if (!postId && !numericPostId && !feedbackId) {
    httpOut.idMissing = true;
    httpOut.rawResponse = _snapshotResponse(resp.rawText || json);
    httpOut.path = "http";
    console.warn(`${MODULE} [HTTP] Post succeeded but no id extracted — captured raw response for diagnostics`);
  }
  return httpOut;
}

// ---------------------------------------------------------------------------
// Human-mode behavioral helpers
//
// A bot signature isn't only the device fingerprint — it's the EMPTY session
// around the write: opening straight on the group deep-link and firing the post
// mutation with no browsing, no composer interaction, and an instant close. These
// helpers wrap the (reliable) GraphQL fetch submit in a believable human session:
// a warm-up on the home feed, dwell + scroll on the group, and opening the REAL
// composer to emit composer-open / text-change telemetry before discarding the
// draft (the actual post is still sent via the fetch). Everything is best-effort
// and never throws — a selector miss simply skips that step and the post proceeds.
// ---------------------------------------------------------------------------
const _rand  = (min, max) => Math.floor(min + Math.random() * (max - min));
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Last known virtual cursor position (CDP has no global cursor state, so we track
// it ourselves to move along a continuous path instead of teleporting). Seeded to a
// random spot so the very first move isn't from a fixed origin every session.
let _mouseX = _rand(120, 700);
let _mouseY = _rand(120, 500);

// Per-session human "persona": small multipliers applied to every timing so two
// sessions are never paced identically. This defeats the "repeated identical
// interaction patterns across sessions" signal — same code, different rhythm each run.
function makeHumanPersona() {
  return {
    typeSpeed:  0.72 + Math.random() * 0.85,  // per-keystroke delay multiplier
    reactSpeed: 0.70 + Math.random() * 0.90,  // notice -> decide -> act reaction multiplier
    moveSpeed:  0.70 + Math.random() * 0.80,  // mouse travel-step multiplier
    overshoot:  Math.random() < 0.6,          // this session tends to overshoot targets
    typo:       Math.random() < 0.35,         // this session occasionally "mistypes" + corrects
  };
}

// Cubic-bezier evaluation (one axis).
function _bezier(t, a, b, c, d) {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
}

// Move the virtual cursor to (toX,toY) along a CURVED, variable-speed path with an
// ease-in/ease-out velocity profile and an occasional small overshoot + correction.
// Uses real CDP mouseMoved events so the path looks human, not a straight constant
// -speed line. Never throws.
async function humanMouseMove(Input, toX, toY, persona) {
  const fromX = _mouseX, fromY = _mouseY;
  const dist  = Math.hypot(toX - fromX, toY - fromY);
  const steps = Math.max(10, Math.min(42, Math.round(dist / 11)));
  // Two control points offset perpendicular-ish from the straight line create a gentle arc.
  const cp1x = fromX + (toX - fromX) * (0.25 + Math.random() * 0.2) + (Math.random() - 0.5) * 70;
  const cp1y = fromY + (toY - fromY) * (0.25 + Math.random() * 0.2) + (Math.random() - 0.5) * 70;
  const cp2x = fromX + (toX - fromX) * (0.65 + Math.random() * 0.2) + (Math.random() - 0.5) * 70;
  const cp2y = fromY + (toY - fromY) * (0.65 + Math.random() * 0.2) + (Math.random() - 0.5) * 70;
  for (let i = 1; i <= steps; i++) {
    let t = i / steps;
    t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out: accelerate then decelerate
    const x = Math.round(_bezier(t, fromX, cp1x, cp2x, toX));
    const y = Math.round(_bezier(t, fromY, cp1y, cp2y, toY));
    try { await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y }); } catch (_) {}
    _mouseX = x; _mouseY = y;
    await _sleep(Math.round((5 + Math.random() * 13) * (persona?.moveSpeed || 1)));
  }
  // Occasional overshoot + correction so the cursor doesn't land dead-on every time.
  if (persona?.overshoot && Math.random() < 0.5) {
    const ox = Math.round(toX + (Math.random() - 0.5) * 20);
    const oy = Math.round(toY + (Math.random() - 0.5) * 20);
    try { await Input.dispatchMouseEvent({ type: 'mouseMoved', x: ox, y: oy }); } catch (_) {}
    _mouseX = ox; _mouseY = oy;
    await _sleep(_rand(40, 120));
  }
  try { await Input.dispatchMouseEvent({ type: 'mouseMoved', x: toX, y: toY }); } catch (_) {}
  _mouseX = toX; _mouseY = toY;
}

// Human click at a viewport coordinate: travel there with a curved path, pause for a
// realistic "notice + decide" reaction time, then a real mouse press/release with a
// short randomized hold. Returns true if the click was issued. Never throws.
async function humanClickAt(client, x, y, persona) {
  const { Input } = client;
  try {
    await humanMouseMove(Input, x, y, persona);
    await _sleep(Math.round(_rand(130, 400) * (persona?.reactSpeed || 1))); // reaction time before pressing
    await Input.dispatchMouseEvent({ type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
    await _sleep(_rand(55, 140)); // button hold duration
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  } catch (_) { return false; }
}

// Type a string into the currently-focused field like a human: one character at a
// time with variable inter-key delays, longer pauses after spaces/punctuation, and
// (per persona) an occasional typo that is corrected with Backspace. Never throws.
async function humanType(Input, text, persona) {
  let typed = 0;
  const mult = persona?.typeSpeed || 1;
  for (const ch of String(text)) {
    // Rare typo: insert a wrong char, brief pause, backspace, then the right one.
    if (persona?.typo && Math.random() < 0.03 && /[a-zA-Z]/.test(ch)) {
      const wrong = String.fromCharCode(ch.charCodeAt(0) + (Math.random() < 0.5 ? 1 : -1));
      try { await Input.insertText({ text: wrong }); } catch (_) {}
      await _sleep(Math.round(_rand(120, 300) * mult));
      try {
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await Input.dispatchKeyEvent({ type: 'keyUp',   key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      } catch (_) {}
      await _sleep(Math.round(_rand(80, 200) * mult));
    }
    try { await Input.insertText({ text: ch }); typed++; } catch (_) {}
    // Base per-key delay, longer after word boundaries / punctuation, with rare "thinking" pauses.
    let d = _rand(45, 130);
    if (ch === ' ') d += _rand(20, 90);
    if (/[.,!?\n]/.test(ch)) d += _rand(80, 220);
    if (Math.random() < 0.05) d += _rand(250, 700); // occasional pause mid-typing
    await _sleep(Math.round(d * mult));
  }
  return typed;
}

// Incremental, eased scroll within the current page. Never throws.
async function humanScroll(Runtime, { steps = 3 } = {}) {
  for (let i = 0; i < steps; i++) {
    try {
      const dy = _rand(250, 650);
      await Runtime.evaluate({ expression: `window.scrollBy({ top: ${dy}, left: 0, behavior: 'smooth' });` });
    } catch (_) {}
    await _sleep(_rand(700, 1800));
  }
  try { await Runtime.evaluate({ expression: `window.scrollBy({ top: ${-_rand(150, 400)}, behavior: 'smooth' });` }); } catch (_) {}
  await _sleep(_rand(400, 1100));
}

// Light session warm-up: land on the home feed, dwell + scroll, so the subsequent
// group navigation carries an intra-session referer chain instead of a cold
// deep-link entry. Best-effort; never throws.
async function humanWarmup(Page, Runtime) {
  try {
    await Page.navigate({ url: "https://www.facebook.com/" });
    await _sleep(_rand(3000, 5500));
    try { await dismissFacebookWarningDialog(Runtime); } catch (_) {}
    await humanScroll(Runtime, { steps: _rand(2, 4) });
    await _sleep(_rand(1200, 3000));
  } catch (_) {}
}

// Known composer-opener placeholders for the app's primary locales (EN/FR/AR) plus
// common variants. This is only a FAST PATH used to prioritise the right opener;
// detection is NOT limited to these — emitComposerTelemetry falls back to a
// language-agnostic structural search and verifies the opened dialog, so the
// composer works in ANY Facebook interface language.
const _COMPOSER_PLACEHOLDERS = [
  "write something", "what's on your mind", "what is on your mind", "start a discussion",
  "exprimez-vous", "\u00e9crire quelque chose", "que voulez-vous dire", "quoi de neuf",
  "\u0628\u0645 \u062a\u0641\u0643\u0631", "\u0628\u0645\u0627\u0630\u0627 \u062a\u0641\u0643\u0631", "\u0627\u0643\u062a\u0628 \u0634\u064a"
];

// Open the real group composer, emit realistic typing telemetry, then DISCARD the
// draft without posting (the genuine post is fired via the reliable GraphQL fetch).
// This makes the write mutation arrive alongside the composer-open and text-change
// client events Facebook expects from a human post. Returns true if exercised.
async function emitComposerTelemetry(client, message, persona = null) {
  const { Runtime, Input } = client;
  persona = persona || makeHumanPersona();
  // Diagnostic record so logs can PROVE which steps actually hit on the live DOM
  // (the selectors are heuristic; this tells us if they matched or silently missed).
  const diag = { openerFound: false, matchedPlaceholder: null, textboxFocused: false, composerPlaceholder: null, typedChars: 0, draftDiscarded: false };
  try {
    // 1) Collect composer-opener CANDIDATES and tag them, then click them in
    //    priority order until one actually opens the post-composer dialog.
    //    LANGUAGE-AGNOSTIC: we do NOT depend on the placeholder being one of the
    //    known locales. Placeholder-text matches (when the locale is known) are
    //    tried FIRST for precision; otherwise we fall back to STRUCTURAL detection
    //    (a wide role=button near the top of the feed showing a short single line),
    //    and a candidate is only ACCEPTED if clicking it renders a Lexical textbox
    //    inside a [role="dialog"] — a check that is itself locale-independent.
    const tagRes = await Runtime.evaluate({
      returnByValue: true,
      expression: `(() => {
        try {
          const needles = ${JSON.stringify(_COMPOSER_PLACEHOLDERS)};
          const seen = new Set();
          const cands = [];
          const add = (btn, source, placeholder) => {
            if (!btn || seen.has(btn)) return;
            if (btn.closest('[role="dialog"]')) return;   // never click inside an open dialog
            if (btn.closest('a[href]')) return;           // never click a navigating link
            seen.add(btn);
            cands.push({ btn, source, placeholder: placeholder || null });
          };
          // (a) precise: known placeholder text -> nearest role=button ancestor.
          for (const el of Array.from(document.querySelectorAll('div,span'))) {
            const t = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (!t || t.length > 60) continue;
            const hit = needles.find(n => t.includes(n));
            if (!hit) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.height < 10 || r.top > 1100) continue;
            const btn = el.closest('[role="button"]');
            if (btn) add(btn, 'placeholder', hit);
          }
          // (b) structural fallback (works in ANY language): a wide role=button near
          //     the top of the feed whose label is a single short line of text.
          const struct = [];
          for (const btn of Array.from(document.querySelectorAll('[role="button"]'))) {
            if (btn.closest('[role="dialog"]') || btn.closest('a[href]')) continue;
            const r = btn.getBoundingClientRect();
            if (r.top < 80 || r.top > 1100) continue;
            if (r.width < 250 || r.height < 36 || r.height > 110) continue;
            const txt = (btn.innerText || btn.textContent || '').trim();
            if (!txt || txt.length > 40 || txt.split('\\n').length > 1) continue;
            struct.push({ btn, top: r.top });
          }
          struct.sort((a, b) => a.top - b.top);
          struct.slice(0, 6).forEach(s => add(s.btn, 'structural', null));
          // tag the chosen candidates so Node can click them one at a time.
          const out = [];
          cands.slice(0, 6).forEach((c, i) => {
            c.btn.setAttribute('data-vc-opener', String(i));
            out.push({ idx: i, source: c.source, placeholder: c.placeholder });
          });
          return { ok: true, candidates: out };
        } catch (e) { return { ok: false, error: String(e && e.message) }; }
      })()`,
    });
    const candidates = tagRes?.result?.value?.candidates || [];
    if (!candidates.length) {
      console.warn(`${MODULE} [Human] No composer-opener candidates found — skipping composer telemetry, post still proceeds via fetch`);
      return diag;
    }
    console.log(`${MODULE} [Human] Found ${candidates.length} composer-opener candidate(s); trying in order`);

    // 2) Click candidates one at a time; ACCEPT the one that opens a dialog with a
    //    Lexical textbox (locale-independent). A feed comment box is also a
    //    role=textbox/contenteditable Lexical editor, but it lives INLINE (NOT in a
    //    [role="dialog"]) — so dialog-scoping prevents typing into a comment field.
    //    Escape any wrong popup before trying the next candidate.
    let focused = false;
    for (const cand of candidates) {
      // Scroll the candidate into view and read its on-screen rect so we can move a
      // REAL cursor to it (curved path + reaction delay) instead of firing a
      // synthetic DOM click that has no pointer telemetry. DOM .click() is kept as a
      // fallback only when coordinates are unavailable (e.g. element off-screen).
      const rectRes = await Runtime.evaluate({
        returnByValue: true,
        expression: `(() => { try { const b = document.querySelector('[data-vc-opener="${cand.idx}"]'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, ok: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= (window.innerHeight || 1080) }; } catch(e){ return null; } })()`,
      });
      await _sleep(_rand(350, 850)); // let the smooth-scroll settle + "notice" the target
      const rect = rectRes?.result?.value || null;
      let clicked = false;
      if (rect && rect.ok) {
        // Aim at a randomized point INSIDE the button (not dead-center) for realism.
        const jx = Math.round(rect.x + (Math.random() - 0.5) * Math.min(40, rect.w * 0.5));
        const jy = Math.round(rect.y + (Math.random() - 0.5) * Math.min(16, rect.h * 0.5));
        clicked = await humanClickAt(client, jx, jy, persona);
      }
      if (!clicked) {
        const domClick = await Runtime.evaluate({
          returnByValue: true,
          expression: `(() => { try { const b = document.querySelector('[data-vc-opener="${cand.idx}"]'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; } catch(e){ return false; } })()`,
        });
        clicked = !!domClick?.result?.value;
      }
      if (!clicked) continue;
      diag.openerFound = true;
      // NOTE: do NOT call dismissFacebookWarningDialog here — it presses Escape and
      // clicks the first button inside any [role="dialog"], which would instantly
      // CLOSE the composer modal we just opened. We only poll for the textbox.
      await _sleep(_rand(900, 1800));
      for (let attempt = 0; attempt < 8 && !focused; attempt++) {
        const focusRes = await Runtime.evaluate({
          returnByValue: true,
          expression: `(() => {
            try {
              const dlgs = Array.from(document.querySelectorAll('[role="dialog"]'));
              for (const dlg of dlgs) {
                const box = dlg.querySelector('div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]')
                         || dlg.querySelector('div[role="textbox"][contenteditable="true"]');
                if (!box) continue;
                const r = box.getBoundingClientRect();
                if (r.width < 100 || r.height < 10) continue;
                box.focus();
                return { ok: true, ph: box.getAttribute('aria-placeholder') || '' };
              }
              return { ok: false };
            } catch (e) { return { ok: false }; }
          })()`,
        });
        const fv = focusRes?.result?.value || {};
        if (fv.ok) {
          focused = true;
          diag.composerPlaceholder = fv.ph || null;
          diag.matchedPlaceholder = cand.placeholder || fv.ph || null;
          break;
        }
        await _sleep(400);
      }
      if (focused) {
        console.log(`${MODULE} [Human] Composer opened via ${cand.source} candidate #${cand.idx} (aria-placeholder: "${diag.composerPlaceholder || ''}")`);
        break;
      }
      console.warn(`${MODULE} [Human] Candidate #${cand.idx} (${cand.source}) did not open the composer — dismissing and trying next`);
      try {
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await Input.dispatchKeyEvent({ type: 'keyUp',   key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}
      try { await dismissFacebookWarningDialog(Runtime); } catch (_) {}
      await _sleep(_rand(300, 700));
    }

    // Remove our temporary tags regardless of outcome.
    try { await Runtime.evaluate({ expression: `(() => { try { document.querySelectorAll('[data-vc-opener]').forEach(e => e.removeAttribute('data-vc-opener')); } catch(e){} })()` }); } catch (_) {}

    diag.textboxFocused = focused;
    if (!diag.textboxFocused) {
      console.warn(`${MODULE} [Human] No candidate opened the composer dialog — post still proceeds via fetch`);
      return diag;
    }
    console.log(`${MODULE} [Human] Composer textbox focused (aria-placeholder: "${diag.composerPlaceholder || ''}")`);

    // 3) Type a representative portion of the text ONE CHARACTER AT A TIME with
    //    human pacing (variable per-key delays, longer pauses after spaces/punctuation,
    //    rare "thinking" pauses, occasional typo+correction) so Facebook records
    //    natural keystroke/text-change telemetry — not a uniform-interval burst.
    //    Length is capped to keep timing sane; the FULL text is sent via the fetch.
    const sample = String(message || '').slice(0, 80);
    await _sleep(Math.round(_rand(250, 650) * (persona.reactSpeed || 1))); // glance at the field before typing
    diag.typedChars = await humanType(Input, sample, persona);
    console.log(`${MODULE} [Human] Typed ${diag.typedChars} chars into composer`);
    await _sleep(_rand(900, 2200)); // re-reading pause before "deciding" to post

    // 4) Discard the draft WITHOUT posting: clear the box, press Escape, accept the
    //    "Discard post?" confirmation. The real post is fired by the fetch path, so
    //    even if the dialog isn't dismissed the leftover draft never auto-submits.
    try {
      await Runtime.evaluate({ expression: `(() => { try { const b = document.querySelector('[role="dialog"] div[role="textbox"][contenteditable="true"][data-lexical-editor="true"]') || document.querySelector('[role="dialog"] div[role="textbox"][contenteditable="true"]'); if (b) { b.focus(); document.execCommand && document.execCommand('selectAll', false, null); document.execCommand && document.execCommand('delete', false, null); } } catch(e){} })()` });
    } catch (_) {}
    await _sleep(_rand(300, 700));
    try {
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await Input.dispatchKeyEvent({ type: 'keyUp',   key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    } catch (_) {}
    await _sleep(_rand(700, 1400));
    // Click the destructive "Discard" button in the confirmation dialog (role-based).
    try {
      const discardRes = await Runtime.evaluate({ returnByValue: true, expression: `(() => { try {
        const dlg = document.querySelector('[role="dialog"]'); if (!dlg) return false;
        const btns = Array.from(dlg.querySelectorAll('[role="button"], button'));
        const tgt = btns[btns.length - 1]; if (tgt) { tgt.click(); return true; }
        return false;
      } catch(e){ return false; } })()` });
      diag.draftDiscarded = !!discardRes?.result?.value;
    } catch (_) {}
    await _sleep(_rand(500, 1000));
    try { await dismissFacebookWarningDialog(Runtime); } catch (_) {}
    console.log(`${MODULE} [Human] Composer telemetry done — opener=${diag.openerFound} textbox=${diag.textboxFocused} typed=${diag.typedChars} discardDialog=${diag.draftDiscarded}`);
    return diag;
  } catch (e) {
    console.warn(`${MODULE} [Human] Composer telemetry error: ${e.message}`);
    return diag;
  }
}

// ---------------------------------------------------------------------------
// Fallback path: browser
// ---------------------------------------------------------------------------
async function postViaBrowser({ facebookGroupId, groupUrl, message, imagePath, profileId, cookies, proxy, fingerprint, suppressUploadErrorReport = false, human = false, watch = false, firstCommentText = '' }) {
  let client = null;
  let chromeProcess = null;
  // Once Runtime.evaluate is asked to run the create-post mutation, a transport
  // error is ambiguous: Facebook may have accepted the request while only the
  // response was lost. Keep this outside the try block so the outer CDP catch can
  // preserve that distinction and the caller can verify instead of re-posting.
  let submissionStarted = false;

  try {
    console.log(`${MODULE} [Browser] Launching browser for profile: ${profileId}`);
    // Human-mode "watch" runs the browser HEADFUL so the operator can visually
    // verify the warmup/scroll/composer steps; normal automation stays headless.
    const headless = !(human && watch);
    if (human && watch) console.log(`${MODULE} [Human] WATCH mode ON — launching VISIBLE (headful) browser`);
    // One per-session persona governs ALL timing this run (typing speed, reaction
    // time, mouse travel, overshoot/typo tendencies) so no two sessions are paced
    // identically — defeating the "identical interaction patterns across sessions" signal.
    const persona = human ? makeHumanPersona() : null;
    if (persona) console.log(`${MODULE} [Human] Session persona: type=${persona.typeSpeed.toFixed(2)}x react=${persona.reactSpeed.toFixed(2)}x move=${persona.moveSpeed.toFixed(2)}x overshoot=${persona.overshoot} typo=${persona.typo}`);
    const startResult = await startVCBrowser(profileId, fingerprint, "about:blank", proxy, headless, true);
    if (!startResult || !startResult.client) {
      return { success: false, error: "Failed to start VCBrowser", profileId };
    }
    client = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;
    await Network.enable();

    // Maximize the window so the visible browser fills the screen. Only done in
    // the headful "watch" testing mode — in headless mode it has no visible effect
    // and we avoid touching the window bounds to keep the fingerprint viewport intact.
    if (!headless) {
      try {
        const { windowId } = await client.Browser.getWindowForTarget();
        await client.Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } });
        await client.Browser.setWindowBounds({ windowId, bounds: { windowState: 'maximized' } });
      } catch (e) { console.warn(`${MODULE} [Browser] Could not maximize window: ${e.message}`); }
    }

    const sessionParams = {};
    const capturedDocIds = {};
    const SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs", "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];
    Network.requestWillBeSent(({ request }) => {
      if (request.url?.includes("facebook.com/api/graphql") && request.postData) {
        try {
          const p = new URLSearchParams(request.postData);
          SESSION_KEYS.forEach(k => { const v = p.get(k); if (v && !sessionParams[k]) sessionParams[k] = v; });
          const fn = p.get("fb_api_req_friendly_name");
          const di = p.get("doc_id");
          if (fn && di) capturedDocIds[fn] = di;
        } catch (_) {}
      }
    });

    await injectCookiesIfLoggedOut(Network, cookies, `${MODULE} [Browser]`);

    // Human mode: warm up on the home feed first so the group navigation carries a
    // real intra-session referer chain instead of a cold deep-link entry.
    if (human) {
      console.log(`${MODULE} [Browser] Human mode: warming up on home feed`);
      await humanWarmup(Page, Runtime);
    }

    console.log(`${MODULE} [Browser] Navigating to ${groupUrl}`);

    // Navigate to the group, retrying on a login/checkpoint redirect. Facebook
    // frequently serves a TRANSIENT login/checkpoint interstitial to a perfectly
    // valid session (request from a new proxy IP, soft-throttle, slow bundle load)
    // that clears on reload. Treating the FIRST such redirect as a dead session was
    // pausing healthy workflows on their first attempt. We reload a few times — and
    // settle via the FB home page between tries — before concluding the profile is
    // genuinely logged out. A real logout / checkpoint persists across all attempts.
    let currentUrl = "";
    let loggedIn = false;
    const NAV_ATTEMPTS = 3;
    for (let nav = 1; nav <= NAV_ATTEMPTS; nav++) {
      await Page.navigate({ url: groupUrl });
      await new Promise(r => setTimeout(r, nav === 1 ? 8000 : 6000));
      await dismissFacebookWarningDialog(Runtime);
      const urlEval = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
      currentUrl = urlEval.result?.value || "";
      if (!currentUrl.includes("login") && !currentUrl.includes("checkpoint")) { loggedIn = true; break; }
      console.warn(`${MODULE} [Browser] Login/checkpoint redirect on attempt ${nav}/${NAV_ATTEMPTS} (url=${currentUrl.slice(0, 80)})`);
      if (nav < NAV_ATTEMPTS) {
        // Settle the session on the home page first, then retry the group page.
        try {
          await Page.navigate({ url: "https://www.facebook.com/" });
          await new Promise(r => setTimeout(r, 4000 + Math.random() * 2000));
          await dismissFacebookWarningDialog(Runtime);
        } catch (_) {}
      }
    }
    if (!loggedIn) {
      return { success: false, error: "Profile is not logged in to Facebook. Please open the profile and log in first.", profileId };
    }

    // Scan page HTML for fresh doc_ids (best-effort)
    try {
      const htmlEval = await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true });
      const pageHtml = htmlEval?.result?.value || "";
      if (pageHtml) updateMany(extractDocIdsFromHtml(pageHtml));
    } catch (_) {}

    // Human mode: dwell + scroll on the group as if reading the feed before posting.
    if (human) {
      console.log(`${MODULE} [Human] On group page — dwell + scroll before posting`);
      await _sleep(_rand(2500, 5000));
      await humanScroll(Runtime, { steps: _rand(2, 4) });
      await _sleep(_rand(1200, 3000));
    }

    const facebookGroupIdSafe = JSON.stringify(String(facebookGroupId));
    const messageSafe         = JSON.stringify(String(message));
    const sessionParamsSafe   = JSON.stringify(sessionParams);
    const docIdSafe           = JSON.stringify(getDocId(MUTATION_NAME));

    // Upload photo from Node.js side using page tokens extracted via CDP.
    // Token extraction is resilient: try Facebook's internal module loader first,
    // then fall back to regex-scraping the live page HTML (the dtsg/lsd tokens are
    // always embedded in inline JSON even when require() isn't ready yet on a slow
    // or soft-blocked page load). uid always falls back to the c_user cookie. The
    // whole extraction is retried a few times because the bundle that defines these
    // modules can finish loading a few seconds after the initial 8s wait.
    let photoId = null;
    if (imagePath) {
      try {
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        const extractTokens = async () => {
          const tokenEval = await Runtime.evaluate({
            expression: `JSON.stringify((() => {
              const dtsg = (() => { try { const r = require("DTSGInitialData"); if (r?.token) return r.token; } catch(_) {} return null; })();
              const lsd  = (() => { try { const r = require("LSD"); if (r?.token) return r.token; } catch(_) {} return ""; })();
              const uid  = (() => { try { const r = require("CurrentUserInitialData"); if (r?.USER_ID) return String(r.USER_ID); } catch(_) {} const m = document.cookie.match(/c_user=([^;]+)/); return m ? m[1].trim() : null; })();
              return {dtsg, lsd, uid};
            })())`,
            returnByValue: true,
          });
          let t = {};
          try { t = JSON.parse(tokenEval.result?.value || "{}"); } catch (_) {}
          // Regex fallback on the live page HTML when the module loader came up empty.
          if (!t.dtsg || !t.uid || !t.lsd) {
            try {
              const htmlEval = await Runtime.evaluate({ expression: "document.documentElement.innerHTML", returnByValue: true });
              const html = htmlEval?.result?.value || "";
              if (!t.dtsg) {
                t.dtsg = (html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
                          html.match(/name="fb_dtsg" value="([^"]+)"/) ||
                          html.match(/"dtsg_ag"\s*:\s*\{"token"\s*:\s*"([^"]+)"/))?.[1] || t.dtsg || null;
              }
              if (!t.lsd) {
                t.lsd = (html.match(/"LSD",\[\],\{"token":"([^"]+)"/) ||
                         html.match(/name="lsd" value="([^"]+)"/))?.[1] || t.lsd || "";
              }
              if (!t.uid) {
                t.uid = (html.match(/"USER_ID"\s*:\s*"(\d+)"/) || [])[1] ||
                        (cookieHeader.match(/c_user=(\d+)/) || [])[1] || t.uid || null;
              }
            } catch (_) {}
          }
          return t;
        };

        let pageTokens = await extractTokens();
        for (let i = 0; i < 2 && (!pageTokens.dtsg || !pageTokens.uid); i++) {
          console.log(`${MODULE} [Browser] Tokens not ready yet (attempt ${i + 1}) — waiting before retry`);
          await new Promise(r => setTimeout(r, 3000));
          try { await dismissFacebookWarningDialog(Runtime); } catch (_) {}
          pageTokens = await extractTokens();
        }
        console.log(`${MODULE} [Browser] Page tokens: dtsg=${pageTokens.dtsg ? pageTokens.dtsg.slice(0,8)+"..." : "MISSING"}, uid=${pageTokens.uid || "MISSING"}, lsd=${pageTokens.lsd ? pageTokens.lsd.slice(0,8)+"..." : "MISSING"}`);
        // A uid of "0" (or empty) means the injected cookies are signed out even
        // though the group shell loaded — never upload with uid=0 (Facebook rejects
        // it with a "log in to continue" error). Treat it as a logged-out session.
        const uidValid = pageTokens.uid && String(pageTokens.uid) !== "0";
        if (pageTokens.dtsg && uidValid) {
          const userAgent = fingerprint.userAgent || defaultUserAgent();
          // Primary: upload via an in-page fetch so the request carries the
          // browser's real TLS fingerprint + live cookies (identical to the genuine
          // composer upload). This avoids the Node-HTTP "status 0" rejections that
          // flagged / FALLBACK-flow profiles hit on upload.facebook.com.
          const inPage = await uploadPhotoInBrowser(Runtime, {
            imagePath,
            tokens: { dtsg: pageTokens.dtsg, lsd: pageTokens.lsd, uid: pageTokens.uid },
            sessionParams,
          });
          photoId = inPage.fbid;
          if (photoId) {
            console.log(`${MODULE} [Browser] Photo uploaded in-page, photoId=${photoId} (status ${inPage.status})`);
          } else if (inPage.loggedOut) {
            return { success: false, error: 'Profile is not logged in to Facebook (session expired during photo upload).', profileId, path: 'browser' };
          } else {
            // In-page upload came back empty — fall back to the Node HTTP path.
            console.warn(`${MODULE} [Browser] In-page upload returned no photo id (status ${inPage.status}) — falling back to HTTP upload`);
            const uploadOutcome = {};
            photoId = await uploadPostImageHttp({
              imagePath,
              tokens: { dtsg: pageTokens.dtsg, lsd: pageTokens.lsd, uid: pageTokens.uid, cookieHeader },
              userAgent,
              proxy,
              sessionParams,
              suppressUploadErrorReport,
              outcome: uploadOutcome,
            });
            console.log(`${MODULE} [Browser] Photo upload result: photoId=${photoId}`);
            if (!photoId) {
              // Signed-out upload rejection → return a session error so the scheduler
              // flags the profile (NOT imageUploadFailed, which would be retried).
              if (uploadOutcome.loggedOut) {
                return { success: false, error: uploadOutcome.errorMessage || 'Profile is not logged in to Facebook (session expired during photo upload).', profileId, path: 'browser' };
              }
              return { success: false, error: 'Image upload failed. Post aborted to avoid posting without image.', imageUploadFailed: true, profileId };
            }
          }
        } else if (pageTokens.dtsg && !uidValid) {
          console.warn(`${MODULE} [Browser] Aborting — user id is 0/empty, the profile is signed out`);
          return { success: false, error: 'Profile is not logged in to Facebook (no valid user id — the account appears signed out). Please open the profile and log in.', profileId, path: 'browser' };
        } else {
          console.warn(`${MODULE} [Browser] Skipping photo upload — missing page tokens (dtsg=${!!pageTokens.dtsg}, uid=${!!pageTokens.uid})`);
          return { success: false, error: 'Image upload failed: could not extract page tokens. Post aborted to avoid posting without image.', imageUploadFailed: true, profileId };
        }
      } catch (uploadErr) {
        console.warn(`${MODULE} [Browser] Photo upload failed: ${uploadErr.message}`);
        return { success: false, error: `Image upload failed: ${uploadErr.message}. Post aborted to avoid posting without image.`, imageUploadFailed: true, profileId };
      }
    }

    // Human mode: open the real composer to emit composer-open + typing telemetry,
    // then discard the draft. The actual post is still fired via the fetch below, so
    // there is no double-post risk (the composer UI never clicks "Post").
    if (human) {
      try {
        const tele = await emitComposerTelemetry(client, message, persona);
        if (!tele || !tele.openerFound) {
          console.warn(`${MODULE} [Human] Composer telemetry was SKIPPED (selectors did not match) — verify selectors; post will still be sent via fetch`);
        }
      } catch (e) { console.warn(`${MODULE} [Human] Composer telemetry threw: ${e.message}`); }
    }

    const photoIdSafe = JSON.stringify(photoId);
    const jsCode = buildBrowserJsCode(sessionParamsSafe, facebookGroupIdSafe, messageSafe, docIdSafe, photoIdSafe);
    submissionStarted = true;
    const evalResult = await Runtime.evaluate({ expression: jsCode, awaitPromise: true, returnByValue: true });

    let postResult;
    try {
      const raw = evalResult.result?.value;
      postResult = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    } catch (_) {
      postResult = { error: "Could not parse browser result: " + String(evalResult.result?.value) };
    }

    // Not-logged-in challenge discrimination. Facebook can return the "log in to
    // continue" dispatcher error (error 1357001) to a request even when the profile
    // is genuinely logged in — a transient, IP/session-trust challenge (common when
    // the exit IP just rotated). Re-read the LIVE cookie jar: if c_user + xs are
    // still present, the on-disk session is intact, so this is a TRANSIENT challenge
    // that must be retried, NOT a real logout that benches the profile. Only when the
    // live jar has actually lost the session do we surface it as a hard session loss.
    if (postResult?.loginError) {
      let liveStillValid = false;
      try {
        const live = await Network.getAllCookies();
        liveStillValid = hasValidFbSession(live && live.cookies);
      } catch (_) {}
      if (liveStillValid) {
        console.warn(`${MODULE} [Browser] Not-logged-in challenge but the live session is still valid (c_user+xs present) — treating as a TRANSIENT challenge, not a logout`);
        postResult = {
          error: "Facebook served a temporary challenge for this request; the profile is still valid — will retry.",
          transient: true, sessionChallenge: true,
          rawResponse: postResult.rawResponse || null,
        };
      } else {
        console.warn(`${MODULE} [Browser] Not-logged-in challenge AND the live jar lost the session — real logout`);
        postResult = {
          error: "Profile is not logged in to Facebook (session expired). Please open the profile and log in.",
          rawResponse: postResult.rawResponse || null,
        };
      }
    }
    const intercepted = capturedDocIds[MUTATION_NAME];
    if (!postResult?.error) updateDocId(MUTATION_NAME, intercepted || getDocId(MUTATION_NAME));
    else if (isDefiniteDocIdError(postResult.error)) invalidateDocId(MUTATION_NAME);

    console.log(`${MODULE} [Browser] Result:`, JSON.stringify(postResult));

    // Human mode: linger and scroll to the top to "see" the published post before
    // closing, instead of an instant close right after the write.
    if (human && !postResult?.error) {
      await _sleep(_rand(2500, 5000));
      try { await Runtime.evaluate({ expression: "window.scrollTo({ top: 0, behavior: 'smooth' });" }); } catch (_) {}
      await _sleep(_rand(1500, 3500));
    }

    // Human mode + auto first comment: stay in the SAME browser session, do a few
    // human interactions (dwell + scroll), THEN post the first comment — instead of
    // opening a separate fresh browser that comments instantly. This keeps the post
    // and its first comment in one coherent session, same IP, with real activity in
    // between, which is what a human actually does.
    let firstComment = null;
    if (human && firstCommentText && !postResult?.error) {
      const _fbId  = postResult.feedbackId || null;
      const _numId = postResult.numericPostId || null;
      const _story = postResult.postId || null;
      if (_fbId || _numId || _story) {
        try {
          console.log(`${MODULE} [Human] Auto first comment: dwelling + interacting before commenting`);
          await _sleep(_rand(4000, 9000));
          try { await humanScroll(Runtime, { steps: _rand(2, 4) }); } catch (_) {}
          await _sleep(_rand(2000, 5000));
          try { await Runtime.evaluate({ expression: "window.scrollTo({ top: 0, behavior: 'smooth' });" }); } catch (_) {}
          await _sleep(_rand(1500, 3500));

          const commentJs = buildCommentJsCode({
            sessionParamsSafe:   JSON.stringify(sessionParams),
            imageBase64:         null,
            imageMime:           "image/jpeg",
            imageFileName:       "image.jpg",
            storyIdSafe:         JSON.stringify(String(_story || "")),
            feedbackIdSafe:      JSON.stringify((_fbId && typeof _fbId === "string") ? _fbId : ""),
            numericPostIdSafe:   JSON.stringify((_numId && /^\d+$/.test(String(_numId))) ? String(_numId) : ""),
            facebookGroupIdSafe: JSON.stringify(String(facebookGroupId)),
            messageSafe:         JSON.stringify(String(firstCommentText)),
            groupUrlSafe:        JSON.stringify(String(groupUrl || "")),
            docIdSafe:           JSON.stringify(getDocId("useCometUFICreateCommentMutation")),
            browserReqSeq:       JSON.stringify((Math.floor(Math.random() * 20) + 1).toString(36)),
          });
          const cEval = await Runtime.evaluate({ expression: commentJs, awaitPromise: true, returnByValue: true });
          let cRes;
          try { const r = cEval.result?.value; cRes = typeof r === "string" ? JSON.parse(r) : (r || {}); }
          catch (_) { cRes = { error: "Could not parse comment result" }; }
          if (cRes?.error) {
            console.warn(`${MODULE} [Human] Auto first comment failed: ${cRes.error}`);
            firstComment = { success: false, error: cRes.error };
          } else if (cRes?.commentId) {
            console.log(`${MODULE} [Human] Auto first comment posted (id ${cRes.commentId})`);
            firstComment = { success: true, commentId: cRes.commentId };
            await _sleep(_rand(2000, 4500)); // post-comment linger
          } else {
            console.warn(`${MODULE} [Human] Auto first comment: no comment id returned (possible phantom)`);
            firstComment = { success: false, error: "no comment id" };
          }
        } catch (e) {
          console.warn(`${MODULE} [Human] Auto first comment error: ${e.message}`);
          firstComment = { success: false, error: e.message };
        }
      } else {
        console.warn(`${MODULE} [Human] Auto first comment skipped — post returned no feedback/post id`);
      }
    }

    // Refresh-back: the live browser jar holds Facebook's freshly rotated session
    // cookies (xs/fr/datr/sb). We reached this point only after a confirmed
    // logged-in navigation, so persist them to keep the stored snapshot alive.
    try {
      const all = await Network.getAllCookies();
      const fresh = cdpCookiesToStorage(all?.cookies || []);
      if (fresh.length) await persistFreshCookies(profileId, fresh);
    } catch (e) {
      console.warn(`${MODULE} [Browser] Cookie refresh-back failed for ${profileId}: ${e.message}`);
    }

    // Close gracefully so Chrome flushes Facebook's freshly-rotated cookies to the
    // on-disk jar (a SIGKILL here would leave the on-disk session stale → logout).
    await gracefulCloseVCBrowser(client, chromeProcess);
    client = null; chromeProcess = null;

    if (postResult?.error) {
      return {
        success: false,
        error: postResult.error,
        ambiguous: postResult.ambiguous === true,
        profileId,
        rawResponse: postResult.rawResponse || null,
        path: "browser",
      };
    }
    return { success: true, postId: postResult.postId || null, numericPostId: postResult.numericPostId || null, feedbackId: postResult.feedbackId || null, userId: postResult.uid || null, profileId, message, idMissing: postResult.idMissing || false, rawResponse: postResult.rawResponse || null, firstComment, path: "browser" };

  } catch (err) {
    console.error(`${MODULE} [Browser] Fatal error:`, err.message);
    return {
      success: false,
      error: err.message,
      ambiguous: submissionStarted,
      profileId,
      path: "browser",
    };
  } finally {
    await gracefulCloseVCBrowser(client, chromeProcess);
  }
}

function buildBrowserJsCode(sessionParamsSafe, facebookGroupIdSafe, messageSafe, docIdSafe, photoIdSafe) {
  const clientMutationId = String(Math.floor(Math.random() * 9) + 1);
  return `
(async function() {
  let requestStarted = false;
  try {
    const capturedParams = ${sessionParamsSafe};
    const photoId        = ${photoIdSafe};
    const dtsg = (() => {
      try { const r = require("DTSGInitialData"); if (r && r.token) return r.token; } catch(_) {}
      try { const el = document.querySelector('input[name="fb_dtsg"]'); if (el && el.value) return el.value; } catch(_) {}
      return null;
    })();
    const lsdToken = (() => {
      try { const r = require("LSD"); if (r && r.token) return r.token; } catch(_) {}
      return capturedParams.__lsd || "";
    })();
    const uid = (() => {
      try { const r = require("CurrentUserInitialData"); if (r && r.USER_ID) return String(r.USER_ID); } catch(_) {}
      const m = document.cookie.match(/(?:^|;\\s*)c_user=([^;]+)/);
      return m ? m[1].trim() : null;
    })();
    if (!dtsg) return JSON.stringify({ error: "Could not extract fb_dtsg" });
    if (!uid || uid === "0")  return JSON.stringify({ error: "Profile is not logged in to Facebook (no valid user id; the account appears signed out)." });
    const jazoest = "2" + Array.from(dtsg).reduce((s, c) => s + c.charCodeAt(0), 0);
    const sessionId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
    const groupId = ${facebookGroupIdSafe};
    const message = ${messageSafe};
    // Use the page's ACTUAL Facebook origin. Facebook pins some accounts/regions to
    // web.facebook.com (others stay on www.facebook.com). A cross-origin fetch (page
    // loaded on web.facebook.com but request sent to www.facebook.com) is treated as
    // third-party, so the browser DROPS the session cookies → Facebook replies "not
    // logged in" (error 1357001) and the post never lands. Matching the page's origin
    // keeps the request same-origin so the live session cookies are sent.
    const fbOrigin = (typeof location !== "undefined" && location.origin && location.origin.indexOf("facebook.com") !== -1)
      ? location.origin : "https://www.facebook.com";

    const variables = {
      input: {
        composer_entry_point: "inline_composer", composer_source_surface: "group",
        composer_type: "group", logging: { composer_session_id: sessionId }, source: "WWW",
        message: { ranges: [], text: message }, with_tags_ids: null, inline_activities: [],
        text_format_preset_id: "0", group_flair: { flair_id: null },
        attachments: photoId ? [{ photo: { id: photoId } }] : null,
        composed_text: { block_data: ["{}"], block_depths: [0], block_types: [0],
          blocks: [message], entities: ["[]"], entity_map: "{}", inline_styles: ["[]"] },
        navigation_data: { attribution_id_v2: "CometGroupDiscussionRoot.react,comet.group,via_cold_start," + Date.now() + ",394427,2361831622,," },
        tracking: [null], event_share_metadata: { surface: "newsfeed" },
        audience: { to_id: groupId }, actor_id: uid, client_mutation_id: "${clientMutationId}"
      },
      feedLocation: "GROUP", feedbackSource: 0, focusCommentID: null, gridMediaWidth: null, groupID: null,
      scale: 1, privacySelectorRenderLocation: "COMET_STREAM", checkPhotosToReelsUpsellEligibility: false,
      referringStoryRenderLocation: null, renderLocation: "group", useDefaultActor: false,
      inviteShortLinkKey: null, isFeed: false, isFundraiser: false, isFunFactPost: false,
      isGroup: true, isEvent: false, isTimeline: false, isSocialLearning: false,
      isPageNewsFeed: false, isProfileReviews: false, isWorkSharedDraft: false,
      "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
      "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": true,
      "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": true,
      "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
      "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "AUTO_TRANSLATE",
      "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
      "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
      "__relay_internal__pv__IsWorkUserrelayprovider": false,
      "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
      "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": true,
      "__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider": false,
      "__relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider": false,
      "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
      "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider": false,
      "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider": true,
      "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider": true,
      "__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider": false,
      "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider": false,
      "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider": false,
      "__relay_internal__pv__IsMergQAPollsrelayprovider": false,
      "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider": true,
      "__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider": true,
      "__relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider": false,
      "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider": true,
      "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider": 206,
      "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider": false,
      "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider": true,
      "__relay_internal__pv__groups_comet_use_glvrelayprovider": false,
      "__relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider": false,
      "__relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider": false,
      "__relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider": false
    };
    const bodyObj = {
      av: uid, __aaid: "0", __user: uid, __a: "1", __req: "1u",
      dpr: "1", __ccg: "GOOD", __comet_req: "15",
      fb_dtsg: dtsg, jazoest, lsd: lsdToken,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "ComposerStoryCreateMutation",
      server_timestamps: "true",
      variables: JSON.stringify(variables),
      doc_id: ${docIdSafe}
    };
    const SESSION_KEYS = ["__rev","__s","__hsi","__dyn","__csr","__hs","__hsdp","__hblp","__sjsp"];
    SESSION_KEYS.forEach(k => { if (capturedParams[k]) bodyObj[k] = capturedParams[k]; });
    const body = new URLSearchParams(bodyObj).toString();
    requestStarted = true;
    const resp = await fetch(fbOrigin + "/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-fb-lsd": lsdToken,
        "x-fb-friendly-name": "ComposerStoryCreateMutation", "x-asbd-id": "359341",
        "origin": fbOrigin, "referer": fbOrigin + "/groups/" + groupId },
      body
    });
    const rawText = await resp.text();
    // Facebook GraphQL uses @defer streaming: one-or-more newline-delimited JSON
    // objects. The first line is the base payload (error detection); deferred
    // fragments on later lines increasingly carry the story / feedback ids. Parse
    // EVERY line so id extraction searches all fragments, not just the first.
    // Each line may carry the anti-JSON-hijacking prefix "for (;;);" which must be
    // stripped before parsing.
    const chunks = [];
    for (const line of String(rawText).split("\\n")) {
      let t = line.trim();
      if (!t) continue;
      t = t.replace(/^for\\s*\\(\\s*;\\s*;\\s*\\)\\s*;?/, "").trim();
      if (!t) continue;
      try { chunks.push(JSON.parse(t)); } catch(_) {}
    }
    const parsed = chunks.length ? chunks[0] : null;
    // Not-logged-in / session-expired dispatcher error, e.g.
    // {"error":1357001,"errorSummary":"Connectez-vous pour continuer",...}.
    // Facebook returns this INSTEAD of creating the post, so it must be surfaced as
    // a hard session failure — NEVER swallowed as a phantom "idMissing" success.
    const loggedOutRe = /"__redirect"|checkpoint|not logged in|connectez-?vous|veuillez vous connecter|non connect|login_required|"error":13\\d{5}|please log ?in|log in to continue/i;
    if ((parsed && (typeof parsed.error === "number" || parsed.errorSummary || parsed.errorDescription)) || loggedOutRe.test(rawText || "")) {
      const summary = (parsed && (parsed.errorDescription || parsed.errorSummary)) || "";
      return JSON.stringify({ error: "Facebook returned a not-logged-in challenge. " + summary, loginError: true, rawResponse: (rawText || "").slice(0, 4000) });
    }
    if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return JSON.stringify({ error: "Facebook API error: " + JSON.stringify(parsed.errors), rawResponse: (rawText || "").slice(0, 6000) });
    }
    // Nothing parseable at all after dispatch is ambiguous. Facebook may have
    // created the post even though a slow/broken connection lost or truncated the
    // response, so this MUST go through verification and must never be re-posted.
    if (!parsed) {
      return JSON.stringify({ error: "Facebook returned an unrecognized response (no parseable JSON) — post not confirmed.", ambiguous: true, rawResponse: (rawText || "").slice(0, 4000) });
    }
    const storyCreate = parsed?.data?.story_create;
    const story = storyCreate?.story || storyCreate?.story_result?.story || {};
    let postId = story.id || story.legacy_story_hideable_id || null;
    let numericPostId = story.legacy_story_hideable_id || story.post_id || null;
    let feedbackId = (story.feedback && story.feedback.id) || null;
    // Deep-walk fallback: Facebook sometimes omits story.id / nests the ids deeper
    // or streams them in a later @defer fragment. Walk the base response AND every
    // streamed chunk.
    if (!postId || !numericPostId || !feedbackId) {
      const seen = new Set();
      const stack = [storyCreate, parsed && parsed.data, parsed, ...chunks].filter(Boolean);
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        for (const k in node) {
          const v = node[k];
          if (v && typeof v === "object") {
            if (!feedbackId && k === "feedback" && typeof v.id === "string") feedbackId = v.id;
            stack.push(v);
          } else if (typeof v === "string" || typeof v === "number") {
            const sv = String(v);
            if (!numericPostId && (k === "legacy_story_hideable_id" || k === "post_id") && /^\\d+$/.test(sv)) numericPostId = sv;
            if (!postId && k === "id" && sv.length > 15) postId = sv;
          }
        }
      }
    }
    return JSON.stringify({ success: true, postId, numericPostId, feedbackId, uid,
      idMissing: (!postId && !numericPostId && !feedbackId),
      rawResponse: (!postId && !numericPostId && !feedbackId) ? (rawText || "").slice(0, 6000) : null });
  } catch (err) {
    return JSON.stringify({ error: err.message, ambiguous: requestStarted });
  }
})()
`;
}

// ---------------------------------------------------------------------------
// Recovery: re-fetch the just-created post's numeric id from the group feed.
// Only used in the rare case (~1%) where ComposerStoryCreateMutation returned
// success but no usable id. Opens the group page, finds the post whose text
// matches what we just published, and reads its numeric id from the permalink.
// ---------------------------------------------------------------------------
async function recoverNumericPostId({ facebookGroupId, groupUrl, message, profileId, cookies, proxy, fingerprint }) {
  let client = null;
  let chromeProcess = null;
  try {
    console.log(`${MODULE} [Recover] Attempting post-id recovery for group ${facebookGroupId}`);
    const startResult = await startVCBrowser(profileId, fingerprint, "about:blank", proxy, true, true);
    if (!startResult || !startResult.client) return null;
    client = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;
    await Network.enable();

    await injectCookiesIfLoggedOut(Network, cookies, `${MODULE} [Recover]`);

    // A text anchor is REQUIRED to reliably identify our specific post in the feed.
    // Without one (image-only / empty post) we cannot tell our post apart from any
    // other, so we must report "unknown" (scanned:false) rather than risk a false
    // "absent" that would trigger a duplicate re-post. Require a few real chars.
    const snippet = String(message || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (snippet.length < 6) {
      console.warn(`${MODULE} [Recover] Message has no usable text anchor (len=${snippet.length}) — cannot verify`);
      return { scanned: false, numericPostId: null };
    }

    // Force CHRONOLOGICAL sort so the just-created post surfaces at/near the top of
    // the feed instead of being buried under "Top posts" relevance ordering.
    const sortUrl = groupUrl + (groupUrl.includes("?") ? "&" : "?") + "sorting_setting=CHRONOLOGICAL";
    await Page.navigate({ url: sortUrl });
    await new Promise(r => setTimeout(r, 8000));
    await dismissFacebookWarningDialog(Runtime);

    const currentUrlEval = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
    const currentUrl = currentUrlEval.result?.value || "";
    if (currentUrl.includes("login") || currentUrl.includes("checkpoint")) {
      console.warn(`${MODULE} [Recover] Profile not logged in — cannot recover`);
      return { scanned: false, numericPostId: null };
    }

    const snippetSafe = JSON.stringify(snippet);
    const scanJs = `(function(){
      try {
        const want = ${snippetSafe};
        const links = Array.from(document.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="multi_permalinks="]'));
        for (const a of links) {
          const href = a.href || "";
          const m = href.match(/\\/(?:posts|permalink)\\/(\\d+)/) ||
                    href.match(/[?&](?:story_fbid|multi_permalinks)=(\\d+)/);
          if (!m) continue;
          let el = a, depth = 0, container = null;
          while (el && depth < 14) { if (el.getAttribute && el.getAttribute('role') === 'article') { container = el; break; } el = el.parentElement; depth++; }
          if (!container) continue;
          const text = (container.innerText || "").replace(/\\s+/g, " ");
          if (want && text.indexOf(want) !== -1) return JSON.stringify({ numericPostId: m[1] });
        }
        return JSON.stringify({ numericPostId: null });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    })()`;

    // The feed is virtualized — scan, then scroll to force more articles to render,
    // and re-scan. The newest (our) post is matched first when scanning from the top.
    let numericPostId = null;
    for (let pass = 0; pass < 5; pass++) {
      const evalRes = await Runtime.evaluate({ expression: scanJs, returnByValue: true });
      let parsed = {};
      try { parsed = JSON.parse(evalRes.result?.value || "{}"); } catch (_) {}
      if (parsed.numericPostId && /^\d+$/.test(String(parsed.numericPostId))) {
        numericPostId = String(parsed.numericPostId);
        break;
      }
      if (pass < 4) {
        await Runtime.evaluate({ expression: "window.scrollBy(0, Math.max(window.innerHeight*1.5, 1200));" });
        await new Promise(r => setTimeout(r, 1800));
      }
    }
    console.log(`${MODULE} [Recover] numericPostId=${numericPostId || "not found"}`);
    // scanned:true only means the group feed loaded and was searched. A missing
    // match is still inconclusive because a new post may not be visible yet (and an
    // image-only post has no text snippet to match). Callers must never use absence
    // here as permission to re-submit an already-dispatched post.
    return { scanned: true, numericPostId };
  } catch (err) {
    console.warn(`${MODULE} [Recover] Failed: ${err.message}`);
    return { scanned: false, numericPostId: null };
  } finally {
    await gracefulCloseVCBrowser(client, chromeProcess);
  }
}

// ---------------------------------------------------------------------------
// Public recovery wrapper \u2014 prepares cookies/proxy/fingerprint from profileData
// the same way facebookGroupPost does, then re-fetches the post's numeric id.
// Returns the numeric post id string, or null if it could not be recovered.
// ---------------------------------------------------------------------------
async function recoverPostId({ facebookGroupId, groupUrl, message, profileId, profileData }) {
  const cookies = (profileData && profileData.cookies) || [];
  const proxy   = profileData && profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== "NULL"
                    ? profileData.proxy : null;
  let fingerprint = profileData && profileData.fingerprint;
  if (!fingerprint || Object.keys(fingerprint).length === 0) {
    fingerprint = getConsistentFingerprintForProfile(profileId);
  }
  try {
    const vcVersion = getVCBrowserVersion();
    if (fingerprint.userAgent && vcVersion?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
    }
  } catch (_) {}
  const r = await recoverNumericPostId({ facebookGroupId, groupUrl, message, profileId, cookies, proxy, fingerprint });
  return (r && r.numericPostId) || null;
}

// ---------------------------------------------------------------------------
// Verify whether a post we attempted actually landed in the group. Used after an
// AMBIGUOUS post outcome (lost/garbled response, success-without-id) to decide
// — with certainty — whether to treat the attempt as a success or safely retry.
// Returns:
//   { checked:true,  exists:true,  numericPostId } — post is present (success)
//   { checked:true,  exists:false, numericPostId:null } — no match yet (inconclusive)
//   { checked:false, exists:false } — could not verify (treat as unknown; do NOT retry)
// ---------------------------------------------------------------------------
async function verifyPostExists({ facebookGroupId, groupUrl, message, profileId, profileData }) {
  const cookies = (profileData && profileData.cookies) || [];
  const proxy   = profileData && profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== "NULL"
                    ? profileData.proxy : null;
  let fingerprint = profileData && profileData.fingerprint;
  if (!fingerprint || Object.keys(fingerprint).length === 0) {
    fingerprint = getConsistentFingerprintForProfile(profileId);
  }
  try {
    const vcVersion = getVCBrowserVersion();
    if (fingerprint.userAgent && vcVersion?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
    }
  } catch (_) {}
  try {
    const r = await recoverNumericPostId({ facebookGroupId, groupUrl, message, profileId, cookies, proxy, fingerprint });
    if (!r || !r.scanned) return { checked: false, exists: false, numericPostId: null };
    return { checked: true, exists: !!r.numericPostId, numericPostId: r.numericPostId || null };
  } catch (_) {
    return { checked: false, exists: false, numericPostId: null };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
async function facebookGroupPost({ facebookGroupId, groupUrl, message, imagePath, profileId, profileData, suppressUploadErrorReport = false, humanMode = false, humanWatch = false, firstCommentText = '' }) {
  const cookies   = profileData.cookies || [];
  const proxy     = profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== "NULL"
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

  const userAgent = fingerprint.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  // Pre-flight: a dead / unreachable proxy is a common transient cause of failed
  // posts. Probe it first so we surface a clear, actionable error (and let the
  // scheduler retry) instead of a confusing generic "post failed".
  if (proxy) {
    const reachable = await checkProxyReachable(proxy, userAgent);
    if (!reachable) {
      console.warn(`${MODULE} Proxy ${proxy.ip}:${proxy.port || ""} unreachable — aborting before post`);
      return { success: false, error: `Proxy unreachable (${proxy.ip}:${proxy.port || "?"}). Check the profile's proxy.`, proxyError: true, profileId };
    }
  }

  // Helper: after an AMBIGUOUS outcome (request sent, response lost), look for the
  // post in the group feed. A positive match proves success. A missing match does
  // NOT prove failure: Facebook feeds are eventually consistent, and image-only
  // posts cannot be matched reliably by text. Therefore no dispatched ambiguous
  // request is ever submitted again. This deliberately prefers an occasional
  // manual-review/missed post over duplicate posts.
  const resolveAmbiguous = async (pathLabel) => {
    for (let i = 0; i < 2; i++) {
      const v = await verifyPostExists({ facebookGroupId, groupUrl, message, profileId, profileData });
      if (v.checked && v.exists) {
        console.log(`${MODULE} Ambiguous post VERIFIED as published (numericPostId=${v.numericPostId || "n/a"})`);
        return { kind: "success", result: { success: true, postId: null, numericPostId: v.numericPostId || null, feedbackId: null, userId: null, profileId, message, verified: true, path: `${pathLabel}-verified` } };
      }
      // Give Facebook time to surface a newly-created post before a second scan.
      if (i === 0) await new Promise(r => setTimeout(r, 8000));
    }
    console.warn(`${MODULE} Ambiguous post could NOT be positively verified — not re-posting to avoid a duplicate`);
    return { kind: "unverified", result: { success: false, error: "Post was sent to Facebook but its outcome could not be verified. It may or may not have published — not retried to avoid a duplicate. Please check the group.", ambiguousUnverified: true, profileId, path: pathLabel } };
  };

  // Try HTTP-only path first (no browser) — UNLESS Human mode is on. The naked HTTP
  // GraphQL mutation (token-harvest GET → instant write) has no browser session
  // around it, which is the loudest behavioral automation signal. In Human mode we
  // skip it entirely and post through the warmed-up browser path that opens the real
  // composer and emits composer telemetry.
  if (!humanMode) {
    try {
      const httpResult = await postViaHttp({ facebookGroupId, groupUrl, message, imagePath, profileId, cookies, userAgent, proxy, suppressUploadErrorReport });
      if (httpResult && httpResult.ambiguous) {
        const v = await resolveAmbiguous("http");
        return v.result;
      } else if (httpResult !== null) {
        return httpResult;
      } else {
        console.log(`${MODULE} HTTP path skipped (cookies expired / not sent) — falling back to browser`);
      }
    } catch (httpErr) {
      console.warn(`${MODULE} HTTP path failed: ${httpErr.message} — falling back to browser`);
    }
  } else {
    console.log(`${MODULE} Human mode ON — skipping HTTP path, posting via warmed-up browser`);
  }

  // Browser fetches have the same distributed-systems ambiguity as Node HTTP: the
  // server can commit the post and the client can still lose the response. Route
  // any dispatched-but-unconfirmed result through the same duplicate-safety gate.
  const browserResult = await postViaBrowser({ facebookGroupId, groupUrl, message, imagePath, profileId, cookies, proxy, fingerprint, suppressUploadErrorReport, human: humanMode, watch: humanMode && humanWatch, firstCommentText: humanMode ? firstCommentText : '' });
  if (browserResult && browserResult.ambiguous) {
    const v = await resolveAmbiguous("browser");
    return v.result;
  }
  return browserResult;
}

// Serialize every profile-touching entry point through the shared per-profile
// session mutex so a profile is never used by two concurrent sessions (the
// trigger behind Facebook's "multiple sessions" restriction + selfie checkpoint).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookGroupPost: (args) => _runProfileExclusive(args && args.profileId, () => facebookGroupPost(args)),
  recoverPostId:     (args) => _runProfileExclusive(args && args.profileId, () => recoverPostId(args)),
  verifyPostExists,
  classifyFbError,
  isAccountLevelBlock,
};
