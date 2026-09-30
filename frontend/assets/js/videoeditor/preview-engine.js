/**
 * Video Editor - Preview Engine
 * Renders the canvas composite preview using fabric.js
 * Handles playback loop, frame composition, and element animation
 */
(function () {
  "use strict";

  class PreviewEngine {
    // Eligibility uses visible visual clips; background music does not disqualify an ending.
    static getEndingImage(tracks) {
      const visual = (tracks || []).filter(track => track.visible !== false)
        .flatMap(track => track.clips || []).filter(clip => clip.type !== 'audio');
      const end = clip => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0);
      const lastEnd = Math.max(0, ...visual.map(end));
      const media = visual.filter(clip => clip.type === 'image' || clip.type === 'video');
      media.sort((a, b) => end(b) - end(a) || (b.startTime || 0) - (a.startTime || 0));
      const last = media[0];
      return last?.type === 'image' && Math.abs(end(last) - lastEnd) < 0.001 ? last : null;
    }

    static prepareEndingBuffer(tracks) {
      const ending = PreviewEngine.getEndingImage(tracks);
      if (!ending?.endingBuffer || ending._endingBufferApplied) return tracks;
      return tracks.map(track => ({ ...track, clips: (track.clips || []).map(clip =>
        clip.id === ending.id ? { ...clip, duration: (Number(clip.duration) || 0) + 5, _endingBufferApplied: true } : clip
      ) }));
    }

    _effectiveClipDuration(clip) {
      return (Number(clip.duration) || 0) +
        (clip.id === this._endingClipId && !clip._endingBufferApplied ? 5 : 0);
    }

    constructor() {
      this.canvas = null;
      this.isPlaying = false;
      this.currentTime = 0;
      this.duration = 0;
      this.speed = 1;
      this.volume = 1;
      this.isMuted = false;
      this.animFrameId = null;
      this.lastFrameTime = 0;
      this.projectSettings = { width: 1920, height: 1080, fps: 30, backgroundColor: "#ffffff" };
      this.tracks = [];
      this.clipObjects = new Map(); // clipId -> { fabricObj, videoEl, audioEl }
      this._imageCache = new Map(); // source URL -> HTMLImageElement (persists across rebuilds)
      this._buildGeneration = 0; // Incremented on each rebuild to invalidate stale async callbacks
      this._rebuilding = false; // Flag to suppress selection:cleared during rebuild
      this.selectedClipId = null;
      this.onTimeUpdate = null;
      this.onPlayStateChange = null;
      this.onClipSelect = null;
      this._audioContext = null;
      this._gainNode = null;
      // Blur background state
      this._blurBgCanvas = null;
      this._blurBgCtx = null;
      this._blurBgFabricObj = null;
    }

    /**
     * Initialize the preview engine with a canvas element
     */
    init(canvasElementId, containerEl) {
      const containerRect = containerEl.getBoundingClientRect();
      const { width: projW, height: projH } = this.projectSettings;
      const scale = Math.min(
        (containerRect.width - 40) / projW,
        (containerRect.height - 40) / projH,
        1
      );
      const displayW = Math.floor(projW * scale);
      const displayH = Math.floor(projH * scale);

      this.canvas = new fabric.Canvas(canvasElementId, {
        width: displayW,
        height: displayH,
        backgroundColor: this.projectSettings.backgroundColor,
        selection: true,
        preserveObjectStacking: true
      });

      this.scaleRatio = scale;
      this._setupCanvasEvents();
      this._initAudioContext();
      this.renderFrame(0);
    }

    _initAudioContext() {
      try {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this._gainNode = this._audioContext.createGain();
        this._gainNode.connect(this._audioContext.destination);
        this._gainNode.gain.value = this.volume;
      } catch (e) {
        console.warn("[PreviewEngine] AudioContext not available:", e);
      }
    }

    _setupCanvasEvents() {
      if (!this.canvas) return;

      this.canvas.on("selection:created", (e) => {
        const obj = e.selected?.[0];
        if (obj && obj._veClipId) {
          this.selectedClipId = obj._veClipId;
          if (this.onClipSelect) this.onClipSelect(obj._veClipId);
        }
      });

      this.canvas.on("selection:updated", (e) => {
        const obj = e.selected?.[0];
        if (obj && obj._veClipId) {
          this.selectedClipId = obj._veClipId;
          if (this.onClipSelect) this.onClipSelect(obj._veClipId);
        }
      });

      this.canvas.on("selection:cleared", () => {
        if (this._rebuilding) return; // Ignore clear events during track rebuild
        this.selectedClipId = null;
        if (this.onClipSelect) this.onClipSelect(null);
      });

      this.canvas.on("object:modified", (e) => {
        const obj = e.target;
        if (obj && obj._veClipId) {
          this._syncObjectToClipData(obj);
        }
      });
    }

    _syncObjectToClipData(obj) {
      const clip = this._findClipById(obj._veClipId);
      if (!clip) return;

      const s = this.scaleRatio;
      clip.position = { x: obj.left / s, y: obj.top / s };
      clip.size = {
        width: (obj.width * obj.scaleX) / s,
        height: (obj.height * obj.scaleY) / s
      };
      if (obj.angle !== undefined) clip.rotation = obj.angle;
    }

    _findClipById(clipId) {
      for (const track of this.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) return clip;
      }
      return null;
    }

    /**
     * Update project settings and resize canvas
     */
    updateSettings(settings, containerEl) {
      const prevBgType = this.projectSettings.backgroundType;
      Object.assign(this.projectSettings, settings);
      if (this.canvas && containerEl) {
        const containerRect = containerEl.getBoundingClientRect();
        const { width: projW, height: projH } = this.projectSettings;
        const scale = Math.min(
          (containerRect.width - 40) / projW,
          (containerRect.height - 40) / projH,
          1
        );
        this.scaleRatio = scale;
        this.canvas.setWidth(Math.floor(projW * scale));
        this.canvas.setHeight(Math.floor(projH * scale));
        if (this.projectSettings.backgroundType === "blur") {
          this.canvas.setBackgroundColor("#000000");
        } else {
          this.canvas.setBackgroundColor(this.projectSettings.backgroundColor);
        }
        // Rebuild if background type changed (need to add/remove blur object)
        if (prevBgType !== this.projectSettings.backgroundType) {
          this._buildClipObjects();
        }
        this.renderFrame(this.currentTime);
      }
    }

    /**
     * Load tracks data into the engine
     */
    loadTracks(tracks) {
      this.tracks = tracks;
      this._calculateDuration();
      this._buildClipObjects();
      this.renderFrame(this.currentTime);
    }

    /**
     * Convert a file path to a URL that fabric.js can load
     */
    _toFileURL(source) {
      if (!source) return source;
      // Already a URL
      if (/^(https?|data|blob|file):/.test(source)) return source;
      // Convert Windows/Unix path to file:// URL
      const normalized = source.replace(/\\/g, "/");
      return "file:///" + normalized.replace(/^\/+/, "");
    }

    _calculateDuration() {
      const ending = PreviewEngine.getEndingImage(this.tracks);
      this._endingClipId = ending?.endingBuffer ? ending.id : null;
      let maxEnd = 0;
      for (const track of this.tracks) {
        for (const clip of track.clips) {
          const end = clip.startTime + this._effectiveClipDuration(clip);
          if (end > maxEnd) maxEnd = end;
        }
      }
      this.duration = maxEnd || 5;
    }

    /**
     * Build fabric objects for all clips
     */
    _buildClipObjects() {
      this._buildGeneration++;
      // Suppress selection:cleared during rebuild to avoid hiding properties panel
      this._rebuilding = true;
      // Clear old objects
      if (this.canvas) this.canvas.clear();
      this._blurBgFabricObj = null;

      if (this.projectSettings.backgroundType === "blur") {
        this.canvas?.setBackgroundColor("#000000");
        // Create off-screen canvas for blur rendering
        const projW = this.projectSettings.width;
        const projH = this.projectSettings.height;
        if (!this._blurBgCanvas || this._blurBgCanvas.width !== projW || this._blurBgCanvas.height !== projH) {
          this._blurBgCanvas = document.createElement("canvas");
          this._blurBgCanvas.width = projW;
          this._blurBgCanvas.height = projH;
          this._blurBgCtx = this._blurBgCanvas.getContext("2d");
        }
        // Create fabric.Image placeholder for blur background at index 0
        const s = this.scaleRatio;
        const blurImg = new fabric.Image(this._blurBgCanvas, {
          left: 0,
          top: 0,
          scaleX: s,
          scaleY: s,
          selectable: false,
          evented: false,
          excludeFromExport: false,
        });
        blurImg._veIsBlurBg = true;
        blurImg.objectCaching = false;
        this._blurBgFabricObj = blurImg;
        if (this.canvas) this.canvas.add(blurImg);
      } else {
        this.canvas?.setBackgroundColor(this.projectSettings.backgroundColor);
      }

      for (const [clipId, meta] of this.clipObjects) {
        if (meta.videoEl) {
          meta.videoEl.pause();
          meta.videoEl.src = "";
          meta.videoEl.remove();
        }
        if (meta.audioEl) {
          meta.audioEl.pause();
          meta.audioEl.src = "";
          meta.audioEl.remove();
        }
      }
      this.clipObjects.clear();

      // Build new objects, bottom tracks first
      const sortedTracks = [...this.tracks].reverse();
      for (const track of sortedTracks) {
        if (!track.visible) continue;
        for (const clip of track.clips) {
          this._createClipObject(clip, track);
        }
      }
      this._rebuilding = false;
    }

    _createClipObject(clip, track) {
      const s = this.scaleRatio;
      const meta = { fabricObj: null, videoEl: null, audioEl: null };

      // Handle placeholder clips — render as a distinct colored rectangle with label
      if (clip.isPlaceholder) {
        // Audio placeholders have no visual representation on canvas
        if (clip.type === 'audio') {
          this.clipObjects.set(clip.id, meta);
          return;
        }

        const phW = (clip.size?.width || 200) * s;
        const phH = (clip.size?.height || 200) * s;
        const phX = (clip.position?.x || 0) * s;
        const phY = (clip.position?.y || 0) * s;
        const num = clip.placeholderId?.replace('placeholder_', '') || '?';
        const typeLabel = clip.type === 'video' ? 'Video' : 'Image';
        const label = typeLabel + ' — Placeholder ' + num;

        const phRect = new fabric.Rect({
          left: phX,
          top: phY,
          width: phW,
          height: phH,
          fill: 'rgba(99, 102, 241, 0.15)',
          stroke: '#6366f1',
          strokeWidth: 2 * s,
          strokeDashArray: [8 * s, 4 * s],
          selectable: !track.locked,
          rx: 4 * s,
          ry: 4 * s
        });
        phRect._veClipId = clip.id;
        phRect._veClipType = clip.type;

        const phText = new fabric.Text(label, {
          left: phX + phW / 2,
          top: phY + phH / 2,
          fontSize: Math.max(12, Math.min(20, phW / 15)) * s,
          fontFamily: 'Arial',
          fill: '#6366f1',
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false
        });

        const phGroup = new fabric.Group([phRect, phText], {
          left: phX,
          top: phY,
          selectable: !track.locked
        });
        phGroup._veClipId = clip.id;
        phGroup._veClipType = clip.type;
        meta.fabricObj = phGroup;

        this.clipObjects.set(clip.id, meta);
        if (this.canvas) this.canvas.add(phGroup);
        return;
      }

      switch (clip.type) {
        case "video":
          meta.videoEl = document.createElement("video");
          meta.videoEl.src = this._toFileURL(clip.source);
          meta.videoEl.muted = true; // Audio handled separately
          meta.videoEl.preload = "auto";
          meta.videoEl.style.display = "none";
          document.body.appendChild(meta.videoEl);

          // Create placeholder until video loads
          const vRect = new fabric.Rect({
            left: (clip.position?.x || 0) * s,
            top: (clip.position?.y || 0) * s,
            width: (clip.size?.width || this.projectSettings.width) * s,
            height: (clip.size?.height || this.projectSettings.height) * s,
            fill: "#333",
            selectable: !track.locked
          });
          vRect._veClipId = clip.id;
          vRect._veClipType = "video";
          meta.fabricObj = vRect;

          // Load video and create image pattern
          meta.videoEl.addEventListener("loadeddata", () => {
            this.renderFrame(this.currentTime);
          });

          // Handle audio track from video
          if (!clip.muted && clip.volume !== 0) {
            meta.audioEl = document.createElement("audio");
            meta.audioEl.src = this._toFileURL(clip.source);
            meta.audioEl.volume = (clip.volume ?? 1) * this.volume;
            meta.audioEl.preload = "auto";
            document.body.appendChild(meta.audioEl);
          }
          break;

        case "image":
          if (clip.source) {
            const imgUrl = this._toFileURL(clip.source);
            const cachedImg = this._imageCache.get(imgUrl);

            if (cachedImg) {
              // Image already loaded — create fabric.Image immediately
              const fImg = new fabric.Image(cachedImg, {
                left: (clip.position?.x || 0) * s,
                top: (clip.position?.y || 0) * s,
                scaleX: ((clip.size?.width || this.projectSettings.width) * s) / (cachedImg.naturalWidth || 1),
                scaleY: ((clip.size?.height || this.projectSettings.height) * s) / (cachedImg.naturalHeight || 1),
                selectable: !track.locked,
                opacity: clip.opacity ?? 1
              });
              fImg._veClipId = clip.id;
              fImg._veClipType = "image";
              meta.fabricObj = fImg;
            } else {
              // Show grey placeholder while loading
              const imgRect = new fabric.Rect({
                left: (clip.position?.x || 0) * s,
                top: (clip.position?.y || 0) * s,
                width: (clip.size?.width || 200) * s,
                height: (clip.size?.height || 200) * s,
                fill: "#666",
                selectable: !track.locked
              });
              imgRect._veClipId = clip.id;
              imgRect._veClipType = "image";
              meta.fabricObj = imgRect;

              // Load image asynchronously and cache it
              const buildGen = this._buildGeneration;
              const htmlImg = new Image();
              htmlImg.onload = () => {
                // Cache for future rebuilds
                this._imageCache.set(imgUrl, htmlImg);
                // If canvas was rebuilt since this load started, do a fresh rebuild
                // so the cached image gets picked up immediately
                if (buildGen !== this._buildGeneration) {
                  this._buildClipObjects();
                  this.renderFrame(this.currentTime);
                  return;
                }

                const fImg = new fabric.Image(htmlImg, {
                  left: (clip.position?.x || 0) * s,
                  top: (clip.position?.y || 0) * s,
                  scaleX: ((clip.size?.width || this.projectSettings.width) * s) / (htmlImg.naturalWidth || 1),
                  scaleY: ((clip.size?.height || this.projectSettings.height) * s) / (htmlImg.naturalHeight || 1),
                  selectable: !track.locked,
                  opacity: clip.opacity ?? 1
                });
                fImg._veClipId = clip.id;
                fImg._veClipType = "image";
                fImg.objectCaching = false;
                meta.fabricObj = fImg;

                // Replace rect placeholder with loaded image
                const idx = this.canvas?.getObjects().indexOf(imgRect);
                if (idx !== undefined && idx >= 0) {
                  this.canvas.remove(imgRect);
                  this.canvas.insertAt(fImg, idx);
                } else {
                  this.canvas?.add(fImg);
                }
                this.renderFrame(this.currentTime);
              };
              htmlImg.onerror = (err) => {
                console.error("[PreviewEngine] Failed to load image:", imgUrl, err);
              };
              htmlImg.src = imgUrl;
            }
          } else {
            // No source — just a grey rect
            const imgRect = new fabric.Rect({
              left: (clip.position?.x || 0) * s,
              top: (clip.position?.y || 0) * s,
              width: (clip.size?.width || 200) * s,
              height: (clip.size?.height || 200) * s,
              fill: "#666",
              selectable: !track.locked
            });
            imgRect._veClipId = clip.id;
            imgRect._veClipType = "image";
            meta.fabricObj = imgRect;
          }
          break;

        case "text":
          const textObj = new fabric.IText(clip.text || "Text", {
            left: (clip.position?.x || 50) * s,
            top: (clip.position?.y || 50) * s,
            fontSize: (clip.fontSize || 48) * s,
            fontFamily: clip.fontFamily || "Arial",
            fill: clip.fontColor || "#ffffff",
            fontWeight: clip.fontWeight || "normal",
            fontStyle: clip.fontStyle || "normal",
            textAlign: clip.textAlign || "center",
            opacity: clip.opacity ?? 1,
            selectable: !track.locked,
            backgroundColor: clip.backgroundColor || ""
          });
          textObj._veClipId = clip.id;
          textObj._veClipType = "text";
          meta.fabricObj = textObj;
          break;

        case "audio":
          // Audio clips don't have visual representation on canvas
          meta.audioEl = document.createElement("audio");
          meta.audioEl.src = this._toFileURL(clip.source);
          meta.audioEl.volume = (clip.volume ?? 1) * this.volume;
          meta.audioEl.preload = "auto";
          document.body.appendChild(meta.audioEl);
          break;

        case "subtitle":
          // Subtitle clips are rendered via canvas 2D overlay after fabric.renderAll()
          // No fabric object needed — we store metadata only
          meta._isSubtitle = true;
          break;
      }

      if (meta.fabricObj && this.canvas) {
        meta.fabricObj.objectCaching = false;
        this.canvas.add(meta.fabricObj);
      }

      this.clipObjects.set(clip.id, meta);
    }

    /**
     * Render a single frame at the given time (in seconds)
     */
    renderFrame(timeSec) {
      this.currentTime = timeSec;
      if (!this.canvas) return;

      const s = this.scaleRatio;

      // Update blur background if active
      if (this.projectSettings.backgroundType === "blur" && this._blurBgFabricObj) {
        this._updateBlurBackground(timeSec);
      }

      for (const track of this.tracks) {
        if (!track.visible) continue;
        for (const clip of track.clips) {
          const meta = this.clipObjects.get(clip.id);
          if (!meta) continue;

          const clipStart = clip.startTime;
          const clipEnd = clip.startTime + this._effectiveClipDuration(clip);
          const isActive = timeSec >= clipStart && timeSec < clipEnd;
          const localTime = timeSec - clipStart;

          if (meta.fabricObj) {
            meta.fabricObj.visible = isActive;

            if (isActive) {
              // Reset to base properties before animation
              meta.fabricObj.left = (clip.position?.x || 0) * s;
              meta.fabricObj.top = (clip.position?.y || 0) * s;
              meta.fabricObj.opacity = clip.opacity ?? 1;
              // Reset scale for all visual clip types
              if (clip.type !== "audio") {
                if (clip.type === "text") {
                  meta.fabricObj.scaleX = 1;
                  meta.fabricObj.scaleY = 1;
                } else if (meta.fabricObj.width) {
                  meta.fabricObj.scaleX = ((clip.size?.width || this.projectSettings.width) * s) / meta.fabricObj.width;
                  meta.fabricObj.scaleY = ((clip.size?.height || this.projectSettings.height) * s) / meta.fabricObj.height;
                }
              }

              // Update video frame (must happen before animation so animation applies to new fabric obj)
              if (clip.type === "video" && meta.videoEl && meta.videoEl.readyState >= 2) {
                // During export, renderFrameForExport already seeked the element
                // and awaited the decoded frame — issuing another (un-awaited)
                // seek here would draw a stale/partial frame. Only seek in live
                // preview mode.
                if (!this._exporting) {
                  const seekTime = (clip.trimStart || 0) + localTime;
                  if (Math.abs(meta.videoEl.currentTime - seekTime) > 0.1) {
                    meta.videoEl.currentTime = seekTime;
                  }
                }
                this._drawVideoFrame(meta, clip);
              }

              // Apply animations
              this._applyAnimation(meta.fabricObj, clip, localTime, this._effectiveClipDuration(clip));

              // Apply filters
              if (clip.filter && meta.fabricObj.filters !== undefined) {
                this._applyFilter(meta.fabricObj, clip.filter);
              }

              // Invalidate fabric.js cache and update bounding box after transforms
              meta.fabricObj.dirty = true;
              meta.fabricObj.setCoords();
            }
          }

          // Handle audio
          if (meta.audioEl) {
            const audioSeekTime = (clip.trimStart || 0) + localTime;
            if (isActive && this.isPlaying) {
              meta.audioEl.volume = this.isMuted ? 0 : (clip.volume ?? 1) * this.volume;
              // Sync position if drifted more than 0.3s
              if (Math.abs(meta.audioEl.currentTime - audioSeekTime) > 0.3) {
                meta.audioEl.currentTime = audioSeekTime;
              }
              if (meta.audioEl.paused) {
                meta.audioEl.play().catch(() => {});
              }
            } else {
              if (!meta.audioEl.paused) meta.audioEl.pause();
              // Pre-seek so audio is ready at the right position when playback starts
              if (isActive && Math.abs(meta.audioEl.currentTime - audioSeekTime) > 0.1) {
                meta.audioEl.currentTime = audioSeekTime;
              }
            }
          }
        }
      }


      this.canvas.renderAll();

      // Render subtitle overlays on top of fabric canvas
      this._renderSubtitles(timeSec);

      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.currentTime, this.duration);
      }
    }

    /**
     * Update the blur background with the current frame's primary visual content
     */
    _updateBlurBackground(timeSec) {
      if (!this._blurBgCanvas || !this._blurBgCtx || !this._blurBgFabricObj) return;

      const projW = this.projectSettings.width;
      const projH = this.projectSettings.height;
      const ctx = this._blurBgCtx;
      const intensity = this.projectSettings.blurIntensity || 30;
      let sourceDrawn = false;

      // Clear previous frame
      ctx.clearRect(0, 0, projW, projH);

      // Find the first active video or image clip (bottom track = primary content)
      const sortedTracks = [...this.tracks].reverse();
      for (const track of sortedTracks) {
        if (!track.visible || sourceDrawn) break;
        for (const clip of track.clips) {
          if (clip.type !== "video" && clip.type !== "image") continue;
          const clipStart = clip.startTime;
          const clipEnd = clip.startTime + this._effectiveClipDuration(clip);
          if (timeSec < clipStart || timeSec >= clipEnd) continue;

          const meta = this.clipObjects.get(clip.id);
          if (!meta) continue;

          let sourceEl = null;
          let srcW = 0, srcH = 0;

          if (clip.type === "video" && meta.videoEl && meta.videoEl.readyState >= 2) {
            sourceEl = meta.videoEl;
            srcW = meta.videoEl.videoWidth || 640;
            srcH = meta.videoEl.videoHeight || 360;
          } else if (clip.type === "image" && meta.fabricObj && meta.fabricObj.type === "image") {
            sourceEl = meta.fabricObj.getElement();
            srcW = sourceEl.naturalWidth || sourceEl.width || 200;
            srcH = sourceEl.naturalHeight || sourceEl.height || 200;
          }

          if (!sourceEl || srcW === 0 || srcH === 0) continue;

          // Draw source scaled-to-cover the canvas (fills entire area, may crop)
          const scaleX = projW / srcW;
          const scaleY = projH / srcH;
          const coverScale = Math.max(scaleX, scaleY);
          const drawW = srcW * coverScale;
          const drawH = srcH * coverScale;
          const drawX = (projW - drawW) / 2;
          const drawY = (projH - drawH) / 2;

          ctx.filter = "blur(" + intensity + "px)";
          ctx.drawImage(sourceEl, drawX, drawY, drawW, drawH);
          ctx.filter = "none";

          // Darkening overlay for visual separation
          ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
          ctx.fillRect(0, 0, projW, projH);

          sourceDrawn = true;
          break;
        }
      }

      if (!sourceDrawn) {
        // No active visual clip — fill with solid fallback
        ctx.fillStyle = this.projectSettings.backgroundColor || "#000000";
        ctx.fillRect(0, 0, projW, projH);
      }

      // Update the fabric object with the new blur canvas content
      const s = this.scaleRatio;
      const newBlurImg = new fabric.Image(this._blurBgCanvas, {
        left: 0,
        top: 0,
        scaleX: s,
        scaleY: s,
        selectable: false,
        evented: false,
      });
      newBlurImg._veIsBlurBg = true;
      newBlurImg.objectCaching = false;

      const idx = this.canvas.getObjects().indexOf(this._blurBgFabricObj);
      if (idx >= 0) {
        this.canvas.remove(this._blurBgFabricObj);
        this.canvas.insertAt(newBlurImg, idx);
      } else {
        // Insert at index 0 (behind everything)
        this.canvas.insertAt(newBlurImg, 0);
      }
      this._blurBgFabricObj = newBlurImg;
    }

    _drawVideoFrame(meta, clip) {
      if (!meta.fabricObj) return;
      const s = this.scaleRatio;

      // During export, prefer the pre-extracted CFR JPEG frame (even, judder-free)
      // over the live <video> element.
      const frameImg =
        meta._exportFrameReady && meta._exportFrameReady.complete
          ? meta._exportFrameReady
          : null;
      const sourceEl = frameImg || meta.videoEl;
      if (!sourceEl) return;

      try {
        const srcW =
          (frameImg ? frameImg.naturalWidth : meta.videoEl.videoWidth) || 640;
        const srcH =
          (frameImg ? frameImg.naturalHeight : meta.videoEl.videoHeight) || 360;
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = srcW;
        tmpCanvas.height = srcH;
        const ctx = tmpCanvas.getContext("2d");
        ctx.drawImage(sourceEl, 0, 0);

        const fabricImg = new fabric.Image(tmpCanvas, {
          left: meta.fabricObj.left,
          top: meta.fabricObj.top,
          scaleX: ((clip.size?.width || this.projectSettings.width) * s) / tmpCanvas.width,
          scaleY: ((clip.size?.height || this.projectSettings.height) * s) / tmpCanvas.height,
          selectable: meta.fabricObj.selectable,
          opacity: clip.opacity ?? 1
        });
        fabricImg._veClipId = clip.id;
        fabricImg._veClipType = "video";
        fabricImg.objectCaching = false;

        const idx = this.canvas.getObjects().indexOf(meta.fabricObj);
        if (idx >= 0) {
          this.canvas.remove(meta.fabricObj);
          this.canvas.insertAt(fabricImg, idx);
          meta.fabricObj = fabricImg;
        }
      } catch (e) {
        // Ignore cross-origin or timing errors
      }
    }

    /**
     * Apply animation to a fabric object
     */
    _applyAnimation(obj, clip, localTime, duration) {
      if (clip.id === this._endingClipId && clip.type === 'image') {
        // Keep motion throughout the still and buffer, independent of in/out transitions.
        const zoom = 1 + 0.03 * Math.max(0, Math.min(1, localTime / Math.max(duration, 0.001)));
        const width = (obj.width || 0) * (obj.scaleX || 1);
        const height = (obj.height || 0) * (obj.scaleY || 1);
        obj.scaleX *= zoom;
        obj.scaleY *= zoom;
        obj.left -= width * (zoom - 1) / 2;
        obj.top -= height * (zoom - 1) / 2;
      }
      const hasIn = clip.animation && clip.animation !== "none";
      const hasOut = clip.animationOut && clip.animationOut !== "none";
      if (!hasIn && !hasOut) return;

      const inDuration = clip.animDurationIn || 0.5;
      const outDuration = clip.animDurationOut || 0.5;

      // Store base values set during reset — used for center-based transforms
      const baseLeft = obj.left;
      const baseTop = obj.top;
      const baseScaleX = obj.scaleX || 1;
      const baseScaleY = obj.scaleY || 1;
      const baseOpacity = obj.opacity ?? 1;
      const objW = (obj.width || 0) * baseScaleX;
      const objH = (obj.height || 0) * baseScaleY;

      // Slide distances proportional to object size (with minimum)
      const slideDistX = Math.max(objW * 0.5, 100);
      const slideDistY = Math.max(objH * 0.4, 80);

      // --- Entrance animation ---
      if (hasIn && localTime < inDuration) {
        const t = Math.min(localTime / inDuration, 1);

        switch (clip.animation) {
          case "fadeIn": {
            obj.opacity = baseOpacity * this._easeOutCubic(t);
            break;
          }
          case "slideLeft": {
            const e = this._easeOutBack(t);
            obj.left = baseLeft - slideDistX * (1 - e);
            obj.opacity = baseOpacity * this._easeOutCubic(t);
            break;
          }
          case "slideRight": {
            const e = this._easeOutBack(t);
            obj.left = baseLeft + slideDistX * (1 - e);
            obj.opacity = baseOpacity * this._easeOutCubic(t);
            break;
          }
          case "slideUp": {
            const e = this._easeOutBack(t);
            obj.top = baseTop + slideDistY * (1 - e);
            obj.opacity = baseOpacity * this._easeOutCubic(t);
            break;
          }
          case "slideDown": {
            const e = this._easeOutBack(t);
            obj.top = baseTop - slideDistY * (1 - e);
            obj.opacity = baseOpacity * this._easeOutCubic(t);
            break;
          }
          case "scaleIn": {
            const e = this._easeOutBack(t);
            const scaleFactor = 0.3 + 0.7 * e;
            obj.scaleX = baseScaleX * scaleFactor;
            obj.scaleY = baseScaleY * scaleFactor;
            // Offset position to keep visual center stable
            obj.left = baseLeft + objW * (1 - scaleFactor) / 2;
            obj.top = baseTop + objH * (1 - scaleFactor) / 2;
            obj.opacity = baseOpacity * this._easeOutCubic(t);
            break;
          }
          case "typewriter": {
            if (clip.type === "text" && obj.text !== undefined) {
              const fullText = clip.text || "";
              const chars = Math.floor(t * fullText.length);
              obj.text = fullText.substring(0, Math.min(chars, fullText.length));
            }
            break;
          }
          case "bounce": {
            const e = this._easeOutBounce(t);
            obj.top = baseTop + slideDistY * 0.6 * (1 - e);
            obj.opacity = baseOpacity * Math.min(t * 4, 1);
            break;
          }
        }
      }

      // --- Exit animation ---
      if (hasOut && localTime > duration - outDuration) {
        const t = Math.min((localTime - (duration - outDuration)) / outDuration, 1);
        const currentOpacity = obj.opacity ?? baseOpacity;

        switch (clip.animationOut) {
          case "fadeOut": {
            obj.opacity = currentOpacity * (1 - this._easeInCubic(t));
            break;
          }
          case "slideLeft": {
            const e = this._easeInCubic(t);
            obj.left = baseLeft - slideDistX * e;
            obj.opacity = currentOpacity * (1 - e);
            break;
          }
          case "slideRight": {
            const e = this._easeInCubic(t);
            obj.left = baseLeft + slideDistX * e;
            obj.opacity = currentOpacity * (1 - e);
            break;
          }
          case "slideUp": {
            const e = this._easeInCubic(t);
            obj.top = baseTop - slideDistY * e;
            obj.opacity = currentOpacity * (1 - e);
            break;
          }
          case "slideDown": {
            const e = this._easeInCubic(t);
            obj.top = baseTop + slideDistY * e;
            obj.opacity = currentOpacity * (1 - e);
            break;
          }
          case "scaleOut": {
            const e = this._easeInCubic(t);
            const scaleFactor = 1 - 0.7 * e;
            obj.scaleX = baseScaleX * scaleFactor;
            obj.scaleY = baseScaleY * scaleFactor;
            // Offset position to keep visual center stable
            obj.left = baseLeft + objW * (1 - scaleFactor) / 2;
            obj.top = baseTop + objH * (1 - scaleFactor) / 2;
            obj.opacity = currentOpacity * (1 - e);
            break;
          }
        }
      }
    }

    /**
     * Apply filter to a fabric object
     */
    _applyFilter(obj, filterName) {
      if (!filterName || filterName === "none") {
        obj.filters = [];
        return;
      }

      const filters = [];
      switch (filterName) {
        case "grayscale":
          filters.push(new fabric.Image.filters.Grayscale());
          break;
        case "sepia":
          filters.push(new fabric.Image.filters.Sepia());
          break;
        case "blur":
          filters.push(new fabric.Image.filters.Blur({ blur: 0.1 }));
          break;
        case "brightness":
          filters.push(new fabric.Image.filters.Brightness({ brightness: 0.15 }));
          break;
        case "contrast":
          filters.push(new fabric.Image.filters.Contrast({ contrast: 0.2 }));
          break;
        case "saturation":
          filters.push(new fabric.Image.filters.Saturation({ saturation: 0.5 }));
          break;
        case "vintage":
          filters.push(new fabric.Image.filters.Sepia());
          filters.push(new fabric.Image.filters.Brightness({ brightness: -0.05 }));
          filters.push(new fabric.Image.filters.Contrast({ contrast: 0.1 }));
          break;
        case "warm":
          filters.push(new fabric.Image.filters.Brightness({ brightness: 0.05 }));
          filters.push(new fabric.Image.filters.Saturation({ saturation: 0.3 }));
          break;
        case "cool":
          filters.push(new fabric.Image.filters.Brightness({ brightness: -0.03 }));
          filters.push(new fabric.Image.filters.Saturation({ saturation: -0.2 }));
          break;
      }

      if (obj.filters !== undefined) {
        obj.filters = filters;
        if (obj.applyFilters) obj.applyFilters();
      }
    }

    /**
     * Render all active subtitle clips on the canvas 2D context.
     * Called after fabric.renderAll() so subtitles draw on top.
     */
    _renderSubtitles(timeSec) {
      if (!this.canvas) return;
      const ctx = this.canvas.getContext("2d");
      if (!ctx) return;

      const ST = typeof SubtitleTemplates !== "undefined" ? SubtitleTemplates : null;
      if (!ST) return;

      const cw = this.canvas.width;
      const ch = this.canvas.height;

      for (const track of this.tracks) {
        if (!track.visible) continue;
        for (const clip of track.clips) {
          if (clip.type !== "subtitle") continue;
          const clipEnd = clip.startTime + this._effectiveClipDuration(clip);
          if (timeSec >= clip.startTime && timeSec < clipEnd) {
            ST.renderSubtitleFrame(ctx, clip, timeSec, this.scaleRatio, cw, ch);
          }
        }
      }
    }

    // Easing functions
    _easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    _easeInCubic(t) { return t * t * t; }
    _easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    _easeOutBack(t) {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    _easeOutBounce(t) {
      const n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }

    /**
     * Start playback
     */
    play() {
      if (this.isPlaying) return;
      this.isPlaying = true;
      this.lastFrameTime = performance.now();

      if (this.currentTime >= this.duration) {
        this.currentTime = 0;
      }

      if (this._audioContext?.state === "suspended") {
        this._audioContext.resume();
      }

      this._playLoop();
      if (this.onPlayStateChange) this.onPlayStateChange(true);
    }

    _playLoop() {
      if (!this.isPlaying) return;

      const now = performance.now();
      const delta = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;

      this.currentTime += delta * this.speed;

      if (this.currentTime >= this.duration) {
        this.currentTime = this.duration;
        this.pause();
        this.renderFrame(this.currentTime);
        return;
      }

      this.renderFrame(this.currentTime);
      this.animFrameId = requestAnimationFrame(() => this._playLoop());
    }

    /**
     * Pause playback
     */
    pause() {
      this.isPlaying = false;
      if (this.animFrameId) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }

      // Pause all audio
      for (const [, meta] of this.clipObjects) {
        if (meta.audioEl && !meta.audioEl.paused) {
          meta.audioEl.pause();
        }
      }

      if (this.onPlayStateChange) this.onPlayStateChange(false);
    }

    /**
     * Toggle play/pause
     */
    togglePlay() {
      if (this.isPlaying) this.pause();
      else this.play();
    }

    /**
     * Seek to a specific time
     */
    seek(timeSec) {
      this.currentTime = Math.max(0, Math.min(timeSec, this.duration));
      this.renderFrame(this.currentTime);
    }

    /**
     * Set playback speed
     */
    setSpeed(speed) {
      this.speed = speed;
    }

    /**
     * Set volume (0-1)
     */
    setVolume(vol) {
      this.volume = Math.max(0, Math.min(1, vol));
      if (this._gainNode) {
        this._gainNode.gain.value = this.isMuted ? 0 : this.volume;
      }
      // Update all audio elements
      for (const [, meta] of this.clipObjects) {
        if (meta.audioEl) {
          meta.audioEl.volume = this.isMuted ? 0 : this.volume;
        }
      }
    }

    /**
     * Toggle mute
     */
    toggleMute() {
      this.isMuted = !this.isMuted;
      this.setVolume(this.volume);
      return this.isMuted;
    }

    /**
     * Select a clip on the canvas
     */
    selectClip(clipId) {
      if (!this.canvas) return;
      if (!clipId) {
        this.canvas.discardActiveObject();
        this.canvas.renderAll();
        this.selectedClipId = null;
        return;
      }

      const meta = this.clipObjects.get(clipId);
      if (meta?.fabricObj) {
        this.canvas.setActiveObject(meta.fabricObj);
        this.canvas.renderAll();
        this.selectedClipId = clipId;
      }
    }

    /**
     * Add a clip object to the preview
     */
    addClip(clip, track) {
      this._createClipObject(clip, track);
      this._calculateDuration();
      this.renderFrame(this.currentTime);
    }

    /**
     * Remove a clip object from the preview
     */
    removeClip(clipId) {
      const meta = this.clipObjects.get(clipId);
      if (!meta) return;

      if (meta.fabricObj && this.canvas) {
        this.canvas.remove(meta.fabricObj);
      }
      if (meta.videoEl) {
        meta.videoEl.pause();
        meta.videoEl.src = "";
        meta.videoEl.remove();
      }
      if (meta.audioEl) {
        meta.audioEl.pause();
        meta.audioEl.src = "";
        meta.audioEl.remove();
      }
      this.clipObjects.delete(clipId);
      this._calculateDuration();
    }

    /**
     * Update clip properties and re-render
     */
    updateClip(clipId, updates) {
      const clip = this._findClipById(clipId);
      if (!clip) return;
      Object.assign(clip, updates);
      this._buildClipObjects();
      this._calculateDuration();
      this.renderFrame(this.currentTime);
    }

    /**
     * Get the canvas data URL for thumbnail
     */
    getThumbnail() {
      if (!this.canvas) return null;
      return this.canvas.toDataURL({ format: "png", quality: 0.7 });
    }

    /**
     * Destroy the engine and clean up
     */
    destroy() {
      this.pause();

      for (const [, meta] of this.clipObjects) {
        if (meta.videoEl) {
          meta.videoEl.pause();
          meta.videoEl.src = "";
          meta.videoEl.remove();
        }
        if (meta.audioEl) {
          meta.audioEl.pause();
          meta.audioEl.src = "";
          meta.audioEl.remove();
        }
      }
      this.clipObjects.clear();

      if (this._audioContext) {
        this._audioContext.close().catch(() => {});
        this._audioContext = null;
      }

      if (this.canvas) {
        this.canvas.dispose();
        this.canvas = null;
      }
    }

    // ============================================
    // EXPORT MODE METHODS
    // ============================================

    /**
     * Initialize for export mode — renders at full resolution without UI interaction
     * @param {number} width - Export width in pixels
     * @param {number} height - Export height in pixels
     * @param {string} backgroundColor - Background color
     */
    initForExport(width, height, backgroundColor, backgroundType, blurIntensity) {
      const canvasEl = document.createElement("canvas");
      canvasEl.width = width;
      canvasEl.height = height;
      document.body.appendChild(canvasEl);

      this._exportMode = true;
      this._exportCanvasEl = canvasEl;
      const bgType = backgroundType || "color";
      const effectiveBgColor = bgType === "blur" ? "#000000" : (backgroundColor || "#000000");
      this.projectSettings = {
        width,
        height,
        fps: 30,
        backgroundColor: backgroundColor || "#000000",
        backgroundType: bgType,
        blurIntensity: blurIntensity || 30,
      };
      this.scaleRatio = 1; // Full resolution — no scaling

      this.canvas = new fabric.Canvas(canvasEl, {
        width,
        height,
        backgroundColor: effectiveBgColor,
        selection: false,
        preserveObjectStacking: true,
        renderOnAddRemove: false,
      });

      // Hide the fabric wrapper off-screen
      const wrapper = this.canvas.wrapperEl;
      if (wrapper) {
        wrapper.style.position = "fixed";
        wrapper.style.left = "-99999px";
        wrapper.style.top = "-99999px";
        wrapper.style.pointerEvents = "none";
      }
    }

    /**
     * Wait for all image assets to finish loading
     * @param {number} timeout - Max wait time in ms
     * @returns {Promise<void>}
     */
    waitForAssets(timeout = 30000) {
      return new Promise((resolve) => {
        const startTime = Date.now();
        const check = () => {
          let allLoaded = true;
          for (const [, meta] of this.clipObjects) {
            // Image clip still showing placeholder rect means it hasn't loaded yet
            if (
              meta.fabricObj &&
              meta.fabricObj._veClipType === "image" &&
              meta.fabricObj.type === "rect" &&
              !meta.fabricObj._veIsPlaceholder
            ) {
              allLoaded = false;
              break;
            }
            // Video element must have decoded at least its first frame so the
            // first exported frames aren't black/stale
            if (meta.videoEl && meta.videoEl.readyState < 2) {
              allLoaded = false;
              break;
            }
          }
          if (allLoaded || Date.now() - startTime > timeout) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        setTimeout(check, 200);
      });
    }

    /**
     * Pre-extract every video clip to an EVEN constant-frame-rate JPEG sequence
     * via FFmpeg so export never has to seek the (imprecise, VFR-prone) HTML
     * <video> element. Must be called AFTER waitForAssets() and BEFORE the first
     * renderFrameForExport(). If extraction fails for a clip it silently falls
     * back to the live-seek path for that clip — so export can never regress.
     * @param {number} fps - Export frame rate
     * @returns {Promise<void>}
     */
    async prepareExportFrames(fps) {
      const outFps = fps && fps > 0 ? fps : 30;
      const maxW = this.projectSettings?.width || 1920;
      const maxH = this.projectSettings?.height || 1080;
      if (!window.electronAPI || !window.electronAPI.extractVideoFramesCFR) return;

      const tasks = [];
      for (const track of this.tracks) {
        for (const clip of track.clips) {
          if (clip.type !== "video" || !clip.source) continue;
          const meta = this.clipObjects.get(clip.id);
          if (!meta) continue;
          tasks.push(
            (async () => {
              try {
                const res = await window.electronAPI.extractVideoFramesCFR({
                  source: clip.source,
                  trimStart: clip.trimStart || 0,
                  duration: clip.duration || 0,
                  fps: outFps,
                  maxWidth: maxW,
                  maxHeight: maxH,
                });
                if (res && res.success && res.frameCount > 0) {
                  meta.useExtractedFrames = true;
                  meta.exportFrameDir = res.dir;
                  meta.exportFrameCount = res.frameCount;
                  meta._exportFrameImg = new Image();
                  meta._exportFrameReady = null;
                  meta._exportFrameLoadedIdx = -1;
                } else {
                  console.warn(
                    "[VideoEditor] Frame extraction fallback (live seek):",
                    res && res.error
                  );
                }
              } catch (err) {
                console.warn(
                  "[VideoEditor] Frame extraction error (live seek):",
                  err.message
                );
              }
            })()
          );
        }
      }
      if (tasks.length) await Promise.all(tasks);
    }

    /**
     * Load the Nth pre-extracted JPEG for a video clip into its reusable Image.
     * Skips the load when the same frame index is already presented (so upsampled
     * exports that repeat a source frame don't re-decode it).
     * @param {Object} meta - Clip meta (must have exportFrameDir/exportFrameCount)
     * @param {number} idx - Zero-based frame index
     * @returns {Promise<void>}
     */
    _loadExportFrame(meta, idx) {
      return new Promise((resolve) => {
        if (meta._exportFrameLoadedIdx === idx && meta._exportFrameReady) {
          return resolve();
        }
        const img = meta._exportFrameImg || (meta._exportFrameImg = new Image());
        const fileName = "f_" + String(idx).padStart(6, "0") + ".jpg";
        const url = this._toFileURL(meta.exportFrameDir + "/" + fileName);
        const done = () => {
          img.onload = null;
          img.onerror = null;
          resolve();
        };
        img.onload = () => {
          meta._exportFrameReady = img;
          meta._exportFrameLoadedIdx = idx;
          done();
        };
        img.onerror = () => {
          // Keep whatever frame was previously presented if this load fails
          done();
        };
        img.src = url;
      });
    }

    /**
     * Render a frame for export — handles async video seeking before compositing
     * @param {number} timeSec - Time to render
     * @param {number} quality - JPEG quality 0-1
     * @returns {Promise<Uint8Array>} JPEG frame data
     */
    async renderFrameForExport(timeSec, quality, fps) {
      // Mark export mode so renderFrame() doesn't issue its own un-awaited seek.
      this._exporting = true;

      // Re-seek the source video for every distinct output frame. The tolerance
      // must be SMALLER than one output frame period, otherwise consecutive
      // frames (e.g. 16.7ms apart at 60fps) fall inside the tolerance and reuse
      // the previously decoded frame — producing irregular frame-holding and
      // visible judder. Use half the output frame period (capped at 20ms).
      const outFps = fps && fps > 0 ? fps : 30;
      const seekTolerance = Math.min(0.02, 0.5 / outFps);

      // Prepare the source frame for every active video clip. Clips that were
      // pre-extracted to a CFR JPEG sequence (prepareExportFrames) just load the
      // Nth frame from disk — perfectly even cadence, no browser seeking. Any
      // clip without extracted frames falls back to seeking + waiting on the
      // decoded <video> frame.
      const frameWork = [];
      for (const track of this.tracks) {
        if (!track.visible) continue;
        for (const clip of track.clips) {
          const meta = this.clipObjects.get(clip.id);
          if (!meta) continue;

          const clipStart = clip.startTime;
          const clipEnd = clip.startTime + this._effectiveClipDuration(clip);
          if (timeSec >= clipStart && timeSec < clipEnd) {
            const localTime = timeSec - clipStart;
            if (meta.useExtractedFrames) {
              const idx = Math.min(
                meta.exportFrameCount - 1,
                Math.max(0, Math.round(localTime * outFps))
              );
              frameWork.push(this._loadExportFrame(meta, idx));
            } else if (meta.videoEl && meta.videoEl.readyState >= 2) {
              const seekTime = (clip.trimStart || 0) + localTime;
              if (Math.abs(meta.videoEl.currentTime - seekTime) > seekTolerance) {
                frameWork.push(this._seekVideoAndWait(meta.videoEl, seekTime));
              }
            }
          }
        }
      }

      if (frameWork.length > 0) {
        await Promise.all(frameWork);
      }

      // Render the composited frame
      this.renderFrame(timeSec);

      // Extract as JPEG
      return new Promise((resolve) => {
        const el = this.canvas.getElement();
        el.toBlob(
          (blob) => {
            blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)));
          },
          "image/jpeg",
          quality || 0.80
        );
      });
    }

    /**
     * Seek a video element to a target time and resolve only once the frame at
     * that position has actually been decoded and presented. Uses
     * requestVideoFrameCallback when available (fires only when a new frame is
     * presentable), falling back to the "seeked" event plus a couple of
     * animation frames. A hard timeout guarantees the export can never stall on
     * a single stuck decode.
     * @param {HTMLVideoElement} videoEl
     * @param {number} seekTime
     * @returns {Promise<void>}
     */
    _seekVideoAndWait(videoEl, seekTime) {
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };

        // Hard safety timeout so a stuck decode never blocks the whole export
        const timer = setTimeout(done, 2000);

        const hasRVFC = typeof videoEl.requestVideoFrameCallback === "function";
        const onSeeked = () => {
          videoEl.removeEventListener("seeked", onSeeked);
          if (hasRVFC) {
            // Wait for the next frame to be presented after the seek completes
            try {
              videoEl.requestVideoFrameCallback(() => done());
            } catch (_) {
              done();
            }
          } else {
            // No rVFC: give the decoder two frames to present the new image
            requestAnimationFrame(() => requestAnimationFrame(done));
          }
        };
        videoEl.addEventListener("seeked", onSeeked);

        try {
          videoEl.currentTime = seekTime;
        } catch (_) {
          videoEl.removeEventListener("seeked", onSeeked);
          done();
        }
      });
    }

    /**
     * Clean up export-mode resources
     */
    destroyExport() {
      this._exporting = false;
      // Delete any temp CFR frame directories created by prepareExportFrames
      for (const [, meta] of this.clipObjects) {
        if (meta && meta.exportFrameDir) {
          try {
            window.electronAPI?.cleanupExtractedFrames?.(meta.exportFrameDir);
          } catch (_) {}
          meta.exportFrameDir = null;
          meta.useExtractedFrames = false;
          meta._exportFrameReady = null;
        }
      }
      this.destroy();
      if (this._exportCanvasEl) {
        this._exportCanvasEl.remove();
        this._exportCanvasEl = null;
      }
      this._exportMode = false;
    }
  }

  // Expose globally
  window.VEPreviewEngine = PreviewEngine;
})();
