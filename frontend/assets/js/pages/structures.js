$(document).ready(function () {

    // Chrome versions - will be populated dynamically from public API
    let CHROME_VERSIONS = ["142.0.0.0"]; // Fallback if API fails
    let latestChromeVersion = null;
    
    // Fetch latest Chrome version from public API on page load
    async function fetchLatestChromeVersion() {
        try {
            const result = await window.electronAPI.getStableChromeVersion();
            if (result && result.full) {
                latestChromeVersion = result.full;
                // Generate version variants for more realistic fingerprints
                const major = result.major;
                const fullParts = result.full.split('.');
                const build = fullParts[2] || '0';
                // Create variations based on patch numbers (typical Chrome updates)
                CHROME_VERSIONS = [
                    result.full,
                    `${major}.0.${build}.${parseInt(fullParts[3] || 0) + 1}`,
                    `${major}.0.${build}.${parseInt(fullParts[3] || 0) + 2}`,
                    `${major}.0.${build}.${parseInt(fullParts[3] || 0) + 3}`
                ];
                console.log(`[Structures] Loaded Chrome versions:`, CHROME_VERSIONS);
            }
        } catch (err) {
            console.warn(`[Structures] Failed to fetch Chrome version, using fallback:`, err.message);
        }
    }
    
    // Initialize Chrome version on page load
    fetchLatestChromeVersion();

    // Detect the real OS platform once - always use this for fingerprints
    const REAL_PLATFORM = (function() {
        try {
            if (navigator.platform) {
                const p = navigator.platform;
                if (p.includes('Win')) return 'Win32';
                if (p.includes('Mac')) return 'MacIntel';
                if (p.includes('Linux')) return 'Linux x86_64';
            }
            if (navigator.userAgentData && navigator.userAgentData.platform) {
                const p = navigator.userAgentData.platform;
                if (p.includes('Win') || p === 'Windows') return 'Win32';
                if (p.includes('Mac') || p === 'macOS') return 'MacIntel';
                if (p.includes('Linux')) return 'Linux x86_64';
            }
            const ua = navigator.userAgent.toLowerCase();
            if (ua.includes('mac')) return 'MacIntel';
            if (ua.includes('linux')) return 'Linux x86_64';
        } catch (e) {
            console.log('[Structures] Could not detect real platform:', e);
        }
        return 'Win32'; // Default fallback
    })();
    console.log('[Structures] Detected real OS platform:', REAL_PLATFORM);

    let openStructure;

    function escapeHtml(value) {
        return $("<div>").text(String(value ?? "")).html();
    }

    /**
     * Parses various proxy string formats into structured data
     * Supported formats:
     * - user:pass@host:port (standard URL format, like Rayobyte)
     * - host:port:user:pass (colon-separated)
     * - host:port (no auth)
     * - socks5://user:pass@host:port (with protocol)
     * - http://user:pass@host:port (with protocol)
     */
    function parseProxyString(proxyString) {
        if (!proxyString || typeof proxyString !== 'string') return null;
        
        proxyString = proxyString.trim();
        
        // Remove protocol prefix if present (http://, https://, socks5://, socks4://)
        proxyString = proxyString.replace(/^(https?|socks[45]?):\/\//i, '');
        
        let ip = '', port = '', username = '', password = '';
        
        // Format 1: user:pass@host:port (standard URL format - Rayobyte style)
        if (proxyString.includes('@')) {
            const atIndex = proxyString.lastIndexOf('@');
            const authPart = proxyString.substring(0, atIndex);
            const hostPart = proxyString.substring(atIndex + 1);
            
            // Parse host:port
            const hostPortMatch = hostPart.match(/^([^:]+):(\d+)$/);
            if (hostPortMatch) {
                ip = hostPortMatch[1];
                port = hostPortMatch[2];
            } else {
                ip = hostPart;
            }
            
            // Parse user:pass (password may contain colons)
            const firstColonIndex = authPart.indexOf(':');
            if (firstColonIndex > -1) {
                username = authPart.substring(0, firstColonIndex);
                password = authPart.substring(firstColonIndex + 1);
            } else {
                username = authPart;
            }
        }
        // Format 2: host:port:user:pass (colon-separated, 4 parts)
        else {
            const parts = proxyString.split(':');
            if (parts.length >= 4) {
                // host:port:user:pass
                ip = parts[0];
                port = parts[1];
                username = parts[2];
                // Password may contain colons, so join remaining parts
                password = parts.slice(3).join(':');
            } else if (parts.length === 2) {
                // Just host:port
                ip = parts[0];
                port = parts[1];
            } else if (parts.length === 3) {
                // Could be host:port:user or ambiguous
                ip = parts[0];
                port = parts[1];
                username = parts[2];
            }
        }
        
        return { ip, port, username, password };
    }

    $("#structures-page").on("click", "#newStructure", async function () {
        const structureNameField = window.I18n?.t('common.structure_name') || "Structure name";
        const result = await newPrompt([
            { type: "text", name: structureNameField, required: true }
        ]);
        if (!result) return;
        const structures = await window.electronAPI.readKey("structures");
        structures[generateRandomString(10)] = {
            label: result[structureNameField],
            profiles: {}
        };
        await window.electronAPI.updateData("structures", structures);
        updateStructures();
    });

    $("#structures-page").on("click", '[data-role="deleteStructure"]', async function () {
        const id = $(this).attr("data-id");
        const confirmed = await confirmPrompt();
        if (!confirmed) return;
        const structures = await window.electronAPI.readKey("structures") || [];
        delete structures[id];
        await window.electronAPI.updateData("structures", structures);
        updateStructures();
    });

    $("#structures-page").on("click", '[data-role="editStructure"]', async function () {
        const id = $(this).attr("data-id");
        openStructure = id;
        updateStructureArea();
    });

    async function updateStructureArea() {
        const id = openStructure;
        const structures = await window.electronAPI.readKey("structures") || [];
        const structure = structures[id];
        const profiles = structure.profiles;

        // Show structure area and hide list
        $(".structure-area").show();
        $(".structures-list-container").hide();

        // Update header info
        $("#structureName").text(structure.label);
        const profileCount = Object.keys(profiles).length;
        const profileText = profileCount === 1 ? window.I18n?.t('common.profile') || 'profile' : window.I18n?.t('common.profiles') || 'profiles';
        $("#profileCount").text(`${profileCount} ${profileText}`);

        // Clear and rebuild profiles grid
        $("#profilesGrid").empty();

        if (profileCount === 0) {
            $("#profilesEmpty").show();
            $("#profilesGrid").hide();
        } else {
            $("#profilesEmpty").hide();
            $("#profilesGrid").show();

            $.each(profiles, function (id, profile) {
                const badgeClass = profile.type === "advertiser" ? "badge-advertiser" :
                                  (profile.type === "poster" ? "badge-poster" : "badge-admin");
                const profileClass = profile.type === "advertiser" ? "profile-advertiser" :
                                    (profile.type === "poster" ? "profile-poster" : "profile-admin");

                const hasProxy = profile.proxy && profile.proxy.ip;
                const hasFingerprint = profile.fingerprint;
                const hasCookies = profile.cookies && profile.cookies.length > 0;
                const cookieCount = profile.cookies?.length || 0;
                const proxyLabel = window.I18n?.t('common.proxy') || 'Proxy';
                const noProxyLabel = window.I18n?.t('common.no_proxy') || 'No Proxy';
                const proxyText = hasProxy ? `${proxyLabel}: ${profile.proxy.ip}${profile.proxy.port ? ':' + profile.proxy.port : ''}` : noProxyLabel;
                const canTransfer = Object.keys(structures).some(structureId => structureId !== openStructure);

                const profileCard = `
                    <div class="profile-card ${profileClass}">
                        <div class="profile-card-header">
                            <span class="profile-type-badge ${badgeClass}">${ucfirst(window.I18n?.t('common.' + profile.type) || profile.type)}</span>
                            <span class="browser-type-badge browser-vc" title="VCBrowser">
                                <i class="material-icons">security</i>
                            </span>
                        </div>
                        <div class="profile-card-body">
                            <div class="profile-name">${profile.label}</div>
                            <div class="profile-id" style="font-size:11px;color:#888;font-family:monospace;margin-top:2px;">ID: ${id}</div>
                            <div class="profile-status-indicators">
                                <div class="profile-indicator ${hasProxy ? 'active' : 'inactive'}">
                                    <i class="material-icons">${hasProxy ? 'vpn_lock' : 'lock_open'}</i>
                                    <span>${proxyText}</span>
                                </div>
                                <div class="profile-indicator ${hasFingerprint ? 'active' : 'inactive'}">
                                    <i class="material-icons">fingerprint</i>
                                    <span>${hasFingerprint ? (window.I18n?.t('common.fingerprint_set') || 'Fingerprint Set') : (window.I18n?.t('common.no_fingerprint') || 'No Fingerprint')}</span>
                                </div>
                                <div class="profile-indicator ${hasCookies ? 'active' : 'inactive'}">
                                    <i class="material-icons">cookie</i>
                                    <span>${hasCookies ? cookieCount + ' ' + (window.I18n?.t('common.cookies') || 'Cookies') : (window.I18n?.t('common.no_cookies') || 'No Cookies')}</span>
                                </div>
                            </div>
                        </div>
                        <div class="profile-card-actions">
                            <button data-role="openProfile" data-id="${id}" class="profile-btn profile-btn-open" data-tooltip="${window.I18n?.t('common.open_profile') || 'Open Profile'}">
                                <i class="material-icons">open_in_new</i>
                                <span>${window.I18n?.t('common.open') || 'Open'}</span>
                            </button>
                            <button data-role="manage2FA" data-id="${id}" class="profile-btn profile-btn-2fa" data-tooltip="${window.I18n?.t('structures.tofa_manage') || '2FA Keys'}">
                                <i class="material-icons">security</i>
                            </button>
                            <button data-role="manageCookies" data-id="${id}" class="profile-btn profile-btn-cookies" data-tooltip="${window.I18n?.t('common.manage_cookies') || 'Manage Cookies'}">
                                <i class="material-icons">cookie</i>
                            </button>
                            <button data-role="configureSettings" data-id="${id}" class="profile-btn profile-btn-settings" data-tooltip="${window.I18n?.t('common.configure_settings') || 'Configure Settings'}">
                                <i class="material-icons">settings</i>
                            </button>
                            ${canTransfer ? `
                            <button data-role="transferProfile" data-id="${id}" class="profile-btn profile-btn-transfer" data-tooltip="${window.I18n?.t('structures.transfer_profile') || 'Transfer Profile'}">
                                <i class="material-icons">drive_file_move</i>
                            </button>` : ''}
                            <button data-role="deleteProfile" data-id="${id}" class="profile-btn profile-btn-delete" data-tooltip="${window.I18n?.t('common.delete_profile') || 'Delete Profile'}">
                                <i class="material-icons">delete</i>
                            </button>
                        </div>
                    </div>
                `;

                $("#profilesGrid").append(profileCard);
            });
        }
    }

    $("#structures-page").on("click", '[data-role="configureSettings"]', async function () {
        const id = $(this).attr("data-id");
        if (!openStructure) return;
        await showUnifiedProfileModal(id, true);
    });

    // Cookie management modal
    $("#structures-page").on("click", '[data-role="manageCookies"]', async function () {
        const profileId = $(this).attr("data-id");
        if (!openStructure) return;
        await showCookiesModal(profileId);
    });

    async function showCookiesModal(profileId) {
        const structures = await window.electronAPI.readKey("structures") || {};
        const profile = structures[openStructure]?.profiles[profileId];
        if (!profile) return;

        const existingCookies = profile.cookies ? JSON.stringify(profile.cookies, null, 2) : '';
        const cookieCount = profile.cookies?.length || 0;

        const manageCookiesTitle = window.I18n?.t('common.manage_cookies') || 'Manage Cookies';
        const pasteCookiesText = window.I18n?.t('common.paste_cookies_json') || 'Paste cookies in JSON format. These cookies will be automatically injected when the profile browser is opened.';
        const currentStatusText = window.I18n?.t('common.current_status') || 'Current Status';
        const cookiesStoredText = window.I18n?.t('common.cookies_stored') || 'cookies stored';
        const noCookiesText = window.I18n?.t('common.no_cookies') || 'No cookies';
        const clearAllText = window.I18n?.t('common.clear_all') || 'Clear All';
        const cancelText = window.I18n?.t('common.cancel') || 'Cancel';
        const saveCookiesText = window.I18n?.t('common.save_cookies') || 'Save Cookies';

        const modalHTML = `
            <div class="cookies-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;">
                <div style="background:white;border-radius:10px;padding:30px;max-width:700px;width:90%;max-height:80vh;display:flex;flex-direction:column;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
                        <h3 style="margin:0;display:flex;align-items:center;gap:10px;">
                            <i class="material-icons" style="color:#FF9800;">cookie</i>
                            ${manageCookiesTitle} - ${profile.label}
                        </h3>
                        <button class="close-cookies-modal" style="background:none;border:none;cursor:pointer;padding:5px;">
                            <i class="material-icons">close</i>
                        </button>
                    </div>
                    <p style="color:#666;margin-bottom:15px;font-size:14px;">${pasteCookiesText}</p>
                    <div style="background:#f5f5f5;padding:10px;border-radius:5px;margin-bottom:15px;font-size:12px;">
                        <strong>${currentStatusText}:</strong> ${cookieCount > 0 ? '<span style="color:#4CAF50;">' + cookieCount + ' ' + cookiesStoredText + '</span>' : '<span style="color:#999;">' + noCookiesText + '</span>'}
                    </div>
                    <textarea id="cookies-json" placeholder='[{"name":"session","value":"abc123","domain":".example.com","path":"/","httpOnly":true,"secure":true}]' style="width:100%;height:300px;padding:15px;border:1px solid #ddd;border-radius:5px;font-family:monospace;font-size:12px;resize:vertical;">${existingCookies}</textarea>
                    <div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end;">
                        <button class="btn btn-outline-danger clear-cookies-btn" ${cookieCount === 0 ? 'disabled' : ''}>
                            <i class="material-icons" style="font-size:16px;vertical-align:middle;">delete_sweep</i>
                            ${clearAllText}
                        </button>
                        <button class="btn btn-outline-dark close-cookies-modal">${cancelText}</button>
                        <button class="btn btn-primary save-cookies-btn">
                            <i class="material-icons" style="font-size:16px;vertical-align:middle;">save</i>
                            ${saveCookiesText}
                        </button>
                    </div>
                </div>
            </div>
        `;

        $("body").append(modalHTML);

        // Close modal
        $(".close-cookies-modal").on("click", () => {
            $(".cookies-modal").remove();
        });

        // Clear cookies
        $(".clear-cookies-btn").on("click", async () => {
            const clearCookiesPrompt = window.I18n?.t('common.are_you_sure_clear_cookies') || "Are you sure you want to clear all cookies?";
            const confirmed = await confirmPrompt(clearCookiesPrompt);
            if (!confirmed) return;

            const structures = await window.electronAPI.readKey("structures") || {};
            if (structures[openStructure]?.profiles[profileId]) {
                delete structures[openStructure].profiles[profileId].cookies;
                await window.electronAPI.updateData("structures", structures);
                $(".cookies-modal").remove();
                const successMsg = window.I18n?.t('common.cookies_cleared_successfully') || "Cookies cleared successfully";
                showAlert("success", successMsg);
                updateStructureArea();
            }
        });

        // Save cookies
        $(".save-cookies-btn").on("click", async () => {
            const cookiesJson = $("#cookies-json").val().trim();
            
            if (!cookiesJson) {
                // Empty = clear cookies
                const structures = await window.electronAPI.readKey("structures") || {};
                if (structures[openStructure]?.profiles[profileId]) {
                    delete structures[openStructure].profiles[profileId].cookies;
                    await window.electronAPI.updateData("structures", structures);
                    $(".cookies-modal").remove();
                    const clearedMsg = window.I18n?.t('common.cookies_cleared') || "Cookies cleared";
                    showAlert("success", clearedMsg);
                    updateStructureArea();
                }
                return;
            }

            // Validate JSON
            let cookies;
            try {
                cookies = JSON.parse(cookiesJson);
                if (!Array.isArray(cookies)) {
                    const arrayError = window.I18n?.t('common.cookies_must_be_array') || "Cookies must be an array";
                    throw new Error(arrayError);
                }
                // Validate each cookie has required fields (allow empty strings for value)
                for (const cookie of cookies) {
                    if (!cookie.name || typeof cookie.value === 'undefined' || !cookie.domain) {
                        const fieldsError = window.I18n?.t('common.cookie_fields_required') || "Each cookie must have name, value, and domain fields";
                        throw new Error(fieldsError);
                    }
                }
            } catch (e) {
                const invalidJsonMsg = window.I18n?.t('common.invalid_json') || "Invalid JSON";
                showAlert("error", invalidJsonMsg + ": " + e.message);
                return;
            }

            // Save cookies to profile
            const structures = await window.electronAPI.readKey("structures") || {};
            if (structures[openStructure]?.profiles[profileId]) {
                structures[openStructure].profiles[profileId].cookies = cookies;
                await window.electronAPI.updateData("structures", structures);
                $(".cookies-modal").remove();
                const savedMsg = window.I18n?.t('common.cookies_saved_successfully') || "cookies saved successfully";
                showAlert("success", `${cookies.length} ${savedMsg}`);
                updateStructureArea();
            }
        });
    }

    // Profile-level 2FA management (multiple entries per profile)
    $("#structures-page").on("click", '[data-role="manage2FA"]', async function () {
        const profileId = $(this).attr("data-id");
        if (!openStructure || !profileId) return;
        await show2FAModal(profileId);
    });

    async function show2FAModal(profileId) {
        const structures = await window.electronAPI.readKey("structures") || {};
        const structure = structures[openStructure];
        if (!structure) return;
        
        const profile = structure.profiles?.[profileId];
        if (!profile) return;

        const tofaEntries = profile.tofaEntries || [];

        // i18n strings
        const i18n = {
            title: window.I18n?.t('structures.tofa_title') || '2FA Keys',
            subtitle: window.I18n?.t('structures.tofa_subtitle') || 'Manage 2FA codes for this structure',





            cancel: window.I18n?.t('common.cancel') || 'Cancel',
            close: window.I18n?.t('common.close') || 'Close',

            copy: window.I18n?.t('common.copy') || 'Copy',
            copy_key: window.I18n?.t('structures.tofa_copy_key') || 'Copy Key',
            copied: window.I18n?.t('common.copied') || 'Copied!',
            remove: window.I18n?.t('common.remove') || 'Remove',
            remove_confirm: window.I18n?.t('structures.tofa_remove_confirm') || 'Are you sure you want to remove this 2FA entry?',
            add_new: window.I18n?.t('structures.tofa_add_new') || 'Add 2FA Key',
            no_entries: window.I18n?.t('structures.tofa_no_entries') || 'No 2FA keys added yet',
            name_label: window.I18n?.t('structures.tofa_name_label') || 'Name',
            name_placeholder: window.I18n?.t('structures.tofa_name_placeholder') || 'e.g., Facebook, Instagram',
            secret_label: window.I18n?.t('structures.tofa_secret_label') || 'Secret Key',
            secret_placeholder: window.I18n?.t('structures.tofa_secret_placeholder') || 'Paste Base32 secret key',
            save: window.I18n?.t('common.save') || 'Save',
            invalid_secret: window.I18n?.t('structures.tofa_invalid_secret') || 'Invalid secret key format',
        };

        const modalHTML = `
            <div class="tofa-modal" id="tofaModal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;">
                <div class="tofa-modal-content" style="background:var(--bg-primary, #fff);border-radius:12px;padding:30px;max-width:550px;width:90%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.2);">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:15px;">
                        <h3 style="margin:0;display:flex;align-items:center;gap:10px;color:var(--text-primary, #212529);">
                            <i class="material-icons" style="color:#4CAF50;">security</i>
                            ${i18n.title} - ${profile.label}
                        </h3>
                        <button class="close-tofa-modal" style="background:none;border:none;cursor:pointer;padding:5px;color:var(--text-secondary, #6c757d);">
                            <i class="material-icons">close</i>
                        </button>
                    </div>
                    
                    <!-- Main 2FA List View -->
                    <div id="tofa-list-step" style="display:none;flex:1;overflow:hidden;flex-direction:column;">
                        <p style="color:var(--text-secondary, #666);margin-bottom:15px;font-size:14px;">${i18n.subtitle}</p>
                        
                        <!-- 2FA Entries List -->
                        <div id="tofa-entries-list" style="flex:1;overflow-y:auto;margin-bottom:15px;max-height:300px;">
                            <!-- Entries will be inserted here -->
                        </div>
                        
                        <!-- Add New Entry Form -->
                        <div id="tofa-add-form" style="display:none;border:1px solid var(--border-color, #ddd);border-radius:8px;padding:15px;margin-bottom:15px;background:var(--bg-secondary, #f9f9f9);">
                            <div style="display:flex;gap:10px;margin-bottom:10px;">
                                <div style="flex:1;">
                                    <input type="text" id="tofa-new-name" placeholder="${i18n.name_placeholder}" style="width:100%;padding:10px;border:1px solid var(--border-color, #ddd);border-radius:6px;background:var(--bg-primary, #fff);color:var(--text-primary, #333);">
                                </div>
                                <div style="flex:2;">
                                    <input type="text" id="tofa-new-secret" placeholder="${i18n.secret_placeholder}" style="width:100%;padding:10px;border:1px solid var(--border-color, #ddd);border-radius:6px;font-family:monospace;background:var(--bg-primary, #fff);color:var(--text-primary, #333);">
                                </div>
                            </div>
                            <div style="display:flex;gap:10px;justify-content:flex-end;">
                                <button class="btn btn-outline-dark btn-sm" id="tofa-cancel-add">${i18n.cancel}</button>
                                <button class="btn btn-primary btn-sm" id="tofa-save-new">
                                    <i class="material-icons" style="font-size:14px;vertical-align:middle;">save</i>
                                    ${i18n.save}
                                </button>
                            </div>
                        </div>
                        
                        <div style="display:flex;gap:10px;justify-content:space-between;">
                            <button class="btn btn-outline-primary" id="tofa-add-btn">
                                <i class="material-icons" style="font-size:16px;vertical-align:middle;">add</i>
                                ${i18n.add_new}
                            </button>
                            <button class="btn btn-outline-dark close-tofa-modal">${i18n.close}</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        $("body").append(modalHTML);

        let codeRefreshIntervals = {};
        let currentEntries = [...tofaEntries];

        // Close modal handler
        function closeModal() {
            Object.values(codeRefreshIntervals).forEach(interval => clearInterval(interval));
            $(".tofa-modal").remove();
        }

        $(".close-tofa-modal").on("click", closeModal);
        
        // Close on backdrop click
        $("#tofaModal").on("click", function(e) {
            if (e.target === this) closeModal();
        });

        // Render entries list
        function renderEntries() {
            const $list = $("#tofa-entries-list");
            $list.empty();

            if (currentEntries.length === 0) {
                $list.html(`
                    <div style="text-align:center;padding:40px;color:var(--text-secondary, #888);">
                        <i class="material-icons" style="font-size:48px;opacity:0.5;margin-bottom:10px;">security</i>
                        <p>${i18n.no_entries}</p>
                    </div>
                `);
                return;
            }

            currentEntries.forEach((entry) => {
                const entryHTML = `
                    <div class="tofa-entry" data-id="${entry.id}" style="border:1px solid var(--border-color, #e0e0e0);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--bg-primary, #fff);">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <span style="font-weight:600;color:var(--text-primary, #333);display:flex;align-items:center;gap:6px;">
                                <i class="material-icons" style="font-size:18px;color:#4CAF50;">vpn_key</i>
                                ${escapeHtml(entry.name)}
                            </span>
                            <button class="tofa-remove-entry" data-id="${entry.id}" style="background:none;border:none;cursor:pointer;padding:4px;color:#E53935;" title="${i18n.remove}">
                                <i class="material-icons" style="font-size:18px;">delete</i>
                            </button>
                        </div>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <div class="tofa-code" data-id="${entry.id}" style="flex:1;font-size:28px;font-family:monospace;font-weight:bold;letter-spacing:4px;color:var(--text-primary, #1976D2);background:var(--bg-secondary, #f5f5f5);padding:8px 12px;border-radius:6px;text-align:center;">------</div>
                            <div style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:40px;">
                                <div class="tofa-countdown" data-id="${entry.id}" style="width:30px;height:30px;border-radius:50%;border:3px solid #4CAF50;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--text-primary, #333);">30</div>
                            </div>
                            <button class="tofa-copy-entry" data-id="${entry.id}" style="background:#1976D2;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:4px;" title="${i18n.copy}">
                                <i class="material-icons" style="font-size:16px;">content_copy</i>
                            </button>
                            <button class="tofa-copy-key" data-id="${entry.id}" data-secret="${entry.encryptedSecret}" style="background:#FF9800;color:white;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:4px;" title="${i18n.copy_key}">
                                <i class="material-icons" style="font-size:16px;">vpn_key</i>
                            </button>
                        </div>
                    </div>
                `;
                $list.append(entryHTML);

                // Start code refresh for this entry
                startCodeRefreshForEntry(entry);
            });
        }

        async function startCodeRefreshForEntry(entry) {
            async function updateCode() {
                const codeResult = await window.electronAPI.getTotpCode(entry.encryptedSecret);
                if (codeResult.success) {
                    $(`.tofa-code[data-id="${entry.id}"]`).text(codeResult.code);
                    $(`.tofa-countdown[data-id="${entry.id}"]`).text(codeResult.remaining);
                    
                    // Change countdown color based on time remaining
                    const $countdown = $(`.tofa-countdown[data-id="${entry.id}"]`);
                    if (codeResult.remaining <= 5) {
                        $countdown.css("border-color", "#E53935");
                        $countdown.css("color", "#E53935");
                    } else if (codeResult.remaining <= 10) {
                        $countdown.css("border-color", "#FF9800");
                        $countdown.css("color", "#FF9800");
                    } else {
                        $countdown.css("border-color", "#4CAF50");
                        $countdown.css("color", "var(--text-primary, #333)");
                    }
                }
            }
            
            await updateCode();
            codeRefreshIntervals[entry.id] = setInterval(updateCode, 1000);
        }

        $("#tofa-list-step").css("display", "flex");
        renderEntries();

        // Copy code handler (using event delegation)
        $("#tofa-entries-list").on("click", ".tofa-copy-entry", async function() {
            const entryId = $(this).data("id");
            const code = $(`.tofa-code[data-id="${entryId}"]`).text();
            if (code && code !== "------") {
                await navigator.clipboard.writeText(code);
                const $btn = $(this);
                const originalHtml = $btn.html();
                $btn.html(`<i class="material-icons" style="font-size:16px;">check</i>`);
                $btn.css("background", "#4CAF50");
                setTimeout(() => {
                    $btn.html(originalHtml);
                    $btn.css("background", "#1976D2");
                }, 1500);
            }
        });

        // Copy secret key handler (using event delegation)
        $("#tofa-entries-list").on("click", ".tofa-copy-key", async function() {
            const encryptedSecret = $(this).data("secret");
            if (!encryptedSecret) return;
            
            const result = await window.electronAPI.decryptTotpSecret(encryptedSecret);
            if (result.success && result.secret) {
                await navigator.clipboard.writeText(result.secret);
                const $btn = $(this);
                const originalHtml = $btn.html();
                $btn.html(`<i class="material-icons" style="font-size:16px;">check</i>`);
                $btn.css("background", "#4CAF50");
                setTimeout(() => {
                    $btn.html(originalHtml);
                    $btn.css("background", "#FF9800");
                }, 1500);
            }
        });

        // Remove entry handler (using event delegation)
        $("#tofa-entries-list").on("click", ".tofa-remove-entry", async function() {
            const entryId = $(this).data("id");
            const confirmed = await confirmPrompt(i18n.remove_confirm);
            if (!confirmed) return;

            const result = await window.electronAPI.removeProfileTotp(openStructure, profileId, entryId);
            if (result.success) {
                // Stop refresh interval for this entry
                if (codeRefreshIntervals[entryId]) {
                    clearInterval(codeRefreshIntervals[entryId]);
                    delete codeRefreshIntervals[entryId];
                }
                // Remove from local array and re-render
                currentEntries = currentEntries.filter(e => e.id !== entryId);
                renderEntries();
                updateStructureArea();
                showAlert("success", window.I18n?.t('structures.tofa_removed') || "2FA entry removed");
            } else {
                showAlert("error", result.error || "Failed to remove 2FA entry");
            }
        });

        // Show add form
        $("#tofa-add-btn").on("click", function() {
            $("#tofa-add-form").show();
            $("#tofa-new-name").focus();
            $(this).hide();
        });

        // Cancel add
        $("#tofa-cancel-add").on("click", function() {
            $("#tofa-add-form").hide();
            $("#tofa-new-name").val("");
            $("#tofa-new-secret").val("");
            $("#tofa-add-btn").show();
        });

        // Save new entry
        $("#tofa-save-new").on("click", async function() {
            const name = $("#tofa-new-name").val().trim();
            const secretKey = $("#tofa-new-secret").val().trim().toUpperCase().replace(/\s/g, '');

            if (!name) {
                showAlert("error", window.I18n?.t('structures.tofa_name_required') || "Please enter a name");
                return;
            }

            if (!secretKey) {
                showAlert("error", window.I18n?.t('structures.tofa_secret_required') || "Please enter a secret key");
                return;
            }

            // Validate base32 format (A-Z, 2-7)
            if (!/^[A-Z2-7]+$/.test(secretKey)) {
                showAlert("error", i18n.invalid_secret);
                return;
            }

            const $btn = $(this);
            const originalText = $btn.html();
            $btn.prop("disabled", true).html(`<span class="spinner-border spinner-border-sm"></span>`);

            try {
                // Encrypt the secret
                const encryptResult = await window.electronAPI.encryptTotpSecret(secretKey);
                if (!encryptResult.success) {
                    showAlert("error", encryptResult.error || i18n.invalid_secret);
                    $btn.prop("disabled", false).html(originalText);
                    return;
                }

                // Generate unique ID for this entry
                const entryId = generateRandomString(8);

                // Save to profile
                const saveResult = await window.electronAPI.saveProfileTotp(
                    openStructure,
                    profileId,
                    entryId,
                    name,
                    encryptResult.encryptedSecret
                );

                if (!saveResult.success) {
                    showAlert("error", saveResult.error || "Failed to save 2FA");
                    $btn.prop("disabled", false).html(originalText);
                    return;
                }

                // Add to local array and re-render
                const newEntry = {
                    id: entryId,
                    name: name,
                    encryptedSecret: encryptResult.encryptedSecret
                };
                currentEntries.push(newEntry);
                renderEntries();
                
                // Reset form
                $("#tofa-add-form").hide();
                $("#tofa-new-name").val("");
                $("#tofa-new-secret").val("");
                $("#tofa-add-btn").show();
                $btn.prop("disabled", false).html(originalText);
                
                updateStructureArea();
                showAlert("success", window.I18n?.t('structures.tofa_saved') || "2FA key added successfully");
            } catch (err) {
                showAlert("error", err.message || "Failed to save 2FA");
                $btn.prop("disabled", false).html(originalText);
            }
        });

        // Helper to escape HTML
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    }


    $("#structures-page").on("click", '[data-role="deleteProfile"]', async function () {
        const id = $(this).attr("data-id");
        const confirmed = await confirmPrompt();
        if (!confirmed) return;
        const structures = await window.electronAPI.readKey("structures") || {};
        if (structures[openStructure] && structures[openStructure].profiles) {
            delete structures[openStructure].profiles[id];
            await window.electronAPI.updateData("structures", structures);
            updateStructureArea();
        }
    });

    $("#structures-page").on("click", '[data-role="transferProfile"]', async function () {
        const profileId = $(this).attr("data-id");
        const structures = await window.electronAPI.readKey("structures") || {};
        const profile = structures[openStructure]?.profiles?.[profileId];
        if (!profile) {
            showAlert("error", window.I18n?.t('structures.transfer_profile_not_found') || "Profile not found");
            return;
        }

        const destinations = Object.entries(structures)
            .filter(([structureId]) => structureId !== openStructure)
            .map(([value, structure]) => ({ value, label: escapeHtml(structure.label || value) }));

        if (destinations.length === 0) {
            showAlert("warning", window.I18n?.t('structures.transfer_no_destination') || "Create another structure before transferring a profile");
            return;
        }

        const destinationLabel = window.I18n?.t('structures.destination_structure') || "Destination structure";
        const result = await newPrompt([{
            type: "select",
            name: destinationLabel,
            required: true,
            options: destinations
        }]);
        if (!result) return;

        const targetStructureId = result[destinationLabel];
        const confirmed = await confirmPrompt();
        if (!confirmed) return;

        const transferResult = await window.electronAPI.transferStructureProfile(
            openStructure,
            targetStructureId,
            profileId
        );

        if (!transferResult?.success) {
            showAlert("error", transferResult?.error || (window.I18n?.t('structures.transfer_failed') || "Failed to transfer profile"));
            return;
        }

        await updateStructureArea();
        if (transferResult.warnings?.length) {
            showAlert("warning", `${window.I18n?.t('structures.transfer_completed_with_warnings') || 'Profile transferred with warnings'}: ${transferResult.warnings.join('; ')}`);
        } else {
            showAlert("success", window.I18n?.t('structures.transfer_success') || "Profile transferred successfully");
        }
    });
    
    // VCBrowser download modal
    function showVCBrowserDownloadModal() {
        return new Promise((resolve) => {
            const modalHTML = `
                <div class="vcbrowser-download-modal" id="vcBrowserDownloadModal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;">
                    <div style="background:white;border-radius:10px;padding:30px;max-width:500px;width:90%;">
                        <h3 style="margin:0 0 15px;display:flex;align-items:center;gap:10px;">
                            <i class="material-icons" style="color:#E53935;">browser_not_supported</i>
                            VCBrowser Required
                        </h3>
                        <p style="color:#666;margin-bottom:20px;">This profile is configured to use VCBrowser (Undetectable Browser), but it's not installed yet. Would you like to download it now?</p>
                        <div id="vcbrowser-download-status" style="display:none;margin-bottom:20px;">
                            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                                <div class="spinner" style="width:20px;height:20px;border-width:2px;"></div>
                                <span id="vcbrowser-status-text">Preparing download...</span>
                            </div>
                            <div style="background:#e0e0e0;border-radius:5px;height:8px;overflow:hidden;">
                                <div id="vcbrowser-progress-bar" style="background:#1976D2;height:100%;width:0%;transition:width 0.3s;"></div>
                            </div>
                        </div>
                        <div id="vcbrowser-download-actions" style="display:flex;gap:10px;justify-content:flex-end;">
                            <button class="btn btn-outline-dark" id="vcbrowser-cancel">Cancel</button>
                            <button class="btn btn-primary" id="vcbrowser-download">
                                <i class="material-icons" style="font-size:18px;vertical-align:middle;">download</i>
                                Download VCBrowser
                            </button>
                        </div>
                    </div>
                </div>
            `;
            $("body").append(modalHTML);
            
            $("#vcbrowser-cancel").click(() => {
                window.electronAPI.removeVCBrowserDownloadProgressListener();
                $("#vcBrowserDownloadModal").remove();
                resolve(false);
            });
            
            $("#vcbrowser-download").click(async () => {
                $("#vcbrowser-download-actions").hide();
                $("#vcbrowser-download-status").show();
                
                window.electronAPI.onVCBrowserDownloadProgress((data) => {
                    $("#vcbrowser-status-text").text(data.status || 'Downloading...');
                    $("#vcbrowser-progress-bar").css('width', (data.progress || 0) + '%');
                });
                
                try {
                    const result = await window.electronAPI.downloadVCBrowser();
                    window.electronAPI.removeVCBrowserDownloadProgressListener();
                    
                    if (result.success) {
                        showAlert("success", "VCBrowser downloaded successfully!");
                        $("#vcBrowserDownloadModal").remove();
                        resolve(true);
                    } else {
                        showAlert("error", result.error || "Download failed");
                        $("#vcbrowser-download-status").hide();
                        $("#vcbrowser-download-actions").show();
                    }
                } catch (error) {
                    window.electronAPI.removeVCBrowserDownloadProgressListener();
                    showAlert("error", error.message || "Download failed");
                    $("#vcbrowser-download-status").hide();
                    $("#vcbrowser-download-actions").show();
                }
            });
        });
    }
    
    // Open profile helper with VCBrowser check
    async function openStructureProfile(id, url, proxy, additionalTabUrl = null) {
        const result = await window.electronAPI.startStructureProfile(id, url, proxy, additionalTabUrl);
        
        if (!result.success && result.needsVCBrowser) {
            // VCBrowser not installed - prompt to download
            const downloaded = await showVCBrowserDownloadModal();
            if (downloaded) {
                // Retry opening the profile
                const retryResult = await window.electronAPI.startStructureProfile(id, url, proxy, additionalTabUrl);
                if (!retryResult.success) {
                    showAlert("error", retryResult.error || "Failed to open profile");
                }
            }
        } else if (!result.success) {
            showAlert("error", result.error || "Failed to open profile");
        }
    }

    $("#structures-page").on("click", '[data-role="openProfile"]', async function () {
        const id = $(this).attr("data-id");
        const confirmed = await confirmPrompt();
        if (!confirmed) return;
        const structures = await window.electronAPI.readKey("structures") || {};
        const profile = structures[openStructure]?.profiles[id];
        const proxy = profile?.proxy;
        
        // Check if profile has saved tabs
        const savedTabs = profile?.savedTabs || [];
        const hasSavedTabs = savedTabs.length > 0;
        
        // Check if pixelscan is already in saved tabs
        const pixelscanUrl = "https://iphey.com";
        const hasPixelscan = savedTabs.some(tab => tab.includes('iphey.com'));
        
        // If has saved tabs, pass null to restore them; otherwise use pixelscan as default
        // We'll add pixelscan separately if it's not in the tabs
        const defaultUrl = hasSavedTabs ? null : pixelscanUrl;
        const addPixelscan = hasSavedTabs && !hasPixelscan;
        
        // Check if proxy needs clean IP verification
        if (proxy && proxy.ip && proxy.ip !== "NULL") {
            const ipregistrySettings = await window.electronAPI.readKey('ipregistrySettings');
            
            if (ipregistrySettings?.enabled && ipregistrySettings?.apiKey) {
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
                        await openStructureProfile(id, defaultUrl, proxy, addPixelscan ? pixelscanUrl : null);
                        return;
                    }
                    
                    if (result.success) {
                        // Found clean proxy
                        closeProxyCheckingModal();
                        showAlert("success", `Clean proxy found! IP: ${result.finalIp}`);
                        await openStructureProfile(id, defaultUrl, result.proxyData, addPixelscan ? pixelscanUrl : null);
                    } else {
                        // No clean proxy found - show confirmation modal
                        closeProxyCheckingModal();
                        const proceed = await showDirtyProxyConfirmModal(result);
                        if (proceed) {
                            await openStructureProfile(id, defaultUrl, result.proxyData, addPixelscan ? pixelscanUrl : null);
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
        await openStructureProfile(id, defaultUrl, proxy, addPixelscan ? pixelscanUrl : null);
    });

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

    // Bulk Update Proxy Credentials
    $("#structures-page").on("click", '#bulkUpdateProxy', async function () {
        const structures = await window.electronAPI.readKey("structures") || {};
        const structure = structures[openStructure];
        if (!structure || !structure.profiles) return;

        const profiles = structure.profiles;
        const proxyProfileIds = Object.keys(profiles).filter(id => profiles[id].proxy && profiles[id].proxy.ip);

        if (proxyProfileIds.length === 0) {
            showAlert("warning", window.I18n?.t('structures.bulk_proxy_no_profiles') || 'No profiles with proxy settings found in this structure');
            return;
        }

        const title = window.I18n?.t('structures.bulk_update_proxy_title') || 'Bulk Update Proxy Credentials';
        const desc = window.I18n?.t('structures.bulk_update_proxy_desc') || 'Update the proxy username and base password for all profiles in this structure that have a proxy configured. Session parameters (after the base password) will be preserved per-profile.';
        const usernameLabel = window.I18n?.t('structures.bulk_proxy_new_username') || 'New Proxy Username';
        const passwordLabel = window.I18n?.t('structures.bulk_proxy_new_password') || 'New Base Password';
        const passwordHelp = window.I18n?.t('structures.bulk_proxy_password_help') || 'Enter only the base password (e.g. Tppiriman123). Per-profile parameters like -country-XX-session-YY will be kept.';
        const hostLabel = window.I18n?.t('structures.bulk_proxy_new_host') || 'New Proxy Host/IP (optional)';
        const portLabel = window.I18n?.t('structures.bulk_proxy_new_port') || 'New Proxy Port (optional)';
        const hostHelp = window.I18n?.t('structures.bulk_proxy_host_help') || 'Leave empty to keep existing host/port per profile';
        const applyBtn = window.I18n?.t('structures.bulk_proxy_apply') || 'Apply to All Profiles';
        const cancelBtn = window.I18n?.t('common.cancel') || 'Cancel';

        // Build a preview of affected profiles
        let previewHTML = '';
        proxyProfileIds.forEach(id => {
            const p = profiles[id];
            previewHTML += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-color);">
                <span>${p.label}</span>
                <span style="color:var(--text-secondary);font-size:12px;font-family:monospace;">${p.proxy.username || ''}@${p.proxy.ip}:${p.proxy.port || ''}</span>
            </div>`;
        });

        const modalHTML = `
            <div class='bulk-proxy-modal' style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;">
                <div style="background:var(--bg-primary);border-radius:12px;padding:30px;max-width:550px;width:95%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;">
                        <h3 style="margin:0;color:var(--text-primary);">${title}</h3>
                        <button class="bulk-proxy-close" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:20px;"><i class="material-icons">close</i></button>
                    </div>
                    <p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">${desc}</p>

                    <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;margin-bottom:20px;max-height:150px;overflow-y:auto;">
                        <strong style="font-size:12px;color:var(--text-secondary);">${proxyProfileIds.length} profiles will be updated:</strong>
                        ${previewHTML}
                    </div>

                    <label style="display:block;margin-bottom:12px;">
                        <span style="color:var(--text-primary);font-weight:500;">${usernameLabel}</span>
                        <input type="text" id="bulk-proxy-username" style="width:100%;padding:10px;border:1px solid var(--border-color);border-radius:5px;margin-top:5px;background:var(--bg-primary);color:var(--text-primary);" />
                    </label>
                    <label style="display:block;margin-bottom:5px;">
                        <span style="color:var(--text-primary);font-weight:500;">${passwordLabel}</span>
                        <input type="text" id="bulk-proxy-password" style="width:100%;padding:10px;border:1px solid var(--border-color);border-radius:5px;margin-top:5px;background:var(--bg-primary);color:var(--text-primary);" />
                    </label>
                    <small style="color:var(--text-secondary);font-size:11px;display:block;margin-bottom:15px;">${passwordHelp}</small>

                    <label style="display:block;margin-bottom:12px;">
                        <span style="color:var(--text-primary);font-weight:500;">${hostLabel}</span>
                        <input type="text" id="bulk-proxy-host" style="width:100%;padding:10px;border:1px solid var(--border-color);border-radius:5px;margin-top:5px;background:var(--bg-primary);color:var(--text-primary);" />
                    </label>
                    <label style="display:block;margin-bottom:5px;">
                        <span style="color:var(--text-primary);font-weight:500;">${portLabel}</span>
                        <input type="text" id="bulk-proxy-port" style="width:100%;padding:10px;border:1px solid var(--border-color);border-radius:5px;margin-top:5px;background:var(--bg-primary);color:var(--text-primary);" />
                    </label>
                    <small style="color:var(--text-secondary);font-size:11px;display:block;margin-bottom:20px;">${hostHelp}</small>

                    <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:15px;border-top:1px solid var(--border-color);">
                        <button class="btn btn-outline-dark bulk-proxy-close">${cancelBtn}</button>
                        <button class="btn btn-primary" id="bulk-proxy-apply">${applyBtn}</button>
                    </div>
                </div>
            </div>
        `;

        $("body").append(modalHTML);

        $(".bulk-proxy-close").on("click", () => $(".bulk-proxy-modal").remove());

        $("#bulk-proxy-apply").on("click", async function() {
            const newUsername = $("#bulk-proxy-username").val().trim();
            const newBasePassword = $("#bulk-proxy-password").val().trim();
            const newHost = $("#bulk-proxy-host").val().trim();
            const newPort = $("#bulk-proxy-port").val().trim();

            if (!newUsername && !newBasePassword && !newHost && !newPort) {
                showAlert("error", "Please enter at least one field to update");
                return;
            }

            const freshStructures = await window.electronAPI.readKey("structures") || {};
            const freshProfiles = freshStructures[openStructure]?.profiles;
            if (!freshProfiles) return;

            let updatedCount = 0;

            for (const pid of Object.keys(freshProfiles)) {
                const prof = freshProfiles[pid];
                if (!prof.proxy || !prof.proxy.ip) continue;

                // Update username if provided
                if (newUsername) {
                    prof.proxy.username = newUsername;
                }

                // Update password: preserve parameters after base password
                if (newBasePassword) {
                    const oldPassword = prof.proxy.password || '';
                    // Find the first '-' that starts parameters (e.g. -country-DE-session-...)
                    // Parameters pattern: starts with -keyword- (lowercase word followed by -)
                    const paramMatch = oldPassword.match(/(-[a-z]+-)/);
                    if (paramMatch) {
                        const paramStart = oldPassword.indexOf(paramMatch[0]);
                        const params = oldPassword.substring(paramStart);
                        prof.proxy.password = newBasePassword + params;
                    } else {
                        prof.proxy.password = newBasePassword;
                    }
                }

                // Update host/port if provided
                if (newHost) prof.proxy.ip = newHost;
                if (newPort) prof.proxy.port = newPort;

                updatedCount++;
            }

            await window.electronAPI.updateData("structures", freshStructures);
            $(".bulk-proxy-modal").remove();
            updateStructureArea();

            const successMsg = (window.I18n?.t('structures.bulk_proxy_updated', { count: updatedCount }) || `Proxy credentials updated for ${updatedCount} profiles`);
            showAlert("success", successMsg);
        });
    });

    $("#structures-page").on("click", '#newProfile', async function () {
        await showUnifiedProfileModal();
    });

    async function showUnifiedProfileModal(profileId = null, isEdit = false) {
        const structures = await window.electronAPI.readKey("structures") || {};
        const profile = isEdit ? structures[openStructure]?.profiles[profileId] : null;
        
        const modalTitle = isEdit 
            ? (window.I18n?.t('structures.edit_profile_settings') || 'Edit Profile Settings')
            : (window.I18n?.t('structures.create_new_profile') || 'Create New Profile');
        const profileInfoTab = window.I18n?.t('structures.profile_info') || 'Profile Info';
        const proxySettingsTab = window.I18n?.t('structures.proxy_settings') || 'Proxy Settings';
        const fingerprintTab = window.I18n?.t('structures.fingerprint_settings') || 'Fingerprint Settings';
        const profileNameLabel = window.I18n?.t('structures.profile_name_required') || 'Profile name (*)';
        const roleLabel = window.I18n?.t('structures.role_required') || 'Role (*)';
        const posterRole = window.I18n?.t('structures.poster') || 'Poster';
        const advertiserRole = window.I18n?.t('structures.advertiser') || 'Advertiser';
        const adminRole = window.I18n?.t('structures.admin') || 'Admin';
        const proxyConfigTitle = window.I18n?.t('structures.proxy_configuration') || 'Proxy Configuration';
        const proxyStringLabel = window.I18n?.t('structures.proxy_string_label') || 'Proxy String (paste full proxy URL)';
        const proxyPlaceholder = window.I18n?.t('structures.proxy_string_placeholder') || 'user:pass@host:port or host:port:user:pass';
        const proxyFormatsHelp = window.I18n?.t('structures.proxy_formats_help') || 'Supports formats: user:pass@host:port, host:port:user:pass, or just host:port';
        const orManually = window.I18n?.t('structures.or_enter_manually') || 'OR enter manually';
        const proxyHostLabel = window.I18n?.t('structures.proxy_host_ip') || 'Proxy Host/IP';
        const proxyPortLabel = window.I18n?.t('structures.proxy_port') || 'Proxy Port';
        const usernameLabel = window.I18n?.t('structures.username') || 'Username';
        const passwordLabel = window.I18n?.t('structures.password') || 'Password';
        const testProxyBtn = window.I18n?.t('structures.test_proxy') || 'Test Proxy';
        const fingerprintConfigTitle = window.I18n?.t('structures.fingerprint_configuration') || 'Fingerprint Configuration';
        const cancelBtn = window.I18n?.t('common.cancel') || 'Cancel';
        const saveBtn = isEdit 
            ? (window.I18n?.t('structures.update_profile') || 'Update Profile')
            : (window.I18n?.t('structures.create_profile') || 'Create Profile');
        
        // Create tabbed modal
        const modalHTML = `
            <div class='unified-profile-modal'>
                <div class='unified-modal-content'>
                    <button class="close"><i class="material-icons">close</i></button>
                    <h3>${modalTitle}</h3>
                    <div class="tab-container">
                        <div class="tab-nav">
                            <button class="tab-btn active" data-tab="basic">${profileInfoTab}</button>
                            <button class="tab-btn" data-tab="proxy">${proxySettingsTab}</button>
                            <button class="tab-btn" data-tab="fingerprint">${fingerprintTab}</button>
                        </div>
                        <div class="tab-content">
                            <div class="tab-panel active" data-tab="basic">
                                <label>
                                    <span>${profileNameLabel}</span>
                                    <input type="text" id="profile-name" value="${profile?.label || ''}" required style="width:100%;padding:10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                                </label>
                                <label style="margin-top:15px;">
                                    <span>${roleLabel}</span>
                                    <select id="profile-role" required style="width:100%;padding:10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;">
                                        <option value="poster" ${profile?.type === 'poster' ? 'selected' : ''}>${posterRole}</option>
                                        <option value="advertiser" ${profile?.type === 'advertiser' ? 'selected' : ''}>${advertiserRole}</option>
                                        <option value="admin" ${profile?.type === 'admin' ? 'selected' : ''}>${adminRole}</option>
                                    </select>
                                </label>
                                <input type="hidden" id="profile-browser-type" value="vcbrowser" />
                            </div>
                            <div class="tab-panel" data-tab="proxy">
                                <h4>${proxyConfigTitle}</h4>
                                <label>
                                    <span>${proxyStringLabel}</span>
                                    <input type="text" id="proxy-string" value="${profile?.proxy?.ip ? (profile.proxy.username ? profile.proxy.username + ':' + (profile.proxy.password || '') + '@' : '') + profile.proxy.ip + ':' + (profile.proxy.port || '') : ''}" placeholder="${proxyPlaceholder}" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                                    <small style="color:#666;font-size:11px;display:block;margin-top:5px;">${proxyFormatsHelp}</small>
                                </label>
                                <div style="display:flex;align-items:center;margin:15px 0;gap:10px;">
                                    <hr style="flex:1;border:none;border-top:1px solid #ddd;">
                                    <span style="color:#999;font-size:12px;">${orManually}</span>
                                    <hr style="flex:1;border:none;border-top:1px solid #ddd;">
                                </div>
                                <label>
                                    <span>${proxyHostLabel}</span>
                                    <input type="text" id="proxy-ip" value="${profile?.proxy?.ip || ''}" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                                </label>
                                <label style="margin-top:15px;">
                                    <span>${proxyPortLabel}</span>
                                    <input type="text" id="proxy-port" value="${profile?.proxy?.port || ''}" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                                </label>
                                <label style="margin-top:15px;">
                                    <span>${usernameLabel}</span>
                                    <input type="text" id="proxy-username" value="${profile?.proxy?.username || ''}" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                                </label>
                                <label style="margin-top:15px;">
                                    <span>${passwordLabel}</span>
                                    <input type="text" id="proxy-password" value="${profile?.proxy?.password || ''}" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                                </label>
                                <button type="button" id="test-proxy" class="btn btn-outline-primary" style="margin-top:15px;">${testProxyBtn}</button>
                            </div>
                            <div class="tab-panel" data-tab="fingerprint">
                                <h4>${fingerprintConfigTitle}</h4>
                                <div id="fingerprint-fields"></div>
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; padding: 15px; border-top: 1px solid #eee;">
                        <button class="btn btn-outline-dark btn-cancel">${cancelBtn}</button>
                        <button class="btn btn-primary btn-save">${saveBtn}</button>
                    </div>
                </div>
            </div>
        `;

        $("body").append(modalHTML);
        
        // Initialize fingerprint fields
        await initializeFingerprintFields(profile?.fingerprint);
        
        // Tab switching
        $(".tab-btn").on("click", function() {
            const tab = $(this).data("tab");
            $(".tab-btn").removeClass("active");
            $(".tab-panel").removeClass("active");
            $(this).addClass("active");
            $(`.tab-panel[data-tab="${tab}"]`).addClass("active");
        });

        // Proxy string parser - parses various proxy formats
        $("#proxy-string").on("input", function() {
            const proxyString = $(this).val().trim();
            if (!proxyString) return;
            
            const parsed = parseProxyString(proxyString);
            if (parsed) {
                $("#proxy-ip").val(parsed.ip || '');
                $("#proxy-port").val(parsed.port || '');
                $("#proxy-username").val(parsed.username || '');
                $("#proxy-password").val(parsed.password || '');
            }
        });

        // Test proxy button
        $("#test-proxy").on("click", async function() {
            const proxyData = {
                ip: $("#proxy-ip").val(),
                port: $("#proxy-port").val(),
                username: $("#proxy-username").val(),
                password: $("#proxy-password").val()
            };
            
            if (!proxyData.ip) {
                showAlert("error", "Please enter proxy IP first");
                return;
            }
            
            showLoading("Testing Proxy ...");
            try {
                const response = await window.electronAPI.testProxy(proxyData);
                removeLoading();
                if (response.success) {
                    showAlert("success", `Proxy working! IP: ${response.ip}, Country: ${response.country_name}`);
                } else {
                    showAlert("error", `Proxy failed: ${response.error}`);
                }
            } catch (error) {
                removeLoading();
                showAlert("error", `Proxy test failed: ${error.message}`);
            }
        });

        // Close modal
        $(".close, .btn-cancel").on("click", () => {
            $(".unified-profile-modal").remove();
        });

        // Save profile
        $(".btn-save").on("click", async function() {
            const profileName = $("#profile-name").val();
            const profileRole = $("#profile-role").val();
            
            if (!profileName) {
                showAlert("error", "Profile name is required");
                return;
            }

            // Collect proxy data
            let proxyData = {
                ip: $("#proxy-ip").val(),
                port: $("#proxy-port").val(),
                username: $("#proxy-username").val(),
                password: $("#proxy-password").val()
            };

            // Test proxy if provided (optional - user can save even if test fails)
            if (proxyData.ip) {
                showLoading("Testing Proxy ...");
                try {
                    const response = await window.electronAPI.testProxy(proxyData);
                    removeLoading();
                    if (!response.success) {
                        const confirmMsg = window.I18n?.t('structures.proxy_test_failed_save_anyway') || 
                            `Proxy test failed: ${response.error}\n\nDo you want to save the profile anyway?`;
                        const confirmed = await confirmPrompt(confirmMsg);
                        if (!confirmed) {
                            return;
                        }
                    }
                } catch (error) {
                    removeLoading();
                    const confirmMsg = window.I18n?.t('structures.proxy_test_failed_save_anyway') || 
                        `Proxy test failed: ${error.message}\n\nDo you want to save the profile anyway?`;
                    const confirmed = await confirmPrompt(confirmMsg);
                    if (!confirmed) {
                        return;
                    }
                }
            } else {
                proxyData = null;
            }

            // Collect fingerprint data
            const fingerprintData = await collectFingerprintData();

            // Save profile
            const structures = await window.electronAPI.readKey("structures") || {};
            if (!structures[openStructure]) {
                structures[openStructure] = {};
            }
            if (!structures[openStructure].profiles) {
                structures[openStructure].profiles = {};
            }

            const profiles = structures[openStructure].profiles;
            const id = profileId || generateRandomString(10);
            
            if( !fingerprintData ) {
                showAlert("error", `Cannot retreive fingerprints`);
                return;
            }
            
            const browserType = $("#profile-browser-type").val() || 'vcbrowser';
            
            // Preserve existing cookies and saved tabs when updating profile
            const existingCookies = profiles[id]?.cookies || null;
            const existingSavedTabs = profiles[id]?.savedTabs || null;
            
            profiles[id] = {
                label: profileName,
                type: profileRole,
                browserType: browserType,
                proxy: proxyData,
                fingerprint: fingerprintData,
                ...(existingCookies && { cookies: existingCookies }),
                ...(existingSavedTabs && { savedTabs: existingSavedTabs })
            };

            await window.electronAPI.updateData("structures", structures);
            $(".unified-profile-modal").remove();
            updateStructureArea();
            
            showAlert("success", `Profile ${isEdit ? 'updated' : 'created'} successfully!`);
        });
    }

    var languageOptions;
    (async () => {
        languageOptions = await getAllLanguageOptions();
    })();

    async function initializeFingerprintFields(existingFingerprint = null) {
        // Function to get current proxy data from modal
        function getProxyDataFromModal() {
            try {
                return {
                    ip: $("#proxy-ip").val() || '',
                    port: $("#proxy-port").val() || '',
                    username: $("#proxy-username").val() || '',
                    password: $("#proxy-password").val() || ''
                };
            } catch (e) {
                return null;
            }
        }

        let fingerprint = existingFingerprint;
        if (!fingerprint) {
            // Try to get IP-based defaults first
            const proxyData = getProxyDataFromModal();
            try {
                fingerprint = await generateSmartFingerprint(proxyData);
            } catch (error) {
                console.log("Could not generate smart fingerprint, using random:", error);
                fingerprint = generateRandomFingerprint();
            }
        }
        
        // Ensure fingerprint has all required properties
        if (!fingerprint || !fingerprint.userAgent || !fingerprint.platform) {
            fingerprint = generateRandomFingerprint();
        }
        
        // Detect user's actual platform for default selection
        let userPlatform = 'Win32'; // Default fallback
        try {
            if (navigator.platform) {
                userPlatform = navigator.platform;
            } else if (navigator.userAgentData && navigator.userAgentData.platform) {
                userPlatform = navigator.userAgentData.platform;
            } else {
                // Fallback detection from user agent
                const userAgent = navigator.userAgent.toLowerCase();
                if (userAgent.includes('mac')) {
                    userPlatform = 'MacIntel';
                } else if (userAgent.includes('linux')) {
                    userPlatform = 'Linux x86_64';
                } else {
                    userPlatform = 'Win32';
                }
            }
        } catch (e) {
            console.log("Could not detect platform:", e);
        }
        
        // Override fingerprint platform with user's actual platform if not editing existing profile
        if (!existingFingerprint) {
            fingerprint.platform = userPlatform;
            // Also update the user agent to match the detected platform
            const chromeVersion = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
            switch (userPlatform) {
                case 'Win32':
                    fingerprint.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                    break;
                case 'MacIntel':
                    fingerprint.userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                    break;
                case 'Linux x86_64':
                    fingerprint.userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                    break;
                default:
                    fingerprint.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
            }
            
            // Also try to use user's actual screen resolution
            try {
                if (window.screen && window.screen.width && window.screen.height) {
                    fingerprint.screenResolution = {
                        width: window.screen.width,
                        height: window.screen.height
                    };
                }
            } catch (e) {
                console.log("Could not detect screen resolution:", e);
            }
        } else {
            // When editing, also enforce the current OS platform
            fingerprint.platform = userPlatform;
            // Update user agent to match current OS
            const chromeVersion = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
            switch (userPlatform) {
                case 'Win32':
                    fingerprint.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                    break;
                case 'MacIntel':
                    fingerprint.userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                    break;
                case 'Linux x86_64':
                    fingerprint.userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                    break;
                default:
                    fingerprint.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
            }
        }
        
        // Get OS display name for the info box
        let osDisplayName = 'Windows';
        let osIcon = '<i class="material-icons">laptop_windows</i>';
        if (userPlatform === 'MacIntel' || userPlatform === 'MacOS') {
            osDisplayName = 'macOS';
            osIcon = '<i class="material-icons">laptop_mac</i>';
        } else if (userPlatform === 'Linux x86_64' || userPlatform.includes('Linux')) {
            osDisplayName = 'Linux';
            osIcon = '<i class="material-icons">computer</i>';
        }
        
        const fieldsHTML = `
            <div class="fp-section">
                <div id="profile-score" class="fp-score-card fp-score-good">
                    <div class="fp-score-header">
                        <i class="material-icons">verified</i>
                        <span>Profile Reliability Score: <strong id="score-value">100</strong>%</span>
                    </div>
                    <div id="score-details" class="fp-score-details"></div>
                </div>
            </div>
            
            <div class="fp-section">
                <h5 class="fp-section-title"><i class="material-icons">computer</i> System Configuration</h5>
                
                <div class="fp-field">
                    <label class="fp-label">User Agent <span class="fp-badge fp-badge-auto">Auto-generated</span></label>
                    <input type="text" id="fp-useragent" value="${fingerprint.userAgent || ''}" readonly class="fp-input fp-input-readonly" />
                    <small class="fp-help-text">Automatically generated based on your operating system</small>
                </div>
                
                <input type="hidden" id="fp-platform" value="${userPlatform}" />
                <div class="fp-field">
                    <label class="fp-label">Operating System <span class="fp-badge fp-badge-auto">Auto-detected</span></label>
                    <div class="fp-info-box">
                        <i class="material-icons">check_circle</i>
                        <span>${osIcon} ${osDisplayName} (Detected from your system)</span>
                    </div>
                </div>
                
                <div class="fp-row">
                    <div class="fp-field fp-field-half">
                        <label class="fp-label">CPU Cores</label>
                        <select id="fp-cores" class="fp-select">
                            <option value="4" ${fingerprint.hardwareConcurrency === 4 ? 'selected' : ''}>4 cores</option>
                            <option value="6" ${fingerprint.hardwareConcurrency === 6 ? 'selected' : ''}>6 cores</option>
                            <option value="8" ${fingerprint.hardwareConcurrency === 8 ? 'selected' : ''}>8 cores</option>
                            <option value="12" ${fingerprint.hardwareConcurrency === 12 ? 'selected' : ''}>12 cores</option>
                            <option value="16" ${fingerprint.hardwareConcurrency === 16 ? 'selected' : ''}>16 cores</option>
                        </select>
                    </div>
                    <div class="fp-field fp-field-half">
                        <label class="fp-label">RAM</label>
                        <select id="fp-memory" class="fp-select">
                            <option value="4" ${fingerprint.deviceMemory === 4 ? 'selected' : ''}>4 GB</option>
                            <option value="8" ${fingerprint.deviceMemory === 8 ? 'selected' : ''}>8 GB</option>
                            <option value="16" ${fingerprint.deviceMemory === 16 ? 'selected' : ''}>16 GB</option>
                            <option value="32" ${fingerprint.deviceMemory === 32 ? 'selected' : ''}>32 GB</option>
                        </select>
                    </div>
                </div>
                
                <div class="fp-field">
                    <label class="fp-label">Screen Resolution</label>
                    <select id="fp-resolution" class="fp-select">
                        ${!existingFingerprint && fingerprint.screenResolution ? 
                            `<option value="${fingerprint.screenResolution.width}x${fingerprint.screenResolution.height}" selected>${fingerprint.screenResolution.width}x${fingerprint.screenResolution.height} (Your Screen)</option>
                             <option disabled>──────────</option>` : ''
                        }
                        <option value="1920x1080" ${fingerprint.screenResolution?.width === 1920 && fingerprint.screenResolution?.height === 1080 ? 'selected' : ''}>1920x1080 (Full HD)</option>
                        <option value="1366x768" ${fingerprint.screenResolution?.width === 1366 && fingerprint.screenResolution?.height === 768 ? 'selected' : ''}>1366x768 (HD)</option>
                        <option value="2560x1440" ${fingerprint.screenResolution?.width === 2560 && fingerprint.screenResolution?.height === 1440 ? 'selected' : ''}>2560x1440 (1440p/QHD)</option>
                        <option value="3840x2160" ${fingerprint.screenResolution?.width === 3840 && fingerprint.screenResolution?.height === 2160 ? 'selected' : ''}>3840x2160 (4K UHD)</option>
                        <option value="1680x1050" ${fingerprint.screenResolution?.width === 1680 && fingerprint.screenResolution?.height === 1050 ? 'selected' : ''}>1680x1050 (WSXGA+)</option>
                        <option value="1600x900" ${fingerprint.screenResolution?.width === 1600 && fingerprint.screenResolution?.height === 900 ? 'selected' : ''}>1600x900 (HD+)</option>
                        <option value="1440x900" ${fingerprint.screenResolution?.width === 1440 && fingerprint.screenResolution?.height === 900 ? 'selected' : ''}>1440x900 (WXGA+)</option>
                        <option value="1280x1024" ${fingerprint.screenResolution?.width === 1280 && fingerprint.screenResolution?.height === 1024 ? 'selected' : ''}>1280x1024 (SXGA)</option>
                        <option value="1280x720" ${fingerprint.screenResolution?.width === 1280 && fingerprint.screenResolution?.height === 720 ? 'selected' : ''}>1280x720 (720p HD)</option>
                    </select>
                </div>
            </div>
            
            <div class="fp-section">
                <h5 class="fp-section-title"><i class="material-icons">language</i> Locale Settings</h5>
                
                <div class="fp-field">
                    <label class="fp-label">Language</label>
                    <div class="fp-searchable-select" id="fp-language-wrapper">
                        <input type="text" class="fp-search-input" placeholder="Search language..." id="fp-language-search" autocomplete="off" />
                        <select id="fp-language" class="fp-select fp-select-hidden">
                        </select>
                        <div class="fp-dropdown" id="fp-language-dropdown"></div>
                    </div>
                </div>
                
                <div class="fp-field">
                    <label class="fp-label">Timezone <span class="fp-badge fp-badge-smart"><i class="material-icons" style="font-size:12px;vertical-align:middle">language</i> Auto (IP-based)</span></label>
                    <div class="fp-info-box fp-info-box-highlight">
                        <i class="material-icons">public</i>
                        <span>Timezone is automatically detected from the proxy IP address for maximum authenticity</span>
                    </div>
                    <input type="hidden" id="fp-timezone" value="ip-based" />
                </div>
            </div>
            
            <div class="fp-section">
                <h5 class="fp-section-title"><i class="material-icons">memory</i> Graphics Configuration</h5>
                
                <div class="fp-row">
                    <div class="fp-field fp-field-half">
                        <label class="fp-label">GPU Vendor</label>
                        <select id="fp-gpu-vendor" class="fp-select">
                            <option value="NVIDIA" ${fingerprint.webgl?.vendor?.includes('NVIDIA') ? 'selected' : ''}>NVIDIA</option>
                            <option value="AMD" ${fingerprint.webgl?.vendor?.includes('AMD') ? 'selected' : ''}>AMD</option>
                            <option value="Intel" ${fingerprint.webgl?.vendor?.includes('Intel') ? 'selected' : ''}>Intel</option>
                            ${fingerprint.platform === 'MacIntel' ? `<option value="Apple" ${fingerprint.webgl?.vendor?.includes('Apple') ? 'selected' : ''}>Apple</option>` : ''}
                        </select>
                    </div>
                    <div class="fp-field fp-field-half">
                        <label class="fp-label">GPU Model</label>
                        <div class="fp-searchable-select" id="fp-gpu-model-wrapper">
                            <input type="text" class="fp-search-input" placeholder="Search GPU model..." id="fp-gpu-model-search" autocomplete="off" />
                            <select id="fp-gpu-model" class="fp-select fp-select-hidden">
                            </select>
                            <div class="fp-dropdown" id="fp-gpu-model-dropdown"></div>
                        </div>
                    </div>
                </div>
                
                <div class="fp-webgl-preview">
                    <div class="fp-webgl-header">
                        <i class="material-icons">info</i>
                        <span>WebGL Info Preview</span>
                    </div>
                    <div id="webgl-preview" class="fp-webgl-content"></div>
                </div>
            </div>
            
            <div class="fp-actions">
                <button type="button" id="randomize-fingerprint" class="fp-btn fp-btn-secondary">
                    <i class="material-icons">shuffle</i>
                    Randomize
                </button>
                <button type="button" id="optimize-fingerprint" class="fp-btn fp-btn-success">
                    <i class="material-icons">auto_fix_high</i>
                    Optimize for 100%
                </button>
            </div>
        `;
        
        $("#fingerprint-fields").html(fieldsHTML);
        
        // Initialize searchable selects
        initSearchableSelect('fp-language', languageOptions || []);
        
        // Initialize GPU models and scoring
        updateGPUModels();
        
        // Populate language options
        if (languageOptions) {
            const languageSelect = $("#fp-language");
            
            // Add IP-based option at the top
            languageSelect.append('<option value="ip-based" selected>Use IP\'s Language (Smart Default)</option>');
            
            languageOptions.forEach(lang => {
                const isSelected = existingFingerprint && fingerprint.language === lang.value;
                languageSelect.append(`<option value="${lang.value}" ${isSelected ? 'selected' : ''}>${lang.label}</option>`);
            });
            
            // Update the searchable select display
            updateSearchableSelectDisplay('fp-language');
        }
        
        // Timezone is always IP-based now - no select needed

        // Initial score calculation and WebGL preview
        updateWebGLPreview();
        await calculateScore();

        // Function to update GPU models based on vendor selection
        function updateGPUModels() {
            const vendor = $("#fp-gpu-vendor").val();
            const gpuModelSelect = $("#fp-gpu-model");
            gpuModelSelect.empty();
            
            const gpuData = getGPUData();
            const models = gpuData[vendor] || [];
            
            models.forEach(model => {
                const isSelected = fingerprint.webgl?.renderer?.includes(model.name);
                gpuModelSelect.append(`<option value="${model.renderer}" ${isSelected ? 'selected' : ''}>${model.name}</option>`);
            });
            
            if (!gpuModelSelect.val() && models.length > 0) {
                gpuModelSelect.val(models[0].renderer);
            }
            
            // Initialize searchable GPU model select
            initSearchableGPUSelect();
        }

        // Function to update WebGL preview
        function updateWebGLPreview() {
            const vendor = $("#fp-gpu-vendor").val();
            const renderer = $("#fp-gpu-model").val();
            
            const vendorText = getWebGLVendor(vendor);
            const previewHtml = `
                <div><strong>Vendor:</strong> ${vendorText}</div>
                <div><strong>Renderer:</strong> ${renderer}</div>
            `;
            $("#webgl-preview").html(previewHtml);
        }
        
        // Function to update GPU vendor options based on platform (Apple only for Mac)
        function updateGPUVendorOptions() {
            const platform = $("#fp-platform").val();
            const gpuVendorSelect = $("#fp-gpu-vendor");
            const currentVendor = gpuVendorSelect.val();
            
            // Check if Apple option exists
            const hasAppleOption = gpuVendorSelect.find('option[value="Apple"]').length > 0;
            
            if (platform === 'MacIntel') {
                // Add Apple option if not present
                if (!hasAppleOption) {
                    gpuVendorSelect.append('<option value="Apple">Apple</option>');
                }
            } else {
                // Remove Apple option if present
                if (hasAppleOption) {
                    gpuVendorSelect.find('option[value="Apple"]').remove();
                    // If Apple was selected, switch to NVIDIA
                    if (currentVendor === 'Apple') {
                        gpuVendorSelect.val('NVIDIA');
                        updateGPUModels();
                    }
                }
            }
        }

        // Event handlers for live updates (timezone removed - always IP-based)
        $("#fp-platform, #fp-language, #fp-resolution, #fp-cores, #fp-memory, #fp-gpu-vendor, #fp-gpu-model").on("change", async function() {
            if ($(this).attr("id") === "fp-platform") {
                updateUserAgent(false);
                updateGPUVendorOptions();
            }
            if ($(this).attr("id") === "fp-gpu-vendor") {
                updateGPUModels();
            }
            updateWebGLPreview();
            await calculateScore();
        });

        // Event handler for platform change
        $("#fp-platform").on("change", () => updateUserAgent(false));
        
        // Optimize button handler
        $("#optimize-fingerprint").on("click", async function() {
            const proxyData = getProxyDataFromModal();
            const optimizedFingerprint = await generateSmartFingerprint(proxyData);
            
            // Always enforce real OS platform
            $("#fp-platform").val(REAL_PLATFORM);
            updateUserAgent(false);
            
            // Validate language exists in dropdown options before setting
            const languageSelect = $("#fp-language");
            const languageExists = languageSelect.find(`option[value="${optimizedFingerprint.language}"]`).length > 0;
            if (languageExists) {
                $("#fp-language").val(optimizedFingerprint.language);
                updateSearchableSelectDisplay('fp-language');
            } else {
                // Fallback to ip-based if the language doesn't exist in options
                $("#fp-language").val("ip-based");
                updateSearchableSelectDisplay('fp-language');
            }
            
            $("#fp-resolution").val(`${optimizedFingerprint.screenResolution.width}x${optimizedFingerprint.screenResolution.height}`);
            $("#fp-cores").val(optimizedFingerprint.hardwareConcurrency);
            $("#fp-memory").val(optimizedFingerprint.deviceMemory);
            
            // Timezone is always IP-based, no need to set
            
            // Set GPU vendor and model
            if (optimizedFingerprint.webgl?.vendor) {
                const vendor = optimizedFingerprint.webgl.vendor.includes('NVIDIA') ? 'NVIDIA' :
                              optimizedFingerprint.webgl.vendor.includes('AMD') ? 'AMD' :
                              optimizedFingerprint.webgl.vendor.includes('Intel') ? 'Intel' : 'NVIDIA';
                $("#fp-gpu-vendor").val(vendor);
                updateGPUModels();
                $("#fp-gpu-model").val(optimizedFingerprint.webgl.renderer);
                updateSearchableGPUSelectDisplay();
            }
            
            updateWebGLPreview();
            await calculateScore();
        });
        
        // Randomize button handler
        $("#randomize-fingerprint").on("click", async function() {
            const newFingerprint = generateRandomFingerprint();
            // Always enforce real OS platform
            $("#fp-platform").val(REAL_PLATFORM);
            updateUserAgent(true); // Update user agent with randomization
            
            // Only set language if it's not currently on "ip-based"
            const currentLanguage = $("#fp-language").val();
            if (currentLanguage !== "ip-based") {
                $("#fp-language").val(newFingerprint.language);
                updateSearchableSelectDisplay('fp-language');
            }
            
            $("#fp-resolution").val(`${newFingerprint.screenResolution.width}x${newFingerprint.screenResolution.height}`);
            $("#fp-cores").val(newFingerprint.hardwareConcurrency);
            $("#fp-memory").val(newFingerprint.deviceMemory);
            
            // Timezone is always IP-based, no need to randomize
            
            // Set random GPU
            const vendor = newFingerprint.webgl.vendor.includes('NVIDIA') ? 'NVIDIA' :
                          newFingerprint.webgl.vendor.includes('AMD') ? 'AMD' :
                          newFingerprint.webgl.vendor.includes('Intel') ? 'Intel' : 'NVIDIA';
            $("#fp-gpu-vendor").val(vendor);
            updateGPUModels();
            $("#fp-gpu-model").val(newFingerprint.webgl.renderer);
            updateSearchableGPUSelectDisplay();
            
            updateWebGLPreview();
            await calculateScore();
        });
        
        // Searchable select initialization for language
        function initSearchableSelect(selectId, options) {
            const wrapper = $(`#${selectId}-wrapper`);
            const searchInput = $(`#${selectId}-search`);
            const dropdown = $(`#${selectId}-dropdown`);
            const select = $(`#${selectId}`);
            
            // Show current value in search input
            updateSearchableSelectDisplay(selectId);
            
            // Focus handler
            searchInput.on('focus', function() {
                dropdown.addClass('open');
                renderDropdownOptions(selectId, '');
            });
            
            // Search input handler
            searchInput.on('input', function() {
                const query = $(this).val().toLowerCase();
                renderDropdownOptions(selectId, query);
            });
            
            // Click outside to close
            $(document).on('click.searchableSelect', function(e) {
                if (!wrapper.is(e.target) && wrapper.has(e.target).length === 0) {
                    dropdown.removeClass('open');
                    updateSearchableSelectDisplay(selectId);
                }
            });
        }
        
        function renderDropdownOptions(selectId, query) {
            const dropdown = $(`#${selectId}-dropdown`);
            const select = $(`#${selectId}`);
            dropdown.empty();
            
            select.find('option').each(function() {
                const value = $(this).val();
                const text = $(this).text();
                
                if ($(this).prop('disabled')) return;
                
                if (!query || text.toLowerCase().includes(query)) {
                    const item = $(`<div class="fp-dropdown-item" data-value="${value}">${text}</div>`);
                    if (select.val() === value) {
                        item.addClass('selected');
                    }
                    dropdown.append(item);
                }
            });
            
            // Click handler for dropdown items
            dropdown.find('.fp-dropdown-item').on('click', function() {
                const value = $(this).data('value');
                select.val(value).trigger('change');
                dropdown.removeClass('open');
                updateSearchableSelectDisplay(selectId);
            });
        }
        
        function updateSearchableSelectDisplay(selectId) {
            const select = $(`#${selectId}`);
            const searchInput = $(`#${selectId}-search`);
            const selectedText = select.find('option:selected').text();
            searchInput.val(selectedText);
        }
        
        // Searchable GPU model select
        function initSearchableGPUSelect() {
            const wrapper = $('#fp-gpu-model-wrapper');
            const searchInput = $('#fp-gpu-model-search');
            const dropdown = $('#fp-gpu-model-dropdown');
            const select = $('#fp-gpu-model');
            
            updateSearchableGPUSelectDisplay();
            
            searchInput.off('focus.gpuSearch').on('focus.gpuSearch', function() {
                dropdown.addClass('open');
                renderGPUDropdownOptions('');
            });
            
            searchInput.off('input.gpuSearch').on('input.gpuSearch', function() {
                const query = $(this).val().toLowerCase();
                renderGPUDropdownOptions(query);
            });
            
            $(document).off('click.gpuSearchableSelect').on('click.gpuSearchableSelect', function(e) {
                if (!wrapper.is(e.target) && wrapper.has(e.target).length === 0) {
                    dropdown.removeClass('open');
                    updateSearchableGPUSelectDisplay();
                }
            });
        }
        
        function renderGPUDropdownOptions(query) {
            const dropdown = $('#fp-gpu-model-dropdown');
            const select = $('#fp-gpu-model');
            dropdown.empty();
            
            select.find('option').each(function() {
                const value = $(this).val();
                const text = $(this).text();
                
                if (!query || text.toLowerCase().includes(query)) {
                    const item = $(`<div class="fp-dropdown-item" data-value="${value}">${text}</div>`);
                    if (select.val() === value) {
                        item.addClass('selected');
                    }
                    dropdown.append(item);
                }
            });
            
            dropdown.find('.fp-dropdown-item').on('click', function() {
                const value = $(this).data('value');
                select.val(value).trigger('change');
                dropdown.removeClass('open');
                updateSearchableGPUSelectDisplay();
                updateWebGLPreview();
            });
        }
        
        function updateSearchableGPUSelectDisplay() {
            const select = $('#fp-gpu-model');
            const searchInput = $('#fp-gpu-model-search');
            const selectedText = select.find('option:selected').text();
            searchInput.val(selectedText || 'Select GPU model...');
        }
    }

    // Function to update user agent based on selected platform
    function updateUserAgent(isRandomizing = false) {
        const platform = $("#fp-platform").val();
        const chromeVersion = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
        let userAgent;
        
        switch (platform) {
            case 'Win32':
                // Random Windows versions: Windows 10 or Windows 11
                const windowsVersions = [
                    'Windows NT 10.0; Win64; x64',     // Windows 10
                    'Windows NT 10.0; Win64; x64',     // Windows 10 (more common)
                    'Windows NT 10.0; Win64; x64',     // Windows 10 (more common)
                    'Windows NT 10.0; Win64; x64',     // Windows 10 (more common)
                    'Windows NT 10.0; Win64; x64; WebView/3.0', // Windows 10 WebView
                    'Windows NT 10.0; WOW64',          // Windows 10 32-bit on 64-bit
                ];
                const windowsVersion = windowsVersions[Math.floor(Math.random() * windowsVersions.length)];
                userAgent = `Mozilla/5.0 (${windowsVersion}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                break;
                
            case 'MacIntel':
                // Random macOS versions
                const macVersions = [
                    '10_15_7',    // Catalina
                    '11_0_0',     // Big Sur
                    '11_6_0',     // Big Sur
                    '12_0_0',     // Monterey
                    '12_6_0',     // Monterey
                    '13_0_0',     // Ventura
                    '13_4_0',     // Ventura
                    '14_0_0',     // Sonoma
                    '14_2_0',     // Sonoma
                    '14_4_0'      // Sonoma
                ];
                const macVersion = macVersions[Math.floor(Math.random() * macVersions.length)];
                userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macVersion}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                break;
                
            case 'Linux x86_64':
                // Random Linux distributions and architectures
                const linuxVariants = [
                    'X11; Linux x86_64',
                    'X11; Linux x86_64',
                    'X11; Linux x86_64',           // Most common
                    'X11; Linux i686',             // 32-bit
                    'X11; Ubuntu; Linux x86_64',   // Ubuntu specific
                    'X11; Ubuntu; Linux i686',     // Ubuntu 32-bit
                    'X11; Fedora; Linux x86_64',   // Fedora
                    'X11; CrOS x86_64',            // Chrome OS
                    'X11; Linux armv7l',           // ARM (Raspberry Pi, etc.)
                    'X11; Linux aarch64'           // ARM 64-bit
                ];
                const linuxVariant = linuxVariants[Math.floor(Math.random() * linuxVariants.length)];
                userAgent = `Mozilla/5.0 (${linuxVariant}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                break;
                
            default:
                // Default to random Windows
                const defaultWindowsVersions = ['Windows NT 10.0; Win64; x64', 'Windows NT 6.3; Win64; x64'];
                const defaultVersion = defaultWindowsVersions[Math.floor(Math.random() * defaultWindowsVersions.length)];
                userAgent = `Mozilla/5.0 (${defaultVersion}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        }
        
        $("#fp-useragent").val(userAgent);
    }

    // GPU data for consistent vendor/renderer matching - Expanded with more realistic options
    function getGPUData() {
        return {
            'NVIDIA': [
                // GTX 10 Series
                { name: 'GeForce GTX 1050 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1060 3GB', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 3GB Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1060 6GB', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1070', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1070 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1080', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1080 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // GTX 16 Series
                { name: 'GeForce GTX 1650', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1650 Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1660', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1660 Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce GTX 1660 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RTX 20 Series
                { name: 'GeForce RTX 2060', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 2060 Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 2070', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 2070 Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 2080', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 2080 Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 2080 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RTX 30 Series
                { name: 'GeForce RTX 3050', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3060', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3060 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3070', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3070 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3080', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3080 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3090', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3090 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RTX 40 Series
                { name: 'GeForce RTX 4060', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4060 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4070', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4070 Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4070 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4070 Ti Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4080', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4080 Super', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4090', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RTX 50 Series (Latest)
                { name: 'GeForce RTX 5070', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 5070 Ti', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 5080', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 5090', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // Laptop GPUs
                { name: 'GeForce RTX 3050 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3060 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 3070 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4050 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4060 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4070 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4080 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'GeForce RTX 4090 Laptop', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' }
            ],
            'AMD': [
                // RX 500 Series
                { name: 'Radeon RX 570', renderer: 'ANGLE (AMD, AMD Radeon RX 570 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 580', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 590', renderer: 'ANGLE (AMD, AMD Radeon RX 590 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RX 5000 Series
                { name: 'Radeon RX 5500 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 5500 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 5600 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 5600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 5700', renderer: 'ANGLE (AMD, AMD Radeon RX 5700 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 5700 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RX 6000 Series
                { name: 'Radeon RX 6500 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6500 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6600', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6600 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6650 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6650 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6700 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6750 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6750 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6800', renderer: 'ANGLE (AMD, AMD Radeon RX 6800 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6800 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6900 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6900 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6950 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 6950 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RX 7000 Series
                { name: 'Radeon RX 7600', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7600 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7700 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 7700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7800 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7900 GRE', renderer: 'ANGLE (AMD, AMD Radeon RX 7900 GRE Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7900 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 7900 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7900 XTX', renderer: 'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // RX 9000 Series (Latest)
                { name: 'Radeon RX 9070', renderer: 'ANGLE (AMD, AMD Radeon RX 9070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 9070 XT', renderer: 'ANGLE (AMD, AMD Radeon RX 9070 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // Laptop GPUs
                { name: 'Radeon RX 6600M', renderer: 'ANGLE (AMD, AMD Radeon RX 6600M Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 6700M', renderer: 'ANGLE (AMD, AMD Radeon RX 6700M Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7600M XT', renderer: 'ANGLE (AMD, AMD Radeon RX 7600M XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon RX 7700S', renderer: 'ANGLE (AMD, AMD Radeon RX 7700S Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // Integrated Graphics
                { name: 'Radeon Graphics (Ryzen)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon Vega 8', renderer: 'ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon Vega 11', renderer: 'ANGLE (AMD, AMD Radeon(TM) Vega 11 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon 780M', renderer: 'ANGLE (AMD, AMD Radeon 780M Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Radeon 880M', renderer: 'ANGLE (AMD, AMD Radeon 880M Direct3D11 vs_5_0 ps_5_0, D3D11)' }
            ],
            'Intel': [
                // HD Graphics
                { name: 'Intel HD Graphics 520', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel HD Graphics 530', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 530 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel HD Graphics 620', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel HD Graphics 630', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // UHD Graphics
                { name: 'Intel UHD Graphics 600', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel UHD Graphics 620', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel UHD Graphics 630', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel UHD Graphics 730', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel UHD Graphics 770', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // Iris Graphics
                { name: 'Intel Iris Plus Graphics 640', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics 640 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Iris Plus Graphics 650', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics 650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Iris Plus Graphics', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Iris Xe Graphics', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Iris Xe Graphics G7', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics G7 96EU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                // Intel Arc (Discrete)
                { name: 'Intel Arc A310', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A310 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Arc A380', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A380 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Arc A580', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A580 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Arc A750', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Arc A770', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
                { name: 'Intel Arc B580', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }
            ],
            'Apple': [
                // Apple Silicon
                { name: 'Apple M1', renderer: 'Apple M1' },
                { name: 'Apple M1 Pro', renderer: 'Apple M1 Pro' },
                { name: 'Apple M1 Max', renderer: 'Apple M1 Max' },
                { name: 'Apple M1 Ultra', renderer: 'Apple M1 Ultra' },
                { name: 'Apple M2', renderer: 'Apple M2' },
                { name: 'Apple M2 Pro', renderer: 'Apple M2 Pro' },
                { name: 'Apple M2 Max', renderer: 'Apple M2 Max' },
                { name: 'Apple M2 Ultra', renderer: 'Apple M2 Ultra' },
                { name: 'Apple M3', renderer: 'Apple M3' },
                { name: 'Apple M3 Pro', renderer: 'Apple M3 Pro' },
                { name: 'Apple M3 Max', renderer: 'Apple M3 Max' },
                { name: 'Apple M4', renderer: 'Apple M4' },
                { name: 'Apple M4 Pro', renderer: 'Apple M4 Pro' },
                { name: 'Apple M4 Max', renderer: 'Apple M4 Max' }
            ]
        };
    }

    function getWebGLVendor(gpuVendor) {
        const vendorMap = {
            'NVIDIA': 'Google Inc. (NVIDIA)',
            'AMD': 'Google Inc. (AMD)',
            'Intel': 'Google Inc. (Intel)',
            'Apple': 'Apple Inc.'
        };
        return vendorMap[gpuVendor] || 'Google Inc. (NVIDIA)';
    }

    // Helper function to check if a string is a valid IP address (not a hostname)
    function isIPAddress(str) {
        if (!str) return false;
        // IPv4 pattern: matches xxx.xxx.xxx.xxx where xxx is 0-255
        const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
        // IPv6 pattern (simplified)
        const ipv6Pattern = /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;
        
        if (ipv4Pattern.test(str)) {
            // Validate each octet is 0-255
            const octets = str.split('.');
            return octets.every(octet => parseInt(octet, 10) >= 0 && parseInt(octet, 10) <= 255);
        }
        return ipv6Pattern.test(str);
    }

    // Smart fingerprint generation based on IP location
    async function generateSmartFingerprint(proxyData = null) {
        let ipInfo = null;
        
        try {
            if (proxyData && proxyData.ip && isIPAddress(proxyData.ip)) {
                // Only lookup if proxy.ip is an actual IP address, not a hostname
                const response = await fetch(`https://api.ipregistry.co/${proxyData.ip}?key=ira_Gx7CP9EIZQ6KxPQMfAGfyb5wznsWyc1ELma6`);
                if (response.ok) {
                    ipInfo = await response.json();
                }
            } else if (!proxyData || !proxyData.ip) {
                // No proxy specified, use user's actual IP
                const response = await fetch(`https://api.ipregistry.co/?key=ira_Gx7CP9EIZQ6KxPQMfAGfyb5wznsWyc1ELma6`);
                if (response.ok) {
                    ipInfo = await response.json();
                }
            }
            // If proxyData.ip is a hostname (not an IP), skip the lookup and use default values
        } catch (error) {
            console.log("Could not fetch IP info:", error);
        }

        // Always use the real OS platform for consistency and detection avoidance
        const platform = REAL_PLATFORM;
        
        const gpuData = getGPUData();
        // Filter out Apple GPU for non-Mac platforms
        const availableVendors = platform === 'MacIntel' 
            ? Object.keys(gpuData) 
            : Object.keys(gpuData).filter(v => v !== 'Apple');
        const selectedVendor = availableVendors[Math.floor(Math.random() * availableVendors.length)];
        const selectedGPU = gpuData[selectedVendor][Math.floor(Math.random() * gpuData[selectedVendor].length)];

        const resolutions = [
            { width: 1920, height: 1080 },  // Full HD (most common)
            { width: 1366, height: 768 },   // HD (common laptop)
            { width: 2560, height: 1440 },  // 1440p/QHD
            { width: 3840, height: 2160 },  // 4K UHD
            { width: 1680, height: 1050 },  // WSXGA+
            { width: 1600, height: 900 },   // HD+
            { width: 1440, height: 900 },   // WXGA+
            { width: 1280, height: 1024 },  // SXGA
            { width: 1280, height: 720 }    // 720p HD
        ];

        let language = 'en-US';
        let timezone = 'America/New_York';
        
        if (ipInfo) {
            // Use location data to set more realistic defaults
            if (ipInfo.location && ipInfo.location.language) {
                language = ipInfo.location.language.code || 'en-US';
            }
            if (ipInfo.time_zone && ipInfo.time_zone.id) {
                timezone = ipInfo.time_zone.id;
            }
        }

        const fingerprint = {
            userAgent: generateUserAgent(platform, false),
            platform: platform,
            language: language,
            languages: language.includes('en') ? ["en-US", "en"] : [language, language.split('-')[0]],
            hardwareConcurrency: [4, 6, 8, 12][Math.floor(Math.random() * 4)],
            deviceMemory: [4, 8, 16][Math.floor(Math.random() * 3)],
            screenResolution: resolutions[Math.floor(Math.random() * resolutions.length)],
            timezone: timezone,
            webgl: {
                vendor: getWebGLVendor(selectedVendor),
                renderer: selectedGPU.renderer
            },
            canvas: generateCanvasNoise(resolutions[0].width, resolutions[0].height),
            audioContext: generateAudioContextNoise(),
            fonts: ["Arial", "Times New Roman", "Courier New", "Calibri", "Cambria", "Verdana", "Georgia"],
            plugins: [],
            doNotTrack: Math.random() > 0.5 ? "1" : "0",
            cookieEnabled: true,
            onLine: true,
            colorDepth: 24,
            pixelDepth: 24,
            ipInfo: ipInfo
        };

        return fingerprint;

        function generateUserAgent(platform, isRandomizing = false) {
            const chromeVersion = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
            
            switch (platform) {
                case 'Win32':
                    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                case 'MacIntel':
                    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                case 'Linux x86_64':
                    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                default:
                    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
            }
        }
    }

    // Scoring system
    async function calculateScore() {
        let score = 100;
        const issues = [];

        // Check WebGL consistency
        const gpuVendor = $("#fp-gpu-vendor").val();
        const gpuRenderer = $("#fp-gpu-model").val();
        const webglVendor = getWebGLVendor(gpuVendor);
        
        if (!gpuRenderer.includes(gpuVendor)) {
            score -= 30;
            issues.push("WebGL vendor/renderer mismatch");
        }

        // Check platform and user agent consistency
        const platform = $("#fp-platform").val();
        const userAgent = $("#fp-useragent").val();
        
        if (platform === 'Win32' && !userAgent.includes('Windows')) {
            score -= 20;
            issues.push("Platform/User Agent mismatch");
        }
        if (platform === 'MacIntel' && !userAgent.includes('Macintosh')) {
            score -= 20;
            issues.push("Platform/User Agent mismatch");
        }
        if (platform === 'Linux x86_64' && !userAgent.includes('Linux')) {
            score -= 20;
            issues.push("Platform/User Agent mismatch");
        }

        // Check hardware consistency (GPU vs RAM/CPU)
        const cores = parseInt($("#fp-cores").val());
        const memory = parseInt($("#fp-memory").val());
        
        // Check for unrealistic high-end specs
        if (cores > 16 || memory > 32) {
            score -= 15;
            issues.push("Unrealistic hardware specs");
        }
        
        // Check GPU-RAM-CPU consistency
        const isHighEndGPU = gpuRenderer.includes('RTX 30') || gpuRenderer.includes('RTX 40') || 
                            gpuRenderer.includes('RTX 50') || gpuRenderer.includes('RX 6700') || 
                            gpuRenderer.includes('RX 7') || gpuRenderer.includes('RX 9');
        
        const isMidRangeGPU = gpuRenderer.includes('GTX 1070') || gpuRenderer.includes('GTX 1080') ||
                             gpuRenderer.includes('GTX 16') || gpuRenderer.includes('RTX 20') ||
                             gpuRenderer.includes('RX 580') || gpuRenderer.includes('RX 6600');
        
        // High-end GPU with low RAM/CPU cores is unrealistic
        if (isHighEndGPU && (memory <= 4 || cores <= 4)) {
            score -= 25;
            issues.push("High-end GPU with insufficient RAM/CPU");
        }
        
        // Mid-range GPU with very low specs is also questionable
        if (isMidRangeGPU && memory <= 4 && cores <= 4) {
            score -= 15;
            issues.push("GPU-RAM-CPU combination seems unbalanced");
        }
        
        // Intel integrated graphics with high-end specs is suspicious (but Arc GPUs are ok)
        if (gpuVendor === 'Intel' && !gpuRenderer.includes('Arc') && (memory >= 32 || cores >= 12)) {
            score -= 20;
            issues.push("Intel integrated GPU with high-end specs is uncommon");
        }
        
        // Apple M1/M2/M3/M4 should have consistent specs
        if (gpuRenderer.includes('Apple M') && platform !== 'MacIntel') {
            score -= 30;
            issues.push("Apple GPU on non-Mac platform");
        }

        // Check language consistency with IP (timezone is always IP-based now)
        const language = $("#fp-language").val();
        
        // Get IP information for geographical consistency check
        const proxyIP = $("#proxy-ip").val();
        let ipGeoData = null;
        
        try {
            // Use proxy IP if provided, otherwise get user's real IP
            let apiUrl;
            if (proxyIP && isIPAddress(proxyIP)) {
                // Only lookup if proxy IP is an actual IP address, not a hostname
                apiUrl = `https://api.ipregistry.co/${proxyIP}?key=ira_Gx7CP9EIZQ6KxPQMfAGfyb5wznsWyc1ELma6`;
            } else if (!proxyIP) {
                // No proxy IP specified, use user's actual IP
                apiUrl = `https://api.ipregistry.co/?key=ira_Gx7CP9EIZQ6KxPQMfAGfyb5wznsWyc1ELma6`;
            }
            // If proxyIP is a hostname (not an IP), skip the lookup
            
            if (apiUrl) {
                const response = await fetch(apiUrl);
                if (response.ok) {
                    ipGeoData = await response.json();
                }
            }
        } catch (error) {
            console.log("Could not fetch IP geolocation data:", error);
        }
        
        // Check geographical consistency with actual IP location
        if (ipGeoData) {
            const ipLanguage = ipGeoData.location?.language?.code || 'en-US';
            const ipCountry = ipGeoData.location?.country?.name || 'Unknown';
            
            // Check language consistency - ALWAYS apply penalty if wrong
            if (language !== "ip-based") {
                if (language !== ipLanguage) {
                    // Check if they're at least from the same continent/region
                    const selectedContinent = getLanguageContinent(language);
                    const ipContinent = getLanguageContinent(ipLanguage);
                    
                    if (selectedContinent !== ipContinent && selectedContinent !== 'mixed' && ipContinent !== 'mixed') {
                        score -= 20;
                        issues.push(`Language ${language} doesn't match IP location (${ipCountry} uses ${ipLanguage})`);
                    } else {
                        score -= 10;
                        issues.push(`Language ${language} is uncommon for IP location (${ipCountry})`);
                    }
                }
            }
            // Timezone is always IP-based, so no penalty needed
        }
        
        // No fallback needed - timezone is always IP-based

        score = Math.max(0, score);
        updateScoreDisplay(score, issues);
        return score;
    }

    // Function to check geographical inconsistencies between language and timezone
    function checkGeographicalInconsistencies(language, timezone) {
        const inconsistencies = [];
        
        // Skip checks for IP-based selections
        if (language === "ip-based" || timezone === "ip-based") {
            return inconsistencies;
        }
        
        // Enhanced language-timezone consistency checking
        const commonLanguageTimezones = {
            'en-US': ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
            'en-GB': ['Europe/London'],
            'fr-FR': ['Europe/Paris'],
            'de-DE': ['Europe/Berlin'],
            'es-ES': ['Europe/Madrid'],
            'pt-BR': ['America/Sao_Paulo', 'America/Fortaleza'],
            'it-IT': ['Europe/Rome'],
            'ru-RU': ['Europe/Moscow', 'Asia/Yekaterinburg'],
            'ja-JP': ['Asia/Tokyo'],
            'zh-CN': ['Asia/Shanghai'],
            'ar-AE': ['Asia/Dubai'],
            'hi-IN': ['Asia/Kolkata'],
            'en-IN': ['Asia/Kolkata'],
            'en-AU': ['Australia/Sydney', 'Australia/Melbourne'],
            'en-NZ': ['Pacific/Auckland'],
            'ar-MA': ['Africa/Casablanca'], // Morocco Arabic
            'fr-CA': ['America/Toronto', 'America/Montreal']
        };
        
        // Enhanced timezone-language consistency checking
        const timezoneCommonLanguages = {
            'America/New_York': ['en-US'],
            'America/Los_Angeles': ['en-US'],
            'America/Chicago': ['en-US'],
            'America/Denver': ['en-US'],
            'America/Sao_Paulo': ['pt-BR'],
            'Europe/London': ['en-GB'],
            'Europe/Paris': ['fr-FR'],
            'Europe/Berlin': ['de-DE'],
            'Europe/Madrid': ['es-ES'],
            'Europe/Rome': ['it-IT'],
            'Europe/Moscow': ['ru-RU'],
            'Asia/Tokyo': ['ja-JP'],
            'Asia/Shanghai': ['zh-CN'],
            'Asia/Dubai': ['ar-AE'],
            'Asia/Kolkata': ['hi-IN', 'en-IN'],
            'Australia/Sydney': ['en-AU'],
            'Pacific/Auckland': ['en-NZ'],
            'Africa/Casablanca': ['ar-MA', 'fr-FR'], // Morocco supports Arabic and French
            'America/Toronto': ['en-US', 'fr-CA']
        };
        
        // Check language-timezone consistency
        const expectedTimezones = commonLanguageTimezones[language];
        if (expectedTimezones && !expectedTimezones.includes(timezone)) {
            // Check if it's at least the same continent
            const languageContinent = getLanguageContinent(language);
            const timezoneContinent = timezone.split('/')[0];
            
            if (languageContinent !== 'mixed' && languageContinent !== timezoneContinent) {
                inconsistencies.push(`${language} language with ${timezone} timezone is geographically inconsistent`);
            } else {
                inconsistencies.push(`${language} language with ${timezone} timezone is uncommon but possible`);
            }
        }
        
        // Check timezone-language consistency
        const expectedLanguages = timezoneCommonLanguages[timezone];
        if (expectedLanguages && !expectedLanguages.includes(language)) {
            const languageContinent = getLanguageContinent(language);
            const timezoneContinent = timezone.split('/')[0];
            
            // Only flag major inconsistencies
            if (languageContinent !== 'mixed' && languageContinent !== timezoneContinent) {
                inconsistencies.push(`${timezone} timezone rarely uses ${language} language`);
            }
        }
        
        return inconsistencies;
    }
    
    // Helper function to determine language continent
    function getLanguageContinent(language) {
        const continentMap = {
            'en-US': 'America',
            'en-GB': 'Europe', 
            'fr-FR': 'Europe',
            'de-DE': 'Europe',
            'es-ES': 'Europe',
            'pt-BR': 'America',
            'it-IT': 'Europe',
            'ru-RU': 'mixed', // Russia spans continents
            'ja-JP': 'Asia',
            'zh-CN': 'Asia',
            'ar-AE': 'Asia',
            'hi-IN': 'Asia',
            'en-IN': 'Asia',
            'en-AU': 'Australia',
            'en-NZ': 'Pacific',
            'fr-CA': 'America',
            'es-MX': 'America',
            'pt-PT': 'Europe'
        };
        return continentMap[language] || 'mixed';
    }

    function updateScoreDisplay(score, issues) {
        const scoreElement = $("#score-value");
        const detailsElement = $("#score-details");
        const scoreContainer = $("#profile-score");
        const scoreHeader = scoreContainer.find(".fp-score-header");
        
        scoreElement.text(score);
        
        // Update the icon
        let icon = 'verified';
        
        if (score >= 90) {
            scoreContainer.removeClass("fp-score-warning fp-score-bad").addClass("fp-score-good");
            icon = 'verified';
        } else if (score >= 70) {
            scoreContainer.removeClass("fp-score-good fp-score-bad").addClass("fp-score-warning");
            icon = 'warning';
        } else {
            scoreContainer.removeClass("fp-score-good fp-score-warning").addClass("fp-score-bad");
            icon = 'error';
        }
        
        // Update the icon in the header
        scoreHeader.find('.material-icons').text(icon);
        
        if (issues.length > 0) {
            detailsElement.html("<strong>Issues:</strong> " + issues.join(", "));
        } else {
            detailsElement.html("<strong>Perfect!</strong> All fingerprint components are consistent.");
        }
    }

    // Advanced noise generation functions for realistic fingerprinting
    function generateCanvasNoise(screenWidth, screenHeight) {
        // Generate noise based on screen resolution for more realistic fingerprinting
        const baseNoise = Math.random() * 0.0001; // Very subtle noise
        const resolutionFactor = (screenWidth * screenHeight) / 2073600; // Normalize to 1920x1080
        const adjustedNoise = baseNoise * (0.5 + resolutionFactor * 0.5);
        
        // Canvas size-specific noise patterns
        const canvasCategories = {
            'small': { threshold: 1366 * 768, noiseMultiplier: 0.8, patternComplexity: 8 },
            'medium': { threshold: 1920 * 1080, noiseMultiplier: 1.0, patternComplexity: 12 },
            'large': { threshold: 2560 * 1440, noiseMultiplier: 1.2, patternComplexity: 16 },
            'ultra': { threshold: 3840 * 2160, noiseMultiplier: 1.4, patternComplexity: 20 }
        };
        
        const currentResolution = screenWidth * screenHeight;
        let category = 'medium';
        
        if (currentResolution <= canvasCategories.small.threshold) category = 'small';
        else if (currentResolution <= canvasCategories.medium.threshold) category = 'medium';
        else if (currentResolution <= canvasCategories.large.threshold) category = 'large';
        else category = 'ultra';
        
        const config = canvasCategories[category];
        
        // Create sophisticated noise pattern based on resolution category
        const noisePattern = [];
        const seedValue = screenWidth + screenHeight + 42; // Pseudo-random seed
        for (let i = 0; i < config.patternComplexity; i++) {
            const x = ((seedValue * (i + 1) * 9301 + 49297) % 233280) / 233280;
            noisePattern.push(Math.floor(x * 255));
        }
        
        // Generate rendering context-specific variations
        const contextVariations = {
            '2d': {
                textRendering: Math.random() * 0.0001,
                lineWidth: 0.5 + Math.random() * 0.5,
                shadowOffset: Math.random() * 2
            },
            'webgl': {
                precision: Math.random() > 0.5 ? 'highp' : 'mediump',
                antialiasing: Math.random() > 0.3,
                premultipliedAlpha: Math.random() > 0.5
            }
        };
        
        // Device-specific rendering quirks simulation
        const deviceQuirks = {
            subpixelRendering: Math.random() > 0.7,
            colorProfile: ['sRGB', 'Display P3', 'Rec. 2020'][Math.floor(Math.random() * 3)],
            hardwareAcceleration: Math.random() > 0.2,
            fontSmoothing: Math.random() > 0.3
        };
        
        return {
            noiseLevel: adjustedNoise * config.noiseMultiplier,
            pattern: noisePattern,
            category: category,
            entropy: Math.random() * 1000000, // Unique entropy for each generation
            method: "Resolution-adaptive ImageData manipulation with context-aware noise",
            contextVariations: contextVariations,
            deviceQuirks: deviceQuirks,
            fingerprint: {
                width: screenWidth,
                height: screenHeight,
                hash: `${screenWidth}x${screenHeight}_${Math.floor(Math.random() * 999999)}`
            }
        };
    }
    
    function generateAudioContextNoise() {
        // Generate sophisticated audio context fingerprint noise
        const sampleRate = 44100 + Math.floor(Math.random() * 4000); // Vary sample rate slightly
        const bufferSize = 4096 + Math.floor(Math.random() * 4096); // Random buffer size
        
        // Generate unique frequency response pattern
        const frequencyResponse = [];
        for (let i = 0; i < 32; i++) {
            const frequency = Math.pow(2, i / 4) * 20;
            const response = Math.sin(frequency / 1000) + Math.random() * 0.1 - 0.05;
            frequencyResponse.push(parseFloat(response.toFixed(6)));
        }
        
        // Generate oscillator noise patterns
        const oscillatorNoise = {
            sine: Math.random() * 0.00001,
            square: Math.random() * 0.00001,
            sawtooth: Math.random() * 0.00001,
            triangle: Math.random() * 0.00001
        };
        
        return {
            sampleRate: sampleRate,
            bufferSize: bufferSize,
            frequencyResponse: frequencyResponse,
            oscillatorNoise: oscillatorNoise,
            dynamicsCompressor: {
                threshold: -24 + Math.random() * 6,
                knee: 30 + Math.random() * 10,
                ratio: 12 + Math.random() * 8,
                attack: 0.003 + Math.random() * 0.002,
                release: 0.25 + Math.random() * 0.1
            },
            entropy: Math.random() * 1000000,
            method: "Hybrid oscillator + compressor analysis"
        };
    }

    async function collectFingerprintData() {
        const resolution = $("#fp-resolution").val().split('x');
        let languageValue = $("#fp-language").val();
        let timezoneValue = $("#fp-timezone").val();
        
        // Handle IP-based selections
        if (languageValue === "ip-based" || timezoneValue === "ip-based") {
            try {
                const proxyData = {
                    ip: $("#proxy-ip").val() || '',
                    port: $("#proxy-port").val() || '',
                    username: $("#proxy-username").val() || '',
                    password: $("#proxy-password").val() || ''
                };
                
                let ipInfo = null;
                if (proxyData.ip && isIPAddress(proxyData.ip)) {
                    // Only lookup if proxy.ip is an actual IP address, not a hostname
                    const response = await fetch(`https://api.ipregistry.co/${proxyData.ip}?key=ira_Gx7CP9EIZQ6KxPQMfAGfyb5wznsWyc1ELma6`);
                    if (response.ok) {
                        ipInfo = await response.json();
                    }
                } else if (!proxyData.ip) {
                    // No proxy IP specified, use user's actual IP
                    const response = await fetch(`https://api.ipregistry.co/?key=ira_Gx7CP9EIZQ6KxPQMfAGfyb5wznsWyc1ELma6`);
                    if (response.ok) {
                        ipInfo = await response.json();
                    }
                }
                // If proxyData.ip is a hostname (not an IP), skip the lookup and use default values
                
                if (ipInfo) {
                    if (languageValue === "ip-based") {
                        languageValue = (ipInfo.location && ipInfo.location.language && ipInfo.location.language.code) || 'en-US';
                    }
                    if (timezoneValue === "ip-based") {
                        timezoneValue = (ipInfo.time_zone && ipInfo.time_zone.id) || 'America/New_York';
                    }
                }
            } catch (error) {
                console.log("Could not fetch IP info for smart defaults:", error);
                // Fallback to defaults
                if (languageValue === "ip-based") languageValue = 'en-US';
                if (timezoneValue === "ip-based") timezoneValue = 'America/New_York';
            }
        }
        
        // Map language to languages array
        const languageMap = {
            "en-US": ["en-US", "en"],
            "en-GB": ["en-GB", "en"],
            "fr-FR": ["fr-FR", "fr"],
            "de-DE": ["de-DE", "de"],
            "es-ES": ["es-ES", "es"]
        };
        
        const gpuVendor = $("#fp-gpu-vendor").val();
        const gpuRenderer = $("#fp-gpu-model").val();
        
        // Generate Chrome-specific runtime properties
        const chromeVersion = $("#fp-useragent").val().match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/)?.[1] || "131.0.0.0";
        const [majorVersion, minorVersion, buildVersion, patchVersion] = chromeVersion.split('.');
        
        return {
            userAgent: $("#fp-useragent").val(),
            platform: $("#fp-platform").val(),
            language: languageValue,
            languages: languageMap[languageValue] || ["en-US", "en"],
            screenResolution: {
                width: parseInt(resolution[0]),
                height: parseInt(resolution[1])
            },
            hardwareConcurrency: parseInt($("#fp-cores").val()),
            deviceMemory: parseInt($("#fp-memory").val()),
            timezone: timezoneValue,
            webgl: {
                vendor: getWebGLVendor(gpuVendor),
                renderer: gpuRenderer,
                version: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
                shadingLanguageVersion: "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)"
            },
            chrome: {
                runtime: {
                    version: chromeVersion,
                    majorVersion: parseInt(majorVersion),
                    minorVersion: parseInt(minorVersion),
                    buildVersion: parseInt(buildVersion),
                    patchVersion: parseInt(patchVersion)
                },
                app: {
                    isInstalled: false,
                    installState: "not_installed",
                    runningState: "cannot_run"
                },
                csi: {
                    startE: Date.now() - Math.floor(Math.random() * 5000),
                    onloadT: Date.now() - Math.floor(Math.random() * 3000)
                },
                loadTimes: {
                    commitLoadTime: (Date.now() - Math.floor(Math.random() * 2000)) / 1000,
                    connectionInfo: "h2",
                    finishDocumentLoadTime: (Date.now() - Math.floor(Math.random() * 1500)) / 1000,
                    finishLoadTime: (Date.now() - Math.floor(Math.random() * 1000)) / 1000,
                    firstPaintAfterLoadTime: 0,
                    firstPaintTime: (Date.now() - Math.floor(Math.random() * 1200)) / 1000,
                    navigationType: "navigate",
                    requestTime: (Date.now() - Math.floor(Math.random() * 3000)) / 1000,
                    startLoadTime: (Date.now() - Math.floor(Math.random() * 2500)) / 1000
                }
            },
            canvas: generateCanvasNoise(parseInt(resolution[0]), parseInt(resolution[1])),
            audioContext: generateAudioContextNoise(),
            fonts: ["Arial", "Times New Roman", "Courier New", "Calibri", "Cambria", "Verdana", "Georgia", "Segoe UI", "Helvetica Neue", "Roboto"],
            plugins: [],
            doNotTrack: Math.random() > 0.5 ? "1" : "0",
            cookieEnabled: true,
            onLine: true,
            colorDepth: 24,
            pixelDepth: 24
        };
    }

    async function getAllLanguageOptions(uiLocale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US') {
        const langDisplay = new Intl.DisplayNames([uiLocale], { type: 'language' });
        const regionDisplay = new Intl.DisplayNames([uiLocale], { type: 'region' });

        const candidates = [];
        for (let a = 97; a <= 122; a++) {
            for (let b = 97; b <= 122; b++) {
                candidates.push(String.fromCharCode(a, b));
            }
        }

        const supported = candidates.filter(tag => Intl.NumberFormat.supportedLocalesOf([tag]).length > 0);

        const seen = new Set();
        const options = [];

        for (const lang of supported) {
            let tag = lang;
            let region = null;
            try {
                const max = new Intl.Locale(lang).maximize();
                region = max.region || null;
                if (region) tag = `${lang}-${region}`;
            } catch { }

            if (seen.has(tag)) continue;
            seen.add(tag);

            const labelLang = langDisplay.of(lang) || lang.toUpperCase();
            const labelRegion = region ? (regionDisplay.of(region) || region) : null;
            const label = labelRegion ? `${labelLang} (${labelRegion})` : labelLang;

            options.push({ label, value: tag });
        }

        options.sort((a, b) => a.label.localeCompare(b.label, uiLocale));
        return options;
    }

    function getAllTimeZoneOptions() {
        const zones = (typeof Intl.supportedValuesOf === 'function')
            ? Intl.supportedValuesOf('timeZone')
            : [
                'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
                'Africa/Casablanca', 'America/New_York', 'America/Chicago', 'America/Denver',
                'America/Los_Angeles', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Kolkata',
                'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo',
                'Australia/Sydney', 'Pacific/Auckland'
            ];

        const now = new Date();
        function offsetStr(tz) {
            try {
                const dtf = new Intl.DateTimeFormat('en-US', {
                    timeZone: tz, hour12: false,
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                });
                const parts = Object.fromEntries(dtf.formatToParts(now).map(p => [p.type, p.value]));
                const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
                const offMin = Math.round((asUTC - now.getTime()) / 60000);
                const sign = offMin >= 0 ? '+' : '-';
                const abs = Math.abs(offMin);
                const hh = String(Math.floor(abs / 60)).padStart(2, '0');
                const mm = String(abs % 60).padStart(2, '0');
                return { offMin, label: `UTC${sign}${hh}:${mm}` };
            } catch {
                return { offMin: 0, label: 'UTC+00:00' };
            }
        }

        const opts = zones.map(z => {
            const { offMin, label } = offsetStr(z);
            const pretty = z.replace(/_/g, ' ');
            return {
                label: `(${label}) ${pretty}`,
                value: z,
                _offMin: offMin
            };
        });

        opts.sort((a, b) => a._offMin - b._offMin || a.value.localeCompare(b.value));
        return opts.map(({ label, value }) => ({ label, value }));
    }

    $("#structures-page").on("click", '#returnBack', async function () {
        $(".structure-area").hide();
        $(".structures-list-container").show();
        updateStructures();
    });

    lastStructureString = "";

    setInterval(updateStructures, 3000);

    function generateRandomFingerprint() {
        // Only use values that exist in the dropdown options
        // Always use the real OS platform - never randomize to a different OS
        
        // Available language codes that will be in the language dropdown
        const languageCodes = ["en-US", "en-GB", "fr-FR", "de-DE", "es-ES", "pt-BR", "it-IT", "ru-RU", "ja-JP", "zh-CN"];
        
        // Common timezone values that will be in the timezone dropdown
        const timezones = [
            "America/New_York", "America/Los_Angeles", "America/Chicago", "America/Denver",
            "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
            "Asia/Tokyo", "Asia/Shanghai", "Asia/Dubai", "Asia/Kolkata",
            "Australia/Sydney", "Pacific/Auckland"
        ];

        // Exact resolution options that match the dropdown
        const resolutions = [
            { width: 1920, height: 1080 },  // Full HD
            { width: 1366, height: 768 },   // HD
            { width: 2560, height: 1440 },  // 1440p/QHD
            { width: 3840, height: 2160 },  // 4K UHD
            { width: 1680, height: 1050 },  // WSXGA+
            { width: 1600, height: 900 },   // HD+
            { width: 1440, height: 900 },   // WXGA+
            { width: 1280, height: 1024 },  // SXGA
            { width: 1280, height: 720 }    // 720p HD
        ];

        // CPU cores that match dropdown options
        const availableCores = [4, 6, 8, 12, 16];
        
        // Memory options that match dropdown
        const availableMemory = [4, 8, 16, 32];

        const randomPlatform = REAL_PLATFORM;
        const randomLanguage = languageCodes[Math.floor(Math.random() * languageCodes.length)];
        const randomTimezone = timezones[Math.floor(Math.random() * timezones.length)];
        const randomResolution = resolutions[Math.floor(Math.random() * resolutions.length)];
        const randomCores = availableCores[Math.floor(Math.random() * availableCores.length)];
        const randomMemory = availableMemory[Math.floor(Math.random() * availableMemory.length)];
        
        // Use the GPU system with consistent vendor/renderer matching
        // Filter out Apple GPU for non-Mac platforms
        const gpuData = getGPUData();
        const availableVendors = randomPlatform === 'MacIntel' 
            ? Object.keys(gpuData) 
            : Object.keys(gpuData).filter(v => v !== 'Apple');
        const selectedVendor = availableVendors[Math.floor(Math.random() * availableVendors.length)];
        const selectedGPU = gpuData[selectedVendor][Math.floor(Math.random() * gpuData[selectedVendor].length)];

        // Generate user agent based on platform
        function generateUserAgent(platform, isRandomizing = false) {
            const chromeVersion = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
            
            switch (platform) {
                case 'Win32':
                    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                case 'MacIntel':
                    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                case 'Linux x86_64':
                    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
                default:
                    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
            }
        }

        // Map language to languages array format
        const languageMap = {
            "en-US": ["en-US", "en"],
            "en-GB": ["en-GB", "en"],
            "fr-FR": ["fr-FR", "fr"],
            "de-DE": ["de-DE", "de"],
            "es-ES": ["es-ES", "es"],
            "pt-BR": ["pt-BR", "pt"],
            "it-IT": ["it-IT", "it"],
            "ru-RU": ["ru-RU", "ru"],
            "ja-JP": ["ja-JP", "ja"],
            "zh-CN": ["zh-CN", "zh"]
        };

        return {
            userAgent: generateUserAgent(randomPlatform),
            platform: randomPlatform,
            language: randomLanguage,
            languages: languageMap[randomLanguage] || ["en-US", "en"],
            hardwareConcurrency: randomCores,
            deviceMemory: randomMemory,
            screenResolution: randomResolution,
            timezone: randomTimezone,
            webgl: {
                vendor: getWebGLVendor(selectedVendor),
                renderer: selectedGPU.renderer
            },
            canvas: generateCanvasNoise(randomResolution.width, randomResolution.height),
            audioContext: generateAudioContextNoise(),
            fonts: ["Arial", "Times New Roman", "Courier New", "Calibri", "Cambria", "Verdana", "Georgia"],
            plugins: [],
            doNotTrack: Math.random() > 0.5 ? "1" : "0",
            cookieEnabled: true,
            onLine: true,
            colorDepth: 24,
            pixelDepth: 24
        };
    }

    updateStructures();
    async function updateStructures() {
        const structures = await window.electronAPI.readKey("structures");
        const structuresString = JSON.stringify(structures)
        if (structuresString != lastStructureString) {
            lastStructureString = structuresString;
            $("#structuresGrid").html("");
            if (Object.keys(structures).length === 0) {
                $("#structuresGrid").hide();
                $("#nothing").show();
            } else {
                $("#structuresGrid").show();
                $("#nothing").hide();
                $.each(structures, function (id, structure) {
                    const profileCount = Object.keys(structure.profiles).length;
                    const profileText = profileCount === 1 
                        ? (window.I18n?.t('structures.profile') || 'profile')
                        : (window.I18n?.t('structures.profiles') || 'profiles');
                    const manageText = window.I18n?.t('structures.manage') || 'Manage';
                    const deleteText = window.I18n?.t('structures.delete') || 'Delete';
                    
                    const structureCard = `
                        <div class="structure-card">
                            <div class="structure-card-header">
                                <div class="structure-card-title">
                                    <div class="structure-card-icon">
                                        <i class="material-icons">folder</i>
                                    </div>
                                    <h3>${structure.label}</h3>
                                </div>
                            </div>
                            <div class="structure-card-body">
                                <div class="structure-stat">
                                    <i class="material-icons">people</i>
                                    <span><strong>${profileCount}</strong> ${profileText}</span>
                                </div>
                            </div>
                            <div class="structure-card-actions">
                                <button data-role="editStructure" data-id="${id}" class="structure-btn structure-btn-edit">
                                    <i class="material-icons">edit</i>
                                    <span>${manageText}</span>
                                </button>
                                <button data-role="deleteStructure" data-id="${id}" class="structure-btn structure-btn-delete">
                                    <i class="material-icons">delete</i>
                                    <span>${deleteText}</span>
                                </button>
                            </div>
                        </div>
                    `;
                    $("#structuresGrid").append(structureCard);
                });
            }
        }
    }

});
