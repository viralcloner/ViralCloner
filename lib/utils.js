const { app, BrowserWindow } = require("electron");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const fss = require("fs");
const { WebSocket } = require("ws");
const CDP = require("chrome-remote-interface");
const path = require("path");
const { once } = require("events");
const fsExtra = require("fs-extra");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const {
  setupBrowserFingerprint,
  applyCDPFingerprint,
  applyChromeIdentityOnSession,
  getConsistentFingerprintForProfile,
  getRealMachineFingerprint,
} = require("./cdpFingerprint");
const { startVCBrowser, isVCBrowserInstalled } = require("./VCBrowserManager");
const { cleanImage, cleanDataUrl } = require("./imageClean");

const dbPath = path.join(app.getPath("userData"), "storage.db");
const db = new Database(dbPath);
db.prepare(
  `CREATE TABLE IF NOT EXISTS storage ( key TEXT PRIMARY KEY, value TEXT )`,
).run();

// Create dedicated table for seen post IDs (much more efficient than JSON blob)
db.prepare(
  `CREATE TABLE IF NOT EXISTS seen_post_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT UNIQUE NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    shares_when_seen INTEGER DEFAULT 0,
    added_to_library INTEGER DEFAULT 0
)`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_seen_post_ids_post_id ON seen_post_ids(post_id)`,
).run();

// Create table for hidden ISE (Image Search Engine) images
db.prepare(
  `CREATE TABLE IF NOT EXISTS hidden_ise_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_hash TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    source TEXT DEFAULT 'unknown',
    hidden_at INTEGER DEFAULT (strftime('%s', 'now'))
)`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_hidden_ise_url_hash ON hidden_ise_images(url_hash)`,
).run();

