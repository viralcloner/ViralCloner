/**
 * Facebook Group Scan Post Automation
 *
 * Fetches detailed information about a Facebook group post using
 * CometSinglePostDialogContentQuery (doc_id: 27403854512578417).
 *
 * Fast path (no browser): uses stored cookies + plain HTTPS to fetch
 * fb_dtsg/lsd/uid, then fires the GraphQL query directly.
 * For URL mode, also fetches the post page via HTTP to extract the storyId.
 *
 * Fallback (browser): if cookies are expired or HTTP path fails, opens
 * VCBrowser to extract tokens and run the query via CDP.
 */

const { startVCBrowser, gracefulCloseVCBrowser } = require("../../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");
const { getFacebookSessionTokens, postGraphQL, buildCookieHeader, buildProxyAgent } = require("../../lib/facebookHttpSession");
const { dismissFacebookWarningDialog } = require("./fbDialogHelper");
const { getDocId, updateDocId, invalidateDocId, isDocIdError, isDefiniteDocIdError, extractDocIdsFromHtml, updateMany } = require("../../lib/facebookDocIds");
const { persistFreshCookies, parseSetCookies, injectCookiesIfLoggedOut } = require("../../lib/facebookCookieStore");
const https = require("https");

const MODULE      = "[FbGroupScanPost]";
const MUTATION_NAME = "CometSinglePostDialogContentQuery";
const SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs", "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];

// ---------------------------------------------------------------------------
// Helper: parse raw GraphQL response into a structured post object
// ---------------------------------------------------------------------------
function parseGraphQLBody(rawText) {
  let json;
  try { json = JSON.parse(rawText.split("\n")[0]); }
  catch (_) { return { error: "Failed to parse GraphQL response", raw: rawText.slice(0, 500) }; }

  if (json.errors && json.errors.length) {
    return { error: json.errors[0].message, raw: rawText.slice(0, 500) };
  }

  const node = json?.data?.node || json?.data?.node_v2 || json?.data?.story || null;
  if (!node) return { error: "No story node in response", raw: rawText.slice(0, 500) };

  const dig = (obj, ...keys) => {
    let c = obj;
    for (const k of keys) { if (c == null) return null; c = c[k]; }
    return c;
  };

  const postText =
    dig(node, "comet_sections", "content", "story", "message", "text") ||
    dig(node, "message", "text") || null;

  const authorName =
    dig(node, "comet_sections", "context_layout", "story", "comet_sections", "actor_photo", "story", "actors", 0, "name") ||
    dig(node, "actors", 0, "name") || null;

  const authorId =
    dig(node, "comet_sections", "context_layout", "story", "comet_sections", "actor_photo", "story", "actors", 0, "id") ||
    dig(node, "actors", 0, "id") || null;

  const createdTime =
    dig(node, "comet_sections", "context_layout", "story", "comet_sections", "metadata", 0, "story", "creation_time") ||
    dig(node, "comet_sections", "header", "story", "creation_time") ||
    dig(node, "comet_sections", "timestamp", "story", "creation_time") ||
    dig(node, "creation_time") || null;

  // Counts — confirmed paths from debug output
  const _ftwc = dig(node, "comet_sections", "feedback", "story", "story_ufi_container", "story", "feedback_context", "feedback_target_with_context");
  const _clrFb = dig(_ftwc, "comment_list_renderer", "feedback");
  const _summaryRenderers = dig(_ftwc, "comet_ufi_summary_and_actions_renderer", "feedback", "adaptive_ufi_action_renderers") || [];

  let reactionsCount = null;
  let sharesCount = null;
  for (const r of _summaryRenderers) {
    if (reactionsCount == null) { const c = dig(r, "feedback", "reaction_count", "count"); if (c != null) reactionsCount = c; }
    if (sharesCount == null)    { const c = dig(r, "feedback", "share_count", "count");    if (c != null) sharesCount = c; }
  }

  const commentsCount =
    dig(_clrFb, "comment_rendering_instance_for_feed_location", "comments", "total_count") ??
    dig(_clrFb, "comment_rendering_instance", "comments", "total_count") ??
    dig(_ftwc, "comment_count", "total_count") ?? null;

  const images = [];
  try {
    const attachments =
      dig(node, "comet_sections", "content", "story", "attachments") ||
      dig(node, "attachments") || [];
    for (const att of attachments) {
      const media = dig(att, "styles", "attachment", "media") || dig(att, "media") || null;
      if (!media) continue;
      const src =
        dig(media, "photo_image", "uri") ||
        dig(media, "large_share_image", "uri") ||
        dig(media, "image", "uri") || null;
      if (src) images.push(src);
    }
  } catch (_) {}

  return { result: { authorName, authorId, text: postText, createdTime, reactionsCount, commentsCount, sharesCount, images, raw: json } };
}

