/**
 * facebookHttpSession.js
 *
 * Extracts Facebook session tokens (fb_dtsg, lsd, uid) from a plain HTTPS
 * request using stored cookies — no browser required.
 *
 * Returns null if the cookies are expired / the profile is logged out,
 * allowing the caller to fall back to the browser-based flow.
 */

const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const MODULE = "[FbHttpSession]";

// Default UA derived from the ACTUAL bundled VCBrowser version. Callers normally
// pass the profile's fingerprint UA; this fallback only applies when none is
// supplied, and it must still match the browser's Chrome version so the HTTP and
// browser surfaces present one consistent device to Facebook (a version mismatch
// is a device-integrity signal that triggers identity/selfie checkpoints).
function defaultUserAgent() {
  let full = "142.0.0.0";
  try {
    const { getVCBrowserVersion } = require("./cdpFingerprint");
    const v = getVCBrowserVersion();
    if (v && v.full) full = v.full;
  } catch (_) {}
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
}

/**
 * Build a cookie header string from the stored cookie array.
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {string}
 */
function buildCookieHeader(cookies) {
  return (cookies || []).map(c => `${c.name}=${c.value}`).join("; ");
}

/**
 * Build an HttpsProxyAgent from a proxy config object, or return null if no proxy.
 * @param {{ip:string, port:number|string, username?:string, password?:string}|null} proxy
 * @returns {HttpsProxyAgent|null}
 */
function buildProxyAgent(proxy) {
  if (!proxy || !proxy.ip || proxy.ip === "NULL") return null;
  const port = proxy.port || 8080;
  let proxyUrl;
  if (proxy.username && proxy.username !== "NULL" && proxy.password && proxy.password !== "NULL") {
    proxyUrl = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.ip}:${port}`;
  } else {
    proxyUrl = `http://${proxy.ip}:${port}`;
  }
  try { return new HttpsProxyAgent(proxyUrl); } catch (_) { return null; }
}

/**
 * Derive sec-ch-ua hint headers from a user-agent string.
 * Every Chrome 89+ browser sends these on every request; their absence is a
 * strong non-browser signal to Facebook's detection systems.
 * @param {string} userAgent
 * @returns {object}
 */
function buildSecChUaHeaders(userAgent) {
  const ver = ((userAgent || "").match(/Chrome\/(\d+)/) || [])[1] || "142";
  return {
    "sec-ch-ua": `"Chromium";v="${ver}", "Google Chrome";v="${ver}", "Not.A/Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

/**
 * Fetch a URL via Node https, following one redirect, with the given headers.
 * Returns { status, headers, body }.
 */
function httpsGet(url, headers, proxy) {
  return new Promise((resolve, reject) => {
    const agent = proxy ? buildProxyAgent(proxy) : null;
    const options = {
      method: "GET",
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
        ...headers,
      },
    };

    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: options.headers,
      ...(agent ? { agent } : {}),
    };

    const req = https.request(reqOptions, (res) => {
      // Handle redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${urlObj.hostname}${res.headers.location}`;
        res.resume();
        return httpsGet(redirectUrl, headers, proxy).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.end();
  });
}

/**
 * Try to obtain Facebook session tokens purely via HTTP (no browser).
 *
 * @param {Array}  cookies     - Stored cookie array from profileData.cookies
 * @param {string} userAgent   - Fingerprint UA string
 * @param {string} [refUrl]    - Optional URL to fetch (defaults to facebook.com)
 * @returns {Promise<{dtsg:string, lsd:string, uid:string}|null>}
 *          Returns null if the profile appears to be logged out.
 */