// Create table for used ISE images (images that have been used in workflows)
db.prepare(
  `CREATE TABLE IF NOT EXISTS used_ise_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_hash TEXT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    source TEXT DEFAULT 'unknown',
    used_at INTEGER DEFAULT (strftime('%s', 'now'))
)`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_used_ise_url_hash ON used_ise_images(url_hash)`,
).run();

// Migration: Add new columns to existing tables if they don't exist
try {
  db.prepare(
    `ALTER TABLE seen_post_ids ADD COLUMN shares_when_seen INTEGER DEFAULT 0`,
  ).run();
  console.log("[DB Migration] Added shares_when_seen column");
} catch (e) {
  // Column likely already exists
}
try {
  db.prepare(
    `ALTER TABLE seen_post_ids ADD COLUMN added_to_library INTEGER DEFAULT 0`,
  ).run();
  console.log("[DB Migration] Added added_to_library column");
} catch (e) {
  // Column likely already exists
}

// Import workflow database for normalized storage
const workflowDb = require("./database");

require("dotenv").config();

// Default Spy WebSocket port helper (env override with SPY_WS_PORT, else 5683)
function getSpyWebSocketPort() {
  const envVal = process.env.SPY_WS_PORT;
  const n = envVal ? parseInt(envVal, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5683;
}

// Lightweight in-memory buffer for spy posts to avoid per-message DB writes
const spyPostsState = {
  list: null, // latest persisted posts - null means not yet loaded from DB
  buffer: [], // incoming posts awaiting flush
  flushTimer: null,
  cap: 300, // keep last N posts
  flushIntervalMs: 2000,
};

function enqueueSpyPost(post) {
  try {
    // Basic shape validation
    if (!post || typeof post !== "object" || !post.postId) return;

    // Initialize list from database on first use (lazy loading)
    if (spyPostsState.list === null) {
      spyPostsState.list = readKey("spyPosts") || [];
      console.log(
        `[enqueueSpyPost] Initialized spyPostsState.list from DB with ${spyPostsState.list.length} existing posts`,
      );
    }

    // Check if post already exists in library - don't show it in spy results
    const postsLibrary = readKey("postsLibrary") || [];
    if (postsLibrary.some((p) => p.postId === post.postId)) {
      console.log(
        `[enqueueSpyPost] Post ${post.postId} already in library, skipping`,
      );
      return;
    }

    // Check if post already exists in current spy posts list
    if (spyPostsState.list.some((p) => p.postId === post.postId)) {
      console.log(
        `[enqueueSpyPost] Post ${post.postId} already in spy posts, skipping`,
      );
      return;
    }

    // Check if post already in buffer (pending flush)
    if (spyPostsState.buffer.some((p) => p.postId === post.postId)) {
      console.log(
        `[enqueueSpyPost] Post ${post.postId} already in buffer, skipping`,
      );
      return;
    }

    // Check for viral growth: if post was seen before but not added to library,
    // and shares increased by configured percentage, show it again with viral growth indicator
    const spySettings = readKey("spySettings") || {};
    const enableViralGrowth = spySettings.enableViralGrowth !== false;
    const viralGrowthThreshold = spySettings.viralGrowthThreshold || 10;
    
    const seenInfo = getSeenPostInfo(post.postId);
    if (seenInfo) {
      // If already added to library, skip completely
      if (seenInfo.added_to_library) {
        console.log(
          `[enqueueSpyPost] Post ${post.postId} was added to library, skipping`,
        );
        return;
      }

      // If viral growth detection is disabled, allow all posts through (don't filter by seen status)
      if (!enableViralGrowth) {
        console.log(
          `[enqueueSpyPost] Post ${post.postId} was seen before but viral growth disabled - allowing through`,
        );
        spyPostsState.buffer.push(post);
        scheduleSpyPostsFlush();
        return;
      }

      const previousShares = seenInfo.shares_when_seen || 0;
      const currentShares = post.shares || 0;

      // Calculate share increase percentage (only if there were previous shares)
      if (previousShares > 0 && currentShares > previousShares) {
        const increasePercent =
          ((currentShares - previousShares) / previousShares) * 100;

        if (increasePercent >= viralGrowthThreshold) {
          // Calculate time since first seen
          const timeSinceSeen = Date.now() - seenInfo.created_at * 1000;
          const hoursSinceSeen = Math.floor(timeSinceSeen / (1000 * 60 * 60));
          const daysSinceSeen = Math.floor(hoursSinceSeen / 24);
          let timeSinceSeenText = "";
          if (daysSinceSeen > 0) {
            timeSinceSeenText = `${daysSinceSeen}d ago`;
          } else if (hoursSinceSeen > 0) {
            timeSinceSeenText = `${hoursSinceSeen}h ago`;
          } else {
            const minutesSinceSeen = Math.floor(timeSinceSeen / (1000 * 60));
            timeSinceSeenText = `${minutesSinceSeen}m ago`;
          }

          console.log(
            `[enqueueSpyPost] VIRAL GROWTH detected for ${post.postId}: ${previousShares} -> ${currentShares} (+${increasePercent.toFixed(1)}%) since ${timeSinceSeenText}`,
          );

          // Attach viral growth info to the post
          post.viralGrowth = {
            previousShares,
            currentShares,
            increasePercent: Math.round(increasePercent),
            shareIncrease: currentShares - previousShares,
            timeSinceSeen: timeSinceSeenText,
          };

          // Update the seen record with new share count
          updateSeenPostShares(post.postId, currentShares);

          // Let the post through to show viral growth
          spyPostsState.buffer.push(post);
          scheduleSpyPostsFlush();
          return;
        }
      }

      // Post was seen but no significant viral growth - skip it
      console.log(
        `[enqueueSpyPost] Post ${post.postId} already seen (${previousShares} shares), no viral growth, skipping`,
      );
      return;
    }

    spyPostsState.buffer.push(post);
    scheduleSpyPostsFlush();
  } catch (e) {
    console.error("[enqueueSpyPost] Error:", e);
  }
}

// Prepared statements for seen post IDs (indexed SQLite table - no cap needed)
const stmtInsertSeenPostId = db.prepare(
  `INSERT OR IGNORE INTO seen_post_ids (post_id, shares_when_seen) VALUES (?, ?)`,
);
const stmtCheckSeenPostId = db.prepare(
  `SELECT 1 FROM seen_post_ids WHERE post_id = ?`,
);
const stmtGetSeenPostInfo = db.prepare(
  `SELECT post_id, shares_when_seen, added_to_library, created_at FROM seen_post_ids WHERE post_id = ?`,
);
const stmtUpdateSeenPostShares = db.prepare(
  `UPDATE seen_post_ids SET shares_when_seen = ? WHERE post_id = ?`,
);
const stmtMarkPostAddedToLibrary = db.prepare(
  `INSERT INTO seen_post_ids (post_id, shares_when_seen, added_to_library) VALUES (?, 0, 1)
   ON CONFLICT(post_id) DO UPDATE SET added_to_library = 1`,
);

function addToSeenPostIds(postIds, sharesMap = {}) {
  try {
    if (!postIds || postIds.length === 0) return;

    // Use a transaction for batch insert/update (much faster)
    const insertMany = db.transaction((ids) => {
      let inserted = 0;
      let updated = 0;
      for (const postId of ids) {
        const shares = sharesMap[postId] || 0;
        const result = stmtInsertSeenPostId.run(postId, shares);
        if (result.changes > 0) {
          inserted++;
        } else if (shares > 0) {
          // Post already exists - update shares if we have new shares data
          // and existing shares_when_seen is 0 (from older data without shares tracking)
          const existing = stmtGetSeenPostInfo.get(postId);
          if (existing && existing.shares_when_seen === 0) {
            stmtUpdateSeenPostShares.run(shares, postId);
            updated++;
          }
        }
      }
      return { inserted, updated };
    });

    const { inserted, updated } = insertMany(postIds);
    if (inserted > 0 || updated > 0) {
      console.log(
        `[addToSeenPostIds] Added ${inserted} new IDs, updated shares for ${updated} existing IDs`,
      );
    }
  } catch (e) {
    console.error("[addToSeenPostIds] Error:", e);
  }
}

// Get seen post info including shares and library status
function getSeenPostInfo(postId) {
  try {
    return stmtGetSeenPostInfo.get(postId) || null;
  } catch (e) {
    console.error("[getSeenPostInfo] Error:", e);
    return null;
  }
}

// Update the shares count for a seen post (when viral growth is detected)
function updateSeenPostShares(postId, newShares) {
  try {
    stmtUpdateSeenPostShares.run(newShares, postId);
  } catch (e) {
    console.error("[updateSeenPostShares] Error:", e);
  }
}

// Mark a post as added to library (won't show again even with viral growth)
function markPostAddedToLibrary(postId) {
  try {
    stmtMarkPostAddedToLibrary.run(postId);
    console.log(
      `[markPostAddedToLibrary] Marked post ${postId} as added to library`,
    );
  } catch (e) {
    console.error("[markPostAddedToLibrary] Error:", e);
  }
}

// ========== ISE (Image Search Engine) Hidden Images Functions ==========

// Simple hash function for URLs (to create a consistent key)
function hashUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// Prepared statements for hidden ISE images
const stmtInsertHiddenIseImage = db.prepare(
  `INSERT OR IGNORE INTO hidden_ise_images (url_hash, url, source) VALUES (?, ?, ?)`,
);
const stmtCheckHiddenIseImage = db.prepare(
  `SELECT 1 FROM hidden_ise_images WHERE url_hash = ?`,
);
const stmtGetAllHiddenIseImages = db.prepare(
  `SELECT url_hash, url, source, hidden_at FROM hidden_ise_images`,
);
const stmtDeleteHiddenIseImage = db.prepare(
  `DELETE FROM hidden_ise_images WHERE url_hash = ?`,
);
const stmtClearAllHiddenIseImages = db.prepare(
  `DELETE FROM hidden_ise_images`,
);

/**
 * Hide an ISE image so it won't appear in future search results
 * @param {string} url - The image URL to hide
 * @param {string} source - Source engine ('google', 'bing', etc.)
 * @returns {boolean} Success
 */
function hideIseImage(url, source = 'unknown') {
  try {
    if (!url) return false;
    const urlHash = hashUrl(url);
    stmtInsertHiddenIseImage.run(urlHash, url, source);
    console.log(`[ISE] Hidden image: ${url.substring(0, 60)}...`);
    return true;
  } catch (e) {
    console.error("[hideIseImage] Error:", e);
    return false;
  }
}

/**
 * Check if an ISE image URL is hidden
 * @param {string} url - The image URL to check
 * @returns {boolean} True if hidden
 */
function isIseImageHidden(url) {
  try {
    if (!url) return false;
    const urlHash = hashUrl(url);
    return !!stmtCheckHiddenIseImage.get(urlHash);
  } catch (e) {
    console.error("[isIseImageHidden] Error:", e);
    return false;
  }
}

/**
 * Get all hidden ISE image URL hashes (for client-side filtering)
 * @returns {Set<string>} Set of URL hashes
 */
function getHiddenIseImageHashes() {
  try {
    const rows = stmtGetAllHiddenIseImages.all();
    return new Set(rows.map(r => r.url_hash));
  } catch (e) {
    console.error("[getHiddenIseImageHashes] Error:", e);
    return new Set();
  }
}

/**
 * Unhide an ISE image
 * @param {string} url - The image URL to unhide
 * @returns {boolean} Success
 */
function unhideIseImage(url) {
  try {
    if (!url) return false;
    const urlHash = hashUrl(url);
    stmtDeleteHiddenIseImage.run(urlHash);
    console.log(`[ISE] Unhidden image: ${url.substring(0, 60)}...`);
    return true;
  } catch (e) {
    console.error("[unhideIseImage] Error:", e);
    return false;
  }
}

/**
 * Clear all hidden ISE images
 * @returns {boolean} Success
 */
function clearHiddenIseImages() {
  try {
    stmtClearAllHiddenIseImages.run();
    console.log("[ISE] Cleared all hidden images");
    return true;
  } catch (e) {
    console.error("[clearHiddenIseImages] Error:", e);
    return false;
  }
}

// Prepared statements for used ISE images
const stmtInsertUsedIseImage = db.prepare(
  `INSERT OR IGNORE INTO used_ise_images (url_hash, url, source) VALUES (?, ?, ?)`,
);
const stmtCheckUsedIseImage = db.prepare(
  `SELECT 1 FROM used_ise_images WHERE url_hash = ?`,
);
const stmtGetAllUsedIseImages = db.prepare(
  `SELECT url_hash, url, source, used_at FROM used_ise_images`,
);
const stmtClearAllUsedIseImages = db.prepare(
  `DELETE FROM used_ise_images`,
);

/**
 * Mark an ISE image as used in a workflow
 * @param {string} url - The image URL
 * @param {string} source - Source engine ('google', 'bing', etc.)
 * @returns {boolean} Success
 */
function markIseImageUsed(url, source = 'unknown') {
  try {
    if (!url) return false;
    const urlHash = hashUrl(url);
    stmtInsertUsedIseImage.run(urlHash, url, source);
    console.log(`[ISE] Marked image as used: ${url.substring(0, 60)}...`);
    return true;
  } catch (e) {
    console.error("[markIseImageUsed] Error:", e);
    return false;
  }
}

/**
 * Check if an ISE image has been used
 * @param {string} url - The image URL to check
 * @returns {boolean} True if used
 */
function isIseImageUsed(url) {
  try {
    if (!url) return false;
    const urlHash = hashUrl(url);
    return !!stmtCheckUsedIseImage.get(urlHash);
  } catch (e) {
    console.error("[isIseImageUsed] Error:", e);
    return false;
  }
}

/**
 * Get all used ISE image URL hashes
 * @returns {Set<string>} Set of URL hashes
 */
function getUsedIseImageHashes() {
  try {
    const rows = stmtGetAllUsedIseImages.all();
    return new Set(rows.map(r => r.url_hash));
  } catch (e) {
    console.error("[getUsedIseImageHashes] Error:", e);
    return new Set();
  }
}

/**
 * Clear all used ISE images history
 * @returns {boolean} Success
 */
function clearUsedIseImages() {
  try {
    stmtClearAllUsedIseImages.run();
    console.log("[ISE] Cleared all used images history");
    return true;
  } catch (e) {
    console.error("[clearUsedIseImages] Error:", e);
    return false;
  }
}

// ========== End ISE Functions ==========

// Check if a post ID has been seen before
function isPostIdSeen(postId) {
  try {
    return !!stmtCheckSeenPostId.get(postId);
  } catch (e) {
    console.error("[isPostIdSeen] Error:", e);
    return false;
  }
}

// Mark a spy post as used in a workflow
function markSpyPostAsUsed(postId, workflowId = null) {
  try {
    if (!postId) {
      console.warn("[markSpyPostAsUsed] No postId provided");
      return false;
    }

    let updated = false;
    const now = new Date().toISOString();

    // Update in spy posts list
    if (spyPostsState.list === null) {
      spyPostsState.list = readKey("spyPosts") || [];
    }

    const spyPostIndex = spyPostsState.list.findIndex(
      (p) => p.postId === postId,
    );
    if (spyPostIndex !== -1) {
      const post = spyPostsState.list[spyPostIndex];
      post.usedAt = now;
      post.usedInWorkflowId = workflowId;
      post.usedCount = (post.usedCount || 0) + 1;
      updateData("spyPosts", spyPostsState.list);
      console.log(
        `[markSpyPostAsUsed] Updated spy post ${postId} (count: ${post.usedCount})`,
      );
      updated = true;
    }

    // Also update in postsLibrary (where posts actually get used from in workflows)
    const postsLibrary = readKey("postsLibrary") || [];
    const libraryPostIndex = postsLibrary.findIndex((p) => p.postId === postId);
    if (libraryPostIndex !== -1) {
      const post = postsLibrary[libraryPostIndex];
      post.usedAt = now;
      post.usedInWorkflowId = workflowId;
      post.usedCount = (post.usedCount || 0) + 1;
      updateData("postsLibrary", postsLibrary);
      console.log(
        `[markSpyPostAsUsed] Updated library post ${postId} (count: ${post.usedCount})`,
      );
      updated = true;
    }

    if (!updated) {
      console.warn(
        `[markSpyPostAsUsed] Post ${postId} not found in spy posts or library`,
      );
    }

    return updated;
  } catch (e) {
    console.error("[markSpyPostAsUsed] Error:", e);
    return false;
  }
}

// Reset used status for a spy post
function resetSpyPostUsedStatus(postId) {
  try {
    if (!postId) return false;

    let updated = false;

    // Reset in spy posts
    if (spyPostsState.list === null) {
      spyPostsState.list = readKey("spyPosts") || [];
    }

    const spyPostIndex = spyPostsState.list.findIndex(
      (p) => p.postId === postId,
    );
    if (spyPostIndex !== -1) {
      const post = spyPostsState.list[spyPostIndex];
      post.usedAt = null;
      post.usedInWorkflowId = null;
      post.usedCount = 0;
      updateData("spyPosts", spyPostsState.list);
      updated = true;
    }

    // Reset in postsLibrary
    const postsLibrary = readKey("postsLibrary") || [];
    const libraryPostIndex = postsLibrary.findIndex((p) => p.postId === postId);
    if (libraryPostIndex !== -1) {
      const post = postsLibrary[libraryPostIndex];
      post.usedAt = null;
      post.usedInWorkflowId = null;
      post.usedCount = 0;
      updateData("postsLibrary", postsLibrary);
      updated = true;
    }

    if (updated) {
      console.log(
        `[resetSpyPostUsedStatus] Reset used status for post ${postId}`,
      );
    }

    return updated;
  } catch (e) {
    console.error("[resetSpyPostUsedStatus] Error:", e);
    return false;
  }
}

// Get spy posts with optional filtering for used posts
function getSpyPostsFiltered(hideUsed = true) {
  try {
    if (spyPostsState.list === null) {
      spyPostsState.list = readKey("spyPosts") || [];
    }

    if (!hideUsed) {
      return spyPostsState.list;
    }

    // Filter out posts that have been used
    return spyPostsState.list.filter((post) => !post.usedAt);
  } catch (e) {
    console.error("[getSpyPostsFiltered] Error:", e);
    return [];
  }
}

function scheduleSpyPostsFlush() {
  if (spyPostsState.flushTimer) return;
  spyPostsState.flushTimer = setTimeout(() => {
    spyPostsState.flushTimer = null;
    try {
      if (spyPostsState.buffer.length === 0) return;

      // Ensure list is initialized from DB (defensive check)
      if (spyPostsState.list === null) {
        spyPostsState.list = readKey("spyPosts") || [];
        console.log(
          `[scheduleSpyPostsFlush] Initialized spyPostsState.list from DB with ${spyPostsState.list.length} existing posts`,
        );
      }

      // Move buffer to local array to minimize lock time
      const batch = spyPostsState.buffer.splice(0, spyPostsState.buffer.length);
      console.log(
        `[scheduleSpyPostsFlush] Flushing ${batch.length} posts to database...`,
      );

      // Track all post IDs in the global seen list with their share counts
      const batchPostIds = batch.map((p) => p.postId).filter(Boolean);
      const sharesMap = {};
      batch.forEach((p) => {
        if (p.postId && p.shares != null) {
          sharesMap[p.postId] = p.shares;
        }
      });
      addToSeenPostIds(batchPostIds, sharesMap);

      // Append all posts - no cap, keep everything permanently
      spyPostsState.list.push(...batch);

      // Single synchronous write for the batch
      updateData("spyPosts", spyPostsState.list);
      console.log(
        `[scheduleSpyPostsFlush] Database updated. Total posts in DB: ${spyPostsState.list.length}`,
      );

      // Verify the write by reading back
      const verifyData = readKey("spyPosts");
      console.log(
        `[scheduleSpyPostsFlush] Verification read: ${verifyData?.length || 0} posts in database`,
      );
    } catch (e) {
      // Log the error instead of swallowing
      console.error(`[scheduleSpyPostsFlush] ERROR during flush:`, e);
    } finally {
      // Re-schedule if there are more items
      if (spyPostsState.buffer.length > 0) {
        scheduleSpyPostsFlush();
      }
    }
  }, spyPostsState.flushIntervalMs);
}

// Global cleanup function for all spy processes
async function terminateAllSpyProcesses() {
  if (!global.spyProcesses || global.spyProcesses.size === 0) {
    console.log("No spy processes to terminate");
    return;
  }

  console.log(`Terminating ${global.spyProcesses.size} spy processes...`);

  // First, try graceful termination
  for (const [pid, processInfo] of global.spyProcesses) {
    if (processInfo.process && !processInfo.process.killed) {
      try {
        console.log(
          `Terminating spy process: ${processInfo.profileName} (PID: ${pid})`,
        );
        processInfo.process.kill("SIGTERM");
      } catch (e) {
        console.error(`Error terminating spy process ${pid}:`, e);
      }
    }
  }

  // Wait 2 seconds for graceful termination
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Force kill any remaining processes
  for (const [pid, processInfo] of global.spyProcesses) {
    if (processInfo.process && !processInfo.process.killed) {
      try {
        console.log(`Force-killing spy process ${pid}`);
        processInfo.process.kill("SIGKILL");
      } catch (e) {
        console.error(`Error force-killing spy process ${pid}:`, e);
      }
    }
  }

  global.spyProcesses.clear();
  console.log("All spy processes terminated");
}

function getDefaultData() {
  return {
    pexelsApi: null,
    googleProfiles: {},
    discordProfiles: {},
    openaiKeys: {},
    openrouterKeys: {},
    googleaiKeys: {},
    anthropicKeys: {},
    chineseaiKeys: {},
    imageUploadKeys: {},
videoUploadKeys: {},
    spyProfiles: {},
    spyPosts: [],
    postsLibrary: [],
    maskTemplates: [],
    automations: [],
    workflows: [],
    structures: {},
    automationSettings: {
      maxConcurrency: 10,
      nodeRetryCount: 3,
      imageUploadMaxConcurrency: 1,
    },
    aiDetectionSettings: {
      imageScoresEnabled: true,
    },
  };
}

async function cleanSingleProfile(profilePath) {
  // Only remove cache and temporary files, preserve session data
  const itemsToRemove = [
    "BrowserMetrics",
    "component_crx_cache",
    "extensions_crx_cache",
    "GraphiteDawnCache",
    "GrShaderCache",
    "ShaderCache",
    "optimization_guide_model_store",
    "Code Cache",
    "GPUCache",
    "Cache",
    "Download Service/Files",
    "Cache_Data",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
  ];
  for (const item of itemsToRemove) {
    const p = path.join(profilePath, item);
    if (await fsExtra.pathExists(p)) await fsExtra.remove(p);
  }
  const filesToRemove = [
    "CrashpadMetrics-active.pma",
    "CrashpadMetrics.pma",
    "Last Browser",
    "Last Version",
  ];
  for (const file of filesToRemove) {
    const p = path.join(profilePath, file);
    if (await fsExtra.pathExists(p)) await fsExtra.remove(p);
  }
}

async function cleanProfileCacheAfterClose(profilePath) {
  try {
    await cleanSingleProfile(profilePath);
    const defaultPath = path.join(profilePath, "Default");
    if (await fsExtra.pathExists(defaultPath)) {
      await cleanSingleProfile(defaultPath);
    }
    console.log(`[Cleanup] Profile cache cleaned after close: ${path.basename(profilePath)}`);
  } catch (err) {
    console.warn(`[Cleanup] Failed to clean profile cache after close:`, err.message);
  }
}

function ensureStorageExists() {
  const defaults = getDefaultData();
  const sel = db.prepare("SELECT value FROM storage WHERE key = ?");
  const ins = db.prepare("INSERT INTO storage (key, value) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) {
      const row = sel.get(k);
      if (!row) ins.run(k, JSON.stringify(v));
    }
  });
  tx();
}

function readKey(key) {
  const row = db.prepare("SELECT value FROM storage WHERE key = ?").get(key);
  if (!row) return undefined;
  return JSON.parse(row.value);
}

// Helper function for reading multiple keys efficiently
function readKeys(keys) {
  if (!Array.isArray(keys)) {
    throw new Error("readKeys expects an array of key names");
  }

  const result = {};
  for (const key of keys) {
    result[key] = readKey(key);
  }
  return result;
}

function updateData(key, value) {
  db.prepare("INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)").run(
    key,
    JSON.stringify(value),
  );
}

// Encryption configuration - uses derived key for better security
const algorithm = "aes-256-gcm";

// Derive encryption key from multiple device-specific factors
function getEncryptionKey() {
  const { machineIdSync } = require("node-machine-id");
  const deviceId = machineIdSync();

  // Combine multiple factors to create device-bound encryption
  const keyComponents = [
    "vC$2026#Enc", // Base component (obfuscated in production)
    deviceId,
    process.platform,
    require("os").hostname(),
    "zP7qR3mK",
  ];

  // Use PBKDF2-like derivation with scrypt
  const combinedSecret = keyComponents.join("|");
  const salt = crypto
    .createHash("sha256")
    .update(deviceId + "vc_salt_2026")
    .digest();
  return crypto.scryptSync(combinedSecret, salt, 32);
}

// Cache the derived key to avoid repeated computation
let _cachedEncryptionKey = null;
function getCachedEncryptionKey() {
  if (!_cachedEncryptionKey) {
    _cachedEncryptionKey = getEncryptionKey();
  }
  return _cachedEncryptionKey;
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = getCachedEncryptionKey();
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(buffer) {
  const key = getCachedEncryptionKey();
  const iv = buffer.slice(0, 16);
  const tag = buffer.slice(16, 32);
  const encryptedText = buffer.slice(32);
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encryptedText),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// Optional migration key for data from older installations. Never commit this value.
const legacyEncryptionPassword = process.env.VIRALCLONER_LEGACY_ENCRYPTION_KEY;
function decryptLegacy(buffer) {
  if (!legacyEncryptionPassword) return null;
  try {
    const key = crypto.scryptSync(legacyEncryptionPassword, "salt", 32);
    const iv = buffer.slice(0, 16);
    const tag = buffer.slice(16, 32);
    const encryptedText = buffer.slice(32);
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(encryptedText),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

// Try new decryption first, fall back to legacy for migration
function decryptWithMigration(buffer) {
  try {
    return decrypt(buffer);
  } catch {
    // Try legacy decryption for old sessions
    const legacyResult = decryptLegacy(buffer);
    if (legacyResult) {
      console.log("[Encryption] Migrated from legacy encryption");
      return legacyResult;
    }
    throw new Error("Decryption failed");
  }
}

// ============================================
// Portable Encryption for Cross-Machine Sharing
// ============================================
// These functions use a static key (not machine-specific) for automation
// export/import so files can be shared between different computers.

const PORTABLE_EXPORT_KEY = "vC#2026@Port4bleExport$K3y!Shar1ng";
const PORTABLE_SALT = "vc_portable_export_salt_2026";

function getPortableKey() {
  return crypto.scryptSync(PORTABLE_EXPORT_KEY, PORTABLE_SALT, 32);
}

function encryptPortable(text) {
  const iv = crypto.randomBytes(16);
  const key = getPortableKey();
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Add a version marker (0x01) at the start to identify portable format
  return Buffer.concat([Buffer.from([0x01]), iv, tag, encrypted]);
}

function decryptPortable(buffer) {
  try {
    // Check for version marker
    if (buffer[0] !== 0x01) {
      return null; // Not a portable-encrypted file
    }
    const key = getPortableKey();
    const iv = buffer.slice(1, 17);
    const tag = buffer.slice(17, 33);
    const encryptedText = buffer.slice(33);
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(encryptedText),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

// Decrypt automation files - tries portable first, then machine-specific, then legacy
function decryptAutomation(buffer) {
  // Try portable decryption first (new cross-machine exports)
  const portableResult = decryptPortable(buffer);
  if (portableResult) {
    console.log("[Encryption] Decrypted using portable key (cross-machine)");
    return portableResult;
  }

  // Try machine-specific decryption (same-machine old exports)
  try {
    const result = decrypt(buffer);
    console.log("[Encryption] Decrypted using machine-specific key");
    return result;
  } catch {
    // Try legacy decryption (very old files)
    const legacyResult = decryptLegacy(buffer);
    if (legacyResult) {
      console.log("[Encryption] Decrypted using legacy key");
      return legacyResult;
    }
  }

  throw new Error(
    "Failed to decrypt automation file. The file may be corrupted or from an incompatible version.",
  );
}

async function downloadFileToUserData(url) {
  const parsedUrl = new URL(url);
  const baseName = path.basename(parsedUrl.pathname);
  const ext = path.extname(baseName) || ".jpg";
  const nameWithoutExt = path.basename(baseName, ext);
  const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fileName = `${nameWithoutExt}_${uniqueSuffix}${ext}`;
  const dirPath = path.join(app.getPath("userData"), "Images");
  const filePath = path.join(dirPath, fileName);
  await fs.mkdir(dirPath, { recursive: true });

  // File logger for diagnosing download issues on remote machines
  const logDir = path.join(app.getPath("userData"), "Logs");
  const logFile = path.join(logDir, "download-debug.log");
  await fs.mkdir(logDir, { recursive: true });
  const dlLog = async (msg) => {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}\n`;
    await fs.appendFile(logFile, line, "utf8").catch(() => {});
    console.log(`[DOWNLOAD] ${msg}`);
  };

  await dlLog(`START url=${url}`);
  await dlLog(`  hostname=${parsedUrl.hostname} fileName=${fileName}`);

  // Quick DNS diagnostic — check if system can resolve the hostname
  try {
    const dns = require("dns");
    await new Promise((res, rej) => {
      dns.lookup(parsedUrl.hostname, (err, addr) => {
        if (err) rej(err); else res(addr);
      });
    }).then(
      (addr) => dlLog(`  SYSTEM_DNS resolved ${parsedUrl.hostname} → ${addr}`),
      (err) => dlLog(`  SYSTEM_DNS FAILED ${parsedUrl.hostname}: ${err.code || err.message}`)
    );
  } catch (e) {
    await dlLog(`  SYSTEM_DNS check error: ${e.message}`);
  }

  // Strategy 1: Use Electron net.fetch (Chromium network stack — better DNS, proxy, redirect handling)
  await dlLog(`  STRATEGY_1 net.fetch starting...`);
  try {
    const { net } = require("electron");
    const response = await net.fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(30000),
    });
    await dlLog(`  STRATEGY_1 response: status=${response.status} redirected=${response.redirected} url=${response.url}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await dlLog(`  STRATEGY_1 body: ${buffer.length} bytes`);
    if (buffer.length < 100) throw new Error(`Response too small: ${buffer.length} bytes`);
    await fs.writeFile(filePath, buffer);
    // Verify file was actually written
    const stat = await fs.stat(filePath);
    await dlLog(`  STRATEGY_1 SUCCESS: file=${fileName} diskSize=${stat.size}`);
    return fileName;
  } catch (electronErr) {
    await dlLog(`  STRATEGY_1 FAILED: ${electronErr.code || ''} ${electronErr.message}`);
  }

  // Strategy 2: Node.js HTTPS with alternative DNS (Google 8.8.8.8 / Cloudflare 1.1.1.1)
  await dlLog(`  STRATEGY_2 Node.js alt-DNS starting...`);
  try {
    // First test alt-DNS resolution
    const { Resolver } = require("dns");
    const testResolver = new Resolver();
    testResolver.setServers(["8.8.8.8", "1.1.1.1"]);
    await new Promise((res, rej) => {
      testResolver.resolve4(parsedUrl.hostname, (err, addrs) => {
        if (err) rej(err); else res(addrs);
      });
    }).then(
      (addrs) => dlLog(`  ALT_DNS resolved ${parsedUrl.hostname} → ${addrs.join(", ")}`),
      (err) => dlLog(`  ALT_DNS FAILED ${parsedUrl.hostname}: ${err.code || err.message}`)
    );

    await _nodeDownloadWithAltDns(url, filePath, parsedUrl);
    // Validate file exists and has content
    const stat = await fs.stat(filePath);
    if (stat.size < 100) {
      await fs.unlink(filePath).catch(() => {});
      throw new Error(`File too small: ${stat.size} bytes`);
    }
    await dlLog(`  STRATEGY_2 SUCCESS: file=${fileName} diskSize=${stat.size}`);
    return fileName;
  } catch (nodeErr) {
    await fs.unlink(filePath).catch(() => {});
    await dlLog(`  STRATEGY_2 FAILED: ${nodeErr.code || ''} ${nodeErr.message}`);
  }

  await dlLog(`  ALL STRATEGIES FAILED for ${parsedUrl.hostname}`);
  throw new Error(`All download strategies failed for ${url}`);
}

function _nodeDownloadWithAltDns(url, filePath, parsedUrl) {
  const downloadHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
    "Referer": parsedUrl.origin + "/",
  };
  const { Resolver } = require("dns");
  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const doRequest = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 5) return settle(reject, new Error("Too many redirects"));
      const reqUrl = new URL(requestUrl);
      const proto = reqUrl.protocol === "https:" ? https : http;
      const options = {
        hostname: reqUrl.hostname,
        port: reqUrl.port,
        path: reqUrl.pathname + reqUrl.search,
        headers: downloadHeaders,
        timeout: 30000,
        lookup: (hostname, opts, callback) => {
          resolver.resolve4(hostname, (err, addresses) => {
            if (err) return callback(err);
            callback(null, addresses[0], 4);
          });
        },
      };
      if (proto === https) {
        options.servername = reqUrl.hostname;
      }
      const req = proto
        .get(options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doRequest(res.headers.location, redirectCount + 1);
          }
          if (res.statusCode !== 200) {
            return settle(reject, new Error(`Download failed: ${res.statusCode}`));
          }
          const fileStream = require("fs").createWriteStream(filePath);
          res.on("error", (err) => {
            fileStream.destroy();
            require("fs").unlink(filePath, () => {});
            settle(reject, err);
          });
          fileStream.on("error", (err) => {
            require("fs").unlink(filePath, () => {});
            settle(reject, err);
          });
          fileStream.on("finish", () => {
            fileStream.close();
            settle(resolve, true);
          });
          res.pipe(fileStream);
        })
        .on("error", (err) => settle(reject, err))
        .on("timeout", () => {
          req.destroy();
          settle(reject, new Error("Download timed out"));
        });
    };
    doRequest(url);
  });
}

async function unlockProfile(profilePath) {
  const singles = [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "SingletonCompactLock",
    "DevToolsActivePort",
  ];
  for (const name of singles) {
    const p = path.join(profilePath, name);
    try {
      await fs.unlink(p);
    } catch {}
  }
}

// More aggressive profile repair for exit code 21 and similar corruption issues
async function repairProfile(profilePath) {
  console.log(`[repairProfile] Starting aggressive repair for: ${profilePath}`);

  // First, unlock the profile
  await unlockProfile(profilePath);

  // Directories to remove that can cause Chrome startup failures
  // NOTE: Do NOT include 'Session Storage', 'blob_storage', or 'Local Storage' here
  // as these contain login/session data that must be preserved
  const corruptibleDirs = [
    "Crashpad",
    "GPUCache",
    "Code Cache",
    "Cache",
    "ShaderCache",
    "GCM Store",
    "BrowserMetrics",
    "optimization_guide_model_store",
    "optimization_guide_prediction_model_downloads",
  ];

  // Files that can cause corruption
  const corruptibleFiles = [
    "Preferences",
    "Secure Preferences",
    "Local State",
    "LOG",
    "LOG.old",
    "lockfile",
    "LOCK",
  ];

  // Remove corruptible directories
  for (const dir of corruptibleDirs) {
    const dirPath = path.join(profilePath, dir);
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      console.log(`[repairProfile] Removed directory: ${dir}`);
    } catch {}

    // Also check in Default subdirectory
    const defaultDirPath = path.join(profilePath, "Default", dir);
    try {
      await fs.rm(defaultDirPath, { recursive: true, force: true });
      console.log(`[repairProfile] Removed Default/${dir}`);
    } catch {}
  }

  // Remove corruptible files
  for (const file of corruptibleFiles) {
    const filePath = path.join(profilePath, file);
    try {
      await fs.unlink(filePath);
      console.log(`[repairProfile] Removed file: ${file}`);
    } catch {}

    // Also check in Default subdirectory
    const defaultFilePath = path.join(profilePath, "Default", file);
    try {
      await fs.unlink(defaultFilePath);
      console.log(`[repairProfile] Removed Default/${file}`);
    } catch {}
  }

  console.log(`[repairProfile] Repair complete for: ${profilePath}`);
}

function pickConsistentLocaleBundle(profileName) {
  const bundles = [
    {
      locale: "en-US",
      tz: "America/New_York",
      acceptLanguage: "en-US,en;q=0.9",
    },
    { locale: "en-GB", tz: "Europe/London", acceptLanguage: "en-GB,en;q=0.9" },
    {
      locale: "fr-FR",
      tz: "Europe/Paris",
      acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
    },
    {
      locale: "de-DE",
      tz: "Europe/Berlin",
      acceptLanguage: "de-DE,de;q=0.9,en;q=0.8",
    },
    {
      locale: "es-ES",
      tz: "Europe/Madrid",
      acceptLanguage: "es-ES,es;q=0.9,en;q=0.8",
    },
    {
      locale: "en-US",
      tz: "America/Los_Angeles",
      acceptLanguage: "en-US,en;q=0.9",
    },
  ];

  // Generate consistent hash from profile name to always pick the same bundle
  let hash = 0;
  for (let i = 0; i < profileName.length; i++) {
    hash = ((hash << 5) - hash + profileName.charCodeAt(i)) & 0x7fffffff;
  }

  return bundles[hash % bundles.length];
}

// Country code to locale bundle mapping
const countryToLocaleMap = {
  // English-speaking
  US: {
    locale: "en-US",
    tz: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
  },
  GB: {
    locale: "en-GB",
    tz: "Europe/London",
    acceptLanguage: "en-GB,en;q=0.9",
  },
  AU: {
    locale: "en-AU",
    tz: "Australia/Sydney",
    acceptLanguage: "en-AU,en;q=0.9",
  },
  CA: {
    locale: "en-CA",
    tz: "America/Toronto",
    acceptLanguage: "en-CA,en;q=0.9",
  },
  NZ: {
    locale: "en-NZ",
    tz: "Pacific/Auckland",
    acceptLanguage: "en-NZ,en;q=0.9",
  },
  IE: {
    locale: "en-IE",
    tz: "Europe/Dublin",
    acceptLanguage: "en-IE,en;q=0.9",
  },
  // French-speaking
  FR: {
    locale: "fr-FR",
    tz: "Europe/Paris",
    acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
  },
  BE: {
    locale: "fr-BE",
    tz: "Europe/Brussels",
    acceptLanguage: "fr-BE,fr;q=0.9,en;q=0.8",
  },
  CH: {
    locale: "fr-CH",
    tz: "Europe/Zurich",
    acceptLanguage: "fr-CH,fr;q=0.9,en;q=0.8",
  },
  // German-speaking
  DE: {
    locale: "de-DE",
    tz: "Europe/Berlin",
    acceptLanguage: "de-DE,de;q=0.9,en;q=0.8",
  },
  AT: {
    locale: "de-AT",
    tz: "Europe/Vienna",
    acceptLanguage: "de-AT,de;q=0.9,en;q=0.8",
  },
  // Spanish-speaking
  ES: {
    locale: "es-ES",
    tz: "Europe/Madrid",
    acceptLanguage: "es-ES,es;q=0.9,en;q=0.8",
  },
  MX: {
    locale: "es-MX",
    tz: "America/Mexico_City",
    acceptLanguage: "es-MX,es;q=0.9,en;q=0.8",
  },
  AR: {
    locale: "es-AR",
    tz: "America/Buenos_Aires",
    acceptLanguage: "es-AR,es;q=0.9,en;q=0.8",
  },
  CO: {
    locale: "es-CO",
    tz: "America/Bogota",
    acceptLanguage: "es-CO,es;q=0.9,en;q=0.8",
  },
  CL: {
    locale: "es-CL",
    tz: "America/Santiago",
    acceptLanguage: "es-CL,es;q=0.9,en;q=0.8",
  },
  // Portuguese-speaking
  PT: {
    locale: "pt-PT",
    tz: "Europe/Lisbon",
    acceptLanguage: "pt-PT,pt;q=0.9,en;q=0.8",
  },
  BR: {
    locale: "pt-BR",
    tz: "America/Sao_Paulo",
    acceptLanguage: "pt-BR,pt;q=0.9,en;q=0.8",
  },
  // Italian
  IT: {
    locale: "it-IT",
    tz: "Europe/Rome",
    acceptLanguage: "it-IT,it;q=0.9,en;q=0.8",
  },
  // Dutch
  NL: {
    locale: "nl-NL",
    tz: "Europe/Amsterdam",
    acceptLanguage: "nl-NL,nl;q=0.9,en;q=0.8",
  },
  // Polish
  PL: {
    locale: "pl-PL",
    tz: "Europe/Warsaw",
    acceptLanguage: "pl-PL,pl;q=0.9,en;q=0.8",
  },
  // Russian
  RU: {
    locale: "ru-RU",
    tz: "Europe/Moscow",
    acceptLanguage: "ru-RU,ru;q=0.9,en;q=0.8",
  },
  // Arabic-speaking
  SA: {
    locale: "ar-SA",
    tz: "Asia/Riyadh",
    acceptLanguage: "ar-SA,ar;q=0.9,en;q=0.8",
  },
  AE: {
    locale: "ar-AE",
    tz: "Asia/Dubai",
    acceptLanguage: "ar-AE,ar;q=0.9,en;q=0.8",
  },
  EG: {
    locale: "ar-EG",
    tz: "Africa/Cairo",
    acceptLanguage: "ar-EG,ar;q=0.9,en;q=0.8",
  },
  MA: {
    locale: "ar-MA",
    tz: "Africa/Casablanca",
    acceptLanguage: "ar-MA,ar;q=0.9,fr;q=0.8,en;q=0.7",
  },
  DZ: {
    locale: "ar-DZ",
    tz: "Africa/Algiers",
    acceptLanguage: "ar-DZ,ar;q=0.9,fr;q=0.8,en;q=0.7",
  },
  TN: {
    locale: "ar-TN",
    tz: "Africa/Tunis",
    acceptLanguage: "ar-TN,ar;q=0.9,fr;q=0.8,en;q=0.7",
  },
  // Asian
  JP: {
    locale: "ja-JP",
    tz: "Asia/Tokyo",
    acceptLanguage: "ja-JP,ja;q=0.9,en;q=0.8",
  },
  KR: {
    locale: "ko-KR",
    tz: "Asia/Seoul",
    acceptLanguage: "ko-KR,ko;q=0.9,en;q=0.8",
  },
  CN: {
    locale: "zh-CN",
    tz: "Asia/Shanghai",
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
  },
  TW: {
    locale: "zh-TW",
    tz: "Asia/Taipei",
    acceptLanguage: "zh-TW,zh;q=0.9,en;q=0.8",
  },
  HK: {
    locale: "zh-HK",
    tz: "Asia/Hong_Kong",
    acceptLanguage: "zh-HK,zh;q=0.9,en;q=0.8",
  },
  SG: {
    locale: "en-SG",
    tz: "Asia/Singapore",
    acceptLanguage: "en-SG,en;q=0.9,zh;q=0.8",
  },
  IN: {
    locale: "en-IN",
    tz: "Asia/Kolkata",
    acceptLanguage: "en-IN,en;q=0.9,hi;q=0.8",
  },
  PH: { locale: "en-PH", tz: "Asia/Manila", acceptLanguage: "en-PH,en;q=0.9" },
  TH: {
    locale: "th-TH",
    tz: "Asia/Bangkok",
    acceptLanguage: "th-TH,th;q=0.9,en;q=0.8",
  },
  VN: {
    locale: "vi-VN",
    tz: "Asia/Ho_Chi_Minh",
    acceptLanguage: "vi-VN,vi;q=0.9,en;q=0.8",
  },
  ID: {
    locale: "id-ID",
    tz: "Asia/Jakarta",
    acceptLanguage: "id-ID,id;q=0.9,en;q=0.8",
  },
  MY: {
    locale: "ms-MY",
    tz: "Asia/Kuala_Lumpur",
    acceptLanguage: "ms-MY,ms;q=0.9,en;q=0.8",
  },
  // Nordic
  SE: {
    locale: "sv-SE",
    tz: "Europe/Stockholm",
    acceptLanguage: "sv-SE,sv;q=0.9,en;q=0.8",
  },
  NO: {
    locale: "nb-NO",
    tz: "Europe/Oslo",
    acceptLanguage: "nb-NO,nb;q=0.9,en;q=0.8",
  },
  DK: {
    locale: "da-DK",
    tz: "Europe/Copenhagen",
    acceptLanguage: "da-DK,da;q=0.9,en;q=0.8",
  },
  FI: {
    locale: "fi-FI",
    tz: "Europe/Helsinki",
    acceptLanguage: "fi-FI,fi;q=0.9,en;q=0.8",
  },
  // Other European
  GR: {
    locale: "el-GR",
    tz: "Europe/Athens",
    acceptLanguage: "el-GR,el;q=0.9,en;q=0.8",
  },
  TR: {
    locale: "tr-TR",
    tz: "Europe/Istanbul",
    acceptLanguage: "tr-TR,tr;q=0.9,en;q=0.8",
  },
  CZ: {
    locale: "cs-CZ",
    tz: "Europe/Prague",
    acceptLanguage: "cs-CZ,cs;q=0.9,en;q=0.8",
  },
  HU: {
    locale: "hu-HU",
    tz: "Europe/Budapest",
    acceptLanguage: "hu-HU,hu;q=0.9,en;q=0.8",
  },
  RO: {
    locale: "ro-RO",
    tz: "Europe/Bucharest",
    acceptLanguage: "ro-RO,ro;q=0.9,en;q=0.8",
  },
  UA: {
    locale: "uk-UA",
    tz: "Europe/Kyiv",
    acceptLanguage: "uk-UA,uk;q=0.9,en;q=0.8",
  },
  // Africa
  ZA: {
    locale: "en-ZA",
    tz: "Africa/Johannesburg",
    acceptLanguage: "en-ZA,en;q=0.9",
  },
  NG: { locale: "en-NG", tz: "Africa/Lagos", acceptLanguage: "en-NG,en;q=0.9" },
  KE: {
    locale: "en-KE",
    tz: "Africa/Nairobi",
    acceptLanguage: "en-KE,en;q=0.9,sw;q=0.8",
  },
  // Middle East
  IL: {
    locale: "he-IL",
    tz: "Asia/Jerusalem",
    acceptLanguage: "he-IL,he;q=0.9,en;q=0.8",
  },
  IR: {
    locale: "fa-IR",
    tz: "Asia/Tehran",
    acceptLanguage: "fa-IR,fa;q=0.9,en;q=0.8",
  },
  PK: {
    locale: "ur-PK",
    tz: "Asia/Karachi",
    acceptLanguage: "ur-PK,ur;q=0.9,en;q=0.8",
  },
};

// Cache for user's country code (fetched once per session)
let cachedUserCountryCode = null;
let countryCodeFetchPromise = null;

async function getUserCountryCode() {
  // Return cached value if available
  if (cachedUserCountryCode) {
    return cachedUserCountryCode;
  }

  // If fetch is in progress, wait for it
  if (countryCodeFetchPromise) {
    return countryCodeFetchPromise;
  }

  // Fetch country code from IP API
  countryCodeFetchPromise = (async () => {
    try {
      const response = await axios.get(
        "http://ip-api.com/json/?fields=countryCode",
        { timeout: 5000 },
      );
      if (response.data && response.data.countryCode) {
        cachedUserCountryCode = response.data.countryCode;
        console.log(`[Locale] Detected user country: ${cachedUserCountryCode}`);
        return cachedUserCountryCode;
      }
    } catch (error) {
      console.warn("[Locale] Failed to fetch country code:", error.message);
    }
    return null;
  })();

  return countryCodeFetchPromise;
}

async function getUserLocaleBundle() {
  // First check if user has set a preferred country/locale
  const preferredCountry = await readKey("browserLanguageCountry");

  if (
    preferredCountry &&
    preferredCountry !== "auto" &&
    countryToLocaleMap[preferredCountry]
  ) {
    console.log(
      `[Locale] Using user-preferred locale for ${preferredCountry}:`,
      countryToLocaleMap[preferredCountry].locale,
    );
    return countryToLocaleMap[preferredCountry];
  }

  // Otherwise, detect from IP
  const countryCode = await getUserCountryCode();

  if (countryCode && countryToLocaleMap[countryCode]) {
    console.log(
      `[Locale] Using locale for country ${countryCode}:`,
      countryToLocaleMap[countryCode].locale,
    );
    return countryToLocaleMap[countryCode];
  }

  // Fallback to en-US if country not found or fetch failed
  console.log("[Locale] Using fallback locale: en-US");
  return {
    locale: "en-US",
    tz: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
  };
}

// Get the list of available countries for the settings UI
function getAvailableLocaleCountries() {
  const countryNames = {
    US: "English (United States)",
    GB: "English (United Kingdom)",
    AU: "English (Australia)",
    CA: "English (Canada)",
    NZ: "English (New Zealand)",
    IE: "English (Ireland)",
    FR: "French (France)",
    BE: "French (Belgium)",
    CH: "French (Switzerland)",
    DE: "German (Germany)",
    AT: "German (Austria)",
    ES: "Spanish (Spain)",
    MX: "Spanish (Mexico)",
    AR: "Spanish (Argentina)",
    CO: "Spanish (Colombia)",
    CL: "Spanish (Chile)",
    PT: "Portuguese (Portugal)",
    BR: "Portuguese (Brazil)",
    IT: "Italian (Italy)",
    NL: "Dutch (Netherlands)",
    PL: "Polish (Poland)",
    RU: "Russian (Russia)",
    SA: "Arabic (Saudi Arabia)",
    AE: "Arabic (UAE)",
    EG: "Arabic (Egypt)",
    MA: "Arabic (Morocco)",
    DZ: "Arabic (Algeria)",
    TN: "Arabic (Tunisia)",
    JP: "Japanese (Japan)",
    KR: "Korean (South Korea)",
    CN: "Chinese (China)",
    TW: "Chinese (Taiwan)",
    HK: "Chinese (Hong Kong)",
    SG: "English (Singapore)",
    IN: "English (India)",
    PH: "English (Philippines)",
    TH: "Thai (Thailand)",
    VN: "Vietnamese (Vietnam)",
    ID: "Indonesian (Indonesia)",
    MY: "Malay (Malaysia)",
    SE: "Swedish (Sweden)",
    NO: "Norwegian (Norway)",
    DK: "Danish (Denmark)",
    FI: "Finnish (Finland)",
    GR: "Greek (Greece)",
    TR: "Turkish (Turkey)",
    CZ: "Czech (Czech Republic)",
    HU: "Hungarian (Hungary)",
    RO: "Romanian (Romania)",
    UA: "Ukrainian (Ukraine)",
    ZA: "English (South Africa)",
    NG: "English (Nigeria)",
    KE: "English (Kenya)",
    IL: "Hebrew (Israel)",
    IR: "Persian (Iran)",
    PK: "Urdu (Pakistan)",
  };

  return Object.keys(countryToLocaleMap)
    .map((code) => ({
      code,
      name: countryNames[code] || code,
      locale: countryToLocaleMap[code].locale,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Cache for stable Chrome version to avoid repeated API calls
let cachedChromeVersion = null;
let cachedChromeVersionTimestamp = 0;
const CHROME_VERSION_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week

async function getStableChromeVersion() {
  // Return cached version if still valid
  if (cachedChromeVersion && (Date.now() - cachedChromeVersionTimestamp < CHROME_VERSION_CACHE_TTL)) {
    return cachedChromeVersion;
  }
  
  try {
    const { data } = await axios.get(
      "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json",
      { timeout: 7000 },
    );
    const full = data.channels.Stable.version;
    const major = String(full).split(".")[0] || "138";
    cachedChromeVersion = { major, full };
    cachedChromeVersionTimestamp = Date.now();
    console.log(`[Chrome Version] Fetched latest stable Chrome version: ${full}`);
    return cachedChromeVersion;
  } catch (err) {
    console.warn(`[Chrome Version] Failed to fetch latest version: ${err.message}, using fallback`);
    // Fallback to VCBrowser version
    return { major: "142", full: "142.0.0.0" };
  }
}

async function applyLocaleToProfile(profilePath, bundle, forceUpdate = false) {
  try {
    const defaultDir = path.join(profilePath, "Default");
    await fs.mkdir(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, "Preferences");
    let prefs = {};
    try {
      prefs = JSON.parse(await fs.readFile(prefsPath, "utf8"));
    } catch {}

    // Set accept languages
    prefs.intl = prefs.intl || {};
    prefs.intl.accept_languages = bundle.acceptLanguage
      .split(",")
      .map((s) => s.split(";")[0])
      .join(",");
    prefs.intl.selected_languages = bundle.acceptLanguage
      .split(",")
      .map((s) => s.split(";")[0])
      .join(",");

    // Force update browser UI language settings
    if (forceUpdate) {
      // Set browser language preferences
      prefs.browser = prefs.browser || {};
      prefs.browser.selected_language = bundle.locale;

      // Set translate settings to use this language
      prefs.translate = prefs.translate || {};
      prefs.translate.target_language = bundle.locale.split("-")[0];

      // Set spellcheck language
      prefs.spellcheck = prefs.spellcheck || {};
      prefs.spellcheck.dictionaries = [bundle.locale];
    }

    await fs.writeFile(prefsPath, JSON.stringify(prefs), "utf8");

    const localStatePath = path.join(profilePath, "Local State");
    let state = {};
    try {
      state = JSON.parse(await fs.readFile(localStatePath, "utf8"));
    } catch {}
    state.intl = state.intl || {};
    state.intl.app_locale = bundle.locale;
    state.intl.selected_languages = bundle.acceptLanguage
      .split(",")
      .map((s) => s.split(";")[0])
      .join(",");

    await fs.writeFile(localStatePath, JSON.stringify(state), "utf8");

    if (forceUpdate) {
      console.log(`[Locale] Force-applied locale ${bundle.locale} to profile`);
    }
  } catch (err) {
    console.error("[Locale] Error applying locale to profile:", err.message);
  }
}

// Global tracking for active test login process (allows cancellation)
let activeTestLoginProcess = null;
let activeTestLoginCancelled = false;

// Cancel any active test login
function cancelTestLogin() {
  activeTestLoginCancelled = true;
  if (activeTestLoginProcess && !activeTestLoginProcess.killed) {
    try {
      activeTestLoginProcess.kill();
      console.log("[TestLogin] Cancelled and killed browser process");
    } catch (e) {
      console.warn("[TestLogin] Error killing process:", e.message);
    }
  }
  activeTestLoginProcess = null;
  return true;
}

async function trackLoginStatus(platform, profileName) {
  // Reset cancellation flag at start
  activeTestLoginCancelled = false;

  let status = "pending";
  let client = null;
  let currentUrl = "";
  let chromeProcess = null;
  let resolveNavigated = null;
  const navigatedPromise = new Promise((resolve) => {
    resolveNavigated = resolve;
  });

  // Helper to close browser gracefully
  const closeBrowser = async (proc, cdpClient) => {
    if (cdpClient) {
      try {
        await cdpClient.close();
      } catch {}
    }
    if (!proc || proc.killed) return;
    return new Promise((resolve) => {
      proc.once("exit", () => {
        // Extra delay to ensure profile lock is released
        setTimeout(resolve, 500);
      });
      try {
        proc.kill();
      } catch {
        resolve();
      }
      // Fallback timeout in case exit event doesn't fire
      setTimeout(resolve, 3000);
    });
  };

  try {
    const spyProfiles = await readKey("spyProfiles");
    const profile = spyProfiles?.[profileName];
    if (!profile) throw new Error("Profile not found");
    const proxyRaw = profile.proxy || {};
    const proxy = {
      ip: proxyRaw.ip?.trim() || "NULL",
      port: proxyRaw.port?.trim() || "NULL",
      username: proxyRaw.username?.trim() || "NULL",
      password: proxyRaw.password?.trim() || "NULL",
    };
    const url =
      platform === "facebook"
        ? "https://facebook.com/me"
        : "https://www.pinterest.com/homefeed/";
    // Check if cancelled before starting browser
    if (activeTestLoginCancelled) {
      return "cancelled";
    }

    // Check if VCBrowser is installed
    if (!isVCBrowserInstalled()) {
      throw new Error(
        "VCBrowser is not installed. Please download it from Settings.",
      );
    }

    // Generate fingerprint for this profile
    const fingerprint = getConsistentFingerprintForProfile(profileName);
    
    // Update to latest Chrome version
    try {
      const latestVersion = await getStableChromeVersion();
      if (fingerprint.userAgent && latestVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${latestVersion.full}`);
      }
    } catch (e) { /* use fallback */ }

    // Use startVCBrowser instead of startBrowser
    const out = await startVCBrowser(
      profileName,
      fingerprint,
      "about:blank", // Start with blank, navigate via CDP
      proxy.ip !== "NULL" ? proxy : null, // Only pass proxy if valid
      true, // headless
      false, // automationMode
    );
    chromeProcess = out.chromeProcess;
    client = out.client; // Use the CDP client from startVCBrowser
    activeTestLoginProcess = chromeProcess; // Store globally for cancellation
    const debuggingPort = out.debuggingPort;

    console.log(
      `[trackLoginStatus] VCBrowser started for ${profileName}, port: ${debuggingPort}`,
    );

    chromeProcess.on("exit", (code) => {
      console.log(`[trackLoginStatus] Browser exited with code: ${code}`);
      if (status === "pending") {
        status = code === 0 ? "loggedout" : "error";
        if (resolveNavigated) {
          resolveNavigated();
          resolveNavigated = null;
        }
      }
    });

    // Check if cancelled
    if (activeTestLoginCancelled) {
      status = "cancelled";
      await closeBrowser(chromeProcess, client);
      return status;
    }

    // Enable CDP domains
    const { Page, Network } = client;
    await Page.enable();
    await Network.enable();

    // Set up navigation event listener
    Page.frameNavigated((params) => {
      const frame = params.frame;
      currentUrl = frame.url || currentUrl;
      console.log(`[trackLoginStatus] Navigated to: ${currentUrl}`);
      if (resolveNavigated) {
        resolveNavigated();
        resolveNavigated = null;
      }

      if (platform === "facebook") {
        if (/https:\/\/www\.facebook\.com\/[^\/]+\/?$/.test(currentUrl)) {
          status = "loggedin";
        } else if (
          currentUrl.includes("login.php") ||
          currentUrl.includes("login/") ||
          currentUrl === "https://www.facebook.com/" ||
          currentUrl.startsWith("https://www.facebook.com/?") ||
          currentUrl.includes("checkpoint")
        ) {
          status = "loggedout";
        }
      } else if (platform === "pinterest") {
        if (
          currentUrl.startsWith("https://www.pinterest.com/homefeed") ||
          currentUrl.startsWith("https://www.pinterest.com/pins/") ||
          currentUrl.includes("/your-profile/")
        ) {
          status = "loggedin";
        } else if (
          currentUrl.includes("/login/") ||
          currentUrl === "https://www.pinterest.com/" ||
          currentUrl.includes("https://www.pinterest.com/?") ||
          currentUrl.includes("session-expired")
        ) {
          status = "loggedout";
        }
      }
    });

    // For Pinterest, also check network requests
    if (platform === "pinterest") {
      Network.requestWillBeSent((params) => {
        if (
          status === "pending" &&
          params.request.url.includes("NewsHubBadgeResource")
        ) {
          status = "loggedin";
        }
      });
    }

    // Navigate to the login check URL
    console.log(`[trackLoginStatus] Navigating to ${url}...`);
    await Page.navigate({ url });

    // Wait for navigation or timeout
    await Promise.race([
      navigatedPromise,
      new Promise((r) => setTimeout(r, 15000)),
    ]);

    // If still pending, wait a bit more for redirects
    if (status === "pending") {
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Final status check
    if (status === "pending") {
      if (platform === "facebook") {
        if (currentUrl) {
          if (/https:\/\/www\.facebook\.com\/[^\/]+\/?$/.test(currentUrl))
            status = "loggedin";
          else if (
            currentUrl.includes("login.php") ||
            currentUrl.includes("login/") ||
            currentUrl === "https://www.facebook.com/" ||
            currentUrl.startsWith("https://www.facebook.com/?") ||
            currentUrl.includes("checkpoint")
          )
            status = "loggedout";
          else status = "error - url: " + currentUrl;
        } else status = "error - no currentUrl";
      }
      if (platform === "pinterest") status = "loggedout";
    }

    console.log(`[trackLoginStatus] Final status: ${status}`);
  } catch (err) {
    console.error(`[trackLoginStatus] Error:`, err);
    status = "error";
  } finally {
    activeTestLoginProcess = null; // Clear global reference
    // Close CDP client and browser
    await closeBrowser(chromeProcess, client);
    console.log(
      `[trackLoginStatus] Browser closed, returning status: ${status}`,
    );
  }
  return status;
}

