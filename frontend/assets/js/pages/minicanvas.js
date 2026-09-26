$(document).ready(function () {
  fabric.Object.prototype.toObject = (function (toObject) {
    return function (props) {
      props = (props || []).concat([
        "placeholderClass",
        "placeholderId",
        "originalPlaceholderId",
        "aspectRatio",
        "textCase",
      ]);
      return toObject.apply(this, [props]);
    };
  })(fabric.Object.prototype.toObject);

  let selectedTemplate;
  let ar;

  $("#mini-canvas-editor").on(
    "click",
    '[data-role="previewTemplate"]',
    async function () {
      const this_button = $(this);
      this_button.attr("disabled", "");
      if (!selectedTemplate) {
        showAlert("error", "No template selected");
        this_button.removeAttr("disabled");
        return;
      }
      const result = await window.electronAPI.textTemplate(selectedTemplate);
      if (result && result.success) {
        const imagePath = result.value;
        const $overlay = $('<div id="imagePreviewOverlay"></div>').css({
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          background: "rgba(0,0,0,0.8)",
          display: "flex",
          "justify-content": "center",
          "align-items": "center",
          "z-index": 9999,
          cursor: "pointer",
        });
        const $img = $("<img>").attr("src", imagePath).css({
          "max-width": "90%",
          "max-height": "90%",
          "box-shadow": "0 0 20px #fff",
          "border-radius": "8px",
          "object-fit": "contain",
        });
        $overlay.append($img);
        $("body").append($overlay);

        $overlay.on("click", function () {
          $overlay.remove();
        });
        this_button.removeAttr("disabled");
      } else {
        const errorMessage =
          (result && result.error) ||
          (result && result.value) ||
          "Failed to generate preview";
        showAlert("error", errorMessage);
        this_button.removeAttr("disabled");
      }
    },
  );

  $("#mini-canvas-editor").on("click", '[data-role="save"]', async function () {
    $(this).attr("disabled", "");
    const canvas = window.canvasList[Object.keys(window.canvasList)[0]];
    const placeholderObjects = canvas
      .getObjects()
      .filter((obj) => obj.placeholderClass === "placeholder-image");
    if (placeholderObjects.length === 0) {
      showAlert(
        "error",
        "You must add at least one placeholder image before saving.",
      );
      $(this).removeAttr("disabled");
      return;
    }
    // Use safe export that ignores current zoom (defined in editor.js)
    const pngDataURL = window.__miniCanvasExport
      ? window.__miniCanvasExport(canvas, { format: "png", quality: 1 })
      : canvas.toDataURL({ format: "png", quality: 1.0 });
    const jsonCanvas = canvas.toJSON(["width", "height"]);
    const masks = (await window.electronAPI.readKey("maskTemplates")) || [];
    if (!selectedTemplate) {
      const randID = Math.random().toString(36).substring(10, 17);
      const labelField = window.I18n?.t('common.label') || "Label";
      const result = await newPrompt([
        { type: "text", name: labelField, required: true },
      ]);
      if (!result) {
        $(this).removeAttr("disabled");
        return;
      }
      masks.push({
        id: randID,
        preview: pngDataURL,
        data: jsonCanvas,
        ar: ar,
        label: result[labelField],
        createdAt: new Date().toISOString(),
      });
      selectedTemplate = randID;
      
      // Log activity for new template
      await window.electronAPI.logActivity(
        "template",
        `Template "${result[labelField]}" created`,
        "template",
        randID
      );
    } else {
      const index = masks.findIndex((m) => m.id === selectedTemplate);
      if (index !== -1) {
        masks[index].preview = pngDataURL;
        masks[index].data = jsonCanvas;
      } else {
        masks.push({
          id: selectedTemplate,
          preview: pngDataURL,
          data: jsonCanvas,
        });
      }
    }
    await window.electronAPI.updateData("maskTemplates", masks);

    $(this).removeAttr("disabled");
    showAlert("success", "Canvas saved successfully");
  });

  $("#mini-canvas-container").on(
    "click",
    '[data-role="newTemplate"]',
    async function () {
      selectedTemplate = null;
      const aspectRatioField = window.I18n?.t('common.aspect_ratio') || "Aspect ratio (eg: 4:5)";
      const result = await newPrompt([
        { type: "text", name: aspectRatioField, required: true },
      ]);
      if (!result) return;
      const aspectRatio = result[aspectRatioField];
      if (!/^\d+:\d+$/.test(aspectRatio)) {
        showAlert(
          "error",
          "Aspect ratio must be in the format x:x (e.g., 4:5)",
        );
        return;
      }
      ar = aspectRatio;
      const [wRatio, hRatio] = aspectRatio.split(":").map(Number);
      const baseSize = 1000;
      let width = baseSize;
      let height = Math.round((baseSize * hRatio) / wRatio);
      if (height < 1000) {
        height = 1000;
        width = Math.round((baseSize * wRatio) / hRatio);
      }
      loadEditor(width, height);
      if (window.canvasList) {
        const canvas = window.canvasList[Object.keys(window.canvasList)[0]];
        canvas.clear();
      }
      $("#canvas-container").hide();
      const editor = $("#mini-canvas-editor");
      editor
        .css({
          display: "block",
          position: "relative",
          top: "-100%",
          opacity: 0,
        })
        .animate(
          {
            top: "0",
            opacity: 1,
          },
          300,
        );
    },
  );

  $("#mini-canvas-container").on(
    "click",
    '[data-role="edit-template"]',
    async function () {
      const id = $(this).attr("data-id");
      selectedTemplate = id;
      const maskTemplates = await window.electronAPI.readKey("maskTemplates");
      const template = maskTemplates?.find((t) => t.id === id);
      if (!template) return;

      const aspectRatio = template.ar || "1:1";
      const [wRatio, hRatio] = aspectRatio.split(":").map(Number);
      const baseSize = 1000;
      let width = baseSize;
      let height = Math.round((baseSize * hRatio) / wRatio);
      if (height < 1000) {
        height = 1000;
        width = Math.round((baseSize * wRatio) / hRatio);
      }

      loadEditor(width, height);
      const canvas = window.canvasList[Object.keys(window.canvasList)[0]];
      canvas.clear();

      if (template.data) {
        loadFontsFromJSON(template.data, function () {
          canvas.loadFromJSON(template.data, () => {
            const objects = canvas.getObjects();

            objects.forEach((obj) => {
              // Restore locked state
              if (obj.locked) {
                obj.set({
                  lockMovementX: true,
                  lockMovementY: true,
                  lockScalingX: true,
                  lockScalingY: true,
                  lockRotation: true,
                  hasControls: false,
                  hasBorders: false,
                  selectable: true,
                  evented: true,
                });
              }

              // placeholders (images)
              if (obj.placeholderClass === "placeholder-image") {
                obj.lockUniScaling = true;
                obj.setControlsVisibility({
                  mt: false,
                  mr: false,
                  mb: false,
                  ml: false,
                  bl: true,
                  br: true,
                  tl: true,
                  tr: true,
                });
                obj.lockRotation = true;
                obj.hasRotatingPoint = false;
              }

              // linked text: reapply locks & linking
              if (obj.type === "i-text" && obj.parent) {
                const rect = objects.find((o) => o.id === obj.parent);
                if (rect) {
                  // Restore the linking properties if not already set
                  if (!obj.id) {
                    obj.id = Date.now() + Math.random();
                  }
                  if (!rect.linkedTextId) {
                    rect.linkedTextId = obj.id;
                  }
                  if (!obj.linkedRectId) {
                    obj.linkedRectId = obj.id;
                  }

                  obj.set({
                    lockMovementX: true,
                    lockMovementY: true,
                    lockScalingX: true,
                    lockScalingY: true,
                    lockRotation: true,
                    selectable: true,
                    editable: true,
                  });

                  obj.setControlsVisibility({
                    mt: false,
                    mb: false,
                    ml: false,
                    mr: false,
                    tl: false,
                    tr: false,
                    bl: false,
                    br: false,
                    mtr: false,
                  });

                  function updateTextPosition() {
                    obj.set({
                      left: rect.left + (rect.width * rect.scaleX) / 2,
                      top: rect.top + (rect.height * rect.scaleY) / 2,
                    });
                    obj.setCoords();
                    canvas.requestRenderAll();
                  }

                  rect.on("moving", updateTextPosition);
                  rect.on("scaling", updateTextPosition);
                  rect.on("modified", updateTextPosition);
                  updateTextPosition();
                }
              }
            });

            canvas.renderAll();

            // Reset history after loading template to prevent undo button from being enabled
            // This clears any states saved during template loading and sets current state as initial
            if (window.__resetMiniCanvasHistory) {
              window.__resetMiniCanvasHistory();
            }
          });
        });
      }

      $("#canvas-container").hide();
      const editor = $("#mini-canvas-editor");
      editor
        .css({
          display: "block",
          position: "relative",
          top: "-100%",
          opacity: 0,
        })
        .animate(
          {
            top: "0",
            opacity: 1,
          },
          300,
        );
    },
  );

  function loadFontsFromJSON(jsonData, callback) {
    var parsed = typeof jsonData === "string" ? JSON.parse(jsonData) : jsonData;
    var fontFamilies = [];
    var fontTextMap = {};
    if (parsed.objects) {
      parsed.objects.forEach(function (obj) {
        if (obj.type === "i-text" && obj.fontFamily) {
          fontFamilies.push(obj.fontFamily);
          fontTextMap[obj.fontFamily] =
            (fontTextMap[obj.fontFamily] || "") + (obj.text || "");
        }
      });
    }
    if (fontFamilies.length === 0) {
      if (typeof callback === "function") callback();
      return;
    }
    fontFamilies = [...new Set(fontFamilies)];
    var loadedCount = 0;
    fontFamilies.forEach(function (fontFamily) {
      var url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}&display=swap`;
      if (!$(`link[href="${url}"]`).length) {
        $("<link>", {
          rel: "stylesheet",
          href: url,
        }).appendTo("head");
      }
      var font = new FontFaceObserver(fontFamily);
      // Pass the template's actual text so latin-ext glyphs (ă, ș, ț, etc.) are
      // fetched before the canvas renders, preventing smaller fallback glyphs.
      var sampleText = fontTextMap[fontFamily] || undefined;
      font.load(sampleText).then(function () {
        loadedCount++;
        if (
          loadedCount === fontFamilies.length &&
          typeof callback === "function"
        ) {
          callback();
        }
      }).catch(function () {
        loadedCount++;
        if (
          loadedCount === fontFamilies.length &&
          typeof callback === "function"
        ) {
          callback();
        }
      });
    });
  }

  $("#mini-canvas-container").on(
    "click",
    '[data-role="delete-template"]',
    async function () {
      const id = $(this).attr("data-id");
      const confirm = await confirmPrompt();
      if (confirm) {
        const maskTemplates =
          (await window.electronAPI.readKey("maskTemplates")) || [];
        const templateToDelete = maskTemplates.find((t) => t.id === id);
        const templateName = templateToDelete?.label || 'Unknown';
        const updatedTemplates = maskTemplates.filter((t) => t.id !== id);
        await window.electronAPI.updateData("maskTemplates", updatedTemplates);
        
        // Log activity for template deletion
        await window.electronAPI.logActivity(
          "delete",
          `Template "${templateName}" deleted`,
          "template",
          id
        );
        
        updateTemplates();
      }
    },
  );

  // Export single template
  $("#mini-canvas-container").on(
    "click",
    '[data-role="export-template"]',
    async function () {
      const id = $(this).attr("data-id");
      const maskTemplates =
        (await window.electronAPI.readKey("maskTemplates")) || [];
      const template = maskTemplates.find((t) => t.id === id);

      if (!template) {
        showAlert("error", "Template not found");
        return;
      }

      const result = await window.electronAPI.exportTemplateFile(
        template,
        template.label,
      );

      if (result.success) {
        showAlert("success", "Template exported successfully!");
      } else if (!result.message || !result.message.includes("canceled")) {
        showAlert("error", result.error || "Failed to export template");
      }
    },
  );

  // Export all templates
  $("#mini-canvas-container").on(
    "click",
    '[data-role="exportAllTemplates"]',
    async function () {
      const maskTemplates =
        (await window.electronAPI.readKey("maskTemplates")) || [];

      if (maskTemplates.length === 0) {
        showAlert("error", "No templates to export");
        return;
      }

      const result =
        await window.electronAPI.exportAllTemplatesFile(maskTemplates);

      if (result.success) {
        showAlert(
          "success",
          `${result.count} template(s) exported successfully!`,
        );
      } else if (!result.message || !result.message.includes("canceled")) {
        showAlert("error", result.error || "Failed to export templates");
      }
    },
  );

  // Import templates
  $("#mini-canvas-container").on(
    "click",
    '[data-role="importTemplates"]',
    async function () {
      const result = await window.electronAPI.importTemplateFile();

      if (!result.success) {
        if (!result.message || !result.message.includes("canceled")) {
          showAlert("error", result.error || "Failed to import templates");
        }
        return;
      }

      const importedTemplates = result.templates;
      const maskTemplates =
        (await window.electronAPI.readKey("maskTemplates")) || [];

      // Handle ID conflicts by generating new IDs for duplicates
      let importedCount = 0;
      let skippedCount = 0;

      for (const template of importedTemplates) {
        const existingTemplate = maskTemplates.find(
          (t) => t.id === template.id,
        );

        if (existingTemplate) {
          // Generate new ID for duplicate
          const newId = Math.random().toString(36).substring(10, 17);
          template.id = newId;
          template.label = `${template.label} (imported)`;
        }

        maskTemplates.push(template);
        importedCount++;
      }

      await window.electronAPI.updateData("maskTemplates", maskTemplates);
      updateTemplates();

      showAlert(
        "success",
        `Successfully imported ${importedCount} template(s)!`,
      );
    },
  );

  $("#mini-canvas-container").on("click", '[data-role="return"]', function () {
    $("#canvas-container").show();
    updateTemplates();
    const editor = $("#mini-canvas-editor");
    editor.animate(
      {
        top: "-100%",
        opacity: 0,
      },
      300,
      function () {
        editor.hide();
      },
    );
  });

  updateTemplates();
  let prevMasksHash;
  async function updateTemplates() {
    const maskTemplates =
      (await window.electronAPI.readKey("maskTemplates")) || [];
    if (maskTemplates.length == 0) {
      $("#mini-canvas-container .templates").html(`
                <div class="empty-state">
                    <div class="empty-state-icon">
                        <i class="material-icons">dashboard_customize</i>
                    </div>
                    <div class="empty-state-title">No templates yet</div>
                    <div class="empty-state-text">Click <strong>"New Template"</strong> to create your first visual template</div>
                </div>
            `);
    } else {
      const currentHash = JSON.stringify(maskTemplates);
      if (currentHash != prevMasksHash) {
        prevMasksHash = currentHash;
        $("#mini-canvas-container .templates").html("");
        for (let i = maskTemplates.length - 1; i >= 0; i--) {
          $("#mini-canvas-container .templates").append(`<div class="template">
                        <div class="buttons">
                            <button data-role="edit-template" data-id="${maskTemplates[i]["id"]}" class="btn" title="Edit Template">
                                <i class="material-icons">edit</i>
                            </button>
                            <button data-role="export-template" data-id="${maskTemplates[i]["id"]}" class="btn btn-success" title="Export Template">
                                <i class="material-icons">download</i>
                            </button>
                            <button data-role="delete-template" data-id="${maskTemplates[i]["id"]}" class="btn" title="Delete Template">
                                <i class="material-icons">delete</i>
                            </button>
                        </div>
                        <div class="template-content">
                            <img src="${maskTemplates[i]["preview"]}">
                            <span>${maskTemplates[i]["label"]} (ar: ${maskTemplates[i]["ar"]})</span>
                        </div>
                    </div>`);
        }
      }
    }
  }

  // Set cleanup function for this page
  window.currentPageCleanup = () => {
    // Clear fabric.js canvases
    if (window.canvasList) {
      Object.keys(window.canvasList).forEach((key) => {
        try {
          window.canvasList[key].dispose();
        } catch (err) {
          console.warn("Error disposing canvas:", err);
        }
      });
      window.canvasList = {};
    }

    // Clear minicanvas state
    selectedTemplate = null;
    ar = null;
    prevMasksHash = null;

    // Clear event handlers
    $("#mini-canvas-container").off();
    $("#mini-canvas-editor").off();

    // Remove any preview overlays
    $("#imagePreviewOverlay").remove();
  };
});
