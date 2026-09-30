// Simple hash function for performance optimization
function hash(str) {
  let hash = 0;
  if (str.length === 0) return hash;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

// Global workflow cache - persists across page navigations
// Backend is authoritative for all state - this is just a UI cache
window.workflowCache = window.workflowCache || {
  allWorkflows: {},
  allWorkflowsSummary: [],
  totalWorkflows: 0,
  wfCurrentPage: 0,
  lastUpdated: 0,
};

// ========== Global Mailbox Auto Refresh Manager ==========
// Keeps mailbox inboxes refreshing across the entire app, not just when the
// mailboxes page is visible.
window.mailboxAutoRefreshManager = window.mailboxAutoRefreshManager || {
  _initialized: false,
  _timer: null,
  _running: false,
  _minutes: 5,

  _allowedMinutes(value) {
    return [0, 1, 5, 10, 15, 30, 60].includes(Number(value)) ? Number(value) : 5;
  },

  getMinutes() {
    return this._minutes;
  },

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    if (!window.electronAPI) return;
    try {
      const stored = await window.electronAPI.readKey("mailboxAutoRefreshMinutes");
      this._minutes = stored == null || stored === "" ? 5 : this._allowedMinutes(stored);
      this._schedule();
    } catch (error) {
      console.error("[MailboxAutoRefresh] Failed to load preference:", error);
    }
  },

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  },

  _schedule() {
    this.stop();
    if (this._minutes <= 0) return;
    this._timer = setInterval(() => { this.refreshNow().catch(() => {}); }, this._minutes * 60_000);
  },

  async setMinutes(minutes) {
    this._minutes = this._allowedMinutes(minutes);
    if (window.electronAPI) {
      await window.electronAPI.updateData("mailboxAutoRefreshMinutes", this._minutes);
    }
    this._schedule();
  },

  async refreshNow() {
    if (this._running || this._minutes <= 0) return;
    this._running = true;
    try {
      if (!window.electronAPI) return;
      const allResponse = await window.electronAPI.mailboxesAll();
      const mailboxIds = allResponse?.success ? allResponse.data : [];
      if (!Array.isArray(mailboxIds) || !mailboxIds.length) return;
      const newMessagesByMailbox = {};
      const concurrency = Math.min(6, mailboxIds.length);
      let index = 0;
      const worker = async () => {
        while (index < mailboxIds.length) {
          const mailboxId = mailboxIds[index++];
          try {
            const refreshResponse = await window.electronAPI.mailboxesRefresh(mailboxId, { folderPath: "INBOX" });
            if (refreshResponse?.success) {
              const newMessages = Math.max(0, Number(refreshResponse.data?.newMessages) || 0);
              if (newMessages > 0) {
                const key = String(mailboxId);
                newMessagesByMailbox[key] = (newMessagesByMailbox[key] || 0) + newMessages;
              }
            }
          } catch (error) {
            console.error("[MailboxAutoRefresh] Refresh failed for mailbox", mailboxId, error);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (typeof window.mailboxNotificationManager?.applyRefreshResults === "function") {
        window.mailboxNotificationManager.applyRefreshResults(newMessagesByMailbox);
      }
      if (typeof window.mailboxesRefreshVisible === "function") {
        await window.mailboxesRefreshVisible();
      }
    } finally {
      this._running = false;
    }
  },
};

// ========== Global Mailbox Notification Manager ==========
// Tracks new emails and displays a notification badge on the mailboxes sidebar button
// Shows unread email count only when user is NOT on the mailboxes page
window.mailboxNotificationManager = window.mailboxNotificationManager || {
  _perMailboxCounts: {},
  _notificationCount: 0,
  _currentPageNotified: false,

  async init() {
    this._perMailboxCounts = this._perMailboxCounts || {};
    this._notificationCount = Number(this._notificationCount) || 0;
    this._updateBadgeDisplay();
  },

  applyRefreshResults(newMessagesByMailbox = {}) {
    try {
      if (!newMessagesByMailbox || typeof newMessagesByMailbox !== "object") return;
      for (const [mailboxId, count] of Object.entries(newMessagesByMailbox)) {
        const increment = Math.max(0, Number(count) || 0);
        if (!increment) continue;
        const key = String(mailboxId);
        this._perMailboxCounts[key] = (Number(this._perMailboxCounts[key]) || 0) + increment;
        this._notificationCount += increment;
      }
      this._updateBadgeDisplay();
    } catch (error) {
      console.error("[MailboxNotification] Apply refresh results failed:", error);
    }
  },

  getMailboxCount(mailboxId) {
    return Number(this._perMailboxCounts[String(mailboxId)]) || 0;
  },

  clearMailboxCount(mailboxId) {
    const key = String(mailboxId);
    const current = Number(this._perMailboxCounts[key]) || 0;
    if (!current) return;
    this._notificationCount = Math.max(0, this._notificationCount - current);
    delete this._perMailboxCounts[key];
    this._updateBadgeDisplay();
  },

  _isOnMailboxesPage() {
    try {
      return $(".menu .menu-element.active").attr("href") === "#mailboxes";
    } catch (_) {
      return false;
    }
  },

  async resetOnPageEntry() {
    this._perMailboxCounts = {};
    this._notificationCount = 0;
    this._currentPageNotified = false;
    this._updateBadgeDisplay();
  },

  _updateBadgeDisplay() {
    const $badge = $("#mailboxNotificationBadge");
    if (!$badge) return;
    if (this._isOnMailboxesPage()) {
      $badge.addClass("d-none").text("0");
      return;
    }
    if (this._notificationCount > 0) {
      $badge.text(this._notificationCount).removeClass("d-none");
    } else {
      $badge.addClass("d-none").text("0");
    }
  },
};

// ========== Global FB Groups Manager ==========
// Owns all persistent IPC push listeners for Facebook Groups.
// Keeps the live-log buffer alive and fires page callbacks when the page is loaded.
// Shows a floating indicator when new activity arrives while the user is on another page.
window.fbGroupsManager = window.fbGroupsManager || {
  liveLogEntries: [],  // Persists across page navigations (max 500)
  unreadLogCount: 0,   // Events received while NOT on the fb-groups page
  profileActivity: {}, // profileId → latest activity entry (live "what is it doing now")
  _initialized: false,
  _pageCallbacks: null,

  // Call once at app startup to register persistent IPC listeners
  init() {
    if (this._initialized) return;
    this._initialized = true;
    if (!window.electronAPI) return;

    // Pre-populate from backend's in-memory buffer
    window.electronAPI.fbGroupsGetLiveLogs().then(r => {
      if (r && r.success && Array.isArray(r.data)) {
        this.liveLogEntries = r.data;
      }
    }).catch(() => {});

    if (window.electronAPI.onFbGroupsLiveLog) {
      window.electronAPI.onFbGroupsLiveLog((entry) => {
        this.liveLogEntries.push(entry);
        if (this.liveLogEntries.length > 500) this.liveLogEntries.shift();
        if (this._pageCallbacks && this._pageCallbacks.onLog) {
          this._pageCallbacks.onLog(entry);
        } else if (!(entry && entry.lifecycle)) {
          // Lifecycle logs (scheduler start/stop) fire on every app launch even
          // when FB Groups was never used — don't surface the floating indicator for them.
          this.unreadLogCount++;
          this._updateFloatingIndicator();
        }
      });
    }

    if (window.electronAPI.onFbGroupsViralAlert) {
      window.electronAPI.onFbGroupsViralAlert((data) => {
        if (this._pageCallbacks && this._pageCallbacks.onViralAlert) {
          this._pageCallbacks.onViralAlert(data);
        } else {
          this._pulseFloatingIndicator();
        }
      });
    }

    if (window.electronAPI.onFbGroupsPostSent) {
      window.electronAPI.onFbGroupsPostSent((data) => {
        if (this._pageCallbacks && this._pageCallbacks.onPostSent) {
          this._pageCallbacks.onPostSent(data);
        }
      });
    }

    if (window.electronAPI.onFbGroupsWorkflowCompleted) {
      window.electronAPI.onFbGroupsWorkflowCompleted((data) => {
        if (this._pageCallbacks && this._pageCallbacks.onWorkflowCompleted) {
          this._pageCallbacks.onWorkflowCompleted(data);
        }
      });
    }

    if (window.electronAPI.onFbGroupsProfileActivity) {
      window.electronAPI.onFbGroupsProfileActivity((data) => {
        if (data && data.profileId) this.profileActivity[data.profileId] = data;
        if (this._pageCallbacks && this._pageCallbacks.onProfileActivity) {
          this._pageCallbacks.onProfileActivity(data);
        }
      });
    }

    if (window.electronAPI.onFbGroupsGroupScanned) {
      window.electronAPI.onFbGroupsGroupScanned((data) => {
        if (this._pageCallbacks && this._pageCallbacks.onGroupScanned) {
          this._pageCallbacks.onGroupScanned(data);
        }
      });
    }

    if (window.electronAPI.onFbGroupsProfileScanned) {
      window.electronAPI.onFbGroupsProfileScanned((data) => {
        if (this._pageCallbacks && this._pageCallbacks.onProfileScanned) {
          this._pageCallbacks.onProfileScanned(data);
        }
      });
    }

    if (window.electronAPI.onFbGroupsProfileFlagged) {
      window.electronAPI.onFbGroupsProfileFlagged((data) => {
        if (data && data.profileId) {
          if (data.loggedIn) {
            // Cleared — remove the disconnected state
            delete this.profileActivity[data.profileId];
          } else {
            // Flagged — persist disconnected state across page navigations
            this.profileActivity[data.profileId] = {
              ...(this.profileActivity[data.profileId] || {}),
              profileId: data.profileId,
              status: 'disconnected',
              detail: data.error || 'Session expired',
              timestamp: data.timestamp || new Date().toISOString(),
            };
          }
        }
        if (this._pageCallbacks && this._pageCallbacks.onProfileFlagged) {
          this._pageCallbacks.onProfileFlagged(data);
        }
      });
    }

    if (window.electronAPI.onFbGroupsMonitorsExpired) {
      window.electronAPI.onFbGroupsMonitorsExpired((data) => {
        if (this._pageCallbacks && this._pageCallbacks.onMonitorsExpired) {
          this._pageCallbacks.onMonitorsExpired(data);
        }
      });
    }
  },

  // Called by the fb-groups page when it loads — subscribes page UI callbacks
  setPageCallbacks(callbacks) {
    this._pageCallbacks = callbacks;
    if (callbacks) {
      // Now on the page — clear unread badge and hide indicator
      this.unreadLogCount = 0;
      $('#fbg-floating-indicator').removeClass('visible pulse-anim');
    }
  },

  // Called by the fb-groups page when it unloads
  clearPageCallbacks() {
    this._pageCallbacks = null;
  },

  _updateFloatingIndicator() {
    const $ind = $('#fbg-floating-indicator');
    if (this.unreadLogCount > 0) {
      $ind.addClass('visible');
      $ind.find('.fbg-float-count').text(this.unreadLogCount);
      $ind.toggleClass('above-spy', $('#spy-floating-indicator').hasClass('visible'));
    }
  },

  _pulseFloatingIndicator() {
    this.unreadLogCount++;
    const $ind = $('#fbg-floating-indicator');
    $ind.addClass('visible');
    $ind.find('.fbg-float-count').text(this.unreadLogCount);
    $ind.toggleClass('above-spy', $('#spy-floating-indicator').hasClass('visible'));
    $ind.addClass('pulse-anim');
    setTimeout(() => $ind.removeClass('pulse-anim'), 800);
  }
};

// ========== Global Spy Manager ==========
// Manages spy sessions independently of page lifecycle
// Allows minimizing spy manager and continuing to work in other pages
window.spyManager = window.spyManager || {
  // Active spy sessions: Map of profileId -> session data
  sessions: new Map(),
  
  // Whether the floating indicator is visible (minimized state)
  isMinimized: false,
  
  // Polling interval for background post updates
  _pollInterval: null,
  _pollIntervalMs: 10000,
  
  async canRunMultipleSessions() { return true; },

  // Start a new spy session
  async startSession(profileId, platform, filters = {}, spyMode = 'feed', profileName = 'Unknown') {
    // If session already exists for this profile, just update it
    if (this.sessions.has(profileId)) {
      const existingSession = this.sessions.get(profileId);
      existingSession.filters = filters;
      existingSession.spyMode = spyMode;
      existingSession.isStarting = false; // No longer starting
      existingSession.categoryId = filters.spyCategoryId || null;
      if (profileName && profileName !== 'Unknown') existingSession.profileName = profileName;
      this._updateFloatingIndicator();
      return { success: true };
    }
    
    const session = {
      profileId,
      profileName,
      platform,
      filters,
      spyMode,
      postCount: 0,
      rawPostCount: 0,
      isGenerating: true,
      startedAt: Date.now(),
      autoRestartInterval: null,
      noPostsTimeout: null,
      categoryId: filters.spyCategoryId || null,
      // Pages mode progress tracking
      currentPage: null,
      totalPages: null,
      currentPageUrl: null,
    };
    
    this.sessions.set(profileId, session);
    this._startBackgroundPolling();
    this._updateFloatingIndicator();
    
    return { success: true };
  },
  
  // Stop a spy session
  async stopSession(profileId) {
    const session = this.sessions.get(profileId);
    if (!session) return;
    
    // Clear intervals
    if (session.autoRestartInterval) clearInterval(session.autoRestartInterval);
    if (session.noPostsTimeout) clearTimeout(session.noPostsTimeout);
    
    // Stop backend spy process
    try {
      await window.electronAPI.stopSpy(session.platform, profileId, "spy-manager-stop-session");
    } catch (e) {
      console.error('[SpyManager] Error stopping spy:', e);
    }
    
    this.sessions.delete(profileId);
    this._updateFloatingIndicator();
    
    // Stop polling if no more sessions
    if (this.sessions.size === 0) {
      this._stopBackgroundPolling();
      this.isMinimized = false;
    }
  },
  
  // Stop all sessions
  async stopAllSessions() {
    const profileIds = Array.from(this.sessions.keys());
    for (const id of profileIds) {
      await this.stopSession(id);
    }
  },
  
  // Update post count for a session
  updatePostCount(profileId, count, rawCount = null) {
    // Handle both string and number profileId types
    let session = this.sessions.get(profileId);
    if (!session && typeof profileId === 'number') {
      session = this.sessions.get(String(profileId));
    }
    if (!session && typeof profileId === 'string') {
      session = this.sessions.get(Number(profileId));
    }
    
    if (session) {
      const oldCount = session.postCount;
      session.postCount = count;
      if (rawCount !== null) session.rawPostCount = rawCount;
      
      // Animate badge if count increased
      if (count > oldCount) {
        this._animateNewPost();
      }
      
      this._updateFloatingIndicator();
    }
  },
  
  // Update pages progress for a session (specific pages mode)
  updatePagesProgress(profileId, currentPage, totalPages, currentPageUrl = null) {
    // Handle both string and number profileId types
    let session = this.sessions.get(profileId);
    if (!session && typeof profileId === 'number') {
      session = this.sessions.get(String(profileId));
    }
    if (!session && typeof profileId === 'string') {
      session = this.sessions.get(Number(profileId));
    }
    
    if (session) {
      session.currentPage = currentPage;
      session.totalPages = totalPages;
      if (currentPageUrl) session.currentPageUrl = currentPageUrl;
      this._updateFloatingIndicator();
    } else {
      console.warn('[SpyManager] updatePagesProgress: session not found for profileId:', profileId, 'Available sessions:', Array.from(this.sessions.keys()));
    }
  },
  
  // Get total post count across all sessions
  getTotalPostCount() {
    let total = 0;
    this.sessions.forEach(s => total += s.postCount);
    return total;
  },
  
  // Check if any session is active
  hasActiveSessions() {
    return this.sessions.size > 0;
  },
  
  // Minimize spy manager (show floating icon)
  minimize() {
    this.isMinimized = true;
    this._updateFloatingIndicator();
  },
  
  // Restore from minimized state
  restore(profileId = null) {
    console.log('[SpyManager] restore() called with profileId:', profileId, 'type:', typeof profileId);
    
    // DON'T set isMinimized = false here! Keep it true during navigation
    // so cleanupCurrentPage() skips spy cleanup. The spy page will set it
    // to false after it loads and restores the session.
    
    // Get the session to restore - ensure string comparison
    let session;
    if (profileId) {
      // Try exact match first
      session = this.sessions.get(profileId);
      // If not found and it's a number, try string version
      if (!session && typeof profileId === 'number') {
        session = this.sessions.get(String(profileId));
      }
      // If still not found and it's a string, try number version
      if (!session && typeof profileId === 'string') {
        session = this.sessions.get(Number(profileId));
      }
    } else {
      session = this.sessions.values().next().value;
    }
    
    console.log('[SpyManager] Found session:', session ? session.profileId : 'none');
    
    if (!session) return null;
    
    // Navigate to spy page if not there
    const currentPage = $('.menu .menu-element.active').attr('href');
    if (currentPage !== '#spy') {
      // Set restore session before navigation so spy.js can pick it up on load
      window.spyRestoreSession = session;
      $('.menu .menu-element[href="#spy"]').click();
    } else {
      // Already on spy page - directly restore the UI
      // Safe to set isMinimized = false now since no cleanup will run
      this.isMinimized = false;
      this._updateFloatingIndicator();
      
      if (typeof window.restoreSpySession === 'function') {
        window.restoreSpySession(session);
      } else {
        // Fallback: set the variable and trigger the check
        window.spyRestoreSession = session;
        if (typeof window.checkAndRestoreSpySessionNow === 'function') {
          window.checkAndRestoreSpySessionNow();
        }
      }
    }
    
    return session;
  },
  
  // Start background polling for post updates
  _startBackgroundPolling() {
    if (this._pollInterval) return;
    
    this._pollInterval = setInterval(async () => {
      if (this.sessions.size === 0) return;
      
      try {
        const spyPosts = await window.electronAPI.readKey('spyPosts') || [];
        const postsLibrary = await window.electronAPI.readKey('postsLibrary') || [];
        const bannedPagesRaw = await window.electronAPI.readKey('bannedPages');
        // bannedPages is stored as an OBJECT with URL keys, not an array
        const bannedPagesObj = (bannedPagesRaw && typeof bannedPagesRaw === 'object' && !Array.isArray(bannedPagesRaw)) 
          ? bannedPagesRaw : {};
        
        // Build lookup sets for filtering
        const libraryPostIds = new Set(Array.isArray(postsLibrary) ? postsLibrary.map(p => p.postId) : []);
        
        let anyNewPosts = false;
        
        this.sessions.forEach((session, profileId) => {
          // Filter posts for this profile
          let profilePosts = spyPosts.filter(p => 
            p.spyProfileId === profileId || 
            (!p.spyProfileId && this.sessions.keys().next().value === profileId)
          );
          
          // Remove duplicates within this profile's posts
          const seenIds = new Set();
          profilePosts = profilePosts.filter(p => {
            if (seenIds.has(p.postId)) return false;
            seenIds.add(p.postId);
            return true;
          });
          
          // Apply same filters as spy.js renderTempPosts
          profilePosts = profilePosts.filter(p => {
            // Filter out library duplicates
            if (libraryPostIds.has(p.postId)) return false;
            
            // Filter out banned pages (object lookup, not array)
            if (p.page && p.page.url && bannedPagesObj[p.page.url]) return false;
            
            // Filter out posts with no image (spy.js filterOutVideos does this)
            const img = p.postImg || p.postImage || '';
            if (!img) return false;
            
            // Filter out videos - use same logic as spy.js filterOutVideos
            // Allow local file paths, for remote URLs only allow Facebook CDN images (not videos)
            if (img.startsWith('http')) {
              if (!img.includes('fbcdn.net') || img.includes('/video')) return false;
            }
            
            return true;
          });
          
          // Apply minimum threshold filters from session.filters
          if (session.filters) {
            const minShares = parseInt(session.filters.minShares) || 0;
            const minLikes = parseInt(session.filters.minLikes) || 0;
            const minComments = parseInt(session.filters.minComments) || 0;
            
            if (minShares > 0 || minLikes > 0 || minComments > 0) {
              profilePosts = profilePosts.filter(p => {
                const shares = p.shares || 0;
                const likes = p.reactions || 0;
                const comments = p.comments || 0;
                return shares >= minShares && likes >= minLikes && comments >= minComments;
              });
            }
          }
          
          const filteredCount = profilePosts.length;
          const oldCount = session.postCount;
          
          // Update count with filtered value
          if (filteredCount !== oldCount) {
            session.postCount = filteredCount;
            if (filteredCount > oldCount) {
              anyNewPosts = true;
            }
          }
        });
        
        if (anyNewPosts) {
          this._animateNewPost();
        }
        
        this._updateFloatingIndicator();
      } catch (e) {
        console.error('[SpyManager] Poll error:', e);
      }
    }, this._pollIntervalMs);
  },
  
  // Stop background polling
  _stopBackgroundPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  },
  
  // Update the floating indicator UI
  _updateFloatingIndicator() {
    const $indicator = $('#spy-floating-indicator');
    
    if (this.sessions.size === 0) {
      $indicator.removeClass('visible expanded');
      return;
    }
    
    if (!this.isMinimized) {
      $indicator.removeClass('visible expanded');
      return;
    }
    
    // Show indicator - only expand on initial show, preserve user's collapsed state after
    const wasVisible = $indicator.hasClass('visible');
    $indicator.addClass('visible');
    if (!wasVisible) {
      // First time showing - expand so sessions are visible
      $indicator.addClass('expanded');
    }
    // If already visible, preserve current expanded/collapsed state
    
    // Update session list
    const $list = $indicator.find('.spy-sessions-list');
    $list.empty();
    
    this.sessions.forEach((session, profileId) => {
      const runTime = this._formatRunTime(Date.now() - session.startedAt);
      const platformIcon = this._getPlatformIcon(session.platform);
      const displayName = session.profileName || 'Unknown Profile';
      const isStarting = session.isStarting === true;
      const isCompleted = session.isCompleted === true;
      const loadingClass = isStarting ? ' loading' : (isCompleted ? ' completed' : '');
      const statusText = session.statusText || runTime;
      
      // Determine what to show in the time/status area
      let timeDisplay = runTime;
      if (isStarting) {
        timeDisplay = statusText;
      } else if (isCompleted) {
        timeDisplay = '<span style="color: #22c55e;">Complete</span>';
      }
      
      // Build pages progress display for specific pages mode
      let pagesProgressHtml = '';
      if (session.spyMode === 'pages' && session.currentPage && session.totalPages && !isStarting && !isCompleted) {
        const progressPercent = Math.round((session.currentPage / session.totalPages) * 100);
        pagesProgressHtml = `
          <div class="session-pages-progress">
            <span class="pages-text">${session.currentPage}/${session.totalPages} pages</span>
            <div class="pages-progress-bar">
              <div class="pages-progress-fill" style="width: ${progressPercent}%"></div>
            </div>
          </div>`;
      }
      
      $list.append(`
        <div class="spy-session-item${loadingClass}" data-profile-id="${profileId}">
          <div class="session-platform">${platformIcon}</div>
          <div class="session-info">
            <span class="session-mode">${displayName}</span>
            <span class="session-time">${timeDisplay}</span>
            ${pagesProgressHtml}
          </div>
          ${isStarting ? '<div class="session-loading-spinner"></div>' : (isCompleted ? '<div class="session-complete-icon"><i class="material-icons" style="color: #22c55e; font-size: 20px;">check_circle</i></div>' : `<div class="session-count">${session.postCount}</div>`)}
          ${!isStarting ? `<button class="session-restore-btn" title="Restore">
            <i class="material-icons">open_in_full</i>
          </button>` : ''}
          <button class="session-stop-btn" title="${isStarting ? 'Cancel' : (isCompleted ? 'Dismiss' : 'Stop')}">
            <i class="material-icons">${isStarting ? 'close' : (isCompleted ? 'close' : 'stop')}</i>
          </button>
        </div>
      `);
    });
    
    // Update total count badge
    const total = this.getTotalPostCount();
    $indicator.find('.spy-total-count').text(total);
    
    // Update session count
    const sessionCount = this.sessions.size;
    $indicator.find('.spy-session-count').text(sessionCount > 1 ? `${sessionCount} sessions` : '1 session');
  },
  
  // Animate pulse effect when new post arrives
  _animateNewPost() {
    const $badge = $('#spy-floating-indicator .spy-total-count');
    $badge.addClass('pulse');
    setTimeout(() => $badge.removeClass('pulse'), 600);
  },
  
  // Format run time
  _formatRunTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  },
  
  // Get platform icon HTML
  _getPlatformIcon(platform) {
    const icons = {
      facebook: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1877F2"><path d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z"/></svg>',
      pinterest: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#E60023"><path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.406.042-3.442.218-.936 1.407-5.965 1.407-5.965s-.359-.719-.359-1.781c0-1.669.967-2.914 2.171-2.914 1.024 0 1.518.769 1.518 1.69 0 1.03-.655 2.569-.994 3.995-.283 1.195.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.208 0 1.031.397 2.137.893 2.739a.36.36 0 0 1 .083.344c-.091.379-.293 1.194-.333 1.361-.053.218-.173.265-.4.16-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.608 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>',
    };
    return icons[platform] || `<i class="material-icons" style="font-size: 16px;">visibility</i>`;
  }
};