// NOTE: buildChromeCH and applyChromeIdentityOnSession have been moved to cdpFingerprint.js
// They are imported at the top of this file from './cdpFingerprint'

async function startBrowser(
  profileName,
  url = null,
  proxy = null,
  method = null,
  debuggingPort = null,
  headless = false,
  useFingerprint = true,
  stealthMode = false,
  useRealChrome = false,
) {
  // Unified startup with diagnostics and safe fallback if the first attempt exits immediately

  const version = await getStableChromeVersion();

  // Use user's real locale for Google and OpenAI profile connections, random for others
  let bundle;
  if (method === "google" || method === "openai") {
    bundle = await getUserLocaleBundle();
    console.log(
      `[${profileName}] Using user's real locale for ${method} profile: ${bundle.locale}`,
    );
  } else {
    bundle = pickConsistentLocaleBundle(profileName);
  }

  const profilePath = path.join(
    app.getPath("userData"),
    "profiles",
    profileName,
  );
  await fs.mkdir(profilePath, { recursive: true });
  await unlockProfile(profilePath);

  if (method === "spy") {
    console.log(
      `[${profileName}] Skipping profile cleaning and locale setup for spy mode`,
    );
  } else {
    const firstRunFile = path.join(profilePath, ".first_run");
    const hasExistingData =
      (await fsExtra.pathExists(path.join(profilePath, "Default"))) ||
      (await fsExtra.pathExists(path.join(profilePath, "Local State")));
    const isFirstRun =
      !(await fsExtra.pathExists(firstRunFile)) && !hasExistingData;
    if (isFirstRun) {
      console.log(`[${profileName}] First run detected, cleaning profile...`);
      await cleanSingleProfile(profilePath);
      await fs.writeFile(firstRunFile, "1", "utf8");
    } else {
      console.log(`[${profileName}] Using existing profile data`);
    }
    // Force update locale for Google and OpenAI profiles (they need user's real locale)
    const forceLocaleUpdate = method === "google" || method === "openai";
    await applyLocaleToProfile(profilePath, bundle, forceLocaleUpdate);
  }

  // Prepare extensions (before launch attempt). We'll be able to skip them on fallback if needed.
  console.log(`[${profileName}] Preparing extensions...`);
  const extensionTasks = [];
  if (method === "spy") {
    // Proxy extension only when configured
    if (proxy && proxy.ip && proxy.ip !== "NULL") {
      extensionTasks.push(async () => {
        const proxyExtensionPath = await prepareFreshExtension(
          profileName,
          "proxy",
        );
        await updateProxyBackground(
          proxyExtensionPath,
          proxy,
          url || "about:blank",
        );
        return proxyExtensionPath;
      });
    }
    // Spy extension
    extensionTasks.push(async () => {
      const port = await getSpyWebSocketPortAsync();
      const spyExtensionPath = await prepareFreshSpyExtension(
        profileName,
        port,
      );
      return spyExtensionPath;
    });
  } else {
    // Proxy extension - always load it with the target URL
    extensionTasks.push(async () => {
      const proxyExtensionPath = await prepareFreshExtension(
        profileName,
        "proxy",
      );
      await updateProxyBackground(
        proxyExtensionPath,
        proxy,
        url || "about:blank",
      );
      return proxyExtensionPath;
    });
    // Fingerprint extension - DISABLED: Using CDP-only approach for fingerprint spoofing
    // This avoids extension detection and provides more reliable injection
    // if (useFingerprint) {
    //     extensionTasks.push(async () => {
    //         const fingerprintExtensionPath = await prepareFreshExtension(profileName, "fingerprint");
    //         await updateFingerprintExtension(fingerprintExtensionPath, profileName, version, bundle);
    //         return fingerprintExtensionPath;
    //     });
    // }
  }

  // Track if proxy extension is configured with a real URL AND has an actual proxy configured
  // Only then will the extension handle navigation - otherwise we use CDP Page.navigate
  // When proxy is null/empty, the extension just sets up but doesn't navigate
  const hasRealProxy = proxy && proxy.ip && proxy.ip !== "NULL";
  const proxyExtensionWillNavigate =
    method !== "spy" && url && url !== "about:blank" && hasRealProxy;

  const prepared = await Promise.all(extensionTasks.map((task) => task()));
  async function hasManifest(dir) {
    if (!dir) return false;
    try {
      await fs.access(path.join(dir, "manifest.json"));
      return true;
    } catch {
      return false;
    }
  }
  const extensionsPrepared = (
    await Promise.all(
      prepared.map(async (p) => ((await hasManifest(p)) ? p : null)),
    )
  ).filter(Boolean);
  console.log(
    `[${profileName}] Extensions prepared: ${extensionsPrepared.length} extensions`,
  );

  const norm = (p) => p.replace(/\\/g, "/");

  // Helper to choose VCBrowser path (fallback to system Chrome if needed)
  const resolveChromePath = (attempt) => {
    // Always try VCBrowser first
    const userDataPath = app.getPath("userData");
    const vcBrowserPath = require("./browserPaths").getVCBrowserPath();
    if (fss.existsSync(vcBrowserPath)) return vcBrowserPath;

    // Fallback to system Chrome if VCBrowser not available (shouldn't happen in production)
    if (useRealChrome) return findChromeExe();
    return findChromeExe();
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let chromePath = resolveChromePath(attempt);
    if (!chromePath || !fss.existsSync(chromePath)) {
      lastError = new Error(
        `VCBrowser executable not found on attempt ${attempt}`,
      );
      continue;
    }
    console.log(
      `[${profileName}] Using browser at: ${chromePath} (attempt ${attempt})`,
    );

    // Build args for this attempt
    const args = [
    `--host-resolver-rules=${require("./networkPolicy").browserHostRules}`, 
      `--user-data-dir=${norm(profilePath)}`,
      `--lang=${bundle.locale}`,
      `--accept-lang=${bundle.acceptLanguage}`,
      "--no-default-browser-check",
      "--no-first-run",
      "--password-store=basic",
    ];

    // Windowing: keep spy lightweight (smaller window) to reduce GPU/CPU load
    if (!headless) {
      if (method === "spy") {
        args.push("--window-size=1920,1080");
      } else {
        args.push("--start-maximized");
      }
    } else {
      args.push("--headless=new", "--window-size=1920,1080");
    }

    // Extensions only on first attempt (fallback removes them)
    const useExtensions = attempt === 1 && extensionsPrepared.length > 0;
    if (useExtensions) {
      const extList = extensionsPrepared.map(norm).join(",");
      args.push(`--disable-extensions-except=${extList}`);
      args.push(`--load-extension=${extList}`);
      console.log(
        `[${profileName}] Loading ${extensionsPrepared.length} extensions: ${extensionsPrepared.map((e) => path.basename(e)).join(", ")}`,
      );
    } else {
      if (attempt === 2)
        console.log(`[${profileName}] Fallback without extensions`);
    }

    // GPU safety: for spy, force software rendering to avoid GPU driver crashes
    if (method === "spy") {
      args.push(
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--use-angle=swiftshader",
        "--use-gl=swiftshader",
        "--ignore-gpu-blocklist",
        "--disable-features=VizDisplayCompositor",
        // Relax sandboxes which sometimes cause immediate termination on some setups
        "--no-sandbox",
        "--disable-gpu-sandbox",
      );
      if (attempt === 2)
        console.log(
          `[${profileName}] GPU-safe flags applied (spy mode, fallback attempt)`,
        );
      else console.log(`[${profileName}] GPU-safe flags applied (spy mode)`);
    }

    // GPU safety for OpenAI/ChatGPT headless mode - prevents Chrome crashes
    if (method === "openai" && headless) {
      args.push(
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-software-rasterizer",
        "--no-sandbox",
        "--disable-dev-shm-usage", // Prevents shared memory issues in headless
      );
      console.log(
        `[${profileName}] GPU-safe flags applied (openai headless mode)`,
      );
    }

    // GPU safety for test method in headless mode - prevents Chrome crashes
    if (method === "test" && headless) {
      args.push(
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--disable-software-rasterizer",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu-sandbox",
      );
      console.log(
        `[${profileName}] GPU-safe flags applied (test headless mode)`,
      );
    }

    // Stealth flags (kept optional)
    if (stealthMode) {
      args.push(
        "--disable-blink-features=AutomationControlled",
        "--exclude-switches=enable-automation",
        "--disable-automation",
      );
    }

    // Remote debugging
    const actualPort = debuggingPort || 9000 + Math.floor(Math.random() * 5000);
    args.push(`--remote-debugging-port=${actualPort}`);

    // In stealth mode, navigate via CLI
    if (stealthMode && url && url !== "about:blank") args.push(url);

    console.log(`[${profileName}] Starting Chrome process...`);
    console.log(`[${profileName}] Chrome args:`, args);

    // Pipe stderr to capture crash info
    const chromeProcess = spawn(chromePath, args, {
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });

    // Track process globally
    if (!global.spyProcesses) global.spyProcesses = new Map();
    const browserType =
      method === "spy" ? "Spy Browser" : "Google Sites Browser";
    const processInfo = {
      process: chromeProcess,
      profileName,
      startTime: Date.now(),
      lastMemoryCheck: 0,
      memoryWarnings: 0,
      debuggingPort: actualPort,
      type: browserType,
      method: method || "default",
    };
    global.spyProcesses.set(chromeProcess.pid, processInfo);
    console.log(
      `[${profileName}] Tracking browser process: ${browserType} (PID: ${chromeProcess.pid})`,
    );

    // Crash diagnostics buffer (stderr)
    let stderrBuf = "";
    if (chromeProcess.stderr) {
      chromeProcess.stderr.on("data", (d) => {
        try {
          const s = d.toString();
          // Keep the last ~4KB to avoid memory blowup
          stderrBuf = (stderrBuf + s).slice(-4096);
        } catch {}
      });
    }

    chromeProcess.on("error", (err) => {
      console.error(`[${profileName}] Chrome process error:`, err);
    });
    chromeProcess.on("spawn", () => {
      console.log(`[${profileName}] Chrome process spawned successfully`);
    });
    chromeProcess.on("exit", (code, signal) => {
      console.log(
        `[${profileName}] Chrome process exited with code: ${code}, signal: ${signal || "none"}`,
      );
      if (stderrBuf)
        console.log(`[${profileName}] Chrome stderr (tail):\n${stderrBuf}`);
      if (global.spyProcesses && global.spyProcesses.has(chromeProcess.pid)) {
        global.spyProcesses.delete(chromeProcess.pid);
        console.log(`[${profileName}] Removed from spy process tracking`);
      }
      cleanProfileCacheAfterClose(profilePath).catch(() => {});
    });
    chromeProcess.on("close", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send("stealth-browser-closed", profileName);
    });

    // Early-exit detection: if process dies quickly, attempt fallback
    const earlyExitWindowMs = method === "spy" ? 6000 : 2000;
    const earlyExit = await Promise.race([
      (async () => {
        const r = await once(chromeProcess, "exit");
        return { early: true, r };
      })(),
      new Promise((res) =>
        setTimeout(() => res({ early: false }), earlyExitWindowMs),
      ),
    ]);
    if (earlyExit.early) {
      const exitCode = earlyExit.r && earlyExit.r[0];
      lastError = new Error(
        `Chrome exited too quickly on attempt ${attempt} with code ${exitCode}`,
      );
      console.warn(
        `[${profileName}] Chrome exited early (code: ${exitCode}); ${attempt < 2 ? "retrying with safer defaults" : "no more retries"}`,
      );

      // Exit codes that indicate profile corruption - run aggressive repair
      const corruptionExitCodes = [21, 22, 1];
      if (attempt === 1 && corruptionExitCodes.includes(exitCode)) {
        console.log(
          `[${profileName}] Exit code ${exitCode} indicates profile corruption, running repair...`,
        );
        await repairProfile(profilePath);
      }

      // If first attempt used embedded chrome, we'll retry with system Chrome and no extensions
      continue;
    }

    console.log(`[${profileName}] Waiting for Chrome to initialize...`);
    await new Promise((r) => setTimeout(r, method === "spy" ? 3000 : 5000));
    console.log(`[${profileName}] Chrome initialization wait complete`);

    let client = null;
    let disconnected = false;
    if (actualPort && !stealthMode) {
      console.log(
        `[${profileName}] Connecting to Chrome DevTools on port ${actualPort}...`,
      );
      try {
        client = await connectClient(actualPort, 30, 1000);
        console.log(
          `[${profileName}] Successfully connected to Chrome DevTools`,
        );
      } catch (err) {
        lastError = err;
        console.error(
          `[${profileName}] Failed to connect to Chrome DevTools:`,
          err.message || err,
        );
        try {
          chromeProcess.kill();
        } catch {}
        // Try fallback (next attempt) if available
        continue;
      }

      client.on("disconnect", () => {
        disconnected = true;
      });

      // Store fingerprint reference
      let fingerprint = null;

      // Chrome identity will be built after loading fingerprint
      let chromeIdentity = null;

      if (method !== "spy") {
        // First, load the fingerprint to get user's configured language/timezone
        if (useFingerprint) {
          try {
            console.log(`[${profileName}] Loading fingerprint...`);
            const { getOrCreateFingerprint } = require("./cdpFingerprint");
            fingerprint = await getOrCreateFingerprint(profileName, version);
          } catch (e) {
            console.log(
              `[${profileName}] Could not load fingerprint:`,
              e.message,
            );
          }
        }

        // Extract Chrome version from fingerprint's userAgent (e.g., "Chrome/140.0.0.0")
        // This ensures the CDP identity matches the spoofed fingerprint
        let fpChromeVersion = { major: version.major, full: version.full };
        if (fingerprint?.userAgent) {
          const match = fingerprint.userAgent.match(/Chrome\/([\d.]+)/);
          if (match) {
            fpChromeVersion = {
              major: match[1].split(".")[0],
              full: match[1],
            };
            console.log(
              `[${profileName}] Using fingerprint Chrome version: ${fpChromeVersion.full}`,
            );
          }
        }

        // Build Chrome identity - use fingerprint values if available, otherwise fall back to bundle
        chromeIdentity = {
          major: fpChromeVersion.major,
          full: fpChromeVersion.full,
          locale: fingerprint?.language || bundle.locale,
          tz: fingerprint?.timezone || bundle.tz,
          acceptLanguage:
            fingerprint?.languages?.join(",") || bundle.acceptLanguage,
        };

        console.log(
          `[${profileName}] Using locale: ${chromeIdentity.locale}, timezone: ${chromeIdentity.tz}`,
        );

        // Apply Chrome identity to main session (UA, locale, timezone via CDP)
        try {
          console.log(`[${profileName}] Applying Chrome identity...`);
          await applyChromeIdentityOnSession(client, undefined, chromeIdentity);
          console.log(`[${profileName}] Chrome identity applied`);
        } catch (e) {
          console.log(
            `[${profileName}] Chrome identity application failed:`,
            e.message,
          );
        }

        // Apply CDP-based fingerprint spoofing using the consolidated function
        // This handles EVERYTHING:
        // - Script injection (fingerprint already loaded above)
        // - THE ONLY Target.attachedToTarget handler for child targets
        // - Chrome identity application to child targets
        if (useFingerprint && fingerprint) {
          try {
            console.log(`[${profileName}] Setting up fingerprint spoofing...`);
            // Pass fingerprint directly and Chrome identity for child targets
            const { applyCDPFingerprint } = require("./cdpFingerprint");
            await applyCDPFingerprint(
              client,
              fingerprint,
              undefined,
              chromeIdentity,
            );
            console.log(`[${profileName}] Fingerprint spoofing active`);
          } catch (e) {
            console.log(
              `[${profileName}] Fingerprint setup failed:`,
              e.message,
            );
          }
        }
      } else {
        console.log(`[${profileName}] Skipping Chrome identity for spy mode`);
      }

      // CRITICAL: Set up auto-attach AFTER fingerprint handlers are ready
      // This ensures all handlers are in place before any targets attach
      // Use waitForDebuggerOnStart: true to pause new targets before any JS runs
      try {
        await client.Target.setAutoAttach({
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        });
      } catch {}

      // NOTE: Target.attachedToTarget handler is now ONLY in cdpFingerprint.js
      // It handles: fingerprint injection, Chrome identity, domain enabling, and runIfWaitingForDebugger
      // DO NOT add another handler here - it will cause race conditions and crashes

      // Only navigate via CDP if:
      // 1. We have a URL and not in stealth mode
      // 2. AND the proxy extension is NOT handling navigation (extensions not loaded OR url is about:blank)
      // When proxy extension is loaded with a URL, it handles navigation via handleProxy() -> openGoogleAndCloseOthers()
      const proxyExtensionHandlesNavigation =
        useExtensions && proxyExtensionWillNavigate;

      if (url && !stealthMode && !proxyExtensionHandlesNavigation) {
        console.log(`[${profileName}] Navigating to ${url}...`);
        try {
          await client.Page.enable();
        } catch {}
        try {
          await client.Page.navigate({ url });
        } catch {}
        const pageLoadTimeout = method === "spy" ? 8000 : 15000;
        console.log(
          `[${profileName}] Waiting for page load (${pageLoadTimeout / 1000}s timeout)...`,
        );
        await Promise.race([
          new Promise((res) => client.on("Page.loadEventFired", res)),
          new Promise((res) => setTimeout(res, pageLoadTimeout)),
          new Promise((res) => {
            if (disconnected) res();
          }),
        ]);
        console.log(`[${profileName}] Page navigation completed`);
      } else if (proxyExtensionHandlesNavigation) {
        console.log(
          `[${profileName}] Proxy extension will handle navigation to ${url}`,
        );
        // Wait a bit for the proxy extension to navigate
        const pageLoadTimeout = method === "spy" ? 8000 : 15000;
        await Promise.race([
          new Promise((res) => client.on("Page.loadEventFired", res)),
          new Promise((res) => setTimeout(res, pageLoadTimeout)),
          new Promise((res) => {
            if (disconnected) res();
          }),
        ]);
        console.log(
          `[${profileName}] Page navigation completed (via proxy extension)`,
        );
      }
    }

    console.log(`[${profileName}] Browser startup completed successfully`);
    return { chromeProcess, client, debuggingPort: actualPort };
  }

  // If we get here, both attempts failed
  throw lastError || new Error("Chrome failed to start");
}

