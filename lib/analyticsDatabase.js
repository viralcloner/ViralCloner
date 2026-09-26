/**
 * Analytics Database Module
 * Separate SQLite database for persistent analytics that survive workflow deletion
 * 
 * Tables:
 * - archived_workflows: Complete workflow data copied before deletion
 * - archived_posts: Post summaries with platform info
 * - daily_snapshots: Aggregated daily statistics for performance
 * - error_categories: Categorized error patterns
 * - cost_tracking: Per-workflow/automation cost records
 */

const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");

// Error category patterns for automatic classification
const ERROR_PATTERNS = [
  { category: 'timeout', patterns: ['timeout', 'timed out', 'ETIMEDOUT', 'deadline exceeded'] },
  { category: 'rate_limit', patterns: ['rate limit', 'too many requests', '429', 'throttled', 'quota exceeded'] },
  { category: 'auth', patterns: ['authentication', 'unauthorized', '401', '403', 'forbidden', 'invalid token', 'expired token', 'login required'] },
  { category: 'network', patterns: ['network', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'socket hang up', 'connection refused'] },
  { category: 'api_error', patterns: ['api error', 'internal server error', '500', '502', '503', '504', 'service unavailable'] },
  { category: 'invalid_input', patterns: ['invalid', 'validation', 'malformed', 'missing required', 'bad request', '400'] },
  { category: 'content_policy', patterns: ['content policy', 'safety', 'moderation', 'inappropriate', 'blocked'] },
  { category: 'resource', patterns: ['out of memory', 'disk full', 'no space', 'resource exhausted'] },
];

class AnalyticsDatabase {
  constructor() {
    const dbPath = path.join(app.getPath("userData"), "analytics.db");
    this.db = new Database(dbPath);

    // Enable WAL mode for better performance
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.initSchema();
    console.log("✓ Analytics database initialized:", dbPath);
  }

  initSchema() {
    this.db.exec(`
      -- ============================================
      -- ARCHIVED WORKFLOWS TABLE
      -- Complete workflow data preserved after deletion
      -- ============================================
      CREATE TABLE IF NOT EXISTS archived_workflows (
        archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        name TEXT,
        automation_id TEXT,
        automation_name TEXT,
        status TEXT,
        progress INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        archived_at TEXT NOT NULL,
        post_count INTEGER DEFAULT 0,
        posts_completed INTEGER DEFAULT 0,
        posts_failed INTEGER DEFAULT 0,
        node_execution_count INTEGER DEFAULT 0,
        nodes_completed INTEGER DEFAULT 0,
        nodes_failed INTEGER DEFAULT 0,
        total_duration_ms INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        pinterest_outputs INTEGER DEFAULT 0,
        facebook_outputs INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_archived_workflows_id ON archived_workflows(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_archived_workflows_automation ON archived_workflows(automation_id);
      CREATE INDEX IF NOT EXISTS idx_archived_workflows_created ON archived_workflows(created_at);
      CREATE INDEX IF NOT EXISTS idx_archived_workflows_archived ON archived_workflows(archived_at);
      CREATE INDEX IF NOT EXISTS idx_archived_workflows_status ON archived_workflows(status);

      -- ============================================
      -- ARCHIVED POSTS TABLE
      -- Post summaries with platform performance
      -- ============================================
      CREATE TABLE IF NOT EXISTS archived_posts (
        archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        automation_id TEXT,
        platform TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        archived_at TEXT NOT NULL,
        duration_ms INTEGER DEFAULT 0,
        node_count INTEGER DEFAULT 0,
        nodes_failed INTEGER DEFAULT 0,
        has_pinterest_output INTEGER DEFAULT 0,
        has_facebook_output INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_archived_posts_workflow ON archived_posts(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_archived_posts_automation ON archived_posts(automation_id);
      CREATE INDEX IF NOT EXISTS idx_archived_posts_platform ON archived_posts(platform);
      CREATE INDEX IF NOT EXISTS idx_archived_posts_created ON archived_posts(created_at);
      CREATE INDEX IF NOT EXISTS idx_archived_posts_status ON archived_posts(status);

      -- ============================================
      -- DAILY SNAPSHOTS TABLE
      -- Aggregated daily statistics for fast querying
      -- ============================================
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        hour INTEGER,
        automation_id TEXT,
        automation_name TEXT,
        workflows_started INTEGER DEFAULT 0,
        workflows_completed INTEGER DEFAULT 0,
        workflows_failed INTEGER DEFAULT 0,
        posts_started INTEGER DEFAULT 0,
        posts_completed INTEGER DEFAULT 0,
        posts_failed INTEGER DEFAULT 0,
        nodes_executed INTEGER DEFAULT 0,
        nodes_completed INTEGER DEFAULT 0,
        nodes_failed INTEGER DEFAULT 0,
        total_duration_ms INTEGER DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        pinterest_outputs INTEGER DEFAULT 0,
        facebook_outputs INTEGER DEFAULT 0,
        error_timeout INTEGER DEFAULT 0,
        error_rate_limit INTEGER DEFAULT 0,
        error_auth INTEGER DEFAULT 0,
        error_network INTEGER DEFAULT 0,
        error_api INTEGER DEFAULT 0,
        error_input INTEGER DEFAULT 0,
        error_policy INTEGER DEFAULT 0,
        error_other INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_date_hour_auto ON daily_snapshots(date, hour, automation_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON daily_snapshots(date);
      CREATE INDEX IF NOT EXISTS idx_snapshots_automation ON daily_snapshots(automation_id);

      -- ============================================
      -- ERROR CATEGORIES TABLE
      -- Track error patterns and frequencies
      -- ============================================
      CREATE TABLE IF NOT EXISTS error_records (
        error_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT,
        post_id TEXT,
        node_id TEXT,
        node_type TEXT,
        category TEXT NOT NULL,
        message TEXT,
        stack_trace TEXT,
        automation_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_errors_category ON error_records(category);
      CREATE INDEX IF NOT EXISTS idx_errors_node_type ON error_records(node_type);
      CREATE INDEX IF NOT EXISTS idx_errors_automation ON error_records(automation_id);
      CREATE INDEX IF NOT EXISTS idx_errors_created ON error_records(created_at);

      -- ============================================
      -- COST TRACKING TABLE
      -- Per-workflow/automation cost records from server
      -- ============================================
      CREATE TABLE IF NOT EXISTS cost_tracking (
        cost_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT,
        automation_id TEXT,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        request_type TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cost_workflow ON cost_tracking(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_cost_automation ON cost_tracking(automation_id);
      CREATE INDEX IF NOT EXISTS idx_cost_provider ON cost_tracking(provider);
      CREATE INDEX IF NOT EXISTS idx_cost_created ON cost_tracking(created_at);

      -- ============================================
      -- LIFETIME STATS TABLE
      -- Cumulative all-time statistics
      -- ============================================
      CREATE TABLE IF NOT EXISTS lifetime_stats (
        stat_key TEXT PRIMARY KEY,
        stat_value REAL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- ============================================
      -- NODE TYPE STATS TABLE
      -- Aggregated per-node-type statistics
      -- ============================================
      CREATE TABLE IF NOT EXISTS node_type_stats (
        node_type TEXT PRIMARY KEY,
        total_executions INTEGER DEFAULT 0,
        successful INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        total_duration_ms INTEGER DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        last_execution_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_node_stats_updated ON node_type_stats(updated_at);

      -- ============================================
      -- PEAK USAGE TABLE
      -- Hourly usage patterns
      -- ============================================
      CREATE TABLE IF NOT EXISTS peak_usage (
        peak_id INTEGER PRIMARY KEY AUTOINCREMENT,
        day_of_week INTEGER NOT NULL,
        hour INTEGER NOT NULL,
        executions INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(day_of_week, hour)
      );

      -- Initialize lifetime stats if empty
      INSERT OR IGNORE INTO lifetime_stats (stat_key, stat_value, updated_at) VALUES
        ('total_workflows', 0, datetime('now')),
        ('total_posts', 0, datetime('now')),
        ('total_nodes', 0, datetime('now')),
        ('total_cost_usd', 0, datetime('now')),
        ('total_pinterest_outputs', 0, datetime('now')),
        ('total_facebook_outputs', 0, datetime('now')),
        ('total_duration_ms', 0, datetime('now')),
        ('first_workflow_at', '', datetime('now'));
    `);
  }

