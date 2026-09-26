const path = require("path");
const { app, BrowserWindow, powerMonitor, session } = require("electron");
const networkPolicy = require("./lib/networkPolicy");
networkPolicy.installNodePolicy();
app.commandLine.appendSwitch("host-resolver-rules", networkPolicy.browserHostRules);
app.on("session-created", networkPolicy.installSessionPolicy);

// These must be evaluated early but are lightweight
const isDev = !app.isPackaged;

// Hot-reload in development: watch all source files and restart on change
/* if (isDev) {
  require("electron-reload")(__dirname, {
    electron: path.join(__dirname, "node_modules", ".bin", "electron.cmd"),
    hardResetMethod: "exit",
    ignored: /node_modules|dist|build-temp|userData/,
  });
} */

// Fix GPU process crash (STATUS_BREAKPOINT / exit_code=-2147483645 on Windows)
// Run GPU in-process and disable its sandbox to prevent the subprocess from crashing,
// while keeping hardware acceleration active for smooth rendering.
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// Detect RDP/headless environment and fully disable GPU for those sessions
function isRemoteSession() {
  return process.env.SESSIONNAME && process.env.SESSIONNAME !== 'Console';
}
if (isRemoteSession() || process.argv.includes('--disable-gpu')) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  console.log('[GPU] Hardware acceleration disabled (RDP/remote session detected)');
}

// Single instance lock - prevent multiple instances when users double-click
const gotTheLock = app.requestSingleInstanceLock();

let mainWindow = null;
let splashWindow = null;

if (!gotTheLock) {
  // Another instance is already running, quit immediately
  console.log("[SingleInstance] Another instance is already running, quitting...");
  app.quit();
} else {
  // Handle second instance attempt - focus existing window
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    console.log("[SingleInstance] Second instance attempted, focusing existing window");
    const windowToFocus = mainWindow || splashWindow;
    if (windowToFocus) {
      if (windowToFocus.isMinimized()) windowToFocus.restore();
      windowToFocus.show();
      windowToFocus.focus();
    }
  });
}

// Create splash window immediately with minimal overhead
const createSplashWindow = () => {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 400,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    center: true,
    show: false,
    icon: path.join(__dirname, "frontend", "assets", "images", "app-icon.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  splashWindow.loadFile(path.join(__dirname, "frontend", "splash.html"));

  // Show splash as soon as it's ready to paint
  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
    splashWindow.focus();
  });

  return splashWindow;
};

// Show splash window IMMEDIATELY when app is ready - before any heavy loading
app.whenReady().then(async () => {

  networkPolicy.installSessionPolicy(session.defaultSession);

  createSplashWindow();
  await initializeApp();
}).catch((error) => {
  console.error("Error in app.whenReady():", error);
  console.error("Stack:", error.stack);
});

