const { readKey } = require("../lib/utils");
const { getVideoMetadata } = require("../lib/videoExporter");
const { app } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");

/**
 * Video Editor automation node
 * Loads a saved video template, replaces placeholder clips with actual media,
 * replaces {INPUT_X} in text clips, and exports the video.
 *
 * @param {string} templateId - ID of the video template to use
 * @param {Object} inputs - Connection inputs { input_1, input_2, ... }
 * @param {string|null} musicPath - Path to background music file, or null for no music
 * @returns {Promise<{success: boolean, value: string}>}
 */
async function videoEditor(templateId, inputs, musicPath, fps, quality, resolution, subtitlesTemplate, subtitlesLanguage) {
  if (!templateId || typeof templateId !== "string") {
    return { success: false, value: "Template ID is required" };
  }

  const videoTemplates = await readKey("videoTemplates");
  if (!videoTemplates || !Array.isArray(videoTemplates)) {
    return { success: false, value: "No video templates found" };
  }

  const template = videoTemplates.find((t) => t.id === templateId || t.projectId === templateId);
  if (!template) {
    return {
      success: false,
      value: `Template with id "${templateId}" not found`,
    };
  }

  try {
    // Deep clone the project to avoid mutating the template
    const project = JSON.parse(JSON.stringify(template.project));

    // Replace placeholder clips and text placeholders
    for (const track of project.tracks || []) {
      for (let i = 0; i < track.clips.length; i++) {
        const clip = track.clips[i];

        // Replace placeholder clips with actual media
        if (clip.isPlaceholder && clip.placeholderId) {
          const num = parseInt(
            clip.placeholderId.replace("placeholder_", ""),
            10
          );
          const inputKey = `input_${num}`;
          const inputValue = inputs[inputKey];

          if (inputValue) {
            const wasMuted = clip.muted; // preserve user-configured mute
            clip.source = inputValue;
            clip.isPlaceholder = false;
            clip.name = path.basename(String(inputValue));
            if (wasMuted) clip.muted = true;

            // For audio placeholders: if input audio is longer than the
            // placeholder duration, calculate atempo factor to speed it up
            if (clip.type === "audio") {
              try {
                const meta = await getVideoMetadata(String(inputValue));
                if (meta.success && meta.duration > 0) {
                  const placeholderDur = clip.duration || 5;
                  if (meta.duration > placeholderDur) {
                    clip.atempoFactor = meta.duration / placeholderDur;
                    console.log(
                      `[VideoEditor Automation] Audio placeholder ${num}: ` +
                      `input ${meta.duration.toFixed(2)}s > slot ${placeholderDur}s, ` +
                      `atempo=${clip.atempoFactor.toFixed(3)}`
                    );
                  }
                }
              } catch (err) {
                console.warn(`[VideoEditor Automation] Could not probe audio duration for placeholder ${num}:`, err.message);
              }
            }
          } else {
            // No input for this placeholder — remove clip so it doesn't cause errors
            track.clips.splice(i, 1);
            i--;
            continue;
          }
        }

        // Replace {INPUT_X} patterns in text clips
        if (clip.type === "text" && clip.text) {
          clip.text = clip.text.replace(/\{INPUT_(\d+)\}/g, (match, num) => {
            const inputKey = `input_${num}`;
            const val = inputs[inputKey];
            if (val === undefined || val === null) return "";
            return Array.isArray(val) ? val.join(", ") : String(val);
          });
        }
      }
    }

    // If a music file is provided, add an audio clip covering the entire video
    if (musicPath && fsSync.existsSync(musicPath)) {
      // Calculate total video duration from all clips across all tracks
      let totalDuration = 0;
      for (const track of project.tracks || []) {
        for (const clip of track.clips || []) {
          const clipEnd = (clip.startTime || 0) + (clip.duration || 0);
          if (clipEnd > totalDuration) totalDuration = clipEnd;
        }
      }
      if (totalDuration <= 0) totalDuration = 10;

      // Find or create an audio track
      let audioTrack = project.tracks.find(t => t.type === "audio");
      if (!audioTrack) {
        audioTrack = { id: "track_music", type: "audio", name: "Music", locked: false, visible: true, clips: [] };
        project.tracks.push(audioTrack);
      }

      // Add the music clip spanning the full video duration
      audioTrack.clips.push({
        type: "audio",
        source: musicPath,
        startTime: 0,
        duration: totalDuration,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0.5,
        name: path.basename(musicPath)
      });

      console.log(`[VideoEditor Automation] Added music: ${path.basename(musicPath)} (${totalDuration}s)`);
    }

    // Prepare a reusable exporter. Resolution/quality are fixed; each call
    // renders the CURRENT project state to a fresh temp file.
    const tempDir = path.join(app.getPath("userData"), "Temp");
    await fs.mkdir(tempDir, { recursive: true });

    const projW = project.settings?.width || 1920;
    const projH = project.settings?.height || 1080;
    const resPresets = { '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160 };
    let expW = projW, expH = projH;
    if (resolution && resolution !== 'original' && resPresets[resolution]) {
      const targetShort = resPresets[resolution];
      const shortSide = Math.min(projW, projH);
      const scale = targetShort / shortSide;
      expW = Math.round(projW * scale);
      expH = Math.round(projH * scale);
    }

    const { autoExportVideo } = require("../lib/ipcHandlers");
    const { videoExportQueue } = require("../lib/videoExportQueue");

    async function exportProject(opts = {}) {
      const fast = opts.fast === true;
      const outputPath = path.join(
        tempDir,
        `ve_export_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`
      );
      // A "fast" pass is only used to obtain the final mixed audio for
      // transcription. The audio track is identical at any resolution/fps, so
      // we render at a tiny size and low frame rate to make it much faster.
      const exportSettings = {
        format: "mp4",
        quality: fast ? "low" : (quality || "high"),
        width: fast ? 320 : (expW & ~1),
        height: fast ? 180 : (expH & ~1),
        fps: fast ? 6 : (fps || project.settings?.fps || 30),
        outputPath,
      };
      console.log(`[VideoEditor Automation] Exporting video${fast ? " (fast audio pass)" : ""}:`, outputPath);
      const res = await videoExportQueue.enqueue(() => autoExportVideo(project, exportSettings));
      return res && res.success
        ? { success: true, outputPath: res.outputPath || outputPath }
        : { success: false, error: (res && res.error) || "Export failed" };
    }

    const wantSubtitles = subtitlesTemplate && subtitlesTemplate !== 'disabled';

    // No subtitles requested — render the final video once and return it.
    if (!wantSubtitles) {
      const baseExport = await exportProject();
      if (!baseExport.success) {
        return { success: false, value: baseExport.error };
      }
      return { success: true, value: baseExport.outputPath };
    }

    // Subtitles requested. To avoid rendering the full video twice, first do a
    // FAST low-resolution render purely to obtain the final mixed audio (TTS +
    // music, with the same atempo/trim as the real export). Transcribe that
    // audio, then render the real video ONCE with the subtitle track burned in.
    console.log(`[VideoEditor Automation] Auto subtitles enabled: template=${subtitlesTemplate}, language=${subtitlesLanguage || 'auto'}`);

    let words = null;
    try {
      const audioPass = await exportProject({ fast: true });
      if (!audioPass.success) {
        console.error(`[VideoEditor Automation] Fast audio pass failed (${audioPass.error}); rendering without subtitles`);
      } else {
        const { transcribeAudio } = require("../lib/transcription");
        console.log(`[VideoEditor Automation] Transcribing audio pass: ${path.basename(audioPass.outputPath)}`);
        const result = await transcribeAudio(audioPass.outputPath, subtitlesLanguage || undefined);
        try { await fs.unlink(audioPass.outputPath); } catch (_) {}

        if (!result || result.success === false || !result.words || result.words.length === 0) {
          const reason = (result && result.error) || "no speech detected";
          console.error(
            `[VideoEditor Automation] Auto subtitles produced NO subtitles. Reason: ${reason}. ` +
            `Common causes: missing/invalid OpenAI API key (Settings -> API Keys), the video has no ` +
            `spoken audio, or ffmpeg could not extract audio. Rendering the video without subtitles.`
          );
        } else {
          // Word timings from the rendered audio are already in the OUTPUT
          // timeline, so no atempo/trim conversion is needed.
          words = result.words.map(w => {
            const rawStart = typeof w.start === "number" ? w.start : 0;
            const rawEnd = typeof w.end === "number" ? w.end : rawStart;
            return {
              text: w.word || w.text || "",
              start: Math.max(0, rawStart),
              end: Math.max(0, rawEnd),
            };
          });
          console.log(`[VideoEditor Automation] Transcribed ${words.length} words`);
        }
      }
    } catch (subErr) {
      console.error("[VideoEditor Automation] Auto subtitles error:", subErr.message);
    }

    // If we got words, build a subtitle track and add it to the project so the
    // single final render burns the subtitles in.
    if (words && words.length) {
      // Template style defaults (matching subtitle-templates.js)
      const templateDefaults = {
        classic:    { fontSize: 72, fontFamily: "Arial", fontColor: "#ffffff", highlightColor: "#FFD700", strokeColor: "#000000", strokeWidth: 8, backgroundColor: "" },
        pop:        { fontSize: 72, fontFamily: "Arial", fontColor: "#ffffff", highlightColor: "#FF3B5C", strokeColor: "#000000", strokeWidth: 8, backgroundColor: "" },
        neon:       { fontSize: 68, fontFamily: "Arial", fontColor: "#e0e0ff", highlightColor: "#00f5ff", strokeColor: "#0a0a1e", strokeWidth: 8, backgroundColor: "" },
        karaoke:    { fontSize: 72, fontFamily: "Arial", fontColor: "#ffffff", highlightColor: "#FFD700", strokeColor: "#000000", strokeWidth: 8, backgroundColor: "" },
        highlight:  { fontSize: 72, fontFamily: "Arial", fontColor: "#ffffff", highlightColor: "#FFD700", strokeColor: "#000000", strokeWidth: 8, backgroundColor: "rgba(0,0,0,0.6)" },
        typewriter: { fontSize: 72, fontFamily: "Arial", fontColor: "#ffffff", highlightColor: "#00ff88", strokeColor: "#000000", strokeWidth: 8, backgroundColor: "" },
        wave:       { fontSize: 72, fontFamily: "Arial", fontColor: "#ffffff", highlightColor: "#FF6B35", strokeColor: "#000000", strokeWidth: 8, backgroundColor: "" },
        shadow3d:   { fontSize: 72, fontFamily: "Arial", fontColor: "#ffffff", highlightColor: "#FFD700", strokeColor: "#000000", strokeWidth: 8, backgroundColor: "" }
      };
      const defaults = templateDefaults[subtitlesTemplate] || templateDefaults.classic;

      // Subtitles span the whole video timeline.
      let totalDuration = 0;
      for (const track of project.tracks || []) {
        for (const clip of track.clips || []) {
          const clipEnd = (clip.startTime || 0) + (clip.duration || 0);
          if (clipEnd > totalDuration) totalDuration = clipEnd;
        }
      }
      const lastWord = words[words.length - 1];
      const subDuration = totalDuration > 0 ? totalDuration : lastWord.end + 0.5;

      const subtitleTrack = {
        id: "track_autosub_" + Date.now(),
        type: "subtitle",
        name: "Auto Subtitles",
        visible: true,
        locked: false,
        clips: [{
          id: "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          type: "subtitle",
          template: subtitlesTemplate,
          words: words,
          wordsPerGroup: 4,
          startTime: 0,
          duration: subDuration,
          // No explicit position — renderSubtitleFrame defaults to bottom-center
          // of the actual export canvas, so it stays correct at any resolution.
          fontSize: defaults.fontSize,
          fontFamily: defaults.fontFamily,
          fontColor: defaults.fontColor,
          highlightColor: defaults.highlightColor,
          strokeColor: defaults.strokeColor,
          strokeWidth: defaults.strokeWidth,
          backgroundColor: defaults.backgroundColor,
          name: "Auto Subtitles"
        }]
      };
      project.tracks.push(subtitleTrack);
      console.log(`[VideoEditor Automation] Re-rendering once with ${words.length} subtitle words`);
    }

    // Final render — once — with subtitles burned in (or plain if transcription
    // failed). Either way this is a valid, full-quality export.
    const finalExport = await exportProject();
    if (!finalExport.success) {
      return { success: false, value: finalExport.error };
    }
    return { success: true, value: finalExport.outputPath };
  } catch (error) {
    console.error("[VideoEditor Automation] Error:", error);
    return { success: false, value: error.message };
  }
}

module.exports = { videoEditor };