// ========== Global Theme Manager ==========
// Applies a light/dark theme across all pages by toggling attributes on <html>
// Persists preference in storage.db (key: appTheme) and caches in localStorage to avoid flash.
const VC_THEME_STORAGE_KEY = "appTheme";
const VC_THEME_LOCAL_KEY = "vc.theme";

window.applyTheme = function (theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", normalized);
  document.documentElement.setAttribute("data-bs-theme", normalized);
};

window.initTheme = async function () {
  let theme;

  // Prefer persisted storage value (shared across app sessions)
  try {
    const stored = await window.electronAPI.readKey(VC_THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      theme = stored;
    }
  } catch (e) {
    // ignore
  }

  // Fall back to local cache (used for early render)
  if (!theme) {
    try {
      const cached = localStorage.getItem(VC_THEME_LOCAL_KEY);
      if (cached === "dark" || cached === "light") theme = cached;
    } catch (e) {
      // ignore
    }
  }

  if (!theme) theme = "light";

  window.applyTheme(theme);

  // Keep cache in sync
  try {
    localStorage.setItem(VC_THEME_LOCAL_KEY, theme);
  } catch (e) {
    // ignore
  }
};

window.toggleTheme = async function () {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";

  window.applyTheme(next);

  try {
    localStorage.setItem(VC_THEME_LOCAL_KEY, next);
  } catch (e) {
    // ignore
  }

  try {
    await window.electronAPI.updateData(VC_THEME_STORAGE_KEY, next);
  } catch (e) {
    console.error("[Theme] Failed to persist theme:", e);
  }
};

// ========== Global Template Manager ==========
// Swaps the active design template (color palette / brand identity).
// The default template is built-in via @import in style.css.
// Alternative templates are loaded via a <link id="vc-template-override"> tag.
const VC_TEMPLATE_STORAGE_KEY = "appTemplate";
const VC_TEMPLATE_LOCAL_KEY = "vc.template";
const VC_TEMPLATE_DEFAULT = "default";

// Map of template IDs → CSS file paths (relative to index.html)
const VC_TEMPLATES = {
  default: null, // built-in, no override needed
  ocean: "assets/css/pages/template-ocean.css",
  lux: "assets/css/pages/template-lux.css",
};

window.applyTemplate = function (templateId) {
  const linkEl = document.getElementById("vc-template-override");
  if (!linkEl) return;

  const cssPath = VC_TEMPLATES[templateId];

  if (!cssPath) {
    // Default template — disable override
    linkEl.removeAttribute("href");
    linkEl.setAttribute("disabled", "");
  } else {
    linkEl.removeAttribute("disabled");
    linkEl.setAttribute("href", cssPath);
  }
};

window.initTemplate = async function () {
  let templateId;

  // Prefer persisted storage value
  try {
    const stored = await window.electronAPI.readKey(VC_TEMPLATE_STORAGE_KEY);
    if (stored && VC_TEMPLATES.hasOwnProperty(stored)) {
      templateId = stored;
    }
  } catch (e) {
    // ignore
  }

  // Fall back to local cache
  if (!templateId) {
    try {
      const cached = localStorage.getItem(VC_TEMPLATE_LOCAL_KEY);
      if (cached && VC_TEMPLATES.hasOwnProperty(cached)) templateId = cached;
    } catch (e) {
      // ignore
    }
  }

  if (!templateId) templateId = VC_TEMPLATE_DEFAULT;

  window.applyTemplate(templateId);

  try {
    localStorage.setItem(VC_TEMPLATE_LOCAL_KEY, templateId);
  } catch (e) {
    // ignore
  }
};

window.setTemplate = async function (templateId) {
  if (!VC_TEMPLATES.hasOwnProperty(templateId)) {
    console.error("[Template] Unknown template:", templateId);
    return;
  }

  window.applyTemplate(templateId);

  try {
    localStorage.setItem(VC_TEMPLATE_LOCAL_KEY, templateId);
  } catch (e) {
    // ignore
  }

  try {
    await window.electronAPI.updateData(VC_TEMPLATE_STORAGE_KEY, templateId);
  } catch (e) {
    console.error("[Template] Failed to persist template:", e);
  }
};

