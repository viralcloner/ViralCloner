/**
 * Facebook Group Comment Automation
 *
 * Opens a VCBrowser profile (non-headless), navigates to the group page,
 * captures session tokens via CDP Network interception, then executes
 * useCometUFICreateCommentMutation from inside the page context to add
 * a comment to an existing Facebook group post.
 */

const fs   = require("fs");
const path = require("path");

const { startVCBrowser, gracefulCloseVCBrowser } = require("../../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");
const { getDocId, updateDocId, invalidateDocId, isDocIdError, isDefiniteDocIdError, extractDocIdsFromHtml, updateMany } = require("../../lib/facebookDocIds");
const { persistFreshCookies, parseSetCookies, injectCookiesIfLoggedOut } = require("../../lib/facebookCookieStore");
const { getFacebookSessionTokens, postGraphQL, buildJazoest, buildProxyAgent } = require("../../lib/facebookHttpSession");
const { dismissFacebookWarningDialog } = require("./fbDialogHelper");

const MODULE = "[FbGroupComment]";
const MUTATION_NAME = "useCometUFICreateCommentMutation";

// Holds the raw response from the most recent HTTP phantom-success so the
// browser fallback path can surface it for diagnostics if it also fails.
let _lastPhantomResponse = null;

// Compact, length-capped snapshot of a raw Facebook response for diagnostics.
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
// Safely decode a Facebook storyId to its numeric post ID.
// Handles both base64-encoded ("S:f{uid}:VK:{numericId}") and raw numeric IDs.
// ---------------------------------------------------------------------------
function decodeStoryId(storyId) {
  if (!storyId) return null;
  try {
    const decoded = Buffer.from(String(storyId), 'base64').toString('utf8');
    const last    = decoded.split(':').pop().trim();
    if (/^\d+$/.test(last)) return last;
  } catch (_) {}
  // Fallback: already a raw numeric ID
  const raw = String(storyId).trim();
  if (/^\d+$/.test(raw)) return raw;
  return null;
}

// ---------------------------------------------------------------------------
// HTTP fast path — post a text comment without launching a browser.
// Returns null to signal browser fallback; returns result object on definitive outcome.
// ---------------------------------------------------------------------------
async function postCommentViaHttp({ storyId, numericPostId, feedbackId, facebookGroupId, groupUrl, message, cookies, userAgent, proxy, profileId }) {
  // Prefer the feedback id captured directly from the post-create response, then
  // the numeric post id. Decoding it out of the story id is unreliable for the
  // modern Uzpf-format ids, so it is only a last resort.
  let resolvedFeedbackId = (feedbackId && typeof feedbackId === 'string' && feedbackId.length > 0) ? feedbackId : null;
  if (!resolvedFeedbackId) {
    const resolvedPostId = (numericPostId && /^\d+$/.test(String(numericPostId)))
      ? String(numericPostId)
      : decodeStoryId(storyId);
    if (!resolvedPostId) {
      console.warn(`${MODULE} [HTTP] Cannot resolve comment target (storyId "${storyId}", numericPostId "${numericPostId}", feedbackId "${feedbackId}") — falling back to browser`);
      return null;
    }
    resolvedFeedbackId = Buffer.from('feedback:' + resolvedPostId).toString('base64');
  }

  const session = await getFacebookSessionTokens(cookies, userAgent, groupUrl, proxy);
  if (!session) return null;

  const { dtsg, lsd, uid, cookieHeader } = session;
  const jazoest    = buildJazoest(dtsg);

  const makeUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });

  const variables = {
    feedLocation:          'GROUP',
    feedbackSource:        0,
    groupID:               String(facebookGroupId),
    input: {
      client_mutation_id:    String(Math.floor(Math.random() * 9) + 1),
      attachments:           null,
      feedback_id:           resolvedFeedbackId,
      formatting_style:      null,
      message:               { ranges: [], text: message },
      attribution_id_v2:     'CometGroupDiscussionRoot.react,comet.group,via_cold_start,' + Date.now() + ',245287,2361831622,,',
      vod_video_timestamp:   null,
      is_tracking_encrypted: false,
      tracking:              [null],
      feedback_source:       'PROFILE',
      idempotence_token:     'client:' + makeUUID(),
      session_id:            makeUUID(),
    },
    inviteShortLinkKey:    null,
    renderLocation:        null,
    scale:                 1,
    useDefaultActor:       false,
    focusCommentID:        null,
    translationType:       'AUTO_TRANSLATE',
    canUseNicknameOnComet: false,
    '__relay_internal__pv__groups_comet_use_glvrelayprovider':                          false,
    '__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider':      false,
    '__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider':     false,
    '__relay_internal__pv__IsWorkUserrelayprovider':                                    false,
    '__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider':            'AUTO_TRANSLATE',
  };

  const docId = getDocId(MUTATION_NAME);
  console.log(`${MODULE} [HTTP] Firing ${MUTATION_NAME} (doc_id: ${docId}) for story ${storyId}`);

  const resp = await postGraphQL({
    friendlyName: MUTATION_NAME,
    docId,
    variables, dtsg, lsd, uid, cookieHeader,
    referer: groupUrl,
    userAgent,
    proxy,
  });

  if (!resp.ok) {
    console.warn(`${MODULE} [HTTP] GraphQL HTTP status ${resp.status}`);
    return null;
  }

  const json = resp.json;
  if (!json) { console.warn(`${MODULE} [HTTP] Could not parse response`); return null; }

  if (json.errors && json.errors.length) {
    const errMsg = json.errors[0]?.message || JSON.stringify(json.errors);
    console.error(`${MODULE} [HTTP] Facebook API error: ${errMsg}`);
    if (isDocIdError(errMsg)) { if (isDefiniteDocIdError(errMsg)) invalidateDocId(MUTATION_NAME); return null; }
    return { success: false, error: 'Facebook API error: ' + errMsg, rawResponse: _snapshotResponse(json) };
  }

  const commentId =
    json?.data?.comment_create?.feedback_comment_edge?.node?.id
    || json?.data?.comment_create?.comment?.id
    || json?.data?.feedback_comment_add?.comment?.id
    || json?.data?.comment_create?.id
    || json?.data?.comment?.id
    || null;

  // Guard against phantom success: a 200 response with no errors but no comment
  // id means the comment was NOT actually created. Fall back to the browser path
  // (return null) rather than reporting a false success.
  if (!commentId) {
    console.warn(`${MODULE} [HTTP] Response had no comment id (possible phantom success) — falling back to browser`);
    _lastPhantomResponse = _snapshotResponse(json);
    return null;
  }

  updateDocId(MUTATION_NAME, docId);
  console.log(`${MODULE} [HTTP] Comment success, commentId: ${commentId}`);
  // Refresh-back: persist cookies Facebook rotated on this request.
  try {
    const rotated = parseSetCookies([
      ...(session.setCookieHeaders || []),
      ...(resp.setCookieHeaders || []),
    ]);
    if (rotated.length) await persistFreshCookies(profileId, rotated);
  } catch (_) {}
  return { success: true, commentId };
}

