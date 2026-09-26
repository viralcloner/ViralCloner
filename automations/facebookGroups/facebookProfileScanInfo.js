/**
 * Facebook Profile Scan Info Automation
 *
 * Verifies that a stored Chrome profile is still logged into Facebook and
 * collects basic identity info about the logged-in account:
 *   - login health (the most important signal)
 *   - display name
 *   - numeric user id + vanity username
 *   - profile picture + cover photo
 *   - friends / followers count (best-effort, localized text)
 *
 * Uses the robust browser path: launches a VCBrowser with the profile's
 * fingerprint + injected cookies, navigates to facebook.com/me/, then reads
 * the identity out of the page context (CurrentUserInitialData) and scrapes
 * the cover / friends / followers from the rendered DOM.
 */

const { startVCBrowser, gracefulCloseVCBrowser } = require("../../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");
const { updateMany, extractDocIdsFromHtml } = require("../../lib/facebookDocIds");
const { persistFreshCookies, cdpCookiesToStorage, injectCookiesIfLoggedOut } = require("../../lib/facebookCookieStore");

const MODULE = "[FbProfileScanInfo]";

// Unescape a JSON-string URI fragment (Facebook escapes "/" as "\/" and may use
// \uXXXX sequences in query params).
function unescapeJsonUri(s) {
  if (!s) return s;
  try { return JSON.parse('"' + s + '"'); }
  catch (_) { return s.replace(/\\\//g, "/"); }
}

// Return the first capture group that matches any of the given regexes.
function firstMatch(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m && m[1]) return unescapeJsonUri(m[1]);
  }
  return null;
}

// Extract the real profile picture + cover photo from captured Facebook GraphQL
// responses (ProfileCometHeaderQuery and friends embed both as fbcdn URLs).
function extractBrandingFromGraphQL(combined) {
  if (!combined) return { profilePicture: null, coverImage: null };

  const coverImage = firstMatch(combined, [
    /"cover_photo":\{[\s\S]{0,800}?"image":\{"uri":"([^"]+)"/,
    /"cover_photo":\{[\s\S]{0,800}?"uri":"([^"]+)"/,
    /"coverPhoto":\{[\s\S]{0,800}?"uri":"([^"]+)"/,
    /"profileCoverPhoto"[\s\S]{0,400}?"uri":"([^"]+)"/,
  ]);

  const profilePicture = firstMatch(combined, [
    /"profilePicLarge":\{"uri":"([^"]+)"/,
    /"profile_picture_for_sticky_bar":\{"uri":"([^"]+)"/,
    /"profilePicMedium":\{"uri":"([^"]+)"/,
    /"profilePic.{0,40}?":\{"uri":"([^"]+)"/,
  ]);

  return { profilePicture, coverImage };
}

/**
 * Scan a profile's Facebook account.
 *
 * @param {object} opts
 * @param {string}  opts.profileId    - VCBrowser profile name / ID
 * @param {object}  opts.profileData  - { proxy, fingerprint, cookies[] }
 * @returns {Promise<{success:boolean, loggedIn:boolean, info?:object, error?:string, profileId:string}>}
 */
