const path = require("path");
const fs = require("fs");
const { ipcMain, BrowserWindow, app } = require("electron");

const {
  googleSites,
  stopWorkflowQueues: stopGoogleSitesQueues,
} = require("../automations/googleSites");
const { uploadImage } = require("../automations/uploadImage");
const { uploadVideo } = require("../automations/uploadVideo");
const {
  startImageRequest,
  stopWorkflowQueues: stopMidjourneyQueues,
  clearWorkflowStateForRerun: clearMidjourneyStateForRerun,
} = require("../automations/midjourneyV2");
const {
  startImageRequest: startChatGPTImageRequest,
  stopWorkflowQueues: stopChatGPTImageQueues,
  clearWorkflowStateForRerun: clearChatGPTImageStateForRerun,
} = require("../automations/chatgptImage");
const {
  startChatRequest: startChatGPTChatRequest,
  stopWorkflowQueues: stopChatGPTChatQueues,
  clearWorkflowStateForRerun: clearChatGPTChatStateForRerun,
  closeAllBrowserSessions: closeChatGPTChatBrowserSessions,
} = require("../automations/chatgptChat");
const { miniCanvas } = require("../automations/minicanvas");
const { videoEditor } = require("../automations/videoeditor");
const { openAi } = require("../automations/openai");
const { wordPress } = require("../automations/wordPress");
const { wordpressGet } = require("../automations/wordpressGet");
const { wpRecipeMaker } = require("../automations/wpRecipeMaker");
const { executeCurl } = require("../automations/curlRequest");
const { advancedCurl } = require("../automations/advancedCurl");
const { serpApiSearch } = require("../automations/serpapi");
const { openAmazonProduct } = require("../automations/amazonCrawl");
const { downloadImage } = require("../automations/imageDownloader");
const { videoToImage } = require("../automations/videoToImage");
const { parseJson } = require("../automations/jsonParser");
const { amazonAffLink } = require("../automations/amazonAffLink");
const { textToSpeech } = require("../automations/textToSpeech");
const { humanize } = require("../automations/humanize");

// New AI model integrations
const { openRouter } = require("../automations/openrouter");
const { googleAI, googleAIImage } = require("../automations/googleai");
const { anthropic } = require("../automations/anthropic");
const { chineseAI } = require("../automations/chineseai");
const { deepseekBrowser } = require("../automations/deepseekBrowser");
const { qwenBrowser } = require("../automations/qwenBrowser");
const { gptImage } = require("../automations/gptimage");
const { vcai } = require("../automations/vcai");
const {
  startImageRequest: startGeminiImageRequest,
  stopWorkflowQueues: stopGeminiImageQueues,
  clearWorkflowStateForRerun: clearGeminiImageStateForRerun,
} = require("../automations/geminiImage");
const {
  startVideoRequest: startVeoVideoRequest,
  stopWorkflowQueues: stopVeoQueues,
  clearWorkflowStateForRerun: clearVeoStateForRerun,
} = require("../automations/googleDocsVeo");
const {
  soraImage,
  stopWorkflowQueues: stopSoraImageQueues,
  clearWorkflowStateForRerun: clearSoraImageStateForRerun,
  isProfileExhausted: isSoraProfileExhausted,
  getExhaustedProfiles: getSoraExhaustedProfiles,
} = require("../automations/soraImage");
const { soraVideo } = require("../automations/soraVideo");
const {
  metaaiImage,
  metaaiVideo,
  stopWorkflowQueues: stopMetaAIQueues,
  clearWorkflowStateForRerun: clearMetaAIStateForRerun,
  getProfileLoad: getMetaAIProfileLoad,
} = require("../automations/metaai");
const {
  tiktokAdsImage,
  stopWorkflowQueues: stopTikTokAdsImageQueues,
  clearWorkflowStateForRerun: clearTikTokAdsImageStateForRerun,
} = require("../automations/tiktokAdsImage");
const {
  tiktokAdsVideo,
  stopWorkflowQueues: stopTikTokAdsVideoQueues,
  clearWorkflowStateForRerun: clearTikTokAdsVideoStateForRerun,
} = require("../automations/tiktokAdsVideo");

const { readKey, updateData, moveToPermStorage, decryptWithMigration } = require("./utils");
const { workflowQueue } = require("./workflowQueue");
const workflowDb = require("./database");
const { getAnalyticsDatabase } = require("./analyticsDatabase");
async function resolveUploadProvider(mediaType) {
  const isImage = mediaType === "image";
  const preferenceName = isImage ? "imageProvider" : "videoProvider";
  const credentialsKey = isImage ? "imageUploadKeys" : "videoUploadKeys";
  const preferences = (await readKey("mediaHostingPreferences")) || {};
  const savedProviders = (await readKey(credentialsKey)) || {};
  let provider = preferences[preferenceName];

  if (!provider) {
    // Older settings screens displayed the first connected provider as selected
    // without persisting it. Repair that state once so existing installations
    // immediately match what the user sees in Settings.
    const fallbackProvider = Object.entries(savedProviders).find(([, entry]) =>
      entry && entry.apiKey && entry.status !== "inactive"
    )?.[0];

    if (!fallbackProvider) {
      return {
        error: `No default ${mediaType} hosting provider is selected. Open Settings > Media Hosting and select one.`,
      };
    }

    provider = fallbackProvider;
    preferences[preferenceName] = provider;
    await updateData("mediaHostingPreferences", preferences);
  }

  const savedProvider = savedProviders[provider];
  if (!savedProvider || !savedProvider.apiKey || savedProvider.status === "inactive") {
    return {
      error: `The default ${mediaType} hosting provider "${provider}" is not configured. Open Settings > Media Hosting and connect it, or select another default.`,
    };
  }

  return { provider, apiKey: savedProvider.apiKey };
}

function uploadProviderLabel(provider) {
  const labels = {
    imgbb: "ImgBB",
    cloudinary: "Cloudinary",
    "imagekit.io": "ImageKit.io",
    "freeimage.host": "FreeImage.host",
    streamable: "Streamable",
    "cloudflare-r2": "Cloudflare R2",
  };
  return labels[provider] || provider || "Unknown provider";
}

function formatUploadProviderError(mediaType, provider, error) {
  const status = error?.response?.status;
  const remoteMessage = error?.response?.data?.error?.message
    || error?.response?.data?.message
    || error?.message
    || "Unknown upload error";
  const statusText = status ? ` (HTTP ${status})` : "";
  return `${uploadProviderLabel(provider)} ${mediaType} upload failed${statusText}: ${remoteMessage}`;
}

// Sora Image profile rotation index (round-robin across enabled profiles)
let soraProfileRotationIndex = 0;