// Global state to track pages mode progress per profile (survives restarts)
if (!global.spyPagesState) {
  global.spyPagesState = new Map();
}

async function startSpying(
  profileID,
  proxy = null,
  clearPosts = true,
  filters = {},
) {
  // Extract filter values with defaults
  const minShares = filters.minShares || 0;
  const minLikes = filters.minLikes || 0;
  const minComments = filters.minComments || 0;
  const minVirality = filters.minVirality || 0;
  const scrollSpeed = Math.min(10, Math.max(1, filters.scrollSpeed || 3)); // Clamp between 1-10
  const spyMode = filters.spyMode || "feed"; // 'feed' or 'pages'
  let targetPages = [...(filters.targetPages || [])]; // Array of page URLs to spy on (copy to allow shuffle)
  const maxPostAgeDays = Math.min(30, Math.max(1, filters.maxPostAgeDays || 7)); // Clamp between 1-30 days

  // For pages mode: preserve shuffled order and progress on restart
  let startingPageIndex = 0;
  const existingPagesState = global.spyPagesState.get(profileID);

  if (spyMode === "pages" && targetPages.length > 0) {
    if (
      !clearPosts &&
      existingPagesState &&
      existingPagesState.shuffledPages?.length === targetPages.length
    ) {
      // Restart mode: restore previous shuffled order and continue from where we left off
      targetPages = existingPagesState.shuffledPages;
      startingPageIndex = existingPagesState.currentPageIndex || 0;
      console.log(
        `[startSpying:${profileID}] Restart mode - restoring page order, continuing from page ${startingPageIndex + 1}/${targetPages.length}`,
      );
    } else {
      // Fresh start: shuffle pages and reset progress
      if (targetPages.length > 1) {
        for (let i = targetPages.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [targetPages[i], targetPages[j]] = [targetPages[j], targetPages[i]];
        }
        console.log(
          `[startSpying:${profileID}] Shuffled ${targetPages.length} pages into random order`,
        );
      }
      // Save the shuffled order for potential restarts
      global.spyPagesState.set(profileID, {
        shuffledPages: [...targetPages],
        currentPageIndex: 0,
        pagesCompletedCount: 0,
      });
    }
  }

  console.log(
    `[startSpying:${profileID}] Filters - minShares: ${minShares}, minLikes: ${minLikes}, minComments: ${minComments}, minVirality: ${minVirality}, scrollSpeed: ${scrollSpeed}`,
  );
  console.log(
    `[startSpying:${profileID}] Spy mode: ${spyMode}, Target pages: ${targetPages.length > 0 ? targetPages.join(", ") : "none"}`,
  );

  // Clear previous spy posts only if clearPosts is true (default behavior)
  // When restarting spy (auto-restart), we set clearPosts to false to preserve existing posts
  if (clearPosts) {
    console.log(`[startSpying:${profileID}] Clearing previous spy posts...`);
    spyPostsState.list = [];
    spyPostsState.buffer = [];
    if (spyPostsState.flushTimer) {
      clearTimeout(spyPostsState.flushTimer);
      spyPostsState.flushTimer = null;
    }
    // Also clear from database
    updateData("spyPosts", []);
    console.log(`[startSpying:${profileID}] Previous spy posts cleared`);
  } else {
    console.log(
      `[startSpying:${profileID}] Restart mode - preserving existing spy posts`,
    );
  }

  // Check if VCBrowser is installed
  if (!isVCBrowserInstalled()) {
    throw new Error(
      "VCBrowser is not installed. Please download it from Settings.",
    );
  }

  // Generate fingerprint for this profile
  const fingerprint = getConsistentFingerprintForProfile(profileID);
  
  // Update to latest Chrome version
  try {
    const latestVersion = await getStableChromeVersion();
    if (fingerprint.userAgent && latestVersion?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${latestVersion.full}`);
    }
  } catch (e) { /* use fallback */ }

  // Determine if we have a valid proxy
  const hasValidProxy = proxy && proxy.ip && proxy.ip !== "NULL";

  console.log(
    `[startSpying:${profileID}] Using VCBrowser with fingerprint spoofing`,
  );
  if (hasValidProxy) {
    console.log(
      `[startSpying:${profileID}] Proxy configured: ${proxy.ip}:${proxy.port}`,
    );
  } else {
    console.log(`[startSpying:${profileID}] No proxy configured`);
  }

  // Launch VCBrowser with retry logic
  let browserResult = null;
  let launchAttempts = 0;
  const maxLaunchAttempts = 3;

  while (launchAttempts < maxLaunchAttempts && !browserResult) {
    launchAttempts++;
    console.log(
      `[startSpying:${profileID}] VCBrowser launch attempt ${launchAttempts}/${maxLaunchAttempts}...`,
    );

    try {
      browserResult = await startVCBrowser(
        profileID,
        fingerprint,
        "https://facebook.com",
        hasValidProxy ? proxy : null,
        true, // headless - VCBrowser handles headless properly with extended-parameters
        false, // automationMode
      );
      console.log(
        `[startSpying:${profileID}] VCBrowser launched successfully on attempt ${launchAttempts}`,
      );
    } catch (launchErr) {
      console.warn(
        `[startSpying:${profileID}] VCBrowser launch attempt ${launchAttempts}/${maxLaunchAttempts} failed:`,
        launchErr?.message || launchErr,
      );
      browserResult = null;

      if (launchAttempts >= maxLaunchAttempts) {
        throw new Error(
          `Failed to launch VCBrowser after ${maxLaunchAttempts} attempts: ${launchErr?.message || launchErr}`,
        );
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const chromeProcess = browserResult.chromeProcess;
  const cdpPort = browserResult.debuggingPort;

  // Use the client already connected by startVCBrowser
  let client = browserResult.client;

  // Track process globally for cleanup
  if (!global.spyProcesses) global.spyProcesses = new Map();
  global.spyProcesses.set(chromeProcess.pid, {
    process: chromeProcess,
    profileName: profileID,
    startTime: Date.now(),
    debuggingPort: cdpPort,
    type: "Spy Browser",
    method: "spy",
  });
  console.log(
    `[startSpying:${profileID}] Tracking spy process (PID: ${chromeProcess.pid})`,
  );

  // Clean up tracking when process exits
  chromeProcess.on("exit", () => {
    global.spyProcesses.delete(chromeProcess.pid);
    console.log(
      `[startSpying:${profileID}] Spy process exited (PID: ${chromeProcess.pid})`,
    );
  });

  // Verify CDP connection is working
  try {
    await client.Browser.getVersion();
    console.log(`[startSpying:${profileID}] CDP connection verified`);
  } catch (verifyErr) {
    console.warn(
      `[startSpying:${profileID}] CDP connection verification failed, attempting reconnect...`,
    );
    // Try to reconnect
    client = await connectClient(cdpPort, 30, 1000);
    await client.Browser.getVersion();
    console.log(`[startSpying:${profileID}] CDP reconnection successful`);
  }

  const { Network, Page, Runtime } = client;

  // Set up disconnect handler
  let isDisconnected = false;
  let pageCycleTimeoutId = null; // Declare here so disconnect handler can access it
  let pageNavigationPending = false; // Flag to prevent multiple navigation calls and stop post processing during navigation
  client.on("disconnect", () => {
    console.warn(`[startSpying:${profileID}] CDP client disconnected`);
    isDisconnected = true;
    // Clear page cycle timeout to prevent errors from stale CDP connection
    if (pageCycleTimeoutId) {
      clearTimeout(pageCycleTimeoutId);
      pageCycleTimeoutId = null;
      console.log(
        `[startSpying:${profileID}] Page cycle timeout cleared due to disconnect`,
      );
    }
  });

  await Network.enable();
  await Page.enable();

  // Calculate scroll parameters based on speed index (1-10)
  // Speed 1: Very slow - minBurstDelay: 8000ms, maxBurstDelay: 12000ms
  // Speed 3 (default): minBurstDelay: 3000ms, maxBurstDelay: 6000ms
  // Speed 10: Fast - minBurstDelay: 500ms, maxBurstDelay: 1500ms
  const speedConfig = {
    minBurstDelay: Math.round(8000 - ((scrollSpeed - 1) / 9) * 7500), // 8000ms at speed 1, 500ms at speed 10
    maxBurstDelay: Math.round(12000 - ((scrollSpeed - 1) / 9) * 10500), // 12000ms at speed 1, 1500ms at speed 10
    minBurst: Math.round(150 + ((scrollSpeed - 1) / 9) * 150), // 150px at speed 1, 300px at speed 10
    maxBurst: Math.round(300 + ((scrollSpeed - 1) / 9) * 300), // 300px at speed 1, 600px at speed 10
  };
  console.log(
    `[startSpying:${profileID}] Scroll config for speed ${scrollSpeed}:`,
    speedConfig,
  );

  // Build the injected scroll script
  // In pages mode, don't auto-reload since we cycle through pages instead
  const shouldAutoReload = spyMode !== "pages" || targetPages.length === 0;
  const injectedSource = `(function fastHumanScroll() {
        const minBurst = ${speedConfig.minBurst};
        const maxBurst = ${speedConfig.maxBurst};
        const minBurstDelay = ${speedConfig.minBurstDelay};
        const maxBurstDelay = ${speedConfig.maxBurstDelay};
        const minStep = 1;
        const maxStep = 10;

        function scrollBurst() {
            const totalScroll = Math.floor(Math.random() * (maxBurst - minBurst + 1)) + minBurst;
            let scrolled = 0;

            function step() {
                if (scrolled >= totalScroll) return;
                const stepAmount = Math.floor(Math.random() * (maxStep - minStep + 1)) + minStep;
                window.scrollBy(0, stepAmount);
                scrolled += stepAmount;
                setTimeout(step, 0.5); // 0.5ms between tiny steps
            }

            step();

            const nextDelay = Math.floor(Math.random() * (maxBurstDelay - minBurstDelay + 1)) + minBurstDelay;
            setTimeout(scrollBurst, nextDelay);
        }

        scrollBurst();
    })();
    ${
      shouldAutoReload
        ? `setTimeout(() => {
        window.location.reload();
    }, 180000);`
        : "// Auto-reload disabled for pages mode"
    }`;

  await Page.addScriptToEvaluateOnNewDocument({
    source: injectedSource,
  });

  // Wait for browser to be fully ready
  // Longer wait when using proxy to ensure proxy settings apply
  const waitTime = hasValidProxy ? 3000 : 1000;
  console.log(
    `[startSpying:${profileID}] Waiting ${waitTime}ms for browser to initialize...`,
  );
  await new Promise((resolve) => setTimeout(resolve, waitTime));

  // Check connection before navigation
  if (isDisconnected) {
    throw new Error("CDP connection lost before navigation");
  }

  // Determine the initial URL based on spy mode
  let initialUrl = "https://www.facebook.com";
  let currentPageIndex = startingPageIndex; // Use restored index on restart

  if (spyMode === "pages" && targetPages.length > 0) {
    initialUrl = targetPages[currentPageIndex];
    console.log(
      `[startSpying:${profileID}] Pages mode - starting with page ${currentPageIndex + 1}/${targetPages.length}: ${initialUrl}`,
    );
  }

  // Navigate to Facebook (or specific page) explicitly and wait for load
  console.log(`[startSpying:${profileID}] Navigating to ${initialUrl}...`);

  // Set up load event listener BEFORE navigation
  const loadPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(
        `[startSpying:${profileID}] Navigation timeout - continuing anyway`,
      );
      resolve();
    }, 30000); // 30 second timeout

    Page.loadEventFired(() => {
      clearTimeout(timeout);
      console.log(`[startSpying:${profileID}] Page loaded.`);
      resolve();
    });
  });

  // Navigate with error handling
  try {
    const navResult = await Page.navigate({ url: initialUrl });
    console.log(
      `[startSpying:${profileID}] Navigation started, frameId: ${navResult?.frameId || "unknown"}`,
    );
  } catch (navErr) {
    console.error(
      `[startSpying:${profileID}] Navigation error:`,
      navErr?.message || navErr,
    );
    // Try to reconnect and retry navigation once
    if (
      navErr?.message?.includes("WebSocket") ||
      navErr?.message?.includes("CLOSED")
    ) {
      console.log(`[startSpying:${profileID}] Attempting to reconnect CDP...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const newClient = await connectClient(cdpPort, 10, 1000);
      await newClient.Page.enable();
      await newClient.Page.navigate({ url: initialUrl });
      console.log(
        `[startSpying:${profileID}] Reconnected and navigated successfully`,
      );
    } else {
      throw navErr;
    }
  }

  // Wait for load or timeout
  await loadPromise;

  // For pages mode, set up smart page cycling based on post age and activity
  // Note: pageCycleTimeoutId is declared earlier so disconnect handler can access it
  let lastPostDetectedTime = Date.now();
  // Restore pagesCompletedCount on restart (it equals currentPageIndex since each completed page advances the index)
  let pagesCompletedCount =
    existingPagesState && !clearPosts
      ? existingPagesState.pagesCompletedCount || startingPageIndex
      : 0;
  let spyingFinished = false; // Flag to prevent further cycling after completion
  const MAX_POST_AGE_MS = maxPostAgeDays * 24 * 60 * 60 * 1000; // User-configured max age in milliseconds
  const NO_POSTS_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes timeout for no posts

  // Function to navigate to next page or finish spying
  const navigateToNextPage = async (reason) => {
    // Check if CDP connection is still active
    if (isDisconnected) {
      console.log(
        `[startSpying:${profileID}] Skipping page cycle - CDP disconnected`,
      );
      return;
    }
    if (spyMode !== "pages" || targetPages.length === 0 || spyingFinished)
      return;
    // Prevent multiple simultaneous navigation calls
    if (pageNavigationPending) {
      console.log(
        `[startSpying:${profileID}] Skipping page cycle - navigation already pending`,
      );
      return;
    }
    pageNavigationPending = true;

    pagesCompletedCount++;
    console.log(
      `[startSpying:${profileID}] Page completed (${pagesCompletedCount}/${targetPages.length}) - reason: ${reason}`,
    );

    // Check if all pages have been completed
    if (pagesCompletedCount >= targetPages.length) {
      spyingFinished = true;
      console.log(
        `[startSpying:${profileID}] All ${targetPages.length} pages have been fully scrolled! Spying finished.`,
      );

      // Clear pages state since we're done
      global.spyPagesState.delete(profileID);

      // Send message to frontend that spying is complete
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send("spy-pages-completed", {
          profileId: profileID,
          pagesCount: targetPages.length,
          message: `Finished spying on all ${targetPages.length} pages. Add the posts you want to your library.`,
        });
      }

      // Clear timeout and stop cycling
      if (pageCycleTimeoutId) {
        clearTimeout(pageCycleTimeoutId);
        pageCycleTimeoutId = null;
      }

      // Kill the spy browser process since we're done with all pages
      console.log(
        `[startSpying:${profileID}] Closing spy browser - all pages completed`,
      );
      try {
        if (chromeProcess && !chromeProcess.killed) {
          chromeProcess.kill();
          console.log(
            `[startSpying:${profileID}] Spy browser closed successfully`,
          );
        }
      } catch (killErr) {
        console.warn(
          `[startSpying:${profileID}] Error closing spy browser:`,
          killErr?.message || killErr,
        );
      }

      return;
    }

    // Send progress update to frontend
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send("spy-page-progress", {
        profileId: profileID,
        currentPage: pagesCompletedCount + 1,
        totalPages: targetPages.length,
        currentPageUrl: targetPages[currentPageIndex],
        nextPageUrl: targetPages[(currentPageIndex + 1) % targetPages.length],
      });
    }

    try {
      currentPageIndex = (currentPageIndex + 1) % targetPages.length;
      const nextUrl = targetPages[currentPageIndex];
      console.log(
        `[startSpying:${profileID}] Cycling to page ${currentPageIndex + 1}/${targetPages.length}: ${nextUrl}`,
      );

      // Update global state to preserve progress across restarts
      global.spyPagesState.set(profileID, {
        shuffledPages: [...targetPages],
        currentPageIndex: currentPageIndex,
        pagesCompletedCount: pagesCompletedCount,
      });

      await Page.navigate({ url: nextUrl });

      // Reset tracking for new page
      lastPostDetectedTime = Date.now();

      // Restart the no-posts timeout
      if (pageCycleTimeoutId) clearTimeout(pageCycleTimeoutId);
      pageCycleTimeoutId = setTimeout(() => {
        navigateToNextPage("no posts for 2 minutes");
      }, NO_POSTS_TIMEOUT_MS);

      // Reset navigation pending flag after successful navigation
      pageNavigationPending = false;
    } catch (err) {
      console.error(
        `[startSpying:${profileID}] Page cycle error:`,
        err?.message || err,
      );
      pageNavigationPending = false; // Reset flag on error too
    }
  };

  // Function to check if a post is older than max age and trigger page switch
  const checkPostAgeAndCycle = (postCreatedTime) => {
    if (
      isDisconnected ||
      spyMode !== "pages" ||
      targetPages.length === 0 ||
      spyingFinished ||
      pageNavigationPending
    )
      return false;

    const postAgeMs = Date.now() - postCreatedTime * 1000;
    if (postAgeMs > MAX_POST_AGE_MS) {
      const daysOld = Math.floor(postAgeMs / (24 * 60 * 60 * 1000));
      console.log(
        `[startSpying:${profileID}] Post is older than ${maxPostAgeDays} days (${daysOld} days old), switching to next page`,
      );
      navigateToNextPage(`post older than ${maxPostAgeDays} days`);
      return true;
    }
    return false;
  };

  // Function to reset no-posts timeout when a post is detected
  const resetNoPostsTimeout = () => {
    if (isDisconnected || pageNavigationPending) return; // Don't reset timeout if disconnected or navigating
    lastPostDetectedTime = Date.now();
    if (spyMode === "pages" && targetPages.length > 0 && !spyingFinished) {
      if (pageCycleTimeoutId) clearTimeout(pageCycleTimeoutId);
      pageCycleTimeoutId = setTimeout(() => {
        navigateToNextPage("no posts for 2 minutes");
      }, NO_POSTS_TIMEOUT_MS);
    }
  };

  // Start the initial no-posts timeout for pages mode
  if (spyMode === "pages" && targetPages.length > 0) {
    console.log(
      `[startSpying:${profileID}] Pages mode - will cycle to next page if: no posts for 2 min or posts older than ${maxPostAgeDays} days`,
    );

    // Send initial progress to frontend (using restored or starting page index)
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send("spy-page-progress", {
        profileId: profileID,
        currentPage: pagesCompletedCount + 1, // Use restored pagesCompletedCount
        totalPages: targetPages.length,
        currentPageUrl: targetPages[currentPageIndex],
        nextPageUrl:
          targetPages.length > 1
            ? targetPages[(currentPageIndex + 1) % targetPages.length]
            : null,
      });
    }

    pageCycleTimeoutId = setTimeout(() => {
      navigateToNextPage("no posts for 2 minutes");
    }, NO_POSTS_TIMEOUT_MS);

    // Store timeout for cleanup when browser exits
    chromeProcess.on("exit", () => {
      if (pageCycleTimeoutId) clearTimeout(pageCycleTimeoutId);
      console.log(`[startSpying:${profileID}] Page cycling stopped`);
    });
  }

  if (proxy && proxy.ip && proxy.ip !== "NULL") {
    console.log(
      `[startSpying:${profileID}] Proxy configured: ${proxy.ip}:${proxy.port}`,
    );
  }

  // Track request IDs -> URLs
  const pending = new Map();
  // In-memory cache for page follower counts during this session (keyed by entityID or pageUrl)
  const pageFollowersCache = new Map();
  // In-memory cache for resolved image URLs (keyed by photoUrl) - avoids re-fetching same photo pages
  const imageUrlCache = new Map();
  const IMAGE_URL_CACHE_MAX = 500;

  // Import database for persistent page followers cache
  const workflowDb = require("./database");

  Network.requestWillBeSent((e) => {
    if (e.request && e.request.url.includes("api/graphql")) {
      pending.set(e.requestId, {
        url: e.request.url,
        postData: e.request.postData,
      });
    }
  });

  const scrapedPosts = [];

  // Parse follower count from text like "840 K followers", "1.2M followers", "5 234 followers"
  function parseFollowerCount(text) {
    if (!text) return null;
    // Remove "followers" and trim
    const cleaned = text.replace(/followers?/i, "").trim();
    // Handle different formats: "840 K", "1.2M", "5 234", "840K"
    const match = cleaned.match(/([\d\s,.]+)\s*([KMB])?/i);
    if (!match) return null;

    let num = parseFloat(match[1].replace(/[\s]/g, "").replace(",", "."));
    const suffix = (match[2] || "").toUpperCase();

    if (suffix === "K") num *= 1000;
    else if (suffix === "M") num *= 1000000;
    else if (suffix === "B") num *= 1000000000;

    return Math.round(num);
  }

  // Function to trigger hover on page link and fetch follower count
  async function getPageFollowers(pageUrl, actorId, pageName = null) {
    // Check in-memory cache first (fastest)
    const cacheKey = actorId || pageUrl;
    if (pageFollowersCache.has(cacheKey)) {
      console.log(
        `[startSpying:${profileID}] Followers memory cache hit for ${cacheKey}: ${pageFollowersCache.get(cacheKey)}`,
      );
      return pageFollowersCache.get(cacheKey);
    }

    // Check persistent database cache (expires after 30 days)
    try {
      const dbEntry = workflowDb.getPageFollowers(actorId, pageUrl);
      if (dbEntry) {
        console.log(
          `[startSpying:${profileID}] Followers DB cache hit for ${dbEntry.pageName || pageUrl}: ${dbEntry.followers} (${dbEntry.ageInDays} days old)`,
        );
        // Also store in memory cache for faster subsequent lookups
        if (actorId) pageFollowersCache.set(actorId, dbEntry.followers);
        if (pageUrl) pageFollowersCache.set(pageUrl, dbEntry.followers);
        return dbEntry.followers;
      }
    } catch (dbErr) {
      console.warn(
        `[startSpying:${profileID}] DB cache lookup error:`,
        dbErr?.message,
      );
    }

    // If no actorId, we can't make the API request
    if (!actorId) {
      console.log(
        `[startSpying:${profileID}] No actorId available for ${pageUrl}, skipping followers fetch`,
      );
      return null;
    }

    try {
      // Get current session data for the request
      if (!sessionData) {
        sessionData = await getBrowserSessionData();
      }

      if (!sessionData) {
        console.log(
          `[startSpying:${profileID}] No session data available for followers fetch`,
        );
        return null;
      }

      // Extract required tokens from cookies
      const cookies = sessionData.cookies;
      const fbDtsgMatch = cookies.match(/fb_dtsg=([^;]+)/);
      const userIdMatch = cookies.match(/c_user=(\d+)/);
      const lsdMatch = cookies.match(/lsd=([^;]+)/);

      // Get fb_dtsg from the page if not in cookies (it's usually in a hidden input)
      let fbDtsg = "";
      let lsd = "";

      try {
        const tokenResult = await Runtime.evaluate({
          expression: `(function() {
                        // Try to get fb_dtsg from various sources
                        const dtsgInput = document.querySelector('input[name="fb_dtsg"]');
                        const dtsg = dtsgInput ? dtsgInput.value : '';
                        
                        // Try to get lsd
                        const lsdInput = document.querySelector('input[name="lsd"]');
                        const lsdVal = lsdInput ? lsdInput.value : '';
                        
                        // Also try from require calls in scripts
                        let dtsgFromScript = '';
                        let lsdFromScript = '';
                        const scripts = document.querySelectorAll('script');
                        for (const script of scripts) {
                            const text = script.textContent || '';
                            const dtsgMatch = text.match(/"DTSGInitialData"[^}]*"token":"([^"]+)"/);
                            if (dtsgMatch) dtsgFromScript = dtsgMatch[1];
                            const lsdMatch = text.match(/"LSD"[^}]*"token":"([^"]+)"/);
                            if (lsdMatch) lsdFromScript = lsdMatch[1];
                        }
                        
                        return {
                            fb_dtsg: dtsg || dtsgFromScript,
                            lsd: lsdVal || lsdFromScript
                        };
                    })()`,
          returnByValue: true,
        });

        if (tokenResult.result?.value) {
          fbDtsg = tokenResult.result.value.fb_dtsg;
          lsd = tokenResult.result.value.lsd;
        }
      } catch (e) {
        console.warn(
          `[startSpying:${profileID}] Could not extract tokens from page:`,
          e?.message,
        );
      }

      if (!fbDtsg) {
        console.log(
          `[startSpying:${profileID}] Could not get fb_dtsg token for followers fetch`,
        );
        return null;
      }

      const userId = userIdMatch ? userIdMatch[1] : "";

      // Build the GraphQL request for hovercard data
      const variables = JSON.stringify({
        actionBarRenderLocation: "WWW_COMET_HOVERCARD",
        context: "DEFAULT",
        entityID: actorId,
        scale: 1,
        __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
      });

      const formData = new URLSearchParams();
      formData.append("av", userId);
      formData.append("__user", userId);
      formData.append("__a", "1");
      formData.append("fb_dtsg", fbDtsg);
      formData.append("lsd", lsd);
      formData.append("fb_api_caller_class", "RelayModern");
      formData.append(
        "fb_api_req_friendly_name",
        "CometHovercardQueryRendererQuery",
      );
      formData.append("variables", variables);
      formData.append("doc_id", "25206984255635460"); // CometHovercardQueryRendererQuery doc_id

      // Build proxy agent if proxy is configured
      let httpsAgent = undefined;
      if (proxy && proxy.ip && proxy.ip !== "NULL") {
        const portNum = parseInt(proxy.port, 10) || 80;
        let proxyUrl;
        if (
          proxy.username &&
          proxy.username !== "NULL" &&
          proxy.password &&
          proxy.password !== "NULL"
        ) {
          proxyUrl = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.ip}:${portNum}`;
        } else {
          proxyUrl = `http://${proxy.ip}:${portNum}`;
        }
        httpsAgent = new HttpsProxyAgent(proxyUrl);
      }

      console.log(
        `[startSpying:${profileID}] Fetching followers for actor ${actorId}...`,
      );

      const response = await axios.post(
        "https://www.facebook.com/api/graphql/",
        formData.toString(),
        {
          headers: {
            accept: "*/*",
            "accept-language": "en-GB,en;q=0.9",
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://www.facebook.com",
            referer: "https://www.facebook.com/",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            cookie: sessionData.cookies,
            "user-agent": sessionData.userAgent,
            "x-fb-friendly-name": "CometHovercardQueryRendererQuery",
          },
          timeout: 5000,
          proxy: false,
          httpsAgent: httpsAgent,
        },
      );

      // Parse the response to extract follower count
      const responseText =
        typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data);
      const lines = responseText.split("\n");

      for (const line of lines) {
        try {
          const lineJSON = JSON.parse(line);
          const hovercardData =
            lineJSON?.data?.node?.comet_hovercard_renderer?.user;
          if (hovercardData) {
            const timelineItems =
              hovercardData.timeline_context_items?.nodes || [];
            // Find the followers item (usually contains "followers" text)
            for (const item of timelineItems) {
              const titleText = item?.title?.text || "";
              if (titleText.toLowerCase().includes("follower")) {
                const followers = parseFollowerCount(titleText);
                if (followers !== null) {
                  // Cache the result in memory
                  pageFollowersCache.set(actorId, followers);
                  if (pageUrl) pageFollowersCache.set(pageUrl, followers);

                  // Save to persistent database cache
                  try {
                    workflowDb.savePageFollowers(
                      actorId,
                      pageUrl,
                      pageName,
                      followers,
                    );
                    console.log(
                      `[startSpying:${profileID}] Saved to DB cache: ${pageName || pageUrl} = ${followers} followers`,
                    );
                  } catch (dbErr) {
                    console.warn(
                      `[startSpying:${profileID}] Failed to save to DB cache:`,
                      dbErr?.message,
                    );
                  }

                  console.log(
                    `[startSpying:${profileID}] Got followers for ${pageUrl}: ${followers}`,
                  );
                  return followers;
                }
              }
            }
          }
        } catch (e) {
          // Continue to next line
        }
      }

      // Log failed response to file for debugging
      console.log(
        `[startSpying:${profileID}] Could not extract followers from API response for ${pageUrl}`,
      );
      try {
        const debugDir = path.join(app.getPath("userData"), "debug");
        await fs.mkdir(debugDir, { recursive: true });
        const logFile = path.join(debugDir, "graphql_logs.txt");
        const timestamp = new Date().toISOString();
        const logEntry = `\n${"=".repeat(80)}\n[${timestamp}] Failed to extract followers for: ${pageUrl}\nActor ID: ${actorId}\n${"=".repeat(80)}\nResponse:\n${responseText}\n`;
        await fs.appendFile(logFile, logEntry, "utf8");
        console.log(
          `[startSpying:${profileID}] Saved failed response to ${logFile}`,
        );
      } catch (logErr) {
        console.error(
          `[startSpying:${profileID}] Failed to save debug log:`,
          logErr?.message,
        );
      }
      return null;
    } catch (err) {
      console.error(
        `[startSpying:${profileID}] Error getting page followers:`,
        err?.message || err,
      );
      return null;
    }
  }

  // Function to get browser cookies and user agent
  async function getBrowserSessionData() {
    try {
      // Get cookies for facebook.com domain
      const cookiesResult = await Network.getCookies({
        urls: ["https://www.facebook.com", "https://facebook.com"],
      });

      // Format cookies as string
      const cookieString = cookiesResult.cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");

      // Get user agent
      const userAgentResult = await Runtime.evaluate({
        expression: "navigator.userAgent",
      });

      return {
        cookies: cookieString,
        userAgent: userAgentResult.result.value,
      };
    } catch (error) {
      console.error("Error getting browser session data:", error);
      return null;
    }
  }

  // Function to extract full image URL from photo page
  async function getFullImageUrl(photoUrl, sessionData) {
    if (!sessionData) {
      console.warn("No session data available, using fallback");
      return photoUrl;
    }

    // Check image URL cache first
    if (imageUrlCache.has(photoUrl)) {
      return imageUrlCache.get(photoUrl);
    }

    try {
      // Extract the photo ID from the URL to build the proper photo page URL
      const photoIdMatch = photoUrl.match(/fbid=(\d+)/);
      let targetUrl = photoUrl;

      if (photoIdMatch) {
        // Build the proper Facebook photo page URL
        targetUrl = `https://www.facebook.com/photo?fbid=${photoIdMatch[1]}`;
      }

      // Build optional axios proxy configuration using the same proxy passed to startSpying
      // Use HttpsProxyAgent for HTTPS URLs through HTTP proxy (required for CONNECT tunneling)
      let httpsAgent = undefined;
      let axiosProxyConfig = false; // false disables axios built-in proxy
      if (proxy && proxy.ip && proxy.ip !== "NULL") {
        const portNum = parseInt(proxy.port, 10) || 80;
        let proxyUrl;
        if (
          proxy.username &&
          proxy.username !== "NULL" &&
          proxy.password &&
          proxy.password !== "NULL"
        ) {
          proxyUrl = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.ip}:${portNum}`;
        } else {
          proxyUrl = `http://${proxy.ip}:${portNum}`;
        }
        httpsAgent = new HttpsProxyAgent(proxyUrl);
        console.log(
          `[startSpying:${profileID}] Using HTTPS proxy agent for image fetch: ${proxy.ip}:${portNum}`,
        );
      }

      const response = await axios.get(targetUrl, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "accept-language": "fr-FR,fr;q=0.9",
          "cache-control": "max-age=0",
          dpr: "1.25",
          priority: "u=0, i",
          "sec-ch-prefers-color-scheme": "light",
          "sec-ch-ua": '"Not_A Brand";v="99", "Chromium";v="142"',
          "sec-ch-ua-full-version-list":
            '"Not_A Brand";v="99.0.0.0", "Chromium";v="142.0.7404.0"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-model": '""',
          "sec-ch-ua-platform": '"Windows"',
          "sec-ch-ua-platform-version": '"10.0.0"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "upgrade-insecure-requests": "1",
          "viewport-width": "1536",
          cookie: sessionData.cookies,
          "user-agent": sessionData.userAgent,
          referer: "https://www.facebook.com/",
        },
        timeout: 10000,
        proxy: axiosProxyConfig,
        httpsAgent: httpsAgent,
      });

      const html = response.data;

      // Try multiple regex patterns to find the full image URL
      const patterns = [
        // Pattern 1: preload with specific preloader
        /<link rel="preload" href="([^"]*)" as="image" data-preloader="adp_CometPhotoRootContentQueryRelayPreloader_/,
        // Pattern 2: generic preload image
        /<link rel="preload" as="image" href="([^"]*)"/,
        // Pattern 3: og:image meta tag (often has full resolution)
        /<meta property="og:image" content="([^"]*)"/,
        // Pattern 4: data-src in image tags
        /data-src="(https:\/\/scontent[^"]*\.jpg[^"]*)"/,
        // Pattern 5: high resolution in JSON data
        /"url":"(https:\\\/\\\/scontent[^"]*\.jpg[^"]*)"/,
        // Pattern 6: image in background-image style
        /background-image:\s*url\(&quot;(https:\/\/scontent[^&]*\.jpg[^&]*)&quot;\)/,
      ];

      for (const regex of patterns) {
        const match = html.match(regex);
        if (match && match[1]) {
          let fullImageUrl = match[1]
            .replace(/&amp;/g, "&")
            .replace(/\\u0025/g, "%")
            .replace(/\\\//g, "/");

          // Verify it's a valid image URL
          if (
            fullImageUrl.includes("scontent") &&
            (fullImageUrl.includes(".jpg") || fullImageUrl.includes(".png"))
          ) {
            // Cache the result
            imageUrlCache.set(photoUrl, fullImageUrl);
            if (imageUrlCache.size > IMAGE_URL_CACHE_MAX) {
              const firstKey = imageUrlCache.keys().next().value;
              imageUrlCache.delete(firstKey);
            }
            return fullImageUrl;
          }
        }
      }

      // If no full resolution found, return original - this is normal for some posts
      return photoUrl;
    } catch (error) {
      // Don't log error for common cases, just return fallback
      return photoUrl;
    }
  }

  // Wait for page to load and get session data
  let sessionData = null;
  Page.loadEventFired(async () => {
    console.log("Page loaded, getting session data...");
    // Wait a bit for cookies to be set
    await new Promise((resolve) => setTimeout(resolve, 2000));
    sessionData = await getBrowserSessionData();
    if (sessionData) {
      console.log("Session data retrieved successfully");
    }
  });

  // Wait until loading finished, THEN fetch the body
  Network.loadingFinished(async ({ requestId }) => {
    const requestInfo = pending.get(requestId);
    if (!requestInfo) return;

    const { url, postData } = requestInfo;
    console.log(url);

    // If we don't have session data yet, try to get it now
    if (!sessionData) {
      sessionData = await getBrowserSessionData();
    }

    try {
      const body = await Network.getResponseBody({ requestId });
      const lines = body.body.split("\n");

      for (const line of lines) {
        try {
          const lineJSON = JSON.parse(line);

          if (lineJSON) {
            // Handle multiple Facebook JSON formats
            let postsToProcess = [];

            // Format 1: Streaming format with label "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed"
            if (
              lineJSON["label"] &&
              lineJSON["label"] ==
                "CometNewsFeed_viewerConnection$stream$CometNewsFeed_viewer_news_feed"
            ) {
              const data = lineJSON.data?.node;
              if (data && data.attachments && data.attachments[0]) {
                postsToProcess.push(data);
              }
            }
            // Format 2: Direct viewer.news_feed.edges format (data.viewer.news_feed.edges[].node)
            else if (lineJSON.data?.viewer?.news_feed?.edges) {
              const edges = lineJSON.data.viewer.news_feed.edges;
              for (const edge of edges) {
                const data = edge.node;
                if (data && data.attachments && data.attachments[0]) {
                  postsToProcess.push(data);
                }
              }
            }
            // Format 3: Page timeline format (ProfileCometTimelineFeedRefetchQuery)
            // Structure: data.node.timeline_list_feed_units.edges[].node
            else if (lineJSON.data?.node?.timeline_list_feed_units?.edges) {
              console.log(
                `[startSpying:${profileID}] Found page timeline format with ${lineJSON.data.node.timeline_list_feed_units.edges.length} edges`,
              );
              const edges = lineJSON.data.node.timeline_list_feed_units.edges;
              for (const edge of edges) {
                const data = edge.node;
                if (data && data.attachments && data.attachments[0]) {
                  postsToProcess.push(data);
                }
              }
            }
            // Format 4: Page timeline streaming format (similar to Format 1 but for pages)
            // Structure: label contains "ProfileCometTimeline" and data.node contains post
            else if (
              lineJSON["label"] &&
              lineJSON["label"].includes("ProfileCometTimeline") &&
              lineJSON.data?.node?.attachments
            ) {
              console.log(
                `[startSpying:${profileID}] Found page timeline streaming format`,
              );
              const data = lineJSON.data.node;
              if (data && data.attachments && data.attachments[0]) {
                postsToProcess.push(data);
              }
            } else {
              /* Log to a file */
              try {
                const debugDir = path.join(app.getPath("userData"), "debug");
                await fs.mkdir(debugDir, { recursive: true });
                const debugFile = path.join(
                  debugDir,
                  "facebook_responses.jsonl",
                );
                const line = JSON.stringify(lineJSON) + "\n";

                if (line.includes("reaction_count")) {
                  await fs.appendFile(debugFile, line, "utf8");
                  console.error("[DEBUG] Invalid lineJSON");
                }
              } catch (debugErr) {
                console.error("[DEBUG] Failed to save lineJSON:", debugErr);
              }
            }

            // Process all found posts — parallel batch processing for speed
            // Phase 1: Synchronous pre-filtering (fast, no network calls)
            const filteredPosts = [];
            const spySettings = readKey("spySettings") || {};
            const enableViralGrowth = spySettings.enableViralGrowth !== false;
            const postsLibrary = readKey("postsLibrary") || [];

            for (const data of postsToProcess) {
              if (!data || !data.attachments || !data.attachments[0]) continue;
              if (scrapedPosts.includes(data.post_id)) continue;
              if (enableViralGrowth && isPostIdSeen(data.post_id)) continue;

              scrapedPosts.push(data.post_id);

              // Extract image paths (synchronous)
              let photoUrl = data.attachments[0]?.styles?.attachment?.media?.url;
              let directImageUri = data.attachments[0]?.styles?.attachment?.media?.photo_image?.uri;

              if (!photoUrl && !directImageUri) {
                const subattachments = data.attachments[0]?.styles?.attachment?.all_subattachments?.nodes;
                if (subattachments && subattachments.length > 0) {
                  photoUrl = subattachments[0]?.media?.image?.uri || subattachments[0]?.media?.viewer_image?.uri;
                }
              }
              if (!photoUrl && !directImageUri) {
                photoUrl = data.attachments[0]?.media?.image?.uri || data.attachments[0]?.media?.viewer_image?.uri;
              }
              if (!photoUrl && !directImageUri) continue;

              // Extract metrics (synchronous)
              const feedbackData = data.comet_sections?.feedback?.story?.story_ufi_container?.story
                ?.feedback_context?.feedback_target_with_context
                ?.comet_ufi_summary_and_actions_renderer?.feedback;
              const reactions = feedbackData?.reaction_count?.count || 0;
              const shares = feedbackData?.share_count?.count || 0;
              const comments = feedbackData?.comments_count_summary_renderer?.feedback
                ?.comment_rendering_instance?.comments?.total_count || 0;

              // Filter by metrics
              if (shares < minShares || reactions < minLikes || comments < minComments) continue;

              // Check library/spy dedup
              if (postsLibrary.some((p) => p.postId === data.post_id)) continue;
              if (spyPostsState.list && spyPostsState.list.some((p) => p.postId === data.post_id)) continue;

              console.log(
                `[startSpying:${profileID}] Post ${data.post_id} PASSED filters - shares: ${shares}, reactions: ${reactions}, comments: ${comments}`,
              );

              filteredPosts.push({ data, photoUrl, directImageUri, reactions, shares, comments });
            }

            // Phase 2: Parallel async enrichment (image fetch + follower fetch) in batches of 5
            const BATCH_SIZE = 5;
            for (let i = 0; i < filteredPosts.length; i += BATCH_SIZE) {
              const batch = filteredPosts.slice(i, i + BATCH_SIZE);

              const batchResults = await Promise.allSettled(
                batch.map(async ({ data, photoUrl, directImageUri, reactions, shares, comments }) => {
                  const timestamp = Math.floor(Date.now() / 1000);
                  const actorId = data.actors?.[0]?.id || null;
                  const skipFollowerFetch = minVirality > 0 && shares < 20;

                  // Launch image fetch and follower fetch in parallel
                  const imagePromise = (async () => {
                    if (directImageUri) return directImageUri;
                    if (photoUrl) return await getFullImageUrl(photoUrl, sessionData);
                    return null;
                  })();

                  const followerPromise = (async () => {
                    if (skipFollowerFetch) return null;
                    const pageUrl = data.actors?.[0]?.url || "";
                    if (!pageUrl && !actorId) return null;
                    try {
                      let followers = actorId ? pageFollowersCache.get(actorId) : null;
                      if (!followers && pageUrl) followers = pageFollowersCache.get(pageUrl);
                      if (!followers) followers = await getPageFollowers(pageUrl, actorId, data.actors?.[0]?.name);
                      return followers;
                    } catch (e) {
                      console.warn(`[startSpying:${profileID}] Could not get followers: ${e?.message}`);
                      return null;
                    }
                  })();

                  const [fullImage, followers] = await Promise.all([imagePromise, followerPromise]);

                  if (!fullImage) return null; // Skip posts with no image

                  // Extract creation_time
                  const creationTimePath1 = data.comet_sections?.context_layout?.story?.comet_sections?.metadata?.[0]?.story?.creation_time;
                  const creationTimePath2 = data.comet_sections?.timestamp?.story?.creation_time;
                  const creationTimePath3 = data.creation_time;
                  const extractedCreationTime = creationTimePath1 || creationTimePath2 || creationTimePath3;

                  const postData = {
                    type: "facebook",
                    spyProfileId: profileID,
                    postId: data.post_id,
                    postMessage: data.comet_sections?.content?.story?.comet_sections?.message?.story?.message?.text || "",
                    postImg: fullImage,
                    postUrl: photoUrl || fullImage,
                    reactions,
                    shares,
                    comments,
                    createdTime: extractedCreationTime || timestamp,
                    now: timestamp,
                    page: {
                      url: data.actors?.[0]?.url || "",
                      name: data.actors?.[0]?.name || "",
                      image: data.comet_sections?.context_layout?.story?.comet_sections?.actor_photo?.story?.actors?.[0]?.profile_picture?.uri || "",
                      followers: followers || null,
                    },
                  };

                  // Calculate virality score
                  if (postData.page.followers > 0 && postData.shares > 0) {
                    const nowTs = Math.floor(Date.now() / 1000);
                    const ageInSeconds = Math.max(43200, nowTs - postData.createdTime);
                    const ageInDays = ageInSeconds / 86400;
                    const sharesPerDay = postData.shares / ageInDays;
                    postData.viralityScore = Math.round((sharesPerDay / postData.page.followers) * 10000);
                  } else {
                    postData.viralityScore = null;
                  }

                  // Apply virality filter
                  if (minVirality > 0) {
                    if (postData.shares < 20) return null;
                    if (postData.viralityScore === null) return null;
                    if (postData.viralityScore < minVirality) return null;
                  }

                  return postData;
                }),
              );

              // Phase 3: Enqueue results sequentially (maintains order for pages-mode age checks)
              for (const result of batchResults) {
                if (result.status !== "fulfilled" || !result.value) continue;
                const postData = result.value;

                // For pages mode: check post age and trigger page switch if needed
                if (spyMode === "pages" && targetPages.length > 0 && !pageNavigationPending) {
                  if (checkPostAgeAndCycle(postData.createdTime)) {
                    break;
                  }
                }

                console.log(
                  `[startSpying:${profileID}] Enqueueing post ${postData.postId} with image ${postData.postImg?.substring(0, 80)}...`,
                );
                enqueueSpyPost(postData);
                console.log(`Post scraped and sent to frontend : ${postData.shares}`);
                resetNoPostsTimeout();
              }

              // If page navigation was triggered during enqueue, stop processing more batches
              if (pageNavigationPending) break;
            }
          }
        } catch (err) {
          console.log(err);
        }
      }
    } catch (err) {
      // Chrome may drop the body (redirect, no content, cached, etc.)
      console.warn("No body available for", url, err.message);
    } finally {
      pending.delete(requestId);
    }
  });

  // Return process and port information for tracking
  return { chromeProcess, debuggingPort: cdpPort };
}

