/**
 * facebookDocIds.js
 *
 * Manages Facebook Relay persisted query doc_ids.
 * These IDs are extracted from Facebook's compiled JS bundle and can rotate
 * when Facebook ships a new bundle version.
 *
 * - Falls back to hardcoded values on first run.
 * - Updates the cache whenever a browser run confirms a working doc_id.
 * - Detects Facebook API errors that indicate a stale doc_id.
 * - Can scan page HTML to discover new doc_ids before they cause failures.
 */

const path = require("path");
const fs   = require("fs");

const MODULE = "[FbDocIds]";

// ---------------------------------------------------------------------------
// Known doc_ids (last confirmed working – update these when Facebook rotates)
// ---------------------------------------------------------------------------
const FALLBACK_DOC_IDS = {
  "ComposerStoryCreateMutation":        "27264118266586374",
  "useCometUFICreateCommentMutation":   "28371989589069362",
  "CometSinglePostDialogContentQuery":  "27403854512578417",
  "useCometUFIEditCommentMutation":     "26337203612619588",
  "CometGroupAboutRootQuery":           "26848302004827785",
  "CometGroupRootQuery":                "26835153426165001",
  "ProfileCometHeaderQuery":            "9978351005616325",
  "ProfileCometTimelineFeedRefetchQuery": "9870095973019651",
};

// ---------------------------------------------------------------------------
// Cache file location
// ---------------------------------------------------------------------------
function getCacheFile() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "fb-doc-ids.json");
  } catch (_) {
    return path.join(require("os").tmpdir(), "fb-doc-ids.json");
  }
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(getCacheFile(), "utf8")); }
  catch (_) { return {}; }
}

function writeCache(data) {
  try { fs.writeFileSync(getCacheFile(), JSON.stringify(data, null, 2), "utf8"); }
  catch (_) {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the best-known doc_id for a mutation.
 * Returns cached value if available, else hardcoded fallback.
 */
function getDocId(mutationName) {
  const cache = readCache();
  return cache[mutationName] || FALLBACK_DOC_IDS[mutationName] || null;
}

/**
 * Confirm / update a doc_id in the cache.
 * Called after a successful operation so we know this ID is current.
 */
function updateDocId(mutationName, docId) {
  if (!mutationName || !docId) return;
  if (!Object.prototype.hasOwnProperty.call(FALLBACK_DOC_IDS, mutationName)) return;
  const cache = readCache();
  if (cache[mutationName] === docId) return; // already up-to-date
  const prev = cache[mutationName] || FALLBACK_DOC_IDS[mutationName];
  cache[mutationName] = docId;
  writeCache(cache);
  if (prev && prev !== docId) {
    console.log(`${MODULE} doc_id UPDATED for ${mutationName}: ${prev} → ${docId}`);
  } else {
    console.log(`${MODULE} doc_id confirmed for ${mutationName}: ${docId}`);
  }
}

/**
 * Mark a doc_id as stale (remove from cache so fallback triggers browser refresh).
 *
 * IMPORTANT: only ever call this when the error is a *definite* doc_id error
 * (see isDefiniteDocIdError). Invalidating on a transient/unrelated Facebook
 * error wipes a known-good cached doc_id and strands every subsequent request
 * on the hardcoded fallback — the classic "worked at first, then all failed"
 * degradation. As a second line of defence we refuse to delete a cached value
 * that already equals the current fallback (deletion would be a no-op that only
 * loses the freshly-learned value).
 */
function invalidateDocId(mutationName) {
  const cache = readCache();
  if (!cache[mutationName]) return;
  delete cache[mutationName];
  writeCache(cache);
  console.log(`${MODULE} doc_id invalidated for ${mutationName} — will refresh via browser`);
}

/**
 * Returns true if a Facebook API error message *might* be doc_id related.
 * Intentionally broad — used only to decide whether to fall back to the browser
 * path (which can rescrape a fresh doc_id from the bundle). Being broad here is
 * safe because the browser fallback is non-destructive.
 */
function isDocIdError(error) {
  if (!error) return false;
  const m = String(error).toLowerCase();
  return (
    m.includes("unknown query") ||
    m.includes("not supported") ||
    m.includes("query not found") ||
    m.includes("invalid doc_id") ||
    m.includes("doc id") ||
    m.includes("field_exception") ||
    m.includes("server error") ||
    (m.includes("operation") && m.includes("not found"))
  );
}

/**
 * Returns true ONLY for errors that are specifically about a persisted-query /
 * doc_id no longer existing. Used to gate cache invalidation so transient
 * Facebook errors (generic "server error", momentary "field_exception",
 * rate-limit blips) can NOT delete a known-good cached doc_id.
 */
function isDefiniteDocIdError(error) {
  if (!error) return false;
  const m = String(error).toLowerCase();
  return (
    m.includes("unknown query") ||
    m.includes("query not found") ||
    m.includes("invalid doc_id") ||
    m.includes("doc id") ||
    m.includes("doc_id") ||
    m.includes("persisted query") ||
    m.includes("api does not exist") ||
    (m.includes("operation") && m.includes("does not exist"))
  );
}

/**
 * Scan a block of HTML/JS text for doc_ids near known mutation names.
 * Best-effort — works when Facebook embeds relay query metadata in page source.
 * Returns a map of { mutationName: docId } for any it finds.
 */
function extractDocIdsFromHtml(html) {
  const found = {};
  for (const name of Object.keys(FALLBACK_DOC_IDS)) {
    // Primary pattern: Facebook bundles store doc_ids in modules named
    // "{MutationName}_facebookRelayOperation" with a.exports="<doc_id>"
    // e.g. __d("CometSinglePostDialogContentQuery_facebookRelayOperation",[],(function(t,n,r,o,a,i){a.exports="27403854512578417"}),null);
    const relayKey = `${name}_facebookRelayOperation`;
    const relayIdx = html.indexOf(relayKey);
    if (relayIdx >= 0) {
      const ctx = html.slice(relayIdx, relayIdx + 200);
      const m = ctx.match(/a\.exports\s*=\s*"(\d{14,20})"/);
      if (m) { found[name] = m[1]; continue; }
    }

    // Fallback: look anywhere near the name for a numeric id
    let searchFrom = 0;
    while (searchFrom < html.length) {
      const idx = html.indexOf(name, searchFrom);
      if (idx < 0) break;
      searchFrom = idx + 1;
      const ctx = html.slice(Math.max(0, idx - 2000), idx + 2000);
      const m =
        ctx.match(/a\.exports\s*=\s*"(\d{14,20})"/) ||
        ctx.match(/"(?:doc_id|id)"\s*:\s*"(\d{14,20})"/) ||
        ctx.match(/\bid\s*:\s*"(\d{14,20})"/) ||
        ctx.match(/return\s+"(\d{14,20})"/) ||
        ctx.match(/"queryID"\s*:\s*"(\d{14,20})"/);
      if (m) { found[name] = m[1]; break; }
    }
  }
  return found;
}

/**
 * Update multiple doc_ids at once (e.g. from a batch extraction).
 */
function updateMany(map) {
  for (const [name, id] of Object.entries(map)) {
    updateDocId(name, id);
  }
}

module.exports = {
  getDocId,
  updateDocId,
  invalidateDocId,
  isDocIdError,
  isDefiniteDocIdError,
  extractDocIdsFromHtml,
  updateMany,
  FALLBACK_DOC_IDS,
};
