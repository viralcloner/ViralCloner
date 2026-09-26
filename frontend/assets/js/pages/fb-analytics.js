$(document).ready(async function () {
    // ========== STATE ==========
    const NS = '.fbAnalytics'; // Event namespace for cleanup
    let csvPosts = []; // Parsed posts from CSV
    let csvFilePath = null;
    let selectedProvider = null;
    let selectedModel = null;
    let selectedSpyProfile = null; // Selected spy profile for image fetching
    let selectedPageType = 'general';
    let selectedDepth = 50;
    let analyzeImages = false;
    let selectedImageCount = 10; // Default to 10 images
    let analysisResults = null;
    let isAnalyzing = false;
    let analysisCancelled = false;
    let selectedImages = []; // For comparison feature

    // Page type configurations for niche-specific analysis
    const PAGE_TYPES = {
        recipe: { icon: 'restaurant', title: 'Recipe Insights', nicheFields: 'ingredients, cuisines, cooking methods, dietary tags' },
        fitness: { icon: 'fitness_center', title: 'Fitness Insights', nicheFields: 'exercises, muscle groups, equipment, workout types' },
        fashion: { icon: 'checkroom', title: 'Fashion Insights', nicheFields: 'clothing types, brands, styles, occasions, colors' },
        travel: { icon: 'flight', title: 'Travel Insights', nicheFields: 'destinations, travel types, activities, seasons' },
        business: { icon: 'business', title: 'Business Insights', nicheFields: 'topics, industries, strategies, tools' },
        tech: { icon: 'computer', title: 'Tech Insights', nicheFields: 'products, brands, features, use cases' },
        entertainment: { icon: 'movie', title: 'Entertainment Insights', nicheFields: 'content types, genres, formats, trends' },
        education: { icon: 'school', title: 'Education Insights', nicheFields: 'subjects, learning formats, difficulty levels, target audiences' },
        motivation: { icon: 'psychology', title: 'Motivation Insights', nicheFields: 'themes, quote styles, emotional tones, call-to-actions' },
        general: { icon: 'auto_awesome', title: 'Content Insights', nicheFields: 'topics, formats, themes, styles' }
    };

    // AI Provider configurations (2025-2026 vision-capable models only)
    const AI_PROVIDERS = {
        openai: {
            name: 'OpenAI',
            storageKey: 'openaiKeys',
            models: [
                { id: 'gpt-5-nano', name: 'GPT-5 Nano' }
            ]
        },
        anthropic: {
            name: 'Anthropic',
            storageKey: 'anthropicKeys',
            models: [
                { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5 (Recommended)' },
                { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5 (Most Capable)' },
                { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (Faster)' }
            ]
        },
        googleai: {
            name: 'Google AI',
            storageKey: 'googleaiKeys',
            models: [
                { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Recommended)' },
                { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Faster)' },
                { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
                { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
            ]
        },
        openrouter: {
            name: 'OpenRouter',
            storageKey: 'openrouterKeys',
            models: [
                { id: 'openai/gpt-5.2', name: 'GPT-5.2 via OpenRouter' },
                { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5 via OpenRouter' },
                { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro via OpenRouter' },
                { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick (Vision)' }
            ]
        }
    };

    // ========== AI CHAT STATE ==========
    let chatOpen = false;
    let chatMinimized = false;
    let chatHistoryOpen = false;
    let currentConversationId = null;
    let chatMessages = [];
    let chatImages = [];
    let chatProvider = null;
    let chatModel = null;
    let isChatStreaming = false;
    let currentScanId = null; // Track current scan for chat persistence
    let generatedTitles = []; // Track previously generated titles to avoid duplicates

    // ========== INITIALIZATION ==========
    async function init() {
        setupEventListeners();
        setupChatEventListeners();
        await loadAvailableAIProviders();
        await checkSpyProfiles();
        await loadSavedScans(); // Load saved scans on page load
    }

    // ========== EVENT LISTENERS ==========
    function setupEventListeners() {
        // Browse CSV button
        $('#btn-browse-csv').off('click' + NS).on('click' + NS, selectCSVFile);

        // Dropzone drag & drop
        const dropzone = $('#import-dropzone');
        dropzone.off('dragover' + NS).on('dragover' + NS, function(e) {
            e.preventDefault();
            $(this).addClass('dragover');
        });
        dropzone.off('dragleave' + NS).on('dragleave' + NS, function(e) {
            e.preventDefault();
            $(this).removeClass('dragover');
        });
        dropzone.off('drop' + NS).on('drop' + NS, handleFileDrop);
        dropzone.off('click' + NS).on('click' + NS, function(e) {
            if (!$(e.target).closest('.btn-browse').length) {
                selectCSVFile();
            }
        });

        // Remove file button
        $('#btn-remove-file').off('click' + NS).on('click' + NS, resetImport);

        // AI provider select (user can change from auto-selected default)
        $('#ai-provider-select').off('change' + NS).on('change' + NS, onProviderChange);

        // AI model select
        $('#ai-model-select').off('change' + NS).on('change' + NS, onModelChange);

        // Spy profile select
        $('#spy-profile-select').off('change' + NS).on('change' + NS, function() {
            selectedSpyProfile = $(this).val() || null;
        });

        // Start analysis button
        $('#btn-start-analysis').off('click' + NS).on('click' + NS, startAnalysis);

        // Cancel analysis
        $('#btn-cancel-analysis').off('click' + NS).on('click' + NS, cancelAnalysis);

        // New analysis button
        $('#btn-new-analysis').off('click' + NS).on('click' + NS, resetToStep1);

        // Export results
        $('#btn-export-results').off('click' + NS).on('click' + NS, exportResults);

        // Generate automation button
        $('#btn-generate-automation').off('click' + NS).on('click' + NS, generateAutomation);

        // Image analysis checkbox - toggle image count selector
        $('#analyze-images').off('change' + NS).on('change' + NS, function() {
            const isChecked = $(this).is(':checked');
            $('#image-count-config').toggle(isChecked);
        });

        // Image count selector (max 50 images)
        $('#image-count-select').off('change' + NS).on('change' + NS, function() {
            const val = $(this).val();
            selectedImageCount = Math.min(parseInt(val) || 10, 50);
        });

        // Analysis depth selector - show hint for large datasets (max 300 posts)
        $('#analysis-depth-select').off('change' + NS).on('change' + NS, function() {
            const val = $(this).val();
            const numericVal = Math.min(parseInt(val) || 50, 300);
            const showHint = numericVal > 100;
            $('#chunked-analysis-hint').toggle(showHint);
        });

        // Save scan button - opens modal
        // Save scan button removed - now auto-saves after analysis

        // Save scan modal handlers
        $('#save-scan-close, #save-scan-cancel').off('click' + NS).on('click' + NS, function() {
            $('#save-scan-modal').removeClass('show');
        });
        $('#save-scan-overlay').off('click' + NS).on('click' + NS, function(e) {
            if (e.target === this) {
                $('#save-scan-modal').removeClass('show');
            }
        });
        $('#save-scan-confirm').off('click' + NS).on('click' + NS, confirmSaveScan);
        $('#save-scan-name').off('keypress' + NS).on('keypress' + NS, function(e) {
            if (e.which === 13) { // Enter key
                confirmSaveScan();
            }
        });

        // Saved scans toggle
        $('#saved-scans-toggle').off('click' + NS).on('click' + NS, function() {
            $(this).toggleClass('expanded');
            $('#saved-scans-content').slideToggle(200);
        });

        // Load scan button (delegated)
        $(document).off('click' + NS, '.btn-load-scan').on('click' + NS, '.btn-load-scan', function() {
            const scanId = $(this).data('scan-id');
            loadScan(scanId);
        });

        // Delete scan button (delegated)
        $(document).off('click' + NS, '.btn-delete-scan').on('click' + NS, '.btn-delete-scan', function() {
            const scanId = $(this).data('scan-id');
            deleteScan(scanId);
        });

        // Image gallery controls
        $(document).off('click' + NS, '.view-btn').on('click' + NS, '.view-btn', function() {
            $('.view-btn').removeClass('active');
            $(this).addClass('active');
            const view = $(this).data('view');
            $('#image-grid').toggleClass('list-view', view === 'list');
        });

        // Image item click - show detail (no more checkbox selection)
        $(document).off('click' + NS, '.image-item').on('click' + NS, '.image-item', function(e) {
            showImageDetail($(this).data('index'));
        });

        // Modal close buttons - close only when clicking overlay or X button
        $('#modal-close-detail').off('click' + NS).on('click' + NS, function() {
            $('#image-detail-modal').removeClass('show');
        });
        $('#modal-overlay').off('click' + NS).on('click' + NS, function(e) {
            // Only close if clicking directly on overlay, not on content above it
            if (e.target === this) {
                $('#image-detail-modal').removeClass('show');
            }
        });
        
        // Prevent modal content clicks from bubbling to overlay
        $('.modal-content').off('click' + NS).on('click' + NS, function(e) {
            e.stopPropagation();
        });

        // Composition grid toggle
        $(document).off('click' + NS, '.overlay-btn[data-overlay="grid"]').on('click' + NS, '.overlay-btn[data-overlay="grid"]', function() {
            $(this).toggleClass('active');
            $('#composition-grid').toggle();
        });
        
        // Listen for image analysis progress updates from main process
        window.electronAPI.onImageAnalysisProgress((data) => {
            if (!isAnalyzing) return;
            const progressBar = $('#analysis-progress-bar');
            const progressLog = $('#progress-log');
            
            if (data.type === 'analysis-start') {
                progressBar.css('width', '32%');
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">image</i> Starting ultra-detailed analysis of ${data.total} images...</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'image-analyzed') {
                const progress = 30 + (data.current / data.total) * 40; // 30% to 70%
                progressBar.css('width', `${progress}%`);
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">check_circle</i> Image ${data.current}/${data.total} analyzed (${data.chars} chars)</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'image-failed') {
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">error</i> Image ${data.current}/${data.total} failed: ${data.reason}</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'comparison-start') {
                progressBar.css('width', '72%');
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">psychology</i> AI comparing all images to find winning formula...</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'comparison-done') {
                progressBar.css('width', '78%');
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">check_circle</i> AI visual comparison complete</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'comparison-failed') {
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">warning</i> AI comparison failed: ${data.reason}</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'chunked-analysis-start') {
                progressBar.css('width', '32%');
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">layers</i> <strong>Chunked analysis:</strong> ${data.totalPosts} posts split into ${data.totalChunks} chunks</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'chunk-start') {
                const progress = 30 + ((data.current - 1) / data.total) * 45; // 30% to 75%
                progressBar.css('width', `${progress}%`);
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">analytics</i> Analyzing chunk ${data.current}/${data.total} (${data.postsInChunk} posts)...</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'chunk-done') {
                const progress = 30 + (data.current / data.total) * 45; // 30% to 75%
                progressBar.css('width', `${progress}%`);
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">check_circle</i> Chunk ${data.current}/${data.total} analyzed successfully</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'chunk-failed') {
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">error</i> Chunk ${data.current}/${data.total} failed: ${data.reason}</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            } else if (data.type === 'merging-chunks') {
                progressBar.css('width', '78%');
                progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">merge_type</i> Merging insights from ${data.successfulChunks}/${data.totalChunks} chunks...</div>`);
                progressLog.scrollTop(progressLog[0].scrollHeight);
            }
        });
    }

    // ========== AI CHAT EVENT LISTENERS ==========
    function setupChatEventListeners() {
        // FAB click - toggle chat panel
        $('#ai-chat-fab').off('click' + NS).on('click' + NS, toggleChatPanel);

        // Three-dots menu dropdown toggle
        $('#ai-chat-menu-btn').off('click' + NS).on('click' + NS, function(e) {
            e.stopPropagation();
            $('#ai-chat-dropdown').toggleClass('show');
        });

        // Close dropdown when clicking outside
        $(document).off('click' + NS + '.dropdown').on('click' + NS + '.dropdown', function(e) {
            if (!$(e.target).closest('.ai-chat-menu-wrapper').length) {
                $('#ai-chat-dropdown').removeClass('show');
            }
        });

        // Header dropdown items
        $('#ai-chat-history').off('click' + NS).on('click' + NS, function() {
            $('#ai-chat-dropdown').removeClass('show');
            toggleChatHistory();
        });
        $('#ai-chat-new').off('click' + NS).on('click' + NS, function() {
            $('#ai-chat-dropdown').removeClass('show');
            startNewChat();
        });
        $('#ai-chat-close').off('click' + NS).on('click' + NS, function() {
            $('#ai-chat-dropdown').removeClass('show');
            closeChatPanel();
        });

        // Model selector
        $('#ai-chat-model').off('change' + NS).on('change' + NS, onChatModelChange);

        // History panel close
        $('#ai-chat-history-close').off('click' + NS).on('click' + NS, function() {
            chatHistoryOpen = false;
            $('#ai-chat-history-panel').hide();
        });

        // History item click
        $(document).off('click' + NS, '.ai-chat-history-item').on('click' + NS, '.ai-chat-history-item', function(e) {
            if (!$(e.target).closest('.ai-chat-history-item-delete').length) {
                loadChatConversation($(this).data('id'));
            }
        });

        // History item delete
        $(document).off('click' + NS, '.ai-chat-history-item-delete').on('click' + NS, '.ai-chat-history-item-delete', function(e) {
            e.stopPropagation();
            deleteChatConversation($(this).closest('.ai-chat-history-item').data('id'));
        });

        // Suggestion buttons (except viral titles which has special handling)
        $(document).off('click' + NS, '.ai-chat-suggestion:not(.viral-titles-btn)').on('click' + NS, '.ai-chat-suggestion:not(.viral-titles-btn)', function() {
            const prompt = $(this).data('prompt') || $(this).text().trim();
            $('#ai-chat-input').val(prompt);
            sendChatMessage();
        });

        // Viral titles button with count
        $(document).off('click' + NS, '.viral-titles-btn').on('click' + NS, '.viral-titles-btn', function(e) {
            e.preventDefault();
            const count = $('#viral-titles-count').val() || '10';
            let prompt = `Generate ${count} viral post titles for my automation. Each title should be catchy, hook-driven, and optimized based on the winning patterns from my analysis. Format them as a numbered list (1. Title, 2. Title, etc). Keep titles in the same language as the analyzed posts. Output ONLY the numbered titles, no explanations.`;
            
            // Add previously generated titles to avoid duplicates
            if (generatedTitles.length > 0) {
                prompt += `\n\nIMPORTANT: Do NOT generate any of these previously generated titles or very similar variations:\n${generatedTitles.slice(-50).join('\n')}`;
            }
            
            $('#ai-chat-input').val(prompt);
            sendChatMessage();
        });

        // Copy title button
        $(document).off('click' + NS, '.copy-title-btn').on('click' + NS, '.copy-title-btn', function(e) {
            e.stopPropagation();
            const $parent = $(this).closest('.copyable-title');
            const title = $parent.data('title');
            if (title) {
                navigator.clipboard.writeText(title).then(() => {
                    $parent.addClass('copied');
                    showToast('success', window.I18n?.t('fb_analytics.chat.title_copied') || 'Title copied to clipboard!');
                    setTimeout(() => $parent.removeClass('copied'), 2000);
                }).catch(err => {
                    console.error('Copy failed:', err);
                    showToast('error', 'Failed to copy');
                });
            }
        });

        // Copy all titles button
        $(document).off('click' + NS, '.copy-all-titles-btn').on('click' + NS, '.copy-all-titles-btn', function(e) {
            e.stopPropagation();
            const $titles = $(this).closest('.ai-chat-message-bubble').find('.copyable-title');
            const titles = [];
            $titles.each(function() {
                const title = $(this).data('title');
                if (title) titles.push(title);
            });
            if (titles.length > 0) {
                const allTitles = titles.join(' | ');
                navigator.clipboard.writeText(allTitles).then(() => {
                    $titles.addClass('copied');
                    showToast('success', window.I18n?.t('fb_analytics.chat.all_titles_copied') || `${titles.length} titles copied!`);
                    setTimeout(() => $titles.removeClass('copied'), 2000);
                }).catch(err => {
                    console.error('Copy failed:', err);
                    showToast('error', 'Failed to copy');
                });
            }
        });

        // Click on copyable title to copy
        $(document).off('click' + NS, '.copyable-title').on('click' + NS, '.copyable-title', function(e) {
            if (!$(e.target).closest('.title-action-btn').length) {
                const title = $(this).data('title');
                if (title) {
                    navigator.clipboard.writeText(title).then(() => {
                        $(this).addClass('copied');
                        showToast('success', window.I18n?.t('fb_analytics.chat.title_copied') || 'Title copied to clipboard!');
                        setTimeout(() => $(this).removeClass('copied'), 2000);
                    });
                }
            }
        });

        // Send button
        $('#ai-chat-send').off('click' + NS).on('click' + NS, sendChatMessage);

        // Attach image button
        $('#ai-chat-attach').off('click' + NS).on('click' + NS, function() {
            $('#ai-chat-image-input').click();
        });

        // Image input change
        $('#ai-chat-image-input').off('change' + NS).on('change' + NS, handleChatImageSelect);

        // Clear images
        $('#clear-chat-images').off('click' + NS).on('click' + NS, function() {
            chatImages = [];
            $('#ai-chat-image-preview').hide();
            updateSendButtonState();
        });

        // Input textarea - send on Enter, newline on Shift+Enter
        $('#ai-chat-input').off('keydown' + NS).on('keydown' + NS, function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });

        // Auto-resize textarea
        $('#ai-chat-input').off('input' + NS).on('input' + NS, function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            updateSendButtonState();
        });

        // Listen for streaming chunks
        window.electronAPI.onFbAnalyticsChatChunk(handleChatChunk);
    }

    // Handle image selection for chat
    function handleChatImageSelect(e) {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            const reader = new FileReader();
            reader.onload = function(event) {
                chatImages.push(event.target.result);
                updateImagePreview();
            };
            reader.readAsDataURL(file);
        }
        
        // Reset input so same file can be selected again
        e.target.value = '';
    }

    // ========== AI CHAT FUNCTIONS ==========
    function toggleChatPanel() {
        chatOpen = !chatOpen;
        if (chatOpen) {
            $('#ai-chat-panel').addClass('open');
            chatMinimized = false;
            $('#ai-chat-panel').removeClass('minimized');
            initializeChatModels();
        } else {
            $('#ai-chat-panel').removeClass('open');
        }
    }

    function closeChatPanel() {
        chatOpen = false;
        $('#ai-chat-panel').removeClass('open');
    }

    function minimizeChat() {
        chatMinimized = !chatMinimized;
        $('#ai-chat-panel').toggleClass('minimized', chatMinimized);
    }

    function toggleChatHistory() {
        chatHistoryOpen = !chatHistoryOpen;
        if (chatHistoryOpen) {
            loadChatHistoryList();
            $('#ai-chat-history-panel').show();
        } else {
            $('#ai-chat-history-panel').hide();
        }
    }

    async function initializeChatModels() {
        const $select = $('#ai-chat-model');
        $select.empty();

        // Use same provider as analytics if available
        if (selectedProvider && AI_PROVIDERS[selectedProvider]) {
            chatProvider = selectedProvider;
            const provider = AI_PROVIDERS[selectedProvider];
            provider.models.forEach(model => {
                $select.append(`<option value="${selectedProvider}:${model.id}">${model.name}</option>`);
            });
            chatModel = provider.models[0]?.id;
            $select.val(`${selectedProvider}:${chatModel}`);
        } else {
            // Add all available providers
            for (const [key, provider] of Object.entries(AI_PROVIDERS)) {
                const hasKeys = await window.electronAPI.readKey(provider.storageKey);
                if (hasKeys && Object.keys(hasKeys).length > 0) {
                    provider.models.forEach(model => {
                        $select.append(`<option value="${key}:${model.id}">${provider.name} - ${model.name}</option>`);
                    });
                    if (!chatProvider) {
                        chatProvider = key;
                        chatModel = provider.models[0]?.id;
                    }
                }
            }
            if (chatProvider && chatModel) {
                $select.val(`${chatProvider}:${chatModel}`);
            }
        }
    }

    function onChatModelChange() {
        const val = $(this).val();
        if (val) {
            const [provider, ...modelParts] = val.split(':');
            chatProvider = provider;
            chatModel = modelParts.join(':'); // Handle models with colons in name
        }
    }

    function startNewChat() {
        currentConversationId = null;
        chatMessages = [];
        chatImages = [];
        generatedTitles = []; // Reset tracked titles for new conversation
        renderChatMessages();
        chatHistoryOpen = false;
        $('#ai-chat-history-panel').hide();
        $('#ai-chat-input').val('').focus();
        showToast('info', 'Started new conversation');
    }

    function updateSendButtonState() {
        const hasText = $('#ai-chat-input').val().trim().length > 0;
        const hasImages = chatImages.length > 0;
        $('#ai-chat-send').prop('disabled', (!hasText && !hasImages) || isChatStreaming);
    }

    function updateImagePreview() {
        const $preview = $('#ai-chat-image-preview');
        const $images = $('#preview-images');
        $images.empty();

        if (chatImages.length === 0) {
            $preview.hide();
            return;
        }

        chatImages.forEach(img => {
            $images.append(`<img src="${img}" alt="Preview">`);
        });
        $preview.show();
        updateSendButtonState();
    }

    function buildChatContext() {
        // Build context from current analysis results
        const context = {
            pageInfo: null,
            topPosts: [],
            imageAnalyses: [],
            patterns: '',
            insights: null
        };

        if (analysisResults) {
            // Page info
            context.pageInfo = {
                name: csvFilePath?.split(/[/\\]/).pop()?.replace('.csv', '') || 'Unknown',
                totalPosts: analysisResults.totalPosts || csvPosts.length,
                totalViews: analysisResults.totalViews || 0,
                avgViews: analysisResults.avgViews || 0,
                pageType: analysisResults.pageType || selectedPageType
            };

            // Top posts - sort by views and take top 10
            if (analysisResults.posts && analysisResults.posts.length > 0) {
                const sortedPosts = [...analysisResults.posts]
                    .sort((a, b) => (b.views || 0) - (a.views || 0))
                    .slice(0, 10);
                
                context.topPosts = sortedPosts.map((p, i) => ({
                    rank: i + 1,
                    text: p.text || p.title || p.description || '',
                    views: p.views || 0,
                    reactions: p.reactions || 0,
                    comments: p.comments || 0,
                    shares: p.shares || 0,
                    date: p.date || p.createdTime || '',
                    type: p.type || 'post'
                }));
            }

            // Image analyses from imageDescriptions
            if (analysisResults.imageDescriptions && analysisResults.imageDescriptions.length > 0) {
                context.imageAnalyses = analysisResults.imageDescriptions.map(img => ({
                    rank: img.rank,
                    views: img.views,
                    description: img.description?.substring(0, 800) || ''
                }));
            }

            // AI Insights - the main analysis results
            if (analysisResults.aiInsights) {
                const insights = analysisResults.aiInsights;
                context.insights = {
                    winningKeywords: insights.winningKeywords || [],
                    hookPatterns: insights.hookPatterns || [],
                    contentStructure: insights.contentStructure || {},
                    psychologicalTriggers: insights.psychologicalTriggers || [],
                    doMore: insights.doMore || [],
                    avoid: insights.avoid || [],
                    contentIdeas: insights.contentIdeas || [],
                    nicheInsights: insights.nicheInsights || {},
                    visualPatterns: insights.visualPatterns || null
                };
            }

            // Image comparison summary
            if (analysisResults.imageComparison) {
                context.imageComparison = analysisResults.imageComparison.substring(0, 2000);
            }
        }

        // Include previously generated titles to help AI avoid duplicates
        if (generatedTitles.length > 0) {
            context.previouslyGeneratedTitles = generatedTitles.slice(-50); // Last 50 titles
        }

        return context;
    }

    async function sendChatMessage() {
        const input = $('#ai-chat-input').val().trim();
        if ((!input && chatImages.length === 0) || isChatStreaming) return;

        // Generate conversation ID if new
        if (!currentConversationId) {
            currentConversationId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        // Add user message
        const userMessage = {
            role: 'user',
            content: input,
            images: [...chatImages],
            timestamp: Date.now()
        };
        chatMessages.push(userMessage);

        // Clear input and images
        $('#ai-chat-input').val('');
        chatImages = [];
        updateImagePreview();
        updateSendButtonState();

        // Render messages with typing indicator
        renderChatMessages(true);

        // Scroll to bottom
        scrollChatToBottom();

        isChatStreaming = true;
        updateSendButtonState();

        try {
            const context = buildChatContext();
            const appLanguage = window.I18n?.getLocale?.() || 'en';
            
            const result = await window.electronAPI.fbAnalyticsChatStream({
                messages: chatMessages,
                provider: chatProvider,
                model: chatModel,
                images: userMessage.images,
                context,
                language: appLanguage
            });

            if (!result.success && !result.streaming) {
                throw new Error(result.error || 'Failed to send message');
            }

            // Response will come via streaming chunks
        } catch (error) {
            console.error('[Chat] Send error:', error);
            isChatStreaming = false;
            updateSendButtonState();
            
            // Remove typing indicator and show error
            chatMessages.push({
                role: 'assistant',
                content: `Sorry, I encountered an error: ${error.message}`,
                timestamp: Date.now()
            });
            renderChatMessages();
            showToast('error', 'Failed to send message');
        }
    }

    let currentStreamingMessage = '';

    function handleChatChunk(data) {
        if (data.error) {
            isChatStreaming = false;
            currentStreamingMessage = '';
            updateSendButtonState();
            showToast('error', data.error);
            return;
        }

        if (data.chunk) {
            currentStreamingMessage += data.chunk;
            renderChatMessages(true, currentStreamingMessage);
            scrollChatToBottom();
        }

        if (data.done && isChatStreaming) {
            isChatStreaming = false;
            updateSendButtonState();

            const responseContent = data.fullResponse || currentStreamingMessage;
            
            // Add completed assistant message
            chatMessages.push({
                role: 'assistant',
                content: responseContent,
                timestamp: Date.now()
            });

            // Extract and track generated titles from response
            extractAndTrackTitles(responseContent);

            currentStreamingMessage = '';
            renderChatMessages();

            // Auto-save conversation
            saveChatConversation();
        }
    }

    /**
     * Extract numbered titles from AI response and add to tracking list
     * Matches patterns like "1. Title" or "1) Title"
     */
    function extractAndTrackTitles(content) {
        if (!content) return;
        
        // Match numbered list items (1. Title or 1) Title)
        const titleRegex = /^\d+[.)\s]+(.+)$/gm;
        let match;
        const newTitles = [];
        
        while ((match = titleRegex.exec(content)) !== null) {
            const title = match[1].trim();
            // Only track substantial titles (not very short matches)
            if (title.length >= 10 && !generatedTitles.includes(title)) {
                newTitles.push(title);
            }
        }
        
        if (newTitles.length > 0) {
            generatedTitles.push(...newTitles);
            // Keep only the last 200 titles to prevent memory bloat
            if (generatedTitles.length > 200) {
                generatedTitles = generatedTitles.slice(-200);
            }
            console.log(`[FB-Analytics Chat] Tracked ${newTitles.length} new titles. Total: ${generatedTitles.length}`);
        }
    }

    function renderChatMessages(showTyping = false, streamingContent = '') {
        const $messages = $('#ai-chat-messages');
        $messages.empty();

        if (chatMessages.length === 0 && !showTyping) {
            // Show welcome screen
            $messages.html(`
                <div class="ai-chat-welcome">
                    <div class="ai-chat-welcome-icon">
                        <i class="material-icons">psychology</i>
                    </div>
                    <h4 data-i18n="fb_analytics.chat.welcome_title">AI Analytics Assistant</h4>
                    <p data-i18n="fb_analytics.chat.welcome_text">Ask me anything about your page's performance, content patterns, or get suggestions for viral content!</p>
                    <div class="ai-chat-suggestions">
                        <button class="ai-chat-suggestion" data-prompt="What makes my top posts successful?">
                            <i class="material-icons">trending_up</i>
                            <span>What makes my top posts successful?</span>
                        </button>
                        <div class="viral-titles-group">
                            <button class="ai-chat-suggestion viral-titles-btn" id="generate-viral-titles-btn">
                                <i class="material-icons">title</i>
                                <span data-i18n="fb_analytics.chat.generate_titles">Generate viral titles</span>
                            </button>
                            <select id="viral-titles-count" class="viral-titles-count">
                                <option value="5">5</option>
                                <option value="10" selected>10</option>
                                <option value="15">15</option>
                                <option value="20">20</option>
                                <option value="30">30</option>
                            </select>
                        </div>
                        <button class="ai-chat-suggestion" data-prompt="Give me 5 viral post ideas for this niche">
                            <i class="material-icons">lightbulb</i>
                            <span>Give me 5 viral post ideas</span>
                        </button>
                        <button class="ai-chat-suggestion" data-prompt="What are the best posting times based on my data?">
                            <i class="material-icons">schedule</i>
                            <span>Best posting times?</span>
                        </button>
                    </div>
                </div>
            `);
            if (window.I18n) window.I18n.translatePage();
            return;
        }

        // Render each message
        chatMessages.forEach(msg => {
            const isOwn = msg.role === 'user';
            const $msg = $(`
                <div class="ai-chat-message ${isOwn ? 'own' : ''}">
                    <div class="ai-chat-message-avatar">
                        <i class="material-icons">${isOwn ? 'person' : 'psychology'}</i>
                    </div>
                    <div class="ai-chat-message-content">
                        ${msg.images?.length ? `
                            <div class="ai-chat-message-images">
                                ${msg.images.map(img => `<img src="${img}" alt="Attached">`).join('')}
                            </div>
                        ` : ''}
                        <div class="ai-chat-message-bubble">${formatChatMessage(msg.content)}</div>
                        <span class="ai-chat-message-time">${formatChatTime(msg.timestamp)}</span>
                    </div>
                </div>
            `);
            $messages.append($msg);
        });

        // Show typing indicator or streaming content
        if (showTyping) {
            const content = streamingContent ? formatChatMessage(streamingContent) : `
                <div class="ai-chat-typing-dots">
                    <span></span><span></span><span></span>
                </div>
            `;
            $messages.append(`
                <div class="ai-chat-message">
                    <div class="ai-chat-message-avatar">
                        <i class="material-icons">psychology</i>
                    </div>
                    <div class="ai-chat-message-content">
                        <div class="ai-chat-message-bubble">${content}</div>
                    </div>
                </div>
            `);
        }
    }

    function formatChatMessage(content) {
        if (!content) return '';
        
        // Basic markdown-like formatting
        let formatted = escapeHtml(content);
        
        // Code blocks
        formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        
        // Inline code
        formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Bold
        formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Italic
        formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        
        // Detect numbered titles (1. Title, 2. Title, etc.) and make them copyable
        // Match lines that start with a number followed by . or ) and content
        let hasTitles = false;
        formatted = formatted.replace(/^(\d+)[.\)]\s*(.+)$/gm, (match, num, titleText) => {
            // Clean up the title text (remove any trailing markdown/HTML)
            const cleanTitle = titleText.replace(/<[^>]*>/g, '').replace(/<br>/g, '').trim();
            if (cleanTitle.length < 5) return match; // Skip very short matches
            hasTitles = true;
            return `<div class="copyable-title" data-title="${escapeHtml(cleanTitle)}">
                <span class="title-number">${num}.</span>
                <span class="title-text">${titleText}</span>
                <span class="title-actions">
                    <button class="title-action-btn copy-title-btn" title="${window.I18n?.t('fb_analytics.chat.copy_title') || 'Copy title'}">
                        <i class="material-icons">content_copy</i>
                    </button>
                </span>
            </div>`;
        });
        
        // Add "Copy all" button at the bottom if there are titles
        if (hasTitles) {
            formatted = formatted + `<div class="copy-all-titles-container">
                <button class="copy-all-titles-btn" title="${window.I18n?.t('fb_analytics.chat.copy_all_titles') || 'Copy all titles'}">
                    <i class="material-icons">copy_all</i>
                    <span>${window.I18n?.t('fb_analytics.chat.copy_all') || 'Copy all'}</span>
                </button>
            </div>`;
        }
        
        // Line breaks (after numbered list processing)
        formatted = formatted.replace(/\n/g, '<br>');
        
        // Lists (but not for numbered items we already processed)
        formatted = formatted.replace(/^- (.+)$/gm, '<li>$1</li>');
        formatted = formatted.replace(/(<li>.*<\/li>)+/g, '<ul>$&</ul>');
        
        return formatted;
    }

    function formatChatTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function scrollChatToBottom() {
        const $messages = $('#ai-chat-messages');
        $messages.scrollTop($messages[0].scrollHeight);
    }

    async function saveChatConversation() {
        if (!currentScanId || !currentConversationId || chatMessages.length === 0) return;

        try {
            // Generate title from first user message
            const firstUserMsg = chatMessages.find(m => m.role === 'user');
            const title = firstUserMsg?.content?.substring(0, 50) || 'New conversation';

            await window.electronAPI.saveFbAnalyticsChat({
                scanId: currentScanId,
                conversationId: currentConversationId,
                conversation: {
                    title,
                    messages: chatMessages,
                    createdAt: chatMessages[0]?.timestamp || Date.now(),
                    provider: chatProvider,
                    model: chatModel
                }
            });
        } catch (error) {
            console.error('[Chat] Save error:', error);
        }
    }

    async function loadChatHistoryList() {
        const $list = $('#ai-chat-history-list');
        $list.empty();

        if (!currentScanId) {
            $list.html(`
                <div class="ai-chat-history-empty">
                    <i class="material-icons">chat_bubble_outline</i>
                    <p data-i18n="fb_analytics.chat.no_scan">Run an analysis first to start chatting</p>
                </div>
            `);
            if (window.I18n) window.I18n.translatePage();
            return;
        }

        try {
            const result = await window.electronAPI.getFbAnalyticsChats(currentScanId);
            
            if (!result.success || result.conversations.length === 0) {
                $list.html(`
                    <div class="ai-chat-history-empty">
                        <i class="material-icons">chat_bubble_outline</i>
                        <p data-i18n="fb_analytics.chat.no_history">No conversations yet</p>
                    </div>
                `);
                if (window.I18n) window.I18n.translatePage();
                return;
            }

            result.conversations.forEach(conv => {
                const isActive = conv.id === currentConversationId;
                const date = new Date(conv.updatedAt || conv.createdAt).toLocaleDateString();
                $list.append(`
                    <div class="ai-chat-history-item ${isActive ? 'active' : ''}" data-id="${conv.id}">
                        <i class="material-icons">chat</i>
                        <div class="ai-chat-history-item-content">
                            <div class="ai-chat-history-item-title">${escapeHtml(conv.title)}</div>
                            <div class="ai-chat-history-item-date">${date} · ${conv.messageCount} messages</div>
                        </div>
                        <button class="ai-chat-history-item-delete" title="Delete">
                            <i class="material-icons">delete</i>
                        </button>
                    </div>
                `);
            });
        } catch (error) {
            console.error('[Chat] Load history error:', error);
            $list.html(`<div class="ai-chat-history-empty"><p>Failed to load history</p></div>`);
        }
    }

    async function loadChatConversation(conversationId) {
        try {
            const result = await window.electronAPI.loadFbAnalyticsChat({
                scanId: currentScanId,
                conversationId
            });

            if (!result.success) {
                showToast('error', 'Failed to load conversation');
                return;
            }

            currentConversationId = conversationId;
            chatMessages = result.conversation.messages || [];
            
            // Update model if different
            if (result.conversation.provider && result.conversation.model) {
                chatProvider = result.conversation.provider;
                chatModel = result.conversation.model;
                $('#ai-chat-model').val(`${chatProvider}:${chatModel}`);
            }

            renderChatMessages();
            scrollChatToBottom();
            
            chatHistoryOpen = false;
            $('#ai-chat-history-panel').hide();
            
            showToast('info', 'Conversation loaded');
        } catch (error) {
            console.error('[Chat] Load conversation error:', error);
            showToast('error', 'Failed to load conversation');
        }
    }

    async function deleteChatConversation(conversationId) {
        const confirmed = await confirmPrompt(window.I18n?.t('fb_analytics.confirm_delete_conversation') || 'Delete this conversation?');
        if (!confirmed) return;

        try {
            await window.electronAPI.deleteFbAnalyticsChat({
                scanId: currentScanId,
                conversationId
            });

            // If deleting current conversation, start new
            if (conversationId === currentConversationId) {
                startNewChat();
            }

            // Refresh history list
            loadChatHistoryList();
            showToast('success', 'Conversation deleted');
        } catch (error) {
            console.error('[Chat] Delete error:', error);
            showToast('error', 'Failed to delete conversation');
        }
    }

    // Show chat FAB when analysis is complete
    function showChatFab() {
        $('#ai-chat-fab').addClass('active');
    }

    function hideChatFab() {
        $('#ai-chat-fab').removeClass('active');
        closeChatPanel();
    }

    // ========== CSV IMPORT ==========
    async function selectCSVFile() {
        try {
            const result = await window.electronAPI.selectFacebookInsightsCsv();
            if (result.success && result.filePath) {
                await parseCSVFile(result.filePath);
            }
        } catch (error) {
            console.error('[FB Analytics] CSV selection error:', error);
            showToast('error', window.I18n?.t('fb_analytics.errors.csv_select_failed') || 'Failed to select CSV file');
        }
    }

    function handleFileDrop(e) {
        e.preventDefault();
        $(this).removeClass('dragover');

        const files = e.originalEvent.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            if (file.name.endsWith('.csv')) {
                parseCSVFile(file.path);
            } else {
                showToast('error', window.I18n?.t('fb_analytics.errors.invalid_file') || 'Please select a CSV file');
            }
        }
    }

    async function parseCSVFile(filePath) {
        try {
            const result = await window.electronAPI.parseFacebookInsightsCsv(filePath);
            
            if (!result.success) {
                showToast('error', result.error || 'Failed to parse CSV');
                return;
            }

            csvPosts = result.posts;
            csvFilePath = filePath;

            // Update UI
            const filename = filePath.split(/[/\\]/).pop();
            $('#import-filename').text(filename);
            $('#import-post-count').text(`${csvPosts.length} posts`);
            $('#import-dropzone').hide();
            $('#import-info').show();
            $('#ai-config-card').fadeIn();

            updateAnalyzeButton();

            showToast('success', window.I18n?.t('fb_analytics.import.success', { count: csvPosts.length }) || `Successfully imported ${csvPosts.length} posts`);
        } catch (error) {
            console.error('[FB Analytics] CSV parse error:', error);
            showToast('error', window.I18n?.t('fb_analytics.errors.csv_parse_failed') || 'Failed to parse CSV file');
        }
    }

    function resetImport() {
        csvPosts = [];
        csvFilePath = null;
        $('#import-dropzone').show();
        $('#import-info').hide();
        $('#ai-config-card').hide();
        updateAnalyzeButton();
    }

    // ========== AI PROVIDER CONFIGURATION ==========
    async function loadAvailableAIProviders() {
        const providerSelect = $('#ai-provider-select');
        providerSelect.empty();
        providerSelect.append(`<option value="">${window.I18n?.t('fb_analytics.ai.select_provider') || 'Select AI Provider'}</option>`);
        
        let firstProvider = null;

        // Populate available providers
        for (const [providerId, config] of Object.entries(AI_PROVIDERS)) {
            try {
                const keys = await window.electronAPI.readKey(config.storageKey);
                // Keys are stored as objects with API key as property name
                // e.g., { "sk-xxx": { label: "My Key", status: "active" } }
                if (keys && typeof keys === 'object') {
                    const keyEntries = Object.entries(keys);
                    const hasValidKey = keyEntries.some(([apiKey, data]) => 
                        apiKey && apiKey.trim() !== '' && data && data.status === 'active'
                    );
                    if (hasValidKey) {
                        providerSelect.append(`<option value="${providerId}">${config.name}</option>`);
                        if (!firstProvider) {
                            firstProvider = providerId;
                        }
                    }
                }
            } catch (error) {
                console.error(`[FB Analytics] Error loading ${providerId} keys:`, error);
            }
        }

        // Check if any providers are available
        if (providerSelect.find('option').length <= 1) {
            providerSelect.append(`<option value="" disabled>${window.I18n?.t('fb_analytics.ai.no_providers') || 'No AI providers configured'}</option>`);
        } else if (firstProvider) {
            // Auto-select first available provider and trigger model population
            providerSelect.val(firstProvider);
            selectedProvider = firstProvider;
            
            // Populate models for the auto-selected provider
            const modelSelect = $('#ai-model-select');
            modelSelect.empty();
            modelSelect.append(`<option value="">${window.I18n?.t('fb_analytics.ai.select_model') || 'Select Model'}</option>`);
            
            const models = AI_PROVIDERS[firstProvider].models;
            models.forEach(model => {
                modelSelect.append(`<option value="${model.id}">${model.name}</option>`);
            });
            modelSelect.prop('disabled', false);
            
            // Auto-select first (recommended) model
            if (models.length > 0) {
                modelSelect.val(models[0].id);
                selectedModel = models[0].id;
            }
            
            console.log(`[FB Analytics] Auto-selected AI: ${AI_PROVIDERS[firstProvider].name} / ${models[0]?.name}`);
        }
        
        updateAnalyzeButton();
    }

    function onProviderChange() {
        const providerId = $(this).val();
        const modelSelect = $('#ai-model-select');
        
        modelSelect.empty();
        modelSelect.append(`<option value="">${window.I18n?.t('fb_analytics.ai.select_model') || 'Select Model'}</option>`);

        if (providerId && AI_PROVIDERS[providerId]) {
            selectedProvider = providerId;
            const models = AI_PROVIDERS[providerId].models;
            models.forEach(model => {
                modelSelect.append(`<option value="${model.id}">${model.name}</option>`);
            });
            modelSelect.prop('disabled', false);
            
            // Auto-select first (recommended) model
            if (models.length > 0) {
                modelSelect.val(models[0].id);
                selectedModel = models[0].id;
            }
        } else {
            selectedProvider = null;
            modelSelect.prop('disabled', true);
        }

        updateAnalyzeButton();
    }

    function onModelChange() {
        selectedModel = $(this).val() || null;
        updateAnalyzeButton();
    }

    // ========== SPY PROFILE SELECTION ==========
    async function checkSpyProfiles() {
        const profileSelect = $('#spy-profile-select');
        const statusDiv = $('#spy-profile-status');
        
        profileSelect.empty();
        profileSelect.append(`<option value="">${window.I18n?.t('fb_analytics.spy.select_profile') || 'Select Spy Profile'}</option>`);
        
        try {
            // Get spy profiles - stored as object: { "profileId": { name, platform, status, ... } }
            const profiles = await window.electronAPI.readKey('spyProfiles');
            
            // Handle case where profiles is not an object or is empty
            if (!profiles || typeof profiles !== 'object' || Object.keys(profiles).length === 0) {
                statusDiv.html(`
                    <div class="check-status error">
                        <i class="material-icons">error</i>
                        <span>${window.I18n?.t('fb_analytics.spy.no_profiles') || 'No Facebook spy profiles configured. Please add one in the Spy page.'}</span>
                    </div>
                `);
                profileSelect.prop('disabled', true);
                return false;
            }

            // Check if any profile has Facebook platform
            const profileEntries = Object.entries(profiles);
            const fbProfiles = profileEntries.filter(([id, p]) => 
                p && (p.platform === 'facebook' || !p.platform)
            );
            
            if (fbProfiles.length === 0) {
                statusDiv.html(`
                    <div class="check-status error">
                        <i class="material-icons">error</i>
                        <span>${window.I18n?.t('fb_analytics.spy.no_fb_profiles') || 'No Facebook spy profiles found. Please add one in the Spy page.'}</span>
                    </div>
                `);
                profileSelect.prop('disabled', true);
                return false;
            }

            // Populate dropdown with profiles
            fbProfiles.forEach(([id, profile]) => {
                const displayName = profile.name || id;
                profileSelect.append(`<option value="${id}">${displayName}</option>`);
            });
            
            // Auto-select first profile
            if (fbProfiles.length > 0) {
                const [firstId] = fbProfiles[0];
                profileSelect.val(firstId);
                selectedSpyProfile = firstId;
            }
            
            profileSelect.prop('disabled', false);
            statusDiv.html(`
                <div class="check-status success">
                    <i class="material-icons">check_circle</i>
                    <span>${window.I18n?.t('fb_analytics.spy.profiles_ready', { count: fbProfiles.length }) || `${fbProfiles.length} Facebook spy profile(s) available`}</span>
                </div>
            `);
            return true;
        } catch (error) {
            console.error('[FB Analytics] Spy profile check error:', error);
            checkDiv.html(`
                <div class="check-status error">
                    <i class="material-icons">error</i>
                    <span>${window.I18n?.t('fb_analytics.spy.check_failed') || 'Failed to check spy profiles'}</span>
                </div>
            `);
            return false;
        }
    }

    // ========== ANALYZE BUTTON STATE ==========
    function updateAnalyzeButton() {
        const canAnalyze = csvPosts.length > 0 && selectedProvider && selectedModel;
        $('#btn-start-analysis').prop('disabled', !canAnalyze);
    }

    // ========== ANALYSIS ==========
    async function startAnalysis() {
        if (isAnalyzing) return;
        
        isAnalyzing = true;
        analysisCancelled = false;

        // Get selected options (enforce max limits: 300 posts, 50 images)
        selectedPageType = $('#page-type-select').val() || 'general';
        const depthVal = $('#analysis-depth-select').val();
        selectedDepth = Math.min(parseInt(depthVal) || 50, 300);
        analyzeImages = $('#analyze-images').is(':checked');
        const imageCountVal = $('#image-count-select').val();
        selectedImageCount = Math.min(parseInt(imageCountVal) || 10, 50);

        // Switch to step 2 (progress)
        $('#fb-analytics-step1').hide();
        $('#fb-analytics-step2').show();
        $('#fb-analytics-step3').hide();

        const progressBar = $('#analysis-progress-bar');
        const progressStatus = $('#progress-status');
        const progressLog = $('#progress-log');

        progressBar.css('width', '0%');
        progressLog.empty();

        const addLog = (message, type = 'info') => {
            const icon = type === 'error' ? 'error' : type === 'success' ? 'check_circle' : 'info';
            progressLog.append(`<div class="log-item"><i class="material-icons" style="font-size: 12px; vertical-align: middle;">${icon}</i> ${message}</div>`);
            progressLog.scrollTop(progressLog[0].scrollHeight);
        };

        try {
            // Step 1: Prepare data for analysis (10%)
            progressBar.css('width', '10%');
            progressStatus.text(window.I18n?.t('fb_analytics.analyzing.preparing') || 'Preparing data for analysis...');

            // Filter out posts with less than 30 shares (low quality posts)
            const MIN_SHARES_THRESHOLD = 30;
            const qualityPosts = csvPosts.filter(p => (p.shares || 0) >= MIN_SHARES_THRESHOLD);
            const filteredCount = csvPosts.length - qualityPosts.length;
            
            if (filteredCount > 0) {
                addLog(`Filtered out ${filteredCount} posts with less than ${MIN_SHARES_THRESHOLD} shares`, 'info');
            }
            
            if (qualityPosts.length === 0) {
                throw new Error(`No posts found with at least ${MIN_SHARES_THRESHOLD} shares. Try importing a CSV with more viral content.`);
            }

            // Adjust selectedDepth if it exceeds available quality posts
            const effectiveDepth = Math.min(selectedDepth, qualityPosts.length);
            addLog(`Preparing top ${effectiveDepth} quality posts for deep analysis...`);

            // Calculate basic metrics from filtered posts
            const totalViews = qualityPosts.reduce((sum, p) => sum + (p.views || 0), 0);
            const avgViews = qualityPosts.length > 0 ? Math.round(totalViews / qualityPosts.length) : 0;

            if (analysisCancelled) throw new Error('Analysis cancelled');

            // Step 2: Optionally fetch images from top posts
            let postImages = [];
            if (analyzeImages && qualityPosts.length > 0) {
                progressBar.css('width', '15%');
                progressStatus.text(window.I18n?.t('fb_analytics.analyzing.fetching_images') || 'Fetching and downloading images from top posts...');
                const effectiveImageCount = Math.min(selectedImageCount, qualityPosts.length, 50);
                addLog(`Fetching ${effectiveImageCount} images from top posts for visual analysis...`);
                if (selectedSpyProfile) {
                    addLog(`Using spy profile: ${selectedSpyProfile}`);
                }

                // CSV parser returns 'permalink' field, not 'link'
                const topPostsWithLinks = qualityPosts.slice(0, effectiveImageCount).filter(p => p.permalink);
                
                if (topPostsWithLinks.length === 0) {
                    addLog('No post URLs found in CSV data', 'error');
                } else {
                    for (let i = 0; i < topPostsWithLinks.length && !analysisCancelled; i++) {
                        try {
                            const progress = 15 + (i / topPostsWithLinks.length) * 15; // 15% to 30%
                            progressBar.css('width', `${progress}%`);
                            addLog(`Fetching image ${i + 1}/${topPostsWithLinks.length}...`);
                            
                            // Use extractFacebookPostImage which also downloads locally, pass selected profile
                            const imgResult = await window.electronAPI.extractFacebookPostImage(
                                topPostsWithLinks[i].permalink,
                                60000, // timeout
                                selectedSpyProfile // selected spy profile
                            );
                            
                            // Scraper returns { success, value: imageUrl, text: postText, localPath: localImagePath }
                            if (imgResult.success && (imgResult.value || imgResult.localPath)) {
                                postImages.push({
                                    rank: i + 1,
                                    image: imgResult.value, // CDN URL (may expire)
                                    localPath: imgResult.localPath, // Local downloaded path
                                    views: topPostsWithLinks[i].views,
                                    description: (topPostsWithLinks[i].description || '').substring(0, 200),
                                    permalink: topPostsWithLinks[i].permalink
                                });
                                addLog(`Image ${i + 1} downloaded successfully`, 'success');
                            } else {
                                addLog(`Image ${i + 1} failed: ${imgResult.error || 'No image found'}`, 'error');
                            }
                        } catch (imgError) {
                            console.warn('[FB Analytics] Failed to fetch image:', imgError);
                            addLog(`Image ${i + 1} failed: ${imgError.message || 'Unknown error'}`, 'error');
                        }
                    }
                }
                addLog(`Downloaded ${postImages.length} images for analysis`, postImages.length > 0 ? 'success' : 'info');
            }

            if (analysisCancelled) throw new Error('Analysis cancelled');

            // Step 3: Send to AI for analysis (30-80%)
            progressBar.css('width', '30%');
            progressStatus.text(window.I18n?.t('fb_analytics.analyzing.ai_processing') || 'AI is analyzing your content...');
            addLog(`Sending ${effectiveDepth} quality posts to ${AI_PROVIDERS[selectedProvider].name} for deep analysis...`);

            // Prepare posts for AI with more data (only quality posts with 30+ shares)
            const postsForAI = qualityPosts.slice(0, effectiveDepth).map((p, idx) => ({
                rank: idx + 1,
                views: p.views || 0,
                shares: p.shares || 0,
                description: (p.description || '').substring(0, 500), // More text for better analysis
                link: p.permalink || ''
            }));

            // Get current app language for AI responses
            const appLanguage = window.I18n?.getLocale?.() || 'en';

            // Call AI analysis with new parameters
            let aiResult = await window.electronAPI.analyzeFacebookContent({
                provider: selectedProvider,
                model: selectedModel,
                posts: postsForAI,
                totalPosts: qualityPosts.length,
                totalViews: totalViews,
                avgViews: avgViews,
                pageType: selectedPageType,
                nicheConfig: PAGE_TYPES[selectedPageType],
                images: postImages,
                language: appLanguage
            });

            if (analysisCancelled) throw new Error('Analysis cancelled');

            progressBar.css('width', '80%');

            if (!aiResult.success) {
                // Check if it's a content policy refusal with images
                if (aiResult.refusalType === 'content_policy' && postImages.length > 0) {
                    addLog('AI refused to analyze images due to content policy. Retrying without images...', 'warning');
                    
                    // Retry without images
                    const retryResult = await window.electronAPI.analyzeFacebookContent({
                        provider: selectedProvider,
                        model: selectedModel,
                        posts: qualityPosts.slice(0, effectiveDepth).map((p, idx) => ({
                            rank: idx + 1,
                            views: p.views || 0,
                            shares: p.shares || 0,
                            description: (p.description || '').substring(0, 500),
                            link: p.permalink || ''
                        })),
                        totalPosts: qualityPosts.length,
                        totalViews: totalViews,
                        avgViews: avgViews,
                        pageType: selectedPageType,
                        nicheConfig: PAGE_TYPES[selectedPageType],
                        images: [], // No images this time
                        language: appLanguage
                    });
                    
                    if (!retryResult.success) {
                        throw new Error(retryResult.error || 'AI analysis failed');
                    }
                    
                    aiResult = retryResult;
                    postImages = []; // Clear images since we didn't use them
                    addLog('Text-only analysis completed successfully', 'success');
                } else {
                    throw new Error(aiResult.error || 'AI analysis failed');
                }
            }

            addLog('AI analysis complete!', 'success');

            // Step 3: Process results (80-100%)
            progressBar.css('width', '90%');
            progressStatus.text(window.I18n?.t('fb_analytics.analyzing.processing_results') || 'Processing results...');
            addLog('Generating dashboard...');

            // Store results including images and AI comparison
            // Note: We store qualityPosts (30+ shares) not all csvPosts
            analysisResults = {
                posts: qualityPosts,
                totalPosts: qualityPosts.length,
                filteredOutPosts: filteredCount, // Posts excluded due to low shares
                totalViews: totalViews,
                avgViews: avgViews,
                pageType: selectedPageType,
                hasImageAnalysis: postImages.length > 0,
                postImages: postImages, // Store downloaded images with local paths
                imageDescriptions: aiResult.imageDescriptions || [], // AI analysis per image (now with rank, views, description)
                imageComparison: aiResult.imageComparison || null, // Automatic AI comparison of all images
                aiInsights: aiResult.insights,
                analyzedAt: new Date().toISOString()
            };

            progressBar.css('width', '100%');
            addLog('Analysis complete!', 'success');

            // Wait a moment for user to see completion
            await new Promise(resolve => setTimeout(resolve, 500));

            // Show results
            showResults();

            // Auto-save the scan
            await autoSaveScan();

        } catch (error) {
            console.error('[FB Analytics] Analysis error:', error);
            
            if (error.message === 'Analysis cancelled') {
                addLog('Analysis cancelled by user', 'error');
            } else {
                addLog(`Error: ${error.message}`, 'error');
                showToast('error', error.message || 'Analysis failed');
            }

            // Return to step 1 after delay
            setTimeout(() => {
                resetToStep1();
            }, 2000);
        } finally {
            isAnalyzing = false;
        }
    }

    function cancelAnalysis() {
        analysisCancelled = true;
    }

    // ========== RESULTS DISPLAY ==========
    function showResults() {
        $('#fb-analytics-step1').hide();
        $('#fb-analytics-step2').hide();
        $('#fb-analytics-step3').show();

        if (!analysisResults) return;

        const { posts, totalPosts, totalViews, avgViews, pageType, hasImageAnalysis, postImages, imageDescriptions, imageComparison, aiInsights } = analysisResults;

        // Update overview cards
        $('#total-posts').text(formatNumber(totalPosts));
        $('#total-views').text(formatNumber(totalViews));
        
        // Calculate viral rate (posts that got 2x+ average views)
        const viralThreshold = avgViews * 2;
        const viralPosts = posts.filter(p => (p.views || 0) >= viralThreshold).length;
        const viralRate = totalPosts > 0 ? Math.round((viralPosts / totalPosts) * 100) : 0;
        $('#viral-rate').text(`${viralRate}%`);

        // Top keyword from AI insights
        if (aiInsights.winningKeywords && aiInsights.winningKeywords.length > 0) {
            $('#top-keyword').text(aiInsights.winningKeywords[0].keyword || aiInsights.winningKeywords[0]);
        }

        // Subtitle
        const pageTypeLabel = PAGE_TYPES[pageType]?.title || 'Content';
        $('#results-subtitle').text(
            `${pageTypeLabel} • ` +
            (window.I18n?.t('fb_analytics.results.analyzed_posts', { count: totalPosts }) || `Analyzed ${totalPosts} posts`) +
            ` • ${new Date().toLocaleDateString()}`
        );

        // Update niche-specific card header
        const nicheConfig = PAGE_TYPES[pageType] || PAGE_TYPES.general;
        $('#niche-icon').text(nicheConfig.icon);
        $('#niche-title').text(nicheConfig.title);

        // RENDER IMAGE GALLERY (primary visual section)
        if (hasImageAnalysis && postImages && postImages.length > 0) {
            $('#image-gallery-card').show();
            renderImageGallery(postImages, imageDescriptions);
            
            // Show AI Comparison card if we have automatic comparison
            if (imageComparison) {
                $('#ai-comparison-card').show();
                renderAIComparison(imageComparison);
            } else {
                $('#ai-comparison-card').hide();
            }
            
            // Show visual summary if we have visual patterns
            if (aiInsights.visualPatterns && aiInsights.visualPatterns.summary) {
                $('#visual-summary-card').show();
                renderVisualSummary(aiInsights.visualPatterns);
            } else {
                $('#visual-summary-card').hide();
            }
        } else {
            $('#image-gallery-card').hide();
            $('#ai-comparison-card').hide();
            $('#visual-summary-card').hide();
        }

        // Show/hide visual patterns card based on image analysis
        // New structure: visualPatterns is now an object with detailed fields, not an array
        if (hasImageAnalysis && aiInsights.visualPatterns && typeof aiInsights.visualPatterns === 'object' && aiInsights.visualPatterns.summary) {
            $('#visual-patterns-card').show();
            renderVisualPatterns(aiInsights.visualPatterns);
        } else if (hasImageAnalysis && Array.isArray(aiInsights.visualPatterns) && aiInsights.visualPatterns.length > 0) {
            // Fallback for old array format
            $('#visual-patterns-card').show();
            renderVisualPatternsLegacy(aiInsights.visualPatterns);
        } else {
            $('#visual-patterns-card').hide();
        }

        // Render all sections
        renderKeywords(aiInsights.winningKeywords || []);
        renderHookPatterns(aiInsights.hookPatterns || []);
        renderNicheInsights(aiInsights.nicheInsights || {});
        renderContentStructure(aiInsights.contentStructure || {});
        renderTriggers(aiInsights.psychologicalTriggers || []);
        renderTopPostsDeep(posts.slice(0, 5), aiInsights.topPostAnalysis || []);
        renderDoMore(aiInsights.doMore || []);
        renderAvoid(aiInsights.avoid || []);
        renderContentIdeas(aiInsights.contentIdeas || []);

        // Generate a temporary scan ID for chat (will be replaced if user saves scan)
        if (!currentScanId) {
            currentScanId = `temp_${Date.now()}`;
        }
        
        // Show AI Chat FAB
        showChatFab();
    }

    // ========== NEW RENDER FUNCTIONS FOR DEEP ANALYTICS ==========

    function renderKeywords(keywords) {
        const container = $('#keywords-content');
        container.empty();

        if (!keywords || keywords.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No keyword data available'}</p>`);
            return;
        }

        const listHtml = `<div class="keyword-list">
            ${keywords.map((kw, idx) => {
                const keyword = typeof kw === 'string' ? kw : kw.keyword;
                const score = typeof kw === 'object' ? kw.score : null;
                const level = idx < 3 ? 'high' : (idx < 7 ? 'medium' : '');
                return `<span class="keyword-tag ${level}">
                    ${escapeHtml(keyword)}
                    ${score ? `<span class="keyword-score">${score}%</span>` : ''}
                </span>`;
            }).join('')}
        </div>`;
        container.html(listHtml);
    }

    function renderHookPatterns(hooks) {
        const container = $('#hooks-content');
        container.empty();

        if (!hooks || hooks.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No hook pattern data available'}</p>`);
            return;
        }

        hooks.slice(0, 5).forEach(hook => {
            container.append(`
                <div class="hook-item">
                    <div class="hook-example">"${escapeHtml(hook.example || hook)}"</div>
                    ${hook.explanation ? `<div class="hook-explanation">${escapeHtml(hook.explanation)}</div>` : ''}
                </div>
            `);
        });
    }

    function renderNicheInsights(insights) {
        const container = $('#niche-specific-content');
        container.empty();

        if (!insights || Object.keys(insights).length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No niche-specific data available'}</p>`);
            return;
        }

        // insights could be { topIngredients: [], topCuisines: [] } for recipes, etc.
        Object.entries(insights).forEach(([key, values]) => {
            if (!values || (Array.isArray(values) && values.length === 0)) return;
            
            const title = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
            const icon = getInsightIcon(key);
            
            let content = '';
            if (Array.isArray(values)) {
                content = values.slice(0, 5).map(v => {
                    const name = typeof v === 'string' ? v : v.name;
                    const count = typeof v === 'object' ? v.count : null;
                    return `<span class="keyword-tag">${escapeHtml(name)}${count ? ` (${count})` : ''}</span>`;
                }).join(' ');
            } else if (typeof values === 'string') {
                content = `<p style="margin:0; font-size:13px; color:var(--text-secondary);">${escapeHtml(values)}</p>`;
            }

            container.append(`
                <div class="insight-item">
                    <div class="insight-icon"><i class="material-icons">${icon}</i></div>
                    <div class="insight-content">
                        <h4>${escapeHtml(title)}</h4>
                        <div style="margin-top: 8px;">${content}</div>
                    </div>
                </div>
            `);
        });
    }

    function getInsightIcon(key) {
        const icons = {
            ingredients: 'restaurant_menu', topIngredients: 'restaurant_menu',
            cuisines: 'public', topCuisines: 'public',
            exercises: 'fitness_center', topExercises: 'fitness_center',
            products: 'shopping_bag', topProducts: 'shopping_bag',
            destinations: 'place', topDestinations: 'place',
            topics: 'topic', topTopics: 'topic',
            styles: 'style', topStyles: 'style',
            themes: 'palette', topThemes: 'palette'
        };
        return icons[key] || 'auto_awesome';
    }

    function renderContentStructure(structure) {
        const container = $('#content-structure-content');
        container.empty();

        if (!structure || Object.keys(structure).length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No structure data available'}</p>`);
            return;
        }

        const structureItems = [
            { key: 'optimalLength', icon: 'straighten', title: 'Optimal Length' },
            { key: 'emojiUsage', icon: 'emoji_emotions', title: 'Emoji Usage' },
            { key: 'hashtagStrategy', icon: 'tag', title: 'Hashtag Strategy' },
            { key: 'ctaStyle', icon: 'touch_app', title: 'Call-to-Action Style' },
            { key: 'format', icon: 'format_list_bulleted', title: 'Post Format' }
        ];

        structureItems.forEach(item => {
            const value = structure[item.key];
            if (!value) return;
            
            container.append(`
                <div class="structure-item">
                    <div class="structure-icon"><i class="material-icons">${item.icon}</i></div>
                    <div class="structure-content">
                        <h4>${item.title}</h4>
                        <p>${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value))}</p>
                    </div>
                </div>
            `);
        });

        // If no standard items found, show raw structure
        if (container.children().length === 0) {
            Object.entries(structure).forEach(([key, value]) => {
                container.append(`
                    <div class="structure-item">
                        <div class="structure-icon"><i class="material-icons">info</i></div>
                        <div class="structure-content">
                            <h4>${escapeHtml(key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()))}</h4>
                            <p>${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value))}</p>
                        </div>
                    </div>
                `);
            });
        }
    }

    function renderVisualPatterns(patterns) {
        const container = $('#visual-patterns-content');
        container.empty();

        if (!patterns || typeof patterns !== 'object') {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No visual pattern data available'}</p>`);
            return;
        }

        // Summary section
        if (patterns.summary) {
            container.append(`
                <div class="visual-summary mb-4">
                    <div class="alert alert-info">
                        <i class="material-icons" style="vertical-align: middle;">lightbulb</i>
                        <strong>Winning Visual Formula:</strong> ${escapeHtml(patterns.summary)}
                    </div>
                </div>
            `);
        }

        // Build detailed sections
        let sectionsHtml = '<div class="visual-details-grid">';

        // Production Quality
        if (patterns.productionQuality) {
            sectionsHtml += `
                <div class="visual-detail-card">
                    <div class="detail-header">
                        <i class="material-icons">videocam</i>
                        <h5>Production Quality</h5>
                    </div>
                    <div class="detail-winner">
                        <span class="badge badge-success">${escapeHtml(patterns.productionQuality.winner || 'N/A')}</span>
                    </div>
                    <p class="detail-insight">${escapeHtml(patterns.productionQuality.insight || '')}</p>
                </div>
            `;
        }

        // Lighting
        if (patterns.lighting) {
            sectionsHtml += `
                <div class="visual-detail-card">
                    <div class="detail-header">
                        <i class="material-icons">wb_sunny</i>
                        <h5>Lighting</h5>
                    </div>
                    <div class="detail-winner">
                        <span class="badge badge-warning">${escapeHtml(patterns.lighting.winner || 'N/A')}</span>
                    </div>
                    <p class="detail-insight">${escapeHtml(patterns.lighting.insight || '')}</p>
                </div>
            `;
        }

        // Camera Work
        if (patterns.cameraWork) {
            const angles = Array.isArray(patterns.cameraWork.winningAngles) 
                ? patterns.cameraWork.winningAngles.join(', ') 
                : patterns.cameraWork.winningAngles || 'N/A';
            sectionsHtml += `
                <div class="visual-detail-card">
                    <div class="detail-header">
                        <i class="material-icons">camera_alt</i>
                        <h5>Camera & Angles</h5>
                    </div>
                    <div class="detail-tags">
                        <span class="tag">Angles: ${escapeHtml(angles)}</span>
                        <span class="tag">Distance: ${escapeHtml(patterns.cameraWork.winningDistance || 'N/A')}</span>
                        <span class="tag">DOF: ${escapeHtml(patterns.cameraWork.depthOfField || 'N/A')}</span>
                    </div>
                    <p class="detail-insight">${escapeHtml(patterns.cameraWork.insight || '')}</p>
                </div>
            `;
        }

        // Composition
        if (patterns.composition) {
            const compPatterns = Array.isArray(patterns.composition.patterns) 
                ? patterns.composition.patterns.map(p => `<span class="tag">${escapeHtml(p)}</span>`).join('') 
                : '';
            sectionsHtml += `
                <div class="visual-detail-card">
                    <div class="detail-header">
                        <i class="material-icons">grid_on</i>
                        <h5>Composition</h5>
                    </div>
                    <div class="detail-tags">${compPatterns}</div>
                    <p class="detail-insight">${escapeHtml(patterns.composition.insight || '')}</p>
                </div>
            `;
        }

        // Color Palette
        if (patterns.colorPalette) {
            const colors = Array.isArray(patterns.colorPalette.dominantColors) 
                ? patterns.colorPalette.dominantColors.map(c => `<span class="color-tag">${escapeHtml(c)}</span>`).join('') 
                : '';
            sectionsHtml += `
                <div class="visual-detail-card">
                    <div class="detail-header">
                        <i class="material-icons">palette</i>
                        <h5>Color Palette</h5>
                    </div>
                    <div class="color-tags">${colors}</div>
                    <div class="detail-tags">
                        <span class="tag">Temp: ${escapeHtml(patterns.colorPalette.temperature || 'N/A')}</span>
                        <span class="tag">Saturation: ${escapeHtml(patterns.colorPalette.saturation || 'N/A')}</span>
                    </div>
                    <p class="detail-insight">${escapeHtml(patterns.colorPalette.insight || '')}</p>
                </div>
            `;
        }

        // Styling
        if (patterns.styling) {
            sectionsHtml += `
                <div class="visual-detail-card">
                    <div class="detail-header">
                        <i class="material-icons">style</i>
                        <h5>Styling & Props</h5>
                    </div>
                    <div class="detail-tags">
                        <span class="tag">Background: ${escapeHtml(patterns.styling.backgroundStyle || 'N/A')}</span>
                        <span class="tag">Clutter: ${escapeHtml(patterns.styling.clutterLevel || 'N/A')}</span>
                    </div>
                    <p class="detail-insight">${escapeHtml(patterns.styling.propsUsage || '')}</p>
                    <p class="detail-insight">${escapeHtml(patterns.styling.insight || '')}</p>
                </div>
            `;
        }

        // Text Overlays
        if (patterns.textOverlays) {
            sectionsHtml += `
                <div class="visual-detail-card">
                    <div class="detail-header">
                        <i class="material-icons">text_fields</i>
                        <h5>Text Overlays</h5>
                    </div>
                    <div class="detail-tags">
                        <span class="tag">Usage: ${escapeHtml(patterns.textOverlays.usage || 'N/A')}</span>
                        ${patterns.textOverlays.fontStyle ? `<span class="tag">Font: ${escapeHtml(patterns.textOverlays.fontStyle)}</span>` : ''}
                        ${patterns.textOverlays.placement ? `<span class="tag">Position: ${escapeHtml(patterns.textOverlays.placement)}</span>` : ''}
                    </div>
                    <p class="detail-insight">${escapeHtml(patterns.textOverlays.insight || '')}</p>
                </div>
            `;
        }

        sectionsHtml += '</div>';
        container.append(sectionsHtml);

        // Scroll Stoppers section
        if (patterns.scrollStoppers && Array.isArray(patterns.scrollStoppers) && patterns.scrollStoppers.length > 0) {
            let stoppersHtml = `
                <div class="scroll-stoppers-section mt-4">
                    <h5><i class="material-icons">touch_app</i> Scroll-Stopping Elements</h5>
                    <div class="stoppers-list">
            `;
            patterns.scrollStoppers.forEach(stopper => {
                stoppersHtml += `
                    <div class="stopper-item">
                        <span class="stopper-element">${escapeHtml(stopper.element || '')}</span>
                        <span class="stopper-frequency">${escapeHtml(stopper.frequency || '')}</span>
                    </div>
                `;
            });
            stoppersHtml += '</div></div>';
            container.append(stoppersHtml);
        }

        // Visual Recommendations
        if (patterns.recommendations && Array.isArray(patterns.recommendations) && patterns.recommendations.length > 0) {
            let recsHtml = `
                <div class="visual-recommendations mt-4">
                    <h5><i class="material-icons">auto_awesome</i> Visual Recommendations</h5>
                    <div class="recommendations-list">
            `;
            patterns.recommendations.forEach(rec => {
                recsHtml += `
                    <div class="recommendation-item">
                        <h6>${escapeHtml(rec.title || '')}</h6>
                        <p>${escapeHtml(rec.description || '')}</p>
                    </div>
                `;
            });
            recsHtml += '</div></div>';
            container.append(recsHtml);
        }
    }

    // Legacy function for old array format
    function renderVisualPatternsLegacy(patterns) {
        const container = $('#visual-patterns-content');
        container.empty();

        if (!patterns || patterns.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No visual pattern data available'}</p>`);
            return;
        }

        patterns.forEach(pattern => {
            const icon = pattern.icon || 'palette';
            container.append(`
                <div class="visual-item">
                    <div class="visual-icon"><i class="material-icons">${icon}</i></div>
                    <div class="visual-content">
                        <h4>${escapeHtml(pattern.title || pattern.pattern)}</h4>
                        <p>${escapeHtml(pattern.description || '')}</p>
                    </div>
                </div>
            `);
        });
    }

    function renderTriggers(triggers) {
        const container = $('#triggers-content');
        container.empty();

        if (!triggers || triggers.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No trigger data available'}</p>`);
            return;
        }

        triggers.forEach(trigger => {
            const type = (trigger.type || 'value').toLowerCase().replace(/\s+/g, '-');
            container.append(`
                <div class="trigger-item ${type}">
                    <h4>${escapeHtml(trigger.name || trigger.type)}</h4>
                    <p>${escapeHtml(trigger.description || trigger.example || '')}</p>
                </div>
            `);
        });
    }

    function renderTopPostsDeep(posts, analysis) {
        const container = $('#top-posts-content');
        container.empty();

        if (!posts || posts.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_posts') || 'No posts available'}</p>`);
            return;
        }

        posts.slice(0, 5).forEach((post, idx) => {
            const description = post.description || 'No description';
            const truncated = description.length > 200 ? description.substring(0, 200) + '...' : description;
            const rankClass = idx === 0 ? 'gold' : (idx === 1 ? 'silver' : (idx === 2 ? 'bronze' : ''));
            
            // Get AI analysis for this post if available
            const postAnalysis = analysis && analysis[idx] ? analysis[idx] : null;
            
            container.append(`
                <div class="top-post-deep">
                    <div class="top-post-rank ${rankClass}">${idx + 1}</div>
                    <div class="top-post-details">
                        <div class="top-post-text">${escapeHtml(truncated)}</div>
                        ${postAnalysis ? `
                            <div class="top-post-analysis">
                                <h5>Why it worked</h5>
                                <p>${escapeHtml(postAnalysis.reason || postAnalysis)}</p>
                            </div>
                        ` : ''}
                        <div class="top-post-meta">
                            <span><i class="material-icons">visibility</i> ${formatNumber(post.views || 0)} views</span>
                        </div>
                    </div>
                </div>
            `);
        });
    }

    function renderDoMore(items) {
        const container = $('#do-more-content');
        container.empty();

        if (!items || items.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No recommendations available'}</p>`);
            return;
        }

        items.forEach(item => {
            const title = typeof item === 'string' ? item : item.title;
            const desc = typeof item === 'object' ? item.description : '';
            container.append(`
                <div class="action-item">
                    <h4>\u2705 ${escapeHtml(title)}</h4>
                    ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
                </div>
            `);
        });
    }

    function renderAvoid(items) {
        const container = $('#avoid-content');
        container.empty();

        if (!items || items.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No recommendations available'}</p>`);
            return;
        }

        items.forEach(item => {
            const title = typeof item === 'string' ? item : item.title;
            const desc = typeof item === 'object' ? item.description : '';
            container.append(`
                <div class="action-item">
                    <h4>\u274c ${escapeHtml(title)}</h4>
                    ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
                </div>
            `);
        });
    }

    function renderContentIdeas(ideas) {
        const container = $('#content-ideas-content');
        container.empty();

        if (!ideas || ideas.length === 0) {
            container.html(`<p class="text-muted">${window.I18n?.t('fb_analytics.results.no_data') || 'No content ideas available'}</p>`);
            return;
        }

        ideas.forEach((idea, idx) => {
            const title = typeof idea === 'string' ? idea : idea.title;
            const desc = typeof idea === 'object' ? idea.description : '';
            const tags = typeof idea === 'object' && idea.tags ? idea.tags : [];
            
            container.append(`
                <div class="idea-item">
                    <div class="idea-number">${idx + 1}</div>
                    <div class="idea-content">
                        <h4>${escapeHtml(title)}</h4>
                        ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
                        ${tags.length > 0 ? `
                            <div class="idea-tags">
                                ${tags.map(t => `<span class="idea-tag">${escapeHtml(t)}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                </div>
            `);
        });
    }

    // ========== IMAGE GALLERY FUNCTIONS ==========

    function renderImageGallery(images, descriptions) {
        const container = $('#image-grid');
        container.empty();
        selectedImages = []; // Reset selection
        updateCompareButton();

        if (!images || images.length === 0) {
            container.html(`<p class="text-muted">No images available</p>`);
            return;
        }

        images.forEach((img, idx) => {
            // Use local path if available, otherwise CDN URL
            const imgSrc = img.localPath ? `file://${img.localPath}` : img.image;
            
            // Get description - handle both old (string array) and new (object array) formats
            let descText = null;
            if (descriptions && descriptions[idx]) {
                descText = typeof descriptions[idx] === 'string' 
                    ? descriptions[idx] 
                    : descriptions[idx].description || null;
            }
            
            // Extract key patterns from description for preview tags
            const patternTags = extractPatternTags(descText);
            
            container.append(`
                <div class="image-item" data-index="${idx}">
                    <span class="rank-badge">#${img.rank}</span>
                    <img class="image-thumb" src="${imgSrc}" alt="Post ${img.rank}" loading="lazy" onerror="this.src='assets/images/placeholder.png'">
                    <div class="image-info">
                        <div class="image-views">
                            <i class="material-icons">visibility</i>
                            <strong>${formatNumber(img.views || 0)}</strong> views
                        </div>
                        ${patternTags.length > 0 ? `
                            <div class="image-patterns">
                                ${patternTags.slice(0, 3).map(tag => `<span class="pattern-tag">${escapeHtml(tag)}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                </div>
            `);
        });
    }

    function extractPatternTags(description) {
        // Handle both string and object formats
        let desc = '';
        if (typeof description === 'string') {
            desc = description.toLowerCase();
        } else if (description && typeof description === 'object' && description.description) {
            desc = description.description.toLowerCase();
        }
        
        if (!desc) return [];
        
        const tags = [];
        
        // Lighting
        if (desc.includes('natural light')) tags.push('Natural Light');
        else if (desc.includes('studio light') || desc.includes('artificial')) tags.push('Studio Light');
        else if (desc.includes('soft light')) tags.push('Soft Light');
        else if (desc.includes('bright') || desc.includes('well-lit')) tags.push('Bright');
        
        // Composition
        if (desc.includes('overhead') || desc.includes('top-down') || desc.includes('bird')) tags.push('Overhead');
        else if (desc.includes('close-up') || desc.includes('closeup')) tags.push('Close-up');
        else if (desc.includes('45') || desc.includes('angle')) tags.push('Angled');
        
        // Style
        if (desc.includes('professional')) tags.push('Professional');
        else if (desc.includes('homemade') || desc.includes('amateur') || desc.includes('casual')) tags.push('Homemade');
        
        // Colors
        if (desc.includes('warm') && (desc.includes('color') || desc.includes('tone'))) tags.push('Warm Tones');
        else if (desc.includes('cool') && (desc.includes('color') || desc.includes('tone'))) tags.push('Cool Tones');
        else if (desc.includes('vibrant') || desc.includes('colorful')) tags.push('Vibrant');
        
        // Props
        if (desc.includes('minimal') || desc.includes('clean')) tags.push('Minimal');
        if (desc.includes('props') || desc.includes('styled')) tags.push('Styled');
        
        return tags;
    }

    function toggleImageSelection(element) {
        const index = element.data('index');
        const isSelected = element.hasClass('selected');
        
        if (isSelected) {
            element.removeClass('selected');
            selectedImages = selectedImages.filter(i => i !== index);
        } else {
            if (selectedImages.length >= 3) {
                showToast('warning', 'You can select up to 3 images for comparison');
                return;
            }
            element.addClass('selected');
            selectedImages.push(index);
        }
        
        updateCompareButton();
    }

    function updateCompareButton() {
        const btn = $('#btn-compare-images');
        if (selectedImages.length >= 2) {
            btn.prop('disabled', false);
            btn.find('span').text(`Compare ${selectedImages.length} Images`);
        } else {
            btn.prop('disabled', true);
            btn.find('span').text('Compare Selected');
        }
    }

    function showImageDetail(index) {
        if (!analysisResults || !analysisResults.postImages) return;
        
        const img = analysisResults.postImages[index];
        if (!img) return;
        
        const imgSrc = img.localPath ? `file://${img.localPath}` : img.image;
        
        // Get description - handle both old (string) and new (object) formats
        const descObj = analysisResults.imageDescriptions && analysisResults.imageDescriptions[index] 
            ? analysisResults.imageDescriptions[index] 
            : null;
        const description = descObj ? (typeof descObj === 'string' ? descObj : descObj.description) : null;
        
        // Set image
        $('#detail-image').attr('src', imgSrc);
        $('#detail-views').text(formatNumber(img.views || 0));
        $('#detail-rank').text(img.rank);
        
        // Build analysis sections from description
        const analysisContainer = $('#detail-analysis');
        analysisContainer.empty();
        
        if (description) {
            // Parse the description into structured analysis
            const analysisData = parseImageAnalysis(description);
            
            analysisData.forEach(section => {
                const fullTextClass = section.isFullText ? ' full-text' : '';
                analysisContainer.append(`
                    <div class="analysis-section${fullTextClass}">
                        <div class="section-header">
                            <i class="material-icons">${section.icon}</i>
                            <span>${escapeHtml(section.title)}</span>
                        </div>
                        <div class="section-content">${section.isFullText ? escapeHtml(section.content) : escapeHtml(section.content)}</div>
                        ${section.tags && section.tags.length > 0 ? `
                            <div class="section-tags">
                                ${section.tags.map(tag => `<span class="section-tag">${escapeHtml(tag)}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                `);
            });
        } else {
            analysisContainer.html('<p class="text-muted">No AI analysis available for this image</p>');
        }
        
        // Reset grid overlay
        $('#composition-grid').hide();
        $('.overlay-btn[data-overlay="grid"]').removeClass('active');
        
        // Show modal
        $('#image-detail-modal').addClass('show');
    }

    function parseImageAnalysis(description) {
        // Parse ultra-detailed AI description into structured sections
        const sections = [];
        const desc = description || '';
        
        // For ultra-detailed descriptions, extract key sections
        
        // Try to find production quality info
        const productionMatch = desc.match(/production[^:]*:?[^.]*\.|professional[^.]*\.|technical[^.]{10,80}\./i);
        if (productionMatch) {
            sections.push({
                icon: 'high_quality',
                title: 'Production Quality',
                content: productionMatch[0].replace(/\*\*/g, '').trim(),
                tags: []
            });
        }
        
        // Try to find lighting info
        const lightingMatch = desc.match(/lighting[^:]*:?[^.]*\.|light[^.]{20,120}\./i);
        if (lightingMatch) {
            sections.push({
                icon: 'wb_sunny',
                title: 'Lighting',
                content: lightingMatch[0].replace(/\*\*/g, '').trim(),
                tags: []
            });
        }
        
        // Try to find camera/perspective info
        const cameraMatch = desc.match(/(camera|angle|perspective|framing|overhead|shot)[^:]*:?[^.]*\./i);
        if (cameraMatch) {
            sections.push({
                icon: 'camera_alt',
                title: 'Camera & Framing',
                content: cameraMatch[0].replace(/\*\*/g, '').trim(),
                tags: []
            });
        }
        
        // Try to find composition info
        const compositionMatch = desc.match(/(composition|rule of thirds|visual flow|negative space)[^:]*:?[^.]*\./i);
        if (compositionMatch) {
            sections.push({
                icon: 'grid_on',
                title: 'Composition',
                content: compositionMatch[0].replace(/\*\*/g, '').trim(),
                tags: []
            });
        }
        
        // Try to find color info
        const colorMatch = desc.match(/(color[^:]*:?|palette|saturation|temperature)[^.]*\./i);
        if (colorMatch) {
            sections.push({
                icon: 'palette',
                title: 'Colors',
                content: colorMatch[0].replace(/\*\*/g, '').trim(),
                tags: []
            });
        }
        
        // Try to find emotional impact
        const emotionMatch = desc.match(/(emotion|emotional|triggers?|aspir|relat)[^:]*:?[^.]*\./i);
        if (emotionMatch) {
            sections.push({
                icon: 'favorite',
                title: 'Emotional Impact',
                content: emotionMatch[0].replace(/\*\*/g, '').trim(),
                tags: []
            });
        }
        
        // Try to find scroll-stopping elements
        const scrollMatch = desc.match(/(scroll|stopping|hook|attention)[^:]*:?[^.]*\./i);
        if (scrollMatch) {
            sections.push({
                icon: 'touch_app',
                title: 'Scroll-Stopping Power',
                content: scrollMatch[0].replace(/\*\*/g, '').trim(),
                tags: []
            });
        }
        
        // If no sections found, show the full description
        if (sections.length === 0) {
            sections.push({
                icon: 'auto_awesome',
                title: 'Full Analysis',
                content: desc.substring(0, 500) + (desc.length > 500 ? '...' : ''),
                tags: extractPatternTags(desc)
            });
        }
        
        // Always add "Full Description" section for ultra-detailed views
        if (desc.length > 300) {
            sections.push({
                icon: 'article',
                title: 'Complete Analysis',
                content: desc,
                tags: [],
                isFullText: true
            });
        }
        
        return sections;
    }

    // ========== AI COMPARISON RENDERING ==========
    function renderAIComparison(comparisonText) {
        const container = $('#ai-comparison-content');
        container.empty();
        
        if (!comparisonText) {
            container.html('<p class="text-muted">No comparison data available</p>');
            return;
        }
        
        // Convert the AI text to HTML with proper formatting
        let html = escapeHtml(comparisonText);
        
        // Convert markdown-style bold (**TEXT**)
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Remove leading colons from lines (AI sometimes outputs ": text")
        html = html.replace(/^\s*:\s*/gm, '');
        
        // Convert section headers (handle various formats)
        html = html.replace(/^(THE WINNING FORMULA|PRODUCTION PATTERNS|LIGHTING SECRETS|CAMERA[^:]*|COMPOSITION[^:]*|COLOR STRATEGY|STYLING BLUEPRINT|SCROLL-STOPPING[^:]*|KEY DIFFERENCES|ACTIONABLE RECOMMENDATIONS)[:\s]*/gmi, 
            '<h4>$1</h4>');
        
        // Also handle bold headers like <strong>HEADER:</strong>
        html = html.replace(/<strong>(THE WINNING FORMULA|PRODUCTION PATTERNS|LIGHTING SECRETS|CAMERA[^<]*|COMPOSITION[^<]*|COLOR[^<]*|STYLING[^<]*|SCROLL[^<]*|KEY DIFFERENCES|ACTIONABLE[^<]*)[:\s]*<\/strong>/gi,
            '<h4>$1</h4>');
        
        // Convert numbered lists
        html = html.replace(/^(\d+)\.\s+/gm, '<span class="list-num">$1.</span> ');
        
        // Convert bullet points
        html = html.replace(/^[-•]\s+/gm, '• ');
        
        // Convert line breaks to paragraphs
        const paragraphs = html.split(/\n\n+/);
        html = paragraphs.map(p => {
            p = p.trim();
            if (!p) return '';
            if (p.startsWith('<h4>')) return p;
            return `<p>${p.replace(/\n/g, '<br>')}</p>`;
        }).join('');
        
        container.html(html);
    }

    function showImageComparison() {
        if (selectedImages.length < 2) return;
        if (!analysisResults || !analysisResults.postImages) return;
        
        const compareBody = $('#compare-body');
        compareBody.empty();
        
        // Build columns for each selected image
        selectedImages.forEach(index => {
            const img = analysisResults.postImages[index];
            if (!img) return;
            
            const imgSrc = img.localPath ? `file://${img.localPath}` : img.image;
            
            // Get description - handle both old (string) and new (object) formats
            const descObj = analysisResults.imageDescriptions && analysisResults.imageDescriptions[index] 
                ? analysisResults.imageDescriptions[index] 
                : null;
            const descText = descObj ? (typeof descObj === 'string' ? descObj : descObj.description) : '';
            
            const patternTags = extractPatternTags(descText);
            
            compareBody.append(`
                <div class="compare-column">
                    <img class="column-image" src="${imgSrc}" alt="Post ${img.rank}" onerror="this.src='assets/images/placeholder.png'">
                    <div class="column-info">
                        <div class="column-rank">
                            <span class="rank-badge">#${img.rank}</span>
                            <span class="views">
                                <i class="material-icons">visibility</i>
                                ${formatNumber(img.views || 0)}
                            </span>
                        </div>
                        <div class="analysis-list">
                            ${patternTags.map(tag => `
                                <div class="analysis-item">
                                    <span class="item-value">${escapeHtml(tag)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `);
        });
        
        // Build comparison summary
        const summaryContainer = $('#compare-summary');
        summaryContainer.empty();
        
        // Find commonalities and differences
        const allTags = selectedImages.map(index => {
            const descObj = analysisResults.imageDescriptions && analysisResults.imageDescriptions[index] 
                ? analysisResults.imageDescriptions[index] 
                : null;
            const descText = descObj ? (typeof descObj === 'string' ? descObj : descObj.description) : '';
            return extractPatternTags(descText);
        });
        
        // Find tags that appear in all images
        const commonTags = allTags.reduce((common, tags, idx) => {
            if (idx === 0) return tags;
            return common.filter(tag => tags.includes(tag));
        }, []);
        
        // Find unique tags per image
        const uniqueTags = allTags.map(tags => 
            tags.filter(tag => !commonTags.includes(tag))
        );
        
        summaryContainer.append(`
            <div class="summary-content">
                <div class="commonalities">
                    <h4><i class="material-icons">check_circle</i> Common Patterns</h4>
                    <ul class="summary-list">
                        ${commonTags.length > 0 
                            ? commonTags.map(tag => `<li><i class="material-icons">check</i> ${escapeHtml(tag)}</li>`).join('')
                            : '<li>No common patterns detected</li>'
                        }
                    </ul>
                </div>
                <div class="differences">
                    <h4><i class="material-icons">compare_arrows</i> Differences</h4>
                    <ul class="summary-list">
                        ${uniqueTags.flat().length > 0 
                            ? [...new Set(uniqueTags.flat())].map(tag => `<li><i class="material-icons">arrow_forward</i> ${escapeHtml(tag)}</li>`).join('')
                            : '<li>Images share similar patterns</li>'
                        }
                    </ul>
                </div>
            </div>
        `);
        
        // Show modal
        $('#image-compare-modal').addClass('show');
    }

    function renderVisualSummary(patterns) {
        const container = $('#visual-summary-content');
        container.empty();
        
        if (!patterns) return;
        
        // Main formula banner
        if (patterns.summary) {
            container.append(`
                <div class="visual-formula-banner">
                    <p>${escapeHtml(patterns.summary)}</p>
                </div>
            `);
        }
        
        // Quick stats grid
        let statsHtml = '<div class="visual-quick-stats">';
        
        if (patterns.lighting && patterns.lighting.winner) {
            statsHtml += `
                <div class="visual-stat-item">
                    <i class="material-icons">wb_sunny</i>
                    <div>
                        <div class="stat-label">Best Lighting</div>
                        <div class="stat-value">${escapeHtml(patterns.lighting.winner)}</div>
                    </div>
                </div>
            `;
        }
        
        if (patterns.cameraWork && patterns.cameraWork.winningAngles) {
            const angles = Array.isArray(patterns.cameraWork.winningAngles) 
                ? patterns.cameraWork.winningAngles.join(', ') 
                : patterns.cameraWork.winningAngles;
            statsHtml += `
                <div class="visual-stat-item">
                    <i class="material-icons">camera_alt</i>
                    <div>
                        <div class="stat-label">Winning Angles</div>
                        <div class="stat-value">${escapeHtml(angles)}</div>
                    </div>
                </div>
            `;
        }
        
        if (patterns.colorPalette && patterns.colorPalette.temperature) {
            statsHtml += `
                <div class="visual-stat-item">
                    <i class="material-icons">palette</i>
                    <div>
                        <div class="stat-label">Color Temperature</div>
                        <div class="stat-value">${escapeHtml(patterns.colorPalette.temperature)}</div>
                    </div>
                </div>
            `;
        }
        
        if (patterns.productionQuality && patterns.productionQuality.winner) {
            statsHtml += `
                <div class="visual-stat-item">
                    <i class="material-icons">high_quality</i>
                    <div>
                        <div class="stat-label">Production Style</div>
                        <div class="stat-value">${escapeHtml(patterns.productionQuality.winner)}</div>
                    </div>
                </div>
            `;
        }
        
        statsHtml += '</div>';
        container.append(statsHtml);
    }

    // ========== EXPORT ==========
    async function exportResults() {
        if (!analysisResults) {
            showToast('error', window.I18n?.t('fb_analytics.errors.no_results') || 'No results to export');
            return;
        }

        try {
            const exportData = {
                exportedAt: new Date().toISOString(),
                totalPosts: analysisResults.totalPosts,
                totalViews: analysisResults.totalViews,
                avgViews: analysisResults.avgViews,
                insights: analysisResults.aiInsights
            };

            const result = await window.electronAPI.showSaveDialog({
                title: 'Export Analytics Report',
                defaultPath: `fb-analytics-${new Date().toISOString().split('T')[0]}.json`,
                filters: [{ name: 'JSON Files', extensions: ['json'] }]
            });

            if (result.canceled || !result.filePath) return;

            await window.electronAPI.saveFile(result.filePath, JSON.stringify(exportData, null, 2));
            showToast('success', window.I18n?.t('fb_analytics.export.success') || 'Report exported successfully');
        } catch (error) {
            console.error('[FB Analytics] Export error:', error);
            showToast('error', window.I18n?.t('fb_analytics.errors.export_failed') || 'Failed to export report');
        }
    }

    // ========== SAVE & LOAD SCANS ==========
    async function loadSavedScans() {
        try {
            const result = await window.electronAPI.getFbAnalyticsScans();
            if (!result.success) {
                console.error('[FB Analytics] Failed to load saved scans:', result.error);
                return;
            }

            const scans = result.scans || [];
            const container = $('#saved-scans-list');
            const badge = $('#scan-count-badge');
            
            badge.text(scans.length);
            
            if (scans.length === 0) {
                container.html(`
                    <div class="no-scans-message" id="no-scans-message">
                        <i class="material-icons">inbox</i>
                        <p data-i18n="fb_analytics.saved_scans.no_scans">${window.I18n?.t('fb_analytics.saved_scans.no_scans') || 'No saved scans yet. Complete an analysis and save it to view later.'}</p>
                    </div>
                `);
                return;
            }

            let html = '';
            for (const scan of scans) {
                const date = new Date(scan.createdAt).toLocaleDateString();
                const pageTypeConfig = PAGE_TYPES[scan.pageType] || PAGE_TYPES.general;
                const imageInfo = scan.hasImageAnalysis ? `<span><i class="material-icons">image</i> ${scan.imageCount}</span>` : '';
                
                html += `
                    <div class="saved-scan-item" data-scan-id="${scan.id}">
                        <div class="scan-icon">
                            <i class="material-icons">${pageTypeConfig.icon}</i>
                        </div>
                        <div class="scan-info">
                            <div class="scan-name">${escapeHtml(scan.name)}</div>
                            <div class="scan-meta">
                                <span><i class="material-icons">calendar_today</i> ${date}</span>
                                <span><i class="material-icons">article</i> ${scan.totalPosts} posts</span>
                                <span><i class="material-icons">visibility</i> ${formatNumber(scan.totalViews)} views</span>
                                ${imageInfo}
                            </div>
                        </div>
                        <div class="scan-actions">
                            <button class="btn-load-scan" data-scan-id="${scan.id}">
                                <i class="material-icons">open_in_new</i>
                                <span data-i18n="fb_analytics.saved_scans.load">${window.I18n?.t('fb_analytics.saved_scans.load') || 'Load'}</span>
                            </button>
                            <button class="btn-delete-scan" data-scan-id="${scan.id}">
                                <i class="material-icons">delete</i>
                            </button>
                        </div>
                    </div>
                `;
            }
            container.html(html);
        } catch (error) {
            console.error('[FB Analytics] Error loading saved scans:', error);
        }
    }

    /**
     * Auto-save scan after analysis completes
     */
    async function autoSaveScan() {
        if (!analysisResults) {
            console.log('[FB Analytics] No results to auto-save');
            return;
        }

        try {
            // Generate default name based on page type and date
            const defaultName = `${PAGE_TYPES[analysisResults.pageType || 'general'].title} - ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`;

            const scanData = {
                name: defaultName,
                posts: analysisResults.posts || csvPosts,
                images: analysisResults.postImages || [],
                imageDescriptions: analysisResults.imageDescriptions || [],
                imageComparison: analysisResults.imageComparison || null,
                aiInsights: analysisResults.aiInsights,
                pageType: analysisResults.pageType || selectedPageType,
                provider: selectedProvider,
                model: selectedModel,
                totalPosts: analysisResults.totalPosts,
                totalViews: analysisResults.totalViews,
                avgViews: analysisResults.avgViews
            };

            const result = await window.electronAPI.saveFbAnalyticsScan(scanData);
            
            if (result.success) {
                // Update currentScanId to the saved scan ID for chat persistence
                if (result.scanId) {
                    currentScanId = result.scanId;
                }
                console.log('[FB Analytics] Auto-saved scan:', defaultName);
                await loadSavedScans(); // Refresh list
            } else {
                console.error('[FB Analytics] Auto-save failed:', result.error);
            }
        } catch (error) {
            console.error('[FB Analytics] Auto-save error:', error);
        }
    }

    function showSaveScanModal() {
        if (!analysisResults) {
            showToast('error', window.I18n?.t('fb_analytics.errors.no_results') || 'No results to save');
            return;
        }

        // Set default name
        const defaultName = `${PAGE_TYPES[analysisResults.pageType || 'general'].title} - ${new Date().toLocaleDateString()}`;
        $('#save-scan-name').val(defaultName);
        
        // Show modal
        $('#save-scan-modal').addClass('show');
        
        // Focus input
        setTimeout(() => $('#save-scan-name').focus().select(), 100);
    }

    async function confirmSaveScan() {
        const name = $('#save-scan-name').val();
        
        if (!name || !name.trim()) {
            showToast('warning', window.I18n?.t('fb_analytics.saved_scans.name_required') || 'Please enter a name');
            $('#save-scan-name').focus();
            return;
        }

        // Close modal
        $('#save-scan-modal').removeClass('show');

        try {
            $('#btn-save-scan').prop('disabled', true).html('<i class="material-icons spin">sync</i> Saving...');

            const scanData = {
                name: name.trim(),
                posts: analysisResults.posts || csvPosts,
                images: analysisResults.postImages || [],
                imageDescriptions: analysisResults.imageDescriptions || [],
                imageComparison: analysisResults.imageComparison || null,
                aiInsights: analysisResults.aiInsights,
                pageType: analysisResults.pageType || selectedPageType,
                provider: selectedProvider,
                model: selectedModel,
                totalPosts: analysisResults.totalPosts,
                totalViews: analysisResults.totalViews,
                avgViews: analysisResults.avgViews
            };

            const result = await window.electronAPI.saveFbAnalyticsScan(scanData);
            
            if (result.success) {
                // Update currentScanId to the saved scan ID for chat persistence
                if (result.scanId) {
                    currentScanId = result.scanId;
                }
                showToast('success', window.I18n?.t('fb_analytics.saved_scans.saved_success') || `Scan saved with ${result.imageCount} images`);
                await loadSavedScans(); // Refresh list
            } else {
                showToast('error', result.error || 'Failed to save scan');
            }
        } catch (error) {
            console.error('[FB Analytics] Save scan error:', error);
            showToast('error', window.I18n?.t('fb_analytics.errors.save_failed') || 'Failed to save scan');
        } finally {
            $('#btn-save-scan').prop('disabled', false).html('<i class="material-icons">save</i> <span data-i18n="fb_analytics.results.save_scan">Save Scan</span>');
        }
    }

    async function loadScan(scanId) {
        try {
            const result = await window.electronAPI.loadFbAnalyticsScan(scanId);
            
            if (!result.success) {
                showToast('error', result.error || 'Failed to load scan');
                return;
            }

            const scan = result.scan;

            // Set current scan ID for chat persistence
            currentScanId = scanId;
            
            // Reset chat state for new scan
            currentConversationId = null;
            chatMessages = [];

            // Restore state
            csvPosts = scan.posts || [];
            selectedPageType = scan.pageType || 'general';
            selectedProvider = scan.provider;
            selectedModel = scan.model;

            // Rebuild postImages from saved images (with local paths)
            const postImages = (scan.images || []).filter(img => img.exists).map(img => ({
                rank: img.rank,
                views: img.views,
                description: img.description,
                localPath: img.localPath,
                image: `file://${img.localPath}` // For display
            }));

            // Restore analysisResults
            analysisResults = {
                posts: scan.posts,
                totalPosts: scan.totalPosts,
                totalViews: scan.totalViews,
                avgViews: scan.avgViews,
                pageType: scan.pageType,
                hasImageAnalysis: postImages.length > 0,
                postImages: postImages,
                imageDescriptions: scan.imageDescriptions || [],
                imageComparison: scan.imageComparison || null,
                aiInsights: scan.aiInsights,
                analyzedAt: scan.createdAt,
                isLoadedScan: true // Flag to indicate this is a loaded scan
            };

            // Show results
            showResults();

        } catch (error) {
            console.error('[FB Analytics] Load scan error:', error);
            showToast('error', window.I18n?.t('fb_analytics.errors.load_failed') || 'Failed to load scan');
        }
    }

    async function deleteScan(scanId) {
        const confirmed = await confirmPrompt(window.I18n?.t('fb_analytics.saved_scans.delete_confirm') || 'Are you sure you want to delete this scan?');
        if (!confirmed) return;

        try {
            const result = await window.electronAPI.deleteFbAnalyticsScan(scanId);
            
            if (result.success) {
                showToast('success', window.I18n?.t('fb_analytics.saved_scans.deleted') || 'Scan deleted');
                await loadSavedScans(); // Refresh list
            } else {
                showToast('error', result.error || 'Failed to delete scan');
            }
        } catch (error) {
            console.error('[FB Analytics] Delete scan error:', error);
            showToast('error', window.I18n?.t('fb_analytics.errors.delete_failed') || 'Failed to delete scan');
        }
    }

    // ========== NAVIGATION ==========
    function resetToStep1() {
        $('#fb-analytics-step1').show();
        $('#fb-analytics-step2').hide();
        $('#fb-analytics-step3').hide();
        isAnalyzing = false;
        analysisCancelled = false;
        
        // Hide chat FAB when going back to step 1
        hideChatFab();
        
        // Reset chat state
        currentScanId = null;
        currentConversationId = null;
        chatMessages = [];
        generatedTitles = []; // Reset tracked titles for new analysis
    }

    // ========== AUTOMATION GENERATION ==========
    async function generateAutomation() {
        if (!analysisResults || !analysisResults.aiInsights) {
            showToast('error', window.I18n?.t('fb_analytics.automation.no_results') || 'No analysis results available');
            return;
        }

        try {
            const textProvider = $('#auto-text-provider').val();
            const imageProvider = $('#auto-image-provider').val();
            const pageType = analysisResults.pageType || 'general';
            const nicheConfig = PAGE_TYPES[pageType] || PAGE_TYPES.general;
            const insights = analysisResults.aiInsights;

        // =====================================================
        // BUILD DETAILED PROMPTS FROM ANALYTICS INSIGHTS
        // =====================================================

        // Extract winning patterns
        const winningKeywords = (insights.winningKeywords || []).slice(0, 15).map(k => typeof k === 'string' ? k : k.keyword).join(', ');
        const hookPatterns = (insights.hookPatterns || []).slice(0, 5).map(h => `"${h.example || h}"`).join('\n- ');
        const contentStructure = insights.contentStructure || {};
        const triggers = (insights.psychologicalTriggers || []).slice(0, 5).map(t => `${t.name || t.type}: ${t.description || ''}`).join('\n- ');
        const doMore = (insights.doMore || []).slice(0, 5).map(d => `${d.title}: ${d.description || ''}`).join('\n- ');
        const avoid = (insights.avoid || []).slice(0, 3).map(a => a.title || a).join(', ');

        // Extract visual patterns if available
        const visualPatterns = insights.visualPatterns || {};
        let visualInsights = '';
        if (typeof visualPatterns === 'object' && visualPatterns.summary) {
            visualInsights = `
VISUAL PATTERNS THAT WORK:
- Winning Formula: ${visualPatterns.summary || 'Professional food photography style'}
- Production: ${visualPatterns.productionQuality?.winner || 'Semi-professional, authentic feel'}
- Lighting: ${visualPatterns.lighting?.winner || 'Natural daylight preferred'}
- Camera Angles: ${Array.isArray(visualPatterns.cameraWork?.winningAngles) ? visualPatterns.cameraWork.winningAngles.join(', ') : 'Overhead, 45-degree angle'}
- Colors: ${Array.isArray(visualPatterns.colorPalette?.dominantColors) ? visualPatterns.colorPalette.dominantColors.join(', ') : 'Warm, vibrant colors'}
- Styling: ${visualPatterns.styling?.backgroundStyle || 'Clean, minimal background'}, ${visualPatterns.styling?.clutterLevel || 'minimalist'}
- Scroll Stoppers: ${visualPatterns.scrollStoppers?.slice(0, 2).map(s => s.element).join(', ') || 'Bold colors, appetizing presentation'}`;
        }

        // =====================================================
        // BUILD ULTRA-DETAILED VISUAL INSIGHTS FROM IMAGE ANALYSIS
        // =====================================================
        
        // Get detailed image descriptions from analysis
        const imageDescriptions = analysisResults.imageDescriptions || [];
        let detailedVisualAnalysis = '';
        
        if (imageDescriptions.length > 0) {
            // Extract key patterns from all analyzed images
            const topImageDescriptions = imageDescriptions.slice(0, 5).map((desc, idx) => {
                const descText = typeof desc === 'string' ? desc : desc.description || '';
                return `IMAGE #${idx + 1}:\n${descText.substring(0, 800)}`;
            }).join('\n\n');
            
            detailedVisualAnalysis = `
=== ULTRA-DETAILED VISUAL ANALYSIS FROM TOP PERFORMING IMAGES ===

${topImageDescriptions}
`;
        }
        
        // Get the AI comparison (automatic synthesis of all images)
        const imageComparison = analysisResults.imageComparison || '';
        let aiComparisonInsights = '';
        
        if (imageComparison) {
            aiComparisonInsights = `
=== AI-SYNTHESIZED WINNING VISUAL FORMULA ===

${imageComparison.substring(0, 2000)}
`;
        }

        // Create the TEXT GENERATION prompt (Node 2 - generates the Facebook post)
        const textGenPrompt = `You are an expert viral Facebook content writer specializing in ${nicheConfig.title.replace(' Insights', '')} content.

=== LANGUAGE REQUIREMENT ===
CRITICAL: You MUST write your output in the SAME LANGUAGE as the input topic/title provided. If the input is in French, write in French. If in Arabic, write in Arabic. If in Spanish, write in Spanish. Match the input language exactly.

=== FACEBOOK COMMUNITY STANDARDS COMPLIANCE ===
**MANDATORY: Your content MUST fully comply with Facebook's Community Standards and Advertising Policies:**

NEVER include or imply:
- Health claims (no "cures", "treats disease", "weight loss guaranteed", "miracle results")
- Get-rich-quick schemes or unrealistic financial promises
- Before/after transformation claims (especially for health, weight, appearance)
- Sensationalized or misleading headlines (no "Doctors HATE this", "They don't want you to know")
- Content that could be seen as harassment, hate speech, or discrimination
- Dangerous misinformation about health, safety, or current events
- Exaggerated or false claims about products or services
- Content exploiting sensitive topics (tragedy, health crises, fears)
- Adult content, violence, or graphic imagery references
- Personal attributes targeting (age, health conditions, financial status)
- Clickbait or engagement bait ("Tag someone who...", "Share if you agree", "Type YES to...")
- Spam tactics or repetitive posting patterns
- Fake urgency or scarcity ("Only 10 left!", "Ends tonight!" when not true)
- Misleading thumbnails or content that doesn't match the post

ALWAYS:
- Be authentic and honest in claims
- Use aspirational language without false promises ("Discover", "Explore", "Try" instead of "guaranteed", "proven", "will make you")
- Focus on benefits without medical/health claims
- Keep content positive and constructive
- Respect user privacy and dignity
- Provide genuine value to the reader

=== CRITICAL: COMPLETE CONTENT REQUIREMENT ===
**ABSOLUTELY MANDATORY - THIS IS THE MOST IMPORTANT RULE:**

You MUST provide COMPLETE, FULL content in the post itself. NEVER use teaser tactics that redirect users elsewhere.

STRICTLY FORBIDDEN phrases and tactics:
- "Full recipe in the comments"
- "Link in bio"
- "Check the comments for..."
- "DM me for the full..."
- "See more in the description"
- "Full details below"
- "Comment [word] to get..."
- "Full tutorial in comments"
- "Ingredients/Steps in first comment"
- Any variation that withholds the main content

FOR RECIPES: Include the COMPLETE recipe with ALL ingredients and ALL steps directly in the post
FOR TUTORIALS: Include ALL steps and instructions in the post
FOR TIPS/ADVICE: Provide the FULL valuable information, not just a teaser
FOR LISTS: Include the COMPLETE list, not "See full list in comments"

The post MUST be self-contained and provide full value without requiring the user to look elsewhere.
If the content is too long, prioritize the most essential information but NEVER use "see comments" tactics.

=== WINNING PATTERNS FROM DATA ANALYSIS ===

TOP PERFORMING KEYWORDS (use naturally):
${winningKeywords || 'delicious, easy, quick, homemade, viral'}

HOOK PATTERNS THAT WORK:
- ${hookPatterns || '"This recipe broke the internet" | "You won\'t believe how easy..."'}

CONTENT STRUCTURE:
- Optimal Length: ${contentStructure.optimalLength || '150-500 characters, extend as needed for complete content'}
- Emoji Usage: ${contentStructure.emojiUsage || 'Use 3-5 relevant emojis, especially at start and end'}
- CTA Style: ${contentStructure.ctaStyle || 'Invite genuine interaction: "What do you think?", "Have you tried this?", "Save for later!" (NO engagement bait)'}
- Format: ${contentStructure.format || 'Short punchy sentences, line breaks for readability'}

PSYCHOLOGICAL TRIGGERS TO USE:
- ${triggers || 'Curiosity: Create intrigue | Urgency: Limited time feel | Social Proof: Everyone loves it'}

WHAT TO DO MORE:
- ${doMore || 'Start with strong hooks | Use power words | Include benefits'}

WHAT TO AVOID:
${avoid || 'Long paragraphs, no emojis, boring intros'}

=== YOUR TASK ===

INPUT: {INPUT_2}

Take this topic/title and write a VIRAL Facebook post applying ALL the winning patterns above while STRICTLY following Facebook's Community Standards.

REQUIREMENTS:
1. Start with a proven hook pattern (compliant version - no clickbait or misleading claims)
2. Include winning keywords naturally
3. Use the optimal emoji strategy
4. Keep the ideal length (but extend if needed to include FULL content)
5. End with an engaging CTA (compliant - no "comment to get", "link in bio", etc.)
6. Make it scroll-stopping and shareable
7. Write in the SAME LANGUAGE as the input
8. ENSURE 100% compliance with Facebook policies - NO health claims, NO false promises, NO sensationalism
9. **CRITICAL: Include COMPLETE content** - For recipes: ALL ingredients + ALL steps. For tutorials: ALL instructions. NEVER use "full recipe/details in comments" tactics.
10. The post must provide FULL VALUE standalone - readers should get everything they need without looking elsewhere

Output ONLY the post text. No explanations, no quotes, no labels.`;

        // Create the IMAGE PROMPT GENERATOR prompt (Node 3 - generates Midjourney/GPT prompt)
        // This includes ALL the visual insights learned from analyzing the top-performing images
        const imagePromptGenPrompt = `You are an expert at creating viral social media image prompts. Your job is to create image prompts that EXACTLY replicate the visual style of proven top-performing content.

=== FACEBOOK CONTENT POLICY COMPLIANCE ===
**MANDATORY: Generated images MUST comply with Facebook's Community Standards:**

NEVER create prompts that could generate:
- Before/after weight loss or body transformation imagery
- Exaggerated or unrealistic body proportions
- Medical or health treatment imagery
- Violent, gory, or disturbing content
- Sexually suggestive or adult content
- Misleading or manipulated imagery (fake news style)
- Content exploiting tragedy, fear, or suffering
- Imagery that could be seen as discriminatory
- Fake testimonials or unrealistic results
- "Shocking" or sensationalized visual content

ALWAYS create prompts for:
- Authentic, natural-looking content
- Positive, aspirational imagery
- High-quality lifestyle photography
- Real, relatable scenarios
- Tasteful and family-friendly visuals

${visualInsights}
${detailedVisualAnalysis}
${aiComparisonInsights}

=== CRITICAL: APPLY THESE EXACT VISUAL PATTERNS ===

Based on the analysis above, you MUST incorporate:
1. **LIGHTING**: Use the EXACT lighting style that works (natural daylight, soft diffused, golden hour, etc.)
2. **CAMERA ANGLE**: Use the WINNING angles (overhead flat-lay, 45-degree hero shot, eye-level, etc.)
3. **COLOR PALETTE**: Match the proven color temperature and saturation (warm/cool, vibrant/muted)
4. **COMPOSITION**: Apply the composition techniques that drive engagement
5. **STYLING**: Match the background style, props usage, and clutter level that performs best
6. **PRODUCTION QUALITY**: Match the exact production level (professional polish vs authentic homemade feel)
7. **SCROLL-STOPPING ELEMENTS**: Include the specific visual hooks that make people stop scrolling
${imageProvider === 'midjourney' ? `
=== CRITICAL: ABSOLUTELY NO TEXT IN THE IMAGE ===
**THIS IS THE MOST IMPORTANT RULE - ZERO TOLERANCE FOR TEXT**

Midjourney CANNOT render text properly and will create ugly, garbled, unreadable characters.

You MUST:
- NEVER mention any text, writing, words, letters, numbers, titles, captions, labels, watermarks, or typography in your prompt
- NEVER describe signage, menus, recipe cards, ingredient lists, or any written content
- NEVER use phrases like "with text overlay", "featuring a caption", "with the title", etc.
- Focus 100% on VISUAL elements only: colors, lighting, composition, subjects, props, backgrounds, textures, mood

Even if the analyzed images had text overlays - IGNORE THEM COMPLETELY. Describe only the visual/photographic elements.` : ''}

=== YOUR TASK ===

INPUT: {INPUT_2}

Based on this Facebook post text, create a detailed image generation prompt that REPLICATES the exact visual formula of the top-performing analyzed images.

REQUIREMENTS:
1. The image MUST match the winning visual patterns from the analysis
2. Include SPECIFIC details about lighting direction, quality, and mood
3. Specify the EXACT camera angle and framing from winning patterns
4. Use the PROVEN color palette (list specific colors)
5. Describe the styling, background, and props that work
6. Make it scroll-stopping using the identified visual hooks
7. Focus on ${pageType === 'recipe' ? 'food photography' : pageType === 'fitness' ? 'fitness photography' : pageType === 'fashion' ? 'fashion photography' : 'lifestyle photography'} style

OUTPUT FORMAT:
Write ONLY the image description prompt. ${imageProvider === 'midjourney' ? 'Do NOT include any Midjourney parameters like --ar, --v, --style, etc. Just the pure visual description.' : ''}
${imageProvider === 'midjourney' ? 'REMEMBER: Absolutely NO text, words, writing, letters, numbers, captions, titles, labels, or any written content. Pure visual elements only.' : 'If you include any text/typography in the image, write it in the SAME LANGUAGE as the input Facebook post text.'}

CRITICAL: Do NOT wrap your output in quotation marks. Start directly with the description (e.g., start with "A refreshing..." not with quotes around it). No quotes at the beginning or end.

Be EXTREMELY specific with visual details. Instead of "good lighting", say "soft natural daylight from a large window on the left, creating gentle shadows".

Example of correct output (notice NO quotes wrapping the entire prompt):
A delicious breakfast scene photographed from a 45-degree angle, soft natural daylight from a large window, warm golden and cream color scheme, rustic wooden table background, rule of thirds composition, fresh ingredients as props, cozy morning atmosphere, professional food photography, 8K resolution`;

        // Get model based on provider
        const textModels = {
            openai: 'gpt-5-nano',
            anthropic: 'claude-sonnet-4-20250514',
            googleai: 'gemini-2.0-flash',
            openrouter: 'openai/gpt-5-nano'
        };

        // Helper to generate node HTML
        function getNodeHtml(inputs, outputs, text, title) {
            const inputHTML = inputs.map(elm => `<span>${elm}</span>`).join('');
            const outputHTML = outputs.map(elm => `<span>${elm}</span>`).join('');
            return `<div class="node-content">
                <div class="left">${inputHTML}</div>
                <div class="center">
                    <span>${title}</span>
                    <strong class="editable-text" tabindex="0" 
                        ondblclick="this.setAttribute('contenteditable', 'true'); this.focus();" 
                        onblur="this.removeAttribute('contenteditable');">
                        ${text}
                    </strong>
                </div>
                <div class="right">${outputHTML}</div>
            </div>`;
        }

        // Get image provider display info
        const imageProviderTitle = imageProvider === 'gptimage' ? 'GPT Image' : 
                                   imageProvider === 'chatgptimage' ? 'ChatGPT Image' :
                                   imageProvider === 'googleaiimage' ? 'Google Imagen' : 'Midjourney';
        
        // Check if this provider outputs multiple images (only Midjourney does)
        const outputsMultipleImages = imageProvider === 'midjourney';
        
        // Text provider display info  
        const textProviderTitle = textProvider === 'openai' ? 'OpenAI' : 
                                  textProvider === 'anthropic' ? 'Anthropic' :
                                  textProvider === 'googleai' ? 'Google AI' : 'OpenRouter';

        // =====================================================
        // BUILD PROPER WORKFLOW CHAIN:
        // 1. Input -> 2. Text Gen AI -> 3. Image Prompt AI -> 4. Image Gen -> 5. Variables -> 6. FB Output
        // =====================================================

        const drawflowData = {
            drawflow: {
                Home: {
                    data: {
                        // NODE 1: Input
                        "1": {
                            id: 1,
                            name: "input",
                            class: "unhideable",
                            pos_x: 50,
                            pos_y: 300,
                            typenode: false,
                            inputs: {},
                            outputs: {
                                output_1: { connections: [] },
                                output_2: { connections: [{ node: "2", output: "input_2" }] }
                            },
                            data: {
                                type: "input",
                                inputs: [],
                                inputTypes: [],
                                outputTypes: ["image", "text"],
                                text: "Input"
                            },
                            html: getNodeHtml([], ['Image', 'Text'], 'Topic/Title', 'Input')
                        },
                        
                        // NODE 2: Text Generation AI (generates Facebook post text)
                        "2": {
                            id: 2,
                            name: textProvider,
                            class: `node-${generateRandomId(6)}`,
                            pos_x: 450,
                            pos_y: 150,
                            typenode: false,
                            inputs: {
                                input_1: { connections: [] },
                                input_2: { connections: [{ node: "1", input: "output_2" }] }
                            },
                            outputs: {
                                output_1: { connections: [
                                    { node: "3", output: "input_2" },
                                    { node: "6", output: "input_2" }  // Also connect to FB output text
                                ]}
                            },
                            data: {
                                type: textProvider,
                                inputs: buildTextAIInputs(textProvider, textGenPrompt, textModels[textProvider]),
                                inputTypes: ["url", "text"],
                                outputTypes: ["text"],
                                text: "Text Generator"
                            },
                            html: getNodeHtml(['Image Url', 'Text'], ['Text'], 'Post Text', textProviderTitle)
                        },
                        
                        // NODE 3: Image Prompt Generator AI (generates image prompt from post text)
                        "3": {
                            id: 3,
                            name: textProvider,
                            class: `node-${generateRandomId(6)}`,
                            pos_x: 850,
                            pos_y: 150,
                            typenode: false,
                            inputs: {
                                input_1: { connections: [] },
                                input_2: { connections: [{ node: "2", input: "output_1" }] }
                            },
                            outputs: {
                                output_1: { connections: [{ node: "4", output: imageProvider === 'gptimage' ? "input_1" : "input_2" }] }
                            },
                            data: {
                                type: textProvider,
                                inputs: buildTextAIInputs(textProvider, imagePromptGenPrompt, textModels[textProvider]),
                                inputTypes: ["url", "text"],
                                outputTypes: ["text"],
                                text: "Image Prompt"
                            },
                            html: getNodeHtml(['Image Url', 'Text'], ['Text'], 'Img Prompt', textProviderTitle)
                        },
                        
                        // NODE 4: Image Generation (Midjourney, ChatGPT Image, GPT Image, or Google Imagen)
                        "4": {
                            id: 4,
                            name: imageProvider,
                            class: `node-${generateRandomId(6)}`,
                            pos_x: 1250,
                            pos_y: 300,
                            typenode: false,
                            // Match input structure from automation.js
                            // midjourney & chatgptimage: 2 inputs (image/url + text)
                            // gptimage & googleaiimage: 1 input (text only)
                            inputs: (imageProvider === 'gptimage' || imageProvider === 'googleaiimage')
                                ? { input_1: { connections: [{ node: "3", input: "output_1" }] } }
                                : {
                                    input_1: { connections: [] },  // Image input (optional)
                                    input_2: { connections: [{ node: "3", input: "output_1" }] }  // Text/Prompt input
                                },
                            outputs: {
                                // For multi-image providers (Midjourney), connect to Variables node (5)
                                // For single-image providers, connect directly to Facebook output (5, renumbered)
                                output_1: { connections: [{ node: outputsMultipleImages ? "5" : "5", output: "input_1" }] }
                            },
                            data: {
                                type: imageProvider,
                                inputs: buildImageGenInputs(imageProvider),
                                // Match inputTypes from automation.js
                                inputTypes: imageProvider === 'midjourney' ? ["url", "text"] : 
                                            imageProvider === 'chatgptimage' ? ["image", "text"] : ["text"],
                                outputTypes: imageProvider === 'midjourney' ? ["images"] : ["image"],
                                text: "Image Gen"
                            },
                            // Match HTML labels from automation.js
                            html: getNodeHtml(
                                imageProvider === 'midjourney' ? ['Image url', 'Text'] : 
                                imageProvider === 'chatgptimage' ? ['Image', 'Text'] : ['Text Input'], 
                                imageProvider === 'midjourney' ? ['4 Images'] : ['Image'], 
                                'Generate', 
                                imageProviderTitle
                            )
                        },
                        
                        // NODE 5: Variables (extract first image from array) - ONLY for multi-image providers
                        // OR NODE 5: Facebook Output - for single-image providers
                        ...(outputsMultipleImages ? {
                            "5": {
                                id: 5,
                                name: "variables",
                                class: `node-${generateRandomId(6)}`,
                                pos_x: 1650,
                                pos_y: 400,
                                typenode: false,
                                inputs: {
                                    input_1: { connections: [{ node: "4", input: "output_1" }] }
                                },
                                outputs: {
                                    output_1: { connections: [{ node: "6", output: "input_1" }] }
                                },
                                data: {
                                    type: "variables",
                                    inputs: [
                                        { type: "textarea", title: "Value", value: "{INPUT_1}[0]" }
                                    ],
                                    inputTypes: ["any"],
                                    outputTypes: ["any"],
                                    text: "First Image"
                                },
                                html: getNodeHtml(['Input'], ['Output'], 'First Img', 'Variables')
                            },
                            "6": {
                                id: 6,
                                name: "output",
                                class: "unhideable",
                                pos_x: 2050,
                                pos_y: 300,
                                typenode: false,
                                inputs: {
                                    input_1: { connections: [{ node: "5", input: "output_1" }] },  // Image from Variables
                                    input_2: { connections: [{ node: "2", input: "output_1" }] }   // Text from Text Gen
                                },
                                outputs: {},
                                data: {
                                    type: "facebook-output",
                                    inputs: [],
                                    inputTypes: ["image", "text"],
                                    outputTypes: [],
                                    text: "Facebook"
                                },
                                html: `<div class="node-content" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 10px; margin-left: 10px;">
                            <span>Image</span>
                            <span>Text</span>
                        </div>
                        <div class="flex-center ms-3">   
                            <img class="me-2" width="20" src="assets/images/icons/facebook-colored.png">
                            <span>Facebook</span>
                        </div>
                    </div>`
                            }
                        } : {
                            // Single-image providers: NODE 5 is Facebook Output (no Variables node needed)
                            "5": {
                                id: 5,
                                name: "output",
                                class: "unhideable",
                                pos_x: 1650,
                                pos_y: 300,
                                typenode: false,
                                inputs: {
                                    input_1: { connections: [{ node: "4", input: "output_1" }] },  // Image directly from Image Gen
                                    input_2: { connections: [{ node: "2", input: "output_1" }] }   // Text from Text Gen
                                },
                                outputs: {},
                                data: {
                                    type: "facebook-output",
                                    inputs: [],
                                    inputTypes: ["image", "text"],
                                    outputTypes: [],
                                    text: "Facebook"
                                },
                                html: `<div class="node-content" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; flex-direction: column; gap: 10px; margin-left: 10px;">
                            <span>Image</span>
                            <span>Text</span>
                        </div>
                        <div class="flex-center ms-3">   
                            <img class="me-2" width="20" src="assets/images/icons/facebook-colored.png">
                            <span>Facebook</span>
                        </div>
                    </div>`
                            }
                        })
                    }
                }
            }
        };
        
        // Generate automation name
        const automationName = `FB Analytics - ${imageProviderTitle} - ${new Date().toLocaleString()}`;
        const automationId = generateRandomId(10);
        const timestampInSeconds = Math.floor(Date.now() / 1000);
        
        // Get existing automations and add the new one
        const automations = await window.electronAPI.readKey("automations") || [];
        automations.push({
            label: automationName,
            id: automationId,
            data: drawflowData,
            status: "inactive",
            time: timestampInSeconds
        });
        
        await window.electronAPI.updateData("automations", automations);
        
        showToast('success', window.I18n?.t('fb_analytics.automation_created') || 'Automation created successfully!');
        
        // Store the automation ID for the automation page to open it
        window.pendingAutomationSelection = automationId;
        
        // Navigate to automation page after a short delay
        setTimeout(() => {
            $('a.menu-element[href="#automation"]').trigger('click');
        }, 500);
        
    } catch (error) {
        console.error('[FB-ANALYTICS] Error generating automation:', error);
        showToast('error', window.I18n?.t('fb_analytics.automation_error') || 'Error generating automation');
    }
}

    function generateRandomId(length) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    function buildTextAIInputs(provider, prompt, model) {
        const inputs = [
            { type: "textarea", title: "Prompt", value: prompt },
            { type: "range", title: "Temperature", value: 0.8, min: 0, max: provider === 'anthropic' ? 1 : 2 }
        ];

        if (provider === 'openai') {
            inputs.push({
                type: "select",
                title: "Model",
                value: model,
                options: [
                    { value: "gpt-5-nano", text: "GPT-5 Nano" }
                ]
            });
        } else if (provider === 'anthropic') {
            inputs.push({
                type: "select",
                title: "Model",
                value: model,
                options: [
                    { value: "claude-sonnet-4-20250514", text: "Claude Sonnet 4" },
                    { value: "claude-3-5-sonnet-20241022", text: "Claude 3.5 Sonnet" },
                    { value: "claude-3-haiku-20240307", text: "Claude 3 Haiku" }
                ]
            });
            inputs.push({ type: "input", title: "Max Tokens", value: "4096" });
        } else if (provider === 'googleai') {
            inputs.push({
                type: "select",
                title: "Model",
                value: model,
                options: [
                    { value: "gemini-2.0-flash", text: "Gemini 2.0 Flash" },
                    { value: "gemini-1.5-flash", text: "Gemini 1.5 Flash" },
                    { value: "gemini-1.5-pro", text: "Gemini 1.5 Pro" }
                ]
            });
            inputs.push({ type: "input", title: "Max Tokens", value: "4096" });
        } else if (provider === 'openrouter') {
            inputs.push({
                type: "select",
                title: "Model",
                value: model,
                options: [
                    { value: "openai/gpt-5-nano", text: "GPT-5 Nano" },
                    { value: "anthropic/claude-3.5-sonnet", text: "Claude 3.5 Sonnet" },
                    { value: "google/gemini-pro-1.5", text: "Gemini 1.5 Pro" }
                ]
            });
            inputs.push({ type: "input", title: "Max Tokens", value: "4096" });
        }

        return inputs;
    }

    function buildImageGenInputs(provider) {
        if (provider === 'gptimage') {
            // Match automation.js gptimage node exactly
            return [
                { type: "textarea", title: "Prompt", value: "{INPUT_1}", placeholder: "Describe the image to generate..." },
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
                    value: "1024x1536",
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
            ];
        } else if (provider === 'chatgptimage') {
            // Match automation.js chatgptimage node exactly - only has Prompt
            // Uses {INPUT_2} because input_1 is Image, input_2 is Text
            return [
                { type: "textarea", title: "Prompt", value: "{INPUT_2}", placeholder: "Prompt : " }
            ];
        } else if (provider === 'googleaiimage') {
            // Match automation.js googleaiimage node exactly
            return [
                { type: "textarea", title: "Prompt", value: "{INPUT_1}", placeholder: "Describe the image to generate..." },
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
            ];
        } else if (provider === 'midjourney') {
            // Midjourney - prompt from input + parameters appended
            // --no prevents Midjourney from generating any text/writing in the image
            return [
                { type: "textarea", title: "Prompt", value: "{INPUT_2} --no text, words, letters, typography, captions, watermark, writing, inscriptions, labels, titles, subtitles, signatures, logos, fonts, characters, numbers, symbols, quotes --ar 4:5 --v 6.1 --style raw", placeholder: "Prompt : " }
            ];
        }
        return [];
    }

    // ========== UTILITIES ==========
    function formatNumber(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toString();
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function showToast(type, message) {
        // Use global showAlert if available, otherwise console.log
        if (typeof showAlert === 'function') {
            showAlert(type, message);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    // ========== CLEANUP ==========
    $(window).on('beforeunload' + NS, function() {
        $(document).off(NS);
        $(window).off(NS);
        // Remove chat streaming listener
        window.electronAPI.removeFbAnalyticsChatChunkListener();
        // Hide chat FAB
        hideChatFab();
    });

    // ========== START ==========
    init();
});
