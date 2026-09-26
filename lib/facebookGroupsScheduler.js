/**
 * FBGroupsScheduler
 * Drives automated posting from imported workflows to Facebook groups.
 * Runs two intervals:
 *   - postTick  (every 60s): processes one pending post per active workflow/group target
 *   - monitorTick (every 5min): checks viral monitors and fires edit actions at threshold
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');
const { readKey, updateData, findCleanProxy, isRayobyteSessionProxy } = require('./utils');
const { isCommentRateLimited } = require('./facebookHttpSession');
const { executeAutomation } = require('./executeAutomation');
const { facebookGroupPost, recoverPostId, classifyFbError, isAccountLevelBlock } = require('../automations/facebookGroups/facebookGroupPost');
const { facebookGroupComment } = require('../automations/facebookGroups/facebookGroupComment');
const { facebookGroupEditComment } = require('../automations/facebookGroups/facebookGroupEditComment');
const { facebookGroupEditPost } = require('../automations/facebookGroups/facebookGroupEditPost');
const { facebookGroupScanPost } = require('../automations/facebookGroups/facebookGroupScanPost');
const { facebookGroupFeedScan } = require('../automations/facebookGroups/facebookGroupFeedScan');
const { facebookGroupScanInfo } = require('../automations/facebookGroups/facebookGroupScanInfo');
const { facebookProfileScanInfo } = require('../automations/facebookGroups/facebookProfileScanInfo');
const { isBusy: _isProfileSessionBusy } = require('./facebookProfileLock');
const { varyContent } = require('../automations/facebookGroups/contentVariation');
const workflowDb = require('./database');
const { reportClientError } = require('./remoteErrorLogger');
const facebookGroupsImageStore = require('./facebookGroupsImageStore');
// AI providers (lazy-loaded to avoid startup cost)
const AI_PROVIDERS = {
  openai:           () => require('../automations/openai').openAi,
  googleai:         () => require('../automations/googleai').googleAI,
  anthropic:        () => require('../automations/anthropic').anthropic,
  openrouter:       () => require('../automations/openrouter').openRouter,
  chineseai:        () => require('../automations/chineseai').chineseAI,
  // aliases so deepseek/qwen/zhipu/moonshot all route through chineseai (API)
  deepseek:         () => require('../automations/chineseai').chineseAI,
  qwen:             () => require('../automations/chineseai').chineseAI,
  zhipu:            () => require('../automations/chineseai').chineseAI,
  moonshot:         () => require('../automations/chineseai').chineseAI,
  // browser-based (no API key needed)
  deepseekbrowser:  () => require('../automations/deepseekBrowser').deepseekBrowser,
  qwenbrowser:      () => require('../automations/qwenBrowser').qwenBrowser,
};

const POST_TICK_MS    = 60 * 1000;       // 1 minute
const MONITOR_TICK_MS = 30 * 1000;       // 30 seconds — polls cheaply; HTTP scans only fire when a monitor is actually due
const SCAN_TICK_MS    = 30 * 60 * 1000;  // 30 minutes — checks which groups are due for their daily info scan
const RECOVER_TICK_MS = 10 * 60 * 1000;  // 10 minutes — re-checks disconnected profiles so they auto-recover after reconnection
const RECOVER_STALE_MS = 9 * 60 * 1000;  // only re-check a flagged profile if its last scan is older than this
const RECOVER_MAX_PER_PASS = 5;          // cap browsers opened per recovery pass
const MAX_CONCURRENT_SCAN_SESSIONS = 1;  // max simultaneous human-like viral scan browser sessions
const MAX_LOG_BUFFER  = 200;
const IMAGE_MIGRATION_VERSION = 1;
const IMAGE_MIGRATION_KEY = 'fbGroupsImageMigrationVersion';

class FBGroupsScheduler {
  constructor(fbGroupsDb) {
    this.db             = fbGroupsDb;
    this.postInterval   = null;
    this.monitorInterval = null;
    this.scanInterval    = null;
    this.recoverInterval = null;
    this.runningWorkflows   = new Set(); // mutex: prevent concurrent ticks for same workflow
    this.runningMonitors    = new Set(); // mutex: prevent concurrent checks of same monitor
    this.runningScanSessions = new Set(); // mutex: prevent concurrent batched viral scan sessions per group
    this.runningScans       = new Set(); // mutex: prevent concurrent info scans of same group
    this.runningProfileScans = new Set(); // mutex: prevent concurrent scans of same profile
    this.cancelledWorkflows  = new Set(); // workflows deleted while in-flight
    this.activeProfiles      = new Set(); // profiles currently occupied by any browser operation
    this._monitorTickRunning = false;     // prevents concurrent monitor tick executions
    this._recoverTickRunning = false;     // prevents concurrent flagged-profile recovery passes
    this.liveLogBuffer       = [];
    this.profileDailyCount   = new Map(); // profileId → { count: number, date: 'YYYY-MM-DD' } (in-flight reservation only)
    this.profileActivity     = new Map(); // profileId → { status, detail, groupId, groupName, workflowName, timestamp }
    this.profileNextPostAt   = new Map(); // profileId → ms epoch of the earliest next allowed post (global per-profile gap, anti-ban)
    this._viralCheckMs       = null;      // user-configured viral check interval (ms); null → use tiered back-off
    this._imageMigrationStarted = false;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (this.postInterval) this.stop();
    this._migrateStoredFacebookImages();
    // ── Restart recovery ──────────────────────────────────────────────────
    // 1) Clear posts left mid-flight when the app was closed (status='running').
    try {
      const cleared = this.db.resetStaleRunningPosts();
      if (cleared > 0) this._log('info', `Restart recovery: cleared ${cleared} interrupted post(s)`);
    } catch (_) {}
    // 2) Anti-burst: any active workflow that already posted before but is now overdue
    //    gets a fresh full delay measured from now, so reopening doesn't fire a burst.
    try {
      const activeWfs = this.db.getImportedWorkflows().filter(w => w.status === 'active' && !w.isCompleted);
      for (const wf of activeWfs) {
        const delayMs = Math.max(1, Number(wf.delayMinutes) || 1) * 60 * 1000;
        const nextIso = new Date(Date.now() + delayMs).toISOString();
        this.db.rescheduleOverdueTargets(wf.workflowId, nextIso);
      }
    } catch (e) { this._log('error', `Restart reschedule error: ${e.message}`); }

    this.postInterval    = setInterval(() => this._postTick(),    POST_TICK_MS);
    this.monitorInterval = setInterval(() => this._monitorTick(), MONITOR_TICK_MS);
    this.scanInterval    = setInterval(() => this._scanTick(),    SCAN_TICK_MS);
    // NOTE: auto-recovery of disconnected profiles is intentionally DISABLED.
    // A profile flagged as disconnected must stay untouched until the user
    // explicitly clicks "Mark as working" (markProfileWorking). We never reopen a
    // browser in the background for a disconnected profile.
    // Fire post tick immediately so completion checks don't wait a full minute after restart
    setTimeout(() => this._postTick(), 500);
    // Fire monitor tick shortly after so due viral checks resume promptly on reopen
    setTimeout(() => this._monitorTick(), 1500);
    // Run a scan sweep a few seconds after startup so freshly-due groups refresh promptly
    setTimeout(() => this._scanTick(), 8000);
    this._log('info', 'FB Groups Scheduler started', { lifecycle: true });
  }

  stop() {
    if (this.postInterval)    { clearInterval(this.postInterval);    this.postInterval    = null; }
    if (this.monitorInterval) { clearInterval(this.monitorInterval); this.monitorInterval = null; }
    if (this.scanInterval)    { clearInterval(this.scanInterval);    this.scanInterval    = null; }
    if (this.recoverInterval) { clearInterval(this.recoverInterval); this.recoverInterval = null; }
    this._log('info', 'FB Groups Scheduler stopped', { lifecycle: true });
  }

  getLiveLogs() { return [...this.liveLogBuffer]; }

  // Snapshot of what every tracked profile is doing right now (for the Profiles page).
  getProfileActivity() { return Array.from(this.profileActivity.values()); }

  // Immediately run a specific workflow without waiting for the next tick.
  // Used when a workflow is activated or restarted from the UI.
  runWorkflowNow(workflowId) {
    if (this.runningWorkflows.has(workflowId)) return; // already in-flight
    const wf = this.db.getImportedWorkflows().find(w => w.workflowId === workflowId);
    if (!wf || wf.status !== 'active') return;
    this.runningWorkflows.add(workflowId);
    this._processWorkflow(wf)
      .catch(e => this._log('error', `Workflow "${wf.name}" error: ${e.message}`, { workflowId }))
      .finally(() => { this.runningWorkflows.delete(workflowId); this.cancelledWorkflows.delete(workflowId); });
  }

  // ─── Group info scanning ──────────────────────────────────────────────────

  // Resolve the auto-scan interval (hours) from global settings. Returns null
  // when auto-scan is globally disabled. Defaults to 24h.
  async _getScanIntervalHours() {
    try {
      const s = (await readKey('fbGroupsGlobalSettings')) || {};
      if (s.autoScanEnabled === false) return null;
      const h = Number(s.autoScanIntervalHours);
      return (h && h > 0) ? h : 24;
    } catch (_) { return 24; }
  }

  // Periodic sweep: scans every group whose cached info is older than the interval.
  async _scanTick() {
    let intervalHours;
    try { intervalHours = await this._getScanIntervalHours(); } catch (_) { intervalHours = 24; }
    if (intervalHours == null) return; // globally disabled

    const cutoffIso = new Date(Date.now() - intervalHours * 3600 * 1000).toISOString();
    let due = [];
    try { due = this.db.getGroupsDueForScan(cutoffIso); }
    catch (e) { this._log('error', `Scan sweep error: ${e.message}`); return; }
    if (!due.length) return;

    this._log('info', `Auto-scan: ${due.length} group(s) due for info refresh`);
    for (const g of due) {
      try {
        await this.scanGroupNow(g.groupId);
        await new Promise(r => setTimeout(r, 4000)); // gentle spacing between groups
      } catch (e) {
        this._log('error', `Auto-scan group ${g.groupId} failed: ${e.message}`, { groupId: g.groupId });
      }
    }

    // Same sweep for linked profiles: verify login health + refresh identity.
    let dueProfiles = [];
    try { dueProfiles = this.db.getProfilesDueForScan(cutoffIso); }
    catch (e) { this._log('error', `Profile scan sweep error: ${e.message}`); return; }
    if (!dueProfiles.length) return;

    this._log('info', `Auto-scan: ${dueProfiles.length} profile(s) due for health/identity refresh`);
    for (const p of dueProfiles) {
      try {
        await this.scanProfileNow(p.profileId, p.profileLabel);
        await new Promise(r => setTimeout(r, 4000)); // gentle spacing between profiles
      } catch (e) {
        this._log('error', `Auto-scan profile ${p.profileId} failed: ${e.message}`, { profileId: p.profileId });
      }
    }
  }

  // Auto-recovery sweep: re-checks profiles currently flagged as disconnected so
  // that, once the user reconnects them, the flag clears on its own without any
  // manual "mark as working" / scan click. Runs on a short interval (independent
  // of the 24h health sweep, which deliberately skips freshly-flagged profiles).
  // A successful scan calls saveProfileScan(loggedIn:true), which clears the flag
  // and broadcasts 'fb-groups-profile-scanned' to refresh the card live.
  async _recoverFlaggedProfiles() {
    if (this._recoverTickRunning) return;
    this._recoverTickRunning = true;
    try {
      // Respect the global auto-scan switch — if the user disabled scanning, don't
      // open browsers in the background.
      let intervalHours;
      try { intervalHours = await this._getScanIntervalHours(); } catch (_) { intervalHours = 24; }
      if (intervalHours == null) return; // globally disabled

      const staleBeforeIso = new Date(Date.now() - RECOVER_STALE_MS).toISOString();
      let flagged = [];
      try { flagged = this.db.getFlaggedProfiles(staleBeforeIso, RECOVER_MAX_PER_PASS); }
      catch (e) { this._log('error', `Flagged-profile lookup failed: ${e.message}`); return; }
      if (!flagged.length) return;

      this._log('info', `Recovery check: re-verifying ${flagged.length} disconnected profile(s)`);
      for (const p of flagged) {
        // Skip profiles that are currently busy posting/scanning to avoid contention.
        if (this.activeProfiles.has(p.profileId) || this.runningProfileScans.has(p.profileId)) continue;
        try {
          const res = await this.scanProfileNow(p.profileId, p.profileLabel);
          if (res && res.loggedIn) {
            this._log('info', `Profile "${p.profileLabel || p.profileId}" reconnected — disconnected flag cleared`, { profileId: p.profileId });
          }
          await new Promise(r => setTimeout(r, 4000)); // gentle spacing between profiles
        } catch (e) {
          this._log('error', `Recovery scan for profile ${p.profileId} failed: ${e.message}`, { profileId: p.profileId });
        }
      }
    } finally {
      this._recoverTickRunning = false;
    }
  }

  // Scan one Chrome profile: verify it is still logged into Facebook and refresh
  // its cached identity. Shared by the daily auto-scan and the manual button.
  async scanProfileNow(profileId, profileLabel = '') {
    if (!profileId) return { success: false, error: 'Missing profileId' };
    if (this.runningProfileScans.has(profileId)) return { success: false, error: 'Scan already in progress' };
    this.runningProfileScans.add(profileId);
    try {
      const profileData = await this._getProfileData(profileId);
      if (!profileData) {
        const saved = this.db.saveProfileScan(profileId, {
          profileLabel, loggedIn: false, error: 'Profile not found in structures',
        });
        this._log('warn', `Profile "${profileLabel || profileId}" not found in structures`, { profileId });
        return { success: false, error: 'Profile not found in structures', loggedIn: false, scan: saved };
      }

      const result = await facebookProfileScanInfo({ profileId, profileData });

      const existingScan = this.db.getProfileScan(profileId);
      const rawInfo = (result && result.info) || null;
      const localInfo = rawInfo
        ? await facebookGroupsImageStore.localizeProfileInfo(
            profileId,
            rawInfo,
            existingScan && existingScan.scanInfo,
          )
        : null;
      if (result && localInfo) result.info = localInfo;

      const saved = this.db.saveProfileScan(profileId, {
        profileLabel,
        loggedIn: !!(result && result.loggedIn),
        info: localInfo,
        error: (result && result.success) ? null : ((result && result.error) || null),
      });

      const name = (result && result.info && result.info.name) || profileLabel || profileId;
      if (result && result.loggedIn) {
        this._log('info', `Profile "${name}" is logged in`, { profileId });
        // Clear any stale "disconnected" live-activity so the profile card stops
        // showing "Disconnected" the moment a scan confirms it is connected again.
        const act = this.profileActivity.get(profileId);
        if (act && act.status === 'disconnected') {
          this._setProfileActivity(profileId, 'idle', '', {});
        }
      } else {
        this._log('warn', `Profile "${name}" is logged out${result && result.error ? ` — ${result.error}` : ''}`, { profileId });
      }

      const win = this._getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('fb-groups-profile-scanned', { profileId, scan: saved });
      }

      return { ...(result || {}), scan: saved };
    } catch (e) {
      return { success: false, loggedIn: false, error: e.message };
    } finally {
      this.runningProfileScans.delete(profileId);
    }
  }

  // Scan one group's public info via a random linked profile and persist it.
  // Shared by the daily auto-scan, the add-profile trigger, and the manual button.
  async scanGroupNow(groupId) {
    if (!groupId) return { success: false, error: 'Missing groupId' };
    if (this.runningScans.has(groupId)) return { success: false, error: 'Scan already in progress' };
    this.runningScans.add(groupId);
    try {
      const group = this.db.getGroupById(groupId);
      if (!group) return { success: false, error: 'Group not found' };

      const profiles = this.db.getGroupProfiles(groupId);
      if (!profiles || !profiles.length) return { success: false, error: 'No profiles linked to this group' };

      const picked = profiles[Math.floor(Math.random() * profiles.length)];
      const profileData = await this._getProfileData(picked.profileId);
      if (!profileData) return { success: false, error: `Profile "${picked.profileLabel}" not found in structures` };

      const result = await facebookGroupScanInfo({
        groupId,
        groupUrl: group.url || '',
        profileId: picked.profileId,
        profileData,
      });

      if (result && result.success && result.info) {
        const existingInfo = {
          ...(group.scanInfo || {}),
          coverImage: group.coverImage || group.scanInfo?.coverImage || null,
          profilePicture: group.profilePicture || group.scanInfo?.profilePicture || null,
        };
        const localInfo = await facebookGroupsImageStore.localizeGroupInfo(
          groupId,
          result.info,
          existingInfo,
        );
        result.info = localInfo;
        this.db.saveGroupScanInfo(groupId, localInfo);
        this._log('info', `Scanned group "${localInfo.name || groupId}" — ${localInfo.membersFormatted || '?'} members`, { groupId });
        const win = this._getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('fb-groups-group-scanned', { groupId, info: localInfo });
        }
        return { success: true, info: localInfo, profileLabel: picked.profileLabel };
      }

      const err = (result && result.error) || 'Scan failed';
      this._log('warn', `Scan failed for group ${groupId}: ${err}`, { groupId });
      return { success: false, error: err, profileLabel: picked.profileLabel };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      this.runningScans.delete(groupId);
    }
  }

  // Move pre-existing Facebook CDN references into the same durable store once.
  // Failed legacy URLs remain remote and can be refreshed by a future scan.
  _migrateStoredFacebookImages() {
    if (this._imageMigrationStarted) return;
    this._imageMigrationStarted = true;

    if ((Number(readKey(IMAGE_MIGRATION_KEY)) || 0) >= IMAGE_MIGRATION_VERSION) {
      return;
    }

    setTimeout(async () => {
      try {
        for (const group of this.db.getAllGroups()) {
          const currentInfo = {
            ...(group.scanInfo || {}),
            coverImage: group.coverImage || group.scanInfo?.coverImage || null,
            profilePicture: group.profilePicture || group.scanInfo?.profilePicture || null,
          };
          if (!/^https?:\/\//i.test(currentInfo.coverImage || "") &&
              !/^https?:\/\//i.test(currentInfo.profilePicture || "")) continue;
          const localized = await facebookGroupsImageStore.localizeGroupInfo(
            group.groupId,
            currentInfo,
            currentInfo,
            { logFailures: false },
          );
          this.db.updateGroupImagePaths(group.groupId, localized);
          const win = this._getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('fb-groups-group-scanned', {
              groupId: group.groupId,
              info: localized,
            });
          }
        }

        for (const scan of this.db.getAllProfileScans()) {
          const currentInfo = scan.scanInfo || {};
          if (!/^https?:\/\//i.test(currentInfo.coverImage || "") &&
              !/^https?:\/\//i.test(currentInfo.profilePicture || "")) continue;
          const localized = await facebookGroupsImageStore.localizeProfileInfo(
            scan.profileId,
            currentInfo,
            currentInfo,
            { logFailures: false },
          );
          const saved = this.db.updateProfileScanImages(scan.profileId, localized);
          const win = this._getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('fb-groups-profile-scanned', {
              profileId: scan.profileId,
              scan: saved,
            });
          }
        }
      } catch (error) {
        console.warn(`[FB Groups] Existing image migration failed: ${error.message}`);
      } finally {
        updateData(IMAGE_MIGRATION_KEY, IMAGE_MIGRATION_VERSION);
      }
    }, 1000);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  _getMainWindow() {
    return BrowserWindow.getAllWindows()[0] || null;
  }

  _log(level, message, meta = {}) {
    const entry = { level, message, timestamp: new Date().toISOString(), ...meta };
    this.liveLogBuffer.push(entry);
    if (this.liveLogBuffer.length > MAX_LOG_BUFFER) this.liveLogBuffer.shift();
    try {
      const win = this._getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('fb-groups-live-log', entry);
    } catch (_) {}
    console.log(`[FBGroupsScheduler] [${level}] ${message}`, Object.keys(meta).length ? meta : '');

    // Forward error-level events to the backend so we can diagnose problems that
    // beta testers hit on their own machines. Fire-and-forget; never blocks.
    if (level === 'error') {
      try {
        reportClientError({
          feature: 'fb_groups',
          level: 'error',
          message,
          context: meta,
        });
      } catch (_) {}
    }
  }

  async _getProfileData(profileId) {
    if (!profileId) return null;
    try {
      const structures = await readKey('structures');
      for (const struct of Object.values(structures || {})) {
        if (struct.profiles?.[profileId]) return struct.profiles[profileId];
      }
    } catch (_) {}
    return null;
  }

  // Mark a workflow as cancelled so any in-flight _processWorkflow call exits early
  cancelWorkflow(workflowId) {
    this.cancelledWorkflows.add(workflowId);
    // Clean up after a short delay — the running promise will have exited by then
    setTimeout(() => this.cancelledWorkflows.delete(workflowId), 30000);
  }

  // ISO timestamp for local midnight today — the lower bound for "posts sent today".
  _localMidnightIso() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  // Returns today’s date as YYYY-MM-DD (local time)
  _getDailyDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // DB-backed daily usage for a profile. cap <= 0 means unlimited.
  // Persists across restarts because it counts real 'sent' rows in group_post_log.
  // The in-memory profileDailyCount only reserves slots for posts that are in-flight
  // this tick (so two targets in the same tick can't both slip past a cap of N).
  _getProfileCapUsage(profileId, cap) {
    if (!cap || cap <= 0) return { used: 0, cap: 0, allowed: true };
    let dbCount = 0;
    try { dbCount = this.db.getProfileSentCountToday(profileId, this._localMidnightIso()); } catch (_) {}
    const today = this._getDailyDate();
    const reserved = this.profileDailyCount.get(profileId);
    const reservedCount = reserved && reserved.date === today ? reserved.count : 0;
    const used = dbCount + reservedCount;
    return { used, cap, allowed: used < cap };
  }

  // How many posts a profile has already sent today (DB 'sent' rows + in-flight
  // reservations), regardless of any cap. Used to balance load fairly across
  // profiles so the same accounts aren't favoured by random selection.
  _getProfileUsedToday(profileId) {
    let dbCount = 0;
    try { dbCount = this.db.getProfileSentCountToday(profileId, this._localMidnightIso()); } catch (_) {}
    const today = this._getDailyDate();
    const reserved = this.profileDailyCount.get(profileId);
    const reservedCount = reserved && reserved.date === today ? reserved.count : 0;
    return dbCount + reservedCount;
  }

  // Reserve one in-flight slot for a profile this tick (prevents same-tick over-posting).
  _reserveDailySlot(profileId) {
    const today = this._getDailyDate();
    const entry = this.profileDailyCount.get(profileId) || { count: 0, date: today };
    if (entry.date !== today) { entry.count = 0; entry.date = today; }
    entry.count++;
    this.profileDailyCount.set(profileId, entry);
  }

  // Release a previously reserved in-flight slot (call when a reserved post ultimately fails).
  _releaseDailySlot(profileId) {
    const entry = this.profileDailyCount.get(profileId);
    if (entry && entry.count > 0) { entry.count--; this.profileDailyCount.set(profileId, entry); }
  }

  // ─── Per-profile minimum posting gap (anti-ban) ───────────────────────────
  // Enforces a minimum time between ANY two posts from the same profile, across
  // every workflow and group. Posting to many groups within seconds is the
  // strongest "unusual activity" signal Facebook flags. The gap is randomized
  // (between minMin and maxMin minutes) and locked in at send time.
  //
  // Returns { allowed, waitMs }. Seeds lazily from the DB (last 'sent' time) so
  // the gap survives app restarts instead of resetting to "post immediately".
  _isProfileGapElapsed(profileId, minMin, maxMin) {
    if (!profileId) return { allowed: true, waitMs: 0 };
    const lo = Math.max(0, Number(minMin) || 0);
    if (lo <= 0) return { allowed: true, waitMs: 0 }; // gap disabled
    let nextAt = this.profileNextPostAt.get(profileId);
    if (nextAt === undefined) {
      // Seed from the last real post so a freshly-started app respects the gap.
      let lastIso = null;
      try { lastIso = this.db.getProfileLastSentAt(profileId); } catch (_) {}
      nextAt = lastIso ? new Date(lastIso).getTime() + lo * 60000 : 0;
      this.profileNextPostAt.set(profileId, nextAt);
    }
    const now = Date.now();
    if (now >= nextAt) return { allowed: true, waitMs: 0 };
    return { allowed: false, waitMs: nextAt - now };
  }

  // Lock in the next allowed post time for a profile right after it posts.
  // Call on EVERY post that actually consumed the profile (success and the
  // ambiguous-but-sent path).
  _recordProfilePost(profileId, minMin, maxMin) {
    if (!profileId) return;
    const lo = Math.max(0, Number(minMin) || 0);
    const hi = Math.max(lo, Number(maxMin) || 0);
    const gapMin = hi > lo ? lo + Math.random() * (hi - lo) : lo;
    this.profileNextPostAt.set(profileId, Date.now() + gapMin * 60000);
  }

  // ─── New-profile warm-up ramp (anti-ban) ──────────────────────────────────
  // Brand-new / low-history profiles should not jump straight to the full daily
  // cap. Returns the effective cap = min(configuredCap, warmupCapForAge).
  // Age is measured in days since the profile's FIRST successful post.
  _getWarmupCap(profileId, configuredCap, enabled) {
    if (!enabled) return configuredCap;
    let firstIso = null;
    try { firstIso = this.db.getProfileFirstSentAt(profileId); } catch (_) {}
    let dayTierCap;
    if (!firstIso) {
      dayTierCap = 3; // brand new (no successful posts yet)
    } else {
      const ageDays = (Date.now() - new Date(firstIso).getTime()) / 86400000;
      if (ageDays < 3)      dayTierCap = 3;
      else if (ageDays < 7) dayTierCap = 5;
      else                  dayTierCap = configuredCap; // fully warmed up
    }
    if (!configuredCap || configuredCap <= 0) return dayTierCap; // unlimited config → still ramp
    return Math.min(configuredCap, dayTierCap);
  }

  // Exclusive browser lock: prevents two concurrent Chrome operations on the same profile directory.
  // Returns true and acquires the lock; returns false if already busy (caller should skip/defer).
  // Also defers when the SHARED per-profile session mutex (facebookProfileLock) is busy — that
  // covers work started outside the scheduler (manual UI actions via IPC) or the fire-and-forget
  // first comment that runs after the post released this scheduler-local flag. This keeps a profile
  // to ONE live session at a time across the whole app (avoids Facebook's "multiple sessions" flag).
  _acquireProfile(profileId) {
    if (!profileId || this.activeProfiles.has(profileId) || _isProfileSessionBusy(profileId)) return false;
    this.activeProfiles.add(profileId);
    return true;
  }

  _releaseProfile(profileId) {
    if (profileId) this.activeProfiles.delete(profileId);
  }

  // Update and broadcast what a profile is doing right now.
  // status: 'posting' | 'commenting' | 'viral_check' | 'viral_edit' | 'idle'
  _setProfileActivity(profileId, status, detail = '', meta = {}) {
    if (!profileId) return;
    const entry = {
      profileId, status, detail,
      groupId:      meta.groupId      || '',
      groupName:    meta.groupName    || '',
      workflowName: meta.workflowName || '',
      timestamp:    new Date().toISOString(),
    };
    this.profileActivity.set(profileId, entry);
    try {
      const win = this._getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('fb-groups-profile-activity', entry);
    } catch (_) {}
  }
  // ─── Post tick ────────────────────────────────────────────────────────────

  async _postTick() {
    try {
      const workflows = this.db.getImportedWorkflows().filter(w => w.status === 'active');

      // ── Completion sweep ──────────────────────────────────────────────────
      // On every tick, check every active non-loop workflow. If all group targets
      // have sentCount >= postsLength, mark it complete immediately — regardless
      // of whether the post was sent in this tick or a previous one.
      for (const wf of workflows.filter(w => !w.loopWorkflow)) {
        if (this.runningWorkflows.has(wf.workflowId)) continue;
        try {
          const targets = this.db.getWorkflowGroupTargets(wf.workflowId).filter(t => t.enabled);
          if (targets.length === 0) continue;
          let posts;
          if (wf.isManual) {
            posts = this.db.getWorkflowLibraryPosts(wf.workflowId);
          } else {
            posts = workflowDb.getWorkflowPosts(wf.workflowId);
          }
          if (!posts || posts.length === 0) continue;
          const allDone = targets.every(t => {
            const sentCount = this.db.getAutomationPostSentCount(wf.workflowId, t.groupId);
            return sentCount > 0 && (sentCount % posts.length) === 0;
          });
          if (allDone) {
            this._log('success', `Workflow "${wf.name}" → all posts sent, marking as completed`, { workflowId: wf.workflowId });
            this.db.updateImportedWorkflowStatus(wf.workflowId, 'paused', true);
            try {
              const win = this._getMainWindow();
              if (win && !win.isDestroyed()) win.webContents.send('fb-groups-workflow-completed', { workflowId: wf.workflowId });
            } catch (_) {}
          }
        } catch (_) {}
      }

      for (const wf of workflows) {
        if (this.runningWorkflows.has(wf.workflowId)) continue;
        this.runningWorkflows.add(wf.workflowId);
        this._processWorkflow(wf)
          .catch(e => this._log('error', `Workflow "${wf.name}" error: ${e.message}`, { workflowId: wf.workflowId }))
          .finally(() => { this.runningWorkflows.delete(wf.workflowId); this.cancelledWorkflows.delete(wf.workflowId); });
      }
    } catch (e) {
      this._log('error', `postTick error: ${e.message}`);
    }
  }

  async _processWorkflow(wf) {
    const now = new Date();
    // Read global anti-ban settings once per workflow execution so the scheduler always uses current values
    const _globalSettings  = (await readKey('fbGroupsGlobalSettings')) || {};
    const _commentDelayMin = typeof _globalSettings.commentDelayMin === 'number' ? _globalSettings.commentDelayMin : 60;
    const _commentDelayMax = typeof _globalSettings.commentDelayMax === 'number' ? _globalSettings.commentDelayMax : 180;
    const _dailyPostingCap = typeof _globalSettings.dailyPostingCap === 'number'  ? _globalSettings.dailyPostingCap : 8;
    // Anti-ban: minimum gap (minutes) between ANY two posts from the same profile,
    // across all workflows/groups. Randomized between min and max. Defaults 30–90.
    const _minProfileGapMin = typeof _globalSettings.minProfileGapMin === 'number' ? _globalSettings.minProfileGapMin : 30;
    const _minProfileGapMax = typeof _globalSettings.minProfileGapMax === 'number' ? _globalSettings.minProfileGapMax : 90;
    // Anti-ban: warm-up ramp for fresh profiles + light content variation (default on).
    const _warmupEnabled    = _globalSettings.warmupEnabled !== false;
    const _contentVariation = _globalSettings.contentVariationEnabled !== false;
    // Human mode: warmed-up browser posting that opens the real composer (emits
    // composer telemetry) instead of the naked HTTP GraphQL mutation. Per-workflow
    // override (wf.humanMode: null=inherit / 0 / 1) falls back to the global default,
    // which is ON unless explicitly disabled.
    const _globalHumanMode = _globalSettings.humanMode !== false;
    const _humanMode = (wf.humanMode === null || wf.humanMode === undefined)
      ? _globalHumanMode
      : !!wf.humanMode;
    // Testing aid: when enabled, the Human-mode post runs in a VISIBLE (headful)
    // browser so the operator can watch the warmup/composer steps. Default off.
    const _humanWatch = _globalSettings.humanModeWatch === true;
    // Viral monitor timing (user-configurable from Group Settings); undefined → DB defaults apply
    const _viralExpiryHours      = Number(_globalSettings.viralExpiryHours)      > 0 ? Number(_globalSettings.viralExpiryHours)      : undefined;
    const _viralCheckIntervalMin = Number(_globalSettings.viralCheckIntervalMin) > 0 ? Number(_globalSettings.viralCheckIntervalMin) : undefined;
    // Whether this workflow needs a first comment (URL-as-comment or viral initial
    // comment). A profile currently under Facebook's comment cooldown (see
    // isCommentRateLimited) must not be picked for these — the post would go out
    // with no comment attached.
    const _requiresFirstComment = !!(wf.postUrlAsComment || (wf.viralMonitorEnabled && wf.viralInitialCommentText));
    const targets = this.db.getWorkflowGroupTargets(wf.workflowId).filter(t => t.enabled);

    for (const target of targets) {
      // Bail out if this workflow was deleted while we were running
      if (this.cancelledWorkflows.has(wf.workflowId)) {
        this._log('info', `Workflow "${wf.name}" was deleted — aborting in-flight execution`, { workflowId: wf.workflowId });
        return;
      }
      const isManual = !!wf.isManual;
      let posts;
      if (isManual) {
        const manualPosts = this.db.getWorkflowLibraryPosts(wf.workflowId);
        if (!manualPosts || manualPosts.length === 0) {
          this._log('info', `No manual posts in workflow "${wf.name}" — skipping`, { workflowId: wf.workflowId });
          continue;
        }
        posts = manualPosts.map(p => ({
          post_id: String(p.id),
          postMessage: p.text || '',
          postImg: p.imagePath || null,
          url: p.url || '',
        }));
      } else {
        const workflowData = workflowDb.getWorkflow(wf.workflowId);
        if (!workflowData) {
          this._log('error', `Workflow DB record missing for "${wf.name}"`, { workflowId: wf.workflowId });
          continue;
        }
        posts = workflowDb.getWorkflowPosts(wf.workflowId);
        if (!posts || posts.length === 0) {
          this._log('info', `No posts in workflow "${wf.name}" — skipping`, { workflowId: wf.workflowId });
          continue;
        }
      }

      // Check completion BEFORE delay guard — so the workflow is marked done immediately
      // regardless of how long the inter-post delay is.
      const sentCount = this.db.getAutomationPostSentCount(wf.workflowId, target.groupId);
      const postIndex = sentCount % posts.length;

      if (postIndex === 0 && sentCount > 0 && !wf.loopWorkflow) {
        this._log('success', `Workflow "${wf.name}" → all posts processed, marked as completed`, { workflowId: wf.workflowId });
        this.db.updateImportedWorkflowStatus(wf.workflowId, 'paused', true);
        // Notify renderer so the card updates immediately
        try {
          const win = this._getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('fb-groups-workflow-completed', { workflowId: wf.workflowId });
          }
        } catch (_) {}
        continue;
      }

      // Respect delay between posts. Prefer the persisted next_post_at (jitter locked in at
      // send time, survives app restarts). Fall back to lastPostedAt + delay for legacy targets
      // that posted before this field existed.
      if (target.nextPostAt) {
        if (now < new Date(target.nextPostAt)) continue;
      } else if (target.lastPostedAt) {
        const sc = wf.scheduleConfig || {};
        const randomnessPct = sc.randomnessPct ?? 0;
        const jitterMin = randomnessPct > 0
          ? (Math.random() * 2 - 1) * (wf.delayMinutes * randomnessPct / 100)
          : 0;
        const effectiveDelay = Math.max(1, wf.delayMinutes + jitterMin);
        const elapsedMin = (now - new Date(target.lastPostedAt)) / 60000;
        if (elapsedMin < effectiveDelay) continue;
      }

      // Check allowed days (0=Sun … 6=Sat) and posting hours window
      {
        const sc = wf.scheduleConfig || {};
        const allowedDays = sc.allowedDays;
        const postingHours = sc.postingHours;
        const dayOfWeek = now.getDay();
        const hourOfDay = now.getHours();
        if (Array.isArray(allowedDays) && allowedDays.length > 0 && !allowedDays.includes(dayOfWeek)) continue;
        if (postingHours && typeof postingHours.from === 'number' && typeof postingHours.to === 'number') {
          const { from, to } = postingHours;
          if (from <= to) {
            if (hourOfDay < from || hourOfDay >= to) continue;
          } else {
            // overnight window e.g. 22→06
            if (hourOfDay < from && hourOfDay >= to) continue;
          }
        }
      }

      const post = posts[postIndex];

      // ── Resolve final content (use pre-generated content; never re-run the graph) ─
      let fbText, fbImage, fbUrl;
      const workflowPostId = isManual ? post.post_id : post.postId;

      if (isManual) {
        fbText  = post.postMessage || '';
        fbImage = post.postImg || null;  // already absolute path
        fbUrl   = post.url || '';
        if (!fbText && !fbImage) {
          const apId = this.db.createAutomationPost(
            wf.workflowId, target.groupId, target.profileId || '', workflowPostId,
            { message: fbText, imagePath: fbImage, url: fbUrl }
          );
          const errMsg = 'Manual post has no text and no image — skipping.';
          this.db.updateAutomationPostStatus(apId, 'skipped', null, null, errMsg);
          this._log('info', errMsg, { workflowId: wf.workflowId });
          continue;
        }
        this._log('info', `[Manual] Post "${post.post_id}" — text="${fbText.slice(0,60)}", img="${fbImage || ''}"`, { workflowId: wf.workflowId });
      } else {
        // Automation workflows are NOT re-executed during scheduled posting.
        // The post content was already generated when the workflow ran in the main
        // Automation system and saved as `facebookOutput`. We post that saved
        // content directly — no AI / browser nodes are re-run here. The automation
        // graph is only re-run on the viral path ("Run Automation for Article URL").
        const fb = post.facebookOutput || null;
        let fbImageRaw = fb && fb.image ? fb.image : (post.postImg || null);
        if (Array.isArray(fbImageRaw)) fbImageRaw = fbImageRaw[0] || null;
        fbText  = fb && fb.text ? fb.text : (post.postMessage || '');
        fbImage = fbImageRaw || null;
        fbUrl   = fb && fb.url ? fb.url : '';

        // Resolve relative image paths to the userData Images folder
        if (fbImage && !path.isAbsolute(fbImage)) {
          fbImage = path.join(app.getPath('userData'), 'Images', fbImage);
        }

        // Guard: don't post if there's no saved content
        if (!fbText && !fbImage) {
          const apId = this.db.createAutomationPost(
            wf.workflowId, target.groupId, target.profileId || '', workflowPostId,
            { message: fbText, imagePath: fbImage, url: fbUrl }
          );
          const errMsg = 'This post has no saved content. Run the workflow in the Automation page first so its posts are generated, then they will be posted here.';
          this.db.updateAutomationPostStatus(apId, 'failed', null, null, errMsg);
          this._log('error', `Skipped empty post for "${wf.name}": ${errMsg}`, { workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId });
          continue;
        }

        this._log('info', `Posting saved content for "${wf.name}" → group "${target.groupName || target.groupId}" — text="${(fbText || '').slice(0,60)}", image="${fbImage || ''}"`, {
          workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId,
        });
      }

      // Determine profile — use target.profileId or pick an UNCAPPED profile from the group to spread load
      let profileId = target.profileId;
      if (profileId) {
        // Fixed profile assigned to this target — enforce its cap directly (with warm-up ramp)
        const effCap = this._getWarmupCap(profileId, _dailyPostingCap, _warmupEnabled);
        const usage = this._getProfileCapUsage(profileId, effCap);
        if (!usage.allowed) {
          this._log('info', `Profile ${profileId} reached the daily cap (${usage.used}/${usage.cap}) — skipping group "${target.groupName || target.groupId}"`, { workflowId: wf.workflowId });
          continue;
        }
        if (this._isProfileFlagged(profileId)) {
          this._log('info', `Profile ${profileId} is flagged as disconnected — skipping until marked as working`, { workflowId: wf.workflowId });
          continue;
        }
        if (_requiresFirstComment && this.db.isProfileCommentBlocked(profileId)) {
          const until = this.db.getProfileCommentBlockedUntil(profileId);
          this._log('info', `Profile ${profileId} is temporarily blocked from commenting by Facebook (until ${until}) and this workflow requires a first comment — skipping group "${target.groupName || target.groupId}"`, { workflowId: wf.workflowId });
          continue;
        }
        // Anti-ban: enforce the minimum gap since this profile last posted (any group/workflow)
        const gap = this._isProfileGapElapsed(profileId, _minProfileGapMin, _minProfileGapMax);
        if (!gap.allowed) {
          this._log('info', `Profile ${profileId} posted recently — deferring "${target.groupName || target.groupId}" for ${Math.ceil(gap.waitMs / 60000)} more min (per-profile gap)`, { workflowId: wf.workflowId });
          continue;
        }
      } else {
        const groupProfiles = this.db.getGroupProfiles(target.groupId);
        if (groupProfiles.length > 0) {
          // Keep only profiles that still have daily capacity (warm-up aware), are not
          // flagged, have satisfied the per-profile minimum posting gap, AND (when the
          // workflow needs a first comment) are not under Facebook's comment cooldown.
          const available = groupProfiles.filter(p =>
            this._getProfileCapUsage(p.profileId, this._getWarmupCap(p.profileId, _dailyPostingCap, _warmupEnabled)).allowed &&
            !this._isProfileFlagged(p.profileId) &&
            this._isProfileGapElapsed(p.profileId, _minProfileGapMin, _minProfileGapMax).allowed &&
            !(_requiresFirstComment && this.db.isProfileCommentBlocked(p.profileId))
          );
          if (available.length === 0) {
            const cappedN  = groupProfiles.filter(p => !this._getProfileCapUsage(p.profileId, this._getWarmupCap(p.profileId, _dailyPostingCap, _warmupEnabled)).allowed).length;
            const flaggedN = groupProfiles.filter(p => this._isProfileFlagged(p.profileId)).length;
            const gapN     = groupProfiles.filter(p => !this._isProfileGapElapsed(p.profileId, _minProfileGapMin, _minProfileGapMax).allowed).length;
            const cmtN     = _requiresFirstComment ? groupProfiles.filter(p => this.db.isProfileCommentBlocked(p.profileId)).length : 0;
            this._log('info', `0/${groupProfiles.length} profile(s) available for group "${target.groupName || target.groupId}" — capped: ${cappedN}, flagged: ${flaggedN}, in posting gap: ${gapN}, comment-blocked: ${cmtN} — skipping`, { workflowId: wf.workflowId });
            continue;
          }
          // Spread the load FAIRLY: choose the profile that has posted the least
          // today rather than a pure random pick (random drifts uneven even when
          // all profiles are identical). Random tie-break among the least-loaded
          // keeps selection unpredictable for anti-ban purposes.
          let minUsed = Infinity;
          for (const p of available) {
            p._usedToday = this._getProfileUsedToday(p.profileId);
            if (p._usedToday < minUsed) minUsed = p._usedToday;
          }
          const leastLoaded = available.filter(p => p._usedToday === minUsed);
          profileId = leastLoaded[Math.floor(Math.random() * leastLoaded.length)].profileId;
        }
      }
      if (!profileId) {
        const apId = this.db.createAutomationPost(
          wf.workflowId, target.groupId, '', workflowPostId,
          { message: fbText, imagePath: fbImage, url: fbUrl }
        );
        this.db.updateAutomationPostStatus(apId, 'failed', null, null, 'No profile available for group');
        this._log('error', `No profile for group ${target.groupId}`, { workflowId: wf.workflowId });
        continue;
      }

      // Reserve an in-flight daily slot so two targets in the same tick can't both bypass the cap
      this._reserveDailySlot(profileId);

      // Acquire exclusive browser lock — skip if a monitor check or another post is already using this profile
      if (!this._acquireProfile(profileId)) {
        this._releaseDailySlot(profileId);
        this._log('info', `Profile ${profileId} is busy with another operation — deferring post to next tick`, { workflowId: wf.workflowId });
        continue;
      }

      // A row is "running" only after every scheduling guard has passed and this
      // profile is locked for the actual Facebook operation. Creating it earlier
      // made deferred posts look active in the workflow card indefinitely.
      const apId = this.db.createAutomationPost(
        wf.workflowId, target.groupId, profileId, workflowPostId,
        { message: fbText, imagePath: fbImage, url: fbUrl }
      );
      const profileData = await this._getProfileData(profileId);

      // ── Clean-IP rotation (rotational/session proxies only) ───────────────
      // If the profile uses a Rayobyte rotational/session proxy AND IPRegistry is
      // configured in Settings, rotate the proxy session until a clean (un-flagged)
      // exit IP is found BEFORE posting — same behaviour as Pinterest auto-publish.
      // The rotated proxy is written back into `profileData.proxy` so the SAME clean
      // session is reused for the first comment / viral comment below (all of which
      // receive this same `profileData`). Fixed-IP proxies are left untouched.
      if (profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== 'NULL'
          && isRayobyteSessionProxy(profileData.proxy.password)) {
        try {
          const ipregistrySettings = (await readKey('ipregistrySettings')) || {};
          if (ipregistrySettings.enabled && ipregistrySettings.apiKey) {
            this._setProfileActivity(profileId, 'posting', `Finding a clean proxy IP for "${target.groupName || target.groupId}"`, {
              groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
            });
            const cleanResult = await findCleanProxy(profileData.proxy, ipregistrySettings.apiKey, 20);
            if (cleanResult && cleanResult.success && !cleanResult.skipped) {
              profileData.proxy = cleanResult.proxyData;
              this._log('info', `Clean proxy IP ${cleanResult.finalIp} found for "${target.groupName || target.groupId}" after ${cleanResult.attempts} attempt(s) — using it for the post and first comment`, {
                workflowId: wf.workflowId, groupId: target.groupId,
              });
            } else if (cleanResult && !cleanResult.skipped && !cleanResult.success) {
              // Could not find a clean exit IP within the rotation budget. Do NOT post
              // through a flagged IP — mark this attempt 'skipped' (not 'failed', so it
              // neither counts against the cap nor benches the profile) and release the
              // slot/lock. The post index does not advance, so it retries on a later
              // tick with fresh rotated IPs.
              this.db.updateAutomationPostStatus(apId, 'skipped', null, null,
                `No clean proxy IP after ${cleanResult.attempts || 0} attempt(s): ${(cleanResult.flaggedReasons || []).join(', ') || cleanResult.error || 'flagged'}`);
              this._releaseDailySlot(profileId);
              this._releaseProfile(profileId);
              this._setProfileActivity(profileId, 'idle', '', {
                groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
              });
              this._log('warn', `Skipping post to "${target.groupName || target.groupId}" — no clean proxy IP after ${cleanResult.attempts || 0} attempt(s) (${(cleanResult.flaggedReasons || []).join(', ') || cleanResult.error || 'flagged'}). Will retry next tick.`, {
                workflowId: wf.workflowId, groupId: target.groupId,
              });
              continue;
            }
          }
        } catch (cleanErr) {
          this._log('warn', `Clean proxy check failed: ${cleanErr.message} — proceeding with the current proxy IP`, { workflowId: wf.workflowId });
        }
      }

      // Extract the real Facebook group ID from the stored URL
      const facebookGroupId = (target.groupUrl || '').match(/\/groups\/([^/?#]+)/)?.[1] || target.groupId;

      // Broadcast live activity for the Profiles page
      this._setProfileActivity(profileId, 'posting', `Posting to "${target.groupName || target.groupId}"`, {
        groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
      });

      // Post to Facebook group with the SAME profile, retrying TRANSIENT failures
      // (image-upload soft-throttle, proxy hiccup, network blip, generic transient
      // FB error) up to 3 times with randomized backoff to avoid an automated
      // cadence. NEVER retried here:
      //   - success
      //   - permanent failures (session/auth → pause; content/policy → skip)
      //   - ambiguousUnverified (the post may have landed — re-posting could duplicate)
      // Anti-ban: lightly vary the text so the same library post isn't blasted
      // byte-for-byte to every group (a strong spam fingerprint).
      const postText = _contentVariation ? varyContent(fbText || '') : (fbText || '');
      // Only the viral "Edit First Comment" action needs a comment ID immediately.
      // All other first comments must use the configured delay in the scheduler
      // below, including when Human Mode is enabled.
      const _needsSynchronousFirstComment =
        wf.viralMonitorEnabled && wf.viralAction === 'edit_comment';
      let _inSessionCommentText = '';
      if (_humanMode && _needsSynchronousFirstComment) {
        if (wf.postUrlAsComment && (wf.urlCommentPrefix || fbUrl)) {
          _inSessionCommentText = String(wf.urlCommentPrefix || fbUrl || '').replace(/\{\{url\}\}/g, fbUrl || '').trim();
        } else if (wf.viralMonitorEnabled && wf.viralInitialCommentText && !wf.postUrlAsComment) {
          _inSessionCommentText = String(wf.viralInitialCommentText || '');
        }
      }
      const MAX_POST_ATTEMPTS = 3;
      let postResult = null;
      for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt++) {
        postResult = await facebookGroupPost({
          facebookGroupId, groupUrl: target.groupUrl || '', profileId, message: postText,
          imagePath: fbImage || null, profileData, humanMode: _humanMode, humanWatch: _humanWatch,
          firstCommentText: _inSessionCommentText,
          // Stay quiet on the upload diagnostic until the final attempt.
          suppressUploadErrorReport: attempt < MAX_POST_ATTEMPTS,
        });
        if (postResult?.success) break;
        // Decide whether this failure is worth a same-profile retry.
        const isTransient =
          !postResult?.ambiguousUnverified && (
            postResult?.imageUploadFailed ||
            postResult?.proxyError ||
            classifyFbError(postResult?.error || postResult?.value || '') === 'transient'
          );
        if (!isTransient || attempt >= MAX_POST_ATTEMPTS) break;
        // Random backoff between 10s and 25s — keep the same profile, don't log a
        // failure yet, just retry quietly.
        const retryDelayMs = 10000 + Math.floor(Math.random() * 15000);
        this._setProfileActivity(profileId, 'posting', `Retrying post to "${target.groupName || target.groupId}" (${attempt + 1}/${MAX_POST_ATTEMPTS})`, {
          groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
        });
        await new Promise(r => setTimeout(r, retryDelayMs));
      }

      // Ambiguous-but-unverifiable: the post WAS sent to Facebook but we could not
      // confirm whether it published (response lost AND the feed-verification could
      // not run). To guarantee we never double-post, treat it as sent (advance the
      // schedule, do NOT re-post) and flag it loudly for manual review.
      if (!postResult?.success && postResult?.ambiguousUnverified) {
        this.db.updateAutomationPostStatus(apId, 'sent', null, null, postResult.error || null);
        this.db.updateGroupTargetLastPosted(target.id, new Date().toISOString());
        // Anti-ban: a post was sent — start this profile's minimum gap before it posts again.
        this._recordProfilePost(profileId, _minProfileGapMin, _minProfileGapMax);
        {
          const sc = wf.scheduleConfig || {};
          const randomnessPct = sc.randomnessPct ?? 0;
          const jitterMin = randomnessPct > 0
            ? (Math.random() * 2 - 1) * (wf.delayMinutes * randomnessPct / 100)
            : 0;
          const effectiveDelay = Math.max(1, wf.delayMinutes + jitterMin);
          this.db.setTargetNextPostAt(target.id, new Date(Date.now() + effectiveDelay * 60000).toISOString());
        }
        try { this.db.addPostLog(target.groupId, profileId, '', fbText || '', 'sent', null); } catch (_) {}
        this._releaseProfile(profileId); // daily slot stays consumed (a post was sent)
        this._setProfileActivity(profileId, 'idle', `Post sent but unverified for "${target.groupName || target.groupId}"`, {
          groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
        });
        this._log('warn', `Post to "${target.groupName || target.groupId}" was sent but could NOT be verified — not re-posted to avoid a duplicate. Please check the group manually.`, {
          workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId, path: postResult?.path || null,
        });
        continue;
      }

      if (!postResult?.success) {
        const errMsg = postResult?.error || postResult?.value || 'Post failed';
        this.db.updateAutomationPostStatus(apId, 'failed', null, null, errMsg);
        // Failed post never counted against the cap — release the reserved slot and browser lock
        this._releaseDailySlot(profileId);
        this._releaseProfile(profileId);
        // Record the failure in the post log so the Profiles page reflects it
        try { this.db.addPostLog(target.groupId, profileId, '', fbText || '', 'failed', null); } catch (_) {}
        this._setProfileActivity(profileId, 'idle', `Post failed for "${target.groupName || target.groupId}"`, {
          groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
        });
        this._log('error', `Post failed for group ${target.groupId}: ${errMsg}`, {
          workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId,
          path: postResult?.path || null, rawResponse: postResult?.rawResponse || null,
        });
        // Decide whether this is an ACCOUNT-LEVEL problem that needs the user to
        // step in (signed out, checkpoint, action blocked, temporarily blocked,
        // restricted/banned/disabled, rate limited). If so, bench ONLY this profile
        // so the scheduler stops using it until the user clears it — the workflow
        // keeps running so other healthy profiles continue posting.
        if (classifyFbError(errMsg) === 'permanent_session') {
          // Session loss / logged out — bench just this profile, do NOT pause the workflow.
          this._log('error', `Profile ${profileId} is logged out — benched until you refresh its session. The workflow keeps running with other profiles.`, {
            workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId,
          });
          this._flagProfileNeedsAttention(profileId, errMsg);
        } else if (isAccountLevelBlock(errMsg)) {
          // Account block on a single profile — bench just this profile and keep
          // other healthy profiles working. The user must clear it to resume.
          this._log('error', `Profile ${profileId} needs attention — Facebook returned an account-level block: ${errMsg}. Benched until you mark it as working.`, {
            workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId,
          });
          this._flagProfileNeedsAttention(profileId, errMsg);
        }
        continue;
      }

      const storyId = postResult.postId;
      const _inSessionComment = postResult.firstComment || null;
      // Comment target resolution. Facebook occasionally returns a successful post
      // with no usable id (~1% of posts). Prefer the feedback id, then the numeric
      // post id captured from the post-create response.
      let cmtFeedbackId    = postResult.feedbackId || null;
      let cmtNumericPostId = postResult.numericPostId || null;
      // Diagnostics: Facebook accepted the post but returned no extractable id
      // (~1% case). Capture the raw response so the extraction logic can be
      // improved for any new response shapes Facebook introduces.
      if (postResult.idMissing && !storyId && !cmtFeedbackId && !cmtNumericPostId) {
        this._log('error', `Post accepted but Facebook returned no extractable post id (path: ${postResult.path || 'unknown'})`, {
          workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId,
          path: postResult.path || 'unknown', rawResponse: postResult.rawResponse || null,
        });
        // Persist the raw Facebook response so a new response shape can be
        // inspected offline and the id-extraction logic updated to match.
        try {
          if (postResult.rawResponse) {
            const fs = require('fs');
            const dir = path.join(app.getPath('userData'), 'Logs');
            fs.mkdirSync(dir, { recursive: true });
            const entry = `\n===== ${new Date().toISOString()} | wf=${wf.name} | group=${target.groupId} | path=${postResult.path || 'unknown'} =====\n${postResult.rawResponse}\n`;
            fs.appendFileSync(path.join(dir, 'fb-groups-idmissing.log'), entry, 'utf8');
          }
        } catch (_) {}
      }
      this.db.updateAutomationPostStatus(apId, 'sent', storyId);
      this.db.updateGroupTargetLastPosted(target.id, new Date().toISOString());
      // Anti-ban: lock in this profile's minimum gap before it may post again (any group/workflow).
      this._recordProfilePost(profileId, _minProfileGapMin, _minProfileGapMax);
      // Persist the next allowed post time (jitter locked in now) so the inter-post delay
      // survives app restarts and powers the "Next post in X" countdown on the workflow card.
      {
        const sc = wf.scheduleConfig || {};
        const randomnessPct = sc.randomnessPct ?? 0;
        const jitterMin = randomnessPct > 0
          ? (Math.random() * 2 - 1) * (wf.delayMinutes * randomnessPct / 100)
          : 0;
        const effectiveDelay = Math.max(1, wf.delayMinutes + jitterMin);
        this.db.setTargetNextPostAt(target.id, new Date(Date.now() + effectiveDelay * 60000).toISOString());
      }

      // Mirror to group_post_log (for the Groups tab history)
      this.db.addPostLog(target.groupId, profileId, '', fbText || '', 'sent', storyId);
      // Release exclusive browser lock — post is done; comment fires independently
      this._releaseProfile(profileId);

      this._setProfileActivity(profileId, 'idle', `Posted to "${target.groupName || target.groupId}"`, {
        groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
      });

      this._log('success', `Posted to "${target.groupName || target.groupId}" via "${wf.name}"`, {
        workflowId: wf.workflowId, workflowName: wf.name, groupId: target.groupId, storyId,
      });

      // Push notification to renderer
      try {
        const win = this._getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('fb-groups-post-sent', { workflowId: wf.workflowId, groupId: target.groupId, status: 'sent' });
        }
      } catch (_) {}

      // ── First comment ─────────────────────────────────────────────────────
      // Use a random delay (from global settings) before posting the URL comment to
      // avoid the instant-comment bot pattern. Exception: when viral monitoring uses
      // the 'edit_comment' action the comment must exist synchronously so the monitor
      // has its ID at creation time.
      let firstCommentId = null;
      // When human mode already published the first comment in the same session,
      // adopt it and skip the legacy separate-browser comment + id recovery below.
      let _commentHandledInSession = false;
      if (_inSessionComment && _inSessionComment.success && _inSessionComment.commentId) {
        firstCommentId = _inSessionComment.commentId;
        _commentHandledInSession = true;
        try { this.db.updateAutomationPostFirstComment(apId, firstCommentId); } catch (_) {}
        this._log('success', `First comment posted in-session (human mode) on story ${storyId || cmtNumericPostId}`, {
          workflowId: wf.workflowId, groupId: target.groupId,
        });
      } else if (_inSessionComment && _inSessionComment.success === false) {
        this._log('warn', `In-session first comment failed (${_inSessionComment.error || 'unknown'}) — falling back to the standard comment path`, { workflowId: wf.workflowId });
      }
      const _wantsFirstComment = wf.postUrlAsComment && (wf.urlCommentPrefix || fbUrl);
      const _wantsViralComment = wf.viralMonitorEnabled && wf.viralInitialCommentText && !wf.postUrlAsComment;
      // If a comment is needed but Facebook returned no usable post id, recover it
      // by re-fetching the just-created post from the group feed. This closes the
      // ~1% gap where the first comment was silently skipped.
      if ((_wantsFirstComment || _wantsViralComment) && !_commentHandledInSession && !cmtFeedbackId && !cmtNumericPostId && !storyId) {
        try {
          this._log('info', `Post id missing from Facebook response — attempting recovery re-fetch before commenting`, {
            workflowId: wf.workflowId, groupId: target.groupId,
          });
          const recovered = await recoverPostId({
            facebookGroupId, groupUrl: target.groupUrl || '',
            message: fbText || '', profileId, profileData,
          });
          if (recovered) {
            cmtNumericPostId = recovered;
            this._log('success', `Recovered post id ${recovered} — comment can now be attached`, {
              workflowId: wf.workflowId, groupId: target.groupId,
            });
          } else {
            this._log('warn', `First comment could not be attached — Facebook returned no post id and the recovery re-fetch found no matching post. The post itself was published successfully.`, {
              workflowId: wf.workflowId, groupId: target.groupId,
            });
          }
        } catch (recErr) {
          this._log('warn', `Post id recovery failed: ${recErr.message}`, { workflowId: wf.workflowId });
        }
      }
      const _canComment = !!(cmtFeedbackId || cmtNumericPostId || storyId);
      if (wf.postUrlAsComment && !_commentHandledInSession && _canComment && (wf.urlCommentPrefix || fbUrl)) {
        let urlText = wf.urlCommentPrefix || fbUrl || '';
        const _hadUrlPlaceholder = /\{\{url\}\}/i.test(urlText);
        urlText = urlText.replace(/\{\{url\}\}/g, fbUrl || '').trim();
        if (_hadUrlPlaceholder && !fbUrl) {
          this._log('info', `URL comment: {{url}} placeholder found but post has no URL — comment will post without a link`, { workflowId: wf.workflowId });
        }
        if (!urlText) {
          this._log('info', `URL comment skipped — text empty after substitution (no URL available yet)`, { workflowId: wf.workflowId });
        } else {
          // Bypass delay when viral edit_comment action needs the comment ID synchronously
          const _delayMs   = (!_needsSynchronousFirstComment && (_commentDelayMin > 0 || _commentDelayMax > 0))
            ? (_commentDelayMin + Math.random() * Math.max(0, _commentDelayMax - _commentDelayMin)) * 1000
            : 0;
          const _self = this;
          const _postComment = async () => {
            if (_delayMs > 0) {
              _self._log('info', `URL comment queued — posting in ~${Math.round(_delayMs / 1000)}s`, { workflowId: wf.workflowId });
              await new Promise(r => setTimeout(r, _delayMs));
            }
            const _attempt = async () => {
              _self._setProfileActivity(profileId, 'commenting', `Commenting on "${target.groupName || target.groupId}"`, {
                groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
              });
              return facebookGroupComment({
                storyId, numericPostId: cmtNumericPostId, feedbackId: cmtFeedbackId,
                facebookGroupId, groupUrl: target.groupUrl || '',
                message: urlText, profileId, profileData,
              });
            };
            try {
              let commentResult = await _attempt();
              // Retry once on non-auth, non-rate-limited failures (transient network
              // errors, browser crash, etc.) — retrying a comment cooldown just wastes
              // an attempt and won't succeed.
              if (!commentResult?.success) {
                const isAuthErr = /login|session|cookie|auth|checkpoint/i.test(commentResult?.error || '');
                const isRateLimited = isCommentRateLimited(commentResult?.error);
                if (!isAuthErr && !isRateLimited) {
                  _self._log('info', `URL comment failed (attempt 1/2): ${commentResult?.error || 'unknown error'} — retrying in 30s`, { workflowId: wf.workflowId });
                  await new Promise(r => setTimeout(r, 30000));
                  commentResult = await _attempt();
                }
              }
              if (commentResult?.success) {
                _self.db.updateAutomationPostFirstComment(apId, commentResult.commentId);
                _self._log('success', `URL comment posted on story ${storyId || cmtNumericPostId}`, {
                  workflowId: wf.workflowId, groupId: target.groupId,
                });
                return commentResult.commentId;
              } else if (isCommentRateLimited(commentResult?.error)) {
                const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
                try { _self.db.setProfileCommentBlocked(profileId, until); } catch (_) {}
                _self._log('error', `URL comment failed: Facebook is temporarily blocking comments from profile ${profileId} (spam-prevention throttle) — skipping this profile for comment-requiring workflows until ${until}`, {
                  workflowId: wf.workflowId, groupId: target.groupId,
                });
              } else {
                _self._log('error', `URL comment failed: ${commentResult?.error || 'unknown error'}`, {
                  workflowId: wf.workflowId, groupId: target.groupId,
                  rawResponse: commentResult?.rawResponse || null,
                });
              }
            } catch (e) {
              _self._log('error', `URL comment failed: ${e.message}`, { workflowId: wf.workflowId });
            } finally {
              _self._setProfileActivity(profileId, 'idle', '', {
                groupId: target.groupId, groupName: target.groupName, workflowName: wf.name,
              });
            }
            return null;
          };
          if (_delayMs === 0) {
            firstCommentId = await _postComment();
          } else {
            _postComment(); // fire-and-forget — comment fires after delay in background
          }
        }
      }

      // ── Viral monitoring ──────────────────────────────────────────────────
      if (wf.viralMonitorEnabled && storyId) {
        const linkToAdd = fbUrl || '';
        let viralCommentId = firstCommentId;

        // Post initial comment (only if we didn't already post the URL as comment)
        if (wf.viralInitialCommentText && !wf.postUrlAsComment && !_commentHandledInSession) {
          try {
            const initResult = await facebookGroupComment({
              storyId, numericPostId: cmtNumericPostId, feedbackId: cmtFeedbackId,
              facebookGroupId, groupUrl: target.groupUrl || '',
              message: wf.viralInitialCommentText, profileId, profileData,
            });
            if (initResult?.success) {
              viralCommentId = initResult.commentId;
              this.db.updateAutomationPostFirstComment(apId, viralCommentId);
              this._log('info', `Viral initial comment posted on story ${storyId}`, {
                workflowId: wf.workflowId, groupId: target.groupId,
              });
            } else if (isCommentRateLimited(initResult?.error)) {
              const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
              try { this.db.setProfileCommentBlocked(profileId, until); } catch (_) {}
              this._log('error', `Viral initial comment failed: Facebook is temporarily blocking comments from profile ${profileId} (spam-prevention throttle) — skipping this profile for comment-requiring workflows until ${until}`, {
                workflowId: wf.workflowId, groupId: target.groupId,
              });
            } else {
              this._log('error', `Viral initial comment failed: ${initResult?.error || 'unknown error'}`, { workflowId: wf.workflowId });
            }
          } catch (e) {
            this._log('error', `Viral initial comment failed: ${e.message}`, { workflowId: wf.workflowId });
          }
        }

        this.db.createViralMonitor(
          apId, storyId, target.groupId, profileId,
          wf.viralSharesTarget, linkToAdd, viralCommentId, wf.viralAction,
          // Resolve only {{post_text}} now; keep {{url}} intact for trigger time (resolved URL may come from viral automation)
          (wf.viralAiRewrite && wf.viralAiPromptText)
            ? wf.viralAiPromptText
                .replace(/\{\{post_text\}\}/gi, fbText || '')
            : null,
          // Replacement text for edit_comment action — store raw ({{url}} substituted at trigger time)
          (wf.viralAction === 'edit_comment' && wf.viralEditCommentText)
            ? wf.viralEditCommentText
            : null,
          wf.viralMetric || 'shares',
          { expiryHours: _viralExpiryHours, checkIntervalMin: _viralCheckIntervalMin },
          // Custom text for the post edit ({{url}} substituted at trigger time).
          // Used both as the primary text for the edit_post action AND as the
          // "Also Edit the Post" text for the edit_comment action. Stored whenever
          // AI rewrite is off and custom text is provided.
          (!wf.viralAiRewrite && wf.viralEditPostText)
            ? wf.viralEditPostText
            : null,
          // Number of lines to keep from old post (0 / null = replace entirely)
          wf.viralEditPostKeepLines ?? null
        );
        this._log('info', `Viral monitor created for story ${storyId} (target: ${wf.viralSharesTarget} ${wf.viralMetric || 'shares'})`, {
          workflowId: wf.workflowId, groupId: target.groupId,
        });
      }

      // ── Immediate completion check ────────────────────────────────────────
      // If this was the last post in the cycle and loop is off, mark completed now
      // instead of waiting for the next tick.
      if (!wf.loopWorkflow && (postIndex + 1) >= posts.length) {
        this._log('success', `Workflow "${wf.name}" → last post sent, marking as completed`, { workflowId: wf.workflowId });
        this.db.updateImportedWorkflowStatus(wf.workflowId, 'paused', true);
        try {
          const win = this._getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('fb-groups-workflow-completed', { workflowId: wf.workflowId });
          }
        } catch (_) {}
      }
    }
  }

  // ─── Monitor tick ─────────────────────────────────────────────────────────

  // Back-off schedule: returns ms until next check based on monitor age
  _nextCheckDelay(createdAt) {
    // User-configured flat interval takes precedence (refreshed each monitor tick).
    if (this._viralCheckMs && this._viralCheckMs > 0) return this._viralCheckMs;
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageH  = ageMs / (1000 * 60 * 60);
    if (ageH < 2)   return  5 * 60 * 1000;  // < 2h old  → every 5 min
    if (ageH < 12)  return 30 * 60 * 1000;  // < 12h old → every 30 min
    return 2 * 60 * 60 * 1000;              // 12h+      → every 2 hours
  }

  async _monitorTick() {
    // Prevent concurrent executions — the previous tick may still be sleeping between checks
    if (this._monitorTickRunning) {
      this._log('info', '[MonitorTick] Previous tick still running — skipping this interval');
      return;
    }
    this._monitorTickRunning = true;
    try {
      // Always expire overdue monitors first — even when monitoring is paused —
      // so posts past their "stop monitoring after" window are removed from the
      // monitoring view immediately regardless of the pause state. If any were
      // expired, notify an open Posts page to refresh.
      try {
        const expiredCount = this.db.expireOverdueViralMonitors();
        if (expiredCount > 0) {
          const win = this._getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('fb-groups-monitors-expired', { count: expiredCount });
          }
        }
      } catch (_) {}
      // Refresh user-configured viral check interval (flat) so changes apply without restart.
      // Also check pause state — skip the rest of the tick if monitoring is paused.
      try {
        const gs = (await readKey('fbGroupsGlobalSettings')) || {};
        const min = Number(gs.viralCheckIntervalMin);
        this._viralCheckMs = min > 0 ? min * 60 * 1000 : null;
        if (gs.viralMonitoringPaused) {
          return;
        }
      } catch (_) {}

      // ── Batched, human-like viral scan ──────────────────────────────────────
      // Instead of scanning each monitored post individually (a recognizable bot
      // pattern when many posts are tracked), open ONE human-like browser session
      // per DUE group and harvest every monitored post's metrics in a single
      // scroll pass. Sessions run detached so a long browse never blocks the tick.
      const groups = this.db.getMonitoringGroups();
      if (!groups || groups.length === 0) {
        return;
      }

      const dueGroups = groups.filter(g => (g.dueCount || 0) > 0);
      if (dueGroups.length === 0) {
        return;
      }

      // Oldest-due first; respect the global concurrent-session cap.
      // next_due is a UTC string ('YYYY-MM-DD HH:MM:SS') so it sorts lexicographically.
      dueGroups.sort((a, b) => String(a.nextDue || '').localeCompare(String(b.nextDue || '')));
      for (const g of dueGroups) {
        if (await this._isViralMonitoringPaused()) {
          this._log('info', '[MonitorTick] Viral monitoring paused — aborting remaining scans this tick');
          return;
        }
        if (this.runningScanSessions.size >= MAX_CONCURRENT_SCAN_SESSIONS) {
          this._log('info', `[MonitorTick] Scan-session cap reached (${MAX_CONCURRENT_SCAN_SESSIONS}) — ${dueGroups.length} group(s) due, remainder next tick`);
          break;
        }
        if (this.runningScanSessions.has(g.groupId)) continue;
        // Reserve the slot synchronously so the cap holds within this tick.
        this.runningScanSessions.add(g.groupId);
        this._runGroupScanSession(g)
          .catch(e => this._log('error', `Group scan session error: ${e.message}`, { groupId: g.groupId }))
          .finally(() => this.runningScanSessions.delete(g.groupId));
      }
    } catch (e) {
      this._log('error', `monitorTick error: ${e.message}`);
    } finally {
      this._monitorTickRunning = false;
    }
  }

  // ─── Batched human-like scan session for one group ──────────────────────────
  // Picks a random idle, non-flagged group profile, opens a single browser
  // session, scrolls the feed (permalink fallback) to read every monitored
  // post's metrics, updates each monitor and fires the viral action at threshold.
  async _runGroupScanSession(group) {
    const groupId = group.groupId;
    const groupName = group.groupName || groupId;

    const monitors = this.db.getMonitorsForGroup(groupId);
    if (!monitors || monitors.length === 0) return;

    // Build the candidate browsing-profile pool. Prefer explicitly-assigned group
    // profiles (spreads load across accounts), but ALWAYS fall back to the posters'
    // own profiles — they are guaranteed members of the group and logged in, so a
    // group with no rows in group_profiles can still be scanned (matches the old
    // per-post behaviour, which defaulted to the monitor's own profile).
    let scanProfileId = null;
    let scanProfileData = null;
    try {
      const candidateIds = [];
      const seen = new Set();
      const addId = (id) => { if (id && !seen.has(id)) { seen.add(id); candidateIds.push(id); } };
      try {
        for (const p of (this.db.getGroupProfiles(groupId) || [])) addId(p.profileId);
      } catch (_) {}
      // Poster profiles as guaranteed fallback.
      for (const m of monitors) addId(m.profileId);

      const available = candidateIds.filter(id => !this._isProfileFlagged(id) && !this.activeProfiles.has(id));
      for (let i = available.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [available[i], available[j]] = [available[j], available[i]];
      }
      for (const id of available) {
        const pd = await this._getProfileData(id);
        if (pd) { scanProfileId = id; scanProfileData = pd; break; }
      }
    } catch (_) {}

    if (!scanProfileId || !scanProfileData) {
      // No usable browsing profile right now (none assigned / all flagged or busy).
      // Push these monitors out a few minutes so the tick doesn't spin every cycle.
      this._log('info', `[ScanSession] No idle profile available for "${groupName}" — deferring 5min`, { groupId });
      const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      for (const m of monitors) {
        try { this.db.updateViralMonitor(m.id, m.currentShares, 'monitoring', null, retryAt); } catch (_) {}
      }
      return;
    }
    if (!this._acquireProfile(scanProfileId)) {
      this._log('info', `[ScanSession] Profile ${scanProfileId} became busy — retrying next tick`, { groupId });
      return;
    }

    const groupRecord = this.db.getGroupById(groupId);
    const groupUrl = group.groupUrl || groupRecord?.url || `https://www.facebook.com/groups/${groupId}`;
    const storyIds = monitors.map(m => String(m.storyId));

    this._setProfileActivity(scanProfileId, 'viral_check', `Browsing "${groupName}" to check ${storyIds.length} post(s)`, { groupId, groupName });

    let scanResult = null;
    try {
      scanResult = await facebookGroupFeedScan({
        groupId, groupUrl, profileId: scanProfileId, profileData: scanProfileData, storyIds,
        onLog: (msg) => this._log('info', `[ScanSession] ${msg}`, { groupId }),
      });
    } catch (e) {
      this._log('error', `[ScanSession] Feed scan threw: ${e.message}`, { groupId });
    } finally {
      this._setProfileActivity(scanProfileId, 'idle', '', { groupId, groupName });
      this._releaseProfile(scanProfileId);
    }

    // Fallback: if the whole browser session failed, scan a bounded set via HTTP.
    let countsMap = (scanResult && scanResult.success) ? scanResult.counts : null;
    if (!countsMap) {
      this._log('warn', `[ScanSession] Session failed for "${groupName}" — falling back to bounded HTTP scan`, { groupId });
      countsMap = await this._httpFallbackScan(groupId, monitors, scanProfileId, scanProfileData);
    }

    // Apply results to each monitor.
    for (const monitor of monitors) {
      if (await this._isViralMonitoringPaused()) break;
      const metric = monitor.viralMetric || 'shares';
      const nextCheckAt = new Date(Date.now() + this._nextCheckDelay(monitor.createdAt)).toISOString().slice(0, 19).replace('T', ' ');
      const c = countsMap ? countsMap[String(monitor.storyId)] : null;
      if (!c) {
        // Couldn't resolve this post this round — keep its current count, reschedule.
        this.db.updateViralMonitor(monitor.id, monitor.currentShares, 'monitoring', null, nextCheckAt);
        continue;
      }
      const metricCount =
        metric === 'likes'    ? (c.reactionsCount || 0) :
        metric === 'comments' ? (c.commentsCount  || 0) :
                                (c.sharesCount     || 0);
      this.db.updateViralMonitor(monitor.id, metricCount, 'monitoring', null, nextCheckAt);
      this._log('info', `[ScanSession] story ${monitor.storyId} → ${metricCount}/${monitor.targetShares} ${metric}`, { groupId, storyId: monitor.storyId });

      if (metricCount >= monitor.targetShares) {
        if (this._isProfileFlagged(monitor.profileId)) {
          this._log('info', `[ScanSession] Action profile ${monitor.profileId} flagged — deferring viral action`, { storyId: monitor.storyId });
          continue;
        }
        if (this.runningMonitors.has(monitor.id)) continue;
        this.runningMonitors.add(monitor.id);
        try {
          await this._applyViralAction(monitor, metricCount);
        } catch (e) {
          this._log('error', `[ScanSession] viral action error: ${e.message}`, { storyId: monitor.storyId });
        } finally {
          this.runningMonitors.delete(monitor.id);
        }
      }
    }
  }

  // Bounded HTTP-only fallback used only when a whole browser scan session fails.
  // Scans at most a handful of posts to avoid re-creating the single-post storm.
  async _httpFallbackScan(groupId, monitors, profileId, profileData) {
    const countsMap = {};
    const MAX = 5;
    if (!profileData || this._isProfileFlagged(profileId)) return countsMap;
    if (!this._acquireProfile(profileId)) return countsMap;
    try {
      let done = 0;
      for (const monitor of monitors) {
        if (done >= MAX) break;
        if (await this._isViralMonitoringPaused()) break;
        try {
          const postPermalink = `https://www.facebook.com/groups/${groupId}/permalink/${monitor.storyId}/`;
          const r = await facebookGroupScanPost({
            storyId: monitor.storyId, facebookGroupId: groupId, groupUrl: postPermalink,
            profileId, profileData,
          });
          if (r?.success) {
            countsMap[String(monitor.storyId)] = {
              sharesCount:    r.post?.sharesCount    ?? null,
              reactionsCount: r.post?.reactionsCount ?? null,
              commentsCount:  r.post?.commentsCount  ?? null,
            };
          }
        } catch (_) {}
        done++;
        await new Promise(res => setTimeout(res, 5000));
      }
    } finally {
      this._releaseProfile(profileId);
    }
    return countsMap;
  }


  // Single source of truth for the global viral-monitoring pause flag.
  // Every check entry point (tick + force check) consults this so pausing
  // takes effect immediately across all trigger paths.
  async _isViralMonitoringPaused() {
    try {
      const gs = (await readKey('fbGroupsGlobalSettings')) || {};
      return !!gs.viralMonitoringPaused;
    } catch (_) {
      return false;
    }
  }

  async forceCheckMonitor(storyId) {
    // Respect the global pause flag — force checks (manual or auto-triggered by
    // the frontend countdown) must not run while monitoring is paused.
    if (await this._isViralMonitoringPaused()) {
      this._log('info', `[ForceCheck] Skipped — viral monitoring is paused`, { storyId });
      return { success: false, paused: true, error: 'Viral monitoring is paused' };
    }
    const monitor = this.db.getViralMonitorByStoryId(storyId);
    if (!monitor) return { success: false, error: `No active monitoring record found for story ${storyId}` };
    this._log('info', `[ForceCheck] Manually triggering check for story ${storyId}`);
    try {
      // Run the check detached so the IPC returns as soon as the scan+DB update is done.
      // The viral action (automation, edit) continues in background; frontend polls for the result.
      this._checkMonitor(monitor).catch(e =>
        this._log('error', `[ForceCheck] post-scan action error: ${e.message}`, { storyId })
      );
      // Give the scan enough time to complete and update the DB before we return
      await new Promise(resolve => setTimeout(resolve, 8000));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Stats-only refresh for a post (Post History "Check stats" button). Scans the
   * post to fetch the latest share/comment/reaction count and updates the
   * monitor's current count — WITHOUT resuming monitoring or running the viral
   * action. Works for ANY monitor status (monitoring, triggered, expired) and
   * regardless of the global pause flag, since it's a manual, read-only action.
   */
  async refreshExpiredStats(storyId) {
    const monitor = this.db.getAnyViralMonitorByStoryId(storyId);
    if (!monitor) return { success: false, error: `No monitoring record found for story ${storyId}` };

    // Pick a non-flagged group profile to scan with (spreads load); fall back to
    // the original poster profile.
    let scanProfileId = monitor.profileId;
    let scanProfileData = await this._getProfileData(scanProfileId);
    try {
      const groupProfiles = this.db.getGroupProfiles(monitor.groupId);
      const available = groupProfiles.filter(p => !this._isProfileFlagged(p.profileId));
      if (available.length > 0) {
        const pick = available[Math.floor(Math.random() * available.length)];
        const pd = await this._getProfileData(pick.profileId);
        if (pd) { scanProfileId = pick.profileId; scanProfileData = pd; }
      }
    } catch (_) {}

    if (!scanProfileData) return { success: false, error: 'No profile data available to scan this post' };
    if (this._isProfileFlagged(scanProfileId)) {
      return { success: false, error: 'The scan profile is disconnected — mark it working first' };
    }
    if (!this._acquireProfile(scanProfileId)) {
      return { success: false, error: 'Scan profile is busy — try again shortly' };
    }

    this._setProfileActivity(scanProfileId, 'viral_check', `Refreshing stats for a post in "${monitor.groupName || monitor.groupId}"`, {
      groupId: monitor.groupId, groupName: monitor.groupName,
    });
    try {
      const postPermalink = `https://www.facebook.com/groups/${monitor.groupId}/permalink/${monitor.storyId}/`;
      const scanResult = await facebookGroupScanPost({
        storyId: monitor.storyId, facebookGroupId: monitor.groupId, groupUrl: postPermalink,
        profileId: scanProfileId, profileData: scanProfileData,
      });
      if (!scanResult?.success) {
        return { success: false, error: scanResult?.value || 'Scan failed' };
      }
      const metric = monitor.viralMetric || 'shares';
      const metricCount =
        metric === 'likes'    ? (scanResult.post?.reactionsCount || 0) :
        metric === 'comments' ? (scanResult.post?.commentsCount  || 0) :
                                (scanResult.post?.sharesCount    || 0);
      // Update count only — never change status (no monitoring/action side-effects).
      this.db.updateViralMonitorCount(monitor.id, metricCount);
      this._log('info', `[CheckStats] story ${monitor.storyId} → ${metricCount}/${monitor.targetShares} ${metric}`, {
        groupId: monitor.groupId, storyId: monitor.storyId,
      });
      return { success: true, count: metricCount, metric, target: monitor.targetShares };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      this._setProfileActivity(scanProfileId, 'idle', '', { groupId: monitor.groupId, groupName: monitor.groupName });
      this._releaseProfile(scanProfileId);
    }
  }

  // Returns true when the profile has been flagged as disconnected by the scheduler
  // or a scan result. Flagged profiles are skipped until the user marks them working.
  _isProfileFlagged(profileId) {
    try { return this.db.isProfileFlagged(profileId); } catch (_) { return false; }
  }

  // Bench a profile that hit an account-level problem (signed out, checkpoint,
  // action blocked, restricted, etc.). Persists the disconnected state and pushes
  // a live update so the Profiles page turns red immediately. The profile stays
  // benched (skipped by every scheduler path) until the user marks it working.
  _flagProfileNeedsAttention(profileId, errMsg) {
    if (!profileId) return;
    try {
      const existingScan = this.db.getProfileScan(profileId);
      this.db.saveProfileScan(profileId, {
        profileLabel: existingScan?.profileLabel || profileId,
        loggedIn: false,
        info: existingScan?.scanInfo || null,
        error: errMsg || 'Needs attention',
      });
    } catch (_) {}
    try {
      this._setProfileActivity(profileId, 'disconnected', errMsg || 'Needs attention', {});
    } catch (_) {}
    try {
      const win = this._getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('fb-groups-profile-flagged', {
          profileId,
          loggedIn: false,
          error: errMsg || 'Needs attention',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (_) {}
  }

  // ─── Build edit-post text (custom text or URL-append fallback) ────────────

  _buildEditPostText(monitor, resolvedUrl) {
    const currentText = monitor.postMessage || '';
    if (monitor.editPostText) {
      // Custom text mode — substitute {{url}}
      const substituted = monitor.editPostText.replace(/\{\{url\}\}/gi, resolvedUrl);
      const keepLines = monitor.editPostKeepLines > 0 ? monitor.editPostKeepLines : 0;
      if (keepLines > 0) {
        const lines = currentText.split('\n');
        const kept = lines.slice(0, keepLines).join('\n');
        return kept ? `${kept}\n\n${substituted}` : substituted;
      }
      return substituted;
    }
    // Fallback: append resolved URL
    return currentText ? `${currentText}\n\n${resolvedUrl}` : resolvedUrl;
  }

  // ─── AI rewrite helper ────────────────────────────────────────────────────

  async _callAI(provider, model, promptText) {
    const fn = AI_PROVIDERS[provider?.toLowerCase()];
    if (!fn) throw new Error(`Unknown AI provider: ${provider}`);
    const call = fn();
    let result;
    // openai: openAi(apiKey, model, prompt, temperature) — apiKey ignored by queue
    // googleai: googleAI(model, prompt, temperature)
    // anthropic: anthropic(model, prompt, temperature)
    // openrouter: openRouter(model, prompt, temperature)
    // chineseai / deepseek / qwen / zhipu / moonshot: chineseAI(model, prompt, temperature)
    // deepseekbrowser: deepseekBrowser(prompt) — no model/key
    // qwenbrowser: qwenBrowser(prompt, imagePath, options) — no model/key
    const p = provider.toLowerCase();
    if (p === 'openai') {
      result = await call(null, model, promptText, 0.8);
    } else if (p === 'deepseekbrowser') {
      result = await call(promptText, false, false);
    } else if (p === 'qwenbrowser') {
      result = await call(promptText, null, {});
    } else {
      result = await call(model, promptText, 0.8);
    }
    if (!result?.success) throw new Error(result?.value || 'AI call failed');
    return result.value;
  }

  async _checkMonitor(monitor) {
    // Mutex: skip if already running for this monitor (prevents frontend + scheduler race)
    if (this.runningMonitors.has(monitor.id)) {
      this._log('info', `[CheckMonitor] Skipping story ${monitor.storyId} — already in progress`);
      return;
    }
    this.runningMonitors.add(monitor.id);
    // Claim: immediately advance next_check_at so no other tick picks this up while we run
    const claimedNext = new Date(Date.now() + this._nextCheckDelay(monitor.createdAt)).toISOString().slice(0, 19).replace('T', ' ');
    this.db.updateViralMonitor(monitor.id, monitor.currentShares, 'monitoring', null, claimedNext);
    try {
      await this._doCheckMonitor(monitor);
    } finally {
      this.runningMonitors.delete(monitor.id);
    }
  }

  async _doCheckMonitor(monitor) {
    // The action profile is always the original poster (must be author to edit).
    // If that profile is flagged, skip the entire monitor check until it's cleared.
    if (this._isProfileFlagged(monitor.profileId)) {
      this._log('info', `[CheckMonitor] Action profile ${monitor.profileId} is flagged as disconnected — skipping viral check until marked as working`, { storyId: monitor.storyId });
      const retryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      this.db.updateViralMonitor(monitor.id, monitor.currentShares, 'monitoring', null, retryAt);
      return;
    }

    const profileData = await this._getProfileData(monitor.profileId);

    // For scanning, pick a random non-flagged group profile each tick to spread the load
    let scanProfileId = monitor.profileId;
    let scanProfileData = profileData;
    try {
      const groupProfiles = this.db.getGroupProfiles(monitor.groupId);
      const available = groupProfiles.filter(p => !this._isProfileFlagged(p.profileId));
      if (available.length > 0) {
        const pick = available[Math.floor(Math.random() * available.length)];
        scanProfileId = pick.profileId;
        scanProfileData = await this._getProfileData(scanProfileId);
        // Fall back to action profile if random pick has no data
        if (!scanProfileData) { scanProfileId = monitor.profileId; scanProfileData = profileData; }
      }
    } catch (_) {}

    // Use direct post permalink as referrer — avoids scanning group feed entirely
    const postPermalink = `https://www.facebook.com/groups/${monitor.groupId}/permalink/${monitor.storyId}/`;

    // Acquire exclusive browser lock for the scan profile — skip if it's currently posting
    if (!this._acquireProfile(scanProfileId)) {
      this._log('info', `[CheckMonitor] Scan profile ${scanProfileId} is busy — rescheduling in 5min`, { storyId: monitor.storyId });
      const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      this.db.updateViralMonitor(monitor.id, monitor.currentShares, 'monitoring', null, retryAt);
      return;
    }

    this._setProfileActivity(scanProfileId, 'viral_check', `Checking virality of a post in "${monitor.groupName || monitor.groupId}"`, {
      groupId: monitor.groupId, groupName: monitor.groupName,
    });

    const scanResult = await facebookGroupScanPost({
      storyId: monitor.storyId, facebookGroupId: monitor.groupId, groupUrl: postPermalink,
      profileId: scanProfileId, profileData: scanProfileData,
    });

    if (!scanResult?.success) {
      this._log('error', `Viral scan failed for story ${monitor.storyId}: ${scanResult?.value}`, {
        groupId: monitor.groupId,
      });
      this._setProfileActivity(scanProfileId, 'idle', '', { groupId: monitor.groupId, groupName: monitor.groupName });
      this._releaseProfile(scanProfileId);
      // Apply back-off even on failure to avoid hammering on errors
      const nextCheckAt = new Date(Date.now() + this._nextCheckDelay(monitor.createdAt)).toISOString().slice(0, 19).replace('T', ' ');
      this.db.updateViralMonitor(monitor.id, monitor.currentShares, 'monitoring', null, nextCheckAt);
      return;
    }

    const metric = monitor.viralMetric || 'shares';
    const metricCount =
      metric === 'likes'    ? (scanResult.post?.reactionsCount || 0) :
      metric === 'comments' ? (scanResult.post?.commentsCount  || 0) :
                              (scanResult.post?.sharesCount    || 0);
    // Schedule next check using back-off based on monitor age
    const nextCheckAt = new Date(Date.now() + this._nextCheckDelay(monitor.createdAt)).toISOString().slice(0, 19).replace('T', ' ');
    this.db.updateViralMonitor(monitor.id, metricCount, 'monitoring', null, nextCheckAt);

    this._log('info', `Viral check: story ${monitor.storyId} → ${metricCount}/${monitor.targetShares} ${metric} (next in ${Math.round(this._nextCheckDelay(monitor.createdAt)/60000)}min)`, {
      groupId: monitor.groupId, storyId: monitor.storyId,
    });

    if (metricCount < monitor.targetShares) {
      this._setProfileActivity(scanProfileId, 'idle', '', { groupId: monitor.groupId, groupName: monitor.groupName });
      this._releaseProfile(scanProfileId);
      return;
    }

    // Release the scan profile lock; acquire the edit profile lock (they may differ)
    this._setProfileActivity(scanProfileId, 'idle', '', { groupId: monitor.groupId, groupName: monitor.groupName });
    this._releaseProfile(scanProfileId);

    await this._applyViralAction(monitor, metricCount);
  }

  // ─── Apply the viral action (extracted so the batched scan session and the
  //     force-check path can both reuse it). Acquires the action profile (the
  //     original poster), runs the optional URL automation + AI rewrite, performs
  //     edit_post / edit_comment, updates the monitor and alerts the UI. ────────
  async _applyViralAction(monitor, metricCount) {
    const metric = monitor.viralMetric || 'shares';
    const profileData = await this._getProfileData(monitor.profileId);

    if (!this._acquireProfile(monitor.profileId)) {
      this._log('info', `[ViralAction] Edit profile ${monitor.profileId} is busy — rescheduling viral action in 5min`, { storyId: monitor.storyId });
      const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      this.db.updateViralMonitor(monitor.id, metricCount, 'monitoring', null, retryAt);
      return;
    }

    // Threshold reached — the action profile (original poster) now performs the viral edit
    this._setProfileActivity(monitor.profileId, 'viral_edit', `Applying viral action on a post in "${monitor.groupName || monitor.groupId}"`, {
      groupId: monitor.groupId, groupName: monitor.groupName,
    });

    // ── Viral automation: run workflow to get article URL ─────────────────────
    let resolvedUrl = monitor.linkToAdd || '';
    if (monitor.viralAutomationId) {
      try {
        this._log('info', `Running viral URL automation (id: ${monitor.viralAutomationId})`, {
          groupId: monitor.groupId, storyId: monitor.storyId,
        });
        const automations = await readKey('automations');
        const automation  = automations?.find(a => a.id === monitor.viralAutomationId);
        if (!automation) throw new Error(`Automation ${monitor.viralAutomationId} not found`);
        const nodesObject = automation.data.drawflow.Home.data;
        const cleanedNodes = Object.entries(nodesObject).map(([, elm]) => ({
          id: elm.id, name: elm.name, data: elm.data, inputs: elm.inputs, outputs: elm.outputs,
        }));
        const autoInputs = { image: monitor.postImagePath || null, text: monitor.postMessage || '', url: '' };
        const autoResult = await executeAutomation(monitor.viralAutomationId, cleanedNodes, autoInputs, () => {}, 2, null);
        const urlFromAuto = autoResult?.value?.facebook?.url;
        if (!urlFromAuto) throw new Error('Automation produced no URL — connect a URL node to input_4 of the facebook-output node');
        resolvedUrl = urlFromAuto;
        this._log('success', `Viral automation produced URL: ${resolvedUrl}`, {
          groupId: monitor.groupId, storyId: monitor.storyId,
        });
      } catch (autoErr) {
        this._log('error', `Viral automation failed: ${autoErr.message} — aborting viral action`, {
          groupId: monitor.groupId, storyId: monitor.storyId,
        });
        const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        this.db.updateViralMonitor(monitor.id, metricCount, 'monitoring', null, retryAt);
        this._setProfileActivity(monitor.profileId, 'idle', '', { groupId: monitor.groupId, groupName: monitor.groupName });
        this._releaseProfile(monitor.profileId);
        return;
      }
    }

    // ── Threshold reached ────────────────────────────────────────────────────
    let actionSuccess = false;

    // Resolve the real Facebook group URL (facebookGroupEditPost navigates to it to capture session)
    const groupRecord = this.db.getGroupById(monitor.groupId);
    const groupUrl = groupRecord?.url || `https://www.facebook.com/groups/${monitor.groupId}`;

    // ── Step 1: AI rewrite the post (always, regardless of viralAction) ──────
    // Use fresh AI settings from imported_workflows JOIN (aiRewriteEnabled, aiPromptTemplate)
    // so updates made after the monitor was created take effect immediately.
    // Browser-based providers (deepseekbrowser, qwenbrowser) don't require a model field
    const _providerNeedsModel = !['deepseekbrowser', 'qwenbrowser'].includes((monitor.aiProvider || '').toLowerCase());
    const aiRewriteEnabled = monitor.aiRewriteEnabled && monitor.aiPromptTemplate && monitor.aiProvider && (!_providerNeedsModel || monitor.aiModel);
    if (aiRewriteEnabled) {
      // Substitute both {{post_text}} and {{url}} at trigger time
      const finalPrompt = monitor.aiPromptTemplate
        .replace(/\{\{post_text\}\}/gi, monitor.postMessage || '')
        .replace(/\{\{url\}\}/gi, resolvedUrl);
      try {
        this._log('info', `Running AI rewrite for viral post (provider: ${monitor.aiProvider})`, {
          groupId: monitor.groupId, storyId: monitor.storyId,
        });
        const newText = await this._callAI(monitor.aiProvider, monitor.aiModel, finalPrompt);
        const editResult = await facebookGroupEditPost({
          storyId: monitor.storyId, groupUrl,
          message: newText, profileId: monitor.profileId, profileData,
        });
        if (editResult?.success) {
          this._log('info', `AI rewrite applied to post`, { groupId: monitor.groupId, storyId: monitor.storyId });
          // For edit_post action this IS the primary action — mark success now
          if (monitor.viralAction === 'edit_post') actionSuccess = true;
        } else {
          this._log('error', `AI rewrite edit_post FAILED: ${editResult?.error || JSON.stringify(editResult)}`, {
            groupId: monitor.groupId, storyId: monitor.storyId,
          });
          // Fall back to custom text or URL append for edit_post
          if (monitor.viralAction === 'edit_post') {
            const fallbackText = this._buildEditPostText(monitor, resolvedUrl);
            const fbResult = await facebookGroupEditPost({
              storyId: monitor.storyId, groupUrl,
              message: fallbackText, profileId: monitor.profileId, profileData,
            });
            actionSuccess = !!fbResult?.success;
          }
        }
      } catch (aiErr) {
        this._log('error', `AI rewrite failed: ${aiErr.message}`, { groupId: monitor.groupId, storyId: monitor.storyId });
        // Fall back to custom text or URL append for edit_post
        if (monitor.viralAction === 'edit_post') {
          const fallbackText = this._buildEditPostText(monitor, resolvedUrl);
          const fbResult = await facebookGroupEditPost({
            storyId: monitor.storyId, groupUrl,
            message: fallbackText, profileId: monitor.profileId, profileData,
          });
          actionSuccess = !!fbResult?.success;
        }
      }
    } else if (monitor.viralAction === 'edit_post') {
      // No AI rewrite — use custom text if set, otherwise append URL
      const newText = this._buildEditPostText(monitor, resolvedUrl);
      const editResult = await facebookGroupEditPost({
        storyId: monitor.storyId, groupUrl,
        message: newText, profileId: monitor.profileId, profileData,
      });
      actionSuccess = !!editResult?.success;
      if (!actionSuccess) {
        this._log('error', `edit_post FAILED: ${editResult?.error || editResult?.value || JSON.stringify(editResult)}`, {
          groupId: monitor.groupId, storyId: monitor.storyId,
        });
      }
    }

    // ── Step 2: edit_comment action ───────────────────────────────────────────
    if (monitor.viralAction === 'edit_comment') {
      if (!monitor.commentId) {
        this._log('error', `edit_comment action but monitor has no commentId — cannot edit. storyId: ${monitor.storyId}`, {
          groupId: monitor.groupId, storyId: monitor.storyId,
        });
      } else {
        const editText = monitor.editCommentText
          ? monitor.editCommentText.replace(/\{\{url\}\}/gi, resolvedUrl)
          : resolvedUrl;
        if (!editText) {
          this._log('error', `edit_comment action but no editCommentText or URL set. storyId: ${monitor.storyId}`, {
            groupId: monitor.groupId, storyId: monitor.storyId,
          });
        } else {
          this._log('info', `edit_comment: editing comment ${monitor.commentId}, text="${editText.slice(0,80)}"`, {
            groupId: monitor.groupId, storyId: monitor.storyId,
          });
          const editResult = await facebookGroupEditComment({
            commentId: monitor.commentId, facebookGroupId: monitor.groupId, groupUrl: '',
            newText: editText, profileId: monitor.profileId, profileData,
          });
          actionSuccess = !!editResult?.success;
          if (!actionSuccess) {
            this._log('error', `edit_comment FAILED: ${editResult?.error || JSON.stringify(editResult)}`, {
              groupId: monitor.groupId, storyId: monitor.storyId,
            });
          }
        }
      }

      // ── Also edit the post (custom text, no AI) if editPostText is configured ─
      if (monitor.editPostText && !monitor.aiRewriteEnabled) {
        try {
          const postEditText = this._buildEditPostText(monitor, resolvedUrl);
          this._log('info', `edit_comment: also editing post with custom text, text="${postEditText.slice(0,80)}"`, {
            groupId: monitor.groupId, storyId: monitor.storyId,
          });
          const postEditResult = await facebookGroupEditPost({
            storyId: monitor.storyId, groupUrl,
            message: postEditText, profileId: monitor.profileId, profileData,
          });
          if (!postEditResult?.success) {
            this._log('error', `edit_comment also-edit-post FAILED: ${postEditResult?.error || JSON.stringify(postEditResult)}`, {
              groupId: monitor.groupId, storyId: monitor.storyId,
            });
          }
        } catch (e) {
          this._log('error', `edit_comment also-edit-post error: ${e.message}`, { groupId: monitor.groupId, storyId: monitor.storyId });
        }
      }
    }

    const triggeredAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (actionSuccess) {
      this.db.updateViralMonitor(monitor.id, metricCount, 'triggered', triggeredAt);
    } else {
      // Keep monitoring so it retries on the next tick; back off 5 min to avoid hammering
      const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      this.db.updateViralMonitor(monitor.id, metricCount, 'monitoring', null, retryAt);
    }

    this._log('viral', `🚀 Viral threshold reached! story ${monitor.storyId}: ${metricCount} ${metric} → ${monitor.viralAction} (${actionSuccess ? 'success' : 'failed'})`, {
      groupId: monitor.groupId, storyId: monitor.storyId, metricCount, metric, actionSuccess,
    });

    // Push viral alert to renderer
    try {
      const win = this._getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('fb-groups-viral-alert', {
          monitorId: monitor.id, storyId: monitor.storyId, groupId: monitor.groupId,
          metricCount, metric, action: monitor.viralAction, actionSuccess,
        });
      }
    } catch (_) {}

    // Viral action finished — return the action profile to idle and release the browser lock
    this._setProfileActivity(monitor.profileId, 'idle', '', { groupId: monitor.groupId, groupName: monitor.groupName });
    this._releaseProfile(monitor.profileId);
  }
}

module.exports = FBGroupsScheduler;
