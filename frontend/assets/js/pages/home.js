$(document).ready(async function () {

    // Namespace for event cleanup
    const NS = '.homePage';

    // Clear any existing home page events from previous loads
    $(document).off(NS);

    // Clear any existing home page intervals from previous loads
    if (window.homePageIntervals) {
        window.homePageIntervals.forEach(id => clearInterval(id));
    }
    window.homePageIntervals = [];

    // Track previous values to avoid unnecessary animations
    let previousValues = {
        automations: null,
        minicanvas: null,
        spyposts: null,
        workflows: null
    };

    // Track displayed article IDs - persist in window to survive page navigations
    // Also track ALL seen articles to avoid showing repeats
    if (!window.seenArticleIds) {
        window.seenArticleIds = new Set();
    }
    if (!window.displayedArticleIds) {
        window.displayedArticleIds = new Set();
    }
    let displayedArticleIds = window.displayedArticleIds;
    let seenArticleIds = window.seenArticleIds;
    
    // Check if we have actual recipe elements in DOM, not just loading state
    const hasExistingRecipes = $('#articles-list .article-item').length > 0;
    let isFirstArticleLoad = !hasExistingRecipes;
    
    // Use window-level flag to prevent concurrent API calls across page reloads
    if (typeof window.isLoadingArticles === 'undefined') {
        window.isLoadingArticles = false;
    }

    // Set current date
    function setCurrentDate() {
        const now = new Date();
        // Use locale from I18n if available
        const currentLocale = window.I18n?.getLocale() || 'en';
        const localeMap = { 'en': 'en-US', 'fr': 'fr-FR', 'ar': 'ar-SA' };
        const locale = localeMap[currentLocale] || 'en-US';
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        $('#current-date').text(now.toLocaleDateString(locale, options));
    }

    // Update last updated time
    function updateTimestamp() {
        const now = new Date();
        const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        $('#last-updated').text(timeString);
    }

    // Animate number counting from current value to new value
    function animateNumber(element, finalNumber, duration = 1000) {
        const $element = $(element);
        const startNumber = parseInt($element.text()) || 0;
        
        // Don't animate if the number hasn't changed
        if (startNumber === finalNumber) {
            return;
        }

        const difference = finalNumber - startNumber;
        const increment = difference / (duration / 16);
        let currentNumber = startNumber;

        const timer = setInterval(() => {
            currentNumber += increment;
            if ((increment > 0 && currentNumber >= finalNumber) || (increment < 0 && currentNumber <= finalNumber)) {
                currentNumber = finalNumber;
                clearInterval(timer);
            }
            $element.text(Math.floor(currentNumber));
        }, 16);
    }

    // Update stat numbers only if they changed
    function updateStatNumbers(data) {
        const newValues = {
            automations: data.automations?.length || 0,
            minicanvas: data.maskTemplates?.length || 0,
            spyposts: data.postsLibrary?.length || 0,
            workflows: data.workflowCount || 0
        };

        // Only animate if this is the first load or if values changed
        Object.keys(newValues).forEach(key => {
            if (previousValues[key] !== newValues[key]) {
                const delay = previousValues[key] === null ? 200 * Object.keys(previousValues).indexOf(key) : 0;
                setTimeout(() => {
                    animateNumber(`[data_log="${key}"]`, newValues[key]);
                }, delay);
            }
        });

        // Update previous values
        previousValues = { ...newValues };
    }

    // Load and display dashboard data
    async function loadDashboardData() {
        try {
            // Get all needed keys at once for the dashboard
            const [
                automations, 
                maskTemplates, 
                postsLibrary, 
                workflowsResult,
                openaiKeys,
                googleProfiles,
                discordProfiles,
                wordpressSites,
                imageUploadKeys
            ] = await Promise.all([
                window.electronAPI.readKey('automations'),
                window.electronAPI.readKey('maskTemplates'),
                window.electronAPI.readKey('postsLibrary'),
                window.electronAPI.invoke('get-workflows-summary', 0, 1), // Just get first page to get total count
                window.electronAPI.readKey('openaiKeys'),
                window.electronAPI.readKey('googleProfiles'),
                window.electronAPI.readKey('discordProfiles'),
                window.electronAPI.readKey('wordpressSites'),
                window.electronAPI.readKey('imageUploadKeys')
            ]);
            
            // Extract workflow count from database result
            const workflowCount = workflowsResult?.success ? workflowsResult.total : 0;
            
            const result = { 
                automations, 
                maskTemplates, 
                postsLibrary,
                workflowCount,
                openaiKeys,
                googleProfiles,
                discordProfiles,
                wordpressSites,
                imageUploadKeys
            };

            // Update stat numbers (only animates if values changed)
            updateStatNumbers(result);

            // Update system status based on real data
            updateSystemStatus(result);

            // Update trend indicators
            updateTrendIndicators(result);

            updateTimestamp();
            console.log('Dashboard data:', result);

        } catch (error) {
            console.error('Error loading dashboard data:', error);
            updateSystemStatus(null, true);
        }
    }

    // Update system status indicators
    function updateSystemStatus(data, hasError = false) {
        if (hasError) {
            $('#api-status').removeClass('success warning').addClass('error');
            $('#api-status-text').text(window.I18n?.t('home.connection_error') || 'Connection Error');
            $('#task-status').removeClass('success warning').addClass('error');
            $('#task-status-text').text(window.I18n?.t('home.unknown') || 'Unknown');
            return;
        }

        // Check API connections based on available keys
        const hasOpenAI = data.openaiKeys && Object.keys(data.openaiKeys).length > 0;
        const hasGoogle = data.googleProfiles && Object.keys(data.googleProfiles).length > 0;
        const hasDiscord = data.discordProfiles && Object.keys(data.discordProfiles).length > 0;
        const hasWordpress = data.wordpressSites && Object.keys(data.wordpressSites).length > 0;
        const hasImageUpload = data.imageUploadKeys && Object.keys(data.imageUploadKeys).length > 0;

        const connectedServices = [hasOpenAI, hasGoogle, hasDiscord, hasWordpress, hasImageUpload].filter(Boolean).length;

        const connectedText = window.I18n?.t('home.connected') || 'Connected';
        const noConnectionsText = window.I18n?.t('home.no_connections') || 'No Connections';

        if (connectedServices >= 3) {
            $('#api-status').removeClass('warning error').addClass('success');
            $('#api-status-text').text(`${connectedServices}/5 ${connectedText}`);
        } else if (connectedServices >= 1) {
            $('#api-status').removeClass('success error').addClass('warning');
            $('#api-status-text').text(`${connectedServices}/5 ${connectedText}`);
        } else {
            $('#api-status').removeClass('success warning').addClass('error');
            $('#api-status-text').text(noConnectionsText);
        }

        // Check active automations
        const totalAutomations = data.automations?.length || 0;
        
        const availableText = window.I18n?.t('home.available') || 'Available';
        const noneCreatedText = window.I18n?.t('home.none_created') || 'None Created';

        if (totalAutomations > 0) {
            $('#task-status').removeClass('success error').addClass('success');
            $('#task-status-text').text(`${totalAutomations} ${availableText}`);
        } else {
            $('#task-status').removeClass('success warning').addClass('error');
            $('#task-status-text').text(noneCreatedText);
        }
    }

    // Update trend indicators based on real data
    function updateTrendIndicators(data) {
        // Automations trend
        const automationsCount = data.automations?.length || 0;
        const runningAutomations = data.automations?.filter(a => a.status === 'running')?.length || 0;

        const runningNowText = window.I18n?.t('home.running_now') || 'Running now';
        const readyToRunText = window.I18n?.t('home.ready_to_run') || 'Ready to run';
        const createFirstAutomationText = window.I18n?.t('home.create_first_automation') || 'Create first automation';

        if (runningAutomations > 0) {
            $('#automations-trend').html(`<i class="material-icons">play_circle</i><span>${runningNowText}</span>`);
        } else if (automationsCount > 0) {
            $('#automations-trend').html(`<i class="material-icons">pause_circle</i><span>${readyToRunText}</span>`);
        } else {
            $('#automations-trend').html(`<i class="material-icons">add</i><span>${createFirstAutomationText}</span>`);
        }

        // Templates trend
        const templatesCount = data.maskTemplates?.length || 0;
        const templatesAvailableText = window.I18n?.t('home.templates_available') || 'Templates available';
        const createFirstTemplateText = window.I18n?.t('home.create_first_template') || 'Create first template';

        if (templatesCount > 0) {
            $('#templates-trend').html(`<i class="material-icons">palette</i><span>${templatesAvailableText}</span>`);
        } else {
            $('#templates-trend').html(`<i class="material-icons">add</i><span>${createFirstTemplateText}</span>`);
        }

        // Spy Posts trend
        const postsCount = data.postsLibrary?.length || 0;
        const contentDiscoveredText = window.I18n?.t('home.content_discovered') || 'Content discovered';
        const startDiscoveringText = window.I18n?.t('home.start_discovering') || 'Start discovering';

        if (postsCount > 0) {
            $('#posts-trend').html(`<i class="material-icons">visibility</i><span>${contentDiscoveredText}</span>`);
        } else {
            $('#posts-trend').html(`<i class="material-icons">search</i><span>${startDiscoveringText}</span>`);
        }

        // Workflows trend
        const workflowsCount = data.workflowCount || 0;
        const workflowsCreatedText = window.I18n?.t('home.workflows_created') || 'Workflows created';
        const buildFirstWorkflowText = window.I18n?.t('home.build_first_workflow') || 'Build first workflow';

        if (workflowsCount > 0) {
            $('#workflows-trend').html(`<i class="material-icons">account_tree</i><span>${workflowsCreatedText}</span>`);
        } else {
            $('#workflows-trend').html(`<i class="material-icons">build</i><span>${buildFirstWorkflowText}</span>`);
        }
    }

    // Handle quick action clicks
    $('.action-tile').click(function (e) {
        e.preventDefault();
        const action = $(this).data('action');

        // Add click animation
        $(this).addClass('clicked');
        setTimeout(() => $(this).removeClass('clicked'), 200);

        // Navigate using the same system as the main menu
        switch (action) {
            case 'workflows':
                navigateToPage('workflows');
                break;
            case 'new-automation':
                navigateToPage('automation');
                break;
            case 'create-template':
                navigateToPage('minicanvas');
                break;
            case 'spy-posts':
                navigateToPage('spy');
                break;
            case 'settings':
                navigateToPage('settings');
                break;
            case 'structures':
                navigateToPage('structures');
                break;
        }
    });

    // Navigation function that mimics the main menu behavior
    function navigateToPage(page) {
        if (window.loadingState && window.loadingState.isNavigating) {
            console.log('Navigation already in progress, ignoring request');
            return;
        }

        console.log(`Navigating to: ${page}`);
        window.loadingState.isNavigating = true;

        try {
            // Find the corresponding menu element
            const menuElement = $(`.menu .menu-element[href="#${page}"]`);

            if (menuElement.length > 0) {
                console.log(`Found menu element for: ${page}`);

                // Comprehensive cleanup before navigation (from app.js)
                if (typeof cleanupCurrentPage === 'function') {
                    cleanupCurrentPage();
                }

                // Update menu state
                $('.menu .menu-element').removeClass('active');
                menuElement.addClass('active');

                // Show loading indicator
                $('#pagesContent').html('<div style="text-align: center; padding: 50px; color: #666;"><div class="spinner-border"></div><br>Loading...</div>');

                // Load page with a slight delay to allow cleanup to complete
                setTimeout(() => {
                    $('#pagesContent').load(`pages/${page}.html`, function (response, status, xhr) {
                        window.loadingState.isNavigating = false;
                        if (status === 'error') {
                            console.error(`Failed to load page: ${page}`, xhr.status, xhr.statusText);
                            $('#pagesContent').html(`<div style="text-align: center; padding: 50px; color: #666;">
                                <i class="material-icons" style="font-size: 3rem; opacity: 0.5;">error</i>
                                <p>Failed to load page: ${page}</p>
                                <small>Error ${xhr.status}: ${xhr.statusText}</small>
                            </div>`);
                        } else {
                            console.log(`Successfully loaded page: ${page}`);
                        }
                    });
                }, 50);
            } else {
                console.error(`Menu element not found for page: ${page}`);
                window.loadingState.isNavigating = false;
                showAlert('error', `Page "${page}" not found in navigation menu`);
            }
        } catch (err) {
            console.error('Navigation error:', err);
            window.loadingState.isNavigating = false;
            showAlert('error', `Navigation failed: ${err.message}`);
        }
    }

    // Handle refresh button
    $('#refresh-activity').click(function (e) {
        e.preventDefault();
        $(this).find('.material-icons').addClass('spinning');

        // Force animation on manual refresh by resetting previous values
        previousValues = {
            automations: null,
            minicanvas: null,
            spyposts: null,
            workflows: null
        };

        // Refresh data
        Promise.all([loadDashboardData(), loadActivityLog()]).then(() => {
            setTimeout(() => {
                $(this).find('.material-icons').removeClass('spinning');
            }, 1000);
        });
    });

    // Load real activity from persistent activity log
    async function loadActivityLog() {
        try {
            // Get recent activities from persistent database
            const result = await window.electronAPI.getRecentActivities(15);
            
            if (result?.success && result.activities && result.activities.length > 0) {
                // Convert to display format
                const activities = result.activities.map(activity => ({
                    type: activity.type,
                    message: activity.message,
                    timestamp: new Date(activity.createdAt),
                    category: activity.sourceType || activity.type,
                    sourceId: activity.sourceId
                }));
                
                displayActivityLog(activities);
            } else {
                showEmptyActivity();
            }
            
        } catch (error) {
            console.error('Error loading activity log:', error);
            showEmptyActivity();
        }
    }

    // Display activity log entries
    function displayActivityLog(logs) {
        const activityList = $('#activity-list');
        activityList.empty();

        if (!logs || logs.length === 0) {
            showEmptyActivity();
            return;
        }

        logs.slice(0, 10).forEach(log => {
            const timeAgo = getTimeAgo(new Date(log.timestamp));
            const icon = getActivityIcon(log.type);

            const activityHtml = `
                <div class="activity-item">
                    <div class="activity-icon ${log.type}">
                        <i class="material-icons">${icon}</i>
                    </div>
                    <div class="activity-content">
                        <p class="activity-title">${translateActivityMessage(log.message)}</p>
                        <p class="activity-time">${timeAgo}</p>
                    </div>
                </div>
            `;

            activityList.append(activityHtml);
        });
    }

    // Show empty activity state
    function showEmptyActivity() {
        const noActivity = window.I18n?.t('home.no_activity') || 'No recent activity';
        const activityHint = window.I18n?.t('home.activity_hint') || 'Activity will appear here as you use the app';
        $('#activity-list').html(`
            <div class="empty-state">
                <i class="material-icons">inbox</i>
                <p>${noActivity}</p>
                <span>${activityHint}</span>
            </div>
        `);
    }

    // Translate a stored English activity message to the current locale
    function translateActivityMessage(msg) {
        if (!msg) return msg;
        const t = (key, params) => window.I18n?.t(key, params) || null;
        let m;

        // Automation "name" created
        m = msg.match(/^Automation "(.+)" created$/);
        if (m) return t('home.log_automation_created', { name: m[1] }) || msg;

        // Automation "name" imported
        m = msg.match(/^Automation "(.+)" imported$/);
        if (m) return t('home.log_automation_imported', { name: m[1] }) || msg;

        // Automation "name" deleted
        m = msg.match(/^Automation "(.+)" deleted$/);
        if (m) return t('home.log_automation_deleted', { name: m[1] }) || msg;

        // Automation renamed from "old" to "new"
        m = msg.match(/^Automation renamed from "(.+)" to "(.+)"$/);
        if (m) return t('home.log_automation_renamed', { old: m[1], name: m[2] }) || msg;

        // Automation "name" duplicated from "original"
        m = msg.match(/^Automation "(.+)" duplicated from "(.+)"$/);
        if (m) return t('home.log_automation_duplicated', { name: m[1] }) || msg;

        // Bulk deleted N automation(s): ...
        m = msg.match(/^Bulk deleted (\d+) automation\(s\)/);
        if (m) return t('home.log_bulk_deleted', { count: m[1] }) || msg;

        // Workflow "name" created with N post(s)
        m = msg.match(/^Workflow "(.+)" created with (\d+) posts?$/);
        if (m) return t('home.log_workflow_created', { name: m[1], count: m[2] }) || msg;

        // Workflow "name" deleted
        m = msg.match(/^Workflow "(.+)" deleted$/);
        if (m) return t('home.log_workflow_deleted', { name: m[1] }) || msg;

        // Workflow completed: N/M posts successful
        m = msg.match(/^Workflow completed: (\d+)\/(\d+) posts successful$/);
        if (m) return t('home.log_workflow_completed', { success: m[1], total: m[2] }) || msg;

        // Workflow failed: N completed, M failed
        m = msg.match(/^Workflow failed: (\d+) completed, (\d+) failed$/);
        if (m) return t('home.log_workflow_failed_counts', { completed: m[1], failed: m[2] }) || msg;

        // Workflow stopped: N/M posts completed
        m = msg.match(/^Workflow stopped: (\d+)\/(\d+) posts completed$/);
        if (m) return t('home.log_workflow_stopped', { completed: m[1], total: m[2] }) || msg;

        // Workflow still running: N completed, M failed, P pending
        m = msg.match(/^Workflow still running: (\d+) completed, (\d+) failed, (\d+) pending$/);
        if (m) return t('home.log_workflow_running', { completed: m[1], failed: m[2], pending: m[3] }) || msg;

        // Workflow stopped during error handling
        if (msg === 'Workflow stopped during error handling') return t('home.log_workflow_stopped_error') || msg;

        // Workflow failed: <error message>
        m = msg.match(/^Workflow failed: (.+)$/);
        if (m) return t('home.log_workflow_error') || msg;

        // Post added to library from source
        m = msg.match(/^Post added to library from (.+)$/);
        if (m) return t('home.log_post_added', { source: m[1] }) || msg;

        return msg;
    }

    // Get appropriate icon for activity type
    function getActivityIcon(type) {
        const icons = {
            success: 'check_circle',
            info: 'info',
            warning: 'warning',
            error: 'error',
            automation: 'precision_manufacturing',
            template: 'palette',
            workflow: 'account_tree',
            spy: 'visibility',
            delete: 'delete',
            account: 'person',
            settings: 'settings',
            backup: 'cloud_upload',
            restore: 'cloud_download',
            export: 'file_download',
            import: 'file_upload'
        };
        return icons[type] || 'info';
    }

    // Calculate time ago
    function getTimeAgo(timestamp) {
        const now = new Date();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return window.I18n?.t('home.just_now') || 'Just now';
        if (minutes < 60) return window.I18n?.t('home.minutes_ago', { count: minutes }) || `${minutes} min ago`;
        if (hours < 24) return window.I18n?.t('home.hours_ago', { count: hours }) || `${hours}h ago`;
        return window.I18n?.t('home.days_ago', { count: days }) || `${days}d ago`;
    }

    // Load trending recipes from TheMealDB API - fetches 1 recipe per call
    async function loadTrendingArticles() {
        // Prevent concurrent API calls
        if (window.isLoadingArticles) return;
        window.isLoadingArticles = true;
        
        try {
            // Fetch just 1 random recipe per interval
            const res = await fetch('https://www.themealdb.com/api/json/v1/1/random.php');
            if (!res.ok) return;
            
            const data = await res.json();
            if (!data.meals || data.meals.length === 0) return;
            
            const recipe = data.meals[0];
            
            // Skip if already seen
            if (seenArticleIds.has(recipe.idMeal)) {
                // If we've seen too many, clear history
                if (seenArticleIds.size > 100) {
                    seenArticleIds.clear();
                    displayedArticleIds.clear();
                }
                return;
            }
            
            // Mark as seen
            seenArticleIds.add(recipe.idMeal);
            
            // Add to display (prepend new recipe, keep max 6)
            displaySingleRecipe(recipe);
            
        } catch (error) {
            console.error('Error loading recipe:', error);
        } finally {
            window.isLoadingArticles = false;
        }
    }
    
    // Display a single new recipe (prepend to list, remove oldest if > 6)
    function displaySingleRecipe(recipe) {
        const $list = $('#articles-list');
        
        // If first load or empty, clear loading skeleton
        if ($list.find('.article-item').length === 0 || $list.find('.loading-skeleton').length > 0) {
            $list.empty();
        }
        
        const element = createArticleElement(recipe, true);
        $list.prepend(element);
        
        // Remove "NEW" badge after 5 seconds
        setTimeout(() => {
            element.removeClass('article-new');
        }, 5000);
        
        // Keep only 6 recipes max
        const $items = $list.find('.article-item');
        if ($items.length > 6) {
            $items.last().fadeOut(300, function() { $(this).remove(); });
        }
    }

    function getDomain(url) {
        if (!url) return '';
        try {
            const urlObj = new URL(url);
            const parts = urlObj.hostname.split('.');
            // Get last two parts (domain.tld) or last three if it's a .co.uk style domain
            if (parts.length >= 2) {
                const twoLevel = parts.slice(-2).join('.');
                // Check for common two-part TLDs
                const twoPartTlds = ['co.uk', 'com.au', 'co.jp', 'co.nz', 'com.br'];
                if (parts.length >= 3 && twoPartTlds.includes(twoLevel)) {
                    return parts.slice(-3).join('.');
                }
                return twoLevel;
            }
            return urlObj.hostname;
        } catch (e) {
            return '';
        }
    }

    // Create recipe HTML element
    function createArticleElement(recipe, isNew = false) {
        // TheMealDB API fields
        const coverImage = recipe.strMealThumb || null;
        const title = recipe.strMeal || 'Untitled Recipe';
        const category = recipe.strCategory || '';
        const area = recipe.strArea || '';
        const recipeUrl = recipe.strSource || `https://www.themealdb.com/meal/${recipe.idMeal}`;
        const youtubeUrl = recipe.strYoutube || '';
        const recipeDomain = getDomain(recipe.strSource) || '';
        
        const $article = $(`
            <div class="article-item${isNew ? ' article-new' : ''}" data-article-id="${recipe.idMeal}" onclick="window.open('${recipeUrl}', '_blank')">
                ${coverImage ? 
                    `<img src="${coverImage}" class="article-cover" alt="${escapeHtml(title)}" onerror="this.classList.add('no-image'); this.outerHTML='<div class=\\'article-cover no-image\\'><i class=\\'material-icons\\'>restaurant</i></div>';">` :
                    `<div class="article-cover no-image"><i class="material-icons">restaurant</i></div>`
                }
                <div class="article-body">
                    <h4 class="article-title">${escapeHtml(title)}</h4>
                    <div class="article-meta">
                        <i class="material-icons" style="font-size: 16px; color: #6366f1;">category</i>
                        <span class="article-author">${escapeHtml(category)}</span>
                    </div>
                    <div class="article-stats">
                        <span class="article-stat">
                            <i class="material-icons">flag</i>
                            ${escapeHtml(area)}
                        </span>
                        ${youtubeUrl ? `
                        <span class="article-stat" onclick="event.stopPropagation(); window.open('${youtubeUrl}', '_blank');" style="cursor: pointer; color: #ff0000;">
                            <i class="material-icons">play_circle</i>
                            Video
                        </span>
                        ` : ''}
                        ${recipeDomain ? `
                        <span class="article-stat">
                            <i class="material-icons">public</i>
                            ${recipeDomain}
                        </span>
                        ` : ''}
                    </div>
                    <div class="article-tags">
                        <span class="article-tag">#${escapeHtml(category.toLowerCase().replace(/\s+/g, ''))}</span>
                        <span class="article-tag">#${escapeHtml(area.toLowerCase().replace(/\s+/g, ''))}</span>
                    </div>
                </div>
            </div>
        `);
        
        return $article;
    }

    // Display recipes with animation for new items
    function displayArticlesWithAnimation(recipes) {
        const articlesList = $('#articles-list');
        
        if (!recipes || recipes.length === 0) {
            showArticlesError();
            return;
        }
        
        // On first load, just display all recipes
        if (isFirstArticleLoad) {
            articlesList.empty();
            recipes.forEach(recipe => {
                displayedArticleIds.add(recipe.idMeal);
                const $article = createArticleElement(recipe, false);
                articlesList.append($article);
            });
            isFirstArticleLoad = false;
            return;
        }
        
        // Find new recipes (not in our tracked set)
        const newRecipes = recipes.filter(recipe => !displayedArticleIds.has(recipe.idMeal));
        
        if (newRecipes.length > 0) {
            // Only add ONE new recipe at a time for smooth animation
            const recipe = newRecipes[0];
            displayedArticleIds.add(recipe.idMeal);
            const $article = createArticleElement(recipe, true);
            
            // Hide initially for animation
            $article.css({
                opacity: 0,
                transform: 'translateY(-20px) scale(0.95)',
                maxHeight: 0,
                marginBottom: 0,
                overflow: 'hidden'
            });
            
            // Prepend to list
            articlesList.prepend($article);
            
            // Animate in
            setTimeout(() => {
                $article.css({
                    transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                    opacity: 1,
                    transform: 'translateY(0) scale(1)',
                    maxHeight: '200px',
                    marginBottom: '12px'
                });
                
                // Add glow effect
                $article.addClass('article-glow');
                
                // Remove glow after animation
                setTimeout(() => {
                    $article.removeClass('article-new article-glow');
                }, 2000);
            }, 50);
            
            // Remove excess articles from the bottom (keep only 6)
            const allItems = articlesList.find('.article-item');
            if (allItems.length > 6) {
                allItems.slice(6).each(function() {
                    const $item = $(this);
                    const itemId = parseInt($item.data('article-id'));
                    displayedArticleIds.delete(itemId);
                    
                    // Animate out
                    $item.css({
                        transition: 'all 0.3s ease-out',
                        opacity: 0,
                        transform: 'translateX(20px)',
                        maxHeight: 0,
                        marginBottom: 0
                    });
                    
                    setTimeout(() => $item.remove(), 300);
                });
            }
        }
    }

    // Show recipes error state
    function showArticlesError() {
        $('#articles-list').html(`
            <div class="empty-state" style="grid-column: 1 / -1;">
                <i class="material-icons">cloud_off</i>
                <p>Unable to load recipes</p>
                <span>Check your internet connection and try again</span>
            </div>
        `);
    }

    // Helper function to escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Handle refresh articles button
    $('#refresh-articles').click(function (e) {
        e.preventDefault();
        $(this).find('.material-icons').addClass('spinning');
        
        // Reset tracking to force full refresh
        displayedArticleIds.clear();
        isFirstArticleLoad = true;
        
        loadTrendingArticles().then(() => {
            setTimeout(() => {
                $(this).find('.material-icons').removeClass('spinning');
            }, 1000);
        });
    });

    // Auto-refresh data every 30 seconds
    const dashboardInterval = setInterval(() => {
        loadDashboardData();
        loadActivityLog();
    }, 30000);
    window.homePageIntervals.push(dashboardInterval);

    // ========== NOTES WIDGET ==========
    let currentEditingNoteId = null;
    let selectedNoteColor = '#fef3c7';
    let cachedNotes = []; // Cache notes locally for quick access

    // Load local notes
    async function loadNotes() {
        try {
            const result = await window.electronAPI.getNotes();
            if (result.success) {
                cachedNotes = result.notes || [];
                displayNotes(cachedNotes);
            } else {
                console.error('Error loading notes:', result.error);
                displayNotes([]);
            }
        } catch (error) {
            console.error('Error loading notes:', error);
            displayNotes([]);
        }
    }

    // Display notes in the widget
    function displayNotes(notes) {
        const notesList = $('#notes-list');
        notesList.empty();

        if (!notes || notes.length === 0) {
            const noNotesText = window.I18n?.t('home.no_notes') || 'No notes yet';
            const notesHintText = window.I18n?.t('home.notes_hint') || 'Click + to create your first note';
            notesList.html(`
                <div class="empty-state">
                    <i class="material-icons">note_add</i>
                    <p>${noNotesText}</p>
                    <span>${notesHintText}</span>
                </div>
            `);
            return;
        }

        // Sort by updated time (most recent first)
        notes.sort((a, b) => b.updatedAt - a.updatedAt);

        notes.forEach(note => {
            const timeAgo = getTimeAgo(new Date(note.updatedAt));
            const noteHtml = `
                <div class="note-item" data-note-id="${note.id}" style="background: ${note.color || '#fef3c7'};">
                    <div class="note-actions">
                        <button class="note-action-btn edit" title="Edit">
                            <i class="material-icons">edit</i>
                        </button>
                        <button class="note-action-btn delete" title="Delete">
                            <i class="material-icons">delete</i>
                        </button>
                    </div>
                    <h4 class="note-title">${escapeHtml(note.title || 'Untitled')}</h4>
                    <p class="note-content">${escapeHtml(note.content || '')}</p>
                    <div class="note-time">
                        <i class="material-icons">schedule</i>
                        ${timeAgo}
                    </div>
                </div>
            `;
            notesList.append(noteHtml);
        });
    }

    // ==================== COMMUNITY POSTS WIDGET ====================

    // Load latest community posts
    async function loadCommunityPosts() {
        try {
            // Hide the entire community card when the community is disabled
            const capabilities = await window.electronAPI.getAppCapabilities();
            if (capabilities && capabilities.community_disabled === true) {
                $('.community-posts-card').hide();
                return;
            }
            $('.community-posts-card').show();

            const result = await window.electronAPI.getForumPosts({
                page: 1,
                limit: 5,
                filter: 'newest',
                category: 'all'
            });

            if (result.success) {
                displayCommunityPosts(result.posts || []);
            } else {
                displayCommunityPosts([]);
            }
        } catch (error) {
            console.error('Error loading community posts:', error);
            displayCommunityPosts([]);
        }
    }

    // Display community posts in widget
    function displayCommunityPosts(posts) {
        const postsList = $('#community-posts-list');
        postsList.empty();

        if (!posts || posts.length === 0) {
            postsList.html(`
                <div class="empty-state">
                    <i class="material-icons">forum</i>
                    <p>${window.I18n?.t('home.no_posts_yet') || 'No posts yet'}</p>
                    <span>${window.I18n?.t('home.first_discussion') || 'Be the first to start a discussion!'}</span>
                </div>
            `);
            return;
        }

        posts.forEach(post => {
            const timeAgo = getTimeAgo(new Date(post.created_at_ts));
            const excerpt = post.content ? stripHtmlTags(post.content).substring(0, 80) + (post.content.length > 80 ? '...' : '') : '';
            
            const postHtml = `
                <div class="community-post-item" data-post-id="${post.id}">
                    ${post.featured_image ? `
                        <div class="post-thumb">
                            <img src="${escapeHtml(post.featured_image)}" alt="">
                        </div>
                    ` : ''}
                    <div class="post-info">
                        <h4 class="post-title">${escapeHtml(post.title)}</h4>
                        <p class="post-excerpt">${escapeHtml(excerpt)}</p>
                        <div class="post-meta">
                            <span class="post-author">${escapeHtml(post.author_name || 'Anonymous')}</span>
                            <span class="post-dot">•</span>
                            <span class="post-time">${timeAgo}</span>
                            <div class="post-stats">
                                <span><i class="material-icons">favorite</i> ${post.likes_count || 0}</span>
                                <span><i class="material-icons">chat_bubble</i> ${post.comments_count || 0}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            postsList.append(postHtml);
        });
    }

    // Strip HTML tags helper
    function stripHtmlTags(html) {
        const tmp = document.createElement('DIV');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    }

    // Click on community post to navigate
    $(document).on('click' + NS, '.community-post-item', function() {
        const postId = $(this).data('post-id');
        // Navigate to community page with post ID
        navigateToPage('community');
    });

    // View all link click
    $(document).on('click' + NS, '.view-all-link[data-action="community"]', function(e) {
        e.preventDefault();
        navigateToPage('community');
    });

    // ==================== CONVERSATIONS WIDGET ====================
    
    const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='50' fill='%236366f1'/%3E%3Ccircle cx='50' cy='38' r='18' fill='%23fff'/%3E%3Cellipse cx='50' cy='80' rx='30' ry='22' fill='%23fff'/%3E%3C/svg%3E";

    // Load conversations for home widget
    async function loadConversations() {
        try {
            // Hide the entire messages card when the community is disabled
            const capabilities = await window.electronAPI.getAppCapabilities();
            if (capabilities && capabilities.community_disabled === true) {
                $('.conversations-card').hide();
                return;
            }
            $('.conversations-card').show();

            const result = await window.electronAPI.getConversations();
            if (result.success) {
                displayConversations(result.conversations || []);
            } else {
                displayConversations([]);
            }
        } catch (error) {
            console.error('Error loading conversations:', error);
            displayConversations([]);
        }
    }

    // Display conversations in widget
    function displayConversations(conversations) {
        const container = $('#conversations-list-home');
        container.empty();

        if (!conversations || conversations.length === 0) {
            container.html(`
                <div class="empty-state">
                    <i class="material-icons">chat_bubble_outline</i>
                    <p>${window.I18n?.t('home.no_messages_yet') || 'No messages yet'}</p>
                    <span>${window.I18n?.t('home.start_conversation') || 'Start a conversation in the Community page'}</span>
                </div>
            `);
            return;
        }

        // Show up to 6 most recent conversations
        conversations.slice(0, 6).forEach(conv => {
            const isGroup = conv.type === 'group';
            
            let avatarSrc, displayName, onlineDot;
            
            if (isGroup) {
                const groupAvatar = conv.groupAvatar || conv.avatar;
                avatarSrc = groupAvatar 
                    ? (groupAvatar.startsWith('http') ? groupAvatar : '')
                    : DEFAULT_AVATAR;
                displayName = conv.groupName || conv.name || 'Unnamed Group';
                onlineDot = '';
            } else {
                avatarSrc = conv.otherUserAvatar 
                    ? (conv.otherUserAvatar.startsWith('http') ? conv.otherUserAvatar : '')
                    : DEFAULT_AVATAR;
                displayName = conv.otherUserName || 'Unknown User';
                onlineDot = conv.isOnline ? '<span class="online-dot"></span>' : '';
            }

            let preview = conv.lastMessage || window.I18n?.t('home.no_messages_yet') || 'No messages yet';
            if (preview.length > 40) preview = preview.substring(0, 40) + '...';
            if (conv.lastMessageIsOwn) preview = 'You: ' + preview;
            if (isGroup && conv.lastSenderName && !conv.lastMessageIsOwn) {
                preview = conv.lastSenderName.split(' ')[0] + ': ' + preview;
            }

            const timeAgo = conv.lastMessageAt ? formatConvTime(conv.lastMessageAt) : '';
            const unreadBadge = conv.unreadCount > 0 
                ? `<span class="conv-unread-badge">${conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span>` 
                : '';

            const avatarClass = isGroup ? 'group-avatar' + (conv.groupAvatar ? ' has-image' : '') : '';
            const groupIcon = isGroup ? '<i class="material-icons group-icon">group</i>' : '';

            const itemHtml = `
                <div class="conversation-home-item ${conv.unreadCount > 0 ? 'unread' : ''}" 
                     data-conversation-id="${conv.conversationId}"
                     data-type="${isGroup ? 'group' : 'private'}">
                    <div class="conv-avatar ${avatarClass}">
                        ${groupIcon}
                        <img src="${avatarSrc}" alt="${escapeHtml(displayName)}" onerror="this.src='${DEFAULT_AVATAR}'">
                        ${onlineDot}
                    </div>
                    <div class="conv-info">
                        <div class="conv-header">
                            <span class="conv-name">${escapeHtml(displayName)}</span>
                            <span class="conv-time">${timeAgo}</span>
                        </div>
                        <div class="conv-preview ${conv.lastMessageIsOwn ? 'own-message' : ''}">${escapeHtml(preview)}</div>
                    </div>
                    ${unreadBadge}
                </div>
            `;
            container.append(itemHtml);
        });
    }

    // Format conversation time
    function formatConvTime(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now - date;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'Now';
        if (minutes < 60) return `${minutes}m`;
        if (hours < 24) return `${hours}h`;
        if (days < 7) return `${days}d`;
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    // Click on conversation to navigate
    $(document).on('click' + NS, '.conversation-home-item', function() {
        const conversationId = $(this).data('conversation-id');
        const type = $(this).data('type') || 'private';
        
        // Store conversation data for community page to pick up
        window.pendingConversation = {
            conversationId: conversationId,
            type: type
        };
        
        // Navigate to community page to open conversation
        navigateToPage('community');
    });

    // View all conversations link
    $(document).on('click' + NS, '.view-all-link[data-action="conversations"]', function(e) {
        e.preventDefault();
        navigateToPage('community');
    });

    // Open note modal
    function openNoteModal(note = null) {
        currentEditingNoteId = note ? note.id : null;
        
        const editNoteText = window.I18n?.t('home.edit_note') || 'Edit Note';
        const newNoteText = window.I18n?.t('home.new_note') || 'New Note';
        const titlePlaceholder = window.I18n?.t('home.note_title_placeholder') || 'Note title...';
        const contentPlaceholder = window.I18n?.t('home.note_content_placeholder') || 'Write your note here...';
        
        $('#note-modal-title').text(note ? editNoteText : newNoteText);
        $('#note-title-input').val(note ? note.title : '').attr('placeholder', titlePlaceholder);
        $('#note-content-input').val(note ? note.content : '').attr('placeholder', contentPlaceholder);
        
        // Set selected color
        selectedNoteColor = note ? (note.color || '#fef3c7') : '#fef3c7';
        $('.note-color').removeClass('active');
        $(`.note-color[data-color="${selectedNoteColor}"]`).addClass('active');
        
        $('#note-modal-overlay').addClass('active');
        $('#note-title-input').focus();
    }

    // Close note modal
    function closeNoteModal() {
        $('#note-modal-overlay').removeClass('active');
        currentEditingNoteId = null;
        $('#note-title-input').val('');
        $('#note-content-input').val('');
    }

    // Save note to server
    async function saveNote() {
        const title = $('#note-title-input').val().trim();
        const content = $('#note-content-input').val().trim();

        if (!title && !content) {
            const requiredMsg = window.I18n?.t('home.note_title_content_required') || 'Please enter a title or content for your note';
            showAlert('warning', requiredMsg);
            return;
        }

        // Disable save button to prevent double-clicks
        const savingText = window.I18n?.t('home.saving') || 'Saving...';
        const saveNoteText = window.I18n?.t('home.save_note') || 'Save Note';
        $('#note-modal-save').prop('disabled', true).text(savingText);

        try {
            let result;
            
            if (currentEditingNoteId) {
                // Update existing note on server
                result = await window.electronAPI.updateNote({
                    id: currentEditingNoteId,
                    title,
                    content,
                    color: selectedNoteColor
                });
            } else {
                // Create new note on server
                result = await window.electronAPI.createNote({
                    title,
                    content,
                    color: selectedNoteColor
                });
            }

            if (result.success) {
                // Reload notes from server to get updated list
                await loadNotes();
                closeNoteModal();
                const successMsg = currentEditingNoteId 
                    ? (window.I18n?.t('home.note_updated') || 'Note updated!') 
                    : (window.I18n?.t('home.note_created') || 'Note created!');
                showAlert('success', successMsg);
            } else {
                const failMsg = window.I18n?.t('home.failed_to_save_note') || 'Failed to save note';
                showAlert('error', result.error || failMsg);
            }
        } catch (error) {
            console.error('Error saving note:', error);
            const failMsg = window.I18n?.t('home.failed_to_save_note') || 'Failed to save note';
            showAlert('error', failMsg);
        } finally {
            $('#note-modal-save').prop('disabled', false).text(saveNoteText);
        }
    }

    // Delete note from server
    async function deleteNote(noteId) {
        try {
            const result = await window.electronAPI.deleteNote(noteId);
            if (result.success) {
                await loadNotes();
                const successMsg = window.I18n?.t('home.note_deleted') || 'Note deleted!';
                showAlert('success', successMsg);
            } else {
                const failMsg = window.I18n?.t('home.failed_to_delete_note') || 'Failed to delete note';
                showAlert('error', result.error || failMsg);
            }
        } catch (error) {
            console.error('Error deleting note:', error);
            const failMsg = window.I18n?.t('home.failed_to_delete_note') || 'Failed to delete note';
            showAlert('error', failMsg);
        }
    }

    // Add note button click
    $('#add-note-btn').click(function(e) {
        e.preventDefault();
        openNoteModal();
    });

    // Close modal events
    $('#note-modal-close, #note-modal-cancel').click(function(e) {
        e.preventDefault();
        closeNoteModal();
    });

    // Close modal on overlay click
    $('#note-modal-overlay').click(function(e) {
        if (e.target === this) {
            closeNoteModal();
        }
    });

    // Save note button
    $('#note-modal-save').click(function(e) {
        e.preventDefault();
        saveNote();
    });

    // Color picker
    $(document).on('click' + NS, '.note-color', function(e) {
        e.preventDefault();
        $('.note-color').removeClass('active');
        $(this).addClass('active');
        selectedNoteColor = $(this).data('color');
    });

    // Edit note click
    $(document).on('click' + NS, '.note-action-btn.edit', async function(e) {
        e.stopPropagation();
        const noteId = $(this).closest('.note-item').data('note-id').toString();
        const note = cachedNotes.find(n => n.id.toString() === noteId);
        if (note) {
            openNoteModal(note);
        }
    });

    // Delete note click
    $(document).on('click' + NS, '.note-action-btn.delete', async function(e) {
        e.stopPropagation();
        const noteId = $(this).closest('.note-item').data('note-id').toString();
        const confirmMsg = window.I18n?.t('home.confirm_delete_note') || 'Are you sure you want to delete this note?';
        const confirmed = await confirmPrompt(confirmMsg);
        if (confirmed) {
            await deleteNote(noteId);
        }
    });

    // Click on note to edit
    $(document).on('click' + NS, '.note-item', async function(e) {
        if ($(e.target).closest('.note-action-btn').length) return;
        const noteId = $(this).data('note-id').toString();
        const note = cachedNotes.find(n => n.id.toString() === noteId);
        if (note) {
            openNoteModal(note);
        }
    });

    // Keyboard shortcut to save (Ctrl+Enter)
    $(document).on('keydown' + NS, '#note-content-input, #note-title-input', function(e) {
        if (e.ctrlKey && e.key === 'Enter') {
            saveNote();
        }
        if (e.key === 'Escape') {
            closeNoteModal();
        }
    });

    // Initial load
    setCurrentDate();
    loadDashboardData();
    loadActivityLog();
    loadNotes();
    loadCommunityPosts();
    loadConversations();

    // Update timestamp every minute
    const timestampInterval = setInterval(updateTimestamp, 60000);
    window.homePageIntervals.push(timestampInterval);

    // Refresh conversations every 30 seconds
    const conversationsInterval = setInterval(loadConversations, 30000);
    window.homePageIntervals.push(conversationsInterval);
});