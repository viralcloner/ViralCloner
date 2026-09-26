/**
 * Pinterest Analytics Database Module
 * Separate SQLite database for storing Pinterest account analytics data
 * collected daily via headless browser sessions.
 *
 * Tables:
 * - daily_metrics: Per-day metric values (IMPRESSION, ENGAGEMENT, PIN_CLICK, OUTBOUND_CLICK, SAVE)
 * - summary_metrics: Aggregated period totals (e.g. last 90 days)
 * - top_pins: Top performing pins per metric type
 * - fetch_log: Audit trail of fetch attempts per account
 */

const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");

let instance = null;

class PinterestAnalyticsDatabase {
  constructor() {
    const dbPath = path.join(app.getPath("userData"), "pinterest.db");
    this.db = new Database(dbPath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.initSchema();
    this.prepareStatements();
    console.log("✓ Pinterest analytics database initialized:", dbPath);
  }

  initSchema() {
    this.db.exec(`
      -- ============================================
      -- DAILY METRICS TABLE
      -- One row per account + date + metric type
      -- ============================================
      CREATE TABLE IF NOT EXISTS daily_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        date TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value INTEGER DEFAULT 0,
        data_status TEXT,
        fetched_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_metrics_unique
        ON daily_metrics(account_id, date, metric_type);
      CREATE INDEX IF NOT EXISTS idx_daily_metrics_account
        ON daily_metrics(account_id);
      CREATE INDEX IF NOT EXISTS idx_daily_metrics_date
        ON daily_metrics(date);

      -- ============================================
      -- SUMMARY METRICS TABLE
      -- Aggregated period totals (e.g. "last90d")
      -- ============================================
      CREATE TABLE IF NOT EXISTS summary_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        period TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_metrics_unique
        ON summary_metrics(account_id, period, metric_type);

      -- ============================================
      -- TOP PINS TABLE
      -- Top performing pins per metric type per fetch
      -- ============================================
      CREATE TABLE IF NOT EXISTS top_pins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        fetch_date TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        pin_id TEXT NOT NULL,
        title TEXT,
        description TEXT,
        image_url TEXT,
        link TEXT,
        pin_created_at TEXT,
        metric_value INTEGER DEFAULT 0,
        pin_format TEXT,
        is_in_profile INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_top_pins_unique
        ON top_pins(account_id, fetch_date, metric_type, pin_id);
      CREATE INDEX IF NOT EXISTS idx_top_pins_account
        ON top_pins(account_id);
      CREATE INDEX IF NOT EXISTS idx_top_pins_date
        ON top_pins(fetch_date);

      -- ============================================
      -- FETCH LOG TABLE
      -- Audit trail of collection attempts
      -- ============================================
      CREATE TABLE IF NOT EXISTS fetch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        fetch_type TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        metrics_saved INTEGER DEFAULT 0,
        pins_saved INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fetch_log_account
        ON fetch_log(account_id);
      CREATE INDEX IF NOT EXISTS idx_fetch_log_date
        ON fetch_log(fetched_at);
    `);
  }

  prepareStatements() {
    this._upsertDailyMetric = this.db.prepare(`
      INSERT INTO daily_metrics (account_id, date, metric_type, value, data_status, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, date, metric_type)
      DO UPDATE SET value = excluded.value, data_status = excluded.data_status, fetched_at = excluded.fetched_at
    `);

    this._upsertSummaryMetric = this.db.prepare(`
      INSERT INTO summary_metrics (account_id, period, metric_type, value, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, period, metric_type)
      DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at
    `);

    this._upsertTopPin = this.db.prepare(`
      INSERT INTO top_pins (account_id, fetch_date, metric_type, pin_id, title, description, image_url, link, pin_created_at, metric_value, pin_format, is_in_profile, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, fetch_date, metric_type, pin_id)
      DO UPDATE SET title = excluded.title, description = excluded.description, image_url = excluded.image_url,
        link = excluded.link, metric_value = excluded.metric_value, pin_format = excluded.pin_format,
        is_in_profile = excluded.is_in_profile, fetched_at = excluded.fetched_at
    `);

    this._insertFetchLog = this.db.prepare(`
      INSERT INTO fetch_log (account_id, fetch_type, status, error_message, metrics_saved, pins_saved, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  // ============================================
  // WRITE METHODS
  // ============================================

  upsertDailyMetric(accountId, date, metricType, value, dataStatus) {
    const now = new Date().toISOString();
    return this._upsertDailyMetric.run(accountId, date, metricType, value, dataStatus, now);
  }

  upsertDailyMetricsBatch(accountId, metricType, dailyMetrics) {
    const now = new Date().toISOString();
    const tx = this.db.transaction((metrics) => {
      let count = 0;
      for (const m of metrics) {
        if (m.data_status === "READY" || m.data_status === "ESTIMATE") {
          const val = (m.metrics && m.metrics[metricType]) || 0;
          this._upsertDailyMetric.run(accountId, m.date, metricType, val, m.data_status, now);
          count++;
        }
      }
      return count;
    });
    return tx(dailyMetrics);
  }

  upsertSummaryMetric(accountId, period, metricType, value) {
    const now = new Date().toISOString();
    return this._upsertSummaryMetric.run(accountId, period, metricType, value, now);
  }

  upsertTopPin(accountId, fetchDate, metricType, pinData) {
    const now = new Date().toISOString();
    const imageUrl = pinData.pin?.images?.["736x"]?.url || pinData.pin?.images?.["474x"]?.url || "";
    const pinFormats = pinData.metadata?.pin_format_list || [];
    const inProfileList = pinData.metadata?.in_profile_list || [];
    return this._upsertTopPin.run(
      accountId,
      fetchDate,
      metricType,
      pinData.pin?.id || "",
      pinData.pin?.grid_title || pinData.pin?.title || "",
      (pinData.pin?.description || "").substring(0, 1000),
      imageUrl,
      pinData.pin?.link || "",
      pinData.pin?.created_at || "",
      (pinData.metrics && pinData.metrics[metricType]) || 0,
      pinFormats.join(","),
      inProfileList.includes(true) ? 1 : 0,
      now
    );
  }

  upsertTopPinsBatch(accountId, fetchDate, metricType, pins) {
    const tx = this.db.transaction((pinList) => {
      let count = 0;
      for (const pinData of pinList) {
        this.upsertTopPin(accountId, fetchDate, metricType, pinData);
        count++;
      }
      return count;
    });
    return tx(pins);
  }

  logFetch(accountId, fetchType, status, errorMessage = null, metricsSaved = 0, pinsSaved = 0) {
    const now = new Date().toISOString();
    return this._insertFetchLog.run(accountId, fetchType, status, errorMessage, metricsSaved, pinsSaved, now);
  }

  // ============================================
  // READ METHODS
  // ============================================

  getDailyMetrics(accountId, metricType, startDate, endDate) {
    return this.db.prepare(`
      SELECT date, metric_type, value, data_status, fetched_at
      FROM daily_metrics
      WHERE account_id = ? AND metric_type = ? AND date >= ? AND date <= ?
      ORDER BY date ASC
    `).all(accountId, metricType, startDate, endDate);
  }

  getAllDailyMetrics(accountId, startDate, endDate) {
    return this.db.prepare(`
      SELECT date, metric_type, value, data_status, fetched_at
      FROM daily_metrics
      WHERE account_id = ? AND date >= ? AND date <= ?
      ORDER BY date ASC, metric_type ASC
    `).all(accountId, startDate, endDate);
  }

  getSummaryMetrics(accountId, period) {
    return this.db.prepare(`
      SELECT metric_type, value, fetched_at
      FROM summary_metrics
      WHERE account_id = ? AND period = ?
    `).all(accountId, period);
  }

  getAllSummaryMetrics() {
    return this.db.prepare(`
      SELECT account_id, period, metric_type, value, fetched_at
      FROM summary_metrics
      ORDER BY account_id, period, metric_type
    `).all();
  }

  getTopPins(accountId, metricType, fetchDate) {
    return this.db.prepare(`
      SELECT pin_id, title, description, image_url, link, pin_created_at,
             metric_value, pin_format, is_in_profile, fetched_at
      FROM top_pins
      WHERE account_id = ? AND metric_type = ? AND fetch_date = ?
      ORDER BY metric_value DESC
    `).all(accountId, metricType, fetchDate);
  }

  getLatestTopPins(accountId, metricType, limit = 50) {
    return this.db.prepare(`
      SELECT pin_id, title, description, image_url, link, pin_created_at,
             metric_value, pin_format, is_in_profile, fetch_date, fetched_at
      FROM top_pins
      WHERE account_id = ? AND metric_type = ?
        AND fetch_date = (SELECT MAX(fetch_date) FROM top_pins WHERE account_id = ? AND metric_type = ?)
      ORDER BY metric_value DESC
      LIMIT ?
    `).all(accountId, metricType, accountId, metricType, limit);
  }

  getFetchLog(accountId, limit = 50) {
    return this.db.prepare(`
      SELECT fetch_type, status, error_message, metrics_saved, pins_saved, fetched_at
      FROM fetch_log
      WHERE account_id = ?
      ORDER BY fetched_at DESC
      LIMIT ?
    `).all(accountId, limit);
  }

  getLatestFetchLog(accountId) {
    return this.db.prepare(`
      SELECT fetch_type, status, error_message, metrics_saved, pins_saved, fetched_at
      FROM fetch_log
      WHERE account_id = ?
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get(accountId);
  }

  getLastSuccessfulFetch(accountId) {
    return this.db.prepare(`
      SELECT fetched_at
      FROM fetch_log
      WHERE account_id = ? AND fetch_type = 'all' AND status = 'success'
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get(accountId);
  }

  getLatestFetchTime() {
    const row = this.db.prepare(`
      SELECT fetched_at
      FROM fetch_log
      WHERE fetch_type = 'all' AND status = 'success'
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get();
    return row ? row.fetched_at : null;
  }

  // ============================================
  // MAINTENANCE
  // ============================================

  pruneOldData(daysToKeep = 365) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const logCutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

    const dailyDeleted = this.db.prepare("DELETE FROM daily_metrics WHERE date < ?").run(cutoff).changes;
    const pinsDeleted = this.db.prepare("DELETE FROM top_pins WHERE fetch_date < ?").run(cutoff).changes;
    const logDeleted = this.db.prepare("DELETE FROM fetch_log WHERE fetched_at < ?").run(logCutoff).changes;

    const totalDeleted = dailyDeleted + pinsDeleted + logDeleted;
    if (totalDeleted > 0) {
      console.log(`[PinterestAnalytics] Pruned: ${dailyDeleted} daily_metrics, ${pinsDeleted} top_pins, ${logDeleted} fetch_log`);
    }
    return { totalDeleted, dailyDeleted, pinsDeleted, logDeleted };
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function getPinterestAnalyticsDatabase() {
  if (!instance) {
    instance = new PinterestAnalyticsDatabase();
  }
  return instance;
}

module.exports = {
  PinterestAnalyticsDatabase,
  getPinterestAnalyticsDatabase,
};