// ---------------------------------------------------------------------------
// Helper: build the in-page JS that fires the explicit GraphQL request
// ---------------------------------------------------------------------------
function buildJsCode(sessionParamsSafe, storyIdSafe, docIdSafe, refUrlSafe) {
  return `
(async function() {
  try {
    const capturedParams = ${sessionParamsSafe};
    const storyID        = ${storyIdSafe};
    const docId          = ${docIdSafe};
    const refUrl         = ${refUrlSafe};
    // Match the page's ACTUAL Facebook origin (www vs web.facebook.com) so the
    // request stays same-origin and the session cookies are sent (avoids 1357001).
    const fbOrigin = (typeof location !== "undefined" && location.origin && location.origin.indexOf("facebook.com") !== -1)
      ? location.origin : "https://www.facebook.com";

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

    if (!dtsg)    return JSON.stringify({ error: "Could not extract fb_dtsg — is the profile logged into Facebook?" });
    if (!uid)     return JSON.stringify({ error: "Could not extract user ID — is the profile logged into Facebook?" });
    if (!storyID) return JSON.stringify({ error: "No storyId provided" });

    const jazoest = "2" + Array.from(dtsg).reduce((s, c) => s + c.charCodeAt(0), 0);

    const variables = {
      feedbackSource: 2,
      feedLocation: "POST_PERMALINK_DIALOG",
      focusCommentID: null,
      privacySelectorRenderLocation: "COMET_STREAM",
      renderLocation: "permalink",
      scale: 1,
      shouldChangeNodeFieldName: true,
      storyID: storyID,
      useDefaultActor: false,
      "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": true,
      "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": true,
      "__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider": false,
      "__relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider": false,
      "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
      "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
      "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
      "__relay_internal__pv__IsWorkUserrelayprovider": false,
      "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider": false,
      "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider": true,
      "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider": true,
      "__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider": false,
      "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider": false,
      "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider": false,
      "__relay_internal__pv__IsMergQAPollsrelayprovider": false,
      "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider": true,
      "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
      "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "AUTO_TRANSLATE",
      "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
      "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": true,
      "__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider": true,
      "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
      "__relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider": false,
      "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider": true,
      "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider": 206,
      "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider": false,
      "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider": true,
      "__relay_internal__pv__ProfileCometSeoIsViewerLoggedOutrelayprovider": false
    };

    const body = new URLSearchParams();
    body.set("av",          uid);
    body.set("__aaid",      "0");
    body.set("__user",      uid);
    body.set("__a",         "1");
    body.set("__req",       "scan1");
    body.set("dpr",         "1");
    body.set("__ccg",       "EXCELLENT");
    body.set("__rev",       capturedParams.__rev    || "");
    body.set("__s",         capturedParams.__s      || "");
    body.set("__hsi",       capturedParams.__hsi    || "");
    body.set("__dyn",       capturedParams.__dyn    || "");
    body.set("__csr",       capturedParams.__csr    || "");
    body.set("__hs",        capturedParams.__hs     || "");
    body.set("__hsdp",      capturedParams.__hsdp   || "");
    body.set("__hblp",      capturedParams.__hblp   || "");
    body.set("__sjsp",      capturedParams.__sjsp   || "");
    body.set("__spin_r",    capturedParams.__spin_r || "");
    body.set("__spin_b",    capturedParams.__spin_b || "trunk");
    body.set("__spin_t",    capturedParams.__spin_t || "");
    body.set("__crn",       capturedParams.__crn    || "");
    body.set("__comet_req", "15");
    body.set("fb_dtsg",     dtsg);
    body.set("jazoest",     jazoest);
    body.set("lsd",         lsdToken);
    body.set("fb_api_caller_class",     "RelayModern");
    body.set("fb_api_req_friendly_name","CometSinglePostDialogContentQuery");
    body.set("server_timestamps",       "true");
    body.set("variables",   JSON.stringify(variables));
    body.set("doc_id",      docId);

    const response = await fetch(fbOrigin + "/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": "CometSinglePostDialogContentQuery",
        "x-fb-lsd": lsdToken,
        "origin": fbOrigin,
        "referer": refUrl
      },
      body: body.toString()
    });

    if (!response.ok) return JSON.stringify({ error: "HTTP " + response.status });

    const rawText = await response.text();
    let json;
    try { json = JSON.parse(rawText.split("\\n")[0]); }
    catch (_) { return JSON.stringify({ error: "Failed to parse response", raw: rawText.slice(0, 500) }); }

    if (json.errors && json.errors.length) {
      return JSON.stringify({ error: json.errors[0].message, raw: rawText.slice(0, 500) });
    }

    const node = json?.data?.node || json?.data?.node_v2 || json?.data?.story || null;
    if (!node) {
      console.error("[FbGroupScanPost] No story node. data keys:", Object.keys(json?.data || {}));
      console.error("[FbGroupScanPost] Full response (first 2000 chars):", rawText.slice(0, 2000));
      return JSON.stringify({ error: "No story node in response", dataKeys: Object.keys(json?.data || {}), raw: rawText.slice(0, 2000) });
    }

    const dig = (obj, ...keys) => {
      let cur = obj;
      for (const k of keys) { if (cur == null) return null; cur = cur[k]; }
      return cur;
    };

    const postText =
      dig(node, "comet_sections", "content", "story", "message", "text") ||
      dig(node, "message", "text") || null;
    const authorName =
      dig(node, "comet_sections", "context_layout", "story", "comet_sections", "actor_photo", "story", "actors", 0, "name") ||
      dig(node, "actors", 0, "name") || null;
    const authorId =
      dig(node, "comet_sections", "context_layout", "story", "comet_sections", "actor_photo", "story", "actors", 0, "id") ||
      dig(node, "actors", 0, "id") || null;
    const createdTime =
      dig(node, "comet_sections", "context_layout", "story", "comet_sections", "metadata", 0, "story", "creation_time") ||
      dig(node, "comet_sections", "header", "story", "creation_time") ||
      dig(node, "comet_sections", "timestamp", "story", "creation_time") ||
      dig(node, "creation_time") || null;

    const _ftwc = dig(node, "comet_sections", "feedback", "story", "story_ufi_container", "story", "feedback_context", "feedback_target_with_context");
    const _clrFb = dig(_ftwc, "comment_list_renderer", "feedback");
    const _summaryRenderers = dig(_ftwc, "comet_ufi_summary_and_actions_renderer", "feedback", "adaptive_ufi_action_renderers") || [];

    let reactionsCount = null;
    let sharesCount = null;
    for (const r of _summaryRenderers) {
      if (reactionsCount == null) { const c = dig(r, "feedback", "reaction_count", "count"); if (c != null) reactionsCount = c; }
      if (sharesCount == null)    { const c = dig(r, "feedback", "share_count", "count");    if (c != null) sharesCount = c; }
    }

    const commentsCount =
      (dig(_clrFb, "comment_rendering_instance_for_feed_location", "comments", "total_count") ??
      dig(_clrFb, "comment_rendering_instance", "comments", "total_count") ??
      dig(_ftwc, "comment_count", "total_count") ?? null);

    const images = [];
    try {
      const attachments =
        dig(node, "comet_sections", "content", "story", "attachments") ||
        dig(node, "attachments") || [];
      for (const att of attachments) {
        const media = dig(att, "styles", "attachment", "media") || dig(att, "media") || null;
        if (!media) continue;
        const src =
          dig(media, "photo_image", "uri") ||
          dig(media, "large_share_image", "uri") ||
          dig(media, "image", "uri") || null;
        if (src) images.push(src);
      }
    } catch (_) {}

    return JSON.stringify({ ok: true, result: { storyId: storyID, authorName, authorId, text: postText, createdTime, reactionsCount, commentsCount, sharesCount, images, raw: json } });

  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
})()
`;
}

