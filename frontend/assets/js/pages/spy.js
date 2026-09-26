// spy.js (optimized for dynamically loaded spy.html)
// Assumes jQuery, tippy.js, and your window.electronAPI helpers are available.

(() => {
  const NS = ".spy"; // jQuery namespace to prevent duplicate listeners
  const POLL_MS = 10000; // Increased from 5000ms to reduce CPU usage
  const RENDER_THROTTLE_MS = 300; // Increased throttling for better performance
  const LIBRARY_PAGE_SIZE = 48; // Reduced from 16 to improve rendering speed
  const MAX_CACHE_SIZE = 500; // Limit cache size to prevent memory leaks

  // ---- State ----
  let isGenerating = false;
  let isAutoRestarting = false; // True during auto-restart/no-posts-restart cycle to protect preview
  let screenshotFailCount = 0; // Consecutive screenshot failures (closes preview after 5)
  const MAX_SCREENSHOT_FAILS = 5;
  let openProfile = null; // { platform, id } or null
  let generatedPostsCount = 0; // Track number of posts generated (after filters)
  let rawPostsCount = 0; // Track raw posts count (before filters) for no-posts timeout
  let autoRestartIntervalId = null; // Auto-restart every 10 minutes
  let previewIntervalId = null; // Live preview screenshot interval
  let noPostsTimeoutId = null; // Auto-restart if no posts received
  let lastPostCount = 0; // Track last known post count
  const AUTO_RESTART_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const PREVIEW_INTERVAL_MS = 1000; // 1 second for screenshot updates
  const NO_POSTS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes - restart if no new posts

  let lastProfilesHash = ""; // coarse hash of spyProfiles keys
  const profileRowCache = new Map(); // profileID -> row hash
  let currentSpyCategoryId = null; // Category ID for current spy session (auto-assign to posts)

  // For post grids (temp/live and library)
  let currentLibraryPage = 1;
  let lastSpyPostsIdsHash = ""; // hash of ids only (temp list)
  let lastLibraryPageSig = ""; // "page:totalPages:filter:sort:search"
  const cardCacheTemp = new Map(); // postId -> card hash
  const cardCacheLib = new Map(); // postId -> card hash

  // Intervals + visibility + caching
  if (!window.intervals) window.intervals = [];
  let pollId = null;
  let isVisible = !document.hidden;
  let cachedData = null;
  let lastDataFetch = 0;
  const DATA_CACHE_TTL = 3000; // Cache data for 3 seconds

  // ---- Utils ----
  const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));

  const throttle = (fn, ms) => {
    let last = 0,
      t = null,
      lastArgs = null;
    return function (...args) {
      const now = Date.now();
      lastArgs = args;
      const run = () => {
        last = now;
        t = null;
        fn.apply(this, lastArgs);
        lastArgs = null;
      };
      if (now - last >= ms) run();
      else if (!t) t = setTimeout(run, ms - (now - last));
    };
  };

  const hash = (obj) => {
    try {
      const s = typeof obj === "string" ? obj : JSON.stringify(obj);
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (h << 5) - h + s.charCodeAt(i);
        h |= 0;
      }
      return h.toString(36);
    } catch {
      return String(Math.random());
    }
  };

  const ucfirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  const timeAgoSafe = (ts) => {
    if (typeof window.timeAgo === "function") return window.timeAgo(ts);
    const diff = (Date.now() - Number(ts)) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const formatReadableDate = (iso) => {
    if (typeof window.formatReadableDate === "function")
      return window.formatReadableDate(iso);
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso || "";
    }
  };

  const flagImg = (country) =>
    country ? `https://flagsapi.com/${country}/flat/24.png` : "";

  const imgSrc = (path, local = false) =>
    local ? `${window.localPath}/Images/${path}` : path;

  const formatNumber = (n) =>
    typeof window.formatNumber === "function"
      ? window.formatNumber(n)
      : (n ?? 0);

  // Platform icon SVGs for consistent styling
  const getPlatformIcon = (platform, size = 20) => {
    const icons = {
      facebook: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#1877F2"><path d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z"/></svg>`,
      pinterest: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#E60023"><path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.406.042-3.442.218-.936 1.407-5.965 1.407-5.965s-.359-.719-.359-1.781c0-1.669.967-2.914 2.171-2.914 1.024 0 1.518.769 1.518 1.69 0 1.03-.655 2.569-.994 3.995-.283 1.195.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.208 0 1.031.397 2.137.893 2.739a.36.36 0 0 1 .083.344c-.091.379-.293 1.194-.333 1.361-.053.218-.173.265-.4.16-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.608 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>`,
      tiktok: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#000000"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/></svg>`,
      instagram: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="url(#instagram-gradient)"><defs><linearGradient id="instagram-gradient" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#FFDC80"/><stop offset="25%" style="stop-color:#F77737"/><stop offset="50%" style="stop-color:#E1306C"/><stop offset="75%" style="stop-color:#C13584"/><stop offset="100%" style="stop-color:#833AB4"/></linearGradient></defs><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`,
    };
    return (
      icons[platform] ||
      `<img src="assets/images/icons/${platform}-colored.png" width="${size}">`
    );
  };

  // Cache management for data fetching
  // Individual key caching system
  const keyCache = {};
  const getCachedKey = async (key, forceRefresh = false) => {
    const now = Date.now();
    if (
      forceRefresh ||
      !keyCache[key] ||
      now - keyCache[key].lastFetch > DATA_CACHE_TTL
    ) {
      keyCache[key] = {
        data: await window.electronAPI.readKey(key),
        lastFetch: now,
      };
    }
    return keyCache[key].data;
  };

  // Clear specific cache key
  const clearCacheKey = (key) => {
    if (keyCache[key]) {
      keyCache[key] = null;
      delete keyCache[key];
    }
  };

  // Clear multiple cache keys at once
  const clearCacheKeys = (...keys) => {
    keys.forEach((key) => clearCacheKey(key));
  };

  // Cache size management to prevent memory leaks
  const manageCacheSize = (cache, maxSize = MAX_CACHE_SIZE) => {
    if (cache.size > maxSize) {
      const entries = Array.from(cache.entries());
      entries
        .slice(0, cache.size - maxSize)
        .forEach(([key]) => cache.delete(key));
    }
  };

  // Auto-restart functions for spy generation (every 10 minutes)
  const startAutoRestartInterval = () => {
    // Clear any existing interval first
    stopAutoRestartInterval();

    console.log("[Spy] Starting auto-restart interval (every 10 minutes)");
    autoRestartIntervalId = setInterval(async () => {
      if (!isGenerating || !openProfile) {
        console.log(
          "[Spy] Auto-restart skipped - not generating or no profile",
        );
        return;
      }

      // Skip auto-restart for pages mode to preserve progress
      if (openProfile.spyMode === "pages") {
        console.log(
          "[Spy] Auto-restart skipped - pages mode preserves progress",
        );
        return;
      }

      console.log("[Spy] Auto-restart triggered");
      const { platform, id } = openProfile;
      const $stopBtn = $(".stopresetgeneration");

      // Mark auto-restarting so preview and onSpyStopped don't kill state
      isAutoRestarting = true;

      // Stop generation (don't stop preview - it will survive the restart)
      isGenerating = false;
      window.electronAPI.stopSpy(platform, id, "auto-restart-10min");
      $stopBtn
        
        .attr("title", "Start generation")
        .html(`<i class="material-icons">play_circle</i>`);
      updateGenerationState();

      // Wait 2 seconds then restart (using restartSpy to preserve posts)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Restart generation (preserves existing posts)
      isGenerating = true;
      isAutoRestarting = false;
      window.electronAPI.restartSpy(platform, id);
      $stopBtn
        
        .attr("title", "Stop generation")
        .html(`<i class="material-icons">stop_circle</i>`);
      updateGenerationState();

      console.log("[Spy] Auto-restart completed (posts preserved)");
    }, AUTO_RESTART_INTERVAL_MS);

    window.intervals.push(autoRestartIntervalId);
  };

  const stopAutoRestartInterval = () => {
    if (autoRestartIntervalId) {
      console.log("[Spy] Stopping auto-restart interval");
      clearInterval(autoRestartIntervalId);
      autoRestartIntervalId = null;
    }
  };

  // Browser preview functions
  const startPreviewInterval = async () => {
    if (!openProfile) return;

    const $modal = $("#browser-preview-modal");
    const $image = $("#browser-preview-image");
    const $content = $(".browser-preview-content");

    // Show modal and loading state
    $modal.fadeIn(200);
    $content.removeClass("loaded");
    screenshotFailCount = 0;

    const { id } = openProfile;

    // Get the spy browser's debugging port, retry up to 5 times (handles restart windows)
    let browserInfo = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      browserInfo = await window.electronAPI.getSpyBrowserInfo(id);
      if (browserInfo.success) break;
      console.log(`[Spy] Browser info attempt ${attempt + 1}/5 failed, retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!browserInfo || !browserInfo.success) {
      console.error("[Spy] Failed to get browser info after retries:", browserInfo?.error);
      showAlert("error", "Failed to connect to browser preview");
      $modal.fadeOut(200);
      return;
    }

    const debuggingPort = browserInfo.port;
    console.log(
      `[Spy] Starting preview for profile ${id} on port ${debuggingPort}`,
    );

    // Capture initial screenshot
    await captureScreenshot(id, debuggingPort, $image, $content);

    // Start interval for live updates
    previewIntervalId = setInterval(async () => {
      // Stop preview if spy is no longer active (but tolerate auto-restart windows)
      if ((!isGenerating && !isAutoRestarting) || !openProfile || openProfile.id !== id) {
        console.log("[Spy] Preview stopping - spy session ended");
        stopPreviewInterval();
        return;
      }
      await captureScreenshot(id, debuggingPort, $image, $content);
    }, PREVIEW_INTERVAL_MS);
  };

  const captureScreenshot = async (profileId, port, $image, $content) => {
    try {
      const screenshot = await window.electronAPI.getBrowserScreenshot(
        profileId,
        port,
      );
      if (screenshot) {
        $image.attr("src", `data:image/png;base64,${screenshot}`);
        $content.addClass("loaded");
        screenshotFailCount = 0; // Reset on success
      } else {
        screenshotFailCount++;
        console.log(`[Spy] No screenshot returned (${screenshotFailCount}/${MAX_SCREENSHOT_FAILS})`);
        if (screenshotFailCount >= MAX_SCREENSHOT_FAILS) {
          console.log("[Spy] Too many screenshot failures, stopping preview");
          stopPreviewInterval();
        }
      }
    } catch (error) {
      screenshotFailCount++;
      console.log(`[Spy] Screenshot capture failed (${screenshotFailCount}/${MAX_SCREENSHOT_FAILS})`);
      if (screenshotFailCount >= MAX_SCREENSHOT_FAILS) {
        console.log("[Spy] Too many screenshot failures, stopping preview");
        stopPreviewInterval();
      }
    }
  };

  const stopPreviewInterval = () => {
    if (previewIntervalId) {
      console.log("[Spy] Stopping preview interval");
      clearInterval(previewIntervalId);
      previewIntervalId = null;
    }
    $("#browser-preview-modal").fadeOut(200);
  };

  // No-posts timeout - auto restart if no new posts received within 5 minutes
  // Skip for pages mode - backend handles no-posts by cycling to next page
  const resetNoPostsTimeout = () => {
    if (noPostsTimeoutId) {
      clearTimeout(noPostsTimeoutId);
    }

    if (!isGenerating || !openProfile) return;

    // Skip no-posts timeout for pages mode - backend handles it by cycling pages
    if (openProfile.spyMode === "pages") {
      return;
    }

    noPostsTimeoutId = setTimeout(async () => {
      if (!isGenerating || !openProfile) return;

      // Double-check we're not in pages mode
      if (openProfile.spyMode === "pages") {
        return;
      }

      console.log(
        "[Spy] No new posts received in 5 minutes, auto-restarting...",
      );

      const { platform, id } = openProfile;
      const $stopBtn = $(".stopresetgeneration");

      // Mark auto-restarting so preview and onSpyStopped don't kill state
      isAutoRestarting = true;

      // Stop generation (don't stop preview - it will survive the restart)
      isGenerating = false;
      window.electronAPI.stopSpy(platform, id, "no-posts-timeout-5min");
      $stopBtn
        
        .attr("title", "Start generation")
        .html(`<i class="material-icons">play_circle</i>`);
      updateGenerationState();

      // Wait 2 seconds then restart (using restartSpy to preserve posts)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Restart generation (preserves existing posts)
      isGenerating = true;
      isAutoRestarting = false;
      lastPostCount = generatedPostsCount; // Reset post count tracking
      window.electronAPI.restartSpy(platform, id);
      $stopBtn
        
        .attr("title", "Stop generation")
        .html(`<i class="material-icons">stop_circle</i>`);
      updateGenerationState();

      // Reset the timeout for next check
      resetNoPostsTimeout();

      console.log(
        "[Spy] Auto-restart completed (no posts timeout, posts preserved)",
      );
    }, NO_POSTS_TIMEOUT_MS);
  };

  const stopNoPostsTimeout = () => {
    if (noPostsTimeoutId) {
      clearTimeout(noPostsTimeoutId);
      noPostsTimeoutId = null;
    }
  };

  // Start the no-posts timeout monitoring
  const startNoPostsTimeout = () => {
    lastPostReceivedTime = Date.now();
    resetNoPostsTimeout();
  };

  // Called when new posts are received - resets the no-posts timeout
  const handleNewPostReceived = () => {
    lastPostReceivedTime = Date.now();
    resetNoPostsTimeout();
  };

  // Update delete button state based on checkbox selection
  const updateDeleteButtonState = () => {
    const checkedCount = $(".post-checkbox:checked").length;
    const deleteBtn = $("#delete-selected");

    if (checkedCount > 0) {
      deleteBtn.prop("disabled", false);
      deleteBtn.find("span").text(`Delete Selected (${checkedCount})`);
    } else {
      deleteBtn.prop("disabled", true);
      deleteBtn.find("span").text("Delete Selected");
    }
  };

  // Update generation state display with post count
  const updateGenerationState = () => {
    const $stateDisplay = $(".libraryGenerationState");
    if (isGenerating) {
      $stateDisplay.html(`
                <div class="spinner-border me-2"></div>
                <span>Generating posts (${generatedPostsCount})</span>
            `);
    } else {
      $stateDisplay.html("Stopped");
    }
    
    // Sync post count with global spyManager
    if (openProfile && window.spyManager) {
      window.spyManager.updatePostCount(openProfile.id, generatedPostsCount, rawPostsCount);
    }
  };

  // Get current filter values from the UI
  const getCurrentFilters = () => {
    return {
      minShares: parseInt($("#min-shares").val()) || 0,
      minLikes: parseInt($("#min-likes").val()) || 0,
      minComments: parseInt($("#min-comments").val()) || 0,
      minVirality: parseFloat($("#min-virality").val()) || 0,
      scrollSpeed: parseInt($("#active-scroll-speed").text()) || 3,
      spyCategoryId: currentSpyCategoryId,
    };
  };

  // Update temp posts bulk action buttons state
  const updateTempBulkActionsState = () => {
    const checkedCount = $(".temp-post-checkbox:checked").length;
    const $addSelectedBtn = $("#add-selected-to-library");
    const $hideSelectedBtn = $("#hide-selected-posts");

    if (checkedCount > 0) {
      $addSelectedBtn.prop("disabled", false);
      $addSelectedBtn.find("span").text(`Add Selected (${checkedCount})`);
      $hideSelectedBtn.prop("disabled", false);
      $hideSelectedBtn.find("span").text(`Hide Selected (${checkedCount})`);
    } else {
      $addSelectedBtn.prop("disabled", true);
      $addSelectedBtn.find("span").text("Add Selected");
      $hideSelectedBtn.prop("disabled", true);
      $hideSelectedBtn.find("span").text("Hide Selected");
    }
  };

  // Update followed pages bulk action buttons state
  const updateFollowedPagesBulkActionsState = () => {
    const checkedCount = $(".followed-page-checkbox:checked").length;
    const $bulkActions = $("#followed-pages-bulk-actions");
    const $deleteBtn = $("#bulk-delete-pages");
    const $categoryBtn = $("#bulk-change-category-pages");
    const $countLabel = $("#followed-pages-selected-count");

    if (checkedCount > 0) {
      $bulkActions.css("display", "").addClass("d-flex");
      $deleteBtn.prop("disabled", false);
      $categoryBtn.prop("disabled", false);
      const selectedText = window.I18n?.t("spy.followed_section.selected_count", { count: checkedCount }) || `${checkedCount} selected`;
      $countLabel.text(selectedText);
    } else {
      $bulkActions.css("display", "none").removeClass("d-flex");
      $deleteBtn.prop("disabled", true);
      $categoryBtn.prop("disabled", true);
      $countLabel.text("");
    }
  };

  // ---- Spy Session Restore ----
  // Check if there's a minimized spy session to restore when returning to spy page
  const checkAndRestoreSpySession = async () => {
    // Check if there's a pending restore from floating indicator click
    if (window.spyRestoreSession) {
      const session = window.spyRestoreSession;
      window.spyRestoreSession = null;
      
      console.log('[Spy] Restoring session:', session.profileId);
      
      // Restore local state from session
      openProfile = {
        platform: session.platform,
        id: session.profileId,
        spyMode: session.spyMode
      };
      isGenerating = session.isGenerating;
      generatedPostsCount = session.postCount;
      rawPostsCount = session.rawPostCount;
      currentSpyCategoryId = session.categoryId;
      
      // Show the library manager
      $(".library-manager").fadeIn();
      
      // Update UI state
      updateGenerationState();
      
      // Show category indicator if applicable
      if (currentSpyCategoryId) {
        const categories = await loadCategories();
        const category = categories.find(c => c.id === currentSpyCategoryId);
        if (category) {
          const iconHtml = category.image 
            ? `<img src="${category.image}" width="12" height="12" style="border-radius: 2px; margin-right: 4px;">`
            : '';
          $('#spy-category-name').html(`${iconHtml}${category.name}`);
          $('#spy-category-indicator').removeClass('d-none').addClass('d-flex');
        }
      }
      
      // Update stop/start button state
      if (isGenerating) {
        $(".stopresetgeneration")
          
          .attr("title", "Stop generation")
          .html(`<i class="material-icons">stop_circle</i>`);
      } else {
        $(".stopresetgeneration")
          
          .attr("title", "Start generation")
          .html(`<i class="material-icons">play_circle</i>`);
      }
      
      // Restore pages progress UI if in pages mode
      if (session.spyMode === 'pages' && session.currentPage && session.totalPages) {
        const $progressContainer = $(".spy-pages-progress");
        $progressContainer.removeClass("d-none").addClass("d-flex");
        $progressContainer.find(".current-page").text(session.currentPage);
        $progressContainer.find(".total-pages").text(session.totalPages);
        
        const progressPercent = (session.currentPage / session.totalPages) * 100;
        $progressContainer.find(".progress-bar").css("width", progressPercent + "%");
        
        // Extract and show page name from URL
        if (session.currentPageUrl) {
          let pageName = '';
          try {
            const url = new URL(session.currentPageUrl);
            pageName = url.pathname.replace(/^\//, '').replace(/\/$/, '') || url.hostname;
            if (pageName === 'profile.php' && url.searchParams.get('id')) {
              pageName = 'ID: ' + url.searchParams.get('id');
            }
          } catch (e) {
            pageName = session.currentPageUrl;
          }
          $progressContainer.find(".current-page-name").text(pageName).attr("title", session.currentPageUrl);
        }
      }
      
      // Start polling to render posts
      startPoll();
      
      // Restart frontend timers that were stopped on partial cleanup
      if (isGenerating) {
        if (session.spyMode !== 'pages') {
          startAutoRestartInterval();
        }
        startNoPostsTimeout();
      }
      
      // Clear minimized state in spyManager
      window.spyManager.isMinimized = false;
      window.spyManager._updateFloatingIndicator();
      
      // Render existing posts
      setTimeout(() => {
        renderTempPosts();
      }, 100);
      
      return;
    }
    
    // Check if spyManager has active sessions that should be shown
    if (window.spyManager && window.spyManager.hasActiveSessions()) {
      const session = window.spyManager.sessions.values().next().value;
      
      if (session && window.spyManager.isMinimized) {
        // Session is minimized - keep it minimized, don't auto-restore
        // User will click maximize on floating indicator when ready
        console.log('[Spy] Found minimized session, keeping minimized');
        
        // Just restore the local state without showing UI
        openProfile = {
          platform: session.platform,
          id: session.profileId,
          spyMode: session.spyMode
        };
        // If session completed while minimized, reflect that
        isGenerating = session.isCompleted ? false : session.isGenerating;
        generatedPostsCount = session.postCount;
        rawPostsCount = session.rawPostCount;
        currentSpyCategoryId = session.categoryId;
        
        // Update session switcher UI (if visible)
        updateSessionSwitcherUI();
        
        // Keep library manager hidden - don't call fadeIn
        // Don't clear isMinimized - keep it minimized
        return;
      }
    }
  };
  
  // Global function to restore spy session (called from app.js when already on spy page)
  window.restoreSpySession = async (session) => {
    if (!session) return;
    
    console.log('[Spy] Restoring session via global function:', session.profileId);
    
    // Restore local state from session
    openProfile = {
      platform: session.platform,
      id: session.profileId,
      spyMode: session.spyMode
    };
    isGenerating = session.isGenerating;
    generatedPostsCount = session.postCount;
    rawPostsCount = session.rawPostCount;
    currentSpyCategoryId = session.categoryId;
    
    // Show the library manager
    $(".library-manager").fadeIn();
    
    // Update UI state
    updateGenerationState();
    
    // Show category indicator if applicable
    if (currentSpyCategoryId) {
      const categories = await loadCategories();
      const category = categories.find(c => c.id === currentSpyCategoryId);
      if (category) {
        const iconHtml = category.image 
          ? `<img src="${category.image}" width="12" height="12" style="border-radius: 2px; margin-right: 4px;">`
          : '';
        $('#spy-category-name').html(`${iconHtml}${category.name}`);
        $('#spy-category-indicator').removeClass('d-none').addClass('d-flex');
      }
    }
    
    // Update stop/start button state
    if (isGenerating) {
      $(".stopresetgeneration")
        
        .attr("title", "Stop generation")
        .html(`<i class="material-icons">stop_circle</i>`);
    } else {
      $(".stopresetgeneration")
        
        .attr("title", "Start generation")
        .html(`<i class="material-icons">play_circle</i>`);
    }
    
    // Restore pages progress UI if in pages mode
    if (session.spyMode === 'pages' && session.currentPage && session.totalPages) {
      const $progressContainer = $(".spy-pages-progress");
      $progressContainer.removeClass("d-none").addClass("d-flex");
      $progressContainer.find(".current-page").text(session.currentPage);
      $progressContainer.find(".total-pages").text(session.totalPages);
      
      const progressPercent = (session.currentPage / session.totalPages) * 100;
      $progressContainer.find(".progress-bar").css("width", progressPercent + "%");
      
      // Extract and show page name from URL
      if (session.currentPageUrl) {
        let pageName = '';
        try {
          const url = new URL(session.currentPageUrl);
          pageName = url.pathname.replace(/^\//, '').replace(/\/$/, '') || url.hostname;
          if (pageName === 'profile.php' && url.searchParams.get('id')) {
            pageName = 'ID: ' + url.searchParams.get('id');
          }
        } catch (e) {
          pageName = session.currentPageUrl;
        }
        $progressContainer.find(".current-page-name").text(pageName).attr("title", session.currentPageUrl);
      }
    }
    
    // Start polling to render posts
    startPoll();
    
    // Restart frontend timers that were stopped on partial cleanup
    if (isGenerating) {
      if (session.spyMode !== 'pages') {
        startAutoRestartInterval();
      }
      startNoPostsTimeout();
    }
    
    // Clear minimized state in spyManager
    window.spyManager.isMinimized = false;
    window.spyManager._updateFloatingIndicator();
    
    // Render existing posts
    setTimeout(() => {
      renderTempPosts();
    }, 100);
  };
  
  // Expose checkAndRestoreSpySession for fallback
  window.checkAndRestoreSpySessionNow = checkAndRestoreSpySession;

  // ---- Multi-Session Switcher ----
  
  // Initialize the session switcher
  const initSessionSwitcher = async () => {
    if (!window.spyManager) return;
    
    // Always show session switcher when spy is active (to display current profile)
    updateSessionSwitcherUI();
  };
  
  // Update session switcher UI with current sessions
  const updateSessionSwitcherUI = async () => {
    const $switcher = $('#spySessionSwitcher');
    const $list = $switcher.find('.session-list');
    const profiles = await getCachedKey('spyProfiles') || {};
    const canMultiple = window.spyManager && await window.spyManager.canRunMultipleSessions();
    const hasMultiple = window.spyManager && window.spyManager.sessions.size > 1;
    
    // Always show switcher to display current profile name
    $switcher.removeClass('d-none').addClass('d-flex');
    
    // Update current session name
    if (openProfile) {
      const currentProfileName = profiles[openProfile.id]?.name || 'Unknown Profile';
      $switcher.find('.current-session-name').text(currentProfileName);
      
      // Show/hide dropdown arrow based on whether multiple sessions are possible
      if (hasMultiple) {
        $switcher.find('.dropdown-arrow').show();
      } else {
        $switcher.find('.dropdown-arrow').hide();
      }
    }
    
    // Only populate dropdown if there are multiple sessions
    if (!hasMultiple) {
      $list.empty();
      return;
    }
    
    $list.empty();
    
    window.spyManager.sessions.forEach((session, profileId) => {
      const profileName = profiles[profileId]?.name || 'Unknown Profile';
      const isActive = openProfile && openProfile.id === profileId;
      const runTime = window.spyManager._formatRunTime(Date.now() - session.startedAt);
      const platformIcon = window.spyManager._getPlatformIcon(session.platform);
      
      $list.append(`
        <div class="session-item ${isActive ? 'active' : ''}" data-profile-id="${profileId}">
          <div class="session-icon">${platformIcon}</div>
          <div class="session-details">
            <div class="session-name">${profileName}</div>
            <div class="session-meta">${session.spyMode === 'pages' ? 'Pages' : 'Feed'} • ${runTime}</div>
          </div>
          <div class="session-posts">${session.postCount}</div>
        </div>
      `);
    });
  };
  
  // Session switcher event handlers
  $(document).on('click' + NS, '.session-switcher-btn', function(e) {
    e.stopPropagation();
    $('#spySessionSwitcher').toggleClass('open');
  });
  
  // Close switcher when clicking outside
  $(document).on('click' + NS, function() {
    $('#spySessionSwitcher').removeClass('open');
  });
  
  // Switch to a different session
  $(document).on('click' + NS, '.session-switcher-dropdown .session-item', async function(e) {
    e.stopPropagation();
    
    const profileId = $(this).data('profile-id');
    if (!profileId || (openProfile && openProfile.id === profileId)) {
      $('#spySessionSwitcher').removeClass('open');
      return;
    }
    
    const session = window.spyManager.sessions.get(profileId);
    if (!session) return;
    
    // Switch to the selected session
    openProfile = {
      platform: session.platform,
      id: profileId,
      spyMode: session.spyMode
    };
    isGenerating = session.isGenerating;
    generatedPostsCount = session.postCount;
    rawPostsCount = session.rawPostCount;
    currentSpyCategoryId = session.categoryId;
    
    // Update UI
    updateGenerationState();
    updateSessionSwitcherUI();
    
    if (isGenerating) {
      $(".stopresetgeneration")
        
        .attr("title", "Stop generation")
        .html(`<i class="material-icons">stop_circle</i>`);
    } else {
      $(".stopresetgeneration")
        
        .attr("title", "Start generation")
        .html(`<i class="material-icons">play_circle</i>`);
    }
    
    // Re-render posts for this session
    lastSpyPostsIdsHash = '';
    renderTempPosts();
    
    $('#spySessionSwitcher').removeClass('open');
    
    showAlert('info', 'Switched to session');
  });

  // ---- Banned Pages Management ----

  // Check if a page is banned
  const isBannedPage = async (pageUrl) => {
    if (!pageUrl) return false;
    const bannedPages = await getCachedKey("bannedPages");
    return bannedPages && bannedPages[pageUrl];
  };

  // Ban a page
  const banPage = async (pageData) => {
    if (!pageData || !pageData.url) return false;
    try {
      const bannedPages = (await getCachedKey("bannedPages")) || {};

      // Download profile image locally if available
      let localImagePath = pageData.image;
      if (pageData.image && pageData.image.startsWith("http")) {
        try {
          const downloadResult =
            await window.electronAPI.downloadFileToUserData(pageData.image);
          if (downloadResult.success) {
            localImagePath = downloadResult.filePath;
          }
        } catch (downloadError) {
          console.warn(
            "Failed to download profile image for banned page:",
            downloadError,
          );
          // Continue with original image URL as fallback
        }
      }

      bannedPages[pageData.url] = {
        name: pageData.name,
        url: pageData.url,
        image: localImagePath,
        platform: pageData.platform || "unknown",
        bannedAt: new Date().toISOString(),
      };
      await window.electronAPI.updateData("bannedPages", bannedPages);

      // Clear banned pages cache to force refresh
      clearCacheKey("bannedPages");

      return true;
    } catch (error) {
      console.error("Error banning page:", error);
      return false;
    }
  };

  // Unban a page
  const unbanPage = async (pageUrl) => {
    if (!pageUrl) return false;
    try {
      const bannedPages = (await getCachedKey("bannedPages")) || {};
      delete bannedPages[pageUrl];
      await window.electronAPI.updateData("bannedPages", bannedPages);
      return true;
    } catch (error) {
      console.error("Error unbanning page:", error);
      return false;
    }
  };

  // Get all banned pages
  const getBannedPages = async () => {
    return (await getCachedKey("bannedPages")) || {};
  };

  // ---- Followed Pages Management ----

  // Get all followed pages
  const getFollowedPages = async () => {
    return (await getCachedKey("followedPages")) || {};
  };

  // Add a page to followed pages
  const addFollowedPage = async (pageData) => {
    if (!pageData || !pageData.url) return false;
    try {
      const followedPages = (await getCachedKey("followedPages")) || {};

      // Download profile image locally if available
      let localImagePath = pageData.image;
      if (pageData.image && pageData.image.startsWith("http")) {
        try {
          const downloadResult =
            await window.electronAPI.downloadFileToUserData(pageData.image);
          if (downloadResult.success) {
            localImagePath = downloadResult.filePath;
          }
        } catch (downloadError) {
          console.warn(
            "Failed to download profile image for followed page:",
            downloadError,
          );
        }
      }

      followedPages[pageData.url] = {
        name: pageData.name || extractPageNameFromUrl(pageData.url),
        url: pageData.url,
        image: localImagePath,
        platform: pageData.platform || "facebook",
        categoryId: pageData.categoryId || null,
        addedAt: new Date().toISOString(),
      };
      await window.electronAPI.updateData("followedPages", followedPages);

      // Clear cache to force refresh
      clearCacheKey("followedPages");

      return true;
    } catch (error) {
      console.error("Error adding followed page:", error);
      return false;
    }
  };

  // Remove a page from followed pages
  const removeFollowedPage = async (pageUrl) => {
    if (!pageUrl) return false;
    try {
      const followedPages = (await getCachedKey("followedPages")) || {};
      delete followedPages[pageUrl];
      await window.electronAPI.updateData("followedPages", followedPages);
      clearCacheKey("followedPages");
      return true;
    } catch (error) {
      console.error("Error removing followed page:", error);
      return false;
    }
  };

  // Extract page name from Facebook URL
  const extractPageNameFromUrl = (url) => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      // Remove leading/trailing slashes and get the first path segment
      const segments = pathname.split("/").filter((s) => s);

      // Handle profile.php?id= URLs
      if (segments.length > 0 && segments[0] === "profile.php") {
        const id = urlObj.searchParams.get("id");
        if (id) {
          return `Page ${id}`;
        }
      }

      if (segments.length > 0) {
        // Handle different URL formats
        if (segments[0] === "pages" && segments.length > 1) {
          return decodeURIComponent(segments[1]).replace(/-/g, " ");
        }
        return decodeURIComponent(segments[0]).replace(/-/g, " ");
      }
      return "Unknown Page";
    } catch {
      return "Unknown Page";
    }
  };

  // Normalize Facebook page URL
  const normalizePageUrl = (url) => {
    try {
      let cleanUrl = url.trim();

      // Add https:// if missing
      if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
        cleanUrl = "https://" + cleanUrl;
      }

      const urlObj = new URL(cleanUrl);

      // Ensure it's a Facebook URL
      if (!urlObj.hostname.includes("facebook.com")) {
        return null;
      }

      // Get the page path
      const pathname = urlObj.pathname;
      const segments = pathname.split("/").filter((s) => s);

      if (segments.length === 0) {
        return null;
      }

      // Handle profile.php URLs with ?id= parameter (numeric page IDs)
      if (segments[0] === "profile.php" && urlObj.searchParams.get("id")) {
        return `https://www.facebook.com/profile.php?id=${urlObj.searchParams.get("id")}`;
      }

      // Build normalized URL
      let pagePath = segments[0];
      if (segments[0] === "pages" && segments.length > 1) {
        pagePath = segments[1];
      }

      return `https://www.facebook.com/${pagePath}`;
    } catch {
      return null;
    }
  };

  // Render followed pages table
  const renderFollowedPages = throttle(async () => {
    const followedPages = (await getCachedKey("followedPages")) || {};
    const pages = Object.values(followedPages);
    const $table = $("#followedPages");
    const $tbody = $("#followedPages tbody");
    const $noPagesMsg = $("#no-followed-pages");
    const $countBadge = $("#followed-count");

    // Update count badge
    $countBadge.text(
      `${pages.length} followed page${pages.length !== 1 ? "s" : ""}`,
    );

    if (pages.length === 0) {
      $table.hide();
      $noPagesMsg.show();
      $tbody.empty();
      return;
    } else {
      $table.show();
      $noPagesMsg.hide();
    }

    // Preserve checked state across re-renders
    const checkedUrls = new Set();
    $(".followed-page-checkbox:checked").each(function () {
      checkedUrls.add($(this).attr("data-page-url"));
    });

    // Sort by added date (newest first)
    const sortedPages = pages.sort(
      (a, b) => new Date(b.addedAt) - new Date(a.addedAt),
    );

    // Build table rows
    const rows = sortedPages.map((page) => followedPageRow(page)).join("");
    $tbody.html(rows);

    // Restore checked state
    if (checkedUrls.size > 0) {
      $(".followed-page-checkbox").each(function () {
        if (checkedUrls.has($(this).attr("data-page-url"))) {
          $(this).prop("checked", true);
        }
      });

      // Restore select-all checkbox state
      const totalCheckboxes = $(".followed-page-checkbox").length;
      const checkedCheckboxes = $(".followed-page-checkbox:checked").length;
      const selectAllCheckbox = $("#select-all-followed-pages");

      if (checkedCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === totalCheckboxes) {
        selectAllCheckbox.prop("checked", true).prop("indeterminate", false);
      } else {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", true);
      }
      updateFollowedPagesBulkActionsState();
    }

    // Render category badges after table is built
    await renderFollowedPagesCategoryBadges();

    initTooltips();
  }, RENDER_THROTTLE_MS);

  function followedPageRow(page) {
    const platformIcon = getPlatformIcon(page.platform, 20);
    const addedDate = formatReadableDate(page.addedAt);

    // Handle profile image with fallback
    let profileImageHtml;
    if (page.image) {
      const isLocalImage = !page.image.startsWith("http");
      const imageSrc = isLocalImage ? imgSrc(page.image, true) : page.image;

      profileImageHtml = `<img class="profile"
                src="${imageSrc}"
                width="40" height="40"
                style="border-radius: 50%; object-fit: cover;"
                loading="lazy"
                onerror="this.src='assets/images/icons/${page.platform}-colored.png'; this.style.width='40px'; this.style.height='40px'; this.style.borderRadius='50%';">`;
    } else {
      profileImageHtml = `<img class="profile"
                src="assets/images/icons/${page.platform}-colored.png"
                width="40" height="40"
                style="border-radius: 50%; object-fit: cover;"
                loading="lazy">`;
    }

    return `<tr data-page-url="${page.url}" data-category-id="${page.categoryId || ""}">
            <td><input type="checkbox" class="followed-page-checkbox form-check-input" data-page-url="${page.url}" /></td>
            <td>${profileImageHtml}</td>
            <td>
                <div class="d-flex flex-column">
                    <strong>${page.name}</strong>
                    <small class="text-muted" style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${page.url}</small>
                </div>
            </td>
            <td class="page-category-cell" data-page-url="${page.url}">
                <span class="category-badge-placeholder" data-category-id="${page.categoryId || ""}"></span>
            </td>
            <td>
                <div class="d-flex align-items-center">
                    ${platformIcon}
                    <span class="ms-2">${ucfirst(page.platform)}</span>
                </div>
            </td>
            <td>${addedDate}</td>
            <td>
                <div class="d-flex gap-1">
                    <button data-role="changePageCategory" data-page-url="${page.url}" class="btn btn-secondary btn-sm flex-center" title="Change Category">
                        <div class="material-icons" style="font-size: 16px;">category</div>
                    </button>
                    <button data-role="removeFollowedPage" data-page-url="${page.url}" class="btn btn-danger flex-center">
                        <div class="material-icons">delete</div><span>Remove</span>
                    </button>
                </div>
            </td>
        </tr>`;
  }

  // Update target pages list in the filter dialog
  const updateTargetPagesSelector = async (filterCategoryId = null) => {
    const followedPages = (await getCachedKey("followedPages")) || {};
    let pages = Object.values(followedPages);
    const $container = $("#target-pages-list");
    const $noPages = $("#no-pages-to-select");

    // Filter by category if specified
    if (filterCategoryId) {
      pages = pages.filter((p) => p.categoryId === filterCategoryId);
    }

    if (pages.length === 0) {
      $noPages
        .show()
        .text(
          filterCategoryId
            ? "No pages in this category."
            : 'No followed pages yet. Add pages in the "Followed Pages" section first.',
        );
      $container.find(".target-page-item").remove();
      return;
    }

    $noPages.hide();

    // Build checkboxes for each page
    const html = pages
      .map((page) => {
        const isLocalImage = page.image && !page.image.startsWith("http");
        const imageSrc = page.image
          ? isLocalImage
            ? imgSrc(page.image, true)
            : page.image
          : `assets/images/icons/${page.platform}-colored.png`;

        return `<label class="target-page-item d-flex align-items-center gap-2 p-2 border-bottom" style="cursor: pointer;">
                <input type="checkbox" class="target-page-checkbox form-check-input" value="${page.url}" checked />
                <img src="${imageSrc}" width="32" height="32" style="border-radius: 50%; object-fit: cover;" 
                     onerror="this.src='assets/images/icons/${page.platform}-colored.png';" />
                <div class="flex-fill">
                    <div class="fw-medium">${page.name}</div>
                    <small class="text-muted">${page.url}</small>
                </div>
            </label>`;
      })
      .join("");

    $container.html(html);
  };

  // Filter posts to remove banned pages
  const filterBannedPosts = async (posts) => {
    if (!posts || posts.length === 0) return posts;
    const bannedPages = (await getCachedKey("bannedPages")) || {};
    return posts.filter((post) => {
      if (!post.page || !post.page.url) return true;
      return !bannedPages[post.page.url];
    });
  };

  // Render banned pages table
  const renderBannedPages = throttle(async () => {
    const bannedPages = (await getCachedKey("bannedPages")) || {};
    const pages = Object.values(bannedPages);
    const $table = $("#bannedPages");
    const $tbody = $("#bannedPages tbody");
    const $noPagesMsg = $("#no-banned-pages");
    const $countBadge = $("#banned-count");

    // Update count badge
    $countBadge.text(
      `${pages.length} banned page${pages.length !== 1 ? "s" : ""}`,
    );

    if (pages.length === 0) {
      $table.hide();
      $noPagesMsg.show();
      $tbody.empty();
      return;
    } else {
      $table.show();
      $noPagesMsg.hide();
    }

    // Sort by banned date (newest first)
    const sortedPages = pages.sort(
      (a, b) => new Date(b.bannedAt) - new Date(a.bannedAt),
    );

    // Build table rows
    const rows = sortedPages.map((page) => bannedPageRow(page)).join("");
    $tbody.html(rows);

    initTooltips(); // Re-init tooltips for new elements
  }, RENDER_THROTTLE_MS);

  function bannedPageRow(page) {
    const platformIcon = getPlatformIcon(page.platform, 20);
    const bannedDate = formatReadableDate(page.bannedAt);

    // Handle profile image with fallback
    let profileImageHtml;
    if (page.image) {
      // Determine if image is local or remote
      const isLocalImage = !page.image.startsWith("http");
      const imageSrc = isLocalImage ? imgSrc(page.image, true) : page.image;

      profileImageHtml = `<img class="profile"
                src="${imageSrc}"
                width="40" height="40"
                style="border-radius: 50%; object-fit: cover;"
                loading="lazy"
                onerror="this.src='assets/images/icons/${page.platform}-colored.png'; this.style.width='40px'; this.style.height='40px'; this.style.borderRadius='50%';">`;
    } else {
      // Fallback to platform icon if no image
      profileImageHtml = `<img class="profile"
                src="assets/images/icons/${page.platform}-colored.png"
                width="40" height="40"
                style="border-radius: 50%; object-fit: cover;"
                loading="lazy">`;
    }

    return `<tr data-page-url="${page.url}">
            <td>${profileImageHtml}</td>
            <td>
                <div class="d-flex align-items-center">
                    <strong>${page.name}</strong>
                </div>
            </td>
            <td>
                <div class="d-flex align-items-center">
                    ${platformIcon}
                    <span class="ms-2">${ucfirst(page.platform)}</span>
                </div>
            </td>
            <td>${bannedDate}</td>
            <td>
                <button data-role="unbanPage" data-page-url="${page.url}" class="btn btn-success flex-center">
                    <div class="material-icons">restore</div><span>Unban</span>
                </button>
            </td>
        </tr>`;
  }

  // ---- Tippy (tooltips) ----
  function initTooltips() {
    // Only init once per element—tippy auto-guards, but we namespace anyway
    // Scoped to spy-section to avoid duplicating tooltips on main sidebar
    $("#spy-section [data-tooltip]").each(function () {
      if (this._tippy) return;
      tippy(this, {
        content: $(this).attr("data-tooltip"),
        animation: "scale",
        theme: "light",
        placement: "top",
      });
    });
  }

  // ---- Profiles Table Rendering ----
  const renderProfiles = throttle(async () => {
    const spyProfiles = await getCachedKey("spyProfiles");
    const profiles = spyProfiles || {};
    const keys = Object.keys(profiles);
    const keysHash = hash(keys);
    const $table = $("#spyProfiles");
    const $tbody = $("#spyProfiles tbody");

    // If first render and empty, hide; else show
    if (keys.length === 0) {
      $table.hide();
      $tbody.empty();
      lastProfilesHash = keysHash;
      profileRowCache.clear();
      return;
    } else {
      $table.show();
    }

    // Only rebuild rows that changed; keep order newest first
    const entries = Object.entries(profiles).sort(
      (a, b) =>
        Date.parse(b[1]?.createdAt || 0) - Date.parse(a[1]?.createdAt || 0),
    );

    const seen = new Set();

    for (const [profileID, vl] of entries) {
      const rowSig = hash({
        platform: vl.platform,
        name: vl.name,
        country: vl.country,
        country_name: vl.country_name,
        createdAt: vl.createdAt,
        status: vl.status,
      });
      seen.add(profileID);

      const $row = $tbody.find(`tr[data-id="${profileID}"]`);
      if ($row.length && profileRowCache.get(profileID) === rowSig) continue;

      const rowHtml = profileRow(profileID, vl);
      if ($row.length) $row.replaceWith(rowHtml);
      else $tbody.prepend(rowHtml);

      profileRowCache.set(profileID, rowSig);
    }

    // Remove stale rows
    $tbody.find("tr[data-id]").each(function () {
      const id = $(this).attr("data-id");
      if (!seen.has(id)) {
        $(this).remove();
        profileRowCache.delete(id);
      }
    });

    lastProfilesHash = keysHash;

    // Manage cache size to prevent memory leaks
    manageCacheSize(profileRowCache);
  }, RENDER_THROTTLE_MS);

  function profileRow(profileID, vl) {
    const countryHtml = vl.country
      ? `<img class="me-2" src="${flagImg(vl.country)}"><span>${vl.country_name}</span>`
      : window.I18n?.t('spy.local') || 'Local';
    const statusOk = vl.status === "connected";

    // Translated labels
    const t = (key, fallback) => window.I18n?.t(key) || fallback;

    // Build dropdown items based on status
    let dropdownItems = "";
    if (statusOk) {
      dropdownItems = `
                <button data-role="openProfile" data-action="justopen" data-id="${profileID}" class="action-dropdown-item item-primary">
                    <i class="material-icons">open_in_browser</i>
                    <span>${t('spy.actions.open', 'Open')}</span>
                </button>
                <button data-role="startSpy" data-id="${profileID}" class="action-dropdown-item item-success">
                    <i class="material-icons">play_arrow</i>
                    <span>${t('spy.actions.start_spy', 'Start Spy')}</span>
                </button>
                <div class="action-dropdown-divider"></div>
            `;
    } else {
      dropdownItems = `
                <button data-role="openProfile" data-id="${profileID}" class="action-dropdown-item item-primary">
                    <i class="material-icons">open_in_browser</i>
                    <span>${t('spy.actions.open', 'Open')}</span>
                </button>
                <div class="action-dropdown-divider"></div>
            `;
    }
    dropdownItems += `
            <button data-role="editSpyProfile" data-id="${profileID}" class="action-dropdown-item">
                <i class="material-icons">edit</i>
                <span>${t('spy.actions.edit', 'Edit')}</span>
            </button>
            <button data-role="delete" data-id="${profileID}" class="action-dropdown-item item-danger">
                <i class="material-icons">delete</i>
                <span>${t('spy.actions.delete', 'Delete')}</span>
            </button>
        `;

    const statusText = statusOk 
      ? t('spy.status.connected', 'Connected') 
      : t('spy.status.disconnected', 'Disconnected');

    return `<tr data-id="${profileID}">
            <td>${getPlatformIcon(vl.platform, 24)}</td>
            <td>${vl.name}</td>
            <td><div class="flex-center">${countryHtml}</div></td>
            <td>${formatReadableDate(vl.createdAt)}</td>
            <td><span class="status ${statusOk ? "success" : "danger"}"></span>${statusText}</td>
            <td>
                <div class="action-dropdown">
                    <button class="action-dropdown-toggle" title="${t('spy.actions_title', 'Actions')}">
                        <i class="material-icons">more_vert</i>
                    </button>
                    <div class="action-dropdown-menu">
                        ${dropdownItems}
                    </div>
                </div>
            </td>
        </tr>`;
  }

  // ---- Category Management ----

  let categoriesCache = null;
  let flagsCache = null;
  let categoryModalResolve = null;
  let categoryModalPostsToAdd = []; // Track posts being added (single or bulk)

  const loadCategories = async (forceRefresh = false) => {
    if (!forceRefresh && categoriesCache) return categoriesCache;
    try {
      const result = await window.electronAPI.getLibraryCategories();
      categoriesCache = result.success ? result.categories : [];
      return categoriesCache;
    } catch (err) {
      console.error("[Categories] Load error:", err);
      return [];
    }
  };

  const loadFlags = async () => {
    if (flagsCache) return flagsCache;
    try {
      const result = await window.electronAPI.getCategoryFlags();
      flagsCache = result.success ? result.flags : [];
      return flagsCache;
    } catch (err) {
      console.error("[Flags] Load error:", err);
      return [];
    }
  };

  const getCategoryPostCount = async (categoryId) => {
    const postsLibrary = (await getCachedKey("postsLibrary")) || [];
    if (categoryId === "uncategorized") {
      return postsLibrary.filter((p) => !p.categoryId).length;
    }
    return postsLibrary.filter((p) => p.categoryId === categoryId).length;
  };

  const populateCategoryDropdown = async () => {
    const $dropdown = $("#filter-category");
    if (!$dropdown.length) return;

    const categories = await loadCategories(true);
    const postsLibrary = (await getCachedKey("postsLibrary")) || [];

    // Build options
    let options = '<option value="">All Categories</option>';
    options += `<option value="uncategorized">Uncategorized (${postsLibrary.filter((p) => !p.categoryId).length})</option>`;

    for (const cat of categories) {
      const count = postsLibrary.filter((p) => p.categoryId === cat.id).length;
      options += `<option value="${cat.id}">${cat.name} (${count})</option>`;
    }

    const currentVal = $dropdown.val();
    $dropdown.html(options);
    if (currentVal) $dropdown.val(currentVal);
  };

  // Populate category dropdowns for Add Page form and Spy Filter
  const populatePageCategoryDropdowns = async () => {
    const categories = await loadCategories(true);

    // Add Page category dropdown
    const $addPageDropdown = $("#add-page-category");
    if ($addPageDropdown.length) {
      let options = '<option value="">No Category</option>';
      for (const cat of categories) {
        const iconHtml = "";
        options += `<option value="${cat.id}">${iconHtml}${cat.name}</option>`;
      }
      $addPageDropdown.html(options);
    }

    // Spy category filter dropdown
    const $spyFilterDropdown = $("#spy-category-filter");
    if ($spyFilterDropdown.length) {
      let options = '<option value="">All Categories</option>';
      for (const cat of categories) {
        options += `<option value="${cat.id}">${cat.name}</option>`;
      }
      $spyFilterDropdown.html(options);
    }
  };

  // Render category badges in followed pages table
  const renderFollowedPagesCategoryBadges = async () => {
    const categories = await loadCategories();
    const $cells = $(".category-badge-placeholder");

    $cells.each(function () {
      const $cell = $(this);
      const categoryId = $cell.attr("data-category-id");

      if (!categoryId) {
        $cell.html(
          '<span class="badge bg-secondary" style="font-size: 11px;">No Category</span>',
        );
        return;
      }

      const category = categories.find((c) => c.id === categoryId);
      if (category) {
        const iconHtml = category.image
          ? `<img src="${category.image}" width="14" height="14" style="border-radius: 2px; margin-right: 4px;">`
          : "";
        $cell.html(
          `<span class="badge bg-primary d-inline-flex align-items-center" style="font-size: 11px;">${iconHtml}${category.name}</span>`,
        );
      } else {
        $cell.html(
          '<span class="badge bg-secondary" style="font-size: 11px;">No Category</span>',
        );
      }
    });
  };

  const renderCategoryList = async () => {
    const categories = await loadCategories(true);
    const $list = $("#category-list");
    const $noMsg = $("#no-categories-msg");

    if (!categories.length) {
      $list.hide();
      $noMsg.show();
      return;
    }

    $noMsg.hide();
    $list.show();

    let html = "";
    for (const cat of categories) {
      const count = await getCategoryPostCount(cat.id);
      const iconHtml = cat.image
        ? `<img src="${cat.image}" alt="${cat.name}">`
        : `<i class="material-icons">folder</i>`;

      html += `
                <div class="category-item" data-category-id="${cat.id}">
                    <div class="category-icon">${iconHtml}</div>
                    <div class="category-name">${cat.name}</div>
                    <div class="category-count">${count} post${count !== 1 ? "s" : ""}</div>
                </div>
            `;
    }

    $list.html(html);
  };

  const renderCategoryManageList = async () => {
    const categories = await loadCategories(true);
    const $list = $("#category-manage-list");
    const $noMsg = $("#no-categories-manage-msg");

    if (!categories.length) {
      $list.hide();
      $noMsg.show();
      return;
    }

    $noMsg.hide();
    $list.show();

    let html = "";
    for (const cat of categories) {
      const count = await getCategoryPostCount(cat.id);
      const iconHtml = cat.image
        ? `<img src="${cat.image}" alt="${cat.name}">`
        : `<i class="material-icons">folder</i>`;

      html += `
                <div class="category-manage-item" data-category-id="${cat.id}">
                    <div class="category-icon">${iconHtml}</div>
                    <div class="category-info">
                        <div class="category-name">${cat.name}</div>
                        <div class="category-count">${count} post${count !== 1 ? "s" : ""}</div>
                    </div>
                    <div class="category-actions">
                        <button class="edit-btn" data-action="edit" title="Edit">
                            <i class="material-icons">edit</i>
                        </button>
                        <button class="delete-btn" data-action="delete" title="Delete">
                            <i class="material-icons">delete</i>
                        </button>
                    </div>
                </div>
            `;
    }

    $list.html(html);
  };

  const renderPageCategories = async () => {
    const categories = await loadCategories(true);
    const $list = $("#page-categories-list");
    const $noMsg = $("#no-page-categories");

    if (!categories.length) {
      $list.hide();
      $noMsg.show();
      return;
    }

    $noMsg.hide();
    $list.show();

    const followedPages = (await getCachedKey("followedPages")) || {};
    const followedPagesArr = Object.values(followedPages);

    let html = "";
    for (const cat of categories) {
      const count = await getCategoryPostCount(cat.id);
      const pagesCount = followedPagesArr.filter((p) => p.categoryId === cat.id).length;
      const iconHtml = cat.image
        ? `<img src="${cat.image}" alt="${escapeHtml(cat.name)}">`
        : `<i class="material-icons">folder</i>`;

      html += `
        <div class="page-category-card" data-category-id="${cat.id}">
          <div class="page-category-card-header">
            <div class="page-category-icon">${iconHtml}</div>
            <div class="page-category-info">
              <div class="page-category-name">${escapeHtml(cat.name)}</div>
              <div class="page-category-count">${count} post${count !== 1 ? "s" : ""} · ${pagesCount} page${pagesCount !== 1 ? "s" : ""}</div>
            </div>
          </div>
          <div class="page-category-actions">
            <button class="btn btn-sm btn-outline-primary edit-page-category" data-category-id="${cat.id}" title="Edit">
              <i class="material-icons">edit</i>
            </button>
            <button class="btn btn-sm btn-outline-danger delete-page-category" data-category-id="${cat.id}" title="Delete">
              <i class="material-icons">delete</i>
            </button>
          </div>
        </div>
      `;
    }

    $list.html(html);
  };

  const renderFlagPicker = async () => {
    const flags = await loadFlags();
    const $grid = $("#flag-picker-grid");

    if (!flags.length) {
      $grid.html(
        '<p class="text-muted text-center small">No flags available</p>',
      );
      return;
    }

    let html = "";
    for (const flag of flags) {
      html += `
                <div class="flag-picker-item" data-flag-path="${flag.path}" data-flag-code="${flag.code}" title="${flag.code}">
                    <img src="${flag.path}" alt="${flag.code}">
                </div>
            `;
    }

    $grid.html(html);
  };

  const resetCategoryForm = () => {
    $("#new-category-name").val("");
    $("#new-category-image").val("");
    $("#selected-icon-preview").html(
      '<i class="material-icons default-icon">folder</i>',
    );
    $("#clear-category-image").hide();
    $(".flag-picker-item").removeClass("selected");
    // Reset create button state
    $("#create-category-btn")
      .prop("disabled", false)
      .html('<i class="material-icons">add</i> Create & Select');
  };

  const showCategoryModal = async (posts) => {
    categoryModalPostsToAdd = Array.isArray(posts) ? posts : [posts];

    const $modal = $("#category-select-modal");
    const $title = $("#category-modal-title");

    // Update modal title based on posts count
    if (categoryModalPostsToAdd.length === 1) {
      $title.text("Select Category");
    } else {
      $title.text(
        `Select Category for ${categoryModalPostsToAdd.length} Posts`,
      );
    }

    // Show the skip button for adding posts
    $(".skip-category-option").show();

    // Switch to select tab
    $(".category-tab").removeClass("active");
    $('.category-tab[data-tab="select"]').addClass("active");
    $(".category-tab-content").removeClass("active");
    $('.category-tab-content[data-content="select"]').addClass("active");

    // Reset form
    resetCategoryForm();

    // Populate data
    await renderCategoryList();
    await renderFlagPicker();

    $modal.fadeIn(200);

    return new Promise((resolve) => {
      categoryModalResolve = resolve;
    });
  };

  const closeCategoryModal = (result = null) => {
    $("#category-select-modal").fadeOut(200);
    categoryModalPostsToAdd = [];
    if (categoryModalResolve) {
      categoryModalResolve(result);
      categoryModalResolve = null;
    }
  };

  // Show modal for changing a post's category (simpler version)
  const showChangeCategoryModal = async (postId) => {
    const $modal = $("#category-select-modal");
    const $title = $("#category-modal-title");

    $title.text("Change Category");

    // Show the skip button (to allow removing category)
    $(".skip-category-option").show();

    // Switch to select tab
    $(".category-tab").removeClass("active");
    $('.category-tab[data-tab="select"]').addClass("active");
    $(".category-tab-content").removeClass("active");
    $('.category-tab-content[data-content="select"]').addClass("active");

    // Reset form
    resetCategoryForm();

    // Populate data
    await renderCategoryList();
    await renderFlagPicker();

    $modal.fadeIn(200);

    return new Promise((resolve) => {
      categoryModalResolve = resolve;
    });
  };

  const addPostsToLibraryWithCategory = async (posts, categoryId) => {
    let successCount = 0;
    let failCount = 0;

    for (const post of posts) {
      try {
        const result = await window.electronAPI.addToLibrary(
          post,
          categoryId || null,
        );
        if (result.success) {
          successCount++;
          // Remove from UI
          $(`.post-element[data-id="${post.postId}"]`).fadeOut(
            200,
            function () {
              $(this).remove();
            },
          );
          cardCacheTemp.delete(post.postId);
        } else {
          if (result.code === "DUPLICATE_POST") {
            // Still count as handled, remove from UI
            successCount++;
            $(`.post-element[data-id="${post.postId}"]`).fadeOut(
              200,
              function () {
                $(this).remove();
              },
            );
            cardCacheTemp.delete(post.postId);
          } else {
            failCount++;
          }
        }
      } catch (error) {
        console.error(`Failed to add post ${post.postId}:`, error);
        failCount++;
      }
    }

    // Clear caches and refresh
    clearCacheKeys("postsLibrary", "spyPosts");
    lastSpyPostsIdsHash = "";
    lastLibraryPageSig = "";
    categoriesCache = null;

    await populateCategoryDropdown();

    return { successCount, failCount };
  };

  // ---- Posts Rendering (Temp + Library) ----

  const getFilters = () => {
    const filter = ($("#filter-type").val() || "").trim();
    const sortBy = ($("#sort-by").val() || "").trim();
    const search = ($("#search-message").val() || "").toLowerCase();
    const hideUsed = $("#hide-used-posts").is(":checked");
    const category = ($("#filter-category").val() || "").trim();
    return { filter, sortBy, search, hideUsed, category };
  };

  const applyFiltersAndSort = (
    posts,
    { filter, sortBy, search, hideUsed, category },
  ) => {
    // Map sort option values to actual field names
    const fieldMap = {
      now: 'createdTime',
      shares: 'shares',
      comments: 'comments',
      likes: 'reactions',
      viral: 'viralityScore'
    };
    const sortField = fieldMap[sortBy] || 'createdTime';
    
    return posts
      .filter((p) => {
        const okType = !filter || p.type === filter;
        const okSearch =
          !search ||
          (p.postMessage && p.postMessage.toLowerCase().includes(search));
        // Filter out used posts if hideUsed is true
        const okUsed = !hideUsed || !p.usedAt;
        // Filter by category
        let okCategory = true;
        if (category === "uncategorized") {
          okCategory = !p.categoryId;
        } else if (category) {
          okCategory = p.categoryId === category;
        }
        return okType && okSearch && okUsed && okCategory;
      })
      .sort((a, b) => (b[sortField] || 0) - (a[sortField] || 0));
  };

  // Video detection filter (used for both temp and library posts)
  const filterOutVideos = (posts) => {
    return posts.filter((p) => {
      const img = p.postImg || p.postImage || "";
      // Allow local images (downloaded files) and Facebook CDN images
      // Filter out videos by checking for video-related patterns
      if (!img) return false; // No image at all

      // Allow local file paths (starts with filename only, no URL)
      if (!img.startsWith("http")) return true;

      // For remote URLs, only allow Facebook CDN images (not videos)
      return img.includes("fbcdn.net") && !img.includes("/video");
    });
  };

  // New functions for temp posts filtering
  const getTempFilters = () => {
    const minShares = parseInt($("#min-shares").val()) || 0;
    const minLikes = parseInt($("#min-likes").val()) || 0;
    const minComments = parseInt($("#min-comments").val()) || 0;
    const tempSortBy = ($("#temp-sort-by").val() || "now").trim();
    return { minShares, minLikes, minComments, tempSortBy };
  };

  const applyTempFilters = (posts) => {
    const { minShares, minLikes, minComments } = getTempFilters();
    const minVirality = parseFloat($("#min-virality").val()) || 0;

    return posts.filter((p) => {
      // Apply minimum threshold filters
      const shares = p.shares || 0;
      const likes = p.reactions || 0; // reactions = likes in this context
      const comments = p.comments || 0;
      const virality = p.viralityScore || 0;

      return (
        shares >= minShares && likes >= minLikes && comments >= minComments && virality >= minVirality
      );
    });
  };

  // Sort temp posts by selected field
  const applyTempSort = (posts) => {
    const { tempSortBy } = getTempFilters();
    
    // Map sort option values to actual field names
    const fieldMap = {
      now: 'createdTime',
      shares: 'shares',
      comments: 'comments',
      likes: 'reactions',
      viral: 'viralityScore'
    };
    
    const field = fieldMap[tempSortBy] || 'createdTime';
    
    return [...posts].sort((a, b) => (b[field] || 0) - (a[field] || 0));
  };

  // Debounced function to mark rendered posts as permanently seen
  // This prevents posts from ever appearing in spy manager again
  // Now also stores share counts for viral growth detection
  let seenPostsBuffer = new Map(); // postId -> shares
  let seenPostsTimeout = null;
  const markRenderedPostsAsSeen = (postIds, sharesMap = {}) => {
    // Add to buffer with shares data
    for (const id of postIds) {
      // Only update if we have shares data, or if the post isn't already buffered
      if (sharesMap[id] != null || !seenPostsBuffer.has(id)) {
        seenPostsBuffer.set(id, sharesMap[id] || 0);
      }
    }
    // Debounce the API call to batch multiple renders
    if (seenPostsTimeout) clearTimeout(seenPostsTimeout);
    seenPostsTimeout = setTimeout(async () => {
      if (seenPostsBuffer.size > 0) {
        const idsToMark = Array.from(seenPostsBuffer.keys());
        const sharesMapToSend = {};
        for (const [id, shares] of seenPostsBuffer) {
          sharesMapToSend[id] = shares;
        }
        seenPostsBuffer.clear();
        try {
          await window.electronAPI.markPostsAsSeen(idsToMark, sharesMapToSend);
          console.log(
            `[markRenderedPostsAsSeen] Marked ${idsToMark.length} posts as permanently seen with shares data`,
          );
        } catch (e) {
          console.error("[markRenderedPostsAsSeen] Failed:", e);
        }
      }
    }, 3000); // 3 second debounce
  };

  // Hidden posts management (now uses persistent backend storage)
  const hiddenPostIds = new Set(); // Local cache for immediate UI response

  const hidePost = async (postId, shares = 0) => {
    // Add to local cache for immediate UI update
    hiddenPostIds.add(postId);
    // Persist to backend (marks as permanently seen with shares for viral growth detection)
    try {
      await window.electronAPI.hideSpyPost(postId, shares);
    } catch (e) {
      console.error("[hidePost] Failed to persist hidden post:", e);
    }
  };

  const isPostHidden = (postId) => {
    return hiddenPostIds.has(postId);
  };

  // Remove duplicate posts within temp posts list and hidden posts
  // Note: seen post filtering is now done in the backend before posts are even added
  const removeDuplicatesAndHiddenPosts = async (posts) => {
    if (!posts || posts.length === 0) return posts;

    // Track seen post IDs to remove duplicates within the temp posts
    const localSeenIds = new Set();

    return posts.filter((post) => {
      // Skip if duplicate within current temp posts
      if (localSeenIds.has(post.postId)) {
        return false;
      }

      // Skip if hidden by user
      if (isPostHidden(post.postId)) {
        return false;
      }

      localSeenIds.add(post.postId);
      return true;
    });
  };

  const renderTempPosts = throttle(async () => {
    // live temp posts (storage.spyPosts)
    const $container = $(".library-manager .posts-container");
    if (!$container.length) {
      console.log(
        "[renderTempPosts] Container not found - .library-manager .posts-container",
      );
      return;
    }

    const spyPosts = await getCachedKey("spyPosts");
    let originalPosts = spyPosts || [];

    // Filter posts by current profile (multi-session support)
    // Only show posts collected by the currently active spy profile
    if (openProfile && openProfile.id) {
      originalPosts = originalPosts.filter(p => 
        p.spyProfileId === openProfile.id || !p.spyProfileId // Include legacy posts without profileId
      );
    }

    // Fetch followed pages to pass to postCard
    const followedPages = (await getCachedKey("followedPages")) || {};
    const followedPageUrls = new Set(Object.keys(followedPages));

    // quick hash of original posts + filters to determine if we need to re-render
    // Note: seen post filtering is done in backend, so we don't need to track seenPostIds here
    const filtersHash = hash(getTempFilters());
    const originalIdsHash = hash(originalPosts.map((p) => p.postId));
    const followedPagesHash = hash([...followedPageUrls].sort());
    const combinedHash = `${originalIdsHash}_${filtersHash}_${openProfile?.id || 'none'}_${followedPagesHash}`;

    if (combinedHash === lastSpyPostsIdsHash) {
      return;
    }
    lastSpyPostsIdsHash = combinedHash;

    // Apply filters
    let posts = originalPosts;

    // Filter out posts that are already in the library (frontend safety check)
    const postsLibrary = (await getCachedKey("postsLibrary")) || [];
    const libraryPostIds = new Set(postsLibrary.map((p) => p.postId));
    posts = posts.filter((p) => !libraryPostIds.has(p.postId));

    // Remove duplicates and hidden posts (seen post filtering is done in backend)
    posts = await removeDuplicatesAndHiddenPosts(posts);

    // Filter out banned pages
    posts = await filterBannedPosts(posts);

    // Filter out video posts
    posts = filterOutVideos(posts);

    // Apply temp post filters (minimum thresholds)
    posts = applyTempFilters(posts);

    // Apply sorting
    posts = applyTempSort(posts);

    // diff by card hash; update/insert/remove
    const seen = new Set();
    const frag = document.createDocumentFragment();

    // Build a map of existing elements to allow in-place updates
    const $existing = new Map();
    $container.children(".post-element").each(function () {
      const id = $(this).attr("data-id");
      if (id) $existing.set(id, $(this));
    });

    for (const p of posts) {
      const cardSig = hash({
        id: p.postId,
        type: p.type,
        img: p.postImg || p.postImage || "",
        msg: p.postMessage || "",
        shares: p.shares,
        comments: p.comments,
        repins: p.repins,
        reactions: p.reactions,
        page: p.page ? { n: p.page.name, i: p.page.image } : null,
        created: p.createdTime,
      });
      seen.add(p.postId);

      if ($existing.has(p.postId) && cardCacheTemp.get(p.postId) === cardSig) {
        // unchanged
        continue;
      }

      const html = postCard(p, "temp", { followedPageUrls });
      if ($existing.has(p.postId)) {
        $existing.get(p.postId).replaceWith(htmlToNode(html));
      } else {
        frag.appendChild(htmlToNode(html));
      }
      cardCacheTemp.set(p.postId, cardSig);
    }

    // Remove stale
    $container.children(".post-element").each(function () {
      const id = $(this).attr("data-id");
      if (id && !seen.has(id)) {
        $(this).remove();
        cardCacheTemp.delete(id);
      }
    });

    if (frag.childNodes.length) $container[0].appendChild(frag);

    // Mark all rendered posts as permanently seen so they never appear again
    // This is done in a debounced manner to avoid excessive DB writes
    // Build sharesMap from posts for viral growth detection
    if (seen.size > 0) {
      const sharesMap = {};
      for (const p of posts) {
        if (p.postId && seen.has(p.postId)) {
          sharesMap[p.postId] = p.shares || 0;
        }
      }
      markRenderedPostsAsSeen(Array.from(seen), sharesMap);
    }

    // Check if new RAW posts arrived (to reset no-posts timeout)
    // We use raw count (before filters) so that finding posts that don't match filters
    // still resets the timeout - the spy IS working, just no posts match the criteria
    const oldRawCount = rawPostsCount;
    rawPostsCount = originalPosts.length;

    // Update generated posts count (filtered) and generation state display
    generatedPostsCount = posts.length;
    updateGenerationState();
    
    // Update spyManager session count to match the filtered count shown in UI
    if (openProfile && openProfile.id && window.spyManager) {
      const session = window.spyManager.sessions.get(openProfile.id);
      if (session) {
        session.postCount = posts.length;
        window.spyManager._updateFloatingIndicator();
      }
    }

    // If raw posts count increased, reset the no-posts timeout
    // This prevents restart when spy finds posts but they're filtered out
    if (rawPostsCount > oldRawCount) {
      handleNewPostReceived();
    }

    // Update bulk action buttons state after rendering
    raf(() => {
      updateTempBulkActionsState();

      // Update select-all checkbox state
      const totalCheckboxes = $(".temp-post-checkbox").length;
      const checkedCheckboxes = $(".temp-post-checkbox:checked").length;
      const selectAllCheckbox = $("#select-all-temp-posts");

      if (totalCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === totalCheckboxes) {
        selectAllCheckbox.prop("checked", true).prop("indeterminate", false);
      } else {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", true);
      }
    });

    // Manage cache size to prevent memory leaks
    manageCacheSize(cardCacheTemp);
  }, RENDER_THROTTLE_MS);

  const renderLibraryPosts = throttle(async () => {
    const $wrap = $("#library-show");
    if (!$wrap.length) return;

    const $container = $("#library-show .posts-container");
    const $paginationWrap = $("#pagination");
    const $pagination = $("#pagination .pagination");

    const postsLibrary = await getCachedKey("postsLibrary");
    let posts = postsLibrary || [];

    // Filter out banned pages first
    posts = await filterBannedPosts(posts);

    // Filter out video posts
    posts = filterOutVideos(posts);

    const filters = getFilters();
    posts = applyFiltersAndSort(posts, filters);

    const totalPages = Math.max(1, Math.ceil(posts.length / LIBRARY_PAGE_SIZE));
    if (currentLibraryPage > totalPages) currentLibraryPage = totalPages;

    const pageSig = `p:${currentLibraryPage}:t:${totalPages}:c:${posts.length}:f:${filters.filter}:s:${filters.sortBy}:q:${filters.search}:u:${filters.hideUsed}:cat:${filters.category}`;
    if (pageSig === lastLibraryPageSig) return;
    lastLibraryPageSig = pageSig;

    const pageSlice = posts.slice(
      (currentLibraryPage - 1) * LIBRARY_PAGE_SIZE,
      currentLibraryPage * LIBRARY_PAGE_SIZE,
    );

    // Load categories for badge display
    const categories = await loadCategories();
    const categoryMap = new Map();
    for (const cat of categories) {
      categoryMap.set(cat.id, cat);
    }

    // Build duplicate detection map (by image filename)
    const imageCountMap = new Map();
    for (const p of posts) {
      const imgKey = p.postImg || "";
      if (imgKey) {
        imageCountMap.set(imgKey, (imageCountMap.get(imgKey) || 0) + 1);
      }
    }
    // Create set of duplicate images (count > 1)
    const duplicateImages = new Set();
    for (const [img, count] of imageCountMap) {
      if (count > 1) duplicateImages.add(img);
    }

    // Build/refresh pagination controls
    if (totalPages > 1) {
      $paginationWrap.show();
      const fragPg = document.createDocumentFragment();
      for (let i = 1; i <= totalPages; i++) {
        const li = htmlToNode(
          `<li class="page-item">
            <a class="page-link ${i === currentLibraryPage ? "active" : ""}" href="#${i}">${i}</a>
           </li>`,
        );
        fragPg.appendChild(li);
      }
      $pagination.empty()[0].appendChild(fragPg);
    } else {
      $paginationWrap.hide();
      $pagination.empty();
    }

    // Diff cards
    const seen = new Set();
    const existingMap = new Map();
    $container.children(".post-element").each(function () {
      const id = $(this).attr("data-id");
      if (id) existingMap.set(id, $(this));
    });

    const frag = document.createDocumentFragment();

    for (const p of pageSlice) {
      seen.add(p.postId);
      const isDuplicate = duplicateImages.has(p.postImg || "");
      const categoryInfo = p.categoryId ? categoryMap.get(p.categoryId) : null;
      const sig = hash({
        id: p.postId,
        type: p.type,
        img: p.postImg || "",
        msg: p.postMessage || "",
        shares: p.shares,
        comments: p.comments,
        repins: p.repins,
        reactions: p.reactions,
        page: p.page ? { n: p.page.name, i: p.page.image } : null,
        created: p.createdTime,
        usedAt: p.usedAt || null,
        usedCount: p.usedCount || 0,
        isDuplicate: isDuplicate,
        categoryId: p.categoryId || null,
      });

      if (existingMap.has(p.postId) && cardCacheLib.get(p.postId) === sig)
        continue;

      const html = postCard(p, "library", { isDuplicate, categoryInfo });
      if (existingMap.has(p.postId)) {
        existingMap.get(p.postId).replaceWith(htmlToNode(html));
      } else {
        frag.appendChild(htmlToNode(html));
      }
      cardCacheLib.set(p.postId, sig);
    }

    // Remove stale
    $container.children(".post-element").each(function () {
      const id = $(this).attr("data-id");
      if (id && !seen.has(id)) {
        $(this).remove();
        cardCacheLib.delete(id);
      }
    });

    if (frag.childNodes.length) $container[0].appendChild(frag);

    // Update delete button state and select-all checkbox after rendering
    raf(() => {
      updateDeleteButtonState();

      // Update select-all checkbox state
      const totalCheckboxes = $(".post-checkbox").length;
      const checkedCheckboxes = $(".post-checkbox:checked").length;
      const selectAllCheckbox = $("#select-all-posts");

      if (totalCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === totalCheckboxes) {
        selectAllCheckbox.prop("checked", true).prop("indeterminate", false);
      } else {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", true);
      }
    });

    // Manage cache size to prevent memory leaks
    manageCacheSize(cardCacheLib);
  }, RENDER_THROTTLE_MS);

  const htmlToNode = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  };

  // Format follower count for display (e.g., 840000 -> "840K", 1200000 -> "1.2M")
  const formatFollowers = (count) => {
    if (!count || count < 1000) return count ? count.toString() : "";
    if (count >= 1000000000)
      return (count / 1000000000).toFixed(1).replace(/\.0$/, "") + "B";
    if (count >= 1000000)
      return (count / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (count >= 1000)
      return (count / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return count.toString();
  };

  function postCard(data, type, options = {}) {
    const { isDuplicate = false, categoryInfo = null, followedPageUrls = new Set() } = options;

    // Build page header with optional follower count
    let pageHtml = "";
    if (data.page) {
      const followersDisplay = data.page.followers
        ? `<span class="page-followers" title="${data.page.followers.toLocaleString()} followers"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">group</i> ${formatFollowers(data.page.followers)}</span>`
        : "";
      pageHtml = `
      <img class="profile" src="${type === "library" || (data.page.image && !data.page.image.startsWith("http")) ? imgSrc(data.page.image, true) : data.page.image}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='assets/images/icons/${data.type || 'facebook'}-colored.png';this.style.width='36px';this.style.height='36px';this.style.borderRadius='50%';">
      <div class="name">
        <strong>${data.page.name}</strong>
        <div class="page-meta">
            <span>${timeAgoSafe((data.createdTime || 0) * 1000)}</span>
            ${followersDisplay}
        </div>
      </div>`;
    }

    // Pre-calculate stats to avoid repetitive conditionals
    const statItems = [];
    if (data.shares != null)
      statItems.push(
        `<div class="stat"><i class="material-icons">share</i><span>${formatNumber(data.shares)}</span></div>`,
      );
    if (data.comments != null)
      statItems.push(
        `<div class="stat"><i class="material-icons">mode_comment</i><span>${formatNumber(data.comments)}</span></div>`,
      );
    if (data.repins != null)
      statItems.push(
        `<div class="stat"><i class="material-icons">moved_location</i><span>${formatNumber(data.repins)}</span></div>`,
      );
    if (data.reactions != null)
      statItems.push(
        `<div class="stat"><i class="material-icons">thumb_up</i><span>${formatNumber(data.reactions)}</span></div>`,
      );
    if (data.viralityScore != null)
      statItems.push(
        `<div class="stat virality" title="Virality Score: ${data.viralityScore} (shares per 1000 followers)"><i class="material-icons">local_fire_department</i><span>${data.viralityScore}</span></div>`,
      );
    const stats = statItems.join("");

    // Used badge for library posts
    const usedBadge =
      type === "library" && data.usedAt
        ? `<div class="used-badge" title="Used ${data.usedCount || 1}x - Last: ${new Date(data.usedAt).toLocaleDateString()}">
                <i class="material-icons">check_circle</i>
                <span>Used${data.usedCount > 1 ? ` (${data.usedCount}x)` : ""}</span>
            </div>`
        : "";

    // Category badge for library posts
    let categoryBadge = "";
    if (type === "library" && categoryInfo) {
      const catIcon = categoryInfo.image
        ? `<img src="${categoryInfo.image}" alt="">`
        : `<i class="material-icons">folder</i>`;
      categoryBadge = `<div class="category-badge" title="Category: ${categoryInfo.name}">${catIcon}<span>${categoryInfo.name}</span></div>`;
    }

    // Duplicate badge for library posts
    const duplicateBadge =
      type === "library" && isDuplicate
        ? `<div class="duplicate-badge" title="This image appears multiple times in your library">
                <i class="material-icons">content_copy</i>
                <span>Duplicate</span>
            </div>`
        : "";

    // Viral growth badge for posts with 10%+ share increase since last seen
    let viralGrowthBadge = "";
    if (data.viralGrowth && type !== "library") {
      const vg = data.viralGrowth;
      viralGrowthBadge = `
            <div class="viral-growth-badge" title="This post gained ${vg.increasePercent}% more shares (${formatNumber(vg.previousShares)} → ${formatNumber(vg.currentShares)}) since ${vg.timeSinceSeen}">
                <div class="viral-header">
                    <i class="material-icons">trending_up</i>
                    <span class="viral-percent">+${vg.increasePercent}%</span>
                </div>
                <div class="viral-stats">
                    <span>+${formatNumber(vg.shareIncrease)} shares</span>
                    <span>since ${vg.timeSinceSeen}</span>
                </div>
            </div>`;
    }

    // Used class for styling
    const usedClass = type === "library" && data.usedAt ? " post-used" : "";

    // Different action buttons for library vs temp posts
    const actionBtn =
      type === "library"
        ? `<div class="library-actions">
                <label class="d-flex align-items-center" style="font-size:12px;">
                    <input type="checkbox" class="post-checkbox me-1" data-id="${data.postId}" />
                    Select
                </label>
                <div class="d-flex gap-1">
                    <button data-role="changeCategory" data-id="${data.postId}" class="btn btn-outline-info btn-sm" title="Change category">
                        <i class="material-icons">folder</i><span>Category</span>
                    </button>
                    <button data-role="deletePost" data-id="${data.postId}" class="btn btn-danger btn-sm" title="Delete post">
                        <i class="material-icons">delete</i><span>Delete</span>
                    </button>
                </div>
            </div>`
        : `<div class="spy-card-actions">
                <div class="spy-card-actions-top">
                    <label class="spy-select-label">
                        <input type="checkbox" class="temp-post-checkbox" data-id="${data.postId}" />
                        <span>Select</span>
                    </label>
                    <div class="spy-card-dropdown">
                        <button class="spy-dropdown-toggle" type="button">
                            <i class="material-icons">more_vert</i>
                        </button>
                        <div class="spy-dropdown-menu">
                            ${(() => {
                              if (!data.page) return '';
                              const isFollowed = followedPageUrls.has(data.page.url);
                              return isFollowed
                                ? `<button data-role="unfollowPage" data-page-url="${data.page.url}" data-page-name="${data.page.name}" data-platform="${data.type}" class="spy-dropdown-item">
                                    <i class="material-icons">star_border</i><span>Unfollow Page</span>
                                  </button>`
                                : `<button data-role="followPage" data-page-url="${data.page.url}" data-page-name="${data.page.name}" data-page-image="${data.page.image}" data-platform="${data.type}" class="spy-dropdown-item">
                                    <i class="material-icons">star</i><span>Follow Page</span>
                                  </button>`;
                            })()}
                            ${
                              data.page
                                ? `
                            <button data-role="banPage" data-page-url="${data.page.url}" data-page-name="${data.page.name}" data-page-image="${data.page.image}" data-platform="${data.type}" class="spy-dropdown-item">
                                <i class="material-icons">block</i><span>Ban Page</span>
                            </button>`
                                : ""
                            }
                            <button data-role="hidePost" data-id="${data.postId}" class="spy-dropdown-item">
                                <i class="material-icons">visibility_off</i><span>Hide Post</span>
                            </button>
                        </div>
                    </div>
                </div>
                <button data-role="addToLibrary" data-id="${data.postId}" class="spy-add-library-btn">
                    <i class="material-icons">library_add</i>
                    <span>Add to Library</span>
                </button>
            </div>`;

    const isLocalImg = data.postImg && !data.postImg.startsWith("http");
    const img = (type === "library" || isLocalImg) ? imgSrc(data.postImg, true) : data.postImg;
    const message = data.postMessage?.trim();

    return `<div class="post-element${usedClass}" data-id="${data.postId}">
      ${categoryBadge}
      ${usedBadge}
      ${duplicateBadge}
      ${viralGrowthBadge}
      <div class="head">
        <div class="left">${pageHtml}</div>
        <img src="assets/images/icons/${data.type}-colored.png" class="sm" loading="lazy" decoding="async">
      </div>
      <img class="post-image" loading="lazy" decoding="async" src="${img}" alt="Post image" onerror="this.onerror=null;this.style.display='none';">
      <div class="post-statistics">${stats}</div>
      ${message?.length ? `<textarea readonly class="post-content">${message}</textarea>` : ""}
      ${actionBtn}
    </div>`;
  }

  // ---- Core Poll Loop ----
  const poll = async () => {
    if (!isVisible) return; // pause work when hidden

    try {
      // Force fresh data on poll to check for changes
      cachedData = null;
      await raf(() => renderProfiles()); // Use RAF for smoother rendering
      await raf(() => renderTempPosts());
      await raf(() => renderLibraryPosts());
      await raf(() => renderBannedPages());
      await raf(() => renderFollowedPages());
    } catch (error) {
      console.error("Polling error:", error);
    }
  };

  const startPoll = () => {
    if (pollId) return;
    pollId = setInterval(poll, POLL_MS);
    window.intervals.push(pollId);
  };

  const stopPoll = () => {
    if (!pollId) return;
    clearInterval(pollId);
    pollId = null;
  };

  document.addEventListener(
    "visibilitychange",
    () => {
      isVisible = !document.hidden;
      if (isVisible) startPoll();
      else stopPoll();
    },
    { passive: true },
  );

  // Listen for spy post used updates to refresh the library view in real-time
  window.electronAPI.onSpyPostUsed((data) => {
    console.log("[Spy Library] Spy post marked as used:", data);
    // Update the post card in the library if visible
    const $postCard = $(
      `.posts-container .post-element[data-id="${data.postId}"]`,
    );
    if ($postCard.length) {
      // Add used badge if not already present
      if (!$postCard.find(".used-badge").length) {
        $postCard
          .find(".post-badges")
          .append(
            '<span class="used-badge"><i class="material-icons">check_circle</i>Used</span>',
          );
        $postCard.addClass("post-used");
      }
      // Invalidate cache so it renders correctly on next full render
      cardCacheLib.delete(data.postId);
    }
  });

  // Listen for spy pages completed event (when all followed pages have been fully scrolled)
  window.electronAPI.onSpyPagesCompleted((data) => {
    console.log("[Spy] All pages completed:", data);

    // Hide progress bar
    $(".spy-pages-progress").addClass("d-none").removeClass("d-flex");

    // Update the generation state display
    isGenerating = false;
    
    // Update spyManager session state to reflect completion (skip for FeedSpy)
    if (data.source !== "feedspy" && openProfile && window.spyManager) {
      const session = window.spyManager.sessions.get(openProfile.id);
      if (session) {
        session.isGenerating = false;
        session.isCompleted = true;
      }
      window.spyManager._updateFloatingIndicator();
    }
    
    const $stateDisplay = $(".libraryGenerationState");
    $stateDisplay.html(`
            <i class="material-icons" style="color: #10b981; font-size: 24px;">check_circle</i>
            <span style="color: #10b981; font-weight: 600;">Spying Complete!</span>
        `);

    // Update the stop button to show completion
    const $stopBtn = $(".stopresetgeneration");
    $stopBtn
      
      .attr("title", "Completed")
      .html(`<i class="material-icons" style="color: #22c55e;">check_circle</i>`);

    // Stop auto-restart and no-posts timeout since we're done
    stopAutoRestartInterval();
    stopNoPostsTimeout();

    // Show alert to user
    showAlert(
      "success",
      data.message ||
        `Finished spying on all ${data.pagesCount} pages. Add the posts you want to your library.`,
    );
  });

  // Listen for spy stopped event (when spy is stopped from elsewhere, like floating indicator)
  window.electronAPI.onSpyStopped((data) => {
    console.log("[Spy] Spy stopped event received:", data);
    
    // Ignore spy-stopped during auto-restart cycle (browser is being recycled, not truly stopped)
    if (isAutoRestarting) {
      console.log(`[Spy] Ignoring spy-stopped during auto-restart (reason: ${data.reason})`);
      return;
    }
    
    // Check if this affects our current open profile
    if (openProfile && openProfile.id === data.profileId) {
      console.log(`[Spy] Current profile stopped (reason: ${data.reason})`);
      
      // Stop all intervals and update state
      stopPreviewInterval();
      stopAutoRestartInterval();
      stopNoPostsTimeout();
      
      isGenerating = false;
      
      // Update UI
      $(".stopresetgeneration")
        .attr("title", "Start generation")
        .html(`<i class="material-icons">play_circle</i>`);
      updateGenerationState();
      
      // Hide progress bar if in pages mode
      $(".spy-pages-progress").addClass("d-none").removeClass("d-flex");
    }
  });

  // Listen for spy page progress updates (for specific pages mode)
  window.electronAPI.onSpyPageProgress((data) => {
    console.log("[Spy] Page progress:", data);
    
    // Update spyManager session state for floating indicator (skip FeedSpy — no session)
    if (data.source !== "feedspy" && openProfile && window.spyManager) {
      window.spyManager.updatePagesProgress(
        openProfile.id,
        data.currentPage,
        data.totalPages,
        data.currentPageUrl
      );
    }

    const $progressContainer = $(".spy-pages-progress");
    const $currentPage = $progressContainer.find(".current-page");
    const $totalPages = $progressContainer.find(".total-pages");
    const $progressBar = $progressContainer.find(".progress-bar");
    const $pageName = $progressContainer.find(".current-page-name");

    // Show progress bar
    $progressContainer.removeClass("d-none").addClass("d-flex");

    // Update values
    $currentPage.text(data.currentPage);
    $totalPages.text(data.totalPages);

    // Calculate progress percentage
    const progressPercent = (data.currentPage / data.totalPages) * 100;
    $progressBar.css("width", progressPercent + "%");

    // Extract page name from URL for display
    let pageName = "";
    try {
      const url = new URL(data.currentPageUrl);
      pageName =
        url.pathname.replace(/^\//, "").replace(/\/$/, "") || url.hostname;
      // Handle profile.php?id= format
      if (pageName === "profile.php" && url.searchParams.get("id")) {
        pageName = "ID: " + url.searchParams.get("id");
      }
    } catch (e) {
      pageName = data.currentPageUrl;
    }
    $pageName.text(pageName).attr("title", data.currentPageUrl);
  });

  // ---- Boot (namespaced, safe for dynamic .load) ----
  $(document).ready(function () {
    // Remove any prior handlers for this page before re-binding
    $(document).off(NS);
    $("#spy-section").off(NS);
    $("#library-show").off(NS);
    $("body").off(NS);

    initTooltips();
    // Check if we need to restore a minimized spy session
    checkAndRestoreSpySession();
    
    // Initialize session switcher
    initSessionSwitcher();

    // Sidebar menu
    $(".settings-sidebar .menu .menu-element").on("click" + NS, function (e) {
      e.preventDefault();
      $(".settings-sidebar .menu .menu-element").removeClass("active");
      $(this).addClass("active");
      $(".section").hide();
      $(".section#" + $(this).attr("for")).show();
    });

    // Create Profile
    $("#spy-section").on("click" + NS, "#newProfile", async function () {
      const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
      const platformField = window.I18n?.t('common.platform') || "Platform";
      const proxyIpField = "Proxy ip";
      const proxyPortField = "Proxy port";
      const proxyUsernameField = "Proxy Username";
      const proxyPasswordField = "Proxy Password";
      const result = await newPrompt([
        { type: "text", name: profileNameField, required: true },
        {
          type: "select",
          name: platformField,
          required: true,
          options: [
            { label: "Facebook", value: "facebook" },
            /* { label: "Pinterest", value: "pinterest" } */
          ],
        },
        { type: "text", name: proxyIpField },
        { type: "text", name: proxyPortField },
        { type: "text", name: proxyUsernameField },
        { type: "text", name: proxyPasswordField },
      ]);
      if (!result) return;

      const proxyData = {
        ip: result[proxyIpField],
        port: result[proxyPortField],
        username: result[proxyUsernameField],
        password: result[proxyPasswordField],
      };

      let ip = null,
        country = null,
        country_name = null;
      if (proxyData.ip) {
        showLoading("Testing Proxy ...");
        const response = await window.electronAPI.testProxy(proxyData);
        removeLoading();
        if (!response.success) {
          showAlert("error", "Proxy failed: " + response.error);
          return;
        }
        ip = response.ip;
        country = response.country;
        country_name = response.country_name;
      }

      const profileID = generateRandomString(10);
      const profiles = (await window.electronAPI.readKey("spyProfiles")) || {};
      profiles[profileID] = {
        name: result[profileNameField],
        country,
        country_name,
        createdAt: new Date().toISOString(),
        status: "pending",
        proxy: proxyData,
        platform: result[platformField],
      };
      await window.electronAPI.updateData("spyProfiles", profiles);
      renderProfiles(); // immediate refresh
    });

    // Edit Profile
    $("#spy-section").on(
      "click" + NS,
      '[data-role="editSpyProfile"]',
      async function () {
        $(this).closest(".action-dropdown").removeClass("open");
        const id = $(this).attr("data-id");
        const spyProfiles =
          (await window.electronAPI.readKey("spyProfiles")) || {};
        if (!spyProfiles[id]) return;
        const proxy = spyProfiles[id]["proxy"] || {};

        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const platformField = "Platform";
        const proxyIpField = "Proxy ip";
        const proxyPortField = "Proxy port";
        const proxyUsernameField = "Proxy Username";
        const proxyPasswordField = "Proxy Password";
        const result = await newPrompt([
          {
            type: "text",
            name: profileNameField,
            required: true,
            value: spyProfiles[id]["name"],
          },
          {
            type: "select",
            name: platformField,
            required: true,
            value: spyProfiles[id]["platform"],
            options: [
              { label: "Facebook", value: "facebook" },
              { label: "Pinterest", value: "pinterest" },
            ],
          },
          { type: "text", name: proxyIpField, value: proxy["ip"] },
          { type: "text", name: proxyPortField, value: proxy["port"] },
          { type: "text", name: proxyUsernameField, value: proxy["username"] },
          { type: "text", name: proxyPasswordField, value: proxy["password"] },
        ]);
        if (!result) return;

        const proxyData = {
          ip: result[proxyIpField],
          port: result[proxyPortField],
          username: result[proxyUsernameField],
          password: result[proxyPasswordField],
        };

        let ip = null,
          country = null,
          country_name = null;
        if (proxyData.ip) {
          showLoading("Testing Proxy ...");
          const response = await window.electronAPI.testProxy(proxyData);
          removeLoading();
          if (!response.success) {
            showAlert("error", "Proxy failed: " + response.error);
            return;
          }
          ip = response.ip;
          country = response.country;
          country_name = response.country_name;
        }

        spyProfiles[id] = {
          ...spyProfiles[id],
          name: result[profileNameField],
          platform: result[platformField],
          proxy: proxyData,
          // If proxy is set, use new country; if proxy removed, clear country
          country: proxyData.ip ? country : null,
          country_name: proxyData.ip ? country_name : null,
        };
        await window.electronAPI.updateData("spyProfiles", spyProfiles);
        renderProfiles();
      },
    );

    // Delete Profile
    $("#spy-section").on(
      "click" + NS,
      '[data-role="delete"]',
      async function () {
        $(this).closest(".action-dropdown").removeClass("open");
        const id = $(this).attr("data-id");
        const confirmed = await confirmPrompt(
          "Do you really want to delete this profile?",
        );
        if (!confirmed) return;
        const entries = (await window.electronAPI.readKey("spyProfiles")) || {};
        delete entries[id];
        await window.electronAPI.updateData("spyProfiles", entries);
        window.electronAPI.deleteProfile(id);

        // Immediately remove the table row from DOM
        $(`tr[data-id="${id}"]`).remove();

        // Clear profile cache to ensure fresh data on next render
        profileRowCache.delete(id);

        renderProfiles();
      },
    );

    // Open Profile (stealth)
    $("#spy-section").on(
      "click" + NS,
      '[data-role="openProfile"]',
      async function () {
        $(this).closest(".action-dropdown").removeClass("open");
        const id = $(this).attr("data-id");
        const spyProfiles = await getCachedKey("spyProfiles");
        const profile = spyProfiles?.[id];
        if (!profile) return;
        const proxy = profile.proxy;
        if (!proxy) return;

        // Show warning if profile is not connected (user needs to login)
        const isJustOpen = $(this).attr("data-action") === "justopen";
        if (!isJustOpen && profile.status !== "connected") {
          const confirmed = await confirmPrompt(
            `<div class="text-start">
                        <p class="mb-2"><strong><i class="material-icons" style="font-size:16px;vertical-align:middle">warning</i> Important Notice</strong></p>
                        <p class="mb-2">This application performs automated actions that may violate the platform's Terms of Service. Using this feature could result in:</p>
                        <ul class="mb-2" style="padding-left: 20px;">
                            <li>Account suspension or permanent ban</li>
                            <li>Loss of access to your profile and data</li>
                            <li>Restrictions on associated accounts</li>
                        </ul>
                        <p class="mb-0 text-warning"><strong>Please only connect accounts that you are willing to lose. Do not use your primary or important accounts.</strong></p>
                    </div>`,
            "I Understand the Risks",
          );
          if (!confirmed) return;
        }

        let url = null;
        if (profile.platform === "facebook") url = "https://www.facebook.com";
        else if (profile.platform === "pinterest")
          url = "https://www.pinterest.com/login/";

        window.electronAPI.openStealthProfile(
          id,
          url,
          proxy,
          $(this).attr("data-action") == "justopen"
            ? null
            : `${profile.platform}spy`,
        );
        $(this).addClass("disabled").attr("disabled", "");
      },
    );

    // Start Spy - Show filter dialog first
    $("#spy-section").on(
      "click" + NS,
      '[data-role="startSpy"]',
      async function () {
        $(this).closest(".action-dropdown").removeClass("open");
        const id = $(this).attr("data-id");
        
        // Check if this profile already has an active spy session
        if (window.spyManager && window.spyManager.sessions.has(id)) {
          return showAlert("warning", "This profile already has an active spy session. Stop it first or use a different profile.");
        }
        
        // Force fresh data for critical operations
        cachedData = null;
        const spyProfiles = await getCachedKey("spyProfiles");
        if (!spyProfiles[id]) return;

        const platform = spyProfiles[id]["platform"];

        // Store profile info for use in filter dialog callback
        window.pendingSpyProfile = { id, platform };

        // Populate category dropdowns and update target pages selector
        await populatePageCategoryDropdowns();
        await updateTargetPagesSelector();

        // Reset spy mode to default (feed) and category filter
        $('input[name="spy-mode"][value="feed"]').prop("checked", true);
        $("#target-pages-section").hide();
        $("#spy-category-filter").val("");
        currentSpyCategoryId = null;

        // Show filter dialog
        $("#spy-filter-dialog").fadeIn(200);
      },
    );

    // Spy mode toggle handler
    $(document).on("change" + NS, 'input[name="spy-mode"]', async function () {
      const mode = $('input[name="spy-mode"]:checked').val();
      if (mode === "pages") {
        await populatePageCategoryDropdowns();
        $("#target-pages-section").slideDown(200);
      } else {
        $("#target-pages-section").slideUp(200);
        // Reset category filter and spy category
        $("#spy-category-filter").val("");
        currentSpyCategoryId = null;
      }
    });

    // Spy category filter change handler
    $(document).on("change" + NS, "#spy-category-filter", async function () {
      const categoryId = $(this).val() || null;
      currentSpyCategoryId = categoryId;
      await updateTargetPagesSelector(categoryId);
      // Reset select all checkbox state
      updateSelectAllSpyPagesState();
    });

    // Select all spy pages checkbox handler
    $(document).on("change" + NS, "#select-all-spy-pages", function () {
      const isChecked = $(this).is(":checked");
      $(".target-page-checkbox").prop("checked", isChecked);
    });

    // Update select all state when individual checkboxes change
    $(document).on("change" + NS, ".target-page-checkbox", function () {
      updateSelectAllSpyPagesState();
    });

    // Helper to update select all checkbox state
    const updateSelectAllSpyPagesState = () => {
      const $checkboxes = $(".target-page-checkbox");
      const $checkedBoxes = $(".target-page-checkbox:checked");
      const $selectAll = $("#select-all-spy-pages");
      
      if ($checkboxes.length === 0) {
        $selectAll.prop("checked", false);
        $selectAll.prop("indeterminate", false);
      } else if ($checkedBoxes.length === 0) {
        $selectAll.prop("checked", false);
        $selectAll.prop("indeterminate", false);
      } else if ($checkedBoxes.length === $checkboxes.length) {
        $selectAll.prop("checked", true);
        $selectAll.prop("indeterminate", false);
      } else {
        $selectAll.prop("checked", false);
        $selectAll.prop("indeterminate", true);
      }
    };

    // Scroll speed slider handler - show warning at high speeds
    $(document).on("input" + NS, "#filter-scroll-speed", function () {
      const speed = parseInt($(this).val());
      $("#scroll-speed-value").text(speed);

      // Show warning for speed >= 6
      if (speed >= 6) {
        $("#scroll-speed-warning").slideDown(200);
        $("#scroll-speed-value")
          .removeClass("bg-primary")
          .addClass("bg-warning");
      } else {
        $("#scroll-speed-warning").slideUp(200);
        $("#scroll-speed-value")
          .removeClass("bg-warning")
          .addClass("bg-primary");
      }
    });

    // Filter dialog cancel - use document delegation for fixed position modal
    $(document).on("click" + NS, "#spy-filter-cancel", function (e) {
      e.preventDefault();
      e.stopPropagation();
      $("#spy-filter-dialog").fadeOut(200);
      window.pendingSpyProfile = null;
    });

    // Close dialog when clicking overlay background
    $(document).on("click" + NS, "#spy-filter-dialog", function (e) {
      if (e.target === this) {
        $("#spy-filter-dialog").fadeOut(200);
        window.pendingSpyProfile = null;
      }
    });

    // Filter dialog start - actually start spying with filters
    $(document).on("click" + NS, "#spy-filter-start", async function (e) {
      e.preventDefault();
      e.stopPropagation();

      if (!window.pendingSpyProfile) return;

      const { id, platform } = window.pendingSpyProfile;
      const $btn = $(this);
      
      // Check if there's already an active spy session
      // Get spy mode
      const spyMode = $('input[name="spy-mode"]:checked').val() || "feed";

      // Get target pages if in pages mode
      let targetPages = [];
      if (spyMode === "pages") {
        targetPages = $(".target-page-checkbox:checked")
          .map(function () {
            return $(this).val();
          })
          .get();

        // Validate that at least one page is selected
        if (targetPages.length === 0) {
          showAlert("error", "Please select at least one page to spy on");
          return;
        }
      }

      // Get filters from dialog inputs
      const filters = {
        minShares: parseInt($("#filter-min-shares").val()) || 0,
        minLikes: parseInt($("#filter-min-likes").val()) || 0,
        minComments: parseInt($("#filter-min-comments").val()) || 0,
        minVirality: parseFloat($("#filter-min-virality").val()) || 0,
        scrollSpeed: parseInt($("#filter-scroll-speed").val()) || 3,
        spyMode: spyMode,
        targetPages: targetPages,
        maxPostAgeDays: Math.min(
          30,
          Math.max(1, parseInt($("#filter-max-post-age").val()) || 7),
        ),
        spyCategoryId: spyMode === "pages" ? currentSpyCategoryId : null,
      };

      // Hide dialog
      $("#spy-filter-dialog").fadeOut(200);

      // Get profile name for display in floating indicator
      const spyProfilesData = await getCachedKey("spyProfiles");
      const profileName = spyProfilesData[id]?.name || 'Unknown Profile';
      
      // Clear posts for this profile BEFORE starting session to prevent flash of old posts
      const existingPosts = await getCachedKey("spyPosts") || [];
      const otherProfilePosts = existingPosts.filter(p => p.spyProfileId && p.spyProfileId !== id);
      await window.electronAPI.updateData("spyPosts", otherProfilePosts);
      lastSpyPostsIdsHash = ''; // Force re-render
      
      // Register session with spyManager IMMEDIATELY in minimized state with loading indicator
      // This shows the floating indicator right away with a loading spinner
      if (!window.spyManager.sessions.has(id)) {
        await window.spyManager.startSession(id, platform, filters, spyMode, profileName);
        const session = window.spyManager.sessions.get(id);
        if (session) {
          session.isStarting = true;
          session.statusText = 'Testing login...';
        }
      }
      
      // Immediately minimize and show floating indicator
      window.spyManager.isMinimized = true;
      window.spyManager._updateFloatingIndicator();

      $btn.addClass("disabled").attr("disabled", "");

      let status = "error";
      let tries = 0;
      let isCancelled = false;
      
      // Check for cancellation via session removal
      const checkCancelled = () => !window.spyManager.sessions.has(id);
      
      while (status === "error" && tries < 3 && !isCancelled) {
        status = await window.electronAPI.testProfileLogin(platform, id);
        isCancelled = checkCancelled();
        if (status !== "error" || isCancelled) break;
        tries++;
      }

      // Check if operation was cancelled (session stopped from floating indicator)
      if (isCancelled || status === "cancelled") {
        $btn.removeClass("disabled").removeAttr("disabled");
        window.pendingSpyProfile = null;
        return;
      }

      $btn.removeClass("disabled").removeAttr("disabled");

      if (status === "error") {
        // Remove the session from floating indicator on error
        await window.spyManager.stopSession(id);
        window.pendingSpyProfile = null;
        return showAlert(
          "error",
          "An error occurred while checking login status",
        );
      }
      if (status === "loggedout") {
        // Remove the session from floating indicator
        await window.spyManager.stopSession(id);
        const spyProfiles = await getCachedKey("spyProfiles");
        spyProfiles[id]["status"] = "disconnected";
        await window.electronAPI.updateData("spyProfiles", spyProfiles);
        renderProfiles();
        window.pendingSpyProfile = null;
        return showAlert("error", "The profile is logged out");
      }
      
      // Update session status - login test passed, now starting spy
      const sessionAfterLogin = window.spyManager.sessions.get(id);
      if (sessionAfterLogin) {
        sessionAfterLogin.statusText = 'Starting spy...';
        window.spyManager._updateFloatingIndicator();
      }

      // Posts already cleared at session start - no need to clear again
      
      isGenerating = true;
      generatedPostsCount = 0;
      rawPostsCount = 0;
      
      // Store the current spy info for minimize functionality
      window.currentStartingSpyInfo = { id, platform, spyMode, filters };
      
      // Session is already registered and minimized - don't open library manager
      // User will click maximize on floating indicator when ready

      // Show spy category indicator if auto-assigning
      if (currentSpyCategoryId) {
        const categories = await loadCategories();
        const category = categories.find((c) => c.id === currentSpyCategoryId);
        if (category) {
          const iconHtml = category.image
            ? `<img src="${category.image}" width="12" height="12" style="border-radius: 2px; margin-right: 4px;">`
            : "";
          $("#spy-category-name").html(`${iconHtml}${category.name}`);
          $("#spy-category-indicator").removeClass("d-none").addClass("d-flex");
        }
      } else {
        $("#spy-category-indicator").removeClass("d-flex").addClass("d-none");
      }

      // Also update the library manager filter inputs to match
      $("#min-shares").val(filters.minShares || "");
      $("#min-likes").val(filters.minLikes || "");
      $("#min-comments").val(filters.minComments || "");
      $("#min-virality").val(filters.minVirality || "");
      $("#active-scroll-speed").text(filters.scrollSpeed || 3);

      console.log("Starting spy with filters:", filters);
      try {
        const spyResult = await window.electronAPI.startSpy(
          platform,
          id,
          filters,
        );
        console.log("startSpy result:", spyResult);
        if (spyResult && spyResult.status === "error") {
          // Remove session from floating indicator on error
          await window.spyManager.stopSession(id);
          showAlert("error", spyResult.message || "Failed to start spying");
          isGenerating = false;
          updateGenerationState();
          return;
        }
      } catch (spyErr) {
        console.error("startSpy error:", spyErr);
        // Remove session from floating indicator on error
        await window.spyManager.stopSession(id);
        showAlert(
          "error",
          "Failed to start spying: " + (spyErr.message || spyErr),
        );
        isGenerating = false;
        updateGenerationState();
        window.currentStartingSpyInfo = null;
        return;
      }
      openProfile = { platform, id, spyMode };
      window.pendingSpyProfile = null;
      window.currentStartingSpyInfo = null; // Clear since spy is now fully started

      // Mark session as fully started (no longer loading)
      const startedSession = window.spyManager.sessions.get(id);
      if (startedSession) {
        startedSession.isStarting = false;
        startedSession.statusText = null;
        window.spyManager._updateFloatingIndicator();
      }
      
      // Update session switcher
      updateSessionSwitcherUI();

      // Start auto-restart interval (every 10 minutes) - skip for pages mode
      if (spyMode !== "pages") {
        startAutoRestartInterval();
      }

      // Start no-posts timeout (auto-restart if no posts for 30 seconds)
      startNoPostsTimeout();
    });

    // Add to Library - now with category selection (auto-assign if spy has category)
    $("#spy-section").on(
      "click" + NS,
      '[data-role="addToLibrary"]',
      async function () {
        const $btn = $(this);
        const id = $btn.attr("data-id");
        const $postElement = $btn.closest(".post-element");

        // Prevent multiple clicks
        if ($btn.hasClass("processing")) return;

        const spyPosts = await getCachedKey("spyPosts");
        const item = (spyPosts || []).find((p) => p.postId === id);
        if (!item) {
          showAlert("error", "Post not found");
          return;
        }

        let categoryId = null;

        // If current spy session has a category, auto-assign it
        if (currentSpyCategoryId) {
          categoryId = currentSpyCategoryId;
        } else {
          // Show category selection modal
          const categoryResult = await showCategoryModal(item);

          // If modal was closed without selection, do nothing
          if (categoryResult === null) return;

          categoryId = categoryResult.categoryId;
        }

        // Set processing state
        $btn.addClass("processing").attr("disabled", true);
        $btn.html(
          `<div class="spinner-border spinner-border-sm me-1"></div>Adding...`,
        );

        try {
          // Add posts using the helper function
          const { successCount, failCount } =
            await addPostsToLibraryWithCategory([item], categoryId);

          if (successCount > 0) {
            showAlert("success", "Post added to library successfully!");

            // Force re-render to update state
            setTimeout(() => {
              console.log(
                "[Add to Library] Forcing library refresh after successful addition",
              );
              renderTempPosts();
              renderLibraryPosts();
            }, 250);
          } else {
            showAlert("error", "Failed to add post to library");
            // Restore button state
            $btn.removeClass("processing").attr("disabled", false);
            $btn.html(
              `<i class="material-icons">library_add</i><span>Add to Library</span>`,
            );
          }
        } catch (error) {
          console.error("Add to library error:", error);
          showAlert("error", "An unexpected error occurred. Please try again.");

          // Restore button state
          $btn.removeClass("processing").attr("disabled", false);
          $btn.html(
            `<i class="material-icons">library_add</i><span>Add to Library</span>`,
          );
        }
      },
    );

    // Stop/Start generation toggle
    $(".stopresetgeneration").html(`<i class="material-icons">stop_circle</i>`);
    $("#spy-section").on(
      "click" + NS,
      ".library-manager .stopresetgeneration",
      async function () {
        isGenerating = !isGenerating;
        const $btn = $(this);
        if (isGenerating) {
          $btn.attr("title", "Stop generation").html(`<i class="material-icons">stop_circle</i>`);
        } else {
          $btn.attr("title", "Start generation").html(`<i class="material-icons">play_circle</i>`);
        }
        if (openProfile) {
          const { platform, id } = openProfile;
          if (isGenerating) {
            window.electronAPI.startSpy(platform, id);
            // Resume auto-restart only for non-pages mode
            if (openProfile.spyMode !== "pages") {
              startAutoRestartInterval();
            }
            startNoPostsTimeout(); // Resume no-posts timeout
          } else {
            window.electronAPI.stopSpy(platform, id, "user-clicked-stop-button");
            stopAutoRestartInterval(); // Stop auto-restart
            stopNoPostsTimeout(); // Stop no-posts timeout
            $(".spy-pages-progress").addClass("d-none").removeClass("d-flex"); // Hide progress bar
            $("#spy-category-indicator")
              .removeClass("d-flex")
              .addClass("d-none"); // Hide category indicator
            currentSpyCategoryId = null; // Reset spy category
          }
        }
        updateGenerationState();
      },
    );

    // Preview browser button - shows live screenshot updates
    $("#spy-section").on(
      "click" + NS,
      ".library-manager .previewbrowser",
      async function () {
        if (!openProfile) {
          showAlert("error", "No active spy session");
          return;
        }
        startPreviewInterval();
      },
    );

    // Close preview modal
    $("#spy-section").on(
      "click" + NS,
      "#browser-preview-modal .close-preview",
      function () {
        stopPreviewInterval();
      },
    );

    // Close preview on overlay click
    $("#spy-section").on("click" + NS, "#browser-preview-modal", function (e) {
      if (e.target === this) {
        stopPreviewInterval();
      }
    });

    // Close preview on Escape key
    $(document).on("keydown" + NS, function (e) {
      if (e.key === "Escape" && $("#browser-preview-modal").is(":visible")) {
        stopPreviewInterval();
      }
    });

    // Restart generation button - stops and restarts after 2 seconds
    $("#spy-section").on(
      "click" + NS,
      ".library-manager .restartgeneration",
      async function () {
        if (!openProfile) return;

        const $btn = $(this);
        const $stopBtn = $(".stopresetgeneration");

        // Prevent multiple clicks
        if ($btn.hasClass("processing")) return;
        $btn.addClass("processing").attr("disabled", true);
        $btn.html(`<div class="spinner-border spinner-border-sm"></div>`);

        const { platform, id } = openProfile;

        // Stop generation
        isGenerating = false;
        window.electronAPI.stopSpy(platform, id, "user-clicked-restart-button");
        $stopBtn
          
          .attr("title", "Start generation")
          .html(`<i class="material-icons">play_circle</i>`);
        updateGenerationState();

        // Wait 2 seconds then restart
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Restart generation (using restartSpy to preserve filters including scrollSpeed)
        isGenerating = true;
        window.electronAPI.restartSpy(platform, id);
        $stopBtn
          
          .attr("title", "Stop generation")
          .html(`<i class="material-icons">stop_circle</i>`);
        updateGenerationState();

        // Restore button state
        $btn.removeClass("processing").attr("disabled", false);
        $btn.html(`<i class="material-icons">restart_alt</i>`);

        showAlert("success", "Generation restarted successfully");
      },
    );

    // Close library manager
    $("#spy-section").on(
      "click" + NS,
      ".library-manager .close",
      async function () {
        $(".library-manager").hide();
        $(".spy-pages-progress").addClass("d-none").removeClass("d-flex"); // Hide progress bar
        $("#spy-category-indicator").removeClass("d-flex").addClass("d-none"); // Hide category indicator
        currentSpyCategoryId = null; // Reset spy category
        stopAutoRestartInterval(); // Stop auto-restart when closing
        stopPreviewInterval(); // Stop preview when closing
        stopNoPostsTimeout(); // Stop no-posts timeout when closing
        
        // Stop spy if profile is active
        if (openProfile) {
          const { platform, id } = openProfile;
          await window.electronAPI.stopSpy(platform, id, "user-closed-library-manager");
          
          // Also stop the spyManager session
          if (window.spyManager) {
            await window.spyManager.stopSession(id);
            updateSessionSwitcherUI();
          }
          
          isGenerating = false;
          openProfile = null; // Clear openProfile to prevent issues on next spy
          $(".stopresetgeneration")
            
            .attr("title", "Stop generation")
            .html(`<i class="material-icons">stop_circle</i>`);
          updateGenerationState();
        } else if (window.pendingSpyProfile) {
          // Spy was still starting - stop it
          const { platform, id } = window.pendingSpyProfile;
          await window.electronAPI.stopSpy(platform, id, "user-closed-library-manager-pending");
          
          if (window.spyManager) {
            await window.spyManager.stopSession(id);
            updateSessionSwitcherUI();
          }
          
          window.pendingSpyProfile = null;
          isGenerating = false;
          updateGenerationState();
        }
        
        // Hide floating indicator if no more sessions
        if (window.spyManager && !window.spyManager.hasActiveSessions()) {
          $('#spy-floating-indicator').removeClass('visible expanded');
        }
      },
    );

    // Minimize library manager (keep spy running in background)
    $("#spy-section").on(
      "click" + NS,
      ".library-manager .minimize",
      async function () {
        // Check if library manager is visible
        if (!$(".library-manager").is(":visible")) {
          showAlert("info", "No active spy session to minimize");
          return;
        }

        // Determine the profile info - check multiple sources
        let profileId, platform, spyMode;
        
        if (openProfile) {
          // Spy is fully started
          profileId = openProfile.id;
          platform = openProfile.platform;
          spyMode = openProfile.spyMode;
        } else if (window.currentStartingSpyInfo) {
          // Spy is starting - use stored info
          profileId = window.currentStartingSpyInfo.id;
          platform = window.currentStartingSpyInfo.platform;
          spyMode = window.currentStartingSpyInfo.spyMode || 'feed';
        } else if (window.pendingSpyProfile) {
          // Fallback to pendingSpyProfile
          profileId = window.pendingSpyProfile.id;
          platform = window.pendingSpyProfile.platform;
          spyMode = 'feed';
        } else {
          // No spy info available
          showAlert("info", "No active spy session to minimize");
          return;
        }

        // Register session with global spyManager if not already
        // Get profile name from spyProfiles data to avoid showing "Unknown"
        const spyProfilesData = await getCachedKey('spyProfiles') || {};
        const profileName = spyProfilesData[profileId]?.name || 'Unknown Profile';
        
        if (!window.spyManager.sessions.has(profileId)) {
          await window.spyManager.startSession(
            profileId,
            platform,
            getCurrentFilters(),
            spyMode,
            profileName
          );
        } else {
          // Update profile name if session exists but has "Unknown"
          const existingSession = window.spyManager.sessions.get(profileId);
          if (existingSession && (!existingSession.profileName || existingSession.profileName === 'Unknown')) {
            existingSession.profileName = profileName;
          }
        }
        
        // Update session state - handle type mismatch for profileId
        let session = window.spyManager.sessions.get(profileId);
        if (!session && typeof profileId === 'number') {
          session = window.spyManager.sessions.get(String(profileId));
        }
        if (!session && typeof profileId === 'string') {
          session = window.spyManager.sessions.get(Number(profileId));
        }
        
        if (session) {
          session.isGenerating = isGenerating;
          session.isStarting = !openProfile; // Still starting if openProfile not set
          
          // Preserve pages progress from current UI state when re-minimizing
          if (spyMode === 'pages') {
            const $progressContainer = $(".spy-pages-progress");
            const currentPage = parseInt($progressContainer.find(".current-page").text()) || session.currentPage;
            const totalPages = parseInt($progressContainer.find(".total-pages").text()) || session.totalPages;
            const currentPageUrl = $progressContainer.find(".current-page-name").attr("title") || session.currentPageUrl;
            
            if (currentPage && totalPages) {
              session.currentPage = currentPage;
              session.totalPages = totalPages;
              if (currentPageUrl) session.currentPageUrl = currentPageUrl;
            }
          }
        }

        // Update post count in spyManager
        window.spyManager.updatePostCount(profileId, generatedPostsCount, rawPostsCount);

        // Set minimized state and force UI update
        window.spyManager.isMinimized = true;
        window.spyManager._updateFloatingIndicator();

        // Hide the library manager UI but keep everything running
        $(".library-manager").hide();

        // Stop preview interval (not needed when minimized)
        stopPreviewInterval();
      },
    );

    // Library controls: pagination + filters
    $("#library-show").on("click" + NS, "#pagination a", function (e) {
      e.preventDefault();
      const page = parseInt($(this).attr("href").slice(1), 10);
      if (!Number.isNaN(page)) {
        currentLibraryPage = page;
        // force rerender by invalidating last sig
        lastLibraryPageSig = "";
        renderLibraryPosts();
      }
    });

    $("#library-show").on("change" + NS, "#filter-type, #sort-by", function () {
      currentLibraryPage = 1;
      lastLibraryPageSig = "";
      cardCacheLib.clear();
      $("#library-show .posts-container").empty();
      renderLibraryPosts();
    });

    // Temp posts sort dropdown
    $(".library-manager").on("change" + NS, "#temp-sort-by", function () {
      lastSpyPostsIdsHash = "";
      cardCacheTemp.clear();
      $(".library-manager .posts-container").empty();
      renderTempPosts();
    });

    // Hide used posts toggle
    $("#library-show").on("change" + NS, "#hide-used-posts", function () {
      currentLibraryPage = 1;
      lastLibraryPageSig = "";
      renderLibraryPosts();
    });

    $("#library-show").on(
      "input" + NS,
      "#search-message",
      throttle(function () {
        currentLibraryPage = 1;
        lastLibraryPageSig = "";
        renderLibraryPosts();
      }, 250),
    );

    // Individual post delete
    $("#library-show").on(
      "click" + NS,
      '[data-role="deletePost"]',
      async function () {
        const postId = $(this).attr("data-id");
        const confirmed = await confirmPrompt(
          "Are you sure you want to delete this post?",
        );
        if (!confirmed) return;

        try {
          const postsLibrary =
            (await window.electronAPI.readKey("postsLibrary")) || [];
          const updatedLibrary = postsLibrary.filter(
            (post) => post.postId !== postId,
          );
          await window.electronAPI.updateData("postsLibrary", updatedLibrary);

          // Remove from UI immediately for snappy UX
          $(this).closest(".post-element").remove();
          cardCacheLib.delete(postId);

          showAlert("success", "Post deleted successfully");
        } catch (error) {
          showAlert("error", "Failed to delete post");
          console.error("Delete post error:", error);
        }
      },
    );

    // Change category for a single post
    $("#library-show").on(
      "click" + NS,
      '[data-role="changeCategory"]',
      async function () {
        const postId = $(this).attr("data-id");
        const $postElement = $(this).closest(".post-element");

        // Show category modal for changing category
        const result = await showChangeCategoryModal(postId);

        // If user closed modal without selection, do nothing
        if (result === null) return;

        const categoryId = result.categoryId;

        try {
          const updateResult = await window.electronAPI.updatePostCategory(
            postId,
            categoryId || null,
          );
          if (updateResult.success) {
            // Refresh the category cache and re-render
            categoriesCache = null;
            await loadCategories();
            await populateCategoryDropdown();

            // Update the category badge on the post
            const categoryInfo = categoryId
              ? categoriesCache.find((c) => c.id === categoryId)
              : null;
            const $existingBadge = $postElement.find(".category-badge");

            if (categoryInfo) {
              const catIcon = categoryInfo.image
                ? `<img src="${categoryInfo.image}" alt="">`
                : `<i class="material-icons">folder</i>`;
              const newBadge = `<div class="category-badge" title="Category: ${categoryInfo.name}">${catIcon}<span>${categoryInfo.name}</span></div>`;

              if ($existingBadge.length) {
                $existingBadge.replaceWith(newBadge);
              } else {
                $postElement.prepend(newBadge);
              }
            } else {
              $existingBadge.remove();
            }

            showAlert("success", "Category updated successfully");
          } else {
            showAlert(
              "error",
              updateResult.error || "Failed to update category",
            );
          }
        } catch (error) {
          console.error("Change category error:", error);
          showAlert("error", "Failed to update category");
        }
      },
    );

    // Manage Categories button - open modal to create/manage categories
    $("#library-show").on(
      "click" + NS,
      "#manage-categories-btn",
      async function () {
        const $modal = $("#category-select-modal");
        const $title = $("#category-modal-title");

        $title.text("Manage Categories");

        // Hide the skip button since we're just managing, not selecting
        $(".skip-category-option").hide();

        // Switch to manage tab
        $(".category-tab").removeClass("active");
        $('.category-tab[data-tab="manage"]').addClass("active");
        $(".category-tab-content").removeClass("active");
        $('.category-tab-content[data-content="manage"]').addClass("active");

        // Reset form and populate
        resetCategoryForm();
        await renderCategoryList();
        await renderCategoryManageList();
        await renderFlagPicker();

        $modal.fadeIn(200);

        // Set up a close handler without returning a promise
        categoryModalResolve = null;
        categoryModalPostsToAdd = [];
      },
    );

    // Select all checkbox handler
    $("#library-show").on("change" + NS, "#select-all-posts", function () {
      const checked = $(this).is(":checked");
      $(".post-checkbox").prop("checked", checked);
      updateDeleteButtonState();
    });

    // Individual checkbox handler
    $("#library-show").on("change" + NS, ".post-checkbox", function () {
      updateDeleteButtonState();

      // Update select-all checkbox state
      const totalCheckboxes = $(".post-checkbox").length;
      const checkedCheckboxes = $(".post-checkbox:checked").length;
      const selectAllCheckbox = $("#select-all-posts");

      if (checkedCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === totalCheckboxes) {
        selectAllCheckbox.prop("checked", true).prop("indeterminate", false);
      } else {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", true);
      }
    });

    // Bulk delete handler
    $("#library-show").on("click" + NS, "#delete-selected", async function () {
      const selectedIds = $(".post-checkbox:checked")
        .map(function () {
          return $(this).attr("data-id");
        })
        .get();

      if (selectedIds.length === 0) return;

      const confirmed = await confirmPrompt(
        `Are you sure you want to delete ${selectedIds.length} selected post${selectedIds.length > 1 ? "s" : ""}?`,
      );
      if (!confirmed) return;

      try {
        const postsLibrary =
          (await window.electronAPI.readKey("postsLibrary")) || [];
        const updatedLibrary = postsLibrary.filter(
          (post) => !selectedIds.includes(post.postId),
        );
        await window.electronAPI.updateData("postsLibrary", updatedLibrary);

        // Remove from UI immediately for snappy UX
        selectedIds.forEach((id) => {
          $(`.post-element[data-id="${id}"]`).remove();
          cardCacheLib.delete(id);
        });

        // Recalculate duplicate status for remaining posts
        const remainingPosts = updatedLibrary;
        const imageCountMap = new Map();
        for (const p of remainingPosts) {
          const imgKey = p.postImg || "";
          if (imgKey) {
            imageCountMap.set(imgKey, (imageCountMap.get(imgKey) || 0) + 1);
          }
        }
        // Update duplicate badges on remaining visible posts
        $(".post-element").each(function () {
          const $post = $(this);
          const postId = $post.attr("data-id");
          const post = remainingPosts.find((p) => p.postId === postId);
          if (post) {
            const imgKey = post.postImg || "";
            const isDuplicate = imgKey && (imageCountMap.get(imgKey) || 0) > 1;
            const $badge = $post.find(".duplicate-badge");
            if (isDuplicate && $badge.length === 0) {
              // Add badge if now duplicate (shouldn't happen after delete, but just in case)
              $post
                .find(".post-badges")
                .append(
                  '<span class="duplicate-badge"><i class="material-icons">content_copy</i>Duplicate</span>',
                );
              $post.addClass("has-duplicate");
            } else if (!isDuplicate && $badge.length > 0) {
              // Remove badge if no longer duplicate
              $badge.remove();
              $post.removeClass("has-duplicate");
            }
            // Invalidate cache for this post so it re-renders correctly on next full render
            cardCacheLib.delete(postId);
          }
        });

        // Reset selection state
        $("#select-all-posts")
          .prop("checked", false)
          .prop("indeterminate", false);
        updateDeleteButtonState();

        showAlert(
          "success",
          `${selectedIds.length} post${selectedIds.length > 1 ? "s" : ""} deleted successfully`,
        );
      } catch (error) {
        showAlert("error", "Failed to delete selected posts");
        console.error("Bulk delete error:", error);
      }
    });

    // Delete All Used Posts handler
    $("#library-show").on("click" + NS, "#delete-all-used", async function () {
      try {
        const postsLibrary =
          (await window.electronAPI.readKey("postsLibrary")) || [];
        const usedPosts = postsLibrary.filter((post) => post.usedAt);

        if (usedPosts.length === 0) {
          showAlert("info", "No used posts found to delete");
          return;
        }

        const confirmed = await confirmPrompt(
          `Are you sure you want to delete ${usedPosts.length} used post${usedPosts.length > 1 ? "s" : ""}? This action cannot be undone.`,
        );
        if (!confirmed) return;

        const usedIds = usedPosts.map((p) => p.postId);
        const updatedLibrary = postsLibrary.filter((post) => !post.usedAt);
        await window.electronAPI.updateData("postsLibrary", updatedLibrary);

        // Remove from UI immediately for snappy UX
        usedIds.forEach((id) => {
          $(`.post-element[data-id="${id}"]`).remove();
          cardCacheLib.delete(id);
        });

        // Recalculate duplicate status for remaining posts
        const imageCountMap = new Map();
        for (const p of updatedLibrary) {
          const imgKey = p.postImg || "";
          if (imgKey) {
            imageCountMap.set(imgKey, (imageCountMap.get(imgKey) || 0) + 1);
          }
        }
        // Update duplicate badges on remaining visible posts
        $(".post-element").each(function () {
          const $post = $(this);
          const postId = $post.attr("data-id");
          const post = updatedLibrary.find((p) => p.postId === postId);
          if (post) {
            const imgKey = post.postImg || "";
            const isDuplicate = imgKey && (imageCountMap.get(imgKey) || 0) > 1;
            const $badge = $post.find(".duplicate-badge");
            if (!isDuplicate && $badge.length > 0) {
              $badge.remove();
              $post.removeClass("has-duplicate");
            }
            cardCacheLib.delete(postId);
          }
        });

        // Reset selection state
        $("#select-all-posts")
          .prop("checked", false)
          .prop("indeterminate", false);
        updateDeleteButtonState();

        // Force re-render to update pagination
        lastLibraryPageSig = null;
        renderLibraryPosts();

        showAlert(
          "success",
          `${usedIds.length} used post${usedIds.length > 1 ? "s" : ""} deleted successfully`,
        );
      } catch (error) {
        showAlert("error", "Failed to delete used posts");
        console.error("Delete all used error:", error);
      }
    });

    // Ban Page handler
    $("#spy-section").on(
      "click" + NS,
      '[data-role="banPage"]',
      async function () {
        const $btn = $(this);
        const pageUrl = $btn.attr("data-page-url");
        const pageName = $btn.attr("data-page-name");
        const pageImage = $btn.attr("data-page-image");
        const platform = $btn.attr("data-platform");

        // Prevent multiple clicks
        if ($btn.hasClass("processing")) return;

        const confirmed = await confirmPrompt(
          `Are you sure you want to ban "${pageName}"? All posts from this page will be hidden from future spy sessions.`,
        );
        if (!confirmed) return;

        // Set processing state
        $btn.addClass("processing").attr("disabled", true);
        const originalHtml = $btn.html();
        $btn.html(
          `<div class="spinner-border spinner-border-sm me-1"></div>Banning...`,
        );

        try {
          const pageData = {
            url: pageUrl,
            name: pageName,
            image: pageImage,
            platform: platform,
          };

          const success = await banPage(pageData);
          if (success) {
            showAlert(
              "success",
              `Page "${pageName}" has been banned successfully`,
            );

            // Force refresh of temp posts to hide banned content immediately
            clearCacheKeys("spyPosts", "bannedPages");
            lastSpyPostsIdsHash = "";
            lastLibraryPageSig = "";

            setTimeout(() => {
              renderTempPosts();
              renderLibraryPosts();
              renderBannedPages();
            }, 100);
          } else {
            showAlert("error", "Failed to ban page");
          }
        } catch (error) {
          showAlert("error", "Failed to ban page");
          console.error("Ban page error:", error);
        } finally {
          // Restore button state
          $btn.removeClass("processing").attr("disabled", false);
          $btn.html(originalHtml);
        }
      },
    );

    // Unban Page handler
    $("#pages-show").on(
      "click" + NS,
      '[data-role="unbanPage"]',
      async function () {
        const pageUrl = $(this).attr("data-page-url");
        const pageName = $(this).closest("tr").find("strong").text();

        const confirmed = await confirmPrompt(
          `Are you sure you want to unban "${pageName}"? Posts from this page will appear in future spy sessions.`,
        );
        if (!confirmed) return;

        try {
          const success = await unbanPage(pageUrl);
          if (success) {
            showAlert(
              "success",
              `Page "${pageName}" has been unbanned successfully`,
            );
            // Force refresh to show changes
            renderBannedPages();
            // Clear cache to force fresh data
            cachedData = null;
          } else {
            showAlert("error", "Failed to unban page");
          }
        } catch (error) {
          showAlert("error", "Failed to unban page");
          console.error("Unban page error:", error);
        }
      },
    );

    // Temp post filters event listeners
    $(".library-manager").on(
      "input" + NS,
      "#min-shares, #min-likes, #min-comments",
      throttle(function () {
        // Force re-render of temp posts when filter values change
        lastSpyPostsIdsHash = "";
        renderTempPosts();
      }, 300),
    );

    // Select First X posts button
    $(".library-manager").on(
      "click" + NS,
      "#select-first-x-btn",
      function () {
        const x = parseInt($("#select-first-x-input").val()) || 0;
        if (x <= 0) return;
        // Uncheck all first, then check first x
        $(".temp-post-checkbox").prop("checked", false);
        $(".temp-post-checkbox").slice(0, x).prop("checked", true);
        updateTempBulkActionsState();
      },
    );

    // Select all temp posts checkbox handler
    $(".library-manager").on(
      "change" + NS,
      "#select-all-temp-posts",
      function () {
        const checked = $(this).is(":checked");
        $(".temp-post-checkbox").prop("checked", checked);
        updateTempBulkActionsState();
      },
    );

    // Individual temp post checkbox handler
    $(".library-manager").on("change" + NS, ".temp-post-checkbox", function () {
      updateTempBulkActionsState();

      // Update select-all checkbox state
      const totalCheckboxes = $(".temp-post-checkbox").length;
      const checkedCheckboxes = $(".temp-post-checkbox:checked").length;
      const selectAllCheckbox = $("#select-all-temp-posts");

      if (totalCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === 0) {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
      } else if (checkedCheckboxes === totalCheckboxes) {
        selectAllCheckbox.prop("checked", true).prop("indeterminate", false);
      } else {
        selectAllCheckbox.prop("checked", false).prop("indeterminate", true);
      }
    });

    // Hide single post handler
    $("#spy-section").on(
      "click" + NS,
      '[data-role="hidePost"]',
      async function () {
        const postId = $(this).attr("data-id");
        const $postElement = $(this).closest(".post-element");

        // Get shares from spyPosts for viral growth detection
        const spyPosts = (await getCachedKey("spyPosts")) || [];
        const post = spyPosts.find((p) => p.postId === postId);
        const shares = post?.shares || 0;

        // Hide the post with shares data
        hidePost(postId, shares);

        // Remove from UI with animation
        $postElement.fadeOut(200, function () {
          $(this).remove();
          cardCacheTemp.delete(postId);
        });

        // Update count
        generatedPostsCount = $(".library-manager .post-element").length - 1;
        updateGenerationState();
      },
    );

    // Bulk add to library handler - now with category selection
    $(".library-manager").on(
      "click" + NS,
      "#add-selected-to-library",
      async function () {
        const selectedIds = $(".temp-post-checkbox:checked")
          .map(function () {
            return $(this).attr("data-id");
          })
          .get();

        if (selectedIds.length === 0) return;

        const $btn = $(this);
        const originalHtml = $btn.html();

        // Prevent multiple clicks
        if ($btn.hasClass("processing")) return;

        const spyPosts = await getCachedKey("spyPosts");
        const postsToAdd = (spyPosts || []).filter((p) =>
          selectedIds.includes(p.postId),
        );

        if (postsToAdd.length === 0) {
          showAlert("error", "No posts found");
          return;
        }

        let categoryId = null;

        // If current spy session has a category, auto-assign it
        if (currentSpyCategoryId) {
          categoryId = currentSpyCategoryId;
        } else {
          // Show category selection modal
          const categoryResult = await showCategoryModal(postsToAdd);

          // If modal was closed without selection, do nothing
          if (categoryResult === null) return;

          categoryId = categoryResult.categoryId;
        }

        // Set processing state
        $btn.addClass("processing").attr("disabled", true);
        $btn.html(
          `<div class="spinner-border spinner-border-sm me-1"></div>Adding ${selectedIds.length} posts...`,
        );

        try {
          const { successCount, failCount } =
            await addPostsToLibraryWithCategory(postsToAdd, categoryId);

          // Show result
          if (successCount > 0) {
            showAlert(
              "success",
              `${successCount} post${successCount > 1 ? "s" : ""} added to library successfully!`,
            );
          }
          if (failCount > 0) {
            showAlert(
              "warning",
              `${failCount} post${failCount > 1 ? "s" : ""} failed to add`,
            );
          }

          // Reset selection state
          $("#select-all-temp-posts")
            .prop("checked", false)
            .prop("indeterminate", false);
          updateTempBulkActionsState();

          // Force re-render
          setTimeout(() => {
            renderTempPosts();
            renderLibraryPosts();
          }, 250);
        } catch (error) {
          console.error("Bulk add to library error:", error);
          showAlert("error", "An unexpected error occurred. Please try again.");
        } finally {
          // Restore button state
          $btn.removeClass("processing").attr("disabled", false);
          $btn.html(originalHtml);
        }
      },
    );

    // Bulk hide posts handler
    $(".library-manager").on(
      "click" + NS,
      "#hide-selected-posts",
      async function () {
        const selectedIds = $(".temp-post-checkbox:checked")
          .map(function () {
            return $(this).attr("data-id");
          })
          .get();

        if (selectedIds.length === 0) return;

        const confirmed = await confirmPrompt(
          `Are you sure you want to hide ${selectedIds.length} selected post${selectedIds.length > 1 ? "s" : ""}?`,
        );
        if (!confirmed) return;

        try {
          // Get spyPosts to retrieve shares for viral growth detection
          const spyPosts = (await getCachedKey("spyPosts")) || [];
          const sharesMap = {};
          for (const post of spyPosts) {
            if (post.postId && selectedIds.includes(post.postId)) {
              sharesMap[post.postId] = post.shares || 0;
            }
          }

          // Hide all selected posts with promises to track completion
          const fadePromises = selectedIds.map((id) => {
            hidePost(id, sharesMap[id] || 0);
            return new Promise((resolve) => {
              $(`.post-element[data-id="${id}"]`).fadeOut(200, function () {
                $(this).remove();
                cardCacheTemp.delete(id);
                resolve();
              });
            });
          });

          // Wait for all animations to complete
          await Promise.all(fadePromises);

          // Reset selection state after posts are removed
          $("#select-all-temp-posts")
            .prop("checked", false)
            .prop("indeterminate", false);
          updateTempBulkActionsState();

          // Update count
          generatedPostsCount = $(".library-manager .post-element").length;
          updateGenerationState();

          showAlert(
            "success",
            `${selectedIds.length} post${selectedIds.length > 1 ? "s" : ""} hidden successfully`,
          );
        } catch (error) {
          showAlert("error", "Failed to hide selected posts");
          console.error("Bulk hide error:", error);
        }
      },
    );

    // ---- Followed Pages Event Handlers ----

    // Add followed page from URL input
    $("#followed-pages-show").on(
      "click" + NS,
      "#add-followed-page",
      async function () {
        const $input = $("#add-page-url");
        const rawUrl = $input.val().trim();

        if (!rawUrl) {
          showAlert("error", "Please enter a Facebook page URL");
          return;
        }

        const normalizedUrl = normalizePageUrl(rawUrl);
        if (!normalizedUrl) {
          showAlert("error", "Please enter a valid Facebook page URL");
          return;
        }

        const $btn = $(this);
        const originalHtml = $btn.html();
        $btn.addClass("processing").attr("disabled", true);
        $btn.html(
          `<div class="spinner-border spinner-border-sm me-1"></div>Adding...`,
        );

        try {
          // Check if already followed
          const followedPages = (await getCachedKey("followedPages")) || {};
          if (followedPages[normalizedUrl]) {
            showAlert(
              "info",
              "This page is already in your followed pages list",
            );
            return;
          }

          const pageData = {
            url: normalizedUrl,
            name: extractPageNameFromUrl(normalizedUrl),
            platform: "facebook",
            categoryId: $("#add-page-category").val() || null,
          };

          // Try to fetch profile picture for this page
          try {
            const imgResult = await window.electronAPI.fetchPageProfileImage(normalizedUrl);
            if (imgResult.success && imgResult.filePath) {
              pageData.image = imgResult.filePath;
            }
          } catch (imgErr) {
            console.warn("Could not fetch profile image for page:", imgErr);
          }

          const success = await addFollowedPage(pageData);
          if (success) {
            showAlert(
              "success",
              `Page "${pageData.name}" added to followed pages`,
            );
            $input.val("");
            $("#add-page-category").val(""); // Reset category selection
            renderFollowedPages();
          } else {
            showAlert("error", "Failed to add page");
          }
        } catch (error) {
          showAlert("error", "Failed to add page");
          console.error("Add followed page error:", error);
        } finally {
          $btn.removeClass("processing").attr("disabled", false);
          $btn.html(originalHtml);
        }
      },
    );

    // Handle enter key in URL input
    $("#followed-pages-show").on(
      "keypress" + NS,
      "#add-page-url",
      function (e) {
        if (e.which === 13) {
          e.preventDefault();
          $("#add-followed-page").click();
        }
      },
    );

    // Remove followed page handler
    $("#followed-pages-show").on(
      "click" + NS,
      '[data-role="removeFollowedPage"]',
      async function () {
        const pageUrl = $(this).attr("data-page-url");
        const pageName = $(this).closest("tr").find("strong").text();

        const confirmed = await confirmPrompt(
          `Are you sure you want to remove "${pageName}" from your followed pages?`,
        );
        if (!confirmed) return;

        try {
          const success = await removeFollowedPage(pageUrl);
          if (success) {
            showAlert(
              "success",
              `Page "${pageName}" removed from followed pages`,
            );
            renderFollowedPages();
          } else {
            showAlert("error", "Failed to remove page");
          }
        } catch (error) {
          showAlert("error", "Failed to remove page");
          console.error("Remove followed page error:", error);
        }
      },
    );

    // Change page category handler
    $("#followed-pages-show").on(
      "click" + NS,
      '[data-role="changePageCategory"]',
      async function () {
        const pageUrl = $(this).attr("data-page-url");
        const $row = $(this).closest("tr");
        const pageName = $row.find("strong").text();

        // Show category modal (reuse the existing one)
        const categoryResult = await showChangeCategoryModal(pageUrl);

        // If modal was closed without selection, do nothing
        if (categoryResult === null) return;

        try {
          // Update the page's category
          const followedPages = (await getCachedKey("followedPages")) || {};
          if (followedPages[pageUrl]) {
            followedPages[pageUrl].categoryId =
              categoryResult.categoryId || null;
            await window.electronAPI.updateData("followedPages", followedPages);
            clearCacheKey("followedPages");

            showAlert("success", `Category updated for "${pageName}"`);
            renderFollowedPages();
          } else {
            showAlert("error", "Page not found");
          }
        } catch (error) {
          showAlert("error", "Failed to update category");
          console.error("Change page category error:", error);
        }
      },
    );

    // Select all followed pages checkbox handler
    $("#followed-pages-show").on(
      "change" + NS,
      "#select-all-followed-pages",
      function () {
        const checked = $(this).is(":checked");
        $(".followed-page-checkbox").prop("checked", checked);
        updateFollowedPagesBulkActionsState();
      },
    );

    // Individual followed page checkbox handler
    $("#followed-pages-show").on(
      "change" + NS,
      ".followed-page-checkbox",
      function () {
        updateFollowedPagesBulkActionsState();

        const totalCheckboxes = $(".followed-page-checkbox").length;
        const checkedCheckboxes = $(".followed-page-checkbox:checked").length;
        const selectAllCheckbox = $("#select-all-followed-pages");

        if (checkedCheckboxes === 0) {
          selectAllCheckbox.prop("checked", false).prop("indeterminate", false);
        } else if (checkedCheckboxes === totalCheckboxes) {
          selectAllCheckbox.prop("checked", true).prop("indeterminate", false);
        } else {
          selectAllCheckbox.prop("checked", false).prop("indeterminate", true);
        }
      },
    );

    // Bulk delete followed pages handler
    $("#followed-pages-show").on(
      "click" + NS,
      "#bulk-delete-pages",
      async function () {
        const $checked = $(".followed-page-checkbox:checked");
        const count = $checked.length;
        if (count === 0) return;

        const warningMsg = window.I18n?.t("spy.followed_section.bulk_delete_warning", { count }) ||
          `Are you sure you want to remove ${count} followed page${count !== 1 ? "s" : ""}? This action cannot be undone.`;
        const confirmed = await confirmPrompt(warningMsg);
        if (!confirmed) return;

        try {
          const followedPages = (await getCachedKey("followedPages")) || {};
          $checked.each(function () {
            const pageUrl = $(this).attr("data-page-url");
            delete followedPages[pageUrl];
          });
          await window.electronAPI.updateData("followedPages", followedPages);
          clearCacheKey("followedPages");

          const successMsg = window.I18n?.t("spy.followed_section.bulk_delete_success", { count }) ||
            `${count} page${count !== 1 ? "s" : ""} removed from followed pages`;
          showAlert("success", successMsg);
          $("#select-all-followed-pages").prop("checked", false).prop("indeterminate", false);
          updateFollowedPagesBulkActionsState();
          renderFollowedPages();
        } catch (error) {
          showAlert("error", "Failed to remove pages");
          console.error("Bulk delete followed pages error:", error);
        }
      },
    );

    // Bulk change category for followed pages handler
    $("#followed-pages-show").on(
      "click" + NS,
      "#bulk-change-category-pages",
      async function () {
        const $checked = $(".followed-page-checkbox:checked");
        const count = $checked.length;
        if (count === 0) return;

        const categoryResult = await showChangeCategoryModal(null);
        if (categoryResult === null) return;

        try {
          const followedPages = (await getCachedKey("followedPages")) || {};
          let updatedCount = 0;
          $checked.each(function () {
            const pageUrl = $(this).attr("data-page-url");
            if (followedPages[pageUrl]) {
              followedPages[pageUrl].categoryId = categoryResult.categoryId || null;
              updatedCount++;
            }
          });
          await window.electronAPI.updateData("followedPages", followedPages);
          clearCacheKey("followedPages");

          const successMsg = window.I18n?.t("spy.followed_section.bulk_category_success", { count: updatedCount }) ||
            `Category updated for ${updatedCount} page${updatedCount !== 1 ? "s" : ""}`;
          showAlert("success", successMsg);
          $("#select-all-followed-pages").prop("checked", false).prop("indeterminate", false);
          updateFollowedPagesBulkActionsState();
          renderFollowedPages();
        } catch (error) {
          showAlert("error", "Failed to update categories");
          console.error("Bulk change category error:", error);
        }
      },
    );

    // Unfollow page from post card handler
    $("#spy-section").on(
      "click" + NS,
      '[data-role="unfollowPage"]',
      async function () {
        const $btn = $(this);
        const pageUrl = $btn.attr("data-page-url");
        const pageName = $btn.attr("data-page-name");

        // Close dropdown
        $btn.closest(".spy-dropdown-menu").removeClass("open");

        try {
          const success = await removeFollowedPage(pageUrl);
          if (success) {
            showAlert("success", `Page "${pageName}" removed from followed pages`);
            // Force re-render to show Follow button
            lastSpyPostsIdsHash = '';
            clearCacheKey('followedPages');
            cardCacheTemp.clear();
            renderTempPosts();
            renderFollowedPages();
          } else {
            showAlert("error", "Failed to unfollow page");
          }
        } catch (error) {
          showAlert("error", "Failed to unfollow page");
          console.error("Unfollow page error:", error);
        }
      },
    );

    // Follow page from post card handler
    $("#spy-section").on(
      "click" + NS,
      '[data-role="followPage"]',
      async function () {
        const $btn = $(this);
        const pageUrl = $btn.attr("data-page-url");
        const pageName = $btn.attr("data-page-name");
        const pageImage = $btn.attr("data-page-image");
        const platform = $btn.attr("data-platform");

        // Close dropdown
        $btn.closest(".spy-dropdown-menu").removeClass("open");

        // Check if already followed
        const followedPages = (await getCachedKey("followedPages")) || {};
        if (followedPages[pageUrl]) {
          showAlert(
            "info",
            `Page "${pageName}" is already in your followed pages`,
          );
          return;
        }

        const pageData = {
          url: pageUrl,
          name: pageName,
          image: pageImage,
          platform: platform,
        };

        try {
          const success = await addFollowedPage(pageData);
          if (success) {
            showAlert("success", `Page "${pageName}" added to followed pages`);
            // Force re-render to show Unfollow button
            lastSpyPostsIdsHash = '';
            clearCacheKey('followedPages');
            cardCacheTemp.clear();
            renderTempPosts();
            renderFollowedPages();
          } else {
            showAlert("error", "Failed to follow page");
          }
        } catch (error) {
          showAlert("error", "Failed to follow page");
          console.error("Follow page error:", error);
        }
      },
    );

    // ---- Category Modal Event Handlers ----

    // Close category modal
    $(document).on("click" + NS, ".category-modal-close", function (e) {
      e.preventDefault();
      closeCategoryModal(null);
    });

    // Close on overlay click
    $(document).on("click" + NS, "#category-select-modal", function (e) {
      if (e.target === this) {
        closeCategoryModal(null);
      }
    });

    // Tab switching
    $(document).on("click" + NS, ".category-tab", function (e) {
      e.preventDefault();
      const tab = $(this).data("tab");

      $(".category-tab").removeClass("active");
      $(this).addClass("active");

      $(".category-tab-content").removeClass("active");
      $(`.category-tab-content[data-content="${tab}"]`).addClass("active");

      // Render manage list when switching to manage tab
      if (tab === "manage") {
        renderCategoryManageList();
      }
    });

    // Go to create tab button
    $(document).on("click" + NS, "#go-to-create-tab", function (e) {
      e.preventDefault();
      $(".category-tab").removeClass("active");
      $('.category-tab[data-tab="create"]').addClass("active");
      $(".category-tab-content").removeClass("active");
      $('.category-tab-content[data-content="create"]').addClass("active");
    });

    // Select a category
    $(document).on("click" + NS, ".category-item", function (e) {
      e.preventDefault();
      const categoryId = $(this).data("category-id");
      closeCategoryModal({ categoryId });
    });

    // Skip category (no category)
    $(document).on("click" + NS, "#skip-category-btn", function (e) {
      e.preventDefault();
      closeCategoryModal({ categoryId: null });
    });

    // Flag picker selection
    $(document).on("click" + NS, ".flag-picker-item", function (e) {
      e.preventDefault();
      const flagPath = $(this).data("flag-path");

      $(".flag-picker-item").removeClass("selected");
      $(this).addClass("selected");

      $("#new-category-image").val(flagPath);
      $("#selected-icon-preview").html(
        `<img src="${flagPath}" alt="Selected flag">`,
      );
      $("#clear-category-image").show();
    });

    // Upload custom image button
    $(document).on("click" + NS, "#upload-category-image", function (e) {
      e.preventDefault();
      $("#category-image-input").click();
    });

    // Handle file selection for category image
    $(document).on("change" + NS, "#category-image-input", async function (e) {
      const file = this.files[0];
      if (!file) return;

      // Convert to base64 data URL (for simple storage)
      const reader = new FileReader();
      reader.onload = function (e) {
        const dataUrl = e.target.result;

        $(".flag-picker-item").removeClass("selected");
        $("#new-category-image").val(dataUrl);
        $("#selected-icon-preview").html(
          `<img src="${dataUrl}" alt="Custom image">`,
        );
        $("#clear-category-image").show();
      };
      reader.readAsDataURL(file);
    });

    // Clear category image
    $(document).on("click" + NS, "#clear-category-image", function (e) {
      e.preventDefault();
      resetCategoryForm();
    });

    // Create new category
    $(document).on("click" + NS, "#create-category-btn", async function (e) {
      e.preventDefault();

      const name = $("#new-category-name").val().trim();
      if (!name) {
        showAlert("error", "Please enter a category name");
        return;
      }

      const image = $("#new-category-image").val() || null;

      const $btn = $(this);
      $btn
        .prop("disabled", true)
        .html(
          '<div class="spinner-border spinner-border-sm me-1"></div>Creating...',
        );

      try {
        const result = await window.electronAPI.saveLibraryCategory({
          name,
          image,
        });

        if (result.success) {
          showAlert("success", "Category created successfully!");
          categoriesCache = null; // Clear cache
          await populatePageCategoryDropdowns(); // Refresh page category dropdowns
          closeCategoryModal({ categoryId: result.category.id });
        } else {
          showAlert("error", result.error || "Failed to create category");
          $btn
            .prop("disabled", false)
            .html('<i class="material-icons">add</i> Create & Select');
        }
      } catch (err) {
        console.error("Create category error:", err);
        showAlert("error", "Failed to create category");
        $btn
          .prop("disabled", false)
          .html('<i class="material-icons">add</i> Create & Select');
      }
    });

    // Delete category from manage list
    $(document).on(
      "click" + NS,
      ".category-manage-item .delete-btn",
      async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const $item = $(this).closest(".category-manage-item");
        const categoryId = $item.data("category-id");
        const categoryName = $item.find(".category-name").text();

        const confirmed = await confirmPrompt(
          `Are you sure you want to delete the category "${categoryName}"? Posts in this category will become uncategorized.`,
        );
        if (!confirmed) return;

        try {
          const result =
            await window.electronAPI.deleteLibraryCategory(categoryId);

          if (result.success) {
            showAlert("success", "Category deleted");
            categoriesCache = null;
            await renderCategoryManageList();
            await populateCategoryDropdown();
            await populatePageCategoryDropdowns();
            lastLibraryPageSig = ""; // Force re-render
            renderLibraryPosts();
            renderFollowedPages(); // Refresh followed pages category badges
          } else {
            showAlert("error", result.error || "Failed to delete category");
          }
        } catch (err) {
          console.error("Delete category error:", err);
          showAlert("error", "Failed to delete category");
        }
      },
    );

    // Category filter dropdown change
    $(document).on("change" + NS, "#filter-category", function (e) {
      currentLibraryPage = 1;
      lastLibraryPageSig = "";
      cardCacheLib.clear();
      renderLibraryPosts();
    });

    // --- Pages Categories section handlers ---

    // Add category button in the Pages Categories section
    $("#pages-categories-show").on("click" + NS, "#add-category-btn", async function () {
      const $modal = $("#category-select-modal");
      const $title = $("#category-modal-title");

      $title.text(window.I18n?.t("spy.pages_categories_section.add_category") || "Add Category");
      $(".skip-category-option").hide();

      // Switch to create tab
      $(".category-tab").removeClass("active");
      $('.category-tab[data-tab="create"]').addClass("active");
      $(".category-tab-content").removeClass("active");
      $('.category-tab-content[data-content="create"]').addClass("active");

      resetCategoryForm();
      await renderCategoryList();
      await renderCategoryManageList();
      await renderFlagPicker();

      $modal.fadeIn(200);
      categoryModalResolve = async () => {
        await renderPageCategories();
      };
      categoryModalPostsToAdd = [];
    });

    // Edit category from Pages Categories section
    $("#pages-categories-show").on("click" + NS, ".edit-page-category", async function (e) {
      e.preventDefault();
      e.stopPropagation();

      const categoryId = $(this).data("category-id");
      const categories = await loadCategories(true);
      const cat = categories.find((c) => c.id === categoryId);
      if (!cat) return;

      const result = await newPrompt([
        { type: "text", name: window.I18n?.t("spy.pages_categories_section.category_name") || "Category Name", required: true, value: cat.name },
      ]);

      if (!result) return;
      const newName = Object.values(result)[0]?.trim();
      if (!newName) return;

      try {
        const updateResult = await window.electronAPI.saveLibraryCategory({ id: categoryId, name: newName });
        if (updateResult.success) {
          showAlert("success", window.I18n?.t("spy.pages_categories_section.edit_success") || "Category updated");
          categoriesCache = null;
          await renderPageCategories();
          await populateCategoryDropdown();
          await populatePageCategoryDropdowns();
          renderFollowedPages();
        } else {
          showAlert("error", updateResult.error || "Failed to update category");
        }
      } catch (err) {
        console.error("[PageCategories] Edit error:", err);
        showAlert("error", "Failed to update category");
      }
    });

    // Delete category from Pages Categories section
    $("#pages-categories-show").on("click" + NS, ".delete-page-category", async function (e) {
      e.preventDefault();
      e.stopPropagation();

      const categoryId = $(this).data("category-id");
      const categories = await loadCategories(true);
      const cat = categories.find((c) => c.id === categoryId);
      if (!cat) return;

      const confirmed = await confirmPrompt(
        (window.I18n?.t("spy.pages_categories_section.delete_confirm", { name: cat.name }) ||
          `Are you sure you want to delete the category "${cat.name}"? Posts in this category will become uncategorized.`)
      );
      if (!confirmed) return;

      try {
        const result = await window.electronAPI.deleteLibraryCategory(categoryId);
        if (result.success) {
          showAlert("success", window.I18n?.t("spy.pages_categories_section.delete_success") || "Category deleted");
          categoriesCache = null;
          await renderPageCategories();
          await renderCategoryManageList();
          await populateCategoryDropdown();
          await populatePageCategoryDropdowns();
          lastLibraryPageSig = "";
          renderLibraryPosts();
          renderFollowedPages();
        } else {
          showAlert("error", result.error || "Failed to delete category");
        }
      } catch (err) {
        console.error("[PageCategories] Delete error:", err);
        showAlert("error", "Failed to delete category");
      }
    });

    // Kickoff
    renderProfiles();
    renderTempPosts();
    renderLibraryPosts();
    renderBannedPages();
    renderFollowedPages();
    renderPageCategories();
    populateCategoryDropdown();
    populatePageCategoryDropdowns();
    startPoll();

    // Partial cleanup for when navigating away with active sessions (keeps spy running)
    window.spyPartialCleanup = () => {
      console.log('[Spy] Partial cleanup - keeping spy session alive');
      
      // Stop polling (spyManager handles background polling)
      stopPoll();
      
      // Stop frontend-only timers — these belong to this closure and must not
      // survive navigation. They will be restarted when the session is restored.
      stopAutoRestartInterval();
      stopNoPostsTimeout();
      stopPreviewInterval();
      
      // Clear UI event handlers
      $(document).off(NS);
      $("#spy-section").off(NS);
      $("#library-show").off(NS);
      $("#pages-show").off(NS);
      $("#followed-pages-show").off(NS);
      $("#pages-categories-show").off(NS);
      $("body").off(NS);

      // Clear UI caches (will be rebuilt on return)
      profileRowCache.clear();
      cardCacheTemp.clear();
      cardCacheLib.clear();
      cachedData = null;
      lastDataFetch = 0;
      categoriesCache = null;
      flagsCache = null;
      
      // Clear hash signatures to force re-render on return
      lastProfilesHash = "";
      lastSpyPostsIdsHash = "";
      lastLibraryPageSig = "";
      
      // DO NOT reset isGenerating, openProfile, or stop backend processes
      // Those stay active via spyManager
    };

    // Set cleanup function for this page
    window.currentPageCleanup = () => {
      // Only preserve spy on navigation if it is actively generating.
      // If the user clicked Stop (isGenerating=false), the session stays in spyManager
      // but the backend should NOT survive navigation — full cleanup must run.
      if (window.spyManager && window.spyManager.hasActiveSessions() && isGenerating) {
        // Ensure floating indicator stays visible after navigation
        window.spyManager.isMinimized = true;
        window.spyManager._updateFloatingIndicator();
        window.spyPartialCleanup();
        return;
      }
      
      stopPoll();
      stopAutoRestartInterval(); // Stop auto-restart interval
      stopPreviewInterval(); // Stop preview interval
      stopNoPostsTimeout(); // Stop no-posts timeout
      $(document).off(NS);
      $("#spy-section").off(NS);
      $("#library-show").off(NS);
      $("#pages-show").off(NS);
      $("#followed-pages-show").off(NS);
      $("#pages-categories-show").off(NS);
      $("body").off(NS);

      // Clear caches
      profileRowCache.clear();
      cardCacheTemp.clear();
      cardCacheLib.clear();

      // Clear data cache
      cachedData = null;
      lastDataFetch = 0;

      // Clear category caches
      categoriesCache = null;
      flagsCache = null;
      categoryModalResolve = null;
      categoryModalPostsToAdd = [];

      // Reset state
      isGenerating = false;
      openProfile = null;
      generatedPostsCount = 0;
      rawPostsCount = 0;
      currentLibraryPage = 1;
      lastProfilesHash = "";
      lastSpyPostsIdsHash = "";
      lastLibraryPageSig = "";

      // Clear hidden posts
      hiddenPostIds.clear();

      // Reset selection states
      $("#select-all-posts")
        .prop("checked", false)
        .prop("indeterminate", false);
      $(".post-checkbox").prop("checked", false);
      updateDeleteButtonState();

      $("#select-all-temp-posts")
        .prop("checked", false)
        .prop("indeterminate", false);
      $(".temp-post-checkbox").prop("checked", false);
      updateTempBulkActionsState();
      
      // Clear spyManager sessions if doing full cleanup
      if (window.spyManager) {
        window.spyManager.stopAllSessions();
      }

      console.log("Spy page cleanup completed");
    };

    // ===================== FEEDSPY EVENT HANDLERS =====================
    // Must be inside $(document).ready() because it calls $(document).off(NS) above

    // Show FeedSpy button on page load
    updateFeedSpyButtonVisibility();

    // FeedSpy button click — open dialog
    $(document).on("click" + NS, "#start-feedspy-btn", async function () {
      try {
        // Populate category dropdown
        const result = await window.electronAPI.getLibraryCategories();
        const categories = (result && result.categories) || [];
        const $catFilter = $("#feedspy-category-filter");
        $catFilter.find("option:not(:first)").remove();
        if (categories.length > 0) {
          categories.forEach((cat) => {
            $catFilter.append(`<option value="${cat.id}">${cat.name}</option>`);
          });
        }

        // Populate pages
        await updateFeedSpyPagesSelector();

        // Reset select-all
        $("#feedspy-select-all").prop("checked", true);

        // Show dialog
        $("#feedspy-dialog").css({ display: "flex", opacity: 0 }).animate({ opacity: 1 }, 150);
      } catch (err) {
        console.error("[FeedSpy] Error opening dialog:", err);
        showAlert("error", "Failed to open FeedSpy dialog");
      }
    });

    // FeedSpy category filter change
    $(document).on("change" + NS, "#feedspy-category-filter", function () {
      const categoryId = $(this).val() || null;
      updateFeedSpyPagesSelector(categoryId);
      // Reset select-all to match (all filtered pages are checked by default)
      $("#feedspy-select-all").prop("checked", true);
    });

    // FeedSpy select all toggle
    $(document).on("change" + NS, "#feedspy-select-all", function () {
      const checked = $(this).is(":checked");
      $(".feedspy-page-checkbox").prop("checked", checked);
    });

    // FeedSpy cancel
    $(document).on("click" + NS, "#feedspy-cancel", function () {
      $("#feedspy-dialog").animate({ opacity: 0 }, 150, function() { $(this).css("display", "none"); });
    });

    // FeedSpy start analysis
    $(document).on("click" + NS, "#feedspy-start", async function () {
      const $btn = $(this);

      // Get selected category for filtering and auto-assignment
      const selectedCategoryId = $("#feedspy-category-filter").val() || null;

      // Collect selected pages
      let targetPages = [];
      $(".feedspy-page-checkbox:checked").each(function () {
        targetPages.push($(this).val());
      });

      // Enforce category filter: only include pages that belong to the selected category
      if (selectedCategoryId && targetPages.length > 0) {
        const followedPages = (await getCachedKey("followedPages")) || {};
        targetPages = targetPages.filter(url => {
          const page = followedPages[url];
          return page && String(page.categoryId) === String(selectedCategoryId);
        });
      }

      if (targetPages.length === 0) {
        showAlert("warning", window.I18n?.t("spy.feedspy.no_pages_selected") || "Please select at least one page to analyse.");
        return;
      }

      const postsPerPage = parseInt($("#feedspy-posts-per-page").val()) || 50;
      const filters = {
        minShares: parseInt($("#feedspy-min-shares").val()) || 0,
        minLikes: parseInt($("#feedspy-min-likes").val()) || 0,
        minComments: parseInt($("#feedspy-min-comments").val()) || 0,
        minVirality: parseFloat($("#feedspy-min-virality").val()) || 0,
      };

      // Hide dialog
      $("#feedspy-dialog").animate({ opacity: 0 }, 150, function() { $(this).css("display", "none"); });

      // Set FeedSpy as the active "profile"
      feedspyActive = true;
      openProfile = { platform: "facebook", id: "feedspy", spyMode: "feedspy" };
      isGenerating = true;
      generatedPostsCount = 0;
      rawPostsCount = 0;
      currentSpyCategoryId = selectedCategoryId;

      // Clear old FeedSpy posts from storage
      const existingPosts = (await window.electronAPI.readKey("spyPosts")) || [];
      const nonFeedspyPosts = existingPosts.filter((p) => p.spyProfileId !== "feedspy");
      await window.electronAPI.updateData("spyPosts", nonFeedspyPosts);
      cachedData = null;
      lastDataFetch = 0;

      // Show library manager
      $(".library-manager").fadeIn(200);
      $(".library-manager .posts-container").html("");

      // Update generation state
      const $stateDisplay = $(".libraryGenerationState");
      $stateDisplay.html(`
        <div class="spinner-border spinner-border-sm text-primary me-2"></div>
        <span>${window.I18n?.t("spy.feedspy.running") || "FeedSpy analysing pages..."}</span>
      `);

      // Show progress bar
      $(".spy-pages-progress").removeClass("d-none").addClass("d-flex");
      $(".spy-pages-progress .current-page").text("0");
      $(".spy-pages-progress .total-pages").text(targetPages.length);
      $(".spy-pages-progress .progress-bar").css("width", "0%");

      // Configure stop button for FeedSpy
      const $stopBtn = $(".stopresetgeneration");
      $stopBtn
        .attr("title", "Stop FeedSpy")
        .html('<i class="material-icons">stop_circle</i>')
        .off("click")
        .on("click", async function () {
          await window.electronAPI.stopFeedSpySpy();
          feedspyActive = false;
          isGenerating = false;
          $stateDisplay.html(`
            <i class="material-icons" style="color: #ef4444; font-size: 24px;">cancel</i>
            <span style="color: #ef4444; font-weight: 600;">${window.I18n?.t("spy.feedspy.stopped") || "Analysis stopped"}</span>
          `);
          $(".spy-pages-progress").addClass("d-none").removeClass("d-flex");
        });

      // Start polling for rendered posts
      if (!pollId) {
        pollId = setInterval(() => {
          renderTempPosts();
        }, POLL_MS);
      }

      // Call the FeedSpy IPC to start fetching
      try {
        const result = await window.electronAPI.startFeedSpySpy(targetPages, postsPerPage, filters);
        if (!result.success) {
          const isRateLimit = result.error === "FEEDSPY_RATE_LIMIT";
          const errorMsg = isRateLimit
            ? (window.I18n?.t("spy.feedspy.rate_limit") || "You've hit the FeedSpy rate limit. Please wait a few minutes before trying again.")
            : (result.error || (window.I18n?.t("spy.feedspy.failed") || "FeedSpy analysis failed"));
          showAlert("error", errorMsg);
          feedspyActive = false;
          isGenerating = false;
          $stateDisplay.html(`
            <i class="material-icons" style="color: #ef4444; font-size: 24px;">${isRateLimit ? "timer" : "error"}</i>
            <span style="color: #ef4444; font-weight: 600;">${isRateLimit ? (window.I18n?.t("spy.feedspy.rate_limit_short") || "Rate limit reached — try again later") : (result.error || "Analysis failed")}</span>
          `);
        }
      } catch (err) {
        console.error("[FeedSpy] Start error:", err);
        feedspyActive = false;
        isGenerating = false;
      }
    });

    // Hook into followed pages tab to refresh FeedSpy button visibility
    $(document).on("click" + NS, ".menu-element[for='followed-pages-show']", function () {
      updateFeedSpyButtonVisibility();
    });
  });

  // ===================== FEEDSPY INTEGRATION =====================

  let feedspyActive = false;

  // Check if FeedSpy is connected and show/hide button accordingly
  async function updateFeedSpyButtonVisibility() {
    try {
      // Multi-account: check if any enabled account with session exists
      let accounts = await window.electronAPI.readKey("feedspyAccounts");
      if (accounts && Array.isArray(accounts)) {
        const hasEnabled = accounts.some(a => a.enabled && a.session);
        if (hasEnabled) {
          $("#feedspy-action-row").show();
          return;
        }
      }
      // Backward compat: check old single-account format
      const settings = await window.electronAPI.readKey("feedspySettings");
      if (settings && settings.enabled && settings.session) {
        $("#feedspy-action-row").show();
      } else {
        $("#feedspy-action-row").hide();
      }
    } catch (e) {
      $("#feedspy-action-row").hide();
    }
  }

  // Populate FeedSpy pages selector (reuses followed pages data)
  async function updateFeedSpyPagesSelector(filterCategoryId = null) {
    const followedPages = (await getCachedKey("followedPages")) || {};
    let pages = Object.values(followedPages);
    const $container = $("#feedspy-pages-list");

    if (filterCategoryId) {
      pages = pages.filter((p) => p.categoryId && String(p.categoryId) === String(filterCategoryId));
    }

    if (pages.length === 0) {
      $container.html(
        '<p class="text-muted text-center py-2 mb-0">' +
        (window.I18n?.t("spy.feedspy.no_pages") || "No followed pages yet.") +
        '</p>'
      );
      return;
    }

    const html = pages
      .map((page) => {
        const isLocalImage = page.image && !page.image.startsWith("http");
        const imageSrc = page.image
          ? isLocalImage
            ? imgSrc(page.image, true)
            : page.image
          : `assets/images/icons/${page.platform}-colored.png`;

        return `<label class="target-page-item d-flex align-items-center gap-2 p-2 border-bottom" style="cursor: pointer;">
                <input type="checkbox" class="feedspy-page-checkbox form-check-input" value="${page.url}" checked />
                <img src="${imageSrc}" width="32" height="32" style="border-radius: 50%; object-fit: cover;"
                     onerror="this.src='assets/images/icons/${page.platform}-colored.png';" />
                <div class="flex-fill">
                    <div class="fw-medium">${page.name}</div>
                    <small class="text-muted">${page.url}</small>
                </div>
            </label>`;
      })
      .join("");

    $container.html(html);
  }

})();