async function getFacebookSessionTokens(cookies, userAgent, refUrl, proxy) {
  if (!cookies || cookies.length === 0) {
    console.log(`${MODULE} No cookies available — cannot use HTTP session`);
    return null;
  }

  const cookieHeader = buildCookieHeader(cookies);
  const fetchUrl = refUrl || "https://www.facebook.com/";
  const effectiveUA = userAgent || defaultUserAgent();

  // Retry the page fetch a few times on transient network/proxy errors. Flaky
  // residential proxies routinely drop a single request; a quiet retry avoids an
  // unnecessary (and much slower) browser fallback. Decisive outcomes (logged
  // out, missing tokens) return immediately and are NOT retried.
  const MAX_FETCH_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const { status, body, headers } = await httpsGet(fetchUrl, {
        "cookie": cookieHeader,
        "user-agent": effectiveUA,
        ...buildSecChUaHeaders(effectiveUA),
      }, proxy);
      const setCookieHeaders = headers && headers["set-cookie"] ? headers["set-cookie"] : [];

      // Redirect to login = session expired (decisive — no retry)
      if (status === 302 || body.includes('"login"') || body.includes('id="login_form"')) {
        console.log(`${MODULE} Cookies appear expired (redirected to login)`);
        return null;
      }

      // Extract fb_dtsg
      const dtsg =
        (body.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
         body.match(/"DTSGInitialData",\[\],{"token":"([^"]+)"/) ||
         body.match(/name="fb_dtsg" value="([^"]+)"/) ||
         body.match(/"dtsg_ag"\s*:\s*\{"token"\s*:\s*"([^"]+)"/))?.[1] || null;

      // Extract LSD token
      const lsd =
        (body.match(/"LSD",\[\],\{"token":"([^"]+)"/) ||
         body.match(/"lsd"\s*:\s*"([^"]{6,30})"/) ||
         body.match(/name="lsd" value="([^"]+)"/))?.[1] || null;

      // Extract uid from c_user cookie (most reliable)
      const uidFromCookie = (cookieHeader.match(/c_user=(\d+)/) || [])[1] || null;
      const uidFromBody   =
        (body.match(/"USER_ID"\s*:\s*"(\d+)"/) ||
         body.match(/"uid"\s*:\s*"(\d+)"/))?.[1] || null;
      const uid = uidFromCookie || uidFromBody || null;

      if (!dtsg || !uid) {
        // uid comes from the cookie; if it is present but dtsg is missing the page
        // was likely a transient/partial response — retry. If uid itself is missing
        // the profile is almost certainly logged out (decisive — no retry).
        if (uid && attempt < MAX_FETCH_ATTEMPTS) {
          console.log(`${MODULE} dtsg missing (attempt ${attempt}) — retrying fetch`);
          await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
          continue;
        }
        console.log(`${MODULE} Could not extract dtsg=${!!dtsg} uid=${!!uid} from HTTP response — profile may not be logged in`);
        return null;
      }

      // Extract the numeric group id from the fetched page (when refUrl is a group page).
      // The page HTML embeds it even when the URL used a vanity slug.
      const pageGroupId =
        (body.match(/"groupID"\s*:\s*"(\d+)"/) ||
         body.match(/"group_id"\s*:\s*"(\d+)"/) ||
         body.match(/\\"groupID\\"\s*:\s*\\"(\d+)\\"/) ||
         body.match(/\/groups\/(\d+)/))?.[1] || null;

      console.log(`${MODULE} HTTP session OK: uid=${uid}, dtsg=${dtsg.slice(0, 8)}..., lsd=${lsd ? lsd.slice(0, 8) + "..." : "(none)"}`);
      return { dtsg, lsd: lsd || "", uid, cookieHeader, pageGroupId, pageBody: body, setCookieHeaders };

    } catch (err) {
      lastErr = err;
      console.warn(`${MODULE} HTTP session fetch attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_FETCH_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
        continue;
      }
    }
  }

  console.error(`${MODULE} HTTP session fetch failed after ${MAX_FETCH_ATTEMPTS} attempts: ${lastErr?.message || "unknown error"}`);
  return null;
}

/**
 * Classify a Facebook error/failure message so callers can decide whether to
 * retry the same profile (transient), pause the workflow (session), or skip the
 * post permanently (content/permission/soft-block).
 * @param {string} errMsg
 * @returns {"transient"|"permanent_session"|"permanent_content"}
 */
function classifyFbError(errMsg) {
  const m = String(errMsg || "").toLowerCase();
  if (!m) return "transient";
  // Session / auth problems → workflow must pause, profile needs re-login.
  if (/session|cookie|not logged|logged out|\blogin\b|checkpoint|c_user|\bauth\b|re-?authenticate/.test(m)) {
    return "permanent_session";
  }
  // Content / permission / account soft-block → retrying this post now cannot help
  // and (for action blocks) hammering it harms the account. Skip permanently.
  if (/community standard|policy|\bspam\b|not allowed|cannot post|no permission|not have permission|restricted|\bbanned\b|disabled|abusive|action blocked|temporarily blocked|you're temporarily|rate limit exceeded|too many requests|blocked from posting/.test(m)) {
    return "permanent_content";
  }
  // network / timeout / proxy / generic → safe to retry.
  return "transient";
}

/**
 * Detect Facebook's temporary per-ACTION spam-prevention throttle on commenting
 * ("We limit how often you can post, comment or do other things..." / French
 * "Nous limitons le nombre de fois que vous pouvez publier, commenter...").
 * This is narrower than isAccountLevelBlock: the account can often still post,
 * just not comment, for a cooldown window. Detected primarily via Facebook's
 * language-independent numeric error codes so it works across locales.
 * @param {string} errMsg
 * @returns {boolean}
 */
function isCommentRateLimited(errMsg) {
  const m = String(errMsg || "");
  if (!m) return false;
  if (/"api_error_code"\s*:\s*368\b/.test(m)) return true;
  if (/"code"\s*:\s*1390008\b/.test(m)) return true;
  if (/field_exception/i.test(m) && /limit|limitons|spam|trop de fois|too many times/i.test(m)) return true;
  return false;
}

/**
 * Detect an ACCOUNT-LEVEL problem that needs the user to step in (the account is
 * blocked/restricted/checkpointed/logged out), as opposed to a per-post content
 * rejection (e.g. a single post violating a policy). When true, the profile
 * itself should be flagged and benched until the user clears it — continuing to
 * use it only harms the account and wastes posts.
 * @param {string} errMsg
 * @returns {boolean}
 */
function isAccountLevelBlock(errMsg) {
  const m = String(errMsg || "").toLowerCase();
  if (!m) return false;
  // Session/auth loss is always account-level (covers logged out / checkpoint).
  if (classifyFbError(m) === "permanent_session") return true;
  // Account soft/hard blocks that bench the whole profile, not just one post.
  return /action blocked|temporarily blocked|you're temporarily|you are temporarily|rate limit exceeded|too many requests|blocked from posting|\bbanned\b|account (?:is )?disabled|account (?:is )?restricted|your account|verify your identity|confirm your identity/.test(m);
}

/**
 * Lightweight proxy reachability probe. Fires a tiny GET to facebook.com through
 * the proxy; any HTTP response means the proxy successfully tunnelled to FB.
 * Retries a couple of times so a single dropped connection doesn't mark a good
 * proxy as dead. Returns true when no proxy is configured (nothing to check).
 * @param {object|null} proxy
 * @param {string} [userAgent]
 * @returns {Promise<boolean>}
 */
function checkProxyReachable(proxy, userAgent) {
  if (!proxy || !proxy.ip || proxy.ip === "NULL") return Promise.resolve(true);

  const ua = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  const ping = () => new Promise((resolve) => {
    const agent = buildProxyAgent(proxy);
    if (!agent) return resolve(false);
    const req = https.request({
      hostname: "www.facebook.com",
      path: "/robots.txt",
      method: "GET",
      headers: { "user-agent": ua, "accept": "*/*", ...buildSecChUaHeaders(ua) },
      agent,
    }, (res) => {
      res.resume(); // drain & discard — we only care that a response arrived
      resolve(typeof res.statusCode === "number" && res.statusCode > 0);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.end();
  });

  return (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await ping()) return true;
      if (attempt < 3) await new Promise(r => setTimeout(r, 600 + Math.random() * 900));
    }
    return false;
  })();
}

/**
 * Build the jazoest value from a fb_dtsg token.
 * @param {string} dtsg
 * @returns {string}
 */
function buildJazoest(dtsg) {
  let sum = 0;
  for (const ch of dtsg) sum += ch.charCodeAt(0);
  return "2" + sum;
}

/**
 * POST a Facebook GraphQL request directly from Node.js using stored cookies.
 *
 * @param {object} opts
 * @param {string}  opts.friendlyName  - e.g. "ComposerStoryCreateMutation"
 * @param {string}  opts.docId         - Relay persisted query doc_id
 * @param {object}  opts.variables     - GraphQL variables object
 * @param {string}  opts.dtsg
 * @param {string}  opts.lsd
 * @param {string}  opts.uid
 * @param {string}  opts.cookieHeader  - Pre-built cookie string
 * @param {string}  opts.referer       - Referer URL
 * @param {string}  opts.userAgent
 * @returns {Promise<{ok:boolean, rawText:string, json:object|null, jsonChunks:object[], status:number, requestSent:boolean, networkError:boolean, errorMessage?:string}>}
 */
function _postGraphQLOnce({ friendlyName, docId, variables, dtsg, lsd, uid, cookieHeader, referer, userAgent, proxy }) {
  const jazoest = buildJazoest(dtsg);
  const agent = proxy ? buildProxyAgent(proxy) : null;
  const effectiveUA = userAgent || defaultUserAgent();
  // Randomise the request sequence counter. Real sessions use a short base-36 counter
  // that increments; always sending "http1" is a textbook bot fingerprint.
  const reqSeq = (Math.floor(Math.random() * 20) + 1).toString(36);

  const bodyObj = new URLSearchParams({
    av: uid,
    __aaid: "0",
    __user: uid,
    __a: "1",
    __req: reqSeq,
    dpr: "1",
    __ccg: "EXCELLENT",
    __comet_req: "15",
    fb_dtsg: dtsg,
    jazoest,
    lsd: lsd || "",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: friendlyName,
    server_timestamps: "true",
    variables: JSON.stringify(variables),
    doc_id: docId,
  });

  return new Promise((resolve) => {
    const bodyStr = bodyObj.toString();
    const reqOptions = {
      hostname: "www.facebook.com",
      path: "/api/graphql/",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(bodyStr),
        "cookie": cookieHeader,
        "x-fb-lsd": lsd || "",
        "x-fb-friendly-name": friendlyName,
        "x-asbd-id": "359341",
        "origin": "https://www.facebook.com",
        "referer": referer || "https://www.facebook.com/",
        "user-agent": effectiveUA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "priority": "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        ...buildSecChUaHeaders(effectiveUA),
      },
      ...(agent ? { agent } : {}),
    };

    // `requestSent` becomes true once the body bytes are flushed to the socket.
    // It is the duplicate-safety gate: when the request was never sent it is safe
    // to auto-retry; once it was sent the outcome is ambiguous and the caller must
    // verify (never blind-retry) to avoid double-posting.
    let bodyWritten = false;

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const rawText = Buffer.concat(chunks).toString("utf8");
        // Facebook GraphQL uses @defer streaming: the response is one-or-more
        // newline-delimited JSON objects. The FIRST line is the base payload
        // (used for error detection); deferred fragments (which often carry the
        // story / feedback ids) arrive on subsequent lines. Parse every line so
        // callers can deep-walk all fragments, not just the first.
        const jsonChunks = [];
        for (const line of String(rawText).split("\n")) {
          let t = line.trim();
          if (!t) continue;
          // Strip Facebook's anti-JSON-hijacking prefix ("for (;;);") if present.
          t = t.replace(/^for\s*\(\s*;\s*;\s*\)\s*;?/, "").trim();
          if (!t) continue;
          try { jsonChunks.push(JSON.parse(t)); } catch (_) {}
        }
        const json = jsonChunks.length ? jsonChunks[0] : null;
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          rawText, json, jsonChunks, status: res.statusCode,
          requestSent: true, networkError: false,
          setCookieHeaders: res.headers && res.headers["set-cookie"] ? res.headers["set-cookie"] : [],
        });
      });
      res.on("error", (err) => resolve({
        ok: false, rawText: "", json: null, status: res.statusCode || 0,
        requestSent: true, networkError: true, errorMessage: err.message,
      }));
    });

    req.on("error", (err) => resolve({
      ok: false, rawText: "", json: null, status: 0,
      requestSent: bodyWritten, networkError: true, errorMessage: err.message,
    }));
    req.setTimeout(30000, () => req.destroy(new Error("GraphQL request timed out")));
    req.write(bodyStr, () => { bodyWritten = true; });
    req.end();
  });
}

/**
 * POST a Facebook GraphQL request, retrying ONLY when the request was never sent
 * (connection refused / proxy-connect failure / DNS) — which carries no
 * duplicate-post risk. A request that was sent but produced no/garbled response
 * is returned as-is (requestSent:true) so the caller can verify the real outcome.
 * @returns {Promise<{ok:boolean, rawText:string, json:object|null, jsonChunks:object[], status:number, requestSent:boolean, networkError:boolean, errorMessage?:string}>}
 */
async function postGraphQL(opts) {
  const MAX_ATTEMPTS = 3;
  let result = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await _postGraphQLOnce(opts);
    if (result.ok) return result;
    // Only safe to auto-retry when the request never left this process.
    if (result.networkError && !result.requestSent && attempt < MAX_ATTEMPTS) {
      console.warn(`${MODULE} GraphQL ${opts.friendlyName || ""} not sent (attempt ${attempt}): ${result.errorMessage || "connect failed"} — retrying`);
      await new Promise(r => setTimeout(r, 700 + Math.random() * 1000));
      continue;
    }
    break;
  }
  return result;
}

module.exports = { getFacebookSessionTokens, postGraphQL, classifyFbError, isAccountLevelBlock, isCommentRateLimited, checkProxyReachable, buildCookieHeader, buildJazoest, buildProxyAgent, buildSecChUaHeaders };
