const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");

class WorkflowDatabase {
  constructor() {
    const dbPath = path.join(app.getPath("userData"), "workflows.db");
    this.db = new Database(dbPath);

    // Enable WAL mode for better performance and concurrency
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.initSchema();
    
    // Remove only TRULY orphaned outputs/executions whose parent post no longer
    // exists (e.g. a workflow was deleted). This must NEVER delete outputs of an
    // existing post just because its status isn't 'completed' — doing so wiped the
    // results of week-old workflows on restart ("No output found" bug).
    this.cleanupOrphanedOutputs();

    // If a post has saved outputs, the workflow produced a usable result. Keep
    // status in sync so completed posts do not linger as failed after crashes.
    this.reconcilePostStatusesFromOutputs();
    
    // Fix any stuck workflows that show "pending" but have no pending posts
    this.fixStuckWorkflows();
    
    console.log("✓ Workflow database initialized:", dbPath);
  }

  // Helper to convert snake_case database fields to camelCase for frontend
  _toCamelCase(obj) {
    if (!obj) return obj;
    const camelCase = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
        letter.toUpperCase(),
      );
      camelCase[camelKey] = value;
    }
    return camelCase;
  }

  initSchema() {
    this.db.exec(`
            -- ============================================
            -- WORKFLOWS TABLE
            -- ============================================
            CREATE TABLE IF NOT EXISTS workflows (
                workflow_id TEXT PRIMARY KEY,
                name TEXT,
                automation_id TEXT,
                status TEXT CHECK(status IN ('pending', 'queued', 'completed', 'failed', 'stopped')),
                progress INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT,
              queue_started_at TEXT,
              queue_wait_ms INTEGER,
              execution_started_at TEXT,
              execution_completed_at TEXT,
              runtime_ms INTEGER,
                exported INTEGER DEFAULT 0,
                exported_at TEXT,
                skip_image_choosing INTEGER DEFAULT 0
            );
            
            -- Add skip_image_choosing column if it doesn't exist (migration for existing DBs)
            -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we handle it in code

            CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
            CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_workflows_automation ON workflows(automation_id);

            -- ============================================
            -- POSTS TABLE  
            -- ============================================
            CREATE TABLE IF NOT EXISTS posts (
                post_id TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                post_img TEXT,
                post_message TEXT,
                status TEXT CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
                progress INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                pinterest_account_id TEXT,
                pinterest_board_id TEXT,
                pinterest_title_id TEXT,
                FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_posts_workflow ON posts(workflow_id);
            CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
            CREATE INDEX IF NOT EXISTS idx_posts_pinterest_account ON posts(pinterest_account_id);

            -- ============================================
            -- POST OUTPUTS TABLE (Pinterest/Facebook)
            -- ============================================
            CREATE TABLE IF NOT EXISTS post_outputs (
                output_id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id TEXT NOT NULL,
                platform TEXT CHECK(platform IN ('pinterest', 'facebook')),
                output_data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_outputs_post ON post_outputs(post_id);
            CREATE INDEX IF NOT EXISTS idx_outputs_platform ON post_outputs(platform);

            -- ============================================
            -- NODE EXECUTION TABLE (Node logs per post)
            -- No foreign keys - analytics persist after workflow deletion
            -- ============================================
            CREATE TABLE IF NOT EXISTS node_executions (
                execution_id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id TEXT,
                workflow_id TEXT,
                node_id TEXT NOT NULL,
                node_type TEXT NOT NULL,
                status TEXT CHECK(status IN ('started', 'processing', 'completed', 'failed')),
                message TEXT,
                attempt INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                completed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_executions_post ON node_executions(post_id);
            CREATE INDEX IF NOT EXISTS idx_executions_workflow ON node_executions(workflow_id);
            CREATE INDEX IF NOT EXISTS idx_executions_node ON node_executions(node_id);
            CREATE INDEX IF NOT EXISTS idx_executions_status ON node_executions(status);
            CREATE INDEX IF NOT EXISTS idx_executions_node_type ON node_executions(node_type);
            CREATE INDEX IF NOT EXISTS idx_executions_created ON node_executions(created_at);

            -- ============================================
            -- MIGRATION STATUS TABLE
            -- ============================================
            CREATE TABLE IF NOT EXISTS migration_status (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                migrated_at TEXT NOT NULL
            );
            
            -- ============================================
            -- PAGE FOLLOWERS CACHE TABLE
            -- ============================================
            CREATE TABLE IF NOT EXISTS page_followers (
                actor_id TEXT PRIMARY KEY,
                page_url TEXT,
                page_name TEXT,
                followers INTEGER NOT NULL,
                cached_at INTEGER NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_page_followers_url ON page_followers(page_url);
            CREATE INDEX IF NOT EXISTS idx_page_followers_cached ON page_followers(cached_at);
            
            -- ============================================
            -- ACTIVITIES TABLE (Persistent Activity Log)
            -- No foreign keys to avoid cascade deletes
            -- ============================================
            CREATE TABLE IF NOT EXISTS activities (
                activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                message TEXT NOT NULL,
                source_type TEXT,
                source_id TEXT,
                created_at TEXT NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
        `);

    // Run migrations for existing databases
    this._runMigrations();
  }

  _runMigrations() {
    // Migration: Add skip_image_choosing column if it doesn't exist
    try {
      const columns = this.db.prepare("PRAGMA table_info(workflows)").all();
      const hasSkipColumn = columns.some(
        (col) => col.name === "skip_image_choosing",
      );

      if (!hasSkipColumn) {
        this.db.exec(
          "ALTER TABLE workflows ADD COLUMN skip_image_choosing INTEGER DEFAULT 0",
        );
        console.log("✓ Added skip_image_choosing column to workflows table");
      }
    } catch (error) {
      // Column might already exist or other error
      console.log("Migration check for skip_image_choosing:", error.message);
    }

    // Migration: Add original_input_image column to posts table
    // This stores the unprocessed original image before any cropping/inpainting
    try {
      const postColumns = this.db.prepare("PRAGMA table_info(posts)").all();
      const hasOriginalImageColumn = postColumns.some(
        (col) => col.name === "original_input_image",
      );

      if (!hasOriginalImageColumn) {
        this.db.exec("ALTER TABLE posts ADD COLUMN original_input_image TEXT");
        console.log("✓ Added original_input_image column to posts table");
      }
    } catch (error) {
      console.log("Migration check for original_input_image:", error.message);
    }

    // Migration: Add export_path column to workflows table
    // This stores the path where workflow images were exported
    try {
      const workflowColumns = this.db.prepare("PRAGMA table_info(workflows)").all();
      const hasExportPathColumn = workflowColumns.some(
        (col) => col.name === "export_path",
      );

      if (!hasExportPathColumn) {
        this.db.exec("ALTER TABLE workflows ADD COLUMN export_path TEXT");
        console.log("✓ Added export_path column to workflows table");
      }
    } catch (error) {
      console.log("Migration check for export_path:", error.message);
    }

    // Migration: Add workflow runtime timing columns
    // Runtime is execution-only (from first pending transition to terminal completion)
    try {
      const workflowColumns = this.db.prepare("PRAGMA table_info(workflows)").all();

      if (!workflowColumns.some((col) => col.name === "queue_started_at")) {
        this.db.exec("ALTER TABLE workflows ADD COLUMN queue_started_at TEXT");
        console.log("✓ Added queue_started_at column to workflows table");
      }

      if (!workflowColumns.some((col) => col.name === "queue_wait_ms")) {
        this.db.exec("ALTER TABLE workflows ADD COLUMN queue_wait_ms INTEGER");
        console.log("✓ Added queue_wait_ms column to workflows table");
      }

      if (!workflowColumns.some((col) => col.name === "execution_started_at")) {
        this.db.exec("ALTER TABLE workflows ADD COLUMN execution_started_at TEXT");
        console.log("✓ Added execution_started_at column to workflows table");
      }

      if (!workflowColumns.some((col) => col.name === "execution_completed_at")) {
        this.db.exec("ALTER TABLE workflows ADD COLUMN execution_completed_at TEXT");
        console.log("✓ Added execution_completed_at column to workflows table");
      }

      if (!workflowColumns.some((col) => col.name === "runtime_ms")) {
        this.db.exec("ALTER TABLE workflows ADD COLUMN runtime_ms INTEGER");
        console.log("✓ Added runtime_ms column to workflows table");
      }
    } catch (error) {
      console.log("Migration check for runtime columns:", error.message);
    }

    // Migration: Add export_index column to posts table
    // This stores the 1-based index of the exported file (e.g., 34 for 34.png)
    try {
      const postColumns = this.db.prepare("PRAGMA table_info(posts)").all();
      const hasExportIndexColumn = postColumns.some(
        (col) => col.name === "export_index",
      );

      if (!hasExportIndexColumn) {
        this.db.exec("ALTER TABLE posts ADD COLUMN export_index INTEGER");
        console.log("✓ Added export_index column to posts table");
      }
    } catch (error) {
      console.log("Migration check for export_index:", error.message);
    }

    // Migration: Remove foreign key constraints from node_executions table
    // This allows analytics to persist even after workflows are deleted
    this._migrateNodeExecutionsRemoveForeignKeys();

    // Migration: Add 'paused' to workflows status CHECK constraint
    try {
      const tableInfo = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='workflows'"
      ).get();

      if (tableInfo && tableInfo.sql && !tableInfo.sql.includes("'paused'")) {
        const existingColumns = this.db.prepare("PRAGMA table_info(workflows)").all();
        const colNames = existingColumns.map(c => `"${c.name}"`).join(', ');

        // Build column definitions preserving all types/defaults but updating status CHECK
        const colDefs = existingColumns.map(c => {
          if (c.name === 'status') {
            return `"status" TEXT CHECK(status IN ('pending', 'queued', 'completed', 'failed', 'stopped', 'paused'))`;
          }
          let def = `"${c.name}" ${c.type || 'TEXT'}`;
          if (c.pk) def += ' PRIMARY KEY';
          else if (c.notnull) def += ' NOT NULL';
          if (!c.pk && c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
          return def;
        }).join(', ');

        const migrate = this.db.transaction(() => {
          this.db.exec(`CREATE TABLE "workflows_v2_paused" (${colDefs})`);
          this.db.exec(`INSERT INTO "workflows_v2_paused" (${colNames}) SELECT ${colNames} FROM "workflows"`);
          this.db.exec('DROP TABLE "workflows"');
          this.db.exec('ALTER TABLE "workflows_v2_paused" RENAME TO "workflows"');
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status)');
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at DESC)');
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_automation ON workflows(automation_id)');
        });
        migrate();
        console.log('✓ Migrated workflows table to support paused status');
      }
    } catch (error) {
      console.log('Migration check for paused status:', error.message);
    }
  }

  _migrateNodeExecutionsRemoveForeignKeys() {
    const migrationKey = "node_executions_remove_fk_v1";
    
    // Check if already migrated
    if (this.getMigrationStatus(migrationKey)) {
      return;
    }

    try {
      // Check if table has foreign keys by looking at the table SQL
      const tableInfo = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='node_executions'"
      ).get();
      
      if (!tableInfo || !tableInfo.sql) {
        // Table doesn't exist yet or will be created fresh without FK
        this.setMigrationStatus(migrationKey, "not_needed_new_table");
        return;
      }

      // If table doesn't have FOREIGN KEY, no migration needed
      if (!tableInfo.sql.includes("FOREIGN KEY")) {
        this.setMigrationStatus(migrationKey, "not_needed_no_fk");
        return;
      }

      console.log("✓ Migrating node_executions to remove foreign key constraints...");

      // SQLite doesn't support dropping foreign keys, so we need to recreate the table
      this.db.exec(`
        -- Create new table without foreign keys
        CREATE TABLE IF NOT EXISTS node_executions_new (
          execution_id INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id TEXT,
          workflow_id TEXT,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL,
          status TEXT CHECK(status IN ('started', 'processing', 'completed', 'failed')),
          message TEXT,
          attempt INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );

        -- Copy existing data
        INSERT INTO node_executions_new 
        SELECT execution_id, post_id, workflow_id, node_id, node_type, status, message, attempt, created_at, completed_at
        FROM node_executions;

        -- Drop old table
        DROP TABLE node_executions;

        -- Rename new table
        ALTER TABLE node_executions_new RENAME TO node_executions;

        -- Recreate indexes
        CREATE INDEX IF NOT EXISTS idx_executions_post ON node_executions(post_id);
        CREATE INDEX IF NOT EXISTS idx_executions_workflow ON node_executions(workflow_id);
        CREATE INDEX IF NOT EXISTS idx_executions_node ON node_executions(node_id);
        CREATE INDEX IF NOT EXISTS idx_executions_status ON node_executions(status);
        CREATE INDEX IF NOT EXISTS idx_executions_node_type ON node_executions(node_type);
        CREATE INDEX IF NOT EXISTS idx_executions_created ON node_executions(created_at);
      `);

      this.setMigrationStatus(migrationKey, "completed");
      console.log("✓ node_executions migration completed - analytics will persist after workflow deletion");
    } catch (error) {
      console.error("Migration error (node_executions FK removal):", error.message);
      // Don't block startup on migration failure
    }
  }

  // ============================================
  // WORKFLOW OPERATIONS
  // ============================================

  createWorkflow(workflowData) {
    const stmt = this.db.prepare(`
            INSERT INTO workflows (
                workflow_id,
                name,
                automation_id,
                status,
                progress,
                created_at,
                updated_at,
                queue_started_at,
                queue_wait_ms,
                execution_started_at,
                execution_completed_at,
                runtime_ms,
                exported,
                exported_at,
                skip_image_choosing
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

    const now = new Date().toISOString();
    const initialStatus = workflowData.status || "pending";
    const createdAt = workflowData.createdAt || now;
    const queueStartedAt = workflowData.queueStartedAt || createdAt;

    return stmt.run(
      workflowData.workflowId,
      workflowData.name || null,
      workflowData.automationId || null,
      initialStatus,
      workflowData.progress || 0,
      createdAt,
      workflowData.updatedAt || null,
      queueStartedAt,
      workflowData.queueWaitMs ?? null,
      workflowData.executionStartedAt || null,
      workflowData.executionCompletedAt || null,
      workflowData.runtimeMs ?? null,
      workflowData.exported ? 1 : 0,
      workflowData.exportedAt || null,
      workflowData.skipImageChoosing ? 1 : 0,
    );
  }

  updateWorkflowStatus(workflowId, status, progress = null) {
    const nowIso = new Date().toISOString();
    const terminalStates = new Set(["completed", "failed", "stopped"]);

    const current = this.db
      .prepare(
        `
            SELECT status, queue_started_at, queue_wait_ms, execution_started_at, execution_completed_at, runtime_ms
            FROM workflows
            WHERE workflow_id = ?
        `,
      )
      .get(workflowId);

    if (!current) {
      return this.db
        .prepare(
          `
            UPDATE workflows
            SET status = ?, progress = COALESCE(?, progress), updated_at = ?
            WHERE workflow_id = ?
        `,
        )
        .run(status, progress, nowIso, workflowId);
    }

    // A rerun re-enters queue and must reset timing to prevent stale runtime carry-over.
    if (status === "queued") {
      return this.db
        .prepare(
          `
            UPDATE workflows
            SET status = ?,
                progress = COALESCE(?, progress),
                updated_at = ?,
                queue_started_at = ?,
                queue_wait_ms = NULL,
                execution_started_at = NULL,
                execution_completed_at = NULL,
                runtime_ms = NULL
            WHERE workflow_id = ?
        `,
        )
        .run(status, progress, nowIso, nowIso, workflowId);
    }

    let queueWaitMs = current.queue_wait_ms ?? null;
    let executionStartedAt = current.execution_started_at || null;
    let executionCompletedAt = current.execution_completed_at || null;
    let runtimeMs = current.runtime_ms ?? null;

    if (status === "pending") {
      if (!executionStartedAt) {
        executionStartedAt = nowIso;
      }

      if (queueWaitMs == null && current.queue_started_at) {
        const queueStart = new Date(current.queue_started_at).getTime();
        if (!Number.isNaN(queueStart)) {
          queueWaitMs = Math.max(0, Date.now() - queueStart);
        }
      }
    }

    if (terminalStates.has(status)) {
      if (!executionStartedAt) {
        executionStartedAt = nowIso;
      }

      executionCompletedAt = nowIso;

      const startMs = new Date(executionStartedAt).getTime();
      const endMs = new Date(executionCompletedAt).getTime();
      if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
        runtimeMs = Math.max(0, endMs - startMs);
      }
    }

    return this.db
      .prepare(
        `
            UPDATE workflows
            SET status = ?,
                progress = COALESCE(?, progress),
                updated_at = ?,
                queue_wait_ms = ?,
                execution_started_at = ?,
                execution_completed_at = ?,
                runtime_ms = ?
            WHERE workflow_id = ?
        `,
      )
      .run(
        status,
        progress,
        nowIso,
        queueWaitMs,
        executionStartedAt,
        executionCompletedAt,
        runtimeMs,
        workflowId,
      );
  }

  updateWorkflowProgress(workflowId, progress) {
    const stmt = this.db.prepare(`
            UPDATE workflows 
            SET progress = ?, updated_at = ?
            WHERE workflow_id = ?
        `);
    return stmt.run(progress, new Date().toISOString(), workflowId);
  }

  markWorkflowExported(workflowId, exportPath = null) {
    const stmt = this.db.prepare(`
            UPDATE workflows 
            SET exported = 1, exported_at = ?, export_path = ?, updated_at = ?
            WHERE workflow_id = ?
        `);
    const now = new Date().toISOString();
    return stmt.run(now, exportPath, now, workflowId);
  }

  getWorkflowExportPath(workflowId) {
    const stmt = this.db.prepare(`
            SELECT export_path FROM workflows WHERE workflow_id = ?
        `);
    const result = stmt.get(workflowId);
    return result?.export_path || null;
  }

  unmarkWorkflowExported(workflowId) {
    const stmt = this.db.prepare(`
            UPDATE workflows 
            SET exported = 0, exported_at = NULL, updated_at = ?
            WHERE workflow_id = ?
        `);
    return stmt.run(new Date().toISOString(), workflowId);
  }

  updateWorkflowSkipMode(workflowId, skipImageChoosing) {
    const stmt = this.db.prepare(`
            UPDATE workflows 
            SET skip_image_choosing = ?, updated_at = ?
            WHERE workflow_id = ?
        `);
    return stmt.run(
      skipImageChoosing ? 1 : 0,
      new Date().toISOString(),
      workflowId,
    );
  }

  updateWorkflowAutomation(workflowId, automationId) {
    const stmt = this.db.prepare(`
            UPDATE workflows 
            SET automation_id = ?, updated_at = ?
            WHERE workflow_id = ?
        `);
    return stmt.run(
      automationId,
      new Date().toISOString(),
      workflowId,
    );
  }

  getWorkflow(workflowId) {
    return this.db
      .prepare(
        `
            SELECT * FROM workflows WHERE workflow_id = ?
        `,
      )
      .get(workflowId);
  }

  getWorkflowWithPosts(workflowId) {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) return null;

    const posts = this.getWorkflowPosts(workflowId);

    // Convert to camelCase for frontend consistency
    const camelWorkflow = this._toCamelCase(workflow);
    camelWorkflow.exported = camelWorkflow.exported === 1;
    camelWorkflow.skipImageChoosing = camelWorkflow.skipImageChoosing === 1;

    return {
      ...camelWorkflow,
      posts: posts,
    };
  }

  getAllWorkflowsSummary() {
    const rows = this.db
      .prepare(
        `
            SELECT w.*,
                   COUNT(p.post_id) as total_posts,
                   SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) as completed_posts,
                   SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END) as failed_posts,
                   SUM(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END) as pending_posts,
                   MAX(CASE WHEN p.pinterest_account_id IS NOT NULL AND p.pinterest_account_id != '' THEN 1 ELSE 0 END) as has_pinterest_posts,
                   (SELECT p2.pinterest_account_id FROM posts p2 WHERE p2.workflow_id = w.workflow_id AND p2.pinterest_account_id IS NOT NULL AND p2.pinterest_account_id != '' LIMIT 1) as workflow_pinterest_account_id
            FROM workflows w
            LEFT JOIN posts p ON w.workflow_id = p.workflow_id
            GROUP BY w.workflow_id
            ORDER BY w.created_at DESC
        `,
      )
      .all();

    // Convert to camelCase and fix booleans
    return rows.map((row) => {
      const camel = this._toCamelCase(row);
      camel.exported = camel.exported === 1;
      camel.skipImageChoosing = camel.skipImageChoosing === 1;
      camel.hasPinterestPosts = camel.hasPinterestPosts === 1;
      return camel;
    });
  }

  getAllWorkflowsWithPosts() {
    const workflows = this.getAllWorkflowsSummary();
    const result = {};

    for (const workflow of workflows) {
      const posts = this.getWorkflowPosts(workflow.workflow_id);
      result[workflow.workflow_id] = {
        ...workflow,
        posts: posts,
      };
    }

    return result;
  }

  deleteWorkflow(workflowId) {
    // CASCADE will auto-delete posts, outputs, and executions
    const stmt = this.db.prepare("DELETE FROM workflows WHERE workflow_id = ?");
    return stmt.run(workflowId);
  }

  /**
   * Get Pinterest title IDs from non-completed posts in a workflow
   * Used for cleanup when deleting workflows - these titles can be marked as unused
   * @param {string} workflowId - The workflow ID
   * @returns {string[]} Array of Pinterest title IDs
   */
  getNonCompletedTitleIds(workflowId) {
    const stmt = this.db.prepare(`
      SELECT DISTINCT pinterest_title_id 
      FROM posts 
      WHERE workflow_id = ? 
        AND status != 'completed' 
        AND pinterest_title_id IS NOT NULL
    `);
    const rows = stmt.all(workflowId);
    return rows.map(row => row.pinterest_title_id);
  }

  /**
   * Check if a Pinterest title is used in any workflow other than the specified one
   * @param {string} titleId - The Pinterest title ID
   * @param {string} excludeWorkflowId - The workflow ID to exclude from the check
   * @returns {boolean} True if the title is used in other workflows
   */
  isTitleUsedInOtherWorkflows(titleId, excludeWorkflowId) {
    const stmt = this.db.prepare(`
      SELECT 1 FROM posts 
      WHERE pinterest_title_id = ? 
        AND workflow_id != ? 
      LIMIT 1
    `);
    const result = stmt.get(titleId, excludeWorkflowId);
    return !!result;
  }

  // ============================================
  // POST OPERATIONS
  // ============================================

  /**
   * Count posts created today (UTC timezone)
   * Used for daily post limit enforcement
   */
  getPostsCreatedToday() {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM posts 
      WHERE date(created_at) = date('now')
    `).get();
    return result.count;
  }

  createPost(postData) {
    const stmt = this.db.prepare(`
            INSERT INTO posts (
                post_id, workflow_id, post_img, post_message, 
                status, progress, created_at,
                pinterest_account_id, pinterest_board_id, pinterest_title_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

    return stmt.run(
      postData.postId,
      postData.workflowId,
      postData.postImg || null,
      postData.postMessage || null,
      postData.status || "pending",
      postData.progress || 0,
      postData.createdAt || new Date().toISOString(),
      postData.pinterestAccountId || null,
      postData.pinterestBoardId || null,
      postData.pinterestTitleId || null,
    );
  }

  updatePostStatus(postId, status, progress = null) {
    if (status === "failed") {
      const outputCount = this.db
        .prepare("SELECT COUNT(*) as count FROM post_outputs WHERE post_id = ?")
        .get(postId)?.count || 0;

      if (outputCount > 0) {
        console.log(
          `[Database] Preserving completed status for post ${postId}: ${outputCount} saved output(s) exist`,
        );
        status = "completed";
        progress = 100;
      }
    }

    const stmt = this.db.prepare(`
            UPDATE posts 
            SET status = ?, progress = COALESCE(?, progress)
            WHERE post_id = ?
        `);
    return stmt.run(status, progress, postId);
  }

  updatePostProgress(postId, progress) {
    const stmt = this.db.prepare(`
            UPDATE posts 
            SET progress = ?
            WHERE post_id = ?
        `);
    return stmt.run(progress, postId);
  }

  updatePostImage(postId, newImagePath) {
    const stmt = this.db.prepare(`
            UPDATE posts 
            SET post_img = ?
            WHERE post_id = ?
        `);
    return stmt.run(newImagePath, postId);
  }

  getPost(postId) {
    const post = this.db
      .prepare(
        `
            SELECT * FROM posts WHERE post_id = ?
        `,
      )
      .get(postId);

    if (!post) return null;

    // Add outputs
    const outputs = this.getPostOutputs(postId);
    if (outputs.pinterest) post.pinterestOutput = outputs.pinterest;
    if (outputs.facebook) post.facebookOutput = outputs.facebook;

    // Add nodes
    post.nodes = this.getPostNodes(postId);

    return post;
  }

  getWorkflowPosts(workflowId, limit = null, offset = 0) {
    let query = `
            SELECT p.*
            FROM posts p
            WHERE p.workflow_id = ?
            ORDER BY p.created_at ASC
        `;

    if (limit) {
      query += ` LIMIT ? OFFSET ?`;
    }

    const stmt = this.db.prepare(query);
    const posts = limit
      ? stmt.all(workflowId, limit, offset)
      : stmt.all(workflowId);

    // Enrich each post with outputs and nodes, and convert to camelCase
    return posts.map((post) => {
      const outputs = this.getPostOutputs(post.post_id);
      const nodes = this.getPostNodes(post.post_id);

      const camelPost = this._toCamelCase(post);
      camelPost.pinterestOutput = outputs.pinterest || undefined;
      camelPost.facebookOutput = outputs.facebook || undefined;
      camelPost.nodes = nodes;

      return camelPost;
    });
  }

  /**
   * Set the export index for a post (the filename number when exported, e.g., 34 for 34.png)
   */
  setPostExportIndex(postId, exportIndex) {
    const stmt = this.db.prepare(`UPDATE posts SET export_index = ? WHERE post_id = ?`);
    return stmt.run(exportIndex, postId);
  }

  /**
   * Get the export index and workflow ID for a post
   */
  getPostExportInfo(postId) {
    const stmt = this.db.prepare(`
      SELECT export_index, workflow_id FROM posts WHERE post_id = ?
    `);
    const result = stmt.get(postId);
    if (!result) return null;
    return {
      exportIndex: result.export_index,
      workflowId: result.workflow_id,
    };
  }

  batchCreatePosts(posts) {
    const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO posts (
                post_id, workflow_id, post_img, post_message, 
                status, progress, created_at,
                pinterest_account_id, pinterest_board_id, pinterest_title_id,
                original_input_image
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

    const transaction = this.db.transaction((postsList) => {
      for (const post of postsList) {
        stmt.run(
          post.postId,
          post.workflowId,
          post.postImg || null,
          post.postMessage || null,
          post.status || "pending",
          post.progress || 0,
          post.createdAt || new Date().toISOString(),
          post.pinterestAccountId || null,
          post.pinterestBoardId || null,
          post.pinterestTitleId || null,
          post.originalInputImage || null,
        );
      }
    });

    transaction(posts);
  }

  // ============================================
  // POST OUTPUT OPERATIONS
  // ============================================

  addPostOutput(postId, platform, outputData) {
    const stmt = this.db.prepare(`
            INSERT INTO post_outputs (post_id, platform, output_data, created_at)
            VALUES (?, ?, ?, ?)
        `);

    return stmt.run(
      postId,
      platform,
      JSON.stringify(outputData),
      new Date().toISOString(),
    );
  }

  updatePostOutput(postId, platform, outputData) {
    // Delete existing and insert new (simpler than update)
    this.deletePostOutput(postId, platform);
    return this.addPostOutput(postId, platform, outputData);
  }

  /**
   * Update specific fields in a post output (for fixing text after policy check)
   */
  updatePostOutputFields(postId, platform, fieldsToUpdate) {
    // Get existing output
    const existing = this.db.prepare(`
      SELECT output_data FROM post_outputs WHERE post_id = ? AND platform = ?
    `).get(postId, platform);
    
    if (!existing) {
      console.warn(`[Database] No output found for post ${postId} platform ${platform}`);
      return { changes: 0 };
    }
    
    try {
      const outputData = JSON.parse(existing.output_data);
      // Merge the fields to update
      Object.assign(outputData, fieldsToUpdate);
      // Update the output
      const stmt = this.db.prepare(`
        UPDATE post_outputs SET output_data = ? WHERE post_id = ? AND platform = ?
      `);
      return stmt.run(JSON.stringify(outputData), postId, platform);
    } catch (e) {
      console.error(`[Database] Failed to update post output fields:`, e);
      return { changes: 0 };
    }
  }

  deletePostOutput(postId, platform) {
    const stmt = this.db.prepare(`
            DELETE FROM post_outputs 
            WHERE post_id = ? AND platform = ?
        `);
    return stmt.run(postId, platform);
  }

  /**
   * Clear all outputs for a post (used when resetting for rerun)
   */
  clearPostOutputs(postId) {
    const stmt = this.db.prepare(`
            DELETE FROM post_outputs 
            WHERE post_id = ?
        `);
    return stmt.run(postId);
  }

  /**
   * Clear all node execution history for a post (used when resetting for rerun)
   */
  clearPostNodeExecutions(postId) {
    const stmt = this.db.prepare(`
            DELETE FROM node_executions 
            WHERE post_id = ?
        `);
    return stmt.run(postId);
  }

  /**
   * Reset a post for rerun - clears status, progress, outputs, and node executions
   */
  resetPostForRerun(postId) {
    // Clear outputs first
    this.clearPostOutputs(postId);
    // Clear node execution history
    this.clearPostNodeExecutions(postId);
    // Reset status and progress
    this.updatePostStatus(postId, 'pending', 0);
    return { success: true };
  }

  /**
   * Clean up TRULY orphaned outputs - removes outputs/executions whose parent
   * post no longer exists in the posts table (e.g. the workflow was deleted).
   *
   * IMPORTANT: This intentionally does NOT delete rows based on post status.
   * Outputs of a post that exists are preserved regardless of whether the post
   * is 'completed', 'failed', 'processing' or 'pending'. Clearing a post's
   * outputs only happens explicitly via resetPostForRerun()/clearPostOutputs().
   * Safe to call on app startup.
   */
  cleanupOrphanedOutputs() {
    try {
      // Delete outputs whose parent post row is gone.
      const stmt = this.db.prepare(`
        DELETE FROM post_outputs 
        WHERE post_id NOT IN (SELECT post_id FROM posts)
      `);
      const result = stmt.run();
      
      // Delete node executions whose parent post row is gone.
      // (node_executions has no FK so it can survive post deletion otherwise.)
      const stmtNodes = this.db.prepare(`
        DELETE FROM node_executions 
        WHERE post_id IS NOT NULL
          AND post_id NOT IN (SELECT post_id FROM posts)
      `);
      const resultNodes = stmtNodes.run();
      
      if (result.changes > 0 || resultNodes.changes > 0) {
        console.log(`[Database] Cleaned up ${result.changes} orphaned outputs and ${resultNodes.changes} orphaned node executions`);
      }
      return { success: true, outputsRemoved: result.changes, nodesRemoved: resultNodes.changes };
    } catch (error) {
      console.error('[Database] Error cleaning up orphaned outputs:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fix stuck workflows that show "pending" status but have no pending posts.
   * This happens when the workflow-completed event fails to reach the frontend.
   * Called on app startup to auto-fix any stuck workflows.
   */
  fixStuckWorkflows() {
    try {
      // Find all workflows with status 'pending' (shown as "RUNNING" in UI)
      const pendingWorkflows = this.db.prepare(`
        SELECT workflow_id FROM workflows WHERE status = 'pending'
      `).all();
      
      let fixedCount = 0;
      
      for (const wf of pendingWorkflows) {
        const posts = this.db.prepare(`
          SELECT status FROM posts WHERE workflow_id = ?
        `).all(wf.workflow_id);
        
        if (posts.length === 0) continue; // Skip workflows with no posts
        
        const pendingPosts = posts.filter(p => p.status === 'pending' || p.status === 'processing');
        const failedPosts = posts.filter(p => p.status === 'failed');
        const completedPosts = posts.filter(p => p.status === 'completed');
        
        // If no posts are pending/processing, workflow should be completed
        if (pendingPosts.length === 0) {
          let finalStatus;
          if (failedPosts.length === posts.length) {
            finalStatus = 'failed';
          } else if (completedPosts.length + failedPosts.length === posts.length) {
            finalStatus = 'completed';
          } else {
            continue; // Unknown state, skip
          }
          
          const progress = Math.round((completedPosts.length + failedPosts.length) / posts.length * 100);
          
          this.db.prepare(`
            UPDATE workflows SET status = ?, progress = ?, updated_at = ? WHERE workflow_id = ?
          `).run(finalStatus, progress, new Date().toISOString(), wf.workflow_id);
          
          console.log(`[Database] Fixed stuck workflow ${wf.workflow_id}: ${finalStatus} (${completedPosts.length} completed, ${failedPosts.length} failed)`);
          fixedCount++;
        }
      }
      
      if (fixedCount > 0) {
        console.log(`[Database] ✓ Fixed ${fixedCount} stuck workflows`);
      }
      
      return { success: true, fixedCount };
    } catch (error) {
      console.error('[Database] Error fixing stuck workflows:', error);
      return { success: false, error: error.message };
    }
  }

  getPostOutputs(postId) {
    const outputs = this.db
      .prepare(
        `
            SELECT platform, output_data
            FROM post_outputs
            WHERE post_id = ?
        `,
      )
      .all(postId);

    const result = {};
    for (const output of outputs) {
      try {
        result[output.platform] = JSON.parse(output.output_data);
      } catch (e) {
        console.error(
          `Failed to parse ${output.platform} output for post ${postId}:`,
          e,
        );
      }
    }

    return result;
  }

  /**
   * Collect every local media file path referenced anywhere in the workflow DB.
   * Used by the cleanup engine to know which files in userData/Images, Audio and
   * Videos are still in use and must NOT be deleted.
   *
   * Sources scanned:
   *  - posts.post_img, posts.original_input_image
   *  - post_outputs.output_data (any string field that looks like a local path)
   *  - node_executions.message (output values that are local file paths, e.g. TTS mp3)
   *
   * Returns a Set of strings containing both full paths and basenames.
   */
  getAllReferencedMediaPaths() {
    const refs = new Set();
    // Image, video and audio extensions we track for cleanup.
    const mediaExtRe =
      /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?|mp4|webm|mov|avi|mkv|m4v|mp3|wav|ogg|m4a|aac|flac|wma|opus)\b/i;

    const add = (value) => {
      if (
        value &&
        typeof value === "string" &&
        !value.startsWith("http") &&
        !value.startsWith("data:") &&
        mediaExtRe.test(value)
      ) {
        refs.add(value);
        try {
          refs.add(path.basename(value));
        } catch (_) {
          /* ignore */
        }
      }
    };

    // Recursively walk a parsed JSON value pulling out any media-like strings.
    const walk = (node) => {
      if (!node) return;
      if (typeof node === "string") {
        add(node);
      } else if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (typeof node === "object") {
        Object.values(node).forEach(walk);
      }
    };

    try {
      // Posts: cropped/inpainted image + original input image
      const posts = this.db
        .prepare(`SELECT post_img, original_input_image FROM posts`)
        .all();
      for (const p of posts) {
        add(p.post_img);
        add(p.original_input_image);
      }
    } catch (e) {
      console.warn("[Database] getAllReferencedMediaPaths posts scan failed:", e.message);
    }

    try {
      // Post outputs: parse JSON and walk for any media path
      const outputs = this.db
        .prepare(`SELECT output_data FROM post_outputs`)
        .all();
      for (const o of outputs) {
        try {
          walk(JSON.parse(o.output_data));
        } catch (_) {
          // Not valid JSON - still try to extract a raw path
          add(o.output_data);
        }
      }
    } catch (e) {
      console.warn("[Database] getAllReferencedMediaPaths outputs scan failed:", e.message);
    }

    try {
      // Node execution messages: a node may output a local file path (e.g. TTS mp3)
      const execs = this.db
        .prepare(`SELECT message FROM node_executions WHERE message IS NOT NULL`)
        .all();
      for (const e of execs) {
        add(e.message);
      }
    } catch (e) {
      console.warn("[Database] getAllReferencedMediaPaths executions scan failed:", e.message);
    }

    return refs;
  }

  // ============================================
  // NODE EXECUTION OPERATIONS
  // ============================================

  logNodeExecution(executionData) {
    const stmt = this.db.prepare(`
            INSERT INTO node_executions (
                post_id, workflow_id, node_id, node_type, 
                status, message, attempt, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

    return stmt.run(
      executionData.postId,
      executionData.workflowId,
      executionData.nodeId,
      executionData.nodeType,
      executionData.status,
      executionData.message || null,
      executionData.attempt || 1,
      new Date().toISOString(),
      executionData.completedAt || null,
    );
  }

  updateNodeExecution(postId, nodeId, updates) {
    const fields = [];
    const values = [];

    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.message !== undefined) {
      fields.push("message = ?");
      values.push(updates.message);
    }
    if (updates.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(updates.completedAt);
    }

    if (fields.length === 0) return;

    values.push(postId, nodeId);

    const stmt = this.db.prepare(`
            UPDATE node_executions 
            SET ${fields.join(", ")}
            WHERE execution_id = (
                SELECT execution_id FROM node_executions
                WHERE post_id = ? AND node_id = ?
                ORDER BY created_at DESC
                LIMIT 1
            )
        `);

    return stmt.run(...values);
  }

  getPostNodes(postId) {
    return this.db
      .prepare(
        `
            SELECT * FROM node_executions
            WHERE post_id = ?
            ORDER BY created_at ASC
        `,
      )
      .all(postId)
      .map((row) => this._toCamelCase(row));
  }

  getWorkflowNodes(workflowId) {
    return this.db
      .prepare(
        `
            SELECT * FROM node_executions
            WHERE workflow_id = ?
            ORDER BY created_at ASC
        `,
      )
      .all(workflowId)
      .map((row) => this._toCamelCase(row));
  }

  // ============================================
  // ANALYTICS & STATS
  // ============================================

  getWorkflowStats() {
    return this.db
      .prepare(
        `
            SELECT 
                COUNT(*) as total_workflows,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued
            FROM workflows
        `,
      )
      .get();
  }

  getPostStats(workflowId = null) {
    let query = `
            SELECT 
                COUNT(*) as total_posts,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                AVG(progress) as avg_progress
            FROM posts
        `;

    if (workflowId) {
      query += " WHERE workflow_id = ?";
      return this.db.prepare(query).get(workflowId);
    }

    return this.db.prepare(query).get();
  }

  // ============================================
  // MIGRATION HELPERS
  // ============================================

  setMigrationStatus(key, value) {
    const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO migration_status (key, value, migrated_at)
            VALUES (?, ?, ?)
        `);
    return stmt.run(key, value, new Date().toISOString());
  }

  getMigrationStatus(key) {
    const result = this.db
      .prepare(
        `
            SELECT value FROM migration_status WHERE key = ?
        `,
      )
      .get(key);
    return result ? result.value : null;
  }

  reconcilePostStatusesFromOutputs() {
    try {
      const postsWithOutputs = this.db
        .prepare(
          `
                SELECT DISTINCT p.post_id, p.workflow_id
                FROM posts p
                INNER JOIN post_outputs po ON p.post_id = po.post_id
                WHERE p.status != 'completed'
            `,
        )
        .all();

      if (postsWithOutputs.length === 0) {
        return { success: true, count: 0 };
      }

      const updatePostStmt = this.db.prepare(`
                UPDATE posts
                SET status = 'completed', progress = 100
                WHERE post_id = ?
            `);

      const transaction = this.db.transaction((posts) => {
        for (const post of posts) {
          updatePostStmt.run(post.post_id);
        }
      });
      transaction(postsWithOutputs);

      const affectedWorkflowIds = [
        ...new Set(postsWithOutputs.map((post) => post.workflow_id)),
      ];

      for (const workflowId of affectedWorkflowIds) {
        const stats = this.db
          .prepare(
            `
                    SELECT
                        COUNT(*) as total,
                        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                        SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) as pending
                    FROM posts
                    WHERE workflow_id = ?
                `,
          )
          .get(workflowId);

        const total = stats.total || 0;
        const completed = stats.completed || 0;
        const failed = stats.failed || 0;
        const pending = stats.pending || 0;
        const progress =
          total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;

        if (pending === 0) {
          const status = failed === total && total > 0 ? "failed" : "completed";
          this.db
            .prepare(
              `
                    UPDATE workflows
                    SET status = ?, progress = ?, updated_at = ?
                    WHERE workflow_id = ?
                `,
            )
            .run(status, progress, new Date().toISOString(), workflowId);
        } else {
          this.db
            .prepare(
              `
                    UPDATE workflows
                    SET progress = ?, updated_at = ?
                    WHERE workflow_id = ?
                `,
            )
            .run(progress, new Date().toISOString(), workflowId);
        }
      }

      console.log(
        `[Database] Reconciled ${postsWithOutputs.length} post(s) with saved outputs to completed`,
      );
      return { success: true, count: postsWithOutputs.length };
    } catch (error) {
      console.error("[Database] Failed to reconcile post statuses:", error);
      return { success: false, error: error.message };
    }
  }

  // Migration: Mark posts with outputs as completed
  migratePostStatusFromOutputs() {
    const migrationKey = "post_status_from_outputs_v1";

    // Check if already migrated
    if (this.getMigrationStatus(migrationKey)) {
      console.log("✓ Post status migration already completed");
      return { migrated: false, reason: "already_done" };
    }

    try {
      const reconcileResult = this.reconcilePostStatusesFromOutputs();

      if (!reconcileResult.success) {
        return { migrated: false, error: reconcileResult.error };
      }

      if (reconcileResult.count === 0) {
        console.log("✓ No posts need status migration");
        this.setMigrationStatus(migrationKey, "completed_no_posts");
        return { migrated: true, count: 0 };
      }

      this.setMigrationStatus(
        migrationKey,
        `completed_${reconcileResult.count}_posts`,
      );
      console.log(
        `✓ Migrated ${reconcileResult.count} posts with outputs to completed status`,
      );

      return { migrated: true, count: reconcileResult.count };
    } catch (error) {
      console.error("Failed to migrate post status:", error);
      return { migrated: false, error: error.message };
    }
  }

  isMigrated() {
    return this.getMigrationStatus("workflows_migrated") === "true";
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Called on app startup to clean up incomplete workflows from previous session.
   * - Marks all pending/queued workflows as completed
   * - Marks all pending/processing posts inside them as failed
   */
  cleanupIncompleteWorkflows() {
    try {
      console.log(
        "[DB] Cleaning up incomplete workflows from previous session...",
      );

      // Get all pending or queued workflows
      const pendingWorkflows = this.db
        .prepare(
          `
                SELECT workflow_id FROM workflows 
                WHERE status IN ('pending', 'queued')
            `,
        )
        .all();

      if (pendingWorkflows.length === 0) {
        console.log("[DB] No incomplete workflows to clean up");
        return { cleaned: true, workflowCount: 0, postCount: 0 };
      }

      const workflowIds = pendingWorkflows.map((w) => w.workflow_id);
      const placeholders = workflowIds.map(() => "?").join(",");

      // Mark pending/processing posts without saved outputs as failed.
      // Posts with outputs are reconciled to completed and must not be downgraded.
      const postResult = this.db
        .prepare(
          `
                UPDATE posts 
                SET status = 'failed'
                WHERE workflow_id IN (${placeholders})
                AND status IN ('pending', 'processing')
                AND NOT EXISTS (
                  SELECT 1 FROM post_outputs po WHERE po.post_id = posts.post_id
                )
            `,
        )
        .run(...workflowIds);

      this.reconcilePostStatusesFromOutputs();

      // Mark all pending/queued workflows as completed
      const workflowResult = this.db
        .prepare(
          `
                UPDATE workflows 
                SET status = 'completed', updated_at = ?
                WHERE workflow_id IN (${placeholders})
            `,
        )
        .run(new Date().toISOString(), ...workflowIds);

      console.log(
        `[DB] Cleaned up ${workflowResult.changes} workflows and ${postResult.changes} posts`,
      );

      return {
        cleaned: true,
        workflowCount: workflowResult.changes,
        postCount: postResult.changes,
      };
    } catch (error) {
      console.error("[DB] Failed to cleanup incomplete workflows:", error);
      return { cleaned: false, error: error.message };
    }
  }

  // ============================================
  // PAGE FOLLOWERS CACHE OPERATIONS
  // ============================================

  /**
   * Get cached page followers by actorId or pageUrl
   * Returns null if not found or expired (> 30 days)
   */
  getPageFollowers(actorId, pageUrl) {
    const CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const now = Date.now();

    let entry = null;

    // Try by actorId first
    if (actorId) {
      const stmt = this.db.prepare(
        "SELECT * FROM page_followers WHERE actor_id = ?",
      );
      entry = stmt.get(actorId);
    }

    // Try by pageUrl if not found
    if (!entry && pageUrl) {
      const stmt = this.db.prepare(
        "SELECT * FROM page_followers WHERE page_url = ?",
      );
      entry = stmt.get(pageUrl);
    }

    if (entry) {
      const ageMs = now - entry.cached_at;
      if (ageMs < CACHE_EXPIRY_MS) {
        return {
          actorId: entry.actor_id,
          pageUrl: entry.page_url,
          pageName: entry.page_name,
          followers: entry.followers,
          cachedAt: entry.cached_at,
          ageInDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
        };
      }
      // Entry expired, will be updated on next fetch
      return null;
    }

    return null;
  }

  /**
   * Save or update page followers in cache
   */
  savePageFollowers(actorId, pageUrl, pageName, followers) {
    const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO page_followers (actor_id, page_url, page_name, followers, cached_at)
            VALUES (?, ?, ?, ?, ?)
        `);

    return stmt.run(actorId, pageUrl, pageName, followers, Date.now());
  }

  /**
   * Get all cached page followers (for debugging/stats)
   */
  getAllPageFollowers() {
    const stmt = this.db.prepare(
      "SELECT * FROM page_followers ORDER BY cached_at DESC",
    );
    return stmt.all().map((entry) => ({
      actorId: entry.actor_id,
      pageUrl: entry.page_url,
      pageName: entry.page_name,
      followers: entry.followers,
      cachedAt: entry.cached_at,
    }));
  }

  /**
   * Get count of cached pages
   */
  getPageFollowersCount() {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM page_followers",
    );
    return stmt.get().count;
  }

  /**
   * Clean up expired page followers cache entries (older than 30 days)
   */
  cleanupExpiredPageFollowers() {
    const CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const expiryTime = Date.now() - CACHE_EXPIRY_MS;

    const stmt = this.db.prepare(
      "DELETE FROM page_followers WHERE cached_at < ?",
    );
    const result = stmt.run(expiryTime);

    if (result.changes > 0) {
      console.log(
        `[DB] Cleaned up ${result.changes} expired page followers cache entries`,
      );
    }

    return result.changes;
  }

  // ============================================
  // ACTIVITY LOG OPERATIONS
  // ============================================

  // Maximum number of activities to retain
  static MAX_ACTIVITIES = 150;

  /**
   * Log a new activity
   * @param {string} type - Activity type (success, error, info, warning, automation, template, workflow, spy, delete)
   * @param {string} message - Human-readable activity message
   * @param {string|null} sourceType - Source type (workflow, automation, template, spy, etc.)
   * @param {string|null} sourceId - ID of the source item (optional)
   * @returns {object} Insert result
   */
  logActivity(type, message, sourceType = null, sourceId = null) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO activities (type, message, source_type, source_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        type,
        message,
        sourceType,
        sourceId,
        new Date().toISOString(),
      );

      // Cleanup old activities if we exceed the max
      this._cleanupOldActivities();

      return result;
    } catch (error) {
      console.error("[DB] Error logging activity:", error);
      return null;
    }
  }

  /**
   * Get recent activities
   * @param {number} limit - Maximum number of activities to return (default 50)
   * @returns {Array} Array of activity objects
   */
  getRecentActivities(limit = 50) {
    try {
      const stmt = this.db.prepare(`
        SELECT activity_id, type, message, source_type, source_id, created_at
        FROM activities
        ORDER BY created_at DESC
        LIMIT ?
      `);

      const rows = stmt.all(limit);

      return rows.map((row) => ({
        activityId: row.activity_id,
        type: row.type,
        message: row.message,
        sourceType: row.source_type,
        sourceId: row.source_id,
        createdAt: row.created_at,
        timestamp: new Date(row.created_at),
      }));
    } catch (error) {
      console.error("[DB] Error getting recent activities:", error);
      return [];
    }
  }

  /**
   * Cleanup old activities when exceeding MAX_ACTIVITIES
   * Keeps only the most recent MAX_ACTIVITIES entries
   */
  _cleanupOldActivities() {
    try {
      const countStmt = this.db.prepare(
        "SELECT COUNT(*) as count FROM activities",
      );
      const { count } = countStmt.get();

      if (count > WorkflowDatabase.MAX_ACTIVITIES) {
        // Delete oldest activities that exceed the limit
        const deleteStmt = this.db.prepare(`
          DELETE FROM activities
          WHERE activity_id NOT IN (
            SELECT activity_id FROM activities
            ORDER BY created_at DESC
            LIMIT ?
          )
        `);

        const result = deleteStmt.run(WorkflowDatabase.MAX_ACTIVITIES);
        if (result.changes > 0) {
          console.log(
            `[DB] Cleaned up ${result.changes} old activity entries`,
          );
        }
      }
    } catch (error) {
      console.error("[DB] Error cleaning up old activities:", error);
    }
  }

  /**
   * Clear all activities (for testing/reset purposes)
   */
  clearAllActivities() {
    try {
      const stmt = this.db.prepare("DELETE FROM activities");
      return stmt.run();
    } catch (error) {
      console.error("[DB] Error clearing activities:", error);
      return null;
    }
  }

  // ============================================
  // MONITORING & ANALYTICS
  // ============================================

  /**
   * Get node type statistics (success/fail rates) within a time range
   * @param {number} hoursAgo - Hours to look back (default 24)
   */
  getNodeTypeStats(hoursAgo = 24) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT 
        node_type,
        COUNT(*) as total_executions,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        ROUND(100.0 * SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) / 
          NULLIF(SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END), 0), 1) as success_rate,
        ROUND(100.0 * SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) / 
          NULLIF(SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END), 0), 1) as failure_rate
      FROM node_executions
      WHERE created_at >= ?
      GROUP BY node_type
      ORDER BY total_executions DESC
    `).all(cutoff).map(row => this._toCamelCase(row));
  }

  /**
   * Get average execution duration per node type
   * @param {number} hoursAgo - Hours to look back (default 24)
   */
  getNodeDurations(hoursAgo = 24) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT 
        node_type,
        COUNT(*) as sample_size,
        ROUND(AVG(
          CASE 
            WHEN completed_at IS NOT NULL 
            THEN (julianday(completed_at) - julianday(created_at)) * 86400000 
            ELSE NULL 
          END
        ), 0) as avg_duration_ms,
        ROUND(MIN(
          CASE 
            WHEN completed_at IS NOT NULL 
            THEN (julianday(completed_at) - julianday(created_at)) * 86400000 
            ELSE NULL 
          END
        ), 0) as min_duration_ms,
        ROUND(MAX(
          CASE 
            WHEN completed_at IS NOT NULL 
            THEN (julianday(completed_at) - julianday(created_at)) * 86400000 
            ELSE NULL 
          END
        ), 0) as max_duration_ms
      FROM node_executions
      WHERE created_at >= ? AND completed_at IS NOT NULL
      GROUP BY node_type
      ORDER BY avg_duration_ms DESC
    `).all(cutoff).map(row => this._toCamelCase(row));
  }

  /**
   * Get workflow completion trend over time
   * @param {number} hoursAgo - Hours to look back (default 24)
   */
  getWorkflowCompletionTrend(hoursAgo = 24) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    // Use hourly buckets for <= 48 hours, daily for longer
    const groupBy = hoursAgo <= 48 ? "strftime('%Y-%m-%d %H:00', created_at)" : "date(created_at)";
    
    return this.db.prepare(`
      SELECT 
        ${groupBy} as time_bucket,
        COUNT(*) as total_workflows,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status IN ('pending', 'queued') THEN 1 ELSE 0 END) as pending
      FROM workflows
      WHERE created_at >= ?
      GROUP BY time_bucket
      ORDER BY time_bucket ASC
    `).all(cutoff).map(row => this._toCamelCase(row));
  }

  /**
   * Get posts completion trend over time
   * @param {number} hoursAgo - Hours to look back (default 24)
   */
  getPostsCompletionTrend(hoursAgo = 24) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const groupBy = hoursAgo <= 48 ? "strftime('%Y-%m-%d %H:00', created_at)" : "date(created_at)";
    
    return this.db.prepare(`
      SELECT 
        ${groupBy} as time_bucket,
        COUNT(*) as total_posts,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM posts
      WHERE created_at >= ?
      GROUP BY time_bucket
      ORDER BY time_bucket ASC
    `).all(cutoff).map(row => this._toCamelCase(row));
  }

  /**
   * Get currently active/running executions
   */
  getActiveExecutions() {
    const workflows = this.db.prepare(`
      SELECT workflow_id, name, automation_id, status, progress, created_at, updated_at
      FROM workflows
      WHERE status IN ('pending', 'queued')
      ORDER BY created_at DESC
    `).all().map(row => this._toCamelCase(row));

    const posts = this.db.prepare(`
      SELECT p.post_id, p.workflow_id, p.status, p.progress, p.created_at,
             w.name as workflow_name
      FROM posts p
      JOIN workflows w ON p.workflow_id = w.workflow_id
      WHERE p.status IN ('pending', 'processing')
      ORDER BY p.created_at DESC
      LIMIT 50
    `).all().map(row => this._toCamelCase(row));

    return { workflows, posts };
  }

  /**
   * Get recent node failures with details
   * @param {number} limit - Maximum failures to return
   */
  getRecentFailures(limit = 20) {
    return this.db.prepare(`
      SELECT 
        ne.execution_id,
        ne.post_id,
        ne.workflow_id,
        ne.node_id,
        ne.node_type,
        ne.message,
        ne.attempt,
        ne.created_at,
        ne.completed_at,
        w.name as workflow_name
      FROM node_executions ne
      LEFT JOIN workflows w ON ne.workflow_id = w.workflow_id
      WHERE ne.status = 'failed'
      ORDER BY ne.created_at DESC
      LIMIT ?
    `).all(limit).map(row => this._toCamelCase(row));
  }

  /**
   * Get comprehensive analytics summary
   * @param {number} hoursAgo - Hours to look back (default 24)
   */
  getAnalyticsSummary(hoursAgo = 24) {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

    // Workflow stats
    const workflowStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total_workflows,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_workflows,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_workflows,
        SUM(CASE WHEN status IN ('pending', 'queued') THEN 1 ELSE 0 END) as active_workflows
      FROM workflows
      WHERE created_at >= ?
    `).get(cutoff);

    // Post stats
    const postStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total_posts,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_posts,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_posts
      FROM posts
      WHERE created_at >= ?
    `).get(cutoff);

    // Node execution stats
    const nodeStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total_node_executions,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_nodes,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_nodes,
        ROUND(AVG(
          CASE 
            WHEN completed_at IS NOT NULL 
            THEN (julianday(completed_at) - julianday(created_at)) * 86400000 
            ELSE NULL 
          END
        ), 0) as avg_node_duration_ms
      FROM node_executions
      WHERE created_at >= ?
    `).get(cutoff);

    // Calculate success rates
    const workflowSuccessRate = workflowStats.total_workflows > 0 
      ? Math.round(100 * workflowStats.completed_workflows / workflowStats.total_workflows * 10) / 10 
      : 0;
    const postSuccessRate = postStats.total_posts > 0 
      ? Math.round(100 * postStats.completed_posts / postStats.total_posts * 10) / 10 
      : 0;
    const nodeSuccessRate = nodeStats.total_node_executions > 0 
      ? Math.round(100 * nodeStats.completed_nodes / nodeStats.total_node_executions * 10) / 10 
      : 0;

    return {
      timeRange: hoursAgo,
      workflows: {
        total: workflowStats.total_workflows || 0,
        completed: workflowStats.completed_workflows || 0,
        failed: workflowStats.failed_workflows || 0,
        active: workflowStats.active_workflows || 0,
        successRate: workflowSuccessRate,
      },
      posts: {
        total: postStats.total_posts || 0,
        completed: postStats.completed_posts || 0,
        failed: postStats.failed_posts || 0,
        successRate: postSuccessRate,
      },
      nodes: {
        total: nodeStats.total_node_executions || 0,
        completed: nodeStats.completed_nodes || 0,
        failed: nodeStats.failed_nodes || 0,
        successRate: nodeSuccessRate,
        avgDurationMs: nodeStats.avg_node_duration_ms || 0,
      },
    };
  }

  beginTransaction() {
    this.db.prepare("BEGIN TRANSACTION").run();
  }

  commit() {
    this.db.prepare("COMMIT").run();
  }

  rollback() {
    this.db.prepare("ROLLBACK").run();
  }

  vacuum() {
    this.db.prepare("VACUUM").run();
  }

  close() {
    this.db.close();
  }
}

// Singleton instance
let instance = null;

function getDatabase() {
  if (!instance) {
    instance = new WorkflowDatabase();
  }
  return instance;
}

module.exports = getDatabase();
