/**
 * VC Video Editor — Subtitle Templates
 *
 * 8 CapCut-style animated subtitle templates with word-by-word highlighting.
 * Bold, impactful styles with thick outlines, multi-line layout, and uppercase text.
 */

(function (global) {
  "use strict";

  // ============================================
  // WORD GROUPING LOGIC
  // ============================================

  function getActiveWordGroup(clip, relativeTime) {
    const words = clip.words || [];
    if (words.length === 0) return { groupWords: [], activeWordIndex: -1, activeProgress: 0, groupIndex: 0 };

    const wpg = clip.wordsPerGroup || 4;

    const groups = [];
    for (let i = 0; i < words.length; i += wpg) {
      groups.push(words.slice(i, i + wpg));
    }

    let activeGlobalIndex = -1;
    for (let i = 0; i < words.length; i++) {
      if (relativeTime >= words[i].start && relativeTime < words[i].end) {
        activeGlobalIndex = i;
        break;
      }
    }

    if (activeGlobalIndex === -1) {
      for (let i = 0; i < words.length; i++) {
        if (relativeTime < words[i].start) {
          activeGlobalIndex = i;
          break;
        }
      }
    }

    if (activeGlobalIndex === -1) {
      // relativeTime is past the last word's end (no active word and no upcoming
      // word). Keep the final group on screen only for a short linger so it stays
      // readable, then hide it. Without this the last subtitle would stick around
      // until the subtitle clip ends — i.e. until the very end of the video.
      const lastWord = words[words.length - 1];
      const linger = clip.subtitleEndLinger != null ? clip.subtitleEndLinger : 1.0;
      if (lastWord && relativeTime <= lastWord.end + linger) {
        activeGlobalIndex = words.length - 1;
      } else {
        return { groupWords: [], activeWordIndex: -1, activeProgress: 0, groupIndex: 0 };
      }
    }

    const groupIndex = Math.floor(activeGlobalIndex / wpg);
    const groupWords = groups[groupIndex] || [];
    const activeWordIndex = activeGlobalIndex - groupIndex * wpg;

    const activeWord = words[activeGlobalIndex];
    let activeProgress = 0;
    if (activeWord && activeWord.end > activeWord.start) {
      activeProgress = Math.max(0, Math.min(1,
        (relativeTime - activeWord.start) / (activeWord.end - activeWord.start)
      ));
    }
    if (activeWord && relativeTime < activeWord.start) {
      activeProgress = 0;
    }

    return { groupWords, activeWordIndex, activeProgress, groupIndex };
  }

  // ============================================
  // EASING FUNCTIONS
  // ============================================

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  function easeOutBounce(t) {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
    if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
    t -= 2.625 / 2.75; return 7.5625 * t * t + 0.984375;
  }

  // ============================================
  // MULTI-LINE LAYOUT HELPERS
  // ============================================

  /**
   * Split group words into display lines (~2-3 words per line, stacked vertically).
   */
  function splitIntoLines(groupWords, maxPerLine) {
    if (!maxPerLine) {
      maxPerLine = groupWords.length <= 2 ? groupWords.length : Math.ceil(groupWords.length / 2);
    }
    const lines = [];
    for (let i = 0; i < groupWords.length; i += maxPerLine) {
      lines.push(groupWords.slice(i, i + maxPerLine));
    }
    return lines;
  }

  /**
   * Measure lines and return layout metrics.
   * @returns Array of { words: [], widths: [], totalWidth, spacing }
   */
  function measureLines(ctx, lines, fontSize) {
    const spacing = fontSize * 0.35;
    return lines.map(function (lineWords) {
      var widths = lineWords.map(function (w) { return ctx.measureText(w.text.toUpperCase()).width; });
      var totalWidth = widths.reduce(function (a, b) { return a + b; }, 0) + spacing * Math.max(0, widths.length - 1);
      return { words: lineWords, widths: widths, totalWidth: totalWidth, spacing: spacing };
    });
  }

  /**
   * Draw a word with thick stroke + fill (double-stroke for heavier outline).
   */
  function drawBoldWord(ctx, text, cx, cy, fillColor, strokeColor, strokeWidth) {
    if (strokeWidth > 0) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeText(text, cx, cy);
    }
    ctx.fillStyle = fillColor;
    ctx.fillText(text, cx, cy);
  }

  /**
   * Iterate over multi-line layout and call a per-word callback.
   * callback(word, globalIdx, wx, wy, wordWidth, lineIdx)
   */
  function forEachWord(measuredLines, centerX, baseY, fontSize, lineHeight, callback) {
    var totalBlockH = measuredLines.length * lineHeight;
    var startY = baseY - totalBlockH / 2 + lineHeight / 2;

    for (var li = 0; li < measuredLines.length; li++) {
      var line = measuredLines[li];
      var lx = centerX - line.totalWidth / 2;
      var ly = startY + li * lineHeight;

      for (var wi = 0; wi < line.words.length; wi++) {
        var wx = lx + line.widths[wi] / 2;
        callback(line.words[wi], wi + (li > 0 ? measuredLines[0].words.length * li : 0), wx, ly, line.widths[wi], li);
        lx += line.widths[wi] + line.spacing;
      }
    }
  }

  /**
   * Get the global index within the original groupWords for a word in multi-line layout.
   */
  function getGlobalIndex(measuredLines, lineIdx, wordIdx) {
    var idx = 0;
    for (var i = 0; i < lineIdx; i++) {
      idx += measuredLines[i].words.length;
    }
    return idx + wordIdx;
  }

  // ============================================
  // TEMPLATE DEFINITIONS
  // ============================================

  const SUBTITLE_TEMPLATES = [
    // ---- 1. CLASSIC BOLD ----
    {
      key: "classic",
      name: "Classic Bold",
      description: "Bold white text with yellow highlight, thick black outline",
      previewColors: ["#ffffff", "#FFD700"],
      defaults: {
        fontSize: 72,
        fontFamily: "Arial",
        fontColor: "#ffffff",
        highlightColor: "#FFD700",
        strokeColor: "#000000",
        strokeWidth: 8,
        backgroundColor: "",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth;

        ctx.font = "900 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var lines = splitIntoLines(groupWords);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.2;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;

        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var gIdx = getGlobalIndex(measured, li, wi);
            var wx = lx + line.widths[wi] / 2;
            var isActive = gIdx === activeWordIndex;
            var color = isActive ? highlightColor : fontColor;

            drawBoldWord(ctx, line.words[wi].text.toUpperCase(), wx, ly, color, strokeColor, strokeWidth);
            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },

    // ---- 2. POP BOUNCE ----
    {
      key: "pop",
      name: "Pop",
      description: "Active word pops up with bounce and scale",
      previewColors: ["#ffffff", "#FF3B5C"],
      defaults: {
        fontSize: 72,
        fontFamily: "Arial",
        fontColor: "#ffffff",
        highlightColor: "#FF3B5C",
        strokeColor: "#000000",
        strokeWidth: 8,
        backgroundColor: "",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth;

        ctx.font = "900 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var lines = splitIntoLines(groupWords);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.2;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;

        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var gIdx = getGlobalIndex(measured, li, wi);
            var wx = lx + line.widths[wi] / 2;
            var isActive = gIdx === activeWordIndex;

            ctx.save();

            if (isActive) {
              var scaleT = activeProgress < 0.25 ? easeOutBack(activeProgress / 0.25) : 1.0;
              var popScale = 1.0 + 0.25 * scaleT;
              var yOff = -fontSize * 0.1 * scaleT;

              ctx.translate(wx, ly);
              ctx.scale(popScale, popScale);
              ctx.translate(-wx, -ly);

              drawBoldWord(ctx, line.words[wi].text.toUpperCase(), wx, ly + yOff, highlightColor, strokeColor, strokeWidth);
            } else {
              drawBoldWord(ctx, line.words[wi].text.toUpperCase(), wx, ly, fontColor, strokeColor, strokeWidth);
            }

            ctx.restore();
            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },

    // ---- 3. NEON GLOW ----
    {
      key: "neon",
      name: "Neon Glow",
      description: "Dark background with bright neon glow on active word",
      previewColors: ["#1a1a2e", "#00f5ff"],
      defaults: {
        fontSize: 68,
        fontFamily: "Arial",
        fontColor: "#c0c0c0",
        highlightColor: "#00f5ff",
        strokeColor: "#000000",
        strokeWidth: 4,
        backgroundColor: "rgba(0,0,0,0.7)",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth;
        var backgroundColor = opts.backgroundColor, scale = opts.scale;

        ctx.font = "800 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var lines = splitIntoLines(groupWords);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.2;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;

        // Background box spanning all lines
        if (backgroundColor) {
          var maxLineW = 0;
          for (var i = 0; i < measured.length; i++) {
            if (measured[i].totalWidth > maxLineW) maxLineW = measured[i].totalWidth;
          }
          var padH = fontSize * 0.6;
          var padV = fontSize * 0.4;
          var bgX = x - maxLineW / 2 - padH;
          var bgY = startY - lineH / 2 - padV;
          var bgW = maxLineW + padH * 2;
          var bgH = totalH + padV * 2;
          ctx.fillStyle = backgroundColor;
          ctx.beginPath();
          ctx.roundRect(bgX, bgY, bgW, bgH, fontSize * 0.15);
          ctx.fill();
        }

        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var gIdx = getGlobalIndex(measured, li, wi);
            var wx = lx + line.widths[wi] / 2;
            var isActive = gIdx === activeWordIndex;
            var txt = line.words[wi].text.toUpperCase();

            if (isActive) {
              ctx.save();
              ctx.shadowColor = highlightColor;
              ctx.shadowBlur = fontSize * 0.5 * scale;
              drawBoldWord(ctx, txt, wx, ly, highlightColor, strokeColor, strokeWidth);
              // Double-draw for stronger glow
              ctx.fillStyle = highlightColor;
              ctx.fillText(txt, wx, ly);
              ctx.restore();
            } else {
              drawBoldWord(ctx, txt, wx, ly, fontColor, strokeColor, strokeWidth);
            }

            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },

    // ---- 4. KARAOKE FILL ----
    {
      key: "karaoke",
      name: "Karaoke",
      description: "Color progressively fills each word left to right",
      previewColors: ["#888888", "#FFD700"],
      defaults: {
        fontSize: 72,
        fontFamily: "Arial",
        fontColor: "#888888",
        highlightColor: "#FFD700",
        strokeColor: "#000000",
        strokeWidth: 8,
        backgroundColor: "",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth;

        ctx.font = "900 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var lines = splitIntoLines(groupWords);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.2;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;

        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var gIdx = getGlobalIndex(measured, li, wi);
            var wx = lx + line.widths[wi] / 2;
            var isActive = gIdx === activeWordIndex;
            var isPast = gIdx < activeWordIndex;
            var txt = line.words[wi].text.toUpperCase();
            var wordLeft = lx;
            var ww = line.widths[wi];

            // Stroke first (always)
            if (strokeWidth > 0) {
              ctx.strokeStyle = strokeColor;
              ctx.lineWidth = strokeWidth;
              ctx.lineJoin = "round";
              ctx.miterLimit = 2;
              ctx.strokeText(txt, wx, ly);
            }

            if (isPast || isActive) {
              ctx.fillStyle = highlightColor;
              ctx.fillText(txt, wx, ly);
            } else {
              ctx.fillStyle = fontColor;
              ctx.fillText(txt, wx, ly);
            }

            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },

    // ---- 5. HIGHLIGHT BOX ----
    {
      key: "highlight",
      name: "Highlight",
      description: "Colored box behind the active word",
      previewColors: ["#ffffff", "#6C63FF"],
      defaults: {
        fontSize: 68,
        fontFamily: "Arial",
        fontColor: "#ffffff",
        highlightColor: "#6C63FF",
        strokeColor: "#000000",
        strokeWidth: 6,
        backgroundColor: "",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth;

        ctx.font = "900 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var lines = splitIntoLines(groupWords);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.25;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;

        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var gIdx = getGlobalIndex(measured, li, wi);
            var wx = lx + line.widths[wi] / 2;
            var isActive = gIdx === activeWordIndex;
            var txt = line.words[wi].text.toUpperCase();

            if (isActive) {
              // Draw highlight box behind active word
              var padH = fontSize * 0.2;
              var padV = fontSize * 0.12;
              ctx.fillStyle = highlightColor;
              ctx.beginPath();
              ctx.roundRect(lx - padH, ly - fontSize * 0.55 - padV,
                line.widths[wi] + padH * 2, fontSize * 1.1 + padV * 2,
                fontSize * 0.12);
              ctx.fill();

              drawBoldWord(ctx, txt, wx, ly, "#ffffff", strokeColor, strokeWidth);
            } else {
              drawBoldWord(ctx, txt, wx, ly, fontColor, strokeColor, strokeWidth);
            }

            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },

    // ---- 6. TYPEWRITER ----
    {
      key: "typewriter",
      name: "Typewriter",
      description: "Words appear one by one as spoken",
      previewColors: ["#ffffff", "#00E676"],
      defaults: {
        fontSize: 68,
        fontFamily: "Arial",
        fontColor: "#ffffff",
        highlightColor: "#00E676",
        strokeColor: "#000000",
        strokeWidth: 8,
        backgroundColor: "",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth;

        ctx.font = "900 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Only show words up to active
        var visible = groupWords.slice(0, activeWordIndex + 1);
        var lines = splitIntoLines(visible);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.2;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;

        var globalIdx = 0;
        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var wx = lx + line.widths[wi] / 2;
            var isActive = globalIdx === activeWordIndex;
            var txt = line.words[wi].text.toUpperCase();

            // Fade in new word
            var alpha = 1;
            if (isActive && activeProgress < 0.25) {
              alpha = easeOutCubic(activeProgress / 0.25);
            }
            ctx.globalAlpha = alpha;

            drawBoldWord(ctx, txt, wx, ly, isActive ? highlightColor : fontColor, strokeColor, strokeWidth);

            ctx.globalAlpha = 1;
            globalIdx++;
            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },

    // ---- 7. WAVE ----
    {
      key: "wave",
      name: "Wave",
      description: "Active word bounces with wave motion",
      previewColors: ["#ffffff", "#FF9800"],
      defaults: {
        fontSize: 72,
        fontFamily: "Arial",
        fontColor: "#ffffff",
        highlightColor: "#FF9800",
        strokeColor: "#000000",
        strokeWidth: 8,
        backgroundColor: "",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth;

        ctx.font = "900 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var lines = splitIntoLines(groupWords);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.2;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;

        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var gIdx = getGlobalIndex(measured, li, wi);
            var wx = lx + line.widths[wi] / 2;
            var isActive = gIdx === activeWordIndex;
            var txt = line.words[wi].text.toUpperCase();

            var yOffset = 0;
            if (isActive) {
              yOffset = -Math.sin(activeProgress * Math.PI) * fontSize * 0.25;
            } else {
              var dist = Math.abs(gIdx - activeWordIndex);
              if (dist === 1 && activeWordIndex >= 0) {
                yOffset = -Math.sin(activeProgress * Math.PI) * fontSize * 0.1;
              }
            }

            drawBoldWord(ctx, txt, wx, ly + yOffset, isActive ? highlightColor : fontColor, strokeColor, strokeWidth);
            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },

    // ---- 8. SHADOW 3D ----
    {
      key: "shadow3d",
      name: "3D Shadow",
      description: "Active word gets colored 3D drop shadow effect",
      previewColors: ["#ffffff", "#E040FB"],
      defaults: {
        fontSize: 72,
        fontFamily: "Arial",
        fontColor: "#ffffff",
        highlightColor: "#E040FB",
        strokeColor: "#000000",
        strokeWidth: 8,
        backgroundColor: "",
      },
      render: function (ctx, groupWords, activeWordIndex, activeProgress, opts) {
        var x = opts.x, y = opts.y, fontSize = opts.fontSize, fontFamily = opts.fontFamily;
        var fontColor = opts.fontColor, highlightColor = opts.highlightColor;
        var strokeColor = opts.strokeColor, strokeWidth = opts.strokeWidth, scale = opts.scale;

        ctx.font = "900 " + fontSize + "px " + fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var lines = splitIntoLines(groupWords);
        var measured = measureLines(ctx, lines, fontSize);
        var lineH = fontSize * 1.2;
        var totalH = measured.length * lineH;
        var startY = y - totalH / 2 + lineH / 2;
        var shadowOff = Math.max(3, fontSize * 0.06);

        for (var li = 0; li < measured.length; li++) {
          var line = measured[li];
          var lx = x - line.totalWidth / 2;
          var ly = startY + li * lineH;

          for (var wi = 0; wi < line.words.length; wi++) {
            var gIdx = getGlobalIndex(measured, li, wi);
            var wx = lx + line.widths[wi] / 2;
            var isActive = gIdx === activeWordIndex;
            var txt = line.words[wi].text.toUpperCase();

            if (isActive) {
              // Colored 3D shadow layers
              var sOff = shadowOff * (0.5 + 0.5 * easeOutCubic(Math.min(activeProgress * 3, 1)));
              // Shadow layer (offset)
              drawBoldWord(ctx, txt, wx + sOff, ly + sOff, highlightColor, strokeColor, strokeWidth);
              // Main layer
              drawBoldWord(ctx, txt, wx, ly, "#ffffff", strokeColor, strokeWidth);
            } else {
              drawBoldWord(ctx, txt, wx, ly, fontColor, strokeColor, strokeWidth);
            }

            lx += line.widths[wi] + line.spacing;
          }
        }
      },
    },
  ];

  // ============================================
  // MAIN RENDER FUNCTION
  // ============================================

  /**
   * Render subtitle frame on the canvas context.
   * @param {CanvasRenderingContext2D} ctx - The canvas 2D context
   * @param {Object} clip - Subtitle clip data
   * @param {number} currentTime - Absolute timeline time (seconds)
   * @param {number} scaleRatio - Display scale ratio
   * @param {number} canvasWidth - Canvas width in pixels
   * @param {number} canvasHeight - Canvas height in pixels
   */
  function renderSubtitleFrame(ctx, clip, currentTime, scaleRatio, canvasWidth, canvasHeight) {
    const words = clip.words;
    if (!words || words.length === 0) return;

    const relativeTime = currentTime - clip.startTime;
    if (relativeTime < 0 || relativeTime > clip.duration) return;

    const { groupWords, activeWordIndex, activeProgress } = getActiveWordGroup(clip, relativeTime);
    if (groupWords.length === 0) return;

    // Find template
    const template = SUBTITLE_TEMPLATES.find((t) => t.key === clip.template) || SUBTITLE_TEMPLATES[0];

    // Calculate position
    const s = scaleRatio;
    const fontSize = (clip.fontSize || template.defaults.fontSize) * s;
    const posX = clip.position?.x != null ? clip.position.x * s : canvasWidth / 2;
    const posY = clip.position?.y != null ? clip.position.y * s : canvasHeight * 0.85;

    ctx.save();

    // Apply clip-level opacity
    if (clip.opacity != null && clip.opacity < 1) {
      ctx.globalAlpha = clip.opacity;
    }

    template.render(ctx, groupWords, activeWordIndex, activeProgress, {
      x: posX,
      y: posY,
      fontSize,
      fontFamily: clip.fontFamily || template.defaults.fontFamily,
      fontColor: clip.fontColor || template.defaults.fontColor,
      highlightColor: clip.highlightColor || template.defaults.highlightColor,
      strokeColor: clip.strokeColor || template.defaults.strokeColor,
      strokeWidth: (clip.strokeWidth != null ? clip.strokeWidth : template.defaults.strokeWidth) * s,
      backgroundColor: clip.backgroundColor || template.defaults.backgroundColor,
      scale: s,
    });

    ctx.restore();
  }

  // ============================================
  // EXPORTS
  // ============================================

  const SubtitleTemplates = {
    SUBTITLE_TEMPLATES,
    getActiveWordGroup,
    renderSubtitleFrame,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SubtitleTemplates;
  } else {
    global.SubtitleTemplates = SubtitleTemplates;
  }
})(typeof window !== "undefined" ? window : global);