// ---------------------------------------------------------------------------
// HTTP helper: fetch a Facebook page with cookies (for storyId extraction)
// ---------------------------------------------------------------------------
function httpsGetFb(url, cookieHeader, userAgent, proxy) {
  return new Promise((resolve, reject) => {
    const agent = proxy ? buildProxyAgent(proxy) : null;
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "cookie": cookieHeader,
        "user-agent": userAgent,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
      },
      ...(agent ? { agent } : {}),
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${urlObj.hostname}${res.headers.location}`;
        res.resume();
        return httpsGetFb(redirectUrl, cookieHeader, userAgent, proxy).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP-only scan: no browser
// ---------------------------------------------------------------------------
async function scanViaHttp({ storyId, postUrl, profileId, cookies, userAgent, proxy }) {
  // Need either a resolved storyId, or a postUrl to extract one from
  const session = await getFacebookSessionTokens(cookies, userAgent, null, proxy);
  if (!session) return null; // cookies expired — fall back to browser

  const { dtsg, lsd, uid, cookieHeader } = session;
  let resolvedStoryId = storyId || null;

  // URL mode: fetch post page via HTTP to extract storyId
  if (!resolvedStoryId && postUrl) {
    const mPost = postUrl.match(/\/posts\/(\d+)/);
    if (!mPost) return { success: false, error: "Could not extract post ID from URL", profileId };
    const numericPostId = mPost[1];

    console.log(`${MODULE} [HTTP] Fetching post page to extract storyId`);
    try {
      const { status, body } = await httpsGetFb(postUrl, cookieHeader, userAgent, proxy);
      if (status !== 200 || body.includes('"login"') || body.includes('id="login_form"')) {
        console.log(`${MODULE} [HTTP] Post page not accessible (status ${status}) — falling back to browser`);
        return null;
      }

      // Extract storyId from page HTML (same 4 strategies as browser mode)
      const m1 = body.match(/"storyID"\s*:\s*"(Uzpf[^"]{10,})"/);
      if (m1) { resolvedStoryId = m1[1]; }

      if (!resolvedStoryId) {
        const allB64 = body.match(/Uzpf[A-Za-z0-9+/]{10,}={0,2}/g) || [];
        for (const b64 of allB64) {
          try {
            const dec = Buffer.from(b64, "base64").toString("utf8");
            if (dec.includes(":VK:" + numericPostId)) { resolvedStoryId = b64; break; }
          } catch (_) {}
        }
      }

      if (!resolvedStoryId) {
        console.log(`${MODULE} [HTTP] Could not extract storyId from page HTML — falling back to browser`);
        return null;
      }
      console.log(`${MODULE} [HTTP] Extracted storyId: ${resolvedStoryId}`);
    } catch (err) {
      console.warn(`${MODULE} [HTTP] Failed to fetch post page: ${err.message} — falling back to browser`);
      return null;
    }
  }

  if (!resolvedStoryId) {
    console.log(`${MODULE} [HTTP] No storyId available — falling back to browser`);
    return null;
  }

  // Fire the GraphQL query
  const variables = {
    feedbackSource: 2,
    feedLocation: "POST_PERMALINK_DIALOG",
    focusCommentID: null,
    privacySelectorRenderLocation: "COMET_STREAM",
    renderLocation: "permalink",
    scale: 1,
    shouldChangeNodeFieldName: true,
    storyID: resolvedStoryId,
    useDefaultActor: false,
    "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": true,
    "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": true,
    "__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider": false,
    "__relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider": false,
    "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
    "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
    "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
    "__relay_internal__pv__IsWorkUserrelayprovider": false,
    "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider": false,
    "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider": true,
    "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider": true,
    "__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider": false,
    "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider": false,
    "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider": false,
    "__relay_internal__pv__IsMergQAPollsrelayprovider": false,
    "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider": true,
    "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
    "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "AUTO_TRANSLATE",
    "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
    "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": true,
    "__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider": true,
    "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
    "__relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider": false,
    "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider": true,
    "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider": 206,
    "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider": false,
    "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider": true,
    "__relay_internal__pv__ProfileCometSeoIsViewerLoggedOutrelayprovider": false,
  };

  console.log(`${MODULE} [HTTP] Firing ${MUTATION_NAME} (doc_id: ${getDocId(MUTATION_NAME)})`);
  const resp = await postGraphQL({
    friendlyName: MUTATION_NAME,
    docId: getDocId(MUTATION_NAME),
    variables, dtsg, lsd, uid, cookieHeader,
    referer: postUrl || "https://www.facebook.com/",
    userAgent,
    proxy,
  });

  if (!resp.ok) {
    console.warn(`${MODULE} [HTTP] GraphQL status ${resp.status} — falling back to browser`);
    return null;
  }

  const parsed = parseGraphQLBody(resp.rawText);
  if (parsed.error) {
    if (isDocIdError(parsed.error)) {
      if (isDefiniteDocIdError(parsed.error)) invalidateDocId(MUTATION_NAME);
      console.log(`${MODULE} [HTTP] doc_id stale — falling back to browser to refresh`);
      return null;
    }
    console.error(`${MODULE} [HTTP] Parse error: ${parsed.error}`);
    return null;
  }

  updateDocId(MUTATION_NAME, getDocId(MUTATION_NAME)); // confirm current doc_id is valid
  console.log(`${MODULE} [HTTP] Scan success`);
  // Refresh-back: persist any cookies Facebook rotated on this request so the
  // stored snapshot stays alive between posts (viral monitors scan frequently).
  try {
    const rotated = parseSetCookies(resp.setCookieHeaders || []);
    if (rotated.length) await persistFreshCookies(profileId, rotated);
  } catch (_) {}
  return { success: true, post: parsed.result, profileId };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------
async function facebookGroupScanPost({ storyId, postUrl, groupUrl, profileId, profileData }) {
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

  // Try HTTP-only path first
  try {
    const httpResult = await scanViaHttp({ storyId, postUrl, profileId, cookies, userAgent, proxy });
    if (httpResult !== null) return httpResult;
    console.log(`${MODULE} HTTP path skipped — falling back to browser`);
  } catch (httpErr) {
    console.warn(`${MODULE} HTTP path failed: ${httpErr.message} — falling back to browser`);
  }

  // ── Browser fallback ──────────────────────────────────────────────────────
  let client        = null;
  let chromeProcess = null;

  try {
    console.log(`${MODULE} Launching browser for profile: ${profileId}`);

    const startResult = await startVCBrowser(
      profileId,
      fingerprint,
      "about:blank",
      proxy,
      true, // headless
      true  // automationMode
    );

    if (!startResult || !startResult.client) {
      return { success: false, error: "Failed to start VCBrowser", profileId };
    }

    client        = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;

    await Network.enable();

    const sessionParams = {};
    const capturedDocIds = {};

    // Capture session params from any graphql request
    Network.requestWillBeSent(({ request }) => {
      if (request.url?.includes("facebook.com/api/graphql") && request.postData) {
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

    // Inject cookies (only if the live profile is logged out)
    await injectCookiesIfLoggedOut(Network, cookies, MODULE);

    // =========================================================================
    // URL MODE
    // Navigate directly to post permalink, extract the real storyId from the
    // page's embedded JSON data, then fire the explicit GraphQL request.
    // No scrolling — Facebook always injects the storyId into the page source.
    // =========================================================================
    if (postUrl && postUrl.startsWith("http")) {
      const mPost = postUrl.match(/\/posts\/(\d+)/);
      if (!mPost) {
        return { success: false, error: "Could not extract post ID from URL. Expected: .../groups/{id}/posts/{numericId}", profileId };
      }
      const numericPostId = mPost[1];

      console.log(`${MODULE} [URL mode] Navigating to post permalink: ${postUrl}`);
      await Page.navigate({ url: postUrl });
      await new Promise(r => setTimeout(r, 8000));
      await dismissFacebookWarningDialog(Runtime);

      const urlCheck = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
      const landed = urlCheck.result?.value || "";
      if (landed.includes("login") || landed.includes("checkpoint")) {
        return { success: false, error: "Profile is not logged in to Facebook. Please open the profile and log in first.", profileId };
      }

      // Extract storyId from the page's embedded JSON — Facebook injects it in script tags
      const extractResult = await Runtime.evaluate({
        expression: `
          (() => {
            const numId = "${numericPostId}";
            const html = document.documentElement.outerHTML;

            // Strategy 1: look for explicit storyID key in JSON data
            const m1 = html.match(/"storyID"\\s*:\\s*"(Uzpf[^"]{10,})"/);
            if (m1) return m1[1];

            // Strategy 2: look for base64 id that decodes to contain :VK:{numId}
            // Only search script tag content to avoid scanning megabytes of HTML
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const s of scripts) {
              const t = s.textContent || "";
              if (!t.includes(numId)) continue;
              const matches = t.match(/Uzpf[A-Za-z0-9+\\/]{10,}={0,2}/g) || [];
              for (const b64 of matches) {
                try {
                  const dec = atob(b64);
                  if (dec.includes(":VK:" + numId)) return b64;
                } catch(_) {}
              }
            }

            // Strategy 3: search the serialised relay store embedded in __bbox
            const bboxMatch = html.match(/__bbox\\.push\\((.+?)\\);<\\/script>/s);
            if (bboxMatch) {
              const m2 = bboxMatch[1].match(/"storyID"\\s*:\\s*"(Uzpf[^"]{10,})"/);
              if (m2) return m2[1];
            }

            // Strategy 4: broad search for any Uzpf... base64 containing the post ID
            const allB64 = html.match(/Uzpf[A-Za-z0-9+\\/]{10,}={0,2}/g) || [];
            for (const b64 of allB64) {
              try {
                const dec = atob(b64);
                if (dec.includes(":VK:" + numId)) return b64;
              } catch(_) {}
            }

            return null;
          })()
        `,
        returnByValue: true
      });

      const resolvedStoryId = extractResult?.result?.value || null;
      console.log(`${MODULE} [URL mode] Extracted storyId: ${resolvedStoryId || "(none)"}`);

      if (!resolvedStoryId) {
        return {
          success: false,
          error: "Could not find storyId in the post page. The post may have been deleted or is not accessible with this profile.",
          profileId
        };
      }

      // Now fire the explicit GraphQL request from the page context (we are on the post page,
      // so dtsg/lsd/session params are all available)
      const capturedKeys = Object.keys(sessionParams);
      console.log(`${MODULE} Captured session params: ${capturedKeys.length > 0 ? capturedKeys.join(", ") : "(none)"}`);

      // Scan page HTML for fresh doc_ids
      try {
        const htmlEval = await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true });
        const pageHtml = htmlEval?.result?.value || "";
        if (pageHtml) updateMany(extractDocIdsFromHtml(pageHtml));
      } catch (_) {}

      const sessionParamsSafe2 = JSON.stringify(sessionParams);
      const storyIdSafe2       = JSON.stringify(resolvedStoryId);
      const docIdSafe2         = JSON.stringify(getDocId(MUTATION_NAME));
      const refUrlSafe2        = JSON.stringify(postUrl);

      const jsCodeUrl = buildJsCode(sessionParamsSafe2, storyIdSafe2, docIdSafe2, refUrlSafe2);

      const evalResult2 = await Runtime.evaluate({
        expression: jsCodeUrl,
        awaitPromise: true,
        returnByValue: true,
        timeout: 30000
      });

      const returnValue2 = evalResult2?.result?.value || "{}";
      let parsed2;
      try { parsed2 = JSON.parse(returnValue2); } catch (_) { parsed2 = {}; }

      if (parsed2.error) {
        if (isDefiniteDocIdError(parsed2.error)) invalidateDocId(MUTATION_NAME);
        console.error(`${MODULE} GraphQL error: ${parsed2.error}`);
        if (parsed2.dataKeys) console.error(`${MODULE} Response data keys: ${JSON.stringify(parsed2.dataKeys)}`);
        if (parsed2.raw)      console.error(`${MODULE} Raw response: ${parsed2.raw}`);
        return { success: false, error: parsed2.error, dataKeys: parsed2.dataKeys || null, raw: parsed2.raw || null, profileId };
      }
      if (!parsed2.ok) {
        return { success: false, error: "Unexpected response from page", profileId };
      }

      // Update doc_id cache
      updateDocId(MUTATION_NAME, capturedDocIds[MUTATION_NAME] || getDocId(MUTATION_NAME));

      console.log(`${MODULE} Scan success (URL mode) post #${numericPostId}`);
      return { success: true, post: parsed2.result, profileId };
    }

    // =========================================================================
    // STORYID MODE
    // Navigate to group page, fire explicit GraphQL from page context
    // =========================================================================
    console.log(`${MODULE} Navigating to ${groupUrl}`);
    await Page.navigate({ url: groupUrl });
    await new Promise(r => setTimeout(r, 8000));
    await dismissFacebookWarningDialog(Runtime);

    const urlEval = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
    const currentUrl = urlEval.result?.value || "";
    if (currentUrl.includes("login") || currentUrl.includes("checkpoint")) {
      return { success: false, error: "Profile is not logged in to Facebook. Please open the profile and log in first.", profileId };
    }

    const capturedKeys = Object.keys(sessionParams);
    console.log(`${MODULE} Captured session params: ${capturedKeys.length > 0 ? capturedKeys.join(", ") : "(none)"}`);

    // Scan page HTML for fresh doc_ids
    try {
      const htmlEval = await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true });
      const pageHtml = htmlEval?.result?.value || "";
      if (pageHtml) updateMany(extractDocIdsFromHtml(pageHtml));
    } catch (_) {}

    const sessionParamsSafe = JSON.stringify(sessionParams);
    const storyIdSafe       = JSON.stringify(String(storyId || ""));
    const docIdSafe         = JSON.stringify(getDocId(MUTATION_NAME));
    const refUrlSafe        = JSON.stringify(String(groupUrl));

    const jsCode = buildJsCode(sessionParamsSafe, storyIdSafe, docIdSafe, refUrlSafe);

    const evalResult = await Runtime.evaluate({
      expression: jsCode,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000
    });

    const returnValue = evalResult?.result?.value || "{}";
    let parsed;
    try { parsed = JSON.parse(returnValue); } catch (_) { parsed = {}; }

    if (parsed.error) {
      if (isDefiniteDocIdError(parsed.error)) invalidateDocId(MUTATION_NAME);
      console.error(`${MODULE} GraphQL error: ${parsed.error}`);
      if (parsed.dataKeys) console.error(`${MODULE} Response data keys: ${JSON.stringify(parsed.dataKeys)}`);
      if (parsed.raw)      console.error(`${MODULE} Raw response: ${parsed.raw}`);
      return { success: false, error: parsed.error, dataKeys: parsed.dataKeys || null, raw: parsed.raw || null, profileId };
    }
    if (!parsed.ok) {
      return { success: false, error: "Unexpected response from page", profileId };
    }

    updateDocId(MUTATION_NAME, capturedDocIds[MUTATION_NAME] || getDocId(MUTATION_NAME));
    console.log(`${MODULE} Scan success (storyId mode): ${storyId}`);
    return { success: true, post: parsed.result, profileId };

  } catch (err) {
    console.error(`${MODULE} Fatal error: ${err.message}`);
    return { success: false, error: err.message, profileId };
  } finally {
    await gracefulCloseVCBrowser(client, chromeProcess);
  }
}

// Serialize through the shared per-profile session mutex (see facebookProfileLock).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookGroupScanPost: (args) => _runProfileExclusive(args && args.profileId, () => facebookGroupScanPost(args)),
};
