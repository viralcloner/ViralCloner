const { readKey, findChromeExe } = require("../lib/utils");
const puppeteer = require('puppeteer');
const path = require("path");
const { app } = require('electron');
const fs = require("fs/promises");

// Timeout management removed - this node can take variable time for complex
// rendering operations and should not be artificially constrained

async function fabricJsonToBase64Image(fabricJson) {
    const browser = await puppeteer.launch({
        executablePath: findChromeExe(),
        headless: "new",
        args: [
            '--force-device-scale-factor=1',
            '--allow-file-access-from-files',
            '--disable-web-security',
            '--allow-file-access'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });

    const fontFamilies = Array.from(new Set(
        (fabricJson.objects || [])
            .filter(obj => obj.type === 'i-text' && obj.fontFamily)
            .map(obj => obj.fontFamily)
    ));

    const fontLinks = fontFamilies.map(f =>
        `<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}&display=swap" rel="stylesheet">`
    ).join('\n');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js"></script>
        <style>body,html { margin:0; padding:0; }</style>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        ${fontLinks}
    </head>
    <body>
        <canvas id="canvas"></canvas>
        <script>
        async function loadGoogleFont(fontFamily, sampleText) {
            return new Promise(resolve => {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(fontFamily) + "&display=swap";
                document.head.appendChild(link);
                // Pass the actual text so the browser fetches every glyph subset it
                // needs (e.g. latin-ext for accented chars like a-breve / s-comma).
                // Without the text argument document.fonts.load resolves after only
                // the default latin subset loads, leaving accented glyphs to fall
                // back to a smaller default-font glyph.
                const sample = (sampleText && sampleText.length) ? sampleText : "ABCabc";
                Promise.all([
                    document.fonts.load("16px '" + fontFamily + "'", sample),
                    document.fonts.load("bold 16px '" + fontFamily + "'", sample)
                ]).then(() => resolve()).catch(() => resolve());
            });
        }

        function wrapText(ctx, text, maxWidth, fontSize, fontFamily) {
            ctx.font = fontSize + "px " + fontFamily;
            const words = text.split(' ');
            let line = '';
            const lines = [];

            for (let n = 0; n < words.length; n++) {
                const testLine = line + words[n] + ' ';
                const metrics = ctx.measureText(testLine);
                if (metrics.width > maxWidth && n > 0) {
                    lines.push(line);
                    line = words[n] + ' ';
                } else {
                    line = testLine;
                }
            }
            lines.push(line);
            return lines.join('\\n');
        }

        (async () => {
            try {
                const fabricJson = ${JSON.stringify(fabricJson)};
                const canvasEl = document.getElementById('canvas');

                const fontFamilies = new Set();
                if (fabricJson.objects) {
                    fabricJson.objects.forEach(obj => {
                        if (obj.type === 'i-text' && obj.fontFamily) fontFamilies.add(obj.fontFamily);
                    });
                }

                // Collect the combined text per font family so each font's glyph
                // subsets (incl. latin-ext) are fully fetched before rendering.
                const fontTextMap = {};
                if (fabricJson.objects) {
                    fabricJson.objects.forEach(obj => {
                        if (obj.type === 'i-text' && obj.fontFamily) {
                            fontTextMap[obj.fontFamily] = (fontTextMap[obj.fontFamily] || "") + (obj.text || "");
                        }
                    });
                }

                await Promise.all(Array.from(fontFamilies).map(f => loadGoogleFont(f, fontTextMap[f]).catch(() => {})));
                // Wait until all font faces (including lazily-loaded subsets) are ready.
                if (document.fonts && document.fonts.ready) {
                    await document.fonts.ready.catch(() => {});
                }


                let width = fabricJson.width || 1200;
                let height = fabricJson.height || 1200;
                const minDim = 1200;
                const aspectRatio = width / height;
                if (width < minDim || height < minDim) {
                    if (aspectRatio >= 1) {
                        width = minDim;
                        height = Math.round(minDim / aspectRatio);
                    } else {
                        height = minDim;
                        width = Math.round(minDim * aspectRatio);
                    }
                }

                canvasEl.width = width;
                canvasEl.height = height;

                const canvas = new fabric.StaticCanvas('canvas', {
                    width,
                    height,
                    enableRetinaScaling: false,
                    preserveObjectStacking: true,
                });

                fabricJson.objects = fabricJson.objects || [];
                const originalWidth = fabricJson.width || width;
                const originalHeight = fabricJson.height || height;
                const scaleX = width / originalWidth;
                const scaleY = height / originalHeight;

                fabricJson.objects.forEach(obj => {
                    // Apply global canvas scaling to object transforms
                    obj.scaleX = obj.scaleX ? obj.scaleX * scaleX : scaleX;
                    obj.scaleY = obj.scaleY ? obj.scaleY * scaleY : scaleY;
                    if (obj.left) obj.left *= scaleX;
                    if (obj.top) obj.top *= scaleY;

                    // If this object is a placeholder image awaiting natural dimension
                    // recalculation (we stored desired display size before loading the
                    // real image), also scale that desired size so later recomputation
                    // preserves the same relative size as other objects.
                    if (obj._desiredWidth && obj._desiredHeight) {
                        obj._desiredWidth *= scaleX;
                        obj._desiredHeight *= scaleY;
                    }
                });
                fabricJson.width = width;
                fabricJson.height = height;

                canvas.loadFromJSON(fabricJson, async () => {
                    canvas.renderAll();
                    canvas.calcOffset();
                    const objects = canvas.getObjects();

                    // Recalculate scales for replaced placeholder images
                    objects.forEach(obj => {
                        if (obj.placeholderClass === "placeholder-image" && obj._desiredWidth && obj._desiredHeight) {
                            const imgElement = obj.getElement();
                            if (imgElement) {
                                const naturalWidth = imgElement.naturalWidth || imgElement.width || 1;
                                const naturalHeight = imgElement.naturalHeight || imgElement.height || 1;

                                // A rounded-corner clipPath (border radius) was created in
                                // the editor sized to the ORIGINAL placeholder image's
                                // dimensions. The swapped-in image usually has different
                                // natural dimensions, so resize the clipPath to match the
                                // new image and rescale its corner radius proportionally so
                                // the rounded corners stay aligned with the image edges.
                                if (obj.clipPath && (obj.clipPath.rx || obj.clipPath.ry)) {
                                    const oldClipWidth = obj.clipPath.width || naturalWidth;
                                    const oldClipHeight = obj.clipPath.height || naturalHeight;
                                    obj.clipPath.set({
                                        width: naturalWidth,
                                        height: naturalHeight,
                                        rx: (obj.clipPath.rx || 0) * (naturalWidth / oldClipWidth),
                                        ry: (obj.clipPath.ry || 0) * (naturalHeight / oldClipHeight)
                                    });
                                    if (typeof obj.clipPath.setCoords === 'function') obj.clipPath.setCoords();
                                }

                                // Recalculate scale to maintain placeholder's visual size
                                obj.set({
                                    width: naturalWidth,
                                    height: naturalHeight,
                                    scaleX: obj._desiredWidth / naturalWidth,
                                    scaleY: obj._desiredHeight / naturalHeight
                                });
                                obj.dirty = true;

                                delete obj._desiredWidth;
                                delete obj._desiredHeight;
                            }
                        }
                    });
                    const measure = document.createElement('canvas');
                    const mctx = measure.getContext('2d');

                    function getBounding(parent) {
                        return parent.getBoundingRect(true);
                    }

                    function setMeasureSize(pxWidth, pxHeight) {
                        const ratio = window.devicePixelRatio || 1;
                        measure.width = Math.max(1, Math.ceil(pxWidth * ratio));
                        measure.height = Math.max(1, Math.ceil(pxHeight * ratio));
                        mctx.setTransform(ratio, 0, 0, ratio, 0, 0);
                    }

                    function wrapLinesWithCtx(paragraphs, fontSize, fontFamily, fontStyle, fontWeight, maxWidth) {
                        mctx.font = (fontStyle || '') + ' ' + (fontWeight || '') + ' ' + fontSize + 'px "' + fontFamily + '"';
                        const out = [];
                        for (const p of paragraphs) {
                            if (!p) {
                                out.push('');
                                continue;
                            }
                            const words = p.split(' ');
                            let line = '';
                            for (let w of words) {
                                const test = line ? (line + ' ' + w) : w;
                                const width = mctx.measureText(test).width;
                                if (width <= maxWidth) {
                                    line = test;
                                } else {
                                    if (!line) {
                                        let chunk = '';
                                        for (let ch of w) {
                                            const t = chunk + ch;
                                            if (mctx.measureText(t).width <= maxWidth) {
                                                chunk = t;
                                            } else {
                                                if (chunk) out.push(chunk);
                                                chunk = ch;
                                            }
                                        }
                                        line = chunk;
                                    } else {
                                        out.push(line);
                                        line = w;
                                    }
                                }
                            }
                            if (line) out.push(line);
                        }
                        return out;
                    }

                    function trial(paragraphs, fontSize, fontFamily, fontStyle, fontWeight, maxWidth, maxHeight, lineHeight) {
                        const lines = wrapLinesWithCtx(paragraphs, fontSize, fontFamily, fontStyle, fontWeight, maxWidth);
                        const height = lines.length * fontSize * lineHeight;
                        return { fits: height <= maxHeight, lines, height };
                    }

                    function waitForFont(fontName, timeout = 3000) {
                        if (document.fonts && typeof document.fonts.load === 'function') {
                            return Promise.race([
                                document.fonts.load('16px "' + fontName + '"'),

                                new Promise(res => setTimeout(res, timeout))
                            ]);
                        } else {
                            return new Promise(res => setTimeout(res, timeout));
                        }
                    }

                    const fontSet = new Set();
                    for (const o of objects) {
                        if (o.type === 'i-text') {
                            const f = o.fontFamily || 'Arial';
                            fontSet.add(f);
                        }
                    }
                    const fontPromises = Array.from(fontSet).map(f => waitForFont(f, 4000));
                    await Promise.all(fontPromises);

                    for (let obj of objects) {
                        if (obj.type === 'i-text' && obj.parent) {
                            const parent = objects.find(o => o.id === obj.parent);
                            if (!parent) continue;

                            const pad = (obj.padding || 10) || 10;
                            const bound = getBounding(parent);
                            const rawMaxWidth = Math.max(1, bound.width - pad * 2);
                            const rawMaxHeight = Math.max(1, bound.height - pad * 2);

                            const canvasZoom = (typeof canvas.getZoom === 'function') ? canvas.getZoom() : 1;
                            const objScaleX = obj.scaleX || 1;
                            const objScaleY = obj.scaleY || 1;

                            const measureWidthForFont = Math.max(1, rawMaxWidth / (objScaleX * canvasZoom));
                            const measureHeightForFont = Math.max(1, rawMaxHeight / (objScaleY * canvasZoom));

                            setMeasureSize(measureWidthForFont, measureHeightForFont);

                            const initial = Math.round(obj.fontSize || 40);
                            const minSize = 6;
                            const lineHeight = obj.lineHeight || 1.16;
                            const fontFamily = obj.fontFamily || 'Arial';
                            const fontStyle = obj.fontStyle || 'normal';
                            const fontWeight = obj.fontWeight || 'normal';
                            const paragraphs = (obj.text || '').split('\\n');

                            let low = minSize;
                            let high = Math.max(initial, minSize);
                            let best = minSize;
                            let bestRes = trial(paragraphs, best, fontFamily, fontStyle, fontWeight, measureWidthForFont, measureHeightForFont, lineHeight);

                            while (low <= high) {
                                const mid = Math.floor((low + high) / 2);
                                const res = trial(paragraphs, mid, fontFamily, fontStyle, fontWeight, measureWidthForFont, measureHeightForFont, lineHeight);
                                if (res.fits) {
                                    best = mid;
                                    bestRes = res;
                                    low = mid + 1;
                                } else {
                                    high = mid - 1;
                                }
                            }

                            let finalFont = best;
                            let finalLines = bestRes.lines;
                            const maxLines = Math.max(1, Math.floor(measureHeightForFont / (finalFont * lineHeight)));
                            if (finalLines.length > maxLines) {
                                finalLines = finalLines.slice(0, maxLines);
                                let last = finalLines[finalLines.length - 1];
                                if (last.length > 3) last = last.slice(0, -3) + '...';
                                else last = last + '...';
                                finalLines[finalLines.length - 1] = last;
                            }

                            const finalText = finalLines.join('\\n');
                            const parentCenter = parent.getCenterPoint();

                            obj.set({
                                text: finalText,
                                fontSize: finalFont,
                                lineHeight: lineHeight,
                                fontFamily: fontFamily,
                                fontStyle: fontStyle,
                                fontWeight: fontWeight,
                                originX: 'center',
                                originY: 'center',
                                left: parentCenter.x,
                                top: parentCenter.y,
                                textAlign: obj.textAlign || 'center',
                                width: Math.max(1, measureWidthForFont),
                                angle: parent.angle || 0
                            });

                            obj.setCoords();
                        }
                    }

                    function setMeasureFont(fontSize, fontFamily, fontStyle, fontWeight) {
                        const style = fontStyle && fontStyle !== 'normal' ? fontStyle + ' ' : '';
                        const weight = fontWeight && fontWeight !== 'normal' ? fontWeight + ' ' : '';
                        mctx.font = style + weight + fontSize + 'px "' + (fontFamily || 'Arial') + '"';
                    }


                    canvas.getObjects().forEach(obj => {
                        if (!obj.iscenter || obj.type !== 'i-text') return;

                        const canvasWidth = canvas.getWidth();
                        const padding = 10;
                        const minLeft = 5;
                        const maxTextWidth = Math.max(1, canvasWidth - padding * 2);

                        let fontSize = Math.round(obj.fontSize || 40);
                        const rawText = typeof obj.text === 'string' ? obj.text : String(obj.text || '');

                        setMeasureFont(fontSize, obj.fontFamily, obj.fontStyle, obj.fontWeight);
                        let textWidth = Math.max(1, mctx.measureText(rawText).width);

                        if (textWidth > maxTextWidth) {
                            const scaled = fontSize * (maxTextWidth / textWidth);
                            fontSize = Math.max(6, Math.floor(scaled));
                            obj.set('fontSize', fontSize);
                            setMeasureFont(fontSize, obj.fontFamily, obj.fontStyle, obj.fontWeight);
                            textWidth = Math.max(1, mctx.measureText(rawText).width);
                        }

                        const effectiveWidth = textWidth * (obj.scaleX || 1);

                        if (effectiveWidth <= maxTextWidth) {
                            obj.set({
                                originX: 'center',
                                left: Math.round(canvasWidth / 2),
                                textAlign: 'center'
                            });
                        } else {
                            obj.set({
                                originX: 'left',
                                left: minLeft,
                                textAlign: 'left'
                            });
                        }

                        obj.setCoords();
                    });

                    canvas.renderAll();
                    window.__fabricImageBase64 = canvas.toDataURL('image/png');
                });

            } catch (err) {
                console.error("Failed to render canvas", err);
                window.__fabricImageBase64 = null;
            }
        })();
        </script>
    </body>
    </html>`;

    const tempHtmlPath = path.join(app.getPath('temp'), `temp_canvas_${Date.now()}.html`);
    await fs.writeFile(tempHtmlPath, html);
    await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'load' });

    const base64 = await page.evaluate(() => {
        return new Promise(resolve => {
            (function waitForBase64() {
                if (window.__fabricImageBase64 !== undefined) resolve(window.__fabricImageBase64);
                else setTimeout(waitForBase64, 50);
            })();
        });
    });
    await browser.close();

    if (!base64) throw new Error('Failed to generate image');
    return base64.replace(/^data:image\/png;base64,/, '');
}

async function saveFabricImage(fabricJson) {
    const base64Data = await fabricJsonToBase64Image(fabricJson);
    const outputDir = path.join(app.getPath("userData"), "Uploads", "Temp");
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `canvas_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
    const outputPath = path.join(outputDir, fileName);
    await fs.writeFile(outputPath, base64Data, 'base64');
    return outputPath;
}

async function imageToBase64(filePath) {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).substring(1).toLowerCase();
    return `data:image/${ext};base64,${data.toString('base64')}`;
}

