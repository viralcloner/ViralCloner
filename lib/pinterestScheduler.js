const { collectPinterestAnalytics } = require("./pinterestAnalyticsCollector");
const { getPinterestAnalyticsDatabase } = require("./pinterestAnalytics");
const { readKey } = require("./utils");

const MODULE = "[PinterestScheduler]";

// Global scheduler state so it can be restarted from IPC
global.pinterestScheduler = {
  initialTimer: null,
  nextRunTimer: null,
  repeatInterval: null,
  isCollecting: false,
  lastCollectionTime: null,
  nextScheduledTime: null,
};

async function runPinterestCollection() {
  global.pinterestScheduler.isCollecting = true;
  try {
    console.log(`${MODULE} Collection starting...`);
    // Respect the user's saved account selection (null = all accounts)
    let selectedAccounts = null;
    try {
      const settings = (await readKey("pinterestCollectionSettings")) || {};
      if (Array.isArray(settings.selectedAccounts) && settings.selectedAccounts.length > 0) {
        selectedAccounts = settings.selectedAccounts;
      }
    } catch (e) { /* fall back to all accounts */ }
    await collectPinterestAnalytics(false, selectedAccounts);
    global.pinterestScheduler.lastCollectionTime = new Date().toISOString();
    const pDb = getPinterestAnalyticsDatabase();
    pDb.pruneOldData(365);
  } catch (error) {
    console.error(`${MODULE} Collection failed:`, error.message);
  } finally {
    global.pinterestScheduler.isCollecting = false;
  }
}

function clearPinterestTimers() {
  const s = global.pinterestScheduler;
  if (s.initialTimer) { clearTimeout(s.initialTimer); s.initialTimer = null; }
  if (s.nextRunTimer) { clearTimeout(s.nextRunTimer); s.nextRunTimer = null; }
  if (s.repeatInterval) { clearInterval(s.repeatInterval); s.repeatInterval = null; }
  s.nextScheduledTime = null;
}

function schedulePinterestRepeat(intervalMs) {
  global.pinterestScheduler.repeatInterval = setInterval(async () => {
    await runPinterestCollection();
    global.pinterestScheduler.nextScheduledTime = new Date(Date.now() + intervalMs).toISOString();
  }, intervalMs);
  global.pinterestScheduler.nextScheduledTime = new Date(Date.now() + intervalMs).toISOString();
}

async function startPinterestScheduler() {
  clearPinterestTimers();
  const settings = (await readKey("pinterestCollectionSettings")) || { enabled: false, intervalHours: 24 };
  if (!settings.enabled) {
    console.log(`${MODULE} Auto-collection is disabled`);
    return;
  }

  const intervalHours = settings.intervalHours || 24;
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Check if we collected recently enough to skip the initial run
  let skipInitial = false;
  try {
    const pDb = getPinterestAnalyticsDatabase();
    const lastFetch = pDb.getLatestFetchTime();
    if (lastFetch) {
      const elapsed = Date.now() - new Date(lastFetch).getTime();
      if (elapsed < intervalMs) {
        skipInitial = true;
        const nextMs = intervalMs - elapsed;
        console.log(`${MODULE} Last collection was ${Math.round(elapsed / 3600000)}h ago, next in ${Math.round(nextMs / 3600000)}h`);
        global.pinterestScheduler.initialTimer = setTimeout(async () => {
          await runPinterestCollection();
          schedulePinterestRepeat(intervalMs);
        }, nextMs);
        global.pinterestScheduler.nextScheduledTime = new Date(Date.now() + nextMs).toISOString();
      }
    }
  } catch (e) {
    console.error(`${MODULE} Error checking last fetch time:`, e.message);
  }

  if (!skipInitial) {
    // Initial collection 5 minutes after launch
    global.pinterestScheduler.initialTimer = setTimeout(async () => {
      await runPinterestCollection();
      schedulePinterestRepeat(intervalMs);
    }, 5 * 60 * 1000);
    global.pinterestScheduler.nextScheduledTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    console.log(`${MODULE} Initial collection in 5 minutes, then every ${intervalHours}h`);
  }
}

function initPinterestScheduler() {
  // Initial cleanup
  try {
    const pinterestDb = getPinterestAnalyticsDatabase();
    const pCleanup = pinterestDb.pruneOldData(365);
    if (pCleanup.totalDeleted > 0) {
      console.log(`${MODULE} Initial cleanup: removed ${pCleanup.totalDeleted} old records`);
    }
  } catch (error) {
    console.error(`${MODULE} Initial cleanup failed:`, error.message);
  }

  // Expose restarter globally so IPC handlers can call it
  global.restartPinterestScheduler = startPinterestScheduler;

  startPinterestScheduler();
}

module.exports = { initPinterestScheduler };
