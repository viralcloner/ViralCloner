/**
 * Video Editor - Page Controller
 * Handles page init/cleanup, project CRUD, panel management, and all UI interactions
 */
(function () {
  "use strict";

  const NS = ".videoEditor";
  let previewEngine = null;
  let timeline = null;
  let exportDialog = null;
  let currentProject = null;
  let undoStack = [];
  let redoStack = [];
  let autoSaveInterval = null;
  let panelOpen = "media";

  // ============================================
  // Page Initialization
  // ============================================

  window.initVideoEditor = async function () {
    await loadProjectList();

    // Translate dynamic content if i18n is ready
    if (window.I18n && window.I18n.isReady()) {
      window.I18n.translatePage(document.getElementById("pagesContent"));
    }

    registerEvents();
  };

  // ============================================
  // Page Cleanup
  // ============================================

  window.currentPageCleanup = function () {
    $(document).off(NS);

    // Remove context menu from body
    $("#ve-context-menu").remove();

    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
      autoSaveInterval = null;
    }

    // Save current project before leaving
    if (currentProject) {
      saveProject(true);
    }

    if (previewEngine) {
      previewEngine.destroy();
      previewEngine = null;
    }

    if (timeline) {
      timeline.destroy();
      timeline = null;
    }

    exportDialog = null;
    currentProject = null;
    undoStack = [];
    redoStack = [];
  };

  // ============================================
  // Event Registration
  // ============================================

  function registerEvents() {
    // New project button
    $(document).on("click" + NS, "#ve-new-project-btn, #ve-empty-new-btn", () => {
      showNewProjectModal();
    });

    // Modal events
    $(document).on("click" + NS, "#ve-modal-close-btn, #ve-modal-cancel-btn", () => {
      $("#ve-new-project-modal").fadeOut(200);
    });

    $(document).on("click" + NS, "#ve-modal-create-btn", () => {
      createProject();
    });

    // Resolution presets
    $(document).on("click" + NS, ".ve-resolution-btn", function () {
      $(".ve-resolution-btn").removeClass("active");
      $(this).addClass("active");
      const w = $(this).data("w");
      const h = $(this).data("h");
      if (w === 0 && h === 0) {
        $("#ve-custom-res").show();
      } else {
        $("#ve-custom-res").hide();
      }
    });

    // Background type change (properties panel)
    $(document).on("change" + NS, "#ve-bg-type-select", function () {
      const bgType = $(this).val();
      if (bgType === "blur") {
        $("#ve-bg-color-controls").hide();
        $("#ve-bg-blur-controls").show();
      } else {
        $("#ve-bg-color-controls").show();
        $("#ve-bg-blur-controls").hide();
      }
      applyBackgroundSettings({ backgroundType: bgType });
    });

    // Live background color change (properties panel)
    $(document).on("input" + NS, "#ve-live-bg-color", function () {
      const color = $(this).val();
      $("#ve-live-bg-hex").val(color);
      applyBackgroundSettings({ backgroundColor: color });
    });

    $(document).on("change" + NS, "#ve-live-bg-hex", function () {
      let color = $(this).val().trim();
      if (/^#[0-9a-fA-F]{6}$/.test(color)) {
        $("#ve-live-bg-color").val(color);
        applyBackgroundSettings({ backgroundColor: color });
      }
    });

    // Blur intensity slider
    $(document).on("input" + NS, "#ve-blur-intensity", function () {
      const val = parseInt($(this).val(), 10);
      $("#ve-blur-intensity-val").text(val + "px");
      applyBackgroundSettings({ blurIntensity: val });
    });

    // Project card click
    $(document).on("click" + NS, ".ve-project-card", function (e) {
      if ($(e.target).closest(".ve-project-card-actions").length) return;
      const projectId = $(this).data("project-id");
      openProject(projectId);
    });

    // Project card delete
    $(document).on("click" + NS, ".ve-project-delete-btn", function (e) {
      e.stopPropagation();
      const projectId = $(this).data("project-id");
      deleteProject(projectId);
    });

    // Project card export file
    $(document).on("click" + NS, ".ve-project-export-btn", function (e) {
      e.stopPropagation();
      const projectId = $(this).data("project-id");
      exportProjectFileById(projectId);
    });

    // Import project file button (project list header)
    $(document).on("click" + NS, "#ve-import-project-btn", () => {
      importProjectFile();
    });

    // ---- Editor Events ----

    // Back button
    $(document).on("click" + NS, "#ve-back-btn", () => {
      closeEditor();
    });

    // Save button
    $(document).on("click" + NS, "#ve-save-btn", () => {
      saveProject();
    });

    // Export project file button (editor toolbar)
    $(document).on("click" + NS, "#ve-export-project-btn", () => {
      exportProjectFile();
    });

    // Project title change
    $(document).on("change" + NS, "#ve-project-title", function () {
      if (currentProject) {
        currentProject.name = $(this).val();
      }
    });

    // Undo/Redo
    $(document).on("click" + NS, "#ve-undo-btn", () => undo());
    $(document).on("click" + NS, "#ve-redo-btn", () => redo());

    // Keyboard shortcuts
    $(document).on("keydown" + NS, (e) => {
      if (!currentProject) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

      if (e.ctrlKey && e.key === "z") { e.preventDefault(); undo(); }
      if (e.ctrlKey && e.key === "y") { e.preventDefault(); redo(); }
      if (e.ctrlKey && e.key === "s") { e.preventDefault(); saveProject(); }
      if (e.key === " ") { e.preventDefault(); previewEngine?.togglePlay(); }
      if (e.key === "Delete" && timeline?.selectedClipId) {
        deleteSelectedClip();
      }
    });

    // Sidebar panel toggle
    $(document).on("click" + NS, ".ve-sidebar-btn", function () {
      const panel = $(this).data("panel");
      $(".ve-sidebar-btn").removeClass("active");
      $(this).addClass("active");

      if (panelOpen === panel) {
        // Toggle off
        $("#ve-side-panel").removeClass("open");
        panelOpen = null;
      } else {
        panelOpen = panel;
        loadPanel(panel);
        $("#ve-side-panel").addClass("open");
      }
    });

    // Side panel close
    $(document).on("click" + NS, "#ve-panel-close-btn", () => {
      $("#ve-side-panel").removeClass("open");
      $(".ve-sidebar-btn").removeClass("active");
      panelOpen = null;
    });

    // Click on canvas container (outside the canvas) deselects fabric objects
    $(document).on("mousedown" + NS, "#ve-canvas-container", (e) => {
      if (e.target.tagName === "CANVAS") return;
      if (previewEngine?.canvas) {
        previewEngine.canvas.discardActiveObject();
        previewEngine.canvas.renderAll();
      }
    });

    // Click on timeline empty space deselects everything
    $(document).on("mousedown" + NS, "#ve-timeline-tracks-scroll", (e) => {
      if ($(e.target).closest(".ve-clip").length) return;
      timeline?.selectClip(null);
    });

    // Playback controls
    $(document).on("click" + NS, "#ve-play-btn", () => {
      previewEngine?.togglePlay();
    });

    $(document).on("click" + NS, "#ve-skip-start-btn", () => {
      previewEngine?.seek(0);
    });

    $(document).on("click" + NS, "#ve-skip-end-btn", () => {
      previewEngine?.seek(previewEngine?.duration || 0);
    });

    $(document).on("change" + NS, "#ve-speed-select", function () {
      previewEngine?.setSpeed(parseFloat($(this).val()));
    });

    $(document).on("click" + NS, "#ve-mute-btn", () => {
      const muted = previewEngine?.toggleMute();
      $("#ve-mute-btn .material-icons").text(muted ? "volume_off" : "volume_up");
    });

    $(document).on("input" + NS, "#ve-volume-slider", function () {
      previewEngine?.setVolume(parseInt($(this).val(), 10) / 100);
    });

    // Export
    $(document).on("click" + NS, "#ve-export-btn", () => {
      exportDialog?.show();
    });

    $(document).on("click" + NS, "#ve-export-close-btn, #ve-export-cancel-btn", () => {
      exportDialog?.hide();
    });

    $(document).on("click" + NS, "#ve-export-start-btn", () => {
      if (currentProject) exportDialog?.startExport(currentProject);
    });

    // Timeline toolbar
    $(document).on("click" + NS, "#ve-add-track-btn", () => {
      showAddTrackMenu();
    });

    $(document).on("click" + NS, "#ve-split-btn", () => {
      if (timeline?.selectedClipId && previewEngine) {
        timeline.splitClip(timeline.selectedClipId, previewEngine.currentTime);
        pushUndoState();
        syncTracksToPreview();
      }
    });

    $(document).on("click" + NS, "#ve-delete-clip-btn", () => {
      deleteSelectedClip();
    });

    $(document).on("click" + NS, "#ve-snap-btn", () => {
      const enabled = timeline?.toggleSnap();
      $("#ve-snap-btn").toggleClass("active", enabled);
    });

    $(document).on("input" + NS, "#ve-tl-zoom-slider", function () {
      const val = parseInt($(this).val(), 10);
      timeline?.setZoom(val);
    });

    // Timeline resize handle
    let tlResizing = false;
    let tlStartY = 0;
    let tlStartH = 0;

    $(document).on("mousedown" + NS, "#ve-timeline-resize", function (e) {
      tlResizing = true;
      tlStartY = e.clientY;
      tlStartH = $("#ve-timeline").height();
      e.preventDefault();
    });

    $(document).on("mousemove" + NS, function (e) {
      if (!tlResizing) return;
      const dy = tlStartY - e.clientY;
      const newH = Math.max(120, Math.min(400, tlStartH + dy));
      $("#ve-timeline").css("height", newH + "px");
    });

    $(document).on("mouseup" + NS, function () {
      tlResizing = false;
    });

    // Context menu
    $(document).on("click" + NS, ".ve-ctx-item", function () {
      const action = $(this).data("action");
      handleContextAction(action);
      $("#ve-context-menu").hide();
    });

    // Close context menu on click elsewhere
    $(document).on("click" + NS, function (e) {
      if (!$(e.target).closest(".ve-context-menu").length) {
        $("#ve-context-menu").hide();
      }
    });
  }

  // ============================================
  // Project CRUD
  // ============================================

  async function loadProjectList() {
    try {
      const projects = await window.electronAPI.readKey("videoProjects") || [];

      if (projects.length === 0) {
        $("#ve-projects-grid").hide();
        $("#ve-empty-state").show();
        return;
      }

      $("#ve-empty-state").hide();
      $("#ve-projects-grid").show();

      let html = "";
      for (const proj of projects) {
        html += '<div class="ve-project-card" data-project-id="' + proj.id + '">';
        html += '  <div class="ve-project-card-thumb">';
        if (proj.thumbnail) {
          html += '    <img src="' + proj.thumbnail + '" alt="">';
        } else {
          html += '    <span class="material-icons">movie</span>';
        }
        html += "  </div>";
        html += '  <div class="ve-project-card-info">';
        html += "    <h4>" + escapeHtml(proj.name || "Untitled");
        if (proj.isTemplate) html += ' <span class="ve-template-badge">' + (window.I18n?.t("videoeditor.template_badge") || "Template") + '</span>';
        html += "</h4>";
        html += "    <span>" + formatDate(proj.updatedAt || proj.createdAt) + " · " + (proj.settings?.width || 1920) + "×" + (proj.settings?.height || 1080) + "</span>";
        html += "  </div>";
        html += '  <div class="ve-project-card-actions">';
        html += '    <button class="ve-project-export-btn" data-project-id="' + proj.id + '" title="' + (window.I18n?.t("videoeditor.export_project") || "Export Project File") + '">';
        html += '      <span class="material-icons">file_download</span>';
        html += "    </button>";
        html += '    <button class="ve-project-delete-btn" data-project-id="' + proj.id + '" title="Delete">';
        html += '      <span class="material-icons">delete</span>';
        html += "    </button>";
        html += "  </div>";
        html += "</div>";
      }

      $("#ve-projects-grid").html(html);
    } catch (err) {
      console.error("[VideoEditor] Error loading projects:", err);
    }
  }

  function showNewProjectModal() {
    $("#ve-project-name-input").val("");
    $(".ve-resolution-btn").removeClass("active");
    $(".ve-resolution-btn[data-label='9:16']").addClass("active");
    $("#ve-custom-res").hide();
    $("#ve-new-project-modal").fadeIn(200);
  }

  async function createProject() {
    const name = $("#ve-project-name-input").val().trim() || (window.I18n?.t("videoeditor.untitled") || "Untitled Project");
    const activeRes = $(".ve-resolution-btn.active");
    let w = parseInt(activeRes.data("w"), 10) || 1080;
    let h = parseInt(activeRes.data("h"), 10) || 1920;

    if (w === 0 || h === 0) {
      w = parseInt($("#ve-custom-w").val(), 10) || 1920;
      h = parseInt($("#ve-custom-h").val(), 10) || 1080;
    }

    const project = {
      id: "vep_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      thumbnail: null,
      settings: { width: w, height: h, fps: 30, backgroundColor: "#ffffff", backgroundType: "color", blurIntensity: 30 },
      tracks: [
        { id: "track_1", type: "video", name: "Video 1", locked: false, visible: true, clips: [] },
        { id: "track_2", type: "audio", name: "Audio 1", locked: false, visible: true, clips: [] }
      ]
    };

    const projects = await window.electronAPI.readKey("videoProjects") || [];
    projects.unshift(project);
    await window.electronAPI.updateData("videoProjects", projects);

    $("#ve-new-project-modal").fadeOut(200);
    openProject(project.id);
  }

  async function deleteProject(projectId) {
    const confirmed = await veConfirm(window.I18n?.t("videoeditor.delete_confirm") || "Delete this project? This cannot be undone.");
    if (!confirmed) return;

    let projects = await window.electronAPI.readKey("videoProjects") || [];
    projects = projects.filter((p) => p.id !== projectId);
    await window.electronAPI.updateData("videoProjects", projects);

    // Remove associated template (both new-style by projectId and old-style by embedded project.id)
    let templates = await window.electronAPI.readKey("videoTemplates") || [];
    templates = templates.filter((t) => t.projectId !== projectId && !(t.project && t.project.id === projectId));
    await window.electronAPI.updateData("videoTemplates", templates);

    await loadProjectList();
  }

  async function openProject(projectId) {
    const projects = await window.electronAPI.readKey("videoProjects") || [];
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;

    currentProject = JSON.parse(JSON.stringify(project)); // Deep clone

    // Ensure defaults for older projects
    if (!currentProject.settings.backgroundColor) {
      currentProject.settings.backgroundColor = "#ffffff";
    }
    if (!currentProject.settings.backgroundType) {
      currentProject.settings.backgroundType = "color";
    }
    if (!currentProject.settings.blurIntensity) {
      currentProject.settings.blurIntensity = 30;
    }

    // Switch to editor view
    $("#ve-project-list").hide();
    $("#ve-editor").show();
    $("#ve-project-title").val(currentProject.name);

    // Initialize engines
    initEditor();
  }

  async function closeEditor() {
    // Save before closing
    await saveProject(true);

    // Cleanup engines
    if (previewEngine) {
      previewEngine.destroy();
      previewEngine = null;
    }
    if (timeline) {
      timeline.destroy();
      timeline = null;
    }
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
      autoSaveInterval = null;
    }

    currentProject = null;
    $("#ve-editor").hide();
    $("#ve-project-list").show();
    loadProjectList();
  }

  async function saveProject(silent) {
    if (!currentProject) return;

    currentProject.updatedAt = Date.now();
    currentProject.name = $("#ve-project-title").val() || currentProject.name;

    // Capture thumbnail
    if (previewEngine) {
      const thumb = previewEngine.getThumbnail();
      if (thumb) currentProject.thumbnail = thumb;
    }

    // Save tracks from timeline
    if (timeline) {
      currentProject.tracks = JSON.parse(JSON.stringify(timeline.tracks));
    }

    try {
      let projects = (await window.electronAPI.readKey("videoProjects") || []).filter(Boolean);
      const idx = projects.findIndex((p) => p.id === currentProject.id);
      if (idx >= 0) {
        projects[idx] = currentProject;
      } else {
        projects.unshift(currentProject);
      }
      await window.electronAPI.updateData("videoProjects", projects);

      // Auto-sync template when project has placeholders
      await syncTemplate(currentProject);

      if (!silent) {
        showToast(window.I18n?.t("videoeditor.saved") || "Project saved");
      }
    } catch (err) {
      console.error("[VideoEditor] Save error:", err);
    }
  }

  // ============================================
  // Editor Initialization
  // ============================================

  function initEditor() {
    // Move context menu to body to avoid overflow clipping from parent containers
    const ctxMenu = document.getElementById("ve-context-menu");
    if (ctxMenu && ctxMenu.parentElement !== document.body) {
      document.body.appendChild(ctxMenu);
    }

    // Initialize preview engine
    previewEngine = new window.VEPreviewEngine();
    previewEngine.projectSettings = { ...currentProject.settings };

    const containerEl = document.getElementById("ve-canvas-container");
    previewEngine.init("ve-preview-canvas", containerEl);

    // Initialize timeline
    timeline = new window.VETimeline();
    timeline.init();
    timeline.loadTracks(currentProject.tracks || []);

    // Initialize export dialog
    exportDialog = new window.VEExportDialog();
    exportDialog.init(NS);

    // Wire up callbacks
    previewEngine.onTimeUpdate = (current, total) => {
      updateTimeDisplay(current, total);
      timeline?.setCurrentTime(current);
    };

    previewEngine.onPlayStateChange = (playing) => {
      const icon = playing ? "pause" : "play_arrow";
      $("#ve-play-btn .material-icons").text(icon);
      if (playing) timeline?.scrollToPlayhead();
    };

    previewEngine.onClipSelect = (clipId) => {
      timeline?.selectClip(clipId);
      showClipProperties(clipId);
    };

    timeline.onClipSelect = (clipId) => {
      previewEngine?.selectClip(clipId);
      showClipProperties(clipId);
    };

    timeline.onClipMove = () => {
      pushUndoState();
      syncTracksToPreview();
    };

    timeline.onClipResize = () => {
      pushUndoState();
      syncTracksToPreview();
    };

    timeline.onSeek = (time) => {
      previewEngine?.seek(time);
    };

    timeline.onTrackChange = () => {
      // Only mark for save, don't rebuild preview (callers handle sync explicitly)
    };

    timeline.onClipContextMenu = (clipId, x, y) => {
      showContextMenu(clipId, x, y);
    };

    timeline.onClipDrop = (mediaData, time, trackIndex) => {
      handleMediaDrop(mediaData, time, trackIndex);
    };

    // Load tracks into preview engine
    previewEngine.loadTracks(currentProject.tracks || []);

    // Open media panel by default
    panelOpen = "media";
    loadPanel("media");
    $("#ve-side-panel").addClass("open");

    // Show background color in properties panel by default
    showClipProperties(null);

    // Auto-save every 30 seconds
    autoSaveInterval = setInterval(() => saveProject(true), 30000);

    // Initial undo state
    pushUndoState();
  }

  function syncTracksToPreview() {
    if (timeline && previewEngine) {
      previewEngine.loadTracks(timeline.tracks);
    }
  }

  function applyBackgroundSettings(updates) {
    if (!currentProject) return;
    Object.assign(currentProject.settings, updates);
    if (previewEngine) {
      previewEngine.updateSettings(updates, document.getElementById("ve-canvas-container"));
      previewEngine.renderFrame(previewEngine.currentTime);
    }
    pushUndoState();
  }

  function updateTimeDisplay(current, total) {
    $("#ve-current-time").text(formatTimecode(current));
    $("#ve-total-time").text(formatTimecode(total));
  }

  // ============================================
  // Panel Management
  // ============================================

  function loadPanel(panel) {
    const titles = {
      media: window.I18n?.t("videoeditor.media") || "Media",
      text: window.I18n?.t("videoeditor.text") || "Text",
      elements: window.I18n?.t("videoeditor.elements") || "Elements",
      musics: window.I18n?.t("videoeditor.musics") || "Musics",
      filters: window.I18n?.t("videoeditor.filters") || "Filters",
      ai: window.I18n?.t("videoeditor.ai_tools") || "AI Tools",
      placeholders: window.I18n?.t("videoeditor.placeholders") || "Placeholders",
      subtitles: window.I18n?.t("videoeditor.subtitles") || "Subtitles"
    };

    $("#ve-panel-title").text(titles[panel] || panel);

    const content = $("#ve-panel-content");
    switch (panel) {
      case "media": renderMediaPanel(content); break;
      case "text": renderTextPanel(content); break;
      case "elements": renderElementsPanel(content); break;
      case "musics": renderMusicsPanel(content); break;
      case "filters": renderFiltersPanel(content); break;
      case "ai": renderAIPanel(content); break;
      case "placeholders": renderPlaceholdersPanel(content); break;
      case "subtitles": renderSubtitlesPanel(content); break;
    }
  }

  // ---- Media Panel ----
  function renderMediaPanel(container) {
    let html = '<button class="ve-media-import-btn" id="ve-import-media-btn">';
    html += '  <span class="material-icons">add_photo_alternate</span>';
    html += '  <span>' + (window.I18n?.t("videoeditor.import_media") || "Import Video or Image") + "</span>";
    html += "</button>";

    html += '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + (window.I18n?.t("videoeditor.project_media") || "Project Media") + "</div>";
    html += '  <div class="ve-media-grid" id="ve-media-grid"></div>';
    html += "</div>";

    container.html(html);

    // Load existing project media
    loadProjectMedia();

    // Import button handler
    $(document).off("click" + NS, "#ve-import-media-btn");
    $(document).on("click" + NS, "#ve-import-media-btn", async () => {
      try {
        const result = await window.electronAPI.showOpenDialog({
          properties: ["openFile", "multiSelections"],
          filters: [
            { name: "Media Files", extensions: ["mp4", "webm", "mov", "avi", "mkv", "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"] }
          ]
        });

        if (result && result.length > 0) {
          if (!currentProject.media) currentProject.media = [];
          for (const filePath of result) {
            const ext = filePath.split(".").pop().toLowerCase();
            const isVideo = ["mp4", "webm", "mov", "avi", "mkv"].includes(ext);
            let safePath = filePath;
            let displayName = filePath.split(/[/\\]/).pop();
            const copyResult = await window.electronAPI.veImportMediaFile({ filePath });
            if (copyResult.success) {
              safePath = copyResult.filePath;
              displayName = copyResult.name;
            } else {
              console.warn("[VideoEditor] Could not copy media to safe location, using original path:", copyResult.error);
            }
            const media = {
              id: "media_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
              type: isVideo ? "video" : "image",
              source: safePath,
              name: displayName
            };
            currentProject.media.push(media);
          }
          loadProjectMedia();
        }
      } catch (err) {
        console.error("[VideoEditor] Import error:", err);
      }
    });
  }

  function loadProjectMedia() {
    const mediaGrid = $("#ve-media-grid");
    if (!mediaGrid.length) return;

    const media = currentProject?.media || [];
    if (media.length === 0) {
      mediaGrid.html('<p style="color: var(--text-secondary); font-size: 12px; grid-column: 1/-1; text-align: center;">' +
        (window.I18n?.t("videoeditor.no_media") || "No media imported yet") + "</p>");
      return;
    }

    let html = "";
    for (const m of media) {
      html += '<div class="ve-media-item" draggable="true" data-media-id="' + m.id + '" data-type="' + m.type + '" data-source="' + escapeAttr(m.source) + '">';
      if (m.type === "image") {
        html += '<img src="' + escapeAttr(m.source) + '" alt="">';
        html += '<span class="ve-media-type-icon"><span class="material-icons">image</span></span>';
      } else if (m.type === "audio") {
        html += '<div class="ve-media-audio-placeholder"><span class="material-icons">music_note</span></div>';
        html += '<span class="ve-media-duration">--:--</span>';
      } else {
        html += '<video src="' + escapeAttr(m.source) + '" muted preload="metadata"></video>';
        html += '<span class="ve-media-type-icon"><span class="material-icons">videocam</span></span>';
        html += '<span class="ve-media-duration">--:--</span>';
      }
      html += '<button class="ve-media-delete-btn" data-media-id="' + m.id + '" title="Delete"><span class="material-icons">close</span></button>';
      html += "</div>";
    }
    mediaGrid.html(html);

    // Setup drag events
    mediaGrid.find(".ve-media-item").each(function () {
      this.addEventListener("dragstart", (e) => {
        const data = {
          type: $(this).data("type"),
          source: $(this).data("source"),
          mediaId: $(this).data("media-id")
        };
        e.dataTransfer.setData("application/ve-media", JSON.stringify(data));
      });

      // Double-click to add to timeline at playhead
      $(this).on("dblclick", function () {
        const type = $(this).data("type");
        const source = $(this).data("source");
        addMediaToTimeline(type, source);
      });
    });

    // Delete media item
    mediaGrid.off("click" + NS, ".ve-media-delete-btn");
    mediaGrid.on("click" + NS, ".ve-media-delete-btn", async function (e) {
      e.stopPropagation();
      const mediaId = $(this).data("media-id");
      const confirmed = await confirmPrompt();
      if (!confirmed) return;
      await removeMediaFromProject(mediaId);
    });

    // Get video durations
    mediaGrid.find("video").each(function () {
      $(this).on("loadedmetadata", function () {
        const dur = formatTimecode(this.duration);
        $(this).siblings(".ve-media-duration").text(dur);
      });
    });

    // Get audio durations
    mediaGrid.find(".ve-media-audio-placeholder").each(function () {
      const source = $(this).closest(".ve-media-item").data("source");
      const durationEl = $(this).siblings(".ve-media-duration");
      const audio = new Audio();
      audio.addEventListener("loadedmetadata", function () {
        durationEl.text(formatTimecode(audio.duration));
      });
      audio.src = source;
    });
  }

  // ---- Text Panel ----
  function renderTextPanel(container) {
    let html = '<div class="ve-text-presets">';
    const presets = [
      { key: "title", class: "ve-text-preset-title", text: "Add Title", fontSize: 64, fontWeight: "bold" },
      { key: "subtitle", class: "ve-text-preset-subtitle", text: "Add Subtitle", fontSize: 40, fontWeight: "500" },
      { key: "body", class: "ve-text-preset-body", text: "Add Body Text", fontSize: 24, fontWeight: "normal" },
      { key: "caption", class: "ve-text-preset-caption", text: "Add Caption", fontSize: 18, fontWeight: "normal", fontStyle: "italic" },
      { key: "lower_third", class: "ve-text-preset-lower-third", text: "Lower Third", fontSize: 28, fontWeight: "600", backgroundColor: "rgba(102,126,234,0.85)" }
    ];

    for (const p of presets) {
      const label = window.I18n?.t("videoeditor.text_" + p.key) || p.text;
      html += '<button class="ve-text-preset" data-preset="' + p.key + '">';
      html += '  <span class="' + p.class + '">' + label + "</span>";
      html += "</button>";
    }
    html += "</div>";

    html += '<div class="ve-panel-section" style="margin-top: 20px;">';
    html += '  <div class="ve-panel-section-title">' + (window.I18n?.t("videoeditor.text_animation") || "Default Animation") + "</div>";
    html += '  <select class="ve-anim-select" id="ve-text-default-anim">';
    html += '    <option value="none">' + (window.I18n?.t("videoeditor.anim_none") || "None") + "</option>";
    html += '    <option value="fadeIn">' + (window.I18n?.t("videoeditor.anim_fade_in") || "Fade In") + "</option>";
    html += '    <option value="slideUp">' + (window.I18n?.t("videoeditor.anim_slide_up") || "Slide Up") + "</option>";
    html += '    <option value="slideLeft">' + (window.I18n?.t("videoeditor.anim_slide_left") || "Slide Left") + "</option>";
    html += '    <option value="typewriter">' + (window.I18n?.t("videoeditor.anim_typewriter") || "Typewriter") + "</option>";
    html += '    <option value="bounce">' + (window.I18n?.t("videoeditor.anim_bounce") || "Bounce") + "</option>";
    html += '    <option value="scaleIn">' + (window.I18n?.t("videoeditor.anim_scale_in") || "Scale In") + "</option>";
    html += "  </select>";
    html += "</div>";

    container.html(html);

    $(document).off("click" + NS, ".ve-text-preset");
    $(document).on("click" + NS, ".ve-text-preset", function () {
      const key = $(this).data("preset");
      const preset = presets.find((p) => p.key === key);
      if (!preset) return;

      const anim = $("#ve-text-default-anim").val() || "none";
      const clip = {
        type: "text",
        text: preset.text,
        startTime: previewEngine?.currentTime || 0,
        duration: 5,
        position: { x: 100, y: 100 },
        fontSize: preset.fontSize,
        fontFamily: "Arial",
        fontColor: "#ffffff",
        fontWeight: preset.fontWeight || "normal",
        fontStyle: preset.fontStyle || "normal",
        textAlign: "center",
        backgroundColor: preset.backgroundColor || "",
        opacity: 1,
        animation: anim,
        name: preset.text
      };

      addClipToTimeline(clip, "text");
    });
  }

  // ---- Elements Panel ----
  function renderElementsPanel(container) {
    let html = '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + (window.I18n?.t("videoeditor.shapes") || "Shapes") + "</div>";
    html += '  <div class="ve-shapes-grid">';

    const shapes = [
      { icon: "rectangle", label: "Rectangle", shape: "rect" },
      { icon: "circle", label: "Circle", shape: "circle" },
      { icon: "change_history", label: "Triangle", shape: "triangle" },
      { icon: "horizontal_rule", label: "Line", shape: "line" },
      { icon: "arrow_forward", label: "Arrow", shape: "arrow" },
      { icon: "star", label: "Star", shape: "star" }
    ];

    for (const s of shapes) {
      html += '<button class="ve-shape-btn" data-shape="' + s.shape + '">';
      html += '  <span class="material-icons">' + s.icon + "</span>";
      html += "  <span>" + (window.I18n?.t("videoeditor.shape_" + s.shape) || s.label) + "</span>";
      html += "</button>";
    }

    html += "  </div>";
    html += "</div>";
    container.html(html);

    $(document).off("click" + NS, ".ve-shape-btn");
    $(document).on("click" + NS, ".ve-shape-btn", function () {
      const shape = $(this).data("shape");
      const clip = {
        type: "image",
        source: null,
        shape: shape,
        startTime: previewEngine?.currentTime || 0,
        duration: 5,
        position: { x: 200, y: 200 },
        size: { width: 200, height: 200 },
        fillColor: "#667eea",
        opacity: 1,
        animation: "none",
        name: shape.charAt(0).toUpperCase() + shape.slice(1)
      };
      addClipToTimeline(clip, "image");
    });
  }

  // ---- Musics Panel ----
  function getAudioDuration(source) {
    return new Promise((resolve) => {
      const audio = new Audio();
      audio.addEventListener("loadedmetadata", () => {
        resolve(isFinite(audio.duration) ? audio.duration : 10);
      });
      audio.addEventListener("error", () => resolve(10));
      audio.src = source.startsWith("file://") ? source : "file://" + source.replace(/\\/g, "/");
    });
  }

  // ---- Subtitles Panel ----
  function renderSubtitlesPanel(container) {
    const t = (key, fb) => window.I18n?.t("videoeditor." + key) || fb;

    const ST = typeof SubtitleTemplates !== "undefined" ? SubtitleTemplates : null;
    const templates = ST ? ST.SUBTITLE_TEMPLATES : [];

    let html = "";

    // Auto Generate Section
    html += '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + t("sub_auto_generate", "Auto Generate") + "</div>";
    html += '  <p class="ve-panel-hint">' + t("sub_auto_hint", "Select an audio or video clip on the timeline, then generate subtitles from its speech.") + "</p>";

    // Source selector
    html += '  <div class="ve-prop-row" style="margin-top:8px;">';
    html += '    <span class="ve-prop-label">' + t("sub_source", "Source") + '</span>';
    html += '    <select id="ve-sub-source" class="ve-prop-input" style="flex:1;">';
    html += '      <option value="">' + t("sub_select_source", "Select audio/video clip...") + '</option>';

    // Populate audio/video clips from timeline
    if (timeline) {
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          if ((clip.type === "audio" || clip.type === "video") && clip.source) {
            const label = clip.name || clip.source.split(/[\\/]/).pop();
            html += '<option value="' + clip.id + '">' + escapeHtml(label) + "</option>";
          }
        }
      }
    }
    html += "    </select>";
    html += "  </div>";

    // Language selector
    html += '  <div class="ve-prop-row" style="margin-top:6px;">';
    html += '    <span class="ve-prop-label">' + t("sub_language", "Lang") + '</span>';
    html += '    <select id="ve-sub-language" class="ve-prop-input" style="flex:1;">';
    html += '      <option value="">' + t("sub_auto_detect", "Auto Detect") + "</option>";
    html += '      <option value="en">English</option>';
    html += '      <option value="fr">Français</option>';
    html += '      <option value="ar">العربية</option>';
    html += '      <option value="es">Español</option>';
    html += '      <option value="de">Deutsch</option>';
    html += '      <option value="pt">Português</option>';
    html += '      <option value="zh">中文</option>';
    html += '      <option value="ja">日本語</option>';
    html += '      <option value="ko">한국어</option>';
    html += '      <option value="hi">हिन्दी</option>';
    html += "    </select>";
    html += "  </div>";

    // Template selector for auto-generated subtitles
    html += '  <div class="ve-prop-row" style="margin-top:6px;">';
    html += '    <span class="ve-prop-label">' + t("sub_template", "Style") + '</span>';
    html += '    <select id="ve-sub-template" class="ve-prop-input" style="flex:1;">';
    for (const tmpl of templates) {
      html += '      <option value="' + tmpl.key + '">' + tmpl.name + "</option>";
    }
    html += "    </select>";
    html += "  </div>";

    html += '  <button class="ve-media-import-btn" id="ve-sub-generate-btn" style="margin-top:10px;">';
    html += '    <span class="material-icons">subtitles</span>';
    html += "    <span>" + t("sub_generate", "Generate Subtitles") + "</span>";
    html += "  </button>";

    html += '  <div id="ve-sub-progress" style="display:none;margin-top:8px;">';
    html += '    <div class="ve-progress-bar"><div class="ve-progress-fill" id="ve-sub-progress-fill"></div></div>';
    html += '    <p class="ve-panel-hint" id="ve-sub-progress-text">' + t("sub_transcribing", "Transcribing audio...") + "</p>";
    html += "  </div>";
    html += "</div>";

    // Templates Section
    html += '<div class="ve-panel-section" style="margin-top:16px;">';
    html += '  <div class="ve-panel-section-title">' + t("sub_templates", "Templates") + "</div>";
    html += '  <div class="ve-subtitle-template-grid">';

    for (const tmpl of templates) {
      const [bg, fg] = tmpl.previewColors;
      html += '<button class="ve-subtitle-template-card" data-template="' + tmpl.key + '">';
      html += '  <div class="ve-subtitle-template-preview" style="background:' + bg + ';color:' + fg + ';">';
      html += '    <span style="font-weight:bold;">' + tmpl.name + "</span>";
      html += "  </div>";
      html += '  <span class="ve-subtitle-template-name">' + tmpl.name + "</span>";
      html += "</button>";
    }

    html += "  </div>";
    html += "</div>";

    // Manual Add Section
    html += '<div class="ve-panel-section" style="margin-top:16px;">';
    html += '  <div class="ve-panel-section-title">' + t("sub_manual", "Manual") + "</div>";
    html += '  <button class="ve-media-import-btn" id="ve-sub-add-empty-btn">';
    html += '    <span class="material-icons">add</span>';
    html += "    <span>" + t("sub_add_empty", "Add Empty Subtitle") + "</span>";
    html += "  </button>";
    html += "</div>";

    container.html(html);

    // ---- Event Handlers ----

    // Generate subtitles
    $(document).off("click" + NS, "#ve-sub-generate-btn");
    $(document).on("click" + NS, "#ve-sub-generate-btn", async function () {
      const sourceClipId = $("#ve-sub-source").val();
      if (!sourceClipId) {
        showToast(t("sub_select_source_error", "Please select an audio or video source clip"), "warning");
        return;
      }

      const sourceClip = findClipById(sourceClipId);
      if (!sourceClip || !sourceClip.source) {
        showToast(t("sub_source_not_found", "Source clip not found"), "error");
        return;
      }

      const language = $("#ve-sub-language").val() || undefined;
      const templateKey = $("#ve-sub-template").val() || "classic";

      // Show progress
      $("#ve-sub-progress").show();
      $("#ve-sub-generate-btn").prop("disabled", true);
      $("#ve-sub-progress-fill").css("width", "30%");

      try {
        const result = await window.electronAPI.transcribeAudio(sourceClip.source, language);
        $("#ve-sub-progress-fill").css("width", "90%");

        if (!result.success || !result.words || result.words.length === 0) {
          showToast(result.error || t("sub_no_words", "No speech detected in the audio"), "error");
          return;
        }

        // Create subtitle clip
        const tmpl = templates.find((tt) => tt.key === templateKey) || templates[0];
        const lastWord = result.words[result.words.length - 1];
        const subtitleDuration = Math.min(lastWord.end + 0.5, sourceClip.duration);

        const clip = {
          type: "subtitle",
          template: templateKey,
          words: result.words,
          wordsPerGroup: 4,
          startTime: sourceClip.startTime,
          duration: subtitleDuration,
          position: { x: currentProject.settings.width / 2, y: Math.round(currentProject.settings.height * 0.85) },
          fontSize: tmpl.defaults.fontSize,
          fontFamily: tmpl.defaults.fontFamily,
          fontColor: tmpl.defaults.fontColor,
          highlightColor: tmpl.defaults.highlightColor,
          strokeColor: tmpl.defaults.strokeColor,
          strokeWidth: tmpl.defaults.strokeWidth,
          backgroundColor: tmpl.defaults.backgroundColor,
          opacity: 1,
          name: "Subtitles"
        };

        addClipToTimeline(clip, "subtitle");
        $("#ve-sub-progress-fill").css("width", "100%");

        showToast(t("sub_generated", "Subtitles generated successfully!") + ` (${result.words.length} words)`, "success");
      } catch (err) {
        console.error("[VideoEditor] Subtitle generation error:", err);
        showToast(t("sub_error", "Failed to generate subtitles") + ": " + (err.message || err), "error");
      } finally {
        setTimeout(() => {
          $("#ve-sub-progress").hide();
          $("#ve-sub-generate-btn").prop("disabled", false);
          $("#ve-sub-progress-fill").css("width", "0%");
        }, 1000);
      }
    });

    // Apply template to selected subtitle clip
    $(document).off("click" + NS, ".ve-subtitle-template-card");
    $(document).on("click" + NS, ".ve-subtitle-template-card", function () {
      const templateKey = $(this).data("template");
      const selectedClipId = timeline?.selectedClipId;
      if (!selectedClipId) {
        showToast(t("sub_select_clip", "Select a subtitle clip on the timeline first"), "info");
        return;
      }
      const clip = findClipById(selectedClipId);
      if (!clip || clip.type !== "subtitle") {
        showToast(t("sub_select_subtitle", "Please select a subtitle clip"), "info");
        return;
      }

      const tmpl = templates.find((tt) => tt.key === templateKey);
      if (!tmpl) return;

      clip.template = templateKey;
      clip.fontSize = tmpl.defaults.fontSize;
      clip.fontFamily = tmpl.defaults.fontFamily;
      clip.fontColor = tmpl.defaults.fontColor;
      clip.highlightColor = tmpl.defaults.highlightColor;
      clip.strokeColor = tmpl.defaults.strokeColor;
      clip.strokeWidth = tmpl.defaults.strokeWidth;
      clip.backgroundColor = tmpl.defaults.backgroundColor;

      pushUndoState();
      syncTracksToPreview();
      showClipProperties(selectedClipId);
    });

    // Add empty subtitle clip
    $(document).off("click" + NS, "#ve-sub-add-empty-btn");
    $(document).on("click" + NS, "#ve-sub-add-empty-btn", function () {
      const templateKey = "classic";
      const tmpl = templates.find((tt) => tt.key === templateKey) || templates[0];

      const clip = {
        type: "subtitle",
        template: templateKey,
        words: [
          { text: "Hello", start: 0, end: 0.5 },
          { text: "World", start: 0.5, end: 1.0 },
          { text: "Edit", start: 1.0, end: 1.5 },
          { text: "Me", start: 1.5, end: 2.0 },
        ],
        wordsPerGroup: 4,
        startTime: previewEngine?.currentTime || 0,
        duration: 2,
        position: { x: currentProject.settings.width / 2, y: Math.round(currentProject.settings.height * 0.85) },
        fontSize: tmpl.defaults.fontSize,
        fontFamily: tmpl.defaults.fontFamily,
        fontColor: tmpl.defaults.fontColor,
        highlightColor: tmpl.defaults.highlightColor,
        strokeColor: tmpl.defaults.strokeColor,
        strokeWidth: tmpl.defaults.strokeWidth,
        backgroundColor: tmpl.defaults.backgroundColor,
        opacity: 1,
        name: "Subtitles"
      };

      addClipToTimeline(clip, "subtitle");
    });
  }

  let musicLibraryCache = null;

  function renderMusicsPanel(container) {
    const t = (key, fb) => window.I18n?.t("videoeditor." + key) || fb;

    let html = '';

    // --- Music Library Section ---
    html += '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + t("music_library", "Music Library") + '</div>';
    html += '  <div class="ve-music-search-row">';
    html += '    <input type="text" class="ve-music-search" id="ve-music-search" placeholder="' + escapeAttr(t("search_music", "Search music...")) + '">';
    html += '  </div>';
    html += '  <div class="ve-music-library-list" id="ve-music-library-list">';
    html += '    <p class="ve-music-loading">' + t("loading_musics", "Loading musics...") + '</p>';
    html += '  </div>';
    html += '</div>';

    // --- My Musics Section ---
    html += '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + t("my_musics", "My Musics") + '</div>';
    html += '  <button class="ve-media-import-btn" id="ve-import-audio-btn">';
    html += '    <span class="material-icons">library_music</span>';
    html += '    <span>' + t("import_audio", "Import Music") + '</span>';
    html += '  </button>';
    html += '  <div class="ve-audio-list" id="ve-audio-list"></div>';
    html += '</div>';
    container.html(html);

    // Load music library from server
    loadMusicLibrary();

    // Load imported audio items (My Musics)
    renderMyMusics();

    // Search handler
    let searchTimeout = null;
    $(document).off("input" + NS, "#ve-music-search");
    $(document).on("input" + NS, "#ve-music-search", function () {
      clearTimeout(searchTimeout);
      const query = $(this).val().trim();
      searchTimeout = setTimeout(() => loadMusicLibrary(query), 300);
    });

    // Import button
    $(document).off("click" + NS, "#ve-import-audio-btn");
    $(document).on("click" + NS, "#ve-import-audio-btn", async () => {
      try {
        const result = await window.electronAPI.showOpenDialog({
          properties: ["openFile", "multiSelections"],
          filters: [
            { name: "Audio Files", extensions: ["mp3", "wav", "ogg", "aac", "flac", "m4a"] }
          ]
        });
        if (result && result.length > 0) {
          if (!currentProject.media) currentProject.media = [];
          for (const filePath of result) {
            let safePath = filePath;
            let displayName = filePath.split(/[/\\]/).pop();
            const copyResult = await window.electronAPI.veImportMediaFile({ filePath });
            if (copyResult.success) {
              safePath = copyResult.filePath;
              displayName = copyResult.name;
            } else {
              console.warn("[VideoEditor] Could not copy audio to safe location, using original path:", copyResult.error);
            }
            const media = {
              id: "media_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
              type: "audio",
              source: safePath,
              name: displayName
            };
            currentProject.media.push(media);
          }
          renderMyMusics();
        }
      } catch (err) {
        console.error("[VideoEditor] Music import error:", err);
      }
    });

    // Double-click my music to add to timeline
    $(document).off("dblclick" + NS, ".ve-audio-item");
    $(document).on("dblclick" + NS, ".ve-audio-item", async function () {
      const source = $(this).data("source");
      const realDuration = await getAudioDuration(source);
      const clip = {
        type: "audio",
        source: source,
        startTime: previewEngine?.currentTime || 0,
        duration: realDuration,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        name: source.split(/[/\\]/).pop()
      };
      addClipToTimeline(clip, "audio");
    });
  }

  async function loadMusicLibrary(search) {
    const t = (key, fb) => window.I18n?.t("videoeditor." + key) || fb;
    const listEl = $("#ve-music-library-list");

    try {
      const result = await window.electronAPI.getMusicLibrary({
        category: "all",
        search: search || ""
      });

      if (!result.success) {
        listEl.html('<p class="ve-music-empty">' + (result.error || "Error loading") + '</p>');
        return;
      }

      musicLibraryCache = result;

      // Render music items
      const musics = result.musics || [];
      if (musics.length === 0) {
        listEl.html('<p class="ve-music-empty">' + t("no_musics_found", "No musics found") + '</p>');
        return;
      }

      let html = "";
      for (const m of musics) {
        const durationText = m.duration ? formatTimecode(m.duration) : "--:--";
        const thumbUrl = m.thumbnail ? '' : '';
        html += '<div class="ve-music-lib-item" data-filename="' + escapeAttr(m.filename) + '" data-title="' + escapeAttr(m.title) + '" data-duration="' + (m.duration || 0) + '">';
        html += '  <div class="ve-music-lib-thumb-wrap">';
        if (thumbUrl) {
          html += '    <div class="ve-music-lib-thumb"><img src="' + escapeAttr(thumbUrl) + '" alt=""></div>';
        } else {
          html += '    <div class="ve-music-lib-thumb ve-music-lib-thumb-default"><span class="material-icons">music_note</span></div>';
        }
        html += '    <button class="ve-music-play-btn" title="Preview"><span class="material-icons">play_arrow</span></button>';
        html += '  </div>';
        html += '  <div class="ve-music-lib-title">' + escapeHtml(m.title) + '</div>';
        html += '  <div class="ve-music-lib-actions">';
        html += '    <span class="ve-music-lib-duration">' + durationText + '</span>';
        html += '    <button class="ve-music-download-btn" title="Download & Add">';
        html += '      <span class="material-icons">download</span>';
        html += '    </button>';
        html += '  </div>';
        html += '</div>';
      }
      listEl.html(html);

      // Preview play/pause
      let previewAudio = null;
      let previewBtn = null;
      listEl.off("click" + NS, ".ve-music-play-btn");
      listEl.on("click" + NS, ".ve-music-play-btn", function (e) {
        e.stopPropagation();
        const btn = $(this);
        const item = btn.closest(".ve-music-lib-item");
        const filename = item.data("filename");
        const url = '';

        // If same track is playing, toggle pause
        if (previewAudio && previewBtn && previewBtn.is(btn)) {
          if (previewAudio.paused) {
            previewAudio.play();
            btn.find(".material-icons").text("pause");
          } else {
            previewAudio.pause();
            btn.find(".material-icons").text("play_arrow");
          }
          return;
        }

        // Stop any existing preview
        if (previewAudio) {
          previewAudio.pause();
          previewAudio = null;
          if (previewBtn) previewBtn.find(".material-icons").text("play_arrow");
        }

        previewAudio = new Audio(url);
        previewBtn = btn;
        btn.find(".material-icons").text("pause");
        previewAudio.play();
        previewAudio.onended = () => {
          btn.find(".material-icons").text("play_arrow");
          previewAudio = null;
          previewBtn = null;
        };
      });

      // Download & add to project
      listEl.off("click" + NS, ".ve-music-download-btn");
      listEl.on("click" + NS, ".ve-music-download-btn", async function (e) {
        e.stopPropagation();
        const item = $(this).closest(".ve-music-lib-item");
        const filename = item.data("filename");
        const title = item.data("title");
        const btn = $(this);

        btn.find(".material-icons").text("hourglass_empty");
        btn.prop("disabled", true);

        const result = await window.electronAPI.downloadMusicFile({ filename });
        if (result.success) {
          btn.find(".material-icons").text("check");
          setTimeout(() => {
            btn.find(".material-icons").text("download");
            btn.prop("disabled", false);
          }, 2000);
        } else {
          btn.find(".material-icons").text("error");
          setTimeout(() => {
            btn.find(".material-icons").text("download");
            btn.prop("disabled", false);
          }, 2000);
        }
      });

      // Drag support for library items
      listEl.find(".ve-music-lib-item").each(function () {
        this.setAttribute("draggable", "true");
        this.addEventListener("dragstart", (e) => {
          const data = {
            type: "music-library",
            filename: $(this).data("filename"),
            title: $(this).data("title"),
            duration: parseInt($(this).data("duration")) || 0
          };
          e.dataTransfer.setData("application/ve-media", JSON.stringify(data));
        });
      });

      // Double-click library item to download and add to timeline
      listEl.off("dblclick" + NS, ".ve-music-lib-item");
      listEl.on("dblclick" + NS, ".ve-music-lib-item", async function () {
        const filename = $(this).data("filename");
        const title = $(this).data("title");
        const duration = parseInt($(this).data("duration")) || 10;
        const btn = $(this).find(".ve-music-download-btn");

        btn.find(".material-icons").text("hourglass_empty");
        btn.prop("disabled", true);

        const result = await window.electronAPI.downloadMusicFile({ filename });
        if (result.success) {
          // Add to timeline
          const realDur = await getAudioDuration(result.filePath);
          const clip = {
            type: "audio",
            source: result.filePath,
            startTime: previewEngine?.currentTime || 0,
            duration: realDur,
            volume: 1,
            fadeIn: 0,
            fadeOut: 0,
            name: title || filename
          };
          addClipToTimeline(clip, "audio");
          btn.find(".material-icons").text("check");
        } else {
          btn.find(".material-icons").text("error");
        }
        setTimeout(() => {
          btn.find(".material-icons").text("download");
          btn.prop("disabled", false);
        }, 2000);
      });

    } catch (err) {
      console.error("[VideoEditor] Music library error:", err);
      listEl.html('<p class="ve-music-empty">Error loading musics</p>');
    }
  }

  function renderMyMusics() {
    const media = (currentProject?.media || []).filter((m) => m.type === "audio");
    const listEl = $("#ve-audio-list");
    if (!listEl.length) return;

    if (media.length === 0) {
      listEl.html("");
      return;
    }

    let audioHtml = "";
    for (const m of media) {
      audioHtml += '<div class="ve-audio-item" draggable="true" data-source="' + escapeAttr(m.source) + '" data-media-id="' + m.id + '">';
      audioHtml += '  <span class="material-icons">music_note</span>';
      audioHtml += '  <div class="ve-audio-item-info">';
      audioHtml += '    <div class="ve-audio-item-name">' + escapeHtml(m.name) + "</div>";
      audioHtml += '    <div class="ve-audio-item-duration" data-audio-source="' + escapeAttr(m.source) + '">--:--</div>';
      audioHtml += "  </div>";
      audioHtml += '  <button class="ve-audio-delete-btn" data-media-id="' + m.id + '" title="Delete"><span class="material-icons">close</span></button>';
      audioHtml += "</div>";
    }
    listEl.html(audioHtml);

    // Load real durations
    listEl.find(".ve-audio-item-duration").each(function () {
      const el = $(this);
      const src = el.data("audio-source");
      if (src) getAudioDuration(src).then((dur) => el.text(formatTimecode(dur)));
    });

    // Delete handler
    listEl.off("click" + NS, ".ve-audio-delete-btn");
    listEl.on("click" + NS, ".ve-audio-delete-btn", async function (e) {
      e.stopPropagation();
      const mediaId = $(this).data("media-id");
      const confirmed = await confirmPrompt();
      if (!confirmed) return;
      await removeMediaFromProject(mediaId);
    });

    // Drag events
    listEl.find(".ve-audio-item").each(function () {
      this.addEventListener("dragstart", (e) => {
        const data = {
          type: "audio",
          source: $(this).data("source"),
          mediaId: $(this).data("media-id")
        };
        e.dataTransfer.setData("application/ve-media", JSON.stringify(data));
      });
    });
  }

  // ---- Filters Panel ----
  function renderFiltersPanel(container) {
    const filters = [
      { key: "none", label: "None" },
      { key: "grayscale", label: "Grayscale" },
      { key: "sepia", label: "Sepia" },
      { key: "brightness", label: "Bright" },
      { key: "contrast", label: "Contrast" },
      { key: "saturation", label: "Saturate" },
      { key: "blur", label: "Blur" },
      { key: "vintage", label: "Vintage" },
      { key: "warm", label: "Warm" },
      { key: "cool", label: "Cool" }
    ];

    let html = '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + (window.I18n?.t("videoeditor.select_clip_filter") || "Select a clip, then apply a filter") + "</div>";
    html += '  <div class="ve-filters-grid">';

    for (const f of filters) {
      const label = window.I18n?.t("videoeditor.filter_" + f.key) || f.label;
      html += '<button class="ve-filter-btn" data-filter="' + f.key + '">';
      html += '  <div class="ve-filter-preview" style="filter: ' + getFilterCSS(f.key) + ';"></div>';
      html += "  <span>" + label + "</span>";
      html += "</button>";
    }

    html += "  </div>";
    html += "</div>";

    // Filter adjustments
    html += '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + (window.I18n?.t("videoeditor.adjustments") || "Adjustments") + "</div>";
    html += '  <div class="ve-prop-group">';

    const adjustments = [
      { key: "brightness", label: "Brightness", min: -100, max: 100, val: 0 },
      { key: "contrast", label: "Contrast", min: -100, max: 100, val: 0 },
      { key: "saturation", label: "Saturation", min: -100, max: 100, val: 0 }
    ];

    for (const adj of adjustments) {
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + adj.label.substring(0, 4) + "</span>";
      html += '    <input type="range" class="ve-prop-slider ve-filter-adj" data-adj="' + adj.key + '" min="' + adj.min + '" max="' + adj.max + '" value="' + adj.val + '">';
      html += '    <span class="ve-adj-value" style="font-size:11px;min-width:30px;text-align:right;">' + adj.val + "</span>";
      html += "  </div>";
    }

    html += "  </div>";
    html += "</div>";

    container.html(html);

    $(document).off("click" + NS, ".ve-filter-btn");
    $(document).on("click" + NS, ".ve-filter-btn", function () {
      const filter = $(this).data("filter");
      $(".ve-filter-btn").removeClass("active");
      $(this).addClass("active");
      applyFilterToSelectedClip(filter);
    });

    $(document).off("input" + NS, ".ve-filter-adj");
    $(document).on("input" + NS, ".ve-filter-adj", function () {
      $(this).closest(".ve-prop-row").find(".ve-adj-value").text($(this).val());
    });
  }

  function getFilterCSS(key) {
    switch (key) {
      case "grayscale": return "grayscale(100%)";
      case "sepia": return "sepia(100%)";
      case "brightness": return "brightness(130%)";
      case "contrast": return "contrast(130%)";
      case "saturation": return "saturate(200%)";
      case "blur": return "blur(2px)";
      case "vintage": return "sepia(60%) contrast(110%) brightness(90%)";
      case "warm": return "sepia(20%) saturate(150%) brightness(105%)";
      case "cool": return "hue-rotate(20deg) saturate(80%) brightness(95%)";
      default: return "none";
    }
  }

  function applyFilterToSelectedClip(filter) {
    if (!timeline?.selectedClipId) return;
    const clip = findClipById(timeline.selectedClipId);
    if (!clip) return;
    clip.filter = filter;
    pushUndoState();
    syncTracksToPreview();
  }

  // ---- AI Panel ----
  function renderAIPanel(container) {
    const providers = [
      { id: "dalle3", name: "DALL-E 3", icon: "key", desc: "OpenAI API key", profile: false },
      { id: "gptimage", name: "GPT Image", icon: "key", desc: "OpenAI API key", profile: false },
      { id: "chatgptimage", name: "ChatGPT Image", icon: "person", desc: "OpenAI profile", profile: "openaiProfiles" },
      { id: "soraimage", name: "Sora Image", icon: "person", desc: "OpenAI profile", profile: "openaiProfiles" },
      { id: "geminiimage", name: "Gemini Image", icon: "person", desc: "Google profile", profile: "googleProfiles" },
      { id: "midjourney", name: "Midjourney", icon: "person", desc: "Discord profile", profile: "discordProfiles" }
    ];

    let html = '<div class="ve-ai-section">';
    html += '  <h4><span class="material-icons" style="font-size:16px;vertical-align:middle;margin-right:4px;">image</span>';
    html += (window.I18n?.t("videoeditor.ai_image_gen") || "Image Generator") + "</h4>";

    // Provider selector
    html += '  <label style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;display:block;">' +
      (window.I18n?.t("videoeditor.ai_provider") || "Provider") + "</label>";
    html += '  <select class="ve-select" id="ve-ai-provider" style="width:100%;margin-bottom:10px;">';
    for (const p of providers) {
      html += '    <option value="' + p.id + '">' + p.name + " — " + p.desc + "</option>";
    }
    html += "  </select>";

    // Profile selector (shown for browser-based providers)
    html += '  <div id="ve-ai-profile-container" style="display:none;margin-bottom:10px;">';
    html += '    <label style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;display:block;">' +
      (window.I18n?.t("videoeditor.ai_profile") || "Profile") + "</label>";
    html += '    <select class="ve-select" id="ve-ai-profile" style="width:100%;"></select>';
    html += '    <p id="ve-ai-no-profiles" style="color:#ef4444;font-size:11px;margin-top:4px;display:none;">' +
      (window.I18n?.t("videoeditor.ai_no_profiles") || "No profiles configured. Add profiles in Settings.") + "</p>";
    html += "  </div>";

    // Prompt
    html += '  <textarea class="ve-ai-textarea" id="ve-ai-image-prompt" placeholder="' +
      (window.I18n?.t("videoeditor.ai_image_placeholder") || "Describe the image you want to generate...") + '"></textarea>';

    // Size selector (hidden for Midjourney — uses --ar in prompt)
    html += '  <div id="ve-ai-size-container">';
    html += '  <label style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;display:block;">' +
      (window.I18n?.t("videoeditor.ai_size") || "Size") + "</label>";
    html += '  <select class="ve-select" id="ve-ai-size" style="width:100%;margin-bottom:10px;">';
    html += '    <option value="1024x1024">1024 × 1024</option>';
    html += '    <option value="1792x1024">1792 × 1024 (Landscape)</option>';
    html += '    <option value="1024x1792">1024 × 1792 (Portrait)</option>';
    html += "  </select>";
    html += "  </div>";

    // Generate button
    html += '  <button class="ve-btn ve-btn-primary ve-ai-generate-btn" id="ve-ai-generate-image-btn">';
    html += '    <span class="material-icons">brush</span>';
    html += '    <span>' + (window.I18n?.t("videoeditor.generate_image") || "Generate Image") + "</span>";
    html += "  </button>";
    html += '  <div id="ve-ai-image-result" style="margin-top:12px;"></div>';
    html += "</div>";

    container.html(html);

    // Provider change handler - show/hide profile selector and load profiles
    async function updateProfileSelector() {
      const providerId = $("#ve-ai-provider").val();
      const providerDef = providers.find(p => p.id === providerId);
      if (providerDef && providerDef.profile) {
        const profiles = await window.electronAPI.readKey(providerDef.profile) || {};
        const entries = Object.entries(profiles).filter(([, v]) => v && typeof v === "object");
        if (entries.length) {
          let opts = "";
          for (const [id, prof] of entries) {
            const label = prof.label || prof.name || prof.email || id;
            opts += '<option value="' + id + '">' + escapeHtml(label) + "</option>";
          }
          // Add auto-select option for providers that support it
          if (providerId === "chatgptimage" || providerId === "geminiimage") {
            opts = '<option value="">' + (window.I18n?.t("videoeditor.ai_auto_select") || "Auto-select best") + "</option>" + opts;
          }
          $("#ve-ai-profile").html(opts);
          $("#ve-ai-no-profiles").hide();
        } else {
          $("#ve-ai-profile").html("");
          $("#ve-ai-no-profiles").show();
        }
        $("#ve-ai-profile-container").show();
      } else {
        $("#ve-ai-profile-container").hide();
      }
      // Hide size selector for Midjourney (uses --ar in prompt)
      if (providerId === "midjourney") {
        $("#ve-ai-size-container").hide();
      } else {
        $("#ve-ai-size-container").show();
      }
    }

    $(document).off("change" + NS, "#ve-ai-provider");
    $(document).on("change" + NS, "#ve-ai-provider", updateProfileSelector);
    updateProfileSelector();

    $(document).off("click" + NS, "#ve-ai-generate-image-btn");
    $(document).on("click" + NS, "#ve-ai-generate-image-btn", async () => {
      if ($("#ve-ai-generate-image-btn").prop("disabled")) return;
      const prompt = $("#ve-ai-image-prompt").val().trim();
      if (!prompt) return;

      const provider = $("#ve-ai-provider").val();
      const size = $("#ve-ai-size").val();
      const profileId = $("#ve-ai-profile").val() || null;

      // Validate profile for browser-based providers
      const providerDef = providers.find(p => p.id === provider);
      if (providerDef && providerDef.profile && !profileId && provider !== "chatgptimage" && provider !== "geminiimage") {
        $("#ve-ai-image-result").html(
          '<p style="color:#ef4444;font-size:13px;">' +
          (window.I18n?.t("videoeditor.ai_select_profile") || "Please select a profile") + "</p>"
        );
        return;
      }

      $("#ve-ai-generate-image-btn").prop("disabled", true).html(
        '<span class="material-icons ve-spin">sync</span> <span>' +
        (window.I18n?.t("videoeditor.generating") || "Generating...") + "</span>"
      );
      $("#ve-ai-image-result").html("");

      try {
        const options = { size, profileId };
        const result = await window.electronAPI.generateVEImage(provider, prompt, options);
        if (result?.success && result.path) {
          if (!currentProject.media) currentProject.media = [];
          currentProject.media.push({
            id: "media_" + Date.now(),
            type: "image",
            source: result.path,
            name: "AI Generated"
          });
          loadProjectMedia();
          $("#ve-ai-image-result").html(
            '<p style="color:#22c55e;font-size:13px;">' +
            (window.I18n?.t("videoeditor.ai_image_success") || "Image generated and added to media library") + "</p>"
          );
        } else {
          $("#ve-ai-image-result").html(
            '<p style="color:#ef4444;font-size:13px;">' + escapeHtml(result?.error || "Generation failed") + "</p>"
          );
        }
      } catch (err) {
        console.error("[VideoEditor] AI image error:", err);
        $("#ve-ai-image-result").html(
          '<p style="color:#ef4444;font-size:13px;">Error: ' + escapeHtml(err.message) + "</p>"
        );
      } finally {
        $("#ve-ai-generate-image-btn").prop("disabled", false).html(
          '<span class="material-icons">brush</span> <span>' +
          (window.I18n?.t("videoeditor.generate_image") || "Generate Image") + "</span>"
        );
      }
    });
  }

  // ============================================
  // Clip Operations
  // ============================================

  let _addingMedia = false;
  async function addMediaToTimeline(type, source) {
    if (_addingMedia) return;
    _addingMedia = true;
    try {
    let duration = type === "video" ? 10 : 5;
    if (type === "audio") {
      duration = await getAudioDuration(source);
    }

    // For images/videos, load natural dimensions to preserve aspect ratio
    let clipWidth = currentProject.settings.width;
    let clipHeight = currentProject.settings.height;
    if (type === "image" || type === "video") {
      try {
        const dims = await new Promise((resolve, reject) => {
          if (type === "image") {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = reject;
            img.src = source;
          } else {
            const vid = document.createElement("video");
            vid.onloadedmetadata = () => resolve({ w: vid.videoWidth, h: vid.videoHeight, duration: vid.duration });
            vid.onerror = reject;
            vid.src = source;
          }
        });
        if (dims.w && dims.h) {
          const scaleX = currentProject.settings.width / dims.w;
          const scaleY = currentProject.settings.height / dims.h;
          const scale = Math.min(scaleX, scaleY);
          clipWidth = Math.round(dims.w * scale);
          clipHeight = Math.round(dims.h * scale);
        }
        if (type === "video" && dims.duration && isFinite(dims.duration)) {
          duration = dims.duration;
        }
      } catch (e) {
        // Fallback to project dimensions
      }
    }

    const clip = {
      type: type,
      source: source,
      startTime: previewEngine?.currentTime || 0,
      duration: duration,
      position: { x: Math.round((currentProject.settings.width - clipWidth) / 2), y: Math.round((currentProject.settings.height - clipHeight) / 2) },
      size: { width: clipWidth, height: clipHeight },
      opacity: 1,
      name: source.split(/[/\\]/).pop()
    };

    if (type === "video") {
      clip.volume = 1;
      clip.trimStart = 0;
      clip.trimEnd = 0;
    }

    addClipToTimeline(clip, type);
    } finally { _addingMedia = false; }
  }

  function addClipToTimeline(clip, type) {
    if (!timeline) { console.warn("[VE] addClipToTimeline: no timeline"); return; }

    // Images and videos are both visual content — use "video" tracks
    const trackType = (type === "image" || type === "video") ? "video" : type;

    // Find or create appropriate track
    let track = timeline.tracks.find((t) => t.type === trackType && !t.locked);
    if (!track) {
      track = timeline.addTrack(trackType, trackType.charAt(0).toUpperCase() + trackType.slice(1) + " " + (timeline.tracks.length + 1));
    }
    timeline.addClip(track.id, clip);
    pushUndoState();
    syncTracksToPreview();

    // Seek playhead to clip start so it's immediately visible
    if (previewEngine && clip.startTime !== undefined) {
      previewEngine.seek(clip.startTime);
    }
  }

  let _lastDropTime = 0;
  async function handleMediaDrop(mediaData, time, trackIndex) {
    const now = Date.now();
    if (now - _lastDropTime < 200) return;
    _lastDropTime = now;
    if (!timeline) return;

    // Handle music library drag (needs download first)
    if (mediaData.type === "music-library") {
      const filename = mediaData.filename;
      const title = mediaData.title || filename;
      const result = await window.electronAPI.downloadMusicFile({ filename });
      if (!result.success) {
        console.error("[VE] Music download failed:", result.error);
        return;
      }
      const realDur = await getAudioDuration(result.filePath);
      const clip = {
        type: "audio",
        source: result.filePath,
        startTime: time,
        duration: realDur,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        name: title
      };
      addClipToTimeline(clip, "audio");
      return;
    }

    let duration = mediaData.type === "video" ? 10 : 5;
    if (mediaData.type === "audio") {
      duration = await getAudioDuration(mediaData.source);
    }

    // Preserve aspect ratio for images/videos
    let clipWidth = currentProject.settings.width;
    let clipHeight = currentProject.settings.height;
    if (mediaData.type === "image" || mediaData.type === "video") {
      try {
        const dims = await new Promise((resolve, reject) => {
          if (mediaData.type === "image") {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = reject;
            img.src = mediaData.source;
          } else {
            const vid = document.createElement("video");
            vid.onloadedmetadata = () => resolve({ w: vid.videoWidth, h: vid.videoHeight, duration: vid.duration });
            vid.onerror = reject;
            vid.src = mediaData.source;
          }
        });
        if (dims.w && dims.h) {
          const scaleX = currentProject.settings.width / dims.w;
          const scaleY = currentProject.settings.height / dims.h;
          const scale = Math.min(scaleX, scaleY);
          clipWidth = Math.round(dims.w * scale);
          clipHeight = Math.round(dims.h * scale);
        }
        if (mediaData.type === "video" && dims.duration && isFinite(dims.duration)) {
          duration = dims.duration;
        }
      } catch (e) {
        // Fallback to project dimensions
      }
    }

    const clip = {
      type: mediaData.type,
      source: mediaData.source,
      startTime: time,
      duration: duration,
      position: { x: Math.round((currentProject.settings.width - clipWidth) / 2), y: Math.round((currentProject.settings.height - clipHeight) / 2) },
      size: { width: clipWidth, height: clipHeight },
      opacity: 1,
      name: mediaData.source?.split(/[/\\]/).pop() || "Media"
    };

    addClipToTimeline(clip, mediaData.type);
  }

  function deleteSelectedClip() {
    if (!timeline?.selectedClipId) return;
    const clipId = timeline.selectedClipId;
    timeline.removeClip(clipId);
    previewEngine?.removeClip(clipId);
    pushUndoState();
    showClipProperties(null);
  }

  async function removeMediaFromProject(mediaId) {
    if (!currentProject?.media) return;
    const media = currentProject.media.find((m) => m.id === mediaId);
    if (!media) return;

    // Check if this media source is used in any other project
    try {
      const allProjects = (await window.electronAPI.readKey("videoProjects") || []).filter(Boolean);
      const otherProjects = allProjects.filter((p) => p.id !== currentProject.id);
      const usedInProjects = otherProjects.filter((p) => {
        // Check media array
        const inMedia = (p.media || []).some((m) => m.source === media.source);
        // Check timeline clips
        const inTracks = (p.tracks || []).some((t) =>
          (t.clips || []).some((c) => c.source === media.source)
        );
        return inMedia || inTracks;
      });

      if (usedInProjects.length > 0) {
        const names = usedInProjects.map((p) => `"${p.name || 'Untitled'}"`).join(", ");
        const warning = (window.I18n?.t("videoeditor.media_used_in_other_projects") ||
          `This file is also used in ${usedInProjects.length} other project(s): ${names}. Deleting it here will break those projects. Continue?`)
          .replace("{count}", usedInProjects.length)
          .replace("{names}", names);
        const secondConfirm = await confirmPrompt(warning);
        if (!secondConfirm) return;
      }
    } catch (err) {
      console.warn("[VideoEditor] Could not check cross-project usage:", err);
    }

    // Remove all timeline clips that use this media source
    if (timeline) {
      const clipsToRemove = [];
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          if (clip.source === media.source) clipsToRemove.push(clip.id);
        }
      }
      for (const clipId of clipsToRemove) {
        timeline.removeClip(clipId);
        previewEngine?.removeClip(clipId);
      }
    }

    // Remove from project media array
    currentProject.media = currentProject.media.filter((m) => m.id !== mediaId);
    pushUndoState();
    syncTracksToPreview();
    showClipProperties(null);

    // Re-render both panels — audio files appear in both Project Media grid and My Musics
    loadProjectMedia();
    if (media.type === "audio") {
      renderMyMusics();
    }

    // Persist the removal immediately so it survives reload/auto-save
    saveProject(true);

    // Delete the safe-copied file from VideoEditorMedia (fire-and-forget, after UI update)
    if (media.source && window.electronAPI?.veDeleteMediaFile) {
      window.electronAPI.veDeleteMediaFile({ filePath: media.source }).catch(() => {});
    }
  }

  function findClipById(clipId) {
    if (!timeline) return null;
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }

  // ============================================
  // Properties Panel
  // ============================================

  function showClipProperties(clipId) {
    const content = $("#ve-properties-content");

    if (!clipId) {
      const curBg = currentProject?.settings?.backgroundColor || "#ffffff";
      const bgType = currentProject?.settings?.backgroundType || "color";
      const blurInt = currentProject?.settings?.blurIntensity || 30;
      const isSolid = bgType === "color";
      content.html(
        '<div class="ve-project-props">' +
        '  <div class="ve-prop-group">' +
        '    <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.background_type") || "Background") + '</div>' +
        '    <div class="ve-prop-row">' +
        '      <select id="ve-bg-type-select" class="ve-prop-input" style="flex:1;">' +
        '        <option value="color"' + (isSolid ? ' selected' : '') + '>' + (window.I18n?.t("videoeditor.bg_solid_color") || "Solid Color") + '</option>' +
        '        <option value="blur"' + (!isSolid ? ' selected' : '') + '>' + (window.I18n?.t("videoeditor.bg_blur_fill") || "Blur Fill") + '</option>' +
        '      </select>' +
        '    </div>' +
        '    <div id="ve-bg-color-controls" style="' + (isSolid ? '' : 'display:none;') + '">' +
        '      <div class="ve-prop-row" style="margin-top:8px;">' +
        '        <input type="color" id="ve-live-bg-color" class="ve-prop-color" value="' + curBg + '">' +
        '        <input type="text" id="ve-live-bg-hex" class="ve-prop-input" value="' + curBg + '" style="flex:1;font-family:monospace;">' +
        '      </div>' +
        '    </div>' +
        '    <div id="ve-bg-blur-controls" style="' + (!isSolid ? '' : 'display:none;') + '">' +
        '      <div class="ve-prop-row" style="margin-top:8px;">' +
        '        <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.blur_intensity") || "Blur") + '</span>' +
        '        <input type="range" id="ve-blur-intensity" class="ve-prop-slider" min="10" max="60" step="1" value="' + blurInt + '" style="flex:1;">' +
        '        <span id="ve-blur-intensity-val" class="ve-prop-value" style="font-size:11px;min-width:30px;">' + blurInt + 'px</span>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="ve-no-selection" style="margin-top:16px;">' +
        '    <span class="material-icons">touch_app</span>' +
        '    <p>' + (window.I18n?.t("videoeditor.select_element") || "Select an element to edit its properties") + '</p>' +
        '  </div>' +
        '</div>'
      );
      return;
    }

    const clip = findClipById(clipId);
    if (!clip) return;

    let html = "";

    // Position & Size (for visual clips)
    if (clip.type !== "audio") {
      html += '<div class="ve-prop-group">';
      html += '  <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.position_size") || "Position & Size") + "</div>";
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">X</span>';
      html += '    <input class="ve-prop-input ve-clip-prop" data-prop="position.x" type="number" value="' + Math.round(clip.position?.x || 0) + '">';
      html += '  </div>';
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">Y</span>';
      html += '    <input class="ve-prop-input ve-clip-prop" data-prop="position.y" type="number" value="' + Math.round(clip.position?.y || 0) + '">';
      html += '  </div>';
      if (clip.size) {
        html += '  <div class="ve-prop-row">';
        html += '    <span class="ve-prop-label">W</span>';
        html += '    <input class="ve-prop-input ve-clip-prop" data-prop="size.width" type="number" value="' + Math.round(clip.size.width || 200) + '">';
        html += '  </div>';
        html += '  <div class="ve-prop-row">';
        html += '    <span class="ve-prop-label">H</span>';
        html += '    <input class="ve-prop-input ve-clip-prop" data-prop="size.height" type="number" value="' + Math.round(clip.size.height || 200) + '">';
        html += '  </div>';
      }
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">Op</span>';
      html += '    <input class="ve-prop-slider ve-clip-prop" data-prop="opacity" type="range" min="0" max="1" step="0.05" value="' + (clip.opacity ?? 1) + '">';
      html += '    <span class="ve-prop-value" style="font-size:11px;min-width:25px;">' + Math.round((clip.opacity ?? 1) * 100) + '%</span>';
      html += '  </div>';
      html += "</div>";
    }

    // Timing
    html += '<div class="ve-prop-group">';
    html += '  <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.timing") || "Timing") + "</div>";
    html += '  <div class="ve-prop-row">';
    html += '    <span class="ve-prop-label">Start</span>';
    html += '    <input class="ve-prop-input ve-clip-prop" data-prop="startTime" type="number" step="0.1" value="' + (clip.startTime || 0).toFixed(1) + '">';
    html += '  </div>';
    html += '  <div class="ve-prop-row">';
    html += '    <span class="ve-prop-label">Dur</span>';
    html += '    <input class="ve-prop-input ve-clip-prop" data-prop="duration" type="number" step="0.1" min="0.1" value="' + (clip.duration || 5).toFixed(1) + '">';
    html += '  </div>';
    html += "</div>";

    // Text specific
    if (clip.type === "text") {
      html += '<div class="ve-prop-group">';
      html += '  <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.text_properties") || "Text") + "</div>";
      html += '  <textarea class="ve-ai-textarea ve-clip-prop" data-prop="text" style="min-height:50px;">' + escapeHtml(clip.text || "") + "</textarea>";
      html += '  <div class="ve-prop-row" style="margin-top:8px;">';
      html += '    <span class="ve-prop-label">Font</span>';
      html += '    <select class="ve-prop-input ve-clip-prop" data-prop="fontFamily">';
      const fonts = ["Arial", "Georgia", "Helvetica", "Times New Roman", "Courier New", "Impact", "Verdana", "Tahoma", "Comic Sans MS"];
      for (const f of fonts) {
        const selected = (clip.fontFamily || "Arial") === f ? " selected" : "";
        html += '      <option value="' + f + '"' + selected + ">" + f + "</option>";
      }
      html += "    </select>";
      html += "  </div>";
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">Size</span>';
      html += '    <input class="ve-prop-input ve-clip-prop" data-prop="fontSize" type="number" min="8" max="200" value="' + (clip.fontSize || 48) + '">';
      html += "  </div>";
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">Color</span>';
      html += '    <input type="color" class="ve-clip-prop" data-prop="fontColor" value="' + (clip.fontColor || "#ffffff") + '" style="width:40px;height:28px;border:none;padding:0;cursor:pointer;">';
      html += "  </div>";
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.anim_in") || "In") + '</span>';
      html += '    <select class="ve-prop-input ve-clip-prop" data-prop="animation">';
      const anims = ["none", "fadeIn", "slideUp", "slideLeft", "slideRight", "slideDown", "typewriter", "bounce", "scaleIn"];
      for (const a of anims) {
        const selected = (clip.animation || "none") === a ? " selected" : "";
        html += '      <option value="' + a + '"' + selected + ">" + a + "</option>";
      }
      html += "    </select>";
      html += '    <input class="ve-prop-slider ve-clip-prop ve-anim-dur-slider" data-prop="animDurationIn" type="range" min="0.1" max="3" step="0.1" value="' + (clip.animDurationIn || 0.5) + '" style="width:60px;flex:none;">';
      html += '    <span class="ve-prop-value" style="font-size:11px;min-width:24px;">' + (clip.animDurationIn || 0.5) + 's</span>';
      html += "  </div>";
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.anim_out") || "Out") + '</span>';
      html += '    <select class="ve-prop-input ve-clip-prop" data-prop="animationOut">';
      const animsOut = ["none", "fadeOut", "slideUp", "slideLeft", "slideRight", "slideDown", "scaleOut"];
      for (const a of animsOut) {
        const selected = (clip.animationOut || "none") === a ? " selected" : "";
        html += '      <option value="' + a + '"' + selected + ">" + a + "</option>";
      }
      html += "    </select>";
      html += '    <input class="ve-prop-slider ve-clip-prop ve-anim-dur-slider" data-prop="animDurationOut" type="range" min="0.1" max="3" step="0.1" value="' + (clip.animDurationOut || 0.5) + '" style="width:60px;flex:none;">';
      html += '    <span class="ve-prop-value" style="font-size:11px;min-width:24px;">' + (clip.animDurationOut || 0.5) + 's</span>';
      html += "  </div>";
      html += "</div>";
    }

    // Subtitle specific
    if (clip.type === "subtitle") {
      const ST = typeof SubtitleTemplates !== "undefined" ? SubtitleTemplates : null;
      const templates = ST ? ST.SUBTITLE_TEMPLATES : [];

      html += '<div class="ve-prop-group">';
      html += '  <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.sub_style", ) || "Subtitle Style") + "</div>";

      // Template selector
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.sub_template") || "Template") + '</span>';
      html += '    <select class="ve-prop-input ve-clip-prop" data-prop="template" style="flex:1;">';
      for (const tmpl of templates) {
        const selected = (clip.template || "classic") === tmpl.key ? " selected" : "";
        html += '      <option value="' + tmpl.key + '"' + selected + ">" + tmpl.name + "</option>";
      }
      html += "    </select>";
      html += "  </div>";

      // Words per group
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.sub_words_per_group") || "Words/Group") + '</span>';
      html += '    <input class="ve-prop-input ve-clip-prop" data-prop="wordsPerGroup" type="number" min="1" max="10" value="' + (clip.wordsPerGroup || 4) + '">';
      html += "  </div>";

      // Font family
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">Font</span>';
      html += '    <select class="ve-prop-input ve-clip-prop" data-prop="fontFamily" style="flex:1;">';
      const subFonts = ["Arial", "Georgia", "Helvetica", "Times New Roman", "Courier New", "Impact", "Verdana", "Tahoma", "Comic Sans MS"];
      for (const f of subFonts) {
        const selected = (clip.fontFamily || "Arial") === f ? " selected" : "";
        html += '      <option value="' + f + '"' + selected + ">" + f + "</option>";
      }
      html += "    </select>";
      html += "  </div>";

      // Font size
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">Size</span>';
      html += '    <input class="ve-prop-input ve-clip-prop" data-prop="fontSize" type="number" min="12" max="200" value="' + (clip.fontSize || 52) + '">';
      html += "  </div>";

      // Font color
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.sub_font_color") || "Text") + '</span>';
      html += '    <input type="color" class="ve-clip-prop" data-prop="fontColor" value="' + (clip.fontColor || "#ffffff") + '" style="width:40px;height:28px;border:none;padding:0;cursor:pointer;">';
      html += "  </div>";

      // Highlight color
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.sub_highlight_color") || "Highlight") + '</span>';
      html += '    <input type="color" class="ve-clip-prop" data-prop="highlightColor" value="' + (clip.highlightColor || "#FFD700") + '" style="width:40px;height:28px;border:none;padding:0;cursor:pointer;">';
      html += "  </div>";

      // Stroke color
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.sub_stroke") || "Stroke") + '</span>';
      html += '    <input type="color" class="ve-clip-prop" data-prop="strokeColor" value="' + (clip.strokeColor || "#000000") + '" style="width:40px;height:28px;border:none;padding:0;cursor:pointer;">';
      html += '    <input class="ve-prop-input ve-clip-prop" data-prop="strokeWidth" type="number" min="0" max="10" value="' + (clip.strokeWidth ?? 2) + '" style="width:48px;flex:none;">';
      html += "  </div>";
      html += "</div>";

      // Words Editor
      html += '<div class="ve-prop-group">';
      html += '  <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.sub_words_editor") || "Words") + "</div>";
      html += '  <div class="ve-subtitle-words-editor" id="ve-subtitle-words-editor">';

      const words = clip.words || [];
      for (let wi = 0; wi < words.length; wi++) {
        const w = words[wi];
        html += '    <div class="ve-subtitle-word-row" data-word-index="' + wi + '">';
        html += '      <input class="ve-sub-word-text" type="text" value="' + escapeHtml(w.text) + '" title="Word text">';
        html += '      <input class="ve-sub-word-start" type="number" step="0.01" min="0" value="' + w.start.toFixed(2) + '" title="Start (s)">';
        html += '      <input class="ve-sub-word-end" type="number" step="0.01" min="0" value="' + w.end.toFixed(2) + '" title="End (s)">';
        html += '      <button class="ve-sub-word-del" title="Delete word"><span class="material-icons" style="font-size:14px;">close</span></button>';
        html += "    </div>";
      }

      html += "  </div>";
      html += '  <button class="ve-sub-add-word-btn" id="ve-sub-add-word-btn">';
      html += '    <span class="material-icons" style="font-size:14px;margin-right:4px;">add</span>';
      html += "    " + (window.I18n?.t("videoeditor.sub_add_word") || "Add Word");
      html += "  </button>";
      html += "</div>";
    }

    // Audio specific
    if (clip.type === "audio" || clip.type === "video") {
      const isMuted = !!clip.muted;
      html += '<div class="ve-prop-group">';
      html += '  <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.audio_props") || "Audio") + "</div>";
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">Vol</span>';
      html += '    <input class="ve-prop-slider ve-clip-prop" data-prop="volume" type="range" min="0" max="1" step="0.05" value="' + (clip.volume ?? 1) + '"' + (isMuted ? ' disabled style="opacity:0.4;"' : '') + '>';
      html += '    <span class="ve-prop-value" style="font-size:11px;min-width:25px;' + (isMuted ? 'opacity:0.4;' : '') + '">' + (isMuted ? 'Muted' : Math.round((clip.volume ?? 1) * 100) + '%') + '</span>';
      html += '  </div>';
      html += '  <div class="ve-prop-row" style="margin-top:4px;">';
      html += '    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:pointer;user-select:none;">';
      html += '      <input type="checkbox" id="ve-clip-mute-toggle" style="cursor:pointer;"' + (isMuted ? ' checked' : '') + '>';
      html += '      <span class="material-icons" style="font-size:16px;">' + (isMuted ? 'volume_off' : 'volume_up') + '</span>';
      html += '      Mute audio';
      html += '    </label>';
      html += '  </div>';
      html += "</div>";
    }

    // Animation (for image and video clips)
    if (clip.type === "image" || clip.type === "video") {
      html += '<div class="ve-prop-group">';
      html += '  <div class="ve-prop-group-title">' + (window.I18n?.t("videoeditor.animation") || "Animation") + "</div>";
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.anim_in") || "In") + '</span>';
      html += '    <select class="ve-prop-input ve-clip-prop" data-prop="animation">';
      const animsImg = ["none", "fadeIn", "slideUp", "slideDown", "slideLeft", "slideRight", "scaleIn", "bounce"];
      for (const a of animsImg) {
        const selected = (clip.animation || "none") === a ? " selected" : "";
        html += '      <option value="' + a + '"' + selected + ">" + a + "</option>";
      }
      html += "    </select>";
      html += '  </div>';
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.anim_duration") || "Dur") + '</span>';
      html += '    <input class="ve-prop-slider ve-clip-prop ve-anim-dur-slider" data-prop="animDurationIn" type="range" min="0.1" max="3" step="0.1" value="' + (clip.animDurationIn || 0.5) + '">';
      html += '    <span class="ve-prop-value" style="font-size:11px;min-width:30px;">' + (clip.animDurationIn || 0.5) + 's</span>';
      html += '  </div>';
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.anim_out") || "Out") + '</span>';
      html += '    <select class="ve-prop-input ve-clip-prop" data-prop="animationOut">';
      const animsImgOut = ["none", "fadeOut", "slideUp", "slideDown", "slideLeft", "slideRight", "scaleOut"];
      for (const a of animsImgOut) {
        const selected = (clip.animationOut || "none") === a ? " selected" : "";
        html += '      <option value="' + a + '"' + selected + ">" + a + "</option>";
      }
      html += "    </select>";
      html += '  </div>';
      html += '  <div class="ve-prop-row">';
      html += '    <span class="ve-prop-label">' + (window.I18n?.t("videoeditor.anim_duration") || "Dur") + '</span>';
      html += '    <input class="ve-prop-slider ve-clip-prop ve-anim-dur-slider" data-prop="animDurationOut" type="range" min="0.1" max="3" step="0.1" value="' + (clip.animDurationOut || 0.5) + '">';
      html += '    <span class="ve-prop-value" style="font-size:11px;min-width:30px;">' + (clip.animDurationOut || 0.5) + 's</span>';
      html += '  </div>';
      html += "</div>";
    }

    content.html(html);

    // Property change handlers
    $(document).off("change" + NS, ".ve-clip-prop");
    $(document).on("change" + NS, ".ve-clip-prop", function () {
      const prop = $(this).data("prop");
      let val = $(this).val();

      // Type coercion
      const numProps = ["position.x", "position.y", "size.width", "size.height", "opacity", "startTime", "duration", "fontSize", "volume", "animDurationIn", "animDurationOut", "wordsPerGroup", "strokeWidth"];
      if (numProps.includes(prop)) val = parseFloat(val);

      // Set nested property
      const parts = prop.split(".");
      if (parts.length === 2) {
        if (!clip[parts[0]]) clip[parts[0]] = {};
        clip[parts[0]][parts[1]] = val;
      } else {
        clip[prop] = val;
      }

      pushUndoState();
      syncTracksToPreview();
      timeline?.render();
    });

    $(document).off("input" + NS, ".ve-prop-slider.ve-clip-prop");
    $(document).on("input" + NS, ".ve-prop-slider.ve-clip-prop", function () {
      const val = parseFloat($(this).val());
      if ($(this).hasClass("ve-anim-dur-slider")) {
        $(this).closest(".ve-prop-row").find(".ve-prop-value").text(val.toFixed(1) + "s");
      } else {
        $(this).closest(".ve-prop-row").find(".ve-prop-value").text(Math.round(val * 100) + "%");
      }
    });

    // Mute toggle for audio/video clips
    $(document).off("change" + NS, "#ve-clip-mute-toggle");
    $(document).on("change" + NS, "#ve-clip-mute-toggle", function () {
      clip.muted = this.checked;
      pushUndoState();
      syncTracksToPreview();
      timeline?.render();
      showClipProperties(clip.id);
    });

    // Subtitle template change — apply template defaults
    if (clip.type === "subtitle") {
      $(document).off("change" + NS, '[data-prop="template"]');
      $(document).on("change" + NS, '[data-prop="template"]', function () {
        const ST = typeof SubtitleTemplates !== "undefined" ? SubtitleTemplates : null;
        if (!ST) return;
        const tmpl = ST.SUBTITLE_TEMPLATES.find((t) => t.key === $(this).val());
        if (tmpl) {
          clip.fontSize = tmpl.defaults.fontSize;
          clip.fontFamily = tmpl.defaults.fontFamily;
          clip.fontColor = tmpl.defaults.fontColor;
          clip.highlightColor = tmpl.defaults.highlightColor;
          clip.strokeColor = tmpl.defaults.strokeColor;
          clip.strokeWidth = tmpl.defaults.strokeWidth;
          clip.backgroundColor = tmpl.defaults.backgroundColor;
          pushUndoState();
          syncTracksToPreview();
          showClipProperties(clip.id);
        }
      });

      // Word text/timing edits
      $(document).off("change" + NS, ".ve-sub-word-text, .ve-sub-word-start, .ve-sub-word-end");
      $(document).on("change" + NS, ".ve-sub-word-text, .ve-sub-word-start, .ve-sub-word-end", function () {
        const row = $(this).closest(".ve-subtitle-word-row");
        const idx = parseInt(row.data("word-index"), 10);
        if (!clip.words || idx < 0 || idx >= clip.words.length) return;

        if ($(this).hasClass("ve-sub-word-text")) {
          clip.words[idx].text = $(this).val();
        } else if ($(this).hasClass("ve-sub-word-start")) {
          clip.words[idx].start = parseFloat($(this).val()) || 0;
        } else if ($(this).hasClass("ve-sub-word-end")) {
          clip.words[idx].end = parseFloat($(this).val()) || 0;
        }
        pushUndoState();
        syncTracksToPreview();
        timeline?.render();
      });

      // Delete word
      $(document).off("click" + NS, ".ve-sub-word-del");
      $(document).on("click" + NS, ".ve-sub-word-del", function () {
        const row = $(this).closest(".ve-subtitle-word-row");
        const idx = parseInt(row.data("word-index"), 10);
        if (!clip.words || idx < 0 || idx >= clip.words.length) return;
        clip.words.splice(idx, 1);
        pushUndoState();
        syncTracksToPreview();
        showClipProperties(clip.id);
      });

      // Add word
      $(document).off("click" + NS, "#ve-sub-add-word-btn");
      $(document).on("click" + NS, "#ve-sub-add-word-btn", function () {
        if (!clip.words) clip.words = [];
        const lastEnd = clip.words.length > 0 ? clip.words[clip.words.length - 1].end : 0;
        clip.words.push({ text: "word", start: lastEnd, end: lastEnd + 0.5 });
        clip.duration = Math.max(clip.duration, lastEnd + 0.5);
        pushUndoState();
        syncTracksToPreview();
        showClipProperties(clip.id);
      });
    }
  }

  // ============================================
  // Context Menu
  // ============================================

  function showContextMenu(clipId, x, y) {
    const menu = $("#ve-context-menu");
    // Temporarily show off-screen to measure height
    menu.css({ left: "-9999px", top: "-9999px" }).show();
    const menuH = menu.outerHeight();
    const menuW = menu.outerWidth();
    // Ensure the menu fits within the viewport
    const winH = window.innerHeight;
    const winW = window.innerWidth;
    if (y + menuH > winH) y = Math.max(0, winH - menuH - 4);
    if (x + menuW > winW) x = Math.max(0, winW - menuW - 4);
    menu.css({ left: x + "px", top: y + "px" });
    menu.data("clip-id", clipId);
  }

  function handleContextAction(action) {
    const clipId = timeline?.selectedClipId;
    if (!clipId) return;

    switch (action) {
      case "duplicate":
        timeline.duplicateClip(clipId);
        pushUndoState();
        syncTracksToPreview();
        break;
      case "split":
        if (previewEngine) {
          timeline.splitClip(clipId, previewEngine.currentTime);
          pushUndoState();
          syncTracksToPreview();
        }
        break;
      case "delete":
        deleteSelectedClip();
        break;
      case "bring-front":
      case "send-back": {
        // Find the track that contains this clip
        const clipTrack = timeline.tracks.find((t) => t.clips.some((c) => c.id === clipId));
        if (clipTrack) {
          timeline.moveTrack(clipTrack.id, action === "bring-front" ? "up" : "down");
          pushUndoState();
          syncTracksToPreview();
        }
        break;
      }
    }
  }

  // ============================================
  // Add Track Menu
  // ============================================

  function showAddTrackMenu() {
    const types = [
      { type: "video", label: "Video Track", icon: "videocam" },
      { type: "audio", label: "Audio Track", icon: "music_note" },
      { type: "text", label: "Text Track", icon: "title" },
      { type: "image", label: "Image Track", icon: "image" }
    ];

    // Simple approach: cycle through types
    const counts = {};
    for (const t of timeline.tracks) {
      counts[t.type] = (counts[t.type] || 0) + 1;
    }

    // Add the most needed type, or video by default
    const type = types.find((t) => !counts[t.type]) || types[0];
    const count = (counts[type.type] || 0) + 1;
    timeline.addTrack(type.type, type.label.split(" ")[0] + " " + count);
    pushUndoState();
    syncTracksToPreview();
  }

  // ============================================
  // Undo/Redo
  // ============================================

  function pushUndoState() {
    if (!timeline) return;
    const state = JSON.stringify(timeline.tracks);
    undoStack.push(state);
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
  }

  function undo() {
    if (undoStack.length <= 1) return;
    const current = undoStack.pop();
    redoStack.push(current);
    const prev = undoStack[undoStack.length - 1];
    if (prev) {
      const tracks = JSON.parse(prev);
      timeline?.loadTracks(tracks);
      syncTracksToPreview();
    }
  }

  function redo() {
    if (redoStack.length === 0) return;
    const state = redoStack.pop();
    undoStack.push(state);
    const tracks = JSON.parse(state);
    timeline?.loadTracks(tracks);
    syncTracksToPreview();
  }

  // ============================================
  // Utilities
  // ============================================

  function formatTimecode(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return "00:00.0";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + ms;
  }

  function formatDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString();
  }

  // ============================================
  // Placeholders Panel
  // ============================================

  function getNextPlaceholderNumber() {
    if (!timeline) return 1;
    let maxNum = 0;
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.isPlaceholder && clip.placeholderId) {
          const num = parseInt(clip.placeholderId.replace('placeholder_', ''), 10);
          if (num > maxNum) maxNum = num;
        }
      }
    }
    return maxNum + 1;
  }

  function getExistingPlaceholders() {
    if (!timeline) return [];
    const placeholders = [];
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.isPlaceholder) placeholders.push(clip);
      }
    }
    return placeholders.sort((a, b) => {
      const na = parseInt(a.placeholderId?.replace('placeholder_', '') || '0', 10);
      const nb = parseInt(b.placeholderId?.replace('placeholder_', '') || '0', 10);
      return na - nb;
    });
  }

  function renderPlaceholdersPanel(container) {
    const t = (k, fb) => window.I18n?.t("videoeditor." + k) || fb;

    let html = '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + t("add_placeholder", "Add Placeholder") + '</div>';

    // Type selector
    html += '  <div class="ve-prop-row">';
    html += '    <label>' + t("placeholder_type", "Type") + '</label>';
    html += '    <select class="ve-prop-input" id="ve-ph-type">';
    html += '      <option value="image">' + t("image", "Image") + '</option>';
    html += '      <option value="video">' + t("video", "Video") + '</option>';
    html += '      <option value="audio">' + t("audio", "Audio") + '</option>';
    html += '    </select>';
    html += '  </div>';

    // Aspect ratio input (hidden for audio)
    html += '  <div class="ve-prop-row" id="ve-ph-aspect-row">';
    html += '    <label>' + t("placeholder_aspect", "Aspect Ratio") + '</label>';
    html += '    <input class="ve-prop-input" id="ve-ph-aspect" type="text" value="9:16" placeholder="9:16" style="flex:1;">';
    html += '  </div>';

    // Duration
    html += '  <div class="ve-prop-row">';
    html += '    <label>' + t("placeholder_duration", "Duration (s)") + '</label>';
    html += '    <input class="ve-prop-input" id="ve-ph-duration" type="number" min="0.5" max="120" step="0.5" value="5">';
    html += '  </div>';

    // Add button
    html += '  <button class="ve-media-import-btn" id="ve-ph-add-btn" style="margin-top:8px;">';
    html += '    <span class="material-icons">add_circle_outline</span>';
    html += '    <span>' + t("add_to_timeline", "Add to Timeline") + '</span>';
    html += '  </button>';
    html += '</div>';

    // Existing placeholders list
    const placeholders = getExistingPlaceholders();
    html += '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + t("current_placeholders", "Current Placeholders") + '</div>';
    if (placeholders.length === 0) {
      html += '  <div class="ve-no-selection" style="padding:12px 0;"><p style="font-size:12px;color:var(--text-secondary);">' + t("no_placeholders", "No placeholders added yet") + '</p></div>';
    } else {
      html += '  <div class="ve-placeholder-list">';
      for (const ph of placeholders) {
        const num = ph.placeholderId?.replace('placeholder_', '') || '?';
        const typeIcon = ph.type === 'video' ? 'videocam' : ph.type === 'audio' ? 'music_note' : 'image';
        html += '  <div class="ve-placeholder-item" data-clip-id="' + ph.id + '">';
        html += '    <span class="material-icons" style="font-size:16px;margin-right:6px;">' + typeIcon + '</span>';
        html += '    <span>' + t("placeholder_label", "Placeholder") + ' ' + num + '</span>';
        html += '    <span style="margin-left:auto;font-size:11px;color:var(--text-secondary);">' + (ph.duration || 5) + 's</span>';
        html += '  </div>';
      }
      html += '  </div>';
    }
    html += '</div>';

    // Info about text placeholders
    html += '<div class="ve-panel-section">';
    html += '  <div class="ve-panel-section-title">' + t("text_placeholders", "Text Placeholders") + '</div>';
    html += '  <p style="font-size:11px;color:var(--text-secondary);line-height:1.5;margin:0;">';
    html += t("text_placeholder_info", "To create text placeholders, add a text clip and use {INPUT_2}, {INPUT_3}, etc. in the text content. These will be replaced with automation inputs.");
    html += '  </p>';
    html += '</div>';

    container.html(html);

    // Toggle aspect ratio row visibility based on type
    function toggleAspectRow() {
      const isAudio = $("#ve-ph-type").val() === "audio";
      $("#ve-ph-aspect-row").toggle(!isAudio);
    }
    toggleAspectRow();
    $("#ve-ph-type").off("change").on("change", toggleAspectRow);

    // Add to timeline click
    $("#ve-ph-add-btn").off("click").on("click", function () {
      const type = $("#ve-ph-type").val();
      const aspect = $("#ve-ph-aspect").val();
      const duration = parseFloat($("#ve-ph-duration").val()) || 5;
      addPlaceholderToTimeline(type, aspect, duration);
      renderPlaceholdersPanel(container); // Refresh list
    });

    // Click on placeholder item to select it in timeline
    container.find(".ve-placeholder-item").off("click").on("click", function () {
      const clipId = $(this).data("clip-id");
      if (timeline && clipId) {
        timeline.selectClip(clipId);
      }
    });
  }

  function addPlaceholderToTimeline(type, aspectRatio, duration) {
    if (!currentProject || !timeline) return;

    const num = getNextPlaceholderNumber();

    // Audio placeholders don't need visual position/size
    if (type === 'audio') {
      const clip = {
        type: 'audio',
        source: null,
        isPlaceholder: true,
        placeholderId: 'placeholder_' + num,
        startTime: previewEngine?.currentTime || 0,
        duration: duration,
        volume: 1,
        name: (window.I18n?.t("videoeditor.placeholder_label") || "Placeholder") + " " + num
      };
      addClipToTimeline(clip, 'audio');
      return;
    }

    const projW = currentProject.settings.width;
    const projH = currentProject.settings.height;
    let clipWidth, clipHeight;

    if (aspectRatio === 'fill') {
      clipWidth = projW;
      clipHeight = projH;
    } else {
      const parts = aspectRatio.split(':').map(Number);
      const aw = parts[0] || 9;
      const ah = parts[1] || 16;
      const ratio = aw / ah;
      // Fit within project dimensions while preserving aspect ratio
      if (projW / projH > ratio) {
        clipHeight = projH;
        clipWidth = Math.round(projH * ratio);
      } else {
        clipWidth = projW;
        clipHeight = Math.round(projW / ratio);
      }
    }

    const clip = {
      type: type,
      source: null,
      isPlaceholder: true,
      placeholderId: 'placeholder_' + num,
      startTime: previewEngine?.currentTime || 0,
      duration: duration,
      position: {
        x: Math.round((projW - clipWidth) / 2),
        y: Math.round((projH - clipHeight) / 2)
      },
      size: { width: clipWidth, height: clipHeight },
      opacity: 1,
      name: (window.I18n?.t("videoeditor.placeholder_label") || "Placeholder") + " " + num
    };

    if (type === 'video') {
      clip.volume = 1;
      clip.trimStart = 0;
      clip.trimEnd = 0;
    }

    addClipToTimeline(clip, type);
  }

  // ============================================
  // Sync template: each project has at most one template (keyed by project id).
  // If the project contains placeholders it's a template; otherwise remove it.
  // ============================================

  async function syncTemplate(project) {
    if (!project || !project.id) return;
    try {
      const placeholders = getExistingPlaceholders();
      let templates = (await window.electronAPI.readKey('videoTemplates') || []).filter(Boolean);

      // Migrate old-style templates that belong to this project
      templates = templates.map((t) => {
        if (!t.projectId && t.project && t.project.id === project.id) {
          return { ...t, projectId: project.id };
        }
        return t;
      });

      // Remove any existing template for this project
      templates = templates.filter((t) => t.projectId !== project.id);

      if (placeholders.length > 0) {
        // Mark project as template
        project.isTemplate = true;

        let preview = null;
        if (previewEngine) preview = previewEngine.getThumbnail();

        templates.push({
          id: 'vt_' + project.id,
          projectId: project.id,
          label: project.name || 'Untitled Template',
          preview: preview,
          project: JSON.parse(JSON.stringify(project)),
          createdAt: Date.now()
        });
      } else {
        project.isTemplate = false;
      }

      await window.electronAPI.updateData('videoTemplates', templates);
    } catch (err) {
      console.error('[VideoEditor] Sync template error:', err);
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function showToast(msg) {
    // Simple toast notification
    const toast = $('<div style="position:fixed;bottom:20px;right:20px;background:var(--accent-color);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:9999;animation:veModalIn 0.3s ease;">' + msg + "</div>");
    $("body").append(toast);
    setTimeout(() => toast.fadeOut(300, () => toast.remove()), 2000);
  }

  function vePrompt(message, defaultValue) {
    return new Promise((resolve) => {
      const overlay = $(`<div class="ve-prompt-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;animation:veModalIn 0.2s ease;">
        <div style="background:var(--bg-primary);border-radius:12px;padding:24px;min-width:360px;max-width:460px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
          <p style="margin:0 0 12px;color:var(--text-primary);font-size:14px;">${message}</p>
          <input type="text" class="ve-prompt-input" style="width:100%;padding:8px 12px;border:1px solid var(--border-color);border-radius:6px;font-size:13px;background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;" />
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button class="ve-prompt-cancel btn" style="padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer;">${window.I18n?.t("common.cancel") || "Cancel"}</button>
            <button class="ve-prompt-ok btn btn-primary" style="padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer;background:var(--accent-color);color:#fff;border:none;">${window.I18n?.t("common.ok") || "OK"}</button>
          </div>
        </div>
      </div>`);
      const input = overlay.find(".ve-prompt-input");
      if (defaultValue) input.val(defaultValue);
      overlay.find(".ve-prompt-cancel").on("click", () => { overlay.remove(); resolve(null); });
      overlay.find(".ve-prompt-ok").on("click", () => { const v = input.val(); overlay.remove(); resolve(v && v.trim() ? v.trim() : null); });
      input.on("keydown", (e) => { if (e.key === "Enter") overlay.find(".ve-prompt-ok").click(); if (e.key === "Escape") overlay.find(".ve-prompt-cancel").click(); });
      overlay.on("click", (e) => { if (e.target === overlay[0]) { overlay.remove(); resolve(null); } });
      $("body").append(overlay);
      input.focus().select();
    });
  }

  function veConfirm(message) {
    return new Promise((resolve) => {
      const overlay = $(`<div class="ve-prompt-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;animation:veModalIn 0.2s ease;">
        <div style="background:var(--bg-primary);border-radius:12px;padding:24px;min-width:360px;max-width:460px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
          <p style="margin:0 0 16px;color:var(--text-primary);font-size:14px;">${message}</p>
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button class="ve-prompt-cancel btn" style="padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer;">${window.I18n?.t("common.cancel") || "Cancel"}</button>
            <button class="ve-prompt-ok btn btn-primary" style="padding:6px 16px;border-radius:6px;font-size:13px;cursor:pointer;background:#dc3545;color:#fff;border:none;">${window.I18n?.t("common.confirm") || "Confirm"}</button>
          </div>
        </div>
      </div>`);
      overlay.find(".ve-prompt-cancel").on("click", () => { overlay.remove(); resolve(false); });
      overlay.find(".ve-prompt-ok").on("click", () => { overlay.remove(); resolve(true); });
      overlay.on("click", (e) => { if (e.target === overlay[0]) { overlay.remove(); resolve(false); } });
      $("body").append(overlay);
      overlay.find(".ve-prompt-ok").focus();
    });
  }

  // ============================================
  // Project File Export/Import (.vcve)
  // ============================================

  async function exportProjectFile() {
    if (!currentProject) return;
    await saveProject();
    const name = currentProject.name || "video-project";
    const result = await window.electronAPI.exportVideoProject(currentProject, name);
    if (result.success) {
      showAlert(window.I18n?.t("videoeditor.export_project_success") || "Project exported successfully!", "success");
    } else if (result.error) {
      showAlert(result.error, "error");
    }
  }

  async function exportProjectFileById(projectId) {
    const projects = await window.electronAPI.readKey("videoProjects") || [];
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const name = project.name || "video-project";
    const result = await window.electronAPI.exportVideoProject(project, name);
    if (result.success) {
      showAlert(window.I18n?.t("videoeditor.export_project_success") || "Project exported successfully!", "success");
    } else if (result.error) {
      showAlert(result.error, "error");
    }
  }

  async function importProjectFile() {
    const result = await window.electronAPI.importVideoProject();
    if (!result.success) {
      if (result.error) showAlert(result.error, "error");
      return;
    }
    const projects = await window.electronAPI.readKey("videoProjects") || [];
    for (const proj of result.projects) {
      proj.createdAt = new Date().toISOString();
      proj.updatedAt = new Date().toISOString();
      projects.push(proj);
    }
    await window.electronAPI.updateData("videoProjects", projects);
    showAlert(window.I18n?.t("videoeditor.import_project_success") || "Project imported successfully!", "success");
    loadProjectList();
  }

  // Auto-initialize when script loads
  $(document).ready(function () {
    window.initVideoEditor();
  });
})();