$(document).ready(function () {
  // Initialize i18n (load translations)
  window.I18n.init().then(() => {
    // Translate the main shell (sidebar, modals)
    window.I18n.translatePage();
    // Re-initialize sidebar tooltips with translated text
    if (typeof initSidebarTooltips === 'function') {
      initSidebarTooltips();
    }
    // Load user profile after i18n is ready to avoid missing translation warnings
    loadUserProfile();
    // Open the local workspace after translations are ready.
    $(".menu .menu-element[href='#home']").addClass("active");
    $("#pagesContent").load("pages/home.html", function () {
      window.I18n.translatePage(document.getElementById('pagesContent'));
    });
  });

  // Theme (apply early in case storage differs from cached value)
  window.initTheme();

  // Template (load alternative template override if set)
  window.initTemplate();

  // Theme toggle button
  $(document).on("click", "#themeToggleBtn", function (e) {
    e.preventDefault();
    window.toggleTheme();
  });

  // Sidebar dropdown functionality
  initSidebarDropdowns();

  // Sidebar collapse/expand functionality
  initSidebarToggle();

  lightbox.option({
    resizeDuration: 100,
    wrapAround: true,
    disableScrolling: true,
    fadeDuration: 100,
    showImageNumberLabel: false,
  });

  let chooseModals = 0;

  // Load app version
  loadAppVersion();

  initSpyFloatingIndicator();
  window.fbGroupsManager.init();
  initFbGroupsFloatingIndicator();
  window.mailboxAutoRefreshManager.init();
  window.mailboxNotificationManager.init();

  // Debounced navigation function to prevent rapid clicking
  const debouncedNavigation = debounce(async function (page, element) {
    if (window.loadingState.isNavigating) return;

    // Check for unsaved automation changes before navigating away
    if (window.hasUnsavedAutomation) {
      const msg = window.I18n?.t('alerts.confirm_unsaved') || 'You have unsaved changes. Are you sure you want to leave?';
      const confirmed = await confirmPrompt(msg);
      if (!confirmed) return;
      window.hasUnsavedAutomation = false;
    }

    window.loadingState.isNavigating = true;

    try {
      // Comprehensive cleanup before navigation
      cleanupCurrentPage();

      // Update sidebar active state
      updateSidebarActiveState(page);

      // Show loading indicator
      $("#pagesContent").html(
        '<div style="text-align: center; padding: 50px; color: #666;"><div class="spinner-border"></div><br>Loading...</div>',
      );

      // Load page with a slight delay to allow cleanup to complete
      setTimeout(() => {
        $("#pagesContent").load(`pages/${page}.html`, function () {
          // Translate the newly loaded page content
          if (window.I18n && window.I18n.isReady()) {
            window.I18n.translatePage(document.getElementById('pagesContent'));
          }
          window.loadingState.isNavigating = false;
        });
      }, 50);
    } catch (err) {
      console.error("Navigation error:", err);
      window.loadingState.isNavigating = false;
    }
  }, 200);

  $(".menu .menu-element").click(async function (e) {
    e.preventDefault(0);
    var page = $(this).attr("href").slice(1);
    debouncedNavigation(page, this);
  });

  // Bug report button click handler
  $("#bugReportBtn").click(function (e) {
    e.preventDefault();
    $(".menu .menu-element").removeClass("active");
    debouncedNavigation("reports", null);
  });

  $("body").on("click", '.dismissable [data-role="dismiss"]', function (e) {
    e.preventDefault(0);
    $(this).closest(".dismissable").fadeOut();
  });

  window.electronAPI.onStealthBrowserClosed((event, profileName) => {
    $('[data-role="openProfile"][data-id="' + profileName + '"]')
      .removeAttr("disabled")
      .removeClass("disabled");
    
    // Trigger settings data refresh if on settings page
    // This ensures profile status updates are shown immediately
    if (typeof window.refreshSettingsData === 'function') {
      window.refreshSettingsData();
    }
  });

  window.electronAPI.onShowMainAlert((data) => {
    if (data && data.message) {
      const msg = (window.I18n?.t(data.i18nKey) || data.message);
      showAlert(data.type || "warning", msg);
    }
  });

  window.electronAPI.onChooseSplitImages(
    ({
      requestId,
      splitPaths,
      workflowId,
      hasWorkflowPreference,
      pendingCount,
    }) => {
      showSplitChooseModal(
        requestId,
        splitPaths,
        workflowId,
        hasWorkflowPreference,
        pendingCount,
      );
    },
  );

  // Handle auto-resolution of pending selections
  window.electronAPI.onAutoResolvePendingSelections(
    ({ workflowId, requestIds, selectedIndexes }) => {
      console.log(
        `[Auto-resolve] Closing ${requestIds.length} pending modals for workflow ${workflowId}`,
      );

      requestIds.forEach((requestId) => {
        const modal = document.getElementById(`split-modal-${requestId}`);
        if (modal) {
          // Add shimmer effect before closing
          modal.querySelector(".modal-content").classList.add("shimmer-effect");

          setTimeout(() => {
            document.body.removeChild(modal);
            chooseModals--;
            if (window.checkChooseModals) {
              window.checkChooseModals();
            }
          }, 500);
        }
      });

      // Show beautiful auto-selection notification
      showAutoSelectionNotification({
        reason: "workflow-preference",
        count: requestIds.length,
        selectedIndexes,
        workflowId,
      });
    },
  );

  // Handle auto-selection notifications
  window.electronAPI.onShowAutoSelectionNotification(
    ({ workflowId, selectedIndexes, splitPaths, reason }) => {
      showAutoSelectionNotification({
        reason,
        selectedIndexes,
        splitPaths,
        workflowId,
        count: 1,
      });
    },
  );

  // Listen for live update notifications
  window.electronAPI.onUpdateAvailable((updateInfo) => {
    updateInfo = { ...updateInfo, latestVersion: String(updateInfo.latestVersion).replace(/[^0-9.]/g, ''),
      releaseNotes: $('<div>').text(updateInfo.releaseNotes || '').html() };

    if (updateInfo.isMandatory) {
      // Mandatory update - start download immediately
      showMandatoryUpdateModal(updateInfo);
    } else {
      // Optional update - show notification banner
      showUpdateNotificationBanner(updateInfo);
    }
  });

  function showSplitChooseModal(
    requestId,
    splitPaths,
    workflowId,
    hasWorkflowPreference,
    pendingCount = 1,
  ) {
    chooseModals++;
    if (window.checkChooseModals) {
      window.checkChooseModals();
    }

    const modal = document.createElement("div");
    modal.id = `split-modal-${requestId}`;
    modal.className = "enhanced-choose-modal";
    modal.style.display = "flex";

    const dialog = document.createElement("div");
    dialog.className = "modal-content";

    // Build the enhanced modal content with pending count info
    const pendingInfo = pendingCount > 1 ? ` (${pendingCount} pending)` : "";
    const workflowPreferenceSection = workflowId
      ? `
            <div class="workflow-preference-section">
                <label>
                    <input type="checkbox" id="workflow-preference-checkbox" ${hasWorkflowPreference ? "checked disabled" : ""}>
                    <span>${
                      hasWorkflowPreference
                        ? "Automatic selection is enabled for this workflow"
                        : `Make the same choice for all the next workflow posts${pendingInfo}`
                    }</span>
                </label>
                ${hasWorkflowPreference ? '<small style="opacity: 0.8; margin-left: 30px; font-style: italic;">This setting was applied from your previous choice</small>' : ""}
            </div>
        `
      : "";

    dialog.innerHTML = `
            <div class="modal-header">
                <h3><i class="material-icons">auto_awesome</i> Select Images${pendingInfo}</h3>
                <button class="close"><i class="material-icons">close</i></button>
            </div>
            ${workflowPreferenceSection}
            <div class="split-container"></div>
            <button disabled class="confirm-btn"><i class="material-icons">rocket_launch</i> Confirm Selection</button>
        `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    const container = dialog.querySelector(".split-container");
    splitPaths.forEach((imgPath, idx) => {
      const wrapper = document.createElement("label");
      wrapper.style =
        "display:flex; flex-direction:column; align-items:center; flex: calc(50% - 15px) 0 0; margin-bottom: 15px; cursor: pointer;";
      wrapper.className = "chooseLabel";

      const img = document.createElement("img");
      img.src = imgPath;
      Object.assign(img.style, {
        maxWidth: "250px",
        maxHeight: "250px",
        objectFit: "cover",
      });

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.style = "display: none;";
      chk.value = idx;

      wrapper.append(img, chk);
      container.append(wrapper);
    });

    const confirmBtn = dialog.querySelector(".confirm-btn");
    confirmBtn.disabled = false;

    confirmBtn.addEventListener("click", () => {
      let selected = Array.from(
        container.querySelectorAll("input[type=checkbox]:checked"),
      ).map((chk) => Number(chk.value));
      if (selected.length === 0) {
        selected = splitPaths.map((_, i) => i);
      }

      // Get workflow preference setting
      const workflowPreferenceCheckbox = dialog.querySelector(
        "#workflow-preference-checkbox",
      );
      const workflowPreference = workflowPreferenceCheckbox
        ? {
            enabled:
              workflowPreferenceCheckbox.checked &&
              !workflowPreferenceCheckbox.disabled,
            workflowId: workflowId,
          }
        : null;

      window.electronAPI.sendSplitImagesSelected(
        requestId,
        selected,
        workflowPreference,
      );
      document.body.removeChild(modal);
      chooseModals--;
      if (window.checkChooseModals) {
        window.checkChooseModals();
      }
    });

    dialog.querySelector(".close")?.addEventListener("click", () => {
      document.body.removeChild(modal);
      chooseModals--;
      if (window.checkChooseModals) {
        window.checkChooseModals();
      }
    });
  }

  function showAutoSelectionNotification({
    reason,
    selectedIndexes,
    splitPaths,
    workflowId,
    count = 1,
  }) {
    // Remove existing notification if any
    const existing = document.querySelector(".auto-selection-notification");
    if (existing) {
      existing.remove();
    }

    const notification = document.createElement("div");
    notification.className = "auto-selection-notification";

    const reasonText =
      reason === "skip-mode"
        ? `Skip mode enabled - auto-selected all images`
        : `Applied your preference to ${count > 1 ? count + " modals" : "this selection"}`;

    const selectedText = selectedIndexes
      .map((i) => `Image ${i + 1}`)
      .join(", ");

    notification.innerHTML = `
            <div class="notification-header">
                <div class="notification-icon">
                    <i class="material-icons">auto_fix_high</i>
                </div>
                <div>
                    <h4 class="notification-title">Auto-Selection Applied!</h4>
                </div>
            </div>
            <div class="notification-body">
                ${reasonText}<br>
                <strong>Selected:</strong> ${selectedText}
            </div>
            <div class="notification-actions">
                <button class="btn btn-primary" onclick="showOverrideModal('${workflowId}', ${JSON.stringify(selectedIndexes)})">
                    <i class="material-icons" style="font-size:16px;vertical-align:middle">settings</i> Change
                </button>
                <button class="btn btn-secondary" onclick="closeNotification(this)">
                    OK
                </button>
            </div>
        `;

    document.body.appendChild(notification);

    // Auto-hide after 3 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.classList.add("hide");
        setTimeout(() => {
          if (notification.parentNode) {
            notification.remove();
          }
        }, 300);
      }
    }, 3000);
  }

  window.closeNotification = function (button) {
    const notification = button.closest(".auto-selection-notification");
    if (notification) {
      notification.classList.add("hide");
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
        }
      }, 300);
    }
  };

  window.showOverrideModal = function (workflowId, selectedIndexes) {
    // Close notification
    const notification = document.querySelector(".auto-selection-notification");
    if (notification) {
      notification.remove();
    }

    // For now, show an alert - you can enhance this later
    showAlert(
      "info",
      `Override functionality for workflow ${workflowId} - Selected: ${selectedIndexes.join(", ")}`,
    );
  };

  // Show update notification banner for optional updates
  function showUpdateNotificationBanner(updateInfo) {
    // Remove existing update banner if any
    const existing = document.querySelector(".update-notification-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.className = "update-notification-banner";
    banner.innerHTML = `
            <div class="update-banner-content">
                <div class="update-banner-icon">
                    <i class="material-icons">system_update</i>
                </div>
                <div class="update-banner-text">
                    <strong>Update Available!</strong>
                    <span>Version ${updateInfo.latestVersion} is ready to install</span>
                </div>
                <div class="update-banner-actions">
                    <button class="btn-update-now" data-url="${updateInfo.downloadUrl}">
                        <i class="material-icons">download</i> Update Now
                    </button>
                    <button class="btn-update-later">
                        Later
                    </button>
                </div>
            </div>
            <div class="update-progress-container" style="display: none;">
                <div class="update-progress-bar">
                    <div class="update-progress-fill"></div>
                </div>
                <span class="update-progress-text">Starting download...</span>
            </div>
        `;

    // Add styles
    Object.assign(banner.style, {
      position: "fixed",
      top: "45px",
      left: "50%",
      transform: "translateX(-50%) translateY(-100px)",
      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      color: "#fff",
      padding: "0",
      borderRadius: "12px",
      boxShadow: "0 10px 40px rgba(102, 126, 234, 0.4)",
      zIndex: "999998",
      maxWidth: "600px",
      width: "90%",
      overflow: "hidden",
      transition: "transform 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)",
    });

    document.body.appendChild(banner);

    // Animate in
    setTimeout(() => {
      banner.style.transform = "translateX(-50%) translateY(0)";
    }, 100);

    // Handle Update Now button
    banner
      .querySelector(".btn-update-now")
      .addEventListener("click", async function () {
        const downloadUrl = this.dataset.url;
        const actionsDiv = banner.querySelector(".update-banner-actions");
        const progressDiv = banner.querySelector(".update-progress-container");

        actionsDiv.style.display = "none";
        progressDiv.style.display = "block";

        // Listen for progress updates
        window.electronAPI.onUpdateDownloadProgress((data) => {
          banner.querySelector(".update-progress-fill").style.width =
            data.progress + "%";
          banner.querySelector(".update-progress-text").textContent =
            data.status;
        });

        const result =
          await window.electronAPI.downloadAndInstallUpdate(downloadUrl);

        if (!result.success) {
          banner.querySelector(".update-progress-text").textContent =
            "Error: " + result.error;
          banner.querySelector(".update-progress-fill").style.background =
            "#e53e3e";

          setTimeout(() => {
            progressDiv.style.display = "none";
            actionsDiv.style.display = "flex";
          }, 3000);
        }
      });

    // Handle Later button
    banner
      .querySelector(".btn-update-later")
      .addEventListener("click", function () {
        banner.style.transform = "translateX(-50%) translateY(-100px)";
        setTimeout(() => banner.remove(), 500);
      });
  }

  // Show mandatory update modal - starts download immediately
  function showMandatoryUpdateModal(updateInfo) {
    // Remove any existing update elements
    const existing = document.querySelector(".mandatory-update-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "mandatory-update-overlay";
    overlay.innerHTML = `
            <div class="mandatory-update-modal">
                <div class="mandatory-update-icon">
                    <i class="material-icons">security_update</i>
                </div>
                <h2>Required Update</h2>
                <p class="version-info">Version ${updateInfo.latestVersion}</p>
                <p class="update-message">A mandatory update is being installed. Please wait...</p>
                ${updateInfo.releaseNotes ? `<p class="release-notes">${updateInfo.releaseNotes}</p>` : ""}
                <div class="mandatory-progress-container">
                    <div class="mandatory-progress-bar">
                        <div class="mandatory-progress-fill"></div>
                    </div>
                    <span class="mandatory-progress-text">Connecting...</span>
                </div>
            </div>
        `;

    // Add styles
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      background: "rgba(0, 0, 0, 0.85)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "999999",
    });

    document.body.appendChild(overlay);

    // Listen for progress updates
    window.electronAPI.onUpdateDownloadProgress((data) => {
      overlay.querySelector(".mandatory-progress-fill").style.width =
        data.progress + "%";
      overlay.querySelector(".mandatory-progress-text").textContent =
        data.status;
    });

    // Start download immediately
    (async () => {
      const result = await window.electronAPI.downloadAndInstallUpdate(
        updateInfo.downloadUrl,
      );

      if (!result.success) {
        overlay.querySelector(".update-message").textContent =
          "Update failed. Please restart the app to try again.";
        overlay.querySelector(".mandatory-progress-text").textContent =
          "Error: " + result.error;
        overlay.querySelector(".mandatory-progress-fill").style.background =
          "#e53e3e";

        // Add retry button
        const modal = overlay.querySelector(".mandatory-update-modal");
        const retryBtn = document.createElement("button");
        retryBtn.className = "btn-retry-update";
        retryBtn.innerHTML =
          '<i class="material-icons">refresh</i> Retry Update';
        retryBtn.addEventListener("click", () => {
          overlay.remove();
          showMandatoryUpdateModal(updateInfo);
        });
        modal.appendChild(retryBtn);
      }
    })();
  }

  // Make function globally accessible
  window.checkChooseModals = function checkChooseModals() {
    const $alert = $(".chooseModalsAlert");

    if (chooseModals > 0) {
      const message = `${chooseModals} midjourney prompts left`;

      if ($alert.length) {
        $alert.find("span").text(message);
      } else {
        $("body").append(`
                    <div class="chooseModalsAlert">
                        <i class="material-icons">warning</i>
                        <span>${message}</span>
                    </div>
                `);
      }
    } else {
      $alert.remove();
    }
  };

  // Start the interval to check for modals
  setInterval(window.checkChooseModals, 1000);

  $("body").on("click", ".chooseModalsAlert", function (e) {
    e.preventDefault();
    e.stopPropagation();
    console.log("chooseModalsAlert clicked!");

    const modals = $(".choose-modal");
    console.log("Found modals:", modals.length);

    if (modals.length > 0) {
      modals.css("display", "flex");
      console.log("Showing", modals.length, "modals");
    } else {
      console.log("No modals found! chooseModals counter:", chooseModals);
      console.log(
        "This indicates a sync issue between counter and DOM elements",
      );

      // Reset the counter and hide the alert since no modals exist
      chooseModals = 0;
      if (window.checkChooseModals) {
        window.checkChooseModals();
      }

      showAlert(
        "success",
        "The pending prompts have been cleared. The alert will now disappear.",
      );
    }
  });

  $("body").on("click", ".close", function (e) {
    $(".choose-modal").fadeOut(100);
  });

  $("body").on("mousedown", ".chooseLabel", function (e) {
    if ($(this).is(".checked")) {
      $(this).removeClass("checked");
    } else {
      $(this).addClass("checked");
    }
    const confirmBtn = $(this).closest(".choose-modal").find(".confirm-btn");
    confirmBtn.attr("disabled", "");
    $(this)
      .closest(".choose-modal")
      .find(".chooseLabel")
      .each(function () {
        if ($(this).is(".checked")) {
          confirmBtn.removeAttr("disabled");
        }
      });
  });

  let currentCaptchaProfile = null;
  let captchaMinimized = false;

  window.electronAPI.onCaptchaRequired(({ profileId, seed }) => {
    currentCaptchaProfile = profileId;
    $("#captchaProfile").text(profileId);
    $("#captchaSeed").text(seed || "");
    // Always show modal on new captcha (restore if was minimized)
    captchaMinimized = false;
    $("#captchaMinimizedIndicator").hide();
    $("#captchaBanner").css("display", "flex");
  });

  window.electronAPI.onCaptchaCleared(({ profileId }) => {
    if (profileId === currentCaptchaProfile) {
      $("#captchaBanner").hide();
      $("#captchaMinimizedIndicator").hide();
      captchaMinimized = false;
      currentCaptchaProfile = null;
    }
  });

  $("#captchaSolvedBtn").on("click", function () {
    if (!currentCaptchaProfile) return;
    window.electronAPI.markCaptchaSolved(currentCaptchaProfile);
  });

  // Open Discord profile in stealth browser for captcha solving
  $("#captchaOpenDiscordBtn").on("click", function () {
    if (!currentCaptchaProfile) return;
    window.electronAPI.openStealthProfile(currentCaptchaProfile, "https://discord.com/login", null, "discord");
  });

  // Minimize captcha modal
  $("#captchaMinimizeBtn").on("click", function () {
    captchaMinimized = true;
    $("#captchaBanner").hide();
    $("#captchaMinimizedIndicator").css("display", "flex");
  });

  // Restore captcha modal from minimized state
  $("#captchaMinimizedIndicator").on("click", function () {
    captchaMinimized = false;
    $("#captchaMinimizedIndicator").hide();
    $("#captchaBanner").css("display", "flex");
  });

  // ========================================
  // COPYPASTE STATE PERSISTENCE (GLOBAL)
  // ========================================
  // Persists copypaste modal across page navigation so it survives route changes
  window.copypasteState = {
    $element: null,        // Detached jQuery element
    isOpen: false,         // Modal was visible
    isMinimized: false,    // Modal was minimized (indicator shown)
    policyCheckPending: false, // Policy check was running
  };

  // Clicking the minimized copypaste icon restores the modal (only works on workflows page)
  $("#copypasteMinimizedIndicator").on("click", function () {
    $("#copypasteMinimizedIndicator").hide();
    window.copypasteState.isMinimized = false;
    window.copypasteState.isOpen = true;
    $(".workflow-copypaste").css("display", "flex");
  });

  // ========================================
  // GOOGLE ACCOUNT DISCONNECTION HANDLERS
  // ========================================

  let currentGoogleDisconnectedProfile = null;
  let googleDisconnectedQueue = [];
  let googleBrowserOpening = false;
  let googleDisconnectMinimized = false;

  window.electronAPI.onGoogleDisconnected(({ profileId, blockedCount, allBlockedProfiles }) => {
    console.log(`[Google Disconnect] Profile disconnected: ${profileId}, total blocked: ${blockedCount}`);
    
    // Update queue
    googleDisconnectedQueue = allBlockedProfiles || [profileId];
    
    // Show the first profile if not already showing one
    if (!currentGoogleDisconnectedProfile) {
      showGoogleDisconnectedBanner(profileId, blockedCount);
    } else {
      // Update the count display if modal is already showing
      updateGoogleDisconnectedCount(blockedCount);
    }
  });

  window.electronAPI.onGoogleReconnected(({ profileId, blockedCount, nextProfileId }) => {
    console.log(`[Google Disconnect] Profile reconnected: ${profileId}, remaining: ${blockedCount}`);
    
    // If this was the profile being shown, hide or show next
    if (profileId === currentGoogleDisconnectedProfile) {
      if (nextProfileId && blockedCount > 0) {
        // Show next profile that needs attention
        showGoogleDisconnectedBanner(nextProfileId, blockedCount);
      } else {
        // All profiles reconnected, hide the banner
        hideGoogleDisconnectedBanner();
      }
    } else {
      // Update the count display
      updateGoogleDisconnectedCount(blockedCount);
    }
    
    googleBrowserOpening = false;
  });

  function showGoogleDisconnectedBanner(profileId, blockedCount) {
    currentGoogleDisconnectedProfile = profileId;
    $("#googleDisconnectedProfile").text(profileId);
    
    // Show/hide the "more profiles" row
    if (blockedCount > 1) {
      $("#googleDisconnectedCountRow").show();
      $("#googleDisconnectedCount").text(`+${blockedCount - 1}`);
    } else {
      $("#googleDisconnectedCountRow").hide();
    }
    
    // Always restore full modal on new disconnection
    googleDisconnectMinimized = false;
    $("#googleDisconnectedMinimizedIndicator").hide();
    $("#googleDisconnectError").hide();
    $("#googleDisconnectedBanner").css("display", "flex");
    
    // Translate the banner
    if (window.I18n) window.I18n.translatePage();
  }

  function hideGoogleDisconnectedBanner() {
    $("#googleDisconnectedBanner").hide();
    $("#googleDisconnectedMinimizedIndicator").hide();
    googleDisconnectMinimized = false;
    currentGoogleDisconnectedProfile = null;
    googleDisconnectedQueue = [];
    googleBrowserOpening = false;
  }

  function updateGoogleDisconnectedCount(blockedCount) {
    if (blockedCount > 1) {
      $("#googleDisconnectedCountRow").show();
      $("#googleDisconnectedCount").text(`+${blockedCount - 1}`);
    } else {
      $("#googleDisconnectedCountRow").hide();
    }
  }

  // Open browser to reconnect Google account
  $("#openGoogleProfileBtn").on("click", async function () {
    if (!currentGoogleDisconnectedProfile || googleBrowserOpening) return;

    googleBrowserOpening = true;
    // Hide any previous error
    $("#googleDisconnectError").hide();
    $(this).prop("disabled", true).find("span").text(
      window.I18n?.t("google_disconnect.opening") || "Opening..."
    );

    const showOpenBtnError = (msg) => {
      $("#googleDisconnectErrorText").text(msg);
      $("#googleDisconnectError").css("display", "flex");
    };

    const resetOpenBtn = () => {
      $("#openGoogleProfileBtn").prop("disabled", false).find("span").text(
        window.I18n?.t("google_disconnect.open_browser") || "Open Profile Browser"
      );
      googleBrowserOpening = false;
    };

    try {
      const result = await window.electronAPI.openGoogleProfileBrowser(currentGoogleDisconnectedProfile);

      if (result && result.success === false) {
        if (result.needsVCBrowser) {
          showOpenBtnError(
            window.I18n?.t("google_disconnect.error_no_vcbrowser") ||
            "VCBrowser is not installed. Please install it from the Settings page first."
          );
        } else {
          showOpenBtnError(
            (window.I18n?.t("google_disconnect.error_browser_failed") || "Failed to open browser:") +
            " " + (result.error || "Unknown error")
          );
        }
        resetOpenBtn();
        return;
      }

      // Success — re-enable after a short delay to prevent double-clicks
      setTimeout(resetOpenBtn, 3000);
    } catch (err) {
      console.error("[Google Disconnect] Failed to open browser:", err);
      showOpenBtnError(
        (window.I18n?.t("google_disconnect.error_browser_failed") || "Failed to open browser:") +
        " " + (err.message || "Unknown error")
      );
      resetOpenBtn();
    }
  });

  // User confirms they've reconnected
  $("#googleReconnectedBtn").on("click", function () {
    if (!currentGoogleDisconnectedProfile) return;
    window.electronAPI.markGoogleReconnected(currentGoogleDisconnectedProfile);
  });

  // Minimize google disconnect modal
  $("#googleDisconnectMinimizeBtn").on("click", function () {
    googleDisconnectMinimized = true;
    $("#googleDisconnectedBanner").hide();
    $("#googleDisconnectedMinimizedIndicator").css("display", "flex");
  });

  // Restore google disconnect modal from minimized state
  $("#googleDisconnectedMinimizedIndicator").on("click", function () {
    googleDisconnectMinimized = false;
    $("#googleDisconnectedMinimizedIndicator").hide();
    $("#googleDisconnectedBanner").css("display", "flex");
  });

  // ========================================
  // GLOBAL SPY PAGE PROGRESS LISTENER
  // Ensures spy pages progress is tracked regardless of which page is active
  // ========================================
  
  window.electronAPI.onSpyPageProgress((data) => {
    // FeedSpy handles its own progress via spy.js — skip SpyManager routing
    if (data.source === "feedspy") return;

    // Find the active spy session for this progress update
    if (window.spyManager && window.spyManager.hasActiveSessions()) {
      // If data has profileId, use it directly
      if (data.profileId) {
        window.spyManager.updatePagesProgress(
          data.profileId,
          data.currentPage,
          data.totalPages,
          data.currentPageUrl
        );
      } else {
        // Otherwise update all pages-mode sessions (typically just one)
        window.spyManager.sessions.forEach((session, profileId) => {
          if (session.spyMode === 'pages') {
            window.spyManager.updatePagesProgress(
              profileId,
              data.currentPage,
              data.totalPages,
              data.currentPageUrl
            );
          }
        });
      }
    }
  });

  // ========================================
  // GLOBAL WORKFLOW EVENT LISTENERS
  // These ensure workflow status updates are captured regardless of which page is active
  // ========================================

  // Helper to update workflow status in database (global version)
  const globalUpdateWorkflowStatus = async (workflowId, status, progress) => {
    try {
      await window.electronAPI.invoke(
        "update-workflow-status",
        workflowId,
        status,
        progress,
      );
      return true;
    } catch (e) {
      console.error(`[Global] Failed updating workflow ${workflowId}:`, e);
      return false;
    }
  };

  // Global handler for automation logs
  window.electronAPI.automationLogs(async (_, log) => {
    const allWorkflows = window.workflowCache?.allWorkflows;
    if (!allWorkflows) return;

    let wf = allWorkflows[log.workflowId];

    // Safety net: If workflow exists in cache but has no posts (summary-only load),
    // fetch full detail from DB once so incoming logs aren't silently dropped
    if (wf && (!Array.isArray(wf.posts) || wf.posts.length === 0) && !wf._postsFetchAttempted) {
      wf._postsFetchAttempted = true;
      try {
        console.log(`[Global] Workflow ${log.workflowId} has no posts in cache, fetching from DB...`);
        const detail = await window.electronAPI.invoke("get-workflow-detail", log.workflowId);
        if (detail?.success && detail.workflow?.posts?.length > 0) {
          wf.posts = detail.workflow.posts;
          console.log(`[Global] Loaded ${wf.posts.length} posts for workflow ${log.workflowId} from DB`);
        }
      } catch (e) {
        console.warn(`[Global] Failed to fetch posts for workflow ${log.workflowId}:`, e.message);
      }
    }

    // If workflow not in cache at all, try fetching it (e.g. started on another page)
    if (!wf) {
      if (!window._wfFetchAttempted) window._wfFetchAttempted = {};
      if (!window._wfFetchAttempted[log.workflowId]) {
        window._wfFetchAttempted[log.workflowId] = true;
        try {
          console.log(`[Global] Workflow ${log.workflowId} not in cache, fetching from DB...`);
          const detail = await window.electronAPI.invoke("get-workflow-detail", log.workflowId);
          if (detail?.success && detail.workflow) {
            allWorkflows[log.workflowId] = detail.workflow;
            wf = detail.workflow;
            console.log(`[Global] Added workflow ${log.workflowId} to cache from DB`);
          }
        } catch (e) {
          console.warn(`[Global] Failed to fetch workflow ${log.workflowId}:`, e.message);
        }
      }
      if (!wf || !Array.isArray(wf.posts)) return;
    }

    if (!Array.isArray(wf.posts)) return;

    const post = wf.posts.find((p) => p.postId === log.postId);
    if (!post) return;

    if (!post.nodes) post.nodes = [];

    // Skip informational logs that don't represent actual node executions
    if (!log.logData.nodeId && log.logData.nodeId !== 0) return;
    // Skip logs with stringified "undefined" nodeId (from malformed node references)
    if (String(log.logData.nodeId) === "undefined") return;
    // Skip informational event logs that aren't real node state changes
    if (log.logData.event && ["node-info", "node-warning", "output-generated"].includes(log.logData.event)) return;

    // Cache totalNodes from automation on first log (only once per workflow)
    // Only count processing nodes — exclude input and output nodes
    if (typeof wf.totalNodes !== "number" && wf.automationId) {
      try {
        const automations = await window.electronAPI.readKey("automations");
        // automations can be an array or an object — handle both
        const automation = Array.isArray(automations)
          ? automations.find((a) => a.id === wf.automationId)
          : automations?.[wf.automationId];
        if (automation?.data?.drawflow?.Home?.data) {
          const excludedTypes = new Set(["input", "facebook-output", "pinterest-output", "subinput", "suboutput"]);
          const processingNodes = Object.values(automation.data.drawflow.Home.data).filter(
            (n) => !excludedTypes.has(n.data?.type)
          );
          wf.totalNodes = processingNodes.length;
          console.log(`[Global] Cached totalNodes=${wf.totalNodes} for workflow ${log.workflowId}`);
        }
      } catch (e) {
        console.warn(`[Global] Failed to get automation nodes: ${e.message}`);
      }
    }

    // Update or insert node log entry — always deduplicate by nodeId
    // On retry, a node sends "started" again; we must UPDATE the existing
    // entry rather than pushing a duplicate, otherwise the old "failed"
    // entry inflates the completed-node count and skews progress.
    const existingIdx = post.nodes.findIndex((n) => n.nodeId === log.logData.nodeId);
    if (existingIdx !== -1) {
      post.nodes[existingIdx] = { ...post.nodes[existingIdx], ...log.logData };
    } else {
      post.nodes.push(log.logData);
    }
    if (log.logData.status === "started") {
      post.status = post.status || "pending";
    }

    // Calculate progress based on processing nodes divided by total processing nodes
    // Exclude synthetic nodes (security, workflow) and input/output nodes from progress
    // Deduplicate by nodeId — use only the latest entry per node
    const excludedNodeTypes = new Set(["input", "facebook-output", "pinterest-output", "subinput", "suboutput"]);
    const isProcessingNode = (n) => /^\d+$/.test(String(n.nodeId)) && !excludedNodeTypes.has(n.nodeType);
    const processingNodes = post.nodes.filter(isProcessingNode);
    const totalNodes = wf.totalNodes || processingNodes.length;
    if (totalNodes > 0) {
      // Completed/failed nodes count as 100%, started/processing nodes count as 50%
      let weightedProgress = 0;
      for (const n of processingNodes) {
        if (n.status === "completed" || n.status === "failed") {
          weightedProgress += 1;
        } else if (n.status === "started" || n.status === "processing") {
          weightedProgress += 0.5;
        }
      }
      post.progress = Math.min(99, Math.round((weightedProgress / totalNodes) * 100));
    }

    // Recalculate workflow progress
    const wfPosts = wf.posts || [];
    if (wfPosts.length > 0) {
      const totalWfProgress = wfPosts.reduce(
        (sum, p) => sum + (typeof p.progress === "number" ? p.progress : 0),
        0,
      );
      const newProgress = Math.round(totalWfProgress / wfPosts.length);
      if (
        !wf._lastSavedProgress ||
        Math.abs(newProgress - wf._lastSavedProgress) >= 5
      ) {
        wf.progress = newProgress;
        wf._lastSavedProgress = newProgress;

        // Sync progress to allWorkflowsSummary so the workflows table updates live
        if (window.workflowCache?.allWorkflowsSummary) {
          const summaryWf = window.workflowCache.allWorkflowsSummary.find(
            w => w.workflowId === log.workflowId || w.id === log.workflowId
          );
          if (summaryWf) {
            summaryWf.progress = newProgress;
            if (wf.status) summaryWf.status = wf.status;
          }
        }

        globalUpdateWorkflowStatus(
          log.workflowId,
          wf.status,
          wf.progress,
        ).catch((err) =>
          console.warn(
            `[Global] Failed to save workflow progress: ${err.message}`,
          ),
        );

        // Dispatch workflow-level update for immediate table re-render
        document.dispatchEvent(new CustomEvent('workflow-cache-updated', {
          detail: { workflowId: log.workflowId, status: wf.status, progress: newProgress }
        }));
      }
    }

    // Dispatch event for real-time UI updates on post progress
    document.dispatchEvent(new CustomEvent('post-progress', { 
      detail: { workflowId: log.workflowId, postId: log.postId, progress: post.progress } 
    }));

    console.log(
      `[Global] Automation log received for workflow ${log.workflowId}, post ${log.postId}`,
    );
  });

  // Global handler for final logs (post completion)
  // Backend already saved to DB - this just updates the UI cache
  window.electronAPI.finalLogs(async (_, log) => {
    const allWorkflows = window.workflowCache?.allWorkflows;
    if (!allWorkflows) return;

    let wf = allWorkflows[log.workflowId];

    // Safety net: fetch workflow from DB if missing or has no posts
    if (wf && (!Array.isArray(wf.posts) || wf.posts.length === 0) && !wf._postsFetchAttempted) {
      wf._postsFetchAttempted = true;
      try {
        const detail = await window.electronAPI.invoke("get-workflow-detail", log.workflowId);
        if (detail?.success && detail.workflow?.posts?.length > 0) {
          wf.posts = detail.workflow.posts;
        }
      } catch (e) { /* ignore */ }
    }
    if (!wf || !Array.isArray(wf.posts)) return;

    const post = wf.posts.find((p) => p.postId === log.postId);
    if (!post) return;

    console.log(`[Global] Final logs received for workflow ${log.workflowId}, post ${log.postId}`);

    // Update UI cache only - backend already saved to DB
    if (log.result && log.result.success) {
      post.status = "completed";
      post.pinterestOutput = log.result.value?.pinterest;
      post.facebookOutput = log.result.value?.facebook;
      post.progress = 100;
      // Record completion timestamp for posts/min metric (successful only)
      if (!window._postCompletionTimestamps) window._postCompletionTimestamps = [];
      window._postCompletionTimestamps.push(Date.now());
      if (window._postCompletionTimestamps.length > 50) window._postCompletionTimestamps.splice(0, window._postCompletionTimestamps.length - 50);
    } else {
      post.status = "failed";
      post.progress = 100;
      post.error = log.result?.error?.message || log.result?.value || "Unknown error";
    }

    // Update workflow progress in UI cache
    const posts = wf.posts || [];

    // Dispatch event for immediate UI update on post completion
    document.dispatchEvent(new CustomEvent('post-completed', { 
      detail: { workflowId: log.workflowId, postId: log.postId, status: post.status } 
    }));
    if (posts.length > 0) {
      // If workflow is already completed/stopped/failed, force progress to 100
      if (wf.status === 'completed' || wf.status === 'stopped' || wf.status === 'failed') {
        wf.progress = 100;
      } else {
        const totalProgress = posts.reduce(
          (sum, p) => sum + (typeof p.progress === "number" ? p.progress : 0),
          0,
        );
        wf.progress = Math.round(totalProgress / posts.length);
      }

      // Sync progress to allWorkflowsSummary on post completion
      if (window.workflowCache?.allWorkflowsSummary) {
        const summaryWf = window.workflowCache.allWorkflowsSummary.find(
          w => w.workflowId === log.workflowId || w.id === log.workflowId
        );
        if (summaryWf) {
          summaryWf.progress = wf.progress;
          if (wf.status) summaryWf.status = wf.status;
        }
      }
    }
  });

  // Global handler for workflow completion
  // Backend already saved to DB - this just updates the UI cache
  window.electronAPI.workflowCompleted(async (_, data) => {
    console.log(`[Global] workflow-completed event received for ${data.workflowId}`, data);
    
    const allWorkflows = window.workflowCache?.allWorkflows;
    if (!allWorkflows) {
      console.warn(`[Global] No workflow cache available`);
      // Still dispatch event so UI can react
      document.dispatchEvent(new CustomEvent('workflow-cache-updated', { 
        detail: { workflowId: data.workflowId, status: data.status || 'completed', progress: data.progress || 100 } 
      }));
      return;
    }

    let wf = allWorkflows[data.workflowId];
    
    // If workflow not in cache, try to fetch and add it
    if (!wf) {
      console.log(`[Global] Workflow ${data.workflowId} not in cache, fetching from DB...`);
      try {
        const freshWorkflow = await window.electronAPI.invoke("get-workflow-with-posts", data.workflowId);
        if (freshWorkflow) {
          allWorkflows[data.workflowId] = freshWorkflow;
          wf = freshWorkflow;
          console.log(`[Global] Added workflow ${data.workflowId} to cache from DB`);
        }
      } catch (err) {
        console.warn(`[Global] Could not fetch workflow from DB:`, err.message);
      }
    }

    // Update workflow status
    if (wf) {
      console.log(`[Global] Updating workflow ${data.workflowId} in cache: status=${data.status || 'completed'}`);
      wf.status = data.status || 'completed';
      wf.progress = data.progress || 100;
      // Freeze the run-time timer by recording the completion timestamp
      wf.updatedAt = new Date().toISOString();
      
      // Also update the cache reference directly to ensure sync
      window.workflowCache.allWorkflows[data.workflowId] = wf;
      
      // CRITICAL: Also update allWorkflowsSummary to keep it in sync
      if (window.workflowCache.allWorkflowsSummary) {
        const summaryWf = window.workflowCache.allWorkflowsSummary.find(
          w => w.workflowId === data.workflowId || w.id === data.workflowId
        );
        if (summaryWf) {
          summaryWf.status = data.status || 'completed';
          summaryWf.progress = data.progress || 100;
          summaryWf.updatedAt = wf.updatedAt;
        }
      }
    }

    console.log(
      `[Global] Workflow ${data.workflowId} completed`,
      data.error ? `(error: ${data.error})` : "",
    );

    // Always dispatch event for immediate UI update
    document.dispatchEvent(new CustomEvent('workflow-cache-updated', { 
      detail: { workflowId: data.workflowId, status: data.status || 'completed', progress: data.progress || 100 } 
    }));
  });

  // Global handler for workflow stopped
  window.electronAPI.workflowStopped((data) => {
    const allWorkflows = window.workflowCache?.allWorkflows;
    if (!allWorkflows) return;

    const wf = allWorkflows[data.workflowId];
    if (!wf) return;

    console.log(
      `[Global] Workflow ${data.workflowId} stopped: ${data.completedPosts}/${data.totalPosts} posts completed`,
    );

    wf.status = data.status;
    wf.progress = data.progress;
    // Freeze the run-time timer by recording the stop timestamp
    wf.updatedAt = new Date().toISOString();

    if (wf.posts && Array.isArray(wf.posts)) {
      wf.posts.forEach((post) => {
        if (post.status !== "completed") {
          post.status = "failed";
          post.progress = 100;
        }
      });
    }

    // Update summary cache updatedAt as well
    if (window.workflowCache?.allWorkflowsSummary) {
      const summaryWf = window.workflowCache.allWorkflowsSummary.find(
        w => w.workflowId === data.workflowId || w.id === data.workflowId
      );
      if (summaryWf) {
        summaryWf.updatedAt = wf.updatedAt;
      }
    }
  });

  // Global handler for workflow status changes (from queue)
  window.electronAPI.workflowStatusChanged((data) => {
    const cache = window.workflowCache;
    if (!cache) return;

    const allWorkflows = cache.allWorkflows;
    const allWorkflowsSummary = cache.allWorkflowsSummary;

    console.log(`[Global] Workflow ${data.workflowId} status changed: ${data.status} (${data.reason})`);
    
    // Update the full workflow cache
    if (allWorkflows && allWorkflows[data.workflowId]) {
      allWorkflows[data.workflowId].status = data.status;
    }
    
    // CRITICAL: Also update the summary cache
    if (allWorkflowsSummary && Array.isArray(allWorkflowsSummary)) {
      const summaryItem = allWorkflowsSummary.find(w => w.workflowId === data.workflowId);
      if (summaryItem) {
        summaryItem.status = data.status;
      }
    }
    
    // Trigger a re-render if we're on the workflows page
    if (typeof window.forceWorkflowsRender === 'function') {
      window.forceWorkflowsRender();
    }
  });
});