/**
 * Add a comment to a Facebook group post.
 *
 * @param {object} opts
 * @param {string}  opts.storyId      - Base64-encoded Facebook story ID (postId from log)
 * @param {string}  opts.facebookGroupId - Numeric Facebook group ID
 * @param {string}  opts.groupUrl     - Full group URL (used as referer)
 * @param {string}  opts.message      - Comment text
 * @param {string}  opts.profileId    - VCBrowser profile name / ID
 * @param {object}  opts.profileData  - { proxy, fingerprint, cookies[] }
 * @returns {Promise<{success:boolean, commentId?:string, profileId:string, error?:string}>}
 */
async function facebookGroupComment({ storyId, numericPostId, feedbackId, facebookGroupId, groupUrl, message, imagePath, profileId, profileData }) {
  _lastPhantomResponse = null; // reset per-call diagnostic capture
  const cookies = profileData.cookies || [];
  const proxy   = profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== "NULL"
                    ? profileData.proxy : null;

  // Pre-read image so we can pass it as base64 into the browser JS context
  let imageBase64   = null;
  let imageMime     = "image/jpeg";
  let imageFileName = "image.jpg";
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      imageBase64   = fs.readFileSync(imagePath).toString("base64");
      imageFileName = path.basename(imagePath);
      const ext     = imageFileName.split(".").pop().toLowerCase();
      const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
      imageMime     = mimeMap[ext] || "image/jpeg";
    } catch (_) { imageBase64 = null; }
  }

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

  // ── HTTP fast path (no browser needed for text-only comments) ────────────
  if (!imagePath) {
    try {
      const httpResult = await postCommentViaHttp({
        storyId, numericPostId, feedbackId, facebookGroupId, groupUrl, message,
        cookies,
        userAgent: fingerprint.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        proxy,
        profileId,
      });
      if (httpResult !== null) return { ...httpResult, profileId, message };
      console.log(`${MODULE} HTTP path skipped (cookies expired or failed) — falling back to browser`);
    } catch (httpErr) {
      console.warn(`${MODULE} HTTP path failed: ${httpErr.message} — falling back to browser`);
    }
  }

  let client        = null;
  let chromeProcess = null;

  try {
    console.log(`${MODULE} Launching browser for profile: ${profileId}`);

    const startResult = await startVCBrowser(
      profileId,
      fingerprint,
      "about:blank",
      proxy,
      true,  // headless
      true   // automationMode
    );

    if (!startResult || !startResult.client) {
      return { success: false, error: "Failed to start VCBrowser", profileId };
    }

    client        = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;

    // ── Enable Network and capture session params BEFORE navigation ───────
    await Network.enable();

    const sessionParams = {};
    const capturedDocIds = {};
    const SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs",
                          "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];

    Network.requestWillBeSent(({ request }) => {
      if (
        request.url &&
        request.url.includes("facebook.com/api/graphql") &&
        request.postData
      ) {
        try {
          const p = new URLSearchParams(request.postData);
          SESSION_KEYS.forEach(k => {
            const v = p.get(k);
            if (v && !sessionParams[k]) sessionParams[k] = v;
          });
          const fn = p.get("fb_api_req_friendly_name");
          const di = p.get("doc_id");
          if (fn && di) capturedDocIds[fn] = di;
        } catch (_) {}
      }
    });

    // ── Inject stored cookies (only if the live profile is logged out) ────
    await injectCookiesIfLoggedOut(Network, cookies, MODULE);

    // ── Navigate to group page ────────────────────────────────────────────
    console.log(`${MODULE} Navigating to ${groupUrl}`);
    await Page.navigate({ url: groupUrl });
    await new Promise(r => setTimeout(r, 8000));
    await dismissFacebookWarningDialog(Runtime);

    const urlEval = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
    const currentUrl = urlEval.result?.value || "";
    console.log(`${MODULE} Landed on: ${currentUrl}`);

    if (currentUrl.includes("login") || currentUrl.includes("checkpoint")) {
      return {
        success: false,
        error: "Profile is not logged in to Facebook. Please open the profile and log in first.",
        profileId
      };
    }

    const capturedKeys = Object.keys(sessionParams);
    console.log(`${MODULE} Captured session params: ${capturedKeys.length > 0 ? capturedKeys.join(", ") : "(none)"}`);

    // Scan page HTML for fresh doc_ids (best-effort)
    try {
      const htmlEval = await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true });
      const pageHtml = htmlEval?.result?.value || "";
      if (pageHtml) updateMany(extractDocIdsFromHtml(pageHtml));
    } catch (_) {}

    const sessionParamsSafe    = JSON.stringify(sessionParams);
    const storyIdSafe          = JSON.stringify(String(storyId));
    const numericPostIdSafe    = JSON.stringify((numericPostId && /^\d+$/.test(String(numericPostId))) ? String(numericPostId) : "");
    const feedbackIdSafe       = JSON.stringify((feedbackId && typeof feedbackId === "string") ? feedbackId : "");
    const facebookGroupIdSafe  = JSON.stringify(String(facebookGroupId));
    const messageSafe          = JSON.stringify(String(message));
    const docIdSafe            = JSON.stringify(getDocId(MUTATION_NAME));
    const groupUrlSafe         = JSON.stringify(String(groupUrl));
    const browserReqSeq        = JSON.stringify((Math.floor(Math.random() * 20) + 1).toString(36));
    const browserMutId         = JSON.stringify(String(Math.floor(Math.random() * 9) + 1));

    const jsCode = buildCommentJsCode({
      sessionParamsSafe, imageBase64, imageMime, imageFileName,
      storyIdSafe, feedbackIdSafe, numericPostIdSafe, facebookGroupIdSafe,
      messageSafe, groupUrlSafe, docIdSafe, browserReqSeq,
    });

    console.log(`${MODULE} Executing comment mutation in browser context...`);
    const evalResult = await Runtime.evaluate({
      expression:    jsCode,
      awaitPromise:  true,
      returnByValue: true
    });

    let commentResult;
    try {
      const raw = evalResult.result?.value;
      commentResult = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    } catch (_) {
      commentResult = { error: "Could not parse browser result: " + String(evalResult.result?.value) };
    }

    console.log(`${MODULE} Result:`, JSON.stringify(commentResult));

    // Update doc_id cache
    if (!commentResult?.error) updateDocId(MUTATION_NAME, capturedDocIds[MUTATION_NAME] || getDocId(MUTATION_NAME));
    else if (isDefiniteDocIdError(commentResult.error)) invalidateDocId(MUTATION_NAME);

    // Close gracefully so Chrome flushes any rotated cookies to the on-disk jar.
    await gracefulCloseVCBrowser(client, chromeProcess);
    client = null; chromeProcess = null;

    if (commentResult?.error) {
      return { success: false, error: commentResult.error, profileId, rawResponse: commentResult.rawResponse || _lastPhantomResponse || null };
    }

    // Guard against phantom success: no comment id means the comment was not
    // actually created, even though Facebook returned a 200 with no errors.
    if (!commentResult.commentId) {
      console.warn(`${MODULE} Browser response had no comment id (possible phantom success)`);
      return { success: false, error: "Comment response had no comment id (possible phantom success)", profileId, rawResponse: commentResult.rawResponse || _lastPhantomResponse || null };
    }

    return {
      success:   true,
      commentId: commentResult.commentId,
      profileId,
      message
    };

  } catch (err) {
    console.error(`${MODULE} Fatal error:`, err.message);
    return { success: false, error: err.message, profileId };
  } finally {
    await gracefulCloseVCBrowser(client, chromeProcess);
  }
}