  // ============================================
  // ARCHIVAL OPERATIONS
  // ============================================

  /**
   * Archive a workflow before deletion
   * Copies workflow, posts, and aggregates node execution stats
   * @param {object} workflowDb - Reference to main WorkflowDatabase instance
   * @param {string} workflowId - Workflow ID to archive
   * @param {string} automationName - Optional automation name for display
   */
  archiveWorkflow(workflowDb, workflowId, automationName = null) {
    try {
      // Get workflow data
      const workflow = workflowDb.getWorkflow(workflowId);
      if (!workflow) {
        console.warn(`[AnalyticsDB] Workflow ${workflowId} not found for archiving`);
        return false;
      }

      const now = new Date().toISOString();

      // Get posts for this workflow
      const posts = workflowDb.getWorkflowPosts(workflowId);
      
      // Get node execution stats
      const nodeStats = workflowDb.db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN completed_at IS NOT NULL 
            THEN (julianday(completed_at) - julianday(created_at)) * 86400000 
            ELSE 0 END) as total_duration
        FROM node_executions
        WHERE workflow_id = ?
      `).get(workflowId);

      // Count platform outputs
      const outputCounts = workflowDb.db.prepare(`
        SELECT 
          SUM(CASE WHEN platform = 'pinterest' THEN 1 ELSE 0 END) as pinterest,
          SUM(CASE WHEN platform = 'facebook' THEN 1 ELSE 0 END) as facebook
        FROM post_outputs po
        JOIN posts p ON po.post_id = p.post_id
        WHERE p.workflow_id = ?
      `).get(workflowId);

      // Count post statuses
      const postCounts = posts.reduce((acc, p) => {
        acc.total++;
        if (p.status === 'completed') acc.completed++;
        if (p.status === 'failed') acc.failed++;
        return acc;
      }, { total: 0, completed: 0, failed: 0 });

      // Calculate completion time
      let completedAt = null;
      if (workflow.status === 'completed' || workflow.status === 'failed') {
        completedAt = workflow.updatedAt || now;
      }

      // Get cost for this workflow from cost_tracking
      const costData = this.db.prepare(`
        SELECT SUM(cost_usd) as total_cost
        FROM cost_tracking
        WHERE workflow_id = ?
      `).get(workflowId);

      // Archive the workflow
      this.db.prepare(`
        INSERT INTO archived_workflows (
          workflow_id, name, automation_id, automation_name, status, progress,
          created_at, completed_at, archived_at,
          post_count, posts_completed, posts_failed,
          node_execution_count, nodes_completed, nodes_failed,
          total_duration_ms, total_cost_usd,
          pinterest_outputs, facebook_outputs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workflowId,
        workflow.name,
        workflow.automationId,
        automationName,
        workflow.status,
        workflow.progress || 0,
        workflow.createdAt || now,
        completedAt,
        now,
        postCounts.total,
        postCounts.completed,
        postCounts.failed,
        nodeStats?.total || 0,
        nodeStats?.completed || 0,
        nodeStats?.failed || 0,
        Math.round(nodeStats?.total_duration || 0),
        costData?.total_cost || 0,
        outputCounts?.pinterest || 0,
        outputCounts?.facebook || 0
      );

      // Archive each post
      const archivePostStmt = this.db.prepare(`
        INSERT INTO archived_posts (
          post_id, workflow_id, automation_id, platform, status,
          created_at, completed_at, archived_at,
          duration_ms, node_count, nodes_failed,
          has_pinterest_output, has_facebook_output
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const post of posts) {
        // Get post's node execution stats
        const postNodeStats = workflowDb.db.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN completed_at IS NOT NULL 
              THEN (julianday(completed_at) - julianday(created_at)) * 86400000 
              ELSE 0 END) as duration
          FROM node_executions
          WHERE post_id = ?
        `).get(post.postId);

        // Determine platform from outputs
        let platform = null;
        if (post.pinterestOutput) platform = 'pinterest';
        else if (post.facebookOutput) platform = 'facebook';

        archivePostStmt.run(
          post.postId,
          workflowId,
          workflow.automationId,
          platform,
          post.status,
          post.createdAt || now,
          post.status === 'completed' ? now : null,
          now,
          Math.round(postNodeStats?.duration || 0),
          postNodeStats?.total || 0,
          postNodeStats?.failed || 0,
          post.pinterestOutput ? 1 : 0,
          post.facebookOutput ? 1 : 0
        );
      }