async function newPrompt(inputs) {
  return new Promise((resolve) => {
    let form = inputs
      .map((input, inputIndex) => {
        const requiredAttr = input.required ? "required" : "";
        if (input.type === "html") {
          // Support for HTML content (no input field, just display HTML)
          return input.content || "";
        } else if (input.type === "select") {
          // Use custom searchable dropdown for selects with many options
          const useCustomDropdown = input.options && input.options.length > 8;
          
          if (useCustomDropdown) {
            const searchText = (window.I18n && window.I18n.isReady()) ? window.I18n.t('common.search') : 'Search...';
            const selectText = (window.I18n && window.I18n.isReady()) ? window.I18n.t('common.select') : 'Select...';
            const searchPlaceholder = searchText === 'common.search' ? 'Search...' : searchText;
            const selectDefault = selectText === 'common.select' ? 'Select...' : selectText;
            const optionsHtml = input.options
              .map((opt) => {
                const isSelected = opt.selected || (input.value && input.value == opt.value);
                // Support for thumbnail images in options with hover preview
                const thumbnailHtml = opt.thumbnail 
                  ? `<div class="option-thumbnail-wrapper">
                       <img class="option-thumbnail" src="${opt.thumbnail}" onerror="this.style.display='none'; this.nextElementSibling.style.display='none';" />
                       <img class="thumbnail-preview" src="${opt.thumbnail}" onerror="this.style.display='none'" />
                     </div>`
                  : '';
                return `<div class="custom-select-option ${isSelected ? 'selected' : ''} ${opt.thumbnail ? 'has-thumbnail' : ''}" data-value="${opt.value}">${thumbnailHtml}<span class="option-label">${opt.label}</span></div>`;
              })
              .join("");
            const selectedOpt = input.options.find(opt => opt.selected || (input.value && input.value == opt.value)) || input.options[0];
            // Show thumbnail in trigger if selected option has one
            const selectedThumbnailHtml = selectedOpt?.thumbnail 
              ? `<img class="trigger-thumbnail" src="${selectedOpt.thumbnail}" onerror="this.style.display='none'" />`
              : '';
            return `<label class="${input.class || ""}">
                      <span>${input.name} ${input.required ? "<span style='color: #ef4444;'>*</span>" : ""}</span>
                      <div class="custom-select-wrapper ${input.showThumbnails ? 'with-thumbnails' : ''}" data-name="${input.name}" data-index="${inputIndex}">
                        <input type="hidden" name="${input.name}" value="${selectedOpt?.value || ''}" ${requiredAttr}>
                        <div class="custom-select-trigger">
                          ${selectedThumbnailHtml}
                          <span class="custom-select-value">${selectedOpt?.label || selectDefault}</span>
                          <i class="material-icons">expand_more</i>
                        </div>
                        <div class="custom-select-dropdown">
                          <div class="custom-select-search">
                            <i class="material-icons">search</i>
                            <input type="text" placeholder="${searchPlaceholder}" class="custom-select-search-input">
                          </div>
                          <div class="custom-select-options">
                            ${optionsHtml}
                          </div>
                        </div>
                      </div>
                    </label>`;
          } else {
            const options = input.options
              .map((opt) => {
                const isSelected =
                  opt.selected || (input.value && input.value == opt.value);
                return `<option ${isSelected ? "selected" : ""} value="${opt.value}">${opt.label}</option>`;
              })
              .join("");
            return `<label class="${input.class || ""}">
                      <span>${input.name} ${input.required ? "<span style='color: #ef4444;'>*</span>" : ""}</span>
                      <select name="${input.name}" ${requiredAttr}>
                          ${options}
                      </select>
                  </label>`;
          }
        } else {
          const minAttr = input.min !== undefined ? `min="${input.min}"` : "";
          const maxAttr = input.max !== undefined ? `max="${input.max}"` : "";
          const stepAttr = input.step !== undefined ? `step="${input.step}"` : "";
          return `<label class="${input.class || ""}">
                    <span>${input.name} ${input.required ? "<span style='color: #ef4444;'>*</span>" : ""}</span>
                    <input value="${input.value || ""}" type="${input.type}" name="${input.name}" ${requiredAttr} ${minAttr} ${maxAttr} ${stepAttr} placeholder="${input.placeholder || ""}" />
                </label>`;
        }
      })
      .join("");

    // Check if all inputs are HTML (display-only, no form needed)
    const hasFormInputs = inputs.some((input) => input.type !== "html");
    const submitText = (window.I18n && window.I18n.isReady()) ? window.I18n.t('common.submit') : 'Submit';
    const submitButton = hasFormInputs
      ? `<button type="submit"><i class="material-icons" style="font-size: 18px;">check</i> ${submitText === 'common.submit' ? 'Submit' : submitText}</button>`
      : "";

    const promptModal = $(`
            <div class='promptModal'>
                <div class='modal-content'>
                    <button type="button" class="close"><i class="material-icons">close</i></button>
                    <form>
                        ${form}
                        ${submitButton}
                    </form>
                </div>    
            </div>
        `);

    $("body").append(promptModal);

    const closeModal = () => {
      promptModal.addClass("closing");
      setTimeout(() => promptModal.remove(), 200);
    };

    // Thumbnail preview positioning on hover
    promptModal.find(".option-thumbnail-wrapper").on("mouseenter", function() {
      const $wrapper = $(this);
      const $preview = $wrapper.find(".thumbnail-preview");
      if (!$preview.length) return;
      
      const rect = this.getBoundingClientRect();
      const previewWidth = 180;
      const previewHeight = 180;
      const padding = 20;
      
      // Position to the right of the modal
      let left = rect.right + padding;
      let top = rect.top + (rect.height / 2) - (previewHeight / 2);
      
      // If it would go off the right edge, position to the left instead
      if (left + previewWidth > window.innerWidth - padding) {
        left = rect.left - previewWidth - padding;
      }
      
      // Keep within vertical bounds
      if (top < padding) top = padding;
      if (top + previewHeight > window.innerHeight - padding) {
        top = window.innerHeight - previewHeight - padding;
      }
      
      $preview.css({
        left: left + 'px',
        top: top + 'px'
      });
    });

    // Custom dropdown event handlers
    promptModal.find(".custom-select-trigger").on("click", function(e) {
      e.stopPropagation();
      const $wrapper = $(this).closest(".custom-select-wrapper");
      const wasOpen = $wrapper.hasClass("open");
      
      // Close all other dropdowns
      promptModal.find(".custom-select-wrapper").removeClass("open");
      
      if (!wasOpen) {
        $wrapper.addClass("open");
        $wrapper.find(".custom-select-search-input").focus();
      }
    });

    // Search functionality
    promptModal.find(".custom-select-search-input").on("input", function() {
      const searchTerm = $(this).val().toLowerCase();
      const $options = $(this).closest(".custom-select-dropdown").find(".custom-select-option");
      
      $options.each(function() {
        const text = $(this).text().toLowerCase();
        $(this).toggle(text.includes(searchTerm));
      });
    });

    // Prevent search input from closing dropdown
    promptModal.find(".custom-select-search-input").on("click", function(e) {
      e.stopPropagation();
    });

    // Option selection
    promptModal.find(".custom-select-option").on("click", function(e) {
      e.stopPropagation();
      const $option = $(this);
      const $wrapper = $option.closest(".custom-select-wrapper");
      const value = $option.data("value");
      const label = $option.find(".option-label").length ? $option.find(".option-label").text() : $option.text();
      
      // Update hidden input
      $wrapper.find('input[type="hidden"]').val(value);
      
      // Update trigger text and thumbnail
      $wrapper.find(".custom-select-value").text(label);
      
      // Update trigger thumbnail if option has one
      const $optionThumbnail = $option.find(".option-thumbnail");
      const $trigger = $wrapper.find(".custom-select-trigger");
      $trigger.find(".trigger-thumbnail").remove();
      if ($optionThumbnail.length && $optionThumbnail.attr("src")) {
        $trigger.prepend(`<img class="trigger-thumbnail" src="${$optionThumbnail.attr("src")}" onerror="this.style.display='none'" />`);
      }
      
      // Update selected state
      $wrapper.find(".custom-select-option").removeClass("selected");
      $option.addClass("selected");
      
      // Close dropdown
      $wrapper.removeClass("open");
      
      // Clear search
      $wrapper.find(".custom-select-search-input").val("");
      $wrapper.find(".custom-select-option").show();
    });

    // Close dropdown when clicking outside
    promptModal.on("click", function() {
      promptModal.find(".custom-select-wrapper").removeClass("open");
    });

    promptModal.find(".close").on("click", () => {
      closeModal();
      resolve(null);
    });

    // Close on overlay click
    promptModal.on("click", function (e) {
      if (e.target === this) {
        closeModal();
        resolve(null);
      }
    });

    // Close on Escape key
    $(document).on("keydown.promptModal", function (e) {
      if (e.key === "Escape") {
        $(document).off("keydown.promptModal");
        closeModal();
        resolve(null);
      }
    });

    promptModal.find("form").on("submit", function (e) {
      e.preventDefault();
      $(document).off("keydown.promptModal");
      const data = {};
      inputs.forEach((input) => {
        if (
          ($(".tempInputs").length > 0 && input.name != "Api key") ||
          $(".tempInputs").length == 0
        ) {
          data[input.name] = $(this).find(`[name="${input.name}"]`).val();
        }
      });
      if ($(".tempInputs").length > 0) {
        let apiinfo = [];
        $(".tempInputs input").each(function () {
          apiinfo.push($(this).val());
        });
        data["Api key"] = apiinfo.join("|");
      }
      closeModal();
      resolve(data);
    });
  });
}

