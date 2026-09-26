const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  forceClose: () => ipcRenderer.send("window:force-close"),
  reloadApp: () => ipcRenderer.send("window:reload"),
  getAppCloseStatus: () => ipcRenderer.invoke("get-app-close-status"),
  toggleMaxRestore: () => ipcRenderer.send("window:toggle-max"),
  openDevTools: () => ipcRenderer.send("window:open-devtools"),
  refreshFrontend: () => ipcRenderer.send("window:refresh-frontend"),
  isDev: () => ipcRenderer.invoke("is-dev"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openStealthProfile: (profileName, url, proxy, method) =>
    ipcRenderer.invoke("open-stealth-profile", profileName, url, proxy, method),
  startStructureProfile: (profileName, url, proxy, additionalTabUrl) =>
    ipcRenderer.invoke(
      "start-structure-profile",
      profileName,
      url,
      proxy,
      additionalTabUrl,
    ),
  onStealthBrowserClosed: (callback) =>
    ipcRenderer.on("stealth-browser-closed", callback),
  pinterestAutoPublish: (accountId, csvContent) =>
    ipcRenderer.invoke("pinterest-auto-publish", { accountId, csvContent }),
  pinterestAutoPublishBatch: (accountId, csvContents) =>
    ipcRenderer.invoke("pinterest-auto-publish-batch", { accountId, csvContents }),
  onPinterestBatchProgress: (callback) => {
    const wrapper = (_event, data) => callback(data);
    ipcRenderer.on("pinterest-batch-progress", wrapper);
    return wrapper;
  },
  removePinterestBatchProgressListener: (wrapper) =>
    ipcRenderer.removeListener("pinterest-batch-progress", wrapper),
  pinterestGetScheduledPins: (accountId) =>
    ipcRenderer.invoke("pinterest-get-scheduled-pins", { accountId }),
  onShowCloseConfirmation: (callback) =>
    ipcRenderer.on("show-close-confirmation", callback),
  deleteProfile: (profileId) => ipcRenderer.invoke("delete-profile", profileId),
  duplicateProfile: (profileId, profileType, newProfileName) =>
    ipcRenderer.invoke(
      "duplicate-profile",
      profileId,
      profileType,
      newProfileName,
    ),
  repairProfile: (profileId) => ipcRenderer.invoke("repair-profile", profileId),
  readKey: (key) => ipcRenderer.invoke("read-key", key),
  updateData: (key, value) => ipcRenderer.invoke("update-data", key, value),

  // Mailbox Manager — credentials never cross this bridge.
  mailboxesList: (options) => ipcRenderer.invoke("mailboxes-list", options),
  mailboxesAll: () => ipcRenderer.invoke("mailboxes-all"),
  mailboxesTotalUnread: () => ipcRenderer.invoke("mailboxes-total-unread"),
  mailboxesGet: (mailboxId) => ipcRenderer.invoke("mailboxes-get", mailboxId),
  mailboxesTest: (config, mailboxId = null) => ipcRenderer.invoke("mailboxes-test", config, mailboxId),
  mailboxesSave: (config, testToken, mailboxId = null) => ipcRenderer.invoke("mailboxes-save", config, testToken, mailboxId),
  mailboxesDelete: (mailboxId) => ipcRenderer.invoke("mailboxes-delete", mailboxId),
  mailboxesClearCache: (mailboxId) => ipcRenderer.invoke("mailboxes-clear-cache", mailboxId),
  mailboxesResetUnread: (mailboxId) => ipcRenderer.invoke("mailboxes-reset-unread", mailboxId),
  mailboxesFolders: (mailboxId, refresh = false) => ipcRenderer.invoke("mailboxes-folders", mailboxId, refresh),
  mailboxesRefresh: (mailboxId, options) => ipcRenderer.invoke("mailboxes-refresh", mailboxId, options),
  mailboxesMessages: (mailboxId, folderPath, options) => ipcRenderer.invoke("mailboxes-messages", mailboxId, folderPath, options),
  mailboxesMessage: (mailboxId, messageId) => ipcRenderer.invoke("mailboxes-message", mailboxId, messageId),
  mailboxesUpdateFlags: (mailboxId, messageIds, changes) => ipcRenderer.invoke("mailboxes-update-flags", mailboxId, messageIds, changes),
  mailboxesMove: (mailboxId, messageIds, destination) => ipcRenderer.invoke("mailboxes-move", mailboxId, messageIds, destination),
  mailboxesDeleteMessages: (mailboxId, messageIds, permanent = false) => ipcRenderer.invoke("mailboxes-delete-messages", mailboxId, messageIds, permanent),
  mailboxesDownloadAttachment: (mailboxId, messageId, attachmentIndex, destination) => ipcRenderer.invoke("mailboxes-download-attachment", mailboxId, messageId, attachmentIndex, destination),
  mailboxesStartBatch: (type, mailboxIds) => ipcRenderer.invoke("mailboxes-start-batch", type, mailboxIds),
  mailboxesCancelBatch: (jobId) => ipcRenderer.invoke("mailboxes-cancel-batch", jobId),
  mailboxesOutlookStart: () => ipcRenderer.invoke("mailboxes-outlook-start"),
  mailboxesOutlookPoll: (pollToken) => ipcRenderer.invoke("mailboxes-outlook-poll", pollToken),
  onMailboxesJobProgress: (callback) => ipcRenderer.on("mailboxes-job-progress", (_, data) => callback(data)),
  removeMailboxesJobProgressListeners: () => ipcRenderer.removeAllListeners("mailboxes-job-progress"),
  getSystemLocale: () => ipcRenderer.invoke("get-system-locale"),
  getAvailableLocaleCountries: () =>
    ipcRenderer.invoke("get-available-locale-countries"),
  getDetectedCountry: () => ipcRenderer.invoke("get-detected-country"),
  testProxy: (proxyData) => ipcRenderer.invoke("test-proxy", proxyData),
  testProfileLogin: (platform, profileName) =>
    ipcRenderer.invoke("test-profile-login", platform, profileName),
  cancelTestProfileLogin: () => ipcRenderer.invoke("cancel-test-profile-login"),
  startSpy: (platform, profileName, filters) =>
    ipcRenderer.invoke("start-spying", platform, profileName, filters),
  restartSpy: (platform, profileName, filters) =>
    ipcRenderer.invoke("restart-spying", platform, profileName, filters),
  stopSpy: (platform, profileName, reason = "unknown") =>
    ipcRenderer.invoke("stop-spying", platform, profileName, reason),
  addToLibrary: (post, categoryId) =>
    ipcRenderer.invoke("add-to-library", post, categoryId),

  // Library categories
  getLibraryCategories: () => ipcRenderer.invoke("get-library-categories"),
  saveLibraryCategory: (category) =>
    ipcRenderer.invoke("save-library-category", category),
  deleteLibraryCategory: (categoryId) =>
    ipcRenderer.invoke("delete-library-category", categoryId),
  getCategoryFlags: () => ipcRenderer.invoke("get-category-flags"),
  updatePostCategory: (postId, categoryId) =>
    ipcRenderer.invoke("update-post-category", postId, categoryId),

  // Spy post seen/hide tracking (permanent)
  // sharesMap is optional: { postId: sharesCount } for viral growth detection
  markPostsAsSeen: (postIds, sharesMap = {}) =>
    ipcRenderer.invoke("mark-posts-as-seen", postIds, sharesMap),
  // shares is optional for viral growth detection
  hideSpyPost: (postId, shares = 0) =>
    ipcRenderer.invoke("hide-spy-post", postId, shares),

  // Spy post usage tracking
  markSpyPostUsed: (postId, workflowId) =>
    ipcRenderer.invoke("mark-spy-post-used", postId, workflowId),
  resetSpyPostUsed: (postId) =>
    ipcRenderer.invoke("reset-spy-post-used", postId),
  getSpyPostsFiltered: (hideUsed) =>
    ipcRenderer.invoke("get-spy-posts-filtered", hideUsed),
  onSpyPostUsed: (callback) =>
    ipcRenderer.on("spy-post-used", (e, data) => callback(data)),
  onSpyPagesCompleted: (callback) =>
    ipcRenderer.on("spy-pages-completed", (e, data) => callback(data)),
  onSpyPageProgress: (callback) =>
    ipcRenderer.on("spy-page-progress", (e, data) => callback(data)),
  onSpyStopped: (callback) =>
    ipcRenderer.on("spy-stopped", (e, data) => callback(data)),

  // ISE (Image Search Engine) functions
  searchImages: (query, options) =>
    ipcRenderer.invoke("search-images", query, options),
  hideIseImage: (url, source) =>
    ipcRenderer.invoke("hide-ise-image", url, source),
  unhideIseImage: (url) =>
    ipcRenderer.invoke("unhide-ise-image", url),
  getHiddenIseImages: () =>
    ipcRenderer.invoke("get-hidden-ise-images"),
  clearHiddenIseImages: () =>
    ipcRenderer.invoke("clear-hidden-ise-images"),
  markIseImageUsed: (url, source) =>
    ipcRenderer.invoke("mark-ise-image-used", url, source),
  getUsedIseImages: () =>
    ipcRenderer.invoke("get-used-ise-images"),
  clearUsedIseImages: () =>
    ipcRenderer.invoke("clear-used-ise-images"),
  generateIseQueries: (options) =>
    ipcRenderer.invoke("generate-ise-queries", options),
  downloadIseImage: (imageUrl) =>
    ipcRenderer.invoke("download-ise-image", imageUrl),
  downloadIseImages: (imageUrls) =>
    ipcRenderer.invoke("download-ise-images", imageUrls),

  // Pinterest Feed Spy functions
  pinterestFeedSpyInit: (query) =>
    ipcRenderer.invoke("pinterest-feedspy-init", query),
  pinterestFeedSpyInitAccount: (accountId) =>
    ipcRenderer.invoke("pinterest-feedspy-init-account", accountId),
  pfeedSpyMarkUsed: (pinIds) =>
    ipcRenderer.invoke("pfeedspy-mark-used", pinIds),
  pfeedSpyGetUsed: () =>
    ipcRenderer.invoke("pfeedspy-get-used"),
  pfeedSpyGenerateTitles: (opts) =>
    ipcRenderer.invoke("pfeedspy-generate-titles", opts),
  pinterestFeedSpyPage: (opts) =>
    ipcRenderer.invoke("pinterest-feedspy-page", opts),
  pinterestFeedSpyDownloadImages: (imageUrls) =>
    ipcRenderer.invoke("pinterest-feedspy-download-images", imageUrls),
  onPfeedSpyDownloadProgress: (callback) =>
    ipcRenderer.on("pfeedspy-download-progress", (e, data) => callback(data)),
  removePfeedSpyDownloadProgressListeners: () =>
    ipcRenderer.removeAllListeners("pfeedspy-download-progress"),

  // Google Trends functions
  fetchGoogleTrends: (options) =>
    ipcRenderer.invoke("fetch-google-trends", options),
  getGoogleTrendsCategories: () =>
    ipcRenderer.invoke("get-google-trends-categories"),
  getGoogleTrendsRegions: () =>
    ipcRenderer.invoke("get-google-trends-regions"),
  getGoogleTrendsTimeRanges: () =>
    ipcRenderer.invoke("get-google-trends-time-ranges"),
  openGoogleTrendsBrowser: (options) =>
    ipcRenderer.invoke("open-google-trends-browser", options),

  downloadFileToUserData: (url) =>
    ipcRenderer.invoke("download-file-to-userdata", url),
  fetchPageProfileImage: (pageUrl) =>
    ipcRenderer.invoke("fetch-page-profile-image", pageUrl),
  getMusicLibrary: (opts) =>
    ipcRenderer.invoke("get-music-library", opts),
  humanizeAiText: (text, options = {}) =>
    ipcRenderer.invoke("humanize-ai-text", { ...options, text }),
  scoreAiText: (text) =>
    ipcRenderer.invoke("score-ai-text", text),
  humanizeAiTexts: (texts, options = {}) =>
    ipcRenderer.invoke("humanize-ai-texts", { ...options, texts }),
  cancelHumanizeAiTexts: (requestId) =>
    ipcRenderer.invoke("cancel-humanize-ai-texts", requestId),
  onHumanizeAiTextsProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("humanize-ai-texts-progress", handler);
    return () => ipcRenderer.removeListener("humanize-ai-texts-progress", handler);
  },
  downloadMusicFile: (opts) =>
    ipcRenderer.invoke("download-music-file", opts),
  getLocalMusics: () =>
    ipcRenderer.invoke("get-local-musics"),
  veImportMediaFile: (opts) =>
    ipcRenderer.invoke("ve-import-media-file", opts),
  veDeleteMediaFile: (opts) =>
    ipcRenderer.invoke("ve-delete-media-file", opts),
  getUserDataPath: () => ipcRenderer.invoke("get-userdata-path"),
  getShapes: () => ipcRenderer.invoke("get-shapes"),
  getFonts: () => ipcRenderer.invoke("get-fonts"),
  getTTSVoices: () => ipcRenderer.invoke("get-tts-voices"),
  previewTTSVoice: (voice, text) => ipcRenderer.invoke("preview-tts-voice", voice, text),
  getPhotos: (page, query) => ipcRenderer.invoke("get-photos", page, query),
  getUploads: () => ipcRenderer.invoke("get-uploads"),
  uploadImage: () => ipcRenderer.invoke("upload-image"),
  testImageUploadApi: (provider, apiKey) =>
    ipcRenderer.invoke("test-image-upload-api", provider, apiKey),
  testOpenAIApi: (apiKey) =>
    ipcRenderer.invoke("test-openai-api", apiKey),
  updateAutomationImageUploadNodes: (provider, newCredentials) =>
    ipcRenderer.invoke(
      "update-automation-image-upload-nodes",
      provider,
      newCredentials,
    ),
  testVideoUploadApi: (provider, apiKey) =>
    ipcRenderer.invoke("test-video-upload-api", provider, apiKey),
  updateAutomationVideoUploadNodes: (provider, newCredentials) =>
    ipcRenderer.invoke(
      "update-automation-video-upload-nodes",
      provider,
      newCredentials,
    ),
  getIllustrations: (page, search) =>
    ipcRenderer.invoke("get-illustrations", page, search),
  validateWorkflowPreflight: async (automationId, posts) => {
    try {
      return await ipcRenderer.invoke(
        "validate-workflow-preflight",
        automationId,
        posts,
      );
    } catch (err) {
      return { valid: false, errors: [{ type: "system", message: err.message }] };
    }
  },
  executeAutomation: async (workflowId, automationId, posts) => {
    try {
      return await ipcRenderer.invoke(
        "execute-automation",
        workflowId,
        automationId,
        posts,
      );
    } catch (err) {
      return { error: err.message };
    }
  },
  automationLogs: (logData) => ipcRenderer.on("automation-logs", logData),
  finalLogs: (logData) => ipcRenderer.on("final-logs", logData),
  workflowCompleted: (callback) =>
    ipcRenderer.on("workflow-completed", callback),
  workflowStopped: (callback) =>
    ipcRenderer.on("workflow-stopped", (e, data) => callback(data)),
  workflowStatusChanged: (callback) =>
    ipcRenderer.on("workflow-status-changed", (e, data) => callback(data)),
  removeAutomationLogsListeners: () =>
    ipcRenderer.removeAllListeners("automation-logs"),
  removeFinalLogsListeners: () => ipcRenderer.removeAllListeners("final-logs"),
  removeWorkflowCompletedListeners: () =>
    ipcRenderer.removeAllListeners("workflow-completed"),
  removeWorkflowStoppedListeners: () =>
    ipcRenderer.removeAllListeners("workflow-stopped"),
  removeWorkflowStatusChangedListeners: () =>
    ipcRenderer.removeAllListeners("workflow-status-changed"),
  stopWorkflow: (workflowId) => ipcRenderer.invoke("stop-workflow", workflowId),
  clearWorkflowStateForRerun: (workflowId) => 
    ipcRenderer.invoke("clear-workflow-state-for-rerun", workflowId),
  getWorkflowQueueStatus: () => ipcRenderer.invoke("get-workflow-queue-status"),

  // ============================================
  // MONITORING & ANALYTICS
  // ============================================
  getAnalyticsSummary: (hoursAgo = 24) =>
    ipcRenderer.invoke("get-analytics-summary", hoursAgo),
  getNodeTypeStats: (hoursAgo = 24) =>
    ipcRenderer.invoke("get-node-type-stats", hoursAgo),
  getNodeDurations: (hoursAgo = 24) =>
    ipcRenderer.invoke("get-node-durations", hoursAgo),
  getWorkflowCompletionTrend: (hoursAgo = 24) =>
    ipcRenderer.invoke("get-workflow-completion-trend", hoursAgo),
  getPostsCompletionTrend: (hoursAgo = 24) =>
    ipcRenderer.invoke("get-posts-completion-trend", hoursAgo),
  getActiveExecutions: () => ipcRenderer.invoke("get-active-executions"),
  getRecentFailures: (limit = 20) =>
    ipcRenderer.invoke("get-recent-failures", limit),

  // Failure Log File Operations
  getFailureLogs: (limit = 50) =>
    ipcRenderer.invoke("get-failure-logs", limit),
  deleteFailureLog: (lineIndex) =>
    ipcRenderer.invoke("delete-failure-log", lineIndex),
  clearFailureLogs: () =>
    ipcRenderer.invoke("clear-failure-logs"),
  startFailureLogWatcher: () =>
    ipcRenderer.invoke("start-failure-log-watcher"),
  stopFailureLogWatcher: () =>
    ipcRenderer.invoke("stop-failure-log-watcher"),
  onFailureLogUpdated: (callback) =>
    ipcRenderer.on("failure-log-updated", (e, logs) => callback(logs)),
  removeFailureLogUpdatedListeners: () =>
    ipcRenderer.removeAllListeners("failure-log-updated"),

  // ============================================
  // ADVANCED ANALYTICS (PERSISTENT ARCHIVE)
  // ============================================
  getAnalyticsDashboard: (options = {}) =>
    ipcRenderer.invoke("get-analytics-dashboard", options),
  getAutomationAnalytics: (hoursAgo = 24) =>
    ipcRenderer.invoke("get-automation-analytics", hoursAgo),
  getNodeTypeAnalytics: (hoursAgo = 24) =>
    ipcRenderer.invoke("get-node-type-analytics", hoursAgo),
  getPlatformAnalytics: (options = {}) =>
    ipcRenderer.invoke("get-platform-analytics", options),
  getErrorAnalytics: (options = {}) =>
    ipcRenderer.invoke("get-error-analytics", options),
  getPeakUsage: () =>
    ipcRenderer.invoke("get-peak-usage"),
  getCostAnalytics: (options = {}) =>
    ipcRenderer.invoke("get-cost-analytics", options),
  getLifetimeStats: () =>
    ipcRenderer.invoke("get-lifetime-stats"),
  exportAnalytics: (options = {}) =>
    ipcRenderer.invoke("export-analytics", options),
  trackAnalyticsCost: (costData) =>
    ipcRenderer.invoke("track-analytics-cost", costData),
  runAnalyticsCleanup: (daysToKeep = 365) =>
    ipcRenderer.invoke("run-analytics-cleanup", daysToKeep),
  resetAnalyticsData: () =>
    ipcRenderer.invoke("reset-analytics-data"),
  getAutomationsList: () =>
    ipcRenderer.invoke("get-automations-list"),

  onChooseSplitImages: (callback) =>
    ipcRenderer.on("choose-split-images", (e, payload) => callback(payload)),
  sendSplitImagesSelected: (requestId, indexes, workflowPreference) =>
    ipcRenderer.send(
      "split-images-selected",
      requestId,
      indexes,
      workflowPreference,
    ),
  setWorkflowSkipMode: (workflowId, skipMode) =>
    ipcRenderer.invoke("set-workflow-skip-mode", workflowId, skipMode),
  updateWorkflowSkipMode: (workflowId, skipImageChoosing) =>
    ipcRenderer.invoke(
      "update-workflow-skip-mode",
      workflowId,
      skipImageChoosing,
    ),
  updateWorkflowAutomation: (workflowId, automationId) =>
    ipcRenderer.invoke(
      "update-workflow-automation",
      workflowId,
      automationId,
    ),
  onAutoResolvePendingSelections: (callback) =>
    ipcRenderer.on("auto-resolve-pending-selections", (e, payload) =>
      callback(payload),
    ),
  onShowAutoSelectionNotification: (callback) =>
    ipcRenderer.on("show-auto-selection-notification", (e, payload) =>
      callback(payload),
    ),
  onShowMainAlert: (callback) =>
    ipcRenderer.on("show-main-alert", (e, data) => callback(data)),
  onExportProcessingStarted: (callback) =>
    ipcRenderer.on("export-processing-started", () => callback()),
  exportFlowImages: (workflowId) =>
    ipcRenderer.invoke("export-flow-images", workflowId),
  scoreAiImage: (imagePath) =>
    ipcRenderer.invoke("score-ai-image", imagePath),
  showSaveDialog: (options) => ipcRenderer.invoke("show-save-dialog", options),
  showOpenDialog: (options) => ipcRenderer.invoke("show-open-dialog", options),
  saveFile: (filePath, content) =>
    ipcRenderer.invoke("save-file", filePath, content),
  
  
  
  
  
  
  
  
  
  

  // Local application capabilities
  getAppCapabilities: () => ipcRenderer.invoke("get-app-capabilities"),

  checkChrome: () => ipcRenderer.invoke("check-chrome"),
  checkChromedriver: () => ipcRenderer.invoke("check-chromedriver"),
  downloadChromedriver: () => ipcRenderer.invoke("download-chromedriver"),
  onChromedriverDownloadProgress: (callback) =>
    ipcRenderer.on("chromedriver-download-progress", callback),

  // VCBrowser - Undetectable Browser
  checkVCBrowser: () => ipcRenderer.invoke("check-vcbrowser"),
  
  // Get latest stable Chrome version from public API
  getStableChromeVersion: () => ipcRenderer.invoke("get-stable-chrome-version"),

  // Private Messaging methods
  getChatMessages: (options) =>
    ipcRenderer.invoke("get-chat-messages", options),
  sendChatMessage: (conversationId, content, attachment) =>
    ipcRenderer.invoke(
      "send-chat-message",
      conversationId,
      content,
      attachment,
    ),
  getConversations: () => ipcRenderer.invoke("get-conversations"),
  startConversation: (otherEmail) =>
    ipcRenderer.invoke("start-conversation", otherEmail),
  getUserProfile: (email) => ipcRenderer.invoke("get-user-profile", email),
  getUnreadCount: () => ipcRenderer.invoke("get-unread-count"),
  checkNewMessages: (sinceId) =>
    ipcRenderer.invoke("check-new-messages", sinceId),

  // Group chat functions
  createGroupConversation: (name, members, avatar) =>
    ipcRenderer.invoke("create-group-conversation", { name, members, avatar }),
  getGroupMembers: (conversationId) =>
    ipcRenderer.invoke("get-group-members", conversationId),
  addGroupMember: (conversationId, memberEmail) =>
    ipcRenderer.invoke("add-group-member", { conversationId, memberEmail }),
  removeGroupMember: (conversationId, memberEmail) =>
    ipcRenderer.invoke("remove-group-member", { conversationId, memberEmail }),
  leaveGroup: (conversationId, newOwnerEmail) =>
    ipcRenderer.invoke("leave-group", conversationId, newOwnerEmail),
  updateGroupInfo: (conversationId, name, avatar) =>
    ipcRenderer.invoke("update-group-info", { conversationId, name, avatar }),
  updateMemberRole: (conversationId, memberEmail, role) =>
    ipcRenderer.invoke("update-member-role", {
      conversationId,
      memberEmail,
      role,
    }),

  downloadVCBrowser: () => ipcRenderer.invoke("download-vcbrowser"),
  onVCBrowserDownloadProgress: (callback) =>
    ipcRenderer.on("vcbrowser-download-progress", (e, data) => callback(data)),
  removeVCBrowserDownloadProgressListener: () =>
    ipcRenderer.removeAllListeners("vcbrowser-download-progress"),

  exportAutomation: (automationId) =>
    ipcRenderer.invoke("export-automation", automationId),
  importAutomation: (automationName) =>
    ipcRenderer.invoke("import-automation", automationName),
  saveImage: (originalName, buffer) =>
    ipcRenderer.invoke("save-image", originalName, buffer),
  saveAutomationScreenshot: (automationId, dataUrl) =>
    ipcRenderer.invoke("save-automation-screenshot", automationId, dataUrl),
  deleteAutomationThumbnail: (automationId) =>
    ipcRenderer.invoke("delete-automation-thumbnail", automationId),
  inpaintImage: (imageName, maskDataUrl) =>
    ipcRenderer.invoke("inpaint-image", imageName, maskDataUrl),
  textTemplate: (templateId) => ipcRenderer.invoke("text-template", templateId),
  selectPreviewImage: () => ipcRenderer.invoke("select-preview-image"),
  cleanAiImage: (byteArray, options) =>
    ipcRenderer.invoke("clean-ai-image", byteArray, options),
  saveCleanedImage: (suggestedName, byteArray) =>
    ipcRenderer.invoke("save-cleaned-image", suggestedName, byteArray),
  readImageMetadata: (byteArray) =>
    ipcRenderer.invoke("read-image-metadata", byteArray),
  removeGeminiWatermark: (byteArray) =>
    ipcRenderer.invoke("remove-gemini-watermark", byteArray),
  onCaptchaRequired: (cb) =>
    ipcRenderer.on("midjourney-captcha-required", (_e, payload) => cb(payload)),
  onCaptchaCleared: (cb) =>
    ipcRenderer.on("midjourney-captcha-cleared", (_e, payload) => cb(payload)),
  markCaptchaSolved: (profileId) =>
    ipcRenderer.send("midjourney-captcha-solved", profileId),

  // Google Account Disconnection handling
  onGoogleDisconnected: (cb) =>
    ipcRenderer.on("google-account-disconnected", (_e, payload) => cb(payload)),
  onGoogleReconnected: (cb) =>
    ipcRenderer.on("google-account-reconnected", (_e, payload) => cb(payload)),
  markGoogleReconnected: (profileId) =>
    ipcRenderer.send("google-account-reconnected-manual", profileId),
  openGoogleProfileBrowser: (profileId) =>
    ipcRenderer.invoke("open-stealth-profile", profileId, "https://accounts.google.com/ServiceLogin?hl=fr&passive=true&continue=https://www.google.com/&ec=futura_exp_og_so_72776762_e", null, "google-reconnect"),

  // Monitoring functions
  getMonitoringData: () => ipcRenderer.invoke("getMonitoringData"),
  getBrowserScreenshot: (profileName, debuggingPort) =>
    ipcRenderer.invoke("getBrowserScreenshot", profileName, debuggingPort),
  getSpyBrowserInfo: (profileName) =>
    ipcRenderer.invoke("getSpyBrowserInfo", profileName),
  killBrowserInstance: (pid) => ipcRenderer.invoke("killBrowserInstance", pid),
  unblockMidjourneyProfile: (profileId) =>
    ipcRenderer.invoke("unblockMidjourneyProfile", profileId),

  // OpenAI function
  callOpenAI: (apiKey, model, prompt, temperature = 0.7) =>
    ipcRenderer.invoke("call-openai", apiKey, model, prompt, temperature),
  generateAIImage: (apiKey, prompt, size, quality) =>
    ipcRenderer.invoke("generate-ai-image", apiKey, prompt, size, quality),
  generatePollinationsImage: (
    prompt,
    width,
    height,
    model,
    negativePrompt,
    maxRetries,
  ) =>
    ipcRenderer.invoke(
      "generate-pollinations-image",
      prompt,
      width,
      height,
      model,
      negativePrompt,
      maxRetries,
    ),

  // Video Editor AI Image Generation
  generateVEImage: (provider, prompt, options) =>
    ipcRenderer.invoke("generate-ve-image", provider, prompt, options),

  // Policy Violation Check
  checkPostPolicyViolation: (options) =>
    ipcRenderer.invoke("check-post-policy-violation", options),
  fixPolicyText: (options) =>
    ipcRenderer.invoke("fix-policy-text", options),
  regeneratePolicyImage: (options) =>
    ipcRenderer.invoke("regenerate-policy-image", options),

  // Smart Split - AI content analysis
  analyzePostContent: (options) =>
    ipcRenderer.invoke("analyze-post-content", options),
  generateImagePrompt: (options) =>
    ipcRenderer.invoke("generate-image-prompt", options),
  updatePostText: (options) =>
    ipcRenderer.invoke("update-post-text", options),
  updatePostImage: (options) =>
    ipcRenderer.invoke("update-post-image", options),
  savePostExportIndices: (exportIndices) =>
    ipcRenderer.invoke("save-post-export-indices", exportIndices),

  // Backup System functions
  createFullBackup: () => ipcRenderer.invoke("create-full-backup"),
  getBackupEstimate: () => ipcRenderer.invoke("get-backup-estimate"),
  validateBackupFile: (filePath) =>
    ipcRenderer.invoke("validate-backup-file", filePath),
  getBackupInfo: (filePath) => ipcRenderer.invoke("get-backup-info", filePath),
  restoreFromBackup: (filePath, options) =>
    ipcRenderer.invoke("restore-from-backup", filePath, options),
  selectBackupFile: () => ipcRenderer.invoke("select-backup-file"),

  // Backup progress listeners
  onBackupProgress: (callback) =>
    ipcRenderer.on("backup-progress", (event, data) => callback(data)),
  onRestoreProgress: (callback) =>
    ipcRenderer.on("restore-progress", (event, data) => callback(data)),
  removeBackupProgressListeners: () => {
    ipcRenderer.removeAllListeners("backup-progress");
    ipcRenderer.removeAllListeners("restore-progress");
  },

  // App restart function
  restartApp: () => {
    ipcRenderer.send("restart-app");
  },

  // MiniCanvas template import/export
  exportTemplateFile: (template, defaultFileName) =>
    ipcRenderer.invoke("export-template-file", template, defaultFileName),
  exportAllTemplatesFile: (templates) =>
    ipcRenderer.invoke("export-all-templates-file", templates),
  importTemplateFile: () => ipcRenderer.invoke("import-template-file"),

  // Test automation
  testAutomation: (automationId, inputs) =>
    ipcRenderer.invoke("test-automation", automationId, inputs),
  onTestAutomationLog: (callback) =>
    ipcRenderer.on("test-automation-log", (e, data) => callback(data)),
  removeTestAutomationLogListeners: () =>
    ipcRenderer.removeAllListeners("test-automation-log"),
  stopTestAutomation: (testId) =>
    ipcRenderer.invoke("stop-test-automation", testId),

  // Telegram Notifications
  validateTelegramBot: (botToken) =>
    ipcRenderer.invoke("validate-telegram-bot", botToken),
  sendTelegramTest: (botToken, chatId) =>
    ipcRenderer.invoke("send-telegram-test", botToken, chatId),
  sendTelegramWelcome: (botToken, chatId) =>
    ipcRenderer.invoke("send-telegram-welcome", botToken, chatId),
  getTelegramChatIdInstructions: () =>
    ipcRenderer.invoke("get-telegram-chat-id-instructions"),
  initializeTelegramNotifications: () =>
    ipcRenderer.invoke("initialize-telegram-notifications"),

  // System Notifications
  sendSystemNotificationTest: () =>
    ipcRenderer.invoke("send-system-notification-test"),
  initializeSystemNotifications: () =>
    ipcRenderer.invoke("initialize-system-notifications"),

  // Database Migration
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // Fix stuck workflows - call this when workflows page loads
  fixStuckWorkflows: () => ipcRenderer.invoke("fix-stuck-workflows"),

  // Splash screen
  onSplashReady: (callback) => ipcRenderer.on("splash-ready", () => callback()),

  // App Info
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadAndInstallUpdate: (downloadUrl) =>
    ipcRenderer.invoke("download-and-install-update", downloadUrl),
  onUpdateDownloadProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("update-download-progress", handler);
    return () => ipcRenderer.removeListener("update-download-progress", handler);
  },
  onUpdateAvailable: (callback) =>
    ipcRenderer.on("update-available-notification", (_, data) =>
      callback(data),
    ),
  removeUpdateAvailableListener: () =>
    ipcRenderer.removeAllListeners("update-available-notification"),

  // User Profile
  uploadAvatar: (avatarDataUrl) =>
    ipcRenderer.invoke("upload-avatar", avatarDataUrl),

  // Notes API
  getNotes: () => ipcRenderer.invoke("get-notes"),
  createNote: (note) => ipcRenderer.invoke("create-note", note),
  updateNote: (note) => ipcRenderer.invoke("update-note", note),
  deleteNote: (noteId) => ipcRenderer.invoke("delete-note", noteId),

  // Community Forum API
  getForumPosts: (options) => ipcRenderer.invoke("get-forum-posts", options),
  getForumPost: (postId) => ipcRenderer.invoke("get-forum-post", postId),
  createForumPost: (post) => ipcRenderer.invoke("create-forum-post", post),
  updateForumPost: (post) => ipcRenderer.invoke("update-forum-post", post),
  deleteForumPost: (postId) => ipcRenderer.invoke("delete-forum-post", postId),
  likeForumPost: (postId) => ipcRenderer.invoke("like-forum-post", postId),
  getForumComments: (postId) =>
    ipcRenderer.invoke("get-forum-comments", postId),
  createForumComment: (comment) =>
    ipcRenderer.invoke("create-forum-comment", comment),
  deleteForumComment: (commentId) =>
    ipcRenderer.invoke("delete-forum-comment", commentId),
  likeForumComment: (commentId) =>
    ipcRenderer.invoke("like-forum-comment", commentId),

  // Community Users API
  getLiveUsers: () => ipcRenderer.invoke("get-live-users"),
  searchUsers: (query) => ipcRenderer.invoke("search-users", query),
  getAllUsers: (options) => ipcRenderer.invoke("get-all-users", options),
  communityHeartbeat: () => ipcRenderer.invoke("community-heartbeat"),

  // Bug Reports & Suggestions API
  submitReport: (report) => ipcRenderer.invoke("submit-report", report),
  getUserReports: (options) => ipcRenderer.invoke("get-user-reports", options),
  getReport: (reportId) => ipcRenderer.invoke("get-report", reportId),
  addReportComment: (data) => ipcRenderer.invoke("add-report-comment", data),

  // 2Captcha
  testTwoCaptchaKey: (apiKey) =>
    ipcRenderer.invoke("test-twocaptcha-key", apiKey),

  // DeepSeek Browser test
  testDeepSeekBrowserProfile: (profileId) =>
    ipcRenderer.invoke("test-deepseekbrowser-profile", profileId),

  // Qwen Browser test
  testQwenBrowserProfile: (profileId) =>
    ipcRenderer.invoke("test-qwenbrowser-profile", profileId),

  // TikTok Ads test
  testTikTokAdsProfile: (profileId) =>
    ipcRenderer.invoke("test-tiktokads-profile", profileId),

  // Qwen captcha solver test (visible browser, auto-drags the slider)
  testQwenBrowserCaptcha: (profileId, opts) =>
    ipcRenderer.invoke("test-qwenbrowser-captcha", profileId, opts || {}),
  onQwenCaptchaLog: (callback) => {
    const handler = (_event, line) => callback(line);
    ipcRenderer.on("qwen-captcha-log", handler);
    return () => ipcRenderer.removeListener("qwen-captcha-log", handler);
  },

  // SerpAPI
  testSerpApiKey: (apiKey) =>
    ipcRenderer.invoke("test-serpapi-key", apiKey),
  refreshSerpApiUsage: () =>
    ipcRenderer.invoke("refresh-serpapi-usage"),

  // IPRegistry
  testIpregistryKey: (apiKey) =>
    ipcRenderer.invoke("test-ipregistry-key", apiKey),

  // Proxy Rotation
  findCleanProxy: (proxyData, maxAttempts) =>
    ipcRenderer.invoke("find-clean-proxy", proxyData, maxAttempts),
  onProxyCheckProgress: (callback) => {
    // Wrap and store the reference so callers can remove exactly this handler
    // without nuking other concurrent listeners (e.g. bulk publish with 3 workflows).
    const wrapper = (_event, data) => callback(data);
    ipcRenderer.on("proxy-check-progress", wrapper);
    return wrapper; // caller must pass this back to removeProxyCheckProgressListener
  },
  removeProxyCheckProgressListener: (handler) => {
    if (handler) {
      // Remove only this specific handler — safe for concurrent use
      ipcRenderer.removeListener("proxy-check-progress", handler);
    } else {
      // No handler provided → remove all (backward-compat for single-account callers)
      ipcRenderer.removeAllListeners("proxy-check-progress");
    }
  },

  // Pinterest Trends
  fetchPinterestTrends: (category, country) =>
    ipcRenderer.invoke("fetch-pinterest-trends", category, country),

  // Facebook Scraper
  extractFacebookPostImage: (postUrl) =>
    ipcRenderer.invoke("extract-facebook-post-image", postUrl),
  extractFacebookPost: (postUrl, timeoutMs) =>
    ipcRenderer.invoke("extract-facebook-post", postUrl, timeoutMs),
  scrapeFacebookPostSimple: (postUrl) =>
    ipcRenderer.invoke("scrape-facebook-post-simple", postUrl),

  // Facebook Insights
  selectFacebookInsightsCsv: () =>
    ipcRenderer.invoke("select-facebook-insights-csv"),
  parseFacebookInsightsCsv: (filePath) =>
    ipcRenderer.invoke("parse-facebook-insights-csv", filePath),
  processFacebookInsightsPosts: (posts) =>
    ipcRenderer.invoke("process-facebook-insights-posts", posts),
  onFbInsightsProgress: (callback) =>
    ipcRenderer.on("fb-insights-progress", (e, data) => callback(data)),
  removeFbInsightsProgressListeners: () =>
    ipcRenderer.removeAllListeners("fb-insights-progress"),

  // Facebook Content Analytics
  analyzeFacebookContent: (options) =>
    ipcRenderer.invoke("analyze-facebook-content", options),
  onImageAnalysisProgress: (callback) =>
    ipcRenderer.on("image-analysis-progress", (e, data) => callback(data)),
  removeImageAnalysisProgressListeners: () =>
    ipcRenderer.removeAllListeners("image-analysis-progress"),

  // FB Analytics Scan Persistence
  saveFbAnalyticsScan: (scanData) =>
    ipcRenderer.invoke("save-fb-analytics-scan", scanData),
  getFbAnalyticsScans: () =>
    ipcRenderer.invoke("get-fb-analytics-scans"),
  loadFbAnalyticsScan: (scanId) =>
    ipcRenderer.invoke("load-fb-analytics-scan", scanId),
  deleteFbAnalyticsScan: (scanId) =>
    ipcRenderer.invoke("delete-fb-analytics-scan", scanId),

  // FB Analytics AI Chat
  fbAnalyticsChatStream: (params) =>
    ipcRenderer.invoke("fb-analytics-chat-stream", params),
  onFbAnalyticsChatChunk: (callback) =>
    ipcRenderer.on("fb-analytics-chat-chunk", (e, data) => callback(data)),
  removeFbAnalyticsChatChunkListener: () =>
    ipcRenderer.removeAllListeners("fb-analytics-chat-chunk"),
  saveFbAnalyticsChat: (params) =>
    ipcRenderer.invoke("save-fb-analytics-chat", params),
  getFbAnalyticsChats: (scanId) =>
    ipcRenderer.invoke("get-fb-analytics-chats", scanId),
  loadFbAnalyticsChat: (params) =>
    ipcRenderer.invoke("load-fb-analytics-chat", params),
  deleteFbAnalyticsChat: (params) =>
    ipcRenderer.invoke("delete-fb-analytics-chat", params),

  // OpenAI Queue Statistics (for monitoring rate limiting)
  getOpenAIQueueStats: () => ipcRenderer.invoke("get-openai-queue-stats"),

  // OpenRouter Queue Statistics
  getOpenRouterQueueStats: () => ipcRenderer.invoke("get-openrouter-queue-stats"),

  // Google AI Queue Statistics
  getGoogleAIQueueStats: () => ipcRenderer.invoke("get-googleai-queue-stats"),

  // Anthropic Queue Statistics
  getAnthropicQueueStats: () => ipcRenderer.invoke("get-anthropic-queue-stats"),

  // Chinese AI Queue Statistics
  getChineseAIQueueStats: () => ipcRenderer.invoke("get-chineseai-queue-stats"),

  // GPT-Image Queue Statistics
  getGPTImageQueueStats: () => ipcRenderer.invoke("get-gptimage-queue-stats"),

  // Sora Image Queue Statistics & Enabled Profiles
  getSoraImageQueueStats: () => ipcRenderer.invoke("get-soraimage-queue-stats"),
  saveEnabledSoraProfiles: (profileIds) => ipcRenderer.invoke("save-enabled-sora-profiles", profileIds),
  getEnabledSoraProfiles: () => ipcRenderer.invoke("get-enabled-sora-profiles"),

  // Gemini Image Enabled Profiles
  saveEnabledGeminiImageProfiles: (profileIds) => ipcRenderer.invoke("save-enabled-gemini-image-profiles", profileIds),
  getEnabledGeminiImageProfiles: () => ipcRenderer.invoke("get-enabled-gemini-image-profiles"),

  // Veo 3.1 Enabled Profiles
  saveEnabledVeoProfiles: (profileIds) => ipcRenderer.invoke("save-enabled-veo-profiles", profileIds),
  getEnabledVeoProfiles: () => ipcRenderer.invoke("get-enabled-veo-profiles"),

  // Fetch OpenRouter models
  fetchOpenRouterModels: () => ipcRenderer.invoke("fetch-openrouter-models"),

  // Startup cleanup (used by precheck page)
  getStartupCleanupStatus: () => ipcRenderer.invoke("get-startup-cleanup-status"),
  runStartupCleanup: () => ipcRenderer.invoke("run-startup-cleanup"),
  onCleanupProgress: (callback) =>
    ipcRenderer.on("cleanup-progress", (e, data) => callback(data)),
  removeCleanupProgressListener: () =>
    ipcRenderer.removeAllListeners("cleanup-progress"),
    
  // Manual cleanup (used by settings page)
  getCleanupStatus: () => ipcRenderer.invoke("get-cleanup-status"),
  runCleanup: () => ipcRenderer.invoke("run-cleanup"),
  cleanProfileCaches: () => ipcRenderer.invoke("clean-profile-caches"),

  // Activity Log (persistent activity tracking)
  logActivity: (type, message, sourceType = null, sourceId = null) =>
    ipcRenderer.invoke("log-activity", type, message, sourceType, sourceId),
  getRecentActivities: (limit = 50) =>
    ipcRenderer.invoke("get-recent-activities", limit),
  clearActivities: () => ipcRenderer.invoke("clear-activities"),

  // AI Usage tracking
  getMyAIUsage: () => ipcRenderer.invoke("get-my-ai-usage"),
  onAITokensConsumed: (callback) =>
    ipcRenderer.on("ai-tokens-consumed", (e, data) => callback(data)),
  removeAITokensConsumedListener: () =>
    ipcRenderer.removeAllListeners("ai-tokens-consumed"),

  // AI Automation Agent
  automationAgentStream: (params) =>
    ipcRenderer.invoke("automation-agent-stream", params),
  stopAutomationAgent: () =>
    ipcRenderer.invoke("stop-automation-agent"),
  onAutomationAgentChunk: (callback) =>
    ipcRenderer.on("automation-agent-chunk", (e, data) => callback(data)),
  removeAutomationAgentListeners: () =>
    ipcRenderer.removeAllListeners("automation-agent-chunk"),
  getAutomationAgentTools: () =>
    ipcRenderer.invoke("get-automation-agent-tools"),
  saveAgentSessionLog: (logData) =>
    ipcRenderer.invoke("save-agent-session-log", logData),
  openAgentLogsFolder: () =>
    ipcRenderer.invoke("open-agent-logs-folder"),

  // ViralCloner AI (VCAI) - Self-hosted LLM Bridge
  vcaiChatCompletion: (params) =>
    ipcRenderer.invoke("vcai-chat-completion", params),
  vcaiGetUsage: () =>
    ipcRenderer.invoke("vcai-get-usage"),
  vcaiHealth: () =>
    ipcRenderer.invoke("vcai-health"),

  // ============================================
  // STRUCTURE 2FA MANAGEMENT
  // ============================================
  
  generateTotpSecret: (profileLabel) =>
    ipcRenderer.invoke("generate-totp-secret", profileLabel),
  getTotpCode: (encryptedSecret) =>
    ipcRenderer.invoke("get-totp-code", encryptedSecret),
  verifyTotpCode: (encryptedSecret, code) =>
    ipcRenderer.invoke("verify-totp-code", encryptedSecret, code),
  saveProfileTotp: (structureId, profileId, entryId, name, encryptedSecret) =>
    ipcRenderer.invoke("save-profile-totp", structureId, profileId, entryId, name, encryptedSecret),
  removeProfileTotp: (structureId, profileId, entryId) =>
    ipcRenderer.invoke("remove-profile-totp", structureId, profileId, entryId),
  transferStructureProfile: (sourceStructureId, targetStructureId, profileId) =>
    ipcRenderer.invoke("transfer-structure-profile", sourceStructureId, targetStructureId, profileId),
  encryptTotpSecret: (rawSecretBase32) =>
    ipcRenderer.invoke("encrypt-totp-secret", rawSecretBase32),
  decryptTotpSecret: (encryptedSecret) =>
    ipcRenderer.invoke("decrypt-totp-secret", encryptedSecret),

  // ============================================
  // SEO IMAGE METADATA GENERATION
  // ============================================
  generateSeoMetadata: (imagePath, settings) =>
    ipcRenderer.invoke("generate-seo-metadata", imagePath, settings),
  testGoogleSuggestions: (keyword, proxy) =>
    ipcRenderer.invoke("test-google-suggestions", keyword, proxy),
  applySeoMetadataToImage: (imagePath, seoMetadata) =>
    ipcRenderer.invoke("apply-seo-metadata-to-image", imagePath, seoMetadata),
  getSeoMetadataSettings: () =>
    ipcRenderer.invoke("get-seo-metadata-settings"),
  saveSeoMetadataSettings: (settings) =>
    ipcRenderer.invoke("save-seo-metadata-settings", settings),

  // ============================================
  // VIDEO EDITOR
  // ============================================
  checkFFmpeg: () => ipcRenderer.invoke("check-ffmpeg"),
  downloadFFmpeg: () => ipcRenderer.invoke("download-ffmpeg"),
  onFFmpegDownloadProgress: (callback) => {
    const handler = (_, ...args) => callback(...args);
    ipcRenderer.on("ffmpeg-download-progress", handler);
    return handler;
  },
  removeFFmpegDownloadProgressListeners: () =>
    ipcRenderer.removeAllListeners("ffmpeg-download-progress"),
  exportVideo: (project, settings) =>
    ipcRenderer.invoke("export-video", project, settings),
  cancelVideoExport: () => ipcRenderer.invoke("cancel-video-export"),
  startFrameExport: (settings) =>
    ipcRenderer.invoke("start-frame-export", settings),
  writeExportFrame: (frameBuffer) =>
    ipcRenderer.invoke("write-export-frame", frameBuffer),
  finishFrameExport: () => ipcRenderer.invoke("finish-frame-export"),
  extractVideoFramesCFR: (opts) =>
    ipcRenderer.invoke("ve-extract-video-frames", opts),
  cleanupExtractedFrames: (dir) =>
    ipcRenderer.invoke("ve-cleanup-extracted-frames", dir),
  onVideoExportProgress: (callback) => {
    const handler = (_, ...args) => callback(...args);
    ipcRenderer.on("video-export-progress", handler);
    return handler;
  },
  removeVideoExportProgressListeners: () =>
    ipcRenderer.removeAllListeners("video-export-progress"),

  // Automation-triggered frame-by-frame export (main→renderer→main)
  onAutoExportVideo: (callback) => {
    ipcRenderer.on("ve-auto-export", (event, data) => callback(data));
  },
  autoExportResult: (result) =>
    ipcRenderer.send("ve-auto-export-result", result),

  getVideoMetadata: (filePath) =>
    ipcRenderer.invoke("get-video-metadata", filePath),

  // Audio Transcription (Whisper API)
  transcribeAudio: (filePath, language) =>
    ipcRenderer.invoke("transcribe-audio", filePath, language),
  extractAudio: (videoFilePath) =>
    ipcRenderer.invoke("extract-audio", videoFilePath),

  // Video Editor Project Export/Import (.vcve)
  exportVideoProject: (project, name) =>
    ipcRenderer.invoke("export-video-project", project, name),
  importVideoProject: () =>
    ipcRenderer.invoke("import-video-project"),
  prepareVideoProjectForShare: (project) =>
    ipcRenderer.invoke("prepare-video-project-for-share", project),
  importVideoProjectFromData: (data) =>
    ipcRenderer.invoke("import-video-project-from-data", data),

  // ============================================
  // FEEDSPY
  // ============================================
  testFeedSpyLogin: (email, password) =>
    ipcRenderer.invoke("test-feedspy-login", { email, password }),
  startFeedSpySpy: (targetPages, postsPerPage, filters) =>
    ipcRenderer.invoke("start-feedspy-spy", { targetPages, postsPerPage, filters }),
  stopFeedSpySpy: () => ipcRenderer.invoke("stop-feedspy-spy"),

  // ============================================
  // Pinterest Analytics
  // ============================================
  getPinterestDailyMetrics: (accountId, metricType, startDate, endDate) =>
    ipcRenderer.invoke("get-pinterest-daily-metrics", accountId, metricType, startDate, endDate),
  getPinterestTopPins: (accountId, metricType, fetchDate) =>
    ipcRenderer.invoke("get-pinterest-top-pins", accountId, metricType, fetchDate),
  getPinterestFetchLog: (accountId) =>
    ipcRenderer.invoke("get-pinterest-fetch-log", accountId),
  triggerPinterestAnalyticsFetch: (force = false, selectedAccounts = null) =>
    ipcRenderer.invoke("trigger-pinterest-analytics-fetch", force, selectedAccounts),
  getPinterestAnalyticsSummary: () =>
    ipcRenderer.invoke("get-pinterest-analytics-summary"),
  getPinterestAccountsStatus: () =>
    ipcRenderer.invoke("get-pinterest-accounts-status"),
  retryPinterestAccount: (accountId) =>
    ipcRenderer.invoke("retry-pinterest-account", accountId),

  // Pinterest Collection Settings
  getPinterestCollectionSettings: () =>
    ipcRenderer.invoke("get-pinterest-collection-settings"),
  updatePinterestCollectionSettings: (settings) =>
    ipcRenderer.invoke("update-pinterest-collection-settings", settings),
  getPinterestCollectionStatus: () =>
    ipcRenderer.invoke("get-pinterest-collection-status"),
  onPinterestCollectionLog: (callback) =>
    ipcRenderer.on("pinterest-collection-log", (_, data) => callback(data)),
  offPinterestCollectionLog: () =>
    ipcRenderer.removeAllListeners("pinterest-collection-log"),
  onPinterestAccountProgress: (callback) =>
    ipcRenderer.on("pinterest-account-progress", (_, data) => callback(data)),
  offPinterestAccountProgress: () =>
    ipcRenderer.removeAllListeners("pinterest-account-progress"),
  updatePinterestSelectedAccounts: (selectedAccounts) =>
    ipcRenderer.invoke("update-pinterest-selected-accounts", selectedAccounts),

  // WP Auto Category
  wpacFetchUncategorized: (siteId) =>
    ipcRenderer.invoke("wpac-fetch-uncategorized", siteId),
  wpacCategorizePost: (siteId, postId, postTitle, categories) =>
    ipcRenderer.invoke("wpac-categorize-post", siteId, postId, postTitle, categories),

  // ============================================
  // Pinterest Profile Scanner
  // ============================================
  scanPinterestProfile: (username) =>
    ipcRenderer.invoke("scan-pinterest-profile", username),
  onPinterestScanProgress: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("pinterest-scan-progress", handler);
    return () => ipcRenderer.removeListener("pinterest-scan-progress", handler);
  },

  // Pinterest Keyword Research
  pinterestKwAutotype: (term, count) =>
    ipcRenderer.invoke("pinterest-kw-autotype", term, count),
  pinterestKwSuggestions: (keyword, country) =>
    ipcRenderer.invoke("pinterest-kw-suggestions", keyword, country),
  pinterestKwData: (keyword) =>
    ipcRenderer.invoke("pinterest-kw-data", keyword),
  pinterestKwCacheGet: (keyword, country) =>
    ipcRenderer.invoke("pinterest-kw-cache-get", keyword, country),
  pinterestKwCacheSet: (keyword, country, data) =>
    ipcRenderer.invoke("pinterest-kw-cache-set", keyword, country, data),
  pinterestKwKd: (keyword) =>
    ipcRenderer.invoke("pinterest-kw-kd", keyword),
  pinterestKwVolume: (keyword) =>
    ipcRenderer.invoke("pinterest-kw-volume", keyword),
  pinterestKwDemographics: (terms, country, days) =>
    ipcRenderer.invoke("pinterest-kw-demographics", terms, country, days),
  pinterestKwTopPins: (keyword, limit) =>
    ipcRenderer.invoke("pinterest-kw-top-pins", keyword, limit),

  // ============================================
  // Facebook Groups
  // ============================================
  fbGroupsGetAll:       ()                                                                     => ipcRenderer.invoke("fb-groups-get-all"),
  fbGroupsGetStats:     ()                                                                     => ipcRenderer.invoke("fb-groups-get-stats"),
  fbGroupsGetById:      (id)                                                                   => ipcRenderer.invoke("fb-groups-get-by-id", id),
  fbGroupsSearch:       (query)                                                                => ipcRenderer.invoke("fb-groups-search", query),
  fbGroupsCreate:       (groupId, name, url, notes)                                            => ipcRenderer.invoke("fb-groups-create", groupId, name, url, notes),
  fbGroupsUpdate:       (groupId, name, url, notes)                                            => ipcRenderer.invoke("fb-groups-update", groupId, name, url, notes),
  fbGroupsDelete:       (id)                                                                   => ipcRenderer.invoke("fb-groups-delete", id),
  fbGroupsGetProfiles:  (groupId)                                                              => ipcRenderer.invoke("fb-groups-get-profiles", groupId),
  fbGroupsAddProfile:   (groupId, structureId, profileId, profileLabel, structureLabel)        => ipcRenderer.invoke("fb-groups-add-profile", groupId, structureId, profileId, profileLabel, structureLabel),
  fbGroupsRemoveProfile:(groupId, profileId)                                                   => ipcRenderer.invoke("fb-groups-remove-profile", groupId, profileId),
  fbGroupsGetPostLog:        (groupId, limit, offset) => ipcRenderer.invoke("fb-groups-get-post-log", groupId, limit, offset),
  fbGroupsUpdateLogPostId:   (id, postId)             => ipcRenderer.invoke("fb-groups-update-log-post-id", id, postId),
  fbGroupsNewPost:       (groupId, message, imagePath) => ipcRenderer.invoke("fb-groups-new-post", groupId, message, imagePath),
  fbGroupsPostFromProfile: (profileId, groupId, message, imagePath) => ipcRenderer.invoke("fb-groups-post-from-profile", profileId, groupId, message, imagePath),
  fbGroupsEditPost:      (groupId, storyId, message)  => ipcRenderer.invoke("fb-groups-edit-post", groupId, storyId, message),
  fbGroupsAddComment:    (groupId, storyId, message, imagePath)  => ipcRenderer.invoke("fb-groups-add-comment", groupId, storyId, message, imagePath),
  fbGroupsScanPost:      (groupId, storyId)           => ipcRenderer.invoke("fb-groups-scan-post", groupId, storyId),
  fbGroupsScanGroupInfo: (groupId)                    => ipcRenderer.invoke("fb-groups-scan-group-info", groupId),
  fbGroupsScanProfile: (profileId, profileLabel)      => ipcRenderer.invoke("fb-groups-scan-profile", profileId, profileLabel),
  fbGroupsTestHttpSession: (groupId)                  => ipcRenderer.invoke("fb-groups-test-http-session", groupId),
  fbGroupsEditComment:     (groupId, commentId, text, imagePath) => ipcRenderer.invoke("fb-groups-edit-comment", groupId, commentId, text, imagePath),
  fbGroupsRefreshDocIds:   (groupId)                  => ipcRenderer.invoke("fb-groups-refresh-doc-ids", groupId),
  fbGroupsTestDocIds:      ()                         => ipcRenderer.invoke("fb-groups-test-doc-ids"),
  // Automation orchestration
  fbGroupsImportWorkflow:          (workflowId, name, settings, groupTargets) => ipcRenderer.invoke("fb-groups-import-workflow", workflowId, name, settings, groupTargets),
  fbGroupsRemoveImportedWorkflow:  (workflowId)                               => ipcRenderer.invoke("fb-groups-remove-imported-workflow", workflowId),
  fbGroupsGetImportedWorkflows:    ()                                          => ipcRenderer.invoke("fb-groups-get-imported-workflows"),
  fbGroupsGetImportedWorkflowIds:  ()                                          => ipcRenderer.invoke("fb-groups-get-imported-workflow-ids"),
  fbGroupsGetWorkflowSettings:     (workflowId)                               => ipcRenderer.invoke("fb-groups-get-workflow-settings", workflowId),
  fbGroupsUpdateWorkflowSettings:  (workflowId, settings)                     => ipcRenderer.invoke("fb-groups-update-workflow-settings", workflowId, settings),
  fbGroupsSetWorkflowStatus:       (workflowId, status)                       => ipcRenderer.invoke("fb-groups-set-workflow-status", workflowId, status),
  fbGroupsRestartWorkflow:         (workflowId)                               => ipcRenderer.invoke("fb-groups-restart-workflow", workflowId),
  fbGroupsUpdateWorkflowTargets:   (workflowId, targets)                      => ipcRenderer.invoke("fb-groups-update-workflow-targets", workflowId, targets),
  // Manual workflows
  fbGroupsCreateManualWorkflow:    (name, settings, groupTargets)             => ipcRenderer.invoke("fb-groups-create-manual-workflow", name, settings, groupTargets),
  // Posts Library
  fbGroupsGetLibraryPosts:         ()                                         => ipcRenderer.invoke("fb-groups-get-library-posts"),
  fbGroupsAddLibraryPost:          (name, text, imagePath, url)               => ipcRenderer.invoke("fb-groups-add-library-post", name, text, imagePath, url),
  fbGroupsUpdateLibraryPost:       (id, name, text, imagePath, url)           => ipcRenderer.invoke("fb-groups-update-library-post", id, name, text, imagePath, url),
  fbGroupsDeleteLibraryPost:       (id)                                       => ipcRenderer.invoke("fb-groups-delete-library-post", id),
  fbGroupsPickLibraryPostImage:    ()                                         => ipcRenderer.invoke("fb-groups-pick-library-post-image"),
  fbGroupsImportLibraryCsv:        (csvText)                                  => ipcRenderer.invoke("fb-groups-import-library-csv", csvText),
  fbGroupsGetWorkflowLibraryPosts: (workflowId)                               => ipcRenderer.invoke("fb-groups-get-workflow-library-posts", workflowId),
  fbGroupsSetWorkflowLibraryPosts: (workflowId, postIds)                      => ipcRenderer.invoke("fb-groups-set-workflow-library-posts", workflowId, postIds),
  fbGroupsGetDashboardStats:       ()                                          => ipcRenderer.invoke("fb-groups-get-dashboard-stats"),
  fbGroupsGetRecentActivity:       (limit)                                     => ipcRenderer.invoke("fb-groups-get-recent-activity", limit),
  fbGroupsGetAutomationPosts:      (workflowId, limit, offset)                => ipcRenderer.invoke("fb-groups-get-automation-posts", workflowId, limit, offset),
  fbGroupsGetPostsFeed:            (limit, offset, vmStatus)                  => ipcRenderer.invoke("fb-groups-get-posts-feed", limit, offset, vmStatus),
  fbGroupsGetExpiredPostsFeed:     (limit, offset)                            => ipcRenderer.invoke("fb-groups-get-expired-posts-feed", limit, offset),
  fbGroupsRefreshExpiredStats:     (storyId)                                  => ipcRenderer.invoke("fb-groups-refresh-expired-stats", storyId),
  fbGroupsForceCheckMonitor:       (storyId)                                  => ipcRenderer.invoke("fb-groups-force-check-monitor", storyId),
  fbGroupsStopMonitor:             (automationPostId)                          => ipcRenderer.invoke("fb-groups-stop-monitor", automationPostId),
  fbGroupsDeletePost:              (automationPostId)                          => ipcRenderer.invoke("fb-groups-delete-post", automationPostId),
  fbGroupsGetViralMonitors:        (status)                                    => ipcRenderer.invoke("fb-groups-get-viral-monitors", status),
  fbGroupsGetViralMonitorHistory:  (limit)                                     => ipcRenderer.invoke("fb-groups-get-viral-monitor-history", limit),
  fbGroupsGetLiveLogs:             ()                                          => ipcRenderer.invoke("fb-groups-get-live-logs"),
  fbGroupsGetAnalytics:            (daysAgo)                                   => ipcRenderer.invoke("fb-groups-get-analytics", daysAgo),
  fbGroupsGetSettings:             ()                                          => ipcRenderer.invoke("fb-groups-get-settings"),
  fbGroupsSaveSettings:            (settings)                                  => ipcRenderer.invoke("fb-groups-save-settings", settings),
  fbGroupsPauseMonitoring:         ()                                          => ipcRenderer.invoke("fb-groups-pause-monitoring"),
  fbGroupsResumeMonitoring:        (daysAgo)                                   => ipcRenderer.invoke("fb-groups-resume-monitoring", daysAgo),
  fbGroupsGetProfilesOverview:     ()                                          => ipcRenderer.invoke("fb-groups-get-profiles-overview"),
  fbGroupsGetProfileDetail:        (profileId)                                 => ipcRenderer.invoke("fb-groups-get-profile-detail", profileId),
  fbGroupsGetProfileHistory:       (profileId, limit, offset)                  => ipcRenderer.invoke("fb-groups-get-profile-history", { profileId, limit, offset }),
  fbGroupsGetProfileActivity:      ()                                          => ipcRenderer.invoke("fb-groups-get-profile-activity"),
  fbGroupsSchedulerStart:          ()                                          => ipcRenderer.invoke("fb-groups-scheduler-start"),
  fbGroupsSchedulerStop:           ()                                          => ipcRenderer.invoke("fb-groups-scheduler-stop"),
  fbGroupsGetAiPrompts:            ()                                          => ipcRenderer.invoke("fb-groups-get-ai-prompts"),
  fbGroupsGetConnectedAiProviders: ()                                          => ipcRenderer.invoke("fb-groups-get-connected-ai-providers"),
  fbGroupsSaveAiPrompt:            (prompt)                                    => ipcRenderer.invoke("fb-groups-save-ai-prompt", prompt),
  fbGroupsDeleteAiPrompt:          (promptId)                                  => ipcRenderer.invoke("fb-groups-delete-ai-prompt", promptId),
  onFbGroupsLiveLog:               (cb) => ipcRenderer.on("fb-groups-live-log",    (_, d) => cb(d)),
  onFbGroupsViralAlert:            (cb) => ipcRenderer.on("fb-groups-viral-alert",          (_, d) => cb(d)),
  onFbGroupsPostSent:              (cb) => ipcRenderer.on("fb-groups-post-sent",             (_, d) => cb(d)),
  onFbGroupsWorkflowCompleted:     (cb) => ipcRenderer.on("fb-groups-workflow-completed",    (_, d) => cb(d)),
  onFbGroupsProfileActivity:       (cb) => ipcRenderer.on("fb-groups-profile-activity",      (_, d) => cb(d)),
  onFbGroupsGroupScanned:          (cb) => ipcRenderer.on("fb-groups-group-scanned",         (_, d) => cb(d)),
  onFbGroupsProfileScanned:        (cb) => ipcRenderer.on("fb-groups-profile-scanned",       (_, d) => cb(d)),
  onFbGroupsProfileFlagged:        (cb) => ipcRenderer.on("fb-groups-profile-flagged",       (_, d) => cb(d)),
  onFbGroupsMonitorsExpired:       (cb) => ipcRenderer.on("fb-groups-monitors-expired",      (_, d) => cb(d)),
  fbGroupsMarkProfileWorking:      (profileId) => ipcRenderer.invoke("fb-groups-mark-profile-working", profileId),
  fbGroupsResetProfileStats:       (profileId) => ipcRenderer.invoke("fb-groups-reset-profile-stats", profileId),
});