// Create logs directory for node failure logging
const logsDir = path.join(app.getPath("userData"), "Logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const nodeFailureLogPath = path.join(logsDir, "node-failures.log");
const automationDebugLogPath = path.join(logsDir, "automation-debug.log");

// Comprehensive debug logger for automation troubleshooting
function logAutomationDebug(event, data = null) {
  try {
    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] [${event}]`;
    if (data) {
      // Truncate very long values (e.g. base64 images) to keep log readable
      const sanitized = JSON.stringify(data, (key, value) => {
        if (typeof value === 'string' && value.length > 500) {
          return value.substring(0, 500) + `... (${value.length} chars)`;
        }
        return value;
      });
      logEntry += ` ${sanitized}`;
    }
    logEntry += "\n";
    fs.appendFileSync(automationDebugLogPath, logEntry, "utf8");
  } catch (err) {
    // Silently fail - debug logging should never break execution
  }
}

// Function to log node failures to file
function logNodeFailureToFile(failureData) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      ...failureData,
    };

    const logLine = JSON.stringify(logEntry) + "\n";
    fs.appendFileSync(nodeFailureLogPath, logLine, "utf8");

    console.log(`[NODE FAILURE LOG] Logged to: ${nodeFailureLogPath}`);
  } catch (logError) {
    console.error(`[NODE FAILURE LOG] Failed to write: ${logError.message}`);
  }
}

// Node timeouts are now managed by individual automation files

// ==================== Halal Mode Filter ====================
// Checks if a string looks like a file path or URL (should not be filtered)
function _isFileOrUrl(str) {
  return (
    /^https?:\/\//i.test(str) ||
    /^file:\/\//i.test(str) ||
    /^[a-zA-Z]:[/\\]/.test(str) ||
    /^\/[^/]/.test(str)
  );
}

// Applies halal replacement list to a text string.
// Uses word-boundary matching for ASCII words; substring matching for non-ASCII.
function applyHalalFilter(text, replacements) {
  if (typeof text !== "string" || !text || _isFileOrUrl(text)) return text;
  let result = text;
  for (const { haram, halal } of replacements) {
    if (!haram || !halal) continue;
    const h = haram.trim();
    if (!h) continue;
    // Detect whether the term is pure ASCII (use word boundary) or contains non-ASCII (substring)
    const isAscii = /^[\x00-\x7F]+$/.test(h);
    try {
      if (isAscii) {
        result = result.replace(new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), halal.trim());
      } else {
        result = result.replace(new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), halal.trim());
      }
    } catch (_e) {
      // Invalid regex — skip this entry silently
    }
  }
  return result;
}
// ===========================================================

const workflowControllers = new Map(); // workflowId -> { controllers: Set, queues: Set }
const splitImageResolvers = new Map();
const workflowImagePreferences = new Map(); // workflowId -> { enabled: boolean, selectedIndexes: number[] }
const workflowSkipModes = new Map(); // workflowId -> boolean (skip image choosing)
const pendingImageSelections = new Map(); // workflowId -> Set of requestIds

// OpenAI queue manager handles key rotation and rate limiting automatically

// Function to set skip mode for a workflow (used during testing to skip image selection modals)
function setSkipModeForWorkflow(workflowId, skipMode) {
  if (skipMode) {
    workflowSkipModes.set(workflowId, true);
    console.log(`[Skip Mode] Enabled for workflow: ${workflowId}`);
  } else {
    workflowSkipModes.delete(workflowId);
    console.log(`[Skip Mode] Disabled for workflow: ${workflowId}`);
  }
}

ipcMain.on(
  "split-images-selected",
  (event, respId, indexes, workflowPreference) => {
    const entry = splitImageResolvers.get(respId);
    if (entry) {
      // Store workflow preference if provided
      if (
        workflowPreference &&
        workflowPreference.enabled &&
        entry.workflowId
      ) {
        workflowImagePreferences.set(entry.workflowId, {
          enabled: true,
          selectedIndexes: indexes,
        });

        // Auto-resolve other pending selections for this workflow
        const pending = pendingImageSelections.get(entry.workflowId);
        if (pending && pending.size > 1) {
          const otherRequestIds = Array.from(pending).filter(
            (id) => id !== respId,
          );

          // Notify frontend to auto-resolve other modals
          const window = BrowserWindow.getAllWindows()[0];
          if (window) {
            window.webContents.send("auto-resolve-pending-selections", {
              workflowId: entry.workflowId,
              requestIds: otherRequestIds,
              selectedIndexes: indexes,
            });
          }

          // Auto-resolve the backend resolvers
          otherRequestIds.forEach((requestId) => {
            const otherEntry = splitImageResolvers.get(requestId);
            if (otherEntry) {
              otherEntry.resolve(indexes);
              splitImageResolvers.delete(requestId);
            }
          });

          // Clear pending selections for this workflow
          pendingImageSelections.delete(entry.workflowId);
        }
      }

      // Remove this request from pending selections
      const pending = pendingImageSelections.get(entry.workflowId);
      if (pending) {
        pending.delete(respId);
        if (pending.size === 0) {
          pendingImageSelections.delete(entry.workflowId);
        }
      }

      entry.resolve(indexes);
      splitImageResolvers.delete(respId);
    }
  },
);

// Add IPC handler for workflow skip mode (using handle for sync confirmation)
ipcMain.handle("set-workflow-skip-mode", (event, workflowId, skipMode) => {
  console.log(`[SkipMode] ========== IPC HANDLER CALLED ==========`);
  console.log(`[SkipMode] workflowId: ${workflowId}`);
  console.log(`[SkipMode] skipMode: ${skipMode}`);
  console.log(
    `[SkipMode] workflowSkipModes BEFORE:`,
    Array.from(workflowSkipModes.entries()),
  );

  if (skipMode) {
    workflowSkipModes.set(workflowId, true);
    console.log(
      `[SkipMode] ✅ ENABLED skip image choosing for workflow ${workflowId}`,
    );
  } else {
    workflowSkipModes.delete(workflowId);
    console.log(
      `[SkipMode] ❌ DISABLED skip image choosing for workflow ${workflowId}`,
    );
  }

  console.log(
    `[SkipMode] workflowSkipModes AFTER:`,
    Array.from(workflowSkipModes.entries()),
  );
  console.log(`[SkipMode] ========================================`);
  return true; // Confirm the mode was set
});

// Timeout management moved to individual automation files

// Execute a sub-automation graph (inner Drawflow of a SubAutomation node)
async function executeSubGraph(
  workflowId,
  postId,
  innerNodes,
  parentInputs,
  sendLog,
  abortSignal,
  retryCount = 3,
) {
  // Build dependency graph (same pattern as executeAutomation)
  const nodeMap = {};
  const outputsMap = {};
  const dependencies = {};
  const reverseDependencies = {};
  const pendingInputsCount = {};

  innerNodes.forEach((node) => {
    const nId = String(node.id);
    nodeMap[nId] = node;
    dependencies[nId] = {};
    reverseDependencies[nId] = {};
    pendingInputsCount[nId] = Object.values(node.inputs).filter(
      (inp) => inp.connections && inp.connections.length > 0,
    ).length;
  });

  innerNodes.forEach((node) => {
    const nId = String(node.id);
    Object.entries(node.inputs).forEach(([inputName, inputData]) => {
      if (inputData.connections && inputData.connections.length > 0) {
        const conn = inputData.connections[0];
        const srcId = String(conn.node);
        dependencies[nId][inputName] = { nodeId: srcId, outputName: conn.input };
        if (!reverseDependencies[srcId][conn.input]) {
          reverseDependencies[srcId][conn.input] = [];
        }
        reverseDependencies[srcId][conn.input].push({ nodeId: nId, inputName });
      }
    });
  });

  const queue = [];

  // Find subinput node → seed its outputs from parentInputs
  const subInputNode = innerNodes.find((n) => n.data.type === "subinput" || n.name === "subinput");
  const subInputId = subInputNode ? String(subInputNode.id) : null;

  if (subInputNode) {
    const subInputOutputs = {};
    const outKeys = Object.keys(subInputNode.outputs);
    for (let i = 0; i < outKeys.length; i++) {
      const parentInputKey = `input_${i + 1}`;
      subInputOutputs[outKeys[i]] = parentInputs[parentInputKey] !== undefined ? parentInputs[parentInputKey] : "";
    }
    outputsMap[subInputId] = subInputOutputs;

    sendLog({
      event: "node-processed",
      nodeId: subInputId,
      nodeType: "subinput",
      inputs: {},
      outputs: subInputOutputs,
      message: "Sub-Input initialized from parent inputs",
      status: "completed",
    });

    // Enqueue downstream nodes
    Object.values(subInputNode.outputs).forEach((output) => {
      if (output.connections) {
        output.connections.forEach((conn) => {
          const targetId = String(conn.node);
          pendingInputsCount[targetId]--;
          if (pendingInputsCount[targetId] === 0) {
            queue.push(targetId);
          }
        });
      }
    });
  }

  // Seed nodes with no dependencies
  for (const nId in pendingInputsCount) {
    if (nId === subInputId) continue;
    if (pendingInputsCount[nId] === 0 && !queue.includes(nId)) {
      queue.push(nId);
    }
  }

  const processed = new Set();
  let hasError = false;
  let lastErrorMessage = null;

  while (queue.length > 0 && !hasError) {
    if (abortSignal && abortSignal.aborted) {
      throw new Error(abortSignal.reason || "Workflow stopped by user");
    }

    const nId = queue.shift();
    if (processed.has(nId)) continue;
    processed.add(nId);

    const node = nodeMap[nId];
    const nodeType = node.data.type;

    // subinput is already handled as source
    if (nodeType === "subinput") continue;

    try {
      const nodeInputs = {};
      Object.entries(dependencies[nId]).forEach(([inputName, source]) => {
        if (outputsMap[source.nodeId]) {
          nodeInputs[inputName] = outputsMap[source.nodeId][source.outputName];
        }
      });

      // suboutput is a pass-through: collect inputs and store as outputs
      if (nodeType === "suboutput") {
        const passThrough = {};
        const inputKeys = Object.keys(node.inputs);
        for (let i = 0; i < inputKeys.length; i++) {
          passThrough[`output_${i + 1}`] = nodeInputs[inputKeys[i]] !== undefined ? nodeInputs[inputKeys[i]] : "";
        }
        outputsMap[nId] = passThrough;

        sendLog({
          event: "node-completed",
          nodeId: nId,
          nodeType: "suboutput",
          status: "completed",
          inputs: nodeInputs,
          outputs: passThrough,
          message: "Sub-Output collected results",
        });
      } else {
        // Execute regular node
        const nodeResult = await runNode(
          workflowId,
          postId,
          node,
          nodeInputs,
          sendLog,
          abortSignal,
          retryCount,
          halalSettings,
        );
        outputsMap[nId] = nodeResult;

        sendLog({
          event: "node-completed",
          nodeId: nId,
          nodeType,
          status: "completed",
          inputs: nodeInputs,
          outputs: nodeResult,
          message: "Node processed successfully",
        });
      }

      // Propagate downstream
      const currentOutputs = outputsMap[nId];
      if (currentOutputs && reverseDependencies[nId]) {
        Object.entries(reverseDependencies[nId]).forEach(([outputName, deps]) => {
          deps.forEach((dep) => {
            pendingInputsCount[dep.nodeId]--;
            if (pendingInputsCount[dep.nodeId] === 0 && !processed.has(dep.nodeId)) {
              if (!abortSignal || !abortSignal.aborted) {
                queue.push(dep.nodeId);
              }
            }
          });
        });
      }
    } catch (err) {
      hasError = true;
      lastErrorMessage = `Sub-node ${nId} (${nodeType}) failed: ${err.message}`;
      sendLog({
        event: "node-error",
        nodeId: nId,
        nodeType,
        status: "failed",
        message: lastErrorMessage,
      });
    }
  }

  if (hasError) {
    return { success: false, value: lastErrorMessage };
  }

  // Collect output from suboutput node
  const subOutputNode = innerNodes.find((n) => n.data.type === "suboutput" || n.name === "suboutput");
  if (subOutputNode) {
    const subOutputId = String(subOutputNode.id);
    const subResult = outputsMap[subOutputId];
    if (subResult) {
      return { success: true, value: subResult };
    }
  }

  return { success: false, value: "Sub-automation completed but no output was produced" };
}

async function runNode(
  workflowId,
  postId,
  node,
  inputs,
  sendLog,
  abortSignal,
  retryCount = 3,
  halalSettings = null,
) {
  const nodeId = String(node.id);
  const nodeType = node.data.type;
  let attempt = 1;
  // Video exports are expensive (full frame re-render each attempt) — limit retries
  if (nodeType === "videoeditor") retryCount = Math.min(retryCount, 1);
  const maxAttempts = retryCount + 1; // Add 1 to include the initial attempt
  let lastError = null;
  const nodeStartTime = Date.now();
  // Timeout now managed by individual automation files

  const logData = {
    nodeId,
    nodeType,
    inputs: JSON.parse(JSON.stringify(inputs)),
    outputs: null,
    status: "",
    message: "",
    createdAt: new Date().toISOString(), // Timestamp for execution order sorting
  };

  while (attempt <= maxAttempts) {
    try {
      if (abortSignal.aborted) {
        throw new Error(abortSignal.reason || "Workflow stopped by user");
      }

      logData.attempt = attempt;
      logData.status = "started";
      sendLog({ ...logData, message: `Attempt ${attempt}/${maxAttempts}` });

      // Log to automation debug file
      logAutomationDebug('NODE_START', {
        workflowId,
        nodeId,
        nodeType,
        attempt,
        maxAttempts,
        inputs: Object.keys(inputs).reduce((acc, k) => {
          const v = inputs[k];
          acc[k] = typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v;
          return acc;
        }, {}),
        nodeConfig: node.data.inputs ? node.data.inputs.map(inp => ({ title: inp.title, value: typeof inp.value === 'string' && inp.value.length > 200 ? inp.value.substring(0, 200) + '...' : inp.value })) : [],
      });

      // Log node execution start to database (only on first attempt)
      if (attempt === 1 && postId) {
        try {
          workflowDb.logNodeExecution({
            postId,
            workflowId,
            nodeId,
            nodeType,
            status: 'started',
            message: `Starting node execution`,
            attempt: 1,
            completedAt: null,
          });
        } catch (dbErr) {
          console.warn(`[ExecuteAutomation] Failed to log node start: ${dbErr.message}`);
        }
      }

      let result;

      // ── Halal Mode: filter all string inputs before passing to any node ──
      if (halalSettings && halalSettings.enabled && Array.isArray(halalSettings.replacements) && halalSettings.replacements.length > 0) {
        for (const key of Object.keys(inputs)) {
          if (typeof inputs[key] === "string") {
            inputs[key] = applyHalalFilter(inputs[key], halalSettings.replacements);
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      switch (nodeType) {
        case "openai": {
          // OpenAI queue manager handles key selection and rate limiting automatically
          // Check if old format (4 inputs with apiKey) or new format (3 inputs without apiKey)
          const hasOldFormat =
            node.data.inputs.length === 4 &&
            node.data.inputs[0]?.title === "Api key";
          const inputOffset = hasOldFormat ? 1 : 0;

          let promptTemplate = node.data.inputs[inputOffset].value;
          const temperature = parseFloat(
            node.data.inputs[inputOffset + 1].value,
          );
          const model = node.data.inputs[inputOffset + 2].value;
          const image =
            inputs.input_1 && inputs.input_1.trim() != ""
              ? inputs.input_1
              : null;

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value,
            );
          });

          // Pass null for apiKey - queue manager selects the best available key
          result = await openAi(
            null,
            model,
            promptTemplate,
            temperature,
            image,
          );
          break;
        }
        case "midjourney": {
          let promptTemplate = node.data.inputs[0].value;
          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value,
            );
          });

          const discordProfiles = (await readKey("discordProfiles")) || {};

          // Get the default Midjourney profile from settings, or fall back to first available
          let profileId = await readKey("defaultMidjourneyProfile");

          // Validate that the selected profile exists and is connected
          if (
            !profileId ||
            !discordProfiles[profileId] ||
            discordProfiles[profileId].status !== "connected"
          ) {
            // Fall back to first connected profile, or just the first profile if none are marked connected
            profileId =
              Object.keys(discordProfiles).find(
                (id) => discordProfiles[id].status === "connected",
              ) || Object.keys(discordProfiles)[0];
          }

          if (!profileId)
            throw new Error(
              "No Discord profile available. Please connect a Discord profile in Settings.",
            );

          const generationResult = await startImageRequest(
            promptTemplate,
            profileId,
            workflowId,
          );

          if (!generationResult.success) {
            throw new Error(`Midjourney failed: ${generationResult.value}`);
          }

          const splitPaths = generationResult.value;

          // Check for skip mode - auto-select all images
          const skipModeEnabled = workflowSkipModes.get(workflowId);
          console.log(
            `[Midjourney] Checking skip mode for workflow ${workflowId}: ${skipModeEnabled ? "ENABLED" : "DISABLED"}`,
          );
          console.log(
            `[Midjourney] Current workflowSkipModes Map:`,
            Array.from(workflowSkipModes.entries()),
          );

          if (skipModeEnabled) {
            console.log(
              `[Midjourney] Skip mode enabled - auto-selecting all images for workflow ${workflowId}`,
            );

            const window = BrowserWindow.getAllWindows()[0];
            if (window) {
              // Show auto-selection notification
              window.webContents.send("show-auto-selection-notification", {
                workflowId,
                selectedIndexes: [0, 1, 2, 3],
                splitPaths,
                reason: "skip-mode",
              });
            }

            // Mark node as completed before returning
            if (postId) {
              try {
                const duration = Date.now() - nodeStartTime;
                workflowDb.updateNodeExecution(postId, nodeId, {
                  status: 'completed',
                  message: `Completed in ${duration}ms (skip mode)`,
                  completedAt: new Date().toISOString(),
                });
              } catch (dbErr) {
                console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
              }
            }
            return { output_1: splitPaths };
          }

          // Check for existing workflow preference
          const workflowPref = workflowImagePreferences.get(workflowId);
          if (workflowPref && workflowPref.enabled) {
            console.log(
              `[Midjourney] Auto-applying workflow preference for workflow ${workflowId}:`,
              workflowPref.selectedIndexes,
            );

            // Validate that the preference indexes are valid for current split paths
            const validIndexes = workflowPref.selectedIndexes.filter(
              (idx) => idx < splitPaths.length,
            );
            if (validIndexes.length > 0) {
              const chosenPaths = validIndexes.map((i) => splitPaths[i]);
              console.log(
                `[Midjourney] Auto-selected ${chosenPaths.length} images based on workflow preference`,
              );

              const window = BrowserWindow.getAllWindows()[0];
              if (window) {
                // Show auto-selection notification
                window.webContents.send("show-auto-selection-notification", {
                  workflowId,
                  selectedIndexes: validIndexes,
                  splitPaths,
                  reason: "workflow-preference",
                });
              }

              // Mark node as completed before returning
              if (postId) {
                try {
                  const duration = Date.now() - nodeStartTime;
                  workflowDb.updateNodeExecution(postId, nodeId, {
                    status: 'completed',
                    message: `Completed in ${duration}ms (auto-preference)`,
                    completedAt: new Date().toISOString(),
                  });
                } catch (dbErr) {
                  console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
                }
              }
              return { output_1: chosenPaths };
            }
          }

          console.log(
            `[Midjourney] Images generated successfully. Asking user to select from ${splitPaths.length} images...`,
          );

          const window = BrowserWindow.getAllWindows()[0];
          const requestId = `${workflowId}-${nodeId}-${Date.now()}`;

          // Track pending selections for this workflow
          if (!pendingImageSelections.has(workflowId)) {
            pendingImageSelections.set(workflowId, new Set());
          }
          pendingImageSelections.get(workflowId).add(requestId);

          // Send workflow preference info to frontend
          window.webContents.send("choose-split-images", {
            requestId,
            splitPaths,
            workflowId,
            hasWorkflowPreference: !!(workflowPref && workflowPref.enabled),
            pendingCount: pendingImageSelections.get(workflowId).size,
          });

          console.log(
            `[Midjourney] Waiting for user selection. RequestId: ${requestId}`,
          );

          const chosenIndexes = await new Promise((resolve, reject) => {
            const abortListener = () => {
              if (splitImageResolvers.has(requestId))
                splitImageResolvers.delete(requestId);
              // Remove from pending selections
              const pending = pendingImageSelections.get(workflowId);
              if (pending) {
                pending.delete(requestId);
                if (pending.size === 0) {
                  pendingImageSelections.delete(workflowId);
                }
              }
              reject(new Error(abortSignal.reason || "Workflow stopped by user"));
            };

            abortSignal.addEventListener("abort", abortListener, {
              once: true,
            });

            splitImageResolvers.set(requestId, {
              workflowId, // Store workflowId for preference handling
              resolve: (indexes) => {
                abortSignal.removeEventListener("abort", abortListener);
                resolve(indexes);
              },
              reject: (err) => {
                abortSignal.removeEventListener("abort", abortListener);
                reject(err);
              },
            });
          });

          console.log(
            `[Midjourney] User selected images: ${chosenIndexes}. Processing ${chosenIndexes.length} images...`,
          );
          const chosenPaths = chosenIndexes.map((i) => splitPaths[i]);
          console.log(
            `[Midjourney] Midjourney node completed successfully with ${chosenPaths.length} images`,
          );
          // Mark node as completed before returning
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms (user selection)`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: chosenPaths };
        }
        case "chatgptimage": {
          let promptTemplate = node.data.inputs[0].value;
          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value,
            );
          });

          // Get reference image path if provided (input_1)
          const referenceImagePath = inputs.input_1 || null;

          // Profile selection is now handled by the chatgptImage module's load balancer
          // Pass null to let it auto-select the best profile from all connected profiles
          // This enables concurrent image generation across multiple ChatGPT profiles

          console.log(
            `[ChatGPT Image] Starting image generation (load balancer will select profile)`,
          );
          if (referenceImagePath) {
            console.log(
              `[ChatGPT Image] Reference image: ${referenceImagePath}`,
            );
          }
          const generationResult = await startChatGPTImageRequest(
            promptTemplate,
            referenceImagePath,
            null,
            workflowId,
          );

          if (!generationResult.success) {
            throw new Error(`ChatGPT Image failed: ${generationResult.value}`);
          }

          console.log(
            `[ChatGPT Image] Image generated successfully: ${generationResult.value}`,
          );
          // Mark node as completed before returning
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: generationResult.value };
        }
        case "chatgptchat": {
          let promptTemplate = node.data.inputs[0].value;
          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value,
            );
          });

          // Get reference image path if provided (input_1)
          const referenceImagePath = inputs.input_1 || null;

          console.log(
            `[ChatGPT Chat] Starting chat request (load balancer will select profile)`,
          );
          if (referenceImagePath) {
            console.log(
              `[ChatGPT Chat] Reference image: ${referenceImagePath}`,
            );
          }
          const chatResult = await startChatGPTChatRequest(
            promptTemplate,
            referenceImagePath,
            null,
            workflowId,
          );

          if (!chatResult.success) {
            throw new Error(`ChatGPT Chat failed: ${chatResult.value}`);
          }

          console.log(
            `[ChatGPT Chat] Response received, length: ${chatResult.value?.length || 0}`,
          );
          // Mark node as completed before returning
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: chatResult.value };
        }
        case "minicanvas": {
          const templateId = node.data.inputs[0].value;
          const images = Array.isArray(inputs.input_1)
            ? inputs.input_1
            : [inputs.input_1].filter(Boolean);

          result = await miniCanvas(images, templateId, inputs);
          
          // Move to permanent storage with AI cleaning, fake device metadata, and SEO metadata
          if (result.success && result.value) {
            const automationSettings = readKey('automationSettings') || {};
            const cleanAI = automationSettings.aiImageCleaning !== false;
            const imageMetadataSettings = readKey('imageMetadataSettings') || {};
            
            // Build prompt context from text inputs for SEO keyword extraction
            const textInputs = [inputs.input_2, inputs.input_3, inputs.input_4, inputs.input_5]
              .filter(v => v && typeof v === 'string' && v.trim())
              .join(' | ');

            const moveResult = await moveToPermStorage(result.value, {
              cleanAI,
              injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
              nodeType: 'minicanvas',
              workflowId,
              prompt: textInputs || null
            });
            
            if (moveResult.success) {
              result.value = moveResult.permanentPath;
              sendLog({ event: "node-info", message: `MiniCanvas image saved: ${moveResult.permanentPath}` });
            }
          }
          break;
        }
        case "videoeditor": {
          const templateId = node.data.inputs[0].value;
          const musicRaw = node.data.inputs[1]?.value || "[]";
          let musicPath = null;

          // Parse selected music filenames (JSON array)
          let selectedMusics = [];
          try { selectedMusics = JSON.parse(musicRaw); } catch(_) {}
          if (!Array.isArray(selectedMusics)) selectedMusics = [];

          // Helper to download a music file by filename
          const downloadMusic = async (filename) => {
            const musicDir = path.join(app.getPath("userData"), "Musics");
            if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });
            const localPath = path.join(musicDir, path.basename(filename));
            if (fs.existsSync(localPath)) return localPath;

            sendLog({ event: "node-warning", message: "Import this music file locally before running the workflow." });
            return null;
          };

          if (selectedMusics.length > 0) {
            const chosen = selectedMusics[Math.floor(Math.random() * selectedMusics.length)];
            sendLog({ event: "node-info", message: `Music selected: ${chosen}` });
            // Check if it's a local absolute path
            if (path.isAbsolute(chosen) && fs.existsSync(chosen)) {
              musicPath = chosen;
            } else {
              musicPath = await downloadMusic(chosen);
              if (!musicPath) {
                sendLog({ event: "node-warning", message: `Could not download music: ${chosen}` });
              }
            }
          }

          const fps = parseInt(node.data.inputs[2]?.value, 10) || 30;
          const quality = node.data.inputs[3]?.value || 'high';
          const resolution = node.data.inputs[4]?.value || 'original';
          const subtitlesTemplate = node.data.inputs[5]?.value || 'disabled';
          const subtitlesLanguage = node.data.inputs[6]?.value || '';
          result = await videoEditor(templateId, inputs, musicPath, fps, quality, resolution, subtitlesTemplate, subtitlesLanguage);
          break;
        }
        case "imageupload": {
          const selectedProvider = await resolveUploadProvider("image");
          if (selectedProvider.error) {
            result = { success: false, value: selectedProvider.error };
            break;
          }
          const imagePath = inputs.input_1;
          sendLog({
            event: "node-info",
            message: `Using ${uploadProviderLabel(selectedProvider.provider)} from Settings > Media Hosting for this image upload.`,
          });
          try {
            result = await uploadImage(selectedProvider.provider, selectedProvider.apiKey, imagePath, workflowId);
          } catch (error) {
            throw new Error(formatUploadProviderError("image", selectedProvider.provider, error));
          }
          break;
        }
        case "videoupload": {
          const selectedProvider = await resolveUploadProvider("video");
          if (selectedProvider.error) {
            result = { success: false, value: selectedProvider.error };
            break;
          }
          const videoPath = inputs.input_1;
          sendLog({
            event: "node-info",
            message: `Using ${uploadProviderLabel(selectedProvider.provider)} from Settings > Media Hosting for this video upload.`,
          });
          try {
            result = await uploadVideo(selectedProvider.provider, selectedProvider.apiKey, videoPath, workflowId);
          } catch (error) {
            throw new Error(formatUploadProviderError("video", selectedProvider.provider, error));
          }
          break;
        }
        case "googlesites": {
          const html = inputs.input_1;
          // profileId is now optional - googleSites will auto-select from connected profiles
          const profileId = node.data.inputs[0]?.value || null;

          result = await googleSites(html, profileId, workflowId);
          break;
        }
        case "wordpress": {
          const wordpressId = node.data.inputs[0].value;
          const title = inputs.input_1;
          const htmlContent = inputs.input_2;
          const featuredImageUrl = inputs.input_3 || null; // Optional featured image URL
          const categoriesRaw = inputs.input_4 || "";

          result = await wordPress(
            wordpressId,
            title,
            htmlContent,
            featuredImageUrl,
            categoriesRaw,
          );
          break;
        }
        case "wordpressget": {
          const wpGetSiteId = node.data.inputs[0].value;
          const resourceType = node.data.inputs[1].value;
          const perPage = node.data.inputs[2].value;
          const sortBy = node.data.inputs[3] ? node.data.inputs[3].value : "date_desc";
          const searchQuery = inputs.input_1 || null;
          const resourceId = inputs.input_2 || null;

          result = await wordpressGet(
            wpGetSiteId,
            resourceType,
            perPage,
            searchQuery,
            resourceId,
            sortBy,
          );
          break;
        }
        case "wprecipemaker": {
          const wordpressId = node.data.inputs[0].value;
          
          // Check if JSON input is provided (input_1)
          let recipeData = {};
          const jsonInput = inputs.input_1;
          
          if (jsonInput && jsonInput.trim()) {
            try {
              let jsonStr = jsonInput.trim();
              
              // Remove markdown code blocks (various formats)
              jsonStr = jsonStr.replace(/^```(?:json|JSON)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
              
              // Try to extract JSON object if there's text before/after
              const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                jsonStr = jsonMatch[0];
              }
              
              // Fix common AI mistakes: actual newlines in strings → escaped newlines
              // Process line by line within string values
              jsonStr = jsonStr.replace(/"([^"]*?)"/g, (match, content) => {
                // Replace actual newlines with \n escape sequence
                const fixed = content.replace(/\r?\n/g, '\\n');
                return `"${fixed}"`;
              });
              
              const parsed = JSON.parse(jsonStr);
              recipeData = {
                name: String(parsed.name || ''),
                summary: String(parsed.summary || ''),
                ingredients: String(parsed.ingredients || ''),
                instructions: String(parsed.instructions || ''),
                prepTime: String(parsed.prepTime || ''),
                cookTime: String(parsed.cookTime || ''),
                servings: String(parsed.servings || ''),
                notes: String(parsed.notes || ''),
                cuisine: String(parsed.cuisine || ''),
                course: String(parsed.course || ''),
                equipment: String(parsed.equipment || ''),
                imageUrl: parsed.imageUrl || null,
              };
            } catch (e) {
              // JSON parsing failed, fall back to individual inputs
              console.warn('[WP Recipe Maker] JSON parsing failed, using individual inputs:', e.message);
            }
          }
          
          // If no JSON or JSON parsing failed, use individual inputs
          // Individual inputs override JSON values if both are provided
          if (!recipeData.name && inputs.input_2) recipeData.name = inputs.input_2;
          if (!recipeData.summary && inputs.input_3) recipeData.summary = inputs.input_3;
          if (!recipeData.ingredients && inputs.input_4) recipeData.ingredients = inputs.input_4;
          if (!recipeData.instructions && inputs.input_5) recipeData.instructions = inputs.input_5;
          if (!recipeData.prepTime && inputs.input_6) recipeData.prepTime = inputs.input_6;
          if (!recipeData.cookTime && inputs.input_7) recipeData.cookTime = inputs.input_7;
          if (!recipeData.servings && inputs.input_8) recipeData.servings = inputs.input_8;
          if (!recipeData.notes && inputs.input_9) recipeData.notes = inputs.input_9;
          if (!recipeData.cuisine && inputs.input_10) recipeData.cuisine = inputs.input_10;
          if (!recipeData.course && inputs.input_11) recipeData.course = inputs.input_11;
          if (!recipeData.equipment && inputs.input_12) recipeData.equipment = inputs.input_12;
          if (!recipeData.imageUrl && inputs.input_13) recipeData.imageUrl = inputs.input_13;

          result = await wpRecipeMaker(wordpressId, recipeData);
          break;
        }
        case "curl": {
          const curlrequest = inputs.input_1;

          result = await executeCurl(curlrequest);
          break;
        }
        case "advancedcurl": {
          const acUrl = node.data.inputs[0].value;
          const acMethod = node.data.inputs[1].value;
          const acContentType = node.data.inputs[2].value;
          const acHeaders = node.data.inputs[3].value;
          const acBody = node.data.inputs[4].value;
          const acAuthType = node.data.inputs[5].value;
          const acAuthValue = node.data.inputs[6].value;

          result = await advancedCurl(
            acUrl,
            acMethod,
            acContentType,
            acHeaders,
            acBody,
            acAuthType,
            acAuthValue,
            inputs,
          );
          break;
        }
        case "serpapi": {
          let saQuery = node.data.inputs[0].value || "";
          const saEngine = node.data.inputs[1].value || "google";
          const saHl = node.data.inputs[2].value || "auto";
          const saGl = node.data.inputs[3].value || "auto";
          const saLocation = node.data.inputs[4].value || "";
          const saDevice = node.data.inputs[5].value || "desktop";
          const saNum = node.data.inputs[6].value || "10";
          const saStart = node.data.inputs[7].value || "0";
          const saSafe = node.data.inputs[8].value || "off";
          const saTbm = node.data.inputs[9].value || "";
          const saAdvanced = node.data.inputs[10].value || "";

          // Interpolate {INPUT_1}, {INPUT_2}, etc. with connected text
          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            saQuery = saQuery.replace(
              new RegExp(`{${varName}}`, "g"),
              value,
            );
          });

          result = await serpApiSearch(null, saEngine, saQuery, {
            location: saLocation,
            hl: saHl,
            gl: saGl,
            device: saDevice,
            num: saNum,
            start: saStart,
            safe: saSafe,
            tbm: saTbm,
            advancedParams: saAdvanced,
          });
          break;
        }
        case "amazoncrawl": {
          const productUrl = inputs.input_1;
          result = await openAmazonProduct(productUrl);
          // Return the full product data as JSON string
          if (result.success && result.productData) {
            result.value = JSON.stringify(result.productData);
          }
          break;
        }
        case "imagedownloader": {
          const imageUrl = inputs.input_1;
          result = await downloadImage(imageUrl);
          break;
        }
        case "videotoimage": {
          const videoPath = inputs.input_1;
          const frameMode = node.data.inputs[0].value || "first";
          const frameNumber = node.data.inputs[1].value || "1";
          result = await videoToImage(videoPath, frameMode, parseInt(frameNumber, 10));
          break;
        }
        case "jsonparser": {
          const jsonText = inputs.input_1;
          const fieldPath = node.data.inputs[0].value;
          const pickFields = node.data.inputs[1].value;
          result = await parseJson(jsonText, fieldPath, pickFields);
          break;
        }
        case "humanize": {
          const text = inputs.input_1;
          result = await humanize(text);
          break;
        }
        case "firstelement": {
          // Returns a single element from a list/array input (defaults to index 0).
          const raw = inputs.input_1;
          const idxRaw = parseInt(node.data.inputs?.[0]?.value, 10);
          const idx = Number.isInteger(idxRaw) && idxRaw >= 0 ? idxRaw : 0;

          let arr;
          if (Array.isArray(raw)) {
            arr = raw;
          } else if (typeof raw === "string" && raw.trim().startsWith("[")) {
            try {
              const parsed = JSON.parse(raw);
              arr = Array.isArray(parsed) ? parsed : [raw];
            } catch (_) {
              arr = [raw];
            }
          } else if (raw === undefined || raw === null || raw === "") {
            arr = [];
          } else {
            arr = [raw];
          }

          const item = arr.length > idx ? arr[idx] : "";
          result = { success: true, value: item === undefined || item === null ? "" : item };
          break;
        }
        case "grouplist": {
          // Collects all connected inputs into a single flat array (list) output.
          const collected = [];
          const inputKeys = Object.keys(inputs)
            .filter((k) => /^input_\d+$/.test(k))
            .sort(
              (a, b) =>
                parseInt(a.split("_")[1], 10) - parseInt(b.split("_")[1], 10)
            );

          for (const k of inputKeys) {
            const v = inputs[k];
            if (v === undefined || v === null || v === "") continue;
            if (Array.isArray(v)) {
              v.forEach((it) => {
                if (it !== undefined && it !== null && it !== "") collected.push(it);
              });
            } else if (typeof v === "string" && v.trim().startsWith("[")) {
              try {
                const parsed = JSON.parse(v);
                if (Array.isArray(parsed)) {
                  parsed.forEach((it) => {
                    if (it !== undefined && it !== null && it !== "") collected.push(it);
                  });
                } else {
                  collected.push(v);
                }
              } catch (_) {
                collected.push(v);
              }
            } else {
              collected.push(v);
            }
          }

          result = { success: true, value: collected };
          break;
        }
        case "amazonafflink": {
          const productUrl = inputs.input_1;
          const trackingId = node.data.inputs[0].value;
          result = await amazonAffLink(productUrl, trackingId);
          break;
        }
        case "variables": {
          let template = node.data.inputs[0].value;

          // Pre-process all input values from actual connected inputs AND template references
          const resolvedInputs = {};
          
          // Find highest {INPUT_X} referenced in template to ensure all are covered
          let maxInput = 0;
          const templateRefs = template.matchAll(/\{INPUT_(\d+)\}/g);
          for (const m of templateRefs) {
            maxInput = Math.max(maxInput, parseInt(m[1], 10));
          }
          // Also include all actual inputs
          for (const key of Object.keys(inputs)) {
            const km = key.match(/^input_(\d+)$/);
            if (km) maxInput = Math.max(maxInput, parseInt(km[1], 10));
          }
          
          for (let i = 1; i <= maxInput; i++) {
            const inputKey = `input_${i}`;
            const value = inputs[inputKey];
            
            if (value === undefined || value === null) {
              resolvedInputs[i] = { strValue: "", arrayValue: null, isNull: true };
              continue;
            }
            
            const strValue = Array.isArray(value)
              ? value.join(",")
              : String(value);
            
            // Try to parse JSON string arrays for indexing support
            let arrayValue = null;
            if (Array.isArray(value)) {
              arrayValue = value;
            } else if (
              typeof value === "string" &&
              value.trim().startsWith("[")
            ) {
              try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) {
                  arrayValue = parsed;
                }
              } catch (e) {
                console.log(
                  `[Variables] Failed to parse JSON array for INPUT_${i}:`,
                  e.message,
                );
              }
            }
            
            resolvedInputs[i] = { strValue, arrayValue, isNull: false };
          }
          
          // Single-pass replacement for BASE64() patterns
          template = template.replace(
            /BASE64\(\{INPUT_(\d+)\}\)/g,
            (match, num) => {
              const idx = parseInt(num, 10);
              const resolved = resolvedInputs[idx];
              if (!resolved || resolved.isNull) return "";
              return Buffer.from(resolved.strValue, "utf8").toString("base64");
            },
          );
          
          // Single-pass replacement for {INPUT_X}[index] patterns
          template = template.replace(
            /\{INPUT_(\d+)\}\[(\d+)\]/g,
            (match, num, index) => {
              const idx = parseInt(num, 10);
              const resolved = resolvedInputs[idx];
              if (!resolved || resolved.isNull) return "";
              if (resolved.arrayValue && resolved.arrayValue.length > parseInt(index, 10)) {
                return resolved.arrayValue[parseInt(index, 10)];
              }
              return "";
            },
          );
          
          // Single-pass replacement for {INPUT_X} patterns
          // This prevents cascading substitutions where INPUT_1's value
          // containing "{INPUT_2}" would get replaced by INPUT_2's value
          template = template.replace(
            /\{INPUT_(\d+)\}/g,
            (match, num) => {
              const idx = parseInt(num, 10);
              const resolved = resolvedInputs[idx];
              if (!resolved || resolved.isNull) return "";
              return resolved.strValue;
            },
          );

          result = { success: true, value: template };
          break;
        }
        case "splitter": {
          const splitSymbol = node.data.inputs[0].value || "|";
          const inputText = inputs.input_1;
          
          // Use actual Drawflow output ports as primary source (outputTypes can be stale from initial default)
          const outputCount = Object.keys(node.outputs || {}).length || node.data.outputTypes?.length || 4;

          if (!inputText) {
            const outputs = {};
            for (let i = 1; i <= outputCount; i++) {
              outputs[`output_${i}`] = "";
            }
            result = { success: true, value: outputs };
            break;
          }

          const textValue = String(inputText);
          const parts = textValue.split(splitSymbol);

          // Return elements based on dynamic output count
          const outputs = {};
          for (let i = 1; i <= outputCount; i++) {
            outputs[`output_${i}`] = parts[i - 1] ? parts[i - 1].trim() : "";
          }

          result = { success: true, value: outputs };
          break;
        }
        case "gptimage": {
          let promptTemplate = node.data.inputs[0].value;
          const model = node.data.inputs[1]?.value || "gpt-image-1";
          const size = node.data.inputs[2]?.value || "1024x1024";
          const quality = node.data.inputs[3]?.value || "standard";

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await gptImage(promptTemplate, model, size, quality, 'png', workflowId);
          break;
        }
        case "soraimage": {
          // Sora application discontinued — redirect to ChatGPT Image backend
          let promptTemplate = node.data.inputs[0].value;
          const nVariants = parseInt(node.data.inputs[1]?.value) || 1;

          // Get reference image if connected (input_2 = image)
          const soraRefImage = inputs.input_2 || null;

          Object.entries(inputs).forEach(([key, value]) => {
            // Skip image input from text replacement
            if (key === "input_2") return;
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          console.log(`[Sora Image] Redirecting to ChatGPT Image backend (Sora discontinued). Variants requested: ${nVariants}`);

          // Generate images via ChatGPT Image (one request per variant)
          const soraPaths = [];
          for (let vi = 0; vi < nVariants; vi++) {
            if (nVariants > 1) {
              sendLog({ event: "node-info", message: `Generating image ${vi + 1}/${nVariants} via ChatGPT Image...` });
            }
            const genResult = await startChatGPTImageRequest(
              promptTemplate,
              soraRefImage,
              null,
              workflowId,
            );
            if (!genResult.success) {
              // If we already have at least one image, continue with what we have
              if (soraPaths.length > 0) {
                console.warn(`[Sora Image] Variant ${vi + 1} failed: ${genResult.value}, continuing with ${soraPaths.length} images`);
                break;
              }
              throw new Error(`Sora Image failed (ChatGPT backend): ${genResult.value}`);
            }
            soraPaths.push(genResult.value);
          }

          console.log(`[Sora Image] Generated ${soraPaths.length} image(s) via ChatGPT Image backend`);

          // If only 1 image, skip selection UI
          if (soraPaths.length === 1) {
            // Mark node as completed before returning
            if (postId) {
              try {
                const duration = Date.now() - nodeStartTime;
                workflowDb.updateNodeExecution(postId, nodeId, {
                  status: 'completed',
                  message: `Completed in ${duration}ms (single image)`,
                  completedAt: new Date().toISOString(),
                });
              } catch (dbErr) {
                console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
              }
            }
            return { output_1: soraPaths };
          }

          // Multi-variant: use same image selection logic as Midjourney
          const skipModeEnabled = workflowSkipModes.get(workflowId);
          if (skipModeEnabled) {
            console.log(
              `[Sora Image] Skip mode enabled - auto-selecting all images for workflow ${workflowId}`,
            );
            const window = BrowserWindow.getAllWindows()[0];
            if (window) {
              window.webContents.send("show-auto-selection-notification", {
                workflowId,
                selectedIndexes: soraPaths.map((_, i) => i),
                splitPaths: soraPaths,
                reason: "skip-mode",
              });
            }
            // Mark node as completed before returning
            if (postId) {
              try {
                const duration = Date.now() - nodeStartTime;
                workflowDb.updateNodeExecution(postId, nodeId, {
                  status: 'completed',
                  message: `Completed in ${duration}ms (skip mode)`,
                  completedAt: new Date().toISOString(),
                });
              } catch (dbErr) {
                console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
              }
            }
            return { output_1: soraPaths };
          }

          // Check for existing workflow preference
          const soraWorkflowPref = workflowImagePreferences.get(workflowId);
          if (soraWorkflowPref && soraWorkflowPref.enabled) {
            const validIndexes = soraWorkflowPref.selectedIndexes.filter(
              (idx) => idx < soraPaths.length,
            );
            if (validIndexes.length > 0) {
              const chosenPaths = validIndexes.map((i) => soraPaths[i]);
              const window = BrowserWindow.getAllWindows()[0];
              if (window) {
                window.webContents.send("show-auto-selection-notification", {
                  workflowId,
                  selectedIndexes: validIndexes,
                  splitPaths: soraPaths,
                  reason: "workflow-preference",
                });
              }
              // Mark node as completed before returning
              if (postId) {
                try {
                  const duration = Date.now() - nodeStartTime;
                  workflowDb.updateNodeExecution(postId, nodeId, {
                    status: 'completed',
                    message: `Completed in ${duration}ms (workflow preference)`,
                    completedAt: new Date().toISOString(),
                  });
                } catch (dbErr) {
                  console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
                }
              }
              return { output_1: chosenPaths };
            }
          }

          // Manual selection via UI
          const window = BrowserWindow.getAllWindows()[0];
          const requestId = `${workflowId}-${nodeId}-${Date.now()}`;

          if (!pendingImageSelections.has(workflowId)) {
            pendingImageSelections.set(workflowId, new Set());
          }
          pendingImageSelections.get(workflowId).add(requestId);

          window.webContents.send("choose-split-images", {
            requestId,
            splitPaths: soraPaths,
            workflowId,
            hasWorkflowPreference: !!(soraWorkflowPref && soraWorkflowPref.enabled),
            pendingCount: pendingImageSelections.get(workflowId).size,
          });

          const soraChosenIndexes = await new Promise((resolve, reject) => {
            const abortListener = () => {
              if (splitImageResolvers.has(requestId))
                splitImageResolvers.delete(requestId);
              const pending = pendingImageSelections.get(workflowId);
              if (pending) {
                pending.delete(requestId);
                if (pending.size === 0)
                  pendingImageSelections.delete(workflowId);
              }
              reject(new Error(abortSignal.reason || "Workflow stopped by user"));
            };

            abortSignal.addEventListener("abort", abortListener, {
              once: true,
            });

            splitImageResolvers.set(requestId, {
              workflowId,
              resolve: (indexes) => {
                abortSignal.removeEventListener("abort", abortListener);
                resolve(indexes);
              },
              reject: (err) => {
                abortSignal.removeEventListener("abort", abortListener);
                reject(err);
              },
            });
          });

          const soraChosenPaths = soraChosenIndexes.map((i) => soraPaths[i]);
          // Mark node as completed before returning
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms (user selection)`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: soraChosenPaths };
        }
        case "soravideo": {
          // Sora application discontinued — redirect to ChatGPT Image backend
          let promptTemplate = node.data.inputs[0].value;

          // Interpolate {INPUT_1} with connected text
          Object.entries(inputs).forEach(([key, value]) => {
            if (key === "input_2") return;
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          // Optional reference image from input_2
          const svImagePath = inputs.input_2 || null;

          console.log(`[Sora Video] Redirecting to ChatGPT Image backend (Sora discontinued)`);
          sendLog({ event: "node-info", message: `Generating image via ChatGPT Image (Sora discontinued)...` });

          result = await startChatGPTImageRequest(
            promptTemplate,
            svImagePath,
            null,
            workflowId,
          );
          break;
        }
        case "openrouter": {
          let promptTemplate = node.data.inputs[0].value;
          const temperature = parseFloat(node.data.inputs[1].value);
          const model = node.data.inputs[2].value;
          const maxTokens = parseInt(node.data.inputs[3]?.value) || 4096;
          const image =
            inputs.input_1 && inputs.input_1.trim() !== ""
              ? inputs.input_1
              : null;

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await openRouter(model, promptTemplate, temperature, image, null, maxTokens);
          break;
        }
        case "googleai": {
          let promptTemplate = node.data.inputs[0].value;
          const temperature = parseFloat(node.data.inputs[1].value);
          const model = node.data.inputs[2].value;
          const maxTokens = parseInt(node.data.inputs[3]?.value) || 8192;
          const image =
            inputs.input_1 && inputs.input_1.trim() !== ""
              ? inputs.input_1
              : null;

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await googleAI(model, promptTemplate, temperature, image, null, maxTokens);
          break;
        }
        case "googleaiimage": {
          let promptTemplate = node.data.inputs[0].value;
          const model = node.data.inputs[1]?.value || "imagen-3.0-generate-001";
          const aspectRatio = node.data.inputs[2]?.value || "1:1";

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await googleAIImage(promptTemplate, model, aspectRatio);
          
          // Save to permanent storage to enable SEO metadata and prevent cleanup
          if (result.success && result.value) {
            const automationSettings = readKey('automationSettings') || {};
            const cleanAI = automationSettings.aiImageCleaning !== false;
            const imageMetadataSettings = readKey('imageMetadataSettings') || {};
            
            const moveResult = await moveToPermStorage(result.value, {
              cleanAI,
              injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
              nodeType: 'googleaiimage',
              workflowId,
              prompt: promptTemplate
            });
            
            if (moveResult.success) {
              result.value = moveResult.permanentPath;
              sendLog({ event: "node-info", message: `Google AI image saved: ${moveResult.permanentPath}` });
            }
          }
          break;
        }
        case "metaaiimage": {
          let promptTemplate = node.data.inputs[0].value;
          const orientation = node.data.inputs[1]?.value || "VERTICAL";

          // Get attachment image if connected (input_2 = image)
          const metaaiAttachmentImage = inputs.input_2 || null;

          Object.entries(inputs).forEach(([key, value]) => {
            // Skip image input from text replacement
            if (key === "input_2") return;
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          // Get connected Meta AI profiles
          const metaaiProfiles = (await readKey("metaaiProfiles")) || {};
          const connectedMetaAIProfiles = Object.keys(metaaiProfiles).filter(
            (id) => metaaiProfiles[id].status === "connected"
          );

          if (connectedMetaAIProfiles.length === 0) {
            throw new Error(
              "No Meta AI profile available. Please connect a Meta AI profile in Settings."
            );
          }

          // Least-loaded profile selection (balances across profiles better than round-robin)
          let metaaiProfileId = connectedMetaAIProfiles[0];
          let minLoad = getMetaAIProfileLoad(metaaiProfileId);
          for (let i = 1; i < connectedMetaAIProfiles.length; i++) {
            const load = getMetaAIProfileLoad(connectedMetaAIProfiles[i]);
            if (load < minLoad) { minLoad = load; metaaiProfileId = connectedMetaAIProfiles[i]; }
          }

          console.log(`[Meta AI Image] Using profile: ${metaaiProfileId} (load: ${minLoad})`);

          const metaaiResult = await metaaiImage(
            promptTemplate,
            orientation,
            metaaiProfileId,
            workflowId,
            metaaiAttachmentImage
          );

          if (!metaaiResult.success) {
            throw new Error(`Meta AI Image failed: ${metaaiResult.value}`);
          }

          const metaaiPaths = metaaiResult.value; // Array of image paths

          // If only 1 image, return directly
          if (metaaiPaths.length === 1) {
            if (postId) {
              try {
                const duration = Date.now() - nodeStartTime;
                workflowDb.updateNodeExecution(postId, nodeId, {
                  status: 'completed',
                  message: `Completed in ${duration}ms (single image)`,
                  completedAt: new Date().toISOString(),
                });
              } catch (dbErr) {
                console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
              }
            }
            return { output_1: metaaiPaths };
          }

          // Multi-image: use image selection logic (skip mode / workflow preference / manual)
          const metaaiSkipMode = workflowSkipModes.get(workflowId);
          if (metaaiSkipMode) {
            console.log(`[Meta AI Image] Skip mode enabled - auto-selecting all images for workflow ${workflowId}`);
            const metaaiWindow = BrowserWindow.getAllWindows()[0];
            if (metaaiWindow) {
              metaaiWindow.webContents.send("show-auto-selection-notification", {
                workflowId,
                selectedIndexes: metaaiPaths.map((_, i) => i),
                splitPaths: metaaiPaths,
                reason: "skip-mode",
              });
            }
            if (postId) {
              try {
                const duration = Date.now() - nodeStartTime;
                workflowDb.updateNodeExecution(postId, nodeId, {
                  status: 'completed',
                  message: `Completed in ${duration}ms (skip mode)`,
                  completedAt: new Date().toISOString(),
                });
              } catch (dbErr) {
                console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
              }
            }
            return { output_1: metaaiPaths };
          }

          // Check for existing workflow preference
          const metaaiWorkflowPref = workflowImagePreferences.get(workflowId);
          if (metaaiWorkflowPref && metaaiWorkflowPref.enabled) {
            const metaaiValidIndexes = metaaiWorkflowPref.selectedIndexes.filter(
              (idx) => idx < metaaiPaths.length,
            );
            if (metaaiValidIndexes.length > 0) {
              const metaaiChosenPaths = metaaiValidIndexes.map((i) => metaaiPaths[i]);
              const metaaiWindow = BrowserWindow.getAllWindows()[0];
              if (metaaiWindow) {
                metaaiWindow.webContents.send("show-auto-selection-notification", {
                  workflowId,
                  selectedIndexes: metaaiValidIndexes,
                  splitPaths: metaaiPaths,
                  reason: "workflow-preference",
                });
              }
              if (postId) {
                try {
                  const duration = Date.now() - nodeStartTime;
                  workflowDb.updateNodeExecution(postId, nodeId, {
                    status: 'completed',
                    message: `Completed in ${duration}ms (workflow preference)`,
                    completedAt: new Date().toISOString(),
                  });
                } catch (dbErr) {
                  console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
                }
              }
              return { output_1: metaaiChosenPaths };
            }
          }

          // Manual selection via UI
          const metaaiSelWindow = BrowserWindow.getAllWindows()[0];
          const metaaiRequestId = `${workflowId}-${nodeId}-${Date.now()}`;

          if (!pendingImageSelections.has(workflowId)) {
            pendingImageSelections.set(workflowId, new Set());
          }
          pendingImageSelections.get(workflowId).add(metaaiRequestId);

          metaaiSelWindow.webContents.send("choose-split-images", {
            requestId: metaaiRequestId,
            splitPaths: metaaiPaths,
            workflowId,
            hasWorkflowPreference: !!(metaaiWorkflowPref && metaaiWorkflowPref.enabled),
            pendingCount: pendingImageSelections.get(workflowId).size,
          });

          const metaaiChosenIndexes = await new Promise((resolve, reject) => {
            const abortListener = () => {
              if (splitImageResolvers.has(metaaiRequestId))
                splitImageResolvers.delete(metaaiRequestId);
              const pending = pendingImageSelections.get(workflowId);
              if (pending) {
                pending.delete(metaaiRequestId);
                if (pending.size === 0)
                  pendingImageSelections.delete(workflowId);
              }
              reject(new Error(abortSignal.reason || "Workflow stopped by user"));
            };

            abortSignal.addEventListener("abort", abortListener, {
              once: true,
            });

            splitImageResolvers.set(metaaiRequestId, {
              workflowId,
              resolve: (indexes) => {
                abortSignal.removeEventListener("abort", abortListener);
                resolve(indexes);
              },
              reject: (err) => {
                abortSignal.removeEventListener("abort", abortListener);
                reject(err);
              },
            });
          });

          const metaaiSelectedPaths = metaaiChosenIndexes.map((i) => metaaiPaths[i]);
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms (user selection)`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: metaaiSelectedPaths };
        }
        case "tiktokadsimage": {
          let promptTemplate = node.data.inputs[0].value;
          const tiktokModel = node.data.inputs[1]?.value || "gemini";

          // Get attachment image if connected (input_2 = image)
          const tiktokAttachmentImage = inputs.input_2 || null;

          Object.entries(inputs).forEach(([key, value]) => {
            // Skip image input from text replacement
            if (key === "input_2") return;
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          // Get connected TikTok Ads profiles
          const tiktokProfiles = (await readKey("tiktokAdsProfiles")) || {};
          const connectedTikTokProfiles = Object.keys(tiktokProfiles).filter(
            (id) => tiktokProfiles[id].status === "connected"
          );

          if (connectedTikTokProfiles.length === 0) {
            throw new Error(
              "No TikTok Ads profile available. Please connect a TikTok Ads account in Settings."
            );
          }

          // Rotate across connected profiles
          const tiktokProfileId =
            connectedTikTokProfiles[
              Math.floor(Math.random() * connectedTikTokProfiles.length)
            ];

          console.log(`[TikTok Ads Image] Using profile: ${tiktokProfileId}`);

          const tiktokResult = await tiktokAdsImage(
            promptTemplate,
            tiktokModel,
            tiktokProfileId,
            workflowId,
            tiktokAttachmentImage
          );

          if (!tiktokResult.success) {
            throw new Error(`TikTok Ads Image failed: ${tiktokResult.value}`);
          }

          const tiktokPaths = tiktokResult.value; // Array of image paths

          // If only 1 image, return directly
          if (tiktokPaths.length === 1) {
            if (postId) {
              try {
                const duration = Date.now() - nodeStartTime;
                workflowDb.updateNodeExecution(postId, nodeId, {
                  status: 'completed',
                  message: `Completed in ${duration}ms (single image)`,
                  completedAt: new Date().toISOString(),
                });
              } catch (dbErr) {
                console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
              }
            }
            return { output_1: tiktokPaths };
          }

          // Multi-image: skip mode auto-selects all
          const tiktokSkipMode = workflowSkipModes.get(workflowId);
          if (tiktokSkipMode) {
            const tiktokWindow = BrowserWindow.getAllWindows()[0];
            if (tiktokWindow) {
              tiktokWindow.webContents.send("show-auto-selection-notification", {
                workflowId,
                selectedIndexes: tiktokPaths.map((_, i) => i),
                splitPaths: tiktokPaths,
                reason: "skip-mode",
              });
            }
            if (postId) {
              try {
                const duration = Date.now() - nodeStartTime;
                workflowDb.updateNodeExecution(postId, nodeId, {
                  status: 'completed',
                  message: `Completed in ${duration}ms (skip mode)`,
                  completedAt: new Date().toISOString(),
                });
              } catch (dbErr) {
                console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
              }
            }
            return { output_1: tiktokPaths };
          }

          // Workflow-level preference
          const tiktokWorkflowPref = workflowImagePreferences.get(workflowId);
          if (tiktokWorkflowPref && tiktokWorkflowPref.enabled) {
            const tiktokValidIndexes = tiktokWorkflowPref.selectedIndexes.filter(
              (idx) => idx < tiktokPaths.length,
            );
            if (tiktokValidIndexes.length > 0) {
              const tiktokChosenPaths = tiktokValidIndexes.map((i) => tiktokPaths[i]);
              const tiktokWindow = BrowserWindow.getAllWindows()[0];
              if (tiktokWindow) {
                tiktokWindow.webContents.send("show-auto-selection-notification", {
                  workflowId,
                  selectedIndexes: tiktokValidIndexes,
                  splitPaths: tiktokPaths,
                  reason: "workflow-preference",
                });
              }
              if (postId) {
                try {
                  const duration = Date.now() - nodeStartTime;
                  workflowDb.updateNodeExecution(postId, nodeId, {
                    status: 'completed',
                    message: `Completed in ${duration}ms (workflow preference)`,
                    completedAt: new Date().toISOString(),
                  });
                } catch (dbErr) {
                  console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
                }
              }
              return { output_1: tiktokChosenPaths };
            }
          }

          // Manual selection via UI
          const tiktokSelWindow = BrowserWindow.getAllWindows()[0];
          const tiktokRequestId = `${workflowId}-${nodeId}-${Date.now()}`;

          if (!pendingImageSelections.has(workflowId)) {
            pendingImageSelections.set(workflowId, new Set());
          }
          pendingImageSelections.get(workflowId).add(tiktokRequestId);

          tiktokSelWindow.webContents.send("choose-split-images", {
            requestId: tiktokRequestId,
            splitPaths: tiktokPaths,
            workflowId,
            hasWorkflowPreference: !!(tiktokWorkflowPref && tiktokWorkflowPref.enabled),
            pendingCount: pendingImageSelections.get(workflowId).size,
          });

          const tiktokChosenIndexes = await new Promise((resolve, reject) => {
            const abortListener = () => {
              if (splitImageResolvers.has(tiktokRequestId))
                splitImageResolvers.delete(tiktokRequestId);
              const pending = pendingImageSelections.get(workflowId);
              if (pending) {
                pending.delete(tiktokRequestId);
                if (pending.size === 0)
                  pendingImageSelections.delete(workflowId);
              }
              reject(new Error(abortSignal.reason || "Workflow stopped by user"));
            };

            abortSignal.addEventListener("abort", abortListener, { once: true });

            splitImageResolvers.set(tiktokRequestId, {
              workflowId,
              resolve: (indexes) => {
                abortSignal.removeEventListener("abort", abortListener);
                resolve(indexes);
              },
              reject: (err) => {
                abortSignal.removeEventListener("abort", abortListener);
                reject(err);
              },
            });
          });

          const tiktokSelectedPaths = tiktokChosenIndexes.map((i) => tiktokPaths[i]);
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms (user selection)`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: tiktokSelectedPaths };
        }
        case "metaaivideo": {
          let videoPromptTemplate = node.data.inputs[0].value;

          // Get attachment image if connected (input_2 = image)
          const metaaiVideoAttachmentImage = inputs.input_2 || null;

          Object.entries(inputs).forEach(([key, value]) => {
            // Skip image input from text replacement
            if (key === "input_2") return;
            const varName = key.toUpperCase();
            videoPromptTemplate = videoPromptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          // Get connected Meta AI profiles
          const metaaiVideoProfiles = (await readKey("metaaiProfiles")) || {};
          const connectedMetaAIVideoProfiles = Object.keys(metaaiVideoProfiles).filter(
            (id) => metaaiVideoProfiles[id].status === "connected"
          );

          if (connectedMetaAIVideoProfiles.length === 0) {
            throw new Error(
              "No Meta AI profile available. Please connect a Meta AI profile in Settings."
            );
          }

          // Least-loaded profile selection (balances across profiles better than round-robin)
          let metaaiVideoProfileId = connectedMetaAIVideoProfiles[0];
          let minVideoLoad = getMetaAIProfileLoad(metaaiVideoProfileId);
          for (let i = 1; i < connectedMetaAIVideoProfiles.length; i++) {
            const load = getMetaAIProfileLoad(connectedMetaAIVideoProfiles[i]);
            if (load < minVideoLoad) { minVideoLoad = load; metaaiVideoProfileId = connectedMetaAIVideoProfiles[i]; }
          }

          console.log(`[Meta AI Video] Using profile: ${metaaiVideoProfileId} (load: ${minVideoLoad})`);

          const metaaiVideoResult = await metaaiVideo(
            videoPromptTemplate,
            metaaiVideoProfileId,
            workflowId,
            metaaiVideoAttachmentImage
          );

          if (!metaaiVideoResult.success) {
            throw new Error(`Meta AI Video failed: ${metaaiVideoResult.value}`);
          }

          const metaaiVideoPaths = metaaiVideoResult.value;

          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms (${metaaiVideoPaths.length} video(s))`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: metaaiVideoPaths };
        }
        case "tiktokadsvideo": {
          let tiktokVideoPromptTemplate = node.data.inputs[0].value;
          const tiktokVideoMode = node.data.inputs[1]?.value || "reference";
          const tiktokVideoDuration = node.data.inputs[2]?.value || "12";

          // Get attachment image(s) if connected (input_2 = image). Reference
          // mode supports multiple images, so input_2 may be a single path or
          // an array of paths.
          const tiktokVideoAttachmentImage = inputs.input_2 || null;

          Object.entries(inputs).forEach(([key, value]) => {
            // Skip image input from text replacement
            if (key === "input_2") return;
            const varName = key.toUpperCase();
            tiktokVideoPromptTemplate = tiktokVideoPromptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          // Get connected TikTok Ads profiles (shared with TikTok Ads Image)
          const tiktokVideoProfiles = (await readKey("tiktokAdsProfiles")) || {};
          const connectedTikTokVideoProfiles = Object.keys(tiktokVideoProfiles).filter(
            (id) => tiktokVideoProfiles[id].status === "connected"
          );

          if (connectedTikTokVideoProfiles.length === 0) {
            throw new Error(
              "No TikTok Ads profile available. Please connect a TikTok Ads account in Settings."
            );
          }

          // Rotate across connected profiles
          const tiktokVideoProfileId =
            connectedTikTokVideoProfiles[
              Math.floor(Math.random() * connectedTikTokVideoProfiles.length)
            ];

          console.log(`[TikTok Ads Video] Using profile: ${tiktokVideoProfileId} (mode: ${tiktokVideoMode})`);

          const tiktokVideoResult = await tiktokAdsVideo(
            tiktokVideoPromptTemplate,
            tiktokVideoDuration,
            tiktokVideoMode,
            tiktokVideoProfileId,
            workflowId,
            tiktokVideoAttachmentImage
          );

          if (!tiktokVideoResult.success) {
            throw new Error(`TikTok Ads Video failed: ${tiktokVideoResult.value}`);
          }

          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: tiktokVideoResult.value };
        }
        case "geminiimage": {
          let promptTemplate = node.data.inputs[0].value;

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          // Get reference image path if provided (input_1)
          const referenceImagePath = inputs.input_1 || null;

          console.log(`[Gemini Image] Starting image generation (load balancer will select profile)`);
          if (referenceImagePath) {
            console.log(`[Gemini Image] Reference image: ${referenceImagePath}`);
          }
          const geminiResult = await startGeminiImageRequest(
            promptTemplate,
            referenceImagePath,
            workflowId,
          );

          if (!geminiResult.success) {
            throw new Error(`Gemini Image failed: ${geminiResult.value}`);
          }

          console.log(`[Gemini Image] Image generated successfully: ${geminiResult.value}`);
          // Mark node as completed before returning
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: geminiResult.value };
        }
        case "googledocsveo": {
          let promptTemplate = node.data.inputs[0].value;
          const veoAspectRatio = node.data.inputs[1]?.value || "landscape";

          Object.entries(inputs).forEach(([key, value]) => {
            if (key === "input_2") return;
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          const veoImagePath = inputs.input_2 || null;
          const veoMode = veoImagePath ? "image-text-to-video" : "text-to-video";

          console.log(`[Veo 3.1] Starting video generation (mode=${veoMode}, aspect=${veoAspectRatio})`);
          if (veoImagePath) {
            console.log(`[Veo 3.1] Reference image: ${veoImagePath}`);
          }

          const veoResult = await startVeoVideoRequest(
            promptTemplate,
            veoAspectRatio,
            veoMode,
            veoImagePath,
            workflowId,
          );

          if (!veoResult.success) {
            throw new Error(`Veo 3.1 failed: ${veoResult.value}`);
          }

          console.log(`[Veo 3.1] Video generated successfully: ${veoResult.value}`);
          if (postId) {
            try {
              const duration = Date.now() - nodeStartTime;
              workflowDb.updateNodeExecution(postId, nodeId, {
                status: 'completed',
                message: `Completed in ${duration}ms`,
                completedAt: new Date().toISOString(),
              });
            } catch (dbErr) {
              console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
            }
          }
          return { output_1: veoResult.value };
        }
        case "anthropic": {
          let promptTemplate = node.data.inputs[0].value;
          const temperature = parseFloat(node.data.inputs[1].value);
          const model = node.data.inputs[2].value;
          const maxTokens = parseInt(node.data.inputs[3]?.value) || 4096;
          const image =
            inputs.input_1 && inputs.input_1.trim() !== ""
              ? inputs.input_1
              : null;

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await anthropic(model, promptTemplate, temperature, image, null, maxTokens);
          break;
        }
        case "chineseai": {
          let promptTemplate = node.data.inputs[0].value;
          const temperature = parseFloat(node.data.inputs[1].value);
          const model = node.data.inputs[2].value;
          const maxTokens = parseInt(node.data.inputs[3]?.value) || 4096;
          const image =
            inputs.input_1 && inputs.input_1.trim() !== ""
              ? inputs.input_1
              : null;

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await chineseAI(model, promptTemplate, temperature, image, null, maxTokens);
          break;
        }
        case "deepseekbrowser": {
          let promptTemplate = node.data.inputs[0].value;
          const thinkingEnabled = node.data.inputs[1]?.value === "true";
          const searchEnabled = node.data.inputs[2]?.value === "true";

          // New nodes use input_1 for an image and input_2 for text. Existing
          // saved one-port nodes keep input_1 as text for compatibility.
          const hasVisionInput = Object.prototype.hasOwnProperty.call(
            node.inputs || {},
            "input_2",
          );
          const imagePath = hasVisionInput ? inputs.input_1 || null : null;

          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await deepseekBrowser(
            promptTemplate,
            thinkingEnabled,
            searchEnabled,
            null,
            imagePath,
          );
          break;
        }
        case "qwenbrowser": {
          let promptTemplate = node.data.inputs[0].value;
          const qwenModel = node.data.inputs[1]?.value || "qwen-plus";
          const qwenThinking = node.data.inputs[2]?.value === "true";
          const qwenTemperature = parseFloat(node.data.inputs[3]?.value) || 0.7;
          const qwenMaxTokens = parseInt(node.data.inputs[4]?.value) || 4096;
          const qwenSearch = node.data.inputs[5]?.value === "true";

          // Replace {INPUT_1} with image path and {INPUT_2} with text
          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          const qwenImagePath = inputs.input_1 || null;

          result = await qwenBrowser(promptTemplate, qwenImagePath, {
            model: qwenModel,
            thinkingEnabled: qwenThinking,
            temperature: qwenTemperature,
            maxTokens: qwenMaxTokens,
            searchEnabled: qwenSearch,
          });
          break;
        }
        case "vcai": {
          let promptTemplate = node.data.inputs[0].value;
          const temperature = parseFloat(node.data.inputs[1].value);
          const model = node.data.inputs[2].value || "";  // Empty = use server default
          const maxTokens = parseInt(node.data.inputs[3]?.value) || 4096;

          // VCAI only supports text input (no image)
          Object.entries(inputs).forEach(([key, value]) => {
            const varName = key.toUpperCase();
            promptTemplate = promptTemplate.replace(
              new RegExp(`{${varName}}`, "g"),
              value
            );
          });

          result = await vcai(model, promptTemplate, temperature, null, null, maxTokens);
          break;
        }
        case "vctts": {
          const ttsText = inputs.input_1;
          const selectedVoice = node.data.inputs[1].value; // configInput[1] = Voice ShortName
          result = await textToSpeech(ttsText, selectedVoice);
          break;
        }
        case "subautomation": {
          const innerData = node.data.subAutomationData;
          if (!innerData || !innerData.drawflow || !innerData.drawflow.Home) {
            throw new Error("Sub-Automation has no inner graph data. Please edit and save it first.");
          }
          const innerNodesObj = innerData.drawflow.Home.data;
          const cleanedInnerNodes = Object.entries(innerNodesObj).map(
            ([id, elm]) => ({
              id: elm.id,
              name: elm.name,
              data: elm.data,
              inputs: elm.inputs,
              outputs: elm.outputs,
            }),
          );

          sendLog({
            event: "node-progress",
            nodeId,
            nodeType: "subautomation",
            message: "Executing sub-automation graph...",
          });

          result = await executeSubGraph(
            workflowId,
            postId,
            cleanedInnerNodes,
            inputs,
            (subLog) => {
              sendLog({
                ...subLog,
                event: "node-progress",
                parentNodeId: nodeId,
                message: `[Sub] ${subLog.message || ""}`,
              });
            },
            abortSignal,
            retryCount,
          );
          break;
        }
        case "subinput":
        case "suboutput": {
          // These are handled internally by executeSubGraph, not reached normally.
          // Defensive no-op: pass through inputs as outputs
          const passOutputs = {};
          Object.entries(inputs).forEach(([key, value], i) => {
            passOutputs[`output_${i + 1}`] = value;
          });
          result = { success: true, value: passOutputs };
          break;
        }
        default:
          throw new Error(`Unsupported node type: ${nodeType}`);
      }

      if (!result.success) {
        throw new Error(result.value);
      }

      // Handle both single output and multiple outputs
      let outputs;
      if (
        typeof result.value === "object" &&
        result.value !== null &&
        !Array.isArray(result.value) &&
        (result.value.output_1 !== undefined ||
          result.value.output_2 !== undefined)
      ) {
        // Multiple outputs (like splitter node)
        outputs = result.value;
      } else {
        // Single output (traditional nodes)
        outputs = { output_1: result.value };
      }

      logData.outputs = outputs;
      logData.status = "completed";
      sendLog({ ...logData, message: `Node completed successfully` });

      // Log completion to automation debug file
      const debugDuration = Date.now() - nodeStartTime;
      logAutomationDebug('NODE_COMPLETE', {
        workflowId,
        nodeId,
        nodeType,
        duration: `${debugDuration}ms`,
        attempt,
        outputs: Object.keys(outputs).reduce((acc, k) => {
          const v = outputs[k];
          acc[k] = typeof v === 'string' && v.length > 300 ? v.substring(0, 300) + '...' : v;
          return acc;
        }, {}),
      });

      // Update node execution in database with completion
      if (postId) {
        try {
          const duration = Date.now() - nodeStartTime;
          workflowDb.updateNodeExecution(postId, nodeId, {
            status: 'completed',
            message: `Completed in ${duration}ms`,
            completedAt: new Date().toISOString(),
          });
          
          // Track in analytics database
          try {
            const analyticsDb = getAnalyticsDatabase();
            analyticsDb.updateNodeTypeStats(nodeType, true, duration);
            analyticsDb.updatePeakUsage();
            analyticsDb.updateDailySnapshot({
              automationId: null, // Will be filled from workflow context if available
              nodesExecuted: 1,
              nodesCompleted: 1,
              durationMs: duration,
            });
          } catch (analyticsErr) {
            // Don't fail execution if analytics fails
            console.warn(`[ExecuteAutomation] Analytics tracking error: ${analyticsErr.message}`);
          }
        } catch (dbErr) {
          console.warn(`[ExecuteAutomation] Failed to update node completion: ${dbErr.message}`);
        }
      }

      return outputs;
    } catch (error) {
      lastError = error;
      logData.status = "failed";
      logData.message = error.message;
      sendLog({
        ...logData,
        message: `Attempt ${attempt} failed: ${error.message}`,
      });

      // Log failure to automation debug file
      logAutomationDebug('NODE_FAIL', {
        workflowId,
        nodeId,
        nodeType,
        attempt,
        maxAttempts,
        error: error.message,
        errorName: error.name,
        stack: error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : null,
      });

      // Log failure to file with comprehensive details
      const failureLogData = {
        workflowId,
        nodeId,
        nodeType,
        attempt,
        maxAttempts,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
        inputs: JSON.parse(JSON.stringify(inputs)),
        nodeConfig: {
          nodeName: node.name,
          nodeInputs: node.data.inputs
            ? node.data.inputs.map((inp) => ({
                value: nodeType === "imageupload" || nodeType === "videoupload"
                  ? "[managed in Settings > Media Hosting]"
                  : inp.value,
                type: typeof inp.value,
              }))
            : [],
        },
        isUserStop: error.message === "Workflow stopped by user",
        isValidationStop: error.message.startsWith("Validation failed:"),
        isFinalAttempt: attempt === maxAttempts,
      };

      logNodeFailureToFile(failureLogData);

      if (error.message === "Workflow stopped by user" || error.message.startsWith("Validation failed:")) {
        throw error;
      }

      if (attempt === maxAttempts) {
        // Log final failure with comprehensive details
        const finalFailureLogData = {
          ...failureLogData,
          finalFailure: true,
          totalAttemptsExhausted: true,
          finalErrorMessage: `Node failed permanently after ${maxAttempts} attempts: ${error.message}`,
        };

        logNodeFailureToFile(finalFailureLogData);

        // Update node execution in database with failure
        if (postId) {
          try {
            const duration = Date.now() - nodeStartTime;
            workflowDb.updateNodeExecution(postId, nodeId, {
              status: 'failed',
              message: `Failed after ${maxAttempts} attempts: ${error.message} (${duration}ms)`,
              completedAt: new Date().toISOString(),
            });
            
            // Track failure in analytics database
            try {
              const analyticsDb = getAnalyticsDatabase();
              analyticsDb.updateNodeTypeStats(nodeType, false, duration);
              analyticsDb.updatePeakUsage();
              analyticsDb.recordError({
                workflowId,
                postId,
                nodeId,
                nodeType,
                message: error.message,
                stackTrace: error.stack,
                automationId: null, // Will be filled from workflow context if available
              });
              analyticsDb.updateDailySnapshot({
                automationId: null,
                nodesExecuted: 1,
                nodesFailed: 1,
                durationMs: duration,
              });
            } catch (analyticsErr) {
              console.warn(`[ExecuteAutomation] Analytics tracking error: ${analyticsErr.message}`);
            }
          } catch (dbErr) {
            console.warn(`[ExecuteAutomation] Failed to update node failure: ${dbErr.message}`);
          }
        }

        throw new Error(
          `Node failed after ${maxAttempts} attempts: ${error.message}`,
        );
      }

      attempt++;
      const backoffTime = 1000 * Math.pow(2, attempt);
      sendLog({
        ...logData,
        message: `Retrying in ${backoffTime / 1000} seconds...`,
      });

      try {
        await new Promise((resolve, reject) => {
          let isSettled = false; // Track if promise has been settled

          const abortListener = () => {
            if (isSettled) return; // Prevent double-settlement
            isSettled = true;
            clearTimeout(timer);
            abortSignal.removeEventListener("abort", abortListener);
            console.log(
              `[runNode] Backoff aborted for node ${nodeId} (attempt ${attempt}/${maxAttempts})`,
            );
            reject(new Error(abortSignal.reason || "Workflow stopped by user"));
          };

          const timer = setTimeout(() => {
            if (isSettled) return; // Prevent double-settlement
            isSettled = true;
            abortSignal.removeEventListener("abort", abortListener);
            console.log(
              `[runNode] Backoff complete for node ${nodeId} (attempt ${attempt}/${maxAttempts}), proceeding to retry`,
            );
            resolve();
          }, backoffTime);

          // Add abort listener
          abortSignal.addEventListener("abort", abortListener);

          // Safety timeout: Force resolve after 2x backoff time to prevent infinite hang
          const safetyTimeout = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            abortSignal.removeEventListener("abort", abortListener);
            console.warn(
              `[runNode] SAFETY TIMEOUT: Backoff exceeded expected time for node ${nodeId} (attempt ${attempt}/${maxAttempts}), forcing retry`,
            );
            resolve();
          }, backoffTime * 2);

          // Clean up safety timeout if promise settles normally
          const cleanup = () => clearTimeout(safetyTimeout);
          timer.then = cleanup; // Attach cleanup to timer
        });
      } catch (backoffError) {
        console.log(
          `[runNode] Backoff error for node ${nodeId}: ${backoffError.message}`,
        );
        throw backoffError;
      }
    }
  }

  throw lastError;
}

async function executeAutomation(
  workflowId,
  cleanedAutomations,
  initialInput,
  sendLog = () => {},
  retryCount = 3,
  postId = null,
) {
  const abortController = new AbortController();
  
  // CRITICAL: Clean up any stale controllers from previous runs (especially aborted ones)
  // This prevents "Workflow stopped by user" errors on reruns
  if (workflowControllers.has(workflowId)) {
    const existingData = workflowControllers.get(workflowId);
    // Clear all existing controllers (they may be aborted from a previous stop)
    existingData.controllers.clear();
    existingData.queues.clear();
    console.log(`[ExecuteAutomation] Cleared stale controllers for workflow ${workflowId} (rerun cleanup)`);
  } else {
    workflowControllers.set(workflowId, {
      controllers: new Set(),
      queues: new Set(),
    });
  }
  
  workflowControllers.get(workflowId).controllers.add(abortController);
  const abortSignal = abortController.signal;

  try {
    // Log workflow start to debug file
    logAutomationDebug('WORKFLOW_START', {
      workflowId,
      nodeCount: cleanedAutomations.length,
      nodes: cleanedAutomations.map(n => ({ id: n.id, type: n.data?.type, name: n.name })),
      hasImage: !!initialInput.image,
      hasText: !!initialInput.text,
      textPreview: initialInput.text ? initialInput.text.substring(0, 200) : null,
      retryCount,
      postId,
    });

    const nodeMap = {};
    const outputsMap = {};
    const dependencies = {};
    const reverseDependencies = {};
    const pendingInputsCount = {};
    let hasError = false;
    let lastErrorMessage = null; // Store the actual error message for better reporting

    // Read Halal Mode settings once for the entire workflow execution
    const halalSettings = (await readKey("halalModeSettings")) || { enabled: false, replacements: [] };

    cleanedAutomations.forEach((node) => {
      const nodeId = String(node.id);
      nodeMap[nodeId] = node;
      dependencies[nodeId] = {};
      reverseDependencies[nodeId] = {};
      pendingInputsCount[nodeId] = Object.values(node.inputs).filter(
        (input) => input.connections && input.connections.length > 0,
      ).length;
    });

    cleanedAutomations.forEach((node) => {
      const nodeId = String(node.id);
      Object.entries(node.inputs).forEach(([inputName, inputData]) => {
        if (inputData.connections && inputData.connections.length > 0) {
          const conn = inputData.connections[0];
          const sourceNodeId = String(conn.node);

          dependencies[nodeId][inputName] = {
            nodeId: sourceNodeId,
            outputName: conn.input,
          };

          if (!reverseDependencies[sourceNodeId][conn.input]) {
            reverseDependencies[sourceNodeId][conn.input] = [];
          }

          reverseDependencies[sourceNodeId][conn.input].push({
            nodeId,
            inputName,
          });
        }
      });
    });

    const inputNode = cleanedAutomations.find((n) => n.name === "input");
    const inputNodeId = inputNode ? String(inputNode.id) : null;

    const queue = [];

    // Store queue reference for external access (stopping workflow)
    workflowControllers.get(workflowId).queues.add(queue);

    if (inputNode) {
      outputsMap[inputNodeId] = {
        output_1: initialInput.image,
        output_2: initialInput.text,
        output_3: initialInput.url || "",
      };

      sendLog({
        event: "node-processed",
        nodeId: inputNodeId,
        nodeType: "input",
        inputs: {},
        outputs: outputsMap[inputNodeId],
        message: "Input node initialized",
        status: "completed",
      });

      Object.values(inputNode.outputs).forEach((output) => {
        output.connections.forEach((conn) => {
          const targetNodeId = String(conn.node);
          pendingInputsCount[targetNodeId]--;
          if (pendingInputsCount[targetNodeId] === 0) {
            queue.push(targetNodeId);
          }
        });
      });
    }

    // Seed nodes that have no incoming connections (all connection inputs are optional/unconnected)
    for (const nodeId in pendingInputsCount) {
      if (nodeId === inputNodeId) continue;
      if (pendingInputsCount[nodeId] === 0 && !queue.includes(nodeId)) {
        const node = nodeMap[nodeId];
        // Skip output nodes — they are handled via the propagation chain
        if (node.data.type !== "facebook-output" && node.data.type !== "pinterest-output") {
          queue.push(nodeId);
        }
      }
    }

    const processed = new Set();
    const finalOutputs = { facebook: null, pinterest: null };

    while (queue.length > 0 && !hasError) {
      if (abortSignal.aborted) {
        // Clear the queue immediately when workflow is stopped
        queue.length = 0;
        throw new Error(abortSignal.reason || "Workflow stopped by user");
      }

      const nodeId = queue.shift();

      // Double-check if workflow was stopped before processing this node
      if (abortSignal.aborted) {
        queue.length = 0; // Clear remaining queue
        throw new Error(abortSignal.reason || "Workflow stopped by user");
      }

      if (processed.has(nodeId)) continue;
      processed.add(nodeId);

      const node = nodeMap[nodeId];
      let inputs = {};

      try {
        if (node.data.type === "facebook-output") {
          inputs = {};
          Object.entries(dependencies[nodeId]).forEach(
            ([inputName, source]) => {
              if (outputsMap[source.nodeId]) {
                inputs[inputName] =
                  outputsMap[source.nodeId][source.outputName];
              }
            },
          );
          finalOutputs.facebook = {
            image: inputs.input_1,
            text: inputs.input_2,
            video: inputs.input_3,
            url: inputs.input_4 || null,
            title: inputs.input_5 || null,
          };

          // Auto-generate a title from the post text when enabled in settings
          // and no title was connected to the node. Matches the post language.
          if (!finalOutputs.facebook.title && finalOutputs.facebook.text) {
            try {
              const autoSettings = (await readKey("automationSettings")) || {};
              if (autoSettings.autoGenerateFacebookTitle) {
                const { generateTitleFromText } = require("./titleGenerator");
                const generatedTitle = await generateTitleFromText(
                  finalOutputs.facebook.text,
                  {
                    provider: autoSettings.autoTitleProvider || "",
                    model: autoSettings.autoTitleModel || "",
                  },
                );
                if (generatedTitle) {
                  finalOutputs.facebook.title = generatedTitle;
                  sendLog({
                    event: "node-progress",
                    message: `Auto-generated Facebook title: ${generatedTitle}`,
                  });
                }
              }
            } catch (titleErr) {
              sendLog({
                event: "warning",
                message: `Failed to auto-generate Facebook title: ${titleErr.message}`,
              });
            }
          }

          sendLog({
            event: "output-generated",
            platform: "facebook",
            outputs: finalOutputs.facebook,
          });
          continue;
        }

        if (node.data.type === "pinterest-output") {
          inputs = {};
          Object.entries(dependencies[nodeId]).forEach(
            ([inputName, source]) => {
              if (outputsMap[source.nodeId]) {
                inputs[inputName] =
                  outputsMap[source.nodeId][source.outputName];
              }
            },
          );
          finalOutputs.pinterest = {
            image: inputs.input_1,
            title: inputs.input_2,
            description: inputs.input_3,
            url: inputs.input_4,
            videoUrl: inputs.input_5,
          };

          sendLog({
            event: "output-generated",
            platform: "pinterest",
            outputs: finalOutputs.pinterest,
          });
          continue;
        }

        inputs = {};
        Object.entries(dependencies[nodeId]).forEach(([inputName, source]) => {
          if (outputsMap[source.nodeId]) {
            inputs[inputName] = outputsMap[source.nodeId][source.outputName];
          }
        });

        const result = await runNode(
          workflowId,
          postId,
          node,
          inputs,
          (log) => {
            sendLog({ ...log, event: "node-progress" });
          },
          abortSignal,
          retryCount,
          halalSettings,
        );

        outputsMap[nodeId] = result;

        sendLog({
          event: "node-completed",
          nodeId,
          nodeType: node.data.type,
          status: "completed",
          inputs,
          outputs: result,
          message: "Node processed successfully",
        });

        Object.entries(result).forEach(([outputName, value]) => {
          if (
            reverseDependencies[nodeId] &&
            reverseDependencies[nodeId][outputName]
          ) {
            reverseDependencies[nodeId][outputName].forEach((dep) => {
              pendingInputsCount[dep.nodeId]--;
              if (
                pendingInputsCount[dep.nodeId] === 0 &&
                !processed.has(dep.nodeId)
              ) {
                // Check if workflow is stopped before adding to queue
                if (!abortSignal.aborted) {
                  queue.push(dep.nodeId);
                }
              }
            });
          }
        });
      } catch (err) {
        hasError = true;
        if (err.message === "Workflow stopped by user") {
          sendLog({
            event: "workflow-stopped",
            nodeId,
            message: "Workflow stopped by user",
          });

          
          return {
            success: false,
            value: "Workflow stopped by user",
          };
        } else {
          // Log workflow-level node failure
          const workflowFailureLogData = {
            workflowId,
            nodeId,
            nodeType: node.data.type,
            workflowLevel: true,
            error: {
              message: err.message,
              stack: err.stack,
              name: err.name,
            },
            inputs: inputs,
            nodeConfig: {
              nodeName: node.name,
              nodeInputs: node.data.inputs
                ? node.data.inputs.map((inp) => ({
                    value: inp.value,
                    type: typeof inp.value,
                  }))
                : [],
            },
            context: "workflow-execution",
            permanentFailure: true,
          };

          logNodeFailureToFile(workflowFailureLogData);

          // Store the actual error message for the final result
          lastErrorMessage = `Node ${nodeId} (${node.data.type}) failed: ${err.message}`;

          sendLog({
            event: "node-error",
            nodeId,
            nodeType: node.data.type,
            status: "failed",
            message: `Node failed permanently: ${err.message}`,
            error: {
              message: err.message,
              stack: err.stack,
              name: err.name,
            },
          });
        }
      }
    }

    const unprocessedNodes = Object.keys(pendingInputsCount).filter(
      (nodeId) => !processed.has(nodeId) && pendingInputsCount[nodeId] > 0,
    );

    if (unprocessedNodes.length > 0) {
      sendLog({
        event: "warning",
        message: `Unprocessed nodes due to missing dependencies: ${unprocessedNodes.join(", ")}`,
      });
    }

    // Check if output nodes were never reached (no outputs generated)
    const hasOutputNodes = cleanedAutomations.some(
      (n) => n.data.type === "facebook-output" || n.data.type === "pinterest-output"
    );
    const noOutputsGenerated = hasOutputNodes && !finalOutputs.facebook && !finalOutputs.pinterest;

    if (hasError || (noOutputsGenerated && unprocessedNodes.length > 0)) {
      const errorMsg = hasError
        ? (lastErrorMessage || "Automation failed due to node execution errors")
        : `Workflow incomplete: ${unprocessedNodes.length} nodes were never reached due to missing dependencies (nodes: ${unprocessedNodes.join(", ")})`;

      logAutomationDebug('WORKFLOW_FAILED', {
        workflowId,
        error: errorMsg,
        processedNodes: processed.size,
        totalNodes: cleanedAutomations.length,
        unprocessedNodes,
      });


      return {
        success: false,
        value: errorMsg,
      };
    }

    // Log workflow success to debug file
    logAutomationDebug('WORKFLOW_COMPLETE', {
      workflowId,
      success: true,
      processedNodes: processed.size,
      totalNodes: cleanedAutomations.length,
      outputPlatforms: Object.keys(finalOutputs).filter(k => finalOutputs[k]),
    });


    return {
      success: true,
      value: finalOutputs,
    };
  } catch (error) {
    // Log workflow-level error to debug file
    logAutomationDebug('WORKFLOW_ERROR', {
      workflowId,
      error: error.message,
      errorName: error.name,
      stack: error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : null,
      nodeCount: cleanedAutomations ? cleanedAutomations.length : 0,
    });

    // Log workflow-level error
    const workflowErrorLogData = {
      workflowId,
      workflowLevel: true,
      generalWorkflowError: true,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      context: "workflow-execution-general",
      automationCount: cleanedAutomations ? cleanedAutomations.length : 0,
    };

    logNodeFailureToFile(workflowErrorLogData);

    sendLog({
      event: "workflow-error",
      nodeId: "workflow",
      nodeType: "workflow",
      message: `Workflow execution failed: ${error.message}`,
    });


    return {
      success: false,
      value: error.message,
    };
  } finally {


    const workflowData = workflowControllers.get(workflowId);
    if (workflowData) {
      workflowData.controllers.delete(abortController);
      // Remove queue reference when execution finishes
      workflowData.queues.clear();
      if (workflowData.controllers.size === 0) {
        workflowControllers.delete(workflowId);
      }
    }
  }
}

ipcMain.handle("stop-workflow", async (_, workflowId) => {
  console.log(
    `🛑🛑🛑 [STOP-WORKFLOW DEBUG] stop-workflow IPC handler called for workflow ${workflowId}`,
  );
  console.log(
    `🛑🛑🛑 [STOP-WORKFLOW DEBUG] Timestamp: ${new Date().toISOString()}`,
  );

  // ALWAYS remove workflow from queue system FIRST - this marks it as stopped
  // This must happen regardless of whether workflowData exists
  try {
    console.log(
      `🛑🛑🛑 [STOP-WORKFLOW DEBUG] About to call workflowQueue.removeFromQueue(${workflowId})`,
    );
    await workflowQueue.removeFromQueue(workflowId);
    console.log(
      `🛑🛑🛑 [STOP-WORKFLOW DEBUG] workflowQueue.removeFromQueue completed`,
    );
    console.log(
      `🛑🛑🛑 [STOP-WORKFLOW DEBUG] workflowQueue.stoppedWorkflows now:`,
      Array.from(workflowQueue.stoppedWorkflows),
    );
  } catch (error) {
    console.warn(
      `[Workflow] Failed to remove workflow ${workflowId} from queue:`,
      error.message,
    );
  }

  const workflowData = workflowControllers.get(workflowId);
  console.log(
    `🛑🛑🛑 [STOP-WORKFLOW DEBUG] workflowData exists: ${!!workflowData}`,
  );

  if (workflowData) {
    // Immediately clear all execution queues
    for (const queue of workflowData.queues) {
      queue.length = 0; // Clear the queue array
      console.log(
        `[Workflow] Cleared execution queue for workflow ${workflowId}`,
      );
    }

    // Abort all controllers
    console.log(
      `🛑🛑🛑 [STOP-WORKFLOW DEBUG] Aborting ${workflowData.controllers.size} controllers`,
    );
    for (const ctrl of workflowData.controllers) {
      ctrl.abort();
    }

    // Stop queues for specific automations
    try {
      stopMidjourneyQueues(workflowId);
    } catch (e) {
      console.error("Error stopping midjourney queues:", e);
    }

    try {
      stopChatGPTImageQueues(workflowId);
    } catch (e) {
      console.error("Error stopping ChatGPT Image queues:", e);
    }

    try {
      stopSoraImageQueues(workflowId);
    } catch (e) {
      console.error("Error stopping Sora Image queues:", e);
    }

    try {
      stopChatGPTChatQueues(workflowId);
    } catch (e) {
      console.error("Error stopping ChatGPT Chat queues:", e);
    }

    try {
      stopGoogleSitesQueues(workflowId);
    } catch (e) {
      console.error("Error stopping google sites queues:", e);
    }

    try {
      stopGeminiImageQueues(workflowId);
    } catch (e) {
      console.error("Error stopping Gemini Image queues:", e);
    }

    try {
      stopVeoQueues(workflowId);
    } catch (e) {
      console.error("Error stopping Veo 3.1 queues:", e);
    }

    try {
      stopMetaAIQueues(workflowId);
    } catch (e) {
      console.error("Error stopping Meta AI queues:", e);
    }

    try {
      stopTikTokAdsImageQueues(workflowId);
    } catch (e) {
      console.error("Error stopping TikTok Ads Image queues:", e);
    }

    try {
      stopTikTokAdsVideoQueues(workflowId);
    } catch (e) {
      console.error("Error stopping TikTok Ads Video queues:", e);
    }

    // Clean up workflow image preferences and skip modes
    if (workflowImagePreferences.has(workflowId)) {
      workflowImagePreferences.delete(workflowId);
      console.log(
        `[Workflow] Cleared image preferences for workflow ${workflowId}`,
      );
    }
    if (workflowSkipModes.has(workflowId)) {
      workflowSkipModes.delete(workflowId);
      console.log(`[Workflow] Cleared skip mode for workflow ${workflowId}`);
    }
    if (pendingImageSelections.has(workflowId)) {
      pendingImageSelections.delete(workflowId);
      console.log(
        `[Workflow] Cleared pending selections for workflow ${workflowId}`,
      );
    }
  }

  // Update workflow data in storage when manually stopped
  try {
    const workflow = workflowDb.getWorkflowWithPosts(workflowId);
    if (workflow) {
      // Count completed posts and calculate progress
      let completedCount = 0;
      const totalPosts = workflow.posts ? workflow.posts.length : 0;

      // Mark all non-completed posts as failed
      if (workflow.posts && Array.isArray(workflow.posts)) {
        workflow.posts.forEach((post) => {
          if (post.status === "completed") {
            completedCount++;
          } else {
            workflowDb.updatePostStatus(post.postId, "failed", 100);
          }
        });
      }

      // Calculate final progress based on completed posts
      const finalProgress =
        totalPosts > 0 ? Math.round((completedCount / totalPosts) * 100) : 0;

      // When manually stopped, mark workflow as "failed" (consistent with frontend)
      workflowDb.updateWorkflowStatus(workflowId, "failed", finalProgress);
      console.log(
        `[Workflow] Marked workflow ${workflowId} as failed with progress ${finalProgress}% (${completedCount}/${totalPosts} posts completed)`,
      );

      // Notify frontend to refresh this workflow's data
      const window = BrowserWindow.getAllWindows()[0];
      if (
        window &&
        !window.isDestroyed() &&
        window.webContents &&
        !window.webContents.isDestroyed()
      ) {
        window.webContents.send("workflow-stopped", {
          workflowId,
          status: "failed",
          progress: finalProgress,
          completedPosts: completedCount,
          totalPosts: totalPosts,
        });
      }
    }
  } catch (error) {
    console.error(
      `[Workflow] Failed to update workflow status: ${error.message}`,
    );
  }

  console.log(
    `🛑🛑🛑 [STOP-WORKFLOW DEBUG] stop-workflow handler completed for ${workflowId}`,
  );
  return true;
});

// ============================================
// CLEAR WORKFLOW STATE FOR RERUN
// This clears stale state without marking workflow as stopped
// Used by frontend before rerunning a workflow
// ============================================
ipcMain.handle("clear-workflow-state-for-rerun", async (_, workflowId) => {
  console.log(`🔄 [RERUN CLEANUP] Clearing state for workflow ${workflowId}...`);
  
  const wfIdStr = String(workflowId);
  
  // 1. Clear from workflowQueue's stoppedWorkflows Set (both string and number forms)
  workflowQueue.stoppedWorkflows.delete(wfIdStr);
  workflowQueue.stoppedWorkflows.delete(parseInt(workflowId, 10));
  console.log(`🔄 [RERUN CLEANUP] Cleared stoppedWorkflows entries`);
  
  // 2. Clear workflowControllers map entry for this workflow
  if (workflowControllers.has(workflowId)) {
    workflowControllers.delete(workflowId);
    console.log(`🔄 [RERUN CLEANUP] Cleared workflowControllers entry`);
  }
  
  // 3. Clear automation-specific state (without aborting or resolving pending requests)
  try {
    clearMidjourneyStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] Midjourney state clear warning: ${e.message}`);
  }
  
  try {
    clearChatGPTImageStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] ChatGPT Image state clear warning: ${e.message}`);
  }
  
  try {
    clearSoraImageStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] Sora Image state clear warning: ${e.message}`);
  }
  
  try {
    clearChatGPTChatStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] ChatGPT Chat state clear warning: ${e.message}`);
  }
  
  try {
    clearGeminiImageStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] Gemini Image state clear warning: ${e.message}`);
  }
  
  try {
    clearVeoStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] Veo 3.1 state clear warning: ${e.message}`);
  }
  
  try {
    clearMetaAIStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] Meta AI state clear warning: ${e.message}`);
  }

  try {
    clearTikTokAdsImageStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] TikTok Ads Image state clear warning: ${e.message}`);
  }

  try {
    clearTikTokAdsVideoStateForRerun(workflowId);
  } catch (e) {
    console.warn(`[RERUN CLEANUP] TikTok Ads Video state clear warning: ${e.message}`);
  }
  
  // 4. Clear image preferences and skip modes
  if (workflowImagePreferences.has(workflowId)) {
    workflowImagePreferences.delete(workflowId);
    console.log(`🔄 [RERUN CLEANUP] Cleared image preferences`);
  }
  if (workflowSkipModes.has(workflowId)) {
    workflowSkipModes.delete(workflowId);
    console.log(`🔄 [RERUN CLEANUP] Cleared skip mode`);
  }
  if (pendingImageSelections.has(workflowId)) {
    pendingImageSelections.delete(workflowId);
    console.log(`🔄 [RERUN CLEANUP] Cleared pending image selections`);
  }

  
  console.log(`🔄 [RERUN CLEANUP] State cleared successfully for workflow ${workflowId}`);
  return { success: true };
});

module.exports = { executeAutomation, setSkipModeForWorkflow };
