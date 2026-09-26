/**
 * Facebook cookie refresh-back store.
 *
 * The Facebook Groups automation posts by injecting the cookie SNAPSHOT stored
 * in `structures[...].profiles[id].cookies` (captured once at login) into a
 * fresh request/browser each run. Facebook rotates the session cookie (`xs`)
 * and refreshes `fr`/`datr`/`sb` periodically and hands the new values back via
 * `Set-Cookie` (HTTP) or in the live browser cookie jar (CDP). If we never save
 * those rotated values back, the stored snapshot goes stale and the profile
 * eventually looks "logged out" to the automation — even though the real
 * on-disk profile still works.
 *
 * This module captures the freshest cookies after a successful action and
 * merges them back into the stored snapshot, keeping sessions alive.
 */

const { readKey, updateData } = require("./utils");

const MODULE = "[FbCookieStore]";

// Cookies worth refreshing live on these Facebook domains.
function _isFacebookDomain(domain) {
  const d = String(domain || "").toLowerCase();
  return d.includes("facebook.com") || d.includes("fbcdn.net") || d.includes("fb.com");
}

function _normalizeSameSite(sameSite) {
  const s = String(sameSite || "").toLowerCase();
  if (s === "none" || s === "no_restriction") return "no_restriction";
  if (s === "strict") return "strict";
  return "lax";
}

/**
 * Convert CDP `Network.getAllCookies()` results into the storage format used by
 * `structures[...].profiles[id].cookies`.
 * @param {Array} cdpCookies
 * @returns {Array}
 */
function cdpCookiesToStorage(cdpCookies) {
  if (!Array.isArray(cdpCookies)) return [];
  return cdpCookies
    .filter((c) => c && c.name && _isFacebookDomain(c.domain))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: c.secure || false,
      httpOnly: c.httpOnly || false,
      sameSite: _normalizeSameSite(c.sameSite),
      expires: c.expires && c.expires > 0 ? c.expires : undefined,
    }));
}

/**
 * Parse an array of raw `Set-Cookie` header strings (Node's
 * `res.headers["set-cookie"]`) into the storage cookie format.
 * @param {Array<string>} setCookieHeaders
 * @returns {Array}
 */
function parseSetCookies(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders)) {
    if (typeof setCookieHeaders === "string") setCookieHeaders = [setCookieHeaders];
    else return [];
  }
  const out = [];
  for (const raw of setCookieHeaders) {
    if (!raw || typeof raw !== "string") continue;
    const parts = raw.split(";");
    const first = parts.shift();
    const eq = first.indexOf("=");
    if (eq === -1) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;

    const cookie = {
      name,
      value,
      domain: ".facebook.com",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      expires: undefined,
    };
    let maxAge = null;
    let expiresDate = null;
    for (const attr of parts) {
      const a = attr.trim();
      const lower = a.toLowerCase();
      if (lower === "secure") cookie.secure = true;
      else if (lower === "httponly") cookie.httpOnly = true;
      else if (lower.startsWith("domain=")) cookie.domain = a.slice(7).trim() || cookie.domain;
      else if (lower.startsWith("path=")) cookie.path = a.slice(5).trim() || "/";
      else if (lower.startsWith("samesite=")) cookie.sameSite = _normalizeSameSite(a.slice(9).trim());
      else if (lower.startsWith("max-age=")) maxAge = parseInt(a.slice(8).trim(), 10);
      else if (lower.startsWith("expires=")) expiresDate = a.slice(8).trim();
    }
    // Resolve expiry to unix seconds (Max-Age wins over Expires per RFC).
    if (maxAge != null && !Number.isNaN(maxAge)) {
      cookie.expires = Math.floor(Date.now() / 1000) + maxAge;
    } else if (expiresDate) {
      const t = Date.parse(expiresDate);
      if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
    }
    out.push(cookie);
  }
  return out.filter((c) => _isFacebookDomain(c.domain));
}

/**
 * Merge a set of fresh cookies into the stored snapshot for a profile and save
 * it back. Cookies are merged by name (Facebook session cookies all share
 * `.facebook.com`): existing cookies are updated in place and new ones appended.
 * Cookies are never removed — a missing rotation must not wipe a valid session.
 *
 * A cookie that Facebook explicitly cleared (empty value AND an expiry in the
 * past) is skipped so a transient "delete" response can't blank a good cookie.
 *
 * @param {string} profileId
 * @param {Array}  freshCookies  - cookies already in storage format
 * @returns {Promise<boolean>} true if the snapshot was updated
 */