async function generateImageIndexMap(images) {
    const imageIndexMap = {};
    await Promise.all(images.map(async (imgPath, index) => {
        try {
            const base64 = await imageToBase64(imgPath);
            imageIndexMap[`placehold_${index + 1}`] = base64;
        } catch { }
    }));
    return imageIndexMap;
}

async function miniCanvas(images, templateId, inputs) {
    if (!templateId || typeof templateId !== 'string') return { success: false, value: "Template id is required" };

    const maskTemplates = await readKey('maskTemplates');
    if (!maskTemplates || !Array.isArray(maskTemplates)) return { success: false, value: "No maskTemplates found" };

    const template = maskTemplates.find(t => t.id === templateId);
    if (!template) return { success: false, value: `Template with id "${templateId}" not found` };

    try {
        let fabricJson = typeof template.data === "string" ? JSON.parse(template.data) : template.data;
        const imageIndexMap = await generateImageIndexMap(images);

        fabricJson.objects = fabricJson.objects || [];

        fabricJson.objects = fabricJson.objects.map(obj => {
            if (obj.placeholderClass === "placeholder-image" && obj.placeholderId && imageIndexMap[obj.placeholderId]) {
                // Preserve the placeholder's visual size (bounding box)
                const desiredWidth = (obj.width || 1) * (obj.scaleX || 1);
                const desiredHeight = (obj.height || 1) * (obj.scaleY || 1);

                return {
                    ...obj,
                    src: imageIndexMap[obj.placeholderId],
                    // Remove width/height so fabric uses actual image dimensions
                    width: undefined,
                    height: undefined,
                    // Store desired size for recalculation after load
                    _desiredWidth: desiredWidth,
                    _desiredHeight: desiredHeight
                };
            }
            return obj;
        });

        const { input_2 = "", input_3 = "", input_4 = "", input_5 = "" } = inputs;
        fabricJson.objects = fabricJson.objects.map(obj => {
            if (obj.type === 'i-text' && obj.text && typeof obj.text === 'string') {
                let newText = obj.text.replace(/\{INPUT_2\}/gi, input_2)
                    .replace(/\{INPUT_3\}/gi, input_3)
                    .replace(/\{INPUT_4\}/gi, input_4)
                    .replace(/\{INPUT_5\}/gi, input_5);
                // Enforce a forced letter case (set in the editor) AFTER placeholder
                // substitution so substituted input text is also cased correctly.
                if (obj.textCase === 'upper') {
                    newText = newText.toLocaleUpperCase();
                } else if (obj.textCase === 'lower') {
                    newText = newText.toLocaleLowerCase();
                }
                return { ...obj, text: newText };
            }
            return obj;
        });

        fabricJson.objects = fabricJson.objects.map(obj => {
            if (obj.id) {
                return {
                    ...obj,
                    stroke: null,
                    strokeWidth: 0,
                    strokeDashArray: null
                };
            }
            return obj;
        });

        const pngPath = await saveFabricImage(fabricJson);
        return { success: true, value: pngPath };

    } catch (error) {
        return { success: false, value: error.message };
    }
}

module.exports = { miniCanvas };