async function confirmPrompt(message = null) {
  // Blur whatever is focused so Electron doesn't re-fire a click on it when the modal closes
  if (document.activeElement) document.activeElement.blur();
  const defaultMsg = (window.I18n && window.I18n.isReady()) ? window.I18n.t('common.are_you_sure') : "Are you sure?";
  const defaultMessage = defaultMsg === 'common.are_you_sure' ? "Are you sure?" : defaultMsg;
  const cancelTxt = (window.I18n && window.I18n.isReady()) ? window.I18n.t('common.cancel') : 'Cancel';
  const cancelText = cancelTxt === 'common.cancel' ? 'Cancel' : cancelTxt;
  const confirmTxt = (window.I18n && window.I18n.isReady()) ? window.I18n.t('common.confirm') : 'Confirm';
  const confirmText = confirmTxt === 'common.confirm' ? 'Confirm' : confirmTxt;
  return new Promise((resolve) => {
    const promptModal = $(`
            <div class='confirmModal'>
                <div class='confirm-modal-overlay'></div>
                <div class='confirm-modal-content'>
                    <div class='confirm-modal-icon'>
                        <i class="material-icons">help_outline</i>
                    </div>
                    <p class='confirm-modal-message'>${message || defaultMessage}</p>
                    <div class='confirm-modal-actions'>
                        <button class="confirm-modal-btn btn-cancel">${cancelText}</button>
                        <button class="confirm-modal-btn btn-confirm" autofocus>${confirmText}</button>
                    </div>
                </div>
            </div>
        `);

    $("body").append(promptModal);

    // Focus the confirm button for keyboard accessibility
    setTimeout(() => {
      promptModal.find(".btn-confirm").focus();
    }, 50);

    const closeModal = () => {
      promptModal.addClass("closing");
      setTimeout(() => promptModal.remove(), 200);
    };

    // Handle keyboard events
    promptModal.on("keydown", function (e) {
      if (e.key === "Escape") {
        closeModal();
        resolve(false);
      } else if (e.key === "Enter" || e.key === " ") {
        if ($(document.activeElement).hasClass("btn-confirm")) {
          e.preventDefault();
          closeModal();
          resolve(true);
        } else if ($(document.activeElement).hasClass("btn-cancel")) {
          e.preventDefault();
          closeModal();
          resolve(false);
        }
      }
    });

    promptModal.find(".confirm-modal-overlay, .btn-cancel").on("click", () => {
      closeModal();
      resolve(false);
    });

    promptModal.find(".btn-confirm").on("click", () => {
      closeModal();
      resolve(true);
    });
  });
}