async function facebookProfileScanInfo({ profileId, profileData }) {
  if (!profileId)   return { success: false, loggedIn: false, error: "Missing profileId", profileId };
  if (!profileData) return { success: false, loggedIn: false, error: "Missing profile data", profileId };

  const cookies = profileData.cookies || [];
  if (!cookies.length) {
    return { success: true, loggedIn: false, error: "No cookies — log this profile into Facebook first", profileId };
  }

  const proxy = profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== "NULL"
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
      return { success: false, loggedIn: false, error: "Failed to start VCBrowser", profileId };
    }

    client        = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;

    await Network.enable();

    // ── Inject stored cookies (only if the live profile is logged out) ────
    await injectCookiesIfLoggedOut(Network, cookies, MODULE);

    // ── Capture Facebook's own GraphQL responses ──────────────────────────
    // The profile header query embeds the real profile picture + cover photo
    // as fbcdn URLs — far more reliable than DOM scraping or the graph endpoint.
    const graphqlRequestIds = new Set();
    const graphqlBodies = [];
    // Dynamically harvest Relay doc_ids from the live GraphQL requests so the
    // profile queries stay fresh when Facebook rotates them (same approach the
    // group/post automations use).
    const capturedDocIds = {};
    try {
      Network.requestWillBeSent(({ request }) => {
        try {
          if (request && request.url && request.url.includes("/api/graphql") && request.postData) {
            const p = new URLSearchParams(request.postData);
            const fn = p.get("fb_api_req_friendly_name");
            const di = p.get("doc_id");
            if (fn && di) capturedDocIds[fn] = di;
          }
        } catch (_) {}
      });
      Network.responseReceived(({ requestId, response }) => {
        try {
          const url = (response && response.url) || "";
          const ct = (response && response.headers &&
            (response.headers["content-type"] || response.headers["Content-Type"])) || "";
          if (url.includes("/api/graphql") || url.includes("/graphql") || ct.includes("application/json")) {
            graphqlRequestIds.add(requestId);
          }
        } catch (_) {}
      });
      Network.loadingFinished(async ({ requestId }) => {
        if (!graphqlRequestIds.has(requestId)) return;
        try {
          const { body, base64Encoded } = await Network.getResponseBody({ requestId });
          const text = base64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
          if (text && (text.includes("cover_photo") || text.includes("profilePic") || text.includes("coverPhoto"))) {
            graphqlBodies.push(text);
          }
        } catch (_) {}
      });
    } catch (e) {
      console.warn(`${MODULE} GraphQL capture setup warning:`, e.message);
    }

    // ── Navigate to the logged-in user's own profile ──────────────────────
    console.log(`${MODULE} Navigating to facebook.com/me/`);
    await Page.navigate({ url: "https://www.facebook.com/me/" });
    await new Promise(r => setTimeout(r, 9000));

    const urlEval = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
    const currentUrl = urlEval.result?.value || "";
    console.log(`${MODULE} Landed on: ${currentUrl}`);

    if (/\/(login|checkpoint|recover|two_step_verification)/.test(currentUrl)) {
      return { success: true, loggedIn: false, error: "Profile is logged out (redirected to login/checkpoint)", profileId };
    }

    // ── Persist freshly-seen Relay doc_ids ────────────────────────────────
    // 1) From the live GraphQL requests captured above,
    // 2) from the in-page Relay operation registry (most reliable), and
    // 3) by scanning the page bundle HTML (best-effort) — exactly how the
    //    group/post automations keep their doc_ids current.
    try {
      if (Object.keys(capturedDocIds).length) updateMany(capturedDocIds);

      // Read the profile query doc_ids straight from Facebook's Relay registry.
      const relayEval = await Runtime.evaluate({
        expression: `(function(){
          var names = ["ProfileCometHeaderQuery","ProfileCometTimelineFeedRefetchQuery"];
          var out = {};
          for (var i=0;i<names.length;i++){
            try {
              var v = require(names[i] + "_facebookRelayOperation");
              if (typeof v === "string" && /^\\d{14,20}$/.test(v)) { out[names[i]] = v; continue; }
              if (v && typeof v.default === "string") { out[names[i]] = v.default; }
            } catch(_) {}
          }
          return JSON.stringify(out);
        })()`,
        returnByValue: true,
      });
      let fromRegistry = {};
      try { fromRegistry = JSON.parse(relayEval?.result?.value || "{}"); } catch (_) {}
      if (Object.keys(fromRegistry).length) {
        updateMany(fromRegistry);
        console.log(`${MODULE} doc_ids from Relay registry:`, fromRegistry);
      }

      const htmlEval = await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true });
      const pageHtml = htmlEval?.result?.value || "";
      if (pageHtml) updateMany(extractDocIdsFromHtml(pageHtml));
    } catch (e) {
      console.warn(`${MODULE} doc_id refresh warning:`, e.message);
    }

    // ── Extract identity + branding from the page context ─────────────────
    const jsCode = `
(function () {
  function out(o){ return JSON.stringify(o); }
  try {
    var res = { loggedIn:false };

    if (/\\/(login|checkpoint|recover|two_step_verification)/.test(location.pathname)) return out(res);

    var cu = {};
    try { cu = require("CurrentUserInitialData") || {}; } catch(_) {}
    var uid = cu.USER_ID || cu.ACCOUNT_ID || null;
    if (uid) uid = String(uid);
    if (!uid || uid === "0") {
      // Fall back to the c_user cookie if the module wasn't available.
      var m = document.cookie.match(/c_user=(\\d+)/);
      if (m) uid = m[1];
    }
    if (!uid || uid === "0") return out(res);

    res.loggedIn = true;
    res.userId   = uid;
    res.name     = cu.NAME || cu.SHORT_NAME || null;
    res.url      = location.href;

    // Vanity username from the resolved URL (skip profile.php / me).
    var um = location.href.match(/facebook\\.com\\/([^/?#]+)/);
    if (um && um[1] && !/^profile\\.php/i.test(um[1]) && um[1].toLowerCase() !== "me") {
      try { res.username = decodeURIComponent(um[1]); } catch(_) { res.username = um[1]; }
    }

    // Profile picture — try to read the real rendered avatar. Facebook renders
    // profile photos either as <img> or inside an <svg><image>. We look for an
    // fbcdn image referencing this user's id (best) or the first square avatar.
    try {
      var pic = null;
      var svgImgs = Array.prototype.slice.call(document.querySelectorAll('image'));
      for (var s = 0; s < svgImgs.length; s++) {
        var href = svgImgs[s].getAttribute('xlink:href') || svgImgs[s].getAttribute('href') || '';
        if (href && href.indexOf('fbcdn') !== -1) {
          if (uid && href.indexOf(uid) !== -1) { pic = href; break; }
          if (!pic) pic = href;
        }
      }
      if (!pic) {
        var pimgs = Array.prototype.slice.call(document.querySelectorAll('div[role="main"] img[src*="fbcdn"]'));
        for (var p = 0; p < pimgs.length; p++) {
          var ps = pimgs[p].src || '';
          if (uid && ps.indexOf(uid) !== -1) { pic = ps; break; }
        }
      }
      if (pic) res.profilePicture = pic;
    } catch(_) {}

    // Cover photo — try a few stable selectors, then fall back to the first
    // large fbcdn image in the main region.
    try {
      var cover = document.querySelector('img[data-imgperflogname="profileCoverPhoto"]')
               || document.querySelector('[data-pagelet*="ProfileCover"] img')
               || null;
      if (!cover) {
        var imgs = Array.prototype.slice.call(document.querySelectorAll('div[role="main"] img[src*="fbcdn"]'));
        for (var i = 0; i < imgs.length; i++) {
          var im = imgs[i];
          if ((im.naturalWidth || im.width || 0) >= 400) { cover = im; break; }
        }
      }
      if (cover && cover.src) res.coverImage = cover.src;
    } catch(_) {}

    // Friends / followers — scan visible link/heading text in EN / FR / AR.
    try {
      var nodes = Array.prototype.slice.call(document.querySelectorAll('a[role="link"], a, span'));
      var friendRe   = /([\\d][\\d.,\\s]*\\s*[KMkm]?)\\s*(friends?|amis?|صديق|أصدقاء)/i;
      var followerRe = /([\\d][\\d.,\\s]*\\s*[KMkm]?)\\s*(followers?|abonn[ée]s?|متابع)/i;
      for (var j = 0; j < nodes.length; j++) {
        var txt = (nodes[j].textContent || "").trim();
        if (!txt || txt.length > 40) continue;
        if (!res.friendsText) { var fm = txt.match(friendRe); if (fm) res.friendsText = txt; }
        if (!res.followersText) { var lm = txt.match(followerRe); if (lm) res.followersText = txt; }
        if (res.friendsText && res.followersText) break;
      }
    } catch(_) {}

    return out(res);
  } catch (e) {
    return out({ loggedIn:false, error: String(e && e.message || e) });
  }
})()
`;

    const evalResult = await Runtime.evaluate({
      expression:    jsCode,
      awaitPromise:  false,
      returnByValue: true,
    });

    let parsed;
    try {
      const raw = evalResult.result?.value;
      parsed = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    } catch (_) {
      parsed = { loggedIn: false, error: "Could not parse browser result" };
    }

    // Give any in-flight response bodies a moment to finish, then pull the real
    // profile picture + cover photo out of the captured GraphQL payloads.
    await new Promise(r => setTimeout(r, 500));
    const branding = extractBrandingFromGraphQL(graphqlBodies.join("\n"));
    console.log(`${MODULE} GraphQL branding — pic=${branding.profilePicture ? "yes" : "no"} cover=${branding.coverImage ? "yes" : "no"} (from ${graphqlBodies.length} payloads)`);

    // Refresh-back: if this profile is logged in, persist the live (rotated)
    // cookie jar so the stored snapshot stays alive. The health scan is the
    // ideal refresh point — it proves the session is valid right now.
    if (parsed.loggedIn) {
      try {
        const all = await Network.getAllCookies();
        const fresh = cdpCookiesToStorage(all?.cookies || []);
        if (fresh.length) await persistFreshCookies(profileId, fresh);
      } catch (_) {}
    }

    // Close gracefully so Chrome flushes the rotated cookie jar to disk — the
    // health scan is a key refresh point that keeps the session alive.
    await gracefulCloseVCBrowser(client, chromeProcess);
    client = null; chromeProcess = null;

    if (!parsed.loggedIn) {
      return { success: true, loggedIn: false, error: parsed.error || "Profile is not logged in to Facebook", profileId };
    }

    const info = {
      userId:         parsed.userId || null,
      name:           parsed.name || null,
      username:       parsed.username || null,
      url:            parsed.url || (parsed.username ? `https://www.facebook.com/${parsed.username}` : `https://www.facebook.com/profile.php?id=${parsed.userId}`),
      // Prefer the real fbcdn picture captured from GraphQL; fall back to the
      // DOM-scraped value, then the public graph endpoint as a last resort.
      profilePicture: branding.profilePicture || parsed.profilePicture
                       || (parsed.userId ? `https://graph.facebook.com/${parsed.userId}/picture?type=large&width=480&height=480` : null),
      coverImage:     branding.coverImage || parsed.coverImage || null,
      friendsText:    parsed.friendsText || null,
      followersText:  parsed.followersText || null,
      scannedAt:      new Date().toISOString(),
    };

    console.log(`${MODULE} Scan OK — name="${info.name}" uid=${info.userId} username=${info.username || "(none)"}`);
    return { success: true, loggedIn: true, info, profileId };

  } catch (err) {
    console.error(`${MODULE} Fatal error:`, err.message);
    return { success: false, loggedIn: false, error: err.message, profileId };
  } finally {
    await gracefulCloseVCBrowser(client, chromeProcess);
  }
}

// Serialize through the shared per-profile session mutex (see facebookProfileLock).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookProfileScanInfo: (args) => _runProfileExclusive(args && args.profileId, () => facebookProfileScanInfo(args)),
};