async function persistFreshCookies(profileId, freshCookies) {
  if (!profileId || !Array.isArray(freshCookies) || freshCookies.length === 0) return false;
  try {
    const structures = await readKey("structures");
    if (!structures || typeof structures !== "object") return false;

    let targetStructId = null;
    for (const [sid, struct] of Object.entries(structures)) {
      if (struct && struct.profiles && struct.profiles[profileId]) {
        targetStructId = sid;
        break;
      }
    }
    if (!targetStructId) return false;

    const profile = structures[targetStructId].profiles[profileId];
    const existing = Array.isArray(profile.cookies) ? profile.cookies : [];

    const byName = new Map();
    for (const c of existing) {
      if (c && c.name) byName.set(c.name, c);
    }

    // Device-identity cookies. Facebook ties the account's "recognized device"
    // trust (and the new-device heuristics that trigger the "confirm you're a
    // real person" / selfie checkpoint) to these long-lived identifiers. Once
    // captured at login they must stay CONSTANT — letting an automation run or a
    // transient HTTP Set-Cookie rotate them makes the account look like it moved
    // to a new device. Allow the first capture, but never overwrite an existing value.
    const DEVICE_PINNED = new Set(["datr", "sb"]);
    const nowSec = Math.floor(Date.now() / 1000);
    let changed = 0;
    for (const fc of freshCookies) {
      if (!fc || !fc.name) continue;
      const prev = byName.get(fc.name);
      if (DEVICE_PINNED.has(fc.name) && prev && prev.value) continue; // pinned device id — never rotate
      const clearing = (fc.value === "" || fc.value == null) && fc.expires && fc.expires < nowSec;
      if (clearing) continue; // never let a transient clear wipe a good cookie
      const merged = { ...(prev || {}), ...fc };
      if (merged.value == null || merged.value === "") continue;
      if (!prev || prev.value !== merged.value || (fc.expires && prev.expires !== fc.expires)) {
        byName.set(fc.name, merged);
        changed++;
      }
    }

    if (changed === 0) return false;

    structures[targetStructId].profiles[profileId].cookies = Array.from(byName.values());
    structures[targetStructId].profiles[profileId].lastCookieRefreshAt = new Date().toISOString();
    await updateData("structures", structures);
    console.log(`${MODULE} Refreshed ${changed} cookie(s) for profile ${profileId}`);
    return true;
  } catch (err) {
    console.warn(`${MODULE} Failed to persist refreshed cookies for ${profileId}: ${err.message}`);
    return false;
  }
}

/**
 * True if the given CDP cookie jar holds a usable Facebook session, i.e. a
 * non-empty `c_user` AND `xs` cookie on a facebook.com domain.
 * @param {Array} cdpCookies - results of `Network.getAllCookies()`
 * @returns {boolean}
 */
function hasValidFbSession(cdpCookies) {
  if (!Array.isArray(cdpCookies)) return false;
  let cUser = false, xs = false;
  for (const c of cdpCookies) {
    if (!c || !c.name || !c.value) continue;
    if (!_isFacebookDomain(c.domain)) continue;
    if (c.name === "c_user") cUser = true;
    else if (c.name === "xs") xs = true;
  }
  return cUser && xs;
}

/**
 * Inject the stored cookie SNAPSHOT into a live CDP browser session ONLY when
 * the on-disk profile is logged out.
 *
 * VCBrowser launches a PERSISTENT user-data-dir whose cookie jar is kept fresh
 * by manual logins, prior automation runs, and Facebook's own cookie rotation —
 * that live jar is almost always NEWER than the stored snapshot. Blindly
 * re-injecting the snapshot every run downgraded a good session back to a stale
 * one, which made profiles repeatedly "log out" (and, after a manual reconnect,
 * get logged out again on the very next run). So we read the live jar first and
 * skip injection when it already holds a valid session; we only bootstrap from
 * the snapshot when the live jar is empty / logged out.
 *
 * @param {object} Network - CDP Network domain
 * @param {Array}  cookies - stored snapshot cookies (storage format)
 * @param {string} [label] - log label (module name)
 * @returns {Promise<boolean>} true if snapshot cookies were injected
 */
async function injectCookiesIfLoggedOut(Network, cookies, label) {
  const tag = label || MODULE;
  try {
    const live = await Network.getAllCookies();
    if (hasValidFbSession(live && live.cookies)) {
      console.log(`${tag} Live profile session is valid — skipping snapshot injection (avoids downgrading the live cookies)`);
      return false;
    }
  } catch (e) {
    console.warn(`${tag} Could not read live cookie jar (${e.message}) — proceeding with snapshot injection`);
  }
  if (!Array.isArray(cookies) || cookies.length === 0) return false;
  for (const c of cookies) {
    if (!c || !c.name) continue;
    const cdpCookie = {
      name: c.name, value: c.value,
      domain: c.domain || ".facebook.com", path: c.path || "/",
      secure: c.secure || false, httpOnly: c.httpOnly || false,
    };
    if (c.sameSite) {
      cdpCookie.sameSite = c.sameSite === "no_restriction" ? "None" :
                           c.sameSite === "lax" ? "Lax" :
                           c.sameSite === "strict" ? "Strict" : undefined;
    }
    if (c.expires) cdpCookie.expires = c.expires;
    try { await Network.setCookie(cdpCookie); } catch (_) {}
  }
  console.log(`${tag} On-disk jar logged out — injected ${cookies.length} snapshot cookies`);
  return true;
}

module.exports = {
  cdpCookiesToStorage,
  parseSetCookies,
  persistFreshCookies,
  hasValidFbSession,
  injectCookiesIfLoggedOut,
};