function generateRandomString(length) {
  return Math.random()
    .toString(36)
    .substring(2, 2 + length);
}

function formatReadableDate(isoString, locale = "en-US") {
  const date = new Date(isoString);
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function ucfirst(val) {
  return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

/**
 * Global toast/alert function - alias for showAlert
 * Supports both parameter orders for compatibility:
 * - showToast(type, message) - preferred
 * - showToast(message, type) - legacy support
 */
function showToast(arg1, arg2) {
  // Detect parameter order: if arg1 is a known type, use (type, message) order
  const knownTypes = ['error', 'warning', 'success', 'info'];
  
  if (knownTypes.includes(arg1)) {
    // Correct order: showToast(type, message)
    showAlert(arg1, arg2);
  } else if (knownTypes.includes(arg2)) {
    // Legacy order: showToast(message, type)
    showAlert(arg2, arg1);
  } else {
    // Default to info type if no valid type found
    showAlert('info', arg1 || arg2);
  }
}

function showAlert(type, message) {
  // Remove existing alerts
  const existingAlerts = document.querySelectorAll(".modern-alert");
  existingAlerts.forEach((alert) => alert.remove());

  const icons = {
    error: "error",
    warning: "warning",
    success: "check_circle",
    info: "info",
  };

  const colors = {
    error: {
      bg: "linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%)",
      border: "#ff5252",
      iconBg: "rgba(255,255,255,0.2)",
    },
    warning: {
      bg: "linear-gradient(135deg, #ffa726 0%, #ff9800 100%)",
      border: "#ff9800",
      iconBg: "rgba(255,255,255,0.2)",
    },
    success: {
      bg: "linear-gradient(135deg, #66bb6a 0%, #4caf50 100%)",
      border: "#4caf50",
      iconBg: "rgba(255,255,255,0.2)",
    },
    info: {
      bg: "linear-gradient(135deg, #42a5f5 0%, #2196f3 100%)",
      border: "#2196f3",
      iconBg: "rgba(255,255,255,0.2)",
    },
  };

  const colorScheme = colors[type] || colors.info;
  const icon = icons[type] || "info";

  const alertBox = document.createElement("div");
  alertBox.className = "modern-alert";
  alertBox.innerHTML = `
        <div class="modern-alert-icon">
            <i class="material-icons">${icon}</i>
        </div>
        <div class="modern-alert-content">
            <span class="modern-alert-message">${message}</span>
        </div>
        <button class="modern-alert-close">
            <i class="material-icons">close</i>
        </button>
        <div class="modern-alert-progress"></div>
    `;

  // Apply styles
  Object.assign(alertBox.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    background: colorScheme.bg,
    color: "#fff",
    padding: "16px 20px",
    borderRadius: "12px",
    boxShadow: "0 10px 40px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.1)",
    zIndex: "999999",
    fontSize: "14px",
    fontWeight: "500",
    maxWidth: "400px",
    minWidth: "300px",
    transform: "translateX(120%)",
    transition: "transform 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)",
    overflow: "hidden",
    borderLeft: `4px solid rgba(255,255,255,0.3)`,
  });

  // Icon styles
  const iconEl = alertBox.querySelector(".modern-alert-icon");
  Object.assign(iconEl.style, {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: colorScheme.iconBg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
  });
  iconEl.querySelector("i").style.fontSize = "20px";

  // Content styles
  const contentEl = alertBox.querySelector(".modern-alert-content");
  Object.assign(contentEl.style, {
    flex: "1",
    lineHeight: "1.4",
  });

  // Close button styles
  const closeBtn = alertBox.querySelector(".modern-alert-close");
  Object.assign(closeBtn.style, {
    background: "rgba(255,255,255,0.1)",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    padding: "6px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.2s, transform 0.2s",
    flexShrink: "0",
  });
  closeBtn.querySelector("i").style.fontSize = "18px";
  closeBtn.onmouseenter = () => {
    closeBtn.style.background = "rgba(255,255,255,0.25)";
    closeBtn.style.transform = "scale(1.1)";
  };
  closeBtn.onmouseleave = () => {
    closeBtn.style.background = "rgba(255,255,255,0.1)";
    closeBtn.style.transform = "scale(1)";
  };

  // Progress bar styles
  const progressBar = alertBox.querySelector(".modern-alert-progress");
  Object.assign(progressBar.style, {
    position: "absolute",
    bottom: "0",
    left: "0",
    height: "3px",
    background: "rgba(255,255,255,0.4)",
    width: "100%",
    transformOrigin: "left",
    animation: "alertProgress 4s linear forwards",
  });

  // Add keyframes if not exists
  if (!document.getElementById("alertKeyframes")) {
    const style = document.createElement("style");
    style.id = "alertKeyframes";
    style.textContent = `
            @keyframes alertProgress {
                from { transform: scaleX(1); }
                to { transform: scaleX(0); }
            }
            @keyframes alertShake {
                0%, 100% { transform: translateX(0); }
                25% { transform: translateX(-5px); }
                75% { transform: translateX(5px); }
            }
        `;
    document.head.appendChild(style);
  }

  document.body.appendChild(alertBox);

  // Slide in animation
  requestAnimationFrame(() => {
    alertBox.style.transform = "translateX(0)";
  });

  // Close function
  const closeAlert = () => {
    alertBox.style.transform = "translateX(120%)";
    alertBox.style.opacity = "0";
    setTimeout(() => {
      if (alertBox.parentNode) {
        alertBox.parentNode.removeChild(alertBox);
      }
    }, 400);
  };

  closeBtn.onclick = closeAlert;

  // Auto close after 4 seconds
  setTimeout(closeAlert, 4000);
}

function showLoading(
  text,
  canclose = false,
  closeCallback = () => {},
  black = false,
) {
  const closeButton = canclose
    ? `<button class="close-loading-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            Cancel
           </button>`
    : "";

  const loadingDIV = $(`
        <div class="modern-loading-overlay ${black ? "solid-bg" : ""}">
            <div class="modern-loading-card">
                <div class="loading-spinner">
                    <div class="spinner-ring"></div>
                    <div class="spinner-ring"></div>
                    <div class="spinner-ring"></div>
                </div>
                <div class="loading-text">${text}</div>
                <div class="loading-progress">
                    <div class="progress-bar-animated"></div>
                </div>
                ${closeButton}
            </div>
        </div>
    `);

  $("body").append(loadingDIV);

  if (canclose) {
    loadingDIV.find(".close-loading-btn").on("click", () => {
      loadingDIV.addClass("fade-out");
      setTimeout(() => {
        loadingDIV.remove();
        closeCallback();
      }, 200);
    });
  }
}

function removeLoading() {
  const $loader = $(".modern-loading-overlay, .loading-container");
  $loader.addClass("fade-out");
  setTimeout(() => {
    $loader.remove();
  }, 200);
}

// ========== FB Groups Floating Indicator Handlers ==========
function initFbGroupsFloatingIndicator() {
  const $ind = $('#fbg-floating-indicator');

  // Close button → dismiss the indicator without navigating
  $ind.on('click', '.fbg-float-close', function (e) {
    e.stopPropagation();
    $ind.removeClass('visible pulse-anim');
    if (window.fbGroupsManager) window.fbGroupsManager.unreadLogCount = 0;
  });

  // Click anywhere on indicator → navigate to fb-groups page
  $ind.on('click', function () {
    $ind.removeClass('visible pulse-anim');
    $('.menu .menu-element[href="#fb-groups"]').click();
  });
}

// ========== Spy Floating Indicator Handlers ==========
function initSpyFloatingIndicator() {
  const $indicator = $('#spy-floating-indicator');
  
  // Toggle expand/collapse on main bar click
  $indicator.on('click', '.spy-indicator-main', function(e) {
    // Don't toggle if clicking the expand button (it handles its own action)
    if ($(e.target).closest('.spy-indicator-expand').length) return;
    
    $indicator.toggleClass('expanded');
  });
  
  // Expand button click
  $indicator.on('click', '.spy-indicator-expand', function(e) {
    e.stopPropagation();
    $indicator.toggleClass('expanded');
  });
  
  // Stop all sessions
  $indicator.on('click', '.spy-stop-all-btn', async function(e) {
    e.stopPropagation();
    
    const confirmed = await confirmPrompt('Stop all spy sessions?');
    if (!confirmed) return;
    
    await window.spyManager.stopAllSessions();
    $indicator.removeClass('visible expanded');
    showAlert('info', 'All spy sessions stopped');
  });
  
  // Restore a specific session
  $indicator.on('click', '.session-restore-btn', function(e) {
    e.stopPropagation();
    // Use .attr() instead of .data() to avoid jQuery auto-conversion of numeric strings
    const profileId = $(this).closest('.spy-session-item').attr('data-profile-id');
    
    console.log('[SpyManager] Restore clicked, profileId:', profileId, 'type:', typeof profileId);
    console.log('[SpyManager] Available sessions:', Array.from(window.spyManager.sessions.keys()));
    
    // Collapse panel first
    $indicator.removeClass('expanded');
    
    // Navigate and restore (restore() handles setting spyRestoreSession)
    window.spyManager.restore(profileId);
  });
  
  // Stop a specific session
  $indicator.on('click', '.session-stop-btn', async function(e) {
    e.stopPropagation();
    // Use .attr() instead of .data() to avoid jQuery auto-conversion of numeric strings
    const profileId = $(this).closest('.spy-session-item').attr('data-profile-id');
    
    // Check if session is still starting (login test in progress)
    const session = window.spyManager.sessions.get(profileId);
    if (session && session.isStarting) {
      // Cancel the login test
      await window.electronAPI.cancelTestProfileLogin();
      showAlert('info', 'Spy startup cancelled');
    } else {
      showAlert('info', 'Spy session stopped');
    }
    
    await window.spyManager.stopSession(profileId);
    
    // If no more sessions, hide the indicator
    if (!window.spyManager.hasActiveSessions()) {
      $indicator.removeClass('visible expanded');
    }
  });
  
  // Click on main icon to restore first session
  $indicator.on('click', '.spy-indicator-icon', function(e) {
    e.stopPropagation();
    
    // Navigate and restore (restore() handles everything)
    window.spyManager.restore();
  });
  
  // Double-click anywhere on main bar to restore first session (legacy)
  $indicator.on('dblclick', '.spy-indicator-main', function(e) {
    if ($(e.target).closest('.spy-indicator-expand').length) return;
    if ($(e.target).closest('.spy-indicator-icon').length) return;
    if ($indicator.hasClass('expanded')) return;
    
    // Navigate and restore
    window.spyManager.restore();
  });
  
  console.log('[SpyManager] Floating indicator initialized');
}

function formatNumber(num) {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  }
  return num.toString();
}

