(() => {
  const WF_NAMESPACE = ".wf";
  const RENDER_INTERVAL_MS = 3000; // Render every 3 seconds for running workflows
  const RENDER_THROTTLE_MS = 150; // Fast throttle for responsive UI
  const POSTS_PAGE_SIZE = 20;
  const POSTS_PROGRESS_THROTTLE_MS = 100; // Fast throttle for post progress updates
  const STORAGE_WRITE_DEBOUNCE_MS = 350;

  // Use global cache to persist across page navigations
  let allWorkflows = window.workflowCache?.allWorkflows || {};
  let allWorkflowsSummary = window.workflowCache?.allWorkflowsSummary || [];
  let totalWorkflows = window.workflowCache?.totalWorkflows || 0;
  let currentWorkflowView = null;
  let currentPostView = null;
  let inLogs = false;
  let currentMode = "spy";
  let customModeImage = null; // Store uploaded image filename for custom mode
  let customModePinterestAccountId = null; // Optional Pinterest account for custom mode
  let customModePinterestBoardId = null;   // Optional Pinterest board for custom mode
  let currentAutomationId = null; // Store automation ID in variable (not DOM) to survive language changes
  let policyCheckCancelled = false; // Flag to cancel background policy checks

  // Set of workflow IDs currently in use by the Facebook Groups module.
  // These workflows cannot be deleted from here (the delete action is disabled).
  let fbGroupsWorkflowIds = new Set();

  // FB Insights mode state
  let fbInsightsCsvData = null; // Parsed CSV posts
  let fbInsightsProcessedPosts = []; // Posts after image fetching
  let fbInsightsCurrentStep = 1;

  // ISE (Image Search Engines) mode state
  let iseSearchResults = []; // Array of image objects from search
  let iseSelectedImages = new Set(); // Set of selected image IDs
  let iseIsSearching = false; // Flag to track if search is in progress
  let iseUsedImageHashes = new Set(); // Set of URL hashes for used images

  // Google Trends mode state
  let gtrendsFetchedTopics = []; // Array of trending topic objects
  let gtrendsSelectedTopics = new Set(); // Set of selected topic titles
  let gtrendsIsFetching = false; // Flag to track if fetch is in progress

  // Pinterest Feed Spy mode state
  let pfeedspyAllPins = []; // All collected pins (deduplicated, sorted after stop)
  let pfeedspyIsRunning = false; // Flag to track if scraping is running
  let pfeedspyStopRequested = false; // Flag to request graceful stop
  let pfeedspyCookies = null; // Pinterest session cookies
  let pfeedspyBookmark = null; // Current pagination bookmark
  let pfeedspyQuery = ""; // Current search query
  let pfeedspyPagesFetched = 0; // Pages fetched so far
  let pfeedspySelectedIds = new Set(); // IDs of user-selected pins
  let pfeedspyUsedIds = new Set(); // Persistently used pin IDs loaded from storage
  let pfeedspyAiGenTitles = []; // { id, pinId, title, isOriginal } — pre-generated AI title items
  let pfeedspyPinterestAccountId = null; // Optional Pinterest account for pfeedspy auto-publish
  let pfeedspyPinterestBoardId = null;   // Optional Pinterest board for pfeedspy auto-publish
  let pfeedspyStep = 1; // 1 = search/select, 2 = review & configure
  let pfeedspyStep2Items = []; // { id, pinId, title, isOriginal, checked }

  // Performance optimization: track last render state
  let lastWorkflowsHash = null;

  const postsPageByWorkflow = new Map();
  const wfRowCache = new Map();
  const postRowCache = new Map();
  const nodeRowCache = new Map();

  let savePending = false;
  if (!window.intervals) window.intervals = [];
  let renderIntervalId = null;
  let isPageVisible = true;
  let isImageProcessingMode = false; // Flag to pause intervals during cropping/inpainting
  let queueStatusIntervalId = null;

  // Track recent post completion timestamps (across all workflows) for posts/min metric
  // Uses global array so it persists across page navigations
  if (!window._postCompletionTimestamps) window._postCompletionTimestamps = [];

  // Cache for scheduled pins counts per Pinterest account (survives page navigations)
  // Structure: { [accountId]: { pendingCount: N, fetchedAt: timestamp } }
  if (!window.scheduledPinsCache) window.scheduledPinsCache = {};

  // Persist an account's pin count to both in-memory cache and storage
  const saveScheduledPinsCache = (accountId, pendingCount) => {
    window.scheduledPinsCache[accountId] = { pendingCount, fetchedAt: Date.now() };
    window.electronAPI.updateData("scheduledPinsCache", window.scheduledPinsCache).catch(() => {});
    lastWorkflowsHash = null; // force table re-render
  };

  function recordPostCompletion() {
    const ts = window._postCompletionTimestamps;
    ts.push(Date.now());
    // Keep only last 50 entries to limit memory
    if (ts.length > 50) ts.splice(0, ts.length - 50);
  }

  function getPostsPerHourText() {
    const ts = window._postCompletionTimestamps;
    if (!ts || ts.length < 2) return "";
    // Use last 10 completed posts max
    const recent = ts.slice(-10);
    if (recent.length < 2) return "";
    const elapsedHours = (recent[recent.length - 1] - recent[0]) / 3600000;
    if (elapsedHours <= 0) return "";
    const rate = Math.round((recent.length - 1) / elapsedHours);
    return `${rate} posts/h`;
  }

  function getPostsPerHourRate() {
    const ts = window._postCompletionTimestamps;
    if (!ts || ts.length < 2) return 0;
    const recent = ts.slice(-10);
    if (recent.length < 2) return 0;
    const elapsedHours = (recent[recent.length - 1] - recent[0]) / 3600000;
    if (elapsedHours <= 0) return 0;
    return (recent.length - 1) / elapsedHours;
  }

  function getEstimatedTimeLeft(runningIds, queuedIds) {
    const rate = getPostsPerHourRate();
    if (rate <= 0) return "";
    // Count remaining (non-completed/failed) posts in running + queued workflows
    let remaining = 0;
    const allIds = [...runningIds, ...queuedIds];
    for (const wfId of allIds) {
      const wf = allWorkflows[wfId];
      if (!wf) continue;
      if (Array.isArray(wf.posts) && wf.posts.length > 0) {
        for (const p of wf.posts) {
          if (p.status !== "completed" && p.status !== "failed") remaining++;
        }
      } else {
        // Posts array not loaded — use summary counts as fallback
        const total = typeof wf.totalPosts === "number" ? wf.totalPosts : 0;
        const done = typeof wf.completedPosts === "number" ? wf.completedPosts : 0;
        const failed = typeof wf.failedPosts === "number" ? wf.failedPosts : 0;
        remaining += Math.max(0, total - done - failed);
      }
    }
    if (remaining <= 0) return "";
    const hoursLeft = remaining / rate;
    const totalMin = Math.round(hoursLeft * 60);
    if (totalMin < 1) return "< 1m left";
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `~${h}h ${m}m left`;
    return `~${m}m left`;
  }

  // Shift-click multi-select tracking
  let lastCheckedPostIndex = null;
  let lastCheckedWorkflowIndex = null;

  // Flag to indicate the next startAutomation click should create a paused workflow
  let createPausedMode = false;

  // Track selected workflow IDs to persist across table re-renders
  const selectedWorkflowIds = new Set();

  // Listen for export processing started event (after user selects folder)
  window.electronAPI.onExportProcessingStarted(() => {
    showLoading("Downloading images and calculating similarity...");
  });

  // Pause background intervals during image processing (cropping/inpainting)
  const pauseBackgroundIntervals = () => {
    isImageProcessingMode = true;
    console.log(
      "[Performance] Pausing background intervals for image processing",
    );
  };

  // Resume background intervals after image processing
  const resumeBackgroundIntervals = () => {
    isImageProcessingMode = false;
    console.log("[Performance] Resuming background intervals");
  };

  const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
  const nowIso = () => new Date().toISOString();
  const ucfirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const formatScore = (value) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
      ? numericValue.toLocaleString(window.I18n?.getLocale?.() || "en", {
        useGrouping: false,
        maximumFractionDigits: 2,
      })
      : String(value);
  };
  const genId = (n = 10) =>
    Array.from(crypto.getRandomValues(new Uint32Array(n)))
      .map((x) => (x % 36).toString(36))
      .join("")
      .slice(0, n);

  const hash = (obj) => {
    try {
      const str = typeof obj === "string" ? obj : JSON.stringify(obj);
      let h = 0,
        i,
        chr;
      if (str.length === 0) return "0";
      for (i = 0; i < str.length; i++) {
        chr = str.charCodeAt(i);
        h = (h << 5) - h + chr;
        h |= 0;
      }
      return h.toString(36);
    } catch {
      return String(Math.random());
    }
  };

  const throttle = (fn, ms) => {
    let last = 0,
      timer = null,
      lastArgs = null;
    const throttled = function (...args) {
      const ts = Date.now();
      lastArgs = args;
      const run = () => {
        last = ts;
        timer = null;
        fn.apply(this, lastArgs);
        lastArgs = null;
      };
      if (ts - last >= ms) run();
      else if (!timer) timer = setTimeout(run, ms - (ts - last));
    };
    // Allow forcing immediate execution by resetting last timestamp
    throttled.forceImmediate = function (...args) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = 0;
      fn.apply(this, args);
    };
    return throttled;
  };

  const debounce = (fn, ms) => {
    let t = null;
    return function debounced(...args) {
      clearTimeout(t);
      return new Promise((resolve) => {
        t = setTimeout(async () => {
          const res = await fn.apply(this, args);
          resolve(res);
        }, ms);
      });
    };
  };

  let savePromise = Promise.resolve();

  // Save workflow to database (direct API call)
  const saveWorkflow = async (workflowId, workflowData) => {
    try {
      await window.electronAPI.invoke("create-workflow", {
        workflowId: workflowId,
        ...workflowData,
      });
      console.log(`✓ Workflow ${workflowId} saved`);
      return true;
    } catch (e) {
      console.error(`Failed saving workflow ${workflowId}:`, e);
      return false;
    }
  };

  // Update workflow status (direct API call)
  const updateWorkflowStatus = async (workflowId, status, progress) => {
    try {
      await window.electronAPI.invoke(
        "update-workflow-status",
        workflowId,
        status,
        progress,
      );
      // Update the full workflow cache
      if (allWorkflows[workflowId]) {
        allWorkflows[workflowId].status = status;
        if (progress !== undefined)
          allWorkflows[workflowId].progress = progress;
      }
      // CRITICAL: Also update the summary cache - this is what renderWorkflows uses as base
      const summaryIndex = allWorkflowsSummary.findIndex(w => w.workflowId === workflowId);
      if (summaryIndex !== -1) {
        allWorkflowsSummary[summaryIndex].status = status;
        if (progress !== undefined)
          allWorkflowsSummary[summaryIndex].progress = progress;
      }
      // Sync to global cache
      if (window.workflowCache) {
        window.workflowCache.allWorkflows = allWorkflows;
        window.workflowCache.allWorkflowsSummary = allWorkflowsSummary;
      }
      // Force next render to bypass hash check by invalidating the hash
      lastWorkflowsHash = null;
      return true;
    } catch (e) {
      console.error(`Failed updating workflow ${workflowId}:`, e);
      return false;
    }
  };

  // Legacy debounced save (deprecated - kept for compatibility)
  const saveWorkflowsDebounced = debounce(async () => {
    console.warn(
      "saveWorkflowsDebounced is deprecated, workflows are saved individually now",
    );
    savePending = false;
  }, STORAGE_WRITE_DEBOUNCE_MS);

  // Legacy immediate save (deprecated - kept for compatibility)
  const saveWorkflowsImmediate = async (retries = 3) => {
    console.warn(
      "saveWorkflowsImmediate is deprecated, workflows are saved individually now",
    );
    return true;
  };

  async function flushSaves() {
    // No-op now since saves are immediate
    await savePromise;
  }

  const scheduleSave = () => {
    // No-op now since saves are immediate
    savePending = false;
  };

  const imgTag = (src) =>
    `<img loading="lazy" src="${src}" style="max-width:80px" onerror="this.onerror=null;this.src='assets/images/blank.png';"/>`;

  // Helper to get proper image path - handles both absolute paths and filenames
  const getImagePath = (postImg) => {
    if (!postImg) return null;
    // Check if already an absolute path (contains drive letter on Windows or starts with /)
    if (postImg.includes(":") || postImg.startsWith("/")) {
      return postImg;
    }
    // Just a filename, prepend the Images directory
    return `${window.localPath}/Images/${postImg}`;
  };

  const escapeForCSV = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const PINTEREST_CSV_DEFAULT_BATCH_SIZE = 50;
  const PINTEREST_CSV_MAX_BATCH_SIZE = 100;
  const PINTEREST_CSV_HEADERS = [
    "Pinterest board",
    "Media URL",
    "Thumbnail",
    "Title",
    "Link",
    "Description",
    "Publish date",
  ];

  const tWorkflow = (key, fallback, params) => {
    const fullKey = `workflows.${key}`;
    const value = window.I18n?.t?.(fullKey, params);
    return value && value !== fullKey ? value : fallback;
  };

  const normalizePinterestCsvBatchSize = (value) => {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return PINTEREST_CSV_DEFAULT_BATCH_SIZE;
    return Math.max(1, Math.min(PINTEREST_CSV_MAX_BATCH_SIZE, parsed));
  };

  const getPinterestCsvBatchPromptField = (name) => ({
    type: "number",
    name,
    required: true,
    value: String(PINTEREST_CSV_DEFAULT_BATCH_SIZE),
    min: 1,
    max: PINTEREST_CSV_MAX_BATCH_SIZE,
    step: 1,
    placeholder: String(PINTEREST_CSV_DEFAULT_BATCH_SIZE),
  });

  const resolvePinterestCsvNames = (
    post,
    pinterestAccounts = {},
    structures = {},
    fallbackBoardName = "Unknown Board",
  ) => {
    let boardName = fallbackBoardName || "Unknown Board";
    let profileName = "No Profile Linked";

    if (post?.pinterestAccountId && post?.pinterestBoardId) {
      const account = pinterestAccounts[post.pinterestAccountId];
      if (account) {
        if (Array.isArray(account.boards)) {
          const board = account.boards.find(
            (b) => b.id === post.pinterestBoardId,
          );
          if (board?.name) boardName = board.name;
        }

        if (account.linkedStructureId && account.linkedProfileId) {
          const structure = structures[account.linkedStructureId];
          const profile = structure?.profiles?.[account.linkedProfileId];
          if (profile) {
            profileName =
              profile.label ||
              profile.name ||
              `Profile ${account.linkedProfileId}`;
          }
        }
      }
    }

    return { boardName, profileName };
  };

  const buildPinterestCsvRows = ({
    pinterestPosts,
    scheduledTimes,
    pinterestAccounts = {},
    structures = {},
    fallbackBoardName = "Unknown Board",
  }) => {
    const rows = [PINTEREST_CSV_HEADERS];
    const uniqueProfiles = new Set();
    const uniqueBoards = new Set();
    const usedTitles = new Set();

    pinterestPosts.forEach((post, i) => {
      const output = post.pinterestOutput || {};
      const { boardName, profileName } = resolvePinterestCsvNames(
        post,
        pinterestAccounts,
        structures,
        fallbackBoardName,
      );

      uniqueProfiles.add(profileName);
      uniqueBoards.add(boardName);

      rows.push([
        boardName,
        output.videoUrl || output.image || "",
        output.videoUrl ? "00:01" : "",
        makeUniqueTitle(output.title, usedTitles),
        output.url || "",
        output.description || "",
        scheduledTimes[i],
      ]);
    });

    return { rows, uniqueProfiles, uniqueBoards };
  };

  const splitPinterestCsvRows = (rows, batchSize) => {
    const headers = rows[0] || PINTEREST_CSV_HEADERS;
    const dataRows = rows.slice(1);
    const size = normalizePinterestCsvBatchSize(batchSize);
    const batches = [];

    for (let i = 0; i < dataRows.length; i += size) {
      batches.push([headers, ...dataRows.slice(i, i + size)]);
    }

    return batches;
  };

  const pinterestRowsToCsv = (rows) =>
    rows.map((row) => row.map(escapeForCSV).join(",")).join("\n");

  const addCsvBatchSuffix = (fileName, index, total) => {
    if (total <= 1) return fileName;
    const width = Math.max(2, String(total).length);
    const part = String(index + 1).padStart(width, "0");
    const totalText = String(total).padStart(width, "0");
    const suffix = `_part-${part}-of-${totalText}`;
    const safeName = String(fileName || `pinterest-${Date.now()}.csv`);

    if (safeName.toLowerCase().endsWith(".csv")) {
      return `${safeName.slice(0, -4)}${suffix}.csv`;
    }

    return `${safeName}${suffix}.csv`;
  };

  const joinExportPath = (folder, fileName) =>
    `${String(folder || "").replace(/[\\/]+$/, "")}\\${fileName}`;

  // Pinterest's bulk CSV import rejects files that contain duplicate pin
  // titles. The spy scraper frequently returns repeated titles (e.g. when a
  // description fallback is used), so we de-duplicate by appending a numeric
  // suffix to any repeated title before it is written to the CSV.
  const makeUniqueTitle = (title, usedTitles) => {
    let base = String(title || "").trim();
    if (!base) base = "Untitled";
    let candidate = base;
    let n = 2;
    while (usedTitles.has(candidate.toLowerCase())) {
      const suffix = ` (${n})`;
      // Pinterest titles are capped at 100 chars; trim the base to fit suffix.
      const maxBase = 100 - suffix.length;
      const trimmedBase = base.length > maxBase ? base.slice(0, maxBase) : base;
      candidate = `${trimmedBase}${suffix}`;
      n++;
    }
    usedTitles.add(candidate.toLowerCase());
    return candidate;
  };

  const pad2 = (n) => n.toString().padStart(2, "0");
  const formatScheduleDate = (date) =>
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

  // Sort spy posts by selected criteria (all descending)
  const applySortOrder = (posts, sortBy) => {
    const fieldMap = {
      newest: "now",
      virality: "viralityScore",
      shares: "shares",
      comments: "comments",
      reactions: "reactions",
    };
    const field = fieldMap[sortBy] || "now";
    return posts.sort((a, b) => (b[field] || 0) - (a[field] || 0));
  };

  // Fisher-Yates shuffle to randomize post order (avoids similar photos being posted consecutively)
  const shuffleArray = (array) => {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

  const trackBoardExportHistory = async (
    pinterestPosts,
    scheduledTimes,
    workflowId,
  ) => {
    try {
      // Load Pinterest accounts data
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const structures = (await window.electronAPI.readKey("structures")) || {};
      const workflow = allWorkflows[workflowId];
      const exportDate = new Date().toISOString();

      // Group posts by board (accountId + boardId combination)
      const boardExports = new Map();

      pinterestPosts.forEach((post, index) => {
        if (post.pinterestAccountId && post.pinterestBoardId) {
          const boardKey = `${post.pinterestAccountId}:${post.pinterestBoardId}`;

          if (!boardExports.has(boardKey)) {
            boardExports.set(boardKey, {
              accountId: post.pinterestAccountId,
              boardId: post.pinterestBoardId,
              posts: [],
            });
          }

          // Get profile name for the scheduled post
          let profileName = "No Profile Linked";
          const account = pinterestAccounts[post.pinterestAccountId];
          if (account && account.linkedStructureId && account.linkedProfileId) {
            const structure = structures[account.linkedStructureId];
            if (structure && structure.profiles) {
              const profile = structure.profiles[account.linkedProfileId];
              if (profile) {
                profileName =
                  profile.label ||
                  profile.name ||
                  `Profile ${account.linkedProfileId}`;
              }
            }
          }

          boardExports.get(boardKey).posts.push({
            postTitle: post.pinterestOutput.title || "Untitled Post",
            postDescription: post.pinterestOutput.description || "",
            scheduledDate: scheduledTimes[index],
            profileName: profileName,
            mediaUrl: post.pinterestOutput.image || "",
            linkUrl: post.pinterestOutput.url || "",
            workflowName: workflow?.name || `Workflow ${workflowId}`,
            exportDate: exportDate,
          });
        }
      });

      // Update each board's export history
      let pinterestAccountsUpdated = false;
      for (const [boardKey, boardData] of boardExports) {
        try {
          const account = pinterestAccounts[boardData.accountId];
          if (account && account.boards && Array.isArray(account.boards)) {
            const board = account.boards.find(
              (b) => b.id === boardData.boardId,
            );
            if (board) {
              // Initialize export history if it doesn't exist
              if (!board.csvExportHistory) {
                board.csvExportHistory = {
                  lastExportDate: null,
                  exportCount: 0,
                  scheduledPosts: [],
                };
              }

              // Update export history
              board.csvExportHistory.lastExportDate = exportDate;
              board.csvExportHistory.exportCount =
                (board.csvExportHistory.exportCount || 0) + 1;
              board.csvExportHistory.scheduledPosts = boardData.posts;

              pinterestAccountsUpdated = true;
              console.log(
                `Updated export history for board: ${board.name} (${boardData.posts.length} posts)`,
              );
            } else {
              console.warn(
                `Board not found: ${boardData.boardId} in account ${boardData.accountId}`,
              );
            }
          } else {
            console.warn(
              `Account not found or has no boards: ${boardData.accountId}`,
            );
          }
        } catch (error) {
          console.error(
            `Error updating board export history for ${boardKey}:`,
            error,
          );
        }
      }

      // Save updated Pinterest accounts data
      if (pinterestAccountsUpdated) {
        await window.electronAPI.updateData(
          "pinterestAccounts",
          pinterestAccounts,
        );
        console.log("Pinterest accounts data updated with export history");

        // Trigger Pinterest accounts page refresh if available
        if (
          window.PinterestAccounts &&
          typeof window.PinterestAccounts.refreshCsvExports === "function"
        ) {
          window.PinterestAccounts.refreshCsvExports();
        }
      } else {
        console.warn("No Pinterest accounts were updated with export history");
      }
    } catch (error) {
      console.error("Failed to track board export history:", error);
    }
  };

  const calculateScheduleTimes = (count, interval) => {
    const schedules = [];
    const now = new Date();
    const startTime = new Date(now.getTime() + 60 * 60 * 1000); // Start 1 hour from now

    if (interval === "all") {
      // All at once, 1 hour from now
      const s = formatScheduleDate(startTime);
      for (let i = 0; i < count; i++) schedules.push(s);
      return schedules;
    }

    // Parse period (e.g., "24h" -> 24 hours)
    const unit = interval.slice(-1);
    const value = parseInt(interval.slice(0, -1), 10);
    let periodMs = 0;

    if (unit === "h") periodMs = value * 60 * 60 * 1000;
    else if (unit === "d") periodMs = value * 24 * 60 * 60 * 1000;

    const endTime = new Date(startTime.getTime() + periodMs);
    const totalTimeSpan = endTime.getTime() - startTime.getTime();

    // Generate random times within the period
    const randomTimes = [];
    for (let i = 0; i < count; i++) {
      const randomOffset = Math.random() * totalTimeSpan;
      const randomTime = new Date(startTime.getTime() + randomOffset);
      randomTimes.push(randomTime);
    }

    // Sort times chronologically
    randomTimes.sort((a, b) => a.getTime() - b.getTime());

    // Format the sorted times
    for (let i = 0; i < count; i++) {
      schedules.push(formatScheduleDate(randomTimes[i]));
    }

    return schedules;
  };

  const progressBar = (val) => {
    const v = Math.max(0, Math.min(100, Number.isFinite(val) ? val : 0));
    return `<div class="mb-1"><div class="progress" style="height:14px"><div class="progress-bar" role="progressbar" style="width:${v}%">${v}%</div></div></div>`;
  };

  const statusBadge = (status) => {
    if (status === "pending") {
      return `<div class="d-flex justify-content-center align-items-center progress"><div class="spinner-border small me-1"></div><span>Pending</span></div>`;
    }
    const color =
      status === "completed"
        ? "success"
        : status === "failed"
          ? "danger"
          : "secondary";
    return `<div class="d-flex justify-content-center align-items-center progress"><div class="status bg-${color} small me-1"></div><span>${ucfirst(status || "unknown")}</span></div>`;
  };

  const timeAgo = (iso) => {
    try {
      if (typeof window.timeAgo === "function") return window.timeAgo(iso);
      const d = new Date(iso);
      const diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 60) return `${Math.floor(diff)}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    } catch {
      return iso || "";
    }
  };

  const formatRunTimeFromMs = (totalMs) => {
    const totalSec = Math.max(0, Math.floor(totalMs / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;

    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  // Runtime is execution-only (executionStartedAt -> now/executionCompletedAt).
  const formatRunTime = (
    status,
    executionStartedAt,
    executionCompletedAt,
    runtimeMs,
  ) => {
    try {
      if (status === "queued") return "—";

      const isTerminal =
        status === "completed" || status === "failed" || status === "stopped";

      if (typeof runtimeMs === "number" && runtimeMs >= 0) {
        return formatRunTimeFromMs(runtimeMs);
      }

      const startMs = executionStartedAt
        ? new Date(executionStartedAt).getTime()
        : NaN;

      if (Number.isNaN(startMs)) {
        return status === "pending" ? "Starting..." : "—";
      }

      const endMs = isTerminal
        ? executionCompletedAt
          ? new Date(executionCompletedAt).getTime()
          : Date.now()
        : Date.now();

      if (Number.isNaN(endMs)) {
        return "—";
      }

      return formatRunTimeFromMs(Math.max(0, endMs - startMs));
    } catch {
      return "—";
    }
  };

  // Cache for reducing storage reads
  let storageCache = null;
  let cacheTimestamp = 0;
  const CACHE_DURATION = 5000; // 5 seconds cache

  // Load all workflows summary (no pagination - loads everything)
  const loadWorkflowsSummary = async (forceRefresh = false) => {
    try {
      // Fix any stuck workflows before loading (workflows with 'pending' status but all posts completed)
      await window.electronAPI.fixStuckWorkflows();

      // Refresh the set of workflows in use by Facebook Groups so the Delete
      // action can be disabled for them.
      try {
        const fbIdsRes = await window.electronAPI.fbGroupsGetImportedWorkflowIds();
        const fbIds = Array.isArray(fbIdsRes) ? fbIdsRes : (fbIdsRes?.data || []);
        fbGroupsWorkflowIds = new Set((fbIds || []).map((id) => String(id)));
      } catch (fbErr) {
        console.warn("Failed to load FB Groups workflow IDs:", fbErr?.message);
      }
      
      // Load all workflows by using a very large page size
      const result = await window.electronAPI.invoke(
        "get-workflows-summary",
        0,
        100000, // Load all workflows
      );
      if (result.success) {
        // CRITICAL: Before replacing allWorkflowsSummary, preserve terminal statuses
        const terminalStatuses = {};
        for (const wf of allWorkflowsSummary) {
          const wfId = wf.workflowId || wf.id;
          if (wf.status === 'completed' || wf.status === 'failed' || wf.status === 'stopped') {
            terminalStatuses[wfId] = { status: wf.status, progress: wf.progress };
          }
        }
        // Also check allWorkflows for terminal statuses
        for (const [wfId, wf] of Object.entries(allWorkflows)) {
          if (wf.status === 'completed' || wf.status === 'failed' || wf.status === 'stopped') {
            terminalStatuses[wfId] = { status: wf.status, progress: wf.progress };
          }
        }
        
        // CRITICAL: Also preserve "pending" status for workflows the queue manager says are running
        // This prevents UI from reverting to "queued" when DB update is slow or refresh races
        let runningWorkflowIds = [];
        try {
          const queueStatus = await window.electronAPI.getWorkflowQueueStatus();
          if (queueStatus && queueStatus.running) {
            runningWorkflowIds = queueStatus.running.map(id => String(id));
          }
        } catch (e) {
          console.warn('Failed to get queue status for pending preservation:', e.message);
        }
        
        allWorkflowsSummary = result.workflows;
        totalWorkflows = result.total;

        // Defensive fix: re-add any in-memory workflow that was not returned by the DB
        // query, preventing a workflow from temporarily disappearing during a refresh cycle.
        // (Handles race conditions where a workflow was just created or the DB lags.)
        // Safe because deleted workflows are removed from allWorkflows via `delete allWorkflows[id]`.
        for (const [wfId, wf] of Object.entries(allWorkflows)) {
          // Skip sentinel/non-workflow entries (e.g. _fetchAttempted_* keys with value `true`)
          if (!wf || typeof wf !== 'object' || !wf.workflowId) continue;
          if (!allWorkflowsSummary.some(s => s.workflowId === wfId)) {
            allWorkflowsSummary.push(wf);
            totalWorkflows++;
          }
        }
        
        // Restore terminal statuses to allWorkflowsSummary
        for (const wf of allWorkflowsSummary) {
          const wfId = wf.workflowId || wf.id;
          const wfIdStr = String(wfId);
          if (terminalStatuses[wfId]) {
            wf.status = terminalStatuses[wfId].status;
            wf.progress = terminalStatuses[wfId].progress;
          } else if (runningWorkflowIds.includes(wfIdStr)) {
            // CRITICAL: If queue manager says this workflow is running, force status to "pending"
            // This fixes the bug where DB shows "queued" but workflow is actually executing
            if (wf.status === 'queued') {
              console.log(`[Workflows] Correcting status for workflow ${wfId}: "queued" -> "pending" (in running set)`);
              wf.status = 'pending';
            }
          }
        }

        // Update allWorkflows cache with summary data (always preserve posts)
        for (const workflow of allWorkflowsSummary) {
          const existingWorkflow = allWorkflows[workflow.workflowId];
          const existingPosts = existingWorkflow?.posts || [];
          const wfIdStr = String(workflow.workflowId);
          
          // CRITICAL: Don't overwrite if existing status is 'completed' or 'failed'
          // This prevents the UI from reverting to 'pending' after a workflow completes
          // The in-memory cache is authoritative for completed workflows
          const shouldPreserveStatus = existingWorkflow && 
            (existingWorkflow.status === 'completed' || existingWorkflow.status === 'failed' || existingWorkflow.status === 'stopped');
          
          // Also force "pending" for running workflows if they still show "queued"
          const isRunningButShowsQueued = runningWorkflowIds.includes(wfIdStr) && workflow.status === 'queued';
          
          // Merge summary data with preserved posts and potentially preserved status
          allWorkflows[workflow.workflowId] = {
            ...workflow,
            posts: existingPosts,
            // Preserve the status if it's already terminal
            ...(shouldPreserveStatus ? { status: existingWorkflow.status, progress: existingWorkflow.progress } : {}),
            // Force pending for running workflows showing queued
            ...(isRunningButShowsQueued && !shouldPreserveStatus ? { status: 'pending' } : {}),
          };
        }

        // Sync to global cache for persistence across page navigations
        if (window.workflowCache) {
          window.workflowCache.allWorkflows = allWorkflows;
          window.workflowCache.allWorkflowsSummary = allWorkflowsSummary;
          window.workflowCache.totalWorkflows = totalWorkflows;
          window.workflowCache.lastUpdated = Date.now();
        }

        return allWorkflowsSummary;
      }
      return [];
    } catch (e) {
      console.error("Failed to load workflows summary:", e);
      return [];
    }
  };

  // Load full workflow details with posts (on-demand)
  // IMPORTANT: Merges with existing in-memory data to preserve real-time progress
  const loadWorkflowDetail = async (workflowId) => {
    try {
      const result = await window.electronAPI.invoke(
        "get-workflow-detail",
        workflowId,
      );
      if (result.success) {
        const existingWorkflow = allWorkflows[workflowId];
        const existingPosts = existingWorkflow?.posts || [];
        const newWorkflow = result.workflow;
        
        // If we have existing posts with progress data, merge rather than overwrite
        if (existingPosts.length > 0 && newWorkflow.posts) {
          // Create a map of existing posts by postId for quick lookup
          const existingPostsMap = new Map(
            existingPosts.map(p => [p.postId, p])
          );
          
          // Merge: prefer existing in-memory progress/nodes over DB data
          newWorkflow.posts = newWorkflow.posts.map(dbPost => {
            const memPost = existingPostsMap.get(dbPost.postId);
            if (memPost) {
              // Preserve in-memory progress and nodes if they exist
              return {
                ...dbPost,
                progress: typeof memPost.progress === 'number' ? memPost.progress : dbPost.progress,
                nodes: memPost.nodes?.length > 0 ? memPost.nodes : dbPost.nodes,
                // Keep DB status if it's terminal (completed/failed), otherwise use memory
                status: (dbPost.status === 'completed' || dbPost.status === 'failed') 
                  ? dbPost.status 
                  : (memPost.status || dbPost.status),
              };
            }
            return dbPost;
          });
        }
        
        allWorkflows[workflowId] = newWorkflow;
        return newWorkflow;
      }
      return null;
    } catch (e) {
      console.error(`Failed to load workflow ${workflowId}:`, e);
      return null;
    }
  };

  const safeGetWorkflows = async (forceRefresh = false) => {
    const now = Date.now();

    // Use cache if it's fresh and not forcing refresh
    if (
      !forceRefresh &&
      storageCache &&
      now - cacheTimestamp < CACHE_DURATION
    ) {
      return allWorkflows;
    }

    try {
      // Load all workflows summary (metadata only, no posts)
      await loadWorkflowsSummary(forceRefresh);

      // Also cache automations for display
      const automations = await window.electronAPI.readKey("automations");
      const pinterestAccounts = await window.electronAPI.readKey("pinterestAccounts");
      storageCache = { automations, pinterestAccounts: pinterestAccounts || {} };
      cacheTimestamp = now;

      // Restore scheduled pins cache from persistent storage on first load.
      // Discard entries older than 24 hours so stale counts never persist across days.
      const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
      if (Object.keys(window.scheduledPinsCache).length === 0) {
        const saved = await window.electronAPI.readKey("scheduledPinsCache");
        if (saved && typeof saved === "object") {
          const now = Date.now();
          const fresh = {};
          for (const [id, entry] of Object.entries(saved)) {
            if (entry && (now - (entry.fetchedAt || 0)) < CACHE_TTL_MS) {
              fresh[id] = entry;
            }
          }
          window.scheduledPinsCache = fresh;
        }
      }

      return allWorkflows;
    } catch (e) {
      console.error("readKey failed:", e);
      return allWorkflows;
    }
  };

  const getAutomationName = (automationId) => {
    if (!automationId) return "Unknown Automation";

    const automations = storageCache?.automations || {};
    const automation = Object.values(automations).find(
      (a) => a.id === automationId,
    );

    return automation?.label || `#${automationId}`;
  };

  /**
   * Check (synchronously from cache) if an automation has a Pinterest output node.
   * @param {string} automationId - The automation ID to check
   * @returns {boolean} - True if automation contains a pinterest or pinterest-output node
   */
  const automationHasPinterestNode = (automationId) => {
    if (!automationId) return false;
    const automations = storageCache?.automations || {};
    const automation = Object.values(automations).find((a) => a.id === automationId);
    if (!automation?.data?.drawflow?.Home?.data) return false;
    const pinterestNodeTypes = ["pinterest", "pinterest-output"];
    const nodes = automation.data.drawflow.Home.data;
    for (const nodeId in nodes) {
      if (pinterestNodeTypes.includes(nodes[nodeId]?.data?.type)) return true;
    }
    return false;
  };

  /**
   * Check if an automation contains a multi-output image generator node (Midjourney, Sora Image)
   * @param {string} automationId - The automation ID to check
   * @returns {Promise<boolean>} - True if automation has a multi-output image generator node
   */
  const automationHasMidjourneyNode = async (automationId) => {
    if (!automationId) return false;

    try {
      const automations =
        storageCache?.automations ||
        (await window.electronAPI.readKey("automations")) ||
        {};
      const automation = Object.values(automations).find(
        (a) => a.id === automationId,
      );

      if (!automation?.data?.drawflow?.Home?.data) return false;

      // Check for any multi-output image generator that requires user selection
      const imageGeneratorTypes = ["midjourney", "soraimage"];
      const nodes = automation.data.drawflow.Home.data;
      for (const nodeId in nodes) {
        if (imageGeneratorTypes.includes(nodes[nodeId]?.data?.type)) {
          return true;
        }
      }
      return false;
    } catch (e) {
      console.error("[Workflows] Error checking for image generator nodes:", e);
      return false;
    }
  };

  /**
   * Get the image generator node type used in an automation
   * @param {string} automationId - The automation ID to check
   * @returns {Promise<string|null>} - The image generator type (gptimage, chatgptimage, soraimage, midjourney) or null
   */
  const getAutomationImageGenerator = async (automationId) => {
    if (!automationId) return null;

    try {
      const automations =
        storageCache?.automations ||
        (await window.electronAPI.readKey("automations")) ||
        {};
      const automation = Object.values(automations).find(
        (a) => a.id === automationId,
      );

      if (!automation?.data?.drawflow?.Home?.data) return null;

      // Check for image generator node types
      const imageGeneratorTypes = ["gptimage", "chatgptimage", "soraimage", "midjourney"];
      const nodes = automation.data.drawflow.Home.data;
      for (const nodeId in nodes) {
        const nodeType = nodes[nodeId]?.data?.type;
        if (imageGeneratorTypes.includes(nodeType)) {
          return nodeType;
        }
      }
      return null;
    } catch (e) {
      console.error("[Workflows] Error detecting image generator:", e);
      return null;
    }
  };

  /**
   * Validate workflow pre-flight: check API keys, profiles, input connections
   * Shows a persistent modal with errors if validation fails
   * @param {string} automationId - The automation ID to validate
   * @param {Array} posts - The posts to be processed
   * @returns {Promise<boolean>} - True if validation passes, false otherwise
   */
  const validateWorkflowPreflight = async (automationId, posts) => {
    try {
      const result = await window.electronAPI.validateWorkflowPreflight(
        automationId,
        posts,
      );

      if (result.valid) {
        return true;
      }

      // Show validation errors modal
      showValidationErrorsModal(result.errors);
      return false;
    } catch (error) {
      console.error("[PreFlight] Validation error:", error);
      showAlert("error", `Validation error: ${error.message}`);
      return false;
    }
  };

  /**
   * Show persistent validation errors modal
   * @param {Array} errors - Array of validation error objects
   */
  const showValidationErrorsModal = (errors) => {
    // Remove existing modal if any
    $(".preflight-validation-modal").remove();

    // Group errors by type for better organization
    const errorsByType = {
      api_key: [],
      input_mismatch: [],
      pinterest: [],
      automation: [],
      system: [],
    };

    errors.forEach((err) => {
      const type = err.type || "system";
      if (errorsByType[type]) {
        errorsByType[type].push(err);
      } else {
        errorsByType.system.push(err);
      }
    });

    // Build error list HTML
    let errorsHtml = "";

    // API Key errors
    if (errorsByType.api_key.length > 0) {
      errorsHtml += `
        <div class="error-group">
          <div class="error-group-header">
            <i class="material-icons">key</i>
            <span>${window.I18n?.t("validation.missing_api_keys") || "Missing API Keys / Profiles"}</span>
          </div>
          <ul class="error-list">
            ${errorsByType.api_key
              .map(
                (err) => `
              <li class="error-item">
                <div class="error-node-type">${ucfirst(err.nodeType || "Unknown")}</div>
                <div class="error-message">${err.message}</div>
                ${
                  err.settingsPath
                    ? `<button class="btn btn-sm btn-outline-primary go-to-settings" data-path="${err.settingsPath}">
                    <i class="material-icons">settings</i>
                    ${window.I18n?.t("validation.go_to_settings") || "Go to Settings"}
                  </button>`
                    : ""
                }
              </li>
            `,
              )
              .join("")}
          </ul>
        </div>
      `;
    }

    // Input mismatch errors
    if (errorsByType.input_mismatch.length > 0) {
      errorsHtml += `
        <div class="error-group">
          <div class="error-group-header">
            <i class="material-icons">link_off</i>
            <span>${window.I18n?.t("validation.input_mismatch") || "Input Connection Issues"}</span>
          </div>
          <ul class="error-list">
            ${errorsByType.input_mismatch
              .map(
                (err) => `
              <li class="error-item">
                <div class="error-message">${err.message}</div>
              </li>
            `,
              )
              .join("")}
          </ul>
        </div>
      `;
    }

    // Pinterest errors
    if (errorsByType.pinterest.length > 0) {
      errorsHtml += `
        <div class="error-group">
          <div class="error-group-header">
            <i class="material-icons">account_circle</i>
            <span>${window.I18n?.t("validation.pinterest_config") || "Pinterest Configuration"}</span>
          </div>
          <ul class="error-list">
            ${errorsByType.pinterest
              .map(
                (err) => `
              <li class="error-item">
                <div class="error-message">${err.message}</div>
                ${
                  err.settingsPath
                    ? `<button class="btn btn-sm btn-outline-primary go-to-settings" data-path="${err.settingsPath}">
                    <i class="material-icons">manage_accounts</i>
                    ${window.I18n?.t("validation.manage_accounts") || "Manage Accounts"}
                  </button>`
                    : ""
                }
              </li>
            `,
              )
              .join("")}
          </ul>
        </div>
      `;
    }

    // Automation/System errors
    const otherErrors = [
      ...errorsByType.automation,
      ...errorsByType.system,
    ];
    if (otherErrors.length > 0) {
      errorsHtml += `
        <div class="error-group">
          <div class="error-group-header">
            <i class="material-icons">error_outline</i>
            <span>${window.I18n?.t("validation.other_issues") || "Other Issues"}</span>
          </div>
          <ul class="error-list">
            ${otherErrors
              .map(
                (err) => `
              <li class="error-item">
                <div class="error-message">${err.message}</div>
              </li>
            `,
              )
              .join("")}
          </ul>
        </div>
      `;
    }

    const modalHtml = `
      <div class="preflight-validation-modal">
        <div class="preflight-validation-content">
          <div class="preflight-header">
            <div class="preflight-icon">
              <i class="material-icons">warning</i>
            </div>
            <div class="preflight-title">
              <h3>${window.I18n?.t("validation.preflight_failed") || "Pre-flight Check Failed"}</h3>
              <p>${window.I18n?.t("validation.preflight_subtitle") || "Please fix the following issues before starting the workflow:"}</p>
            </div>
            <button class="preflight-close">
              <i class="material-icons">close</i>
            </button>
          </div>
          <div class="preflight-body">
            ${errorsHtml}
          </div>
          <div class="preflight-footer">
            <button class="btn btn-secondary preflight-dismiss">
              <i class="material-icons me-1">close</i>
              ${window.I18n?.t("common.close") || "Close"}
            </button>
          </div>
        </div>
      </div>
    `;

    // Add modal to body
    $("body").append(modalHtml);

    // Add styles if not already added
    if (!$("#preflight-validation-styles").length) {
      const styles = `
        <style id="preflight-validation-styles">
          .preflight-validation-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 100000;
            animation: fadeIn 0.2s ease;
          }
          
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          
          .preflight-validation-content {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow: hidden;
            box-shadow: var(--shadow-lg);
            display: flex;
            flex-direction: column;
            animation: slideUp 0.3s ease;
          }
          
          @keyframes slideUp {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          
          .preflight-header {
            display: flex;
            align-items: flex-start;
            gap: 16px;
            padding: 24px;
            border-bottom: 1px solid var(--border-color);
            background: var(--bg-primary);
          }
          
          .preflight-icon {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          
          .preflight-icon i {
            color: white;
            font-size: 24px;
          }
          
          .preflight-title {
            flex: 1;
          }
          
          .preflight-title h3 {
            margin: 0 0 4px 0;
            font-size: 18px;
            font-weight: 600;
            color: var(--text-primary);
          }
          
          .preflight-title p {
            margin: 0;
            font-size: 14px;
            color: var(--text-secondary);
          }
          
          .preflight-close {
            background: transparent;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            transition: all 0.2s;
          }
          
          .preflight-close:hover {
            background: var(--bg-tertiary);
            color: var(--text-primary);
          }
          
          .preflight-body {
            padding: 24px;
            overflow-y: auto;
            flex: 1;
            background: var(--bg-secondary);
          }
          
          .error-group {
            margin-bottom: 20px;
          }
          
          .error-group:last-child {
            margin-bottom: 0;
          }
          
          .error-group-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
            font-weight: 600;
            color: var(--text-primary);
          }
          
          .error-group-header i {
            font-size: 20px;
            color: #ff6b6b;
          }
          
          .error-list {
            list-style: none;
            padding: 0;
            margin: 0;
          }
          
          .error-item {
            background: var(--bg-tertiary);
            border-radius: 8px;
            padding: 12px 16px;
            margin-bottom: 8px;
            border-left: 3px solid #ff6b6b;
          }
          
          .error-item:last-child {
            margin-bottom: 0;
          }
          
          .error-node-type {
            font-weight: 600;
            font-size: 13px;
            color: var(--accent-color);
            margin-bottom: 4px;
          }
          
          .error-message {
            font-size: 14px;
            color: var(--text-primary);
            margin-bottom: 8px;
            line-height: 1.5;
          }
          
          .error-item .btn {
            font-size: 12px;
            padding: 4px 12px;
            background: var(--accent-color);
            color: #fff;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            transition: background 0.2s;
          }
          
          .error-item .btn:hover {
            background: var(--accent-hover);
          }
          
          .error-item .btn i {
            font-size: 14px;
          }
          
          .preflight-footer {
            padding: 16px 24px;
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            background: var(--bg-primary);
          }
          
          .preflight-footer .btn-secondary {
            background: var(--bg-tertiary);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 14px;
            transition: all 0.2s;
          }
          
          .preflight-footer .btn-secondary:hover {
            background: var(--bg-secondary);
          }
        </style>
      `;
      $("head").append(styles);
    }

    // Handle close button
    $(".preflight-validation-modal").on("click", ".preflight-close, .preflight-dismiss", function () {
      $(".preflight-validation-modal").remove();
    });

    // Handle clicking outside modal
    $(".preflight-validation-modal").on("click", function (e) {
      if (e.target === this) {
        $(this).remove();
      }
    });

    // Handle go to settings buttons
    $(".preflight-validation-modal").on("click", ".go-to-settings", function () {
      const path = $(this).data("path");
      $(".preflight-validation-modal").remove();
      
      // Navigate to the appropriate settings section
      if (path === "pinterest-accounts") {
        window.loadPage("pinterest-accounts");
      } else if (path === "minicanvas") {
        window.loadPage("minicanvas");
      } else if (path && path.startsWith("settings")) {
        window.loadPage("settings");
        // After a short delay, click on the relevant menu item
        // Format: "settings#section-name" where section-name matches for="section-name" in settings.html
        const section = path.split("#")[1];
        if (section) {
          setTimeout(() => {
            const $menuItem = $(`.menu-element[for="${section}"]`);
            if ($menuItem.length) {
              $menuItem.trigger("click");
            }
          }, 400);
        }
      } else if (path === "automation") {
        window.loadPage("automation");
      }
    });
  };

  const sortWorkflows = (wfObj) => {
    const arr = Object.entries(wfObj).map(([id, v]) => {
      const ts = Number.isFinite(Date.parse(v?.createdAt))
        ? Date.parse(v.createdAt)
        : 0;
      return [id, { ...v, _createdAtTs: ts }];
    });
    arr.sort((a, b) => {
      const ta = a[1]._createdAtTs;
      const tb = b[1]._createdAtTs;
      if (tb !== ta) return tb - ta;
      return b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0;
    });
    return arr;
  };

  // Pagination removed - all workflows are loaded at once

  // Update workflow queue status display
  async function updateQueueStatus() {
    // Skip during image processing to avoid slowdowns
    if (isImageProcessingMode) return;

    try {
      const queueStatus = await window.electronAPI.getWorkflowQueueStatus();
      const running = queueStatus.running.length;
      const queued = queueStatus.queued.length;
      const maxConcurrent = queueStatus.maxConcurrent;

      const $statusElement = $("#workflowQueueStatus");

      // Calculate posts/h from recent completion timestamps
      const postsPerHourText = getPostsPerHourText();
      const etaText = getEstimatedTimeLeft(queueStatus.running, queueStatus.queued);

      // Count post statuses across ALL workflows (not just running+queued)
      // For workflows with loaded posts (real-time), use posts array
      // For others, use DB summary counts (completedPosts, failedPosts, pendingPosts)
      let completedPosts = 0, failedPosts = 0, remainingPosts = 0;
      for (const wfId of Object.keys(allWorkflows)) {
        const wf = allWorkflows[wfId];
        if (!wf) continue;
        if (Array.isArray(wf.posts) && wf.posts.length > 0) {
          // Use real-time posts data if loaded
          for (const p of wf.posts) {
            if (p.status === "completed") completedPosts++;
            else if (p.status === "failed") failedPosts++;
            else remainingPosts++;
          }
        } else {
          // Fall back to DB summary aggregate counts
          completedPosts += Number(wf.completedPosts) || 0;
          failedPosts += Number(wf.failedPosts) || 0;
          remainingPosts += Number(wf.pendingPosts) || 0;
        }
      }

      if (running > 0 || queued > 0) {
        $("#queueRunningText").text(`${running} running`);
        $("#queueQueuedText").text(`${queued} queued`);
        $("#queueDoneText").text(window.I18n?.t("workflows.done_count", { count: completedPosts }) || `${completedPosts} done`);
        $("#queueFailedText").text(`${failedPosts} failed`);
        $("#queueLeftText").text(`${remainingPosts} left`);

        if (postsPerHourText) {
          $("#queueSpeedText").text(postsPerHourText);
          $("#queueSpeedItem").show();
        } else {
          $("#queueSpeedItem").hide();
        }

        if (etaText) {
          $("#queueEtaText").text(etaText);
          $("#queueEtaItem").show();
        } else {
          $("#queueEtaItem").hide();
        }

        $statusElement.show();
      } else {
        $statusElement.hide();
      }
    } catch (error) {
      console.warn("Failed to update queue status:", error);
      $("#workflowQueueStatus").hide();
    }
  }

  // Flag removed - no pagination

  // Force render function exposed globally for status change notifications
  window.forceWorkflowsRender = () => {
    // Invalidate the hash to force re-render
    lastWorkflowsHash = null;
    // Use forceImmediate to bypass throttle for instant UI updates
    renderWorkflows.forceImmediate();
  };

  // Force posts render function for immediate post completion updates
  window.forcePostsRender = (workflowId) => {
    if (workflowId) {
      renderPosts.forceImmediate(workflowId);
    }
  };

  function updateDeleteSelectedButton() {
    const checkedCount = selectedWorkflowIds.size;
    $(".bulk-action-bar")
      .toggleClass("is-active", checkedCount > 0)
      .attr("aria-hidden", checkedCount === 0 ? "true" : "false");

    if (checkedCount > 0) {
      $("#deleteSelectedWorkflows")
        .css("display", "flex")
        .find("span")
        .text(window.I18n?.t("workflows.delete_selected_count", { count: checkedCount }) || `Delete Selected (${checkedCount})`);

      // Count selected workflows whose automation has a Pinterest node and profiles are connected
      const _hasPinterestProfiles =
        Object.keys(storageCache?.pinterestAccounts || {}).length > 0;
      let workflowsWithPinterestPosts = 0;
      if (_hasPinterestProfiles) {
        for (const workflowId of selectedWorkflowIds) {
          const summaryWf = allWorkflowsSummary.find(
            (w) => (w.workflowId || w.id) === workflowId,
          );
          const automationId =
            summaryWf?.automationId || allWorkflows[workflowId]?.automationId;
          if (automationId && automationHasPinterestNode(automationId)) {
            workflowsWithPinterestPosts++;
          }
        }
      }

      if (workflowsWithPinterestPosts > 0) {
        $("#autoPublishSelectedWorkflows")
          .css("display", "flex")
          .find("span")
          .text(`Auto Publish (${workflowsWithPinterestPosts})`);
        $("#scheduledPinsSelectedWorkflows")
          .css("display", "flex")
          .find("span")
          .text(`Scheduled Pins (${workflowsWithPinterestPosts})`);
      } else {
        $("#autoPublishSelectedWorkflows").css("display", "none");
        $("#scheduledPinsSelectedWorkflows").css("display", "none");
      }

      // Show Remove Exported Mark only when at least one selected workflow is marked as exported
      let workflowsExported = 0;
      for (const workflowId of selectedWorkflowIds) {
        const summaryWf = allWorkflowsSummary.find(
          (w) => (w.workflowId || w.id) === workflowId,
        );
        if (summaryWf?.exported || allWorkflows[workflowId]?.exported) {
          workflowsExported++;
        }
      }
      if (workflowsExported > 0) {
        $("#removeExportedSelectedWorkflows")
          .css("display", "flex")
          .find("span")
          .text(`Remove Exported Mark (${workflowsExported})`);
      } else {
        $("#removeExportedSelectedWorkflows").css("display", "none");
      }

      // Show bulk CSV export only when multiple workflows are selected and all have Pinterest output
      if (checkedCount > 1 && workflowsWithPinterestPosts === checkedCount) {
        $("#bulkExportCsvSelectedWorkflows")
          .css("display", "flex")
          .find("span")
          .text(`Bulk export CSV (${checkedCount})`);
      } else {
        $("#bulkExportCsvSelectedWorkflows").css("display", "none");
      }
      
      // Count workflows that have any rerunnable posts (failed/pending or completed)
      let workflowsWithFailedPosts = 0;
      for (const workflowId of selectedWorkflowIds) {
        // Check summary data first (contains failedPosts and pendingPosts counts)
        const summaryWf = allWorkflowsSummary.find(
          (w) => (w.workflowId || w.id) === workflowId
        );
        if (summaryWf) {
          const failedCount = (summaryWf.failedPosts || 0) + (summaryWf.pendingPosts || 0);
          const completedCount = summaryWf.completedPosts || 0;
          if (failedCount > 0 || completedCount > 0) {
            workflowsWithFailedPosts++;
          }
        } else if (allWorkflows[workflowId]?.posts) {
          // Fallback to checking loaded posts
          const rerunnableCount = allWorkflows[workflowId].posts.filter(
            (p) =>
              p.status === "failed" ||
              p.status === "pending" ||
              p.status === "completed"
          ).length;
          if (rerunnableCount > 0) {
            workflowsWithFailedPosts++;
          }
        } else {
          // If we don't have data yet, count it as potentially having posts
          workflowsWithFailedPosts++;
        }
      }
      
      if (workflowsWithFailedPosts > 0) {
        $("#rerunSelectedWorkflows")
          .css("display", "flex")
          .find("span")
          .text(`Rerun (${workflowsWithFailedPosts})`);
      } else {
        // Hide the rerun button if no workflows have rerunnable posts
        $("#rerunSelectedWorkflows").css("display", "none");
      }

      // Count selected paused workflows
      let pausedWorkflowsCount = 0;
      for (const workflowId of selectedWorkflowIds) {
        const summaryWf = allWorkflowsSummary.find(
          (w) => (w.workflowId || w.id) === workflowId,
        );
        const status = summaryWf?.status || allWorkflows[workflowId]?.status;
        if (status === "paused") {
          pausedWorkflowsCount++;
        }
      }
      if (pausedWorkflowsCount > 0) {
        $("#startSelectedWorkflows")
          .css("display", "flex")
          .find("span")
          .text(`Start Selected (${pausedWorkflowsCount})`);
      } else {
        $("#startSelectedWorkflows").css("display", "none");
      }
    } else {
      $("#deleteSelectedWorkflows").css("display", "none");
      $("#rerunSelectedWorkflows").css("display", "none");
      $("#startSelectedWorkflows").css("display", "none");
      $("#autoPublishSelectedWorkflows").css("display", "none");
      $("#bulkExportCsvSelectedWorkflows").css("display", "none");
      $("#scheduledPinsSelectedWorkflows").css("display", "none");
      $("#removeExportedSelectedWorkflows").css("display", "none");
    }
  }

  function clearWorkflowSelection() {
    selectedWorkflowIds.clear();
    lastCheckedWorkflowIndex = null;
    $("#selectAllWorkflows").prop("checked", false);
    $(".workflow-checkbox").prop("checked", false);
    updateDeleteSelectedButton();
  }

  const renderWorkflows = throttle(() => {
    raf(() => {
      const $tableContainer = $("#workflowsTableContainer");
      const $tableBody = $("#workflowsTableBody");
      if (!$tableBody.length) return;

      // IMPORTANT: Skip re-rendering if a dropdown is open to prevent it from closing
      // This prevents the issue where the table re-render destroys the open dropdown
      if ($tableBody.find(".action-dropdown.open").length > 0) {
        return; // Skip this render cycle, will render on next cycle when dropdown is closed
      }

      // Update queue status
      updateQueueStatus();

      // Use allWorkflowsSummary (all workflows loaded at once)
      // Sort workflows by creation date
      const sorted = sortWorkflows(
        allWorkflowsSummary.reduce((acc, wf) => {
          acc[wf.workflowId] = allWorkflows[wf.workflowId] || wf;
          return acc;
        }, {}),
      );

      // Performance optimization: skip render if data hasn't changed
      const currentHash = hash(JSON.stringify({ sorted, totalWorkflows }));
      if (currentHash === lastWorkflowsHash) {
        return; // Skip rendering if nothing changed
      }
      lastWorkflowsHash = currentHash;

      const total = totalWorkflows;

      if (total === 0) {
        $("#emptyWorkflows").show();
        $tableContainer.hide();
        $("#workflowsPager").empty();
        $tableBody.empty();
        return;
      } else {
        $("#emptyWorkflows").hide();
        $tableContainer.show();
      }

      // Clear pager (no pagination)
      $("#workflowsPager").empty();

      // Rebuild the DOM every time to ensure correct ordering and fresh time-ago text.
      const frag = document.createDocumentFragment();

      for (const [workflowId, vl] of sorted) {
        // Calculate progress = finished posts / total posts.
        // Use in-memory post statuses (updated live via finalLogs) so it
        // doesn't rely on stale DB counters that only refresh on summary reload.
        const isTerminal = vl.status === "completed" || vl.status === "stopped" || vl.status === "failed";
        let progressValue;
        if (isTerminal) {
          progressValue = 100;
        } else if (Array.isArray(vl.posts) && vl.posts.length > 0) {
          const doneCount = vl.posts.filter(p => p.status === "completed" || p.status === "failed").length;
          progressValue = Math.round((doneCount / vl.posts.length) * 100);
        } else {
          const totalPostsForProgress = typeof vl.totalPosts === "number" ? vl.totalPosts : 0;
          const completedForProgress = typeof vl.completedPosts === "number" ? vl.completedPosts : 0;
          const failedForProgress = typeof vl.failedPosts === "number" ? vl.failedPosts : 0;
          progressValue = totalPostsForProgress > 0
            ? Math.round(((completedForProgress + failedForProgress) / totalPostsForProgress) * 100)
            : (Number.isFinite(vl.progress) ? vl.progress : 0);
        }

        // Check if this is a Pinterest workflow: automation must have a Pinterest node
        // AND the system must have at least one connected Pinterest profile.
        const hasPinterestProfiles =
          Object.keys(storageCache?.pinterestAccounts || {}).length > 0;
        const isPinterestWorkflow =
          hasPinterestProfiles && automationHasPinterestNode(vl.automationId);

        // Resolve Pinterest account info for the table cell
        // workflowPinterestAccountId comes from the DB summary subquery
        const wfPinterestAccountId =
          vl.workflowPinterestAccountId ||
          (vl.posts &&
            vl.posts.find((p) => p.pinterestAccountId)?.pinterestAccountId) ||
          null;
        let pinterestCellHtml = '<span class="text-muted">—</span>';
        if (isPinterestWorkflow && wfPinterestAccountId) {
          const cachedAccounts = storageCache?.pinterestAccounts || {};
          const accountEmail =
            cachedAccounts[wfPinterestAccountId]?.email || wfPinterestAccountId;
          const _cachedEntry = window.scheduledPinsCache[wfPinterestAccountId];
          const _cacheAge = _cachedEntry ? (Date.now() - (_cachedEntry.fetchedAt || 0)) : Infinity;
          const cached = (_cacheAge < 24 * 60 * 60 * 1000) ? _cachedEntry : null;
          const scheduledBadge = cached
            ? `<span class="sp-table-badge" title="Scheduled pins not yet posted">${cached.pendingCount} scheduled</span>`
            : "";
          pinterestCellHtml = `
            <div class="pinterest-cell">
              <span class="pinterest-email" title="${accountEmail}">${accountEmail.length > 22 ? accountEmail.substring(0, 19) + "…" : accountEmail}</span>
              ${scheduledBadge}
            </div>`;
        }

        // Check if workflow has any failed or pending posts to show rerun button
        const posts = Array.isArray(vl.posts) ? vl.posts : [];
        const hasFailedOrPendingPosts =
          posts.length > 0
            ? posts.some((p) => p.status === "failed" || p.status === "pending")
            : (vl.failedPosts || 0) + (vl.pendingPosts || 0) > 0;
        const hasCompletedPosts =
          posts.length > 0
            ? posts.some((p) => p.status === "completed")
            : (vl.completedPosts || 0) > 0;
        // The rerun action is available whenever there are failed/pending posts,
        // or completed posts that the user may choose to rerun.
        const canRerun = hasFailedOrPendingPosts || hasCompletedPosts;

        // Calculate post status counts
        const successCount =
          typeof vl.completedPosts === "number"
            ? vl.completedPosts
            : posts.filter((p) => p.status === "completed").length;
        const failedCount =
          typeof vl.failedPosts === "number"
            ? vl.failedPosts
            : posts.filter((p) => p.status === "failed").length;
        const pendingCount =
          typeof vl.pendingPosts === "number"
            ? vl.pendingPosts
            : posts.filter((p) => p.status === "pending" || !p.status).length;
        const totalPosts =
          typeof vl.totalPosts === "number" ? vl.totalPosts : posts.length;

        // Determine actual status based on post results (fixes incorrect stored status)
        // Only recalculate for finished workflows (not pending/queued)
        let actualStatus = vl.status;
        if (vl.status === "completed" || vl.status === "failed") {
          if (totalPosts > 0 && successCount === 0 && failedCount > 0) {
            // All posts failed - should be failed
            actualStatus = "failed";
          } else if (successCount > 0) {
            // At least one success - completed
            actualStatus = "completed";
          }
        }

        // Status badge
        const statusClass =
          actualStatus === "completed"
            ? "active"
            : actualStatus === "failed"
              ? "inactive"
              : actualStatus === "pending"
                ? "pending"
                : actualStatus === "paused"
                  ? "paused"
                  : "queued";
        const statusText =
          actualStatus === "pending"
            ? (window.I18n?.t("workflows.status.running") || "Running")
            : actualStatus === "paused"
              ? (window.I18n?.t("workflows.status.paused") || "Paused")
              : (window.I18n?.t(`workflows.status.${actualStatus}`) || ucfirst(actualStatus || "unknown"));

        // Action buttons based on status - now using dropdown menu
        let dropdownItems = "";

        // Delete button markup — disabled with a tooltip when the workflow is in
        // use by the Facebook Groups module (it must be removed there first).
        const isInFbGroups = fbGroupsWorkflowIds.has(String(workflowId));
        const deleteBtnHtml = isInFbGroups
          ? `<button class="action-dropdown-item item-danger is-disabled" data-role="deleteWorkflow" data-id="${workflowId}" aria-disabled="true" title="${window.I18n?.t("workflows.delete_blocked_fb_groups") || "This workflow is in use by Facebook Groups. Remove it from the Facebook Groups page before deleting it here."}">
                            <i class="material-icons">delete</i>
                            <span>${window.I18n?.t("workflows.actions.delete") || "Delete"}</span>
                            <i class="material-icons" style="margin-left:auto;font-size:16px;opacity:.7;">lock</i>
                        </button>`
          : `<button class="action-dropdown-item item-danger" data-role="deleteWorkflow" data-id="${workflowId}">
                            <i class="material-icons">delete</i>
                            <span>${window.I18n?.t("workflows.actions.delete") || "Delete"}</span>
                        </button>`;

        if (vl.status === "paused") {
          dropdownItems = `
                        <button class="action-dropdown-item item-success" data-role="startPausedWorkflow" data-id="${workflowId}">
                            <i class="material-icons">play_circle</i>
                            <span>${window.I18n?.t("workflows.dropdown.start_workflow") || "Start Workflow"}</span>
                        </button>
                        <div class="action-dropdown-divider"></div>
                        ${deleteBtnHtml}
                    `;
        } else if (vl.status === "pending") {
          dropdownItems = `
                        <button class="action-dropdown-item item-info" data-role="showProgress" data-id="${workflowId}">
                            <i class="material-icons">visibility</i>
                            <span>${window.I18n?.t("workflows.dropdown.show_progress") || "Show Progress"}</span>
                        </button>
                        <div class="action-dropdown-divider"></div>
                        <button class="action-dropdown-item item-danger" data-role="stopWorkflow" data-id="${workflowId}">
                            <i class="material-icons">stop</i>
                            <span>${window.I18n?.t("workflows.dropdown.stop_workflow") || "Stop Workflow"}</span>
                        </button>
                    `;
        } else if (vl.status === "queued") {
          dropdownItems = `
                        <button class="action-dropdown-item item-danger" data-role="stopWorkflow" data-id="${workflowId}">
                            <i class="material-icons">remove_from_queue</i>
                            <span>${window.I18n?.t("workflows.dropdown.remove_from_queue") || "Remove from Queue"}</span>
                        </button>
                    `;
        } else {
          dropdownItems = `
                        <button class="action-dropdown-item item-primary" data-role="openWorkflow" data-id="${workflowId}">
                            <i class="material-icons">play_circle</i>
                            <span>${window.I18n?.t("workflows.dropdown.open_workflow") || "Open Workflow"}</span>
                        </button>
                        <button class="action-dropdown-item item-info" data-role="showProgress" data-id="${workflowId}">
                            <i class="material-icons">visibility</i>
                            <span>${window.I18n?.t("workflows.dropdown.show_progress") || "Show Progress"}</span>
                        </button>
                        ${
                          isPinterestWorkflow && wfPinterestAccountId
                            ? `<button class="action-dropdown-item item-success" data-role="openWorkflowProfile" data-id="${workflowId}">
                            <i class="material-icons">open_in_new</i>
                            <span>${window.I18n?.t("workflows.dropdown.open_pinterest") || "Open Pinterest"}</span>
                        </button>
                        <button class="action-dropdown-item item-success" data-role="autoPublishPinterest" data-id="${workflowId}">
                            <i class="material-icons">cloud_upload</i>
                            <span data-i18n="workflows.auto_publish">Auto Publish</span>
                        </button>
                        <button class="action-dropdown-item item-info" data-role="scheduledPins" data-id="${workflowId}">
                            <i class="material-icons">schedule</i>
                            <span data-i18n="workflows.scheduled_pins">Scheduled Pins</span>
                        </button>`
                            : ""
                        }
                        ${
                          vl.exported
                            ? `<button class="action-dropdown-item item-secondary" data-role="removeExported" data-id="${workflowId}">
                            <i class="material-icons">remove_circle_outline</i>
                            <span>${window.I18n?.t("workflows.dropdown.remove_exported") || "Remove Exported Mark"}</span>
                        </button>`
                            : ""
                        }
                        ${
                          canRerun
                            ? `<button class="action-dropdown-item item-warning" data-role="rerunFailedWorkflow" data-id="${workflowId}">
                            <i class="material-icons">replay</i>
                            <span>${window.I18n?.t("workflows.dropdown.rerun_failed") || "Rerun"}</span>
                        </button>`
                            : ""
                        }
                        <div class="action-dropdown-divider"></div>
                        ${deleteBtnHtml}
                    `;
        }

        const actionButtons = `
                    <div class="action-dropdown">
                        <button class="action-dropdown-toggle" title="Actions">
                            <i class="material-icons">more_vert</i>
                        </button>
                        <div class="action-dropdown-menu">
                            ${dropdownItems}
                        </div>
                    </div>
                `;

        const row = document.createElement("tr");
        row.setAttribute("data-wf", workflowId);
        row.innerHTML = `
                    <td class="workflow-checkbox-cell">
                        <input type="checkbox" class="form-check-input workflow-checkbox" data-workflow-id="${workflowId}">
                    </td>
                    <td class="workflow-id">
                        <code>${workflowId}</code>
                    </td>
                    <td class="workflow-automation">
                        <div class="automation-info">
                            <i class="material-icons">precision_manufacturing</i>
                            <span>${getAutomationName(vl.automationId)}</span>
                        </div>
                        ${
                          vl.exported
                            ? `<div class="exported-badge">
                            <i class="material-icons">file_download</i>
                            <span>Exported</span>
                        </div>`
                            : ""
                        }
                    </td>
                    <td class="workflow-progress">
                        ${
                          vl.status === "pending"
                            ? `
                        <div class="progress-container">
                            <div class="progress-bar" style="width: ${progressValue}%"></div>
                            <span class="progress-text">${progressValue}%</span>
                        </div>
                        `
                            : '<span class="text-muted">—</span>'
                        }
                    </td>
                    <td class="workflow-posts">
                        ${
                          totalPosts > 0
                            ? `
                            <div class="posts-summary">
                                <span class="post-count success" title="${window.I18n?.t('workflows.status.completed') || 'Completed'}">${successCount}</span>
                                <span class="post-count failed" title="Failed">${failedCount}</span>
                                <span class="post-count pending" title="Pending">${pendingCount}</span>
                            </div>
                        `
                            : '<span class="text-muted">—</span>'
                        }
                    </td>
                    <td class="workflow-status">
                        <span class="status-badge status-${statusClass}">
                            ${vl.status === "pending" ? '<div class="status-spinner"></div>' : '<span class="status-dot"></span>'}
                            ${statusText}
                        </span>
                    </td>
                    <td class="workflow-pinterest">${pinterestCellHtml}</td>
                    <td class="workflow-date">${formatRunTime(vl.status, vl.executionStartedAt, vl.executionCompletedAt, vl.runtimeMs)}</td>
                    <td class="workflow-actions">
                        <div class="action-buttons">
                            ${actionButtons}
                        </div>
                    </td>
                `;
        frag.appendChild(row);
      }

      $tableBody.empty()[0].appendChild(frag);

      // Restore checkbox states from tracking Set after table rebuild
      if (selectedWorkflowIds.size > 0) {
        selectedWorkflowIds.forEach((workflowId) => {
          $tableBody
            .find(`.workflow-checkbox[data-workflow-id="${workflowId}"]`)
            .prop("checked", true);
        });
        // Update "select all" checkbox state
        const totalCheckboxes = $tableBody.find(".workflow-checkbox").length;
        const checkedCheckboxes = $tableBody.find(
          ".workflow-checkbox:checked",
        ).length;
        $("#selectAllWorkflows").prop(
          "checked",
          totalCheckboxes > 0 && totalCheckboxes === checkedCheckboxes,
        );
        updateDeleteSelectedButton();
      }
    });
  }, RENDER_THROTTLE_MS);

  const renderPosts = throttle((workflowId) => {
    raf(() => {
      const $tbody = $("#posts-progression tbody");
      if (!$tbody.length) return;
      const wf = allWorkflows[workflowId];
      if (!wf) return;
      const posts = Array.isArray(wf.posts) ? wf.posts : [];
      const page = postsPageByWorkflow.get(workflowId) || 0;
      const start = page * POSTS_PAGE_SIZE;
      const slice = posts.slice(start, start + POSTS_PAGE_SIZE);
      const totalPages = Math.max(1, Math.ceil(posts.length / POSTS_PAGE_SIZE));
      const $pager = $("#posts-progression .pagination");
      if ($pager.length) {
        const pagHtml = Array.from({ length: totalPages })
          .map(
            (_, i) =>
              `<button class="btn btn-sm ${i === page ? "btn-primary" : "btn-outline-primary"} me-1" data-role="postPage" data-id="${workflowId}" data-page="${i}">${i + 1}</button>`,
          )
          .join("");
        $pager.html(pagHtml);
      }
      const seen = new Set();
      for (const post of slice) {
        // Terminal post states should always show full completion in UI,
        // even if a stale persisted progress value is < 100.
        const progressValue =
          post.status === "completed" || post.status === "failed"
            ? 100
            : typeof post.progress === "number"
              ? post.progress
              : 0;
        const keyObj = {
          id: post.postId,
          progressValue,
          status: post.status,
          msg: (post.postMessage || "").slice(0, 60),
          img: !!post.postImg,
        };
        const h = hash(keyObj);
        seen.add(post.postId);
        const $existing = $tbody.find(`tr[data-id="${post.postId}"]`);
        if ($existing.length && postRowCache.get(post.postId) === h) continue;
        const statusHTML = (() => {
          if (post.status === "completed")
            return `<div class="d-flex justify-content-center align-items-center progress"><div class="status bg-success small me-1"></div><span>${window.I18n?.t("workflows.status.completed") || "Completed"}</span></div>`;
          if (post.status === "failed")
            return `<div class="d-flex justify-content-center align-items-center progress"><div class="status bg-danger small me-1"></div><span>${window.I18n?.t("workflows.status.failed") || "Failed"}</span></div>`;
          return `<div class="d-flex justify-content-center align-items-center progress"><div class="spinner-border small me-1"></div><span>${window.I18n?.t("workflows.status.pending") || "Pending"}</span></div>`;
        })();
        // Handle postImg - check if it's already an absolute path or just a filename
        const imgSrc = getImagePath(post.postImg);
        const imgHtml = imgSrc ? imgTag(imgSrc) : (window.I18n?.t("workflows.dropdown.no_image") || "No image");
        const msg = post.postMessage
          ? post.postMessage.length > 60
            ? post.postMessage.slice(0, 60) + "..."
            : post.postMessage
          : "";
        const hasNodes = post.nodes && post.nodes.length > 0;
        const logsBtn = hasNodes
          ? `<button data-role="showlogs" data-workflow="${workflowId}" data-id="${post.postId}" class="btn btn-primary"><i class="material-icons">browse_activity</i><span>${window.I18n?.t("workflows.dropdown.show_logs") || "Show logs"}</span></button>`
          : `<span class="text-muted">—</span>`;
        const row = `<tr data-id="${post.postId}"><td>${imgHtml}</td><td>${msg}</td><td>${logsBtn}</td><td>${progressBar(progressValue)}${statusHTML}</td></tr>`;
        if ($existing.length) $existing.replaceWith(row);
        else $tbody.append(row);
        postRowCache.set(post.postId, h);
      }
      $tbody.find("tr[data-id]").each(function () {
        const id = $(this).attr("data-id");
        if (!seen.has(id)) {
          $(this).remove();
          postRowCache.delete(id);
        }
      });
    });
  }, POSTS_PROGRESS_THROTTLE_MS);

  // Get icon for node type
  const getNodeIcon = (nodeType, status) => {
    if (status === "completed") return "check_circle";
    if (status === "failed") return "error";
    if (status === "processing") return "sync";
    if (status === "started") return "play_circle";

    // Default icons by node type
    const typeIcons = {
      input: "input",
      openai: "psychology",
      chatgptimage: "auto_awesome",
      chatgptchat: "chat",
      imageupload: "cloud_upload",
      uploadimage: "cloud_upload",
      uploadvideo: "cloud_upload",
      midjourneyv2: "brush",
      minicanvas: "palette",
      variables: "data_object",
      pinterest: "push_pin",
      "pinterest-output": "push_pin",
      facebook: "public",
      "facebook-output": "public",
      wordpress: "article",
      jsonparser: "code",
      curlrequest: "http",
      advancedcurl: "http",
      imagedownloader: "download",
      imagesearch: "image_search",
      amazoncrawl: "shopping_cart",
      amazonafflink: "link",
      googlesites: "language",
      googleai: "auto_awesome",
      googleaiimage: "auto_awesome",
      geminiimage: "auto_awesome",
      anthropic: "psychology",
      openrouter: "psychology",
      chineseai: "psychology",
      metaai: "psychology",
      metaaiimage: "auto_awesome",
      vcai: "psychology",
      texttospeech: "record_voice_over",
      serpapi: "search",
      googletrends: "trending_up",
      soraimage: "auto_awesome",
      soravideo: "videocam",
      videoeditor: "movie",
      videotoimage: "photo_camera",
      gptimage: "auto_awesome",
      facebookscraper: "content_copy",
      wprecipemaker: "restaurant",
      wordpressget: "article",
      security: "verified_user",
      workflow: "account_tree",
    };
    return typeIcons[nodeType?.toLowerCase()] || "settings";
  };

  // Format node type name for display
  const formatNodeType = (nodeType) => {
    if (!nodeType) return "Unknown";
    const typeNames = {
      input: "Input",
      openai: "OpenAI",
      chatgptimage: "ChatGPT Image",
      chatgptchat: "ChatGPT Chat",
      imageupload: "Image Upload",
      uploadimage: "Image Upload",
      uploadvideo: "Video Upload",
      midjourneyv2: "Midjourney",
      minicanvas: "Mini Canvas",
      variables: "Variables",
      pinterest: "Pinterest",
      "pinterest-output": "Pinterest Output",
      facebook: "Facebook",
      "facebook-output": "Facebook Output",
      wordpress: "WordPress",
      jsonparser: "JSON Parser",
      curlrequest: "HTTP Request",
      advancedcurl: "Advanced HTTP",
      imagedownloader: "Image Downloader",
      imagesearch: "Image Search",
      amazoncrawl: "Amazon Crawl",
      amazonafflink: "Amazon Affiliate",
      googlesites: "Google Sites",
      googleai: "Google AI",
      googleaiimage: "Google AI Image",
      geminiimage: "Gemini Image",
      anthropic: "Anthropic",
      openrouter: "OpenRouter",
      chineseai: "Chinese AI",
      metaai: "Meta AI",
      metaaiimage: "Meta AI Image",
      vcai: "VC AI",
      texttospeech: "Text to Speech",
      serpapi: "SERP API",
      googletrends: "Google Trends",
      soraimage: "Sora Image",
      soravideo: "Sora Video",
      videoeditor: "Video Editor",
      videotoimage: "Video to Image",
      gptimage: "GPT Image",
      facebookscraper: "Facebook Scraper",
      wprecipemaker: "WP Recipe Maker",
      wordpressget: "WordPress Get",
      security: "Security",
      workflow: "Workflow",
    };
    return typeNames[nodeType?.toLowerCase()] || nodeType;
  };

  // Translate backend-generated node messages that contain "Completed in Xms"
  const translateNodeMessage = (message) => {
    if (!message) return message;
    const t = (key, params) => window.I18n?.t(key, params) || null;
    // Match: "Completed in 1234ms" optionally followed by " (some detail)"
    const match = message.match(/^Completed in (\d+ms)(?: \((.+?)\))?$/);
    if (match) {
      const duration = match[1];
      const detail = match[2];
      const base = t("workflows.pipeline.completed_in", { duration }) || `Completed in ${duration}`;
      if (!detail) return base;
      // Translate known detail suffixes
      const detailMap = {
        "skip mode": t("workflows.pipeline.detail_skip_mode") || "skip mode",
        "auto-preference": t("workflows.pipeline.detail_auto_preference") || "auto-preference",
        "user selection": t("workflows.pipeline.detail_user_selection") || "user selection",
        "single image": t("workflows.pipeline.detail_single_image") || "single image",
        "workflow preference": t("workflows.pipeline.detail_workflow_preference") || "workflow preference",
      };
      // Handle dynamic detail like "3 video(s)"
      const videoMatch = detail.match(/^(\d+) video\(s\)$/);
      if (videoMatch) {
        const translated = t("workflows.pipeline.detail_videos", { count: videoMatch[1] }) || detail;
        return `${base} (${translated})`;
      }
      const translatedDetail = detailMap[detail] || detail;
      return `${base} (${translatedDetail})`;
    }
    return message;
  };

  const renderNodes = throttle((workflowId, postId) => {
    raf(() => {
      const $pipeline = $("#nodesPipeline");
      if (!$pipeline.length) return;

      // Only render if this matches current view to prevent cross-contamination
      if (currentWorkflowView !== workflowId || currentPostView !== postId)
        return;

      const wf = allWorkflows[workflowId];
      if (!wf) return;
      const post = (wf.posts || []).find((p) => p.postId === postId);
      if (!post || !Array.isArray(post.nodes) || post.nodes.length === 0) {
        $pipeline.html(`
                    <div class="nodes-empty-state">
                        <div class="empty-icon">
                            <i class="material-icons">hourglass_empty</i>
                        </div>
                        <h3>Waiting for nodes...</h3>
                        <p>Node execution will appear here as they process</p>
                    </div>
                `);
        return;
      }

      // Filter out informational log entries, synthetic unknowns, and malformed nodes
      const validNodes = post.nodes.filter((n) => {
        if (n.nodeId == null) return false;
        if (String(n.nodeId) === "undefined") return false;
        // Skip informational event logs (node-info, node-warning, output-generated)
        if (n.event && ["node-info", "node-warning", "output-generated"].includes(n.event)) return false;
        // Skip nodes with no nodeType unless they are known synthetic nodes
        if (!n.nodeType && n.nodeId !== "security" && n.nodeId !== "workflow") return false;
        return true;
      });

      if (validNodes.length === 0) {
        $pipeline.html(`
                    <div class="nodes-empty-state">
                        <div class="empty-icon">
                            <i class="material-icons">hourglass_empty</i>
                        </div>
                        <h3>Waiting for nodes...</h3>
                        <p>Node execution will appear here as they process</p>
                    </div>
                `);
        return;
      }

      // Sort nodes by execution (arrival) order: Security/Input pinned at top,
      // remaining nodes keep the order they were inserted into the array
      // (which matches actual execution order from the backend graph traversal).
      const sortedNodes = [...validNodes].sort((a, b) => {
        const typeA = (a.nodeType || "").toLowerCase();
        const typeB = (b.nodeType || "").toLowerCase();
        const idA = String(a.nodeId || "");
        const idB = String(b.nodeId || "");

        const orderA = (typeA === "security" || idA === "security") ? 0
                     : (typeA === "input") ? 1
                     : (typeA === "workflow" || idA === "workflow") ? 9999
                     : 2; // all other nodes share the same priority tier
        const orderB = (typeB === "security" || idB === "security") ? 0
                     : (typeB === "input") ? 1
                     : (typeB === "workflow" || idB === "workflow") ? 9999
                     : 2;

        if (orderA !== orderB) return orderA - orderB;
        // Within the same tier, preserve original array index (execution order)
        return validNodes.indexOf(a) - validNodes.indexOf(b);
      });

      // Calculate stats
      const completedCount = sortedNodes.filter(
        (n) => n.status === "completed",
      ).length;
      const processingCount = sortedNodes.filter(
        (n) => n.status === "processing" || n.status === "started",
      ).length;

      // Check if structure already exists - if so, update in place
      const $existingContainer = $pipeline.find(".nodes-container");
      const $nodesContainer = $pipeline.closest(".nodes");

      // Check if user is scrolled near the bottom before updates
      // Use the .nodes container which is the scrollable element
      let isNearBottom = false;
      if ($nodesContainer.length > 0) {
        const el = $nodesContainer[0];
        isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      }

      if ($existingContainer.length > 0) {
        // Update stats without rebuilding
        $pipeline
          .find(".pipeline-stat.completed span")
          .text(`${completedCount} ${window.I18n?.t("workflows.pipeline.completed") || "Completed"}`);
        $pipeline
          .find(".pipeline-stat.processing span")
          .text(`${processingCount} ${window.I18n?.t("workflows.pipeline.processing") || "Processing"}`);

        // Update or add individual node cards
        let addedNew = false;
        sortedNodes.forEach((node, index) => {
          const status = node.status || "pending";
          const icon = getNodeIcon(node.nodeType, status);
          const typeName = formatNodeType(node.nodeType);
          const message = translateNodeMessage(node.message) || (window.I18n?.t("workflows.pipeline.waiting") || "Waiting...");
          const truncatedMessage =
            message.length > 80 ? message.substring(0, 80) + "..." : message;

          const $existingCard = $existingContainer.find(
            `.node-card[data-id="${node.nodeId}"]`,
          );

          if ($existingCard.length > 0) {
            // Update existing card - only update changed parts
            const currentStatus = $existingCard
              .attr("class")
              .split(" ")
              .find((c) =>
                [
                  "pending",
                  "started",
                  "processing",
                  "completed",
                  "failed",
                  "error",
                ].includes(c),
              );

            if (currentStatus !== status) {
              $existingCard
                .removeClass(
                  "pending started processing completed failed error",
                )
                .addClass(status);
              $existingCard
                .find(".node-status-indicator .material-icons")
                .text(icon);
              $existingCard.find(".node-status-badge").text(window.I18n?.t(`workflows.status.${status}`) || status);
            }

            // Update message if changed
            const $msgEl = $existingCard.find(".node-message");
            if ($msgEl.text() !== truncatedMessage) {
              $msgEl.text(truncatedMessage);
            }
          } else {
            // Add new node card
            addedNew = true;
            const newCardHtml = `
                            <div class="node-card ${status}" data-id="${node.nodeId}">
                                <div class="node-status-indicator">
                                    <i class="material-icons">${icon}</i>
                                </div>
                                <div class="node-content">
                                    <div class="node-header">
                                        <span class="node-id">#${node.nodeId}</span>
                                        <span class="node-name">${typeName}</span>
                                    </div>
                                    <div class="node-message">${truncatedMessage}</div>
                                </div>
                                <div class="node-status-badge">${window.I18n?.t(`workflows.status.${status}`) || status}</div>
                            </div>
                        `;
            $existingContainer.append(newCardHtml);
          }
        });

        // Remove stale cards that no longer belong to this post's nodes
        const currentNodeIds = new Set(sortedNodes.map((n) => String(n.nodeId)));
        $existingContainer.find(".node-card[data-id]").each(function () {
          if (!currentNodeIds.has($(this).attr("data-id"))) {
            $(this).remove();
          }
        });

        // Auto-scroll to bottom if user was near bottom and new nodes were added
        if (addedNew && isNearBottom && $nodesContainer.length > 0) {
          setTimeout(() => {
            const el = $nodesContainer[0];
            el.scrollTop = el.scrollHeight;
          }, 100);
        }
      } else {
        // Initial render - build full HTML
        let html = `
                    <div class="nodes-pipeline-header">
                        <div class="nodes-pipeline-title">
                            <i class="material-icons">account_tree</i>
                            <span>${window.I18n?.t("workflows.pipeline.title") || "Execution Pipeline"}</span>
                        </div>
                        <div class="nodes-pipeline-stats">
                            <div class="pipeline-stat completed">
                                <i class="material-icons" style="font-size: 16px;">check_circle</i>
                                <span>${completedCount} ${window.I18n?.t("workflows.pipeline.completed") || "Completed"}</span>
                            </div>
                            <div class="pipeline-stat processing">
                                <i class="material-icons" style="font-size: 16px;">sync</i>
                                <span>${processingCount} ${window.I18n?.t("workflows.pipeline.processing") || "Processing"}</span>
                            </div>
                        </div>
                    </div>
                    <div class="nodes-container">
                `;

        sortedNodes.forEach((node, index) => {
          const status = node.status || "pending";
          const icon = getNodeIcon(node.nodeType, status);
          const typeName = formatNodeType(node.nodeType);
          const message = translateNodeMessage(node.message) || (window.I18n?.t("workflows.pipeline.waiting") || "Waiting...");
          const truncatedMessage =
            message.length > 80 ? message.substring(0, 80) + "..." : message;

          html += `
                        <div class="node-card ${status}" data-id="${node.nodeId}" style="animation-delay: ${index * 0.05}s">
                            <div class="node-status-indicator">
                                <i class="material-icons">${icon}</i>
                            </div>
                            <div class="node-content">
                                <div class="node-header">
                                    <span class="node-id">#${node.nodeId}</span>
                                    <span class="node-name">${typeName}</span>
                                </div>
                                <div class="node-message">${truncatedMessage}</div>
                            </div>
                            <div class="node-status-badge">${window.I18n?.t(`workflows.status.${status}`) || status}</div>
                        </div>
                    `;
        });

        html += "</div>";
        $pipeline.html(html);
      }
    });
  }, 120);

  // Phase transition overlay function
  function showPhaseTransition(fromPhase, toPhase) {
    return new Promise((resolve) => {
      const phases = {
        cropping: { icon: '<i class="material-icons">crop</i>', name: "Cropping", step: 1 },
        inpainting: { icon: '<i class="material-icons">brush</i>', name: "Inpainting", step: 2 },
        complete: { icon: '<i class="material-icons">check_circle</i>', name: "Complete", step: 3 },
      };

      const from = phases[fromPhase];
      const to = phases[toPhase];

      const overlay = document.createElement("div");
      overlay.className = "phase-transition-overlay";
      overlay.innerHTML = `
                <div class="phase-icon">${to.icon}</div>
                <div class="phase-title">${fromPhase === "start" ? "Starting" : "Moving to"} ${to.name}</div>
                <div class="phase-subtitle">${fromPhase === "start" ? "Preparing your images..." : `${from?.name || "Previous step"} completed successfully!`}</div>
                <div class="phase-progress">
                    ${
                      fromPhase !== "start"
                        ? `
                        <div class="phase-step completed">
                            <span>${from?.icon || '<i class="material-icons">check</i>'}</span>
                            <span>${from?.name || "Previous"}</span>
                        </div>
                        <span class="phase-arrow material-icons">arrow_forward</span>
                    `
                        : ""
                    }
                    <div class="phase-step active">
                        <span>${to.icon}</span>
                        <span>${to.name}</span>
                    </div>
                    ${
                      to.step < 3
                        ? `
                        <span class="phase-arrow material-icons">arrow_forward</span>
                        <div class="phase-step pending">
                            <span>${phases[toPhase === "cropping" ? "inpainting" : "complete"].icon}</span>
                            <span>${phases[toPhase === "cropping" ? "inpainting" : "complete"].name}</span>
                        </div>
                    `
                        : ""
                    }
                </div>
            `;

      document.body.appendChild(overlay);

      // Auto dismiss after 1.5 seconds
      setTimeout(() => {
        overlay.style.animation = "fadeOut 0.3s ease";
        setTimeout(() => {
          if (overlay.parentNode) {
            document.body.removeChild(overlay);
          }
          resolve();
        }, 300);
      }, 1500);
    });
  }

  async function cropImagesSequentially(imageNames) {
    // Pause background intervals during cropping for better performance
    pauseBackgroundIntervals();

    const $imgEl = $("#cropperImage");
    const $confirmBtn = $("#confirmCrop");
    const $skipBtn = $("#skipCrop");
    const $prevBtn = $("#prevCrop");
    const $stepIndicator = $("#cropperStepIndicator");
    const $modalEl = $("#cropperModal");
    const modal = new bootstrap.Modal($modalEl[0], {
      backdrop: "static",
      keyboard: false,
    });
    const results = [];
    const totalImages = imageNames.length;

    let currentIndex = 0;

    while (currentIndex < imageNames.length) {
      const imageName = imageNames[currentIndex];
      const imageNumber = currentIndex + 1;

      // Update step indicator
      $stepIndicator.text(
        `Cropping: Image ${imageNumber} of ${totalImages}`,
      );

      // Show/hide Previous button based on index
      if (currentIndex > 0) {
        $prevBtn.show();
      } else {
        $prevBtn.hide();
      }

      const result = await new Promise((resolve) => {
        let cropper = null;
        let modalHiddenResolve = null;

        $confirmBtn.off(WF_NAMESPACE);
        $skipBtn.off(WF_NAMESPACE);
        $prevBtn.off(WF_NAMESPACE);
        $modalEl.off(WF_NAMESPACE);
        $imgEl.off(WF_NAMESPACE);

        $modalEl.one("hidden.bs.modal" + WF_NAMESPACE, () => {
          if (cropper) {
            cropper.destroy();
            cropper = null;
          }
          if (modalHiddenResolve) modalHiddenResolve();
        });

        window.electronAPI.getUserDataPath().then((userDataPath) => {
          // Handle both full paths (from FB Insights) and just filenames
          const imgSrc =
            imageName.includes(":") || imageName.startsWith("/")
              ? `file://${imageName}`
              : `file://${userDataPath}/Images/${imageName}`;
          $imgEl.attr("src", imgSrc);

          $imgEl
            .one("load" + WF_NAMESPACE, function () {
              $modalEl.one("shown.bs.modal" + WF_NAMESPACE, function () {
                if (cropper) cropper.destroy();
                cropper = new Cropper($imgEl[0], {
                  aspectRatio: NaN,
                  viewMode: 2, // Restrict crop box within canvas
                  autoCropArea: 1,
                  responsive: true,
                  background: true,
                  zoomable: false, // Disable zooming completely
                  zoomOnWheel: false, // Disable mouse wheel zoom
                  zoomOnTouch: false, // Disable touch zoom
                  minContainerWidth: 300,
                  minContainerHeight: 300,
                  initialAspectRatio: NaN,
                  guides: true,
                  center: true,
                  highlight: true,
                  cropBoxMovable: true,
                  cropBoxResizable: true,
                  toggleDragModeOnDblclick: false,
                });
              });
            })
            .one("error" + WF_NAMESPACE, () =>
              resolve({ action: "next", result: imageName }),
            );

          modal.show();

          $confirmBtn.one("click" + WF_NAMESPACE, async function () {
            if (!cropper) {
              modal.hide();
              return;
            }
            const canvas = cropper.getCroppedCanvas();
            if (!canvas) {
              modal.hide();
              return;
            }
            const blob = await new Promise((r) => canvas.toBlob(r));
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            const newName = await window.electronAPI.saveImage(
              imageName,
              uint8Array,
            );
            await new Promise((resolve) => {
              modalHiddenResolve = resolve;
              modal.hide();
            });
            resolve({ action: "next", result: newName });
          });

          $skipBtn.one("click" + WF_NAMESPACE, function () {
            new Promise((resolve) => {
              modalHiddenResolve = resolve;
              modal.hide();
            }).then(() => resolve({ action: "next", result: imageName }));
          });

          $prevBtn.one("click" + WF_NAMESPACE, function () {
            new Promise((resolve) => {
              modalHiddenResolve = resolve;
              modal.hide();
            }).then(() => resolve({ action: "prev", result: null }));
          });
        });
      });

      if (result.action === "prev") {
        // Go back to previous image
        if (currentIndex > 0) {
          currentIndex--;
          results.pop(); // Remove the last result since we're going back
        }
      } else {
        // Move to next image
        results.push(result.result);
        currentIndex++;
      }
    }

    // Resume background intervals after cropping completes
    resumeBackgroundIntervals();
    return results;
  }

  async function inpaintImagesSequentially(imageNames) {
    // Pause background intervals during inpainting for better performance
    pauseBackgroundIntervals();

    const $imgEl = $("#inpaintImage");
    const $maskCanvas = $("#inpaintMaskCanvas");
    const $modalEl = $("#inpaintModal");
    const $confirmBtn = $("#confirmInpaint");
    const $skipBtn = $("#skipInpaint");
    const $prevBtn = $("#prevInpaint");
    const $stepIndicator = $("#inpaintStepIndicator");
    const modal = new bootstrap.Modal($modalEl[0], {
      backdrop: "static",
      keyboard: false,
    });
    const results = [];
    const totalImages = imageNames.length;

    // Persist draw mode across all images in the sequence
    let drawMode = "brush"; // 'brush' or 'rectangle'

    let currentIndex = 0;

    while (currentIndex < imageNames.length) {
      const imageName = imageNames[currentIndex];
      const imageNumber = currentIndex + 1;

      // Update step indicator
      $stepIndicator.text(
        `Inpainting: Image ${imageNumber} of ${totalImages}`,
      );

      // Show/hide Previous button based on index
      if (currentIndex > 0) {
        $prevBtn.show();
      } else {
        $prevBtn.hide();
      }

      const result = await new Promise((resolve) => {
        let maskCtx = null;
        let isDrawing = false;
        let modalHiddenResolve = null;
        let rafId = null; // For throttling drawing
        let pendingDrawPoint = null; // Store pending draw coordinates
        let rectangleStart = null; // Starting point for rectangle drag
        let currentRect = null; // Current rectangle being drawn

        // Clear all previous event listeners
        $modalEl.off(WF_NAMESPACE);
        $imgEl.off(WF_NAMESPACE);
        $confirmBtn.off(WF_NAMESPACE);
        $skipBtn.off(WF_NAMESPACE);
        $prevBtn.off(WF_NAMESPACE);
        $("#finishInpaint").off(WF_NAMESPACE);
        $("#inpaintClearMask, #inpaintBrushSize, #inpaintDrawMode").off(
          WF_NAMESPACE,
        );
        $maskCanvas.off(WF_NAMESPACE);

        // Modal cleanup on hide
        $modalEl.one("hidden.bs.modal" + WF_NAMESPACE, () => {
          if (modalHiddenResolve) modalHiddenResolve();
          if (rafId) cancelAnimationFrame(rafId);
        });

        let maskPaths = []; // Store drawn mask paths for binary mask generation

        const setupMaskCanvas = () => {
          const canvas = $maskCanvas[0];
          const img = $imgEl[0];

          console.log(`=== CANVAS SETUP DEBUG ===`);
          console.log(
            `Image natural dimensions: ${img.naturalWidth}x${img.naturalHeight}`,
          );
          console.log(
            `Image display dimensions: ${img.clientWidth}x${img.clientHeight}`,
          );
          console.log(`Image offset: ${img.offsetLeft}, ${img.offsetTop}`);

          // ISSUE: We're setting canvas size to natural image size, but this creates huge canvases!
          // Let's match the display size instead for easier coordinate mapping
          canvas.width = img.clientWidth;
          canvas.height = img.clientHeight;

          // Display canvas at the same size as the displayed image
          canvas.style.width = img.clientWidth + "px";
          canvas.style.height = img.clientHeight + "px";
          canvas.style.left = img.offsetLeft + "px";
          canvas.style.top = img.offsetTop + "px";

          maskCtx = canvas.getContext("2d", { willReadFrequently: true });

          // Set transparent background
          maskCtx.clearRect(0, 0, canvas.width, canvas.height);

          // Use solid red for visual feedback
          maskCtx.fillStyle = "rgb(255, 0, 0)"; // Solid red, fully opaque
          maskCtx.lineCap = "round";
          maskCtx.lineJoin = "round";

          // Since canvas size now matches display size, no scaling needed
          canvas.scaleX = 1.0;
          canvas.scaleY = 1.0;

          // Clear mask paths for new session
          maskPaths = [];

          console.log(
            `Canvas actual dimensions: ${canvas.width}x${canvas.height}`,
          );
          console.log(
            `Canvas style dimensions: ${canvas.style.width} x ${canvas.style.height}`,
          );
          console.log(`Scale factors: ${canvas.scaleX}x${canvas.scaleY}`);
          console.log(`=== CANVAS SETUP COMPLETE ===`);
        };

        const generateBinaryMask = () => {
          console.log(`Generating binary mask with ${maskPaths.length} paths`);

          if (maskPaths.length === 0) {
            console.log(`No paths found, returning null`);
            return null;
          }

          const img = $imgEl[0];
          const displayCanvas = $maskCanvas[0];

          // Create binary mask at original image resolution for API
          const binaryCanvas = document.createElement("canvas");
          binaryCanvas.width = img.naturalWidth;
          binaryCanvas.height = img.naturalHeight;
          const binaryCtx = binaryCanvas.getContext("2d");

          console.log(`=== BINARY MASK GENERATION ===`);
          console.log(
            `Display canvas dimensions: ${displayCanvas.width}x${displayCanvas.height}`,
          );
          console.log(
            `Binary canvas dimensions: ${binaryCanvas.width}x${binaryCanvas.height}`,
          );
          console.log(
            `Image natural dimensions: ${img.naturalWidth}x${img.naturalHeight}`,
          );

          // Calculate scaling factors from display to original size
          const scaleToOriginalX = img.naturalWidth / displayCanvas.width;
          const scaleToOriginalY = img.naturalHeight / displayCanvas.height;

          console.log(
            `Scaling factors to original: ${scaleToOriginalX.toFixed(2)}x${scaleToOriginalY.toFixed(2)}`,
          );

          // Start with fully transparent background
          binaryCtx.clearRect(0, 0, binaryCanvas.width, binaryCanvas.height);

          // Set composite operation to ensure proper drawing
          binaryCtx.globalCompositeOperation = "source-over";
          binaryCtx.globalAlpha = 1.0;

          // First, calculate bounding box of all mask areas (both circles and rectangles)
          let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;

          for (const path of maskPaths) {
            if (path.type === "circle") {
              const scaledX = path.x * scaleToOriginalX;
              const scaledY = path.y * scaleToOriginalY;
              const scaledRadius =
                path.radius * Math.min(scaleToOriginalX, scaleToOriginalY);

              minX = Math.min(minX, scaledX - scaledRadius);
              minY = Math.min(minY, scaledY - scaledRadius);
              maxX = Math.max(maxX, scaledX + scaledRadius);
              maxY = Math.max(maxY, scaledY + scaledRadius);
            } else if (path.type === "rectangle") {
              const scaledX = path.x * scaleToOriginalX;
              const scaledY = path.y * scaleToOriginalY;
              const scaledWidth = path.width * scaleToOriginalX;
              const scaledHeight = path.height * scaleToOriginalY;

              minX = Math.min(minX, scaledX);
              minY = Math.min(minY, scaledY);
              maxX = Math.max(maxX, scaledX + scaledWidth);
              maxY = Math.max(maxY, scaledY + scaledHeight);
            }
          }

          // Add padding around the mask areas
          const padding = 50;
          const rectX = Math.max(0, minX - padding);
          const rectY = Math.max(0, minY - padding);
          const rectWidth = Math.min(
            binaryCanvas.width - rectX,
            maxX - minX + 2 * padding,
          );
          const rectHeight = Math.min(
            binaryCanvas.height - rectY,
            maxY - minY + 2 * padding,
          );

          console.log(
            `Mask bounding box: (${minX.toFixed(1)}, ${minY.toFixed(1)}) to (${maxX.toFixed(1)}, ${maxY.toFixed(1)})`,
          );
          console.log(
            `Green rectangle: (${rectX.toFixed(1)}, ${rectY.toFixed(1)}) size: ${rectWidth.toFixed(1)}x${rectHeight.toFixed(1)}`,
          );

          // Draw green rectangle background first
          binaryCtx.fillStyle = "#00FF00"; // Green rectangle
          binaryCtx.fillRect(rectX, rectY, rectWidth, rectHeight);

          // Draw red mask areas on top (both circles and rectangles)
          binaryCtx.fillStyle = "#FF0000"; // Solid red mask areas

          for (const path of maskPaths) {
            if (path.type === "circle") {
              // Scale coordinates from display size to original image size
              const scaledX = path.x * scaleToOriginalX;
              const scaledY = path.y * scaleToOriginalY;
              const scaledRadius =
                path.radius * Math.min(scaleToOriginalX, scaleToOriginalY);

              console.log(
                `Drawing circle: Display(${path.x.toFixed(1)}, ${path.y.toFixed(1)}, r=${path.radius.toFixed(1)}) -> Original(${scaledX.toFixed(1)}, ${scaledY.toFixed(1)}, r=${scaledRadius.toFixed(1)})`,
              );

              binaryCtx.beginPath();
              binaryCtx.arc(scaledX, scaledY, scaledRadius, 0, Math.PI * 2);
              binaryCtx.fill();
            } else if (path.type === "rectangle") {
              // Scale rectangle from display size to original image size
              const scaledX = path.x * scaleToOriginalX;
              const scaledY = path.y * scaleToOriginalY;
              const scaledWidth = path.width * scaleToOriginalX;
              const scaledHeight = path.height * scaleToOriginalY;

              console.log(
                `Drawing rectangle: Display(${path.x.toFixed(1)}, ${path.y.toFixed(1)}, ${path.width.toFixed(1)}x${path.height.toFixed(1)}) -> Original(${scaledX.toFixed(1)}, ${scaledY.toFixed(1)}, ${scaledWidth.toFixed(1)}x${scaledHeight.toFixed(1)})`,
              );

              binaryCtx.fillRect(scaledX, scaledY, scaledWidth, scaledHeight);
            }
          }

          const dataUrl = binaryCanvas.toDataURL("image/png");
          console.log(
            `Generated binary mask data URL length: ${dataUrl.length}`,
          );

          // Debug: Check if the canvas has red and green pixels
          const imageData = binaryCtx.getImageData(
            0,
            0,
            binaryCanvas.width,
            binaryCanvas.height,
          );
          let redPixelCount = 0;
          let greenPixelCount = 0;
          for (let i = 0; i < imageData.data.length; i += 4) {
            const r = imageData.data[i];
            const g = imageData.data[i + 1];
            const b = imageData.data[i + 2];
            const a = imageData.data[i + 3];

            if (r === 255 && g === 0 && b === 0 && a === 255) {
              redPixelCount++; // Red mask pixels
            } else if (r === 0 && g === 255 && b === 0 && a === 255) {
              greenPixelCount++; // Green rectangle pixels
            }
          }
          console.log(
            `Binary mask has ${redPixelCount} red pixels and ${greenPixelCount} green pixels out of ${imageData.data.length / 4} total pixels`,
          );
          console.log(`=== BINARY MASK COMPLETE ===`);

          return dataUrl;
        };

        // Initialize image loading
        window.electronAPI.getUserDataPath().then((userDataPath) => {
          // Handle both full paths (from FB Insights) and just filenames
          const imgSrc =
            imageName.includes(":") || imageName.startsWith("/")
              ? `file://${imageName}`
              : `file://${userDataPath}/Images/${imageName}`;
          $imgEl.attr("src", imgSrc);

          $imgEl
            .one("load" + WF_NAMESPACE, function () {
              $modalEl.one("shown.bs.modal" + WF_NAMESPACE, function () {
                setupMaskCanvas();
                // Hide finish button initially
                $("#finishInpaint").hide();
              });
            })
            .one("error" + WF_NAMESPACE, () => resolve(imageName));

          modal.show();

          let currentImageName = imageName;

          // Inpainting functionality
          $confirmBtn.on("click" + WF_NAMESPACE, async function () {
            if (!maskCtx) return;

            const $scanner = $("#inpaintScanner");

            try {
              // Check if there are any mask paths drawn
              if (maskPaths.length === 0) {
                showAlert(
                  "info",
                  "Please draw a mask on the areas you want to inpaint.",
                );
                return;
              }

              // Generate binary mask for API
              const maskDataUrl = generateBinaryMask();

              if (!maskDataUrl) {
                showAlert(
                  "info",
                  "No mask drawn. Please draw a mask on the areas you want to inpaint.",
                );
                return;
              }

              // Debug logging
              console.log(`Mask paths count: ${maskPaths.length}`);
              console.log(
                `Generated binary mask data URL length: ${maskDataUrl.length} characters`,
              );
              console.log(
                `Mask canvas dimensions: ${$maskCanvas[0].width}x${$maskCanvas[0].height}`,
              );
              console.log(`Binary mask preview: ${maskDataUrl}...`);

              if (maskDataUrl.length < 100) {
                showAlert(
                  "error",
                  "Failed to generate proper mask. Please try drawing again.",
                );
                return;
              }

              // Show loading state and scanner animation
              $(this).prop("disabled", true).text("Processing...");
              $scanner.addClass("active");

              console.log(
                `Sending inpaint request for image: ${currentImageName}`,
              );
              const result = await window.electronAPI.inpaintImage(
                currentImageName,
                maskDataUrl,
              );

              if (result.success) {
                // Update current image name to the inpainted result
                currentImageName = result.inpaintedImageName;

                // Clear the mask
                maskCtx.clearRect(
                  0,
                  0,
                  $maskCanvas[0].width,
                  $maskCanvas[0].height,
                );
                maskPaths = []; // Clear stored paths

                // Load the new inpainted image
                const userDataPath = await window.electronAPI.getUserDataPath();
                // Handle both full paths and just filenames
                const inpaintedImgSrc =
                  currentImageName.includes(":") ||
                  currentImageName.startsWith("/")
                    ? `file://${currentImageName}?t=${Date.now()}`
                    : `file://${userDataPath}/Images/${currentImageName}?t=${Date.now()}`;
                $imgEl.attr("src", inpaintedImgSrc);

                $imgEl.one(
                  "load" + WF_NAMESPACE,
                  function () {
                    setupMaskCanvas();

                    // Show the "Finish Inpainting" button after first successful inpaint
                    $("#finishInpaint").show();

                    // Show success message
                    showAlert(
                      "success",
                      "Inpainting completed! You can now draw new masks to continue inpainting or click 'Finish Inpainting' when done.",
                    );
                  }.bind(this),
                );

                // Hide scanner animation and reset button
                $scanner.removeClass("active");
                $(this).prop("disabled", false).text("Apply Inpainting");
              } else {
                console.error("Inpainting failed:", result.error);
                showAlert("error", "Inpainting failed: " + result.error);
                $scanner.removeClass("active");
                $(this).prop("disabled", false).text("Apply Inpainting");
              }
            } catch (error) {
              console.error("Error during inpainting:", error);
              showAlert("error", "Error during inpainting: " + error.message);
              $scanner.removeClass("active");
              $(this).prop("disabled", false).text("Apply Inpainting");
            }
          });

          $skipBtn.one("click" + WF_NAMESPACE, function () {
            new Promise((resolve) => {
              modalHiddenResolve = resolve;
              modal.hide();
            }).then(() =>
              resolve({ action: "next", result: currentImageName }),
            );
          });

          $("#finishInpaint").one("click" + WF_NAMESPACE, function () {
            new Promise((resolve) => {
              modalHiddenResolve = resolve;
              modal.hide();
            }).then(() =>
              resolve({ action: "next", result: currentImageName }),
            );
          });

          $prevBtn.one("click" + WF_NAMESPACE, function () {
            new Promise((resolve) => {
              modalHiddenResolve = resolve;
              modal.hide();
            }).then(() => resolve({ action: "prev", result: null }));
          });

          // Mask drawing functionality
          $("#inpaintClearMask").on("click" + WF_NAMESPACE, function () {
            if (maskCtx) {
              maskCtx.clearRect(
                0,
                0,
                $maskCanvas[0].width,
                $maskCanvas[0].height,
              );
              maskPaths = []; // Clear stored paths too
            }
          });

          $("#inpaintBrushSize").on("input" + WF_NAMESPACE, function () {
            const size = $(this).val();
            $("#inpaintBrushSizeLabel").text(size + "px");
          });

          // Draw mode toggle
          $("#inpaintDrawMode").on("change" + WF_NAMESPACE, function () {
            drawMode = $(this).val();
            console.log(`Draw mode changed to: ${drawMode}`);
          });

          // Helper function to draw mask point (used by both mousedown and throttled mousemove)
          const drawMaskPoint = (x, y, brushRadius) => {
            // Add bounds checking
            const canvas = $maskCanvas[0];
            if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) {
              return;
            }

            // Add to mask paths for binary mask generation with type identifier
            maskPaths.push({ type: "circle", x, y, radius: brushRadius });

            // Draw visual feedback immediately
            maskCtx.beginPath();
            maskCtx.arc(x, y, brushRadius, 0, Math.PI * 2);
            maskCtx.fill();
          };

          // Helper function to redraw canvas with current mask and temporary rectangle
          const redrawCanvas = () => {
            const canvas = $maskCanvas[0];
            maskCtx.clearRect(0, 0, canvas.width, canvas.height);

            // Redraw all existing mask paths (both circles and rectangles)
            for (const path of maskPaths) {
              if (path.type === "circle") {
                maskCtx.beginPath();
                maskCtx.arc(path.x, path.y, path.radius, 0, Math.PI * 2);
                maskCtx.fill();
              } else if (path.type === "rectangle") {
                maskCtx.fillRect(path.x, path.y, path.width, path.height);
              }
            }

            // Draw current rectangle if dragging
            if (currentRect) {
              maskCtx.fillRect(
                currentRect.x,
                currentRect.y,
                currentRect.width,
                currentRect.height,
              );
            }
          };

          // Mouse events for drawing
          $maskCanvas.on("mousedown" + WF_NAMESPACE, function (e) {
            if (!maskCtx) return;
            isDrawing = true;
            const rect = this.getBoundingClientRect();
            const displayX = e.clientX - rect.left;
            const displayY = e.clientY - rect.top;

            // Since canvas size now matches display size, coordinates are 1:1
            const x = displayX;
            const y = displayY;

            if (drawMode === "brush") {
              const brushRadius = parseInt($("#inpaintBrushSize").val()) / 2;
              drawMaskPoint(x, y, brushRadius);
            } else if (drawMode === "rectangle") {
              // Start rectangle drag
              rectangleStart = { x, y };
              currentRect = null;
            }
          });

          $maskCanvas.on("mousemove" + WF_NAMESPACE, function (e) {
            if (!isDrawing || !maskCtx) return;

            const rect = this.getBoundingClientRect();
            const displayX = e.clientX - rect.left;
            const displayY = e.clientY - rect.top;

            // Since canvas size now matches display size, coordinates are 1:1
            const x = displayX;
            const y = displayY;

            if (drawMode === "brush") {
              const brushRadius = parseInt($("#inpaintBrushSize").val()) / 2;

              // Store pending draw point
              pendingDrawPoint = { x, y, brushRadius };

              // Use RAF to throttle drawing for better performance
              if (!rafId) {
                rafId = requestAnimationFrame(() => {
                  if (pendingDrawPoint && isDrawing) {
                    drawMaskPoint(
                      pendingDrawPoint.x,
                      pendingDrawPoint.y,
                      pendingDrawPoint.brushRadius,
                    );
                    pendingDrawPoint = null;
                  }
                  rafId = null;
                });
              }
            } else if (drawMode === "rectangle" && rectangleStart) {
              // Update current rectangle
              const width = x - rectangleStart.x;
              const height = y - rectangleStart.y;

              currentRect = {
                x: width < 0 ? x : rectangleStart.x,
                y: height < 0 ? y : rectangleStart.y,
                width: Math.abs(width),
                height: Math.abs(height),
              };

              // Redraw with current rectangle
              redrawCanvas();
            }
          });

          $maskCanvas.on("mouseup" + WF_NAMESPACE, function () {
            if (drawMode === "rectangle" && rectangleStart && currentRect) {
              // Store rectangle as a solid rectangle object
              maskPaths.push({
                type: "rectangle",
                x: currentRect.x,
                y: currentRect.y,
                width: currentRect.width,
                height: currentRect.height,
              });

              console.log(
                `Added rectangle: (${currentRect.x.toFixed(1)}, ${currentRect.y.toFixed(1)}) size: ${currentRect.width.toFixed(1)}x${currentRect.height.toFixed(1)}`,
              );

              // Clear temporary rectangle and redraw
              currentRect = null;
              rectangleStart = null;
              redrawCanvas();
            }

            isDrawing = false;
            pendingDrawPoint = null;
            if (rafId) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }
          });

          // Also handle mouseleave to stop drawing when mouse leaves canvas
          $maskCanvas.on("mouseleave" + WF_NAMESPACE, function () {
            if (drawMode === "rectangle" && currentRect) {
              // Finalize rectangle on mouse leave
              maskPaths.push({
                type: "rectangle",
                x: currentRect.x,
                y: currentRect.y,
                width: currentRect.width,
                height: currentRect.height,
              });

              currentRect = null;
              rectangleStart = null;
              redrawCanvas();
            }

            isDrawing = false;
            pendingDrawPoint = null;
            if (rafId) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }
          });
        });
      });

      if (result.action === "prev") {
        // Go back to previous image
        if (currentIndex > 0) {
          currentIndex--;
          results.pop(); // Remove the last result since we're going back
        }
      } else {
        // Move to next image
        results.push(result.result);
        currentIndex++;
      }
    }

    // Resume background intervals after inpainting completes
    resumeBackgroundIntervals();
    return results;
  }

  async function showLogs(workflowId) {
    // Check if we need to load workflow details from DB
    const existingWorkflow = allWorkflows[workflowId];
    const existingPosts = existingWorkflow?.posts || [];
    
    // Only fetch from DB if we don't have posts data yet
    // For running workflows, we rely on real-time IPC events for progress
    if (existingPosts.length === 0) {
      const workflow = await loadWorkflowDetail(workflowId);
      if (!workflow) {
        console.error(`Failed to load workflow ${workflowId}`);
        return;
      }
    }

    currentWorkflowView = workflowId;
    $(".workflow-preview, .workflow-preview #posts-progression").show();
    $("body").addClass("posts-view-active");
    // Use forceImmediate for instant rendering when user clicks showProgress
    renderPosts.forceImmediate(workflowId);
  }

  function resetLogsView() {
    $(".workflow-preview #posts-progression").show();
    $("#workflows-container .workflow-preview .nodes").hide();
    $("body").removeClass("nodes-view-active");
    currentPostView = null;
    inLogs = false;
  }

  function openNodes(workflowId, postId) {
    currentPostView = postId;
    currentWorkflowView = workflowId;
    inLogs = true;
    $(".workflow-preview #posts-progression").hide();
    $("#workflows-container .workflow-preview .nodes").show();
    $("body").addClass("nodes-view-active");
    $("#nodesTable tbody").empty();
    $("#nodesPipeline").empty(); // Clear pipeline to prevent stale cards from previous post
    nodeRowCache.clear();
    renderNodes.forceImmediate(workflowId, postId);
  }

  function setMode(id) {
    currentMode = id;
    const $buttons = $("[data-role='changeMode'] button");
    // Update active state for the new styled mode selector
    $buttons.removeClass("active btn-primary btn-outline-primary");
    $buttons.filter(`[data-id='${id}']`).addClass("active");
    $("[data-section]").hide();
    $(`[data-section='${id}']`).show();
    $('#posts-gallery input[type="checkbox"]').prop("checked", false);
    $("#previewCount").text("0");
    $("#startAutomation").attr("disabled", "");
    $('[data-role="customTitles"] .text').remove();
    $('[data-role="pinterestTitles"] .pinterest-title-item').remove();

    // Show/hide filters based on mode (visible in spy and smartsplit modes)
    if (id === "spy" || id === "smartsplit") {
      $(".workflow-filters").show();
    } else {
      $(".workflow-filters").hide();
    }

    // Reset category filter and sort when switching modes
    $("#spy-category-filter").val("");
    $("#spy-sort-by").val("newest");
    // Clear custom mode image when switching modes
    customModeImage = null;
    $("#customModeImage").val("");
    $("#customModeImagePreview").hide();
    $("#customModeImagePreview img").attr("src", "");

    // Clear custom mode Pinterest state
    customModePinterestAccountId = null;
    customModePinterestBoardId = null;
    $("#customModePinterestEnabled").prop("checked", false);
    $("#customModePinterestBody").hide();
    $("#customModePinterestAccount").html('<option value="">Select Account</option>');
    $("#customModePinterestBoard").html('<option value="">Select Board</option>').prop("disabled", true);

    // Clear Pinterest mode state when switching modes
    $("#workflowPinterestAccount").val("");
    $("#workflowPinterestBoard").val("").prop("disabled", true);
    $("#availablePinterestTitles").html(`
            <div class="text-muted text-center py-3">
                <i class="material-icons">title</i><br>
                Select account and board to see available titles
            </div>
        `);
    $("#selectAllTitles").text("Select All");
    $("#loadPinterestTitles").prop("disabled", true);
    $('[data-role="pinterestTitles"]').html(`
            <div class="text-muted text-center py-3">
                <i class="material-icons">checklist</i><br>
                No titles selected
            </div>
        `);

    // Load Pinterest data if switching to Pinterest mode
    if (id === "pinterest") {
      console.log("Switching to Pinterest mode, loading accounts...");
      // Add a small delay to ensure DOM elements are ready
      setTimeout(() => {
        loadPinterestAccountsForWorkflow();
      }, 100);
    }

    // Reset FB Insights mode state when switching modes
    if (id === "fbinsights") {
      resetFbInsightsState();
    } else {
      // Clear FB Insights state when leaving the mode
      fbInsightsCsvData = null;
      fbInsightsProcessedPosts = [];
      fbInsightsCurrentStep = 1;
    }

    // Reset ISE mode state when switching modes
    if (id === "ise") {
      resetIseState();
    } else {
      // Clear ISE state when leaving the mode
      iseSearchResults = [];
      iseSelectedImages.clear();
      iseIsSearching = false;
    }

    // Reset Google Trends mode state when switching modes
    if (id === "gtrends") {
      resetGtrendsState();
    } else {
      // Clear Google Trends state when leaving the mode
      gtrendsFetchedTopics = [];
      gtrendsSelectedTopics.clear();
      gtrendsIsFetching = false;
    }

    // Reset Pinterest Feed Spy state when switching modes
    if (id === "pfeedspy") {
      resetPfeedSpyState();
      // Load persisted used pin IDs
      window.electronAPI.pfeedSpyGetUsed().then((res) => {
        pfeedspyUsedIds = new Set((res.ids || []).map(String));
      }).catch(() => { pfeedspyUsedIds = new Set(); });
      // Populate account dropdowns (scraping + publish)
      window.electronAPI.readKey("pinterestAccounts").then((accounts) => {
        const $sel = $("#pfeedspyAccountId");
        $sel.find("option:not(:first)").remove();
        const $pub = $("#pfeedspyPublishAccount");
        $pub.html('<option value="">No account (disabled)</option>');
        const entries = Object.entries(accounts || {}).filter(
          ([id, acc]) => acc && typeof acc === "object" && (acc.email || acc.linkedStructureId),
        );
        if (entries.length === 0) {
          $sel.append(`<option value="" disabled>${window.I18n?.t("workflows.pfeedspy.no_accounts") || "No accounts connected"}</option>`);
        } else {
          for (const [id, acc] of entries) {
            const label = acc.email || acc.username || acc.name || id;
            $sel.append(`<option value="${id}">${label}</option>`);
            if (acc.email) $pub.append(`<option value="${id}">${escapeHtml(acc.email)}</option>`);
          }
        }
      }).catch(() => {});
    } else {
      // Stop if running and clear state when leaving the mode
      if (pfeedspyIsRunning) pfeedspyStopRequested = true;
      pfeedspyAllPins = [];
      pfeedspyIsRunning = false;
    }

    // Load Smart Split providers and posts when switching to smartsplit mode
    if (id === "smartsplit") {
      loadSmartSplitProviders();
      // Populate category dropdown then load posts
      window.electronAPI.getLibraryCategories().then((categoriesResult) => {
        const categories = categoriesResult?.categories || [];
        const $categoryFilter = $("#spy-category-filter");
        $categoryFilter.empty();
        $categoryFilter.append('<option value="">All Categories</option>');
        $categoryFilter.append('<option value="__uncategorized__">Uncategorized</option>');
        categories.forEach((cat) => {
          $categoryFilter.append(`<option value="${cat.id}">${cat.name}</option>`);
        });
        loadSmartSplitPosts();
      }).catch(() => loadSmartSplitPosts());
    } else {
      resetSmartSplitState();
    }

    // Reset Generate mode state when switching modes
    if (id === "generate") {
      $("#generatePostCount").val(1);
      $("#generateModeWarning").hide();
      $("#previewCount").text("1");
      $("#startAutomation").removeAttr("disabled");
      checkGenerateModeInputWarning();
    }
  }

  // ========== Generate Mode Helper Functions ==========

  /**
   * Check if the current automation uses input node connections
   * and show a warning in Generate mode if it does.
   */
  async function checkGenerateModeInputWarning() {
    if (!currentAutomationId) return;
    try {
      const automations =
        storageCache?.automations ||
        (await window.electronAPI.readKey("automations")) ||
        {};
      const automation = Object.values(automations).find(
        (a) => a.id === currentAutomationId,
      );
      if (!automation?.data?.drawflow?.Home?.data) return;

      const nodes = automation.data.drawflow.Home.data;
      let hasInputConnections = false;
      for (const nodeId in nodes) {
        const node = nodes[nodeId];
        if (node.data?.type === "input" && node.outputs) {
          const out1 = node.outputs.output_1?.connections?.length > 0;
          const out2 = node.outputs.output_2?.connections?.length > 0;
          if (out1 || out2) {
            hasInputConnections = true;
          }
          break;
        }
      }

      if (hasInputConnections) {
        $("#generateModeWarning").show();
      } else {
        $("#generateModeWarning").hide();
      }
    } catch (e) {
      console.error("[Generate] Error checking input connections:", e);
    }
  }

  // ========== Smart Split Helper Functions ==========

  // Smart Split state
  let smartSplitAnalysisResults = []; // Array of { post, items: [{description}] }
  let smartSplitIsAnalyzing = false;

  async function loadSmartSplitProviders() {
    const $select = $("#smartsplitProvider");

    const [openaiKeys, anthropicKeys, googleaiKeys, openrouterKeys, chineseaiKeys] = await Promise.all([
      window.electronAPI.readKey("openaiKeys"),
      window.electronAPI.readKey("anthropicKeys"),
      window.electronAPI.readKey("googleaiKeys"),
      window.electronAPI.readKey("openrouterKeys"),
      window.electronAPI.readKey("chineseaiKeys"),
    ]);

    const providers = [];
    if (Object.keys(openaiKeys || {}).length > 0) providers.push({ value: "openai", label: "OpenAI" });
    if (Object.keys(anthropicKeys || {}).length > 0) providers.push({ value: "anthropic", label: "Anthropic (Claude)" });
    if (Object.keys(googleaiKeys || {}).length > 0) providers.push({ value: "googleai", label: "Google AI (Gemini)" });
    if (Object.keys(openrouterKeys || {}).length > 0) providers.push({ value: "openrouter", label: "OpenRouter" });
    if (Object.keys(chineseaiKeys || {}).length > 0) providers.push({ value: "chineseai", label: "Chinese AI" });

    $select.empty();
    $select.append(`<option value="">${window.I18n?.t("workflows.smart_split.select_provider") || "-- Select AI Provider --"}</option>`);
    providers.forEach(p => {
      $select.append(`<option value="${p.value}">${p.label}</option>`);
    });
  }

  async function loadSmartSplitPosts() {
    let posts = (await window.electronAPI.readKey("postsLibrary")) || [];

    // Filter out used posts if toggle is checked
    const hideUsed = $("#hide-used-workflow-posts").is(":checked");
    if (hideUsed) {
      posts = posts.filter((p) => !p.usedAt);
    }

    // Filter by category if selected
    const selectedCategory = $("#spy-category-filter").val();
    if (selectedCategory === "__uncategorized__") {
      posts = posts.filter((p) => !p.categoryId);
    } else if (selectedCategory) {
      posts = posts.filter((p) => p.categoryId === selectedCategory);
    }

    // Sort posts by selected criteria
    posts = applySortOrder(posts, $("#spy-sort-by").val() || "newest");

    const $tbody = $("#smartsplit-table tbody");
    $tbody.empty();

    if (posts.length === 0) {
      $tbody.html(`
        <tr>
          <td colspan="5" class="text-center py-5">
            <div style="color: #94a3b8;">
              <i class="material-icons" style="font-size: 48px; display: block; margin-bottom: 8px;">visibility_off</i>
              ${window.I18n?.t("workflows.spy_empty.title") || "No Spy Posts Yet"}
            </div>
          </td>
        </tr>
      `);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const data of posts) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-id", data.postId);
      const postImgPath = getImagePath(data.postImg);
      const usedBadge = data.usedAt
        ? `<span class="badge bg-warning text-dark ms-2">Used</span>`
        : "";

      tr.innerHTML = `
        <td><input class="form-check-input" type="checkbox"></td>
        <td>
          <div class="d-flex flex-direction-center align-items-center">
            <img src="assets/images/icons/${data.type}-colored.png" class="sm me-1">
            <span>${ucfirst(data.type)}${usedBadge}</span>
          </div>
        </td>
        <td>
          <a href="${postImgPath}" data-title="${maxStr(data.postMessage, 25)}" data-lightbox="preview">
            <img loading="lazy" src="${postImgPath}">
          </a>
        </td>
        <td>
          <div class="stats">
            ${data.views != null ? `<div class="stat"><i class="material-icons">visibility</i><span>${formatNumber(data.views)}</span></div>` : ""}
            ${data.shares != null ? `<div class="stat"><i class="material-icons">share</i><span>${formatNumber(data.shares)}</span></div>` : ""}
            ${data.comments != null ? `<div class="stat"><i class="material-icons">mode_comment</i><span>${formatNumber(data.comments)}</span></div>` : ""}
            ${data.repins != null ? `<div class="stat"><i class="material-icons">moved_location</i><span>${formatNumber(data.repins)}</span></div>` : ""}
            ${data.reactions != null ? `<div class="stat"><i class="material-icons">thumb_up</i><span>${formatNumber(data.reactions)}</span></div>` : ""}
          </div>
        </td>
        <td>${maxStr(data.postMessage, 25)}</td>
      `;
      frag.appendChild(tr);
    }
    $tbody[0].appendChild(frag);
  }

  function updateSmartSplitSelectedCount() {
    const count = $('#smartsplit-table tbody input[type="checkbox"]:checked').length;
    $("#smartsplitSelectedCount").text(count);
    const hasProvider = !!$("#smartsplitProvider").val();
    $("#smartsplitAnalyzeBtn").prop("disabled", count === 0 || !hasProvider || smartSplitIsAnalyzing);
  }

  async function analyzeSmartSplitPosts() {
    const provider = $("#smartsplitProvider").val();
    if (!provider) {
      showAlert("error", window.I18n?.t("workflows.smart_split.select_provider_error") || "Please select an AI provider");
      return;
    }

    // Collect selected post IDs
    const selectedIds = [];
    $('#smartsplit-table tbody input[type="checkbox"]:checked').each(function () {
      selectedIds.push($(this).closest("tr").attr("data-id"));
    });

    if (selectedIds.length === 0) {
      showAlert("error", window.I18n?.t("workflows.smart_split.no_selection") || "Please select at least one post");
      return;
    }

    const postsLib = (await window.electronAPI.readKey("postsLibrary")) || [];
    const selectedPosts = postsLib.filter(p => selectedIds.includes(p.postId));

    if (selectedPosts.length === 0) return;

    smartSplitIsAnalyzing = true;
    smartSplitAnalysisResults = [];
    $("#smartsplitAnalyzeBtn").prop("disabled", true);

    // Show progress overlay
    const $overlay = $(`
      <div class="smartsplit-progress-overlay" id="smartsplitProgressOverlay">
        <div class="smartsplit-progress-modal">
          <div class="smartsplit-progress-spinner"></div>
          <h5>${window.I18n?.t("workflows.smart_split.analyzing") || "Analyzing posts..."}</h5>
          <p id="smartsplitProgressText" style="color: var(--text-secondary, #6c757d); font-size: 13px; margin: 8px 0 0;">
            0 / ${selectedPosts.length}
          </p>
        </div>
      </div>
    `);
    $("body").append($overlay);

    let completed = 0;

    for (const post of selectedPosts) {
      const imagePath = getImagePath(post.postImg);

      try {
        const result = await window.electronAPI.analyzePostContent({
          imagePath,
          postText: post.postMessage || "",
          aiProvider: provider,
        });

        if (result.success && result.items && result.items.length > 0) {
          smartSplitAnalysisResults.push({
            post,
            items: result.items,
          });
        } else {
          // Single item fallback — use post message as description
          smartSplitAnalysisResults.push({
            post,
            items: [{ description: post.postMessage || "Untitled" }],
            error: result.error,
          });
        }
      } catch (err) {
        console.error("[Smart Split] Analysis error:", err);
        smartSplitAnalysisResults.push({
          post,
          items: [{ description: post.postMessage || "Untitled" }],
          error: err.message,
        });
      }

      completed++;
      $("#smartsplitProgressText").text(`${completed} / ${selectedPosts.length}`);
    }

    smartSplitIsAnalyzing = false;
    $("#smartsplitProgressOverlay").remove();
    updateSmartSplitSelectedCount();

    if (smartSplitAnalysisResults.length > 0) {
      showSmartSplitReviewModal();
    }
  }

  function showSmartSplitReviewModal() {
    $(".smartsplit-review-overlay").remove();

    let totalItems = 0;
    let itemsHtml = "";

    smartSplitAnalysisResults.forEach((result, resultIdx) => {
      const postImgPath = getImagePath(result.post.postImg);
      const errorClass = result.error ? " smartsplit-item-error" : "";

      result.items.forEach((item, itemIdx) => {
        const inputId = `ss-desc-${resultIdx}-${itemIdx}`;
        itemsHtml += `
          <div class="smartsplit-review-item${errorClass}" data-result="${resultIdx}" data-item="${itemIdx}">
            <img src="${postImgPath}" class="smartsplit-review-thumb" onerror="this.src='assets/images/blank.png'" />
            <div class="smartsplit-review-content">
              ${result.items.length > 1 ? `<small style="color: var(--text-secondary, #6c757d);">${window.I18n?.t("workflows.smart_split.item_of", { current: itemIdx + 1, total: result.items.length }) || `Item ${itemIdx + 1}/${result.items.length}`}</small>` : ""}
              <input type="text" class="form-control smartsplit-description-input" id="${inputId}" value="${escapeHtml(item.description)}" />
            </div>
            <button type="button" class="btn btn-outline-danger btn-sm smartsplit-remove-item" title="Remove">
              <i class="material-icons">close</i>
            </button>
          </div>
        `;
        totalItems++;
      });
    });

    const modalHtml = `
      <div class="smartsplit-review-overlay">
        <div class="smartsplit-review-modal">
          <div class="smartsplit-review-header">
            <h5>
              <i class="material-icons">auto_awesome</i>
              ${window.I18n?.t("workflows.smart_split.review_title") || "Review Generated Titles"}
            </h5>
            <p style="margin: 0; font-size: 13px; color: var(--text-secondary, #6c757d);">
              ${window.I18n?.t("workflows.smart_split.review_subtitle") || "Edit or remove titles before starting the workflow. Each title becomes a separate post."}
            </p>
          </div>
          <div class="smartsplit-review-body">
            ${itemsHtml}
          </div>
          <div class="smartsplit-review-footer">
            <button type="button" class="btn btn-secondary smartsplit-review-cancel">
              ${window.I18n?.t("common.cancel") || "Cancel"}
            </button>
            <button type="button" class="btn btn-primary smartsplit-review-confirm">
              <i class="material-icons">play_circle</i>
              ${window.I18n?.t("workflows.smart_split.start_workflow") || "Start Workflow"} (<span class="smartsplit-review-count">${totalItems}</span>)
            </button>
          </div>
        </div>
      </div>
    `;

    $("body").append(modalHtml);

    // Remove item
    $(".smartsplit-review-overlay").on("click", ".smartsplit-remove-item", function () {
      $(this).closest(".smartsplit-review-item").fadeOut(200, function () {
        $(this).remove();
        const remaining = $(".smartsplit-review-item").length;
        $(".smartsplit-review-count").text(remaining);
        if (remaining === 0) {
          $(".smartsplit-review-overlay").remove();
        }
      });
    });

    // Cancel
    $(".smartsplit-review-overlay").on("click", ".smartsplit-review-cancel", function () {
      $(".smartsplit-review-overlay").remove();
    });

    // Confirm — trigger workflow start
    $(".smartsplit-review-overlay").on("click", ".smartsplit-review-confirm", function () {
      const posts = [];
      $(".smartsplit-review-item").each(function () {
        const resultIdx = parseInt($(this).data("result"));
        const desc = $(this).find(".smartsplit-description-input").val().trim();
        if (!desc) return;

        const originalPost = smartSplitAnalysisResults[resultIdx]?.post;
        if (!originalPost) return;

        posts.push({
          postMessage: desc,
          postImg: originalPost.postImg,
          originalInputImage: originalPost.postImg,
          postId: genId(10),
          originalPostId: originalPost.postId,
          status: "pending",
          progress: 0,
          nodes: [],
          smartSplitSource: true,
        });
      });

      $(".smartsplit-review-overlay").remove();

      if (posts.length === 0) {
        showAlert("error", window.I18n?.t("workflows.smart_split.no_titles") || "No titles to process");
        return;
      }

      // Store posts and trigger the workflow via a custom event
      window._smartSplitPosts = posts;
      $("#startAutomation").trigger("smartsplit-confirmed");
    });
  }

  function resetSmartSplitState() {
    smartSplitAnalysisResults = [];
    smartSplitIsAnalyzing = false;
    $("#smartsplitSelectedCount").text("0");
    $("#smartsplitAnalyzeBtn").prop("disabled", true);
    $(".smartsplit-review-overlay").remove();
    $("#smartsplitProgressOverlay").remove();
  }

  // ========== ISE (Image Search Engines) Helper Functions ==========

  function resetIseState() {
    iseSearchResults = [];
    iseSelectedImages.clear();
    iseIsSearching = false;

    // Reset UI
    $("#iseKeywords").val("");
    $("#iseMaxResults").val(20);
    $("#iseEngineGoogle").prop("checked", true);
    $("#iseEngineBing").prop("checked", true);
    $("#iseSafeSearch").prop("checked", true);
    $("#iseProgressPanel").hide();
    $("#iseResultsPanel").hide();
    $("#iseResultsGrid").empty();
    updateIseSelectedCount();
  }

  function updateIseSelectedCount() {
    const selectedCount = iseSelectedImages.size;
    $("#iseSelectedCount").text(selectedCount);
    $("#previewCount").text(selectedCount);

    if (selectedCount > 0) {
      $("#startAutomation").removeAttr("disabled");
    } else {
      $("#startAutomation").attr("disabled", "");
    }
  }

  // ISE AI Provider Models Configuration
  const iseAiModels = {
    deepseek: [
      { value: "deepseek-v4", label: "DeepSeek V4" },
    ],
    openai: [
      { value: "gpt-5-nano", label: "GPT-5 Nano" },
    ],
    anthropic: [
      { value: "claude-opus-4-5-20250220", label: "Claude Opus 4.5 (Recommended)" },
      { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { value: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet" },
      { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
      { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
    ],
    googleai: [
      { value: "gemini-2.5-pro-preview-06-05", label: "Gemini 2.5 Pro (Recommended)" },
      { value: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    ],
  };

  // Initialize ISE AI Providers based on connected APIs
  async function initIseAiProviders() {
    const $noApi = $("#iseAiNoApi");
    const $form = $("#iseAiForm");
    const $providerRow = $("#iseAiProviderRow");
    const $providerSelect = $("#iseAiProvider");
    const $modelSelect = $("#iseAiModel");

    // Get connected API keys
    const openaiKeys = await window.electronAPI.readKey("openaiKeys") || {};
    const anthropicKeys = await window.electronAPI.readKey("anthropicKeys") || {};
    const googleaiKeys = await window.electronAPI.readKey("googleaiKeys") || {};

    const hasOpenAI = Object.keys(openaiKeys).length > 0;
    const hasAnthropic = Object.keys(anthropicKeys).length > 0;
    const hasGoogleAI = Object.keys(googleaiKeys).length > 0;

    const connectedProviders = [];
    if (hasOpenAI) connectedProviders.push({ value: "openai", label: "OpenAI" });
    if (hasAnthropic) connectedProviders.push({ value: "anthropic", label: "Anthropic (Claude)" });
    if (hasGoogleAI) connectedProviders.push({ value: "googleai", label: "Google AI (Gemini)" });

    if (connectedProviders.length === 0) {
      // No APIs connected
      $noApi.show();
      $form.hide();
      return;
    }

    $noApi.hide();
    $form.show();

    // Populate provider dropdown
    $providerSelect.empty();
    connectedProviders.forEach(p => {
      $providerSelect.append(`<option value="${p.value}">${p.label}</option>`);
    });

    // If only one provider, hide the provider row
    if (connectedProviders.length === 1) {
      $providerRow.hide();
    } else {
      $providerRow.show();
    }

    // Set models for first/selected provider
    updateIseAiModels($providerSelect.val());
  }

  // Update model dropdown based on selected provider
  function updateIseAiModels(provider) {
    const $modelSelect = $("#iseAiModel");
    const models = iseAiModels[provider] || [];

    $modelSelect.empty();
    models.forEach(m => {
      $modelSelect.append(`<option value="${m.value}">${m.label}</option>`);
    });
  }

  // ========== Pinterest Feed Spy — AI Title Generator helpers ==========

  async function initPfeedSpyAiProviders() {
    const $noApi = $("#pfeedspyAiGenNoApi");
    const $form = $("#pfeedspyAiGenForm");
    const $providerRow = $("#pfeedspyAiGenProviderRow");
    const $providerSelect = $("#pfeedspyAiGenProvider");

    const [openaiKeys, anthropicKeys, googleaiKeys, deepseekProfiles] = await Promise.all([
      window.electronAPI.readKey("openaiKeys").catch(() => ({})),
      window.electronAPI.readKey("anthropicKeys").catch(() => ({})),
      window.electronAPI.readKey("googleaiKeys").catch(() => ({})),
      window.electronAPI.readKey("deepseekBrowserProfiles").catch(() => ({})),
    ]);

    // Check for connected DeepSeek browser profiles
    const hasDeepSeek = Object.values(deepseekProfiles || {}).some((p) => p.status === "connected");

    // Priority: DeepSeek first, then OpenAI, then others
    const connected = [];
    if (hasDeepSeek) connected.push({ value: "deepseek", label: "DeepSeek (Browser)" });
    if (Object.keys(openaiKeys || {}).length > 0) connected.push({ value: "openai", label: "OpenAI" });
    if (Object.keys(anthropicKeys || {}).length > 0) connected.push({ value: "anthropic", label: "Anthropic (Claude)" });
    if (Object.keys(googleaiKeys || {}).length > 0) connected.push({ value: "googleai", label: "Google AI (Gemini)" });

    if (connected.length === 0) {
      $noApi.show();
      $form.hide();
      return;
    }

    $noApi.hide();
    $form.show();

    // Repopulate provider list, restoring previous selection if still valid
    const prevVal = $providerSelect.val();
    $providerSelect.empty();
    connected.forEach((p) => $providerSelect.append(`<option value="${p.value}">${p.label}</option>`));
    if (connected.length === 1) $providerRow.hide(); else $providerRow.show();
    if (prevVal && $providerSelect.find(`option[value="${prevVal}"]`).length) {
      $providerSelect.val(prevVal);
    }
    updatePfeedSpyAiModels($providerSelect.val());
  }

  function updatePfeedSpyAiModels(provider) {
    const models = iseAiModels[provider] || [];
    const $modelSelect = $("#pfeedspyAiGenModel");
    $modelSelect.empty();
    models.forEach((m) => $modelSelect.append(`<option value="${m.value}">${m.label}</option>`));
  }

  function pfeedspyUpdateAiGenVisibility() {
    const outputVisible = $("#pfeedspyOutputCard").is(":visible");
    const inputType = $("input[name='pfeedspyInputType']:checked").val() || "text";
    const textType = $("input[name='pfeedspyTextType']:checked").val() || "title";
    const canUseAi = outputVisible && inputType === "text" && textType === "title";
    if (canUseAi) {
      $("#pfeedspyAiGenSection").show();
      initPfeedSpyAiProviders();
    } else {
      $("#pfeedspyAiGenSection").hide();
      $("#pfeedspyAiGenEnabled").prop("checked", false);
      $("#pfeedspyAiGenBody").hide();
    }
  }

  function renderPfeedSpyAiTitles() {
    const $list = $("#pfeedspyAiGenTitlesList");
    // Capture which pin groups are currently collapsed so we can restore state after re-render
    const collapsedPins = new Set(
      $list.find(".pfeedspy-ai-title-group.collapsed").map(function () { return String($(this).data("pin-id")); }).get()
    );
    $list.empty();

    if (pfeedspyAiGenTitles.length === 0) {
      $("#pfeedspyAiGenResults").hide();
      // Fall back to pin selection count when no AI titles remain
      pfeedspyUpdatePreviewCount(pfeedspySelectedIds.size);
      return;
    }

    // Collect ordered unique pinIds
    const seenPins = new Set();
    const pinOrder = [];
    for (const item of pfeedspyAiGenTitles) {
      if (!seenPins.has(item.pinId)) { seenPins.add(item.pinId); pinOrder.push(item.pinId); }
    }

    for (const pinId of pinOrder) {
      const items = pfeedspyAiGenTitles.filter((t) => t.pinId === pinId);
      const pin = pfeedspyAllPins.find((p) => p.id === pinId);
      const thumbSrc = pin?.image ? escapeHtml(pin.image) : "";
      const pinLabel = escapeHtml(pin?.title || pin?.description || "Pin");

      const $group = $('<div class="pfeedspy-ai-title-group" data-pin-id="' + escapeHtml(String(pinId)) + '"></div>');
      $group.append(`
        <div class="pfeedspy-ai-title-group-header">
          <i class="material-icons pfeedspy-ai-title-chevron">expand_more</i>
          ${thumbSrc ? `<img class="pfeedspy-ai-title-thumb" src="${thumbSrc}" onerror="this.style.display='none'" />` : ""}
          <span class="pfeedspy-ai-title-group-label" title="${pinLabel}">${pinLabel}</span>
          <span class="pfeedspy-ai-title-group-count">${items.length} title${items.length !== 1 ? "s" : ""}</span>
          <button class="pfeedspy-ai-title-add" data-pin-id="${escapeHtml(String(pinId))}" title="Add a title for this pin"><i class="material-icons">add</i></button>
        </div>
      `);

      const $body = $('<div class="pfeedspy-ai-title-items-body"></div>');
      for (const item of items) {
        const badgeText = item.isOriginal
          ? (window.I18n?.t("workflows.pfeedspy.ai_badge_original") || "Original")
          : "AI";
        const removeBtn = item.isOriginal
          ? ""
          : `<button class="pfeedspy-ai-title-remove" data-item-id="${item.id}"><i class="material-icons">close</i></button>`;
        $body.append(`
          <div class="pfeedspy-ai-title-item${item.isOriginal ? " is-original" : ""}" data-item-id="${item.id}">
            <span class="pfeedspy-ai-badge${item.isOriginal ? " original" : " generated"}">${badgeText}</span>
            <span class="pfeedspy-ai-title-text" contenteditable="true" spellcheck="false" data-item-id="${item.id}">${escapeHtml(item.title)}</span>
            ${removeBtn}
          </div>
        `);
      }
      $group.append($body);
      // Groups are collapsed by default; only expand if the pin was explicitly expanded before re-render
      if (collapsedPins.size > 0 && !collapsedPins.has(String(pinId))) {
        // Was previously expanded — keep it expanded
        $body.show();
      } else {
        // Default: collapsed
        $group.addClass("collapsed");
      }
      $list.append($group);
    }
    // Safety net: ensure every non-collapsed body is visible
    $list.find(".pfeedspy-ai-title-group:not(.collapsed) .pfeedspy-ai-title-items-body").show();

    const origCount = pfeedspyAiGenTitles.filter((t) => t.isOriginal).length;
    const genCount = pfeedspyAiGenTitles.length - origCount;
    $("#pfeedspyAiGenResultsInfo").text(
      `${pfeedspyAiGenTitles.length} titles \u2014 ${origCount} original${origCount !== 1 ? "s" : ""} + ${genCount} AI generated`,
    );
    // Update Start button count: in AI titles mode each title is one post
    pfeedspyUpdatePreviewCount(pfeedspyAiGenTitles.length);
  }

  // ========== End Pinterest Feed Spy — AI Title Generator helpers ==========

  function renderIseResults() {
    const $grid = $("#iseResultsGrid");
    const $empty = $("#iseResultsEmpty");
    const $panel = $("#iseResultsPanel");

    $grid.empty();

    if (iseSearchResults.length === 0) {
      $empty.show();
      $panel.show();
      $("#iseResultsCount").text("0");
      return;
    }

    $empty.hide();
    $panel.show();
    $("#iseResultsCount").text(iseSearchResults.length);

    for (const img of iseSearchResults) {
      const isSelected = iseSelectedImages.has(img.id);
      const sourceClass = (img.source || "unknown").toLowerCase();
      
      // Use thumbnail for display, full URL for download
      const displayUrl = img.thumbnail || img.url;
      const fullUrl = img.url || img.thumbnail;
      
      // Check if image was used before (show semi-transparent)
      const isUsed = img.urlHash && iseUsedImageHashes.has(img.urlHash);

      const card = $(`
        <div class="ise-image-card ${isSelected ? "selected" : ""} ${isUsed ? "used" : ""}" data-id="${img.id}" data-url="${escapeHtml(fullUrl)}" data-thumbnail="${escapeHtml(displayUrl)}" data-url-hash="${img.urlHash || ""}">
          <div class="ise-select-badge">
            <i class="material-icons">check</i>
          </div>
          <span class="ise-source-badge ${sourceClass}">${img.source || "?"}</span>
          ${isUsed ? '<span class="ise-used-badge" title="Previously used">✓ Used</span>' : ''}
          <div class="ise-image-wrapper">
            <img src="${escapeHtml(displayUrl)}" alt="${escapeHtml(img.title || "")}" loading="lazy" onerror="this.onerror=null; this.style.opacity='0.5'; this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23ddd%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2212%22>Error</text></svg>';"/>
            <div class="ise-image-overlay">
              <div class="ise-image-actions">
                <button type="button" class="ise-btn-select" title="${window.I18n?.t("workflows.ise.toggle_select") || "Toggle Selection"}">
                  <i class="material-icons">${isSelected ? "check_circle" : "add_circle"}</i>
                </button>
                <button type="button" class="ise-btn-hide" title="${window.I18n?.t("workflows.ise.hide_image") || "Hide Image"}">
                  <i class="material-icons">visibility_off</i>
                </button>
              </div>
            </div>
          </div>
          ${img.width && img.height ? `<div class="ise-image-info">${img.width}x${img.height}</div>` : ""}
        </div>
      `);

      $grid.append(card);
    }
  }

  async function performIseSearch() {
    const keywordsRaw = $("#iseKeywords").val().trim();
    if (!keywordsRaw) {
      showAlert("error", window.I18n?.t("workflows.ise.enter_keywords") || "Please enter keywords to search");
      return;
    }

    // Parse keywords (split by newlines or commas)
    const keywords = keywordsRaw
      .split(/[\n,]+/)
      .map(k => k.trim())
      .filter(k => k.length > 0);

    if (keywords.length === 0) {
      showAlert("error", window.I18n?.t("workflows.ise.enter_keywords") || "Please enter keywords to search");
      return;
    }

    const maxResults = parseInt($("#iseMaxResults").val()) || 20;
    const useGoogle = $("#iseEngineGoogle").is(":checked");
    const useBing = $("#iseEngineBing").is(":checked");
    const safeSearch = $("#iseSafeSearch").is(":checked");

    if (!useGoogle && !useBing) {
      showAlert("error", window.I18n?.t("workflows.ise.select_engine") || "Please select at least one search engine");
      return;
    }

    const engines = [];
    if (useGoogle) engines.push("google");
    if (useBing) engines.push("bing");

    iseIsSearching = true;
    iseSearchResults = [];
    iseSelectedImages.clear();

    $("#iseSearchBtn").prop("disabled", true);
    $("#iseProgressPanel").show();
    $("#iseResultsPanel").hide();

    try {
      // Load used images hashes first
      const usedResult = await window.electronAPI.getUsedIseImages();
      if (usedResult.success && usedResult.hashes) {
        iseUsedImageHashes = new Set(usedResult.hashes);
      }

      const allResults = [];

      for (let i = 0; i < keywords.length; i++) {
        const keyword = keywords[i];
        $("#iseProgressText").text(window.I18n?.t("workflows.ise.searching") || "Searching...");
        $("#iseProgressKeyword").text(`"${keyword}" (${i + 1}/${keywords.length})`);

        const result = await window.electronAPI.searchImages(keyword, {
          maxResults,
          safeSearch,
          engines,
        });

        if (result.success && result.images) {
          allResults.push(...result.images);
        } else if (!result.success) {
          console.warn(`[ISE] Search failed for "${keyword}":`, result.error);
        }
      }

      // Deduplicate by URL and add urlHash for used image tracking
      const seenUrls = new Set();
      iseSearchResults = allResults.filter(img => {
        const url = img.url || img.thumbnail;
        if (!url || seenUrls.has(url)) return false;
        seenUrls.add(url);
        // Add urlHash from backend if available
        if (!img.urlHash) {
          img.urlHash = simpleHash(url);
        }
        return true;
      });

      console.log(`[ISE] Total unique results: ${iseSearchResults.length}`);

      if (iseSearchResults.length === 0) {
        showAlert("warning", window.I18n?.t("workflows.ise.no_results_found") || "No images found. Try different keywords.");
      }

      renderIseResults();
      updateIseSelectedCount();
    } catch (error) {
      console.error("[ISE] Search error:", error);
      showAlert("error", `Search failed: ${error.message}`);
    } finally {
      iseIsSearching = false;
      $("#iseSearchBtn").prop("disabled", false);
      $("#iseProgressPanel").hide();
    }
  }

  function toggleIseImageSelection(imageId) {
    if (iseSelectedImages.has(imageId)) {
      iseSelectedImages.delete(imageId);
    } else {
      iseSelectedImages.add(imageId);
    }

    // Update UI
    const $card = $(`.ise-image-card[data-id="${imageId}"]`);
    $card.toggleClass("selected", iseSelectedImages.has(imageId));
    $card.find(".ise-btn-select i").text(iseSelectedImages.has(imageId) ? "check_circle" : "add_circle");

    updateIseSelectedCount();
  }

  async function hideIseImage(imageId) {
    const img = iseSearchResults.find(i => i.id === imageId);
    if (!img) return;

    const url = img.url || img.thumbnail;
    const source = img.source || "unknown";

    try {
      await window.electronAPI.hideIseImage(url, source);

      // Remove from results and selection
      iseSearchResults = iseSearchResults.filter(i => i.id !== imageId);
      iseSelectedImages.delete(imageId);

      // Remove from DOM
      $(`.ise-image-card[data-id="${imageId}"]`).fadeOut(200, function() {
        $(this).remove();
        $("#iseResultsCount").text(iseSearchResults.length);
        updateIseSelectedCount();
      });
    } catch (error) {
      console.error("[ISE] Failed to hide image:", error);
    }
  }

  // ========== End ISE Helper Functions ==========

  // ========== Google Trends Mode Helper Functions ==========

  function resetGtrendsState() {
    gtrendsFetchedTopics = [];
    gtrendsSelectedTopics.clear();
    gtrendsIsFetching = false;

    // Reset UI
    $("#gtrendsRegion").val("US");
    $("#gtrendsCategory").val("all");
    $("#gtrendsKeyword").val("");
    $("#gtrendsLoading").hide();
    $("#gtrendsResultsPanel").hide();
    $("#gtrendsResultsGrid").empty();
    $("#gtrendsCacheIndicator").hide();
    updateGtrendsSelectedCount();
  }

  function updateGtrendsSelectedCount() {
    const selectedCount = gtrendsSelectedTopics.size;
    $("#gtrendsSelectedCount").text(selectedCount);
    $("#previewCount").text(selectedCount);

    if (selectedCount > 0) {
      $("#startAutomation").removeAttr("disabled");
    } else {
      $("#startAutomation").attr("disabled", "");
    }
  }

  function renderGtrendsResults(topics, fromCache = false, isFallback = false) {
    const $grid = $("#gtrendsResultsGrid");
    $grid.empty();

    if (!topics || topics.length === 0) {
      $("#gtrendsResultsEmpty").show();
      $("#gtrendsResultsPanel").show();
      $("#gtrendsResultsCount").text("0");
      return;
    }

    $("#gtrendsResultsEmpty").hide();
    $("#gtrendsResultsPanel").show();
    $("#gtrendsResultsCount").text(topics.length);
    
    if (fromCache) {
      $("#gtrendsCacheIndicator").show();
      $("#gtrendsCacheIndicator span").text(window.I18n?.t("workflows.gtrends.from_cache") || "from cache");
    } else {
      $("#gtrendsCacheIndicator").hide();
    }

    topics.forEach((topic, index) => {
      const isSelected = gtrendsSelectedTopics.has(topic.title);
      
      // Display volume and growth from VCBrowser scraping
      const volumeDisplay = topic.volume || topic.searchCount || topic.formattedTraffic || "";
      const growthDisplay = topic.growth || "";
      const durationDisplay = topic.duration || "";
      const startedDisplay = topic.started || "";
      
      // Related terms from composition column
      const relatedTerms = topic.relatedTerms || topic.relatedQueries || [];
      const relatedDisplay = relatedTerms.slice(0, 5);
      
      // Determine trend icon based on growth
      const hasGrowth = growthDisplay && parseInt(growthDisplay) > 0;
      const trendIcon = hasGrowth ? "trending_up" : "local_fire_department";
      const trendClass = hasGrowth ? "rising" : "hot";
      
      const $card = $(`
        <div class="gtrends-topic-card ${isSelected ? 'selected' : ''}" data-title="${escapeHtml(topic.title)}" data-index="${index}">
          <div class="gtrends-topic-header">
            <div class="gtrends-topic-rank">#${index + 1}</div>
            <div class="gtrends-topic-trend ${trendClass}">
              <i class="material-icons">${trendIcon}</i>
              <span>${escapeHtml(volumeDisplay)}</span>
              ${growthDisplay ? `<span class="gtrends-growth">+${escapeHtml(growthDisplay)}</span>` : ""}
            </div>
          </div>
          <div class="gtrends-topic-title">${escapeHtml(topic.title)}</div>
          ${durationDisplay || startedDisplay ? `
            <div class="gtrends-topic-meta">
              ${startedDisplay ? `<span class="gtrends-started"><i class="material-icons">schedule</i>${escapeHtml(startedDisplay)}</span>` : ""}
              ${durationDisplay ? `<span class="gtrends-duration"><i class="material-icons">timer</i>${escapeHtml(durationDisplay)}</span>` : ""}
            </div>
          ` : ""}
          ${relatedDisplay.length > 0 ? `
            <div class="gtrends-topic-related">
              ${relatedDisplay.map(q => `<span class="gtrends-related-tag">${escapeHtml(q)}</span>`).join("")}
            </div>
          ` : ""}
          <div class="gtrends-topic-actions">
            <button class="gtrends-btn-select" title="${isSelected ? "Deselect" : "Select"}">
              <i class="material-icons">${isSelected ? "check_circle" : "add_circle"}</i>
            </button>
          </div>
        </div>
      `);

      $grid.append($card);
    });
  }

  function toggleGtrendsTopicSelection(title) {
    if (gtrendsSelectedTopics.has(title)) {
      gtrendsSelectedTopics.delete(title);
    } else {
      gtrendsSelectedTopics.add(title);
    }

    // Update UI
    const escapedTitle = title.replace(/"/g, '\\"');
    const $card = $(`.gtrends-topic-card[data-title="${escapedTitle}"]`);
    $card.toggleClass("selected", gtrendsSelectedTopics.has(title));
    $card.find(".gtrends-btn-select i").text(gtrendsSelectedTopics.has(title) ? "check_circle" : "add_circle");

    updateGtrendsSelectedCount();
  }

  async function fetchGoogleTrends(forceRefresh = false) {
    if (gtrendsIsFetching) return;

    const region = $("#gtrendsRegion").val();
    const category = $("#gtrendsCategory").val();
    const keyword = $("#gtrendsKeyword").val().trim();
    const hours = parseInt($("#gtrendsTimeRange").val()) || 168;

    gtrendsIsFetching = true;
    gtrendsSelectedTopics.clear();
    $("#gtrendsLoading").show();
    $("#gtrendsResultsPanel").hide();

    try {
      const result = await window.electronAPI.fetchGoogleTrends({
        region,
        category,
        keyword: keyword || null,
        hours,
        forceRefresh
      });

      if (result.success) {
        gtrendsFetchedTopics = result.trends || [];
        renderGtrendsResults(gtrendsFetchedTopics, result.fromCache, false);
      } else if (result.captchaDetected) {
        // Captcha was detected
        console.warn("[GTrends] Captcha detected:", result.captchaType);
        gtrendsFetchedTopics = [];
        renderGtrendsResults([]);
        if (result.browserOpened) {
          showAlert("warning", window.I18n?.t("workflows.gtrends.captcha_browser_opened") || "Captcha detected! Browser opened - please solve it, then click 'Fetch Trends' again.");
        } else {
          showAlert("error", window.I18n?.t("workflows.gtrends.captcha_detected") || "Captcha detected! Use 'Open Browser' to solve it manually.");
        }
      } else {
        console.error("[GTrends] Fetch failed:", result.error);
        gtrendsFetchedTopics = [];
        renderGtrendsResults([]);
        showAlert("error", result.error || "Failed to fetch Google Trends");
      }
    } catch (error) {
      console.error("[GTrends] Fetch error:", error);
      gtrendsFetchedTopics = [];
      renderGtrendsResults([]);
      showAlert("error", "Failed to fetch Google Trends: " + error.message);
    } finally {
      gtrendsIsFetching = false;
      $("#gtrendsLoading").hide();
    }
  }

  // Open Google Trends browser for manual captcha solving
  async function openGoogleTrendsBrowser() {
    const region = $("#gtrendsRegion").val();
    const category = $("#gtrendsCategory").val();
    const hours = parseInt($("#gtrendsTimeRange").val()) || 168;

    try {
      const result = await window.electronAPI.openGoogleTrendsBrowser({
        region,
        category,
        hours
      });

      if (result.success && result.browserOpened) {
        showAlert("info", window.I18n?.t("workflows.gtrends.browser_opened") || "Browser opened. Solve captcha if needed, then click 'Fetch Trends'.");
      } else {
        showAlert("error", result.error || "Failed to open browser");
      }
    } catch (error) {
      console.error("[GTrends] Open browser error:", error);
      showAlert("error", "Failed to open browser: " + error.message);
    }
  }

  // ========== End Google Trends Helper Functions ==========

  // ========== Pinterest Feed Spy Helper Functions ==========

  function resetPfeedSpyState() {
    pfeedspyAllPins = [];
    pfeedspyIsRunning = false;
    pfeedspyStopRequested = false;
    pfeedspyCookies = null;
    pfeedspyBookmark = null;
    pfeedspyQuery = "";
    pfeedspyPagesFetched = 0;
    pfeedspySelectedIds = new Set();

    // Reset UI
    $("#pfeedspyQuery").val("");
    $("#pfeedspyLiveBar").hide();
    $("#pfeedspyResultsPanel").hide();
    $("#pfeedspyResultsGrid").empty();
    $("#pfeedspySelectionBar").hide();
    $("#pfeedspyOutputCard").hide();
    $("#pfeedspyDownloadPanel").hide();
    $("#pfeedspyStartBtn").prop("disabled", false).show();
    $("#pfeedspyStopBtn").prop("disabled", false).hide().find("span").text(window.I18n?.t("workflows.pfeedspy.stop") || "Stop");
    $("#pfeedspyScrapedCount").text("0");
    $("#pfeedspyPageCount").text("0");
    $("#pfeedspyFilteredStat").hide();
    $("#pfeedspyFilteredCount").text("0");
    $("#pfeedspyStatusText").text("");
    $("#pfeedspySelectedCount").text("0");
    $("input[name='pfeedspyInputType'][value='text']").prop("checked", true);
    $("input[name='pfeedspyTextType'][value='title']").prop("checked", true);
    $("input[name='pfeedspySource'][value='public']").prop("checked", true);
    $("#pfeedspyAccountSelectWrap").hide();
    $("#pfeedspyHideUsed").prop("checked", false);
    $("#pfeedspyHideUsedResults").prop("checked", false);
    $("#pfeedspyTextOptions").show();
    // Reset AI title generation panel
    $("#pfeedspyAiGenSection").hide();
    $("#pfeedspyAiGenEnabled").prop("checked", false);
    $("#pfeedspyAiGenBody").hide();
    $("#pfeedspyAiGenResults").hide();
    $("#pfeedspyAiGenTitlesList").empty();
    $("#pfeedspyAiGenProvider").empty();
    pfeedspyAiGenTitles = [];
    pfeedspyPinterestAccountId = null;
    pfeedspyPinterestBoardId = null;
    pfeedspyStep = 1;
    pfeedspyStep2Items = [];
    // Hide step 2, show step 1 config
    $("#pfeedspyStep2Panel").hide();
    $(".pfeedspy-config-card").show();
    // Reset publish row dropdowns
    $("#pfeedspyPublishAccount").val("");
    $("#pfeedspyPublishBoard").html('<option value="">Select board…</option>').prop("disabled", true);
    // Reset Pinterest publish card
    $("#pfeedspyPinterestEnabled").prop("checked", false);
    $("#pfeedspyPinterestBody").hide();
    $("#pfeedspyPinterestAccount").html('<option value="">Select Account</option>');
    $("#pfeedspyPinterestBoard").html('<option value="">Select Board</option>').prop("disabled", true);
    pfeedspyUpdatePreviewCount(0);
  }

  function pfeedspyUpdatePreviewCount(count) {
    $("#previewCount").text(count);
    if (count > 0) {
      $("#startAutomation").removeAttr("disabled");
    } else {
      $("#startAutomation").attr("disabled", "");
    }
  }

  function pfeedspyUpdateSelectionUI() {
    const count = pfeedspySelectedIds.size;
    $("#pfeedspySelectedCount").text(count);
    // If AI titles are generated they own the Start count — don't override with pin selection count
    if (pfeedspyAiGenTitles.length === 0) pfeedspyUpdatePreviewCount(count);
    // Sync visual selected state on cards
    $("#pfeedspyResultsGrid .pfeedspy-pin-card").each(function () {
      const id = String($(this).data("pin-id"));
      $(this).toggleClass("selected", pfeedspySelectedIds.has(id));
    });
  }

  // ── Step 2: Go to review panel ──────────────────────────────────────────────
  function pfeedspyGoToStep2() {
    const selPins = pfeedspyAllPins.filter((p) => pfeedspySelectedIds.has(String(p.id)));
    if (selPins.length === 0) {
      showAlert("error", window.I18n?.t("workflows.pfeedspy.no_pins_selected") || "Please select at least one pin first.");
      return;
    }
    pfeedspyStep = 2;

    // Build initial items: one original item per selected pin, all checked
    pfeedspyStep2Items = selPins.map((pin) => ({
      id: genId(8),
      pinId: pin.id,
      title: pin.title || pin.description || "",
      isOriginal: true,
      checked: true,
    }));

    // Update topbar info
    $("#pfeedspyS2PinCount").text(selPins.length);
    pfeedspyStep2UpdateCount();

    // Load AI providers for step 2
    pfeedspyS2InitProviders();

    // Show/hide Pinterest auto-publish info
    if (pfeedspyPinterestAccountId && pfeedspyPinterestBoardId) {
      $("#pfeedspyS2PinterestInfo").show();
      window.electronAPI.readKey("pinterestAccounts").then((accounts) => {
        const acc = accounts?.[pfeedspyPinterestAccountId];
        const board = acc?.boards?.find((b) => b.id === pfeedspyPinterestBoardId);
        if (board) $("#pfeedspyS2BoardName").text(board.name);
      }).catch(() => {});
    } else {
      $("#pfeedspyS2PinterestInfo").hide();
    }

    // Render the list
    pfeedspyRenderStep2List();

    // Swap panels
    $(".pfeedspy-config-card, #pfeedspyResultsPanel").hide();
    $("#pfeedspyStep2Panel").show();
  }

  function pfeedspyGoToStep1() {
    pfeedspyStep = 1;
    $("#pfeedspyStep2Panel").hide();
    $(".pfeedspy-config-card").show();
    if (pfeedspyAllPins.length > 0) {
      $("#pfeedspyResultsPanel").show();
      $("#pfeedspySelectionBar").show();
    }
    // Restore previous selection count in Start button
    pfeedspyUpdatePreviewCount(pfeedspySelectedIds.size);
  }

  function pfeedspyRenderStep2List() {
    const $list = $("#pfeedspyStep2List");
    $list.empty();

    // Use String() for all pinId comparisons to avoid number/string type mismatches
    const pinIds = [...new Set(pfeedspyStep2Items.map((i) => String(i.pinId)))];

    for (const pinId of pinIds) {
      const pin = pfeedspyAllPins.find((p) => String(p.id) === pinId);
      const items = pfeedspyStep2Items.filter((i) => String(i.pinId) === pinId);
      const $group = $('<div class="pfeedspy-s2-group"></div>').attr('data-pin-id', pinId);

      for (const item of items) {
        const isOrig = item.isOriginal;

        // Build row via DOM — avoids HTML-parse failures from special chars in titles/URLs
        const $row = $('<label></label>')
          .addClass('pfeedspy-s2-item')
          .addClass(isOrig ? 'pfeedspy-s2-item-orig' : 'pfeedspy-s2-item-ai');

        // Checkbox
        const $cb = $('<input type="checkbox" class="pfeedspy-s2-cb">').attr('data-item-id', item.id).prop('checked', item.checked);
        $row.append($cb);

        // Thumbnail or indent
        if (isOrig && pin?.image) {
          const $img = $('<img class="pfeedspy-s2-thumb">').attr('src', pin.image);
          $img.on('error', function () { $(this).hide(); });
          $row.append($img);
        } else {
          $row.append('<span class="pfeedspy-s2-ai-indent"></span>');
        }

        // Title
        const $title = $('<span class="pfeedspy-s2-item-title"></span>');
        if (isOrig) {
          $title.text(item.title);
        } else {
          $title.attr({ contenteditable: 'true', spellcheck: 'false', 'data-item-id': item.id });
          $title.text(item.title);
        }
        $row.append($title);

        // Badge
        const $badge = $('<span class="pfeedspy-s2-badge"></span>')
          .addClass(isOrig ? 'pfeedspy-s2-badge-orig' : 'pfeedspy-s2-badge-ai')
          .text(isOrig ? 'Original' : 'AI');
        $row.append($badge);

        $group.append($row);
      }

      $list.append($group);
    }
  }

  function pfeedspyStep2UpdateCount() {
    const count = pfeedspyStep2Items.filter((i) => i.checked).length;
    $("#pfeedspyS2CheckedCount").text(count);
    pfeedspyUpdatePreviewCount(count);
  }

  async function pfeedspyS2InitProviders() {
    const $noApi = $("#pfeedspyS2NoApi");
    const $form = $("#pfeedspyS2AiForm");
    const $providerSelect = $("#pfeedspyS2Provider");

    const [openaiKeys, anthropicKeys, googleaiKeys, deepseekProfiles] = await Promise.all([
      window.electronAPI.readKey("openaiKeys").catch(() => ({})),
      window.electronAPI.readKey("anthropicKeys").catch(() => ({})),
      window.electronAPI.readKey("googleaiKeys").catch(() => ({})),
      window.electronAPI.readKey("deepseekBrowserProfiles").catch(() => ({})),
    ]);

    const hasDeepSeek = Object.values(deepseekProfiles || {}).some((p) => p.status === "connected");
    const connected = [];
    if (hasDeepSeek) connected.push({ value: "deepseek", label: "DeepSeek (Browser)" });
    if (Object.keys(openaiKeys || {}).length > 0) connected.push({ value: "openai", label: "OpenAI" });
    if (Object.keys(anthropicKeys || {}).length > 0) connected.push({ value: "anthropic", label: "Anthropic (Claude)" });
    if (Object.keys(googleaiKeys || {}).length > 0) connected.push({ value: "googleai", label: "Google AI (Gemini)" });

    if (connected.length === 0) {
      $noApi.show();
      $form.hide();
      return;
    }
    $noApi.hide();
    $form.show();

    const prevVal = $providerSelect.val();
    $providerSelect.empty();
    connected.forEach((p) => $providerSelect.append(`<option value="${p.value}">${p.label}</option>`));
    if (prevVal && $providerSelect.find(`option[value="${prevVal}"]`).length) {
      $providerSelect.val(prevVal);
    }
    pfeedspyS2UpdateModels($providerSelect.val());
  }

  function pfeedspyS2UpdateModels(provider) {
    const $modelSelect = $("#pfeedspyS2Model");
    const models = iseAiModels[provider] || [];
    $modelSelect.empty();
    models.forEach((m) => $modelSelect.append(`<option value="${m.value}">${m.label}</option>`));
  }

  function pfeedspyExpandQueries(query) {
    // Always start with the exact query, then add up to 5 variations
    const base = query.trim();
    const seen = new Set();
    const variants = [];
    const add = (q) => { const t = q.trim(); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); variants.push(t); } };

    add(base);

    const words = base.split(/\s+/);
    const prefixes = ["easy", "best", "quick", "simple", "homemade"];
    const suffixes = ["recipe", "ideas", "tutorial", "tips", "DIY"];

    // Add prefix variants (skip if base already starts with that word)
    for (const p of prefixes) {
      if (!base.toLowerCase().startsWith(p)) {
        add(`${p} ${base}`);
        if (variants.length >= 6) break;
      }
    }

    // Add suffix variants (skip if base already ends with that word)
    for (const s of suffixes) {
      if (!base.toLowerCase().endsWith(s)) {
        add(`${base} ${s}`);
        if (variants.length >= 6) break;
      }
    }

    // If multi-word, try reversing word order as a final variant
    if (words.length >= 2 && variants.length < 6) {
      add([...words].reverse().join(" "));
    }

    return variants.slice(0, 6);
  }

  function pfeedspyTrendScore(pin) {
    const reactions = pin.reactions || 0;
    const createdAt = pin.created_at ? new Date(pin.created_at).getTime() : 0;
    // Age in days, minimum 0.1 to avoid division by zero on brand-new pins
    const ageDays = createdAt
      ? Math.max((Date.now() - createdAt) / (1000 * 3600 * 24), 0.1)
      : 365; // treat unknown date as 1 year old
    // Score = reactions per day — strongly penalizes old pins
    return reactions / ageDays;
  }

  function pfeedspyTimeAgo(dateStr) {
    if (!dateStr) return "";
    const diff = Date.now() - new Date(dateStr).getTime();
    if (isNaN(diff) || diff < 0) return "";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  function pfeedspyGetFilteredPins(pins) {
    const minR = parseInt($("#pfeedspyMinReactions").val()) || 0;
    const maxDRaw = $("#pfeedspyMaxDays").val().trim();
    const maxD = maxDRaw !== "" ? parseFloat(maxDRaw) : null;
    const hideUsed = $("#pfeedspyHideUsed").is(":checked");
    return pins.filter((p) => {
      if (hideUsed && pfeedspyUsedIds.has(String(p.id))) return false;
      if (minR > 0 && (p.reactions || 0) < minR) return false;
      if (maxD !== null) {
        const ageDays = p.created_at
          ? (Date.now() - new Date(p.created_at).getTime()) / 86400000
          : Infinity;
        if (ageDays > maxD) return false;
      }
      // Filter out Etsy pins
      const domain = (p.domain || p.link || "").toLowerCase();
      if (domain.includes("etsy.com")) return false;
      return true;
    });
  }

  function renderPfeedSpyResults(pins, isLive) {
    const $grid = $("#pfeedspyResultsGrid");
    $grid.empty();

    for (let i = 0; i < pins.length; i++) {
      const pin = pins[i];
      const displayTitle = escapeHtml(pin.title || pin.description || "—");
      const imgSrc = escapeHtml(pin.image);
      const timeAgo = pfeedspyTimeAgo(pin.created_at);
      const linkHost = pin.link
        ? (() => { try { return new URL(pin.link).hostname.replace(/^www\./, ""); } catch(e) { return ""; } })()
        : "";
      const isSelected = pfeedspySelectedIds.has(String(pin.id));
      const isUsed = pfeedspyUsedIds.has(pin.id);
      const card = $(`
        <div class="pfeedspy-pin-card${isSelected ? " selected" : ""}${isUsed ? " used" : ""}" data-pin-id="${escapeHtml(String(pin.id))}">
          <span class="pfeedspy-pin-rank">#${i + 1}</span>
          ${isUsed ? '<span class="pfeedspy-pin-used-badge"><i class="material-icons">check_circle</i>Used</span>' : ""}
          ${!isLive ? '<div class="pfeedspy-pin-check"><i class="material-icons">check</i></div>' : ""}
          <img class="pfeedspy-pin-img" src="${imgSrc}" loading="lazy" alt=""
            onerror="this.style.opacity='0.35'" />
          <div class="pfeedspy-pin-info">
            <div class="pfeedspy-pin-reactions"><i class="material-icons" style="font-size:13px;vertical-align:middle">favorite</i> ${pin.reactions}${timeAgo ? `<span class="pfeedspy-pin-time">${timeAgo}</span>` : ""}</div>
            <div class="pfeedspy-pin-title" title="${displayTitle}">${displayTitle}</div>
            ${linkHost ? `<div class="pfeedspy-pin-link"><i class="material-icons" style="font-size:12px;vertical-align:middle">link</i> ${escapeHtml(linkHost)}</div>` : ""}
          </div>
        </div>
      `);
      $grid.append(card);
    }

    $("#pfeedspyResultsCount").text(pins.length);
    $("#pfeedspyResultsPanel").show();
  }

  async function startPfeedSpyScraping() {
    const query = $("#pfeedspyQuery").val().trim();

    if (!query) {
      showAlert("error", window.I18n?.t("workflows.pfeedspy.enter_query") || "Please enter a search query");
      return;
    }

    pfeedspyAllPins = [];
    pfeedspySelectedIds = new Set();
    pfeedspyIsRunning = true;
    pfeedspyStopRequested = false;
    pfeedspyCookies = null;
    pfeedspyBookmark = null;
    pfeedspyPagesFetched = 0;
    pfeedspyQuery = query;

    const seenIds = new Set();

    $("#pfeedspyStartBtn").prop("disabled", true);
    $("#pfeedspyStopBtn").show();
    $("#pfeedspyLiveBar").show();
    $("#pfeedspyResultsPanel").hide();
    $("#pfeedspyOutputCard").hide();
    $("#pfeedspyLiveDot").removeClass("stopped");
    $("#pfeedspyStatusText").text(
      window.I18n?.t("workflows.pfeedspy.initializing") || "Initializing session...",
    );
    pfeedspyUpdatePreviewCount(0);

    try {
      // Step 1: Init session — public or via connected account
      const spySource = $("input[name='pfeedspySource']:checked").val() || "public";
      let initResult;
      if (spySource === "account") {
        const accountId = $("#pfeedspyAccountId").val();
        if (!accountId) {
          throw new Error(window.I18n?.t("workflows.pfeedspy.no_account_selected") || "Please select a Pinterest account");
        }
        $("#pfeedspyStatusText").text(
          window.I18n?.t("workflows.pfeedspy.initializing_account") || "Opening account browser...",
        );
        initResult = await window.electronAPI.pinterestFeedSpyInitAccount(accountId);
      } else {
        initResult = await window.electronAPI.pinterestFeedSpyInit(query);
      }
      if (!initResult.success) {
        throw new Error(initResult.error || "Failed to initialize Pinterest session");
      }
      pfeedspyCookies = initResult.cookies;

      // Generate query variants
      const queryVariants = pfeedspyExpandQueries(pfeedspyQuery);

      // Debounced live UI updater — called from concurrent workers, throttled to ~4/s
      let liveRenderTimer = null;
      const liveUpdate = () => {
        if (liveRenderTimer) return;
        liveRenderTimer = setTimeout(() => {
          liveRenderTimer = null;
          $("#pfeedspyScrapedCount").text(pfeedspyAllPins.length);
          $("#pfeedspyPageCount").text(pfeedspyPagesFetched);
          const liveFiltered = pfeedspyGetFilteredPins(pfeedspyAllPins);
          const _minR = parseInt($("#pfeedspyMinReactions").val()) || 0;
          const _maxDRaw = $("#pfeedspyMaxDays").val().trim();
          if (_minR > 0 || _maxDRaw !== "") {
            $("#pfeedspyFilteredCount").text(liveFiltered.length);
            $("#pfeedspyFilteredStat").show();
          } else {
            $("#pfeedspyFilteredStat").hide();
          }
          const sorted = [...liveFiltered].sort((a, b) => pfeedspyTrendScore(b) - pfeedspyTrendScore(a));
          renderPfeedSpyResults(sorted, true);
        }, 250);
      };

      // Each query variant runs its full pagination loop.
      // When using a connected account, run variants sequentially with a
      // longer inter-page delay to avoid triggering Pinterest's suspicious-
      // activity detection. For anonymous/public scraping run concurrently.
      const isAccountSource = spySource === "account";
      // Inter-page delay: anonymous → 450ms fixed; account → 1500–2500ms jitter
      const pageDelay = () => isAccountSource
        ? new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000))
        : new Promise((r) => setTimeout(r, 450));

      const runQuery = async (currentQuery, qIdx) => {
        let variantBookmark = null;
        while (!pfeedspyStopRequested) {
          const pageResult = await Promise.race([
            window.electronAPI.pinterestFeedSpyPage({
              query: currentQuery,
              cookies: pfeedspyCookies,
              bookmark: variantBookmark,
            }),
            new Promise((resolve) => {
              const check = setInterval(() => {
                if (pfeedspyStopRequested) { clearInterval(check); resolve({ success: false, _stopped: true }); }
              }, 200);
            }),
          ]);

          if (pageResult._stopped || pfeedspyStopRequested) break;
          if (!pageResult.success) {
            console.warn(`[PFeedSpy] Query "${currentQuery}" failed:`, pageResult.error);
            break;
          }

          pfeedspyPagesFetched++;
          for (const pin of pageResult.pins || []) {
            if (!seenIds.has(pin.id) && pin.title && pin.title.trim()) {
              seenIds.add(pin.id);
              pfeedspyAllPins.push(pin);
            }
          }
          liveUpdate();

          variantBookmark = pageResult.bookmark;
          if (pageResult.done || !variantBookmark) break;
          await pageDelay();
        }
      };

      // Show how many queries are running and the mode
      const activeCount = queryVariants.length;
      if (isAccountSource) {
        $("#pfeedspyStatusText").text(`Scraping ${activeCount} query variants (sequential, safe mode)...`);
      } else {
        $("#pfeedspyStatusText").text(`Scraping ${activeCount} query variants in parallel...`);
      }

      if (isAccountSource) {
        // Sequential: run one variant at a time to avoid flooding the account session
        for (let i = 0; i < queryVariants.length && !pfeedspyStopRequested; i++) {
          await runQuery(queryVariants[i], i);
        }
      } else {
        // Concurrent: run all variants in parallel for anonymous/public scraping
        await Promise.all(queryVariants.map((q, i) => runQuery(q, i)));
      }

      pfeedspyFinalizeScraping();
    } catch (error) {
      console.error("[PFeedSpy] Scraping error:", error);
      pfeedspyIsRunning = false;
      pfeedspyStopRequested = false;
      $("#pfeedspyLiveDot").addClass("stopped");
      $("#pfeedspyStartBtn").prop("disabled", false);
      $("#pfeedspyStopBtn").prop("disabled", false).hide().find("span").text(window.I18n?.t("workflows.pfeedspy.stop") || "Stop");
      $("#pfeedspyStatusText").text(
        window.I18n?.t("workflows.pfeedspy.error") || "Error occurred",
      );
      showAlert("error", `Pinterest Feed Spy error: ${error.message}`);
    }
  }

  function pfeedspyFinalizeScraping() {
    pfeedspyIsRunning = false;
    pfeedspyStopRequested = false;
    $("#pfeedspyLiveDot").addClass("stopped");
    $("#pfeedspyStartBtn").prop("disabled", false).show();
    $("#pfeedspyStopBtn").prop("disabled", false).hide().find("span").text(window.I18n?.t("workflows.pfeedspy.stop") || "Stop");

    // Apply reactions + age filters (same logic as live render)
    pfeedspyAllPins = pfeedspyGetFilteredPins(pfeedspyAllPins);

    if (pfeedspyAllPins.length === 0) {
      $("#pfeedspyStatusText").text(
        window.I18n?.t("workflows.pfeedspy.no_pins") || "No pins found",
      );
      showAlert(
        "warning",
        window.I18n?.t("workflows.pfeedspy.no_pins_warning") ||
          "No pins found. Try a different search query.",
      );
      return;
    }

    // Sort by trend score
    pfeedspyAllPins.sort((a, b) => pfeedspyTrendScore(b) - pfeedspyTrendScore(a));

    const doneMsg =
      window.I18n?.t("workflows.pfeedspy.done", { count: pfeedspyAllPins.length }) ||
      `Done — ${pfeedspyAllPins.length} pins found. Select the ones you want to use.`;
    $("#pfeedspyStatusText").text(doneMsg);

    // Render with selection checkmarks enabled
    renderPfeedSpyResults(pfeedspyAllPins, false);
    $("#pfeedspySelectionBar").show();
    pfeedspyUpdatePreviewCount(0);
  }

  // ========== End Pinterest Feed Spy Helper Functions ==========

  // FB Insights helper functions
  function resetFbInsightsState() {
    fbInsightsCsvData = null;
    fbInsightsProcessedPosts = [];
    fbInsightsCurrentStep = 1;

    // Reset UI to step 1
    setFbInsightsStep(1);

    // Clear file input
    $("#fbinsightsCsvInput").val("");
    $("#fbinsightsCsvInfo").hide();
    $("#fbinsightsCsvDropzone").show();

    // Clear posts preview
    $("#fbinsightsPostsPreview tbody").empty();
    $("#fbinsightsAvailableCount").text("0 posts available");

    // Clear log
    $("#fbinsightsLog").empty();

    // Clear ready posts
    $("#fbinsightsReadyPosts tbody").empty();

    // Reset multiplier to default
    $("#fbinsightsMultiplier").val(1);
    $("#fbinsightsTotalCount").text("0");
  }

  function setFbInsightsStep(step) {
    fbInsightsCurrentStep = step;

    // Update step indicators
    $(".fbinsights-step").removeClass("active completed");
    $(".fbinsights-step").each(function () {
      const stepNum = parseInt($(this).data("step"));
      if (stepNum < step) {
        $(this).addClass("completed");
      } else if (stepNum === step) {
        $(this).addClass("active");
      }
    });

    // Show correct panel
    $(".fbinsights-panel").hide();
    $(`.fbinsights-panel[data-panel="${step}"]`).show();
  }

  function updateFbInsightsPostsPreview() {
    if (!fbInsightsCsvData || !fbInsightsCsvData.posts) return;

    const count = parseInt($("#fbinsightsPostCount").val()) || 10;
    const posts = fbInsightsCsvData.posts.slice(0, count);

    const $tbody = $("#fbinsightsPostsPreview tbody");
    $tbody.empty();

    posts.forEach((post, i) => {
      const contentPreview =
        post.description.substring(0, 100) +
        (post.description.length > 100 ? "..." : "");
      $tbody.append(`
                <tr>
                    <td>${i + 1}</td>
                    <td class="content-preview" title="${escapeHtml(post.description)}">${escapeHtml(contentPreview)}</td>
                    <td><strong>${post.views}</strong></td>
                </tr>
            `);
    });
  }

  function updateFbInsightsReadyPosts() {
    const $tbody = $("#fbinsightsReadyPosts tbody");
    $tbody.empty();

    let successCount = 0;
    let imagesCount = 0;
    let skippedCount = 0;

    fbInsightsProcessedPosts.forEach((post, i) => {
      if (post.success) {
        successCount++;
        if (post.localImage) imagesCount++;
      } else {
        skippedCount++;
      }

      const contentPreview =
        post.description.substring(0, 80) +
        (post.description.length > 80 ? "..." : "");
      const rowClass = post.success ? "" : "skipped";
      const imgSrc = post.localImage
        ? `file://${window.electronAPI.getUserDataPath ? "" : ""}`
        : "";

      $tbody.append(`
                <tr class="${rowClass}" data-index="${i}">
                    <td>
                        <input type="checkbox" class="form-check-input fbinsights-post-check" 
                            data-index="${i}" ${post.success ? "checked" : "disabled"}>
                    </td>
                    <td>
                        ${
                          post.localImage
                            ? `<img class="post-thumb" src="" data-local="${escapeHtml(post.localImage)}" alt="Post image">`
                            : `<div class="post-thumb" style="display:flex;align-items:center;justify-content:center;color:#999;"><i class="material-icons">broken_image</i></div>`
                        }
                    </td>
                    <td class="post-content" title="${escapeHtml(post.description)}">${escapeHtml(contentPreview)}</td>
                    <td><strong>${post.views}</strong></td>
                </tr>
            `);
    });

    // Update summary counts
    $("#fbinsightsReadyCount").text(successCount);
    $("#fbinsightsImagesCount").text(imagesCount);
    $("#fbinsightsSkippedCount").text(skippedCount);

    // Show/hide retry button based on failed count
    if (skippedCount > 0) {
      $("#fbinsightsRetryFailed").show();
    } else {
      $("#fbinsightsRetryFailed").hide();
    }

    // Load local images
    loadFbInsightsLocalImages();

    // Update start button
    updateFbInsightsStartButton();
  }

  async function loadFbInsightsLocalImages() {
    const userDataPath = await window.electronAPI.getUserDataPath();
    $("#fbinsightsReadyPosts img[data-local]").each(function () {
      const localPath = $(this).data("local");
      if (localPath) {
        // Check if it's already an absolute path
        if (localPath.includes(":") || localPath.startsWith("/")) {
          // Already absolute path, use directly
          $(this).attr("src", `file://${localPath.replace(/\\/g, "/")}`);
        } else {
          // Just a filename, prepend the path
          $(this).attr("src", `file://${userDataPath}/Images/${localPath}`);
        }
      }
    });
  }

  function updateFbInsightsStartButton() {
    const checkedCount = $(".fbinsights-post-check:checked").length;
    const multiplier = parseInt($("#fbinsightsMultiplier").val()) || 1;
    const totalPosts = checkedCount * multiplier;

    if (checkedCount > 0) {
      $("#startAutomation").removeAttr("disabled");
    } else {
      $("#startAutomation").attr("disabled", "");
    }
    $("#previewCount").text(totalPosts);
    $("#fbinsightsTotalCount").text(totalPosts);
  }

  function addFbInsightsLogEntry(message, type = "info") {
    const $log = $("#fbinsightsLog");
    $log.append(
      `<div class="log-entry ${type}">[${new Date().toLocaleTimeString()}] ${escapeHtml(message)}</div>`,
    );
    $log.scrollTop($log[0].scrollHeight);
  }

  function updateCustomTitlesButton() {
    const count = $('[data-role="customTitles"] .text').length;
    if (count > 0) $("#startAutomation").removeAttr("disabled");
    else $("#startAutomation").attr("disabled", "");
    $("#previewCount").text(count);
  }

  function updatePinterestTitlesButton() {
    const count = $(
      '[data-role="pinterestTitles"] .pinterest-title-item',
    ).length;
    if (count > 0) $("#startAutomation").removeAttr("disabled");
    else $("#startAutomation").attr("disabled", "");
    $("#previewCount").text(count);
  }

  // Load Pinterest accounts into the custom-mode dropdowns
  async function loadPfeedSpyPinterestAccounts() {
    try {
      const pinterestAccounts = (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const validAccounts = Object.entries(pinterestAccounts).filter(
        ([id, account]) =>
          id !== "_usageMigrationCompleted" &&
          account &&
          typeof account === "object" &&
          account.email,
      );
      if (validAccounts.length === 0) {
        $("#pfeedspyPinterestAccount").html('<option value="">No accounts available</option>');
        return;
      }
      const opts = validAccounts
        .map(([id, acc]) => `<option value="${id}">${escapeHtml(acc.email)}</option>`)
        .join("");
      $("#pfeedspyPinterestAccount").html(`<option value="">Select Account</option>${opts}`);
    } catch (e) {
      console.error("[PFeedSpy] Failed to load Pinterest accounts:", e);
    }
  }

  async function loadPfeedSpyPinterestBoards(accountId) {
    try {
      const pinterestAccounts = (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const account = pinterestAccounts[accountId];
      if (!account?.boards?.length) {
        $("#pfeedspyPinterestBoard").html('<option value="">No boards found</option>').prop("disabled", true);
        return;
      }
      const opts = account.boards
        .map((b, i) => `<option value="${b.id}">${i + 1}: ${escapeHtml(b.name)}</option>`)
        .join("");
      $("#pfeedspyPinterestBoard").html(`<option value="">Select Board</option>${opts}`).prop("disabled", false);
    } catch (e) {
      console.error("[PFeedSpy] Failed to load Pinterest boards:", e);
    }
  }

  async function loadCustomModePinterestAccounts() {
    try {
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const validAccounts = Object.entries(pinterestAccounts).filter(
        ([id, account]) =>
          id !== "_usageMigrationCompleted" &&
          account &&
          typeof account === "object" &&
          account.email,
      );
      if (validAccounts.length === 0) {
        $("#customModePinterestAccount").html(
          '<option value="">No accounts available</option>',
        );
        return;
      }
      const opts = validAccounts
        .map(
          ([id, acc]) =>
            `<option value="${id}">${escapeHtml(acc.email)}</option>`,
        )
        .join("");
      $("#customModePinterestAccount").html(
        `<option value="">Select Account</option>${opts}`,
      );
    } catch (e) {
      console.error("[CustomMode] Failed to load Pinterest accounts:", e);
    }
  }

  async function loadCustomModePinterestBoards(accountId) {
    try {
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const account = pinterestAccounts[accountId];
      if (!account?.boards?.length) {
        $("#customModePinterestBoard")
          .html('<option value="">No boards found</option>')
          .prop("disabled", true);
        return;
      }
      const opts = account.boards
        .map(
          (b, i) =>
            `<option value="${b.id}">${i + 1}: ${escapeHtml(b.name)}</option>`,
        )
        .join("");
      $("#customModePinterestBoard")
        .html(`<option value="">Select Board</option>${opts}`)
        .prop("disabled", false);
    } catch (e) {
      console.error("[CustomMode] Failed to load Pinterest boards:", e);
    }
  }

  // Pinterest workflow integration functions
  async function loadPinterestAccountsForWorkflow() {
    try {
      console.log("Loading Pinterest accounts for workflow...");
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      console.log("Pinterest accounts data:", pinterestAccounts);

      // Filter out invalid accounts and create options with last used information
      const validAccounts = Object.entries(pinterestAccounts).filter(
        ([id, account]) => {
          // Skip migration flag
          if (id === "_usageMigrationCompleted") return false;
          return account && typeof account === "object" && account.email;
        },
      );

      console.log(`Found ${validAccounts.length} valid Pinterest accounts`);

      if (validAccounts.length === 0) {
        console.warn("No valid Pinterest accounts found");
        const $dropdown = $("#workflowPinterestAccount");
        if ($dropdown.length > 0) {
          $dropdown.html(
            '<option value="">No Pinterest accounts available</option>',
          );
        } else {
          console.error("Pinterest account dropdown element not found in DOM");
        }
        return;
      }

      const accountsWithTime = validAccounts.map(([id, account]) => {
        // Get usage data from the account's workflowUsage field
        const lastUsed = account.workflowUsage?.lastUsedDate || null;
        const totalWorkflows = account.workflowUsage?.totalWorkflows || 0;
        let lastUsedText = "Never used";

        if (lastUsed) {
          lastUsedText = `Last used: ${timeAgo(lastUsed)}`;
          if (totalWorkflows > 1) {
            lastUsedText += ` (${totalWorkflows} workflows)`;
          }
        }

        return {
          id,
          email: account.email || "Unknown Account",
          lastUsed: lastUsed ? Date.parse(lastUsed) : 0,
          html: `<option value="${id}">${escapeHtml(account.email || "Unknown Account")} - ${lastUsedText}</option>`,
        };
      });

      // Sort by most recently used first
      accountsWithTime.sort((a, b) => {
        if (b.lastUsed === 0 && a.lastUsed === 0) {
          return a.email.localeCompare(b.email);
        }
        return b.lastUsed - a.lastUsed;
      });

      const accountOptions = accountsWithTime
        .map((account) => account.html)
        .join("");

      // Defensive check: ensure dropdown element exists before populating
      const $dropdown = $("#workflowPinterestAccount");
      if ($dropdown.length > 0) {
        $dropdown.html(
          `<option value="">Select Account</option>${accountOptions}`,
        );
        console.log(
          `Successfully loaded ${validAccounts.length} Pinterest accounts for workflow`,
        );

        // Debug: Log the first account for verification
        if (validAccounts.length > 0) {
          console.log("First account example:", validAccounts[0]);
        }
      } else {
        console.error("Pinterest account dropdown element not found in DOM");
        console.log(
          "Available elements with 'pinterest' in ID:",
          $("[id*='pinterest']")
            .map((i, el) => el.id)
            .get(),
        );
      }
    } catch (error) {
      console.error("Failed to load Pinterest accounts:", error);
      // Provide fallback empty dropdown
      const $dropdown = $("#workflowPinterestAccount");
      if ($dropdown.length > 0) {
        $dropdown.html('<option value="">Error loading accounts</option>');
      }
    }
  }

  async function loadPinterestBoardsForWorkflow(accountId) {
    try {
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const account = pinterestAccounts[accountId];

      if (!account || !account.boards) {
        $("#workflowPinterestBoard")
          .html('<option value="">No boards found</option>')
          .prop("disabled", true);
        return;
      }

      const boardOptions = account.boards
        .map(
          (board, index) =>
            `<option value="${board.id}">${index + 1}: ${escapeHtml(board.name)}</option>`,
        )
        .join("");

      $("#workflowPinterestBoard")
        .html(`<option value="">Select Board</option>${boardOptions}`)
        .prop("disabled", false);
      $("#loadPinterestTitles").prop("disabled", false);
    } catch (error) {
      console.error("Failed to load Pinterest boards:", error);
    }
  }

  async function loadPinterestTitlesForWorkflow(accountId, boardId) {
    try {
      const pinterestTitles =
        (await window.electronAPI.readKey("pinterestTitles")) || {};
      const availableTitles = Object.entries(pinterestTitles)
        .filter(
          ([_, title]) =>
            title.accountId === accountId &&
            title.boardId === boardId &&
            !title.used,
        )
        .map(([id, title]) => ({ id, ...title }));

      const container = $("#availablePinterestTitles");

      if (availableTitles.length === 0) {
        container.html(`
                    <div class="text-muted text-center py-3">
                        <i class="material-icons">title</i><br>
                        No unused titles found for this board.<br>
                        <small>Generate titles in Pinterest Accounts page first.</small>
                    </div>
                `);
        return;
      }

      const titlesHtml = availableTitles
        .map(
          (title) => `
                <div class="form-check mb-2">
                    <input class="form-check-input" type="checkbox" id="title_${title.id}" data-title-id="${title.id}" data-title-text="${escapeHtml(title.title)}">
                    <label class="form-check-label" for="title_${title.id}" style="cursor: pointer; word-break: break-word;">
                        ${escapeHtml(title.title)}
                    </label>
                </div>
            `,
        )
        .join("");

      container.html(titlesHtml);
    } catch (error) {
      console.error("Failed to load Pinterest titles:", error);
    }
  }

  function addSelectedPinterestTitle(titleId, titleText) {
    const container = $('[data-role="pinterestTitles"]');

    // Remove empty state if present
    container.find(".text-muted").remove();

    // Check if title already added
    if (container.find(`[data-title-id="${titleId}"]`).length > 0) {
      return;
    }

    const titleItem = $(`
            <div class="pinterest-title-item d-flex mb-2 align-items-center" data-title-id="${titleId}">
                <div class="flex-grow-1" style="word-break: break-word;">
                    <small class="text-muted">Pinterest Title:</small><br>
                    <strong>${escapeHtml(titleText)}</strong>
                </div>
                <button type="button" class="btn btn-sm btn-outline-danger ms-2" data-role="removePinterestTitle">
                    <i class="material-icons">remove</i>
                </button>
            </div>
        `);

    container.append(titleItem);
    updatePinterestTitlesButton();
  }

  async function markPinterestTitleAsUsed(titleId) {
    try {
      const pinterestTitles =
        (await window.electronAPI.readKey("pinterestTitles")) || {};
      if (pinterestTitles[titleId]) {
        pinterestTitles[titleId].used = true;
        await window.electronAPI.updateData("pinterestTitles", pinterestTitles);
      }
    } catch (error) {
      console.error("Failed to mark Pinterest title as used:", error);
    }
  }

  async function markWorkflowAsExported(workflowId, exportPath = null) {
    try {
      const result = await window.electronAPI.invoke(
        "mark-workflow-exported",
        { workflowId, exportPath },
      );
      if (result.success) {
        // Update local cache
        if (allWorkflows[workflowId]) {
          allWorkflows[workflowId].exported = true;
          allWorkflows[workflowId].exportedAt = result.exportedAt || nowIso();
          allWorkflows[workflowId].exportPath = exportPath;
        }
        // Sync to global cache
        if (window.workflowCache) {
          window.workflowCache.allWorkflows = allWorkflows;
        }
        renderWorkflows();
      }
    } catch (error) {
      console.error("Failed to mark workflow as exported:", error);
    }
  }

  async function unmarkWorkflowAsExported(workflowId) {
    try {
      const result = await window.electronAPI.invoke(
        "unmark-workflow-exported",
        workflowId,
      );
      if (result.success) {
        // Update local cache
        if (allWorkflows[workflowId]) {
          allWorkflows[workflowId].exported = false;
          allWorkflows[workflowId].exportedAt = null;
        }
        // Also update allWorkflowsSummary which renderWorkflows uses
        const summaryIndex = allWorkflowsSummary.findIndex(w => w.workflowId === workflowId);
        if (summaryIndex !== -1) {
          allWorkflowsSummary[summaryIndex].exported = false;
          allWorkflowsSummary[summaryIndex].exportedAt = null;
        }
        // Sync to global cache
        if (window.workflowCache) {
          window.workflowCache.allWorkflows = allWorkflows;
          window.workflowCache.allWorkflowsSummary = allWorkflowsSummary;
        }
        // Invalidate hash and force re-render
        lastWorkflowsHash = null;
        renderWorkflows();
      }
    } catch (error) {
      console.error("Failed to remove exported mark from workflow:", error);
    }
  }

  const escapeHtml = (text) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  };

  const getSightengineGeneratorLabel = (generator) => {
    const labels = {
      dalle: "DALL-E",
      firefly: "Adobe Firefly",
      flux: "FLUX",
      gan: "GAN",
      gpt: "GPT Image",
      grok: "Grok",
      higgsfield: "Higgsfield",
      ideogram: "Ideogram",
      kling: "Kling",
      imagen: "Imagen",
      midjourney: "Midjourney",
      qwen: "Qwen",
      recraft: "Recraft",
      reve: "Reve",
      seedream: "Seedream",
      stable_diffusion: "Stable Diffusion",
      wan: "Wan",
      z_image: "Z-Image",
      other: "Other",
    };
    return labels[generator] || String(generator || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  };

  const openSightengineDetailsModal = (result) => {
    const generatorScores = Object.entries(result?.generatorScores || {})
      .filter(([, score]) => Number.isFinite(Number(score)))
      .sort(([, leftScore], [, rightScore]) => Number(rightScore) - Number(leftScore));
    if (!generatorScores.length) return;

    const translate = (key, fallback) =>
      window.I18n?.t(`workflows.output_modal.${key}`) || fallback;
    const aiScore = Number(result.score);
    const deepfakeScore = Number(result.deepfakeScore);
    const [topGenerator, topGeneratorScore] = generatorScores[0];
    const generatorRows = generatorScores.map(([generator, rawScore]) => {
      const score = Math.max(0, Math.min(100, Number(rawScore)));
      return `
        <div class="sightengine-generator-row">
          <div class="sightengine-generator-meta">
            <span>${escapeHtml(getSightengineGeneratorLabel(generator))}</span>
            <strong>${escapeHtml(formatScore(score))}%</strong>
          </div>
          <div class="sightengine-generator-track" aria-hidden="true">
            <span style="width: ${score}%"></span>
          </div>
        </div>`;
    }).join("");

    $(".sightengine-details-modal").remove();
    const $modal = $(`
      <div class="sightengine-details-modal" role="dialog" aria-modal="true" aria-labelledby="sightengine-details-title">
        <button type="button" class="sightengine-details-backdrop" data-role="closeSightengineDetails" aria-label="${escapeHtml(translate("sightengine_close", "Close"))}"></button>
        <div class="sightengine-details-dialog">
          <div class="sightengine-details-header">
            <div>
              <span class="sightengine-details-eyebrow">Sightengine</span>
              <h3 id="sightengine-details-title">${escapeHtml(translate("sightengine_details_title", "AI generator details"))}</h3>
            </div>
            <button type="button" class="sightengine-details-close" data-role="closeSightengineDetails" aria-label="${escapeHtml(translate("sightengine_close", "Close"))}">
              <i class="material-icons">close</i>
            </button>
          </div>
          <div class="sightengine-details-summary">
            <div class="sightengine-summary-card">
              <span>${escapeHtml(translate("sightengine_ai_generated", "AI-generated"))}</span>
              <strong>${escapeHtml(formatScore(aiScore))}%</strong>
            </div>
            <div class="sightengine-summary-card">
              <span>${escapeHtml(translate("sightengine_top_generator", "Highest generator match"))}</span>
              <strong>${escapeHtml(getSightengineGeneratorLabel(topGenerator))} · ${escapeHtml(formatScore(topGeneratorScore))}%</strong>
            </div>
            <div class="sightengine-summary-card">
              <span>${escapeHtml(translate("sightengine_deepfake", "Deepfake"))}</span>
              <strong>${Number.isFinite(deepfakeScore) ? `${escapeHtml(formatScore(deepfakeScore))}%` : "—"}</strong>
            </div>
          </div>
          <div class="sightengine-generator-section">
            <h4>${escapeHtml(translate("sightengine_generator_scores", "Generator probabilities"))}</h4>
            <div class="sightengine-generator-list">${generatorRows}</div>
          </div>
          <p class="sightengine-details-note">${escapeHtml(translate("sightengine_details_note", "The highest match is an estimate, not a definitive attribution."))}</p>
        </div>
      </div>
    `).appendTo("body");

    const closeModal = () => {
      $(document).off(`keydown${WF_NAMESPACE}.sightengineModal`);
      $modal.remove();
    };
    $modal.on("click", '[data-role="closeSightengineDetails"]', closeModal);
    $(document).on(`keydown${WF_NAMESPACE}.sightengineModal`, (event) => {
      if (event.key === "Escape") closeModal();
    });
    $modal.find(".sightengine-details-close").trigger("focus");
  };

  // Simple hash function for URL tracking (must match backend hashUrl)
  const simpleHash = (url) => {
    if (!url) return "";
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  };

  // Migrate existing workflow data to Pinterest account usage tracking (run once)
  const migratePinterestAccountUsage = async () => {
    try {
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const workflows = (await window.electronAPI.readKey("workflows")) || {};
      let accountsUpdated = false;

      // Check if migration has already been done
      const migrationKey = "_usageMigrationCompleted";
      if (pinterestAccounts[migrationKey]) {
        console.log("Pinterest account usage migration already completed");
        return; // Migration already completed
      }

      // Validate Pinterest accounts data before migration
      if (!pinterestAccounts || typeof pinterestAccounts !== "object") {
        console.warn("Pinterest accounts data is invalid, skipping migration");
        return;
      }

      // Check if there are any actual Pinterest accounts (not just the migration flag)
      const actualAccounts = Object.keys(pinterestAccounts).filter(
        (key) => key !== migrationKey,
      );
      if (actualAccounts.length === 0) {
        console.log(
          "No Pinterest accounts found, marking migration as completed",
        );
        pinterestAccounts[migrationKey] = true;
        await window.electronAPI.updateData(
          "pinterestAccounts",
          pinterestAccounts,
        );
        return;
      }

      console.log("Starting Pinterest account usage migration...");

      // Find all Pinterest account usage from existing workflows
      const accountUsage = {};

      Object.entries(workflows).forEach(([workflowId, workflow]) => {
        if (!workflow || !workflow.posts || !Array.isArray(workflow.posts))
          return;

        workflow.posts.forEach((post) => {
          if (post && post.pinterestAccountId) {
            const accountId = post.pinterestAccountId;
            const workflowDate = workflow.createdAt;

            // Only process if account exists in Pinterest accounts
            if (!pinterestAccounts[accountId]) {
              console.warn(
                `Skipping workflow ${workflowId}: Pinterest account ${accountId} not found`,
              );
              return;
            }

            if (!accountUsage[accountId]) {
              accountUsage[accountId] = {
                lastUsedDate: workflowDate,
                totalWorkflows: 0,
                workflowHistory: [],
              };
            }

            // Update last used date if this workflow is more recent
            if (workflowDate > accountUsage[accountId].lastUsedDate) {
              accountUsage[accountId].lastUsedDate = workflowDate;
            }

            // Add to workflow history if not already present
            const existingWorkflow = accountUsage[
              accountId
            ].workflowHistory.find((w) => w.workflowId === workflowId);
            if (!existingWorkflow) {
              accountUsage[accountId].totalWorkflows += 1;
              accountUsage[accountId].workflowHistory.push({
                workflowId: workflowId,
                date: workflowDate,
                postCount: workflow.posts.filter(
                  (p) => p.pinterestAccountId === accountId,
                ).length,
              });
            }
          }
        });
      });

      // Apply usage data to Pinterest accounts
      Object.entries(accountUsage).forEach(([accountId, usage]) => {
        if (pinterestAccounts[accountId]) {
          // Sort workflow history by date (most recent first)
          usage.workflowHistory.sort(
            (a, b) => new Date(b.date) - new Date(a.date),
          );

          // Keep only last 10 workflows
          if (usage.workflowHistory.length > 10) {
            usage.workflowHistory = usage.workflowHistory.slice(0, 10);
          }

          pinterestAccounts[accountId].workflowUsage = usage;
          accountsUpdated = true;
          console.log(
            `Migrated usage data for account: ${pinterestAccounts[accountId].email}`,
          );
        }
      });

      // Mark migration as completed
      pinterestAccounts[migrationKey] = true;
      accountsUpdated = true;

      // Save updated Pinterest accounts data
      if (accountsUpdated) {
        await window.electronAPI.updateData(
          "pinterestAccounts",
          pinterestAccounts,
        );
        console.log("Pinterest account usage migration completed");
      }
    } catch (error) {
      console.error("Failed to migrate Pinterest account usage:", error);
    }
  };

  // Track Pinterest account usage in workflow creation
  const trackPinterestAccountUsage = async (workflowId, posts) => {
    try {
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const pinterestTitles =
        (await window.electronAPI.readKey("pinterestTitles")) || {};
      const workflow = allWorkflows[workflowId];
      const usageDate = workflow?.createdAt || nowIso();
      let accountsUpdated = false;
      let titlesUpdated = false;

      posts.forEach((post) => {
        // Mark Pinterest title as used
        if (post.pinterestTitleId && pinterestTitles[post.pinterestTitleId]) {
          pinterestTitles[post.pinterestTitleId].used = true;
          pinterestTitles[post.pinterestTitleId].usedInWorkflowId = workflowId;
          pinterestTitles[post.pinterestTitleId].usedAt = usageDate;
          titlesUpdated = true;
          console.log(
            `Marked Pinterest title as used: ${post.pinterestTitleId}`,
          );
        }

        if (post.pinterestAccountId) {
          const account = pinterestAccounts[post.pinterestAccountId];
          if (account) {
            // Initialize usage tracking if it doesn't exist
            if (!account.workflowUsage) {
              account.workflowUsage = {
                lastUsedDate: null,
                totalWorkflows: 0,
                workflowHistory: [],
              };
            }

            // Update usage information
            account.workflowUsage.lastUsedDate = usageDate;
            account.workflowUsage.totalWorkflows =
              (account.workflowUsage.totalWorkflows || 0) + 1;

            // Keep a history of workflows (limit to last 10 for performance)
            account.workflowUsage.workflowHistory =
              account.workflowUsage.workflowHistory || [];
            account.workflowUsage.workflowHistory.unshift({
              workflowId: workflowId,
              date: usageDate,
              postCount: posts.filter(
                (p) => p.pinterestAccountId === post.pinterestAccountId,
              ).length,
            });

            // Keep only last 10 workflow entries
            if (account.workflowUsage.workflowHistory.length > 10) {
              account.workflowUsage.workflowHistory =
                account.workflowUsage.workflowHistory.slice(0, 10);
            }

            accountsUpdated = true;
            console.log(
              `Updated usage tracking for Pinterest account: ${account.email}`,
            );
          }
        }
      });

      // Save updated Pinterest titles data
      if (titlesUpdated) {
        await window.electronAPI.updateData("pinterestTitles", pinterestTitles);
        console.log(
          `Pinterest titles marked as used: ${posts.filter((p) => p.pinterestTitleId).length} titles`,
        );
      }

      // Save updated Pinterest accounts data
      if (accountsUpdated) {
        await window.electronAPI.updateData(
          "pinterestAccounts",
          pinterestAccounts,
        );
        console.log("Pinterest accounts usage data updated");
      }
    } catch (error) {
      console.error("Failed to track Pinterest account usage:", error);
    }
  };

  // Debug function to check Pinterest accounts (call from console)
  window.debugPinterestAccounts = async () => {
    try {
      console.log("=== Pinterest Accounts Debug ===");
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      console.log("Raw Pinterest accounts data:", pinterestAccounts);

      const validAccounts = Object.entries(pinterestAccounts).filter(
        ([id, account]) => {
          if (id === "_usageMigrationCompleted") return false;
          return account && typeof account === "object" && account.email;
        },
      );

      console.log(`Valid accounts found: ${validAccounts.length}`);
      validAccounts.forEach(([id, account], index) => {
        console.log(`Account ${index + 1}:`, {
          id,
          email: account.email,
          boards: account.boards?.length || 0,
          workflowUsage: account.workflowUsage,
        });
      });

      const $dropdown = $("#workflowPinterestAccount");
      console.log("Dropdown element found:", $dropdown.length > 0);
      if ($dropdown.length > 0) {
        console.log("Current dropdown content:", $dropdown.html());
      }

      console.log("=== End Debug ===");
    } catch (error) {
      console.error("Debug error:", error);
    }
  };

  // Clear all previous workflow data when creating a new workflow
  function clearPreviousWorkflowData() {
    // Clear posts-progression table and pagination
    $("#posts-progression tbody").empty();
    $("#posts-progression .pagination").empty();

    // Clear posts gallery selections
    $('#posts-gallery input[type="checkbox"]').prop("checked", false);
    $('[data-role="checkAll"]').prop("checked", false);

    // Reset counters and buttons
    $("#previewCount").text("0");
    $("#startAutomation").attr("disabled", "");

    // Reset to default mode (spy) - this will also clear custom titles
    setMode("spy");

    // Clear any previous workflow view state
    currentWorkflowView = null;
    currentPostView = null;
    inLogs = false;
    currentAutomationId = null; // Clear automation ID

    // Hide both nodes view and posts-progression (they'll be shown when needed)
    $("#workflows-container .workflow-preview .nodes").hide();
    $(".workflow-preview #posts-progression").hide();

    console.log("Previous workflow data cleared, reset to spy mode");
  }

  $(document).ready(async function () {
    $(document).off(WF_NAMESPACE);
    $("#workflows-container").off(WF_NAMESPACE);
    $("body").off(WF_NAMESPACE);

    // Restore copypaste modal if it was preserved during navigation
    if (window.copypasteState && window.copypasteState.$element) {
      const state = window.copypasteState;
      // Remove the fresh empty .workflow-copypaste from HTML to avoid duplicates
      $("#workflows-container .workflow-copypaste").remove();
      // Reattach the preserved element to its original location in workflows-container
      $("#workflows-container").append(state.$element);
      console.log("[Copypaste] Restoring saved state", { isOpen: state.isOpen, isMinimized: state.isMinimized });
      if (state.isMinimized) {
        state.$element.hide();
        $("#copypasteMinimizedIndicator").css("display", "flex");
      } else if (state.isOpen) {
        state.$element.css("display", "flex");
        // Resume background policy check if it was running
        if (state.policyCheckPending) {
          state.policyCheckPending = false;
          // Restart policy check after a short delay to let the page finish initializing
          setTimeout(() => {
            if (typeof window._restartPolicyCheck === "function") {
              window._restartPolicyCheck();
            }
          }, 500);
        }
      }
      // Clear the saved state
      state.$element = null;
    }

    allWorkflows = await safeGetWorkflows(true); // Force refresh on page load



    // Update queue status periodically
    setInterval(updateQueueStatus, 5000);

    // Update run time cells frequently for running workflows (no full re-render needed)
    const runTimeIntervalId = setInterval(() => {
      $("#workflowsTableBody tr[data-wf]").each(function () {
        const wfId = $(this).attr("data-wf");
        const wf = allWorkflows[wfId];
        if (!wf) return;
        // Only update for running workflows (terminal times are fixed)
        if (wf.status !== "pending") return;
        $(this)
          .find(".workflow-date")
          .text(
            formatRunTime(
              wf.status,
              wf.executionStartedAt,
              wf.executionCompletedAt,
              wf.runtimeMs,
            ),
          );
      });
    }, 5000);
    window.intervals.push(runTimeIntervalId);

    // Run Pinterest account usage migration (only runs once) - but only if there are Pinterest accounts
    try {
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const hasPinterestAccounts = Object.keys(pinterestAccounts).some(
        (key) => key !== "_usageMigrationCompleted",
      );

      if (hasPinterestAccounts) {
        console.log("Pinterest accounts detected, running migration check...");
        await migratePinterestAccountUsage();
      } else {
        console.log("No Pinterest accounts found, skipping migration");
      }
    } catch (error) {
      console.error("Error during Pinterest migration check:", error);
    }

    renderWorkflows();

    const startInterval = () => {
      if (renderIntervalId) return;
      renderIntervalId = setInterval(async () => {
        if (!isPageVisible || isImageProcessingMode) return;

        // Refresh workflows data from storage with caching
        try {
          const latestWorkflows = await safeGetWorkflows(false); // Use cache
          // Only update workflows data if we're not currently viewing a specific workflow
          // This prevents switching between workflows when viewing progress
          if (!currentWorkflowView) {
            allWorkflows = latestWorkflows;
          } else {
            // Update only the current workflow being viewed to get latest progress
            // BUT preserve the posts array to avoid losing in-progress post updates
            // This is critical during reruns where posts are being processed
            if (latestWorkflows[currentWorkflowView]) {
              const existingPosts =
                allWorkflows[currentWorkflowView]?.posts || [];
              allWorkflows[currentWorkflowView] = {
                ...latestWorkflows[currentWorkflowView],
                posts:
                  existingPosts.length > 0
                    ? existingPosts
                    : latestWorkflows[currentWorkflowView]?.posts || [],
              };
            }
            // Update other workflows but preserve the view
            for (const [id, wf] of Object.entries(latestWorkflows)) {
              if (id !== currentWorkflowView) {
                allWorkflows[id] = wf;
              }
            }
          }
        } catch (e) {
          console.error("Failed to refresh workflows data:", e);
        }

        renderWorkflows();
        if (currentWorkflowView) renderPosts(currentWorkflowView);
        if (currentWorkflowView && currentPostView)
          renderNodes(currentWorkflowView, currentPostView);
      }, RENDER_INTERVAL_MS);
      window.intervals.push(renderIntervalId);
    };

    const stopInterval = () => {
      if (renderIntervalId) {
        clearInterval(renderIntervalId);
        renderIntervalId = null;
      }
    };

    document.addEventListener(
      "visibilitychange",
      () => {
        isPageVisible = !document.hidden;
        if (isPageVisible) startInterval();
        else stopInterval();
      },
      { passive: true },
    );

    startInterval();

    // Listen for spy post used updates to refresh the posts gallery in real-time
    window.electronAPI.onSpyPostUsed((data) => {
      console.log("[Workflows] Spy post marked as used:", data);
      // Update the post row in the gallery if visible
      const $row = $(`#posts-gallery tbody tr[data-id="${data.postId}"]`);
      if ($row.length) {
        // Add used badge if not already present
        const $typeCell = $row.find("td:nth-child(2) .d-flex span");
        if (!$typeCell.find(".badge").length) {
          $typeCell.append(
            '<span class="badge bg-warning text-dark ms-2" title="Used 1x">Used</span>',
          );
        }
      }
    });

    // ========== BULK WORKFLOW LAUNCHER ==========

    // State for bulk launcher
    let bulkLaunchData = {
      accounts: {},
      titles: {},
      selectedBoards: new Set(), // Set of "accountId:boardId" keys
    };

    // Load data for bulk launcher modal
    async function loadBulkLaunchData() {
      try {
        const [pinterestAccounts, pinterestTitles, automations] =
          await Promise.all([
            window.electronAPI.readKey("pinterestAccounts"),
            window.electronAPI.readKey("pinterestTitles"),
            window.electronAPI.readKey("automations"),
          ]);

        bulkLaunchData.accounts = pinterestAccounts || {};
        bulkLaunchData.titles = pinterestTitles || {};
        bulkLaunchData.selectedBoards = new Set();

        // Populate automations dropdown
        const activeAutomations = Object.entries(automations || {})
          .filter(([_, v]) => v.status === "active")
          .map(([_, v]) => ({ value: v.id, label: v.label }));

        const $automationSelect = $("#bulkLaunchAutomation");
        $automationSelect.html(
          '<option value="">-- Select an automation --</option>',
        );
        activeAutomations.forEach((a) => {
          $automationSelect.append(
            `<option value="${a.value}">${escapeHtml(a.label)}</option>`,
          );
        });

        // Build accounts grid
        renderBulkAccountsGrid();
      } catch (error) {
        console.error("Failed to load bulk launch data:", error);
        showAlert("error", "Failed to load Pinterest data");
      }
    }

    // Render the accounts/boards grid
    function renderBulkAccountsGrid() {
      const $grid = $("#bulkAccountsGrid");
      $grid.empty();

      console.log("[Bulk Launch] Rendering accounts grid...");
      console.log("[Bulk Launch] Accounts data:", bulkLaunchData.accounts);
      console.log("[Bulk Launch] Titles data:", bulkLaunchData.titles);

      // Filter valid accounts
      const validAccounts = Object.entries(bulkLaunchData.accounts).filter(
        ([id, account]) =>
          id !== "_usageMigrationCompleted" && account && account.email,
      );

      console.log("[Bulk Launch] Valid accounts:", validAccounts.length);

      if (validAccounts.length === 0) {
        $grid.html(`
          <div class="text-center text-muted py-5">
            <i class="material-icons" style="font-size: 48px;">person_off</i>
            <p class="mt-2">No Pinterest accounts found</p>
            <a href="#pinterest-accounts" class="btn btn-outline-primary mt-2">Add Pinterest Accounts</a>
          </div>
        `);
        updateBulkLaunchStats();
        return;
      }

      let totalBoards = 0;
      let boardsWithTitles = 0;
      let accountsRendered = 0;

      validAccounts.forEach(([accountId, account]) => {
        const boards = account.boards || [];
        console.log(
          `[Bulk Launch] Account ${account.email} has ${boards.length} boards`,
        );

        // Skip accounts with no boards
        if (boards.length === 0) return;

        accountsRendered++;

        // Build boards HTML
        let boardsHtml = "";

        boards.forEach((board) => {
          totalBoards++;

          // Count unused titles for this board
          const unusedTitles = Object.entries(bulkLaunchData.titles).filter(
            ([_, title]) =>
              title.accountId === accountId &&
              title.boardId === board.id &&
              !title.used,
          );

          const titleCount = unusedTitles.length;
          if (titleCount > 0) boardsWithTitles++;

          const boardKey = `${accountId}:${board.id}`;
          const isSelected = bulkLaunchData.selectedBoards.has(boardKey);
          const hasNoTitles = titleCount === 0;

          boardsHtml += `
            <div class="board-item ${isSelected ? "selected" : ""} ${hasNoTitles ? "no-titles" : ""}" 
                 data-board-key="${boardKey}" 
                 data-account-id="${accountId}"
                 data-board-id="${board.id}"
                 data-title-count="${titleCount}">
              <div class="board-checkbox">
                <input type="checkbox" class="form-check-input board-select" 
                       ${isSelected ? "checked" : ""} 
                       ${hasNoTitles ? "disabled" : ""}>
              </div>
              <div class="board-info">
                <span class="board-name">${escapeHtml(board.name || "Unnamed Board")}</span>
              </div>
              <div class="board-titles ${titleCount === 0 ? "empty" : titleCount < 5 ? "low" : ""}">
                <i class="material-icons">title</i>
                <span>${titleCount}</span>
              </div>
            </div>
          `;
        });

        // Append account card with boards
        $grid.append(`
          <div class="bulk-account-card" data-account-id="${accountId}">
            <div class="account-header">
              <div class="account-info">
                <i class="material-icons account-icon">account_circle</i>
                <span class="account-email">${escapeHtml(account.email)}</span>
                <span class="badge bg-secondary ms-2">${boards.length} boards</span>
              </div>
              <button type="button" class="btn btn-sm btn-outline-primary select-all-boards" data-account-id="${accountId}">
                Select All
              </button>
            </div>
            <div class="boards-list">
              ${boardsHtml}
            </div>
          </div>
        `);
      });

      console.log(
        `[Bulk Launch] Rendered ${accountsRendered} accounts with ${totalBoards} total boards`,
      );

      // Show message if no accounts have boards
      if (accountsRendered === 0) {
        $grid.html(`
          <div class="text-center text-muted py-5">
            <i class="material-icons" style="font-size: 48px;">dashboard</i>
            <p class="mt-2">No boards found in your Pinterest accounts</p>
            <p class="text-muted small">Go to Pinterest Accounts page and fetch boards first</p>
          </div>
        `);
      }

      // Update header stats
      $("#bulkTotalAccounts").text(validAccounts.length);
      $("#bulkTotalBoards").text(boardsWithTitles);

      updateBulkLaunchStats();
    }

    // Update statistics and launch button state
    function updateBulkLaunchStats() {
      const selectedCount = bulkLaunchData.selectedBoards.size;
      let totalTitles = 0;

      bulkLaunchData.selectedBoards.forEach((boardKey) => {
        const [accountId, boardId] = boardKey.split(":");
        const titles = Object.entries(bulkLaunchData.titles).filter(
          ([_, t]) =>
            t.accountId === accountId && t.boardId === boardId && !t.used,
        );
        totalTitles += titles.length;
      });

      $("#bulkSelectedCount").text(selectedCount);
      $("#bulkTotalTitles").text(totalTitles);
      $("#bulkWorkflowCount").text(selectedCount);
      $("#bulkPostCount").text(totalTitles);

      // Enable/disable launch button
      const automationSelected = !!$("#bulkLaunchAutomation").val();
      const hasSelection = selectedCount > 0 && totalTitles > 0;

      $("#bulkLaunchStart").prop(
        "disabled",
        !(automationSelected && hasSelection),
      );
    }

    // Open bulk launch modal
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#bulkLaunchWorkflows",
      async function () {
        const $btn = $(this);
        const originalHtml = $btn.html();
        
        // Show loading state
        $btn.prop("disabled", true).html('<i class="material-icons spin">sync</i><span>Loading...</span>');
        
        await loadBulkLaunchData();
        $btn.prop("disabled", false).html(originalHtml);
        const modal = new bootstrap.Modal(
          document.getElementById("bulkLaunchModal"),
        );
        modal.show();
      },
    );
    
    // Board selection toggle
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".board-item:not(.no-titles)",
      function () {
        const $item = $(this);
        const boardKey = $item.data("board-key");
        const $checkbox = $item.find(".board-select");

        if (bulkLaunchData.selectedBoards.has(boardKey)) {
          bulkLaunchData.selectedBoards.delete(boardKey);
          $item.removeClass("selected");
          $checkbox.prop("checked", false);
        } else {
          bulkLaunchData.selectedBoards.add(boardKey);
          $item.addClass("selected");
          $checkbox.prop("checked", true);
        }

        updateBulkLaunchStats();
      },
    );

    // Select all boards for an account
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".select-all-boards",
      function (e) {
        e.stopPropagation();
        const accountId = $(this).data("account-id");
        const $card = $(this).closest(".bulk-account-card");
        const $boards = $card.find(".board-item:not(.no-titles)");

        // Check if all are already selected
        let allSelected = true;
        $boards.each(function () {
          if (!bulkLaunchData.selectedBoards.has($(this).data("board-key"))) {
            allSelected = false;
            return false;
          }
        });

        $boards.each(function () {
          const boardKey = $(this).data("board-key");
          if (allSelected) {
            bulkLaunchData.selectedBoards.delete(boardKey);
            $(this)
              .removeClass("selected")
              .find(".board-select")
              .prop("checked", false);
          } else {
            bulkLaunchData.selectedBoards.add(boardKey);
            $(this)
              .addClass("selected")
              .find(".board-select")
              .prop("checked", true);
          }
        });

        $(this).text(allSelected ? "Select All" : "Deselect");
        updateBulkLaunchStats();
      },
    );

    // Global select/deselect all
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#bulkSelectAll",
      function () {
        $(".board-item:not(.no-titles)").each(function () {
          const boardKey = $(this).data("board-key");
          bulkLaunchData.selectedBoards.add(boardKey);
          $(this)
            .addClass("selected")
            .find(".board-select")
            .prop("checked", true);
        });
        updateBulkLaunchStats();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#bulkDeselectAll",
      function () {
        $(".board-item").each(function () {
          const boardKey = $(this).data("board-key");
          bulkLaunchData.selectedBoards.delete(boardKey);
          $(this)
            .removeClass("selected")
            .find(".board-select")
            .prop("checked", false);
        });
        updateBulkLaunchStats();
      },
    );

    // Automation selection change
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#bulkLaunchAutomation",
      function () {
        updateBulkLaunchStats();
      },
    );

    // LAUNCH ALL WORKFLOWS
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#bulkLaunchStart",
      async function () {
        const automationId = $("#bulkLaunchAutomation").val();
        if (!automationId) {
          showAlert("error", "Please select an automation");
          return;
        }

        if (bulkLaunchData.selectedBoards.size === 0) {
          showAlert("error", "Please select at least one board");
          return;
        }

        const $btn = $(this);
        const totalToCreate = bulkLaunchData.selectedBoards.size;

        // Update button to show loading
        $btn
          .prop("disabled", true)
          .html(
            '<span class="spinner-border spinner-border-sm me-2"></span>Preparing...',
          );

        try {
          // Check if automation has Midjourney node (for skip mode)
          const hasMidjourney = await automationHasMidjourneyNode(automationId);
          const skipImageChoosing = hasMidjourney
            ? await showWorkflowSkipModal()
            : true;

          if (skipImageChoosing === null) {
            $btn
              .prop("disabled", false)
              .html(
                '<i class="material-icons me-2">rocket_launch</i>Launch All Workflows',
              );
            return;
          }

          // Pre-flight validation: check API keys and profiles before creating workflows
          // Build a sample post array to check input requirements
          const samplePosts = [];
          for (const boardKey of bulkLaunchData.selectedBoards) {
            const [accountId, boardId] = boardKey.split(":");
            const boardTitles = Object.entries(bulkLaunchData.titles)
              .filter(
                ([_, t]) =>
                  t.accountId === accountId && t.boardId === boardId && !t.used,
              )
              .slice(0, 1);
            if (boardTitles.length > 0) {
              samplePosts.push({
                postMessage: boardTitles[0][1].title,
                postImg: null,
                pinterestAccountId: accountId,
                pinterestBoardId: boardId,
              });
              break;
            }
          }

          const isValid = await validateWorkflowPreflight(automationId, samplePosts);
          if (!isValid) {
            $btn
              .prop("disabled", false)
              .html(
                '<i class="material-icons me-2">rocket_launch</i>Launch All Workflows',
              );
            return;
          }

          // Close modal immediately and show loading overlay
          bootstrap.Modal.getInstance(
            document.getElementById("bulkLaunchModal"),
          ).hide();
          showLoading(`Creating ${totalToCreate} workflows...`);

          let workflowsCreated = 0;
          let totalPostsCreated = 0;
          const createdWorkflows = [];

          // Create a workflow for each selected board
          let processed = 0;
          for (const boardKey of bulkLaunchData.selectedBoards) {
            processed++;
            // Update loading text
            $(".modern-loading-overlay .loading-text").text(
              `Creating workflow ${processed} of ${totalToCreate}...`,
            );

            const [accountId, boardId] = boardKey.split(":");

            // Get unused titles for this board
            const boardTitles = Object.entries(bulkLaunchData.titles)
              .filter(
                ([_, t]) =>
                  t.accountId === accountId && t.boardId === boardId && !t.used,
              )
              .map(([id, t]) => ({ id, ...t }));

            if (boardTitles.length === 0) continue;

            const workflowId = genId(10);

            if (skipImageChoosing) {
              await window.electronAPI.setWorkflowSkipMode(workflowId, true);
            }

            // Create posts from titles
            const posts = boardTitles.map((title) => ({
              postMessage: title.title,
              postImg: null,
              postId: genId(10),
              status: "pending",
              progress: 0,
              nodes: [],
              pinterestTitleId: title.id,
              pinterestAccountId: accountId,
              pinterestBoardId: boardId,
            }));

            // Shuffle posts for better distribution
            const shuffledPosts = shuffleArray(posts);

            // Get account and board names for workflow label
            const account = bulkLaunchData.accounts[accountId];
            const board = account?.boards?.find((b) => b.id === boardId);
            const accountName =
              account?.email?.split("@")[0] || accountId.slice(0, 6);
            const boardName = board?.name || boardId.slice(0, 6);

            // Create workflow
            const workflowData = {
              workflowId: workflowId,
              progress: 0,
              automationId,
              posts: shuffledPosts,
              createdAt: nowIso(),
              status: "pending",
              name: `Bulk: ${accountName} / ${boardName}`,
              skipImageChoosing: skipImageChoosing || false,
              bulkLaunched: true,
            };

            await saveWorkflow(workflowId, workflowData);
            await trackPinterestAccountUsage(workflowId, shuffledPosts);

            // Populate in-memory cache immediately so automation-logs IPC events
            // can find the workflow and its posts (prevents silent log drops)
            allWorkflows[workflowId] = workflowData;

            createdWorkflows.push({
              workflowId,
              automationId,
              posts: shuffledPosts,
            });
            workflowsCreated++;
            totalPostsCreated += shuffledPosts.length;
          }

          $(".modern-loading-overlay .loading-text").text(
            `Starting ${workflowsCreated} workflows...`,
          );

          // Refresh workflows list (preserves existing posts in cache)
          await safeGetWorkflows(true);
          renderWorkflows();

          // Start executing all workflows (they'll be queued automatically)
          for (const wf of createdWorkflows) {
            window.electronAPI.executeAutomation(
              wf.workflowId,
              wf.automationId,
              wf.posts,
            );
          }

          // Hide loading and show success
          removeLoading();
          showAlert(
            "success",
            `Launched ${workflowsCreated} workflows with ${totalPostsCreated} total posts!`,
          );
        } catch (error) {
          console.error("Bulk launch failed:", error);
          removeLoading();
          showAlert("error", `Failed to launch workflows: ${error.message}`);
        } finally {
          $btn
            .prop("disabled", false)
            .html(
              '<i class="material-icons me-2">rocket_launch</i>Launch All Workflows',
            );
        }
      },
    );

    // ========== END BULK WORKFLOW LAUNCHER ==========

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#newWorkflow",
      async function () {
        // Use cached storage to avoid blocking UI
        const automations = Object.entries(
          storageCache?.automations ||
            (await window.electronAPI.readKey("automations")) ||
            {},
        )
          .filter(([_, v]) => v.status === "active")
          .map(([_, v]) => {
            // Build thumbnail path if automation has a thumbnail
            let thumbnailPath = null;
            if (v.thumbnail) {
              thumbnailPath = `file://${window.localPath}/AutomationThumbnails/${v.thumbnail}`;
            } else if (v.screenshot) {
              // Fallback to screenshot if no thumbnail
              thumbnailPath = `file://${window.localPath}/AutomationScreenshots/${v.screenshot}`;
            }
            return { value: v.id, label: v.label, thumbnail: thumbnailPath };
          });

        const automationFieldName = window.I18n?.t('common.automation') || "Automation";
        const result = await newPrompt([
          {
            type: "select",
            name: automationFieldName,
            required: true,
            options: automations,
            showThumbnails: true,
          },
        ]);
        if (!result) return;

        const automationId = result[automationFieldName];

        // Clear previous workflow data before creating new one
        clearPreviousWorkflowData();

        // Reset shift-click tracking for new post list
        lastCheckedPostIndex = null;

        // Load categories for display and populate filter dropdown
        const categoriesResult =
          await window.electronAPI.getLibraryCategories();
        const categories = categoriesResult?.categories || [];
        const categoryMap = {};
        categories.forEach((c) => {
          categoryMap[c.id] = c;
        });

        // Populate the category filter dropdown
        const $categoryFilter = $("#spy-category-filter");
        $categoryFilter.empty();
        $categoryFilter.append('<option value="">All Categories</option>');
        $categoryFilter.append(
          '<option value="__uncategorized__">Uncategorized</option>',
        );
        categories.forEach((cat) => {
          const catImg = cat.image ? `${cat.name}` : cat.name;
          $categoryFilter.append(
            `<option value="${cat.id}">${catImg}</option>`,
          );
        });

        let posts = (await window.electronAPI.readKey("postsLibrary")) || [];
        console.log(posts);

        // Filter out used posts if toggle is checked
        const hideUsed = $("#hide-used-workflow-posts").is(":checked");
        if (hideUsed) {
          posts = posts.filter((p) => !p.usedAt);
        }

        // Filter by category if selected
        const selectedCategory = $categoryFilter.val();
        if (selectedCategory === "__uncategorized__") {
          posts = posts.filter((p) => !p.categoryId);
        } else if (selectedCategory) {
          posts = posts.filter((p) => p.categoryId === selectedCategory);
        }

        // Sort posts by selected criteria
        posts = applySortOrder(posts, $("#spy-sort-by").val());

        const $tbody = $(
          "#workflows-container .workflow-preview #posts-gallery tbody",
        );
        $("#workflows-container .workflow-preview #posts-gallery").show();
        $tbody.empty();

        // Always set these critical state variables
        $("#startAutomation").prop("disabled", true);
        $('[data-role="checkAll"]').prop("checked", false);
        $(".workflow-preview, #posts-gallery").show();
        currentAutomationId = automationId; // Store in variable instead of DOM

        // Update generate mode warning if currently in generate mode
        if (currentMode === "generate") {
          checkGenerateModeInputWarning();
        }

        // Show empty state if no spy posts
        if (posts.length === 0) {
          const emptyTitle = window.I18n?.t("workflows.spy_empty.title") || "No Spy Posts Yet";
          const emptyDesc = window.I18n?.t("workflows.spy_empty.description") || "Start discovering viral content by using the Spy feature to collect posts from Pinterest and Facebook.";
          const emptyBtn = window.I18n?.t("workflows.spy_empty.button") || "Open Spy";
          $tbody.html(`
            <tr>
              <td colspan="5" class="text-center py-5">
                <div class="spy-empty-state">
                  <div class="spy-empty-icon">
                    <i class="material-icons" style="font-size: 64px; color: #cbd5e1;">visibility_off</i>
                  </div>
                  <h4 style="color: #64748b; margin: 16px 0 8px; font-weight: 600;">${emptyTitle}</h4>
                  <p style="color: #94a3b8; max-width: 400px; margin: 0 auto 20px; line-height: 1.5;">${emptyDesc}</p>
                  <button class="btn btn-primary" id="goToSpyFromWorkflow" style="display: inline-flex; align-items: center; gap: 8px;">
                    <i class="material-icons" style="font-size: 20px;">visibility</i>
                    ${emptyBtn}
                  </button>
                </div>
              </td>
            </tr>
          `);
          return;
        }

        const frag = document.createDocumentFragment();
        for (const data of posts) {
          const tr = document.createElement("tr");
          tr.setAttribute("data-id", data.postId);

          // Used badge indicator
          const usedBadge = data.usedAt
            ? `<span class="badge bg-warning text-dark ms-2" title="Used ${data.usedCount || 1}x">Used</span>`
            : "";

          // Category badge
          let categoryBadge = "";
          if (data.categoryId && categoryMap[data.categoryId]) {
            const cat = categoryMap[data.categoryId];
            const catImg = cat.image
              ? `<img src="${cat.image}" style="width:14px;height:14px;border-radius:2px;margin-right:4px;">`
              : "";
            categoryBadge = `<span class="badge bg-info text-white ms-2" style="font-size:10px;display:inline-flex;align-items:center;">${catImg}${cat.name}</span>`;
          }

          // Get proper image path
          const postImgPath = getImagePath(data.postImg);

          tr.innerHTML = `
            <td><input class="form-check-input" type="checkbox"></td>
            <td>
                <div class="d-flex flex-direction-center align-items-center">
                    <img src="assets/images/icons/${data.type}-colored.png" class="sm me-1">
                    <span>${ucfirst(data.type)}${usedBadge}${categoryBadge}</span>
                </div>
            </td>
            <td>
                <a href="${postImgPath}" data-title="${maxStr(data.postMessage, 25)}" data-lightbox="preview">
                    <img loading="lazy" src="${postImgPath}">
                </a>
            </td>
            <td>
                <div class="stats">
                    ${
                      data.views != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">visibility</i>
                            <span>${formatNumber(data.views)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.shares != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">share</i>
                            <span>${formatNumber(data.shares)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.comments != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">mode_comment</i>
                            <span>${formatNumber(data.comments)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.repins != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">moved_location</i>
                            <span>${formatNumber(data.repins)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.reactions != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">thumb_up</i>
                            <span>${formatNumber(data.reactions)}</span>
                        </div>`
                        : ""
                    }
                </div>
            </td>
            <td>${maxStr(data.postMessage, 25)}</td>
        `;
          frag.appendChild(tr);
        }
        $tbody[0].appendChild(frag);
      },
    );

    // Navigate to Spy page from empty state button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#goToSpyFromWorkflow",
      function () {
        // Navigate to spy page using the same navigation system
        const menuElement = $('.menu .menu-element[href="#spy"]');
        if (menuElement.length > 0) {
          menuElement.trigger("click");
        }
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="checkAll"]',
      function () {
        const checked = $(this).is(":checked");
        $(this)
          .closest("table")
          .find("input[type='checkbox']")
          .prop("checked", checked);
        const count = $(
          '#posts-gallery tbody input[type="checkbox"]:checked',
        ).length;
        $("#startAutomation").prop("disabled", count === 0);
        $("#previewCount").text(count);
        // Reset shift-click tracking when using check all
        lastCheckedPostIndex = null;
        // Update smartsplit selected count if in smartsplit mode
        if (currentMode === "smartsplit") {
          updateSmartSplitSelectedCount();
        }
      },
    );

    // Shift-click multi-select for posts gallery
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '#posts-gallery tbody input[type="checkbox"]',
      function (e) {
        const $checkboxes = $('#posts-gallery tbody input[type="checkbox"]');
        const currentIndex = $checkboxes.index(this);

        if (
          e.shiftKey &&
          lastCheckedPostIndex !== null &&
          lastCheckedPostIndex !== currentIndex
        ) {
          // Shift+click: select all between lastCheckedPostIndex and currentIndex
          const start = Math.min(lastCheckedPostIndex, currentIndex);
          const end = Math.max(lastCheckedPostIndex, currentIndex);
          const isChecked = $(this).is(":checked");

          $checkboxes.slice(start, end + 1).prop("checked", isChecked);
        }

        // Update last checked index
        lastCheckedPostIndex = currentIndex;

        // Update count and button state
        const count = $checkboxes.filter(":checked").length;
        $("#startAutomation").prop("disabled", count === 0);
        $("#previewCount").text(count);
      },
    );

    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      '#posts-gallery input[type="checkbox"]',
      function () {
        const count = $(
          '#posts-gallery tbody input[type="checkbox"]:checked',
        ).length;
        $("#startAutomation").prop("disabled", count === 0);
        $("#previewCount").text(count);
      },
    );

    // Hide Used toggle - reload posts when changed
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#hide-used-workflow-posts",
      async function () {
        if (currentMode === "smartsplit") {
          await loadSmartSplitPosts();
          updateSmartSplitSelectedCount();
          return;
        }
        const hideUsed = $(this).is(":checked");

        // Load categories for display
        const categoriesResult =
          await window.electronAPI.getLibraryCategories();
        const categories = categoriesResult?.categories || [];
        const categoryMap = {};
        categories.forEach((c) => {
          categoryMap[c.id] = c;
        });

        let posts = (await window.electronAPI.readKey("postsLibrary")) || [];

        // Filter out used posts if toggle is checked
        if (hideUsed) {
          posts = posts.filter((p) => !p.usedAt);
        }

        // Filter by category if selected
        const selectedCategory = $("#spy-category-filter").val();
        if (selectedCategory === "__uncategorized__") {
          posts = posts.filter((p) => !p.categoryId);
        } else if (selectedCategory) {
          posts = posts.filter((p) => p.categoryId === selectedCategory);
        }

        // Sort posts by selected criteria
        posts = applySortOrder(posts, $("#spy-sort-by").val());

        const $tbody = $(
          "#workflows-container .workflow-preview #posts-gallery tbody",
        );
        $tbody.empty();

        // Reset shift-click tracking
        lastCheckedPostIndex = null;

        const frag = document.createDocumentFragment();
        for (const data of posts) {
          const tr = document.createElement("tr");
          tr.setAttribute("data-id", data.postId);

          // Used badge indicator
          const usedBadge = data.usedAt
            ? `<span class="badge bg-warning text-dark ms-2" title="Used ${data.usedCount || 1}x">Used</span>`
            : "";

          // Category badge
          let categoryBadge = "";
          if (data.categoryId && categoryMap[data.categoryId]) {
            const cat = categoryMap[data.categoryId];
            const catImg = cat.image
              ? `<img src="${cat.image}" style="width:14px;height:14px;border-radius:2px;margin-right:4px;">`
              : "";
            categoryBadge = `<span class="badge bg-info text-white ms-2" style="font-size:10px;display:inline-flex;align-items:center;">${catImg}${cat.name}</span>`;
          }

          // Get proper image path
          const postImgPath = getImagePath(data.postImg);

          tr.innerHTML = `
            <td><input class="form-check-input" type="checkbox"></td>
            <td>
                <div class="d-flex flex-direction-center align-items-center">
                    <img src="assets/images/icons/${data.type}-colored.png" class="sm me-1">
                    <span>${ucfirst(data.type)}${usedBadge}${categoryBadge}</span>
                </div>
            </td>
            <td>
                <a href="${postImgPath}" data-title="${maxStr(data.postMessage, 25)}" data-lightbox="preview">
                    <img loading="lazy" src="${postImgPath}">
                </a>
            </td>
            <td>
                <div class="stats">
                    ${
                      data.views != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">visibility</i>
                            <span>${formatNumber(data.views)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.shares != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">share</i>
                            <span>${formatNumber(data.shares)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.comments != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">mode_comment</i>
                            <span>${formatNumber(data.comments)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.repins != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">moved_location</i>
                            <span>${formatNumber(data.repins)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.reactions != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">thumb_up</i>
                            <span>${formatNumber(data.reactions)}</span>
                        </div>`
                        : ""
                    }
                </div>
            </td>
            <td>${maxStr(data.postMessage, 25)}</td>
        `;
          frag.appendChild(tr);
        }
        $tbody[0].appendChild(frag);

        // Reset selection state
        $("#startAutomation").prop("disabled", true);
        $('[data-role="checkAll"]').prop("checked", false);
        $("#previewCount").text(0);
      },
    );

    // Category filter - reload posts when changed
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#spy-category-filter",
      async function () {
        if (currentMode === "smartsplit") {
          await loadSmartSplitPosts();
          updateSmartSplitSelectedCount();
          return;
        }
        const selectedCategory = $(this).val();

        // Load categories for display
        const categoriesResult =
          await window.electronAPI.getLibraryCategories();
        const categories = categoriesResult?.categories || [];
        const categoryMap = {};
        categories.forEach((c) => {
          categoryMap[c.id] = c;
        });

        let posts = (await window.electronAPI.readKey("postsLibrary")) || [];

        // Filter out used posts if toggle is checked
        const hideUsed = $("#hide-used-workflow-posts").is(":checked");
        if (hideUsed) {
          posts = posts.filter((p) => !p.usedAt);
        }

        // Filter by category
        if (selectedCategory === "__uncategorized__") {
          posts = posts.filter((p) => !p.categoryId);
        } else if (selectedCategory) {
          posts = posts.filter((p) => p.categoryId === selectedCategory);
        }

        // Sort posts by selected criteria
        posts = applySortOrder(posts, $("#spy-sort-by").val());

        const $tbody = $(
          "#workflows-container .workflow-preview #posts-gallery tbody",
        );
        $tbody.empty();

        // Reset shift-click tracking
        lastCheckedPostIndex = null;

        const frag = document.createDocumentFragment();
        for (const data of posts) {
          const tr = document.createElement("tr");
          tr.setAttribute("data-id", data.postId);

          // Used badge indicator
          const usedBadge = data.usedAt
            ? `<span class="badge bg-warning text-dark ms-2" title="Used ${data.usedCount || 1}x">Used</span>`
            : "";

          // Category badge
          let categoryBadge = "";
          if (data.categoryId && categoryMap[data.categoryId]) {
            const cat = categoryMap[data.categoryId];
            const catImg = cat.image
              ? `<img src="${cat.image}" style="width:14px;height:14px;border-radius:2px;margin-right:4px;">`
              : "";
            categoryBadge = `<span class="badge bg-info text-white ms-2" style="font-size:10px;display:inline-flex;align-items:center;">${catImg}${cat.name}</span>`;
          }

          // Get proper image path
          const postImgPath = getImagePath(data.postImg);

          tr.innerHTML = `
            <td><input class="form-check-input" type="checkbox"></td>
            <td>
                <div class="d-flex flex-direction-center align-items-center">
                    <img src="assets/images/icons/${data.type}-colored.png" class="sm me-1">
                    <span>${ucfirst(data.type)}${usedBadge}${categoryBadge}</span>
                </div>
            </td>
            <td>
                <a href="${postImgPath}" data-title="${maxStr(data.postMessage, 25)}" data-lightbox="preview">
                    <img loading="lazy" src="${postImgPath}">
                </a>
            </td>
            <td>
                <div class="stats">
                    ${
                      data.views != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">visibility</i>
                            <span>${formatNumber(data.views)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.shares != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">share</i>
                            <span>${formatNumber(data.shares)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.comments != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">mode_comment</i>
                            <span>${formatNumber(data.comments)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.repins != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">moved_location</i>
                            <span>${formatNumber(data.repins)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.reactions != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">thumb_up</i>
                            <span>${formatNumber(data.reactions)}</span>
                        </div>`
                        : ""
                    }
                </div>
            </td>
            <td>${maxStr(data.postMessage, 25)}</td>
        `;
          frag.appendChild(tr);
        }
        $tbody[0].appendChild(frag);

        // Reset selection state
        $("#startAutomation").prop("disabled", true);
        $('[data-role="checkAll"]').prop("checked", false);
        $("#previewCount").text(0);
      },
    );

    // Sort dropdown - reload posts when changed
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#spy-sort-by",
      async function () {
        if (currentMode === "smartsplit") {
          await loadSmartSplitPosts();
          updateSmartSplitSelectedCount();
          return;
        }
        const categoriesResult =
          await window.electronAPI.getLibraryCategories();
        const categories = categoriesResult?.categories || [];
        const categoryMap = {};
        categories.forEach((c) => {
          categoryMap[c.id] = c;
        });

        let posts = (await window.electronAPI.readKey("postsLibrary")) || [];

        // Filter out used posts if toggle is checked
        const hideUsed = $("#hide-used-workflow-posts").is(":checked");
        if (hideUsed) {
          posts = posts.filter((p) => !p.usedAt);
        }

        // Filter by category if selected
        const selectedCategory = $("#spy-category-filter").val();
        if (selectedCategory === "__uncategorized__") {
          posts = posts.filter((p) => !p.categoryId);
        } else if (selectedCategory) {
          posts = posts.filter((p) => p.categoryId === selectedCategory);
        }

        // Sort posts by selected criteria
        posts = applySortOrder(posts, $(this).val());

        const $tbody = $(
          "#workflows-container .workflow-preview #posts-gallery tbody",
        );
        $tbody.empty();

        // Reset shift-click tracking
        lastCheckedPostIndex = null;

        const frag = document.createDocumentFragment();
        for (const data of posts) {
          const tr = document.createElement("tr");
          tr.setAttribute("data-id", data.postId);

          // Used badge indicator
          const usedBadge = data.usedAt
            ? `<span class="badge bg-warning text-dark ms-2" title="Used ${data.usedCount || 1}x">Used</span>`
            : "";

          // Category badge
          let categoryBadge = "";
          if (data.categoryId && categoryMap[data.categoryId]) {
            const cat = categoryMap[data.categoryId];
            const catImg = cat.image
              ? `<img src="${cat.image}" style="width:14px;height:14px;border-radius:2px;margin-right:4px;">`
              : "";
            categoryBadge = `<span class="badge bg-info text-white ms-2" style="font-size:10px;display:inline-flex;align-items:center;">${catImg}${cat.name}</span>`;
          }

          // Get proper image path
          const postImgPath = getImagePath(data.postImg);

          tr.innerHTML = `
            <td><input class="form-check-input" type="checkbox"></td>
            <td>
                <div class="d-flex flex-direction-center align-items-center">
                    <img src="assets/images/icons/${data.type}-colored.png" class="sm me-1">
                    <span>${ucfirst(data.type)}${usedBadge}${categoryBadge}</span>
                </div>
            </td>
            <td>
                <a href="${postImgPath}" data-title="${maxStr(data.postMessage, 25)}" data-lightbox="preview">
                    <img loading="lazy" src="${postImgPath}">
                </a>
            </td>
            <td>
                <div class="stats">
                    ${
                      data.views != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">visibility</i>
                            <span>${formatNumber(data.views)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.shares != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">share</i>
                            <span>${formatNumber(data.shares)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.comments != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">mode_comment</i>
                            <span>${formatNumber(data.comments)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.repins != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">moved_location</i>
                            <span>${formatNumber(data.repins)}</span>
                        </div>`
                        : ""
                    }
                    ${
                      data.reactions != null
                        ? `
                        <div class="stat">
                            <i class="material-icons">thumb_up</i>
                            <span>${formatNumber(data.reactions)}</span>
                        </div>`
                        : ""
                    }
                </div>
            </td>
            <td>${maxStr(data.postMessage, 25)}</td>
        `;
          frag.appendChild(tr);
        }
        $tbody[0].appendChild(frag);

        // Reset selection state
        $("#startAutomation").prop("disabled", true);
        $('[data-role="checkAll"]').prop("checked", false);
        $("#previewCount").text(0);
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#startAutomation",
      async function () {
        const automationId = currentAutomationId;
        if (!automationId) {
          showAlert("error", window.I18n?.t('workflows.errors.no_automation') || "Please select an automation first");
          return;
        }

        // Only show skip modal if workflow has Midjourney node, otherwise auto-skip
        const hasMidjourney = await automationHasMidjourneyNode(automationId);
        const skipImageChoosing = hasMidjourney
          ? await showWorkflowSkipModal()
          : true;

        // If user cancelled (clicked outside modal), abort workflow
        if (skipImageChoosing === null) return;

        const workflowId = genId(10);

        if (skipImageChoosing) {
          // Enable skip mode for this workflow
          await window.electronAPI.setWorkflowSkipMode(workflowId, true);
        }
        const chosenPosts = [];
        if (currentMode === "spy") {
          const postIds = [];
          $('#posts-gallery tbody input[type="checkbox"]:checked').each(
            function () {
              postIds.push($(this).closest("tr").attr("data-id"));
            },
          );
          const postsLib =
            (await window.electronAPI.readKey("postsLibrary")) || [];
          const seen = new Set();
          for (const data of postsLib) {
            if (postIds.includes(data.postId) && !seen.has(data.postId)) {
              chosenPosts.push({
                ...data,
                postId: genId(10), // Generate new unique ID for this workflow
                originalPostId: data.postId, // Keep reference to original library post
                originalInputImage: data.postImg, // Store original unprocessed image for comparison
                status: "pending",
                progress: 0,
              });
              seen.add(data.postId);
            }
          }
          const images = chosenPosts.map((elm) => elm.postImg);
          let processedImages = images;

          // Show professional image processing options modal
          const processingOptions = await showImageProcessingOptionsModal();

          // If user cancelled (clicked outside modal), abort workflow
          if (processingOptions === null) return;

          // Step 1: Cropping
          if (processingOptions.crop) {
            await showPhaseTransition("start", "cropping");
            processedImages = await cropImagesSequentially(processedImages);
          }

          // Step 2: Inpainting
          if (processingOptions.inpaint) {
            if (processingOptions.crop) {
              // Show transition from cropping to inpainting
              await showPhaseTransition("cropping", "inpainting");
            } else {
              // Show starting inpainting directly
              await showPhaseTransition("start", "inpainting");
            }
            processedImages = await inpaintImagesSequentially(processedImages);
          }

          chosenPosts.forEach((post, i) => {
            post.postImg = processedImages[i];
          });
        } else if (currentMode === "custom") {
          const _cmPinterestAccount = customModePinterestAccountId || null;
          const _cmPinterestBoard = customModePinterestBoardId || null;
          $('[data-role="customTitles"] .text').each(function () {
            const post = {
              postMessage: $(this).find("input").val(),
              postImg: customModeImage, // Use uploaded image directly without processing
              postId: genId(10),
              status: "pending",
              progress: 0,
              nodes: [],
            };
            if (_cmPinterestAccount && _cmPinterestBoard) {
              post.pinterestAccountId = _cmPinterestAccount;
              post.pinterestBoardId = _cmPinterestBoard;
            }
            chosenPosts.push(post);
          });
          // No image processing for custom mode - use image as-is
        } else if (currentMode === "pinterest") {
          // Handle Pinterest titles
          const accountId = $("#workflowPinterestAccount").val();
          const boardId = $("#workflowPinterestBoard").val();

          $('[data-role="pinterestTitles"] .pinterest-title-item').each(
            function () {
              const titleId = $(this).data("title-id");
              const titleText = $(this).find("strong").text();

              chosenPosts.push({
                postMessage: titleText,
                postImg: null,
                postId: genId(10),
                status: "pending",
                progress: 0,
                nodes: [],
                pinterestTitleId: titleId,
                pinterestAccountId: accountId,
                pinterestBoardId: boardId,
              });
            },
          );
        } else if (currentMode === "fbinsights") {
          // Handle FB Insights posts
          const selectedIndices = [];
          $(".fbinsights-post-check:checked").each(function () {
            selectedIndices.push(parseInt($(this).data("index")));
          });

          // Get the multiplier value
          const multiplier = Math.max(
            1,
            Math.min(100, parseInt($("#fbinsightsMultiplier").val()) || 1),
          );

          for (const idx of selectedIndices) {
            const post = fbInsightsProcessedPosts[idx];
            if (post && post.success) {
              // Create 'multiplier' copies of each selected post
              for (let m = 0; m < multiplier; m++) {
                chosenPosts.push({
                  postMessage: post.description,
                  postImg: post.localImage,
                  originalInputImage: post.localImage, // Store original for comparison
                  postId: genId(10),
                  status: "pending",
                  progress: 0,
                  nodes: [],
                  fbInsightsSource: true,
                  originalPermalink: post.permalink,
                  views: post.views,
                  copyIndex: m + 1, // Track which copy this is (1-based)
                });
              }
            }
          }

          // Offer image processing for FB Insights mode (same as spy mode)
          if (chosenPosts.length > 0 && chosenPosts.some((p) => p.postImg)) {
            const images = chosenPosts.map((elm) => elm.postImg);
            let processedImages = images;

            // Show professional image processing options modal
            const processingOptions = await showImageProcessingOptionsModal();

            // If user cancelled (clicked outside modal), abort workflow
            if (processingOptions === null) return;

            // Step 1: Cropping
            if (processingOptions.crop) {
              await showPhaseTransition("start", "cropping");
              processedImages = await cropImagesSequentially(processedImages);
            }

            // Step 2: Inpainting
            if (processingOptions.inpaint) {
              if (processingOptions.crop) {
                await showPhaseTransition("cropping", "inpainting");
              } else {
                await showPhaseTransition("start", "inpainting");
              }
              processedImages =
                await inpaintImagesSequentially(processedImages);
            }

            chosenPosts.forEach((post, i) => {
              post.postImg = processedImages[i];
            });
          }
        } else if (currentMode === "ise") {
          // Handle ISE (Image Search Engines) mode
          if (iseSelectedImages.size === 0) {
            showAlert("error", window.I18n?.t("workflows.ise.no_selection") || "Please select at least one image");
            return;
          }

          // Show loading while downloading images
          showLoading(window.I18n?.t("workflows.ise.downloading") || "Downloading selected images...");

          // Download all selected images
          const selectedUrls = [];
          for (const imageId of iseSelectedImages) {
            const img = iseSearchResults.find(i => i.id === imageId);
            if (img) {
              selectedUrls.push(img.url || img.thumbnail);
            }
          }

          try {
            const downloadResult = await window.electronAPI.downloadIseImages(selectedUrls);
            hideLoading();

            if (!downloadResult.success || downloadResult.successCount === 0) {
              showAlert("error", window.I18n?.t("workflows.ise.download_failed") || "Failed to download images. Try again.");
              return;
            }

            // Mark used images in the database for future visual feedback
            for (const result of downloadResult.results) {
              if (result.success && result.url) {
                await window.electronAPI.markIseImageUsed(result.url);
              }
            }

            // Create posts from successfully downloaded images
            for (const result of downloadResult.results) {
              if (result.success && result.value) {
                chosenPosts.push({
                  postMessage: "", // ISE mode only provides images
                  postImg: result.value, // Local filename
                  originalInputImage: result.url, // Original URL for reference
                  postId: genId(10),
                  status: "pending",
                  progress: 0,
                  nodes: [],
                  iseSource: true,
                });
              }
            }

            if (chosenPosts.length === 0) {
              showAlert("error", window.I18n?.t("workflows.ise.no_images_downloaded") || "No images were downloaded successfully");
              return;
            }

            console.log(`[ISE] Downloaded ${chosenPosts.length} images for workflow`);

            // Offer image processing for ISE mode (same as spy mode)
            const images = chosenPosts.map((elm) => elm.postImg);
            let processedImages = images;

            // Show professional image processing options modal
            const processingOptions = await showImageProcessingOptionsModal();

            // If user cancelled (clicked outside modal), abort workflow
            if (processingOptions === null) return;

            // Step 1: Cropping
            if (processingOptions.crop) {
              await showPhaseTransition("start", "cropping");
              processedImages = await cropImagesSequentially(processedImages);
            }

            // Step 2: Inpainting
            if (processingOptions.inpaint) {
              if (processingOptions.crop) {
                await showPhaseTransition("cropping", "inpainting");
              } else {
                await showPhaseTransition("start", "inpainting");
              }
              processedImages = await inpaintImagesSequentially(processedImages);
            }

            chosenPosts.forEach((post, i) => {
              post.postImg = processedImages[i];
            });
          } catch (error) {
            hideLoading();
            console.error("[ISE] Error downloading images:", error);
            showAlert("error", `Failed to download images: ${error.message}`);
            return;
          }
        } else if (currentMode === "gtrends") {
          // Handle Google Trends mode
          if (gtrendsSelectedTopics.size === 0) {
            showAlert("error", window.I18n?.t("workflows.gtrends.no_selection") || "Please select at least one trending topic");
            return;
          }

          // Create posts from selected trending topics
          for (const title of gtrendsSelectedTopics) {
            const topic = gtrendsFetchedTopics.find(t => t.title === title);
            if (topic) {
              chosenPosts.push({
                postMessage: title, // The trending topic as the message
                postImg: "", // No image for trends mode - workflow generates content
                postId: genId(10),
                status: "pending",
                progress: 0,
                nodes: [],
                gtrendsSource: true,
                gtrendsTraffic: topic.formattedTraffic || topic.traffic || "",
                gtrendsRelatedQueries: topic.relatedQueries || [],
              });
            }
          }

          if (chosenPosts.length === 0) {
            showAlert("error", window.I18n?.t("workflows.gtrends.no_topics_added") || "No topics were added");
            return;
          }

          console.log(`[GTrends] Created ${chosenPosts.length} posts from trending topics`);
        } else if (currentMode === "pfeedspy") {
          // ── Pinterest Feed Spy mode ────────────────────────────────────────
          // Allow launching directly from Step 1 with just the selected pins
          // (using their original titles) without being forced into the Step 2
          // AI-title review. Step 2 remains available for AI titles / image config.
          if (pfeedspyStep !== 2) {
            const selPins = pfeedspyAllPins.filter((p) => pfeedspySelectedIds.has(String(p.id)));
            if (selPins.length === 0) {
              showAlert("error", window.I18n?.t("workflows.pfeedspy.no_pins_selected") || "Please select at least one pin first.");
              return;
            }
            // Build items straight from the current selection, each with its
            // original pin title, all checked.
            pfeedspyStep2Items = selPins.map((pin) => ({
              id: genId(8),
              pinId: pin.id,
              title: pin.title || pin.description || "",
              isOriginal: true,
              checked: true,
            }));
          }

          const checkedItems = pfeedspyStep2Items.filter((i) => i.checked);
          if (checkedItems.length === 0) {
            showAlert("error", window.I18n?.t("workflows.pfeedspy.no_pins_selected") || "No items selected. Please check at least one pin or title.");
            return;
          }

          const inputType = $("input[name='pfeedspyS2InputType']:checked").val() || "text";
          const needImages = inputType === "image" || inputType === "both";
          const needText   = inputType === "text"  || inputType === "both";

          const usedPinIds = [...new Set(checkedItems.map((i) => i.pinId))];
          const uniquePins = usedPinIds.map((id) => pfeedspyAllPins.find((p) => p.id === id)).filter(Boolean);

          const pfeedspyAddPinterest = !!(pfeedspyPinterestAccountId && pfeedspyPinterestBoardId);
          const pfeedspyPinterestFields = pfeedspyAddPinterest
            ? { pinterestAccountId: pfeedspyPinterestAccountId, pinterestBoardId: pfeedspyPinterestBoardId }
            : {};

          if (needImages) {
            const progressHandler = (progressData) => {
              $("#pfeedspyS2DownloadText").text(
                window.I18n?.t("workflows.pfeedspy.downloading_progress", {
                  current: progressData.current, total: progressData.total,
                }) || `Downloading image ${progressData.current} of ${progressData.total}...`,
              );
              $("#pfeedspyS2DownloadPercent").text(`${progressData.percent}%`);
              $("#pfeedspyS2ProgressFill").css("width", `${progressData.percent}%`);
            };
            window.electronAPI.onPfeedSpyDownloadProgress(progressHandler);
            $("#pfeedspyS2DownloadPanel").show();
            $("#pfeedspyS2ProgressFill").css("width", "0%");
            $("#pfeedspyS2DownloadPercent").text("0%");
            $("#pfeedspyS2DownloadText").text(window.I18n?.t("workflows.pfeedspy.downloading") || "Downloading images...");

            let dlResults;
            try {
              const dlResult = await window.electronAPI.pinterestFeedSpyDownloadImages(
                uniquePins.map((p) => p.image),
              );
              if (!dlResult.success) throw new Error(dlResult.error || "Download failed");
              dlResults = dlResult.results;
            } catch (e) {
              window.electronAPI.removePfeedSpyDownloadProgressListeners();
              $("#pfeedspyS2DownloadPanel").hide();
              showAlert("error", `Failed to download images: ${e.message}`);
              return;
            }
            window.electronAPI.removePfeedSpyDownloadProgressListeners();
            $("#pfeedspyS2DownloadPanel").hide();

            const pinImgMap = {};
            uniquePins.forEach((pin, i) => {
              pinImgMap[pin.id] = dlResults[i]?.success ? dlResults[i].value : "";
            });

            for (const item of checkedItems) {
              const pin = pfeedspyAllPins.find((p) => p.id === item.pinId);
              chosenPosts.push({
                postMessage: needText ? item.title : "",
                postImg: pinImgMap[item.pinId] || "",
                originalInputImage: pin?.image || "",
                postId: genId(10), status: "pending", progress: 0, nodes: [],
                pfeedspySource: true, pfeedspyPinId: item.pinId,
                pfeedspyReactions: pin?.reactions, pfeedspyLink: pin?.link || "",
                pfeedspyAiGenerated: !item.isOriginal,
                ...pfeedspyPinterestFields,
              });
            }
          } else {
            for (const item of checkedItems) {
              const pin = pfeedspyAllPins.find((p) => p.id === item.pinId);
              chosenPosts.push({
                postMessage: needText ? item.title : "",
                postImg: "",
                postId: genId(10), status: "pending", progress: 0, nodes: [],
                pfeedspySource: true, pfeedspyPinId: item.pinId,
                pfeedspyReactions: pin?.reactions, pfeedspyLink: pin?.link || "",
                pfeedspyAiGenerated: !item.isOriginal,
                ...pfeedspyPinterestFields,
              });
            }
          }

          if (chosenPosts.length === 0) {
            showAlert("error", window.I18n?.t("workflows.pfeedspy.no_posts_generated") || "No posts generated from Pinterest Feed Spy results.");
            return;
          }
          console.log(`[PFeedSpy] Created ${chosenPosts.length} posts from ${usedPinIds.length} pins`);
          window.electronAPI.pfeedSpyMarkUsed(usedPinIds).catch(() => {});
          for (const id of usedPinIds) pfeedspyUsedIds.add(String(id));

        } else if (currentMode === "generate") {
          // Generate mode: create empty placeholder posts
          const count = Math.max(1, Math.min(500, parseInt($("#generatePostCount").val()) || 1));
          for (let i = 0; i < count; i++) {
            chosenPosts.push({
              postMessage: "",
              postImg: null,
              postId: genId(10),
              status: "pending",
              progress: 0,
              nodes: [],
              generateMode: true,
            });
          }
          console.log(`[Generate] Created ${chosenPosts.length} empty posts for generation`);
        } else if (currentMode === "smartsplit") {
          // Smart Split mode — analysis + review handled via event handlers
          // The "smartsplit-confirmed" event on #startAutomation handles workflow creation
          analyzeSmartSplitPosts();
          return;
        }
        $(".workflow-preview, #posts-gallery").hide();

        // Shuffle posts to avoid similar photos being posted consecutively
        // This is healthier for social media algorithms
        const shuffledPosts = shuffleArray(chosenPosts);
        console.log(
          `[Workflow] Shuffled ${shuffledPosts.length} posts to randomize order`,
        );

        // Pre-flight validation: check API keys, profiles, and input connections
        const isValid = await validateWorkflowPreflight(automationId, shuffledPosts);
        if (!isValid) {
          // Validation failed - just return without showing the workflow preview
          // The error modal is already shown by validateWorkflowPreflight
          return;
        }

        // Determine if we're creating a paused workflow
        const isPausedCreate = createPausedMode;
        createPausedMode = false; // Reset immediately

        // Create workflow via API (no more reading/writing entire allWorkflows object)
        const workflowData = {
          workflowId: workflowId,
          progress: 0,
          automationId,
          posts: shuffledPosts,
          createdAt: nowIso(),
          status: isPausedCreate ? "paused" : "pending",
          name: `Workflow ${nowIso()}`,
          skipImageChoosing: skipImageChoosing || false, // Store skip mode preference
        };

        await saveWorkflow(workflowId, workflowData);

        // Populate in-memory cache immediately so automation-logs IPC events
        // can find the workflow and its posts (prevents silent log drops)
        allWorkflows[workflowId] = workflowData;

        // Refresh workflows from API to get consistent data structure
        await safeGetWorkflows(true); // Force refresh after creation (preserves existing posts)

        if (isPausedCreate) {
          showAlert("success", window.I18n?.t("workflows.paused_created") || "Workflow created in paused state. Click \"Start Workflow\" when you're ready to run it.");
          renderWorkflows();
        } else {
          // Track Pinterest account usage for this workflow
          await trackPinterestAccountUsage(workflowId, shuffledPosts);

          window.electronAPI.executeAutomation(
            workflowId,
            automationId,
            shuffledPosts,
          );
          showLogs(workflowId);
          renderWorkflows();
        }
      },
    );

    // Toggle the "Create Paused" dropdown menu next to the Start button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#startAutomationMenuToggle",
      function (e) {
        e.stopPropagation();
        const $menu = $("#startAutomationMenu");
        $menu.toggle();
      },
    );

    // Close the dropdown when clicking outside
    $(document).on("click" + WF_NAMESPACE, function (e) {
      if (!$(e.target).closest(".start-automation-group").length) {
        $("#startAutomationMenu").hide();
      }
    });

    // "Create Paused" dropdown item handler
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#createPausedWorkflow",
      function (e) {
        e.stopPropagation();
        $("#startAutomationMenu").hide();
        createPausedMode = true;
        $("#startAutomation").trigger("click");
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "[data-role='changeMode'] button",
      async function () {
        const modeId = $(this).data("id");
        
        setMode(modeId);
      },
    );

    $("#workflows-container").on(
      "submit" + WF_NAMESPACE,
      "#customTitles",
      function (e) {
        e.preventDefault();
        const text = $(this).find("textarea").val();
        if (text) {
          const texts = text.split("|");
          for (let i = 0; i < texts.length; i++) {
            if (texts[i].trim().length > 3) {
              $('[data-role="customTitles"]').append(
                `<div class="text d-flex mb-1"><input class="form-control" value="${texts[i].trim()}"><button data-role="deleteText" class="btn btn-danger"><i class="material-icons">delete</i></button></div>`,
              );
            }
          }
        }
        $(this).find("textarea").val("");
        updateCustomTitlesButton();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="deleteText"]',
      function () {
        $(this).parent().remove();
        updateCustomTitlesButton();
      },
    );

    // Generate mode post count change
    $("#workflows-container").on(
      "input" + WF_NAMESPACE,
      "#generatePostCount",
      function () {
        const count = Math.max(1, Math.min(500, parseInt($(this).val()) || 1));
        $("#previewCount").text(count);
      },
    );

    // Custom mode image upload handler
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#customModeImage",
      async function (e) {
        const file = e.target.files[0];
        if (!file) return;

        try {
          // Read file as data URL for preview
          const reader = new FileReader();
          reader.onload = async function (event) {
            // Show preview
            $("#customModeImagePreview img").attr("src", event.target.result);
            $("#customModeImagePreview").show();

            // Save image to Images folder
            const buffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(buffer);

            // Create simpler filename without special characters
            const timestamp = Date.now();
            const ext = file.name.split(".").pop().toLowerCase();
            const filename = `custom_${timestamp}.${ext}`;

            try {
              const savedFilename = await window.electronAPI.saveImage(
                filename,
                uint8Array,
              );

              // Small delay to ensure file is fully written to disk
              await new Promise((resolve) => setTimeout(resolve, 100));

              customModeImage = savedFilename;
              showAlert("success", "Image uploaded successfully!");
            } catch (error) {
              console.error("Failed to save image:", error);
              showAlert("error", "Failed to save image: " + error.message);
              $("#customModeImagePreview").hide();
              customModeImage = null;
            }
          };
          reader.readAsDataURL(file);
        } catch (error) {
          console.error("Failed to read image:", error);
          showAlert("error", "Failed to read image file");
        }
      },
    );

    // Remove custom mode image handler
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#removeCustomImage",
      function () {
        customModeImage = null;
        $("#customModeImage").val("");
        $("#customModeImagePreview").hide();
        $("#customModeImagePreview img").attr("src", "");
        showAlert("info", "Image removed");
      },
    );

    // Custom mode Pinterest toggle
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#customModePinterestEnabled",
      function () {
        const enabled = $(this).is(":checked");
        if (enabled) {
          $("#customModePinterestBody").show();
          loadCustomModePinterestAccounts();
        } else {
          $("#customModePinterestBody").hide();
          customModePinterestAccountId = null;
          customModePinterestBoardId = null;
          $("#customModePinterestAccount").html('<option value="">Select Account</option>');
          $("#customModePinterestBoard").html('<option value="">Select Board</option>').prop("disabled", true);
        }
      },
    );

    // Custom mode Pinterest account change
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#customModePinterestAccount",
      function () {
        const accountId = $(this).val();
        customModePinterestAccountId = accountId || null;
        customModePinterestBoardId = null;
        $("#customModePinterestBoard").html('<option value="">Select Board</option>').prop("disabled", true);
        if (accountId) {
          loadCustomModePinterestBoards(accountId);
        }
      },
    );

    // Custom mode Pinterest board change
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#customModePinterestBoard",
      function () {
        customModePinterestBoardId = $(this).val() || null;
      },
    );

    // Pinterest event handlers
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#workflowPinterestAccount",
      function () {
        const accountId = $(this).val();

        // Clear selected titles when account changes
        $('[data-role="pinterestTitles"]').html(`
                <div class="text-muted text-center py-3">
                    <i class="material-icons">checklist</i><br>
                    No titles selected
                </div>
            `);
        updatePinterestTitlesButton();
        $("#selectAllTitles").text("Select All");

        if (accountId) {
          loadPinterestBoardsForWorkflow(accountId);
          // Clear available titles until a board is selected
          $("#availablePinterestTitles").html(`
                    <div class="text-muted text-center py-3">
                        <i class="material-icons">title</i><br>
                        Select a board to see available titles
                    </div>
                `);
        } else {
          $("#workflowPinterestBoard")
            .html('<option value="">Select Board</option>')
            .prop("disabled", true);
          $("#loadPinterestTitles").prop("disabled", true);
          $("#availablePinterestTitles").html(`
                    <div class="text-muted text-center py-3">
                        <i class="material-icons">title</i><br>
                        Select account and board to see available titles
                    </div>
                `);
        }
      },
    );

    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#workflowPinterestBoard",
      function () {
        const accountId = $("#workflowPinterestAccount").val();
        const boardId = $(this).val();

        // Clear selected titles when board changes
        $('[data-role="pinterestTitles"]').html(`
                <div class="text-muted text-center py-3">
                    <i class="material-icons">checklist</i><br>
                    No titles selected
                </div>
            `);
        updatePinterestTitlesButton();
        $("#selectAllTitles").text("Select All");

        if (accountId && boardId) {
          loadPinterestTitlesForWorkflow(accountId, boardId);
        }
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#loadPinterestTitles",
      function () {
        const accountId = $("#workflowPinterestAccount").val();
        const boardId = $("#workflowPinterestBoard").val();
        if (accountId && boardId) {
          loadPinterestTitlesForWorkflow(accountId, boardId);
        }
      },
    );

    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#availablePinterestTitles input[type='checkbox']",
      function () {
        const titleId = $(this).data("title-id");
        const titleText = $(this).data("title-text");

        if ($(this).is(":checked")) {
          addSelectedPinterestTitle(titleId, titleText);
        } else {
          $(
            `[data-role="pinterestTitles"] .pinterest-title-item[data-title-id="${titleId}"]`,
          ).remove();
          updatePinterestTitlesButton();

          // Show empty state if no titles
          if (
            $('[data-role="pinterestTitles"] .pinterest-title-item').length ===
            0
          ) {
            $('[data-role="pinterestTitles"]').html(`
                        <div class="text-muted text-center py-3">
                            <i class="material-icons">checklist</i><br>
                            No titles selected
                        </div>
                    `);
          }
        }
      },
    );

    // Select first N titles
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#selectFirstN",
      function () {
        const count = parseInt($("#selectFirstNCount").val()) || 0;
        if (count <= 0) {
          showAlert("warning", "Please enter a valid number");
          return;
        }

        const checkboxes = $(
          "#availablePinterestTitles input[type='checkbox']",
        );
        if (checkboxes.length === 0) {
          showAlert("warning", "No titles available to select");
          return;
        }

        // First uncheck all
        checkboxes.prop("checked", false);

        // Then check the first N
        checkboxes.slice(0, count).each(function () {
          $(this).prop("checked", true).trigger("change");
        });

        const selectedCount = Math.min(count, checkboxes.length);
        showAlert("success", `Selected first ${selectedCount} titles`);

        // Update Select All button text
        if (selectedCount === checkboxes.length) {
          $("#selectAllTitles").text("Deselect All");
        } else {
          $("#selectAllTitles").text("Select All");
        }
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#selectAllTitles",
      function () {
        const checkboxes = $(
          "#availablePinterestTitles input[type='checkbox']",
        );
        const allChecked =
          checkboxes.length > 0 &&
          checkboxes.filter(":checked").length === checkboxes.length;

        if (allChecked) {
          // Uncheck all
          checkboxes.prop("checked", false).trigger("change");
          $(this).text("Select All");
        } else {
          // Check all
          checkboxes.prop("checked", true).trigger("change");
          $(this).text("Deselect All");
        }
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="removePinterestTitle"]',
      function () {
        const titleId = $(this)
          .closest(".pinterest-title-item")
          .data("title-id");
        $(this).closest(".pinterest-title-item").remove();

        // Uncheck corresponding checkbox
        $(`#availablePinterestTitles input[data-title-id="${titleId}"]`).prop(
          "checked",
          false,
        );

        updatePinterestTitlesButton();

        // Show empty state if no titles
        if (
          $('[data-role="pinterestTitles"] .pinterest-title-item').length === 0
        ) {
          $('[data-role="pinterestTitles"]').html(`
                    <div class="text-muted text-center py-3">
                        <i class="material-icons">checklist</i><br>
                        No titles selected
                    </div>
                `);
        }
      },
    );

    // ========== FB Insights Mode Event Handlers ==========

    // CSV Browse button - use native dialog
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#fbinsightsCsvBrowse",
      async function (e) {
        e.preventDefault();
        e.stopPropagation();
        await selectFbInsightsCsvFile();
      },
    );

    // CSV Dropzone click - use native dialog
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#fbinsightsCsvDropzone",
      async function (e) {
        if (
          e.target.tagName !== "BUTTON" &&
          e.target.id !== "fbinsightsCsvBrowse"
        ) {
          e.preventDefault();
          e.stopPropagation();
          await selectFbInsightsCsvFile();
        }
      },
    );

    // Function to select CSV file using native dialog
    async function selectFbInsightsCsvFile() {
      try {
        const selectResult =
          await window.electronAPI.selectFacebookInsightsCsv();

        if (!selectResult.success) {
          if (!selectResult.canceled) {
            showAlert("error", selectResult.error || "Failed to select file");
          }
          return;
        }

        await handleFbInsightsCsvPath(selectResult.filePath);
      } catch (error) {
        console.error("Error selecting CSV:", error);
        showAlert("error", "Failed to select file: " + error.message);
      }
    }

    // CSV Drag & Drop
    $("#workflows-container").on(
      "dragover" + WF_NAMESPACE,
      "#fbinsightsCsvDropzone",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).addClass("dragover");
      },
    );

    $("#workflows-container").on(
      "dragleave" + WF_NAMESPACE,
      "#fbinsightsCsvDropzone",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).removeClass("dragover");
      },
    );

    $("#workflows-container").on(
      "drop" + WF_NAMESPACE,
      "#fbinsightsCsvDropzone",
      async function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).removeClass("dragover");

        // Drag & drop doesn't provide file path in Electron with context isolation
        // Show a message to use the browse button instead
        showAlert(
          "info",
          "Please use the Browse Files button to select your CSV file.",
        );
      },
    );

    // Handle CSV file path (from native dialog)
    async function handleFbInsightsCsvPath(filePath, fileName) {
      try {
        showLoading("Parsing CSV file...");

        const result =
          await window.electronAPI.parseFacebookInsightsCsv(filePath);
        removeLoading();

        if (!result.success) {
          showAlert("error", result.error || "Failed to parse CSV");
          return;
        }

        if (result.posts.length === 0) {
          showAlert(
            "warning",
            "No valid posts found in CSV. Make sure it contains Facebook post links.",
          );
          return;
        }

        fbInsightsCsvData = result;

        // Extract filename from path
        const displayName = fileName || filePath.split(/[\\/]/).pop();

        // Update file info display
        $("#fbinsightsCsvDropzone").hide();
        $("#fbinsightsCsvInfo").show();
        $("#fbinsightsCsvInfo .file-name").text(displayName);
        $("#fbinsightsCsvInfo .file-size").text(
          `${result.posts.length} posts found`,
        );

        // Move to step 2
        setFbInsightsStep(2);

        // Update post count max
        $("#fbinsightsPostCount").attr("max", result.posts.length);
        $("#fbinsightsAvailableCount").text(
          `${result.posts.length} posts available`,
        );

        // Preview posts
        updateFbInsightsPostsPreview();

        showAlert("success", `Loaded ${result.posts.length} posts from CSV`);
      } catch (error) {
        removeLoading();
        console.error("Error parsing CSV:", error);
        showAlert("error", "Failed to parse CSV file: " + error.message);
      }
    }

    // Remove CSV file
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#fbinsightsCsvRemove",
      function () {
        resetFbInsightsState();
      },
    );

    // Post count change
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#fbinsightsPostCount",
      function () {
        updateFbInsightsPostsPreview();
      },
    );

    // Back to Step 1
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#fbinsightsBackToStep1",
      function () {
        setFbInsightsStep(1);
      },
    );

    // Back to Step 2
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#fbinsightsBackToStep2",
      function () {
        setFbInsightsStep(2);
      },
    );

    // Fetch Images button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#fbinsightsFetchImages",
      async function () {
        if (!fbInsightsCsvData || !fbInsightsCsvData.posts) {
          showAlert("error", "No posts loaded");
          return;
        }

        const count = parseInt($("#fbinsightsPostCount").val()) || 10;
        const postsToProcess = fbInsightsCsvData.posts.slice(0, count);

        if (postsToProcess.length === 0) {
          showAlert("warning", "No posts to process");
          return;
        }

        // Move to step 3
        setFbInsightsStep(3);

        // Clear log
        $("#fbinsightsLog").empty();
        addFbInsightsLogEntry(
          `Starting to process ${postsToProcess.length} posts...`,
          "info",
        );

        // Set up progress listener
        window.electronAPI.onFbInsightsProgress((data) => {
          // Update progress bar
          $("#fbinsightsProgressBar").css("width", `${data.percent}%`);
          $("#fbinsightsProgressPercent").text(`${data.percent}%`);
          $("#fbinsightsProgressText").text(
            `Processing post ${data.current} of ${data.total}...`,
          );

          // Update status
          let statusIcon = "autorenew";
          let statusClass = "spin";
          if (data.status === "success") {
            statusIcon = "check_circle";
            statusClass = "";
          } else if (data.status === "error") {
            statusIcon = "error";
            statusClass = "";
          }

          if (data.status !== "complete") {
            $("#fbinsightsCurrentStatus").html(`
                        <i class="material-icons ${statusClass}">${statusIcon}</i>
                        <span>${data.message}</span>
                    `);
          }

          // Add log entry
          addFbInsightsLogEntry(data.message, data.type);
        });

        try {
          const result =
            await window.electronAPI.processFacebookInsightsPosts(
              postsToProcess,
            );

          // Remove listener
          window.electronAPI.removeFbInsightsProgressListeners();

          if (result.success) {
            fbInsightsProcessedPosts = result.results;

            const successCount = result.results.filter((r) => r.success).length;
            addFbInsightsLogEntry(
              `Completed! ${successCount}/${result.results.length} posts processed successfully.`,
              "success",
            );

            // Move to step 4
            setTimeout(() => {
              setFbInsightsStep(4);
              updateFbInsightsReadyPosts();
            }, 1000);
          } else {
            addFbInsightsLogEntry(`Error: ${result.error}`, "error");
            showAlert("error", result.error || "Failed to process posts");
          }
        } catch (error) {
          window.electronAPI.removeFbInsightsProgressListeners();
          console.error("Error processing posts:", error);
          addFbInsightsLogEntry(`Error: ${error.message}`, "error");
          showAlert("error", "Failed to process posts: " + error.message);
        }
      },
    );

    // Select all checkbox in ready posts
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#fbinsightsSelectAll",
      function () {
        const checked = $(this).is(":checked");
        $(".fbinsights-post-check:not(:disabled)").prop("checked", checked);
        updateFbInsightsStartButton();
      },
    );

    // Individual post checkbox
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      ".fbinsights-post-check",
      function () {
        updateFbInsightsStartButton();

        // Update select all state
        const allChecked =
          $(".fbinsights-post-check:not(:disabled)").length ===
          $(".fbinsights-post-check:checked").length;
        $("#fbinsightsSelectAll").prop("checked", allChecked);
      },
    );

    // Post multiplier input
    $("#workflows-container").on(
      "input" + WF_NAMESPACE,
      "#fbinsightsMultiplier",
      function () {
        updateFbInsightsStartButton();
      },
    );

    // Retry Failed button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#fbinsightsRetryFailed",
      async function () {
        // Get failed posts from the processed results
        const failedPosts = fbInsightsProcessedPosts.filter((p) => !p.success);

        if (failedPosts.length === 0) {
          showAlert("info", "No failed posts to retry");
          return;
        }

        // Disable retry button during processing
        $(this)
          .prop("disabled", true)
          .html('<i class="material-icons spin">autorenew</i> Retrying...');

        // Add log entry
        addFbInsightsLogEntry(
          `Retrying ${failedPosts.length} failed posts...`,
          "info",
        );

        // Set up progress listener
        window.electronAPI.onFbInsightsProgress((data) => {
          addFbInsightsLogEntry(data.message, data.type);
        });

        try {
          const result =
            await window.electronAPI.processFacebookInsightsPosts(failedPosts);

          // Remove listener
          window.electronAPI.removeFbInsightsProgressListeners();

          if (result.success) {
            // Merge retry results back into the original array
            const retryResultsMap = new Map();
            result.results.forEach((r) => {
              retryResultsMap.set(r.permalink, r);
            });

            // Update original processed posts with retry results
            fbInsightsProcessedPosts = fbInsightsProcessedPosts.map((post) => {
              if (!post.success && retryResultsMap.has(post.permalink)) {
                return retryResultsMap.get(post.permalink);
              }
              return post;
            });

            const newSuccessCount = result.results.filter(
              (r) => r.success,
            ).length;
            const stillFailed = result.results.filter((r) => !r.success).length;

            addFbInsightsLogEntry(
              `Retry completed! ${newSuccessCount} recovered, ${stillFailed} still failed.`,
              newSuccessCount > 0 ? "success" : "warning",
            );

            // Refresh the posts table
            updateFbInsightsReadyPosts();

            if (newSuccessCount > 0) {
              showAlert("success", `Recovered ${newSuccessCount} posts!`);
            } else if (stillFailed > 0) {
              showAlert(
                "warning",
                `Still ${stillFailed} failed posts. You can try again.`,
              );
            }
          } else {
            addFbInsightsLogEntry(`Retry error: ${result.error}`, "error");
            showAlert("error", result.error || "Retry failed");
          }
        } catch (error) {
          window.electronAPI.removeFbInsightsProgressListeners();
          console.error("Error retrying posts:", error);
          addFbInsightsLogEntry(`Retry error: ${error.message}`, "error");
          showAlert("error", "Retry failed: " + error.message);
        }

        // Re-enable retry button
        $("#fbinsightsRetryFailed")
          .prop("disabled", false)
          .html('<i class="material-icons">refresh</i> Retry Failed');
      },
    );

    // ========== End FB Insights Mode Event Handlers ==========

    // ========== Smart Split Mode Event Handlers ==========

    // Checkbox change in smartsplit table
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      '#smartsplit-table input[type="checkbox"]',
      function () {
        updateSmartSplitSelectedCount();
      },
    );

    // Provider change — update analyze button state
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#smartsplitProvider",
      function () {
        updateSmartSplitSelectedCount();
      },
    );

    // Analyze button click
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#smartsplitAnalyzeBtn",
      function () {
        analyzeSmartSplitPosts();
      },
    );

    // Smart Split confirmed event — triggered from review modal
    $("#workflows-container").on(
      "smartsplit-confirmed" + WF_NAMESPACE,
      "#startAutomation",
      async function () {
        const posts = window._smartSplitPosts;
        delete window._smartSplitPosts;
        if (!posts || posts.length === 0) return;

        const automationId = currentAutomationId;
        if (!automationId) {
          showAlert("error", window.I18n?.t("workflows.errors.no_automation") || "Please select an automation first");
          return;
        }

        // Validate workflow pre-flight
        const valid = await validateWorkflowPreflight(automationId, posts);
        if (!valid) return;

        const hasMidjourney = await automationHasMidjourneyNode(automationId);
        const skipImageChoosing = hasMidjourney
          ? await showWorkflowSkipModal()
          : true;
        if (skipImageChoosing === null) return;

        const workflowId = genId(10);
        if (skipImageChoosing) {
          await window.electronAPI.setWorkflowSkipMode(workflowId, true);
        }

        // Image processing for smartsplit posts
        const images = posts.map((p) => p.postImg);
        let processedImages = [...images];

        const processingOptions = await showImageProcessingOptionsModal();
        if (processingOptions === null) return;

        if (processingOptions.crop) {
          await showPhaseTransition("start", "cropping");
          processedImages = await cropImagesSequentially(processedImages);
        }
        if (processingOptions.inpaint) {
          if (processingOptions.crop) {
            await showPhaseTransition("cropping", "inpainting");
          } else {
            await showPhaseTransition("start", "inpainting");
          }
          processedImages = await inpaintImagesSequentially(processedImages);
        }

        posts.forEach((post, i) => {
          post.postImg = processedImages[i];
        });

        $(".workflow-preview, #posts-gallery").hide();

        const shuffledPosts = shuffleArray(posts);
        console.log(`[Smart Split] Starting workflow with ${shuffledPosts.length} posts`);

        const newWf = {
          id: workflowId,
          automationId,
          automationLabel: getAutomationName(automationId),
          status: "pending",
          progress: 0,
          posts: shuffledPosts,
          createdAt: nowIso(),
        };

        allWorkflows[workflowId] = newWf;
        await saveWorkflow(workflowId, newWf);
        await updateWorkflowStatus(workflowId, "running", 0);

        await window.electronAPI.executeAutomation(
          workflowId,
          automationId,
          shuffledPosts,
        );

        showLogs(workflowId);
        renderWorkflows();
      },
    );

    // ========== End Smart Split Mode Event Handlers ==========

    // ========== ISE (Image Search Engines) Mode Event Handlers ==========

    // ISE Search Form Submit
    $("#workflows-container").on(
      "submit" + WF_NAMESPACE,
      "#iseSearchForm",
      function (e) {
        e.preventDefault();
        if (!iseIsSearching) {
          performIseSearch();
        }
      },
    );

    // ISE Image Card Click - Toggle Selection
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".ise-image-card",
      function (e) {
        // Don't toggle if clicking on action buttons
        if ($(e.target).closest(".ise-image-actions").length > 0) return;

        const imageId = $(this).data("id");
        toggleIseImageSelection(imageId);
      },
    );

    // ISE Select Button Click
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".ise-btn-select",
      function (e) {
        e.stopPropagation();
        const imageId = $(this).closest(".ise-image-card").data("id");
        toggleIseImageSelection(imageId);
      },
    );

    // ISE Hide Button Click
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".ise-btn-hide",
      function (e) {
        e.stopPropagation();
        const imageId = $(this).closest(".ise-image-card").data("id");
        hideIseImage(imageId);
      },
    );

    // ISE Select All Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#iseSelectAll",
      function () {
        iseSearchResults.forEach(img => {
          iseSelectedImages.add(img.id);
        });
        $(".ise-image-card").addClass("selected");
        $(".ise-image-card .ise-btn-select i").text("check_circle");
        updateIseSelectedCount();
      },
    );

    // ISE Deselect All Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#iseDeselectAll",
      function () {
        iseSelectedImages.clear();
        $(".ise-image-card").removeClass("selected");
        $(".ise-image-card .ise-btn-select i").text("add_circle");
        updateIseSelectedCount();
      },
    );

    // ISE Clear Hidden Images Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#iseClearHiddenBtn",
      async function () {
        const confirmed = await confirmPrompt(window.I18n?.t("workflows.ise.confirm_clear_hidden") || "Clear all hidden images? They will appear in search results again.");
        if (!confirmed) {
          return;
        }

        try {
          await window.electronAPI.clearHiddenIseImages();
          showAlert("success", window.I18n?.t("workflows.ise.hidden_cleared") || "Hidden images cleared. Search again to see them.");
        } catch (error) {
          console.error("[ISE] Failed to clear hidden images:", error);
          showAlert("error", "Failed to clear hidden images");
        }
      },
    );

    // ISE AI Generator Toggle
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#iseAiToggle",
      async function () {
        const $generator = $(".ise-ai-generator");
        const $body = $("#iseAiBody");
        const isExpanded = $generator.hasClass("expanded");

        if (isExpanded) {
          $body.slideUp(200);
          $generator.removeClass("expanded");
        } else {
          // Check AI availability when opening
          await initIseAiProviders();
          $body.slideDown(200);
          $generator.addClass("expanded");
        }
      },
    );

    // ISE AI Provider Change
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#iseAiProvider",
      function () {
        updateIseAiModels($(this).val());
      },
    );

    // ISE AI Generate Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#iseAiGenerateBtn",
      async function () {
        const niche = $("#iseAiNiche").val().trim();
        if (!niche) {
          showAlert("error", window.I18n?.t("workflows.ise.ai_enter_niche") || "Please enter a niche/topic");
          return;
        }

        const language = $("#iseAiLanguage").val();
        const count = parseInt($("#iseAiCount").val()) || 5;
        const provider = $("#iseAiProvider").val();
        const model = $("#iseAiModel").val();

        // Show spinner
        $("#iseAiGenerateBtn").hide();
        $("#iseAiSpinner").show();

        try {
          const result = await window.electronAPI.generateIseQueries({
            niche,
            language,
            count,
            provider,
            model,
          });

          if (result.success && result.queries.length > 0) {
            // Append queries to the keywords textarea
            const $keywords = $("#iseKeywords");
            const existing = $keywords.val().trim();
            const newQueries = result.queries.join("\n");
            
            if (existing) {
              $keywords.val(existing + "\n" + newQueries);
            } else {
              $keywords.val(newQueries);
            }

            showAlert("success", window.I18n?.t("workflows.ise.ai_generated_success", { count: result.queries.length }) || `Generated ${result.queries.length} search queries!`);
          } else {
            showAlert("error", result.error || window.I18n?.t("workflows.ise.ai_generate_failed") || "Failed to generate queries");
          }
        } catch (error) {
          console.error("[ISE] AI generation error:", error);
          showAlert("error", `AI Error: ${error.message}`);
        } finally {
          $("#iseAiGenerateBtn").show();
          $("#iseAiSpinner").hide();
        }
      },
    );

    // ========== End ISE Mode Event Handlers ==========

    // ========== Google Trends Mode Event Handlers ==========

    // Google Trends Fetch Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#gtrendsFetchBtn",
      function () {
        fetchGoogleTrends(false);
      },
    );

    // Google Trends Force Refresh Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#gtrendsRefreshBtn",
      function () {
        fetchGoogleTrends(true);
      },
    );

    // Google Trends Open Browser Button (for captcha solving)
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#gtrendsOpenBrowserBtn",
      function () {
        openGoogleTrendsBrowser();
      },
    );

    // Google Trends Topic Card Click - Toggle Selection
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".gtrends-topic-card",
      function (e) {
        // Don't toggle if clicking on action buttons
        if ($(e.target).closest(".gtrends-topic-actions").length > 0) return;

        const title = $(this).data("title");
        toggleGtrendsTopicSelection(title);
      },
    );

    // Google Trends Select Button Click
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".gtrends-btn-select",
      function (e) {
        e.stopPropagation();
        const title = $(this).closest(".gtrends-topic-card").data("title");
        toggleGtrendsTopicSelection(title);
      },
    );

    // Google Trends Select All Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#gtrendsSelectAll",
      function () {
        gtrendsFetchedTopics.forEach(topic => {
          gtrendsSelectedTopics.add(topic.title);
        });
        $(".gtrends-topic-card").addClass("selected");
        $(".gtrends-topic-card .gtrends-btn-select i").text("check_circle");
        updateGtrendsSelectedCount();
      },
    );

    // Google Trends Deselect All Button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#gtrendsDeselectAll",
      function () {
        gtrendsSelectedTopics.clear();
        $(".gtrends-topic-card").removeClass("selected");
        $(".gtrends-topic-card .gtrends-btn-select i").text("add_circle");
        updateGtrendsSelectedCount();
      },
    );

    // ========== End Google Trends Mode Event Handlers ==========

    // ========== Pinterest Feed Spy Mode Event Handlers ==========

    // Start scraping button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#pfeedspyStartBtn",
      function () {
        startPfeedSpyScraping();
      },
    );

    // Stop scraping button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#pfeedspyStopBtn",
      function () {
        if (pfeedspyIsRunning) {
          pfeedspyStopRequested = true;
          $(this).prop("disabled", true);
          $(this).find("span").text(window.I18n?.t("workflows.pfeedspy.stopping") || "Stopping...");
          // Force-finalize after 3s in case the fetch is still blocking
          setTimeout(() => {
            if (pfeedspyIsRunning) {
              pfeedspyFinalizeScraping();
            }
          }, 3000);
        }
      },
    );

    // Source radio: show/hide account selector
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "input[name='pfeedspySource']",
      function () {
        if ($(this).val() === "account") {
          $("#pfeedspyAccountSelectWrap").show();
        } else {
          $("#pfeedspyAccountSelectWrap").hide();
        }
      },
    );

    // "Hide used pins" checkbox — re-render the grid immediately.
    // There are two mirrored checkboxes (config card + results header); keep
    // them in sync so toggling either one applies the same filter.
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#pfeedspyHideUsed, #pfeedspyHideUsedResults",
      function () {
        const checked = $(this).is(":checked");
        $("#pfeedspyHideUsed, #pfeedspyHideUsedResults").prop("checked", checked);
        if (pfeedspyAllPins.length === 0) return;
        const filtered = pfeedspyGetFilteredPins(pfeedspyAllPins);
        const sorted = [...filtered].sort((a, b) => pfeedspyTrendScore(b) - pfeedspyTrendScore(a));
        renderPfeedSpyResults(sorted, pfeedspyIsRunning);
        if (!pfeedspyIsRunning) pfeedspyUpdateSelectionUI();
      },
    );

    // Input type radio: hide/show text options when "Image only" selected
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "input[name='pfeedspyInputType']",
      function () {
        const val = $(this).val();
        if (val === "image") {
          $("#pfeedspyTextOptions").hide();
        } else {
          $("#pfeedspyTextOptions").show();
        }
        pfeedspyUpdateAiGenVisibility();
      },
    );

    // Text type radio: hide AI gen if "description" selected
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "input[name='pfeedspyTextType']",
      function () {
        pfeedspyUpdateAiGenVisibility();
      },
    );

    // AI gen checkbox: show/hide provider + model selects
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#pfeedspyAiGenEnabled",
      function () {
        if ($(this).is(":checked")) {
          $("#pfeedspyAiGenBody").slideDown(180);
        } else {
          $("#pfeedspyAiGenBody").slideUp(180);
        }
      },
    );

    // AI gen provider change: update model list
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#pfeedspyAiGenProvider",
      function () {
        updatePfeedSpyAiModels($(this).val());
      },
    );

    // AI gen — "Generate Titles" button click
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#pfeedspyAiGenBtn",
      async function () {
        const selPins = pfeedspyAllPins.filter((p) => pfeedspySelectedIds.has(String(p.id)));
        if (selPins.length === 0) {
          showAlert("error", window.I18n?.t("workflows.pfeedspy.no_pins_selected") || "Please select at least one pin first.");
          return;
        }
        const provider = $("#pfeedspyAiGenProvider").val();
        const model = $("#pfeedspyAiGenModel").val();
        // total = grand total of titles (originals + AI)
        const totalTitles = Math.max(selPins.length + 1, parseInt($("#pfeedspyAiGenCount").val()) || 10);
        const totalAiSlots = totalTitles - selPins.length;
        if (!provider || !model) {
          showAlert("error", window.I18n?.t("workflows.pfeedspy.ai_gen_no_provider") || "Please select an AI provider and model.");
          return;
        }

        // Distribute AI title slots proportionally to trend score (higher trend → more AI titles)
        const trendScores = selPins.map((p) => Math.max(pfeedspyTrendScore(p), 0.001));
        const totalTrendScore = trendScores.reduce((a, b) => a + b, 0);
        const perPinAi = trendScores.map((s) => Math.max(1, Math.round((s / totalTrendScore) * totalAiSlots)));
        // Fix rounding so sum exactly equals totalAiSlots
        let aiDiff = totalAiSlots - perPinAi.reduce((a, b) => a + b, 0);
        const sortedByScore = trendScores.map((_, i) => i).sort((a, b) => trendScores[b] - trendScores[a]);
        for (let i = 0; aiDiff !== 0 && i < sortedByScore.length; i++) {
          perPinAi[sortedByScore[i]] += aiDiff > 0 ? 1 : -1;
          aiDiff += aiDiff > 0 ? -1 : 1;
        }

        // Collect titles of all already-used pins (from current session) to avoid duplicates
        const usedTitles = pfeedspyAllPins
          .filter((p) => pfeedspyUsedIds.has(p.id) && (p.title || p.description))
          .map((p) => (p.title || p.description || "").trim())
          .filter(Boolean);

        // Request extra titles as buffer so filtering doesn't leave us short
        const maxPerPin = Math.max(...perPinAi);
        const buffer = Math.min(usedTitles.length + 2, 8);
        const requestCount = maxPerPin + buffer;

        $("#pfeedspyAiGenBtn").prop("disabled", true).css("opacity", "0.55");
        $("#pfeedspyAiGenSpinner").show();
        try {
          const result = await window.electronAPI.pfeedSpyGenerateTitles({
            pins: selPins,
            provider,
            model,
            titlesPerPin: requestCount,
            usedTitles,
          });
          if (!result.success) {
            showAlert("error", `AI generation failed: ${result.error}`);
            return;
          }

        // Client-side dedup: only prevent the AI from returning the exact same
          // title as the pin being processed (a verbatim copy of the original).
          // Historical used-title dedup is handled by the prompt's avoid section.
          const currentPinTitlesLower = new Set(
            selPins.map((p) => (p.title || p.description || "").trim().toLowerCase()).filter(Boolean)
          );

          pfeedspyAiGenTitles = [];
          for (let i = 0; i < selPins.length; i++) {
            const pin = selPins[i];
            const group = result.grouped[i] || { pinId: pin.id, titles: [] };
            // Original pin title first
            pfeedspyAiGenTitles.push({ id: genId(8), pinId: pin.id, title: pin.title || pin.description || "", isOriginal: true });
            // AI generated titles — skip exact copies of the original titles, keep up to perPinAi[i]
            let added = 0;
            for (const t of group.titles) {
              if (added >= perPinAi[i]) break;
              if (!currentPinTitlesLower.has(t.toLowerCase())) {
                pfeedspyAiGenTitles.push({ id: genId(8), pinId: pin.id, title: t, isOriginal: false });
                added++;
              }
            }
          }
          renderPfeedSpyAiTitles();
          $("#pfeedspyAiGenResults").show();
        } catch (e) {
          showAlert("error", `AI generation error: ${e.message}`);
        } finally {
          $("#pfeedspyAiGenBtn").prop("disabled", false).css("opacity", "");
          $("#pfeedspyAiGenSpinner").hide();
        }
      },
    );

    // AI gen — toggle group expand/collapse
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".pfeedspy-ai-title-group-header",
      function (e) {
        // Don't collapse when clicking the Add button
        if ($(e.target).closest(".pfeedspy-ai-title-add").length) return;
        const $group = $(this).closest(".pfeedspy-ai-title-group");
        const $body = $group.find(".pfeedspy-ai-title-items-body");
        if ($group.hasClass("collapsed")) {
          $group.removeClass("collapsed");
          $body.show();
        } else {
          $group.addClass("collapsed");
          $body.hide();
        }
      },
    );

    // AI gen — remove individual title item
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".pfeedspy-ai-title-remove",
      function () {
        const itemId = String($(this).data("item-id"));
        pfeedspyAiGenTitles = pfeedspyAiGenTitles.filter((t) => t.id !== itemId);
        renderPfeedSpyAiTitles();
        if (pfeedspyAiGenTitles.length === 0) $("#pfeedspyAiGenResults").hide();
      },
    );

    // AI gen — add a blank custom title to a specific pin's group
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".pfeedspy-ai-title-add",
      function () {
        const pinId = String($(this).data("pin-id"));
        const newItem = { id: genId(8), pinId, title: "", isOriginal: false };
        // Insert right after the last item of this pin's group
        const lastIdx = pfeedspyAiGenTitles.map((t, i) => t.pinId === pinId ? i : -1).filter(i => i >= 0).pop();
        if (lastIdx !== undefined) {
          pfeedspyAiGenTitles.splice(lastIdx + 1, 0, newItem);
        } else {
          pfeedspyAiGenTitles.push(newItem);
        }
        renderPfeedSpyAiTitles();
        // Focus the newly added title row for immediate typing
        const $newRow = $(`[data-item-id="${newItem.id}"] .pfeedspy-ai-title-text`);
        if ($newRow.length) {
          $newRow[0].focus();
          // Place cursor at end
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents($newRow[0]);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      },
    );

    // AI gen — sync contenteditable edits back to state on blur
    $("#workflows-container").on(
      "blur" + WF_NAMESPACE,
      ".pfeedspy-ai-title-text",
      function () {
        const itemId = String($(this).data("item-id"));
        const item = pfeedspyAiGenTitles.find((t) => t.id === itemId);
        if (item) item.title = $(this).text().trim() || item.title;
      },
    );

    // AI gen — regenerate button: clear results and re-run generate
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#pfeedspyAiGenRegenBtn",
      function () {
        pfeedspyAiGenTitles = [];
        $("#pfeedspyAiGenResults").hide();
        $("#pfeedspyAiGenBtn").trigger("click");
      },
    );

    // pfeedspy Pinterest toggle: show/hide account+board selects
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#pfeedspyPinterestEnabled",
      function () {
        if ($(this).is(":checked")) {
          loadPfeedSpyPinterestAccounts();
          $("#pfeedspyPinterestBody").slideDown(180);
        } else {
          $("#pfeedspyPinterestBody").slideUp(180);
          pfeedspyPinterestAccountId = null;
          pfeedspyPinterestBoardId = null;
        }
      },
    );

    // pfeedspy Pinterest account change: load boards
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#pfeedspyPinterestAccount",
      function () {
        const accountId = $(this).val();
        pfeedspyPinterestAccountId = accountId || null;
        pfeedspyPinterestBoardId = null;
        $("#pfeedspyPinterestBoard").html('<option value="">Select Board</option>').prop("disabled", true);
        if (accountId) loadPfeedSpyPinterestBoards(accountId);
      },
    );

    // pfeedspy Pinterest board change: store selection
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#pfeedspyPinterestBoard",
      function () {
        pfeedspyPinterestBoardId = $(this).val() || null;
      },
    );

    // Pin card click — toggle selection (only when not scraping)
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#pfeedspyResultsGrid .pfeedspy-pin-card",
      function () {
        if (pfeedspyIsRunning) return; // not selectable during live scraping
        const id = String($(this).data("pin-id"));
        if (!id) return;
        if (pfeedspySelectedIds.has(id)) {
          pfeedspySelectedIds.delete(id);
          $(this).removeClass("selected");
        } else {
          pfeedspySelectedIds.add(id);
          $(this).addClass("selected");
        }
        const count = pfeedspySelectedIds.size;
        $("#pfeedspySelectedCount").text(count);
        // If AI titles are generated they own the Start count — don't override with pin selection count
        if (pfeedspyAiGenTitles.length === 0) pfeedspyUpdatePreviewCount(count);
      },
    );

    // Auto-select top N button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#pfeedspyAutoSelectBtn",
      function () {
        const n = Math.max(1, parseInt($("#pfeedspyAutoSelectCount").val()) || 10);
        pfeedspySelectedIds = new Set();
        const top = pfeedspyAllPins.slice(0, n);
        for (const pin of top) pfeedspySelectedIds.add(String(pin.id));
        pfeedspyUpdateSelectionUI();
      },
    );

    // Select all button — only select pins that pass the current filters
    // (e.g. when "Hide used pins" is checked, used/hidden pins are excluded).
    $("#workflows-container").on("click" + WF_NAMESPACE, "#pfeedspySelectAllBtn", function () {
      pfeedspySelectedIds = new Set(pfeedspyGetFilteredPins(pfeedspyAllPins).map((p) => String(p.id)));
      pfeedspyUpdateSelectionUI();
    });

    // Clear selection button
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#pfeedspyClearSelectBtn",
      function () {
        pfeedspySelectedIds = new Set();
        pfeedspyUpdateSelectionUI();
      },
    );

    // ── Step 2: Next / Back ────────────────────────────────────────────────
    $("#workflows-container").on("click" + WF_NAMESPACE, "#pfeedspyNextBtn", function () {
      pfeedspyGoToStep2();
    });
    $("#workflows-container").on("click" + WF_NAMESPACE, "#pfeedspyBackBtn", function () {
      pfeedspyGoToStep1();
    });

    // ── Step 2: Checkbox change ────────────────────────────────────────────
    $("#workflows-container").on("change" + WF_NAMESPACE, "#pfeedspyStep2List .pfeedspy-s2-cb", function () {
      const itemId = String($(this).data("item-id"));
      const item = pfeedspyStep2Items.find((i) => i.id === itemId);
      if (item) item.checked = $(this).is(":checked");
      pfeedspyStep2UpdateCount();
    });

    // ── Step 2: Check all / Uncheck all ───────────────────────────────────
    $("#workflows-container").on("click" + WF_NAMESPACE, "#pfeedspyS2CheckAll", function () {
      pfeedspyStep2Items.forEach((i) => { i.checked = true; });
      pfeedspyRenderStep2List();
      pfeedspyStep2UpdateCount();
    });
    $("#workflows-container").on("click" + WF_NAMESPACE, "#pfeedspyS2UncheckAll", function () {
      pfeedspyStep2Items.forEach((i) => { i.checked = false; });
      pfeedspyRenderStep2List();
      pfeedspyStep2UpdateCount();
    });

    // ── Step 2: Provider change ────────────────────────────────────────────
    $("#workflows-container").on("change" + WF_NAMESPACE, "#pfeedspyS2Provider", function () {
      pfeedspyS2UpdateModels($(this).val());
    });

    // ── Step 2: Generate AI titles ─────────────────────────────────────────
    $("#workflows-container").on("click" + WF_NAMESPACE, "#pfeedspyS2GenerateBtn", async function () {
      const provider = $("#pfeedspyS2Provider").val();
      const model = $("#pfeedspyS2Model").val();
      const totalTitles = Math.max(1, parseInt($("#pfeedspyS2TotalTitles").val()) || 10);
      if (!provider || !model) {
        showAlert("error", "Please select an AI provider and model.");
        return;
      }
      const selPins = pfeedspyAllPins.filter((p) => pfeedspySelectedIds.has(String(p.id)));
      if (selPins.length === 0) {
        showAlert("error", "No pins in session.");
        return;
      }

      // ── Compute per-pin count and trim to exact total ─────────────────────
      // Ask the AI for ceil(aiTotal/pins) each — slight over-request — then
      // trim the collected AI titles client-side to hit the exact aiTotal.
      const aiTotal = Math.max(0, totalTitles - selPins.length);
      if (aiTotal === 0) {
        showAlert("warning", "Total titles is less than or equal to the number of selected pins — no AI titles to generate.");
        return;
      }
      const titlesPerPin = Math.ceil(aiTotal / selPins.length);

      const usedTitles = pfeedspyAllPins
        .filter((p) => pfeedspyUsedIds.has(String(p.id)) && (p.title || p.description))
        .map((p) => (p.title || p.description || "").trim())
        .filter(Boolean);

      $(this).prop("disabled", true).css("opacity", "0.55");
      $("#pfeedspyS2GenSpinner").show();
      try {
        const result = await window.electronAPI.pfeedSpyGenerateTitles({
          pins: selPins, provider, model, titlesPerPin, usedTitles,
        });
        if (!result.success) {
          showAlert("error", `AI generation failed: ${result.error}`);
          return;
        }
        // Collect all AI titles flat, then trim to exactly aiTotal
        const origItems = pfeedspyStep2Items.filter((i) => i.isOriginal);
        const allAiFlat = [];
        for (let idx = 0; idx < selPins.length; idx++) {
          const pin = selPins[idx];
          const titles = result.grouped?.[idx]?.titles || [];
          for (const t of titles) {
            allAiFlat.push({ id: genId(8), pinId: pin.id, title: t, isOriginal: false, checked: true });
          }
        }
        // Trim to exact aiTotal (round-robin removal from the end of each pin's group)
        while (allAiFlat.length > aiTotal) allAiFlat.pop();

        const newAiItems = allAiFlat;
        // Interleave: orig first then its AI titles
        pfeedspyStep2Items = [];
        for (const origItem of origItems) {
          pfeedspyStep2Items.push(origItem);
          pfeedspyStep2Items.push(...newAiItems.filter((i) => i.pinId === origItem.pinId));
        }
        pfeedspyRenderStep2List();
        pfeedspyStep2UpdateCount();
      } catch (e) {
        showAlert("error", `AI generation error: ${e.message}`);
      } finally {
        $(this).prop("disabled", false).css("opacity", "");
        $("#pfeedspyS2GenSpinner").hide();
      }
    });

    // ── Step 2: Title contenteditable blur sync ────────────────────────────
    $("#workflows-container").on("blur" + WF_NAMESPACE, "#pfeedspyStep2List .pfeedspy-s2-item-title[contenteditable]", function () {
      const itemId = String($(this).data("item-id"));
      const item = pfeedspyStep2Items.find((i) => i.id === itemId);
      if (item) item.title = $(this).text().trim() || item.title;
    });

    // ── Step 1: Publish account / board ───────────────────────────────────
    $("#workflows-container").on("change" + WF_NAMESPACE, "#pfeedspyPublishAccount", function () {
      pfeedspyPinterestAccountId = $(this).val() || null;
      pfeedspyPinterestBoardId = null;
      $("#pfeedspyPublishBoard").html('<option value="">Select board\u2026</option>').prop("disabled", true);
      if (pfeedspyPinterestAccountId) {
        window.electronAPI.readKey("pinterestAccounts").then((accounts) => {
          const acc = accounts?.[pfeedspyPinterestAccountId];
          if (acc?.boards?.length) {
            const opts = acc.boards
              .map((b, i) => `<option value="${escapeHtml(b.id)}">${i + 1}: ${escapeHtml(b.name)}</option>`)
              .join("");
            $("#pfeedspyPublishBoard").html(`<option value="">Select board\u2026</option>${opts}`).prop("disabled", false);
          }
        }).catch(() => {});
      }
    });
    $("#workflows-container").on("change" + WF_NAMESPACE, "#pfeedspyPublishBoard", function () {
      pfeedspyPinterestBoardId = $(this).val() || null;
    });

    // ========== End Pinterest Feed Spy Mode Event Handlers ==========

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#returnBack",
      async function () {
        // If we're in the nodes/logs view, go back to posts view
        if (inLogs && currentWorkflowView) {
          resetLogsView();
          return;
        }

        // Otherwise, go back to workflows list
        resetLogsView();
        $(".workflow-preview, #posts-gallery").hide();
        $("body").removeClass("posts-view-active");
        currentWorkflowView = null;
        currentPostView = null;
        inLogs = false;
        await flushSaves();
        // Clear cache and get fresh data when returning to main view
        const latest = await safeGetWorkflows(true); // Force fresh data
        allWorkflows = latest;
        renderWorkflows();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="showlogs"]',
      function () {
        const postId = $(this).attr("data-id");
        const workflowId = $(this).attr("data-workflow");
        if (currentPostView !== postId || currentWorkflowView !== workflowId)
          openNodes(workflowId, postId);
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="postPage"]',
      function () {
        const workflowId = $(this).data("id");
        const page = Number($(this).data("page")) || 0;
        postsPageByWorkflow.set(workflowId, page);
        renderPosts(workflowId);
      },
    );

    // Pagination removed - all workflows loaded at once

    $("body").on(
      "change" + WF_NAMESPACE,
      "#facebookPlatform, #pinterestPlatform",
      function () {
        const anyChecked =
          $("#facebookPlatform").is(":checked") ||
          $("#pinterestPlatform").is(":checked");
        $("#platformNext").prop("disabled", !anyChecked);
      },
    );

    $("body").on("click" + WF_NAMESPACE, "#platformNext", async function () {
      const $button = $(this);
      $button.prop("disabled", true);
      const workflowId = $(this).attr("data-id");

      // Get checkbox states BEFORE any async operations or DOM changes
      const facebookChecked = $("#facebookPlatform").is(":checked");
      const pinterestChecked = $("#pinterestPlatform").is(":checked");

      // Close the modal
      $(".dynamicModal").remove();

      console.log(
        "[EXPORT DEBUG] facebookChecked:",
        facebookChecked,
        "pinterestChecked:",
        pinterestChecked,
      );

      console.log(
        "[EXPORT DEBUG] platformNext clicked, workflowId:",
        workflowId,
      );
      console.log(
        "[EXPORT DEBUG] allWorkflows keys:",
        Object.keys(allWorkflows),
      );
      console.log(
        "[EXPORT DEBUG] allWorkflows[workflowId]:",
        allWorkflows[workflowId],
      );

      // Always load fresh workflow details from database for export
      // This ensures we get the latest outputs after automation changes or reruns
      console.log("[EXPORT DEBUG] Loading fresh data from database...");
      const fullWorkflow = await loadWorkflowDetail(workflowId);
      console.log("[EXPORT DEBUG] loadWorkflowDetail result:", fullWorkflow);
      console.log("[EXPORT DEBUG] fullWorkflow.posts:", fullWorkflow?.posts);
      console.log(
        "[EXPORT DEBUG] fullWorkflow.posts length:",
        fullWorkflow?.posts?.length,
      );
      
      let wf = fullWorkflow || allWorkflows[workflowId] || {};
      if (fullWorkflow) {
        allWorkflows[workflowId] = wf;
      }

      const allPosts = wf.posts || [];
      console.log("[EXPORT DEBUG] Final allPosts:", allPosts);
      console.log("[EXPORT DEBUG] Final allPosts length:", allPosts.length);

      if (allPosts.length > 0) {
        console.log(
          "[EXPORT DEBUG] First post sample:",
          JSON.stringify(allPosts[0], null, 2),
        );
        console.log(
          "[EXPORT DEBUG] First post facebookOutput:",
          allPosts[0]?.facebookOutput,
        );
        console.log(
          "[EXPORT DEBUG] First post pinterestOutput:",
          allPosts[0]?.pinterestOutput,
        );
      }
      let chosenPosts;
      if (facebookChecked && pinterestChecked) chosenPosts = allPosts;
      else if (facebookChecked)
        chosenPosts = allPosts.filter((p) => p.facebookOutput != null);
      else if (pinterestChecked)
        chosenPosts = allPosts.filter((p) => p.pinterestOutput != null);
      else chosenPosts = [];

      console.log("[EXPORT DEBUG] chosenPosts count:", chosenPosts.length);
      if (chosenPosts.length > 0) {
        console.log(
          "[EXPORT DEBUG] First post sample:",
          JSON.stringify(chosenPosts[0], null, 2),
        );
        console.log(
          "[EXPORT DEBUG] First post has originalInputImage:",
          !!chosenPosts[0].originalInputImage,
        );
        console.log(
          "[EXPORT DEBUG] First post originalInputImage value:",
          chosenPosts[0].originalInputImage,
        );
      }

      const posts = [];
      for (const p of chosenPosts) {
        // Use originalInputImage (unprocessed) for comparison
        // For older workflows without originalInputImage, we cannot show comparison
        const originalImage = p.originalInputImage || null;

        console.log(
          "[EXPORT DEBUG] Post processing - postId:",
          p.postId,
          "originalInputImage:",
          originalImage,
          "postImg:",
          p.postImg,
        );

        if (p.facebookOutput) {
          console.log(
            "[EXPORT DEBUG] Adding facebook post, image:",
            p.facebookOutput.image,
            "originalInput:",
            originalImage,
          );
          posts.push({
            type: "facebook",
            image: p.facebookOutput.image,
            text: p.facebookOutput.text,
            title: p.facebookOutput.title || null,
            video: p.facebookOutput.video || null,
            originalImage: originalImage,
            postId: p.postId,
          });
        }
        if (p.pinterestOutput) {
          console.log(
            "[EXPORT DEBUG] Adding pinterest post, image:",
            p.pinterestOutput.image,
            "originalInput:",
            originalImage,
          );
          posts.push({
            type: "pinterest",
            image: p.pinterestOutput.image,
            title: p.pinterestOutput.title,
            description: p.pinterestOutput.description,
            videoUrl: p.pinterestOutput.videoUrl || null,
            originalImage: originalImage,
            postId: p.postId,
          });
        }
      }

      console.log("[EXPORT DEBUG] Final posts array to export:", posts);
      console.log("[EXPORT DEBUG] Final posts count:", posts.length);

      if (posts.length === 0) {
        console.log("[EXPORT DEBUG] ERROR: No posts to export!");
        $button.prop("disabled", false);
        showAlert("Error", "No posts selected!");
        return;
      }

      // Check if this is a text-only workflow (no images or videos)
      const hasAnyMedia = posts.some((p) =>
        (p.image && typeof p.image === "string" && p.image.trim() !== "") ||
        (p.video && typeof p.video === "string" && p.video.trim() !== "") ||
        (p.videoUrl && typeof p.videoUrl === "string" && p.videoUrl.trim() !== "")
      );
      console.log("[EXPORT DEBUG] Has any media:", hasAnyMedia);

      let newPosts;
      let exportPath = null; // Track the export folder path
      if (hasAnyMedia) {
        // Workflow has images/videos - use the standard export flow
        console.log(
          "[EXPORT DEBUG] Calling exportFlowImages with posts:",
          JSON.stringify(posts, null, 2),
        );
        const exportResult = await window.electronAPI.exportFlowImages(posts);
        console.log("[EXPORT DEBUG] exportFlowImages result:", exportResult);
        removeLoading();
        $button.prop("disabled", false);
        if (!exportResult || exportResult.error) {
          console.log("[EXPORT DEBUG] Export failed, error:", exportResult?.error);
          const errorMessage =
            exportResult?.error || "An error has occurred, please try again!";
          showAlert("Error", errorMessage);
          return;
        }
        // Handle both old format (array) and new format (object with posts and exportPath)
        if (Array.isArray(exportResult)) {
          newPosts = exportResult;
        } else {
          newPosts = exportResult.posts;
          exportPath = exportResult.exportPath;
        }
        
        // Save export indices for each post (maps postId to their exported filename number)
        const exportIndices = newPosts
          .filter(p => p.postId && p.exportIndex)
          .map(p => ({ postId: p.postId, exportIndex: p.exportIndex }));
        if (exportIndices.length > 0) {
          await window.electronAPI.savePostExportIndices(exportIndices);
        }
      } else {
        // Text-only workflow - no images/videos to export, build posts directly
        console.log("[EXPORT DEBUG] Text-only workflow detected, skipping media export");
        removeLoading();
        $button.prop("disabled", false);
        newPosts = posts.map((p, i) => ({
          type: p.type,
          image: null,
          imagePath: null,
          originalImage: null,
          originalImagePath: null,
          similarity: null,
          text: p.text || null,
          title: p.title || null,
          description: p.description || null,
          video: p.video || null,
          videoUrl: p.videoUrl || null,
          isTextOnly: true,
          postId: p.postId || null,
        }));
      }

      // Close all dynamic modals
      $(".dynamicModal").remove();
      $(".modal-backdrop").remove();
      $("#copypasteMinimizedIndicator").hide();
      // Track global copypaste state
      if (window.copypasteState) {
        window.copypasteState.$element = null;
        window.copypasteState.isOpen = true;
        window.copypasteState.isMinimized = false;
      }

      // Mark workflow as exported when copy-paste mode opens (pass export path)
      await markWorkflowAsExported(workflowId, exportPath);

      // When disabled, do not render score badges or send images to either
      // detection provider. Default to the existing enabled behavior.
      let showImageAiScores = true;
      try {
        const aiDetectionSettings = await window.electronAPI.readKey("aiDetectionSettings");
        showImageAiScores = aiDetectionSettings?.imageScoresEnabled !== false;
      } catch (error) {
        console.warn("[COPYPASTE] Could not load AI detection settings:", error);
      }

      // Helper function to get similarity badge HTML
      const getSimilarityBadge = (similarity) => {
        if (similarity === null || similarity === undefined) return "";

        let badgeClass = "similarity-safe";
        let icon = "check_circle";
        let label = "Similar";

        if (similarity >= 90) {
          badgeClass = "similarity-danger";
          icon = "warning";
          label = "Nearly Identical";
        } else if (similarity >= 75) {
          badgeClass = "similarity-warning";
          icon = "error_outline";
          label = "Very Similar";
        } else if (similarity >= 60) {
          badgeClass = "similarity-caution";
          icon = "info";
          label = "Somewhat Similar";
        }

        return `
                    <div class="similarity-badge ${badgeClass}">
                        <i class="material-icons">${icon}</i>
                        <span class="similarity-value">${similarity}%</span>
                        <span class="similarity-label">${label}</span>
                    </div>
                `;
      };

      const $container = $(".copypaste-container").empty();

      // Check if any posts have original images for comparison
      const postsWithOriginal = newPosts.filter(
        (np) => np.originalImagePath && np.originalImage,
      );
      console.log(
        `[COPYPASTE] Posts with original images: ${postsWithOriginal.length}/${newPosts.length}`,
      );

      // Add compact class if no posts have comparisons
      if (postsWithOriginal.length === 0) {
        $container.addClass("no-comparison");
      } else {
        $container.removeClass("no-comparison");
      }

      for (const np of newPosts) {
        const hasOriginal = np.originalImagePath && np.originalImage;
        const hasImage = np.imagePath && np.image;
        const videoSrc = np.videoPath || np.video || np.videoUrl || null;
        const hasVideo = !!videoSrc;
        const isTextOnly = np.isTextOnly || (!hasImage && !hasVideo);
        const similarityBadge = hasOriginal
          ? getSimilarityBadge(np.similarity)
          : "";

        // Show info badge for old workflows without original image (only if they have an image)
        const noComparisonBadge = !hasOriginal && hasImage
          ? `
                    <div class="similarity-badge similarity-caution" title="This workflow was created before the comparison feature was added. Create a new workflow to see original vs generated comparison.">
                        <i class="material-icons">info</i>
                        <span class="similarity-label">No comparison available</span>
                    </div>
                `
          : "";

        // Show text-only badge for text-only workflows
        const textOnlyBadge = isTextOnly
          ? `
                    <div class="similarity-badge similarity-info" title="This is a text-only post with no image content.">
                        <i class="material-icons">text_fields</i>
                        <span class="similarity-label">Text Only</span>
                    </div>
                `
          : "";

        // Show video badge for video posts
        const videoBadge = hasVideo && !hasImage
          ? `
                    <div class="similarity-badge similarity-info" title="This post contains video content.">
                        <i class="material-icons">videocam</i>
                        <span class="similarity-label">Video</span>
                    </div>
                `
          : "";

        // Store post data for policy check
        const postDataAttr = encodeURIComponent(JSON.stringify({
          postId: np.postId || null,
          imagePath: np.imagePath,
          text: np.text || "",
          title: np.title || "",
          description: np.description || "",
          type: np.type,
        }));

        // Build media label for header
        const mediaLabel = hasImage
          ? `<div class="media-name" title="${np.image}"><i class="material-icons">image</i><span>${np.image}</span></div>`
          : hasVideo
            ? `<div class="media-name" title="${np.videoFileName || "video"}"><i class="material-icons">movie</i><span>${np.videoFileName || videoSrc.split(/[/\\\\]/).pop() || "video"}</span></div>`
            : "";

        $container.append(
          `<div class="post ${hasOriginal ? "has-comparison" : ""} ${isTextOnly ? "text-only" : ""}" data-post-info="${postDataAttr}">
            <div class="head">
              <div class="head-left">
                <div class="platform-badge platform-${np.type}">
                  <img src="assets/images/icons/${np.type}-colored.png" class="platform-icon" alt="">
                  <span class="platform-name">${ucfirst(np.type)}</span>
                </div>
                ${mediaLabel}
                ${similarityBadge || noComparisonBadge || videoBadge || textOnlyBadge}
              </div>
              <div class="head-right">
                ${hasImage ? `
                <button data-role="checkPolicy" class="policy-check-btn" title="${window.I18n?.t("workflows.policy_check.check_btn_title") || "Check for policy violations"}">
                  <i class="material-icons">verified_user</i>
                  <span>${window.I18n?.t("workflows.policy_check.check_btn") || "Check Policy"}</span>
                </button>
                ` : ""}
                <div class="copypaste-nav">
                  <button data-role="prev" class="nav-btn nav-prev" title="Previous"><i class="material-icons">arrow_back</i></button>
                  <button data-role="next" class="nav-btn nav-next" title="Next"><i class="material-icons">arrow_forward</i></button>
                </div>
                <div class="copypaste-window-controls">
                  <button data-role="minimizeCopypaste" class="window-ctrl-btn minimize-btn" title="Minimize"><i class="material-icons">remove</i></button>
                  <button data-role="closeCopypaste" class="window-ctrl-btn close-btn" title="Close"><i class="material-icons">close</i></button>
                </div>
              </div>
            </div>
            <div class="policy-check-result" style="display: none;"></div>
            <div class="content">
              ${
                hasOriginal
                  ? `
              <div class="image-comparison">
                <div class="comparison-column original">
                  <div class="comparison-label">
                    <i class="material-icons">photo_library</i>
                    <span>Original Input</span>
                  </div>
                  <a href="${np.originalImagePath}" data-lightbox="preview-original-${np.image}">
                    <img class="image" loading="lazy" src="${np.originalImagePath}">
                  </a>
                </div>
                <div class="comparison-divider">
                  <div class="divider-line"></div>
                  <div class="divider-icon">
                    <i class="material-icons">compare_arrows</i>
                  </div>
                  <div class="divider-line"></div>
                </div>
                <div class="comparison-column generated">
                  <div class="comparison-label">
                    <i class="material-icons">auto_fix_high</i>
                    <span>Generated Output</span>
                  </div>
                  <a href="${np.imagePath}" data-lightbox="preview-generated-${np.image}">
                    <img class="image" loading="lazy" src="${np.imagePath}">
                  </a>
                  ${showImageAiScores ? `<div class="copypaste-image-ai-scores" data-image-score-path="${escapeHtml(encodeURIComponent(np.imagePath))}" title="${window.I18n?.t("workflows.output_modal.image_score_privacy") || "Image is uploaded to ZeroGPT and the Sightengine detector service for scoring and may be stored by those providers."}">
                    <div class="copypaste-image-ai-score is-pending" data-score-provider="zeroGpt">
                      <i class="material-icons spin">autorenew</i>
                      <span>${window.I18n?.t("workflows.output_modal.checking_zero_gpt") || "Checking ZeroGPT..."}</span>
                    </div>
                    <div class="copypaste-image-ai-score is-pending" data-score-provider="sightengine">
                      <i class="material-icons spin">autorenew</i>
                      <span>${window.I18n?.t("workflows.output_modal.checking_sightengine") || "Checking Sightengine..."}</span>
                    </div>
                  </div>` : ""}
                </div>
              </div>
              `
                  : hasImage
                    ? `
              <div class="copypaste-scored-image">
                <a href="${np.imagePath}" data-lightbox="preview">
                  <img class="image" loading="lazy" src="${np.imagePath}">
                </a>
                ${showImageAiScores ? `<div class="copypaste-image-ai-scores" data-image-score-path="${escapeHtml(encodeURIComponent(np.imagePath))}" title="${window.I18n?.t("workflows.output_modal.image_score_privacy") || "Image is uploaded to ZeroGPT and the Sightengine detector service for scoring and may be stored by those providers."}">
                  <div class="copypaste-image-ai-score is-pending" data-score-provider="zeroGpt">
                    <i class="material-icons spin">autorenew</i>
                    <span>${window.I18n?.t("workflows.output_modal.checking_zero_gpt") || "Checking ZeroGPT..."}</span>
                  </div>
                  <div class="copypaste-image-ai-score is-pending" data-score-provider="sightengine">
                    <i class="material-icons spin">autorenew</i>
                    <span>${window.I18n?.t("workflows.output_modal.checking_sightengine") || "Checking Sightengine..."}</span>
                  </div>
                </div>` : ""}
              </div>
              `
                    : ""
              }
              ${hasVideo ? `
              <div class="video-lazy-placeholder" data-src="${videoSrc.startsWith("http") ? videoSrc : "file://" + videoSrc.replace(/\\/g, "/")}">
                <div class="video-thumb-fallback">
                  <i class="material-icons">videocam</i>
                </div>
                <button class="video-play-btn" aria-label="Play video">
                  <i class="material-icons">play_circle</i>
                </button>
              </div>
              ` : ""}
              <div class="copypaste-text-content">
              ${
                np.type === "facebook" && np.title
                  ? `
                <div class="copy-area copy-area-title">
                  <div class="copy-area-bar">
                    <div class="copy-area-label"><i class="material-icons">title</i><span>Title</span></div>
                    <div class="copy-area-actions">
                      <button data-role="copyContent" class="copy-btn" title="Copy to clipboard"><i class="material-icons">content_copy</i><span>Copy</span></button>
                      <button data-role="copyAndNext" class="copy-btn copy-btn-next" title="Copy and go to next"><span>Copy &amp; Next</span><i class="material-icons">arrow_forward</i></button>
                    </div>
                  </div>
                  <pre>${escapeHtml(np.title)}</pre>
                </div>`
                  : ""
              }
              ${
                np.text || (np.type !== "facebook" && np.title)
                  ? `
                <div class="copy-area copy-area-main">
                  <div class="copy-area-bar">
                    <div class="copy-area-label"><i class="material-icons">${np.type === "facebook" ? "notes" : "subject"}</i><span>${np.type === "facebook" ? "Post Text" : "Content"}</span></div>
                    <div class="copy-area-actions">
                      <button data-role="copyContent" class="copy-btn" title="Copy to clipboard"><i class="material-icons">content_copy</i><span>Copy</span></button>
                      <button data-role="copyAndNext" class="copy-btn copy-btn-next" title="Copy and go to next"><span>Copy &amp; Next</span><i class="material-icons">arrow_forward</i></button>
                    </div>
                  </div>
                  <pre>${escapeHtml(np.type === "facebook" ? np.text : np.title)}</pre>
                </div>
                ${
                  np.description
                    ? `
                  <div class="copy-area copy-area-description">
                    <div class="copy-area-bar">
                      <div class="copy-area-label"><i class="material-icons">description</i><span>Description</span></div>
                      <div class="copy-area-actions">
                        <button data-role="copyContent" class="copy-btn" title="Copy to clipboard"><i class="material-icons">content_copy</i><span>Copy</span></button>
                        <button data-role="copyAndNext" class="copy-btn copy-btn-next" title="Copy and go to next"><span>Copy &amp; Next</span><i class="material-icons">arrow_forward</i></button>
                      </div>
                    </div>
                    <pre>${escapeHtml(np.description)}</pre>
                  </div>`
                    : ""
                }`
                  : ""
              }
              </div>
            </div>
          </div>`,
        );
      }
      $("#workflows-container .workflow-copypaste .copypaste-container .post")
        .hide()
        .first()
        .show();

      // Show modal only after content is fully populated
      $(".workflow-copypaste").css("display", "flex");

      const imageScoreGroups = $("#workflows-container .copypaste-image-ai-scores").toArray();
      const imageScoreConcurrency = 4;
      let nextImageScoreIndex = 0;
      const renderImageScore = ($badge, result, label) => {
        $badge
          .removeClass("has-details")
          .removeAttr("role tabindex aria-label")
          .removeData("sightengineResult");
        if (!result?.success || !Number.isFinite(Number(result.score))) {
          $badge.removeClass("is-pending is-low is-medium is-high").addClass("is-failed");
          $badge.find("i").removeClass("spin").text("error_outline");
          $badge.find("span").text(`${label}: ${window.I18n?.t("workflows.output_modal.score_unavailable") || "Unavailable"}`);
          return;
        }

        const score = Number(result.score);
        const scoreClass = score >= 50 ? "is-high" : score >= 20 ? "is-medium" : "is-low";
        $badge.removeClass("is-pending is-failed is-low is-medium is-high").addClass(scoreClass);
        $badge.find("i").removeClass("spin").text(score >= 50 ? "smart_toy" : "verified");
        $badge.find("span").text(`${label}: ${score.toFixed(1)}%`);
        if (result.generatorScores && Object.keys(result.generatorScores).length) {
          const detailsLabel = window.I18n?.t("workflows.output_modal.sightengine_click_details") || "Click to view AI generator details";
          $badge
            .addClass("has-details")
            .attr({
              role: "button",
              tabindex: "0",
              "aria-label": `${label}: ${score.toFixed(1)}%. ${detailsLabel}`,
            })
            .data("sightengineResult", result);
        }
      };
      const scoreImageWorker = async () => {
        while (nextImageScoreIndex < imageScoreGroups.length) {
          const $group = $(imageScoreGroups[nextImageScoreIndex++]);
          const encodedPath = $group.attr("data-image-score-path") || "";
          let imagePath;
          try {
            imagePath = decodeURIComponent(encodedPath);
          } catch (_) {
            imagePath = "";
          }

          try {
            const result = await window.electronAPI.scoreAiImage(imagePath);
            if (!$group.closest("#workflows-container").length) continue;
            if (!result?.success) throw new Error(result?.error || "Score unavailable");
            renderImageScore(
              $group.find('[data-score-provider="zeroGpt"]'),
              result.zeroGpt,
              window.I18n?.t("workflows.output_modal.image_ai_score") || "ZeroGPT AI score",
            );
            renderImageScore(
              $group.find('[data-score-provider="sightengine"]'),
              result.sightengine,
              window.I18n?.t("workflows.output_modal.sightengine_ai_score") || "Sightengine AI score",
            );
          } catch (error) {
            if (!$group.closest("#workflows-container").length) continue;
            const unavailableLabel = window.I18n?.t("workflows.output_modal.image_score_unavailable") || "Image AI score unavailable";
            $group.find(".copypaste-image-ai-score")
              .removeClass("is-pending is-low is-medium is-high")
              .addClass("is-failed")
              .each(function () {
                $(this).find("i").removeClass("spin").text("error_outline");
                $(this).find("span").text(unavailableLabel);
              });
          }
        }
      };
      // Score every post as soon as the modal opens. Workers consume the DOM
      // list in first-to-last order; navigation does not trigger requests.
      Promise.all(Array.from({ length: Math.min(imageScoreConcurrency, imageScoreGroups.length) }, () => scoreImageWorker()))
        .catch((error) => console.warn("[COPYPASTE] Image AI scoring queue failed:", error));

      // Start background policy check if enabled
      startBackgroundPolicyCheck();
    });

    // Background policy check function - checks all posts sequentially from first to last
    async function startBackgroundPolicyCheck() {
      policyCheckCancelled = false;
      if (window.copypasteState) window.copypasteState.policyCheckPending = true;

      // Check if auto policy check is enabled in settings
      const settings = await window.electronAPI.readKey("automationSettings") || {};
      if (!settings.autoPolicyCheck) {
        console.log("[Policy Check] Auto policy check is disabled in settings");
        return;
      }

      console.log("[Policy Check] Starting background policy check for all posts");

      const $posts = $("#workflows-container .workflow-copypaste .copypaste-container .post");
      const totalPosts = $posts.length;

      for (let i = 0; i < totalPosts; i++) {
        // Check if cancelled (user closed copypaste mode)
        if (policyCheckCancelled) {
          console.log("[Policy Check] Background check cancelled");
          break;
        }

        const $post = $posts.eq(i);
        const $btn = $post.find('[data-role="checkPolicy"]');
        const $resultPanel = $post.find(".policy-check-result");

        // Skip if already has results (not empty)
        if ($resultPanel.children().length > 0 && !$resultPanel.find(".policy-checking").length) {
          console.log(`[Policy Check] Post ${i + 1}/${totalPosts} already checked, skipping`);
          continue;
        }

        // Parse post data
        let postInfo;
        try {
          postInfo = JSON.parse(decodeURIComponent($post.attr("data-post-info")));
        } catch (e) {
          console.error(`[Policy Check] Failed to parse post ${i + 1} data:`, e);
          continue;
        }

        // Show loading state
        $btn.prop("disabled", true);
        $btn.html('<i class="material-icons spin">autorenew</i><span>' + (window.I18n?.t("workflows.policy_check.checking") || "Checking...") + '</span>');

        $resultPanel.html(`
          <div class="policy-checking">
            <div class="spinner-border spinner-border-sm me-2"></div>
            <span>${window.I18n?.t("workflows.policy_check.analyzing") || "Analyzing content for policy violations..."} (${i + 1}/${totalPosts})</span>
          </div>
        `).slideDown(200);

        try {
          const result = await window.electronAPI.checkPostPolicyViolation({
            imagePath: postInfo.imagePath,
            text: postInfo.text,
            title: postInfo.title,
            description: postInfo.description,
            platform: postInfo.type,
          });

          // Check if cancelled while waiting for API response
          if (policyCheckCancelled) {
            console.log("[Policy Check] Background check cancelled during API call");
            break;
          }

          if (!result.success) {
            $resultPanel.html(`
              <div class="policy-error">
                <i class="material-icons">error</i>
                <span>${escapeHtml(result.error || "Failed to check policy")}</span>
                <button class="btn btn-sm btn-outline-secondary ms-2" data-role="dismissPolicyResult">
                  <i class="material-icons">close</i>
                </button>
              </div>
            `);
          } else {
            const analysis = result.analysis;
            renderPolicyResult($resultPanel, $post, analysis, postInfo);
          }

          console.log(`[Policy Check] Post ${i + 1}/${totalPosts} completed`);

        } catch (error) {
          console.error(`[Policy Check] Error checking post ${i + 1}:`, error);
          $resultPanel.html(`
            <div class="policy-error">
              <i class="material-icons">error</i>
              <span>${window.I18n?.t("workflows.policy_check.error") || "An error occurred during policy check"}</span>
              <button class="btn btn-sm btn-outline-secondary ms-2" data-role="dismissPolicyResult">
                <i class="material-icons">close</i>
              </button>
            </div>
          `);
        } finally {
          // Restore button state
          $btn.prop("disabled", false);
          $btn.html('<i class="material-icons">verified_user</i><span>' + (window.I18n?.t("workflows.policy_check.check_btn") || "Check Policy") + '</span>');
        }

        // Small delay between checks to avoid hammering the API
        if (i < totalPosts - 1 && !policyCheckCancelled) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (!policyCheckCancelled) {
        console.log("[Policy Check] Background check completed for all posts");
      }
      if (window.copypasteState) window.copypasteState.policyCheckPending = false;
    }

    // Expose for restart after navigation restore
    window._restartPolicyCheck = startBackgroundPolicyCheck;

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="closeCopypaste"]',
      function () {
        policyCheckCancelled = true; // Cancel any running background policy checks
        // Pause any active video players before closing
        $(".workflow-copypaste .video-lazy-placeholder.video-active video").each(function () {
          this.pause();
        });
        $(".workflow-copypaste").fadeOut(100);
        $("#copypasteMinimizedIndicator").hide();
        // Clear global state
        if (window.copypasteState) {
          window.copypasteState.$element = null;
          window.copypasteState.isOpen = false;
          window.copypasteState.isMinimized = false;
          window.copypasteState.policyCheckPending = false;
        }
      },
    );

    // Minimize copypaste modal
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="minimizeCopypaste"]',
      function () {
        $(".workflow-copypaste").hide();
        $("#copypasteMinimizedIndicator").css("display", "flex");
        if (window.copypasteState) {
          window.copypasteState.isOpen = false;
          window.copypasteState.isMinimized = true;
        }
      },
    );

    // Policy Check Button Handler
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="checkPolicy"]',
      async function () {
        const $btn = $(this);
        const $post = $btn.closest(".post");
        const $resultPanel = $post.find(".policy-check-result");

        // Parse post data
        let postInfo;
        try {
          postInfo = JSON.parse(decodeURIComponent($post.attr("data-post-info")));
        } catch (e) {
          showAlert("error", "Failed to read post data");
          return;
        }

        // Show loading state
        $btn.prop("disabled", true);
        $btn.html('<i class="material-icons spin">autorenew</i><span>' + (window.I18n?.t("workflows.policy_check.checking") || "Checking...") + '</span>');

        $resultPanel.html(`
          <div class="policy-checking">
            <div class="spinner-border spinner-border-sm me-2"></div>
            <span>${window.I18n?.t("workflows.policy_check.analyzing") || "Analyzing content for policy violations..."}</span>
          </div>
        `).slideDown(200);

        try {
          const result = await window.electronAPI.checkPostPolicyViolation({
            imagePath: postInfo.imagePath,
            text: postInfo.text,
            title: postInfo.title,
            description: postInfo.description,
            platform: postInfo.type,
          });

          if (!result.success) {
            $resultPanel.html(`
              <div class="policy-error">
                <i class="material-icons">error</i>
                <span>${escapeHtml(result.error || "Failed to check policy")}</span>
                <button class="btn btn-sm btn-outline-secondary ms-2" data-role="dismissPolicyResult">
                  <i class="material-icons">close</i>
                </button>
              </div>
            `);
            return;
          }

          const analysis = result.analysis;
          renderPolicyResult($resultPanel, $post, analysis, postInfo);

        } catch (error) {
          console.error("[Policy Check] Error:", error);
          $resultPanel.html(`
            <div class="policy-error">
              <i class="material-icons">error</i>
              <span>${window.I18n?.t("workflows.policy_check.error") || "An error occurred during policy check"}</span>
              <button class="btn btn-sm btn-outline-secondary ms-2" data-role="dismissPolicyResult">
                <i class="material-icons">close</i>
              </button>
            </div>
          `);
        } finally {
          // Restore button
          $btn.prop("disabled", false);
          $btn.html('<i class="material-icons">verified_user</i><span>' + (window.I18n?.t("workflows.policy_check.check_btn") || "Check Policy") + '</span>');
        }
      },
    );

    // Helper to safely encode objects for HTML data attributes
    // Handles single quotes (not encoded by encodeURIComponent) and control characters
    function safeAttrEncode(obj) {
      // Deep clone and sanitize string values
      const sanitize = (value) => {
        if (typeof value === 'string') {
          // Remove control characters that break JSON parsing
          return value.replace(/[\x00-\x1F\x7F]/g, (char) => {
            if (char === '\n') return ' ';
            if (char === '\r') return '';
            if (char === '\t') return ' ';
            return '';
          });
        }
        if (Array.isArray(value)) {
          return value.map(sanitize);
        }
        if (value && typeof value === 'object') {
          const result = {};
          for (const key in value) {
            result[key] = sanitize(value[key]);
          }
          return result;
        }
        return value;
      };
      
      const sanitized = sanitize(obj);
      // encodeURIComponent doesn't encode single quotes - must replace them with %27
      return encodeURIComponent(JSON.stringify(sanitized)).replace(/'/g, '%27');
    }

    // Helper function to render policy check results
    function renderPolicyResult($resultPanel, $post, analysis, postInfo) {
      // Filter out non-issues: items with "low" severity that say "no policy-violating" or similar
      const isActualIssue = (issue) => {
        if (!issue) return false;
        const desc = (issue.description || "").toLowerCase();
        // If description says no issues found, it's not an actual issue
        if (desc.includes("no policy-violating") || 
            desc.includes("no issues") || 
            desc.includes("no violations") ||
            desc.includes("does not violate") ||
            desc.includes("no disallowed") ||
            desc.includes("no harmful")) {
          return false;
        }
        // Low severity with no suggestion is likely not a real issue
        if (issue.severity === "low" && !issue.suggestedFix && !issue.problematicText) {
          return false;
        }
        return true;
      };
      
      const imageIssues = (analysis.imageIssues || []).filter(isActualIssue);
      const textIssues = (analysis.textIssues || []).filter(isActualIssue);
      
      // Derive actual severity from issues if AI response is inconsistent
      let severity = analysis.severity || "none";
      const actualHasIssues = imageIssues.length > 0 || textIssues.length > 0;
      
      // If no actual issues after filtering, force severity to none
      if (!actualHasIssues) {
        severity = "none";
      }
      // If there are issues but severity is "none", calculate from actual issues
      else if (actualHasIssues && severity === "none") {
        const allIssues = [...imageIssues, ...textIssues];
        const hasHigh = allIssues.some(i => i.severity === "high");
        const hasMedium = allIssues.some(i => i.severity === "medium");
        const hasLow = allIssues.some(i => i.severity === "low");
        
        if (hasHigh) severity = "high";
        else if (hasMedium) severity = "medium";
        else if (hasLow) severity = "low";
      }

      let severityClass = "success";
      let severityIcon = "check_circle";
      let severityLabel = window.I18n?.t("workflows.policy_check.no_issues") || "No Issues Found";

      if (severity === "high") {
        severityClass = "danger";
        severityIcon = "error";
        severityLabel = window.I18n?.t("workflows.policy_check.high_risk") || "High Risk";
      } else if (severity === "medium") {
        severityClass = "warning";
        severityIcon = "warning";
        severityLabel = window.I18n?.t("workflows.policy_check.medium_risk") || "Medium Risk";
      } else if (severity === "low") {
        severityClass = "info";
        severityIcon = "info";
        severityLabel = window.I18n?.t("workflows.policy_check.low_risk") || "Low Risk";
      }

      let html = `
        <div class="policy-result policy-${severityClass}">
          <div class="policy-header">
            <div class="policy-status">
              <i class="material-icons">${severityIcon}</i>
              <span class="severity-label">${severityLabel}</span>
            </div>
            <button class="btn btn-sm btn-outline-secondary" data-role="dismissPolicyResult">
              <i class="material-icons">close</i>
            </button>
          </div>
          ${analysis.overallSummary ? `<div class="policy-summary">${escapeHtml(analysis.overallSummary)}</div>` : ""}
      `;

      // Image Issues
      if (imageIssues.length > 0) {
        html += `
          <div class="policy-section policy-section-image">
            <div class="policy-section-title">
              <i class="material-icons">image</i>
              <span>${window.I18n?.t("workflows.policy_check.image_issues") || "Image Issues"}</span>
              <span class="issue-count">(${imageIssues.length})</span>
            </div>
            <div class="policy-section-subtitle">
              ${window.I18n?.t("workflows.policy_check.image_issues_hint") || "Issues detected in image content. Regenerate to fix."}
            </div>
            <div class="policy-issues">
        `;
        for (const issue of imageIssues) {
          const issueSeverityClass = issue.severity === "high" ? "danger" : (issue.severity === "medium" ? "warning" : "info");
          // Format category: replace underscores with spaces, capitalize words
          const formattedCategory = (issue.category || "").replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
          html += `
            <div class="policy-issue policy-issue-${issueSeverityClass}">
              <div class="issue-header">
                <span class="issue-category">${escapeHtml(formattedCategory)}</span>
                <span class="badge bg-${issueSeverityClass}">${issue.severity}</span>
              </div>
              <div class="issue-description">${escapeHtml(issue.description)}</div>
              ${issue.brandNames ? `<div class="issue-brands"><i class="material-icons" style="font-size:14px;vertical-align:middle;">label</i> <strong>${window.I18n?.t("workflows.policy_check.detected_brands") || "Detected brands"}:</strong> ${escapeHtml(issue.brandNames)}</div>` : ""}
            </div>
          `;
        }
        // Add Regenerate Image button
        html += `
            <button class="btn btn-sm btn-primary mt-2" data-role="regenerateImage" data-post-info='${safeAttrEncode(postInfo)}' data-issues='${safeAttrEncode(imageIssues)}'>
              <i class="material-icons">auto_fix_high</i>
              <span>${window.I18n?.t("workflows.policy_check.regenerate_image") || "Regenerate Image"}</span>
            </button>
        `;
        html += `</div></div>`;
      }

      // Text Issues
      if (textIssues.length > 0) {
        html += `
          <div class="policy-section policy-section-text">
            <div class="policy-section-title">
              <i class="material-icons">text_fields</i>
              <span>${window.I18n?.t("workflows.policy_check.text_issues") || "Text Issues"}</span>
              <span class="issue-count">(${textIssues.length})</span>
            </div>
            <div class="policy-section-subtitle">
              ${window.I18n?.t("workflows.policy_check.text_issues_hint") || "Issues detected in caption/description. Click Fix Text to rewrite."}
            </div>
            <div class="policy-issues">
        `;
        for (const issue of textIssues) {
          const issueSeverityClass = issue.severity === "high" ? "danger" : (issue.severity === "medium" ? "warning" : "info");
          const issueId = genId(8);
          // Format category: replace underscores with spaces, capitalize words
          const formattedCategory = (issue.category || "").replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
          html += `
            <div class="policy-issue policy-issue-${issueSeverityClass}" data-issue-id="${issueId}">
              <div class="issue-header">
                <span class="issue-category">${escapeHtml(formattedCategory)}</span>
                <span class="badge bg-${issueSeverityClass}">${issue.severity}</span>
              </div>
              <div class="issue-description">${escapeHtml(issue.description)}</div>
              ${issue.problematicText ? `
                <div class="issue-problematic">
                  <span class="label">${window.I18n?.t("workflows.policy_check.problematic_text") || "Problematic:"}</span>
                  <code>${escapeHtml(issue.problematicText)}</code>
                </div>
              ` : ""}
              ${issue.suggestedFix ? `
                <div class="issue-fix-suggestion">
                  <span class="label">${window.I18n?.t("workflows.policy_check.suggestion") || "Suggestion:"}</span>
                  <span>${escapeHtml(issue.suggestedFix)}</span>
                </div>
                <button class="btn btn-sm btn-primary mt-2" data-role="fixPolicyText" data-issue='${safeAttrEncode(issue)}' data-post-info='${safeAttrEncode(postInfo)}'>
                  <i class="material-icons">auto_fix_high</i>
                  <span>${window.I18n?.t("workflows.policy_check.fix_text") || "Fix Text"}</span>
                </button>
              ` : ""}
            </div>
          `;
        }
        html += `</div></div>`;
      }

      html += `</div>`;
      $resultPanel.html(html);
    }

    // Dismiss policy result
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="dismissPolicyResult"]',
      function () {
        $(this).closest(".policy-check-result").slideUp(200);
      },
    );

    // Fix text based on policy issue
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="fixPolicyText"]',
      async function () {
        const $btn = $(this);
        const $post = $btn.closest(".post");
        
        let issue, postInfo;
        try {
          issue = JSON.parse(decodeURIComponent($btn.attr("data-issue")));
          postInfo = JSON.parse(decodeURIComponent($btn.attr("data-post-info")));
        } catch (parseError) {
          console.error("[Fix Policy Text] Failed to parse button data:", parseError);
          showAlert("error", window.I18n?.t("workflows.policy_check.data_parse_error") || "Failed to read issue data. Please re-run the policy check.");
          return;
        }

        // Determine which text field to fix
        const originalText = postInfo.text || postInfo.title || postInfo.description;
        if (!originalText) {
          showAlert("error", window.I18n?.t("workflows.policy_check.no_text_to_fix") || "No text to fix");
          return;
        }

        // Show loading
        $btn.prop("disabled", true);
        const originalBtnHtml = $btn.html();
        $btn.html('<i class="material-icons spin">autorenew</i><span>' + (window.I18n?.t("workflows.policy_check.fixing") || "Fixing...") + '</span>');

        try {
          const result = await window.electronAPI.fixPolicyText({
            originalText,
            issue,
            platform: postInfo.type,
          });

          if (!result.success) {
            showAlert("error", result.error || "Failed to fix text");
            return;
          }

          // Show the fixed text in a modal for user to accept/reject
          showFixedTextModal(postInfo, originalText, result.fixedText, $post);

        } catch (error) {
          console.error("[Fix Policy Text] Error:", error);
          showAlert("error", window.I18n?.t("workflows.policy_check.fix_error") || "Failed to generate fixed text");
        } finally {
          $btn.prop("disabled", false);
          $btn.html(originalBtnHtml);
        }
      },
    );

    // Regenerate image based on policy issues
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="regenerateImage"]',
      async function () {
        const $btn = $(this);
        const $post = $btn.closest(".post");
        
        let postInfo, issues;
        try {
          postInfo = JSON.parse(decodeURIComponent($btn.attr("data-post-info")));
          issues = JSON.parse(decodeURIComponent($btn.attr("data-issues")));
        } catch (parseError) {
          console.error("[Regenerate Image] Failed to parse button data:", parseError);
          showAlert("error", window.I18n?.t("workflows.policy_check.data_parse_error") || "Failed to read issue data. Please re-run the policy check.");
          return;
        }

        // Show the regenerate image modal
        showRegenerateImageModal(postInfo, issues, $post);
      },
    );

    // Show modal for image regeneration
    async function showRegenerateImageModal(postInfo, issues, $post) {
      // Remove existing modal
      $(".regenerate-image-modal").remove();

      // Check which generators are available
      const openaiKeys = await window.electronAPI.readKey("openaiKeys") || {};
      const hasGPTImage = Object.keys(openaiKeys).length > 0;
      
      // Detect the image generator used in this automation
      const detectedGenerator = await getAutomationImageGenerator(currentAutomationId);
      
      // Build options with the detected generator pre-selected
      const generators = [
        { value: "gptimage", label: "GPT Image (API - Fast)", available: hasGPTImage },
        { value: "chatgptimage", label: "ChatGPT Image (Browser)", available: true },
        { value: "soraimage", label: "Sora Image (Browser)", available: true },
        { value: "midjourney", label: "Midjourney (Browser)", available: true }
      ];
      
      // Sort generators: detected generator first, then others
      const sortedGenerators = [...generators].sort((a, b) => {
        if (a.value === detectedGenerator) return -1;
        if (b.value === detectedGenerator) return 1;
        return 0;
      });
      
      // Filter to available generators
      const availableGenerators = sortedGenerators.filter(g => g.available);
      
      const generatorOptions = availableGenerators
        .map((g, idx) => {
          // First option is selected (the detected generator if available, otherwise first available)
          const isSelected = idx === 0;
          return `<option value="${g.value}"${isSelected ? " selected" : ""}>${g.label}</option>`;
        })
        .join("");

      const modalHtml = `
        <div class="regenerate-image-modal">
          <div class="regenerate-image-content">
            <div class="regenerate-image-header">
              <h4><i class="material-icons">auto_fix_high</i> ${window.I18n?.t("workflows.policy_check.regenerate_image_title") || "Regenerate Image"}</h4>
              <button class="btn-close regenerate-image-close"></button>
            </div>
            <div class="regenerate-image-body">
              <div class="regenerate-preview">
                <div class="preview-current">
                  <label>${window.I18n?.t("workflows.policy_check.current_image") || "Current Image"}</label>
                  <img src="${postInfo.imagePath}" alt="Current" />
                </div>
                <div class="preview-issues">
                  <label>${window.I18n?.t("workflows.policy_check.issues_to_fix") || "Issues to Fix"}</label>
                  <div class="issues-list">${issues.map(i => `<div class="issue-item"><i class="material-icons">warning</i> ${escapeHtml(i.description)}</div>`).join('')}</div>
                </div>
              </div>
              
              <div class="regenerate-options">
                <div class="form-group mb-3">
                  <label>${window.I18n?.t("workflows.policy_check.select_generator") || "Select Image Generator"}</label>
                  <select id="regenerateGenerator" class="form-select">
                    ${generatorOptions}
                  </select>
                  ${!hasGPTImage ? '<small class="text-muted">' + (window.I18n?.t("workflows.policy_check.no_openai_key") || "Add OpenAI API key in Settings for faster GPT Image generation") + '</small>' : ''}
                </div>
                <p class="text-muted small mb-0">
                  <i class="material-icons" style="font-size: 14px; vertical-align: middle;">info</i>
                  ${window.I18n?.t("workflows.policy_check.auto_prompt_info") || "AI will analyze the image and generate a prompt to fix the issues automatically."}
                </p>
              </div>
            </div>
            <div class="regenerate-image-footer">
              <button class="btn btn-secondary regenerate-image-close">
                ${window.I18n?.t("common.cancel") || "Cancel"}
              </button>
              <button class="btn btn-primary" id="regenerateImageStart">
                <i class="material-icons">refresh</i>
                ${window.I18n?.t("workflows.policy_check.regenerate") || "Regenerate"}
              </button>
            </div>
          </div>
        </div>
      `;

      $("body").append(modalHtml);

      // Add styles if not present
      if (!$("#regenerate-image-modal-styles").length) {
        $("head").append(`
          <style id="regenerate-image-modal-styles">
            .regenerate-image-modal {
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(0,0,0,0.6);
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 10000;
              animation: fadeIn 0.2s ease;
            }
            .regenerate-image-content {
              background: var(--bg-primary, #fff);
              border-radius: 12px;
              width: 90%;
              max-width: 700px;
              max-height: 90vh;
              overflow: hidden;
              display: flex;
              flex-direction: column;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            .regenerate-image-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: 16px 20px;
              border-bottom: 1px solid var(--border-color, #e0e0e0);
            }
            .regenerate-image-header h4 {
              margin: 0;
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .regenerate-image-body {
              padding: 20px;
              overflow-y: auto;
              flex: 1;
            }
            .regenerate-preview {
              display: grid;
              grid-template-columns: 200px 1fr;
              gap: 20px;
              margin-bottom: 20px;
            }
            .preview-current img {
              width: 100%;
              border-radius: 8px;
              border: 1px solid var(--border-color, #e0e0e0);
            }
            .preview-current label, .preview-issues label {
              display: block;
              font-weight: 600;
              margin-bottom: 8px;
              color: var(--text-secondary, #666);
            }
            .issues-list {
              background: #fff3cd;
              border: 1px solid #ffc107;
              border-radius: 8px;
              padding: 12px;
            }
            .issue-item {
              display: flex;
              align-items: flex-start;
              gap: 8px;
              padding: 6px 0;
              font-size: 13px;
            }
            .issue-item i {
              color: #ffc107;
              font-size: 18px;
              flex-shrink: 0;
            }
            .regenerate-options label {
              display: block;
              font-weight: 600;
              margin-bottom: 6px;
            }
            .regenerate-image-footer {
              display: flex;
              justify-content: flex-end;
              gap: 10px;
              padding: 16px 20px;
              border-top: 1px solid var(--border-color, #e0e0e0);
            }
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          </style>
        `);
      }

      // Handle close
      $(".regenerate-image-modal").on("click", ".regenerate-image-close", function() {
        $(".regenerate-image-modal").remove();
      });

      // Handle click outside
      $(".regenerate-image-modal").on("click", function(e) {
        if ($(e.target).hasClass("regenerate-image-modal")) {
          $(".regenerate-image-modal").remove();
        }
      });

      // Handle regenerate - auto-generates prompt then regenerates image
      $("#regenerateImageStart").on("click", async function() {
        const generator = $("#regenerateGenerator").val();

        const $btn = $(this);
        const originalHtml = $btn.html();
        $btn.prop("disabled", true).html('<i class="material-icons spin">autorenew</i> ' + (window.I18n?.t("workflows.policy_check.analyzing_image") || "Analyzing image..."));
        $(".regenerate-image-close").prop("disabled", true);
        
        try {
          // Step 1: Generate prompt by analyzing image with AI
          // Pass generator type so we generate appropriate prompt
          const promptResult = await window.electronAPI.generateImagePrompt({
            imagePath: postInfo.imagePath,
            issues: issues,
            platform: postInfo.type,
            generator: generator // Pass which generator will be used
          });
          
          if (!promptResult.success) {
            showAlert("error", promptResult.error || "Failed to analyze image");
            $btn.prop("disabled", false).html(originalHtml);
            $(".regenerate-image-close").prop("disabled", false);
            return;
          }
          
          const prompt = promptResult.prompt;
          console.log("[Regenerate Image] Generated prompt:", prompt);
          
          // Step 2: Regenerate image with the generated prompt
          $btn.html('<i class="material-icons spin">autorenew</i> ' + (window.I18n?.t("workflows.policy_check.generating") || "Generating image..."));
          
          const result = await window.electronAPI.regeneratePolicyImage({
            generator,
            prompt,
            originalImagePath: postInfo.imagePath,
            postInfo
          });
          
          if (result.success) {
            // Update the post image in the UI
            // Try multiple selectors to cover different layouts (comparison mode vs simple mode)
            const newSrc = result.imagePath + "?t=" + Date.now();
            
            // Comparison mode: update the generated output image
            let $postImg = $post.find(".comparison-column.generated img.image");
            if (!$postImg.length) {
              // Simple mode (no comparison): update the main image
              $postImg = $post.find(".content > a > img.image");
            }
            if (!$postImg.length) {
              // Fallback: any .image class
              $postImg = $post.find("img.image").first();
            }
            
            if ($postImg.length) {
              $postImg.attr("src", newSrc);
              // Also update lightbox link if present
              $postImg.closest("a[data-lightbox]").attr("href", result.imagePath);
              console.log("[Regenerate Image] Updated image in UI");
            } else {
              console.warn("[Regenerate Image] Could not find image element to update");
            }
            
            // Update postInfo for future operations
            postInfo.imagePath = result.imagePath;
            
            // Update the data-post-info attribute
            try {
              const currentPostInfo = JSON.parse(decodeURIComponent($post.attr("data-post-info")));
              currentPostInfo.imagePath = result.imagePath;
              $post.attr("data-post-info", encodeURIComponent(JSON.stringify(currentPostInfo)));
              console.log("[Regenerate Image] Updated post data-post-info with new image path");
              
              // PERSIST TO DATABASE if we have a postId
              if (currentPostInfo.postId) {
                try {
                  const dbResult = await window.electronAPI.updatePostImage({
                    postId: currentPostInfo.postId,
                    platform: currentPostInfo.type,
                    newImagePath: result.imagePath
                  });
                  if (dbResult.success) {
                    console.log("[Regenerate Image] Successfully persisted to database");
                  } else {
                    console.warn("[Regenerate Image] Database update failed:", dbResult.error);
                  }
                } catch (dbErr) {
                  console.error("[Regenerate Image] Database update error:", dbErr);
                }
              } else {
                console.log("[Regenerate Image] No postId available, skipping database update");
              }
            } catch (dataErr) {
              console.error("[Regenerate Image] Failed to update post data:", dataErr);
            }
            
            // Close modal
            $(".regenerate-image-modal").remove();
            
            // Dismiss the policy result
            $post.find(".policy-check-result").slideUp(200);
            
            showAlert("success", window.I18n?.t("workflows.policy_check.image_regenerated") || "Image regenerated successfully! Run policy check again to verify.");
          } else {
            showAlert("error", result.error || "Failed to regenerate image");
          }
        } catch (error) {
          console.error("[Regenerate Image] Error:", error);
          showAlert("error", window.I18n?.t("workflows.policy_check.regenerate_error") || "Failed to regenerate image");
        } finally {
          $btn.prop("disabled", false).html(originalHtml);
          $(".regenerate-image-close").prop("disabled", false);
        }
      });
    }

    // Show modal with fixed text for user to accept
    function showFixedTextModal(postInfo, originalText, fixedText, $post) {
      // Remove existing modal
      $(".fixed-text-modal").remove();

      const modalHtml = `
        <div class="fixed-text-modal">
          <div class="fixed-text-content">
            <div class="fixed-text-header">
              <h4><i class="material-icons">auto_fix_high</i> ${window.I18n?.t("workflows.policy_check.fixed_text_title") || "Fixed Text"}</h4>
              <button class="btn-close-modal" data-role="closeFixedTextModal">
                <i class="material-icons">close</i>
              </button>
            </div>
            <div class="fixed-text-body">
              <div class="text-comparison">
                <div class="text-box original-text">
                  <div class="text-box-header">
                    <i class="material-icons">history</i>
                    <span>${window.I18n?.t("workflows.policy_check.original") || "Original"}</span>
                  </div>
                  <pre>${escapeHtml(originalText)}</pre>
                </div>
                <div class="text-arrow">
                  <i class="material-icons">arrow_forward</i>
                </div>
                <div class="text-box fixed-text">
                  <div class="text-box-header">
                    <i class="material-icons">check_circle</i>
                    <span>${window.I18n?.t("workflows.policy_check.fixed") || "Fixed"}</span>
                  </div>
                  <pre contenteditable="true" class="editable-fixed-text">${escapeHtml(fixedText)}</pre>
                </div>
              </div>
            </div>
            <div class="fixed-text-footer">
              <button class="btn btn-secondary" data-role="closeFixedTextModal">
                <i class="material-icons">close</i>
                <span>${window.I18n?.t("common.cancel") || "Cancel"}</span>
              </button>
              <button class="btn btn-success" data-role="applyFixedText">
                <i class="material-icons">check</i>
                <span>${window.I18n?.t("workflows.policy_check.apply_fix") || "Apply & Copy"}</span>
              </button>
            </div>
          </div>
        </div>
      `;

      $("body").append(modalHtml);

      // Handle close
      $(".fixed-text-modal").on("click", '[data-role="closeFixedTextModal"]', function () {
        $(".fixed-text-modal").fadeOut(100, function () {
          $(this).remove();
        });
      });

      // Handle apply
      $(".fixed-text-modal").on("click", '[data-role="applyFixedText"]', async function () {
        const newText = $(".editable-fixed-text").text().trim();

        // Copy to clipboard
        try {
          await navigator.clipboard.writeText(newText);

          // Update the pre element in the post
          const $copyArea = $post.find(".copy-area pre").first();
          if ($copyArea.length) {
            $copyArea.text(newText);
          }

          // CRITICAL: Update the post data attribute so policy check uses new text
          let currentPostInfo;
          try {
            currentPostInfo = JSON.parse(decodeURIComponent($post.attr("data-post-info")));
            // Build the text fields to update based on platform
            const textFields = {};
            
            // Update whichever text field was originally used
            if (currentPostInfo.text) {
              currentPostInfo.text = newText;
              textFields.text = newText;
            } else if (currentPostInfo.title) {
              currentPostInfo.title = newText;
              textFields.title = newText;
            } else if (currentPostInfo.description) {
              currentPostInfo.description = newText;
              textFields.description = newText;
            } else {
              // Fallback: set as text
              currentPostInfo.text = newText;
              textFields.text = newText;
            }
            // Save updated data back to the post element
            $post.attr("data-post-info", encodeURIComponent(JSON.stringify(currentPostInfo)));
            console.log("[Fix Text] Updated post data-post-info with fixed text");
            
            // PERSIST TO DATABASE if we have a postId
            if (currentPostInfo.postId) {
              try {
                const dbResult = await window.electronAPI.updatePostText({
                  postId: currentPostInfo.postId,
                  platform: currentPostInfo.type,
                  textFields: textFields
                });
                if (dbResult.success) {
                  console.log("[Fix Text] Successfully persisted to database");
                } else {
                  console.warn("[Fix Text] Database update failed:", dbResult.error);
                }
              } catch (dbErr) {
                console.error("[Fix Text] Database update error:", dbErr);
              }
            } else {
              console.log("[Fix Text] No postId available, skipping database update");
            }
          } catch (dataErr) {
            console.error("[Fix Text] Failed to update post data:", dataErr);
          }

          showAlert("success", window.I18n?.t("workflows.policy_check.text_applied") || "Fixed text copied to clipboard!");

          // Close modal
          $(".fixed-text-modal").fadeOut(100, function () {
            $(this).remove();
          });

          // Clear existing policy result and trigger re-check
          $post.find(".policy-check-result").empty();
          $post.find('[data-role="checkPolicy"]').trigger("click");

        } catch (err) {
          showAlert("error", "Failed to copy text to clipboard");
        }
      });

      // Handle click outside
      $(".fixed-text-modal").on("click", function (e) {
        if (e.target === this) {
          $(this).fadeOut(100, function () {
            $(this).remove();
          });
        }
      });
    }

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="openWorkflow"]',
      async function () {
        const workflowId = $(this).attr("data-id");
        let wf = allWorkflows[workflowId];
        if (!wf) return;

        // Load full workflow details including posts from database
        // This is necessary after app restart when only summary data is cached
        if (!wf.posts || wf.posts.length === 0) {
          const fullWorkflow = await loadWorkflowDetail(workflowId);
          if (fullWorkflow) {
            wf = fullWorkflow;
            allWorkflows[workflowId] = wf;
          }
        }
        const pinterestPosts = (wf.posts || []).filter(
          (p) => p.pinterestOutput != null,
        );
        showDynamicModal(
          window.I18n?.t("workflows.output_modal.type_title", { id: workflowId }) || `Output type (#${workflowId})`,
          `
        <div class="output-type-options">
          <button data-role="startCopyPasteMode" data-id="${workflowId}" class="output-type-card">
            <div class="output-type-icon output-type-icon--copy">
              <i class="material-icons">copy_all</i>
            </div>
            <div class="output-type-info">
              <span class="output-type-label">${window.I18n?.t("workflows.output_modal.copy_paste_label") || "Copy Paste mode"}</span>
              <span class="output-type-desc">${window.I18n?.t("workflows.output_modal.copy_paste_desc") || "Review and copy content for each platform"}</span>
            </div>
            <i class="material-icons output-type-arrow">chevron_right</i>
          </button>
          <button data-role="startCsvMode" data-id="${workflowId}" class="output-type-card ${pinterestPosts.length === 0 ? "output-type-card--disabled" : ""}" ${pinterestPosts.length === 0 ? "disabled" : ""}>
            <div class="output-type-icon output-type-icon--csv">
              <i class="material-icons">file_save</i>
            </div>
            <div class="output-type-info">
              <span class="output-type-label">${window.I18n?.t("workflows.output_modal.csv_label") || "CSV download"}</span>
              <span class="output-type-desc">${pinterestPosts.length === 0 ? (window.I18n?.t("workflows.auto_publish_no_posts") || "No Pinterest posts found in this workflow") : (window.I18n?.t("workflows.output_modal.csv_desc") || "Export Pinterest posts as a CSV file")}</span>
            </div>
            <i class="material-icons output-type-arrow">chevron_right</i>
          </button>
        </div>`,
        );
      },
    );

    $("body").on(
      "click" + WF_NAMESPACE,
      '[data-role="startCsvMode"]',
      async function () {
        const workflowId = $(this).attr("data-id");
        $(this).closest(".dynamicModal").remove();

        let wf = allWorkflows[workflowId] || {};

        // Load full workflow details including posts from database
        // This is necessary after app restart when only summary data is cached
        if (!wf.posts || wf.posts.length === 0) {
          const fullWorkflow = await loadWorkflowDetail(workflowId);
          if (fullWorkflow) {
            wf = fullWorkflow;
            allWorkflows[workflowId] = wf;
          }
        }

        const posts = Array.isArray(wf.posts) ? wf.posts : [];
        const pinterestPosts = posts.filter((p) => p.pinterestOutput);

        if (!pinterestPosts.length) {
          showAlert(
            "error",
            "CSV download unavailable: No Pinterest posts found in this workflow",
          );
          return;
        }

        // Check if this workflow has Pinterest title information for automatic board detection
        const hasAutoBoardInfo = pinterestPosts.some(
          (post) => post.pinterestBoardId && post.pinterestAccountId,
        );
        let promptFields = [];
        
        // Define field names for consistent access
        const boardNameField = "Board name";
        const schedulePeriodField = "Schedule Period";
        const pinsPerCsvField = tWorkflow(
          "pinterest_csv_batch_size",
          "Pins per CSV",
        );

        if (!hasAutoBoardInfo) {
          // Fallback to manual board name entry
          promptFields.push({
            type: "text",
            name: boardNameField,
            required: true,
            placeholder: "Enter Pinterest board name",
          });
        }

        promptFields.push({
          type: "select",
          name: schedulePeriodField,
          required: true,
          options: [
            { label: "All at once (1 hour from now)", value: "all" },
            { label: "12 hours (Half day)", value: "12h" },
            { label: "24 hours (1 day)", value: "24h" },
            { label: "48 hours (2 days)", value: "48h" },
            { label: "72 hours (3 days)", value: "72h" },
            { label: "168 hours (1 week)", value: "168h", selected: true },
            { label: "336 hours (2 weeks)", value: "336h" },
            { label: "720 hours (1 month)", value: "720h" },
          ],
        });

        promptFields.push({
          ...getPinterestCsvBatchPromptField(pinsPerCsvField),
        });

        const result = await newPrompt(promptFields);
        if (!result) return;

        try {
          const interval = result[schedulePeriodField];
          const csvBatchSize = normalizePinterestCsvBatchSize(
            result[pinsPerCsvField],
          );
          const scheduledTimes = calculateScheduleTimes(
            pinterestPosts.length,
            interval,
          );

          // Get Pinterest accounts and boards data for board name lookup
          const pinterestAccounts =
            (await window.electronAPI.readKey("pinterestAccounts")) || {};
          const structures =
            (await window.electronAPI.readKey("structures")) || {};

          const { rows, uniqueProfiles, uniqueBoards } = buildPinterestCsvRows({
            pinterestPosts,
            scheduledTimes,
            pinterestAccounts,
            structures,
            fallbackBoardName: result[boardNameField] || "Unknown Board",
          });

          // Create filename from profile and board names
          const sanitizeFilename = (str) =>
            str.replace(/[^a-zA-Z0-9\-_]/g, "_").substring(0, 30);
          const profilePart = Array.from(uniqueProfiles).join("_");
          const boardPart = Array.from(uniqueBoards).join("_");
          const timestamp = Date.now();
          const defaultFilename = `${sanitizeFilename(profilePart)}_${sanitizeFilename(boardPart)}_${timestamp}.csv`;
          const csvBatches = splitPinterestCsvRows(rows, csvBatchSize);
          let savedFileCount = 0;

          if (csvBatches.length === 1) {
            const { filePath, canceled } =
              await window.electronAPI.showSaveDialog({
                title: "Save Pinterest CSV",
                defaultPath: defaultFilename,
                filters: [{ name: "CSV Files", extensions: ["csv"] }],
              });
            if (canceled || !filePath) return;
            await window.electronAPI.saveFile(
              filePath,
              pinterestRowsToCsv(csvBatches[0]),
            );
            savedFileCount = 1;
          } else {
            const chooseFolderResult = await window.electronAPI.showOpenDialog({
              title: tWorkflow(
                "pinterest_csv_select_folder",
                "Select folder for Pinterest CSV files",
              ),
              properties: ["openDirectory", "createDirectory"],
            });
            const selectedPaths = Array.isArray(chooseFolderResult)
              ? chooseFolderResult
              : chooseFolderResult?.filePaths || [];
            const wasCanceled = Array.isArray(chooseFolderResult)
              ? selectedPaths.length === 0
              : !!chooseFolderResult?.canceled;
            if (wasCanceled || !selectedPaths[0]) return;

            for (let i = 0; i < csvBatches.length; i++) {
              await window.electronAPI.saveFile(
                joinExportPath(
                  selectedPaths[0],
                  addCsvBatchSuffix(defaultFilename, i, csvBatches.length),
                ),
                pinterestRowsToCsv(csvBatches[i]),
              );
            }
            savedFileCount = csvBatches.length;
          }

          // Track CSV export in board-level history
          await trackBoardExportHistory(
            pinterestPosts,
            scheduledTimes,
            workflowId,
          );

          // Mark workflow as exported
          await markWorkflowAsExported(workflowId);

          showAlert(
            "success",
            savedFileCount === 1
              ? tWorkflow(
                  "pinterest_csv_export_success",
                  "CSV file saved successfully with scheduled posts!",
                )
              : tWorkflow(
                  "pinterest_csv_export_split_success",
                  `${savedFileCount} CSV files saved successfully with scheduled posts!`,
                  { count: savedFileCount },
                ),
          );
        } catch (error) {
          console.error("CSV generation failed:", error);
          showAlert("error", "Failed to generate CSV: " + error.message);
        }
      },
    );

    $("body").on(
      "click" + WF_NAMESPACE,
      '[data-role="startCopyPasteMode"]',
      async function () {
        const workflowId = $(this).attr("data-id");
        $(this).closest(".dynamicModal").remove();
        let wf = allWorkflows[workflowId];
        if (!wf) {
          showAlert("error", "Workflow not found!");
          return;
        }

        // Load full workflow details including posts from database
        // This is necessary after app restart when only summary data is cached
        if (!wf.posts || wf.posts.length === 0) {
          const fullWorkflow = await loadWorkflowDetail(workflowId);
          if (fullWorkflow) {
            wf = fullWorkflow;
            allWorkflows[workflowId] = wf;
          }
        }

        const hasFacebook = (wf.posts || []).some(
          (p) => p.facebookOutput != null,
        );
        const hasPinterest = (wf.posts || []).some(
          (p) => p.pinterestOutput != null,
        );
        if (!hasFacebook && !hasPinterest) {
          showAlert("error", "No output found!");
          return;
        }
        showDynamicModal(
          window.I18n?.t("workflows.output_modal.platform_title") || "Output platform",
          `
        ${
          hasPinterest
            ? `
          <label for="pinterestPlatform" class="d-flex justify-content-between my-3 cursor-pointer">
            <span class="me-1 flex-center">
              <img class="me-1" src="assets/images/icons/pinterest-colored.png" width="20">
              <span>Pinterest</span>
            </span>
            <input id="pinterestPlatform" type="checkbox">
          </label>`
            : ""
        }
        ${
          hasFacebook
            ? `
          <label for="facebookPlatform" class="d-flex justify-content-between my-3 cursor-pointer">
            <span class="me-1 flex-center">
              <img class="me-1" src="assets/images/icons/facebook-colored.png" width="20">
              <span>Facebook</span>
            </span>
            <input id="facebookPlatform" type="checkbox">
          </label>`
            : ""
        }
        <button id="platformNext" data-id="${workflowId}" class="btn btn-primary w-100" disabled>${window.I18n?.t("workflows.output_modal.next") || "Next"}</button>`,
        );
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="showProgress"]',
      function () {
        const id = $(this).attr("data-id");
        showLogs(id);
      },
    );

    // Remove exported mark from workflow
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="removeExported"]',
      async function () {
        const workflowId = $(this).data("id");
        // Close the dropdown menu immediately (remove both 'show' on menu and 'open' on container)
        const $dropdown = $(this).closest(".action-dropdown");
        $dropdown.removeClass("open");
        $dropdown.find(".action-dropdown-menu").removeClass("show");
        await unmarkWorkflowAsExported(workflowId);
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="deleteWorkflow"]',
      async function () {
        // Ignore clicks on a disabled delete item (in use by Facebook Groups)
        if (this.classList.contains("is-disabled")) return;
        const workflowId = $(this).data("id");
        const confirmed = await confirmPrompt(
          window.I18n?.t("workflows.delete_confirm") || "Do you really want to delete this workflow?",
        );
        if (!confirmed) return;

        // Stop the workflow first to ensure proper cleanup from queue
        try {
          await window.electronAPI.stopWorkflow(workflowId);
          console.log(`✓ Stopped workflow ${workflowId} before deletion`);
        } catch (error) {
          console.warn(`Could not stop workflow ${workflowId}:`, error);
        }

        // Delete via API
        try {
          const delRes = await window.electronAPI.invoke("delete-workflow", workflowId);
          if (delRes && delRes.success === false) {
            // Blocked (e.g. in use by Facebook Groups) — keep it in the list
            showAlert(
              "warning",
              delRes.error ||
                (window.I18n?.t("workflows.delete_blocked_fb_groups") ||
                  "This workflow is in use by Facebook Groups and cannot be deleted."),
            );
            await loadWorkflowsSummary(true);
            renderWorkflows();
            updateDeleteSelectedButton();
            return;
          }
          delete allWorkflows[workflowId];
          // Also remove from allWorkflowsSummary and update total
          allWorkflowsSummary = allWorkflowsSummary.filter(
            (wf) => wf.workflowId !== workflowId,
          );
          totalWorkflows = Math.max(0, totalWorkflows - 1);
          // Remove from selection if selected
          selectedWorkflowIds.delete(workflowId);
          console.log(`✓ Deleted workflow ${workflowId}`);
        } catch (error) {
          console.error(`Failed to delete workflow ${workflowId}:`, error);
        }

        // Reload all workflows from backend to get fresh data
        await loadWorkflowsSummary(true);
        renderWorkflows();
        updateDeleteSelectedButton();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="openWorkflowProfile"]',
      async function () {
        const workflowId = $(this).data("id");
        await openWorkflowProfile(workflowId);
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="autoPublishPinterest"]',
      async function () {
        const workflowId = $(this).data("id");
        showAutoPublishModal(workflowId);
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="scheduledPins"]',
      async function () {
        const workflowId = $(this).data("id");
        showScheduledPinsModal(workflowId);
      },
    );

    // Start a paused workflow
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="startPausedWorkflow"]',
      async function () {
        const workflowId = $(this).attr("data-id");

        // Load full workflow details (including posts) if not already loaded
        let wf = allWorkflows[workflowId];
        if (!wf || !wf.posts || wf.posts.length === 0) {
          const fullWf = await loadWorkflowDetail(workflowId);
          if (fullWf) {
            wf = fullWf;
            allWorkflows[workflowId] = wf;
          }
        }

        if (!wf) {
          showAlert("error", "Could not load workflow details.");
          return;
        }

        const posts = wf.posts || [];
        if (posts.length === 0) {
          showAlert("error", "No posts found in this workflow.");
          return;
        }

        // Update status to pending in-memory and in DB, then execute
        await updateWorkflowStatus(workflowId, "pending", 0);

        window.electronAPI.executeAutomation(
          workflowId,
          wf.automationId,
          posts,
        );
        showLogs(workflowId);
        renderWorkflows();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="stopWorkflow"]',
      async function () {
        const workflowId = $(this).attr("data-id");
        const confirmed = await confirmPrompt(
          "Do you really want to stop the workflow process?",
        );
        if (!confirmed) return;

        // Call backend to stop workflow - it will send workflow-stopped event
        await window.electronAPI.stopWorkflow(workflowId);

        // The workflow-stopped event handler will update the UI
        // But also do immediate visual feedback
        if (allWorkflows[workflowId]) {
          allWorkflows[workflowId].status = "failed";
        }
        renderWorkflows();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="rerunFailedWorkflow"]',
      async function () {
        const workflowId = $(this).attr("data-id");
        let wf = allWorkflows[workflowId];

        if (!wf) {
          showAlert("error", "Workflow not found!");
          return;
        }

        // Safety check - prevent rerunning if workflow is not in a terminal state
        if (wf.status === "pending") {
          showAlert(
            "warning",
            "This workflow is already running. Please wait for it to complete or stop it first.",
          );
          return;
        }

        // ========================================
        // Clean up any lingering backend state before rerun
        // ========================================
        
        // Call clearWorkflowStateForRerun to clean up state without marking as stopped
        // This prevents "Workflow stopped by user" errors on immediate reruns
        try {
          await window.electronAPI.clearWorkflowStateForRerun(workflowId);
          console.log(`[Rerun] Cleared stale state for workflow ${workflowId}`);
        } catch (err) {
          console.warn(`[Rerun] State cleanup warning (non-fatal): ${err.message}`);
        }

        // ALWAYS load full workflow details from database on rerun
        // This ensures we have the correct skipImageChoosing flag and all post data
        const fullWorkflow = await loadWorkflowDetail(workflowId);
        if (fullWorkflow) {
          wf = fullWorkflow;
          allWorkflows[workflowId] = wf;
          console.log(
            `[Rerun] Loaded workflow details - skipImageChoosing: ${wf.skipImageChoosing}`,
          );
        } else if (!wf.posts || wf.posts.length === 0) {
          showAlert("error", "Failed to load workflow details!");
          return;
        }

        // Count failed and pending posts
        const failedPosts = wf.posts
          ? wf.posts.filter(
              (post) => post.status === "failed" || post.status === "pending",
            )
          : [];
        const completedPosts = wf.posts
          ? wf.posts.filter((post) => post.status === "completed")
          : [];

        if (failedPosts.length === 0 && completedPosts.length === 0) {
          showAlert(
            "info",
            "No posts available to rerun.",
          );
          return;
        }

        // Show rerun modal with automation switching option
        const currentAutomationName = getAutomationName(wf.automationId);
        const rerunResult = await window.showRerunAutomationModal(
          wf.automationId,
          currentAutomationName,
          failedPosts.length,
          completedPosts.length
        );

        if (!rerunResult.proceed) return;

        // Build the list of posts to rerun. Completed posts are included only when
        // the user explicitly opted in via the modal checkbox.
        const postsToRerun = rerunResult.includeCompleted
          ? [...failedPosts, ...completedPosts]
          : failedPosts;

        if (postsToRerun.length === 0) {
          showAlert("info", "No posts selected to rerun.");
          return;
        }

        // Determine the automation to use
        const targetAutomationId = rerunResult.newAutomationId || wf.automationId;

        // If user selected a different automation (and NOT creating new workflow), update it on original
        if (rerunResult.newAutomationId && !rerunResult.createNewWorkflow) {
          console.log(`[Rerun] Switching automation from ${wf.automationId} to ${rerunResult.newAutomationId}`);
          
          // Update in database
          await window.electronAPI.updateWorkflowAutomation(workflowId, rerunResult.newAutomationId);
          
          // Update in memory
          wf.automationId = rerunResult.newAutomationId;
          
          showAlert("info", `Switched to automation: ${getAutomationName(rerunResult.newAutomationId)}`);
        }

        // Pre-flight validation BEFORE any status changes
        // This ensures we don't modify workflow state if validation fails
        const isValid = await validateWorkflowPreflight(targetAutomationId, postsToRerun);
        if (!isValid) {
          renderWorkflows();
          return;
        }

        // ========================================
        // CREATE NEW WORKFLOW path
        // ========================================
        if (rerunResult.createNewWorkflow) {
          const newWorkflowId = genId(10);
          const automationName = getAutomationName(targetAutomationId);
          const newWorkflowName = `Rerun: ${wf.name || workflowId} — ${automationName}`;

          // Create new posts based on the posts to rerun (deep copy with new IDs)
          const newPosts = postsToRerun.map((post) => ({
            postMessage: post.postMessage,
            postImg: post.postImg,
            postId: genId(10),
            status: "pending",
            progress: 0,
            nodes: [],
            pinterestTitleId: post.pinterestTitleId || null,
            pinterestAccountId: post.pinterestAccountId || null,
            pinterestBoardId: post.pinterestBoardId || null,
            originalInputImage: post.originalInputImage || null,
          }));

          const newWorkflowData = {
            workflowId: newWorkflowId,
            progress: 0,
            automationId: targetAutomationId,
            posts: newPosts,
            createdAt: new Date().toISOString(),
            status: "pending",
            name: newWorkflowName,
            skipImageChoosing: false,
          };

          const createResult = await window.electronAPI.invoke("create-workflow", newWorkflowData);
          if (!createResult.success) {
            showAlert("error", createResult.error || "Failed to create new workflow");
            return;
          }

          // Add to in-memory cache
          allWorkflows[newWorkflowId] = newWorkflowData;

          // Only show skip modal if workflow has Midjourney node
          const hasMidjourney = await automationHasMidjourneyNode(targetAutomationId);
          const skipImageChoosing = hasMidjourney ? await showWorkflowSkipModal() : true;

          await window.electronAPI.setWorkflowSkipMode(newWorkflowId, skipImageChoosing);
          await window.electronAPI.updateWorkflowSkipMode(newWorkflowId, skipImageChoosing);
          newWorkflowData.skipImageChoosing = skipImageChoosing;

          await new Promise((resolve) => setTimeout(resolve, 100));

          showAlert("info", `Created new workflow with ${newPosts.length} post(s). Starting...`);
          window.electronAPI.executeAutomation(newWorkflowId, targetAutomationId, newPosts);

          // Refresh workflows list
          await loadWorkflowsSummary(true);
          renderWorkflows();
          showLogs(newWorkflowId);
          return;
        }

        // ========================================
        // ORIGINAL RERUN path (modify existing workflow)
        // ========================================

        // Reset workflow status and progress
        wf.status = "pending";

        // Reset the selected posts to pending and clear their execution data.
        // When the user opted to rerun completed posts, those are included too.
        const rerunPostIds = new Set(postsToRerun.map((p) => p.postId));
        if (wf.posts && Array.isArray(wf.posts)) {
          for (const post of wf.posts) {
            if (rerunPostIds.has(post.postId)) {
              post.status = "pending";
              post.progress = 0;
              post.nodes = []; // Clear node execution history
              // Clear output data from memory
              delete post.pinterestOutput;
              delete post.facebookOutput;

              // Reset post in database - clears outputs, node executions, and status
              try {
                await window.electronAPI.invoke(
                  "reset-post-for-rerun",
                  post.postId,
                );
              } catch (err) {
                console.warn(
                  `Failed to reset post ${post.postId} for rerun:`,
                  err,
                );
              }
            }
            // Posts not selected for rerun remain untouched
          }
        }

        // Recalculate workflow progress based on completed vs pending posts
        const totalPosts = wf.posts.length;
        const completedCount = wf.posts.filter(
          (p) => p.status === "completed",
        ).length;
        wf.progress = Math.round((completedCount / totalPosts) * 100);

        // Save workflow status to database
        await updateWorkflowStatus(workflowId, wf.status, wf.progress);

        // Sync to global cache
        allWorkflows[workflowId] = wf;
        if (window.workflowCache) {
          window.workflowCache.allWorkflows = allWorkflows;
        }

        // Re-execute the selected posts
        if (wf.automationId && postsToRerun.length > 0) {
          // Only show skip modal if workflow has Midjourney node, otherwise auto-skip
          const hasMidjourney = await automationHasMidjourneyNode(
            wf.automationId,
          );
          const skipImageChoosing = hasMidjourney
            ? await showWorkflowSkipModal()
            : true;
          console.log(
            `[Rerun] User selected skipImageChoosing: ${skipImageChoosing}`,
          );

          // Always set the skip mode BEFORE starting execution
          console.log(
            `[Rerun] Setting skip mode for workflow ${workflowId} to: ${skipImageChoosing}`,
          );
          const skipModeResult = await window.electronAPI.setWorkflowSkipMode(
            workflowId,
            skipImageChoosing,
          );
          console.log(`[Rerun] Skip mode set result: ${skipModeResult}`);

          // Update the workflow's skipImageChoosing flag
          wf.skipImageChoosing = skipImageChoosing;

          // Also update the database to persist the setting
          await window.electronAPI.updateWorkflowSkipMode(
            workflowId,
            skipImageChoosing,
          );
          console.log(
            `[Rerun] Updated workflow skipImageChoosing in database: ${skipImageChoosing}`,
          );

          // Small delay to ensure IPC message is fully processed
          await new Promise((resolve) => setTimeout(resolve, 100));

          showAlert(
            "info",
            `Restarting ${postsToRerun.length} post(s)...`,
          );
          console.log(
            `[Rerun] Calling executeAutomation for workflow ${workflowId} with ${postsToRerun.length} posts`,
          );
          window.electronAPI.executeAutomation(
            workflowId,
            wf.automationId,
            postsToRerun,
          );
          showLogs(workflowId);
        } else {
          showAlert(
            "error",
            "Cannot restart workflow: Missing automation or posts data",
          );
        }

        renderWorkflows();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '.copypaste-image-ai-score[data-score-provider="sightengine"].has-details',
      function (event) {
        event.preventDefault();
        event.stopPropagation();
        openSightengineDetailsModal($(this).data("sightengineResult"));
      },
    );

    $("#workflows-container").on(
      "keydown" + WF_NAMESPACE,
      '.copypaste-image-ai-score[data-score-provider="sightengine"].has-details',
      function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openSightengineDetailsModal($(this).data("sightengineResult"));
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="copyContent"]',
      async function () {
        const $btn = $(this);
        $btn.prop("disabled", true);
        await navigator.clipboard.writeText(
          $btn.closest(".copy-area").find("pre").text(),
        );
        $btn.prop("disabled", false);
        showAlert("success", "Successfully copied to clipboard!");
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="copyAndNext"]',
      async function () {
        const $btn = $(this);
        $btn.prop("disabled", true);
        await navigator.clipboard.writeText(
          $btn.closest(".copy-area").find("pre").text(),
        );
        $btn.prop("disabled", false);
        showAlert("success", "Successfully copied to clipboard!");
        $btn.closest(".post").find('[data-role="next"]').trigger("click");
      },
    );

    // Play button: activate video player on click
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".video-play-btn",
      function () {
        const $placeholder = $(this).closest(".video-lazy-placeholder");
        const src = $placeholder.data("src");
        if (!src) return;
        $placeholder.addClass("video-active");
        $placeholder.html(`
          <video class="copypaste-video" controls autoplay src="${src}">
            Your browser does not support the video tag.
          </video>
        `);
      },
    );

    // Helper: restore video placeholder from active player state
    function restoreVideoPlaceholder($post) {
      const $placeholder = $post.find(".video-lazy-placeholder.video-active");
      if (!$placeholder.length) return;
      const video = $placeholder.find("video")[0];
      if (video) { video.pause(); }
      $placeholder.html(`
        <div class="video-thumb-fallback">
          <i class="material-icons">videocam</i>
        </div>
        <button class="video-play-btn" aria-label="Play video">
          <i class="material-icons">play_circle</i>
        </button>
      `);
      $placeholder.removeClass("video-active");
    }

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="next"]',
      function () {
        const $posts = $(
          "#workflows-container .workflow-copypaste .copypaste-container .post",
        );
        const idx = $(this).closest(".post").index();
        const $current = $posts.eq(idx);
        restoreVideoPlaceholder($current);
        $current.hide();
        $posts.eq(Math.min(idx + 1, $posts.length - 1)).show();
      },
    );

    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      '[data-role="prev"]',
      function () {
        const $posts = $(
          "#workflows-container .workflow-copypaste .copypaste-container .post",
        );
        const idx = $(this).closest(".post").index();
        const $current = $posts.eq(idx);
        restoreVideoPlaceholder($current);
        $current.hide();
        $posts.eq(Math.max(idx - 1, 0)).show();
      },
    );

    // Select all workflows checkbox
    $("#workflows-container").on(
      "change" + WF_NAMESPACE,
      "#selectAllWorkflows",
      function () {
        const isChecked = $(this).prop("checked");
        $(".workflow-checkbox").each(function () {
          const workflowId = $(this).data("workflow-id");
          $(this).prop("checked", isChecked);
          if (isChecked) {
            selectedWorkflowIds.add(workflowId);
          } else {
            selectedWorkflowIds.delete(workflowId);
          }
        });
        updateDeleteSelectedButton();
      },
    );

    // Individual workflow checkbox with shift-click multi-select support
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      ".workflow-checkbox",
      function (e) {
        const $checkboxes = $(".workflow-checkbox");
        const currentIndex = $checkboxes.index(this);
        const isChecked = $(this).prop("checked");
        const workflowId = $(this).data("workflow-id");

        // Handle shift-click range selection
        if (
          e.shiftKey &&
          lastCheckedWorkflowIndex !== null &&
          lastCheckedWorkflowIndex !== currentIndex
        ) {
          const start = Math.min(lastCheckedWorkflowIndex, currentIndex);
          const end = Math.max(lastCheckedWorkflowIndex, currentIndex);

          $checkboxes.slice(start, end + 1).each(function () {
            $(this).prop("checked", isChecked);
            const wfId = $(this).data("workflow-id");
            if (isChecked) {
              selectedWorkflowIds.add(wfId);
            } else {
              selectedWorkflowIds.delete(wfId);
            }
          });
        } else {
          // Single checkbox click
          if (isChecked) {
            selectedWorkflowIds.add(workflowId);
          } else {
            selectedWorkflowIds.delete(workflowId);
          }
        }

        // Update last checked index
        lastCheckedWorkflowIndex = currentIndex;

        const totalCheckboxes = $checkboxes.length;
        const checkedCheckboxes = $checkboxes.filter(":checked").length;
        $("#selectAllWorkflows").prop(
          "checked",
          totalCheckboxes === checkedCheckboxes,
        );
        updateDeleteSelectedButton();
      },
    );

    // Start selected paused workflows
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#startSelectedWorkflows",
      async function () {
        const selectedIds = Array.from(selectedWorkflowIds);
        if (selectedIds.length === 0) return;

        // Filter to only paused workflows
        const pausedIds = selectedIds.filter((workflowId) => {
          const summaryWf = allWorkflowsSummary.find(
            (w) => (w.workflowId || w.id) === workflowId,
          );
          const status = summaryWf?.status || allWorkflows[workflowId]?.status;
          return status === "paused";
        });

        if (pausedIds.length === 0) return;

        // Show loading overlay while loading workflow details
        $("body").append(`
          <div class="modern-loading-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; flex-direction: column;">
            <div class="spinner-border text-light mb-3" role="status" style="width: 3rem; height: 3rem;"></div>
            <div class="loading-text text-light">Loading workflow details...</div>
          </div>
        `);

        // Load full details for all paused workflows
        for (let i = 0; i < pausedIds.length; i++) {
          const workflowId = pausedIds[i];
          $(".modern-loading-overlay .loading-text").text(
            `Loading workflow ${i + 1} of ${pausedIds.length}...`,
          );
          if (!allWorkflows[workflowId] || !allWorkflows[workflowId].posts || allWorkflows[workflowId].posts.length === 0) {
            const fullWf = await loadWorkflowDetail(workflowId);
            if (fullWf) {
              allWorkflows[workflowId] = fullWf;
            }
          }
        }

        $(".modern-loading-overlay").remove();

        let successCount = 0;
        for (const workflowId of pausedIds) {
          const wf = allWorkflows[workflowId];
          if (!wf) continue;
          const posts = wf.posts || [];
          if (posts.length === 0) continue;

          await updateWorkflowStatus(workflowId, "pending", 0);
          window.electronAPI.executeAutomation(workflowId, wf.automationId, posts);
          successCount++;
        }

        renderWorkflows();
        if (successCount > 0) {
          showAlert("success", `Started ${successCount} workflow${successCount > 1 ? "s" : ""}.`);
        }
      },
    );

    // Delete selected workflows
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#deleteSelectedWorkflows",
      async function () {
        const selectedIds = Array.from(selectedWorkflowIds);

        if (selectedIds.length === 0) return;

        const confirmed = await confirmPrompt(
          `Delete ${selectedIds.length} selected workflow${selectedIds.length > 1 ? "s" : ""}?`,
        );
        if (!confirmed) return;

        let blockedCount = 0;
        for (const workflowId of selectedIds) {
          // Stop the workflow first to ensure proper cleanup from queue
          try {
            await window.electronAPI.stopWorkflow(workflowId);
            console.log(`✓ Stopped workflow ${workflowId} before deletion`);
          } catch (error) {
            console.warn(`Could not stop workflow ${workflowId}:`, error);
          }

          // Delete via API
          try {
            const delRes = await window.electronAPI.invoke("delete-workflow", workflowId);
            if (delRes && delRes.success === false) {
              // Blocked (e.g. in use by Facebook Groups) — leave it in place
              blockedCount++;
              console.warn(`Workflow ${workflowId} not deleted: ${delRes.error}`);
              continue;
            }
            delete allWorkflows[workflowId];
            // Also remove from allWorkflowsSummary
            allWorkflowsSummary = allWorkflowsSummary.filter(
              (wf) => wf.workflowId !== workflowId,
            );
            totalWorkflows = Math.max(0, totalWorkflows - 1);
            console.log(`✓ Deleted workflow ${workflowId}`);
          } catch (error) {
            console.error(`Failed to delete workflow ${workflowId}:`, error);
          }
        }

        if (blockedCount > 0) {
          showAlert(
            "warning",
            window.I18n?.t("workflows.delete_blocked_fb_groups_bulk", { count: blockedCount }) ||
              `${blockedCount} workflow${blockedCount > 1 ? "s were" : " was"} not deleted because ${blockedCount > 1 ? "they are" : "it is"} in use by Facebook Groups.`,
          );
        }

        // Clear the selection tracking Set after deletion
        selectedWorkflowIds.clear();
        lastCheckedWorkflowIndex = null;
        $("#selectAllWorkflows").prop("checked", false);

        // Reload all workflows from backend to get fresh data
        await loadWorkflowsSummary(true);
        renderWorkflows();
        updateDeleteSelectedButton();
      },
    );

    // Rerun selected workflows
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#rerunSelectedWorkflows",
      async function () {
        const selectedIds = Array.from(selectedWorkflowIds);

        if (selectedIds.length === 0) return;

        // Show loading overlay while loading workflow details
        $("body").append(`
          <div class="modern-loading-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; flex-direction: column;">
            <div class="spinner-border text-light mb-3" role="status" style="width: 3rem; height: 3rem;"></div>
            <div class="loading-text text-light">Loading workflow details...</div>
          </div>
        `);

        // Load full workflow details for all selected workflows first
        for (let i = 0; i < selectedIds.length; i++) {
          const workflowId = selectedIds[i];
          $(".modern-loading-overlay .loading-text").text(
            `Loading workflow ${i + 1} of ${selectedIds.length}...`,
          );
          const fullWorkflow = await loadWorkflowDetail(workflowId);
          if (fullWorkflow) {
            allWorkflows[workflowId] = fullWorkflow;
          }
        }

        // Now count total failed posts across all selected workflows
        // AND build a filtered list of only workflows that have rerunnable posts
        let totalFailedPosts = 0;
        const workflowIdsWithFailedPosts = [];
        for (const workflowId of selectedIds) {
          const wf = allWorkflows[workflowId];
          if (wf && wf.posts) {
            const failedCount = wf.posts.filter(
              (p) => p.status === "failed" || p.status === "pending",
            ).length;
            const completedCount = wf.posts.filter(
              (p) => p.status === "completed",
            ).length;
            if (failedCount > 0 || completedCount > 0) {
              totalFailedPosts += failedCount;
              workflowIdsWithFailedPosts.push(workflowId);
            }
          }
        }

        // Remove loading overlay for now
        $(".modern-loading-overlay").remove();

        if (workflowIdsWithFailedPosts.length === 0) {
          showAlert(
            "info",
            "No posts available to rerun in selected workflows.",
          );
          return;
        }

        // Show rerun modal with automation switching and new workflow options
        // Use the first workflow's automation as the "current" reference
        const firstWf = allWorkflows[workflowIdsWithFailedPosts[0]];
        const totalCompletedPosts = workflowIdsWithFailedPosts.reduce((sum, wfId) => {
          const w = allWorkflows[wfId];
          return sum + (w && w.posts ? w.posts.filter(p => p.status === "completed").length : 0);
        }, 0);
        const currentAutomationName = getAutomationName(firstWf.automationId);
        const rerunResult = await window.showRerunAutomationModal(
          firstWf.automationId,
          currentAutomationName,
          totalFailedPosts,
          totalCompletedPosts
        );

        if (!rerunResult.proceed) return;

        // Determine if user wants to switch automation for all workflows
        const batchNewAutomationId = rerunResult.newAutomationId || null;
        const batchCreateNewWorkflow = rerunResult.createNewWorkflow || false;
        const batchIncludeCompleted = rerunResult.includeCompleted || false;

        // Show loading overlay again for execution
        $("body").append(`
          <div class="modern-loading-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; flex-direction: column;">
            <div class="spinner-border text-light mb-3" role="status" style="width: 3rem; height: 3rem;"></div>
            <div class="loading-text text-light">Preparing workflows for rerun...</div>
          </div>
        `);

        let successCount = 0;
        let currentIndex = 0;

        // Ask once for skip mode (will apply to all)
        let skipImageChoosing = true;
        let hasMidjourneyInAny = false;

        // Determine automation IDs to check for Midjourney
        const automationIdsToCheck = new Set();
        for (const workflowId of workflowIdsWithFailedPosts) {
          const wf = allWorkflows[workflowId];
          if (wf) {
            automationIdsToCheck.add(batchNewAutomationId || wf.automationId);
          }
        }

        // Check if any target automation has Midjourney
        for (const automationId of automationIdsToCheck) {
          if (automationId) {
            const hasMidjourney = await automationHasMidjourneyNode(automationId);
            if (hasMidjourney) {
              hasMidjourneyInAny = true;
              break;
            }
          }
        }

        if (hasMidjourneyInAny) {
          $(".modern-loading-overlay").remove();
          skipImageChoosing = await showWorkflowSkipModal();
          $("body").append(`
            <div class="modern-loading-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; flex-direction: column;">
              <div class="spinner-border text-light mb-3" role="status" style="width: 3rem; height: 3rem;"></div>
              <div class="loading-text text-light">Validating workflows...</div>
            </div>
          `);
        }

        // Pre-flight validation: validate each unique automation once
        const validatedAutomations = new Set();
        const failedAutomations = new Set();

        for (const workflowId of workflowIdsWithFailedPosts) {
          const wf = allWorkflows[workflowId];
          if (!wf) continue;
          const targetAutomationId = batchNewAutomationId || wf.automationId;
          if (!targetAutomationId) continue;
          
          // Skip if already validated
          if (validatedAutomations.has(targetAutomationId) || failedAutomations.has(targetAutomationId)) continue;

          // Get sample posts for validation
          const samplePool = wf.posts
            ? wf.posts.filter((p) =>
                p.status === "failed" ||
                p.status === "pending" ||
                (batchIncludeCompleted && p.status === "completed"),
              )
            : [];
          const samplePosts = samplePool.slice(0, 1);

          const isValid = await validateWorkflowPreflight(targetAutomationId, samplePosts);
          if (isValid) {
            validatedAutomations.add(targetAutomationId);
          } else {
            failedAutomations.add(targetAutomationId);
            // Remove loading overlay so user can see the error modal
            $(".modern-loading-overlay").remove();
            return;
          }
        }

        // Re-show loading if it was removed for validation modal
        if (!$(".modern-loading-overlay").length) {
          $("body").append(`
            <div class="modern-loading-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; flex-direction: column;">
              <div class="spinner-border text-light mb-3" role="status" style="width: 3rem; height: 3rem;"></div>
              <div class="loading-text text-light">Starting workflows...</div>
            </div>
          `);
        }

        for (const workflowId of workflowIdsWithFailedPosts) {
          currentIndex++;
          $(".modern-loading-overlay .loading-text").text(
            `Rerunning workflow ${currentIndex} of ${workflowIdsWithFailedPosts.length}...`,
          );

          let wf = allWorkflows[workflowId];
          if (!wf) continue;

          // Skip workflows that are currently running
          if (wf.status === "pending") {
            console.log(`Skipping workflow ${workflowId} - already running`);
            continue;
          }

          // Get failed posts
          const failedPosts = wf.posts
            ? wf.posts.filter(
                (post) => post.status === "failed" || post.status === "pending",
              )
            : [];
          const completedPosts = wf.posts
            ? wf.posts.filter((post) => post.status === "completed")
            : [];

          // Include completed posts only when the user opted in via the modal
          const postsToRerun = batchIncludeCompleted
            ? [...failedPosts, ...completedPosts]
            : failedPosts;

          if (postsToRerun.length === 0) continue;

          const targetAutomationId = batchNewAutomationId || wf.automationId;

          // ========================================
          // CREATE NEW WORKFLOW path (batch)
          // ========================================
          if (batchCreateNewWorkflow) {
            const newWorkflowId = genId(10);
            const automationName = getAutomationName(targetAutomationId);
            const newWorkflowName = `Rerun: ${wf.name || workflowId} — ${automationName}`;

            // Create new posts based on the posts to rerun (deep copy with new IDs)
            const newPosts = postsToRerun.map((post) => ({
              postMessage: post.postMessage,
              postImg: post.postImg,
              postId: genId(10),
              status: "pending",
              progress: 0,
              nodes: [],
              pinterestTitleId: post.pinterestTitleId || null,
              pinterestAccountId: post.pinterestAccountId || null,
              pinterestBoardId: post.pinterestBoardId || null,
              originalInputImage: post.originalInputImage || null,
            }));

            const newWorkflowData = {
              workflowId: newWorkflowId,
              progress: 0,
              automationId: targetAutomationId,
              posts: newPosts,
              createdAt: new Date().toISOString(),
              status: "pending",
              name: newWorkflowName,
              skipImageChoosing: skipImageChoosing,
            };

            const createResult = await window.electronAPI.invoke("create-workflow", newWorkflowData);
            if (!createResult.success) {
              console.error(`[Batch Rerun] Failed to create new workflow for ${workflowId}:`, createResult.error);
              continue;
            }

            allWorkflows[newWorkflowId] = newWorkflowData;

            await window.electronAPI.setWorkflowSkipMode(newWorkflowId, skipImageChoosing);
            await window.electronAPI.updateWorkflowSkipMode(newWorkflowId, skipImageChoosing);

            window.electronAPI.executeAutomation(newWorkflowId, targetAutomationId, newPosts);
            successCount++;

            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }

          // ========================================
          // ORIGINAL RERUN path (modify existing workflow)
          // ========================================

          // If user selected a different automation, update it on original workflow
          if (batchNewAutomationId) {
            await window.electronAPI.updateWorkflowAutomation(workflowId, batchNewAutomationId);
            wf.automationId = batchNewAutomationId;
          }

          // Reset workflow status
          wf.status = "pending";

          // Reset the posts selected for rerun
          for (const post of postsToRerun) {
            post.status = "pending";
            post.progress = 0;
            post.nodes = [];
            delete post.pinterestOutput;
            delete post.facebookOutput;

            // Reset post in database - clears outputs, node executions, and status
            try {
              await window.electronAPI.invoke(
                "reset-post-for-rerun",
                post.postId,
              );
            } catch (err) {
              console.warn(`Failed to reset post ${post.postId} for rerun:`, err);
            }
          }

          // Recalculate progress
          const completedCount = wf.posts.filter(
            (p) => p.status === "completed",
          ).length;
          wf.progress = Math.round((completedCount / wf.posts.length) * 100);

          // Save workflow status
          await updateWorkflowStatus(workflowId, wf.status, wf.progress);

          // Set skip mode
          await window.electronAPI.setWorkflowSkipMode(
            workflowId,
            skipImageChoosing,
          );
          await window.electronAPI.updateWorkflowSkipMode(
            workflowId,
            skipImageChoosing,
          );
          wf.skipImageChoosing = skipImageChoosing;

          // Execute
          if (wf.automationId) {
            window.electronAPI.executeAutomation(
              workflowId,
              wf.automationId,
              postsToRerun,
            );
            successCount++;
          }

          // Small delay between launches to prevent overwhelming the system
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        // Remove loading overlay
        $(".modern-loading-overlay").remove();

        // Clear selection
        selectedWorkflowIds.clear();
        lastCheckedWorkflowIndex = null;
        $("#selectAllWorkflows").prop("checked", false);

        // Refresh
        await loadWorkflowsSummary(true);
        renderWorkflows();
        updateDeleteSelectedButton();

        showAlert("success", `Started rerun for ${successCount} workflow(s)`);
      },
    );

    // Auto-publish selected workflows
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#autoPublishSelectedWorkflows",
      async function () {
        const selectedIds = Array.from(selectedWorkflowIds);
        if (selectedIds.length === 0) return;
        clearWorkflowSelection();
        showAutoPublishModal(selectedIds);
      },
    );

    // Scheduled Pins for selected workflows
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#scheduledPinsSelectedWorkflows",
      async function () {
        const selectedIds = Array.from(selectedWorkflowIds);
        if (selectedIds.length === 0) return;
        clearWorkflowSelection();
        showBulkScheduledPinsModal(selectedIds);
      },
    );

    // Remove exported mark from selected workflows
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#removeExportedSelectedWorkflows",
      async function () {
        const exportedIds = Array.from(selectedWorkflowIds).filter((id) => {
          const summaryWf = allWorkflowsSummary.find(
            (w) => (w.workflowId || w.id) === id,
          );
          return summaryWf?.exported || allWorkflows[id]?.exported;
        });
        if (exportedIds.length === 0) return;
        clearWorkflowSelection();
        for (const workflowId of exportedIds) {
          await unmarkWorkflowAsExported(workflowId);
        }
      },
    );

    // Bulk export CSV for selected workflows (all must be Pinterest workflows)
    $("#workflows-container").on(
      "click" + WF_NAMESPACE,
      "#bulkExportCsvSelectedWorkflows",
      async function () {
        const selectedIds = Array.from(selectedWorkflowIds);
        if (selectedIds.length < 2) {
          showAlert("error", "Select at least 2 workflows for bulk CSV export.");
          return;
        }

        const pinsPerCsvField = tWorkflow(
          "pinterest_csv_batch_size",
          "Pins per CSV",
        );
        const batchPromptResult = await newPrompt([
          getPinterestCsvBatchPromptField(pinsPerCsvField),
        ]);
        if (!batchPromptResult) return;
        const csvBatchSize = normalizePinterestCsvBatchSize(
          batchPromptResult[pinsPerCsvField],
        );

        clearWorkflowSelection();

        const chooseFolderResult = await window.electronAPI.showOpenDialog({
          title: "Select folder for bulk Pinterest CSV export",
          properties: ["openDirectory", "createDirectory"],
        });

        // Compatibility: show-open-dialog may return either an array of paths or
        // an object with { canceled, filePaths } depending on IPC implementation.
        const selectedPaths = Array.isArray(chooseFolderResult)
          ? chooseFolderResult
          : chooseFolderResult?.filePaths || [];
        const wasCanceled = Array.isArray(chooseFolderResult)
          ? selectedPaths.length === 0
          : !!chooseFolderResult?.canceled;

        if (wasCanceled || !selectedPaths[0]) {
          return;
        }

        const targetFolder = selectedPaths[0];
        if (!targetFolder) {
          showAlert("error", "Could not resolve selected export folder.");
          return;
        }
        const interval = "168h";
        const pinterestAccounts = (await window.electronAPI.readKey("pinterestAccounts")) || {};
        const structures = (await window.electronAPI.readKey("structures")) || {};

        const sanitizeFilename = (str) =>
          String(str || "")
            .replace(/[^a-zA-Z0-9\-_]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "")
            .substring(0, 40) || "workflow";

        let successCount = 0;
        let failCount = 0;
        let exportedFileCount = 0;

        for (const workflowId of selectedIds) {
          try {
            let wf = allWorkflows[workflowId] || {};
            if (!wf.posts || wf.posts.length === 0) {
              const fullWorkflow = await loadWorkflowDetail(workflowId);
              if (fullWorkflow) {
                wf = fullWorkflow;
                allWorkflows[workflowId] = wf;
              }
            }

            const posts = Array.isArray(wf.posts) ? wf.posts : [];
            const pinterestPosts = posts.filter((p) => p.pinterestOutput);
            if (!pinterestPosts.length) {
              throw new Error("No Pinterest posts found");
            }

            const scheduledTimes = calculateScheduleTimes(pinterestPosts.length, interval);
            const { rows, uniqueProfiles, uniqueBoards } = buildPinterestCsvRows({
              pinterestPosts,
              scheduledTimes,
              pinterestAccounts,
              structures,
            });

            const profilePart = sanitizeFilename(Array.from(uniqueProfiles).join("_"));
            const boardPart = sanitizeFilename(Array.from(uniqueBoards).join("_"));
            const profileBoardPart = sanitizeFilename(`${profilePart}_${boardPart}`);

            // Clean workflow segment for filenames
            let wfPart = sanitizeFilename(wf.name || workflowId)
              .replace(/^bulk[_-]+/i, "")
              .replace(/^_+|_+$/g, "");

            if (/^bulk$/i.test(wfPart)) {
              wfPart = "";
            }

            // Avoid duplicating profile/board if workflow name already contains it
            const wfPartLower = String(wfPart).toLowerCase();
            const profileBoardLower = String(profileBoardPart).toLowerCase();
            const hasProfileBoardAlready =
              profileBoardLower &&
              (wfPartLower === profileBoardLower || wfPartLower.includes(profileBoardLower));

            const baseName =
              wfPart && !hasProfileBoardAlready
                ? `${wfPart}_${profileBoardPart}`
                : (wfPart || profileBoardPart || sanitizeFilename(workflowId));

            const fileName = `${baseName}_${Date.now()}.csv`;
            const csvBatches = splitPinterestCsvRows(rows, csvBatchSize);
            for (let i = 0; i < csvBatches.length; i++) {
              await window.electronAPI.saveFile(
                joinExportPath(
                  targetFolder,
                  addCsvBatchSuffix(fileName, i, csvBatches.length),
                ),
                pinterestRowsToCsv(csvBatches[i]),
              );
            }
            exportedFileCount += csvBatches.length;

            await trackBoardExportHistory(pinterestPosts, scheduledTimes, workflowId);
            await markWorkflowAsExported(workflowId);
            successCount++;
          } catch (error) {
            console.error(`[Bulk CSV] Failed for workflow ${workflowId}:`, error);
            failCount++;
          }
        }

        await loadWorkflowsSummary(true);
        renderWorkflows();

        if (successCount > 0 && failCount === 0) {
          showAlert("success", `Bulk CSV export complete. ${exportedFileCount} file(s) saved to selected folder.`);
        } else if (successCount > 0) {
          showAlert("info", `Bulk CSV export finished. ${successCount} workflow(s) succeeded, ${failCount} failed. ${exportedFileCount} file(s) saved.`);
        } else {
          showAlert("error", "Bulk CSV export failed for all selected workflows.");
        }
      },
    );

    // NOTE: We no longer remove all listeners here since global listeners in app.js handle data updates
    // The workflows.js page now only needs to set up UI refresh intervals

    // Track last known state for change detection (only current page workflows)
    function buildCurrentPageState() {
      // Only track workflows on the current page to avoid unnecessary re-renders
      const currentPageIds = allWorkflowsSummary.map(
        (wf) => wf.workflowId || wf.id,
      );
      return JSON.stringify(
        currentPageIds.map((id) => {
          const wf = allWorkflows[id];
          if (!wf) return { id, missing: true };
          return {
            id: wf.workflowId,
            status: wf.status,
            progress: wf.progress,
            postsHash: wf.posts
              ? wf.posts
                  .map((p) => `${p.postId}:${p.status}:${p.progress}`)
                  .join(",")
              : "",
          };
        }),
      );
    }

    let lastKnownState = buildCurrentPageState();

    // Set up a UI refresh interval while on the workflows page
    // This will pick up changes made by the global event handlers in app.js
    const workflowsPageRefreshInterval = setInterval(() => {
      // Skip during image processing to avoid slowdowns
      if (isImageProcessingMode) return;

      // Check if global cache has updates
      const cache = window.workflowCache?.allWorkflows;
      if (!cache) return;

      // Since allWorkflows may be a reference to the cache, or may have been
      // initialized separately, we need to handle both cases
      if (allWorkflows !== cache) {
        // Different objects - sync them
        Object.assign(allWorkflows, cache);
      }

      // Sync totalWorkflows from cache if available and valid (greater than 0)
      if (window.workflowCache) {
        if (
          window.workflowCache.totalWorkflows !== undefined &&
          window.workflowCache.totalWorkflows > 0
        ) {
          totalWorkflows = window.workflowCache.totalWorkflows;
        }
      }

      // Check if anything changed that requires re-render
      const currentState = buildCurrentPageState();

      if (currentState !== lastKnownState) {
        lastKnownState = currentState;
        console.log(
          "[Workflows Page] Detected changes from global handlers, re-rendering...",
        );
        renderWorkflows();
        if (currentWorkflowView) {
          renderPosts(currentWorkflowView);
        }
      }
    }, 1000); // Check every 1 second for responsive updates during workflow execution

    // Store the interval ID for cleanup when leaving the page
    window.workflowsPageRefreshInterval = workflowsPageRefreshInterval;

    // Listen for immediate cache update events from app.js for instant UI refresh
    const handleCacheUpdate = (e) => {
      const { workflowId, status, progress } = e.detail || {};
      console.log(`[Workflows Page] Received cache update for workflow ${workflowId}: status=${status}, progress=${progress}`);
      
      // Sync with global cache
      const cache = window.workflowCache?.allWorkflows;
      if (cache) {
        // Update our local reference if different
        if (allWorkflows !== cache) {
          Object.assign(allWorkflows, cache);
        }
        
        // Also directly update the specific workflow in local allWorkflows
        if (workflowId && allWorkflows[workflowId]) {
          console.log(`[Workflows Page] Directly updating workflow ${workflowId} status to ${status}`);
          allWorkflows[workflowId].status = status;
          allWorkflows[workflowId].progress = progress;
          // Freeze run-time timer for terminal statuses
          if (status === 'completed' || status === 'failed' || status === 'stopped') {
            allWorkflows[workflowId].updatedAt = new Date().toISOString();
          }
        }
        
        // CRITICAL: Also update allWorkflowsSummary to prevent stale data causing re-render loops
        if (workflowId) {
          const summaryWf = allWorkflowsSummary.find(w => w.workflowId === workflowId || w.id === workflowId);
          if (summaryWf) {
            console.log(`[Workflows Page] Also updating allWorkflowsSummary for ${workflowId}`);
            summaryWf.status = status;
            summaryWf.progress = progress;
            // Freeze run-time timer for terminal statuses
            if (status === 'completed' || status === 'failed' || status === 'stopped') {
              summaryWf.updatedAt = allWorkflows[workflowId]?.updatedAt || new Date().toISOString();
            }
          }
        }
      }
      
      // Update lastKnownState to prevent immediate re-trigger from polling
      lastKnownState = buildCurrentPageState();
      lastWorkflowsHash = null; // Clear the hash to force re-render
      renderWorkflows.forceImmediate();
      if (currentWorkflowView) {
        renderPosts.forceImmediate(currentWorkflowView);
      }
    };
    document.addEventListener('workflow-cache-updated', handleCacheUpdate);
    
    // Listen for immediate post completion events from app.js for instant posts table refresh
    const handlePostCompleted = (e) => {
      const { workflowId, postId, status } = e.detail || {};
      console.log(`[Workflows Page] Post completed: workflow ${workflowId}, post ${postId}, status ${status}`);
      
      // If we're currently viewing this workflow's posts, immediately re-render
      if (currentWorkflowView === workflowId) {
        renderPosts.forceImmediate(workflowId);
      }
      
      // Also update the workflows table to reflect new completion count
      lastWorkflowsHash = null;
      renderWorkflows.forceImmediate();
    };
    document.addEventListener('post-completed', handlePostCompleted);
    
    // Listen for post progress events (node completion updates) for real-time progress bars
    // Use throttled render since these events come frequently
    let lastProgressRender = 0;
    const PROGRESS_RENDER_THROTTLE = 200; // Update progress every 200ms max
    const handlePostProgress = (e) => {
      const { workflowId, postId, progress } = e.detail || {};
      
      // Only re-render if we're viewing this workflow's posts and throttle is satisfied
      if (currentWorkflowView === workflowId) {
        const now = Date.now();
        if (now - lastProgressRender >= PROGRESS_RENDER_THROTTLE) {
          lastProgressRender = now;
          renderPosts(workflowId);
        }
      }
    };
    document.addEventListener('post-progress', handlePostProgress);
    
    // Clean up event listener when leaving the page
    $(document).on('page-unload' + WF_NAMESPACE, () => {
      document.removeEventListener('workflow-cache-updated', handleCacheUpdate);
      document.removeEventListener('post-completed', handlePostCompleted);
      document.removeEventListener('post-progress', handlePostProgress);
      // Clean up global force render function
      delete window.forceWorkflowsRender;
      delete window.forcePostsRender;
      delete window._restartPolicyCheck;
    });

    // NOTE: Event listeners for workflow events are now handled globally in app.js
    // The polling mechanism above syncs UI with the global cache
    // This prevents duplicate listeners when navigating to/from the workflows page

    // Professional Image Processing Options Modal
    window.showImageProcessingOptionsModal = function () {
      return new Promise((resolve) => {
        const modal = document.createElement("div");
        modal.className = "workflow-skip-modal";

        modal.innerHTML = `
                    <div class="modal-content">
                        <div class="modal-header">
                            <h4><i class="material-icons">palette</i> Image Processing Options</h4>
                        </div>
                        <div class="modal-body">
                            <p style="margin-bottom: 20px; opacity: 0.9;">Configure how your images will be processed before automation:</p>

                            <div style="margin-bottom: 20px;">
                                <label style="display: flex; align-items: center; cursor: pointer; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; transition: all 0.3s;">
                                    <input type="checkbox" id="enable-cropping" checked style="margin-right: 12px; transform: scale(1.2);">
                                    <div>
                                        <strong><i class="material-icons" style="font-size:16px;vertical-align:middle">crop</i> Image Cropping</strong>
                                        <div style="font-size: 0.9rem; opacity: 0.8; margin-top: 4px;">
                                            Manually crop and adjust images before processing
                                        </div>
                                    </div>
                                </label>
                            </div>

                            <div style="margin-bottom: 20px;">
                                <label style="display: flex; align-items: center; cursor: pointer; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; transition: all 0.3s;">
                                    <input type="checkbox" id="enable-inpainting" checked style="margin-right: 12px; transform: scale(1.2);">
                                    <div>
                                        <strong><i class="material-icons" style="font-size:16px;vertical-align:middle">brush</i> Image Inpainting</strong>
                                        <div style="font-size: 0.9rem; opacity: 0.8; margin-top: 4px;">
                                            Remove or replace unwanted elements from images using AI
                                        </div>
                                    </div>
                                </label>
                            </div>

                            <div class="btn-container" style="margin-top: 24px;">
                                <button class="btn btn-primary" id="processing-continue">
                                    <i class="material-icons" style="font-size:16px;vertical-align:middle">rocket_launch</i> Start Processing
                                </button>
                                <button class="btn btn-secondary" id="processing-skip-all">
                                    <i class="material-icons" style="font-size:16px;vertical-align:middle">skip_next</i> Skip All Processing
                                </button>
                            </div>
                        </div>
                    </div>
                `;

        // Add hover effects with CSS
        const style = document.createElement("style");
        style.textContent = `
                    .workflow-skip-modal label:hover {
                        border-color: #007bff !important;
                        background-color: #f8f9fa !important;
                    }
                    .workflow-skip-modal input:checked + div {
                        color: #007bff;
                    }
                `;
        document.head.appendChild(style);

        document.body.appendChild(modal);

        const cleanup = () => {
          if (modal.parentNode) {
            modal.style.animation = "slideOutToTop 0.3s ease-in-out";
            setTimeout(() => {
              if (modal.parentNode) {
                document.body.removeChild(modal);
              }
              if (style.parentNode) {
                document.head.removeChild(style);
              }
            }, 300);
          }
        };

        modal
          .querySelector("#processing-continue")
          .addEventListener("click", () => {
            const cropEnabled = modal.querySelector("#enable-cropping").checked;
            const inpaintEnabled =
              modal.querySelector("#enable-inpainting").checked;
            cleanup();
            resolve({ crop: cropEnabled, inpaint: inpaintEnabled });
          });

        modal
          .querySelector("#processing-skip-all")
          .addEventListener("click", () => {
            cleanup();
            resolve({ crop: false, inpaint: false });
          });

        // Close on backdrop click - return null to signal cancellation
        modal.addEventListener("click", (e) => {
          if (e.target === modal) {
            cleanup();
            resolve(null);
          }
        });
      });
    };

    // Beautiful Skip Image Choosing Modal
    window.showWorkflowSkipModal = function () {
      return new Promise((resolve) => {
        const modal = document.createElement("div");
        modal.className = "workflow-skip-modal";

        modal.innerHTML = `
                    <div class="modal-content">
                        <div class="modal-header">
                            <h4><i class="material-icons">palette</i> Workflow Image Settings</h4>
                        </div>
                        <div class="modal-body">
                            <p>Would you like to skip image selection for this entire workflow?</p>
                            <p style="opacity: 0.8; font-size: 0.95rem;">
                                <i class="material-icons" style="font-size:14px;vertical-align:middle;color:#4caf50">check_circle</i> <strong>Yes:</strong> All images will be automatically selected<br>
                                <i class="material-icons" style="font-size:14px;vertical-align:middle;color:#f44336">cancel</i> <strong>No:</strong> You'll choose images for each post individually
                            </p>
                            <div class="btn-container">
                                <button class="btn btn-primary" id="skip-yes">
                                    <i class="material-icons" style="font-size:16px;vertical-align:middle">rocket_launch</i> Skip Image Choosing
                                </button>
                                <button class="btn btn-secondary" id="skip-no">
                                    <i class="material-icons" style="font-size:16px;vertical-align:middle">ads_click</i> Manual Selection
                                </button>
                            </div>
                        </div>
                    </div>
                `;

        document.body.appendChild(modal);

        const cleanup = () => {
          if (modal.parentNode) {
            modal.style.animation = "slideOutToTop 0.3s ease-in-out";
            setTimeout(() => {
              if (modal.parentNode) {
                document.body.removeChild(modal);
              }
            }, 300);
          }
        };

        modal.querySelector("#skip-yes").addEventListener("click", () => {
          cleanup();
          resolve(true);
        });

        modal.querySelector("#skip-no").addEventListener("click", () => {
          cleanup();
          resolve(false);
        });

        // Close on backdrop click - return null to signal cancellation
        modal.addEventListener("click", (e) => {
          if (e.target === modal) {
            cleanup();
            resolve(null);
          }
        });
      });
    };

    // Rerun Automation Selection Modal
    // Shows when user clicks "Rerun" - allows switching to a different automation
    window.showRerunAutomationModal = async function (currentAutomationId, currentAutomationName, failedCount, completedCount) {
      // Load active automations
      const automations = await window.electronAPI.readKey("automations") || {};
      const activeAutomations = Object.entries(automations)
        .filter(([_, v]) => v.status === "active")
        .map(([_, v]) => ({ id: v.id, label: v.label }));

      // i18n helper
      const t = (key, vars = {}) => {
        let text = window.I18n?.t(`workflows.rerun_modal.${key}`) || key;
        if (text === `workflows.rerun_modal.${key}`) {
          // Fallback for missing translations
          const fallbacks = {
            title: "Rerun Posts",
            subtitle: `Choose which automation to use for rerunning ${vars.count || 0} failed/pending post(s)`,
            subtitle_completed: `This workflow has no failed posts. Choose which automation to use, then enable the option below to rerun ${vars.count || 0} completed post(s)`,
            keep_current: "Keep Current Automation",
            switch_automation: "Switch to Different Automation",
            select_automation: "Select automation...",
            current_automation: `Current: ${vars.name || "Unknown"}`,
            no_automations: "No active automations available",
            rerun_btn: "Rerun Posts",
            cancel_btn: "Cancel",
            completed_kept: `${vars.count || 0} completed post(s) will be kept as-is.`,
            create_new_workflow: "Create a new workflow for rerun posts",
            create_new_workflow_hint: "Failed posts will be copied to a new workflow instead of rerunning in the original",
            include_completed: "Also rerun completed posts",
            include_completed_hint: `Completed post(s) will be reset and run again`
          };
          text = fallbacks[key] || key;
        }
        // Replace {{var}} placeholders
        Object.entries(vars).forEach(([k, v]) => {
          text = text.replace(new RegExp(`{{${k}}}`, 'g'), v);
        });
        return text;
      };

      return new Promise((resolve) => {
        const modal = document.createElement("div");
        modal.className = "rerun-automation-modal";

        // Build automation options HTML
        const otherAutomations = activeAutomations.filter(a => a.id !== currentAutomationId);
        const automationOptionsHtml = otherAutomations.length > 0
          ? otherAutomations.map(a => `<option value="${a.id}">${escapeHtml(a.label)}</option>`).join("")
          : `<option value="" disabled>${t("no_automations")}</option>`;

        modal.innerHTML = `
          <div class="rerun-modal-overlay"></div>
          <div class="rerun-modal-content">
            <div class="rerun-modal-header">
              <div class="rerun-modal-icon">
                <i class="material-icons">replay</i>
              </div>
              <div class="rerun-modal-title">
                <h3>${t("title")}</h3>
                <p>${failedCount > 0 ? t("subtitle", { count: failedCount }) : t("subtitle_completed", { count: completedCount })}</p>
                ${completedCount > 0 && failedCount > 0 ? `<p class="text-muted small">${t("completed_kept", { count: completedCount })}</p>` : ""}
              </div>
            </div>
            <div class="rerun-modal-body">
              <div class="rerun-option ${otherAutomations.length === 0 ? 'only-option' : ''}" data-option="keep">
                <input type="radio" name="rerun-automation" id="rerun-keep" value="keep" checked>
                <label for="rerun-keep">
                  <div class="option-icon"><i class="material-icons">check_circle</i></div>
                  <div class="option-text">
                    <strong>${t("keep_current")}</strong>
                    <span class="current-automation-name">${t("current_automation", { name: currentAutomationName })}</span>
                  </div>
                </label>
              </div>
              ${otherAutomations.length > 0 ? `
              <div class="rerun-option" data-option="switch">
                <input type="radio" name="rerun-automation" id="rerun-switch" value="switch">
                <label for="rerun-switch">
                  <div class="option-icon"><i class="material-icons">swap_horiz</i></div>
                  <div class="option-text">
                    <strong>${t("switch_automation")}</strong>
                    <select id="rerun-automation-select" class="form-select mt-2" disabled>
                      <option value="">${t("select_automation")}</option>
                      ${automationOptionsHtml}
                    </select>
                  </div>
                </label>
              </div>
              ` : ""}
            </div>
            <div class="rerun-new-workflow-option">
              <label class="rerun-checkbox-label">
                <input type="checkbox" id="rerun-create-new-workflow">
                <span class="rerun-checkbox-text">
                  <strong>${t("create_new_workflow")}</strong>
                  <small>${t("create_new_workflow_hint")}</small>
                </span>
              </label>
            </div>
            ${completedCount > 0 ? `
            <div class="rerun-new-workflow-option">
              <label class="rerun-checkbox-label">
                <input type="checkbox" id="rerun-include-completed">
                <span class="rerun-checkbox-text">
                  <strong>${t("include_completed")}</strong>
                  <small>${t("include_completed_hint", { count: completedCount })}</small>
                </span>
              </label>
            </div>
            ` : ""}
            <div class="rerun-modal-footer">
              <button class="btn btn-secondary" id="rerun-cancel">
                ${t("cancel_btn")}
              </button>
              <button class="btn btn-primary" id="rerun-confirm">
                <i class="material-icons me-1">replay</i>
                ${t("rerun_btn")}
              </button>
            </div>
          </div>
        `;

        // Add styles if not already present
        if (!document.getElementById("rerun-automation-modal-styles")) {
          const styles = document.createElement("style");
          styles.id = "rerun-automation-modal-styles";
          styles.textContent = `
            .rerun-automation-modal {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              z-index: 10000;
              display: flex;
              align-items: center;
              justify-content: center;
              animation: rerunModalFadeIn 0.2s ease-out;
            }
            @keyframes rerunModalFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            .rerun-modal-overlay {
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: rgba(0, 0, 0, 0.6);
              backdrop-filter: blur(4px);
            }
            .rerun-modal-content {
              position: relative;
              background: var(--vc-bg-elevated);
              border: 1px solid var(--vc-border-color);
              border-radius: 16px;
              width: 90%;
              max-width: 480px;
              box-shadow: var(--vc-shadow-modal, 0 20px 60px rgba(0, 0, 0, 0.4));
              animation: rerunModalSlideIn 0.3s ease-out;
              overflow: hidden;
            }
            @keyframes rerunModalSlideIn {
              from { transform: translateY(-20px) scale(0.95); opacity: 0; }
              to { transform: translateY(0) scale(1); opacity: 1; }
            }
            .rerun-modal-header {
              display: flex;
              align-items: flex-start;
              gap: 16px;
              padding: 24px 24px 16px;
              border-bottom: 1px solid var(--vc-border-color);
            }
            .rerun-modal-icon {
              width: 48px;
              height: 48px;
              border-radius: 12px;
              background: linear-gradient(135deg, #6366f1, #8b5cf6);
              display: flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
            }
            .rerun-modal-icon i {
              font-size: 24px;
              color: white;
            }
            .rerun-modal-title h3 {
              margin: 0 0 4px;
              font-size: 1.25rem;
              font-weight: 600;
              color: var(--vc-text-primary);
            }
            .rerun-modal-title p {
              margin: 0;
              font-size: 0.9rem;
              color: var(--vc-text-secondary);
            }
            .rerun-modal-body {
              padding: 20px 24px;
              display: flex;
              flex-direction: column;
              gap: 12px;
            }
            .rerun-option {
              border: 2px solid var(--vc-border-color);
              border-radius: 12px;
              padding: 16px;
              cursor: pointer;
              transition: all 0.2s ease;
            }
            .rerun-option:hover {
              border-color: rgba(99, 102, 241, 0.4);
              background: var(--vc-brand-secondary-bg);
            }
            .rerun-option:has(input:checked) {
              border-color: var(--vc-brand-secondary, #6366f1);
              background: var(--vc-brand-secondary-bg);
            }
            .rerun-option.only-option {
              border-color: var(--vc-brand-secondary, #6366f1);
              background: var(--vc-brand-secondary-bg);
            }
            .rerun-option input[type="radio"] {
              display: none;
            }
            .rerun-option label {
              display: flex;
              align-items: flex-start;
              gap: 12px;
              cursor: pointer;
              margin: 0;
            }
            .rerun-option .option-icon {
              width: 40px;
              height: 40px;
              border-radius: 10px;
              background: var(--vc-bg-hover);
              display: flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
            }
            .rerun-option:has(input:checked) .option-icon {
              background: linear-gradient(135deg, #6366f1, #8b5cf6);
            }
            .rerun-option:has(input:checked) .option-icon i {
              color: #fff;
            }
            .rerun-option .option-icon i {
              font-size: 20px;
              color: var(--vc-text-primary);
            }
            .rerun-option .option-text {
              flex: 1;
            }
            .rerun-option .option-text strong {
              display: block;
              color: var(--vc-text-primary);
              font-size: 0.95rem;
              margin-bottom: 4px;
            }
            .rerun-option .current-automation-name {
              display: block;
              font-size: 0.85rem;
              color: var(--vc-text-secondary);
            }
            .rerun-option .form-select {
              background: var(--vc-bg-secondary);
              border: 1px solid var(--vc-border-color);
              color: var(--vc-text-primary);
              border-radius: 8px;
              padding: 8px 12px;
              font-size: 0.9rem;
            }
            .rerun-option .form-select:disabled {
              opacity: 0.5;
              cursor: not-allowed;
            }
            .rerun-option .form-select:not(:disabled) {
              opacity: 1;
            }
            .rerun-modal-footer {
              display: flex;
              justify-content: flex-end;
              gap: 12px;
              padding: 16px 24px 24px;
              border-top: 1px solid var(--vc-border-color);
            }
            .rerun-modal-footer .btn {
              padding: 10px 20px;
              border-radius: 8px;
              font-weight: 500;
              display: flex;
              align-items: center;
              gap: 6px;
            }
            .rerun-modal-footer .btn-secondary {
              background: var(--vc-bg-secondary);
              border: 1px solid var(--vc-border-color);
              color: var(--vc-text-primary);
            }
            .rerun-modal-footer .btn-secondary:hover {
              background: var(--vc-bg-tertiary);
            }
            .rerun-modal-footer .btn-primary {
              background: linear-gradient(135deg, #6366f1, #8b5cf6);
              border: none;
              color: #fff;
            }
            .rerun-modal-footer .btn-primary:hover {
              background: linear-gradient(135deg, #5558e3, #7c4ee8);
            }
            .rerun-new-workflow-option {
              padding: 0 24px 4px;
            }
            .rerun-checkbox-label {
              display: flex;
              align-items: flex-start;
              gap: 10px;
              cursor: pointer;
              padding: 12px 16px;
              border: 1px solid var(--vc-border-color);
              border-radius: 10px;
              transition: all 0.2s ease;
            }
            .rerun-checkbox-label:hover {
              border-color: rgba(99, 102, 241, 0.4);
              background: var(--vc-brand-secondary-bg);
            }
            .rerun-checkbox-label input[type="checkbox"] {
              margin-top: 3px;
              accent-color: #6366f1;
              width: 16px;
              height: 16px;
              flex-shrink: 0;
            }
            .rerun-checkbox-text {
              display: flex;
              flex-direction: column;
              gap: 2px;
            }
            .rerun-checkbox-text strong {
              font-size: 0.9rem;
              color: var(--vc-text-primary);
            }
            .rerun-checkbox-text small {
              font-size: 0.8rem;
              color: var(--vc-text-secondary);
            }
          `;
          document.head.appendChild(styles);
        }

        document.body.appendChild(modal);

        // Event handlers
        const cleanup = () => {
          modal.style.animation = "rerunModalFadeIn 0.2s ease-out reverse";
          setTimeout(() => {
            if (modal.parentNode) {
              document.body.removeChild(modal);
            }
          }, 200);
        };

        // Radio button change handler
        const keepRadio = modal.querySelector("#rerun-keep");
        const switchRadio = modal.querySelector("#rerun-switch");
        const automationSelect = modal.querySelector("#rerun-automation-select");

        if (switchRadio && automationSelect) {
          switchRadio.addEventListener("change", () => {
            automationSelect.disabled = false;
            if (!automationSelect.value) {
              automationSelect.selectedIndex = 1; // Select first automation
            }
          });
          keepRadio.addEventListener("change", () => {
            automationSelect.disabled = true;
          });
        }

        // Option click handler (for the whole option box)
        modal.querySelectorAll(".rerun-option").forEach(opt => {
          opt.addEventListener("click", (e) => {
            if (e.target.tagName === "SELECT" || e.target.tagName === "OPTION") return;
            const radio = opt.querySelector('input[type="radio"]');
            if (radio) {
              radio.checked = true;
              radio.dispatchEvent(new Event("change"));
            }
          });
        });

        // Cancel button
        modal.querySelector("#rerun-cancel").addEventListener("click", () => {
          cleanup();
          resolve({ proceed: false, newAutomationId: null, createNewWorkflow: false, includeCompleted: false });
        });

        // Confirm button
        modal.querySelector("#rerun-confirm").addEventListener("click", () => {
          const selectedOption = modal.querySelector('input[name="rerun-automation"]:checked')?.value;
          let newAutomationId = null;

          if (selectedOption === "switch" && automationSelect && automationSelect.value) {
            newAutomationId = automationSelect.value;
          }

          const createNewWorkflow = modal.querySelector("#rerun-create-new-workflow")?.checked || false;
          const includeCompleted = modal.querySelector("#rerun-include-completed")?.checked || false;

          cleanup();
          resolve({ proceed: true, newAutomationId, createNewWorkflow, includeCompleted });
        });

        // Click outside to close
        modal.querySelector(".rerun-modal-overlay").addEventListener("click", () => {
          cleanup();
          resolve({ proceed: false, newAutomationId: null, createNewWorkflow: false, includeCompleted: false });
        });

        // Escape key
        const handleEscape = (e) => {
          if (e.key === "Escape") {
            cleanup();
            resolve({ proceed: false, newAutomationId: null, createNewWorkflow: false, includeCompleted: false });
            document.removeEventListener("keydown", handleEscape);
          }
        };
        document.addEventListener("keydown", handleEscape);
      });
    };

    // Proxy checking modal helpers
    function showProxyCheckingModal() {
      const modal = document.createElement("div");
      modal.className = "proxy-checking-modal";
      modal.id = "proxyCheckingModal";
      modal.innerHTML = `
                <div class="proxy-checking-content">
                    <h4><i class="fas fa-shield-alt me-2"></i>Checking Proxy IP</h4>
                    <div class="proxy-progress-bar">
                        <div class="proxy-progress-fill" style="width: 0%"></div>
                    </div>
                    <p class="proxy-status">Starting proxy check...</p>
                    <div class="proxy-attempts-log"></div>
                </div>
            `;
      document.body.appendChild(modal);
    }

    function updateProxyCheckingModal(data) {
      const modal = document.getElementById("proxyCheckingModal");
      if (!modal) return;

      const progressFill = modal.querySelector(".proxy-progress-fill");
      const status = modal.querySelector(".proxy-status");
      const attemptsLog = modal.querySelector(".proxy-attempts-log");

      const percentage = (data.attempt / data.maxAttempts) * 100;
      progressFill.style.width = `${percentage}%`;

      // Update status text based on result
      let statusText;
      if (data.error) {
        statusText = `Attempt ${data.attempt}/${data.maxAttempts}: Connection error`;
      } else if (data.clean) {
        statusText = `Attempt ${data.attempt}/${data.maxAttempts}: Clean IP found!`;
      } else {
        statusText = `Attempt ${data.attempt}/${data.maxAttempts}: IP flagged, rotating...`;
      }
      status.textContent = statusText;

      // Add log entry
      const logEntry = document.createElement("div");
      const entryClass = data.error ? "error" : (data.clean ? "clean" : "flagged");
      logEntry.className = `proxy-log-entry ${entryClass}`;

      // IPRegistry returns location.country and location.region as objects with .name property
      const location = data.location
        ? `${data.location.city || ""}, ${data.location.region?.name || ""}, ${data.location.country?.name || ""}`.replace(
            /^, |, $/g,
            "",
          ).replace(/, ,/g, ",")
        : "";

      // Build status icon/text based on result
      let statusIcon;
      if (data.error) {
        statusIcon = `<i class="fas fa-exclamation-circle text-danger"></i> ${data.error}`;
      } else if (data.clean) {
        statusIcon = '<i class="fas fa-check text-success"></i>';
      } else {
        const flagsStr = data.flaggedReasons && data.flaggedReasons.length > 0 
          ? data.flaggedReasons.join(', ') 
          : 'Flagged';
        statusIcon = `<i class="fas fa-times text-danger"></i> ${flagsStr}`;
      }

      logEntry.innerHTML = `
                <span class="attempt-num">#${data.attempt}</span>
                <span class="attempt-ip">${data.ip || "N/A"}</span>
                ${location ? `<span class="attempt-location">${location}</span>` : ''}
                <span class="attempt-status">${statusIcon}</span>
            `;
      attemptsLog.appendChild(logEntry);
      attemptsLog.scrollTop = attemptsLog.scrollHeight;
    }

    function closeProxyCheckingModal() {
      const modal = document.getElementById("proxyCheckingModal");
      if (modal) modal.remove();
    }

    function showDirtyProxyConfirmModal(result) {
      return new Promise((resolve) => {
        const flagsHtml =
          result.flaggedReasons && result.flaggedReasons.length > 0
            ? result.flaggedReasons
                .map((f) => `<span class="flag-badge">${f}</span>`)
                .join("")
            : '<span class="flag-badge">unknown</span>';

        const modal = document.createElement("div");
        modal.className = "dirty-proxy-modal";
        modal.innerHTML = `
                    <div class="dirty-proxy-content">
                        <h4><i class="fas fa-exclamation-triangle text-warning me-2"></i>Proxy IP Flagged</h4>
                        <p>After ${result.attempts || "multiple"} attempts, no clean IP was found.</p>
                        <div class="last-ip-info">
                            <p><strong>Last IP:</strong> ${result.finalIp || "N/A"}</p>
                            <p><strong>Flags:</strong></p>
                            <div class="flags-list">
                                ${flagsHtml}
                            </div>
                        </div>
                        <p class="mt-3">Do you still want to open this profile?</p>
                        <div class="dirty-proxy-buttons">
                            <button class="btn btn-secondary" id="dirtyProxyCancel">Cancel</button>
                            <button class="btn btn-warning" id="dirtyProxyProceed">Open Anyway</button>
                        </div>
                    </div>
                `;
        document.body.appendChild(modal);

        modal
          .querySelector("#dirtyProxyCancel")
          .addEventListener("click", () => {
            modal.remove();
            resolve(false);
          });

        modal
          .querySelector("#dirtyProxyProceed")
          .addEventListener("click", () => {
            modal.remove();
            resolve(true);
          });
      });
    }

    async function openWorkflowProfile(workflowId) {
      try {
        let workflow = allWorkflows[workflowId];
        if (!workflow) {
          showAlert("error", "Workflow not found");
          return;
        }

        // Load full workflow details including posts from database
        // This is necessary when posts array is empty (summary view)
        if (!workflow.posts || workflow.posts.length === 0) {
          console.log(`Loading full workflow details for ${workflowId}...`);
          const fullWorkflow = await loadWorkflowDetail(workflowId);
          if (fullWorkflow) {
            workflow = fullWorkflow;
            allWorkflows[workflowId] = fullWorkflow;
          }
        }

        // Find the first Pinterest post to get account information
        const pinterestPost = (workflow.posts || []).find(
          (post) => post.pinterestAccountId && post.pinterestBoardId,
        );

        if (!pinterestPost) {
          showAlert(
            "error",
            "No Pinterest account information found in this workflow",
          );
          return;
        }

        // Load Pinterest accounts to get linked profile info
        const pinterestAccounts =
          (await window.electronAPI.readKey("pinterestAccounts")) || {};
        const account = pinterestAccounts[pinterestPost.pinterestAccountId];

        if (!account) {
          showAlert("error", "Pinterest account no longer exists");
          return;
        }

        if (!account.linkedStructureId || !account.linkedProfileId) {
          showAlert(
            "error",
            "This Pinterest account doesn't have a linked structure profile",
          );
          return;
        }

        // Load structures to get profile info
        const structures =
          (await window.electronAPI.readKey("structures")) || {};
        const structure = structures[account.linkedStructureId];

        if (
          !structure ||
          !structure.profiles ||
          !structure.profiles[account.linkedProfileId]
        ) {
          showAlert("error", "Linked structure profile no longer exists");
          return;
        }

        const profile = structure.profiles[account.linkedProfileId];
        const confirmed = await confirmPrompt(
          `Open "${profile.label}" profile from "${structure.label}" structure? This profile is linked to Pinterest account: ${account.email}`,
        );
        if (!confirmed) return;

        const proxy = profile.proxy;

        // Check if proxy needs clean IP verification
        if (proxy && proxy.ip && proxy.ip !== "NULL") {
          const ipregistrySettings =
            await window.electronAPI.readKey("ipregistrySettings");

          if (ipregistrySettings?.enabled && ipregistrySettings?.apiKey) {
            // Show proxy checking modal
            showProxyCheckingModal();

            // Set up progress listener
            const progressHandler = (data) => {
              updateProxyCheckingModal(data);
            };
            window.electronAPI.onProxyCheckProgress(progressHandler);

            try {
              const result = await window.electronAPI.findCleanProxy(proxy, 20);

              closeProxyCheckingModal();
              window.electronAPI.removeProxyCheckProgressListener(
                progressHandler,
              );

              if (result.skipped) {
                // IPRegistry not configured, proceed directly
                closeProxyCheckingModal();
                await window.electronAPI.startStructureProfile(
                  account.linkedProfileId,
                  "https://www.pinterest.com/settings/bulk-create-pins",
                  proxy,
                );
                showAlert("success", "Pinterest profile opened successfully!");
                return;
              }

              if (result.success) {
                // Found clean proxy
                showAlert(
                  "success",
                  `Clean proxy found! IP: ${result.finalIp}`,
                );
                await window.electronAPI.startStructureProfile(
                  account.linkedProfileId,
                  "https://www.pinterest.com/settings/bulk-create-pins",
                  result.proxyData,
                );
              } else {
                // Check for 551 geo-targeting error
                if (result.error && result.error.includes("551")) {
                  showAlert(
                    "error",
                    "Geo-targeting error (551): The proxy geo settings (country/region/city) are not available. Please remove or change the geo parameters in your proxy configuration.",
                  );
                  return;
                }

                // No clean proxy found - show confirmation modal
                const proceed = await showDirtyProxyConfirmModal(result);
                if (proceed) {
                  await window.electronAPI.startStructureProfile(
                    account.linkedProfileId,
                    "https://www.pinterest.com/settings/bulk-create-pins",
                    result.proxyData,
                  );
                  showAlert(
                    "warning",
                    "Pinterest profile opened with flagged IP",
                  );
                }
              }
            } catch (proxyError) {
              closeProxyCheckingModal();
              window.electronAPI.removeProxyCheckProgressListener(
                progressHandler,
              );
              console.error("Proxy check error:", proxyError);
              showAlert("error", `Proxy check error: ${proxyError.message}`);
            }
            return;
          }
        }

        // Use Pinterest URL for the profile launch (no proxy check needed)
        await window.electronAPI.startStructureProfile(
          account.linkedProfileId,
          "https://www.pinterest.com/settings/bulk-create-pins",
          proxy,
        );
        showAlert("success", "Pinterest profile opened successfully!");
      } catch (error) {
        console.error("Failed to open workflow profile:", error);
        showAlert("error", "Failed to open Pinterest profile");
      }
    }

    /**
     * Auto Publish: generates CSV from workflow posts, then uploads it
     * to Pinterest via VCBrowser headless (same CSV format as manual export).
     */
    /**
     * Collect all Pinterest-eligible workflows from the loaded data.
     * Returns array of { workflowId, name, pinCount, accountEmail, exported, accountId }
     */
    async function collectPinterestWorkflows() {
      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const result = [];

      for (const summary of allWorkflowsSummary) {
        const wfId = summary.workflowId;
        const wf = allWorkflows[wfId] || summary;

        const isPinterest =
          wf.hasPinterestPosts ||
          (wf.posts &&
            wf.posts.some(
              (p) =>
                p.pinterestOutput != null ||
                (p.pinterestAccountId && p.pinterestBoardId),
            ));
        if (!isPinterest) continue;

        // Try to get post count from cached posts or summary
        let pinCount = 0;
        let accountId = null;
        let accountEmail = "";

        if (wf.posts && wf.posts.length > 0) {
          const pPosts = wf.posts.filter((p) => p.pinterestOutput);
          pinCount = pPosts.length;
          const firstWithAccount = pPosts.find((p) => p.pinterestAccountId);
          if (firstWithAccount) {
            accountId = firstWithAccount.pinterestAccountId;
            const acct = pinterestAccounts[accountId];
            accountEmail = acct?.email || accountId;
          }
        } else {
          pinCount = wf.totalPosts || wf.completedPosts || 0;
          // Use the account ID from the summary query (workflow_pinterest_account_id)
          if (wf.workflowPinterestAccountId) {
            accountId = wf.workflowPinterestAccountId;
            const acct = pinterestAccounts[accountId];
            accountEmail = acct?.email || accountId;
          }
        }

        result.push({
          workflowId: wfId,
          name: wf.name || `Workflow #${wfId}`,
          pinCount,
          accountEmail,
          accountId,
          exported: !!wf.exported,
        });
      }

      return result;
    }

    /**
     * Show the Auto Publish modal with workflow selection grid.
     * @param {string|null} preSelectedWorkflowId - Pre-select this workflow if provided
     */
    async function showAutoPublishModal(preSelectedWorkflowIds = null) {
      // Remove any existing modal
      document.getElementById("autoPublishModal")?.remove();

      const workflows = await collectPinterestWorkflows();
      if (workflows.length === 0) {
        showAlert("error", window.I18n?.t("workflows.auto_publish_no_pinterest") || "No Pinterest workflows found.");
        return;
      }

      const selectedSet = new Set(
        (Array.isArray(preSelectedWorkflowIds)
          ? preSelectedWorkflowIds
          : preSelectedWorkflowIds
            ? [preSelectedWorkflowIds]
            : []
        ).map((id) => String(id)),
      );

      const t = (key, fb) => window.I18n?.t(key) || fb;

      const workflowItems = workflows.map((wf) => {
        const hasAccount = !!wf.accountId;
        const isSelected = hasAccount && selectedSet.has(String(wf.workflowId));
        const exportBadge = wf.exported
          ? `<span class="ap-wf-badge exported">${t("workflows.ap_exported", "Exported")}</span>`
          : `<span class="ap-wf-badge not-exported">${t("workflows.ap_new", "New")}</span>`;
        const noAccountBadge = !hasAccount
          ? `<span class="ap-wf-badge" style="background:var(--bg-tertiary,#e9ecef);color:var(--text-secondary,#6c757d);" title="No Pinterest account connected to this workflow">No account</span>`
          : "";
        return `
          <label class="ap-workflow-item${isSelected ? " selected" : ""}${!hasAccount ? " disabled" : ""}" data-wf-id="${wf.workflowId}">
            <input type="checkbox" class="ap-wf-check" data-wf-id="${wf.workflowId}"
              data-account-id="${wf.accountId || ""}" ${isSelected ? "checked" : ""} ${!hasAccount ? "disabled" : ""} />
            <div class="ap-wf-info">
              <div class="ap-wf-name">#${wf.workflowId} — ${wf.name}</div>
              <div class="ap-wf-meta">
                <span><i class="material-icons">photo_library</i>${wf.pinCount} pins</span>
                <span><i class="material-icons">person</i>${wf.accountEmail || "—"}</span>
              </div>
            </div>
            ${hasAccount ? exportBadge : noAccountBadge}
          </label>`;
      }).join("");

      const selectedCount = workflows.filter((wf) => selectedSet.has(String(wf.workflowId))).length;

      const modal = document.createElement("div");
      modal.className = "auto-publish-modal";
      modal.id = "autoPublishModal";
      modal.innerHTML = `
        <div class="auto-publish-modal-content">
          <div class="auto-publish-header">
            <h4><i class="material-icons">cloud_upload</i>${t("workflows.ap_title", "Auto Publish to Pinterest")}</h4>
            <button class="ap-close-btn" id="apCloseBtn"><i class="material-icons">close</i></button>
          </div>
          <div class="auto-publish-body" id="apBody">
            <div class="ap-section">
              <div class="ap-section-title">
                <span class="ap-step-badge">1</span>
                ${t("workflows.ap_select_workflows", "Select Workflows")}
                <div class="ap-select-actions">
                  <button id="apSelectAll">${t("workflows.ap_select_all", "Select All")}</button>
                  <button id="apClearAll">${t("workflows.ap_clear", "Clear")}</button>
                </div>
              </div>
              <div class="ap-workflow-grid" id="apWorkflowGrid">
                ${workflowItems}
              </div>
            </div>
            <div class="ap-section">
              <div class="ap-section-title">
                <span class="ap-step-badge">2</span>
                ${t("workflows.ap_schedule", "Schedule Period")}
              </div>
              <select class="ap-schedule-select" id="apScheduleSelect">
                <option value="all">All at once (1 hour from now)</option>
                <option value="12h">12 hours (Half day)</option>
                <option value="24h">24 hours (1 day)</option>
                <option value="48h">48 hours (2 days)</option>
                <option value="72h">72 hours (3 days)</option>
                <option value="168h" selected>168 hours (1 week)</option>
                <option value="336h">336 hours (2 weeks)</option>
                <option value="720h">720 hours (1 month)</option>
              </select>
            </div>
            <div class="ap-section">
              <div class="ap-section-title">
                <span class="ap-step-badge">3</span>
                ${t("workflows.pinterest_csv_batch_size", "Pins per CSV")}
              </div>
              <input class="ap-number-input" id="apCsvBatchSizeInput" type="number" min="1" max="${PINTEREST_CSV_MAX_BATCH_SIZE}" step="1" value="${PINTEREST_CSV_DEFAULT_BATCH_SIZE}" />
            </div>
          </div>
          <div class="auto-publish-footer" id="apFooter">
            <div class="ap-footer-summary" id="apSummary">
              <strong id="apSelectedCount">${selectedCount}</strong> ${t("workflows.ap_workflows_selected", "workflow(s) selected")}
            </div>
            <div class="ap-footer-buttons">
              <button class="ap-btn ap-btn-cancel" id="apCancelBtn">${t("workflows.ap_cancel", "Cancel")}</button>
              <button class="ap-btn ap-btn-start" id="apStartBtn" ${selectedCount > 0 ? "" : "disabled"}>
                <i class="material-icons">cloud_upload</i>
                ${t("workflows.ap_start_publish", "Start Publishing")}
              </button>
            </div>
          </div>
        </div>`;

      document.body.appendChild(modal);

      // ── Wire up events ──

      const closeModal = () => modal.remove();
      modal.querySelector("#apCloseBtn").onclick = closeModal;
      modal.querySelector("#apCancelBtn").onclick = closeModal;
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
      });

      const updateSummary = () => {
        const checked = modal.querySelectorAll(".ap-wf-check:checked");
        modal.querySelector("#apSelectedCount").textContent = checked.length;
        modal.querySelector("#apStartBtn").disabled = checked.length === 0;
      };

      // Checkbox toggle + selected styling
      modal.querySelector("#apWorkflowGrid").addEventListener("change", (e) => {
        if (e.target.classList.contains("ap-wf-check")) {
          const item = e.target.closest(".ap-workflow-item");
          item.classList.toggle("selected", e.target.checked);
          updateSummary();
        }
      });

      modal.querySelector("#apSelectAll").onclick = () => {
        modal.querySelectorAll(".ap-wf-check:not(:disabled)").forEach((cb) => {
          cb.checked = true;
          cb.closest(".ap-workflow-item").classList.add("selected");
        });
        updateSummary();
      };

      modal.querySelector("#apClearAll").onclick = () => {
        modal.querySelectorAll(".ap-wf-check").forEach((cb) => {
          cb.checked = false;
          cb.closest(".ap-workflow-item").classList.remove("selected");
        });
        updateSummary();
      };

      // ── Start Publishing ──
      modal.querySelector("#apStartBtn").onclick = async () => {
        const selectedIds = Array.from(modal.querySelectorAll(".ap-wf-check:checked"))
          .map((cb) => cb.dataset.wfId);
        const schedule = modal.querySelector("#apScheduleSelect").value;
        const csvBatchSize = normalizePinterestCsvBatchSize(
          modal.querySelector("#apCsvBatchSizeInput").value,
        );

        if (selectedIds.length === 0) return;

        // Switch to progress view
        await runAutoPublishBatch(modal, selectedIds, schedule, csvBatchSize);
      };
    }

    /**
     * Run auto-publish for multiple workflows sequentially, showing progress
     * inside the existing modal.
     */
    async function runAutoPublishBatch(modal, workflowIds, schedule, csvBatchSize) {
      const t = (key, fb) => window.I18n?.t(key) || fb;
      const body = modal.querySelector("#apBody");
      const footer = modal.querySelector("#apFooter");

      // Build log entries for each workflow
      const logEntries = workflowIds.map((id) => {
        const wf = allWorkflows[id] || {};
        const name = wf.name || `Workflow #${id}`;
        return { id, name };
      });

      // Replace body with progress view
      body.innerHTML = `
        <div class="ap-progress-section">
          <div class="ap-progress-overall">
            <span id="apProgressLabel">0 / ${workflowIds.length}</span>
            <div class="ap-progress-bar-wrap">
              <div class="ap-progress-bar-fill" id="apProgressFill"></div>
            </div>
          </div>
          <div class="ap-progress-log" id="apProgressLog">
            ${logEntries.map((e) => `
              <div class="ap-log-entry pending" id="apLog-${e.id}">
                <i class="material-icons">schedule</i>
                <div class="ap-log-info">
                  <div class="ap-log-name">#${e.id} — ${e.name}</div>
                  <div class="ap-log-status">${t("workflows.ap_status_waiting", "Waiting...")}</div>
                </div>
                <div class="ap-log-actions"></div>
              </div>
            `).join("")}
          </div>
        </div>`;

      // Replace footer — disable close while running
      footer.innerHTML = `
        <div class="ap-footer-summary" id="apRunSummary">
          ${t("workflows.ap_publishing", "Publishing...")}
        </div>
        <div class="ap-footer-buttons">
          <button class="ap-btn ap-btn-cancel" id="apDoneBtn" disabled>
            ${t("workflows.ap_close", "Close")}
          </button>
        </div>`;
      modal.querySelector("#apDoneBtn").onclick = () => modal.remove();
      modal.querySelector("#apCloseBtn").onclick = null; // disable X during publishing

      const progressFill = modal.querySelector("#apProgressFill");
      const progressLabel = modal.querySelector("#apProgressLabel");
      const progressLog = modal.querySelector("#apProgressLog");
      const summaryEl = modal.querySelector("#apRunSummary");
      const doneBtn = modal.querySelector("#apDoneBtn");

      const pinterestAccounts =
        (await window.electronAPI.readKey("pinterestAccounts")) || {};
      let completed = 0;
      let batchFinished = false;
      const workflowState = {};
      workflowIds.forEach((id) => {
        workflowState[String(id)] = "pending";
      });
      const workflowResumeBatchIndex = {};

      const updateProgress = () => {
        const pct = Math.round((completed / workflowIds.length) * 100);
        progressFill.style.width = pct + "%";
        progressLabel.textContent = `${completed} / ${workflowIds.length}`;
      };

      const updateSummary = () => {
        const values = Object.values(workflowState);
        const succeeded = values.filter((v) => v === "success").length;
        const failed = values.filter((v) => v === "failed").length;
        summaryEl.innerHTML = `
          <strong>${succeeded}</strong> ${t("workflows.ap_succeeded", "succeeded")},
          <strong>${failed}</strong> ${t("workflows.ap_failed_count", "failed")}
          — ${batchFinished ? t("workflows.ap_batch_done", "Batch complete") : t("workflows.ap_publishing", "Publishing...")}`;
      };

      const setLogState = (logEl, stateClass, iconName, statusText, spin = false) => {
        logEl.className = `ap-log-entry ${stateClass}`;
        const icon = logEl.querySelector(".material-icons");
        icon.textContent = iconName;
        icon.classList.toggle("ap-log-icon-spin", spin);
        logEl.querySelector(".ap-log-status").textContent = statusText;
      };

      const clearLogActions = (logEl) => {
        const actionsEl = logEl.querySelector(".ap-log-actions");
        if (actionsEl) actionsEl.innerHTML = "";
      };

      const setRetryAction = (logEl, wfId) => {
        const actionsEl = logEl.querySelector(".ap-log-actions");
        if (!actionsEl) return;
        actionsEl.innerHTML = `<button class="ap-retry-btn" data-wf-id="${wfId}">${t("workflows.ap_retry", "Retry")}</button>`;
      };

      const publishWorkflow = async (wfId, isRetry = false) => {
        const logEl = modal.querySelector(`#apLog-${wfId}`);
        if (!logEl) return false;

        clearLogActions(logEl);
        setLogState(
          logEl,
          "running",
          "sync",
          isRetry
            ? t("workflows.ap_retrying", "Retrying...")
            : t("workflows.ap_status_loading", "Loading workflow data..."),
          true,
        );

        try {
          // Load full workflow
          let wf = allWorkflows[wfId] || {};
          if (!wf.posts || wf.posts.length === 0) {
            const fullWorkflow = await loadWorkflowDetail(wfId);
            if (fullWorkflow) {
              wf = fullWorkflow;
              allWorkflows[wfId] = wf;
            }
          }

          const posts = Array.isArray(wf.posts) ? wf.posts : [];
          const pinterestPosts = posts.filter((p) => p.pinterestOutput);

          if (!pinterestPosts.length) {
            throw new Error("No Pinterest posts found");
          }

          const pinterestPost = pinterestPosts.find((p) => p.pinterestAccountId);
          if (!pinterestPost?.pinterestAccountId) {
            throw new Error("No Pinterest account linked");
          }

          const accountId = pinterestPost.pinterestAccountId;
          setLogState(logEl, "running", "sync", t("workflows.ap_status_csv", "Generating CSV..."), true);

          // Build CSV batches once so retries can resume from the failed batch.
          const scheduledTimes = calculateScheduleTimes(pinterestPosts.length, schedule);
          const { rows } = buildPinterestCsvRows({
            pinterestPosts,
            scheduledTimes,
            pinterestAccounts,
          });
          const csvBatches = splitPinterestCsvRows(rows, csvBatchSize);
          const totalBatches = csvBatches.length;
          const totalPins = rows.length - 1;
          const resumeIndex = isRetry
            ? Math.min(
                workflowResumeBatchIndex[String(wfId)] || 0,
                totalBatches,
              )
            : 0;
          workflowResumeBatchIndex[String(wfId)] = resumeIndex;

          // Listen for proxy check progress — filter by accountId to avoid
          // cross-contamination when multiple concurrent publishes are running.
          // onProxyCheckProgress returns the internal wrapper function; we pass it
          // back to removeProxyCheckProgressListener so only this handler is removed,
          // leaving the other concurrent workflows' handlers intact.
          const proxyStatusEl = logEl.querySelector(".ap-log-status");
          const proxyProgressWrapper = window.electronAPI.onProxyCheckProgress((data) => {
            if (data.accountId && data.accountId !== accountId) return;
            proxyStatusEl.textContent = `Proxy check ${data.attempt}/${data.maxAttempts}: ${data.ip || "..."} — ${data.clean ? "Clean" : data.error || "Flagged"}`;
            logEl.className = "ap-log-entry proxy-check";
            const icon = logEl.querySelector(".material-icons");
            icon.textContent = "shield";
            icon.classList.remove("ap-log-icon-spin");
          });

          // Batch progress — updates the status line as each CSV file is uploaded
          // within the SINGLE shared browser session (same account IP for every batch).
          const batchProgressWrapper = window.electronAPI.onPinterestBatchProgress((data) => {
            if (data.accountId && data.accountId !== accountId) return;
            if (totalBatches > 1) {
              const uploadStatus = tWorkflow(
                "ap_batch_uploading",
                `Uploading batch ${data.index + 1}/${totalBatches}...`,
                { current: data.index + 1, total: totalBatches, count: "" },
              );
              setLogState(logEl, "running", "sync", uploadStatus, true);
            }
          });

          try {
            // Upload ALL CSV batches on ONE session / ONE clean IP. Splitting a CSV into
            // multiple files must NOT open a new browser (and rotate to a new IP) per file —
            // Pinterest flags an account that uploads from several IPs in quick succession.
            const csvStrings = csvBatches
              .slice(resumeIndex)
              .map((batchRows) => pinterestRowsToCsv(batchRows));

            setLogState(
              logEl,
              "running",
              "sync",
              totalBatches > 1
                ? t("workflows.ap_status_uploading", "Uploading to Pinterest...")
                : t("workflows.ap_status_uploading", "Uploading to Pinterest..."),
              true,
            );

            const publishResult = await window.electronAPI.pinterestAutoPublishBatch(
              accountId,
              csvStrings,
            );

            if (!publishResult.success) {
              // Persist how far we got so a retry resumes from the failed batch.
              workflowResumeBatchIndex[String(wfId)] =
                resumeIndex + (publishResult.completedBatches || 0);
              throw new Error(publishResult.value || "Unknown error");
            }

            delete workflowResumeBatchIndex[String(wfId)];
          } finally {
            window.electronAPI.removeProxyCheckProgressListener(proxyProgressWrapper);
            window.electronAPI.removePinterestBatchProgressListener(batchProgressWrapper);
          }

          await trackBoardExportHistory(pinterestPosts, scheduledTimes, wfId);
          await markWorkflowAsExported(wfId);
          delete workflowResumeBatchIndex[String(wfId)];

          setLogState(
            logEl,
            "success",
            "check_circle",
            totalBatches > 1
              ? tWorkflow(
                  "ap_batch_success",
                  `Published ${totalPins} pins in ${totalBatches} CSV batches`,
                  { count: totalPins, csvCount: totalBatches },
                )
              : t("workflows.ap_status_done", "Published successfully"),
            false,
          );
          return true;
        } catch (err) {
          setLogState(logEl, "error", "error", err.message, false);
          setRetryAction(logEl, wfId);
          return false;
        }
      };

      progressLog.addEventListener("click", async (event) => {
        const retryBtn = event.target.closest(".ap-retry-btn");
        if (!retryBtn || !batchFinished) return;

        const wfId = retryBtn.dataset.wfId;
        if (!wfId || workflowState[String(wfId)] !== "failed") return;

        retryBtn.disabled = true;
        retryBtn.textContent = t("workflows.ap_retrying", "Retrying...");

        workflowState[String(wfId)] = "pending";
        updateSummary();

        const ok = await publishWorkflow(wfId, true);
        workflowState[String(wfId)] = ok ? "success" : "failed";
        updateSummary();
      });

      // Process workflows with concurrency of 3
      const CONCURRENCY = 3;
      for (let i = 0; i < workflowIds.length; i += CONCURRENCY) {
        const batch = workflowIds.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (wfId) => {
            const ok = await publishWorkflow(wfId, false);
            workflowState[String(wfId)] = ok ? "success" : "failed";
            completed++;
            updateProgress();
            updateSummary();
          })
        );
      }

      // Finished — unlock close and retries
      batchFinished = true;
      updateSummary();
      doneBtn.disabled = false;
      modal.querySelector("#apCloseBtn").onclick = () => modal.remove();
    }

    // Check for auto-export request from Pinterest accounts page
    const autoExportWorkflowId = sessionStorage.getItem("autoExportWorkflowId");
    if (autoExportWorkflowId) {
      sessionStorage.removeItem("autoExportWorkflowId");

      // Wait a bit for the page to fully load, then trigger export
      setTimeout(() => {
        const workflow = allWorkflows[autoExportWorkflowId];
        if (
          workflow &&
          workflow.posts &&
          workflow.posts.some((p) => p.pinterestOutput)
        ) {
          showAlert(
            "info",
            `Auto-exporting CSV for workflow: ${workflow.name || autoExportWorkflowId}`,
          );

          // Trigger the CSV export modal
          const mockEvent = {
            attr: () => autoExportWorkflowId,
            closest: () => ({ remove: () => {} }),
          };
          $("body")
            .find(
              `[data-role="startCsvMode"][data-id="${autoExportWorkflowId}"]`,
            )
            .first()
            .click();

          if (
            $("body").find(
              `[data-role="startCsvMode"][data-id="${autoExportWorkflowId}"]`,
            ).length === 0
          ) {
            // If button doesn't exist, show the output type modal first
            showAlert(
              "info",
              "Please use the 'Export/Output' button for this workflow to export the CSV.",
            );
          }
        } else {
          showAlert(
            "error",
            "Workflow not found or has no Pinterest posts to export.",
          );
        }
      }, 1000);
    }
  });

  /**
   * Show the Scheduled Pins modal for multiple selected workflows (grouped by account).
   */
  async function showBulkScheduledPinsModal(workflowIds) {
    document.getElementById("scheduledPinsModal")?.remove();

    const pinterestAccounts =
      (await window.electronAPI.readKey("pinterestAccounts")) || {};

    // Resolve account IDs from the selected workflows (deduplicated)
    const accountWorkflowMap = new Map(); // accountId -> { accountLabel, workflowIds[] }

    for (const workflowId of workflowIds) {
      let workflow = allWorkflows[workflowId];
      if (!workflow || !workflow.posts || workflow.posts.length === 0) {
        const fullWorkflow = await loadWorkflowDetail(workflowId);
        if (fullWorkflow) {
          workflow = fullWorkflow;
          allWorkflows[workflowId] = fullWorkflow;
        }
      }
      if (!workflow) continue;

      const pinterestPost =
        (workflow.posts || []).find(
          (p) => p.pinterestAccountId && p.pinterestBoardId,
        ) ||
        (workflow.posts || []).find((p) => p.pinterestOutput != null);

      if (!pinterestPost?.pinterestAccountId) continue;

      const accountId = pinterestPost.pinterestAccountId;
      if (!accountWorkflowMap.has(accountId)) {
        const account = pinterestAccounts[accountId];
        accountWorkflowMap.set(accountId, {
          accountLabel: account?.email || accountId,
          workflowIds: [],
        });
      }
      accountWorkflowMap.get(accountId).workflowIds.push(workflowId);
    }

    if (accountWorkflowMap.size === 0) {
      showAlert(
        "error",
        window.I18n?.t("workflows.sp_no_account") ||
          "No Pinterest account linked to the selected workflows",
      );
      return;
    }

    // Build account tabs HTML
    const accountEntries = Array.from(accountWorkflowMap.entries());
    const firstAccountId = accountEntries[0][0];

    let tabsHtml = '<div class="sp-tabs">';
    for (const [accountId, info] of accountEntries) {
      tabsHtml += `<button class="sp-tab${accountId === firstAccountId ? " sp-tab-active" : ""}" data-account="${accountId}">
        <span class="sp-tab-email">${info.accountLabel}</span>
        <span class="sp-tab-status sp-tab-status--loading" data-tab-status="${accountId}"><span class="material-icons sp-spin" style="font-size:13px">sync</span></span>
      </button>`;
    }
    tabsHtml += "</div>";

    let panelsHtml = "";
    for (const [accountId] of accountEntries) {
      panelsHtml += `<div class="sp-panel" id="sp-panel-${accountId}" style="display:${accountId === firstAccountId ? "block" : "none"}">
        <div class="sp-loading"><span class="material-icons sp-spin">sync</span><p>${window.I18n?.t("workflows.sp_loading") || "Fetching scheduled pins..."}</p></div>
      </div>`;
    }

    const modalHtml = `
      <div class="sp-modal-overlay" id="scheduledPinsModal">
        <div class="sp-modal sp-modal-wide">
          <div class="sp-modal-header">
            <div class="sp-header-left">
              <span class="material-icons sp-header-icon">schedule</span>
              <div>
                <h3 class="sp-title">${window.I18n?.t("workflows.sp_title") || "Scheduled Pins"}</h3>
                <span class="sp-account-label">${accountEntries.length} account(s)</span>
              </div>
            </div>
            <button class="sp-close-btn" id="spCloseBtn">
              <span class="material-icons">close</span>
            </button>
          </div>
          ${accountEntries.length > 1 ? tabsHtml : ""}
          <div class="sp-modal-body" id="spModalBody">
            ${panelsHtml}
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    // Close handlers
    document.getElementById("spCloseBtn").addEventListener("click", () => {
      document.getElementById("scheduledPinsModal")?.remove();
    });
    document.getElementById("scheduledPinsModal").addEventListener("click", (e) => {
      if (e.target.id === "scheduledPinsModal") {
        document.getElementById("scheduledPinsModal")?.remove();
      }
    });

    // Tab switching
    document.getElementById("scheduledPinsModal").addEventListener("click", (e) => {
      const tab = e.target.closest(".sp-tab");
      if (!tab) return;
      document.querySelectorAll(".sp-tab").forEach((t) => t.classList.remove("sp-tab-active"));
      tab.classList.add("sp-tab-active");
      const accountId = tab.dataset.account;
      document.querySelectorAll(".sp-panel").forEach((p) => (p.style.display = "none"));
      const panel = document.getElementById(`sp-panel-${accountId}`);
      if (panel) panel.style.display = "block";
    });

    // Fetch pins for each account
    const renderPinsToPanel = async (accountId, info) => {
      const panel = document.getElementById(`sp-panel-${accountId}`);
      const tabStatus = document.querySelector(`[data-tab-status="${accountId}"]`);
      const setTabStatus = (type, label) => {
        if (!tabStatus) return;
        const icons = { ok: "check_circle", empty: "remove_circle_outline", error: "error_outline" };
        const colors = { ok: "#22c55e", empty: "#9ca3af", error: "#ef4444" };
        tabStatus.className = "sp-tab-status";
        tabStatus.innerHTML = `<span class="material-icons" style="font-size:13px;color:${colors[type]}">${icons[type]}</span>${label ? `<span class="sp-tab-count">${label}</span>` : ""}`;
      };
      if (!panel) return;
      try {
        const result = await window.electronAPI.pinterestGetScheduledPins(accountId);
        if (!result.success) {
          panel.innerHTML = `<div class="sp-error"><span class="material-icons">error_outline</span><p>${window.I18n?.t("workflows.sp_error") || "Failed to fetch scheduled pins"}</p><p class="sp-error-detail">${result.value || ""}</p><button class="sp-retry-btn" data-account-id="${accountId}">${window.I18n?.t("workflows.sp_retry") || "Retry"}</button></div>`;
          setTabStatus("error", "");
          return;
        }
        const pins = result.data || [];
        const totalCount = result.totalCount || pins.length;

        // Cache pending pin count for the workflows table
        // ScheduledPinsResource already returns only future (not-yet-posted) pins
        saveScheduledPinsCache(accountId, totalCount);

        if (pins.length === 0) {
          panel.innerHTML = `<div class="sp-empty"><span class="material-icons">event_busy</span><p>${window.I18n?.t("workflows.sp_no_pins") || "No scheduled pins found"}</p></div>`;
          setTabStatus("empty", "");
          return;
        }
        setTabStatus("ok", totalCount);
        const countLabel =
          window.I18n?.t("workflows.sp_total_count", { count: totalCount }) ||
          `${totalCount} scheduled pin(s)`;
        let pinsHtml = `<div class="sp-count-bar"><span class="material-icons">push_pin</span> ${countLabel}</div>`;
        pinsHtml += '<div class="sp-grid">';
        for (const pin of pins) {
          const title =
            pin.title ||
            pin.description ||
            (window.I18n?.t("workflows.sp_untitled") || "Untitled");
          const board = pin.board?.name || "";
          const section = pin.section?.title || "";
          const scheduledTs = pin.scheduled_ts;
          const scheduledDate = scheduledTs
            ? new Date(scheduledTs * 1000).toLocaleString()
            : "";
          const imgUrl =
            pin.image?.["236x"]?.url || pin.image?.["474x"]?.url || "";
          const pinLink = pin.link || "";
          pinsHtml += `
            <div class="sp-pin-card">
              <div class="sp-pin-img-wrap">
                ${imgUrl ? `<img class="sp-pin-img" src="${imgUrl}" alt="" loading="lazy" />` : `<div class="sp-pin-no-img"><span class="material-icons">image</span></div>`}
              </div>
              <div class="sp-pin-info">
                <div class="sp-pin-title" title="${title.replace(/"/g, "&quot;")}">${title.length > 60 ? title.substring(0, 57) + "..." : title}</div>
                ${board ? `<div class="sp-pin-board"><span class="material-icons">dashboard</span> ${board}${section ? " / " + section : ""}</div>` : ""}
                ${scheduledDate ? `<div class="sp-pin-date"><span class="material-icons">event</span> ${scheduledDate}</div>` : ""}
                ${pinLink ? `<div class="sp-pin-link"><span class="material-icons">link</span> <span class="sp-link-text" title="${pinLink.replace(/"/g, "&quot;")}">${pinLink.length > 40 ? pinLink.substring(0, 37) + "..." : pinLink}</span></div>` : ""}
              </div>
            </div>
          `;
        }
        pinsHtml += "</div>";
        panel.innerHTML = pinsHtml;
      } catch (error) {
        panel.innerHTML = `<div class="sp-error"><span class="material-icons">error_outline</span><p>${window.I18n?.t("workflows.sp_error") || "Failed to fetch scheduled pins"}</p><p class="sp-error-detail">${error.message || ""}</p><button class="sp-retry-btn" data-account-id="${accountId}">${window.I18n?.t("workflows.sp_retry") || "Retry"}</button></div>`;
        setTabStatus("error", "");
      }
    };

    // Retry button handler
    document.getElementById("scheduledPinsModal").addEventListener("click", async (e) => {
      const btn = e.target.closest(".sp-retry-btn");
      if (!btn) return;
      const accountId = btn.dataset.accountId;
      if (!accountId) return;
      const info = accountWorkflowMap.get(accountId);
      const tabStatus = document.querySelector(`[data-tab-status="${accountId}"]`);
      if (tabStatus) {
        tabStatus.innerHTML = `<span class="material-icons sp-tab-spin" style="font-size:13px;color:#9ca3af">sync</span>`;
      }
      const panel = document.getElementById(`sp-panel-${accountId}`);
      if (panel) panel.innerHTML = `<div class="sp-loading"><span class="material-icons sp-spin">sync</span></div>`;
      await renderPinsToPanel(accountId, info);
    });

    // Fetch accounts with concurrency of 3
    const CONCURRENCY = 3;
    const entries = [...accountEntries];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(([accountId, info]) => renderPinsToPanel(accountId, info)));
    }
  }

  /**
   * Show the Scheduled Pins modal for a Pinterest workflow.
   * Fetches scheduled pins from Pinterest's API via VCBrowser headless.
   */
  async function showScheduledPinsModal(workflowId) {
    // Remove any existing modal
    document.getElementById("scheduledPinsModal")?.remove();

    // Resolve the Pinterest account ID from the workflow
    let workflow = allWorkflows[workflowId];
    if (!workflow) {
      showAlert("error", window.I18n?.t("workflows.sp_error") || "Could not load workflow data");
      return;
    }

    // Load full workflow details including posts from database if needed
    if (!workflow.posts || workflow.posts.length === 0) {
      const fullWorkflow = await loadWorkflowDetail(workflowId);
      if (fullWorkflow) {
        workflow = fullWorkflow;
        allWorkflows[workflowId] = fullWorkflow;
      }
    }

    // Find the first Pinterest post to get account information
    const pinterestPost = (workflow.posts || []).find(
      (post) => post.pinterestAccountId && post.pinterestBoardId,
    ) || (workflow.posts || []).find(
      (post) => post.pinterestOutput != null,
    );

    if (!pinterestPost || !pinterestPost.pinterestAccountId) {
      showAlert("error", window.I18n?.t("workflows.sp_no_account") || "No Pinterest account linked to this workflow");
      return;
    }

    const accountId = pinterestPost.pinterestAccountId;
    const pinterestAccounts = (await window.electronAPI.readKey("pinterestAccounts")) || {};
    const account = pinterestAccounts[accountId];
    const accountLabel = account?.email || accountId;

    // Build modal HTML
    const modalHtml = `
      <div class="sp-modal-overlay" id="scheduledPinsModal">
        <div class="sp-modal">
          <div class="sp-modal-header">
            <div class="sp-header-left">
              <span class="material-icons sp-header-icon">schedule</span>
              <div>
                <h3 class="sp-title">${window.I18n?.t("workflows.sp_title") || "Scheduled Pins"}</h3>
                <span class="sp-account-label">${accountLabel}</span>
              </div>
            </div>
            <button class="sp-close-btn" id="spCloseBtn">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div class="sp-modal-body" id="spModalBody">
            <div class="sp-loading">
              <span class="material-icons sp-spin">sync</span>
              <p>${window.I18n?.t("workflows.sp_loading") || "Fetching scheduled pins..."}</p>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", modalHtml);

    // Close handlers
    document.getElementById("spCloseBtn").addEventListener("click", () => {
      document.getElementById("scheduledPinsModal")?.remove();
    });
    document.getElementById("scheduledPinsModal").addEventListener("click", (e) => {
      if (e.target.id === "scheduledPinsModal") {
        document.getElementById("scheduledPinsModal")?.remove();
      }
    });

    // Fetch scheduled pins
    try {
      const result = await window.electronAPI.pinterestGetScheduledPins(accountId);
      const body = document.getElementById("spModalBody");
      if (!body) return;

      if (!result.success) {
        body.innerHTML = `
          <div class="sp-error">
            <span class="material-icons">error_outline</span>
            <p>${window.I18n?.t("workflows.sp_error") || "Failed to fetch scheduled pins"}</p>
            <p class="sp-error-detail">${result.value || ""}</p>
          </div>
        `;
        return;
      }

      const pins = result.data || [];
      const totalCount = result.totalCount || pins.length;

      // Cache pending pin count for the workflows table
      // ScheduledPinsResource already returns only future (not-yet-posted) pins
      saveScheduledPinsCache(accountId, totalCount);

      if (pins.length === 0) {
        body.innerHTML = `
          <div class="sp-empty">
            <span class="material-icons">event_busy</span>
            <p>${window.I18n?.t("workflows.sp_no_pins") || "No scheduled pins found"}</p>
          </div>
        `;
        return;
      }

      // Build the pins grid
      const countLabel = window.I18n?.t("workflows.sp_total_count", { count: totalCount }) || `${totalCount} scheduled pin(s)`;
      let pinsHtml = `<div class="sp-count-bar"><span class="material-icons">push_pin</span> ${countLabel}</div>`;
      pinsHtml += '<div class="sp-grid">';

      for (const pin of pins) {
        const title = pin.title || pin.description || (window.I18n?.t("workflows.sp_untitled") || "Untitled");
        const board = pin.board?.name || "";
        const section = pin.section?.title || "";
        const scheduledTs = pin.scheduled_ts;
        const scheduledDate = scheduledTs ? new Date(scheduledTs * 1000).toLocaleString() : "";
        const imgUrl = pin.image?.["236x"]?.url || pin.image?.["474x"]?.url || "";
        const pinLink = pin.link || "";

        pinsHtml += `
          <div class="sp-pin-card">
            <div class="sp-pin-img-wrap">
              ${imgUrl ? `<img class="sp-pin-img" src="${imgUrl}" alt="" loading="lazy" />` : `<div class="sp-pin-no-img"><span class="material-icons">image</span></div>`}
            </div>
            <div class="sp-pin-info">
              <div class="sp-pin-title" title="${title.replace(/"/g, '&quot;')}">${title.length > 60 ? title.substring(0, 57) + "..." : title}</div>
              ${board ? `<div class="sp-pin-board"><span class="material-icons">dashboard</span> ${board}${section ? " / " + section : ""}</div>` : ""}
              ${scheduledDate ? `<div class="sp-pin-date"><span class="material-icons">event</span> ${scheduledDate}</div>` : ""}
              ${pinLink ? `<div class="sp-pin-link"><span class="material-icons">link</span> <span class="sp-link-text" title="${pinLink.replace(/"/g, '&quot;')}">${pinLink.length > 40 ? pinLink.substring(0, 37) + "..." : pinLink}</span></div>` : ""}
            </div>
          </div>
        `;
      }

      pinsHtml += "</div>";
      body.innerHTML = pinsHtml;

    } catch (error) {
      const body = document.getElementById("spModalBody");
      if (body) {
        body.innerHTML = `
          <div class="sp-error">
            <span class="material-icons">error_outline</span>
            <p>${window.I18n?.t("workflows.sp_error") || "Failed to fetch scheduled pins"}</p>
            <p class="sp-error-detail">${error.message || ""}</p>
          </div>
        `;
      }
    }
  }

})();
