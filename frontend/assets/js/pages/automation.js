$(document).ready(function () {

    var currentID;
    var automationNodes;
    var currentAutomationNodes = [];
    var lastSavedState = null; // Track last saved state for unsaved detection

    // ==================== GLOBAL UNDO/REDO SYSTEM ====================
    const undoHistory = [];
    const redoHistory = [];
    const MAX_HISTORY = 50;
    let pendingState = null; // State captured before potential changes
    let undoDebounceTimer = null;
    const UNDO_DEBOUNCE_MS = 300;

    // Save state for undo (captures state BEFORE the change)
    function saveUndoState(description, stateToSave) {
        if (!stateToSave) {
            syncNodeTextToData();
        }
        const state = stateToSave || window.editor.export();
        undoHistory.push({ state, description, timestamp: Date.now() });
        if (undoHistory.length > MAX_HISTORY) {
            undoHistory.shift();
        }
        redoHistory.length = 0; // Clear redo on new action
        updateUndoRedoButtons();
    }

    // Restore editable text values after import
    function restoreNodeTextValues() {
        const allNodes = window.editor?.drawflow?.drawflow?.Home?.data;
        if (!allNodes) return;
        
        for (const nodeId in allNodes) {
            const nodeData = allNodes[nodeId];
            const textValue = nodeData.data?.text || "";
            const htmlElement = document.querySelector(`#node-${nodeId} .editable-text`);
            if (htmlElement) {
                htmlElement.textContent = textValue;
            }
        }
        
        // Re-inject info icons
        if (typeof injectInfoIconsIntoExistingNodes === 'function') {
            injectInfoIconsIntoExistingNodes();
        }
        
        // Re-inject Variables node dynamic controls
        if (typeof injectVariablesNodeControls === 'function') {
            injectVariablesNodeControls();
        }
        
        // Re-inject Splitter node dynamic controls
        if (typeof injectSplitterNodeControls === 'function') {
            injectSplitterNodeControls();
        }
        
        // Re-inject SubAutomation node labels
        if (typeof injectSubAutomationNodeControls === 'function') {
            injectSubAutomationNodeControls();
        }
        
        // Refresh connection paths after DOM modifications
        requestAnimationFrame(() => {
            for (const nodeId in allNodes) {
                window.editor.updateConnectionNodes("node-" + nodeId);
            }
        });
    }

    // Undo action
    function performUndo() {
        if (undoHistory.length === 0) return;
        
        syncNodeTextToData();
        const currentState = window.editor.export();
        const previousAction = undoHistory.pop();
        redoHistory.push({ state: currentState, description: 'Redo', timestamp: Date.now() });
        
        window.editor.import(previousAction.state);
        restoreNodeTextValues();
        updateUndoRedoButtons();
        showUndoNotification(window.I18n?.t('automation.undone', { action: previousAction.description }) || `Undone: ${previousAction.description}`);
    }

    // Redo action
    function performRedo() {
        if (redoHistory.length === 0) return;
        
        syncNodeTextToData();
        const currentState = window.editor.export();
        const nextAction = redoHistory.pop();
        undoHistory.push({ state: currentState, description: 'Redo action', timestamp: Date.now() });
        
        window.editor.import(nextAction.state);
        restoreNodeTextValues();
        updateUndoRedoButtons();
        showUndoNotification(window.I18n?.t('automation.action_redone') || 'Action redone');
    }

    // Update global undo/redo buttons
    function updateUndoRedoButtons() {
        $('#undoAction').prop('disabled', undoHistory.length === 0);
        $('#redoAction').prop('disabled', redoHistory.length === 0);
        // Also update AI Agent buttons if they exist
        $('#aiAgentUndo').prop('disabled', undoHistory.length === 0);
        $('#aiAgentRedo').prop('disabled', redoHistory.length === 0);
    }

    // Show undo/redo notification
    function showUndoNotification(text) {
        // Remove any existing notification
        $('.undo-notification').remove();
        const $notification = $('<div class="undo-notification"></div>').text(text);
        $('#automation-container').append($notification);
        setTimeout(() => $notification.addClass('show'), 10);
        setTimeout(() => {
            $notification.removeClass('show');
            setTimeout(() => $notification.remove(), 300);
        }, 2000);
    }

    // Sync DOM text values to node data (must be called before export)
    function syncNodeTextToData() {
        const allNodes = window.editor?.drawflow?.drawflow?.Home?.data;
        if (!allNodes) return;
        
        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            const nodeEl = document.querySelector(`#node-${nodeId} .editable-text`);
            if (nodeEl) {
                node.data.text = nodeEl.innerText.trim();
            }
        }
    }

    // Capture state BEFORE changes (called on mousedown/interaction start)
    function capturePendingState() {
        syncNodeTextToData();
        pendingState = window.editor.export();
    }

    // Commit pending state with debouncing (for rapid changes like dragging)
    function commitPendingState(description) {
        if (!pendingState) return;
        
        clearTimeout(undoDebounceTimer);
        const stateToSave = pendingState;
        pendingState = null;
        
        undoDebounceTimer = setTimeout(() => {
            saveUndoState(description, stateToSave);
        }, UNDO_DEBOUNCE_MS);
    }

    // Commit immediately without debounce (for discrete actions)
    function commitPendingStateImmediate(description) {
        if (!pendingState) return;
        clearTimeout(undoDebounceTimer);
        saveUndoState(description, pendingState);
        pendingState = null;
    }

    // Clear undo history (e.g., when loading new automation)
    function clearUndoHistory() {
        undoHistory.length = 0;
        redoHistory.length = 0;
        pendingState = null;
        clearTimeout(undoDebounceTimer);
        updateUndoRedoButtons();
    }

    // Expose for AI Agent and other modules
    window.automationUndo = {
        save: saveUndoState,
        undo: performUndo,
        redo: performRedo,
        clear: clearUndoHistory,
        capturePending: capturePendingState,
        commitPending: commitPendingState,
        commitImmediate: commitPendingStateImmediate
    };

    // Undo/Redo button click handlers
    $('#automation-container').on('click', '#undoAction', performUndo);
    $('#automation-container').on('click', '#redoAction', performRedo);

    // Keyboard shortcuts for undo/redo
    $(document).on('keydown.automationUndoRedo', function(e) {
        // Only when automation editor is active
        if (!$('#automation-container:visible').length) return;
        // Don't trigger when typing in inputs
        if ($(e.target).is('input, textarea, [contenteditable="true"]')) return;
        
        // Ctrl+Z or Cmd+Z for Undo
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            e.preventDefault();
            performUndo();
        }
        // Ctrl+Y or Ctrl+Shift+Z or Cmd+Shift+Z for Redo
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
            e.preventDefault();
            performRedo();
        }
    });
    // ==================== END UNDO/REDO SYSTEM ====================

    // Mark automation as modified when editor changes
    function markAutomationModified() {
        if (currentID) {
            window.hasUnsavedAutomation = true;
        }
    }

    // Clear unsaved state after save or when closing editor
    function clearAutomationModified() {
        window.hasUnsavedAutomation = false;
        lastSavedState = window.editor.export();
    }

    var $editorid = $("#drawflow");
    const editor = new Drawflow($editorid.get(0));
    window.editor = editor;
    window.editor.start();

    // Track editor changes for unsaved state AND undo/redo
    // Capture state before any potential changes
    $editorid.on('mousedown', function(e) {
        // Only capture if clicking on a node or connection point
        if ($(e.target).closest('.drawflow-node, .input, .output').length) {
            capturePendingState();
        }
    });

    editor.on('nodeCreated', function(id) {
        markAutomationModified();
        // For drag-drop node creation, commit pending state
        if (pendingState) {
            commitPendingStateImmediate('Add node');
        } else {
            // For programmatic creation (no mousedown), save current state
            saveUndoState('Add node');
        }
    });
    
    editor.on('nodeRemoved', function(id) {
        markAutomationModified();
        commitPendingStateImmediate('Delete node');
    });
    
    editor.on('connectionCreated', function(info) {
        markAutomationModified();
        commitPendingStateImmediate('Connect nodes');
    });
    
    editor.on('connectionRemoved', function(info) {
        markAutomationModified();
        commitPendingStateImmediate('Disconnect nodes');
    });
    
    editor.on('nodeMoved', function(id) {
        markAutomationModified();
        // Use debounced commit for node moves (rapid changes during drag)
        commitPendingState('Move node');
    });
    
    editor.on('nodeDataChanged', function(id) {
        markAutomationModified();
        // Capture state before data changes if not already captured
        if (!pendingState) {
            capturePendingState();
        }
        commitPendingState('Edit node');
    });

    var websites, minicanvas, googleProfiles, musicLibraryItems, videoTemplatesList;
    var ttsLocales = [], ttsVoicesByLocale = {}, ttsAllVoices = [];
    var gptModels = [
        // Forced Model
        { value: "gpt-5-nano", text: "GPT-5 Nano" }
    ];


    async function refreshNodeOptions() {
        const [wordpressSites, maskTemplates, googleProfilesData, videoTemplatesData, musicLibData, ttsVoicesData] = await Promise.all([
            window.electronAPI.readKey('wordpressSites'),
            window.electronAPI.readKey('maskTemplates'),
            window.electronAPI.readKey('googleProfiles'),
            window.electronAPI.readKey('videoTemplates'),
            window.electronAPI.getMusicLibrary({ category: 'all', search: '' }),
            window.electronAPI.getTTSVoices()
        ]);

        const showFacebookOutput = true;
        const showPinterestOutput = true;

        websites = Object.entries(wordpressSites || {}).map(([key, val]) => ({ value: key, text: val.name }));
        minicanvas = (maskTemplates || []).map((template) => ({ value: template.id, text: template.label }));
        googleProfiles = Object.entries(googleProfilesData || {}).map(([key, val]) => ({ value: key, text: val.name }));
        const videoTemplateOptions = (videoTemplatesData || []).map((t) => ({ value: t.id, text: t.label }));
        videoTemplatesList = (videoTemplatesData || []);
        musicLibraryItems = (musicLibData?.musics || []);

        // Process TTS voices into locale-grouped structures
        const localeToFlag = (locale) => {
            const parts = locale.split('-');
            const country = (parts[1] || parts[0]).toUpperCase();
            if (country.length === 2) {
                return String.fromCodePoint(...[...country].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
            }
            return '\uD83C\uDF10';
        };
        const localeToName = (locale) => {
            try {
                const langNames = new Intl.DisplayNames(['en'], { type: 'language' });
                const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
                const parts = locale.split('-');
                const lang = langNames.of(parts[0]) || parts[0];
                const region = parts[1] ? (regionNames.of(parts[1].toUpperCase()) || parts[1]) : '';
                return region ? `${lang} (${region})` : lang;
            } catch { return locale; }
        };
        const voices = ttsVoicesData || [];
        const localeMap = {};
        ttsVoicesByLocale = {};
        voices.forEach(v => {
            if (!localeMap[v.Locale]) {
                localeMap[v.Locale] = true;
            }
            if (!ttsVoicesByLocale[v.Locale]) ttsVoicesByLocale[v.Locale] = [];
            const name = v.FriendlyName ? v.FriendlyName.replace(/Microsoft\s+/i, '').replace(/\s+Online.*$/i, '') : v.ShortName;
            ttsVoicesByLocale[v.Locale].push({ value: v.ShortName, text: `${name} (${v.Gender})` });
        });
        ttsLocales = Object.keys(localeMap).sort().map(locale => ({
            value: locale,
            text: `${localeToFlag(locale)} ${localeToName(locale)}`
        }));
        ttsAllVoices = voices.map(v => {
            const name = v.FriendlyName ? v.FriendlyName.replace(/Microsoft\s+/i, '').replace(/\s+Online.*$/i, '') : v.ShortName;
            return { value: v.ShortName, text: `${name} (${v.Gender})` };
        });

        currentAutomationNodes = [
            {
                type: "openai",
                label: "OpenAI (API)",
                icon: "openai.svg",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Prompt : " },
                    { type: "range", title: "Temperature", value: 1, min: 0.2, max: 2 },
                    {
                        type: "select",
                        title: "Model",
                        value: "gpt-5-nano",
                        options: gptModels
                    }
                ],
                inputTypes: ["url", "text"],
                inputsHtml: ["Image Url", "text"],
                outputTypes: ["text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "minicanvas",
                label: "Mini Canvas",
                icon: "minicanvas.png",
                inputs: [
                    { type: "select", title: "Template", value: minicanvas.length > 0 ? minicanvas[0].value : "", options: minicanvas }
                ],
                inputTypes: ["images", "text", "text", "text", "text"],
                inputsHtml: ["Images", "Text 1", "Text 2", "Text 3", "Text 4"],
                outputTypes: ["image"],
                inputsCount: 5,
                outputsCount: 1
            },
            {
                type: "videoeditor",
                label: "Video Editor",
                icon: "video-icon.svg",
                inputs: [
                    { type: "select", title: "Template", value: videoTemplateOptions.length > 0 ? videoTemplateOptions[0].value : "", options: videoTemplateOptions },
                    { type: "music-picker", title: "Music", value: "[]" },
                    { type: "select", title: "FPS", value: "30", options: [{value: "24", text: "24 FPS"}, {value: "30", text: "30 FPS"}, {value: "60", text: "60 FPS"}] },
                    { type: "select", title: "Quality", value: "high", options: [{value: "low", text: "Low (Fast)"}, {value: "medium", text: "Medium"}, {value: "high", text: "High"}, {value: "ultra", text: "Ultra (Slow)"}] },
                    { type: "select", title: "Resolution", value: "original", options: [{value: "original", text: "Original"}, {value: "720p", text: "720p (HD)"}, {value: "1080p", text: "1080p (Full HD)"}, {value: "2k", text: "2K (1440p)"}, {value: "4k", text: "4K (2160p)"}] },
                    { type: "select", title: "Auto Subtitles", value: "disabled", options: [{value: "disabled", text: "Disabled"}, {value: "classic", text: "Classic Bold"}, {value: "pop", text: "Pop"}, {value: "neon", text: "Neon Glow"}, {value: "karaoke", text: "Karaoke"}, {value: "highlight", text: "Highlight"}, {value: "typewriter", text: "Typewriter"}, {value: "wave", text: "Wave"}, {value: "shadow3d", text: "3D Shadow"}] },
                    { type: "select", title: "Subtitles Language", value: "", optional: true, options: [{value: "", text: "Auto Detect"}, {value: "en", text: "English"}, {value: "fr", text: "Français"}, {value: "ar", text: "العربية"}, {value: "es", text: "Español"}, {value: "de", text: "Deutsch"}, {value: "pt", text: "Português"}, {value: "zh", text: "中文"}, {value: "ja", text: "日本語"}, {value: "ko", text: "한국어"}, {value: "hi", text: "हिन्दी"}] }
                ],
                inputTypes: ["all", "all"],
                inputsHtml: ["Input 1", "Input 2"],
                outputTypes: ["video"],
                outputsHtml: ["Video"],
                inputsCount: 2,
                outputsCount: 1,
                dynamicInputs: true
            },
            {
                type: "midjourney",
                label: "Midjourney (Browser)",
                icon: "image.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Prompt : " }
                ],
                inputTypes: ["url", "text"],
                outputTypes: ["images"],
                inputsHtml: ["Image url", "Text"],
                outputsHtml: ["4 Images"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "chatgptimage",
                label: "ChatGPT Image (Browser)",
                icon: "openai.svg",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Prompt : " }
                ],
                inputTypes: ["image", "text"],
                outputTypes: ["image"],
                inputsHtml: ["Image", "Text"],
                outputsHtml: ["Image"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "chatgptchat",
                label: "ChatGPT Chat (Browser)",
                icon: "openai.svg",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Prompt : " }
                ],
                inputTypes: ["image", "text"],
                outputTypes: ["text"],
                inputsHtml: ["Image", "Text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "googlesites",
                label: "Google Sites",
                icon: "google.png",
                inputs: [
                    {
                        type: "select",
                        title: "Google Profile (Auto-selected)",
                        value: "",
                        options: [{ value: "", text: "Auto-select from connected profiles" }, ...googleProfiles]
                    },
                ],
                inputTypes: ["text"],
                outputTypes: ["url"],
                inputsHtml: ["Html"],
                outputsHtml: ["Url"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "wordpress",
                label: "Wordpress POST",
                icon: "wordpress.png",
                inputs: [
                    {
                        type: "select",
                        title: "Website",
                        value: websites.length > 0 ? websites[0].value : "",
                        options: websites
                    },
                ],
                inputTypes: ["text", "text", "url", "text"],
                outputTypes: ["url"],
                inputsHtml: ["Title", "Text", "Featured Image URL", "Categories (1,5,12)"],
                outputsHtml: ["Url"],
                inputsCount: 4,
                outputsCount: 1
            },
            {
                type: "wprecipemaker",
                label: "WP Recipe Maker",
                icon: "wordpress.png",
                inputs: [
                    {
                        type: "select",
                        title: "Website",
                        value: websites.length > 0 ? websites[0].value : "",
                        options: websites
                    },
                ],
                inputTypes: ["text", "text", "text", "text", "text", "text", "text", "text", "text", "text", "text", "text", "url"],
                outputTypes: ["text"],
                inputsHtml: ["Recipe JSON", "Recipe Name", "Summary", "Ingredients", "Instructions", "Prep Time", "Cook Time", "Servings", "Notes", "Cuisine", "Course", "Equipment", "Image URL"],
                outputsHtml: ["Recipe ID"],
                inputsCount: 13,
                outputsCount: 1
            },
            {
                type: "wordpressget",
                label: "Wordpress GET",
                icon: "wordpress.png",
                inputs: [
                    {
                        type: "select",
                        title: "Website",
                        value: websites.length > 0 ? websites[0].value : "",
                        options: websites
                    },
                    {
                        type: "select",
                        title: "Resource",
                        value: "posts",
                        options: [
                            { value: "posts", text: "Posts" },
                            { value: "pages", text: "Pages" },
                            { value: "categories", text: "Categories" },
                            { value: "tags", text: "Tags" },
                            { value: "media", text: "Media" },
                            { value: "comments", text: "Comments" },
                            { value: "users", text: "Users" },
                            { value: "products", text: "Products (WooCommerce)" },
                            { value: "orders", text: "Orders (WooCommerce)" },
                            { value: "coupons", text: "Coupons (WooCommerce)" }
                        ]
                    },
                    {
                        type: "input",
                        title: "Per Page",
                        value: "10",
                        placeholder: "1-100"
                    },
                    {
                        type: "select",
                        title: "Sort By",
                        value: "date_desc",
                        options: [
                            { value: "date_desc", text: "Date (Newest first)" },
                            { value: "date_asc", text: "Date (Oldest first)" },
                            { value: "title_asc", text: "Title (A-Z)" },
                            { value: "title_desc", text: "Title (Z-A)" },
                            { value: "modified_desc", text: "Modified (Newest first)" },
                            { value: "modified_asc", text: "Modified (Oldest first)" },
                            { value: "id_asc", text: "ID (Ascending)" },
                            { value: "id_desc", text: "ID (Descending)" },
                            { value: "slug_asc", text: "Slug (A-Z)" },
                            { value: "slug_desc", text: "Slug (Z-A)" },
                            { value: "include", text: "Include Order" },
                            { value: "relevance", text: "Relevance (Search only)" },
                            { value: "rand", text: "Random" }
                        ]
                    }
                ],
                inputTypes: ["text", "text"],
                outputTypes: ["text"],
                inputsHtml: ["Search Query", "Resource ID"],
                outputsHtml: ["Result (JSON)"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "variables",
                label: "Variables",
                icon: "variable.png",
                inputs: [
                    { type: "textarea", title: "Text", value: "", placeholder: "Combine variables : " }
                ],
                inputTypes: ["all"],
                outputTypes: ["all"],
                inputsHtml: ["Var 1"],
                outputsHtml: ["Out"],
                inputsCount: 1,
                outputsCount: 1,
                dynamicInputs: true
            },
            {
                type: "firstelement",
                label: "First Element",
                icon: "variable.png",
                inputs: [
                    { type: "input", title: "Index", value: "0", placeholder: "0" }
                ],
                inputTypes: ["all"],
                outputTypes: ["all"],
                inputsHtml: ["List"],
                outputsHtml: ["Item"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "grouplist",
                label: "Group List",
                icon: "variable.png",
                inputs: [],
                inputTypes: ["all", "all"],
                outputTypes: ["all"],
                inputsHtml: ["Item 1", "Item 2"],
                outputsHtml: ["List"],
                inputsCount: 2,
                outputsCount: 1,
                dynamicInputs: true
            },
            {
                type: "imageupload",
                label: "Image Upload",
                icon: "upload.png",
                inputs: [],
                inputTypes: ["image"],
                outputTypes: ["url"],
                inputsHtml: ["Image"],
                outputsHtml: ["Image Url"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "videoupload",
                label: "Video Upload",
                icon: "upload.png",
                inputs: [],
                inputTypes: ["video"],
                outputTypes: ["url"],
                inputsHtml: ["Video"],
                outputsHtml: ["Video Url"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "curl",
                label: "Curl Request",
                icon: "web.png",
                inputs: [],
                inputTypes: ["text"],
                outputTypes: ["text"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "advancedcurl",
                label: "Advanced Curl",
                icon: "web.png",
                inputs: [
                    { type: "input", title: "URL", value: "", placeholder: "https://api.example.com/endpoint" },
                    {
                        type: "select",
                        title: "Method",
                        value: "GET",
                        options: [
                            { value: "GET", text: "GET" },
                            { value: "POST", text: "POST" },
                            { value: "PUT", text: "PUT" },
                            { value: "PATCH", text: "PATCH" },
                            { value: "DELETE", text: "DELETE" },
                            { value: "HEAD", text: "HEAD" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Content Type",
                        value: "application/json",
                        options: [
                            { value: "application/json", text: "JSON" },
                            { value: "application/x-www-form-urlencoded", text: "Form URL Encoded" },
                            { value: "text/plain", text: "Plain Text" },
                            { value: "none", text: "None" }
                        ]
                    },
                    { type: "textarea", title: "Headers", value: "", placeholder: "Key: Value (one per line)\nX-Api-Key: your-key\nAccept: application/json" },
                    { type: "textarea", title: "Body", value: "", placeholder: "{\n  \"title\": \"{INPUT_1}\",\n  \"content\": \"{INPUT_2}\"\n}" },
                    {
                        type: "select",
                        title: "Auth Type",
                        value: "none",
                        options: [
                            { value: "none", text: "None" },
                            { value: "bearer", text: "Bearer Token" },
                            { value: "basic", text: "Basic Auth" }
                        ]
                    },
                    { type: "input", title: "Auth Value", value: "", placeholder: "Token or username:password" }
                ],
                inputTypes: ["text", "text"],
                outputTypes: ["text"],
                inputsHtml: ["Input 1", "Input 2"],
                outputsHtml: ["Response"],
                inputsCount: 2,
                outputsCount: 1,
                dynamicInputs: true
            },
            {
                type: "serpapi",
                label: "SerpAPI Search",
                icon: "serpapi.svg",
                inputs: [
                    { type: "input", title: "Search Query", value: "", placeholder: "best restaurants in {INPUT_1}" },
                    {
                        type: "select",
                        title: "Engine",
                        value: "google",
                        options: [
                            { value: "google", text: "Google" },
                            { value: "google_images", text: "Google Images" },
                            { value: "google_news", text: "Google News" },
                            { value: "google_videos", text: "Google Videos" },
                            { value: "google_shopping", text: "Google Shopping" },
                            { value: "google_maps", text: "Google Maps" },
                            { value: "google_scholar", text: "Google Scholar" },
                            { value: "google_trends", text: "Google Trends" },
                            { value: "google_jobs", text: "Google Jobs" },
                            { value: "google_autocomplete", text: "Google Autocomplete" },
                            { value: "google_local", text: "Google Local" },
                            { value: "google_finance", text: "Google Finance" },
                            { value: "youtube", text: "YouTube" },
                            { value: "bing", text: "Bing" },
                            { value: "duckduckgo", text: "DuckDuckGo" },
                            { value: "yahoo", text: "Yahoo" },
                            { value: "yandex", text: "Yandex" },
                            { value: "amazon", text: "Amazon" },
                            { value: "ebay", text: "eBay" },
                            { value: "walmart", text: "Walmart" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Language",
                        value: "auto",
                        options: [
                            { value: "auto", text: "Auto" },
                            { value: "en", text: "English" },
                            { value: "fr", text: "French" },
                            { value: "ar", text: "Arabic" },
                            { value: "es", text: "Spanish" },
                            { value: "de", text: "German" },
                            { value: "it", text: "Italian" },
                            { value: "pt", text: "Portuguese" },
                            { value: "ja", text: "Japanese" },
                            { value: "ko", text: "Korean" },
                            { value: "zh-CN", text: "Chinese" },
                            { value: "ru", text: "Russian" },
                            { value: "nl", text: "Dutch" },
                            { value: "pl", text: "Polish" },
                            { value: "tr", text: "Turkish" },
                            { value: "hi", text: "Hindi" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Country",
                        value: "auto",
                        options: [
                            { value: "auto", text: "Auto" },
                            { value: "us", text: "United States" },
                            { value: "gb", text: "United Kingdom" },
                            { value: "fr", text: "France" },
                            { value: "de", text: "Germany" },
                            { value: "sa", text: "Saudi Arabia" },
                            { value: "es", text: "Spain" },
                            { value: "it", text: "Italy" },
                            { value: "br", text: "Brazil" },
                            { value: "in", text: "India" },
                            { value: "jp", text: "Japan" },
                            { value: "ca", text: "Canada" },
                            { value: "au", text: "Australia" },
                            { value: "ru", text: "Russia" },
                            { value: "nl", text: "Netherlands" },
                            { value: "mx", text: "Mexico" },
                            { value: "kr", text: "South Korea" }
                        ]
                    },
                    { type: "input", title: "City / Region", value: "", placeholder: "Austin, Texas", optional: true },
                    {
                        type: "select",
                        title: "Device",
                        value: "desktop",
                        options: [
                            { value: "desktop", text: "Desktop" },
                            { value: "tablet", text: "Tablet" },
                            { value: "mobile", text: "Mobile" }
                        ]
                    },
                    { type: "input", title: "Results Count", value: "10", placeholder: "1-100" },
                    { type: "input", title: "Offset", value: "0", placeholder: "0" },
                    {
                        type: "select",
                        title: "Safe Search",
                        value: "off",
                        options: [
                            { value: "off", text: "Off" },
                            { value: "active", text: "Active" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Google Search Type (tbm)",
                        value: "",
                        optional: true,
                        options: [
                            { value: "", text: "Default" },
                            { value: "isch", text: "Images (isch)" },
                            { value: "vid", text: "Videos (vid)" },
                            { value: "nws", text: "News (nws)" },
                            { value: "shop", text: "Shopping (shop)" },
                            { value: "pts", text: "Patents (pts)" }
                        ]
                    },
                    { type: "textarea", title: "Advanced Params", value: "", placeholder: "{\"tbs\":\"qdr:d\",\"nfpr\":1}", optional: true }
                ],
                inputTypes: ["text"],
                outputTypes: ["text"],
                inputsHtml: ["Text"],
                outputsHtml: ["Results (JSON)"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "amazoncrawl",
                label: "Amazon Crawler",
                icon: "amazon-icon.png",
                inputs: [],
                inputTypes: ["url"],
                outputTypes: ["text"],
                inputsHtml: ["Product URL"],
                outputsHtml: ["Product Data (JSON)"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "imagedownloader",
                label: "Image Downloader",
                icon: "image.png",
                inputs: [],
                inputTypes: ["url"],
                outputTypes: ["image"],
                inputsHtml: ["Image URL"],
                outputsHtml: ["Image Path"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "videotoimage",
                label: "Video to Image",
                icon: "video-icon.svg",
                inputs: [
                    {
                        type: "select",
                        title: "Frame Selection",
                        value: "first",
                        options: [
                            { value: "first", text: "First Frame" },
                            { value: "last", text: "Last Frame" },
                            { value: "specific", text: "Specific Frame" }
                        ]
                    },
                    { type: "input", title: "Frame Number", value: "1", placeholder: "e.g. 30 (only for Specific Frame)" }
                ],
                inputTypes: ["video"],
                outputTypes: ["image"],
                inputsHtml: ["Video"],
                outputsHtml: ["Image"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "jsonparser",
                label: "JSON Parser",
                icon: "variable.png",
                inputs: [
                    { type: "input", title: "Field Path", value: "", placeholder: "e.g. data.items, [0].title (empty = root)", optional: true },
                    { type: "input", title: "Pick Fields", value: "", placeholder: "e.g. id, name, slug (comma-separated)", optional: true }
                ],
                inputTypes: ["text"],
                outputTypes: ["text"],
                inputsHtml: ["JSON Text"],
                outputsHtml: ["Value"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "humanize",
                label: "Humanize",
                icon: "variable.png",
                inputs: [],
                inputTypes: ["text"],
                outputTypes: ["text"],
                inputsHtml: ["Text"],
                outputsHtml: ["Humanized Text"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "amazonafflink",
                label: "Amazon Aff Link",
                icon: "amazon-icon.png",
                inputs: [
                    { type: "input", title: "Tracking ID", value: "", placeholder: "e.g. mystore-20" }
                ],
                inputTypes: ["text"],
                outputTypes: ["url"],
                inputsHtml: ["Product URL"],
                outputsHtml: ["Affiliate URL"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "splitter",
                label: "Splitter",
                icon: "conditions.png",
                inputs: [
                    { type: "input", title: "Split Symbol", value: "|", placeholder: "Enter symbol (e.g., |, /, ,)" }
                ],
                inputTypes: ["text"],
                outputTypes: ["all"],
                inputsHtml: ["Text"],
                outputsHtml: ["Output 1"],
                inputsCount: 1,
                outputsCount: 1,
                dynamicOutputs: true
            },
            {
                type: "gptimage",
                label: "GPT Image (API)",
                icon: "openai.svg",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the image to generate..." },
                    {
                        type: "select",
                        title: "Model",
                        value: "gpt-image-1",
                        options: [
                            { value: "gpt-image-1", text: "GPT Image 1" },
                            { value: "gpt-image-1.5", text: "GPT Image 1.5" },
                            { value: "gpt-image-1-mini", text: "GPT Image 1 Mini" },
                            { value: "chatgpt-image-latest", text: "ChatGPT Image (Latest)" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Size",
                        value: "1024x1024",
                        options: [
                            { value: "1024x1024", text: "1024x1024 (Square)" },
                            { value: "1536x1024", text: "1536x1024 (Landscape)" },
                            { value: "1024x1536", text: "1024x1536 (Portrait)" },
                            { value: "auto", text: "Auto" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Quality",
                        value: "auto",
                        options: [
                            { value: "auto", text: "Auto" },
                            { value: "high", text: "High" },
                            { value: "medium", text: "Medium" },
                            { value: "low", text: "Low" }
                        ]
                    }
                ],
                inputTypes: ["text"],
                inputsHtml: ["Text Input"],
                outputTypes: ["image"],
                outputsHtml: ["Image"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "soraimage",
                label: "Sora Image (Browser)",
                icon: "openai.svg",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the image to generate with Sora..." },
                    {
                        type: "select",
                        title: "Variants",
                        value: "1",
                        options: [
                            { value: "1", text: "1 Image" },
                            { value: "2", text: "2 Images" },
                            { value: "3", text: "3 Images" },
                            { value: "4", text: "4 Images" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Size",
                        value: "480x720",
                        options: [
                            { value: "480x720", text: "480x720 (Portrait)" },
                            { value: "720x480", text: "720x480 (Landscape)" },
                            { value: "720x720", text: "720x720 (Square)" },
                            { value: "1024x1024", text: "1024x1024 (Large Square)" }
                        ]
                    }
                ],
                inputTypes: ["text", "image"],
                inputsHtml: ["Text", "Image"],
                outputTypes: ["images"],
                outputsHtml: ["Generated Images"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "openrouter",
                label: "OpenRouter (API)",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Enter your prompt..." },
                    { type: "range", title: "Temperature", value: 1, min: 0, max: 2 },
                    {
                        type: "select",
                        title: "Model",
                        value: "openai/gpt-5-nano",
                        options: [
                            // OpenAI Models (Forced)
                            { value: "openai/gpt-5-nano", text: "GPT-5 Nano (OpenAI)" },
                            // Anthropic Models (Affordable)
                            { value: "anthropic/claude-haiku-4-5", text: "Claude Haiku 4.5 (Fast)" },
                            { value: "anthropic/claude-sonnet-4-5", text: "Claude Sonnet 4.5" },
                            { value: "anthropic/claude-3-haiku", text: "Claude 3 Haiku" },
                            // Google Models (Flash versions)
                            { value: "google/gemini-3-flash", text: "Gemini 3 Flash" },
                            { value: "google/gemini-2.5-flash", text: "Gemini 2.5 Flash" },
                            { value: "google/gemini-2.0-flash-exp", text: "Gemini 2.0 Flash" },
                            // Meta Llama Models (Open source - affordable)
                            { value: "meta-llama/llama-3.3-70b-instruct", text: "Llama 3.3 70B" },
                            { value: "meta-llama/llama-3.1-8b-instruct", text: "Llama 3.1 8B" },
                            // Mistral Models (Affordable)
                            { value: "mistralai/mixtral-8x7b-instruct", text: "Mixtral 8x7B" },
                            { value: "mistralai/mistral-7b-instruct", text: "Mistral 7B" },
                            // DeepSeek Models (Very affordable)
                            { value: "deepseek/deepseek-chat", text: "DeepSeek Chat" },
                            { value: "deepseek/deepseek-coder", text: "DeepSeek Coder" },
                            // Qwen Models (Affordable)
                            { value: "qwen/qwen3-32b", text: "Qwen 3 32B" },
                            { value: "qwen/qwen-2.5-7b-instruct", text: "Qwen 2.5 7B" }
                        ]
                    },
                    { type: "input", title: "Max Tokens", value: "2048", placeholder: "Max tokens (e.g. 2048)" }
                ],
                inputTypes: ["url", "text"],
                inputsHtml: ["Image URL", "Text"],
                outputTypes: ["text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "googleai",
                label: "Google AI (API)",
                icon: "google.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Enter your prompt..." },
                    { type: "range", title: "Temperature", value: 1, min: 0, max: 2 },
                    {
                        type: "select",
                        title: "Model",
                        value: "gemini-2.5-flash",
                        options: [
                            // Gemini Flash Series (Cost-Effective)
                            { value: "gemini-3-flash", text: "Gemini 3 Flash (Balanced)" },
                            { value: "gemini-2.5-flash", text: "Gemini 2.5 Flash (Best Value)" },
                            { value: "gemini-2.5-flash-lite", text: "Gemini 2.5 Flash-Lite (Fastest)" },
                            { value: "gemini-2.0-flash-exp", text: "Gemini 2.0 Flash" },
                            { value: "gemini-2.0-flash-thinking-exp", text: "Gemini 2.0 Flash Thinking" },
                            // Legacy Flash Models
                            { value: "gemini-1.5-flash", text: "Gemini 1.5 Flash" },
                            { value: "gemini-1.5-flash-8b", text: "Gemini 1.5 Flash 8B" }
                        ]
                    },
                    { type: "input", title: "Max Tokens", value: "2048", placeholder: "Max tokens (e.g. 2048)" }
                ],
                inputTypes: ["url", "text"],
                inputsHtml: ["Image URL", "Text"],
                outputTypes: ["text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "googleaiimage",
                label: "Google Imagen (API)",
                icon: "google.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the image to generate..." },
                    {
                        type: "select",
                        title: "Model",
                        value: "imagen-3.0-generate-001",
                        options: [
                            { value: "imagen-3.0-generate-001", text: "Imagen 3" },
                            { value: "imagen-3.0-fast-generate-001", text: "Imagen 3 Fast" },
                            { value: "nano-banana", text: "Nano Banana (Creative)" },
                            { value: "imagegeneration@006", text: "Imagen 2" }
                        ]
                    }
                ],
                inputTypes: ["text"],
                inputsHtml: ["Text Input"],
                outputTypes: ["image"],
                outputsHtml: ["Image"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "geminiimage",
                label: "Gemini Image (Browser)",
                icon: "google.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the image to generate with Gemini..." }
                ],
                inputTypes: ["image", "text"],
                inputsHtml: ["Image", "Text"],
                outputTypes: ["image"],
                outputsHtml: ["Image"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "metaaiimage",
                label: "Meta AI Image",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the image to generate with Meta AI..." },
                    {
                        type: "select",
                        title: "Orientation",
                        value: "SQUARE",
                        options: [
                            { value: "SQUARE", text: "Square (1:1)" },
                            { value: "VERTICAL", text: "Vertical (9:16)" },
                            { value: "HORIZONTAL", text: "Horizontal (16:9)" }
                        ]
                    }
                ],
                inputTypes: ["text", "image"],
                inputsHtml: ["Text", "Attachment Image"],
                outputTypes: ["images"],
                outputsHtml: ["Generated Images"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "tiktokadsimage",
                label: "TikTok Ads Image (Browser)",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the image to generate with TikTok Ads..." },
                    {
                        type: "select",
                        title: "Model",
                        value: "gemini",
                        options: [
                            { value: "gemini", text: "Gemini" }
                        ]
                    }
                ],
                inputTypes: ["text", "image"],
                inputsHtml: ["Text", "Attachment Image"],
                outputTypes: ["images"],
                outputsHtml: ["Generated Images"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "metaaivideo",
                label: "Meta AI Video",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe your animation..." }
                ],
                inputTypes: ["text", "image"],
                inputsHtml: ["Text", "Attachment Image"],
                outputTypes: ["videos"],
                outputsHtml: ["Generated Videos"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "tiktokadsvideo",
                label: "TikTok Ads Video (Browser)",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the video to generate with TikTok Ads..." },
                    {
                        type: "select",
                        title: "Mode",
                        value: "reference",
                        options: [
                            { value: "reference", text: "Reference to Video" },
                            { value: "image", text: "Image to Video" },
                            { value: "text", text: "Text to Video" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Duration",
                        value: "12",
                        options: [
                            { value: "5", text: "5 seconds" },
                            { value: "10", text: "10 seconds" },
                            { value: "12", text: "12 seconds" }
                        ]
                    }
                ],
                inputTypes: ["text", "image"],
                inputsHtml: ["Text", "Attachment Image"],
                outputTypes: ["video"],
                outputsHtml: ["Generated Video"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "googledocsveo",
                label: "Google Docs Veo 3.1",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Describe the video to generate... Use {INPUT_1} for dynamic text" },
                    {
                        type: "select",
                        title: "Aspect Ratio",
                        value: "landscape",
                        options: [
                            { value: "landscape", text: "Landscape (16:9)" },
                            { value: "portrait", text: "Portrait (9:16)" }
                        ]
                    }
                ],
                inputTypes: ["text", "image"],
                inputsHtml: ["Text", "Image"],
                outputTypes: ["video"],
                outputsHtml: ["Video"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "anthropic",
                label: "Anthropic (API)",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Enter your prompt..." },
                    { type: "range", title: "Temperature", value: 1, min: 0, max: 1 },
                    {
                        type: "select",
                        title: "Model",
                        value: "claude-haiku-4-5",
                        options: [
                            // Claude Haiku Series (Fast & Affordable)
                            { value: "claude-haiku-4-5-20251001", text: "Claude Haiku 4.5 (Fast)" },
                            { value: "claude-haiku-4-5", text: "Claude Haiku 4.5 (Alias)" },
                            { value: "claude-3-haiku-20240307", text: "Claude 3 Haiku" },
                            // Claude Sonnet (Balanced)
                            { value: "claude-sonnet-4-5", text: "Claude Sonnet 4.5" },
                            { value: "claude-3-5-sonnet-20241022", text: "Claude 3.5 Sonnet" },
                            { value: "claude-3-sonnet-20240229", text: "Claude 3 Sonnet" }
                        ]
                    },
                    { type: "input", title: "Max Tokens", value: "2048", placeholder: "Max tokens (e.g. 2048)" }
                ],
                inputTypes: ["url", "text"],
                inputsHtml: ["Image URL", "Text"],
                outputTypes: ["text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "chineseai",
                label: "Chinese AI (API)",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Enter your prompt..." },
                    { type: "range", title: "Temperature", value: 1, min: 0, max: 2 },
                    {
                        type: "select",
                        title: "Model",
                        value: "deepseek-chat",
                        options: [
                            // DeepSeek Models (Latest)
                            { value: "deepseek-v3.2", text: "DeepSeek V3.2 (Latest)" },
                            { value: "deepseek-v3.2-exp", text: "DeepSeek V3.2 Exp" },
                            { value: "deepseek-v3.1", text: "DeepSeek V3.1" },
                            { value: "deepseek-r1", text: "DeepSeek R1 (Reasoning)" },
                            { value: "deepseek-r1-0528", text: "DeepSeek R1 0528" },
                            { value: "deepseek-chat", text: "DeepSeek Chat (V3)" },
                            { value: "deepseek-coder", text: "DeepSeek Coder" },
                            { value: "deepseek-reasoner", text: "DeepSeek Reasoner" },
                            // Qwen/Tongyi Models (Alibaba)
                            { value: "qwen3-max", text: "Qwen 3 Max (Best)" },
                            { value: "qwen-plus", text: "Qwen Plus (Balanced)" },
                            { value: "qwen-flash", text: "Qwen Flash (Fast)" },
                            { value: "qwen-turbo", text: "Qwen Turbo" },
                            { value: "qwen3-vl-plus", text: "Qwen 3 VL Plus (Vision)" },
                            { value: "qwq-plus", text: "QwQ Plus (Reasoning)" },
                            { value: "qwen3-coder-plus", text: "Qwen 3 Coder Plus" },
                            // Kimi Models (Moonshot)
                            { value: "kimi-k2-thinking", text: "Kimi K2 Thinking" },
                            { value: "Moonshot-Kimi-K2-Instruct", text: "Kimi K2 Instruct" },
                            { value: "moonshot-v1-128k", text: "Moonshot v1 128K" },
                            // GLM Models (Zhipu)
                            { value: "glm-4.7", text: "GLM-4.7 (Latest)" },
                            { value: "glm-4.6", text: "GLM-4.6" },
                            { value: "glm-4.5", text: "GLM-4.5" },
                            { value: "glm-4.5-air", text: "GLM-4.5 Air (Fast)" },
                            { value: "glm-4", text: "GLM-4" },
                            { value: "glm-4v", text: "GLM-4V (Vision)" },
                            // MiniMax Models
                            { value: "MiniMax-M2.1", text: "MiniMax M2.1" }
                        ]
                    },
                    { type: "input", title: "Max Tokens", value: "2048", placeholder: "Max tokens (e.g. 2048)" }
                ],
                inputTypes: ["url", "text"],
                inputsHtml: ["Image URL", "Text"],
                outputTypes: ["text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "deepseekbrowser",
                label: "DeepSeek (Browser)",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Enter your prompt... Use {INPUT_1} for image, {INPUT_2} for text" },
                    {
                        type: "select",
                        title: "Deep Think",
                        value: "false",
                        options: [
                            { value: "false", text: "Disabled" },
                            { value: "true", text: "Enabled" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Web Search",
                        value: "false",
                        options: [
                            { value: "false", text: "Disabled" },
                            { value: "true", text: "Enabled" }
                        ]
                    }
                ],
                inputTypes: ["image", "text"],
                inputsHtml: ["Image", "Text"],
                outputTypes: ["text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "qwenbrowser",
                label: "Qwen AI (Browser)",
                icon: "web.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Enter your prompt... Use {INPUT_1} for image, {INPUT_2} for text" },
                    {
                        type: "select",
                        title: "Model",
                        value: "qwen3.7-plus",
                        options: [
                            { value: "qwen3.7-plus", text: "Qwen3.7 Plus" }
                        ]
                    },
                    {
                        type: "select",
                        title: "Enable Thinking",
                        value: "false",
                        options: [
                            { value: "false", text: "Disabled" },
                            { value: "true", text: "Enabled" }
                        ]
                    },
                    { type: "range", title: "Temperature", value: 0.7, min: 0, max: 2 },
                    { type: "input", title: "Max Tokens", value: "4096", placeholder: "Max tokens (e.g. 4096)" },
                    {
                        type: "select",
                        title: "Web Search",
                        value: "false",
                        options: [
                            { value: "false", text: "Disabled" },
                            { value: "true", text: "Enabled" }
                        ]
                    }
                ],
                inputTypes: ["image", "text"],
                inputsHtml: ["Image", "Text"],
                outputTypes: ["text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "vcai",
                label: "ViralCloner AI (retired)",
                icon: "app-icon.png",
                inputs: [
                    { type: "textarea", title: "Prompt", value: "", placeholder: "Enter your prompt... Use {INPUT_2} for text input" },
                    { type: "range", title: "Temperature", value: 0.7, min: 0, max: 2 },
                    {
                        type: "select",
                        title: "Model",
                        value: "",
                        options: [
                            { value: "", text: "VC-1.0" }
                        ]
                    },
                    { type: "input", title: "Max Tokens", value: "4096", placeholder: "Max tokens (e.g. 4096)" }
                ],
                inputTypes: ["url", "text"],
                inputsHtml: ["Image URL", "Text"],
                outputTypes: ["text"],
                outputsHtml: ["Text"],
                inputsCount: 2,
                outputsCount: 1
            },
            {
                type: "vctts",
                label: "VC Text To Speech",
                icon: "tts.svg",
                inputs: [
                    {
                        type: "select",
                        title: "Locale",
                        value: "en-US",
                        options: ttsLocales
                    },
                    {
                        type: "select",
                        title: "Voice",
                        value: "en-US-EmmaMultilingualNeural",
                        options: ttsVoicesByLocale["en-US"] || ttsAllVoices
                    }
                ],
                inputTypes: ["text"],
                outputTypes: ["audio"],
                inputsHtml: ["Text"],
                outputsHtml: ["Audio Path"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "subautomation",
                label: "Sub Automation",
                icon: "subautomation.svg",
                inputs: [],
                inputTypes: ["all"],
                inputsHtml: ["Input 1"],
                outputTypes: ["all"],
                outputsHtml: ["Output 1"],
                inputsCount: 1,
                outputsCount: 1
            },
            {
                type: "input",
                name: "Input",
                label: "Input",
                icon: "post.png",
                singleInstance: true,
                inputs: [],
                inputTypes: [],
                inputsHtml: [],
                outputTypes: ["image", "text"],
                outputsHtml: ["Image", "Text"],
                inputsCount: 0,
                outputsCount: 2
            },
            ...(showPinterestOutput ? [{
                type: "pinterest-output",
                name: "Pinterest Output",
                label: "Pinterest Output",
                icon: "pinterest-black.png",
                singleInstance: true,
                inputs: [],
                inputTypes: ["url", "text", "text", "url", "url"],
                inputsHtml: ["Image URL", "Title", "Description", "Link", "Video URL"],
                outputTypes: [],
                outputsHtml: [],
                inputsCount: 5,
                outputsCount: 0
            }] : []),
            ...(showFacebookOutput ? [{
                type: "facebook-output",
                name: "Facebook Output",
                label: "Facebook Output",
                icon: "facebook-black.png",
                singleInstance: true,
                inputs: [],
                inputTypes: ["image", "text", "video", "url", "text"],
                inputsHtml: ["Image", "Text", "Video", "URL", "Title"],
                outputTypes: [],
                outputsHtml: [],
                inputsCount: 5,
                outputsCount: 0
            }] : [])
        ];

        updateSidebar();
    }

    // Node group definitions
    const nodeGroups = {
        'Input/Output': ['input', 'pinterest-output', 'facebook-output'],
        'AI & Content': ['vcai', 'openai', 'openrouter', 'googleai', 'anthropic', 'chineseai', 'deepseekbrowser', 'qwenbrowser', 'chatgptchat', 'humanize'],
        'AI Images': ['midjourney', 'chatgptimage', 'gptimage', 'googleaiimage', 'soraimage', 'geminiimage', 'metaaiimage', 'tiktokadsimage'],
        'AI Videos': ['metaaivideo', 'tiktokadsvideo', 'googledocsveo'],
        'AI Audios': ['vctts'],
        'Design': ['minicanvas', 'videoeditor'],
        'Publishing': ['googlesites', 'wordpress', 'wprecipemaker', 'wordpressget'],
        'Data Processing': ['variables', 'jsonparser', 'splitter', 'firstelement', 'grouplist', 'subautomation'],
        'Media': ['imageupload', 'videoupload', 'imagedownloader'],
        'Web & API': ['curl', 'advancedcurl', 'serpapi', 'amazoncrawl', 'amazonafflink']
    };

    const groupIcons = {
        'Input/Output': 'swap_horiz',
        'AI & Content': 'psychology',
        'AI Images': 'image',
        'AI Videos': 'videocam',
        'AI Audios': 'graphic_eq',
        'Design': 'palette',
        'Publishing': 'publish',
        'Data Processing': 'data_object',
        'Media': 'perm_media',
        'Web & API': 'api'
    };

    // Map group names to i18n keys
    const groupNameKeys = {
        'Input/Output': 'automation.groups.input_output',
        'AI & Content': 'automation.groups.ai_content',
        'AI Images': 'automation.groups.ai_images',
        'AI Videos': 'automation.groups.ai_videos',
        'AI Audios': 'automation.groups.ai_audios',
        'Design': 'automation.groups.design',
        'Publishing': 'automation.groups.publishing',
        'Data Processing': 'automation.groups.data_processing',
        'Media': 'automation.groups.media',
        'Web & API': 'automation.groups.web_api'
    };

    // Map node types to i18n keys
    const nodeLabelKeys = {
        'input': 'automation.nodes.input',
        'pinterest-output': 'automation.nodes.pinterest_output',
        'facebook-output': 'automation.nodes.facebook_output',
        'openai': 'automation.nodes.openai',
        'openrouter': 'automation.nodes.openrouter',
        'googleai': 'automation.nodes.googleai',
        'anthropic': 'automation.nodes.anthropic',
        'chineseai': 'automation.nodes.chineseai',
        'deepseekbrowser': 'automation.nodes.deepseekbrowser',
        'qwenbrowser': 'automation.nodes.qwenbrowser',
        'vcai': 'automation.nodes.vcai',
        'chatgptchat': 'automation.nodes.chatgptchat',
        'midjourney': 'automation.nodes.midjourney',
        'chatgptimage': 'automation.nodes.chatgptimage',
        'gptimage': 'automation.nodes.gptimage',
        'googleaiimage': 'automation.nodes.googleaiimage',
        'soraimage': 'automation.nodes.soraimage',
        'geminiimage': 'automation.nodes.geminiimage',
        'metaaiimage': 'automation.nodes.metaaiimage',
        'tiktokadsimage': 'automation.nodes.tiktokadsimage',
        'metaaivideo': 'automation.nodes.metaaivideo',
        'tiktokadsvideo': 'automation.nodes.tiktokadsvideo',
        'googledocsveo': 'automation.nodes.googledocsveo',
        'vctts': 'automation.nodes.vctts',
        'minicanvas': 'automation.nodes.minicanvas',
        'videoeditor': 'automation.nodes.videoeditor',
        'googlesites': 'automation.nodes.googlesites',
        'wordpress': 'automation.nodes.wordpress',
        'wprecipemaker': 'automation.nodes.wprecipemaker',
        'wordpressget': 'automation.nodes.wordpressget',
        'variables': 'automation.nodes.variables',
        'jsonparser': 'automation.nodes.jsonparser',
        'humanize': 'automation.nodes.humanize',
        'splitter': 'automation.nodes.splitter',
        'firstelement': 'automation.nodes.firstelement',
        'grouplist': 'automation.nodes.grouplist',
        'subautomation': 'automation.nodes.subautomation',
        'imageupload': 'automation.nodes.imageupload',
        'videoupload': 'automation.nodes.videoupload',
        'imagedownloader': 'automation.nodes.imagedownloader',
        'curl': 'automation.nodes.curl',
        'advancedcurl': 'automation.nodes.advancedcurl',
        'serpapi': 'automation.nodes.serpapi',
        'amazoncrawl': 'automation.nodes.amazoncrawl',
        'amazonafflink': 'automation.nodes.amazonafflink'
    };

    // Update sidebar with grouped nodes
    function updateSidebar() {
        const $container = $(".automation-sidebar .elements");
        $container.html("");
        
        // Build grouped HTML
        Object.entries(nodeGroups).forEach(([groupName, nodeTypes]) => {
            const groupNodes = currentAutomationNodes.filter(node => nodeTypes.includes(node.type));
            if (groupNodes.length === 0) return;
            
            const groupIcon = groupIcons[groupName] || 'folder';
            const groupId = groupName.replace(/\s+/g, '-').toLowerCase();
            const translatedGroupName = (groupNameKeys[groupName] && window.I18n?.t(groupNameKeys[groupName])) || groupName;
            
            let groupHtml = `
                <div class="node-group" data-group="${groupId}">
                    <div class="node-group-header">
                        <div class="group-title">
                            <i class="material-icons">${groupIcon}</i>
                            <span>${translatedGroupName}</span>
                        </div>
                        <i class="material-icons group-toggle">expand_more</i>
                    </div>
                    <div class="node-group-items">
            `;
            
            groupNodes.forEach(node => {
                const translatedLabel = (nodeLabelKeys[node.type] && window.I18n?.t(nodeLabelKeys[node.type])) || node.label;
                groupHtml += `
                    <button data-role="addElement" data-automation="${node.type}" class="node-item" title="${translatedLabel}" draggable="true">
                        <img src="assets/images/icons/${node.icon}" width="18" draggable="false">
                        <span>${translatedLabel}</span>
                    </button>
                `;
            });
            
            groupHtml += `</div></div>`;
            $container.append(groupHtml);
        });
        
        // Add any ungrouped nodes
        const allGroupedTypes = Object.values(nodeGroups).flat();
        const ungroupedNodes = currentAutomationNodes.filter(node => !allGroupedTypes.includes(node.type));
        
        if (ungroupedNodes.length > 0) {
            const otherLabel = window.I18n?.t('automation.groups.other') || 'Other';
            let otherHtml = `
                <div class="node-group" data-group="other">
                    <div class="node-group-header">
                        <div class="group-title">
                            <i class="material-icons">extension</i>
                            <span>${otherLabel}</span>
                        </div>
                        <i class="material-icons group-toggle">expand_more</i>
                    </div>
                    <div class="node-group-items">
            `;
            
            ungroupedNodes.forEach(node => {
                const translatedLabel = (nodeLabelKeys[node.type] && window.I18n?.t(nodeLabelKeys[node.type])) || node.label;
                otherHtml += `
                    <button data-role="addElement" data-automation="${node.type}" class="node-item" title="${translatedLabel}" draggable="true">
                        <img src="assets/images/icons/${node.icon}" width="18" draggable="false">
                        <span>${translatedLabel}</span>
                    </button>
                `;
            });
            
            otherHtml += `</div></div>`;
            $container.append(otherHtml);
        }
    }

    // Node group toggle
    $(document).on('click', '.node-group-header', function() {
        const $group = $(this).closest('.node-group');
        $group.toggleClass('collapsed');
        const $toggle = $(this).find('.group-toggle');
        $toggle.text($group.hasClass('collapsed') ? 'expand_less' : 'expand_more');
    });

    // Node search functionality
    $(document).on('input', '#nodeSearch', function() {
        const searchTerm = $(this).val().toLowerCase().trim();
        
        if (!searchTerm) {
            $('.node-group').show().removeClass('collapsed');
            $('.node-item').show();
            $('.group-toggle').text('expand_more');
            return;
        }
        
        $('.node-group').each(function() {
            const $group = $(this);
            let hasVisibleNodes = false;
            
            $group.find('.node-item').each(function() {
                const $node = $(this);
                const nodeLabel = $node.find('span').text().toLowerCase();
                const nodeType = $node.data('automation').toLowerCase();
                const matches = nodeLabel.includes(searchTerm) || nodeType.includes(searchTerm);
                
                $node.toggle(matches);
                if (matches) hasVisibleNodes = true;
            });
            
            $group.toggle(hasVisibleNodes);
            if (hasVisibleNodes) {
                $group.removeClass('collapsed');
                $group.find('.group-toggle').text('expand_more');
            }
        });
    });

    // ========== Drag and Drop from Sidebar ==========
    
    // Make sidebar node items draggable
    $('#automation-container').on('dragstart', '.node-item', function(e) {
        const automationType = $(this).data('automation');
        e.originalEvent.dataTransfer.setData('text/plain', automationType);
        e.originalEvent.dataTransfer.effectAllowed = 'copy';
        
        // Add visual feedback
        $(this).addClass('dragging');
        $('#drawflow').addClass('drag-target-active');
    });
    
    $('#automation-container').on('dragend', '.node-item', function(e) {
        $(this).removeClass('dragging');
        $('#drawflow').removeClass('drag-target-active');
    });
    
    // Make Drawflow canvas a drop target
    $('#automation-container').on('dragover', '#drawflow', function(e) {
        e.preventDefault();
        e.originalEvent.dataTransfer.dropEffect = 'copy';
    });
    
    $('#automation-container').on('dragenter', '#drawflow', function(e) {
        e.preventDefault();
        $(this).addClass('drag-over');
    });
    
    $('#automation-container').on('dragleave', '#drawflow', function(e) {
        // Only remove class if leaving the actual drawflow element
        if (!$(e.relatedTarget).closest('#drawflow').length) {
            $(this).removeClass('drag-over');
        }
    });
    
    $('#automation-container').on('drop', '#drawflow', async function(e) {
        e.preventDefault();
        $(this).removeClass('drag-over');
        $('#drawflow').removeClass('drag-target-active');
        
        const automationType = e.originalEvent.dataTransfer.getData('text/plain');
        if (!automationType) return;
        
        const nodeConfig = currentAutomationNodes.find(node => node.type === automationType);
        if (!nodeConfig) return;
        
        // Check single-instance restriction
        if (nodeConfig.singleInstance) {
            const allNodes = window.editor.drawflow.drawflow["Home"]?.data || {};
            const existingNode = Object.values(allNodes).find(node => node.data?.type === automationType);
            if (existingNode) {
                showAlert("warning", window.I18n?.t("automation.single_instance_warning", { nodeName: nodeConfig.name }) || `Only one ${nodeConfig.name} node is allowed per automation`);
                return;
            }
        }
        
        // Calculate drop position in canvas coordinates using the precanvas element
        // which already has the transform applied
        const precanvas = window.editor.precanvas;
        const precanvasRect = precanvas.getBoundingClientRect();
        const zoom = window.editor.zoom;
        
        // Get position relative to the transformed precanvas, then divide by zoom
        // to convert from screen pixels to canvas coordinates
        const relX = e.originalEvent.clientX - precanvasRect.left;
        const relY = e.originalEvent.clientY - precanvasRect.top;
        const dropX = relX / zoom;
        const dropY = relY / zoom;
        
        const formattedInputs = (nodeConfig.inputsHtml || nodeConfig.inputTypes).map(ucfirst);
        const formattedOutputs = (nodeConfig.outputsHtml || nodeConfig.outputTypes).map(ucfirst);
        
        window.editor.addNode(
            automationType,
            nodeConfig.inputsCount,
            nodeConfig.outputsCount,
            dropX,
            dropY,
            generateRandomString(10),
            {
                type: automationType,
                inputs: nodeConfig.inputs,
                inputTypes: nodeConfig.inputTypes,
                outputTypes: nodeConfig.outputTypes,
                text: "edit text"
            },
            getHtml(formattedInputs, formattedOutputs, "edit text", ucfirst(automationType), automationType)
        );
    });

    let nodeOptionsLoaded = false;
    
    async function loadNodeOptionsOnce() {
        if (!nodeOptionsLoaded) {
            await refreshNodeOptions();
            nodeOptionsLoaded = true;
        }
    }
    
    loadNodeOptionsOnce();

    $('#automation-container').on("click", '#testAutomation', async function () {
        if (!currentID) return;
        
        // Reset modal
        $('#testTextInput').val('');
        $('#testImageInput').val('');
        $('#testResults').hide();
        $('#testLogs').hide();
        $('#testResultsContent').html('');
        $('#testLogsContent').html('');
        $('#executeTestBtn').prop('disabled', false);
        // Reset button text in case it was left in "Running..." state from a canceled test
        $('#executeTestBtn').html('<i class="material-icons me-1">play_arrow</i><span>' + (window.I18n?.t('automation.test_modal.run_test') || 'Run Test') + '</span>');
        
        // Show modal
        $('#testAutomationModal').fadeIn(200);
    });

    // Track current test for log handling
    let currentTestId = null;

    // Remove any existing listeners before setting up new one (prevents duplicates on page reload)
    window.electronAPI.removeTestAutomationLogListeners();

    // Setup test log listener
    window.electronAPI.onTestAutomationLog((logData) => {
        // Set currentTestId from first log if not set (so we can receive all logs)
        if (!currentTestId && logData.testId) {
            currentTestId = logData.testId;
        }
        // Process logs for the current test
        if (currentTestId && logData.testId === currentTestId) {
            appendTestLog(logData);
        }
    });

    // Helper function to append test logs
    function appendTestLog(logData) {
        const $logsContent = $('#testLogsContent');
        const time = new Date(logData.timestamp).toLocaleTimeString();
        
        let statusClass = '';
        let statusIcon = '';
        
        switch (logData.event) {
            case 'error':
            case 'node-error':
            case 'workflow-error':
                statusClass = 'log-error';
                statusIcon = '<i class="material-icons" style="font-size:16px">cancel</i>';
                break;
            case 'complete':
                statusClass = 'log-success';
                statusIcon = '<i class="material-icons" style="font-size:16px">check_circle</i>';
                break;
            case 'node-progress':
                if (logData.status === 'completed') {
                    statusClass = 'log-success';
                    statusIcon = '<i class="material-icons" style="font-size:16px">check</i>';
                } else if (logData.status === 'failed') {
                    statusClass = 'log-error';
                    statusIcon = '<i class="material-icons" style="font-size:16px">close</i>';
                } else if (logData.status === 'started') {
                    statusClass = 'log-info';
                    statusIcon = '▶';
                } else {
                    statusClass = 'log-progress';
                    statusIcon = '<i class="material-icons" style="font-size:16px">hourglass_empty</i>';
                }
                break;
            case 'warning':
                statusClass = 'log-warning';
                statusIcon = '<i class="material-icons" style="font-size:16px">warning</i>';
                break;
            case 'node-completed':
            case 'output-generated':
                statusClass = 'log-success';
                statusIcon = '<i class="material-icons" style="font-size:16px">check</i>';
                break;
            case 'workflow-stopped':
                statusClass = 'log-warning';
                statusIcon = '<i class="material-icons" style="font-size:16px">stop_circle</i>';
                break;
            case 'info':
            default:
                statusClass = 'log-info';
                statusIcon = '<i class="material-icons" style="font-size:16px">info</i>';
                break;
        }

        // Build log entry HTML
        let logHtml = `<div class="log-entry ${statusClass}">`;
        logHtml += `<span class="log-time">${time}</span>`;
        logHtml += `<span class="log-icon">${statusIcon}</span>`;
        
        // Node info
        if (logData.nodeType && logData.nodeType !== 'system') {
            logHtml += `<span class="log-node-type">[${logData.nodeType}${logData.nodeId ? ' #' + logData.nodeId : ''}]</span>`;
        }
        
        // Status badge
        if (logData.status) {
            logHtml += `<span class="log-status log-status-${logData.status}">${logData.status}</span>`;
        }
        
        // Attempt info
        if (logData.attempt) {
            logHtml += `<span class="log-attempt">Attempt ${logData.attempt}</span>`;
        }
        
        // Message
        logHtml += `<span class="log-message">${escapeHtml(logData.message || '')}</span>`;
        
        // Error details
        if (logData.error) {
            logHtml += `<div class="log-error-details">`;
            logHtml += `<strong>Error:</strong> ${escapeHtml(logData.error.message || '')}`;
            if (logData.error.stack) {
                logHtml += `<pre class="log-stack">${escapeHtml(logData.error.stack)}</pre>`;
            }
            logHtml += `</div>`;
        }
        
        // Inputs (collapsible)
        if (logData.inputs && Object.keys(logData.inputs).length > 0) {
            const inputsStr = JSON.stringify(logData.inputs, null, 2);
            if (inputsStr.length < 500) {
                logHtml += `<details class="log-data"><summary>Inputs</summary><pre>${escapeHtml(inputsStr)}</pre></details>`;
            }
        }
        
        // Outputs (collapsible)
        if (logData.outputs && Object.keys(logData.outputs).length > 0) {
            const outputsStr = JSON.stringify(logData.outputs, null, 2);
            logHtml += `<details class="log-data"><summary>Outputs</summary><pre>${escapeHtml(outputsStr)}</pre></details>`;
        }
        
        logHtml += `</div>`;
        
        $logsContent.append(logHtml);
        
        // Auto-scroll to bottom - scroll the logs content element itself
        const logsContainer = $logsContent[0];
        if (logsContainer) {
            logsContainer.scrollTop = logsContainer.scrollHeight;
        }
    }

    $('#automation-container').on("click", '#executeTestBtn', async function () {
        const textInput = $('#testTextInput').val().trim();
        const imageInput = $('#testImageInput')[0].files[0];

        const $executeBtn = $('#executeTestBtn');
        $executeBtn.prop('disabled', true);
        $executeBtn.html('<i class="material-icons me-1">hourglass_empty</i><span>Running...</span>');

        // Clear previous results and show logs section
        $('#testResults').hide();
        $('#testLogs').show();
        $('#testLogsContent').html('');

        try {
            // Read image as base64 if provided
            let imageData = null;
            if (imageInput) {
                imageData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(imageInput);
                });
            }

            // Get automation data
            const automations = await window.electronAPI.readKey('automations');
            const automation = automations?.find(item => item.id === currentID);
            
            if (!automation || !automation.data || !automation.data.drawflow) {
                showAlert("error", "Please save the automation first before testing");
                $executeBtn.prop('disabled', false);
                $executeBtn.html('<i class="material-icons me-1">play_arrow</i><span>Run Test</span>');
                return;
            }

            // Pre-flight validation: check API keys, profiles, and input connections
            const testPosts = [{
                postMessage: textInput || null,
                postImg: imageData ? 'test-image' : null
            }];
            
            const validationResult = await window.electronAPI.validateWorkflowPreflight(currentID, testPosts);
            if (!validationResult.valid) {
                // Show validation errors in the test results panel
                let errorsHtml = '<div class="alert alert-danger mb-3"><i class="material-icons me-2">error</i><strong>Pre-flight Check Failed</strong></div>';
                errorsHtml += '<div class="validation-errors">';
                validationResult.errors.forEach(err => {
                    errorsHtml += `<div class="alert alert-warning py-2 mb-2">`;
                    if (err.nodeType) {
                        errorsHtml += `<strong>${ucfirst(err.nodeType)}:</strong> `;
                    }
                    errorsHtml += `${err.message}</div>`;
                });
                errorsHtml += '</div>';
                
                $('#testResults').show();
                $('#testResultsContent').html(errorsHtml);
                $('#testLogs').hide();
                
                $executeBtn.prop('disabled', false);
                $executeBtn.html('<i class="material-icons me-1">play_arrow</i><span>Run Test</span>');
                return;
            }

            // Reset currentTestId - we'll set it from the backend response
            // This allows logs to come through before the result
            currentTestId = null;

            // Execute test - use a callback pattern to get testId early
            const result = await window.electronAPI.testAutomation(currentID, {
                text: textInput || null,
                image: imageData || null
            });
            
            // Display results - keep logs visible when no real outputs
            const outputs = result.success ? result.value : null;
            const hasOutputs = outputs && (outputs.facebook || outputs.pinterest);
            if (result.success && hasOutputs) {
                $('#testLogs').hide();
            } else {
                $('#testLogs').show();
            }
            $('#testResults').show();
            
            if (result.success) {
                let resultsHtml = '<div class="alert alert-success mb-3"><i class="material-icons me-2">check_circle</i>Test completed successfully!</div>';
                
                const outputs = result.value;
                
                if (outputs.facebook) {
                    resultsHtml += '<div class="output-section mb-3">';
                    resultsHtml += '<h5><img src="assets/images/icons/facebook-colored.png" width="24" class="me-2">Facebook Output</h5>';
                    resultsHtml += '<div class="output-content">';
                    
                    if (outputs.facebook.image) {
                        if (Array.isArray(outputs.facebook.image)) {
                            resultsHtml += '<div class="output-images">';
                            outputs.facebook.image.forEach((img, idx) => {
                                resultsHtml += `<img src="file://${img}" alt="Image ${idx + 1}" class="output-image">`;
                            });
                            resultsHtml += '</div>';
                        } else {
                            resultsHtml += `<img src="file://${outputs.facebook.image}" alt="Facebook Image" class="output-image">`;
                        }
                    }
                    
                    if (outputs.facebook.video) {
                        resultsHtml += `<div class="output-video"><video src="file://${outputs.facebook.video}" controls style="max-width:100%;max-height:400px;border-radius:8px;"></video></div>`;
                    }
                    
                    if (outputs.facebook.title) {
                        resultsHtml += `<div class="output-text"><strong>Title:</strong><p>${outputs.facebook.title}</p></div>`;
                    }
                    
                    if (outputs.facebook.text) {
                        resultsHtml += `<div class="output-text"><strong>Text:</strong><p>${outputs.facebook.text}</p></div>`;
                    }
                    
                    if (outputs.facebook.url) {
                        resultsHtml += `<div class="output-text"><strong>URL:</strong><p><a href="${outputs.facebook.url}" target="_blank">${outputs.facebook.url}</a></p></div>`;
                    }
                    
                    resultsHtml += '</div></div>';
                }
                
                if (outputs.pinterest) {
                    resultsHtml += '<div class="output-section mb-3">';
                    resultsHtml += '<h5><img src="assets/images/icons/pinterest-colored.png" width="24" class="me-2">Pinterest Output</h5>';
                    resultsHtml += '<div class="output-content">';
                    
                    if (outputs.pinterest.image) {
                        if (Array.isArray(outputs.pinterest.image)) {
                            resultsHtml += '<div class="output-images">';
                            outputs.pinterest.image.forEach((img, idx) => {
                                resultsHtml += `<img src="${img}" alt="Image ${idx + 1}" class="output-image">`;
                            });
                            resultsHtml += '</div>';
                        } else {
                            resultsHtml += `<img src="${outputs.pinterest.image}" alt="Pinterest Image" class="output-image">`;
                        }
                    }
                    
                    if (outputs.pinterest.title) {
                        resultsHtml += `<div class="output-text"><strong>Title:</strong><p>${outputs.pinterest.title}</p></div>`;
                    }
                    
                    if (outputs.pinterest.description) {
                        resultsHtml += `<div class="output-text"><strong>Description:</strong><p>${outputs.pinterest.description}</p></div>`;
                    }
                    
                    if (outputs.pinterest.url) {
                        resultsHtml += `<div class="output-text"><strong>URL:</strong><p><a href="${outputs.pinterest.url}" target="_blank">${outputs.pinterest.url}</a></p></div>`;
                    }
                    
                    if (outputs.pinterest.videoUrl) {
                        resultsHtml += `<div class="output-video"><video src="file://${outputs.pinterest.videoUrl}" controls style="max-width:100%;max-height:400px;border-radius:8px;"></video></div>`;
                    }
                    
                    resultsHtml += '</div></div>';
                }
                
                if (!outputs.facebook && !outputs.pinterest) {
                    resultsHtml += '<div class="alert alert-warning">No outputs generated. Make sure your automation is connected to Facebook or Pinterest output nodes.</div>';
                }
                
                $('#testResultsContent').html(resultsHtml);
                showAlert("success", "Test completed successfully!");
            } else {
                $('#testResultsContent').html(`<div class="alert alert-danger"><i class="material-icons me-2">error</i><strong>Test Failed:</strong><p>${result.value}</p></div>`);
                showAlert("error", "Test failed: " + result.value);
                // Scroll modal to show the error result below the logs
                const modal = $('.test-automation-modal')[0];
                if (modal) modal.scrollTop = modal.scrollHeight;
            }

        } catch (error) {
            $('#testLogs').show();
            $('#testResults').show();
            $('#testResultsContent').html(`<div class="alert alert-danger"><i class="material-icons me-2">error</i><strong>Error:</strong><p>${error.message}</p></div>`);
            showAlert("error", "Test error: " + error.message);
        } finally {
            $executeBtn.prop('disabled', false);
            $executeBtn.html('<i class="material-icons me-1">play_arrow</i><span>Run Test</span>');
        }
    });

    // Convert all text AI nodes to ViralCloner AI (vcai)
    $('#automation-container').on("click", '#convertToVCAI', async function () {
        if (!currentID) return;
        
        const textAINodeTypes = ['openai', 'anthropic', 'googleai', 'chineseai', 'openrouter', 'chatgptchat', 'deepseekbrowser', 'qwenbrowser'];
        const allNodes = window.editor.drawflow.drawflow["Home"].data;
        
        // Check for nodes with image input connections (input_1 is typically image)
        let nodesWithImageInput = [];
        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            if (textAINodeTypes.includes(node.data.type)) {
                // Check if input_1 (image input) has any connections
                if (node.inputs && node.inputs.input_1 && node.inputs.input_1.connections && node.inputs.input_1.connections.length > 0) {
                    nodesWithImageInput.push(node.data.label || node.data.type);
                }
            }
        }
        
        if (nodesWithImageInput.length > 0) {
            showAlert('error', window.I18n?.t('automation.convert_vcai_image_error') || 
                `Cannot convert: ${nodesWithImageInput.length} node(s) have image input connections. ViralCloner AI does not support image inputs. Please disconnect image inputs first: ${nodesWithImageInput.join(', ')}`);
            return;
        }
        
        // Count how many nodes would be converted
        let nodesToConvert = 0;
        for (const nodeId in allNodes) {
            if (textAINodeTypes.includes(allNodes[nodeId].data.type)) {
                nodesToConvert++;
            }
        }
        
        if (nodesToConvert === 0) {
            showAlert('info', window.I18n?.t('automation.convert_vcai_none') || 'No AI text nodes found to convert');
            return;
        }
        
        // Show confirmation dialog
        const confirmMsg = window.I18n?.t('automation.convert_vcai_confirm') || 'This will convert all AI text nodes (OpenAI, Anthropic, Google AI, etc.) to ViralCloner AI. Prompts will be preserved. Continue?';
        const confirmed = await confirmPrompt(confirmMsg);
        if (!confirmed) {
            return;
        }
        
        let convertedCount = 0;
        
        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            if (textAINodeTypes.includes(node.data.type)) {
                // Extract current prompt from node inputs
                let prompt = '';
                let temperature = 0.7;
                let maxTokens = '4096';
                let editText = node.data.text || 'edit text';
                
                if (node.data.inputs && Array.isArray(node.data.inputs)) {
                    for (const input of node.data.inputs) {
                        if (input.title === 'Prompt' && input.value) {
                            prompt = input.value;
                        }
                        if (input.title === 'Temperature' && input.value !== undefined) {
                            temperature = parseFloat(input.value) || 0.7;
                        }
                        if (input.title === 'Max Tokens' && input.value) {
                            maxTokens = input.value;
                        }
                    }
                }
                
                // Convert node to vcai
                node.data.type = 'vcai';
                node.data.label = 'ViralCloner AI';
                node.data.inputs = [
                    { type: 'textarea', title: 'Prompt', value: prompt, placeholder: 'Enter your prompt... Use {INPUT_1} for text input' },
                    { type: 'range', title: 'Temperature', value: temperature, min: 0, max: 2 },
                    {
                        type: 'select',
                        title: 'Model',
                        value: '',
                        options: [
                            { value: '', text: 'VC-1.0' }
                        ]
                    },
                    { type: 'input', title: 'Max Tokens', value: maxTokens, placeholder: 'Max tokens (e.g. 4096)' }
                ];
                node.data.icon = 'app-icon.png';
                node.data.inputTypes = ['text'];
                node.data.inputsHtml = ['Text'];
                node.data.outputTypes = ['text'];
                node.data.outputsHtml = ['Text'];
                
                // Also update the node name and class in drawflow
                node.name = 'vcai';
                node.class = 'vcai';
                
                // Update the stored HTML to persist the label change
                node.html = getHtml(['Text'], ['Text'], editText, 'ViralCloner AI', 'vcai');
                
                // Update node data in editor
                window.editor.updateNodeDataFromId(nodeId, node.data);
                
                // Update the node's visual label in the DOM
                const nodeEl = document.getElementById('node-' + nodeId);
                if (nodeEl) {
                    // Update the title span inside .node-content .center
                    const titleSpan = nodeEl.querySelector('.node-content .center > span');
                    if (titleSpan) {
                        titleSpan.textContent = 'ViralCloner AI';
                    }
                    // Update the node class from old type to vcai
                    nodeEl.classList.forEach(cls => {
                        if (textAINodeTypes.includes(cls)) {
                            nodeEl.classList.remove(cls);
                        }
                    });
                    nodeEl.classList.add('vcai');
                }
                
                convertedCount++;
            }
        }
        
        if (convertedCount > 0) {
            markAutomationModified();
            const successMsg = window.I18n?.t('automation.convert_vcai_success', { count: convertedCount }) || `Converted ${convertedCount} AI node(s) to ViralCloner AI`;
            showAlert('success', successMsg);
        }
    });

    $('#automation-container').on("click", '#saveAutomation', async function () {
        if (!currentID) return;

        // Add loading state
        const $saveBtn = $('#saveAutomation');
        $saveBtn.addClass('loading');
        $saveBtn.find('i').text('sync');
        $saveBtn.find('span').text('Saving...');

        function resetSaveButton() {
            $saveBtn.removeClass('loading');
            $saveBtn.find('i').text('save');
            $saveBtn.find('span').text('Save');
        }

        const allNodes = window.editor.drawflow.drawflow["Home"].data;

        // Migrate old OpenAI nodes that have deprecated API key input
        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            if (node.data.type === "openai" && 
                node.data.inputs && 
                node.data.inputs.length === 4 && 
                node.data.inputs[0]?.title === "Api key") {
                // Remove the deprecated Api key input (first element)
                node.data.inputs.shift();
                window.editor.updateNodeDataFromId(nodeId, node.data);
                console.log(`[Automation] Migrated old OpenAI node ${nodeId} - removed deprecated Api key input`);
            }
        }

        function hasOutputConnections(node) {
            return Object.values(node.outputs).some(output => output.connections.length > 0);
        }
        function hasInputConnections(node) {
            return Object.values(node.inputs).some(input => input.connections.length > 0);
        }

        const adjacency = {};
        let allFilled = true;
        let emptyNodeName = '';
        let emptyFieldName = '';

        for (const nodeId in allNodes) {
            adjacency[nodeId] = [];
            const node = allNodes[nodeId];

            // Upload nodes have no configurable inputs — provider is set globally in Settings.
            // Skip input validation for them entirely.
            if (node.data.type === "imageupload" || node.data.type === "videoupload") {
                for (const outputKey in node.outputs) {
                    const output = node.outputs[outputKey];
                    for (const conn of output.connections) {
                        adjacency[nodeId].push(conn.node);
                    }
                }
                continue;
            }

            if (node.data.inputs) {
                node.data.inputs.forEach((input, index) => {
                    let options = [];
                    switch (node.data.type) {
                        case "openai":
                            if (input.title === "Model" && node.data.type === "openai") options = gptModels;
                            break;
                        case "wordpress":
                            if (input.title === "Website" && node.data.type === "wordpress") options = websites;
                            break;
                        case "wprecipemaker":
                            if (input.title === "Website" && node.data.type === "wprecipemaker") options = websites;
                            break;
                        case "minicanvas":
                            if (input.title === "Template" && node.data.type === "minicanvas") options = minicanvas;
                            console.log(minicanvas)
                            console.log(node)
                            break;
                        case "googlesites":
                            if (input.title === "Google Profile (Auto-selected)" && node.data.type === "googlesites") options = [
                                { value: "all", text: "All Connected Profiles (Simultaneous)" },
                                ...googleProfiles
                            ];
                            break;
                    }
                    if (node?.data?.inputs?.[index] && options.length) {
                        node.data.inputs[index].options = options;
                        if (!node.data.inputs[index].options.map(elm => elm.value).includes(node.data.inputs[index].value)) {
                            const missingValue = node.data.inputs[index].value;
                            node.data.inputs[index].options.unshift({ value: missingValue, text: `Unavailable provider (${String(missingValue).split('|')[0] || 'not configured'})` });
                        }
                    }
                    if (input.value === "") {
                        if (node?.data?.inputs?.[index] && options.length) {
                            node.data.inputs[index].value = options[0].value;
                        }
                    }
                    window.editor.updateNodeDataFromId(nodeId, node.data);
                });
            }

            let updated = false;
            for (const dataInputKey in node.data.inputs) {
                const dataInput = node.data.inputs[dataInputKey];
                // Check if this is Google Sites auto-select
                const isGoogleSitesAutoSelect = node.data.type === "googlesites" && 
                                               dataInput.title === "Google Profile (Auto-selected)";
                
                // Check if this is VCAI model (empty = server default, which is valid)
                const isVCAIModel = node.data.type === "vcai" && dataInput.title === "Model";
                
                // Don't auto-fill Google Sites auto-select, VCAI model, or optional fields if empty value is intentional
                if (dataInput.type === "select" && dataInput.options.length > 0 && dataInput.value === "" && !isGoogleSitesAutoSelect && !isVCAIModel && !dataInput.optional) {
                    dataInput.value = dataInput.options[0].value;
                    updated = true;
                }
                
                // Allow empty values for Google Sites auto-select, VCAI model, and optional fields
                if ((!dataInput.value || dataInput.value == "") && !isGoogleSitesAutoSelect && !isVCAIModel && !dataInput.optional) {
                    allFilled = false;
                    if (!emptyNodeName) {
                        emptyNodeName = node.data.text && node.data.text !== 'edit text'
                            ? `${ucfirst(node.data.type)} ("${node.data.text}")`
                            : ucfirst(node.data.type);
                        emptyFieldName = dataInput.title || `Input ${parseInt(dataInputKey) + 1}`;
                    }
                }
            }

            if (updated) {
                window.editor.updateNodeDataFromId(nodeId, node.data);
            }

            for (const outputKey in node.outputs) {
                const output = node.outputs[outputKey];
                for (const conn of output.connections) {
                    adjacency[nodeId].push(conn.node);
                }
            }
        }

        if (!allFilled) {
            resetSaveButton();
            const msg = window.I18n?.t("automation.empty_node_value_detail", { node: emptyNodeName, field: emptyFieldName })
                || `Empty value in "${emptyNodeName}" → ${emptyFieldName}`;
            showAlert("error", msg);
            return;
        }

        let inputNodeId = null;
        const facebookNodeIds = [];
        const pinterestNodeIds = [];

        for (const nodeId in allNodes) {
            const type = allNodes[nodeId].data.type;
            if (type === "input") inputNodeId = nodeId;
            else if (type === "facebook-output") facebookNodeIds.push(nodeId);
            else if (type === "pinterest-output") pinterestNodeIds.push(nodeId);
        }



        function hasPathFromInputToEndOutputs() {
            if (!inputNodeId || !adjacency[inputNodeId]) return false;
            const targets = new Set([...facebookNodeIds, ...pinterestNodeIds]);
            const visited = new Set();
            const stack = [...adjacency[inputNodeId]];

            while (stack.length > 0) {
                const current = stack.pop();
                if (visited.has(current)) continue;
                visited.add(current);

                if (targets.has(current)) {
                    return true;
                }

                if (adjacency[current]) {
                    stack.push(...adjacency[current]);
                }
            }
            return false;
        }

        const inputNode = inputNodeId ? allNodes[inputNodeId] : null;
        const inputHasOutputs = inputNode ? hasOutputConnections(inputNode) : false;

        const facebookHasInputConnection = facebookNodeIds.some(id => hasInputConnections(allNodes[id]));
        const pinterestHasInputConnection = pinterestNodeIds.some(id => hasInputConnections(allNodes[id]));

        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            const type = node.data.type;
            if (type !== "input" && type !== "facebook-output" && type !== "pinterest-output") {
                const noInputs = !hasInputConnections(node);
                const noOutputs = !hasOutputConnections(node);
                if (noInputs && noOutputs) {
                    window.editor.removeNodeId(`node-${nodeId}`);
                }
            }
        }

        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            const nodeEl = document.querySelector(`#node-${nodeId} .editable-text`);
            if (nodeEl) {
                node.data.text = nodeEl.innerText.trim();
            }
        }

        const routeValid =
            (facebookHasInputConnection || pinterestHasInputConnection);

        if (routeValid) {
            const data = window.editor.export();
            const automations = await window.electronAPI.readKey("automations") || [];

            const automation = automations.find(item => item.id === currentID);
            if (automation) {
                automation.data = data;
                automation.status = "active";

                // Capture screenshot of drawflow canvas
                try {
                    const drawflowCanvas = document.getElementById('drawflow');
                    const canvas = await html2canvas(drawflowCanvas, {
                        backgroundColor: '#1a1a1a',
                        scale: 1,
                        logging: false,
                        useCORS: true
                    });
                    const screenshotDataUrl = canvas.toDataURL('image/png');
                    const screenshotFileName = await window.electronAPI.saveAutomationScreenshot(currentID, screenshotDataUrl);
                    automation.screenshot = screenshotFileName;
                } catch (err) {
                    console.warn('Failed to capture screenshot:', err);
                }

                await window.electronAPI.updateData("automations", automations);
                clearAutomationModified(); // Clear unsaved state after successful save
                resetSaveButton();
                showAlert("success", "Automation saved successfully");
            }
        } else {
            resetSaveButton();
            showAlert(
                "error",
                "Invalid route: At least one Facebook or Pinterest output must be connected to another node"
            );
        }
    });

    $('#automation-container').on("click", '#returnBack', async function () {
        if (window.hasUnsavedAutomation) {
            const msg = window.I18n?.t('alerts.confirm_unsaved') || 'You have unsaved changes. Are you sure you want to leave?';
            const confirmed = await confirmPrompt(msg);
            if (!confirmed) return;
        }
        clearAutomationModified(); // Clear unsaved state when leaving editor
        updateAutomations();
        // Hide AI agent FAB and panel when leaving editor
        $('#aiAgentFab').hide().removeClass('active');
        $('#aiAgentPanel').removeClass('open');
        const editor = $("#automation-container .automation-editor");
        editor.animate({
            top: '-100%',
            opacity: 0
        }, 100, function () {
            editor.hide();
            $("#automation-container .automation-list").show();
        });
    });

    $('#automation-container').on("click", '#importAutomation', async function () {
        const automationNameField = window.I18n?.t('common.automation_name') || "Automation name";
        const result = await newPrompt([
            { type: "text", name: automationNameField, required: true }
        ]);
        if (!result) return;
        const automationName = result[automationNameField];
        const importResult = await window.electronAPI.importAutomation(automationName);
        if (importResult.success) {
            updateAutomations();
            showAlert("success", "Automation imported successfully");
        } else {
            showAlert("error", importResult.value);
        }
    });

    $('#automation-container').on("click", '#newAutomation', async function () {
        const automationNameField = window.I18n?.t('common.automation_name') || "Automation name";
        const result = await newPrompt([
            { type: "text", name: automationNameField, required: true }
        ]);
        if (!result) return;
        const randomID = generateRandomString(10);
        const automations = await window.electronAPI.readKey("automations") || [];
        const timestampInSeconds = Math.floor(Date.now() / 1000);
        automations.push({
            label: result[automationNameField],
            id: randomID,
            data: {},
            status: "inactive",
            time: timestampInSeconds
        });
        await window.electronAPI.updateData("automations", automations);
        
        // Log activity for new automation
        await window.electronAPI.logActivity(
            "automation",
            `Automation "${result[automationNameField]}" created`,
            "automation",
            randomID
        );

        currentID = randomID;
        $("#automation-container .automation-list").hide();
        const editor = $("#automation-container .automation-editor");
        editor.css({
            display: 'flex',
            position: 'relative',
            top: '-100%',
            opacity: 0
        }).animate({
            top: '0',
            opacity: 1
        }, 300);
        startAutomationEditor();
    });

    $('#automation-container').on("click", '[data-role="exportAutomation"]', async function () {
        const id = $(this).attr("data-id");
        $(this).attr("disabled", "");
        const result = await window.electronAPI.exportAutomation(id);
        $(this).removeAttr("disabled");
        if (result.success) {
            showAlert("success", "Automation savec successfully!");
        } else {
            showAlert("error", result.value);
        }
    });

    $('#automation-container').on("click", '[data-role="editAutomation"]', async function () {
        const id = $(this).attr("data-id");
        currentID = id;
        $("#automation-container .automation-list").hide();
        const editor = $("#automation-container .automation-editor");
        editor.css({
            display: 'flex',
            position: 'relative',
            top: '-100%',
            opacity: 0
        }).animate({
            top: '0',
            opacity: 1
        }, 300);
        startAutomationEditor();
    });

    $('#automation-container').on("click", '[data-role="renameAutomation"]', async function () {
        const id = $(this).attr("data-id");
        const automations = await window.electronAPI.readKey("automations") || [];
        const automation = automations.find(item => item.id === id);
        if (!automation) {
            showAlert("error", "Automation not found");
            return;
        }

        const newNameField = window.I18n?.t('automation.new_name') || "New name";
        const result = await newPrompt([
            { type: "text", name: newNameField, required: true, value: automation.label }
        ]);
        if (!result) return;

        const newName = result[newNameField];
        if (newName === automation.label) return; // No change

        const oldName = automation.label;
        automation.label = newName;
        await window.electronAPI.updateData("automations", automations);

        // Log activity for automation rename
        await window.electronAPI.logActivity(
            "automation",
            `Automation renamed from "${oldName}" to "${newName}"`,
            "automation",
            id
        );

        updateAutomations();
        showAlert("success", window.I18n?.t('automation.rename_success') || "Automation renamed successfully");
    });

    $('#automation-container').on("click", '[data-role="deleteAutomation"]', async function () {
        const id = $(this).attr("data-id");
        const confirmed = await confirmPrompt("Do you really want to delete this automation?");
        if (!confirmed) return;
        const automations = await window.electronAPI.readKey("automations") || [];
        const automationToDelete = automations.find(item => item.id === id);
        const automationName = automationToDelete?.label || 'Unknown';
        const updatedAutomations = automations.filter(item => item.id !== id);
        await window.electronAPI.updateData("automations", updatedAutomations);
        
        // Log activity for automation deletion
        await window.electronAPI.logActivity(
            "delete",
            `Automation "${automationName}" deleted`,
            "automation",
            id
        );
        
        updateAutomations();
    });

    // Multi-select functionality
    function updateBulkActionsBar() {
        const selectedCount = $('.automation-checkbox:checked').length;
        const totalCount = $('.automation-checkbox').length;
        
        if (selectedCount > 0) {
            $('#bulkActionsBar').slideDown(200);
            $('#selectedCount').text(selectedCount);
        } else {
            $('#bulkActionsBar').slideUp(200);
        }
        
        // Update "Select All" checkbox state
        const $selectAll = $('#selectAllAutomations');
        if (selectedCount === 0) {
            $selectAll.prop('checked', false);
            $selectAll.prop('indeterminate', false);
        } else if (selectedCount === totalCount) {
            $selectAll.prop('checked', true);
            $selectAll.prop('indeterminate', false);
        } else {
            $selectAll.prop('checked', false);
            $selectAll.prop('indeterminate', true);
        }
    }

    // Select All checkbox handler
    $('#automation-container').on("change", '#selectAllAutomations', function () {
        const isChecked = $(this).prop('checked');
        $('.automation-checkbox').prop('checked', isChecked);
        // Toggle selected class on all rows
        $('.automation-checkbox').each(function() {
            $(this).closest('tr').toggleClass('selected', isChecked);
        });
        updateBulkActionsBar();
    });

    // Individual checkbox handler
    $('#automation-container').on("change", '.automation-checkbox', function () {
        // Toggle selected class on this row
        $(this).closest('tr').toggleClass('selected', $(this).prop('checked'));
        updateBulkActionsBar();
    });

    // Clear selection button
    $('#automation-container').on("click", '#clearSelectionBtn', function () {
        $('.automation-checkbox').prop('checked', false);
        $('#selectAllAutomations').prop('checked', false).prop('indeterminate', false);
        // Remove selected class from all rows
        $('#automationsTableBody tr').removeClass('selected');
        updateBulkActionsBar();
    });

    // Bulk delete button
    $('#automation-container').on("click", '#bulkDeleteBtn', async function () {
        const selectedIds = [];
        $('.automation-checkbox:checked').each(function () {
            selectedIds.push($(this).attr('data-id'));
        });

        if (selectedIds.length === 0) return;

        const warningMessage = window.I18n?.t('automation.bulk.delete_warning', { count: selectedIds.length }) 
            || `Are you sure you want to delete ${selectedIds.length} automation(s)? This action cannot be undone.`;
        
        const confirmed = await confirmPrompt(warningMessage);
        if (!confirmed) return;

        const $deleteBtn = $('#bulkDeleteBtn');
        $deleteBtn.prop('disabled', true);
        $deleteBtn.find('span').text(window.I18n?.t('automation.bulk.deleting') || 'Deleting...');

        try {
            const automations = await window.electronAPI.readKey("automations") || [];
            const deletedNames = [];
            
            // Collect names for logging
            selectedIds.forEach(id => {
                const automation = automations.find(item => item.id === id);
                if (automation) deletedNames.push(automation.label);
            });

            // Filter out selected automations
            const updatedAutomations = automations.filter(item => !selectedIds.includes(item.id));
            await window.electronAPI.updateData("automations", updatedAutomations);

            // Log activity for bulk deletion
            await window.electronAPI.logActivity(
                "delete",
                `Bulk deleted ${selectedIds.length} automation(s): ${deletedNames.join(', ')}`,
                "automation",
                selectedIds.join(',')
            );

            showAlert("success", window.I18n?.t('automation.bulk.delete_success', { count: selectedIds.length }) 
                || `Successfully deleted ${selectedIds.length} automation(s)`);
            
            updateAutomations();
        } catch (error) {
            showAlert("error", window.I18n?.t('automation.bulk.delete_error') || "Failed to delete automations: " + error.message);
        } finally {
            $deleteBtn.prop('disabled', false);
            $deleteBtn.find('span').text(window.I18n?.t('automation.bulk.delete_selected') || 'Delete Selected');
            $('#bulkActionsBar').slideUp(200);
        }
    });

    // Reset automation thumbnail (will regenerate on next workflow run)
    $('#automation-container').on("click", '[data-role="resetThumbnail"]', async function () {
        const id = $(this).attr("data-id");
        const confirmed = await confirmPrompt("Reset thumbnail? A new one will be generated on the next workflow run.");
        if (!confirmed) return;
        
        try {
            const result = await window.electronAPI.deleteAutomationThumbnail(id);
            if (result.success) {
                showAlert("success", "Thumbnail reset. A new one will be generated on the next workflow run.");
                updateAutomations();
            } else {
                showAlert("error", result.error || "Failed to reset thumbnail");
            }
        } catch (error) {
            showAlert("error", "Failed to reset thumbnail: " + error.message);
        }
    });

    $('#automation-container').on("click", '[data-role="duplicateAutomation"]', async function () {
        const id = $(this).attr("data-id");
        const automations = await window.electronAPI.readKey("automations") || [];
        const original = automations.find(item => item.id === id);
        if (!original) {
            showAlert("error", "Automation not found");
            return;
        }

        const automationNameField = window.I18n?.t('common.automation_name') || "Automation name";
        const result = await newPrompt([
            { type: "text", name: automationNameField, required: true, value: original.label + " (Copy)" }
        ]);
        if (!result) return;

        const randomID = generateRandomString(10);
        const timestampInSeconds = Math.floor(Date.now() / 1000);

        automations.push({
            label: result[automationNameField],
            id: randomID,
            data: JSON.parse(JSON.stringify(original.data)), // Deep clone the workflow data
            status: "inactive",
            time: timestampInSeconds
        });

        await window.electronAPI.updateData("automations", automations);
        
        // Log activity for automation duplication
        await window.electronAPI.logActivity(
            "automation",
            `Automation "${result[automationNameField]}" duplicated from "${original.label}"`,
            "automation",
            randomID
        );
        
        updateAutomations();
        showAlert("success", "Automation duplicated successfully");
    });

    updateAutomations();
    async function updateAutomations() {
        const automations = await window.electronAPI.readKey('automations');

        // Reset bulk selection state
        $('#bulkActionsBar').hide();
        $('#selectAllAutomations').prop('checked', false).prop('indeterminate', false);

        // Check if there's a pending automation selection from FB Analytics
        const pendingSelection = window.pendingAutomationSelection;
        if (pendingSelection) {
            window.pendingAutomationSelection = null; // Clear it
            const targetAutomation = automations?.find(a => a.id === pendingSelection);
            if (targetAutomation) {
                // Auto-open the editor for this automation
                currentID = pendingSelection;
                setTimeout(() => {
                    $("#automation-container .automation-list").hide();
                    const editor = $("#automation-container .automation-editor");
                    editor.css({
                        display: 'flex',
                        position: 'relative',
                        top: '-100%',
                        opacity: 0
                    }).animate({
                        top: '0',
                        opacity: 1
                    }, 300);
                    startAutomationEditor();
                }, 100);
            }
        }

        if (automations && automations.length > 0) {
            $("#automationsTableContainer").show();
            $("#emptyAutomations").hide();
            $("#automationsTableBody").html("");

            for (var i = 0; i < automations.length; i++) {
                const automation = automations[i];
                const date = new Date(automation["time"] * 1000);
                const readable = date.toLocaleString();
                
                // Prefer thumbnail (generated from workflow output) over screenshot (flow diagram)
                const thumbnailPath = automation.thumbnail
                    ? `file://${window.localPath}/AutomationThumbnails/${automation.thumbnail}`
                    : null;
                const screenshotPath = automation.screenshot
                    ? `file://${window.localPath}/AutomationScreenshots/${automation.screenshot}`
                    : null;
                const previewPath = thumbnailPath || screenshotPath;

                const rowHtml = `
                    <tr data-id="${automation.id}">
                        <td class="checkbox-column">
                            <label class="custom-checkbox">
                                <input type="checkbox" class="automation-checkbox" data-id="${automation.id}">
                                <span class="checkmark"></span>
                            </label>
                        </td>
                        <td class="automation-preview">
                            <div class="preview-thumbnail ${!previewPath ? 'no-screenshot' : ''} ${thumbnailPath ? 'has-thumbnail' : ''}">
                                ${previewPath
                                    ? `<img src="${previewPath}" alt="${automation.label}" onerror="this.parentElement.classList.add('no-screenshot'); this.style.display='none'; this.parentElement.innerHTML+='<i class=\\'material-icons\\'>account_tree</i>';">`
                                    : '<i class="material-icons">account_tree</i>'
                                }
                            </div>
                        </td>
                        <td class="automation-name">
                            <div class="name-cell">${automation.label}</div>
                        </td>
                        <td class="automation-id">
                            <code>${automation.id}</code>
                        </td>
                        <td class="automation-date">${readable}</td>
                        <td class="automation-status">
                            <span class="status-badge status-${automation.status}">
                                <span class="status-dot"></span>
                                ${window.I18n?.t('automation.status.' + automation.status) || ucfirst(automation.status)}
                            </span>
                        </td>
                        <td class="automation-actions">
                            <div class="action-dropdown">
                                <button class="action-dropdown-toggle" title="${window.I18n?.t('automation.table.actions') || 'Actions'}">
                                    <i class="material-icons">more_vert</i>
                                </button>
                                <div class="action-dropdown-menu">
                                    <button data-role="editAutomation" data-id="${automation.id}" class="action-dropdown-item item-primary">
                                        <i class="material-icons">edit</i>
                                        <span>${window.I18n?.t('automation.actions.edit') || 'Edit'}</span>
                                    </button>
                                    <button data-role="renameAutomation" data-id="${automation.id}" class="action-dropdown-item">
                                        <i class="material-icons">drive_file_rename_outline</i>
                                        <span>${window.I18n?.t('automation.actions.rename') || 'Rename'}</span>
                                    </button>
                                    <button data-role="exportAutomation" data-id="${automation.id}" class="action-dropdown-item item-success">
                                        <i class="material-icons">file_download</i>
                                        <span>${window.I18n?.t('automation.actions.export') || 'Export'}</span>
                                    </button>
                                    <button data-role="duplicateAutomation" data-id="${automation.id}" class="action-dropdown-item">
                                        <i class="material-icons">content_copy</i>
                                        <span>${window.I18n?.t('automation.actions.duplicate') || 'Duplicate'}</span>
                                    </button>
                                    ${automation.thumbnail ? `
                                    <button data-role="resetThumbnail" data-id="${automation.id}" class="action-dropdown-item">
                                        <i class="material-icons">refresh</i>
                                        <span>${window.I18n?.t('automation.actions.reset_thumbnail') || 'Reset Thumbnail'}</span>
                                    </button>
                                    ` : ''}
                                    <div class="action-dropdown-divider"></div>
                                    <button data-role="deleteAutomation" data-id="${automation.id}" class="action-dropdown-item item-danger">
                                        <i class="material-icons">delete</i>
                                        <span>${window.I18n?.t('automation.actions.delete') || 'Delete'}</span>
                                    </button>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;

                $("#automationsTableBody").append(rowHtml);
            }
        } else {
            $("#automationsTableContainer").hide();
            $("#emptyAutomations").show();
        }
    }

    // ========== Preview Image Hover Popup ==========
    let hoverPopup = null;
    let hidePopupTimeout = null;

    function createHoverPopup() {
        if (!hoverPopup) {
            hoverPopup = $(`
                <div class="preview-hover-popup">
                    <div class="preview-hover-popup-inner">
                        <img src="" alt="Preview">
                        <div class="preview-hover-popup-label"></div>
                    </div>
                </div>
            `).appendTo('body');
        }
        return hoverPopup;
    }

    function showPreviewPopup($thumbnail, imgSrc, label) {
        if (hidePopupTimeout) {
            clearTimeout(hidePopupTimeout);
            hidePopupTimeout = null;
        }
        
        const popup = createHoverPopup();
        const $img = popup.find('img');
        const $label = popup.find('.preview-hover-popup-label');
        
        // Update content
        $img.attr('src', imgSrc);
        $label.text(label);
        
        // Position popup near the thumbnail
        const thumbRect = $thumbnail[0].getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const popupWidth = 252; // 240 + 12 padding
        const popupHeight = 280; // approximate with label
        
        // Default position: right of thumbnail
        let left = thumbRect.right + 12;
        let top = thumbRect.top - 20;
        
        // If popup would go off right edge, position to the left of thumbnail
        if (left + popupWidth > viewportWidth - 20) {
            left = thumbRect.left - popupWidth - 12;
        }
        
        // If popup would go off left edge, center it
        if (left < 20) {
            left = Math.max(20, (viewportWidth - popupWidth) / 2);
        }
        
        // Ensure popup doesn't go off bottom
        if (top + popupHeight > viewportHeight - 20) {
            top = viewportHeight - popupHeight - 20;
        }
        
        // Ensure popup doesn't go off top
        if (top < 20) {
            top = 20;
        }
        
        popup.css({
            left: left + 'px',
            top: top + 'px'
        });
        
        // Trigger animation
        requestAnimationFrame(() => {
            popup.addClass('visible');
        });
    }

    function hidePreviewPopup(immediate = false) {
        if (!hoverPopup) return;
        
        if (immediate) {
            hoverPopup.removeClass('visible');
        } else {
            hidePopupTimeout = setTimeout(() => {
                hoverPopup.removeClass('visible');
                hidePopupTimeout = null;
            }, 100);
        }
    }

    // Mouse enter on preview thumbnail
    $('#automation-container').on('mouseenter', '.preview-thumbnail:not(.no-screenshot)', function(e) {
        const $this = $(this);
        const $img = $this.find('img');
        
        if ($img.length && $img.attr('src')) {
            const $row = $this.closest('tr');
            const automationName = $row.find('.automation-name .name-cell').text().trim();
            showPreviewPopup($this, $img.attr('src'), automationName);
        }
    });

    // Mouse leave on preview thumbnail
    $('#automation-container').on('mouseleave', '.preview-thumbnail', function(e) {
        hidePreviewPopup();
    });

    // Hide popup when scrolling the table
    $('#automation-container').on('scroll', '#automationsTableContainer', function() {
        hidePreviewPopup(true);
    });

    // Cleanup popup on page unload
    $(window).on('beforeunload.automationPreview', function() {
        if (hoverPopup) {
            hoverPopup.remove();
            hoverPopup = null;
        }
    });

    async function startAutomationEditor() {
        if (currentID) {
            await loadNodeOptionsOnce();

            window.editor.clear();
            window.editor.zoom = 0.75;
            window.editor.zoom_refresh();

            const automations = await window.electronAPI.readKey('automations');
            const automation = automations?.find(item => item.id === currentID);
            const automationData = automation?.data || {};

            const editorWidth = $editorid.width();
            const editorHeight = $editorid.height();
            const nodeHeight = 60;
            const defaultNodes = [
                {
                    type: 'input',
                    inputsCount: 0,
                    outputsCount: 2,
                    posX: -140,
                    posY: (editorHeight / 2) - (nodeHeight / 2),
                    className: 'unhideable',
                    data: {
                        type: 'input',
                        inputTypes: [],
                        outputTypes: ['url', 'text']
                    },
                    html: `<div class="node-content" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 10px; margin-left: 10px;">
                            <span>Image URL</span>
                            <span>Text</span>
                        </div>
                        <div class="flex-center ms-2">
                            <i class="material-icons node-info-icon" data-node-type="input">info</i>
                        </div>
                    </div>`
                },
                {
                    type: 'output',
                    inputsCount: 5,
                    outputsCount: 0,
                    posX: editorWidth - 40,
                    posY: 0,
                    className: 'unhideable',
                    data: {
                        type: 'pinterest-output',
                        inputTypes: ['url', 'text', 'text', 'url', 'url'],
                        outputTypes: []
                    },
                    html: `<div class="node-content" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 10px; margin-left: 10px;">
                            <span>Image url</span>
                            <span>Title</span>
                            <span>Description</span>
                            <span>Url</span>
                            <span>Video URL</span>
                        </div>
                        <div class="flex-center ms-3">   
                            <img class="me-2" width="20" src="assets/images/icons/pinterest-colored.png">
                            <span>Pinterest</span>
                            <i class="material-icons node-info-icon ms-1" data-node-type="pinterest-output">info</i>
                        </div>
                    </div>`
                },
                {
                    type: 'output',
                    inputsCount: 3,
                    outputsCount: 0,
                    posX: editorWidth - 40,
                    posY: editorHeight,
                    className: 'unhideable',
                    data: {
                        type: 'facebook-output',
                        inputTypes: ['image', 'text', 'video'],
                        outputTypes: []
                    },
                    html: `<div class="node-content" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 10px; margin-left: 10px;">
                            <span>Image</span>
                            <span>Text</span>
                            <span>Video</span>
                        </div>
                        <div class="flex-center ms-3">   
                            <img class="me-2" width="20" src="assets/images/icons/facebook-colored.png">
                            <span>Facebook</span>
                            <i class="material-icons node-info-icon ms-1" data-node-type="facebook-output">info</i>
                        </div>
                    </div>`
                }
            ];

            if (Object.keys(automationData).length === 0) {
                // Empty canvas - user can drag Input/Output nodes from sidebar
            } else {
                window.editor.clear();
                
                // Migrate old OpenAI nodes before importing
                const allNodes = automationData.drawflow["Home"].data;
                for (const nodeId in allNodes) {
                    const nodeData = allNodes[nodeId];
                    if (nodeData.data.type === "openai" && 
                        nodeData.data.inputs && 
                        nodeData.data.inputs.length === 4 && 
                        nodeData.data.inputs[0]?.title === "Api key") {
                        // Remove the deprecated Api key input (first element)
                        nodeData.data.inputs.shift();
                        console.log(`[Automation] Migrated old OpenAI node ${nodeId} on load - removed deprecated Api key input`);
                    }
                }
                
                window.editor.import(automationData);

                for (const nodeId in allNodes) {
                    const nodeData = allNodes[nodeId];
                    const textValue = nodeData.data?.text || "";
                    const htmlElement = $(`.drawflow-node.${nodeData.class} .editable-text`);
                    if (htmlElement) {
                        htmlElement.text(textValue);
                    }
                }
                
                // Inject info icons into existing nodes
                injectInfoIconsIntoExistingNodes();
                
                // Inject dynamic input controls for Variables nodes
                injectVariablesNodeControls();
                
                // Inject dynamic output controls for Splitter nodes
                injectSplitterNodeControls();
                
                // Inject SubAutomation node labels
                injectSubAutomationNodeControls();
                
                // Refresh all connection paths after DOM modifications
                // (info icons, controls injection may change node sizes)
                requestAnimationFrame(() => {
                    for (const nodeId in allNodes) {
                        window.editor.updateConnectionNodes("node-" + nodeId);
                    }
                });

                // Center the view on the midpoint of all nodes
                const nodeIds = Object.keys(allNodes);
                if (nodeIds.length > 0) {
                    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                    for (const nid of nodeIds) {
                        const n = allNodes[nid];
                        if (n.pos_x < minX) minX = n.pos_x;
                        if (n.pos_x > maxX) maxX = n.pos_x;
                        if (n.pos_y < minY) minY = n.pos_y;
                        if (n.pos_y > maxY) maxY = n.pos_y;
                    }
                    const centerX = (minX + maxX) / 2;
                    const centerY = (minY + maxY) / 2;
                    const edW = $editorid.width();
                    const edH = $editorid.height();
                    const z = window.editor.zoom;
                    window.editor.canvas_x = (edW / 2) - (centerX * z);
                    window.editor.canvas_y = (edH / 2) - (centerY * z);
                    window.editor.precanvas.style.transform = 
                        "translate(" + window.editor.canvas_x + "px, " + window.editor.canvas_y + "px) scale(" + z + ")";
                }
            }
        }
        
        // Mark as clean state after loading (this is the saved state)
        clearAutomationModified();
        
        // Clear undo history when loading new automation
        clearUndoHistory();
        
        // Show AI agent FAB when entering the editor
        $('#aiAgentFab').css('display', 'flex');
    }

    $('#automation-container').on("click", '#inputsBack', async function () {
        $('.drawflow-node.selected').removeClass('selected');
        window.editor.node_selected = null;
        $(".automation-sidebar .main-bar").show();
        $(".automation-sidebar .inputs").hide();
    });

    let unselectTimeout = null;

    window.editor.on("nodeUnselected", function (id) {
        clearTimeout(unselectTimeout);

        unselectTimeout = setTimeout(() => {
            $(".automation-sidebar .main-bar").show();
            $(".automation-sidebar .inputs").hide();
        }, 50);
    });

    window.editor.on("nodeSelected", function (id) {
        clearTimeout(unselectTimeout);

        const nodeData = window.editor.getNodeFromId(id);
        $(".automation-sidebar .inputs-container").html("");

        // Upload providers are managed centrally in Settings > Media Hosting.
        // Older workflows may still carry a legacy provider value, but runtime
        // execution intentionally ignores it in favor of the current default.
        if (nodeData.data.type === "imageupload" || nodeData.data.type === "videoupload") {
            $(".automation-sidebar .main-bar").show();
            $(".automation-sidebar .inputs").hide();
            return;
        }

        if (
            nodeData.data.inputs &&
            nodeData.data.type !== "input" &&
            nodeData.data.type !== "facebook-output" &&
            nodeData.data.type !== "pinterest-output"
        ) {
            $(".automation-sidebar .main-bar").hide();
            $(".automation-sidebar .inputs").show();

            nodeData.data.inputs.forEach((input, index) => {
                let inputHTML = "";
                let valueDisplay = `<span class="value-display"></span>`;

                if (input.type === "textarea") {
                    const rawText = (input.value || '').substring(0, 50) + ((input.value || '').length > 50 ? '...' : '');
                    // Escape HTML to prevent rendering
                    const previewText = rawText
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');
                    inputHTML = `
                        <div class="textarea-expander" data-index="${index}" data-value="${encodeURIComponent(input.value || '')}" data-placeholder="${input.placeholder}">
                            <div class="textarea-preview">${previewText || '<span class="placeholder-text">Click to edit...</span>'}</div>
                            <button type="button" class="btn-expand-textarea">
                                <i class="material-icons">edit</i>
                                <span>Edit</span>
                            </button>
                        </div>`;
                } else if (input.type === "range") {
                    const rangeValue = input.value ?? input.min;
                    inputHTML = `<input placeholder="${input.placeholder}" class="w-100 range-input" type="range" data-index="${index}" min="${input.min}" max="${input.max}" step="0.01" value="${rangeValue}">`;
                    valueDisplay = `<span class="range-value ms-2">${rangeValue}</span>`;
                } else if (input.type === "select") {
                    let options = [];
                    switch (nodeData.data.type) {
                        case "openai":
                            if (input.title === "Model" && nodeData.data.type === "openai") options = gptModels;
                            break;
                        case "wordpress":
                            if (input.title === "Website" && nodeData.data.type === "wordpress") options = websites;
                            break;
                        case "wprecipemaker":
                            if (input.title === "Website" && nodeData.data.type === "wprecipemaker") options = websites;
                            break;
                        case "minicanvas":
                            if (input.title === "Template" && nodeData.data.type === "minicanvas") options = minicanvas;
                            break;
                        case "videoeditor":
                            if (input.title === "Template") options = (currentAutomationNodes.find(n => n.type === 'videoeditor')?.inputs[0]?.options) || [];
                            else if (input.options) options = input.options;
                            break;
                        case "googlesites":
                            if (input.title === "Google Profile (Auto-selected)" && nodeData.data.type === "googlesites") options = [
                                { value: "all", text: "All Connected Profiles (Simultaneous)" },
                                ...googleProfiles
                            ];
                            break;
                        case "vctts":
                            if (input.title === "Locale") {
                                options = ttsLocales;
                            } else if (input.title === "Voice") {
                                const currentLocale = nodeData.data.inputs[0]?.value || "en-US";
                                options = ttsVoicesByLocale[currentLocale] || ttsAllVoices;
                            }
                            break;
                        default:
                            if (input.options && input.options.length > 0) {
                                if (typeof input.options[0] === "string") {
                                    options = input.options.map(opt => ({ value: opt, text: opt }));
                                } else {
                                    options = input.options;
                                }
                            }
                    }
                    // TTS locale: render as searchable dropdown
                    if (nodeData.data.type === "vctts" && input.title === "Locale") {
                        const selectedOpt = options.find(o => o.value === input.value) || options[0] || { value: '', text: '' };
                        inputHTML = `<div class="tts-locale-picker" data-index="${index}" data-value="${selectedOpt.value}">
                            <div class="tts-locale-selected form-select">${selectedOpt.text}</div>
                            <div class="tts-locale-dropdown" style="display:none;">
                                <input type="text" class="tts-locale-search form-control" placeholder="Search locale...">
                                <div class="tts-locale-options">
                                    ${options.map(opt => `<div class="tts-locale-option${opt.value === input.value ? ' active' : ''}" data-value="${opt.value}">${opt.text}</div>`).join('')}
                                </div>
                            </div>
                        </div>`;
                    } else if (nodeData.data.type === "vctts" && input.title === "Voice") {
                    inputHTML = `<div class="tts-voice-row">
                        <select class="form-select" data-index="${index}">
                            ${options.map(opt => `<option value="${opt.value}" ${opt.value === input.value ? "selected" : ""}>${opt.text}</option>`).join("")}
                        </select>
                        <button type="button" class="tts-voice-preview-btn" title="Preview voice">
                            <span class="material-icons">play_circle</span>
                        </button>
                    </div>
                    <input type="text" class="form-control tts-preview-text" placeholder="Preview text..." value="Hello, this is a preview of the selected voice." style="margin-top:6px;">`;
                    } else {
                    inputHTML = `<select class="form-select" data-index="${index}">
                        ${options.map(
                        opt => `<option value="${opt.value}" ${opt.value === input.value ? "selected" : ""}>${opt.text}</option>`
                    ).join("")}
                    </select>`;
                    }
                } else if (input.type === "input") {
                    // Escape HTML in input values
                    const escapedValue = (input.value || '')
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');
                    inputHTML = `<input placeholder="${input.placeholder}" class="form-control" type="text" data-index="${index}" value="${escapedValue}">`;
                } else if (input.type === "music-picker") {
                    // Multi-select music picker with thumbnails and play buttons
                    let selectedArr = [];
                    try { selectedArr = JSON.parse(input.value || '[]'); } catch(_) {}
                    if (!Array.isArray(selectedArr)) selectedArr = (input.value && input.value !== 'none') ? [input.value] : [];

                    // Get local audio files from the selected template
                    const selectedTemplateId = nodeData.data.inputs[0]?.value;
                    const selectedTemplate = (videoTemplatesList || []).find(t => t.id === selectedTemplateId || t.projectId === selectedTemplateId);
                    const localAudioItems = (selectedTemplate?.project?.media || selectedTemplate?.media || []).filter(m => m.type === 'audio');

                    const noneLabel = window.I18n?.t('automation.videoeditor.music_none') || "No Music";
                    // For label: check both server library and local items
                    const allMusicItems = [
                        ...(musicLibraryItems || []).map(m => ({ value: m.filename, label: m.title || m.filename, isLocal: false })),
                        ...localAudioItems.map(m => ({ value: m.source, label: m.name || m.source.split(/[/\\]/).pop(), isLocal: true }))
                    ];
                    const countLabel = selectedArr.length === 0 ? noneLabel
                        : (selectedArr.length === 1
                            ? (allMusicItems.find(m => m.value === selectedArr[0])?.label || selectedArr[0].split(/[/\\]/).pop())
                            : (selectedArr.length + ' ' + (window.I18n?.t('automation.videoeditor.music_tracks') || 'tracks selected')));
                    inputHTML = `<div class="auto-music-picker" data-index="${index}">
                        <div class="auto-music-picker-selected">
                            <span class="material-icons" style="font-size:18px;margin-right:6px;">${selectedArr.length > 0 ? 'library_music' : 'music_off'}</span>
                            <span class="auto-music-picker-label">${countLabel}</span>
                            <span class="material-icons auto-music-picker-arrow">expand_more</span>
                        </div>
                        <div class="auto-music-picker-dropdown" style="display:none;">
                            <div class="auto-music-picker-search-row">
                                <input type="text" class="auto-music-picker-search" placeholder="${window.I18n?.t('videoeditor.search_music') || 'Search music...'}">
                            </div>
                            <div class="auto-music-picker-hint">${window.I18n?.t('automation.videoeditor.music_hint') || 'Select tracks. A random one will be used each run.'}</div>
                            <div class="auto-music-picker-options">
                                ${localAudioItems.length > 0 ? `<div class="auto-music-picker-section-label">${window.I18n?.t('automation.videoeditor.music_my_musics') || 'My Musics'}</div>` : ''}
                                ${localAudioItems.map(m => {
                                    const displayName = m.name || m.source.split(/[/\\]/).pop();
                                    const escapedPath = m.source.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                                    const escapedTitle = displayName.replace(/"/g, '&quot;');
                                    const isChecked = selectedArr.includes(m.source);
                                    return `<div class="auto-music-picker-option auto-music-picker-option-local${isChecked ? ' checked' : ''}" data-value="${escapedPath}" data-title="${escapedTitle}" data-is-local="1">
                                        <span class="auto-music-picker-check material-icons">${isChecked ? 'check_box' : 'check_box_outline_blank'}</span>
                                        <div class="auto-music-picker-thumb-placeholder"><span class="material-icons">audio_file</span></div>
                                        <span class="auto-music-picker-opt-title">${displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
                                        <button type="button" class="auto-music-play-btn" data-localpath="${escapedPath}" data-is-local="1" title="Preview"><span class="material-icons">play_arrow</span></button>
                                    </div>`;
                                }).join('')}
                                ${(musicLibraryItems || []).length > 0 ? `<div class="auto-music-picker-section-label">${window.I18n?.t('automation.videoeditor.music_library') || 'Music Library'}</div>` : ''}
                                ${(musicLibraryItems || []).map(m => {
                                    const tUrl = m.thumbnail ? '' : '';
                                    const thumbHtml = tUrl ? `<img src="${tUrl}" class="auto-music-picker-thumb-img">` : '<div class="auto-music-picker-thumb-placeholder"><span class="material-icons">music_note</span></div>';
                                    const dur = m.duration ? Math.floor(m.duration / 60) + ':' + String(m.duration % 60).padStart(2, '0') : '';
                                    const isChecked = selectedArr.includes(m.filename);
                                    return `<div class="auto-music-picker-option${isChecked ? ' checked' : ''}" data-value="${m.filename}" data-title="${(m.title || '').replace(/"/g, '&quot;')}">
                                        <span class="auto-music-picker-check material-icons">${isChecked ? 'check_box' : 'check_box_outline_blank'}</span>
                                        ${thumbHtml}
                                        <span class="auto-music-picker-opt-title">${m.title || m.filename}</span>
                                        ${dur ? `<span class="auto-music-picker-opt-dur">${dur}</span>` : ''}
                                        <button type="button" class="auto-music-play-btn" data-filename="${m.filename}" title="Preview"><span class="material-icons">play_arrow</span></button>
                                    </div>`;
                                }).join('')}
                            </div>
                            <div class="auto-music-picker-footer">
                                <button type="button" class="auto-music-picker-clear">${window.I18n?.t('automation.videoeditor.music_clear') || 'Clear All'}</button>
                                <button type="button" class="auto-music-picker-select-all">${window.I18n?.t('automation.videoeditor.music_select_all') || 'Select All'}</button>
                            </div>
                        </div>
                    </div>`;
                }
                // Hide Frame Number input when Video to Image node is not in "specific" mode
                let inputWrapperStyle = '';
                if (nodeData.data.type === 'videotoimage' && input.title === 'Frame Number') {
                    const frameMode = nodeData.data.inputs[0]?.value || 'first';
                    if (frameMode !== 'specific') inputWrapperStyle = ' style="display:none"';
                }
                $(".automation-sidebar .inputs-container").append(`<div class="input mb-2" data-input-title="${input.title}"${inputWrapperStyle}>
                <strong>${input.title} ${valueDisplay}</strong>
                ${inputHTML}
            </div>`);
            });
        } else {
            clearTimeout(unselectTimeout);
            unselectTimeout = setTimeout(() => {
                $(".automation-sidebar .main-bar").show();
                $(".automation-sidebar .inputs").hide();
            }, 50);
        }

        const $inputsContainer = $(".automation-sidebar .inputs-container");

        $inputsContainer.off("input change").on("input change", "input, select", function () {
            updateInputValue($(this));
            
            // Update range value display
            if ($(this).hasClass('range-input')) {
                $(this).closest(".input").find(".range-value").text($(this).val());
            }

            // Video to Image: toggle Frame Number visibility based on Frame Selection
            if (nodeData.data.type === 'videotoimage' && $(this).data('index') === 0) {
                const $frameNumInput = $inputsContainer.find('[data-input-title="Frame Number"]');
                if ($(this).val() === 'specific') {
                    $frameNumInput.show();
                } else {
                    $frameNumInput.hide();
                }
            }
        });

        // TTS searchable locale picker handlers
        $inputsContainer.off("click.ttslocale").on("click.ttslocale", ".tts-locale-selected", function (e) {
            e.stopPropagation();
            const $dropdown = $(this).siblings(".tts-locale-dropdown");
            const isVisible = $dropdown.is(":visible");
            $(".tts-locale-dropdown").hide();
            if (!isVisible) {
                $dropdown.show();
                $dropdown.find(".tts-locale-search").val("").focus();
                $dropdown.find(".tts-locale-option").show();
            }
        });

        $inputsContainer.off("input.ttslocale").on("input.ttslocale", ".tts-locale-search", function () {
            const query = $(this).val().toLowerCase();
            $(this).closest(".tts-locale-dropdown").find(".tts-locale-option").each(function () {
                $(this).toggle($(this).text().toLowerCase().includes(query) || $(this).data("value").toLowerCase().includes(query));
            });
        });

        $inputsContainer.off("click.ttsopt").on("click.ttsopt", ".tts-locale-option", function (e) {
            e.stopPropagation();
            const $picker = $(this).closest(".tts-locale-picker");
            const locale = $(this).data("value");
            const label = $(this).text();

            $picker.find(".tts-locale-option").removeClass("active");
            $(this).addClass("active");
            $picker.find(".tts-locale-selected").text(label);
            $picker.data("value", locale);
            $picker.closest(".tts-locale-dropdown").hide();

            // Update node data
            const idx = parseInt($picker.data("index"), 10);
            nodeData.data.inputs[idx].value = locale;
            window.editor.updateNodeDataFromId(id, nodeData.data);

            // Update voice dropdown
            const filteredVoices = ttsVoicesByLocale[locale] || [];
            const $voiceSelect = $inputsContainer.find('select[data-index="1"]');
            $voiceSelect.html(filteredVoices.map(v => `<option value="${v.value}">${v.text}</option>`).join(""));
            if (filteredVoices.length > 0) {
                $voiceSelect.val(filteredVoices[0].value);
                nodeData.data.inputs[1].value = filteredVoices[0].value;
                window.editor.updateNodeDataFromId(id, nodeData.data);
            }
        });

        $(document).off("click.ttslocale").on("click.ttslocale", function () {
            $(".tts-locale-dropdown").hide();
        });

        // TTS voice preview handler
        let ttsPreviewAudio = null;
        $inputsContainer.off("click.ttspreview").on("click.ttspreview", ".tts-voice-preview-btn", async function (e) {
            e.stopPropagation();
            const $btn = $(this);
            const $icon = $btn.find(".material-icons");

            // If already playing, stop
            if (ttsPreviewAudio) {
                ttsPreviewAudio.pause();
                ttsPreviewAudio = null;
                $btn.removeClass("playing");
                $icon.text("play_circle");
                return;
            }

            // Get the selected voice from the sibling select
            const voice = $btn.siblings("select").val();
            if (!voice) return;

            // Get custom preview text from the input below the voice row
            const previewText = $btn.closest(".input").find(".tts-preview-text").val().trim() || "Hello, this is a preview of the selected voice.";

            // Show loading state
            $btn.addClass("loading");
            $icon.text("hourglass_empty");

            try {
                const result = await window.electronAPI.previewTTSVoice(voice, previewText);
                if (!result?.success) {
                    console.warn("[TTS Preview] Failed:", result?.error);
                    $btn.removeClass("loading");
                    $icon.text("play_circle");
                    return;
                }

                $btn.removeClass("loading").addClass("playing");
                $icon.text("stop_circle");

                ttsPreviewAudio = new Audio("file:///" + result.filePath.replace(/\\/g, "/"));
                ttsPreviewAudio.volume = 1;
                ttsPreviewAudio.play();
                ttsPreviewAudio.onended = () => {
                    ttsPreviewAudio = null;
                    $btn.removeClass("playing");
                    $icon.text("play_circle");
                };
                ttsPreviewAudio.onerror = () => {
                    ttsPreviewAudio = null;
                    $btn.removeClass("playing");
                    $icon.text("play_circle");
                };
            } catch (err) {
                console.error("[TTS Preview] Error:", err);
                $btn.removeClass("loading");
                $icon.text("play_circle");
            }
        });

        // Handle textarea expander click
        $inputsContainer.off("click", ".textarea-expander").on("click", ".textarea-expander", function(e) {
            e.stopPropagation();
            const $expander = $(this);
            const index = $expander.data("index");
            const currentValue = decodeURIComponent($expander.data("value") || '');
            const placeholder = $expander.data("placeholder");
            const title = $expander.closest(".input").find("strong").text().trim();
            
            // Store reference for saving
            $("#textEditorModal").data("expander", $expander);
            $("#textEditorModal").data("index", index);
            $("#textEditorModal").data("nodeId", id);
            
            // Populate modal
            $("#textEditorTitle").text(title || "Edit Text");
            $("#textEditorContent").attr("placeholder", placeholder || "Enter your text here...");
            $("#textEditorContent").val(currentValue);
            
            // Show modal
            $("#textEditorModal").fadeIn(200);
            $("#textEditorContent").focus();
        });

        // Music picker event handlers
        let musicPreviewAudio = null;
        let musicPreviewBtn = null;

        $inputsContainer.off("click", ".auto-music-picker-selected").on("click", ".auto-music-picker-selected", function(e) {
            e.stopPropagation();
            const $dropdown = $(this).siblings(".auto-music-picker-dropdown");
            const isVisible = $dropdown.is(":visible");
            $(".auto-music-picker-dropdown").hide();
            if (!isVisible) {
                $dropdown.show();
                $dropdown.find(".auto-music-picker-search").val("").focus();
                $dropdown.find(".auto-music-picker-option").show();
            }
        });

        $inputsContainer.off("input", ".auto-music-picker-search").on("input", ".auto-music-picker-search", function() {
            const query = $(this).val().toLowerCase();
            $(this).closest(".auto-music-picker-dropdown").find(".auto-music-picker-option").each(function() {
                const title = ($(this).data("title") || $(this).text()).toLowerCase();
                $(this).toggle(title.includes(query));
            });
        });

        // Helper: update the picker's stored value and header label
        function updateMusicPickerValue($picker) {
            const index = parseInt($picker.data("index"), 10);
            const checked = [];
            $picker.find(".auto-music-picker-option.checked").each(function() {
                checked.push($(this).data("value"));
            });
            const valueStr = JSON.stringify(checked);
            const noneLabel = window.I18n?.t('automation.videoeditor.music_none') || "No Music";
            const $label = $picker.find(".auto-music-picker-label");
            const $icon = $picker.find(".auto-music-picker-selected > .material-icons:first");
            if (checked.length === 0) {
                $label.text(noneLabel);
                $icon.text("music_off");
            } else if (checked.length === 1) {
                const val = checked[0];
                const serverItem = (musicLibraryItems || []).find(x => x.filename === val);
                if (serverItem) {
                    $label.text(serverItem.title || val);
                } else {
                    // Local file path — show just the filename
                    $label.text(val.split(/[/\\]/).pop());
                }
                $icon.text("library_music");
            } else {
                $label.text(checked.length + ' ' + (window.I18n?.t('automation.videoeditor.music_tracks') || 'tracks selected'));
                $icon.text("library_music");
            }
            if (nodeData?.data?.inputs?.[index]) {
                nodeData.data.inputs[index].value = valueStr;
                window.editor.updateNodeDataFromId(id, nodeData.data);
            }
        }

        // Toggle checkbox on option click (but not on play button)
        $inputsContainer.off("click", ".auto-music-picker-option").on("click", ".auto-music-picker-option", function(e) {
            if ($(e.target).closest(".auto-music-play-btn").length) return;
            e.stopPropagation();
            const $opt = $(this);
            const $check = $opt.find(".auto-music-picker-check");
            $opt.toggleClass("checked");
            $check.text($opt.hasClass("checked") ? "check_box" : "check_box_outline_blank");
            updateMusicPickerValue($opt.closest(".auto-music-picker"));
        });

        // Play button: stream from server, download in background
        $inputsContainer.off("click", ".auto-music-play-btn").on("click", ".auto-music-play-btn", async function(e) {
            e.stopPropagation();
            const btn = $(this);
            const isLocal = btn.data("is-local") === 1 || btn.data("is-local") === "1";
            const filename = btn.data("filename");
            const localpath = btn.data("localpath");

            // If same track is playing, toggle pause
            if (musicPreviewAudio && musicPreviewBtn && musicPreviewBtn.is(btn)) {
                if (musicPreviewAudio.paused) {
                    musicPreviewAudio.play();
                    btn.find(".material-icons").text("pause");
                } else {
                    musicPreviewAudio.pause();
                    btn.find(".material-icons").text("play_arrow");
                }
                return;
            }

            // Stop any existing preview
            if (musicPreviewAudio) {
                musicPreviewAudio.pause();
                musicPreviewAudio = null;
                if (musicPreviewBtn) musicPreviewBtn.find(".material-icons").text("play_arrow");
            }

            if (isLocal && localpath) {
                // Play local file directly
                const fileUrl = "file://" + localpath.replace(/\\/g, "/");
                musicPreviewAudio = new Audio(fileUrl);
                musicPreviewBtn = btn;
                btn.find(".material-icons").text("pause");
                musicPreviewAudio.play();
                musicPreviewAudio.onended = () => {
                    btn.find(".material-icons").text("play_arrow");
                    musicPreviewAudio = null;
                    musicPreviewBtn = null;
                };
                musicPreviewAudio.onerror = () => {
                    btn.find(".material-icons").text("play_arrow");
                    musicPreviewAudio = null;
                    musicPreviewBtn = null;
                };
                return;
            }

            // Show loading spinner
            btn.find(".material-icons").text("").hide();
            btn.addClass("loading");

            // Download in background (will be cached for execution)
            const downloadResult = await window.electronAPI.downloadMusicFile({ filename });

            btn.removeClass("loading");
            btn.find(".material-icons").show();

            if (downloadResult.success) {
                // Play from local file
                const fileUrl = "file://" + downloadResult.filePath.replace(/\\/g, "/");
                musicPreviewAudio = new Audio(fileUrl);
                musicPreviewBtn = btn;
                btn.find(".material-icons").text("pause");
                musicPreviewAudio.play();
                musicPreviewAudio.onended = () => {
                    btn.find(".material-icons").text("play_arrow");
                    musicPreviewAudio = null;
                    musicPreviewBtn = null;
                };
                musicPreviewAudio.onerror = () => {
                    btn.find(".material-icons").text("play_arrow");
                    musicPreviewAudio = null;
                    musicPreviewBtn = null;
                };
            } else {
                btn.find(".material-icons").text("play_arrow");
            }
        });

        // Clear all
        $inputsContainer.off("click", ".auto-music-picker-clear").on("click", ".auto-music-picker-clear", function(e) {
            e.stopPropagation();
            const $picker = $(this).closest(".auto-music-picker");
            $picker.find(".auto-music-picker-option").removeClass("checked");
            $picker.find(".auto-music-picker-check").text("check_box_outline_blank");
            updateMusicPickerValue($picker);
        });

        // Select all
        $inputsContainer.off("click", ".auto-music-picker-select-all").on("click", ".auto-music-picker-select-all", function(e) {
            e.stopPropagation();
            const $picker = $(this).closest(".auto-music-picker");
            $picker.find(".auto-music-picker-option").addClass("checked");
            $picker.find(".auto-music-picker-check").text("check_box");
            updateMusicPickerValue($picker);
        });

        // Close music picker when clicking outside
        $(document).off("click.musicPickerClose").on("click.musicPickerClose", function() {
            $(".auto-music-picker-dropdown").hide();
        });

        function updateInputValue($el) {
            const index = parseInt($el.data("index"), 10);
            const newValue = $el.val();
            if (nodeData?.data?.inputs?.[index]) {
                nodeData.data.inputs[index].value = newValue;
                window.editor.updateNodeDataFromId(id, nodeData.data);
            }
        }

    });

    // Text Editor Modal handlers
    $('#automation-container').on("click", "#saveTextEditor", function() {
        const $modal = $("#textEditorModal");
        const $expander = $modal.data("expander");
        const index = $modal.data("index");
        const nodeId = $modal.data("nodeId");
        const newValue = $("#textEditorContent").val();
        
        // Update the expander display
        const previewText = newValue.substring(0, 50) + (newValue.length > 50 ? '...' : '');
        $expander.data("value", encodeURIComponent(newValue));
        $expander.find(".textarea-preview").html(previewText || '<span class="placeholder-text">Click to edit...</span>');
        
        // Update the node data
        const nodeData = window.editor.getNodeFromId(nodeId);
        if (nodeData?.data?.inputs?.[index]) {
            nodeData.data.inputs[index].value = newValue;
            window.editor.updateNodeDataFromId(nodeId, nodeData.data);
        }
        
        // Close modal
        $modal.fadeOut(200);
    });

    $('#automation-container').on("click", "#cancelTextEditor, #closeTextEditor", function() {
        $("#textEditorModal").fadeOut(200);
    });

    $('#automation-container').on("click", "#textEditorModal", function(e) {
        if (e.target === this) {
            $(this).fadeOut(200);
        }
    });

    window.editor.on('connectionCreated', function (connection) {
        const { output_id, input_id, output_class, input_class } = connection;

        const outputNode = window.editor.getNodeFromId(output_id);
        const inputNode = window.editor.getNodeFromId(input_id);

        if (!outputNode || !inputNode) return;

        const outputIndex = parseInt(output_class.replace("output_", ""), 10) - 1;
        const inputIndex = parseInt(input_class.replace("input_", ""), 10) - 1;

        const outputType = outputNode.data.outputTypes?.[outputIndex];
        const inputType = inputNode.data.inputTypes?.[inputIndex];

        // Check type compatibility
        const isCompatible = !outputType || !inputType || 
            outputType.toLowerCase() === inputType.toLowerCase() ||
            outputType === 'all' || inputType === 'all';

        if (!isCompatible) {
            setTimeout(() => {
                window.editor.removeSingleConnection(output_id, input_id, output_class, input_class);
            }, 100);
            showAlert("error", `Connection type mismatch: cannot connect "${outputType || 'undefined'}" to "${inputType || 'undefined'}"`)
        }
    });

    // Node descriptions for info tooltips
    const nodeDescriptions = {
        input: `<b>Input Node</b><br>Starting point for your automation. Receives the initial image and text from spy posts or manual input.<br><br><b>Outputs:</b><br>• Image - The source image (file path or URL)<br>• Text - The source text/caption (plain text string)<br><br><b>Output Format:</b><br>Image output is a local file path or URL string. Text output is a plain text string. Both can be connected to any downstream node.`,
        
        openai: `<b>OpenAI (API)</b><br>Uses OpenAI GPT models to process text. Can analyze images if an image URL is provided.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional image URL for vision analysis<br>• Text (Input 2) - Text content to process<br><br><b>Config:</b><br>• Prompt - Your instructions. Use <code>{INPUT_1}</code> to insert the image URL, <code>{INPUT_2}</code> to insert the text<br>• Temperature - 0.0 (deterministic) to 2.0 (creative), default 0.7<br>• Model - GPT model to use (e.g. gpt-4o, gpt-4o-mini)<br><br><b>Output:</b><br>• Text - The AI-generated response as a plain text string`,
        
        openrouter: `<b>OpenRouter (API)</b><br>Access multiple AI models through OpenRouter API including OpenAI, Anthropic, Google, and open-source models.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional image URL for vision models<br>• Text (Input 2) - Text content to process<br><br><b>Config:</b><br>• Prompt - Your instructions. Use <code>{INPUT_1}</code> for image URL, <code>{INPUT_2}</code> for text<br>• Model - Choose from 50+ models across multiple providers<br><br><b>Output:</b><br>• Text - The AI-generated response as a plain text string`,
        
        googleai: `<b>Google AI (API)</b><br>Uses Google's Gemini models for text generation and analysis.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional image URL for vision<br>• Text (Input 2) - Text content to process<br><br><b>Config:</b><br>• Prompt - Your instructions. Use <code>{INPUT_1}</code> for image URL, <code>{INPUT_2}</code> for text<br>• Model - Gemini model variant<br><br><b>Output:</b><br>• Text - The AI-generated response as a plain text string`,
        
        anthropic: `<b>Anthropic (API)</b><br>Uses Anthropic's Claude models for high-quality text generation.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional image URL for vision<br>• Text (Input 2) - Text content to process<br><br><b>Config:</b><br>• Prompt - Your instructions. Use <code>{INPUT_1}</code> for image URL, <code>{INPUT_2}</code> for text<br>• Model - Claude model variant (e.g. claude-3.5-sonnet)<br><br><b>Output:</b><br>• Text - The AI-generated response as a plain text string`,
        
        chineseai: `<b>Chinese AI (API)</b><br>Access Chinese AI models including DeepSeek, Qwen, Kimi, and GLM.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional image URL for vision models<br>• Text (Input 2) - Text content to process<br><br><b>Config:</b><br>• Provider - DeepSeek, Qwen, Kimi, GLM<br>• Model - Specific model variant<br>• Prompt - Use <code>{INPUT_1}</code> for image, <code>{INPUT_2}</code> for text<br><br><b>Output:</b><br>• Text - The AI-generated response as a plain text string`,

        deepseekbrowser: `<b>DeepSeek (Browser)</b><br>Sends a chat message to DeepSeek using your saved browser accounts. Supports image analysis, deep-think reasoning, and web search.<br><br><b>Requirements:</b><br>• Connect at least one DeepSeek account in Settings<br><br><b>Inputs:</b><br>• Image (Input 1) - Optional local image to analyze<br>• Text (Input 2) - Text input to use in the prompt via <code>{INPUT_2}</code><br><br><b>Config:</b><br>• Prompt - Your message. Use <code>{INPUT_1}</code> for the image and <code>{INPUT_2}</code> for text input<br>• Deep Think - Enable extended reasoning mode<br>• Web Search - Enable DeepSeek web search<br><br><b>Output:</b><br>• Text - DeepSeek's response (RESPONSE fragments only, thinking is excluded)`,
        
        vcai: `<b>ViralCloner AI (API)</b><br>Our optimized AI model for content generation. Cost-effective and fast.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional image URL for vision<br>• Text (Input 2) - Text content to process<br><br><b>Config:</b><br>• Prompt - Your instructions. Use <code>{INPUT_2}</code> to reference the text input<br>• Temperature - 0.0 (focused) to 2.0 (creative)<br><br><b>Output:</b><br>• Text - The AI-generated response as a plain text string`,
        
        chatgptchat: `<b>ChatGPT Chat (Browser)</b><br>Uses browser-based ChatGPT for text generation. Requires a logged-in ChatGPT session in your browser profile.<br><br><b>Inputs:</b><br>• Image (Input 1) - Optional image to send<br>• Text (Input 2) - Your message to ChatGPT<br><br><b>Output:</b><br>• Text - ChatGPT's response as a plain text string`,
        
        midjourney: `<b>Midjourney (Browser)</b><br>Generates 4 AI images using Midjourney via Discord. Requires an active Discord connection with Midjourney access.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Reference image URL for style/content guidance<br>• Text (Input 2) - Image prompt text<br><br><b>Output:</b><br>• Images - 4 generated images as local file paths`,
        
        chatgptimage: `<b>ChatGPT Image (Browser)</b><br>Generates images using ChatGPT's DALL-E integration via browser automation.<br><br><b>Inputs:</b><br>• Image (Input 1) - Optional reference image<br>• Text (Input 2) - Image description/prompt<br><br><b>Output:</b><br>• Image - Generated image as a local file path`,
        
        gptimage: `<b>GPT Image (API)</b><br>Generates images using OpenAI's GPT-Image/DALL-E API directly.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional reference image URL<br>• Text (Input 2) - Image prompt<br><br><b>Output:</b><br>• Image - Generated image as a local file path`,
        
        googleaiimage: `<b>Google Imagen (API)</b><br>Generates images using Google's Imagen model.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Optional reference image<br>• Text (Input 2) - Image description<br><br><b>Output:</b><br>• Image - Generated image as a local file path`,
        
        soraimage: `<b>Sora Image (Browser)</b><br>Generates images using OpenAI's Sora model via browser automation.<br><br><b>Inputs:</b><br>• Text (Input 1) - Image description prompt<br><br><b>Output:</b><br>• Image - Generated image as a local file path`,
        
        geminiimage: `<b>Gemini Image (Browser)</b><br>Generates images using Google Gemini via browser automation. Uses connected Google profiles with automatic load balancing.<br><br><b>Inputs:</b><br>• Image (Input 1) - Reference image for generating similar content<br>• Text (Input 2) - Dynamic text to include in prompt<br><br><b>Config:</b><br>• Prompt - Use <code>{INPUT_1}</code> for image, <code>{INPUT_2}</code> for text<br><br><b>Output:</b><br>• Image - Generated image as a local file path`,
        
        minicanvas: `<b>Mini Canvas</b><br>Applies text overlays to images using predefined templates from the Mini Canvas editor.<br><br><b>Inputs:</b><br>• Images (Input 1) - Source images (typically from Midjourney or other image nodes)<br>• Text 1-4 (Input 2-5) - Text strings for template placeholders<br><br><b>Config:</b><br>• Template - Select a saved Mini Canvas template<br><br><b>Output:</b><br>• Image - Processed image with text overlays as a local file path`,
        
        googlesites: `<b>Google Sites</b><br>Publishes HTML content to a new Google Sites page using browser automation.<br><br><b>Inputs:</b><br>• HTML (Input 1) - The HTML content to publish (full HTML string)<br><br><b>Config:</b><br>• Profile - Google account to use<br><br><b>Output:</b><br>• URL - The published Google Sites page URL<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:5px;font-size:11px;">e.g. https://sites.google.com/d/abc123/p/xyz</code>`,
        
        wordpress: `<b>WordPress POST</b><br>Publishes a post to your WordPress website via the REST API.<br><br><b>Inputs:</b><br>• Title (Input 1) - Post title (plain text)<br>• Text (Input 2) - Post content (HTML supported)<br>• Featured Image URL (Input 3) - Optional cover image URL<br>• Categories (Input 4) - Comma-separated category IDs (e.g. <code>1,5,12</code>). Leave empty for default/uncategorized. Find IDs in WordPress dashboard under Posts → Categories.<br><br><b>Config:</b><br>• Website - Select a configured WordPress site<br><br><b>Output:</b><br>• URL - Direct link to the published post<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:5px;font-size:11px;">e.g. https://mysite.com/my-post-title/</code><br><br><b>Recipe Workflow:</b><br>To embed a WP Recipe Maker recipe:<br>1. WP Recipe Maker → Variables (Var 1)<br>2. In Variables, use <code>[wprm-recipe id="{INPUT_1}"]</code><br>3. Variables → WordPress Text input`,
        
        wprecipemaker: `<b>WP Recipe Maker</b><br>Creates a recipe using the WP Recipe Maker WordPress plugin.<br><br><b>Inputs (Individual):</b><br>• Recipe JSON - JSON with all recipe data (see below)<br>• Recipe Name - Title (required if no JSON)<br>• Summary - Recipe description<br>• Ingredients - One per line<br>• Instructions - One step per line<br>• Prep/Cook Time - e.g., "30 min"<br>• Servings, Notes, Cuisine, Course, Equipment<br>• Image URL - Recipe photo<br><br><b>Recipe JSON Format:</b><br><code style="display:block;background:#1a1a2e;padding:8px;border-radius:4px;margin-top:5px;font-size:11px;white-space:pre;overflow-x:auto;">{
  "name": "Recipe Title",
  "summary": "Description",
  "ingredients": "2 cups flour\\n1 tsp salt",
  "instructions": "Step 1\\nStep 2",
  "prepTime": "30 min",
  "cookTime": "1 hour",
  "servings": "4",
  "notes": "Tips here",
  "cuisine": "Italian",
  "course": "Main Dish",
  "equipment": "Oven, Bowl",
  "imageUrl": "https://..."
}</code><br><br><b>AI Prompt (copy this):</b><br><code style="display:block;background:#1a1a2e;padding:8px;border-radius:4px;margin-top:5px;font-size:11px;white-space:pre-wrap;">Generate a recipe as valid JSON only. Use this exact structure:
{"name":"","summary":"","ingredients":"","instructions":"","prepTime":"","cookTime":"","servings":"","notes":"","cuisine":"","course":"","equipment":"","imageUrl":""}

Rules:
- Output ONLY the JSON object, no markdown, no explanation
- Use \\n for newlines in ingredients/instructions
- All values must be strings
- prepTime/cookTime format: "X min" or "X hour"</code><br><br><b>Output:</b><br>• Recipe ID - A numeric ID (e.g. "42")<br><br><b>How to embed recipe:</b><br>1. Connect Recipe ID output → Variables node (Var 1)<br>2. In Variables text, write your HTML with:<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;white-space:pre-wrap;">&lt;p&gt;Intro text here...&lt;/p&gt;

[wprm-recipe id="{INPUT_1}"]

&lt;p&gt;More content after recipe...&lt;/p&gt;</code><br>3. Connect Variables output → WordPress Text input`,
        
        variables: `<b>Variables</b><br>Combines multiple inputs into a single output using a text template with placeholders.<br><br><b>Dynamic Inputs:</b><br>Use the + and − buttons to add or remove inputs as needed.<br><br><b>Inputs:</b><br>• Var 1, Var 2, ... Var N - Any text or data from connected nodes<br><br><b>Config:</b><br>• Text - Template using <code>{INPUT_1}</code>, <code>{INPUT_2}</code>, <code>{INPUT_N}</code> placeholders<br><br><b>Output:</b><br>• Text - The template with all placeholders replaced by actual values (plain text string)<br><br><b>Example:</b><br>If Var 1 = "Hello" and Var 2 = "World":<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;">Template: "{INPUT_1}, {INPUT_2}!"
Output:   "Hello, World!"</code>`,
        
        jsonparser: `<b>JSON Parser</b><br>Parses JSON and optionally navigates to a path and picks specific fields.<br><br><b>Inputs:</b><br>• JSON Text (Input 1) - A JSON string to parse<br><br><b>Config:</b><br>• Field Path - Navigate to a specific part of the JSON (leave empty to use root)<br>• Pick Fields - Comma-separated field names to keep from each object (leave empty to keep all)<br><br><b>Field Path Examples:</b><br><code style="display:block;background:#1a1a2e;padding:8px;border-radius:4px;margin-top:5px;font-size:11px;white-space:pre-wrap;">(empty)            → use entire JSON as-is
data.items         → navigate to nested array
[0]                → first item if root is array
results[0].meta    → specific nested value</code><br><br><b>Pick Fields Examples:</b><br><code style="display:block;background:#1a1a2e;padding:8px;border-radius:4px;margin-top:5px;font-size:11px;white-space:pre-wrap;">id, name           → keep only id and name
id, name, slug     → keep 3 fields
title, meta.key    → supports nested paths</code><br><br><b>Example - WordPress categories:</b><br>Field Path: <i>(empty)</i> &nbsp; Pick Fields: <code>id, name</code><br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;">Input:  [{"id":1,"name":"Food","slug":"food","count":55,...}, ...]
Output: [{"id":1,"name":"Food"}, ...]</code><br><br><b>Output:</b><br>• Value - Extracted/filtered data as a JSON string.`,
        
        splitter: `<b>Splitter</b><br>Splits text by a delimiter and sends each part to a separate output connection.<br><br><b>Dynamic Outputs:</b><br>Use the + and − buttons to add or remove outputs as needed.<br><br><b>Inputs:</b><br>• Text (Input 1) - The text string to split<br><br><b>Config:</b><br>• Split Symbol - Delimiter character (e.g. <code>|</code>, <code>/</code>, <code>,</code>, <code>\\n</code>)<br><br><b>Outputs:</b><br>• Output 1, 2, ... N - Each part of the split text as a separate string<br><br><b>Example:</b><br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;">Input: "apple|banana|cherry"  Split: "|"
Output 1: "apple"
Output 2: "banana"
Output 3: "cherry"</code>`,

        humanize: `<b>Humanize</b><br>Rewrites AI-generated text to sound more natural using the AI Humanize service.<br><br><b>Inputs:</b><br>• Text (Input 1) - The text to humanize (minimum 30 words)<br><br><b>Output:</b><br>• Humanized Text - The rewritten text as a plain string`,

        firstelement: `<b>First Element</b><br>Returns a single element from a list/array input. Works like a Variables node containing <code>{INPUT_1}[0]</code>.<br><br><b>Inputs:</b><br>• List (Input 1) - A list/array (or array-like value) to pick from<br><br><b>Config:</b><br>• Index - Zero-based position of the element to return (0 = first element)<br><br><b>Output:</b><br>• Item - The element at the chosen index (empty if out of range)`,

        grouplist: `<b>Group List</b><br>Collects multiple connected inputs into a single list/array output.<br><br><b>Dynamic Inputs:</b><br>Use the + and − buttons to add or remove inputs as needed. Connect a different node to each input.<br><br><b>Inputs:</b><br>• Item 1, Item 2, ... Item N - Any value or list from connected nodes (lists are flattened)<br><br><b>Output:</b><br>• List - All connected inputs combined into a single array<br><br><b>Tip:</b><br>Feed this list into a node that accepts multiple images, such as the TikTok Ads Video reference attachment, to use several images at once`,
        
        imageupload: `<b>Image Upload</b><br>Uploads a local image with the default image provider selected in Settings &gt; Media Hosting and returns a public URL.<br><br><b>Inputs:</b><br>• Image (Input 1) - Local image file path to upload<br><br><b>Output:</b><br>• URL - Public URL of the uploaded image<br><br><b>Note:</b> ViralCloner-hosted files expire after the retention period shown in Media Hosting settings.`,
        
        videoupload: `<b>Video Upload</b><br>Uploads a local video with the default video provider selected in Settings &gt; Media Hosting and returns a public URL.<br><br><b>Inputs:</b><br>• Video (Input 1) - Local video file path to upload<br><br><b>Output:</b><br>• URL - Public URL of the uploaded video<br><br><b>Note:</b> ViralCloner-hosted files expire after the retention period shown in Media Hosting settings.`,
        
        imagedownloader: `<b>Image Downloader</b><br>Downloads an image from a URL and saves it locally.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Full URL starting with http:// or https://<br><br><b>Output:</b><br>• Image - Local file path to the downloaded image<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:5px;font-size:11px;">e.g. C:/Users/.../Downloads/img_1234567890.jpg</code>`,
        
        curl: `<b>cURL Request</b><br>Executes a raw cURL command to make HTTP requests.<br><br><b>Inputs:</b><br>• cURL Command (Input 1) - A full cURL command string or plain URL<br><br><b>Supported Flags:</b> <code>-X</code> (method), <code>-H</code> (headers), <code>-d</code> (data/body), <code>-b</code> (cookies)<br><br><b>Output:</b><br>• Response - The raw HTTP response body as a text string<br><br><b>Example Input:</b><br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;white-space:pre-wrap;">curl -X GET https://api.example.com/data \\
  -H "Authorization: Bearer token123"</code><br><br><b>Tip:</b> For a visual request builder, use the <b>Advanced Curl</b> node instead.`,
        
        advancedcurl: `<b>Advanced Curl</b><br>Full HTTP request builder with structured fields. No need to write raw cURL commands — configure everything visually.<br><br><b>Config:</b><br>• URL - API endpoint (supports <code>{INPUT_1}</code>, <code>{INPUT_2}</code> placeholders)<br>• Method - GET, POST, PUT, PATCH, DELETE, HEAD<br>• Content Type - JSON, Form URL Encoded, Plain Text, or None<br>• Headers - One per line in <code>Key: Value</code> format (supports placeholders)<br>• Body - Request body with <code>{INPUT_1}</code>, <code>{INPUT_2}</code> placeholders<br>• Auth Type - None, Bearer Token, or Basic Auth<br>• Auth Value - Token or username:password<br><br><b>Dynamic Inputs:</b><br>Use + and − to add/remove inputs. Reference them in URL, headers, or body as <code>{INPUT_1}</code>, <code>{INPUT_2}</code>, etc.<br><br><b>Output:</b><br>• Response - The HTTP response body as a text string. JSON responses are returned as a JSON string. Timeout: 10 minutes.<br><br><b>Example (POST JSON):</b><br><code style="display:block;background:#1a1a2e;padding:8px;border-radius:4px;margin-top:5px;font-size:11px;white-space:pre-wrap;">URL: https://api.example.com/posts
Method: POST
Content Type: JSON
Body:
{"title": "{INPUT_1}", "content": "{INPUT_2}"}</code>`,
        
        amazoncrawl: `<b>Amazon Crawl</b><br>Extracts product data from an Amazon product page using browser automation.<br><br><b>Inputs:</b><br>• Product URL (Input 1) - Full Amazon product link (must contain amazon.com)<br><br><b>Output:</b><br>• Product Data (JSON) - A JSON string with the product details:<br><code style="display:block;background:#1a1a2e;padding:8px;border-radius:4px;margin-top:5px;font-size:11px;white-space:pre;overflow-x:auto;">{
  "title": "Product Name",
  "price": 29.99,
  "images": ["url1", "url2"],
  "description": "...",
  "features": ["Feature 1", "Feature 2"],
  "availability": "In Stock",
  "rating": "4.5 out of 5 stars",
  "reviewCount": "1,234 ratings"
}</code><br><br><b>Tip:</b> Connect output to <b>JSON Parser</b> to extract specific fields like <code>title</code>, <code>price</code>, or <code>images[0]</code>.`,
        
        serpapi: `<b>SerpAPI Search</b><br>Searches using SerpAPI with 20+ engines (Google, Bing, YouTube, Amazon, etc.). Requires a SerpAPI key in Settings.<br><br><b>Inputs:</b><br>• Query (Input 1) - The search query text<br><br><b>Config:</b><br>• Engine - Google, Google Images/News/Videos/Shopping/Maps/Scholar/Trends, YouTube, Bing, DuckDuckGo, Yahoo, Yandex, Amazon, eBay, Walmart<br>• Location - Geographic location (e.g. "Austin, Texas")<br>• Language (hl) - Results language<br>• Country (gl) - Country for localized results<br>• Device - Desktop, Tablet, or Mobile<br>• Results Count - Number of results (1-100)<br>• Offset - Pagination offset<br>• Safe Search - Off or Active<br>• Google Search Type (tbm) - Images, Videos, News, Shopping, Patents<br>• Advanced Params - Extra SerpAPI params as JSON<br><br><b>Output:</b><br>• Results (JSON) - Full SerpAPI response with organic results, knowledge graph, ads, etc.<br><br><b>Google example:</b><br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;white-space:pre;overflow-x:auto;">{"organic_results":[{"title":"...","link":"...","snippet":"..."}],"knowledge_graph":{...}}</code><br><b>YouTube example:</b><br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;white-space:pre;overflow-x:auto;">{"video_results":[{"title":"...","link":"...","length":"10:30","views":12345}]}</code><br><br><b>Tip:</b> Use <b>JSON Parser</b> to extract fields like <code>organic_results[0].link</code> or <code>video_results[0].title</code>.<br>• Multi-key rotation: Add multiple keys in Settings → SerpAPI. The node auto-selects the key with the most remaining searches.<br>• Advanced params example: <code>{"tbs":"qdr:d"}</code> for past-24h results.`,
        
        amazonafflink: `<b>Amazon Affiliate Link</b><br>Converts an Amazon product URL into an affiliate link with your tracking tag.<br><br><b>Inputs:</b><br>• Product URL (Input 1) - Original Amazon product link<br><br><b>Config:</b><br>• Tracking ID - Your Amazon Associates affiliate tag (e.g. "mystore-20")<br><br><b>Output:</b><br>• Affiliate URL - The product URL with your tracking tag appended<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:5px;font-size:11px;">e.g. https://amazon.com/dp/B08N5...?tag=mystore-20</code>`,
        
        'pinterest-output': `<b>Pinterest Output</b><br>Final destination node for Pinterest posts. Connect your processed content here to publish to Pinterest.<br><br><b>Inputs:</b><br>• Image URL (Input 1) - Public URL of the pin image (use Image Upload node first if you have a local file)<br>• Title (Input 2) - Pin title (plain text)<br>• Description (Input 3) - Pin description (plain text)<br>• URL (Input 4) - Destination link when pin is clicked<br>• Video URL (Input 5) - Optional video URL for video pins<br><br><b>Output:</b><br>This is a terminal node — no outputs.`,
        
        'facebook-output': `<b>Facebook Output</b><br>Final destination node for Facebook posts. Connect your processed content here to publish to Facebook.<br><br><b>Inputs:</b><br>• Image (Input 1) - Image file path or URL<br>• Text (Input 2) - Post caption/text (plain text)<br>• Video (Input 3) - Optional video file path or URL<br>• URL (Input 4) - Optional link URL<br>• Title (Input 5) - Optional post title (shown in test/export, usable as image filename slug)<br><br><b>Output:</b><br>This is a terminal node — no outputs.`,
        
        videoeditor: `<b>Video Editor</b><br>Creates a video from a saved Video Editor template by replacing placeholders with actual media.<br><br><b>Dynamic Inputs:</b><br>Use the + and − buttons to add or remove inputs. Each input maps to a Placeholder in the template by number (Input 1 → Placeholder 1, etc.).<br><br><b>Inputs:</b><br>• Input 1, 2, ... N - Images (file paths), videos (file paths), or text strings for template placeholders<br><br><b>Config:</b><br>• Template - Select a saved Video Editor template<br>• Music - None, Random (picks a random track from your Musics folder), or a specific music file<br><br><b>Output:</b><br>• Video - Local file path to the exported MP4 video`,
        
        metaaiimage: `<b>Meta AI Image</b><br>Generates images using Meta AI via browser automation. Requires a connected Meta AI profile. Automatically rotates between connected profiles.<br><br><b>Inputs:</b><br>• Text (Input 1) - Dynamic text for prompt (<code>{INPUT_1}</code>)<br>• Attachment Image (Input 2) - Optional reference image to guide generation<br><br><b>Config:</b><br>• Prompt - Describe the image. Use <code>{INPUT_1}</code> to insert dynamic text<br>• Orientation - Square (1:1), Vertical (9:16), or Horizontal (16:9)<br><br><b>Output:</b><br>• Generated Images - One or more AI-generated images as local file paths`,
        tiktokadsimage: `<b>TikTok Ads Image (Browser)</b><br>Generates images using the TikTok Ads Creative Studio image generation mini-app via browser automation. Requires a connected TikTok Ads profile. Automatically rotates between connected profiles.<br><br><b>Inputs:</b><br>• Text (Input 1) - Dynamic text for prompt (<code>{INPUT_1}</code>)<br>• Attachment Image (Input 2) - Optional reference image for image-to-image generation<br><br><b>Config:</b><br>• Prompt - Describe the image. Use <code>{INPUT_1}</code> to insert dynamic text<br>• Model - The TikTok Ads image generation model<br><br><b>Output:</b><br>• Generated Images - One or more AI-generated images as local file paths`,
        
        metaaivideo: `<b>Meta AI Video</b><br>Generates short animated videos using Meta AI via browser automation. Requires a connected Meta AI profile. Automatically rotates between connected profiles.<br><br><b>Inputs:</b><br>• Text (Input 1) - Dynamic text for prompt (<code>{INPUT_1}</code>)<br>• Attachment Image (Input 2) - Optional reference image to guide generation<br><br><b>Config:</b><br>• Prompt - Describe the animation. Use <code>{INPUT_1}</code> to insert dynamic text<br><br><b>Output:</b><br>• Generated Videos - AI-generated video files as local file paths`,
        
        tiktokadsvideo: `<b>TikTok Ads Video (Browser)</b><br>Generates videos using the TikTok Ads Creative Studio video mini-app via browser automation. Requires a connected TikTok Ads profile (shared with TikTok Ads Image). Automatically rotates between connected profiles.<br><br><b>Inputs:</b><br>• Text (Input 1) - Dynamic text for prompt (<code>{INPUT_1}</code>)<br>• Attachment Image (Input 2) - Optional reference image. In <b>Reference to Video</b> mode you can connect multiple images (e.g. from an image generator) and all of them are used as references<br><br><b>Config:</b><br>• Prompt - Describe the video. Use <code>{INPUT_1}</code> to insert dynamic text<br>• Mode - <b>Reference to Video</b> incorporates the attached image(s) products, characters and scenes into the video (accepts multiple images). <b>Image to Video</b> animates a single attached image directly. <b>Text to Video</b> generates the video from the prompt only (no image needed)<br>• Duration - Length of the generated video in seconds<br><br><b>Output:</b><br>• Generated Video - The AI-generated video as a local file path`,
        
        googledocsveo: `<b>Google Docs Veo 3.1</b><br>Generates videos using Google Veo 3.1 via browser automation. Requires connected Google accounts enabled in Settings → Veo 3.1. Automatically rotates between enabled profiles.<br><br><b>Inputs:</b><br>• Text (Input 1) - Dynamic text for prompt (<code>{INPUT_1}</code>)<br>• Image (Input 2) - Optional reference image. If provided, uses image+text-to-video mode automatically<br><br><b>Config:</b><br>• Prompt - Describe the video to generate. Use <code>{INPUT_1}</code> to insert dynamic text<br>• Aspect Ratio - Landscape (16:9) or Portrait (9:16)<br><br><b>Output:</b><br>• Generated Video - AI-generated video file as a local file path`,
        
        wordpressget: `<b>WordPress GET</b><br>Fetches resources from a WordPress site using the REST API. Supports standard WordPress resources and WooCommerce.<br><br><b>Inputs:</b><br>• Search Query (Input 1) - Optional text to filter results (e.g. "chocolate cake"). Leave empty to get all.<br>• Resource ID (Input 2) - Optional numeric ID to fetch a single specific item (e.g. "42"). Leave empty to get a list.<br><br><b>Config:</b><br>• Website - Select a configured WordPress site<br>• Resource - Posts, Pages, Categories, Tags, Media, Comments, Users, Products, Orders, or Coupons<br>• Per Page - Number of results (1-100, default 10)<br>• Sort By - Order results by date, title, modified, ID, slug, relevance, or random<br><br><b>Output:</b><br>• Result (JSON) - A JSON string from the WordPress REST API.<br><br>When fetching a list (no Resource ID):<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;white-space:pre;overflow-x:auto;">[{"id":1,"title":{"rendered":"My Post"},"link":"https://...","status":"publish",...}]</code><br>When fetching by ID:<br><code style="display:block;background:#1a1a2e;padding:6px;border-radius:4px;margin-top:4px;font-size:11px;white-space:pre;overflow-x:auto;">{"id":42,"title":{"rendered":"My Post"},"content":{"rendered":"<p>...</p>"},...}</code><br><br><b>Tip:</b> Connect output to <b>JSON Parser</b>. Use paths like <code>[0].title.rendered</code> to get the first post title, or <code>[0].link</code> for the URL.`
    };

    function getHtml(inputs, outputs, text, title, nodeType = '') {
        const inputHTML = inputs.map(elm => `<span>${elm}</span>`).join('');
        const outputHTML = outputs.map(elm => `<span>${elm}</span>`).join('');
        const description = nodeDescriptions[nodeType] || '';
        const infoIcon = description ? `<i class="material-icons node-info-icon" data-node-type="${nodeType}">info</i>` : '';
        
        // Input/Output nodes don't have editable text
        const isIONode = ['input', 'pinterest-output', 'facebook-output', 'subinput', 'suboutput'].includes(nodeType);
        
        // Add dynamic input buttons for Variables, Video Editor, and Advanced Curl nodes
        const dynamicInputButtons = (nodeType === 'variables' || nodeType === 'videoeditor' || nodeType === 'advancedcurl' || nodeType === 'grouplist') ? `
            <div class="dynamic-input-controls">
                <button type="button" class="btn-add-var-input" title="${window.I18n?.t('automation.variables.add_input') || 'Add input'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-var-input" title="${window.I18n?.t('automation.variables.remove_input') || 'Remove input'}">
                    <i class="material-icons">remove</i>
                </button>
            </div>` : '';
        
        // Add dynamic output buttons for Splitter node
        const dynamicOutputButtons = nodeType === 'splitter' ? `
            <div class="dynamic-output-controls">
                <button type="button" class="btn-add-splitter-output" title="${window.I18n?.t('automation.splitter.add_output') || 'Add output'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-splitter-output" title="${window.I18n?.t('automation.splitter.remove_output') || 'Remove output'}">
                    <i class="material-icons">remove</i>
                </button>
            </div>` : '';
        
        // Add dynamic output buttons for subinput node (inside sub-editor)
        const subInputDynamicOutputs = nodeType === 'subinput' ? `
            <div class="dynamic-output-controls">
                <button type="button" class="btn-add-subinput-output" title="${window.I18n?.t('automation.subautomation.add_output') || 'Add output'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-subinput-output" title="${window.I18n?.t('automation.subautomation.remove_output') || 'Remove output'}">
                    <i class="material-icons">remove</i>
                </button>
            </div>` : '';
        
        // Add dynamic input buttons for suboutput node (inside sub-editor)
        const subOutputDynamicInputs = nodeType === 'suboutput' ? `
            <div class="dynamic-input-controls">
                <button type="button" class="btn-add-suboutput-input" title="${window.I18n?.t('automation.subautomation.add_input') || 'Add input'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-suboutput-input" title="${window.I18n?.t('automation.subautomation.remove_input') || 'Remove input'}">
                    <i class="material-icons">remove</i>
                </button>
            </div>` : '';
        
        // SubAutomation node gets an edit button instead of editable text
        const subAutomationEditBtn = nodeType === 'subautomation' ? `
                <button type="button" class="btn-edit-subautomation" title="${window.I18n?.t('automation.subautomation.edit') || 'Edit Sub-Automation'}">
                    <i class="material-icons">account_tree</i>
                    <span>${window.I18n?.t('automation.subautomation.edit') || 'Edit'}</span>
                </button>` : '';
        
        const editableText = isIONode ? '' : (nodeType === 'subautomation' ? subAutomationEditBtn : `
                <strong class="editable-text" tabindex="0" 
                    ondblclick="this.setAttribute('contenteditable', 'true'); this.focus();" 
                    onblur="this.removeAttribute('contenteditable');">
                    ${text}
                </strong>`);
        
        return `<div class="node-content">
            <div class="left">${inputHTML}${dynamicInputButtons}${subOutputDynamicInputs}</div>
            <div class="center">
                <div class="node-title-row">
                    <span>${title}</span>
                    ${infoIcon}
                </div>${editableText}
            </div>
            <div class="right">${outputHTML}${dynamicOutputButtons}${subInputDynamicOutputs}</div>
        </div>`;
    }

    window.editor.removeNodeId = function (id) {
        const node = this.getNodeFromId(id.slice(5));
        if (node.class === 'unhideable' && node.data?.type === 'input') return;
        this.removeConnectionNodeId(id);
        let moduleName = this.getModuleFromNodeId(id.slice(5));
        if (this.module === moduleName) {
            this.container.querySelector(`#${id}`).remove();
        }
        delete this.drawflow.drawflow[moduleName].data[id.slice(5)];
        this.dispatch('nodeRemoved', id.slice(5));
    };

    // ========== Custom Node Context Menu (Duplicate / Delete) ==========
    // Intercept contextmenu on the editor container BEFORE Drawflow's bound handler
    // (Drawflow binds via .bind() at start(), so overriding the method won't work)
    window.editor.container.addEventListener('contextmenu', function (e) {
        const nodeEl = e.target.closest('.drawflow-node');
        if (!nodeEl) return; // Let Drawflow handle connections/empty canvas

        // Stop Drawflow's contextmenu from firing (it shows the "x" delete button)
        e.stopImmediatePropagation();
        e.preventDefault();

        const ed = window.editor;
        if (ed.editor_mode === "fixed" || ed.editor_mode === "view") return;

        // Remove any existing drawflow-delete or custom context menu
        ed.precanvas.querySelectorAll('.drawflow-delete').forEach(el => el.remove());
        document.querySelectorAll('.drawflow-context-menu').forEach(el => el.remove());

        // Select the node if not already selected
        if (ed.node_selected !== nodeEl) {
            if (ed.node_selected) ed.node_selected.classList.remove("selected");
            nodeEl.classList.add("selected");
            ed.node_selected = nodeEl;
            ed.dispatch("nodeSelected", nodeEl.id.slice(5));
        }

        const nodeId = nodeEl.id.slice(5);
        const nodeData = ed.getNodeFromId(nodeId);
        const isProtected = nodeData.class === 'unhideable' && nodeData.data?.type === 'input';

        // Build context menu
        const menu = document.createElement('div');
        menu.classList.add('drawflow-context-menu');
        menu.innerHTML = `
            <div class="drawflow-context-menu-item" data-action="duplicate">
                <i class="material-icons">content_copy</i>
                <span>${window.I18n?.t('automation.duplicate_node') || 'Duplicate'}</span>
            </div>
            <div class="drawflow-context-menu-item danger ${isProtected ? 'disabled' : ''}" data-action="delete">
                <i class="material-icons">delete</i>
                <span>${window.I18n?.t('automation.delete_node') || 'Delete'}</span>
            </div>
        `;

        // Position menu at cursor in canvas coordinates
        const precanvasRect = ed.precanvas.getBoundingClientRect();
        const zoom = ed.zoom;
        menu.style.top = (e.clientY - precanvasRect.y) / zoom + "px";
        menu.style.left = (e.clientX - precanvasRect.x) / zoom + "px";
        ed.precanvas.appendChild(menu);

        // Handle menu item clicks
        menu.addEventListener('click', (ev) => {
            const item = ev.target.closest('.drawflow-context-menu-item');
            if (!item || item.classList.contains('disabled')) return;
            const action = item.dataset.action;
            menu.remove();
            if (action === 'duplicate') {
                duplicateNode(nodeId);
            } else if (action === 'delete') {
                saveUndoState('Delete node');
                ed.removeNodeId(`node-${nodeId}`);
            }
        });

        // Close menu on click outside
        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu, true);
                document.removeEventListener('contextmenu', closeMenu, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu, true);
            document.addEventListener('contextmenu', closeMenu, true);
        }, 0);
    }, true); // <-- capturing phase to fire before Drawflow's bubbling listener

    // Duplicate a node by ID (copies data + config, no connections)
    function duplicateNode(nodeId) {
        const sourceNode = window.editor.getNodeFromId(nodeId);
        if (!sourceNode) return;

        const nodeType = sourceNode.data?.type || sourceNode.name;
        const nodeConfig = currentAutomationNodes.find(n => n.type === nodeType);
        if (!nodeConfig) return;

        // Check single-instance restriction
        if (nodeConfig.singleInstance) {
            showAlert("warning", window.I18n?.t("automation.single_instance_warning", { nodeName: nodeConfig.label || nodeConfig.name }) || `Only one ${nodeConfig.label || nodeType} node is allowed per automation`);
            return;
        }

        saveUndoState('Duplicate node');

        // Deep clone the data object (inputs with values, types, text)
        const clonedData = JSON.parse(JSON.stringify(sourceNode.data));

        // Count actual inputs/outputs from source (handles dynamic inputs/outputs)
        const inputCount = Object.keys(sourceNode.inputs || {}).length;
        const outputCount = Object.keys(sourceNode.outputs || {}).length;

        // Build HTML using the same getHtml helper
        const formattedInputs = (nodeConfig.inputsHtml || nodeConfig.inputTypes || []).map(ucfirst);
        const formattedOutputs = (nodeConfig.outputsHtml || nodeConfig.outputTypes || []).map(ucfirst);

        // Offset position so the duplicate doesn't overlap exactly
        const newX = sourceNode.pos_x + 50;
        const newY = sourceNode.pos_y + 50;

        const newNodeId = window.editor.addNode(
            sourceNode.name,
            inputCount,
            outputCount,
            newX,
            newY,
            generateRandomString(10),
            clonedData,
            getHtml(formattedInputs, formattedOutputs, clonedData.text || "edit text", ucfirst(sourceNode.name), nodeType)
        );

        // If the source had extra dynamic inputs/outputs beyond the default, add them to the new node
        if (inputCount > nodeConfig.inputsCount) {
            for (let i = nodeConfig.inputsCount; i < inputCount; i++) {
                window.editor.addNodeInput(newNodeId);
            }
        }
        if (outputCount > (nodeConfig.outputsCount || 1)) {
            for (let i = (nodeConfig.outputsCount || 1); i < outputCount; i++) {
                window.editor.addNodeOutput(newNodeId);
            }
        }

        // Restore editable text on the new node
        const textEl = document.querySelector(`#node-${newNodeId} .editable-text`);
        if (textEl && clonedData.text) {
            textEl.textContent = clonedData.text;
        }

        // Re-inject info icons and dynamic controls
        if (typeof injectInfoIconsIntoExistingNodes === 'function') {
            injectInfoIconsIntoExistingNodes();
        }
        if (typeof injectVariablesNodeControls === 'function') {
            injectVariablesNodeControls();
        }
    }

    let isResizing = false;
    let startWidth = 0;
    let sidebarLeft = 0;

    $('.automation-sidebar .resize-handle').on('mousedown', function (e) {
        isResizing = true;
        startX = e.clientX;
        const $sidebar = $('.automation-sidebar');
        startWidth = $sidebar.width();
        sidebarLeft = $sidebar.offset().left;
        $('body').css('cursor', 'ew-resize');
        e.preventDefault();
    });

    $(document).on('mousemove', function (e) {
        if (!isResizing) return;
        const mouseX = e.clientX;
        let dx = sidebarLeft - mouseX;
        let newWidth = startWidth + dx;
        newWidth = Math.min(Math.max(newWidth, 150), 600);
        $('.automation-sidebar').css('width', newWidth + 'px');
    });

    $(document).on('mouseup', function () {
        if (isResizing) {
            isResizing = false;
            $('body').css('cursor', '');
        }
    });

    // Helper function to escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ========== Node Info Tooltip ==========
    let activeTooltip = null;
    
    function showNodeInfoTooltip(icon, nodeType) {
        // Remove existing tooltip if any
        hideNodeInfoTooltip();
        
        const description = nodeDescriptions[nodeType];
        if (!description) return;
        
        // Create tooltip element
        const tooltip = document.createElement('div');
        tooltip.className = 'node-info-tooltip';
        tooltip.innerHTML = `
            <button class="node-info-tooltip-close"><i class="material-icons">close</i></button>
            ${description}
        `;
        document.body.appendChild(tooltip);
        activeTooltip = tooltip;
        
        // Position tooltip near the icon
        const iconRect = icon.getBoundingClientRect();
        const tooltipWidth = 360;
        const tooltipHeight = tooltip.offsetHeight;
        
        let left = iconRect.right + 10;
        let top = iconRect.top - 10;
        
        // Adjust if goes off screen right
        if (left + tooltipWidth > window.innerWidth - 20) {
            left = iconRect.left - tooltipWidth - 10;
        }
        
        // Adjust if goes off screen bottom
        if (top + tooltipHeight > window.innerHeight - 20) {
            top = window.innerHeight - tooltipHeight - 20;
        }
        
        // Adjust if goes off screen top
        if (top < 20) {
            top = 20;
        }
        
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
        
        // Close button handler
        tooltip.querySelector('.node-info-tooltip-close').addEventListener('click', hideNodeInfoTooltip);
    }
    
    function hideNodeInfoTooltip() {
        if (activeTooltip) {
            activeTooltip.remove();
            activeTooltip = null;
        }
    }
    
    // Event delegation for info icons (works for dynamically created nodes)
    $('#automation-container').on('click', '.node-info-icon', function(e) {
        e.stopPropagation();
        const nodeType = $(this).data('node-type');
        
        // Toggle tooltip - if clicking same icon, close it
        if (activeTooltip && activeTooltip.dataset.nodeType === nodeType) {
            hideNodeInfoTooltip();
        } else {
            if (activeTooltip) activeTooltip.dataset.nodeType = '';
            showNodeInfoTooltip(this, nodeType);
            if (activeTooltip) activeTooltip.dataset.nodeType = nodeType;
        }
    });
    
    // Close tooltip when clicking elsewhere
    $(document).on('click', function(e) {
        if (activeTooltip && !$(e.target).closest('.node-info-tooltip, .node-info-icon').length) {
            hideNodeInfoTooltip();
        }
    });
    
    // Close tooltip when zooming/panning
    if (window.editor) {
        window.editor.on('zoom', hideNodeInfoTooltip);
        window.editor.on('translate', hideNodeInfoTooltip);
    }
    
    // Inject info icons into existing/loaded nodes that don't have them
    function injectInfoIconsIntoExistingNodes() {
        const allNodes = window.editor?.drawflow?.drawflow?.Home?.data;
        if (!allNodes) return;
        
        for (const nodeId in allNodes) {
            const nodeData = allNodes[nodeId];
            const nodeType = nodeData?.data?.type || nodeData?.name;
            
            // Skip if no description available for this node type
            if (!nodeDescriptions[nodeType]) continue;
            
            // Find the node element in DOM
            const nodeEl = document.querySelector(`#node-${nodeId}`);
            if (!nodeEl) continue;
            
            // Check if info icon already exists
            if (nodeEl.querySelector('.node-info-icon')) continue;
            
            // Handle different node structures
            const nodeContent = nodeEl.querySelector('.node-content');
            if (!nodeContent) continue;
            
            // Try to find center div (regular nodes)
            const centerDiv = nodeContent.querySelector('.center');
            
            if (centerDiv) {
                // Regular node with center div
                const titleSpan = centerDiv.querySelector(':scope > span') || 
                                  centerDiv.querySelector('.node-title-row > span');
                if (!titleSpan) continue;
                
                // Check if there's already a title row wrapper
                let titleRow = centerDiv.querySelector('.node-title-row');
                
                if (!titleRow) {
                    // Wrap the title span in a title row and add info icon
                    titleRow = document.createElement('div');
                    titleRow.className = 'node-title-row';
                    titleSpan.parentNode.insertBefore(titleRow, titleSpan);
                    titleRow.appendChild(titleSpan);
                }
                
                // Add info icon if not present
                if (!titleRow.querySelector('.node-info-icon')) {
                    const infoIcon = document.createElement('i');
                    infoIcon.className = 'material-icons node-info-icon';
                    infoIcon.setAttribute('data-node-type', nodeType);
                    infoIcon.textContent = 'info';
                    titleRow.appendChild(infoIcon);
                }
            } else {
                // Special nodes (input, pinterest-output, facebook-output)
                // These have flex-center or direct structure
                const flexCenter = nodeContent.querySelector('.flex-center');
                
                if (flexCenter) {
                    // Output nodes with icon + title (Pinterest/Facebook)
                    const infoIcon = document.createElement('i');
                    infoIcon.className = 'material-icons node-info-icon ms-1';
                    infoIcon.setAttribute('data-node-type', nodeType);
                    infoIcon.textContent = 'info';
                    flexCenter.appendChild(infoIcon);
                } else {
                    // Input node - add info icon to the right side
                    const infoWrapper = document.createElement('div');
                    infoWrapper.className = 'flex-center ms-2';
                    infoWrapper.innerHTML = `<i class="material-icons node-info-icon" data-node-type="${nodeType}">info</i>`;
                    nodeContent.appendChild(infoWrapper);
                }
            }
        }
    }

    // ========== Dynamic Variable Inputs ==========
    
    // Helper function to update Variables node input labels
    function updateVariablesNodeLabels(nodeId) {
        const node = window.editor.getNodeFromId(nodeId);
        if (!node || (node.data.type !== 'variables' && node.data.type !== 'videoeditor' && node.data.type !== 'advancedcurl' && node.data.type !== 'grouplist')) return;
        
        const inputCount = Object.keys(node.inputs).length;
        const $nodeEl = $(`#node-${nodeId}`);
        const $leftDiv = $nodeEl.find('.node-content > .left');
        const isVE = node.data.type === 'videoeditor' || node.data.type === 'advancedcurl';
        const isGroup = node.data.type === 'grouplist';
        
        // Build labels HTML
        let labelsHtml = '';
        for (let i = 1; i <= inputCount; i++) {
            const lbl = isGroup ? 'Item ' + i : (isVE ? 'Input ' + i : 'Var ' + i);
            labelsHtml += `<span>${lbl}</span>`;
        }
        
        // Add the control buttons
        labelsHtml += `
            <div class="dynamic-input-controls">
                <button type="button" class="btn-add-var-input" title="${window.I18n?.t('automation.variables.add_input') || 'Add input'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-var-input" title="${window.I18n?.t('automation.variables.remove_input') || 'Remove input'}" ${inputCount <= 1 ? 'disabled' : ''}>
                    <i class="material-icons">remove</i>
                </button>
            </div>`;
        
        $leftDiv.html(labelsHtml);
        
        // Update node data inputTypes array to match
        const newInputTypes = [];
        for (let i = 0; i < inputCount; i++) {
            newInputTypes.push('all');
        }
        node.data.inputTypes = newInputTypes;
    }
    
    // Inject dynamic input controls into existing Variables nodes (for loaded automations)
    function injectVariablesNodeControls() {
        const allNodes = window.editor?.drawflow?.drawflow?.Home?.data;
        if (!allNodes) return;
        
        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            if (node.data.type === 'variables' || node.data.type === 'videoeditor' || node.data.type === 'advancedcurl' || node.data.type === 'grouplist') {
                updateVariablesNodeLabels(nodeId);
            }
        }
    }
    
    // Add Variable input button handler
    $('#automation-container').on('click', '.btn-add-var-input', function(e) {
        e.stopPropagation();
        e.preventDefault();
        
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        
        // Capture state for undo
        if (window.automationUndo) {
            window.automationUndo.capturePending();
        }
        
        // Add the input using Drawflow's built-in method
        window.editor.addNodeInput(nodeId);
        
        // Update the labels
        updateVariablesNodeLabels(nodeId);
        
        // Mark as modified
        markAutomationModified();
        
        // Commit undo state
        if (window.automationUndo) {
            window.automationUndo.commitImmediate('Add variable input');
        }
    });
    
    // Remove Variable input button handler
    $('#automation-container').on('click', '.btn-remove-var-input', function(e) {
        e.stopPropagation();
        e.preventDefault();
        
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        const node = window.editor.getNodeFromId(nodeId);
        
        const inputCount = Object.keys(node.inputs).length;
        
        // Minimum 1 input
        if (inputCount <= 1) {
            return;
        }
        
        // Capture state for undo
        if (window.automationUndo) {
            window.automationUndo.capturePending();
        }
        
        // Remove the last input
        const lastInputClass = `input_${inputCount}`;
        window.editor.removeNodeInput(nodeId, lastInputClass);
        
        // Update the labels
        updateVariablesNodeLabels(nodeId);
        
        // Mark as modified
        markAutomationModified();
        
        // Commit undo state
        if (window.automationUndo) {
            window.automationUndo.commitImmediate('Remove variable input');
        }
    });

    // ========== Dynamic Splitter Outputs ==========
    
    // Helper function to update Splitter node output labels
    function updateSplitterNodeLabels(nodeId) {
        const node = window.editor.getNodeFromId(nodeId);
        if (!node || node.data.type !== 'splitter') return;
        
        const outputCount = Object.keys(node.outputs).length;
        const $nodeEl = $(`#node-${nodeId}`);
        const $rightDiv = $nodeEl.find('.node-content > .right');
        
        // Build labels HTML
        let labelsHtml = '';
        for (let i = 1; i <= outputCount; i++) {
            labelsHtml += `<span>Output ${i}</span>`;
        }
        
        // Add the control buttons
        labelsHtml += `
            <div class="dynamic-output-controls">
                <button type="button" class="btn-add-splitter-output" title="${window.I18n?.t('automation.splitter.add_output') || 'Add output'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-splitter-output" title="${window.I18n?.t('automation.splitter.remove_output') || 'Remove output'}" ${outputCount <= 1 ? 'disabled' : ''}>
                    <i class="material-icons">remove</i>
                </button>
            </div>`;
        
        $rightDiv.html(labelsHtml);
        
        // Update node data outputTypes array to match
        const newOutputTypes = [];
        for (let i = 0; i < outputCount; i++) {
            newOutputTypes.push('text');
        }
        node.data.outputTypes = newOutputTypes;
    }
    
    // Inject dynamic output controls into existing Splitter nodes (for loaded automations)
    function injectSplitterNodeControls() {
        const allNodes = window.editor?.drawflow?.drawflow?.Home?.data;
        if (!allNodes) return;
        
        for (const nodeId in allNodes) {
            const node = allNodes[nodeId];
            if (node.data.type === 'splitter') {
                updateSplitterNodeLabels(nodeId);
            }
        }
    }
    
    // Add Splitter output button handler
    $('#automation-container').on('click', '.btn-add-splitter-output', function(e) {
        e.stopPropagation();
        e.preventDefault();
        
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        
        // Capture state for undo
        if (window.automationUndo) {
            window.automationUndo.capturePending();
        }
        
        // Add the output using Drawflow's built-in method
        window.editor.addNodeOutput(nodeId);
        
        // Update the labels
        updateSplitterNodeLabels(nodeId);
        
        // Mark as modified
        markAutomationModified();
        
        // Commit undo state
        if (window.automationUndo) {
            window.automationUndo.commitImmediate('Add splitter output');
        }
    });
    
    // Remove Splitter output button handler
    $('#automation-container').on('click', '.btn-remove-splitter-output', function(e) {
        e.stopPropagation();
        e.preventDefault();
        
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        const node = window.editor.getNodeFromId(nodeId);
        
        const outputCount = Object.keys(node.outputs).length;
        
        // Minimum 1 output
        if (outputCount <= 1) {
            return;
        }
        
        // Capture state for undo
        if (window.automationUndo) {
            window.automationUndo.capturePending();
        }
        
        // Remove the last output
        const lastOutputClass = `output_${outputCount}`;
        window.editor.removeNodeOutput(nodeId, lastOutputClass);
        
        // Update the labels
        updateSplitterNodeLabels(nodeId);
        
        // Mark as modified
        markAutomationModified();
        
        // Commit undo state
        if (window.automationUndo) {
            window.automationUndo.commitImmediate('Remove splitter output');
        }
    });

    // ========== SubAutomation Editor ==========

    // SubAutomation node configs (only used inside the sub-editor, not in main sidebar)
    const subEditorNodes = [
        {
            type: "subinput",
            name: "Sub Input",
            label: "Input",
            icon: "subautomation.svg",
            singleInstance: true,
            inputs: [],
            inputTypes: [],
            inputsHtml: [],
            outputTypes: ["all"],
            outputsHtml: ["Output 1"],
            inputsCount: 0,
            outputsCount: 1,
            dynamicOutputs: true
        },
        {
            type: "suboutput",
            name: "Sub Output",
            label: "Output",
            icon: "subautomation.svg",
            singleInstance: true,
            inputs: [],
            inputTypes: ["all"],
            inputsHtml: ["Input 1"],
            outputTypes: [],
            outputsHtml: [],
            inputsCount: 1,
            outputsCount: 0,
            dynamicInputs: true
        }
    ];

    let currentSubAutomationNodeId = null;
    let subEditorInitialized = false;

    // Build the sub-editor sidebar node list (filtered: no input/output/facebook-output/pinterest-output/subautomation)
    function buildSubEditorSidebar() {
        const $container = $("#subEditorSidebar .elements");
        $container.html("");

        const excludedTypes = ['input', 'pinterest-output', 'facebook-output', 'subautomation'];
        
        // Sub I/O group first
        let subIOHtml = `
            <div class="node-group" data-group="sub-io">
                <div class="node-group-header">
                    <div class="group-title">
                        <i class="material-icons">swap_horiz</i>
                        <span>${window.I18n?.t('automation.subautomation.io_group') || 'Input / Output'}</span>
                    </div>
                    <i class="material-icons group-toggle">expand_more</i>
                </div>
                <div class="node-group-items">`;
        
        subEditorNodes.forEach(node => {
            subIOHtml += `
                <button data-role="addSubElement" data-automation="${node.type}" class="node-item" title="${node.label}" draggable="true">
                    <img src="assets/images/icons/${node.icon}" width="18" draggable="false">
                    <span>${node.label}</span>
                </button>`;
        });
        subIOHtml += `</div></div>`;
        $container.append(subIOHtml);

        // Regular node groups (filtered)
        Object.entries(nodeGroups).forEach(([groupName, nodeTypes]) => {
            const groupNodes = currentAutomationNodes.filter(node => 
                nodeTypes.includes(node.type) && !excludedTypes.includes(node.type)
            );
            if (groupNodes.length === 0) return;

            const groupIcon = groupIcons[groupName] || 'folder';
            const groupId = 'sub-' + groupName.replace(/\s+/g, '-').toLowerCase();

            const translatedGroupName = (groupNameKeys[groupName] && window.I18n?.t(groupNameKeys[groupName])) || groupName;
            let groupHtml = `
                <div class="node-group" data-group="${groupId}">
                    <div class="node-group-header">
                        <div class="group-title">
                            <i class="material-icons">${groupIcon}</i>
                            <span>${translatedGroupName}</span>
                        </div>
                        <i class="material-icons group-toggle">expand_more</i>
                    </div>
                    <div class="node-group-items">`;

            groupNodes.forEach(node => {
                const translatedLabel = (nodeLabelKeys[node.type] && window.I18n?.t(nodeLabelKeys[node.type])) || node.label;
                groupHtml += `
                    <button data-role="addSubElement" data-automation="${node.type}" class="node-item" title="${translatedLabel}" draggable="true">
                        <img src="assets/images/icons/${node.icon}" width="18" draggable="false">
                        <span>${translatedLabel}</span>
                    </button>`;
            });

            groupHtml += `</div></div>`;
            $container.append(groupHtml);
        });

        // Collapsible group toggle
        $container.off('click', '.node-group-header').on('click', '.node-group-header', function() {
            const $group = $(this).closest('.node-group');
            $group.toggleClass('collapsed');
            $(this).find('.group-toggle').text($group.hasClass('collapsed') ? 'expand_more' : 'expand_less');
        });
    }

    // Look up a node config from either the main list or sub-editor list
    function findNodeConfig(automationType) {
        return currentAutomationNodes.find(n => n.type === automationType) 
            || subEditorNodes.find(n => n.type === automationType);
    }

    // Initialize the sub-editor Drawflow instance
    function initSubEditor() {
        if (subEditorInitialized && window.subEditor) return;

        const el = document.getElementById('subdrawflow');
        if (!el) return;

        window.subEditor = new Drawflow(el);
        window.subEditor.start();
        subEditorInitialized = true;

        // Drag-and-drop from sidebar into sub-editor
        $('#subAutomationModal').on('dragstart', '.node-item[data-role="addSubElement"]', function(e) {
            e.originalEvent.dataTransfer.setData('text/plain', $(this).data('automation'));
            e.originalEvent.dataTransfer.effectAllowed = 'copy';
            $(this).addClass('dragging');
            $('#subdrawflow').addClass('drag-target-active');
        });

        $('#subAutomationModal').on('dragend', '.node-item[data-role="addSubElement"]', function() {
            $(this).removeClass('dragging');
            $('#subdrawflow').removeClass('drag-target-active');
        });

        $('#subAutomationModal').on('dragover', '#subdrawflow', function(e) {
            e.preventDefault();
        });

        $('#subAutomationModal').on('dragenter', '#subdrawflow', function(e) {
            e.preventDefault();
            $(this).addClass('drag-over');
        });

        $('#subAutomationModal').on('dragleave', '#subdrawflow', function(e) {
            if (!$(e.relatedTarget).closest('#subdrawflow').length) {
                $(this).removeClass('drag-over');
            }
        });

        $('#subAutomationModal').on('drop', '#subdrawflow', function(e) {
            e.preventDefault();
            $(this).removeClass('drag-over');
            $('#subdrawflow').removeClass('drag-target-active');

            const automationType = e.originalEvent.dataTransfer.getData('text/plain');
            if (!automationType) return;

            const nodeConfig = findNodeConfig(automationType);
            if (!nodeConfig) return;

            // Single-instance check for subinput / suboutput
            if (nodeConfig.singleInstance) {
                const allNodes = window.subEditor.drawflow.drawflow["Home"]?.data || {};
                const existing = Object.values(allNodes).find(n => n.data?.type === automationType);
                if (existing) {
                    showAlert("warning", window.I18n?.t("automation.single_instance_warning", { nodeName: nodeConfig.label }) || `Only one ${nodeConfig.label} node is allowed`);
                    return;
                }
            }

            const precanvas = window.subEditor.precanvas;
            const precanvasRect = precanvas.getBoundingClientRect();
            const zoom = window.subEditor.zoom;
            const relX = e.originalEvent.clientX - precanvasRect.left;
            const relY = e.originalEvent.clientY - precanvasRect.top;
            const dropX = relX / zoom;
            const dropY = relY / zoom;

            const formattedInputs = (nodeConfig.inputsHtml || nodeConfig.inputTypes).map(ucfirst);
            const formattedOutputs = (nodeConfig.outputsHtml || nodeConfig.outputTypes).map(ucfirst);

            window.subEditor.addNode(
                automationType,
                nodeConfig.inputsCount,
                nodeConfig.outputsCount,
                dropX,
                dropY,
                generateRandomString(10),
                {
                    type: automationType,
                    inputs: nodeConfig.inputs,
                    inputTypes: nodeConfig.inputTypes,
                    outputTypes: nodeConfig.outputTypes,
                    text: "edit text"
                },
                getHtml(formattedInputs, formattedOutputs, "edit text", ucfirst(nodeConfig.label || automationType), automationType)
            );
        });
    }

    // Update Sub Input node output labels (dynamic outputs)
    function updateSubInputLabels(nodeId) {
        const node = window.subEditor.getNodeFromId(nodeId);
        if (!node || node.data.type !== 'subinput') return;

        const outputCount = Object.keys(node.outputs).length;
        const $nodeEl = $(`#subAutomationModal #node-${nodeId}`);
        const $rightDiv = $nodeEl.find('.node-content > .right');

        let labelsHtml = '';
        for (let i = 1; i <= outputCount; i++) {
            labelsHtml += `<span>Output ${i}</span>`;
        }
        labelsHtml += `
            <div class="dynamic-output-controls">
                <button type="button" class="btn-add-subinput-output" title="${window.I18n?.t('automation.subautomation.add_output') || 'Add output'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-subinput-output" title="${window.I18n?.t('automation.subautomation.remove_output') || 'Remove output'}" ${outputCount <= 1 ? 'disabled' : ''}>
                    <i class="material-icons">remove</i>
                </button>
            </div>`;

        $rightDiv.html(labelsHtml);

        const newOutputTypes = [];
        for (let i = 0; i < outputCount; i++) newOutputTypes.push('all');
        node.data.outputTypes = newOutputTypes;
    }

    // Update Sub Output node input labels (dynamic inputs)
    function updateSubOutputLabels(nodeId) {
        const node = window.subEditor.getNodeFromId(nodeId);
        if (!node || node.data.type !== 'suboutput') return;

        const inputCount = Object.keys(node.inputs).length;
        const $nodeEl = $(`#subAutomationModal #node-${nodeId}`);
        const $leftDiv = $nodeEl.find('.node-content > .left');

        let labelsHtml = '';
        for (let i = 1; i <= inputCount; i++) {
            labelsHtml += `<span>Input ${i}</span>`;
        }
        labelsHtml += `
            <div class="dynamic-input-controls">
                <button type="button" class="btn-add-suboutput-input" title="${window.I18n?.t('automation.subautomation.add_input') || 'Add input'}">
                    <i class="material-icons">add</i>
                </button>
                <button type="button" class="btn-remove-suboutput-input" title="${window.I18n?.t('automation.subautomation.remove_input') || 'Remove input'}" ${inputCount <= 1 ? 'disabled' : ''}>
                    <i class="material-icons">remove</i>
                </button>
            </div>`;

        $leftDiv.html(labelsHtml);

        const newInputTypes = [];
        for (let i = 0; i < inputCount; i++) newInputTypes.push('all');
        node.data.inputTypes = newInputTypes;
    }

    // Update parent SubAutomation node labels after saving the sub-editor
    function updateSubAutomationLabels(nodeId) {
        const node = window.editor.getNodeFromId(nodeId);
        if (!node || node.data.type !== 'subautomation') return;

        const inputCount = Object.keys(node.inputs).length;
        const outputCount = Object.keys(node.outputs).length;
        const $nodeEl = $(`#node-${nodeId}`);

        // Update left (inputs)
        const $leftDiv = $nodeEl.find('.node-content > .left');
        let inputLabels = '';
        for (let i = 1; i <= inputCount; i++) {
            inputLabels += `<span>Input ${i}</span>`;
        }
        $leftDiv.html(inputLabels);

        // Update right (outputs)
        const $rightDiv = $nodeEl.find('.node-content > .right');
        let outputLabels = '';
        for (let i = 1; i <= outputCount; i++) {
            outputLabels += `<span>Output ${i}</span>`;
        }
        $rightDiv.html(outputLabels);

        // Update data arrays
        node.data.inputTypes = Array(inputCount).fill('all');
        node.data.outputTypes = Array(outputCount).fill('all');
    }

    // Inject SubAutomation labels into loaded nodes
    function injectSubAutomationNodeControls() {
        const allNodes = window.editor?.drawflow?.drawflow?.Home?.data;
        if (!allNodes) return;
        for (const nodeId in allNodes) {
            if (allNodes[nodeId].data.type === 'subautomation') {
                updateSubAutomationLabels(nodeId);
            }
        }
    }

    // Open the SubAutomation editor modal
    function openSubAutomationEditor(nodeId) {
        currentSubAutomationNodeId = nodeId;
        const node = window.editor.getNodeFromId(nodeId);
        if (!node) return;

        initSubEditor();
        buildSubEditorSidebar();

        window.subEditor.clear();
        window.subEditor.zoom = 0.75;
        window.subEditor.zoom_refresh();

        const subData = node.data.subAutomationData;
        if (subData && subData.drawflow && subData.drawflow.Home && Object.keys(subData.drawflow.Home.data).length > 0) {
            window.subEditor.import(subData);
            // Re-inject dynamic controls for subinput/suboutput after import
            const allSubNodes = window.subEditor.drawflow.drawflow["Home"]?.data || {};
            for (const nId in allSubNodes) {
                if (allSubNodes[nId].data.type === 'subinput') updateSubInputLabels(nId);
                if (allSubNodes[nId].data.type === 'suboutput') updateSubOutputLabels(nId);
            }
            // Also inject variable/splitter controls inside sub-editor
            for (const nId in allSubNodes) {
                const nType = allSubNodes[nId].data.type;
                if (nType === 'variables' || nType === 'videoeditor' || nType === 'advancedcurl') {
                    updateSubEditorVariablesLabels(nId);
                }
                if (nType === 'splitter') {
                    updateSubEditorSplitterLabels(nId);
                }
            }
        }

        $('#subAutomationModal').fadeIn(200);
    }

    // Helper: update variable-type node labels inside the sub-editor
    function updateSubEditorVariablesLabels(nodeId) {
        const node = window.subEditor.getNodeFromId(nodeId);
        if (!node) return;
        const inputCount = Object.keys(node.inputs).length;
        const $nodeEl = $(`#subAutomationModal #node-${nodeId}`);
        const $leftDiv = $nodeEl.find('.node-content > .left');
        const isVE = node.data.type === 'videoeditor' || node.data.type === 'advancedcurl';
        let html = '';
        for (let i = 1; i <= inputCount; i++) {
            html += `<span>${isVE ? 'Input ' + i : 'Var ' + i}</span>`;
        }
        html += `
            <div class="dynamic-input-controls">
                <button type="button" class="btn-add-var-input" title="Add input"><i class="material-icons">add</i></button>
                <button type="button" class="btn-remove-var-input" title="Remove input" ${inputCount <= 1 ? 'disabled' : ''}><i class="material-icons">remove</i></button>
            </div>`;
        $leftDiv.html(html);
        node.data.inputTypes = Array(inputCount).fill('all');
    }

    // Helper: update splitter-type node labels inside the sub-editor
    function updateSubEditorSplitterLabels(nodeId) {
        const node = window.subEditor.getNodeFromId(nodeId);
        if (!node) return;
        const outputCount = Object.keys(node.outputs).length;
        const $nodeEl = $(`#subAutomationModal #node-${nodeId}`);
        const $rightDiv = $nodeEl.find('.node-content > .right');
        let html = '';
        for (let i = 1; i <= outputCount; i++) {
            html += `<span>Output ${i}</span>`;
        }
        html += `
            <div class="dynamic-output-controls">
                <button type="button" class="btn-add-splitter-output" title="Add output"><i class="material-icons">add</i></button>
                <button type="button" class="btn-remove-splitter-output" title="Remove output" ${outputCount <= 1 ? 'disabled' : ''}><i class="material-icons">remove</i></button>
            </div>`;
        $rightDiv.html(html);
        node.data.outputTypes = Array(outputCount).fill('text');
    }

    // Save the sub-editor with validation
    function saveSubAutomation() {
        if (!currentSubAutomationNodeId || !window.subEditor) return;

        const allSubNodes = window.subEditor.drawflow.drawflow["Home"]?.data || {};

        // Validate: suboutput must exist
        const subOutputNode = Object.values(allSubNodes).find(n => n.data?.type === 'suboutput');
        if (!subOutputNode) {
            showAlert("error", window.I18n?.t('automation.subautomation.error_no_output') || "An Output node is required. Please add one before saving.");
            return;
        }

        // Validate: suboutput must have at least one input connected
        const subOutputInputs = subOutputNode.inputs || {};
        const hasConnection = Object.values(subOutputInputs).some(inp => inp.connections && inp.connections.length > 0);
        if (!hasConnection) {
            showAlert("error", window.I18n?.t('automation.subautomation.error_output_not_connected') || "The Output node must have at least one input connected.");
            return;
        }

        const subData = window.subEditor.export();
        const parentNode = window.editor.getNodeFromId(currentSubAutomationNodeId);
        if (!parentNode) return;

        // Store the sub-automation data
        parentNode.data.subAutomationData = subData;

        // Count subinput outputs → parent inputs
        const subInputNode = Object.values(allSubNodes).find(n => n.data?.type === 'subinput');
        const targetInputCount = subInputNode ? Object.keys(subInputNode.outputs).length : 0;
        const currentInputCount = Object.keys(parentNode.inputs).length;

        // Count suboutput inputs → parent outputs
        const targetOutputCount = Object.keys(subOutputInputs).length;
        const currentOutputCount = Object.keys(parentNode.outputs).length;

        // Sync parent input count
        if (targetInputCount > currentInputCount) {
            for (let i = 0; i < targetInputCount - currentInputCount; i++) {
                window.editor.addNodeInput(currentSubAutomationNodeId);
            }
        } else if (targetInputCount < currentInputCount) {
            for (let i = currentInputCount; i > targetInputCount; i--) {
                window.editor.removeNodeInput(currentSubAutomationNodeId, `input_${i}`);
            }
        }

        // Sync parent output count
        if (targetOutputCount > currentOutputCount) {
            for (let i = 0; i < targetOutputCount - currentOutputCount; i++) {
                window.editor.addNodeOutput(currentSubAutomationNodeId);
            }
        } else if (targetOutputCount < currentOutputCount) {
            for (let i = currentOutputCount; i > targetOutputCount; i--) {
                window.editor.removeNodeOutput(currentSubAutomationNodeId, `output_${i}`);
            }
        }

        // Special case: no subinput → 0 inputs on parent
        if (targetInputCount === 0 && currentInputCount > 0) {
            for (let i = currentInputCount; i > 0; i--) {
                window.editor.removeNodeInput(currentSubAutomationNodeId, `input_${i}`);
            }
        }

        window.editor.updateNodeDataFromId(currentSubAutomationNodeId, parentNode.data);
        updateSubAutomationLabels(currentSubAutomationNodeId);

        // Refresh connections on parent
        window.editor.updateConnectionNodes("node-" + currentSubAutomationNodeId);

        markAutomationModified();

        $('#subAutomationModal').fadeOut(200);
        currentSubAutomationNodeId = null;

        showAlert("success", window.I18n?.t('automation.subautomation.saved') || "Sub-Automation saved");
    }

    // ---- SubAutomation click handlers ----

    // Open editor on double-click or edit button
    $('#automation-container').on('dblclick', '.drawflow-node', function(e) {
        const nodeId = $(this).attr('id').replace('node-', '');
        const node = window.editor.getNodeFromId(nodeId);
        if (node && node.data.type === 'subautomation') {
            e.stopPropagation();
            openSubAutomationEditor(nodeId);
        }
    });

    $('#automation-container').on('click', '.btn-edit-subautomation', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        openSubAutomationEditor(nodeId);
    });

    // Save / Cancel / Close modal
    $('#automation-container').on('click', '#saveSubAutomation', function() {
        saveSubAutomation();
    });

    $('#automation-container').on('click', '#cancelSubAutomation, #closeSubAutomation', function() {
        $('#subAutomationModal').fadeOut(200);
        currentSubAutomationNodeId = null;
    });

    // Click outside modal content to close
    $('#automation-container').on('click', '#subAutomationModal', function(e) {
        if (e.target === this) {
            $('#subAutomationModal').fadeOut(200);
            currentSubAutomationNodeId = null;
        }
    });

    // ---- Dynamic I/O for subinput/suboutput nodes inside sub-editor ----

    // Add output to subinput
    $('#automation-container').on('click', '.btn-add-subinput-output', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        window.subEditor.addNodeOutput(nodeId);
        updateSubInputLabels(nodeId);
    });

    // Remove output from subinput
    $('#automation-container').on('click', '.btn-remove-subinput-output', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        const node = window.subEditor.getNodeFromId(nodeId);
        const count = Object.keys(node.outputs).length;
        if (count <= 1) return;
        window.subEditor.removeNodeOutput(nodeId, `output_${count}`);
        updateSubInputLabels(nodeId);
    });

    // Add input to suboutput
    $('#automation-container').on('click', '.btn-add-suboutput-input', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        window.subEditor.addNodeInput(nodeId);
        updateSubOutputLabels(nodeId);
    });

    // Remove input from suboutput
    $('#automation-container').on('click', '.btn-remove-suboutput-input', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        const node = window.subEditor.getNodeFromId(nodeId);
        const count = Object.keys(node.inputs).length;
        if (count <= 1) return;
        window.subEditor.removeNodeInput(nodeId, `input_${count}`);
        updateSubOutputLabels(nodeId);
    });

    // Handle dynamic variable/splitter inputs inside the sub-editor (delegate through modal)
    $('#subAutomationModal').on('click', '.btn-add-var-input', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        window.subEditor.addNodeInput(nodeId);
        updateSubEditorVariablesLabels(nodeId);
    });

    $('#subAutomationModal').on('click', '.btn-remove-var-input', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        const node = window.subEditor.getNodeFromId(nodeId);
        const count = Object.keys(node.inputs).length;
        if (count <= 1) return;
        window.subEditor.removeNodeInput(nodeId, `input_${count}`);
        updateSubEditorVariablesLabels(nodeId);
    });

    $('#subAutomationModal').on('click', '.btn-add-splitter-output', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        window.subEditor.addNodeOutput(nodeId);
        updateSubEditorSplitterLabels(nodeId);
    });

    $('#subAutomationModal').on('click', '.btn-remove-splitter-output', function(e) {
        e.stopPropagation();
        e.preventDefault();
        const $node = $(this).closest('.drawflow-node');
        const nodeId = $node.attr('id').replace('node-', '');
        const node = window.subEditor.getNodeFromId(nodeId);
        const count = Object.keys(node.outputs).length;
        if (count <= 1) return;
        window.subEditor.removeNodeOutput(nodeId, `output_${count}`);
        updateSubEditorSplitterLabels(nodeId);
    });

    // ========== AI Automation Agent ==========
    
    // Agent state
    let agentMessages = [];
    let agentToolsSchema = null;
    let isAgentStreaming = false;
    let agentRetryCount = 0; // Retry counter for connection failures after auto_layout
    let currentStreamingMessage = '';
    let streamingDisplayOverride = null; // For qwenbrowser: display text without <tool_call> blocks
    let pendingImageBase64 = null; // For image attachments
    
    // ========== Agent Session Logging ==========
    let agentSessionLog = [];
    let agentSessionStartTime = null;
    
    function initAgentSessionLog() {
        agentSessionLog = [];
        agentSessionStartTime = new Date().toISOString();
        logAgentEvent('session_start', { time: agentSessionStartTime });
    }
    
    function logAgentEvent(eventType, data) {
        const entry = {
            timestamp: new Date().toISOString(),
            event: eventType,
            ...data
        };
        agentSessionLog.push(entry);
        console.log(`[Agent Log] ${eventType}:`, data);
    }
    
    async function saveAgentSessionLog() {
        console.log('[Agent Log] Attempting to save session, events:', agentSessionLog.length);
        if (agentSessionLog.length === 0) {
            console.log('[Agent Log] No events to save, skipping');
            return;
        }
        
        const logData = {
            sessionStart: agentSessionStartTime,
            sessionEnd: new Date().toISOString(),
            events: agentSessionLog,
            summary: {
                totalEvents: agentSessionLog.length,
                userMessages: agentSessionLog.filter(e => e.event === 'user_message').length,
                aiResponses: agentSessionLog.filter(e => e.event === 'ai_response').length,
                toolCalls: agentSessionLog.filter(e => e.event === 'tool_call').length,
                toolResults: agentSessionLog.filter(e => e.event === 'tool_result').length,
                errors: agentSessionLog.filter(e => e.event === 'error').length,
                validationIssues: agentSessionLog.filter(e => e.event === 'validation_failed').length
            }
        };
        
        try {
            const result = await window.electronAPI.saveAgentSessionLog(logData);
            if (result.success) {
                console.log('[Agent Log] Session saved to:', result.path);
                return result.path;
            }
        } catch (err) {
            console.error('[Agent Log] Failed to save session:', err);
        }
        return null;
    }
    
    // Export session log to clipboard for debugging
    async function exportAgentSessionLog() {
        const logText = agentSessionLog.map(entry => {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            let line = `[${time}] ${entry.event}`;
            
            if (entry.event === 'user_message') {
                line += `: ${entry.text || '[image]'}`;
            } else if (entry.event === 'ai_response') {
                line += `: ${entry.content?.substring(0, 200)}${entry.content?.length > 200 ? '...' : ''}`;
            } else if (entry.event === 'tool_call') {
                line += `: ${entry.toolName}(${JSON.stringify(entry.args)})`;
            } else if (entry.event === 'tool_result') {
                line += `: ${entry.success ? 'SUCCESS' : 'FAILED'} - ${JSON.stringify(entry.result).substring(0, 300)}`;
            } else if (entry.event === 'error') {
                line += `: ${entry.error}`;
            } else if (entry.event === 'validation_failed') {
                line += `: ${entry.issues?.length || 0} issues`;
            } else if (entry.event === 'canvas_state') {
                line += `: ${entry.nodes?.length || 0} nodes, ${entry.connections?.length || 0} connections`;
            }
            
            return line;
        }).join('\n');
        
        // Also create a structured version for easy debugging
        const structuredLog = JSON.stringify({
            session: agentSessionStartTime,
            events: agentSessionLog
        }, null, 2);
        
        return { text: logText, json: structuredLog };
    }
    
    // Note: Undo/Redo is now handled globally at the top of the file
    // AI Agent uses window.automationUndo.save() for its operations
    
    // Model options by provider (cost-effective models only)
    const agentModels = {
        openai: [
            { value: 'gpt-5.2', text: 'GPT-5.2 (Recommended)' },
            { value: 'gpt-4o-mini', text: 'GPT-4o Mini' },
            { value: 'gpt-4o', text: 'GPT-4o' },
            { value: 'o4-mini', text: 'o4-mini (Reasoning)' }
        ],
        anthropic: [
            { value: 'claude-sonnet-4-5', text: 'Claude Sonnet 4.5 (Recommended)' },
            { value: 'claude-haiku-4-5', text: 'Claude Haiku 4.5 (Fast)' },
            { value: 'claude-3-haiku-20240307', text: 'Claude 3 Haiku' }
        ],
        googleai: [
            { value: 'gemini-2.5-flash', text: 'Gemini 2.5 Flash (Recommended)' },
            { value: 'gemini-2.5-flash-lite', text: 'Gemini 2.5 Flash-Lite (Fastest)' },
            { value: 'gemini-3-flash', text: 'Gemini 3 Flash' },
            { value: 'gemini-1.5-flash', text: 'Gemini 1.5 Flash' }
        ],
        openrouter: [
            { value: 'openai/gpt-5.2', text: 'GPT-5.2 (Recommended)' },
            { value: 'openai/gpt-4o-mini', text: 'GPT-4o Mini' },
            { value: 'anthropic/claude-sonnet-4-5', text: 'Claude Sonnet 4.5' },
            { value: 'google/gemini-2.5-flash', text: 'Gemini 2.5 Flash' },
            { value: 'deepseek/deepseek-chat', text: 'DeepSeek Chat' },
            { value: 'meta-llama/llama-3.3-70b-instruct', text: 'Llama 3.3 70B' }
        ],
        deepseekbrowser: [
            { value: 'deepseek-v4', text: 'DeepSeek V4' }
        ]
    };

    // Tool name to friendly display name
    const toolDisplayNames = {
        'get_canvas_state': 'Analyzing canvas...',
        'get_node_details': 'Inspecting node...',
        'add_node': 'Adding node...',
        'edit_node': 'Editing node...',
        'delete_node': 'Deleting node...',
        'connect_nodes': 'Connecting nodes...',
        'disconnect_nodes': 'Disconnecting nodes...',
        'clear_canvas': 'Clearing canvas...',
        'auto_layout': 'Arranging layout...'
    };

    // Show canvas loading indicator
    function showCanvasOverlay(toolNameOrText) {
        // If it's a custom string (contains space), use directly, otherwise look up display name
        const name = toolNameOrText || 'Building...';
        const displayName = name.includes(' ') ? name : (toolDisplayNames[name] || 'Building...');
        $('#aiAgentCurrentTool').text(displayName);
        $('#aiAgentCanvasIndicator').addClass('active');
    }

    // Hide canvas loading indicator
    function hideCanvasOverlay() {
        $('#aiAgentCanvasIndicator').removeClass('active');
    }

    // Update canvas indicator tool status
    function updateCanvasOverlayTool(toolName) {
        const displayName = toolDisplayNames[toolName || ''] || 'Building...';
        $('#aiAgentCurrentTool').text(displayName);
    }

    // Initialize agent when panel opens
    async function initAgent() {
        if (!agentToolsSchema) {
            const result = await window.electronAPI.getAutomationAgentTools();
            if (result.success) {
                agentToolsSchema = result.data;
            }
        }
        await updateAgentModelOptions();
    }

    // Update model dropdown based on provider
    async function updateAgentModelOptions() {
        const provider = $('#aiAgentProvider').val();
        const $modelSelect = $('#aiAgentModel');
        const models = agentModels[provider] || [];
        
        $modelSelect.html('');
        models.forEach(m => {
            $modelSelect.append(`<option value="${m.value}">${m.text}</option>`);
        });

        // Disable image attach for providers without vision (deepseekbrowser has no vision)
        const noVisionProviders = ['deepseekbrowser'];
        const attachDisabled = noVisionProviders.includes(provider);
        $('#aiAgentAttach').prop('disabled', attachDisabled).attr('title', attachDisabled ? 'Image attachment not supported by this provider' : 'Attach image');

        // Show/hide no-profile warning
        if (provider === 'deepseekbrowser') {
            try {
                const profiles = await window.electronAPI.readKey('deepseekBrowserProfiles') || {};
                const hasConnected = Object.values(profiles).some(p => p?.status === 'connected');
                $('#aiAgentQwenWarning').toggle(!hasConnected);
                if (hasConnected) $('#aiAgentQwenWarning').hide();
                else $('#aiAgentQwenWarning').text(window.I18n?.t('automation.ai_agent.deepseek_no_profile') || 'No DeepSeek account connected. Go to Settings to connect one.').show();
                $('#aiAgentSend').prop('disabled', !hasConnected);
            } catch (_) {
                $('#aiAgentQwenWarning').hide();
            }
        } else {
            $('#aiAgentQwenWarning').hide();
            // Re-enable send if there's input
            const hasInput = $('#aiAgentInput').val().trim().length > 0;
            $('#aiAgentSend').prop('disabled', !hasInput);
        }
    }

    // Provider change handler
    $('#automation-container').on('change', '#aiAgentProvider', updateAgentModelOptions);

    // Qwen connect button — navigate to Settings Qwen Browser tab
    $('#automation-container').on('click', '#aiAgentQwenConnect', function() {
        if (window.navigateTo) window.navigateTo('settings');
        else $('#aiAgentPanel').removeClass('open');
    });

    // Toggle agent panel
    $('#automation-container').on('click', '#aiAgentFab', async function() {
        const $panel = $('#aiAgentPanel');
        const $fab = $('#aiAgentFab');
        
        // If panel is open, just close it
        if ($panel.hasClass('open')) {
            $panel.removeClass('open');
            $fab.removeClass('active');
            return;
        }
        
        $panel.addClass('open');
        $fab.addClass('active');
        initAgent();
        $('#aiAgentInput').focus();
    });

    // Close panel
    $('#automation-container').on('click', '#aiAgentClose', function() {
        $('#aiAgentPanel').removeClass('open');
        $('#aiAgentFab').removeClass('active');
    });

    // Clear chat - saves session log first
    $('#automation-container').on('click', '#aiAgentClear', async function() {
        // Save session log before clearing
        if (agentSessionLog.length > 0) {
            logAgentEvent('session_clear', { messageCount: agentMessages.length });
            await saveAgentSessionLog();
        }
        agentMessages = [];
        agentSessionLog = [];
        agentSessionStartTime = null;
        renderAgentMessages();
    });

    // Export session log to clipboard (for debugging)
    $('#automation-container').on('click', '#aiAgentExportLog', async function() {
        if (agentSessionLog.length === 0) {
            showAlert('info', 'No session log to export. Start a conversation first.');
            return;
        }
        
        const logs = await exportAgentSessionLog();
        
        try {
            await navigator.clipboard.writeText(logs.json);
            showAlert('success', 'Session log copied to clipboard! Paste it to share for debugging.');
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            // Fallback: show in console
            console.log('Session Log JSON:', logs.json);
            showAlert('info', 'Log printed to console (F12 to view)');
        }
    });

    // Open logs folder
    $('#automation-container').on('click', '#aiAgentOpenLogs', async function() {
        await window.electronAPI.openAgentLogsFolder();
    });

    // Suggestion buttons
    $('#automation-container').on('click', '.ai-agent-suggestion', function() {
        const prompt = $(this).data('prompt');
        $('#aiAgentInput').val(prompt);
        sendAgentMessage();
    });

    // Image attachment button
    $('#automation-container').on('click', '#aiAgentAttach', function() {
        $('#aiAgentImageInput').click();
    });

    // Handle image selection
    $('#automation-container').on('change', '#aiAgentImageInput', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        // Validate file type
        if (!file.type.startsWith('image/')) {
            showAlert('error', window.I18n?.t('automation.alerts.select_image_file') || 'Please select an image file');
            return;
        }
        
        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
            showAlert('error', window.I18n?.t('automation.alerts.image_too_large') || 'Image too large. Maximum size is 10MB');
            return;
        }
        
        // Read and resize image to reduce tokens
        const reader = new FileReader();
        reader.onload = async function(event) {
            try {
                // Resize image to max 800px and compress to reduce token usage
                const resizedBase64 = await resizeImageForAgent(event.target.result, 800, 0.7);
                pendingImageBase64 = resizedBase64;
                
                // Show preview
                $('#aiAgentPreviewImg').attr('src', pendingImageBase64);
                $('#aiAgentImagePreview').show();
                
                // Enable send button if there's an image
                updateSendButtonState();
            } catch (err) {
                console.error('[AI Agent] Image resize failed:', err);
                // Fallback to original
                pendingImageBase64 = event.target.result;
                $('#aiAgentPreviewImg').attr('src', pendingImageBase64);
                $('#aiAgentImagePreview').show();
                updateSendButtonState();
            }
        };
        reader.readAsDataURL(file);
        
        // Clear the input so the same file can be selected again
        $(this).val('');
    });
    
    // Resize image for AI agent to reduce token consumption
    async function resizeImageForAgent(base64Data, maxSize = 800, quality = 0.7) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = function() {
                // Calculate new dimensions maintaining aspect ratio
                let width = img.width;
                let height = img.height;
                
                if (width > maxSize || height > maxSize) {
                    if (width > height) {
                        height = Math.round(height * (maxSize / width));
                        width = maxSize;
                    } else {
                        width = Math.round(width * (maxSize / height));
                        height = maxSize;
                    }
                }
                
                // Create canvas and draw resized image
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Convert to JPEG for better compression (unless PNG with transparency)
                const isPNG = base64Data.includes('image/png');
                const outputType = isPNG ? 'image/png' : 'image/jpeg';
                const outputQuality = isPNG ? undefined : quality;
                
                const resized = canvas.toDataURL(outputType, outputQuality);
                console.log(`[AI Agent] Image resized: ${Math.round(base64Data.length/1024)}KB -> ${Math.round(resized.length/1024)}KB (${width}x${height})`);
                resolve(resized);
            };
            img.onerror = reject;
            img.src = base64Data;
        });
    }

    // Remove attached image
    $('#automation-container').on('click', '#aiAgentImageRemove', function() {
        pendingImageBase64 = null;
        $('#aiAgentImagePreview').hide();
        $('#aiAgentPreviewImg').attr('src', '');
        updateSendButtonState();
    });

    // Helper to update send button state
    function updateSendButtonState() {
        const hasText = $('#aiAgentInput').val().trim().length > 0;
        const hasImage = pendingImageBase64 !== null;
        $('#aiAgentSend').prop('disabled', (!hasText && !hasImage) || isAgentStreaming);
    }

    // Input handling
    $('#automation-container').on('input', '#aiAgentInput', function() {
        updateSendButtonState();
        
        // Auto-resize textarea
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    // Send on Enter (not Shift+Enter)
    $('#automation-container').on('keydown', '#aiAgentInput', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const hasText = $(this).val().trim();
            const hasImage = pendingImageBase64 !== null;
            if (!isAgentStreaming && (hasText || hasImage)) {
                sendAgentMessage();
            }
        }
    });

    // Send button
    $('#automation-container').on('click', '#aiAgentSend', function() {
        if (!isAgentStreaming) {
            sendAgentMessage();
        }
    });

    // Stop button
    $('#automation-container').on('click', '#aiAgentStop', async function() {
        if (isAgentStreaming) {
            console.log('[AI Agent] Stop button clicked, stopping agent...');
            try {
                const result = await window.electronAPI.stopAutomationAgent();
                console.log('[AI Agent] Stop result:', result);
                logAgentEvent('agent_stopped_by_user', {});
                
                // Directly update UI in case the stream message doesn't arrive
                // This is a fallback - normally the 'automation-agent-chunk' with stopped:true handles this
                setTimeout(() => {
                    if (isAgentStreaming) {
                        console.log('[AI Agent] Fallback: forcing UI update after stop');
                        removeTypingIndicator();
                        hideCanvasOverlay();
                        agentMessages.push({ 
                            role: 'assistant', 
                            content: '⏹️ Agent stopped.',
                            _isStopMessage: true
                        });
                        renderAgentMessages();
                        isAgentStreaming = false;
                        updateAgentButtons(false);
                        currentStreamingMessage = '';
                    }
                }, 500);
            } catch (err) {
                console.error('[AI Agent] Error stopping agent:', err);
                // Still update UI even on error
                removeTypingIndicator();
                hideCanvasOverlay();
                isAgentStreaming = false;
                updateAgentButtons(false);
            }
        }
    });

    // Toggle send/stop button visibility based on streaming state
    function updateAgentButtons(streaming) {
        if (streaming) {
            $('#aiAgentSend').hide();
            $('#aiAgentStop').show();
        } else {
            $('#aiAgentStop').hide();
            $('#aiAgentSend').show().prop('disabled', !$('#aiAgentInput').val().trim() && !pendingImageBase64);
        }
    }

    // Get current canvas state for AI context (optimized for minimal tokens)
    function getCanvasState(minimal = false) {
        const allNodes = window.editor?.drawflow?.drawflow?.["Home"]?.data || {};
        const state = {
            nodes: [],
            connections: []
        };
        
        for (const [nodeId, node] of Object.entries(allNodes)) {
            const nodeInfo = {
                id: nodeId,
                type: node.data?.type || node.name,
                label: node.data?.text || node.name,
                // Include type signatures so AI can plan connections correctly
                inputTypes: node.data?.inputTypes || [],
                outputTypes: node.data?.outputTypes || []
            };
            
            // Only include config values if not minimal mode and they exist
            if (!minimal && node.data?.inputs) {
                const configValues = {};
                node.data.inputs.forEach((input, idx) => {
                    console.log(`[AI Agent] getCanvasState node ${nodeId} input ${idx}:`, input.title, '=', input.value?.substring?.(0, 50) || input.value);
                    if (input.value !== undefined && input.value !== '' && input.value !== null) {
                        const key = input.title?.toLowerCase().replace(/\s+/g, '') || `input_${idx}`;
                        // Don't truncate prompt values - they are frequently edited and must be complete
                        // Truncate other long values to save tokens (500 char limit for non-prompts)
                        if (key === 'prompt') {
                            configValues[key] = input.value;
                        } else {
                            configValues[key] = typeof input.value === 'string' && input.value.length > 500 
                                ? input.value.substring(0, 500) + '...[truncated]' 
                                : input.value;
                        }
                    }
                });
                if (Object.keys(configValues).length > 0) {
                    nodeInfo.config = configValues;
                }
            }
            
            state.nodes.push(nodeInfo);
            
            // Compact connection format
            for (const [outputKey, output] of Object.entries(node.outputs || {})) {
                for (const conn of output.connections || []) {
                    state.connections.push(`${nodeId}:${outputKey}->${conn.node}:${conn.output}`);
                }
            }
        }
        
        return state;
    }

    // Note: saveUndoState, performUndo, performRedo, updateUndoRedoButtons 
    // are defined globally at the top of the file
    // AI Agent uses window.automationUndo.save() or calls saveUndoState() directly

    // Undo/Redo buttons for AI Agent panel (delegate to global handlers)
    $('#automation-container').on('click', '#aiAgentUndo', function() {
        if (window.automationUndo) window.automationUndo.undo();
    });
    $('#automation-container').on('click', '#aiAgentRedo', function() {
        if (window.automationUndo) window.automationUndo.redo();
    });

    // Highlight a node with animation when AI modifies it
    function highlightNode(nodeId) {
        const nodeEl = document.querySelector(`#node-${nodeId}`);
        if (nodeEl) {
            nodeEl.classList.add('ai-modified');
            // Remove class after animation completes
            setTimeout(() => {
                nodeEl.classList.remove('ai-modified');
            }, 1500);
        }
    }

    // Track validation attempts to prevent infinite loops
    let validationAttempts = 0;
    const MAX_VALIDATION_ATTEMPTS = 2; // Reduced from 3 to save tokens

    // Validate workflow and return issues
    function validateWorkflow() {
        const issues = [];
        // IMPORTANT: Use full canvas state (not minimal) so we can check config values
        const canvasState = getCanvasState(false);
        
        if (!canvasState || !canvasState.nodes || canvasState.nodes.length === 0) {
            return issues; // Empty canvas, nothing to validate
        }
        
        const nodes = canvasState.nodes;
        const connections = canvasState.connections || [];
        
        // Build maps for quick lookup
        const nodeById = {};
        nodes.forEach(n => nodeById[n.id] = n);
        
        // Find input and output nodes
        const inputNode = nodes.find(n => n.type === 'input');
        const outputNodes = nodes.filter(n => n.type === 'pinterest-output' || n.type === 'facebook-output');
        
        // Parse connection string format: "nodeId:output->nodeId:input"
        const parseConnection = (connStr) => {
            if (typeof connStr === 'string') {
                const match = connStr.match(/^(\d+):(\w+)->(\d+):(\w+)$/);
                if (match) {
                    return { from: { nodeId: match[1], output: match[2] }, to: { nodeId: match[3], input: match[4] } };
                }
            }
            return connStr; // Already in object format
        };
        
        // Issue 1: Check for direct input→output connections (THE CLONING RULE)
        if (inputNode) {
            for (const connRaw of connections) {
                const conn = parseConnection(connRaw);
                if (!conn) continue;
                if (conn.from.nodeId === inputNode.id) {
                    const targetNode = nodeById[conn.to.nodeId];
                    if (targetNode && (targetNode.type === 'pinterest-output' || targetNode.type === 'facebook-output')) {
                        issues.push({
                            type: 'direct_input_output',
                            severity: 'critical',
                            message: `CLONING RULE VIOLATION: Input node is directly connected to ${targetNode.type}. All content must be transformed through AI nodes first!`,
                            fromNode: inputNode.id,
                            toNode: conn.to.nodeId,
                            fix: `Disconnect input from ${targetNode.type} and route through an AI transformation node (openai, anthropic, etc.)`
                        });
                    }
                }
            }
        }
        
        // Issue 2: Check for unconfigured Midjourney nodes
        const midjourneyNodes = nodes.filter(n => n.type === 'midjourney');
        for (const mjNode of midjourneyNodes) {
            const promptValue = mjNode.config?.prompt || '';
            
            if (!promptValue || promptValue.trim() === '' || promptValue === 'Click to edit...') {
                issues.push({
                    type: 'empty_midjourney_prompt',
                    severity: 'critical',
                    message: `Midjourney node "${mjNode.label}" (ID: ${mjNode.id}) has no prompt configured!`,
                    nodeId: mjNode.id,
                    fix: `Configure prompt to: {INPUT_2} --sref {INPUT_1} --ar 4:5 --v 7`
                });
            } else if (!promptValue.includes('{INPUT_')) {
                issues.push({
                    type: 'static_midjourney_prompt',
                    severity: 'warning',
                    message: `Midjourney node "${mjNode.label}" (ID: ${mjNode.id}) has a static prompt without {INPUT_2}. It won't use the dynamic text from connected nodes.`,
                    nodeId: mjNode.id,
                    fix: `Update prompt to include {INPUT_2} for dynamic text, e.g.: {INPUT_2} --ar 4:5 --v 7`
                });
            }
        }
        
        // Issue 3: Check for unconfigured AI text nodes (openai, anthropic, googleai, openrouter)
        const aiTextNodes = nodes.filter(n => ['openai', 'anthropic', 'googleai', 'openrouter', 'chineseai', 'deepseekbrowser', 'qwenbrowser'].includes(n.type));
        for (const aiNode of aiTextNodes) {
            const promptValue = aiNode.config?.prompt || '';
            console.log('[AI Agent] Validating AI node:', aiNode.id, 'type:', aiNode.type, 'config:', JSON.stringify(aiNode.config), 'promptValue:', promptValue);
            
            if (!promptValue || promptValue.trim() === '' || promptValue === 'Click to edit...') {
                issues.push({
                    type: 'empty_ai_prompt',
                    severity: 'critical',
                    message: `AI node "${aiNode.label}" (ID: ${aiNode.id}) has no prompt configured!`,
                    nodeId: aiNode.id,
                    fix: `Configure the prompt with instructions for the AI, using {INPUT_1} or {INPUT_2} to reference connected inputs.`
                });
            }
        }
        
        // Issue 3b: Check for unconfigured AI IMAGE nodes (soraimage, gptimage, chatgptimage, googleaiimage)
        const aiImageNodes = nodes.filter(n => ['soraimage', 'gptimage', 'chatgptimage', 'googleaiimage', 'geminiimage'].includes(n.type));
        for (const imgNode of aiImageNodes) {
            const promptValue = imgNode.config?.prompt || '';
            
            if (!promptValue || promptValue.trim() === '' || promptValue === 'Click to edit...') {
                // Determine what input reference to suggest based on node type
                const inputRef = (imgNode.type === 'soraimage') ? '{INPUT_1}' : '{INPUT_2}';
                issues.push({
                    type: 'empty_image_prompt',
                    severity: 'critical',
                    message: `Image generator "${imgNode.label}" (ID: ${imgNode.id}) has no prompt configured!`,
                    nodeId: imgNode.id,
                    fix: `Configure the prompt to use ${inputRef} for the text input. Example: "Create an image of: ${inputRef}"`
                });
            }
        }
        
        // Issue 4: Check for unconfigured Variables nodes
        const variablesNodes = nodes.filter(n => n.type === 'variables');
        for (const varNode of variablesNodes) {
            // Variables node uses 'text' config field (title is "Text")
            const textConfig = varNode.config?.text || '';
            
            if (!textConfig || textConfig.trim() === '' || textConfig === 'Click to edit...') {
                issues.push({
                    type: 'empty_variables',
                    severity: 'critical',
                    message: `Variables node "${varNode.label}" (ID: ${varNode.id}) has no template configured!`,
                    nodeId: varNode.id,
                    fix: `Configure text to: {INPUT_1}[0] to pick the first image from Midjourney output.`
                });
            }
        }
        
        // Issue 5: Check for disconnected output nodes
        // NOTE: Facebook and Pinterest outputs are ALWAYS present on canvas.
        // If one isn't connected, it's simply ignored during execution - this is NORMAL.
        // Only flag as issue if ALL output nodes are disconnected (nothing will be posted)
        const connectedOutputs = outputNodes.filter(outNode => 
            connections.some(connRaw => {
                const conn = parseConnection(connRaw);
                return conn && conn.to.nodeId === outNode.id;
            })
        );
        
        if (outputNodes.length > 0 && connectedOutputs.length === 0) {
            // No outputs connected at all - this IS a problem
            issues.push({
                type: 'no_outputs_connected',
                severity: 'critical',
                message: `No output nodes are connected! The workflow won't post anywhere.`,
                nodeId: outputNodes[0].id,
                fix: `Connect your AI transformation nodes to at least one output (facebook-output or pinterest-output).`
            });
        }
        // If some outputs are connected and some aren't, that's fine - user only wants to post to one platform
        
        // Issue 6: Check for Splitter nodes that should be configured
        const splitterNodes = nodes.filter(n => n.type === 'splitter');
        for (const splNode of splitterNodes) {
            // Splitter node uses 'splitsymbol' config field
            const delimValue = splNode.config?.splitsymbol || '';
            
            if (!delimValue || delimValue.trim() === '' || delimValue === 'Click to edit...') {
                issues.push({
                    type: 'empty_splitter',
                    severity: 'warning',
                    message: `Splitter node "${splNode.label}" (ID: ${splNode.id}) has no split symbol configured!`,
                    nodeId: splNode.id,
                    fix: `Configure splitsymbol (e.g., | or \\n) to split the text into parts.`
                });
            }
        }
        
        // Issue 7: Check Pinterest without imageupload (needs URL, not local path)
        const pinterestNodes = nodes.filter(n => n.type === 'pinterest-output');
        for (const pinNode of pinterestNodes) {
            // Check if something is connected to input_1 (image)
            const imageConnection = connections.map(parseConnection).find(c => c && c.to.nodeId === pinNode.id && c.to.input === 'input_1');
            if (imageConnection) {
                const sourceNode = nodeById[imageConnection.from.nodeId];
                // If source is midjourney, gptimage, chatgptimage, imagedownloader - needs imageupload
                if (sourceNode && ['midjourney', 'gptimage', 'chatgptimage', 'imagedownloader', 'googleaiimage', 'soraimage', 'geminiimage'].includes(sourceNode.type)) {
                    // Check if there's a variables node in between
                    if (sourceNode.type === 'variables') {
                        // Variables is OK, but check what's connected to it
                        const varSourceConn = connections.map(parseConnection).find(c => c && c.to.nodeId === sourceNode.id);
                        if (varSourceConn) {
                            const varSource = nodeById[varSourceConn.from.nodeId];
                            if (varSource && ['midjourney', 'gptimage', 'chatgptimage', 'imagedownloader', 'googleaiimage', 'soraimage', 'geminiimage'].includes(varSource.type)) {
                                issues.push({
                                    type: 'pinterest_needs_url',
                                    severity: 'critical',
                                    message: `Pinterest requires image URLs but receives local paths from ${varSource.type}. Add imageupload between variables and Pinterest!`,
                                    nodeId: pinNode.id,
                                    sourceType: varSource.type,
                                    fix: `Add imageupload node between the image source and Pinterest to convert local path to URL.`
                                });
                            }
                        }
                    } else {
                        issues.push({
                            type: 'pinterest_needs_url',
                            severity: 'critical',
                            message: `Pinterest requires image URLs but receives local paths from ${sourceNode.type}. Add imageupload node!`,
                            nodeId: pinNode.id,
                            sourceType: sourceNode.type,
                            fix: `Add imageupload node between ${sourceNode.type} and Pinterest to convert local path to URL.`
                        });
                    }
                }
            }
        }
        
        // Issue 7b: Check for image array generators (soraimage, midjourney) connected directly to outputs
        // These output arrays and should go through a variables node to pick one image
        const arrayImageGens = ['soraimage', 'midjourney'];
        for (const outNode of outputNodes) {
            const imageConnection = connections.map(parseConnection).find(c => c && c.to.nodeId === outNode.id && c.to.input === 'input_1');
            if (imageConnection) {
                const sourceNode = nodeById[imageConnection.from.nodeId];
                if (sourceNode && arrayImageGens.includes(sourceNode.type)) {
                    issues.push({
                        type: 'array_needs_variables',
                        severity: 'critical',
                        message: `${sourceNode.type} outputs an image ARRAY but is directly connected to ${outNode.type}. Add a variables node to pick one image!`,
                        nodeId: sourceNode.id,
                        fix: `Add variables node between ${sourceNode.type} and ${outNode.type}. Connect ${sourceNode.type}→variables.input_1, set variables text="{INPUT_1}[0]", then variables→${outNode.type}.input_1`
                    });
                }
            }
        }
        
        // Issue 8: Check for orphan nodes (nodes with outputs not connected to anything)
        // Skip input node (always has unconnected appearance) and output nodes (they're endpoints)
        const skipTypes = ['input', 'pinterest-output', 'facebook-output'];
        const processingNodes = nodes.filter(n => !skipTypes.includes(n.type));
        
        for (const node of processingNodes) {
            // Check if this node has any outgoing connections
            const hasOutgoingConnection = connections.some(connRaw => {
                const conn = parseConnection(connRaw);
                return conn && conn.from.nodeId === node.id;
            });
            
            // We can't easily check outputCount without full data, so assume node should have outgoing if it exists
            if (!hasOutgoingConnection) {
                // This node has outputs but nothing is connected to them
                issues.push({
                    type: 'orphan_node',
                    severity: 'critical',
                    message: `Node "${node.label}" (ID: ${node.id}, type: ${node.type}) has outputs but they're not connected to anything!`,
                    nodeId: node.id,
                    fix: `Connect the output of node ${node.id} to another node or to an output (facebook-output/pinterest-output). If this node is not needed, delete it.`
                });
            }
        }
        
        // Issue 9: Check for type mismatches in connections
        // Get actual node data from editor to check types
        const allEditorNodes = window.editor?.drawflow?.drawflow?.["Home"]?.data || {};
        for (const connRaw of connections) {
            const conn = parseConnection(connRaw);
            if (!conn) continue;
            
            const fromEditorNode = allEditorNodes[conn.from.nodeId];
            const toEditorNode = allEditorNodes[conn.to.nodeId];
            
            if (!fromEditorNode || !toEditorNode) continue;
            
            const outputIdx = parseInt(conn.from.output?.replace('output_', '') || '1', 10) - 1;
            const inputIdx = parseInt(conn.to.input?.replace('input_', '') || '1', 10) - 1;
            
            const outputType = fromEditorNode.data?.outputTypes?.[outputIdx];
            const inputType = toEditorNode.data?.inputTypes?.[inputIdx];
            
            // Check for mismatch (skip if either is 'all' which accepts anything)
            // Also allow url→text (URLs can be used in text prompts) and text→url (text can contain URLs)
            const compatiblePairs = [
                ['url', 'text'], ['text', 'url'], 
                ['url', 'image'], ['image', 'url']  // URL is how images are passed around
            ];
            const isCompatible = compatiblePairs.some(([a, b]) => 
                outputType?.toLowerCase() === a && inputType?.toLowerCase() === b
            );
            
            if (outputType && inputType && 
                outputType !== 'all' && inputType !== 'all' &&
                outputType.toLowerCase() !== inputType.toLowerCase() &&
                !isCompatible) {
                
                const fromNode = nodeById[conn.from.nodeId];
                const toNode = nodeById[conn.to.nodeId];
                
                // Make type mismatches a warning, not critical - the runtime often handles conversions
                issues.push({
                    type: 'type_mismatch',
                    severity: 'warning',
                    message: `Type mismatch: "${fromNode?.label}" outputs "${outputType}" but "${toNode?.label}" expects "${inputType}"`,
                    fromNodeId: conn.from.nodeId,
                    toNodeId: conn.to.nodeId,
                    fix: `Consider using the correct output port. For input node: use output_2 (text) for text workflows, output_1 (image) for image workflows.`
                });
            }
        }
        
        return issues;
    }

    // Format issues into a prompt for the AI to fix
    function formatIssuesForAI(issues) {
        if (issues.length === 0) return null;
        
        let prompt = '[WARNING] **WORKFLOW VALIDATION ISSUES** - Here are issues found in the workflow:\n\n';
        
        const critical = issues.filter(i => i.severity === 'critical');
        const warnings = issues.filter(i => i.severity === 'warning');
        
        if (critical.length > 0) {
            prompt += '### CRITICAL ISSUES:\n';
            critical.forEach((issue, idx) => {
                prompt += `${idx + 1}. **${issue.type}**: ${issue.message}\n   → Suggested fix: ${issue.fix}\n\n`;
            });
        }
        
        if (warnings.length > 0) {
            prompt += '### WARNINGS:\n';
            warnings.forEach((issue, idx) => {
                prompt += `${idx + 1}. **${issue.type}**: ${issue.message}\n   → Suggested fix: ${issue.fix}\n\n`;
            });
        }
        
        prompt += '\nWould you like me to fix any of these issues? Please tell me which ones to address.';
        
        return prompt;
    }

    // Run validation and auto-fix if needed
    async function runValidationAndAutoFix() {
        const issues = validateWorkflow();
        
        if (issues.length === 0) {
            console.log('[AI Agent] Workflow validation passed ✓');
            logAgentEvent('validation_passed', { message: 'Workflow validation successful' });
            validationAttempts = 0; // Reset counter on success
            return;
        }
        
        console.log('[AI Agent] Workflow validation found issues:', issues);
        console.log('[AI Agent] Issue details:', JSON.stringify(issues.map(i => ({ type: i.type, message: i.message, nodeId: i.nodeId })), null, 2));
        logAgentEvent('validation_failed', { 
            issues: issues.map(i => ({ type: i.type, severity: i.severity, message: i.message, nodeId: i.nodeId })),
            attempt: validationAttempts + 1
        });
        
        // Check if we've hit max attempts
        if (validationAttempts >= MAX_VALIDATION_ATTEMPTS) {
            console.warn('[AI Agent] Max validation attempts reached, showing issues to user');
            logAgentEvent('validation_max_attempts', { issues: issues.length });
            
            // Save session log for debugging
            await saveAgentSessionLog();
            
            validationAttempts = 0;
            
            // Show issues to user instead of auto-fixing
            const issuesSummary = issues.map(i => `• ${i.message}`).join('\n');
            agentMessages.push({
                role: 'assistant',
                content: `[WARNING] I tried to fix the workflow but some issues remain:\n\n${issuesSummary}\n\nPlease check these manually or ask me to try again.`
            });
            renderAgentMessages();
            
            // IMPORTANT: Reset streaming state and enable send button so user can respond
            isAgentStreaming = false;
            updateAgentButtons(false);
            hideCanvasOverlay();
            return;
        }
        
        // Increment attempt counter
        validationAttempts++;
        console.log(`[AI Agent] Auto-fix attempt ${validationAttempts}/${MAX_VALIDATION_ATTEMPTS}`);
        
        // Add validation message as system-injected user message
        const fixPrompt = formatIssuesForAI(issues);
        
        // Add as a "user" message so the AI responds to it
        agentMessages.push({
            role: 'user',
            content: fixPrompt,
            _isValidation: true // Mark as validation message for UI styling
        });
        
        renderAgentMessages();
        
        // Trigger AI to fix
        isAgentStreaming = true;
        currentStreamingMessage = '';
        updateAgentButtons(true);
        addTypingIndicator();
        showCanvasOverlay('Fixing issues...');
        
        // Use minimal canvas for validation fixes - AI knows the context
        const canvasState = getCanvasState(true);
        const provider = $('#aiAgentProvider').val();
        const model = $('#aiAgentModel').val();
        const language = window.I18n?.currentLanguage || 'en';
        
        try {
            await window.electronAPI.automationAgentStream({
                messages: agentMessages,
                provider,
                model,
                canvasState,
                language
            });
        } catch (error) {
            removeTypingIndicator();
            hideCanvasOverlay();
            agentMessages.push({ role: 'assistant', content: `Error during auto-fix: ${error.message}` });
            renderAgentMessages();
            isAgentStreaming = false;
            updateAgentButtons(false);
            validationAttempts = 0;
        }
    }

    // Execute agent tool
    async function executeAgentTool(toolName, args) {
        // The agent sometimes double-stringifies arguments — parse if needed
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (e) { args = {}; }
        }
        console.log(`[AI Agent] Executing tool: ${toolName}`, args);
        
        try {
            switch (toolName) {
                case 'get_canvas_state':
                    return { success: true, result: getCanvasState() };
                    
                case 'get_node_details': {
                    const node = window.editor.getNodeFromId(args.nodeId);
                    if (!node) return { success: false, error: `Node ${args.nodeId} not found` };
                    return { success: true, result: {
                        id: args.nodeId,
                        type: node.data?.type || node.name,
                        label: node.data?.text,
                        position: { x: node.pos_x, y: node.pos_y },
                        inputs: node.data?.inputs || [],
                        inputTypes: node.data?.inputTypes || [],
                        outputTypes: node.data?.outputTypes || [],
                        connections: {
                            inputs: node.inputs,
                            outputs: node.outputs
                        }
                    }};
                }
                    
                case 'add_node': {
                    saveUndoState(`Add ${args.nodeType} node`);
                    
                    const nodeConfig = currentAutomationNodes.find(n => n.type === args.nodeType);
                    if (!nodeConfig && args.nodeType !== 'pinterest-output' && args.nodeType !== 'facebook-output') {
                        return { success: false, error: `Unknown node type: ${args.nodeType}` };
                    }
                    
                    // Calculate position
                    let posX, posY;
                    if (args.positionHint?.startsWith('after:')) {
                        const afterId = args.positionHint.split(':')[1];
                        const afterNode = window.editor.getNodeFromId(afterId);
                        if (afterNode) {
                            posX = afterNode.pos_x + 400;
                            posY = afterNode.pos_y;
                        }
                    }
                    if (!posX) {
                        const pos = calculateNextNodePosition(args.nodeType);
                        posX = pos.x;
                        posY = pos.y;
                    }
                    
                    // Build node config
                    let inputs = [], inputTypes = [], outputTypes = [], inputsCount = 0, outputsCount = 0;
                    let inputsHtml = [], outputsHtml = [];
                    
                    if (nodeConfig) {
                        inputs = JSON.parse(JSON.stringify(nodeConfig.inputs || []));
                        inputTypes = nodeConfig.inputTypes || [];
                        outputTypes = nodeConfig.outputTypes || [];
                        inputsCount = nodeConfig.inputsCount || 0;
                        outputsCount = nodeConfig.outputsCount || 0;
                        inputsHtml = nodeConfig.inputsHtml || inputTypes.map(ucfirst);
                        outputsHtml = nodeConfig.outputsHtml || outputTypes.map(ucfirst);
                    } else if (args.nodeType === 'pinterest-output') {
                        inputTypes = ['url', 'text', 'text', 'url'];
                        inputsHtml = ['Image URL', 'Title', 'Description', 'Link URL'];
                        inputsCount = 4;
                        outputsCount = 0;
                    } else if (args.nodeType === 'facebook-output') {
                        inputTypes = ['image', 'text'];
                        inputsHtml = ['Image', 'Text'];
                        inputsCount = 2;
                        outputsCount = 0;
                    }
                    
                    // Apply config values
                    if (args.configValues && inputs.length > 0) {
                        applyConfigValues(inputs, args.configValues);
                    }
                    
                    const label = args.label || ucfirst(args.nodeType.replace(/-/g, ' '));
                    const html = getHtml(inputsHtml.map(ucfirst), outputsHtml.map(ucfirst), label, ucfirst(args.nodeType.replace(/-/g, ' ')), args.nodeType);
                    
                    const newNodeId = window.editor.addNode(
                        args.nodeType,
                        inputsCount,
                        outputsCount,
                        posX,
                        posY,
                        args.nodeType === 'pinterest-output' || args.nodeType === 'facebook-output' ? 'unhideable' : generateRandomString(10),
                        {
                            type: args.nodeType,
                            inputs: inputs,
                            inputTypes: inputTypes,
                            outputTypes: outputTypes,
                            text: label
                        },
                        html
                    );
                    
                    // Highlight the new node
                    highlightNode(newNodeId);
                    
                    return { 
                        success: true, 
                        result: { 
                            nodeId: String(newNodeId), 
                            type: args.nodeType,
                            ports: {
                                inputs: inputTypes.map((t, i) => ({ id: `input_${i+1}`, type: t, label: inputsHtml[i] || `Input ${i+1}` })),
                                outputs: outputTypes.map((t, i) => ({ id: `output_${i+1}`, type: t, label: outputsHtml[i] || `Output ${i+1}` }))
                            }
                        } 
                    };
                }

                case 'get_node_info': {
                    const nodeConfig = currentAutomationNodes.find(n => n.type === args.nodeType);
                    if (!nodeConfig) return { success: false, error: `Unknown node type: ${args.nodeType}` };
                    const inTypes = nodeConfig.inputTypes || [];
                    const inHtml = nodeConfig.inputsHtml || [];
                    const outTypes = nodeConfig.outputTypes || [];
                    const outHtml = nodeConfig.outputsHtml || [];
                    return {
                        success: true,
                        result: {
                            type: nodeConfig.type,
                            label: nodeConfig.label,
                            ports: {
                                inputs: inTypes.map((t, i) => ({ id: `input_${i+1}`, type: t, label: inHtml[i] || `Input ${i+1}` })),
                                outputs: outTypes.map((t, i) => ({ id: `output_${i+1}`, type: t, label: outHtml[i] || `Output ${i+1}` }))
                            },
                            configKeys: (nodeConfig.inputs || []).map(inp => inp.title),
                            note: nodeConfig.dynamicInputs ? 'Has dynamic inputs but AI tools cannot add more — only 1 input created by default' : undefined
                        }
                    };
                }
                    
                case 'edit_node': {
                    console.log(`[AI Agent] edit_node called with args:`, JSON.stringify(args, null, 2));
                    saveUndoState(`Edit node ${args.nodeId}`);
                    
                    const node = window.editor.getNodeFromId(args.nodeId);
                    if (!node) {
                        console.log(`[AI Agent] edit_node: Node ${args.nodeId} not found`);
                        return { success: false, error: `Node ${args.nodeId} not found` };
                    }
                    
                    console.log(`[AI Agent] edit_node: Found node, current inputs:`, node.data?.inputs?.map(i => ({ title: i.title, value: i.value })));
                    
                    // Update label if provided
                    if (args.label) {
                        node.data.text = args.label;
                        const nodeEl = document.querySelector(`#node-${args.nodeId} .editable-text`);
                        if (nodeEl) nodeEl.textContent = args.label;
                    }
                    
                    // Update config values
                    if (args.configValues && node.data.inputs) {
                        console.log(`[AI Agent] edit_node: Applying configValues:`, args.configValues);
                        applyConfigValues(node.data.inputs, args.configValues);
                        window.editor.updateNodeDataFromId(args.nodeId, node.data);
                        console.log(`[AI Agent] edit_node: After apply, inputs:`, node.data?.inputs?.map(i => ({ title: i.title, value: i.value })));
                    } else {
                        console.log(`[AI Agent] edit_node: No configValues or inputs - configValues:`, args.configValues, 'inputs:', !!node.data?.inputs);
                    }
                    
                    // Highlight the edited node
                    highlightNode(args.nodeId);
                    
                    return { success: true, result: { nodeId: args.nodeId, updated: true } };
                }
                    
                case 'delete_node': {
                    const node = window.editor.getNodeFromId(args.nodeId);
                    if (!node) return { success: false, error: `Node ${args.nodeId} not found` };
                    if (node.data?.type === 'input') return { success: false, error: 'Cannot delete input node' };
                    
                    saveUndoState(`Delete ${node.data?.type || 'node'}`);
                    window.editor.removeNodeId(`node-${args.nodeId}`);
                    return { success: true, result: { deleted: args.nodeId } };
                }
                    
                case 'connect_nodes': {
                    // Drawflow uses numeric IDs internally
                    const fromIdNum = parseInt(args.fromNodeId, 10);
                    const toIdNum = parseInt(args.toNodeId, 10);
                    
                    if (isNaN(fromIdNum)) return { success: false, error: `Invalid source node ID: ${args.fromNodeId}. You must use the literal numeric nodeId from the [Tool result for add_node] message (e.g. "6"). Never use variable names or placeholders. If you called add_node and connect_nodes in the same turn, that is the problem — you must add nodes first, read their nodeIds from the results, THEN connect in the next turn.` };
                    if (isNaN(toIdNum)) return { success: false, error: `Invalid target node ID: ${args.toNodeId}. You must use the literal numeric nodeId from the [Tool result for add_node] message (e.g. "7"). Never use variable names or placeholders.` };
                    
                    const fromNode = window.editor.getNodeFromId(fromIdNum);
                    const toNode = window.editor.getNodeFromId(toIdNum);
                    
                    if (!fromNode) return { success: false, error: `Source node ${fromIdNum} not found` };
                    if (!toNode) return { success: false, error: `Target node ${toIdNum} not found` };
                    
                    // Default to output_1 and input_1 if not specified
                    const fromOutput = args.fromOutput || 'output_1';
                    const toInput = args.toInput || 'input_1';
                    
                    // Validate output/input port format
                    if (!fromOutput.startsWith('output_')) {
                        return { success: false, error: `Invalid output format: ${fromOutput}. Use output_1, output_2, etc.` };
                    }
                    if (!toInput.startsWith('input_')) {
                        return { success: false, error: `Invalid input format: ${toInput}. Use input_1, input_2, etc.` };
                    }
                    
                    // Validate types - REJECT incompatible connections with helpful message
                    const outputIdx = parseInt(fromOutput.replace('output_', ''), 10) - 1;
                    const inputIdx = parseInt(toInput.replace('input_', ''), 10) - 1;
                    const outputType = fromNode.data?.outputTypes?.[outputIdx]?.toLowerCase();
                    const inputType = toNode.data?.inputTypes?.[inputIdx]?.toLowerCase();
                    
                    if (outputType && inputType && outputType !== inputType) {
                        // Same strict rule as the manual connectionCreated handler: exact match or 'all'
                        const compatible = outputType === 'all' || inputType === 'all';
                        
                        if (!compatible) {
                            const fromLabel = fromNode.data?.label || fromNode.name || `Node ${fromIdNum}`;
                            const toLabel = toNode.data?.label || toNode.name || `Node ${toIdNum}`;
                            
                            // Build helpful error message
                            let hint = '';
                            if (outputType === 'text' && inputType === 'image') {
                                const textInputIdx = toNode.data?.inputTypes?.findIndex(t => t?.toLowerCase() === 'text');
                                if (textInputIdx >= 0) {
                                    const inputLabels = toNode.data?.inputLabels || [];
                                    hint = ` Try connecting to input_${textInputIdx + 1} (${inputLabels[textInputIdx] || 'text'}) instead!`;
                                }
                            } else if ((outputType === 'images' || outputType === 'image') && inputType === 'url') {
                                hint = ` SOLUTION: Add an "imageupload" node between them. Connect ${fromOutput} → imageupload.input_1, then imageupload.output_1 (url) → ${toInput}.`;
                            }
                            
                            return { 
                                success: false, 
                                error: `TYPE MISMATCH: "${fromLabel}" ${fromOutput} outputs "${outputType}" but "${toLabel}" ${toInput} expects "${inputType}".${hint}`
                            };
                        }
                    }
                    
                    // Check if output/input ports exist
                    const outputCount = fromNode.outputs ? Object.keys(fromNode.outputs).length : 0;
                    const inputCount = toNode.inputs ? Object.keys(toNode.inputs).length : 0;
                    
                    if (outputIdx >= outputCount) {
                        return { success: false, error: `Source node ${fromIdNum} doesn't have ${fromOutput} (only has ${outputCount} outputs)` };
                    }
                    if (inputIdx >= inputCount) {
                        return { success: false, error: `Target node ${toIdNum} doesn't have ${toInput} (only has ${inputCount} inputs)` };
                    }
                    
                    try {
                        // Drawflow addConnection expects: (output_node_id, input_node_id, output_class, input_class)
                        window.editor.addConnection(fromIdNum, toIdNum, fromOutput, toInput);
                        saveUndoState(`Connect ${fromIdNum} to ${toIdNum}`);
                        return { success: true, result: { connected: true, from: fromIdNum, to: toIdNum, fromOutput, toInput } };
                    } catch (connError) {
                        console.error('[AI Agent] Connection error:', connError);
                        return { success: false, error: `Connection failed: ${connError.message}` };
                    }
                }
                    
                case 'disconnect_nodes': {
                    const fromIdNum = parseInt(args.fromNodeId, 10);
                    const toIdNum = parseInt(args.toNodeId, 10);
                    saveUndoState(`Disconnect ${fromIdNum} from ${toIdNum}`);
                    window.editor.removeSingleConnection(fromIdNum, toIdNum, args.fromOutput, args.toInput);
                    return { success: true, result: { disconnected: true } };
                }
                    
                case 'clear_canvas': {
                    saveUndoState('Clear canvas');
                    
                    // Access raw data directly (avoids getNodeFromId module mismatch issues)
                    const rawData = window.editor.drawflow.drawflow["Home"].data;
                    const keptNodeIds = {};
                    let maxKeptId = 1;
                    
                    // Collect IDs to delete first (avoid modifying during iteration)
                    const toDelete = [];
                    for (const nodeId of Object.keys(rawData)) {
                        const nodeType = rawData[nodeId]?.data?.type;
                        const nodeClass = rawData[nodeId]?.class || '';
                        // Keep nodes that are 'unhideable' (input/facebook-output/pinterest-output)
                        // Detect by class OR by known type names as fallback
                        const isKeepable = nodeClass.includes('unhideable') || 
                            nodeType === 'input' || 
                            nodeType === 'facebook-output' || 
                            nodeType === 'pinterest-output';
                        if (isKeepable) {
                            keptNodeIds[nodeType || nodeId] = nodeId;
                            if (parseInt(nodeId) > maxKeptId) maxKeptId = parseInt(nodeId);
                        } else {
                            toDelete.push(nodeId);
                        }
                    }
                    for (const nodeId of toDelete) {
                        window.editor.removeNodeId(`node-${nodeId}`);
                    }
                    // If input node was not on canvas, add it now so the AI always has a valid input node ID
                    if (!keptNodeIds['input']) {
                        const inputHtml = `<div class="node-content" style="display: flex; justify-content: space-between; align-items: center;"><div style="display: flex; flex-direction: column; gap: 10px; margin-left: 10px;"><span>Image URL</span><span>Text</span></div><div class="flex-center ms-2"><i class="material-icons node-info-icon" data-node-type="input">info</i></div></div>`;
                        const newInputId = window.editor.addNode(
                            'input', 0, 2, -140, 200, 'unhideable',
                            { type: 'input', inputs: [], inputTypes: [], outputTypes: ['url', 'text'], text: '' },
                            inputHtml
                        );
                        keptNodeIds['input'] = String(newInputId);
                        if (newInputId > maxKeptId) maxKeptId = newInputId;
                    }
                    // Reset node ID counter so new nodes get sequential IDs after kept nodes
                    window.editor.nodeId = maxKeptId + 1;
                    const nextId = maxKeptId + 1;
                    return { success: true, result: { cleared: true, keptNodes: keptNodeIds, note: `Kept nodes: ${JSON.stringify(keptNodeIds)}. Next new node ID=${nextId}.`, nextNodeId: nextId } };
                }
                    
                case 'auto_layout': {
                    saveUndoState('Auto layout');
                    autoLayoutNodes();
                    return { success: true, result: { layoutApplied: true } };
                }
                    
                default:
                    return { success: false, error: `Unknown tool: ${toolName}` };
            }
        } catch (error) {
            console.error(`[AI Agent] Tool error:`, error);
            return { success: false, error: error.message };
        }
    }

    // Apply config values to inputs array
    function applyConfigValues(inputs, configValues) {
        for (const input of inputs) {
            const key = input.title?.toLowerCase().replace(/\s+/g, '');
            if (configValues.prompt !== undefined && key === 'prompt') {
                input.value = configValues.prompt;
            } else if (configValues.temperature !== undefined && key === 'temperature') {
                input.value = configValues.temperature;
            } else if (configValues.model !== undefined && key === 'model') {
                input.value = configValues.model;
            } else if (configValues.maxTokens !== undefined && (key === 'maxtokens' || key === 'max_tokens')) {
                input.value = configValues.maxTokens;
            } else if (configValues.template !== undefined && key === 'template') {
                input.value = configValues.template;
            } else if (configValues.website !== undefined && key === 'website') {
                input.value = configValues.website;
            } else if (configValues.provider !== undefined && (key === 'provider' || key === 'providers')) {
                input.value = configValues.provider;
            } else if ((configValues.text !== undefined || configValues.prompt !== undefined) && key === 'text') {
                // Also accept 'prompt' as alias for 'text' (e.g. variables node configValues)
                input.value = configValues.text ?? configValues.prompt;
            } else if (configValues.fieldPath !== undefined && key === 'fieldpath') {
                input.value = configValues.fieldPath;
            } else if (configValues.splitSymbol !== undefined && (key === 'splitsymbol' || key === 'symbol')) {
                input.value = configValues.splitSymbol;
            } else if (configValues.trackingId !== undefined && key === 'trackingid') {
                input.value = configValues.trackingId;
            } else if (configValues.size !== undefined && key === 'size') {
                input.value = configValues.size;
            } else if (configValues.quality !== undefined && key === 'quality') {
                input.value = configValues.quality;
            } else if (configValues.deepThink !== undefined && key === 'deepthink') {
                input.value = String(configValues.deepThink);
            } else if (configValues.webSearch !== undefined && key === 'websearch') {
                input.value = String(configValues.webSearch);
            }
        }
    }

    // Calculate smart position for new node
    function calculateNextNodePosition(nodeType) {
        const allNodes = window.editor?.drawflow?.drawflow?.["Home"]?.data || {};
        const nodeList = Object.values(allNodes);
        
        if (nodeList.length === 0) {
            return { x: 50, y: 200 };
        }
        
        // Find rightmost node
        let maxX = 0;
        let avgY = 0;
        for (const node of nodeList) {
            if (node.pos_x > maxX) maxX = node.pos_x;
            avgY += node.pos_y;
        }
        avgY = avgY / nodeList.length;
        
        // Position new node to the right
        const newX = maxX + 400;
        
        // For output nodes, position them further right and at different Y levels
        if (nodeType === 'pinterest-output' || nodeType === 'facebook-output') {
            const outputNodes = nodeList.filter(n => 
                n.data?.type === 'pinterest-output' || n.data?.type === 'facebook-output'
            );
            const yOffset = outputNodes.length * 250;
            return { x: newX + 200, y: 100 + yOffset };
        }
        
        return { x: newX, y: avgY };
    }

    // Auto-layout nodes in a clean grid
    function autoLayoutNodes() {
        const allNodes = window.editor?.drawflow?.drawflow?.["Home"]?.data || {};
        const nodeList = Object.entries(allNodes);
        
        // Group by type
        const inputNodes = nodeList.filter(([_, n]) => n.data?.type === 'input');
        const outputNodes = nodeList.filter(([_, n]) => 
            n.data?.type === 'pinterest-output' || n.data?.type === 'facebook-output'
        );
        const processingNodes = nodeList.filter(([_, n]) => 
            n.data?.type !== 'input' && 
            n.data?.type !== 'pinterest-output' && 
            n.data?.type !== 'facebook-output'
        );
        
        // Position input node
        inputNodes.forEach(([id, _], idx) => {
            window.editor.drawflow.drawflow["Home"].data[id].pos_x = 50;
            window.editor.drawflow.drawflow["Home"].data[id].pos_y = 200 + idx * 200;
        });
        
        // Position processing nodes in columns
        const cols = Math.ceil(processingNodes.length / 3);
        processingNodes.forEach(([id, _], idx) => {
            const col = Math.floor(idx / 3);
            const row = idx % 3;
            window.editor.drawflow.drawflow["Home"].data[id].pos_x = 450 + col * 400;
            window.editor.drawflow.drawflow["Home"].data[id].pos_y = 100 + row * 200;
        });
        
        // Position output nodes
        const outputX = 450 + (cols + 1) * 400;
        outputNodes.forEach(([id, _], idx) => {
            window.editor.drawflow.drawflow["Home"].data[id].pos_x = outputX;
            window.editor.drawflow.drawflow["Home"].data[id].pos_y = 100 + idx * 250;
        });
        
        // Re-render
        const exported = window.editor.export();
        window.editor.import(exported);
        
        // Refresh connection paths after re-render
        requestAnimationFrame(() => {
            const reloadedNodes = window.editor?.drawflow?.drawflow?.Home?.data;
            if (reloadedNodes) {
                for (const nodeId in reloadedNodes) {
                    window.editor.updateConnectionNodes("node-" + nodeId);
                }
            }
        });
    }

    // Send message to AI agent
    async function sendAgentMessage() {
        const input = $('#aiAgentInput').val().trim();
        const hasImage = pendingImageBase64 !== null;
        
        if ((!input && !hasImage) || isAgentStreaming) return;
        
        // Initialize session log on first message
        if (agentMessages.length === 0) {
            initAgentSessionLog();
            const provider = $('#aiAgentProvider').val();
            const model = $('#aiAgentModel').val();
            logAgentEvent('config', { provider, model });
        }
        
        // Log user message
        logAgentEvent('user_message', { 
            text: input, 
            hasImage: hasImage,
            messageIndex: agentMessages.length
        });
        
        // Build user message - can be string or array with image
        let userContent;
        if (hasImage) {
            // Multi-part message with image
            userContent = [];
            if (input) {
                userContent.push({ type: 'text', text: input });
            }
            userContent.push({
                type: 'image_url',
                image_url: { url: pendingImageBase64 }
            });
        } else {
            userContent = input;
        }
        
        // Add user message with optional image for display
        agentMessages.push({ 
            role: 'user', 
            content: userContent,
            // Store image separately for rendering
            _imageBase64: hasImage ? pendingImageBase64 : null,
            _textContent: input
        });
        
        // Clear input and image
        $('#aiAgentInput').val('').trigger('input');
        pendingImageBase64 = null;
        $('#aiAgentImagePreview').hide();
        $('#aiAgentPreviewImg').attr('src', '');
        
        renderAgentMessages();
        
        // Start streaming
        isAgentStreaming = true;
        agentRetryCount = 0; // Reset retry count on each new user message
        currentStreamingMessage = '';
        updateAgentButtons(true);
        
        // Add typing indicator
        addTypingIndicator();
        
        // Get canvas state for context
        const canvasState = getCanvasState();
        logAgentEvent('canvas_state', { 
            nodes: canvasState.nodes?.length || 0, 
            connections: canvasState.connections?.length || 0 
        });
        
        // Setup streaming listener
        window.electronAPI.removeAutomationAgentListeners();
        window.electronAPI.onAutomationAgentChunk(handleAgentChunk);
        
        try {
            const provider = $('#aiAgentProvider').val();
            const model = $('#aiAgentModel').val();
            const language = window.I18n?.currentLanguage || 'en';
            
            const result = await window.electronAPI.automationAgentStream({
                messages: agentMessages,
                provider,
                model,
                canvasState,
                language
            });
            
            if (!result.success) {
                removeTypingIndicator();
                agentMessages.push({ role: 'assistant', content: `Error: ${result.error}` });
                renderAgentMessages();
                isAgentStreaming = false;
                updateAgentButtons(false);
            }
            // Note: Don't set isAgentStreaming=false here for success case
            // The handleAgentChunk callback will handle it when streaming completes
        } catch (error) {
            removeTypingIndicator();
            agentMessages.push({ role: 'assistant', content: `Error: ${error.message}` });
            renderAgentMessages();
            isAgentStreaming = false;
            updateAgentButtons(false);
        }
    }

    // Track network retry attempts
    let networkRetryCount = 0;
    const MAX_NETWORK_RETRIES = 2;

    // Handle streaming chunks
    async function handleAgentChunk(data) {
        if (!data.chunk) streamingDisplayOverride = null; // Reset on non-chunk events
        if (data.error) {
            removeTypingIndicator();
            hideCanvasOverlay();
            
            // Handle user-initiated stop
            if (data.stopped) {
                logAgentEvent('stopped', { reason: 'user' });
                agentMessages.push({ 
                    role: 'assistant', 
                    content: '⏹️ Agent stopped.',
                    _isStopMessage: true
                });
                renderAgentMessages();
                isAgentStreaming = false;
                updateAgentButtons(false);
                currentStreamingMessage = '';
                return;
            }
            
            // Log error and save session log for debugging
            logAgentEvent('error', { error: data.error, isRetryable: data.isRetryable });
            await saveAgentSessionLog();
            
            // Check if we should auto-retry on network errors
            if (data.isRetryable && networkRetryCount < MAX_NETWORK_RETRIES) {
                networkRetryCount++;
                console.log(`[AI Agent] Network error, auto-retrying... (attempt ${networkRetryCount}/${MAX_NETWORK_RETRIES})`);
                
                // Show retry message
                agentMessages.push({ 
                    role: 'assistant', 
                    content: `[WARNING] Connection interrupted. Retrying... (${networkRetryCount}/${MAX_NETWORK_RETRIES})`,
                    _isRetry: true
                });
                renderAgentMessages();
                
                // Wait a moment then retry
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Remove the retry message
                agentMessages = agentMessages.filter(m => !m._isRetry);
                
                // Retry the request
                await continueAfterToolCalls();
                return;
            }
            
            // Reset retry count on non-retryable errors or max retries reached
            networkRetryCount = 0;
            
            agentMessages.push({ role: 'assistant', content: `Error: ${data.error}` });
            renderAgentMessages();
            isAgentStreaming = false;
            updateAgentButtons(false);
            return;
        }
        
        // Reset retry count on successful chunks
        if (data.chunk || data.done) {
            networkRetryCount = 0;
        }
        
        if (data.chunk) {
            currentStreamingMessage += data.chunk;
            // For qwenbrowser, suppress <tool_call> blocks from the live display
            const provider = $('#aiAgentProvider').val();
            if (provider === 'qwenbrowser' && currentStreamingMessage.includes('<tool_call>')) {
                streamingDisplayOverride = currentStreamingMessage.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
            } else {
                streamingDisplayOverride = null;
            }
            renderAgentMessages(true);
        }
        
        if (data.done) {
            removeTypingIndicator();
            
            // Handle tool calls if present
            if (data.toolCalls && data.toolCalls.length > 0) {
                // Show canvas overlay
                showCanvasOverlay(data.toolCalls[0].name);

                // ── STEP ENFORCEMENT ─────────────────────────────────────────────
                // If the agent mixed add_node + connect_nodes in one batch, the
                // connect_nodes args will contain undefined IDs because the agent
                // wrote them before knowing the real nodeIds.  Split the batch:
                // execute ONLY add_node calls now, then force a new turn so the
                // agent reads real IDs from the results before connecting.
                const batchNames = data.toolCalls.map(tc => tc.name);
                const hasAddNode      = batchNames.includes('add_node');
                const hasConnectNodes = batchNames.includes('connect_nodes');
                const hasClearCanvas  = batchNames.includes('clear_canvas');

                if (hasAddNode && hasConnectNodes) {
                    // Keep only non-connect calls (add_node, edit_node, etc.)
                    data.toolCalls = data.toolCalls.filter(tc => tc.name !== 'connect_nodes');
                    console.warn('[AI Agent] Mixed add_node+connect_nodes batch detected — connect_nodes stripped. Will re-prompt with real IDs.');
                } else if (hasClearCanvas && (hasAddNode || hasConnectNodes)) {
                    // clear_canvas must run alone so keptNodes IDs are known before add_node
                    data.toolCalls = data.toolCalls.filter(tc => tc.name === 'clear_canvas');
                    console.warn('[AI Agent] Mixed clear_canvas+add_node/connect_nodes batch detected — only clear_canvas kept. Will re-prompt after canvas is cleared.');
                }
                // ─────────────────────────────────────────────────────────────────

                // Add assistant message WITH tool_calls - required for OpenAI format
                // The assistant message must include the tool_calls array
                // Strip <tool_call> blocks from displayed content (qwenbrowser text-based tool calling)
                const displayContent = currentStreamingMessage
                    ? currentStreamingMessage.replace(/<tool_call>[\\.\s\S]*?<\/tool_call>/gi, '').replace(/\n{3,}/g, '\n\n').trim()
                    : null;
                agentMessages.push({ 
                    role: 'assistant', 
                    content: displayContent || null,
                    tool_calls: data.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments)
                        }
                    }))
                });
                
                // Track tool execution status for UI
                const toolExecutionStatus = [];
                
                // Execute tools and collect results
                let connectNodeFailureCount = 0;
                const failedConnectionDetails = [];
                const toolResults = [];
                for (const toolCall of data.toolCalls) {
                    // Update overlay with current tool
                    updateCanvasOverlayTool(toolCall.name);
                    
                    // Log tool call
                    logAgentEvent('tool_call', { 
                        toolName: toolCall.name, 
                        args: toolCall.arguments,
                        toolCallId: toolCall.id
                    });
                    
                    // Add to status tracking (pending)
                    toolExecutionStatus.push({ name: toolCall.name, status: 'pending' });
                    renderAgentMessages(false, toolExecutionStatus);
                    
                    const result = await executeAgentTool(toolCall.name, toolCall.arguments);
                    if (toolCall.name === 'connect_nodes' && !result.success) {
                        connectNodeFailureCount++;
                        const a = toolCall.arguments || {};
                        failedConnectionDetails.push(`${a.fromNodeId}:${a.fromOutput} → ${a.toNodeId}:${a.toInput}: ${result.error || 'failed'}`);
                    }
                    
                    // Log tool result
                    logAgentEvent('tool_result', { 
                        toolName: toolCall.name, 
                        success: result.success,
                        result: result
                    });
                    
                    // Update status (success/error)
                    toolExecutionStatus[toolExecutionStatus.length - 1].status = result.success ? 'success' : 'error';
                    renderAgentMessages(false, toolExecutionStatus);
                    
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        name: toolCall.name,
                        result: JSON.stringify(result)
                    });
                    
                    // Add tool result to messages for context
                    agentMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: toolCall.name,
                        content: JSON.stringify(result)
                    });
                }
                
                // Continue conversation with tool results
                currentStreamingMessage = '';
                
                // For qwenbrowser: if the batch included auto_layout or a terminal tool,
                // the workflow is complete - skip continuation to prevent Qwen from looping
                const provider = $('#aiAgentProvider').val();
                const executedToolNames = data.toolCalls.map(tc => tc.name);
                const isWorkflowComplete = executedToolNames.includes('auto_layout');
                
                if ((provider === 'qwenbrowser' || provider === 'deepseekbrowser') && isWorkflowComplete) {
                    // Check if any connect_nodes calls failed — give AI a chance to fix (max 2 retries)
                    const hasConnectionFailures = connectNodeFailureCount > 0;
                    if (hasConnectionFailures && agentRetryCount < 2) {
                        agentRetryCount++;
                        // Inject targeted failure message so AI knows exactly what to fix
                        agentMessages.push({
                            role: 'user',
                            content: `[WARNING] CONNECTION FAILURES — these connect_nodes calls failed:\n${failedConnectionDetails.join('\n')}\n\nCall ONLY connect_nodes to fix these specific connections. Do NOT call clear_canvas, add_node, or auto_layout again.`
                        });
                        await continueAfterToolCalls();
                    } else {
                        hideCanvasOverlay();
                        const nodeCount = getCanvasState()?.nodes?.length || 0;
                        const connCount = getCanvasState()?.connections?.length || 0;
                        const doneMsg = `Workflow complete! Built ${nodeCount} nodes with ${connCount} connections.`;
                        agentMessages.push({ role: 'assistant', content: doneMsg });
                        logAgentEvent('ai_response', { content: doneMsg });
                        renderAgentMessages();
                        isAgentStreaming = false;
                        updateAgentButtons(false);
                        agentRetryCount = 0;
                        validationAttempts = 0;
                        await saveAgentSessionLog();
                    }
                } else {
                    // Request follow-up from AI
                    await continueAfterToolCalls();
                }
                
            } else if (data.failedToolCalls && data.failedToolCalls.length > 0) {
                // Hide canvas overlay
                hideCanvasOverlay();
                
                // Some tool calls failed to parse - show error and let user know
                console.error('[AI Agent] Tool calls failed to parse:', data.failedToolCalls);
                const failedNames = data.failedToolCalls.map(tc => tc.name).join(', ');
                agentMessages.push({
                    role: 'assistant',
                    content: `I tried to create the automation but there was an issue processing my request (${failedNames}). Let me try again with a simpler approach.\n\nCan you tell me:\n1. What type of content should the automation process? (recipe, quote, news, etc.)\n2. Where should it be posted? (Facebook or Pinterest?)`
                });
                
                // Streaming fully complete - re-enable UI
                isAgentStreaming = false;
                updateAgentButtons(false);
            } else {
                // Hide canvas overlay - AI is done building
                hideCanvasOverlay();
                
                // No tool calls, just add the message
                if (currentStreamingMessage || data.fullResponse) {
                    const aiContent = currentStreamingMessage || data.fullResponse;
                    agentMessages.push({ 
                        role: 'assistant', 
                        content: aiContent 
                    });
                    logAgentEvent('ai_response', { content: aiContent });
                } else {
                    // Empty response - likely a failed tool call parse
                    console.warn('[AI Agent] Received empty response - possible tool call parsing failure');
                    logAgentEvent('ai_response_empty', { message: 'Empty response received' });
                    agentMessages.push({
                        role: 'assistant',
                        content: "I tried to create the automation but encountered an issue. Let me try again with a simpler approach. What would you like me to build?"
                    });
                }
                
                renderAgentMessages();
                currentStreamingMessage = '';
                
                // Validation check - log issues but don't auto-fix (let user decide)
                const issues = validateWorkflow();
                if (issues.length > 0) {
                    const criticalCount = issues.filter(i => i.severity === 'critical').length;
                    if (criticalCount > 0) {
                        console.log(`[AI Agent] Validation found ${criticalCount} critical issues (not auto-fixing):`, 
                            issues.filter(i => i.severity === 'critical').map(i => i.type));
                    }
                    // Don't auto-fix - user can ask for validation/fixes if needed
                }
                
                // Streaming fully complete - re-enable UI
                isAgentStreaming = false;
                updateAgentButtons(false);
                validationAttempts = 0; // Reset on successful completion
                
                // Auto-save session log on successful completion
                logAgentEvent('session_complete', { 
                    finalNodes: getCanvasState()?.nodes?.length || 0,
                    finalConnections: getCanvasState()?.connections?.length || 0
                });
                await saveAgentSessionLog();
            }
            
            renderAgentMessages();
            currentStreamingMessage = '';
        }
    }

    // Continue conversation after tool calls
    async function continueAfterToolCalls() {
        isAgentStreaming = true;
        addTypingIndicator();
        
        // Use minimal canvas state for continuations - AI already has full context
        const canvasState = getCanvasState(true);
        const provider = $('#aiAgentProvider').val();
        const model = $('#aiAgentModel').val();
        const language = window.I18n?.currentLanguage || 'en';
        
        try {
            await window.electronAPI.automationAgentStream({
                messages: agentMessages,
                provider,
                model,
                canvasState,
                language
            });
            // Note: handleAgentChunk will be called with done:true when complete
        } catch (error) {
            removeTypingIndicator();
            agentMessages.push({ role: 'assistant', content: `Error: ${error.message}` });
            renderAgentMessages();
            isAgentStreaming = false;
            updateAgentButtons(false);
        }
    }

    // Render messages
    function renderAgentMessages(isStreaming = false, toolExecutionStatus = []) {
        const $container = $('#aiAgentMessages');
        
        // Check if we should show welcome screen
        const hasUserMessages = agentMessages.some(m => m.role === 'user');
        if (!hasUserMessages && !isStreaming) {
            $container.html(`
                <div class="ai-agent-welcome">
                    <i class="material-icons">waving_hand</i>
                    <h4>${window.I18n?.t('automation.ai_agent.welcome_title') || "Hi! I'm your automation assistant"}</h4>
                    <p>${window.I18n?.t('automation.ai_agent.welcome_text') || "Tell me what kind of automation you want to build, and I'll create it step by step."}</p>
                    <div class="ai-agent-suggestions">
                        <button class="ai-agent-suggestion" data-prompt="Create a simple Pinterest automation that reposts spy content with AI-rewritten text">
                            <i class="material-icons">auto_awesome</i>
                            <span>${window.I18n?.t('automation.ai_agent.suggestion_1') || "Pinterest repost with AI text"}</span>
                        </button>
                        <button class="ai-agent-suggestion" data-prompt="Build an automation that generates new images with Midjourney based on spy posts and posts to Pinterest">
                            <i class="material-icons">image</i>
                            <span>${window.I18n?.t('automation.ai_agent.suggestion_2') || "Midjourney image generation"}</span>
                        </button>
                        <button class="ai-agent-suggestion" data-prompt="Create a Facebook automation that rewrites spy text using Claude and posts with the original image">
                            <i class="material-icons">facebook</i>
                            <span>${window.I18n?.t('automation.ai_agent.suggestion_3') || "Facebook with Claude rewrite"}</span>
                        </button>
                    </div>
                </div>
            `);
            return;
        }
        
        let html = '';
        
        for (const msg of agentMessages) {
            if (msg.role === 'tool') continue; // Don't show raw tool results
            
            // Skip assistant messages with no content (tool-only responses)
            if (msg.role === 'assistant' && !msg.content && msg.tool_calls) continue;
            
            // Skip completely empty messages
            if (!msg.content && msg.role === 'assistant') continue;
            
            const isUser = msg.role === 'user';
            const isValidation = msg._isValidation === true;
            
            // Get text content for display
            let textContent = '';
            if (typeof msg.content === 'string') {
                textContent = msg.content;
            } else if (msg._textContent) {
                // Use stored text content for user messages with images
                textContent = msg._textContent;
            } else if (Array.isArray(msg.content)) {
                // Extract text from multi-part content
                const textPart = msg.content.find(p => p.type === 'text');
                textContent = textPart?.text || '';
            }
            
            // Check for attached image (user messages)
            const hasImage = msg._imageBase64;
            
            html += `
                <div class="ai-agent-message ${isUser ? 'user' : 'assistant'} ${isValidation ? 'validation' : ''}">
                    <div class="ai-agent-message-avatar">
                        <i class="material-icons">${isValidation ? 'warning' : (isUser ? 'person' : 'smart_toy')}</i>
                    </div>
                    <div class="ai-agent-message-content">
                        <div class="ai-agent-message-bubble">
                            ${hasImage ? `<img src="${hasImage}" class="ai-agent-message-image" alt="Attached image">` : ''}
                            ${textContent ? formatMessageContent(textContent) : ''}
                        </div>
                    </div>
                </div>
            `;
        }
        
        // Add tool execution status indicators
        if (toolExecutionStatus.length > 0) {
            html += '<div class="ai-agent-tool-calls">';
            for (const tool of toolExecutionStatus) {
                const icon = tool.status === 'success' ? 'check_circle' : tool.status === 'error' ? 'error' : 'hourglass_empty';
                const friendlyName = tool.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                html += `
                    <div class="ai-agent-tool-call ${tool.status}">
                        <i class="material-icons">${icon}</i>
                        <span>${friendlyName}</span>
                    </div>
                `;
            }
            html += '</div>';
        }
        
        // Add streaming message if present
        if (isStreaming && currentStreamingMessage) {
            html += `
                <div class="ai-agent-message assistant">
                    <div class="ai-agent-message-avatar">
                        <i class="material-icons">smart_toy</i>
                    </div>
                    <div class="ai-agent-message-content">
                        <div class="ai-agent-message-bubble">
                            ${formatMessageContent(streamingDisplayOverride !== null ? streamingDisplayOverride : currentStreamingMessage)}
                            <span class="ai-agent-cursor"></span>
                        </div>
                    </div>
                </div>
            `;
        }
        
        $container.html(html);
        
        // Scroll to bottom
        $container.scrollTop($container[0].scrollHeight);
    }

    // Format message content (basic markdown)
    function formatMessageContent(content) {
        if (!content) return '';
        
        let formatted = escapeHtml(content);
        
        // Code blocks (must be before line breaks)
        formatted = formatted.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        
        // Inline code
        formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Headings (must be before line breaks)
        formatted = formatted.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        formatted = formatted.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        formatted = formatted.replace(/^# (.+)$/gm, '<h2>$1</h2>');
        
        // Bold
        formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Italic
        formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        
        // Bullet lists
        formatted = formatted.replace(/^- (.+)$/gm, '<li>$1</li>');
        formatted = formatted.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        
        // Numbered lists
        formatted = formatted.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        
        // Line breaks (for non-heading lines)
        formatted = formatted.replace(/\n/g, '<br>');
        
        // Clean up extra breaks after block elements
        formatted = formatted.replace(/<\/(h[234]|ul|li|pre)><br>/g, '</$1>');
        formatted = formatted.replace(/<br><(h[234]|ul)/g, '<$1');
        
        return formatted;
    }

    // Add typing indicator
    function addTypingIndicator() {
        const $container = $('#aiAgentMessages');
        if ($container.find('.ai-agent-typing').length === 0) {
            $container.append(`
                <div class="ai-agent-message assistant ai-agent-typing-container">
                    <div class="ai-agent-message-avatar">
                        <i class="material-icons">smart_toy</i>
                    </div>
                    <div class="ai-agent-message-content">
                        <div class="ai-agent-message-bubble ai-agent-typing">
                            <span></span><span></span><span></span>
                        </div>
                    </div>
                </div>
            `);
            $container.scrollTop($container[0].scrollHeight);
        }
    }

    // Remove typing indicator
    function removeTypingIndicator() {
        $('#aiAgentMessages .ai-agent-typing-container').remove();
    }

    // Set cleanup function for this page
    window.currentPageCleanup = () => {
        // Clear Drawflow editor
        if (window.editor) {
            try {
                window.editor.clear();
                window.editor.removeNodeId = null;
            } catch (err) {
                console.warn('Error clearing automation editor:', err);
            }
        }
        
        // Reset automation state
        currentID = null;
        nodeOptionsLoaded = false;
        openAiApis = [];
        websites = [];
        minicanvas = [];
        googleProfiles = [];
        currentAutomationNodes = [];
        
        // Clear event handlers
        $('#automation-container').off();
        $(document).off('mousemove mouseup');
        
        // Remove test automation log listener
        window.electronAPI.removeTestAutomationLogListeners();
        
        // Remove AI agent listeners
        window.electronAPI.removeAutomationAgentListeners();
        
        // Reset AI agent state
        agentMessages = [];
        agentToolsSchema = null;
        isAgentStreaming = false;
        currentStreamingMessage = '';
        undoHistory.length = 0;
        redoHistory.length = 0;
        
        // Reset UI state
        isResizing = false;
        currentTestId = null;
        
        // Close any open info tooltip
        hideNodeInfoTooltip();
    };

});
