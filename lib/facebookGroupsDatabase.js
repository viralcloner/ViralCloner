const { getTargetProfileIds } = require('./facebookGroupsTargetProfiles');
const { normalizeKeepLines } = require('./facebookGroupsPostContent');
const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");

class FacebookGroupsDatabase {
  constructor() {
    const dbPath = path.join(app.getPath("userData"), "facebook-groups.db");
    this.db = new Database(dbPath);

    // WAL mode for best concurrent read performance
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("cache_size = -8000"); // 8MB page cache

    this.initSchema();
    this._runMigrations();

    console.log("✓ Facebook Groups database initialized:", dbPath);
  }

  // Convert snake_case DB columns → camelCase for frontend
  _toCamelCase(obj) {
    if (!obj) return obj;
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      out[camelKey] = value;
    }
    if (typeof out.profileIds === 'string') {
      // Invalid stored selections must not silently broaden to Auto.
      try { out.profileIds = JSON.parse(out.profileIds); } catch (_) { out.profileIds = ['__invalid_selection__']; }
    }
    // Parse JSON fields
    if (typeof out.scheduleConfig === 'string') {
      try { out.scheduleConfig = JSON.parse(out.scheduleConfig); } catch (_) { out.scheduleConfig = null; }
    }
    if (typeof out.scanInfo === 'string') {
      try { out.scanInfo = JSON.parse(out.scanInfo); } catch (_) { out.scanInfo = null; }
    }
    return out;
  }

  initSchema() {
    this.db.exec(`
      -- ============================================
      -- GROUPS TABLE
      -- ============================================
      CREATE TABLE IF NOT EXISTS groups (
        group_id   TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        url        TEXT    DEFAULT '',
        notes      TEXT    DEFAULT '',
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );

      -- ============================================
      -- GROUP PROFILES (many-to-many via structure profiles)
      -- ============================================
      CREATE TABLE IF NOT EXISTS group_profiles (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id        TEXT    NOT NULL,
        structure_id    TEXT    NOT NULL,
        profile_id      TEXT    NOT NULL,
        profile_label   TEXT    NOT NULL DEFAULT '',
        structure_label TEXT            DEFAULT '',
        added_at        TEXT    NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
        UNIQUE(group_id, profile_id)
      );

      -- ============================================
      -- POST LOG (history of posts sent to each group)
      -- ============================================
      CREATE TABLE IF NOT EXISTS group_post_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      TEXT    NOT NULL,
        profile_id    TEXT            DEFAULT '',
        profile_label TEXT            DEFAULT '',
        message       TEXT            DEFAULT '',
        status        TEXT    CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
        posted_at     TEXT    NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE
      );

      -- ============================================
      -- INDEXES for fast lookups on large datasets
      -- ============================================
      CREATE INDEX IF NOT EXISTS idx_gp_group_id      ON group_profiles(group_id);
      CREATE INDEX IF NOT EXISTS idx_gpl_group_id     ON group_post_log(group_id);
      CREATE INDEX IF NOT EXISTS idx_gpl_posted_at    ON group_post_log(posted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_groups_name      ON groups(name);
      CREATE INDEX IF NOT EXISTS idx_groups_updated   ON groups(updated_at DESC);

      -- ============================================
      -- IMPORTED WORKFLOWS (automation → FB Groups)
      -- ============================================
      CREATE TABLE IF NOT EXISTS imported_workflows (
        id                         INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id                TEXT    NOT NULL UNIQUE,
        name                       TEXT    NOT NULL DEFAULT '',
        status                     TEXT    CHECK(status IN ('active','paused')) DEFAULT 'paused',
        delay_minutes              INTEGER NOT NULL DEFAULT 30,
        schedule_config            TEXT             DEFAULT NULL,
        post_url_as_comment        INTEGER NOT NULL DEFAULT 0,
        url_comment_prefix         TEXT             DEFAULT '',
        viral_monitor_enabled      INTEGER NOT NULL DEFAULT 0,
        viral_shares_target        INTEGER NOT NULL DEFAULT 100,
        viral_action               TEXT    CHECK(viral_action IN ('edit_post','edit_comment')) DEFAULT 'edit_comment',
        viral_initial_comment_text TEXT             DEFAULT '',
        viral_edit_comment_text    TEXT             DEFAULT '',
        loop_workflow              INTEGER NOT NULL DEFAULT 0,
        viral_ai_rewrite           INTEGER NOT NULL DEFAULT 0,
        viral_ai_provider          TEXT             DEFAULT NULL,
        viral_ai_model             TEXT             DEFAULT NULL,
        viral_ai_prompt_text       TEXT             DEFAULT NULL,
        viral_automation_id        TEXT             DEFAULT NULL,
        viral_edit_post_text       TEXT             DEFAULT NULL,
        viral_edit_post_keep_lines INTEGER          DEFAULT NULL,
        is_manual                  INTEGER NOT NULL DEFAULT 0,
        created_at                 TEXT    NOT NULL,
        updated_at                 TEXT    NOT NULL
      );

      -- ============================================
      -- WORKFLOW GROUP TARGETS
      -- ============================================
      CREATE TABLE IF NOT EXISTS workflow_group_targets (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id    TEXT    NOT NULL,
        group_id       TEXT    NOT NULL,
        profile_id     TEXT    DEFAULT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        last_posted_at TEXT    DEFAULT NULL,
        FOREIGN KEY (workflow_id) REFERENCES imported_workflows(workflow_id) ON DELETE CASCADE,
        UNIQUE(workflow_id, group_id)
      );

      -- ============================================
      -- AUTOMATION POSTS (scheduler-driven posting log)
      -- ============================================
      CREATE TABLE IF NOT EXISTS automation_posts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id      TEXT    NOT NULL,
        group_id         TEXT    NOT NULL,
        profile_id       TEXT    DEFAULT '',
        workflow_post_id TEXT    DEFAULT NULL,
        status           TEXT    CHECK(status IN ('pending','running','sent','failed','skipped')) DEFAULT 'pending',
        message          TEXT    DEFAULT '',
        image_path       TEXT    DEFAULT NULL,
        url              TEXT    DEFAULT NULL,
        story_id         TEXT    DEFAULT NULL,
        first_comment_id TEXT    DEFAULT NULL,
        scheduled_at     TEXT    NOT NULL,
        posted_at        TEXT    DEFAULT NULL,
        error_message    TEXT    DEFAULT NULL,
        FOREIGN KEY (workflow_id) REFERENCES imported_workflows(workflow_id) ON DELETE CASCADE
      );

      -- ============================================
      -- VIRAL MONITORS
      -- ============================================
      CREATE TABLE IF NOT EXISTS viral_monitors (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_post_id INTEGER NOT NULL,
        story_id           TEXT    NOT NULL,
        group_id           TEXT    NOT NULL,
        profile_id         TEXT    DEFAULT '',
        comment_id         TEXT    DEFAULT NULL,
        target_shares      INTEGER NOT NULL DEFAULT 100,
        current_shares     INTEGER NOT NULL DEFAULT 0,
        status             TEXT    CHECK(status IN ('monitoring','triggered','done','failed','expired')) DEFAULT 'monitoring',
        viral_action       TEXT    CHECK(viral_action IN ('edit_post','edit_comment')) DEFAULT 'edit_comment',
        link_to_add        TEXT    DEFAULT '',
        ai_prompt_text     TEXT    DEFAULT NULL,
        edit_comment_text  TEXT    DEFAULT NULL,
        edit_post_text     TEXT    DEFAULT NULL,
        edit_post_keep_lines INTEGER DEFAULT NULL,
        last_checked_at    TEXT    DEFAULT NULL,
        next_check_at      TEXT    DEFAULT NULL,
        expires_at         TEXT    DEFAULT NULL,
        triggered_at       TEXT    DEFAULT NULL,
        created_at         TEXT    NOT NULL,
        FOREIGN KEY (automation_post_id) REFERENCES automation_posts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_iw_status       ON imported_workflows(status);
      CREATE INDEX IF NOT EXISTS idx_wgt_workflow_id ON workflow_group_targets(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_ap_workflow_id  ON automation_posts(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_ap_status       ON automation_posts(status);
      CREATE INDEX IF NOT EXISTS idx_vm_status       ON viral_monitors(status);

      -- ============================================
      -- MANUAL POSTS (user-entered posts for manual workflows)
      -- ============================================
      CREATE TABLE IF NOT EXISTS manual_posts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT    NOT NULL,
        text        TEXT    DEFAULT '',
        image_path  TEXT    DEFAULT NULL,
        url         TEXT    DEFAULT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES imported_workflows(workflow_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mp_workflow ON manual_posts(workflow_id);

      -- ============================================
      -- POSTS LIBRARY (global reusable content posts)
      -- ============================================
      CREATE TABLE IF NOT EXISTS posts_library (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL DEFAULT '',
        text        TEXT    DEFAULT '',
        image_path  TEXT    DEFAULT NULL,
        url         TEXT    DEFAULT NULL,
        created_at  TEXT    NOT NULL
      );

      -- Workflow → library post assignments (many-to-many)
      CREATE TABLE IF NOT EXISTS workflow_library_posts (
        workflow_id  TEXT    NOT NULL,
        post_id      INTEGER NOT NULL,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workflow_id, post_id),
        FOREIGN KEY (workflow_id) REFERENCES imported_workflows(workflow_id) ON DELETE CASCADE,
        FOREIGN KEY (post_id)     REFERENCES posts_library(id)               ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_wlp_workflow ON workflow_library_posts(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_wlp_post     ON workflow_library_posts(post_id);

      -- ============================================
      -- PROFILE SCANS (cached Facebook identity + login health per profile)
      -- ============================================
      CREATE TABLE IF NOT EXISTS profile_scans (
        profile_id      TEXT PRIMARY KEY,
        profile_label   TEXT    DEFAULT '',
        logged_in       INTEGER NOT NULL DEFAULT 0,
        scan_info       TEXT             DEFAULT NULL,
        scan_error      TEXT             DEFAULT NULL,
        last_scanned_at TEXT             DEFAULT NULL
      );
    `);
  }

  _runMigrations() {
    // v2: Add post_id to group_post_log
    try { this.db.prepare(`ALTER TABLE group_post_log ADD COLUMN post_id TEXT DEFAULT NULL`).run(); } catch (_) {}
    // v3: automation tables are created in initSchema via CREATE TABLE IF NOT EXISTS — no ALTER needed
    const iwCols = this.db.prepare('PRAGMA table_info(imported_workflows)').all().map(c => c.name);
    // Additive post presentation migration. Zero lines keeps the complete post;
    // existing workflows retain their behavior and original library content.
    for (const [column, definition] of Object.entries({
      post_keep_lines: 'INTEGER NOT NULL DEFAULT 0',
      post_suffix: "TEXT NOT NULL DEFAULT ''",
      post_content_as_comment: 'INTEGER NOT NULL DEFAULT 0',
    })) {
      if (!iwCols.includes(column)) this.db.prepare(`ALTER TABLE imported_workflows ADD COLUMN ${column} ${definition}`).run();
    }
    if (!iwCols.includes('viral_ai_rewrite'))   { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_ai_rewrite INTEGER NOT NULL DEFAULT 0').run(); } catch(_) {} }
    if (!iwCols.includes('viral_ai_provider'))  { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_ai_provider TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!iwCols.includes('viral_ai_model'))     { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_ai_model TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!iwCols.includes('viral_ai_prompt_text')){ try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_ai_prompt_text TEXT DEFAULT NULL').run(); } catch(_) {} }
    const vmCols = this.db.prepare('PRAGMA table_info(viral_monitors)').all().map(c => c.name);
    if (!vmCols.includes('ai_prompt_text'))  { try { this.db.prepare('ALTER TABLE viral_monitors ADD COLUMN ai_prompt_text TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!vmCols.includes('next_check_at'))   { try { this.db.prepare('ALTER TABLE viral_monitors ADD COLUMN next_check_at TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!vmCols.includes('expires_at'))      { try { this.db.prepare('ALTER TABLE viral_monitors ADD COLUMN expires_at TEXT DEFAULT NULL').run(); } catch(_) {} }
    const iwCols2 = this.db.prepare('PRAGMA table_info(imported_workflows)').all().map(c => c.name);
    if (!iwCols2.includes('viral_edit_comment_text')) { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_edit_comment_text TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!iwCols2.includes('viral_metric')) { try { this.db.prepare("ALTER TABLE imported_workflows ADD COLUMN viral_metric TEXT NOT NULL DEFAULT 'shares'").run(); } catch(_) {} }
    if (!vmCols.includes('edit_comment_text')) { try { this.db.prepare('ALTER TABLE viral_monitors ADD COLUMN edit_comment_text TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!vmCols.includes('viral_metric')) { try { this.db.prepare("ALTER TABLE viral_monitors ADD COLUMN viral_metric TEXT NOT NULL DEFAULT 'shares'").run(); } catch(_) {} }
    const iwCols3 = this.db.prepare('PRAGMA table_info(imported_workflows)').all().map(c => c.name);
    if (!iwCols3.includes('is_completed'))   { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN is_completed INTEGER NOT NULL DEFAULT 0').run(); } catch(_) {} }
    if (!iwCols3.includes('schedule_config')){ try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN schedule_config TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!iwCols3.includes('viral_automation_id')){ try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_automation_id TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!iwCols3.includes('is_manual'))      { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0').run(); } catch(_) {} }
    const iwCols4 = this.db.prepare('PRAGMA table_info(imported_workflows)').all().map(c => c.name);
    if (!iwCols4.includes('viral_edit_post_text')) { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_edit_post_text TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!iwCols4.includes('viral_edit_post_keep_lines')) { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN viral_edit_post_keep_lines INTEGER DEFAULT NULL').run(); } catch(_) {} }
    const vmCols2 = this.db.prepare('PRAGMA table_info(viral_monitors)').all().map(c => c.name);
    if (!vmCols2.includes('edit_post_text')) { try { this.db.prepare('ALTER TABLE viral_monitors ADD COLUMN edit_post_text TEXT DEFAULT NULL').run(); } catch(_) {} }
    if (!vmCols2.includes('edit_post_keep_lines')) { try { this.db.prepare('ALTER TABLE viral_monitors ADD COLUMN edit_post_keep_lines INTEGER DEFAULT NULL').run(); } catch(_) {} }
    // v4: persisted per-target next post time so the inter-post delay survives app restarts
    const wgtCols = this.db.prepare('PRAGMA table_info(workflow_group_targets)').all().map(c => c.name);
    // Additive migration: NULL preserves legacy Auto/single-profile targets.
    // A JSON array restricts scheduling to the manually selected accounts.
    if (!wgtCols.includes('profile_ids')) this.db.prepare('ALTER TABLE workflow_group_targets ADD COLUMN profile_ids TEXT DEFAULT NULL').run();
    if (!wgtCols.includes('next_post_at')) { try { this.db.prepare('ALTER TABLE workflow_group_targets ADD COLUMN next_post_at TEXT DEFAULT NULL').run(); } catch(_) {} }
    // v5: cached group info from the daily auto-scan (cover, name, member/post stats)
    const gCols = this.db.prepare('PRAGMA table_info(groups)').all().map(c => c.name);
    const addGroupCol = (col, ddl) => { if (!gCols.includes(col)) { try { this.db.prepare(`ALTER TABLE groups ADD COLUMN ${ddl}`).run(); } catch(_) {} } };
    addGroupCol('cover_image',       'cover_image TEXT DEFAULT NULL');
    addGroupCol('profile_picture',   'profile_picture TEXT DEFAULT NULL');
    addGroupCol('privacy_label',     'privacy_label TEXT DEFAULT NULL');
    addGroupCol('members_total',     'members_total INTEGER DEFAULT NULL');
    addGroupCol('members_formatted', 'members_formatted TEXT DEFAULT NULL');
    addGroupCol('created_time',      'created_time INTEGER DEFAULT NULL');
    addGroupCol('posts_today',       'posts_today INTEGER DEFAULT NULL');
    addGroupCol('posts_last_month',  'posts_last_month INTEGER DEFAULT NULL');
    addGroupCol('scan_info',         'scan_info TEXT DEFAULT NULL');
    addGroupCol('auto_scan_enabled', 'auto_scan_enabled INTEGER NOT NULL DEFAULT 1');
    addGroupCol('last_scanned_at',   'last_scanned_at TEXT DEFAULT NULL');

    // v6: older databases created viral_monitors with a CHECK constraint that did
    // NOT include the 'expired' status. Setting status='expired' on those throws
    // "CHECK constraint failed", which breaks the posts feed. SQLite can't ALTER a
    // CHECK constraint, so rebuild the table (preserving data) when 'expired' is
    // missing from its definition.
    try {
      const vmDef = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='viral_monitors'"
      ).get();
      if (vmDef && vmDef.sql && !/'expired'/.test(vmDef.sql)) {
        const oldCols = this.db.prepare('PRAGMA table_info(viral_monitors)').all().map(c => c.name);
        const newCols = ['id','automation_post_id','story_id','group_id','profile_id','comment_id',
          'target_shares','current_shares','status','viral_action','link_to_add','ai_prompt_text',
          'edit_comment_text','edit_post_text','edit_post_keep_lines','viral_metric','last_checked_at',
          'next_check_at','expires_at','triggered_at','created_at'];
        const common = oldCols.filter(c => newCols.includes(c)).join(', ');
        this.db.pragma('foreign_keys = OFF');
        const rebuild = this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE viral_monitors_new (
              id                 INTEGER PRIMARY KEY AUTOINCREMENT,
              automation_post_id INTEGER NOT NULL,
              story_id           TEXT    NOT NULL,
              group_id           TEXT    NOT NULL,
              profile_id         TEXT    DEFAULT '',
              comment_id         TEXT    DEFAULT NULL,
              target_shares      INTEGER NOT NULL DEFAULT 100,
              current_shares     INTEGER NOT NULL DEFAULT 0,
              status             TEXT    CHECK(status IN ('monitoring','triggered','done','failed','expired')) DEFAULT 'monitoring',
              viral_action       TEXT    CHECK(viral_action IN ('edit_post','edit_comment')) DEFAULT 'edit_comment',
              link_to_add        TEXT    DEFAULT '',
              ai_prompt_text     TEXT    DEFAULT NULL,
              edit_comment_text  TEXT    DEFAULT NULL,
              edit_post_text     TEXT    DEFAULT NULL,
              edit_post_keep_lines INTEGER DEFAULT NULL,
              viral_metric       TEXT    NOT NULL DEFAULT 'shares',
              last_checked_at    TEXT    DEFAULT NULL,
              next_check_at      TEXT    DEFAULT NULL,
              expires_at         TEXT    DEFAULT NULL,
              triggered_at       TEXT    DEFAULT NULL,
              created_at         TEXT    NOT NULL,
              FOREIGN KEY (automation_post_id) REFERENCES automation_posts(id) ON DELETE CASCADE
            );
          `);
          this.db.exec(`INSERT INTO viral_monitors_new (${common}) SELECT ${common} FROM viral_monitors;`);
          this.db.exec(`DROP TABLE viral_monitors;`);
          this.db.exec(`ALTER TABLE viral_monitors_new RENAME TO viral_monitors;`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_vm_status ON viral_monitors(status);`);
        });
        rebuild();
        this.db.pragma('foreign_keys = ON');
        console.log("[FBGroupsDB] Migrated viral_monitors to allow status='expired'");
      }
    } catch (e) {
      console.error('[FBGroupsDB] viral_monitors expired-status migration failed:', e.message);
      try { this.db.pragma('foreign_keys = ON'); } catch (_) {}
    }

    // v7: per-workflow Human-mode override. NULL = inherit global setting, 0 = off,
    // 1 = on. When on, posting is forced through the warmed-up browser path that
    // opens the real composer (emits composer telemetry) instead of the naked HTTP
    // GraphQL mutation, to reduce the behavioral automation signature.
    const iwCols5 = this.db.prepare('PRAGMA table_info(imported_workflows)').all().map(c => c.name);
    if (!iwCols5.includes('human_mode')) { try { this.db.prepare('ALTER TABLE imported_workflows ADD COLUMN human_mode INTEGER DEFAULT NULL').run(); } catch(_) {} }

    // v8: per-profile lifetime-stats reset watermark. When set, getProfileStats counts
    // only posts logged AFTER this timestamp, so the user can zero a profile's
    // sent/failed totals. The daily-usage query is independent and is NOT affected.
    const psCols = this.db.prepare('PRAGMA table_info(profile_scans)').all().map(c => c.name);
    if (!psCols.includes('stats_reset_at')) { try { this.db.prepare('ALTER TABLE profile_scans ADD COLUMN stats_reset_at TEXT DEFAULT NULL').run(); } catch(_) {} }

    // v9: per-profile comment-only cooldown. Facebook can temporarily throttle just
    // the "comment" action (api_error_code 368 / code 1390008) while posting still
    // works. This watermark benches the profile from comment-requiring workflows
    // until it expires, without affecting its ability to post.
    if (!psCols.includes('comment_blocked_until')) { try { this.db.prepare('ALTER TABLE profile_scans ADD COLUMN comment_blocked_until TEXT DEFAULT NULL').run(); } catch(_) {} }
  }

  // Mark any automation_posts left in 'running' (app was closed mid-post) as failed.
  // Called once on scheduler startup so stale rows don't pollute stats/running counts forever.
  resetStaleRunningPosts() {
    try {
      const res = this.db.prepare(
        `UPDATE automation_posts SET status = 'failed', error_message = 'Interrupted by app restart' WHERE status = 'running'`
      ).run();
      return res.changes || 0;
    } catch (_) { return 0; }
  }

  // ============================================================
  //  GROUPS CRUD
  // ============================================================

  createGroup(groupId, name, url = "", notes = "") {
    const now = new Date().toISOString();
    // Name is optional — it is auto-filled by the group scan once a profile is linked.
    const safeName = (name && name.trim()) ? name.trim() : "Scanning…";
    this.db.prepare(`
      INSERT INTO groups (group_id, name, url, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(groupId, safeName, (url || "").trim(), (notes || "").trim(), now, now);
    return this.getGroupById(groupId);
  }

  // Persist the result of a group info scan (cover, name, members, post stats).
  // The canonical Facebook name always overrides the stored name when present.
  saveGroupScanInfo(groupId, info) {
    if (!info) return this.getGroupById(groupId);
    const now = new Date().toISOString();
    const newName = (info.name && String(info.name).trim()) ? String(info.name).trim() : null;
    this.db.prepare(`
      UPDATE groups SET
        name              = COALESCE(?, name),
        cover_image       = ?,
        profile_picture   = ?,
        privacy_label     = ?,
        members_total     = ?,
        members_formatted = ?,
        created_time      = ?,
        posts_today       = ?,
        posts_last_month  = ?,
        scan_info         = ?,
        last_scanned_at   = ?,
        updated_at        = ?
      WHERE group_id = ?
    `).run(
      newName,
      info.coverImage || null,
      info.profilePicture || null,
      info.privacyLabel || null,
      info.membersTotal ?? null,
      info.membersFormatted || null,
      info.createdTime ?? null,
      info.postsToday ?? null,
      info.postsLastMonth ?? null,
      JSON.stringify(info),
      now, now, groupId
    );
    return this.getGroupById(groupId);
  }

  setGroupAutoScan(groupId, enabled) {
    return this.db.prepare(`UPDATE groups SET auto_scan_enabled = ? WHERE group_id = ?`)
      .run(enabled ? 1 : 0, groupId);
  }

  // Groups eligible for an automatic scan: auto-scan on, at least one linked profile,
  // and either never scanned or last scanned before the given cutoff ISO timestamp.
  getGroupsDueForScan(cutoffIso) {
    const rows = this.db.prepare(`
      SELECT g.group_id, g.url, g.last_scanned_at
      FROM   groups g
      WHERE  g.auto_scan_enabled = 1
        AND  EXISTS (SELECT 1 FROM group_profiles gp WHERE gp.group_id = g.group_id)
        AND  (g.last_scanned_at IS NULL OR g.last_scanned_at < ?)
      ORDER  BY (g.last_scanned_at IS NULL) DESC, g.last_scanned_at ASC
    `).all(cutoffIso);
    return rows.map((r) => this._toCamelCase(r));
  }

  updateGroup(groupId, name, url = "", notes = "") {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE groups
      SET name = ?, url = ?, notes = ?, updated_at = ?
      WHERE group_id = ?
    `).run(name.trim(), url.trim(), notes.trim(), now, groupId);
    return this.getGroupById(groupId);
  }

  deleteGroup(groupId) {
    return this.db.prepare(`DELETE FROM groups WHERE group_id = ?`).run(groupId);
  }

  updateGroupImagePaths(groupId, { coverImage = null, profilePicture = null } = {}) {
    const current = this.getGroupById(groupId);
    if (!current) return null;
    const scanInfo = {
      ...(current.scanInfo || {}),
      coverImage: coverImage || current.coverImage || null,
      profilePicture: profilePicture || current.profilePicture || null,
    };
    this.db.prepare(`
      UPDATE groups
      SET cover_image = ?, profile_picture = ?, scan_info = ?, updated_at = ?
      WHERE group_id = ?
    `).run(
      scanInfo.coverImage,
      scanInfo.profilePicture,
      JSON.stringify(scanInfo),
      new Date().toISOString(),
      groupId,
    );
    return this.getGroupById(groupId);
  }

  getGroupById(groupId) {
    const row = this.db.prepare(`
      SELECT g.*,
             COUNT(DISTINCT gp.id)  AS profile_count,
             COUNT(DISTINCT pl.id)  AS total_posts,
             MAX(pl.posted_at)      AS last_post_at
      FROM   groups g
      LEFT JOIN group_profiles gp ON g.group_id = gp.group_id
      LEFT JOIN group_post_log pl ON g.group_id = pl.group_id
      WHERE  g.group_id = ?
      GROUP  BY g.group_id
    `).get(groupId);
    return row ? this._toCamelCase(row) : null;
  }

  getAllGroups() {
    const rows = this.db.prepare(`
      SELECT g.*,
             COUNT(DISTINCT gp.id)  AS profile_count,
             COUNT(DISTINCT pl.id)  AS total_posts,
             MAX(pl.posted_at)      AS last_post_at
      FROM   groups g
      LEFT JOIN group_profiles gp ON g.group_id = gp.group_id
      LEFT JOIN group_post_log pl ON g.group_id = pl.group_id
      GROUP  BY g.group_id
      ORDER  BY g.updated_at DESC
    `).all();
    return rows.map((r) => this._toCamelCase(r));
  }

  searchGroups(query) {
    const like = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT g.*,
             COUNT(DISTINCT gp.id)  AS profile_count,
             COUNT(DISTINCT pl.id)  AS total_posts,
             MAX(pl.posted_at)      AS last_post_at
      FROM   groups g
      LEFT JOIN group_profiles gp ON g.group_id = gp.group_id
      LEFT JOIN group_post_log pl ON g.group_id = pl.group_id
      WHERE  g.name LIKE ? OR g.url LIKE ? OR g.notes LIKE ?
      GROUP  BY g.group_id
      ORDER  BY g.updated_at DESC
    `).all(like, like, like);
    return rows.map((r) => this._toCamelCase(r));
  }

  getStats() {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*)                              FROM groups)                        AS total_groups,
        (SELECT COUNT(*)                              FROM group_profiles)                AS total_profiles,
        (SELECT COUNT(*)                              FROM group_post_log WHERE status = 'sent') AS total_posts_sent
    `).get();
    return this._toCamelCase(row);
  }

  // ============================================================
  //  PROFILES
  // ============================================================

  addProfileToGroup(groupId, structureId, profileId, profileLabel, structureLabel = "") {
    const now = new Date().toISOString();
    return this.db.prepare(`
      INSERT OR IGNORE INTO group_profiles
        (group_id, structure_id, profile_id, profile_label, structure_label, added_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(groupId, structureId, profileId, profileLabel, structureLabel, now);
  }

  removeProfileFromGroup(groupId, profileId) {
    return this.db.prepare(`
      DELETE FROM group_profiles WHERE group_id = ? AND profile_id = ?
    `).run(groupId, profileId);
  }

  moveProfileToStructure(profileId, sourceStructureId, targetStructureId, targetStructureLabel = "") {
    return this.db.prepare(`
      UPDATE group_profiles
      SET structure_id = ?, structure_label = ?
      WHERE profile_id = ? AND structure_id = ?
    `).run(targetStructureId, targetStructureLabel, profileId, sourceStructureId);
  }

  getGroupProfiles(groupId) {
    const rows = this.db.prepare(`
      SELECT gp.*,
             ps.logged_in       AS logged_in,
             ps.scan_info        AS scan_info,
             ps.scan_error       AS scan_error,
             ps.last_scanned_at  AS last_scanned_at
      FROM   group_profiles gp
      LEFT JOIN profile_scans ps ON ps.profile_id = gp.profile_id
      WHERE  gp.group_id = ?
      ORDER  BY gp.added_at ASC
    `).all(groupId);
    return rows.map((r) => this._toCamelCase(r));
  }

  // ============================================================
  //  PROFILE SCANS (Facebook identity + login health, cached)
  // ============================================================

  // Persist the result of a profile scan. `info` is the flat object returned by
  // facebookProfileScanInfo (name, userId, username, profilePicture, coverImage,
  // friendsText, followersText, scannedAt). loggedIn drives the health badge.
  saveProfileScan(profileId, { profileLabel = "", loggedIn = false, info = null, error = null } = {}) {
    if (!profileId) return null;
    const now = (info && info.scannedAt) || new Date().toISOString();
    this.db.prepare(`
      INSERT INTO profile_scans (profile_id, profile_label, logged_in, scan_info, scan_error, last_scanned_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        profile_label   = excluded.profile_label,
        logged_in       = excluded.logged_in,
        scan_info       = COALESCE(excluded.scan_info, profile_scans.scan_info),
        scan_error      = excluded.scan_error,
        last_scanned_at = excluded.last_scanned_at
    `).run(
      profileId,
      profileLabel || "",
      loggedIn ? 1 : 0,
      info ? JSON.stringify(info) : null,
      error || null,
      now
    );
    return this.getProfileScan(profileId);
  }

  getProfileScan(profileId) {
    if (!profileId) return null;
    const row = this.db.prepare(`SELECT * FROM profile_scans WHERE profile_id = ?`).get(profileId);
    return row ? this._toCamelCase(row) : null;
  }

  getAllProfileScans() {
    return this.db.prepare(`SELECT * FROM profile_scans`)
      .all()
      .map((row) => this._toCamelCase(row));
  }

  updateProfileScanImages(profileId, { coverImage = null, profilePicture = null } = {}) {
    const current = this.getProfileScan(profileId);
    if (!current) return null;
    const scanInfo = {
      ...(current.scanInfo || {}),
      coverImage: coverImage || current.scanInfo?.coverImage || null,
      profilePicture: profilePicture || current.scanInfo?.profilePicture || null,
    };
    this.db.prepare(`UPDATE profile_scans SET scan_info = ? WHERE profile_id = ?`)
      .run(JSON.stringify(scanInfo), profileId);
    return this.getProfileScan(profileId);
  }

  deleteProfileScan(profileId) {
    return this.db.prepare(`DELETE FROM profile_scans WHERE profile_id = ?`).run(profileId);
  }

  // Returns true when the profile has been explicitly scanned/flagged and logged_in = 0.
  // Profiles that have never been scanned (no row) are NOT considered flagged.
  isProfileFlagged(profileId) {
    if (!profileId) return false;
    const row = this.db.prepare(
      `SELECT logged_in FROM profile_scans WHERE profile_id = ? AND last_scanned_at IS NOT NULL`
    ).get(profileId);
    return row ? row.logged_in === 0 : false;
  }

  // User-initiated: clear the disconnected flag so the profile is used again.
  markProfileWorking(profileId) {
    if (!profileId) return;
    this.db.prepare(
      `UPDATE profile_scans SET logged_in = 1, scan_error = NULL WHERE profile_id = ?`
    ).run(profileId);
  }

  // Bench a profile from comment-requiring workflows until `untilIso` (Facebook's
  // temporary per-action spam-prevention throttle on commenting). Posting itself
  // is unaffected. Upserts so a never-scanned profile still gets a row.
  setProfileCommentBlocked(profileId, untilIso) {
    if (!profileId) return;
    this.db.prepare(`
      INSERT INTO profile_scans (profile_id, comment_blocked_until)
      VALUES (?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET comment_blocked_until = excluded.comment_blocked_until
    `).run(profileId, untilIso);
  }

  getProfileCommentBlockedUntil(profileId) {
    if (!profileId) return null;
    const row = this.db.prepare(`SELECT comment_blocked_until FROM profile_scans WHERE profile_id = ?`).get(profileId);
    return row ? row.comment_blocked_until : null;
  }

  // true while the profile is still inside its comment cooldown window.
  isProfileCommentBlocked(profileId) {
    const until = this.getProfileCommentBlockedUntil(profileId);
    return !!(until && new Date(until).getTime() > Date.now());
  }

  // Distinct profiles linked to at least one group that are due for an automatic
  // health/identity scan: never scanned, or last scanned before the cutoff ISO.
  // Profiles currently flagged as disconnected (logged_in = 0) are EXCLUDED — a
  // disconnected profile must not be re-opened in the background by the auto-scan;
  // it stays untouched until the user clicks "Mark as working".
  // Returns one row per profile with a representative label/structure id.
  getProfilesDueForScan(cutoffIso) {
    const rows = this.db.prepare(`
      SELECT
        gp.profile_id              AS profile_id,
        MAX(gp.profile_label)      AS profile_label,
        ps.last_scanned_at         AS last_scanned_at
      FROM   group_profiles gp
      LEFT JOIN profile_scans ps ON ps.profile_id = gp.profile_id
      GROUP BY gp.profile_id
      HAVING (ps.last_scanned_at IS NULL OR ps.last_scanned_at < ?)
         AND (MAX(ps.logged_in) IS NULL OR MAX(ps.logged_in) = 1)
      ORDER  BY (ps.last_scanned_at IS NULL) DESC, ps.last_scanned_at ASC
    `).all(cutoffIso);
    return rows.map((r) => this._toCamelCase(r));
  }

  // Distinct group-linked profiles currently flagged as disconnected (logged_in = 0)
  // whose last scan is older than the given ISO cutoff. Used by the auto-recovery
  // loop to re-check disconnected profiles on a short interval so they clear their
  // flag automatically once the user reconnects them. `limit` caps how many are
  // returned per pass to avoid opening too many browsers at once.
  getFlaggedProfiles(staleBeforeIso, limit = 5) {
    const rows = this.db.prepare(`
      SELECT
        gp.profile_id          AS profile_id,
        MAX(gp.profile_label)  AS profile_label,
        ps.last_scanned_at     AS last_scanned_at
      FROM   group_profiles gp
      JOIN   profile_scans ps ON ps.profile_id = gp.profile_id
      WHERE  ps.logged_in = 0
        AND  ps.last_scanned_at IS NOT NULL
        AND  ps.last_scanned_at < ?
      GROUP BY gp.profile_id
      ORDER  BY ps.last_scanned_at ASC
      LIMIT  ?
    `).all(staleBeforeIso, Math.max(1, Number(limit) || 5));
    return rows.map((r) => this._toCamelCase(r));
  }

  // Every distinct profile that belongs to at least one group, with how many groups it covers.
  getAllGroupProfiles() {
    const rows = this.db.prepare(`
      SELECT
        profile_id,
        MAX(profile_label)   AS profile_label,
        MAX(structure_id)    AS structure_id,
        MAX(structure_label) AS structure_label,
        COUNT(DISTINCT group_id) AS group_count,
        MIN(added_at)        AS added_at
      FROM group_profiles
      GROUP BY profile_id
      ORDER BY profile_label COLLATE NOCASE ASC
    `).all();
    return rows.map((r) => this._toCamelCase(r));
  }

  // Groups a profile is attached to (for the profile detail view).
  getProfileGroups(profileId) {
    const rows = this.db.prepare(`
      SELECT gp.group_id, g.name AS group_name
      FROM   group_profiles gp
      LEFT JOIN groups g ON gp.group_id = g.group_id
      WHERE  gp.profile_id = ?
      ORDER  BY g.name COLLATE NOCASE ASC
    `).all(profileId);
    return rows.map((r) => this._toCamelCase(r));
  }

  // Lifetime post stats for one profile (sent / failed / last activity). When a
  // stats_reset_at watermark is set (user clicked "Reset stats"), only posts logged
  // after that point are counted. The daily-usage counter is independent of this.
  getProfileStats(profileId) {
    const resetRow = this.db.prepare(`SELECT stats_reset_at FROM profile_scans WHERE profile_id = ?`).get(profileId);
    const resetAt = (resetRow && resetRow.stats_reset_at) ? resetRow.stats_reset_at : null;
    const row = this.db.prepare(`
      SELECT
        COUNT(*)                                                AS total_posts,
        SUM(CASE WHEN status = 'sent'   THEN 1 ELSE 0 END)      AS sent_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)      AS failed_count,
        MAX(posted_at)                                          AS last_posted_at
      FROM group_post_log
      WHERE profile_id = ?
        AND (? IS NULL OR posted_at >= ?)
    `).get(profileId, resetAt, resetAt);
    return this._toCamelCase(row || { total_posts: 0, sent_count: 0, failed_count: 0, last_posted_at: null });
  }

  // Reset a profile's lifetime sent/failed totals without deleting any post-log rows.
  // Writes a stats_reset_at watermark on the profile_scans row (upsert) so future
  // getProfileStats calls ignore everything posted before now. The current daily
  // usage is preserved because the daily-count query does not read this watermark.
  resetProfileStats(profileId) {
    if (!profileId) return;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO profile_scans (profile_id, stats_reset_at)
      VALUES (?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET stats_reset_at = excluded.stats_reset_at
    `).run(profileId, now);
  }

  // Paginated post history for one profile (with group name).
  getProfilePostHistory(profileId, limit = 20, offset = 0) {
    const rows = this.db.prepare(`
      SELECT pl.*, g.name AS group_name
      FROM   group_post_log pl
      LEFT JOIN groups g ON pl.group_id = g.group_id
      WHERE  pl.profile_id = ?
      ORDER  BY pl.posted_at DESC
      LIMIT  ? OFFSET ?
    `).all(profileId, limit, offset);
    const total = this.db.prepare(`
      SELECT COUNT(*) AS c FROM group_post_log WHERE profile_id = ?
    `).get(profileId).c;
    return { rows: rows.map((r) => this._toCamelCase(r)), total };
  }

  // Count of posts a single profile sent since the given ISO timestamp (used for the daily cap).
  getProfileSentCountToday(profileId, sinceIso) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM group_post_log
      WHERE profile_id = ? AND status = 'sent' AND posted_at >= ?
    `).get(profileId, sinceIso);
    return row.c || 0;
  }

  // Most recent successful-post timestamp for a profile (ISO string) or null.
  // Used to seed the per-profile minimum posting gap so it survives app restarts.
  getProfileLastSentAt(profileId) {
    const row = this.db.prepare(`
      SELECT MAX(posted_at) AS t FROM group_post_log
      WHERE profile_id = ? AND status = 'sent'
    `).get(profileId);
    return (row && row.t) ? row.t : null;
  }

  // Oldest successful-post timestamp for a profile (ISO string) or null.
  // Used to compute how long a profile has been posting for the warm-up ramp.
  getProfileFirstSentAt(profileId) {
    const row = this.db.prepare(`
      SELECT MIN(posted_at) AS t FROM group_post_log
      WHERE profile_id = ? AND status = 'sent'
    `).get(profileId);
    return (row && row.t) ? row.t : null;
  }

  // Batch version: { profileId: count } for every profile since the given ISO timestamp.
  getProfilesSentCountToday(sinceIso) {
    const rows = this.db.prepare(`
      SELECT profile_id, COUNT(*) AS c FROM group_post_log
      WHERE status = 'sent' AND posted_at >= ?
      GROUP BY profile_id
    `).all(sinceIso);
    const map = {};
    for (const r of rows) map[r.profile_id] = r.c;
    return map;
  }

  // ============================================================
  //  POST LOG
  // ============================================================

  addPostLog(groupId, profileId, profileLabel, message, status = "sent", postId = null) {
    const now = new Date().toISOString();
    return this.db.prepare(`
      INSERT INTO group_post_log (group_id, profile_id, profile_label, message, status, posted_at, post_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(groupId, profileId || "", profileLabel || "", message || "", status, now, postId || null);
  }

  getGroupPostLog(groupId, limit = 20, offset = 0) {
    const rows = this.db.prepare(`
      SELECT * FROM group_post_log
      WHERE group_id = ?
      ORDER BY posted_at DESC
      LIMIT ? OFFSET ?
    `).all(groupId, limit, offset);
    const total = this.db.prepare(`
      SELECT COUNT(*) AS c FROM group_post_log WHERE group_id = ?
    `).get(groupId).c;
    return { rows: rows.map((r) => this._toCamelCase(r)), total };
  }

  updatePostLogPostId(id, postId) {
    return this.db.prepare(`
      UPDATE group_post_log SET post_id = ? WHERE id = ?
    `).run(postId || null, id);
  }

  getRecentActivity(limit = 10) {
    const rows = this.db.prepare(`
      SELECT pl.*, g.name AS group_name
      FROM   group_post_log pl
      LEFT JOIN groups g ON pl.group_id = g.group_id
      ORDER  BY pl.posted_at DESC
      LIMIT  ?
    `).all(limit);
    return rows.map((r) => this._toCamelCase(r));
  }

  // ============================================================
  //  IMPORTED WORKFLOWS
  // ============================================================

  importWorkflow(workflowId, name, settings = {}) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO imported_workflows
        (workflow_id, name, status, delay_minutes, schedule_config, post_url_as_comment, url_comment_prefix, post_keep_lines, post_suffix, post_content_as_comment,
         viral_monitor_enabled, viral_shares_target, viral_metric, viral_action, viral_initial_comment_text,
         viral_edit_comment_text, loop_workflow, viral_ai_rewrite, viral_ai_provider, viral_ai_model, viral_ai_prompt_text,
         viral_automation_id, viral_edit_post_text, viral_edit_post_keep_lines, is_manual, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workflow_id) DO UPDATE SET
        name=excluded.name, delay_minutes=excluded.delay_minutes,
        schedule_config=excluded.schedule_config,
        post_url_as_comment=excluded.post_url_as_comment,
        url_comment_prefix=excluded.url_comment_prefix,
        post_keep_lines=excluded.post_keep_lines,
        post_suffix=excluded.post_suffix,
        post_content_as_comment=excluded.post_content_as_comment,
        viral_monitor_enabled=excluded.viral_monitor_enabled,
        viral_shares_target=excluded.viral_shares_target,
        viral_metric=excluded.viral_metric,
        viral_action=excluded.viral_action,
        viral_initial_comment_text=excluded.viral_initial_comment_text,
        viral_edit_comment_text=excluded.viral_edit_comment_text,
        loop_workflow=excluded.loop_workflow,
        viral_ai_rewrite=excluded.viral_ai_rewrite,
        viral_ai_provider=excluded.viral_ai_provider,
        viral_ai_model=excluded.viral_ai_model,
        viral_ai_prompt_text=excluded.viral_ai_prompt_text,
        viral_automation_id=excluded.viral_automation_id,
        viral_edit_post_text=excluded.viral_edit_post_text,
        viral_edit_post_keep_lines=excluded.viral_edit_post_keep_lines,
        updated_at=excluded.updated_at
    `).run(
      workflowId, name,
      settings.status || 'paused',
      settings.delayMinutes ?? 30,
      settings.scheduleConfig ? JSON.stringify(settings.scheduleConfig) : null,
      settings.postUrlAsComment ? 1 : 0,
      settings.urlCommentPrefix || '',
      normalizeKeepLines(settings.postKeepLines),
      String(settings.postSuffix || ''),
      settings.postContentAsComment ? 1 : 0,
      settings.viralMonitorEnabled ? 1 : 0,
      settings.viralSharesTarget ?? 100,
      settings.viralMetric || 'shares',
      settings.viralAction || 'edit_comment',
      settings.viralInitialCommentText || '',
      settings.viralEditCommentText || '',
      settings.loopWorkflow ? 1 : 0,
      settings.viralAiRewrite ? 1 : 0,
      settings.viralAiProvider || null,
      settings.viralAiModel || null,
      settings.viralAiPromptText || null,
      settings.viralAutomationId || null,
      settings.viralEditPostText || null,
      settings.viralEditPostKeepLines ?? null,
      settings.isManual ? 1 : 0,
      now, now
    );
    return this.getImportedWorkflowById(workflowId);
  }

  removeImportedWorkflow(workflowId) {
    return this.db.prepare(`DELETE FROM imported_workflows WHERE workflow_id = ?`).run(workflowId);
  }

  getImportedWorkflowIds() {
    return this.db.prepare(`SELECT workflow_id FROM imported_workflows`).all().map(r => r.workflow_id);
  }

  getImportedWorkflows() {
    const rows = this.db.prepare(`
      SELECT iw.*,
        (SELECT COUNT(*) FROM workflow_group_targets wgt WHERE wgt.workflow_id = iw.workflow_id) AS target_count,
        (SELECT COUNT(*) FROM automation_posts ap WHERE ap.workflow_id = iw.workflow_id AND ap.status = 'sent') AS posts_sent,
        (SELECT COUNT(*) FROM automation_posts ap WHERE ap.workflow_id = iw.workflow_id AND ap.status = 'running') AS running_count,
        (SELECT MAX(ap.posted_at) FROM automation_posts ap WHERE ap.workflow_id = iw.workflow_id AND ap.status = 'sent') AS last_run_at,
        (SELECT MIN(wgt.next_post_at) FROM workflow_group_targets wgt WHERE wgt.workflow_id = iw.workflow_id AND wgt.enabled = 1 AND wgt.next_post_at IS NOT NULL) AS next_post_at
      FROM imported_workflows iw
      ORDER BY iw.created_at DESC
    `).all();
    return rows.map(r => this._toCamelCase(r));
  }

  getImportedWorkflowById(workflowId) {
    const row = this.db.prepare(`
      SELECT iw.*,
        (SELECT COUNT(*) FROM workflow_group_targets wgt WHERE wgt.workflow_id = iw.workflow_id) AS target_count,
        (SELECT COUNT(*) FROM automation_posts ap WHERE ap.workflow_id = iw.workflow_id AND ap.status = 'sent') AS posts_sent,
        (SELECT MAX(ap.posted_at) FROM automation_posts ap WHERE ap.workflow_id = iw.workflow_id AND ap.status = 'sent') AS last_run_at
      FROM imported_workflows iw
      WHERE iw.workflow_id = ?
    `).get(workflowId);
    return row ? this._toCamelCase(row) : null;
  }

  updateImportedWorkflowStatus(workflowId, status, isCompleted = null) {
    const now = new Date().toISOString();
    if (isCompleted !== null) {
      return this.db.prepare(`
        UPDATE imported_workflows SET status = ?, is_completed = ?, updated_at = ? WHERE workflow_id = ?
      `).run(status, isCompleted ? 1 : 0, now, workflowId);
    }
    return this.db.prepare(`
      UPDATE imported_workflows SET status = ?, updated_at = ? WHERE workflow_id = ?
    `).run(status, now, workflowId);
  }

  resetWorkflowForRestart(workflowId) {
    const now = new Date().toISOString();
    // Mark active, clear completed flag
    this.db.prepare(`
      UPDATE imported_workflows SET status = 'active', is_completed = 0, updated_at = ? WHERE workflow_id = ?
    `).run(now, workflowId);
    // Clear last_posted_at on all targets so the delay check passes immediately
    this.db.prepare(`
      UPDATE workflow_group_targets SET last_posted_at = NULL, next_post_at = NULL WHERE workflow_id = ?
    `).run(workflowId);
    // Delete automation_posts so the round-robin counter resets to 0
    this.db.prepare(`
      DELETE FROM automation_posts WHERE workflow_id = ?
    `).run(workflowId);
  }

  updateImportedWorkflowSettings(workflowId, settings) {
    const now = new Date().toISOString();
    // Human-mode is a tri-state (NULL inherit / 0 off / 1 on) so it can't use the
    // COALESCE-keep pattern below (COALESCE can't reset a column back to NULL).
    // Update it explicitly only when the caller actually supplied a value.
    if (settings.humanMode !== undefined) {
      const hm = settings.humanMode === null ? null : (settings.humanMode ? 1 : 0);
      try { this.db.prepare('UPDATE imported_workflows SET human_mode = ?, updated_at = ? WHERE workflow_id = ?').run(hm, now, workflowId); } catch (_) {}
    }
    return this.db.prepare(`
      UPDATE imported_workflows SET
        name = COALESCE(?, name),
        delay_minutes = COALESCE(?, delay_minutes),
        schedule_config = COALESCE(?, schedule_config),
        post_url_as_comment = COALESCE(?, post_url_as_comment),
        url_comment_prefix = COALESCE(?, url_comment_prefix),
        post_keep_lines = COALESCE(?, post_keep_lines),
        post_suffix = COALESCE(?, post_suffix),
        post_content_as_comment = COALESCE(?, post_content_as_comment),
        viral_monitor_enabled = COALESCE(?, viral_monitor_enabled),
        viral_shares_target = COALESCE(?, viral_shares_target),
        viral_metric = COALESCE(?, viral_metric),
        viral_action = COALESCE(?, viral_action),
        viral_initial_comment_text = COALESCE(?, viral_initial_comment_text),
        viral_edit_comment_text = COALESCE(?, viral_edit_comment_text),
        loop_workflow = COALESCE(?, loop_workflow),
        viral_ai_rewrite = COALESCE(?, viral_ai_rewrite),
        viral_ai_provider = COALESCE(?, viral_ai_provider),
        viral_ai_model = COALESCE(?, viral_ai_model),
        viral_ai_prompt_text = COALESCE(?, viral_ai_prompt_text),
        viral_automation_id = COALESCE(?, viral_automation_id),
        viral_edit_post_text = COALESCE(?, viral_edit_post_text),
        viral_edit_post_keep_lines = COALESCE(?, viral_edit_post_keep_lines),
        updated_at = ?
      WHERE workflow_id = ?
    `).run(
      settings.name ?? null,
      settings.delayMinutes ?? null,
      settings.scheduleConfig !== undefined ? JSON.stringify(settings.scheduleConfig) : null,
      settings.postUrlAsComment != null ? (settings.postUrlAsComment ? 1 : 0) : null,
      settings.urlCommentPrefix ?? null,
      settings.postKeepLines == null ? null : normalizeKeepLines(settings.postKeepLines),
      settings.postSuffix == null ? null : String(settings.postSuffix),
      settings.postContentAsComment == null ? null : (settings.postContentAsComment ? 1 : 0),
      settings.viralMonitorEnabled != null ? (settings.viralMonitorEnabled ? 1 : 0) : null,
      settings.viralSharesTarget ?? null,
      settings.viralMetric ?? null,
      settings.viralAction ?? null,
      settings.viralInitialCommentText ?? null,
      settings.viralEditCommentText ?? null,
      settings.loopWorkflow != null ? (settings.loopWorkflow ? 1 : 0) : null,
      settings.viralAiRewrite != null ? (settings.viralAiRewrite ? 1 : 0) : null,
      settings.viralAiProvider ?? null,
      settings.viralAiModel ?? null,
      settings.viralAiPromptText ?? null,
      settings.viralAutomationId !== undefined ? (settings.viralAutomationId || null) : null,
      settings.viralEditPostText !== undefined ? (settings.viralEditPostText || null) : null,
      settings.viralEditPostKeepLines !== undefined ? (settings.viralEditPostKeepLines ?? null) : null,
      now, workflowId
    );
  }

  // ============================================================
  //  WORKFLOW GROUP TARGETS
  // ============================================================

  setWorkflowGroupTargets(workflowId, targets = []) {
    const del = this.db.prepare(`DELETE FROM workflow_group_targets WHERE workflow_id = ?`);
    const ins = this.db.prepare(`
      INSERT INTO workflow_group_targets (workflow_id, group_id, profile_id, profile_ids, enabled)
      VALUES (?, ?, ?, ?, 1)
    `);
    const run = this.db.transaction(() => {
      del.run(workflowId);
      for (const t of targets) {
        const ids = getTargetProfileIds(t);
        ins.run(workflowId, t.groupId, ids.length === 1 ? ids[0] : null, ids.length ? JSON.stringify(ids) : null);
      }
    });
    run();
  }

  getWorkflowGroupTargets(workflowId) {
    const rows = this.db.prepare(`
      SELECT wgt.*, g.name AS group_name, g.url AS group_url
      FROM workflow_group_targets wgt
      LEFT JOIN groups g ON wgt.group_id = g.group_id
      WHERE wgt.workflow_id = ?
      ORDER BY wgt.id ASC
    `).all(workflowId);
    return rows.map(r => this._toCamelCase(r));
  }

  updateGroupTargetLastPosted(id, ts) {
    return this.db.prepare(`UPDATE workflow_group_targets SET last_posted_at = ? WHERE id = ?`).run(ts, id);
  }

  // Persist the time the next post to this target is allowed (jitter locked in at send time).
  setTargetNextPostAt(id, iso) {
    return this.db.prepare(`UPDATE workflow_group_targets SET next_post_at = ? WHERE id = ?`).run(iso, id);
  }

  // Anti-burst on restart: any target that has already posted before but whose next_post_at
  // is missing or in the past gets a fresh full delay window measured from `nowIso`.
  // Never-posted targets (last_posted_at IS NULL) are left untouched so new workflows post promptly.
  rescheduleOverdueTargets(workflowId, nextIso) {
    return this.db.prepare(`
      UPDATE workflow_group_targets
      SET next_post_at = ?
      WHERE workflow_id = ?
        AND last_posted_at IS NOT NULL
        AND (next_post_at IS NULL OR next_post_at <= ?)
    `).run(nextIso, workflowId, new Date().toISOString());
  }

  // ============================================================
  //  AUTOMATION POSTS
  // ============================================================

  createAutomationPost(workflowId, groupId, profileId, workflowPostId, data = {}) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO automation_posts
        (workflow_id, group_id, profile_id, workflow_post_id, status, message, image_path, url, scheduled_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      workflowId, groupId, profileId || '', workflowPostId || null,
      'running', data.message || '', data.imagePath || null, data.url || null, now
    );
    return result.lastInsertRowid;
  }

  updateAutomationPostStatus(id, status, storyId = null, commentId = null, errorMessage = null) {
    const now = status === 'sent' ? new Date().toISOString() : null;
    return this.db.prepare(`
      UPDATE automation_posts SET
        status = ?,
        story_id = COALESCE(?, story_id),
        first_comment_id = COALESCE(?, first_comment_id),
        error_message = COALESCE(?, error_message),
        posted_at = COALESCE(?, posted_at)
      WHERE id = ?
    `).run(status, storyId, commentId, errorMessage, now, id);
  }

  updateAutomationPostFirstComment(id, commentId) {
    return this.db.prepare(`UPDATE automation_posts SET first_comment_id = ? WHERE id = ?`).run(commentId, id);
  }

  /** Returns the profile_id of the account that originally sent the post with the given story_id in that group. */
  getPostProfileId(groupId, storyId) {
    const row = this.db.prepare(`
      SELECT profile_id FROM automation_posts
      WHERE group_id = ? AND story_id = ? AND status = 'sent'
      ORDER BY posted_at DESC LIMIT 1
    `).get(groupId, storyId);
    return row?.profile_id || null;
  }

  // ============================================================
  //  MANUAL POSTS CRUD
  // ============================================================

  createManualPost(workflowId, text, imagePath, url) {
    const now = new Date().toISOString();
    const maxOrder = this.db.prepare(`SELECT COALESCE(MAX(sort_order),0) AS m FROM manual_posts WHERE workflow_id = ?`).get(workflowId)?.m ?? 0;
    const result = this.db.prepare(`
      INSERT INTO manual_posts (workflow_id, text, image_path, url, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workflowId, text || '', imagePath || null, url || null, maxOrder + 1, now);
    return this.getManualPostById(result.lastInsertRowid);
  }

  getManualPostById(id) {
    const row = this.db.prepare(`SELECT * FROM manual_posts WHERE id = ?`).get(id);
    return row ? this._toCamelCase(row) : null;
  }

  getManualPosts(workflowId) {
    const rows = this.db.prepare(`SELECT * FROM manual_posts WHERE workflow_id = ? ORDER BY sort_order ASC, id ASC`).all(workflowId);
    return rows.map(r => this._toCamelCase(r));
  }

  getManualPostCount(workflowId) {
    return this.db.prepare(`SELECT COUNT(*) AS c FROM manual_posts WHERE workflow_id = ?`).get(workflowId)?.c ?? 0;
  }

  updateManualPost(id, text, imagePath, url) {
    this.db.prepare(`
      UPDATE manual_posts SET text = ?, image_path = ?, url = ? WHERE id = ?
    `).run(text || '', imagePath !== undefined ? imagePath : null, url || null, id);
    return this.getManualPostById(id);
  }

  deleteManualPost(id) {
    return this.db.prepare(`DELETE FROM manual_posts WHERE id = ?`).run(id);
  }

  reorderManualPosts(workflowId, orderedIds) {
    const stmt = this.db.prepare(`UPDATE manual_posts SET sort_order = ? WHERE id = ? AND workflow_id = ?`);
    const run  = this.db.transaction(() => {
      orderedIds.forEach((id, idx) => stmt.run(idx + 1, id, workflowId));
    });
    run();
  }

  // ============================================================
  //  POSTS LIBRARY CRUD
  // ============================================================

  createLibraryPost(name, text, imagePath, url) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO posts_library (name, text, image_path, url, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name || '', text || '', imagePath || null, url || null, now);
    return this.getLibraryPostById(result.lastInsertRowid);
  }

  getLibraryPostById(id) {
    const row = this.db.prepare(`SELECT * FROM posts_library WHERE id = ?`).get(id);
    return row ? this._toCamelCase(row) : null;
  }

  getLibraryPosts() {
    return this.db.prepare(`SELECT * FROM posts_library ORDER BY id DESC`).all().map(r => this._toCamelCase(r));
  }

  // Returns every non-null image_path referenced by library posts + automation posts.
  // Used by the cleanup manager to protect these images from the orphan sweep.
  getAllAutomationPostImages() {
    const paths = [];
    try {
      this.db.prepare(`SELECT image_path FROM posts_library WHERE image_path IS NOT NULL AND image_path != ''`)
        .all().forEach(r => paths.push(r.image_path));
    } catch (_) {}
    try {
      this.db.prepare(`SELECT DISTINCT image_path FROM automation_posts WHERE image_path IS NOT NULL AND image_path != ''`)
        .all().forEach(r => paths.push(r.image_path));
    } catch (_) {}
    return paths;
  }

  updateLibraryPost(id, name, text, imagePath, url) {
    this.db.prepare(`
      UPDATE posts_library SET name = ?, text = ?, image_path = ?, url = ? WHERE id = ?
    `).run(name || '', text || '', imagePath !== undefined ? imagePath : null, url || null, id);
    return this.getLibraryPostById(id);
  }

  deleteLibraryPost(id) {
    return this.db.prepare(`DELETE FROM posts_library WHERE id = ?`).run(id);
  }

  setWorkflowLibraryPosts(workflowId, postIds) {
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM workflow_library_posts WHERE workflow_id = ?`).run(workflowId);
      const stmt = this.db.prepare(`INSERT OR IGNORE INTO workflow_library_posts (workflow_id, post_id, sort_order) VALUES (?, ?, ?)`);
      (postIds || []).forEach((pid, idx) => stmt.run(workflowId, Number(pid), idx + 1));
    });
    run();
  }

  getWorkflowLibraryPosts(workflowId) {
    const rows = this.db.prepare(`
      SELECT pl.*, wlp.sort_order
      FROM posts_library pl
      INNER JOIN workflow_library_posts wlp ON wlp.post_id = pl.id
      WHERE wlp.workflow_id = ?
      ORDER BY wlp.sort_order ASC, pl.id ASC
    `).all(workflowId);
    return rows.map(r => this._toCamelCase(r));
  }

  getWorkflowLibraryPostCount(workflowId) {
    return this.db.prepare(`SELECT COUNT(*) AS c FROM workflow_library_posts WHERE workflow_id = ?`).get(workflowId)?.c ?? 0;
  }

  /** Returns the profile_id that owns a given commentId (looks in automation_posts.first_comment_id then viral_monitors.comment_id). */
  getCommentProfileId(groupId, commentId) {
    // Check automation_posts first (comment was posted as first_comment_id)
    const fromPost = this.db.prepare(`
      SELECT profile_id FROM automation_posts
      WHERE group_id = ? AND first_comment_id = ? AND status = 'sent'
      ORDER BY posted_at DESC LIMIT 1
    `).get(groupId, commentId);
    if (fromPost?.profile_id) return fromPost.profile_id;
    // Fall back to viral_monitors (viral comment was created separately)
    const fromMonitor = this.db.prepare(`
      SELECT profile_id FROM viral_monitors
      WHERE group_id = ? AND comment_id = ? LIMIT 1
    `).get(groupId, commentId);
    return fromMonitor?.profile_id || null;
  }

  getAutomationPostSentCount(workflowId, groupId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM automation_posts
      WHERE workflow_id = ? AND group_id = ? AND status = 'sent'
    `).get(workflowId, groupId);
    return row?.c || 0;
  }

  getRecentAutomationPosts(limit = 20) {
    const rows = this.db.prepare(`
      SELECT ap.*,
        g.name AS group_name,
        iw.name AS workflow_name
      FROM automation_posts ap
      LEFT JOIN groups g ON ap.group_id = g.group_id
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      ORDER BY ap.scheduled_at DESC
      LIMIT ?
    `).all(limit);
    return rows.map(r => this._toCamelCase(r));
  }

  getAutomationPostsFeed(limit = 20, offset = 0, vmStatus = null) {
    // Expire overdue monitors first so posts past their "stop monitoring after"
    // window drop out of the monitoring view immediately — even while viral
    // monitoring is paused (this runs on every feed load, independent of the
    // scheduler tick which is gated by the pause flag).
    this.expireOverdueViralMonitors();
    let whereClause = `WHERE ap.status = 'sent'`;
    const params = [];
    if (vmStatus === 'monitoring') {
      whereClause += ` AND vm.status = 'monitoring'`;
    } else if (vmStatus === 'triggered') {
      whereClause += ` AND vm.status = 'triggered'`;
    } else {
      // Default ('all') view hides posts whose monitor expired (passed the
      // "stop monitoring after" window). Those live on the Expired sub-page.
      // Posts without a monitor (vm.status IS NULL) are always kept.
      whereClause += ` AND (vm.status IS NULL OR vm.status != 'expired')`;
    }
    const rows = this.db.prepare(`
      SELECT ap.*,
        g.name AS group_name,
        g.url  AS group_url,
        iw.name AS workflow_name,
        iw.viral_monitor_enabled AS vm_enabled,
        vm.current_shares  AS vm_current_count,
        vm.target_shares   AS vm_target_count,
        vm.viral_metric    AS vm_metric,
        vm.status          AS vm_status,
        vm.last_checked_at AS vm_last_checked_at,
        vm.next_check_at   AS vm_next_check_at,
        vm.triggered_at    AS vm_triggered_at
      FROM automation_posts ap
      LEFT JOIN groups g             ON ap.group_id = g.group_id
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      LEFT JOIN viral_monitors vm     ON vm.automation_post_id = ap.id
      ${whereClause}
      ORDER BY ap.posted_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM automation_posts ap
       LEFT JOIN viral_monitors vm ON vm.automation_post_id = ap.id
       ${whereClause}`
    ).get();
    return { rows: rows.map(r => this._toCamelCase(r)), total: totalRow.c };
  }

  /**
   * Feed of posts whose viral monitor has 'expired' (passed the "stop monitoring
   * after" window). Shown on the Expired sub-page as a compact table.
   * Defaults to 100 rows per page. Ordered by most-recently expired first.
   */
  getExpiredPostsFeed(limit = 100, offset = 0) {
    // Make sure any newly-overdue monitors are marked expired before listing.
    this.expireOverdueViralMonitors();
    const rows = this.db.prepare(`
      SELECT ap.*,
        g.name AS group_name,
        g.url  AS group_url,
        iw.name AS workflow_name,
        vm.current_shares  AS vm_current_count,
        vm.target_shares   AS vm_target_count,
        vm.viral_metric    AS vm_metric,
        vm.status          AS vm_status,
        vm.last_checked_at AS vm_last_checked_at,
        vm.expires_at      AS vm_expires_at,
        vm.triggered_at    AS vm_triggered_at
      FROM automation_posts ap
      LEFT JOIN groups g             ON ap.group_id = g.group_id
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      LEFT JOIN viral_monitors vm     ON vm.automation_post_id = ap.id
      WHERE ap.status = 'sent' AND vm.status = 'expired'
      ORDER BY vm.expires_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM automation_posts ap
       LEFT JOIN viral_monitors vm ON vm.automation_post_id = ap.id
       WHERE ap.status = 'sent' AND vm.status = 'expired'`
    ).get();
    return { rows: rows.map(r => this._toCamelCase(r)), total: totalRow.c };
  }

  getAutomationPostsByWorkflow(workflowId, limit = 20, offset = 0) {
    const rows = this.db.prepare(`
      SELECT ap.*, g.name AS group_name
      FROM automation_posts ap
      LEFT JOIN groups g ON ap.group_id = g.group_id
      WHERE ap.workflow_id = ?
      ORDER BY ap.scheduled_at DESC
      LIMIT ? OFFSET ?
    `).all(workflowId, limit, offset);
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM automation_posts WHERE workflow_id = ?`).get(workflowId).c;
    return { rows: rows.map(r => this._toCamelCase(r)), total };
  }

  // ============================================================
  //  VIRAL MONITORS
  // ============================================================

  // Helper: convert JS Date to SQLite-compatible UTC string 'YYYY-MM-DD HH:MM:SS' (no ms, no T, no Z)
  _toSqliteDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
  }

  createViralMonitor(automationPostId, storyId, groupId, profileId, targetShares, linkToAdd, commentId, viralAction, aiPromptText, editCommentText, viralMetric, opts = {}, editPostText = null, editPostKeepLines = null) {
    const now         = this._toSqliteDate(new Date());
    // User-configurable (from global settings); fall back to historical defaults.
    const intervalMin = Number(opts.checkIntervalMin) > 0 ? Number(opts.checkIntervalMin) : 5;
    const expiryHours = Number(opts.expiryHours)     > 0 ? Number(opts.expiryHours)     : 48;
    const nextCheckAt = this._toSqliteDate(new Date(Date.now() + intervalMin * 60 * 1000));
    const expiresAt   = this._toSqliteDate(new Date(Date.now() + expiryHours * 60 * 60 * 1000));
    const result = this.db.prepare(`
      INSERT INTO viral_monitors
        (automation_post_id, story_id, group_id, profile_id, comment_id, target_shares,
         viral_metric, viral_action, link_to_add, ai_prompt_text, edit_comment_text, edit_post_text, edit_post_keep_lines, next_check_at, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(automationPostId, storyId, groupId, profileId || '', commentId || null,
           targetShares || 100, viralMetric || 'shares', viralAction || 'edit_comment', linkToAdd || '',
           aiPromptText || null, editCommentText || null, editPostText || null, editPostKeepLines ?? null,
           nextCheckAt, expiresAt, now);
    return result.lastInsertRowid;
  }

  stopViralMonitorByPostId(automationPostId) {
    return this.db.prepare(
      `UPDATE viral_monitors SET status = 'done' WHERE automation_post_id = ? AND status = 'monitoring'`
    ).run(automationPostId);
  }

  deleteAutomationPost(id) {
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM viral_monitors WHERE automation_post_id = ?`).run(id);
      this.db.prepare(`DELETE FROM automation_posts WHERE id = ?`).run(id);
    });
    run();
  }

  updateViralMonitor(id, currentShares, status, triggeredAt = null, nextCheckAt = null) {
    const toSql = (v) => v ? v.replace('T',' ').replace('Z','') : v;
    return this.db.prepare(`
      UPDATE viral_monitors SET
        current_shares = ?,
        status = ?,
        last_checked_at = ?,
        triggered_at = COALESCE(?, triggered_at),
        next_check_at = COALESCE(?, next_check_at)
      WHERE id = ?
    `).run(currentShares, status, this._toSqliteDate(new Date()), toSql(triggeredAt), toSql(nextCheckAt), id);
  }

  /**
   * Reset next_check_at to NOW for all active monitors so they get rechecked
   * immediately on monitoring resume.
   * @param {number|null} daysAgo - If set, only reset monitors created within this many days.
   *                                 null = reset all active monitors.
   * @returns {number} number of rows updated
   */
  resetMonitorCheckTimes(daysAgo = null) {
    const now = this._toSqliteDate(new Date());
    if (daysAgo !== null && daysAgo > 0) {
      const cutoff = this._toSqliteDate(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000));
      return this.db.prepare(`
        UPDATE viral_monitors SET next_check_at = ?
        WHERE status = 'monitoring'
          AND datetime(replace(replace(substr(created_at,1,19),'T',' '),'Z','')) >= datetime(?)
      `).run(now, cutoff).changes;
    }
    return this.db.prepare(`
      UPDATE viral_monitors SET next_check_at = ?
      WHERE status = 'monitoring'
    `).run(now).changes;
  }

  /**
   * Mark any 'monitoring' viral monitors whose expires_at (the "stop monitoring
   * after (hours)" window) has passed as 'expired'. Runs independently of the
   * global viral-monitoring pause flag so expired posts are removed from the
   * monitoring view instantly even while monitoring is paused.
   * Uses substr to strip ms so datetime() works with both ISO and space formats.
   * @returns {number} number of monitors expired by this call
   */
  expireOverdueViralMonitors() {
    try {
      return this.db.prepare(
        `UPDATE viral_monitors SET status='expired'
         WHERE status='monitoring' AND expires_at IS NOT NULL
           AND datetime(replace(replace(substr(expires_at,1,19),'T',' '),'Z','')) < datetime('now')`
      ).run().changes;
    } catch (e) {
      // Never let an expiry failure break callers (e.g. the posts feed).
      console.error('[FBGroupsDB] expireOverdueViralMonitors failed:', e.message);
      return 0;
    }
  }

  /**
   * Recompute expires_at = created_at + expiryHours for all currently-monitoring
   * monitors so a change to the global "Stop monitoring after (hours)" setting
   * applies retroactively (the stored expires_at is otherwise frozen at creation
   * time). Then immediately expire any monitor that is now overdue.
   * @param {number} expiryHours - new window in hours (must be > 0)
   * @returns {{recomputed:number, expired:number}}
   */
  recomputeViralExpiry(expiryHours) {
    const hours = Number(expiryHours);
    if (!(hours > 0)) return { recomputed: 0, expired: 0 };
    try {
      const recomputed = this.db.prepare(
        `UPDATE viral_monitors
           SET expires_at = strftime('%Y-%m-%d %H:%M:%S',
                 datetime(replace(replace(substr(created_at,1,19),'T',' '),'Z',''),
                          '+' || ? || ' hours'))
         WHERE status = 'monitoring' AND created_at IS NOT NULL`
      ).run(hours).changes;
      const expired = this.expireOverdueViralMonitors();
      return { recomputed, expired };
    } catch (e) {
      console.error('[FBGroupsDB] recomputeViralExpiry failed:', e.message);
      return { recomputed: 0, expired: 0 };
    }
  }

  getActiveViralMonitors() {
    // Expire overdue monitors first (pause-independent).
    this.expireOverdueViralMonitors();
    const rows = this.db.prepare(`
      SELECT vm.*, ap.message AS post_message, ap.image_path AS post_image_path,
             iw.viral_ai_provider    AS ai_provider,
             iw.viral_ai_model       AS ai_model,
             iw.viral_automation_id,
             iw.viral_ai_rewrite     AS ai_rewrite_enabled,
             iw.viral_ai_prompt_text AS ai_prompt_template
      FROM viral_monitors vm
      LEFT JOIN automation_posts ap ON vm.automation_post_id = ap.id
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      WHERE vm.status = 'monitoring'
        AND (vm.next_check_at IS NULL OR datetime(replace(replace(substr(vm.next_check_at,1,19),'T',' '),'Z','')) <= datetime('now'))
      ORDER BY vm.created_at ASC
    `).all();
    return rows.map(r => this._toCamelCase(r));
  }

  /**
   * Distinct groups that have at least one monitor in 'monitoring' status, with
   * the group's earliest due time. Used by the batched scan scheduler to decide
   * which groups need a human-like browsing session this tick. A group is "due"
   * when nullDue > 0 (a never-checked monitor) or nextDue <= now.
   */
  getMonitoringGroups() {
    this.expireOverdueViralMonitors();
    const rows = this.db.prepare(`
      SELECT vm.group_id            AS group_id,
             g.name                 AS group_name,
             g.url                  AS group_url,
             COUNT(*)               AS monitor_count,
             MIN(vm.next_check_at)  AS next_due,
             SUM(CASE WHEN vm.next_check_at IS NULL THEN 1 ELSE 0 END) AS null_due,
             SUM(CASE WHEN vm.next_check_at IS NULL
                        OR datetime(replace(replace(substr(vm.next_check_at,1,19),'T',' '),'Z','')) <= datetime('now')
                      THEN 1 ELSE 0 END) AS due_count
      FROM viral_monitors vm
      LEFT JOIN groups g ON vm.group_id = g.group_id
      WHERE vm.status = 'monitoring'
      GROUP BY vm.group_id
    `).all();
    return rows.map(r => this._toCamelCase(r));
  }

  /**
   * All 'monitoring' monitors for a single group (joined with their post +
   * workflow AI settings, like getActiveViralMonitors). Not filtered by
   * next_check_at — one scan session covers every monitored post in the group.
   */
  getMonitorsForGroup(groupId) {
    const rows = this.db.prepare(`
      SELECT vm.*, ap.message AS post_message, ap.image_path AS post_image_path,
             iw.viral_ai_provider    AS ai_provider,
             iw.viral_ai_model       AS ai_model,
             iw.viral_automation_id,
             iw.viral_ai_rewrite     AS ai_rewrite_enabled,
             iw.viral_ai_prompt_text AS ai_prompt_template
      FROM viral_monitors vm
      LEFT JOIN automation_posts ap ON vm.automation_post_id = ap.id
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      WHERE vm.group_id = ? AND vm.status = 'monitoring'
      ORDER BY vm.created_at ASC
    `).all(groupId);
    return rows.map(r => this._toCamelCase(r));
  }

  getViralMonitorByStoryId(storyId) {
    const row = this.db.prepare(`
      SELECT vm.*, ap.message AS post_message, ap.image_path AS post_image_path,
             iw.viral_ai_provider    AS ai_provider,
             iw.viral_ai_model       AS ai_model,
             iw.viral_automation_id,
             iw.viral_ai_rewrite     AS ai_rewrite_enabled,
             iw.viral_ai_prompt_text AS ai_prompt_template
      FROM viral_monitors vm
      LEFT JOIN automation_posts ap ON vm.automation_post_id = ap.id
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      WHERE vm.story_id = ? AND vm.status = 'monitoring'
      ORDER BY vm.created_at DESC LIMIT 1
    `).get(storyId);
    return row ? this._toCamelCase(row) : null;
  }

  /**
   * Like getViralMonitorByStoryId but for an 'expired' monitor — used by the
   * Expired Posts page "Check stats" button to refresh share/comment counts
   * without resuming monitoring or running the viral action.
   */
  getExpiredViralMonitorByStoryId(storyId) {
    const row = this.db.prepare(`
      SELECT vm.*, ap.message AS post_message, ap.image_path AS post_image_path
      FROM viral_monitors vm
      LEFT JOIN automation_posts ap ON vm.automation_post_id = ap.id
      WHERE vm.story_id = ? AND vm.status = 'expired'
      ORDER BY vm.created_at DESC LIMIT 1
    `).get(storyId);
    return row ? this._toCamelCase(row) : null;
  }

  /**
   * Like getViralMonitorByStoryId but matches ANY status — used by the
   * "Check stats" button so it works on monitoring (even paused), triggered and
   * expired posts alike, refreshing counts without running the viral action.
   */
  getAnyViralMonitorByStoryId(storyId) {
    const row = this.db.prepare(`
      SELECT vm.*, ap.message AS post_message, ap.image_path AS post_image_path
      FROM viral_monitors vm
      LEFT JOIN automation_posts ap ON vm.automation_post_id = ap.id
      WHERE vm.story_id = ?
      ORDER BY vm.created_at DESC LIMIT 1
    `).get(storyId);
    return row ? this._toCamelCase(row) : null;
  }

  /**
   * Update only the current metric count + last_checked_at on a monitor, leaving
   * its status untouched. Used for a stats-only refresh on expired posts.
   */
  updateViralMonitorCount(id, currentShares) {
    return this.db.prepare(`
      UPDATE viral_monitors
         SET current_shares = ?, last_checked_at = ?
       WHERE id = ?
    `).run(currentShares, this._toSqliteDate(new Date()), id);
  }

  getViralMonitorHistory(limit = 20) {
    const rows = this.db.prepare(`
      SELECT vm.*, g.name AS group_name, iw.name AS workflow_name
      FROM viral_monitors vm
      LEFT JOIN groups g ON vm.group_id = g.group_id
      LEFT JOIN automation_posts ap ON vm.automation_post_id = ap.id
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      WHERE vm.status IN ('triggered','done','failed')
      ORDER BY vm.triggered_at DESC
      LIMIT ?
    `).all(limit);
    return rows.map(r => this._toCamelCase(r));
  }

  // ============================================================
  //  DASHBOARD STATS
  // ============================================================

  getDashboardStats() {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM imported_workflows WHERE status='active')                           AS active_workflows,
        (SELECT COUNT(*) FROM imported_workflows)                                                 AS total_workflows,
        (SELECT COUNT(*) FROM automation_posts WHERE status='sent' AND posted_at LIKE ?)          AS posts_today,
        (SELECT COUNT(*) FROM automation_posts WHERE status='sent' AND posted_at >= ?)            AS posts_week,
        (SELECT COUNT(*) FROM automation_posts WHERE status='sent')                               AS posts_total,
        (SELECT COUNT(*) FROM automation_posts WHERE status='failed')                             AS posts_failed,
        (SELECT COUNT(*) FROM viral_monitors WHERE status='monitoring')                           AS monitoring_count,
        (SELECT COUNT(*) FROM viral_monitors WHERE status='triggered')                            AS triggered_count,
        (SELECT COUNT(*) FROM groups)                                                             AS total_groups,
        (SELECT COUNT(*) FROM group_profiles)                                                     AS total_profiles
    `).get(`${today}%`, weekAgo);

    const result = this._toCamelCase(row);
    const total = (result.postsTotal || 0) + (result.postsFailed || 0);
    result.successRate = total > 0 ? Math.round((result.postsTotal / total) * 100) : 0;
    return result;
  }

  getAnalyticsData(daysAgo = 7) {
    const since = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const postsByDay = this.db.prepare(`
      SELECT substr(posted_at,1,10) AS day,
             COUNT(*) AS total,
             SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM automation_posts
      WHERE scheduled_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(since);

    const topGroups = this.db.prepare(`
      SELECT ap.group_id, g.name AS group_name,
             COUNT(*) AS total_posts,
             SUM(CASE WHEN ap.status='sent' THEN 1 ELSE 0 END) AS sent_posts
      FROM automation_posts ap
      LEFT JOIN groups g ON ap.group_id = g.group_id
      WHERE ap.scheduled_at >= ?
      GROUP BY ap.group_id
      ORDER BY sent_posts DESC
      LIMIT 10
    `).all(since);

    const topWorkflows = this.db.prepare(`
      SELECT ap.workflow_id, iw.name AS workflow_name,
             COUNT(*) AS total_posts,
             SUM(CASE WHEN ap.status='sent' THEN 1 ELSE 0 END) AS sent_posts
      FROM automation_posts ap
      LEFT JOIN imported_workflows iw ON ap.workflow_id = iw.workflow_id
      WHERE ap.scheduled_at >= ?
      GROUP BY ap.workflow_id
      ORDER BY sent_posts DESC
      LIMIT 10
    `).all(since);

    const viralStats = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status='triggered' THEN 1 ELSE 0 END) AS triggered,
             AVG(CASE WHEN status='triggered' THEN current_shares ELSE NULL END) AS avg_shares_at_trigger
      FROM viral_monitors
      WHERE created_at >= ?
    `).get(since);

    return {
      postsByDay: postsByDay.map(r => this._toCamelCase(r)),
      topGroups:  topGroups.map(r => this._toCamelCase(r)),
      topWorkflows: topWorkflows.map(r => this._toCamelCase(r)),
      viralStats: this._toCamelCase(viralStats),
    };
  }
}

module.exports = new FacebookGroupsDatabase();