async function startSpyBrowser(
  profileName,
  url = null,
  proxy = null,
  debuggingPort = null,
  headless = false,
) {
  console.log(`[${profileName}] STEP 1: Starting spy browser (simple mode)...`);

  // Resolve VCBrowser path
  const userDataPath = app.getPath("userData");
  console.log(
    `[${profileName}] STEP 2: User data path resolved: ${userDataPath}`,
  );

  let chromePath = require("./browserPaths").getVCBrowserPath();
  console.log(
    `[${profileName}] STEP 3: VCBrowser path resolved: ${chromePath}`,
  );

  if (!chromePath || !fss.existsSync(chromePath)) {
    console.error(
      `[${profileName}] STEP 3b: VCBrowser executable not found at ${chromePath}`,
    );
    throw new Error(`VCBrowser executable not found`);
  }
  console.log(`[${profileName}] STEP 3c: VCBrowser executable found.`);

  // Profile setup
  const profilePath = path.join(
    app.getPath("userData"),
    "profiles",
    profileName,
  );
  console.log(`[${profileName}] STEP 4: Profile path resolved: ${profilePath}`);

  await fs.mkdir(profilePath, { recursive: true });
  console.log(`[${profileName}] STEP 5: Profile directory ensured.`);

  await unlockProfile(profilePath);
  console.log(`[${profileName}] STEP 6: Profile unlocked.`);

  // Prepare proxy extension (if proxy configured)
  const extensions = [];
  console.log(
    `[${profileName}] STEP 7: Proxy detected, preparing proxy extension...`,
  );
  const proxyExtensionPath = await prepareFreshExtension(profileName, "proxy");
  console.log(
    `[${profileName}] STEP 7a: Proxy extension path: ${proxyExtensionPath}`,
  );
  await updateProxyBackground(proxyExtensionPath, proxy, url || "about:blank");
  console.log(`[${profileName}] STEP 7b: Proxy extension updated.`);
  if (proxyExtensionPath) extensions.push(proxyExtensionPath);

  // Prepare spy extension
  console.log(`[${profileName}] STEP 8: Preparing spy extension...`);
  try {
    const port = await getSpyWebSocketPortAsync();
    const spyExtensionPath = await prepareFreshSpyExtension(profileName, port);
    console.log(
      `[${profileName}] STEP 8a: Spy extension prepared at: ${spyExtensionPath}`,
    );
    if (spyExtensionPath) extensions.push(spyExtensionPath);
  } catch (e) {
    console.warn(
      `[${profileName}] STEP 8b: Failed to prepare spy extension, continuing without it:`,
      e?.message || e,
    );
  }

  // Build args
  console.log(`[${profileName}] STEP 9: Building Chrome arguments...`);
  const norm = (p) => p.replace(/\\/g, "/");
  const extList = extensions.map(norm).join(",");
  const args = [
    `--host-resolver-rules=${require("./networkPolicy").browserHostRules}`, 
    `--user-data-dir=${norm(profilePath)}`,
    "--no-default-browser-check",
    "--no-first-run",
    "--password-store=basic",
  ];

  if (extList) {
    args.push(`--disable-extensions-except=${extList}`);
    args.push(`--load-extension=${extList}`);
    console.log(
      `[${profileName}] STEP 9a: Loading extensions: ${extensions.map((e) => path.basename(e)).join(", ")}`,
    );
  } else {
    console.log(`[${profileName}] STEP 9a: No extensions to load.`);
  }

  if (headless) {
    args.push("--headless=new", "--window-size=1920,1080");
    console.log(`[${profileName}] STEP 9b: Running in headless mode.`);
  } else {
    args.push("--start-maximized");
    console.log(
      `[${profileName}] STEP 9b: Running in visible (maximized) mode.`,
    );
  }

  // Optional debugging port if provided
  const actualPort = debuggingPort || null;
  if (actualPort) {
    args.push(`--remote-debugging-port=${actualPort}`);
    console.log(
      `[${profileName}] STEP 9c: Debugging port set to ${actualPort}`,
    );
  } else {
    console.log(`[${profileName}] STEP 9c: No debugging port specified.`);
  }
  // Launch Chrome
  console.log(`[${profileName}] STEP 10: Launching Chrome with args:`, args);

  const chromeProcess = spawn(chromePath, args, {
    env: { ...process.env },
    windowsHide: true,
    stdio: "ignore",
  });

  chromeProcess.on("error", (err) => {
    console.error(`[${profileName}] STEP 11: Spy Chrome process error:`, err);
  });
  chromeProcess.on("close", () => {
    console.log(`[${profileName}] STEP 12: Spy Chrome process closed.`);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      console.log(
        `[${profileName}] STEP 12a: Notifying renderer process of closure.`,
      );
      win.webContents.send("stealth-browser-closed", profileName);
    }
  });

  console.log(`[${profileName}] STEP 13: Spy browser launched successfully.`);
  return { chromeProcess, client: null, debuggingPort: actualPort };
}