// ---------------------------------------------------------------------------
// Build the in-page comment mutation JS (useCometUFICreateCommentMutation).
// Extracted so the post automation can fire the first comment inside the SAME
// browser session it used to publish the post (human mode), instead of opening
// a fresh browser. All token extraction (dtsg/lsd/uid) happens in-page so the
// caller only needs to pass the post identifiers + captured session params.
// ---------------------------------------------------------------------------
function buildCommentJsCode({
  sessionParamsSafe, imageBase64, imageMime, imageFileName,
  storyIdSafe, feedbackIdSafe, numericPostIdSafe, facebookGroupIdSafe,
  messageSafe, groupUrlSafe, docIdSafe, browserReqSeq,
}) {
  return `
(async function() {
  try {
    const capturedParams  = ${sessionParamsSafe};
    const imageBase64     = ${JSON.stringify(imageBase64)};
    const imageMime       = ${JSON.stringify(imageMime)};
    const imageFileName   = ${JSON.stringify(imageFileName)};

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

    if (!dtsg) return JSON.stringify({ error: "Could not extract fb_dtsg — is the profile logged into Facebook?" });
    if (!uid)  return JSON.stringify({ error: "Could not extract user ID — is the profile logged into Facebook?" });

    const jazoest = "2" + Array.from(dtsg).reduce((s, c) => s + c.charCodeAt(0), 0);

    // Derive feedback_id from the post id. Prefer the feedback id captured
    // directly from the post-create response, then the numeric post id; decoding
    // it out of the story id is unreliable for modern Uzpf-format ids and yields
    // a wrong feedback target.
    const storyId = ${storyIdSafe};
    const passedFeedbackId = ${feedbackIdSafe};
    const passedNumericPostId = ${numericPostIdSafe};
    let numericPostId = passedNumericPostId || null;
    let feedbackId = passedFeedbackId || null;
    if (!feedbackId) {
      if (!numericPostId) {
        try {
          // Normalize URL-safe base64 (- and _) before calling atob which is strict
          const _safeB64 = storyId.replace(/-/g, '+').replace(/_/g, '/');
          const _decoded = atob(_safeB64);
          const _last = _decoded.split(':').pop().trim();
          if (/^\\d+$/.test(_last)) numericPostId = _last;
        } catch(_) {}
      }
      // Fallback: storyId may already be a raw numeric ID
      if (!numericPostId && /^\\d+$/.test(String(storyId).trim())) numericPostId = String(storyId).trim();
      if (!numericPostId) return JSON.stringify({ error: 'Could not decode storyId: ' + storyId });
      feedbackId = btoa('feedback:' + numericPostId);
    }

    const groupId  = ${facebookGroupIdSafe};
    const msgText  = ${messageSafe};
    const groupUrl = ${groupUrlSafe};
    // Match the page's ACTUAL Facebook origin (www.facebook.com vs web.facebook.com).
    // A cross-origin fetch drops the session cookies → "not logged in" (error 1357001).
    const fbOrigin = (typeof location !== "undefined" && location.origin && location.origin.indexOf("facebook.com") !== -1)
      ? location.origin : "https://www.facebook.com";

    // Fresh UUIDs
    const makeUUID = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });

    // Upload image if provided
    let attachments = null;
    if (imageBase64 && feedbackId) {
      try {
        const binary = atob(imageBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: imageMime });
        const uploadFd = new FormData();
        uploadFd.append("file", blob, imageFileName);
        const uploadQp = new URLSearchParams({
          av: uid, feedback_id: feedbackId, profile_id: uid, source: "19", target_id: uid,
          __user: uid, __a: "1", __aaid: "0", dpr: "1", __ccg: "EXCELLENT", __comet_req: "15",
          fb_dtsg: dtsg, jazoest, lsd: lsdToken,
        });
        const uploadResp = await fetch(fbOrigin + "/ajax/ufi/upload/?" + uploadQp.toString(), {
          method: "POST",
          credentials: "include",
          headers: { "x-fb-lsd": lsdToken, "x-asbd-id": "359341", "origin": fbOrigin, "referer": groupUrl },
          body: uploadFd,
        });
        const uploadRaw = await uploadResp.text();
        let uploadParsed = null;
        for (const line of uploadRaw.split("\\n")) {
          const t = line.trim();
          if (!t) continue;
          try { uploadParsed = JSON.parse(t); break; } catch(_) {}
        }
        const fbid = uploadParsed?.payload?.fbid || uploadParsed?.fbid || null;
        if (fbid) attachments = [{ media: { id: fbid } }];
      } catch(_) {
        // Image upload failed — proceed with text only
      }
    }

    const variables = {
      feedLocation:    "GROUP",
      feedbackSource:  0,
      groupID:         groupId,
      input: {
        client_mutation_id:   String(Math.floor(Math.random() * 9) + 1),
        attachments:          attachments,
        feedback_id:          feedbackId,
        formatting_style:     null,
        message:              { ranges: [], text: msgText },
        attribution_id_v2:    "CometGroupDiscussionRoot.react,comet.group,via_cold_start," + Date.now() + ",245287,2361831622,,",
        vod_video_timestamp:  null,
        is_tracking_encrypted: false,
        tracking:             [null],
        feedback_source:      "PROFILE",
        idempotence_token:    "client:" + makeUUID(),
        session_id:           makeUUID()
      },
      inviteShortLinkKey:  null,
      renderLocation:      null,
      scale:               1,
      useDefaultActor:     false,
      focusCommentID:      null,
      translationType:     "AUTO_TRANSLATE",
      canUseNicknameOnComet: false,
      "__relay_internal__pv__groups_comet_use_glvrelayprovider":                          false,
      "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider":      false,
      "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider":     false,
      "__relay_internal__pv__IsWorkUserrelayprovider":                                    false,
      "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider":            "AUTO_TRANSLATE"
    };

    const bodyObj = {
      av:                        uid,
      __aaid:                    "0",
      __user:                    uid,
      __a:                       "1",
      __req:                     ${browserReqSeq},
      dpr:                       "1",
      __ccg:                     "EXCELLENT",
      __comet_req:               "15",
      fb_dtsg:                   dtsg,
      jazoest:                   jazoest,
      lsd:                       lsdToken,
      fb_api_caller_class:       "RelayModern",
      fb_api_req_friendly_name:  "useCometUFICreateCommentMutation",
      server_timestamps:         "true",
      variables:                 JSON.stringify(variables),
      doc_id:                    ${docIdSafe}
    };

    const SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs",
                          "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];
    SESSION_KEYS.forEach(k => { if (capturedParams[k]) bodyObj[k] = capturedParams[k]; });

    const body = new URLSearchParams(bodyObj).toString();

    const resp = await fetch(fbOrigin + "/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type":       "application/x-www-form-urlencoded",
        "x-fb-lsd":           lsdToken,
        "x-fb-friendly-name": "useCometUFICreateCommentMutation",
        "x-asbd-id":          "359341",
        "origin":             fbOrigin,
        "referer":            groupUrl
      },
      body
    });

    const rawText = await resp.text();

    let parsed = null;
    for (const line of rawText.split("\\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { parsed = JSON.parse(trimmed); break; } catch(_) {}
    }

    if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return JSON.stringify({ error: "Facebook API error: " + JSON.stringify(parsed.errors), rawResponse: (rawText || "").slice(0, 6000) });
    }

    const commentId =
      parsed?.data?.comment_create?.feedback_comment_edge?.node?.id  // confirmed working format
      || parsed?.data?.comment_create?.comment?.id                    // alternate format
      || parsed?.data?.feedback_comment_add?.comment?.id              // older format
      || parsed?.data?.comment_create?.id                             // flat format
      || parsed?.data?.comment?.id                                    // minimal format
      || null;

    return JSON.stringify({ success: true, commentId, feedbackId, uid,
      rawResponse: commentId ? null : (rawText || "").slice(0, 6000) });

  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
})()
`;
}

// Serialize through the shared per-profile session mutex (see facebookProfileLock).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookGroupComment: (args) => _runProfileExclusive(args && args.profileId, () => facebookGroupComment(args)),
  buildCommentJsCode,
};

