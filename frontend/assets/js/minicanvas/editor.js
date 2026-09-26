function loadEditor(dimWidth, dimHeight) {

    fabric.Object.prototype.toObject = (function (original) {
        return function (propertiesToInclude) {
            propertiesToInclude = propertiesToInclude || [];
            propertiesToInclude.push('iscenter');
            propertiesToInclude.push('parent');
            propertiesToInclude.push('id');
            propertiesToInclude.push('placeholderClass');
            propertiesToInclude.push('placeholderId');
            propertiesToInclude.push('aspectRatio');
            propertiesToInclude.push('locked');
            propertiesToInclude.push('linkedTextId');
            propertiesToInclude.push('linkedRectId');
            return original.call(this, propertiesToInclude);
        };
    })(fabric.Object.prototype.toObject);

    var mainContainerID = Math.random().toString(36).substring(10, 17);
    var tempContainer = $(`<div id='${mainContainerID}'></div>`);
    $("#mini-canvas-editor").html(tempContainer);
    tempContainer.css({
        "overflow-y": "auto",
        "height": "100vh",
        "padding-bottom": "150px"
    });
    var ar = getAspectRatio(dimWidth, dimHeight);
    var x_ar = ar[0];
    var y_ar = ar[1];
    // Zoom percent (10 - 300). We visually scale each editor container with CSS transform
    // so the canvas remains inside its parent; internal coordinates stay at 100% scale,
    // avoiding side effects on export or stored object data.
    var currentZoom = 100;
    function applyZoom(percent) {
        if (percent < 10) percent = 10;
        if (percent > 300) percent = 300;
        currentZoom = percent;
        const factor = percent / 100;
        $(".resizer .percentage").text(percent + "%");

        $('.editor-container').each(function(){
            const container = $(this);
            const wrapper = container.children('.editor-zoom-wrapper');
            if(!wrapper.length) return;
            
            // Capture base (unscaled) dimensions once
            if(!container.data('baseW') || !container.data('baseH')) {
                container.data('baseW', wrapper.outerWidth());
                container.data('baseH', wrapper.outerHeight());
            }
            const baseW = container.data('baseW');
            const baseH = container.data('baseH');

            // Resize container to accommodate scaled content for proper scrolling
            const scaledW = Math.ceil(baseW * factor);
            const scaledH = Math.ceil(baseH * factor);
            container.css({
                width: scaledW + 'px',
                height: scaledH + 'px',
                position: 'relative',
                overflow: 'visible'
            });

            // Scale wrapper with pure CSS transform
            wrapper.css({
                position: 'absolute',
                top: 0,
                left: 0,
                width: baseW + 'px',
                height: baseH + 'px',
                transform: `scale(${factor})`,
                transformOrigin: 'top left'
            });
        });
    }
    // Safe export utility: returns dataURL at 1:1 (no internal zoom, just pure CSS scaling)
    window.__miniCanvasExport = function (c, opts = {}) {
        if (!c) return null;
        return c.toDataURL(Object.assign({ format: 'png', quality: 1 }, opts));
    }
    window.canvasList = {}
    var historyMap = {}
    var guidesMap = {} // Store guides per canvas
    var selectedCanvas;
    var colorElement;
    var draggedELM;
    var clonedELM;
    var inputTimeout;
    var clipboard = null; // Global clipboard for copy/paste
    var scalingELM;
    var selectedItem;
    var headerbarClicked = false;
    var sideContainerJustOpened = false; // Flag to prevent immediate closing
    var brushOptions = {
        "pen": { width: 1, color: "#ff4242", opacity: 1 },
        "marker": { width: 10, color: "#2254fa", opacity: 1 },
        "highlighter": { width: 30, color: "#fff151", opacity: 0.5 },
        "eraser": { width: 10, color: null, opacity: null }
    };
    var selectedBrush = "pen";
    var drawingCircle = new fabric.Circle({
        radius: 10,
        fill: 'transparent',
        stroke: 'black',
        strokeWidth: 4,
        left: -2000,
        top: -2000,
        erasable: false,
        visible: false,
        selectable: false,
        isTemporary: true,
        evented: false,
    });

    tempContainer.prepend(`<header>
        <div class="right">
            <button data-role="return" class="btn btn-primary"><i class="material-icons">arrow_back_ios</i> ${window.I18n?.t('minicanvas.editor.return') || 'Return'}</button>
        </div>
        <div class="center">
            <button data-role="undo" class="btn" title="${window.I18n?.t('minicanvas.editor.undo') || 'Undo'} (Ctrl+Z)"><i class="material-icons">undo</i></button>
            <button data-role="redo" class="btn" title="${window.I18n?.t('minicanvas.editor.redo') || 'Redo'} (Ctrl+Y)"><i class="material-icons">redo</i></button>
        </div>
        <div class="right">
            <button data-role="previewTemplate" class="btn btn-dark"><i class="material-icons">preview</i> ${window.I18n?.t('minicanvas.editor.preview') || 'Preview'}</button>
            <button data-role="save" class="btn btn-success" title="${window.I18n?.t('minicanvas.editor.save') || 'Save'} (Ctrl+S)"><i class="material-icons">save</i> ${window.I18n?.t('minicanvas.editor.save') || 'Save'}</button>
        </div>
    </header>
    <div class="header-bar-container"></div>
    <div class="canvas-body">
        <div class="sidebar">
            <button data-role="input" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.image_input') || 'Image input'}"><i class="material-icons">input</i></button>
            <button data-role="textinput" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.text_input') || 'Text input'}"><i class="material-icons">text_fields_alt</i></button>
            <button data-role="frames" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.frames') || 'Frames'}"><i class="material-icons">crop_free</i></button>
            <button data-role="shapes" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.shapes') || 'Shapes'}"><i class="material-icons">shapes</i></button>
            <button data-role="graphics" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.graphics') || 'Graphics'}"><i class="material-icons">data_thresholding</i></button>
            <button data-role="photos" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.photos') || 'Photos'}"><i class="material-icons">photo_camera_back</i></button>
            <button data-role="text" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.text') || 'Text'}"><i class="material-icons">text_format</i></button>
            <button data-role="upload" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.upload') || 'Upload'}"><i class="material-icons">upload</i></button>
            <button data-role="ai-generate" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.ai_generate') || 'AI Generate'}"><i class="material-icons">auto_awesome</i></button>
            <button data-role="tools" class="btn" tooltip="${window.I18n?.t('minicanvas.editor.tools') || 'Tools'}"><i class="material-icons">draw</i></button>
        </div>
        <div class="side-container">
            <div class="section-top">
                <div class="title"></div>
                <button closeSection class="btn"><i class="material-icons">close</i></button>
                <button closeSection class="btn right-close"><i class="material-icons">close</i></button>
            </div>
            <div class="section-content"></div>
        </div>
        <div class="popup">
            <div class="section-top">
                <div class="title"></div>
                <button closeSection class="btn"><i class="material-icons">close</i></button>
            </div>
            <div class="section-content"></div>
        </div>
        <div class="bottom-bar">
            <div class="resizer">
                <div range class="range"></div>
                <span class="percentage">100%</span>
            </div>
        </div>
        <div class="content"></div>
    </div>
    <div id="objectDimentions"></div>`);

    $(".resizer .range").range(10, 300, 100, function (val) { applyZoom(val); });

    tempContainer.on("click", "[closeSection]", function () {
        closeSideSection($(this).closest(".popup").length > 0);
    });

    document.addEventListener('wheel', function (e) {
        if (e.ctrlKey) {
            e.preventDefault();
            const next = currentZoom + (e.deltaY < 0 ? 10 : -10);
            applyZoom(next);
            $(".resizer .range").changeRange(currentZoom);
        }
    }, { passive: false });

    newEditor();
    if (window.mainInterval) {
        clearInterval(window.mainInterval);
    }
    window.mainInterval = setInterval(frame, 100);

    // Always show AI Generate button (supports OpenAI DALL-E 3)
    tempContainer.find('[data-role="ai-generate"]').show();

    // Custom tooltip handler for sidebar buttons
    tempContainer.on("mouseenter", ".sidebar .btn[tooltip]", function(e) {
        const tooltipText = $(this).attr("tooltip");
        const $btn = $(this);
        const btnOffset = $btn.offset();
        
        // Remove any existing sidebar tooltips
        $(".minicanvas-sidebar-tooltip").remove();
        
        // Create tooltip
        const $tooltip = $("<div>", {
            class: "minicanvas-sidebar-tooltip",
            text: tooltipText,
            css: {
                position: "fixed",
                left: (btnOffset.left + $btn.outerWidth() + 10) + "px",
                top: (btnOffset.top + ($btn.outerHeight() / 2)) + "px",
                transform: "translateY(-50%)",
                backgroundColor: "#333",
                color: "#fff",
                padding: "6px 12px",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: "500",
                zIndex: 99999,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                boxShadow: "0px 2px 8px rgba(0, 0, 0, 0.3)"
            }
        });
        
        $("body").append($tooltip);
    });

    tempContainer.on("mouseleave", ".sidebar .btn[tooltip]", function() {
        $(".minicanvas-sidebar-tooltip").remove();
    });

    tempContainer.on("mousedown", ".canvas-container", function () {
        selectedCanvas = window.canvasList[$(this).find("canvas").attr("id")];
    });

    tempContainer.on("click", '[data-role="tools"]', function () {
        $(".sidebar .btn").removeClass("selected");
        if ($(".tools-container").length) {
            $(".tools-container").remove();
        } else {
            $(this).addClass("selected");
            tempContainer.append(`<div class="tools-container" style="top: ${$(this).offset().top - 200}px;">
                <div class="tools-sidebar">
                    <div class="tools-sidebar-content">
                        <button tooltip="${window.I18n?.t('minicanvas.editor.select_mode') || 'Select mode'}" class="btn select-mode selected"><i class="material-icons">arrow_selector_tool</i></button>
                        <hr>
                        <button type="pen" tooltip="${window.I18n?.t('minicanvas.editor.pen') || 'Pen'}" class="drawBtn pen" style="color: #ff4242;"><img issvg src="assets/images/mini-canvas/pen.svg"></button>
                        <button type="marker" tooltip="${window.I18n?.t('minicanvas.editor.marker') || 'Marker'}" class="drawBtn pen" style="color: #2254fa;"><img issvg src="assets/images/mini-canvas/marker.svg"></button>
                        <button type="highlighter" tooltip="${window.I18n?.t('minicanvas.editor.highlighter') || 'HighLighter'}" class="drawBtn pen" style="color: #fff151;"><img issvg src="assets/images/mini-canvas/highlighter.svg"></button>
                        <button type="eraser" tooltip="${window.I18n?.t('minicanvas.editor.eraser') || 'Eraser'}" class="drawBtn pen" style="color: #fff151;"><img issvg src="assets/images/mini-canvas/eraser.svg"></button>
                        <div class="other-options">
                            <div tooltip="${window.I18n?.t('minicanvas.editor.draw_color') || 'Draw color'}" color-elm val="#000000" class="color-selector"><span style="background-color: #000000;"></span></div>
                            <button tooltip="${window.I18n?.t('minicanvas.editor.settings') || 'Settings'}" class="btn tools-settings-button"><i class="material-icons">settings</i></button>
                        </div>
                    </div>
                </div>
                <div class="tools-settings">
                    <div class="setting">
                        <span>Weight</span>
                        <div class="range-container">
                            <div range class="weight-range"></div>
                            <input value="${brushOptions[selectedBrush].width}">
                        </div>
                    </div>
                    <div class="setting">
                        <span>Opacity</span>
                        <div class="range-container">
                            <div range class="transparency-range"></div>
                            <input value="${parseInt(brushOptions[selectedBrush].opacity * 100)}">
                        </div>
                    </div>
                </div>    
            </div>`);

            $(".weight-range").range(1, 100, brushOptions[selectedBrush].width, function (val) {
                $(".weight-range").parent().find("input").val(val);
                brushOptions[selectedBrush].width = parseInt(val);
                updateTools();
            });

            $(".transparency-range").range(1, 100, parseInt(brushOptions[selectedBrush].opacity * 100), function (val) {
                $(".transparency-range").parent().find("input").val(val);
                brushOptions[selectedBrush].opacity = parseInt(val) / 100;
                updateTools();
            });

            updateTools();
        }
    });

    const setBrush = () => {
        $.each(window.canvasList, function (id, canvas) {
            if (selectedBrush == "eraser") {
                canvas.freeDrawingBrush = new fabric.EraserBrush(canvas);
                canvas.freeDrawingBrush.width = brushOptions[selectedBrush].width;
            } else {
                var brush = new fabric.PencilBrush(canvas);
                var options = brushOptions[selectedBrush];
                var options = {
                    width: brushOptions[selectedBrush].width,
                    color: hexWithOpacity(
                        brushOptions[selectedBrush].color,
                        brushOptions[selectedBrush].opacity
                    )
                };
                Object.assign(brush, options);
                canvas.freeDrawingBrush = brush;
            }
        });
    };

    function updateTools() {
        $.each(brushOptions, function (type, val) {
            $(".tools-sidebar .drawBtn[type='" + type + "']").css("color", val.color);
        });

        if (selectedBrush == "eraser") {
            $(".tools-sidebar .other-options [color-elm]").hide();
            $(".tools-settings .setting").eq(1).hide();
        } else {
            $(".tools-sidebar .other-options [color-elm]").show();
            $(".tools-settings .setting").eq(1).show();
        }

        $(".weight-range").changeRange(brushOptions[selectedBrush].width)
            .parent().find("input").val(brushOptions[selectedBrush].width);

        $(".transparency-range").changeRange(parseInt(brushOptions[selectedBrush].opacity * 100))
            .parent().find("input").val(parseInt(brushOptions[selectedBrush].opacity * 100));

        setBrush();
    }

    function hexWithOpacity(hex, opacity) {
        hex = hex.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        let alpha = Math.round(Math.min(Math.max(opacity, 0), 1) * 255);
        let alphaHex = alpha.toString(16).padStart(2, '0').toUpperCase();
        return `#${hex}${alphaHex}`;
    }

    tempContainer.find(".content").scroll(function () {
        var scrollPosition = $(this).scrollTop();
        var scrollEnd = scrollPosition + $(this).height();
        $.each(window.canvasList, function (id, canvas) {
            var canvasElement = $(`#${id}`);
            var canvasTop = canvasElement.offset().top;
            var canvasBottom = canvasTop + canvasElement.height();
            if (canvasTop < scrollEnd && canvasBottom > scrollPosition) {
                selectedCanvas = canvas;
            }
        });
    });


    tempContainer.on("click", ".tools-sidebar .select-mode", function () {
        $(".tools-sidebar .drawBtn").removeClass("selected");
        $(this).addClass("selected");
        $(".tools-sidebar .other-options").hide();
        $.each(window.canvasList, function (id, canvas) { canvas.isDrawingMode = false; });
        $(".tools-settings").hide();
    });

    tempContainer.on("click", ".tools-sidebar .drawBtn", function () {
        $(".tools-sidebar .drawBtn, .tools-sidebar .select-mode").removeClass("selected");
        $(this).addClass("selected");
        $(".tools-sidebar .other-options").fadeIn();
        var type = $(this).attr("type");
        $.each(window.canvasList, function (id, canvas) {
            canvas.isDrawingMode = true;
            if (type != "eraser") {
                canvas.freeDrawingCursor = 'url(assets/images/mini-canvas/pencil-cursor.png) 0 35, auto';
            } else {
                canvas.freeDrawingCursor = 'url(assets/images/mini-canvas/eraser-cursor.png) 0 35, auto';
            }
        });
        selectedBrush = type;
        updateTools();
        if (type != "eraser") {
            var currentColor = brushOptions[selectedBrush].color;
            $(".tools-sidebar [color-elm]")
                .attr("val", currentColor)
                .find("span")
                .css("background-color", currentColor);
        }
        $(".tools-settings").hide();
    });

    tempContainer.on("click", ".tools-sidebar [color-elm]", function () {
        $(this).popupColorPicker($(this).attr("val"), function (color) {
            brushOptions[selectedBrush].color = color.slice(0, 7);
            updateTools();
        }, false, "top");
    });

    tempContainer.on("click", ".tools-settings-button", function () {
        $(".tools-settings").toggle();
    });

    tempContainer.on("mousedown", function (e) {
        if (
            !$(e.target).is(".tools-container") && !$(e.target).closest(".tools-container").length &&
            !$(e.target).is("[data-role='tools']") && !$(e.target).closest("[data-role='tools']").length &&
            !$(e.target).is("#colorPickerPopup") && !$(e.target).closest("#colorPickerPopup").length &&
            !$(e.target).is("canvas") && !$(e.target).closest("canvas").length
        ) {
            $(".tools-container").remove();
            $("#colorPickerPopup").remove();
            $.each(window.canvasList, function (id, canvas) { canvas.isDrawingMode = false; });
        }
    });

    tempContainer.on("click", '[data-role="newPage"]', function () {
        newEditor();
        setTimeout(() => {
            tempContainer.find(".content").animate({
                scrollTop: tempContainer.find(".content")[0].scrollHeight,
            });
        }, 200);
    });

    tempContainer.on("click", '[data-role="deletePage"]', function () {
        var editorcontainer = $(this).closest(".editor-container");
        editorcontainer.animate({
            width: "100px",
            height: "100px",
        });
        delete window.canvasList[editorcontainer.find("canvas").attr("id")];
        setTimeout(() => {
            editorcontainer.remove();
        }, 300);
    });

    tempContainer.on("mousedown", "[draggable]", function (e) {
        e.preventDefault();
        draggedELM = $(this).clone().css({ display: "none" }).appendTo(`#${mainContainerID}`);
        clonedELM = $(this);
        setTimeout(() => {
            if (draggedELM && clonedELM) {
                var offsetX = (clonedELM.width() / 2) - (draggedELM.width() / 2);
                var offsetY = (clonedELM.height() / 2) - (draggedELM.height() / 2);
                draggedELM.css({
                    display: "none",
                    position: "fixed",
                    pointerEvents: "none",
                    zIndex: 9999,
                    width: "100px",
                    height: "auto",
                    opacity: "0.7",
                    top: (e.clientX + offsetX) + "px",
                    left: (e.clientY + offsetY) + "px"
                });
            }
        }, 30);
    });

    tempContainer.on("mousemove", function (e) {
        if (scalingELM) {
            const width = scalingELM.getScaledWidth().toFixed(0);
            const height = scalingELM.getScaledHeight().toFixed(0);
            var dimsELM = ($("#objectDimentions").length ? $("#objectDimentions") : $("<div id='objectDimentions'></div>").appendTo(`#${mainContainerID}`));
            dimsELM.show().css({ top: `${e.clientY + 15}px`, left: `${e.clientX + 15}px` }).text(`w:${width} h:${height}`);
        } else {
            $("#objectDimentions").hide();
        }
        if (draggedELM && clonedELM) {
            var mouseX = e.clientX;
            var mouseY = e.clientY;
            var canvas = $("canvas");
            var imageType = clonedELM.attr("image-type");
            
            // Reset all frames to normal state
            Object.keys(window.canvasList).forEach(function(canvasId) {
                var canvasInstance = window.canvasList[canvasId];
                var objects = canvasInstance.getObjects();
                objects.forEach(function(obj) {
                    if (obj.isFrame) {
                        obj.set({
                            stroke: '#999',
                            strokeWidth: 2
                        });
                    }
                });
                canvasInstance.renderAll();
            });
            
            canvas.each(function () {
                var offset = $(this).offset();
                var width = $(this).width();
                var height = $(this).height();
                $(this).css("border", "1px solid transparent");
                if (mouseX >= offset.left && mouseX <= offset.left + width && mouseY >= offset.top && mouseY <= offset.top + height) {
                    var canvasId = $(this).attr('id');
                    if (canvasId) {
                        $(`canvas#${canvasId}`).css("border", "1px solid blue");
                        
                        // Check if hovering over a frame with photo/image
                        if (imageType == "photo" || imageType == "image") {
                            var canvasInstance = window.canvasList[canvasId];
                            var pointer = canvasInstance.getPointer(e);
                            var objects = canvasInstance.getObjects();
                            
                            for (var i = objects.length - 1; i >= 0; i--) {
                                var obj = objects[i];
                                if (obj.isFrame && obj.containsPoint(pointer)) {
                                    obj.set({
                                        stroke: '#4CAF50',
                                        strokeWidth: 4
                                    });
                                    canvasInstance.renderAll();
                                    break;
                                }
                            }
                        }
                    }
                }
            });

            if (getImageType(draggedELM.attr("src")) == "image") {
                var offsetX = (clonedELM.width() / 2) - (draggedELM.width() / 2);
                var offsetY = (clonedELM.height() / 2) - (draggedELM.height() / 2);
                draggedELM.css({
                    display: "block",
                    left: (mouseX + offsetX) + "px",
                    top: (mouseY + offsetY) + "px"
                });
            } else {
                var offsetX = draggedELM.width() / 2;
                var offsetY = draggedELM.height() / 2;
                draggedELM.css({
                    display: "block",
                    left: (mouseX - offsetX) + "px",
                    top: (mouseY - offsetY) + "px"
                });
            }
        }
    });

    function getImageType(path) {
        const url = new URL(path, window.location.origin);
        const pathname = url.pathname.toLowerCase();
        return pathname.endsWith(".svg") ? "svg" : "image";
    }

    function showLoading(img_src, canvas, left, top, ar) {
        const loadingBg = new fabric.Rect({
            width: 100 * ar,
            height: 100,
            fill: '#f0f1f5',
            stroke: '#eeeeee',
            left: left + 50,
            top: top + 50,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false
        });
        fabric.Image.fromURL('assets/images/mini-canvas/loading-spinner.png', function (spinner) {
            spinner.set({
                scaleX: 0.05,
                scaleY: 0.05,
                left: left + 50,
                top: top + 50,
                originX: 'center',
                originY: 'center',
                selectable: false,
                evented: false
            });
            const loadingGroup = new fabric.Group([loadingBg, spinner], {
                left: left + 50,
                top: top + 50,
                originX: 'center',
                originY: 'center',
                selectable: false,
                evented: false
            });
            canvas.add(loadingGroup);
            canvas.renderAll();
            function rotate() {
                spinner.set({
                    angle: spinner.angle + 5
                });
                canvas.renderAll();
                spinner.__animFrame = fabric.util.requestAnimFrame(rotate);
            }
            rotate();
            fabric.Image.fromURL(img_src, function (img) {
                const maxWidth = 100;
                const scale = maxWidth / img.width;
                img.set({
                    left: left,
                    top: top,
                    scaleX: scale,
                    scaleY: scale,
                    strokeUniform: true
                });
                canvas.add(img);
                applyCanvaStyleControls(img);
                cancelAnimationFrame(spinner.__animFrame);
                canvas.remove(loadingGroup);
            }, {
                crossOrigin: 'Anonymous'
            });
        });
    }

    tempContainer.on("mouseup", function (e) {
        if (draggedELM && clonedELM) {
            var img_src = clonedELM.attr("src");
            var type = clonedELM.attr("image-type");
            var canvas = $("canvas");
            var mouseX = e.clientX;
            var mouseY = e.clientY;
            canvas.each(function () {
                var offset = $(this).offset();
                var width = $(this).width();
                var height = $(this).height();
                if (mouseX >= offset.left && mouseX <= offset.left + width &&
                    mouseY >= offset.top && mouseY <= offset.top + height) {
                    var canvasId = $(this).attr('id');
                    if (canvasId) {
                        var canvasInstance = window.canvasList[canvasId];
                        var pointer = canvasInstance.getPointer(e);
                        
                        // Check if dropping on a frame
                        var targetFrame = null;
                        var objects = canvasInstance.getObjects();
                        for (var i = objects.length - 1; i >= 0; i--) {
                            var obj = objects[i];
                            if (obj.isFrame && obj.containsPoint(pointer)) {
                                targetFrame = obj;
                                break;
                            }
                        }
                        
                        if (targetFrame && (type == "photo" || type == "image")) {
                            // Drop image into frame (or replace existing image)
                            if (type == "photo") {
                                img_src = img_src.replace("h=350", "h=2000");
                            }
                            window.addImageToFrame(targetFrame, img_src);
                        } else {
                            // Normal drop behavior
                            var left = pointer.x - 50;
                            var top = pointer.y - 50;
                            if (type == "photo") {
                                img_src = img_src.replace("h=350", "h=2000");
                                var ar = clonedELM.width() / clonedELM.height();
                                showLoading(img_src, canvasInstance, left, top, ar);
                            } else if (type == "svg" || type == "graphic") {
                                fabric.loadSVGFromURL(img_src, function (objects, options) {
                                    const loadedObj = fabric.util.groupSVGElements(objects, options);
                                    const scale = 100 / loadedObj.height;
                                    loadedObj.set({
                                        left: left,
                                        top: top,
                                        scaleX: scale,
                                        scaleY: scale,
                                        strokeUniform: true
                                    });
                                    selectedCanvas.add(loadedObj).setActiveObject(loadedObj);
                                    applyCanvaStyleControls(loadedObj);
                                });
                            }
                        }
                    }
                }
            });
            draggedELM.remove();
            draggedELM = null;
            canvas.each(function () {
                $(this).css("border", "1px solid transparent");
            });
            
            // Reset all frame borders
            Object.keys(window.canvasList).forEach(function(canvasId) {
                var canvasInstance = window.canvasList[canvasId];
                var objects = canvasInstance.getObjects();
                objects.forEach(function(obj) {
                    if (obj.isFrame && !obj.hasImage) {
                        obj.set({
                            stroke: '#999',
                            strokeWidth: 2
                        });
                    }
                });
                canvasInstance.renderAll();
            });
        }
    });

    /* UPLOAD AREA */

    tempContainer.on("click", "[data-role='upload']", showUploadSideBar);

    function showUploadSideBar() {
        $(".sidebar button").removeClass("selected");
        $(".sidebar button[data-role='upload']").addClass("selected");
        showSideContainer("upload");
        $(".side-container .title").text("Upload");
        $(".side-container .section-content").html(`
            <div class="uploadContent">
                <i class="material-icons">cloud_upload</i>
                <p>Drop content to upload</p>
                <small>Supported extensions : .png, .jpg, .jpeg, .bmp, .webp, .svg</small>
            </div>
            <button data-role="uploadImage" class='uploadButton'>Upload image</button>
            <div id='uploadedImages'></div>    
        `);
        window.electronAPI.getUploads().then((res) => {
            if (res) {
                $.each(res, function (k, image) {
                    $(".side-container .section-content #uploadedImages").append(`<a class="photo-select" href="#">
                        <img image-type="photo" draggable src="${image}">
                    </a>`);
                });
            }
        });
    }

    tempContainer.on("click", '[data-role="uploadImage"]', async function () {
        const filePath = await window.electronAPI.uploadImage('upload-image');
        if (filePath) {
            $(".side-container .section-content #uploadedImages").prepend(`<a class="photo-select" href="#">
                <img image-type="photo" draggable src="${filePath}">
            </a>`);
        }
    });

    let fileDragTmOut;
    $('body').on('dragover dragenter', function (e) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(fileDragTmOut);
        $('.uploadContent').css('display', 'flex');
        $(".side-container").show();
        showUploadSideBar();
    });

    $('body').on('dragleave', function (e) {
        fileDragTmOut = setTimeout(() => {
            $('.uploadContent').hide();
        }, 100);
    });

    /* AI GENERATE AREA */

    tempContainer.on("click", '[data-role="ai-generate"]', async function () {
        $(".sidebar button").removeClass("selected");
        $(this).addClass("selected");
        showSideContainer("ai-generate");
        $(".side-container .title").text("AI Generate");
        
        // Get OpenAI keys
        const openaiKeys = await window.electronAPI.readKey('openaiKeys');
        const hasOpenAIKeys = openaiKeys && Object.keys(openaiKeys).length > 0;
        const apiKeyOptions = Object.entries(openaiKeys || {}).map(([key, val]) => 
            `<option value="${key}">${val.label}</option>`
        ).join('');
        
        $(".side-container .section-content").html(`
            <div class="ai-generate-content p-3">
                <div class="mb-3" id="apiKeyContainer">
                    <label class="form-label">API Key</label>
                    <select class="form-select" id="aiApiKeySelect">
                        ${apiKeyOptions}
                    </select>
                    ${!hasOpenAIKeys ? '<small class="text-danger">No OpenAI API keys configured. Add them in Settings.</small>' : ''}
                </div>
                <div class="mb-3">
                    <label class="form-label">Prompt</label>
                    <textarea class="form-control" id="aiPromptInput" rows="4" placeholder="Describe the image you want to generate..."></textarea>
                </div>
                <div class="mb-3" id="openaiSizeContainer">
                    <label class="form-label">Size</label>
                    <select class="form-select" id="aiSizeSelect">
                        <option value="1024x1024">Square (1024x1024)</option>
                        <option value="1024x1792">Portrait (1024x1792)</option>
                        <option value="1792x1024">Landscape (1792x1024)</option>
                    </select>
                </div>
                <div class="mb-3" id="qualityContainer">
                    <label class="form-label">Quality</label>
                    <select class="form-select" id="aiQualitySelect">
                        <option value="standard">Standard</option>
                        <option value="hd">HD</option>
                    </select>
                </div>
                <button class="btn btn-primary w-100" id="generateImageBtn" ${!hasOpenAIKeys ? 'disabled' : ''}>
                    <i class="material-icons">auto_awesome</i> Generate Image
                </button>
                <div id="aiGenerateStatus" class="mt-3" style="display:none;"></div>
            </div>
        `);
        
    });

    tempContainer.on("click", '#generateImageBtn', async function () {
        const $btn = $(this);
        const prompt = $('#aiPromptInput').val();
        
        if (!prompt || prompt.trim() === '') {
            showAlert("error", "Please enter a prompt");
            return;
        }
        
        // Show loading state
        $btn.prop('disabled', true);
        
        $('#aiGenerateStatus').show().html(`
            <div class="alert alert-info">
                <i class="material-icons">hourglass_empty</i> Generating image with OpenAI... This may take 10-30 seconds.
            </div>
        `);
        
        try {
            let result;
            
            const size = $('#aiSizeSelect').val();
            const apiKey = $('#aiApiKeySelect').val();
            const quality = $('#aiQualitySelect').val();
            
            if (!apiKey) {
                showAlert("error", "Please select an API key");
                $btn.prop('disabled', false);
                $('#aiGenerateStatus').hide();
                return;
            }
            
            result = await window.electronAPI.generateAIImage(apiKey, prompt, size, quality);
            
            if (result.success) {
                // Add the generated image to the canvas
                fabric.Image.fromURL(result.value, function (img) {
                    const maxWidth = selectedCanvas.width / 2;
                    const maxHeight = selectedCanvas.height / 2;
                    const scaleX = maxWidth / img.width;
                    const scaleY = maxHeight / img.height;
                    const scale = Math.min(scaleX, scaleY, 1);
                    
                    img.set({
                        scaleX: scale,
                        scaleY: scale,
                        left: selectedCanvas.width / 2,
                        top: selectedCanvas.height / 2,
                        originX: 'center',
                        originY: 'center',
                        selectable: true,
                        hasRotatingPoint: true,
                        cornerStyle: 'rect',
                        transparentCorners: false,
                        cornerSize: 10,
                        cornerColor: 'rgba(0,0,255,0.5)'
                    });
                    
                    selectedCanvas.add(img);
                    selectedCanvas.setActiveObject(img);
                    selectedCanvas.renderAll();
                });
                
                $('#aiGenerateStatus').html(`
                    <div class="alert alert-success">
                        <i class="material-icons">check_circle</i> Image generated successfully!
                    </div>
                `);
                
                // Clear prompt
                $('#aiPromptInput').val('');
            } else {
                $('#aiGenerateStatus').html(`
                    <div class="alert alert-danger">
                        <i class="material-icons">error</i> ${result.value}
                    </div>
                `);
            }
        } catch (error) {
            $('#aiGenerateStatus').html(`
                <div class="alert alert-danger">
                    <i class="material-icons">error</i> ${error.message}
                </div>
            `);
        } finally {
            $btn.prop('disabled', false);
        }
    });

    /* TEXT AREA */

    tempContainer.on("click", '[data-role="textinput"]', async function () {
        // Let the user choose which text input to place.
        // Duplicates are allowed so the same text input can be added multiple
        // times across the canvas (the backend replaces every matching
        // {INPUT_X} occurrence with the same input text).
        const textInputsSelect = [
            { label: "Text 1", value: "{INPUT_2}" },
            { label: "Text 2", value: "{INPUT_3}" },
            { label: "Text 3", value: "{INPUT_4}" },
            { label: "Text 4", value: "{INPUT_5}" },
        ];

        const slotResult = await newPrompt([
            {
                type: "select",
                name: "Text input",
                required: true,
                options: textInputsSelect
            }
        ]);

        if (!slotResult) return;

        const textInput = slotResult["Text input"];

        const shapeWidth = 200;
        const shapeHeight = 100;

        var randID = Math.random().toString(36).substring(10, 17);

        const rect = new fabric.Rect({
            left: 100,
            top: 100,
            width: shapeWidth,
            height: shapeHeight,
            fill: null,
            stroke: "#000",
            strokeWidth: 1,
            hasControls: true,
            lockScalingFlip: true,
            strokeDashArray: [5, 5],
            id: randID
        });

        const text = new fabric.IText(textInput, {
            left: rect.left + shapeWidth / 2,
            top: rect.top + shapeHeight / 2,
            fontFamily: "Roboto",
            fill: "#000",
            originX: "center",
            originY: "center",
            textAlign: "center",
            editable: true,
            selectable: true,
            lockMovementX: true,
            lockMovementY: true,
            lockScalingX: true,
            lockScalingY: true,
            lockRotation: true,
            parent: randID
        });

        selectedCanvas.add(rect, text).setActiveObject(text);

        rect.linkedTextId = text.id = Date.now();
        text.linkedRectId = rect.linkedTextId;

        function updateTextPosition() {
            text.set({
                left: rect.left + rect.width * rect.scaleX / 2,
                top: rect.top + rect.height * rect.scaleY / 2
            });
            text.setCoords();
            selectedCanvas.requestRenderAll();
        }

        rect.on("moving", updateTextPosition);
        rect.on("scaling", updateTextPosition);
        rect.on("modified", updateTextPosition);

        updateTextPosition();

        selectedCanvas.on("object:removed", function (e) {
            const obj = e.target;
            if (!obj) return;

            if (obj === rect) {
                const linkedText = selectedCanvas.getObjects().find(o => o.id === rect.linkedTextId);
                if (linkedText) selectedCanvas.remove(linkedText);
            }

            if (obj === text) {
                const linkedRect = selectedCanvas.getObjects().find(o => o.linkedTextId === text.id);
                if (linkedRect) selectedCanvas.remove(linkedRect);
            }
        });

        applyCanvaStyleControls(text);
    });

    tempContainer.on("click", '[data-role="text"]', function () {
        const text = new fabric.IText('Text', {
            left: 100,
            top: 100,
            fontSize: 35,
            fontFamily: "Roboto",
            fill: 'black',
            strokeUniform: true
        });
        selectedCanvas.add(text).setActiveObject(text);
        applyCanvaStyleControls(text);
    });

    /* GRAPHIC AREA */

    var graphicPage = 1;
    tempContainer.on("click", '[data-role="graphics"]', function () {
        $(".sidebar button").removeClass("selected");
        $(".sidebar button[data-role='graphics']").addClass("selected");
        showSideContainer("graphics");
        $(".side-container .title").text("Graphics");
        var randID = Math.random().toString(36).substring(10, 17);
        var initialHTML = `<div id="${randID}"><div id="graphicSearch" class="search-form"><div class="icon-div"><i class="material-icons">search</i></div><input type="text" placeholder="Search a graphic"></div><div class="pt-50" id="graphicList"></div></div>`;
        $(".side-container .section-content").html(initialHTML);
        loadGraphics(graphicPage);
        $("#" + randID).closest(".side-container").off("scroll").on("scroll", function (e) {
            if ($(this).scrollTop() > 90) {
                $("#graphicSearch").addClass("sticky");
            } else {
                $("#graphicSearch").removeClass("sticky");
            }
            if (($(this).scrollTop() + $(this).height() + 100) > $(this)[0].scrollHeight) {
                graphicPage += 1;
                loadGraphics(graphicPage);
            }
        });
    });

    tempContainer.on("input", "#graphicSearch input", function () {
        if ($(this).val().length > 2) {
            graphicPage = 1;
        }
        clearTimeout(inputTimeout);
        inputTimeout = setTimeout(() => {
            loadGraphics(graphicPage);
        }, 500);
    });

    function loadGraphics(page) {
        window.electronAPI.getIllustrations(page, $("#graphicSearch input").val()).then((res) => {
            if (page === 1) $("#graphicList").html("");
            const fragment = document.createDocumentFragment();
            res.forEach((imgPath) => {
                const a = document.createElement("a");
                a.className = "photo-select";
                a.href = "#";

                const randID = Math.random().toString(36).substring(10, 17);
                const img = document.createElement("img");
                img.src = imgPath;
                img.setAttribute("draggable", "true");
                img.setAttribute("elmid", randID);
                img.setAttribute("image-type", "graphic");
                img.setAttribute("width", "48%");
                img.setAttribute("loading", "lazy");

                a.appendChild(img);
                fragment.appendChild(a);
                $("#graphicList").append(a);
            });
        });
    }


    /* PHOTOS AREA */

    var photosPage = 1;
    tempContainer.on("click", '[data-role="photos"]', function () {
        $(".sidebar button").removeClass("selected");
        $(".sidebar button[data-role='photos']").addClass("selected");
        showSideContainer("photos");
        $(".side-container .title").text("Photos");
        var randID = Math.random().toString(36).substring(10, 17);
        var initialHTML = `<div id="${randID}"><div id="photoSearch" class="search-form"><div class="icon-div"><i class="material-icons">search</i></div><input type="text" placeholder="Search a photo"></div><div class="pt-50" id="photosList"></div></div>`;
        $(".side-container .section-content").html(initialHTML);
        loadPhotos(photosPage);
        $("#" + randID).closest(".side-container").off("scroll").on("scroll", function (e) {
            if ($(this).scrollTop() > 90) {
                $("#photoSearch").addClass("sticky");
            } else {
                $("#photoSearch").removeClass("sticky");
            }
            if (($(this).scrollTop() + $(this).height() + 100) > $(this)[0].scrollHeight) {
                photosPage += 1;
                loadPhotos(photosPage);
            }
        });
    });

    tempContainer.on("input", "#photoSearch input", function () {
        if ($(this).val().length > 2) {
            photosPage = 1;
        }
        clearTimeout(inputTimeout);
        inputTimeout = setTimeout(() => {
            loadPhotos(photosPage);
        }, 500);
    });

    function loadPhotos(page) {
        window.electronAPI.getPhotos(page, $("#photoSearch input").val()).then((res) => {
            if (res) {
                if (page == 1) { $("#photosList").html(""); }
                let content = "";
                $.each(res, function (k, vl) {
                    content += `<a class="photo-select" href="#"><img draggable image-type="photo" src="${vl["src"]["medium"]}" alt=""></a>`;
                });
                $("#photosList").append(content);
            }
        });
    }

    tempContainer.on("click", "a.photo-select", function (e) { e.preventDefault(0); });

    /* FONTS */

    tempContainer.on("click", '[data-role="font"]', function (e) {
        e.preventDefault(0);
        selectFont(function (font) {
            selectedItem.set("fontFamily", font);
            selectedCanvas.renderAll();
            $(".header-bar [data-role='font']").text(font);
            // Ensure the full glyph subset (incl. latin-ext: ă, ș, ț, etc.) for the
            // current text is downloaded before final render, then re-render so
            // diacritics use the correct font instead of a smaller fallback glyph.
            ensureFontLoaded(font, selectedItem.text || "", function () {
                selectedCanvas.requestRenderAll();
            });
        });
    });

    function selectFont(onchange) {
        var fontsOffset = 0;
        var randID = Math.random().toString(36).substring(10, 17);
        var initialHTML = `<div id="${randID}"><div id="fontSearch" class="search-form"><div class="icon-div"><i class="material-icons">search</i></div><input type="text" placeholder="Search font"></div><div id="fontsList"></div></div>`;
        window.electronAPI.getFonts().then((fonts) => {
            showSideContainer("fonts");
            $(".side-container .title").text("Fonts");
            $(".side-container .section-content").html(initialHTML);
            addFonts(fontsOffset, fonts);
            $("#" + randID).closest(".side-container").off("scroll").on("scroll", function (e) {
                if ($(this).scrollTop() > 90) {
                    $("#fontSearch").addClass("sticky");
                } else {
                    $("#fontSearch").removeClass("sticky");
                }
                if (($(this).scrollTop() + $(this).height() + 100) > $(this)[0].scrollHeight) {
                    fontsOffset += 50;
                    addFonts(fontsOffset, fonts);
                }
            });
            tempContainer.find("#fontSearch input").off("input").on("input", function () {
                var value = $(this).val().toLowerCase();
                if (value.length > 2) {
                    fontsOffset = 0;
                    $("#" + randID).find("#fontsList").html("");
                    $.each(fonts, function (k, font) {
                        if (font.toLowerCase().includes(value)) {
                            $("#" + randID).find("#fontsList").append(`<button style='font-family: "${font}", sans-serif!important;' class="font-display">${font}</button>`);
                        }
                    });
                } else if (value.length == 0) {
                    $("#" + randID).find("#fontsList").html("");
                    addFonts(0, fonts);
                }
            });
        });

        tempContainer.off("click", "#fontsList button").on("click", "#fontsList button", function () {
            onchange($(this).text());
        });

        function addFonts(fontsOffset, fonts) {
            if (fontsOffset < fonts.length) {
                for (var i = fontsOffset; i < (fontsOffset + 50 > fonts.length ? fonts.length : fontsOffset + 50); i++) {
                    var url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fonts[i])}&display=swap`;
                    loadGoogleFontOnce(url);
                    $(".side-container .section-content #fontsList").append(`<button style='font-family: "${fonts[i]}", sans-serif!important;' class="font-display">${fonts[i]}</button>`);
                }
            }
        }
    }

    /* INPUTS AREA */

    const allImageInputsSelect = [
        { label: "Image #1", value: "placehold_1" },
        { label: "Image #2", value: "placehold_2" },
        { label: "Image #3", value: "placehold_3" },
        { label: "Image #4", value: "placehold_4" },
    ];

    let ImageInputsSelect = [...allImageInputsSelect];

    function updateImageInputsSelect(canvas) {
        const placeholderImages = canvas.getObjects().filter(obj => obj.placeholderClass === "placeholder-image");
        const usedIds = placeholderImages.map(obj => obj.placeholderId);
        ImageInputsSelect = allImageInputsSelect.filter(item => !usedIds.includes(item.value));
    }

    tempContainer.on("click", '[data-role="input"]', async function () {
        // Let the user choose which image input to place.
        // Duplicates are allowed so the same image input can be added multiple
        // times across the canvas (the backend fills every placeholder that
        // shares the same placeholderId with the same input image).
        const slotResult = await newPrompt([
            {
                type: "select",
                name: "Image input",
                required: true,
                options: allImageInputsSelect.map(item => ({ label: item.label, value: item.value }))
            }
        ]);

        if (!slotResult) return;

        const placeholdId = slotResult["Image input"];

        // Check if there are existing image inputs with aspect ratio
        const existingImageInputs = selectedCanvas.getObjects().filter(obj => 
            obj.placeholderClass === "placeholder-image" && obj.aspectRatio
        );
        
        let aspectRatio;
        
        if (existingImageInputs.length > 0) {
            // Use the aspect ratio from the first existing image input
            aspectRatio = existingImageInputs[0].aspectRatio;
        } else {
            // No existing image inputs, ask user for aspect ratio
            const aspectRatioField = "Aspect ratio (e.g., 4:5, 16:9, 1:1)";
            const result = await newPrompt([
                { type: "text", name: aspectRatioField, required: true, value: "4:5" }
            ]);
            
            if (!result) return;
            
            aspectRatio = result[aspectRatioField];
            
            // Validate aspect ratio format
            if (!/^\d+:\d+$/.test(aspectRatio)) {
                showAlert("error", "Aspect ratio must be in the format x:y (e.g., 4:5, 16:9, 1:1)");
                return;
            }
        }

        const [wRatio, hRatio] = aspectRatio.split(":").map(Number);
        const baseSize = 1000;
        let width = baseSize;
        let height = Math.round((baseSize * hRatio) / wRatio);
        if (height < 1000) {
            height = 1000;
            width = Math.round((baseSize * wRatio) / hRatio);
        }

        const base64 = generatePlaceholder(width, height, "#ccc", "#333", `${width} x ${height} (${placeholdId.replace("_", " ")})`);

        fabric.Image.fromURL(base64, function (img) {
            const maxWidth = selectedCanvas.width / 2;
            const maxHeight = selectedCanvas.height / 2;
            const scaleX = maxWidth / img.width;
            const scaleY = maxHeight / img.height;
            const scale = Math.min(scaleX, scaleY, 1);

            img.set({
                scaleX: scale,
                scaleY: scale,
                left: selectedCanvas.width / 2,
                top: selectedCanvas.height / 2,
                originX: 'center',
                originY: 'center',
                selectable: true,
                lockRotation: true,
                lockScalingFlip: true,
                lockUniScaling: true,
                hasRotatingPoint: false,
                cornerStyle: 'rect',
                transparentCorners: false,
                cornerSize: 10,
                cornerColor: 'rgba(0,0,255,0.5)',
                placeholderClass: "placeholder-image",
                placeholderId: placeholdId,
                aspectRatio
            });

            img.setControlsVisibility({
                mt: false,
                mr: false,
                mb: false,
                ml: false,
                bl: true,
                br: true,
                tl: true,
                tr: true
            });

            selectedCanvas.add(img);
            selectedCanvas.setActiveObject(img);
            selectedCanvas.renderAll();
        });
    });

    /* FRAMES AREA */

    tempContainer.on("click", '[data-role="frames"]', function () {
        $(".sidebar button").removeClass("selected");
        $(this).addClass("selected");
        showSideContainer("frames");
        $(".side-container .title").text("Frames");
        
        const frames = [
            { name: "Rectangle", shape: "rect", icon: "crop_square" },
            { name: "Circle", shape: "circle", icon: "circle" },
            { name: "Rounded Rectangle", shape: "roundedRect", icon: "rounded_corner" },
            { name: "Triangle", shape: "triangle", icon: "change_history" },
            { name: "Pentagon", shape: "pentagon", icon: "pentagon" },
            { name: "Hexagon", shape: "hexagon", icon: "hexagon" },
            { name: "Star", shape: "star", icon: "star" },
            { name: "Heart", shape: "heart", icon: "favorite" }
        ];
        
        let framesHTML = '<div class="frames-grid">';
        frames.forEach(frame => {
            framesHTML += `
                <div class="frame-item" data-shape="${frame.shape}">
                    <div class="frame-preview">
                        <i class="material-icons">${frame.icon}</i>
                    </div>
                    <span>${frame.name}</span>
                </div>
            `;
        });
        framesHTML += '</div>';
        
        $(".side-container .section-content").html(framesHTML);
    });

    tempContainer.on("click", '.frame-item', function () {
        const shape = $(this).attr("data-shape");
        addFrameToCanvas(shape);
    });

    function addFrameToCanvas(shapeType) {
        if (!selectedCanvas) return;
        
        const frameSize = 300;
        const left = 100;
        const top = 100;
        
        // Create a unique ID for this frame
        const frameId = 'frame_' + Date.now();
        
        let clipShape;
        
        switch(shapeType) {
            case "rect":
                clipShape = new fabric.Rect({
                    width: frameSize,
                    height: frameSize,
                    originX: 'center',
                    originY: 'center'
                });
                break;
                
            case "circle":
                clipShape = new fabric.Circle({
                    radius: frameSize / 2,
                    originX: 'center',
                    originY: 'center'
                });
                break;
                
            case "roundedRect":
                clipShape = new fabric.Rect({
                    width: frameSize,
                    height: frameSize,
                    rx: 50,
                    ry: 50,
                    originX: 'center',
                    originY: 'center'
                });
                break;
                
            case "triangle":
                clipShape = new fabric.Triangle({
                    width: frameSize,
                    height: frameSize,
                    originX: 'center',
                    originY: 'center'
                });
                break;
                
            case "pentagon":
            case "hexagon":
            case "star":
            case "heart":
                const points = getShapePoints(shapeType, frameSize);
                clipShape = new fabric.Polygon(points, {
                    originX: 'center',
                    originY: 'center'
                });
                break;
        }
        
        // Create a placeholder rectangle with the clip shape
        const frame = new fabric.Rect({
            left: left,
            top: top,
            width: frameSize,
            height: frameSize,
            fill: '#e5e5e5',
            stroke: '#999',
            strokeWidth: 2,
            strokeDashArray: [8, 4],
            hasControls: true,
            lockScalingFlip: true,
            clipPath: clipShape,
            frameId: frameId,
            isFrame: true,
            hasImage: false,
            frameShape: shapeType,
            strokeUniform: true
        });
        
        selectedCanvas.add(frame);
        selectedCanvas.setActiveObject(frame);
        applyCanvaStyleControls(frame);
    }
    
    // Function to add image to a frame
    window.addImageToFrame = function(frame, imageUrl) {
        if (!frame || !frame.isFrame) return;
        
        fabric.Image.fromURL(imageUrl, function(img) {
            const frameWidth = frame.width * (frame.scaleX || 1);
            const frameHeight = frame.height * (frame.scaleY || 1);
            
            // Calculate scale to cover frame completely
            const scaleX = frameWidth / img.width;
            const scaleY = frameHeight / img.height;
            const scale = Math.max(scaleX, scaleY);
            
            // Create clipping shape based on frame shape
            let clipShape;
            
            switch(frame.frameShape) {
                case "rect":
                    clipShape = new fabric.Rect({
                        width: frameWidth,
                        height: frameHeight,
                        originX: 'center',
                        originY: 'center'
                    });
                    break;
                    
                case "circle":
                    clipShape = new fabric.Circle({
                        radius: Math.min(frameWidth, frameHeight) / 2,
                        originX: 'center',
                        originY: 'center'
                    });
                    break;
                    
                case "roundedRect":
                    clipShape = new fabric.Rect({
                        width: frameWidth,
                        height: frameHeight,
                        rx: 50,
                        ry: 50,
                        originX: 'center',
                        originY: 'center'
                    });
                    break;
                    
                case "triangle":
                    clipShape = new fabric.Triangle({
                        width: frameWidth,
                        height: frameHeight,
                        originX: 'center',
                        originY: 'center'
                    });
                    break;
                    
                default:
                    const points = getShapePoints(frame.frameShape, frameWidth);
                    clipShape = new fabric.Polygon(points, {
                        originX: 'center',
                        originY: 'center'
                    });
            }
            
            // Calculate the scaled dimensions
            const scaledImgWidth = img.width * scale;
            const scaledImgHeight = img.height * scale;
            
            // Calculate offset to center the image (middle part)
            const offsetX = (scaledImgWidth - frameWidth) / 2;
            const offsetY = (scaledImgHeight - frameHeight) / 2;
            
            // Create a rect with exact frame dimensions that will act as the container
            const container = new fabric.Rect({
                left: frame.left,
                top: frame.top,
                width: frameWidth,
                height: frameHeight,
                fill: 'transparent',
                scaleX: 1,
                scaleY: 1,
                clipPath: clipShape,
                hasControls: true,
                lockScalingFlip: true,
                strokeUniform: true,
                isFrame: true,
                hasImage: true,
                frameShape: frame.frameShape,
                frameId: frame.frameId
            });
            
            // Set the image as the fill pattern of the container
            // Use negative offset to show the center of the image
            container.set('fill', new fabric.Pattern({
                source: img.getElement(),
                repeat: 'no-repeat',
                patternTransform: [scale, 0, 0, scale, -offsetX, -offsetY]
            }));
            
            // Remove old frame and add new container with image
            selectedCanvas.remove(frame);
            selectedCanvas.add(container);
            selectedCanvas.setActiveObject(container);
            applyCanvaStyleControls(container);
            selectedCanvas.renderAll();
            
        }, { crossOrigin: 'anonymous' });
    }

    function getShapePoints(shapeType, size) {
        const points = [];
        const radius = size / 2;
        
        switch(shapeType) {
            case "pentagon":
                for (let i = 0; i < 5; i++) {
                    const angle = (i * 2 * Math.PI / 5) - Math.PI / 2;
                    points.push({
                        x: radius * Math.cos(angle),
                        y: radius * Math.sin(angle)
                    });
                }
                break;
                
            case "hexagon":
                for (let i = 0; i < 6; i++) {
                    const angle = (i * 2 * Math.PI / 6) - Math.PI / 2;
                    points.push({
                        x: radius * Math.cos(angle),
                        y: radius * Math.sin(angle)
                    });
                }
                break;
                
            case "star":
                for (let i = 0; i < 10; i++) {
                    const r = i % 2 === 0 ? radius : radius / 2;
                    const angle = (i * Math.PI / 5) - Math.PI / 2;
                    points.push({
                        x: r * Math.cos(angle),
                        y: r * Math.sin(angle)
                    });
                }
                break;
                
            case "heart":
                // Heart shape centered around (0,0) with smooth curves
                const scale = radius / 50;
                
                // Generate smooth heart shape using parametric equations
                // Create more points for smoother curves
                for (let t = 0; t <= 2 * Math.PI; t += Math.PI / 32) {
                    // Heart curve parametric equations
                    const x = 16 * Math.pow(Math.sin(t), 3);
                    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
                    
                    points.push({
                        x: x * scale * 3,
                        y: y * scale * 3
                    });
                }
                break;
        }
        
        return points;
    }

    /* SHAPES AREA */

    var shapes = [];
    window.electronAPI.getShapes().then((r) => { shapes = r; });

    tempContainer.on("click", '[data-role="shapes"]', function () {
        $(".sidebar button").removeClass("selected");
        $(this).addClass("selected");
        showSideContainer("shapes");
        $(".side-container .title").text("Shapes");
        var shapesSTR = "";
        for (var i = 0; i < shapes.length; i++) {
            shapesSTR += `<button class="shapeButton"><img draggable image-type="svg" src="assets/images/mini-canvas/shapes/${shapes[i]}"></button>`;
        }
        $(".side-container .section-content").html(`<div class="shapes">${shapesSTR}</div>`);
    });

    /* COLORS AREA */
    window.colors = {
        used_colors: [],
        solid: [
            "#000000",
            "#FFFFFF",
            "#FF0000",
            "#00FF00",
            "#0000FF",
            "#FFFF00",
            "#808080",
            "#800080",
            "#FFA500",
            "#FFC0CB",
            "#A52A2A",
            "#008080",
            "#C0C0C0",
            "#FFD700",
            "#808000",
        ],
        gradient: [
            "90deg,#38b6ff,#000000",
            "90deg,#FF7E5F,#FEB47B",
            "90deg,#00C9FF,#92FE9D",
            "90deg,#FC466B,#3F5EFB",
            "90deg,#DA22FF,#9733EE",
            "90deg,#F7971E,#FFD200",
            "90deg,#56CCF2,#2F80ED",
            "90deg,#12c2e9,#c471ed",
            "90deg,#f64f59,#c471ed",
            "90deg,#667eea,#764ba2",
        ],
    };

    tempContainer.on("mousedown", function (e) {
        if (
            !$(e.target).is(".colorPicker") &&
            !$(e.target).closest(".colorPicker").length &&
            !$(e.target).is("[data-role='newColor']") &&
            !$(e.target).closest("[data-role='newColor']").length &&
            !$(e.target).is("#colorPickerPopup") &&
            !$(e.target).closest("#colorPickerPopup").length &&
            !$(e.target).is(".closebtn") &&
            !$(e.target).closest(".closebtn").length
        ) {
            $(".colorPicker").hide();
        }
    });

    tempContainer.on("click", '[data-role="pickColor"]', function () {
        var this_elm = $(this);
        colorsPicker("#FFFFFF", function (color) {
            var style = getStyle(color);
            if (colorElement) {
                colorElement.attr("val", color).html(`<span style="${style}"></span>`);
                colorElement.find("span").css("background-color", color);
            }
            this_elm.closest(".editor-container").find("canvas").attr("color", color);
        });
    });

    function colorsPicker(initialColor, onChange, supportGradient = true, popup = false) {
        var randID = Math.random().toString(36).substring(10, 17);
        if (popup) {
            var divName = ".popup";
            showPopupContainer("colors");
        } else {
            var divName = ".side-container";
            showSideContainer("colors");
        }
        $(divName + " .title").text("Color");
        var used_colors = "",
            solid = "",
            gradient = "";
        for (var i = 0; i < window.colors["used_colors"].length; i++) {
            used_colors += `<div color-elm val="${window.colors["used_colors"][i]}" class="color"><span style="background-color: ${window.colors["used_colors"][i]};"></span></div>`;
        }
        for (var i = 0; i < window.colors["solid"].length; i++) {
            solid += `<div color-elm val="${window.colors["solid"][i]}" class="color"><span style="background-color: ${window.colors["solid"][i]};"></span></div>`;
        }
        for (var i = 0; i < window.colors["gradient"].length; i++) {
            var gradients = window.colors["gradient"][i].split(",");
            gradient += `<div color-elm val="${gradients.join(
                ","
            )}" class="color"><span style="background: linear-gradient(${gradients[0]
                }, ${gradients[1]} 0%, ${gradients[2]} 100%);"></span></div>`;
        }
        $(divName + " .section-content").html(`
            <div id="${randID}">
                <div class="colorPalette used_colors">
                <div data-role="newColor" class="color"><span class="color-circle"><i class="material-icons">add</i></span></div>
                ${used_colors}
            </div>
            <div class="colorPicker">
                ${supportGradient ? `
                <div class="header">
                    <button section_id="color-picker-container" class="sectionTitle selected">Solid color</button>
                    <button section_id="gradient-picker-container" class="sectionTitle">Gradient</button>
                </div>    
                ` : ""}
                <div class="color-picker-container" id="color-picker-container">
                    <div id="color-picker"></div>
                    <div class="bottom-section">
                        <div class="color-show-input">
                            <div class="color-show"><span style="background-color: ${initialColor};"></span></div>
                            <input value="${initialColor}">
                            <div class="button-pick"><button eyeDropper class="btn"><i class="material-icons">colorize</i></button></div>
                        </div>
                    </div>
                </div>
                ${supportGradient ? `
                <div class="color-picker-container" id="gradient-picker-container" style="display: none;">
                    <b>Colors</b>
                    <div class="colorPalette">
                        <div color-elm val="#FFFFFF" class="color"><span style="background-color: #FFFFFF;"></span></div>
                        <div color-elm val="#000000" class="color"><span style="background-color: #000000;"></span></div>
                        <div data-role="newColorGradient" class="color"><span class="color-circle"><i class="material-icons">add</i></span></div>
                    </div>
                    <b>Gradient style</b>
                    <div class="gradient-styles">
                        <div tooltip="0deg" val="0deg" class="gradient-style" style="background: linear-gradient(0deg, #667eea 0%, #764ba2 100%);"></div>
                        <div tooltip="45deg" val="45deg" class="gradient-style" style="background: linear-gradient(45deg, #667eea 0%, #764ba2 100%);"></div>
                        <div tooltip="90deg" val="90deg" class="gradient-style selected" style="background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);"></div>
                        <div tooltip="135deg" val="135deg" class="gradient-style" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);"></div>
                        <div tooltip="180deg" val="180deg" class="gradient-style" style="background: linear-gradient(180deg, #667eea 0%, #764ba2 100%);"></div>
                        <div tooltip="225deg" val="90deg" class="gradient-style" style="background: linear-gradient(225deg, #667eea 0%, #764ba2 100%);"></div>
                        <div tooltip="270deg" val="270deg" class="gradient-style" style="background: linear-gradient(270deg, #667eea 0%, #764ba2 100%);"></div>
                        <div tooltip="315deg" val="315deg" class="gradient-style" style="background: linear-gradient(315deg, #667eea 0%, #764ba2 100%);"></div>
                    </div>
                </div>
                ` : ""}
            </div>
            <div class="other-colors">
                <span class="smallTitle">Solid colors</span>
                <div class="colorPalette">${solid}</div>
                ${supportGradient ? `<span class="smallTitle">Gradients</span>
                <div class="colorPalette">${gradient}</div>` : ""}
            </div>
        </div>`);

        $("#" + randID).on("click", "[color-elm]", function () {
            if (!$(this).closest(".colorPicker").length) {
                onChange($(this).attr("val"));
            }
        });

        const colorPicker = new iro.ColorPicker("#color-picker", {
            width: 240,
            color: initialColor,
            layout: [
                { component: iro.ui.Box },
                { component: iro.ui.Slider, options: { sliderType: "hue" } },
                { component: iro.ui.Slider, options: { sliderType: "alpha" } },
            ],
        });

        colorPicker.on("color:change", function (color) {
            $(".color-picker-container .color-show span").css(
                "background-color",
                color.hex8String
            );
            $(".color-picker-container .color-show-input input").val(
                color.hex8String
            );
            if (onChange && typeof onChange === "function") {
                if (colorElement) {
                    colorElement.attr("val", color.hex8String).find("span").css("background-color", color.hex8String);
                }
                onChange(color.hex8String);
            }
        });

        if (!window.EyeDropper) {
            $(".color-picker-container .button-pick").remove();
        }

        $("#" + randID).on("click", "[eyeDropper]", async function () {
            const eyeDropper = new EyeDropper();
            try {
                const result = await eyeDropper.open();
                $(".color-picker-container .color-show span").css(
                    "background-color",
                    result.sRGBHex
                );
                $(".color-picker-container .color-show-input input").val(
                    result.sRGBHex
                );
                colorPicker.color.set(result.sRGBHex);
                if (onChange && typeof onChange === "function") {
                    onChange(result.sRGBHex);
                }
            } catch (err) {
                console.error("Color picking cancelled or failed:", err);
            }
        });

        $("#" + randID).on("click", '[data-role="newColor"]', function () {
            $(".colorPicker .sectionTitle").eq(0).click();
            $(this).closest(".colorPalette").prepend(`<div color-elm val="#000000" class="color"><span style="background-color: #000000;"></span></div>`);
            colorElement = $(this).closest(".colorPalette").find("[color-elm]").first();
            $(".colorPicker").fadeToggle(100);
        });

        $("#" + randID).on("click", ".used_colors [color-elm]", function () {
            colorElement = $(this);
            var color = $(this).attr("val");
            $(".colorPicker").fadeToggle(100);
            $("#gradient-picker-container .colorPalette [color-elm]").remove();
            for (var i = 0; i < color.split(",").length - 1; i++) {
                $("#gradient-picker-container .colorPalette [data-role='newColorGradient']").before(`<div color-elm="" val="${color.split(",")[i + 1]}" class="color"><span style="background-color: ${color.split(",")[i + 1]};"></span></div>`);
            }
        });

        $("#" + randID).on("click", ".other-colors [color-elm]", function () {
            var color = $(this).attr("val");
            var style = getStyle(color);
            $(".used_colors").prepend(`<div color-elm val="${color}" class="color"><span style="${style}"></span></div>`);
        });

        $("#" + randID).on("click", '[data-role="newColorGradient"]', function () {
            $(this).before(
                '<div color-elm val="#000000" class="color"><span style="background-color: #000000;"></span><button class="closebtn"><i class="material-icons">close</i></button></div>'
            );
            $(this)
                .prev()
                .popupColorPicker("#000000", function () {
                    onChange(updateGradients());
                });
        });

        $("#" + randID).on("click", "#gradient-picker-container [color-elm]", function () {
            $(this).popupColorPicker(
                rgbToHex($(this).find("span").css("background-color")),
                function () {
                    onChange(updateGradients());
                }
            );
        });

        $("#" + randID).on("click", ".colorPicker .sectionTitle", function () {
            var section_id = $(this).attr("section_id");
            $(".sectionTitle").removeClass("selected");
            $(this).addClass("selected");
            $(".color-picker-container").hide();
            $("#" + section_id).show();
            updateGradients();
        });

        $("#" + randID).on(
            "click",
            ".gradient-styles .gradient-style",
            function () {
                $(".gradient-styles .gradient-style").removeClass("selected");
                $(this).addClass("selected");
                onChange(updateGradients());
            }
        );

        $("#" + randID).on("click", ".color button.closebtn", function (e) {
            e.preventDefault(0);
            $(this).closest(".color").remove();
        });
    }

    tempContainer.on("mousedown", function (e) {
        // Don't close if container was just opened
        if (sideContainerJustOpened) {
            return;
        }

        const $target = $(e.target);

        const isInSideBar = $target.is(".sidebar") || $target.closest(".sidebar").length;
        const isInSideContainer = $target.is(".side-container") || $target.closest(".side-container").length;
        const isInColorPicker = $target.is("#colorPickerPopup") || $target.closest("#colorPickerPopup").length;
        const isInToolsSidebar = $target.is(".tools-sidebar") || $target.closest(".tools-sidebar").length;
        const isHeaderBar = $target.is(".header-bar") || $target.closest(".header-bar").length;
        const isPopup = $target.is(".popup") || $target.closest(".popup").length;
        const isSidebarButton = $target.is(".sidebar .btn") || $target.closest(".sidebar .btn").length;
        const isEditorHeader = $target.is(".editor-header") || $target.closest(".editor-header").length;
        const isPickColorButton = $target.is('[data-role="pickColor"]') || $target.closest('[data-role="pickColor"]').length;

        if (!isInSideContainer && !isInColorPicker && !isInToolsSidebar && !isInSideBar && !isHeaderBar && !isPopup && !isSidebarButton && !isEditorHeader && !isPickColorButton) {
            closeSideSection();
            closeSideSection(true);
        }
    });

    function showSideContainer(name) {
        const container = document.querySelector(".side-container")
        if (!container) return
        
        // Set flag to prevent immediate closing
        sideContainerJustOpened = true;
        
        container.setAttribute("data-section", name)
        container.style.display = "block"
        void container.offsetWidth
        container.style.transform = "translateX(0)"
        container.style.opacity = "1"
        
        // Reset flag after animation completes (300ms + small buffer)
        setTimeout(() => {
            sideContainerJustOpened = false;
        }, 400);
    }

    function showPopupContainer(name) {
        const container = document.querySelector(".popup")
        if (!container) return
        
        // Set flag to prevent immediate closing
        sideContainerJustOpened = true;
        
        container.setAttribute("data-section", name)
        container.style.display = "block"
        void container.offsetWidth
        container.style.transform = "translateX(0)"
        container.style.opacity = "1"
        
        // Reset flag after animation completes (300ms + small buffer)
        setTimeout(() => {
            sideContainerJustOpened = false;
        }, 400);
    }

    function closeSideSection(isPopup) {
        const container = $(isPopup ? ".popup" : ".side-container");
        if (!container) return
        if (!container.is(":visible")) return
        container.css("transform", `translateX(${isPopup ? "240" : "-140"}%)`)
        $(".sidebar button").removeClass("selected");
        setTimeout(() => {
            container.hide();
        }, 300);
    }

    function newEditor() {
        $.each(window.canvasList, function (id, canvas) {
            canvas.discardActiveObject();
            canvas.requestRenderAll();
        });
        var size = getSize();
        var width = size[0],
            height = size[1];
        var id = `editor${$(`#${mainContainerID} .content .editor`).length + 1}`;
        var deleteButton = "";
        if ($(".editor-container").length) {
            deleteButton = `<button data-role="deletePage" tooltip="Delete" class="btn"><i class="material-icons">delete</i></button>`;
        }
        $(`#${mainContainerID} .content`).append(`<div class="editor-container">
            <div class="editor-zoom-wrapper">
                <div class="editor-header">
                    <div><button data-role="pickColor" tooltip="Background color" class="btn"><span class="color-circle"></span></button></div>
                </div>
                <canvas color="#FFFFFF" width="${width}px" height="${height}px" class="editor" id='${id}'></canvas>
            </div>
        </div>`);
        var canvas = new fabric.Canvas(id, {
            enableRetinaScaling: false  // Keep at 1:1 to avoid quality issues with CSS zoom
        });
        canvas.defaultCursor = 'url(assets/images/mini-canvas/default-cursor.png) 5 2, auto';
        canvas.preserveObjectStacking = true;
        
        selectedCanvas = canvas;
        window.canvasList[id] = canvas;
        historyMap[id] = {
            history: [],
            current: -1,
            isUndoRedoing: false,
            isInitializing: true  // Flag to prevent saving during initialization
        };
        guidesMap[id] = []; // Initialize guides array for this canvas
        canvas.setBackgroundColor("#FFF", canvas.renderAll.bind(canvas));

        // When text is typed (e.g. diacritics ă, ș, ț from the latin-ext subset),
        // make sure the matching font subset is fetched, then re-render so the new
        // glyphs are drawn in the chosen font instead of a smaller fallback glyph.
        canvas.on("text:changed", function (e) {
            const obj = e && e.target;
            if (!obj || obj.type !== "i-text" || !obj.fontFamily) return;
            // Keep a forced letter case (uppercase/lowercase) enforced while typing.
            applyTextCaseToObject(obj);
            ensureFontLoaded(obj.fontFamily, obj.text || "", function () {
                canvas.requestRenderAll();
            });
        });
        
        // Save initial state and setup tracking AFTER canvas is fully initialized
        saveState(id);
        setupStateTracking(id);
        historyMap[id].isInitializing = false; // Initialization complete

        // Canva-style smart snapping system
        const SNAP_THRESHOLD = 6;
        const alignmentLines = [];
        
        canvas.on('object:moving', function (e) {
            const movingObj = e.target;
            if (!movingObj || movingObj.isTemporary) return;
            
            clearXGuides();

            // Hold Alt (or Ctrl) while dragging to temporarily disable the magnet
            // so the element can be placed freely, exactly where the cursor is.
            const domEvt = e.e || window.event;
            if (domEvt && (domEvt.altKey || domEvt.ctrlKey)) {
                movingObj.iscenter = false;
                movingObj.setCoords();
                return;
            }

            // Keep the snap distance consistent in on-screen pixels regardless of
            // the current zoom level. Without this, zooming in makes the magnet
            // feel sticky (a fixed canvas-pixel threshold covers a larger visual
            // area), which is what makes it "force" placement.
            const zoomFactor = (typeof currentZoom === 'number' && currentZoom > 0) ? currentZoom / 100 : 1;
            const snapThreshold = SNAP_THRESHOLD / zoomFactor;

            const movingRect = movingObj.getBoundingRect(true, true);
            const canvasWidth = canvas.width;
            const canvasHeight = canvas.height;
            
            // Calculate all edges and center of moving object
            const movingPoints = {
                left: movingRect.left,
                right: movingRect.left + movingRect.width,
                top: movingRect.top,
                bottom: movingRect.top + movingRect.height,
                centerX: movingRect.left + movingRect.width / 2,
                centerY: movingRect.top + movingRect.height / 2
            };
            
            // Canvas alignment points
            const canvasPoints = {
                centerX: canvasWidth / 2,
                centerY: canvasHeight / 2,
                left: 0,
                right: canvasWidth,
                top: 0,
                bottom: canvasHeight
            };
            
            let snaps = { x: null, y: null };
            let minDistX = snapThreshold;
            let minDistY = snapThreshold;
            let guideLines = [];

            
            // Check canvas center alignment
            let distX = Math.abs(movingPoints.centerX - canvasPoints.centerX);
            if (distX < minDistX) {
                minDistX = distX;
                snaps.x = { 
                    offset: canvasPoints.centerX - movingPoints.centerX,
                    guide: { x: canvasPoints.centerX, y1: 0, y2: canvasHeight }
                };
            }
            
            let distY = Math.abs(movingPoints.centerY - canvasPoints.centerY);
            if (distY < minDistY) {
                minDistY = distY;
                snaps.y = { 
                    offset: canvasPoints.centerY - movingPoints.centerY,
                    guide: { y: canvasPoints.centerY, x1: 0, x2: canvasWidth }
                };
            }
            
            // Check alignment with other objects
            canvas.getObjects().forEach(target => {
                if (target === movingObj || target.isTemporary || target.selectable === false) return;
                
                const targetRect = target.getBoundingRect(true, true);
                const targetPoints = {
                    left: targetRect.left,
                    right: targetRect.left + targetRect.width,
                    top: targetRect.top,
                    bottom: targetRect.top + targetRect.height,
                    centerX: targetRect.left + targetRect.width / 2,
                    centerY: targetRect.top + targetRect.height / 2
                };
                
                // Horizontal alignments (X-axis)
                const xChecks = [
                    { moving: 'left', target: 'left', offset: targetPoints.left - movingPoints.left },
                    { moving: 'left', target: 'centerX', offset: targetPoints.centerX - movingPoints.left },
                    { moving: 'left', target: 'right', offset: targetPoints.right - movingPoints.left },
                    { moving: 'centerX', target: 'left', offset: targetPoints.left - movingPoints.centerX },
                    { moving: 'centerX', target: 'centerX', offset: targetPoints.centerX - movingPoints.centerX },
                    { moving: 'centerX', target: 'right', offset: targetPoints.right - movingPoints.centerX },
                    { moving: 'right', target: 'left', offset: targetPoints.left - movingPoints.right },
                    { moving: 'right', target: 'centerX', offset: targetPoints.centerX - movingPoints.right },
                    { moving: 'right', target: 'right', offset: targetPoints.right - movingPoints.right }
                ];
                
                xChecks.forEach(check => {
                    const dist = Math.abs(check.offset);
                    if (dist < minDistX) {
                        minDistX = dist;
                        const guideX = targetPoints[check.target];
                        snaps.x = { 
                            offset: check.offset,
                            guide: { 
                                x: guideX, 
                                y1: Math.min(movingRect.top, targetRect.top), 
                                y2: Math.max(movingRect.top + movingRect.height, targetRect.top + targetRect.height)
                            }
                        };
                    }
                });
                
                // Vertical alignments (Y-axis)
                const yChecks = [
                    { moving: 'top', target: 'top', offset: targetPoints.top - movingPoints.top },
                    { moving: 'top', target: 'centerY', offset: targetPoints.centerY - movingPoints.top },
                    { moving: 'top', target: 'bottom', offset: targetPoints.bottom - movingPoints.top },
                    { moving: 'centerY', target: 'top', offset: targetPoints.top - movingPoints.centerY },
                    { moving: 'centerY', target: 'centerY', offset: targetPoints.centerY - movingPoints.centerY },
                    { moving: 'centerY', target: 'bottom', offset: targetPoints.bottom - movingPoints.centerY },
                    { moving: 'bottom', target: 'top', offset: targetPoints.top - movingPoints.bottom },
                    { moving: 'bottom', target: 'centerY', offset: targetPoints.centerY - movingPoints.bottom },
                    { moving: 'bottom', target: 'bottom', offset: targetPoints.bottom - movingPoints.bottom }
                ];
                
                yChecks.forEach(check => {
                    const dist = Math.abs(check.offset);
                    if (dist < minDistY) {
                        minDistY = dist;
                        const guideY = targetPoints[check.target];
                        snaps.y = { 
                            offset: check.offset,
                            guide: { 
                                y: guideY, 
                                x1: Math.min(movingRect.left, targetRect.left), 
                                x2: Math.max(movingRect.left + movingRect.width, targetRect.left + targetRect.width)
                            }
                        };
                    }
                });
            });
            
            // Apply snapping
            if (snaps.x) {
                movingObj.set({ left: movingObj.left + snaps.x.offset });
                guideLines.push(snaps.x.guide);
            }
            if (snaps.y) {
                movingObj.set({ top: movingObj.top + snaps.y.offset });
                guideLines.push(snaps.y.guide);
            }
            
            // Draw guide lines
            guideLines.forEach(guide => {
                if (guide.x !== undefined) {
                    // Vertical line
                    drawXGuides([guide.x, guide.y1, guide.x, guide.y2], null);
                } else if (guide.y !== undefined) {
                    // Horizontal line
                    drawXGuides(null, [guide.x1, guide.y, guide.x2, guide.y]);
                }
            });
            
            // Update center flag for text sizing
            const centerDistX = Math.abs(movingPoints.centerX - canvasPoints.centerX);
            movingObj.iscenter = centerDistX < 30;
            
            movingObj.setCoords();
        });

        canvas.on('object:modified', clearXGuides);
        canvas.on('selection:cleared', clearXGuides);
        // Safety net: always remove guide lines when the pointer is released, even
        // if 'object:modified' didn't fire (e.g. a tiny or cancelled drag).
        canvas.on('mouse:up', clearXGuides);

        canvas.on('object:rotating', function (e) {
            const obj = e.target;
            if (obj.angle > 350 || obj.angle < 10) {
                obj.rotate(0);
            } else if (obj.angle > 80 && obj.angle < 100) {
                obj.rotate(90);
            } else if (obj.angle > 170 && obj.angle < 190) {
                obj.rotate(180);
            } else if (obj.angle > 260 && obj.angle < 280) {
                obj.rotate(270);
            }
        });

        canvas.on('object:scaling', function (e) {
            scalingELM = e.target;
        });

        canvas.on('object:modified', function (e) {
            scalingELM = null;
            selectedCanvas = canvas;
        });

        canvas.add(drawingCircle);

        canvas.on('mouse:move', (e) => {
            if (drawingCircle && canvas.isDrawingMode && selectedBrush != "eraser") {
                canvas.bringToFront(drawingCircle);
                const pointer = canvas.getPointer(e.e);
                drawingCircle.set({
                    visible: true,
                    radius: brushOptions[selectedBrush].width / 2,
                    left: pointer.x - drawingCircle.radius,
                    top: pointer.y - drawingCircle.radius
                });
                canvas.renderAll();
            } else {
                drawingCircle.set({ visible: false, left: -2000, top: -2000 });
            }
        });

        canvas.on('mouse:up', (e) => {
            if (drawingCircle) {
                drawingCircle.set({ visible: true });
            }
        });

        /* SHOW HEADER BAR */
        canvas.on('object:added', function (e) { selectItem(e); });
        canvas.on('object:selected', function (e) { 
            selectItem(e);
            // Visual feedback for locked objects
            if (e.target && e.target.locked) {
                e.target.set({
                    borderColor: '#FF6B6B',
                    cornerColor: '#FF6B6B'
                });
                canvas.renderAll();
            }
        });
        canvas.on('object:moving', function () { $(".header-bar").remove(); });
        canvas.on('object:modified', function (e) { selectItem(e); });
        canvas.on('mouse:down', function (e) { selectItem(e); });

        canvas.on("before:selection:cleared", function (e) {
            setTimeout(() => {
                if (!headerbarClicked) {
                    $(".header-bar").remove();
                }
            }, 100);
            e.e?.preventDefault(0);
            e.cancel = true;
        });

        canvas.on("object:scaling", function (e) {
            if (e.target.type == "i-text") {
                $(".header-bar #fontSize").val((e.target.fontSize * e.target.scaleY).toFixed(2));
            }
        });

        return canvas;
    }

    tempContainer.on("mouseout mouseleave", 'canvas', function () {
        if (drawingCircle) {
            drawingCircle.set({ visible: false, left: -2000, top: -2000 });
        }
    });

    tempContainer.on("click", function (e) {
        if (!$(e.target).is(".header-bar button") && !$(e.target).closest(".header-bar button").length) {
            headerbarClicked = false;
        } else {
            headerbarClicked = true;
        }
    });

    tempContainer.on("mousedown", function (e) {
        if (
            !$(e.target).is("canvas") &&
            !$(e.target).closest("canvas").length &&
            !$(e.target).is(".header-bar button") &&
            !$(e.target).closest(".header-bar button").length &&
            $(e.target).is(".content") &&
            $(e.target).closest(".content").length
        ) {
            $.each(window.canvasList, function (id, canvas) {
                canvas.discardActiveObject();
                canvas.requestRenderAll();
            });
            $(".header-bar").remove();
            selectedItem = null;
        }
    });

    tempContainer.on("click", '[data-role="changeEffects"]', function () {
        selectedItem.defaultfill = selectedItem.fill;
        showSideContainer("texteffects");
        $(".side-container .title").text("Text Effects");
        $(".side-container .section-content").html(`
            <div class="texteffect-container">
                <button data-type="none" class="texteffect-button ${selectedItem.effectType == undefined ? "selected" : ""}"><img src="assets/images/mini-canvas/text-effect-normal.webp"><span>None</span></button>
                <button data-type="shadow" class="texteffect-button ${selectedItem.effectType == "shadow" ? "selected" : ""}"><img src="assets/images/mini-canvas/text-effect-shadow.webp"><span>Shadow</span></button>
                <button data-type="lift" class="texteffect-button ${selectedItem.effectType == "lift" ? "selected" : ""}"><img src="assets/images/mini-canvas/text-effect-lift.webp"><span>Lift</span></button>
                <button data-type="outline" class="texteffect-button ${selectedItem.effectType == "outline" ? "selected" : ""}"><img src="assets/images/mini-canvas/text-effect-outline.webp"><span>Outline</span></button>
            </div>
            <div class="texteffect-settings"></div>
        `);
        showEffectsSettings(selectedItem.effectType);
    });

    tempContainer.on("click", ".texteffect-button", function () {
        delete selectedItem.shadow;
        selectedItem.set({
            stroke: '#000',
            strokeWidth: 0
        });
        selectedItem.canvas?.renderAll();
        $(".texteffect-button").removeClass("selected");
        $(this).addClass("selected");
        var type = $(this).attr("data-type");
        showEffectsSettings(type);
    });

    function showEffectsSettings(type) {
        var settings = [];
        var defaultColor = "#000000";
        var settingsValues = {
            "offset": [0, 100],
            "direction": [-180, 180],
            "blur": [0, 100],
            "transparency": [0, 100],
            "intensity": [0, 100],
            "thickness": [0, 100]
        };
        selectedItem.effectType = type;
        if (type == "none") {
            delete selectedItem.effectType;
        } else if (type == "shadow") {
            const shadow = selectedItem.shadow || {};
            const offsetX = shadow.offsetX || 1.5;
            const offsetY = shadow.offsetY || 1.1;
            const offset = Math.round(Math.sqrt(offsetX * offsetX + offsetY * offsetY));
            const direction = Math.round(Math.atan2(offsetY, offsetX) * 180 / Math.PI);
            const color = shadow.color ? rgbaToHex(shadow.color, false) : defaultColor;
            const transparency = shadow.color ? getAlphaFromRgba(shadow.color) : 40;
            settings = { offset, direction, blur: shadow.blur || 0, transparency, color };
            applyShadowFromSettings(selectedItem, settings);
        } else if (type == "lift") {
            var intensity = getLiftIntensity(selectedItem);
            settings = { "intensity": intensity }
            applyLiftEffect(selectedItem, settings);
        } else if (type == "outline") {
            settings = { "thickness": getThickness(selectedItem), "color": selectedItem.stroke || defaultColor }
            applyOutlineEffect(selectedItem, settings);
        }
        var contentHTML = "";
        $.each(settings, function (name, value) {
            contentHTML += `${name == "color" ? `<div class="flex-between">` : ""}<span>${ucfirst(name)}</span>
            ${name != "color" ?
                    `<div class="range-container"><div range effect-settings-range name="${name}" min="${settingsValues[name][0]}" max="${settingsValues[name][1]}" value="${value}"></div><span class="range-display">${value}</span></div>` :
                    `<div class="colorPalette"><div color-elm val="${value}" class="texteffectcolor color"><span style="background-color: ${value};"></span></div></div></div>`}`;
        });
        $(".texteffect-settings").html(`<div class="effects-settings">${contentHTML}</div>`);
        $("[effect-settings-range]").each(function () {
            var this_elm = $(this);
            var min = parseInt($(this).attr("min"));
            var max = parseInt($(this).attr("max"));
            var value = parseInt($(this).attr("value"));
            this_elm.range(min, max, value, function (val) {
                this_elm.attr("value", val);
                this_elm.next().text(val);
                updateEffects();
            });
        });
    }

    function updateEffects(newSettings) {
        var newSettings = {};
        $("[effect-settings-range]").each(function () {
            newSettings[$(this).attr("name")] = parseInt($(this).attr("value"));
        });
        if ($(".texteffectcolor").length) {
            newSettings["color"] = $(".texteffectcolor").attr("val");
        }
        if (selectedItem.effectType == "shadow") {
            applyShadowFromSettings(selectedItem, newSettings);
        } else if (selectedItem.effectType == "lift") {
            applyLiftEffect(selectedItem, newSettings);
        } else if (selectedItem.effectType == "outline") {
            applyOutlineEffect(selectedItem, newSettings);
        }
    }

    function getThickness(object) {
        const maxStrokeWidth = 5;
        const currentStrokeWidth = object.strokeWidth || 0;
        return Math.round((currentStrokeWidth / maxStrokeWidth) * 100);
    }

    function getLiftIntensity(object) {
        if (object.shadow && object.effectType === "lift") {
            return object.shadow.blur;
        }
        return 0;
    }

    function applyOutlineEffect(object, settings) {
        var thickness = settings["thickness"] || 0;
        thickness = 0.25 + (thickness * 1.35 / 100);
        object.set({
            stroke: settings.color || '#000000',
            strokeWidth: thickness
        });
    }

    function applyLiftEffect(object, settings) {
        var intensity = 5 + (settings["intensity"] || 0) * (15 - 5) / 100;
        object.shadow = new fabric.Shadow({
            color: 'rgba(0, 0, 0, 1)',
            blur: intensity,
            offsetX: 1,
            offsetY: 1
        });
        object.canvas?.renderAll();
    }

    function applyShadowFromSettings(object, settings) {
        const { offset, direction, blur, transparency, color } = settings;
        const rad = (direction * Math.PI) / 180;
        const offsetX = offset * Math.cos(rad);
        const offsetY = offset * Math.sin(rad);
        const rgbaColor = hexToRgba(color, transparency);
        object.shadow = new fabric.Shadow({
            color: rgbaColor,
            blur: blur,
            offsetX: offsetX,
            offsetY: offsetY
        });
        object.canvas?.renderAll();
    }

    function getAlphaFromRgba(rgba) {
        const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]*)?\)/);
        if (!match) return 0;
        const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1;
        return Math.round((1 - alpha) * 100);
    }

    var textEffectColorElm;
    tempContainer.on("click", ".texteffectcolor", function () {
        textEffectColorElm = $(this);
        colorsPicker($(this).attr("val"), function (color) {
            if (textEffectColorElm) {
                textEffectColorElm.attr("val", color).find("span").css("background-color", color);
            }
            updateEffects();
        }, false, true);
    });

    tempContainer.on("click", '[data-role="switchText"]', function () {
        var action = $(this).attr("data-action");
        if (action == "italic") {
            selectedItem.set("fontStyle", selectedItem.fontStyle == "italic" ? "normal" : "italic");
            if (selectedItem.fontStyle == "italic") {
                $(this).addClass("active");
            } else {
                $(this).removeClass("active");
            }
        } else if (action == "bold") {
            selectedItem.set("fontWeight", selectedItem.fontWeight == "bold" ? "normal" : "bold");
            if (selectedItem.fontWeight == "bold") {
                $(this).addClass("active");
            } else {
                $(this).removeClass("active");
            }
        } else if (action == "underline") {
            selectedItem.set("underline", !selectedItem.underline);
            if (selectedItem.underline) {
                $(this).addClass("active");
            } else {
                $(this).removeClass("active");
            }
        } else if (action == "textAlign") {
            const alignments = ['left', 'center', 'right'];
            const currentIndex = alignments.indexOf(selectedItem.textAlign);
            const nextAlign = alignments[(currentIndex + 1) % alignments.length];
            selectedItem.set("textAlign", nextAlign);
            $(this).find("i.material-icons").each(function () {
                const current = $(this).text().replace("format_align_", "");
                const nextIndex = (alignments.indexOf(current) + 1) % alignments.length;
                const nextAlign = alignments[nextIndex];
                $(this).text("format_align_" + nextAlign);
            });
        } else if (action == "textCase") {
            // Cycle through: normal -> UPPERCASE -> lowercase -> normal.
            // `textCase` is a persisted custom property so the chosen case is
            // re-applied whenever the text is edited and at export time (even
            // after {INPUT_X} placeholder substitution in the backend).
            const order = ["none", "upper", "lower"];
            const current = selectedItem.textCase || "none";
            const next = order[(order.indexOf(current) + 1) % order.length];
            selectedItem.set("textCase", next);
            applyTextCaseToObject(selectedItem);
            const label = next == "upper" ? "AA" : next == "lower" ? "aa" : "Aa";
            $(this).find(".text-case-label").text(label);
            if (next == "none") {
                $(this).removeClass("active");
            } else {
                $(this).addClass("active");
            }
            selectedCanvas.requestRenderAll();
        }
    });

    tempContainer.on("click", '[data-role="changeTextColor"]', function () {
        colorsPicker(selectedItem.fill, function (color) {
            selectedItem.set("fill", color);
            $(".header-bar .color-bar").css("background-color", color);
        }, false);
    });

    var changeTextSizeInterv;
    tempContainer.on("mousedown", '[data-role="changeTextSize"]', function () {
        var action = $(this).attr("data-action");
        if (selectedItem) {
            c(this);
            changeTextSizeInterv = setInterval(() => { c(this); }, 100);
            function c(el) {
                var newSize = selectedItem.fontSize + (action == "minus" ? -1 : 1);
                $(el).parent().find("input").val((newSize * selectedItem.scaleY).toFixed(2));
                selectedItem.set('fontSize', newSize);
            }
        }
    });

    tempContainer.on("mouseup mouseleave", function () {
        clearInterval(changeTextSizeInterv);
    });

    tempContainer.on("click", '[data-role="moveZIndex"]', function () {
        if (!selectedItem) return;
        var action = $(this).attr("data-action");
        var elements = [selectedItem];

        // If it's a parent, collect children
        if (selectedItem.id) {
            selectedCanvas.getObjects().forEach(obj => {
                if (obj.parent && obj.parent === selectedItem.id) {
                    elements.push(obj);
                }
            });
        }

        // If it's a child, collect its parent
        if (selectedItem.parent) {
            selectedCanvas.getObjects().forEach(obj => {
                if (obj.id && obj.id === selectedItem.parent) {
                    elements.push(obj);
                }
            });
        }

        // Apply z-index move
        elements.forEach(el => {
            if (action === "back") {
                selectedCanvas.sendBackwards(el);
            } else if (action === "front") {
                selectedCanvas.bringForward(el);
            }
        });

        selectedCanvas.renderAll();
    });


    tempContainer.on("click", '[data-role="duplicateELM"]', function () {
        console.log('=== DUPLICATE CLICKED ===');
        console.log('Selected item:', selectedItem);
        console.log('Has id:', selectedItem.id);
        console.log('Has linkedTextId:', selectedItem.linkedTextId);
        console.log('Has parent:', selectedItem.parent);
        console.log('Has linkedRectId:', selectedItem.linkedRectId);
        console.log('Type:', selectedItem.type);
        
        // Check if this is a rectangle with linked text
        if (selectedItem.id && selectedItem.linkedTextId) {
            console.log('Detected as rectangle with linked text');
            // This is a rectangle, find its linked text
            const linkedText = selectedCanvas.getObjects().find(o => o.id === selectedItem.linkedTextId);
            
            // Clone the rectangle
            selectedItem.clone(function (clonedRect) {
                const newRandID = Math.random().toString(36).substring(10, 17);
                clonedRect.set({
                    left: selectedItem.left + 20,
                    top: selectedItem.top + 20,
                    evented: true,
                    id: newRandID
                });
                
                // Clone the linked text if it exists
                if (linkedText) {
                    linkedText.clone(function (clonedText) {
                        const newTextId = Date.now();
                        clonedText.set({
                            left: clonedRect.left + clonedRect.width * clonedRect.scaleX / 2,
                            top: clonedRect.top + clonedRect.height * clonedRect.scaleY / 2,
                            evented: true,
                            parent: newRandID,
                            id: newTextId
                        });
                        
                        // Set up the linking
                        clonedRect.linkedTextId = newTextId;
                        clonedText.linkedRectId = newTextId;
                        
                        // Add both to canvas
                        selectedCanvas.add(clonedRect, clonedText);
                        
                        // Set up event handlers for the cloned rect
                        function updateTextPosition() {
                            clonedText.set({
                                left: clonedRect.left + clonedRect.width * clonedRect.scaleX / 2,
                                top: clonedRect.top + clonedRect.height * clonedRect.scaleY / 2
                            });
                            clonedText.setCoords();
                            selectedCanvas.requestRenderAll();
                        }
                        
                        clonedRect.on("moving", updateTextPosition);
                        clonedRect.on("scaling", updateTextPosition);
                        clonedRect.on("modified", updateTextPosition);
                        
                        selectedCanvas.setActiveObject(clonedText);
                        selectedCanvas.renderAll();
                    }, ['locked', 'parent']);
                } else {
                    // No linked text, just add the rectangle
                    selectedCanvas.add(clonedRect);
                    selectedCanvas.setActiveObject(clonedRect);
                    selectedCanvas.renderAll();
                }
            }, ['locked', 'id', 'linkedTextId']);
            
        } else if (selectedItem.parent && selectedItem.linkedRectId) {
            // This is a text with linked rectangle, find the rectangle
            const linkedRect = selectedCanvas.getObjects().find(o => o.linkedTextId === selectedItem.linkedRectId);
            
            if (linkedRect) {
                // Clone the rectangle first
                linkedRect.clone(function (clonedRect) {
                    const newRandID = Math.random().toString(36).substring(10, 17);
                    clonedRect.set({
                        left: linkedRect.left + 20,
                        top: linkedRect.top + 20,
                        evented: true,
                        id: newRandID
                    });
                    
                    // Clone the text
                    selectedItem.clone(function (clonedText) {
                        const newTextId = Date.now();
                        clonedText.set({
                            left: clonedRect.left + clonedRect.width * clonedRect.scaleX / 2,
                            top: clonedRect.top + clonedRect.height * clonedRect.scaleY / 2,
                            evented: true,
                            parent: newRandID,
                            id: newTextId
                        });
                        
                        // Set up the linking
                        clonedRect.linkedTextId = newTextId;
                        clonedText.linkedRectId = newTextId;
                        
                        // Add both to canvas
                        selectedCanvas.add(clonedRect, clonedText);
                        
                        // Set up event handlers for the cloned rect
                        function updateTextPosition() {
                            clonedText.set({
                                left: clonedRect.left + clonedRect.width * clonedRect.scaleX / 2,
                                top: clonedRect.top + clonedRect.height * clonedRect.scaleY / 2
                            });
                            clonedText.setCoords();
                            selectedCanvas.requestRenderAll();
                        }
                        
                        clonedRect.on("moving", updateTextPosition);
                        clonedRect.on("scaling", updateTextPosition);
                        clonedRect.on("modified", updateTextPosition);
                        
                        selectedCanvas.setActiveObject(clonedText);
                        selectedCanvas.renderAll();
                    }, ['locked', 'parent', 'linkedRectId']);
                }, ['locked', 'id', 'linkedTextId']);
            }
        } else {
            // Regular object without links
            selectedItem.clone(function (clonedObj) {
                clonedObj.set({
                    left: selectedItem.left + 20,
                    top: selectedItem.top + 20,
                    evented: true
                });
                selectedCanvas.add(clonedObj);
                selectedCanvas.discardActiveObject();
                selectedCanvas.setActiveObject(clonedObj);
                selectedCanvas.renderAll();
            }, ['locked']); // Include locked property
        }
    });

    tempContainer.on("change", "#fontSize", function () {
        selectedItem.set("fontSize", $(this).val());
    });

    tempContainer.on("click", '[data-role="changeOpacity"]', function () {
        $(".border-radius-container").hide();
        $(".opacity-container").toggle();
    });

    tempContainer.on("click", '[data-role="changeBorderRadius"]', function () {
        $(".opacity-container").hide();
        $(".border-radius-container").toggle();
    });

    tempContainer.on("click", '[data-role="toggleLock"]', function () {
        if (!selectedItem) return;
        
        const isLocked = !selectedItem.locked;
        selectedItem.locked = isLocked;
        
        // Update lock state visually
        // Keep evented:true and selectable:true so locked objects can be selected
        // in marquee selections and individual clicks
        selectedItem.set({
            lockMovementX: isLocked,
            lockMovementY: isLocked,
            lockScalingX: isLocked,
            lockScalingY: isLocked,
            lockRotation: isLocked,
            selectable: true,
            hasControls: !isLocked,
            hasBorders: !isLocked,
            evented: true
        });
        
        // Update button UI
        const btn = $(this);
        btn.toggleClass('active', isLocked);
        btn.attr('tooltip', isLocked ? 'Unlock' : 'Lock');
        btn.find('i').text(isLocked ? 'lock' : 'lock_open');
        
        selectedCanvas.requestRenderAll();
    });

    tempContainer.on("click", '[data-role="deleteELM"]', deleteSelectedElm);


    /* TOOLS AREA */
    tempContainer.on("click", '[data-role="tools"]', function () {
        closeSideSection(); closeSideSection(true);
    });

    // Comprehensive keyboard shortcuts for MiniCanvas
    $(document).keydown(function (e) {
        // Ignore if user is typing in an input/textarea
        if ($(e.target).is('input, textarea')) {
            return;
        }
        
        // Check if we're in the minicanvas editor
        if (!selectedCanvas || $('#mini-canvas-editor').length === 0) {
            return;
        }
        
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlKey = isMac ? e.metaKey : e.ctrlKey;
        
        // Ctrl/Cmd + Z: Undo
        if (ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            e.preventDefault();
            performUndo();
            return;
        }
        
        // Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z: Redo
        if ((ctrlKey && e.key.toLowerCase() === 'y') || (ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) {
            e.preventDefault();
            performRedo();
            return;
        }
        
        // Ctrl/Cmd + S: Save
        if (ctrlKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            $('[data-role="save"]').trigger('click');
            return;
        }
        
        // Ctrl/Cmd + C: Copy
        if (ctrlKey && e.key.toLowerCase() === 'c') {
            const activeObject = selectedCanvas.getActiveObject();
            if (activeObject) {
                e.preventDefault();
                activeObject.clone(function (cloned) {
                    clipboard = cloned;
                }, ['locked']); // Include locked property
            }
            return;
        }
        
        // Ctrl/Cmd + X: Cut
        if (ctrlKey && e.key.toLowerCase() === 'x') {
            const activeObject = selectedCanvas.getActiveObject();
            if (activeObject) {
                e.preventDefault();
                
                // Check if any locked objects in selection
                if (activeObject.type === 'activeSelection') {
                    const lockedCount = activeObject.getObjects().filter(obj => obj.locked).length;
                    if (lockedCount > 0) {
                        return;
                    }
                } else if (activeObject.locked) {
                    return;
                }
                
                activeObject.clone(function (cloned) {
                    clipboard = cloned;
                    
                    if (activeObject.type === 'activeSelection') {
                        activeObject.getObjects().forEach(function (obj) {
                            selectedCanvas.remove(obj);
                        });
                    } else {
                        selectedCanvas.remove(activeObject);
                    }
                    
                    selectedCanvas.discardActiveObject();
                    selectedCanvas.renderAll();
                }, ['locked']);
            }
            return;
        }
        
        // Ctrl/Cmd + V: Paste
        if (ctrlKey && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            if (clipboard) {
                clipboard.clone(function (clonedObj) {
                    selectedCanvas.discardActiveObject();
                    
                    // Offset the pasted object
                    clonedObj.set({
                        left: clonedObj.left + 20,
                        top: clonedObj.top + 20,
                        evented: true
                    });
                    
                    if (clonedObj.type === 'activeSelection') {
                        // Handle multiple objects
                        clonedObj.canvas = selectedCanvas;
                        clonedObj.forEachObject(function (obj) {
                            selectedCanvas.add(obj);
                        });
                        clonedObj.setCoords();
                    } else {
                        selectedCanvas.add(clonedObj);
                    }
                    
                    // Update clipboard for next paste
                    clipboard.top += 20;
                    clipboard.left += 20;
                    
                    selectedCanvas.setActiveObject(clonedObj);
                    selectedCanvas.renderAll();
                }, ['locked']);
            }
            return;
        }
        
        // Ctrl/Cmd + D: Duplicate
        if (ctrlKey && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            const activeObject = selectedCanvas.getActiveObject();
            if (activeObject) {
                activeObject.clone(function (clonedObj) {
                    selectedCanvas.discardActiveObject();
                    clonedObj.set({
                        left: clonedObj.left + 20,
                        top: clonedObj.top + 20,
                        evented: true
                    });
                    
                    if (clonedObj.type === 'activeSelection') {
                        clonedObj.canvas = selectedCanvas;
                        clonedObj.forEachObject(function (obj) {
                            selectedCanvas.add(obj);
                        });
                        clonedObj.setCoords();
                    } else {
                        selectedCanvas.add(clonedObj);
                    }
                    
                    selectedCanvas.setActiveObject(clonedObj);
                    selectedCanvas.renderAll();
                }, ['locked']);
            }
            return;
        }
        
        // Ctrl/Cmd + A: Select All
        if (ctrlKey && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            const objects = selectedCanvas.getObjects().filter(obj =>
                obj.selectable === true &&
                (obj.isTemporary === false || obj.isTemporary === undefined)
            );

            if (objects.length > 0) {
                const selection = new fabric.ActiveSelection(objects, {
                    canvas: selectedCanvas
                });
                selectedCanvas.setActiveObject(selection);
                selectedCanvas.requestRenderAll();
            }
            return;
        }
        
        // Delete key: Delete selected object
        if (e.key === 'Delete' || e.keyCode === 46) {
            const activeObject = selectedCanvas.getActiveObject();
            if (activeObject) {
                if (activeObject.type === 'activeSelection') {
                    const lockedCount = activeObject.getObjects().filter(obj => obj.locked).length;
                    if (lockedCount > 0) {
                        return;
                    }
                    activeObject.getObjects().forEach(function (obj) {
                        selectedCanvas.remove(obj);
                    });
                } else {
                    if (activeObject.locked) {
                        return;
                    }
                    selectedCanvas.remove(activeObject);
                }
                selectedCanvas.discardActiveObject();
                selectedCanvas.renderAll();
            }
            return;
        }
        
        // Escape: Deselect all
        if (e.key === 'Escape' || e.keyCode === 27) {
            selectedCanvas.discardActiveObject();
            selectedCanvas.renderAll();
            $(".header-bar").remove();
            return;
        }
        
        // Arrow keys: Move selected object (1px normal, 10px with Shift)
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            const activeObject = selectedCanvas.getActiveObject();
            if (activeObject && !activeObject.locked) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                
                if (e.key === 'ArrowUp') activeObject.top -= step;
                if (e.key === 'ArrowDown') activeObject.top += step;
                if (e.key === 'ArrowLeft') activeObject.left -= step;
                if (e.key === 'ArrowRight') activeObject.left += step;
                
                activeObject.setCoords();
                selectedCanvas.renderAll();
            }
            return;
        }
    });


    function deleteSelectedElm() {
        if (selectedCanvas && selectedItem) {
            if (selectedItem.locked) {
                return;
            }
            selectedCanvas.remove(selectedItem);
            selectedItem = null;
            $(".header-bar").remove();
            selectedCanvas.renderAll();
        }
    }

    var selectedColorIndex;
    function selectItem(e = null) {
        var target = e.target;
        if (!target) return;
        const type = target.type;
        selectedItem = e.target;
        if (!target.isTemporary) {
            $(".header-bar").remove();
            if (type === 'text' || type === 'i-text') {
                $(".header-bar-container").append(`<div class="header-bar">
                    <button data-role="toggleLock" class="${target.locked ? 'active' : ''}" tooltip="${target.locked ? 'Unlock' : 'Lock'}"><i class="material-icons">${target.locked ? 'lock' : 'lock_open'}</i></button>
                    <button data-role="font" class="font-name">${target.fontFamily}</button>
                    <div class="number-group-input">
                        <button data-role="changeTextSize" data-action="minus"><i class="material-icons">remove</i></button>
                        <input id="fontSize" type="number" value="${(target.fontSize * target.scaleY).toFixed(2)}">
                        <button data-role="changeTextSize" data-action="plus"><i class="material-icons">add</i></button>
                    </div>
                    <button data-role="changeOpacity"><img width="20" src="assets/images/mini-canvas/opacity.png"></button>
                    <div class="p-relative">
                        <div class="opacity-container">
                            <span>Opacity</span>
                            <div range class="opacity-range"></div>
                        </div>
                    </div>
                    <button data-role="changeTextColor"><i class="material-icons">match_case</i><span class="color-bar" style="background-color: ${target.fill};"></span></button>
                    <button data-role="switchText" data-action="bold" ${target.fontWeight == "bold" ? 'class="active"' : ""}><i class="material-icons">format_bold</i></button>
                    <button data-role="switchText" data-action="italic" ${target.fontStyle == "italic" ? 'class="active"' : ""}><i class="material-icons">format_italic</i></button>
                    <button data-role="switchText" data-action="underline" ${target.underline == true ? 'class="active"' : ""}><i class="material-icons">format_underlined</i></button>
                    <button data-role="switchText" data-action="textCase" tooltip="Letter case (normal / UPPERCASE / lowercase)" ${target.textCase == "upper" || target.textCase == "lower" ? 'class="active"' : ""}><span class="text-case-label">${target.textCase == "upper" ? "AA" : target.textCase == "lower" ? "aa" : "Aa"}</span></button>
                    <button data-role="changeEffects" data-action="front"><span>Effects</span></button>
                    <button data-role="switchText" data-action="textAlign"><i class="material-icons">format_align_${target.textAlign}</i></button>
                    <button data-role="moveZIndex" data-action="back"><i class="material-icons">arrow_cool_down</i> <span>Back</span></button>
                    <button data-role="moveZIndex" data-action="front"><i class="material-icons">arrow_warm_up</i> <span>Front</span></button>
                    <button data-role="duplicateELM"><i class="material-icons">content_copy</i></button>
                    <button data-role="deleteELM"><i class="material-icons">delete</i></button>
                </div>`);
                $(".opacity-range").range(0, 100, parseInt(selectedItem.opacity * 100), function (val) {
                    selectedItem.set({ opacity: parseInt(val) / 100 });
                    selectedCanvas.requestRenderAll();
                });
            } else if (type === 'image') {
                $(".header-bar-container").append(`<div class="header-bar">
                    <button data-role="toggleLock" class="${target.locked ? 'active' : ''}" tooltip="${target.locked ? 'Unlock' : 'Lock'}"><i class="material-icons">${target.locked ? 'lock' : 'lock_open'}</i></button>
                    <button data-role="changeOpacity"><img width="20" src="assets/images/mini-canvas/opacity.png"></button>
                    <button data-role="changeBorderRadius" tooltip="Border Radius"><i class="material-icons">rounded_corner</i></button>
                    <div class="p-relative">
                        <div class="opacity-container">
                            <span>Opacity</span>
                            <div range class="opacity-range"></div>
                        </div>
                        <div class="border-radius-container">
                            <span>Radius</span>
                            <div range class="border-radius-range"></div>
                        </div>
                    </div>
                    <button data-role="moveZIndex" data-action="back"><i class="material-icons">arrow_cool_down</i> <span>Back</span></button>
                    <button data-role="moveZIndex" data-action="front"><i class="material-icons">arrow_warm_up</i> <span>Front</span></button>
                    <button data-role="duplicateELM"><i class="material-icons">content_copy</i></button>
                    <button data-role="deleteELM"><i class="material-icons">delete</i></button>
                </div>`);
                $(".opacity-range").range(0, 100, parseInt(selectedItem.opacity * 100), function (val) {
                    selectedItem.set({ opacity: parseInt(val) / 100 });
                    selectedCanvas.requestRenderAll();
                });
                // Calculate max radius - use half of the smallest dimension to create a perfect circle
                const maxRadius = Math.min(selectedItem.width, selectedItem.height) / 2;
                const currentRadius = selectedItem.clipPath?.rx || 0;
                $(".border-radius-range").range(0, maxRadius, Math.min(currentRadius, maxRadius), function (val) {
                    const radius = parseInt(val);
                    if (radius > 0) {
                        const rect = new fabric.Rect({
                            width: selectedItem.width,
                            height: selectedItem.height,
                            rx: radius,
                            ry: radius,
                            originX: 'center',
                            originY: 'center'
                        });
                        selectedItem.set({ clipPath: rect });
                    } else {
                        selectedItem.set({ clipPath: null });
                    }
                    selectedCanvas.requestRenderAll();
                });
            } else if ((type === 'group' && target._objects?.some(obj => obj.type === 'path' || obj.type === 'circle' || obj.type === 'rect')) || ['path', 'circle', 'rect', 'polygon', 'line'].includes(type)) {
                if (type == "group" && typeof target.getObjects() === "function") {
                    if (target.getObjects()[0].selectable == false) {
                        return;
                    }
                }
                var colorsELM = "";
                $.each(getSVGColors(target), function (k, v) {
                    colorsELM += `<div color-elm index="${k}" val="${v}" class="color-selector"><span style="background-color: ${v};"></span></div>`;
                });
                
                // Add border radius control for rect shapes
                const showBorderRadius = type === 'rect' || (type === 'group' && target._objects?.some(obj => obj.type === 'rect'));
                const borderRadiusButton = showBorderRadius ? `<button data-role="changeBorderRadius" tooltip="Border Radius"><i class="material-icons">rounded_corner</i></button>` : '';
                
                $(".header-bar-container").append(`<div class="header-bar">
                    <button data-role="toggleLock" class="${target.locked ? 'active' : ''}" tooltip="${target.locked ? 'Unlock' : 'Lock'}"><i class="material-icons">${target.locked ? 'lock' : 'lock_open'}</i></button>
                    ${colorsELM}
                    <button data-role="changeOpacity"><img width="20" src="assets/images/mini-canvas/opacity.png"></button>
                    ${borderRadiusButton}
                    <div class="p-relative">
                        <div class="opacity-container">
                            <span>Opacity</span>
                            <div range class="opacity-range"></div>
                        </div>
                        ${showBorderRadius ? `<div class="border-radius-container">
                            <span>Radius</span>
                            <div range class="border-radius-range"></div>
                        </div>` : ''}
                    </div>
                    <button data-role="moveZIndex" data-action="back"><i class="material-icons">arrow_cool_down</i> <span>Back</span></button>
                    <button data-role="moveZIndex" data-action="front"><i class="material-icons">arrow_warm_up</i> <span>Front</span></button>
                    <button data-role="duplicateELM"><i class="material-icons">content_copy</i></button>
                    <button data-role="deleteELM"><i class="material-icons">delete</i></button>
                </div>`);
                $(".opacity-range").range(0, 100, parseInt(selectedItem.opacity * 100), function (val) {
                    selectedItem.set({ opacity: parseInt(val) / 100 });
                    selectedCanvas.requestRenderAll();
                });
                
                // Setup border radius control for rect shapes
                if (showBorderRadius) {
                    let maxRadius, currentRadius;
                    
                    if (type === 'rect') {
                        // Calculate max radius - use half of the smallest dimension to create a perfect circle
                        maxRadius = Math.min(selectedItem.width, selectedItem.height) / 2;
                        currentRadius = selectedItem.rx || 0;
                    } else {
                        // For groups, find the smallest rect and use its dimensions
                        const rectObjs = selectedItem._objects.filter(obj => obj.type === 'rect');
                        if (rectObjs.length > 0) {
                            const smallestDimension = Math.min(...rectObjs.map(obj => Math.min(obj.width, obj.height)));
                            maxRadius = smallestDimension / 2;
                            currentRadius = rectObjs[0].rx || 0;
                        }
                    }
                    
                    $(".border-radius-range").range(0, maxRadius, Math.min(currentRadius, maxRadius), function (val) {
                        const radius = parseInt(val);
                        if (type === 'rect') {
                            selectedItem.set({ rx: radius, ry: radius });
                        } else if (type === 'group') {
                            // Apply to all rect objects in the group
                            selectedItem._objects.forEach(obj => {
                                if (obj.type === 'rect') {
                                    obj.set({ rx: radius, ry: radius });
                                }
                            });
                        }
                        selectedCanvas.requestRenderAll();
                    });
                }
            }
        }
    }

    tempContainer.on("click", ".header-bar [color-elm]", function () {
        selectedColorIndex = parseInt($(this).attr("index"));
        colorElement = $(this);
        var isMultipleColors = (typeof selectedItem.getObjects === "function");
        colorsPicker($(this).attr("val"), function (color) {
            var style = getStyle(color);
            if (colorElement) {
                colorElement.attr("val", color).html(`<span style="${style}"></span>`);
                colorElement.find("span").css("background-color", color);
            }
            editSVGColorByIndex(selectedItem, selectedColorIndex, color);
        }, !isMultipleColors);
    });

    function getAngleFromCoords(coords) {
        const dx = coords.x2 - coords.x1;
        const dy = coords.y2 - coords.y1;
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        return Math.round((angle + 360) % 360);
    }

    function getColorKey(value) {
        if (typeof value === "string") return value.trim().toLowerCase();

        if (value?.type === "linear" && Array.isArray(value.colorStops)) {
            const angle = getAngleFromCoords(value.coords);
            const stops = value.colorStops.map(s => s.color.trim().toLowerCase());
            return `${angle}deg,${stops.join(",")}`;
        }

        return "unknown";
    }

    function getSVGColors(svgObject) {
        const colors = new Set();

        const process = (obj) => {
            if (obj.fill) colors.add(getColorKey(obj.fill));
            if (obj.stroke) colors.add(getColorKey(obj.stroke));
        };

        if (typeof svgObject.getObjects === "function") {
            svgObject.getObjects().forEach(process);
        } else {
            process(svgObject);
        }

        return Array.from(colors);
    }


    function editSVGColorByIndex(svgObject, index, colorInput) {
        const colors = getSVGColors(svgObject);
        const targetColorKey = colors[index];
        if (!targetColorKey) return;

        const applyColorChange = (obj) => {
            if (getColorKey(obj.fill) === targetColorKey) {
                obj.set({ fill: parseColorOrGradient(obj, colorInput, 'fill') });
            }
            if (getColorKey(obj.stroke) === targetColorKey) {
                obj.set({ stroke: parseColorOrGradient(obj, colorInput, 'stroke') });
            }
        };

        if (typeof svgObject.getObjects === "function") {
            svgObject.getObjects().forEach(applyColorChange);
        } else {
            applyColorChange(svgObject);
        }

        svgObject.canvas?.requestRenderAll();
    }

    function parseColorOrGradient(obj, input, type) {
        if (!input.includes("deg,")) return input;
        const [angleStr, ...colors] = input.split(",");
        const angle = parseInt(angleStr);
        const radians = angle * (Math.PI / 180);
        const cos = Math.cos(radians), sin = Math.sin(radians);
        return new fabric.Gradient({
            type: 'linear',
            gradientUnits: 'percentage',
            coords: {
                x1: 0.5 - 0.5 * cos,
                y1: 0.5 - 0.5 * sin,
                x2: 0.5 + 0.5 * cos,
                y2: 0.5 + 0.5 * sin,
            },
            colorStops: colors.map((color, i) => ({
                offset: i / (colors.length - 1),
                color: color.trim()
            })),
        });
    }


    function applyCanvaStyleControls(object) {
        function drawControlWithShadow(ctx, drawShape) {
            ctx.save();
            ctx.shadowColor = '#000';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            ctx.fillStyle = '#fff';
            drawShape(ctx);
            ctx.fill();
            ctx.restore();
        }

        function renderCircle(ctx, left, top) {
            drawControlWithShadow(ctx, () => {
                ctx.beginPath();
                ctx.arc(left, top, 4, 0, Math.PI * 2);
            });
        }

        function renderRotatedRoundedRect(ctx, left, top, width, height, angleRad, radius = 4) {
            drawControlWithShadow(ctx, () => {
                ctx.translate(left, top);
                ctx.rotate(angleRad);
                const x = -width / 2;
                const y = -height / 2;
                const r = Math.min(radius, width / 2, height / 2);
                ctx.beginPath();
                ctx.moveTo(x + r, y);
                ctx.lineTo(x + width - r, y);
                ctx.quadraticCurveTo(x + width, y, x + width, y + r);
                ctx.lineTo(x + width, y + height - r);
                ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
                ctx.lineTo(x + r, y + height);
                ctx.quadraticCurveTo(x, y + height, x, y + height - r);
                ctx.lineTo(x, y + r);
                ctx.quadraticCurveTo(x, y, x + r, y);
                ctx.closePath();
                ctx.rotate(-angleRad);
                ctx.translate(-left, -top);
            });
        }

        ['tl', 'tr', 'bl', 'br'].forEach(corner => {
            object.controls[corner].render = renderCircle;
        });

        object.controls.mt.render = (ctx, left, top, styleOverride, fabricObject) =>
            renderRotatedRoundedRect(ctx, left, top, 20, 5, fabric.util.degreesToRadians(fabricObject.angle), 5);

        object.controls.mb.render = (ctx, left, top, styleOverride, fabricObject) =>
            renderRotatedRoundedRect(ctx, left, top, 20, 5, fabric.util.degreesToRadians(fabricObject.angle), 5);

        object.controls.ml.render = (ctx, left, top, styleOverride, fabricObject) =>
            renderRotatedRoundedRect(ctx, left, top, 5, 20, fabric.util.degreesToRadians(fabricObject.angle), 5);

        object.controls.mr.render = (ctx, left, top, styleOverride, fabricObject) =>
            renderRotatedRoundedRect(ctx, left, top, 5, 20, fabric.util.degreesToRadians(fabricObject.angle), 5);

        object.controls.mtr.render = renderCircle;
        object.setControlsVisibility({ mtr: true });
    }

    function clearXGuides() {
        if (!selectedCanvas) return;
        const canvasId = selectedCanvas.lowerCanvasEl.id;
        if (!guidesMap[canvasId]) {
            guidesMap[canvasId] = [];
        }
        
        // Remove all guide lines from canvas
        guidesMap[canvasId].forEach(line => {
            selectedCanvas.remove(line);
        });
        guidesMap[canvasId] = [];
    }

    function drawXGuides(fline, sline) {
        if (!selectedCanvas) return;
        const canvasId = selectedCanvas.lowerCanvasEl.id;
        if (!guidesMap[canvasId]) {
            guidesMap[canvasId] = [];
        }
        
        if (fline) {
            const line1 = new fabric.Line(fline, {
                stroke: '#FF00FF',
                strokeWidth: 1.5,
                selectable: false,
                evented: false,
                isTemporary: true
            });
            guidesMap[canvasId].push(line1);
            selectedCanvas.add(line1);
        }
        if (sline) {
            const line2 = new fabric.Line(sline, {
                stroke: '#FF00FF',
                strokeWidth: 1.5,
                selectable: false,
                evented: false,
                isTemporary: true
            });
            guidesMap[canvasId].push(line2);
            selectedCanvas.add(line2);
        }
        if (fline || sline) {
            selectedCanvas.renderAll();
        }
    }

    function updateGradients() {
        var deg = $(".gradient-styles .gradient-style.selected").attr("val")
        var gardient = [];
        var val = [];
        var percOff = 100 / ($("#gradient-picker-container .colorPalette [color-elm]").length - 1);
        var currentPerc = 0;
        $("#gradient-picker-container .colorPalette [color-elm]").each(function () {
            gardient.push(`${$(this).attr("val")} ${currentPerc}%`);
            val.push($(this).attr("val"));
            currentPerc += percOff;
        });

        var newval = [deg];
        for (var i = 0; i < val.length; i++) {
            newval.push(val[i]);
        }

        if (colorElement) {
            colorElement
                .attr("val", newval.join(","))
                .find("span")
                .css("background", "linear-gradient(" + deg + "," + gardient.join(", ") + ")");
        }
        return newval.join(",");
    }

    function frame() {
        $(".editor").each(function () {
            var size = getSize();
            var width = size[0],
                height = size[1];
            $.each(window.canvasList, function (id, canvas) {
                updateImageInputsSelect(canvas);
                const objects = canvas.getObjects();
                const scaleX = width / canvas.getWidth();
                const scaleY = height / canvas.getHeight();
                if (canvas.getWidth() != width || canvas.getHeight() != height) {
                    canvas.setWidth(width);
                    canvas.setHeight(height);
                }
                objects.forEach(obj => {
                    obj.scaleX *= scaleX;
                    obj.scaleY *= scaleY;
                    obj.left *= scaleX;
                    obj.top *= scaleY;
                    obj.setCoords();
                });
                var canvas_elm = $(`canvas#${id}`);
                if (!canvas_elm.attr("color").includes(",")) {
                    canvas.setBackgroundColor(
                        canvas_elm.attr("color"),
                        canvas.renderAll.bind(canvas)
                    );
                } else {
                    const gradient = parseGradientToFabric(canvas_elm.attr("color"), canvas);
                    canvas.setBackgroundColor(gradient, canvas.renderAll.bind(canvas));
                }
                if (canvas.backgroundImage) {
                    const bgImg = canvas.backgroundImage;
                    bgImg.scaleX *= scaleX;
                    bgImg.scaleY *= scaleY;
                    bgImg.left *= scaleX;
                    bgImg.top *= scaleY;
                    bgImg.setCoords();
                }
            });
        });
        $(".header-bar-container").css({ "display": "flex" });
        $("[issvg]").each(function () {
            var svg = $(this).attr("src");
            var $this = $(this);
            if (svg) {
                $.get(svg, function (data) {
                    var $svg = $(data).find('svg');
                    $this.replaceWith($svg);
                });
            }
        });
        var selectedObjects = 0;
        $.each(window.canvasList, function (k, canvas) { selectedObjects += canvas.getActiveObjects(); });
        if (selectedObjects == 0) {
            $(".header-bar").remove();
        }
        var index = 0, selectedCanvasIndex = 1;
        $.each(window.canvasList, function (k, canvas) {
            index++;
            if (canvas == selectedCanvas) {
                selectedCanvasIndex = index;
            }
        });
        
        // Initialize undo/redo button states
        updateUndoRedoButtons();
    }
    
    // Helper function to reset history after loading a template
    window.__resetMiniCanvasHistory = function() {
        if (!selectedCanvas) return;
        const id = selectedCanvas.lowerCanvasEl.id;
        const history = historyMap[id];
        if (history) {
            // Clear all history and save just the current state as the new initial state
            history.history = [];
            history.current = -1;
            history.isUndoRedoing = false;
            
            // Save current canvas state as the initial state WITH explicit dimensions
            const state = selectedCanvas.toJSON();
            state.width = selectedCanvas.width;
            state.height = selectedCanvas.height;
            history.history.push(state);
            history.current = 0;
            
            updateUndoRedoButtons();
        }
    };

    function performUndo() {
        console.log("performUndo")
        if (!selectedCanvas) {
            console.log("No canvas");
            return;
        }
        console.log(selectedCanvas)
        const id = selectedCanvas.lowerCanvasEl.id;
        const history = historyMap[id];
        
        if (history.current > 0) {
            console.log('=== UNDO CLICKED ===');
            console.log('Canvas ID:', id);
            console.log('Current history index BEFORE undo:', history.current);
            console.log('Total history states:', history.history.length);
            console.log('Canvas dimensions BEFORE undo:', {
                width: selectedCanvas.width,
                height: selectedCanvas.height
            });
            console.log('State we are going to restore (index ' + (history.current - 1) + '):', {
                width: history.history[history.current - 1].width,
                height: history.history[history.current - 1].height,
                objectCount: history.history[history.current - 1].objects?.length || 0
            });
            
            history.isUndoRedoing = true; // Prevent saveState during undo
            history.current--;
            
            // Clear alignment guides before loading
            clearXGuides();
            
            selectedCanvas.loadFromJSON(history.history[history.current], () => {
                console.log('Canvas dimensions AFTER undo/loadFromJSON:', {
                    width: selectedCanvas.width,
                    height: selectedCanvas.height
                });
                console.log('Number of objects on canvas:', selectedCanvas.getObjects().length);
                console.log('Current history index AFTER undo:', history.current);
                console.log('==================');
                
                // Clear guides again after loading to ensure they're removed
                clearXGuides();
                
                selectedCanvas.renderAll();
                history.isUndoRedoing = false;
                updateUndoRedoButtons();
                
                // Reapply event handlers after loading
                selectedCanvas.getObjects().forEach(obj => {
                    if (obj.locked) {
                        obj.set({
                            lockMovementX: true,
                            lockMovementY: true,
                            lockScalingX: true,
                            lockScalingY: true,
                            lockRotation: true,
                            hasControls: false,
                            hasBorders: false
                        });
                    }
                });
            });
        }
    }
    
    function performRedo() {
        if (!selectedCanvas) return;
        const id = selectedCanvas.lowerCanvasEl.id;
        const history = historyMap[id];
        
        if (history.current < history.history.length - 1) {
            history.isUndoRedoing = true; // Prevent saveState during redo
            history.current++;
            
            // Clear alignment guides before loading
            clearXGuides();
            
            selectedCanvas.loadFromJSON(history.history[history.current], () => {
                // Clear guides again after loading to ensure they're removed
                clearXGuides();
                
                selectedCanvas.renderAll();
                history.isUndoRedoing = false;
                updateUndoRedoButtons();
                
                // Reapply event handlers after loading
                selectedCanvas.getObjects().forEach(obj => {
                    if (obj.locked) {
                        obj.set({
                            lockMovementX: true,
                            lockMovementY: true,
                            lockScalingX: true,
                            lockScalingY: true,
                            lockRotation: true,
                            hasControls: false,
                            hasBorders: false
                        });
                    }
                });
            });
        }
    }

    tempContainer.on("click", '[data-role="undo"]', performUndo);
    tempContainer.on("click", '[data-role="redo"]', performRedo);
    
    $.fn.popupColorPicker = function (initialColor, onChange, opacity = true, position = "bottom") {
        return this.each(function () {
            if ($("#colorPickerPopup").length) {
                $("#colorPickerPopup").remove();
            }
            var elm = $("<div id='colorPickerPopup'></div>");
            if (position == "bottom") {
                var top = $(this).offset().top + $(this).height() + 10;
            } else if (position == "top") {
                var top = $(this).offset().top - 270;
            }
            var left = $(this).offset().left + $(this).width() + 10;
            var this_elm = $(this);
            elm.css({
                top: top,
                left: left,
            });
            elm.appendTo(`#${mainContainerID}`);
            var layOUT = [
                { component: iro.ui.Box },
                { component: iro.ui.Slider, options: { sliderType: "hue" } }
            ];
            if (opacity) {
                layOUT.push({ component: iro.ui.Slider, options: { sliderType: "alpha" } });
            }
            new iro.ColorPicker("#colorPickerPopup", {
                width: 240,
                color: initialColor,
                layout: layOUT,
            }).on("color:change", function (color) {
                this_elm.attr("val", color.hex8String).find("span").css("background-color", color.hex8String);
                if (onChange && typeof onChange === "function") {
                    onChange(color.hex8String);
                }
            });
            $(document).on("mousedown.popupColorPicker", function (e) {
                if (
                    !$(e.target).is("#colorPickerPopup") &&
                    !$(e.target).closest("#colorPickerPopup").length
                ) {
                    $("#colorPickerPopup").remove();
                }
            });
        });
    };

    function parseGradientToFabric(inputString, canvas) {
        const parts = inputString.split(',');
        const angle = parseFloat(parts[0].replace('deg', '').trim());
        const colors = parts.slice(1);

        const radians = (angle * Math.PI) / 180;
        const halfWidth = canvas.getWidth() / 2;
        const halfHeight = canvas.getHeight() / 2;

        const x1 = halfWidth - Math.cos(radians) * halfWidth;
        const y1 = halfHeight - Math.sin(radians) * halfHeight;
        const x2 = halfWidth + Math.cos(radians) * halfWidth;
        const y2 = halfHeight + Math.sin(radians) * halfHeight;

        const colorStops = colors.map((color, index) => ({
            offset: index / (colors.length - 1),
            color: color.trim()
        }));

        return new fabric.Gradient({
            type: 'linear',
            gradientUnits: 'pixels',
            coords: { x1, y1, x2, y2 },
            colorStops: colorStops
        });
    }

    function getSize() {
        let width, height;
        const maxSize = parseInt($(window).height() - 200);
        if (x_ar > y_ar) {
            width = maxSize;
            height = (maxSize / x_ar) * y_ar;
        } else {
            height = maxSize;
            width = (maxSize / y_ar) * x_ar;
        }
        // Return actual canvas size, not zoomed size
        // Zoom will be applied via canvas.setZoom() instead
        return [width, height];
    }

    function saveState(id) {
        const canvas = window.canvasList[id];
        const history = historyMap[id];
        
        // Prevent saving during undo/redo operations or initialization
        if (history.isUndoRedoing) return;

        // Strip transient magnet/alignment guide lines before serializing so they
        // are never baked into the undo/redo history. Otherwise (because the
        // saveState handler runs on 'object:modified' before clearXGuides) the
        // pink guides get saved into a history state and reappear permanently on
        // undo/redo, untracked by guidesMap and impossible to clear.
        const transient = canvas.getObjects().filter(o => o.isTemporary);
        if (transient.length) {
            transient.forEach(o => canvas.remove(o));
            guidesMap[id] = [];
        }
        
        // Get new state and EXPLICITLY save canvas dimensions
        const canvasState = canvas.toJSON();
        canvasState.width = canvas.width;
        canvasState.height = canvas.height;
        const newState = JSON.stringify(canvasState);
        
        // Check if state actually changed from the last saved state
        if (history.history.length > 0) {
            const lastState = JSON.stringify(history.history[history.current]);
            if (newState === lastState) {
                // No changes, don't save duplicate state
                return;
            }
        }
        
        // Limit history to last 50 states to prevent memory issues
        const MAX_HISTORY = 50;
        
        // If we're in the middle of history, remove all future states
        if (history.current < history.history.length - 1) {
            history.history = history.history.slice(0, history.current + 1);
        }
        
        // Add new state (parse it back to object for storage)
        history.history.push(JSON.parse(newState));
        history.current++;
        
        // Trim old history if needed
        if (history.history.length > MAX_HISTORY) {
            history.history.shift();
            history.current--;
        }
        
        // Update undo/redo button states
        updateUndoRedoButtons();
    }

    function setupStateTracking(id) {
        const canvas = window.canvasList[id];
        
        // Simple approach: save on any modification
        // saveState() now checks for duplicates, so multiple calls won't create duplicate history
        canvas.on('object:modified', () => saveState(id));
        canvas.on('object:added', (e) => {
            if (e.target && !e.target.isTemporary) {
                saveState(id);
            }
        });
        canvas.on('object:removed', (e) => {
            if (e.target && !e.target.isTemporary) {
                saveState(id);
            }
        });
    }
    
    function updateUndoRedoButtons() {
        if (!selectedCanvas || !selectedCanvas.lowerCanvasEl) return;
        
        const history = historyMap[selectedCanvas.lowerCanvasEl.id];
        if (!history) return;
        
        // Can only undo if we have more than 1 state (index 0 is initial, need to be at index 1+)
        // This means: must have at least 2 states AND current must be > 0
        const canUndo = history.history.length > 1 && history.current > 0;
        // Can only redo if we're not at the last state
        const canRedo = history.current < history.history.length - 1;
        
        $('[data-role="undo"]').prop('disabled', !canUndo).css('opacity', canUndo ? 1 : 0.5);
        $('[data-role="redo"]').prop('disabled', !canRedo).css('opacity', canRedo ? 1 : 0.5);
    }

    function getStyle(color) {
        if (color.includes(",")) {
            var gardient = [color.split(",")[0]];
            var percOff = 100 / (color.split(",").length - 2),
                currentPerc = 0;
            for (var i = 0; i < color.split(",").length - 1; i++) {
                gardient.push(`${color.split(",")[i + 1]} ${currentPerc}%`);
                currentPerc += percOff;
            }
            var style = `background: linear-gradient(${gardient.join(", ")});`;
        } else {
            var style = `background-color: ${color};`;
        }
        return style;
    }

    function rgbaToHex(rgba, opacity = true) {
        const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
        if (!match) return rgba;

        const r = parseInt(match[1]).toString(16).padStart(2, "0");
        const g = parseInt(match[2]).toString(16).padStart(2, "0");
        const b = parseInt(match[3]).toString(16).padStart(2, "0");
        const a = match[4] !== undefined ? Math.round(parseFloat(match[4]) * 255).toString(16).padStart(2, "0") : "";

        return `#${r}${g}${b}${opacity ? a : ""}`;
    }

    function rgbToHex(rgb) {
        const result = rgb.match(/\d+/g);
        if (!result) return rgb;
        return (
            "#" +
            result
                .map((x) => {
                    const hex = parseInt(x).toString(16);
                    return hex.length === 1 ? "0" + hex : hex;
                })
                .join("")
        );
    }

    function hexToRgba(hex, transparencyPercent) {
        const alpha = 1 - (Math.max(0, Math.min(100, transparencyPercent)) / 100);
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function loadGoogleFontOnce(url) {
        if (!$(`link[href="${url}"]`).length) {
            $('<link>', {
                rel: 'stylesheet',
                href: url
            }).appendTo('head');
        }
    }

    // Returns `str` forced to the given case. Uses locale-aware transforms so
    // accented characters (ă, ș, ț, etc.) convert correctly.
    function applyTextCase(str, textCase) {
        if (typeof str !== 'string') return str;
        if (textCase === 'upper') return str.toLocaleUpperCase();
        if (textCase === 'lower') return str.toLocaleLowerCase();
        return str;
    }

    // Re-applies the object's persisted `textCase` to its text. No-op when the
    // object has no forced case set.
    function applyTextCaseToObject(obj) {
        if (!obj || (obj.type !== 'i-text' && obj.type !== 'text')) return;
        const tc = obj.textCase;
        if (tc !== 'upper' && tc !== 'lower') return;
        const transformed = applyTextCase(obj.text || '', tc);
        if (transformed !== obj.text) {
            obj.set('text', transformed);
        }
    }

    // Loads a Google Font's stylesheet AND forces the browser to fetch every
    // glyph subset needed for `text` (e.g. latin-ext for ă, ș, ț). The CSS2 API
    // splits fonts into unicode-range subsets that are only downloaded when a
    // matching glyph is painted; without passing the text, document.fonts.load
    // resolves after only the default latin subset loads, so diacritics fall
    // back to a smaller default-font glyph. Re-renders via the callback once the
    // real glyphs are available.
    function ensureFontLoaded(fontFamily, text, callback) {
        const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}&display=swap`;
        loadGoogleFontOnce(url);
        const cb = typeof callback === "function" ? callback : function () { };
        if (!document.fonts || !document.fonts.load) {
            cb();
            return;
        }
        // Pass the actual text so the needed subset (latin-ext, etc.) is fetched.
        const sample = (text && text.length) ? text : "ABCabc";
        Promise.all([
            document.fonts.load(`16px "${fontFamily}"`, sample),
            document.fonts.load(`bold 16px "${fontFamily}"`, sample)
        ]).then(cb).catch(cb);
    }

    function getAspectRatio(width, height) {
        const gcd = function (a, b) {
            return b === 0 ? a : gcd(b, a % b);
        };
        const divisor = gcd(width, height);
        return [(width / divisor), (height / divisor)];
    }
}

function ucfirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function generatePlaceholder(width = 300, height = 150, bgColor = "#ddd", textColor = "#000", text = "") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, width, height);
    ctx.fillStyle = textColor;
    ctx.font = "bold 4rem sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text || `${width}x${height}`, width / 2, height / 2);
    return canvas.toDataURL("image/png");
}