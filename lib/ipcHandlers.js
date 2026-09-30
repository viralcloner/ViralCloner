const { ipcMain, dialog, app, BrowserWindow, shell } = require("electron");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const path = require("path");
const fs = require("fs/promises");
const fss = require("fs");
const http = require("http");
const https = require("https");
const { get } = require("http");
const { WebSocket } = require("ws");
const { spawn } = require("child_process");
const extractZip = require("extract-zip");
const { miniCanvas } = require("../automations/minicanvas");
const { uploadImage } = require("../automations/uploadImage");
const crypto = require("crypto");
const { Secret, TOTP } = require("otpauth");
const { getMailboxManager, userError: mailboxUserError, errorReason: mailboxErrorReason } = require("./mailboxManager");
const {
  AIHumanizerError,
  MAX_HUMANIZE_ATTEMPTS,
  humanizeText,
  humanizeTexts,
  scoreText,
} = require("./aiHumanizer");
const aiHumanizerBatchCancellations = new Map();

// Beta mode flag - set to false for production release
const isBeta = true;


const {
  readKey,
  updateData,
  downloadFileToUserData,
  trackLoginStatus,
  cancelTestLogin,
  startBrowser,
  startSpying,
  prepareFreshExtension,
  startBareChrome,
  extractDiscordFields,
  updateProxyBackground,
  encrypt,
  decrypt,
  findChromeExe,
  generateRandomString,
  showAlert,
  triggerCleanupIfNeeded,
  getAvailableLocaleCountries,
  getUserCountryCode,
  getUserLocaleBundle,
  repairProfile,
  isRayobyteSessionProxy,
  checkProxyClean,
  findCleanProxy,
  decryptWithMigration,
  encryptPortable,
  decryptAutomation,
  getStartupCleanupStatus,
  runStartupCleanup,
  // Automation thumbnail functions
  saveAutomationThumbnail,
  extractImagePathsFromOutputs,
  // Chrome version from public API
  getStableChromeVersion,
  // AI usage tracking
  trackAIUsage,
  // FeedSpy support
  enqueueSpyPost,
  // Profile browser registry
  registerProfileBrowser,
  deregisterProfileBrowser,
  // Stable device ID resolver
} = require("./utils");
// Local application capabilities
const { getAppCapabilities } = require("./appCapabilities");
// Fingerprint functions are now in cdpFingerprint.js
const {
  getOrCreateFingerprint,
  getConsistentFingerprintForProfile,
  getRealMachineFingerprint,
  getLatestChromeVersion,
  getVCBrowserVersion,
} = require("./cdpFingerprint");
// VCBrowser - Undetectable browser
const {
  startVCBrowser,
  isVCBrowserInstalled,
  getVCBrowserPath,
  killBrowsersForProfile,
  gracefulCloseVCBrowser,
} = require("./VCBrowserManager");
const {
  executeAutomation,
  setSkipModeForWorkflow,
} = require("../lib/executeAutomation");
const { clearWorkflowCache } = require("../automations/uploadImage");
const { uploadVideo, clearWorkflowCache: clearVideoWorkflowCache } = require("../automations/uploadVideo");
const { exportFlowImages } = require("../lib/exportFlowImages");
const { inpaintOnce } = require("../lib/inpaint");
const { BackupManager } = require("../lib/backupManager");
const { workflowQueue } = require("../lib/workflowQueue");
const CDP = require("chrome-remote-interface");
const telegramNotifications = require("../lib/telegramNotifications");
const systemNotifications = require("../lib/systemNotifications");
const workflowDb = require("../lib/database");
const { getAnalyticsDatabase } = require("../lib/analyticsDatabase");

// Use the workflowQueue's stoppedWorkflows Set to check if a workflow was stopped
// This is populated by workflowQueue.removeFromQueue() which is called from stop-workflow handler
const getStoppedWorkflowsSet = () => {
  const set = workflowQueue.stoppedWorkflows;
  console.log(
    `🔍🔍🔍 [CHECK DEBUG] getStoppedWorkflowsSet called, contents:`,
    Array.from(set),
  );
  return set;
};

// Persistent debug logging for workflow troubleshooting
let debugLogPath = null;
function initDebugLog() {
  if (!debugLogPath) {
    debugLogPath = path.join(app.getPath("userData"), "workflow-debug.log");
  }
}

function debugLog(message, data = null) {
  try {
    initDebugLog();
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] ${message}`;
    if (data) {
      logEntry += `\n${JSON.stringify(data, null, 2)}`;
    }
    logEntry += "\n";

    fss.appendFileSync(debugLogPath, logEntry);
    console.log(message, data || "");
  } catch (error) {
    // Silently fail if logging fails
    console.error("Failed to write debug log:", error.message);
  }
}

const withTimeout = (promise, ms) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms}ms`));
    }, ms);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
};

/**
 * Helper to preserve output images by copying from Temp to permanent Images folder.
 * Modifies outputData in place to update image paths if needed.
 * @param {string} postId - Post ID (used for unique filename)
 * @param {object} outputData - Output data object with potential image property
 * @returns {object} - The modified outputData
 */
function preserveOutputImage(postId, outputData) {
  if (!outputData) return outputData;

  const tempFolder = path.join(app.getPath("userData"), "Uploads", "Temp");
  const imagesFolder = path.join(app.getPath("userData"), "Images");

  const isInTemp = (filePath) =>
    filePath &&
    (filePath.includes(tempFolder) ||
      filePath.includes("Uploads\\Temp") ||
      filePath.includes("Uploads/Temp"));

  const preserveFile = (filePath, prefix) => {
    if (!filePath || !isInTemp(filePath)) return filePath;
    try {
      if (!fss.existsSync(imagesFolder)) {
        fss.mkdirSync(imagesFolder, { recursive: true });
      }
      const fileName = path.basename(filePath);
      const permanentPath = path.join(imagesFolder, `${prefix}_${postId}_${fileName}`);
      if (fss.existsSync(filePath)) {
        fss.copyFileSync(filePath, permanentPath);
        console.log(`✓ Preserved ${prefix}: ${permanentPath}`);
        return permanentPath;
      } else {
        console.warn(`⚠️ File not found for preservation: ${filePath}`);
      }
    } catch (copyError) {
      console.error(`Error preserving ${prefix}:`, copyError.message);
    }
    return filePath;
  };

  // Preserve image
  if (outputData.image) {
    outputData.image = preserveFile(outputData.image, "output");
  }

  // Preserve video (Facebook output)
  if (outputData.video) {
    outputData.video = preserveFile(outputData.video, "video_output");
  }

  // Preserve videoUrl (Pinterest output) — only if it's a local file path, not an external URL
  if (outputData.videoUrl && !outputData.videoUrl.startsWith("http")) {
    outputData.videoUrl = preserveFile(outputData.videoUrl, "video_output");
  }

  return outputData;
}

// Optimized monitoring helper functions - minimal overhead
async function getMonitoringData() {
  const browsers = [];
  const midjourneyRequests = [];

  // Get browser instances from global spyProcesses - no excessive logging
  if (global.spyProcesses && global.spyProcesses.size > 0) {
    for (const [pid, processInfo] of global.spyProcesses) {
      if (processInfo.process && !processInfo.process.killed) {
        // Completely skip memory monitoring for spy browsers to prevent CPU usage
        const memoryUsage =
          processInfo.method === "spy"
            ? "N/A"
            : await getProcessMemoryUsage(pid);
        const browserEntry = {
          pid: pid,
          profileName: processInfo.profileName,
          status: "running",
          type: processInfo.type || "Browser",
          startTime: processInfo.startTime,
          memoryUsage: memoryUsage,
          debuggingPort: processInfo.debuggingPort || null,
        };
        browsers.push(browserEntry);
      }
    }
  }

  // Get Midjourney requests - optimized with minimal logging
  try {
    const midjourneyModule = require("../automations/midjourneyV2");
    const { captchaState, waitingQueue, workflowQueues } = midjourneyModule;

    // Get blocked profiles - no excessive logging
    if (captchaState && captchaState.size > 0) {
      for (const [profileId, state] of captchaState) {
        if (state.blocked) {
          midjourneyRequests.push({
            profileId: profileId,
            status: "blocked",
            prompt: state.lastPrompt || "N/A",
            seed: state.lastSeed || "N/A",
            blockedSince: state.since,
            timestamp: state.since,
          });
        }
      }
    }

    // Get waiting queue - no excessive logging
    if (waitingQueue && waitingQueue.size > 0) {
      for (const [profileId, queue] of waitingQueue) {
        for (let i = 0; i < queue.length; i++) {
          midjourneyRequests.push({
            profileId: profileId,
            status: "pending",
            prompt: queue[i].prompt || "Queued request",
            queuePosition: i + 1,
            timestamp: Date.now(),
          });
        }
      }
    }

    // Get workflow queues - no excessive logging
    if (workflowQueues && workflowQueues.size > 0) {
      for (const [workflowId, workflowQueue] of workflowQueues) {
        for (const item of workflowQueue) {
          midjourneyRequests.push({
            profileId: item.profileId,
            status: "processing",
            prompt: "Workflow request",
            workflowId: workflowId,
            timestamp: Date.now(),
          });
        }
      }
    }
  } catch (error) {
    // Silent error handling for performance
  }

  return {
    browsers,
    midjourney: midjourneyRequests,
    timestamp: Date.now(),
  };
}

async function getProcessMemoryUsage(pid) {
  try {
    if (process.platform === "win32") {
      const { spawn } = require("child_process");
      return new Promise((resolve) => {
        const wmic = spawn("wmic", [
          "process",
          "where",
          `ProcessId=${pid}`,
          "get",
          "WorkingSetSize",
          "/format:csv",
        ]);
        let output = "";

        wmic.stdout.on("data", (data) => {
          output += data.toString();
        });

        wmic.on("close", (code) => {
          try {
            const lines = output
              .split("\n")
              .filter(
                (line) => line.trim() && !line.includes("WorkingSetSize"),
              );
            if (lines.length > 0) {
              const workingSetSize = parseInt(lines[0].split(",")[1]) || 0;
              resolve(Math.round(workingSetSize / 1024 / 1024)); // Convert to MB
            } else {
              resolve(0);
            }
          } catch (e) {
            resolve(0);
          }
        });

        wmic.on("error", () => resolve(0));
      });
    } else {
      // For Linux/Mac, use ps command
      const { spawn } = require("child_process");
      return new Promise((resolve) => {
        const ps = spawn("ps", ["-p", pid.toString(), "-o", "rss="]);
        let output = "";

        ps.stdout.on("data", (data) => {
          output += data.toString();
        });

        ps.on("close", (code) => {
          try {
            const rss = parseInt(output.trim()) || 0;
            resolve(Math.round(rss / 1024)); // Convert KB to MB
          } catch (e) {
            resolve(0);
          }
        });

        ps.on("error", () => resolve(0));
      });
    }
  } catch (error) {
    return 0;
  }
}

async function getBrowserScreenshot(debuggingPort) {
  if (!debuggingPort) {
    throw new Error("No debugging port provided");
  }

  try {
    const client = await CDP({ port: debuggingPort });
    const { Page } = client;

    await Page.enable();

    const screenshot = await Page.captureScreenshot({
      format: "png",
      quality: 80,
    });

    await client.close();

    return screenshot.data;
  } catch (error) {
    console.error("Error capturing screenshot:", error);
    throw error;
  }
}

let openBrowser;
// Track active structure profile browsers for tab saving
const activeStructureProfiles = new Map();

// Profile rotation indices for regenerate-image handler (round-robin)
let soraRegenProfileRotationIndex = 0;
let chatgptRegenProfileRotationIndex = 0;

function registerIpcHandlers() {
  ipcMain.handle('open-external', async (_, value) => {
    const url = require('./networkPolicy').assertAllowedUrl(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Unsupported external URL');
    await shell.openExternal(url.href);
  });
  function fetchBufferFromUrl(url) {
    if (typeof fetch === "function") {
      return fetch(url).then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.arrayBuffer().then((a) => Buffer.from(a));
      });
    }
    return new Promise((resolve, reject) => {
      const lib = url.startsWith("https") ? https : http;
      lib
        .get(url, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        })
        .on("error", reject);
    });
  }

  ipcMain.handle("text-template", async (_, templateId) => {
    try {
      // Get the template from storage
      const maskTemplates = await readKey("maskTemplates");
      if (!maskTemplates || !Array.isArray(maskTemplates)) {
        return { success: false, error: "No templates found in storage" };
      }

      const template = maskTemplates.find((t) => t.id === templateId);
      if (!template) {
        return {
          success: false,
          error: `Template with id "${templateId}" not found`,
        };
      }

      // Parse template data
      let fabricJson;
      try {
        fabricJson =
          typeof template.data === "string"
            ? JSON.parse(template.data)
            : template.data;
      } catch (err) {
        return {
          success: false,
          error: "Failed to parse template data: " + (err.message || err),
        };
      }

      // Extract placeholder dimensions from template
      const placeholders = (fabricJson.objects || [])
        .filter((obj) => obj.placeholderClass === "placeholder-image")
        .map((obj) => ({
          id: obj.placeholderId,
          width: Math.round((obj.width || 800) * (obj.scaleX || 1)),
          height: Math.round((obj.height || 800) * (obj.scaleY || 1)),
        }));

      if (placeholders.length === 0) {
        return { success: false, error: "Template has no placeholder images" };
      }

      // Load custom preview settings
      const previewSettings = (await readKey("minicanvasPreviewSettings")) || {
        images: [],
        text1: "",
        text2: "",
        text3: "",
        text4: "",
      };

      // Check if user has configured custom images
      const customImages = (previewSettings.images || []).filter(
        (img) => img !== null && img !== "",
      );
      let useCustomImages = customImages.length > 0;

      // Verify custom images exist
      if (useCustomImages) {
        for (const imagePath of customImages) {
          try {
            await fs.access(imagePath);
          } catch {
            useCustomImages = false;
            break;
          }
        }
      }

      // Fallback to bundled sample food images if no custom images
      const sampleImagesDir = path.join(
        __dirname,
        "..",
        "frontend",
        "assets",
        "images",
        "samples",
      );
      const sampleFoodImages = [
        path.join(sampleImagesDir, "food1.jpg"),
        path.join(sampleImagesDir, "food2.jpg"),
        path.join(sampleImagesDir, "food3.jpg"),
        path.join(sampleImagesDir, "food4.jpg"),
      ];

      // Verify sample images exist (if using defaults)
      let useSampleImages = !useCustomImages;
      if (!useCustomImages) {
        for (const imagePath of sampleFoodImages) {
          try {
            await fs.access(imagePath);
          } catch {
            useSampleImages = false;
            break;
          }
        }
      }

      // Determine which images to use
      const sourceImages = useCustomImages ? customImages : sampleFoodImages;

      const tempDir = path.join(app.getPath("temp"), "preview_" + templateId);
      await fs.mkdir(tempDir, { recursive: true });
      const placeholderImages = [];

      // Check which image library is available
      let sharp;
      try {
        sharp = require("sharp");
      } catch (e) {
        sharp = null;
      }

      let Jimp;
      if (!sharp) {
        try {
          Jimp = require("jimp");
        } catch (e) {
          Jimp = null;
        }
      }

      if (!sharp && !Jimp) {
        return {
          success: false,
          error:
            "Neither sharp nor jimp is installed. Install one of them to enable image processing.",
        };
      }

      // Process each placeholder with matching image
      for (let i = 0; i < placeholders.length; i++) {
        const placeholder = placeholders[i];
        const targetWidth = placeholder.width;
        const targetHeight = placeholder.height;
        const targetAspectRatio = targetWidth / targetHeight;

        const outputPath = path.join(tempDir, `processed_${i + 1}.png`);

        // Use sourceImages (either custom or default samples)
        const hasImageForSlot =
          (useCustomImages || useSampleImages) && i < sourceImages.length;

        if (hasImageForSlot) {
          // Use image and crop/resize to match placeholder dimensions
          const sourceImage = sourceImages[i];

          if (sharp) {
            try {
              const metadata = await sharp(sourceImage).metadata();
              const sourceWidth = metadata.width;
              const sourceHeight = metadata.height;
              const sourceAspectRatio = sourceWidth / sourceHeight;

              let cropWidth, cropHeight, cropX, cropY;

              // Crop to match target aspect ratio
              if (sourceAspectRatio > targetAspectRatio) {
                // Source is wider - crop width
                cropHeight = sourceHeight;
                cropWidth = Math.round(sourceHeight * targetAspectRatio);
                cropX = Math.round((sourceWidth - cropWidth) / 2);
                cropY = 0;
              } else {
                // Source is taller - crop height
                cropWidth = sourceWidth;
                cropHeight = Math.round(sourceWidth / targetAspectRatio);
                cropX = 0;
                cropY = Math.round((sourceHeight - cropHeight) / 2);
              }

              // Crop and resize to exact placeholder dimensions
              await sharp(sourceImage)
                .extract({
                  left: cropX,
                  top: cropY,
                  width: cropWidth,
                  height: cropHeight,
                })
                .resize(targetWidth, targetHeight, { fit: "fill" })
                .png()
                .toFile(outputPath);

              placeholderImages.push(outputPath);
            } catch (err) {
              console.error("Sharp processing failed:", err);
              useSampleImages = false;
            }
          } else if (Jimp) {
            try {
              const image = await Jimp.read(sourceImage);
              const sourceWidth = image.getWidth();
              const sourceHeight = image.getHeight();
              const sourceAspectRatio = sourceWidth / sourceHeight;

              let cropWidth, cropHeight, cropX, cropY;

              // Crop to match target aspect ratio
              if (sourceAspectRatio > targetAspectRatio) {
                // Source is wider - crop width
                cropHeight = sourceHeight;
                cropWidth = Math.round(sourceHeight * targetAspectRatio);
                cropX = Math.round((sourceWidth - cropWidth) / 2);
                cropY = 0;
              } else {
                // Source is taller - crop height
                cropWidth = sourceWidth;
                cropHeight = Math.round(sourceWidth / targetAspectRatio);
                cropX = 0;
                cropY = Math.round((sourceHeight - cropHeight) / 2);
              }

              // Crop and resize to exact placeholder dimensions
              await image
                .crop(cropX, cropY, cropWidth, cropHeight)
                .resize(targetWidth, targetHeight)
                .writeAsync(outputPath);

              placeholderImages.push(outputPath);
            } catch (err) {
              console.error("Jimp processing failed:", err);
              useSampleImages = false;
            }
          }
        } else {
          // No image available for this slot
        }

        // Fallback: create solid color if no image available or processing failed
        if (placeholderImages.length <= i) {
          const colors = ["#E3F2FD", "#F3E5F5", "#E8F5E9", "#FFF3E0"];
          const color = colors[i % colors.length];

          if (sharp) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);

            await sharp({
              create: {
                width: targetWidth,
                height: targetHeight,
                channels: 3,
                background: { r, g, b },
              },
            })
              .png()
              .toFile(outputPath);
          } else if (Jimp) {
            const colorInt = parseInt(color.slice(1), 16) + "FF";
            const image = new Jimp(
              targetWidth,
              targetHeight,
              parseInt(colorInt, 16),
            );
            await image.writeAsync(outputPath);
          }

          placeholderImages.push(outputPath);
        }
      }

      // Use custom text from settings, or fall back to default recipe texts
      const defaultRecipeTexts = [
        {
          input_2: "Grilled Chicken Salad",
          input_3: "2 chicken breasts",
          input_4: "Fresh mixed greens",
          input_5: "Olive oil dressing",
        },
        {
          input_2: "Margherita Pizza",
          input_3: "200g pizza dough",
          input_4: "Fresh mozzarella",
          input_5: "Tomato sauce & basil",
        },
        {
          input_2: "Berry Smoothie Bowl",
          input_3: "Mixed berries",
          input_4: "1 banana",
          input_5: "Greek yogurt",
        },
        {
          input_2: "Avocado Toast",
          input_3: "1 ripe avocado",
          input_4: "Sourdough bread",
          input_5: "Cherry tomatoes",
        },
      ];

      // Check if user has custom text configured
      const hasCustomText =
        previewSettings.text1 ||
        previewSettings.text2 ||
        previewSettings.text3 ||
        previewSettings.text4;

      let inputs;
      if (hasCustomText) {
        // Use custom text from settings
        inputs = {
          input_2: previewSettings.text1 || "Sample Text 1",
          input_3: previewSettings.text2 || "Sample Text 2",
          input_4: previewSettings.text3 || "Sample Text 3",
          input_5: previewSettings.text4 || "Sample Text 4",
        };
      } else {
        // Use random default recipe text
        const randomRecipe =
          defaultRecipeTexts[
            Math.floor(Math.random() * defaultRecipeTexts.length)
          ];
        inputs = {
          input_2: randomRecipe.input_2,
          input_3: randomRecipe.input_3,
          input_4: randomRecipe.input_4,
          input_5: randomRecipe.input_5,
        };
      }

      // Generate the preview using miniCanvas
      const result = await miniCanvas(placeholderImages, templateId, inputs);

      if (result.success) {
        return { success: true, value: result.value };
      } else {
        return {
          success: false,
          error: result.value || "Failed to generate preview",
        };
      }
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle(
    "generate-ai-image",
    async (_, apiKey, prompt, size, quality) => {
      try {
        const { generateImage } = require("../automations/openai");
        const result = await generateImage(apiKey, prompt, size, quality);
        return result;
      } catch (error) {
        return {
          success: false,
          value: `Failed to generate image: ${error.message}`,
        };
      }
    },
  );

  ipcMain.handle(
    "generate-pollinations-image",
    async (_, prompt, width, height, model, negativePrompt, maxRetries) => {
      try {
        const { generatePollinationsImage } = require("../automations/openai");
        const result = await generatePollinationsImage(
          prompt,
          width,
          height,
          model,
          negativePrompt,
          maxRetries,
        );
        return result;
      } catch (error) {
        return {
          success: false,
          value: `Failed to generate image: ${error.message}`,
        };
      }
    },
  );

  // Unified image generation for Video Editor - all providers, saves to file
  ipcMain.handle("generate-ve-image", async (_, provider, prompt, options = {}) => {
    try {
      let result;
      if (provider === "dalle3") {
        const openaiKeys = readKey("openaiKeys") || {};
        const keys = Object.values(openaiKeys).filter(k => k);
        if (!keys.length) return { success: false, error: "No OpenAI API keys configured" };
        const apiKey = keys[Math.floor(Math.random() * keys.length)];
        const { generateImage } = require("../automations/openai");
        result = await generateImage(apiKey, prompt, options.size || "1024x1024", options.quality || "standard");
      } else if (provider === "gptimage") {
        const openaiKeys = readKey("openaiKeys") || {};
        const keys = Object.values(openaiKeys).filter(k => k);
        if (!keys.length) return { success: false, error: "No OpenAI API keys configured" };
        const { gptImage } = require("../automations/gptimage");
        result = await gptImage(prompt, options.model || "gpt-image-1", options.size || "1024x1024", options.quality || "standard");
      } else if (provider === "chatgptimage") {
        const { startImageRequest } = require("../automations/chatgptImage");
        result = await startImageRequest(prompt, null, options.profileId || null);
      } else if (provider === "soraimage") {
        const { soraImage } = require("../automations/soraImage");
        result = await soraImage(prompt, 1, options.size || "1024x1024", options.profileId || null);
      } else if (provider === "geminiimage") {
        const { startImageRequest } = require("../automations/geminiImage");
        result = await startImageRequest(prompt);
      } else if (provider === "midjourney") {
        const { startImageRequest } = require("../automations/midjourneyV2");
        result = await startImageRequest(prompt, options.profileId || null);
      } else {
        return { success: false, error: "Unknown provider: " + provider };
      }

      if (!result?.success) return { success: false, error: result?.value || result?.error || "Generation failed" };

      // Handle different return formats
      const value = result.value;

      // soraImage returns array of paths
      if (Array.isArray(value)) {
        return { success: true, path: value[0] };
      }

      // Already a file path (from gptImage, chatgptImage, soraImage, geminiImage, midjourney)
      if (value && typeof value === "string" && !value.startsWith("data:") && !value.startsWith("http")) {
        return { success: true, path: value };
      }

      // Save base64/URL to file
      const { moveToPermStorage } = require("./utils");
      const saveResult = await moveToPermStorage(value);
      if (saveResult.success) {
        return { success: true, path: saveResult.permanentPath };
      }
      return { success: false, error: "Failed to save image" };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("save-image", async (_, originalName, uint8Array) => {
    const userDataPath = app.getPath("userData");
    const imagesDir = path.join(userDataPath, "Images");
    await fs.mkdir(imagesDir, { recursive: true });

    // Handle both full paths (from FB Insights) and simple filenames
    const baseName = path.isAbsolute(originalName)
      ? path.basename(originalName)
      : originalName;
    const newName = baseName.replace(/(\.[^.]+)$/, "_cropped$1");
    const filePath = path.join(imagesDir, newName);

    const buffer = Buffer.from(uint8Array);
    await fs.writeFile(filePath, buffer);

    return newName;
  });

  ipcMain.handle(
    "save-automation-screenshot",
    async (_, automationId, dataUrl) => {
      const userDataPath = app.getPath("userData");
      const screenshotsDir = path.join(userDataPath, "AutomationScreenshots");
      await fs.mkdir(screenshotsDir, { recursive: true });

      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const fileName = `automation-${automationId}.png`;
      const filePath = path.join(screenshotsDir, fileName);

      await fs.writeFile(filePath, buffer);
      return fileName;
    },
  );

  // Delete automation thumbnail to allow regeneration on next workflow run
  ipcMain.handle("delete-automation-thumbnail", async (_, automationId) => {
    try {
      const userDataPath = app.getPath("userData");
      const automations = (await readKey("automations")) || [];
      const automationIndex = automations.findIndex((a) => a.id === automationId);

      if (automationIndex === -1) {
        return { success: false, error: "Automation not found" };
      }

      const automation = automations[automationIndex];
      if (!automation.thumbnail) {
        return { success: false, error: "Automation has no thumbnail" };
      }

      // Delete the thumbnail file
      const thumbnailPath = path.join(
        userDataPath,
        "AutomationThumbnails",
        automation.thumbnail
      );

      try {
        await fs.unlink(thumbnailPath);
      } catch (unlinkError) {
        console.warn(`[Thumbnail] Could not delete file: ${unlinkError.message}`);
      }

      // Remove thumbnail from automation metadata
      delete automations[automationIndex].thumbnail;
      delete automations[automationIndex].thumbnailUpdatedAt;
      await updateData("automations", automations);

      console.log(`[Thumbnail] Deleted thumbnail for automation ${automationId}`);
      return { success: true };
    } catch (error) {
      console.error(`[Thumbnail] Error deleting thumbnail:`, error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("import-automation", async (_, automationName) => {
    const result = await dialog.showOpenDialog({
      title: "Import Automation",
      filters: [
        { name: "ViralCloner Automation Files", extensions: ["vcauto"] },
      ],
      properties: ["openFile"],
    });
    if (!result.canceled) {
      const filePath = result.filePaths[0];
      try {
        const fileContent = await fs.readFile(filePath);
        const decryptedContent = decryptAutomation(fileContent);
        const automationData = JSON.parse(decryptedContent);
        const automations = (await readKey("automations")) || [];
        const timestampInSeconds = Math.floor(Date.now() / 1000);
        const randomID = generateRandomString(10);
        automations.push({
          label: automationName,
          id: randomID,
          data: automationData,
          status: "inactive",
          time: timestampInSeconds,
        });
        await updateData("automations", automations);
        
        // Log activity for automation import
        workflowDb.logActivity(
          "import",
          `Automation "${automationName}" imported`,
          "automation",
          randomID
        );
        
        return { success: true, value: null };
      } catch (err) {
        console.error("[Import Automation] Error:", err);
        return {
          success: false,
          value:
            "Failed to import automation. The file may be corrupted or from an incompatible version.",
        };
      }
    } else {
      return { success: false, value: "Dialog Canceled!" };
    }
  });

  ipcMain.handle("export-automation", async (_, automationId) => {
    const result = await dialog.showSaveDialog({
      title: "Save Automation",
      defaultPath: `viralcloner_automation_${Date.now()}.vcauto`,
      filters: [
        { name: "ViralCloner Automation Files", extensions: ["vcauto"] },
      ],
    });
    if (!result.canceled) {
      const filePath = result.filePath;
      const automations = await readKey("automations");
      const automation = automations.find((elm) => elm.id === automationId);

      if (!automation) {
        return { success: false, value: "Automation not found!" };
      }

      // Deep clone to avoid modifying the original
      const exportData = JSON.parse(JSON.stringify(automation.data));

      // Whitelist approach: ONLY preserve explicitly safe select inputs
      // All other select inputs are stripped to prevent credential leaks
      const safeSelectTitles = [
        "Model", // OpenAI model selection - safe to export
      ];

      if (exportData) {
        const stack = [exportData];
        while (stack.length) {
          const current = stack.pop();
          if (Array.isArray(current)) {
            current.forEach((item) => stack.push(item));
          } else if (current && typeof current === "object") {
            if (Array.isArray(current.inputs)) {
              current.inputs.forEach((input) => {
                // Strip ALL select inputs except whitelisted safe ones
                if (
                  input.type === "select" &&
                  !safeSelectTitles.includes(input.title)
                ) {
                  input.value = "";
                  input.options = [];
                }
              });
            }
            Object.values(current).forEach((value) => stack.push(value));
          }
        }
      }

      const automationData = encryptPortable(JSON.stringify(exportData));
      await fs.writeFile(filePath, automationData);
      return { success: true, value: null };
    } else {
      return { success: false, value: "Dialog Canceled!" };
    }
  });

  // Update all image upload nodes across all automations when credentials change
  ipcMain.handle(
    "update-automation-image-upload-nodes",
    async (_, provider, newCredentials) => {
      try {
        const automations = (await readKey("automations")) || [];
        let updatedCount = 0;
        let automationCount = 0;

        for (const automation of automations) {
          let automationUpdated = false;

          if (!automation.data?.drawflow?.Home?.data) continue;

          const nodesObject = automation.data.drawflow.Home.data;

          // Iterate through all nodes in the automation
          for (const [nodeId, node] of Object.entries(nodesObject)) {
            // Check if this is an image upload node
            if (node.name === "imageupload" && node.data?.inputs?.[0]) {
              const input = node.data.inputs[0];

              // Parse current credentials
              if (input.value && typeof input.value === "string") {
                const parts = input.value.split("|");
                const currentProvider = parts[0];

                // If this node uses the provider being updated, update its credentials
                if (currentProvider === provider) {
                  input.value = newCredentials;
                  automationUpdated = true;
                  updatedCount++;
                  console.log(
                    `Updated image upload node in automation "${automation.label}" (node ${nodeId})`,
                  );
                }
              }
            }
          }

          if (automationUpdated) {
            automationCount++;
          }
        }

        // Save updated automations back to storage
        if (updatedCount > 0) {
          await updateData("automations", automations);
          console.log(
            `✓ Updated ${updatedCount} image upload node(s) across ${automationCount} automation(s)`,
          );
        }

        return {
          success: true,
          updatedNodes: updatedCount,
          updatedAutomations: automationCount,
        };
      } catch (error) {
        console.error("Failed to update automation image upload nodes:", error);
        return {
          success: false,
          error: error.message,
        };
      }
    },
  );

  // Update all video upload nodes across all automations when credentials change
  ipcMain.handle(
    "update-automation-video-upload-nodes",
    async (_, provider, newCredentials) => {
      try {
        const automations = (await readKey("automations")) || [];
        let updatedCount = 0;
        let automationCount = 0;

        for (const automation of automations) {
          let automationUpdated = false;

          if (!automation.data?.drawflow?.Home?.data) continue;

          const nodesObject = automation.data.drawflow.Home.data;

          for (const [nodeId, node] of Object.entries(nodesObject)) {
            if (node.name === "videoupload" && node.data?.inputs?.[0]) {
              const input = node.data.inputs[0];

              if (input.value && typeof input.value === "string") {
                const parts = input.value.split("|");
                const currentProvider = parts[0];

                if (currentProvider === provider) {
                  input.value = newCredentials;
                  automationUpdated = true;
                  updatedCount++;
                  console.log(
                    `Updated video upload node in automation "${automation.label}" (node ${nodeId})`,
                  );
                }
              }
            }
          }

          if (automationUpdated) {
            automationCount++;
          }
        }

        if (updatedCount > 0) {
          await updateData("automations", automations);
          console.log(
            `✓ Updated ${updatedCount} video upload node(s) across ${automationCount} automation(s)`,
          );
        }

        return {
          success: true,
          updatedNodes: updatedCount,
          updatedAutomations: automationCount,
        };
      } catch (error) {
        console.error("Failed to update automation video upload nodes:", error);
        return {
          success: false,
          error: error.message,
        };
      }
    },
  );

  ipcMain.handle("check-chrome", async (_) => {
    // Only check for real Chrome installed on user's machine
    const systemChrome = findChromeExe();
    return { success: !!systemChrome, value: systemChrome };
  });

  ipcMain.handle("check-chromedriver", async (_) => {
    // Check if embedded ChromeDriver exists in userData
    const userDataPath = app.getPath("userData");
    const chromedriverPath = path.join(
      userDataPath,
      "chromedriver",
      "chrome.exe",
    );

    return {
      success: fss.existsSync(chromedriverPath),
      value: chromedriverPath,
    };
  });

  ipcMain.handle("download-chromedriver", async (event) => {
    const userDataPath = app.getPath("userData");
    const chromedriverDir = path.join(userDataPath, "chromedriver");
    const zipPath = path.join(chromedriverDir, "chromedriver.zip");
    const chromedriverPath = path.join(chromedriverDir, "chrome.exe");

    // Check if already exists
    if (fss.existsSync(chromedriverPath)) {
      return { success: true, message: "ChromeDriver already exists" };
    }

    await fs.mkdir(chromedriverDir, { recursive: true });

    const url =
      "https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Win_x64%2F1513012%2Fchrome-win.zip?generation=1757430837221808&alt=media";

    try {
      const response = await axios({
        method: "GET",
        url: url,
        responseType: "stream",
      });

      const totalLength = response.headers["content-length"];
      let downloadedLength = 0;

      const writer = require("fs").createWriteStream(zipPath);

      response.data.on("data", (chunk) => {
        downloadedLength += chunk.length;
        const progress = Math.round((downloadedLength / totalLength) * 100);
        event.sender.send("chromedriver-download-progress", progress);
      });

      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      // Extract the zip file using child_process (use 7zip or powershell)
      const { spawn } = require("child_process");

      // Try using PowerShell to extract
      const powershellCommand = `Expand-Archive -Path "${zipPath}" -DestinationPath "${chromedriverDir}" -Force`;

      await new Promise((resolve, reject) => {
        const ps = spawn("powershell", ["-Command", powershellCommand], {
          windowsHide: true,
        });

        ps.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`PowerShell extraction failed with code ${code}`));
          }
        });

        ps.on("error", reject);
      });

      // Find chrome.exe in extracted folder
      const extractedDir = path.join(chromedriverDir, "chrome-win");
      const extractedChromePath = path.join(extractedDir, "chrome.exe");

      if (fss.existsSync(extractedChromePath)) {
        // Move all files from extracted folder to chromedriver directory
        const files = await fs.readdir(extractedDir);
        for (const file of files) {
          const srcPath = path.join(extractedDir, file);
          const destPath = path.join(chromedriverDir, file);
          await fs.rename(srcPath, destPath);
        }

        // Clean up
        await fs.unlink(zipPath);
        await fs.rmdir(extractedDir);

        return {
          success: true,
          message: "ChromeDriver downloaded and extracted successfully",
        };
      } else {
        throw new Error("ChromeDriver executable not found in extracted files");
      }
    } catch (error) {
      console.error("Chrome download error:", error);
      return { success: false, message: `Download failed: ${error.message}` };
    }
  });

  // ==================== VCBrowser Handlers ====================

  ipcMain.handle("check-vcbrowser", async () => require("./browserDownload").status());

  ipcMain.handle("download-vcbrowser", (event) => require("./browserDownload").download(event));

  // ==================== End VCBrowser Handlers ====================

  

  // Store device ban status - prevents any login/signup on this device
  

  // Check if device is banned
  

  // Verify device ban status with server - checks if the banned account is still banned
  

  // Clear device ban (called when account is unbanned)
  

  

  // Get current user's AI usage for the month
  ipcMain.handle("get-my-ai-usage", async () => ({ success: true, disabled: true, tokenLimit: -1, totalTokens: 0, byProvider: [] }));

  

  

  

  

  ipcMain.handle("show-save-dialog", async (event, options) => {
    return await dialog.showSaveDialog(options);
  });

  ipcMain.handle("show-open-dialog", async (event, options) => {
    const result = await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle("save-file", async (event, filePath, content) => {
    try {
      await fs.writeFile(filePath, content, "utf8");
      return true;
    } catch (err) {
      console.error("Failed to save file:", err);
      return false;
    }
  });

  ipcMain.handle("export-flow-images", async (event, workflowId) => {
    try {
      const result = await exportFlowImages(workflowId, event.sender);
      return result;
    } catch (error) {
      return { error: error.message || "Unknown error" };
    }
  });

  ipcMain.handle("add-to-library", async (_, post, categoryId = null) => {
    try {
      if (!post || !post.postId) {
        return {
          success: false,
          error: "Invalid post data",
          code: "INVALID_POST",
        };
      }

      // Check for duplicates first
      const postsLibrary = (await readKey("postsLibrary")) || [];
      const existingPost = postsLibrary.find((p) => p.postId === post.postId);

      if (existingPost) {
        return {
          success: false,
          error: "Post already exists in library",
          code: "DUPLICATE_POST",
        };
      }

      // Download images locally (skip if already a local filename)
      if (post?.page?.image && post.page.image.startsWith("http")) {
        try {
          const profileImg = await downloadFileToUserData(post.page.image);
          if (profileImg) {
            post.page.image = profileImg;
          }
        } catch (downloadError) {
          console.warn("Failed to download profile image:", downloadError);
          // Continue with original image URL
        }
      }

      if (post.postImg && post.postImg.startsWith("http")) {
        try {
          const postImg = await downloadFileToUserData(post.postImg);
          if (postImg) {
            post.postImg = postImg;
          }
        } catch (downloadError) {
          console.warn("Failed to download post image:", downloadError);
          // Continue with original image URL
        }
      }

      // Add category if provided
      if (categoryId) {
        post.categoryId = categoryId;
      }

      // Add post to library
      postsLibrary.push(post);
      await updateData("postsLibrary", postsLibrary);

      // Remove the post from spyPosts (it's now in library)
      const spyPosts = (await readKey("spyPosts")) || [];
      const updatedSpyPosts = spyPosts.filter((p) => p.postId !== post.postId);
      if (updatedSpyPosts.length !== spyPosts.length) {
        await updateData("spyPosts", updatedSpyPosts);
      }

      // Mark post as added to library so it won't appear again even with viral growth
      const { addToSeenPostIds, markPostAddedToLibrary } = require("./utils");
      // Store shares for viral growth detection (in case user removes from library later)
      const sharesMap = post.shares ? { [post.postId]: post.shares } : {};
      addToSeenPostIds([post.postId], sharesMap);
      markPostAddedToLibrary(post.postId);

      // Log activity for adding post to library
      workflowDb.logActivity(
        "spy",
        `Post added to library from ${post.page?.name || post.platform || 'unknown source'}`,
        "spy",
        post.postId
      );

      return {
        success: true,
        message: "Post added to library successfully",
        postId: post.postId,
      };
    } catch (error) {
      console.error("Add to library error:", error);
      return {
        success: false,
        error: error.message || "Failed to add post to library",
        code: "UNKNOWN_ERROR",
      };
    }
  });

  // Fetch and download a Facebook page's profile picture given its URL
  ipcMain.handle("fetch-page-profile-image", async (_, pageUrl) => {
    try {
      if (!pageUrl || typeof pageUrl !== "string") {
        return { success: false, error: "Invalid page URL" };
      }

      // Extract page identifier from URL (profile.php?id=XXX or /pagename)
      let pageIdentifier = null;
      try {
        const parsed = new URL(pageUrl);
        const idParam = parsed.searchParams.get("id");
        if (idParam) {
          pageIdentifier = idParam;
        } else {
          // Get last meaningful path segment
          const segments = parsed.pathname.split("/").filter(Boolean);
          if (segments.length > 0) {
            pageIdentifier = segments[segments.length - 1];
          }
        }
      } catch {
        return { success: false, error: "Could not parse page URL" };
      }

      if (!pageIdentifier) {
        return { success: false, error: "Could not extract page identifier" };
      }

      // Try to get the profile picture via Facebook Graph redirect
      const pictureUrl = `https://graph.facebook.com/${encodeURIComponent(pageIdentifier)}/picture?type=large`;

      const localFileName = await downloadFileToUserData(pictureUrl);
      if (localFileName) {
        return { success: true, filePath: localFileName };
      }
      return { success: false, error: "Download returned empty" };
    } catch (error) {
      console.error("[FetchPageImage] Error:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Mark posts as permanently seen (will never appear in spy manager again)
  // Now accepts optional sharesMap to store shares for viral growth detection
  ipcMain.handle("mark-posts-as-seen", async (_, postIds, sharesMap = {}) => {
    try {
      if (!postIds || !Array.isArray(postIds) || postIds.length === 0) {
        return { success: false, error: "No post IDs provided" };
      }
      const { addToSeenPostIds } = require("./utils");
      addToSeenPostIds(postIds, sharesMap);
      return { success: true, count: postIds.length };
    } catch (error) {
      console.error("Mark posts as seen error:", error);
      return { success: false, error: error.message };
    }
  });

  // Hide a spy post permanently (marks as seen and removes from spyPosts)
  // Now also stores shares for viral growth detection
  ipcMain.handle("hide-spy-post", async (_, postId, shares = 0) => {
    try {
      if (!postId) {
        return { success: false, error: "No post ID provided" };
      }

      // Mark as permanently seen with shares for viral growth detection
      const { addToSeenPostIds, readKey, updateData } = require("./utils");
      const sharesMap = shares ? { [postId]: shares } : {};
      addToSeenPostIds([postId], sharesMap);

      // Remove from current spyPosts
      const spyPosts = (await readKey("spyPosts")) || [];
      const updatedSpyPosts = spyPosts.filter((p) => p.postId !== postId);
      if (updatedSpyPosts.length !== spyPosts.length) {
        await updateData("spyPosts", updatedSpyPosts);
      }

      return { success: true, postId };
    } catch (error) {
      console.error("Hide spy post error:", error);
      return { success: false, error: error.message };
    }
  });

  // Mark a spy post as used in a workflow
  ipcMain.handle("mark-spy-post-used", async (_, postId, workflowId = null) => {
    try {
      const { markSpyPostAsUsed } = require("./utils");
      const success = markSpyPostAsUsed(postId, workflowId);
      return { success };
    } catch (error) {
      console.error("Mark spy post used error:", error);
      return { success: false, error: error.message };
    }
  });

  // Reset used status for a spy post
  ipcMain.handle("reset-spy-post-used", async (_, postId) => {
    try {
      const { resetSpyPostUsedStatus } = require("./utils");
      const success = resetSpyPostUsedStatus(postId);
      return { success };
    } catch (error) {
      console.error("Reset spy post used error:", error);
      return { success: false, error: error.message };
    }
  });

  // Get spy posts with optional filtering
  ipcMain.handle("get-spy-posts-filtered", async (_, hideUsed = true) => {
    try {
      const { getSpyPostsFiltered } = require("./utils");
      const posts = getSpyPostsFiltered(hideUsed);
      return { success: true, posts };
    } catch (error) {
      console.error("Get filtered spy posts error:", error);
      return { success: false, posts: [], error: error.message };
    }
  });

  // ============ FEEDSPY Handlers ============

  // Cancellation flag for FeedSpy operations
  let feedspyCancelled = false;

  ipcMain.handle("test-feedspy-login", async (_, { email, password }) => {
    try {
      if (!email || !password) {
        return { success: false, error: "Email and password are required" };
      }
      const response = await axios.post(
        "https://feedspy.net/fr/site/emailauth/serviceId/1",
        `LoginForm%5Busername%5D=${encodeURIComponent(email)}&LoginForm%5Bpassword%5D=${encodeURIComponent(password)}`,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            Accept: "application/json, text/javascript, */*; q=0.01",
            Origin: "https://feedspy.net",
            Referer: "https://feedspy.net/fr/facebook",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          },
          timeout: 15000,
          maxRedirects: 0,
          validateStatus: (status) => status < 400,
        }
      );
      const setCookieHeaders = response.headers["set-cookie"] || [];
      let session = null;
      for (const cookie of setCookieHeaders) {
        const match = cookie.match(/session=([^;]+)/);
        if (match) {
          session = match[1];
          break;
        }
      }
      if (!session) {
        return {
          success: false,
          error: "Login failed — invalid credentials or no session returned",
        };
      }
      return { success: true, session };
    } catch (error) {
      console.error("[FEEDSPY] Login test error:", error.message);
      if (error.response && error.response.status === 401) {
        return { success: false, error: "Invalid email or password" };
      }
      return {
        success: false,
        error: error.message || "Failed to connect to FeedSpy",
      };
    }
  });

  ipcMain.handle("stop-feedspy-spy", async () => {
    feedspyCancelled = true;
    return { success: true };
  });

  ipcMain.handle(
    "start-feedspy-spy",
    async (event, { targetPages, postsPerPage, filters }) => {
      feedspyCancelled = false;
      const win = BrowserWindow.fromWebContents(event.sender);
      const minShares = (filters && filters.minShares) || 0;
      const minLikes = (filters && filters.minLikes) || 0;
      const minComments = (filters && filters.minComments) || 0;
      const minVirality = (filters && filters.minVirality) || 0;

      try {
        // Multi-account support: load accounts array (with backward compat for old single-account format)
        let accounts = readKey("feedspyAccounts");
        if (!accounts || !Array.isArray(accounts)) {
          // Migrate from old single-account format
          const oldSettings = readKey("feedspySettings");
          if (oldSettings && oldSettings.enabled && oldSettings.session) {
            accounts = [{
              id: Date.now().toString(),
              email: oldSettings.email,
              password: oldSettings.password,
              session: oldSettings.session,
              enabled: true,
            }];
          } else {
            return { success: false, error: "FeedSpy is not connected" };
          }
        }

        // Filter to only enabled accounts with sessions
        const enabledAccounts = accounts.filter(a => a.enabled && a.session);
        if (enabledAccounts.length === 0) {
          return { success: false, error: "FeedSpy is not connected" };
        }
        if (!targetPages || targetPages.length === 0) {
          return { success: false, error: "No target pages selected" };
        }

        // Round-robin account rotation
        let currentAccountIdx = 0;
        let rateLimitedAccounts = new Set();

        function getCurrentAccount() {
          return enabledAccounts[currentAccountIdx];
        }

        function rotateAccount() {
          const prevIdx = currentAccountIdx;
          currentAccountIdx = (currentAccountIdx + 1) % enabledAccounts.length;
          const acct = enabledAccounts[currentAccountIdx];
          console.log(`[FEEDSPY] Rotated account: ${acct.email} (${currentAccountIdx})`);
          return currentAccountIdx !== prevIdx;
        }

        const feedspyHeaders = {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://feedspy.net/fr/facebook",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        };

        // Helper: make authenticated request with auto re-login on session expiry + account rotation on 429
        async function feedspyRequest(url, options = {}) {
          const acct = getCurrentAccount();
          const config = {
            ...options,
            timeout: 30000,
            maxRedirects: 0,
            validateStatus: (status) => status < 400,
          };
          const mergedConfig = {
            ...config,
            headers: {
              ...feedspyHeaders,
              Cookie: `session=${acct.session}`,
              ...(options.headers || {}),
            },
          };

          try {
            return await axios(url, mergedConfig);
          } catch (err) {
            // Rate limit — try rotating to another account
            if (err.response && err.response.status === 429) {
              console.error(`[FEEDSPY] Rate limited (429) on account ${acct.email}`);
              rateLimitedAccounts.add(currentAccountIdx);

              // If all accounts are rate-limited, stop
              if (rateLimitedAccounts.size >= enabledAccounts.length) {
                console.error("[FEEDSPY] All accounts rate limited — stopping");
                const rateLimitError = new Error("FEEDSPY_RATE_LIMIT");
                rateLimitError.isRateLimit = true;
                throw rateLimitError;
              }

              // Rotate to next non-rate-limited account
              let rotated = false;
              for (let i = 0; i < enabledAccounts.length; i++) {
                rotateAccount();
                if (!rateLimitedAccounts.has(currentAccountIdx)) {
                  rotated = true;
                  break;
                }
              }
              if (!rotated) {
                const rateLimitError = new Error("FEEDSPY_RATE_LIMIT");
                rateLimitError.isRateLimit = true;
                throw rateLimitError;
              }

              // Retry with new account
              const newAcct = getCurrentAccount();
              console.log(`[FEEDSPY] Retrying with account ${newAcct.email}`);
              mergedConfig.headers.Cookie = `session=${newAcct.session}`;
              return await axios(url, mergedConfig);
            }
            // If session expired (redirect, 401, or 403), try re-login
            if (
              err.response &&
              (err.response.status === 302 || err.response.status === 401 || err.response.status === 403)
            ) {
              console.log(`[FEEDSPY] Session expired for ${acct.email}, attempting re-login...`);
              const loginResult = await reLogin(currentAccountIdx);
              if (!loginResult) throw new Error("Session expired and re-login failed");
              const refreshedAcct = getCurrentAccount();
              mergedConfig.headers.Cookie = `session=${refreshedAcct.session}`;
              return await axios(url, mergedConfig);
            }
            throw err;
          }
        }

        // Helper: re-login a specific account and update stored session
        async function reLogin(accountIdx) {
          try {
            const acct = enabledAccounts[accountIdx];
            if (!acct || !acct.email || !acct.password) return false;
            const response = await axios.post(
              "https://feedspy.net/fr/site/emailauth/serviceId/1",
              `LoginForm%5Busername%5D=${encodeURIComponent(acct.email)}&LoginForm%5Bpassword%5D=${encodeURIComponent(acct.password)}`,
              {
                headers: {
                  "Content-Type":
                    "application/x-www-form-urlencoded; charset=UTF-8",
                  "X-Requested-With": "XMLHttpRequest",
                  Accept: "application/json, text/javascript, */*; q=0.01",
                  Origin: "https://feedspy.net",
                  Referer: "https://feedspy.net/fr/facebook",
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
                },
                timeout: 15000,
                maxRedirects: 0,
                validateStatus: (status) => status < 400,
              }
            );
            const setCookieHeaders = response.headers["set-cookie"] || [];
            for (const cookie of setCookieHeaders) {
              const match = cookie.match(/session=([^;]+)/);
              if (match) {
                acct.session = match[1];
                // Persist new session to storage
                const allAccounts = readKey("feedspyAccounts") || [];
                const stored = allAccounts.find(a => a.id === acct.id);
                if (stored) {
                  stored.session = acct.session;
                  updateData("feedspyAccounts", allAccounts);
                }
                console.log(`[FEEDSPY] Re-login successful for ${acct.email}`);
                return true;
              }
            }
            return false;
          } catch (e) {
            console.error("[FEEDSPY] Re-login error:", e.message);
            return false;
          }
        }

        const totalPages = targetPages.length;
        let totalPostsFound = 0;

        for (let i = 0; i < totalPages; i++) {
          if (feedspyCancelled) {
            console.log("[FEEDSPY] Cancelled by user");
            break;
          }

          const pageUrl = targetPages[i];
          console.log(
            `[FEEDSPY] Processing page ${i + 1}/${totalPages}: ${pageUrl}`
          );

          // Send progress event
          if (win && !win.isDestroyed()) {
            win.webContents.send("spy-page-progress", {
              profileId: "feedspy",
              currentPage: i + 1,
              totalPages,
              currentPageUrl: pageUrl,
              source: "feedspy",
            });
          }

          try {
            // Step 1: Get page info from Facebook Graph via FeedSpy proxy
            const pageInfoUrl = `https://feedspy.net/fr/facebook/api?url=${encodeURIComponent(
              `https://graph.facebook.com/v7.0/?ids=${pageUrl}&fields=id,name,fan_count,followers_count`
            )}&access_token=`;

            const pageInfoRes = await feedspyRequest(pageInfoUrl);
            const pageInfoData = pageInfoRes.data;

            // The response is keyed by URL — extract the first value
            const pageInfoValues = Object.values(pageInfoData);
            if (!pageInfoValues.length || !pageInfoValues[0].id) {
              console.warn(
                `[FEEDSPY] Could not get info for page: ${pageUrl}`
              );
              continue;
            }

            const pageInfo = pageInfoValues[0];
            const pageId = pageInfo.id;
            const pageName = pageInfo.name || "Unknown Page";
            const followers =
              pageInfo.followers_count || pageInfo.fan_count || 0;
            const pageImage = `https://graph.facebook.com/${pageId}/picture?type=small`;

            // Update followed page with fresh data (followers + profile image)
            try {
              const followedPages = readKey("followedPages") || {};
              if (followedPages[pageUrl]) {
                followedPages[pageUrl].followers = followers;
                followedPages[pageUrl].name = pageName;
                // Download fresh profile image
                try {
                  const localFileName = await downloadFileToUserData(pageImage);
                  if (localFileName) {
                    followedPages[pageUrl].image = localFileName;
                  }
                } catch (imgErr) {
                  console.warn(`[FEEDSPY] Could not download profile image for ${pageName}:`, imgErr.message);
                }
                updateData("followedPages", followedPages);
                console.log(`[FEEDSPY] Updated followed page ${pageName}: ${followers} followers`);
              }
            } catch (updateErr) {
              console.warn(`[FEEDSPY] Failed to update followed page data:`, updateErr.message);
            }

            // Step 2: Add page to FeedSpy (register it)
            try {
              await feedspyRequest("https://feedspy.net/fr/facebook/addPages", {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/x-www-form-urlencoded; charset=UTF-8",
                  Origin: "https://feedspy.net",
                },
                data: `pageId=${encodeURIComponent(pageId)}&pageName=${encodeURIComponent(pageName)}&page_data%5Bid%5D=${encodeURIComponent(pageId)}&page_data%5Bname%5D=${encodeURIComponent(pageName)}&page_data%5Bphoto%5D=${encodeURIComponent(pageImage)}&page_data%5Bmembers_count%5D=${followers}`,
              });
            } catch (addErr) {
              // Page may already be added — continue anyway
              console.warn(
                `[FEEDSPY] Add page warning for ${pageName}:`,
                addErr.message
              );
            }

            if (feedspyCancelled) break;

            // Step 3: Analyse — fetch posts
            const now = Math.floor(Date.now() / 1000);
            const limit = Math.min(Math.max(postsPerPage || 50, 1), 100);

            const analyseUrl = `https://feedspy.net/fr/facebook/api?url=${encodeURIComponent(
              `https://graph.facebook.com/v7.0/${pageId}/posts?fields=id,permalink_url,from,story,message,attachments{title,type,description,url},full_picture,created_time,shares,reactions.limit(0).summary(true),comments.limit(0).summary(true)&limit=${limit}&offset=0&date_format=U&pretty=0&sdk=joey`
            )}&access_token=`;

            const analyseRes = await feedspyRequest(analyseUrl);
            const postsData = analyseRes.data;

            if (!postsData || !postsData.data || !Array.isArray(postsData.data)) {
              console.warn(
                `[FEEDSPY] No posts data for page: ${pageName}`
              );
              continue;
            }

            // Step 4: Map posts to canonical spy post format and enqueue them
            for (const post of postsData.data) {
              if (feedspyCancelled) break;

              const shares = post.shares?.count || 0;
              const reactions =
                post.reactions?.summary?.total_count || 0;
              const comments =
                post.comments?.summary?.total_count || 0;
              const createdTime =
                typeof post.created_time === "number"
                  ? post.created_time
                  : parseInt(post.created_time, 10) || 0;

              // Compute virality score
              const ageInDays = Math.max(
                (now - createdTime) / 86400,
                0.01
              );
              const viralityScore =
                followers > 0
                  ? ((shares / ageInDays) / followers) * 10000
                  : null;

              // Apply minimum threshold filters
              if (
                shares < minShares ||
                reactions < minLikes ||
                comments < minComments ||
                (minVirality > 0 && (viralityScore === null || viralityScore < minVirality))
              ) {
                continue;
              }

              // Download images locally to avoid DNS/CDN issues on some machines
              let localPostImg = "";
              if (post.full_picture) {
                try {
                  localPostImg = await downloadFileToUserData(post.full_picture);
                } catch (imgErr) {
                  console.warn(`[FEEDSPY] Could not download post image: ${imgErr.message}`);
                  localPostImg = ""; // leave empty — onerror handler will hide broken image
                }
              }

              let localPageImage = "";
              if (pageImage && pageImage.startsWith("http")) {
                try {
                  localPageImage = await downloadFileToUserData(pageImage);
                } catch (imgErr) {
                  console.warn(`[FEEDSPY] Could not download page image: ${imgErr.message}`);
                  localPageImage = ""; // leave empty — onerror handler will hide broken image
                }
              }

              const postObj = {
                type: "facebook",
                spyProfileId: "feedspy",
                postId: post.id || `feedspy_${Date.now()}_${Math.random()}`,
                postMessage: post.message || post.story || "",
                postImg: localPostImg,
                postUrl: post.permalink_url || "",
                reactions,
                shares,
                comments,
                createdTime,
                now: Math.floor(Date.now() / 1000),
                page: {
                  url: pageUrl,
                  name: pageName,
                  image: localPageImage,
                  followers,
                },
                viralityScore:
                  viralityScore !== null
                    ? parseFloat(viralityScore.toFixed(2))
                    : null,
              };

              enqueueSpyPost(postObj);
              totalPostsFound++;
            }

            console.log(
              `[FEEDSPY] Page ${pageName}: found ${postsData.data.length} posts`
            );
          } catch (pageError) {
            // Rate limit — stop all pages immediately and notify frontend
            if (pageError.isRateLimit) {
              console.error("[FEEDSPY] Rate limit hit, stopping all pages");
              if (win && !win.isDestroyed()) {
                win.webContents.send("spy-pages-completed", {
                  source: "feedspy",
                  totalPosts: totalPostsFound,
                  pagesCount: totalPages,
                  rateLimited: true,
                });
              }
              return { success: false, error: "FEEDSPY_RATE_LIMIT" };
            }
            console.error(
              `[FEEDSPY] Error processing page ${pageUrl}:`,
              pageError.message
            );
          }

          // Rotate account between pages to spread load
          if (enabledAccounts.length > 1) {
            rotateAccount();
          }

          // Small delay between pages to avoid rate limiting
          if (i < totalPages - 1 && !feedspyCancelled) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        // Send completion event
        if (win && !win.isDestroyed()) {
          win.webContents.send("spy-pages-completed", {
            source: "feedspy",
            totalPosts: totalPostsFound,
            pagesCount: totalPages,
          });
        }

        console.log(
          `[FEEDSPY] Completed. Total posts found: ${totalPostsFound}`
        );
        return { success: true, totalPosts: totalPostsFound };
      } catch (error) {
        if (error.isRateLimit) {
          return { success: false, error: "FEEDSPY_RATE_LIMIT" };
        }
        console.error("[FEEDSPY] Start spy error:", error.message);
        return { success: false, error: error.message };
      }
    }
  );

  // ============ ISE (Image Search Engine) Handlers ============

  // Search images from Google and/or Bing
  ipcMain.handle("search-images", async (_, query, options = {}) => {
    try {
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        return { success: false, error: "Invalid search query", images: [] };
      }

      const { searchImages } = require("../automations/imageSearch");
      const { getHiddenIseImageHashes, hashUrl } = require("./utils");

      const result = await searchImages(query.trim(), options);

      if (!result.success) {
        return { success: false, error: result.value, images: [] };
      }

      // Filter out hidden images
      const hiddenHashes = getHiddenIseImageHashes();
      const filteredImages = result.value.filter((img) => {
        const urlHash = hashUrl(img.url || img.thumbnail);
        return !hiddenHashes.has(urlHash);
      });

      console.log(`[ISE] Returning ${filteredImages.length} images (${result.value.length - filteredImages.length} hidden)`);

      return { success: true, images: filteredImages };
    } catch (error) {
      console.error("[ISE] Search images error:", error);
      return { success: false, error: error.message, images: [] };
    }
  });

  // Hide an ISE image permanently
  ipcMain.handle("hide-ise-image", async (_, url, source = "unknown") => {
    try {
      if (!url) {
        return { success: false, error: "No URL provided" };
      }

      const { hideIseImage } = require("./utils");
      const success = hideIseImage(url, source);

      return { success };
    } catch (error) {
      console.error("[ISE] Hide image error:", error);
      return { success: false, error: error.message };
    }
  });

  // Unhide an ISE image
  ipcMain.handle("unhide-ise-image", async (_, url) => {
    try {
      if (!url) {
        return { success: false, error: "No URL provided" };
      }

      const { unhideIseImage } = require("./utils");
      const success = unhideIseImage(url);

      return { success };
    } catch (error) {
      console.error("[ISE] Unhide image error:", error);
      return { success: false, error: error.message };
    }
  });

  // Get all hidden ISE image hashes (for client-side filtering)
  ipcMain.handle("get-hidden-ise-images", async () => {
    try {
      const { getHiddenIseImageHashes } = require("./utils");
      const hashes = getHiddenIseImageHashes();

      return { success: true, hashes: Array.from(hashes) };
    } catch (error) {
      console.error("[ISE] Get hidden images error:", error);
      return { success: false, hashes: [], error: error.message };
    }
  });

  // Clear all hidden ISE images
  ipcMain.handle("clear-hidden-ise-images", async () => {
    try {
      const { clearHiddenIseImages } = require("./utils");
      const success = clearHiddenIseImages();

      return { success };
    } catch (error) {
      console.error("[ISE] Clear hidden images error:", error);
      return { success: false, error: error.message };
    }
  });

  // Mark an ISE image as used in a workflow
  ipcMain.handle("mark-ise-image-used", async (_, url, source = "unknown") => {
    try {
      if (!url) {
        return { success: false, error: "No URL provided" };
      }

      const { markIseImageUsed } = require("./utils");
      const success = markIseImageUsed(url, source);

      return { success };
    } catch (error) {
      console.error("[ISE] Mark image used error:", error);
      return { success: false, error: error.message };
    }
  });

  // Get all used ISE image hashes
  ipcMain.handle("get-used-ise-images", async () => {
    try {
      const { getUsedIseImageHashes } = require("./utils");
      const hashes = getUsedIseImageHashes();

      return { success: true, hashes: Array.from(hashes) };
    } catch (error) {
      console.error("[ISE] Get used images error:", error);
      return { success: false, hashes: [], error: error.message };
    }
  });

  // Clear all used ISE images history
  ipcMain.handle("clear-used-ise-images", async () => {
    try {
      const { clearUsedIseImages } = require("./utils");
      const success = clearUsedIseImages();

      return { success };
    } catch (error) {
      console.error("[ISE] Clear used images error:", error);
      return { success: false, error: error.message };
    }
  });

  // Generate ISE search queries using AI
  ipcMain.handle("generate-ise-queries", async (_, { niche, language, count, provider, model }) => {
    try {
      if (!niche || !niche.trim()) {
        return { success: false, error: "Niche/topic is required" };
      }
      if (!provider || !model) {
        return { success: false, error: "AI provider and model are required" };
      }

      const prompt = `Generate ${count || 5} short image search queries for: "${niche.trim()}"

Language: ${language || "English"}

Rules:
- Maximum 3-4 words per query
- Simple, direct search terms
- No aesthetic descriptors (no "4k", "hd", "aesthetic", "high quality", etc.)
- No photography terms (no "flat lay", "studio", "natural light", etc.)
- Focus on the subject matter only

Example for "healthy drinks":
green smoothie bowl
detox water citrus
matcha latte cup
protein shake bottle
turmeric golden milk

Return ONLY the queries, one per line. No numbers, bullets, or explanations.`;

      let result;
      if (provider === "openai") {
        const { openAi } = require("../automations/openai");
        result = await openAi(null, model, prompt, 0.8);
      } else if (provider === "anthropic") {
        const { anthropic } = require("../automations/anthropic");
        result = await anthropic(model, prompt, 0.8);
      } else if (provider === "googleai") {
        const { googleAI } = require("../automations/googleai");
        result = await googleAI(model, prompt, 0.8);
      } else {
        return { success: false, error: `Unknown AI provider: ${provider}` };
      }

      if (!result.success) {
        return { success: false, error: result.value };
      }

      // Parse the response into individual queries
      const queries = result.value
        .split("\n")
        .map(q => q.trim())
        .filter(q => q.length > 0 && !q.match(/^[\d\-\*\.]+\s*/));

      console.log(`[ISE] AI generated ${queries.length} queries for niche: ${niche}`);

      return { success: true, queries };
    } catch (error) {
      console.error("[ISE] AI query generation error:", error);
      return { success: false, error: error.message };
    }
  });

  // Download an ISE image to local storage
  ipcMain.handle("download-ise-image", async (_, imageUrl) => {
    try {
      if (!imageUrl || !imageUrl.startsWith("http")) {
        return { success: false, error: "Invalid image URL" };
      }

      const { downloadImage } = require("../automations/imageSearch");
      const result = await downloadImage(imageUrl);

      return result;
    } catch (error) {
      console.error("[ISE] Download image error:", error);
      return { success: false, error: error.message };
    }
  });

  // Download multiple ISE images (batch)
  ipcMain.handle("download-ise-images", async (_, imageUrls) => {
    try {
      if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
        return { success: false, error: "No images to download", results: [] };
      }

      const { downloadImage } = require("../automations/imageSearch");
      const results = [];

      for (const url of imageUrls) {
        try {
          const result = await downloadImage(url);
          results.push({ url, ...result });
        } catch (e) {
          results.push({ url, success: false, error: e.message });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      console.log(`[ISE] Downloaded ${successCount}/${imageUrls.length} images`);

      return { success: true, results, successCount, total: imageUrls.length };
    } catch (error) {
      console.error("[ISE] Batch download error:", error);
      return { success: false, error: error.message, results: [] };
    }
  });

  // ============ Library Categories ============

  // Get all library categories
  ipcMain.handle("get-library-categories", async () => {
    try {
      const categories = (await readKey("libraryCategories")) || [];
      return { success: true, categories };
    } catch (error) {
      console.error("Get library categories error:", error);
      return { success: false, categories: [], error: error.message };
    }
  });

  // Save (create or update) a library category
  ipcMain.handle("save-library-category", async (_, category) => {
    try {
      if (!category || !category.name) {
        return { success: false, error: "Category name is required" };
      }

      const categories = (await readKey("libraryCategories")) || [];

      if (category.id) {
        // Update existing category
        const index = categories.findIndex((c) => c.id === category.id);
        if (index === -1) {
          return { success: false, error: "Category not found" };
        }
        categories[index] = {
          ...categories[index],
          ...category,
          updatedAt: new Date().toISOString(),
        };
      } else {
        // Create new category
        const newCategory = {
          id: `cat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: category.name,
          image: category.image || null, // Can be flag path or uploaded image path
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        categories.push(newCategory);
        category = newCategory; // Return the created category with ID
      }

      await updateData("libraryCategories", categories);
      return { success: true, category };
    } catch (error) {
      console.error("Save library category error:", error);
      return { success: false, error: error.message };
    }
  });

  // Delete a library category
  ipcMain.handle("delete-library-category", async (_, categoryId) => {
    try {
      if (!categoryId) {
        return { success: false, error: "Category ID is required" };
      }

      const categories = (await readKey("libraryCategories")) || [];
      const updatedCategories = categories.filter((c) => c.id !== categoryId);

      if (updatedCategories.length === categories.length) {
        return { success: false, error: "Category not found" };
      }

      await updateData("libraryCategories", updatedCategories);

      // Remove category from all posts that have it
      const postsLibrary = (await readKey("postsLibrary")) || [];
      let postsUpdated = false;
      for (const post of postsLibrary) {
        if (post.categoryId === categoryId) {
          delete post.categoryId;
          postsUpdated = true;
        }
      }
      if (postsUpdated) {
        await updateData("postsLibrary", postsLibrary);
      }

      return { success: true };
    } catch (error) {
      console.error("Delete library category error:", error);
      return { success: false, error: error.message };
    }
  });

  // Get available flag images for category icons
  ipcMain.handle("get-category-flags", async () => {
    try {
      const flagsPath = path.join(
        __dirname,
        "../",
        "frontend",
        "assets",
        "images",
        "flags",
      );
      const files = await fs.readdir(flagsPath);
      const flags = files
        .filter((f) => f.endsWith(".svg"))
        .map((f) => ({
          code: f.replace(".svg", "").toUpperCase(),
          path: `assets/images/flags/${f}`,
        }));
      return { success: true, flags };
    } catch (error) {
      console.error("Get category flags error:", error);
      return { success: false, flags: [], error: error.message };
    }
  });

  // Update post category
  ipcMain.handle("update-post-category", async (_, postId, categoryId) => {
    try {
      if (!postId) {
        return { success: false, error: "Post ID is required" };
      }

      const postsLibrary = (await readKey("postsLibrary")) || [];
      const postIndex = postsLibrary.findIndex((p) => p.postId === postId);

      if (postIndex === -1) {
        return { success: false, error: "Post not found" };
      }

      if (categoryId) {
        postsLibrary[postIndex].categoryId = categoryId;
      } else {
        delete postsLibrary[postIndex].categoryId;
      }

      await updateData("postsLibrary", postsLibrary);
      return { success: true };
    } catch (error) {
      console.error("Update post category error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-illustrations", async (_, page = 1, search = "") => {
    try {
      const PAGE_SIZE = 50;
      const ILLUSTRATIONS_PATH = path.join(
        __dirname,
        "../",
        "frontend",
        "assets",
        "images",
        "mini-canvas",
        "illustrations",
      );
      const allFiles = await fs.readdir(ILLUSTRATIONS_PATH);
      const matchedFiles = allFiles.filter(
        (file) =>
          file.endsWith(".svg") &&
          file.toLowerCase().includes(search.toLowerCase()),
      );
      const start = (page - 1) * PAGE_SIZE;
      const paginated = matchedFiles.slice(start, start + PAGE_SIZE);
      return paginated.map((file) => path.join(ILLUSTRATIONS_PATH, file));
    } catch (err) {
      console.error("Error reading illustrations:", err);
      return [];
    }
  });

  ipcMain.handle("upload-image", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select an image",
      properties: ["openFile"],
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "jpeg", "png", "gif", "webp", "svg"],
        },
      ],
    });

    if (canceled || filePaths.length === 0) return null;

    const sourcePath = filePaths[0];
    const fileName = path.basename(sourcePath);

    const dirPath = path.join(app.getPath("userData"), "Uploads", "Images");
    await fs.mkdir(dirPath, { recursive: true });

    const targetPath = path.join(dirPath, fileName);
    await fs.copyFile(sourcePath, targetPath);

    return targetPath;
  });

  // Select a single image for MiniCanvas preview settings
  ipcMain.handle("select-preview-image", async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: "Select a preview image",
        properties: ["openFile"],
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] },
        ],
      });

      if (canceled || filePaths.length === 0) {
        return { success: false, message: "No image selected" };
      }

      const sourcePath = filePaths[0];

      // Copy to userData for persistence
      const dirPath = path.join(app.getPath("userData"), "PreviewImages");
      await fs.mkdir(dirPath, { recursive: true });

      const fileName = `preview_${Date.now()}_${path.basename(sourcePath)}`;
      const targetPath = path.join(dirPath, fileName);
      await fs.copyFile(sourcePath, targetPath);

      return { success: true, path: targetPath };
    } catch (error) {
      console.error("[select-preview-image] Error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-uploads", async (_) => {
    const dirPath = path.join(app.getPath("userData"), "Uploads", "Images");
    try {
      const files = await fs.readdir(dirPath);
      const uploads = await Promise.all(
        files.map(async (file) => {
          const fullPath = path.join(dirPath, file);
          const stat = await fs.stat(fullPath);
          return {
            path: fullPath,
            mtime: stat.mtimeMs,
          };
        }),
      );
      uploads.sort((a, b) => b.mtime - a.mtime);
      return uploads.map((f) => f.path);
    } catch (err) {
      return [];
    }
  });

  ipcMain.handle("test-openai-api", async (_, apiKey) => {
    try {
      const fetch = require("node-fetch");

      // Step 1: Validate the API key by listing models (free, no tokens consumed)
      const modelsRes = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${apiKey}` },
        timeout: 15000
      });

      if (modelsRes.status === 401) {
        return { success: false, keyValid: false, billingOk: false, error: "Invalid API key" };
      }
      if (modelsRes.status === 403) {
        return { success: false, keyValid: false, billingOk: false, error: "Access denied. Check your API key permissions." };
      }
      if (!modelsRes.ok) {
        const body = await modelsRes.text().catch(() => "");
        return { success: false, keyValid: false, billingOk: false, error: `API returned status ${modelsRes.status}: ${body}` };
      }

      // Key is valid
      const modelsData = await modelsRes.json();
      if (!modelsData.data) {
        return { success: false, keyValid: false, billingOk: false, error: "Unexpected response from OpenAI" };
      }

      // Step 2: Check billing by making a minimal completion request (costs ~0.000001$)
      const completionRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }]
        }),
        timeout: 30000
      });

      if (completionRes.status === 429) {
        const errBody = await completionRes.json().catch(() => ({}));
        const errMsg = errBody?.error?.message || "";
        if (errMsg.toLowerCase().includes("quota") || errMsg.toLowerCase().includes("billing")) {
          return { success: false, keyValid: true, billingOk: false, error: "Billing issue: " + errMsg };
        }
        // Rate limited but billing is likely fine
        return { success: true, keyValid: true, billingOk: true, warning: "Rate limited, but key and billing appear valid" };
      }

      if (completionRes.status === 402) {
        return { success: false, keyValid: true, billingOk: false, error: "Payment required. Please check your OpenAI billing settings." };
      }

      if (!completionRes.ok) {
        const errBody = await completionRes.json().catch(() => ({}));
        const errMsg = errBody?.error?.message || `Status ${completionRes.status}`;
        return { success: false, keyValid: true, billingOk: false, error: errMsg };
      }

      return { success: true, keyValid: true, billingOk: true };
    } catch (error) {
      console.error("[TEST_OPENAI_API] Error:", error);
      return { success: false, keyValid: false, billingOk: false, error: error.message || "Connection failed" };
    }
  });

  ipcMain.handle("test-image-upload-api", async (_, provider, apiKey) => {
    try {
      // Create a small test image (1x1 pixel PNG)
      const testImageBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
        0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x5c, 0xc2, 0x5d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      // Create test directory and file
      const testDir = path.join(app.getPath("userData"), "temp_test");
      await fs.mkdir(testDir, { recursive: true });

      const testImagePath = path.join(testDir, "test_api_validation.png");
      await fs.writeFile(testImagePath, testImageBuffer);

      // Test the upload using the provided API credentials
      const result = await uploadImage(provider, apiKey, testImagePath);

      // Clean up test file
      try {
        await fs.unlink(testImagePath);
        await fs.rmdir(testDir);
      } catch (cleanupError) {
        console.warn("Failed to clean up test files:", cleanupError.message);
      }

      if (result.success) {
        return {
          success: true,
          message: "API test successful",
          imageUrl: result.value,
        };
      } else {
        return { success: false, message: result.value || "API test failed" };
      }
    } catch (error) {
      return { success: false, message: `API test error: ${error.message}` };
    }
  });

  ipcMain.handle("test-video-upload-api", async (_, provider, apiKey) => {
    try {
      // Create a minimal test video file (small valid MP4)
      const testDir = path.join(app.getPath("userData"), "temp_test");
      await fs.mkdir(testDir, { recursive: true });

      const testVideoPath = path.join(testDir, "test_api_validation.mp4");

      // Minimal valid MP4 file (ftyp + moov boxes)
      const ftyp = Buffer.from([
        0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D, 0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6F, 0x6D, 0x69, 0x73, 0x6F, 0x32,
        0x6D, 0x70, 0x34, 0x31
      ]);
      const moov = Buffer.from([
        0x00, 0x00, 0x00, 0x08, 0x6D, 0x6F, 0x6F, 0x76
      ]);
      await fs.writeFile(testVideoPath, Buffer.concat([ftyp, moov]));

      const result = await uploadVideo(provider, apiKey, testVideoPath);

      try {
        await fs.unlink(testVideoPath);
        await fs.rmdir(testDir);
      } catch (cleanupError) {
        console.warn("Failed to clean up test files:", cleanupError.message);
      }

      if (result.success) {
        return {
          success: true,
          message: "API test successful",
          videoUrl: result.value,
        };
      } else {
        return { success: false, message: result.value || "API test failed" };
      }
    } catch (error) {
      return { success: false, message: `API test error: ${error.message}` };
    }
  });

  ipcMain.handle("get-photos", async (_, page, query) => {
    const pexelsApi = await readKey("pexelsApi");
    if (pexelsApi) {
      const url =
        query !== ""
          ? `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=50&page=${page}`
          : `https://api.pexels.com/v1/curated?per_page=50&page=${page}`;
      const res = await fetch(url, {
        headers: { Authorization: pexelsApi },
      });
      if (res.ok) {
        const data = await res.json();
        return data.photos;
      } else {
        return false;
      }
    } else {
      return false;
    }
  });

  ipcMain.handle("get-fonts", async (_) => {
    const fontsPath = path.join(__dirname, "../", "data", "fonts.json");
    const fonts = await fs.readFile(fontsPath, "utf-8");
    return JSON.parse(fonts);
  });

  require("./textToSpeechTool").registerTextToSpeechTool({
    ipcMain, dialog, fs, ...require("../automations/textToSpeech"),
  });

  // TTS Voices
  ipcMain.handle("get-tts-voices", async () => {
    try {
      const { getTTSVoices } = require("../automations/textToSpeech");
      return await getTTSVoices();
    } catch (error) {
      console.error("[IPC] Failed to get TTS voices:", error);
      return [];
    }
  });

  // TTS Voice Preview — synthesizes a short sample and returns the file path
  ipcMain.handle("preview-tts-voice", async (event, voice, text) => {
    try {
      if (!voice || typeof voice !== "string") return { success: false, error: "No voice specified" };
      const { textToSpeech } = require("../automations/textToSpeech");
      const sampleText = (text && typeof text === "string" && text.trim()) ? text.trim() : "Hello, this is a preview of the selected voice.";
      const result = await textToSpeech(sampleText, voice, 120000);
      if (result.success) return { success: true, filePath: result.value };
      return { success: false, error: result.value };
    } catch (error) {
      console.error("[IPC] TTS preview failed:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-shapes", async (_) => {
    const dir = path.join(
      __dirname,
      "../",
      "frontend",
      "assets",
      "images",
      "mini-canvas",
      "shapes",
    );
    const files = await fs.readdir(dir);
    const svgFiles = files.filter((file) => file.endsWith(".svg"));
    return svgFiles;
  });

  ipcMain.handle("get-userdata-path", async () => {
    return app.getPath("userData");
  });

  // ========================================
  // Local Workflow Handlers
  // ========================================

  ipcMain.handle("get-app-capabilities", async () => getAppCapabilities());
  ipcMain.handle("get-stable-chrome-version", async () => getLatestChromeVersion());

  // Verify posts are saved in storage before completing workflow
  async function verifyPostsInStorage(workflowId, expectedPostIds) {
    try {
      const workflow = workflowDb.getWorkflowWithPosts(workflowId);

      if (!workflow || !Array.isArray(workflow.posts)) {
        console.error(
          `⚠️ Workflow ${workflowId} not found in storage or has no posts!`,
        );
        return { verified: 0, total: expectedPostIds.length };
      }

      let verified = 0;
      const verifiedPosts = [];
      const missingPosts = [];

      for (const postId of expectedPostIds) {
        const savedPost = workflow.posts.find((p) => p.postId === postId);
        if (
          savedPost &&
          savedPost.status === "completed" &&
          (savedPost.pinterestOutput || savedPost.facebookOutput)
        ) {
          verified++;
          verifiedPosts.push(postId);
        } else {
          missingPosts.push(postId);
        }
      }

      console.log(
        `✓ Verified ${verified}/${expectedPostIds.length} posts saved in storage`,
      );
      if (missingPosts.length > 0) {
        console.warn(`⚠️ Posts not verified in storage:`, missingPosts);
      }

      return {
        verified,
        total: expectedPostIds.length,
        verifiedPosts,
        missingPosts,
      };
    } catch (error) {
      console.error("Failed to verify posts in storage:", error);
      return {
        verified: 0,
        total: expectedPostIds.length,
        error: error.message,
      };
    }
  }

  // ========== WORKFLOW PRE-FLIGHT VALIDATION ==========
  // Validates all node requirements before starting a workflow
  ipcMain.handle(
    "validate-workflow-preflight",
    async (_, automationId, posts) => {
      try {
        console.log(`[PreFlight] Validating automation ${automationId}`);
        const errors = [];

        // Load automation data
        const automations = (await readKey("automations")) || [];
        const automation = automations.find((a) => a.id === automationId);

        if (!automation || !automation.data || !automation.data.drawflow) {
          return {
            valid: false,
            errors: [
              {
                type: "automation",
                nodeType: null,
                nodeId: null,
                message: "Automation not found or not saved",
                settingsPath: "automation",
              },
            ],
          };
        }

        const allNodes = automation.data.drawflow["Home"]?.data || {};

        // Load all storage keys needed for validation
        const [
          openaiKeys,
          anthropicKeys,
          googleaiKeys,
          openrouterKeys,
          chineseaiKeys,
          discordProfiles,
          openaiProfiles,
          googleProfiles,
          wordpressSites,
          imageUploadKeys,
          videoUploadKeys,
          maskTemplates,
          pinterestAccounts,
        ] = await Promise.all([
          readKey("openaiKeys"),
          readKey("anthropicKeys"),
          readKey("googleaiKeys"),
          readKey("openrouterKeys"),
          readKey("chineseaiKeys"),
          readKey("discordProfiles"),
          readKey("openaiProfiles"),
          readKey("googleProfiles"),
          readKey("wordpressSites"),
          readKey("imageUploadKeys"),
          readKey("videoUploadKeys"),
          readKey("maskTemplates"),
          readKey("pinterestAccounts"),
        ]);

        // Helper to count valid keys/profiles
        const countValidKeys = (keysObj) =>
          Object.keys(keysObj || {}).length;
        const countConnectedProfiles = (profilesObj) =>
          Object.values(profilesObj || {}).filter(
            (p) => p.status === "connected"
          ).length;

        // Track what input types are connected from the input node
        let inputNodeId = null;
        const connectedInputTypes = { image: false, text: false };

        // Find input node and check which outputs are connected
        for (const nodeId in allNodes) {
          const node = allNodes[nodeId];
          if (node.data?.type === "input") {
            inputNodeId = nodeId;
            if (node.outputs) {
              // output_1 is image, output_2 is text
              if (node.outputs.output_1?.connections?.length > 0) {
                connectedInputTypes.image = true;
              }
              if (node.outputs.output_2?.connections?.length > 0) {
                connectedInputTypes.text = true;
              }
            }
            break;
          }
        }

        // Validate input requirements - only check if posts were provided
        if (posts && posts.length > 0) {
          // Check if image connector is used but posts have no images
          if (connectedInputTypes.image) {
            const postsWithImages = posts.filter(
              (p) => p.postImg || p.originalInputImage
            );
            if (postsWithImages.length === 0) {
              errors.push({
                type: "input_mismatch",
                nodeType: "input",
                nodeId: inputNodeId,
                message:
                  "Image connector is used in automation but no images provided. Either provide images or edit the automation to disconnect the image connector.",
                settingsPath: null,
              });
            }
          }

          // Check if text connector is used but posts have no text
          if (connectedInputTypes.text) {
            const postsWithText = posts.filter(
              (p) => p.postMessage && p.postMessage.trim().length > 0
            );
            if (postsWithText.length === 0) {
              errors.push({
                type: "input_mismatch",
                nodeType: "input",
                nodeId: inputNodeId,
                message:
                  "Text connector is used in automation but no text provided. Either provide text or edit the automation to disconnect the text connector.",
                settingsPath: null,
              });
            }
          }
        }

        // Node type to validation mapping
        // settingsPath format: "settings#section-name" where section-name is the 'for' attribute
        // of the menu element in settings.html (e.g., for="openai-connect" -> "settings#openai-connect")
        const nodeValidations = {
          openai: {
            check: () => countValidKeys(openaiKeys) > 0,
            message: "No OpenAI API keys configured",
            settingsPath: "settings#openai-connect",
          },
          gptimage: {
            check: () => countValidKeys(openaiKeys) > 0,
            message: "No OpenAI API keys configured (required for GPT Image)",
            settingsPath: "settings#openai-connect",
          },
          anthropic: {
            check: () => countValidKeys(anthropicKeys) > 0,
            message: "No Anthropic API keys configured",
            settingsPath: "settings#anthropic-connect",
          },
          googleai: {
            check: () => countValidKeys(googleaiKeys) > 0,
            message: "No Google AI API keys configured",
            settingsPath: "settings#googleai-connect",
          },
          googleaiimage: {
            check: () => countValidKeys(googleaiKeys) > 0,
            message:
              "No Google AI API keys configured (required for Google Imagen)",
            settingsPath: "settings#googleai-connect",
          },
          openrouter: {
            check: () => countValidKeys(openrouterKeys) > 0,
            message: "No OpenRouter API keys configured",
            settingsPath: "settings#openrouter-connect",
          },
          chineseai: {
            check: () => countValidKeys(chineseaiKeys) > 0,
            message: "No Chinese AI API keys configured",
            settingsPath: "settings#chineseai-connect",
          },
          midjourney: {
            check: () => countConnectedProfiles(discordProfiles) > 0,
            message: "No connected Discord/Midjourney profiles",
            settingsPath: "settings#midjourney-connect",
          },
          chatgptimage: {
            check: () => countConnectedProfiles(openaiProfiles) > 0,
            message: "No connected ChatGPT Image profiles",
            settingsPath: "settings#openai-browser-connect",
          },
          soraimage: {
            check: () => countConnectedProfiles(openaiProfiles) > 0,
            message: "No connected OpenAI browser profiles (required for Sora Image)",
            settingsPath: "settings#openai-browser-connect",
          },
          googlesites: {
            check: (nodeData) => {
              // Check if a specific profile is selected or auto-select is used
              const selectedProfile = nodeData.data?.inputs?.find(
                (i) => i.title === "Profile"
              )?.value;
              if (selectedProfile && selectedProfile !== "") {
                // Specific profile selected - check if it exists
                return googleProfiles && googleProfiles[selectedProfile];
              }
              // Auto-select mode - need at least one connected profile
              return countConnectedProfiles(googleProfiles) > 0;
            },
            message: "No connected Google profiles",
            settingsPath: "settings#google-connect",
          },
          googledocsveo: {
            check: () => countConnectedProfiles(googleProfiles) > 0,
            message: "No connected Google profiles (required for Veo 3.1)",
            settingsPath: "settings#veo-connect",
          },
          wordpress: {
            check: (nodeData) => {
              const selectedSite = nodeData.data?.inputs?.find(
                (i) => i.title === "Website"
              )?.value;
              if (!selectedSite) {
                return false;
              }
              return wordpressSites && wordpressSites[selectedSite];
            },
            message: "No WordPress site configured or selected site not found",
            settingsPath: "settings#wordpress-connect",
          },
          wprecipemaker: {
            check: (nodeData) => {
              const selectedSite = nodeData.data?.inputs?.find(
                (i) => i.title === "Website"
              )?.value;
              if (!selectedSite) {
                return false;
              }
              return wordpressSites && wordpressSites[selectedSite];
            },
            message: "No WordPress site configured or selected site not found. WP Recipe Maker plugin must be installed.",
            settingsPath: "settings#wordpress-connect",
          },
          wordpressget: {
            check: (nodeData) => {
              const selectedSite = nodeData.data?.inputs?.find(
                (i) => i.title === "Website"
              )?.value;
              if (!selectedSite) {
                return false;
              }
              return wordpressSites && wordpressSites[selectedSite];
            },
            message: "No WordPress site configured or selected site not found",
            settingsPath: "settings#wordpress-connect",
          },
          imageupload: {
            check: (nodeData) => {
              const selectedProvider = nodeData.data?.inputs?.find(
                (i) => i.title === "Provider"
              )?.value;
              if (!selectedProvider) {
                return countValidKeys(imageUploadKeys) > 0;
              }
              // Provider value is "providerName|apiKey"
              const providerName = selectedProvider.split("|")[0];
              return imageUploadKeys && imageUploadKeys[providerName];
            },
            message: "No image upload provider configured",
            settingsPath: "settings#imgbb-connect",
          },
          videoupload: {
            check: (nodeData) => {
              const selectedProvider = nodeData.data?.inputs?.find(
                (i) => i.title === "Provider" || i.title === "Providers"
              )?.value;
              if (!selectedProvider) {
                return countValidKeys(videoUploadKeys) > 0;
              }
              const providerName = selectedProvider.split("|")[0];
              return videoUploadKeys && videoUploadKeys[providerName];
            },
            message: "No video upload provider configured",
            settingsPath: "settings#videoupload-connect",
          },
          minicanvas: {
            check: (nodeData) => {
              const selectedTemplate = nodeData.data?.inputs?.find(
                (i) => i.title === "Template"
              )?.value;
              if (!selectedTemplate) {
                return (maskTemplates || []).length > 0;
              }
              return (maskTemplates || []).some(
                (t) => t.id === selectedTemplate
              );
            },
            message:
              "No Mini Canvas template configured or selected template not found",
            settingsPath: "minicanvas",
          },
        };

        // NOTE: Pinterest account/board validation removed - it was too strict.
        // The workflow will naturally fail if Pinterest output is used without proper assignment,
        // and that's handled by the node execution itself.

        // Validate each node
        for (const nodeId in allNodes) {
          const node = allNodes[nodeId];
          const nodeType = node.data?.type;

          // Skip input/output nodes - they don't need API keys
          if (
            !nodeType ||
            nodeType === "input" ||
            nodeType === "pinterest-output" ||
            nodeType === "facebook-output"
          ) {
            continue;
          }

          const validation = nodeValidations[nodeType];
          if (validation) {
            const isValid = validation.check(node);
            if (!isValid) {
              // Avoid duplicate errors for same node type
              const alreadyReported = errors.some(
                (e) => e.nodeType === nodeType && e.message === validation.message
              );
              if (!alreadyReported) {
                errors.push({
                  type: "api_key",
                  nodeType: nodeType,
                  nodeId: nodeId,
                  message: validation.message,
                  settingsPath: validation.settingsPath,
                });
              }
            }
          }
        }

        console.log(
          `[PreFlight] Validation complete: ${errors.length} errors found`
        );

        return {
          valid: errors.length === 0,
          errors: errors,
        };
      } catch (error) {
        console.error("[PreFlight] Validation error:", error);
        return {
          valid: false,
          errors: [
            {
              type: "system",
              nodeType: null,
              nodeId: null,
              message: `Validation error: ${error.message}`,
              settingsPath: null,
            },
          ],
        };
      }
    }
  );

  ipcMain.handle(
    "execute-automation",
    async (_, workflowId, automationId, posts) => {
      console.log(
        `🚀🚀🚀 [EXECUTE DEBUG] execute-automation called for workflow ${workflowId}`,
      );
      console.log(
        `🚀🚀🚀 [EXECUTE DEBUG] Timestamp: ${new Date().toISOString()}`,
      );
      console.log(
        `🚀🚀🚀 [EXECUTE DEBUG] automationId: ${automationId}, posts count: ${posts.length}`,
      );
      console.log(
        `🚀🚀🚀 [EXECUTE DEBUG] stoppedWorkflows at start:`,
        Array.from(workflowQueue.stoppedWorkflows),
      );

      // CRITICAL: Clear stopped state UNCONDITIONALLY for reruns
      // Use type coercion to handle both string and number workflowIds
      // This must happen BEFORE any async operations to prevent race conditions
      const wfIdStr = String(workflowId);
      workflowQueue.stoppedWorkflows.delete(wfIdStr);
      workflowQueue.stoppedWorkflows.delete(parseInt(workflowId, 10));
      console.log(`🔄 [EXECUTE] Cleared stopped state for workflow ${workflowId} (both string and number forms)`);

      // CRITICAL: Ensure skip mode is set from database before processing
      // This handles race conditions where the IPC setWorkflowSkipMode might not have completed
      try {
        const workflow = workflowDb.getWorkflowWithPosts(workflowId);
        if (workflow && workflow.skipImageChoosing) {
          console.log(
            `🚀🚀🚀 [EXECUTE DEBUG] Setting skip mode from database: skipImageChoosing=${workflow.skipImageChoosing}`,
          );
          setSkipModeForWorkflow(workflowId, true);
        } else {
          console.log(
            `🚀🚀🚀 [EXECUTE DEBUG] Database skipImageChoosing=${workflow?.skipImageChoosing || false}`,
          );
        }
      } catch (dbErr) {
        console.warn(
          `[EXECUTE] Failed to check database for skipImageChoosing:`,
          dbErr.message,
        );
      }

      const window = BrowserWindow.getAllWindows()[0];
      const successfulPostIds = []; // Track successful post IDs for verification

      // Track if thumbnail has been captured for this automation during this workflow run
      let thumbnailCaptureAttempted = false;

      debugLog(`========== WORKFLOW QUEUED ==========`, {
        workflowId,
        automationId,
        postCount: posts.length,
        postIds: posts.map((p) => p.postId),
      });

      // Get automation settings from storage with defaults (declare outside try block for proper scope)
      let automationSettings;

      try {
        // Add workflow to queue and wait for execution slot
        await workflowQueue.addWorkflow(workflowId, automationId, posts);

        // Workflow is now starting execution
        debugLog(`========== WORKFLOW STARTED ==========`, {
          workflowId,
          automationId,
          postCount: posts.length,
          postIds: posts.map((p) => p.postId),
        });

        // Mark spy posts as used immediately when workflow starts (not after completion)
        const { markSpyPostAsUsed } = require("./utils");
        for (const post of posts) {
          const postIdToMark = post.originalPostId || post.postId;
          if (postIdToMark) {
            const wasMarked = markSpyPostAsUsed(postIdToMark, workflowId);
            if (wasMarked && window) {
              window.webContents.send("spy-post-marked-used", {
                postId: postIdToMark,
                workflowId: workflowId,
                markedAt: "workflow-start",
              });
              console.log(
                `[execute-automation] Marked spy post ${postIdToMark} as used at workflow start`,
              );
            }
          }
        }

        // Get automation settings from storage with defaults
        automationSettings = (await readKey("automationSettings")) || {
          maxConcurrencyWorkflows: 2,
          maxConcurrency: 10,
          nodeRetryCount: 3,
          imageUploadMaxConcurrency: 1,
        };
      } catch (error) {
        console.error("Error in workflow initialization:", error);
        // Set defaults if settings couldn't be loaded
        automationSettings = {
          maxConcurrencyWorkflows: 2,
          maxConcurrency: 10,
          nodeRetryCount: 3,
          imageUploadMaxConcurrency: 1,
        };
      }

      // Intelligent concurrency management based on system resources and user settings
      let concurrency = automationSettings.maxConcurrency;

      // Apply reasonable limits based on post count and system stability
      if (posts.length > 100 && concurrency > 15) {
        concurrency = 15; // Limit high concurrency for very large batches
        console.log(
          `Reduced concurrency to ${concurrency} for large batch (${posts.length} posts)`,
        );
      } else if (concurrency > 25) {
        concurrency = 25; // Absolute maximum to prevent system overload
        console.log(
          `Capped concurrency at ${concurrency} for system stability`,
        );
      }

      console.log(
        `Starting automation with user requested: ${automationSettings.maxConcurrency}, effective: ${concurrency}, posts: ${posts.length}`,
      );

      async function processPost(post) {
        const postStartTime = Date.now();
        try {
          // Check if workflow was stopped before starting
          console.log(
            `🔎🔎🔎 [PROCESS DEBUG] processPost checking if workflow ${workflowId} is stopped...`,
          );
          const isStopped = getStoppedWorkflowsSet().has(workflowId);
          console.log(`🔎🔎🔎 [PROCESS DEBUG] isStopped result: ${isStopped}`);
          if (isStopped) {
            console.log(
              `⏹️ Skipping post ${post.postId} - workflow ${workflowId} was stopped`,
            );
            throw new Error("Workflow stopped by user");
          }

          console.log(`🚀 Starting processing for post ${post.postId}`);
          debugLog(`Post ${post.postId}: Starting processing`, {
            workflowId,
            postId: post.postId,
            hasImage: !!post.postImg,
            hasText: !!post.postMessage,
            startTime: new Date(postStartTime).toISOString(),
          });

          const automations = await readKey("automations");
          const automation = automations.find((elm) => elm.id === automationId);
          if (!automation) {
            throw new Error(`Automation with ID ${automationId} not found`);
          }

          const nodesObject = automation.data.drawflow.Home.data;
          const cleanedAutomations = Object.entries(nodesObject).map(
            ([id, elm]) => ({
              id: elm.id,
              name: elm.name,
              data: elm.data,
              inputs: elm.inputs,
              outputs: elm.outputs,
            }),
          );

          // Handle postImg - check if it's already an absolute path or just a filename
          let imagePath = null;
          if (post.postImg) {
            if (path.isAbsolute(post.postImg)) {
              // Already an absolute path (e.g., from FB Insights)
              imagePath = post.postImg;
            } else {
              // Just a filename, prepend the Images directory
              imagePath = path.join(
                app.getPath("userData"),
                "Images",
                post.postImg,
              );
            }
          }

          const inputs = {
            image: imagePath,
            text: post.postMessage,
            url: post.postUrl || "",
          };

          const safeSendLog = (logData) => {
            // Only send to renderer if it's still alive
            if (
              window &&
              !window.isDestroyed() &&
              window.webContents &&
              !window.webContents.isDestroyed()
            ) {
              try {
                window.webContents.send("automation-logs", {
                  workflowId,
                  postId: post.postId,
                  logData,
                });
              } catch (error) {
                // Silently ignore render frame disposal errors as they're expected during window closing
                if (!error.message.includes("Render frame was disposed")) {
                  console.warn(
                    "Failed to send automation-logs:",
                    error.message,
                  );
                }
              }
            }
          };

          const result = await executeAutomation(
            workflowId,
            cleanedAutomations,
            inputs,
            safeSendLog,
            automationSettings.nodeRetryCount,
            post.postId,
          );

          // Check if workflow was stopped during execution - don't send any more logs
          if (getStoppedWorkflowsSet().has(workflowId)) {
            console.log(
              `⏹️ Post ${post.postId} completed but workflow ${workflowId} was stopped - not sending logs`,
            );
            throw new Error("Workflow stopped by user");
          }

          const resultErrorMessage =
            typeof result?.value === "string"
              ? result.value
              : result?.error?.message || result?.error || "Automation failed";

          // ===== BACKEND SAVES TO DB FIRST (authoritative) =====
          // Save post status and outputs to database BEFORE notifying frontend
          // This ensures database is always the source of truth
          try {
            if (result.success) {
              // Update post status to completed
              workflowDb.updatePostStatus(post.postId, 'completed', 100);
              
              // Save outputs (preserve images from Temp to permanent storage first)
              if (result.value?.pinterest) {
                preserveOutputImage(post.postId, result.value.pinterest);
                workflowDb.addPostOutput(post.postId, 'pinterest', result.value.pinterest);
              }
              if (result.value?.facebook) {
                preserveOutputImage(post.postId, result.value.facebook);
                workflowDb.addPostOutput(post.postId, 'facebook', result.value.facebook);
              }
              console.log(`✓ Post ${post.postId} saved to DB as completed`);
            } else {
              // Update post status to failed
              workflowDb.updatePostStatus(post.postId, 'failed', 100);
              console.log(`✓ Post ${post.postId} saved to DB as failed`);
            }
          } catch (dbError) {
            console.error(`❌ Failed to save post ${post.postId} to DB:`, dbError.message);
            // Continue anyway - we'll still notify frontend
          }

          if (result.success) {
            safeSendLog({
              status: "completed",
              nodeId: "workflow",
              nodeType: "workflow",
              message: "Workflow completed successfully",
            });
          } else {
            safeSendLog({
              status: "failed",
              nodeId: "workflow",
              nodeType: "workflow",
              message: `Workflow failed: ${resultErrorMessage}`,
            });
          }

          // Double-check workflow wasn't stopped before sending notification
          if (getStoppedWorkflowsSet().has(workflowId)) {
            console.log(
              `⏹️ Skipping final-logs for post ${post.postId} - workflow ${workflowId} was stopped`,
            );
            throw new Error("Workflow stopped by user");
          }

          // ===== NOTIFY FRONTEND (UI update only) =====
          // Send final-logs as notification - frontend should only update UI cache
          let finalLogsSent = false;
          try {
            if (
              window &&
              !window.isDestroyed() &&
              window.webContents &&
              !window.webContents.isDestroyed()
            ) {
              window.webContents.send("final-logs", {
                workflowId,
                postId: post.postId,
                result,
              });
              finalLogsSent = true;
              console.log(`✓ Final-logs notification sent for post ${post.postId}`);
            }
          } catch (error) {
            if (!error.message.includes("Render frame was disposed")) {
              console.warn(`Failed to send final-logs notification:`, error.message);
            }
            // Not critical - DB already has the data
          }

          const postEndTime = Date.now();
          const processingDuration = (postEndTime - postStartTime) / 1000; // Convert to seconds
          if (result.success) {
            console.log(
              `✅ Post ${post.postId} processed successfully in ${processingDuration.toFixed(1)} seconds`,
            );
          } else {
            console.log(
              `[FAILED] Post ${post.postId} completed with failed result in ${processingDuration.toFixed(1)} seconds: ${resultErrorMessage}`,
            );
          }

          // Note: Spy posts are now marked as used at workflow start (in execute-automation handler)
          // This ensures posts are marked immediately when workflow begins, not after completion

          // Capture automation thumbnail from first successful post with image outputs
          // Updates thumbnail on each workflow run with a randomly selected output image
          if (!thumbnailCaptureAttempted && result.success && result.value) {
            thumbnailCaptureAttempted = true; // Mark as attempted regardless of outcome
            
            try {
              // Extract image paths from the workflow outputs
              const imagePaths = extractImagePathsFromOutputs(result.value);
              
              if (imagePaths.length > 0) {
                // Randomly select one image for the thumbnail
                const randomIndex = Math.floor(Math.random() * imagePaths.length);
                const selectedImage = imagePaths[randomIndex];
                
                console.log(`[Thumbnail] Updating thumbnail for automation ${automationId} from: ${selectedImage}`);
                const thumbnailResult = await saveAutomationThumbnail(automationId, selectedImage);
                
                if (thumbnailResult.success) {
                  console.log(`[Thumbnail] Successfully saved thumbnail: ${thumbnailResult.thumbnailPath}`);
                } else {
                  console.warn(`[Thumbnail] Failed to save thumbnail: ${thumbnailResult.error}`);
                }
              } else {
                console.log(`[Thumbnail] No local image outputs found for thumbnail capture`);
              }
            } catch (thumbnailError) {
              console.error(`[Thumbnail] Error during thumbnail capture:`, thumbnailError.message);
            }
          }

          return {
            result,
            postId: post.postId,
            duration: processingDuration,
            finalLogsSent,
          };
        } catch (error) {
          const postEndTime = Date.now();
          const processingDuration = (postEndTime - postStartTime) / 1000;
          console.error(
            `❌ Post ${post.postId} failed after ${processingDuration.toFixed(1)} seconds:`,
            error.message,
          );

          // ===== BACKEND SAVES FAILURE TO DB (authoritative) =====
          try {
            workflowDb.updatePostStatus(post.postId, 'failed', 100);
            console.log(`✓ Post ${post.postId} saved to DB as failed`);
          } catch (dbError) {
            console.error(`❌ Failed to save post ${post.postId} failure to DB:`, dbError.message);
          }

          // Send error log notification
          const safeSendLog = (logData) => {
            if (
              window &&
              !window.isDestroyed() &&
              window.webContents &&
              !window.webContents.isDestroyed()
            ) {
              try {
                window.webContents.send("automation-logs", {
                  workflowId,
                  postId: post.postId,
                  logData,
                });
              } catch (sendError) {
                if (!sendError.message.includes("Render frame was disposed")) {
                  console.warn(
                    "Failed to send automation-logs:",
                    sendError.message,
                  );
                }
              }
            }
          };

          safeSendLog({
            status: "failed",
            nodeId: "workflow",
            nodeType: "workflow",
            message: `Workflow failed: ${error.message}`,
          });

          throw error; // Re-throw to be caught by the batch processor
        }
      }

      async function runInBatches(posts, batchSize) {
        const running = [];
        let completed = 0;
        let successful = 0;
        let failed = 0;
        let index = 0; // Move index inside the function to prevent race conditions
        const completedPostsSet = new Set(); // Track posts that received final-logs
        // Note: successfulPostIds is defined in parent scope for verification

        while (index < posts.length) {
          // Check if workflow was stopped - exit early
          console.log(
            `🔄🔄🔄 [BATCH DEBUG] Outer loop iteration - index: ${index}, checking if workflow ${workflowId} stopped...`,
          );
          const stoppedInOuter = getStoppedWorkflowsSet().has(workflowId);
          console.log(`🔄🔄🔄 [BATCH DEBUG] stoppedInOuter: ${stoppedInOuter}`);
          if (stoppedInOuter) {
            console.log(
              `⏹️ Workflow ${workflowId} was stopped - exiting batch processing early`,
            );
            // Mark remaining posts as failed
            failed += posts.length - index;
            completed += posts.length - index;
            break;
          }

          while (running.length < batchSize && index < posts.length) {
            // Check again before adding new post
            if (getStoppedWorkflowsSet().has(workflowId)) {
              console.log(
                `⏹️ Workflow ${workflowId} was stopped - not adding more posts`,
              );
              break;
            }

            const post = posts[index++];
            console.log(
              `📝 Adding post ${post.postId} to processing queue (${index}/${posts.length})`,
            );

            const promise = processPost(post)
              .then((processResult) => {
                completed++;
                const postSucceeded = !!processResult?.result?.success;

                if (postSucceeded) {
                  successful++;
                  successfulPostIds.push(post.postId); // Track for verification
                } else {
                  failed++;
                }

                // Track posts that successfully sent final-logs
                if (postSucceeded && processResult.finalLogsSent) {
                  completedPostsSet.add(processResult.postId);
                }

                const duration = processResult.duration
                  ? ` in ${processResult.duration.toFixed(1)}s`
                  : "";
                if (postSucceeded) {
                  console.log(
                    `✓ Post ${post.postId} completed successfully${duration} (${completed}/${posts.length})`,
                  );
                } else {
                  const failureMessage =
                    typeof processResult?.result?.value === "string"
                      ? processResult.result.value
                      : processResult?.result?.error?.message || "Automation failed";
                  console.log(
                    `✗ Post ${post.postId} failed${duration}: ${failureMessage} (${completed}/${posts.length})`,
                  );
                }
              })
              .catch((error) => {
                completed++;
                failed++;
                console.log(
                  `✗ Post ${post.postId} failed: ${error.message} (${completed}/${posts.length})`,
                );
              })
              .finally(() => {
                // Memory management removed to prevent white screen issues

                // Remove from running array
                const promiseIndex = running.indexOf(promise);
                if (promiseIndex > -1) {
                  running.splice(promiseIndex, 1);
                  console.log(
                    `🗑️ Removed post ${post.postId} from running array (${running.length} remaining)`,
                  );
                } else {
                  console.warn(
                    `⚠️ Post ${post.postId} promise not found in running array during cleanup`,
                  );
                }
              });
            running.push(promise);
            console.log(
              `📊 Running array size: ${running.length}, Batch size: ${batchSize}`,
            );
          }

          // Wait for at least one promise to complete
          if (running.length > 0) {
            await Promise.race(running);
          }

          // Add small delay between batches to prevent overwhelming the system
          if (posts.length > 10) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }

        // Wait for all remaining promises to complete
        console.log(
          `Waiting for ${running.length} remaining posts to complete...`,
        );

        // Wait for all posts to complete (no fixed timeout - captcha can block indefinitely)
        // Log progress periodically so we know the workflow is alive
        let allSettledDone = false;
        const progressTimer = setInterval(() => {
          if (allSettledDone) return;
          const elapsed = Math.round((Date.now() - workflowStartTime) / 60000);
          // Check if any Midjourney profile used by this workflow is captcha-blocked
          let captchaBlocked = false;
          try {
            const mjModule = require("../automations/midjourneyV2");
            if (mjModule.captchaState) {
              for (const [, state] of mjModule.captchaState) {
                if (state.blocked) { captchaBlocked = true; break; }
              }
            }
          } catch (_) {}
          if (captchaBlocked) {
            console.log(`⏸️ Workflow ${workflowId} waiting for captcha resolution (${elapsed}min elapsed, ${running.length} posts pending)`);
          } else {
            console.log(`⏳ Workflow ${workflowId} still processing (${elapsed}min elapsed, ${running.length} posts pending)`);
          }
        }, 5 * 60 * 1000); // Log every 5 minutes

        const workflowStartTime = Date.now();
        await Promise.allSettled(running);
        allSettledDone = true;
        clearInterval(progressTimer);

        console.log(
          `Workflow batch complete: ${successful} successful, ${failed} failed, ${completed}/${posts.length} total`,
        );

        // Verify all posts were processed
        if (completed !== posts.length) {
          console.error(
            `⚠️ PROCESSING MISMATCH: Expected ${posts.length} posts, but only processed ${completed}!`,
          );
          console.error(`Missing posts: ${posts.length - completed}`);
        } else {
          console.log(`✓ All ${posts.length} posts processed successfully`);
        }

        // Verify all successful posts received final-logs
        if (completedPostsSet.size !== successful) {
          console.error(
            `⚠️ FINAL-LOGS MISMATCH: ${successful} posts succeeded, but only ${completedPostsSet.size} received final-logs!`,
          );

          // Find which posts are missing final-logs
          const missingFinalLogs = [];
          posts.forEach((post) => {
            if (!completedPostsSet.has(post.postId)) {
              missingFinalLogs.push(post.postId);
            }
          });

          if (missingFinalLogs.length > 0) {
            console.error(`⚠️ Posts missing final-logs:`, missingFinalLogs);
            console.error(
              `⚠️ This will cause these posts to show as incomplete in the UI!`,
            );

            debugLog(`FINAL-LOGS MISMATCH DETECTED`, {
              workflowId,
              successful,
              receivedFinalLogs: completedPostsSet.size,
              missingPosts: missingFinalLogs,
            });
          }
        } else {
          console.log(
            `✓ All ${successful} successful posts received final-logs`,
          );
          debugLog(`All posts received final-logs successfully`, {
            workflowId,
            successful,
            postIds: Array.from(completedPostsSet),
          });
        }
      }

      try {
        await runInBatches(posts, concurrency);

        console.log(
          `✓ All workflow processing completed for workflow ${workflowId}`,
        );
        debugLog(`========== WORKFLOW COMPLETED ==========`, {
          workflowId,
          postCount: posts.length,
        });

        // Clear upload cache for this workflow to free memory
        clearWorkflowCache(workflowId);

        // No delay needed - backend already saved to DB directly

        // Check if workflow was manually stopped - skip all notifications if so
        const wasStoppedBeforeNotify = getStoppedWorkflowsSet().has(workflowId);
        if (wasStoppedBeforeNotify) {
          console.log(
            `🛑 Workflow ${workflowId} was manually stopped - skipping completion notifications`,
          );
          // Log activity for stopped workflow
          workflowDb.logActivity(
            "warning",
            `Workflow stopped: ${successfulPostIds.length}/${posts.length} posts completed`,
            "workflow",
            workflowId
          );
          
          // ===== BACKEND SAVES STOPPED STATUS TO DB =====
          try {
            const allPosts = workflowDb.getWorkflowPosts(workflowId);
            const completedCount = allPosts.filter(p => p.status === 'completed').length;
            const failedCount = allPosts.filter(p => p.status === 'failed').length;
            const finalProgress = Math.round((completedCount + failedCount) / allPosts.length * 100);
            workflowDb.updateWorkflowStatus(workflowId, 'stopped', finalProgress);
            console.log(`✓ Workflow ${workflowId} saved to DB as stopped (${finalProgress}%)`);
          } catch (dbError) {
            console.error(`❌ Failed to save workflow stopped status to DB:`, dbError.message);
          }
        } else {
          // ===== BACKEND SAVES WORKFLOW STATUS TO DB (authoritative) =====
          // Declare these before try so they are available for notifications after DB write.
          let finalStatus = 'completed';
          let finalProgress = 100;
          let pendingCount = 0;
          let completedCount = 0;
          let failedCount = 0;

          try {
            // Determine final workflow status based on ALL post outcomes.
            // Do not mark as completed while any posts are still pending/processing.
            const allPosts = workflowDb.getWorkflowPosts(workflowId) || [];
            failedCount = allPosts.filter(p => p.status === 'failed').length;
            completedCount = allPosts.filter(p => p.status === 'completed').length;
            pendingCount = allPosts.filter(p => p.status === 'pending' || p.status === 'processing').length;

            if (allPosts.length > 0) {
              finalProgress = Math.round(((completedCount + failedCount) / allPosts.length) * 100);
            } else {
              finalProgress = 0;
            }

            if (pendingCount > 0) {
              finalStatus = 'pending';
            } else if (failedCount === allPosts.length && allPosts.length > 0) {
              finalStatus = 'failed';
            } else {
              finalStatus = 'completed';
            }

            workflowDb.updateWorkflowStatus(workflowId, finalStatus, finalProgress);
            console.log(`✓ Workflow ${workflowId} saved to DB as ${finalStatus} (${completedCount} completed, ${failedCount} failed, ${pendingCount} pending)`);
          } catch (dbError) {
            console.error(`❌ Failed to save workflow status to DB:`, dbError.message);
          }

          if (finalStatus === 'pending') {
            workflowDb.logActivity(
              "warning",
              `Workflow still running: ${completedCount} completed, ${failedCount} failed, ${pendingCount} pending`,
              "workflow",
              workflowId
            );
          } else if (finalStatus === 'failed') {
            workflowDb.logActivity(
              "error",
              `Workflow failed: ${completedCount} completed, ${failedCount} failed`,
              "workflow",
              workflowId
            );
          } else {
            workflowDb.logActivity(
              "success",
              `Workflow completed: ${successfulPostIds.length}/${posts.length} posts successful`,
              "workflow",
              workflowId
            );
          }

          // Send completion notification only when workflow reached a terminal state.
          // If still pending, send a status change event so UI keeps showing running state.
          if (
            window &&
            !window.isDestroyed() &&
            window.webContents &&
            !window.webContents.isDestroyed()
          ) {
            try {
              if (finalStatus === 'pending') {
                window.webContents.send("workflow-status-changed", {
                  workflowId,
                  status: finalStatus,
                  reason: "finalization-detected-pending-posts",
                  timestamp: new Date().toISOString(),
                });
                console.log(`✓ Workflow status-change notification sent for workflow ${workflowId} (still pending)`)
              } else {
                window.webContents.send("workflow-completed", { workflowId, status: finalStatus, progress: finalProgress });
                console.log(`✓ Workflow completion notification sent for workflow ${workflowId} (status: ${finalStatus})`)
              }
            } catch (error) {
              // Silently ignore render frame disposal errors as they're expected during window closing
              if (!error.message.includes("Render frame was disposed")) {
                console.warn(
                  "Failed to send workflow completion/status notification:",
                  error.message,
                );
              }
            }
          }

          // Send Telegram notification for workflow completion
          telegramNotifications
            .sendNotification("workflowCompleted", {
              workflowId,
              successfulPosts: successfulPostIds.length,
              totalPosts: posts.length,
            })
            .catch((err) => {
              console.error(
                "Failed to send Telegram notification for workflow completion:",
                err,
              );
            });

          // Send system notification for workflow completion
          systemNotifications
            .sendNotification("workflowCompleted", {
              workflowId,
              successfulPosts: successfulPostIds.length,
              totalPosts: posts.length,
            })
            .catch((err) => {
              console.error(
                "Failed to send system notification for workflow completion:",
                err,
              );
            });
        }
      } catch (error) {
        console.error(`✗ Workflow ${workflowId} failed with error:`, error);
        debugLog(`========== WORKFLOW FAILED ==========`, {
          workflowId,
          error: error.message,
          stack: error.stack,
        });

        // Clear upload cache even on error to free memory
        clearWorkflowCache(workflowId);

        // Check if workflow was manually stopped - skip all notifications if so
        const wasStoppedOnError = getStoppedWorkflowsSet().has(workflowId);
        if (wasStoppedOnError) {
          console.log(
            `🛑 Workflow ${workflowId} was manually stopped - skipping error notifications`,
          );
          // Log activity for stopped workflow (error path)
          workflowDb.logActivity(
            "warning",
            `Workflow stopped during error handling`,
            "workflow",
            workflowId
          );
          
          // ===== BACKEND SAVES STOPPED STATUS TO DB (error path) =====
          try {
            const allPosts = workflowDb.getWorkflowPosts(workflowId);
            const completedCount = allPosts.filter(p => p.status === 'completed').length;
            const failedCount = allPosts.filter(p => p.status === 'failed').length;
            const finalProgress = allPosts.length > 0 ? Math.round((completedCount + failedCount) / allPosts.length * 100) : 0;
            workflowDb.updateWorkflowStatus(workflowId, 'stopped', finalProgress);
            console.log(`✓ Workflow ${workflowId} saved to DB as stopped (${finalProgress}%) [error path]`);
          } catch (dbError) {
            console.error(`❌ Failed to save workflow stopped status to DB:`, dbError.message);
          }
        } else {
          // Log activity for failed workflow
          workflowDb.logActivity(
            "error",
            `Workflow failed: ${error.message.substring(0, 100)}`,
            "workflow",
            workflowId
          );
          
          // ===== BACKEND SAVES WORKFLOW FAILURE TO DB (authoritative) =====
          try {
            workflowDb.updateWorkflowStatus(workflowId, 'failed', 100);
            console.log(`✓ Workflow ${workflowId} saved to DB as failed`);
          } catch (dbError) {
            console.error(`❌ Failed to save workflow failure to DB:`, dbError.message);
          }
          
          // Send workflow completion notification even on error (UI update only)
          if (
            window &&
            !window.isDestroyed() &&
            window.webContents &&
            !window.webContents.isDestroyed()
          ) {
            try {
              window.webContents.send("workflow-completed", {
                workflowId,
                status: isStopped ? 'stopped' : 'failed',
                progress: 100,
                error: error.message,
              });
              console.log(`✓ Workflow error notification sent for workflow ${workflowId} (status: ${isStopped ? 'stopped' : 'failed'})`)
            } catch (sendError) {
              if (!sendError.message.includes("Render frame was disposed")) {
                console.warn(
                  "Failed to send workflow error notification:",
                  sendError.message,
                );
              }
            }
          }

          // Send Telegram notification for workflow failure
          telegramNotifications
            .sendNotification("workflowFailed", {
              workflowId,
              error: error.message,
            })
            .catch((err) => {
              console.error(
                "Failed to send Telegram notification for workflow failure:",
                err,
              );
            });

          // Send system notification for workflow failure
          systemNotifications
            .sendNotification("workflowFailed", {
              workflowId,
              error: error.message,
            })
            .catch((err) => {
              console.error(
                "Failed to send system notification for workflow failure:",
                err,
              );
            });
        }
      } finally {
        // ===== SAFETY NET: Ensure workflow status is ALWAYS updated in database =====
        // This catches cases where exceptions in notifications or other code paths
        // might have prevented the status update in the try/catch blocks above
        try {
          const workflow = workflowDb.getWorkflowWithPosts(workflowId);
          if (workflow && workflow.status === 'pending') {
            // Workflow is still pending but we're in finally - it should have a final status
            console.log(`⚠️ [SAFETY NET] Workflow ${workflowId} still has status 'pending' in finally block - checking posts...`);
            
            const allPosts = workflowDb.getWorkflowPosts(workflowId);
            const wasStopped = getStoppedWorkflowsSet().has(workflowId);
            
            if (allPosts && allPosts.length > 0) {
              const pendingPosts = allPosts.filter(p => p.status === 'pending' || p.status === 'processing');
              const failedPosts = allPosts.filter(p => p.status === 'failed');
              const completedPosts = allPosts.filter(p => p.status === 'completed');
              
              // If no posts are still pending, we can determine final status
              if (pendingPosts.length === 0 || wasStopped) {
                let finalStatus;
                if (wasStopped) {
                  finalStatus = 'stopped';
                } else if (failedPosts.length === allPosts.length) {
                  finalStatus = 'failed';
                } else {
                  finalStatus = 'completed';
                }
                
                const finalProgress = Math.round((completedPosts.length + failedPosts.length) / allPosts.length * 100);
                workflowDb.updateWorkflowStatus(workflowId, finalStatus, finalProgress);
                console.log(`✓ [SAFETY NET] Workflow ${workflowId} status updated to '${finalStatus}' (${completedPosts.length} completed, ${failedPosts.length} failed)`);
                
                // Also notify frontend of the status change
                const window = BrowserWindow.getAllWindows()[0];
                if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
                  try {
                    window.webContents.send("workflow-completed", { workflowId, status: finalStatus, progress: finalProgress });
                  } catch (e) {
                    // Ignore - window may be closing
                  }
                }
              } else {
                console.log(`⚠️ [SAFETY NET] Workflow ${workflowId} still has ${pendingPosts.length} pending posts - not updating status`);
              }
            }
          }
        } catch (safetyNetError) {
          console.error(`❌ [SAFETY NET] Error checking workflow status:`, safetyNetError.message);
        }
        
        // Clean up automation-specific state (MJ queues, captcha timers, pending requests)
        // This prevents orphaned promises and state from leaking into reruns
        try {
          const { clearWorkflowStateForRerun: clearMJ } = require("../automations/midjourneyV2");
          // Use clearWorkflowStateForRerun which cleans up orphaned queue items and pending
          // requests WITHOUT marking the workflow as stopped (which would prevent dequeuing)
          clearMJ(workflowId);
        } catch (e) {
          console.warn(`[CLEANUP] MJ queue cleanup warning: ${e.message}`);
        }

        // Always remove workflow from queue when done (success or failure)
        console.log(`🏁 [Queue] Finishing workflow ${workflowId}`);
        await workflowQueue.finishWorkflow(workflowId);
      }
    },
  );

  // Get workflow queue status
  ipcMain.handle("get-workflow-queue-status", async () => {
    return workflowQueue.getQueueStatus();
  });

  // Track active test executions for stopping
  const activeTestExecutions = new Map();

  ipcMain.handle("test-automation", async (_, automationId, inputs) => {
    const testId = `test_${automationId}_${Date.now()}`;

    // Helper to send logs to frontend AND write to automation-debug.log
    const testDebugLogPath = path.join(app.getPath("userData"), "Logs", "automation-debug.log");
    const sendTestLog = (logData) => {
      const timestamp = new Date().toISOString();
      // Write to automation-debug.log file
      try {
        const event = logData.event || logData.status || 'info';
        const debugEntry = `[${timestamp}] [TEST:${event.toUpperCase()}] ${JSON.stringify({ testId, ...logData }, (key, value) => {
          if (typeof value === 'string' && value.length > 500) return value.substring(0, 500) + '... (' + value.length + ' chars)';
          return value;
        })}\n`;
        fss.appendFileSync(testDebugLogPath, debugEntry);
      } catch (e) { /* ignore */ }
      // Send to frontend
      try {
        const window = BrowserWindow.getAllWindows()[0];
        if (window && !window.isDestroyed()) {
          window.webContents.send("test-automation-log", {
            testId,
            timestamp,
            ...logData,
          });
        }
      } catch (err) {
        console.warn("Failed to send test log:", err.message);
      }
    };

    try {
      const automations = await readKey("automations");
      const automation = automations?.find((elm) => elm.id === automationId);

      if (!automation) {
        sendTestLog({
          event: "error",
          message: "Automation not found",
          nodeType: "system",
        });
        return { success: false, value: "Automation not found", testId };
      }

      if (!automation.data || !automation.data.drawflow) {
        sendTestLog({
          event: "error",
          message: "Automation has no data. Please save it first.",
          nodeType: "system",
        });
        return {
          success: false,
          value: "Automation has no data. Please save it first.",
          testId,
        };
      }

      sendTestLog({
        event: "info",
        message: "Preparing automation test...",
        nodeType: "system",
      });

      const nodesObject = automation.data.drawflow.Home.data;
      const cleanedAutomations = Object.entries(nodesObject).map(
        ([id, elm]) => ({
          id: elm.id,
          name: elm.name,
          data: elm.data,
          inputs: elm.inputs,
          outputs: elm.outputs,
        }),
      );

      // Prepare test inputs
      const testInputs = {};

      // Handle image input (base64 data URL)
      if (inputs.image) {
        sendTestLog({
          event: "info",
          message: "Processing image input...",
          nodeType: "system",
        });
        const imageBuffer = Buffer.from(inputs.image.split(",")[1], "base64");
        const tempImageName = `test_${Date.now()}.png`;
        const tempImagePath = path.join(
          app.getPath("userData"),
          "Images",
          tempImageName,
        );

        const imagesDir = path.join(app.getPath("userData"), "Images");
        if (!fss.existsSync(imagesDir)) {
          fss.mkdirSync(imagesDir, { recursive: true });
        }

        fss.writeFileSync(tempImagePath, imageBuffer);
        testInputs.image = tempImagePath;
        sendTestLog({
          event: "info",
          message: "Image saved to temporary file",
          nodeType: "system",
        });
      } else {
        testInputs.image = null;
      }

      if (inputs.text) {
        testInputs.text = inputs.text;
        sendTestLog({
          event: "info",
          message: `Text input received (${inputs.text.length} characters)`,
          nodeType: "system",
        });
      } else {
        testInputs.text = null;
      }

      if (!testInputs.image && !testInputs.text) {
        testInputs.image = null;
        testInputs.text = "";
        testInputs.url = "";
      }

      // Log node count
      const nodeCount = cleanedAutomations.length;
      sendTestLog({
        event: "info",
        message: `Starting execution of ${nodeCount} nodes...`,
        nodeType: "system",
      });

      // Enhanced log function that sends detailed logs to frontend
      const testLogFunction = (log) => {
        const enhancedLog = {
          event: log.event || "node-progress",
          nodeId: log.nodeId,
          nodeType: log.nodeType,
          nodeName: log.nodeName,
          status: log.status,
          message: log.message,
          attempt: log.attempt,
          inputs: log.inputs,
          outputs: log.outputs,
          error: log.error
            ? {
                message:
                  typeof log.error === "string"
                    ? log.error
                    : log.error.message || String(log.error),
                stack: log.error.stack,
                name: log.error.name,
              }
            : null,
        };
        sendTestLog(enhancedLog);
      };

      // Enable skip mode for Midjourney image selection during testing
      setSkipModeForWorkflow(testId, true);
      sendTestLog({
        event: "info",
        message: "Skip mode enabled for image selection",
        nodeType: "system",
      });

      // Execute automation with detailed logging
      // Use retryCount = 0 for tests - if a node fails, the test should fail immediately
      const result = await executeAutomation(
        testId,
        cleanedAutomations,
        testInputs,
        testLogFunction,
        0, // No retries in test mode
        null, // No postId in test mode
      );

      // Clean up skip mode
      setSkipModeForWorkflow(testId, false);

      // Clean up temporary image
      if (testInputs.image) {
        try {
          fss.unlinkSync(testInputs.image);
          sendTestLog({
            event: "info",
            message: "Cleaned up temporary files",
            nodeType: "system",
          });
        } catch (err) {
          console.warn("Failed to delete temporary test image:", err.message);
        }
      }

      // Send final status
      if (result.success) {
        sendTestLog({
          event: "complete",
          message: "Test completed successfully!",
          nodeType: "system",
          outputs: result.value,
        });
      } else {
        sendTestLog({
          event: "error",
          message: `Test failed: ${result.value || "Unknown error"}`,
          nodeType: "system",
          error: { message: result.value },
        });
      }

      activeTestExecutions.delete(testId);
      return { ...result, testId };
    } catch (error) {
      console.error("Test automation error:", error);
      // Clean up skip mode on error
      setSkipModeForWorkflow(testId, false);
      sendTestLog({
        event: "error",
        message: `Test error: ${error.message}`,
        nodeType: "system",
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });
      activeTestExecutions.delete(testId);
      return { success: false, value: error.message, testId };
    }
  });

  ipcMain.handle("stop-test-automation", async (_, testId) => {
    const controller = activeTestExecutions.get(testId);
    if (controller) {
      controller.abort();
      activeTestExecutions.delete(testId);
      return { success: true, message: "Test stopped" };
    }
    return { success: false, message: "Test not found" };
  });

  ipcMain.handle(
    "start-spying",
    async (_, platform, profileName, filters = {}) => {
      console.log(
        `[start-spying] Called with platform: ${platform}, profile: ${profileName}`,
      );
      try {
        // Store filters globally for this profile so restart can use them
        if (!global.spyFilters) global.spyFilters = new Map();
        global.spyFilters.set(profileName, filters);
        console.log(`[${profileName}] Spy filters set:`, filters);

        // Prevent duplicate spy browsers per profile
        if (!global.activeSpyBrowsers) global.activeSpyBrowsers = new Map();
        const existing = global.activeSpyBrowsers.get(profileName);
        if (existing && existing.process && !existing.process.killed) {
          return { status: "success", message: "Spy browser already running" };
        }

        // IMPORTANT: Close any existing browser using this profile
        // Chrome can't have two instances using the same user-data-dir
        if (global.spyProcesses && global.spyProcesses.size > 0) {
          for (const [pid, processInfo] of global.spyProcesses) {
            if (
              processInfo.profileName === profileName &&
              processInfo.process &&
              !processInfo.process.killed
            ) {
              console.log(
                `[${profileName}] Closing existing browser (PID: ${pid}, type: ${processInfo.type}) before starting spy...`,
              );
              try {
                processInfo.process.kill("SIGTERM");
                // Wait a moment for the process to terminate
                await new Promise((resolve) => setTimeout(resolve, 2000));
              } catch (e) {
                console.warn(
                  `[${profileName}] Error closing existing browser:`,
                  e.message,
                );
              }
            }
          }
        }

        const spyProfiles = await readKey("spyProfiles");
        const profile = spyProfiles?.[profileName];

        if (!profile) {
          throw new Error("Profile not found");
        }

        const proxyRaw = profile.proxy || {};
        const proxy = {
          ip: proxyRaw.ip?.trim() || "NULL",
          port: proxyRaw.port?.trim() || "NULL",
          username: proxyRaw.username?.trim() || "NULL",
          password: proxyRaw.password?.trim() || "NULL",
        };

        console.log(`[${profileName}] Starting spy browser (CDP mode)...`);

        // For now, only support Facebook - Pinterest will be added later
        if (platform !== "facebook") {
          throw new Error(
            "Currently only Facebook spying is supported with the new method",
          );
        }

        const { chromeProcess, debuggingPort } = await startSpying(
          profileName,
          proxy,
          true,
          filters,
        );

        console.log(
          `[${profileName}] Spy browser started successfully with CDP monitoring`,
        );

        // Track the Chrome process and port for management
        global.activeSpyBrowsers.set(profileName, {
          process: chromeProcess,
          port: debuggingPort,
          startedAt: Date.now(),
          method: "cdp", // Mark as CDP-based spying
        });

        // Set up exit handler for cleanup
        chromeProcess.on("exit", () => {
          const entry = global.activeSpyBrowsers.get(profileName);
          if (entry && entry.process === chromeProcess) {
            global.activeSpyBrowsers.delete(profileName);
          }
        });

        // Set openBrowser for backward compatibility with stop-spying
        openBrowser = chromeProcess;

        return { status: "success", message: "Spying started" };
      } catch (err) {
        console.error(`[${profileName}] Start spying error:`, err);
        return { status: "error", message: err.message };
      }
    },
  );

  // Track ongoing restart operations to prevent concurrent restarts
  if (!global.spyRestartLocks) {
    global.spyRestartLocks = new Map();
  }

  // Restart spying without clearing existing posts (used for auto-restart)
  ipcMain.handle(
    "restart-spying",
    async (_, platform, profileName, filters = null) => {
      try {
        // Check if a restart is already in progress for this profile
        if (global.spyRestartLocks.get(profileName)) {
          console.log(
            `[${profileName}] Restart already in progress, skipping...`,
          );
          return { status: "skipped", message: "Restart already in progress" };
        }

        // Set the lock
        global.spyRestartLocks.set(profileName, true);

        // Use provided filters or retrieve stored filters from previous start
        const activeFilters =
          filters || global.spyFilters?.get(profileName) || {};
        console.log(
          `[${profileName}] Restart spying with filters:`,
          activeFilters,
        );

        // Get profile info
        const profiles = await readKey("spyProfiles");
        if (!profiles?.[profileName]) {
          global.spyRestartLocks.delete(profileName);
          return { status: "error", message: "Profile not found" };
        }

        // Stop existing browser first (check activeSpyBrowsers)
        const existingEntry = global.activeSpyBrowsers?.get(profileName);
        if (existingEntry?.process) {
          try {
            const pid = existingEntry.process.pid;
            console.log(
              `[${profileName}] Killing existing spy process (PID: ${pid})...`,
            );
            // On Windows, use taskkill to force kill the process tree
            if (process.platform === "win32") {
              require("child_process").execSync(`taskkill /F /T /PID ${pid}`, {
                stdio: "ignore",
              });
            } else {
              existingEntry.process.kill("SIGKILL");
            }
          } catch (e) {
            console.warn(
              `[${profileName}] Error killing existing spy process:`,
              e.message,
            );
          }
          global.activeSpyBrowsers.delete(profileName);
        }

        // Also check spyProcesses for any other browser using this profile
        if (global.spyProcesses && global.spyProcesses.size > 0) {
          for (const [pid, processInfo] of global.spyProcesses) {
            if (
              processInfo.profileName === profileName &&
              processInfo.process &&
              !processInfo.process.killed
            ) {
              console.log(
                `[${profileName}] Closing existing browser (PID: ${pid}) before restart...`,
              );
              try {
                // On Windows, use taskkill to force kill the process tree
                if (process.platform === "win32") {
                  require("child_process").execSync(
                    `taskkill /F /T /PID ${pid}`,
                    { stdio: "ignore" },
                  );
                } else {
                  processInfo.process.kill("SIGKILL");
                }
              } catch (e) {
                console.warn(
                  `[${profileName}] Error closing browser:`,
                  e.message,
                );
              }
            }
          }
        }

        // Also kill any Chrome processes using this profile path (fallback)
        try {
          const userDataPath = app.getPath("userData");
          const profilePath = path
            .join(userDataPath, "profiles", profileName)
            .replace(/\\/g, "\\\\");
          if (process.platform === "win32") {
            // Find and kill Chrome processes using this profile
            require("child_process").execSync(
              `wmic process where "commandline like '%${profilePath}%'" call terminate`,
              { stdio: "ignore" },
            );
          }
        } catch (e) {
          // Ignore errors - process might not exist
        }

        // Wait for processes to terminate and profile lock to be released
        console.log(`[${profileName}] Waiting for browser cleanup...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Check and wait for profile lock to be released
        const userDataPath = app.getPath("userData");
        const profileLockPath = path.join(
          userDataPath,
          "profiles",
          profileName,
          "SingletonLock",
        );
        const profileCookieLock = path.join(
          userDataPath,
          "profiles",
          profileName,
          "Cookies-journal",
        );

        // Try to remove lock files if they exist
        for (const lockFile of [profileLockPath, profileCookieLock]) {
          try {
            if (fss.existsSync(lockFile)) {
              fss.unlinkSync(lockFile);
              console.log(`[${profileName}] Removed lock file: ${lockFile}`);
            }
          } catch (e) {
            // Lock file might be in use, wait a bit more
            console.warn(
              `[${profileName}] Could not remove lock file, waiting...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }

        // Prepare proxy
        const proxyRaw = profiles[profileName].proxy || {};
        const proxy = {
          ip: proxyRaw.ip?.trim() || "NULL",
          port: proxyRaw.port?.trim() || "NULL",
          username: proxyRaw.username?.trim() || "NULL",
          password: proxyRaw.password?.trim() || "NULL",
        };

        console.log(
          `[${profileName}] Restarting spy browser (preserving posts)...`,
        );

        // Start spying with clearPosts = false to preserve existing posts, and pass filters
        const { chromeProcess, debuggingPort } = await startSpying(
          profileName,
          proxy,
          false,
          activeFilters,
        );

        console.log(`[${profileName}] Spy browser restarted successfully`);

        // Track the Chrome process and port for management
        global.activeSpyBrowsers.set(profileName, {
          process: chromeProcess,
          port: debuggingPort,
          startedAt: Date.now(),
          method: "cdp",
        });

        chromeProcess.on("exit", () => {
          const entry = global.activeSpyBrowsers.get(profileName);
          if (entry && entry.process === chromeProcess) {
            global.activeSpyBrowsers.delete(profileName);
          }
        });

        openBrowser = chromeProcess;

        // Release the lock
        global.spyRestartLocks.delete(profileName);

        return { status: "success", message: "Spying restarted" };
      } catch (err) {
        // Release the lock on error
        global.spyRestartLocks.delete(profileName);
        console.error(`[${profileName}] Restart spying error:`, err);
        return { status: "error", message: err.message };
      }
    },
  );

  ipcMain.handle("stop-spying", async (_, platform, profileName, reason = "unknown") => {
    // If profileName is provided, only stop that specific profile's browser
    if (profileName) {
      console.log(`[stop-spying] Stopping spy browser for profile: ${profileName} (reason: ${reason})`);
      
      // Check activeSpyBrowsers for this profile
      if (global.activeSpyBrowsers && global.activeSpyBrowsers.has(profileName)) {
        const browserInfo = global.activeSpyBrowsers.get(profileName);
        if (browserInfo.process && !browserInfo.process.killed) {
          try {
            browserInfo.process.kill("SIGTERM");
            console.log(`[stop-spying] Killed browser for profile: ${profileName}`);
          } catch (e) {
            console.warn(`[stop-spying] Error killing browser for ${profileName}:`, e.message);
          }
        }
        global.activeSpyBrowsers.delete(profileName);
      }
      
      // Also check legacy openBrowser if it matches (for backward compatibility)
      if (openBrowser && !openBrowser.killed && global.currentSpyProfile === profileName) {
        try {
          openBrowser.kill("SIGTERM");
          console.log("[stop-spying] Killed legacy openBrowser");
        } catch (e) {
          console.warn("[stop-spying] Error killing openBrowser:", e.message);
        }
        openBrowser = null;
        global.currentSpyProfile = null;
      }
      
      console.log(`[stop-spying] Spy browser stopped for profile: ${profileName}`);
      
      // Notify frontend that spy was stopped
      const { BrowserWindow } = require("electron");
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send("spy-stopped", {
          profileId: profileName,
          reason: reason
        });
      }
      
      return { status: "success" };
    }
    
    // No profileName provided - stop ALL spy browsers (legacy behavior)
    console.log("[stop-spying] Stopping all spy browsers...");

    // Kill the openBrowser reference (legacy)
    if (openBrowser && !openBrowser.killed) {
      try {
        openBrowser.kill("SIGTERM");
        console.log("[stop-spying] Killed openBrowser");
      } catch (e) {
        console.warn("[stop-spying] Error killing openBrowser:", e.message);
      }
    }
    openBrowser = null;

    // Kill all browsers in activeSpyBrowsers map
    if (global.activeSpyBrowsers && global.activeSpyBrowsers.size > 0) {
      console.log(
        `[stop-spying] Killing ${global.activeSpyBrowsers.size} active spy browsers...`,
      );
      for (const [profileName, browserInfo] of global.activeSpyBrowsers) {
        if (browserInfo.process && !browserInfo.process.killed) {
          try {
            browserInfo.process.kill("SIGTERM");
            console.log(
              `[stop-spying] Killed browser for profile: ${profileName}`,
            );
          } catch (e) {
            console.warn(
              `[stop-spying] Error killing browser for ${profileName}:`,
              e.message,
            );
          }
        }
      }
      global.activeSpyBrowsers.clear();
    }

    // Kill all processes in spyProcesses map
    if (global.spyProcesses && global.spyProcesses.size > 0) {
      console.log(
        `[stop-spying] Killing ${global.spyProcesses.size} spy processes...`,
      );
      for (const [pid, processInfo] of global.spyProcesses) {
        if (processInfo.process && !processInfo.process.killed) {
          try {
            processInfo.process.kill("SIGTERM");
            console.log(`[stop-spying] Killed process PID: ${pid}`);
          } catch (e) {
            console.warn(`[stop-spying] Error killing PID ${pid}:`, e.message);
          }
        }
      }
      global.spyProcesses.clear();
    }

    // Wait a moment for graceful termination
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Force kill any remaining tracked processes that didn't terminate gracefully
    // NOTE: Do NOT use taskkill /IM chrome.exe as it kills ALL Chrome instances including user's personal browser
    if (global.spyProcesses && global.spyProcesses.size > 0) {
      for (const [pid, processInfo] of global.spyProcesses) {
        if (processInfo.process && !processInfo.process.killed) {
          try {
            processInfo.process.kill("SIGKILL");
            console.log(`[stop-spying] Force killed process PID: ${pid}`);
          } catch (e) {
            // Process may have already exited
          }
        }
      }
      global.spyProcesses.clear();
    }

    console.log("[stop-spying] All spy browsers stopped");
    return { status: "success" };
  });

  // Simple diagnostic: start a plain Chrome, no extensions, no proxy
  ipcMain.handle("start-bare-chrome", async (_, profileName = "diagnostic") => {
    try {
      const { chromeProcess } = await startBareChrome(profileName, false);
      openBrowser = chromeProcess;
      return { status: "success" };
    } catch (err) {
      return { status: "error", message: err.message };
    }
  });

  ipcMain.handle("test-profile-login", async (_, platform, profileName) => {
    try {
      // Add timeout to prevent hanging (30 seconds)
      const status = await withTimeout(
        trackLoginStatus(platform, profileName),
        30000,
      );
      return status;
    } catch (err) {
      console.error("Error in test-profile-login:", err);

      // Ensure we always return a string response
      return err.message.includes("timed out") ? "timeout" : "error";
    }
  });

  // Cancel an ongoing test profile login
  ipcMain.handle("cancel-test-profile-login", async () => {
    try {
      cancelTestLogin();
      return { success: true };
    } catch (err) {
      console.error("Error cancelling test-profile-login:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.on("window:minimize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window.minimize();
  });

  ipcMain.on("window:maximize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window.maximize();
  });

  ipcMain.on("window:toggle-max", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  // Get app close status - checks for running workflows, spy processes, etc.
  ipcMain.handle("get-app-close-status", async () => {
    const warnings = [];
    
    // Check for running/queued workflows
    try {
      const queueStatus = workflowQueue.getQueueStatus();
      const runningCount = queueStatus.running?.length || 0;
      const queuedCount = queueStatus.queued?.length || 0;
      
      if (runningCount > 0) {
        warnings.push({ type: 'workflows', count: runningCount, status: 'running' });
      }
      if (queuedCount > 0) {
        warnings.push({ type: 'workflows', count: queuedCount, status: 'queued' });
      }
    } catch (e) {
      console.warn('[get-app-close-status] Error checking workflow queue:', e.message);
    }
    
    // Check for active spy browsers
    try {
      if (global.activeSpyBrowsers && global.activeSpyBrowsers.size > 0) {
        warnings.push({ type: 'spy', count: global.activeSpyBrowsers.size });
      }
    } catch (e) {
      console.warn('[get-app-close-status] Error checking spy browsers:', e.message);
    }
    
    return { warnings };
  });

  // Force close without confirmation
  ipcMain.on("window:force-close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
      window.destroy(); // Use destroy() to bypass any close handlers
    }
  });

  ipcMain.on("window:close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window.close();
  });

  // Restart the entire application (used for language change)
  ipcMain.on("window:reload", () => {
    app.relaunch();
    app.exit(0);
  });

  // Dev tools - Allow in development mode or beta builds
  ipcMain.on("window:open-devtools", (event) => {
    // Allow in development mode OR beta builds
    const isDev = !app.isPackaged;
    if (isDev || isBeta) {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) {
        window.webContents.openDevTools();
      }
    } else {
      console.warn("[Security] DevTools access blocked in production");
    }
  });

  // Reload only the renderer in development; do not restart the main process.
  ipcMain.on("window:refresh-frontend", (event) => {
    if (!app.isPackaged) {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) window.webContents.reloadIgnoringCache();
    } else {
      console.warn("[Security] Frontend refresh control blocked in production");
    }
  });

  // Check if running in development mode (unpackaged)
  // Returns true only when NOT compiled/packaged (development only)
  ipcMain.handle("is-dev", () => {
    return !app.isPackaged;
  });

  ipcMain.handle("read-key", (_, key) => {
    return readKey(key);
  });

  ipcMain.handle("update-data", async (_, key, value) => {
    // Structure profiles are the Facebook accounts used by FB Groups. Detect
    // actual account deletion here (not a simple unlink from one group) so the
    // durable avatar/cover cache follows the account's lifecycle.
    let deletedStructureProfileIds = [];
    if (key === "structures") {
      const previous = (await readKey("structures")) || {};
      const collectIds = (structures) => new Set(
        Object.values(structures || {}).flatMap((structure) =>
          Object.keys((structure && structure.profiles) || {}),
        ),
      );
      const previousIds = collectIds(previous);
      const nextIds = collectIds(value);
      deletedStructureProfileIds = [...previousIds].filter((id) => !nextIds.has(id));
    }

    const result = await updateData(key, value);

    if (deletedStructureProfileIds.length) {
      const imageStore = require("./facebookGroupsImageStore");
      const groupsDb = require("./facebookGroupsDatabase");
      await Promise.all(deletedStructureProfileIds.map(async (profileId) => {
        groupsDb.deleteProfileScan(profileId);
        await imageStore.removeProfileImages(profileId);
      }));
    }

    return result;
  });

  // Mailboxes: all credentials and message bodies stay in the main process.
  // The renderer receives only redacted mailbox metadata and decrypted data required
  // for the active reader view.
  const mailboxResult = async (operation) => {
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      return { success: false, error: mailboxUserError(error), reason: mailboxErrorReason(error) };
    }
  };

  ipcMain.handle("mailboxes-list", (_, options) =>
    mailboxResult(() => getMailboxManager().listMailboxes(options || {})),
  );
  ipcMain.handle("mailboxes-all", () =>
    mailboxResult(() => getMailboxManager().listMailboxIds()),
  );
  ipcMain.handle("mailboxes-total-unread", () =>
    mailboxResult(() => getMailboxManager().getTotalUnreadCount()),
  );
  ipcMain.handle("mailboxes-get", (_, mailboxId) =>
    mailboxResult(() => getMailboxManager().getMailbox(mailboxId)),
  );
  ipcMain.handle("mailboxes-test", (_, config, mailboxId = null) =>
    mailboxResult(() => getMailboxManager().testConfig(config || {}, mailboxId)),
  );
  ipcMain.handle("mailboxes-save", (_, config, testToken, mailboxId = null) =>
    mailboxResult(() => getMailboxManager().saveMailbox(config || {}, testToken, mailboxId)),
  );
  ipcMain.handle("mailboxes-delete", (_, mailboxId) =>
    mailboxResult(() => getMailboxManager().deleteMailbox(mailboxId)),
  );
  ipcMain.handle("mailboxes-clear-cache", (_, mailboxId) =>
    mailboxResult(() => getMailboxManager().clearCache(mailboxId)),
  );
  ipcMain.handle("mailboxes-reset-unread", (_, mailboxId) =>
    mailboxResult(() => getMailboxManager().resetUnreadCount(mailboxId)),
  );
  ipcMain.handle("mailboxes-folders", (_, mailboxId, refresh = false) =>
    mailboxResult(() => getMailboxManager().getFolders(mailboxId, Boolean(refresh))),
  );
  ipcMain.handle("mailboxes-refresh", (_, mailboxId, options) =>
    mailboxResult(() => getMailboxManager().refreshMailbox(mailboxId, options || {})),
  );
  ipcMain.handle("mailboxes-messages", (_, mailboxId, folderPath, options) =>
    mailboxResult(() => getMailboxManager().getMessages(mailboxId, folderPath, options || {})),
  );
  ipcMain.handle("mailboxes-message", (_, mailboxId, messageId) =>
    mailboxResult(() => getMailboxManager().getMessage(mailboxId, messageId)),
  );
  ipcMain.handle("mailboxes-update-flags", (_, mailboxId, messageIds, changes) =>
    mailboxResult(() => getMailboxManager().updateFlags(mailboxId, messageIds, changes || {})),
  );
  ipcMain.handle("mailboxes-move", (_, mailboxId, messageIds, destination) =>
    mailboxResult(() => getMailboxManager().moveMessages(mailboxId, messageIds, destination)),
  );
  ipcMain.handle("mailboxes-delete-messages", (_, mailboxId, messageIds, permanent = false) =>
    mailboxResult(() => getMailboxManager().deleteMessages(mailboxId, messageIds, Boolean(permanent))),
  );
  ipcMain.handle("mailboxes-download-attachment", (_, mailboxId, messageId, attachmentIndex, destination) =>
    mailboxResult(() => getMailboxManager().downloadAttachment(mailboxId, messageId, attachmentIndex, destination)),
  );
  ipcMain.handle("mailboxes-start-batch", (event, type, mailboxIds) =>
    mailboxResult(() => getMailboxManager().startBatch(type === "test" ? "test" : "refresh", mailboxIds, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("mailboxes-job-progress", progress);
    })),
  );
  ipcMain.handle("mailboxes-cancel-batch", (_, jobId) =>
    mailboxResult(() => getMailboxManager().cancelBatch(jobId)),
  );

  

  ipcMain.handle("mailboxes-outlook-start", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  ipcMain.handle("mailboxes-outlook-poll", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get system locale for i18n
  ipcMain.handle("get-system-locale", () => {
    return app.getLocale();
  });

  // Get available locale countries for browser language settings
  ipcMain.handle("get-available-locale-countries", () => {
    return getAvailableLocaleCountries();
  });

  // Get detected user country code from IP
  ipcMain.handle("get-detected-country", async () => {
    return await getUserCountryCode();
  });

  ipcMain.handle("test-proxy", async (event, proxyData) => {
    const { ip, port, username, password } = proxyData;
    const https = require('https');

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Build proxy config for axios native proxy support
        const proxyConfig = {
          host: ip,
          port: parseInt(port),
          protocol: 'http',
        };
        
        if (username && password) {
          proxyConfig.auth = {
            username: username,
            password: password,
          };
        }

        // Get the proxy IP address
        const ipResponse = await axios.get("https://api.ipify.org?format=json", {
          proxy: proxyConfig,
          timeout: 15000,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        });
        const realIp = ipResponse.data.ip;
        
        // Get geo data WITHOUT proxy (faster and more reliable)
        const geoResponse = await axios.get(
          `https://ipwhois.app/json/${realIp}`,
          {
            timeout: 10000,
          },
        );

        return {
          success: true,
          ip: realIp,
          country: geoResponse.data.country_code,
          country_name: geoResponse.data.country,
        };
      } catch (error) {
        lastError = error;
        const statusCode = error.response?.status;
        
        // Retry on 551/552 errors (temporary geo-targeting issues) or timeout errors
        const isGeoError = statusCode === 551 || statusCode === 552 || 
                          error.message.includes("551") || error.message.includes("552");
        const isTimeoutError = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        
        if ((isGeoError || isTimeoutError) && attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
          continue;
        }
        
        // Don't retry on other errors, break immediately
        break;
      }
    }

    // All retries failed, return error
    let errorMessage = lastError.message;
    const statusCode = lastError.response?.status;
    if (statusCode === 551 || lastError.message.includes("551")) {
      errorMessage =
        "Geo-targeting error (551): The proxy geo settings (country/region/city) are not available. Please remove or change the geo parameters in your proxy configuration.";
    } else if (statusCode === 552 || lastError.message.includes("552")) {
      errorMessage =
        "Geo-targeting error (552): The proxy geo settings are invalid or the requested location is unavailable. Please check your proxy's country/state/city parameters.";
    }

    return {
      success: false,
      error: errorMessage,
    };
  });

  ipcMain.handle("delete-profile", async (_, profileName) => {
    try {
      const profilePath = path.join(
        app.getPath("userData"),
        "profiles",
        profileName,
      );
      await fs.rm(profilePath, { recursive: true, force: true });

      // This handler is also used by account deletion screens. If the profile
      // had Facebook Groups branding cached, delete it with the account.
      try {
        const groupsDb = require("./facebookGroupsDatabase");
        const imageStore = require("./facebookGroupsImageStore");
        groupsDb.deleteProfileScan(profileName);
        await imageStore.removeProfileImages(profileName);
      } catch (mediaError) {
        console.warn("[FbGroups] Failed to remove deleted account images:", mediaError.message);
      }

      // Trigger cleanup after profile deletion to clean up any other orphaned items
      setTimeout(() => {
        triggerCleanupIfNeeded();
      }, 5000); // Delay to ensure any related operations complete first

      return { success: true };
    } catch (error) {
      console.error("Failed to delete profile folder:", error);
      return { success: false, error: error.message };
    }
  });

  // Duplicate a browser profile (copies the profile folder for concurrent usage)
  ipcMain.handle(
    "duplicate-profile",
    async (_, sourceProfileId, profileType, newProfileName) => {
      try {
        const profilesBasePath = path.join(app.getPath("userData"), "profiles");
        const sourceProfilePath = path.join(profilesBasePath, sourceProfileId);

        // Check if source profile exists
        try {
          await fs.access(sourceProfilePath);
        } catch {
          return {
            success: false,
            error: "Source profile folder does not exist",
          };
        }

        // Generate new profile ID
        const newProfileId = Math.random().toString(36).substring(2, 12);
        const newProfilePath = path.join(profilesBasePath, newProfileId);

        // Pre-register the profile BEFORE copying to prevent cleanup manager from deleting it
        if (profileType === "openai") {
          const openaiProfiles = (await readKey("openaiProfiles")) || {};
          const sourceProfile = openaiProfiles[sourceProfileId];
          openaiProfiles[newProfileId] = {
            name:
              newProfileName || (sourceProfile?.name || "Profile") + " (copy)",
            createdAt: new Date().toISOString(),
            status: sourceProfile?.status || "connected",
          };
          await updateData("openaiProfiles", openaiProfiles);
        }

        console.log(
          `[Duplicate Profile] Copying ${sourceProfileId} to ${newProfileId}...`,
        );

        // Copy the entire profile folder
        await fs.cp(sourceProfilePath, newProfilePath, { recursive: true });

        // Clean up lock files in the new profile that might cause issues
        const lockFiles = [
          "SingletonLock",
          "SingletonSocket",
          "SingletonCookie",
        ];
        for (const lockFile of lockFiles) {
          const lockPath = path.join(newProfilePath, lockFile);
          try {
            await fs.rm(lockPath, { force: true });
          } catch (e) {
            // Ignore if doesn't exist
          }
        }

        // Create .first_run file to mark this as an initialized profile
        try {
          await fs.writeFile(path.join(newProfilePath, ".first_run"), "");
        } catch (e) {
          console.log(
            "[Duplicate Profile] Could not create .first_run file:",
            e.message,
          );
        }

        console.log(
          `[Duplicate Profile] Successfully duplicated ${sourceProfileId} to ${newProfileId}`,
        );

        return { success: true, newProfileId };
      } catch (error) {
        console.error(
          "[Duplicate Profile] Failed to duplicate profile:",
          error,
        );
        // Clean up the pre-registered profile if copy failed
        if (profileType === "openai") {
          try {
            const openaiProfiles = (await readKey("openaiProfiles")) || {};
            // Find and remove the failed profile (we don't have newProfileId in scope here if error was early)
            // This is handled by the frontend not seeing the newProfileId
          } catch (cleanupError) {
            console.error("[Duplicate Profile] Cleanup error:", cleanupError);
          }
        }
        return { success: false, error: error.message };
      }
    },
  );

  // Repair a corrupted browser profile (cleans caches, lock files, etc. while preserving cookies/login)
  ipcMain.handle("repair-profile", async (_, profileName) => {
    try {
      const profilePath = path.join(
        app.getPath("userData"),
        "profiles",
        profileName,
      );
      await repairProfile(profilePath);
      return { success: true };
    } catch (error) {
      console.error("Failed to repair profile:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "start-structure-profile",
    async (_, profileId, url = null, proxy = null, additionalTabUrl = null) => {
      try {
        const structures = await readKey("structures");

        let profileInfo = null;
        let parentStructureId = null;

        for (const [structureId, structure] of Object.entries(structures)) {
          if (structure.profiles && structure.profiles[profileId]) {
            profileInfo = structure.profiles[profileId];
            parentStructureId = structureId;
            break;
          }
        }

        if (!profileInfo) {
          console.error(
            `[start-structure-profile] Profile ${profileId} not found`,
          );
          return { success: false, error: "Profile not found" };
        }

        console.log(
          `[start-structure-profile] Opening profile ${profileId} (${profileInfo.label})`,
        );
        console.log(
          `[start-structure-profile] Additional tab to open: ${additionalTabUrl || "none"}`,
        );
        console.log(
          `[start-structure-profile] URL: ${url}, Proxy: ${proxy?.ip || "none"}, BrowserType: ${profileInfo.browserType || "chrome"}`,
        );

        // Check for saved tabs to restore
        const savedTabs = profileInfo.savedTabs || [];
        const hasSavedTabs = savedTabs.length > 0;

        console.log(
          `[start-structure-profile] Profile has ${savedTabs.length} saved tabs:`,
          savedTabs,
        );

        // Determine initial URL - use saved tabs if available, otherwise use provided URL
        let initialUrl = url || "about:blank";
        if (hasSavedTabs && !url) {
          initialUrl = savedTabs[0]; // First tab will be opened by the browser
          console.log(
            `[start-structure-profile] Restoring ${savedTabs.length} saved tabs, initial URL: ${initialUrl}`,
          );
        }

        // Helper function to save tabs and cookies - polls periodically and saves on browser close
        const setupTabTracking = (debuggingPort, chromeProcess, client) => {
          let lastKnownTabs = [];
          let lastKnownCookies = [];
          let isRunning = true;

          // Poll tabs and cookies every 5 seconds while browser is running
          const pollTabsAndCookies = async () => {
            if (!isRunning) return;

            try {
              // Poll tabs via HTTP endpoint
              const tabs = await new Promise((resolve) => {
                http
                  .get(`http://localhost:${debuggingPort}/json`, (res) => {
                    let rawData = "";
                    res.on("data", (chunk) => (rawData += chunk));
                    res.on("end", () => {
                      try {
                        resolve(JSON.parse(rawData));
                      } catch (e) {
                        resolve(null);
                      }
                    });
                  })
                  .on("error", () => resolve(null));
                setTimeout(() => resolve(null), 2000);
              });

              if (tabs && Array.isArray(tabs)) {
                // Filter valid tab URLs
                const tabUrls = tabs
                  .filter(
                    (tab) =>
                      tab.type === "page" &&
                      tab.url &&
                      !tab.url.startsWith("chrome://") &&
                      !tab.url.startsWith("chrome-extension://") &&
                      !tab.url.startsWith("about:") &&
                      !tab.url.startsWith("devtools://"),
                  )
                  .map((tab) => tab.url);

                if (tabUrls.length > 0) {
                  lastKnownTabs = tabUrls;
                }
              }

              // Poll cookies via CDP if client is available
              if (client) {
                try {
                  const { Network } = client;
                  const cookiesResult = await Network.getAllCookies();
                  if (
                    cookiesResult &&
                    cookiesResult.cookies &&
                    cookiesResult.cookies.length > 0
                  ) {
                    // Convert CDP cookies to our storage format
                    lastKnownCookies = cookiesResult.cookies.map((cookie) => ({
                      name: cookie.name,
                      value: cookie.value,
                      domain: cookie.domain,
                      path: cookie.path || "/",
                      secure: cookie.secure || false,
                      httpOnly: cookie.httpOnly || false,
                      sameSite:
                        cookie.sameSite === "None"
                          ? "no_restriction"
                          : cookie.sameSite === "Lax"
                            ? "lax"
                            : cookie.sameSite === "Strict"
                              ? "strict"
                              : "lax",
                      expires: cookie.expires || undefined,
                    }));
                  }
                } catch (cookieError) {
                  // Ignore cookie polling errors (browser might be closing)
                }
              }
            } catch (e) {
              // Ignore errors during polling
            }

            // Schedule next poll if still running
            if (isRunning) {
              setTimeout(pollTabsAndCookies, 5000);
            }
          };

          // Start polling after a delay
          setTimeout(pollTabsAndCookies, 3000);

          // Save last known tabs and cookies when browser exits
          chromeProcess.on("exit", async () => {
            isRunning = false;

            try {
              const currentStructures = await readKey("structures");
              // The profile may have been transferred while its browser was open.
              // Follow its stable ID instead of dropping the latest session data.
              const currentParentStructureId = currentStructures[parentStructureId]?.profiles?.[profileId]
                ? parentStructureId
                : Object.keys(currentStructures).find(
                    structureId => currentStructures[structureId]?.profiles?.[profileId],
                  );

              if (currentParentStructureId) {
                // Save tabs if we have them
                if (lastKnownTabs.length > 0) {
                  currentStructures[currentParentStructureId].profiles[
                    profileId
                  ].savedTabs = lastKnownTabs;
                  console.log(
                    `[start-structure-profile] Saved ${lastKnownTabs.length} tabs for ${profileId}`,
                  );
                }

                // Save cookies if we have them (this persists website-modified cookies!)
                if (lastKnownCookies.length > 0) {
                  currentStructures[currentParentStructureId].profiles[
                    profileId
                  ].cookies = lastKnownCookies;
                  console.log(
                    `[start-structure-profile] Saved ${lastKnownCookies.length} cookies for ${profileId}`,
                  );
                }

                await updateData("structures", currentStructures);
              }

              // Remove from active profiles
              activeStructureProfiles.delete(profileId);
            } catch (e) {
              console.error(
                `[start-structure-profile] Error saving tabs/cookies on exit:`,
                e,
              );
            }
          });
        };

        // Helper function to open a single tab
        const openSingleTab = async (debuggingPort, tabUrl) => {
          try {
            await new Promise((resolve, reject) => {
              const req = http.request(
                {
                  hostname: "localhost",
                  port: debuggingPort,
                  path: "/json/new?" + encodeURIComponent(tabUrl),
                  method: "PUT",
                },
                (res) => {
                  res.on("data", () => {});
                  res.on("end", resolve);
                },
              );
              req.on("error", reject);
              req.end();
            });
            console.log(`[start-structure-profile] Opened tab: ${tabUrl}`);
          } catch (e) {
            console.error(`[start-structure-profile] Failed to open tab:`, e);
          }
        };

        // Helper function to open additional tabs
        const openAdditionalTabs = async (debuggingPort, tabsToOpen) => {
          if (tabsToOpen.length <= 1) return; // First tab already opened

          // Wait a bit for browser to be ready
          await new Promise((resolve) => setTimeout(resolve, 1000));

          for (let i = 1; i < tabsToOpen.length; i++) {
            try {
              const tabUrl = tabsToOpen[i];
              // Create new tab via CDP
              await new Promise((resolve, reject) => {
                const postData = JSON.stringify({ url: tabUrl });
                const req = http.request(
                  {
                    hostname: "localhost",
                    port: debuggingPort,
                    path: "/json/new?" + encodeURIComponent(tabUrl),
                    method: "PUT",
                  },
                  (res) => {
                    res.on("data", () => {});
                    res.on("end", resolve);
                  },
                );
                req.on("error", reject);
                req.end();
              });
              console.log(`[start-structure-profile] Opened tab: ${tabUrl}`);
            } catch (e) {
              console.error(`[start-structure-profile] Failed to open tab:`, e);
            }
          }
        };

        // All profiles now use VCBrowser
        // Check if VCBrowser is installed
        if (!isVCBrowserInstalled()) {
          console.error(`[start-structure-profile] VCBrowser not installed`);
          return {
            success: false,
            error: "VCBrowser is not installed",
            needsVCBrowser: true,
          };
        }

        // Use the fingerprint saved in the profile, fallback to consistent fingerprint if not set
        let fingerprint = profileInfo.fingerprint;
        if (!fingerprint || Object.keys(fingerprint).length === 0) {
          console.log(
            `[start-structure-profile] No saved fingerprint, using consistent fingerprint`,
          );
          fingerprint = getConsistentFingerprintForProfile(profileId);
        } else {
          console.log(
            `[start-structure-profile] Using saved fingerprint for profile`,
          );
        }

        // Always update Chrome version in fingerprint to match VCBrowser's actual version
        try {
          const vcVersion = getVCBrowserVersion();
          if (fingerprint.userAgent && vcVersion?.full) {
            const oldUA = fingerprint.userAgent;
            fingerprint.userAgent = oldUA.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
            if (oldUA !== fingerprint.userAgent) {
              console.log(`[start-structure-profile] Updated Chrome version to: ${vcVersion.full}`);
            }
          }
        } catch (versionErr) {
          console.warn(`[start-structure-profile] Could not update Chrome version:`, versionErr.message);
        }

        // Use VCBrowser with built-in fingerprint spoofing
        // Fall back to the profile's stored proxy when no proxy is passed (e.g. from FB Groups page)
        const effectiveProxy = proxy || profileInfo.proxy || null;
        const { chromeProcess, client, debuggingPort, geoData } =
          await startVCBrowser(
            profileId,
            fingerprint,
            initialUrl,
            effectiveProxy,
            false, // headless
          );

        // Track active profile
        activeStructureProfiles.set(profileId, {
          chromeProcess,
          debuggingPort,
          parentStructureId,
          client,
        });

        // Enable Network domain for cookie operations
        try {
          const { Network } = client;
          await Network.enable();
        } catch (e) {
          console.error(
            `[start-structure-profile] Failed to enable Network domain:`,
            e,
          );
        }

        // Set up tab and cookie tracking
        setupTabTracking(debuggingPort, chromeProcess, client);

        // Open additional saved tabs
        if (hasSavedTabs && !url) {
          openAdditionalTabs(debuggingPort, savedTabs);
        }

        // Open pixelscan tab if it wasn't in the saved tabs
        if (additionalTabUrl) {
          setTimeout(
            () => openSingleTab(debuggingPort, additionalTabUrl),
            2000,
          );
        }

        // Inject cookies if profile has them
        if (profileInfo.cookies && profileInfo.cookies.length > 0) {
          try {
            const { Network } = client;

            // Convert cookies to CDP format and set them
            for (const cookie of profileInfo.cookies) {
              const cdpCookie = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || "/",
                secure: cookie.secure || false,
                httpOnly: cookie.httpOnly || false,
                sameSite:
                  cookie.sameSite === "no_restriction"
                    ? "None"
                    : cookie.sameSite === "lax"
                      ? "Lax"
                      : cookie.sameSite === "strict"
                        ? "Strict"
                        : undefined,
              };

              // Add expires if present
              if (cookie.expires) {
                cdpCookie.expires = cookie.expires;
              }

              await Network.setCookie(cdpCookie);
            }
            console.log(
              `[start-structure-profile] Injected ${profileInfo.cookies.length} cookies for ${profileId}`,
            );
          } catch (cookieError) {
            console.error(
              `[start-structure-profile] Failed to inject cookies:`,
              cookieError,
            );
          }
        }

        console.log(
          `[start-structure-profile] VCBrowser launched for ${profileId}, port: ${debuggingPort}`,
        );
        return {
          success: true,
          debuggingPort,
          browserType: "vcbrowser",
          geoData,
        };
      } catch (error) {
        console.error(`[start-structure-profile] Error:`, error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle(
    "open-stealth-profile",
    async (_, profileName, url = null, proxy = null, method = null) => {
      // All profiles now use VCBrowser
      // Generate consistent fingerprint for the profile
      const fingerprint = getConsistentFingerprintForProfile(profileName);

      // Always update Chrome version in fingerprint to match VCBrowser's actual version
      try {
        const vcVersion = getVCBrowserVersion();
        if (fingerprint.userAgent && vcVersion?.full) {
          fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
          console.log(`[open-stealth-profile] Using VCBrowser version: ${vcVersion.full}`);
        }
      } catch (versionErr) {
        console.warn(`[open-stealth-profile] Could not update Chrome version:`, versionErr.message);
      }

      // Override fingerprint language with user's preferred language setting
      // This is important for Google/OpenAI profiles where user selects language
      // NOTE: Timezone is NOT overridden here - VCBrowserManager will get it from the IP's geolocation
      try {
        const localeBundle = await getUserLocaleBundle();
        if (localeBundle && localeBundle.locale) {
          const primaryLang = localeBundle.locale; // e.g., 'fr-FR'
          const baseLang = primaryLang.split("-")[0]; // e.g., 'fr'
          fingerprint.language = primaryLang;
          fingerprint.languages = [primaryLang, baseLang, "en"].filter(
            (v, i, a) => a.indexOf(v) === i,
          ); // Remove duplicates
          // Don't override timezone - let VCBrowserManager get it from the IP geolocation
          console.log(
            `[open-stealth-profile] Using user's preferred language: ${primaryLang}`,
          );
        }
      } catch (localeError) {
        console.warn(
          `[open-stealth-profile] Failed to get user locale, using fingerprint defaults:`,
          localeError.message,
        );
      }

      // Check if VCBrowser is installed
      if (!isVCBrowserInstalled()) {
        console.error(`[open-stealth-profile] VCBrowser not installed`);
        return {
          success: false,
          error: "VCBrowser is not installed",
          needsVCBrowser: true,
        };
      }

      // When reopening a profile (e.g. from the Google disconnect modal), the
      // profile may already be open in another browser instance (a headless
      // automation browser like Gemini Image, etc.). Chrome cannot launch a
      // second instance against the same locked user-data-dir, so the new
      // window would silently fail to appear. Kill any running browser for
      // this profile first and give the OS a moment to release the lock.
      try {
        const killedCount = killBrowsersForProfile(profileName);
        if (killedCount > 0) {
          console.log(
            `[open-stealth-profile] Closed ${killedCount} existing browser(s) for "${profileName}" before reopening`,
          );
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (killErr) {
        console.warn(
          `[open-stealth-profile] Could not close existing browser(s) for "${profileName}": ${killErr.message}`,
        );
      }

      // Use VCBrowser with built-in fingerprint spoofing
      let chromeProcess, client, debuggingPort;
      try {
        const result = await startVCBrowser(
          profileName,
          fingerprint,
          url || "about:blank",
          proxy,
          false, // headless
        );
        chromeProcess = result.chromeProcess;
        client = result.client;
        debuggingPort = result.debuggingPort;
      } catch (err) {
        console.error(
          `[open-stealth-profile] Failed to start VCBrowser:`,
          err.message,
        );
        return {
          success: false,
          error: `Failed to start browser: ${err.message}`,
        };
      }

      // Register in registry so disconnection handlers can kill it
      registerProfileBrowser(profileName, chromeProcess);

      let alertShown = false;
      let connectionDetected = false;
      let googleInterval = null;

      // Helper to get main window for sending events
      const getMainWindow = () => {
        const { BrowserWindow } = require("electron");
        const windows = BrowserWindow.getAllWindows();
        return windows.find((w) => !w.isDestroyed());
      };

      // Listen for process exit to re-enable button
      chromeProcess.on("exit", () => {
        deregisterProfileBrowser(profileName);
        const win = getMainWindow();
        if (win) {
          win.webContents.send("stealth-browser-closed", profileName);
        }
      });

      if (method == "google" || method == "google-reconnect") {
        // Check if profile is already connected - skip auto-close detection
        // Also skip auto-close when opened from the disconnect modal (google-reconnect)
        const googleProfiles = (await readKey("googleProfiles")) || {};
        const isAlreadyConnected = googleProfiles[profileName]?.status === "connected" || method === "google-reconnect";

        // Helper function to gracefully close Chrome using CDP (preserves cookies/session)
        const closeChromeGracefully = () => {
          http
            .get(
              `http://localhost:${debuggingPort}/json/version`,
              (versionRes) => {
                let versionData = "";
                versionRes.on("data", (chunk) => (versionData += chunk));
                versionRes.on("end", () => {
                  try {
                    const versionInfo = JSON.parse(versionData);
                    const browserWsUrl = versionInfo.webSocketDebuggerUrl;
                    if (browserWsUrl) {
                      const WebSocket = require("ws");
                      const browserWs = new WebSocket(browserWsUrl);
                      browserWs.on("open", () => {
                        console.log(
                          "[Google Profile] Sending Browser.close command for graceful shutdown...",
                        );
                        browserWs.send(
                          JSON.stringify({ id: 999, method: "Browser.close" }),
                        );
                        // Give Chrome time to flush cookies, then force kill as fallback
                        setTimeout(() => {
                          if (!chromeProcess.killed) {
                            console.log(
                              "[Google Profile] Force killing Chrome process as fallback",
                            );
                            chromeProcess.kill();
                          }
                        }, 5000);
                      });
                      browserWs.on("error", () => {
                        console.log(
                          "[Google Profile] Browser WebSocket failed, using kill fallback",
                        );
                        chromeProcess.kill();
                      });
                    } else {
                      chromeProcess.kill();
                    }
                  } catch (e) {
                    chromeProcess.kill();
                  }
                });
              },
            )
            .on("error", () => {
              chromeProcess.kill();
            });
        };

        const checkForTargetUrl = () => {
          // Skip if already detected connection
          if (connectionDetected) return;

          // Validate debuggingPort is a valid number
          if (
            !debuggingPort ||
            !Number.isInteger(debuggingPort) ||
            debuggingPort <= 0
          ) {
            console.error(`Invalid debugging port: ${debuggingPort}`);
            return;
          }
          http
            .get(`http://localhost:${debuggingPort}/json`, (res) => {
              let rawData = "";
              res.on("data", (chunk) => (rawData += chunk));
              res.on("end", () => {
                try {
                  const tabs = JSON.parse(rawData);
                  for (const tab of tabs) {
                    if (tab.url && tab.url.includes("myaccount.google.com")) {
                      // Prevent duplicate detection
                      if (connectionDetected) return;
                      connectionDetected = true;

                      // Clear interval immediately
                      if (googleInterval) {
                        clearInterval(googleInterval);
                        googleInterval = null;
                      }

                      (async function () {
                        const googleProfiles =
                          (await readKey("googleProfiles")) || {};
                        googleProfiles[profileName] =
                          googleProfiles[profileName] || {};
                        googleProfiles[profileName]["status"] = "connected";
                        await updateData("googleProfiles", googleProfiles);
                      })();

                      if (!alertShown) {
                        alertShown = true;
                        showAlert(
                          "Profile connected successfully. The browser will close automatically in 5 seconds.",
                          5,
                        );
                      }
                      setTimeout(() => {
                        if (!chromeProcess.killed) {
                          closeChromeGracefully();
                          console.log(
                            "[Google Profile] Chrome closing gracefully after successful connection",
                          );
                        }
                      }, 5000);
                      return;
                    }
                  }
                } catch (err) {}
              });
            })
            .on("error", (err) => {});
        };

        // Only poll for login detection if profile is not already connected
        if (!isAlreadyConnected) {
          googleInterval = setInterval(() => {
            if (chromeProcess.killed || connectionDetected) {
              if (googleInterval) {
                clearInterval(googleInterval);
                googleInterval = null;
              }
            } else {
              checkForTargetUrl();
            }
          }, 1500);
        } else {
          console.log(`[Google Profile] Profile "${profileName}" is ${method === "google-reconnect" ? "opened from reconnect modal" : "already connected"}, skipping auto-close detection`);
        }
      } else if (method === "openai") {
        // OpenAI/ChatGPT profile connection detection
        const openaiProfilesInitial = (await readKey("openaiProfiles")) || {};
        const isAlreadyConnected = openaiProfilesInitial[profileName]?.status === "connected";
        let openaiConnectionDetected = false;
        let openaiInterval = null;

        // Helper function to gracefully close Chrome using CDP (preserves cookies/session)
        const closeChromeGracefully = () => {
          http
            .get(
              `http://localhost:${debuggingPort}/json/version`,
              (versionRes) => {
                let versionData = "";
                versionRes.on("data", (chunk) => (versionData += chunk));
                versionRes.on("end", () => {
                  try {
                    const versionInfo = JSON.parse(versionData);
                    const browserWsUrl = versionInfo.webSocketDebuggerUrl;
                    if (browserWsUrl) {
                      const browserWs = new WebSocket(browserWsUrl);
                      browserWs.on("open", () => {
                        console.log(
                          "[OpenAI] Sending Browser.close command for graceful shutdown...",
                        );
                        browserWs.send(
                          JSON.stringify({ id: 999, method: "Browser.close" }),
                        );
                        setTimeout(() => {
                          if (!chromeProcess.killed) {
                            console.log(
                              "[OpenAI] Force killing Chrome process as fallback",
                            );
                            chromeProcess.kill();
                          }
                        }, 5000);
                      });
                      browserWs.on("error", () => {
                        console.log(
                          "[OpenAI] Browser WebSocket failed, using kill fallback",
                        );
                        chromeProcess.kill();
                      });
                    } else {
                      chromeProcess.kill();
                    }
                  } catch (e) {
                    chromeProcess.kill();
                  }
                });
              },
            )
            .on("error", () => {
              chromeProcess.kill();
            });
        };

        const { verifyChatGPTSession } = require('./chatgptLoginDetection');
        let openaiCheckInFlight = false;
        let openaiBrowserExited = false;
        chromeProcess.once('exit', () => {
          openaiBrowserExited = true;
          if (openaiInterval) clearInterval(openaiInterval);
          openaiInterval = null;
        });

        const checkForChatGPTLogin = async () => {
          if (openaiConnectionDetected || openaiCheckInFlight || openaiBrowserExited || chromeProcess.killed) return;
          if (!Number.isInteger(debuggingPort) || debuggingPort <= 0) return;
          openaiCheckInFlight = true;
          try {
            const tabs = await new Promise(resolve => {
              const request = http.get(`http://localhost:${debuggingPort}/json`, res => {
                let rawData = '';
                res.on('data', chunk => { rawData += chunk; });
                res.on('error', () => resolve([]));
                res.on('end', () => {
                  try { const data = JSON.parse(rawData); resolve(Array.isArray(data) ? data : []); }
                  catch (_) { resolve([]); }
                });
              });
              request.setTimeout(5000, () => { request.destroy(); resolve([]); });
              request.on('error', () => resolve([]));
            });
            for (const tab of tabs) {
              if (!(await verifyChatGPTSession(tab, WebSocket))) continue;
              if (openaiBrowserExited || chromeProcess.killed) return;
              const profiles = (await readKey('openaiProfiles')) || {};
              // Do not recreate a profile deleted while login verification was running.
              if (!profiles[profileName]) return;
              profiles[profileName].status = 'connected';
              await updateData('openaiProfiles', profiles);
              openaiConnectionDetected = true;
              if (openaiInterval) clearInterval(openaiInterval);
              openaiInterval = null;
              if (!isAlreadyConnected) {
                if (!alertShown) {
                  alertShown = true;
                  showAlert('ChatGPT profile connected successfully. The browser will close automatically in 5 seconds.', 5);
                }
                setTimeout(() => {
                  if (!openaiBrowserExited && !chromeProcess.killed) closeChromeGracefully();
                }, 5000);
              }
              return;
            }
          } catch (_) {
            // Navigation, startup and transient failures are retried on the next poll.
          } finally {
            openaiCheckInFlight = false;
          }
        };

        openaiInterval = setInterval(checkForChatGPTLogin, 1500);
        checkForChatGPTLogin();
      } else if (method === "discord") {
        // Check if profile is already connected
        const discordProfilesInitial = (await readKey("discordProfiles")) || {};
        const isAlreadyConnected =
          discordProfilesInitial[profileName]?.status === "connected";
        let hasUpdatedSession = false; // Track if we've already updated session info
        const pendingDiscordInteractions = new Map();
        const pendingDiscordHeaders = new Map();

        const saveDiscordConnectionInfo = async (fields) => {
          const requiredFields = [
            "APPLICATION_ID",
            "CHANNEL_ID",
            "SESSION_ID",
            "DATA_VERSION",
            "DATA_ID",
            "AUTHORIZATION",
          ];
          const missingFields = requiredFields.filter((field) => !fields?.[field]);
          if (missingFields.length > 0) {
            console.log(
              `[Discord] Waiting for complete /imagine session data (${missingFields.join(", ")})`,
            );
            return false;
          }

          const discordProfiles = (await readKey("discordProfiles")) || {};
          discordProfiles[profileName] = discordProfiles[profileName] || {};
          discordProfiles[profileName]["status"] = "connected";
          discordProfiles[profileName]["connection-info"] = fields;
          await updateData("discordProfiles", discordProfiles);
          console.log(
            `[Discord] Updated complete /imagine session info for profile: ${profileName}`,
          );
          return true;
        };

        // Helper function to gracefully close Chrome using CDP
        const closeChromeGracefully = (wsDebuggerUrl, callback) => {
          // Connect to the browser's WebSocket to send Browser.close command
          get(
            `http://localhost:${debuggingPort}/json/version`,
            (versionRes) => {
              let versionData = "";
              versionRes.on("data", (chunk) => (versionData += chunk));
              versionRes.on("end", () => {
                try {
                  const versionInfo = JSON.parse(versionData);
                  const browserWsUrl = versionInfo.webSocketDebuggerUrl;
                  if (browserWsUrl) {
                    const browserWs = new WebSocket(browserWsUrl);
                    browserWs.on("open", () => {
                      console.log(
                        "[Discord] Sending Browser.close command for graceful shutdown...",
                      );
                      browserWs.send(
                        JSON.stringify({ id: 999, method: "Browser.close" }),
                      );
                      // Give it a moment then force kill if still running
                      setTimeout(() => {
                        if (!chromeProcess.killed) {
                          console.log(
                            "[Discord] Force killing Chrome process as fallback",
                          );
                          chromeProcess.kill();
                        }
                        if (callback) callback();
                      }, 5000);
                    });
                    browserWs.on("error", () => {
                      // Fallback to kill if WebSocket fails
                      console.log(
                        "[Discord] Browser WebSocket failed, using kill fallback",
                      );
                      chromeProcess.kill();
                      if (callback) callback();
                    });
                  } else {
                    chromeProcess.kill();
                    if (callback) callback();
                  }
                } catch (e) {
                  chromeProcess.kill();
                  if (callback) callback();
                }
              });
            },
          ).on("error", () => {
            chromeProcess.kill();
            if (callback) callback();
          });
        };

        const connectToCDP = () => {
          get(`http://localhost:${debuggingPort}/json`, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              try {
                const targets = JSON.parse(body);
                const discordTarget =
                  targets.find(
                    (target) =>
                      target.type === "page" &&
                      /(?:^|\.)discord(?:app)?\.com/i.test(
                        (() => {
                          try {
                            return new URL(target.url).hostname;
                          } catch (_) {
                            return "";
                          }
                        })(),
                      ),
                  ) || targets.find((target) => target.type === "page");
                const wsDebuggerUrl = discordTarget?.webSocketDebuggerUrl;
                if (!wsDebuggerUrl) return;

                const ws = new WebSocket(wsDebuggerUrl);

                ws.on("open", () => {
                  ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));

                  const finishDiscordCapture = () => {
                    // Only close the browser and websocket during first-time setup.
                    if (!isAlreadyConnected && !hasUpdatedSession) {
                      hasUpdatedSession = true;
                      ws.close();

                      if (!alertShown) {
                        alertShown = true;
                        showAlert(
                          "Profile connected successfully. Please keep the Chrome window open; it will close automatically in 15 seconds.",
                          5,
                        );
                      }
                      setTimeout(() => {
                        closeChromeGracefully(wsDebuggerUrl, null);
                      }, 15000);
                    }
                  };

                  ws.on("message", async (raw) => {
                    const msg = JSON.parse(raw);
                    if (msg.method === "Network.requestWillBeSent") {
                      const { request, type, requestId } = msg.params;
                      const isDiscordInteraction =
                        (type === "XHR" || type === "Fetch") &&
                        request.method === "POST" &&
                        /discord(?:app)?\.com\/api\/v\d+\/interactions(?:\?|$)/i.test(request.url);

                      if (isDiscordInteraction) {
                        let fields;
                        try {
                          fields = extractDiscordFields(request);
                        } catch (_) {
                          return;
                        }

                        const extraHeaders = pendingDiscordHeaders.get(requestId) || {};
                        fields.AUTHORIZATION =
                          extraHeaders.Authorization ||
                          extraHeaders.authorization ||
                          fields.AUTHORIZATION;
                        pendingDiscordHeaders.delete(requestId);
                        pendingDiscordInteractions.set(requestId, fields);
                        const saved = await saveDiscordConnectionInfo(fields);

                        if (saved) {
                          pendingDiscordInteractions.delete(requestId);
                          finishDiscordCapture();
                          return;
                        }
                      } else {
                        pendingDiscordHeaders.delete(requestId);
                      }
                    } else if (msg.method === "Network.requestWillBeSentExtraInfo") {
                      // Chromium may expose sensitive request headers (including
                      // Discord authorization) only in this separate CDP event.
                      const { requestId, headers = {} } = msg.params;
                      const fields = pendingDiscordInteractions.get(requestId);
                      if (!fields) {
                        // CDP does not guarantee whether ExtraInfo is delivered
                        // before or after requestWillBeSent.
                        if (pendingDiscordHeaders.size >= 100) {
                          pendingDiscordHeaders.delete(
                            pendingDiscordHeaders.keys().next().value,
                          );
                        }
                        pendingDiscordHeaders.set(requestId, headers);
                        return;
                      }

                      fields.AUTHORIZATION =
                        headers.Authorization || headers.authorization || fields.AUTHORIZATION;
                      if (await saveDiscordConnectionInfo(fields)) {
                        pendingDiscordInteractions.delete(requestId);
                        finishDiscordCapture();
                      }
                    }
                  });
                });

                ws.on("error", (err) => {
                  console.error("WebSocket error:", err.message);
                });
              } catch (e) {
                console.error("Failed to connect to CDP:", e);
              }
            });
          });
        };

        setTimeout(connectToCDP, 3000);
      } else if (method == "facebookspy") {
        let facebookConnectionDetected = false;

        // Helper function to gracefully close Chrome using CDP (preserves cookies/session)
        const closeChromeGracefullyFb = (wsDebuggerUrl) => {
          try {
            const browserWs = new WebSocket(
              wsDebuggerUrl.replace("/devtools/page/", "/devtools/browser/"),
            );
            browserWs.on("open", () => {
              console.log(
                "[FacebookSpy] Sending Browser.close command for graceful shutdown...",
              );
              browserWs.send(
                JSON.stringify({ id: 999, method: "Browser.close" }),
              );
              setTimeout(() => {
                if (!chromeProcess.killed) {
                  console.log(
                    "[FacebookSpy] Force killing Chrome process as fallback",
                  );
                  chromeProcess.kill();
                }
              }, 5000);
            });
            browserWs.on("error", () => {
              console.log(
                "[FacebookSpy] Browser WebSocket failed, using kill fallback",
              );
              chromeProcess.kill();
            });
          } catch (e) {
            chromeProcess.kill();
          }
        };

        const connectToCDP = () => {
          get(`http://localhost:${debuggingPort}/json`, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              try {
                const targets = JSON.parse(body);
                const wsDebuggerUrl = targets[0]?.webSocketDebuggerUrl;
                if (!wsDebuggerUrl) return;

                const ws = new WebSocket(wsDebuggerUrl);

                ws.on("open", () => {
                  ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));

                  ws.on("message", async (raw) => {
                    // Skip if already detected
                    if (facebookConnectionDetected) return;

                    const msg = JSON.parse(raw);
                    if (msg.method === "Network.requestWillBeSent") {
                      const url = msg.params.request.url;
                      if (url.includes("ajax/bnzai")) {
                        // Prevent duplicate detection
                        if (facebookConnectionDetected) return;
                        facebookConnectionDetected = true;

                        const spyProfiles =
                          (await readKey("spyProfiles")) || {};
                        if (!spyProfiles[profileName])
                          spyProfiles[profileName] = {};
                        spyProfiles[profileName]["status"] = "connected";
                        await updateData("spyProfiles", spyProfiles);

                        if (!alertShown) {
                          alertShown = true;
                          showAlert(
                            "Profile connected successfully. The browser will close automatically in 5 seconds.",
                            5,
                          );
                        }
                        setTimeout(() => {
                          if (!chromeProcess.killed) {
                            closeChromeGracefullyFb(wsDebuggerUrl);
                            console.log(
                              "[FacebookSpy] Chrome closing gracefully after successful connection",
                            );
                          }
                        }, 5000);

                        // Close WebSocket as we're done
                        ws.close();
                      }
                    }
                  });
                });

                ws.on("error", (err) => {
                  console.error("WebSocket error:", err.message);
                });
              } catch (e) {
                console.error("Failed to connect to CDP for Facebook:", e);
              }
            });
          });
        };

        setTimeout(connectToCDP, 3000);
      } else if (method == "pinterestspy") {
        let pinterestConnectionDetected = false;

        // Helper function to gracefully close Chrome using CDP (preserves cookies/session)
        const closeChromeGracefullyPinterest = (wsDebuggerUrl) => {
          try {
            const browserWs = new WebSocket(
              wsDebuggerUrl.replace("/devtools/page/", "/devtools/browser/"),
            );
            browserWs.on("open", () => {
              console.log(
                "[PinterestSpy] Sending Browser.close command for graceful shutdown...",
              );
              browserWs.send(
                JSON.stringify({ id: 999, method: "Browser.close" }),
              );
              setTimeout(() => {
                if (!chromeProcess.killed) {
                  console.log(
                    "[PinterestSpy] Force killing Chrome process as fallback",
                  );
                  chromeProcess.kill();
                }
              }, 5000);
            });
            browserWs.on("error", () => {
              console.log(
                "[PinterestSpy] Browser WebSocket failed, using kill fallback",
              );
              chromeProcess.kill();
            });
          } catch (e) {
            chromeProcess.kill();
          }
        };

        const connectToCDP = () => {
          get(`http://localhost:${debuggingPort}/json`, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              try {
                const targets = JSON.parse(body);
                const wsDebuggerUrl = targets[0]?.webSocketDebuggerUrl;
                if (!wsDebuggerUrl) return;

                const ws = new WebSocket(wsDebuggerUrl);

                ws.on("open", () => {
                  ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));

                  ws.on("message", async (raw) => {
                    // Skip if already detected
                    if (pinterestConnectionDetected) return;

                    const msg = JSON.parse(raw);
                    if (msg.method === "Network.requestWillBeSent") {
                      const url = msg.params.request.url;
                      console.log(url);
                      if (
                        url.includes(
                          "UserExperiencePlatformResource/get/?source_url",
                        ) ||
                        url.includes("NewsHubBadgeResource/get/?source_url")
                      ) {
                        // Prevent duplicate detection
                        if (pinterestConnectionDetected) return;
                        pinterestConnectionDetected = true;

                        const spyProfiles =
                          (await readKey("spyProfiles")) || {};
                        if (!spyProfiles[profileName])
                          spyProfiles[profileName] = {};
                        spyProfiles[profileName]["status"] = "connected";
                        await updateData("spyProfiles", spyProfiles);
                        if (!alertShown) {
                          alertShown = true;
                          showAlert(
                            "Profile connected successfully. The browser will close automatically in 5 seconds.",
                            5,
                          );
                        }
                        setTimeout(() => {
                          if (!chromeProcess.killed) {
                            closeChromeGracefullyPinterest(wsDebuggerUrl);
                            console.log(
                              "[PinterestSpy] Chrome closing gracefully after successful connection",
                            );
                          }
                        }, 5000);

                        // Close WebSocket as we're done
                        ws.close();
                      }
                    }
                  });
                });

                ws.on("error", (err) => {
                  console.error("WebSocket error:", err.message);
                });
              } catch (e) {
                console.error("Failed to connect to CDP for Pinterest:", e);
              }
            });
          });
        };

        setTimeout(connectToCDP, 3000);
      } else if (method === "metaai") {
        // Meta AI profile connection detection via cookies
        let metaaiConnectionDetected = false;
        let metaaiInterval = null;

        // Required cookies for Meta AI authentication
        const requiredCookieNames = ["rd_challenge", "datr", "dpr", "ecto_1_sess", "wd"];

        const closeChromeGracefully = () => {
          http
            .get(
              `http://localhost:${debuggingPort}/json/version`,
              (versionRes) => {
                let versionData = "";
                versionRes.on("data", (chunk) => (versionData += chunk));
                versionRes.on("end", () => {
                  try {
                    const versionInfo = JSON.parse(versionData);
                    const browserWsUrl = versionInfo.webSocketDebuggerUrl;
                    if (browserWsUrl) {
                      const browserWs = new WebSocket(browserWsUrl);
                      browserWs.on("open", () => {
                        console.log(
                          "[Meta AI] Sending Browser.close command for graceful shutdown...",
                        );
                        browserWs.send(
                          JSON.stringify({ id: 999, method: "Browser.close" }),
                        );
                        setTimeout(() => {
                          if (!chromeProcess.killed) {
                            console.log(
                              "[Meta AI] Force killing Chrome process as fallback",
                            );
                            chromeProcess.kill();
                          }
                        }, 5000);
                      });
                      browserWs.on("error", () => {
                        console.log(
                          "[Meta AI] Browser WebSocket failed, using kill fallback",
                        );
                        chromeProcess.kill();
                      });
                    } else {
                      chromeProcess.kill();
                    }
                  } catch (e) {
                    chromeProcess.kill();
                  }
                });
              },
            )
            .on("error", () => {
              chromeProcess.kill();
            });
        };

        const checkForMetaAICookies = () => {
          if (metaaiConnectionDetected) return;

          if (
            !debuggingPort ||
            !Number.isInteger(debuggingPort) ||
            debuggingPort <= 0
          ) {
            console.error(`Invalid debugging port: ${debuggingPort}`);
            return;
          }

          // Connect to the first tab via CDP WebSocket to check cookies
          http
            .get(`http://localhost:${debuggingPort}/json`, (res) => {
              let rawData = "";
              res.on("data", (chunk) => (rawData += chunk));
              res.on("end", () => {
                try {
                  const targets = JSON.parse(rawData);
                  const wsUrl = targets[0]?.webSocketDebuggerUrl;
                  if (!wsUrl) return;

                  const ws = new WebSocket(wsUrl);
                  let responded = false;

                  ws.on("open", () => {
                    // Use Network.getCookies via CDP to check meta.ai cookies
                    ws.send(
                      JSON.stringify({
                        id: 1,
                        method: "Network.getCookies",
                        params: {
                          urls: [
                            "https://www.meta.ai",
                            "https://meta.ai",
                            "https://auth.meta.com",
                          ],
                        },
                      }),
                    );
                  });

                  ws.on("message", (raw) => {
                    if (responded) return;
                    try {
                      const msg = JSON.parse(raw);
                      if (msg.id === 1 && msg.result && msg.result.cookies) {
                        responded = true;
                        const cookieNames = msg.result.cookies.map(
                          (c) => c.name,
                        );
                        const hasAllRequired = requiredCookieNames.every(
                          (name) => cookieNames.includes(name),
                        );

                        if (hasAllRequired) {
                          if (metaaiConnectionDetected) {
                            ws.close();
                            return;
                          }
                          metaaiConnectionDetected = true;

                          if (metaaiInterval) {
                            clearInterval(metaaiInterval);
                            metaaiInterval = null;
                          }

                          // Store the cookies for later use
                          const cookieString = msg.result.cookies
                            .map((c) => `${c.name}=${c.value}`)
                            .join("; ");

                          // Save full CDP cookie objects with extended expiry for session cookies
                          const cdpCookies = msg.result.cookies.map((c) => {
                            const cookie = { ...c };
                            // Extend session cookies (expires=-1 or 0) to 30 days so they survive browser restarts
                            if (!cookie.expires || cookie.expires === -1 || cookie.expires === 0) {
                              cookie.expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
                            }
                            return cookie;
                          });

                          (async function () {
                            const metaaiProfiles =
                              (await readKey("metaaiProfiles")) || {};
                            const wasAlreadyConnected =
                              metaaiProfiles[profileName]?.status === "connected";
                            metaaiProfiles[profileName] =
                              metaaiProfiles[profileName] || {};
                            metaaiProfiles[profileName]["status"] = "connected";
                            metaaiProfiles[profileName]["cookies"] =
                              cookieString;
                            metaaiProfiles[profileName]["cdpCookies"] =
                              cdpCookies;
                            await updateData("metaaiProfiles", metaaiProfiles);

                            // Only close browser if this is a new connection
                            if (!wasAlreadyConnected) {
                              if (!alertShown) {
                                alertShown = true;
                                showAlert(
                                  "Meta AI profile connected successfully. The browser will close automatically in 5 seconds.",
                                  5,
                                );
                              }
                              setTimeout(() => {
                                if (!chromeProcess.killed) {
                                  closeChromeGracefully();
                                  console.log(
                                    "[Meta AI] Chrome closing gracefully after successful cookie detection",
                                  );
                                }
                              }, 5000);
                            } else {
                              console.log(
                                "[Meta AI] Profile already connected, keeping browser open",
                              );
                            }
                          })();
                        }
                        ws.close();
                      }
                    } catch (err) {}
                  });

                  ws.on("error", () => {});

                  // Close websocket after timeout if no response
                  setTimeout(() => {
                    if (!responded) {
                      ws.close();
                    }
                  }, 5000);
                } catch (err) {}
              });
            })
            .on("error", () => {});
        };

        metaaiInterval = setInterval(() => {
          if (chromeProcess.killed || metaaiConnectionDetected) {
            if (metaaiInterval) {
              clearInterval(metaaiInterval);
              metaaiInterval = null;
            }
          } else {
            checkForMetaAICookies();
          }
        }, 3000);
      } else if (method === "deepseekbrowser") {
        // ── DeepSeek (Browser) profile connection ──────────────────────────
        // Capture candidate credentials, then verify /users/current in the browser.
        // An outgoing token alone does not prove the user is signed in.

        let deepseekConnectionDetected = false;
        let deepseekNetworkWs = null;
        let deepseekConnecting = false;
        let deepseekSaving = false;
        const deepseekState = require('./deepseekProfileState');
        const { createDeepSeekLoginMonitor } = require('./deepseekLogin');
        let deepseekLoginMonitor = null;
        let deepseekCloseTimer = null;
        const invalidateDeepSeekLogin = () => {
          deepseekConnectionDetected = false;
          if (deepseekCloseTimer) clearTimeout(deepseekCloseTimer);
          deepseekCloseTimer = null;
          alertShown = false;
        };

        const deepseekProfilesInitial = (await readKey("deepseekBrowserProfiles")) || {};
        const isAlreadyConnected = deepseekProfilesInitial[profileName]?.status === "connected";

        const closeChromeGracefully = () => {
          http
            .get(
              `http://localhost:${debuggingPort}/json/version`,
              (versionRes) => {
                let versionData = "";
                versionRes.on("data", (chunk) => (versionData += chunk));
                versionRes.on("end", () => {
                  try {
                    const versionInfo = JSON.parse(versionData);
                    const browserWsUrl = versionInfo.webSocketDebuggerUrl;
                    if (browserWsUrl) {
                      const WebSocket = require("ws");
                      const browserWs = new WebSocket(browserWsUrl);
                      browserWs.on("open", () => {
                        browserWs.send(
                          JSON.stringify({ id: 999, method: "Browser.close" }),
                        );
                        setTimeout(() => {
                          if (!chromeProcess.killed) chromeProcess.kill();
                        }, 5000);
                      });
                      browserWs.on("error", () => chromeProcess.kill());
                    } else {
                      chromeProcess.kill();
                    }
                  } catch (_) {
                    chromeProcess.kill();
                  }
                });
              },
            )
            .on("error", () => chromeProcess.kill());
        };

        const saveDeepSeekProfile = async (token, cdpCookies, currentUserResponse) => {
          if (deepseekConnectionDetected || deepseekSaving || !deepseekLoginMonitor?.isVerified(token)) return;
          deepseekSaving = true;
          try {

            const cookieString = cdpCookies
              .map((c) => `${c.name}=${c.value}`)
              .join("; ");

            // Extend session cookies to 30 days
            const extendedCookies = cdpCookies.map((c) => {
              const cookie = { ...c };
              if (!cookie.expires || cookie.expires === -1 || cookie.expires === 0) {
                cookie.expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
              }
              return cookie;
            });

            // Storage is synchronous: do not yield between validation and saving.
            const deepseekProfiles = readKey("deepseekBrowserProfiles") || {};
            deepseekProfiles[profileName] = deepseekProfiles[profileName] || {};
            deepseekProfiles[profileName].status = "connected";
            deepseekProfiles[profileName].token = token;
            deepseekProfiles[profileName].cookies = cookieString;
            deepseekProfiles[profileName].cdpCookies = extendedCookies;
            deepseekProfiles[profileName].updatedAt = new Date().toISOString();
            updateData("deepseekBrowserProfiles", deepseekProfiles);
            if (currentUserResponse) deepseekState.observe(profileName, 200, currentUserResponse, {}, true);
            deepseekConnectionDetected = true;

            if (!isAlreadyConnected) {
              if (!alertShown) {
                alertShown = true;
                showAlert(
                  "DeepSeek profile connected successfully. The browser will close automatically in 5 seconds.",
                  5,
                );
              }
              deepseekCloseTimer = setTimeout(() => {
                const saved = (readKey("deepseekBrowserProfiles") || {})[profileName];
                if (!deepseekLoginMonitor?.isVerified(token) || saved?.status !== 'connected' || saved.token !== token) return;
                if (deepseekNetworkWs) {
                  try { deepseekNetworkWs.close(); } catch (_) {}
                }
                if (!chromeProcess.killed) {
                  closeChromeGracefully();
                }
              }, 5000);
            } else {
              console.log(`[DeepSeek Browser] Profile "${profileName}" already connected, keeping browser open`);
            }
          } finally {
            deepseekSaving = false;
          }
        };

        // Connect to CDP and start listening for network events
        const connectToDeepSeekCDP = () => {
          if (chromeProcess.killed || deepseekConnectionDetected || deepseekConnecting || deepseekNetworkWs) return;
          deepseekConnecting = true;
          http
            .get(`http://localhost:${debuggingPort}/json`, (res) => {
              let body = "";
              res.on("data", (chunk) => (body += chunk));
              res.on("end", () => {
                try {
                  const targets = JSON.parse(body);
                  const target = targets.find(tab => tab.type === 'page' &&
                    /^https:\/\/chat\.deepseek\.com(?:\/|$)/.test(tab.url || ''));
                  const wsDebuggerUrl = target?.webSocketDebuggerUrl;
                  if (!wsDebuggerUrl) return;

                  const WebSocket = require("ws");
                  const ws = new WebSocket(wsDebuggerUrl);
                  deepseekNetworkWs = ws;

                  ws.on("open", () => {
                    ws.send(
                      JSON.stringify({ id: 1, method: "Network.enable" }),
                    );
                  });

                  const monitor = createDeepSeekLoginMonitor({
                    ws,
                    onVerified: saveDeepSeekProfile,
                    onObserved: (status, body, headers) => deepseekState.observe(profileName, status, body, headers, true),
                    onInvalidated: () => {
                      if (deepseekLoginMonitor === monitor) invalidateDeepSeekLogin();
                    },
                  });
                  deepseekLoginMonitor = monitor;
                  ws.on("message", async (raw) => {
                    try {
                      const msg = JSON.parse(raw);
                      // Replay initial requests if the chat page loaded before attachment.
                      if (msg.id === 1 && !msg.error && !target.url.includes('/sign_in')) {
                        ws.send(JSON.stringify({ id: 3, method: 'Page.reload' }));
                      }
                      await monitor.handle(msg);
                    } catch (_) {
                      console.warn('[DeepSeek Browser] Could not verify login; keeping the browser open.');
                    }
                  });

                  ws.on("error", () => { ws.close(); });
                  ws.on("close", () => {
                    monitor.close();
                    if (deepseekNetworkWs === ws) {
                      deepseekNetworkWs = null;
                      deepseekLoginMonitor = null;
                    }
                  });
                } catch (_) {
                  console.warn('[DeepSeek Browser] Could not attach login listener; will retry.');
                } finally {
                  deepseekConnecting = false;
                }
              });
            })
            .on("error", () => { deepseekConnecting = false; });
        };

        // Retry attachment and transient verification failures while login is open.
        const deepseekUrlInterval = setInterval(() => {
          if (chromeProcess.killed) {
            clearInterval(deepseekUrlInterval);
            return;
          }
          if (deepseekConnectionDetected) return;
          connectToDeepSeekCDP();
          deepseekLoginMonitor?.refresh();
        }, 2000);

        // Attach immediately, retrying while the browser starts or changes targets.
        connectToDeepSeekCDP();
        chromeProcess.once('exit', () => {
          clearInterval(deepseekUrlInterval);
          if (deepseekNetworkWs) deepseekNetworkWs.close();
        });
      } else if (method === "qwenbrowser") {
        // ── Qwen AI (Browser) profile connection ──────────────────────────
        // Strategy: connect to CDP after the tab opens, enable Network +
        // Runtime events. When the user logs in, Qwen makes API requests to
        // chat.qwen.ai/api/v2/. We detect those, then use Runtime.evaluate
        // to read localStorage.getItem('token') and Network.getCookies to
        // capture all cookies for the domain.

        let qwenConnectionDetected = false;
        let qwenNetworkWs = null;

        const qwenProfilesInitial = (await readKey("qwenBrowserProfiles")) || {};
        const qwenIsAlreadyConnected = qwenProfilesInitial[profileName]?.status === "connected";

        const closeChromeGracefullyQwen = () => {
          http
            .get(
              `http://localhost:${debuggingPort}/json/version`,
              (versionRes) => {
                let versionData = "";
                versionRes.on("data", (chunk) => (versionData += chunk));
                versionRes.on("end", () => {
                  try {
                    const versionInfo = JSON.parse(versionData);
                    const browserWsUrl = versionInfo.webSocketDebuggerUrl;
                    if (browserWsUrl) {
                      const WebSocket = require("ws");
                      const browserWs = new WebSocket(browserWsUrl);
                      browserWs.on("open", () => {
                        browserWs.send(
                          JSON.stringify({ id: 999, method: "Browser.close" }),
                        );
                        setTimeout(() => {
                          if (!chromeProcess.killed) chromeProcess.kill();
                        }, 5000);
                      });
                      browserWs.on("error", () => chromeProcess.kill());
                    } else {
                      chromeProcess.kill();
                    }
                  } catch (_) {
                    chromeProcess.kill();
                  }
                });
              },
            )
            .on("error", () => chromeProcess.kill());
        };

        const saveQwenProfile = async (token, cdpCookies) => {
          if (qwenConnectionDetected) return;
          qwenConnectionDetected = true;

          const cookieString = cdpCookies
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");

          // Extend session cookies to 30 days
          const extendedCookies = cdpCookies.map((c) => {
            const cookie = { ...c };
            if (!cookie.expires || cookie.expires === -1 || cookie.expires === 0) {
              cookie.expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
            }
            return cookie;
          });

          const qwenProfiles = (await readKey("qwenBrowserProfiles")) || {};
          qwenProfiles[profileName] = qwenProfiles[profileName] || {};
          qwenProfiles[profileName].status = "connected";
          qwenProfiles[profileName].token = token;
          qwenProfiles[profileName].cookies = cookieString;
          qwenProfiles[profileName].cdpCookies = extendedCookies;
          qwenProfiles[profileName].updatedAt = new Date().toISOString();
          await updateData("qwenBrowserProfiles", qwenProfiles);

          if (!qwenIsAlreadyConnected) {
            if (!alertShown) {
              alertShown = true;
              showAlert(
                "Qwen AI profile connected successfully. The browser will close automatically in 5 seconds.",
                5,
              );
            }
            setTimeout(() => {
              if (qwenNetworkWs) {
                try { qwenNetworkWs.close(); } catch (_) {}
              }
              if (!chromeProcess.killed) {
                closeChromeGracefullyQwen();
              }
            }, 5000);
          } else {
            console.log(`[Qwen Browser] Profile "${profileName}" already connected, keeping browser open`);
          }
        };

        const connectToQwenCDP = () => {
          if (qwenConnectionDetected) return;
          http
            .get(`http://localhost:${debuggingPort}/json`, (res) => {
              let body = "";
              res.on("data", (chunk) => (body += chunk));
              res.on("end", () => {
                try {
                  const targets = JSON.parse(body);
                  const wsDebuggerUrl = targets[0]?.webSocketDebuggerUrl;
                  if (!wsDebuggerUrl) return;

                  const WebSocket = require("ws");
                  const ws = new WebSocket(wsDebuggerUrl);
                  qwenNetworkWs = ws;

                  ws.on("open", () => {
                    // Enable Network and Runtime domains
                    ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
                    ws.send(JSON.stringify({ id: 2, method: "Runtime.enable" }));
                  });

                  ws.on("message", async (raw) => {
                    if (qwenConnectionDetected) return;
                    try {
                      const msg = JSON.parse(raw);

                      // Detect authenticated API requests (only happen when logged in)
                      if (msg.method === "Network.requestWillBeSent") {
                        const reqUrl = msg.params?.request?.url || "";
                        if (
                          reqUrl.includes("chat.qwen.ai/api/v2/") &&
                          !ws._qwenCapturing
                        ) {
                          ws._qwenCapturing = true;
                          // Step 1: Check current page URL first before capturing anything
                          ws.send(
                            JSON.stringify({
                              id: 9,
                              method: "Runtime.evaluate",
                              params: { expression: "window.location.href" },
                            }),
                          );
                        }
                      }

                      // Step 1 result: URL check — abort if on signup/activation/verification page
                      if (msg.id === 9 && msg.result?.result) {
                        const currentUrl = msg.result.result.value || "";
                        const isOnAuthPage =
                          /\/(signup|register|activation|activate|verify|email.verify|login|sso|auth)/i.test(currentUrl) ||
                          /[?&]mode=(register|signup|activate|verify)/i.test(currentUrl);
                        if (isOnAuthPage) {
                          console.log(`[Qwen Browser] Skipping capture — on auth/activation page: ${currentUrl}`);
                          ws._qwenCapturing = false;
                          ws._capturedQwenToken = null;
                        } else {
                          // Step 2: Check DOM for account-pending-overlay
                          ws.send(JSON.stringify({
                            id: 12,
                            method: "Runtime.evaluate",
                            params: { expression: "!!document.querySelector('.account-pending-overlay')" },
                          }));
                        }
                      }

                      // Step 2 result: DOM overlay check — abort if account activation is pending
                      if (msg.id === 12 && msg.result?.result) {
                        const hasPendingOverlay = msg.result.result.value === true;
                        if (hasPendingOverlay) {
                          console.log(`[Qwen Browser] Skipping capture — account pending activation overlay detected`);
                          ws._qwenCapturing = false;
                          ws._capturedQwenToken = null;
                        } else {
                          // Step 3: Both checks passed — now capture token and cookies
                          ws.send(
                            JSON.stringify({
                              id: 10,
                              method: "Runtime.evaluate",
                              params: { expression: "localStorage.getItem('token')" },
                            }),
                          );
                          ws.send(
                            JSON.stringify({
                              id: 11,
                              method: "Network.getCookies",
                              params: { urls: ["https://chat.qwen.ai", "https://chat.qwen.ai/"] },
                            }),
                          );
                        }
                      }

                      // Handle Runtime.evaluate response (token)
                      if (msg.id === 10 && msg.result?.result) {
                        ws._capturedQwenToken = msg.result.result.value || null;
                      }

                      // Handle getCookies response — save when both token and cookies are ready
                      if (msg.id === 11 && msg.result?.cookies) {
                        const token = ws._capturedQwenToken;
                        if (token) {
                          await saveQwenProfile(token, msg.result.cookies);
                        } else {
                          // Token not yet captured; retry evaluate once more
                          ws._qwenCapturing = false;
                        }
                      }
                    } catch (_) {}
                  });

                  ws.on("error", () => {});
                } catch (_) {}
              });
            })
            .on("error", () => {});
        };

        // Start CDP connection after a short delay to allow the tab to open
        setTimeout(connectToQwenCDP, 3000);
      } else if (method === "tiktokads") {
        // ── TikTok Ads (Browser) profile connection ───────────────────────
        // Strategy: connect to CDP after the tab opens, enable Network +
        // Runtime events. When the user logs in, the TikTok Ads Creative
        // Studio makes authenticated requests to ads.tiktok.com/creative_bff.
        // We detect those, verify the page is not a login page, then capture
        // all cookies for the domain and confirm a `sessionid` cookie exists.

        let tiktokConnectionDetected = false;
        let tiktokNetworkWs = null;

        const tiktokProfilesInitial = (await readKey("tiktokAdsProfiles")) || {};
        const tiktokIsAlreadyConnected =
          tiktokProfilesInitial[profileName]?.status === "connected";

        const closeChromeGracefullyTikTok = () => {
          http
            .get(
              `http://localhost:${debuggingPort}/json/version`,
              (versionRes) => {
                let versionData = "";
                versionRes.on("data", (chunk) => (versionData += chunk));
                versionRes.on("end", () => {
                  try {
                    const versionInfo = JSON.parse(versionData);
                    const browserWsUrl = versionInfo.webSocketDebuggerUrl;
                    if (browserWsUrl) {
                      const WebSocket = require("ws");
                      const browserWs = new WebSocket(browserWsUrl);
                      browserWs.on("open", () => {
                        browserWs.send(
                          JSON.stringify({ id: 999, method: "Browser.close" }),
                        );
                        setTimeout(() => {
                          if (!chromeProcess.killed) chromeProcess.kill();
                        }, 5000);
                      });
                      browserWs.on("error", () => chromeProcess.kill());
                    } else {
                      chromeProcess.kill();
                    }
                  } catch (_) {
                    chromeProcess.kill();
                  }
                });
              },
            )
            .on("error", () => chromeProcess.kill());
        };

        const saveTikTokProfile = async (cdpCookies) => {
          if (tiktokConnectionDetected) return;

          // Require a sessionid cookie to confirm a real logged-in session
          const hasSession = cdpCookies.some(
            (c) => c.name === "sessionid" && c.value,
          );
          if (!hasSession) return;

          tiktokConnectionDetected = true;

          const cookieString = cdpCookies
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");

          // Extend session cookies to 30 days
          const extendedCookies = cdpCookies.map((c) => {
            const cookie = { ...c };
            if (!cookie.expires || cookie.expires === -1 || cookie.expires === 0) {
              cookie.expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
            }
            return cookie;
          });

          const tiktokProfiles = (await readKey("tiktokAdsProfiles")) || {};
          tiktokProfiles[profileName] = tiktokProfiles[profileName] || {};
          tiktokProfiles[profileName].status = "connected";
          tiktokProfiles[profileName].cookies = cookieString;
          tiktokProfiles[profileName].cdpCookies = extendedCookies;
          tiktokProfiles[profileName].updatedAt = new Date().toISOString();
          await updateData("tiktokAdsProfiles", tiktokProfiles);

          if (!tiktokIsAlreadyConnected) {
            if (!alertShown) {
              alertShown = true;
              showAlert(
                "TikTok Ads profile connected successfully. The browser will close automatically in 5 seconds.",
                5,
              );
            }
            setTimeout(() => {
              if (tiktokNetworkWs) {
                try { tiktokNetworkWs.close(); } catch (_) {}
              }
              if (!chromeProcess.killed) {
                closeChromeGracefullyTikTok();
              }
            }, 5000);
          } else {
            console.log(`[TikTok Ads] Profile "${profileName}" already connected, keeping browser open`);
          }
        };

        const connectToTikTokCDP = () => {
          if (tiktokConnectionDetected) return;
          http
            .get(`http://localhost:${debuggingPort}/json`, (res) => {
              let body = "";
              res.on("data", (chunk) => (body += chunk));
              res.on("end", () => {
                try {
                  const targets = JSON.parse(body);
                  const wsDebuggerUrl = targets[0]?.webSocketDebuggerUrl;
                  if (!wsDebuggerUrl) return;

                  const WebSocket = require("ws");
                  const ws = new WebSocket(wsDebuggerUrl);
                  tiktokNetworkWs = ws;

                  ws.on("open", () => {
                    ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
                    ws.send(JSON.stringify({ id: 2, method: "Runtime.enable" }));
                  });

                  ws.on("message", async (raw) => {
                    if (tiktokConnectionDetected) return;
                    try {
                      const msg = JSON.parse(raw);

                      // Detect authenticated BFF requests (only happen when logged in)
                      if (msg.method === "Network.requestWillBeSent") {
                        const reqUrl = msg.params?.request?.url || "";
                        if (
                          reqUrl.includes("ads.tiktok.com/creative_bff") &&
                          !ws._tiktokCapturing
                        ) {
                          ws._tiktokCapturing = true;
                          // Step 1: Check current page URL before capturing
                          ws.send(
                            JSON.stringify({
                              id: 9,
                              method: "Runtime.evaluate",
                              params: { expression: "window.location.href" },
                            }),
                          );
                        }
                      }

                      // Step 1 result: URL check — abort if on a login/auth page
                      if (msg.id === 9 && msg.result?.result) {
                        const currentUrl = msg.result.result.value || "";
                        const isOnAuthPage =
                          /\/(login|signup|passport|account\/login)/i.test(currentUrl);
                        if (isOnAuthPage) {
                          console.log(`[TikTok Ads] Skipping capture — on auth page: ${currentUrl}`);
                          ws._tiktokCapturing = false;
                        } else {
                          // Step 2: Capture cookies for the ads domain
                          ws.send(
                            JSON.stringify({
                              id: 11,
                              method: "Network.getCookies",
                              params: { urls: ["https://ads.tiktok.com", "https://ads.tiktok.com/"] },
                            }),
                          );
                        }
                      }

                      // Step 2 result: getCookies response — save if sessionid present
                      if (msg.id === 11 && msg.result?.cookies) {
                        await saveTikTokProfile(msg.result.cookies);
                        // Allow retry if sessionid wasn't ready yet
                        if (!tiktokConnectionDetected) {
                          ws._tiktokCapturing = false;
                        }
                      }
                    } catch (_) {}
                  });

                  ws.on("error", () => {});
                } catch (_) {}
              });
            })
            .on("error", () => {});
        };

        // Start CDP connection after a short delay to allow the tab to open
        setTimeout(connectToTikTokCDP, 3000);
      }
    },
  );

  // Monitoring handlers - optimized
  ipcMain.handle("getMonitoringData", async () => {
    const monitoringData = await getMonitoringData();
    return monitoringData;
  });

  ipcMain.handle(
    "getBrowserScreenshot",
    async (event, profileName, debuggingPort) => {
      try {
        const screenshot = await getBrowserScreenshot(debuggingPort);
        return screenshot;
      } catch (error) {
        console.error("Error getting browser screenshot:", error);
        return null;
      }
    },
  );

  // Get active spy browser info for preview
  ipcMain.handle("getSpyBrowserInfo", async (event, profileName) => {
    try {
      if (!global.activeSpyBrowsers) {
        return { success: false, error: "No active spy browsers" };
      }
      const browserInfo = global.activeSpyBrowsers.get(profileName);
      if (!browserInfo) {
        return { success: false, error: "Spy browser not found for profile" };
      }
      return {
        success: true,
        port: browserInfo.port,
        startedAt: browserInfo.startedAt,
      };
    } catch (error) {
      console.error("Error getting spy browser info:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("killBrowserInstance", async (event, pid) => {
    try {
      const processInfo = global.spyProcesses?.get(pid);
      if (processInfo && processInfo.process && !processInfo.process.killed) {
        processInfo.process.kill("SIGTERM");
        setTimeout(() => {
          if (!processInfo.process.killed) {
            processInfo.process.kill("SIGKILL");
          }
        }, 2000);
        return { success: true };
      }
      return { success: false, error: "Process not found" };
    } catch (error) {
      console.error("Error killing browser instance:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("unblockMidjourneyProfile", async (event, profileId) => {
    try {
      const { unblockProfile } = require("../automations/midjourneyV2");
      unblockProfile(profileId);
      return { success: true };
    } catch (error) {
      console.error("Error unblocking Midjourney profile:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("inpaint-image", async (_, imageName, maskDataUrl) => {
    try {
      console.log(`[INPAINT] Processing request for image: ${imageName}`);
      const userDataPath = app.getPath("userData");
      const imagesDir = path.join(userDataPath, "Images");

      // Handle both full paths (from FB Insights) and simple filenames
      const isFullPath = path.isAbsolute(imageName);
      const baseName = isFullPath ? path.basename(imageName) : imageName;
      const imagePath = isFullPath
        ? imageName
        : path.join(imagesDir, imageName);

      console.log(`[INPAINT] Image path: ${imagePath}`);
      console.log(`[INPAINT] Mask data URL length: ${maskDataUrl.length}`);

      // Create temporary mask file
      const maskBuffer = Buffer.from(
        maskDataUrl.replace(/^data:image\/png;base64,/, ""),
        "base64",
      );
      const tempMaskName = `temp_mask_${Date.now()}.png`;
      const tempMaskPath = path.join(imagesDir, tempMaskName);
      await fs.writeFile(tempMaskPath, maskBuffer);

      console.log(`[INPAINT] Mask saved to: ${tempMaskPath}`);
      console.log(`[INPAINT] Mask buffer size: ${maskBuffer.length} bytes`);

      // Generate output filename using base name
      const inpaintedName = baseName.replace(/(\.[^.]+)$/, "_inpainted$1");
      const outPath = path.join(imagesDir, inpaintedName);

      console.log(`[INPAINT] Output path: ${outPath}`);

      // Perform inpainting
      console.log(`[INPAINT] Calling inpaintOnce API...`);
      const result = await inpaintOnce({
        imagePath,
        maskPath: tempMaskPath,
        outPath,
      });

      console.log(`[INPAINT] API result:`, result);

      // Clean up temporary mask file
      try {
        await fs.unlink(tempMaskPath);
      } catch (e) {
        console.warn("Failed to clean up temporary mask file:", e.message);
      }

      return {
        success: true,
        inpaintedImageName: inpaintedName,
        result: result,
      };
    } catch (error) {
      console.error("Inpainting error:", error);
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  });

  // Download file to user data directory
  ipcMain.handle("download-file-to-userdata", async (_, url) => {
    try {
      const filePath = await downloadFileToUserData(url);
      return { success: true, filePath };
    } catch (error) {
      console.error("Download file error:", error);
      return { success: false, error: error.message || String(error) };
    }
  });

  // Fetch music library from server
  ipcMain.handle("get-music-library", async () => ({ success: true, musics: [], categories: [], total: 0 }));

  ipcMain.handle("humanize-ai-text", async (_, payload) => {
    const text = typeof payload === "string" ? payload : payload?.text;
    const requestedAttempts = typeof payload === "object" ? Number(payload?.maxAttempts) : 1;
    const maxAttempts = Math.min(
      MAX_HUMANIZE_ATTEMPTS,
      Math.max(1, Number.isFinite(requestedAttempts) ? Math.trunc(requestedAttempts) : 1),
    );
    try {
      const originalText = String(text || "");
      console.log(`[AITextHumanizer] Starting request (${originalText.length} characters, up to ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"})`);
      return { success: true, ...(await humanizeText(originalText, { maxAttempts })) };
    } catch (error) {
      const reason = error instanceof AIHumanizerError ? error.reason : "unexpected";
      console.error(`[AITextHumanizer] API request failed [${reason}]:`, error.message);
      return { success: false, reason, error: error.message || "The text could not be humanized." };
    }
  });

  ipcMain.handle("score-ai-image", async (_event, imagePath) => {
    try {
      const aiDetectionSettings = readKey("aiDetectionSettings") || {};
      if (aiDetectionSettings.imageScoresEnabled === false) {
        return { success: false, disabled: true, error: "Image AI scoring is disabled in Settings" };
      }

      const path = require("path");
      const { app } = require("electron");
      const { scoreZeroGptImage } = require("./zeroGptImageScore");
      const { scoreSightengineImage } = require("./sightengineImageScore");
      const resolvedPath = path.resolve(String(imagePath || ""));
      const userDataRoot = path.resolve(app.getPath("userData"));
      const relativePath = path.relative(userDataRoot, resolvedPath);

      // Copy-paste modal images are staged below userData/Uploads/Temp. Do not
      // expose an unrestricted renderer-to-filesystem upload primitive.
      if (
        !relativePath ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
      ) {
        return { success: false, error: "Image is outside the application data folder" };
      }

      const [zeroGptResult, sightengineResult] = await Promise.allSettled([
        scoreZeroGptImage(resolvedPath),
        scoreSightengineImage(resolvedPath),
      ]);
      const zeroGpt = zeroGptResult.status === "fulfilled"
        ? zeroGptResult.value
        : { success: false, error: zeroGptResult.reason?.message || "ZeroGPT score unavailable" };
      const sightengine = sightengineResult.status === "fulfilled"
        ? sightengineResult.value
        : { success: false, error: sightengineResult.reason?.message || "Sightengine score unavailable" };

      if (!zeroGpt.success && !sightengine.success) {
        return { success: false, error: "Image AI scores unavailable", zeroGpt, sightengine };
      }

      // Keep the original top-level ZeroGPT fields for older renderer callers.
      return {
        ...(zeroGpt.success ? zeroGpt : {}),
        success: true,
        zeroGpt,
        sightengine,
      };
    } catch (error) {
      console.warn("[AIImageScore] Scoring failed:", error.message);
      return { success: false, error: error.message || "Image score unavailable" };
    }
  });

  ipcMain.handle("score-ai-text", async (_, text) => {
    try {
      const originalText = String(text || "");
      console.log(`[AITextHumanizer] Checking originality (${originalText.length} characters)`);
      return { success: true, ...(await scoreText(originalText)) };
    } catch (error) {
      const reason = error instanceof AIHumanizerError ? error.reason : "unexpected";
      console.error(`[AITextHumanizer] Originality check failed [${reason}]:`, error.message);
      return { success: false, reason, error: error.message || "The originality score could not be checked." };
    }
  });

  ipcMain.handle("humanize-ai-texts", async (event, payload) => {
    const texts = Array.isArray(payload?.texts)
      ? payload.texts.map((value) => String(value || "").trim())
      : [];
    const requestId = String(payload?.requestId || "");
    const total = texts.length;
    const sendProgress = (data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("humanize-ai-texts-progress", { requestId, total, ...data });
      }
    };

    if (!total || total > 1000) {
      return { success: false, reason: "invalid_texts", error: "Provide between 1 and 1,000 text outputs." };
    }

    let cancelled = false;
    const controller = new AbortController();
    aiHumanizerBatchCancellations.set(requestId, () => {
      cancelled = true;
      controller.abort();
    });

    try {
      sendProgress({ completed: 0, phase: "starting" });
      const completed = await humanizeTexts(texts, {
        signal: controller.signal,
        concurrency: 3,
        onProgress: ({ completed: completedCount, result }) => {
          sendProgress({
            completed: completedCount,
            phase: "humanizing",
            score: result.finalAiScore ?? result.aiScore ?? null,
          });
        },
      });
      sendProgress({ completed: total, phase: "complete", failedCount: completed.failedCount });
      return { success: true, ...completed };
    } catch (error) {
      if (cancelled || error?.reason === "cancelled") {
        sendProgress({ phase: "cancelled" });
        return { success: false, cancelled: true, reason: "cancelled" };
      }
      const reason = error instanceof AIHumanizerError ? error.reason : "unexpected";
      console.error(`[AITextHumanizer] Workflow batch failed [${reason}]:`, error.message);
      sendProgress({ phase: "failed", error: error.message || "Text humanization failed." });
      return { success: false, reason, error: error.message || "The workflow text outputs could not be humanized." };
    } finally {
      aiHumanizerBatchCancellations.delete(requestId);
    }
  });

  ipcMain.handle("cancel-humanize-ai-texts", async (_, requestId) => {
    const cancel = aiHumanizerBatchCancellations.get(String(requestId || ""));
    if (!cancel) return { success: true, alreadyFinished: true };
    try {
      await cancel();
      return { success: true };
    } catch (error) {
      console.warn("[AITextHumanizer] Batch cancellation warning:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Download music file from server to local Musics folder
  ipcMain.handle("download-music-file", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // List local music files from userData/Musics folder
  ipcMain.handle("get-local-musics", async () => {
    try {
      const musicDir = path.join(app.getPath("userData"), "Musics");
      await fs.mkdir(musicDir, { recursive: true });
      const files = await fs.readdir(musicDir);
      const audioExts = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".wma"];
      const musics = files
        .filter(f => audioExts.includes(path.extname(f).toLowerCase()))
        .map(f => ({ filename: f, filePath: path.join(musicDir, f) }));
      return { success: true, musics };
    } catch (error) {
      console.error("[MusicLibrary] List local error:", error.message);
      return { success: false, error: error.message, musics: [] };
    }
  });

  // ========== Video Editor: safe media import/delete ==========
  // Copies an external file into userData/VideoEditorMedia so the original can be safely moved/deleted.
  ipcMain.handle("ve-import-media-file", async (_, { filePath: srcPath }) => {
    try {
      const mediaDir = path.join(app.getPath("userData"), "VideoEditorMedia");
      await fs.mkdir(mediaDir, { recursive: true });

      const ext = path.extname(srcPath);
      const base = path.basename(srcPath, ext).replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 60);
      const uniqueId = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const destName = base + "_" + uniqueId + ext;
      const destPath = path.join(mediaDir, destName);

      await fs.copyFile(srcPath, destPath);
      return { success: true, filePath: destPath, name: path.basename(srcPath) };
    } catch (error) {
      console.error("[VEImportMedia] Copy error:", error.message);
      return { success: false, error: error.message || String(error) };
    }
  });

  // Deletes a file that is inside userData/VideoEditorMedia (safety-checked).
  ipcMain.handle("ve-delete-media-file", async (_, { filePath: targetPath }) => {
    try {
      const mediaDir = path.join(app.getPath("userData"), "VideoEditorMedia");
      const resolved = path.resolve(targetPath);
      const safeDirPrefix = path.resolve(mediaDir) + path.sep;
      // Security check: only delete files we own.
      // Use case-insensitive comparison on Windows since NTFS is case-insensitive.
      const isOwned = process.platform === "win32"
        ? resolved.toLowerCase().startsWith(safeDirPrefix.toLowerCase())
        : resolved.startsWith(safeDirPrefix);
      if (!isOwned) {
        console.warn("[VEDeleteMedia] Blocked deletion outside VideoEditorMedia:", resolved);
        return { success: false, error: "File is not in the VideoEditorMedia directory" };
      }
      try {
        await fs.unlink(resolved);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error("[VEDeleteMedia] Unlink failed:", err.message);
          return { success: false, error: err.message };
        }
      }
      return { success: true };
    } catch (error) {
      console.error("[VEDeleteMedia] Delete error:", error.message);
      return { success: false, error: error.message || String(error) };
    }
  });

  // Call OpenAI API
  ipcMain.handle(
    "call-openai",
    async (_, apiKey, model, prompt, temperature = 0.7) => {
      try {
        const { openAi } = require("../automations/openai");
        const result = await openAi(apiKey, model, prompt, temperature);
        return result;
      } catch (error) {
        console.error("OpenAI call error:", error);
        return { success: false, value: error.message || String(error) };
      }
    },
  );

  // ========== Smart Split - AI Content Analysis ==========
  // Analyzes a post image+text to detect multiple items (recipes, decorations, etc.)
  // Returns count and description of each item found
  let smartSplitKeyIndex = 0;

  ipcMain.handle(
    "analyze-post-content",
    async (_, { imagePath, postText, aiProvider, niche }) => {
      try {
        // Validate inputs
        if (!aiProvider) {
          return { success: false, error: "No AI provider selected." };
        }

        // Read and resize image (same as policy check - 512px, JPEG 70%)
        let imageBase64 = null;
        if (imagePath) {
          try {
            const sharp = require("sharp");
            const resizedBuffer = await sharp(imagePath)
              .resize(512, 512, {
                fit: "inside",
                withoutEnlargement: true,
              })
              .jpeg({ quality: 70 })
              .toBuffer();

            imageBase64 = `data:image/jpeg;base64,${resizedBuffer.toString("base64")}`;
            console.log(
              `[Smart Split] Resized image to ~512px, ${Math.round(resizedBuffer.length / 1024)}KB`,
            );
          } catch (imgErr) {
            console.error("[Smart Split] Failed to process image:", imgErr.message);
            try {
              const imageBuffer = await fs.readFile(imagePath);
              const mimeType = imagePath.toLowerCase().endsWith(".png")
                ? "image/png"
                : "image/jpeg";
              imageBase64 = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
              console.warn("[Smart Split] Using original image (resize failed)");
            } catch (fallbackErr) {
              console.error("[Smart Split] Failed to read image:", fallbackErr.message);
            }
          }
        }

        if (!imageBase64) {
          return { success: false, error: "Failed to read post image." };
        }

        const nicheHint = niche && niche.trim() ? ` The content domain is: ${niche.trim()}.` : "";

        const prompt = `Analyze this image and the accompanying text below.${nicheHint}

Your task is to determine how many DISTINCT CONTENT TOPICS are presented in this image. A "content topic" means a separate subject, idea, recipe, product, tip, or item being showcased. Do NOT count visual elements like text overlays, banners, backgrounds, or decorative sections as separate items — they are part of the same topic if they describe the same thing.

For example:
- A single recipe with a photo and ingredient list = 1 item (one recipe)
- A collage showing 3 different recipes side by side = 3 items
- A single product shown from multiple angles = 1 item
- An image grid of 4 different outfit ideas = 4 items

For EACH distinct content topic, provide a clear, descriptive title (10-20 words) that captures what the item is about in enough detail that someone could recreate or find it. Include specific names, flavors, styles, or key characteristics — not just generic labels.

For example:
- Good: "Marble Cake with Chocolate Swirl and Vanilla Glaze - Classic Homemade Recipe"
- Bad: "Marble Cake Recipe"

${postText ? `Post text: ${postText}` : "No text provided with this post."}

Respond ONLY with valid JSON in this exact format, no extra text:
{"count": N, "items": [{"description": "Short title of item 1"}, {"description": "Short title of item 2"}]}`;

        let result = null;
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;

        const isRetryableError = (err) => {
          const msg = (typeof err === "string" ? err : err?.message || err?.value || "").toLowerCase();
          return (
            msg.includes("econnreset") ||
            msg.includes("etimedout") ||
            msg.includes("econnrefused") ||
            msg.includes("socket hang up") ||
            msg.includes("network") ||
            msg.includes("timeout") ||
            msg.includes("server_error") ||
            msg.includes("error: 500") ||
            msg.includes("error: 502") ||
            msg.includes("error: 503") ||
            msg.includes("error: 429") ||
            msg.includes("rate_limit") ||
            msg.includes("overloaded")
          );
        };

        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        if (
          !["openai", "googleai", "anthropic", "openrouter", "chineseai"].includes(
            aiProvider,
          )
        ) {
          return { success: false, error: `Unknown AI provider: ${aiProvider}` };
        }

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          if (aiProvider === "openai") {
            const openaiKeys = (await readKey("openaiKeys")) || {};
            const openaiKeyList = Object.entries(openaiKeys)
              .filter(([, v]) => !v.status || v.status === "active")
              .map(([k]) => k);

            if (openaiKeyList.length === 0) {
              return {
                success: false,
                error: "No active OpenAI API keys configured.",
              };
            }

            const startIdx = smartSplitKeyIndex % openaiKeyList.length;
            for (let ki = 0; ki < openaiKeyList.length; ki++) {
              const keyIdx = (startIdx + ki) % openaiKeyList.length;
              const apiKey = openaiKeyList[keyIdx];
              const keyLabel =
                openaiKeys[apiKey]?.label || `key #${keyIdx + 1}`;
              try {
                const contentArray = [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: imageBase64 } },
                ];

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 60000);

                const response = await fetch(
                  "https://api.openai.com/v1/chat/completions",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model: "gpt-5-nano",
                      messages: [{ role: "user", content: contentArray }],
                      max_completion_tokens: 4096,
                    }),
                    signal: controller.signal,
                  },
                );

                clearTimeout(timeoutId);

                if (!response.ok) {
                  const errBody = await response.text().catch(() => "");
                  console.warn(
                    `[Smart Split] OpenAI key "${keyLabel}" returned ${response.status}: ${errBody.slice(0, 200)}`,
                  );
                  if ([429, 500, 502, 503].includes(response.status)) continue;
                  break;
                }

                const data = await response.json();
                const message = data?.choices?.[0]?.message?.content;
                if (message) {
                  result = { success: true, value: message };
                  smartSplitKeyIndex = keyIdx + 1;
                  console.log(
                    `[Smart Split] Used OpenAI gpt-5-nano with key "${keyLabel}" (attempt ${attempt})`,
                  );
                  break;
                }
              } catch (e) {
                console.warn(
                  `[Smart Split] OpenAI key "${keyLabel}" failed (attempt ${attempt}):`,
                  e.message,
                );
                if (isRetryableError(e)) continue;
                break;
              }
            }
          } else if (aiProvider === "googleai") {
            try {
              const { googleAI } = require("../automations/googleai");
              result = await googleAI(
                "gemini-2.0-flash",
                prompt,
                0.3,
                imageBase64,
                null,
                4096,
                60000,
              );
              if (result.success) {
                console.log(
                  `[Smart Split] Used Google AI gemini-2.0-flash (attempt ${attempt})`,
                );
              }
            } catch (e) {
              console.warn(
                `[Smart Split] Google AI failed (attempt ${attempt}):`,
                e.message,
              );
              if (isRetryableError(e) && attempt < MAX_RETRIES) {
                await delay(RETRY_DELAY_MS);
                continue;
              }
            }
          } else if (aiProvider === "anthropic") {
            try {
              const { anthropic } = require("../automations/anthropic");
              result = await anthropic(
                "claude-3-5-haiku-20241022",
                prompt,
                0.3,
                imageBase64,
                null,
                4096,
                60000,
              );
              if (result.success) {
                console.log(
                  `[Smart Split] Used Anthropic claude-3-5-haiku (attempt ${attempt})`,
                );
              }
            } catch (e) {
              console.warn(
                `[Smart Split] Anthropic failed (attempt ${attempt}):`,
                e.message,
              );
              if (isRetryableError(e) && attempt < MAX_RETRIES) {
                await delay(RETRY_DELAY_MS);
                continue;
              }
            }
          } else if (aiProvider === "openrouter") {
            try {
              const { openrouter } = require("../automations/openrouter");
              result = await openrouter(
                "google/gemini-2.0-flash-001",
                prompt,
                0.3,
                imageBase64,
                null,
                4096,
                60000,
              );
              if (result.success) {
                console.log(
                  `[Smart Split] Used OpenRouter gemini-2.0-flash (attempt ${attempt})`,
                );
              }
            } catch (e) {
              console.warn(
                `[Smart Split] OpenRouter failed (attempt ${attempt}):`,
                e.message,
              );
              if (isRetryableError(e) && attempt < MAX_RETRIES) {
                await delay(RETRY_DELAY_MS);
                continue;
              }
            }
          } else if (aiProvider === "chineseai") {
            try {
              const { chineseai } = require("../automations/chineseai");
              result = await chineseai(
                "qwen-vl-max",
                prompt,
                0.3,
                imageBase64,
                null,
                4096,
                60000,
              );
              if (result.success) {
                console.log(
                  `[Smart Split] Used Chinese AI qwen-vl-max (attempt ${attempt})`,
                );
              }
            } catch (e) {
              console.warn(
                `[Smart Split] Chinese AI failed (attempt ${attempt}):`,
                e.message,
              );
              if (isRetryableError(e) && attempt < MAX_RETRIES) {
                await delay(RETRY_DELAY_MS);
                continue;
              }
            }
          }

          // If we got a successful result, break the retry loop
          if (result?.success) break;

          // If provider failed with a retryable error, retry
          if (attempt < MAX_RETRIES) {
            const errVal = result?.value || "";
            if (isRetryableError(errVal)) {
              console.log(
                `[Smart Split] Provider failed with retryable error, attempt ${attempt}/${MAX_RETRIES}, retrying in ${RETRY_DELAY_MS}ms...`,
              );
              result = null;
              await delay(RETRY_DELAY_MS);
              continue;
            }
          }

          // Non-retryable failure or max retries reached
          break;
        }

        if (!result || !result.success) {
          return {
            success: false,
            error:
              result?.value || "AI provider failed to analyze the content.",
          };
        }

        // Parse JSON response
        try {
          let jsonStr = result.value;
          jsonStr = jsonStr.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const analysis = JSON.parse(jsonStr);

          // Validate structure
          if (
            typeof analysis.count !== "number" ||
            !Array.isArray(analysis.items)
          ) {
            return {
              success: false,
              error: "AI returned invalid format. Please try again.",
              rawResponse: result.value,
            };
          }

          return { success: true, count: analysis.count, items: analysis.items };
        } catch (parseErr) {
          console.error("[Smart Split] Failed to parse AI response:", result.value);
          return {
            success: false,
            error: "Failed to parse AI analysis. Please try again.",
            rawResponse: result.value,
          };
        }
      } catch (error) {
        console.error("[Smart Split] Error:", error);
        return {
          success: false,
          error: error.message || "An unexpected error occurred.",
        };
      }
    },
  );

  // Round-robin index for policy check OpenAI key rotation (persists across calls)
  let policyCheckKeyIndex = 0;

  // Check Post Policy Violation - Uses cheapest vision models to check for Facebook/Pinterest policy violations
  // Optimized: Resizes images to reduce token usage (vision tokens scale with image size)
  ipcMain.handle(
    "check-post-policy-violation",
    async (_, { imagePath, text, title, description, platform }) => {
      try {
        // Determine which AI provider to use (prefer cheapest with vision support)
        const openaiKeys = (await readKey("openaiKeys")) || {};
        const anthropicKeys = (await readKey("anthropicKeys")) || {};
        const googleaiKeys = (await readKey("googleaiKeys")) || {};

        const hasOpenAI = Object.keys(openaiKeys).length > 0;
        const hasAnthropic = Object.keys(anthropicKeys).length > 0;
        const hasGoogleAI = Object.keys(googleaiKeys).length > 0;

        if (!hasOpenAI && !hasAnthropic && !hasGoogleAI) {
          return {
            success: false,
            error: "No AI API keys configured. Please add OpenAI, Anthropic, or Google AI keys in Settings.",
          };
        }

        // Read image, resize for policy check (512px max - sufficient for violation detection)
        // This dramatically reduces token usage (from ~37K to ~2K tokens)
        let imageBase64 = null;
        if (imagePath) {
          try {
            const sharp = require("sharp");
            const resizedBuffer = await sharp(imagePath)
              .resize(512, 512, { 
                fit: "inside",  // Maintain aspect ratio, fit within 512x512
                withoutEnlargement: true  // Don't upscale small images
              })
              .jpeg({ quality: 70 })  // Convert to JPEG with moderate compression
              .toBuffer();
            
            imageBase64 = `data:image/jpeg;base64,${resizedBuffer.toString("base64")}`;
            console.log(`[Policy Check] Resized image from ${imagePath} to ~512px, ${Math.round(resizedBuffer.length / 1024)}KB`);
          } catch (imgErr) {
            console.error("[Policy Check] Failed to process image:", imgErr.message);
            // Fallback: try reading without resize
            try {
              const imageBuffer = await fs.readFile(imagePath);
              const mimeType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
              imageBase64 = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
              console.warn("[Policy Check] Using original image (resize failed)");
            } catch (fallbackErr) {
              console.error("[Policy Check] Failed to read image:", fallbackErr.message);
            }
          }
        }

        // Combine text content (no truncation - send full post)
        const textContent = [
          title ? `Title: ${title}` : "",
          description ? `Desc: ${description}` : "",
          text ? `Text: ${text}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        // Extended platform-specific policy check prompt
        const platformName = platform === "pinterest" ? "Pinterest" : "Facebook";
        
        // Get app language for response localization
        const appLanguage = (await readKey("appLanguage")) || "en";
        const languageNames = {
          en: "English",
          fr: "French",
          ar: "Arabic"
        };
        const responseLanguage = languageNames[appLanguage] || "English";
        
        // Platform-specific violation categories (compact to reduce tokens)
        const facebookRules = `FACEBOOK RULES:
- ENGAGEMENT BAIT (HIGH): Any request for likes/shares/comments/reactions/tags. Questions designed to get comments ("What do you think?", "Which would you choose?", "Yes or no?", "Caption this!", "Rate 1-10", etc). Reaction bait ("Love = Yes"). Religious bait ("Type AMEN"). Completion prompts ("Finish this sentence...").
- CLICKBAIT (MEDIUM): "You WON'T BELIEVE...", exaggerated headlines, fake urgency ("Only 2 left!", "Expires in 1 hour!").
- SPAM: Excessive emojis/caps, walls of hashtags, F4F requests.`;

        const pinterestRules = `PINTEREST RULES:
- MISLEADING PINS (HIGH): Bait-and-switch, deceptive previews.
- SPAM (MEDIUM): Pure affiliate links, MLM language, aggressive "BUY NOW" CTAs.
- HASHTAG ABUSE (MEDIUM): >10 hashtags, irrelevant stuffing.
- THIN CONTENT: No meaningful description, single-word captions.`;

        const platformRules = platform === "pinterest" ? pinterestRules : facebookRules;

        const prompt = `Social media policy checker for ${platform === "pinterest" ? "Pinterest" : "Facebook"}. Analyze the post for violations. Respond in ${responseLanguage}.

${textContent ? `POST TEXT:\n${textContent}\n` : ""}${imageBase64 ? "[Image attached]\n" : ""}
${platformRules}

SHARED RULES:
- BRAND/TRADEMARK (HIGH): Flag ONLY real commercial brands (Coca-Cola, Nike, Nestlé, Philadelphia, etc.) visible on products/packaging in image OR mentioned in text. Do NOT flag decorative/thematic text overlays like "Delicious Recipes", "Sabores Auténticos", recipe names, category labels, page taglines — these are the creator's own design.
- COPYRIGHT (HIGH): Flag ONLY if visible watermarks (Getty, Shutterstock, iStock), platform UI screenshots (TikTok, Instagram borders), or creator credits. Do NOT flag professional-looking or AI-generated images.
- HEALTH CLAIMS (MEDIUM): Unverified "cures"/"heals"/"weight loss" claims without evidence.
- CONTENT POLICY (HIGH): Hate speech, violence, adult content, dangerous activities.
- TRUST (HIGH): Fake testimonials, MLM/pyramid, "I made $X in Y days", unrealistic promises.

STRICT SEPARATION RULES:
- "imageIssues" = ONLY problems visible in the image pixels (logos, watermarks, brand labels on products, inappropriate visuals, text overlays baked into the image). Empty [] if image is clean or no image.
- "textIssues" = ONLY problems in the POST TEXT above (caption, title, description). Empty [] if text is clean or no text.
- NEVER cross-contaminate: image problems go ONLY in imageIssues, text problems go ONLY in textIssues.
- If a brand is ONLY in the image, do NOT add a textIssue. If ONLY in the text, do NOT add an imageIssue.

IMPORTANT: Only flag REAL violations with high confidence. If unsure, do NOT flag it. Respond with hasIssues:false if nothing is wrong.

JSON only (no markdown):
{"hasIssues":true/false,"severity":"none|low|medium|high","imageIssues":[{"category":"brand_trademark|copyright|content_policy|food_health|text_overlay","description":"what you see in ${responseLanguage}","severity":"low|medium|high","brandNames":"brands in image"}],"textIssues":[{"category":"engagement_bait|clickbait|brand_trademark|content_policy|trust_authenticity|hashtag_abuse|thin_content","description":"problem in ${responseLanguage}","severity":"low|medium|high","problematicText":"exact quote","suggestedFix":"fix in ${responseLanguage}"}],"overallSummary":"brief summary in ${responseLanguage}"}`;

        let result = null;
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;
        
        // Helper to check if error is retryable (network errors + server errors)
        const isRetryableError = (err) => {
          const msg = (typeof err === 'string' ? err : err?.message || err?.value || "").toLowerCase();
          return msg.includes("econnreset") || 
                 msg.includes("etimedout") || 
                 msg.includes("econnrefused") ||
                 msg.includes("socket hang up") ||
                 msg.includes("network") ||
                 msg.includes("timeout") ||
                 msg.includes("server_error") ||
                 msg.includes("error: 500") ||
                 msg.includes("error: 502") ||
                 msg.includes("error: 503") ||
                 msg.includes("error: 429") ||
                 msg.includes("rate_limit") ||
                 msg.includes("overloaded");
        };
        
        // Helper to delay
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        // Try providers in order of cost (cheapest vision models first)
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          // OpenAI: rotate through all connected API keys directly
          if (hasOpenAI && !result?.success) {
            const openaiKeyList = Object.entries(openaiKeys)
              .filter(([, v]) => !v.status || v.status === "active")
              .map(([k]) => k);

            if (openaiKeyList.length > 0) {
              const startIdx = policyCheckKeyIndex % openaiKeyList.length;
              for (let ki = 0; ki < openaiKeyList.length; ki++) {
                const keyIdx = (startIdx + ki) % openaiKeyList.length;
                const apiKey = openaiKeyList[keyIdx];
                const keyLabel = openaiKeys[apiKey]?.label || `key #${keyIdx + 1}`;
                try {
                  const contentArray = [{ type: "text", text: prompt }];
                  if (imageBase64) {
                    contentArray.push({ type: "image_url", image_url: { url: imageBase64 } });
                  }

                  const controller = new AbortController();
                  const timeoutId = setTimeout(() => controller.abort(), 60000);

                  const response = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model: "gpt-5-nano",
                      messages: [{ role: "user", content: contentArray }],
                      max_completion_tokens: 4096,
                    }),
                    signal: controller.signal,
                  });

                  clearTimeout(timeoutId);

                  if (!response.ok) {
                    const errBody = await response.text().catch(() => "");
                    console.warn(`[Policy Check] OpenAI key "${keyLabel}" returned ${response.status}: ${errBody.slice(0, 200)}`);
                    // Try next key for server/rate errors
                    if ([429, 500, 502, 503].includes(response.status)) continue;
                    // Non-retryable HTTP error, stop trying OpenAI keys
                    break;
                  }

                  const data = await response.json();
                  const message = data?.choices?.[0]?.message?.content;
                  if (message) {
                    result = { success: true, value: message };
                    policyCheckKeyIndex = keyIdx + 1; // Advance for next call
                    console.log(`[Policy Check] Used OpenAI gpt-5-nano with key "${keyLabel}" (attempt ${attempt})`);
                    break;
                  }
                } catch (e) {
                  console.warn(`[Policy Check] OpenAI key "${keyLabel}" failed (attempt ${attempt}):`, e.message);
                  // Try next key on network errors
                  if (isRetryableError(e)) continue;
                  break;
                }
              }
            }
          }

          if (!result?.success && hasGoogleAI) {
            try {
              const { googleAI } = require("../automations/googleai");
              // Use gemini-2.0-flash - fast and cheap
              result = await googleAI("gemini-2.0-flash", prompt, 0.3, imageBase64, null, 4096, 60000);
              if (result.success) {
                console.log(`[Policy Check] Used Google AI gemini-2.0-flash (attempt ${attempt})`);
              }
            } catch (e) {
              console.warn(`[Policy Check] Google AI failed (attempt ${attempt}):`, e.message);
              if (isRetryableError(e) && attempt < MAX_RETRIES) {
                console.log(`[Policy Check] Retryable error, waiting ${RETRY_DELAY_MS}ms before retry...`);
                await delay(RETRY_DELAY_MS);
                continue;
              }
            }
          }

          if (!result?.success && hasAnthropic) {
            try {
              const { anthropic } = require("../automations/anthropic");
              // Use claude-3-5-haiku - cheapest Claude vision model
              result = await anthropic("claude-3-5-haiku-20241022", prompt, 0.3, imageBase64, null, 4096, 60000);
              if (result.success) {
                console.log(`[Policy Check] Used Anthropic claude-3-5-haiku (attempt ${attempt})`);
              }
            } catch (e) {
              console.warn(`[Policy Check] Anthropic failed (attempt ${attempt}):`, e.message);
              if (isRetryableError(e) && attempt < MAX_RETRIES) {
                console.log(`[Policy Check] Retryable error, waiting ${RETRY_DELAY_MS}ms before retry...`);
                await delay(RETRY_DELAY_MS);
                continue;
              }
            }
          }
          
          // If we got a successful result, break the retry loop
          if (result?.success) break;
          
          // If all providers failed with a retryable error, retry the whole cycle
          if (attempt < MAX_RETRIES && result && isRetryableError(result.value || "")) {
            console.log(`[Policy Check] All providers failed with retryable error, attempt ${attempt}/${MAX_RETRIES}, retrying in ${RETRY_DELAY_MS}ms...`);
            result = null; // Reset result so providers are tried again
            await delay(RETRY_DELAY_MS);
            continue;
          }
          
          // Non-retryable failure or max retries reached
          break;
        }

        if (!result || !result.success) {
          return {
            success: false,
            error: result?.value || "All AI providers failed to analyze the content.",
          };
        }

        // Parse the JSON response
        try {
          let jsonStr = result.value;
          // Clean up common issues with AI response
          jsonStr = jsonStr.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const analysis = JSON.parse(jsonStr);
          return {
            success: true,
            analysis,
          };
        } catch (parseErr) {
          console.error("[Policy Check] Failed to parse AI response:", result.value);
          return {
            success: false,
            error: "Failed to parse policy analysis. Please try again.",
            rawResponse: result.value,
          };
        }
      } catch (error) {
        console.error("[Policy Check] Error:", error);
        return {
          success: false,
          error: error.message || "An unexpected error occurred.",
        };
      }
    },
  );

  // Fix text based on policy violation suggestion
  ipcMain.handle(
    "fix-policy-text",
    async (_, { originalText, issue, platform }) => {
      try {
        // Determine which AI provider to use
        const openaiKeys = (await readKey("openaiKeys")) || {};
        const anthropicKeys = (await readKey("anthropicKeys")) || {};
        const googleaiKeys = (await readKey("googleaiKeys")) || {};

        const hasOpenAI = Object.keys(openaiKeys).length > 0;
        const hasAnthropic = Object.keys(anthropicKeys).length > 0;
        const hasGoogleAI = Object.keys(googleaiKeys).length > 0;

        if (!hasOpenAI && !hasAnthropic && !hasGoogleAI) {
          return {
            success: false,
            error: "No AI API keys configured.",
          };
        }

        const platformName = platform === "pinterest" ? "Pinterest" : "Facebook";
        
        // Category-specific rewrite guidance
        const categoryGuidance = {
          engagement_bait: "Remove all calls for likes/shares/tags/comments. Focus on providing value. Let engagement happen naturally through quality content.",
          cta_violation: "Soften the call-to-action. Remove fake urgency/scarcity. Use inviting language instead of pressure tactics.",
          clickbait: "Be specific and honest. Don't withhold information. State the actual benefit or content clearly.",
          promotion_spam: "Reduce promotional intensity. Add genuine value or information. Balance selling with helping.",
          trust_authenticity: "Remove unverifiable claims. Add realistic expectations. Use honest, transparent language.",
          hashtag_abuse: "Reduce to 3-5 highly relevant hashtags. Remove trending/irrelevant tags.",
          thin_content: "Add meaningful context, value, or description. Make it informative and engaging.",
          content_policy: "Remove or rephrase the violating content while preserving the core message if possible.",
          copyright: "Remove brand references, logos, or copyrighted material mentions."
        };
        
        const guidance = categoryGuidance[issue.category] || "Fix the violation while keeping the original intent.";
        
        const prompt = `You are a social media content expert specializing in ${platformName} compliance. Rewrite this post to pass policy checks.

ORIGINAL TEXT:
${originalText}

VIOLATION DETECTED:
- Category: ${issue.category}
- Problem: ${issue.description}
- Problematic part: "${issue.problematicText}"

REWRITE GUIDANCE FOR ${issue.category.toUpperCase()}:
${guidance}

RULES:
1. Rewrite the COMPLETE text (not just the problematic part)
2. Remove the violation completely - don't just soften it
3. Maintain the original message/intent where possible
4. Keep it engaging and natural for ${platformName}
5. ${platform === "pinterest" ? "Use 2-5 relevant hashtags max if hashtags were present" : "Avoid asking for engagement - let quality drive it"}

Return ONLY the fixed text, no quotes or explanations:
`;

        let result = null;

        // Try providers in order of cost
        if (hasOpenAI) {
          try {
            const { openAi } = require("../automations/openai");
            result = await openAi(null, "gpt-5-nano", prompt, 0.7, null, 30000);
          } catch (e) {
            console.warn("[Fix Text] OpenAI failed:", e.message);
          }
        }

        if (!result?.success && hasGoogleAI) {
          try {
            const { googleAI } = require("../automations/googleai");
            result = await googleAI("gemini-2.0-flash", prompt, 0.7, null, null, 2048, 30000);
          } catch (e) {
            console.warn("[Fix Text] Google AI failed:", e.message);
          }
        }

        if (!result?.success && hasAnthropic) {
          try {
            const { anthropic } = require("../automations/anthropic");
            result = await anthropic("claude-3-5-haiku-20241022", prompt, 0.7, null, null, 2048, 30000);
          } catch (e) {
            console.warn("[Fix Text] Anthropic failed:", e.message);
          }
        }

        if (!result || !result.success) {
          return {
            success: false,
            error: result?.value || "Failed to fix text.",
          };
        }

        return {
          success: true,
          fixedText: result.value.trim(),
        };
      } catch (error) {
        console.error("[Fix Text] Error:", error);
        return {
          success: false,
          error: error.message || "An unexpected error occurred.",
        };
      }
    },
  );

  // Backup System Handlers
  const backupManager = new BackupManager();

  // Update post text in database (for Fix Text persistence)
  ipcMain.handle(
    "update-post-text",
    async (_, { postId, platform, textFields }) => {
      try {
        if (!postId) {
          console.warn("[Update Post Text] No postId provided, skipping database update");
          return { success: false, error: "No postId provided" };
        }
        
        console.log(`[Update Post Text] Updating post ${postId} platform ${platform}:`, textFields);
        const result = workflowDb.updatePostOutputFields(postId, platform, textFields);
        
        if (result.changes > 0) {
          console.log(`[Update Post Text] Successfully updated post ${postId}`);
          return { success: true };
        } else {
          console.warn(`[Update Post Text] No rows updated for post ${postId}`);
          return { success: false, error: "No matching post found" };
        }
      } catch (error) {
        console.error("[Update Post Text] Error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Update post image in database (for Regenerate Image persistence)
  ipcMain.handle(
    "update-post-image",
    async (_, { postId, platform, newImagePath }) => {
      try {
        const path = require("path");
        const fs = require("fs").promises;
        
        if (!postId) {
          console.warn("[Update Post Image] No postId provided, skipping database update");
          return { success: false, error: "No postId provided" };
        }
        
        console.log(`[Update Post Image] Updating post ${postId} image to ${newImagePath}`);
        
        // Update the main post image
        workflowDb.updatePostImage(postId, newImagePath);
        
        // Also update the output image field
        const imageFileName = path.basename(newImagePath);
        workflowDb.updatePostOutputFields(postId, platform, { image: imageFileName });
        
        // Check if this post was exported and update the exported file
        const postExportInfo = workflowDb.getPostExportInfo(postId);
        if (postExportInfo && postExportInfo.exportIndex) {
          const exportPath = workflowDb.getWorkflowExportPath(postExportInfo.workflowId);
          if (exportPath) {
            const exportedFileName = `${postExportInfo.exportIndex}.png`;
            const exportedFilePath = path.join(exportPath, exportedFileName);
            
            try {
              // Check if export folder exists
              await fs.access(exportPath);
              // Copy the new image to the export folder
              await fs.copyFile(newImagePath, exportedFilePath);
              console.log(`[Update Post Image] Updated exported file: ${exportedFilePath}`);
            } catch (exportErr) {
              // Export folder may have been deleted or moved - not a critical error
              console.warn(`[Update Post Image] Could not update exported file: ${exportErr.message}`);
            }
          }
        }
        
        console.log(`[Update Post Image] Successfully updated post ${postId}`);
        return { success: true };
      } catch (error) {
        console.error("[Update Post Image] Error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Save export indices for posts after export
  ipcMain.handle(
    "save-post-export-indices",
    async (_, exportIndices) => {
      try {
        // exportIndices is an array of { postId, exportIndex }
        for (const { postId, exportIndex } of exportIndices) {
          if (postId && exportIndex) {
            workflowDb.setPostExportIndex(postId, exportIndex);
          }
        }
        console.log(`[Save Export Indices] Saved ${exportIndices.length} export indices`);
        return { success: true };
      } catch (error) {
        console.error("[Save Export Indices] Error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Generate AI prompt for image regeneration based on analyzing the actual image
  ipcMain.handle(
    "generate-image-prompt",
    async (_, { imagePath, issues, platform, generator, postTitle, postDescription, postText }) => {
      try {
        const openaiKeys = (await readKey("openaiKeys")) || {};
        const anthropicKeys = (await readKey("anthropicKeys")) || {};
        const googleaiKeys = (await readKey("googleaiKeys")) || {};

        const hasOpenAI = Object.keys(openaiKeys).length > 0;
        const hasAnthropic = Object.keys(anthropicKeys).length > 0;
        const hasGoogleAI = Object.keys(googleaiKeys).length > 0;

        if (!hasOpenAI && !hasAnthropic && !hasGoogleAI) {
          return { success: false, error: "No AI API keys configured." };
        }

        // Read image and convert to base64
        const fs = require("fs");
        if (!imagePath || !fs.existsSync(imagePath)) {
          return { success: false, error: "Image file not found." };
        }
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString("base64");
        const ext = require("path").extname(imagePath).toLowerCase();
        const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

        const issuesList = issues.map(i => `- ${i.description}`).join('\n');
        const platformName = platform === "pinterest" ? "Pinterest" : "Facebook";
        
        // Different prompts for different generators
        // Midjourney + GPT Image: Full descriptive prompt (no image editing support)
        // ChatGPT Image + Sora: Edit instructions (they support image editing/remix with reference)
        const supportsImageEdit = generator === "chatgptimage" || generator === "soraimage";
        
        // Build post context block if any text metadata is available
        let postContextBlock = '';
        if (postTitle || postDescription || postText) {
          const parts = [];
          if (postTitle) parts.push(`Title: "${postTitle}"`);
          if (postDescription) parts.push(`Description: "${postDescription}"`);
          if (postText) parts.push(`Text: "${postText}"`);
          postContextBlock = `\n\nORIGINAL POST CONTEXT (preserve this content in the image):\n${parts.join('\n')}`;
        }
        
        let prompt;
        if (supportsImageEdit) {
          // ChatGPT Image / Sora: Generate edit instructions (they will receive the original image)
          prompt = `You are an expert at PRECISE image editing. Analyze this image and identify ONLY the specific problematic text/elements that need to be changed.

POLICY ISSUES TO FIX:
${issuesList}

CRITICAL RULES:
1. PRESERVE ALL NON-PROBLEMATIC TEXT - Do NOT remove text that is not causing policy violations (recipe titles, ingredient names, decorative text, etc.)
2. ONLY target the SPECIFIC text mentioned in the policy issues above
3. Be SURGICAL - modify only what's necessary, keep everything else EXACTLY as-is

Your task:
1. Identify the EXACT text or element causing the specific policy violation
2. PRIORITY 1 - REMOVAL: If the problematic text/logo/trademark can be removed without affecting other content, remove ONLY that specific element
3. PRIORITY 2 - REPLACEMENT: If the problematic text is part of a larger text block or integral to the design, replace ONLY the problematic words with neutral compliant text IN THE SAME LANGUAGE
4. LANGUAGE RULE: Any replacement text MUST be in the SAME LANGUAGE as the original. Spanish → Spanish, French → French, etc.
5. DO NOT touch any text that is not explicitly mentioned in the policy issues

Example outputs:
- "Remove only the health claim text 'para apoyar la pérdida de grasa' from the title, keep the rest of the text 'Shot de vinagre de manzana' intact"
- "Remove the brand logo 'NutriBlast' from the corner, preserve all recipe text"
- "Replace only the words 'SUPPORT FAT LOSS' with 'WELLNESS DRINK' in the title banner, keep 'APPLE CIDER' and all other text unchanged"
- "Remove only 'Quema Grasa' from the overlay, keep 'Receta Saludable' and ingredient list intact"
- "Replace 'pérdida de peso' with 'bienestar' (Spanish), preserve all other Spanish text in the image"
${postContextBlock}
Return ONLY the editing instruction (be VERY specific about what single element to remove/change, and explicitly state what to KEEP):`;
        } else {
          // Midjourney / GPT Image: Generate full descriptive prompt to recreate the image
          prompt = `You are an expert at creating image generation prompts. Analyze this image carefully, then create a detailed prompt to recreate a SIMILAR image that avoids the policy violations listed below.

POLICY ISSUES TO FIX:
${issuesList}

Your task:
1. Describe what you see in this image (subject, composition, colors, style, mood, lighting)
2. Create a new image generation prompt that captures the same visual essence
3. The new prompt MUST avoid elements that cause the policy violations
4. If the image has text overlays, describe replacement text that is compliant (no health claims)
5. ${generator === "midjourney" ? "Include Midjourney style parameters like --ar if appropriate" : "Make it detailed and descriptive"}
6. Make it suitable for ${platformName}
${postContextBlock}
Return ONLY the image generation prompt (no explanations, no preamble):`;
        }

        // Create data URL for vision APIs
        const imageDataUrl = `data:${mimeType};base64,${base64Image}`;
        let result = null;

        if (hasOpenAI) {
          try {
            const { openAi } = require("../automations/openai");
            // Use vision model with image
            result = await openAi(null, "gpt-4o-mini", prompt, 0.8, imageDataUrl, 60000);
          } catch (e) {
            console.warn("[Generate Prompt] OpenAI failed:", e.message);
          }
        }

        if (!result?.success && hasGoogleAI) {
          try {
            const { googleAI } = require("../automations/googleai");
            // Gemini accepts image as separate parameter
            result = await googleAI("gemini-2.0-flash", prompt, 0.8, imageDataUrl, null, 1024, 60000);
          } catch (e) {
            console.warn("[Generate Prompt] Google AI failed:", e.message);
          }
        }

        if (!result?.success && hasAnthropic) {
          try {
            const { anthropic } = require("../automations/anthropic");
            // Anthropic accepts image parameter
            result = await anthropic("claude-3-5-haiku-20241022", prompt, 0.8, imageDataUrl, null, 1024, 60000);
          } catch (e) {
            console.warn("[Generate Prompt] Anthropic failed:", e.message);
          }
        }

        if (!result || !result.success) {
          return { success: false, error: result?.value || "Failed to generate prompt." };
        }

        return { success: true, prompt: result.value.trim() };
      } catch (error) {
        console.error("[Generate Prompt] Error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Regenerate image based on policy issues
  ipcMain.handle(
    "regenerate-policy-image",
    async (_, { generator, prompt, originalImagePath, postInfo }) => {
      try {
        console.log(`[Regenerate Image] Using ${generator} with prompt: ${prompt.substring(0, 100)}...`);
        
        let result = null;
        const path = require("path");
        const fs = require("fs").promises;
        const sharp = require("sharp");
        
        // Look up workflowId from postInfo so regenerated images get the same
        // SEO metadata, EXIF injection, and format as originals
        let workflowId = null;
        if (postInfo?.postId) {
          try {
            const workflowDb = require("./database");
            const post = workflowDb.getPost(postInfo.postId);
            if (post?.workflow_id) {
              workflowId = post.workflow_id;
              console.log(`[Regenerate Image] Resolved workflowId=${workflowId} from postId=${postInfo.postId}`);
            }
          } catch (dbErr) {
            console.warn(`[Regenerate Image] Could not look up workflowId:`, dbErr.message);
          }
        }
        
        // Generate unique filename
        const timestamp = Date.now();
        const outputDir = path.join(app.getPath("userData"), "Images");
        await fs.mkdir(outputDir, { recursive: true });
        
        // Detect original image dimensions and aspect ratio
        let targetSize = "1024x1024"; // Default square
        try {
          if (originalImagePath) {
            const metadata = await sharp(originalImagePath).metadata();
            const aspectRatio = metadata.width / metadata.height;
            
            // Choose appropriate size based on aspect ratio
            if (aspectRatio < 0.8) {
              // Portrait (taller than wide)
              targetSize = "480x720";
            } else if (aspectRatio > 1.2) {
              // Landscape (wider than tall)
              targetSize = "720x480";
            } else {
              // Square-ish
              targetSize = "1024x1024";
            }
            console.log(`[Regenerate Image] Original: ${metadata.width}x${metadata.height}, aspect: ${aspectRatio.toFixed(2)}, using: ${targetSize}`);
          }
        } catch (dimErr) {
          console.warn(`[Regenerate Image] Could not detect dimensions, using default: ${targetSize}`);
        }
        
        if (generator === "gptimage") {
          // Use GPT Image API (fastest)
          // GPT Image supports: 1024x1024, 1024x1792, 1792x1024
          let gptSize = "1024x1024";
          if (targetSize === "480x720") gptSize = "1024x1792"; // Portrait
          else if (targetSize === "720x480") gptSize = "1792x1024"; // Landscape
          
          const { gptImage } = require("../automations/gptimage");
          result = await gptImage(prompt, "gpt-image-1", gptSize, "medium", "png", workflowId);
          
        } else if (generator === "chatgptimage") {
          // Use ChatGPT Image (browser-based) - uses OpenAI profiles with rotation
          const openaiProfiles = (await readKey("openaiProfiles")) || {};
          const connectedProfiles = Object.entries(openaiProfiles)
            .filter(([_, p]) => p.status === "connected")
            .map(([id]) => id);
          
          if (connectedProfiles.length === 0) {
            return { success: false, error: "ChatGPT Image requires a connected ChatGPT account. Please connect one in Settings > OpenAI Profiles." };
          }
          
          // Round-robin profile selection (rotate through all connected profiles)
          chatgptRegenProfileRotationIndex = chatgptRegenProfileRotationIndex % connectedProfiles.length;
          const profileId = connectedProfiles[chatgptRegenProfileRotationIndex];
          chatgptRegenProfileRotationIndex++;
          
          console.log(`[Regenerate Image] ChatGPT Image using profile: ${profileId} (rotation index: ${chatgptRegenProfileRotationIndex - 1}, ${connectedProfiles.length} available)`);
          
          const { startImageRequest } = require("../automations/chatgptImage");
          result = await startImageRequest(prompt, originalImagePath, profileId, workflowId || `regen_${timestamp}`);
          
        } else if (generator === "soraimage") {
          // Use Sora Image - uses OpenAI profiles with rotation and exhaustion filtering
          const openaiProfiles = (await readKey("openaiProfiles")) || {};
          const connectedProfiles = Object.entries(openaiProfiles)
            .filter(([_, p]) => p.status === "connected")
            .map(([id]) => id);
          
          // Get user-enabled profiles for Sora (empty = all connected profiles enabled)
          const enabledSoraProfiles = (await readKey("enabledSoraProfiles")) || [];
          const enabledProfiles = enabledSoraProfiles.length > 0
            ? connectedProfiles.filter((id) => enabledSoraProfiles.includes(id))
            : connectedProfiles;
          
          // Import Sora module to check exhaustion status
          const { soraImage, isProfileExhausted } = require("../automations/soraImage");
          
          // Filter out exhausted profiles (daily limit reached)
          const availableProfiles = enabledProfiles.filter((id) => !isProfileExhausted(id));
          
          if (availableProfiles.length === 0) {
            if (enabledProfiles.length > 0) {
              return { success: false, error: "All enabled Sora profiles have hit their daily limit (50 images/24h). Please wait 24 hours or enable more profiles." };
            }
            if (connectedProfiles.length > 0) {
              return { success: false, error: "No Sora profiles are enabled. Please enable at least one profile in Settings > Sora Image." };
            }
            return { success: false, error: "Sora Image requires a connected ChatGPT account. Please connect one in Settings > OpenAI Profiles." };
          }
          
          // Round-robin profile selection
          soraRegenProfileRotationIndex = soraRegenProfileRotationIndex % availableProfiles.length;
          const profileId = availableProfiles[soraRegenProfileRotationIndex];
          soraRegenProfileRotationIndex++;
          
          console.log(`[Regenerate Image] Sora using profile: ${profileId} (rotation index: ${soraRegenProfileRotationIndex - 1}, ${availableProfiles.length} available)`);
          
          // Pass original image for remix/edit mode
          result = await soraImage(prompt, 1, targetSize, profileId, originalImagePath, workflowId);
          
          // Sora returns array, get first
          if (result?.success && Array.isArray(result.value)) {
            result.value = result.value[0];
          }
          
        } else if (generator === "midjourney") {
          // Use Midjourney - uses OpenAI profiles for browser session
          const openaiProfiles = (await readKey("openaiProfiles")) || {};
          const connectedProfiles = Object.entries(openaiProfiles)
            .filter(([_, p]) => p.status === "connected")
            .map(([id]) => id);
          const profileId = connectedProfiles[0] || null;
          
          if (!profileId) {
            return { success: false, error: "Midjourney requires a connected browser profile. Please connect a ChatGPT account in Settings > OpenAI Profiles." };
          }
          
          const { startImageRequest } = require("../automations/midjourneyV2");
          result = await startImageRequest(prompt, profileId, workflowId || `regen_${timestamp}`);
          
          // Midjourney returns array of 4 images, get first
          if (result?.success && Array.isArray(result.value)) {
            result.value = result.value[0];
          }
          
        } else {
          return { success: false, error: `Unknown generator: ${generator}` };
        }

        if (!result || !result.success) {
          return {
            success: false,
            error: result?.value || "Image generation failed.",
          };
        }

        console.log(`[Regenerate Image] Success: ${result.value}`);
        return {
          success: true,
          imagePath: result.value,
        };
      } catch (error) {
        console.error("[Regenerate Image] Error:", error);
        return {
          success: false,
          error: error.message || "An unexpected error occurred.",
        };
      }
    },
  );

  // Create full backup
  ipcMain.handle("create-full-backup", async (event) => {
    try {
      const result = await dialog.showSaveDialog({
        title: "Save Backup",
        defaultPath: `viralcloner_backup_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.vcbak`,
        filters: [{ name: "ViralCloner Backup Files", extensions: ["vcbak"] }],
      });

      if (result.canceled) {
        return { success: false, message: "Backup canceled by user" };
      }

      const savePath = result.filePath;

      // Send progress updates to renderer
      const sendProgress = (message, percentage = null) => {
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send("backup-progress", { message, percentage });
        }
      };

      sendProgress("Initializing backup system...", 0);
      sendProgress("Preparing to optimize backup size...", 10);

      const backupResult = await backupManager.createFullBackup(
        savePath,
        sendProgress,
      );

      return backupResult;
    } catch (error) {
      console.error("Create backup error:", error);
      return { success: false, error: error.message };
    }
  });

  // Get backup size estimate
  ipcMain.handle("get-backup-estimate", async () => {
    try {
      const estimate = await backupManager.getBackupEstimateSize();
      return { success: true, estimate };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Validate backup file
  ipcMain.handle("validate-backup-file", async (_, backupFilePath) => {
    try {
      const validation = await backupManager.validateBackup(backupFilePath);
      return validation;
    } catch (error) {
      return { isValid: false, error: error.message };
    }
  });

  // Get backup info
  ipcMain.handle("get-backup-info", async (_, backupFilePath) => {
    try {
      const info = await backupManager.getBackupInfo(backupFilePath);
      return info;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Restore from backup
  ipcMain.handle(
    "restore-from-backup",
    async (event, backupFilePath, options = {}) => {
      try {
        // Send progress updates to renderer
        const sendProgress = (message, percentage = null) => {
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send("restore-progress", { message, percentage });
          }
        };

        sendProgress("Starting restore process...", 0);
        sendProgress("Validating backup file...", 10);

        const restoreResult = await backupManager.restoreFromBackup(
          backupFilePath,
          {
            ...options,
            progressCallback: sendProgress,
          },
        );

        if (restoreResult.success) {
          sendProgress("Restore completed successfully!", 100);
        }

        return restoreResult;
      } catch (error) {
        console.error("Restore backup error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Select backup file
  ipcMain.handle("select-backup-file", async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: "Select Backup File",
        filters: [
          { name: "ViralCloner Backup Files", extensions: ["vcbak"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });

      if (result.canceled) {
        return { success: false, message: "File selection canceled" };
      }

      return { success: true, filePath: result.filePaths[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // MiniCanvas Template Import/Export Handlers
  ipcMain.handle(
    "export-template-file",
    async (_, template, defaultFileName) => {
      try {
        const result = await dialog.showSaveDialog({
          title: "Export Template",
          defaultPath: `${defaultFileName || template.label || "template"}.vcmc`,
          filters: [
            { name: "ViralCloner MiniCanvas Template", extensions: ["vcmc"] },
          ],
        });

        if (result.canceled) {
          return { success: false, message: "Export canceled by user" };
        }

        const savePath = result.filePath;
        const templateData = JSON.stringify(template);
        const encryptedData = encryptPortable(templateData);

        await fs.writeFile(savePath, encryptedData);

        return { success: true, filePath: savePath };
      } catch (error) {
        console.error("Export template error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle("export-all-templates-file", async (_, templates) => {
    try {
      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/:/g, "-");
      const result = await dialog.showSaveDialog({
        title: "Export All Templates",
        defaultPath: `minicanvas_templates_${timestamp}.vcmc`,
        filters: [
          { name: "ViralCloner MiniCanvas Template", extensions: ["vcmc"] },
        ],
      });

      if (result.canceled) {
        return { success: false, message: "Export canceled by user" };
      }

      const savePath = result.filePath;
      const templatesData = JSON.stringify({
        templates,
        count: templates.length,
        exportedAt: new Date().toISOString(),
      });
      const encryptedData = encryptPortable(templatesData);

      await fs.writeFile(savePath, encryptedData);

      return { success: true, filePath: savePath, count: templates.length };
    } catch (error) {
      console.error("Export all templates error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("import-template-file", async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: "Import Template(s)",
        filters: [
          { name: "ViralCloner MiniCanvas Template", extensions: ["vcmc"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });

      if (result.canceled) {
        return { success: false, message: "Import canceled by user" };
      }

      const filePath = result.filePaths[0];
      const encryptedData = await fs.readFile(filePath);
      const decryptedData = decryptAutomation(encryptedData);
      const parsedData = JSON.parse(decryptedData);

      // Check if it's a single template or multiple templates
      let templates = [];
      if (parsedData.templates && Array.isArray(parsedData.templates)) {
        // Multiple templates
        templates = parsedData.templates;
      } else if (parsedData.id && parsedData.data) {
        // Single template
        templates = [parsedData];
      } else {
        throw new Error("Invalid template file format");
      }

      return { success: true, templates, count: templates.length };
    } catch (error) {
      console.error("Import template error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("downloadVideo", async (event, videoPath, projectName) => {
    try {
      const result = await dialog.showSaveDialog({
        title: "Save Video",
        defaultPath: `${projectName}.mp4`,
        filters: [
          { name: "Video Files", extensions: ["mp4"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (!result.canceled && result.filePath) {
        await fs.copyFile(videoPath, result.filePath);
        return { success: true, path: result.filePath };
      }

      return { success: false, message: "Save canceled" };
    } catch (error) {
      console.error("Download video error:", error);
      return { success: false, error: error.message };
    }
  });

  // App restart handler
  ipcMain.on("restart-app", () => {
    app.relaunch();
    app.exit();
  });

  // Telegram Notification Handlers
  ipcMain.handle("validate-telegram-bot", async (event, botToken) => {
    try {
      const result = await telegramNotifications.validateBotToken(botToken);
      return result;
    } catch (error) {
      console.error("Error validating Telegram bot:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("send-telegram-test", async (event, botToken, chatId) => {
    try {
      const result = await telegramNotifications.sendTestMessage(
        botToken,
        chatId,
      );
      return result;
    } catch (error) {
      console.error("Error sending Telegram test message:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("send-telegram-welcome", async (event, botToken, chatId) => {
    try {
      const result = await telegramNotifications.sendWelcomeMessage(
        botToken,
        chatId,
      );
      return result;
    } catch (error) {
      console.error("Error sending Telegram welcome message:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-telegram-chat-id-instructions", async () => {
    try {
      const instructions = await telegramNotifications.getChatIdInstructions();
      return { success: true, instructions };
    } catch (error) {
      console.error("Error getting chat ID instructions:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("initialize-telegram-notifications", async () => {
    try {
      const result = await telegramNotifications.initialize();
      return { success: result };
    } catch (error) {
      console.error("Error initializing Telegram notifications:", error);
      return { success: false, error: error.message };
    }
  });

  // ============================================
  // SYSTEM NOTIFICATION HANDLERS
  // ============================================

  ipcMain.handle("send-system-notification-test", async () => {
    try {
      const result = await systemNotifications.sendTestNotification();
      return result;
    } catch (error) {
      console.error("Error sending system test notification:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("initialize-system-notifications", async () => {
    try {
      const result = await systemNotifications.initialize();
      return { success: result };
    } catch (error) {
      console.error("Error initializing system notifications:", error);
      return { success: false, error: error.message };
    }
  });

  // ============================================
  // WORKFLOW DATABASE API HANDLERS
  // ============================================

  // Get paginated workflow summaries (no posts data)
  ipcMain.handle(
    "get-workflows-summary",
    async (_, page = 0, pageSize = 15) => {
      try {
        const allWorkflows = workflowDb.getAllWorkflowsSummary();

        // Sort by creation date (newest first)
        allWorkflows.sort((a, b) => {
          const dateA = new Date(a.createdAt || 0).getTime();
          const dateB = new Date(b.createdAt || 0).getTime();
          return dateB - dateA;
        });

        const start = page * pageSize;
        const end = start + pageSize;
        const paginated = allWorkflows.slice(start, end);

        return {
          success: true,
          workflows: paginated,
          total: allWorkflows.length,
          page,
          pageSize,
          hasMore: end < allWorkflows.length,
        };
      } catch (error) {
        console.error("Error getting workflows summary:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Get single workflow with all posts
  ipcMain.handle("get-workflow-detail", async (_, workflowId) => {
    try {
      const workflow = workflowDb.getWorkflowWithPosts(workflowId);
      if (!workflow) {
        return { success: false, error: "Workflow not found" };
      }
      return { success: true, workflow };
    } catch (error) {
      console.error("Error getting workflow detail:", error);
      return { success: false, error: error.message };
    }
  });

  // Alias for get-workflow-detail - returns workflow with posts directly (used by app.js global handlers)
  ipcMain.handle("get-workflow-with-posts", async (_, workflowId) => {
    try {
      const workflow = workflowDb.getWorkflowWithPosts(workflowId);
      return workflow || null;
    } catch (error) {
      console.error("Error getting workflow with posts:", error);
      return null;
    }
  });

  // ============================================
  // MONITORING & ANALYTICS HANDLERS
  // ============================================

  // Get comprehensive analytics summary
  ipcMain.handle("get-analytics-summary", async (_, hoursAgo = 24) => {
    try {
      const summary = workflowDb.getAnalyticsSummary(hoursAgo);
      return { success: true, data: summary };
    } catch (error) {
      console.error("Error getting analytics summary:", error);
      return { success: false, error: error.message };
    }
  });

  // Get node type statistics (success/fail rates)
  ipcMain.handle("get-node-type-stats", async (_, hoursAgo = 24) => {
    try {
      const stats = workflowDb.getNodeTypeStats(hoursAgo);
      return { success: true, data: stats };
    } catch (error) {
      console.error("Error getting node type stats:", error);
      return { success: false, error: error.message };
    }
  });

  // Get node execution durations
  ipcMain.handle("get-node-durations", async (_, hoursAgo = 24) => {
    try {
      const durations = workflowDb.getNodeDurations(hoursAgo);
      return { success: true, data: durations };
    } catch (error) {
      console.error("Error getting node durations:", error);
      return { success: false, error: error.message };
    }
  });

  // Get workflow completion trend over time
  ipcMain.handle("get-workflow-completion-trend", async (_, hoursAgo = 24) => {
    try {
      const trend = workflowDb.getWorkflowCompletionTrend(hoursAgo);
      return { success: true, data: trend };
    } catch (error) {
      console.error("Error getting workflow completion trend:", error);
      return { success: false, error: error.message };
    }
  });

  // Get posts completion trend over time
  ipcMain.handle("get-posts-completion-trend", async (_, hoursAgo = 24) => {
    try {
      const trend = workflowDb.getPostsCompletionTrend(hoursAgo);
      return { success: true, data: trend };
    } catch (error) {
      console.error("Error getting posts completion trend:", error);
      return { success: false, error: error.message };
    }
  });

  // Get currently active/running executions
  ipcMain.handle("get-active-executions", async () => {
    try {
      const active = workflowDb.getActiveExecutions();
      return { success: true, data: active };
    } catch (error) {
      console.error("Error getting active executions:", error);
      return { success: false, error: error.message };
    }
  });

  // Get recent node failures
  ipcMain.handle("get-recent-failures", async (_, limit = 20) => {
    try {
      const failures = workflowDb.getRecentFailures(limit);
      return { success: true, data: failures };
    } catch (error) {
      console.error("Error getting recent failures:", error);
      return { success: false, error: error.message };
    }
  });

  // ============================================
  // FAILURE LOG FILE OPERATIONS
  // ============================================
  const failureLogPath = path.join(app.getPath("userData"), "Logs", "node-failures.log");
  let failureLogWatcher = null;
  let lastLogSize = 0;

  // Read failure logs from file
  ipcMain.handle("get-failure-logs", async (_, limit = 50) => {
    try {
      // Ensure logs directory exists
      const logsDir = path.join(app.getPath("userData"), "Logs");
      try {
        await fs.mkdir(logsDir, { recursive: true });
      } catch (mkdirErr) {
        // Ignore if already exists
      }

      // Check if file exists
      try {
        await fs.access(failureLogPath);
      } catch {
        return { success: true, data: [] };
      }

      const content = await fs.readFile(failureLogPath, "utf8");
      const lines = content.trim().split("\n").filter(line => line.trim());
      
      // Parse each line as JSON and add line index
      const logs = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          const log = JSON.parse(lines[i]);
          log._lineIndex = i;
          logs.push(log);
        } catch (parseErr) {
          // Skip malformed lines
          console.warn(`[FailureLogs] Skipping malformed line ${i}: ${parseErr.message}`);
        }
      }

      // Return most recent logs first, limited
      const sortedLogs = logs.reverse().slice(0, limit);
      return { success: true, data: sortedLogs };
    } catch (error) {
      console.error("[FailureLogs] Error reading failure logs:", error);
      return { success: false, error: error.message };
    }
  });

  // Delete a specific failure log by line index
  ipcMain.handle("delete-failure-log", async (_, lineIndex) => {
    try {
      const content = await fs.readFile(failureLogPath, "utf8");
      const lines = content.trim().split("\n").filter(line => line.trim());
      
      if (lineIndex < 0 || lineIndex >= lines.length) {
        return { success: false, error: "Invalid line index" };
      }

      // Remove the specified line
      lines.splice(lineIndex, 1);
      
      // Write back
      const newContent = lines.length > 0 ? lines.join("\n") + "\n" : "";
      await fs.writeFile(failureLogPath, newContent, "utf8");
      
      return { success: true };
    } catch (error) {
      console.error("[FailureLogs] Error deleting failure log:", error);
      return { success: false, error: error.message };
    }
  });

  // Clear all failure logs
  ipcMain.handle("clear-failure-logs", async () => {
    try {
      await fs.writeFile(failureLogPath, "", "utf8");
      lastLogSize = 0;
      return { success: true };
    } catch (error) {
      console.error("[FailureLogs] Error clearing failure logs:", error);
      return { success: false, error: error.message };
    }
  });

  // Start watching failure log file for changes
  ipcMain.handle("start-failure-log-watcher", async () => {
    try {
      // Ensure logs directory exists
      const logsDir = path.join(app.getPath("userData"), "Logs");
      try {
        await fs.mkdir(logsDir, { recursive: true });
      } catch (mkdirErr) {
        // Ignore if already exists
      }

      // Create empty file if doesn't exist
      try {
        await fs.access(failureLogPath);
      } catch {
        await fs.writeFile(failureLogPath, "", "utf8");
      }

      // Get initial file size
      const stats = await fs.stat(failureLogPath);
      lastLogSize = stats.size;

      // Stop existing watcher if any
      if (failureLogWatcher) {
        failureLogWatcher.close();
        failureLogWatcher = null;
      }

      // Start watching
      failureLogWatcher = fss.watch(failureLogPath, async (eventType) => {
        if (eventType === "change") {
          try {
            const newStats = await fs.stat(failureLogPath);
            
            // Only emit if file grew (new logs added)
            if (newStats.size > lastLogSize) {
              // Read only the new content
              const content = await fs.readFile(failureLogPath, "utf8");
              const lines = content.trim().split("\n").filter(line => line.trim());
              
              // Get the newest log entries
              const newLogs = [];
              for (let i = lines.length - 1; i >= 0; i--) {
                try {
                  const log = JSON.parse(lines[i]);
                  log._lineIndex = i;
                  newLogs.push(log);
                  // Only get logs that are likely new (limit to prevent re-sending old logs)
                  if (newLogs.length >= 5) break;
                } catch {
                  // Skip malformed
                }
              }

              // Emit to renderer
              const mainWindow = BrowserWindow.getAllWindows()[0];
              if (mainWindow) {
                mainWindow.webContents.send("failure-log-updated", newLogs);
              }
            }
            lastLogSize = newStats.size;
          } catch (readErr) {
            console.warn("[FailureLogs] Error reading updated log:", readErr.message);
          }
        }
      });

      return { success: true };
    } catch (error) {
      console.error("[FailureLogs] Error starting watcher:", error);
      return { success: false, error: error.message };
    }
  });

  // Stop watching failure log file
  ipcMain.handle("stop-failure-log-watcher", async () => {
    try {
      if (failureLogWatcher) {
        failureLogWatcher.close();
        failureLogWatcher = null;
      }
      return { success: true };
    } catch (error) {
      console.error("[FailureLogs] Error stopping watcher:", error);
      return { success: false, error: error.message };
    }
  });

  // ============================================
  // ADVANCED ANALYTICS (PERSISTENT ARCHIVE)
  // Uses separate analytics.db for data that survives workflow deletion
  // ============================================

  // Get comprehensive analytics dashboard data (combines live + archived)
  ipcMain.handle("get-analytics-dashboard", async (_, { hoursAgo = 24, automationId = null } = {}) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      
      // Get all data in parallel
      const [summary, errorData, costData, platformData, peakUsage, lifetimeStats, completionTrend] = await Promise.all([
        Promise.resolve(analyticsDb.getAnalyticsSummary(hoursAgo, automationId, workflowDb)),
        Promise.resolve(analyticsDb.getErrorAnalytics(hoursAgo, automationId)),
        Promise.resolve(analyticsDb.getCostAnalytics(hoursAgo, automationId)),
        Promise.resolve(analyticsDb.getPlatformAnalytics(hoursAgo, automationId)),
        Promise.resolve(analyticsDb.getPeakUsage()),
        Promise.resolve(analyticsDb.getLifetimeStats()),
        Promise.resolve(analyticsDb.getCompletionTrend(hoursAgo, automationId, workflowDb)),
      ]);

      // Get node type stats from main database for live accuracy
      const nodeTypeStats = workflowDb.getNodeTypeStats(hoursAgo);
      const nodeDurations = workflowDb.getNodeDurations(hoursAgo);
      
      // Get active executions
      const activeExecutions = workflowDb.getActiveExecutions();
      
      // Get recent failures from main database
      const recentFailures = workflowDb.getRecentFailures(20);

      return {
        success: true,
        data: {
          summary,
          errorData,
          costData,
          platformData,
          peakUsage,
          lifetimeStats,
          completionTrend,
          nodeTypeStats,
          nodeDurations,
          activeExecutions,
          recentFailures,
        },
      };
    } catch (error) {
      console.error("[Analytics] Error getting dashboard data:", error);
      return { success: false, error: error.message };
    }
  });

  // Get automation-specific analytics
  ipcMain.handle("get-automation-analytics", async (_, hoursAgo = 24) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const automationStats = analyticsDb.getAutomationAnalytics(hoursAgo);
      
      // Enrich with automation names from storage
      const automations = readKey("automations") || {};
      const enriched = automationStats.map(stat => ({
        ...stat,
        automationName: stat.automation_name || automations[stat.automation_id]?.name || stat.automation_id || 'Unknown',
      }));
      
      return { success: true, data: enriched };
    } catch (error) {
      console.error("[Analytics] Error getting automation analytics:", error);
      return { success: false, error: error.message };
    }
  });

  // Get node type analytics (success rates by node type - combines live + archived)
  ipcMain.handle("get-node-type-analytics", async (_, hoursAgo = 24) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
      
      // Get live node type stats from main database - only from existing workflows
      const liveStats = workflowDb.db.prepare(`
        SELECT 
          ne.node_type,
          COUNT(*) as total,
          SUM(CASE WHEN ne.status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN ne.status = 'failed' THEN 1 ELSE 0 END) as failed,
          ROUND(AVG(CASE WHEN ne.completed_at IS NOT NULL 
            THEN (julianday(ne.completed_at) - julianday(ne.created_at)) * 86400000 
            ELSE NULL END), 0) as avg_duration_ms
        FROM node_executions ne
        JOIN workflows w ON ne.workflow_id = w.workflow_id
        WHERE ne.created_at >= ?
        GROUP BY ne.node_type
      `).all(cutoff);
      
      // Get archived node type stats
      const archivedStats = analyticsDb.getNodeTypeStats();
      
      // Combine live and archived data by node type
      const combined = new Map();
      
      // Add live stats
      for (const stat of liveStats) {
        if (!stat.node_type) continue;
        const key = stat.node_type;
        combined.set(key, {
          nodeType: key,
          total: stat.total || 0,
          completed: stat.completed || 0,
          failed: stat.failed || 0,
          avgDurationMs: stat.avg_duration_ms || 0,
        });
      }
      
      // Add archived stats (if no live data for that node type)
      for (const stat of archivedStats) {
        if (!stat.node_type) continue;
        const key = stat.node_type;
        if (!combined.has(key)) {
          combined.set(key, {
            nodeType: key,
            total: stat.total_executions || 0,
            completed: stat.successful || 0,
            failed: stat.failed || 0,
            avgDurationMs: stat.avg_duration_ms || 0,
          });
        }
      }
      
      // Calculate success rates and convert to array
      // successRate is based only on completed executions (completed / (completed + failed))
      // This excludes in-progress nodes that haven't finished yet
      const result = Array.from(combined.values()).map(stat => {
        const finishedTotal = stat.completed + stat.failed;
        return {
          ...stat,
          successRate: finishedTotal > 0 ? Math.round(1000 * stat.completed / finishedTotal) / 10 : 100,
          failRate: finishedTotal > 0 ? Math.round(1000 * stat.failed / finishedTotal) / 10 : 0,
        };
      }).sort((a, b) => b.total - a.total);
      
      return { success: true, data: result };
    } catch (error) {
      console.error("[Analytics] Error getting node type analytics:", error);
      return { success: false, error: error.message };
    }
  });

  // Get platform performance analytics (Pinterest vs Facebook)
  ipcMain.handle("get-platform-analytics", async (_, { hoursAgo = 24, automationId = null } = {}) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const platformData = analyticsDb.getPlatformAnalytics(hoursAgo, automationId);
      
      // Also get live counts from main database
      const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
      const liveOutputs = workflowDb.db.prepare(`
        SELECT 
          platform,
          COUNT(*) as count
        FROM post_outputs
        WHERE created_at >= ?
        GROUP BY platform
      `).all(cutoff);
      
      // Merge archived and live
      const livePinterest = liveOutputs.find(o => o.platform === 'pinterest')?.count || 0;
      const liveFacebook = liveOutputs.find(o => o.platform === 'facebook')?.count || 0;
      
      return {
        success: true,
        data: {
          ...platformData,
          live: {
            pinterest: livePinterest,
            facebook: liveFacebook,
          },
          total: {
            pinterest: (platformData.outputs?.pinterest || 0) + livePinterest,
            facebook: (platformData.outputs?.facebook || 0) + liveFacebook,
          },
        },
      };
    } catch (error) {
      console.error("[Analytics] Error getting platform analytics:", error);
      return { success: false, error: error.message };
    }
  });

  // Get error analytics with categorization
  ipcMain.handle("get-error-analytics", async (_, { hoursAgo = 24, automationId = null } = {}) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const errorData = analyticsDb.getErrorAnalytics(hoursAgo, automationId);
      return { success: true, data: errorData };
    } catch (error) {
      console.error("[Analytics] Error getting error analytics:", error);
      return { success: false, error: error.message };
    }
  });

  // Get peak usage heatmap data
  ipcMain.handle("get-peak-usage", async () => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const peakUsage = analyticsDb.getPeakUsage();
      return { success: true, data: peakUsage };
    } catch (error) {
      console.error("[Analytics] Error getting peak usage:", error);
      return { success: false, error: error.message };
    }
  });

  // Get cost analytics
  ipcMain.handle("get-cost-analytics", async (_, { hoursAgo = 24, automationId = null } = {}) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const costData = analyticsDb.getCostAnalytics(hoursAgo, automationId);
      return { success: true, data: costData };
    } catch (error) {
      console.error("[Analytics] Error getting cost analytics:", error);
      return { success: false, error: error.message };
    }
  });

  // Get lifetime statistics
  ipcMain.handle("get-lifetime-stats", async () => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const lifetimeStats = analyticsDb.getLifetimeStats();
      return { success: true, data: lifetimeStats };
    } catch (error) {
      console.error("[Analytics] Error getting lifetime stats:", error);
      return { success: false, error: error.message };
    }
  });

  // Export analytics data
  ipcMain.handle("export-analytics", async (_, { format = 'json', hoursAgo = 720, automationId = null } = {}) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const exportData = analyticsDb.exportAnalytics(format, hoursAgo, automationId);
      return { success: true, data: exportData, format };
    } catch (error) {
      console.error("[Analytics] Error exporting analytics:", error);
      return { success: false, error: error.message };
    }
  });

  // Track cost event (called from AI usage tracking)
  ipcMain.handle("track-analytics-cost", async (_, costData) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      analyticsDb.recordCost(costData);
      return { success: true };
    } catch (error) {
      console.error("[Analytics] Error tracking cost:", error);
      return { success: false, error: error.message };
    }
  });

  // Run data retention cleanup (prune old data)
  ipcMain.handle("run-analytics-cleanup", async (_, daysToKeep = 365) => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      const result = analyticsDb.pruneOldData(daysToKeep, workflowDb);
      return { success: true, data: result };
    } catch (error) {
      console.error("[Analytics] Error running cleanup:", error);
      return { success: false, error: error.message };
    }
  });

  // Reset all analytics data (clear everything for fresh start)
  ipcMain.handle("reset-analytics-data", async () => {
    try {
      const analyticsDb = getAnalyticsDatabase();
      analyticsDb.resetAllData();
      
      // Also clear node_executions from main database (historical execution data)
      workflowDb.db.exec(`DELETE FROM node_executions`);
      console.log('[Analytics] Cleared node_executions from main database');
      
      return { success: true };
    } catch (error) {
      console.error("[Analytics] Error resetting data:", error);
      return { success: false, error: error.message };
    }
  });

  // Get list of automations for filter dropdown
  ipcMain.handle("get-automations-list", async () => {
    try {
      const automations = readKey("automations") || {};
      let list;
      
      // Handle both array and object formats
      // Automations are stored with 'label' property (not 'name')
      if (Array.isArray(automations)) {
        list = automations.map(auto => ({
          id: auto.id,
          name: auto.label || auto.id || 'Unnamed',
        }));
      } else {
        list = Object.entries(automations).map(([id, auto]) => ({
          id,
          name: auto.label || id,
        }));
      }
      return { success: true, data: list };
    } catch (error) {
      console.error("[Analytics] Error getting automations list:", error);
      return { success: false, error: error.message };
    }
  });

  // Create new workflow
  ipcMain.handle("create-workflow", async (_, workflowData) => {
    try {
      workflowDb.createWorkflow({
        workflowId: workflowData.workflowId,
        name: workflowData.name,
        automationId: workflowData.automationId,
        status: workflowData.status || "pending",
        progress: workflowData.progress || 0,
        createdAt: workflowData.createdAt || new Date().toISOString(),
        updatedAt: workflowData.updatedAt,
        exported: workflowData.exported ? 1 : 0,
        exportedAt: workflowData.exportedAt,
      });

      // Create posts if provided
      if (workflowData.posts && workflowData.posts.length > 0) {
        const posts = workflowData.posts.map((post) => ({
          postId: post.postId,
          workflowId: workflowData.workflowId,
          postImg: post.postImg,
          postMessage: post.postMessage,
          status: post.status || "pending",
          progress: post.progress || 0,
          createdAt: post.createdAt || new Date().toISOString(),
          pinterestAccountId: post.pinterestAccountId,
          pinterestBoardId: post.pinterestBoardId,
          pinterestTitleId: post.pinterestTitleId,
          originalInputImage: post.originalInputImage || null,
        }));
        workflowDb.batchCreatePosts(posts);
      }

      // Log activity for workflow creation
      const postCount = workflowData.posts?.length || 0;
      workflowDb.logActivity(
        "workflow",
        `Workflow "${workflowData.name || 'Untitled'}" created with ${postCount} post${postCount !== 1 ? 's' : ''}`,
        "workflow",
        workflowData.workflowId
      );

      return { success: true, workflowId: workflowData.workflowId };
    } catch (error) {
      console.error("Error creating workflow:", error);
      return { success: false, error: error.message };
    }
  });

  // Update workflow status
  ipcMain.handle(
    "update-workflow-status",
    async (_, workflowId, status, progress) => {
      try {
        workflowDb.updateWorkflowStatus(workflowId, status, progress);
        return { success: true };
      } catch (error) {
        console.error("Error updating workflow status:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Update workflow skip mode
  ipcMain.handle(
    "update-workflow-skip-mode",
    async (_, workflowId, skipImageChoosing) => {
      try {
        console.log(
          `[IPC] Updating workflow ${workflowId} skipImageChoosing to: ${skipImageChoosing}`,
        );
        workflowDb.updateWorkflowSkipMode(workflowId, skipImageChoosing);
        return { success: true };
      } catch (error) {
        console.error("Error updating workflow skip mode:", error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle("change-workflow-automation", async (_, workflowId, automationId) => {
    try {
      const automations = await readKey("automations");
      return require("./changeWorkflowAutomation").changeWorkflowAutomation(
        { workflowDb, workflowQueue, automations }, workflowId, automationId,
      );
    } catch (error) {
      console.error("[IPC] Failed to change workflow automation:", error);
      return { success: false, code: "save_failed" };
    }
  });

  // Update workflow automation (for rerunning with different automation)
  ipcMain.handle(
    "update-workflow-automation",
    async (_, workflowId, automationId) => {
      try {
        console.log(
          `[IPC] Updating workflow ${workflowId} automation to: ${automationId}`,
        );
        workflowDb.updateWorkflowAutomation(workflowId, automationId);
        return { success: true };
      } catch (error) {
        console.error("Error updating workflow automation:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Delete workflow
  ipcMain.handle("delete-workflow", async (_, workflowId) => {
    try {
      // Block deletion if this workflow is in use by the Facebook Groups module.
      // FB Groups references the same workflow by ID to post its generated content,
      // so removing it here would break scheduled posting. The user must remove it
      // from the Facebook Groups page first.
      try {
        const fbImported = fbGroupsDb.getImportedWorkflowById(workflowId);
        if (fbImported) {
          return {
            success: false,
            inUseByFbGroups: true,
            error: "This workflow is in use by the Facebook Groups module. Remove it from the Facebook Groups page before deleting it here.",
          };
        }
      } catch (fbCheckErr) {
        console.error("[DELETE-WORKFLOW] FB Groups usage check failed:", fbCheckErr.message);
      }

      // Get workflow info before deletion for activity log
      const workflow = workflowDb.getWorkflowWithPosts(workflowId);
      const workflowName = workflow?.name || workflowId.substring(0, 8);
      
      // Archive workflow to analytics database BEFORE deletion
      // This preserves all statistics even after the workflow is deleted
      try {
        const analyticsDb = getAnalyticsDatabase();
        const automations = readKey("automations") || {};
        const automationName = workflow?.automationId 
          ? (automations[workflow.automationId]?.name || null) 
          : null;
        analyticsDb.archiveWorkflow(workflowDb, workflowId, automationName);
        console.log(`[DELETE-WORKFLOW] Archived workflow ${workflowId} to analytics database`);
      } catch (archiveError) {
        // Don't fail deletion if archiving fails, just log
        console.error("[DELETE-WORKFLOW] Failed to archive workflow:", archiveError);
      }
      
      // Get non-completed posts' Pinterest title IDs BEFORE cascade delete
      const nonCompletedTitleIds = workflowDb.getNonCompletedTitleIds(workflowId);
      
      workflowDb.deleteWorkflow(workflowId);
      
      // Mark Pinterest titles as unused if they're not used in any other workflow
      if (nonCompletedTitleIds.length > 0) {
        try {
          const pinterestTitles = readKey("pinterestTitles") || {};
          let titlesMarkedUnused = 0;
          
          for (const titleId of nonCompletedTitleIds) {
            // Only mark as unused if title exists and isn't used in other workflows
            if (pinterestTitles[titleId] && !workflowDb.isTitleUsedInOtherWorkflows(titleId, workflowId)) {
              pinterestTitles[titleId].used = false;
              titlesMarkedUnused++;
            }
          }
          
          if (titlesMarkedUnused > 0) {
            updateData("pinterestTitles", pinterestTitles);
            console.log(`[DELETE-WORKFLOW] Marked ${titlesMarkedUnused} Pinterest title(s) as unused`);
          }
        } catch (titleError) {
          console.error("[DELETE-WORKFLOW] Error updating Pinterest titles:", titleError);
          // Don't fail the deletion if title cleanup fails
        }
      }
      
      // Log activity for workflow deletion
      workflowDb.logActivity(
        "delete",
        `Workflow "${workflowName}" deleted`,
        "workflow",
        workflowId
      );
      
      return { success: true };
    } catch (error) {
      console.error("Error deleting workflow:", error);
      return { success: false, error: error.message };
    }
  });

  // Mark workflow as exported
  ipcMain.handle("mark-workflow-exported", async (_, params) => {
    try {
      // Support both old format (workflowId string) and new format (object with workflowId and exportPath)
      const workflowId = typeof params === 'string' ? params : params.workflowId;
      const exportPath = typeof params === 'string' ? null : params.exportPath;
      
      workflowDb.markWorkflowExported(workflowId, exportPath);
      return { success: true, exportedAt: new Date().toISOString() };
    } catch (error) {
      console.error("Error marking workflow as exported:", error);
      return { success: false, error: error.message };
    }
  });

  // Remove exported mark from workflow
  ipcMain.handle("unmark-workflow-exported", async (_, workflowId) => {
    try {
      workflowDb.unmarkWorkflowExported(workflowId);
      return { success: true };
    } catch (error) {
      console.error("Error removing exported mark from workflow:", error);
      return { success: false, error: error.message };
    }
  });

  // Fix stuck workflows - updates workflows that have 'pending' status but all posts are completed/failed
  ipcMain.handle("fix-stuck-workflows", async () => {
    try {
      workflowDb.reconcilePostStatusesFromOutputs();
      const result = workflowDb.fixStuckWorkflows();
      return result;
    } catch (error) {
      console.error("Error fixing stuck workflows:", error);
      return { success: false, error: error.message };
    }
  });

  // Update post status
  ipcMain.handle("update-post-status", async (_, postId, status, progress) => {
    try {
      workflowDb.updatePostStatus(postId, status, progress);
      return { success: true };
    } catch (error) {
      console.error("Error updating post status:", error);
      return { success: false, error: error.message };
    }
  });

  // Reset post for rerun - clears outputs and node executions
  ipcMain.handle("reset-post-for-rerun", async (_, postId) => {
    try {
      workflowDb.resetPostForRerun(postId);
      console.log(`[IPC] Post ${postId} reset for rerun`);
      return { success: true };
    } catch (error) {
      console.error("Error resetting post for rerun:", error);
      return { success: false, error: error.message };
    }
  });

  // Add post output (Pinterest/Facebook)
  // Also copies images from Temp folder to permanent Images folder
  ipcMain.handle("add-post-output", async (_, postId, platform, outputData) => {
    try {
      // If output has an image in Temp folder, copy it to Images folder for permanence
      if (outputData && outputData.image) {
        const imagePath = outputData.image;
        const tempFolder = path.join(
          app.getPath("userData"),
          "Uploads",
          "Temp",
        );
        const imagesFolder = path.join(app.getPath("userData"), "Images");

        // Check if image is in Temp folder (either absolute path or contains Temp in path)
        if (
          imagePath.includes(tempFolder) ||
          imagePath.includes("Uploads\\Temp") ||
          imagePath.includes("Uploads/Temp")
        ) {
          try {
            // Ensure Images folder exists
            if (!fss.existsSync(imagesFolder)) {
              fss.mkdirSync(imagesFolder, { recursive: true });
            }

            // Get filename and create permanent path
            const fileName = path.basename(imagePath);
            const permanentPath = path.join(
              imagesFolder,
              `output_${postId}_${fileName}`,
            );

            // Check if source file exists before copying
            if (fss.existsSync(imagePath)) {
              fss.copyFileSync(imagePath, permanentPath);
              // Update outputData with permanent path
              outputData.image = permanentPath;
              console.log(
                `✓ Copied output image to permanent location: ${permanentPath}`,
              );
            } else {
              console.warn(`⚠️ Source image not found for copy: ${imagePath}`);
            }
          } catch (copyError) {
            console.error(
              "Error copying output image to Images folder:",
              copyError,
            );
            // Continue with original path - better to save something than fail
          }
        }
      }

      workflowDb.addPostOutput(postId, platform, outputData);
      return { success: true };
    } catch (error) {
      console.error("Error adding post output:", error);
      return { success: false, error: error.message };
    }
  });

  // Log node execution
  ipcMain.handle("log-node-execution", async (_, executionData) => {
    try {
      workflowDb.logNodeExecution(executionData);
      return { success: true };
    } catch (error) {
      console.error("Error logging node execution:", error);
      return { success: false, error: error.message };
    }
  });

  // Get app version
  ipcMain.handle("get-app-version", async () => {
    const { app } = require("electron");
    return app.getVersion();
  });

  // Check for app updates
  ipcMain.handle("check-for-updates", async () => require("./githubUpdates").checkForUpdates(app.getVersion()));

  // Download and install app update
  ipcMain.handle("download-and-install-update", (event, url) => require("./githubUpdates").downloadAndInstall(event, url));

  // Test 2Captcha API key
  ipcMain.handle("test-twocaptcha-key", async (_, apiKey) => {
    try {
      const response = await axios.get(
        `https://2captcha.com/res.php?key=${apiKey}&action=getbalance&json=1`,
        {
          timeout: 10000,
        },
      );
      const data = response.data;

      if (data.status === 1) {
        return {
          success: true,
          balance: parseFloat(data.request).toFixed(2),
        };
      } else {
        // Handle error codes from 2Captcha
        let errorMessage = "Invalid API key";
        if (data.request === "ERROR_WRONG_USER_KEY") {
          errorMessage = "Invalid API key format";
        } else if (data.request === "ERROR_KEY_DOES_NOT_EXIST") {
          errorMessage = "API key does not exist";
        } else if (data.request === "IP_BANNED") {
          errorMessage = "Your IP is banned";
        } else if (data.request) {
          errorMessage = data.request;
        }

        return {
          success: false,
          error: errorMessage,
        };
      }
    } catch (error) {
      console.error("2Captcha API test error:", error);
      return {
        success: false,
        error: error.message || "Failed to connect to 2Captcha API",
      };
    }
  });

  // Test SerpAPI key
  ipcMain.handle("test-serpapi-key", async (_, apiKey) => {
    try {
      const { getAccount } = require("serpapi");
      const account = await getAccount({ api_key: apiKey });
      if (!account || !account.account_email) {
        return { success: false, error: "Invalid SerpAPI key" };
      }
      return {
        success: true,
        planName: account.plan_name || "Unknown",
        searchesPerMonth: account.searches_per_month || 0,
        searchesLeft: account.plan_searches_left ?? 0,
        totalSearchesLeft: account.total_searches_left ?? 0,
        thisMonthUsage: account.this_month_usage || 0,
        rateLimit: account.account_rate_limit_per_hour || 0,
        email: account.account_email,
      };
    } catch (error) {
      console.error("[SerpAPI] Key test error:", error);
      return {
        success: false,
        error: error.message || "Failed to validate SerpAPI key",
      };
    }
  });

  // Test DeepSeek Browser profile
  ipcMain.handle("test-deepseekbrowser-profile", async (_, profileId) => {
    try {
      const { deepseekBrowser } = require("../automations/deepseekBrowser");
      const result = await deepseekBrowser("Say hello in one sentence.", false, false, profileId || null);
      return result;
    } catch (error) {
      console.error("[DeepSeekBrowser] Test error:", error);
      return { success: false, error: error.message || "Test failed" };
    }
  });

  // Test Qwen Browser profile
  ipcMain.handle("test-qwenbrowser-profile", async (_, profileId) => {
    try {
      const { qwenBrowser } = require("../automations/qwenBrowser");
      const result = await qwenBrowser("Say hello in one sentence.", null, { visible: true, thinkingEnabled: false }, profileId || null);
      return result;
    } catch (error) {
      console.error("[QwenBrowser] Test error:", error);
      return { success: false, error: error.message || "Test failed" };
    }
  });

  // Test TikTok Ads profile — runs a minimal image generation to verify the session
  ipcMain.handle("test-tiktokads-profile", async (_, profileId) => {
    try {
      const { tiktokAdsImage } = require("../automations/tiktokAdsImage");
      const result = await tiktokAdsImage(
        "A cute golden retriever puppy sitting in a sunny park",
        "gemini",
        profileId || null,
        null,
      );
      if (result.success) {
        return { success: true, value: result.value };
      }
      return { success: false, error: result.value || "Test failed" };
    } catch (error) {
      console.error("[TikTok Ads] Test error:", error);
      return { success: false, error: error.message || "Test failed" };
    }
  });

  // Test Qwen captcha solver (visible browser).
  // Opens the connected Qwen profile in a visible browser, watches for the
  // Alibaba WAF slider challenge, and auto-solves it by dragging the slider.
  // Send a message in the opened browser to trigger the captcha while it runs.
  ipcMain.handle("test-qwenbrowser-captcha", async (event, profileId, opts = {}) => {
    const { startVCBrowser } = require("./VCBrowserManager");
    const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("./cdpFingerprint");
    const { createCaptchaController } = require("./qwenCaptchaSolver");

    const steps = [];
    const log = (m) => {
      const line = `[${new Date().toISOString()}] ${m}`;
      steps.push(line);
      console.log(`[QwenCaptcha] ${m}`);
      try {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (win) win.webContents.send("qwen-captcha-log", line);
      } catch (_) {}
    };

    let chromeProcess = null;
    let client = null;
    try {
      const profiles = (await readKey("qwenBrowserProfiles")) || {};
      const targetId =
        (profileId && profiles[profileId] && profileId) ||
        Object.keys(profiles).find((id) => profiles[id].status === "connected");
      if (!targetId) {
        return { success: false, error: "No connected Qwen profile found.", steps };
      }
      const profile = profiles[targetId];
      log(`Using Qwen profile "${targetId}".`);

      // Resolve fingerprint (align Chrome version with VCBrowser)
      let fingerprint = getConsistentFingerprintForProfile(targetId);
      try {
        const v = getVCBrowserVersion();
        if (fingerprint.userAgent && v?.full) {
          fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${v.full}`);
        }
      } catch (_) {}

      const proxy =
        profile.proxy && profile.proxy.ip && profile.proxy.ip !== "NULL" ? profile.proxy : null;

      log(`Launching visible browser${proxy ? " with proxy" : ""}...`);
      const startResult = await startVCBrowser(
        targetId,
        fingerprint,
        "https://chat.qwen.ai/",
        proxy,
        false, // visible
        true, // automation mode
      );
      if (!startResult?.client) {
        return { success: false, error: "Failed to start browser (no CDP client).", steps };
      }
      client = startResult.client;
      chromeProcess = startResult.chromeProcess;
      const { Page, Runtime, Network } = client;

      const controller = createCaptchaController(client, { log });
      await controller.attach();

      // Restore session: inject saved cookies + auth token, then reload.
      try {
        for (const c of profile.cdpCookies || []) {
          const cc = {
            name: c.name,
            value: c.value,
            domain: c.domain || ".qwen.ai",
            path: c.path || "/",
            secure: c.secure !== false,
            httpOnly: !!c.httpOnly,
          };
          if (c.expires && c.expires > 0) cc.expires = c.expires;
          try { await Network.setCookie(cc); } catch (_) {}
        }
      } catch (_) {}

      await Page.navigate({ url: "https://chat.qwen.ai/" });
      await new Promise((r) => setTimeout(r, 4000));

      if (profile.token) {
        try {
          await Runtime.evaluate({
            expression: `try{localStorage.setItem('token', ${JSON.stringify(profile.token)});}catch(e){}`,
          });
          await Page.navigate({ url: "https://chat.qwen.ai/" });
          await new Promise((r) => setTimeout(r, 3000));
        } catch (_) {}
      }

      log("Browser ready. Send a chat message to trigger the captcha (watching)...");

      const timeoutMs = Math.min(Math.max(parseInt(opts.timeoutMs) || 300000, 30000), 900000);
      const deadline = Date.now() + timeoutMs;
      let solved = false;

      // Auto-send messages to provoke the WAF challenge (unless disabled).
      const autoSend = opts.autoSend !== false;
      let lastSendAt = 0;
      let sendCount = 0;
      const maxSends = parseInt(opts.maxSends) || 5;

      while (Date.now() < deadline) {
        if (controller.state.solved) { solved = true; break; }

        const geom = await controller.findSlider();
        if (geom.found) {
          log("Captcha slider detected — solving...");
          solved = await controller.solveVisible({ maxAttempts: 4 });
          if (solved) { log("Captcha solved."); break; }
          log("Solve attempt finished without confirmation; continuing to watch.");
        } else if (
          autoSend &&
          !controller.state.challengeSeen &&
          sendCount < maxSends &&
          Date.now() - lastSendAt > 8000
        ) {
          // No challenge yet — send a message to trigger it.
          sendCount++;
          lastSendAt = Date.now();
          await controller.sendChatMessage(`test ${sendCount}`);
        }

        // Stop early if the chrome process died
        if (chromeProcess && chromeProcess.killed) {
          log("Browser was closed.");
          break;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }

      if (!solved && !controller.state.challengeSeen) {
        log("No captcha appeared during the watch window.");
      }

      const result = {
        success: solved,
        solved,
        challengeSeen: controller.state.challengeSeen,
        challengeUrl: controller.state.challengeUrl,
        lastSlideCode: controller.state.lastSlideCode,
        steps,
      };

      // Leave the browser open briefly so the user can observe, then close
      // unless explicitly asked to keep it open.
      if (!opts.keepOpen) {
        setTimeout(() => {
          try { if (chromeProcess && !chromeProcess.killed) chromeProcess.kill(); } catch (_) {}
        }, 4000);
      }

      return result;
    } catch (error) {
      console.error("[QwenCaptcha] Test error:", error);
      try { if (chromeProcess && !chromeProcess.killed) chromeProcess.kill(); } catch (_) {}
      return { success: false, error: error.message || "Test failed", steps };
    }
  });

  // Refresh SerpAPI usage for all stored keys
  ipcMain.handle("refresh-serpapi-usage", async () => {
    try {
      const { getAccount } = require("serpapi");
      const keys = (await readKey("serpapiKeys")) || {};
      const entries = Object.entries(keys);
      if (entries.length === 0) {
        return { success: true, message: "No SerpAPI keys configured" };
      }
      for (const [apiKey, data] of entries) {
        try {
          const account = await getAccount({ api_key: apiKey });
          if (account && account.account_email) {
            keys[apiKey] = {
              ...data,
              status: "active",
              planName: account.plan_name || data.planName || "Unknown",
              searchesPerMonth: account.searches_per_month || 0,
              searchesLeft: account.plan_searches_left ?? 0,
              lastChecked: Date.now(),
            };
          } else {
            keys[apiKey] = { ...data, status: "invalid" };
          }
        } catch {
          keys[apiKey] = { ...data, status: "error" };
        }
      }
      await updateData("serpapiKeys", keys);
      return { success: true };
    } catch (error) {
      console.error("[SerpAPI] Refresh usage error:", error);
      return { success: false, error: error.message };
    }
  });

  // Test IPRegistry API key
  ipcMain.handle("test-ipregistry-key", async (_, apiKey) => {
    try {
      const response = await axios.get(
        `https://api.ipregistry.co/?key=${apiKey}`,
        {
          timeout: 10000,
        },
      );
      const data = response.data;

      if (data && data.ip) {
        // Get credits remaining from ipregistry-credits-remaining header
        const creditsRemaining =
          response.headers["ipregistry-credits-remaining"] || null;

        return {
          success: true,
          ip: data.ip,
          country: data.location?.country?.name || "Unknown",
          countryCode: data.location?.country?.code || null,
          city: data.location?.city || null,
          region: data.location?.region?.name || null,
          timezone: data.time_zone?.id || null,
          currency: data.currency?.code || null,
          creditsRemaining: creditsRemaining,
        };
      } else {
        return {
          success: false,
          error: "Invalid response from IPRegistry",
        };
      }
    } catch (error) {
      console.error("IPRegistry API test error:", error);

      let errorMessage = "Failed to connect to IPRegistry API";
      if (error.response) {
        const status = error.response.status;
        if (status === 401 || status === 403) {
          errorMessage = "Invalid API key";
        } else if (status === 402) {
          errorMessage = "API quota exceeded - upgrade your plan";
        } else if (status === 429) {
          errorMessage = "Rate limit exceeded - try again later";
        } else if (error.response.data?.message) {
          errorMessage = error.response.data.message;
        }
      } else if (error.code === "ECONNABORTED") {
        errorMessage = "Request timeout - check your internet connection";
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  });

  // Find clean proxy by rotating session IDs (for Rayobyte-style proxies)
  // This sends progress updates to the renderer via mainWindow.webContents.send
  ipcMain.handle(
    "find-clean-proxy",
    async (event, proxyData, maxAttempts = 10) => {
      try {
        // Get IPRegistry settings
        const ipregistrySettings = await readKey("ipregistrySettings");

        if (!ipregistrySettings?.enabled || !ipregistrySettings?.apiKey) {
          return {
            success: true,
            skipped: true,
            message: "IPRegistry not configured - skipping proxy check",
            proxyData,
          };
        }

        const mainWindow = BrowserWindow.getAllWindows()[0];

        const result = await findCleanProxy(
          proxyData,
          ipregistrySettings.apiKey,
          maxAttempts,
          async (attempt, max, currentProxy, checkResult) => {
            // Send progress update to frontend
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("proxy-check-progress", {
                attempt,
                maxAttempts: max,
                ip: checkResult.ip,
                clean: checkResult.clean,
                flaggedReasons: checkResult.flaggedReasons || [],
                error: checkResult.error,
                location: checkResult.location,
              });
            }
          },
        );

        return result;
      } catch (error) {
        console.error("Find clean proxy error:", error);
        return {
          success: false,
          error: error.message,
        };
      }
    },
  );

  // Upload user avatar to server
  ipcMain.handle("upload-avatar", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // ========== NOTES API ==========

  // Get all notes from server
  ipcMain.handle("get-notes", async () => require("./localNotes").notesOperation("get"));

  // Create a new note on server
  ipcMain.handle("create-note", async (_, note) => require("./localNotes").notesOperation("create", note));

  // Update an existing note on server
  ipcMain.handle("update-note", async (_, note) => require("./localNotes").notesOperation("update", note));

  // Delete a note from server
  ipcMain.handle("delete-note", async (_, id) => require("./localNotes").notesOperation("delete", id));

  // ========== COMMUNITY FORUM API ==========

  const API_TIMEOUT = 15000; // 15 seconds timeout to prevent hangs when offline

  // Create axios instance with default timeout for all community/reports API calls
  const apiClient = axios.create({
    timeout: API_TIMEOUT,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  // Axios errors contain the full request URL. Community GET requests carry the
  // session token in that URL, so log only safe diagnostic fields.
  

  // Helper to get token
  

  // Get forum posts
  ipcMain.handle("get-forum-posts", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get single forum post
  ipcMain.handle("get-forum-post", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Create forum post
  ipcMain.handle("create-forum-post", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Update forum post
  ipcMain.handle("update-forum-post", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Delete forum post
  ipcMain.handle("delete-forum-post", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Like/unlike forum post
  ipcMain.handle("like-forum-post", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get comments for a post
  ipcMain.handle("get-forum-comments", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Create comment
  ipcMain.handle("create-forum-comment", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Delete comment
  ipcMain.handle("delete-forum-comment", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Like/unlike comment
  ipcMain.handle("like-forum-comment", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get live/online users
  ipcMain.handle("get-live-users", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Search users
  ipcMain.handle("search-users", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get all users (members directory)
  ipcMain.handle("get-all-users", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Heartbeat - keep user online status active
  ipcMain.handle("community-heartbeat", async () => ({ success: true, disabled: true }));

  // Get chat messages (long polling with delta updates)
  ipcMain.handle("get-chat-messages", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Send private message
  ipcMain.handle("send-chat-message", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get conversations list
  ipcMain.handle("get-conversations", async () => ({ success: true, conversations: [] }));

  // Start or get existing conversation
  ipcMain.handle("start-conversation", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get user profile
  ipcMain.handle("get-user-profile", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get total unread message count
  ipcMain.handle("get-unread-count", async () => ({ success: true, unreadCount: 0 }));

  // Check for new messages (lightweight notification check)
  ipcMain.handle("check-new-messages", async () => ({ success: true, messages: [], unreadCount: 0 }));

  // ============================================
  // Group Chat Handlers
  // ============================================

  // Create a new group conversation
  ipcMain.handle("create-group-conversation", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get group members
  ipcMain.handle("get-group-members", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Add group member
  ipcMain.handle("add-group-member", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Remove group member
  ipcMain.handle("remove-group-member", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Leave group
  ipcMain.handle("leave-group", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Update group info (name, avatar)
  ipcMain.handle("update-group-info", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Update member role
  ipcMain.handle("update-member-role", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // ============================================
  // Bug Reports & Suggestions Handlers
  // ============================================


  // Submit new report
  ipcMain.handle("submit-report", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get user's reports
  ipcMain.handle("get-user-reports", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Get single report details
  ipcMain.handle("get-report", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Add comment to report
  ipcMain.handle("add-report-comment", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // Facebook Post Image Scraper
  ipcMain.handle(
    "extract-facebook-post-image",
    async (_, postUrl, timeoutMs = 60000, profileId = null) => {
      try {
        const {
          extractFacebookPostImage,
        } = require("../automations/facebookScraper");
        console.log("[IPC] extract-facebook-post-image called with:", postUrl, "profile:", profileId);
        const result = await extractFacebookPostImage(postUrl, timeoutMs, profileId);
        console.log("[IPC] extract-facebook-post-image result:", result);
        return result;
      } catch (error) {
        console.error("[IPC] extract-facebook-post-image error:", error);
        return {
          success: false,
          error: error.message || "Failed to extract Facebook post image",
        };
      }
    },
  );

  // Facebook Post Scraper (text + image)
  ipcMain.handle(
    "extract-facebook-post",
    async (_, postUrl, timeoutMs = 60000) => {
      try {
        const {
          extractFacebookPost,
        } = require("../automations/facebookScraper");
        console.log("[IPC] extract-facebook-post called with:", postUrl);
        const result = await extractFacebookPost(postUrl, timeoutMs);
        console.log("[IPC] extract-facebook-post result:", {
          success: result.success,
          hasText: !!result.text,
          hasImage: !!result.imageUrl,
          hasLocalPath: !!result.localPath
        });
        return result;
      } catch (error) {
        console.error("[IPC] extract-facebook-post error:", error);
        return {
          success: false,
          error: error.message || "Failed to extract Facebook post",
        };
      }
    },
  );

  // Facebook Post Scraper (Simple DOM-based version)
  ipcMain.handle(
    "scrape-facebook-post-simple",
    async (_, postUrl) => {
      try {
        const {
          scrapeFacebookPost,
        } = require("../automations/facebookScraper");
        console.log("[IPC] scrape-facebook-post-simple called with:", postUrl);
        const result = await scrapeFacebookPost(postUrl);
        console.log("[IPC] scrape-facebook-post-simple result:", {
          success: result.success,
          hasText: !!result.text,
          hasImage: !!result.imageUrl,
          hasLocalPath: !!result.localPath
        });
        return result;
      } catch (error) {
        console.error("[IPC] scrape-facebook-post-simple error:", error);
        return {
          success: false,
          error: error.message || "Failed to scrape Facebook post",
        };
      }
    },
  );

  // Select Facebook Insights CSV file
  ipcMain.handle("select-facebook-insights-csv", async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: "Select Facebook Insights CSV",
        filters: [
          { name: "CSV Files", extensions: ["csv"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });

      if (result.canceled) {
        return { success: false, canceled: true };
      }

      return { success: true, filePath: result.filePaths[0] };
    } catch (error) {
      console.error("[FB Insights] File selection error:", error);
      return { success: false, error: error.message };
    }
  });

  // Parse Facebook Insights CSV
  ipcMain.handle("parse-facebook-insights-csv", async (_, filePath) => {
    try {
      const fs = require("fs");
      const csvContent = fs.readFileSync(filePath, "utf-8");

      // Parse CSV - handle quoted fields with newlines
      const parseCSV = (content) => {
        const rows = [];
        let currentRow = [];
        let currentField = "";
        let inQuotes = false;

        for (let i = 0; i < content.length; i++) {
          const char = content[i];
          const nextChar = content[i + 1];

          if (char === '"') {
            if (inQuotes && nextChar === '"') {
              currentField += '"';
              i++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (char === "," && !inQuotes) {
            currentRow.push(currentField);
            currentField = "";
          } else if (
            (char === "\n" || (char === "\r" && nextChar === "\n")) &&
            !inQuotes
          ) {
            if (char === "\r") i++;
            currentRow.push(currentField);
            if (currentRow.length > 1 || currentRow[0] !== "") {
              rows.push(currentRow);
            }
            currentRow = [];
            currentField = "";
          } else {
            currentField += char;
          }
        }

        if (currentField || currentRow.length > 0) {
          currentRow.push(currentField);
          rows.push(currentRow);
        }

        return rows;
      };

      const rows = parseCSV(csvContent);
      if (rows.length < 2) {
        return {
          success: false,
          error: "CSV file is empty or has no data rows",
        };
      }

      const headers = rows[0];

      // LANGUAGE-AGNOSTIC DETECTION: Detect columns by content patterns, not header names
      let permalinkIdx = -1;
      let descriptionIdx = -1;

      // Analyze data rows to detect column types
      // Use first 5 rows for quick detection
      const sampleRows = rows.slice(1, Math.min(6, rows.length));
      
      // For description detection, sample rows across the entire dataset to handle
      // bilingual CSVs where some rows use French columns and others use English columns
      const descriptionSampleRows = [];
      const step = Math.max(1, Math.floor((rows.length - 1) / 20)); // Sample ~20 rows across dataset
      for (let i = 1; i < rows.length && descriptionSampleRows.length < 20; i += step) {
        descriptionSampleRows.push(rows[i]);
      }

      // Find permalink column: contains facebook.com URLs (supports both /posts/ and /permalink.php formats)
      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        let matchCount = 0;
        for (const row of sampleRows) {
          const val = row[colIdx] || "";
          // Match both URL formats:
          // - facebook.com/*/posts/... (standard post URLs)
          // - facebook.com/permalink.php?story_fbid=... (Creator Studio export format)
          if (
            val.includes("facebook.com") &&
            (val.includes("/posts/") || val.includes("/permalink.php"))
          ) {
            matchCount++;
          }
        }
        if (matchCount >= Math.min(2, sampleRows.length)) {
          permalinkIdx = colIdx;
          break;
        }
      }

      // Find description column candidates: columns with long text content (typically > 50 chars) that are not URLs
      // We track multiple candidates because bilingual CSVs may have data in either French or English columns
      // Use distributed sample to catch both column types
      const descriptionCandidates = [];
      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        if (colIdx === permalinkIdx) continue;

        let totalLength = 0;
        let validCount = 0;
        for (const row of descriptionSampleRows) {
          const val = row[colIdx] || "";
          // Skip URLs and very short text
          if (!val.includes("http") && val.length > 20) {
            totalLength += val.length;
            validCount++;
          }
        }

        if (validCount > 0) {
          const avgLength = totalLength / validCount;
          // Lower threshold to catch columns that may have data in only some rows
          if (avgLength > 30) {
            descriptionCandidates.push({ colIdx, avgLength, validCount });
          }
        }
      }
      
      // Sort by valid count (coverage) first, then by average length
      // This prioritizes columns that have data in more rows
      descriptionCandidates.sort((a, b) => {
        // Prioritize columns with more valid entries
        if (b.validCount !== a.validCount) return b.validCount - a.validCount;
        // Then by average length
        return b.avgLength - a.avgLength;
      });
      
      // Primary description column is the one with best coverage
      descriptionIdx = descriptionCandidates.length > 0 ? descriptionCandidates[0].colIdx : -1;

      // Find views column: Look for numeric column with realistic view counts
      // Views are typically hundreds to millions, but NOT huge IDs/timestamps (15+ digits)
      // Filter: values should be between 10 and 100,000,000 (100M) to be realistic views
      let viewsIdx = -1;
      let maxAvgViews = 0;

      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        if (colIdx === permalinkIdx || colIdx === descriptionIdx) continue;

        let totalValue = 0;
        let numericCount = 0;
        let hasUnrealisticValue = false;

        for (const row of sampleRows) {
          const val = row[colIdx]?.trim() || "";
          // Check if it's a numeric value
          if (/^\d+$/.test(val)) {
            const numVal = parseInt(val);
            // Skip columns with very large values (IDs, timestamps - typically 15+ digits)
            if (numVal > 100000000) {
              // Over 100 million = likely ID/timestamp
              hasUnrealisticValue = true;
              break;
            }
            totalValue += numVal;
            numericCount++;
          }
        }

        // Skip columns with unrealistic values (IDs/timestamps)
        if (hasUnrealisticValue) continue;

        // Only consider columns where most rows have numeric values
        if (numericCount >= Math.min(2, sampleRows.length)) {
          const avgValue = totalValue / numericCount;
          // Views typically have higher values (100+) compared to reactions/shares
          // Look for the numeric column with the highest average value
          if (avgValue > maxAvgViews && avgValue >= 10) {
            maxAvgViews = avgValue;
            viewsIdx = colIdx;
          }
        }
      }

      // Find shares column by header name (supports multiple languages)
      // Shares = "Partages" (French), "Shares" (English), etc.
      let sharesIdx = -1;
      const sharesHeaders = ['partages', 'shares', 'compartidos', 'condivisioni', 'teilen'];
      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        const headerLower = (headers[colIdx] || '').toLowerCase().trim();
        if (sharesHeaders.includes(headerLower)) {
          sharesIdx = colIdx;
          break;
        }
      }

      // If not found by header, try to detect by pattern (small numbers, not views)
      if (sharesIdx === -1) {
        for (let colIdx = 0; colIdx < headers.length; colIdx++) {
          if (colIdx === permalinkIdx || colIdx === descriptionIdx || colIdx === viewsIdx) continue;

          let totalValue = 0;
          let numericCount = 0;
          let allSmall = true;

          for (const row of sampleRows) {
            const val = row[colIdx]?.trim() || '';
            if (/^\d+$/.test(val)) {
              const numVal = parseInt(val);
              totalValue += numVal;
              numericCount++;
              // Shares are typically smaller than views (< 10000)
              if (numVal > 50000) allSmall = false;
            }
          }

          // Shares column: mostly numeric, smaller values than views
          if (numericCount >= Math.min(2, sampleRows.length) && allSmall) {
            const avgValue = totalValue / numericCount;
            // Shares typically 0-10000, much less than views
            if (avgValue >= 0 && avgValue < maxAvgViews / 2) {
              sharesIdx = colIdx;
              break;
            }
          }
        }
      }

      console.log(
        `[FB Insights] Auto-detected columns - Permalink: ${permalinkIdx}, Views: ${viewsIdx}, Shares: ${sharesIdx}, Description: ${descriptionIdx}`,
      );
      console.log(
        `[FB Insights] Total columns: ${headers.length}, Avg views value: ${Math.round(maxAvgViews)}, Description candidates: ${descriptionCandidates.length}`,
      );

      if (permalinkIdx === -1) {
        return {
          success: false,
          error:
            "Could not find Facebook post URLs in CSV. Make sure this is a Facebook Content export.",
        };
      }

      if (descriptionIdx === -1) {
        return {
          success: false,
          error: "Could not find post content/description column in CSV.",
        };
      }

      // Parse posts
      const posts = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.length <= permalinkIdx) continue;

        const permalink = row[permalinkIdx]?.trim();
        if (!permalink || !permalink.includes("facebook.com")) continue;

        const views = viewsIdx !== -1 ? parseInt(row[viewsIdx]) || 0 : 0;
        const shares = sharesIdx !== -1 ? parseInt(row[sharesIdx]) || 0 : 0;
        
        // Try to get description from any of the candidate columns (handles bilingual CSVs)
        let description = "";
        for (const candidate of descriptionCandidates) {
          const val = row[candidate.colIdx]?.trim() || "";
          if (val && val.length > 20 && !val.includes("http")) {
            description = val;
            break;
          }
        }

        // Skip posts without descriptions
        if (!description) continue;

        posts.push({
          permalink,
          description,
          views,
          shares,
          rowIndex: i,
        });
      }

      // Sort by views descending
      posts.sort((a, b) => b.views - a.views);

      console.log(`[FB Insights] Parsed ${posts.length} posts from CSV`);
      if (posts.length > 0) {
        console.log(`[FB Insights] Top post has ${posts[0].views} views, ${posts[0].shares} shares`);
      }

      return { success: true, posts, totalRows: rows.length - 1 };
    } catch (error) {
      console.error("[FB Insights] CSV parse error:", error);
      return {
        success: false,
        error: error.message || "Failed to parse CSV file",
      };
    }
  });

  // Process Facebook Insights posts - fetch images and download
  ipcMain.handle("process-facebook-insights-posts", async (event, posts) => {
    const {
      extractFacebookPostImage,
      validateSpyProfiles,
    } = require("../automations/facebookScraper");
    
    // Pre-validate spy profiles before processing any posts
    const validation = await validateSpyProfiles();
    if (!validation.valid) {
      console.log('[FB Insights] Pre-validation failed:', validation.error);
      return { 
        success: false, 
        error: validation.error,
        errorType: validation.errorType 
      };
    }
    
    const results = [];
    const total = posts.length;

    const sendProgress = (current, status, message, type = "info") => {
      event.sender.send("fb-insights-progress", {
        current,
        total,
        percent: Math.round((current / total) * 100),
        status,
        message,
        type,
      });
    };

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const postNum = i + 1;

      try {
        sendProgress(
          postNum,
          "extracting",
          `Extracting image from post ${postNum}...`,
          "info",
        );

        // Extract image URL from post (also downloads through browser session)
        const imageResult = await extractFacebookPostImage(
          post.permalink,
          120000,
        );

        if (!imageResult.success) {
          const errorMsg = imageResult.value || imageResult.error;
          
          // Check if all profiles are logged out - stop early and show specific error
          if (errorMsg && errorMsg.includes('All spy profiles are logged out')) {
            sendProgress(
              postNum,
              "error",
              `All Facebook spy profiles are logged out or blocked. Please re-login to at least one spy profile.`,
              "error",
            );
            // Return immediately with specific error - no point trying more posts
            return {
              success: false,
              error: 'All Facebook spy profiles are logged out or blocked. Please re-login to at least one spy profile in the Spy page.',
              errorType: 'all_profiles_blocked'
            };
          }
          
          sendProgress(
            postNum,
            "error",
            `Post ${postNum}: Failed to extract image - ${errorMsg}`,
            "error",
          );
          results.push({
            ...post,
            success: false,
            error: errorMsg,
          });
          continue;
        }

        // Check if image was already downloaded by the scraper
        let localImage = imageResult.localPath;

        if (!localImage) {
          // Fallback: try direct download (may fail with 403)
          sendProgress(
            postNum,
            "downloading",
            `Downloading image for post ${postNum}...`,
            "info",
          );
          try {
            localImage = await downloadFileToUserData(imageResult.value);
          } catch (downloadError) {
            console.log(
              `[FB Insights] Direct download failed for post ${postNum}:`,
              downloadError.message,
            );
            // Still mark as success if we have the URL, just no local image
            results.push({
              ...post,
              success: false,
              imageUrl: imageResult.value,
              error: "Image download failed (403 - access denied)",
            });
            sendProgress(
              postNum,
              "error",
              `Post ${postNum}: Download failed - 403`,
              "error",
            );
            continue;
          }
        }

        sendProgress(
          postNum,
          "success",
          `Post ${postNum}: Image downloaded successfully`,
          "success",
        );

        results.push({
          ...post,
          success: true,
          imageUrl: imageResult.value,
          localImage: localImage,
        });
      } catch (error) {
        console.error(`[FB Insights] Error processing post ${postNum}:`, error);
        sendProgress(
          postNum,
          "error",
          `Post ${postNum}: ${error.message}`,
          "error",
        );
        results.push({
          ...post,
          success: false,
          error: error.message,
        });
      }
    }

    sendProgress(total, "complete", "All posts processed", "success");

    const successCount = results.filter((r) => r.success).length;
    console.log(
      `[FB Insights] Processed ${successCount}/${total} posts successfully`,
    );

    return { success: true, results };
  });

  // Pinterest Trends API
  ipcMain.handle(
    "fetch-pinterest-trends",
    async (_, category, country = "US") => {
      try {
        // Use date from 10 months ago
        const date = new Date();
        date.setMonth(date.getMonth() - 10);
        const endDate = date.toISOString().split("T")[0];

        const presets = [3, 4];

        console.log(
          `[Pinterest Trends] Fetching trends for category ${category}, date ${endDate}, presets ${presets.join(",")}`,
        );

        const requests = presets.map((preset) => {
          const url = `https://trends.pinterest.com/top_trends_filtered/?lookbackWindow=2&endDate=${endDate}&l1interests=${category}&country=${country}&trendsPreset=${preset}`;
          return axios.get(url, {
            timeout: 15000,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
              Accept: "application/json",
              "Accept-Language": "en-US,en;q=0.9",
            },
          });
        });

        const responses = await Promise.all(requests);

        const allValues = responses.flatMap((res) => res.data?.values || []);

        if (!allValues.length) {
          return { success: false, error: "No trends data found in response" };
        }

        // Merge, sort, and deduplicate by term
        const trendsMap = new Map();

        for (const item of allValues) {
          const existing = trendsMap.get(item.term);
          if (!existing || (item.searchCount || 0) > existing.searchCount) {
            trendsMap.set(item.term, {
              term: item.term,
              searchCount: item.searchCount || 0,
              seasonalityScore: item.seasonality_score || 0,
            });
          }
        }

        const trends = Array.from(trendsMap.values()).sort(
          (a, b) => b.searchCount - a.searchCount,
        );

        console.log(
          `[Pinterest Trends] Found ${trends.length} trending keywords`,
        );
        return { success: true, trends, endDate };
      } catch (error) {
        console.error("[Pinterest Trends] Error:", error.message);
        return {
          success: false,
          error: error.message || "Failed to fetch Pinterest trends",
        };
      }
    },
  );

  // ============ Google Trends Handlers ============

  // Fetch Google Trends
  ipcMain.handle("fetch-google-trends", async (_, options = {}) => {
    try {
      const { fetchGoogleTrends } = require("../automations/googleTrends");
      const result = await fetchGoogleTrends(options);
      return result;
    } catch (error) {
      console.error("[Google Trends] Handler error:", error);
      return {
        success: false,
        error: error.message || "Failed to fetch Google Trends",
        trends: [],
      };
    }
  });

  // Get Google Trends categories
  ipcMain.handle("get-google-trends-categories", async () => {
    try {
      const { getCategories } = require("../automations/googleTrends");
      return { success: true, categories: getCategories() };
    } catch (error) {
      console.error("[Google Trends] Categories error:", error);
      return { success: false, error: error.message, categories: [] };
    }
  });

  // Get Google Trends regions
  ipcMain.handle("get-google-trends-regions", async () => {
    try {
      const { getRegions } = require("../automations/googleTrends");
      return { success: true, regions: getRegions() };
    } catch (error) {
      console.error("[Google Trends] Regions error:", error);
      return { success: false, error: error.message, regions: [] };
    }
  });

  // Get Google Trends time ranges
  ipcMain.handle("get-google-trends-time-ranges", async () => {
    try {
      const { getTimeRanges } = require("../automations/googleTrends");
      return { success: true, timeRanges: getTimeRanges() };
    } catch (error) {
      console.error("[Google Trends] Time ranges error:", error);
      return { success: false, error: error.message, timeRanges: [] };
    }
  });

  // ============ Pinterest Feed Spy ============

  // Mark pin IDs as used (persistent)
  ipcMain.handle("pfeedspy-mark-used", async (_, pinIds) => {
    try {
      const existing = (await readKey("pfeedspyUsedPins")) || [];
      const merged = Array.from(new Set([...existing, ...pinIds]));
      await updateData("pfeedspyUsedPins", merged);
      return { success: true };
    } catch (e) {
      console.error("[PFeedSpy] mark-used error:", e.message);
      return { success: false };
    }
  });

  // Get the set of used pin IDs
  ipcMain.handle("pfeedspy-get-used", async () => {
    try {
      const ids = (await readKey("pfeedspyUsedPins")) || [];
      return { success: true, ids };
    } catch (e) {
      return { success: true, ids: [] };
    }
  });

  // Generate similar Pinterest pin titles using a connected AI provider
  ipcMain.handle("pfeedspy-generate-titles", async (_, { pins, provider, model, titlesPerPin = 3, perPinCounts = null, usedTitles = [] }) => {
    try {
      if (!provider || !model) {
        return { success: false, error: "AI provider and model are required" };
      }
      if (!Array.isArray(pins) || pins.length === 0) {
        return { success: false, error: "No pins provided" };
      }

      // perPinCounts overrides titlesPerPin when provided (variable per-pin allocation)
      const uniformCount = Math.max(1, Math.min(200, parseInt(titlesPerPin) || 3));
      const getPinCount = (i) => perPinCounts ? Math.max(1, parseInt(perPinCounts[i]) || 1) : uniformCount;

      const avoidSection = usedTitles && usedTitles.length > 0
        ? `\nAlready-used titles to AVOID (do not generate anything identical or nearly identical to these):\n${usedTitles.slice(0, 80).map((t) => `- ${t}`).join("\n")}\n`
        : "";

      // Helper: call the selected AI provider
      const callAI = async (prompt) => {
        if (provider === "deepseek") {
          const { deepseekBrowser } = require("../automations/deepseekBrowser");
          return deepseekBrowser(prompt, false, false);
        } else if (provider === "openai") {
          const { openAi } = require("../automations/openai");
          return openAi(null, model, prompt, 0.85);
        } else if (provider === "anthropic") {
          const { anthropic } = require("../automations/anthropic");
          return anthropic(model, prompt, 0.85);
        } else if (provider === "googleai") {
          const { googleAI } = require("../automations/googleai");
          return googleAI(model, prompt, 0.85);
        }
        return { success: false, value: `Unknown AI provider: ${provider}` };
      };

      // Helper: build prompt for a batch of pins with per-pin counts
      const buildPrompt = (batch, batchCounts = []) => {
        const n = batch.length;
        const allSameCount = batchCounts.every((c) => c === batchCounts[0]);
        const singleCount = allSameCount ? batchCounts[0] : null;

        const exampleCount = singleCount || 3;
        const exampleBlock = exampleCount === 1
          ? "Savory Mediterranean Chickpea Salad\n---\nEasy 30-Minute Chicken Tikka Masala"
          : `Savory Mediterranean Chickpea Salad\nChickpea Salad for a Protein-Packed Dinner\nCreamy Lemon Chickpea Salad Recipe\n---\nEasy 30-Minute Chicken Tikka Masala\nAuthentic Chicken Tikka Masala at Home\nThe Best Creamy Chicken Tikka Masala`;

        const pinLines = batch.map((p, i) => {
          const title = (p.title || p.description || "").trim();
          const countLabel = allSameCount ? "" : ` (generate ${batchCounts[i]} title${batchCounts[i] !== 1 ? "s" : ""})`;
          return `[${i + 1}]${countLabel} ${title}`;
        }).join("\n");

        const countInstruction = allSameCount
          ? `For each pin, generate exactly ${singleCount} new Pinterest title variation(s)`
          : `For each pin, generate exactly the number of titles shown in parentheses next to the pin number`;

        const strictRule = allSameCount
          ? `- Output EXACTLY ${singleCount} title(s) per pin, one per line`
          : `- Output EXACTLY the requested number of titles per pin (shown in parentheses), one per line`;

        return `You are a Pinterest SEO expert and content creator. Below are ${n} Pinterest pin title(s). ${countInstruction} that:
- ALWAYS embed the exact core keyword(s) from the original title naturally inside the new title
- Add descriptive adjectives, benefits, contexts, or occasions AROUND the core keyword (e.g. "Savory Mediterranean [keyword]", "[keyword] for a Protein-Packed Dinner", "Easy Homemade [keyword] Recipe")
- Make every title sound like a real Pinterest search query that people type
- Keep titles between 4 and 10 words
- No numbering, no bullets, no quotation marks in the output

Original titles:
${pinLines}
${avoidSection}
Strict rules:
${strictRule}
- Separate each pin's block with a line containing only "---"
- Output NOTHING else — no explanations, no headers, no blank lines between titles within a block

Example output for ${exampleCount} title(s) per pin:
${exampleBlock}`;
      };

      // Helper: parse AI response text into per-pin title arrays
      const parseResponse = (text, batch, batchCounts = []) => {
        const sections = text.split(/\n[ \t]*---[ \t]*\n/).map((s) => s.trim());
        return batch.map((pin, i) => {
          const pinCount = batchCounts[i] || uniformCount;
          const section = sections[i] || "";
          const titles = section
            .split("\n")
            .map((t) =>
              t.trim()
                .replace(/^["'*\u2022\-]+\s*|\s*["']$/g, "")
                .replace(/^\d+[\.)]\s*/, "")
                .trim(),
            )
            .filter((t) => t.length > 2)
            .slice(0, pinCount);
          return { pinId: pin.id, titles };
        });
      };

      // Process pins in batches of 20 to handle very large selections
      const BATCH_SIZE = 20;
      const grouped = [];

      for (let i = 0; i < pins.length; i += BATCH_SIZE) {
        const batch = pins.slice(i, i + BATCH_SIZE);
        const batchCounts = batch.map((_, j) => getPinCount(i + j));
        const prompt = buildPrompt(batch, batchCounts);
        const result = await callAI(prompt);
        if (!result.success) {
          console.error(`[PFeedSpy] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${result.value}`);
          for (const pin of batch) grouped.push({ pinId: pin.id, titles: [] });
        } else {
          const batchGrouped = parseResponse(result.value, batch, batchCounts);
          grouped.push(...batchGrouped);
        }
      }

      const totalGenerated = grouped.reduce((s, g) => s + g.titles.length, 0);
      console.log(`[PFeedSpy] AI generated ${totalGenerated} titles for ${pins.length} pins (${Math.ceil(pins.length / BATCH_SIZE)} batch(es))`);
      return { success: true, grouped };
    } catch (error) {
      console.error("[PFeedSpy] Title generation error:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Initialize Pinterest session cookies via a connected account (VCBrowser headless)
  ipcMain.handle("pinterest-feedspy-init-account", async (_, accountId) => {
    const { startVCBrowser, isVCBrowserInstalled } = require("../lib/VCBrowserManager");
    const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("./cdpFingerprint");

    if (!isVCBrowserInstalled()) {
      return { success: false, error: "VCBrowser is not installed. Please download it from Settings." };
    }

    let chromeProcess = null;
    let client = null;

    try {
      const pinterestAccounts = (await readKey("pinterestAccounts")) || {};
      const account = pinterestAccounts[accountId];
      if (!account) return { success: false, error: "Pinterest account not found" };

      if (!account.linkedStructureId || !account.linkedProfileId) {
        return { success: false, error: "Pinterest account has no linked VCBrowser profile" };
      }

      const structures = (await readKey("structures")) || {};
      const structure = structures[account.linkedStructureId];
      if (!structure?.profiles?.[account.linkedProfileId]) {
        return { success: false, error: "Linked VCBrowser profile not found" };
      }

      const profile = structure.profiles[account.linkedProfileId];
      const profileId = account.linkedProfileId;

      // Resolve proxy
      let proxy = null;
      if (profile.proxy && profile.proxy.ip && profile.proxy.ip !== "NULL") {
        proxy = profile.proxy;
      }

      // Resolve fingerprint
      let fingerprint = profile.fingerprint;
      if (!fingerprint || Object.keys(fingerprint).length === 0) {
        fingerprint = getConsistentFingerprintForProfile(profileId);
      }
      try {
        const vcVersion = getVCBrowserVersion();
        if (fingerprint.userAgent && vcVersion?.full) {
          fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
        }
      } catch (e) { /* ignore */ }

      const storedCookies = profile.cookies || [];

      console.log(`[PFeedSpy] Starting VCBrowser headless for account ${accountId}, profile: ${profileId}`);

      const result = await startVCBrowser(profileId, fingerprint, "about:blank", proxy, true, true);
      if (!result?.client) return { success: false, error: "Failed to start VCBrowser" };

      client = result.client;
      chromeProcess = result.chromeProcess;
      const { Page, Runtime, Network } = client;

      // Inject stored cookies
      if (storedCookies.length > 0) {
        await Network.enable();
        for (const cookie of storedCookies) {
          const cdpCookie = {
            name: cookie.name, value: cookie.value,
            domain: cookie.domain, path: cookie.path || "/",
            secure: cookie.secure || false, httpOnly: cookie.httpOnly || false,
          };
          if (cookie.expires) cdpCookie.expires = cookie.expires;
          try { await Network.setCookie(cdpCookie); } catch (e) { /* ignore */ }
        }
        console.log(`[PFeedSpy] Injected ${storedCookies.length} stored cookies`);
      }

      // Navigate to Pinterest homepage to trigger a real authenticated session
      await Page.navigate({ url: "https://www.pinterest.com/" });
      await new Promise((r) => setTimeout(r, 7000));

      // Check we're actually logged in
      const urlRes = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
      const currentUrl = urlRes.result?.value || "";
      if (currentUrl.includes("/login") || currentUrl.includes("accounts.pinterest.com")) {
        return { success: false, error: "Pinterest account is not logged in. Please open the VCBrowser profile and log in to Pinterest manually first." };
      }

      // Extract all pinterest.com cookies from the live session
      const cookiesResult = await Network.getCookies({ urls: ["https://www.pinterest.com"] });
      const liveCookies = cookiesResult.cookies || [];

      console.log(`[PFeedSpy] Extracted ${liveCookies.length} cookies from live session`);

      // Build the cookie map expected by the feed spy page fetcher
      const cookies = {};
      for (const c of liveCookies) {
        cookies[c.name] = c.value;
      }

      // Ensure required extra cookies
      if (cookies["_routing_id"] && !cookies["_routing_id"].startsWith('"')) {
        cookies["_routing_id"] = `"${cookies["_routing_id"]}"`;
      }
      cookies["sessionFunnelEventLogged"] = "1";
      const nowMs = Date.now();
      if (!cookies["g_state"]) {
        cookies["g_state"] = JSON.stringify({ i_l: 0, i_ll: nowMs, i_b: "WAG5gHSC810fzOmdkzI2ZujOhfNHEdYOCJ06DG/SFfE", i_e: { enable_itp_optimization: 1 }, i_et: nowMs });
      }

      if (!cookies["_pinterest_sess"] && !cookies["csrftoken"]) {
        return { success: false, error: "Could not obtain Pinterest session cookies from the account" };
      }

      return { success: true, cookies };
    } catch (error) {
      console.error("[PFeedSpy] Account init error:", error.message);
      return { success: false, error: error.message };
    } finally {
      // Always close the browser
      try {
        if (client) await client.close().catch(() => {});
      } catch (e) { /* ignore */ }
      try {
        if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
      } catch (e) { /* ignore */ }
    }
  });

  const pinterestTrendRequests = new Map();
  ipcMain.handle("pinterest-feedspy-trends", async (event, { query, requestId } = {}) => {
    if (typeof requestId !== "string" || requestId.length > 100) return { success: false };
    const key = `${event.sender.id}:${requestId}`;
    const controller = new AbortController();
    pinterestTrendRequests.get(key)?.abort();
    pinterestTrendRequests.set(key, controller);
    try {
      const result = await require("./pinterestTrends").discoverTrendingKeywords(query, { signal: controller.signal });
      return { success: true, ...result };
    } catch (error) {
      console.warn("[PFeedSpy] Trend discovery failed:", error.code || error.message);
      return { success: false, cancelled: controller.signal.aborted };
    } finally {
      if (pinterestTrendRequests.get(key) === controller) pinterestTrendRequests.delete(key);
    }
  });
  ipcMain.handle("pinterest-feedspy-cancel-trends", (event, requestId) => {
    pinterestTrendRequests.get(`${event.sender.id}:${requestId}`)?.abort();
    return { success: true };
  });

  // Initialize Pinterest session cookies for feed spy
  ipcMain.handle("pinterest-feedspy-init", async (_, query) => {
    try {
      const axios = require("axios");
      const encodedQuery = encodeURIComponent(query);

      const response = await axios.get(
        `https://www.pinterest.com/search/pins/?q=${encodedQuery}`,
        {
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-language": "fr-FR,fr;q=0.9",
            priority: "u=0, i",
            "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
          },
          maxRedirects: 5,
          timeout: 15000,
          validateStatus: (status) => status < 500,
        },
      );

      // Extract cookies from response headers
      const cookies = {};
      const setCookieHeader = response.headers["set-cookie"] || [];
      for (const cookie of setCookieHeader) {
        const [nameValue] = cookie.split(";");
        const eqIdx = nameValue.indexOf("=");
        if (eqIdx > 0) {
          const name = nameValue.substring(0, eqIdx).trim();
          const value = nameValue.substring(eqIdx + 1).trim();
          cookies[name] = value;
        }
      }

      if (!cookies["_pinterest_sess"] && !cookies["csrftoken"]) {
        return { success: false, error: "Could not obtain Pinterest session cookies" };
      }

      // Add extra cookies the Python scraper sets manually
      const nowMs = Date.now();
      if (cookies["_routing_id"]) {
        // Pinterest expects this wrapped in double-quotes
        cookies["_routing_id"] = `"${cookies["_routing_id"]}"`;
      }
      cookies["_auth"] = "0";
      cookies["sessionFunnelEventLogged"] = "1";
      cookies["g_state"] = JSON.stringify({
        i_l: 0,
        i_ll: nowMs,
        i_b: "WAG5gHSC810fzOmdkzI2ZujOhfNHEdYOCJ06DG/SFfE",
        i_e: { enable_itp_optimization: 1 },
        i_et: nowMs,
      });

      return { success: true, cookies };
    } catch (error) {
      console.error("[PFeedSpy] Init error:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Fetch one page of Pinterest search results
  ipcMain.handle("pinterest-feedspy-page", async (_, { query, cookies, bookmark }) => {
    try {
      const axios = require("axios");
      const querySlug = query.replace(/\s+/g, "-");
      const queryEncoded = encodeURIComponent(query);
      const sourceUrl = `/search/pins/?eq=${querySlug}&q=${queryEncoded}`;

      const options = {
        query,
        scope: "pins",
        appliedProductFilters: "---",
        domains: null,
        user: null,
        seoDrawerEnabled: false,
        applied_unified_filters: null,
        auto_correction_disabled: false,
        journey_depth: null,
        source_id: null,
        source_module_id: null,
        source_url: sourceUrl,
        static_feed: false,
        selected_one_bar_modules: null,
        query_pin_sigs: null,
        page_size: null,
        price_max: null,
        price_min: null,
        query_image_pins: null,
        request_params: null,
        top_pin_ids: null,
        article: null,
        corpus: null,
        customized_rerank_type: null,
        filters: null,
        rs: "direct_navigation",
        redux_normalize_feed: true,
      };

      if (bookmark) {
        options.bookmarks = [bookmark];
      }

      const nowMs = Date.now();
      const params = new URLSearchParams({
        source_url: sourceUrl,
        data: JSON.stringify({ options, context: {} }),
        _: String(nowMs),
      });

      // Build cookie string from stored cookies
      const cookieStr = Object.entries(cookies || {})
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");

      const response = await axios.get(
        `https://www.pinterest.com/resource/BaseSearchResource/get/?${params.toString()}`,
        {
          headers: {
            accept: "application/json, text/javascript, */*, q=0.01",
            "accept-language": "fr-FR,fr;q=0.9",
            cookie: cookieStr,
            referer: "https://www.pinterest.com/",
            "screen-dpr": "1",
            "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            "sec-ch-ua-full-version-list":
              '"Google Chrome";v="147.0.7727.57", "Not.A/Brand";v="8.0.0.0", "Chromium";v="147.0.7727.57"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-model": '""',
            "sec-ch-ua-platform": '"Windows"',
            "sec-ch-ua-platform-version": '"10.0.0"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
            "x-app-version": "8efc3ef",
            "x-b3-flags": "0",
            "x-b3-parentspanid": "5a20e41a2bcd64eb",
            "x-b3-spanid": "7f13c5850e2c9666",
            "x-b3-traceid": "5a20e41a2bcd64eb",
            "x-pinterest-appstate": "active",
            "x-pinterest-pws-handler": "www/search/[scope].js",
            "x-pinterest-source-url": sourceUrl,
            "x-requested-with": "XMLHttpRequest",
          },
          timeout: 15000,
          validateStatus: (status) => status < 500,
        },
      );

      const data = response.data;
      const results = data?.resource_response?.data?.results || [];
      const nextBookmark = data?.resource_response?.bookmark || null;

      const pins = [];
      for (const pin of results) {
        try {
          const image = pin?.images?.orig?.url;
          if (!image) continue;
          const link = pin?.link || "";
          if (!link || !link.startsWith("http")) continue; // skip pins without an external link
          pins.push({
            id: pin.id,
            title: pin.title || "",
            description: pin.description || "",
            image,
            link,
            reactions: pin?.reaction_counts?.["1"] || 0,
            created_at: pin.created_at || "",
          });
        } catch (e) {
          // skip malformed pins
        }
      }

      return { success: true, pins, bookmark: nextBookmark, done: !nextBookmark };
    } catch (error) {
      console.error("[PFeedSpy] Page fetch error:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Download Pinterest images with per-image progress events
  ipcMain.handle("pinterest-feedspy-download-images", async (event, imageUrls) => {
    try {
      if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
        return { success: false, error: "No images to download", results: [] };
      }

      const axios = require("axios");
      const path = require("path");
      const fs = require("fs");
      const { app } = require("electron");

      const imagesDir = path.join(app.getPath("userData"), "Images");
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }

      const results = [];

      for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        try {
          const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 20000,
            headers: {
              accept:
                "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
              "accept-language": "fr-FR,fr;q=0.9",
              referer: "https://www.pinterest.com/",
              "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
              "sec-ch-ua-mobile": "?0",
              "sec-ch-ua-platform": '"Windows"',
              "sec-fetch-dest": "image",
              "sec-fetch-mode": "no-cors",
              "sec-fetch-site": "cross-site",
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
            },
          });

          const rawExt = (url.split(".").pop() || "jpg").split("?")[0].toLowerCase().replace(/[^a-z]/g, "");
          const safeExt = ["jpg", "jpeg", "png", "webp", "gif"].includes(rawExt) ? rawExt : "jpg";
          const filename = `pfeedspy_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${safeExt}`;
          const filePath = path.join(imagesDir, filename);

          fs.writeFileSync(filePath, Buffer.from(response.data));
          results.push({ url, success: true, value: filename });
        } catch (e) {
          results.push({ url, success: false, error: e.message });
        }

        // Send progress event after each image
        const percent = Math.round(((i + 1) / imageUrls.length) * 100);
        if (!event.sender.isDestroyed()) {
          event.sender.send("pfeedspy-download-progress", {
            current: i + 1,
            total: imageUrls.length,
            percent,
          });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      console.log(`[PFeedSpy] Downloaded ${successCount}/${imageUrls.length} images`);
      return { success: true, results, successCount, total: imageUrls.length };
    } catch (error) {
      console.error("[PFeedSpy] Download images error:", error.message);
      return { success: false, error: error.message, results: [] };
    }
  });

  // ============ End Pinterest Feed Spy ============

  // Open Google Trends in visible browser (for captcha solving)
  ipcMain.handle("open-google-trends-browser", async (_, options = {}) => {
    try {
      const { fetchGoogleTrendsVisible } = require("../automations/googleTrends");
      const result = await fetchGoogleTrendsVisible(options);
      return result;
    } catch (error) {
      console.error("[Google Trends] Open browser error:", error);
      return {
        success: false,
        error: error.message || "Failed to open browser",
      };
    }
  });

  // OpenAI Queue Statistics - for monitoring rate limiting
  ipcMain.handle("get-openai-queue-stats", async () => {
    try {
      const { getQueueStats } = require("./openaiQueue");
      const stats = getQueueStats();
      return { success: true, stats };
    } catch (err) {
      console.error("[OpenAI Queue] Error getting stats:", err.message);
      return { success: false, message: err.message };
    }
  });

  // OpenRouter Queue Statistics
  ipcMain.handle("get-openrouter-queue-stats", async () => {
    try {
      const { getOpenRouterQueueStats } = require("./openrouterQueue");
      const stats = getOpenRouterQueueStats();
      return { success: true, stats };
    } catch (err) {
      console.error("[OpenRouter Queue] Error getting stats:", err.message);
      return { success: false, message: err.message };
    }
  });

  // Google AI Queue Statistics
  ipcMain.handle("get-googleai-queue-stats", async () => {
    try {
      const { getGoogleAIQueueStats } = require("./googleAIQueue");
      const stats = getGoogleAIQueueStats();
      return { success: true, stats };
    } catch (err) {
      console.error("[Google AI Queue] Error getting stats:", err.message);
      return { success: false, message: err.message };
    }
  });

  // Anthropic Queue Statistics
  ipcMain.handle("get-anthropic-queue-stats", async () => {
    try {
      const { getAnthropicQueueStats } = require("./anthropicQueue");
      const stats = getAnthropicQueueStats();
      return { success: true, stats };
    } catch (err) {
      console.error("[Anthropic Queue] Error getting stats:", err.message);
      return { success: false, message: err.message };
    }
  });

  // Chinese AI Queue Statistics
  ipcMain.handle("get-chineseai-queue-stats", async () => {
    try {
      const { getChineseAIQueueStats } = require("./chineseAIQueue");
      const stats = getChineseAIQueueStats();
      return { success: true, stats };
    } catch (err) {
      console.error("[Chinese AI Queue] Error getting stats:", err.message);
      return { success: false, message: err.message };
    }
  });

  // GPT-Image Queue Statistics
  ipcMain.handle("get-gptimage-queue-stats", async () => {
    try {
      const { getGPTImageQueueStats } = require("../automations/gptimage");
      const stats = getGPTImageQueueStats();
      return { success: true, stats };
    } catch (err) {
      console.error("[GPT-Image Queue] Error getting stats:", err.message);
      return { success: false, message: err.message };
    }
  });

  // Sora Image Queue Statistics
  ipcMain.handle("get-soraimage-queue-stats", async () => {
    try {
      const { getSoraImageQueueStats } = require("../automations/soraImage");
      const stats = getSoraImageQueueStats();
      return { success: true, stats };
    } catch (err) {
      console.error("[Sora Image Queue] Error getting stats:", err.message);
      return { success: false, message: err.message };
    }
  });

  // Sora Image Enabled Profiles (multi-profile support)
  ipcMain.handle("save-enabled-sora-profiles", async (_, profileIds) => {
    try {
      await updateData("enabledSoraProfiles", profileIds);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-enabled-sora-profiles", async () => {
    try {
      const profileIds = await readKey("enabledSoraProfiles");
      return { success: true, profileIds: profileIds || [] };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // Gemini Image Enabled Profiles (multi-profile support)
  ipcMain.handle("save-enabled-gemini-image-profiles", async (_, profileIds) => {
    try {
      await updateData("enabledGeminiImageProfiles", profileIds);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-enabled-gemini-image-profiles", async () => {
    try {
      const profileIds = await readKey("enabledGeminiImageProfiles");
      return { success: true, profileIds: profileIds || [] };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // Veo 3.1 Enabled Profiles (multi-profile support)
  ipcMain.handle("save-enabled-veo-profiles", async (_, profileIds) => {
    try {
      await updateData("enabledVeoProfiles", profileIds);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-enabled-veo-profiles", async () => {
    try {
      const profileIds = await readKey("enabledVeoProfiles");
      return { success: true, profileIds: profileIds || [] };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // Fetch OpenRouter models list
  ipcMain.handle("fetch-openrouter-models", async () => {
    try {
      const { fetchOpenRouterModels } = require("./openrouterQueue");
      const models = await fetchOpenRouterModels();
      return { success: true, models };
    } catch (err) {
      console.error("[OpenRouter] Error fetching models:", err.message);
      return { success: false, message: err.message };
    }
  });

  // Startup cleanup status check (used by precheck page)
  ipcMain.handle("get-startup-cleanup-status", async () => {
    try {
      return await getStartupCleanupStatus();
    } catch (error) {
      console.error("[IPC] Error getting startup cleanup status:", error.message);
      return { success: false, needsCleanup: false, error: error.message };
    }
  });

  // Run startup cleanup with progress events (used by precheck page)
  ipcMain.handle("run-startup-cleanup", async (event) => {
    try {
      const progressCallback = (data) => {
        // Send progress to renderer
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          event.sender.send("cleanup-progress", data);
        }
      };
      
      return await runStartupCleanup(progressCallback);
    } catch (error) {
      console.error("[IPC] Error running startup cleanup:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Get cleanup status (for settings page storage stats)
  ipcMain.handle("get-cleanup-status", async () => {
    try {
      const { CleanupManager } = require("./cleanup");
      const cleanupManager = new CleanupManager();
      const status = await cleanupManager.getCleanupStatus();
      return status;
    } catch (error) {
      console.error("[IPC] Error getting cleanup status:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Run manual cleanup (from settings page)
  ipcMain.handle("run-cleanup", async () => {
    try {
      const { CleanupManager } = require("./cleanup");
      const cleanupManager = new CleanupManager();
      const result = await cleanupManager.cleanupAll(false); // false = live mode, not dry run
      return result;
    } catch (error) {
      console.error("[IPC] Error running cleanup:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Clean browser cache folders from all profile directories (keeps session/login data)
  ipcMain.handle("clean-profile-caches", async () => {
    try {
      const { CleanupManager } = require("./cleanup");
      const cleanupManager = new CleanupManager();
      const result = await cleanupManager.cleanActiveProfileCaches();
      return result;
    } catch (error) {
      console.error("[IPC] Error cleaning profile caches:", error.message);
      return { success: false, error: error.message };
    }
  });

  // ============================================
  // ACTIVITY LOG HANDLERS
  // ============================================

  // Log a new activity
  ipcMain.handle(
    "log-activity",
    async (_, type, message, sourceType = null, sourceId = null) => {
      try {
        workflowDb.logActivity(type, message, sourceType, sourceId);
        return { success: true };
      } catch (error) {
        console.error("[IPC] Error logging activity:", error.message);
        return { success: false, error: error.message };
      }
    },
  );

  // Get recent activities
  ipcMain.handle("get-recent-activities", async (_, limit = 50) => {
    try {
      const activities = workflowDb.getRecentActivities(limit);
      return { success: true, activities };
    } catch (error) {
      console.error("[IPC] Error getting recent activities:", error.message);
      return { success: false, error: error.message, activities: [] };
    }
  });

  // Clear all activities (for testing/reset)
  ipcMain.handle("clear-activities", async () => {
    try {
      workflowDb.clearAllActivities();
      return { success: true };
    } catch (error) {
      console.error("[IPC] Error clearing activities:", error.message);
      return { success: false, error: error.message };
    }
  });

  // ============================================
  // FACEBOOK CONTENT ANALYTICS
  // ============================================

  // Helper function to convert image URL to base64 data URL
  async function imageUrlToBase64(url) {
    try {
      const fetch = require('node-fetch');
      const response = await fetch(url, { timeout: 15000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.buffer();
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const base64 = buffer.toString('base64');
      return `data:${contentType};base64,${base64}`;
    } catch (error) {
      console.error(`[FB Analytics] Failed to convert image to base64:`, error.message);
      return null;
    }
  }

  // Analyze Facebook content with AI - Deep Analytics Version
  ipcMain.handle("analyze-facebook-content", async (_, options) => {
    try {
      const { provider, model, posts, totalPosts, totalViews, avgViews, pageType, nicheConfig, images, language } = options;
      
      // FB Analytics timeout: 10 minutes for large datasets (hundreds of posts, 128k-200k tokens)
      const FB_ANALYTICS_TIMEOUT = 10 * 60 * 1000; // 10 minutes in ms
      
      // Language mapping for AI responses
      const languageNames = {
        'en': 'English',
        'fr': 'French',
        'ar': 'Arabic'
      };
      const responseLang = languageNames[language] || 'English';

      if (!provider || !model) {
        return { success: false, error: "AI provider and model are required" };
      }

      if (!posts || posts.length === 0) {
        return { success: false, error: "No posts to analyze" };
      }

      // Convert image URLs to base64 for AI vision APIs (they can't fetch Facebook CDN directly)
      let base64Images = [];
      let imageDescriptions = [];
      
      if (images && images.length > 0) {
        console.log(`[FB Analytics] Converting ${images.length} images to base64...`);
        for (const img of images) {
          const base64 = await imageUrlToBase64(img.image);
          if (base64) {
            base64Images.push({ ...img, image: base64 });
          }
        }
        console.log(`[FB Analytics] Successfully converted ${base64Images.length}/${images.length} images`);

        // Pre-analyze images one by one with ULTRA-DETAILED descriptions
        if (base64Images.length > 0 && provider === 'openai') {
          console.log(`[FB Analytics] Pre-analyzing images with ultra-detailed descriptions...`);
          const { openAi } = require("../automations/openai");
          
          // Get main window for progress updates
          const mainWindow = BrowserWindow.getAllWindows()[0];
          
          // Notify frontend that image analysis is starting
          mainWindow?.webContents.send('image-analysis-progress', {
            type: 'analysis-start',
            total: base64Images.length
          });
          
          for (let i = 0; i < base64Images.length; i++) {
            try {
              const imgPrompt = `You are an elite visual content analyst and social media strategist. Provide an ULTRA-DETAILED analysis of this image (300-500 words) covering EVERY visual element that contributes to its viral potential.

IMPORTANT: Write your entire analysis in English.

Write a comprehensive narrative analysis covering:

**PRODUCTION & TECHNICAL QUALITY:**
Describe the exact production quality level - is this shot with professional DSLR equipment, a high-end smartphone, or basic camera? Analyze the resolution, sharpness, and overall technical excellence. How much post-processing is visible? Is there color grading, filters, or HDR effects?

**LIGHTING MASTERY:**
Provide detailed analysis of the lighting setup. Is this natural daylight streaming through a window, golden hour magic, harsh midday sun, or carefully controlled studio lighting? Describe the direction (front, side, back, rim lighting), quality (soft diffused vs hard dramatic), and how shadows play across the image. What mood does the lighting create?

**CAMERA PERSPECTIVE & FRAMING:**
Explain the exact camera angle - overhead flat-lay, 45-degree hero shot, eye-level, low dramatic angle, or unique perspective. What is the shooting distance - extreme close-up showing texture, standard product shot, or environmental wide? Describe the depth of field - is the background creamy bokeh or everything sharp?

**COMPOSITION & VISUAL FLOW:**
Analyze how the image is composed. Does it follow rule of thirds, center composition, or break conventions intentionally? Where does the eye naturally travel? Are there leading lines, frames within frames, or geometric patterns? How is negative space used?

**COLOR PSYCHOLOGY:**
Detail the complete color palette - list the 3-5 dominant colors. Is the temperature warm (reds, oranges, yellows) or cool (blues, greens)? What's the saturation level - punchy and vibrant or muted and moody? Do colors create harmony or intentional contrast?

**SUBJECT PRESENTATION & STYLING:**
Describe exactly what's in the frame. How is the main subject positioned and styled? What props, surfaces, fabrics, or accessories enhance the scene? Is the background minimal/clean, elaborately styled, or contextually natural? Rate the clutter level.

**TEXT & GRAPHIC ELEMENTS:**
If there's any text overlay, describe the typography (bold, script, sans-serif), colors, size, placement, and how it integrates with the image. If no text, note that the image lets visuals speak.

**EMOTIONAL IMPACT:**
What emotions does this image trigger? Hunger, desire, aspiration, comfort, excitement, curiosity? What makes it relatable or aspirational? Are there lifestyle cues?

**SCROLL-STOPPING POWER:**
Explain EXACTLY what makes someone stop scrolling for this image. What's the immediate visual hook? Is there an unexpected element, striking contrast, or irresistible subject?

Write your analysis as flowing paragraphs, not bullet points. Be specific and descriptive.`;
              
              // Try up to 2 times if the first attempt fails or is refused
              let imgResult = null;
              let attempts = 0;
              const maxAttempts = 2;
              
              while (attempts < maxAttempts) {
                attempts++;
                // Use 5 minute timeout for individual image analysis (image vision can be slow)
                imgResult = await openAi(null, 'gpt-5-nano', imgPrompt, 0.5, [base64Images[i].image], 5 * 60 * 1000);
                
                // Check if it's a content policy refusal
                const isRefusal = imgResult.value && (
                  imgResult.value.includes("I can't") || 
                  imgResult.value.includes("I cannot") ||
                  imgResult.value.includes("I'm not able to") ||
                  imgResult.value.includes("I'm unable to") ||
                  imgResult.value.includes("cannot analyze") ||
                  imgResult.value.includes("can't analyze")
                );
                
                if (imgResult.success && imgResult.value && !isRefusal) {
                  break; // Success, exit retry loop
                }
                
                // Log why we're retrying
                if (attempts < maxAttempts) {
                  const reason = !imgResult.success ? (imgResult.value || 'API error') : 
                                 !imgResult.value ? 'Empty response' : 'Content policy refusal';
                  console.log(`[FB Analytics] Image ${i + 1} attempt ${attempts} failed (${reason}), retrying...`);
                  await new Promise(r => setTimeout(r, 1000)); // Wait 1 second before retry
                }
              }
              
              // Check final result
              const finalRefusal = imgResult?.value && (
                imgResult.value.includes("I can't") || 
                imgResult.value.includes("I cannot") ||
                imgResult.value.includes("I'm not able to") ||
                imgResult.value.includes("I'm unable to")
              );
              
              if (imgResult?.success && imgResult?.value && !finalRefusal) {
                imageDescriptions.push({
                  rank: base64Images[i].rank,
                  views: base64Images[i].views || 0,
                  description: imgResult.value
                });
                console.log(`[FB Analytics] Image ${i + 1} analyzed with ultra-detailed description (${imgResult.value.length} chars)`);
                
                // Send progress update to frontend
                mainWindow?.webContents.send('image-analysis-progress', {
                  type: 'image-analyzed',
                  current: i + 1,
                  total: base64Images.length,
                  chars: imgResult.value.length
                });
              } else {
                const failReason = !imgResult?.success ? (imgResult?.value || 'API error') : 
                                   !imgResult?.value ? 'Empty response' : 'Content policy refusal';
                console.log(`[FB Analytics] Image ${i + 1} analysis failed after ${attempts} attempts: ${failReason}`);
                mainWindow?.webContents.send('image-analysis-progress', {
                  type: 'image-failed',
                  current: i + 1,
                  total: base64Images.length,
                  reason: failReason
                });
              }
            } catch (imgError) {
              console.warn(`[FB Analytics] Failed to analyze image ${i + 1}:`, imgError.message);
              mainWindow?.webContents.send('image-analysis-progress', {
                type: 'image-failed',
                current: i + 1,
                total: base64Images.length,
                reason: imgError.message
              });
            }
          }
          console.log(`[FB Analytics] Got ${imageDescriptions.length} ultra-detailed image descriptions`);
          
          // AUTOMATIC AI COMPARISON - Compare all images at once
          let imageComparison = null;
          if (imageDescriptions.length >= 2) {
            console.log(`[FB Analytics] Performing automatic AI comparison of ${imageDescriptions.length} images...`);
            
            // Notify frontend that comparison is starting
            mainWindow?.webContents.send('image-analysis-progress', {
              type: 'comparison-start',
              imageCount: imageDescriptions.length
            });
            
            try {
              const descriptionsForComparison = imageDescriptions.map((d, idx) => 
                `=== IMAGE #${d.rank} (${d.views || 'N/A'} views) ===\n${d.description}`
              ).join('\n\n---\n\n');
              
              const comparisonPrompt = `You are an expert visual content strategist analyzing ${imageDescriptions.length} Facebook post images. Each image has been analyzed in detail. Your job is to compare ALL these analyses and extract the WINNING VISUAL FORMULA.

IMPORTANT: Write your entire analysis in English.

Here are the detailed descriptions of each image:

${descriptionsForComparison}

---

Based on these detailed analyses, provide a COMPREHENSIVE COMPARISON:

**THE WINNING FORMULA:**
Synthesize what the TOP performing images have in common. What's the secret sauce? Create a clear, actionable formula.

**PRODUCTION PATTERNS:**
Compare production quality across all images. What level works best - professional polish or authentic homemade feel? What's the sweet spot?

**LIGHTING SECRETS:**
Which lighting setups appear most in the winners? Natural vs artificial? What lighting mood drives engagement?

**CAMERA & COMPOSITION MASTERY:**
What angles dominate? Overhead, 45-degree, eye-level? What composition techniques are consistent winners? How is the subject framed?

**COLOR STRATEGY:**
What color palettes appear most? Warm or cool? Vibrant or muted? What colors trigger the most engagement?

**STYLING BLUEPRINT:**
Background preferences, prop usage, minimalism vs styled abundance. What visual environment works?

**SCROLL-STOPPING ELEMENTS:**
What makes these images stop the scroll? List the specific elements that grab attention.

**KEY DIFFERENCES:**
Note important differences between the images. Which variations perform better or worse?

**ACTIONABLE RECOMMENDATIONS:**
Provide 5-7 specific, actionable tips for creating images that match this winning formula.

Write in a direct, actionable style. This analysis will be used to create future viral content.`;
              
              // Use 5 minute timeout for image comparison (comparing multiple images can be slow)
              const comparisonResult = await openAi(null, 'gpt-5-nano', comparisonPrompt, 0.6, null, 5 * 60 * 1000);
              
              if (comparisonResult.success && comparisonResult.value) {
                imageComparison = comparisonResult.value;
                console.log(`[FB Analytics] AI comparison complete (${imageComparison.length} chars)`);
                
                mainWindow?.webContents.send('image-analysis-progress', {
                  type: 'comparison-done',
                  chars: imageComparison.length
                });
              }
            } catch (compErr) {
              console.warn(`[FB Analytics] AI comparison failed:`, compErr.message);
              mainWindow?.webContents.send('image-analysis-progress', {
                type: 'comparison-failed',
                reason: compErr.message
              });
            }
          }
          
          // Store comparison in a way we can return it
          if (imageComparison) {
            imageDescriptions._comparison = imageComparison;
          }
        }
      }

      console.log(`[FB Analytics] Starting deep analysis with ${provider}/${model} for ${posts.length} posts (type: ${pageType})`);

      // CHUNKED ANALYSIS: Split large datasets into manageable chunks
      const CHUNK_SIZE = 40; // Posts per chunk
      const useChunkedAnalysis = posts.length > 50;
      const mainWindow = BrowserWindow.getAllWindows()[0];

      // Helper function to call AI provider with extended timeout for large analyses
      const callAIProvider = async (content, sysPrompt = null) => {
        if (provider === 'openai') {
          const { openAi } = require("../automations/openai");
          const keys = readKey("openaiKeys");
          if (!keys || typeof keys !== 'object' || Object.keys(keys).length === 0) {
            throw new Error("No OpenAI API keys configured");
          }
          const activeKey = Object.entries(keys).find(([key, data]) => 
            key && data && data.status === 'active'
          );
          if (!activeKey) {
            throw new Error("No valid OpenAI API key found");
          }
          return await openAi(activeKey[0], model, content, 0.7, null, FB_ANALYTICS_TIMEOUT);
        } else if (provider === 'anthropic') {
          const { anthropic } = require("../automations/anthropic");
          return await anthropic(model, content, 0.7, null, sysPrompt || "You are an expert social media marketing analyst. Always respond with valid JSON only.", 8192, FB_ANALYTICS_TIMEOUT);
        } else if (provider === 'googleai') {
          const { googleAI } = require("../automations/googleai");
          return await googleAI(model, content, 0.7, null, sysPrompt || "You are an expert social media marketing analyst. Always respond with valid JSON only.", 8192, FB_ANALYTICS_TIMEOUT);
        } else if (provider === 'openrouter') {
          const { openRouter } = require("../automations/openrouter");
          return await openRouter(model, content, 0.7, null, sysPrompt || "You are an expert social media marketing analyst. Always respond with valid JSON only.", 8192, FB_ANALYTICS_TIMEOUT);
        } else {
          throw new Error(`Unknown AI provider: ${provider}`);
        }
      };

      // Helper function to merge chunk insights
      const mergeChunkInsights = (chunks) => {
        const merged = {
          winningKeywords: [],
          hookPatterns: [],
          nicheInsights: {},
          contentStructure: {},
          visualPatterns: null,
          psychologicalTriggers: [],
          topPostAnalysis: [],
          doMore: [],
          avoid: [],
          contentIdeas: []
        };

        // Collect all keywords with scores
        const keywordMap = new Map();
        chunks.forEach(chunk => {
          (chunk.winningKeywords || []).forEach(kw => {
            const key = typeof kw === 'string' ? kw : kw.keyword;
            const score = typeof kw === 'string' ? 50 : (kw.score || 50);
            if (keywordMap.has(key)) {
              keywordMap.set(key, Math.max(keywordMap.get(key), score));
            } else {
              keywordMap.set(key, score);
            }
          });
        });
        merged.winningKeywords = Array.from(keywordMap.entries())
          .map(([keyword, score]) => ({ keyword, score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 25);

        // Merge hook patterns (dedupe by example)
        const hookSet = new Set();
        chunks.forEach(chunk => {
          (chunk.hookPatterns || []).forEach(hook => {
            const key = hook.example?.substring(0, 50);
            if (key && !hookSet.has(key)) {
              hookSet.add(key);
              merged.hookPatterns.push(hook);
            }
          });
        });
        merged.hookPatterns = merged.hookPatterns.slice(0, 10);

        // Merge niche insights (combine arrays, sum counts)
        chunks.forEach(chunk => {
          const ni = chunk.nicheInsights || {};
          Object.keys(ni).forEach(key => {
            if (Array.isArray(ni[key])) {
              merged.nicheInsights[key] = merged.nicheInsights[key] || [];
              ni[key].forEach(item => {
                const existing = merged.nicheInsights[key].find(e => e.name === item.name);
                if (existing) {
                  existing.count = (existing.count || 0) + (item.count || 1);
                } else {
                  merged.nicheInsights[key].push({ ...item });
                }
              });
            }
          });
        });
        // Sort niche insights by count
        Object.keys(merged.nicheInsights).forEach(key => {
          if (Array.isArray(merged.nicheInsights[key])) {
            merged.nicheInsights[key].sort((a, b) => (b.count || 0) - (a.count || 0));
            merged.nicheInsights[key] = merged.nicheInsights[key].slice(0, 10);
          }
        });

        // Use content structure from first chunk (most comprehensive)
        merged.contentStructure = chunks[0]?.contentStructure || {};

        // Merge psychological triggers (unique by type)
        const triggerSet = new Set();
        chunks.forEach(chunk => {
          (chunk.psychologicalTriggers || []).forEach(trigger => {
            if (trigger.type && !triggerSet.has(trigger.type)) {
              triggerSet.add(trigger.type);
              merged.psychologicalTriggers.push(trigger);
            }
          });
        });

        // Merge top post analysis (keep all, sorted by rank)
        chunks.forEach(chunk => {
          (chunk.topPostAnalysis || []).forEach(post => {
            merged.topPostAnalysis.push(post);
          });
        });
        merged.topPostAnalysis.sort((a, b) => (a.rank || 99) - (b.rank || 99));
        merged.topPostAnalysis = merged.topPostAnalysis.slice(0, 10);

        // Merge doMore and avoid (unique by title)
        const doMoreSet = new Set();
        chunks.forEach(chunk => {
          (chunk.doMore || []).forEach(item => {
            if (item.title && !doMoreSet.has(item.title)) {
              doMoreSet.add(item.title);
              merged.doMore.push(item);
            }
          });
        });
        merged.doMore = merged.doMore.slice(0, 8);

        const avoidSet = new Set();
        chunks.forEach(chunk => {
          (chunk.avoid || []).forEach(item => {
            if (item.title && !avoidSet.has(item.title)) {
              avoidSet.add(item.title);
              merged.avoid.push(item);
            }
          });
        });
        merged.avoid = merged.avoid.slice(0, 8);

        // Merge content ideas (unique by title)
        const ideaSet = new Set();
        chunks.forEach(chunk => {
          (chunk.contentIdeas || []).forEach(idea => {
            if (idea.title && !ideaSet.has(idea.title)) {
              ideaSet.add(idea.title);
              merged.contentIdeas.push(idea);
            }
          });
        });
        merged.contentIdeas = merged.contentIdeas.slice(0, 8);

        // Visual patterns from first chunk that has them
        for (const chunk of chunks) {
          if (chunk.visualPatterns) {
            merged.visualPatterns = chunk.visualPatterns;
            break;
          }
        }

        return merged;
      };

      // Build niche-specific prompt section
      const nicheFields = nicheConfig?.nicheFields || 'topics, formats, themes, styles';
      const nichePrompt = pageType !== 'general' 
        ? `\n\nNICHE-SPECIFIC ANALYSIS (${pageType.toUpperCase()} PAGE):
Identify the top performing ${nicheFields} from the content. For example:
- For recipe pages: extract top ingredients, cuisines, cooking methods
- For fitness pages: extract exercises, muscle groups, equipment types
- For fashion pages: extract clothing types, brands, styles, occasions`
        : '';

      // Build image analysis prompt if images were analyzed (only for first chunk)
      const buildImagePrompt = () => {
        if (!imageDescriptions || imageDescriptions.length === 0) return '';
        const descriptionsText = imageDescriptions.map(d => 
          `Post #${d.rank} (${d.views || 'N/A'} views):\n${d.description}`
        ).join('\n\n');
        
        return `\n\nDETAILED VISUAL ANALYSIS OF TOP ${imageDescriptions.length} PERFORMING POSTS:
Each image was analyzed across 9 dimensions (quality, lighting, camera, composition, colors, subject, text, emotion, scroll-stopper).

${descriptionsText}

COMPARE these images and identify PATTERNS that correlate with high performance:

1. PRODUCTION PATTERNS:
- What production quality level dominates? (professional vs homemade)
- Is there an optimal "polished but authentic" sweet spot?

2. LIGHTING PATTERNS:
- Which lighting setups appear most in top performers?
- Natural vs artificial - what wins?
- Any lighting moods that correlate with high engagement?

3. CAMERA & COMPOSITION PATTERNS:
- Winning camera angles (overhead, eye-level, etc.)
- Optimal framing and crop styles
- Depth of field preferences

4. COLOR PATTERNS:
- Dominant color palettes in top posts
- Warm vs cool temperature trends
- Saturation levels that work best

5. STYLING PATTERNS:
- Background preferences (styled, plain, contextual)
- Props and accessories that boost engagement
- Minimalism vs detailed scenes

6. TEXT OVERLAY PATTERNS:
- Do top posts use text overlays?
- Font and color preferences
- Optimal text amount and placement

7. SCROLL-STOPPING ELEMENTS:
- Common "pattern interrupts" in top posts
- What makes users stop scrolling
- Unique visual hooks identified`;
      };

      // Build analysis prompt for a given set of posts
      const buildAnalysisPrompt = (postsChunk, includeImages = false, chunkInfo = null) => {
        const postsData = postsChunk.map(p => 
          `#${p.rank}: ${p.views} views - "${p.description.substring(0, 400)}"`
        ).join('\n');
        
        const imagePrompt = includeImages ? buildImagePrompt() : '';
        const chunkNote = chunkInfo ? `\n\nNOTE: This is chunk ${chunkInfo.current}/${chunkInfo.total} of a larger dataset. Focus on extracting patterns from these ${postsChunk.length} posts.` : '';

        return `You are an expert social media marketing analyst helping a business owner analyze their own Facebook page content performance. This is a legitimate business analytics task to understand what content resonates with their audience.

LANGUAGE INSTRUCTIONS:
- Write all EXPLANATIONS, DESCRIPTIONS, RECOMMENDATIONS, and ANALYTICAL TEXT in English.
- KEEP KEYWORDS IN THEIR ORIGINAL LANGUAGE from the posts (do NOT translate keywords).
- KEEP HOOK EXAMPLES IN THEIR ORIGINAL LANGUAGE from the posts (do NOT translate post excerpts).
- The JSON keys must remain in English.
- Only translate your own analysis, insights, and recommendations - never translate content from the posts themselves.

Your job is to perform a professional marketing analysis of this Facebook page data to extract actionable insights that will help the page owner improve their content strategy and engagement.

DATA SUMMARY:
- Total posts analyzed: ${totalPosts}
- Total views: ${totalViews}
- Average views per post: ${avgViews}
- Page type/niche: ${pageType}
${chunkNote}

TOP ${postsChunk.length} POSTS (sorted by views):
${postsData}
${nichePrompt}${imagePrompt}

ANALYSIS REQUIREMENTS:
1. Extract WINNING KEYWORDS - find 15-25 specific words/phrases that appear frequently in top-performing posts. Include single keywords, 2-word phrases, and 3+ word phrases that drive engagement
2. Identify HOOK PATTERNS - how successful posts open to grab attention
3. Analyze CONTENT STRUCTURE - length, emoji usage, hashtags, call-to-actions
4. Identify PSYCHOLOGICAL TRIGGERS used (curiosity, urgency, social-proof, emotion, value, fomo)
5. Explain WHY the top 5 posts worked specifically
6. Provide specific DO MORE and AVOID recommendations
7. Generate 5 CONTENT IDEAS based on patterns found
8. If image data provided, perform DEEP VISUAL ANALYSIS comparing production, lighting, angles, colors, and composition

Respond ONLY with valid JSON in this exact format:
{
  "winningKeywords": [
    {"keyword": "word or phrase", "score": 85},
    {"keyword": "another phrase", "score": 72}
  ],
  "hookPatterns": [
    {"example": "Opening line example from top post", "explanation": "Why this hook works"},
    {"example": "Another hook example", "explanation": "Why it grabs attention"}
  ],
  "nicheInsights": {
    "topIngredients": [{"name": "Ingredient", "count": 5}],
    "topCuisines": [{"name": "Cuisine", "count": 3}],
    "note": "Adapt field names based on page type - use topProducts for fashion, topExercises for fitness, topTopics for business, etc."
  },
  "contentStructure": {
    "optimalLength": "Description of ideal post length with character/word count",
    "emojiUsage": "How emojis are used in top posts",
    "hashtagStrategy": "How hashtags are used or avoided",
    "ctaStyle": "Common call-to-action patterns",
    "format": "Common formatting patterns (lists, questions, stories)"
  },
  "visualPatterns": ${includeImages && imageDescriptions?.length > 0 ? `{
    "summary": "One paragraph summary of the winning visual formula",
    "productionQuality": {
      "winner": "Professional/Semi-pro/Amateur/Homemade - which wins",
      "insight": "Detailed insight about production quality patterns"
    },
    "lighting": {
      "winner": "Natural daylight/Golden hour/Studio/Ring light/etc.",
      "insight": "What lighting works and why"
    },
    "cameraWork": {
      "winningAngles": ["Overhead", "Eye-level", "etc - list winning angles"],
      "winningDistance": "Close-up/Medium/Wide - what works",
      "depthOfField": "Shallow blur or deep focus preference",
      "insight": "Camera technique patterns that drive engagement"
    },
    "composition": {
      "patterns": ["Rule of thirds", "Centered subject", "etc"],
      "insight": "How composition affects performance"
    },
    "colorPalette": {
      "dominantColors": ["Color 1", "Color 2", "Color 3"],
      "temperature": "Warm/Cool/Neutral preference",
      "saturation": "Vibrant/Muted/Natural preference",
      "insight": "Color strategy that works"
    },
    "styling": {
      "backgroundStyle": "Plain/Styled/Contextual/Blurred",
      "propsUsage": "How props and accessories are used",
      "clutterLevel": "Minimalist/Moderate/Busy - what wins",
      "insight": "Styling patterns in top performers"
    },
    "textOverlays": {
      "usage": "None/Minimal/Moderate/Heavy",
      "fontStyle": "Bold/Script/Modern/etc if used",
      "placement": "Where text is placed",
      "insight": "Text overlay strategy"
    },
    "scrollStoppers": [
      {"element": "Specific element that stops scrolling", "frequency": "How often seen in top posts"},
      {"element": "Another attention grabber", "frequency": "Occurrence pattern"}
    ],
    "recommendations": [
      {"title": "Visual recommendation 1", "description": "Specific actionable advice"},
      {"title": "Visual recommendation 2", "description": "Based on pattern analysis"},
      {"title": "Visual recommendation 3", "description": "What to replicate"}
    ]
  }` : 'null'},
  "psychologicalTriggers": [
    {"type": "curiosity", "name": "Curiosity Gap", "description": "How curiosity is used with example"},
    {"type": "social-proof", "name": "Social Proof", "description": "How social proof is leveraged"}
  ],
  "topPostAnalysis": [
    {"rank": 1, "reason": "Specific explanation of why this exact post performed well"},
    {"rank": 2, "reason": "Why post #2 worked"},
    {"rank": 3, "reason": "Why post #3 worked"},
    {"rank": 4, "reason": "Why post #4 worked"},
    {"rank": 5, "reason": "Why post #5 worked"}
  ],
  "doMore": [
    {"title": "Specific action to do more", "description": "Detailed explanation with examples from data"},
    {"title": "Another thing to increase", "description": "Why and how based on the data"}
  ],
  "avoid": [
    {"title": "Specific thing to stop doing", "description": "Why it hurts performance based on data"},
    {"title": "Another thing to avoid", "description": "Evidence from the analysis"}
  ],
  "contentIdeas": [
    {"title": "Content idea title", "description": "Full description of the post idea", "tags": ["tag1", "tag2"]},
    {"title": "Another idea", "description": "Description based on winning patterns", "tags": ["high-potential"]},
    {"title": "Third idea", "description": "Combines multiple successful elements", "tags": ["trending"]},
    {"title": "Fourth idea", "description": "Based on top niche insights", "tags": ["niche-specific"]},
    {"title": "Fifth idea", "description": "Targets identified psychological triggers", "tags": ["engagement"]}
  ]
}

IMPORTANT: 
- Base ALL insights on the actual data provided, not generic advice
- Include specific examples from the posts when possible
- For nicheInsights, use field names appropriate to the page type (e.g., topIngredients for recipes, topProducts for fashion)
- For visualPatterns: If image data was provided, fill ALL visual pattern fields with comparative analysis. If no images, set visualPatterns to null
- Compare images against each other to find what the TOP performers have in common
- Respond ONLY with the JSON object, no markdown code blocks, no explanations.`;
      };

      // Parse AI response to JSON
      const parseAIResponse = (responseText) => {
        try {
          let jsonStr = responseText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
          return JSON.parse(jsonStr);
        } catch (parseError) {
          console.warn("[FB Analytics] Failed to parse AI response:", parseError.message);
          return null;
        }
      };

      let insights;

      // CHUNKED ANALYSIS for large datasets
      if (useChunkedAnalysis) {
        console.log(`[FB Analytics] Using chunked analysis for ${posts.length} posts (chunk size: ${CHUNK_SIZE})`);
        
        // Split posts into chunks
        const chunks = [];
        for (let i = 0; i < posts.length; i += CHUNK_SIZE) {
          chunks.push(posts.slice(i, i + CHUNK_SIZE));
        }
        
        console.log(`[FB Analytics] Split into ${chunks.length} chunks`);
        mainWindow?.webContents.send('image-analysis-progress', {
          type: 'chunked-analysis-start',
          totalChunks: chunks.length,
          totalPosts: posts.length
        });
        
        const chunkResults = [];
        
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const isFirstChunk = i === 0;
          
          console.log(`[FB Analytics] Analyzing chunk ${i + 1}/${chunks.length} (${chunk.length} posts)...`);
          mainWindow?.webContents.send('image-analysis-progress', {
            type: 'chunk-start',
            current: i + 1,
            total: chunks.length,
            postsInChunk: chunk.length
          });
          
          // Only include image analysis in first chunk
          const chunkPrompt = buildAnalysisPrompt(chunk, isFirstChunk, { current: i + 1, total: chunks.length });
          
          try {
            const chunkResult = await callAIProvider(chunkPrompt, "You are an expert social media marketing analyst helping business owners analyze their own content performance. This is a legitimate business analytics task. Always respond with valid JSON only.");
            
            if (chunkResult.success && chunkResult.value) {
              const parsed = parseAIResponse(chunkResult.value);
              if (parsed) {
                chunkResults.push(parsed);
                console.log(`[FB Analytics] Chunk ${i + 1} analyzed successfully`);
                mainWindow?.webContents.send('image-analysis-progress', {
                  type: 'chunk-done',
                  current: i + 1,
                  total: chunks.length
                });
              } else {
                console.warn(`[FB Analytics] Chunk ${i + 1} response could not be parsed`);
                mainWindow?.webContents.send('image-analysis-progress', {
                  type: 'chunk-failed',
                  current: i + 1,
                  total: chunks.length,
                  reason: 'Failed to parse response'
                });
              }
            } else {
              console.warn(`[FB Analytics] Chunk ${i + 1} failed:`, chunkResult.value || chunkResult.error);
              mainWindow?.webContents.send('image-analysis-progress', {
                type: 'chunk-failed',
                current: i + 1,
                total: chunks.length,
                reason: chunkResult.value || chunkResult.error
              });
            }
          } catch (chunkError) {
            console.error(`[FB Analytics] Chunk ${i + 1} error:`, chunkError.message);
            mainWindow?.webContents.send('image-analysis-progress', {
              type: 'chunk-failed',
              current: i + 1,
              total: chunks.length,
              reason: chunkError.message
            });
          }
        }
        
        if (chunkResults.length === 0) {
          return { success: false, error: "All analysis chunks failed. Try with fewer posts." };
        }
        
        console.log(`[FB Analytics] Merging ${chunkResults.length} chunk results...`);
        mainWindow?.webContents.send('image-analysis-progress', {
          type: 'merging-chunks',
          successfulChunks: chunkResults.length,
          totalChunks: chunks.length
        });
        
        insights = mergeChunkInsights(chunkResults);
        console.log(`[FB Analytics] Chunked analysis complete - merged ${chunkResults.length} chunks`);
        
      } else {
        // STANDARD ANALYSIS for smaller datasets
        const analysisPrompt = buildAnalysisPrompt(posts, true, null);
        let messageContent = analysisPrompt;

        // Note: We already pre-analyzed images individually, so we include their descriptions in the text prompt
        // This avoids content policy issues that occur when sending multiple images at once

        // Call the appropriate AI provider (text-only now, images were pre-analyzed)
        let result;
        try {
          result = await callAIProvider(messageContent, "You are an expert social media marketing analyst helping business owners analyze their own content performance. This is a legitimate business analytics task. Always respond with valid JSON only.");
        } catch (aiError) {
          return { success: false, error: aiError.message || "AI analysis failed" };
        }

        if (!result.success) {
          console.error(`[FB Analytics] AI call failed:`, result.value || result.error);
          return { success: false, error: result.value || result.error || "AI analysis failed" };
        }

        // Check for AI refusal responses
        const refusalPatterns = [
          "I'm sorry, I can't assist",
          "I cannot assist",
          "I'm unable to",
          "I can't help with",
          "against my guidelines",
          "violates content policy"
        ];
        
        const responseText = result.value || "";
        const isRefusal = refusalPatterns.some(pattern => 
          responseText.toLowerCase().includes(pattern.toLowerCase())
        );

        if (isRefusal) {
          console.warn("[FB Analytics] AI refused to analyze content, likely due to image/content policy");
          
          // If we had images, the refusal might be due to them - inform the user
          if (base64Images && base64Images.length > 0) {
            return { 
              success: false, 
              error: "AI refused to analyze the images. This may be due to content policy restrictions. Try again without image analysis enabled.",
              refusalType: "content_policy"
            };
          } else {
            return { 
              success: false, 
              error: "AI refused to analyze this content. The text may contain restricted content.",
              refusalType: "content_policy"
            };
          }
        }

        // Parse the AI response as JSON
        const parsed = parseAIResponse(responseText);
        if (parsed) {
          insights = parsed;
        } else {
          console.error("[FB Analytics] Failed to parse AI response");
          console.error("[FB Analytics] Raw response:", result.value);
          
          // Return a basic structure if parsing fails
          insights = {
            winningKeywords: [],
            hookPatterns: [],
            nicheInsights: {},
            contentStructure: {},
            visualPatterns: null,
            psychologicalTriggers: [],
            topPostAnalysis: [],
            doMore: [{ title: "Analysis completed", description: result.value || "Response format was unexpected." }],
            avoid: [],
            contentIdeas: []
          };
        }

        console.log("[FB Analytics] Deep analysis complete");
      }
      
      // Extract comparison if it was stored
      const imageComparison = imageDescriptions._comparison || null;
      
      return { 
        success: true, 
        insights,
        imageDescriptions: Array.isArray(imageDescriptions) ? imageDescriptions.map(d => ({
          rank: d.rank,
          views: d.views,
          description: d.description
        })) : [],
        imageComparison // Return the automatic AI comparison
      };

    } catch (error) {
      console.error("[FB Analytics] Analysis error:", error);
      return { success: false, error: error.message || "Analysis failed" };
    }
  });

  // ========== FB ANALYTICS SCAN PERSISTENCE ==========

  // Save a FB Analytics scan
  ipcMain.handle("save-fb-analytics-scan", async (_, scanData) => {
    try {
      const { name, posts, images, imageDescriptions, imageComparison, aiInsights, pageType, provider, model, totalPosts, totalViews, avgViews } = scanData;
      
      if (!name || !posts) {
        return { success: false, error: "Scan name and posts are required" };
      }

      const scanId = `scan_${generateRandomString(12)}`;
      const imagesDir = path.join(app.getPath('userData'), 'Images');

      // Ensure Images directory exists
      if (!fss.existsSync(imagesDir)) {
        fss.mkdirSync(imagesDir, { recursive: true });
      }

      // Ensure images are downloaded locally (CDN URLs expire)
      const persistedImages = [];
      if (images && images.length > 0) {
        for (const img of images) {
          try {
            let filename = null;
            
            // Check if image already has a local file
            if (img.localPath && fss.existsSync(img.localPath)) {
              // Copy file from Downloads to Images directory
              filename = `fb_scan_${generateRandomString(12)}.jpg`;
              const destPath = path.join(imagesDir, filename);
              fss.copyFileSync(img.localPath, destPath);
              console.log(`[FB Analytics] Copied image to: ${filename}`);
            }
            // If no local file, try to download from CDN
            else if (img.image && img.image.startsWith('http')) {
              const base64 = await imageUrlToBase64(img.image);
              if (base64) {
                // Save base64 to file
                filename = `fb_scan_${generateRandomString(12)}.jpg`;
                const filePath = path.join(imagesDir, filename);
                const buffer = Buffer.from(base64, 'base64');
                fs.writeFileSync(filePath, buffer);
                console.log(`[FB Analytics] Downloaded and saved image: ${filename}`);
              }
            }

            if (filename) {
              persistedImages.push({
                filename,
                rank: img.rank,
                views: img.views || 0,
                description: img.description || ''
              });
            }
          } catch (imgErr) {
            console.warn(`[FB Analytics] Failed to persist image:`, imgErr.message);
          }
        }
      }

      const scan = {
        id: scanId,
        name,
        createdAt: new Date().toISOString(),
        provider,
        model,
        pageType: pageType || 'general',
        totalPosts: totalPosts || posts.length,
        totalViews: totalViews || 0,
        avgViews: avgViews || 0,
        hasImageAnalysis: persistedImages.length > 0,
        posts: posts.slice(0, 100), // Store top 100 posts to limit size
        images: persistedImages,
        imageDescriptions: imageDescriptions || [],
        imageComparison: imageComparison || null,
        aiInsights: aiInsights || null
      };

      // Get existing scans and add new one
      const scans = await readKey('fbAnalyticsScans') || {};
      scans[scanId] = scan;
      await updateData('fbAnalyticsScans', scans);

      console.log(`[FB Analytics] Saved scan "${name}" with ${persistedImages.length} images`);
      return { success: true, scanId, imageCount: persistedImages.length };

    } catch (error) {
      console.error("[FB Analytics] Save scan error:", error);
      return { success: false, error: error.message || "Failed to save scan" };
    }
  });

  // Get all saved FB Analytics scans (summary only)
  ipcMain.handle("get-fb-analytics-scans", async () => {
    try {
      const scans = await readKey('fbAnalyticsScans') || {};
      
      // Return summary info only (not full data)
      const summaries = Object.values(scans).map(scan => ({
        id: scan.id,
        name: scan.name,
        createdAt: scan.createdAt,
        pageType: scan.pageType,
        totalPosts: scan.totalPosts,
        totalViews: scan.totalViews,
        avgViews: scan.avgViews,
        hasImageAnalysis: scan.hasImageAnalysis,
        imageCount: scan.images?.length || 0
      }));

      // Sort by creation date (newest first)
      summaries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return { success: true, scans: summaries };
    } catch (error) {
      console.error("[FB Analytics] Get scans error:", error);
      return { success: false, error: error.message };
    }
  });

  // Load a specific FB Analytics scan (full data)
  ipcMain.handle("load-fb-analytics-scan", async (_, scanId) => {
    try {
      const scans = await readKey('fbAnalyticsScans') || {};
      const scan = scans[scanId];

      if (!scan) {
        return { success: false, error: "Scan not found" };
      }

      // Resolve image paths - check both Images and Downloads directories
      const imagesDir = path.join(app.getPath('userData'), 'Images');
      const downloadsDir = path.join(app.getPath('userData'), 'Downloads');
      
      const imagesWithPaths = (scan.images || []).map(img => {
        // First try Images directory
        let localPath = path.join(imagesDir, img.filename);
        let exists = fss.existsSync(localPath);
        
        // If not found, try Downloads directory (for older scans)
        if (!exists) {
          localPath = path.join(downloadsDir, img.filename);
          exists = fss.existsSync(localPath);
        }
        
        return {
          ...img,
          localPath,
          exists
        };
      });

      return { 
        success: true, 
        scan: {
          ...scan,
          images: imagesWithPaths
        }
      };
    } catch (error) {
      console.error("[FB Analytics] Load scan error:", error);
      return { success: false, error: error.message };
    }
  });

  // Delete a FB Analytics scan
  ipcMain.handle("delete-fb-analytics-scan", async (_, scanId) => {
    try {
      const scans = await readKey('fbAnalyticsScans') || {};
      
      if (!scans[scanId]) {
        return { success: false, error: "Scan not found" };
      }

      const scan = scans[scanId];
      const scanName = scan.name;
      
      // Delete associated images from Images folder
      const imagesDir = path.join(app.getPath('userData'), 'Images');
      if (scan.images && Array.isArray(scan.images)) {
        for (const img of scan.images) {
          if (img.filename) {
            const imagePath = path.join(imagesDir, img.filename);
            try {
              if (fss.existsSync(imagePath)) {
                fss.unlinkSync(imagePath);
                console.log(`[FB Analytics] Deleted image: ${img.filename}`);
              }
            } catch (imgErr) {
              console.warn(`[FB Analytics] Failed to delete image ${img.filename}:`, imgErr.message);
            }
          }
        }
      }
      
      delete scans[scanId];
      await updateData('fbAnalyticsScans', scans);

      console.log(`[FB Analytics] Deleted scan "${scanName}" and associated images`);
      return { success: true };
    } catch (error) {
      console.error("[FB Analytics] Delete scan error:", error);
      return { success: false, error: error.message };
    }
  });

  // ========== FB Analytics AI Chat ==========

  // Streaming chat with AI for FB Analytics
  ipcMain.handle("fb-analytics-chat-stream", async (event, { messages, provider, model, images, context, language }) => {
    try {
      const fetch = require("node-fetch");
      const mainWindow = BrowserWindow.getAllWindows()[0];
      
      // Language mapping for AI responses
      const languageNames = {
        'en': 'English',
        'fr': 'French',
        'ar': 'Arabic'
      };
      const responseLang = languageNames[language] || 'English';
      
      // Build system prompt with page context
      const systemPrompt = `You are an expert social media analyst assistant embedded within ViralCloner, a powerful desktop application for viral content creation and distribution.

LANGUAGE INSTRUCTIONS:
- Respond in ${responseLang} for all your explanations, analysis, and recommendations.
- When quoting or referencing keywords, phrases, or text from the posts, KEEP THEM IN THEIR ORIGINAL LANGUAGE (do not translate post content).
- Only translate your own analysis and insights, never the content from the analyzed posts.

ABOUT VIRALCLONER:
ViralCloner is a comprehensive automation platform that helps content creators and marketers:
- Analyze competitor pages to identify viral content patterns
- Clone and adapt successful content strategies
- Automate posting to multiple platforms (Pinterest, WordPress, Google Sites, etc.)
- Generate AI-powered images using Midjourney, ChatGPT, and other AI tools
- Create automated workflows for content pipelines
- Manage multiple accounts with different browser profiles
- Track performance and optimize content based on analytics

The user is currently in the Facebook Analytics module, which:
- Imports CSV exports from Facebook Creator Studio
- Analyzes post performance metrics (views, reactions, comments, shares)
- Uses AI to identify winning patterns, hooks, and keywords
- Provides visual analysis of top-performing images
- Generates actionable content recommendations
- Creates automated workflows based on analysis insights

You have access to detailed analytics about a Facebook page. Here's the complete context:

PAGE INFORMATION:
${context.pageInfo ? `
- Page/File Name: ${context.pageInfo.name || 'N/A'}
- Total Posts Analyzed: ${context.pageInfo.totalPosts || 0}
- Total Views: ${context.pageInfo.totalViews || 0}
- Average Views per Post: ${context.pageInfo.avgViews || 0}
- Page Type/Niche: ${context.pageInfo.pageType || 'general'}
` : 'No page info available'}

TOP PERFORMING POSTS (sorted by views):
${context.topPosts?.length > 0 ? context.topPosts.map(post => `
#${post.rank}. Views: ${post.views || 0}
   Text: "${(post.text || '').substring(0, 400)}${(post.text || '').length > 400 ? '...' : ''}"
   Reactions: ${post.reactions || 0} | Comments: ${post.comments || 0} | Shares: ${post.shares || 0}
   Date: ${post.date || 'N/A'}
`).join('\n') : 'No top posts data available'}

${context.imageAnalyses?.length > 0 ? `
ANALYZED IMAGES FROM TOP POSTS:
${context.imageAnalyses.map(img => `
Image Rank #${img.rank} (${img.views || 0} views):
${img.description || 'No description'}
`).join('\n')}
` : ''}

${context.insights ? `
AI ANALYSIS INSIGHTS:

Winning Keywords: ${JSON.stringify(context.insights.winningKeywords || []).substring(0, 500)}

Hook Patterns: ${JSON.stringify(context.insights.hookPatterns || []).substring(0, 500)}

Content Structure: ${JSON.stringify(context.insights.contentStructure || {}).substring(0, 500)}

Psychological Triggers: ${JSON.stringify(context.insights.psychologicalTriggers || []).substring(0, 300)}

Do More Of: ${JSON.stringify(context.insights.doMore || []).substring(0, 400)}

Avoid: ${JSON.stringify(context.insights.avoid || []).substring(0, 400)}

Content Ideas: ${JSON.stringify(context.insights.contentIdeas || []).substring(0, 500)}

Niche Insights: ${JSON.stringify(context.insights.nicheInsights || {}).substring(0, 400)}

Visual Patterns: ${context.insights.visualPatterns ? JSON.stringify(context.insights.visualPatterns).substring(0, 600) : 'N/A'}
` : 'No AI insights available'}

${context.imageComparison ? `
AI IMAGE COMPARISON SUMMARY:
${context.imageComparison}
` : ''}

${context.previouslyGeneratedTitles?.length > 0 ? `
PREVIOUSLY GENERATED TITLES (DO NOT REPEAT THESE):
The user has already received these titles in this conversation. When generating new titles, create completely different ones - avoid duplicates or very similar variations:
${context.previouslyGeneratedTitles.join('\n')}
` : ''}

Your role is to:
1. Answer questions about the page's performance and content based on the data above
2. Provide insights on what makes posts successful
3. Suggest content ideas based on top performers and patterns
4. Analyze images the user shares (if any)
5. Give actionable recommendations to improve engagement
6. Reference specific data from the analysis when answering
7. Help users understand how to use ViralCloner features to replicate success
8. Suggest automation workflows they could create based on the analysis
9. When generating titles or content ideas, NEVER repeat previously generated ones

Be concise, data-driven, and helpful. When providing suggestions, reference specific examples from the analyzed posts. You can suggest ViralCloner features that would help them implement recommendations (like creating automations, using MiniCanvas for images, or setting up workflows).`;

      // Get API key based on provider
      let apiKey, apiUrl, headers, requestBody;
      
      // Build messages with potential images
      const formattedMessages = messages.map(msg => {
        if (msg.role === 'user' && msg.images?.length) {
          // Message with images
          const content = [];
          msg.images.forEach(img => {
            content.push({
              type: 'image_url',
              image_url: { url: img }
            });
          });
          content.push({ type: 'text', text: msg.content });
          return { role: msg.role, content };
        }
        return { role: msg.role, content: msg.content };
      });

      // Add any new images from current message
      if (images?.length && formattedMessages.length > 0) {
        const lastMsg = formattedMessages[formattedMessages.length - 1];
        if (typeof lastMsg.content === 'string') {
          const content = [];
          images.forEach(img => {
            content.push({
              type: 'image_url',
              image_url: { url: img }
            });
          });
          content.push({ type: 'text', text: lastMsg.content });
          formattedMessages[formattedMessages.length - 1] = { 
            role: lastMsg.role, 
            content 
          };
        }
      }

      if (provider === 'openai') {
        const openaiKeys = await readKey('openaiKeys') || {};
        const keyEntries = Object.entries(openaiKeys);
        if (!keyEntries.length) {
          throw new Error('No OpenAI API keys configured');
        }
        // Try to find a working key (in case one is rate-limited)
        apiKey = keyEntries[0][0];
        apiUrl = 'https://api.openai.com/v1/chat/completions';
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        };
        // Check if this is an o-series reasoning model (o1, o3, o4, etc.) or gpt-5-nano
        const modelToCheck = model || 'gpt-5-nano';
        const isReasoningModel = /^o[134]-|^o[134]$/.test(modelToCheck);
        const isNanoModel = modelToCheck.includes('nano');
        
        // Truncate context to reduce token usage and avoid quota issues
        const truncatedSystemPrompt = systemPrompt.length > 8000 
          ? systemPrompt.substring(0, 8000) + '\n\n[Context truncated for efficiency...]'
          : systemPrompt;
        
        requestBody = {
          model: model || 'gpt-5-nano',
          messages: [
            { role: 'system', content: truncatedSystemPrompt },
            ...formattedMessages
          ],
          stream: true,
          // Reduce max tokens to avoid quota issues
          max_completion_tokens: 2048
        };
        // Reasoning models and nano models don't support custom temperature
        if (!isReasoningModel && !isNanoModel) {
          requestBody.temperature = 0.7;
        }
      } else if (provider === 'anthropic') {
        const anthropicKeys = await readKey('anthropicKeys') || {};
        const keyEntries = Object.entries(anthropicKeys);
        if (!keyEntries.length) {
          throw new Error('No Anthropic API keys configured');
        }
        apiKey = keyEntries[0][0];
        apiUrl = 'https://api.anthropic.com/v1/messages';
        headers = {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        };
        
        // Convert messages for Anthropic format (images need base64)
        const anthropicMessages = [];
        for (const msg of formattedMessages) {
          if (Array.isArray(msg.content)) {
            // Message with images - convert to Anthropic format
            const content = [];
            for (const part of msg.content) {
              if (part.type === 'image_url') {
                const imgUrl = part.image_url.url;
                if (imgUrl.startsWith('data:')) {
                  const [meta, base64Data] = imgUrl.split(',');
                  const mediaType = meta.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                  content.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: base64Data
                    }
                  });
                }
              } else if (part.type === 'text') {
                content.push({ type: 'text', text: part.text });
              }
            }
            anthropicMessages.push({ role: msg.role, content });
          } else {
            anthropicMessages.push({ role: msg.role, content: msg.content });
          }
        }
        
        requestBody = {
          model: model || 'claude-sonnet-4-20250514',
          system: systemPrompt,
          messages: anthropicMessages,
          stream: true,
          max_tokens: 4096  // Anthropic uses max_tokens (not max_completion_tokens)
        };
      } else if (provider === 'google' || provider === 'googleai') {
        const googleKeys = await readKey('googleaiKeys') || {};
        const keyEntries = Object.entries(googleKeys);
        if (!keyEntries.length) {
          throw new Error('No Google AI API keys configured');
        }
        apiKey = keyEntries[0][0];
        const modelName = model || 'gemini-1.5-flash';
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${apiKey}`;
        headers = { 'Content-Type': 'application/json' };
        
        // Convert messages to Gemini format
        const contents = [];
        for (const msg of formattedMessages) {
          const role = msg.role === 'assistant' ? 'model' : 'user';
          if (Array.isArray(msg.content)) {
            const parts = [];
            for (const part of msg.content) {
              if (part.type === 'image_url') {
                const imgUrl = part.image_url.url;
                if (imgUrl.startsWith('data:')) {
                  const [meta, base64Data] = imgUrl.split(',');
                  const mimeType = meta.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                  parts.push({
                    inline_data: {
                      mime_type: mimeType,
                      data: base64Data
                    }
                  });
                }
              } else if (part.type === 'text') {
                parts.push({ text: part.text });
              }
            }
            contents.push({ role, parts });
          } else {
            contents.push({ role, parts: [{ text: msg.content }] });
          }
        }
        
        requestBody = {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { maxOutputTokens: 4096 }
        };
      } else if (provider === 'openrouter') {
        const openrouterKeys = await readKey('openrouterKeys') || {};
        const keyEntries = Object.entries(openrouterKeys);
        if (!keyEntries.length) {
          throw new Error('No OpenRouter API keys configured');
        }
        apiKey = keyEntries[0][0];
        apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': "https://github.com/viralcloner/ViralCloner",
          'X-Title': 'ViralCloner'
        };
        // Check if this is an OpenAI o-series model via OpenRouter
        const orModel = model || 'openai/gpt-5-nano';
        const isOpenAIReasoningModel = orModel.startsWith('openai/') && /o[134]-|o[134]$/.test(orModel);
        requestBody = {
          model: orModel,
          messages: [
            { role: 'system', content: systemPrompt },
            ...formattedMessages
          ],
          stream: true,
          // Use max_completion_tokens for OpenAI models (OpenRouter passes through)
          max_completion_tokens: 4096
        };
        // Reasoning models don't support temperature
        if (!isOpenAIReasoningModel) {
          requestBody.temperature = 0.7;
        }
      } else {
        throw new Error(`Unknown provider: ${provider}`);
      }

      console.log(`[FB Analytics Chat] Starting stream with ${provider}/${model}`);
      
      let response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      // Handle rate limit errors (429) - try other keys if available
      if (response.status === 429 && (provider === 'openai' || provider === 'anthropic' || provider === 'googleai')) {
        const providerKeyMap = { openai: 'openaiKeys', anthropic: 'anthropicKeys', googleai: 'googleaiKeys' };
        const allKeys = await readKey(providerKeyMap[provider]) || {};
        const keyEntries = Object.entries(allKeys);
        
        // Try other keys
        for (let i = 1; i < keyEntries.length; i++) {
          console.log(`[FB Analytics Chat] Rate limited, trying key ${i + 1}/${keyEntries.length}`);
          const alternateKey = keyEntries[i][0];
          
          if (provider === 'openai') {
            headers['Authorization'] = `Bearer ${alternateKey}`;
          } else if (provider === 'anthropic') {
            headers['x-api-key'] = alternateKey;
          } else if (provider === 'googleai') {
            apiUrl = apiUrl.replace(/key=[^&]+/, `key=${alternateKey}`);
          }
          
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
          });
          
          if (response.ok) break;
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[FB Analytics Chat] API error:`, errorText);
        
        // Provide user-friendly error messages
        if (response.status === 429) {
          throw new Error('Rate limit exceeded. Your API key has reached its quota limit. Please check your billing settings at the API provider or try again later.');
        }
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      // Stream the response
      let fullResponse = '';
      let doneSent = false; // Prevent duplicate done events
      const reader = response.body;

      reader.on('data', (chunk) => {
        const text = chunk.toString();
        const lines = text.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              if (!doneSent) {
                doneSent = true;
                mainWindow?.webContents.send('fb-analytics-chat-chunk', { 
                  done: true, 
                  fullResponse 
                });
              }
              return;
            }
            
            try {
              const json = JSON.parse(data);
              let content = '';
              
              if (provider === 'openai' || provider === 'openrouter') {
                content = json.choices?.[0]?.delta?.content || '';
              } else if (provider === 'anthropic') {
                if (json.type === 'content_block_delta') {
                  content = json.delta?.text || '';
                }
              } else if (provider === 'google' || provider === 'googleai') {
                content = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
              }
              
              if (content) {
                fullResponse += content;
                mainWindow?.webContents.send('fb-analytics-chat-chunk', { 
                  chunk: content, 
                  done: false 
                });
              }
            } catch (e) {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      });

      reader.on('end', () => {
        if (!doneSent) {
          doneSent = true;
          mainWindow?.webContents.send('fb-analytics-chat-chunk', { 
            done: true, 
            fullResponse 
          });
        }
      });

      reader.on('error', (error) => {
        console.error('[FB Analytics Chat] Stream error:', error);
        if (!doneSent) {
          doneSent = true;
          mainWindow?.webContents.send('fb-analytics-chat-chunk', { 
            error: error.message, 
            done: true 
          });
        }
      });

      return { success: true, streaming: true };
    } catch (error) {
      console.error('[FB Analytics Chat] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Save chat conversation
  ipcMain.handle("save-fb-analytics-chat", async (_, { scanId, conversationId, conversation }) => {
    try {
      const chats = await readKey('fbAnalyticsChats') || {};
      
      if (!chats[scanId]) {
        chats[scanId] = {};
      }
      
      chats[scanId][conversationId] = {
        ...conversation,
        updatedAt: Date.now()
      };
      
      await updateData('fbAnalyticsChats', chats);
      console.log(`[FB Analytics Chat] Saved conversation ${conversationId} for scan ${scanId}`);
      
      return { success: true };
    } catch (error) {
      console.error('[FB Analytics Chat] Save error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get all chat conversations for a scan
  ipcMain.handle("get-fb-analytics-chats", async (_, scanId) => {
    try {
      const chats = await readKey('fbAnalyticsChats') || {};
      const scanChats = chats[scanId] || {};
      
      // Convert to array and sort by updatedAt
      const conversationList = Object.entries(scanChats).map(([id, conv]) => ({
        id,
        title: conv.title || 'New conversation',
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages?.length || 0
      })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      
      return { success: true, conversations: conversationList };
    } catch (error) {
      console.error('[FB Analytics Chat] Get chats error:', error);
      return { success: false, error: error.message };
    }
  });

  // Load a specific chat conversation
  ipcMain.handle("load-fb-analytics-chat", async (_, { scanId, conversationId }) => {
    try {
      const chats = await readKey('fbAnalyticsChats') || {};
      const scanChats = chats[scanId] || {};
      const conversation = scanChats[conversationId];
      
      if (!conversation) {
        return { success: false, error: 'Conversation not found' };
      }
      
      return { success: true, conversation };
    } catch (error) {
      console.error('[FB Analytics Chat] Load error:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete a chat conversation
  ipcMain.handle("delete-fb-analytics-chat", async (_, { scanId, conversationId }) => {
    try {
      const chats = await readKey('fbAnalyticsChats') || {};
      
      if (chats[scanId]?.[conversationId]) {
        delete chats[scanId][conversationId];
        await updateData('fbAnalyticsChats', chats);
        console.log(`[FB Analytics Chat] Deleted conversation ${conversationId}`);
      }
      
      return { success: true };
    } catch (error) {
      console.error('[FB Analytics Chat] Delete error:', error);
      return { success: false, error: error.message };
    }
  });

  // ========== AI Automation Agent ==========

  // Helper: Parse text-based tool calls from qwenbrowser responses
  // The qwenbrowser proxy (qwen.aikit.club) doesn't support native function calling,
  // so the model outputs tool calls as <tool_call>{...}</tool_call> text blocks
  function parseQwenTextToolCalls(responseText) {
    const toolCalls = [];
    let cleanedText = responseText;
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    let match;
    let callIndex = 0;
    while ((match = toolCallRegex.exec(responseText)) !== null) {
      try {
        const raw = match[1].trim();
        const parsed = JSON.parse(raw);
        if (parsed.name && parsed.arguments !== undefined) {
          // Guard against double-stringified arguments (agent wraps them in quotes)
          let args = parsed.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (e) { /* keep as-is */ }
          }
          toolCalls.push({
            id: `qwen-text-${Date.now()}-${callIndex}`,
            name: parsed.name,
            arguments: args
          });
          callIndex++;
        }
      } catch (e) {
        console.warn('[Automation Agent] Failed to parse qwen text tool call:', match[1].substring(0, 100));
      }
    }
    if (toolCalls.length > 0) {
      cleanedText = responseText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
    }
    return { toolCalls, cleanedText };
  }

  // Get automation agent tools schema
  ipcMain.handle("get-automation-agent-tools", async () => {
    try {
      const toolsPath = path.join(__dirname, '..', 'data', 'automationAgentTools.json');
      const toolsData = fss.readFileSync(toolsPath, 'utf8');
      return { success: true, data: JSON.parse(toolsData) };
    } catch (error) {
      console.error('[Automation Agent] Error loading tools:', error);
      return { success: false, error: error.message };
    }
  });

  // Save agent session log for debugging
  ipcMain.handle("save-agent-session-log", async (_, logData) => {
    try {
      const { app } = require('electron');
      const logsDir = path.join(app.getPath('userData'), 'Logs');
      
      // Ensure directory exists
      if (!fss.existsSync(logsDir)) {
        fss.mkdirSync(logsDir, { recursive: true });
      }
      
      // Create filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `agent-session-${timestamp}.json`;
      const filePath = path.join(logsDir, filename);
      
      // Write log file
      fss.writeFileSync(filePath, JSON.stringify(logData, null, 2), 'utf8');
      
      console.log(`[Automation Agent] Session log saved: ${filePath}`);
      return { success: true, path: filePath };
    } catch (error) {
      console.error('[Automation Agent] Error saving session log:', error);
      return { success: false, error: error.message };
    }
  });

  // Open agent logs folder
  ipcMain.handle("open-agent-logs-folder", async () => {
    try {
      const { app, shell } = require('electron');
      const logsDir = path.join(app.getPath('userData'), 'Logs');
      
      // Ensure directory exists
      if (!fss.existsSync(logsDir)) {
        fss.mkdirSync(logsDir, { recursive: true });
      }
      
      shell.openPath(logsDir);
      return { success: true, path: logsDir };
    } catch (error) {
      console.error('[Automation Agent] Error opening logs folder:', error);
      return { success: false, error: error.message };
    }
  });

  // Helper to parse and repair malformed tool arguments JSON
  function tryParseToolArgs(argsString, toolName) {
    if (!argsString || argsString.trim() === '') {
      return {};
    }
    
    // Try direct parse first
    try {
      return JSON.parse(argsString);
    } catch (e) {
      console.warn('[Automation Agent] Initial JSON parse failed for', toolName, '- attempting repair...');
      console.warn('[Automation Agent] Raw args:', argsString.substring(0, 500));
    }
    
    // Try to repair common issues
    let repaired = argsString;
    
    // Fix incomplete numbers like "0." -> "0.7" or "temperature":0.," -> "temperature":0.7,"
    repaired = repaired.replace(/"temperature"\s*:\s*(\d+)\.\s*,/g, '"temperature": $1.7,');
    repaired = repaired.replace(/"temperature"\s*:\s*(\d+)\.\s*}/g, '"temperature": $1.7}');
    repaired = repaired.replace(/"temperature"\s*:\s*\.\s*,/g, '"temperature": 0.7,');
    
    // Fix "Values" typo -> "configValues"
    repaired = repaired.replace(/"Values"\s*:/gi, '"configValues":');
    
    // Fix missing colon after "prompt" (e.g., "promptTurn this" -> "prompt": "Turn this")
    repaired = repaired.replace(/"prompt([A-Z][^"]{0,500})"/g, (match, rest) => {
      return `"prompt": "${rest}"`;
    });
    
    // Fix positionHint format "after:nodeId:1" -> "after:1"  
    repaired = repaired.replace(/"after:nodeId:(\d+)"/g, '"after:$1"');
    repaired = repaired.replace(/"positionHint"\s*:\s*"after:nodeId:(\d+)"/g, '"positionHint": "after:$1"');
    
    // Fix model names with typos like "gpt-o-mini" -> "gpt-5-nano"
    repaired = repaired.replace(/"gpt-o-mini"/g, '"gpt-5-nano"');
    repaired = repaired.replace(/"gpt-o"/g, '"gpt-5-nano"');
    
    // Try to close unclosed strings and objects
    const openBraces = (repaired.match(/{/g) || []).length;
    const closeBraces = (repaired.match(/}/g) || []).length;
    if (openBraces > closeBraces) {
      // Check if we're in the middle of a string
      const lastQuote = repaired.lastIndexOf('"');
      const beforeLastQuote = repaired.substring(0, lastQuote);
      const quotesBefore = (beforeLastQuote.match(/"/g) || []).length;
      if (quotesBefore % 2 === 0) {
        // Even number means we need to close a string
        repaired += '"';
      }
      // Close missing braces
      repaired += '}'.repeat(openBraces - closeBraces);
    }
    
    try {
      const parsed = JSON.parse(repaired);
      console.log('[Automation Agent] JSON repair successful');
      return parsed;
    } catch (e2) {
      console.error('[Automation Agent] Failed to repair JSON for', toolName);
      console.error('[Automation Agent] Original:', argsString.substring(0, 300));
      console.error('[Automation Agent] Repair attempt:', repaired.substring(0, 300));
      
      // Return minimal valid args based on what we can extract
      const nodeTypeMatch = argsString.match(/"nodeType"\s*:\s*"([^"]+)"/);
      const labelMatch = argsString.match(/"label"\s*:\s*"([^"]+)"/);
      const nodeIdMatch = argsString.match(/"nodeId"\s*:\s*"?(\d+)"?/);
      
      if (toolName === 'add_node' && nodeTypeMatch) {
        console.log('[Automation Agent] Extracted minimal args for add_node');
        return {
          nodeType: nodeTypeMatch[1],
          label: labelMatch ? labelMatch[1] : undefined
        };
      }
      
      if ((toolName === 'connect_nodes' || toolName === 'edit_node') && nodeIdMatch) {
        console.log('[Automation Agent] Extracted nodeId for', toolName);
        return { nodeId: nodeIdMatch[1] };
      }
      
      if (toolName === 'get_canvas_state') {
        return {};
      }
      
      return null;
    }
  }

  // Track active automation agent streams for cancellation
  let activeAgentAbortController = null;

  // Stop automation agent stream
  ipcMain.handle("stop-automation-agent", async () => {
    if (activeAgentAbortController) {
      console.log('[Automation Agent] Stopping agent stream...');
      activeAgentAbortController.abort();
      activeAgentAbortController = null;
      return { success: true };
    }
    return { success: false, error: 'No active agent stream' };
  });

  // Streaming chat with AI for Automation Agent (with function calling)
  ipcMain.handle("automation-agent-stream", async (event, { messages, provider, model, canvasState, language }) => {
    // Create abort controller for this stream
    const abortController = new AbortController();
    activeAgentAbortController = abortController;
    
    try {
      const fetch = require("node-fetch");
      const mainWindow = BrowserWindow.getAllWindows()[0];
      
      // Load tools schema
      const toolsPath = path.join(__dirname, '..', 'data', 'automationAgentTools.json');
      const toolsData = JSON.parse(fss.readFileSync(toolsPath, 'utf8'));
      
      // Language mapping
      const languageNames = { 'en': 'English', 'fr': 'French', 'ar': 'Arabic' };
      const responseLang = languageNames[language] || 'English';
      
      // Fetch all configured services to tell AI what's available
      const [openaiKeys, anthropicKeys, googleaiKeys, openrouterKeys, chineseaiKeys, discordProfiles, qwenBrowserProfiles, deepseekBrowserProfilesAgent] = await Promise.all([
        readKey('openaiKeys'),
        readKey('anthropicKeys'),
        readKey('googleaiKeys'),
        readKey('openrouterKeys'),
        readKey('chineseaiKeys'),
        readKey('discordProfiles'),
        readKey('qwenBrowserProfiles'),
        readKey('deepseekBrowserProfiles')
      ]);
      
      // Detect available text AI providers
      const availableTextAI = [];
      if (openaiKeys && Object.keys(openaiKeys).length > 0) availableTextAI.push('openai');
      if (anthropicKeys && Object.keys(anthropicKeys).length > 0) availableTextAI.push('anthropic');
      if (googleaiKeys && Object.keys(googleaiKeys).length > 0) availableTextAI.push('googleai');
      if (openrouterKeys && Object.keys(openrouterKeys).length > 0) availableTextAI.push('openrouter');
      if (chineseaiKeys && Object.keys(chineseaiKeys).length > 0) availableTextAI.push('chineseai');
      const hasConnectedQwenProfile = qwenBrowserProfiles && Object.values(qwenBrowserProfiles).some(p => p?.status === 'connected');
      if (hasConnectedQwenProfile) availableTextAI.push('qwenbrowser');
      const hasConnectedDeepSeekProfile = deepseekBrowserProfilesAgent && Object.values(deepseekBrowserProfilesAgent).some(p => p?.status === 'connected');
      if (hasConnectedDeepSeekProfile) availableTextAI.push('deepseekbrowser');
      
      // Detect available image generators
      const availableImageGen = [];
      // Midjourney requires a connected Discord profile
      const hasConnectedDiscord = discordProfiles && Object.values(discordProfiles).some(p => p?.status === 'connected');
      if (hasConnectedDiscord) availableImageGen.push('midjourney');
      // GPT Image uses OpenAI API
      if (openaiKeys && Object.keys(openaiKeys).length > 0) availableImageGen.push('gptimage');
      // ChatGPT Image is always available (browser-based, no API key needed)
      availableImageGen.push('chatgptimage');
      // Google AI Image uses Google AI API
      if (googleaiKeys && Object.keys(googleaiKeys).length > 0) availableImageGen.push('googleaiimage');
      
      // Build compact available services info
      const availableServicesInfo = `AVAILABLE: TextAI=[${availableTextAI.join(',')}] ImageGen=[${availableImageGen.join(',')}]`;

      // Compact canvas state - remove positions and verbose data
      const compactCanvasState = canvasState ? {
        nodes: (canvasState.nodes || []).map(n => ({
          id: n.id,
          type: n.type,
          label: n.label,
          // Only include non-empty config values (handle both 'config' and 'configValues' keys)
          ...(Object.keys(n.config || n.configValues || {}).length > 0 ? {
            config: Object.fromEntries(
              Object.entries(n.config || n.configValues || {}).filter(([k, v]) => v !== undefined && v !== '' && v !== null)
            )
          } : {})
        })).filter(n => n.id), // Remove any invalid nodes
        // Handle both string format (new) and object format (old) connections
        connections: (canvasState.connections || []).map(c => 
          typeof c === 'string' ? c : `${c.from?.nodeId}:${c.from?.output}->${c.to?.nodeId}:${c.to?.input}`
        )
      } : null;

      // Detect user intent from the last message to adjust behavior
      // Skip tool result messages (role='tool') - they are not user intent signals
      const lastUserMsg = messages.filter(m => m.role === 'user' && !String(m.content || '').startsWith('[Tool result')).pop();
      const userText = typeof lastUserMsg?.content === 'string' 
        ? lastUserMsg.content.toLowerCase() 
        : (lastUserMsg?.content?.find?.(p => p.type === 'text')?.text || '').toLowerCase();
      
      // Intent detection
      const isEditIntent = /\b(edit|change prompt|modify prompt|update prompt|update text|fix prompt|improve prompt|rewrite|no engagement|remove|don't use)\b/.test(userText);
      const isReplaceIntent = /\b(replace|swap|switch|change .+ to|convert .+ to)\b/.test(userText);
      const isBuildIntent = /\b(build|create|make|new workflow|new automation|from scratch|set up)\b/.test(userText);
      const isEmptyCanvas = !compactCanvasState || compactCanvasState.nodes?.length <= 3; // input + 2 outputs
      
      // Choose behavior mode
      let modeInstruction = '';
      if (isEditIntent && !isBuildIntent) {
        modeInstruction = `
⚠️ EDIT MODE: User wants to edit/modify existing content.
- ONLY edit what user specifically asks for (prompts, settings, labels)
- DO NOT add new nodes or change connections
- DO NOT call auto_layout
- DO NOT "improve" or restructure the workflow
- Just make the requested edits and confirm what you changed
`;
      } else if (isReplaceIntent) {
        modeInstruction = `
⚠️ REPLACE MODE: User wants to replace a node type.
- Different nodes have different input/output signatures - warn user about incompatibilities
- Delete old node, add new node, then ask user how to reconnect if signatures differ
- DO NOT automatically add intermediate nodes without asking
- DO NOT call auto_layout unless asked
`;
      } else if (isBuildIntent || isEmptyCanvas) {
        modeInstruction = `
🔨 BUILD MODE: User wants to create a workflow.
- IMMEDIATELY start calling tools - DO NOT ask for confirmation first!
- If canvas has old/unrelated nodes, clear them first with clear_canvas, then build fresh
- Add ALL required nodes, configure ALL prompts, connect ALL nodes
- Call auto_layout at the end to organize
- NEVER stop mid-way to ask "what would you like me to do?" - just build the complete workflow
`;
      } else {
        modeInstruction = `
📋 ASSISTANT MODE: Make only the changes user explicitly requests.
- If user asks about prompts or settings, edit those only
- If unclear what user wants, ask for clarification
- DO NOT add/remove nodes or change connections unless explicitly asked
- DO NOT call auto_layout unless explicitly asked
`;
      }

      // Build optimized system prompt
      const systemPrompt = `You are an expert automation workflow builder. Build and edit node-based automation graphs by calling tools.

━━━ 3-STEP BUILD PATTERN (follow this every time you build) ━━━
STEP 1 — PLAN + CLEAR: Write your complete workflow plan as text first (list each node, its single job, and all connections). Then call clear_canvas ALONE — it returns the real IDs of the persistent input/output nodes for this canvas.
STEP 2 — ADD NODES: After seeing the clear_canvas result, emit ONLY add_node calls (one per node, no connect_nodes). Each add_node result returns a "ports" map: {inputs:[{id,type,label}...], outputs:[...]}. Read these carefully.
STEP 3 — CONNECT: After ALL add_node results are in, emit all connect_nodes calls using the EXACT port IDs from the step 2 results, then auto_layout.

WHY: add_node tells you the real ports. You never have to guess or memorize signatures — just read the results.

━━━ DESIGN PRINCIPLES ━━━
• ONE NODE = ONE TASK: Each distinct output gets its own dedicated node. NEVER combine "article + FB post" into one LLM call.
• PARALLEL BRANCHES: Multiple outputs from same source = parallel branches with dedicated nodes.
  Example (title → article on WordPress + FB post with image):
  input.output_2 → DeepSeek(write article) → wordpress.input_2
  input.output_2 → DeepSeek(write FB text) → facebook-output.input_2
  input.output_2 → Midjourney(generate image) → facebook-output.input_1
  input.output_2 → wordpress.input_1 (title goes directly to WP title field)
• CORRECT TOOL: WordPress = wordpress node ONLY. Not curl, not variables as workarounds.
• variables node: reformats ONE input into a template string. Only has input_1. Never connect input_2/input_3.
• Don't add unnecessary nodes. Don't over-engineer.

━━━ FIXED PORTS (only these need to be memorized) ━━━
• input node: output_1=image/url, output_2=text
• facebook-output: input_1=image, input_2=text, input_3=video
• pinterest-output: input_1=url(image), input_2=text, input_3=text, input_4=url, input_5=url
For ALL other nodes: read ports from add_node result in step 2, or call get_node_info before planning.

━━━ TYPE RULES ━━━
• Connections only work when output type exactly matches input type (or either side is "all").
• image/images → url: INCOMPATIBLE. Use an imageupload node: source.output_1 → imageupload.input_1 → imageupload.output_1 → destination.
• url → image: INCOMPATIBLE. The imagedownloader node converts url → image.
• text → image: INCOMPATIBLE. Connect to a text input port instead.

━━━ LLM PROMPT RULES ━━━
• TEXT nodes (openai, anthropic, googleai, deepseekbrowser, qwenbrowser, chineseai, openrouter, chatgptchat, variables): end every prompt with "Output ONLY the result text, no explanations, no preamble, no labels."
• IMAGE nodes (midjourney, gptimage, googleaiimage, chatgptimage, geminiimage, soraimage, metaaiimage, googledocsveo): write a descriptive visual prompt — NO "Output ONLY" instruction. These are image generators, not text models.
• midjourney format: "[visual description], [style/mood/lighting] --v 6.1 --ar 16:9". Use {INPUT_2} to incorporate dynamic text. Example: "A professional blogger writing at desk, modern office, warm lighting, {INPUT_2} visible on screen --v 6.1 --ar 16:9".
• deepThink: set to "true" ONLY for tasks requiring deep analysis (long-form articles, SEO content, complex reasoning). Default: false.
• webSearch: set to "true" ONLY when the task explicitly needs current/real-time data (today's news, current prices, live events). Default: false. Do NOT enable it just because search might help.
${modeInstruction}
${availableServicesInfo}
${availableTextAI.length === 0 ? '⚠️ No text AI configured!' : ''}

RESPOND IN: ${responseLang}

CANVAS: ${compactCanvasState ? JSON.stringify(compactCanvasState) : 'Empty'}${(provider === 'qwenbrowser' || provider === 'deepseekbrowser') ? `

TOOL FORMAT: <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>

NODE IDs: clear_canvas returns keptNodes with REAL IDs for input/output nodes — they change every session. NEVER hardcode IDs. New nodes get sequential IDs starting from nextNodeId.

TOOLS:
- get_node_info: {"nodeType": "string"} → returns ports map. Call BEFORE Step 1 if unsure about any node.
- clear_canvas: {} → {keptNodes:{"input":"X","facebook-output":"Y"}, nextNodeId:N} — call ALONE in Step 1
- add_node: {"nodeType": "openai|anthropic|googleai|chineseai|openrouter|midjourney|gptimage|googleaiimage|chatgptimage|chatgptchat|geminiimage|metaaiimage|metaaivideo|googledocsveo|soraimage|deepseekbrowser|qwenbrowser|variables|imageupload|videoupload|imagedownloader|videotoimage|minicanvas|googlesites|curl|advancedcurl|jsonparser|splitter|serpapi|amazoncrawl|amazonafflink|subautomation|vctts|videoeditor|wordpress|wordpressget|wprecipemaker", "label": "string", "configValues": {"prompt": "...", "text": "... (variables only)", "model": "...", "deepThink": "true (ONLY for complex articles/deep analysis, default false)", "webSearch": "true (ONLY for current/live data needed, default false)"}} → returns {nodeId, ports:{inputs:[...], outputs:[...]}} — Step 2 ONLY, no connect_nodes yet
- connect_nodes: {"fromNodeId": "LITERAL_NUMBER", "fromOutput": "output_1", "toNodeId": "LITERAL_NUMBER", "toInput": "input_1"} — Step 3 ONLY. nodeId values MUST be literal numbers copied from [Tool result for add_node] (e.g. "6", "7"). NEVER use variable names or placeholders.
- edit_node: {"nodeId": "string", "configValues": {"prompt": "...", "model": "...", "text": "...", "deepThink": "true|false", "webSearch": "true|false"}}
- delete_node: {"nodeId": "string"}
- disconnect_nodes: {"fromNodeId": "string", "fromOutput": "output_1", "toNodeId": "string", "toInput": "input_1"}
- get_canvas_state: {}
- auto_layout: {} — always call at end of Step 3

PROMPT CONTENT RULES:
- TEXT nodes (openai, anthropic, googleai, deepseekbrowser, qwenbrowser, chineseai, openrouter, chatgptchat): end prompt with "Output ONLY the result text, no explanations, no preamble, no labels."
- IMAGE nodes (midjourney, gptimage, googleaiimage, chatgptimage, geminiimage, soraimage): write a visual description ONLY — NO "Output ONLY" instruction. Midjourney format: "[visual description], [style/mood] --v 6.1 --ar 16:9". Example: "Colorful healthy recipe photo, food photography, natural lighting, {INPUT_2} --v 6.1 --ar 16:9".
- deepThink: "true" only for complex articles, SEO content, deep analysis. Default: omit or false.
- webSearch: "true" ONLY when task needs current/live data (today's news, live prices). Default: omit or false. Do NOT enable it speculatively.

RULES:
- NEVER use web_search
- NEVER ask for confirmation — always act immediately
- Step 2: emit ONLY add_node calls — do NOT add connect_nodes in the same turn
- Step 3: emit ALL connect_nodes at once, then auto_layout
- EDITING: for any node setting change, call edit_node immediately using the node ID from canvas state` : ''}`;

      // Log system prompt size for debugging
      console.log(`[Automation Agent] System prompt size: ${systemPrompt.length} chars (~${Math.ceil(systemPrompt.length / 4)} tokens)`);

      // Convert tools to OpenAI function format
      const functions = toolsData.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }));

      // Clean messages - remove internal properties and ensure proper format
      // Also truncate verbose tool results and strip old images to save tokens
      let cleanMessages = messages.map((msg, idx) => {
        const clean = { role: msg.role };
        const isLastUserMessage = msg.role === 'user' && idx === messages.length - 1;
        
        // Handle content - can be string or array (for images)
        if (msg.content !== undefined && msg.content !== null) {
          // Truncate very long tool results (canvas state returns can be huge)
          if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 2000) {
            try {
              const parsed = JSON.parse(msg.content);
              // Compact canvas state results
              if (parsed.result?.nodes) {
                parsed.result = {
                  nodes: parsed.result.nodes.map(n => ({ id: n.id, type: n.type, label: n.label })),
                  connections: parsed.result.connections?.map(c => 
                    `${c.from?.nodeId}:${c.from?.output}->${c.to?.nodeId}:${c.to?.input}`
                  ) || []
                };
              }
              clean.content = JSON.stringify(parsed);
            } catch {
              // If not JSON, just truncate
              clean.content = msg.content.substring(0, 2000) + '...[truncated]';
            }
          } else if (Array.isArray(msg.content)) {
            // Handle multi-part content (text + images)
            // Only keep images in the LAST user message to save tokens
            if (isLastUserMessage) {
              clean.content = msg.content;
            } else {
              // Strip images from older messages, keep only text
              const textParts = msg.content.filter(p => p.type === 'text');
              if (textParts.length > 0) {
                // If there were images, note that they were removed
                const hadImages = msg.content.some(p => p.type === 'image_url');
                if (hadImages) {
                  textParts.push({ type: 'text', text: '[image removed from history]' });
                }
                clean.content = textParts.length === 1 ? textParts[0].text : textParts;
              } else {
                clean.content = '[image removed from history]';
              }
            }
          } else {
            clean.content = msg.content;
          }
        }
        
        // Handle tool_calls for assistant messages
        if (msg.tool_calls) {
          clean.tool_calls = msg.tool_calls;
        }
        
        // Handle tool responses
        if (msg.role === 'tool') {
          clean.tool_call_id = msg.tool_call_id;
          if (msg.name) clean.name = msg.name;
        }
        
        return clean;
      });

      // Aggressive message trimming - tool call exchanges consume massive tokens
      // Keep first user message + last 12 messages (much smaller than before)
      const MAX_MESSAGES = 15;
      if (cleanMessages.length > MAX_MESSAGES) {
        console.log(`[Automation Agent] Trimming messages from ${cleanMessages.length} to ${MAX_MESSAGES}`);
        
        // Find the first user message (the original request)
        const firstUserIdx = cleanMessages.findIndex(m => m.role === 'user');
        const firstMessages = firstUserIdx >= 0 ? cleanMessages.slice(0, firstUserIdx + 1) : [];
        
        // Keep the last messages, ensuring we don't break tool call pairs
        let lastMessages = cleanMessages.slice(-(MAX_MESSAGES - firstMessages.length));
        
        // Make sure we don't start with a tool message (it needs its assistant message)
        while (lastMessages.length > 0 && lastMessages[0].role === 'tool') {
          // Find the preceding assistant message with tool_calls
          const fullStartIdx = cleanMessages.length - lastMessages.length - 1;
          if (fullStartIdx >= 0 && cleanMessages[fullStartIdx]?.tool_calls) {
            lastMessages = [cleanMessages[fullStartIdx], ...lastMessages];
          } else {
            // Can't find the pair, just skip this tool message
            lastMessages = lastMessages.slice(1);
          }
        }
        
        // Combine, avoiding duplicates
        if (firstMessages.length > 0 && lastMessages.length > 0) {
          const lastStartIdx = cleanMessages.indexOf(lastMessages[0]);
          if (lastStartIdx > firstMessages.length) {
            // Add a summary message
            cleanMessages = [
              ...firstMessages,
              { role: 'assistant', content: '[Previous conversation trimmed for context length. Continuing from recent state...]' },
              ...lastMessages
            ];
          } else {
            cleanMessages = lastMessages;
          }
        }
        
        console.log(`[Automation Agent] After trimming: ${cleanMessages.length} messages`);
      }

      // Get API key based on provider
      let apiKey, apiUrl, headers, requestBody;
      
      if (provider === 'openai') {
        const openaiKeys = await readKey('openaiKeys') || {};
        const keyEntries = Object.entries(openaiKeys);
        if (!keyEntries.length) throw new Error('No OpenAI API keys configured');
        apiKey = keyEntries[0][0];
        apiUrl = 'https://api.openai.com/v1/chat/completions';
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        };
        
        // Models that don't support custom temperature (reasoning models only)
        const noCustomTemperature = /^o[134]-|^o[134]$/.test(model || 'gpt-5.2');
        requestBody = {
          model: model || 'gpt-5.2',
          messages: [
            { role: 'system', content: systemPrompt },
            ...cleanMessages
          ],
          stream: true,
          tools: functions.map(f => ({ type: 'function', function: f })),
          tool_choice: 'auto',
          max_completion_tokens: 4096
        };
        if (!noCustomTemperature) requestBody.temperature = 0.7;
        
      } else if (provider === 'anthropic') {
        const anthropicKeys = await readKey('anthropicKeys') || {};
        const keyEntries = Object.entries(anthropicKeys);
        if (!keyEntries.length) throw new Error('No Anthropic API keys configured');
        apiKey = keyEntries[0][0];
        apiUrl = 'https://api.anthropic.com/v1/messages';
        headers = {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        };
        
        // Convert messages to Anthropic format (handle tool_calls, tool responses, and images)
        const anthropicMessages = [];
        for (const msg of cleanMessages) {
          if (msg.role === 'user') {
            // Handle user messages - can be string or array with images
            if (typeof msg.content === 'string') {
              anthropicMessages.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
              // Convert from OpenAI image format to Anthropic format
              const anthropicContent = msg.content.map(part => {
                if (part.type === 'text') {
                  return { type: 'text', text: part.text };
                } else if (part.type === 'image_url') {
                  // Extract base64 data from data URL
                  const dataUrl = part.image_url?.url || '';
                  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                  if (match) {
                    return {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: match[1],
                        data: match[2]
                      }
                    };
                  }
                  return { type: 'text', text: '[Image could not be processed]' };
                }
                return part;
              });
              anthropicMessages.push({ role: 'user', content: anthropicContent });
            }
          } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              // Assistant with tool calls - convert to Anthropic tool_use format
              const contentBlocks = [];
              if (msg.content) {
                contentBlocks.push({ type: 'text', text: msg.content });
              }
              for (const tc of msg.tool_calls) {
                contentBlocks.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function?.name || tc.name,
                  input: typeof tc.function?.arguments === 'string' 
                    ? JSON.parse(tc.function.arguments) 
                    : (tc.arguments || {})
                });
              }
              anthropicMessages.push({ role: 'assistant', content: contentBlocks });
            } else {
              anthropicMessages.push({ role: 'assistant', content: msg.content });
            }
          } else if (msg.role === 'tool') {
            // Tool result - convert to Anthropic tool_result format
            anthropicMessages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content
              }]
            });
          }
        }
        
        requestBody = {
          model: model || 'claude-sonnet-4-5',
          system: systemPrompt,
          messages: anthropicMessages,
          stream: true,
          max_tokens: 4096,
          tools: functions.map(f => ({
            name: f.name,
            description: f.description,
            input_schema: f.parameters
          }))
        };
        
      } else if (provider === 'googleai') {
        const googleKeys = await readKey('googleaiKeys') || {};
        const keyEntries = Object.entries(googleKeys);
        if (!keyEntries.length) throw new Error('No Google AI API keys configured');
        apiKey = keyEntries[0][0];
        const modelName = model || 'gemini-2.5-flash';
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${apiKey}`;
        headers = { 'Content-Type': 'application/json' };
        
        // Convert to Gemini format (handle tool_calls, tool responses, and images)
        const contents = [];
        for (const msg of cleanMessages) {
          if (msg.role === 'user') {
            // Handle user messages - can be string or array with images
            if (typeof msg.content === 'string') {
              contents.push({ role: 'user', parts: [{ text: msg.content }] });
            } else if (Array.isArray(msg.content)) {
              // Convert from OpenAI image format to Gemini format
              const parts = msg.content.map(part => {
                if (part.type === 'text') {
                  return { text: part.text };
                } else if (part.type === 'image_url') {
                  const dataUrl = part.image_url?.url || '';
                  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                  if (match) {
                    return {
                      inlineData: {
                        mimeType: match[1],
                        data: match[2]
                      }
                    };
                  }
                  return { text: '[Image could not be processed]' };
                }
                return { text: '' };
              });
              contents.push({ role: 'user', parts });
            }
          } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              // Assistant with tool calls - convert to Gemini function call format
              const parts = [];
              if (msg.content) {
                parts.push({ text: msg.content });
              }
              for (const tc of msg.tool_calls) {
                parts.push({
                  functionCall: {
                    name: tc.function?.name || tc.name,
                    args: typeof tc.function?.arguments === 'string'
                      ? JSON.parse(tc.function.arguments)
                      : (tc.arguments || {})
                  }
                });
              }
              contents.push({ role: 'model', parts });
            } else {
              contents.push({ role: 'model', parts: [{ text: msg.content || '' }] });
            }
          } else if (msg.role === 'tool') {
            // Tool result - convert to Gemini function response format
            contents.push({
              role: 'user',
              parts: [{
                functionResponse: {
                  name: msg.name,
                  response: JSON.parse(msg.content)
                }
              }]
            });
          }
        }
        
        requestBody = {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: [{
            function_declarations: functions.map(f => ({
              name: f.name,
              description: f.description,
              parameters: f.parameters
            }))
          }],
          generationConfig: { maxOutputTokens: 4096 }
        };
        
      } else if (provider === 'openrouter') {
        const openrouterKeys = await readKey('openrouterKeys') || {};
        const keyEntries = Object.entries(openrouterKeys);
        if (!keyEntries.length) throw new Error('No OpenRouter API keys configured');
        apiKey = keyEntries[0][0];
        apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
        headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': "https://github.com/viralcloner/ViralCloner",
          'X-Title': 'ViralCloner'
        };
        
        const orModel = model || 'openai/gpt-5.2';
        // Models that don't support custom temperature (reasoning models only)
        const noCustomTemperature = orModel.startsWith('openai/') && /o[134]-|o[134]$/.test(orModel);
        requestBody = {
          model: orModel,
          messages: [
            { role: 'system', content: systemPrompt },
            ...cleanMessages
          ],
          stream: true,
          tools: functions.map(f => ({ type: 'function', function: f })),
          tool_choice: 'auto',
          max_completion_tokens: 4096
        };
        if (!noCustomTemperature) requestBody.temperature = 0.7;
        
      } else if (provider === 'qwenbrowser') {
        const qwenProfiles = await readKey('qwenBrowserProfiles') || {};
        const connectedQwenIds = Object.keys(qwenProfiles).filter(id => qwenProfiles[id]?.status === 'connected');
        if (!connectedQwenIds.length) throw new Error('No Qwen Browser profile connected. Please connect an account in Settings.');
        const qwenProfileId = connectedQwenIds[0];
        const qwenProfile = qwenProfiles[qwenProfileId];
        apiUrl = 'https://qwen.aikit.club/v1/chat/completions';
        headers = {
          'Content-Type': 'application/json',
          'authorization': `Bearer ${qwenProfile.token}`,
          'cookie': qwenProfile.cookies || '',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          'origin': 'https://chat.qwen.ai',
          'referer': 'https://chat.qwen.ai/'
        };
        // Convert messages to plain format - qwenbrowser proxy (qwen.aikit.club) doesn't support
        // native OpenAI tool calling. We use text-based tool calls via system prompt instead.
        const qwenMessages = [];
        let originalUserTask = '';
        for (const msg of cleanMessages) {
          if (msg.role === 'tool') {
            // Convert tool result to a user message (compatible with Qwen)
            try {
              const result = JSON.parse(msg.content);
              qwenMessages.push({
                role: 'user',
                content: `[Tool result for ${msg.name}]: ${JSON.stringify(result)}`
              });
            } catch {
              qwenMessages.push({ role: 'user', content: `[Tool result for ${msg.name}]: ${msg.content}` });
            }
          } else if (msg.role === 'assistant' && msg.tool_calls) {
            // Represent tool calls as text so Qwen understands the conversation history
            const tcText = msg.tool_calls.map(tc =>
              `<tool_call>{"name": "${tc.function?.name}", "arguments": ${tc.function?.arguments}}</tool_call>`
            ).join('\n');
            qwenMessages.push({
              role: 'assistant',
              content: (msg.content ? msg.content + '\n' : '') + tcText
            });
          } else if (msg.content !== null && msg.content !== undefined) {
            qwenMessages.push({ role: msg.role, content: msg.content });
            // Track the first real user message as the original task
            if (msg.role === 'user' && !originalUserTask && !String(msg.content).startsWith('[Tool result')) {
              originalUserTask = typeof msg.content === 'string' ? msg.content : (msg.content?.[0]?.text || '');
            }
          }
        }
        // If this is a continuation turn (has tool results), inject a task reminder at the end
        // to prevent Qwen from losing context of the original task
        const hasToolResults = qwenMessages.some(m => m.role === 'user' && String(m.content).startsWith('[Tool result'));
        if (hasToolResults && originalUserTask) {
          // Detect if the most recent tool result was clear_canvas — if so, give a very specific
          // instruction to prevent Qwen from looping and calling clear_canvas again
          const lastToolResultMsg = [...qwenMessages].reverse().find(m =>
            m.role === 'user' && String(m.content).startsWith('[Tool result')
          );
          const lastToolName = lastToolResultMsg
            ? (String(lastToolResultMsg.content).match(/^\[Tool result for (\w+)\]/) || [])[1]
            : null;

          let reminderContent;
          if (lastToolName === 'clear_canvas') {
            // Parse keptNodes from result so the AI has exact IDs
            let keptNodesInfo = '';
            try {
              const rawResult = String(lastToolResultMsg.content).replace(/^\[Tool result for clear_canvas\]: /, '');
              const resultJson = JSON.parse(rawResult);
              // Result is wrapped: {success: true, result: {cleared, keptNodes, nextNodeId}}
              const inner = resultJson.result || resultJson;
              if (inner.keptNodes) {
                const keptStr = Object.entries(inner.keptNodes)
                  .map(([type, id]) => `${type}(nodeId=${id})`)
                  .join(', ');
                keptNodesInfo = ` Existing nodes (use these exact numbers in connect_nodes): ${keptStr}. Next new node will get ID=${inner.nextNodeId}. CRITICAL: nodeId is ALWAYS a plain number string like "${inner.nextNodeId}" — NEVER "ID${inner.nextNodeId}", "input", or "facebook-output".`;
              }
            } catch {}
            reminderContent = `✅ CANVAS IS CLEARED. ${keptNodesInfo} Task: "${originalUserTask.substring(0, 200)}". STEP 2: Emit ONLY add_node calls now — one per node, NO connect_nodes yet. Each add_node result will return a "ports" map with exact input/output IDs. After ALL add_node results come back, you will connect them in Step 3.`;
          } else if (lastToolName === 'add_node') {
            reminderContent = `STEP 3: All nodes added. Now emit ALL connect_nodes calls using the exact port IDs (id field) from the add_node results above, then auto_layout. Task: "${originalUserTask.substring(0, 200)}".
REMINDER: If some nodes are still missing, add them first (more add_node calls), then connect everything in one final turn.`;
          } else {
            reminderContent = `REMINDER: Task in progress: "${originalUserTask.substring(0, 200)}". Continue: if nodes are not all added yet → add them. If all nodes are added → connect them all and call auto_layout.`;
          }

          qwenMessages.push({
            role: 'user',
            content: reminderContent
          });
        }
        requestBody = {
          model: model || 'qwen3.7-plus',
          messages: [
            { role: 'system', content: systemPrompt },
            ...qwenMessages
          ],
          stream: true,
          enable_thinking: false,
          temperature: 0.7,
          max_tokens: 4096
          // No tools parameter - using text-based tool calling via system prompt
        };

      } else if (provider === 'deepseekbrowser') {
        // DeepSeek Browser: calls the internal deepseekBrowser() function directly (no streaming HTTP).
        // Uses the same text-based <tool_call> format as qwenbrowser.
        const { deepseekBrowser: deepseekBrowserFn } = require('../automations/deepseekBrowser');
        const dsProfiles = await readKey('deepseekBrowserProfiles') || {};
        const connectedDsIds = Object.keys(dsProfiles).filter(id => dsProfiles[id]?.status === 'connected');
        if (!connectedDsIds.length) throw new Error('No DeepSeek Browser profile connected. Please connect an account in Settings.');

        // Build the same flat message history as qwenbrowser (tool results → user messages)
        const dsMessages = [];
        let dsOriginalTask = '';
        for (const msg of cleanMessages) {
          if (msg.role === 'tool') {
            try {
              const r = JSON.parse(msg.content);
              dsMessages.push({ role: 'user', content: `[Tool result for ${msg.name}]: ${JSON.stringify(r)}` });
            } catch {
              dsMessages.push({ role: 'user', content: `[Tool result for ${msg.name}]: ${msg.content}` });
            }
          } else if (msg.role === 'assistant' && msg.tool_calls) {
            const tcText = msg.tool_calls.map(tc =>
              `<tool_call>{"name": "${tc.function?.name}", "arguments": ${tc.function?.arguments}}</tool_call>`
            ).join('\n');
            dsMessages.push({ role: 'assistant', content: (msg.content ? msg.content + '\n' : '') + tcText });
          } else if (msg.content !== null && msg.content !== undefined) {
            dsMessages.push({ role: msg.role, content: msg.content });
            if (msg.role === 'user' && !dsOriginalTask && !String(msg.content).startsWith('[Tool result')) {
              dsOriginalTask = typeof msg.content === 'string' ? msg.content : (msg.content?.[0]?.text || '');
            }
          }
        }

        // Inject task reminder (same logic as qwenbrowser)
        const dsHasToolResults = dsMessages.some(m => m.role === 'user' && String(m.content).startsWith('[Tool result'));
        if (dsHasToolResults && dsOriginalTask) {
          const dsLastToolResultMsg = [...dsMessages].reverse().find(m =>
            m.role === 'user' && String(m.content).startsWith('[Tool result')
          );
          const dsLastToolName = dsLastToolResultMsg
            ? (String(dsLastToolResultMsg.content).match(/^\[Tool result for (\w+)\]/) || [])[1]
            : null;
          let dsReminderContent;
          if (dsLastToolName === 'clear_canvas') {
            let keptNodesInfo = '';
            try {
              const rawResult = String(dsLastToolResultMsg.content).replace(/^\[Tool result for clear_canvas\]: /, '');
              const resultJson = JSON.parse(rawResult);
              const inner = resultJson.result || resultJson;
              if (inner.keptNodes) {
                const keptStr = Object.entries(inner.keptNodes).map(([type, id]) => `${type}(nodeId=${id})`).join(', ');
                keptNodesInfo = ` Existing nodes: ${keptStr}. Next new node will get ID=${inner.nextNodeId}. CRITICAL: nodeId is ALWAYS a plain number string like "${inner.nextNodeId}" — NEVER "ID${inner.nextNodeId}".`;
              }
            } catch {}
            dsReminderContent = `✅ CANVAS IS CLEARED. ${keptNodesInfo} Task: "${dsOriginalTask.substring(0, 200)}". STEP 2: Emit ONLY add_node calls now — one per node, NO connect_nodes yet. Each add_node result will return a "ports" map with exact input/output IDs. After ALL add_node results come back, connect them in Step 3.`;
          } else if (dsLastToolName === 'add_node') {
            dsReminderContent = `STEP 3: All nodes added. Now emit ALL connect_nodes calls using the exact port IDs (id field) from the add_node results above, then auto_layout. Task: "${dsOriginalTask.substring(0, 200)}".
If some nodes are still missing, add them first, then connect everything.`;
          } else {
            dsReminderContent = `REMINDER: Task in progress: "${dsOriginalTask.substring(0, 200)}". Continue: if nodes are not all added yet → add them. If all nodes are added → connect them all and call auto_layout.`;
          }
          dsMessages.push({ role: 'user', content: dsReminderContent });
        }

        // Build a single prompt string: system prompt + conversation history
        const dsFullPrompt = systemPrompt + '\n\n' +
          dsMessages.map(m => {
            const role = m.role === 'assistant' ? 'Assistant' : 'User';
            return `${role}: ${m.content}`;
          }).join('\n\n') + '\n\nAssistant:';

        // Send a thinking indicator chunk
        mainWindow?.webContents.send('automation-agent-chunk', { chunk: '', done: false });

        const dsResult = await deepseekBrowserFn(dsFullPrompt, false, false);
        if (!dsResult.success) throw new Error(dsResult.value || 'DeepSeek Browser returned an error');

        let dsResponse = dsResult.value || '';
        const { toolCalls: dsToolCalls, cleanedText: dsCleanedText } = parseQwenTextToolCalls(dsResponse);
        dsResponse = dsCleanedText;

        const estimatedInputTokens = Math.ceil(dsFullPrompt.length / 4);
        const estimatedOutputTokens = Math.ceil(dsResponse.length / 4);
        trackAIUsage('deepseekbrowser', model, {
          prompt_tokens: estimatedInputTokens,
          completion_tokens: estimatedOutputTokens,
          total_tokens: estimatedInputTokens + estimatedOutputTokens
        }, 'text', 'automation-agent').catch(() => {});

        mainWindow?.webContents.send('automation-agent-chunk', {
          done: true,
          fullResponse: dsResponse,
          toolCalls: dsToolCalls.length > 0 ? dsToolCalls : null,
          failedToolCalls: null
        });
        return { success: true, streaming: true };

      } else {
        throw new Error(`Unknown provider: ${provider}`);
      }

      // Log request size for cost monitoring
      const requestSize = JSON.stringify(requestBody).length;
      const estimatedTokens = Math.ceil(requestSize / 4);
      console.log(`[Automation Agent] Starting stream with ${provider}/${model}`);
      console.log(`[Automation Agent] Request size: ${requestSize} chars (~${estimatedTokens} tokens est.)`);
      console.log(`[Automation Agent] Messages count: ${cleanMessages.length}`);
      
      // Retry logic for network errors
      const MAX_RETRIES = 3;
      let response;
      let lastError;
      
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // Check if aborted before each attempt
          if (abortController.signal.aborted) {
            throw new Error('Agent stopped by user');
          }
          
          response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            timeout: 60000, // 60 second timeout
            signal: abortController.signal
          });
          break; // Success, exit retry loop
        } catch (fetchError) {
          lastError = fetchError;
          const isRetryable = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(fetchError.code);
          
          if (isRetryable && attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s
            console.log(`[Automation Agent] Network error (${fetchError.code}), retrying in ${delay}ms... (attempt ${attempt}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw fetchError;
          }
        }
      }
      
      if (!response) {
        throw lastError || new Error('Failed to connect to API');
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Automation Agent] API error:`, errorText);
        if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later or check your API billing.');
        }
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      // Estimate input tokens (rough estimate: ~4 chars per token for English text)
      const inputText = JSON.stringify(requestBody);
      const estimatedInputTokens = Math.ceil(inputText.length / 4);

      // Stream response with tool call handling
      let fullResponse = '';
      let doneSent = false;
      let currentToolCalls = [];
      let failedToolCalls = [];  // Track tool calls that failed to parse
      let currentToolCallId = null;
      let currentToolCallName = null;
      let currentToolCallArgs = '';
      let chunkCount = 0;
      let sseBuffer = '';  // Buffer for incomplete SSE data
      let qwenDetailsBuffer = '';  // Buffer to suppress <details> thinking blocks mid-stream
      let qwenInDetails = false;   // Whether we're currently inside a <details> block
      const reader = response.body;

      // Listen for abort signal to properly clean up and notify frontend
      abortController.signal.addEventListener('abort', () => {
        if (!doneSent) {
          doneSent = true;
          activeAgentAbortController = null;
          console.log('[Automation Agent] Abort signal received, sending stopped message');
          mainWindow?.webContents.send('automation-agent-chunk', { 
            error: 'Agent stopped by user',
            stopped: true,
            done: true 
          });
          // Destroy the reader to stop processing
          reader.destroy();
        }
      });

      reader.on('data', (chunk) => {
        chunkCount++;
        const text = chunk.toString();
        
        // Append to buffer
        sseBuffer += text;
        
        // Process complete lines from buffer
        const lines = sseBuffer.split('\n');
        
        // Keep the last incomplete line in buffer
        sseBuffer = lines.pop() || '';
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6);
            if (data === '[DONE]') {
              if (!doneSent) {
                doneSent = true;
                console.log(`[Automation Agent] Stream complete. Response length: ${fullResponse.length}, Tool calls: ${currentToolCalls.length}, Failed: ${failedToolCalls.length}`);
                if (currentToolCalls.length > 0) {
                  console.log('[Automation Agent] Successful tool calls:', currentToolCalls.map(tc => tc.name));
                }
                if (failedToolCalls.length > 0) {
                  console.log('[Automation Agent] Failed tool calls:', failedToolCalls);
                }
                // Strip Qwen <details>...</details> thinking blocks from final response
                if (provider === 'qwenbrowser') {
                  // Flush any safe buffered content that never got emitted
                  if (qwenDetailsBuffer && !qwenInDetails) {
                    mainWindow?.webContents.send('automation-agent-chunk', { chunk: qwenDetailsBuffer, done: false });
                    qwenDetailsBuffer = '';
                  }
                  fullResponse = fullResponse.replace(/<details[\s\S]*?<\/details>/gi, '').trim();
                  // Parse text-based tool calls (proxy doesn't support native function calling)
                  if (currentToolCalls.length === 0) {
                    const { toolCalls: textToolCalls, cleanedText } = parseQwenTextToolCalls(fullResponse);
                    if (textToolCalls.length > 0) {
                      console.log(`[Automation Agent] Extracted ${textToolCalls.length} text-based tool call(s) from qwenbrowser response`);
                      currentToolCalls.push(...textToolCalls);
                      fullResponse = cleanedText;
                    }
                  }
                }
                // Send final message with any pending tool calls
                mainWindow?.webContents.send('automation-agent-chunk', { 
                  done: true, 
                  fullResponse,
                  toolCalls: currentToolCalls.length > 0 ? currentToolCalls : null,
                  failedToolCalls: failedToolCalls.length > 0 ? failedToolCalls : null
                });
                
                // Track AI usage for the automation agent (estimate output tokens)
                const estimatedOutputTokens = Math.ceil(fullResponse.length / 4);
                const totalTokens = estimatedInputTokens + estimatedOutputTokens;
                console.log(`[Automation Agent] Tracking usage: ${provider}/${model} - input: ${estimatedInputTokens}, output: ${estimatedOutputTokens}, total: ${totalTokens}`);
                trackAIUsage(provider, model, {
                  prompt_tokens: estimatedInputTokens,
                  completion_tokens: estimatedOutputTokens,
                  total_tokens: totalTokens
                }, 'text', 'automation-agent').catch(err => {
                  console.error('[Automation Agent] Failed to track usage:', err.message);
                });
              }
              return;
            }
            
            try {
              const json = JSON.parse(data);
              let content = '';
              let toolCallDelta = null;
              
              if (provider === 'openai' || provider === 'openrouter' || provider === 'qwenbrowser') {
                const delta = json.choices?.[0]?.delta;
                // Skip Qwen thinking/reasoning content
                if (provider === 'qwenbrowser' && typeof delta?.reasoning_content === 'string') {
                  content = '';
                } else {
                  content = delta?.content || '';
                }
                
                // Handle tool calls
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.id) {
                      // New tool call started
                      if (currentToolCallId && currentToolCallName) {
                        // Save previous tool call
                        const parsedArgs = tryParseToolArgs(currentToolCallArgs, currentToolCallName);
                        if (parsedArgs) {
                          currentToolCalls.push({
                            id: currentToolCallId,
                            name: currentToolCallName,
                            arguments: parsedArgs
                          });
                        } else {
                          failedToolCalls.push({ name: currentToolCallName, rawArgs: currentToolCallArgs.substring(0, 200) });
                        }
                      }
                      currentToolCallId = tc.id;
                      currentToolCallName = tc.function?.name || '';
                      currentToolCallArgs = tc.function?.arguments || '';
                    } else if (tc.function?.arguments) {
                      currentToolCallArgs += tc.function.arguments;
                    }
                  }
                }
                
                // Check if this is the end and we have a pending tool call
                if (json.choices?.[0]?.finish_reason === 'tool_calls' || json.choices?.[0]?.finish_reason === 'stop') {
                  if (currentToolCallId && currentToolCallName) {
                    const parsedArgs = tryParseToolArgs(currentToolCallArgs, currentToolCallName);
                    if (parsedArgs) {
                      currentToolCalls.push({
                        id: currentToolCallId,
                        name: currentToolCallName,
                        arguments: parsedArgs
                      });
                    } else {
                      failedToolCalls.push({ name: currentToolCallName, rawArgs: currentToolCallArgs.substring(0, 200) });
                    }
                    currentToolCallId = null;
                    currentToolCallName = null;
                    currentToolCallArgs = '';
                  }
                }
                
              } else if (provider === 'anthropic') {
                if (json.type === 'content_block_delta') {
                  if (json.delta?.type === 'text_delta') {
                    content = json.delta?.text || '';
                  } else if (json.delta?.type === 'input_json_delta') {
                    currentToolCallArgs += json.delta?.partial_json || '';
                  }
                } else if (json.type === 'content_block_start') {
                  if (json.content_block?.type === 'tool_use') {
                    currentToolCallId = json.content_block.id;
                    currentToolCallName = json.content_block.name;
                    currentToolCallArgs = '';
                  }
                } else if (json.type === 'content_block_stop') {
                  if (currentToolCallId && currentToolCallName) {
                    const parsedArgs = tryParseToolArgs(currentToolCallArgs, currentToolCallName);
                    if (parsedArgs) {
                      currentToolCalls.push({
                        id: currentToolCallId,
                        name: currentToolCallName,
                        arguments: parsedArgs
                      });
                    } else {
                      failedToolCalls.push({ name: currentToolCallName, rawArgs: currentToolCallArgs.substring(0, 200) });
                    }
                    currentToolCallId = null;
                    currentToolCallName = null;
                    currentToolCallArgs = '';
                  }
                }
                
              } else if (provider === 'googleai') {
                const candidate = json.candidates?.[0];
                const part = candidate?.content?.parts?.[0];
                if (part?.text) {
                  content = part.text;
                } else if (part?.functionCall) {
                  currentToolCalls.push({
                    id: `gemini-${Date.now()}`,
                    name: part.functionCall.name,
                    arguments: part.functionCall.args || {}
                  });
                }
              }
              
              if (content) {
                fullResponse += content;
                // For Qwen: suppress <details>...</details> thinking blocks from streaming chunks
                let emitContent = content;
                if (provider === 'qwenbrowser') {
                  qwenDetailsBuffer += content;
                  // Check if we're entering or inside a <details> block
                  if (!qwenInDetails && qwenDetailsBuffer.includes('<details')) {
                    qwenInDetails = true;
                  }
                  if (qwenInDetails) {
                    // Check if the block has closed
                    if (qwenDetailsBuffer.includes('</details>')) {
                      // Strip all complete <details> blocks from the buffer
                      qwenDetailsBuffer = qwenDetailsBuffer.replace(/<details[\s\S]*?<\/details>/gi, '');
                      qwenInDetails = qwenDetailsBuffer.includes('<details');
                      // Emit whatever safe content remains after stripping
                      emitContent = qwenDetailsBuffer;
                      qwenDetailsBuffer = '';
                    } else {
                      // Still inside the block - suppress
                      emitContent = '';
                    }
                  } else {
                    emitContent = qwenDetailsBuffer;
                    qwenDetailsBuffer = '';
                  }
                }
                if (emitContent) {
                  mainWindow?.webContents.send('automation-agent-chunk', { 
                    chunk: emitContent, 
                    done: false 
                  });
                }
              }
              
            } catch (e) {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      });

      reader.on('end', () => {
        // Process any remaining data in buffer
        if (sseBuffer.trim()) {
          const trimmedLine = sseBuffer.trim();
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6);
            if (data !== '[DONE]') {
              try {
                const json = JSON.parse(data);
                // Handle any final content or tool calls
                if (provider === 'openai' || provider === 'openrouter' || provider === 'qwenbrowser') {
                  const delta = json.choices?.[0]?.delta;
                  if (delta?.content) {
                    fullResponse += delta.content;
                  }
                }
              } catch (e) {
                // Ignore
              }
            }
          }
        }
        
        // Finalize any pending tool call
        if (currentToolCallId && currentToolCallName) {
          const parsedArgs = tryParseToolArgs(currentToolCallArgs, currentToolCallName);
          if (parsedArgs) {
            currentToolCalls.push({
              id: currentToolCallId,
              name: currentToolCallName,
              arguments: parsedArgs
            });
          } else {
            failedToolCalls.push({ name: currentToolCallName, rawArgs: currentToolCallArgs.substring(0, 200) });
          }
        }
        
        if (!doneSent) {
          doneSent = true;
          activeAgentAbortController = null; // Cleanup
          console.log(`[Automation Agent] Stream ended. Response length: ${fullResponse.length}, Tool calls: ${currentToolCalls.length}, Failed: ${failedToolCalls.length}`);
          // Parse text-based tool calls for qwenbrowser at stream end
          if ((provider === 'qwenbrowser' || provider === 'deepseekbrowser') && currentToolCalls.length === 0) {
            fullResponse = fullResponse.replace(/<details[\s\S]*?<\/details>/gi, '').trim();
            const { toolCalls: textToolCalls, cleanedText } = parseQwenTextToolCalls(fullResponse);
            if (textToolCalls.length > 0) {
              console.log(`[Automation Agent] Extracted ${textToolCalls.length} text-based tool call(s) from qwenbrowser stream-end response`);
              currentToolCalls.push(...textToolCalls);
              fullResponse = cleanedText;
            }
          }
          mainWindow?.webContents.send('automation-agent-chunk', { 
            done: true, 
            fullResponse,
            toolCalls: currentToolCalls.length > 0 ? currentToolCalls : null,
            failedToolCalls: failedToolCalls.length > 0 ? failedToolCalls : null
          });
          
          // Track AI usage for the automation agent (estimate output tokens)
          const estimatedOutputTokens = Math.ceil(fullResponse.length / 4);
          const totalTokens = estimatedInputTokens + estimatedOutputTokens;
          console.log(`[Automation Agent] Tracking usage (end): ${provider}/${model} - input: ${estimatedInputTokens}, output: ${estimatedOutputTokens}, total: ${totalTokens}`);
          trackAIUsage(provider, model, {
            prompt_tokens: estimatedInputTokens,
            completion_tokens: estimatedOutputTokens,
            total_tokens: totalTokens
          }, 'text', 'automation-agent').catch(err => {
            console.error('[Automation Agent] Failed to track usage:', err.message);
          });
        }
      });

      reader.on('error', (error) => {
        console.error('[Automation Agent] Stream error:', error);
        activeAgentAbortController = null; // Cleanup
        if (!doneSent) {
          doneSent = true;
          
          // Check if aborted by user
          if (error.name === 'AbortError') {
            mainWindow?.webContents.send('automation-agent-chunk', { 
              error: 'Agent stopped by user',
              stopped: true,
              done: true 
            });
            return;
          }
          
          // Check if it's a retryable network error
          const isNetworkError = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(error.code);
          const errorMessage = isNetworkError 
            ? `Network error (${error.code}). The connection was interrupted. Please try again.`
            : error.message;
          
          mainWindow?.webContents.send('automation-agent-chunk', { 
            error: errorMessage,
            isRetryable: isNetworkError,
            done: true 
          });
        }
      });

      return { success: true, streaming: true };
    } catch (error) {
      activeAgentAbortController = null; // Cleanup
      
      // Check if aborted by user
      if (error.name === 'AbortError') {
        console.log('[Automation Agent] Stopped by user');
        return { success: false, error: 'Agent stopped by user', stopped: true };
      }
      
      console.error('[Automation Agent] Error:', error);
      
      // Check if it's a retryable network error
      const isNetworkError = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code);
      
      return { 
        success: false, 
        error: isNetworkError 
          ? `Network error (${error.code}). Please check your connection and try again.`
          : error.message,
        isRetryable: isNetworkError
      };
    }
  });

  // ============================================
  // VIRALCLONER AI (VCAI) IPC HANDLERS
  // ============================================


  /**
   * Call ViralCloner AI bridge API
   */
  ipcMain.handle("vcai-chat-completion", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  /**
   * Get VCAI usage stats for current user
   */
  ipcMain.handle("vcai-get-usage", async () => ({ success: true, disabled: true }));

  /**
   * Check VCAI health status
   */
  ipcMain.handle("vcai-health", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

  // ============================================
  // PROFILE 2FA MANAGEMENT
  // ============================================

/**
   * Generate a new TOTP secret for a profile
   * Returns the secret (encrypted) and QR code URL
   */
  ipcMain.handle("generate-totp-secret", async (_, profileLabel) => {
    try {

      // Generate a random secret
      const secret = new Secret({ size: 20 });
      
      // Create TOTP instance to get the URL
      const totp = new TOTP({
        issuer: "ViralCloner",
        label: profileLabel || "Profile",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: secret,
      });

      // Encrypt the secret for storage
      const encryptedSecret = encrypt(secret.base32).toString("base64");

      return {
        success: true,
        encryptedSecret: encryptedSecret,
        qrCodeUrl: totp.toString(),
        secretBase32: secret.base32, // For manual entry fallback
      };
    } catch (err) {
      console.error("[2FA] Generate secret error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get current TOTP code from an encrypted secret
   */
  ipcMain.handle("get-totp-code", async (_, encryptedSecret) => {
    try {
      // Decrypt the secret
      const secretBuffer = Buffer.from(encryptedSecret, "base64");
      const secretBase32 = decrypt(secretBuffer);

      // Create TOTP instance
      const totp = new TOTP({
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: Secret.fromBase32(secretBase32),
      });

      // Generate current code
      const code = totp.generate();
      
      // Calculate time remaining in current period
      const now = Math.floor(Date.now() / 1000);
      const remaining = 30 - (now % 30);

      return {
        success: true,
        code: code,
        remaining: remaining,
      };
    } catch (err) {
      console.error("[2FA] Get code error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Verify a TOTP code against an encrypted secret
   */
  ipcMain.handle("verify-totp-code", async (_, encryptedSecret, code) => {
    try {
      // Decrypt the secret
      const secretBuffer = Buffer.from(encryptedSecret, "base64");
      const secretBase32 = decrypt(secretBuffer);

      // Create TOTP instance
      const totp = new TOTP({
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: Secret.fromBase32(secretBase32),
      });

      // Validate with window of 1 (allows previous and next period)
      const delta = totp.validate({ token: code, window: 1 });

      return {
        success: delta !== null,
        error: delta === null ? "Invalid code" : null,
      };
    } catch (err) {
      console.error("[2FA] Verify code error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Save 2FA entry to a profile (profile can have multiple 2FA entries)
   */
  ipcMain.handle("save-profile-totp", async (_, structureId, profileId, entryId, name, encryptedSecret) => {
    try {
      const structures = await readKey("structures") || {};
      
      if (!structures[structureId]) {
        return { success: false, error: "Structure not found" };
      }

      if (!structures[structureId].profiles || !structures[structureId].profiles[profileId]) {
        return { success: false, error: "Profile not found" };
      }

      // Initialize tofaEntries array if doesn't exist
      if (!structures[structureId].profiles[profileId].tofaEntries) {
        structures[structureId].profiles[profileId].tofaEntries = [];
      }

      // Check if entry already exists (update) or add new
      const existingIndex = structures[structureId].profiles[profileId].tofaEntries.findIndex(e => e.id === entryId);
      
      if (existingIndex >= 0) {
        // Update existing entry
        structures[structureId].profiles[profileId].tofaEntries[existingIndex] = {
          id: entryId,
          name: name,
          encryptedSecret: encryptedSecret
        };
      } else {
        // Add new entry
        structures[structureId].profiles[profileId].tofaEntries.push({
          id: entryId,
          name: name,
          encryptedSecret: encryptedSecret
        });
      }
      
      await updateData("structures", structures);
      
      return { success: true };
    } catch (err) {
      console.error("[2FA] Save profile totp error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Remove a 2FA entry from a profile
   */
  ipcMain.handle("remove-profile-totp", async (_, structureId, profileId, entryId) => {
    try {
      const structures = await readKey("structures") || {};
      
      if (!structures[structureId]) {
        return { success: false, error: "Structure not found" };
      }

      if (!structures[structureId].profiles || !structures[structureId].profiles[profileId]) {
        return { success: false, error: "Profile not found" };
      }

      if (!structures[structureId].profiles[profileId].tofaEntries) {
        return { success: true }; // Nothing to remove
      }

      structures[structureId].profiles[profileId].tofaEntries = structures[structureId].profiles[profileId].tofaEntries.filter(e => e.id !== entryId);
      
      await updateData("structures", structures);
      
      return { success: true };
    } catch (err) {
      console.error("[2FA] Remove profile totp error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Move a profile between structures while preserving its stable profile ID
   * and all profile-owned data (browser session, proxy, fingerprint, 2FA, etc.).
   */
  ipcMain.handle("transfer-structure-profile", async (_, sourceStructureId, targetStructureId, profileId) => {
    try {
      if (![sourceStructureId, targetStructureId, profileId].every(id => typeof id === "string" && id.trim())) {
        return { success: false, error: "Invalid transfer request" };
      }

      if (sourceStructureId === targetStructureId) {
        return { success: false, error: "Source and destination structures must be different" };
      }

      const structures = (await readKey("structures")) || {};
      const sourceStructure = structures[sourceStructureId];
      const targetStructure = structures[targetStructureId];

      if (!sourceStructure || !targetStructure) {
        return { success: false, error: "Source or destination structure not found" };
      }

      const profile = sourceStructure.profiles?.[profileId];
      if (!profile) {
        return { success: false, error: "Profile not found in the source structure" };
      }

      if (!targetStructure.profiles || typeof targetStructure.profiles !== "object") {
        targetStructure.profiles = {};
      }
      if (targetStructure.profiles[profileId]) {
        return { success: false, error: "A profile with this ID already exists in the destination structure" };
      }

      targetStructure.profiles[profileId] = profile;
      delete sourceStructure.profiles[profileId];
      await updateData("structures", structures);

      const warnings = [];

      // Pinterest accounts address profiles by both structure and profile ID.
      try {
        const pinterestAccounts = (await readKey("pinterestAccounts")) || {};
        let pinterestChanged = false;
        for (const account of Object.values(pinterestAccounts)) {
          if (account?.linkedStructureId === sourceStructureId && account?.linkedProfileId === profileId) {
            account.linkedStructureId = targetStructureId;
            pinterestChanged = true;
          }
        }
        if (pinterestChanged) {
          await updateData("pinterestAccounts", pinterestAccounts);
        }
      } catch (err) {
        console.error("[Structures] Failed to update Pinterest references after profile transfer:", err.message);
        warnings.push("Some Pinterest account links could not be updated");
      }

      // Facebook Groups stores the structure alongside the stable profile ID.
      try {
        fbGroupsDb.moveProfileToStructure(
          profileId,
          sourceStructureId,
          targetStructureId,
          targetStructure.label || ""
        );
      } catch (err) {
        console.error("[Structures] Failed to update Facebook Groups references after profile transfer:", err.message);
        warnings.push("Some Facebook Groups links could not be updated");
      }

      console.log(`[Structures] Transferred profile ${profileId} from ${sourceStructureId} to ${targetStructureId}`);
      return { success: true, warnings };
    } catch (err) {
      console.error("[Structures] Profile transfer error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Encrypt a raw Base32 TOTP secret (for importing existing secrets)
   * Also validates the secret format
   */
  ipcMain.handle("encrypt-totp-secret", async (_, rawSecretBase32) => {
    try {
      // Validate Base32 format
      const cleanSecret = rawSecretBase32.toUpperCase().replace(/\s/g, '');
      if (!/^[A-Z2-7]+=*$/.test(cleanSecret)) {
        return { success: false, error: "Invalid Base32 secret format" };
      }

      // Verify it can create a valid TOTP
      try {
        const secret = Secret.fromBase32(cleanSecret);
        const totp = new TOTP({
          algorithm: "SHA1",
          digits: 6,
          period: 30,
          secret: secret,
        });
        // Generate a test code to validate
        totp.generate();
      } catch (e) {
        return { success: false, error: "Invalid TOTP secret" };
      }

      // Encrypt the secret for storage
      const encryptedSecret = encrypt(cleanSecret).toString("base64");

      return { success: true, encryptedSecret: encryptedSecret };
    } catch (err) {
      console.error("[2FA] Encrypt secret error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Decrypt a TOTP secret (for copying the Base32 key)
   */
  ipcMain.handle("decrypt-totp-secret", async (_, encryptedSecret) => {
    try {
      const secretBuffer = Buffer.from(encryptedSecret, "base64");
      const secretBase32 = decrypt(secretBuffer);
      return { success: true, secret: secretBase32 };
    } catch (err) {
      console.error("[2FA] Decrypt secret error:", err.message);
      return { success: false, error: err.message };
    }
  });

  // ============================================
  // SEO Metadata Generation Handlers
  // ============================================

  /**
   * Generate SEO metadata for an image
   * Uses AI vision to analyze image, fetches Google suggestions, generates SEO title
   */
  ipcMain.handle("generate-seo-metadata", async (_, imagePath, settings) => {
    try {
      const { generateSEOMetadata } = require("./seoMetadataGenerator");
      const result = await generateSEOMetadata(imagePath, settings);
      return result;
    } catch (err) {
      console.error("[SEO Metadata] Generate error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Test Google Suggestions fetch with optional proxy
   * Used for settings page testing
   */
  ipcMain.handle("test-google-suggestions", async (_, keyword, proxy) => {
    try {
      const { fetchGoogleSuggestions } = require("./seoMetadataGenerator");
      const suggestions = await fetchGoogleSuggestions(keyword, proxy);
      return { success: true, suggestions };
    } catch (err) {
      console.error("[SEO Metadata] Test suggestions error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Apply SEO metadata to an existing image file
   * Loads the image, injects EXIF SEO fields, and saves back
   */
  ipcMain.handle("apply-seo-metadata-to-image", async (_, imagePath, seoMetadata) => {
    try {
      const { injectExifMetadata } = require("./imageClean");
      const { generateMetadata } = require("./deviceMetadataPresets");
      const fs = require("fs");
      const path = require("path");

      // Read the image
      if (!fs.existsSync(imagePath)) {
        return { success: false, error: "Image file not found" };
      }

      const imageBuffer = fs.readFileSync(imagePath);

      // Check if JPEG (required for EXIF)
      const ext = path.extname(imagePath).toLowerCase();
      if (ext !== ".jpg" && ext !== ".jpeg") {
        return { success: false, error: "SEO metadata can only be applied to JPEG images" };
      }

      // Generate base metadata config (minimal - just for the function signature)
      // We primarily care about the SEO fields
      const metadataConfig = {
        seo: seoMetadata
      };

      // Inject the SEO metadata
      const resultBuffer = await injectExifMetadata(imageBuffer, metadataConfig);

      // Save back to file
      fs.writeFileSync(imagePath, resultBuffer);

      console.log(`[SEO Metadata] Applied SEO metadata to: ${path.basename(imagePath)}`);
      return { success: true };
    } catch (err) {
      console.error("[SEO Metadata] Apply error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Load SEO metadata settings from storage
   */
  ipcMain.handle("get-seo-metadata-settings", async () => {
    try {
      const settings = readKey("seoMetadataSettings") || {
        enabled: false,
        platforms: {
          facebook: true,
          pinterest: true,
        },
        aiProvider: "openai",
      };
      return { success: true, settings };
    } catch (err) {
      console.error("[SEO Metadata] Get settings error:", err.message);
      return { success: false, error: err.message };
    }
  });

  /**
   * Save SEO metadata settings to storage
   */
  ipcMain.handle("save-seo-metadata-settings", async (_, settings) => {
    try {
      updateData("seoMetadataSettings", settings);
      console.log("[SEO Metadata] Settings saved:", JSON.stringify(settings));
      return { success: true };
    } catch (err) {
      console.error("[SEO Metadata] Save settings error:", err.message);
      return { success: false, error: err.message };
    }
  });

  // ============================================
  // VIDEO EDITOR - FFmpeg & Export
  // ============================================

  ipcMain.handle("check-ffmpeg", async () => {
    try {
      const { checkFFmpeg } = require("./ffmpegManager");
      return await checkFFmpeg();
    } catch (err) {
      console.error("[VideoEditor] FFmpeg check error:", err.message);
      return { installed: false, error: err.message };
    }
  });

  ipcMain.handle("download-ffmpeg", async (event) => {
    try {
      const { downloadFFmpeg } = require("./ffmpegManager");
      const result = await downloadFFmpeg((percent, downloadedMB, totalMB) => {
        event.sender.send("ffmpeg-download-progress", percent, downloadedMB, totalMB);
      });
      return { success: true, ...result };
    } catch (err) {
      console.error("[VideoEditor] FFmpeg download error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("export-video", async (event, project, settings) => {
    try {
      const { exportVideo } = require("./videoExporter");
      const result = await exportVideo(project, settings, (percent, currentFrame, totalFrames) => {
        event.sender.send("video-export-progress", percent, currentFrame, totalFrames);
      });
      return result;
    } catch (err) {
      console.error("[VideoEditor] Export error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("cancel-video-export", async () => {
    try {
      const { cancelExport } = require("./videoExporter");
      return cancelExport();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("start-frame-export", async (event, settings) => {
    try {
      const { startFrameExport } = require("./videoExporter");
      return await startFrameExport(settings);
    } catch (err) {
      console.error("[VideoEditor] Start frame export error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("write-export-frame", async (event, frameBuffer) => {
    try {
      const { writeExportFrame } = require("./videoExporter");
      return await writeExportFrame(frameBuffer);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("finish-frame-export", async () => {
    try {
      const { finishFrameExport } = require("./videoExporter");
      return await finishFrameExport();
    } catch (err) {
      console.error("[VideoEditor] Finish frame export error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-video-metadata", async (_, filePath) => {
    try {
      const { getVideoMetadata } = require("./videoExporter");
      return await getVideoMetadata(filePath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("ve-extract-video-frames", async (_, opts) => {
    try {
      const { extractVideoFramesCFR } = require("./videoExporter");
      return await extractVideoFramesCFR(opts);
    } catch (err) {
      console.error("[VideoEditor] Extract video frames error:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("ve-cleanup-extracted-frames", async (_, dir) => {
    try {
      const { cleanupExtractedFrames } = require("./videoExporter");
      return await cleanupExtractedFrames(dir);
    } catch (err) {
      return { success: false };
    }
  });

  // ============================================
  // Audio Transcription (Whisper API)
  // ============================================

  ipcMain.handle("transcribe-audio", async (_, filePath, language) => {
    try {
      const { transcribeAudio } = require("./transcription");
      return await transcribeAudio(filePath, language);
    } catch (err) {
      console.error("[IPC] transcribe-audio error:", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("extract-audio", async (_, videoFilePath) => {
    try {
      const { extractAudio } = require("./transcription");
      return await extractAudio(videoFilePath);
    } catch (err) {
      console.error("[IPC] extract-audio error:", err);
      return { success: false, error: err.message };
    }
  });

  // Receive auto-export result from renderer
  ipcMain.on("ve-auto-export-result", (event, result) => {
    if (_autoExportResolve) {
      _autoExportResolve(result);
      _autoExportResolve = null;
    }
  });

  // ============================================
  // Video Editor Project Export/Import (.vcve)
  // ============================================

  ipcMain.handle(
    "export-video-project",
    async (_, project, defaultFileName) => {
      try {
        const result = await dialog.showSaveDialog({
          title: "Export Video Project",
          defaultPath: `${defaultFileName || project.name || "video-project"}.vcve`,
          filters: [
            {
              name: "ViralCloner Video Editor Project",
              extensions: ["vcve"],
            },
          ],
        });

        if (result.canceled) {
          return { success: false, message: "Export canceled by user" };
        }

        // Collect all media files from tracks/clips
        const media = {};
        if (project.tracks && Array.isArray(project.tracks)) {
          for (const track of project.tracks) {
            if (track.clips && Array.isArray(track.clips)) {
              for (const clip of track.clips) {
                if (
                  clip.source &&
                  typeof clip.source === "string" &&
                  !clip.source.startsWith("data:") &&
                  !media[clip.source]
                ) {
                  try {
                    const fileBuffer = await fs.readFile(clip.source);
                    const ext = path.extname(clip.source).toLowerCase();
                    const mimeMap = {
                      ".jpg": "image/jpeg",
                      ".jpeg": "image/jpeg",
                      ".png": "image/png",
                      ".gif": "image/gif",
                      ".webp": "image/webp",
                      ".svg": "image/svg+xml",
                      ".mp4": "video/mp4",
                      ".webm": "video/webm",
                      ".mp3": "audio/mpeg",
                      ".wav": "audio/wav",
                      ".ogg": "audio/ogg",
                      ".aac": "audio/aac",
                    };
                    const mime = mimeMap[ext] || "application/octet-stream";
                    media[clip.source] = `data:${mime};base64,${fileBuffer.toString("base64")}`;
                  } catch (readErr) {
                    console.warn(
                      `[VideoEditor] Could not read media file: ${clip.source}`,
                      readErr.message,
                    );
                  }
                }
              }
            }
          }
        }

        const exportData = {
          type: "vcve_project",
          version: 1,
          project,
          media,
          exportedAt: new Date().toISOString(),
        };

        const encryptedData = encryptPortable(JSON.stringify(exportData));
        await fs.writeFile(result.filePath, encryptedData);

        return { success: true, filePath: result.filePath };
      } catch (error) {
        console.error("[VideoEditor] Export project error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle("import-video-project", async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: "Import Video Project",
        filters: [
          {
            name: "ViralCloner Video Editor Project",
            extensions: ["vcve"],
          },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });

      if (result.canceled) {
        return { success: false, message: "Import canceled by user" };
      }

      const filePath = result.filePaths[0];
      const encryptedData = await fs.readFile(filePath);
      const decryptedData = decryptAutomation(encryptedData);
      const parsedData = JSON.parse(decryptedData);

      if (parsedData.type !== "vcve_project") {
        throw new Error("Invalid video project file format");
      }

      const project = parsedData.project;
      const media = parsedData.media || {};

      // Extract embedded media to userData/VideoMedia/
      const mediaDir = path.join(app.getPath("userData"), "VideoMedia");
      if (!fss.existsSync(mediaDir)) {
        fss.mkdirSync(mediaDir, { recursive: true });
      }

      if (project.tracks && Array.isArray(project.tracks)) {
        for (const track of project.tracks) {
          if (track.clips && Array.isArray(track.clips)) {
            for (const clip of track.clips) {
              if (clip.source && media[clip.source]) {
                const dataUrl = media[clip.source];
                const matches = dataUrl.match(
                  /^data:([^;]+);base64,(.+)$/,
                );
                if (matches) {
                  const ext =
                    path.extname(clip.source) ||
                    "." + matches[1].split("/")[1];
                  const hash = crypto
                    .createHash("md5")
                    .update(matches[2].substring(0, 1000) + clip.source)
                    .digest("hex");
                  const newFileName = `${hash}${ext}`;
                  const newPath = path.join(mediaDir, newFileName);

                  if (!fss.existsSync(newPath)) {
                    const buffer = Buffer.from(matches[2], "base64");
                    await fs.writeFile(newPath, buffer);
                  }
                  clip.source = newPath;
                }
              }
            }
          }
        }
      }

      // Generate new ID to avoid collisions
      project.id = crypto.randomUUID();
      project.name = (project.name || "Project") + " (imported)";

      return { success: true, projects: [project] };
    } catch (error) {
      console.error("[VideoEditor] Import project error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "prepare-video-project-for-share",
    async (_, project) => {
      try {
        // Embed media as base64 (no encryption — chat handles transport)
        const media = {};
        if (project.tracks && Array.isArray(project.tracks)) {
          for (const track of project.tracks) {
            if (track.clips && Array.isArray(track.clips)) {
              for (const clip of track.clips) {
                if (
                  clip.source &&
                  typeof clip.source === "string" &&
                  !clip.source.startsWith("data:") &&
                  !media[clip.source]
                ) {
                  try {
                    const fileBuffer = await fs.readFile(clip.source);
                    const ext = path.extname(clip.source).toLowerCase();
                    const mimeMap = {
                      ".jpg": "image/jpeg",
                      ".jpeg": "image/jpeg",
                      ".png": "image/png",
                      ".gif": "image/gif",
                      ".webp": "image/webp",
                      ".svg": "image/svg+xml",
                      ".mp4": "video/mp4",
                      ".webm": "video/webm",
                      ".mp3": "audio/mpeg",
                      ".wav": "audio/wav",
                      ".ogg": "audio/ogg",
                      ".aac": "audio/aac",
                    };
                    const mime = mimeMap[ext] || "application/octet-stream";
                    media[clip.source] = `data:${mime};base64,${fileBuffer.toString("base64")}`;
                  } catch (readErr) {
                    console.warn(
                      `[VideoEditor] Could not read media for share: ${clip.source}`,
                      readErr.message,
                    );
                  }
                }
              }
            }
          }
        }

        const shareData = {
          type: "vcve_project",
          version: 1,
          project,
          media,
          exportedAt: new Date().toISOString(),
        };

        return {
          success: true,
          data: JSON.stringify(shareData),
          preview: project.name || "Video Project",
        };
      } catch (error) {
        console.error("[VideoEditor] Prepare share error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle(
    "import-video-project-from-data",
    async (_, dataString) => {
      try {
        const parsedData =
          typeof dataString === "string"
            ? JSON.parse(dataString)
            : dataString;

        if (parsedData.type !== "vcve_project") {
          throw new Error("Invalid video project data");
        }

        const project = parsedData.project;
        const media = parsedData.media || {};

        // Extract embedded media to userData/VideoMedia/
        const mediaDir = path.join(app.getPath("userData"), "VideoMedia");
        if (!fss.existsSync(mediaDir)) {
          fss.mkdirSync(mediaDir, { recursive: true });
        }

        if (project.tracks && Array.isArray(project.tracks)) {
          for (const track of project.tracks) {
            if (track.clips && Array.isArray(track.clips)) {
              for (const clip of track.clips) {
                if (clip.source && media[clip.source]) {
                  const dataUrl = media[clip.source];
                  const matches = dataUrl.match(
                    /^data:([^;]+);base64,(.+)$/,
                  );
                  if (matches) {
                    const ext =
                      path.extname(clip.source) ||
                      "." + matches[1].split("/")[1];
                    const hash = crypto
                      .createHash("md5")
                      .update(
                        matches[2].substring(0, 1000) + clip.source,
                      )
                      .digest("hex");
                    const newFileName = `${hash}${ext}`;
                    const newPath = path.join(mediaDir, newFileName);

                    if (!fss.existsSync(newPath)) {
                      const buffer = Buffer.from(matches[2], "base64");
                      await fs.writeFile(newPath, buffer);
                    }
                    clip.source = newPath;
                  }
                }
              }
            }
          }
        }

        // Generate new ID to avoid collisions
        project.id = crypto.randomUUID();
        project.name = (project.name || "Project") + " (imported)";

        return { success: true, project };
      } catch (error) {
        console.error("[VideoEditor] Import from data error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // ============================================
  // Pinterest Analytics IPC Handlers
  // ============================================
  const { getPinterestAnalyticsDatabase } = require("./pinterestAnalytics");
  const { collectPinterestAnalytics, retrySingleAccount, getCollectionProgress } = require("./pinterestAnalyticsCollector");

  ipcMain.handle("get-pinterest-daily-metrics", async (_, accountId, metricType, startDate, endDate) => {
    try {
      const db = getPinterestAnalyticsDatabase();
      if (metricType) {
        return { success: true, data: db.getDailyMetrics(accountId, metricType, startDate, endDate) };
      }
      return { success: true, data: db.getAllDailyMetrics(accountId, startDate, endDate) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-pinterest-top-pins", async (_, accountId, metricType, fetchDate) => {
    try {
      const db = getPinterestAnalyticsDatabase();
      if (fetchDate) {
        return { success: true, data: db.getTopPins(accountId, metricType, fetchDate) };
      }
      return { success: true, data: db.getLatestTopPins(accountId, metricType) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-pinterest-fetch-log", async (_, accountId) => {
    try {
      const db = getPinterestAnalyticsDatabase();
      return { success: true, data: db.getFetchLog(accountId) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("trigger-pinterest-analytics-fetch", async (_, force = false, selectedAccounts = null) => {
    try {
      const result = await collectPinterestAnalytics(force, selectedAccounts);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-pinterest-accounts-status", async () => {
    try {
      const pinterestAccounts = (await readKey("pinterestAccounts")) || {};
      const db = getPinterestAnalyticsDatabase();
      const accounts = Object.entries(pinterestAccounts)
        .filter(([accountId, acct]) => acct && typeof acct === "object" && (acct.linkedStructureId || acct.linkedProfileId))
        .map(([accountId, acct]) => {
          const lastFetch = db.getLastSuccessfulFetch(accountId);
          return {
            accountId,
            email: acct.email || null,
            linkedStructureId: acct.linkedStructureId || null,
            linkedProfileId: acct.linkedProfileId || null,
            businessId: acct.businessId || null,
            isLinked: !!(acct.linkedStructureId && acct.linkedProfileId),
            lastFetch: lastFetch ? { fetched_at: lastFetch.fetched_at } : null,
          };
        });
      return { success: true, data: accounts };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("retry-pinterest-account", async (_, accountId) => {
    try {
      const result = await retrySingleAccount(accountId);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-pinterest-analytics-summary", async () => {
    try {
      const db = getPinterestAnalyticsDatabase();
      return { success: true, data: db.getAllSummaryMetrics() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Pinterest Collection Settings
  ipcMain.handle("get-pinterest-collection-settings", async () => {
    try {
      const settings = (await readKey("pinterestCollectionSettings")) || { enabled: false, intervalHours: 24 };
      return { success: true, data: settings };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("update-pinterest-collection-settings", async (_, settings) => {
    try {
      await updateData("pinterestCollectionSettings", settings);
      // Restart or stop the scheduler based on new settings
      if (global.restartPinterestScheduler) {
        await global.restartPinterestScheduler();
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Save only the account selection without restarting the scheduler
  ipcMain.handle("update-pinterest-selected-accounts", async (_, selectedAccounts) => {
    try {
      const settings = (await readKey("pinterestCollectionSettings")) || { enabled: false, intervalHours: 24 };
      settings.selectedAccounts = selectedAccounts;
      await updateData("pinterestCollectionSettings", settings);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-pinterest-collection-status", async () => {
    try {
      const s = global.pinterestScheduler || {};
      const progress = getCollectionProgress();
      return {
        success: true,
        data: {
          isCollecting: s.isCollecting || false,
          lastCollectionTime: s.lastCollectionTime || null,
          nextScheduledTime: s.nextScheduledTime || null,
          progress: progress,
        },
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

// ============================================
// Automation frame-by-frame video export via renderer
// ============================================
let _autoExportResolve = null;

/**
 * Request the renderer to do a frame-by-frame export with animations.
 * Called from automation nodes in the main process.
 *
 * @param {Object} project
 * @param {Object} exportSettings
 * @param {number} timeoutMs - Max time before giving up. Pass 0 (the default)
 *   to disable the timeout entirely — long videos can take a very long time to
 *   render frame-by-frame, so the video editor node must not time out.
 */
async function autoExportVideo(project, exportSettings, timeoutMs = 0) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    return { success: false, error: "No renderer window available" };
  }

  return new Promise((resolve) => {
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        _autoExportResolve = null;
        // Clean up any leftover FFmpeg process so subsequent exports aren't blocked
        try { const { cancelExport } = require("./videoExporter"); cancelExport(); } catch {}
        resolve({ success: false, error: "Export timed out" });
      }, timeoutMs);
    }

    _autoExportResolve = (result) => {
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    win.webContents.send("ve-auto-export", { project, exportSettings });
  });
}

// ============================================
// WP Auto Category - AI-powered post categorization
// ============================================

/**
 * Fetch all uncategorized posts and available categories from a WordPress site.
 */
ipcMain.handle("wpac-fetch-uncategorized", async (event, siteId) => {
  try {
    const wordpressSites = (await readKey("wordpressSites")) || {};
    const wp = wordpressSites[siteId];
    if (!wp) return { success: false, error: "WordPress site not found" };

    const baseUrl = wp.url.replace(/\/$/, "");
    const auth = Buffer.from(`${wp.username}:${wp.appPassword}`).toString("base64");
    const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

    // First get the "Uncategorized" category ID (default = 1 in most WP installs)
    let uncategorizedId = 1;
    try {
      const catRes = await axios.get(`${baseUrl}/wp-json/wp/v2/categories`, {
        headers,
        params: { slug: "uncategorized", per_page: 1 },
        timeout: 30000,
      });
      if (catRes.data && catRes.data.length > 0) {
        uncategorizedId = catRes.data[0].id;
      }
    } catch (e) {
      console.error("[WPAC] Could not resolve uncategorized ID, using default 1:", e.message);
    }

    // Fetch all categories for this site
    let allCategories = [];
    let catPage = 1;
    while (true) {
      const res = await axios.get(`${baseUrl}/wp-json/wp/v2/categories`, {
        headers,
        params: { per_page: 100, page: catPage },
        timeout: 30000,
      });
      allCategories = allCategories.concat(res.data || []);
      const totalPages = parseInt(res.headers["x-wp-totalpages"] || "1", 10);
      if (catPage >= totalPages) break;
      catPage++;
    }

    // Fetch posts that only have the uncategorized category
    let uncategorizedPosts = [];
    let postPage = 1;
    while (true) {
      const res = await axios.get(`${baseUrl}/wp-json/wp/v2/posts`, {
        headers,
        params: { categories: uncategorizedId, per_page: 100, page: postPage, status: "publish" },
        timeout: 30000,
      });
      const posts = res.data || [];
      // Only include posts whose sole category is "uncategorized"
      for (const p of posts) {
        if (p.categories && p.categories.length === 1 && p.categories[0] === uncategorizedId) {
          uncategorizedPosts.push(p);
        }
      }
      const totalPages = parseInt(res.headers["x-wp-totalpages"] || "1", 10);
      if (postPage >= totalPages) break;
      postPage++;
    }

    // Filter out "Uncategorized" from the categories list sent to frontend
    const usableCategories = allCategories
      .filter((c) => c.id !== uncategorizedId)
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug }));

    return {
      success: true,
      posts: uncategorizedPosts.map((p) => ({ id: p.id, title: p.title, link: p.link })),
      categories: usableCategories,
    };
  } catch (error) {
    console.error("[WPAC] Fetch uncategorized error:", error.message);
    return { success: false, error: error.message };
  }
});

/**
 * Use AI to determine the best category for a post based on its title,
 * then update the post on WordPress.
 */
ipcMain.handle("wpac-categorize-post", async (event, siteId, postId, postTitle, categories) => {
  try {
    const wordpressSites = (await readKey("wordpressSites")) || {};
    const wp = wordpressSites[siteId];
    if (!wp) return { success: false, error: "WordPress site not found" };

    if (!categories || categories.length === 0) {
      return { success: false, error: "No categories available on the site" };
    }

    const categoryList = categories.map((c) => `${c.id}: ${c.name}`).join("\n");

    const prompt = `You are a WordPress content categorization assistant. Given a blog post title and a list of available categories, choose the single most appropriate category for the post.

Post title: "${postTitle}"

Available categories (id: name):
${categoryList}

Rules:
- Return ONLY the category ID number, nothing else.
- If none of the categories fit well, return the ID of the closest match.
- Do NOT explain your choice. Just the number.`;

    // Try AI providers in order: OpenAI → Anthropic → Google AI
    let aiResult = null;
    let usedProvider = null;

    // Try OpenAI
    const openaiKeys = (await readKey("openaiKeys")) || {};
    if (Object.keys(openaiKeys).length > 0) {
      try {
        const { openAi } = require("../automations/openai");
        aiResult = await openAi(null, "gpt-5-nano", prompt, 0.3, null, 30000);
        usedProvider = "openai";
      } catch (e) {
        console.error("[WPAC] OpenAI failed:", e.message);
      }
    }

    // Try Anthropic
    if (!aiResult || !aiResult.success) {
      const anthropicKeys = (await readKey("anthropicKeys")) || {};
      if (Object.keys(anthropicKeys).length > 0) {
        try {
          const { anthropic } = require("../automations/anthropic");
          aiResult = await anthropic("claude-sonnet-4-20250514", prompt, 0.3);
          usedProvider = "anthropic";
        } catch (e) {
          console.error("[WPAC] Anthropic failed:", e.message);
        }
      }
    }

    // Try Google AI
    if (!aiResult || !aiResult.success) {
      const googleKeys = (await readKey("googleaiKeys")) || {};
      if (Object.keys(googleKeys).length > 0) {
        try {
          const { googleAI } = require("../automations/googleai");
          aiResult = await googleAI("gemini-2.0-flash", prompt, 0.3);
          usedProvider = "googleai";
        } catch (e) {
          console.error("[WPAC] Google AI failed:", e.message);
        }
      }
    }

    if (!aiResult || !aiResult.success) {
      return { success: false, error: "No AI provider available. Configure OpenAI, Anthropic, or Google AI keys in Settings." };
    }

    // Parse the category ID from AI response
    const responseText = (aiResult.value || "").trim();
    const categoryId = parseInt(responseText.match(/\d+/)?.[0], 10);

    if (!categoryId || !categories.find((c) => c.id === categoryId)) {
      return { success: false, error: `AI returned invalid category: "${responseText}"` };
    }

    const matchedCategory = categories.find((c) => c.id === categoryId);

    // Update the post on WordPress
    const baseUrl = wp.url.replace(/\/$/, "");
    const auth = Buffer.from(`${wp.username}:${wp.appPassword}`).toString("base64");

    const updateRes = await axios.post(
      `${baseUrl}/wp-json/wp/v2/posts/${postId}`,
      { categories: [categoryId] },
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    if (updateRes.status >= 200 && updateRes.status < 300) {
      console.log(`[WPAC] Post ${postId} categorized as "${matchedCategory.name}" (${categoryId}) via ${usedProvider}`);
      return { success: true, categoryId, categoryName: matchedCategory.name };
    } else {
      return { success: false, error: `WordPress API returned status ${updateRes.status}` };
    }
  } catch (error) {
    console.error("[WPAC] Categorize post error:", error.message);
    return { success: false, error: error.message };
  }
});

// Pinterest Auto Publish - uploads a CSV file to Pinterest bulk create page via VCBrowser headless
ipcMain.handle("pinterest-auto-publish", async (event, { accountId, csvContent }) => {
  try {
    const { pinterestAutoPublish } = require("../automations/pinterestPublish");
    const mainWindow = BrowserWindow.getAllWindows()[0];

    const result = await pinterestAutoPublish(accountId, csvContent, (progressData) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("proxy-check-progress", { ...progressData, accountId });
      }
    });
    return result;
  } catch (error) {
    console.error("[PinterestAutoPublish] IPC handler error:", error.message);
    return { success: false, value: error.message };
  }
});

// Pinterest Auto Publish (batch) - uploads MULTIPLE CSV files for one account within a
// single browser session / clean proxy IP. Prevents Pinterest flagging an account that
// uploads split CSV files from several different rotating IPs.
ipcMain.handle("pinterest-auto-publish-batch", async (event, { accountId, csvContents }) => {
  try {
    const { pinterestAutoPublishBatch } = require("../automations/pinterestPublish");
    const mainWindow = BrowserWindow.getAllWindows()[0];

    const result = await pinterestAutoPublishBatch(
      accountId,
      csvContents,
      (progressData) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("proxy-check-progress", { ...progressData, accountId });
        }
      },
      (batchData) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("pinterest-batch-progress", { ...batchData, accountId });
        }
      },
    );
    return result;
  } catch (error) {
    console.error("[PinterestAutoPublishBatch] IPC handler error:", error.message);
    return { success: false, value: error.message, completedBatches: 0 };
  }
});

// Pinterest Get Scheduled Pins - fetches scheduled pins from Pinterest via VCBrowser headless
ipcMain.handle("pinterest-get-scheduled-pins", async (event, { accountId }) => {
  try {
    const { getScheduledPins } = require("../automations/pinterestPublish");
    return await getScheduledPins(accountId);
  } catch (error) {
    console.error("[PinterestScheduledPins] IPC handler error:", error.message);
    return { success: false, value: error.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pinterest Profile Scanner — full profile / boards / pins via internal API
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle("scan-pinterest-profile", async (event, username) => {
  try {
    const axios = require("axios");

    if (!username || typeof username !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(username.trim())) {
      return { success: false, error: "Invalid Pinterest username." };
    }
    username = username.trim();

    const BASE_URL = "https://www.pinterest.com";
    const BASE_HEADERS = {
      "accept": "application/json, text/javascript, */*, q=0.01",
      "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "referer": `${BASE_URL}/`,
      "x-requested-with": "XMLHttpRequest",
      "x-app-version": "78a7973",
      "x-pinterest-appstate": "active",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    };

    function parseCookies(setCookieArr) {
      const cookies = {};
      for (const raw of (setCookieArr || [])) {
        const [nameValue] = raw.split(";");
        const eqIdx = nameValue.indexOf("=");
        if (eqIdx > 0) {
          cookies[nameValue.substring(0, eqIdx).trim()] = nameValue.substring(eqIdx + 1).trim();
        }
      }
      return cookies;
    }

    function cookieStr(cookies) {
      return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    }

    // Step 0 — harvest cookies
    event.sender.send("pinterest-scan-progress", { stage: "cookies" });
    const initResp = await axios.get(`${BASE_URL}/${username}/`, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-FR,fr;q=0.9",
        "upgrade-insecure-requests": "1",
        "user-agent": BASE_HEADERS["user-agent"],
      },
      maxRedirects: 5,
      timeout: 15000,
      validateStatus: (s) => s < 500,
    });

    const cookies = parseCookies(initResp.headers["set-cookie"]);
    if (!cookies["_pinterest_sess"] && !cookies["csrftoken"]) {
      return { success: false, error: "Could not obtain Pinterest session. The account may not exist or Pinterest is blocking requests." };
    }
    if (cookies["_routing_id"]) {
      cookies["_routing_id"] = `"${cookies["_routing_id"].replace(/^"|"$/g, '')}"`;
    }
    cookies["_auth"] = "0";
    cookies["sessionFunnelEventLogged"] = "1";

    const reqHeaders = (extra = {}) => ({
      ...BASE_HEADERS,
      "cookie": cookieStr(cookies),
      ...extra,
    });

    // Step 1 — profile
    const profileResp = await axios.get(`${BASE_URL}/resource/UserResource/get/`, {
      params: {
        source_url: `/${username}/`,
        data: JSON.stringify({ options: { username, field_set_key: "profile" }, context: {} }),
        _: Date.now(),
      },
      headers: reqHeaders({
        "x-pinterest-pws-handler": `www/${username}.js`,
        "x-pinterest-source-url": `/${username}/`,
      }),
      timeout: 15000,
      validateStatus: (s) => s < 500,
    });

    const profile = profileResp.data?.resource_response?.data;
    if (!profile) {
      return { success: false, error: "User not found or profile is private." };
    }

    event.sender.send("pinterest-scan-progress", { stage: "profile", profile });

    // Step 2 — boards (paginated)
    let boardBookmark = null;
    const boards = [];
    let pagesBoards = 0;
    const MAX_BOARD_PAGES = 20;

    while (pagesBoards < MAX_BOARD_PAGES) {
      pagesBoards++;
      const opts = {
        privacy_filter: "all",
        sort: "last_pinned_to",
        field_set_key: "profile_grid_item",
        filter_stories: false,
        username,
        page_size: 50,
        group_by: "visibility",
        include_archived: true,
        redux_normalize_feed: true,
        filter_all_pins: false,
      };
      if (boardBookmark) opts.bookmarks = [boardBookmark];

      const bResp = await axios.get(`${BASE_URL}/resource/BoardsResource/get/`, {
        params: {
          source_url: `/${username}/`,
          data: JSON.stringify({ options: opts, context: {} }),
          _: Date.now(),
        },
        headers: reqHeaders({
          "x-pinterest-pws-handler": `www/${username}.js`,
          "x-pinterest-source-url": `/${username}/`,
        }),
        timeout: 15000,
        validateStatus: (s) => s < 500,
      });

      const bData = bResp.data?.resource_response;
      const items = (bData?.data || []).filter((i) => i.type === "board");
      boards.push(...items);
      const nextMark = bData?.bookmark;
      if (!nextMark || nextMark === "-end-" || nextMark === boardBookmark) break;
      boardBookmark = nextMark;
    }

    event.sender.send("pinterest-scan-progress", { stage: "boards", boards, total: boards.length });

    // Steps 3+4 — collect and filter pins (speed mode, no per-pin enrichment).
    // Boards are processed in concurrent chunks (BOARD_CONCURRENCY at a time).
    const BOARD_CONCURRENCY = 5;   // boards processed in parallel
    const ownerLc           = username.toLowerCase();
    const pinsSeen          = new Set();
    const allPins           = [];

    // Shared live-progress counters updated across concurrent board workers
    let totalRawCollected  = 0;

    function isOwnerPin(pin) {
      const ownerCandidates = [
        pin?.pinner?.username,
        pin?.native_creator?.username,
        pin?.closeup_attribution?.full_name,
        pin?.closeup_attribution?.title,
      ];

      for (const candidate of ownerCandidates) {
        if (!candidate || typeof candidate !== "string") continue;
        const normalized = candidate.trim().toLowerCase().replace(/^@/, "");
        if (normalized === ownerLc) return true;
      }

      return false;
    }

    async function collectBoardPins(board, bi) {
      const boardUrl = board.url || `/${username}/${board.slug || board.name}/`;
      const boardRaw = [];
      let pinBookmark = null;
      let pagesPins   = 0;

      while (pagesPins < 50) {
        pagesPins++;
        const pOpts = {
          board_id: board.id, board_url: boardUrl, currentFilter: -1,
          field_set_key: "react_grid_pin", filter_section_pins: true,
          sort: "default", layout: "default", page_size: 100,
          redux_normalize_feed: true,
        };
        if (pinBookmark) pOpts.bookmarks = [pinBookmark];

        let pResp;
        try {
          pResp = await axios.get(`${BASE_URL}/resource/BoardFeedResource/get/`, {
            params: { source_url: boardUrl, data: JSON.stringify({ options: pOpts, context: {} }), _: Date.now() },
            headers: reqHeaders({ "x-pinterest-pws-handler": `www/${username}/${board.slug || ''}.js`, "x-pinterest-source-url": boardUrl }),
            timeout: 15000, validateStatus: (s) => s < 500,
          });
        } catch { break; }

        const httpStatus = pResp.data?.resource_response?.http_status;
        if (httpStatus === 429 || httpStatus === 403) {
          await new Promise((r) => setTimeout(r, 10000));
          pagesPins--;
          continue;
        }

        const pItems = (pResp.data?.resource_response?.data || []).filter((p) => p?.id);
        for (const p of pItems) boardRaw.push(p);

        const nextMark = pResp.data?.resource_response?.bookmark;
        if (!nextMark || nextMark === "-end-" || nextMark === pinBookmark || pItems.length === 0) break;
        pinBookmark = nextMark;
      }

      // Deduplicate globally (JS single-threaded so Set ops are safe across async boundaries)
      const unique = [];
      for (const p of boardRaw) {
        if (!pinsSeen.has(p.id)) { pinsSeen.add(p.id); unique.push({ ...p, board_id: board.id }); }
      }

      totalRawCollected += unique.length;

      event.sender.send("pinterest-scan-progress", {
        stage: "pins", boardName: board.name, boardIndex: bi,
        totalBoards: boards.length, pinsScanned: totalRawCollected,
      });

      // Keep only pins that are confidently authored by the scanned profile.
      // Previously we allowed missing-owner pins through, which could inflate totals.
      return unique.filter((p) => {
        return isOwnerPin(p);
      });
    }

    // Process boards in concurrent chunks of BOARD_CONCURRENCY
    for (let i = 0; i < boards.length; i += BOARD_CONCURRENCY) {
      const chunk = boards.slice(i, i + BOARD_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((board, j) => collectBoardPins(board, i + j)));
      for (const r of results) {
        if (r.status === "fulfilled") allPins.push(...r.value);
      }
    }

    const pins = allPins;

    return { success: true, data: { profile, boards, pins } };

  } catch (error) {
    console.error("[PinterestScanner] scan-pinterest-profile error:", error.message);
    return { success: false, error: error.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pinterest Keyword Research — IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle("pinterest-kw-autotype", async (_event, term, count = 10) => {
  try {
    const axios = require("axios");
    const sourceUrl = `/search/pins/?q=${encodeURIComponent(term)}&rs=typed`;
    const dataParam = JSON.stringify({
      options: {
        pin_scope: "pins",
        autocomplete_request_surface: 0,
        count: Math.min(Math.max(parseInt(count) || 10, 1), 20),
        term,
      },
      context: {},
    });
    const url = `https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(dataParam)}&_=${Date.now()}`;
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.pinterest.com/",
        "X-App-Version": "afd9548",
        "X-Pinterest-AppState": "active",
        "X-Pinterest-PWS-Handler": "www/search/[scope].js",
        "X-Pinterest-Source-Url": sourceUrl,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      },
    });
    const items = resp.data?.resource_response?.data?.items || [];
    const suggestions = items.filter(i => i.type === "query" && i.query).map(i => i.query);
    return { ok: true, suggestions };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("pinterest-kw-suggestions", async (_event, keyword, country = "US") => {
  try {
    const axios = require("axios");
    const safeCountry = /^[A-Z]{2}$/.test((country || "").toUpperCase()) ? country.toUpperCase() : "US";
    const url = `https://trends.pinterest.com/prefix_match/?query=${encodeURIComponent(keyword)}&country=${safeCountry}`;
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://trends.pinterest.com",
        "Referer": "https://trends.pinterest.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      },
    });
    return { ok: true, suggestions: Array.isArray(resp.data) ? resp.data : [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("pinterest-kw-data", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

// Legacy aliases kept for backward compat — both now proxy through the unified endpoint
ipcMain.handle("pinterest-kw-kd", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

ipcMain.handle("pinterest-kw-volume", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

ipcMain.handle("pinterest-kw-cache-get", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

ipcMain.handle("pinterest-kw-cache-set", async () => ({ success: false, ok: false, disabled: true, error: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files.", value: "This hosted feature is unavailable in the local edition. Use a directly configured provider or local files." }));

ipcMain.handle("pinterest-kw-demographics", async (_event, terms, country = "US", days = 365) => {
  try {
    const axios = require("axios");
    const safeCountry = /^[A-Z]{2}$/.test((country || "").toUpperCase()) ? country.toUpperCase() : "US";
    const safeDays = Math.min(Math.max(parseInt(days) || 365, 1), 365);
    const endDate = new Date().toISOString().split("T")[0];
    const termsCsv = (Array.isArray(terms) ? terms : [terms]).slice(0, 12).join(",");
    const url = `https://trends.pinterest.com/demographics/?terms=${encodeURIComponent(termsCsv)}&country=${safeCountry}&end_date=${endDate}&days=${safeDays}`;
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://trends.pinterest.com",
        "Referer": "https://trends.pinterest.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      },
    });
    if (!resp.data?.term_distributions) return { ok: false, error: "Unexpected response" };
    return { ok: true, term_distributions: resp.data.term_distributions };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("pinterest-kw-top-pins", async (_event, keyword, limit = 9) => {
  try {
    const axios = require("axios");
    const crypto = require("crypto");
    const safeLimit = Math.min(Math.max(parseInt(limit) || 9, 1), 50);
    const PAGES = 4;

    const querySlug    = keyword.replace(/ /g, "-");
    const queryEncoded = encodeURIComponent(keyword);
    const sourceUrl    = `/search/pins/?eq=${querySlug}&q=${queryEncoded}`;
    const seedUrl      = `https://www.pinterest.com/search/pins/?q=${queryEncoded}`;

    // Step 1 — seed request to harvest session cookies
    let csrftoken = "", pinterestSess = "", routingId = "";
    try {
      const seedResp = await axios.get(seedUrl, {
        timeout: 15000,
        maxRedirects: 3,
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "accept-language": "fr-FR,fr;q=0.9",
          "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        },
      });
      for (const c of (seedResp.headers["set-cookie"] || [])) {
        const part = c.split(";")[0];
        if (part.startsWith("csrftoken="))      csrftoken     = part.split("=")[1];
        if (part.startsWith("_pinterest_sess=")) pinterestSess = part.split("=").slice(1).join("=");
        if (part.startsWith("_routing_id="))     routingId     = part.split("=").slice(1).join("=").replace(/"/g, "");
      }
    } catch (_) { /* proceed without cookies */ }

    const cookieStr = [
      csrftoken     ? `csrftoken=${csrftoken}` : "",
      pinterestSess ? `_pinterest_sess=${pinterestSess}` : "",
      `_auth=0`,
      routingId     ? `_routing_id="${routingId}"` : "",
      `sessionFunnelEventLogged=1`,
    ].filter(Boolean).join("; ");

    // Step 2 — paginate up to PAGES times using bookmarks
    const allPins = [];
    const seenIds = new Set();
    let bookmark = null;

    for (let page = 0; page < PAGES; page++) {
      const traceId  = crypto.randomBytes(8).toString("hex");
      const parentId = crypto.randomBytes(8).toString("hex");
      const spanId   = crypto.randomBytes(8).toString("hex");
      const nowMs    = Date.now();

      const options = {
        query: keyword,
        scope: "pins",
        appliedProductFilters: "---",
        domains: null,
        user: null,
        seoDrawerEnabled: false,
        applied_unified_filters: null,
        auto_correction_disabled: false,
        journey_depth: null,
        source_id: null,
        source_module_id: null,
        source_url: sourceUrl,
        static_feed: false,
        selected_one_bar_modules: null,
        query_pin_sigs: null,
        page_size: null,
        price_max: null,
        price_min: null,
        query_image_pins: null,
        request_params: null,
        top_pin_ids: null,
        article: null,
        corpus: null,
        customized_rerank_type: null,
        filters: null,
        rs: "direct_navigation",
        redux_normalize_feed: true,
        ...(bookmark ? { bookmarks: [bookmark] } : {}),
      };

      const dataParam = encodeURIComponent(JSON.stringify({ options, context: {} }));
      const apiUrl    = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${dataParam}&_=${nowMs}`;

      let resp;
      try {
        resp = await axios.get(apiUrl, {
          timeout: 20000,
          headers: {
            "accept": "application/json, text/javascript, */*; q=0.01",
            "accept-language": "fr-FR,fr;q=0.9",
            "priority": "u=1, i",
            "referer": "https://www.pinterest.com/",
            "screen-dpr": "1",
            "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            "sec-ch-ua-full-version-list": '"Google Chrome";v="147.0.7727.57", "Not.A/Brand";v="8.0.0.0", "Chromium";v="147.0.7727.57"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-model": '""',
            "sec-ch-ua-platform": '"Windows"',
            "sec-ch-ua-platform-version": '"10.0.0"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
            "x-app-version": "8efc3ef",
            "x-b3-flags": "0",
            "x-b3-parentspanid": parentId,
            "x-b3-spanid": spanId,
            "x-b3-traceid": traceId,
            "x-pinterest-appstate": "active",
            "x-pinterest-pws-handler": "www/search/[scope].js",
            "x-requested-with": "XMLHttpRequest",
            ...(cookieStr ? { Cookie: cookieStr } : {}),
          },
        });
      } catch (_) { break; }

      const results = resp.data?.resource_response?.data?.results || [];
      bookmark = resp.data?.resource_response?.bookmark || null;

      for (const pin of results) {
        if (!pin.id || seenIds.has(pin.id)) continue;
        seenIds.add(pin.id);
        const saves = pin.reaction_counts?.[1] ?? pin.reaction_counts?.["1"] ?? pin.aggregated_pin_data?.aggregated_stats?.saves ?? pin.save_count ?? 0;
        const imgUrl = pin.images?.["736x"]?.url || pin.images?.orig?.url || "";
        if (!imgUrl) continue;
        allPins.push({
          id: pin.id,
          title: pin.title || pin.grid_title || "",
          image_url: imgUrl,
          link: pin.link || `https://www.pinterest.com/pin/${pin.id}/`,
          saves,
          pinner: {
            username: pin.pinner?.username || "",
            display_name: pin.pinner?.full_name || "",
            avatar_url: pin.pinner?.image_medium_url || "",
          },
        });
      }

      if (!bookmark) break;
    }

    // Sort by saves descending, return top safeLimit
    allPins.sort((a, b) => b.saves - a.saves);
    const pins = allPins.slice(0, safeLimit);
    return { ok: true, pins };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI Image Cleaner — sanitize metadata and optionally reprocess pixels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean an AI-generated image on behalf of the renderer.
 * Accepts a plain number array (JSON-serialisable) for the image bytes
 * and returns the cleaned bytes the same way.
 */
ipcMain.handle("clean-ai-image", async (_event, byteArray, options = {}) => {
  try {
    const { cleanImage } = require("./imageClean");
    const inputBuffer = Buffer.from(byteArray);
    const result = await cleanImage(inputBuffer, options);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      buffer: Array.from(result.buffer),
      format: result.format,
      originalFormat: result.originalFormat
    };
  } catch (err) {
    console.error("[AIImageCleaner] clean-ai-image error:", err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Save a cleaned image via a native Save-File dialog.
 * suggestedName  — default filename shown in the dialog
 * byteArray      — plain number array of image bytes
 */
ipcMain.handle("save-cleaned-image", async (_event, suggestedName, byteArray) => {
  try {
    const { dialog } = require("electron");
    const fs   = require("fs");
    const path = require("path");

    const ext = path.extname(suggestedName).slice(1).toLowerCase() || "jpg";
    const filterMap = {
      jpg:  [{ name: "JPEG Image", extensions: ["jpg", "jpeg"] }],
      jpeg: [{ name: "JPEG Image", extensions: ["jpg", "jpeg"] }],
      png:  [{ name: "PNG Image",  extensions: ["png"]         }],
      webp: [{ name: "WebP Image", extensions: ["webp"]        }]
    };
    const filters = filterMap[ext] || [{ name: "Image", extensions: [ext] }];

    const { filePath, canceled } = await dialog.showSaveDialog({
      title: "Save Cleaned Image",
      defaultPath: suggestedName,
      filters
    });

    if (canceled || !filePath) {
      return { success: false, cancelled: true };
    }

    const buffer = Buffer.from(byteArray);
    fs.writeFileSync(filePath, buffer);

    console.log(`[AIImageCleaner] Saved cleaned image: ${filePath}`);
    return { success: true, filePath };
  } catch (err) {
    console.error("[AIImageCleaner] save-cleaned-image error:", err.message);
    return { success: false, error: err.message };
  }
});

/**
 * Read all metadata from an image using exiftool.
 * Returns a flat object of key→value strings suitable for display.
 */
ipcMain.handle("read-image-metadata", async (_event, byteArray) => {
  const fs     = require("fs");
  const path   = require("path");
  const os     = require("os");
  const crypto = require("crypto");

  const buf = Buffer.from(byteArray);

  // Detect extension from magic bytes so exiftool picks the right parser
  let ext = '';
  if (buf[0] === 0xFF && buf[1] === 0xD8) ext = '.jpg';
  else if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
  else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) ext = '.webp';
  else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ext = '.gif';

  const tempFile = path.join(os.tmpdir(), `vc_meta_${crypto.randomBytes(8).toString("hex")}${ext}`);

  try {
    const { exiftool } = require("exiftool-vendored");
    fs.writeFileSync(tempFile, buf);
    const tags = await exiftool.read(tempFile);

    // Recursively flatten nested objects/arrays into individual key-value rows.
    // Objects use '__' separator; arrays append '_N' index suffix.
    function flattenValue(val, keyPath, out, depth) {
      if (depth === undefined) depth = 0;
      if (val === null || val === undefined) return;

      // Guard: cap total output fields
      if (Object.keys(out).length >= 600) return;

      // Binary Node.js Buffer
      if (Buffer.isBuffer(val)) {
        out[keyPath] = `(Binary data ${val.length} bytes)`;
        return;
      }

      // Primitives
      if (typeof val !== 'object') {
        const s = String(val);
        out[keyPath] = s.length > 400 ? s.substring(0, 400) + '\u2026' : s;
        return;
      }

      // ExifDate / ExifDateTime
      if (typeof val.toISOString === 'function') {
        try { out[keyPath] = val.toISOString().replace('T', ' ').replace('.000Z', 'Z'); }
        catch (e) { out[keyPath] = String(val); }
        return;
      }

      // BinaryField (C2PA payloads from exiftool-vendored)
      if (val._ctor === 'BinaryField' || (val.rawValue !== undefined && val.bytes !== undefined)) {
        out[keyPath] = `(Binary data ${val.bytes || '?'} bytes)`;
        return;
      }

      // Depth limit: collapse remaining structure to a short JSON excerpt
      if (depth >= 6) {
        try {
          const s = JSON.stringify(val);
          out[keyPath] = s.length > 200 ? s.substring(0, 200) + '\u2026' : s;
        } catch (e) { out[keyPath] = '[Object]'; }
        return;
      }

      // Array: expand each item as keyPath_N
      if (Array.isArray(val)) {
        if (val.length === 0) return;
        val.forEach((item, i) => flattenValue(item, `${keyPath}_${i}`, out, depth + 1));
        return;
      }

      // Plain object: expand each property as keyPath__propName
      for (const [k, v] of Object.entries(val)) {
        flattenValue(v, `${keyPath}__${k}`, out, depth + 1);
      }
    }

    const skipKeys = new Set([
      "SourceFile", "errors", "warnings",
      // Temp-file artefacts — not meaningful for the original image
      "FileName", "Directory",
      "FileModifyDate", "FileAccessDate", "FileCreateDate", "FileInodeChangeDate"
    ]);

    const result = {};
    // Always show checksum first so the user can verify file identity
    result['checksum'] = crypto.createHash('md5').update(buf).digest('hex');

    for (const [k, v] of Object.entries(tags)) {
      if (skipKeys.has(k)) continue;
      if (v === undefined || v === null) continue;
      flattenValue(v, k, result);
    }

    console.log(`[AIImageCleaner] read-image-metadata: ${Object.keys(result).length} fields`);
    return { success: true, tags: result };
  } catch (err) {
    console.error("[AIImageCleaner] read-image-metadata error:", err.message);
    return { success: false, error: err.message, tags: {} };
  } finally {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
  }
});

/**
 * Remove the invisible Gemini (SynthID) watermark from an image.
 * Uses the same reverse alpha-blending approach as the Gemini Image automation.
 * Accepts a plain number array of image bytes and returns the cleaned bytes
 * the same way (always PNG to preserve the lossless alpha reversal).
 */
ipcMain.handle("remove-gemini-watermark", async (_event, byteArray) => {
  try {
    const sharp = require("sharp");
    const { removeWatermarkFromImageDataSync } = await import(
      "@pilio/gemini-watermark-remover"
    );

    const inputBuffer = Buffer.from(byteArray);

    // Decode to raw RGBA.
    const { data, info } = await sharp(inputBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const imageData = {
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
      width: info.width,
      height: info.height,
    };

    // Automatic detection + removal (most aggressive built-in mode).
    const result = removeWatermarkFromImageDataSync(imageData, {
      adaptiveMode: "always",
      maxPasses: 4,
    });

    const outImageData = result.imageData;
    const applied = !!result.meta?.applied;
    const tier = result.meta?.decisionTier || null;

    const outBuffer = await sharp(
      Buffer.from(
        outImageData.data.buffer,
        outImageData.data.byteOffset,
        outImageData.data.byteLength
      ),
      {
        raw: {
          width: outImageData.width,
          height: outImageData.height,
          channels: 4,
        },
      }
    )
      .png()
      .toBuffer();

    console.log(
      `[GeminiWatermark] Removed (applied: ${applied}, tier: ${tier})`
    );

    return {
      success: true,
      buffer: Array.from(outBuffer),
      format: "png",
      applied,
      tier,
    };
  } catch (err) {
    console.error("[GeminiWatermark] remove-gemini-watermark error:", err.message);
    return { success: false, error: err.message };
  }
});

// ================================================================
// Facebook Groups Database Handlers
// ================================================================
const fbGroupsDb = require("./facebookGroupsDatabase");
const FBGroupsScheduler = require("./facebookGroupsScheduler");
const fbGroupsScheduler = new FBGroupsScheduler(fbGroupsDb);
// Start the scheduler after a short delay so the app is fully ready
setTimeout(() => fbGroupsScheduler.start(), 5000);
const { facebookGroupPost }     = require("../automations/facebookGroups/facebookGroupPost");
const { facebookGroupEditPost } = require("../automations/facebookGroups/facebookGroupEditPost");
const { facebookGroupComment }  = require("../automations/facebookGroups/facebookGroupComment");
const { facebookGroupScanPost } = require("../automations/facebookGroups/facebookGroupScanPost");
const { facebookGroupScanInfo } = require("../automations/facebookGroups/facebookGroupScanInfo");

ipcMain.handle("fb-groups-get-all", async () => {
  try {
    const data = fbGroupsDb.getAllGroups();
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-all error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-stats", async () => {
  try {
    const data = fbGroupsDb.getStats();
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-stats error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-by-id", async (_, groupId) => {
  try {
    const data = fbGroupsDb.getGroupById(groupId);
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-by-id error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-search", async (_, query) => {
  try {
    const data = fbGroupsDb.searchGroups(query || "");
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] search error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-create", async (_, groupId, name, url, notes) => {
  try {
    const data = fbGroupsDb.createGroup(groupId, name, url, notes);
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] create error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-update", async (_, groupId, name, url, notes) => {
  try {
    if (!name || !name.trim()) return { success: false, error: "Group name is required" };
    const data = fbGroupsDb.updateGroup(groupId, name, url, notes);
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] update error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-delete", async (_, groupId) => {
  try {
    fbGroupsDb.deleteGroup(groupId);
    const imageStore = require("./facebookGroupsImageStore");
    await imageStore.removeGroupImages(groupId);
    return { success: true };
  } catch (err) {
    console.error("[FbGroups] delete error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-profiles", async (_, groupId) => {
  try {
    const data = fbGroupsDb.getGroupProfiles(groupId);
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-profiles error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-add-profile", async (_, groupId, structureId, profileId, profileLabel, structureLabel) => {
  try {
    fbGroupsDb.addProfileToGroup(groupId, structureId, profileId, profileLabel, structureLabel);
    // Auto-scan the group now that it has a linked profile (first link only, fire-and-forget).
    try {
      const group = fbGroupsDb.getGroupById(groupId);
      if (group && !group.lastScannedAt) {
        fbGroupsScheduler.scanGroupNow(groupId).catch(() => {});
      }
    } catch (_) {}
    // Auto-scan the profile itself (login health + identity) if not scanned yet.
    try {
      const existingScan = fbGroupsDb.getProfileScan(profileId);
      if (!existingScan || !existingScan.lastScannedAt) {
        fbGroupsScheduler.scanProfileNow(profileId, profileLabel || "").catch(() => {});
      }
    } catch (_) {}
    return { success: true };
  } catch (err) {
    console.error("[FbGroups] add-profile error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-remove-profile", async (_, groupId, profileId) => {
  try {
    fbGroupsDb.removeProfileFromGroup(groupId, profileId);
    return { success: true };
  } catch (err) {
    console.error("[FbGroups] remove-profile error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-post-log", async (_, groupId, limit, offset) => {
  try {
    const data = fbGroupsDb.getGroupPostLog(groupId, limit || 20, offset || 0);
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-post-log error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-update-log-post-id", async (_, id, postId) => {
  try {
    fbGroupsDb.updatePostLogPostId(id, postId);
    return { success: true };
  } catch (err) {
    console.error("[FbGroups] update-log-post-id error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-new-post", async (_, groupId, message, imagePath) => {
  try {
    if (!groupId) return { success: false, error: "Missing groupId" };
    if (!message || !message.trim()) return { success: false, error: "Message cannot be empty" };

    const structures = await readKey("structures") || {};

    // Helper: find profile data by searching all structures
    function findProfileData(pid) {
      if (!pid) return null;
      for (const struct of Object.values(structures)) {
        if (struct.profiles?.[pid]) return struct.profiles[pid];
      }
      return null;
    }

    let profileId = null;
    let profileLabel = "unknown";
    let profileData = null;

    // 1) group_profiles table (profiles explicitly linked via Groups tab)
    const directProfiles = fbGroupsDb.getGroupProfiles(groupId);
    if (directProfiles && directProfiles.length > 0) {
      const pick = directProfiles[Math.floor(Math.random() * directProfiles.length)];
      profileId    = pick.profileId;
      profileLabel = pick.profileLabel || profileId;
      profileData  = findProfileData(profileId);
    }

    // 2) workflow_group_targets fallback (any imported workflow targeting this group)
    if (!profileData) {
      const wfTargetRow = fbGroupsDb.db.prepare(
        `SELECT profile_id FROM workflow_group_targets WHERE group_id = ? AND profile_id IS NOT NULL AND profile_id != '' LIMIT 1`
      ).get(groupId);
      if (wfTargetRow?.profile_id) {
        profileId    = wfTargetRow.profile_id;
        profileData  = findProfileData(profileId);
        profileLabel = profileId;
      }
    }

    if (!profileId || !profileData) {
      return { success: false, error: "No profiles linked to this group. Please link a profile via the Groups tab or import a workflow targeting this group." };
    }

    // Get group URL
    const group = fbGroupsDb.getGroupById(groupId);
    if (!group) return { success: false, error: "Group not found" };
    const groupUrl = group.url || "";

    // Extract the real Facebook group ID from the stored URL
    const facebookGroupId = (groupUrl.match(/\/groups\/([^/?#]+)/) || [])[1] || "";
    if (!facebookGroupId) {
      return { success: false, error: "Could not extract Facebook group ID from the group URL. Please edit the group and re-enter the Group ID." };
    }

    // Run the automation
    const result = await facebookGroupPost({ facebookGroupId, groupUrl, message: message.trim(), imagePath: imagePath || null, profileId, profileData });

    // Log result regardless of success/failure
    const status = result.success ? "sent" : "failed";
    const postId = result.success ? (result.postId || null) : null;
    fbGroupsDb.addPostLog(groupId, profileId, profileLabel, message.trim(), status, postId);

    return { ...result, profileLabel };
  } catch (err) {
    console.error("[FbGroupsNewPost] Error:", err.message);
    return { success: false, error: err.message };
  }
});

// Manual post from a SPECIFIC profile to a chosen group (Profiles page quick post).
ipcMain.handle("fb-groups-post-from-profile", async (_, profileId, groupId, message, imagePath) => {
  try {
    if (!profileId) return { success: false, error: "Missing profileId" };
    if (!groupId)   return { success: false, error: "Missing groupId" };
    if (!message || !message.trim()) return { success: false, error: "Message cannot be empty" };

    const structures = await readKey("structures") || {};

    // Find the full profile data + label by searching every structure.
    let profileData = null;
    let profileLabel = profileId;
    for (const struct of Object.values(structures)) {
      if (struct.profiles?.[profileId]) {
        profileData  = struct.profiles[profileId];
        profileLabel = profileData.label || profileData.name || profileId;
        break;
      }
    }
    if (!profileData) {
      return { success: false, error: "Profile not found. It may have been removed." };
    }

    const group = fbGroupsDb.getGroupById(groupId);
    if (!group) return { success: false, error: "Group not found" };
    const groupUrl = group.url || "";

    const facebookGroupId = (groupUrl.match(/\/groups\/([^/?#]+)/) || [])[1] || "";
    if (!facebookGroupId) {
      return { success: false, error: "Could not extract Facebook group ID from the group URL. Please edit the group and re-enter the Group ID." };
    }

    const result = await facebookGroupPost({
      facebookGroupId,
      groupUrl,
      message: message.trim(),
      imagePath: imagePath || null,
      profileId,
      profileData,
    });

    const status = result.success ? "sent" : "failed";
    const postId = result.success ? (result.postId || null) : null;
    fbGroupsDb.addPostLog(groupId, profileId, profileLabel, message.trim(), status, postId);

    return { ...result, profileLabel };
  } catch (err) {
    console.error("[FbGroupsPostFromProfile] Error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-edit-post", async (_, groupId, storyId, message) => {
  try {
    if (!groupId)  return { success: false, error: "Missing groupId" };
    if (!storyId)  return { success: false, error: "Missing story ID" };
    if (!message || !message.trim()) return { success: false, error: "Message cannot be empty" };

    // Get the profile that originally made this post (sticky), fallback to random
    const profiles = fbGroupsDb.getGroupProfiles(groupId);
    if (!profiles || profiles.length === 0) {
      return { success: false, error: "No profiles linked to this group" };
    }
    const originalProfileId = fbGroupsDb.getPostProfileId(groupId, storyId.trim());
    const selectedProfile = (originalProfileId && profiles.find(p => p.profileId === originalProfileId))
      || profiles[Math.floor(Math.random() * profiles.length)];
    const { structureId, profileId, profileLabel } = selectedProfile;

    // Get group URL
    const group = fbGroupsDb.getGroupById(groupId);
    if (!group) return { success: false, error: "Group not found" };
    const groupUrl = group.url || "";

    // Get full profile data
    const structures = await readKey("structures");
    const profileData = structures?.[structureId]?.profiles?.[profileId];
    if (!profileData) {
      return { success: false, error: `Profile "${profileLabel}" not found in structures` };
    }

    const result = await facebookGroupEditPost({
      storyId: storyId.trim(),
      groupUrl,
      message: message.trim(),
      profileId,
      profileData
    });

    return { ...result, profileLabel, editedPostId: storyId.trim() };
  } catch (err) {
    console.error("[FbGroupsEditPost] Error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-add-comment", async (_, groupId, storyId, message, imagePath) => {
  try {
    if (!groupId)  return { success: false, error: "Missing groupId" };
    if (!storyId)  return { success: false, error: "Missing story ID" };
    if (!message || !message.trim()) return { success: false, error: "Message cannot be empty" };

    const profiles = fbGroupsDb.getGroupProfiles(groupId);
    if (!profiles || profiles.length === 0) {
      return { success: false, error: "No profiles linked to this group" };
    }
    // Use the profile that originally made this post (sticky), fallback to random
    const originalProfileId = fbGroupsDb.getPostProfileId(groupId, storyId.trim());
    const selectedProfile = (originalProfileId && profiles.find(p => p.profileId === originalProfileId))
      || profiles[Math.floor(Math.random() * profiles.length)];
    const { structureId, profileId, profileLabel } = selectedProfile;

    const group = fbGroupsDb.getGroupById(groupId);
    if (!group) return { success: false, error: "Group not found" };
    const groupUrl = group.url || "";
    const facebookGroupId = (groupUrl.match(/\/groups\/([^/?#]+)/) || [])[1] || "";
    if (!facebookGroupId) return { success: false, error: "Could not extract Facebook group ID from URL" };

    const structures = await readKey("structures");
    const profileData = structures?.[structureId]?.profiles?.[profileId];
    if (!profileData) {
      return { success: false, error: `Profile "${profileLabel}" not found in structures` };
    }

    const result = await facebookGroupComment({
      storyId: storyId.trim(),
      facebookGroupId,
      groupUrl,
      message: message.trim(),
      imagePath: imagePath || null,
      profileId,
      profileData
    });

    return { ...result, profileLabel };
  } catch (err) {
    console.error("[FbGroupsAddComment] Error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-edit-comment", async (_, groupId, commentId, newText, imagePath) => {
  try {
    if (!groupId)   return { success: false, error: "Missing groupId" };
    if (!commentId) return { success: false, error: "Missing commentId" };
    if (!newText || !newText.trim()) return { success: false, error: "New text cannot be empty" };

    const group = fbGroupsDb.getGroupById(groupId);
    if (!group) return { success: false, error: "Group not found" };
    const groupUrl = group.url || "";

    const profiles = fbGroupsDb.getGroupProfiles(groupId);
    if (!profiles || profiles.length === 0) return { success: false, error: "No profiles linked to this group" };

    // Use the profile that originally created this comment (sticky), fallback to random
    const commentProfileId = fbGroupsDb.getCommentProfileId(groupId, commentId.trim());
    const selectedProfile = (commentProfileId && profiles.find(p => p.profileId === commentProfileId))
      || profiles[Math.floor(Math.random() * profiles.length)];
    const { structureId, profileId, profileLabel } = selectedProfile;
    const structures = await readKey("structures");
    const profileData = structures?.[structureId]?.profiles?.[profileId];
    if (!profileData) return { success: false, error: `Profile "${profileLabel}" not found in structures` };

    const { facebookGroupEditComment } = require("../automations/facebookGroups/facebookGroupEditComment");
    const result = await facebookGroupEditComment({
      commentId: commentId.trim(),
      newText:   newText.trim(),
      imagePath: imagePath || null,
      groupUrl,
      profileId,
      profileData,
    });

    return { ...result, profileLabel };
  } catch (err) {
    console.error("[FbGroupsEditComment] Error:", err.message);
    return { success: false, error: err.message };
  }
});



ipcMain.handle("fb-groups-scan-post", async (_, groupId, input) => {
  try {
    if (!groupId) return { success: false, error: "Missing groupId" };
    if (!input)   return { success: false, error: "Missing post URL or storyId" };

    const group = fbGroupsDb.getGroupById(groupId);
    if (!group) return { success: false, error: "Group not found" };
    const groupUrl = group.url || "";

    const profiles = fbGroupsDb.getGroupProfiles(groupId);
    if (!profiles || profiles.length === 0) {
      return { success: false, error: "No profiles linked to this group" };
    }
    const randomProfile = profiles[Math.floor(Math.random() * profiles.length)];
    const { structureId, profileId, profileLabel } = randomProfile;

    const structures = await readKey("structures");
    const profileData = structures?.[structureId]?.profiles?.[profileId];
    if (!profileData) {
      return { success: false, error: `Profile "${profileLabel}" not found in structures` };
    }

    // Detect whether the input is a full URL or a base64 storyId
    const isUrl = input.startsWith("http");
    const scanParams = isUrl
      ? { postUrl: input, groupUrl, profileId, profileData }
      : { storyId: input, groupUrl, profileId, profileData };

    const result = await facebookGroupScanPost(scanParams);
    return { ...result, profileLabel };
  } catch (err) {
    console.error("[FbGroupsScanPost] Error:", err.message);
    return { success: false, error: err.message };
  }
});

// Scan public group info (name, members, cover, created, activity stats) from a group ID.
// Delegates to the scheduler so the result is persisted to the DB and broadcast to the UI.
ipcMain.handle("fb-groups-scan-group-info", async (_, groupId) => {
  try {
    if (!groupId) return { success: false, error: "Missing groupId" };
    return await fbGroupsScheduler.scanGroupNow(groupId);
  } catch (err) {
    console.error("[FbGroupsScanInfo] Error:", err.message);
    return { success: false, error: err.message };
  }
});

// Scan a single Chrome profile: verify it is still logged into Facebook and
// collect its identity (name, id/username, profile picture, cover, friends/
// followers). Result is cached per-profile so the chip persists between opens.
ipcMain.handle("fb-groups-scan-profile", async (_, profileId, profileLabel) => {
  try {
    if (!profileId) return { success: false, error: "Missing profileId" };
    return await fbGroupsScheduler.scanProfileNow(profileId, profileLabel || "");
  } catch (err) {
    console.error("[FbGroupsScanProfile] Error:", err.message);
    return { success: false, loggedIn: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-mark-profile-working", async (_, profileId) => {
  try {
    if (!profileId) return { success: false, error: "Missing profileId" };
    fbGroupsDb.markProfileWorking(profileId);
    // Clear the scheduler's live "disconnected" activity so a later overview poll
    // doesn't re-surface the Disconnected pill after the DB flag is cleared.
    try {
      const act = fbGroupsScheduler.profileActivity.get(profileId);
      if (act && act.status === 'disconnected') fbGroupsScheduler._setProfileActivity(profileId, 'idle', '', {});
    } catch (_) {}
    // Push a live update so the profile card turns back to normal immediately
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('fb-groups-profile-flagged', {
        profileId,
        loggedIn: true,
        error: null,
        timestamp: new Date().toISOString(),
      });
    }
    return { success: true };
  } catch (err) {
    console.error("[FbGroupsMarkProfileWorking] Error:", err.message);
    return { success: false, error: err.message };
  }
});

// User-initiated: reset a profile's lifetime sent/failed totals. Keeps the current
// daily usage intact (that counter is independent of the stats watermark).
ipcMain.handle("fb-groups-reset-profile-stats", async (_, profileId) => {
  try {
    if (!profileId) return { success: false, error: "Missing profileId" };
    fbGroupsDb.resetProfileStats(profileId);
    return { success: true };
  } catch (err) {
    console.error("[FbGroupsResetProfileStats] Error:", err.message);
    return { success: false, error: err.message };
  }
});

// Test HTTP-only Facebook session (no browser)
ipcMain.handle("fb-groups-test-http-session", async (_, groupId) => {
  try {
    const { getFacebookSessionTokens } = require("./facebookHttpSession");

    if (!groupId) return { success: false, error: "Missing groupId" };
    const profiles = fbGroupsDb.getGroupProfiles(groupId);
    if (!profiles || profiles.length === 0) return { success: false, error: "No profiles linked" };

    const results = [];
    const structures = await readKey("structures");

    for (const { structureId, profileId, profileLabel } of profiles) {
      const profileData = structures?.[structureId]?.profiles?.[profileId];
      if (!profileData) { results.push({ profileId, profileLabel, ok: false, error: "Not found in structures" }); continue; }

      const cookies   = profileData.cookies || [];
      const userAgent = profileData.fingerprint?.userAgent || "Mozilla/5.0";

      const t0 = Date.now();
      try {
        const session = await getFacebookSessionTokens(cookies, userAgent);
        const ms = Date.now() - t0;
        if (session) {
          results.push({ profileId, profileLabel, ok: true, uid: session.uid, dtsgPrefix: session.dtsg.slice(0, 8) + "...", cookieCount: cookies.length, ms });
        } else {
          results.push({ profileId, profileLabel, ok: false, error: "Cookies expired or not logged in", cookieCount: cookies.length, ms });
        }
      } catch (e) {
        results.push({ profileId, profileLabel, ok: false, error: e.message, cookieCount: cookies.length, ms: Date.now() - t0 });
      }
    }

    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Refresh Facebook doc_ids by opening a headless browser, navigating to the group
// page, intercepting live GraphQL requests, and saving the extracted doc_ids.
ipcMain.handle("fb-groups-refresh-doc-ids", async (_, groupId) => {
  const { getDocId, updateDocId, FALLBACK_DOC_IDS } = require("./facebookDocIds");
  const { startVCBrowser } = require("../lib/VCBrowserManager");
  const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../lib/cdpFingerprint");

  try {
    if (!groupId) return { success: false, error: "Missing groupId" };

    const group = fbGroupsDb.getGroupById(groupId);
    if (!group) return { success: false, error: "Group not found" };
    const groupUrl = group.url || "https://www.facebook.com/";

    const profiles = fbGroupsDb.getGroupProfiles(groupId);
    if (!profiles || profiles.length === 0) return { success: false, error: "No profiles linked" };

    const structures = await readKey("structures");
    const { structureId, profileId } = profiles[0];
    const profileData = structures?.[structureId]?.profiles?.[profileId];
    if (!profileData) return { success: false, error: "Profile not found in structures" };

    const cookies   = profileData.cookies || [];
    let fingerprint = profileData.fingerprint || {};
    if (!fingerprint || Object.keys(fingerprint).length === 0)
      fingerprint = getConsistentFingerprintForProfile(profileId);
    try {
      const v = getVCBrowserVersion();
      if (fingerprint.userAgent && v?.full)
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${v.full}`);
    } catch (_) {}

    const proxy = profileData.proxy?.ip && profileData.proxy.ip !== "NULL" ? profileData.proxy : null;

    const startResult = await startVCBrowser(profileId, fingerprint, "about:blank", proxy, true, true);
    if (!startResult?.client) return { success: false, error: "Failed to start browser" };

    const { Page, Runtime, Network } = startResult.client;
    const capturedDocIds = {};
    const jsResponses    = []; // { requestId, url } for JS bundles
    const debugLog       = { graphql: [], jsUrls: [], htmlSnippets: {} };

    await Network.enable();

    // Intercept live GraphQL calls
    Network.requestWillBeSent(({ requestId, request }) => {
      const entry = { requestId, url: request.url, method: request.method };
      if (request.url?.includes("facebook.com/api/graphql") && request.postData) {
        entry.postData = request.postData;
        try {
          const p = new URLSearchParams(request.postData);
          entry.fb_api_req_friendly_name = p.get("fb_api_req_friendly_name");
          entry.doc_id                   = p.get("doc_id");
          const fn = entry.fb_api_req_friendly_name;
          const di = entry.doc_id;
          if (fn && di && Object.prototype.hasOwnProperty.call(FALLBACK_DOC_IDS, fn))
            capturedDocIds[fn] = di;
        } catch (_) {}
        debugLog.graphql.push(entry);
      }
    });

    // Collect JS bundle requestIds so we can read their body via CDP
    Network.responseReceived(({ requestId, response }) => {
      const url  = response?.url  || "";
      const mime = response?.mimeType || "";
      debugLog.jsUrls.push({ requestId, url, mime, status: response?.status });
      if ((url.includes(".fbcdn.net") || url.includes("facebook.com")) &&
          (mime.includes("javascript") || url.includes("/rsrc.php/") || url.endsWith(".js"))) {
        jsResponses.push({ requestId, url });
      }
    });

    // Inject cookies
    if (cookies.length > 0) {
      for (const c of cookies) {
        const cc = { name: c.name, value: c.value, domain: c.domain || ".facebook.com",
          path: c.path || "/", secure: c.secure || false, httpOnly: c.httpOnly || false };
        if (c.sameSite) cc.sameSite = c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : "Strict";
        if (c.expires) cc.expires = c.expires;
        try { await Network.setCookie(cc); } catch (_) {}
      }
    }

    // Navigate and wait for initial bundles to load
    await Page.navigate({ url: groupUrl });
    await new Promise(r => setTimeout(r, 10000));

    // Click the composer box — triggers lazy-loading of ComposerStoryCreateMutation bundle
    let clickResult = "not attempted";
    try {
      const clickEval = await Runtime.evaluate({
        expression: `(function() {
          const selectors = [
            '[aria-label="Write something..."]',
            '[aria-label="Écrire quelque chose..."]',
            '[aria-label="Écrire quelque chose…"]',
            '[aria-label*="Write"]',
            '[aria-label*="quelque"]',
            '[data-testid="status-attachment-mentions-input"]',
            'div[contenteditable]',
          ];
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) { el.click(); el.focus(); return 'clicked:' + s; }
          }
          // Broader: any [role=button] whose text mentions writing
          for (const el of document.querySelectorAll('[role="button"]')) {
            const t = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
            if (t.includes('write') || t.includes('quelque') || t.includes('post')) {
              el.click(); return 'fallback:' + t.substring(0,50);
            }
          }
          return 'not found';
        })()`,
        returnByValue: true,
      });
      clickResult = clickEval?.result?.value || "unknown";
    } catch (_) {}
    console.log(`[FbRefreshDocIds] Composer click: ${clickResult}`);

    // Wait for lazy-loaded composer bundles to arrive
    await new Promise(r => setTimeout(r, 8000));

    // ComposerStoryCreateMutation only loads when the post composer modal actually fires.
    // It cannot be pre-loaded via Bootloader or page navigation alone.
    // It self-heals: facebookGroupPost.js browser-fallback captures it via Network.requestWillBeSent.
    // For the other two mutations, use window.require() directly (confirmed working via diagnostics).
    const namesJson = JSON.stringify(Object.keys(FALLBACK_DOC_IDS));

    // Read relay operation modules via window.require
    try {
      const relayResult = await Runtime.evaluate({
        expression: `(function() {
          const names = ${namesJson};
          const out = {};
          for (const name of names) {
            try {
              const val = require(name + '_facebookRelayOperation');
              if (typeof val === 'string' && /^\\d{14,20}$/.test(val)) { out[name] = val; continue; }
              if (val && typeof val.default === 'string') { out[name] = val.default; continue; }
            } catch (_) {}
          }
          return JSON.stringify(out);
        })()`,
        returnByValue: true,
      });
      const fromRegistry = JSON.parse(relayResult?.result?.value || "{}");
      Object.assign(capturedDocIds, fromRegistry);
      console.log("[FbRefreshDocIds] From require():", fromRegistry);
    } catch (_) {}

    const { extractDocIdsFromHtml } = require("./facebookDocIds");
    let pageHtml = "";
    try {
      pageHtml = (await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true }))?.result?.value || "";
      Object.assign(capturedDocIds, extractDocIdsFromHtml(pageHtml));
      for (const name of Object.keys(FALLBACK_DOC_IDS)) {
        const relayKey = `${name}_facebookRelayOperation`;
        const ri = pageHtml.indexOf(relayKey);
        if (ri >= 0) debugLog.htmlSnippets[name] = pageHtml.slice(Math.max(0, ri - 50), ri + 200);
        else {
          const i = pageHtml.indexOf(name);
          debugLog.htmlSnippets[name] = i >= 0 ? pageHtml.slice(Math.max(0, i - 200), i + 300) : "(not found in page HTML)";
        }
      }
    } catch (_) {}

    // Read JS bundle bodies via CDP for any still-missing mutations
    const bundleSearchLog = [];
    const seen = new Set();
    const stillMissing = Object.keys(FALLBACK_DOC_IDS).filter(n => !capturedDocIds[n] && n !== "ComposerStoryCreateMutation");
    if (stillMissing.length > 0) {
      console.log(`[FbRefreshDocIds] Reading ${jsResponses.length} JS bundle bodies via CDP for: ${stillMissing.join(", ")}…`);
      for (const { requestId, url } of jsResponses) {
        if (stillMissing.every(n => capturedDocIds[n])) break;
        if (seen.has(url)) continue;
        seen.add(url);
        let text = "";
        try {
          const resp = await Network.getResponseBody({ requestId });
          text = resp?.base64Encoded ? Buffer.from(resp.body, "base64").toString("utf8") : (resp?.body || "");
        } catch (_) {}
        const found = text ? extractDocIdsFromHtml(text) : {};
        const snippets = {};
        for (const name of stillMissing) {
          if (capturedDocIds[name]) continue;
          const relayKey = `${name}_facebookRelayOperation`;
          const ri = text ? text.indexOf(relayKey) : -1;
          if (ri >= 0) snippets[name] = text.slice(Math.max(0, ri - 50), ri + 200);
          else { const i = text ? text.indexOf(name) : -1; if (i >= 0) snippets[name] = text.slice(Math.max(0, i - 200), i + 300); }
        }
        if (Object.keys(found).length || Object.keys(snippets).length)
          bundleSearchLog.push({ url, sizeKB: Math.round(text.length / 1024), found, snippets });
        if (Object.keys(found).length) Object.assign(capturedDocIds, found);
      }
    }

    debugLog.bundleSearch = bundleSearchLog;
    debugLog.capturedDocIds = capturedDocIds;
    debugLog.allResponseUrls = debugLog.jsUrls;

    // Write debug log to userData
    let debugLogPath = "";
    try {
      const { app } = require("electron");
      debugLogPath = require("path").join(app.getPath("userData"), "fb-docid-debug.json");
      require("fs").writeFileSync(debugLogPath, JSON.stringify(debugLog, null, 2), "utf8");
      console.log(`[FbRefreshDocIds] Debug log written to: ${debugLogPath}`);
    } catch (e) { console.error("[FbRefreshDocIds] Failed to write debug log:", e.message); }

    try { await startResult.client.close(); } catch (_) {}
    try { if (startResult.chromeProcess) startResult.chromeProcess.kill("SIGKILL"); } catch (_) {}

    // Build result with before/after
    const results = {};
    for (const name of Object.keys(FALLBACK_DOC_IDS)) {
      const prev    = getDocId(name);
      const fresh   = capturedDocIds[name] || null;
      const current = fresh || prev;
      if (fresh) updateDocId(name, fresh);
      results[name] = { prev, fresh, current, changed: fresh && fresh !== prev };
    }

    const foundCount = Object.values(results).filter(r => r.fresh).length;
    return { success: true, results, foundCount, total: Object.keys(FALLBACK_DOC_IDS).length, debugLogPath };

  } catch (err) {
    console.error("[FbRefreshDocIds]", err.message);
    return { success: false, error: err.message };
  }
});

// Diagnostics: gather EVERY known Facebook doc_id and report which were found.
// Opens one linked profile in the background, visits the profile page (for the
// Profile* queries) and a group page + composer (for the Group/Composer queries),
// harvesting doc_ids from the live GraphQL requests, the in-page Relay registry,
// and the page bundle HTML. Returns a per-query status so the UI can show ✓ / ✗.
ipcMain.handle("fb-groups-test-doc-ids", async () => {
  const { getDocId, updateMany, extractDocIdsFromHtml, FALLBACK_DOC_IDS } = require("./facebookDocIds");
  const { startVCBrowser } = require("../lib/VCBrowserManager");
  const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../lib/cdpFingerprint");

  let client = null, chromeProcess = null;
  try {
    // Pick any linked profile and resolve its session data.
    const profiles = fbGroupsDb.getAllGroupProfiles();
    if (!profiles || !profiles.length) {
      return { success: false, error: "Link a profile to a group first" };
    }
    const structures = await readKey("structures");
    let chosen = null;
    for (const p of profiles) {
      const pd = structures?.[p.structureId]?.profiles?.[p.profileId];
      if (pd && (pd.cookies || []).length) { chosen = { ...p, profileData: pd }; break; }
    }
    if (!chosen) return { success: false, error: "No linked profile has saved cookies — log one into Facebook first" };

    const profileData = chosen.profileData;
    let fingerprint = profileData.fingerprint || {};
    if (!fingerprint || Object.keys(fingerprint).length === 0)
      fingerprint = getConsistentFingerprintForProfile(chosen.profileId);
    try {
      const v = getVCBrowserVersion();
      if (fingerprint.userAgent && v?.full)
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${v.full}`);
    } catch (_) {}
    const proxy = profileData.proxy?.ip && profileData.proxy.ip !== "NULL" ? profileData.proxy : null;

    const startResult = await startVCBrowser(chosen.profileId, fingerprint, "about:blank", proxy, true, true);
    if (!startResult?.client) return { success: false, error: "Failed to start browser" };
    client = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;
    await Network.enable();

    const capturedDocIds = {};
    Network.requestWillBeSent(({ request }) => {
      try {
        if (request?.url?.includes("facebook.com/api/graphql") && request.postData) {
          const p = new URLSearchParams(request.postData);
          const fn = p.get("fb_api_req_friendly_name");
          const di = p.get("doc_id");
          if (fn && di) capturedDocIds[fn] = di;
        }
      } catch (_) {}
    });

    // Inject cookies
    for (const c of (profileData.cookies || [])) {
      const cc = { name: c.name, value: c.value, domain: c.domain || ".facebook.com",
        path: c.path || "/", secure: c.secure || false, httpOnly: c.httpOnly || false };
      if (c.sameSite) cc.sameSite = c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : "Strict";
      if (c.expires) cc.expires = c.expires;
      try { await Network.setCookie(cc); } catch (_) {}
    }

    const allNames = Object.keys(FALLBACK_DOC_IDS);
    const namesJson = JSON.stringify(allNames);

    // Helper: read the Relay registry + page HTML for all known names.
    const harvest = async () => {
      try {
        const relayEval = await Runtime.evaluate({
          expression: `(function(){
            var names = ${namesJson};
            function shape(v){
              if (!v) return null;
              if (typeof v === "string" && /^\\d{14,20}$/.test(v)) return v;
              if (typeof v.default === "string" && /^\\d{14,20}$/.test(v.default)) return v.default;
              if (v.params && typeof v.params.id === "string" && /^\\d{14,20}$/.test(v.params.id)) return v.params.id;
              if (typeof v.id === "string" && /^\\d{14,20}$/.test(v.id)) return v.id;
              return null;
            }
            return new Promise(function(resolve){
              var out = {}; var pending = 0; var settled = false;
              function finish(){ if(settled) return; settled = true; resolve(JSON.stringify(out)); }
              for (var i=0;i<names.length;i++){
                (function(name){
                  try { var v = require(name + "_facebookRelayOperation"); var s = shape(v); if (s) { out[name] = s; return; } } catch(_){}
                  try { var v2 = require(name); var s2 = shape(v2); if (s2) { out[name] = s2; return; } } catch(_){}
                  try {
                    if (typeof requireLazy === "function") {
                      pending++;
                      requireLazy([name + "_facebookRelayOperation"], function(m){
                        var s3 = shape(m); if (s3) out[name] = s3;
                        pending--; if (pending === 0) finish();
                      });
                    }
                  } catch(_){}
                })(names[i]);
              }
              if (pending === 0) finish();
              setTimeout(finish, 7000);
            });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        let reg = {}; try { reg = JSON.parse(relayEval?.result?.value || "{}"); } catch (_) {}
        Object.assign(capturedDocIds, reg);
        const htmlEval = await Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true });
        const html = htmlEval?.result?.value || "";
        if (html) Object.assign(capturedDocIds, extractDocIdsFromHtml(html));
      } catch (_) {}
    };

    let loggedOut = false;

    // 1) Profile page → Profile* queries
    await Page.navigate({ url: "https://www.facebook.com/me/" });
    await new Promise(r => setTimeout(r, 9000));
    try {
      const u = (await Runtime.evaluate({ expression: "window.location.href", returnByValue: true }))?.result?.value || "";
      if (/\/(login|checkpoint|recover|two_step_verification)/.test(u)) loggedOut = true;
    } catch (_) {}
    if (!loggedOut) await harvest();

    // 2) A group page + composer → Group*/Composer queries
    if (!loggedOut) {
      let groupUrl = null;
      try {
        const groups = fbGroupsDb.getProfileGroups(chosen.profileId);
        if (groups && groups.length) {
          const g = fbGroupsDb.getGroupById(groups[0].groupId);
          groupUrl = (g && g.url) || `https://www.facebook.com/groups/${groups[0].groupId}`;
        }
      } catch (_) {}
      if (groupUrl) {
        await Page.navigate({ url: groupUrl });
        await new Promise(r => setTimeout(r, 9000));
        // Click the composer to lazy-load the post-create mutation bundle.
        try {
          await Runtime.evaluate({
            expression: `(function(){
              var sel = ['[aria-label*="Write"]','[aria-label*="quelque"]','[role="button"][aria-label]','div[contenteditable]'];
              for (var i=0;i<sel.length;i++){ var el=document.querySelector(sel[i]); if(el){ el.click(); el.focus(); return true; } }
              return false;
            })()`,
            returnByValue: true,
          });
        } catch (_) {}
        await new Promise(r => setTimeout(r, 6000));
        await harvest();

        // Click the first post to load the UFI (comment/edit-comment mutations).
        try {
          await Runtime.evaluate({
            expression: `(function(){
              var links = Array.from(document.querySelectorAll('a[href*="/posts/"],a[href*="/permalink/"]'));
              if (links.length) { links[0].click(); return true; }
              return false;
            })()`,
            returnByValue: true,
          });
          await new Promise(r => setTimeout(r, 7000));
          await harvest();

          // The edit-comment mutation bundle is lazy-loaded only when the "⋯" (More)
          // menu of one of OUR OWN comments is opened. Best-effort: find a comment
          // authored by this profile, open its menu to force-load the bundle, then
          // harvest again. No posting/deleting — purely passive, never spams the group.
          try {
            const cUser = (() => {
              try {
                const ck = (profileData.cookies || []).find(c => c.name === "c_user");
                return ck ? String(ck.value) : null;
              } catch (_) { return null; }
            })();
            if (cUser) {
              const opened = await Runtime.evaluate({
                expression: `(function(){
                  return new Promise(function(resolve){
                    try {
                      var uid = ${JSON.stringify(String(cUser))};
                      var moreLabels = ["More","Plus","More options","Actions for this comment",
                                        "Autres","Plus d'options","المزيد","خيارات","إجراءات"];
                      // Find a comment article that links to our own profile id.
                      var ownLinks = Array.prototype.slice.call(
                        document.querySelectorAll('a[href*="/user/'+uid+'"],a[href*="id='+uid+'"],a[href*="/'+uid+'"]'));
                      for (var k=0;k<ownLinks.length;k++){
                        var art = ownLinks[k].closest ? ownLinks[k].closest('[role="article"]') : null;
                        if (!art) continue;
                        var btns = art.querySelectorAll('[aria-label][role="button"],[aria-haspopup="menu"]');
                        for (var i=0;i<btns.length;i++){
                          var lab = (btns[i].getAttribute("aria-label")||"");
                          for (var j=0;j<moreLabels.length;j++){
                            if (lab.indexOf(moreLabels[j]) !== -1){
                              btns[i].scrollIntoView({block:"center"});
                              btns[i].click();
                              setTimeout(function(){
                                try { document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,bubbles:true})); } catch(_){}
                                resolve(true);
                              }, 2000);
                              return;
                            }
                          }
                        }
                      }
                      resolve(false);
                    } catch(_) { resolve(false); }
                  });
                })()`,
                returnByValue: true,
                awaitPromise: true,
              });
              if (opened?.result?.value) {
                await new Promise(r => setTimeout(r, 900));
                await harvest();
              }
            }
          } catch (_) {}
        } catch (_) {}
      }
    }

    try { await client.close(); } catch (_) {}
    client = null;

    if (loggedOut) {
      return { success: false, error: `Profile "${chosen.profileLabel || chosen.profileId}" is logged out of Facebook` };
    }

    // Persist everything we gathered, then build a per-query report.
    updateMany(capturedDocIds);
    // Mutations that Facebook only exposes on-demand (e.g. when the user opens the
    // Edit menu of their own comment) can't always be harvested passively. They are
    // captured automatically the first time the matching automation runs, so we mark
    // them as "on demand" rather than a hard failure.
    const ON_DEMAND = new Set(["useCometUFIEditCommentMutation"]);
    const results = allNames.map((name) => {
      const fresh = capturedDocIds[name] || null;
      return {
        name,
        gathered: !!fresh,
        onDemand: !fresh && ON_DEMAND.has(name),
        docId: fresh || getDocId(name) || null,
        fromLive: !!fresh,
      };
    });
    const foundCount = results.filter(r => r.gathered).length;
    return {
      success: true,
      profileLabel: chosen.profileLabel || chosen.profileId,
      foundCount,
      total: allNames.length,
      results,
    };
  } catch (err) {
    console.error("[FbTestDocIds]", err.message);
    return { success: false, error: err.message };
  } finally {
    if (client) { try { await client.close(); } catch (_) {} }
    if (chromeProcess) { try { chromeProcess.kill("SIGKILL"); } catch (_) {} }
  }
});

// ============================================
// FB GROUPS — IMPORTED WORKFLOWS & AUTOMATION
// ============================================

ipcMain.handle("fb-groups-import-workflow", async (_, workflowId, name, settings, groupTargets) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    fbGroupsDb.importWorkflow(workflowId, name || workflowId, settings || {});
    if (Array.isArray(groupTargets) && groupTargets.length > 0) {
      fbGroupsDb.setWorkflowGroupTargets(workflowId, groupTargets);
    }
    return { success: true, data: fbGroupsDb.getImportedWorkflowById(workflowId) };
  } catch (err) {
    console.error("[fb-groups-import-workflow]", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-remove-imported-workflow", async (_, workflowId) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    fbGroupsScheduler.cancelWorkflow(workflowId);
    fbGroupsDb.removeImportedWorkflow(workflowId);
    return { success: true };
  } catch (err) {
    console.error("[fb-groups-remove-imported-workflow]", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-imported-workflows", async () => {
  try {
    const rows = fbGroupsDb.getImportedWorkflows();
    const enriched = rows.map(wf => {
      const postCount = wf.isManual
        ? fbGroupsDb.getWorkflowLibraryPostCount(wf.workflowId)
        : (workflowDb.getWorkflowPosts(wf.workflowId) || []).length;

      // Auto-mark completed: if this is a non-loop workflow with posts sent and
      // all group targets are at (sentCount % postCount === 0) — mark it now in
      // case the scheduler missed the IPC event (e.g. event fired while page was unloaded).
      if (!wf.loopWorkflow && !wf.isCompleted && wf.status === 'active' && postCount > 0) {
        const targets = fbGroupsDb.getWorkflowGroupTargets(wf.workflowId).filter(t => t.enabled);
        if (targets.length > 0) {
          const allDone = targets.every(t => {
            const sc = fbGroupsDb.getAutomationPostSentCount(wf.workflowId, t.groupId);
            return sc > 0 && (sc % postCount) === 0;
          });
          if (allDone) {
            fbGroupsDb.updateImportedWorkflowStatus(wf.workflowId, 'paused', true);
            wf.status      = 'paused';
            wf.isCompleted = 1;
          }
        }
      }

      return { ...wf, workflowPostCount: postCount };
    });
    return { success: true, data: enriched };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-create-manual-workflow", async (_, name, settings, groupTargets) => {
  try {
    if (!name) return { success: false, error: "Missing name" };
    const workflowId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    fbGroupsDb.importWorkflow(workflowId, name, { ...settings, isManual: true, status: 'active' });
    if (Array.isArray(groupTargets) && groupTargets.length > 0) {
      fbGroupsDb.setWorkflowGroupTargets(workflowId, groupTargets);
    }
    return { success: true, data: fbGroupsDb.getImportedWorkflowById(workflowId) };
  } catch (err) {
    console.error("[fb-groups-create-manual-workflow]", err.message);
    return { success: false, error: err.message };
  }
});

// ── Posts Library ─────────────────────────────────────────────────────────────

ipcMain.handle("fb-groups-get-library-posts", async () => {
  try {
    return { success: true, data: fbGroupsDb.getLibraryPosts() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-add-library-post", async (_, name, text, imagePath, url) => {
  try {
    // If imagePath is a remote URL, download it locally first
    if (imagePath && imagePath.startsWith("http")) {
      try {
        const fileName = await downloadFileToUserData(imagePath);
        imagePath = path.join(app.getPath("userData"), "Images", fileName);
      } catch (dlErr) {
        console.warn("[FB-LIB] Could not download image URL:", dlErr.message);
      }
    }
    const post = fbGroupsDb.createLibraryPost(name, text, imagePath, url);
    return { success: true, data: post };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-update-library-post", async (_, id, name, text, imagePath, url) => {
  try {
    if (!id) return { success: false, error: "Missing id" };
    // If imagePath is a remote URL, download it locally first
    if (imagePath && imagePath.startsWith("http")) {
      try {
        const fileName = await downloadFileToUserData(imagePath);
        imagePath = path.join(app.getPath("userData"), "Images", fileName);
      } catch (dlErr) {
        console.warn("[FB-LIB] Could not download image URL:", dlErr.message);
      }
    }
    const post = fbGroupsDb.updateLibraryPost(id, name, text, imagePath, url);
    return { success: true, data: post };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-delete-library-post", async (_, id) => {
  try {
    if (!id) return { success: false, error: "Missing id" };
    fbGroupsDb.deleteLibraryPost(id);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// CSV bulk import for Posts Library
ipcMain.handle("fb-groups-import-library-csv", async (_, csvText) => {
  const results = { imported: 0, skipped: 0, errors: [] };
  try {
    // Robust RFC 4180 CSV parser:
    // - Fields may be quoted with double-quotes
    // - Quoted fields may contain commas, newlines (\n or \r\n), and escaped quotes ("")
    // - Unquoted fields end at comma or newline
    // - Handles \r\n, \n, and bare \r as line endings outside quoted fields
    const parseCSVRobust = (text) => {
      const rows = [];
      let fields = [];
      let cur = "";
      let i = 0;
      const len = text.length;

      while (i < len) {
        const ch = text[i];

        if (ch === '"') {
          // Quoted field — consume until closing unescaped quote
          i++;
          while (i < len) {
            const qch = text[i];
            if (qch === '"') {
              if (text[i + 1] === '"') {
                cur += '"'; i += 2; // escaped quote
              } else {
                i++; break; // end of quoted field
              }
            } else {
              cur += qch; i++;
            }
          }
          // After closing quote, skip optional whitespace until comma or newline
          while (i < len && text[i] === ' ') i++;
        } else if (ch === ',') {
          fields.push(cur); cur = ""; i++;
        } else if (ch === '\r' || ch === '\n') {
          // End of record
          fields.push(cur); cur = "";
          rows.push(fields); fields = [];
          if (ch === '\r' && text[i + 1] === '\n') i += 2;
          else i++;
        } else {
          cur += ch; i++;
        }
      }
      // Last field/row
      if (cur || fields.length) { fields.push(cur); rows.push(fields); }
      return rows;
    };

    const rows = parseCSVRobust(csvText);

    // Skip header row
    const dataRows = rows.slice(1).filter(r => r.some(c => c.trim()));

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const imageUrlRaw = (row[0] || "").trim();
      const text        = (row[1] || "").trim();
      const articleUrl  = (row[2] || "").trim() || null;

      if (!text) { results.skipped++; continue; }

      let imagePath = null;
      if (imageUrlRaw && imageUrlRaw.startsWith("http")) {
        try {
          const fileName = await downloadFileToUserData(imageUrlRaw);
          imagePath = path.join(app.getPath("userData"), "Images", fileName);
        } catch (dlErr) {
          results.errors.push(`Row ${i + 2}: image download failed — ${dlErr.message}`);
          console.warn(`[FB-LIB-CSV] Row ${i + 2} image download failed:`, dlErr.message);
          // Continue — create post without image
        }
      }

      try {
        fbGroupsDb.createLibraryPost("", text, imagePath, articleUrl);
        results.imported++;
      } catch (dbErr) {
        results.errors.push(`Row ${i + 2}: DB error — ${dbErr.message}`);
        results.skipped++;
      }
    }
    return { success: true, ...results };
  } catch (err) {
    return { success: false, error: err.message, ...results };
  }
});

ipcMain.handle("fb-groups-pick-library-post-image", async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select post image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (canceled || !filePaths.length) return { success: false };
    const src  = filePaths[0];
    const dir  = path.join(app.getPath("userData"), "Uploads", "PostsLibrary");
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `pl_${Date.now()}_${path.basename(src)}`);
    await fs.copyFile(src, dest);
    return { success: true, path: dest };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-workflow-library-posts", async (_, workflowId) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    return { success: true, data: fbGroupsDb.getWorkflowLibraryPosts(workflowId) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-set-workflow-library-posts", async (_, workflowId, postIds) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    fbGroupsDb.setWorkflowLibraryPosts(workflowId, postIds || []);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-imported-workflow-ids", async () => {
  try {
    return { success: true, data: fbGroupsDb.getImportedWorkflowIds() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-workflow-settings", async (_, workflowId) => {
  try {
    const data = fbGroupsDb.getImportedWorkflowById(workflowId);
    if (!data) return { success: false, error: "Workflow not found" };
    const targets = fbGroupsDb.getWorkflowGroupTargets(workflowId);
    return { success: true, data: { ...data, targets } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-update-workflow-settings", async (_, workflowId, settings) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    fbGroupsDb.updateImportedWorkflowSettings(workflowId, settings || {});
    return { success: true, data: fbGroupsDb.getImportedWorkflowById(workflowId) };
  } catch (err) {
    console.error("[fb-groups-update-workflow-settings]", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-set-workflow-status", async (_, workflowId, status) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    fbGroupsDb.updateImportedWorkflowStatus(workflowId, status);
    // Fire the first post immediately when activating a workflow
    if (status === 'active') fbGroupsScheduler.runWorkflowNow(workflowId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-restart-workflow", async (_, workflowId) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    fbGroupsDb.resetWorkflowForRestart(workflowId);
    // Fire the first post immediately after restart
    setTimeout(() => fbGroupsScheduler.runWorkflowNow(workflowId), 300);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-update-workflow-targets", async (_, workflowId, targets) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    fbGroupsDb.setWorkflowGroupTargets(workflowId, targets || []);
    return { success: true, data: fbGroupsDb.getWorkflowGroupTargets(workflowId) };
  } catch (err) {
    console.error("[fb-groups-update-workflow-targets]", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-dashboard-stats", async () => {
  try {
    return { success: true, data: fbGroupsDb.getDashboardStats() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-recent-activity", async (_, limit) => {
  try {
    return { success: true, data: fbGroupsDb.getRecentAutomationPosts(limit || 15) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-posts-feed", async (_, limit, offset, vmStatus) => {
  try {
    return { success: true, data: fbGroupsDb.getAutomationPostsFeed(limit || 10, offset || 0, vmStatus || null) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-expired-posts-feed", async (_, limit, offset) => {
  try {
    return { success: true, data: fbGroupsDb.getExpiredPostsFeed(limit || 100, offset || 0) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-refresh-expired-stats", async (_, storyId) => {
  try {
    if (!storyId) return { success: false, error: "Missing storyId" };
    return await fbGroupsScheduler.refreshExpiredStats(storyId);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-force-check-monitor", async (_, storyId) => {
  try {
    if (!storyId) return { success: false, error: "Missing storyId" };
    return await fbGroupsScheduler.forceCheckMonitor(storyId);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-stop-monitor", async (_, automationPostId) => {
  try {
    if (!automationPostId) return { success: false, error: "Missing automationPostId" };
    fbGroupsDb.stopViralMonitorByPostId(automationPostId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-delete-post", async (_, automationPostId) => {
  try {
    if (!automationPostId) return { success: false, error: "Missing automationPostId" };
    fbGroupsDb.deleteAutomationPost(automationPostId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-automation-posts", async (_, workflowId, limit, offset) => {
  try {
    if (!workflowId) return { success: false, error: "Missing workflowId" };
    return { success: true, data: fbGroupsDb.getAutomationPostsByWorkflow(workflowId, limit || 20, offset || 0) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-viral-monitors", async (_, status) => {
  try {
    const data = status ? fbGroupsDb.getActiveViralMonitors() : fbGroupsDb.getViralMonitorHistory(50);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-pause-monitoring", async () => {
  try {
    const settings = (await readKey("fbGroupsGlobalSettings")) || {};
    settings.viralMonitoringPaused = true;
    await updateData("fbGroupsGlobalSettings", settings);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-resume-monitoring", async (_, daysAgo) => {
  try {
    const settings = (await readKey("fbGroupsGlobalSettings")) || {};
    settings.viralMonitoringPaused = false;
    await updateData("fbGroupsGlobalSettings", settings);
    // Reset next_check_at for monitors matching the requested window so they
    // are picked up on the very next monitor tick.
    const resetCount = fbGroupsDb.resetMonitorCheckTimes(daysAgo ?? null);
    console.log(`[FbGroups] resume-monitoring: reset ${resetCount} monitor(s) (daysAgo=${daysAgo ?? "all"})`);
    return { success: true, resetCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-viral-monitor-history", async (_, limit) => {
  try {
    return { success: true, data: fbGroupsDb.getViralMonitorHistory(limit || 20) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-live-logs", async () => {
  try {
    return { success: true, data: fbGroupsScheduler.getLiveLogs() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-analytics", async (_, daysAgo) => {
  try {
    return { success: true, data: fbGroupsDb.getAnalyticsData(daysAgo || 7) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-settings", async () => {
  try {
    const data = (await readKey("fbGroupsGlobalSettings")) || {};
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-settings error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-save-settings", async (_, settings) => {
  try {
    const existing = (await readKey("fbGroupsGlobalSettings")) || {};
    await updateData("fbGroupsGlobalSettings", { ...existing, ...settings });
    // If the "Stop monitoring after (hours)" window changed, recompute expires_at
    // for all active monitors (it's otherwise frozen at creation) so the new
    // window applies retroactively and any now-overdue posts expire immediately.
    try {
      const newHours = Number(settings?.viralExpiryHours);
      if (newHours > 0 && newHours !== Number(existing?.viralExpiryHours)) {
        const { recomputed, expired } = fbGroupsDb.recomputeViralExpiry(newHours);
        console.log(`[FbGroups] viralExpiryHours changed to ${newHours}h — recomputed ${recomputed} monitor(s), expired ${expired}`);
      }
    } catch (e) {
      console.error("[FbGroups] recomputeViralExpiry error:", e.message);
    }
    return { success: true };
  } catch (err) {
    console.error("[FbGroups] save-settings error:", err.message);
    return { success: false, error: err.message };
  }
});

// ── Profiles monitoring page ──────────────────────────────────────────────
// Overview of every profile attached to a group: lifetime stats, today's count
// vs the daily cap, and the live "what is it doing now" activity from the scheduler.
ipcMain.handle("fb-groups-get-profiles-overview", async () => {
  try {
    const settings = (await readKey("fbGroupsGlobalSettings")) || {};
    const cap = typeof settings.dailyPostingCap === "number" ? settings.dailyPostingCap : 20;
    const warmupEnabled = settings.warmupEnabled !== false;

    const profiles = fbGroupsDb.getAllGroupProfiles();
    const sinceIso = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); })();
    const todayCounts = fbGroupsDb.getProfilesSentCountToday(sinceIso);
    const activityList = fbGroupsScheduler.getProfileActivity();
    const activityMap = {};
    for (const a of activityList) activityMap[a.profileId] = a;

    const data = profiles.map((p) => {
      const stats = fbGroupsDb.getProfileStats(p.profileId);
      const scan = fbGroupsDb.getProfileScan(p.profileId);
      // Warm-up: a profile is "new" (still ramping) until 7 days after its first
      // successful post. Mirrors scheduler._getWarmupCap tiers.
      let warmupActive = false;
      if (warmupEnabled) {
        let firstIso = null;
        try { firstIso = fbGroupsDb.getProfileFirstSentAt(p.profileId); } catch (_) {}
        if (!firstIso) warmupActive = true;
        else warmupActive = ((Date.now() - new Date(firstIso).getTime()) / 86400000) < 7;
      }
      return {
        profileId:      p.profileId,
        profileLabel:   p.profileLabel || p.profileId,
        structureId:    p.structureId || "",
        structureLabel: p.structureLabel || "",
        groupCount:     p.groupCount || 0,
        sentTotal:      stats.sentCount || 0,
        failedTotal:    stats.failedCount || 0,
        lastPostedAt:   stats.lastPostedAt || null,
        sentToday:      todayCounts[p.profileId] || 0,
        dailyCap:       cap,
        warmupActive:   warmupActive,
        activity:       activityMap[p.profileId] || null,
        // Cached Facebook scan (login health + identity)
        loggedIn:       scan ? scan.loggedIn : null,
        scanInfo:       scan ? scan.scanInfo : null,
        scanError:      scan ? scan.scanError : null,
        lastScannedAt:  scan ? scan.lastScannedAt : null,
      };
    });
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-profiles-overview error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-profile-detail", async (_, profileId) => {
  try {
    if (!profileId) return { success: false, error: "Missing profileId" };
    const stats = fbGroupsDb.getProfileStats(profileId);
    const groups = fbGroupsDb.getProfileGroups(profileId);
    const history = fbGroupsDb.getProfilePostHistory(profileId, 20, 0);
    const activity = fbGroupsScheduler.getProfileActivity().find((a) => a.profileId === profileId) || null;
    return { success: true, data: { stats, groups, history, activity } };
  } catch (err) {
    console.error("[FbGroups] get-profile-detail error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-profile-history", async (_, args) => {
  try {
    const { profileId, limit, offset } = args || {};
    if (!profileId) return { success: false, error: "Missing profileId" };
    const data = fbGroupsDb.getProfilePostHistory(profileId, limit || 20, offset || 0);
    return { success: true, data };
  } catch (err) {
    console.error("[FbGroups] get-profile-history error:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-get-profile-activity", async () => {
  try {
    return { success: true, data: fbGroupsScheduler.getProfileActivity() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fb-groups-scheduler-start", async () => {
  try { fbGroupsScheduler.start(); return { success: true }; } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle("fb-groups-scheduler-stop", async () => {
  try { fbGroupsScheduler.stop(); return { success: true }; } catch (err) { return { success: false, error: err.message }; }
});

// ── FB Groups AI Prompts (stored in storage.db as "fbGroupsAiPrompts") ──────
ipcMain.handle("fb-groups-get-ai-prompts", async () => {
  try {
    const prompts = (await readKey("fbGroupsAiPrompts")) || [];
    return { success: true, data: Array.isArray(prompts) ? prompts : [] };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle("fb-groups-get-connected-ai-providers", async () => {
  try {
    const [openaiKeys, anthropicKeys, googleaiKeys, openrouterKeys, chineseaiKeys, deepseekBrowserProfiles, qwenBrowserProfiles] = await Promise.all([
      readKey("openaiKeys"),
      readKey("anthropicKeys"),
      readKey("googleaiKeys"),
      readKey("openrouterKeys"),
      readKey("chineseaiKeys"),
      readKey("deepseekBrowserProfiles"),
      readKey("qwenBrowserProfiles"),
    ]);
    const hasKeys = (obj) => Object.keys(obj || {}).length > 0;
    const hasAnyChineseKeys = hasKeys(chineseaiKeys);
    return {
      success: true,
      data: {
        openai:          hasKeys(openaiKeys),
        anthropic:       hasKeys(anthropicKeys),
        googleai:        hasKeys(googleaiKeys),
        openrouter:      hasKeys(openrouterKeys),
        deepseek:        hasAnyChineseKeys,
        qwen:            hasAnyChineseKeys,
        zhipu:           hasAnyChineseKeys,
        moonshot:        hasAnyChineseKeys,
        deepseekbrowser: hasKeys(deepseekBrowserProfiles),
        qwenbrowser:     hasKeys(qwenBrowserProfiles),
      }
    };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle("fb-groups-save-ai-prompt", async (_, prompt) => {
  // prompt = { id, name, text }
  try {
    if (!prompt?.id || !prompt?.name || !prompt?.text) return { success: false, error: "Invalid prompt" };
    let prompts = (await readKey("fbGroupsAiPrompts")) || [];
    if (!Array.isArray(prompts)) prompts = [];
    const idx = prompts.findIndex(p => p.id === prompt.id);
    if (idx >= 0) prompts[idx] = prompt;
    else prompts.push(prompt);
    await updateData("fbGroupsAiPrompts", prompts);
    return { success: true, data: prompts };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle("fb-groups-delete-ai-prompt", async (_, promptId) => {
  try {
    let prompts = (await readKey("fbGroupsAiPrompts")) || [];
    if (!Array.isArray(prompts)) prompts = [];
    prompts = prompts.filter(p => p.id !== promptId);
    await updateData("fbGroupsAiPrompts", prompts);
    return { success: true, data: prompts };
  } catch (err) { return { success: false, error: err.message }; }
});

module.exports = { registerIpcHandlers, autoExportVideo };
