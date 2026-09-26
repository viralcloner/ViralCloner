/**
 * Facebook Group Edit Comment Automation
 *
 * Edits an existing Facebook comment via the useCometUFIEditCommentMutation.
 * Uses HTTP-first (facebookHttpSession) with VCBrowser in-page fetch as fallback.
 */

const https = require("https");
const fs   = require("fs");
const path = require("path");

const { startVCBrowser, gracefulCloseVCBrowser } = require("../../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");
const { getDocId, updateDocId, invalidateDocId, isDocIdError, isDefiniteDocIdError, extractDocIdsFromHtml, updateMany } = require("../../lib/facebookDocIds");
const { getFacebookSessionTokens, postGraphQL, buildCookieHeader, buildJazoest, buildProxyAgent } = require("../../lib/facebookHttpSession");
const { injectCookiesIfLoggedOut } = require("../../lib/facebookCookieStore");
const { dismissFacebookWarningDialog } = require("./fbDialogHelper");

const MODULE        = "[FbGroupEditComment]";
const MUTATION_NAME = "useCometUFIEditCommentMutation";
const FALLBACK_DOC_ID = "26337203612619588";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the numeric post ID from a Facebook post URL, e.g. .../posts/12345 → "12345" */
function extractPostIdFromUrl(url) {
  const m = (url || "").match(/\/posts\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Upload an image to Facebook's UFI (comment image) upload endpoint via HTTP.
 * Returns the Facebook media `fbid` string, or null on failure.
 */
async function uploadCommentImageHttp({ imagePath, postId, tokens, referer, userAgent, proxy }) {
  if (!imagePath || !postId) return null;
  if (!fs.existsSync(imagePath)) {
    console.warn(`${MODULE} uploadCommentImageHttp: file not found: ${imagePath}`);
    return null;
  }

  const { dtsg, lsd, uid, cookieHeader } = tokens;
  const fileBuffer   = fs.readFileSync(imagePath);
  const fileName     = path.basename(imagePath);
  const ext          = fileName.split(".").pop().toLowerCase();
  const mimeMap      = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const contentType  = mimeMap[ext] || "image/jpeg";
  const feedbackId   = Buffer.from("feedback:" + postId).toString("base64");
  const jazoest      = buildJazoest(dtsg);
  const boundary     = "----WebKitFormBoundary" + Math.random().toString(36).slice(2, 18);
  const CRLF         = "\r\n";
  const agent        = proxy ? buildProxyAgent(proxy) : null;

  const preambleBuf  = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
    `Content-Type: ${contentType}${CRLF}${CRLF}`
  );
  const epilogueBuf  = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const bodyBuffer   = Buffer.concat([preambleBuf, fileBuffer, epilogueBuf]);

  const qp = new URLSearchParams({
    av: uid, feedback_id: feedbackId, profile_id: uid, source: "19", target_id: uid,
    __user: uid, __a: "1", __aaid: "0", dpr: "1", __ccg: "EXCELLENT", __comet_req: "15",
    fb_dtsg: dtsg, jazoest, lsd: lsd || "",
  });

  return new Promise((resolve) => {
    const reqOptions = {
      hostname: "www.facebook.com",
      path: `/ajax/ufi/upload/?${qp.toString()}`,
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": bodyBuffer.length,
        "cookie": cookieHeader,
        "x-fb-lsd": lsd || "",
        "origin": "https://www.facebook.com",
        "referer": referer || "https://www.facebook.com/",
        "user-agent": userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-asbd-id": "359341",
      },
      ...(agent ? { agent } : {}),
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        for (const line of raw.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try { parsed = JSON.parse(t); break; } catch (_) {}
        }
        const fbid = parsed?.payload?.fbid || parsed?.fbid || null;
        if (fbid) {
          console.log(`${MODULE} Image uploaded via HTTP, fbid=${fbid}`);
          resolve(fbid);
        } else {
          console.warn(`${MODULE} Upload response has no fbid:`, raw.slice(0, 300));
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    });

    req.on("error", () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(bodyBuffer);
    req.end();
  });
}

// ── HTTP-first path ───────────────────────────────────────────────────────────

async function editViaHttp({ commentId, newText, imagePath, groupUrl, profileId, cookies, userAgent, proxy }) {
  // Use the homepage to extract tokens — group pages in plain HTML often lack DTSGInitialData
  const tokens = await getFacebookSessionTokens(cookies, userAgent, "https://www.facebook.com/", proxy);
  if (!tokens) return null; // cookies expired → fall through to browser

  const { dtsg, lsd, uid, cookieHeader } = tokens;
  const docId = getDocId(MUTATION_NAME) || FALLBACK_DOC_ID;

  // Upload image if provided
  let attachments = null;
  if (imagePath) {
    const postId = extractPostIdFromUrl(groupUrl);
    if (postId) {
      const mediaId = await uploadCommentImageHttp({ imagePath, postId, tokens, referer: groupUrl, userAgent, proxy });
      if (mediaId) attachments = [{ media: { id: mediaId } }];
    } else {
      console.warn(`${MODULE} Cannot upload image: no post ID found in groupUrl: ${groupUrl}`);
    }
  }

  const variables = {
    input: {
      actor_id:             uid,
      client_mutation_id:   String(Math.floor(Math.random() * 9) + 1),
      attachments:          attachments,
      attribution_id_v2:    `CometGroupDiscussionRoot.react,comet.group,via_cold_start,${Date.now()},503819,2361831622,,`,
      comment_id:           commentId,
      formatting_style:     "PLAIN_TEXT",
      message:              { ranges: [], text: newText },
      tracking:             [null],
    },
    feedLocation:   "GROUP",
    scale:          1,
    useDefaultActor: false,
    translationType: "AUTO_TRANSLATE",
    "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
    "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
    "__relay_internal__pv__IsWorkUserrelayprovider": false,
  };

  const result = await postGraphQL({
    friendlyName: MUTATION_NAME,
    docId,
    variables,
    dtsg,
    lsd,
    uid,
    cookieHeader,
    referer: groupUrl,
    userAgent,
    proxy,
  });

  if (!result) return null;

  const json = result.json;

  // Doc_id stale — invalidate and let browser fallback capture the live id
  if (json?.errors) {
    const errStr = JSON.stringify(json.errors);
    if (isDocIdError(errStr)) {
      if (isDefiniteDocIdError(errStr)) invalidateDocId(MUTATION_NAME);
      return null; // stale doc_id → fall through to browser once
    }
    return { success: false, error: "Facebook API error: " + errStr, profileId };
  }

  const comment = json?.data?.comment_edit?.comment || null;
  if (comment) {
    updateDocId(MUTATION_NAME, docId);
    return { success: true, commentId: comment.id, profileId, method: "http" };
  }

  // Log unexpected response for debugging
  console.warn(`${MODULE} Unexpected HTTP response:`, result.rawText?.slice(0, 300));
  return null; // unexpected response → fall through to browser
}

// ── Browser fallback path ─────────────────────────────────────────────────────

async function editViaBrowser({ commentId, newText, imagePath, groupUrl, profileId, profileData }) {
  const cookies    = profileData.cookies || [];
  const proxy      = profileData.proxy?.ip && profileData.proxy.ip !== "NULL" ? profileData.proxy : null;
  let fingerprint  = profileData.fingerprint || {};

  // Pre-read image file so we can pass it as base64 into the browser JS context
  let imageBase64  = null;
  let imageMime    = "image/jpeg";
  let imageFileName = "image.jpg";
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      imageBase64   = fs.readFileSync(imagePath).toString("base64");
      imageFileName = path.basename(imagePath);
      const ext = imageFileName.split(".").pop().toLowerCase();
      const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
      imageMime = mimeMap[ext] || "image/jpeg";
    } catch (_) { imageBase64 = null; }
  }

  if (!fingerprint || Object.keys(fingerprint).length === 0)
    fingerprint = getConsistentFingerprintForProfile(profileId);
  try {
    const v = getVCBrowserVersion();
    if (fingerprint.userAgent && v?.full)
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${v.full}`);
  } catch (_) {}

  let client = null;
  let chromeProcess = null;
  try {
    const startResult = await startVCBrowser(profileId, fingerprint, "about:blank", proxy, true, true);
    if (!startResult?.client) return { success: false, error: "Failed to start VCBrowser", profileId };

    client        = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;

    await Network.enable();

    const sessionParams  = {};
    const capturedDocIds = {};
    const SESSION_KEYS   = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs",
                            "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];

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

    // Inject cookies (only if the live profile is logged out)
    await injectCookiesIfLoggedOut(Network, cookies, MODULE);

    await Page.navigate({ url: groupUrl });
    await new Promise(r => setTimeout(r, 8000));
    await dismissFacebookWarningDialog(Runtime);

    const urlVal = (await Runtime.evaluate({ expression: "window.location.href", returnByValue: true }))?.result?.value || "";
    if (urlVal.includes("login") || urlVal.includes("checkpoint"))
      return { success: false, error: "Profile not logged in to Facebook", profileId };

    // Scan page HTML for fresh doc_ids
    try {
      const html = (await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true }))?.result?.value || "";
      if (html) updateMany(extractDocIdsFromHtml(html));
    } catch (_) {}

    // Save captured doc_ids from network traffic
    for (const [fn, di] of Object.entries(capturedDocIds)) updateDocId(fn, di);

    // The edit-comment mutation bundle is lazy-loaded: Facebook only registers
    // "useCometUFIEditCommentMutation_facebookRelayOperation" once the Edit UI is
    // rendered, which only happens on the "⋯" (More) menu of the bot's OWN comment.
    // Since we always edit our own comment, open that comment's menu to force-load
    // the bundle BEFORE attempting to read the doc_id from the Relay registry.
    if (!capturedDocIds[MUTATION_NAME]) {
      try {
        await Runtime.evaluate({
          expression: `(function(){
            return new Promise(function(resolve){
              try {
                var commentId = ${JSON.stringify(String(commentId || ""))};
                // Decode the numeric id from a base64 "comment:<id>:..." token if present.
                var numId = null;
                try { var dec = atob(commentId); var mm = dec.match(/(\\d{6,})/); if (mm) numId = mm[1]; } catch(_){}
                var moreLabels = ["More","Plus","More options","Actions for this comment",
                                  "Modifier","Autres","Plus d'options","المزيد","خيارات","إجراءات"];
                function findMoreButton(){
                  // Prefer a button near an element referencing the comment id.
                  var anchors = [];
                  if (numId) {
                    anchors = Array.prototype.slice.call(
                      document.querySelectorAll('[href*="'+numId+'"],[id*="'+numId+'"]'));
                  }
                  var scopes = anchors.length ? anchors : [document];
                  for (var s=0;s<scopes.length;s++){
                    var root = scopes[s].closest ? (scopes[s].closest('[role="article"]') || document) : document;
                    var btns = root.querySelectorAll('[aria-label][role="button"],[aria-haspopup="menu"]');
                    for (var i=0;i<btns.length;i++){
                      var lab = (btns[i].getAttribute("aria-label")||"");
                      for (var j=0;j<moreLabels.length;j++){
                        if (lab.indexOf(moreLabels[j]) !== -1) return btns[i];
                      }
                    }
                  }
                  return null;
                }
                var btn = findMoreButton();
                if (!btn) { resolve(false); return; }
                btn.scrollIntoView({block:"center"});
                btn.click();
                // Let the lazy bundle download, then close the menu.
                setTimeout(function(){
                  try { document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,bubbles:true})); } catch(_){}
                  resolve(true);
                }, 2000);
              } catch(_) { resolve(false); }
            });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        // Give Bootloader a moment to register the freshly downloaded module.
        await new Promise(r => setTimeout(r, 800));
      } catch (_) {}
    }

    // Try the Relay registry for this specific mutation — after the force-load above
    // the bundle should be present, so a direct require() will usually succeed. We also
    // keep requireLazy as a secondary path.
    if (!capturedDocIds[MUTATION_NAME]) {
      try {
        const relayResult = await Runtime.evaluate({
          expression: `(function(){
            return new Promise(function(resolve){
              var name = ${JSON.stringify(MUTATION_NAME)};
              function shape(v){
                if (!v) return null;
                if (typeof v === "string" && /^\\d{14,20}$/.test(v)) return v;
                if (typeof v.default === "string" && /^\\d{14,20}$/.test(v.default)) return v.default;
                if (v.params && typeof v.params.id === "string" && /^\\d{14,20}$/.test(v.params.id)) return v.params.id;
                if (typeof v.id === "string" && /^\\d{14,20}$/.test(v.id)) return v.id;
                return null;
              }
              try { var r = require(name + "_facebookRelayOperation"); var s = shape(r); if (s) return resolve(s); } catch(_){}
              try { var r2 = require(name); var s2 = shape(r2); if (s2) return resolve(s2); } catch(_){}
              try {
                if (typeof requireLazy === "function") {
                  var done = false;
                  requireLazy([name + "_facebookRelayOperation"], function(m){ if(done) return; done=true; resolve(shape(m)); });
                  setTimeout(function(){ if(done) return; done=true; resolve(null); }, 6000);
                  return;
                }
              } catch(_){}
              resolve(null);
            });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        const relayId = relayResult?.result?.value;
        if (relayId && /^\d{14,20}$/.test(relayId)) {
          capturedDocIds[MUTATION_NAME] = relayId;
          updateDocId(MUTATION_NAME, relayId);
          console.log(`${MODULE} Got fresh doc_id from Relay registry: ${relayId}`);
        }
      } catch (_) {}
    }

    const docId = capturedDocIds[MUTATION_NAME] || getDocId(MUTATION_NAME) || FALLBACK_DOC_ID;

    const postId = extractPostIdFromUrl(groupUrl);
    const browserReqSeq = JSON.stringify((Math.floor(Math.random() * 20) + 1).toString(36));
    const browserMutId  = JSON.stringify(String(Math.floor(Math.random() * 9) + 1));

    const jsCode = `
(async function() {
  try {
    const capturedParams = ${JSON.stringify(sessionParams)};
    const commentId  = ${JSON.stringify(String(commentId))};
    const newText    = ${JSON.stringify(String(newText))};
    const groupUrl   = ${JSON.stringify(String(groupUrl))};
    const docId      = ${JSON.stringify(String(docId))};
    const postId     = ${JSON.stringify(String(postId || ""))};
    const imageBase64 = ${JSON.stringify(imageBase64)};
    const imageMime   = ${JSON.stringify(imageMime)};
    // Match the page's ACTUAL Facebook origin (www vs web.facebook.com) so the
    // request stays same-origin and the session cookies are sent (avoids 1357001).
    const fbOrigin = (typeof location !== "undefined" && location.origin && location.origin.indexOf("facebook.com") !== -1)
      ? location.origin : "https://www.facebook.com";
    const imageFileName = ${JSON.stringify(imageFileName)};

    const dtsg = (() => {
      try { const r = require("DTSGInitialData"); if (r?.token) return r.token; } catch(_) {}
      const el = document.querySelector('input[name="fb_dtsg"]');
      return el?.value || null;
    })();

    const lsd = (() => {
      try { const r = require("LSD"); if (r?.token) return r.token; } catch(_) {}
      return capturedParams.__lsd || "";
    })();

    const uid = (() => {
      try { const r = require("CurrentUserInitialData"); if (r?.USER_ID) return String(r.USER_ID); } catch(_) {}
      const m = document.cookie.match(/(?:^|;\\s*)c_user=([^;]+)/);
      return m ? m[1].trim() : null;
    })();

    if (!dtsg) return JSON.stringify({ error: "Could not extract fb_dtsg" });
    if (!uid)  return JSON.stringify({ error: "Could not extract user ID" });

    const jazoest = "2" + Array.from(dtsg).reduce((s, c) => s + c.charCodeAt(0), 0);

    // Upload image inside the browser context if base64 data was provided
    let attachments = null;
    if (imageBase64 && postId) {
      try {
        const binary = atob(imageBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: imageMime });
        const feedbackId = btoa("feedback:" + postId);
        const uploadFd = new FormData();
        uploadFd.append("file", blob, imageFileName);
        const uploadQp = new URLSearchParams({
          av: uid, feedback_id: feedbackId, profile_id: uid, source: "19", target_id: uid,
          __user: uid, __a: "1", __aaid: "0", dpr: "1", __ccg: "EXCELLENT", __comet_req: "15",
          fb_dtsg: dtsg, jazoest, lsd,
        });
        const uploadResp = await fetch(fbOrigin + "/ajax/ufi/upload/?" + uploadQp.toString(), {
          method: "POST",
          credentials: "include",
          headers: { "x-fb-lsd": lsd, "x-asbd-id": "359341", "origin": fbOrigin, "referer": groupUrl },
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
      } catch(uploadErr) {
        // Image upload failed — proceed with text only
      }
    }

    const variables = {
      input: {
        actor_id:             uid,
        client_mutation_id:   ${browserMutId},
        attachments:          attachments,
        attribution_id_v2:    "CometGroupDiscussionRoot.react,comet.group,via_cold_start," + Date.now() + ",503819,2361831622,,",
        comment_id:           commentId,
        formatting_style:     "PLAIN_TEXT",
        message:              { ranges: [], text: newText },
        tracking:             [null],
      },
      feedLocation:    "GROUP",
      scale:           1,
      useDefaultActor: false,
      translationType: "AUTO_TRANSLATE",
      "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
      "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
      "__relay_internal__pv__IsWorkUserrelayprovider": false,
    };

    const bodyObj = {
      av: uid, __aaid: "0", __user: uid, __a: "1", __req: ${browserReqSeq}, dpr: "1", __ccg: "EXCELLENT",
      __comet_req: "15", fb_dtsg: dtsg, jazoest, lsd,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "useCometUFIEditCommentMutation",
      server_timestamps: "true",
      variables: JSON.stringify(variables),
      doc_id: docId
    };
    const SESSION_KEYS = ["__rev","__s","__hsi","__dyn","__csr","__hs","__hsdp","__hblp","__sjsp","__spin_r","__spin_b","__spin_t","__crn"];
    SESSION_KEYS.forEach(k => { if (capturedParams[k]) bodyObj[k] = capturedParams[k]; });

    const resp = await fetch(fbOrigin + "/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-lsd": lsd,
        "x-fb-friendly-name": "useCometUFIEditCommentMutation",
        "x-asbd-id": "359341",
        "origin": fbOrigin,
        "referer": groupUrl,
      },
      body: new URLSearchParams(bodyObj).toString()
    });

    const raw = await resp.text();
    let parsed = null;
    for (const line of raw.split("\\n")) {
      const t = line.trim();
      if (!t) continue;
      try { parsed = JSON.parse(t); break; } catch(_) {}
    }

    if (parsed?.errors?.length) return JSON.stringify({ error: "FB API error: " + JSON.stringify(parsed.errors) });

    const comment = parsed?.data?.comment_edit?.comment || null;
    return JSON.stringify({ success: !!comment, commentId: comment?.id || null, uid });

  } catch(err) {
    return JSON.stringify({ error: err.message });
  }
})()`;

    const evalResult = await Runtime.evaluate({ expression: jsCode, awaitPromise: true, returnByValue: true });
    let res;
    try { res = JSON.parse(evalResult.result?.value || "{}"); } catch(_) { res = { error: "Parse error" }; }

    // Save captured doc_ids
    for (const [fn, di] of Object.entries(capturedDocIds)) updateDocId(fn, di);

    if (res.success) updateDocId(MUTATION_NAME, docId);
    if (res.error && isDefiniteDocIdError(res.error)) invalidateDocId(MUTATION_NAME);

    return { ...res, profileId, method: "browser" };

  } catch (err) {
    console.error(`${MODULE} Fatal error:`, err.message);
    return { success: false, error: err.message, profileId };
  } finally {
    await gracefulCloseVCBrowser(client, chromeProcess);
  }
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Edit an existing Facebook group comment.
 *
 * @param {object} opts
 * @param {string}  opts.commentId    - The base64 comment ID (from scan or add-comment response)
 * @param {string}  opts.newText      - New comment text to replace the existing content
 * @param {string}  opts.groupUrl     - Full Facebook group URL (used as referer)
 * @param {string}  opts.profileId    - VCBrowser profile ID
 * @param {object}  opts.profileData  - { proxy, fingerprint, cookies[] }
 */
async function facebookGroupEditComment({ commentId, newText, imagePath, groupUrl, profileId, profileData }) {
  if (!commentId) return { success: false, error: "commentId is required", profileId };
  if (!newText)   return { success: false, error: "newText is required", profileId };

  const cookies    = profileData.cookies || [];
  const proxy      = profileData.proxy?.ip && profileData.proxy.ip !== "NULL" ? profileData.proxy : null;
  let fingerprint  = profileData.fingerprint || {};
  if (!fingerprint || Object.keys(fingerprint).length === 0)
    fingerprint = getConsistentFingerprintForProfile(profileId);
  try {
    const v = getVCBrowserVersion();
    if (fingerprint.userAgent && v?.full)
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${v.full}`);
  } catch (_) {}
  const userAgent = fingerprint.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

  console.log(`${MODULE} Trying HTTP-first for profile ${profileId}…`);
  const httpResult = await editViaHttp({ commentId, newText, imagePath, groupUrl, profileId, cookies, userAgent, proxy });
  if (httpResult) {
    console.log(`${MODULE} HTTP success:`, httpResult.success);
    return httpResult;
  }

  console.log(`${MODULE} HTTP failed — falling back to browser for profile ${profileId}…`);
  return editViaBrowser({ commentId, newText, imagePath, groupUrl, profileId, profileData });
}

// Serialize through the shared per-profile session mutex (see facebookProfileLock).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookGroupEditComment: (args) => _runProfileExclusive(args && args.profileId, () => facebookGroupEditComment(args)),
};