// Bare browser start: no extensions, no remote debugging, minimal args
async function startBareChrome(profileName, headless = false) {
  console.log(`[${profileName}] Starting bare VCBrowser (no extensions)...`);

  // Resolve VCBrowser path
  const userDataPath = app.getPath("userData");
  let chromePath = require("./browserPaths").getVCBrowserPath();
  if (!fss.existsSync(chromePath)) {
    // Fallback to system Chrome if VCBrowser not available
    try {
      chromePath = findChromeExe();
    } catch {
      chromePath = null;
    }
  }
  if (!chromePath || !fss.existsSync(chromePath))
    throw new Error(`VCBrowser executable not found`);

  // Use a dedicated empty profile folder to avoid interference
  const profilePath = path.join(
    app.getPath("userData"),
    "profiles",
    profileName + "_bare",
  );
  await fs.mkdir(profilePath, { recursive: true });
  await unlockProfile(profilePath);

  const norm = (p) => p.replace(/\\/g, "/");
  const args = [
    `--host-resolver-rules=${require("./networkPolicy").browserHostRules}`, 
    `--user-data-dir=${norm(profilePath)}`,
    "--no-default-browser-check",
    "--no-first-run",
  ];
  if (headless) {
    args.push("--headless=new", "--window-size=1920,1080");
  } else {
    args.push("--start-maximized");
  }

  console.log(`[${profileName}] Launching Chrome (bare)...`);
  const chromeProcess = spawn(chromePath, args, {
    env: { ...process.env },
    windowsHide: true,
    stdio: "ignore",
  });

  chromeProcess.on("error", (err) => {
    console.error(`[${profileName}] Bare Chrome process error:`, err);
  });
  chromeProcess.on("close", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send("stealth-browser-closed", profileName);
    cleanProfileCacheAfterClose(profilePath).catch(() => {});
  });

  console.log(`[${profileName}] Bare Chrome launched`);
  return { chromeProcess };
}

async function prepareFreshExtension(profileName, extension) {
  const src = path.join(__dirname, "../", "plugins", extension);
  const base = path.join(
    app.getPath("userData"),
    "profiles",
    profileName,
    "EXTENSIONS",
    extension,
  );

  try {
    // Clean up old extension folders
    console.log(`[ExtPrep] cleaning up old ${extension} extension folders`);
    try {
      const existingFolders = await fs.readdir(base);
      for (const folder of existingFolders) {
        const folderPath = path.join(base, folder);
        const stat = await fs.lstat(folderPath);
        if (stat.isDirectory()) {
          console.log(
            `[ExtPrep] removing old ${extension} folder:`,
            folderPath,
          );
          await fs.rm(folderPath, { recursive: true, force: true });
        }
      }
    } catch (cleanupError) {
      // If base directory doesn't exist yet, that's fine
      if (cleanupError.code !== "ENOENT") {
        console.warn(
          `[ExtPrep] ${extension} cleanup warning:`,
          cleanupError.message,
        );
      }
    }

    const randomFolder = generateRandomString(10);
    const dest = path.join(base, randomFolder);

    await fs.mkdir(dest, { recursive: true });
    if (extension === "proxy") {
      await copyProxyExtension(src, dest);
    } else if (extension === "fingerprint") {
      await copyFingerprintExtension(src, dest);
    } else {
      // Fallback to recursive copy for other extensions
      await copyDir(src, dest);
    }
    return dest;
  } catch (e) {
    console.warn(
      `[ExtPrep] Failed to prepare extension ${extension}:`,
      e?.message || e,
    );
    return null;
  }
}

// Lightweight copy for proxy extension (manifest + background only)
async function copyProxyExtension(src, dest) {
  // Only copy files that actually exist in the proxy extension
  const files = ["manifest.json", "background.js"];
  let manifestCopied = false;

  for (const name of files) {
    try {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const buf = await fs.readFile(from);
      await fs.writeFile(to, buf);
      console.log(`[ExtPrep] proxy file copied: ${name}`);
      if (name === "manifest.json") manifestCopied = true;
    } catch (e) {
      console.warn(`[ExtPrep] proxy file copy failed: ${name} - ${e.message}`);
    }
  }

  if (!manifestCopied) {
    throw new Error("Failed to copy manifest.json for proxy extension");
  }
}

// Lightweight copy for fingerprint extension (all required files)
async function copyFingerprintExtension(src, dest) {
  const files = ["manifest.json", "inject.js", "background.js", "content.js"];
  for (const name of files) {
    try {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const buf = await fs.readFile(from);
      await fs.writeFile(to, buf);
    } catch (e) {
      console.warn(`[ExtPrep] fingerprint file copy failed: ${name}`);
    }
  }
}

async function prepareFreshSpyExtension(profileName, wsPort) {
  console.log("prepareFreshSpyExtension started");
  const src = path.join(__dirname, "../", "plugins", "spy");
  const base = path.join(
    app.getPath("userData"),
    "profiles",
    profileName,
    "EXTENSIONS",
    "spy",
  );

  try {
    // Clean up old spy extension folders
    console.log("[SpyPrep] cleaning up old spy extension folders");
    try {
      const existingFolders = await fs.readdir(base);
      for (const folder of existingFolders) {
        const folderPath = path.join(base, folder);
        const stat = await fs.lstat(folderPath);
        if (stat.isDirectory()) {
          console.log("[SpyPrep] removing old folder:", folderPath);
          await fs.rm(folderPath, { recursive: true, force: true });
        }
      }
    } catch (cleanupError) {
      // If base directory doesn't exist yet, that's fine
      if (cleanupError.code !== "ENOENT") {
        console.warn("[SpyPrep] cleanup warning:", cleanupError.message);
      }
    }

    const randomFolder = generateRandomString(10);
    const dest = path.join(base, randomFolder);

    console.log("[SpyPrep] creating destination dir", dest);
    await fs.mkdir(dest, { recursive: true });

    console.log("[SpyPrep] copying essential files only");
    await copySpyExtension(src, dest);

    console.log("[SpyPrep] updating background with ws port");
    await updateSpyExtension(dest, wsPort ?? getSpyWebSocketPort());

    return dest;
  } catch (error) {
    console.error("Error preparing spy extension:", error);
    return null;
  }
}

// Lightweight copy for the spy extension to avoid long recursive operations
async function copySpyExtension(src, dest) {
  const files = [
    "manifest.json",
    "background.js",
    "facebook.js",
    "pinterest.js",
    "offscreen.js",
    "offscreen.html",
  ];
  for (const name of files) {
    try {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const buf = await fs.readFile(from);
      await fs.writeFile(to, buf);
    } catch (e) {
      console.warn(
        `[SpyPrep] optional file missing or failed to copy: ${name}`,
      );
    }
  }
}