      // Update lifetime stats
      this.updateLifetimeStat('total_workflows', 1, 'increment');
      this.updateLifetimeStat('total_posts', postCounts.total, 'increment');
      this.updateLifetimeStat('total_nodes', nodeStats?.total || 0, 'increment');
      this.updateLifetimeStat('total_cost_usd', costData?.total_cost || 0, 'increment');
      this.updateLifetimeStat('total_pinterest_outputs', outputCounts?.pinterest || 0, 'increment');
      this.updateLifetimeStat('total_facebook_outputs', outputCounts?.facebook || 0, 'increment');
      this.updateLifetimeStat('total_duration_ms', nodeStats?.total_duration || 0, 'increment');

      console.log(`[AnalyticsDB] Archived workflow ${workflowId}: ${postCounts.total} posts, ${nodeStats?.total || 0} nodes`);
      return true;
    } catch (error) {
      console.error(`[AnalyticsDB] Error archiving workflow ${workflowId}:`, error);
      return false;
    }
  }

  /**
   * Update a lifetime statistic
   */
  updateLifetimeStat(key, value, mode = 'set') {
    const now = new Date().toISOString();
    if (mode === 'increment') {
      this.db.prepare(`
        INSERT INTO lifetime_stats (stat_key, stat_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(stat_key) DO UPDATE SET 
          stat_value = stat_value + excluded.stat_value,
          updated_at = excluded.updated_at
      `).run(key, value, now);
    } else {
      this.db.prepare(`
        INSERT INTO lifetime_stats (stat_key, stat_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(stat_key) DO UPDATE SET 
          stat_value = excluded.stat_value,
          updated_at = excluded.updated_at
      `).run(key, value, now);
    }
  }

  /**
   * Get all lifetime stats
   */
  getLifetimeStats() {
    const rows = this.db.prepare(`SELECT stat_key, stat_value FROM lifetime_stats`).all();
    const stats = {};
    for (const row of rows) {
      // Convert snake_case stat_key to camelCase
      const camelKey = row.stat_key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      stats[camelKey] = row.stat_value;
    }
    return stats;
  }

  // ============================================
  // DAILY SNAPSHOT OPERATIONS
  // ============================================

  /**
   * Update or create a daily snapshot for current hour
   * @param {object} data - Snapshot data to add
   */
  updateDailySnapshot(data) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const automationId = data.automationId || '_all';

    const existing = this.db.prepare(`
      SELECT snapshot_id FROM daily_snapshots 
      WHERE date = ? AND hour = ? AND automation_id = ?
    `).get(date, hour, automationId);

    if (existing) {
      this.db.prepare(`
        UPDATE daily_snapshots SET
          workflows_started = workflows_started + ?,
          workflows_completed = workflows_completed + ?,
          workflows_failed = workflows_failed + ?,
          posts_started = posts_started + ?,
          posts_completed = posts_completed + ?,
          posts_failed = posts_failed + ?,
          nodes_executed = nodes_executed + ?,
          nodes_completed = nodes_completed + ?,
          nodes_failed = nodes_failed + ?,
          total_duration_ms = total_duration_ms + ?,
          total_cost_usd = total_cost_usd + ?,
          pinterest_outputs = pinterest_outputs + ?,
          facebook_outputs = facebook_outputs + ?,
          error_timeout = error_timeout + ?,
          error_rate_limit = error_rate_limit + ?,
          error_auth = error_auth + ?,
          error_network = error_network + ?,
          error_api = error_api + ?,
          error_input = error_input + ?,
          error_policy = error_policy + ?,
          error_other = error_other + ?,
          updated_at = ?
        WHERE snapshot_id = ?
      `).run(
        data.workflowsStarted || 0,
        data.workflowsCompleted || 0,
        data.workflowsFailed || 0,
        data.postsStarted || 0,
        data.postsCompleted || 0,
        data.postsFailed || 0,
        data.nodesExecuted || 0,
        data.nodesCompleted || 0,
        data.nodesFailed || 0,
        data.durationMs || 0,
        data.costUsd || 0,
        data.pinterestOutputs || 0,
        data.facebookOutputs || 0,
        data.errorTimeout || 0,
        data.errorRateLimit || 0,
        data.errorAuth || 0,
        data.errorNetwork || 0,
        data.errorApi || 0,
        data.errorInput || 0,
        data.errorPolicy || 0,
        data.errorOther || 0,
        now.toISOString(),
        existing.snapshot_id
      );
    } else {
      this.db.prepare(`
        INSERT INTO daily_snapshots (
          date, hour, automation_id, automation_name,
          workflows_started, workflows_completed, workflows_failed,
          posts_started, posts_completed, posts_failed,
          nodes_executed, nodes_completed, nodes_failed,
          total_duration_ms, total_cost_usd,
          pinterest_outputs, facebook_outputs,
          error_timeout, error_rate_limit, error_auth, error_network,
          error_api, error_input, error_policy, error_other,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        date, hour, automationId, data.automationName || null,
        data.workflowsStarted || 0,
        data.workflowsCompleted || 0,
        data.workflowsFailed || 0,
        data.postsStarted || 0,
        data.postsCompleted || 0,
        data.postsFailed || 0,
        data.nodesExecuted || 0,
        data.nodesCompleted || 0,
        data.nodesFailed || 0,
        data.durationMs || 0,
        data.costUsd || 0,
        data.pinterestOutputs || 0,
        data.facebookOutputs || 0,
        data.errorTimeout || 0,
        data.errorRateLimit || 0,
        data.errorAuth || 0,
        data.errorNetwork || 0,
        data.errorApi || 0,
        data.errorInput || 0,
        data.errorPolicy || 0,
        data.errorOther || 0,
        now.toISOString(),
        now.toISOString()
      );
    }
  }

  /**
   * Get daily snapshots for a time range
   * @param {number} daysAgo - Days to look back
   * @param {string} automationId - Filter by automation (optional)
   */
  getDailySnapshots(daysAgo = 30, automationId = null) {
    const cutoff = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    let query = `
      SELECT 
        date,
        SUM(workflows_started) as workflows_started,
        SUM(workflows_completed) as workflows_completed,
        SUM(workflows_failed) as workflows_failed,
        SUM(posts_started) as posts_started,
        SUM(posts_completed) as posts_completed,
        SUM(posts_failed) as posts_failed,
        SUM(nodes_executed) as nodes_executed,
        SUM(nodes_completed) as nodes_completed,
        SUM(nodes_failed) as nodes_failed,
        SUM(total_duration_ms) as total_duration_ms,
        SUM(total_cost_usd) as total_cost_usd,
        SUM(pinterest_outputs) as pinterest_outputs,
        SUM(facebook_outputs) as facebook_outputs,
        SUM(error_timeout) as error_timeout,
        SUM(error_rate_limit) as error_rate_limit,
        SUM(error_auth) as error_auth,
        SUM(error_network) as error_network,
        SUM(error_api) as error_api,
        SUM(error_input) as error_input,
        SUM(error_policy) as error_policy,
        SUM(error_other) as error_other
      FROM daily_snapshots
      WHERE date >= ?
    `;
    
    const params = [cutoff];
    
    if (automationId) {
      query += ` AND automation_id = ?`;
      params.push(automationId);
    }
    
    query += ` GROUP BY date ORDER BY date ASC`;
    
    return this.db.prepare(query).all(...params);
  }

  // ============================================
  // ERROR TRACKING
  // ============================================

  /**
   * Categorize an error message
   * @param {string} message - Error message
   * @returns {string} Error category
   */
  categorizeError(message) {
    if (!message) return 'other';
    const lowerMessage = message.toLowerCase();
    
    for (const { category, patterns } of ERROR_PATTERNS) {
      for (const pattern of patterns) {
        if (lowerMessage.includes(pattern.toLowerCase())) {
          return category;
        }
      }
    }
    return 'other';
  }

  /**
   * Record an error with categorization
   */
  recordError(data) {
    const category = this.categorizeError(data.message);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO error_records (
        workflow_id, post_id, node_id, node_type, category,
        message, stack_trace, automation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.workflowId,
      data.postId,
      data.nodeId,
      data.nodeType,
      category,
      data.message,
      data.stackTrace,
      data.automationId,
      now
    );

    // Update peak usage
    this.updatePeakUsage();

    // Update daily snapshot with error category
    const errorKey = `error${category.charAt(0).toUpperCase() + category.slice(1)}`;
    this.updateDailySnapshot({
      automationId: data.automationId,
      [errorKey === 'errorOther' ? 'errorOther' : errorKey.replace('_', '')]: 1
    });

    return category;
  }

  /**
   * Get error analytics for a time range
   * @param {number} hoursAgo - Hours to look back
   * @param {string} automationId - Filter by automation (optional)
   */
  getErrorAnalytics(hoursAgo = 24, automationId = null) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    
    let query = `
      SELECT 
        category,
        node_type,
        COUNT(*) as count,
        MAX(created_at) as last_occurrence
      FROM error_records
      WHERE created_at >= ?
    `;
    
    const params = [cutoff];
    
    if (automationId) {
      query += ` AND automation_id = ?`;
      params.push(automationId);
    }
    
    query += ` GROUP BY category, node_type ORDER BY count DESC`;
    
    const byCategory = this.db.prepare(query).all(...params);

    // Get category totals
    let totalQuery = `
      SELECT category, COUNT(*) as count
      FROM error_records
      WHERE created_at >= ?
    `;
    
    const totalParams = [cutoff];
    if (automationId) {
      totalQuery += ` AND automation_id = ?`;
      totalParams.push(automationId);
    }
    totalQuery += ` GROUP BY category ORDER BY count DESC`;
    
    const totals = this.db.prepare(totalQuery).all(...totalParams);

    return {
      byCategory: totals,
      byNodeType: byCategory,
    };
  }

  // ============================================
  // COST TRACKING
  // ============================================

  /**
   * Record a cost entry
   */
  recordCost(data) {
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO cost_tracking (
        workflow_id, automation_id, provider, model,
        input_tokens, output_tokens, total_tokens, cost_usd,
        request_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.workflowId,
      data.automationId,
      data.provider,
      data.model,
      data.inputTokens || 0,
      data.outputTokens || 0,
      data.totalTokens || 0,
      data.costUsd || 0,
      data.requestType,
      now
    );

    // Update daily snapshot
    this.updateDailySnapshot({
      automationId: data.automationId,
      costUsd: data.costUsd || 0
    });

    // Update lifetime stat
    this.updateLifetimeStat('total_cost_usd', data.costUsd || 0, 'increment');
  }

  /**
   * Get cost analytics for a time range
   * @param {number} hoursAgo - Hours to look back
   * @param {string} automationId - Filter by automation (optional)
   */
  getCostAnalytics(hoursAgo = 24, automationId = null) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    
    // By provider
    let providerQuery = `
      SELECT 
        provider,
        SUM(cost_usd) as total_cost,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count
      FROM cost_tracking
      WHERE created_at >= ?
    `;
    const providerParams = [cutoff];
    if (automationId) {
      providerQuery += ` AND automation_id = ?`;
      providerParams.push(automationId);
    }
    providerQuery += ` GROUP BY provider ORDER BY total_cost DESC`;
    
    const byProvider = this.db.prepare(providerQuery).all(...providerParams);

    // By automation
    let autoQuery = `
      SELECT 
        automation_id,
        SUM(cost_usd) as total_cost,
        SUM(total_tokens) as total_tokens,
        COUNT(*) as request_count
      FROM cost_tracking
      WHERE created_at >= ?
    `;
    const autoParams = [cutoff];
    if (automationId) {
      autoQuery += ` AND automation_id = ?`;
      autoParams.push(automationId);
    }
    autoQuery += ` GROUP BY automation_id ORDER BY total_cost DESC`;
    
    const byAutomation = this.db.prepare(autoQuery).all(...autoParams);

    // Time series (hourly for short ranges, daily for longer)
    const groupBy = hoursAgo <= 48 ? 'hour' : 'day';
    let timeQuery;
    if (groupBy === 'hour') {
      timeQuery = `
        SELECT 
          strftime('%Y-%m-%d %H:00', created_at) as time_bucket,
          SUM(cost_usd) as total_cost
        FROM cost_tracking
        WHERE created_at >= ?
      `;
    } else {
      timeQuery = `
        SELECT 
          strftime('%Y-%m-%d', created_at) as time_bucket,
          SUM(cost_usd) as total_cost
        FROM cost_tracking
        WHERE created_at >= ?
      `;
    }
    const timeParams = [cutoff];
    if (automationId) {
      timeQuery += ` AND automation_id = ?`;
      timeParams.push(automationId);
    }
    timeQuery += ` GROUP BY time_bucket ORDER BY time_bucket ASC`;
    
    const timeSeries = this.db.prepare(timeQuery).all(...timeParams);

    // Total
    let totalQuery = `
      SELECT SUM(cost_usd) as total FROM cost_tracking WHERE created_at >= ?
    `;
    const totalParams = [cutoff];
    if (automationId) {
      totalQuery += ` AND automation_id = ?`;
      totalParams.push(automationId);
    }
    const total = this.db.prepare(totalQuery).get(...totalParams);

    return {
      totalCost: total?.total || 0,
      byProvider,
      byAutomation,
      timeSeries,
    };
  }

  // ============================================
  // PEAK USAGE TRACKING
  // ============================================

  /**
   * Update peak usage for current time
   */
  updatePeakUsage() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0-6
    const hour = now.getHours(); // 0-23

    this.db.prepare(`
      INSERT INTO peak_usage (day_of_week, hour, executions, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(day_of_week, hour) DO UPDATE SET 
        executions = executions + 1,
        updated_at = excluded.updated_at
    `).run(dayOfWeek, hour, now.toISOString());
  }

  /**
   * Get peak usage heatmap data
   */
  getPeakUsage() {
    const rows = this.db.prepare(`
      SELECT day_of_week, hour, executions
      FROM peak_usage
      ORDER BY day_of_week, hour
    `).all();

    // Create a 7x24 matrix
    const heatmap = Array(7).fill(null).map(() => Array(24).fill(0));
    
    for (const row of rows) {
      heatmap[row.day_of_week][row.hour] = row.executions;
    }

    return heatmap;
  }

  // ============================================
  // NODE TYPE STATISTICS
  // ============================================

  /**
   * Update node type statistics
   */
  updateNodeTypeStats(nodeType, success, durationMs) {
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO node_type_stats (
        node_type, total_executions, successful, failed, 
        total_duration_ms, last_execution_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(node_type) DO UPDATE SET 
        total_executions = total_executions + 1,
        successful = successful + excluded.successful,
        failed = failed + excluded.failed,
        total_duration_ms = total_duration_ms + excluded.total_duration_ms,
        avg_duration_ms = (total_duration_ms + excluded.total_duration_ms) / (total_executions + 1),
        last_execution_at = excluded.last_execution_at,
        updated_at = excluded.updated_at
    `).run(nodeType, success ? 1 : 0, success ? 0 : 1, durationMs || 0, now, now);
  }

  /**
   * Get node type statistics
   */
  getNodeTypeStats() {
    return this.db.prepare(`
      SELECT 
        node_type,
        total_executions,
        successful,
        failed,
        ROUND(avg_duration_ms, 0) as avg_duration_ms,
        ROUND(100.0 * successful / total_executions, 1) as success_rate,
        last_execution_at
      FROM node_type_stats
      WHERE total_executions > 0
      ORDER BY total_executions DESC
    `).all();
  }

  // ============================================
  // COMPREHENSIVE ANALYTICS QUERIES
  // ============================================

  /**
   * Get comprehensive analytics summary combining live and archived data
   * @param {number} hoursAgo - Hours to look back
   * @param {string} automationId - Filter by automation (optional)
   * @param {object} workflowDb - Reference to main WorkflowDatabase for live data
   */
  getAnalyticsSummary(hoursAgo = 24, automationId = null, workflowDb = null) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

    // Get live data from main database
    let liveWorkflows = { total: 0, completed: 0, failed: 0 };
    let livePosts = { total: 0, completed: 0, failed: 0 };
    let liveNodes = { total: 0, completed: 0, failed: 0, duration: 0 };
    let livePlatforms = { pinterest: 0, facebook: 0 };

    if (workflowDb) {
      // Live workflow stats
      let wfQuery = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM workflows
        WHERE created_at >= ?
      `;
      const wfParams = [cutoff];
      if (automationId) {
        wfQuery = wfQuery.replace('WHERE', 'WHERE automation_id = ? AND');
        wfParams.unshift(automationId);
      }
      const wfStats = workflowDb.db.prepare(wfQuery).get(...wfParams);
      liveWorkflows = {
        total: wfStats?.total || 0,
        completed: wfStats?.completed || 0,
        failed: wfStats?.failed || 0,
      };

      // Live post stats
      let postQuery = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM posts p
        JOIN workflows w ON p.workflow_id = w.workflow_id
        WHERE p.created_at >= ?
      `;
      const postParams = [cutoff];
      if (automationId) {
        postQuery = postQuery.replace('WHERE p.created_at', 'WHERE w.automation_id = ? AND p.created_at');
        postParams.unshift(automationId);
      }
      const postStats = workflowDb.db.prepare(postQuery).get(...postParams);
      livePosts = {
        total: postStats?.total || 0,
        completed: postStats?.completed || 0,
        failed: postStats?.failed || 0,
      };

      // Live node stats - only count nodes from existing workflows to avoid double-counting with archived
      let nodeQuery = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN ne.status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN ne.completed_at IS NOT NULL 
            THEN (julianday(ne.completed_at) - julianday(ne.created_at)) * 86400000 
            ELSE 0 END) as duration
        FROM node_executions ne
        JOIN workflows w ON ne.workflow_id = w.workflow_id
        WHERE ne.created_at >= ?
      `;
      const nodeParams = [cutoff];
      if (automationId) {
        nodeQuery = `
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN ne.status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN ne.completed_at IS NOT NULL 
              THEN (julianday(ne.completed_at) - julianday(ne.created_at)) * 86400000 
              ELSE 0 END) as duration
          FROM node_executions ne
          JOIN workflows w ON ne.workflow_id = w.workflow_id
          WHERE w.automation_id = ? AND ne.created_at >= ?
        `;
        nodeParams.unshift(automationId);
      }
      const nodeStats = workflowDb.db.prepare(nodeQuery).get(...nodeParams);
      liveNodes = {
        total: nodeStats?.total || 0,
        completed: nodeStats?.completed || 0,
        failed: nodeStats?.failed || 0,
        duration: nodeStats?.duration || 0,
      };
      
      // Live platform outputs
      let platformQuery = `
        SELECT 
          SUM(CASE WHEN po.platform = 'pinterest' THEN 1 ELSE 0 END) as pinterest,
          SUM(CASE WHEN po.platform = 'facebook' THEN 1 ELSE 0 END) as facebook
        FROM post_outputs po
        JOIN posts p ON po.post_id = p.post_id
        WHERE po.created_at >= ?
      `;
      const platformParams = [cutoff];
      if (automationId) {
        platformQuery = `
          SELECT 
            SUM(CASE WHEN po.platform = 'pinterest' THEN 1 ELSE 0 END) as pinterest,
            SUM(CASE WHEN po.platform = 'facebook' THEN 1 ELSE 0 END) as facebook
          FROM post_outputs po
          JOIN posts p ON po.post_id = p.post_id
          JOIN workflows w ON p.workflow_id = w.workflow_id
          WHERE w.automation_id = ? AND po.created_at >= ?
        `;
        platformParams.unshift(automationId);
      }
      const platformResults = workflowDb.db.prepare(platformQuery).get(...platformParams);
      livePlatforms = {
        pinterest: platformResults?.pinterest || 0,
        facebook: platformResults?.facebook || 0,
      };
    }

    // Get archived data
    let archivedQuery = `
      SELECT 
        COUNT(*) as total_workflows,
        SUM(posts_completed + posts_failed) as total_posts,
        SUM(posts_completed) as completed_posts,
        SUM(posts_failed) as failed_posts,
        SUM(nodes_completed + nodes_failed) as total_nodes,
        SUM(nodes_completed) as completed_nodes,
        SUM(nodes_failed) as failed_nodes,
        SUM(total_duration_ms) as total_duration,
        SUM(total_cost_usd) as total_cost,
        SUM(pinterest_outputs) as pinterest_outputs,
        SUM(facebook_outputs) as facebook_outputs
      FROM archived_workflows
      WHERE created_at >= ?
    `;
    const archivedParams = [cutoff];
    if (automationId) {
      archivedQuery = archivedQuery.replace('WHERE', 'WHERE automation_id = ? AND');
      archivedParams.unshift(automationId);
    }
    const archived = this.db.prepare(archivedQuery).get(...archivedParams);

    // Combine live and archived
    const totalWorkflows = liveWorkflows.total + (archived?.total_workflows || 0);
    const completedWorkflows = liveWorkflows.completed;
    const failedWorkflows = liveWorkflows.failed;
    
    const totalPosts = livePosts.total + (archived?.total_posts || 0);
    const completedPosts = livePosts.completed + (archived?.completed_posts || 0);
    const failedPosts = livePosts.failed + (archived?.failed_posts || 0);
    
    const totalNodes = liveNodes.total + (archived?.total_nodes || 0);
    const completedNodes = liveNodes.completed + (archived?.completed_nodes || 0);
    const failedNodes = liveNodes.failed + (archived?.failed_nodes || 0);
    const totalDuration = liveNodes.duration + (archived?.total_duration || 0);

    // Calculate success rates
    const workflowSuccessRate = totalWorkflows > 0 
      ? Math.round(100 * completedWorkflows / totalWorkflows * 10) / 10 
      : 0;
    const postSuccessRate = totalPosts > 0 
      ? Math.round(100 * completedPosts / totalPosts * 10) / 10 
      : 0;
    const nodeSuccessRate = totalNodes > 0 
      ? Math.round(100 * completedNodes / totalNodes * 10) / 10 
      : 0;
    const avgDuration = totalNodes > 0 ? Math.round(totalDuration / completedNodes) : 0;

    // Get cost from cost_tracking
    let costQuery = `
      SELECT SUM(cost_usd) as total FROM cost_tracking WHERE created_at >= ?
    `;
    const costParams = [cutoff];
    if (automationId) {
      costQuery += ` AND automation_id = ?`;
      costParams.push(automationId);
    }
    const costData = this.db.prepare(costQuery).get(...costParams);

    return {
      timeRange: hoursAgo,
      workflows: {
        total: totalWorkflows,
        completed: completedWorkflows,
        failed: failedWorkflows,
        active: liveWorkflows.total - liveWorkflows.completed - liveWorkflows.failed,
        successRate: workflowSuccessRate,
      },
      posts: {
        total: totalPosts,
        completed: completedPosts,
        failed: failedPosts,
        successRate: postSuccessRate,
      },
      nodes: {
        total: totalNodes,
        completed: completedNodes,
        failed: failedNodes,
        successRate: nodeSuccessRate,
        avgDurationMs: avgDuration,
      },
      cost: {
        total: (costData?.total || 0) + (archived?.total_cost || 0),
      },
      platforms: {
        pinterest: livePlatforms.pinterest + (archived?.pinterest_outputs || 0),
        facebook: livePlatforms.facebook + (archived?.facebook_outputs || 0),
      },
    };
  }

  /**
   * Get automation-specific analytics
   * @param {number} hoursAgo - Hours to look back
   */
  getAutomationAnalytics(hoursAgo = 24) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

    return this.db.prepare(`
      SELECT 
        automation_id,
        automation_name,
        COUNT(*) as workflow_count,
        SUM(posts_completed + posts_failed) as total_posts,
        SUM(posts_completed) as completed_posts,
        SUM(posts_failed) as failed_posts,
        SUM(total_cost_usd) as total_cost,
        SUM(pinterest_outputs) as pinterest_outputs,
        SUM(facebook_outputs) as facebook_outputs,
        ROUND(AVG(total_duration_ms), 0) as avg_duration_ms
      FROM archived_workflows
      WHERE created_at >= ?
      GROUP BY automation_id
      ORDER BY workflow_count DESC
    `).all(cutoff);
  }

  /**
   * Get platform performance analytics
   * @param {number} hoursAgo - Hours to look back
   * @param {string} automationId - Filter by automation (optional)
   */
  getPlatformAnalytics(hoursAgo = 24, automationId = null) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

    // From archived posts
    let query = `
      SELECT 
        COALESCE(platform, 'unknown') as platform,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM archived_posts
      WHERE created_at >= ?
    `;
    const params = [cutoff];
    if (automationId) {
      query += ` AND automation_id = ?`;
      params.push(automationId);
    }
    query += ` GROUP BY platform`;
    
    const fromArchive = this.db.prepare(query).all(...params);

    // From archived workflows (aggregated outputs)
    let wfQuery = `
      SELECT 
        SUM(pinterest_outputs) as pinterest,
        SUM(facebook_outputs) as facebook
      FROM archived_workflows
      WHERE created_at >= ?
    `;
    const wfParams = [cutoff];
    if (automationId) {
      wfQuery = wfQuery.replace('WHERE', 'WHERE automation_id = ? AND');
      wfParams.unshift(automationId);
    }
    const fromWorkflows = this.db.prepare(wfQuery).get(...wfParams);

    return {
      byPlatform: fromArchive,
      outputs: {
        pinterest: fromWorkflows?.pinterest || 0,
        facebook: fromWorkflows?.facebook || 0,
      },
    };
  }

  /**
   * Get completion trend data
   * @param {number} hoursAgo - Hours to look back
   * @param {string} automationId - Filter by automation (optional)
   * @param {object} workflowDb - Reference to main WorkflowDatabase
   */
  getCompletionTrend(hoursAgo = 24, automationId = null, workflowDb = null) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const isHourly = hoursAgo <= 48;
    
    // Get from daily snapshots
    let snapshotQuery;
    if (isHourly) {
      snapshotQuery = `
        SELECT 
          date || ' ' || printf('%02d', hour) || ':00' as time_bucket,
          SUM(posts_completed) as completed,
          SUM(posts_failed) as failed
        FROM daily_snapshots
        WHERE date >= ?
      `;
    } else {
      snapshotQuery = `
        SELECT 
          date as time_bucket,
          SUM(posts_completed) as completed,
          SUM(posts_failed) as failed
        FROM daily_snapshots
        WHERE date >= ?
      `;
    }
    
    const cutoffDate = cutoff.split('T')[0];
    const snapshotParams = [cutoffDate];
    if (automationId) {
      snapshotQuery += ` AND automation_id = ?`;
      snapshotParams.push(automationId);
    }
    snapshotQuery += isHourly 
      ? ` GROUP BY date, hour ORDER BY date, hour` 
      : ` GROUP BY date ORDER BY date`;
    
    const snapshotData = this.db.prepare(snapshotQuery).all(...snapshotParams);

    // Get live data from main database if available
    let liveData = [];
    if (workflowDb) {
      let liveQuery;
      if (isHourly) {
        liveQuery = `
          SELECT 
            strftime('%Y-%m-%d %H:00', p.created_at) as time_bucket,
            SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END) as failed
          FROM posts p
          JOIN workflows w ON p.workflow_id = w.workflow_id
          WHERE p.created_at >= ?
        `;
      } else {
        liveQuery = `
          SELECT 
            strftime('%Y-%m-%d', p.created_at) as time_bucket,
            SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END) as failed
          FROM posts p
          JOIN workflows w ON p.workflow_id = w.workflow_id
          WHERE p.created_at >= ?
        `;
      }
      const liveParams = [cutoff];
      if (automationId) {
        liveQuery = liveQuery.replace('WHERE p.created_at', 'WHERE w.automation_id = ? AND p.created_at');
        liveParams.unshift(automationId);
      }
      liveQuery += isHourly 
        ? ` GROUP BY strftime('%Y-%m-%d %H', p.created_at) ORDER BY time_bucket`
        : ` GROUP BY strftime('%Y-%m-%d', p.created_at) ORDER BY time_bucket`;
      
      liveData = workflowDb.db.prepare(liveQuery).all(...liveParams);
    }

    // Merge snapshot and live data
    const mergedMap = new Map();
    for (const row of snapshotData) {
      mergedMap.set(row.time_bucket, {
        timeBucket: row.time_bucket,
        completed: row.completed || 0,
        failed: row.failed || 0,
      });
    }
    for (const row of liveData) {
      const existing = mergedMap.get(row.time_bucket);
      if (existing) {
        existing.completed += row.completed || 0;
        existing.failed += row.failed || 0;
      } else {
        mergedMap.set(row.time_bucket, {
          timeBucket: row.time_bucket,
          completed: row.completed || 0,
          failed: row.failed || 0,
        });
      }
    }

    // Sort and return
    return Array.from(mergedMap.values()).sort((a, b) => 
      a.timeBucket.localeCompare(b.timeBucket)
    );
  }

  // ============================================
  // DATA RETENTION & CLEANUP
  // ============================================

  /**
   * Prune old detailed data (older than retention period)
   * @param {number} daysToKeep - Days of detailed data to retain
   * @param {object} workflowDb - Reference to main WorkflowDatabase
   */
  pruneOldData(daysToKeep = 365, workflowDb = null) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    
    console.log(`[AnalyticsDB] Pruning data older than ${cutoff}`);

    // First, ensure we have daily snapshots for the data we're about to delete
    this.aggregateOldDataToSnapshots(cutoff, workflowDb);

    // Delete old error records (keep aggregated in daily_snapshots)
    const errorResult = this.db.prepare(`
      DELETE FROM error_records WHERE created_at < ?
    `).run(cutoff);
    console.log(`[AnalyticsDB] Pruned ${errorResult.changes} old error records`);

    // Delete old cost tracking records (already aggregated to daily_snapshots)
    const costResult = this.db.prepare(`
      DELETE FROM cost_tracking WHERE created_at < ?
    `).run(cutoff);
    console.log(`[AnalyticsDB] Pruned ${costResult.changes} old cost records`);

    // Delete old archived posts (keep workflow summaries)
    const postResult = this.db.prepare(`
      DELETE FROM archived_posts WHERE archived_at < ?
    `).run(cutoff);
    console.log(`[AnalyticsDB] Pruned ${postResult.changes} old archived posts`);

    // Prune node_executions in main database if provided
    if (workflowDb) {
      try {
        const nodeResult = workflowDb.db.prepare(`
          DELETE FROM node_executions WHERE created_at < ?
        `).run(cutoff);
        console.log(`[AnalyticsDB] Pruned ${nodeResult.changes} old node_executions from main DB`);
      } catch (error) {
        console.error('[AnalyticsDB] Error pruning node_executions:', error);
      }
    }

    return {
      errorsDeleted: errorResult.changes,
      costsDeleted: costResult.changes,
      postsDeleted: postResult.changes,
    };
  }

  /**
   * Aggregate old data into daily snapshots before deletion
   */
  aggregateOldDataToSnapshots(cutoff, workflowDb) {
    // Aggregate node_executions by date before pruning
    if (workflowDb) {
      const nodeData = workflowDb.db.prepare(`
        SELECT 
          strftime('%Y-%m-%d', created_at) as date,
          strftime('%H', created_at) as hour,
          workflow_id,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN completed_at IS NOT NULL 
            THEN (julianday(completed_at) - julianday(created_at)) * 86400000 
            ELSE 0 END) as duration
        FROM node_executions
        WHERE created_at < ?
        GROUP BY date, hour
      `).all(cutoff);

      for (const row of nodeData) {
        this.db.prepare(`
          INSERT INTO daily_snapshots (
            date, hour, automation_id,
            nodes_executed, nodes_completed, nodes_failed, total_duration_ms,
            created_at, updated_at
          ) VALUES (?, ?, '_aggregated', ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(date, hour, automation_id) DO UPDATE SET
            nodes_executed = nodes_executed + excluded.nodes_executed,
            nodes_completed = nodes_completed + excluded.nodes_completed,
            nodes_failed = nodes_failed + excluded.nodes_failed,
            total_duration_ms = total_duration_ms + excluded.total_duration_ms,
            updated_at = datetime('now')
        `).run(
          row.date,
          parseInt(row.hour),
          row.total,
          row.completed,
          row.failed,
          Math.round(row.duration)
        );
      }
    }
  }

  /**
   * Export analytics data
   * @param {string} format - 'json' or 'csv'
   * @param {number} hoursAgo - Hours to look back
   * @param {string} automationId - Filter by automation (optional)
   */
  exportAnalytics(format = 'json', hoursAgo = 720, automationId = null) {
    const summary = this.getAnalyticsSummary(hoursAgo, automationId);
    const costData = this.getCostAnalytics(hoursAgo, automationId);
    const errorData = this.getErrorAnalytics(hoursAgo, automationId);
    const platformData = this.getPlatformAnalytics(hoursAgo, automationId);
    const peakUsage = this.getPeakUsage();
    const lifetimeStats = this.getLifetimeStats();

    const data = {
      exportedAt: new Date().toISOString(),
      timeRange: hoursAgo,
      automationId,
      summary,
      costData,
      errorData,
      platformData,
      peakUsage,
      lifetimeStats,
    };

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }

    // CSV format - flatten for export
    const rows = [];
    rows.push('Metric,Value');
    rows.push(`Total Workflows,${summary.workflows.total}`);
    rows.push(`Completed Workflows,${summary.workflows.completed}`);
    rows.push(`Total Posts,${summary.posts.total}`);
    rows.push(`Completed Posts,${summary.posts.completed}`);
    rows.push(`Failed Posts,${summary.posts.failed}`);
    rows.push(`Post Success Rate,${summary.posts.successRate}%`);
    rows.push(`Total Node Executions,${summary.nodes.total}`);
    rows.push(`Node Success Rate,${summary.nodes.successRate}%`);
    rows.push(`Avg Node Duration (ms),${summary.nodes.avgDurationMs}`);
    rows.push(`Total Cost (USD),${costData.totalCost}`);
    rows.push(`Pinterest Outputs,${platformData.outputs.pinterest}`);
    rows.push(`Facebook Outputs,${platformData.outputs.facebook}`);

    return rows.join('\n');
  }

  /**
   * Reset all analytics data (clear everything for fresh start)
   */
  resetAllData() {
    console.log('[AnalyticsDB] Resetting all analytics data...');
    
    this.db.exec(`
      DELETE FROM archived_workflows;
      DELETE FROM archived_posts;
      DELETE FROM daily_snapshots;
      DELETE FROM error_records;
      DELETE FROM cost_tracking;
      DELETE FROM lifetime_stats;
      DELETE FROM node_type_stats;
      DELETE FROM peak_usage;
    `);
    
    console.log('[AnalyticsDB] All analytics data cleared');
    return true;
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      console.log('[AnalyticsDB] Database closed');
    }
  }
}

// Export singleton instance getter
let analyticsDbInstance = null;

function getAnalyticsDatabase() {
  if (!analyticsDbInstance) {
    analyticsDbInstance = new AnalyticsDatabase();
  }
  return analyticsDbInstance;
}

module.exports = {
  AnalyticsDatabase,
  getAnalyticsDatabase,
  ERROR_PATTERNS,
};