function timeAgo(unixTimestamp) {
  const now = Date.now();
  const secondsAgo = Math.floor((now - unixTimestamp * 1000) / 1000);

  const intervals = [
    { label: "year", seconds: 31_536_000 },
    { label: "month", seconds: 2_592_000 },
    { label: "week", seconds: 604_800 },
    { label: "day", seconds: 86_400 },
    { label: "hour", seconds: 3_600 },
    { label: "minute", seconds: 60 },
    { label: "second", seconds: 1 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(secondsAgo / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count !== 1 ? "s" : ""} ago`;
    }
  }

  return "just now";
}

function clearIntervals() {
  if (window.intervals) {
    for (var i = 0; i < window.intervals.length; i++) {
      try {
        clearInterval(window.intervals[i]);
      } catch (err) {}
    }
    window.intervals = [];
  }
}

function cleanupCurrentPage() {
  // Clear all intervals and timeouts
  clearIntervals();

  // Preserve copypaste modal state before page content is destroyed
  const $copypaste = $(".workflow-copypaste");
  if ($copypaste.length && window.copypasteState) {
    const isOpen = $copypaste.css("display") !== "none";
    const isMinimized = $("#copypasteMinimizedIndicator").css("display") !== "none";
    if (isOpen || isMinimized) {
      // Detach from DOM to preserve the element and its children
      window.copypasteState.$element = $copypaste.detach();
      window.copypasteState.isOpen = isOpen;
      window.copypasteState.isMinimized = isMinimized;
      // Hide the indicator while not on workflows page
      $("#copypasteMinimizedIndicator").hide();
      console.log("[Copypaste] State saved for navigation", { isOpen, isMinimized });
    } else {
      // Copypaste was closed, clear any stale state
      window.copypasteState.$element = null;
      window.copypasteState.isOpen = false;
      window.copypasteState.isMinimized = false;
    }
  }

  // Clear home page intervals (trending recipes, dashboard refresh, etc.)
  if (window.homePageIntervals) {
    window.homePageIntervals.forEach(id => {
      try {
        clearInterval(id);
      } catch (err) {}
    });
    window.homePageIntervals = [];
  }

  // Clear workflows page refresh interval if it exists
  if (window.workflowsPageRefreshInterval) {
    clearInterval(window.workflowsPageRefreshInterval);
    window.workflowsPageRefreshInterval = null;
  }

  // Clear all jQuery event handlers for dynamically loaded content
  $("#pagesContent").off();
  $("#pagesContent *").off();

  // Destroy Tippy instances to prevent memory leaks
  if (window.tippy && window.tippy.destroyAll) {
    window.tippy.destroyAll();
  }

  // Cleanup Drawflow instance if exists
  if (window.editor && typeof window.editor.clear === "function") {
    try {
      window.editor.clear();
    } catch (err) {
      console.warn("Error clearing Drawflow editor:", err);
    }
  }

  // Stop any background processes
  // BUT skip spy cleanup if spyManager has active sessions (minimized mode)
  if (
    window.currentPageCleanup &&
    typeof window.currentPageCleanup === "function"
  ) {
    // currentPageCleanup handles the spy/partial-cleanup routing internally.
    // It checks window.spyManager.hasActiveSessions() and calls spyPartialCleanup
    // (preserving the backend) when sessions exist, regardless of isMinimized state.
    window.currentPageCleanup();
  }

  // Garbage collection removed to prevent white screen issues
}

function maxStr(text, max) {
  return text.length < max ? text : text.slice(0, max);
}

function timeAgo(isoString) {
  const now = new Date();
  const then = new Date(isoString);
  const seconds = Math.floor((now - then) / 1000);

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60,
    second: 1,
  };

  for (let key in intervals) {
    const interval = Math.floor(seconds / intervals[key]);
    if (interval >= 1) {
      return `${interval} ${key}${interval !== 1 ? "s" : ""} ago`;
    }
  }

  return "just now";
}

function showDynamicModal(title, bodyContent, additionalInfo = "") {
  const modalId = "dynamic-modal-" + Date.now();

  const modalHtml = `
    <div class="dynamicModal" id="${modalId}">
        <div class="dynamic-modal-overlay"></div>
        <div class="dynamic-modal-content">
            <div class="dynamic-modal-header">
                <h5 class="dynamic-modal-title">${title}</h5>
                <button type="button" class="dynamic-modal-close" aria-label="Close">
                    <i class="material-icons">close</i>
                </button>
            </div>
            <div class="dynamic-modal-body" data-info="${additionalInfo}">
                ${bodyContent}
            </div>
        </div>
    </div>`;

  $("body").append(modalHtml);

  const $modal = $(`#${modalId}`);

  const closeModal = () => {
    $modal.addClass("closing");
    setTimeout(() => $modal.remove(), 200);
  };

  // Close on overlay click
  $modal.find(".dynamic-modal-overlay").on("click", closeModal);

  // Close on close button click
  $modal.find(".dynamic-modal-close").on("click", closeModal);

  // Close on Escape key
  $modal.on("keydown", function (e) {
    if (e.key === "Escape") {
      closeModal();
    }
  });

  // Focus the modal for keyboard events
  setTimeout(() => {
    $modal.find(".dynamic-modal-content").attr("tabindex", "-1").focus();
  }, 50);
}

// Sidebar collapse/expand functionality
function initSidebarToggle() {
  const $sidebar = $(".body-sidebar");
  const $toggleBtn = $("#sidebarToggleBtn");
  
  // Load saved state from localStorage
  const isCollapsed = localStorage.getItem("sidebarCollapsed") === "true";
  
  // Apply saved state
  if (isCollapsed) {
    $sidebar.addClass("collapsed");
    $toggleBtn.attr("title", "Expand Sidebar");
  }
  
  // Initialize tooltips for collapsed sidebar using Tippy.js
  // Note: called again after i18n.init() resolves to use translated text
  // initSidebarTooltips(); — deferred to after i18n is ready
  
  // Toggle button click handler
  $toggleBtn.on("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    
    $sidebar.toggleClass("collapsed");
    
    // Save state to localStorage
    const nowCollapsed = $sidebar.hasClass("collapsed");
    localStorage.setItem("sidebarCollapsed", nowCollapsed);
    
    // Update button title
    $toggleBtn.attr("title", nowCollapsed ? "Expand Sidebar" : "Collapse Sidebar");
    
    // Update tooltips state
    updateSidebarTooltips(nowCollapsed);
  });
}

// Initialize tooltips for sidebar menu items (only shown when collapsed)
function initSidebarTooltips() {
  const $sidebar = $(".body-sidebar");
  const isCollapsed = $sidebar.hasClass("collapsed");
  
  // Initialize Tippy tooltips for menu elements
  $(".body-sidebar .menu .menu-element[data-tooltip]").each(function() {
    const i18nKey = $(this).attr("data-i18n-tooltip");
    const tooltipText = (i18nKey && window.I18n?.t(i18nKey)) || $(this).attr("data-tooltip");
    if (tooltipText && !this._tippy) {
      tippy(this, {
        content: tooltipText,
        placement: "right",
        arrow: true,
        theme: "sidebar-tooltip",
        delay: [200, 0],
        offset: [0, 12],
        appendTo: document.body,
        onShow(instance) {
          // Only show tooltip when sidebar is collapsed
          if (!$sidebar.hasClass("collapsed")) {
            return false;
          }
        }
      });
    }
  });
  
  // Initialize tooltips for category headers
  $(".body-sidebar .menu .menu-category[data-tooltip]").each(function() {
    const i18nKey = $(this).attr("data-i18n-tooltip");
    const tooltipText = (i18nKey && window.I18n?.t(i18nKey)) || $(this).attr("data-tooltip");
    const $header = $(this).find(".menu-category-header");
    if (tooltipText && !$header[0]._tippy) {
      tippy($header[0], {
        content: tooltipText,
        placement: "right",
        arrow: true,
        theme: "sidebar-tooltip",
        delay: [200, 0],
        offset: [0, 12],
        appendTo: document.body,
        onShow(instance) {
          // Only show tooltip when sidebar is collapsed
          if (!$sidebar.hasClass("collapsed")) {
            return false;
          }
        }
      });
    }
  });
  
  // Initialize tooltip for user profile section
  const $userProfile = $(".body-sidebar .user-profile-section");
  if (!$userProfile[0]._tippy) {
    tippy($userProfile[0], {
      content: "Profile",
      placement: "right",
      arrow: true,
      theme: "sidebar-tooltip",
      delay: [200, 0],
      offset: [0, 12],
      appendTo: document.body,
      onShow(instance) {
        if (!$sidebar.hasClass("collapsed")) {
          return false;
        }
        // Update content with username if available
        const userName = $("#userName").text();
        if (userName && userName !== "Loading...") {
          instance.setContent(userName);
        }
      }
    });
  }
  
  // Initialize tooltip for logout button
  const $logoutBtn = $(".body-sidebar .sidebar-footer .logout-btn");
  if ($logoutBtn.length && !$logoutBtn[0]._tippy) {
    tippy($logoutBtn[0], {
      content: "Logout",
      placement: "right",
      arrow: true,
      theme: "sidebar-tooltip",
      delay: [200, 0],
      offset: [0, 12],
      appendTo: document.body,
      onShow(instance) {
        if (!$sidebar.hasClass("collapsed")) {
          return false;
        }
      }
    });
  }
}

// Update tooltip visibility state
function updateSidebarTooltips(isCollapsed) {
  // Tooltips automatically handle visibility via onShow callback
  // This function can be extended if needed
}

// Sidebar dropdown functionality
function initSidebarDropdowns() {
  // Load saved dropdown states from localStorage
  const savedStates = JSON.parse(
    localStorage.getItem("sidebarDropdownStates") || "{}",
  );

  // Apply saved states
  $(".menu-category-header").each(function () {
    const category = $(this).data("category");
    if (savedStates[category]) {
      $(this).closest(".menu-category").addClass("open");
    }
  });

  // Toggle dropdown on category header click
  $(document).on("click", ".menu-category-header", function (e) {
    e.preventDefault();
    e.stopPropagation();

    const $category = $(this).closest(".menu-category");
    const categoryName = $(this).data("category");
    const isOpen = $category.hasClass("open");

    // Close all other dropdowns first
    $(".menu-category.open").not($category).removeClass("open");

    // Toggle current dropdown
    $category.toggleClass("open");

    // Save state to localStorage (only keep the open one)
    const states = {};
    if (!isOpen) {
      states[categoryName] = true;
    }
    localStorage.setItem("sidebarDropdownStates", JSON.stringify(states));
  });

  // Auto-expand category when a child menu item is active
  autoExpandActiveCategory();
}

// Auto-expand the category containing the active menu item
function autoExpandActiveCategory() {
  const activeItem = $(".menu-category-items .menu-element.active");
  if (activeItem.length) {
    activeItem.closest(".menu-category").addClass("open");
  }
}

// Update active category when navigating
function updateSidebarActiveState(page) {
  // Remove active class from all menu elements
  $(".menu .menu-element").removeClass("active");

  // Find and activate the matching menu element
  const $menuItem = $(`.menu .menu-element[href="#${page}"]`);
  $menuItem.addClass("active");

  // Auto-expand the parent category if item is in a dropdown
  const $parentCategory = $menuItem.closest(".menu-category");
  if ($parentCategory.length) {
    $parentCategory.addClass("open");
  }
}

// Load and display app version
async function loadAppVersion() {
  try {
    const version = await window.electronAPI.getAppVersion();
    $("#appVersion").text(`v${version}`);
  } catch (error) {
    console.error("Failed to load app version:", error);
    $("#appVersion").text("v1.0.0");
  }
}

/**
 * Show/hide platform-specific sidebar nav items for supported platforms.
 * Elements with data-platform="facebook" are hidden unless platforms includes 'facebook'.
 * Elements with data-platform="pinterest" are hidden unless platforms includes 'pinterest'.
 * @param {string[]} platforms - array of accessible platforms, e.g. ['facebook','pinterest']
 * @param {string[]} platforms - array of accessible platforms, e.g. ['facebook','pinterest']
 * @param {string[]} addons - array of active addon keys, e.g. ['fb_groups']
 */
function applyPlatformAccess(platforms, addons = []) {
  // Normalize args — callers sometimes pass `false`/null for addons.
  platforms = Array.isArray(platforms) ? platforms : [];
  addons = Array.isArray(addons) ? addons : [];
  $('[data-platform]').each(function () {
    const required = $(this).data('platform');
    // Never force-show .section divs — their visibility is controlled by the
    // settings menu click handler only. Only hide/show nav items and badges.
    const isSection = $(this).hasClass('section');
    if (platforms.includes(required)) {
      if (!isSection) $(this).show();
    } else {
      $(this).hide();
    }
  });
  // Gate addon-specific nav items
  $('[data-addon]').each(function () {
    const required = $(this).data('addon');
    if (addons.includes(required)) {
      $(this).show();
    } else {
      $(this).hide();
    }
  });
  // Hide any category whose items are all hidden
  $('.menu-category').each(function () {
    const hasVisible = $(this).find('.menu-category-items .menu-element:visible').length > 0;
    if (!hasVisible) {
      $(this).hide();
    }
  });
}

// Display the local workspace label.
async function loadUserProfile() {
    $('#userName').text((window.I18n?.isReady() ? window.I18n.t('local.workspace') : 'Local workspace'));
    $('#communityNavLink').hide();
    applyPlatformAccess(['facebook', 'pinterest'], ['fb_groups']);
  }

// Initialize profile edit functionality


// Action Dropdown Toggle Handler
$(document).on("click", ".action-dropdown-toggle", function (e) {
  e.stopPropagation();
  e.preventDefault();

  const $dropdown = $(this).closest(".action-dropdown");
  const $menu = $dropdown.find(".action-dropdown-menu");
  const isOpen = $dropdown.hasClass("open");

  // Close all other dropdowns first
  $(".action-dropdown.open").not($dropdown).removeClass("open");

  // Toggle current dropdown
  if (isOpen) {
    $dropdown.removeClass("open");
  } else {
    // Position the menu using fixed positioning
    const toggleRect = this.getBoundingClientRect();

    // Temporarily show menu to get accurate dimensions
    $menu.css({ visibility: "hidden", display: "block" });
    const menuHeight = $menu.outerHeight() || 150;
    const menuWidth = $menu.outerWidth() || 160;
    $menu.css({ visibility: "", display: "" });

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Calculate position - prefer below and to the left of the toggle
    let top = toggleRect.bottom + 4;
    let left = toggleRect.right - menuWidth;

    // If menu would go below viewport, show it above the toggle
    if (top + menuHeight > viewportHeight - 10) {
      top = toggleRect.top - menuHeight - 4;
    }

    // If menu would go off left edge, align to left of toggle
    if (left < 10) {
      left = toggleRect.left;
    }

    // If menu would go off right edge
    if (left + menuWidth > viewportWidth - 10) {
      left = viewportWidth - menuWidth - 10;
    }

    $menu.css({
      top: top + "px",
      left: left + "px",
    });

    $dropdown.addClass("open");
  }
});

// Close dropdown when clicking on a menu item (not the toggle button itself)
$(document).on(
  "click",
  ".action-dropdown-menu .action-dropdown-item",
  function (e) {
    // Don't close immediately - let the click handler complete first
    setTimeout(() => {
      $(this).closest(".action-dropdown").removeClass("open");
    }, 10);
  },
);

// Close dropdown when clicking outside
$(document).on("click", function (e) {
  // Don't close if clicking on the toggle button (handled by toggle handler)
  if ($(e.target).closest(".action-dropdown-toggle").length) {
    return;
  }
  // Don't close if clicking inside the dropdown menu
  if ($(e.target).closest(".action-dropdown-menu").length) {
    return;
  }
  // Close all open dropdowns
  $(".action-dropdown.open").removeClass("open");
});

// Close dropdown on escape key
$(document).on("keydown", function (e) {
  if (e.key === "Escape") {
    $(".action-dropdown.open").removeClass("open");
  }
});

// ========================================
// GLOBAL MESSAGE NOTIFICATION SYSTEM
// ========================================

// Global notification state
window.messageNotificationState = {
  lastNotifiedId: 0,
  pollInterval: null,
  isActive: true,
  POLL_ACTIVE: 15000, // 15s when window focused
  POLL_INACTIVE: 45000, // 45s when window blurred
};

// Default avatar SVG for notifications
const DEFAULT_NOTIFICATION_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='50' fill='%236366f1'/%3E%3Ccircle cx='50' cy='38' r='18' fill='%23fff'/%3E%3Cellipse cx='50' cy='80' rx='30' ry='22' fill='%23fff'/%3E%3C/svg%3E";

// Initialize global message notifications
function initGlobalMessageNotifications() {
  console.log("[GlobalNotifications] Initializing...");

  // Start polling
  startGlobalNotificationPolling();

  // Track window focus for smart polling
  $(window).on("focus.globalNotifications", function () {
    window.messageNotificationState.isActive = true;
    startGlobalNotificationPolling();
  });

  $(window).on("blur.globalNotifications", function () {
    window.messageNotificationState.isActive = false;
    startGlobalNotificationPolling();
  });

  // Initial unread count check
  updateGlobalUnreadBadge();
}

// Start/restart notification polling with appropriate interval
function startGlobalNotificationPolling() {
  const state = window.messageNotificationState;

  // Clear existing interval
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
  }

  const interval = state.isActive ? state.POLL_ACTIVE : state.POLL_INACTIVE;

  state.pollInterval = setInterval(async () => {
    await checkGlobalNewMessages();
  }, interval);

  console.log(
    `[GlobalNotifications] Polling started (${interval / 1000}s interval)`,
  );
}