async function copyDir(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyDir(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

async function connectClient(port, retries = 10, delayMs = 300) {
  let lastErr;
  console.log(
    `Attempting to connect to CDP on port ${port} (${retries} retries, ${delayMs}ms delay)`,
  );

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`CDP connection attempt ${i + 1}/${retries}`);
      const client = await CDP({ port });
      client.on("disconnect", () => {
        client._disconnected = true;
      });
      console.log(`CDP connection successful on attempt ${i + 1}`);
      return client;
    } catch (e) {
      lastErr = e;
      const errorMsg =
        e.code === "ECONNREFUSED"
          ? "Connection refused - Chrome may not be ready yet"
          : e.message;
      console.log(`CDP connection attempt ${i + 1} failed: ${errorMsg}`);
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  console.error(`All CDP connection attempts failed after ${retries} tries`);
  throw (
    lastErr ||
    new Error(
      `Failed to connect to CDP on port ${port} after ${retries} attempts`,
    )
  );
}

async function updateProxyBackground(extensionPath, proxyConfig, url) {
  const filePath = path.join(extensionPath, "background.js");
  let content = await fs.readFile(filePath, "utf-8");
  if (!proxyConfig)
    proxyConfig = {
      ip: "NULL",
      port: "NULL",
      username: "NULL",
      password: "NULL",
    };
  else {
    proxyConfig.ip = proxyConfig.ip || "NULL";
    proxyConfig.port = proxyConfig.port || "NULL";
    proxyConfig.username = proxyConfig.username || "NULL";
    proxyConfig.password = proxyConfig.password || "NULL";
  }
  content = content
    .replace(/const HOST = ".*?";/, `const HOST = "${proxyConfig.ip}";`)
    .replace(/const PORT = ".*?";/, `const PORT = "${proxyConfig.port}";`)
    .replace(
      /const USERNAME = ".*?";/,
      `const USERNAME = "${proxyConfig.username}";`,
    )
    .replace(
      /const PASSWORD = ".*?";/,
      `const PASSWORD = "${proxyConfig.password}";`,
    )
    .replace(
      /const TAB_URL = ".*?";/,
      `const TAB_URL = "${url || "about:blank"}";`,
    );
  await fs.writeFile(filePath, content, "utf-8");
}

async function updateSpyExtension(extensionPath, wsPort) {
  try {
    console.log("updateSpyExtension started");
    const backgroundPath = path.join(extensionPath, "background.js");
    let content = await fs.readFile(backgroundPath, "utf-8");

    if (!wsPort || !Number.isInteger(wsPort) || wsPort <= 0) {
      try {
        wsPort = await getSpyWebSocketPortAsync();
      } catch {
        wsPort = getSpyWebSocketPort();
      }
    }

    const before = content;
    content = content.replace(
      /(?:\w+\s*=\s*)?new\s+WebSocket\(["']ws:\/\/localhost:\d+["']\)/g,
      `new WebSocket("ws://localhost:${wsPort}")`,
    );
    // Broader replacement in case code shape differs
    content = content.replace(
      /ws:\/\/localhost:\d+/g,
      `ws://localhost:${wsPort}`,
    );
    if (content === before) {
      console.warn(
        "Spy extension: did not find WebSocket URL to replace; background.js left unchanged",
      );
    }

    // Add a visible log at top for debugging
    content =
      `console.log('Spy extension WS URL:', 'ws://localhost:${wsPort}');\n` +
      content;

    await fs.writeFile(backgroundPath, content, "utf-8");
  } catch (error) {
    console.error("Failed to update spy extension WebSocket port:", error);
  }
}

async function updateFingerprintExtension(
  extensionPath,
  profileName,
  version = { major: "142", full: "142.0.0.0" },
  bundle = {
    locale: "en-US",
    tz: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
  },
) {
  let fingerprintConfig = null;
  const profilePath = path.join(
    app.getPath("userData"),
    "profiles",
    profileName,
  );
  const fingerprintFile = path.join(profilePath, "fingerprint.json");

  try {
    // First try to get fingerprint from structures
    try {
      const structures = (await readKey("structures")) || {};
      for (const structureId in structures) {
        const structure = structures[structureId];
        if (structure.profiles && structure.profiles[profileName]) {
          fingerprintConfig = structure.profiles[profileName].fingerprint;
          console.log(
            `Loaded fingerprint from structure for profile: ${profileName}`,
          );
          break;
        }
      }
    } catch (e) {
      console.log(
        `Could not load from structures for profile ${profileName}:`,
        e.message,
      );
    }

    // If not found in structures, try profile-specific storage
    if (!fingerprintConfig) {
      try {
        await fs.mkdir(profilePath, { recursive: true });
        const savedFingerprint = await fs.readFile(fingerprintFile, "utf8");
        fingerprintConfig = JSON.parse(savedFingerprint);
        console.log(
          `Loaded existing fingerprint from file for profile: ${profileName}`,
        );
      } catch (e) {
        console.log(
          `No saved fingerprint found for profile ${profileName}, creating consistent fingerprint`,
        );
        // No saved fingerprint, use consistent fingerprint generation for new profiles
        fingerprintConfig = getConsistentFingerprintForProfile(
          profileName,
          version,
        );
        try {
          await fs.writeFile(
            fingerprintFile,
            JSON.stringify(fingerprintConfig, null, 2),
            "utf8",
          );
          console.log(
            `Saved consistent fingerprint for new profile: ${profileName}`,
          );
        } catch (saveError) {
          console.error(
            `Failed to save fingerprint for profile ${profileName}:`,
            saveError,
          );
        }
      }
    } else {
      // If fingerprint came from structures, also save it to profile-specific file for consistency
      try {
        await fs.mkdir(profilePath, { recursive: true });
        await fs.writeFile(
          fingerprintFile,
          JSON.stringify(fingerprintConfig, null, 2),
          "utf8",
        );
        console.log(
          `Synced structure fingerprint to profile file for: ${profileName}`,
        );
      } catch (syncError) {
        console.log(
          `Could not sync fingerprint to file for profile ${profileName}:`,
          syncError,
        );
      }
    }

    // Clean up properties that should not be injected
    const cleanFingerprint = { ...fingerprintConfig };

    // Update the inject script directly with fingerprint data
    const injectPath = path.join(extensionPath, "inject.js");
    let content = await fs.readFile(injectPath, "utf-8");
    const fingerprintString = JSON.stringify(cleanFingerprint, null, 4);

    // Replace the fingerprint placeholder in inject.js
    content = content.replace(
      /const EMBEDDED_FINGERPRINT = {[\s\S]*?};/,
      `const EMBEDDED_FINGERPRINT = ${fingerprintString};`,
    );

    await fs.writeFile(injectPath, content, "utf-8");

    console.log(
      `Successfully applied fingerprint to inject.js for profile: ${profileName}`,
    );
  } catch (mainError) {
    console.error(
      `Error in updateFingerprintExtension for profile ${profileName}:`,
      mainError,
    );
    // Fallback to generating a consistent fingerprint only if all else fails
    try {
      const defaultFingerprint = getConsistentFingerprintForProfile(
        profileName,
        version,
      ); // Use consistent instead of random
      const cleanFingerprint = { ...defaultFingerprint };
      const injectPath = path.join(extensionPath, "inject.js");
      let content = await fs.readFile(injectPath, "utf-8");
      const fingerprintString = JSON.stringify(cleanFingerprint, null, 4);
      content = content.replace(
        /const EMBEDDED_FINGERPRINT = {[\s\S]*?};/,
        `const EMBEDDED_FINGERPRINT = ${fingerprintString};`,
      );
      await fs.writeFile(injectPath, content, "utf-8");

      // Try to save the fallback fingerprint
      try {
        await fs.mkdir(profilePath, { recursive: true });
        await fs.writeFile(
          fingerprintFile,
          JSON.stringify(defaultFingerprint, null, 2),
          "utf8",
        );
      } catch (fallbackSaveError) {
        console.error(
          `Could not save fallback fingerprint for ${profileName}:`,
          fallbackSaveError,
        );
      }

      console.log(
        `Applied fallback consistent fingerprint for profile: ${profileName}`,
      );
    } catch (fallbackError) {
      console.error(
        `Complete failure in fingerprint handling for profile ${profileName}:`,
        fallbackError,
      );
    }
  }
}

// NOTE: getRealMachineFingerprint and getConsistentFingerprintForProfile have been moved to cdpFingerprint.js
// They are imported at the top of this file and re-exported for backwards compatibility

function getRandomInt(min, max) {
  const minCeiled = Math.ceil(min);
  const maxFloored = Math.floor(max);
  return Math.floor(Math.random() * (maxFloored - minCeiled) + minCeiled);
}

function generateRandomString(length = 10) {
  return Math.random()
    .toString(36)
    .substring(2, 2 + length);
}

function extractDiscordFields(request) {
  const postData = request?.postData;
  if (typeof postData !== "string" || !postData.trim()) {
    throw new Error("Discord interaction request has no postData");
  }

  let parsed;
  try {
    parsed = JSON.parse(postData);
  } catch {
    const match = postData.match(
      /name="payload_json"\r\n\r\n({[\s\S]+?})\r\n/,
    );
    if (match && match[1]) parsed = JSON.parse(match[1]);
  }
  if (!parsed) throw new Error("Could not parse request.postData");

  // Only an actual /imagine interaction contains the command metadata needed
  // by the Midjourney HTTP node. Other Discord requests may mention
  // "midjourney" but contain only a subset of these fields.
  if (parsed.type !== 2 || parsed.data?.name !== "imagine") {
    throw new Error("Request is not a Discord /imagine interaction");
  }

  return {
    APPLICATION_ID:
      parsed.application_id || parsed.data?.application_command?.application_id,
    GUILD_ID: parsed.guild_id,
    CHANNEL_ID: parsed.channel_id,
    SESSION_ID: parsed.session_id,
    DATA_VERSION:
      parsed.data?.version || parsed.data?.application_command?.version,
    DATA_ID: parsed.data?.id || parsed.data?.application_command?.id,
    AUTHORIZATION:
      request.headers?.Authorization || request.headers?.authorization || null,
  };
}

let currentWebSocketPort = null;

async function init() {
  try {
    const workflows = readKey("workflows") || {};
    const filteredWorkflows = Object.fromEntries(
      Object.entries(workflows).filter(([_, w]) => w.status !== "pending"),
    );
    await updateData("spyPosts", []);
    await updateData("workflows", filteredWorkflows);
    console.log("Storage initialization completed");
    // Initialize in-memory post list to empty
    spyPostsState.list = [];

    // Sync existing library posts to seen_post_ids to ensure they never appear in spy manager
    const postsLibrary = readKey("postsLibrary") || [];
    if (postsLibrary.length > 0) {
      const libraryPostIds = postsLibrary.map((p) => p.postId).filter(Boolean);
      if (libraryPostIds.length > 0) {
        addToSeenPostIds(libraryPostIds);
        console.log(
          `[init] Synced ${libraryPostIds.length} library posts to seen_post_ids`,
        );
      }
    }
  } catch (error) {
    console.error("Error initializing storage:", error);
  }

  // Try to start WebSocket server with retry logic
  await startWebSocketServer();

  // Initialize automatic cleanup system
  await initCleanupSystem();
}

async function initCleanupSystem() {
  const { CleanupManager } = require("./cleanup");
  console.log("[CLEANUP] Initializing automatic cleanup system...");

  // NOTE: Startup cleanup is now deferred to the frontend precheck page
  // This allows the app to start faster and show cleanup progress to the user
  console.log("[CLEANUP] Startup cleanup deferred to frontend precheck page");

  // Schedule periodic cleanup every 24 hours
  setInterval(
    async () => {
      try {
        console.log("[CLEANUP] Running scheduled cleanup...");
        const cleanupManager = new CleanupManager();
        const result = await cleanupManager.cleanupAll(false);
        console.log(
          `[CLEANUP] Scheduled cleanup completed: ${result.totalRemoved} items removed, ${result.totalFormattedSize} freed`,
        );
      } catch (error) {
        console.error(
          "[CLEANUP] Error during scheduled cleanup:",
          error.message,
        );
      }
    },
    24 * 60 * 60 * 1000,
  ); // 24 hours in milliseconds

  // Schedule more frequent temp file cleanup every hour
  setInterval(
    async () => {
      try {
        console.log("[CLEANUP] Running scheduled temp file cleanup...");
        const cleanupManager = new CleanupManager();

        // Check if temp cleanup is needed
        const status = await cleanupManager.getCleanupStatus();
        const tempFilesSize = status.tempUploads ? status.tempUploads.size : 0;

        // Clean temp files if over 100MB or many files
        if (
          tempFilesSize > 100 * 1024 * 1024 ||
          (status.tempUploads && status.tempUploads.count > 100)
        ) {
          const result = await cleanupManager.cleanupTempUploads(false);
          console.log(
            `[CLEANUP] Temp file cleanup completed: ${result.removed.length} files removed, ${cleanupManager.formatFileSize(result.totalSize)} freed`,
          );
        } else {
          console.log("[CLEANUP] No significant temp file cleanup needed");
        }
      } catch (error) {
        console.error(
          "[CLEANUP] Error during scheduled temp cleanup:",
          error.message,
        );
      }
    },
    60 * 60 * 1000,
  ); // 1 hour in milliseconds

  console.log("[CLEANUP] Automatic cleanup system initialized");
}

// Utility function for automations to trigger temp file cleanup
async function cleanupTempFiles(force = false) {
  try {
    const { CleanupManager } = require("./cleanup");
    const cleanupManager = new CleanupManager();

    if (force) {
      // Force cleanup regardless of thresholds
      console.log("[CLEANUP] Force cleaning temp files...");
      const result = await cleanupManager.cleanupTempUploads(false);
      console.log(
        `[CLEANUP] Force cleanup completed: ${result.removed.length} files removed, ${cleanupManager.formatFileSize(result.totalSize)} freed`,
      );
      return result;
    } else {
      // Check if cleanup is needed based on size/count thresholds
      const status = await cleanupManager.getCleanupStatus();
      const tempFilesSize = status.tempUploads ? status.tempUploads.size : 0;
      const tempFilesCount = status.tempUploads ? status.tempUploads.count : 0;

      // More aggressive thresholds for workflow-triggered cleanup
      if (tempFilesSize > 50 * 1024 * 1024 || tempFilesCount > 50) {
        // 50MB or 50 files
        console.log("[CLEANUP] Workflow-triggered temp cleanup...");
        const result = await cleanupManager.cleanupTempUploads(false);
        console.log(
          `[CLEANUP] Workflow cleanup completed: ${result.removed.length} files removed, ${cleanupManager.formatFileSize(result.totalSize)} freed`,
        );
        return result;
      }
    }

    return null;
  } catch (error) {
    console.error(
      "[CLEANUP] Error during workflow temp cleanup:",
      error.message,
    );
    return null;
  }
}

function startWebSocketServer(retries = 5, preferredPort = null) {
  return new Promise(async (resolve) => {
    let resolved = false;
    let attempt = 0;

    const tryOnce = () => {
      const wantPort =
        attempt === 0 && Number.isInteger(preferredPort) && preferredPort > 0
          ? preferredPort
          : 0;
      console.log(
        `[SOCKET LOG] Attempt ${attempt + 1}/${retries + 1} starting, wantPort=${wantPort}`,
      );
      let wss;

      const finish = (portOrNull) => {
        if (!resolved) {
          resolved = true;
          console.log(
            `[SOCKET LOG] Resolving startWebSocketServer with port=${portOrNull}`,
          );
          resolve(portOrNull);
        }
      };

      try {
        console.log(
          `[SOCKET LOG] Creating WebSocket.Server on port ${wantPort || "auto"}`,
        );
        wss = new WebSocket.Server({
          host: "127.0.0.1",
          port: wantPort,
          clientTracking: true,
          perMessageDeflate: false,
        });

        wss.once("listening", () => {
          const assigned =
            typeof wss.address === "function" && wss.address()
              ? wss.address().port
              : wantPort || null;
          currentWebSocketPort = assigned;
          console.log(
            `[SOCKET LOG] WebSocket server started successfully on port ${assigned}`,
          );

          wss.on("connection", (ws) => {
            console.log(`[SOCKET LOG] WebSocket client connected`);

            ws.isAlive = true;
            ws.on("pong", () => {
              ws.isAlive = true;
              console.log(`[SOCKET LOG] Pong received, client marked alive`);
            });

            ws.on("message", (data) => {
              try {
                console.log(`[SOCKET LOG] Message received:`, data.toString());
                const post = JSON.parse(data);
                let postData;
                if (post.type === "facebook") {
                  postData = {
                    type: post.type,
                    postId: post.postId,
                    postMessage: post.postMessage,
                    postImg: post.postImg,
                    postUrl: post.postUrl,
                    reactions: post.reactions,
                    shares: post.shares,
                    comments: post.comments,
                    createdTime: post.createdTime,
                    now: post.now,
                    page: {
                      url: post.pageUrl,
                      name: post.pageName,
                      image: post.pageImage,
                      followers: post.pageFollowers || null,
                    },
                  };
                } else if (post.type === "pinterest") {
                  postData = {
                    type: post.type,
                    postMessage: post.description,
                    postImg: post.image,
                    postUrl: `https://www.pinterest.com/pin/${post.id}/`,
                    shares: post.shares,
                    comments: post.comments,
                    repins: post.repins,
                    link: post.link,
                    postId: post.id,
                    createdTime: post.createdTime,
                    now: post.now,
                  };
                }
                if (postData) {
                  console.log(`[SOCKET LOG] Enqueuing spy post`, postData);
                  enqueueSpyPost(postData);
                }
              } catch (error) {
                console.error(
                  "[SOCKET LOG] Error processing WebSocket message:",
                  error,
                );
              }
            });

            ws.on("close", (code, reason) => {
              const text = (() => {
                try {
                  if (!reason) return "";
                  if (Buffer.isBuffer(reason)) return reason.toString();
                  return String(reason);
                } catch {
                  return "";
                }
              })();
              console.log("[SOCKET LOG] WebSocket client disconnected", {
                code,
                reason: text,
              });
            });

            ws.on("error", (error) => {
              console.error("[SOCKET LOG] WebSocket connection error:", error);
            });
          });

          wss.on("error", (err) => {
            console.error(
              "[SOCKET LOG] WebSocket server runtime error:",
              err.message,
            );
          });

          const interval = setInterval(() => {
            wss.clients.forEach((ws) => {
              if (ws.isAlive === false) {
                console.warn("[SOCKET LOG] Client unresponsive, terminating");
                try {
                  ws.terminate();
                } catch {}
                return;
              }
              ws.isAlive = false;
              try {
                ws.ping();
                console.log("[SOCKET LOG] Ping sent");
              } catch {}
            });
          }, 30000);

          wss.on("close", () => {
            clearInterval(interval);
            console.warn("[SOCKET LOG] WebSocket server closed");
          });

          finish(assigned);
        });

        wss.once("error", (error) => {
          const code = error && error.code;
          console.error(
            `[SOCKET LOG] WebSocket server error on port ${wantPort || "auto"} (attempt ${attempt + 1}/${retries + 1}):`,
            error.message,
          );

          try {
            wss.close();
          } catch {}

          if (attempt < retries) {
            attempt += 1;
            const backoff = Math.min(1000 * attempt, 3000);
            console.log(
              `[SOCKET LOG] Retrying WebSocket server in ${backoff}ms...`,
            );
            setTimeout(tryOnce, backoff);
          } else {
            console.error(
              "[SOCKET LOG] Failed to start WebSocket server after all retries",
            );
            currentWebSocketPort = null;
            finish(null);
          }
        });
      } catch (error) {
        console.error(
          `[SOCKET LOG] Failed to create WebSocket server (attempt ${attempt + 1}/${retries + 1}) on port ${wantPort || "auto"}:`,
          error.message,
        );
        if (attempt < retries) {
          attempt += 1;
          const backoff = Math.min(1000 * attempt, 3000);
          console.log(
            `[SOCKET LOG] Retrying WebSocket server in ${backoff}ms...`,
          );
          setTimeout(tryOnce, backoff);
        } else {
          console.error(
            "[SOCKET LOG] Failed to start WebSocket server after all retries",
          );
          currentWebSocketPort = null;
          finish(null);
        }
      }
    };

    tryOnce();
  });
}

// Ensure a dynamic WebSocket port is available and return it
async function getSpyWebSocketPortAsync() {
  if (
    currentWebSocketPort &&
    Number.isInteger(currentWebSocketPort) &&
    currentWebSocketPort > 0
  ) {
    return currentWebSocketPort;
  }
  try {
    const port = await startWebSocketServer();
    return port || getSpyWebSocketPort(); // fallback to env/default if somehow null
  } catch {
    return getSpyWebSocketPort();
  }
}

function findChromeExe() {
  const paths = [
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        "Google\\Chrome\\Application\\chrome.exe",
      ),
    process.env.PROGRAMFILES &&
      path.join(
        process.env.PROGRAMFILES,
        "Google\\Chrome\\Application\\chrome.exe",
      ),
    process.env["PROGRAMFILES(X86)"] &&
      path.join(
        process.env["PROGRAMFILES(X86)"],
        "Google\\Chrome\\Application\\chrome.exe",
      ),
  ].filter(Boolean);
  for (const p of paths) {
    if (fss.existsSync(p)) return p;
  }
  return null;
}

function showAlert(message, autoHide = 0) {
  const alertWin = new BrowserWindow({
    width: 300,
    height: 150,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    frame: false,
    titleBarStyle: "hidden",
    modal: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  alertWin.loadFile(path.join(__dirname, "../", "frontend", "alert.html"));
  alertWin.webContents.on("did-finish-load", () => {
    alertWin.webContents.send("alert-message", message);
    alertWin.webContents.send("auto-hide", autoHide);
  });
}

// Trigger cleanup when profiles or data are modified
async function triggerCleanupIfNeeded() {
  try {
    const { CleanupManager } = require("./cleanup");
    const cleanupManager = new CleanupManager();

    // Quick check for cleanup opportunities
    const status = await cleanupManager.getCleanupStatus();
    const itemCount =
      status.orphanedProfiles.count + status.unreferencedImages.count;

    // If there are more than 10 items to clean or over 50MB to reclaim, run cleanup
    if (itemCount > 10 || status.totalSize > 50 * 1024 * 1024) {
      console.log(
        `[CLEANUP] Triggered cleanup: ${itemCount} items, ${status.totalFormattedSize} to reclaim`,
      );
      const result = await cleanupManager.cleanupAll(false);
      console.log(
        `[CLEANUP] Triggered cleanup completed: ${result.totalRemoved} items removed, ${result.totalFormattedSize} freed`,
      );
    }
  } catch (error) {
    console.error("[CLEANUP] Error during triggered cleanup:", error.message);
  }
}

// =====================================================
// Proxy Rotation for Rayobyte-style residential proxies
// =====================================================

/**
 * Generate a random session ID for Rayobyte proxy rotation
 * @param {number} length - Length of the session ID (default 8)
 * @returns {string} Random alphanumeric session ID
 */
function generateProxySessionId(length = 8) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Check if a proxy password contains a Rayobyte-style session ID
 * @param {string} password - The proxy password to check
 * @returns {boolean} True if contains hardsession or session parameter
 */
function isRayobyteSessionProxy(password) {
  if (!password || typeof password !== "string") return false;
  return /(-hardsession-|-session-)[A-Za-z0-9]+/i.test(password);
}

/**
 * Rotate the session ID in a Rayobyte-style proxy password
 * @param {string} password - The original proxy password
 * @returns {string} Password with new session ID
 */
function rotateRayobyteSessionId(password) {
  if (!password || typeof password !== "string") return password;

  const newSessionId = generateProxySessionId(8);

  // Replace hardsession-XXXXX or session-XXXXX with new session ID
  return password.replace(
    /(-hardsession-|-session-)([A-Za-z0-9]+)/i,
    `$1${newSessionId}`,
  );
}

/**
 * Check if a proxy IP is clean using IPRegistry API
 * @param {object} proxyData - Proxy configuration {ip, port, username, password}
 * @param {string} ipregistryApiKey - IPRegistry API key
 * @returns {Promise<{clean: boolean, ip: string, security: object, error?: string}>}
 */
async function checkProxyClean(proxyData, ipregistryApiKey) {
  const { ip, port, username, password } = proxyData;

  try {
    // First get the real IP through the proxy
    let proxyUrl = `http://${ip}:${port}`;
    if (username && password) {
      proxyUrl = `http://${username}:${password}@${ip}:${port}`;
    }

    const agent = new HttpsProxyAgent(proxyUrl);

    // Get real IP through proxy
    const ipResponse = await axios.get("https://api.ipify.org?format=json", {
      httpsAgent: agent,
      timeout: 8000,
    });
    const realIp = ipResponse.data.ip;

    // Check IP with IPRegistry
    const ipregistryResponse = await axios.get(
      `https://api.ipregistry.co/${realIp}?key=${ipregistryApiKey}`,
      {
        timeout: 10000,
      },
    );

    const data = ipregistryResponse.data;
    const security = data.security || {};

    // Check all security flags - a clean proxy has all false
    const isClean =
      !security.is_abuser &&
      !security.is_attacker &&
      !security.is_bogon &&
      !security.is_cloud_provider &&
      !security.is_proxy &&
      !security.is_relay &&
      !security.is_tor &&
      !security.is_tor_exit &&
      !security.is_vpn &&
      !security.is_anonymous &&
      !security.is_threat;

    // Get flagged reasons for display
    const flaggedReasons = Object.entries(security)
      .filter(([k, v]) => v === true && k.startsWith("is_"))
      .map(([k]) => k.replace("is_", "").replace(/_/g, " "));

    return {
      clean: isClean,
      ip: realIp,
      security: security,
      flaggedReasons: flaggedReasons,
      location: data.location,
      creditsRemaining:
        ipregistryResponse.headers["ipregistry-credits-remaining"],
    };
  } catch (error) {
    console.error("[ProxyCheck] Error checking proxy:", error.message);

    // Check for Rayobyte geo-targeting error (551)
    let errorMessage = error.message;
    if (error.response?.status === 551 || error.message.includes("551")) {
      errorMessage =
        "Geo-targeting error (551): The proxy geo settings (country/region/city) are not available. Please remove or change the geo parameters in your proxy configuration.";
    }

    // Classify the failure. A "connection" error means the proxy itself is
    // unreachable/dead (timeout, refused, tunnel/socket failure) — as opposed
    // to reaching IPRegistry and getting a flagged IP. Callers use this to
    // fast-fail instead of burning 20 slow rotation attempts on a dead proxy.
    const code = error.code || "";
    const msg = (error.message || "").toLowerCase();
    const isConnError =
      error.request && !error.response ||
      /econnrefused|econnreset|etimedout|esockettimedout|enotfound|ehostunreach|enetunreach|socket hang up|timeout|tunnel|proxy/i.test(
        code + " " + msg,
      );

    return {
      clean: false,
      ip: null,
      security: null,
      flaggedReasons: [],
      error: errorMessage,
      errorType: isConnError ? "connection" : "other",
    };
  }
}

/**
 * Find a clean proxy by rotating Rayobyte session IDs
 * @param {object} proxyData - Original proxy configuration {ip, port, username, password}
 * @param {string} ipregistryApiKey - IPRegistry API key
 * @param {number} maxAttempts - Maximum number of rotation attempts (default 10)
 * @param {function} onAttempt - Callback for each attempt (attemptNumber, maxAttempts, proxyData, result)
 * @returns {Promise<{success: boolean, proxyData: object, attempts: number, finalIp: string, error?: string}>}
 */
async function findCleanProxy(
  proxyData,
  ipregistryApiKey,
  maxAttempts = 20,
  onAttempt = null,
) {
  if (!ipregistryApiKey) {
    console.warn(
      "[ProxyRotation] No IPRegistry API key provided, skipping clean proxy check",
    );
    return {
      success: true,
      proxyData,
      attempts: 0,
      finalIp: null,
      skipped: true,
    };
  }

  const isSessionProxy = isRayobyteSessionProxy(proxyData.password);
  let currentProxy = { ...proxyData };

  // If it's a session proxy, rotate the session ID before first check to get fresh IP
  if (isSessionProxy) {
    currentProxy = {
      ...currentProxy,
      password: rotateRayobyteSessionId(currentProxy.password),
    };
  }

  // Abort early if the proxy itself is unreachable. Rotating the session ID
  // does not fix a dead proxy, and 20 slow timeouts (~8s each) makes
  // auto-publish crawl when several profiles have failing proxies.
  const MAX_CONN_ERRORS = 3;
  let consecutiveConnErrors = 0;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `[ProxyRotation] Attempt ${attempt}/${maxAttempts} - Checking proxy...`,
    );

    const result = await checkProxyClean(currentProxy, ipregistryApiKey);
    lastResult = result;

    if (onAttempt) {
      try {
        await onAttempt(attempt, maxAttempts, currentProxy, result);
      } catch (e) {
        console.error("[ProxyRotation] onAttempt callback error:", e);
      }
    }

    if (result.error) {
      console.warn(
        `[ProxyRotation] Attempt ${attempt} failed: ${result.error}`,
      );
      // If not a session proxy, can't rotate - return failure
      if (!isSessionProxy) {
        return {
          success: false,
          proxyData: currentProxy,
          attempts: attempt,
          finalIp: null,
          error: result.error,
        };
      }
      // Track connection-level failures (dead/unreachable proxy). After a few
      // in a row, stop — the underlying proxy is down and rotating won't help.
      if (result.errorType === "connection") {
        consecutiveConnErrors++;
        if (consecutiveConnErrors >= MAX_CONN_ERRORS) {
          console.error(
            `[ProxyRotation] Aborting after ${consecutiveConnErrors} consecutive connection errors — proxy appears unreachable`,
          );
          return {
            success: false,
            proxyData: currentProxy,
            attempts: attempt,
            finalIp: null,
            error: `Proxy unreachable (${result.error})`,
          };
        }
      } else {
        consecutiveConnErrors = 0;
      }
      // Rotate session and try again
      currentProxy = {
        ...currentProxy,
        password: rotateRayobyteSessionId(currentProxy.password),
      };
      continue;
    }

    // Reached IPRegistry successfully — reset the connection-error counter.
    consecutiveConnErrors = 0;

    if (result.clean) {
      console.log(
        `[ProxyRotation] Found clean proxy on attempt ${attempt}: ${result.ip}`,
      );
      return {
        success: true,
        proxyData: currentProxy,
        attempts: attempt,
        finalIp: result.ip,
        security: result.security,
        location: result.location,
      };
    }

    console.log(
      `[ProxyRotation] Attempt ${attempt} - IP ${result.ip} is flagged:`,
      result.flaggedReasons.join(", ") || "unknown reason",
    );

    // If not a session proxy, can't rotate - return with last check result
    if (!isSessionProxy) {
      return {
        success: false,
        proxyData: currentProxy,
        attempts: attempt,
        finalIp: result.ip,
        flaggedReasons: result.flaggedReasons,
        security: result.security,
        error: "Proxy IP is flagged and cannot be rotated",
      };
    }

    // Rotate the session ID for next attempt
    if (attempt < maxAttempts) {
      currentProxy = {
        ...currentProxy,
        password: rotateRayobyteSessionId(currentProxy.password),
      };
    }
  }

  // Get final check result to return flagged reasons
  const finalResult = lastResult || (await checkProxyClean(currentProxy, ipregistryApiKey));

  console.error(
    `[ProxyRotation] Failed to find clean proxy after ${maxAttempts} attempts`,
  );
  return {
    success: false,
    proxyData: currentProxy,
    attempts: maxAttempts,
    finalIp: finalResult.ip,
    flaggedReasons: finalResult.flaggedReasons || [],
    security: finalResult.security,
    error: `Could not find clean proxy after ${maxAttempts} attempts`,
  };
}

// ============== AUTOMATION THUMBNAIL SYSTEM ==============
// Save a thumbnail image for an automation (from workflow output images)
// This is called when an automation runs for the first time with image outputs

/**
 * Save an automation thumbnail from a source image
 * @param {string} automationId - The automation ID to save thumbnail for
 * @param {string} sourceImagePath - Absolute path to the source image
 * @returns {Promise<{success: boolean, thumbnailPath?: string, error?: string}>}
 */
async function saveAutomationThumbnail(automationId, sourceImagePath) {
  try {
    if (!automationId || !sourceImagePath) {
      return { success: false, error: "Missing automationId or sourceImagePath" };
    }

    // Verify source image exists
    if (!fss.existsSync(sourceImagePath)) {
      console.log(`[Thumbnail] Source image not found: ${sourceImagePath}`);
      return { success: false, error: "Source image not found" };
    }

    // Create thumbnails directory
    const thumbnailsDir = path.join(app.getPath("userData"), "AutomationThumbnails");
    if (!fss.existsSync(thumbnailsDir)) {
      await fs.mkdir(thumbnailsDir, { recursive: true });
    }

    // Determine output filename (preserve extension from source)
    const sourceExt = path.extname(sourceImagePath).toLowerCase() || ".jpg";
    const thumbnailFilename = `thumb-${automationId}${sourceExt}`;
    const thumbnailPath = path.join(thumbnailsDir, thumbnailFilename);

    // Copy source image to thumbnails folder
    await fs.copyFile(sourceImagePath, thumbnailPath);

    // Update automation metadata with thumbnail path
    const automations = await readKey("automations") || [];
    const automationIndex = automations.findIndex(a => a.id === automationId);
    
    if (automationIndex !== -1) {
      automations[automationIndex].thumbnail = thumbnailFilename;
      automations[automationIndex].thumbnailUpdatedAt = Math.floor(Date.now() / 1000);
      await updateData("automations", automations);
      console.log(`[Thumbnail] Saved thumbnail for automation ${automationId}: ${thumbnailFilename}`);
    }

    return { success: true, thumbnailPath: thumbnailFilename };
  } catch (error) {
    console.error(`[Thumbnail] Error saving thumbnail for ${automationId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Check if an automation already has a thumbnail
 * @param {string} automationId - The automation ID to check
 * @returns {Promise<boolean>}
 */
async function automationHasThumbnail(automationId) {
  try {
    const automations = await readKey("automations") || [];
    const automation = automations.find(a => a.id === automationId);
    
    if (!automation || !automation.thumbnail) {
      return false;
    }

    // Verify the thumbnail file still exists
    const thumbnailPath = path.join(
      app.getPath("userData"),
      "AutomationThumbnails",
      automation.thumbnail
    );
    
    return fss.existsSync(thumbnailPath);
  } catch (error) {
    console.error(`[Thumbnail] Error checking thumbnail for ${automationId}:`, error.message);
    return false;
  }
}

/**
 * Move an image from temp storage to permanent storage
 * This prevents cleanup from deleting workflow output images after 24 hours
 * @param {string} tempPath - The path to the temp file (in Uploads/Temp) or data URL
 * @param {Object} options - Options for processing
 * @param {boolean} options.cleanAI - If true, strip embedded metadata and re-encode (default: false)
 * @param {Object} options.injectMetadata - Metadata injection config for fake device EXIF (optional)
 * @param {boolean} options.humanize - If true, apply the camera-realism humanization pipeline (default: false)
 * @param {number} options.humanizeIntensity - Global strength multiplier for humanization (default: 1)
 * @param {string} options.nodeType - The node type generating this image for SEO metadata (e.g., 'chatgpt-image', 'gpt-image')
 * @returns {Promise<{success: boolean, permanentPath?: string, error?: string}>}
 */
async function moveToPermStorage(tempPath, options = {}) {
  const { cleanAI = false, injectMetadata = null, nodeType = null, workflowId = null, prompt = null } = options;

  // Resolve humanization from the global setting when the caller does not pass
  // an explicit value. This makes humanization apply to EVERY output image that
  // routes through permanent storage (all image automation nodes + the manual
  // AI Image Cleaner) without having to edit each individual automation file.
  let humanize = options.humanize;
  let humanizeIntensity = options.humanizeIntensity;
  if (humanize === undefined) {
    try {
      const automationSettings = readKey('automationSettings') || {};
      humanize = automationSettings.imageHumanize !== false; // default ON
      if (humanizeIntensity === undefined) {
        const s = automationSettings.imageHumanizeIntensity;
        humanizeIntensity = typeof s === 'number' ? s : 1;
      }
    } catch (_) {
      humanize = false;
    }
  }
  if (humanizeIntensity === undefined) humanizeIntensity = 1;
  
  // Check if SEO metadata should be generated for this node type
  let seoMetadataConfig = null;
  if (nodeType) {
    try {
      const seoSettings = readKey('seoMetadataSettings') || {};
      // Use !== false to default to enabled for any node type not explicitly disabled
      // This matches the UI behavior where new node types default to checked
      if (seoSettings.enabled && seoSettings.nodeTypes?.[nodeType] !== false) {
        // Look up proxy based on workflowId -> automationId -> proxy profile
        let proxy = null;
        console.log(`[moveToPermStorage] Proxy lookup: workflowId=${workflowId}, proxyProfiles=${seoSettings.proxyProfiles?.length || 0}, automationProxies=${JSON.stringify(seoSettings.automationProxies || {})}`);
        if (workflowId && seoSettings.proxyProfiles?.length > 0 && seoSettings.automationProxies) {
          try {
            const workflowDb = require('./database');
            const workflow = workflowDb.getWorkflow(workflowId);
            const automationId = workflow?.automation_id;
            console.log(`[moveToPermStorage] Workflow automation_id: ${automationId}`);
            if (automationId) {
              const proxyName = seoSettings.automationProxies[automationId];
              console.log(`[moveToPermStorage] Proxy name for automation ${automationId}: ${proxyName || 'none'}`);
              if (proxyName) {
                proxy = seoSettings.proxyProfiles.find(p => p.name === proxyName);
                if (proxy) {
                  console.log(`[moveToPermStorage] Using proxy "${proxyName}" for automation ${automationId}: ${proxy.ip}:${proxy.port}`);
                } else {
                  console.log(`[moveToPermStorage] Proxy profile "${proxyName}" not found in profiles`);
                }
              }
            }
          } catch (dbErr) {
            console.warn('[moveToPermStorage] Error looking up automation proxy:', dbErr.message);
          }
        } else if (!workflowId) {
          console.log(`[moveToPermStorage] No workflowId provided - cannot look up automation proxy`);
        }
        
        seoMetadataConfig = { 
          enabled: true, 
          nodeType, 
          aiProvider: seoSettings.aiProvider || 'openai',
          proxy: proxy,
          prompt: prompt
        };
        console.log(`[moveToPermStorage] SEO metadata enabled for node type: ${nodeType}`);
      }
    } catch (err) {
      console.warn('[moveToPermStorage] Error checking SEO settings:', err.message);
    }
  }
  
  try {
    if (!tempPath) {
      return { success: false, error: "No path provided" };
    }

    const imagesDir = path.join(app.getPath("userData"), "Images");
    await fs.mkdir(imagesDir, { recursive: true });

    // If it's a data URL (base64), save it directly to Images folder
    if (tempPath.startsWith("data:")) {
      let dataToSave = tempPath;
      let ext;

      // Clean and/or humanize AI image if requested
      if (cleanAI || humanize) {
        console.log(`[moveToPermStorage] Processing AI-generated image (data URL)... clean=${cleanAI}, humanize=${humanize}`);
        const cleanOptions = {
          ...(injectMetadata ? { injectMetadata } : {}),
          ...(humanize ? { humanize: true, humanizeIntensity } : {})
        };
        const cleanResult = await cleanDataUrl(tempPath, cleanOptions);
        if (cleanResult.success) {
          dataToSave = cleanResult.dataUrl;
          ext = cleanResult.format === 'jpeg' ? 'jpg' : cleanResult.format;
          console.log(`[moveToPermStorage] Image cleaned, format: ${cleanResult.format}`);
        } else {
          console.warn('[moveToPermStorage] Failed to clean image, using original:', cleanResult.error);
        }
      }

      // Extract mime type and base64 data
      const matches = dataToSave.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!matches) {
        return { success: false, error: "Invalid data URL format" };
      }

      if (!ext) {
        ext = matches[1] === "jpeg" ? "jpg" : matches[1];
      }
      const base64Data = matches[2];
      const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
      const permanentPath = path.join(imagesDir, filename);

      await fs.writeFile(permanentPath, Buffer.from(base64Data, "base64"));
      console.log(`[moveToPermStorage] Saved data URL to: ${permanentPath}`);

      // Apply SEO metadata if enabled (convert to JPEG first since EXIF only works with JPEG)
      if (seoMetadataConfig?.enabled) {
        try {
          const sharp = require('sharp');
          const jpegBuffer = await sharp(permanentPath).jpeg({ quality: 96 }).toBuffer();
          const jpegPath = permanentPath.replace(/\.[^.]+$/, '.jpg');
          await fs.writeFile(jpegPath, jpegBuffer);
          // Remove original if extension changed
          if (jpegPath !== permanentPath) {
            try { await fs.unlink(permanentPath); } catch (_) {}
          }

          const { generateSEOMetadata } = require('./seoMetadataGenerator');
          const { injectExifMetadata } = require('./imageClean');

          console.log(`[moveToPermStorage] Generating SEO metadata for data URL image (${seoMetadataConfig.nodeType})...`);
          const seoResult = await generateSEOMetadata(jpegPath, {
            aiProvider: seoMetadataConfig.aiProvider,
            aiSettings: {},
            proxy: seoMetadataConfig.proxy || null,
            prompt: seoMetadataConfig.prompt || null
          });

          if (seoResult.success && seoResult.metadata) {
            const imageBuffer = await fs.readFile(jpegPath);
            const resultBuffer = await injectExifMetadata(imageBuffer, { seo: seoResult.metadata });
            await fs.writeFile(jpegPath, resultBuffer);
            console.log(`[moveToPermStorage] SEO metadata applied to data URL image: "${seoResult.metadata.title}" (${seoResult.metadata.keywords?.length || 0} keywords)`);
          } else if (seoResult.skipped) {
            console.warn(`[moveToPermStorage] SEO metadata skipped for data URL image: no text context available`);
            try {
              const win = BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('show-main-alert', { type: 'warning', i18nKey: 'settings.seo_metadata_skipped_warning', message: 'SEO metadata was skipped: no text context (prompt/title) available for this image.' });
            } catch (_) {}
          } else {
            console.warn(`[moveToPermStorage] SEO metadata generation failed for data URL image:`, seoResult.error);
          }
          return { success: true, permanentPath: jpegPath };
        } catch (seoError) {
          console.warn(`[moveToPermStorage] SEO metadata error for data URL image (non-fatal):`, seoError.message);
          return { success: true, permanentPath };
        }
      }

      return { success: true, permanentPath };
    }

    // If it's a URL, skip - those don't need permanent storage
    if (tempPath.startsWith("http://") || tempPath.startsWith("https://")) {
      return { success: true, permanentPath: tempPath };
    }

    // Check if file exists
    if (!fss.existsSync(tempPath)) {
      return { success: false, error: `File not found: ${tempPath}` };
    }

    // Check if already in permanent storage (Images folder)
    if (tempPath.startsWith(imagesDir)) {
      // If cleaning/humanization requested on already-stored file, process it in place
      if (cleanAI || humanize) {
        console.log(`[moveToPermStorage] Processing AI-generated image (already in storage)... clean=${cleanAI}, humanize=${humanize}`);
        const inputBuffer = await fs.readFile(tempPath);
        const cleanOptions = {
          ...(injectMetadata ? { injectMetadata } : {}),
          ...(humanize ? { humanize: true, humanizeIntensity } : {})
        };
        const cleanResult = await cleanImage(inputBuffer, cleanOptions);
        if (cleanResult.success) {
          // Determine new extension based on cleaned format
          const oldExt = path.extname(tempPath);
          const newExt = cleanResult.format === 'jpeg' ? '.jpg' 
                       : cleanResult.format === 'webp' ? '.webp' 
                       : '.png';
          const newPath = tempPath.replace(oldExt, newExt);
          await fs.writeFile(newPath, cleanResult.buffer);
          // Remove old file if extension changed
          if (newPath !== tempPath) {
            try { await fs.unlink(tempPath); } catch (_) {}
          }
          console.log(`[moveToPermStorage] Cleaned in-place: ${newPath}`);
          return { success: true, permanentPath: newPath };
        } else {
          console.warn('[moveToPermStorage] Failed to clean, keeping original:', cleanResult.error);
        }
      }
      return { success: true, permanentPath: tempPath };
    }

    // Process the image
    let finalBuffer;
    let finalExt = path.extname(tempPath) || ".jpg";
    const baseName = path.basename(tempPath, finalExt);

    // Determine if we need JPEG for SEO metadata
    const needsJpegForSeo = seoMetadataConfig?.enabled;

    if (cleanAI || humanize) {
      // Clean and/or humanize AI image before saving
      console.log(`[moveToPermStorage] Processing AI-generated image (file)... clean=${cleanAI}, humanize=${humanize}`);
      const inputBuffer = await fs.readFile(tempPath);
      const cleanOptions = {
        ...(injectMetadata ? { injectMetadata } : {}),
        ...(humanize ? { humanize: true, humanizeIntensity } : {})
      };
      // Force JPEG if SEO metadata is enabled (EXIF only works with JPEG)
      if (needsJpegForSeo) {
        cleanOptions.forceFormat = 'jpeg';
      }
      const cleanResult = await cleanImage(inputBuffer, cleanOptions);
      if (cleanResult.success) {
        finalBuffer = cleanResult.buffer;
        finalExt = cleanResult.format === 'jpeg' ? '.jpg' 
                 : cleanResult.format === 'webp' ? '.webp' 
                 : '.png';
        console.log(`[moveToPermStorage] Image cleaned, format: ${cleanResult.format}`);
      } else {
        console.warn('[moveToPermStorage] Failed to clean, copying original:', cleanResult.error);
        finalBuffer = await fs.readFile(tempPath);
      }
    } else if (needsJpegForSeo) {
      // Convert to JPEG for SEO metadata even if not cleaning
      console.log('[moveToPermStorage] Converting to JPEG for SEO metadata...');
      const inputBuffer = await fs.readFile(tempPath);
      const sharp = require('sharp');
      finalBuffer = await sharp(inputBuffer).jpeg({ quality: 96 }).toBuffer();
      finalExt = '.jpg';
    } else {
      finalBuffer = await fs.readFile(tempPath);
    }

    const filename = `${baseName}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${finalExt}`;
    const permanentPath = path.join(imagesDir, filename);

    await fs.writeFile(permanentPath, finalBuffer);
    console.log(`[moveToPermStorage] Saved ${tempPath} -> ${permanentPath}${cleanAI ? ' (cleaned)' : ''}`);

    // Generate and apply SEO metadata if enabled for this node type
    if (seoMetadataConfig?.enabled && permanentPath && /\.(jpg|jpeg)$/i.test(permanentPath)) {
      try {
        const { generateSEOMetadata } = require('./seoMetadataGenerator');
        const { injectExifMetadata } = require('./imageClean');
        
        console.log(`[moveToPermStorage] Generating SEO metadata for ${seoMetadataConfig.nodeType}...`);
        const seoResult = await generateSEOMetadata(permanentPath, {
          aiProvider: seoMetadataConfig.aiProvider,
          aiSettings: {},
          proxy: seoMetadataConfig.proxy || null,
          prompt: seoMetadataConfig.prompt || null
        });
        
        if (seoResult.success && seoResult.metadata) {
          const imageBuffer = fss.readFileSync(permanentPath);
          const resultBuffer = await injectExifMetadata(imageBuffer, { seo: seoResult.metadata });
          await fs.writeFile(permanentPath, resultBuffer);
          console.log(`[moveToPermStorage] SEO metadata applied: "${seoResult.metadata.title}" (${seoResult.metadata.keywords?.length || 0} keywords)`);
        } else if (seoResult.skipped) {
          console.warn(`[moveToPermStorage] SEO metadata skipped: no text context available`);
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send('show-main-alert', { type: 'warning', i18nKey: 'settings.seo_metadata_skipped_warning', message: 'SEO metadata was skipped: no text context (prompt/title) available for this image.' });
          } catch (_) {}
        } else {
          console.warn(`[moveToPermStorage] SEO metadata generation failed:`, seoResult.error);
        }
      } catch (seoError) {
        console.warn(`[moveToPermStorage] SEO metadata error (non-fatal):`, seoError.message);
        // Don't fail the save, just skip SEO metadata
      }
    }

    return { success: true, permanentPath };
  } catch (error) {
    console.error("[moveToPermStorage] Error:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Move multiple images to permanent storage
 * @param {string[]} tempPaths - Array of temp file paths
 * @param {Object} options - Options passed to moveToPermStorage (cleanAI, injectMetadata, nodeType)
 * @returns {Promise<{success: boolean, permanentPaths?: string[], errors?: string[]}>}
 */
async function moveMultipleToPermStorage(tempPaths, options = {}) {
  if (!Array.isArray(tempPaths) || tempPaths.length === 0) {
    return { success: false, errors: ["No paths provided"] };
  }

  const permanentPaths = [];
  const errors = [];

  for (const tempPath of tempPaths) {
    const result = await moveToPermStorage(tempPath, options);
    if (result.success) {
      permanentPaths.push(result.permanentPath);
    } else {
      errors.push(`${tempPath}: ${result.error}`);
    }
  }

  return {
    success: errors.length === 0,
    permanentPaths,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Extract image paths from workflow output for thumbnail selection
 * @param {object} finalOutputs - The finalOutputs object from executeAutomation
 * @returns {string[]} Array of image paths (local file paths only)
 */
function extractImagePathsFromOutputs(finalOutputs) {
  const imagePaths = [];

  if (!finalOutputs) return imagePaths;

  // Check Facebook outputs
  if (finalOutputs.facebook && finalOutputs.facebook.image) {
    const fbImage = finalOutputs.facebook.image;
    if (typeof fbImage === "string" && !fbImage.startsWith("http") && fss.existsSync(fbImage)) {
      imagePaths.push(fbImage);
    } else if (Array.isArray(fbImage)) {
      fbImage.forEach(img => {
        if (typeof img === "string" && !img.startsWith("http") && fss.existsSync(img)) {
          imagePaths.push(img);
        }
      });
    }
  }

  // Check Pinterest outputs
  if (finalOutputs.pinterest && finalOutputs.pinterest.image) {
    const pImage = finalOutputs.pinterest.image;
    if (typeof pImage === "string" && !pImage.startsWith("http") && fss.existsSync(pImage)) {
      imagePaths.push(pImage);
    } else if (Array.isArray(pImage)) {
      pImage.forEach(img => {
        if (typeof img === "string" && !img.startsWith("http") && fss.existsSync(img)) {
          imagePaths.push(img);
        }
      });
    }
  }

  return imagePaths;
}

// =============================================
// AI USAGE TRACKING
// Track token consumption for all AI providers
// =============================================

// In-memory queue for batching AI usage tracking requests
const aiUsageTrackingState = {
  queue: [],
  flushTimer: null,
  flushIntervalMs: 2000, // Flush every 2 seconds (reduced for faster visibility)
  maxQueueSize: 20, // Or when queue reaches this size
  isFlushing: false
};

/**
 * Track AI usage by sending raw data to backend
 * Backend calculates cost server-side for security
 * 
 * @param {string} provider - openai, anthropic, googleai, chineseai, openrouter, gptimage
 * @param {string} model - Model name/ID used
 * @param {object} usage - Usage object from API response
 * @param {string} requestType - text, vision, or image_generation
 * @param {string} workflowId - Optional workflow ID for context
 */
async function trackAIUsage() { /* Provider usage stays with the provider; no telemetry. */ }

/**
 * Flush the AI usage queue to the backend
 */
async function flushAIUsageQueue() {}

// Flush on app exit
process.on('beforeExit', () => {
  if (aiUsageTrackingState.queue.length > 0) {
    flushAIUsageQueue().catch(() => {});
  }
});

// =========================================================================
// Profile Browser Registry
// Tracks non-headless VCBrowser processes opened via open-stealth-profile
// so they can be killed when a Google account disconnection is detected.
// =========================================================================
const profileBrowserRegistry = new Map(); // profileId -> chromeProcess

function registerProfileBrowser(profileId, chromeProcess) {
  profileBrowserRegistry.set(profileId, chromeProcess);
}

function deregisterProfileBrowser(profileId) {
  profileBrowserRegistry.delete(profileId);
}

function killProfileBrowser(profileId) {
  const proc = profileBrowserRegistry.get(profileId);
  if (proc && !proc.killed) {
    try {
      proc.kill();
      console.log(`[ProfileBrowserRegistry] Killed open browser for profile: ${profileId}`);
    } catch (err) {
      console.error(`[ProfileBrowserRegistry] Failed to kill browser for ${profileId}:`, err.message);
    }
  }
  profileBrowserRegistry.delete(profileId);
}

module.exports = {
  showAlert,
  ensureStorageExists,
  readKey,
  readKeys,
  updateData,
  downloadFileToUserData,
  trackLoginStatus,
  cancelTestLogin,
  startBrowser,
  startSpying,
  startSpyBrowser,
  startBareChrome,
  cleanProfileCacheAfterClose,
  prepareFreshExtension,
  // DEPRECATED: updateFingerprintExtension - kept for backwards compatibility but unused
  updateFingerprintExtension,
  updateProxyBackground,
  getRandomInt,
  // Permanent storage functions for workflow images
  moveToPermStorage,
  moveMultipleToPermStorage,
  extractDiscordFields,
  generateRandomString,
  encrypt,
  decrypt,
  init,
  findChromeExe,
  // DEPRECATED: fingerprint functions now in cdpFingerprint.js - kept for backwards compatibility
  getConsistentFingerprintForProfile,
  getRealMachineFingerprint,
  terminateAllSpyProcesses,
  prepareFreshSpyExtension,
  triggerCleanupIfNeeded,
  cleanupTempFiles,
  isPostIdSeen,
  addToSeenPostIds,
  getSeenPostInfo,
  updateSeenPostShares,
  markPostAddedToLibrary,
  markSpyPostAsUsed,
  resetSpyPostUsedStatus,
  getSpyPostsFiltered,
  // ISE (Image Search Engine) functions
  hashUrl,
  hideIseImage,
  isIseImageHidden,
  getHiddenIseImageHashes,
  unhideIseImage,
  clearHiddenIseImages,
  markIseImageUsed,
  isIseImageUsed,
  getUsedIseImageHashes,
  clearUsedIseImages,
  getAvailableLocaleCountries,
  getUserCountryCode,
  repairProfile,
  unlockProfile,
  // Proxy rotation functions
  isRayobyteSessionProxy,
  checkProxyClean,
  findCleanProxy,
  // Encryption with migration support
  decryptWithMigration,
  getEncryptionKey,
  // Portable encryption for automation export/import (cross-machine)
  encryptPortable,
  decryptPortable,
  decryptAutomation,
  // Locale functions
  getUserLocaleBundle,
  // Startup cleanup functions (used by frontend precheck)
  getStartupCleanupStatus,
  runStartupCleanup,
  // Automation thumbnail functions
  saveAutomationThumbnail,
  automationHasThumbnail,
  extractImagePathsFromOutputs,
  // AI Usage tracking
  trackAIUsage,
  // Chrome version from public API
  getStableChromeVersion,
  // FeedSpy support
  enqueueSpyPost,
  // Profile browser registry (for killing open reconnect browsers on disconnection)
  registerProfileBrowser,
  deregisterProfileBrowser,
  killProfileBrowser,
  // Stable device ID resolver (must be used for every authenticated server call)
};

// Get cleanup status for startup (used by precheck page)
async function getStartupCleanupStatus() {
  const { CleanupManager } = require("./cleanup");
  try {
    const cleanupManager = new CleanupManager();
    const status = await cleanupManager.getCleanupStatus();
    
    const tempFilesCount = status.tempUploads ? status.tempUploads.count : 0;
    const tempFilesSize = status.tempUploads ? status.tempUploads.size : 0;
    const audioCount = status.unreferencedAudio ? status.unreferencedAudio.count : 0;
    const videosCount = status.unreferencedVideos ? status.unreferencedVideos.count : 0;
    
    const shouldClean =
      status.totalSize > 100 * 1024 * 1024 || // 100MB total
      status.orphanedProfiles.count + status.unreferencedImages.count + audioCount + videosCount + tempFilesCount > 50 ||
      tempFilesSize > 500 * 1024 * 1024; // 500MB of temp files alone
    
    return {
      success: true,
      needsCleanup: shouldClean,
      orphanedProfiles: status.orphanedProfiles.count,
      unreferencedImages: status.unreferencedImages.count,
      unreferencedAudio: audioCount,
      unreferencedVideos: videosCount,
      tempFiles: tempFilesCount,
      totalSize: status.totalSize,
      formattedSize: status.totalFormattedSize,
      details: {
        profiles: status.orphanedProfiles.formattedSize,
        images: status.unreferencedImages.formattedSize,
        audio: status.unreferencedAudio ? status.unreferencedAudio.formattedSize : "0 B",
        videos: status.unreferencedVideos ? status.unreferencedVideos.formattedSize : "0 B",
        temp: status.tempUploads ? status.tempUploads.formattedSize : "0 B"
      }
    };
  } catch (error) {
    console.error("[CLEANUP] Error getting startup status:", error.message);
    return { success: false, needsCleanup: false, error: error.message };
  }
}

// Run startup cleanup with progress callback (used by precheck page)
async function runStartupCleanup(progressCallback) {
  const { CleanupManager } = require("./cleanup");
  try {
    const cleanupManager = new CleanupManager();
    
    // Send initial progress
    if (progressCallback) progressCallback({ phase: 'profiles', message: 'Cleaning orphaned profiles...', progress: 0 });
    
    const profileResults = await cleanupManager.cleanupProfiles(false);
    if (progressCallback) progressCallback({ 
      phase: 'profiles', 
      message: `Cleaned ${profileResults.removed.length} orphaned profiles`, 
      progress: 33,
      size: cleanupManager.formatFileSize(profileResults.totalSize)
    });
    
    if (progressCallback) progressCallback({ phase: 'images', message: 'Cleaning unreferenced images...', progress: 33 });
    
    const imageResults = await cleanupManager.cleanupImages(false);
    if (progressCallback) progressCallback({ 
      phase: 'images', 
      message: `Cleaned ${imageResults.removed.length} unreferenced images`, 
      progress: 66,
      size: cleanupManager.formatFileSize(imageResults.totalSize)
    });
    
    if (progressCallback) progressCallback({ phase: 'temp', message: 'Cleaning temp files...', progress: 66 });
    
    const tempResults = await cleanupManager.cleanupTempUploads(false);
    if (progressCallback) progressCallback({ 
      phase: 'temp', 
      message: `Cleaned ${tempResults.removed.length} temp files`, 
      progress: 100,
      size: cleanupManager.formatFileSize(tempResults.totalSize)
    });
    
    const totalSize = profileResults.totalSize + imageResults.totalSize + tempResults.totalSize;
    const totalRemoved = profileResults.removed.length + imageResults.removed.length + tempResults.removed.length;
    
    console.log(`[CLEANUP] Startup cleanup completed: ${totalRemoved} items removed, ${cleanupManager.formatFileSize(totalSize)} freed`);
    
    return {
      success: true,
      totalRemoved,
      totalSize,
      formattedSize: cleanupManager.formatFileSize(totalSize),
      profiles: profileResults.removed.length,
      images: imageResults.removed.length,
      temp: tempResults.removed.length
    };
  } catch (error) {
    console.error("[CLEANUP] Error during startup cleanup:", error.message);
    return { success: false, error: error.message };
  }
}