// All heavy initialization happens here, after splash is visible
async function initializeApp() {
  try {
    // Now load heavy modules
    const {
      ensureStorageExists,
      init,
      terminateAllSpyProcesses
    } = require("./lib/utils");
    const { registerIpcHandlers } = require("./lib/ipcHandlers");
    const telegramNotifications = require("./lib/telegramNotifications");
    const systemNotifications = require("./lib/systemNotifications");
    const { closeBrowserSession: closeFbScraperSession } = require("./automations/facebookScraper");
    const { closeAllBrowserSessions: closeChatGPTChatSessions } = require("./automations/chatgptChat");
    const { shutdownExiftool } = require("./lib/imageClean");

    // Store these for cleanup on quit
    global._appModules = {
      terminateAllSpyProcesses,
      closeFbScraperSession,
      closeChatGPTChatSessions,
      shutdownExiftool
    };

    registerIpcHandlers();
    ensureStorageExists();
    mainWindow = createMainWindow();

    // Handle window close event (Alt+F4, system close, etc.)
    // Always intercept close and ask for confirmation
    mainWindow.on('close', (event) => {
      // Always prevent close and ask renderer to show confirmation dialog
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('show-close-confirmation');
      }
    });

    await init();

    // Cleanup incomplete workflows from previous session
    const workflowDb = require("./lib/database");
    workflowDb.cleanupIncompleteWorkflows();

    // Run one-time migration to move temp workflow images to permanent storage
    // This fixes existing workflows that have images in Uploads/Temp which would be deleted
    await runWorkflowImageMigration(workflowDb);

    // Run one-time migration to convert expensive models to mini variants
    // This reduces token costs for existing automations
    await runModelMigration();

    // Initialize notifications
    await telegramNotifications.initialize();
    await systemNotifications.initialize();

    // Initialize analytics cleanup scheduler (runs daily at 3 AM)
    const { getAnalyticsDatabase } = require("./lib/analyticsDatabase");
    const analyticsDb = getAnalyticsDatabase();

    // Run initial cleanup check
    try {
      const cleanupResult = analyticsDb.pruneOldData(365); // 1 year retention
      if (cleanupResult.totalDeleted > 0) {
        console.log(`[Analytics] Initial cleanup: removed ${cleanupResult.totalDeleted} old records`);
      }
    } catch (error) {
      console.error("[Analytics] Initial cleanup failed:", error.message);
    }

    // Schedule daily cleanup at 3 AM
    const scheduleAnalyticsCleanup = () => {
      const now = new Date();
      const next3AM = new Date(now);
      next3AM.setHours(3, 0, 0, 0);
      if (next3AM <= now) {
        next3AM.setDate(next3AM.getDate() + 1);
      }
      const msUntil3AM = next3AM - now;

      setTimeout(() => {
        try {
          const result = analyticsDb.pruneOldData(365);
          console.log(`[Analytics] Daily cleanup: removed ${result.totalDeleted} old records`);
        } catch (error) {
          console.error("[Analytics] Daily cleanup failed:", error.message);
        }
        // Schedule next cleanup
        setInterval(() => {
          try {
            const result = analyticsDb.pruneOldData(365);
            console.log(`[Analytics] Daily cleanup: removed ${result.totalDeleted} old records`);
          } catch (error) {
            console.error("[Analytics] Daily cleanup failed:", error.message);
          }
        }, 24 * 60 * 60 * 1000); // Every 24 hours
      }, msUntil3AM);

      console.log(`[Analytics] Next cleanup scheduled in ${Math.round(msUntil3AM / 1000 / 60)} minutes`);
    };

    scheduleAnalyticsCleanup();

    // ============================================
    // Media/Storage Cleanup Scheduler (runs daily at 4 AM)
    // ============================================
    const scheduleMediaCleanup = () => {
      const now = new Date();
      const next4AM = new Date(now);
      next4AM.setHours(4, 0, 0, 0);
      if (next4AM <= now) {
        next4AM.setDate(next4AM.getDate() + 1);
      }
      const msUntil4AM = next4AM - now;

      setTimeout(() => {
        const runMediaCleanup = async () => {
          try {
            const { CleanupManager } = require("./lib/cleanup");
            const cleanupManager = new CleanupManager();
            const result = await cleanupManager.cleanupAll(false);
            if (result.totalRemoved > 0) {
              console.log(`[CLEANUP] Scheduled cleanup: removed ${result.totalRemoved} items, freed ${result.totalFormattedSize}`);
            }
          } catch (error) {
            console.error("[CLEANUP] Scheduled cleanup failed:", error.message);
          }
        };
        runMediaCleanup();
        setInterval(runMediaCleanup, 24 * 60 * 60 * 1000); // Every 24 hours
      }, msUntil4AM);

      console.log(`[CLEANUP] Next media cleanup scheduled in ${Math.round(msUntil4AM / 1000 / 60)} minutes`);
    };

    scheduleMediaCleanup();

    // ============================================
    // Pinterest Analytics Collector (configurable)
    // ============================================
    const { initPinterestScheduler } = require("./lib/pinterestScheduler");
    initPinterestScheduler();

    // Reveal the workspace even if it finished loading during initialization.
    const showWorkspace = () => {
      // Close splash and show main window
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.maximize();
        mainWindow.show();
        mainWindow.focus();
      }
    };
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", showWorkspace);
    else showWorkspace();

    // Start periodic update checker
    startUpdateChecker(mainWindow);

    console.log("Application initialized successfully");

  } catch (error) {
    console.error("Error during application initialization:", error);
    // Close splash on error
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
  }
}