// Check for new messages globally
async function checkGlobalNewMessages() {
  const state = window.messageNotificationState;

  // Skip if currently on community page with chat panel open
  if (window.currentConversationId && $("#chat-panel").is(":visible")) {
    return;
  }

  try {
    const result = await window.electronAPI.checkNewMessages(
      state.lastNotifiedId,
    );

    // Stop polling if community is disabled server-side
    if (result.community_disabled) {
      if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
      }
      return;
    }

    if (result.success && result.hasNew) {
      // Update last notified ID
      state.lastNotifiedId = result.latestId;

      // Show notification toast
      showGlobalMessageNotification(
        result.sender,
        result.preview,
        result.conversationId,
      );

      // Update nav badge
      updateGlobalUnreadBadge(result.unreadCount);
    }
  } catch (error) {
    console.error("[GlobalNotifications] Error checking messages:", error);
  }
}

// Update the unread badge on Community nav item
async function updateGlobalUnreadBadge(count) {
  // If count not provided, fetch it
  if (typeof count === "undefined") {
    try {
      const result = await window.electronAPI.getUnreadCount();
      count = result.success ? result.count : 0;
    } catch (e) {
      count = 0;
    }
  }

  const navItem = $('a[data-page="community"], a[href="#community"]').closest(
    ".menu-element, .menu-item",
  );
  let badge = navItem.find(".nav-unread-badge");

  if (count > 0) {
    if (badge.length === 0) {
      navItem.css("position", "relative");
      navItem.append(
        `<span class="nav-unread-badge">${count > 99 ? "99+" : count}</span>`,
      );
    } else {
      badge.text(count > 99 ? "99+" : count);
    }
  } else {
    badge.remove();
  }
}

// Show the global message notification toast
function showGlobalMessageNotification(sender, preview, conversationId) {
  // Remove any existing notification
  $(".global-message-notification").remove();

  const avatarSrc = sender.avatar
    ? ''
    : DEFAULT_NOTIFICATION_AVATAR;

  const notificationHtml = `
        <div class="global-message-notification" data-conversation-id="${conversationId}" data-email="${sender.email}" data-name="${escapeHtml(sender.name)}">
            <img src="${avatarSrc}" alt="${escapeHtml(sender.name)}" class="notification-avatar">
            <div class="notification-content">
                <div class="notification-header">
                    <span class="notification-sender">${escapeHtml(sender.name)}</span>
                    <span class="notification-label">Message</span>
                </div>
                <div class="notification-preview">${escapeHtml(preview)}</div>
            </div>
            <button class="notification-close" onclick="event.stopPropagation(); closeGlobalNotification(this);">
                <i class="material-icons">close</i>
            </button>
            <div class="notification-progress">
                <div class="notification-progress-bar"></div>
            </div>
        </div>
    `;

  $("body").append(notificationHtml);

  // Auto-hide after 6 seconds
  setTimeout(() => {
    $(".global-message-notification").addClass("hiding");
    setTimeout(() => $(".global-message-notification").remove(), 300);
  }, 6000);
}

// Close notification helper
function closeGlobalNotification(button) {
  const notification = $(button).closest(".global-message-notification");
  notification.addClass("hiding");
  setTimeout(() => notification.remove(), 300);
}

// Click handler for notification - navigate to community and open conversation
$(document).on("click", ".global-message-notification", function (e) {
  if ($(e.target).closest(".notification-close").length) return;

  const convId = $(this).data("conversation-id");
  const email = $(this).data("email");
  const name = $(this).data("name");
  const avatar = $(this).find(".notification-avatar").attr("src");

  // Store conversation to open after page load
  window.pendingConversation = {
    id: convId,
    email: email,
    name: name,
    avatar: avatar,
  };

  // Remove notification
  $(this).addClass("hiding");
  setTimeout(() => $(this).remove(), 300);

  // Navigate to community page
  const communityLink = $('a[href="#community"]');
  if (communityLink.length) {
    communityLink.click();
  } else {
    // Fallback - load directly
    $(".menu .menu-element").removeClass("active");
    $('a[href="#community"]').addClass("active");
    $("#pagesContent").load("pages/community.html", function() {
      // Translate the newly loaded page content
      if (window.I18n && window.I18n.isReady()) {
        window.I18n.translatePage(document.getElementById('pagesContent'));
      }
    });
  }

  // Refresh badge after page loads and messages are marked as read
  setTimeout(() => {
    updateGlobalUnreadBadge();
  }, 2000);
});

// Helper function for escaping HTML in notifications
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

window.addEventListener("focus", () => {
  // Fix for Electron input focus bug - force repaint on window focus
  // This fixes the issue where inputs become unresponsive
  requestAnimationFrame(() => {
    document.body.style.opacity = '0.999';
    requestAnimationFrame(() => {
      document.body.style.opacity = '1';
    });
  });
});

// Additional fix: detect and fix stuck inputs by monitoring click events
document.addEventListener("click", (e) => {
  const target = e.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
    // If clicking on an input, ensure it gets focus
    requestAnimationFrame(() => {
      if (document.activeElement !== target) {
        target.focus();
      }
    });
  }
}, true);

// ========== App Close Confirmation ==========
// Global state for tracking unsaved changes in automation editor
window.hasUnsavedAutomation = false;

// ============================================
// Automation Video Export (frame-by-frame with animations)
// ============================================
if (window.electronAPI?.onAutoExportVideo) {
  window.electronAPI.onAutoExportVideo(async (data) => {
    const { exportSettings } = data;
    let project = data.project;
    let exportEngine = null;
    try {
      if (!window.VEPreviewEngine) {
        throw new Error("VEPreviewEngine not loaded");
      }

      project = { ...project, tracks: window.VEPreviewEngine.prepareEndingBuffer(project.tracks || []) };

      const w = (exportSettings.width || project.settings?.width || 1080) & ~1;
      const h = (exportSettings.height || project.settings?.height || 1920) & ~1;
      const fps = exportSettings.fps || project.settings?.fps || 30;

      let totalDuration = 0;
      for (const track of project.tracks || []) {
        for (const clip of track.clips || []) {
          const end = (clip.startTime || 0) + (clip.duration || 0);
          if (end > totalDuration) totalDuration = end;
        }
      }
      if (totalDuration <= 0) throw new Error("No content to export");

      const totalFrames = Math.ceil(totalDuration * fps);

      exportEngine = new window.VEPreviewEngine();
      exportEngine.initForExport(w, h, project.settings?.backgroundColor, project.settings?.backgroundType, project.settings?.blurIntensity);
      exportEngine.loadTracks(project.tracks);
      await exportEngine.waitForAssets();
      // Pre-extract every video clip to an even CFR JPEG sequence (FFmpeg) so
      // export never seeks the <video> element — eliminates judder/freezes.
      await exportEngine.prepareExportFrames(fps);

      // Collect audio clips
      const audioClips = [];
      for (const track of project.tracks || []) {
        if (!track.visible) continue;
        for (const clip of track.clips || []) {
          if (clip.type === "audio" && clip.source) {
            audioClips.push(clip);
          } else if (clip.type === "video" && clip.source && clip.volume !== 0) {
            audioClips.push({
              source: clip.source,
              startTime: clip.startTime || 0,
              duration: clip.duration || 5,
              volume: clip.volume ?? 1,
              trimStart: clip.trimStart || 0,
            });
          }
        }
      }

      const startResult = await window.electronAPI.startFrameExport({
        width: w,
        height: h,
        fps,
        format: exportSettings.format || "mp4",
        quality: exportSettings.quality || "high",
        outputPath: exportSettings.outputPath,
        audioClips,
        totalDuration,
      });

      if (!startResult?.success) throw new Error(startResult?.error || "Failed to start frame export");

      // NOTE: Renders are intentionally serialized (one frame fully rendered
      // before the next begins). All video clips share a single HTMLVideoElement
      // per clip, so rendering two frames concurrently would seek the same
      // element to two positions at once — causing stale/frozen frames in the
      // output.
      //
      // To use the otherwise-idle CPU and finish faster, the IPC write + FFmpeg
      // ingest of the CURRENT frame is overlapped with the rendering of the NEXT
      // frame (a 1-deep pipeline). This is safe: renderFrameForExport returns a
      // detached JPEG buffer, so the canvas is free to be redrawn immediately,
      // and keeping only one write in flight preserves ordering and back-pressure.
      let pendingWrite = null;
      for (let frame = 0; frame < totalFrames; frame++) {
        const frameData = await exportEngine.renderFrameForExport(frame / fps, 0.80, fps);

        if (pendingWrite) {
          const prev = await pendingWrite;
          pendingWrite = null;
          if (!prev?.success) throw new Error(prev?.error || "Failed to write frame");
          if (prev.done) { break; } // FFmpeg finished — stop
        }

        pendingWrite = window.electronAPI.writeExportFrame(frameData);
        if (frame % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      if (pendingWrite) {
        const last = await pendingWrite;
        if (!last?.success) throw new Error(last?.error || "Failed to write frame");
      }

      const result = await window.electronAPI.finishFrameExport();
      exportEngine.destroyExport();
      exportEngine = null;

      window.electronAPI.autoExportResult({
        success: !!result?.success,
        outputPath: result?.success ? exportSettings.outputPath : undefined,
        error: result?.success ? undefined : (result?.error || "Finalize failed"),
      });
    } catch (err) {
      if (exportEngine) { try { exportEngine.destroyExport(); } catch (_) {} }
      // Always cancel/clean up the FFmpeg export state so the next queued
      // export doesn't get blocked by "Another export is already in progress"
      try { await window.electronAPI.cancelVideoExport(); } catch (_) {}
      console.error("[AutoExport] Error:", err);
      window.electronAPI.autoExportResult({ success: false, error: err.message });
    }
  });
}

// Listen for close confirmation request from main process (Alt+F4, system close, etc.)
if (window.electronAPI?.onShowCloseConfirmation) {
  window.electronAPI.onShowCloseConfirmation(() => {
    // Trigger the same close confirmation flow as the close button
    window.handleAppClose();
  });
}

// Handle app close with confirmation for running processes
window.handleAppClose = async function() {
  try {
    // Collect all warnings
    const warnings = [];
    
    // Check for running workflows and spy processes via IPC
    const statusResult = await window.electronAPI.getAppCloseStatus();
    if (statusResult && statusResult.warnings) {
      warnings.push(...statusResult.warnings);
    }
    
    // Check for active spy sessions in spyManager (frontend state)
    if (window.spyManager && window.spyManager.hasActiveSessions && window.spyManager.hasActiveSessions()) {
      const sessionCount = window.spyManager.sessions.size;
      // Only add if not already detected by backend
      const hasBackendSpy = warnings.some(w => w.type === 'spy');
      if (!hasBackendSpy) {
        warnings.push({ type: 'spy', count: sessionCount });
      }
    }
    
    // Check for unsaved automation changes
    if (window.hasUnsavedAutomation) {
      warnings.push({ type: 'unsaved_automation' });
    }
    
    // If no warnings, show simple confirmation
    if (warnings.length === 0) {
      showExitConfirmationModal([]);
      return;
    }
    
    // Build warning message
    const warningItems = [];
    for (const warning of warnings) {
      if (warning.type === 'workflows') {
        const statusText = warning.status === 'running' 
          ? (window.I18n?.t('exit_warning.running_workflows') || `${warning.count} running workflow(s)`)
          : (window.I18n?.t('exit_warning.queued_workflows') || `${warning.count} queued workflow(s)`);
        warningItems.push(statusText.replace('{{count}}', warning.count));
      } else if (warning.type === 'spy') {
        const spyText = window.I18n?.t('exit_warning.active_spy') || `${warning.count} active spy session(s)`;
        warningItems.push(spyText.replace('{{count}}', warning.count));
      } else if (warning.type === 'unsaved_automation') {
        warningItems.push(window.I18n?.t('exit_warning.unsaved_automation') || 'Unsaved automation changes');
      }
    }
    
    // Show confirmation modal
    showExitConfirmationModal(warningItems);
    
  } catch (error) {
    console.error('[handleAppClose] Error checking status:', error);
    // On error, just close
    window.electronAPI.forceClose();
  }
};

// Show exit confirmation modal
function showExitConfirmationModal(warningItems) {
  // Remove existing modal if any
  $('#exitConfirmModal').remove();
  
  const title = window.I18n?.t('exit_warning.title') || 'Are you sure you want to close?';
  const cancelText = window.I18n?.t('common.cancel') || 'Cancel';
  const closeText = window.I18n?.t('exit_warning.close_anyway') || 'Close Anyway';
  
  let bodyHtml = '';
  if (warningItems.length > 0) {
    const subtitle = window.I18n?.t('exit_warning.subtitle') || 'The following processes are still active:';
    const warningListHtml = warningItems.map(item => `
      <li style="margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
        <span class="material-icons" style="color: #f59e0b; font-size: 18px;">warning</span>
        <span>${item}</span>
      </li>
    `).join('');
    bodyHtml = `
      <div class="modal-body" style="padding: 20px 24px;">
        <p style="color: rgba(255,255,255,0.7); margin-bottom: 16px;">${subtitle}</p>
        <ul style="list-style: none; padding: 0; margin: 0; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 16px;">
          ${warningListHtml}
        </ul>
      </div>`;
  }
  
  const modalHtml = `
    <div class="modal fade" id="exitConfirmModal" tabindex="-1" data-bs-backdrop="static">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content" style="border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);">
          <div class="modal-header" style="border-bottom: 1px solid rgba(255,255,255,0.1); padding: 20px 24px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); display: flex; align-items: center; justify-content: center;">
                <span class="material-icons" style="color: white; font-size: 22px;">warning</span>
              </div>
              <h5 class="modal-title" style="margin: 0; font-weight: 600;">${title}</h5>
            </div>
          </div>
          ${bodyHtml}
          <div class="modal-footer" style="border-top: 1px solid rgba(255,255,255,0.1); padding: 16px 24px; gap: 12px;">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" style="border-radius: 8px; padding: 10px 20px;">
              ${cancelText}
            </button>
            <button type="button" class="btn btn-danger" id="exitConfirmBtn" style="border-radius: 8px; padding: 10px 20px; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); border: none;">
              ${closeText}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  $('body').append(modalHtml);
  
  const modal = new bootstrap.Modal(document.getElementById('exitConfirmModal'));
  modal.show();

  // Ensure the exit confirmation renders above the access-revoked lockout
  // overlay (which uses a very high z-index). Bootstrap's default modal
  // z-index is far lower, so it would otherwise be hidden behind the overlay.
  const exitModalEl = document.getElementById('exitConfirmModal');
  if (exitModalEl) exitModalEl.style.zIndex = "2147483647";
  // Bootstrap appends its backdrop to <body> after show(); push it up too.
  const backdrops = document.querySelectorAll('.modal-backdrop');
  const lastBackdrop = backdrops[backdrops.length - 1];
  if (lastBackdrop) lastBackdrop.style.zIndex = "2147483646";
  
  // Handle confirm button
  $('#exitConfirmBtn').on('click', function() {
    modal.hide();
    window.electronAPI.forceClose();
  });
  
  // Cleanup on modal hidden
  $('#exitConfirmModal').on('hidden.bs.modal', function() {
    $(this).remove();
  });
}
