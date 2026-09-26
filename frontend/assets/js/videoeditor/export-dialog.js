/**
 * Video Editor - Export Dialog Controller
 * Manages export settings, ffmpeg check/download, and export progress
 */
(function () {
  "use strict";

  class ExportDialog {
    constructor() {
      this.format = "mp4";
      this.quality = "high";
      this.resolution = "original";
      this.fps = 30;
      this.isExporting = false;
      this.ffmpegReady = false;
    }

    /**
     * Initialize export dialog event bindings
     */
    init(namespace) {
      const NS = namespace;

      // Format selection
      $(document).on("click" + NS, ".ve-format-btn", (e) => {
        $(".ve-format-btn").removeClass("active");
        $(e.currentTarget).addClass("active");
        this.format = $(e.currentTarget).data("format");
      });

      // Quality
      $(document).on("change" + NS, "#ve-export-quality", (e) => {
        this.quality = e.target.value;
      });

      // Resolution
      $(document).on("change" + NS, "#ve-export-resolution", (e) => {
        this.resolution = e.target.value;
      });

      // FPS
      $(document).on("change" + NS, "#ve-export-fps", (e) => {
        this.fps = parseInt(e.target.value, 10);
      });
    }

    /**
     * Show the export modal and check ffmpeg status
     */
    async show() {
      $("#ve-export-modal").fadeIn(200);
      $("#ve-export-progress").hide();
      $("#ve-export-settings").show();
      $("#ve-export-start-btn").prop("disabled", true).show();
      $("#ve-ffmpeg-status").hide();
      // Reset progress icon for fresh export
      $("#ve-export-progress-info-icon").addClass("ve-spin").text("sync").css("color", "");
      $("#ve-export-progress-bar").css("width", "0%");
      $("#ve-export-progress-text").text("0%");
      $("#ve-export-status-text").text(
        window.I18n?.t("videoeditor.exporting") || "Exporting video..."
      );

      await this.checkFFmpeg();
      if (this.ffmpegReady) {
        $("#ve-export-start-btn").prop("disabled", false);
      }
    }

    /**
     * Hide the export modal
     */
    hide() {
      if (this.isExporting) {
        if (!confirm(window.I18n?.t("videoeditor.cancel_export_confirm") || "Export in progress. Cancel?")) {
          return;
        }
        this.cancelExport();
      }
      $("#ve-export-modal").fadeOut(200);
    }

    /**
     * Check if ffmpeg is available
     */
    async checkFFmpeg() {
      try {
        const result = await window.electronAPI.checkFFmpeg();
        this.ffmpegReady = result?.installed === true;

        if (!this.ffmpegReady) {
          $("#ve-ffmpeg-status").show();
          await this.downloadFFmpeg();
        }
      } catch (err) {
        console.error("[ExportDialog] FFmpeg check error:", err);
        this.ffmpegReady = false;
        $("#ve-ffmpeg-status").show();
      }
    }

    /**
     * Download ffmpeg
     */
    async downloadFFmpeg() {
      try {
        // Listen for progress
        window.electronAPI.onFFmpegDownloadProgress((percent, downloadedMB, totalMB) => {
          if (percent === -1) {
            $("#ve-ffmpeg-progress").css("width", "100%");
            $("#ve-ffmpeg-progress-text").text(
              window.I18n?.t("videoeditor.ffmpeg_extracting") || "Extracting..."
            );
          } else {
            const pct = Math.round(percent || 0);
            $("#ve-ffmpeg-progress").css("width", pct + "%");
            $("#ve-ffmpeg-progress-text").text(pct + "% (" + downloadedMB + "/" + totalMB + " MB)");
          }
        });

        const result = await window.electronAPI.downloadFFmpeg();
        if (result?.success) {
          this.ffmpegReady = true;
          $("#ve-ffmpeg-status").slideUp(300);
        } else {
          $("#ve-ffmpeg-progress-text").text(
            window.I18n?.t("videoeditor.ffmpeg_download_failed") || "Download failed. Please try again."
          );
        }
      } catch (err) {
        console.error("[ExportDialog] FFmpeg download error:", err);
        $("#ve-ffmpeg-progress-text").text("Error: " + err.message);
      } finally {
        window.electronAPI.removeFFmpegDownloadProgressListeners?.();
      }
    }

    /**
     * Start the export process
     */
    async startExport(project) {
      if (!this.ffmpegReady) {
        await this.checkFFmpeg();
        if (!this.ffmpegReady) return;
      }

      // Ask user for save path
      const saveResult = await window.electronAPI.showSaveDialog({
        title: window.I18n?.t("videoeditor.save_video") || "Save Video",
        defaultPath: (project.name || "video") + "." + this.format,
        filters: [
          this.format === "mp4"
            ? { name: "MP4 Video", extensions: ["mp4"] }
            : { name: "WebM Video", extensions: ["webm"] }
        ]
      });

      if (!saveResult || saveResult.canceled || !saveResult.filePath) return;
      const savePath = saveResult.filePath;

      this.isExporting = true;
      $("#ve-export-settings").hide();
      $("#ve-export-progress").show();
      $("#ve-export-start-btn").hide();
      $("#ve-export-cancel-btn").text(
        window.I18n?.t("videoeditor.cancel") || "Cancel"
      );

      let exportEngine = null;

      try {
        // Compute export resolution from preset or original
        const projW = project.settings?.width || 1920;
        const projH = project.settings?.height || 1080;
        const resolutionPresets = { '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160 };
        let calcW = projW, calcH = projH;
        if (this.resolution !== 'original' && resolutionPresets[this.resolution]) {
          const targetShort = resolutionPresets[this.resolution];
          const shortSide = Math.min(projW, projH);
          const scale = targetShort / shortSide;
          calcW = Math.round(projW * scale);
          calcH = Math.round(projH * scale);
        }
        // Ensure even dimensions for H.264 compatibility
        const exportWidth = (calcW & ~1);
        const exportHeight = (calcH & ~1);
        const exportFps = this.fps || project.settings?.fps || 30;

        // Calculate total duration
        let totalDuration = 0;
        for (const track of project.tracks || []) {
          for (const clip of track.clips || []) {
            const end = (clip.startTime || 0) + (clip.duration || 0);
            if (end > totalDuration) totalDuration = end;
          }
        }

        if (totalDuration <= 0) {
          throw new Error("No content to export");
        }

        const totalFrames = Math.ceil(totalDuration * exportFps);

        // Update status
        $("#ve-export-status-text").text(
          window.I18n?.t("videoeditor.preparing_export") || "Preparing assets..."
        );

        // Create an offscreen PreviewEngine for full-resolution frame rendering
        exportEngine = new window.VEPreviewEngine();
        exportEngine.initForExport(
          exportWidth,
          exportHeight,
          project.settings?.backgroundColor,
          project.settings?.backgroundType,
          project.settings?.blurIntensity
        );
        exportEngine.loadTracks(project.tracks);
        await exportEngine.waitForAssets();
        // Pre-extract every video clip to an even CFR JPEG sequence (FFmpeg) so
        // export never seeks the <video> element — eliminates judder/freezes.
        await exportEngine.prepareExportFrames(exportFps);

        // Collect audio clips (standalone audio + audio from video clips)
        const audioClips = [];
        for (const track of project.tracks || []) {
          if (!track.visible) continue;
          for (const clip of track.clips || []) {
            if (clip.type === "audio" && clip.source) {
              audioClips.push(clip);
            } else if (clip.type === "video" && clip.source && !clip.muted && clip.volume !== 0) {
              // Include video files that have audio (skip if explicitly muted)
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

        // Start ffmpeg in main process (frame pipe mode)
        const startResult = await window.electronAPI.startFrameExport({
          width: exportWidth,
          height: exportHeight,
          fps: exportFps,
          format: this.format,
          quality: this.quality,
          outputPath: savePath,
          audioClips,
          totalDuration,
        });

        if (!startResult?.success) {
          throw new Error(startResult?.error || "Failed to start export");
        }

        // Update status
        $("#ve-export-status-text").text(
          window.I18n?.t("videoeditor.exporting") || "Exporting video..."
        );

        // Render and send frames one by one.
        // The IPC write + FFmpeg ingest of the current frame is overlapped with
        // the rendering of the next frame (a 1-deep pipeline) so the renderer and
        // FFmpeg run concurrently — using otherwise-idle CPU to finish faster.
        // Rendering stays strictly serial (no concurrent video seeks) and the
        // JPEG buffer is detached from the canvas before the next render begins,
        // so frames can never corrupt one another. Keeping a single write in
        // flight preserves ordering and back-pressure.
        let pendingWrite = null;
        for (let frame = 0; frame < totalFrames; frame++) {
          if (!this.isExporting) break; // User cancelled

          const timeSec = frame / exportFps;
          const frameData = await exportEngine.renderFrameForExport(timeSec, 0.95, exportFps);

          if (pendingWrite) {
            const prev = await pendingWrite;
            pendingWrite = null;
            if (!prev?.success) throw new Error(prev?.error || "Failed to write frame");
            if (prev.done) break; // FFmpeg finished encoding — stop sending frames
          }

          pendingWrite = window.electronAPI.writeExportFrame(frameData);

          // Update progress UI
          const percent = Math.round(((frame + 1) / totalFrames) * 100);
          $("#ve-export-progress-bar").css("width", percent + "%");
          $("#ve-export-progress-text").text(
            percent + "% (Frame " + (frame + 1) + "/" + totalFrames + ")"
          );

          // Yield to event loop every 5 frames so the UI stays responsive
          if (frame % 5 === 0) {
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        if (pendingWrite) {
          const last = await pendingWrite;
          if (!last?.success) throw new Error(last?.error || "Failed to write frame");
        }

        // Finalize: close stdin and wait for ffmpeg to finish encoding
        const result = await window.electronAPI.finishFrameExport();

        if (result?.success) {
          $("#ve-export-status-text").text(
            window.I18n?.t("videoeditor.export_complete") || "Export complete!"
          );
          $("#ve-export-progress-bar").css("width", "100%");
          $("#ve-export-progress-text").text("100%");
          $("#ve-export-progress-info-icon")
            .removeClass("ve-spin")
            .text("check_circle")
            .css("color", "#22c55e");
          $("#ve-export-cancel-btn").text(
            window.I18n?.t("videoeditor.close") || "Close"
          );
        } else {
          $("#ve-export-status-text").text(
            (window.I18n?.t("videoeditor.export_failed") || "Export failed: ") +
              (result?.error || "Unknown error")
          );
          $("#ve-export-progress-info-icon")
            .removeClass("ve-spin")
            .text("error")
            .css("color", "#ef4444");
        }
      } catch (err) {
        console.error("[ExportDialog] Export error:", err);
        $("#ve-export-status-text").text("Error: " + err.message);
        $("#ve-export-progress-info-icon")
          .removeClass("ve-spin")
          .text("error")
          .css("color", "#ef4444");
      } finally {
        this.isExporting = false;
        if (exportEngine) {
          exportEngine.destroyExport();
        }
      }
    }

    /**
     * Cancel the current export
     */
    cancelExport() {
      if (this.isExporting) {
        window.electronAPI.cancelVideoExport?.();
        this.isExporting = false;
      }
    }
  }

  window.VEExportDialog = ExportDialog;
})();
