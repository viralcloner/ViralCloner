(() => {
    const PINTEREST_NAMESPACE = ".pinterest";

    const DEFAULT_PROMPT = 'Generate recipes for this pinterest board "{BOARD_NAME}".';

    let allPinterestAccounts = {};
    let allPinterestTitles = {};
    let allStructures = {}; // Cache structures to avoid repeated loading
    let isGeneratingTitles = false;
    let isMultiAccountMode = false;
    let usePinterestTrends = false;
    let cachedTrends = null; // Cache trends data for the session
    
    // Pagination settings for titles
    const TITLES_PER_PAGE = 50;
    let currentTitlesPage = 1;
    let currentFilteredTitles = []; // Cache filtered/sorted titles

    // Utility functions
    const genId = (n = 10) => Array.from(crypto.getRandomValues(new Uint32Array(n)))
        .map(x => (x % 36).toString(36)).join("").slice(0, n);
    
    const ucfirst = (str) => {
        if (!str || typeof str !== 'string') return str;
        return str.charAt(0).toUpperCase() + str.slice(1);
    };

    const formatDate = (isoString) => {
        try {
            return new Date(isoString).toLocaleDateString();
        } catch {
            return window.I18n?.t('pinterest.invalid_date') || 'Invalid Date';
        }
    };

    const escapeHtml = (text) => {
        // Handle null, undefined, or non-string values
        if (text === null || text === undefined) {
            return '';
        }
        
        // Convert to string if not already a string
        const str = String(text);
        
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return str.replace(/[&<>"']/g, m => map[m]);
    };

    // Storage functions
    async function saveAccountsData() {
        try {
            await window.electronAPI.updateData("pinterestAccounts", allPinterestAccounts);
        } catch (error) {
            console.error("Failed to save Pinterest accounts:", error);
            showAlert("error", window.I18n?.t('pinterest.failed_save_accounts') || "Failed to save accounts data");
        }
    }

    async function saveTitlesData() {
        try {
            await window.electronAPI.updateData("pinterestTitles", allPinterestTitles);
        } catch (error) {
            console.error("Failed to save Pinterest titles:", error);
            showAlert("error", window.I18n?.t('pinterest.failed_save_titles') || "Failed to save titles data");
        }
    }

    function showPageLoading(show = true, message = null) {
        const defaultMessage = window.I18n?.t('pinterest.loading_data') || "Loading Pinterest data...";
        const displayMessage = message || defaultMessage;
        let overlay = $("#pinterestLoadingOverlay");
        
        if (show) {
            if (overlay.length === 0) {
                overlay = $(`
                    <div id="pinterestLoadingOverlay" class="page-loading-overlay">
                        <div class="loading-content">
                            <div class="loading-spinner">
                                <div class="spinner-ring"></div>
                                <div class="spinner-ring"></div>
                                <div class="spinner-ring"></div>
                            </div>
                            <div class="loading-text">${message}</div>
                            <div class="loading-progress">
                                <div class="progress-bar-animated"></div>
                            </div>
                        </div>
                    </div>
                `);
                $("#pinterest-accounts-container").prepend(overlay);
            } else {
                overlay.find(".loading-text").text(message);
                overlay.show();
            }
        } else {
            overlay.fadeOut(300, function() {
                $(this).remove();
            });
        }
    }

    async function loadData() {
        try {
            // Show loading overlay immediately
            showPageLoading(true, window.I18n?.t('pinterest.loading_accounts') || "Loading Pinterest accounts...");
            
            // Load all data in parallel for faster loading
            const [accountsData, titlesData, savedPrompt, structuresData] = await Promise.all([
                window.electronAPI.readKey("pinterestAccounts"),
                window.electronAPI.readKey("pinterestTitles"),
                window.electronAPI.readKey("pinterestTitlePrompt"),
                window.electronAPI.readKey("structures")
            ]);
            
            allPinterestAccounts = accountsData || {};
            allPinterestTitles = titlesData || {};
            allStructures = structuresData || {};
            
            if (savedPrompt) {
                $("#titlePrompt").val(savedPrompt);
            }
            
            // Clean up any malformed account data
            Object.keys(allPinterestAccounts).forEach(accountId => {
                const account = allPinterestAccounts[accountId];
                if (!account || typeof account !== 'object') {
                    console.warn(`Removing malformed account: ${accountId}`);
                    delete allPinterestAccounts[accountId];
                    return;
                }
                
                // Ensure required properties exist
                if (!account.email) {
                    account.email = 'Unknown Account';
                }
                
                if (!account.boards || !Array.isArray(account.boards)) {
                    account.boards = [];
                }
                
                // Clean up board data
                account.boards = account.boards.filter(board => {
                    if (!board || typeof board !== 'object' || !board.id) {
                        return false;
                    }
                    if (!board.name) {
                        board.name = 'Unknown Board';
                    }
                    return true;
                });
            });
            
            // Render UI components (non-blocking, use requestAnimationFrame for smoother rendering)
            requestAnimationFrame(() => {
                try {
                    renderAccounts();
                } catch (error) {
                    console.error("Failed to render accounts:", error);
                    $("#pinterestAccountsGrid").hide();
                    $("#emptyPinterestAccounts").show();
                }
                
                try {
                    renderTitles();
                } catch (error) {
                    console.error("Failed to render titles:", error);
                }
                
                try {
                    updateAccountSelectors();
                } catch (error) {
                    console.error("Failed to update account selectors:", error);
                }
                
                // Hide loading overlay after main content is rendered
                showPageLoading(false);
            });
            
            // Render CSV exports separately (can be deferred as it's below the fold)
            setTimeout(() => {
                try {
                    renderCsvExports();
                } catch (error) {
                    console.error("Failed to render CSV exports:", error);
                }
            }, 100);
            
            // Set default prompt text if empty (only if no saved prompt was loaded)
            if (!$("#titlePrompt").val().trim()) {
                $("#titlePrompt").val(DEFAULT_PROMPT);
            }
        } catch (error) {
            console.error("Failed to load Pinterest data:", error);
            showPageLoading(false);
        }
    }

    async function savePrompt() {
        const prompt = $("#titlePrompt").val().trim();
        if (!prompt) {
            showAlert("error", window.I18n?.t('pinterest.prompt_empty') || "Prompt cannot be empty");
            return;
        }
        
        try {
            await window.electronAPI.updateData("pinterestTitlePrompt", prompt);
            showAlert("success", window.I18n?.t('pinterest.prompt_saved') || "Prompt saved successfully!");
        } catch (error) {
            console.error("Failed to save prompt:", error);
            showAlert("error", window.I18n?.t('pinterest.failed_save_prompt') || "Failed to save prompt");
        }
    }

    // Account management functions
    function renderAccounts() {
        const tbody = $("#pinterestAccountsBody");
        tbody.empty();

        // Ensure allPinterestAccounts is an object
        if (!allPinterestAccounts || typeof allPinterestAccounts !== 'object') {
            allPinterestAccounts = {};
        }

        const accounts = Object.entries(allPinterestAccounts).filter(([id, account]) => {
            return account && typeof account === 'object' && account.email;
        });

        if (accounts.length === 0) {
            $("#pinterestAccountsTable").hide();
            $("#emptyPinterestAccounts").show();
            return;
        }

        $("#pinterestAccountsTable").show();
        $("#emptyPinterestAccounts").hide();

        // Use cached structures for profile information
        const structures = allStructures || {};

        const fragment = document.createDocumentFragment();

        accounts.forEach(([accountId, account]) => {
            const row = document.createElement('tr');
            row.dataset.accountId = accountId;

            const boardCount = account.boards ? account.boards.length : 0;
            const boardNames = account.boards ? account.boards.map(b => b?.name || (window.I18n?.t('pinterest.unknown_board') || 'Unknown Board')).join(", ") : (window.I18n?.t('pinterest.no_boards') || "No boards");

            // Get linked profile information
            let linkedProfileHtml = `<span class="text-muted">${window.I18n?.t('pinterest.not_linked') || 'Not linked'}</span>`;
            let hasValidProfile = false;

            if (account.linkedStructureId && account.linkedProfileId) {
                const structure = structures[account.linkedStructureId];
                if (structure && structure.profiles && structure.profiles[account.linkedProfileId]) {
                    const profile = structure.profiles[account.linkedProfileId];
                    const statusIcons = [];
                    if (profile.proxy && profile.proxy.ip) statusIcons.push('<i class="material-icons text-success" title="Proxy enabled" style="font-size: 16px;">vpn_lock</i>');
                    if (profile.fingerprint) statusIcons.push('<i class="material-icons text-success" title="Fingerprint enabled" style="font-size: 16px;">fingerprint</i>');

                    linkedProfileHtml = `
                        <div class="linked-profile-cell">
                            <strong>${escapeHtml(structure.label)}</strong>
                            <div class="profile-details-small">
                                ${escapeHtml(profile.label)} <span class="text-muted">(${ucfirst(profile.type)})</span>
                            </div>
                            ${statusIcons.length > 0 ? `<div class="profile-icons-small">${statusIcons.join(" ")}</div>` : ""}
                        </div>
                    `;
                    hasValidProfile = true;
                } else {
                    linkedProfileHtml = '<span class="text-danger">Profile not found</span>';
                }
            }

            row.innerHTML = `
                <td class="account-email-cell">
                    <div class="d-flex align-items-center gap-2">
                        <img src="assets/images/icons/pinterest-colored.png" width="20" alt="Pinterest">
                        <strong>${escapeHtml(account?.email || (window.I18n?.t('pinterest.unknown_account') || 'Unknown Account'))}</strong>
                    </div>
                </td>
                <td>
                    <span class="badge bg-primary">${boardCount}</span>
                    <small class="text-muted d-block mt-1" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(boardNames)}">
                        ${escapeHtml(boardNames.length > 40 ? boardNames.substring(0, 40) + "..." : boardNames)}
                    </small>
                </td>
                <td>${linkedProfileHtml}</td>
                <td>
                    ${account.notes ? `<small class="text-muted" title="${escapeHtml(account.notes)}">${escapeHtml(account.notes.length > 30 ? account.notes.substring(0, 30) + "..." : account.notes)}</small>` : '<span class="text-muted">—</span>'}
                </td>
                <td>
                    <small>${formatDate(account.createdAt)}</small>
                </td>
                <td>
                    <div class="action-dropdown">
                        <button class="action-dropdown-toggle btn btn-sm btn-outline-secondary" title="Actions">
                            <i class="material-icons">more_vert</i>
                        </button>
                        <div class="action-dropdown-menu">
                            <button data-role="editAccount" data-id="${accountId}" class="action-dropdown-item item-primary">
                                <i class="material-icons">edit</i>
                                <span data-i18n="pinterest.edit">${window.I18n?.t('pinterest.edit') || 'Edit'}</span>
                            </button>
                            <button data-role="viewTitles" data-id="${accountId}" class="action-dropdown-item item-info">
                                <i class="material-icons">title</i>
                                <span data-i18n="pinterest.view_titles">${window.I18n?.t('pinterest.view_titles') || 'View Titles'}</span>
                            </button>
                            ${hasValidProfile ? `<button data-role="openProfile" data-account-id="${accountId}" class="action-dropdown-item item-success">
                                <i class="material-icons">open_in_new</i>
                                <span data-i18n="pinterest.open_profile">${window.I18n?.t('pinterest.open_profile') || 'Open Profile'}</span>
                            </button>` : ''}
                            <div class="action-dropdown-divider"></div>
                            <button data-role="deleteAccount" data-id="${accountId}" class="action-dropdown-item item-danger">
                                <i class="material-icons">delete</i>
                                <span data-i18n="pinterest.delete">${window.I18n?.t('pinterest.delete') || 'Delete'}</span>
                            </button>
                        </div>
                    </div>
                </td>
            `;
            fragment.appendChild(row);
        });

        tbody[0].appendChild(fragment);
    }

    function renderTitles(resetPage = true) {
        const container = $("#generatedTitlesList");

        const accountFilter = $("#filterAccount").val();
        const boardFilter = $("#filterBoard").val();

        // Reset to page 1 when filters change
        if (resetPage) {
            currentTitlesPage = 1;
        }

        // Filter titles
        let filteredTitles = Object.entries(allPinterestTitles);

        if (accountFilter) {
            filteredTitles = filteredTitles.filter(([_, title]) => title.accountId === accountFilter);
        }

        if (boardFilter) {
            filteredTitles = filteredTitles.filter(([_, title]) => title.boardId === boardFilter);
        }

        if (filteredTitles.length === 0) {
            container.html(`
                <div class="empty-state text-center py-4">
                    <i class="material-icons" style="font-size: 48px;">auto_awesome</i>
                    <p data-i18n="pinterest.no_titles_found">${window.I18n?.t('pinterest.no_titles_found') || 'No titles found.'}</p>
                    <p><small data-i18n="pinterest.generate_some_titles">${window.I18n?.t('pinterest.generate_some_titles') || 'Generate some titles using the form on the left.'}</small></p>
                </div>
            `);
            $("#bulkActionsContainer").addClass("d-none");
            return;
        }

        // Sort by creation date (newest first) - only sort once when resetPage is true
        if (resetPage) {
            filteredTitles.sort(([,a], [,b]) => new Date(b.createdAt) - new Date(a.createdAt));
            currentFilteredTitles = filteredTitles;
        } else {
            filteredTitles = currentFilteredTitles;
        }

        const totalTitles = filteredTitles.length;
        const startIndex = 0;
        const endIndex = currentTitlesPage * TITLES_PER_PAGE;
        const titlesToShow = filteredTitles.slice(startIndex, endIndex);
        const hasMore = endIndex < totalTitles;

        const titlesHtml = titlesToShow.map(([titleId, title]) => {
            const account = allPinterestAccounts[title.accountId];
            const board = account ? account.boards.find(b => b.id === title.boardId) : null;

            return `
                <div class="title-item ${title.used ? 'used' : ''}" data-title-id="${titleId}">
                    <div class="title-checkbox">
                        <input type="checkbox" class="form-check-input title-select" data-title-id="${titleId}">
                    </div>
                    <div class="title-content">
                        <div class="title-text">${escapeHtml(title.title)}</div>
                        <div class="title-meta">
                            <small>
                                <strong>${escapeHtml(account ? account.email : (window.I18n?.t('pinterest.unknown_account') || 'Unknown Account'))}</strong> →
                                <strong>${escapeHtml(board ? board.name : (window.I18n?.t('pinterest.unknown_board') || 'Unknown Board'))}</strong> |
                                ${formatDate(title.createdAt)}
                                ${title.used ? ` | <span style="color: #e60023;">${window.I18n?.t('pinterest.used_in_workflow') || 'Used in workflow'}</span>` : ''}
                            </small>
                        </div>
                    </div>
                    <div class="title-actions">
                        <button data-role="copyTitle" data-title="${escapeHtml(title.title)}" data-i18n-title="pinterest.copy_to_clipboard" title="${window.I18n?.t('pinterest.copy_to_clipboard') || 'Copy to clipboard'}">
                            <i class="material-icons">content_copy</i>
                        </button>
                        <button data-role="deleteTitle" data-id="${titleId}" data-i18n-title="pinterest.delete_title" title="${window.I18n?.t('pinterest.delete_title') || 'Delete title'}">
                            <i class="material-icons">delete</i>
                        </button>
                    </div>
                </div>
            `;
        }).join("");

        // Add load more button and count info
        const loadMoreHtml = hasMore ? `
            <div class="text-center py-3" id="loadMoreContainer">
                <div class="text-muted mb-2">Showing ${titlesToShow.length} of ${totalTitles} titles</div>
                <button class="btn btn-outline-primary" id="loadMoreTitles">
                    <i class="material-icons me-1">expand_more</i>
                    Load More (${Math.min(TITLES_PER_PAGE, totalTitles - endIndex)} more)
                </button>
            </div>
        ` : `<div class="text-center py-2 text-muted"><small>Showing all ${totalTitles} titles</small></div>`;

        container.html(titlesHtml + loadMoreHtml);

        // Show/hide bulk actions based on whether there are titles
        const bulkActionsContainer = $("#bulkActionsContainer");
        if (filteredTitles.length > 0) {
            bulkActionsContainer.removeClass("d-none");
        } else {
            bulkActionsContainer.addClass("d-none");
        }

        // Reset bulk selection state
        updateBulkSelectionState();
    }

    function loadMoreTitles() {
        currentTitlesPage++;
        renderTitles(false); // Don't reset page, just add more
    }

    function updateAccountSelectors() {
        const accountOptions = Object.entries(allPinterestAccounts)
            .map(([id, account]) => `<option value="${id}">${escapeHtml(account?.email || 'Unknown Account')}</option>`)
            .join("");

        $("#selectedAccount, #filterAccount").each(function() {
            const currentValue = $(this).val();
            $(this).html(`<option value="">${window.I18n?.t('pinterest.select_account') || 'Select Account'}</option>${accountOptions}`);
            if (currentValue && allPinterestAccounts[currentValue]) {
                $(this).val(currentValue);
            }
        });

        updateBoardSelectors();
    }

    function updateBoardSelectors() {
        const accountId = $("#selectedAccount").val();
        const filterAccountId = $("#filterAccount").val();

        // Update main board selector
        $("#selectedBoard").prop("disabled", !accountId).html(`<option value="">${window.I18n?.t('pinterest.select_board') || 'Select Board'}</option>`);
        if (accountId && allPinterestAccounts[accountId] && allPinterestAccounts[accountId].boards) {
            const boardOptions = allPinterestAccounts[accountId].boards
                .map((board, index) => `<option value="${board?.id || ''}">${index + 1}: ${escapeHtml(board?.name || 'Unknown Board')}</option>`)
                .join("");
            $("#selectedBoard").html(`<option value="">${window.I18n?.t('pinterest.select_board') || 'Select Board'}</option>${boardOptions}`);
        }

        // Update filter board selector
        let allBoards = [];
        const targetAccountId = filterAccountId || null;

        if (targetAccountId && allPinterestAccounts[targetAccountId]) {
            allBoards = allPinterestAccounts[targetAccountId].boards || [];
        } else {
            // Get all boards from all accounts
            Object.values(allPinterestAccounts).forEach(account => {
                if (account.boards) {
                    allBoards = allBoards.concat(account.boards);
                }
            });
        }

        const filterBoardOptions = allBoards
            .map(board => `<option value="${board?.id || ''}">${escapeHtml(board?.name || 'Unknown Board')}</option>`)
            .join("");

        const currentFilterValue = $("#filterBoard").val();
        $("#filterBoard").html(`<option value="">${window.I18n?.t('pinterest.all_boards') || 'All Boards'}</option>${filterBoardOptions}`);
        if (currentFilterValue && allBoards.some(b => b.id === currentFilterValue)) {
            $("#filterBoard").val(currentFilterValue);
        }
    }

    function updateBoardNamePreview() {
        const accountId = $("#selectedAccount").val();
        const boardId = $("#selectedBoard").val();
        const promptText = $("#titlePrompt").val();

        // Set default prompt if empty or if account/board selection changes
        if (!promptText.trim()) {
            $("#titlePrompt").val(DEFAULT_PROMPT);
        }

        // Check if prompt contains {BOARD_NAME} placeholder
        if ($("#titlePrompt").val().includes("{BOARD_NAME}") && accountId && boardId) {
            const account = allPinterestAccounts[accountId];
            const board = account ? account.boards.find(b => b.id === boardId) : null;

            if (board) {
                $("#boardNameValue").text(board.name);
                $("#boardNamePreview").show();
                return;
            }
        }

        // Hide preview if conditions aren't met
        $("#boardNamePreview").hide();
    }

    async function showAccountModal(accountId = null) {
        const modal = new bootstrap.Modal(document.getElementById('accountModal'));

        // Clear form
        $("#accountId").val(accountId || "");
        $("#accountEmail").val("");
        $("#accountPassword").val("");
        $("#accountNotes").val("");
        $("#boardsList").empty();

        // Load structure profiles
        await loadStructureProfilesForModal();

        if (accountId && allPinterestAccounts[accountId]) {
            const account = allPinterestAccounts[accountId];
            $("#accountEmail").val(account.email);
            $("#accountPassword").val(account.password || "");
            $("#accountNotes").val(account.notes || "");

            // Set linked structure profile
            if (account.linkedStructureId && account.linkedProfileId) {
                $("#linkedStructureProfile").val(`${account.linkedStructureId}:${account.linkedProfileId}`);
            }

            // Add boards
            if (account.boards) {
                account.boards.forEach(board => {
                    addBoardToModal(board.name, board.id);
                });
            }
        }

        // Add at least one empty board field
        if ($("#boardsList .board-item").length === 0) {
            addBoardToModal();
        }

        modal.show();
    }

    async function loadStructureProfilesForModal() {
        try {
            // Refresh structures cache when opening modal
            allStructures = await window.electronAPI.readKey("structures") || {};
            const structures = allStructures;
            let profileOptions = "";

            Object.entries(structures).forEach(([structureId, structure]) => {
                if (structure.profiles) {
                    Object.entries(structure.profiles).forEach(([profileId, profile]) => {
                        const statusIcons = [];
                        if (profile.proxy && profile.proxy.ip) statusIcons.push("[Proxy]");
                        if (profile.fingerprint) statusIcons.push("[FP]");

                        const statusText = statusIcons.length > 0 ? ` (${statusIcons.join("")})` : "";
                        const optionText = `${structure.label} > ${profile.label} (${ucfirst(profile.type)})${statusText}`;

                        profileOptions += `<option value="${structureId}:${profileId}">${escapeHtml(optionText)}</option>`;
                    });
                }
            });

            $("#linkedStructureProfile").html(`<option value="">No linked profile</option>${profileOptions}`);
        } catch (error) {
            console.error("Failed to load structure profiles:", error);
        }
    }

    function addBoardToModal(name = "", id = null) {
        const boardId = id || genId(8);
        const boardItem = $(`
            <div class="board-item" data-board-id="${boardId}">
                <input type="text" value="${escapeHtml(name)}" placeholder="${window.I18n?.t('pinterest.board_name_input') || 'Board name'}" class="board-name">
                <button type="button" class="remove-board">
                    <i class="material-icons">remove</i>
                </button>
            </div>
        `);

        $("#boardsList").append(boardItem);
    }

    async function saveAccount() {
        const accountId = $("#accountId").val() || genId(10);
        const email = $("#accountEmail").val().trim();
        const password = $("#accountPassword").val().trim();
        const notes = $("#accountNotes").val().trim();
        const linkedProfile = $("#linkedStructureProfile").val();

        if (!email || !password) {
            showAlert("error", window.I18n?.t('pinterest.email_password_required') || "Email and password are required");
            return;
        }

        // Collect boards
        const boards = [];
        $("#boardsList .board-item").each(function() {
            const name = $(this).find(".board-name").val().trim();
            const boardId = $(this).attr("data-board-id");
            if (name) {
                boards.push({ id: boardId, name });
            }
        });

        if (boards.length === 0) {
            showAlert("error", window.I18n?.t('pinterest.at_least_one_board') || "At least one board is required");
            return;
        }

        // Check for duplicate board names within the same account
        const boardNames = boards.map(b => (b?.name || (window.I18n?.t('pinterest.unknown_board') || 'Unknown Board')).toLowerCase());
        if (new Set(boardNames).size !== boardNames.length) {
            showAlert("error", window.I18n?.t('pinterest.board_names_unique') || "Board names must be unique within the same account");
            return;
        }

        // Parse linked structure profile
        let linkedStructureId = null;
        let linkedProfileId = null;
        if (linkedProfile && linkedProfile.includes(":")) {
            [linkedStructureId, linkedProfileId] = linkedProfile.split(":");
        }

        allPinterestAccounts[accountId] = {
            email,
            password,
            notes,
            boards,
            linkedStructureId,
            linkedProfileId,
            createdAt: allPinterestAccounts[accountId]?.createdAt || new Date().toISOString()
        };

        await saveAccountsData();
        renderAccounts();
        updateAccountSelectors();

        bootstrap.Modal.getInstance(document.getElementById('accountModal')).hide();
        showAlert("success", window.I18n?.t('pinterest.account_saved') || "Pinterest account saved successfully!");
    }

    async function deleteAccount(accountId) {
        const account = allPinterestAccounts[accountId];
        if (!account) return;

        const confirmMsg = (window.I18n?.t('pinterest.delete_account_confirm', { email: account.email }) || `Delete Pinterest account "${account.email}" and all associated titles?`);
        const confirmed = await confirmPrompt(confirmMsg);
        if (!confirmed) return;

        // Delete associated titles
        const titlesToDelete = Object.keys(allPinterestTitles).filter(
            titleId => allPinterestTitles[titleId].accountId === accountId
        );

        titlesToDelete.forEach(titleId => {
            delete allPinterestTitles[titleId];
        });

        // Delete account
        delete allPinterestAccounts[accountId];

        await saveAccountsData();
        await saveTitlesData();

        renderAccounts();
        renderTitles();
        updateAccountSelectors();

        showAlert("success", window.I18n?.t('pinterest.account_deleted') || "Pinterest account and associated titles deleted successfully");
    }

    // Multi-account mode functions
    function renderAccountCheckboxList() {
        const container = $("#accountCheckboxList");
        container.empty();

        const accounts = Object.entries(allPinterestAccounts).filter(([id, account]) => {
            return account && typeof account === 'object' && account.email;
        });

        if (accounts.length === 0) {
            container.html('<div class="text-muted text-center py-3">No accounts available</div>');
            return;
        }

        const boardNumber = parseInt($("#boardNumber").val()) || 1;

        accounts.forEach(([accountId, account]) => {
            const boardCount = account.boards ? account.boards.length : 0;
            const hasBoard = boardCount >= boardNumber;
            const boardName = hasBoard && account.boards[boardNumber - 1] ? account.boards[boardNumber - 1].name : null;

            const item = $(`
                <div class="account-checkbox-item ${!hasBoard ? 'no-board disabled' : ''}" data-account-id="${accountId}">
                    <input type="checkbox" class="account-multi-checkbox" data-account-id="${accountId}" ${!hasBoard ? 'disabled' : ''}>
                    <div class="account-info">
                        <div class="account-email-text">${escapeHtml(account.email)}</div>
                        <div class="account-boards-info">
                            ${hasBoard ? `Board #${boardNumber}: ${escapeHtml(boardName)}` : `Only ${boardCount} board(s) - no board #${boardNumber}`}
                        </div>
                    </div>
                    <span class="board-count-badge">${boardCount} boards</span>
                </div>
            `);

            container.append(item);
        });

        updateMultiAccountSummary();
    }

    function updateMultiAccountSummary() {
        const selectedAccounts = $(".account-multi-checkbox:checked").length;
        const titleCount = parseInt($("#titleCount").val()) || 5;
        const boardNumber = parseInt($("#boardNumber").val()) || 1;

        $("#selectedAccountsCount").text(selectedAccounts);

        if (selectedAccounts > 0) {
            const totalTitles = selectedAccounts * titleCount;
            $("#multiAccountSummaryText").text(`Will generate ${titleCount} titles × ${selectedAccounts} accounts = ${totalTitles} total titles (using board #${boardNumber})`);
            $("#multiAccountSummary").show();
            $("#generateButtonText").text(`Generate ${totalTitles} Titles`);
        } else {
            $("#multiAccountSummary").hide();
            $("#generateButtonText").text("Generate Titles");
        }
    }

    function toggleMultiAccountMode(enabled) {
        isMultiAccountMode = enabled;

        if (enabled) {
            $("#singleAccountMode").hide();
            $("#multiAccountModeSection").show();
            $("#perAccountLabel").show();
            renderAccountCheckboxList();
        } else {
            $("#singleAccountMode").show();
            $("#multiAccountModeSection").hide();
            $("#perAccountLabel").hide();
            $("#generateButtonText").text("Generate Titles");
        }
    }

    function updateAccountAvailability(boardNumber) {
        $(".account-checkbox-item").each(function() {
            const accountId = $(this).data("account-id");
            const account = allPinterestAccounts[accountId];
            const boardCount = account && account.boards ? account.boards.length : 0;
            const hasBoard = boardCount >= boardNumber;
            const checkbox = $(this).find(".account-multi-checkbox");
            const boardName = hasBoard && account.boards[boardNumber - 1] ? account.boards[boardNumber - 1].name : null;

            if (hasBoard) {
                $(this).removeClass("no-board disabled");
                checkbox.prop("disabled", false);
                $(this).find(".account-boards-info").text(`Board #${boardNumber}: ${boardName}`);
            } else {
                $(this).addClass("no-board disabled");
                checkbox.prop("disabled", true).prop("checked", false);
                $(this).find(".account-boards-info").text(`Only ${boardCount} board(s) - no board #${boardNumber}`);
            }
        });
    }

    function buildTitlePrompt(requestCount, processedPrompt, boardName, trendingKeywords) {
        const trendSection = trendingKeywords && trendingKeywords.length > 0
            ? `TRENDING TOPICS (natural inspiration — 20–40% of titles should reflect one of these when it fits):
${trendingKeywords.map(k => `- ${k.term}`).join('\n')}
Guideline: if a trending topic naturally maps to a specific recipe (e.g. "peach" → Peach Cobbler, "pumpkin" → Pumpkin Bread), use it. Do NOT force a keyword if it makes the title vague. Do NOT ignore all trends — aim for roughly 1 in 3 titles to naturally reflect a trending ingredient or theme.`
            : '';

        return `Generate exactly ${requestCount} unique Pinterest recipe titles for: "${processedPrompt}".

TITLE STRUCTURE — vary across these patterns (rotate, do not repeat one pattern more than 30% of titles):
- [Texture word] [Specific Recipe] for [Meal/Use Case]
- Easy [Specific Recipe] with [Key Ingredient]
- Homemade [Specific Recipe] for [Meal Time]
- No Bake [Specific Recipe]
- One Pan [Specific Recipe] for [Use Case]
- Quick [Specific Recipe] for [Meal]
- [Real Number]-Ingredient [Specific Recipe]  ← MUST use an actual digit, e.g. "3-Ingredient", "5-Ingredient"
- Crispy/Fluffy/Creamy [Specific Recipe] with [Key Ingredient]

GOOD EXAMPLES — follow this quality level:
- Fluffy Homemade Bread for Every Meal
- Creamy Garlic Pasta for Busy Weeknights
- Crispy Garlic Potatoes for Easy Dinners
- Soft Cinnamon Rolls for Weekend Breakfast
- Easy Peach Cobbler with Fresh Peaches
- No Bake Chocolate Cheesecake
- One Pan Lemon Herb Chicken
- 3-Ingredient Peanut Butter Cookies
- 5-Ingredient Banana Bread
- 4-Ingredient Chocolate Oat Bars

FORBIDDEN: Writing "Ingredient" without a real number before it (e.g. "Simple Ingredient Cake" is INVALID)

FOOD TRIGGER WORDS (use frequently — they drive saves):
fluffy, creamy, crispy, cheesy, gooey, soft, moist, juicy, buttery, golden, crunchy, tender, homemade, easy, quick, no bake, one pan, meal prep

${trendSection}

QUALITY RULE #1 — Recipe Clarity (most important):
- Every title MUST name the SPECIFIC recipe, not just a food category
- BAD: "Refreshing Summer Dessert with Fresh Peaches"
- GOOD: "Easy Peach Cobbler with Fresh Peaches"
- The reader must know EXACTLY what recipe they are clicking on

QUALITY RULE #2 — No vague lifestyle filler:
FORBIDDEN phrases (never use these):
"for cozy moments", "for festive gatherings", "for warm evenings",
"yummy comfort food moments", "sweet summer treat", "delicious snack",
"for any occasion", "for the whole family", "a treat you will love",
"perfect for your routine", "nourishing", "wholesome treat",
"satisfying dish", "a nourishing start", "to kickstart your"

QUALITY RULE #3 — Structural variety:
- Do NOT use the same opening word more than 2 times across all titles
- Do NOT use the same pattern for more than 30% of titles
- Mix textures, cooking methods, and use cases

QUALITY RULE #4 — Human writing test:
- Would a real food blogger write this title? If it sounds like SEO text, rewrite it
- Max 1 trend-related term per title — no keyword stuffing
- Never imply a list, collection, or roundup

PINTEREST POLICY (mandatory):
- No health/medical claims or promises
- No clickbait or misleading language
- No all-caps words or excessive punctuation
- Authentic and accurate to what the recipe actually is

OUTPUT FORMAT (strict):
- One title per line, plain text only
- No numbering, no bullets, no quotes, no dashes, no symbols
- Exactly ${requestCount} titles`;
    }

    function scoreTitleQuality(title, keywordsForMatching) {
        const lower = title.toLowerCase();

        // --- Clarity score (40 pts) ---
        const specificRecipeWords = [
            'bread', 'cake', 'pasta', 'salad', 'soup', 'stew', 'curry', 'stir fry',
            'brownies', 'cookies', 'muffins', 'pie', 'cobbler', 'casserole', 'risotto',
            'tacos', 'burgers', 'pizza', 'quesadillas', 'nachos', 'wraps', 'sandwich',
            'smoothie', 'shake', 'lemonade', 'cheesecake', 'pudding', 'ice cream',
            'chicken', 'salmon', 'shrimp', 'beef', 'pork', 'tofu', 'eggs',
            'pancakes', 'waffles', 'french toast', 'oatmeal', 'granola',
            'roast', 'chili', 'lasagna', 'enchiladas', 'fajitas', 'paella',
            'tiramisu', 'flan', 'mousse', 'tart', 'galette', 'scones', 'biscuits',
            'focaccia', 'bagels', 'rolls', 'loaf', 'bars', 'truffles', 'bites',
            'dip', 'hummus', 'guacamole', 'frittata', 'quiche', 'crostini',
            'bruschetta', 'flatbread', 'naan', 'pita', 'wrap', 'bowl',
            'skillet', 'gratin', 'bake', 'roasted', 'grilled', 'fried'
        ];
        const hasSpecificRecipe = specificRecipeWords.some(w => lower.includes(w));
        let clarityScore = hasSpecificRecipe ? 30 : 0;

        const hasIngredient = /\b(garlic|lemon|peach|apple|chocolate|vanilla|cinnamon|pumpkin|berry|berries|cheese|cream|butter|honey|maple|avocado|spinach|tomato|basil|herb|mushroom|bacon|sausage|potato|zucchini|banana|mango|strawberry|blueberry|raspberry|caramel|peanut butter|almond|walnut|coconut|ginger|jalapeño|feta|parmesan|ricotta|mozzarella|broccoli|cauliflower|sweet potato|black bean|chickpea)\b/.test(lower);
        clarityScore += hasIngredient ? 10 : 0;

        // --- Click/Save appeal (25 pts) ---
        const triggerWords = ['fluffy', 'creamy', 'crispy', 'cheesy', 'gooey', 'soft', 'moist', 'juicy', 'buttery', 'golden', 'crunchy', 'tender', 'homemade', 'easy', 'quick', 'no bake', 'one pan', 'meal prep'];
        const triggersFound = triggerWords.filter(w => lower.includes(w)).length;
        let clickScore = Math.min(20, triggersFound * 10);
        const goodStructures = [/^easy /, /^homemade /, /^no.bake /, /^one.pan /, /^quick /, /^\d+-ingredient /i, /^fluffy /, /^creamy /, /^crispy /, /^soft /, /^golden /, /^cheesy /, /^gooey /, /^buttery /];
        if (goodStructures.some(p => p.test(lower))) clickScore = Math.min(25, clickScore + 5);

        // --- Search relevance (20 pts) ---
        let searchScore = hasSpecificRecipe ? 15 : 5;
        searchScore += hasIngredient ? 5 : 0;

        // --- Human wording (10 pts — deduct for AI filler) ---
        const aiFillerPhrases = [
            'for cozy moments', 'for festive gatherings', 'for warm evenings',
            'yummy comfort food', 'sweet summer treat', 'delicious snack',
            'for any occasion', 'for the whole family', 'a treat you will love',
            'perfect for your routine', 'nourishing', 'wholesome treat',
            'satisfying dish', 'a nourishing start', 'to kickstart your',
            'refreshing summer', 'perfect summer', 'amazing', 'incredible',
            'irresistible', 'you will love', 'everyone will love'
        ];
        const fillerFound = aiFillerPhrases.filter(p => lower.includes(p)).length;
        const humanScore = Math.max(0, 10 - (fillerFound * 5));

        // --- Trend keyword (5 pts) ---
        const matchedKeyword = keywordsForMatching ? keywordsForMatching.find(k => lower.includes(k.lower)) : null;
        const trendScore = matchedKeyword ? 5 : 0;

        const totalScore = clarityScore + clickScore + searchScore + humanScore + trendScore;

        // Vague category detection — titles that name a food category instead of a specific recipe
        const vagueCategoryPhrases = [
            'summer dessert', 'winter dessert', 'fall dessert', 'spring dessert',
            'comfort food', 'dinner idea', 'lunch idea', 'breakfast idea',
            'party food', 'holiday food', '4th of july food', 'game day food',
            'easy treat', 'simple snack', 'quick snack', 'healthy treat',
            'sweet treat', 'tasty treat', 'yummy treat', 'light snack',
            'dinner recipe', 'lunch recipe', 'breakfast recipe', 'dessert recipe',
            'summer meal', 'winter meal', 'fall meal', 'spring meal',
            'easy meal', 'simple meal', 'quick meal', 'healthy meal',
            'easy dish', 'simple dish', 'tasty dish', 'savory dish'
        ];
        const hasVagueCategory = vagueCategoryPhrases.some(p => lower.includes(p));

        // Reject "Ingredient" used without a real number before it (e.g. "Simple Ingredient Cake")
        const hasIngredientWord = lower.includes('ingredient');
        const hasNumberedIngredient = /\d+-ingredient/i.test(title);
        const hasBareIngredient = hasIngredientWord && !hasNumberedIngredient;

        const isAccepted =
            clarityScore >= 30 &&
            clickScore >= 10 &&
            humanScore >= 8 &&
            !hasVagueCategory &&
            !hasBareIngredient;

        return {
            clarityScore,
            clickScore,
            searchScore,
            humanScore,
            trendScore,
            totalScore,
            matchedKeyword: matchedKeyword ? matchedKeyword.original : null,
            hasVagueCategory,
            isAccepted
        };
    }

    async function generateTitlesForAccount(accountId, boardId, prompt, count, apiKey, trendingKeywords = null) {
        const account = allPinterestAccounts[accountId];
        const board = account ? account.boards.find(b => b.id === boardId) : null;
        const boardName = board ? board.name : "Unknown Board";

        // Replace {BOARD_NAME} placeholder in the prompt
        const processedPrompt = prompt.replace(/\{BOARD_NAME\}/g, boardName);

        // Build a Set of ALL existing titles (lifetime deduplication)
        const existingTitlesSet = new Set(
            Object.values(allPinterestTitles).map(t => t.title.toLowerCase().trim())
        );

        const savedTitles = [];
        const scoredTitles = []; // Track titles with quality scores
        let totalGenerated = 0;
        let totalDuplicates = 0;
        let totalQualityRejected = 0;
        let attempts = 0;
        const maxAttempts = 5;
        const now = new Date().toISOString();

        // Prepare keywords for natural inspiration matching (not forced verbatim)
        const keywordsForMatching = trendingKeywords ? trendingKeywords.map(k => ({ original: k.term, lower: k.term.toLowerCase() })) : [];

        // Keep generating until we have enough unique titles or hit max attempts
        while (savedTitles.length < count && attempts < maxAttempts) {
            attempts++;
            const remaining = count - savedTitles.length;
            // Request extra titles to compensate for potential duplicates (30% extra, 50% on retries)
            const extraMultiplier = attempts === 1 ? 1.3 : 1.5;
            const requestCount = Math.ceil(remaining * extraMultiplier);

            // Build the prompt using clarity-first approach
            const fullPrompt = buildTitlePrompt(requestCount, processedPrompt, boardName, trendingKeywords);

            const result = await window.electronAPI.callOpenAI(apiKey, "gpt-4o-mini", fullPrompt);

            if (!result.success) {
                throw new Error(result.value || "OpenAI request failed");
            }

            // Parse the generated titles - strip number prefixes and bullet/dash markers
            const generatedTitles = result.value
                .split('\n')
                .map(line => line
                    .replace(/^[\d]+[\.\)\-\:\s]+/, '') // Strip number prefixes (e.g., "1. ", "2) ")
                    .replace(/^[-–—•*]\s*/, '') // Strip dash/bullet prefixes (e.g., "- ", "• ")
                    .trim()
                )
                .filter(line => line.length > 0);

            totalGenerated += generatedTitles.length;

            // Filter out duplicates and low-quality titles, then save
            for (const title of generatedTitles) {
                if (savedTitles.length >= count) break;

                const titleLower = title.toLowerCase().trim();
                if (!existingTitlesSet.has(titleLower)) {
                    // Score quality using clarity-first heuristic
                    const quality = scoreTitleQuality(title, keywordsForMatching);

                    // Reject titles that fail minimum quality thresholds
                    if (!quality.isAccepted) {
                        totalQualityRejected++;
                        continue;
                    }

                    // Add to existing set to prevent duplicates within this generation batch
                    existingTitlesSet.add(titleLower);

                    const titleId = genId(12);
                    allPinterestTitles[titleId] = {
                        title: title.trim(),
                        accountId,
                        boardId,
                        used: false,
                        createdAt: now
                    };
                    savedTitles.push(title);
                    scoredTitles.push({ title: title.trim(), ...quality });
                } else {
                    totalDuplicates++;
                }
            }
        }

        if (savedTitles.length === 0) {
            throw new Error("No valid unique titles could be generated");
        }

        // Calculate aggregate quality scores
        const avgClarityScore = scoredTitles.length > 0
            ? Math.round(scoredTitles.reduce((s, t) => s + t.clarityScore, 0) / scoredTitles.length)
            : 0;
        const avgClickScore = scoredTitles.length > 0
            ? Math.round(scoredTitles.reduce((s, t) => s + t.clickScore, 0) / scoredTitles.length)
            : 0;
        const trendMatchCount = scoredTitles.filter(t => t.matchedKeyword).length;

        return {
            generated: totalGenerated,
            saved: savedTitles.length,
            duplicates: totalDuplicates,
            qualityRejected: totalQualityRejected,
            attempts: attempts,
            avgClarityScore,
            avgClickScore,
            trendMatchCount,
            scoredTitles
        };
    }

    async function generateTitles() {
        if (isGeneratingTitles) return;

        const prompt = $("#titlePrompt").val().trim();
        const count = parseInt($("#titleCount").val());

        if (!prompt) {
            showAlert("error", "Please enter a prompt");
            return;
        }

        // Check if OpenAI is configured
        let apiKey;
        try {
            const openaiKeys = await window.electronAPI.readKey("openaiKeys") || {};
            apiKey = Object.keys(openaiKeys).find(key => openaiKeys[key].status === "active");

            if (!apiKey) {
                showAlert("error", "No active OpenAI API key found. Please configure OpenAI in Settings.");
                return;
            }
        } catch (error) {
            showAlert("error", "Unable to check OpenAI configuration");
            return;
        }

        isGeneratingTitles = true;
        const submitBtn = $("#titleGenerationForm button[type=submit]");
        const originalText = submitBtn.html();
        const generatingText = `<span class="loading-spinner"></span> ${window.I18n?.t('pinterest.generating') || 'Generating...'}`;
        submitBtn.prop("disabled", true).html(generatingText);

        try {
            // Fetch Pinterest Trends if enabled
            let trendingKeywords = null;
            if (usePinterestTrends) {
                submitBtn.html('<span class="loading-spinner"></span> Fetching trends...');
                const category = $("#trendCategory").val();
                const country = $("#trendCountry").val();
                
                // Use cached trends if available for same category/country
                const cacheKey = `${category}-${country}`;
                if (cachedTrends && cachedTrends.key === cacheKey) {
                    trendingKeywords = cachedTrends.trends;
                    console.log("Using cached Pinterest trends");
                } else {
                    try {
                        const trendsResult = await window.electronAPI.fetchPinterestTrends(category, country);
                        if (trendsResult.success && trendsResult.trends) {
                            trendingKeywords = trendsResult.trends;
                            cachedTrends = { key: cacheKey, trends: trendingKeywords };
                            
                            // Update the preview
                            updateTrendsPreview(trendingKeywords, trendsResult.endDate);
                            console.log(`Fetched ${trendingKeywords.length} trending keywords for ${trendsResult.endDate}`);
                        } else {
                            console.warn("Failed to fetch trends:", trendsResult.error);
                            showAlert("warning", `Could not fetch trends: ${trendsResult.error}. Proceeding without trends.`);
                        }
                    } catch (trendsError) {
                        console.error("Pinterest Trends fetch error:", trendsError);
                        showAlert("warning", "Failed to fetch Pinterest trends. Proceeding without trends.");
                    }
                }
            }

            submitBtn.html('<span class="loading-spinner"></span> Generating...');

            if (isMultiAccountMode) {
                // Multi-account mode
                const selectedAccountIds = $(".account-multi-checkbox:checked").map(function() {
                    return $(this).data("account-id");
                }).get();

                if (selectedAccountIds.length === 0) {
                    showAlert("error", "Please select at least one account");
                    return;
                }

                const boardNumber = parseInt($("#boardNumber").val()) || 1;
                let totalSaved = 0;
                let totalDuplicates = 0;
                let successCount = 0;
                let failedAccounts = [];

                // Show progress
                submitBtn.html(`<span class="loading-spinner"></span> Generating (0/${selectedAccountIds.length})...`);

                let totalTrendMatches = 0;
                let totalQualityRejected = 0;
                let totalClarityScore = 0;
                let totalClickScore = 0;
                let totalScoredCount = 0;

                for (let i = 0; i < selectedAccountIds.length; i++) {
                    const accountId = selectedAccountIds[i];
                    const account = allPinterestAccounts[accountId];

                    if (!account || !account.boards || account.boards.length < boardNumber) {
                        failedAccounts.push({ email: account?.email || accountId, reason: "No board at position " + boardNumber });
                        continue;
                    }

                    const board = account.boards[boardNumber - 1];

                    try {
                        submitBtn.html(`<span class="loading-spinner"></span> Generating (${i + 1}/${selectedAccountIds.length})...`);

                        const result = await generateTitlesForAccount(accountId, board.id, prompt, count, apiKey, trendingKeywords);
                        totalSaved += result.saved;
                        totalDuplicates += result.duplicates;
                        totalQualityRejected += result.qualityRejected || 0;
                        totalTrendMatches += result.trendMatchCount || 0;
                        if (result.scoredTitles && result.scoredTitles.length > 0) {
                            totalClarityScore += result.avgClarityScore * result.scoredTitles.length;
                            totalClickScore += result.avgClickScore * result.scoredTitles.length;
                            totalScoredCount += result.scoredTitles.length;
                        }
                        successCount++;

                        // Small delay between requests to avoid rate limiting
                        if (i < selectedAccountIds.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    } catch (error) {
                        console.error(`Failed to generate for ${account.email}:`, error);
                        failedAccounts.push({ email: account.email, reason: error.message });
                    }
                }

                await saveTitlesData();
                renderTitles();

                // Show summary
                const overallAvgClarity = totalScoredCount > 0 ? Math.round(totalClarityScore / totalScoredCount) : 0;
                const overallAvgClick = totalScoredCount > 0 ? Math.round(totalClickScore / totalScoredCount) : 0;

                if (trendingKeywords && trendingKeywords.length > 0) {
                    // Show detailed quality report modal
                    const reportHtml = `
                        <div class="keyword-report">
                            <div class="report-summary mb-4">
                                <div class="alert alert-${failedAccounts.length > 0 ? 'warning' : 'success'}">
                                    <strong>Generated ${totalSaved} titles</strong> for ${successCount}/${selectedAccountIds.length} accounts
                                </div>
                            </div>
                            <div class="report-stats">
                                <div class="stat-row highlight">
                                    <span class="stat-label"><i class="material-icons">spellcheck</i> Avg. Recipe Clarity (40 max):</span>
                                    <span class="stat-value">${overallAvgClarity}/40</span>
                                </div>
                                <div class="stat-row highlight">
                                    <span class="stat-label"><i class="material-icons">favorite</i> Avg. Click/Save Appeal (25 max):</span>
                                    <span class="stat-value">${overallAvgClick}/25</span>
                                </div>
                                <div class="stat-row">
                                    <span class="stat-label"><i class="material-icons">trending_up</i> Titles with trend inspiration:</span>
                                    <span class="stat-value">${totalTrendMatches}/${totalSaved}</span>
                                </div>
                                <div class="stat-row">
                                    <span class="stat-label"><i class="material-icons">content_copy</i> Duplicates skipped:</span>
                                    <span class="stat-value">${totalDuplicates}</span>
                                </div>
                                ${totalQualityRejected > 0 ? `
                                <div class="stat-row">
                                    <span class="stat-label"><i class="material-icons">block</i> Generic titles rejected:</span>
                                    <span class="stat-value">${totalQualityRejected}</span>
                                </div>` : ''}
                            </div>
                            ${failedAccounts.length > 0 ? `
                            <div class="report-failures mt-3">
                                <div class="alert alert-danger">
                                    <strong>Failed accounts:</strong><br>
                                    ${failedAccounts.map(f => `${escapeHtml(f.email)}: ${escapeHtml(f.reason)}`).join('<br>')}
                                </div>
                            </div>` : ''}
                            <div class="report-keywords mt-4">
                                <h6>Trending Topics (used as inspiration):</h6>
                                <div class="keyword-badges">
                                    ${trendingKeywords.map(k => `<span class="badge bg-secondary me-1 mb-1">${escapeHtml(k.term)}</span>`).join('')}
                                </div>
                            </div>
                        </div>
                        <style>
                            .keyword-report .stat-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
                            .keyword-report .stat-row:last-child { border-bottom: none; }
                            .keyword-report .stat-row.highlight { background: #f0fff4; margin: 0 -15px; padding: 10px 15px; }
                            .keyword-report .stat-label { display: flex; align-items: center; gap: 8px; }
                            .keyword-report .stat-label i { font-size: 18px; color: #666; }
                            .keyword-report .stat-value { font-weight: 600; }
                            .keyword-report .stat-row.highlight .stat-label i { color: #28a745; }
                            .keyword-report .keyword-badges { max-height: 100px; overflow-y: auto; }
                        </style>
                    `;
                    showDynamicModal('<i class="material-icons" style="vertical-align:middle">bar_chart</i> Title Quality Report', reportHtml);
                } else {
                    // No trends used, show simple alert with quality scores
                    let message = `Generated ${totalSaved} titles for ${successCount}/${selectedAccountIds.length} accounts · Clarity: ${overallAvgClarity}/40 | Click appeal: ${overallAvgClick}/25`;
                    if (totalDuplicates > 0) message += ` · ${totalDuplicates} duplicates skipped`;
                    if (totalQualityRejected > 0) message += ` · ${totalQualityRejected} generic titles rejected`;
                    if (failedAccounts.length > 0) {
                        message += `\nFailed: ${failedAccounts.map(f => f.email).join(", ")}`;
                        showAlert(successCount > 0 ? "warning" : "error", message);
                    } else {
                        showAlert("success", message);
                    }
                }

            } else {
                // Single account mode (original behavior)
                const accountId = $("#selectedAccount").val();
                const boardId = $("#selectedBoard").val();

                if (!accountId || !boardId) {
                    showAlert("error", "Please select an account and board");
                    return;
                }

                const result = await generateTitlesForAccount(accountId, boardId, prompt, count, apiKey, trendingKeywords);
                await saveTitlesData();
                renderTitles();

                if (trendingKeywords && trendingKeywords.length > 0) {
                    // Show detailed quality report modal
                    const account = allPinterestAccounts[accountId];
                    const board = account ? account.boards.find(b => b.id === boardId) : null;
                    const reportHtml = `
                        <div class="keyword-report">
                            <div class="report-summary mb-4">
                                <div class="alert alert-success">
                                    <strong>Successfully generated ${result.saved} new titles!</strong>
                                    ${account ? `<br><small>Account: ${escapeHtml(account.email)} | Board: ${escapeHtml(board?.name || 'Unknown')}</small>` : ''}
                                </div>
                            </div>
                            <div class="report-stats">
                                <div class="stat-row highlight">
                                    <span class="stat-label"><i class="material-icons">spellcheck</i> Avg. Recipe Clarity (40 max):</span>
                                    <span class="stat-value">${result.avgClarityScore}/40</span>
                                </div>
                                <div class="stat-row highlight">
                                    <span class="stat-label"><i class="material-icons">favorite</i> Avg. Click/Save Appeal (25 max):</span>
                                    <span class="stat-value">${result.avgClickScore}/25</span>
                                </div>
                                <div class="stat-row">
                                    <span class="stat-label"><i class="material-icons">trending_up</i> Titles with trend inspiration:</span>
                                    <span class="stat-value">${result.trendMatchCount}/${result.saved}</span>
                                </div>
                                <div class="stat-row">
                                    <span class="stat-label"><i class="material-icons">content_copy</i> Duplicates skipped:</span>
                                    <span class="stat-value">${result.duplicates}</span>
                                </div>
                                ${result.qualityRejected > 0 ? `
                                <div class="stat-row">
                                    <span class="stat-label"><i class="material-icons">block</i> Generic titles rejected:</span>
                                    <span class="stat-value">${result.qualityRejected}</span>
                                </div>` : ''}
                            </div>
                            <div class="report-keywords mt-4">
                                <h6>Trending Topics (used as inspiration):</h6>
                                <div class="keyword-badges">
                                    ${trendingKeywords.map(k => `<span class="badge bg-secondary me-1 mb-1">${escapeHtml(k.term)}</span>`).join('')}
                                </div>
                            </div>
                        </div>
                        <style>
                            .keyword-report .stat-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
                            .keyword-report .stat-row:last-child { border-bottom: none; }
                            .keyword-report .stat-row.highlight { background: #f0fff4; margin: 0 -15px; padding: 10px 15px; }
                            .keyword-report .stat-label { display: flex; align-items: center; gap: 8px; }
                            .keyword-report .stat-label i { font-size: 18px; color: #666; }
                            .keyword-report .stat-value { font-weight: 600; }
                            .keyword-report .stat-row.highlight .stat-label i { color: #28a745; }
                            .keyword-report .keyword-badges { max-height: 100px; overflow-y: auto; }
                        </style>
                    `;
                    showDynamicModal('<i class="material-icons" style="vertical-align:middle">bar_chart</i> Title Quality Report', reportHtml);
                } else {
                    // No trends used, show simple alert with quality scores
                    let message = `Generated ${result.saved} titles! Clarity: ${result.avgClarityScore}/40 | Click appeal: ${result.avgClickScore}/25`;
                    if (result.duplicates > 0) message += ` · ${result.duplicates} duplicates skipped`;
                    if (result.qualityRejected > 0) message += ` · ${result.qualityRejected} generic titles rejected`;
                    showAlert("success", message);
                }
            }

        } catch (error) {
            console.error("Title generation failed:", error);
            const errorMsg = (window.I18n?.t('pinterest.failed_generate_titles', { error: error.message }) || `Failed to generate titles: ${error.message}`);
            showAlert("error", errorMsg);
        } finally {
            isGeneratingTitles = false;
            submitBtn.prop("disabled", false).html(originalText);
            updateMultiAccountSummary();
        }
    }

    function updateTrendsPreview(trends, endDate) {
        if (!trends || trends.length === 0) {
            $("#trendsPreview").hide();
            return;
        }

        const keywordsHtml = trends.map(t => 
            `<span class="trend-keyword-badge" title="Search count: ${t.searchCount}">${escapeHtml(t.term)}</span>`
        ).join("");

        $("#trendsKeywordsList").html(keywordsHtml);
        $("#trendsPreview").show();
        $("#trendsFetchStatus").hide();
    }

    function togglePinterestTrends(enabled) {
        usePinterestTrends = enabled;
        if (enabled) {
            $("#pinterestTrendsOptions").slideDown(200);
            $("#trendsFetchStatus").show();
            $("#trendsFetchStatusText").text("Trends will be fetched when generating titles...");
        } else {
            $("#pinterestTrendsOptions").slideUp(200);
            $("#trendsPreview").hide();
            cachedTrends = null;
        }
    }

    async function deleteTitle(titleId) {
        const title = allPinterestTitles[titleId];
        if (!title) return;

        const confirmMsg = (window.I18n?.t('pinterest.delete_title_confirm', { title: title.title }) || `Delete the title "${title.title}"?`);
        const confirmed = await confirmPrompt(confirmMsg);
        if (!confirmed) return;

        delete allPinterestTitles[titleId];
        await saveTitlesData();
        renderTitles();

        showAlert("success", window.I18n?.t('pinterest.title_deleted') || "Title deleted successfully");
    }

    async function copyTitle(titleText) {
        try {
            await navigator.clipboard.writeText(titleText);
            showAlert("success", window.I18n?.t('pinterest.title_copied') || "Title copied to clipboard!");
        } catch (error) {
            console.error("Failed to copy title:", error);
            showAlert("error", window.I18n?.t('pinterest.failed_copy_title') || "Failed to copy title to clipboard");
        }
    }

    async function openLinkedProfile(accountId) {
        try {
            const account = allPinterestAccounts[accountId];
            if (!account || !account.linkedStructureId || !account.linkedProfileId) {
                showAlert("error", "No linked profile found for this account");
                return;
            }

            const structures = await window.electronAPI.readKey("structures") || {};
            const structure = structures[account.linkedStructureId];

            if (!structure || !structure.profiles || !structure.profiles[account.linkedProfileId]) {
                showAlert("error", "Linked profile no longer exists");
                return;
            }

            const profile = structure.profiles[account.linkedProfileId];
            const confirmed = await confirmPrompt(`Open "${profile.label}" profile from "${structure.label}" structure?`);
            if (!confirmed) return;

            const proxy = profile.proxy;
            
            console.log('[Pinterest] Opening profile with proxy:', proxy);
            console.log('[Pinterest] Proxy check conditions:', {
                hasProxy: !!proxy,
                hasIp: proxy?.ip,
                ipNotNull: proxy?.ip !== "NULL"
            });
            
            // Check if proxy needs clean IP verification
            if (proxy && proxy.ip && proxy.ip !== "NULL") {
                const ipregistrySettings = await window.electronAPI.readKey('ipregistrySettings');
                
                console.log('[Pinterest] IPRegistry settings:', ipregistrySettings);
                
                if (ipregistrySettings?.enabled && ipregistrySettings?.apiKey) {
                    console.log('[Pinterest] Starting proxy check...');
                    // Show proxy checking modal
                    showProxyCheckingModal();
                    
                    // Set up progress listener
                    window.electronAPI.onProxyCheckProgress((data) => {
                        updateProxyCheckingModal(data);
                    });
                    
                    try {
                        const result = await window.electronAPI.findCleanProxy(proxy, 20);
                        
                        // Remove listener
                        window.electronAPI.removeProxyCheckProgressListener();
                        
                        if (result.skipped) {
                            // IPRegistry not configured, proceed directly
                            closeProxyCheckingModal();
                            await window.electronAPI.startStructureProfile(account.linkedProfileId, "https://pinterest.com", proxy);
                            showAlert("success", "Profile opened successfully!");
                            return;
                        }
                        
                        if (result.success) {
                            // Found clean proxy
                            closeProxyCheckingModal();
                            showAlert("success", `Clean proxy found! IP: ${result.finalIp}`);
                            await window.electronAPI.startStructureProfile(account.linkedProfileId, "https://pinterest.com", result.proxyData);
                        } else {
                            // No clean proxy found - show confirmation modal
                            closeProxyCheckingModal();
                            const proceed = await showDirtyProxyConfirmModal(result);
                            if (proceed) {
                                await window.electronAPI.startStructureProfile(account.linkedProfileId, "https://pinterest.com", result.proxyData);
                                showAlert("success", "Profile opened successfully!");
                            }
                        }
                    } catch (error) {
                        window.electronAPI.removeProxyCheckProgressListener();
                        closeProxyCheckingModal();
                        showAlert("error", `Proxy check failed: ${error.message}`);
                    }
                    return;
                }
            }
            
            // No proxy or IPRegistry not enabled, proceed directly
            await window.electronAPI.startStructureProfile(account.linkedProfileId, "https://pinterest.com", proxy);
            showAlert("success", window.I18n?.t('pinterest.profile_opened') || "Profile opened successfully!");
        } catch (error) {
            console.error("Failed to open linked profile:", error);
            showAlert("error", window.I18n?.t('pinterest.failed_open_profile') || "Failed to open linked profile");
        }
    }

    // Proxy checking modal functions
    function showProxyCheckingModal() {
        const modalHTML = `
            <div class="proxy-checking-modal" id="proxyCheckingModal">
                <div class="proxy-checking-content">
                    <div class="proxy-checking-header">
                        <i class="material-icons spinning">sync</i>
                        <h3>Finding Clean Proxy</h3>
                    </div>
                    <div class="proxy-checking-body">
                        <div class="proxy-status-text" id="proxyStatusText">Initializing proxy check...</div>
                        <div class="proxy-progress-container">
                            <div class="proxy-progress-bar" id="proxyProgressBar" style="width: 0%"></div>
                        </div>
                        <div class="proxy-attempts-log" id="proxyAttemptsLog"></div>
                    </div>
                </div>
            </div>
        `;
        $("body").append(modalHTML);
    }

    function updateProxyCheckingModal(data) {
        const { attempt, maxAttempts, ip, clean, flaggedReasons, error, location } = data;
        const progress = (attempt / maxAttempts) * 100;
        
        $("#proxyProgressBar").css("width", `${progress}%`);
        
        let statusIcon, statusClass, statusText;
        if (error) {
            statusIcon = "error";
            statusClass = "error";
            statusText = `Attempt ${attempt}/${maxAttempts}: Connection error`;
        } else if (clean) {
            statusIcon = "check_circle";
            statusClass = "success";
            statusText = `Attempt ${attempt}/${maxAttempts}: Clean IP found!`;
        } else {
            statusIcon = "warning";
            statusClass = "warning";
            statusText = `Attempt ${attempt}/${maxAttempts}: IP flagged, rotating...`;
        }
        
        $("#proxyStatusText").html(`<span class="${statusClass}"><i class="material-icons">${statusIcon}</i> ${statusText}</span>`);
        
        // Add to log
        const locationStr = location ? `${location.city || ''}, ${location.country?.name || ''}` : '';
        const flagsStr = flaggedReasons && flaggedReasons.length > 0 ? flaggedReasons.join(', ') : '';
        
        let logEntry = `<div class="proxy-log-entry ${statusClass}">`;
        logEntry += `<span class="attempt-num">#${attempt}</span>`;
        logEntry += `<span class="attempt-ip">${ip || 'N/A'}</span>`;
        if (locationStr) logEntry += `<span class="attempt-location">${locationStr}</span>`;
        if (error) {
            logEntry += `<span class="attempt-status error">Error: ${error}</span>`;
        } else if (clean) {
            logEntry += `<span class="attempt-status success">✓ Clean</span>`;
        } else {
            logEntry += `<span class="attempt-status warning">✗ ${flagsStr || 'Flagged'}</span>`;
        }
        logEntry += `</div>`;
        
        $("#proxyAttemptsLog").append(logEntry);
        // Scroll to bottom
        const logContainer = document.getElementById('proxyAttemptsLog');
        if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
    }

    function closeProxyCheckingModal() {
        $("#proxyCheckingModal").remove();
    }

    async function showDirtyProxyConfirmModal(result) {
        return new Promise((resolve) => {
            const flagsHtml = result.flaggedReasons && result.flaggedReasons.length > 0
                ? result.flaggedReasons.map(f => `<span class="flag-badge">${f}</span>`).join('')
                : '<span class="flag-badge">unknown</span>';
            
            const modalHTML = `
                <div class="dirty-proxy-modal" id="dirtyProxyModal">
                    <div class="dirty-proxy-content">
                        <div class="dirty-proxy-header">
                            <i class="material-icons warning-icon">warning</i>
                            <h3>No Clean Proxy Found</h3>
                        </div>
                        <div class="dirty-proxy-body">
                            <p>After <strong>${result.attempts}</strong> attempts, we couldn't find a clean proxy IP.</p>
                            <div class="dirty-proxy-details">
                                <div class="detail-row">
                                    <span class="detail-label">Last IP:</span>
                                    <span class="detail-value">${result.finalIp || 'N/A'}</span>
                                </div>
                                <div class="detail-row">
                                    <span class="detail-label">Flagged as:</span>
                                    <div class="detail-flags">${flagsHtml}</div>
                                </div>
                            </div>
                            <p class="warning-text">
                                <i class="material-icons">info</i>
                                Opening a profile with a flagged proxy may result in account restrictions or bans.
                            </p>
                        </div>
                        <div class="dirty-proxy-actions">
                            <button class="btn btn-outline-dark" id="cancelDirtyProxy">Cancel</button>
                            <button class="btn btn-warning" id="proceedDirtyProxy">
                                <i class="material-icons">open_in_new</i>
                                Open Anyway
                            </button>
                        </div>
                    </div>
                </div>
            `;
            $("body").append(modalHTML);
            
            $("#cancelDirtyProxy").click(() => {
                $("#dirtyProxyModal").remove();
                resolve(false);
            });
            
            $("#proceedDirtyProxy").click(() => {
                $("#dirtyProxyModal").remove();
                resolve(true);
            });
        });
    }

    // Board Export History functions
    function renderCsvExports() {
        try {
            const accordion = $("#boardExportsAccordion");
            const emptyMessage = $("#emptyBoardExports");
            accordion.empty();

            // Get all boards with their export history
            const boardsWithExports = getBoardsWithExportHistory();

            if (boardsWithExports.length === 0) {
                accordion.hide();
                emptyMessage.show();
                updateBoardExportStats(0, 0);
                return;
            }

            accordion.show();
            emptyMessage.hide();

            // Apply filters
            const filteredBoards = applyBoardFilters(boardsWithExports);

            // Group boards by account
            const accountGroups = {};
            filteredBoards.forEach(boardData => {
                if (!accountGroups[boardData.accountId]) {
                    accountGroups[boardData.accountId] = {
                        account: boardData.account,
                        boards: []
                    };
                }
                accountGroups[boardData.accountId].boards.push(boardData.board);
            });

            let totalScheduledPosts = 0;
            let boardsExported = 0;

            const fragment = document.createDocumentFragment();

            Object.entries(accountGroups).forEach(([accountId, data]) => {
                const account = data.account;
                const boards = data.boards;

                // Calculate account-level stats
                let accountTotalPosts = 0;
                let accountBoardsExported = 0;
                let hasRecentExport = false;

                boards.forEach(board => {
                    const exportHistory = board.csvExportHistory;
                    if (exportHistory && exportHistory.lastExportDate) {
                        accountTotalPosts += exportHistory.scheduledPosts.length;
                        accountBoardsExported++;

                        const exportDate = new Date(exportHistory.lastExportDate);
                        const isRecent = (Date.now() - exportDate.getTime()) < 24 * 60 * 60 * 1000;
                        if (isRecent) hasRecentExport = true;
                    }
                });

                totalScheduledPosts += accountTotalPosts;
                boardsExported += accountBoardsExported;

                // Create accordion item
                const accordionItem = document.createElement('div');
                accordionItem.className = 'accordion-item';
                accordionItem.dataset.accountId = accountId;

                // Determine status class
                let statusClass = 'status-never';
                if (accountBoardsExported > 0) {
                    statusClass = hasRecentExport ? 'status-recent' : 'status-older';
                }

                accordionItem.innerHTML = `
                    <div class="accordion-header ${statusClass}">
                        <button class="accordion-button collapsed" type="button" data-account-id="${accountId}">
                            <div class="account-info">
                                <div class="account-email-header">
                                    <i class="material-icons">email</i>
                                    <span>${escapeHtml(account?.email || 'Unknown Account')}</span>
                                    ${account.linkedStructureId ? '<i class="material-icons text-success" title="Linked Profile">link</i>' : ''}
                                </div>
                                <div class="account-stats">
                                    <span class="stat-badge">
                                        <i class="material-icons">dashboard</i>
                                        ${boards.length} ${boards.length === 1 ? (window.I18n?.t('pinterest.board_singular') || 'board') : (window.I18n?.t('pinterest.boards') || 'boards')}
                                    </span>
                                    <span class="stat-badge">
                                        <i class="material-icons">schedule</i>
                                        ${accountTotalPosts} ${accountTotalPosts === 1 ? (window.I18n?.t('pinterest.post') || 'post') : (window.I18n?.t('pinterest.posts') || 'posts')}
                                    </span>
                                    ${accountBoardsExported > 0 ? `
                                        <span class="stat-badge exported">
                                            <i class="material-icons">check_circle</i>
                                            ${accountBoardsExported} ${window.I18n?.t('pinterest.exported') || 'exported'}
                                        </span>
                                    ` : `
                                        <span class="stat-badge not-exported">
                                            <i class="material-icons">cancel</i>
                                            ${window.I18n?.t('pinterest.not_exported') || 'Not exported'}
                                        </span>
                                    `}
                                </div>
                            </div>
                            <i class="material-icons expand-icon">expand_more</i>
                        </button>
                    </div>
                    <div class="accordion-collapse collapse" data-account-id="${accountId}">
                        <div class="accordion-body">
                            <table class="table table-sm boards-table">
                                <thead>
                                    <tr>
                                        <th>${window.I18n?.t('pinterest.board_name_header') || 'Board Name'}</th>
                                        <th>${window.I18n?.t('pinterest.last_export_header') || 'Last Export'}</th>
                                        <th>${window.I18n?.t('pinterest.scheduled_posts_header') || 'Scheduled Posts'}</th>
                                        <th>${window.I18n?.t('pinterest.date_range_header') || 'Date Range'}</th>
                                        <th>${window.I18n?.t('pinterest.actions_header') || 'Actions'}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${boards.map(board => {
                                        const exportHistory = board.csvExportHistory;
                                        let lastExportText = `<span class="never-exported">${window.I18n?.t('pinterest.never') || 'Never'}</span>`;
                                        let scheduledPostsText = '0';
                                        let dateRangeText = '<span class="text-muted">—</span>';
                                        let rowClass = '';

                                        if (exportHistory && exportHistory.lastExportDate) {
                                            const exportDate = new Date(exportHistory.lastExportDate);
                                            const isRecent = (Date.now() - exportDate.getTime()) < 24 * 60 * 60 * 1000;

                                            lastExportText = `<span class="export-date ${isRecent ? 'recently-exported' : ''}">${formatDate(exportHistory.lastExportDate)}</span>`;
                                            scheduledPostsText = `<span class="badge bg-primary">${exportHistory.scheduledPosts.length}</span>`;

                                            if (exportHistory.scheduledPosts.length > 0) {
                                                const dates = exportHistory.scheduledPosts.map(p => new Date(p.scheduledDate));
                                                const minDate = new Date(Math.min(...dates));
                                                const maxDate = new Date(Math.max(...dates));

                                                if (minDate.toDateString() === maxDate.toDateString()) {
                                                    dateRangeText = formatDate(minDate.toISOString());
                                                } else {
                                                    dateRangeText = `${formatDate(minDate.toISOString())} — ${formatDate(maxDate.toISOString())}`;
                                                }
                                            }

                                            rowClass = isRecent ? 'board-recently-exported' : 'board-older-export';
                                        }

                                        return `
                                            <tr class="${rowClass}">
                                                <td>
                                                    <strong>${escapeHtml(board.name)}</strong>
                                                    <div style="font-size: 0.75em; color: #999;">
                                                        ${board.id.substring(0, 8)}...
                                                    </div>
                                                </td>
                                                <td>${lastExportText}</td>
                                                <td>${scheduledPostsText}</td>
                                                <td style="font-size: 0.85em;">${dateRangeText}</td>
                                                <td>
                                                    <div class="btn-group btn-group-sm" role="group">
                                                        <button class="btn btn-outline-primary" onclick="viewScheduleMap('${accountId}', '${board.id}')" title="${window.I18n?.t('pinterest.view_schedule') || 'View Schedule'}">
                                                            <i class="material-icons">schedule</i>
                                                        </button>
                                                        <button class="btn btn-outline-success" onclick="reExportBoardCsv('${accountId}', '${board.id}')" title="${window.I18n?.t('pinterest.re_export') || 'Re-export'}">
                                                            <i class="material-icons">file_download</i>
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;

                fragment.appendChild(accordionItem);
            });

            accordion[0].appendChild(fragment);
            updateBoardExportStats(boardsExported, totalScheduledPosts);

            // Attach click handlers for accordion
            $(".accordion-button").off("click").on("click", function() {
                const accountId = $(this).data("account-id");
                const collapse = $(`.accordion-collapse[data-account-id="${accountId}"]`);
                const button = $(this);

                if (collapse.hasClass("show")) {
                    collapse.removeClass("show");
                    button.addClass("collapsed");
                } else {
                    collapse.addClass("show");
                    button.removeClass("collapsed");
                }
            });

        } catch (error) {
            console.error("Error rendering CSV exports:", error);
            $("#boardExportsAccordion").hide();
            $("#emptyBoardExports").show();
            updateBoardExportStats(0, 0);
        }
    }

    function getBoardsWithExportHistory() {
        const boards = [];

        try {
            Object.entries(allPinterestAccounts).forEach(([accountId, account]) => {
                if (account && account.boards && Array.isArray(account.boards)) {
                    account.boards.forEach(board => {
                        if (board && board.id && board.name) {
                            boards.push({
                                accountId,
                                account,
                                board
                            });
                        }
                    });
                }
            });
        } catch (error) {
            console.error("Error getting boards with export history:", error);
        }

        return boards;
    }

    function applyBoardFilters(boards) {
        const searchTerm = $("#boardSearch").val().toLowerCase();
        const statusFilter = $("#exportStatusFilter").val();
        const fromDate = $("#fromDate").val();
        const toDate = $("#toDate").val();

        return boards.filter(boardData => {
            // Search filter
            if (searchTerm) {
                const boardName = (boardData.board?.name || '').toLowerCase();
                const accountEmail = (boardData.account?.email || '').toLowerCase();
                if (!boardName.includes(searchTerm) && !accountEmail.includes(searchTerm)) {
                    return false;
                }
            }

            // Status filter
            if (statusFilter) {
                const exportHistory = boardData.board.csvExportHistory;
                const hasExport = exportHistory && exportHistory.lastExportDate;

                if (statusFilter === 'never' && hasExport) return false;
                if (statusFilter === 'recent' && (!hasExport || (Date.now() - new Date(exportHistory.lastExportDate).getTime()) > 24 * 60 * 60 * 1000)) return false;
                if (statusFilter === 'older' && (!hasExport || (Date.now() - new Date(exportHistory.lastExportDate).getTime()) <= 24 * 60 * 60 * 1000)) return false;
            }

            // Date range filter
            if (fromDate || toDate) {
                const exportHistory = boardData.board.csvExportHistory;
                if (!exportHistory || !exportHistory.lastExportDate) return false;

                const exportDate = new Date(exportHistory.lastExportDate).toISOString().split('T')[0];

                if (fromDate && exportDate < fromDate) return false;
                if (toDate && exportDate > toDate) return false;
            }

            return true;
        });
    }

    function updateBoardExportStats(boardsExported, totalScheduledPosts) {
        $("#totalBoardsExported").text(boardsExported);
        $("#totalScheduledPosts").text(totalScheduledPosts);

        const fromDate = $("#fromDate").val();
        const toDate = $("#toDate").val();

        let dateRangeInfo = window.I18n?.t('pinterest.all_time_label') || "All time";
        if (fromDate || toDate) {
            if (fromDate && toDate) {
                dateRangeInfo = `${fromDate} to ${toDate}`;
            } else if (fromDate) {
                dateRangeInfo = `From ${fromDate}`;
            } else {
                dateRangeInfo = `Until ${toDate}`;
            }
        }

        $("#dateRangeInfo").text(dateRangeInfo);
    }

    async function refreshCsvExports() {
        try {
            // Reload Pinterest accounts data
            allPinterestAccounts = await window.electronAPI.readKey("pinterestAccounts") || {};

            // Re-render the board exports table
            renderCsvExports();

            showAlert("success", "Board export history refreshed successfully!");
        } catch (error) {
            console.error("Failed to refresh board exports:", error);
            showAlert("error", "Failed to refresh board export history: " + error.message);
        }
    }

    // Weekly Calendar State
    let currentWeekStart = null;
    let currentBoardPosts = [];

    function viewScheduleMap(accountId, boardId) {
        const account = allPinterestAccounts[accountId];
        const board = account ? account.boards.find(b => b.id === boardId) : null;

        if (!board || !board.csvExportHistory || !board.csvExportHistory.scheduledPosts.length) {
            showAlert("error", "No schedule information found for this board");
            return;
        }

        const exportHistory = board.csvExportHistory;
        const modal = new bootstrap.Modal(document.getElementById('scheduleModal'));

        // Store current board posts and info
        currentBoardPosts = exportHistory.scheduledPosts;
        currentWeekStart = getWeekStart(new Date(exportHistory.scheduledPosts[0].scheduledDate));

        // Populate modal header
        $("#scheduleBoardName").text(board.name);
        $("#scheduleAccountEmail").text(account.email);
        $("#schedulePostCount").text(exportHistory.scheduledPosts.length);
        $("#scheduleExportDate").text(formatDate(exportHistory.lastExportDate));

        // Render the weekly calendar
        renderWeeklyCalendar();

        // Store current board info for re-export
        $("#scheduleModal").data('accountId', accountId).data('boardId', boardId);

        modal.show();
    }

    function getWeekStart(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Monday start
        return new Date(d.setDate(diff));
    }

    function getWeekEnd(weekStart) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        return weekEnd;
    }

    function formatWeekRange(weekStart) {
        const weekEnd = getWeekEnd(weekStart);
        const options = { month: 'short', day: 'numeric' };

        if (weekStart.getFullYear() !== weekEnd.getFullYear()) {
            return `${weekStart.toLocaleDateString('en-US', { ...options, year: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { ...options, year: 'numeric' })}`;
        } else if (weekStart.getMonth() !== weekEnd.getMonth()) {
            return `${weekStart.toLocaleDateString('en-US', options)} - ${weekEnd.toLocaleDateString('en-US', { ...options, year: 'numeric' })}`;
        } else {
            return `${weekStart.toLocaleDateString('en-US', options)} - ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
        }
    }

    function renderWeeklyCalendar() {
        // Update week navigation
        $("#currentWeekRange").text(formatWeekRange(currentWeekStart));

        // Get time range settings
        const startHour = parseInt($("#startHour").val()) || 0;
        const endHour = parseInt($("#endHour").val()) || 23;

        // Generate calendar grid
        const calendarGrid = $("#calendarGrid");
        calendarGrid.empty();

        // Group posts by date and hour
        const postsGrid = groupPostsByDateTime(currentBoardPosts, currentWeekStart);

        // Create time rows
        for (let hour = startHour; hour <= endHour; hour++) {
            const timeRow = createTimeRow(hour, postsGrid);
            calendarGrid.append(timeRow);
        }

        // Highlight today if in current week
        highlightToday();
    }

    function groupPostsByDateTime(posts, weekStart) {
        const grid = {};
        const weekEnd = getWeekEnd(weekStart);

        posts.forEach(post => {
            const postDate = new Date(post.scheduledDate);

            // Only include posts within the current week
            if (postDate >= weekStart && postDate <= weekEnd) {
                const dayOfWeek = (postDate.getDay() + 6) % 7; // Convert to Monday = 0
                const hour = postDate.getHours();
                const key = `${dayOfWeek}-${hour}`;

                if (!grid[key]) {
                    grid[key] = [];
                }

                grid[key].push(post);
            }
        });

        return grid;
    }

    function createTimeRow(hour, postsGrid) {
        const timeLabel = formatHour(hour);
        const row = $(`
            <div class="time-row">
                <div class="time-slot">${timeLabel}</div>
            </div>
        `);

        // Create day slots (Monday to Sunday)
        for (let day = 0; day < 7; day++) {
            const key = `${day}-${hour}`;
            const daySlot = $('<div class="day-slot"></div>');

            if (postsGrid[key]) {
                postsGrid[key].forEach(post => {
                    const postCard = createPostCard(post);
                    daySlot.append(postCard);
                });
            }

            row.append(daySlot);
        }

        return row;
    }

    function createPostCard(post) {
        const truncatedTitle = post.postTitle.length > 20 ? post.postTitle.substring(0, 20) + '...' : post.postTitle;
        const card = $(`
            <div class="post-card" title="${escapeHtml(post.postTitle)}">
                ${escapeHtml(truncatedTitle)}
            </div>
        `);

        card.on('click', () => showPostDetails(post));
        return card;
    }

    function showPostDetails(post) {
        const scheduledDate = new Date(post.scheduledDate);
        const dateStr = scheduledDate.toLocaleDateString();
        const timeStr = scheduledDate.toLocaleTimeString('en-GB', { hour12: false }); // 24-hour format

        const modalContent = `
            <div class="post-details">
                <h6>${escapeHtml(post.postTitle)}</h6>
                <hr>
                <p><strong>Scheduled:</strong> ${dateStr} at ${timeStr}</p>
                <p><strong>Profile:</strong> ${escapeHtml(post.profileName)}</p>
                <p><strong>Workflow:</strong> ${escapeHtml(post.workflowName)}</p>
                ${post.postDescription ? `<p><strong>Description:</strong><br>${escapeHtml(post.postDescription)}</p>` : ''}
                <div class="mt-3">
                    ${post.mediaUrl ? `<button class="btn btn-outline-primary btn-sm me-2" onclick="window.open('${escapeHtml(post.mediaUrl)}', '_blank')">View Media</button>` : ''}
                    ${post.linkUrl ? `<button class="btn btn-outline-secondary btn-sm" onclick="window.open('${escapeHtml(post.linkUrl)}', '_blank')">Visit Link</button>` : ''}
                </div>
            </div>
        `;

        showDynamicModal("Post Details", modalContent);
    }

    function formatHour(hour) {
        return `${hour.toString().padStart(2, '0')}:00`;
    }

    function highlightToday() {
        const today = new Date();
        if (today >= currentWeekStart && today <= getWeekEnd(currentWeekStart)) {
            const dayOfWeek = (today.getDay() + 6) % 7;

            // Highlight day header
            $(".day-header").eq(dayOfWeek + 1).addClass("today");

            // Highlight day slots
            $(".time-row").each(function() {
                $(this).find(".day-slot").eq(dayOfWeek).addClass("today");
            });
        }
    }

    function navigateWeek(direction) {
        const newWeekStart = new Date(currentWeekStart);
        newWeekStart.setDate(currentWeekStart.getDate() + (direction * 7));
        currentWeekStart = newWeekStart;
        renderWeeklyCalendar();
    }

    function goToCurrentWeek() {
        if (currentBoardPosts.length > 0) {
            currentWeekStart = getWeekStart(new Date(currentBoardPosts[0].scheduledDate));
        } else {
            currentWeekStart = getWeekStart(new Date());
        }
        renderWeeklyCalendar();
    }

    function showAllHours() {
        $("#startHour").val(0);
        $("#endHour").val(23);
        renderWeeklyCalendar();
    }

    async function reExportBoardCsv(accountId, boardId) {
        try {
            const confirmed = await confirmPrompt("Re-export CSV for this board? This will navigate to the Workflows page.");
            if (confirmed) {
                sessionStorage.setItem('reExportBoardId', `${accountId}:${boardId}`);

                if (window.navigateToPage) {
                    window.navigateToPage('workflows');
                } else {
                    showAlert("info", "Please navigate to the Workflows page to re-export.");
                }
            }
        } catch (error) {
            console.error("Failed to re-export board CSV:", error);
            showAlert("error", "Failed to re-export board CSV");
        }
    }

    // Event handlers
    $(document).ready(function() {
        // Clean up any existing event listeners
        $(document).off(PINTEREST_NAMESPACE);
        $("#pinterest-accounts-container").off(PINTEREST_NAMESPACE);

        // Load initial data
        loadData();

        // Account management events
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#newPinterestAccount", function() {
            showAccountModal();
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "[data-role='editAccount']", function() {
            const accountId = $(this).data("id");
            showAccountModal(accountId);
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "[data-role='deleteAccount']", function() {
            const accountId = $(this).data("id");
            deleteAccount(accountId);
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "[data-role='openProfile']", function() {
            const accountId = $(this).data("account-id");
            openLinkedProfile(accountId);
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "[data-role='viewTitles']", function() {
            const accountId = $(this).data("id");
            $("#filterAccount").val(accountId).trigger("change");
        });

        // Modal events
        $("#accountModal").on("click" + PINTEREST_NAMESPACE, "#addBoard", function() {
            addBoardToModal();
        });

        $("#accountModal").on("click" + PINTEREST_NAMESPACE, ".remove-board", function() {
            $(this).closest(".board-item").remove();
        });

        $("#accountModal").on("click" + PINTEREST_NAMESPACE, "#saveAccount", function() {
            saveAccount();
        });

        // Account selection change
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#selectedAccount", function() {
            updateBoardSelectors();
            // Set default prompt if empty
            if (!$("#titlePrompt").val().trim()) {
                $("#titlePrompt").val(DEFAULT_PROMPT);
            }
            updateBoardNamePreview();
        });

        // Board selection change
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#selectedBoard", function() {
            // Set default prompt if empty
            if (!$("#titlePrompt").val().trim()) {
                $("#titlePrompt").val(DEFAULT_PROMPT);
            }
            updateBoardNamePreview();
        });

        // Multi-account mode toggle
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#multiAccountMode", function() {
            toggleMultiAccountMode($(this).is(":checked"));
        });

        // Multi-account: Select/Deselect all
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#selectAllAccounts", function() {
            $(".account-multi-checkbox:not(:disabled)").prop("checked", true);
            updateMultiAccountSummary();
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#deselectAllAccounts", function() {
            $(".account-multi-checkbox").prop("checked", false);
            updateMultiAccountSummary();
        });

        // Multi-account: Individual checkbox change
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, ".account-multi-checkbox", function() {
            updateMultiAccountSummary();
        });

        // Multi-account: Board number change
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#boardNumber", function() {
            const boardNumber = parseInt($(this).val());
            updateAccountAvailability(boardNumber);
            updateMultiAccountSummary();
        });

        // Multi-account: Title count change - update summary
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#titleCount", function() {
            if (isMultiAccountMode) {
                updateMultiAccountSummary();
            }
        });

        // Title prompt input change to show/hide board name preview
        $("#pinterest-accounts-container").on("input" + PINTEREST_NAMESPACE, "#titlePrompt", function() {
            updateBoardNamePreview();
        });

        // Save prompt button
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#savePromptBtn", function() {
            savePrompt();
        });

        // Pinterest Trends toggle
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#usePinterestTrends", function() {
            togglePinterestTrends($(this).is(":checked"));
        });

        // Pinterest Trends category/country change - clear cache
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#trendCategory, #trendCountry", function() {
            cachedTrends = null;
            $("#trendsPreview").hide();
            $("#trendsFetchStatus").show();
            $("#trendsFetchStatusText").text("Trends will be fetched when generating titles...");
        });

        // Filter changes
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#filterAccount, #filterBoard", function() {
            renderTitles();
        });

        // Load more titles (pagination)
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#loadMoreTitles", function() {
            loadMoreTitles();
        });

        // Title generation
        $("#pinterest-accounts-container").on("submit" + PINTEREST_NAMESPACE, "#titleGenerationForm", function(e) {
            e.preventDefault();
            generateTitles();
        });

        // Title actions
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "[data-role='copyTitle']", function() {
            const titleText = $(this).data("title");
            copyTitle(titleText);
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "[data-role='deleteTitle']", function() {
            const titleId = $(this).data("id");
            deleteTitle(titleId);
        });

        // Bulk title selection events
        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, ".title-select", function() {
            updateBulkSelectionState();
        });

        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#selectAllTitles", function() {
            const isChecked = $(this).prop("checked");
            $(".title-select").prop("checked", isChecked);
            updateBulkSelectionState();
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#deleteSelectedTitles", function() {
            deleteSelectedTitles();
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#deleteAllUnusedTitles", function() {
            deleteAllUnusedTitles();
        });

        // Sync title usage with workflows button
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#syncTitleUsage", function() {
            syncTitleUsageWithWorkflows();
        });

        // Board Export events
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#refreshCsvExports", function() {
            refreshCsvExports();
        });

        // Search and filter events
        $("#pinterest-accounts-container").on("input" + PINTEREST_NAMESPACE, "#boardSearch", function() {
            renderCsvExports();
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#clearSearch", function() {
            $("#boardSearch").val("");
            renderCsvExports();
        });

        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#exportStatusFilter", function() {
            renderCsvExports();
        });

        $("#pinterest-accounts-container").on("change" + PINTEREST_NAMESPACE, "#fromDate, #toDate", function() {
            renderCsvExports();
        });

        // Expand/Collapse all accordion events
        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#expandAllAccounts", function() {
            $(".accordion-collapse").addClass("show");
            $(".accordion-button").removeClass("collapsed");
        });

        $("#pinterest-accounts-container").on("click" + PINTEREST_NAMESPACE, "#collapseAllAccounts", function() {
            $(".accordion-collapse").removeClass("show");
            $(".accordion-button").addClass("collapsed");
        });

        // Schedule modal events
        $("#scheduleModal").on("click" + PINTEREST_NAMESPACE, "#reExportBoard", function() {
            const accountId = $("#scheduleModal").data('accountId');
            const boardId = $("#scheduleModal").data('boardId');
            if (accountId && boardId) {
                bootstrap.Modal.getInstance(document.getElementById('scheduleModal')).hide();
                reExportBoardCsv(accountId, boardId);
            }
        });

        // Week navigation events
        $("#scheduleModal").on("click" + PINTEREST_NAMESPACE, "#prevWeek", function() {
            navigateWeek(-1);
        });

        $("#scheduleModal").on("click" + PINTEREST_NAMESPACE, "#nextWeek", function() {
            navigateWeek(1);
        });

        $("#scheduleModal").on("click" + PINTEREST_NAMESPACE, "#todayWeek", function() {
            goToCurrentWeek();
        });

        $("#scheduleModal").on("click" + PINTEREST_NAMESPACE, "#showAllHours", function() {
            showAllHours();
        });

        // Time range change events
        $("#scheduleModal").on("change" + PINTEREST_NAMESPACE, "#startHour, #endHour", function() {
            renderWeeklyCalendar();
        });

        // Global functions for onclick handlers
        window.viewScheduleMap = viewScheduleMap;
        window.reExportBoardCsv = reExportBoardCsv;
    });

    // Bulk title management functions
    function updateBulkSelectionState() {
        const checkboxes = $(".title-select");
        const checked = checkboxes.filter(":checked");
        const selectedCount = checked.length;

        // Update the selected count display
        const selectedText = window.I18n?.t('pinterest.selected') || 'selected';
        $("#selectedCount").text(`${selectedCount} ${selectedText}`);

        // Update the select all checkbox state
        const selectAllCheckbox = $("#selectAllTitles");
        if (selectedCount === 0) {
            selectAllCheckbox.prop("indeterminate", false).prop("checked", false);
        } else if (selectedCount === checkboxes.length) {
            selectAllCheckbox.prop("indeterminate", false).prop("checked", true);
        } else {
            selectAllCheckbox.prop("indeterminate", true).prop("checked", false);
        }

        // Enable/disable the delete button
        $("#deleteSelectedTitles").prop("disabled", selectedCount === 0);
    }

    async function deleteAllUnusedTitles() {
        // Count total titles and used titles for verification
        const totalTitles = Object.keys(allPinterestTitles).length;
        const usedTitleIds = Object.entries(allPinterestTitles)
            .filter(([_, title]) => title.used === true)
            .map(([id, _]) => id);
        
        // Find all unused titles (explicitly check for used !== true)
        const unusedTitleIds = Object.entries(allPinterestTitles)
            .filter(([_, title]) => title.used !== true)
            .map(([id, _]) => id);

        if (unusedTitleIds.length === 0) {
            showAlert("info", "No unused titles to delete");
            return;
        }

        const confirmed = await confirmPrompt(
            `Delete ${unusedTitleIds.length} unused titles?\n\n` +
            `• Total titles: ${totalTitles}\n` +
            `• Used in workflows: ${usedTitleIds.length} (will be kept)\n` +
            `• Unused: ${unusedTitleIds.length} (will be deleted)\n\n` +
            `This action cannot be undone.`
        );
        if (!confirmed) {
            return;
        }

        try {
            // Remove all unused titles
            unusedTitleIds.forEach(titleId => {
                delete allPinterestTitles[titleId];
            });

            // Save the updated data
            await saveTitlesData();

            // Refresh the display
            renderTitles();

            // Show success message
            showAlert("success", `Successfully deleted ${unusedTitleIds.length} unused title(s)`);
        } catch (error) {
            console.error("Error deleting unused titles:", error);
            showAlert("error", "Error deleting titles. Please try again.");
        }
    }

    // Sync title usage status with existing workflows
    // This marks titles as used if they appear in any workflow's posts
    async function syncTitleUsageWithWorkflows() {
        try {
            showAlert("info", "Scanning workflows to sync title usage status...");
            
            // Get all workflows from the database
            const workflows = await window.electronAPI.invoke('get-all-workflows') || {};
            
            // Collect all Pinterest title IDs that are used in workflows
            const usedTitleIds = new Set();
            
            Object.values(workflows).forEach(workflow => {
                if (workflow.posts && Array.isArray(workflow.posts)) {
                    workflow.posts.forEach(post => {
                        if (post.pinterestTitleId) {
                            usedTitleIds.add(post.pinterestTitleId);
                        }
                    });
                }
            });
            
            // Count current status
            const totalTitles = Object.keys(allPinterestTitles).length;
            const currentlyMarkedUsed = Object.values(allPinterestTitles).filter(t => t.used === true).length;
            
            // Update titles that are in workflows but not marked as used
            let newlyMarkedUsed = 0;
            let alreadyMarkedUsed = 0;
            
            usedTitleIds.forEach(titleId => {
                if (allPinterestTitles[titleId]) {
                    if (allPinterestTitles[titleId].used !== true) {
                        allPinterestTitles[titleId].used = true;
                        newlyMarkedUsed++;
                    } else {
                        alreadyMarkedUsed++;
                    }
                }
            });
            
            // Save if any changes were made
            if (newlyMarkedUsed > 0) {
                await saveTitlesData();
                renderTitles();
            }
            
            const unusedCount = totalTitles - currentlyMarkedUsed - newlyMarkedUsed;
            
            showAlert("success", 
                `Sync complete!\n\n` +
                `• Total titles: ${totalTitles}\n` +
                `• Found in workflows: ${usedTitleIds.size}\n` +
                `• Newly marked as used: ${newlyMarkedUsed}\n` +
                `• Already marked as used: ${alreadyMarkedUsed}\n` +
                `• Truly unused: ${unusedCount}`
            );
            
            return {
                total: totalTitles,
                foundInWorkflows: usedTitleIds.size,
                newlyMarked: newlyMarkedUsed,
                alreadyMarked: alreadyMarkedUsed,
                unused: unusedCount
            };
        } catch (error) {
            console.error("Error syncing title usage:", error);
            showAlert("error", "Failed to sync title usage: " + error.message);
            return null;
        }
    }

    async function deleteSelectedTitles() {
        const selectedTitleIds = $(".title-select:checked").map(function() {
            return $(this).data("title-id");
        }).get();

        if (selectedTitleIds.length === 0) {
            return;
        }

        const confirmed = await confirmPrompt(window.I18n?.t('pinterest_accounts.confirm_delete_titles', { count: selectedTitleIds.length }) || `Are you sure you want to delete ${selectedTitleIds.length} selected title(s)? This action cannot be undone.`);
        if (!confirmed) {
            return;
        }

        try {
            // Remove selected titles from the data
            selectedTitleIds.forEach(titleId => {
                delete allPinterestTitles[titleId];
            });

            // Save the updated data
            await saveTitlesData();

            // Refresh the display
            renderTitles();

            // Show success message
            showToast(`Successfully deleted ${selectedTitleIds.length} title(s)`, "success");
        } catch (error) {
            console.error("Error deleting selected titles:", error);
            showToast("Error deleting titles. Please try again.", "error");
        }
    }

    // Export functions for use by other modules
    window.PinterestAccounts = {
        getAllAccounts: () => allPinterestAccounts,
        getAllTitles: () => allPinterestTitles,
        getTitlesByBoard: (accountId, boardId) => {
            return Object.entries(allPinterestTitles)
                .filter(([_, title]) => title.accountId === accountId && title.boardId === boardId && !title.used)
                .map(([id, title]) => ({ id, ...title }));
        },
        markTitleAsUsed: async (titleId) => {
            if (allPinterestTitles[titleId]) {
                allPinterestTitles[titleId].used = true;
                await saveTitlesData();
                renderTitles();
            }
        },
        getBoardName: (accountId, boardId) => {
            const account = allPinterestAccounts[accountId];
            if (!account || !account.boards) return null;
            const board = account.boards.find(b => b.id === boardId);
            return board ? board.name : null;
        },
        refreshData: loadData,
        refreshCsvExports: refreshCsvExports,
        syncTitleUsage: syncTitleUsageWithWorkflows
    };
})();