process.on("uncaughtException", (error) => {
  // A remote browser or upstream HTTPS peer may reset an already-closing
  // transport. At this point there is no operation left to recover or retry,
  // and treating it as an application exception produces a false crash report.
  const isVCBrowserCloseReset =
    Number(global.__vcBrowserTransportResetUntil || 0) >= Date.now() &&
    ["ECONNRESET", "ECONNABORTED", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(error?.code);
  if (isVCBrowserCloseReset) {
    return;
  }
  console.error("[MAIN] Uncaught Exception:", error?.stack || error);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[MAIN] Unhandled Rejection at:", promise, "reason:", reason?.stack || reason);
});
process.on("warning", (w) => {
  console.warn("[MAIN] Process warning:", w?.stack || w);
});

// Integrity check for critical files (skip in dev mode)


const createMainWindow = () => {
  var mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    frame: false,
    titleBarStyle: "hidden",
    show: false, // Start hidden, will show after splash closes
    icon: path.join(__dirname, "frontend", "assets", "images", "app-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: false,
      enableRemoteModule: false,
      backgroundThrottling: false,
      offscreen: false,
    },
  });

  // Handle renderer process crashes
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    console.error("Renderer process crashed:", details);
    console.error("Reason:", details.reason);
    console.error("Exit code:", details.exitCode);

    // Try to reload the page
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        console.log("Attempting to reload after crash...");
        mainWindow.reload();
      }
    }, 1000);
  });

  // Handle unresponsive renderer
  mainWindow.webContents.on("unresponsive", () => {
    console.warn("Renderer became unresponsive");
  });

  mainWindow.webContents.on("responsive", () => {
    console.log("Renderer became responsive again");
  });

  // Handle page load events
  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedURL) => {
      console.error("Page failed to load:", {
        errorCode,
        errorDescription,
        url: validatedURL,
      });
    },
  );

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("Page loaded successfully");
  });

  // Handle console messages from renderer
  mainWindow.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      if (level >= 2) {
        // Warning and error levels
        console.log(
          `Renderer ${level === 2 ? "WARN" : "ERROR"}:`,
          message,
          `at ${sourceId}:${line}`,
        );
      }
    },
  );

  // Memory monitoring removed to prevent white screen issues

  // Handle navigation events that might cause white screen
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    console.log("Navigation detected to:", navigationUrl);
  });

  mainWindow.webContents.on("did-navigate", (event, url) => {
    console.log("Navigation completed to:", url);
  });

  // Fix for Electron focus bug - inputs become unresponsive until window is resized/DevTools toggled
  // This forces a repaint when window regains focus to fix stuck input fields
  mainWindow.on("focus", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Force repaint by invalidating the renderer
      mainWindow.webContents.invalidate();
    }
  });

  // Also handle blur to ensure clean state
  mainWindow.on("blur", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Blur any focused element to reset state
      mainWindow.webContents.executeJavaScript(`
        if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }
      `).catch(() => { });
    }
  });

  // Intercept image requests to external CDNs and add browser-like headers
  // This prevents Facebook/Instagram/CDN servers from blocking image downloads
  const imageFilter = {
    urls: [
      "https://*.fbcdn.net/*",
      "https://*.fna.fbcdn.net/*",
      "https://*.xx.fbcdn.net/*",
      "https://graph.facebook.com/*",
      "https://*.facebook.com/photo*",
      "https://*.cdninstagram.com/*",
      "https://*.pinimg.com/*",
      "https://*.fbsbx.com/*",
      "https://lookaside.fbsbx.com/*",
      "https://platform-lookaside.fbsbx.com/*",
    ],
  };

  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    imageFilter,
    (details, callback) => {
      details.requestHeaders["User-Agent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
      details.requestHeaders["Accept"] =
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
      details.requestHeaders["Accept-Language"] = "en-US,en;q=0.9";
      details.requestHeaders["Sec-Fetch-Dest"] = "image";
      details.requestHeaders["Sec-Fetch-Mode"] = "no-cors";
      details.requestHeaders["Sec-Fetch-Site"] = "cross-site";
      // Remove Electron-specific origin and file:// referer that can cause blocks
      delete details.requestHeaders["Origin"];
      delete details.requestHeaders["Referer"];
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  // Don't maximize here - it forces the window to show
  // Will maximize when showing after splash closes
  mainWindow.loadFile(path.join(__dirname, "frontend", "index.html"));

  return mainWindow;
};

let updateCheckInterval = null;


// Periodic update checker function
function startUpdateChecker(window) {
    const check = async () => {
      const result = await require('./lib/githubUpdates').checkForUpdates(app.getVersion());
      if (result.success && result.updateAvailable && !window.isDestroyed()) {
        window.webContents.send('update-available-notification', result);
      }
    };
    const initial = setTimeout(check, 120000);
    updateCheckInterval = setInterval(check, 30 * 60 * 1000);
    app.once('before-quit', () => { clearTimeout(initial); clearInterval(updateCheckInterval); });
  }

/**
 * One-time migration to convert expensive AI models to cost-effective mini alternatives
 * This reduces token costs by migrating existing automations to use mini models
 */
async function runModelMigration() {
  const { readKey, updateData } = require("./lib/utils");

  const migrationKey = "modelMigrationToNano_v2";

  try {
    // Check if migration already completed
    const migrationDone = await readKey(migrationKey);

    if (migrationDone) {
      console.log("[Migration] Model migration to mini already completed, skipping");
      return;
    }

    console.log("[Migration] Starting model migration to gpt-5-nano...");

    // Model mapping: ALL OpenAI models -> gpt-5-nano
    const modelMigrationMap = {
      // OpenAI GPT-5 series -> gpt-5-nano
      "gpt-5.2": "gpt-5-nano",
      "gpt-5.2-pro": "gpt-5-nano",
      "gpt-5": "gpt-5-nano",
      "gpt-5-pro": "gpt-5-nano",
      "gpt-5-mini": "gpt-5-nano",
      // OpenAI GPT-4.1 series -> gpt-5-nano
      "gpt-4.1": "gpt-5-nano",
      "gpt-4.1-mini": "gpt-5-nano",
      "gpt-4.1-nano": "gpt-5-nano",
      // OpenAI GPT-4o series -> gpt-5-nano
      "gpt-4o": "gpt-5-nano",
      "gpt-4o-mini": "gpt-5-nano",
      // OpenAI reasoning models -> gpt-5-nano
      "o4-mini": "gpt-5-nano",
      "o3": "gpt-5-nano",
      "o3-pro": "gpt-5-nano",
      "o3-mini": "gpt-5-nano",
      "o1": "gpt-5-nano",
      "o1-pro": "gpt-5-nano",
      "o1-mini": "gpt-5-nano",
      "o1-preview": "gpt-5-nano",
      // Legacy models -> gpt-5-nano
      "gpt-4-turbo": "gpt-5-nano",
      "gpt-4": "gpt-5-nano",
      "gpt-3.5-turbo": "gpt-5-nano",
      // OpenRouter OpenAI models -> openai/gpt-5-nano
      "openai/gpt-5.2": "openai/gpt-5-nano",
      "openai/gpt-5": "openai/gpt-5-nano",
      "openai/gpt-5-mini": "openai/gpt-5-nano",
      "openai/gpt-4o": "openai/gpt-5-nano",
      "openai/gpt-4o-mini": "openai/gpt-5-nano",
      "openai/o4-mini": "openai/gpt-5-nano",
      "openai/o3": "openai/gpt-5-nano",
      "openai/o3-mini": "openai/gpt-5-nano",
      "openai/o1": "openai/gpt-5-nano",
      "openai/o1-mini": "openai/gpt-5-nano",
      "openai/o1-preview": "openai/gpt-5-nano",
      "openai/gpt-4.1": "openai/gpt-5-nano",
      "openai/gpt-4.1-mini": "openai/gpt-5-nano",
      "openai/gpt-4-turbo": "openai/gpt-5-nano",
      "openai/gpt-4": "openai/gpt-5-nano",
      // Anthropic expensive models (OpenRouter)
      "anthropic/claude-opus-4-5": "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6": "anthropic/claude-haiku-4-5",
      "anthropic/claude-3-opus": "anthropic/claude-3-haiku",
      // Direct Anthropic models
      "claude-opus-4-5-20251101": "claude-haiku-4-5",
      "claude-opus-4-5": "claude-haiku-4-5",
      "claude-3-opus-20240229": "claude-3-haiku-20240307",
      // Google expensive models (OpenRouter)
      "google/gemini-3-pro": "google/gemini-3-flash",
      "google/gemini-2.5-pro": "google/gemini-2.5-flash",
      // Direct Google models
      "gemini-3-pro": "gemini-3-flash",
      "gemini-2.5-pro": "gemini-2.5-flash",
      "gemini-1.5-pro": "gemini-1.5-flash",
      "gemini-1.0-pro": "gemini-1.5-flash",
      // Meta Llama expensive models
      "meta-llama/llama-4-maverick-405b": "meta-llama/llama-3.3-70b-instruct",
      "meta-llama/llama-4-scout-70b": "meta-llama/llama-3.3-70b-instruct",
      "meta-llama/llama-3.1-405b-instruct": "meta-llama/llama-3.3-70b-instruct",
      "meta-llama/llama-4-maverick": "meta-llama/llama-3.3-70b-instruct",
      // Mistral expensive models
      "mistralai/mistral-large-2": "mistralai/mixtral-8x7b-instruct",
      "mistralai/mistral-medium-2": "mistralai/mixtral-8x7b-instruct",
      "mistralai/mixtral-8x22b-instruct": "mistralai/mixtral-8x7b-instruct",
      // Qwen expensive models  
      "qwen/qwen3-235b-a22b": "qwen/qwen3-32b",
      "qwen/qwen-2.5-72b-instruct": "qwen/qwen-2.5-7b-instruct",
      // DeepSeek reasoning (expensive)
      "deepseek/deepseek-r1": "deepseek/deepseek-chat",
      "deepseek/deepseek-v3.2": "deepseek/deepseek-chat",
      // Other expensive models
      "cohere/command-r-plus": "deepseek/deepseek-chat",
      "x-ai/grok-2": "deepseek/deepseek-chat",
      "perplexity/llama-3.1-sonar-huge-128k-online": "meta-llama/llama-3.3-70b-instruct"
    };

    const automations = await readKey("automations") || [];
    let migratedNodesCount = 0;
    let automationsUpdated = 0;

    for (const automation of automations) {
      if (!automation.data || !automation.data.drawflow || !automation.data.drawflow.Home || !automation.data.drawflow.Home.data) {
        continue;
      }

      const nodes = automation.data.drawflow.Home.data;
      let automationModified = false;

      for (const nodeId in nodes) {
        const node = nodes[nodeId];

        // Check if node has inputs with model selection
        if (node.data && node.data.inputs && Array.isArray(node.data.inputs)) {
          for (const input of node.data.inputs) {
            if (input.title === "Model" && input.value) {
              const currentModel = input.value;
              const newModel = modelMigrationMap[currentModel];

              if (newModel) {
                console.log(`[Migration] ${automation.label}: Migrating model ${currentModel} -> ${newModel}`);
                input.value = newModel;
                migratedNodesCount++;
                automationModified = true;
              }
            }
          }
        }
      }

      if (automationModified) {
        automationsUpdated++;
      }
    }

    // Save updated automations
    if (automationsUpdated > 0) {
      await updateData("automations", automations);
      console.log(`[Migration] Model migration completed: ${migratedNodesCount} nodes migrated across ${automationsUpdated} automations`);
    } else {
      console.log("[Migration] No automations needed model migration");
    }

    // Mark migration as complete
    await updateData(migrationKey, true);

  } catch (error) {
    console.error("[Migration] Model migration failed:", error);
    // Don't mark as complete so it retries next time
  }
}

// Prevent multiple quit attempts
/**
 * One-time migration to move workflow images from Uploads/Temp to permanent storage
 * This fixes the issue where cleanup was deleting workflow images after 24 hours
 */
async function runWorkflowImageMigration(workflowDb) {
  const fs = require("fs/promises");
  const fss = require("fs");
  const path = require("path");
  const crypto = require("crypto");

  const migrationKey = "workflowImageMigrationCompleted_v1";

  try {
    // Check if migration already completed
    const { readKey, updateData } = require("./lib/utils");
    const migrationDone = await readKey(migrationKey);

    if (migrationDone) {
      console.log("[Migration] Workflow image migration already completed, skipping");
      return;
    }

    console.log("[Migration] Starting workflow image migration...");

    const userDataPath = app.getPath("userData");
    const tempPath = path.join(userDataPath, "Uploads", "Temp");
    const imagesPath = path.join(userDataPath, "Images");

    // Ensure Images directory exists
    await fs.mkdir(imagesPath, { recursive: true });

    let migratedCount = 0;
    let errorCount = 0;

    // Get all workflows from database
    const workflows = workflowDb.getAllWorkflowsSummary() || [];

    for (const workflow of workflows) {
      try {
        const fullWorkflow = workflowDb.getWorkflowWithPosts(workflow.workflowId);
        if (!fullWorkflow || !fullWorkflow.posts) continue;

        for (const post of fullWorkflow.posts) {
          // Check postImg
          const postImg = post.postImg || post.post_img;
          if (postImg && typeof postImg === "string" && postImg.includes("Uploads") && postImg.includes("Temp")) {
            // This is a temp path that needs migration
            if (fss.existsSync(postImg)) {
              const ext = path.extname(postImg) || ".jpg";
              const newName = `migrated_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
              const newPath = path.join(imagesPath, newName);

              await fs.copyFile(postImg, newPath);

              // Update database
              workflowDb.updatePostImage(post.postId, newPath);
              migratedCount++;
              console.log(`[Migration] Moved ${path.basename(postImg)} -> ${newName}`);
            }
          }

          // Check originalInputImage
          const originalImg = post.originalInputImage || post.original_input_image;
          if (originalImg && typeof originalImg === "string" && originalImg.includes("Uploads") && originalImg.includes("Temp")) {
            if (fss.existsSync(originalImg)) {
              const ext = path.extname(originalImg) || ".jpg";
              const newName = `migrated_orig_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
              const newPath = path.join(imagesPath, newName);

              await fs.copyFile(originalImg, newPath);

              // Update database (need to add this method or use raw SQL)
              try {
                workflowDb.db.prepare("UPDATE posts SET original_input_image = ? WHERE post_id = ?").run(newPath, post.postId);
                migratedCount++;
                console.log(`[Migration] Moved original ${path.basename(originalImg)} -> ${newName}`);
              } catch (e) {
                console.warn(`[Migration] Failed to update original_input_image for ${post.postId}:`, e.message);
              }
            }
          }
        }
      } catch (err) {
        errorCount++;
        console.warn(`[Migration] Error processing workflow ${workflow.workflowId}:`, err.message);
      }
    }

    // Mark migration as complete
    await updateData(migrationKey, true);

    console.log(`[Migration] Workflow image migration completed: ${migratedCount} images migrated, ${errorCount} errors`);

  } catch (error) {
    console.error("[Migration] Workflow image migration failed:", error);
    // Don't mark as complete so it retries next time
  }
}

let isQuitting = false;

// Cleanup spy processes on app exit
app.on("before-quit", async (event) => {
  if (isQuitting) return;

  event.preventDefault();
  isQuitting = true;

  console.log("Application shutting down, cleaning up...");

  // Get modules from global store (they may not be loaded yet if app is closing early)
  const modules = global._appModules || {};

  try {
    // Set a maximum timeout for cleanup
    const cleanupTasks = [];
    if (modules.terminateAllSpyProcesses) {
      cleanupTasks.push(modules.terminateAllSpyProcesses());
    }
    if (modules.closeFbScraperSession) {
      cleanupTasks.push(modules.closeFbScraperSession());
    }
    if (modules.closeChatGPTChatSessions) {
      cleanupTasks.push(modules.closeChatGPTChatSessions());
    }
    if (modules.shutdownExiftool) {
      cleanupTasks.push(modules.shutdownExiftool());
    }

    // Close any persistent Qwen browser sessions
    try {
      const qwenSession = require("./lib/qwenBrowserSession");
      if (qwenSession && qwenSession.closeAllSessions) {
        cleanupTasks.push(Promise.resolve().then(() => qwenSession.closeAllSessions()));
      }
    } catch (_) {}

    if (cleanupTasks.length > 0) {
      await Promise.race([
        Promise.all(cleanupTasks),
        new Promise((resolve) =>
          setTimeout(() => {
            console.log("Cleanup timeout reached, forcing quit");
            resolve();
          }, 3000),
        ),
      ]);
    }
  } catch (error) {
    console.error("Error during cleanup:", error);
  }

  console.log("Cleanup complete, quitting application");
  app.exit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
