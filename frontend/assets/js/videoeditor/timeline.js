/**
 * Video Editor - Timeline Component
 * Multi-track timeline with clip management, playhead, zoom, and snap
 */
(function () {
  "use strict";

  class Timeline {
    constructor() {
      this.tracks = [];
      this.pixelsPerSecond = 100;
      this.duration = 10;
      this.currentTime = 0;
      this.snapEnabled = true;
      this.snapThreshold = 8; // pixels
      this._snapLineEl = null;
      this.selectedClipId = null;
      this.isDragging = false;
      this.isResizing = false;
      this.dragData = null;
      this.scrollLeft = 0;

      // DOM references
      this.rulerEl = null;
      this.tracksEl = null;
      this.headersEl = null;
      this.playheadEl = null;
      this.scrollContainer = null;

      // Callbacks
      this.onClipSelect = null;
      this.onClipMove = null;
      this.onClipResize = null;
      this.onSeek = null;
      this.onTrackChange = null;
      this.onClipContextMenu = null;
      this.onClipDrop = null;

      this._boundMouseMove = this._onMouseMove.bind(this);
      this._boundMouseUp = this._onMouseUp.bind(this);
    }

    /**
     * Initialize timeline with DOM elements
     */
    init(opts) {
      this.rulerEl = document.getElementById("ve-timeline-ruler");
      this.tracksEl = document.getElementById("ve-timeline-tracks");
      this.headersEl = document.getElementById("ve-track-headers");
      this.playheadEl = document.getElementById("ve-playhead");
      this.scrollContainer = document.getElementById("ve-timeline-tracks-scroll");

      this._setupRulerClick();
      this._setupDragDrop();
      this._setupWheelZoom();
      this._setupScrollSync();
    }

    /**
     * Load tracks data
     */
    loadTracks(tracks) {
      this.tracks = tracks;
      this._calculateDuration();
      this.render();
    }

    _calculateDuration() {
      let maxEnd = 10;
      for (const track of this.tracks) {
        for (const clip of track.clips) {
          const end = clip.startTime + clip.duration;
          if (end > maxEnd) maxEnd = end;
        }
      }
      // Add 5% extra space (min 5s) so the timeline doesn't end abruptly
      this.duration = Math.max(maxEnd * 1.05, maxEnd + 5);
    }

    /**
     * Set zoom level (pixels per second)
     */
    setZoom(pps) {
      this.pixelsPerSecond = Math.max(5, Math.min(500, pps));
      this.render();
      // Sync the zoom slider if it exists
      const slider = document.getElementById("ve-tl-zoom-slider");
      if (slider) slider.value = this.pixelsPerSecond;
    }

    /**
     * Setup Ctrl+Mouse Wheel zoom on the timeline
     */
    _setupWheelZoom() {
      const container = document.getElementById("ve-timeline");
      if (!container) return;

      container.addEventListener("wheel", (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();

        // Zoom centered on mouse position
        const scrollEl = this.scrollContainer;
        const mouseX = e.clientX - (scrollEl?.getBoundingClientRect().left || 0) + (scrollEl?.scrollLeft || 0);
        const timeAtMouse = mouseX / this.pixelsPerSecond;

        const delta = e.deltaY > 0 ? -15 : 15;
        const newPps = Math.max(5, Math.min(500, this.pixelsPerSecond + delta));
        if (newPps === this.pixelsPerSecond) return;

        this.pixelsPerSecond = newPps;
        this.render();

        // Keep the point under the mouse in the same screen position
        if (scrollEl) {
          const newMouseX = timeAtMouse * this.pixelsPerSecond;
          const offsetFromLeft = e.clientX - scrollEl.getBoundingClientRect().left;
          scrollEl.scrollLeft = newMouseX - offsetFromLeft;
        }

        const slider = document.getElementById("ve-tl-zoom-slider");
        if (slider) slider.value = this.pixelsPerSecond;
      }, { passive: false });
    }

    /**
     * Sync ruler horizontal scroll with tracks scroll
     */
    _setupScrollSync() {
      if (!this.scrollContainer || !this.rulerEl) return;
      this.scrollContainer.addEventListener("scroll", () => {
        const rulerTicks = this.rulerEl.querySelector(".ve-ruler-ticks");
        if (rulerTicks) {
          rulerTicks.style.transform = "translateX(" + (-this.scrollContainer.scrollLeft) + "px)";
        }
      });
    }

    /**
     * Toggle snap
     */
    toggleSnap() {
      this.snapEnabled = !this.snapEnabled;
      return this.snapEnabled;
    }

    /**
     * Render the entire timeline
     */
    render() {
      this._renderRuler();
      this._renderHeaders();
      this._renderTracks();
      this._updatePlayheadPosition();
    }

    _renderRuler() {
      if (!this.rulerEl) return;

      const totalWidth = this.duration * this.pixelsPerSecond;
      let html = '<div class="ve-ruler-spacer"></div>';
      html += '<div class="ve-ruler-ticks" style="width:' + totalWidth + 'px;">';

      // Determine tick interval based on zoom
      let interval = 1;
      if (this.pixelsPerSecond < 15) interval = 10;
      else if (this.pixelsPerSecond < 30) interval = 5;
      else if (this.pixelsPerSecond < 60) interval = 2;
      else if (this.pixelsPerSecond > 200) interval = 0.5;

      for (let t = 0; t <= this.duration; t += interval) {
        const x = t * this.pixelsPerSecond;
        const label = this._formatTime(t);
        html += '<div class="ve-ruler-tick" style="left:' + x + 'px;">';
        html += '<span class="ve-ruler-tick-label">' + label + "</span>";
        html += "</div>";
      }

      html += "</div>";
      this.rulerEl.innerHTML = html;
    }

    _renderHeaders() {
      if (!this.headersEl) return;

      let html = "";
      for (const track of this.tracks) {
        const typeIcon = this._getTrackIcon(track.type);
        const lockIcon = track.locked ? "lock" : "lock_open";
        const visIcon = track.visible ? "visibility" : "visibility_off";
        const muteClass = track.visible ? "" : " ve-track-muted";

        html += '<div class="ve-track-header' + muteClass + '" data-track-id="' + track.id + '">';
        html += '  <span class="material-icons ve-track-header-icon">' + typeIcon + "</span>";
        html += '  <span class="ve-track-header-name">' + this._escapeHtml(track.name) + "</span>";
        html += '  <button class="ve-track-header-btn ve-track-lock-btn" data-track-id="' + track.id + '">';
        html += '    <span class="material-icons">' + lockIcon + "</span>";
        html += "  </button>";
        html += '  <button class="ve-track-header-btn ve-track-vis-btn" data-track-id="' + track.id + '">';
        html += '    <span class="material-icons">' + visIcon + "</span>";
        html += "  </button>";
        html += '  <button class="ve-track-header-btn ve-track-del-btn" data-track-id="' + track.id + '">';
        html += '    <span class="material-icons">close</span>';
        html += "  </button>";
        html += "</div>";
      }

      this.headersEl.innerHTML = html;
      this._setupHeaderEvents();
    }

    _renderTracks() {
      if (!this.tracksEl) return;

      const totalWidth = this.duration * this.pixelsPerSecond;
      const ending = window.VEPreviewEngine?.getEndingImage(this.tracks);
      let html = "";

      for (const track of this.tracks) {
        html += '<div class="ve-track-lane" data-track-id="' + track.id + '" style="width:' + totalWidth + 'px;">';

        for (const clip of track.clips) {
          const left = clip.startTime * this.pixelsPerSecond;
          const width = clip.duration * this.pixelsPerSecond;
          const typeClass = "ve-clip-" + clip.type;
          const selectedClass = clip.id === this.selectedClipId ? " selected" : "";
          const placeholderClass = clip.isPlaceholder ? " ve-clip-placeholder" : "";
          let label = clip.name || clip.text || clip.type;
          if (clip.type === "subtitle" && clip.words && clip.words.length > 0) {
            label = clip.words.slice(0, 6).map((w) => w.text).join(" ");
            if (clip.words.length > 6) label += "...";
          }

          html += '<div class="ve-clip ' + typeClass + selectedClass + placeholderClass + '" ';
          html += 'data-clip-id="' + clip.id + '" data-track-id="' + track.id + '" ';
          html += 'style="left:' + left + "px;width:" + width + 'px;">';
          html += '  <div class="ve-clip-handle ve-clip-handle-left"></div>';
          if (clip.isPlaceholder) {
            html += '  <span class="material-icons ve-clip-ph-icon">extension</span>';
          }
          if (clip.muted && clip.type === 'video') {
            html += '  <span class="material-icons" style="font-size:12px;opacity:0.8;margin-right:3px;flex-shrink:0;">volume_off</span>';
          }
          html += '  <span class="ve-clip-label">' + this._escapeHtml(label) + "</span>";
          html += '  <div class="ve-clip-handle ve-clip-handle-right"></div>';

          // Transition indicator
          if (clip.transition && clip.transition.type !== "none") {
            const tWidth = (clip.transition.duration || 0.5) * this.pixelsPerSecond;
            html += '<div class="ve-clip-transition" style="left:0;width:' + tWidth + 'px;"></div>';
          }

          html += "</div>";
          if (ending?.id === clip.id && clip.endingBuffer) {
            const bufferLabel = window.I18n?.t("videoeditor.ending_buffer") || "Add ending buffer";
            html += '<div class="ve-ending-buffer-marker" style="left:' + (left + width) + 'px;width:' + (5 * this.pixelsPerSecond) + 'px;">' + this._escapeHtml(bufferLabel) + ' (+5s)</div>';
          }
        }

        html += "</div>";
      }

      this.tracksEl.innerHTML = html;
      this.tracksEl.style.width = totalWidth + "px";
      this._setupClipEvents();
    }

    _setupRulerClick() {
      if (!this.rulerEl) return;

      // Create drag time tooltip
      this._dragTimeTooltip = document.createElement("div");
      this._dragTimeTooltip.className = "ve-drag-time-tooltip";
      this._dragTimeTooltip.style.display = "none";
      document.body.appendChild(this._dragTimeTooltip);

      const seekFromEvent = (e) => {
        const rulerTicks = this.rulerEl.querySelector(".ve-ruler-ticks");
        if (!rulerTicks) return;
        const rect = rulerTicks.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = Math.max(0, x / this.pixelsPerSecond);
        if (this.onSeek) this.onSeek(time);

        // Update tooltip with milliseconds
        const min = Math.floor(time / 60);
        const sec = Math.floor(time % 60);
        const ms = Math.floor((time % 1) * 1000);
        this._dragTimeTooltip.textContent = min + ":" + String(sec).padStart(2, "0") + "." + String(ms).padStart(3, "0");
        this._dragTimeTooltip.style.left = e.clientX + "px";
        this._dragTimeTooltip.style.top = (rect.top - 28) + "px";
        this._dragTimeTooltip.style.display = "";
      };

      const onMouseMove = (e) => {
        e.preventDefault();
        seekFromEvent(e);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        this._dragTimeTooltip.style.display = "none";
      };

      // Ruler drag
      this.rulerEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        seekFromEvent(e);
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });

      // Playhead handle drag
      if (this.playheadEl) {
        const handle = this.playheadEl.querySelector(".ve-playhead-handle");
        if (handle) {
          handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            seekFromEvent(e);
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
          });
        }
      }
    }

    _setupHeaderEvents() {
      if (!this.headersEl) return;

      this.headersEl.querySelectorAll(".ve-track-lock-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const trackId = btn.dataset.trackId;
          const track = this.tracks.find((t) => t.id === trackId);
          if (track) {
            track.locked = !track.locked;
            this.render();
            if (this.onTrackChange) this.onTrackChange(this.tracks);
          }
        });
      });

      this.headersEl.querySelectorAll(".ve-track-vis-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const trackId = btn.dataset.trackId;
          const track = this.tracks.find((t) => t.id === trackId);
          if (track) {
            track.visible = !track.visible;
            this.render();
            if (this.onTrackChange) this.onTrackChange(this.tracks);
          }
        });
      });

      this.headersEl.querySelectorAll(".ve-track-del-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const trackId = btn.dataset.trackId;
          this.tracks = this.tracks.filter((t) => t.id !== trackId);
          this.render();
          if (this.onTrackChange) this.onTrackChange(this.tracks);
        });
      });
    }

    _setupClipEvents() {
      if (!this.tracksEl) return;

      this.tracksEl.querySelectorAll(".ve-clip").forEach((clipEl) => {
        // Click to select
        clipEl.addEventListener("mousedown", (e) => {
          if (e.target.classList.contains("ve-clip-handle-left") ||
              e.target.classList.contains("ve-clip-handle-right")) {
            this._startResize(e, clipEl);
            return;
          }
          this._startDrag(e, clipEl);
        });

        // Right-click context menu
        clipEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const clipId = clipEl.dataset.clipId;
          this.selectClip(clipId);
          if (this.onClipContextMenu) {
            this.onClipContextMenu(clipId, e.clientX, e.clientY);
          }
        });
      });
    }

    _setupDragDrop() {
      if (!this.tracksEl) return;
      const dropTarget = this.scrollContainer || this.tracksEl;

      // Create drop indicator element on the scroll container (so it survives re-renders)
      this._dropIndicator = document.createElement("div");
      this._dropIndicator.className = "ve-drop-indicator";
      this._dropIndicator.innerHTML = '<div class="ve-drop-indicator-line"></div><span class="ve-drop-indicator-time"></span>';
      this._dropIndicator.style.display = "none";
      dropTarget.appendChild(this._dropIndicator);

      // Handle drop from side panel
      dropTarget.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";

        // Position the drop indicator
        const rect = dropTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + dropTarget.scrollLeft;
        const time = Math.max(0, x / this.pixelsPerSecond);
        this._dropIndicator.style.left = x + "px";
        this._dropIndicator.style.display = "";
        this._dropIndicator.querySelector(".ve-drop-indicator-time").textContent = this._formatTime(time);
      });

      dropTarget.addEventListener("dragleave", (e) => {
        // Only hide if leaving the drop area entirely
        if (!dropTarget.contains(e.relatedTarget)) {
          this._dropIndicator.style.display = "none";
        }
      });

      dropTarget.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._dropIndicator.style.display = "none";
        const data = e.dataTransfer.getData("application/ve-media");
        if (!data) return;

        try {
          const mediaData = JSON.parse(data);
          const rect = dropTarget.getBoundingClientRect();
          const x = e.clientX - rect.left + dropTarget.scrollLeft;
          const y = e.clientY - rect.top;
          const time = x / this.pixelsPerSecond;
          const trackIndex = Math.floor(y / 50);

          if (this.onClipDrop) {
            this.onClipDrop(mediaData, Math.max(0, time), trackIndex);
          }
        } catch (err) {
          console.warn("[Timeline] Drop parse error:", err);
        }
      });
    }

    _startDrag(e, clipEl) {
      const clipId = clipEl.dataset.clipId;
      const trackId = clipEl.dataset.trackId;
      this.selectClip(clipId);

      const track = this.tracks.find((t) => t.id === trackId);
      if (track?.locked) return;

      const clip = track?.clips.find((c) => c.id === clipId);
      if (!clip) return;

      this.isDragging = true;
      this.dragData = {
        clipId,
        trackId,
        startX: e.clientX,
        originalStartTime: clip.startTime,
        clipEl
      };

      document.addEventListener("mousemove", this._boundMouseMove);
      document.addEventListener("mouseup", this._boundMouseUp);
      e.preventDefault();
    }

    _startResize(e, clipEl) {
      const clipId = clipEl.dataset.clipId;
      const trackId = clipEl.dataset.trackId;
      this.selectClip(clipId);

      const track = this.tracks.find((t) => t.id === trackId);
      if (track?.locked) return;

      const clip = track?.clips.find((c) => c.id === clipId);
      if (!clip) return;

      const isLeft = e.target.classList.contains("ve-clip-handle-left");

      this.isResizing = true;
      this.dragData = {
        clipId,
        trackId,
        startX: e.clientX,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        isLeft,
        clipEl
      };

      document.addEventListener("mousemove", this._boundMouseMove);
      document.addEventListener("mouseup", this._boundMouseUp);
      e.preventDefault();
    }

    _onMouseMove(e) {
      if (!this.dragData) return;

      const dx = e.clientX - this.dragData.startX;
      const dt = dx / this.pixelsPerSecond;

      if (this.isDragging) {
        let newStart = this.dragData.originalStartTime + dt;
        if (newStart < 0) newStart = 0;

        // Snap both start and end edges
        if (this.snapEnabled) {
          const clip = this._findClipById(this.dragData.clipId);
          const snapResult = this._snapClip(newStart, clip ? clip.duration : 0, this.dragData.clipId);
          newStart = snapResult.time;
          this._showSnapLine(snapResult.snapPoint);
        } else {
          this._hideSnapLine();
        }

        const clip = this._findClipById(this.dragData.clipId);
        if (clip) {
          clip.startTime = newStart;
          const left = newStart * this.pixelsPerSecond;
          this.dragData.clipEl.style.left = left + "px";
        }
      }

      if (this.isResizing) {
        const clip = this._findClipById(this.dragData.clipId);
        if (!clip) return;

        if (this.dragData.isLeft) {
          let newStart = this.dragData.originalStartTime + dt;
          let newDuration = this.dragData.originalDuration - dt;
          if (newStart < 0) { newDuration += newStart; newStart = 0; }
          if (newDuration < 0.1) { newDuration = 0.1; newStart = this.dragData.originalStartTime + this.dragData.originalDuration - 0.1; }

          if (this.snapEnabled) {
            const snapResult = this._snapEdge(newStart, this.dragData.clipId);
            if (snapResult.snapPoint !== null) {
              const snapped = snapResult.time;
              newDuration += (newStart - snapped);
              newStart = snapped;
              if (newDuration < 0.1) { newDuration = 0.1; newStart = this.dragData.originalStartTime + this.dragData.originalDuration - 0.1; }
              this._showSnapLine(snapResult.snapPoint);
            } else {
              this._hideSnapLine();
            }
          }

          clip.startTime = newStart;
          clip.duration = newDuration;
        } else {
          let newDuration = this.dragData.originalDuration + dt;
          if (newDuration < 0.1) newDuration = 0.1;

          if (this.snapEnabled) {
            const endTime = this.dragData.originalStartTime + newDuration;
            const snapResult = this._snapEdge(endTime, this.dragData.clipId);
            if (snapResult.snapPoint !== null) {
              newDuration = snapResult.time - this.dragData.originalStartTime;
              if (newDuration < 0.1) newDuration = 0.1;
              this._showSnapLine(snapResult.snapPoint);
            } else {
              this._hideSnapLine();
            }
          }

          clip.duration = newDuration;
        }

        const left = clip.startTime * this.pixelsPerSecond;
        const width = clip.duration * this.pixelsPerSecond;
        this.dragData.clipEl.style.left = left + "px";
        this.dragData.clipEl.style.width = width + "px";
      }
    }

    _onMouseUp() {
      if (this.isDragging && this.dragData) {
        const clip = this._findClipById(this.dragData.clipId);
        // Only fire move callback if position actually changed
        if (clip && this.onClipMove && clip.startTime !== this.dragData.originalStartTime) {
          this.onClipMove(this.dragData.clipId, clip.startTime);
        }
      }

      if (this.isResizing && this.dragData) {
        const clip = this._findClipById(this.dragData.clipId);
        if (clip && this.onClipResize) {
          this.onClipResize(this.dragData.clipId, clip.startTime, clip.duration);
        }
      }

      this.isDragging = false;
      this.isResizing = false;
      this.dragData = null;
      this._hideSnapLine();
      document.removeEventListener("mousemove", this._boundMouseMove);
      document.removeEventListener("mouseup", this._boundMouseUp);

      this._calculateDuration();
      this.render();
    }

    _snapClip(startTime, duration, excludeClipId) {
      const threshold = this.snapThreshold / this.pixelsPerSecond;
      const endTime = startTime + duration;
      const snapPoints = [0, this.currentTime]; // Snap to start and playhead

      for (const track of this.tracks) {
        for (const clip of track.clips) {
          if (clip.id === excludeClipId) continue;
          snapPoints.push(clip.startTime);
          snapPoints.push(clip.startTime + clip.duration);
        }
      }

      let bestDist = threshold;
      let bestStart = startTime;
      let bestSnapPoint = null;

      // Check clip start edge against snap points
      for (const point of snapPoints) {
        const dist = Math.abs(startTime - point);
        if (dist < bestDist) {
          bestDist = dist;
          bestStart = point;
          bestSnapPoint = point;
        }
      }

      // Check clip end edge against snap points
      for (const point of snapPoints) {
        const dist = Math.abs(endTime - point);
        if (dist < bestDist) {
          bestDist = dist;
          bestStart = point - duration;
          bestSnapPoint = point;
        }
      }

      if (bestStart < 0) bestStart = 0;
      return { time: bestStart, snapPoint: bestSnapPoint };
    }

    _snapEdge(edgeTime, excludeClipId) {
      const threshold = this.snapThreshold / this.pixelsPerSecond;
      const snapPoints = [0, this.currentTime];

      for (const track of this.tracks) {
        for (const clip of track.clips) {
          if (clip.id === excludeClipId) continue;
          snapPoints.push(clip.startTime);
          snapPoints.push(clip.startTime + clip.duration);
        }
      }

      let bestDist = threshold;
      let bestTime = edgeTime;
      let bestSnapPoint = null;

      for (const point of snapPoints) {
        const dist = Math.abs(edgeTime - point);
        if (dist < bestDist) {
          bestDist = dist;
          bestTime = point;
          bestSnapPoint = point;
        }
      }

      return { time: bestTime, snapPoint: bestSnapPoint };
    }

    _showSnapLine(snapPoint) {
      if (snapPoint === null || snapPoint === undefined) {
        this._hideSnapLine();
        return;
      }
      if (!this._snapLineEl) {
        this._snapLineEl = document.createElement("div");
        this._snapLineEl.className = "ve-snap-line";
        this.scrollContainer?.appendChild(this._snapLineEl);
      }
      const left = snapPoint * this.pixelsPerSecond;
      this._snapLineEl.style.left = left + "px";
      this._snapLineEl.style.display = "block";
    }

    _hideSnapLine() {
      if (this._snapLineEl) {
        this._snapLineEl.style.display = "none";
      }
    }

    _snapTime(time, excludeClipId) {
      const result = this._snapClip(time, 0, excludeClipId);
      return result.time;
    }

    _findClipById(clipId) {
      for (const track of this.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) return clip;
      }
      return null;
    }

    /**
     * Select a clip
     */
    selectClip(clipId) {
      this.selectedClipId = clipId;

      // Update visual selection
      if (this.tracksEl) {
        this.tracksEl.querySelectorAll(".ve-clip").forEach((el) => {
          el.classList.toggle("selected", el.dataset.clipId === clipId);
        });
      }

      if (this.onClipSelect) this.onClipSelect(clipId);
    }

    /**
     * Update playhead position
     */
    setCurrentTime(time) {
      this.currentTime = time;
      this._updatePlayheadPosition();
    }

    _updatePlayheadPosition() {
      if (!this.playheadEl) return;
      const x = this.currentTime * this.pixelsPerSecond;
      this.playheadEl.style.left = x + "px";
    }

    /**
     * Add a new track
     */
    addTrack(type, name) {
      const id = "track_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const track = {
        id,
        type: type || "video",
        name: name || ("Track " + (this.tracks.length + 1)),
        locked: false,
        visible: true,
        clips: []
      };
      this.tracks.push(track);
      this.render();
      if (this.onTrackChange) this.onTrackChange(this.tracks);
      return track;
    }

    /**
     * Add a clip to a track
     */
    addClip(trackId, clip) {
      const track = this.tracks.find((t) => t.id === trackId);
      if (!track) return null;

      if (!clip.id) {
        clip.id = "clip_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      }
      clip.type = clip.type || track.type;

      // Reject duplicate rapid drops of the same clip
      for (const t of this.tracks) {
        if (t.clips.includes(clip)) {
          return clip;
        }
      }

      track.clips.push(clip);
      this._calculateDuration();
      this.render();
      if (this.onTrackChange) this.onTrackChange(this.tracks);
      return clip;
    }

    /**
     * Remove a clip
     */
    removeClip(clipId) {
      for (const track of this.tracks) {
        const idx = track.clips.findIndex((c) => c.id === clipId);
        if (idx >= 0) {
          track.clips.splice(idx, 1);
          if (this.selectedClipId === clipId) this.selectedClipId = null;
          this._calculateDuration();
          this.render();
          if (this.onTrackChange) this.onTrackChange(this.tracks);
          return true;
        }
      }
      return false;
    }

    /**
     * Duplicate a clip
     */
    duplicateClip(clipId) {
      const clip = this._findClipById(clipId);
      if (!clip) return null;

      // Find the track
      for (const track of this.tracks) {
        if (track.clips.find((c) => c.id === clipId)) {
          const newClip = JSON.parse(JSON.stringify(clip));
          newClip.id = "clip_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
          newClip.startTime = clip.startTime + clip.duration;
          return this.addClip(track.id, newClip);
        }
      }
      return null;
    }

    /**
     * Split a clip at a given time
     */
    splitClip(clipId, splitTime) {
      const clip = this._findClipById(clipId);
      if (!clip) return null;

      const localSplit = splitTime - clip.startTime;
      if (localSplit <= 0 || localSplit >= clip.duration) return null;

      // Find the track
      for (const track of this.tracks) {
        if (track.clips.find((c) => c.id === clipId)) {
          const secondHalf = JSON.parse(JSON.stringify(clip));
          secondHalf.id = "clip_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
          secondHalf.startTime = splitTime;
          secondHalf.duration = clip.duration - localSplit;

          // Adjust trim for video/audio
          if (clip.trimStart !== undefined) {
            secondHalf.trimStart = (clip.trimStart || 0) + localSplit;
          }

          clip.duration = localSplit;

          track.clips.push(secondHalf);
          this._calculateDuration();
          this.render();
          if (this.onTrackChange) this.onTrackChange(this.tracks);
          return secondHalf;
        }
      }
      return null;
    }

    /**
     * Get ID of the track for a given track index (y-position based)
     */
    getTrackIdByIndex(index) {
      if (index >= 0 && index < this.tracks.length) {
        return this.tracks[index].id;
      }
      return null;
    }

    /**
     * Move a track up (towards front/top) or down (towards back/bottom)
     */
    moveTrack(trackId, direction) {
      const idx = this.tracks.findIndex((t) => t.id === trackId);
      if (idx < 0) return;

      if (direction === "up" && idx > 0) {
        [this.tracks[idx - 1], this.tracks[idx]] = [this.tracks[idx], this.tracks[idx - 1]];
      } else if (direction === "down" && idx < this.tracks.length - 1) {
        [this.tracks[idx + 1], this.tracks[idx]] = [this.tracks[idx], this.tracks[idx + 1]];
      } else {
        return;
      }

      this.render();
      if (this.onTrackChange) this.onTrackChange(this.tracks);
    }

    _getTrackIcon(type) {
      switch (type) {
        case "video": return "videocam";
        case "audio": return "music_note";
        case "text": return "title";
        case "image": return "image";
        default: return "layers";
      }
    }

    _formatTime(seconds) {
      const min = Math.floor(seconds / 60);
      const sec = Math.floor(seconds % 60);
      return min + ":" + String(sec).padStart(2, "0");
    }

    _escapeHtml(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }

    /**
     * Scroll to ensure the playhead is visible
     */
    scrollToPlayhead() {
      if (!this.scrollContainer) return;
      const playheadX = this.currentTime * this.pixelsPerSecond;
      const containerWidth = this.scrollContainer.clientWidth;
      const scrollLeft = this.scrollContainer.scrollLeft;

      if (playheadX < scrollLeft || playheadX > scrollLeft + containerWidth - 50) {
        this.scrollContainer.scrollLeft = Math.max(0, playheadX - containerWidth / 3);
      }
    }

    /**
     * Destroy and clean up
     */
    destroy() {
      document.removeEventListener("mousemove", this._boundMouseMove);
      document.removeEventListener("mouseup", this._boundMouseUp);
      this.tracks = [];
      this.selectedClipId = null;
    }
  }

  window.VETimeline = Timeline;
})();
