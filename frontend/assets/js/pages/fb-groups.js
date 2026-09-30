/* ================================================================
   Facebook Groups Page — frontend/assets/js/pages/fb-groups.js
   ================================================================ */

$(document).ready(function () {

    // ── Namespace & Constants ───────────────────────────────────
    const NS = ".fbGroups";
    const GROUPS_PER_PAGE = 8;
    const LOG_PER_PAGE    = 10;

    // ── State ───────────────────────────────────────────────────
    let allGroups        = [];
    let filteredGroups   = [];
    let currentGroupId   = null;
    let currentPage      = 1;
    let currentLogPage   = 1;
    let searchDebounce   = null;
    let isLoading        = false;

    // ── New state for production automation UI ──────────────────
    let currentNavPage       = "dashboard";
    let allWorkflows         = [];
    let currentWfId          = null;           // workflow settings panel
    // liveLogEntries lives in window.fbGroupsManager.liveLogEntries (persists across navigations)
    let liveLogFilter        = "all";
    let dashRefreshInterval  = null;
    let postsRefreshInterval = null;
    let workflowsRefreshInterval = null;
    let workflowsCountdownInterval = null;
    let profilesRefreshInterval = null;
    let analyticsRangeDays   = 7;
    const MAX_LIVE_LOG_DOM   = 500;

    // ── Profiles page state ─────────────────────────────────────
    let allProfiles          = [];   // overview rows from backend
    let profileSearchTerm    = "";
    let pdCurrentProfileId   = null; // open profile detail modal
    let pdHistoryOffset      = 0;
    const PD_HISTORY_PER_PAGE = 20;

    // ── Helpers ─────────────────────────────────────────────────
    function t(key, fallback, params) {
        const translated = window.I18n?.t(key, params);
        if (translated && translated !== key) return translated;
        let out = fallback || key;
        if (params) {
            out = out.replace(/\{\{(\w+)\}\}/g, (m, p) => (params[p] != null ? params[p] : m));
        }
        return out;
    }

    function generateId() {
        return Math.random().toString(36).slice(2, 12) +
               Math.random().toString(36).slice(2, 12);
    }

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function facebookImageSrc(value) {
        if (!value) return "";
        const src = String(value);
        if (/^(https?:|data:|file:)/i.test(src)) return src;
        return "file:///" + src.replace(/\\/g, "/").replace(/^\/+/, "");
    }

    function relativeTime(isoStr) {
        if (!isoStr) return "—";
        const diff = Date.now() - new Date(isoStr).getTime();
        const s = Math.floor(diff / 1000);
        if (s < 60)  return t("common.just_now", "just now");
        const m = Math.floor(s / 60);
        if (m < 60)  return `${m}${t("common.min_ago", "m ago")}`;
        const h = Math.floor(m / 60);
        if (h < 24)  return `${h}${t("common.hr_ago", "h ago")}`;
        const d = Math.floor(h / 24);
        return `${d}${t("common.day_ago", "d ago")}`;
    }

    function formatDate(isoStr) {
        if (!isoStr) return "—";
        try {
            return new Date(isoStr).toLocaleString(undefined, {
                dateStyle: "short", timeStyle: "short"
            });
        } catch { return isoStr; }
    }

    // Human-readable remaining time for the "Next post in X" countdown on workflow cards.
    function formatCountdown(ms) {
        if (ms <= 0) return "";
        const totalSec = Math.round(ms / 1000);
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    // Returns the label text for a workflow's next-post line given its state.
    function nextPostLabel(nextPostAt, isRunning) {
        if (isRunning) return t("fb_groups.posting_now", "Posting…");
        if (!nextPostAt) return t("fb_groups.posting_soon", "Posting soon");
        const ms = new Date(nextPostAt).getTime() - Date.now();
        if (ms <= 0) return t("fb_groups.posting_soon", "Posting soon");
        return t("fb_groups.next_post_in", "Next post in {{time}}").replace("{{time}}", formatCountdown(ms));
    }

    // Tick every second: update each active workflow card's countdown text in place
    // (no full re-render, so it stays smooth between the 10s data refreshes).
    function updateWorkflowCountdowns() {
        $(".fbg-wf-next-post").each(function () {
            const $el = $(this);
            const nextPostAt = $el.attr("data-next-post-at") || "";
            const isRunning  = $el.attr("data-running") === "1";
            $el.find(".fbg-wf-next-text").text(nextPostLabel(nextPostAt, isRunning));
        });
    }

    // ── Init ────────────────────────────────────────────────────
    async function init() {
        await loadData();
        await loadVmPausedState();
        await loadDashboardStats();
        await loadWorkflows();
        initLiveLogs();
        setupEvents();
    }

    // Load the global viral-monitoring pause flag so `_vmPaused` is correct on
    // every page from the moment the page loads — not only after visiting Settings.
    // Without this, post cards would render live countdowns and the auto-trigger
    // would fire real checks even though monitoring is paused.
    async function loadVmPausedState() {
        try {
            const res = await window.electronAPI.fbGroupsGetSettings();
            const s = (res && res.success && res.data) ? res.data : {};
            _setViralMonitorPausedUI(!!s.viralMonitoringPaused);
        } catch (_) { /* leave _vmPaused as-is on error */ }
    }

    async function loadData() {
        try {
            const [groupsRes, statsRes] = await Promise.all([
                window.electronAPI.fbGroupsGetAll(),
                window.electronAPI.fbGroupsGetStats()
            ]);

            allGroups      = (groupsRes.success && Array.isArray(groupsRes.data)) ? groupsRes.data : [];
            filteredGroups = [...allGroups];
            currentPage    = 1;

            // Update stats bar
            if (statsRes.success && statsRes.data) {
                const s = statsRes.data;
                $("#statTotalGroups").text(s.totalGroups  || 0);
                $("#statTotalProfiles").text(s.totalProfiles || 0);
                $("#statPostsSent").text(s.totalPostsSent || 0);
            }

            renderGrid();
        } catch (err) {
            console.error("[FbGroups] loadData error:", err);
        } finally {
            // Hide skeleton on first load
            $("#fbgSkeleton").hide();
        }
    }

    // ── Grid Rendering ──────────────────────────────────────────
    function renderGrid() {
        const $grid = $("#fbgGrid");
        const $empty = $("#fbgEmptyState");
        const $pagination = $("#fbgPagination");

        if (filteredGroups.length === 0) {
            $grid.hide();
            $pagination.hide();
            $empty.show();
            return;
        }

        $empty.hide();
        $grid.show();

        const start = (currentPage - 1) * GROUPS_PER_PAGE;
        const slice = filteredGroups.slice(start, start + GROUPS_PER_PAGE);

        // Build all HTML at once — single innerHTML assignment for performance
        const html = slice.map((g, idx) => buildCardHtml(g, idx)).join("");
        $grid[0].innerHTML = html;

        renderPagination($pagination, filteredGroups.length);
    }

    function buildCardHtml(group, idx) {
        const delay = Math.min(idx * 40, 320); // stagger up to 8 cards
        const urlHtml = group.url
            ? `<a class="group-card-url" href="#" data-url="${escapeHtml(group.url)}" data-id="${group.groupId}">
                <span class="material-icons">link</span>
                ${escapeHtml(group.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}
               </a>`
            : "";
        const notesHtml = group.notes
            ? `<div class="group-card-notes">${escapeHtml(group.notes)}</div>`
            : "";
        const lastPost = group.lastPostAt ? relativeTime(group.lastPostAt) : t("fb_groups.no_posts_yet", "No posts yet");

        // Cover banner — coverImage from scan; profilePicture is a small thumbnail so
        // never stretch it into the banner.
        const coverSrc  = group.coverImage ? facebookImageSrc(group.coverImage) : null;
        const coverHtml = coverSrc
            ? `<div class="group-card-cover"><img src="${escapeHtml(coverSrc)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('.group-card-cover').classList.add('no-img');this.remove();"/></div>`
            : `<div class="group-card-cover no-img"></div>`;

        const hasRealName = group.name && group.name !== "Scanning…";
        const wasScanned  = !!group.lastScannedAt;
        const profileCount = group.profileCount || 0;
        // "Scanning…" only makes sense while a scan can actually run (a profile is linked).
        // With no profile, the scan is blocked — prompt the user to link one instead.
        // If the group was already scanned but name came back null (e.g. stale doc_id for
        // the root query), fall back to the URL slug so the card exits the scanning state.
        const isScanning = !hasRealName && !wasScanned && profileCount > 0;
        const needsProfile = !hasRealName && !wasScanned && profileCount === 0;
        const fallbackId = group.url ? (group.url.match(/\/groups\/([^/?#]+)/)?.[1] || "") : (group.groupId || "");
        const displayName = hasRealName
            ? group.name
            : (isScanning
                ? t("fb_groups.scanning_group", "Scanning…")
                : (wasScanned && fallbackId
                    ? fallbackId
                    : (t("fb_groups.link_profile_to_scan", "Link a profile to scan"))));
        const membersHtml = group.membersFormatted
            ? `<span class="group-card-members"><span class="material-icons">group</span>${escapeHtml(group.membersFormatted)}</span>`
            : (fallbackId && !hasRealName
                ? `<span class="group-card-members"><span class="material-icons">tag</span>${escapeHtml(fallbackId)}</span>`
                : "");

        return `
        <div class="group-card ${coverSrc ? "has-cover" : ""}" data-id="${group.groupId}" style="animation-delay:${delay}ms">
            ${coverHtml}
            <div class="group-card-head">
                <div class="group-card-head-info">
                    <h3 class="group-card-name ${isScanning ? "is-scanning" : ""} ${needsProfile ? "needs-profile" : ""}">${escapeHtml(displayName)}</h3>
                    ${membersHtml}
                </div>
                <div class="group-card-actions" data-stop-propagation>
                    <button class="group-card-btn edit" data-action="edit" data-id="${group.groupId}" title="${t("fb_groups.edit_group","Edit")}">
                        <span class="material-icons">edit</span>
                    </button>
                    <button class="group-card-btn delete" data-action="delete" data-id="${group.groupId}" title="${t("fb_groups.delete_group","Delete")}">
                        <span class="material-icons">delete_outline</span>
                    </button>
                </div>
            </div>
            <div class="group-card-body">
                ${urlHtml}
                ${notesHtml}
            </div>
            <div class="group-card-footer">
                <div class="group-card-profile-badge">
                    <span class="material-icons">person</span>
                    ${profileCount} ${t("fb_groups.profiles_count", "profiles")}
                </div>
                <div class="group-card-meta">
                    <span class="material-icons">schedule</span>
                    ${escapeHtml(lastPost)}
                </div>
            </div>
        </div>`;
    }

    function renderPagination($container, total) {
        if (total <= GROUPS_PER_PAGE) {
            $container.hide();
            return;
        }
        $container.show();
        const totalPages = Math.ceil(total / GROUPS_PER_PAGE);
        let html = `<button class="fbg-page-btn" id="fbgPrevPage" ${currentPage === 1 ? "disabled" : ""}>
                        <span class="material-icons" style="font-size:16px;">chevron_left</span>
                    </button>`;

        // Show max 7 page buttons with ellipsis
        const range = [];
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
                range.push(i);
            } else if (range[range.length - 1] !== "…") {
                range.push("…");
            }
        }
        range.forEach(p => {
            if (p === "…") {
                html += `<span class="fbg-page-info">…</span>`;
            } else {
                html += `<button class="fbg-page-btn ${p === currentPage ? "active" : ""}" data-page="${p}">${p}</button>`;
            }
        });

        html += `<button class="fbg-page-btn" id="fbgNextPage" ${currentPage === totalPages ? "disabled" : ""}>
                    <span class="material-icons" style="font-size:16px;">chevron_right</span>
                 </button>`;
        html += `<span class="fbg-page-info">${t("fb_groups.page_of","Page")} ${currentPage}/${totalPages}</span>`;
        $container.html(html);
    }

    // ── Search ──────────────────────────────────────────────────
    function applySearch(query) {
        const q = (query || "").trim().toLowerCase();
        if (!q) {
            filteredGroups = [...allGroups];
        } else {
            filteredGroups = allGroups.filter(g =>
                (g.name  || "").toLowerCase().includes(q) ||
                (g.url   || "").toLowerCase().includes(q) ||
                (g.notes || "").toLowerCase().includes(q)
            );
        }
        currentPage = 1;
        renderGrid();
    }

    // ── Create / Edit Group ─────────────────────────────────────
    async function showCreateModal() {
        const idLbl    = t("fb_groups.group_id",    "Group ID or URL");
        const notesLbl = t("fb_groups.group_notes", "Notes (optional)");

        const result = await newPrompt([
            { type: "text", name: idLbl,    required: true  },
            { type: "text", name: notesLbl, required: false }
        ]);
        if (!result) return;

        // Accept either a full group URL or a bare numeric id / vanity slug.
        const raw = (result[idLbl] || "").trim();
        const m   = raw.match(/\/groups\/([^/?#]+)/);
        const fbGroupId = (m ? m[1] : raw).trim();
        if (!fbGroupId) {
            showAlert("error", t("fb_groups.create_error", "Failed to create group"));
            return;
        }
        const autoUrl = `https://www.facebook.com/groups/${fbGroupId}`;

        const res = await window.electronAPI.fbGroupsCreate(
            generateId(),
            "",          // name is auto-filled by the scan once a profile is linked
            autoUrl,
            result[notesLbl] || ""
        );
        if (!res || !res.success) {
            showAlert("error", t("fb_groups.create_error", "Failed to create group"));
            return;
        }
        showAlert("success", t("fb_groups.group_created", "Group created!"));
        await loadData();
    }

    async function showEditModal(groupId) {
        const groupRes = await window.electronAPI.fbGroupsGetById(groupId);
        if (!groupRes || !groupRes.success || !groupRes.data) return;
        const group = groupRes.data;

        const nameLbl  = t("fb_groups.group_name",  "Group name");
        const idLbl    = t("fb_groups.group_id",    "Group ID");
        const notesLbl = t("fb_groups.group_notes", "Notes (optional)");

        // Extract existing group ID from stored URL if present
        const existingId = group.url
            ? (group.url.match(/\/groups\/([^/?#]+)/)?.[1] || "")
            : "";

        const result = await newPrompt([
            { type: "text", name: nameLbl,  required: true,  value: group.name  || "" },
            { type: "text", name: idLbl,    required: true,  value: existingId        },
            { type: "text", name: notesLbl, required: false, value: group.notes || "" }
        ]);
        if (!result) return;

        const fbGroupId = (result[idLbl] || "").trim();
        const autoUrl   = fbGroupId ? `https://www.facebook.com/groups/${fbGroupId}` : "";

        const res = await window.electronAPI.fbGroupsUpdate(
            groupId,
            result[nameLbl]  || "",
            autoUrl,
            result[notesLbl] || ""
        );
        if (!res || !res.success) {
            showAlert("error", t("fb_groups.update_error", "Failed to update group"));
            return;
        }
        showAlert("success", t("fb_groups.group_updated", "Group updated!"));
        await loadData();
        // Refresh detail panel if it's open for this group
        if (currentGroupId === groupId) {
            openDetailPanel(groupId);
        }
    }

    async function showNewPostModal(groupId) {
        const profilesCheck = await window.electronAPI.fbGroupsGetProfiles(groupId);
        if (!profilesCheck || !profilesCheck.success || !profilesCheck.data || profilesCheck.data.length === 0) {
            showAlert("warning", "No profiles linked to this group. Add a profile first.");
            return;
        }

        // Pick first profile initial for avatar
        const firstProfile = profilesCheck.data[0];
        const profileName  = firstProfile?.label || firstProfile?.profileId || "?";
        const avatarLetter = profileName.charAt(0).toUpperCase();

        return new Promise((resolve) => {
            const $overlay = $(`
                <div class="fbg-compose-overlay">
                    <div class="fbg-compose-modal">
                        <div class="fbg-compose-header">
                            <span>Create post</span>
                            <button type="button" class="fbg-compose-close"><span class="material-icons">close</span></button>
                        </div>
                        <div class="fbg-compose-divider"></div>
                        <div class="fbg-compose-body">
                            <div class="fbg-compose-author">
                                <div class="fbg-compose-avatar">${escapeHtml(avatarLetter)}</div>
                                <span class="fbg-compose-profile-name">${escapeHtml(profileName)}</span>
                            </div>
                            <textarea
                                class="fbg-compose-textarea"
                                placeholder="What's on your mind?"
                                rows="4"
                                maxlength="63206"
                            ></textarea>
                            <div class="fbg-compose-char-counter"><span class="fbg-char-count">0</span> / 63206</div>
                            <div class="fbg-compose-photo-preview" style="display:none;margin-top:8px;padding:6px 10px;background:var(--bg-secondary);border-radius:6px;border:1px solid var(--border-color);font-size:12px;align-items:center;gap:6px;">
                                <span class="material-icons" style="font-size:16px;color:var(--accent-color)">image</span>
                                <span class="fbg-compose-photo-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
                                <button type="button" class="fbg-compose-photo-remove" style="background:none;border:none;cursor:pointer;padding:0;line-height:1;color:var(--text-secondary)"><span class="material-icons" style="font-size:16px">close</span></button>
                            </div>
                        </div>
                        <div class="fbg-compose-footer">
                            <button type="button" class="fbg-compose-photo-btn" style="background:none;border:1px solid var(--border-color);border-radius:6px;padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:4px;font-size:13px;color:var(--text-secondary);">
                                <span class="material-icons" style="font-size:16px">add_photo_alternate</span>
                                <span>Photo</span>
                            </button>
                            <button type="button" class="fbg-compose-post-btn" disabled>
                                <span class="material-icons">send</span> Post
                            </button>
                        </div>
                    </div>
                </div>
            `);

            const $textarea  = $overlay.find(".fbg-compose-textarea");
            const $postBtn   = $overlay.find(".fbg-compose-post-btn");
            const $charCount = $overlay.find(".fbg-char-count");

            // Auto-grow + char counter
            $textarea.on("input", function () {
                this.style.height = "auto";
                this.style.height = Math.min(this.scrollHeight, 320) + "px";
                const len = this.value.length;
                $charCount.text(len);
                $postBtn.prop("disabled", len === 0);
            });

            // Close handlers
            function closeModal() {
                $overlay.remove();
                resolve(null);
            }
            $overlay.find(".fbg-compose-close").on("click", closeModal);
            $overlay.on("click", function (e) {
                if ($(e.target).is(".fbg-compose-overlay")) closeModal();
            });
            $(document).on("keydown.fbgCompose", function (e) {
                if (e.key === "Escape") { $(document).off("keydown.fbgCompose"); closeModal(); }
            });

            // Photo picker
            let selectedImagePath = null;
            $overlay.find(".fbg-compose-photo-btn").on("click", async function () {
                const files = await window.electronAPI.showOpenDialog({
                    title: "Select photo for post",
                    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
                    properties: ["openFile"],
                    buttonLabel: "Add Photo",
                });
                if (files && files[0]) {
                    selectedImagePath = files[0];
                    const fname = selectedImagePath.split(/[\/\\]/).pop();
                    $overlay.find(".fbg-compose-photo-name").text(fname);
                    $overlay.find(".fbg-compose-photo-preview").css({ display: "flex" });
                }
            });
            $overlay.find(".fbg-compose-photo-remove").on("click", function () {
                selectedImagePath = null;
                $overlay.find(".fbg-compose-photo-preview").css({ display: "none" });
            });

            // Post
            $postBtn.on("click", async function () {
                const message = $textarea.val().trim();
                if (!message) return;

                $postBtn.prop("disabled", true).html(
                    `<span class="material-icons fbg-spin">sync</span> Posting…`
                );
                $textarea.prop("disabled", true);
                $overlay.find(".fbg-compose-close").prop("disabled", true);
                $(document).off("keydown.fbgCompose");

                try {
                    const $panelBtn = $("#fbgNewPostBtn");
                    $panelBtn.prop("disabled", true).html(
                        `<span class="material-icons fbg-spin">sync</span><span>Posting…</span>`
                    );

                    const res = await window.electronAPI.fbGroupsNewPost(groupId, message, selectedImagePath);
                    $overlay.remove();
                    resolve(true);

                    if (!res || !res.success) {
                        showAlert("error", (res && res.error) || "Failed to post");
                    } else {
                        const pName = res.profileLabel || res.profileId || "";
                        showAlert("success", `Post sent successfully!` + (pName ? ` (${pName})` : ""));
                        await loadPanelLog(groupId, 1);
                        await loadData();
                    }

                    $panelBtn.prop("disabled", false).html(
                        `<span class="material-icons">send</span><span>New Post</span>`
                    );
                } catch (err) {
                    $overlay.remove();
                    resolve(null);
                    showAlert("error", err.message || "Failed to post");
                }
            });

            $("body").append($overlay);
            setTimeout(() => $textarea.focus(), 60);
        });
    }

    // Quick manual post from a SPECIFIC profile (Profiles page). Lets the user pick
    // one of the groups this profile is linked to, type text, optionally attach an
    // image, and post immediately via fb-groups-post-from-profile.
    async function showProfilePostModal(profileId, profileLabel) {
        let groups = [];
        try {
            const detail = await window.electronAPI.fbGroupsGetProfileDetail(String(profileId));
            groups = (detail && detail.success && detail.data && detail.data.groups) || [];
        } catch (_) { groups = []; }

        if (!groups.length) {
            showAlert("warning", t("fb_groups.post_no_groups", "This profile is not linked to any group. Link it to a group first."));
            return;
        }

        const profileName  = profileLabel || profileId || "?";
        const avatarLetter = String(profileName).charAt(0).toUpperCase();
        const groupOptions = groups.map((g) =>
            `<option value="${escapeHtml(g.groupId)}">${escapeHtml(g.groupName || g.groupId)}</option>`
        ).join("");

        const $overlay = $(`
            <div class="fbg-compose-overlay">
                <div class="fbg-compose-modal">
                    <div class="fbg-compose-header">
                        <span>${escapeHtml(t("fb_groups.post_from_profile", "Create a post"))}</span>
                        <button type="button" class="fbg-compose-close"><span class="material-icons">close</span></button>
                    </div>
                    <div class="fbg-compose-divider"></div>
                    <div class="fbg-compose-body">
                        <div class="fbg-compose-author">
                            <div class="fbg-compose-avatar">${escapeHtml(avatarLetter)}</div>
                            <span class="fbg-compose-profile-name">${escapeHtml(profileName)}</span>
                        </div>
                        <label class="fbg-compose-group-label">${escapeHtml(t("fb_groups.post_target_group", "Post to group"))}</label>
                        <select class="fbg-compose-group-select">${groupOptions}</select>
                        <textarea
                            class="fbg-compose-textarea"
                            placeholder="${escapeHtml(t("fb_groups.compose_placeholder", "What's on your mind?"))}"
                            rows="4"
                            maxlength="63206"
                        ></textarea>
                        <div class="fbg-compose-char-counter"><span class="fbg-char-count">0</span> / 63206</div>
                        <div class="fbg-compose-photo-preview" style="display:none;margin-top:8px;padding:6px 10px;background:var(--bg-secondary);border-radius:6px;border:1px solid var(--border-color);font-size:12px;align-items:center;gap:6px;">
                            <span class="material-icons" style="font-size:16px;color:var(--accent-color)">image</span>
                            <span class="fbg-compose-photo-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
                            <button type="button" class="fbg-compose-photo-remove" style="background:none;border:none;cursor:pointer;padding:0;line-height:1;color:var(--text-secondary)"><span class="material-icons" style="font-size:16px">close</span></button>
                        </div>
                    </div>
                    <div class="fbg-compose-footer">
                        <button type="button" class="fbg-compose-photo-btn" style="background:none;border:1px solid var(--border-color);border-radius:6px;padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:4px;font-size:13px;color:var(--text-secondary);">
                            <span class="material-icons" style="font-size:16px">add_photo_alternate</span>
                            <span>${escapeHtml(t("fb_groups.compose_photo", "Photo"))}</span>
                        </button>
                        <button type="button" class="fbg-compose-post-btn" disabled>
                            <span class="material-icons">send</span> ${escapeHtml(t("fb_groups.compose_post", "Post"))}
                        </button>
                    </div>
                </div>
            </div>
        `);

        const $textarea  = $overlay.find(".fbg-compose-textarea");
        const $postBtn   = $overlay.find(".fbg-compose-post-btn");
        const $charCount = $overlay.find(".fbg-char-count");
        const $groupSel  = $overlay.find(".fbg-compose-group-select");

        $textarea.on("input", function () {
            this.style.height = "auto";
            this.style.height = Math.min(this.scrollHeight, 320) + "px";
            const len = this.value.length;
            $charCount.text(len);
            $postBtn.prop("disabled", len === 0);
        });

        function closeModal() {
            $(document).off("keydown.fbgProfilePost");
            $overlay.remove();
        }
        $overlay.find(".fbg-compose-close").on("click", closeModal);
        $overlay.on("click", function (e) {
            if ($(e.target).is(".fbg-compose-overlay")) closeModal();
        });
        $(document).on("keydown.fbgProfilePost", function (e) {
            if (e.key === "Escape") closeModal();
        });

        // Photo picker
        let selectedImagePath = null;
        $overlay.find(".fbg-compose-photo-btn").on("click", async function () {
            const files = await window.electronAPI.showOpenDialog({
                title: t("fb_groups.compose_select_photo", "Select photo for post"),
                filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
                properties: ["openFile"],
                buttonLabel: t("fb_groups.compose_add_photo", "Add Photo"),
            });
            if (files && files[0]) {
                selectedImagePath = files[0];
                const fname = selectedImagePath.split(/[\/\\]/).pop();
                $overlay.find(".fbg-compose-photo-name").text(fname);
                $overlay.find(".fbg-compose-photo-preview").css({ display: "flex" });
            }
        });
        $overlay.find(".fbg-compose-photo-remove").on("click", function () {
            selectedImagePath = null;
            $overlay.find(".fbg-compose-photo-preview").css({ display: "none" });
        });

        // Post
        $postBtn.on("click", async function () {
            const message = $textarea.val().trim();
            const groupId = $groupSel.val();
            if (!message) return;
            if (!groupId) { showAlert("warning", t("fb_groups.post_select_group", "Please select a group.")); return; }

            $postBtn.prop("disabled", true).html(
                `<span class="material-icons fbg-spin">sync</span> ${escapeHtml(t("fb_groups.compose_posting", "Posting…"))}`
            );
            $textarea.prop("disabled", true);
            $groupSel.prop("disabled", true);
            $overlay.find(".fbg-compose-close, .fbg-compose-photo-btn").prop("disabled", true);
            $(document).off("keydown.fbgProfilePost");

            try {
                const res = await window.electronAPI.fbGroupsPostFromProfile(String(profileId), String(groupId), message, selectedImagePath);
                $overlay.remove();
                if (!res || !res.success) {
                    showAlert("error", (res && res.error) || t("fb_groups.post_failed", "Failed to post"));
                } else {
                    showAlert("success", t("fb_groups.post_sent", "Post sent successfully!"));
                    if (typeof loadProfiles === "function") { try { await loadProfiles(); } catch (_) {} }
                }
            } catch (err) {
                $overlay.remove();
                showAlert("error", err.message || t("fb_groups.post_failed", "Failed to post"));
            }
        });

        $("body").append($overlay);
        setTimeout(() => $textarea.focus(), 60);
    }

    async function showScanPostModal(groupId) {
        const profilesCheck = await window.electronAPI.fbGroupsGetProfiles(groupId);
        if (!profilesCheck || !profilesCheck.success || !profilesCheck.data || profilesCheck.data.length === 0) {
            showAlert("warning", "No profiles linked to this group. Add a profile first.");
            return;
        }

        // Pre-fill URL from most recent sent post if available
        const logRes = await window.electronAPI.fbGroupsGetPostLog(groupId, 20, 0);
        const rows   = (logRes && logRes.success && logRes.data && logRes.data.rows) || [];
        const recent = rows.find(r => r.status === "sent" && r.postId);
        let prefillUrl = "";
        if (recent && recent.postId) {
            try {
                const dec = atob(recent.postId);
                const m   = dec.match(/(\d{10,})$/);
                const grpM = (window._fbgCurrentGroupUrl || "").match(/\/groups\/([^/?#]+)/);
                if (m && grpM) prefillUrl = `https://www.facebook.com/groups/${grpM[1]}/posts/${m[1]}/`;
            } catch (_) {}
        }

        const result = await newPrompt([
            { type: "text", name: "Post URL", value: prefillUrl, placeholder: "https://www.facebook.com/groups/.../posts/...", required: true }
        ]);
        if (!result) return;

        const input = (result["Post URL"] || "").trim();
        if (!input) return;

        const $btn = $("#fbgScanPostBtn");
        $btn.prop("disabled", true).html(
            `<span class="material-icons fbg-spin">sync</span><span>Scanning…</span>`
        );

        try {
            const res = await window.electronAPI.fbGroupsScanPost(groupId, input);

            if (!res || !res.success) {
                showAlert("error", (res && res.error) || "Scan failed");
                return;
            }

            const p = res.post || {};
            const lines = [];
            if (p.authorName)    lines.push(`<b>Author:</b> ${escapeHtml(p.authorName)} (${escapeHtml(p.authorId || "")})`); 
            if (p.text)          lines.push(`<b>Text:</b> ${escapeHtml(p.text).replace(/\n/g, "<br>")}`); 
            if (p.createdTime)   lines.push(`<b>Posted:</b> ${new Date(p.createdTime * 1000).toLocaleString()}`); 
            if (p.reactionsCount != null) lines.push(`<b>Reactions:</b> ${p.reactionsCount}`);
            if (p.commentsCount  != null) lines.push(`<b>Comments:</b> ${p.commentsCount}`);
            if (p.sharesCount    != null) lines.push(`<b>Shares:</b> ${p.sharesCount}`);
            if (p.images && p.images.length) {
                lines.push(`<b>Images (${p.images.length}):</b><br>` +
                    p.images.map(u => `<a href="#" data-url="${escapeHtml(u)}" class="group-card-url" style="font-size:11px;word-break:break-all;">${escapeHtml(u)}</a>`).join("<br>"));
            }
            if (!lines.length) lines.push("Post scanned — no readable data extracted. Check console for raw response.");

            await newPrompt([
                { type: "html", content: `<div style="font-size:13px;line-height:1.8;">${lines.join("<br>")}</div>` }
            ]);

        } finally {
            $btn.prop("disabled", false).html(
                `<span class="material-icons">manage_search</span><span>Scan Post</span>`
            );
        }
    }

    async function showAddCommentModal(groupId) {
        // Verify at least one profile is linked
        const profilesCheck = await window.electronAPI.fbGroupsGetProfiles(groupId);
        if (!profilesCheck || !profilesCheck.success || !profilesCheck.data || profilesCheck.data.length === 0) {
            showAlert("warning", "No profiles linked to this group. Add a profile first.");
            return;
        }

        // Pre-fill story ID from most recent sent post
        const logRes = await window.electronAPI.fbGroupsGetPostLog(groupId, 20, 0);
        const rows   = (logRes && logRes.success && logRes.data && logRes.data.rows) || [];
        const recent = rows.find(r => r.status === "sent" && r.postId);
        const prefillId = recent ? recent.postId : "";

        const result = await newPrompt([
            { type: "text", name: "Story ID (base64 postId)", value: prefillId, required: true },
            { type: "text", name: "Comment", required: true }
        ]);
        if (!result) return;

        const storyId = (result["Story ID (base64 postId)"] || "").trim();
        const message = (result["Comment"] || "").trim();
        if (!storyId || !message) return;

        // Optional image — open native file dialog (cancel = no image)
        const imageFiles = await window.electronAPI.showOpenDialog({
            title: "Select image for comment (Cancel to skip)",
            filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
            properties: ["openFile"],
            buttonLabel: "Add Image",
        });
        const imagePath = imageFiles?.[0] || null;

        const $btn = $("#fbgCommentBtn");
        $btn.prop("disabled", true).html(
            `<span class="material-icons fbg-spin">sync</span><span>Posting…</span>`
        );

        try {
            const res = await window.electronAPI.fbGroupsAddComment(groupId, storyId, message, imagePath);

            if (!res || !res.success) {
                showAlert("error", (res && res.error) || "Failed to add comment");
            } else {
                const profileName = res.profileLabel || res.profileId || "";
                showAlert("success",
                    `Comment added successfully!` +
                    (profileName ? ` (${profileName})` : "")
                );
            }
        } finally {
            $btn.prop("disabled", false).html(
                `<span class="material-icons">comment</span><span>Add Comment</span>`
            );
        }
    }

    async function deleteGroup(groupId) {
        $(document.activeElement).blur();
        const confirmed = await confirmPrompt(t("fb_groups.confirm_delete", "Delete this group and all linked profiles? This cannot be undone."));
        if (!confirmed) return;

        const res = await window.electronAPI.fbGroupsDelete(groupId);
        if (!res || !res.success) {
            showAlert("error", t("fb_groups.delete_error", "Failed to delete group"));
            return;
        }
        showAlert("success", t("fb_groups.group_deleted", "Group deleted"));
        closeDetailPanel();
        await loadData();
    }

    // ── Detail Panel ────────────────────────────────────────────
    async function openDetailPanel(groupId) {
        currentGroupId = groupId;
        currentLogPage = 1;

        const $panel   = $("#fbgDetailPanel");
        const $overlay = $("#fbgOverlay");

        // Find group from local cache for instant header update
        const group = allGroups.find(g => g.groupId === groupId);
        // Store the group URL for use in log row post-link generation
        window._fbgCurrentGroupUrl = group ? (group.url || "") : "";
        if (group) {
            $("#fbgPanelGroupName").text(group.name);
            $("#fbgPanelGroupMeta").text(
                `${group.profileCount || 0} ${t("fb_groups.profiles_count","profiles")}`
            );
            // Info strip
            let infoHtml = "";
            if (group.url) {
                infoHtml += `<div style="margin-bottom:6px;font-size:13px;display:flex;align-items:center;gap:6px;color:var(--text-secondary)">
                    <span class="material-icons" style="font-size:15px;color:#1877F2;">link</span>
                    <a href="#" class="group-card-url" data-url="${escapeHtml(group.url)}" style="max-width:none;">${escapeHtml(group.url)}</a>
                </div>`;
            }
            if (group.notes) {
                infoHtml += `<div style="font-size:13px;color:var(--text-secondary);line-height:1.5;padding:8px;background:var(--bg-secondary);border-radius:8px;">
                    ${escapeHtml(group.notes)}
                </div>`;
            }
            $("#fbgPanelInfoSection").html(infoHtml || "");

            // Render the last cached scan result (if any) so it persists between opens.
            if (group.scanInfo) {
                $("#fbgPanelInfoSection").append(
                    buildScanInfoBox(group.scanInfo, { scannedAt: group.lastScannedAt })
                );
            }
        }

        // Open panel
        $overlay.addClass("visible");
        $panel.addClass("open");

        // Load profiles and log in parallel
        await Promise.all([
            loadPanelProfiles(groupId),
            loadPanelLog(groupId, 1)
        ]);
    }

    // Merge freshly-scanned info into the in-memory group lists and re-render
    // the matching card so the cover/name/members update live.
    function applyScannedInfoToGrid(groupId, info) {
        if (!info) return;
        const patch = (g) => {
            if (!g || g.groupId !== groupId) return;
            if (info.name)             g.name             = info.name;
            if (info.coverImage)       g.coverImage       = info.coverImage;
            if (info.profilePicture)   g.profilePicture   = info.profilePicture;
            if (info.privacyLabel)     g.privacyLabel     = info.privacyLabel;
            if (info.membersFormatted) g.membersFormatted = info.membersFormatted;
            if (info.membersTotal != null)    g.membersTotal    = info.membersTotal;
            if (info.postsToday != null)      g.postsToday      = info.postsToday;
            if (info.postsLastMonth != null)  g.postsLastMonth  = info.postsLastMonth;
            if (info.createdTime != null)     g.createdTime     = info.createdTime;
            // Cache the full scan payload + timestamp so reopening the panel shows it.
            g.scanInfo      = info;
            g.lastScannedAt = info.scannedAt || new Date().toISOString();
        };
        (allGroups || []).forEach(patch);
        (filteredGroups || []).forEach(patch);
        if (currentNavPage === "groups") renderGrid();
    }

    // Translate Facebook's localized "new members this week" text into the app
    // language. The raw text (e.g. "+ 1 819 la semaine dernière") is always in
    // the Facebook profile's locale, so we extract the number and re-render it.
    function formatNewMembers(text) {
        if (!text) return "";
        const digits = String(text).replace(/[^\d]/g, "");
        if (!digits) return escapeHtml(String(text));
        const count = parseInt(digits, 10);
        const formatted = count.toLocaleString();
        return t("fb_groups.new_members_week", "+{{count}} new members this week", { count: formatted });
    }

    // Build the scan-info result box HTML from a group info object.
    // opts: { scannedVia (profile label), scannedAt (ISO string) }
    function buildScanInfoBox(g, opts = {}) {
        g = g || {};
        const created = g.createdTime
            ? new Date(g.createdTime * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
            : "—";
        const members = g.membersFormatted || (g.membersTotal != null ? String(g.membersTotal) : "—");
        const postsToday = g.postsToday != null ? g.postsToday : "—";
        const postsMonth = g.postsLastMonth != null ? g.postsLastMonth : "—";

        const coverHtml = g.coverImage
            ? `<div class="fbg-scan-cover"><img src="${escapeHtml(facebookImageSrc(g.coverImage))}" alt="cover" referrerpolicy="no-referrer"></div>`
            : "";

        const stat = (icon, label, value) =>
            `<div class="fbg-scan-stat">
                <span class="material-icons">${icon}</span>
                <div><div class="fbg-scan-stat-val">${escapeHtml(String(value))}</div>
                <div class="fbg-scan-stat-lbl">${escapeHtml(label)}</div></div>
            </div>`;

        // "Scanned X ago" line — uses the persisted last-scan timestamp.
        const scannedAt = opts.scannedAt || g.scannedAt || null;
        const agoText = scannedAt
            ? `${t("fb_groups.last_scanned", "Last scanned")} ${relativeTime(scannedAt)}`
            : "";
        const viaText = opts.scannedVia
            ? `${t("fb_groups.scanned_via", "Scanned via")}: ${escapeHtml(opts.scannedVia)}`
            : "";
        const metaParts = [agoText, viaText].filter(Boolean).join(" · ");

        return `
            <div id="fbgScanInfoResult" class="fbg-scan-info-box">
                ${coverHtml}
                <div class="fbg-scan-title">
                    ${g.profilePicture ? `<img class="fbg-scan-avatar" src="${escapeHtml(facebookImageSrc(g.profilePicture))}" referrerpolicy="no-referrer">` : ""}
                    <div>
                        <div class="fbg-scan-name">${escapeHtml(g.name || "—")}</div>
                        <div class="fbg-scan-privacy">${escapeHtml(g.privacyLabel || "")}</div>
                    </div>
                </div>
                <div class="fbg-scan-stats">
                    ${stat("group", t("fb_groups.members", "Members"), members)}
                    ${stat("event", t("fb_groups.created", "Created"), created)}
                    ${stat("today", t("fb_groups.posts_today", "Posts today"), postsToday)}
                    ${stat("calendar_month", t("fb_groups.posts_month", "Posts / month"), postsMonth)}
                </div>
                ${g.newMembersText ? `<div class="fbg-scan-growth"><span class="material-icons">trending_up</span> ${formatNewMembers(g.newMembersText)}</div>` : ""}
                ${metaParts ? `<div class="fbg-scan-meta">${metaParts}</div>` : ""}
            </div>`;
    }

    // Fetch live group info from Facebook and render it into the info section
    async function scanGroupInfo(groupId) {
        const $btn = $("#fbgScanInfoBtn");
        const origHtml = $btn.html();
        $btn.prop("disabled", true).html(`<span class="material-icons fbg-spin">progress_activity</span><span>${t("fb_groups.scanning", "Scanning…")}</span>`);
        try {
            const res = await window.electronAPI.fbGroupsScanGroupInfo(groupId);
            if (!res || !res.success) {
                const msg = (res && res.error) || t("fb_groups.scan_failed", "Scan failed");
                $("#fbgScanInfoResult").remove();
                $("#fbgPanelInfoSection").append(
                    `<div id="fbgScanInfoResult" class="fbg-scan-info-box fbg-scan-error">
                        <span class="material-icons">error_outline</span> ${escapeHtml(msg)}
                    </div>`
                );
                return;
            }

            const g = res.info || {};
            const html = buildScanInfoBox(g, { scannedVia: res.profileLabel, scannedAt: g.scannedAt || new Date().toISOString() });

            $("#fbgScanInfoResult").remove();
            $("#fbgPanelInfoSection").append(html);

            // Update the grid card immediately from the result we already have,
            // so it refreshes live without waiting for the broadcast event.
            applyScannedInfoToGrid(groupId, g);
        } catch (e) {
            console.error("[fbGroups] scanGroupInfo error:", e);
            $("#fbgScanInfoResult").remove();
            $("#fbgPanelInfoSection").append(
                `<div id="fbgScanInfoResult" class="fbg-scan-info-box fbg-scan-error">
                    <span class="material-icons">error_outline</span> ${escapeHtml(e.message || "Error")}
                </div>`
            );
        } finally {
            $btn.prop("disabled", false).html(origHtml);
        }
    }

    function closeDetailPanel() {
        currentGroupId = null;
        window._fbgCurrentGroupUrl = "";
        $("#fbgDetailPanel").removeClass("open");
        $("#fbgOverlay").removeClass("visible");
    }

    // ── Panel: Profiles ─────────────────────────────────────────
    async function loadPanelProfiles(groupId) {
        const res = await window.electronAPI.fbGroupsGetProfiles(groupId);
        if (!res || !res.success) return;
        renderProfileChips(res.data || []);
    }

    function renderProfileChips(profiles) {
        const $container = $("#fbgProfileChips");
        if (!profiles || profiles.length === 0) {
            $container.html(`<span class="fbg-chips-empty" data-i18n="fb_groups.no_profiles_linked">${t("fb_groups.no_profiles_linked","No profiles linked yet")}</span>`);
            return;
        }

        const html = profiles.map((p, i) => buildProfileChip(p, i)).join("");
        $container.html(html);
    }

    // Build a single linked-profile chip. When a cached scan exists it shows the
    // Facebook avatar, login-health badge, name, username and friends/followers.
    function buildProfileChip(p, i = 0) {
        const info = p.scanInfo || null;
        const scanned = !!p.lastScannedAt;
        const loggedIn = p.loggedIn === 1 || p.loggedIn === true;

        // Health badge: green (logged in), red (logged out), grey (never scanned)
        let healthClass = "unknown", healthIcon = "help", healthText = t("fb_groups.not_scanned", "Not scanned");
        if (scanned && loggedIn) { healthClass = "ok";   healthIcon = "verified";    healthText = t("fb_groups.logged_in", "Logged in"); }
        else if (scanned)        { healthClass = "bad";  healthIcon = "gpp_bad";     healthText = t("fb_groups.logged_out", "Logged out"); }

        // Avatar overlaid on the person-icon placeholder; onerror hides a broken image.
        const avatar = info && info.profilePicture
            ? `<div class="profile-chip-icon"><span class="material-icons">person</span><img class="profile-chip-avatar" src="${escapeHtml(facebookImageSrc(info.profilePicture))}" referrerpolicy="no-referrer" alt="" onerror="this.style.display='none'"></div>`
            : `<div class="profile-chip-icon"><span class="material-icons">person</span></div>`;

        const displayName = (info && info.name) ? info.name : p.profileLabel;

        // Sub-line: username + friends/followers when available, else structure label
        let sub = "";
        if (info) {
            const bits = [];
            if (info.username) bits.push("@" + info.username);
            else if (info.userId) bits.push("ID " + info.userId);
            if (info.friendsText)   bits.push(escapeHtml(info.friendsText));
            else if (info.followersText) bits.push(escapeHtml(info.followersText));
            sub = bits.join(" · ");
        }
        if (!sub) sub = escapeHtml(p.structureLabel || p.structureId || "");

        const agoText = scanned ? relativeTime(p.lastScannedAt) : "";

        return `
            <div class="profile-chip ${healthClass}" data-profile="${escapeHtml(p.profileId)}" style="animation-delay:${i * 30}ms">
                ${avatar}
                <div class="profile-chip-main">
                    <div class="profile-chip-label" title="${escapeHtml(displayName)}">
                        ${escapeHtml(displayName)}
                        <span class="profile-chip-health ${healthClass}" title="${escapeHtml(healthText)}"><span class="material-icons">${healthIcon}</span></span>
                    </div>
                    <div class="profile-chip-structure" title="${escapeHtml(sub)}">${sub}</div>
                    ${agoText ? `<div class="profile-chip-scanned">${t("fb_groups.last_scanned","Last scanned")} ${agoText}</div>` : ""}
                </div>
                <div class="profile-chip-actions">
                    <button class="profile-chip-scan" data-action="scan-profile" data-profile="${escapeHtml(p.profileId)}" data-label="${escapeHtml(p.profileLabel || "")}" title="${t("fb_groups.scan_profile","Verify / scan profile")}">
                        <span class="material-icons">person_search</span>
                    </button>
                    <button class="profile-chip-remove" data-action="remove-profile" data-group="${currentGroupId}" data-profile="${escapeHtml(p.profileId)}" title="${t("fb_groups.remove_profile","Remove")}">
                        <span class="material-icons">close</span>
                    </button>
                </div>
            </div>`;
    }

    // Scan a single linked profile, update its chip in place, and reflect the
    // cached result so it persists when the panel is reopened.
    async function scanProfile(profileId, profileLabel) {
        const $chip = $(`.profile-chip[data-profile="${(window.CSS && CSS.escape) ? CSS.escape(profileId) : profileId}"]`);
        const $btn = $chip.find(".profile-chip-scan");
        const origHtml = $btn.html();
        $btn.prop("disabled", true).html(`<span class="material-icons fbg-spin">progress_activity</span>`);
        $chip.addClass("scanning");
        try {
            const res = await window.electronAPI.fbGroupsScanProfile(profileId, profileLabel || "");
            // Build a fresh chip object from the saved scan row.
            const scan = (res && res.scan) || {};
            const patched = {
                profileId,
                profileLabel: profileLabel || "",
                structureId: $chip.find(".profile-chip-structure").attr("title") || "",
                structureLabel: "",
                loggedIn: scan.loggedIn != null ? scan.loggedIn : (res && res.loggedIn ? 1 : 0),
                scanInfo: scan.scanInfo || (res && res.info) || null,
                lastScannedAt: scan.lastScannedAt || new Date().toISOString(),
                scanError: scan.scanError || (res && !res.success ? res.error : null),
            };
            const idx = $chip.index();
            $chip.replaceWith(buildProfileChip(patched, idx >= 0 ? idx : 0));

            if (res && !res.success && res.error) {
                showAlert("error", res.error);
            } else if (res && res.loggedIn === false) {
                showAlert("warning", t("fb_groups.profile_logged_out", "Profile is logged out of Facebook"));
            } else if (res && res.loggedIn) {
                const nm = (res.info && res.info.name) || profileLabel || "";
                showAlert("success", t("fb_groups.profile_verified", "Profile is logged in") + (nm ? ` — ${nm}` : ""));
            }
        } catch (e) {
            console.error("[fbGroups] scanProfile error:", e);
            $btn.prop("disabled", false).html(origHtml);
            $chip.removeClass("scanning");
        }
    }

    // ── Panel: Post Log ─────────────────────────────────────────
    async function loadPanelLog(groupId, page) {
        currentLogPage = page;
        const offset = (page - 1) * LOG_PER_PAGE;
        const res = await window.electronAPI.fbGroupsGetPostLog(groupId, LOG_PER_PAGE, offset);
        if (!res || !res.success) return;

        const { rows, total } = res.data || { rows: [], total: 0 };

        $("#fbgLogTotal").text(`${total} ${t("fb_groups.total_entries","entries")}`);

        if (!rows || rows.length === 0) {
            $("#fbgLogBody").html(`<tr><td colspan="5" class="fbg-log-empty">${t("fb_groups.no_posts_yet","No posts recorded yet")}</td></tr>`);
            $("#fbgLogPagination").hide();
            return;
        }

        const rowsHtml = rows.map(r => {
            const statusClass = r.status || "pending";
            const statusLabel = t(`fb_groups.status_${statusClass}`, statusClass);
            // Build Facebook post URL from stored base64 post_id
            let postUrl = "";
            if (r.postId) {
                try {
                    const decoded = atob(r.postId);
                    // Typical format: S:f{userId}:VK:{numericStoryId} or similar
                    const numericMatch = decoded.match(/(\d{10,})$/);
                    const numericId = numericMatch ? numericMatch[1] : null;
                    // Extract FB group numeric ID from stored group URL
                    const groupUrlForLink = (window._fbgCurrentGroupUrl || "");
                    const fbGrpId = (groupUrlForLink.match(/\/groups\/([^/?#]+)/) || [])[1] || "";
                    if (fbGrpId && numericId) {
                        postUrl = `https://www.facebook.com/groups/${fbGrpId}/posts/${numericId}/`;
                    } else {
                        postUrl = `https://www.facebook.com/groups/${fbGrpId || ""}`;
                    }
                } catch (_) {}
            }
            const actionBtns = postUrl
                ? `<div class="fbg-log-actions">
                     <button class="fbg-log-action-btn" title="Open post" data-post-url="${escapeHtml(postUrl)}" data-action="open">
                       <span class="material-icons">open_in_new</span>
                     </button>
                     <button class="fbg-log-action-btn" title="Copy link" data-post-url="${escapeHtml(postUrl)}" data-action="copy">
                       <span class="material-icons">content_copy</span>
                     </button>
                   </div>`
                : `<span class="fbg-log-no-link">—</span>`;
            return `
            <tr>
                <td><strong>${escapeHtml(r.profileLabel || r.profileId || "—")}</strong></td>
                <td class="fbg-log-message" title="${escapeHtml(r.message || "")}">${escapeHtml(r.message || "—")}</td>
                <td><span class="fbg-log-status ${statusClass}">${statusLabel}</span></td>
                <td style="white-space:nowrap;font-size:12px;">${formatDate(r.postedAt)}</td>
                <td class="fbg-log-actions-cell">${actionBtns}</td>
            </tr>`;
        }).join("");

        $("#fbgLogBody").html(rowsHtml);
        renderLogPagination(total, page);
    }

    function renderLogPagination(total, page) {
        const $p = $("#fbgLogPagination");
        const totalPages = Math.max(1, Math.ceil(total / LOG_PER_PAGE));

        // Windowed page numbers: always show first, last, current ±2, with ellipsis gaps
        const pageSet = new Set([1, totalPages]);
        for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) pageSet.add(i);
        const sorted = [...pageSet].sort((a, b) => a - b);

        let html = `<button class="fbg-log-nav-btn" data-log-page="${page - 1}" ${page === 1 ? "disabled" : ""}>
                        <span class="material-icons" style="font-size:16px;">chevron_left</span>
                    </button>`;

        let prev = 0;
        for (const p of sorted) {
            if (p - prev > 1) html += `<span class="fbg-log-ellipsis">&hellip;</span>`;
            html += `<button class="fbg-page-btn ${p === page ? "active" : ""}" data-log-page="${p}">${p}</button>`;
            prev = p;
        }

        html += `<button class="fbg-log-nav-btn" data-log-page="${page + 1}" ${page === totalPages ? "disabled" : ""}>
                    <span class="material-icons" style="font-size:16px;">chevron_right</span>
                 </button>`;
        html += `<span class="fbg-log-page-info">${page} / ${totalPages}</span>`;

        $p.html(html).show();
    }

    // ── Add Profile Modal ───────────────────────────────────────
    async function showAddProfileModal(groupId) {
        // Load structures and current linked profiles in parallel
        const [structuresData, linkedRes] = await Promise.all([
            window.electronAPI.readKey("structures"),
            window.electronAPI.fbGroupsGetProfiles(groupId)
        ]);

        const structures  = structuresData || {};
        const linkedProfs = (linkedRes && linkedRes.success && linkedRes.data) ? linkedRes.data : [];
        const linkedIds   = new Set(linkedProfs.map(p => p.profileId));

        // Build the flat list of all profiles across all structures
        const allProfileOptions = [];
        Object.entries(structures).forEach(([structId, struct]) => {
            if (!struct || !struct.profiles) return;
            const structLabel = struct.label || structId;
            Object.entries(struct.profiles).forEach(([profId, prof]) => {
                allProfileOptions.push({
                    structureId:    structId,
                    structureLabel: structLabel,
                    profileId:      profId,
                    profileLabel:   prof.label || profId,
                    alreadyLinked:  linkedIds.has(profId)
                });
            });
        });

        if (allProfileOptions.length === 0) {
            showAlert("warning", t("fb_groups.no_structures_found", "No profiles found. Create structures first in the Structures page."));
            return;
        }

        let selectedIds  = new Set();
        let filterQuery  = "";

        function buildModalOptions(query) {
            const q = (query || "").toLowerCase().trim();
            // Group by structure
            const byStructure = {};
            allProfileOptions.forEach(p => {
                if (q && !p.profileLabel.toLowerCase().includes(q) && !p.structureLabel.toLowerCase().includes(q)) return;
                if (!byStructure[p.structureId]) {
                    byStructure[p.structureId] = { label: p.structureLabel, profiles: [] };
                }
                byStructure[p.structureId].profiles.push(p);
            });

            if (Object.keys(byStructure).length === 0) {
                return `<div class="fbg-no-profiles">${t("fb_groups.no_results","No matching profiles")}</div>`;
            }

            return Object.entries(byStructure).map(([structId, group]) => {
                const profileRows = group.profiles.map(p => {
                    const sel    = selectedIds.has(p.profileId) ? "selected" : "";
                    const locked = p.alreadyLinked ? "already-linked" : "";
                    const badge  = p.alreadyLinked ? `<span class="fbg-already-badge">${t("fb_groups.already_linked","Linked")}</span>` : "";
                    return `
                    <div class="fbg-profile-option ${sel} ${locked}"
                         data-profile-id="${p.profileId}"
                         data-structure-id="${structId}"
                         data-structure-label="${escapeHtml(p.structureLabel)}"
                         data-profile-label="${escapeHtml(p.profileLabel)}"
                         ${p.alreadyLinked ? "" : ""}>
                        <div class="fbg-profile-checkbox">
                            <span class="material-icons">check</span>
                        </div>
                        <div class="fbg-profile-avatar">
                            <span class="material-icons">person</span>
                        </div>
                        <div class="fbg-profile-info">
                            <div class="fbg-profile-name">${escapeHtml(p.profileLabel)}</div>
                            <div class="fbg-profile-id">${p.profileId}</div>
                        </div>
                        ${badge}
                    </div>`;
                }).join("");
                return `
                <div class="fbg-structure-group">
                    <div class="fbg-structure-group-label">
                        <span class="material-icons">account_tree</span>
                        ${escapeHtml(group.label)}
                    </div>
                    ${profileRows}
                </div>`;
            }).join("");
        }

        function updateFooter() {
            const n = selectedIds.size;
            $("#fbgModalSelectedCount").html(
                n > 0
                    ? `<strong style="color:#1877F2;">${n}</strong> ${t("fb_groups.selected","selected")}`
                    : t("fb_groups.select_profiles_hint","Click profiles to select them")
            );
            const $btn = $("#fbgModalConfirm");
            if (n > 0) {
                $btn.prop("disabled", false).removeAttr("disabled");
            } else {
                $btn.prop("disabled", true);
            }
            $btn.find("span:last-child").text(n > 0
                ? `${t("fb_groups.add_profile","Add")} (${n})`
                : t("fb_groups.add_profile","Add"));
        }

        function bindProfileClicks() {
            $("#fbgModalBody .fbg-profile-option:not(.already-linked)")
                .off("click.fbgProfile")
                .on("click.fbgProfile", function () {
                    const profId = String($(this).data("profile-id") ?? "");
                    if (!profId) return;
                    if (selectedIds.has(profId)) {
                        selectedIds.delete(profId);
                        $(this).removeClass("selected");
                    } else {
                        selectedIds.add(profId);
                        $(this).addClass("selected");
                    }
                    updateFooter();
                });
        }

        // Build and inject modal
        const modalHtml = `
        <div class="fbg-modal-overlay" id="fbgAddProfileModal">
            <div class="fbg-modal">
                <div class="fbg-modal-header">
                    <h3>
                        <span class="material-icons">person_add</span>
                        ${t("fb_groups.add_profile_title","Add Profiles")}
                    </h3>
                    <button class="fbg-modal-close" id="fbgModalCloseBtn">
                        <span class="material-icons">close</span>
                    </button>
                </div>
                <div class="fbg-modal-search">
                    <div class="fbg-modal-search-wrap">
                        <span class="material-icons">search</span>
                        <input type="text" id="fbgProfileSearch"
                               placeholder="${t("fb_groups.search_profiles","Search profiles…")}">
                    </div>
                </div>
                <div class="fbg-modal-body" id="fbgModalBody">
                    ${buildModalOptions("")}
                </div>
                <div class="fbg-modal-footer">
                    <div class="fbg-modal-footer-info" id="fbgModalSelectedCount">
                        ${t("fb_groups.select_profiles_hint","Click profiles to select them")}
                    </div>
                    <div class="fbg-modal-footer-actions">
                        <button class="btn-fbg-cancel" id="fbgModalCancelBtn">
                            ${t("common.cancel","Cancel")}
                        </button>
                        <button class="btn-fbg-confirm" id="fbgModalConfirm" disabled>
                            <span class="material-icons">person_add</span>
                            <span>${t("fb_groups.add_profile","Add")}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

        $("body").append(modalHtml);

        // ── Modal events
        // Search
        let searchTimer = null;
        $(document).on("input" + NS, "#fbgProfileSearch", function () {
            filterQuery = $(this).val();
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                $("#fbgModalBody").html(buildModalOptions(filterQuery));
                bindProfileClicks();
            }, 180);
        });

        // Initial direct binding for profile selection
        bindProfileClicks();

        // Close
        $(document).on("click" + NS, "#fbgModalCloseBtn, #fbgModalCancelBtn", () => {
            closeAddProfileModal();
        });
        $(document).on("click" + NS, "#fbgAddProfileModal", function (e) {
            if ($(e.target).is("#fbgAddProfileModal")) closeAddProfileModal();
        });

        // Confirm
        $(document).on("click" + NS, "#fbgModalConfirm", async function () {
            if (selectedIds.size === 0) return;
            $(this).prop("disabled", true).html(`<span class="material-icons">hourglass_empty</span>`);

            const toAdd = allProfileOptions.filter(p => selectedIds.has(p.profileId));
            let added = 0;
            for (const p of toAdd) {
                const r = await window.electronAPI.fbGroupsAddProfile(
                    groupId, p.structureId, p.profileId, p.profileLabel, p.structureLabel
                );
                if (r && r.success) added++;
            }

            closeAddProfileModal();
            if (added > 0) {
                showAlert("success", `${added} ${t("fb_groups.profiles_added","profile(s) linked")}`);
                await loadPanelProfiles(groupId);
                await loadData(); // refresh stats / profile counts on cards
            }
        });
    }

    function closeAddProfileModal() {
        // Remove only modal-related events that won't conflict with page cleanup
        $(document).off("input" + NS, "#fbgProfileSearch");
        $(document).off("click" + NS, "#fbgModalCloseBtn, #fbgModalCancelBtn");
        $(document).off("click" + NS, "#fbgAddProfileModal");
        $(document).off("click" + NS, "#fbgModalConfirm");
        $("#fbgAddProfileModal").remove();
    }


    // ════════════════════════════════════════════════════
    //  NAVIGATION
    // ════════════════════════════════════════════════════

    function switchPage(page) {
        currentNavPage = page;
        $(".fbg-nav-item").removeClass("active");
        $(`.fbg-nav-item[data-page="${page}"]`).addClass("active");
        $(".fbg-page").removeClass("active");
        $(`.fbg-page[data-page="${page}"]`).addClass("active");
        if (page === "dashboard") loadDashboardStats();
        if (page === "workflows") {
            loadWorkflows();
            if (workflowsRefreshInterval) clearInterval(workflowsRefreshInterval);
            workflowsRefreshInterval = setInterval(() => {
                if (currentNavPage === "workflows") loadWorkflows();
                else { clearInterval(workflowsRefreshInterval); workflowsRefreshInterval = null; }
            }, 10000);
            // Smooth 1s countdown ticker for the "Next post in X" line
            if (workflowsCountdownInterval) clearInterval(workflowsCountdownInterval);
            workflowsCountdownInterval = setInterval(() => {
                if (currentNavPage === "workflows") updateWorkflowCountdowns();
                else { clearInterval(workflowsCountdownInterval); workflowsCountdownInterval = null; }
            }, 1000);
        } else {
            if (workflowsRefreshInterval) { clearInterval(workflowsRefreshInterval); workflowsRefreshInterval = null; }
            if (workflowsCountdownInterval) { clearInterval(workflowsCountdownInterval); workflowsCountdownInterval = null; }
        }
        if (page === "analytics") loadAnalytics();
        if (page === "posts") {
            loadPostsFeed();
            // Poll every 8s while on the posts page to catch background state changes
            // (e.g. "condition met" → "triggered" after automation finishes)
            if (postsRefreshInterval) clearInterval(postsRefreshInterval);
            postsRefreshInterval = setInterval(() => {
                if (currentNavPage === "posts") loadPostsFeed();
                else { clearInterval(postsRefreshInterval); postsRefreshInterval = null; }
            }, 8000);
        } else {
            if (postsRefreshInterval) { clearInterval(postsRefreshInterval); postsRefreshInterval = null; }
        }
        if (page === "library") loadLibraryPosts();
        if (page === "logs") {
            renderLiveLogs();
        }
        if (page === "groups" && allGroups.length === 0) loadData();
        if (page === "group-settings") loadGroupSettings();
        if (page === "profiles") {
            loadProfiles();
            // Refresh stats periodically while the page is open (live activity arrives via events)
            if (profilesRefreshInterval) clearInterval(profilesRefreshInterval);
            profilesRefreshInterval = setInterval(() => {
                if (currentNavPage === "profiles") loadProfiles();
                else { clearInterval(profilesRefreshInterval); profilesRefreshInterval = null; }
            }, 15000);
        } else {
            if (profilesRefreshInterval) { clearInterval(profilesRefreshInterval); profilesRefreshInterval = null; }
        }
    }

    // ════════════════════════════════════════════════════
    //  DASHBOARD
    // ════════════════════════════════════════════════════

    async function loadDashboardStats() {
        try {
            const [statsRes, activityRes, viralRes] = await Promise.all([
                window.electronAPI.fbGroupsGetDashboardStats(),
                window.electronAPI.fbGroupsGetRecentActivity(12),
                window.electronAPI.fbGroupsGetViralMonitorHistory(5),
            ]);
            if (statsRes.success && statsRes.data) {
                const s = statsRes.data;
                $("#dstatActiveWorkflowsVal").text(s.activeWorkflows ?? "0");
                $("#dstatPostsToday").text(s.postsToday ?? "0");
                $("#dstatPostsWeek").text(s.postsWeek ?? "0");
                $("#dstatSuccessRate").text(`${s.successRate ?? 0}%`);
                $("#dstatMonitoring").text(s.monitoringCount ?? "0");
                $("#dstatTotalGroups").text(s.totalGroups ?? "0");
            }
            if (activityRes.success && Array.isArray(activityRes.data)) {
                renderActivityFeed(activityRes.data);
            }
            if (viralRes.success && Array.isArray(viralRes.data)) {
                renderViralAlerts(viralRes.data);
            }
        } catch (e) {
            console.error("[fbGroups] loadDashboardStats error:", e);
        }
    }

    function renderActivityFeed(items) {
        const $feed = $("#fbgActivityFeed");
        if (!items.length) {
            $feed.html(`<div class="fbg-activity-empty">${t("fb_groups.no_activity","No activity yet")}</div>`);
            return;
        }
        $feed.html(items.map(item => {
            const icon    = item.status === "sent" ? "check_circle" : item.status === "failed" ? "error" : "pending";
            const cls     = item.status === "sent" ? "success" : item.status === "failed" ? "failed" : "pending";
            const msg     = escapeHtml((item.message || "").substring(0, 80)) || "(no text)";
            const group   = escapeHtml(item.groupName || item.groupId || "");
            const wf      = escapeHtml(item.workflowName || "Manual");
            const time    = relativeTime(item.postedAt || item.scheduledAt);
            return `<div class="fbg-activity-item">
                <div class="fbg-activity-icon ${cls}"><span class="material-icons">${icon}</span></div>
                <div class="fbg-activity-body">
                    <div class="fbg-activity-msg">${msg}</div>
                    <div class="fbg-activity-meta">
                        <span class="fbg-chip-small"><span class="material-icons" style="font-size:11px;">group_work</span>${group}</span>
                        <span class="fbg-chip-small"><span class="material-icons" style="font-size:11px;">sync_alt</span>${wf}</span>
                        <span>${time}</span>
                    </div>
                </div>
            </div>`;
        }).join(""));
    }

    function renderViralAlerts(items) {
        const $el = $("#fbgViralAlerts");
        if (!items.length) {
            $el.html(`<div class="fbg-activity-empty">${t("fb_groups.no_viral_alerts","No viral triggers yet")}</div>`);
            return;
        }
        $el.html(items.map(item => {
            const group  = escapeHtml(item.groupName || item.groupId || "");
            const wf     = escapeHtml(item.workflowName || "");
            const shares = item.currentShares || item.targetShares || 0;
            const time   = relativeTime(item.triggeredAt);
            return `<div class="fbg-viral-alert-card">
                <span class="material-icons">local_fire_department</span>
                <div style="flex:1;min-width:0;">
                    <div class="fbg-viral-alert-msg">${group}${wf ? ` · ${wf}` : ""}</div>
                    <div class="fbg-viral-alert-meta">${item.viralAction === "edit_comment" ? "Comment edited" : "Post edited"} · ${time}</div>
                </div>
                <span class="fbg-shares-badge"><span class="material-icons" style="font-size:13px;">share</span>${shares}</span>
            </div>`;
        }).join(""));
    }

    // ════════════════════════════════════════════════════
    //  POSTS FEED
    // ════════════════════════════════════════════════════

    const POSTS_PER_PAGE = 10;
    let postsCurrentPage = 1;
    let postsTotalCount  = 0;
    let postsFilter      = 'all';
    let postsView        = 'active';   // 'active' | 'expired'
    let postsCountdownInterval = null;

    const EXPIRED_PER_PAGE = 100;

    function _fmtCountdown(targetStr) {
        if (!targetStr) return null;
        // Handle both 'YYYY-MM-DD HH:MM:SS' (SQLite format) and 'YYYY-MM-DDTHH:MM:SS.sssZ' (old ISO format)
        const normalized = targetStr.includes('T') ? targetStr : targetStr.replace(' ', 'T') + 'Z';
        const target = new Date(normalized);
        const diffMs = target - Date.now();
        if (isNaN(diffMs) || diffMs <= 0) return null;  // null = show 'due now' indicator
        const totalSec = Math.floor(diffMs / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = n => String(n).padStart(2, '0');
        return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${pad(m)}m ${pad(s)}s`;
    }

    const _autoTriggeredStories = new Set(); // prevent duplicate auto-triggers per page load

    function _startPostsCountdown() {
        if (postsCountdownInterval) clearInterval(postsCountdownInterval);
        postsCountdownInterval = setInterval(() => {
            // Never auto-trigger checks while monitoring is paused.
            if (_vmPaused) return;
            $('#fbgPostsTableBody .fbg-post-countdown').each(function () {
                const $el = $(this);
                const next = $el.data('next-check');
                if (!next) return;
                const txt = _fmtCountdown(next);
                if (txt) {
                    $el.text(txt);
                } else {
                    // Countdown elapsed — the backend opens ONE human-like browsing
                    // session per group and reads every monitored post at once. Do NOT
                    // fire an individual check here (that would bypass the batched,
                    // human-like session). The feed re-renders when the backend updates.
                    $el.text(t("fb_groups.vm_due_soon", "Checking soon…"));
                }
            });
        }, 1000);
    }

    async function loadPostsFeed(page) {
        if (page) postsCurrentPage = page;
        if (postsView === 'expired') {
            const offset = (postsCurrentPage - 1) * EXPIRED_PER_PAGE;
            try {
                const res = await window.electronAPI.fbGroupsGetExpiredPostsFeed(EXPIRED_PER_PAGE, offset);
                if (!res?.success) return;
                postsTotalCount = res.data?.total || 0;
                renderPostsFeed(res.data?.rows || [], postsTotalCount, true);
            } catch (e) {
                console.error("[fbGroups] loadPostsFeed(expired) error:", e);
            }
            return;
        }
        const offset = (postsCurrentPage - 1) * POSTS_PER_PAGE;
        try {
            const filter = postsFilter !== 'all' ? postsFilter : null;
            const res = await window.electronAPI.fbGroupsGetPostsFeed(POSTS_PER_PAGE, offset, filter);
            if (!res?.success) return;
            postsTotalCount = res.data?.total || 0;
            renderPostsFeed(res.data?.rows || [], postsTotalCount, false);
        } catch (e) {
            console.error("[fbGroups] loadPostsFeed error:", e);
        }
    }

    function renderPostsFeed(rows, total, isExpired) {
        const $body  = $("#fbgPostsTableBody");
        const $table = $("#fbgPostsTable");
        const $empty = $("#fbgPostsEmpty");
        const perPage = isExpired ? EXPIRED_PER_PAGE : POSTS_PER_PAGE;
        if (!rows.length) {
            $body.empty();
            $table.hide();
            $empty.find("p").text(isExpired
                ? t("fb_groups.expired_empty", "No expired posts yet")
                : t("fb_groups.posts_empty", "No posts yet"));
            $empty.show();
            $("#fbgPostsPagination").hide();
            return;
        }
        $empty.hide();
        $table.show();
        $body.html(rows.map(p => buildPostRow(p, isExpired)).join(""));
        if (!isExpired) _startPostsCountdown();
        // pagination
        const totalPages = Math.ceil(total / perPage);
        if (totalPages <= 1) { $("#fbgPostsPagination").hide(); return; }
        let pHtml = "";
        for (let p = 1; p <= totalPages; p++) {
            pHtml += `<button class="fbg-page-btn ${p === postsCurrentPage ? "active" : ""}" data-posts-page="${p}">${p}</button>`;
        }
        $("#fbgPostsPagination").show().html(pHtml);
    }

    function buildPostRow(p, isExpired) {
        const imgPath  = p.imagePath ? "file:///" + p.imagePath.replace(/\\/g, "/") : null;
        const textSnip = (p.message || "").slice(0, 120) + ((p.message || "").length > 120 ? "…" : "");
        const groupName = escapeHtml(p.groupName || p.groupId || "—");
        const postedAt  = p.postedAt ? relativeTime(p.postedAt) : "—";
        const storyId   = escapeHtml(p.storyId || "");
        const metric    = p.vmMetric || "shares";
        const thumb = imgPath
            ? `<img src="${imgPath}" alt="" loading="lazy" class="fbg-expired-thumb" onerror="this.style.display='none'">`
            : `<span class="material-icons fbg-expired-thumb fbg-expired-thumb--empty">image_not_supported</span>`;

        // ── Result (metric) cell ──
        let resultCell = `<span style="color:var(--text-secondary,#6b7280);">—</span>`;
        if (isExpired || p.vmEnabled) {
            const current = p.vmCurrentCount ?? "—";
            const target  = p.vmTargetCount  ?? "—";
            const icon    = metric === "likes" ? "thumb_up" : metric === "comments" ? "chat_bubble" : "share";
            resultCell = `<span class="material-icons" style="font-size:13px;">${icon}</span> <span class="fbg-expired-count">${current}</span>/<span class="fbg-expired-target">${target}</span>`;
        }

        // ── Status cell ──
        let statusCell;
        if (isExpired) {
            const expiredAt = p.vmExpiresAt ? relativeTime(p.vmExpiresAt) : "—";
            statusCell = `<span class="fbg-post-status-badge fbg-status-expired">${t("fb_groups.vm_expired", "Expired")}</span><span class="fbg-post-status-sub">${expiredAt}</span>`;
        } else if (p.vmEnabled) {
            const vmSt = p.vmStatus || "monitoring";
            const badgeClass = vmSt === "triggered" ? "fbg-status-triggered" : vmSt === "expired" ? "fbg-status-expired" : "fbg-status-monitoring";
            const vmLbl = vmSt === "triggered" ? t("fb_groups.vm_triggered", "Triggered")
                        : vmSt === "expired"   ? t("fb_groups.vm_expired", "Expired")
                        : t("fb_groups.vm_monitoring", "Monitoring");
            const nextCheck = p.vmNextCheckAt || null;
            const conditionMet = vmSt === 'monitoring' && typeof p.vmCurrentCount === 'number' && typeof p.vmTargetCount === 'number' && p.vmCurrentCount >= p.vmTargetCount;
            const countdownTxt = (!conditionMet && vmSt === 'monitoring' && nextCheck) ? _fmtCountdown(nextCheck) : null;
            const isDueNow     = !conditionMet && vmSt === 'monitoring' && nextCheck && countdownTxt === null;
            let sub = "";
            if (_vmPaused && vmSt === 'monitoring') {
                sub = `<span class="fbg-post-status-sub"><span class="material-icons" style="font-size:11px;">pause_circle</span>${t("fb_groups.vm_paused_label", "Paused")}</span>`;
            } else if (conditionMet) {
                sub = `<span class="fbg-post-status-sub"><span class="material-icons fbg-spin" style="font-size:11px;">autorenew</span>${t("fb_groups.vm_condition_met_short", "Running action\u2026")}</span>`;
            } else if (isDueNow) {
                sub = `<span class="fbg-post-status-sub">${t("fb_groups.vm_due_now", "Check pending (next tick)")}</span>`;
            } else if (countdownTxt) {
                sub = `<span class="fbg-post-status-sub"><span class="material-icons" style="font-size:11px;">timer</span><strong class="fbg-post-countdown" data-next-check="${escapeHtml(nextCheck)}" data-story-id="${storyId}">${countdownTxt}</strong></span>`;
            } else {
                const lastChk = p.vmLastCheckedAt ? relativeTime(p.vmLastCheckedAt) : t("fb_groups.never", "Never");
                sub = `<span class="fbg-post-status-sub">${t("fb_groups.vm_last_check", "Checked")} ${lastChk}</span>`;
            }
            statusCell = `<span class="fbg-post-status-badge ${badgeClass}">${vmLbl}</span>${sub}`;
        } else {
            statusCell = `<span style="color:var(--text-secondary,#6b7280);">—</span>`;
        }

        // ── Actions cell ──
        let actions = "";
        if (isExpired) {
            if (storyId) actions += `<button class="fbg-post-action-btn fbg-expired-check" data-story-id="${storyId}" title="${t('fb_groups.expired_check_stats', 'Check current stats')}"><span class="material-icons">analytics</span></button>`;
        } else if (p.vmEnabled) {
            // "Check stats" works on any monitored post — even while paused — since
            // it only reads the current count without running the viral action.
            if (storyId) actions += `<button class="fbg-post-action-btn fbg-expired-check" data-story-id="${storyId}" title="${t('fb_groups.expired_check_stats', 'Check current stats')}"><span class="material-icons">analytics</span></button>`;
            if (p.vmStatus === 'monitoring') {
                if (!_vmPaused && storyId) actions += `<button class="fbg-post-action-btn fbg-post-force-check" data-story-id="${storyId}" title="${t('fb_groups.force_check', 'Force check now')}"><span class="material-icons">refresh</span></button>`;
                actions += `<button class="fbg-post-action-btn fbg-post-action-stop" data-post-id="${p.id}" title="${t('fb_groups.stop_monitoring', 'Stop Monitoring')}"><span class="material-icons">pause_circle</span></button>`;
            }
        }
        actions += `<button class="fbg-post-action-btn fbg-post-action-delete" data-post-id="${p.id}" title="${t('fb_groups.delete_post', 'Delete Post')}"><span class="material-icons">delete_outline</span></button>`;

        return `<tr data-post-id="${p.id}" data-story-id="${storyId}">
            <td class="fbg-expired-img-cell">${thumb}</td>
            <td class="fbg-expired-text-cell">${textSnip ? escapeHtml(textSnip) : "<span style='color:var(--text-secondary,#6b7280);'>—</span>"}</td>
            <td>${groupName}</td>
            <td class="fbg-expired-metric-cell" data-metric="${metric}">${resultCell}</td>
            <td class="fbg-post-status-cell">${statusCell}</td>
            <td>${postedAt}</td>
            <td class="fbg-expired-action-cell">${actions}</td>
        </tr>`;
    }

    // ════════════════════════════════════════════════════
    //  WORKFLOWS
    // ════════════════════════════════════════════════════

    async function loadWorkflows() {
        try {
            const res = await window.electronAPI.fbGroupsGetImportedWorkflows();
            allWorkflows = (res.success && Array.isArray(res.data)) ? res.data : [];
            renderWorkflowGrid();
        } catch (e) {
            console.error("[fbGroups] loadWorkflows error:", e);
        }
    }

    function renderWorkflowGrid() {
        const $grid = $("#fbgWorkflowGrid");
        if (!allWorkflows.length) {
            $grid.html($("#fbgWfEmpty")[0]?.outerHTML ||
                `<div class="fbg-wf-empty"><span class="material-icons" style="font-size:48px;">sync_alt</span><p>${t("fb_groups.no_workflows","No imported workflows yet")}</p></div>`);
            return;
        }
        const cards = allWorkflows.map(wf => buildWorkflowCard(wf)).join("");
        $grid.html(cards);
    }

    // ── Schedule config helpers ──────────────────────────────────

    const DAYS_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const DAYS_I18N  = ["sun","mon","tue","wed","thu","fri","sat"];

    function buildSchedulingHtml(delayMinutes, sc, prefix) {
        const allowedDays   = sc.allowedDays   ?? [0,1,2,3,4,5,6];
        const postFrom      = sc.postingHours?.from ?? 0;
        const postTo        = sc.postingHours?.to   ?? 24;
        const randomnessPct = sc.randomnessPct ?? 0;

        const daysHtml = DAYS_SHORT.map((d, i) => {
            const sel = allowedDays.includes(i) ? "selected" : "";
            return `<button type="button" class="fbg-day-btn ${sel}" data-day="${i}">${d}</button>`;
        }).join("");

        const hoursOptions = (start, selected) => {
            let opts = "";
            for (let h = 0; h <= 24; h++) {
                const lbl = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : h === 24 ? "12 AM+1" : `${h-12} PM`;
                opts += `<option value="${h}" ${h === selected ? "selected" : ""}>${lbl}</option>`;
            }
            return opts;
        };

        return `
        <div class="fbg-form-group">
            <label class="fbg-form-label">${t("fb_groups.delay_between_posts","Delay Between Posts")}</label>
            <div class="fbg-input-row">
                <input type="number" class="fbg-input fbg-delay-input" id="${prefix}Delay" value="${delayMinutes}" min="1" max="9999" style="width:90px;">
                <span style="font-size:13px;color:var(--text-secondary);">${t("fb_groups.minutes","minutes")}</span>
            </div>
        </div>
        <div class="fbg-form-group" style="margin-top:10px;">
            <label class="fbg-form-label">
                ${t("fb_groups.randomness","Randomness Factor")}
                <span class="fbg-schedule-rnd-val" id="${prefix}RndVal">${buildRndLabel(delayMinutes, randomnessPct)}</span>
            </label>
            <input type="range" class="fbg-range" id="${prefix}Randomness" data-prefix="${prefix}" min="0" max="100" value="${randomnessPct}" step="5">
            <p class="fbg-form-hint">${t("fb_groups.randomness_hint","Posts won't go out at exact intervals — actual delay will vary within the shown range.")}</p>
        </div>
        <div class="fbg-form-group" style="margin-top:10px;">
            <label class="fbg-form-label">${t("fb_groups.allowed_days","Active Days")}</label>
            <div class="fbg-days-picker" id="${prefix}DaysPicker">${daysHtml}</div>
            <p class="fbg-form-hint">${t("fb_groups.allowed_days_hint","Posts will only be sent on selected days. Click to toggle.")}</p>
        </div>
        <div class="fbg-form-group" style="margin-top:10px;">
            <label class="fbg-form-label">${t("fb_groups.posting_hours","Posting Hours")}</label>
            <div class="fbg-input-row" style="gap:8px;align-items:center;">
                <select class="fbg-input" id="${prefix}HourFrom" style="width:110px;">${hoursOptions("from", postFrom)}</select>
                <span style="font-size:13px;color:var(--text-secondary);">${t("fb_groups.to","to")}</span>
                <select class="fbg-input" id="${prefix}HourTo" style="width:110px;">${hoursOptions("to", postTo)}</select>
            </div>
            <p class="fbg-form-hint">${t("fb_groups.posting_hours_hint","Only post within this time window (local time). Set From=0, To=24 for any time.")}</p>
        </div>`;
    }

    function readSchedulingConfig(prefix) {
        const allowedDays = [];
        $(`#${prefix}DaysPicker .fbg-day-btn.selected`).each(function() {
            allowedDays.push(parseInt($(this).data("day")));
        });
        const from = parseInt($(`#${prefix}HourFrom`).val()) || 0;
        const to   = parseInt($(`#${prefix}HourTo`).val())   || 24;
        const randomnessPct = parseInt($(`#${prefix}Randomness`).val()) || 0;
        return {
            allowedDays,
            postingHours: { from, to },
            randomnessPct,
        };
    }

    // ── Randomness range label helper ────────────────────────────
    function buildRndLabel(delayMin, pct) {
        delayMin = Math.max(1, parseInt(delayMin) || 1);
        pct = parseInt(pct) || 0;
        if (pct === 0) return t("fb_groups.no_randomness", "exact");
        const jitter = Math.round(delayMin * pct / 100);
        const lo = Math.max(1, delayMin - jitter);
        const hi = delayMin + jitter;
        return `${lo}–${hi} min`;
    }

    // ── Randomness slider live label ─────────────────────────────
    // (NOTE: bound inside setupEvents to survive the $(document).off(NS) reset)

    // ── Delay input updates rnd label ────────────────────────────
    // (NOTE: bound inside setupEvents to survive the $(document).off(NS) reset)

    // ── Day picker toggle ─────────────────────────────────────────
    // (NOTE: bound inside setupEvents to survive the $(document).off(NS) reset)

    function buildWorkflowCard(wf) {
        const isManual    = !!wf.isManual;
        const isCompleted = !!wf.isCompleted;
        const isActive    = wf.status === "active" && !isCompleted;
        const badgeCls    = isCompleted ? "completed" : (isActive ? "active" : "paused");
        const badgeTxt    = isCompleted ? t("fb_groups.completed","Completed") : (isActive ? t("fb_groups.active","Active") : t("fb_groups.paused","Paused"));
        const toggleLbl   = isCompleted ? t("fb_groups.restart","Restart") : (isActive ? t("fb_groups.pause","Pause") : t("fb_groups.start","Start"));
        const toggleIcon  = isCompleted ? "replay" : (isActive ? "pause" : "play_arrow");
        const toggleAction = isCompleted ? "restart" : "toggle";
        const groups    = wf.targetCount || 0;
        const sent      = wf.postsSent  || 0;
        const lastRun   = wf.lastRunAt  ? relativeTime(wf.lastRunAt) : t("fb_groups.never","Never");
        const isRunning = (wf.runningCount || 0) > 0;
        const totalPosts = (wf.workflowPostCount || 0) * Math.max(groups, 1);
        const pct = totalPosts > 0 ? Math.min(100, Math.round((sent / totalPosts) * 100)) : 0;
        const manualBadge = isManual ? `<span class="fbg-wf-manual-badge"><span class="material-icons" style="font-size:10px;">edit_note</span>Manual</span>` : "";
        const nextPostHtml = isActive ? `
            <div class="fbg-wf-next-post" data-next-post-at="${wf.nextPostAt ? escapeHtml(wf.nextPostAt) : ""}" data-running="${isRunning ? "1" : "0"}">
                <span class="material-icons">timer</span>
                <span class="fbg-wf-next-text">${escapeHtml(nextPostLabel(wf.nextPostAt, isRunning))}</span>
            </div>` : "";
        const progressBar = isActive ? `
            <div class="fbg-wf-progress-wrap${isRunning ? " running" : ""}" title="${sent}${totalPosts > 0 ? ` / ${totalPosts}` : ""} posts sent">
                <div class="fbg-wf-progress-bar" style="width:${pct}%"></div>
                <span class="fbg-wf-progress-label">${isRunning ? `<span class="fbg-wf-posting-dot"></span>${t("fb_groups.posting_now","Posting…")}` : `${pct}%`}${totalPosts > 0 ? ` &nbsp;·&nbsp; ${sent}/${totalPosts}` : ` &nbsp;·&nbsp; ${sent} sent`}</span>
            </div>` : "";
        const manageBtnHtml = isManual ? `
                <button class="fbg-wf-action-btn" data-wf-action="manage-posts" data-wf-id="${escapeHtml(wf.workflowId)}" data-wf-name="${escapeHtml(wf.name)}">
                    <span class="material-icons">list</span>${t("fb_groups.manage_posts","Posts")} <span style="background:#1877F2;color:#fff;border-radius:9px;padding:0 5px;font-size:10px;">${wf.workflowPostCount || 0}</span>
                </button>` : "";
        return `<div class="fbg-workflow-card" data-wf-id="${escapeHtml(wf.workflowId)}">
            <div class="fbg-wf-card-header">
                <div class="fbg-wf-card-icon"><span class="material-icons">${isManual ? "edit_note" : "sync_alt"}</span></div>
                <div class="fbg-wf-card-title">
                    <div class="fbg-wf-card-name" title="${escapeHtml(wf.name)}">${escapeHtml(wf.name)}${manualBadge}</div>
                    <span class="fbg-status-badge ${badgeCls}">${isActive ? "●" : (isCompleted ? "✓" : "○")} ${badgeTxt}</span>
                </div>
            </div>
            <div class="fbg-wf-card-stats">
                <span class="fbg-wf-card-stat"><span class="material-icons">group_work</span>${groups} group${groups !== 1 ? "s" : ""}</span>
                <span class="fbg-wf-card-stat"><span class="material-icons">send</span>${sent} sent</span>
                <span class="fbg-wf-card-stat"><span class="material-icons">schedule</span>${lastRun}</span>
            </div>
            ${progressBar}
            ${nextPostHtml}
            <div class="fbg-wf-card-actions">
                <button class="fbg-wf-action-btn" data-wf-action="settings" data-wf-id="${escapeHtml(wf.workflowId)}">
                    <span class="material-icons">settings</span>${t("fb_groups.settings","Settings")}
                </button>
                ${manageBtnHtml}
                <button class="fbg-wf-action-btn danger" data-wf-action="remove" data-wf-id="${escapeHtml(wf.workflowId)}">
                    <span class="material-icons">delete_outline</span>
                </button>
                <button class="fbg-wf-action-btn start-stop ${isActive ? "active" : ""}" data-wf-action="${toggleAction}" data-wf-id="${escapeHtml(wf.workflowId)}">
                    <span class="material-icons">${toggleIcon}</span>${toggleLbl}
                </button>
            </div>
        </div>`;
    }

    // ── Workflow Settings Panel ──────────────────────────────────

    // Show/hide "Edit comment text" field based on whether URL-as-comment is on
    // AND the viral action is edit_comment (only then do we need an editable text).
    function syncWfEditCommentOption() {
        // edit_comment custom body visibility is handled by the mode picker — no-op
    }

    // Show/hide "Initial comment" field: hidden when URL-as-comment is used
    // (the URL comment IS the initial comment) or when action isn't edit_comment.
    function buildPostContentSettings(prefix, wf = {}) {
        return `<div class="fbg-wf-settings-group">
            <div class="fbg-wf-settings-section-title">${t("fb_groups.post_content_options", "Post content")}</div>
            <div class="fbg-form-group">
                <label class="fbg-form-label" for="${prefix}PostKeepLines">${t("fb_groups.post_keep_lines", "Number of lines to include (0 = all lines)")}</label>
                <input type="number" class="fbg-input" id="${prefix}PostKeepLines" min="0" max="10000" step="1" value="${Number(wf.postKeepLines) || 0}">
                <p class="fbg-form-hint">${t("fb_groups.post_lines_hint", "Counts line breaks, including blank lines. Screen wrapping does not count.")}</p>
            </div>
            <div class="fbg-form-group">
                <label class="fbg-form-label" for="${prefix}PostSuffix">${t("fb_groups.post_suffix", "Text to add after the post content")}</label>
                <textarea class="fbg-input fbg-textarea" id="${prefix}PostSuffix" rows="3">${escapeHtml(wf.postSuffix || "")}</textarea>
            </div>
            <label class="fbg-form-label" for="${prefix}PostContentAsComment">
                <input type="checkbox" id="${prefix}PostContentAsComment" ${wf.postContentAsComment ? 'checked' : ''}>
                ${t("fb_groups.post_content_as_comment", "Write the full post content in the first comment")}
            </label>
            <p class="fbg-form-hint">${t("fb_groups.post_content_comment_hint", "Uses the full content before shortening or adding text. If First Comment is enabled, its text is appended to the same comment. This comment is used by viral comment editing.")}</p>
        </div>`;
    }

    function syncWfInitialComment() {
        const urlCommentOn = $("#fbgWfUrlComment").is(":checked") || $("#fbgWfPostContentAsComment").is(":checked");
        const action       = $("#fbgWfViralAction").val();
        $("#fbgWfInitialCommentGroup").toggle(!urlCommentOn && action === "edit_comment");
    }

    async function openWfSettingsPanel(wfId) {
        currentWfId = wfId;
        const res = await window.electronAPI.fbGroupsGetWorkflowSettings(wfId).catch(() => null);
        if (!res?.success || !res.data) return;
        const wf = res.data;
        const targets = wf.targets || [];
        const groups  = allGroups.length ? allGroups : (await window.electronAPI.fbGroupsGetAll().catch(() => ({data:[]})))?.data || [];

        $("#fbgWfPanelName").text(wf.name || "Workflow");
        $("#fbgWfPanelMeta").text(`${targets.length} group${targets.length !== 1 ? "s" : ""} · ${wf.postsSent || 0} posts sent`);

        const groupsHtml = groups.map(g => {
            const tgt = targets.find(t => t.groupId === g.groupId);
            const sel = tgt ? "checked" : "";
            const profileIds = tgt?.profileIds || (tgt?.profileId ? [tgt.profileId] : []);
            const profiles  = [];
            return `<div class="fbg-group-target-row ${tgt ? "selected" : ""}">
                <input type="checkbox" class="fbg-group-target-cb" data-group-id="${escapeHtml(g.groupId)}" ${sel}>
                <span class="fbg-group-target-name">${escapeHtml(g.name)}</span>
                <select multiple size="4" aria-label="${t("fb_groups.workflow_accounts", "Posting accounts")}" class="fbg-input fbg-group-target-profile" data-group-id="${escapeHtml(g.groupId)}" title="${t("fb_groups.workflow_accounts_hint", "Hold Ctrl (Command on Mac) to select multiple accounts. Auto uses all linked accounts.")}" style="width:190px;height:auto;" ${!tgt ? "disabled" : ""}>
                    <option value="" ${!profileIds.length ? "selected" : ""}>${t("fb_groups.auto_profile","Auto")}</option>
                    ${profileIds.map(id => `<option value="${escapeHtml(id)}" selected>${escapeHtml(id)}</option>`).join("")}
                </select>
            </div>`;
        }).join("") || `<p style="color:var(--text-secondary);font-size:13px;">${t("fb_groups.no_groups_yet","No groups yet")}</p>`;

        const viralChecked   = wf.viralMonitorEnabled ? "checked" : "";
        const urlChecked     = wf.postUrlAsComment    ? "checked" : "";
        const loopChecked    = wf.loopWorkflow ? "checked" : "";
        const hmVal          = (wf.humanMode === 1 || wf.humanMode === true) ? "on" : (wf.humanMode === 0 ? "off" : "inherit");
        const sc             = wf.scheduleConfig || {};
        const schedulingHtml = buildSchedulingHtml(wf.delayMinutes || 30, sc, "fbgWf");

        $("#fbgWfPanelBody").html(`
            <div class="fbg-panel-section">
                <div class="fbg-wf-settings-group">
                    <div class="fbg-wf-settings-section-title">${t("fb_groups.target_groups","Target Groups")}</div>
                    <div style="display:flex;flex-direction:column;gap:6px;" id="fbgWfSettingsGroups">${groupsHtml}</div>
                    <p class="fbg-form-hint">${t("fb_groups.workflow_accounts_hint", "Hold Ctrl (Command on Mac) to select multiple accounts. Auto uses all linked accounts.")}</p>
                </div>
                <div class="fbg-wf-settings-group">
                    <div class="fbg-wf-settings-section-title">${t("fb_groups.scheduling","Scheduling")}</div>
                    ${schedulingHtml}
                    <div class="fbg-form-group" style="margin-top:10px;">
                        <div class="fbg-form-label" style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                            <label class="fbg-toggle-switch">
                                <input type="checkbox" id="fbgWfLoop" ${loopChecked}>
                                <span class="fbg-toggle-thumb"></span>
                            </label>
                            ${t("fb_groups.loop_workflow","Loop Workflow")}
                        </div>
                    </div>
                    <div class="fbg-form-group" style="margin-top:10px;">
                        <label class="fbg-form-label">${t("fb_groups.human_mode_label_short","Human Mode")}</label>
                        <select class="fbg-input" id="fbgWfHumanMode" style="width:220px;">
                            <option value="inherit" ${hmVal==="inherit"?"selected":""}>${t("fb_groups.human_mode_inherit","Use global setting")}</option>
                            <option value="on" ${hmVal==="on"?"selected":""}>${t("fb_groups.human_mode_on","On")}</option>
                            <option value="off" ${hmVal==="off"?"selected":""}>${t("fb_groups.human_mode_off","Off")}</option>
                        </select>
                        <p class="fbg-form-hint">${t("fb_groups.human_mode_wf_hint","On: post through a real browser that browses and uses the composer (safer, slower). Off: post silently in the background (faster).")}</p>
                    </div>
                </div>
                ${buildPostContentSettings("fbgWf", wf)}
                <div class="fbg-wf-settings-group">
                    <div class="fbg-wf-settings-section-title">${t("fb_groups.url_as_comment","First Comment")}</div>
                    <div class="fbg-form-group">
                        <div class="fbg-form-label" style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                            <label class="fbg-toggle-switch">
                                <input type="checkbox" id="fbgWfUrlComment" ${urlChecked}>
                                <span class="fbg-toggle-thumb"></span>
                            </label>
                            ${t("fb_groups.enable","Enable")}
                        </div>
                    </div>
                    <div class="fbg-form-group" style="margin-top:8px;">
                        <label class="fbg-form-label">${t("fb_groups.comment_text","Comment Text")}</label>
                        <textarea class="fbg-input fbg-textarea" id="fbgWfUrlPrefix" rows="3" placeholder="e.g. Check it out!&#10;{{url}}">${escapeHtml(wf.urlCommentPrefix || "")}</textarea>
                        <p class="fbg-form-hint">${t("fb_groups.comment_url_hint","Use {{url}} to insert the post URL")}</p>
                    </div>
                </div>
                <div class="fbg-wf-settings-group">
                    <div class="fbg-wf-settings-section-title">${t("fb_groups.viral_monitoring","Viral Monitoring")}</div>
                    <div class="fbg-form-group">
                        <div class="fbg-form-label" style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                            <label class="fbg-toggle-switch">
                                <input type="checkbox" id="fbgWfViralEnabled" ${viralChecked}>
                                <span class="fbg-toggle-thumb"></span>
                            </label>
                            ${t("fb_groups.enable","Enable")}
                        </div>
                    </div>
                    <div class="fbg-form-row" style="padding:0;border-top:none;gap:10px;flex-wrap:wrap;margin-top:8px;">
                        <div class="fbg-form-group">
                            <label class="fbg-form-label">${t("fb_groups.viral_metric","Metric")}</label>
                            <select class="fbg-input" id="fbgWfViralMetric" style="width:120px;">
                                <option value="shares" ${(wf.viralMetric||'shares')==='shares'?'selected':''}>${t("fb_groups.metric_shares","Shares")}</option>
                                <option value="likes" ${wf.viralMetric==='likes'?'selected':''}>${t("fb_groups.metric_likes","Likes")}</option>
                                <option value="comments" ${wf.viralMetric==='comments'?'selected':''}>${t("fb_groups.metric_comments","Comments")}</option>
                            </select>
                        </div>
                        <div class="fbg-form-group">
                            <label class="fbg-form-label">${t("fb_groups.target_count","Target Count")}</label>
                            <input type="number" class="fbg-input" id="fbgWfViralShares" value="${wf.viralSharesTarget || 100}" min="1" style="width:100px;">
                        </div>
                        <div class="fbg-form-group">
                            <label class="fbg-form-label">${t("fb_groups.viral_action","Action")}</label>
                            <select class="fbg-input" id="fbgWfViralAction" style="width:180px;">
                                <option value="edit_comment" ${wf.viralAction === "edit_comment" ? "selected" : ""}>${t("fb_groups.edit_first_comment","Edit First Comment")}</option>
                                <option value="edit_post" ${(wf.viralAction === "edit_post" || !wf.viralAction) ? "selected" : ""}>${t("fb_groups.edit_post","Edit Post")}</option>
                            </select>
                        </div>
                    </div>
                    <div class="fbg-form-group" id="fbgWfInitialCommentGroup" style="margin-top:8px;${(wf.postUrlAsComment || wf.postContentAsComment || (wf.viralAction !== 'edit_comment' && wf.viralAction)) ? 'display:none;' : ''}">
                        <label class="fbg-form-label">${t("fb_groups.initial_comment","Initial Comment")}</label>
                        <textarea class="fbg-input fbg-textarea" id="fbgWfInitialComment" rows="2">${escapeHtml(wf.viralInitialCommentText || "")}</textarea>
                    </div>
                    <!-- Edit Content / AI Rewrite section -->
                    <div id="fbgWfAiRewriteSection" style="${wf.viralMonitorEnabled ? '' : 'display:none;'}border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:12px 14px;background:var(--bg-secondary,#f8f9fa);margin-top:10px;">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                            <span class="material-icons" style="font-size:18px;color:#8b5cf6;">smart_toy</span>
                            <span style="font-weight:600;font-size:13px;">${wf.viralAction === 'edit_post' ? t("fb_groups.edit_post_content","Edit Post Content") : t("fb_groups.edit_comment_content","Edit Comment Content")}</span>
                        </div>
                        <!-- Mode picker: shown for both actions -->
                        <div id="fbgWfEditPostModePicker" style="display:flex;gap:0;margin-bottom:12px;border:1px solid var(--border-color,#e5e7eb);border-radius:8px;overflow:hidden;">
                            <button type="button" id="fbgWfEditModeAiBtn" style="flex:1;padding:8px 14px;font-size:13px;font-weight:500;border:none;background:${wf.viralAiRewrite ? 'var(--accent-color,#0d6efd)' : 'var(--bg-primary,#fff)'};color:${wf.viralAiRewrite ? '#fff' : 'var(--text-secondary,#6c757d)'};cursor:pointer;">
                                <span class="material-icons" style="font-size:14px;vertical-align:middle;margin-right:4px;">smart_toy</span>${t("fb_groups.ai_rewrite","AI Rewrite Post")}
                            </button>
                            <button type="button" id="fbgWfEditModeCustomBtn" style="flex:1;padding:8px 14px;font-size:13px;font-weight:500;border:none;border-left:1px solid var(--border-color,#e5e7eb);background:${!wf.viralAiRewrite ? 'var(--accent-color,#0d6efd)' : 'var(--bg-primary,#fff)'};color:${!wf.viralAiRewrite ? '#fff' : 'var(--text-secondary,#6c757d)'};cursor:pointer;">
                                <span class="material-icons" style="font-size:14px;vertical-align:middle;margin-right:4px;">edit_note</span>${t("fb_groups.custom_text","Custom Text")}
                            </button>
                        </div>
                        <!-- AI Rewrite body -->
                        <div id="fbgWfAiRewriteBody" style="${wf.viralAiRewrite ? '' : 'display:none;'}">
                            <div class="fbg-form-row" style="padding:0;border-top:none;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
                                <div class="fbg-form-group" style="flex:1;min-width:130px;">
                                    <label class="fbg-form-label">${t("fb_groups.ai_provider","Provider")}</label>
                                    <select class="fbg-input" id="fbgWfAiProvider" style="width:100%;"></select>
                                </div>
                                <div class="fbg-form-group" style="flex:1;min-width:130px;">
                                    <label class="fbg-form-label">${t("fb_groups.ai_model","Model")}</label>
                                    <input type="text" class="fbg-input" id="fbgWfAiModel" value="${escapeHtml(wf.viralAiModel || '')}" placeholder="e.g. gpt-4o-mini">
                                </div>
                            </div>
                            <div class="fbg-form-group">
                                <label class="fbg-form-label">${t("fb_groups.ai_prompt","Prompt")}</label>
                                <textarea class="fbg-input fbg-textarea" id="fbgWfAiPrompt" rows="5" placeholder="Use {{post_text}} for the original post and {{url}} for the link.">${escapeHtml(wf.viralAiPromptText || '')}</textarea>
                                <p class="fbg-form-hint" style="margin-top:4px;">${t("fb_groups.ai_prompt_hint","Available variables: <code>{{post_text}}</code> — original post · <code>{{url}}</code> — the viral link")}</p>
                            </div>
                        </div>
                        <!-- Custom Text body for edit_post -->
                        <div id="fbgWfEditPostCustomBody" style="${(wf.viralAction === 'edit_post' && !wf.viralAiRewrite) ? '' : 'display:none;'}">
                            <div class="fbg-form-group">
                                <label class="fbg-form-label">${t("fb_groups.edit_post_new_text","New Post Text")}</label>
                                <textarea class="fbg-input fbg-textarea" id="fbgWfEditPostText" rows="4" placeholder="${t("fb_groups.edit_post_text_placeholder","Enter the new post text. Use {{url}} for the viral link.")}">${escapeHtml(wf.viralEditPostText || '')}</textarea>
                                <p class="fbg-form-hint">${t("fb_groups.edit_post_text_hint","Use {{url}} to insert the viral link.")}</p>
                            </div>
                            <div class="fbg-form-group" style="margin-top:8px;">
                                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                    <label class="fbg-toggle-switch" onclick="event.stopPropagation()">
                                        <input type="checkbox" id="fbgWfEditPostKeepLinesEnabled" ${(wf.viralEditPostKeepLines > 0) ? 'checked' : ''}>
                                        <span class="fbg-toggle-thumb"></span>
                                    </label>
                                    <span style="font-size:13px;color:var(--text-primary);">${t("fb_groups.keep_lines_label","Keep first")}</span>
                                    <input type="number" class="fbg-input" id="fbgWfEditPostKeepLines" value="${wf.viralEditPostKeepLines > 0 ? wf.viralEditPostKeepLines : 2}" min="1" max="50" style="width:65px;" ${(wf.viralEditPostKeepLines > 0) ? '' : 'disabled'}>
                                    <span style="font-size:13px;color:var(--text-primary);">${t("fb_groups.keep_lines_suffix","lines from old post, then add new text below")}</span>
                                </div>
                            </div>
                        </div>
                        <!-- Custom Text body for edit_comment -->
                        <div id="fbgWfEditCommentCustomBody" style="${(wf.viralAction === 'edit_comment' && !wf.viralAiRewrite) ? '' : 'display:none;'}">
                            <div class="fbg-form-group" style="margin-top:10px;">
                                <label class="fbg-form-label">${t("fb_groups.also_edit_post","Also Edit the Post")}</label>
                                <p class="fbg-form-hint">${t("fb_groups.also_edit_post_hint","Leave empty to not touch the post. Use {{url}} for the viral link.")}</p>
                                <textarea class="fbg-input fbg-textarea" id="fbgWfEditPostText" rows="3" placeholder="${t("fb_groups.also_edit_post_placeholder","e.g. Check out the first comment for the full recipe! {{url}}")}">${escapeHtml(wf.viralEditPostText || '')}</textarea>
                            </div>
                            <div class="fbg-form-group" style="margin-top:8px;">
                                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                    <label class="fbg-toggle-switch" onclick="event.stopPropagation()">
                                        <input type="checkbox" id="fbgWfEditPostKeepLinesEnabled" ${(wf.viralEditPostKeepLines > 0) ? 'checked' : ''}>
                                        <span class="fbg-toggle-thumb"></span>
                                    </label>
                                    <span style="font-size:13px;color:var(--text-primary);">${t("fb_groups.keep_lines_label","Keep first")}</span>
                                    <input type="number" class="fbg-input" id="fbgWfEditPostKeepLines" value="${wf.viralEditPostKeepLines > 0 ? wf.viralEditPostKeepLines : 2}" min="1" max="50" style="width:65px;" ${(wf.viralEditPostKeepLines > 0) ? '' : 'disabled'}>
                                    <span style="font-size:13px;color:var(--text-primary);">${t("fb_groups.keep_lines_suffix","lines from old post, then add new text below")}</span>
                                </div>
                            </div>
                        </div>
                        <!-- Replacement Comment Text — always visible for edit_comment -->
                        <div id="fbgWfEditCommentTextGroup" style="${wf.viralAction === 'edit_comment' ? 'margin-top:10px;' : 'display:none;margin-top:10px;'}">
                            <div class="fbg-form-group">
                                <label class="fbg-form-label">${t("fb_groups.edit_comment_text","Replacement Comment Text")}</label>
                                <p class="fbg-form-hint">${t("fb_groups.edit_comment_text_hint","Replaces the First Comment when the target is reached. Use {{url}} for the viral link.")}</p>
                                <textarea class="fbg-input fbg-textarea" id="fbgWfEditCommentText" rows="2" placeholder="e.g. Check out the full recipe: {{url}}">${escapeHtml(wf.viralEditCommentText || '')}</textarea>
                            </div>
                        </div>
                    </div>
                    <!-- Viral automation for URL -->
                    <div style="border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:12px 14px;background:var(--bg-secondary,#f8f9fa);margin-top:10px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span class="material-icons" style="font-size:18px;color:#0ea5e9;">rocket_launch</span>
                                <span style="font-weight:600;font-size:13px;">${t("fb_groups.viral_automation_url","Run Automation for Article URL")}</span>
                            </div>
                            <label class="fbg-toggle-switch" onclick="event.stopPropagation()">
                                <input type="checkbox" id="fbgWfViralAutoEnabled" ${wf.viralAutomationId ? "checked" : ""}>
                                <span class="fbg-toggle-thumb"></span>
                            </label>
                        </div>
                        <div id="fbgWfViralAutoBody" style="${wf.viralAutomationId ? '' : 'display:none;'}">
                            <p class="fbg-form-hint" style="margin-bottom:8px;">${t("fb_groups.viral_automation_url_hint","When the viral threshold is reached, this automation runs first. It receives the post image and text, and must output a URL via the URL slot of the facebook-output node.")}</p>
                            <div class="fbg-form-group">
                                <label class="fbg-form-label">${t("fb_groups.viral_automation_select","Select Automation")}</label>
                                <select class="fbg-input" id="fbgWfViralAutoId" style="width:100%;">
                                    <option value="">${t("fb_groups.viral_automation_none","None \u2014 use existing URL")}</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `);

        // Load group profiles for each target selector
        for (const g of groups) {
            const tgt = targets.find(tt => tt.groupId === g.groupId);
            try {
                const pRes = await window.electronAPI.fbGroupsGetProfiles(g.groupId);
                if (pRes.success && Array.isArray(pRes.data)) {
                    const $sel = $(`[data-group-id="${g.groupId}"].fbg-group-target-profile`);
                    $sel.find('option').filter(function () { return this.value !== ""; }).remove();
                    pRes.data.forEach(p => {
                        const selectedIds = tgt?.profileIds || (tgt?.profileId ? [tgt.profileId] : []);
                        const sel = selectedIds.includes(p.profileId) ? "selected" : "";
                        $sel.append(`<option value="${escapeHtml(p.profileId)}" ${sel}>${escapeHtml(p.profileLabel || p.profileId)}</option>`);
                    });
                    const savedIds = tgt?.profileIds || (tgt?.profileId ? [tgt.profileId] : []);
                    savedIds.filter(id => !pRes.data.some(p => p.profileId === id)).forEach(id => {
                        $sel.append(`<option value="${escapeHtml(id)}" selected>${escapeHtml(id)}</option>`);
                    });

                }
            } catch (_) {}
        }

        $("#fbgWfOverlay").addClass("open");
        $("#fbgWfSettingsPanel").addClass("open");
        // Sync edit_comment option availability to First Comment toggle
        syncWfEditCommentOption();
        syncWfInitialComment();

        // Populate AI providers for AI Rewrite section
        if (wf.viralAiRewrite) {
            loadConnectedAiProvidersInto("fbgWfAiProvider", "fbgWfAiModel").then(() => {
                if (wf.viralAiProvider) $("#fbgWfAiProvider").val(wf.viralAiProvider).trigger("change");
            }).catch(() => {});
        }

        // Populate viral automation selector
        (async () => {
            try {
                const automationsRaw = await window.electronAPI.readKey("automations");
                const automations = Array.isArray(automationsRaw) ? automationsRaw : [];
                const eligible = automations.filter(a => {
                    const nodes = a.data?.drawflow?.Home?.data || {};
                    return Object.values(nodes).some(n => n.data?.type === 'facebook-output' || n.name === 'facebook-output');
                });
                const $sel = $("#fbgWfViralAutoId");
                $sel.empty().append(`<option value="">${t('fb_groups.viral_automation_none','None \u2014 use existing URL')}</option>`);
                eligible.forEach(a => {
                    const label = a.label || a.id;
                    const sel = a.id === wf.viralAutomationId ? 'selected' : '';
                    $sel.append(`<option value="${escapeHtml(a.id)}" ${sel}>${escapeHtml(label)}</option>`);
                });
            } catch (_) {}
        })();
    }

    function closeWfSettingsPanel() {
        currentWfId = null;
        $("#fbgWfOverlay").removeClass("open");
        $("#fbgWfSettingsPanel").removeClass("open");
    }

    async function saveWfSettings() {
        if (!currentWfId) return;
        const action = $("#fbgWfViralAction").val();
        const isEditPost = action === 'edit_post';
        const viralAiRewrite = $("#fbgWfAiRewrite").is(":checked");
        const aiRewriteOn = viralAiRewrite;
        const aiPromptVal = $("#fbgWfAiPrompt").val().trim();
        if (aiRewriteOn && aiPromptVal && !aiPromptVal.includes('{{post_text}}')) {
            if (!confirm(t("fb_groups.ai_prompt_missing_post_text", "Your AI prompt doesn't contain {{post_text}} — the original post won't be passed to the AI. Save anyway?"))) return;
        }
        // Keep-lines and edit post text are valid for both actions (edit_comment uses them to also edit the post)
        const keepLinesOn = $("#fbgWfEditPostKeepLinesEnabled").is(":checked");
        const settings = {
            delayMinutes:              parseInt($("#fbgWfDelay").val()) || 30,
            scheduleConfig:            readSchedulingConfig("fbgWf"),
            loopWorkflow:              $("#fbgWfLoop").is(":checked"),
            humanMode:                 (() => { const v = $("#fbgWfHumanMode").val(); return v === "on" ? true : (v === "off" ? false : null); })(),
            postKeepLines:            Math.max(0, Math.min(10000, Math.floor(Number($("#fbgWfPostKeepLines").val()) || 0))),
            postSuffix:               $("#fbgWfPostSuffix").val().trim(),
            postContentAsComment:     $("#fbgWfPostContentAsComment").is(":checked"),
            postUrlAsComment:          $("#fbgWfUrlComment").is(":checked"),
            urlCommentPrefix:          $("#fbgWfUrlPrefix").val().trim(),
            viralMonitorEnabled:       $("#fbgWfViralEnabled").is(":checked"),
            viralSharesTarget:         parseInt($("#fbgWfViralShares").val()) || 100,
            viralMetric:               $("#fbgWfViralMetric").val() || 'shares',
            viralAction:               action,
            viralInitialCommentText:   $("#fbgWfInitialComment").val().trim(),
            viralEditCommentText:      $("#fbgWfEditCommentText").val().trim(),
            viralAiRewrite:            viralAiRewrite,
            viralAiProvider:           $("#fbgWfAiProvider").val() || null,
            viralAiModel:              $("#fbgWfAiModel").val().trim() || null,
            viralAiPromptText:         $("#fbgWfAiPrompt").val().trim() || null,
            viralAutomationId:         ($("#fbgWfViralAutoEnabled").is(":checked") && $("#fbgWfViralAutoId").val()) ? $("#fbgWfViralAutoId").val() : null,
            viralEditPostText:         !viralAiRewrite ? ($("#fbgWfEditPostText").val().trim() || null) : null,
            viralEditPostKeepLines:    (!viralAiRewrite && keepLinesOn) ? (parseInt($("#fbgWfEditPostKeepLines").val()) || 0) : null,
        };
        const targets = [];
        $(".fbg-group-target-cb:checked").each(function () {
            const groupId   = $(this).data("group-id");
            const profileIds = ($(`[data-group-id="${groupId}"].fbg-group-target-profile`).val() || []).filter(Boolean);
            targets.push({ groupId, profileIds });
        });
        await window.electronAPI.fbGroupsUpdateWorkflowSettings(currentWfId, settings).catch(() => {});
        await window.electronAPI.fbGroupsUpdateWorkflowTargets(currentWfId, targets).catch(() => {});
        closeWfSettingsPanel();
        await loadWorkflows();
        await loadDashboardStats();
    }

    // ════════════════════════════════════════════════════
    //  IMPORT MODAL
    // ════════════════════════════════════════════════════

    function refreshPromptPicker(selectId) {
        const prompts = window._fbGroupsAiPrompts || [];
        const $picker = $("#fbgAiPromptPicker");
        $picker.empty().append(`<option value="">${t("fb_groups.ai_prompt_select","— Saved Prompts —")}</option>`);
        prompts.forEach(p => {
            $picker.append(`<option value="${escapeHtml(p.id)}" ${p.id === selectId ? "selected" : ""}>${escapeHtml(p.name)}</option>`);
        });
        $("#fbgAiPromptDeleteBtn").toggle(!!(selectId && prompts.find(p => p.id === selectId)));
    }

    async function loadAiPrompts() {
        try {
            const res = await window.electronAPI.fbGroupsGetAiPrompts();
            window._fbGroupsAiPrompts = (res.success && Array.isArray(res.data)) ? res.data : [];
        } catch (_) { window._fbGroupsAiPrompts = []; }
        refreshPromptPicker("");
    }

    // ════════════════════════════════════════════════════
    //  UNIFIED NEW WORKFLOW MODAL  (automation + manual)
    // ════════════════════════════════════════════════════

    let _newWfType = "automation"; // current active tab
    let _nwNameDirty = false;       // true once the user manually edits the workflow name

    // NW manual post picker state
    let _nwLibAllPosts   = [];          // all library posts (cached)
    let _nwSelectedIds   = new Set();   // confirmed ids for new workflow
    // Picker modal transient state
    let _nwPickerTempIds  = new Set();
    let _nwPickerFilter   = "all";      // "all"|"today"|"yesterday"|"range"
    let _nwPickerDateFrom = "";
    let _nwPickerDateTo   = "";
    let _nwPickerSearch   = "";
    let _nwPickerPage     = 1;
    const NW_PICKER_PAGE  = 30;

    function syncNWEditCommentOption() {
        const enabled = $("#fbgNWUrlComment").is(":checked");
        const $opt = $("#fbgNWViralAction option[value='edit_comment']");
        $opt.prop("disabled", !enabled);
        if (!enabled && $("#fbgNWViralAction").val() === "edit_comment") {
            $("#fbgNWViralAction").val("edit_post").trigger("change");
        }
    }

    function _updateNWEditSectionLabel() {
        const isEditPost = $("#fbgNWViralAction").val() === "edit_post";
        const label = isEditPost
            ? (window.I18n?.t("fb_groups.edit_post_content") || "Edit Post Content")
            : (window.I18n?.t("fb_groups.edit_comment_content") || "Edit Comment Content");
        $("#fbgNWEditSectionLabel").text(label);
    }

    function syncNWInitialComment() {
        const firstCommentOn = $("#fbgNWUrlComment").is(":checked") || $("#fbgNWPostContentAsComment").is(":checked");
        const action = $("#fbgNWViralAction").val();
        $("#fbgNWEditCommentGroup").toggle(firstCommentOn && action === "edit_comment");
        $("#fbgNWInitialCommentGroup").toggle(!firstCommentOn && action === "edit_comment");
    }

    async function openNWPickerModal() {
        // Show modal with loading state
        $("#fbgNWPickerList").html(`<div style="padding:48px 20px;text-align:center;color:var(--text-secondary);font-size:14px;"><span class="material-icons" style="font-size:40px;display:block;margin-bottom:8px;opacity:.4;">hourglass_empty</span>Loading posts…</div>`);
        $("#fbgNWPickerBackdrop").addClass("open");
        $("#fbgNWPickerModal").addClass("open");
        // Fetch posts if not cached
        if (!_nwLibAllPosts.length) {
            const libRes = await window.electronAPI.fbGroupsGetLibraryPosts().catch(() => null);
            _nwLibAllPosts = Array.isArray(libRes) ? libRes
                : (Array.isArray(libRes?.data) ? libRes.data : []);
        }
        // Reset transient state from confirmed selection
        _nwPickerTempIds  = new Set(_nwSelectedIds);
        _nwPickerFilter   = "all";
        _nwPickerDateFrom = "";
        _nwPickerDateTo   = "";
        _nwPickerSearch   = "";
        _nwPickerPage     = 1;
        $("#fbgNWPickerSearch").val("");
        $("#fbgNWPickerDateFrom").val("");
        $("#fbgNWPickerDateTo").val("");
        $(".fbg-picker-filter-chip").removeClass("active");
        $(".fbg-picker-filter-chip[data-filter='all']").addClass("active");
        $("#fbgNWPickerDateRange").hide();
        _renderNWPickerList();
    }

    function closeNWPickerModal(apply) {
        if (apply) {
            _nwSelectedIds = new Set(_nwPickerTempIds);
            const n = _nwSelectedIds.size;
            $("#fbgNWPostsSelCount").text(n > 0 ? `${n} post${n !== 1 ? "s" : ""} selected` : "");
        }
        $("#fbgNWPickerBackdrop").removeClass("open");
        $("#fbgNWPickerModal").removeClass("open");
    }

    function _filterNWPickerPosts() {
        let posts = _nwLibAllPosts.slice();
        if (_nwPickerFilter !== "all") {
            const now = new Date();
            const todayStr = now.toISOString().slice(0, 10);
            const yest = new Date(now); yest.setDate(yest.getDate() - 1);
            const yesterdayStr = yest.toISOString().slice(0, 10);
            posts = posts.filter(p => {
                const pd = (p.createdAt || "").slice(0, 10);
                if (_nwPickerFilter === "today")     return pd === todayStr;
                if (_nwPickerFilter === "yesterday") return pd === yesterdayStr;
                if (_nwPickerFilter === "range") {
                    if (_nwPickerDateFrom && pd < _nwPickerDateFrom) return false;
                    if (_nwPickerDateTo   && pd > _nwPickerDateTo)   return false;
                    return true;
                }
                return true;
            });
        }
        const q = _nwPickerSearch.toLowerCase();
        if (q) posts = posts.filter(p =>
            (p.text || "").toLowerCase().includes(q) ||
            (p.url  || "").toLowerCase().includes(q)
        );
        return posts;
    }

    function _renderNWPickerList() {
        const filtered   = _filterNWPickerPosts();
        const totalPages = Math.max(1, Math.ceil(filtered.length / NW_PICKER_PAGE));
        if (_nwPickerPage > totalPages) _nwPickerPage = totalPages;
        const start = (_nwPickerPage - 1) * NW_PICKER_PAGE;
        const page  = filtered.slice(start, start + NW_PICKER_PAGE);
        const $list = $("#fbgNWPickerList");
        const selCount = _nwPickerTempIds.size;
        $("#fbgNWPickerCount").text(selCount > 0
            ? `${selCount} post${selCount !== 1 ? "s" : ""} selected`
            : `${_nwLibAllPosts.length} post${_nwLibAllPosts.length !== 1 ? "s" : ""} in library`);
        $("#fbgNWPickerSelInfo").text(selCount > 0
            ? `${selCount} post${selCount !== 1 ? "s" : ""} selected`
            : "No posts selected yet");
        if (!filtered.length) {
            $list.html(`<div style="padding:48px 20px;text-align:center;color:var(--text-secondary);font-size:14px;">
                <span class="material-icons" style="font-size:40px;display:block;margin-bottom:8px;opacity:.4;">search_off</span>
                ${_nwPickerSearch ? `No results for "<strong>${escapeHtml(_nwPickerSearch)}</strong>"` : "No posts match the selected filter."}
            </div>`);
            $("#fbgNWPickerPagination").empty().hide();
            return;
        }
        const html = page.map(post => {
            const checked = _nwPickerTempIds.has(post.id);
            const dateStr = post.createdAt
                ? new Date(post.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                : "";
            const thumbHtml = post.imagePath
                ? `<img src="file://${post.imagePath.replace(/\\/g,'/')}" class="fbg-picker-thumb-img" onerror="this.style.display='none'">`
                : `<span class="material-icons" style="font-size:20px;color:var(--text-secondary);">image_not_supported</span>`;
            return `<label class="fbg-picker-post-row${checked ? " selected" : ""}" data-post-id="${post.id}">
                <input type="checkbox" class="fbg-nw-picker-cb" style="flex-shrink:0;"${checked ? " checked" : ""}>
                <div class="fbg-picker-post-thumb">${thumbHtml}</div>
                <div class="fbg-picker-post-body">
                    <div class="fbg-picker-post-text">${escapeHtml(post.text || "(no text)")}</div>
                    ${post.url ? `<div class="fbg-picker-post-url">${escapeHtml(post.url)}</div>` : ""}
                </div>
                ${dateStr ? `<div class="fbg-picker-post-date">${dateStr}</div>` : ""}
            </label>`;
        }).join("");
        $list.html(html);
        // Pagination
        const $pag = $("#fbgNWPickerPagination");
        if (totalPages > 1) {
            const from = start + 1, to = Math.min(start + NW_PICKER_PAGE, filtered.length);
            let btnHtml = "";
            for (const pg of _buildPageRange(_nwPickerPage, totalPages)) {
                if (pg === "...") btnHtml += `<span class="fbg-page-ellipsis">…</span>`;
                else btnHtml += `<button class="fbg-nw-picker-pgbtn fbg-page-btn${pg === _nwPickerPage ? " active" : ""}" data-pg="${pg}">${pg}</button>`;
            }
            $pag.show().html(`<div class="fbg-lib-pagination">
                <span class="fbg-page-info">${from}–${to} of ${filtered.length}</span>
                <div class="fbg-page-btns">
                    <button class="fbg-page-nav" id="fbgNWPickerPrev"${_nwPickerPage <= 1 ? " disabled" : ""}><span class="material-icons">chevron_left</span></button>
                    ${btnHtml}
                    <button class="fbg-page-nav" id="fbgNWPickerNext"${_nwPickerPage >= totalPages ? " disabled" : ""}><span class="material-icons">chevron_right</span></button>
                </div>
            </div>`);
        } else {
            $pag.empty().hide();
        }
    }

    function setNewWfType(type) {
        _newWfType = type;
        $(".fbg-wf-type-tab").removeClass("active");
        $(`.fbg-wf-type-tab[data-type="${type}"]`).addClass("active");
        const isManual = type === "manual";
        $("#fbgNWAutomationSection").toggle(!isManual);
        $("#fbgNWNameSection").show();
        $("#fbgNWLibrarySection").toggle(isManual);
        // Update confirm button label
        if (isManual) {
            $("#fbgNewWfConfirmLabel").attr("data-i18n", "fb_groups.create_workflow").text(t("fb_groups.create_workflow", "Create Workflow"));
            $("#fbgNewWfConfirmBtn .material-icons").text("check_circle");
        } else {
            $("#fbgNewWfConfirmLabel").attr("data-i18n", "fb_groups.import_confirm").text(t("fb_groups.import_confirm", "Import & Activate"));
            $("#fbgNewWfConfirmBtn .material-icons").text("add_circle");
        }
        updateNewWfConfirmBtn();
    }

    function updateNewWfConfirmBtn() {
        const hasGroup = $(".fbg-nw-group-cb:checked").length > 0;
        let enabled = hasGroup;
        if (_newWfType === "automation") {
            enabled = enabled && $(".fbg-nw-picker-item.selected[data-wf-id]").length > 0;
        }
        enabled = enabled && $("#fbgNWName").val().trim().length > 0;
        $("#fbgNewWfConfirmBtn").prop("disabled", !enabled);
    }

    async function openNewWfModal(type) {
        type = type || "automation";
        _newWfType = type;

        $("#fbgNWPostContentSettings").html(buildPostContentSettings("fbgNW"));

        // Reset shared fields
        $("#fbgNWLoop").prop("checked", false);
        $("#fbgNWUrlComment").prop("checked", false);
        $("#fbgNWUrlCommentSection").hide();
        $("#fbgNWUrlPrefix").val("");
        $("#fbgNWViralEnabled").prop("checked", false);
        $("#fbgNWViralSection").hide();
        $("#fbgNWViralShares").val(100);
        $("#fbgNWViralMetric").val("shares");
        $("#fbgNWViralAction").val("edit_post");
        $("#fbgNWAiRewriteSection").hide();
        $("#fbgNWAiRewrite").prop("checked", false);
        $("#fbgNWAiRewriteBody").hide();
        $("#fbgNWEditPostCustomBody").hide();
        $("#fbgNWEditCommentCustomBody").hide();
        $("#fbgNWEditCommentTextGroup").hide();
        $("#fbgNWEditPostText").val("");
        $("#fbgNWEditCommentText").val("");
        $("#fbgNWEditPostKeepLinesEnabled").prop("checked", false);
        $("#fbgNWEditPostKeepLines").val(2).prop("disabled", true);
        // Reset mode picker to AI (default)
        $("#fbgNWEditModeAiBtn").css({ background: "var(--accent-color,#0d6efd)", color: "#fff" });
        $("#fbgNWEditModeCustomBtn").css({ background: "var(--bg-primary,#fff)", color: "var(--text-secondary,#6c757d)" });
        _updateNWEditSectionLabel();
        $("#fbgNWAiModel").val("").prop("readonly", false).removeClass("fbg-input-locked").closest(".fbg-form-group").show();
        $("#fbgNWAiPrompt").val("");
        $("#fbgNWInitialComment").val("");
        $("#fbgNWEditCommentText").val("");
        $("#fbgNWViralAutoEnabled").prop("checked", false);
        $("#fbgNWViralAutoBody").hide();
        syncNWEditCommentOption();
        syncNWInitialComment();

        // Reset name + NW post picker
        $("#fbgNWName").val("");
        _nwNameDirty     = false;
        _nwLibAllPosts   = [];
        _nwSelectedIds   = new Set();
        _nwPickerTempIds = new Set();
        _nwPickerFilter  = "all";
        _nwPickerSearch  = "";
        _nwPickerPage    = 1;
        $("#fbgNWPostsSelCount").text("");

        // Inject scheduling html
        const $sched = $("#fbgNWSchedulingSection");
        $sched.html(buildSchedulingHtml(30, {}, "fbgNW"));
        if (window.I18n) window.I18n.translatePage();

        // Apply tab
        setNewWfType(type);

        // Populate group targets (shared)
        const groups = allGroups.length ? allGroups : (await window.electronAPI.fbGroupsGetAll().catch(() => ({ data: [] }))).data || [];
        const $targets = $("#fbgNWGroupTargetsList");
        if (!groups.length) {
            $targets.html(`<div class="fbg-picker-empty">${t("fb_groups.no_groups_yet", "No groups configured yet")}</div>`);
        } else {
            $targets.html(groups.map(g =>
                `<div class="fbg-group-target-row">
                    <input type="checkbox" class="fbg-nw-group-cb" data-group-id="${escapeHtml(g.groupId)}">
                    <span class="fbg-group-target-name">${escapeHtml(g.name)}</span>
                    <select multiple size="4" aria-label="${t("fb_groups.workflow_accounts", "Posting accounts")}" class="fbg-input fbg-nw-group-profile" data-group-id="${escapeHtml(g.groupId)}" title="${t("fb_groups.workflow_accounts_hint", "Hold Ctrl (Command on Mac) to select multiple accounts. Auto uses all linked accounts.")}" style="width:190px;height:auto;" disabled>
                        <option value="" selected>${t("fb_groups.auto_profile","Auto")}</option>
                    </select>
                </div>`
            ).join(""));
            for (const g of groups) {
                window.electronAPI.fbGroupsGetProfiles(g.groupId).then(pRes => {
                    if (!pRes.success || !Array.isArray(pRes.data)) return;
                    const $sel = $(`.fbg-nw-group-profile[data-group-id="${g.groupId}"]`);
                    pRes.data.forEach(p => $sel.append(`<option value="${escapeHtml(p.profileId)}">${escapeHtml(p.profileLabel || p.profileId)}</option>`));
                }).catch(() => {});
            }
        }

        if (type === "automation") {
            // Populate workflow picker
            let eligibleWorkflows = [];
            try {
                const [wfRes, importedRes, automationsRaw] = await Promise.all([
                    window.electronAPI.invoke("get-workflows-summary", 0, 500),
                    window.electronAPI.fbGroupsGetImportedWorkflowIds().catch(() => ({ data: [] })),
                    window.electronAPI.readKey("automations"),
                ]);
                const importedIds  = importedRes.data || [];
                const allWfs       = wfRes.success ? (wfRes.workflows || []) : [];
                const automations  = Array.isArray(automationsRaw) ? automationsRaw : [];
                const fbAutomationIds = new Set(
                    automations.filter(a => {
                        const nodes = a.data?.drawflow?.Home?.data || {};
                        return Object.values(nodes).some(n => n.data?.type === "facebook-output" || n.name === "facebook-output");
                    }).map(a => a.id)
                );
                eligibleWorkflows = allWfs.filter(wf => fbAutomationIds.has(wf.automationId)).map(wf => {
                    const automation = automations.find(a => a.id === wf.automationId);
                    return {
                        ...wf,
                        displayName: wf.name || automation?.label || wf.workflowId,
                        automationLabel: automation?.label || wf.automationId,
                        alreadyImported: importedIds.includes(wf.workflowId),
                    };
                });
            } catch (err) {
                console.error("[FbGroups] openNewWfModal fetch error:", err);
            }
            const $picker = $("#fbgNWWorkflowPicker");
            if (!eligibleWorkflows.length) {
                $picker.html(`<div class="fbg-picker-empty">${t("fb_groups.no_eligible_workflows", "No eligible workflows found. Run an automation with a Facebook Output node first.")}</div>`);
            } else {
                $picker.html(eligibleWorkflows.map(wf => {
                    const postCount = wf.totalPosts || 0;
                    const date = wf.createdAt ? new Date(wf.createdAt).toLocaleDateString() : "";
                    const alreadyBadge = wf.alreadyImported
                        ? `<span style="font-size:10px;background:var(--accent-color,#0d6efd);color:#fff;padding:1px 6px;border-radius:8px;margin-left:6px;">${t("fb_groups.already_imported","configured")}</span>`
                        : "";
                    return `<div class="fbg-nw-picker-item" data-wf-id="${escapeHtml(wf.workflowId)}" data-wf-name="${escapeHtml(wf.displayName)}">
                        <span class="material-icons">radio_button_unchecked</span>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;font-size:13px;">${escapeHtml(wf.displayName)}${alreadyBadge}</div>
                            <div style="font-size:11px;color:var(--text-secondary);">${escapeHtml(wf.automationLabel)} · ${postCount} post${postCount !== 1 ? "s" : ""} · ${date}</div>
                        </div>
                    </div>`;
                }).join(""));
            }
            // Preselect from navigation
            const preselect = window._fbGroupsPreselectedWorkflow;
            if (preselect) {
                window._fbGroupsPreselectedWorkflow = null;
                const $item = $(`.fbg-nw-picker-item[data-wf-id="${preselect.id}"]`);
                if ($item.length) {
                    $item.addClass("selected").find(".material-icons").text("radio_button_checked");
                    if (!_nwNameDirty) $("#fbgNWName").val($item.data("wf-name") || "");
                    $item[0].scrollIntoView({ block: "nearest" });
                }
            }
            // Viral automation selector
            (async () => {
                try {
                    const automationsRaw = await window.electronAPI.readKey("automations");
                    const automations = Array.isArray(automationsRaw) ? automationsRaw : [];
                    const eligible = automations.filter(a => {
                        const nodes = a.data?.drawflow?.Home?.data || {};
                        return Object.values(nodes).some(n => n.data?.type === 'facebook-output' || n.name === 'facebook-output');
                    });
                    const $sel = $("#fbgNWViralAutoId");
                    $sel.empty().append(`<option value="">${t('fb_groups.viral_automation_none','None — use existing URL')}</option>`);
                    eligible.forEach(a => $sel.append(`<option value="${escapeHtml(a.id)}">${escapeHtml(a.label || a.id)}</option>`));
                } catch (_) {}
            })();
            // AI prompts
            await loadNWAiPrompts();
        } else {
            // Viral automation selector for manual
            (async () => {
                try {
                    const automationsRaw = await window.electronAPI.readKey("automations");
                    const automations = Array.isArray(automationsRaw) ? automationsRaw : [];
                    const eligible = automations.filter(a => {
                        const nodes = a.data?.drawflow?.Home?.data || {};
                        return Object.values(nodes).some(n => n.data?.type === 'facebook-output' || n.name === 'facebook-output');
                    });
                    const $sel = $("#fbgNWViralAutoId");
                    $sel.empty().append(`<option value="">${t('fb_groups.viral_automation_none','None — use existing URL')}</option>`);
                    eligible.forEach(a => $sel.append(`<option value="${escapeHtml(a.id)}">${escapeHtml(a.label || a.id)}</option>`));
                } catch (_) {}
            })();
            await loadNWAiPrompts();
        }

        updateNewWfConfirmBtn();
        $("#fbgNewWfBackdrop").addClass("open");
        $("#fbgNewWfModal").addClass("open");
        if (type === "manual") setTimeout(() => $("#fbgNWName").focus(), 100);
    }

    function closeNewWfModal() {
        $("#fbgNewWfBackdrop").removeClass("open");
        $("#fbgNewWfModal").removeClass("open");
    }

    // Shims for backward compatibility (dashboard button, etc.)
    function openImportModal()   { openNewWfModal("automation"); }
    function closeImportModal()  { closeNewWfModal(); }
    function openManualWfModal() { openNewWfModal("manual"); }
    function closeManualWfModal(){ closeNewWfModal(); }

    async function loadConnectedAiProvidersInto(selectId, modelInputId) {
        const PROVIDER_LABELS = {
            deepseek:        "DeepSeek",
            deepseekbrowser: "DeepSeek Browser",
            openai:          "OpenAI",
            anthropic:       "Anthropic",
            googleai:        "Google AI",
            openrouter:      "OpenRouter",
            qwen:            "Qwen",
            qwenbrowser:     "Qwen Browser",
            zhipu:           "Zhipu",
            moonshot:        "Moonshot",
        };
        const DEFAULT_MODELS = {
            openai:    "gpt-4o-mini",
            anthropic: "claude-3-5-haiku-20241022",
            googleai:  "gemini-2.0-flash",
        };
        const NO_MODEL = ["deepseekbrowser", "qwenbrowser"];
        try {
            const res = await window.electronAPI.fbGroupsGetConnectedAiProviders();
            const data = (res?.success && res.data) ? res.data : {};
            const $sel = $(`#${selectId}`);
            const $model = $(`#${modelInputId}`);
            const prev = $sel.val();
            $sel.find("option:not([disabled][selected])").remove();
            $sel.find("option[disabled][selected]").remove();
            const connected = Object.keys(PROVIDER_LABELS).filter(k => data[k]);
            if (connected.length === 0) {
                $sel.append(`<option value="" disabled selected>${t("fb_groups.ai_no_providers","No AI providers configured")}</option>`);
            } else {
                connected.forEach(k => {
                    $sel.append(`<option value="${k}">${PROVIDER_LABELS[k] || k}</option>`);
                });
                const restore = connected.includes(prev) ? prev : connected[0];
                $sel.val(restore);
                const noModel = NO_MODEL.includes(restore);
                if (DEFAULT_MODELS[restore]) {
                    $model.val(DEFAULT_MODELS[restore]).prop("readonly", true).addClass("fbg-input-locked");
                    $model.closest(".fbg-form-group").show();
                } else if (noModel) {
                    $model.val("").prop("readonly", true).addClass("fbg-input-locked");
                    $model.closest(".fbg-form-group").hide();
                } else {
                    $model.prop("readonly", false).removeClass("fbg-input-locked");
                    $model.closest(".fbg-form-group").show();
                }
            }
        } catch (_) {}
    }

    async function loadNWAiPrompts() {
        try {
            const res = await window.electronAPI.fbGroupsGetAiPrompts();
            window._fbGroupsAiPrompts = (res.success && Array.isArray(res.data)) ? res.data : [];
        } catch (_) { window._fbGroupsAiPrompts = []; }
        // Populate prompt picker
        const $picker = $("#fbgNWAiPromptPicker");
        $picker.find("option:not(:first)").remove();
        (window._fbGroupsAiPrompts || []).forEach(p => {
            $picker.append(`<option value="${p.id}">${escapeHtml(p.name || p.text.slice(0,40))}</option>`);
        });
    }

    function refreshPromptPicker(selectedId) {
        // Legacy shim — now handled by loadNWAiPrompts
        loadNWAiPrompts().catch(() => {});
    }

    async function confirmNewWorkflow() {
        const aiRewriteOn = $("#fbgNWAiRewrite").is(":checked");
        const aiPromptVal = $("#fbgNWAiPrompt").val().trim();
        if (aiRewriteOn && aiPromptVal && !aiPromptVal.includes('{{post_text}}')) {
            if (!confirm(t("fb_groups.ai_prompt_missing_post_text", "Your AI prompt doesn't contain {{post_text}} — the original post won't be passed to the AI. Save anyway?"))) return;
        }

        const delayVal  = parseInt($("#fbgNWDelay").val()) || 30;
        const delayUnit = $("#fbgNWDelayUnit").val();
        const delayMin  = delayUnit === "hours" ? delayVal * 60 : delayVal;

        const settings = {
            status:                  "active",
            delayMinutes:            delayMin,
            scheduleConfig:          readSchedulingConfig("fbgNW"),
            loopWorkflow:            $("#fbgNWLoop").is(":checked"),
            postKeepLines:            Math.max(0, Math.min(10000, Math.floor(Number($("#fbgNWPostKeepLines").val()) || 0))),
            postSuffix:               $("#fbgNWPostSuffix").val().trim(),
            postContentAsComment:     $("#fbgNWPostContentAsComment").is(":checked"),
            postUrlAsComment:        $("#fbgNWUrlComment").is(":checked"),
            urlCommentPrefix:        $("#fbgNWUrlPrefix").val().trim(),
            viralMonitorEnabled:     $("#fbgNWViralEnabled").is(":checked"),
            viralSharesTarget:       parseInt($("#fbgNWViralShares").val()) || 100,
            viralMetric:             $("#fbgNWViralMetric").val() || "shares",
            viralAction:             $("#fbgNWViralAction").val(),
            viralInitialCommentText: $("#fbgNWInitialComment").val().trim(),
            viralEditCommentText:    $("#fbgNWEditCommentText").val().trim(),
            viralAiRewrite:          $("#fbgNWAiRewrite").is(":checked"),
            viralAiProvider:         $("#fbgNWAiProvider").val() || null,
            viralAiModel:            $("#fbgNWAiModel").val().trim() || null,
            viralAiPromptText:       $("#fbgNWAiPrompt").val().trim() || null,
            viralAutomationId:       ($("#fbgNWViralAutoEnabled").is(":checked") && $("#fbgNWViralAutoId").val()) ? $("#fbgNWViralAutoId").val() : null,
            viralEditPostText:       !$("#fbgNWAiRewrite").is(":checked") ? ($("#fbgNWEditPostText").val().trim() || null) : null,
            viralEditPostKeepLines:  (!$("#fbgNWAiRewrite").is(":checked") && $("#fbgNWEditPostKeepLinesEnabled").is(":checked")) ? (parseInt($("#fbgNWEditPostKeepLines").val()) || 0) : null,
        };

        const targets = [];
        $(".fbg-nw-group-cb:checked").each(function() {
            const groupId   = $(this).data("group-id");
            const profileIds = ($(`.fbg-nw-group-profile[data-group-id="${groupId}"]`).val() || []).filter(Boolean);
            targets.push({ groupId, profileIds });
        });

        const $btn = $("#fbgNewWfConfirmBtn").prop("disabled", true);
        try {
            let res;
            if (_newWfType === "automation") {
                const $selectedWf = $(".fbg-nw-picker-item.selected[data-wf-id]");
                if (!$selectedWf.length) { alert(t("fb_groups.select_workflow_first","Please select a workflow first.")); return; }
                const wfId   = $selectedWf.data("wf-id");
                const wfName = $("#fbgNWName").val().trim() || $selectedWf.data("wf-name") || wfId;
                $btn.html(`<span class="material-icons fbg-spin">progress_activity</span>${t("fb_groups.importing","Importing…")}`);
                res = await window.electronAPI.fbGroupsImportWorkflow(wfId, wfName, settings, targets);
                if (!res.success) { alert(`Import failed: ${res.error}`); return; }
            } else {
                const name = $("#fbgNWName").val().trim();
                if (!name) { alert(t("fb_groups.enter_workflow_name","Please enter a workflow name.")); return; }
                const selectedPostIds = Array.from(_nwSelectedIds);
                if (selectedPostIds.length === 0) {
                    alert(t("fb_groups.select_library_post_first","Please select at least one library post before creating a manual workflow."));
                    return;
                }
                $btn.html(`<span class="material-icons fbg-spin">progress_activity</span>${t("fb_groups.creating","Creating…")}`);
                res = await window.electronAPI.fbGroupsCreateManualWorkflow(name, settings, targets);
                if (!res.success) { alert(`Error: ${res.error}`); return; }
                // Assign selected library posts
                if (selectedPostIds.length > 0) {
                    await window.electronAPI.fbGroupsSetWorkflowLibraryPosts(res.data.workflowId, selectedPostIds).catch(() => {});
                }
            }
            closeNewWfModal();
            await loadWorkflows();
            await loadDashboardStats();
            switchPage("workflows");
        } catch (e) {
            alert(`Error: ${e.message}`);
        } finally {
            const isManual = _newWfType === "manual";
            $btn.prop("disabled", false).html(
                isManual
                    ? `<span class="material-icons">check_circle</span>${t("fb_groups.create_workflow","Create Workflow")}`
                    : `<span class="material-icons">add_circle</span>${t("fb_groups.import_confirm","Import & Activate")}`
            );
        }
    }

    // Legacy shims
    function updateImportConfirmBtn() { updateNewWfConfirmBtn(); }
    function updateManualWfCreateBtn() { updateNewWfConfirmBtn(); }
    async function confirmImport() { await confirmNewWorkflow(); }
    async function confirmCreateManualWorkflow() { await confirmNewWorkflow(); }

    // ════════════════════════════════════════════════════
    //  POSTS LIBRARY
    // ════════════════════════════════════════════════════

    // State
    let _libEditingPostId    = null;
    let _libSaving           = false;
    let _libCurrentImagePath = null;

    // Library pagination state
    let _libAllPosts  = [];
    let _libPage      = 1;
    const LIB_PAGE_SIZE = 24;

    // Assign-posts modal state
    let _assignWfId       = null;
    let _assignWfName     = null;

    // Global viral-monitor paused state (mirrors the settings flag)
    let _vmPaused = false;
    let _assignSaving     = false;
    let _assignAllPosts   = [];   // all library posts (loaded once)
    let _assignSelected   = [];   // ordered array of post objects chosen for workflow
    let _assignLibPage    = 1;
    let _assignLibSearch  = "";
    const ASSIGN_PAGE_SIZE = 20;
    let _assignDragIdx    = null; // drag source index in selected list

    async function openAssignPostsModal(wfId, wfName) {
        _assignWfId      = wfId;
        _assignWfName    = wfName;
        _assignSaving    = false;
        _assignLibPage   = 1;
        _assignLibSearch = "";

        $("#fbgAssignPostsTitle").text(t("fb_groups.assign_posts_title", "Manage Posts") + (wfName ? ` — ${wfName}` : ""));
        $("#fbgAssignPostsSaveBtn").prop("disabled", true);
        $("#fbgAssignLibSearch").val("");
        _renderAssignLibList();
        _renderAssignSelectedList();
        $("#fbgAssignPostsBackdrop, #fbgAssignPostsModal").addClass("open");

        const [libRes, assignedRes] = await Promise.all([
            window.electronAPI.fbGroupsGetLibraryPosts().catch(() => null),
            window.electronAPI.fbGroupsGetWorkflowLibraryPosts(wfId).catch(() => null),
        ]);

        _assignAllPosts = Array.isArray(libRes) ? libRes
            : (Array.isArray(libRes?.data) ? libRes.data : []);
        const assignedOrdered = Array.isArray(assignedRes) ? assignedRes
            : (Array.isArray(assignedRes?.data) ? assignedRes.data : []);
        // Keep server order from assigned list, fall back to library objects
        const allMap = new Map(_assignAllPosts.map(p => [p.id, p]));
        _assignSelected = assignedOrdered.map(p => allMap.get(p.id) || p).filter(Boolean);

        $("#fbgAssignPostsSaveBtn").prop("disabled", false);
        _assignLibPage   = 1;
        _assignLibSearch = "";
        $("#fbgAssignLibSearch").val("");
        _renderAssignLibList();
        _renderAssignSelectedList();
    }

    function _assignLibFiltered() {
        const q = _assignLibSearch.toLowerCase();
        const selectedIds = new Set(_assignSelected.map(p => p.id));
        const available = _assignAllPosts.filter(p => !selectedIds.has(p.id));
        if (!q) return available;
        return available.filter(p => (p.text || "").toLowerCase().includes(q) || (p.url || "").toLowerCase().includes(q));
    }

    function _renderAssignLibList() {
        const $list   = $("#fbgAssignLibList");
        const $empty  = $("#fbgAssignLibEmpty");
        if (!$list.length) return;

        const filtered   = _assignLibFiltered();
        const totalPages = Math.max(1, Math.ceil(filtered.length / ASSIGN_PAGE_SIZE));
        if (_assignLibPage > totalPages) _assignLibPage = totalPages;
        const start = (_assignLibPage - 1) * ASSIGN_PAGE_SIZE;
        const page  = filtered.slice(start, start + ASSIGN_PAGE_SIZE);

        $list.find(".fbg-asgn-lib-item, .fbg-asgn-no-results").remove();
        $("#fbgAssignLibPagination").remove();

        if (!_assignAllPosts.length) {
            $empty.show();
            return;
        }
        $empty.hide();

        if (!page.length && _assignLibSearch) {
            $list.append(`<div class="fbg-asgn-no-results"><span class="material-icons">search_off</span><span>No results for "${escapeHtml(_assignLibSearch)}"</span></div>`);
            return;
        }
        if (!page.length) {
            // All library posts are already in the workflow
            $list.append(`<div class="fbg-asgn-no-results" style="flex-direction:column;align-items:center;gap:6px;padding:24px 10px;">
                <span class="material-icons" style="font-size:32px;color:var(--accent-color,#0d6efd);">playlist_add_check</span>
                <span style="text-align:center;">${t("fb_groups.all_posts_added", "All library posts are in this workflow")}</span>
            </div>`);
            return;
        }

        $list.append(page.map(p => {
            const thumb = p.imagePath
                ? `<img src="file://${p.imagePath.replace(/\\/g, '/')}" onerror="this.style.display='none'">`
                : `<span class="material-icons" style="font-size:18px;color:var(--text-secondary)">image_not_supported</span>`;
            return `<div class="fbg-asgn-lib-item" data-post-id="${p.id}">
                <div class="fbg-asgn-thumb">${thumb}</div>
                <div class="fbg-asgn-text">${escapeHtml((p.text || "(no text)").slice(0, 120))}</div>
                <button class="fbg-asgn-add-btn" data-post-id="${p.id}" title="Add to workflow"><span class="material-icons">add_circle</span></button>
            </div>`;
        }).join(""));

        // Pagination
        if (totalPages > 1) {
            const from = start + 1, to = Math.min(start + ASSIGN_PAGE_SIZE, filtered.length);
            let btnHtml = "";
            for (const pg of _buildPageRange(_assignLibPage, totalPages)) {
                if (pg === "...") btnHtml += `<span class="fbg-page-ellipsis">…</span>`;
                else btnHtml += `<button class="fbg-page-btn${pg === _assignLibPage ? " active" : ""}" data-apage="${pg}">${pg}</button>`;
            }
            $("#fbgAssignLibPanel").append(`<div id="fbgAssignLibPagination" class="fbg-asgn-pagination">
                <span class="fbg-page-info">${from}–${to} / ${filtered.length}</span>
                <div class="fbg-page-btns">
                    <button class="fbg-page-nav" id="fbgAssignLibPrev" ${_assignLibPage <= 1 ? "disabled" : ""}><span class="material-icons">chevron_left</span></button>
                    ${btnHtml}
                    <button class="fbg-page-nav" id="fbgAssignLibNext" ${_assignLibPage >= totalPages ? "disabled" : ""}><span class="material-icons">chevron_right</span></button>
                </div>
            </div>`);
        }
    }

    function _renderAssignSelectedList() {
        const $list  = $("#fbgAssignSelList");
        const $empty = $("#fbgAssignSelEmpty");
        if (!$list.length) return;
        $("#fbgAssignPostsCount").text(_assignSelected.length
            ? t("fb_groups.n_selected", "{{n}} selected").replace("{{n}}", _assignSelected.length)
            : "");
        if (!_assignSelected.length) {
            $list.empty();
            $empty.show();
            return;
        }
        $empty.hide();
        $list.html(_assignSelected.map((p, i) => {
            const thumb = p.imagePath
                ? `<img src="file://${p.imagePath.replace(/\\/g, '/')}" onerror="this.style.display='none'">`
                : `<span class="material-icons" style="font-size:16px;color:var(--text-secondary)">image_not_supported</span>`;
            return `<div class="fbg-asgn-sel-item" draggable="true" data-sel-idx="${i}">
                <span class="fbg-asgn-drag-handle material-icons">drag_indicator</span>
                <span class="fbg-asgn-sel-num">${i + 1}</span>
                <div class="fbg-asgn-thumb">${thumb}</div>
                <div class="fbg-asgn-text">${escapeHtml((p.text || "(no text)").slice(0, 100))}</div>
                <button class="fbg-asgn-remove-btn" data-sel-idx="${i}" title="Remove"><span class="material-icons">remove_circle_outline</span></button>
            </div>`;
        }).join(""));
    }

    function closeAssignPostsModal() {
        $("#fbgAssignPostsBackdrop, #fbgAssignPostsModal").removeClass("open");
        _assignWfId      = null;
        _assignWfName    = null;
        _assignSaving    = false;
        _assignAllPosts  = [];
        _assignSelected  = [];
        _assignDragIdx   = null;
    }

    async function saveAssignPosts() {
        if (_assignSaving || !_assignWfId) return;
        _assignSaving = true;
        const $btn = $("#fbgAssignPostsSaveBtn");
        $btn.prop("disabled", true);
        try {
            const postIds = _assignSelected.map(p => p.id);
            await window.electronAPI.fbGroupsSetWorkflowLibraryPosts(_assignWfId, postIds);
            closeAssignPostsModal();
            await loadWorkflows();
        } catch (e) {
            console.error("[fbGroups] saveAssignPosts error:", e);
        } finally {
            _assignSaving = false;
            $btn.prop("disabled", false);
        }
    }

    async function loadLibraryPosts() {
        const res = await window.electronAPI.fbGroupsGetLibraryPosts().catch(() => null);
        _libAllPosts = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
        _libPage = 1;
        renderLibraryPosts();
    }

    function renderLibraryPosts() {
        const query = (($("#fbgLibSearch").val() || "").trim()).toLowerCase();
        const filtered = query
            ? _libAllPosts.filter(p => (p.text || "").toLowerCase().includes(query) || (p.url || "").toLowerCase().includes(query))
            : _libAllPosts.slice();

        const totalPages = Math.max(1, Math.ceil(filtered.length / LIB_PAGE_SIZE));
        if (_libPage > totalPages) _libPage = totalPages;

        const startIdx  = (_libPage - 1) * LIB_PAGE_SIZE;
        const pagePosts = filtered.slice(startIdx, startIdx + LIB_PAGE_SIZE);

        const $grid  = $("#fbgLibraryGrid");
        const $empty = $("#fbgLibraryEmpty");
        if (!$grid.length) return;

        $grid.find(".fbg-lib-card, .fbg-lib-pagination").remove();

        if (!filtered.length) {
            $empty.show();
            return;
        }
        $empty.hide();

        $grid.append(pagePosts.map(p => {
            const imgSrc = p.imagePath ? `file://${p.imagePath.replace(/\\/g, "/")}` : "";
            const imgHtml = imgSrc
                ? `<div class="fbg-lib-thumb"><img src="${imgSrc}" alt="" onerror="this.parentNode.style.display='none'"></div>`
                : `<div class="fbg-lib-thumb"><span class="material-icons">image</span></div>`;
            const urlHtml = p.url ? `<div class="fbg-lib-url"><span class="material-icons" style="font-size:13px;vertical-align:middle;">link</span> ${escapeHtml(p.url)}</div>` : "";
            return `
            <div class="fbg-lib-card" data-post-id="${p.id}">
                ${imgHtml}
                <div class="fbg-lib-body">
                    <p class="fbg-lib-text">${escapeHtml(p.text || "")}</p>
                    ${urlHtml}
                </div>
                <div class="fbg-lib-actions">
                    <button class="fbg-btn-icon fbg-lib-edit-btn" data-post-id="${p.id}" title="${t("fb_groups.edit","Edit")}"><span class="material-icons">edit</span></button>
                    <button class="fbg-btn-icon fbg-lib-delete-btn" data-post-id="${p.id}" title="${t("fb_groups.delete","Delete")}"><span class="material-icons">delete</span></button>
                </div>
            </div>`;
        }).join(""));

        // ── Pagination bar ──────────────────────────────────────
        if (totalPages > 1) {
            const from = startIdx + 1;
            const to   = Math.min(startIdx + LIB_PAGE_SIZE, filtered.length);
            let pagesBtns = "";
            const range = _buildPageRange(_libPage, totalPages);
            for (const pg of range) {
                if (pg === "...") {
                    pagesBtns += `<span class="fbg-page-ellipsis">…</span>`;
                } else {
                    pagesBtns += `<button class="fbg-page-btn${pg === _libPage ? " active" : ""}" data-page="${pg}">${pg}</button>`;
                }
            }
            $grid.append(`
            <div class="fbg-lib-pagination" style="grid-column:1/-1;">
                <span class="fbg-page-info">${from}–${to} of ${filtered.length}</span>
                <div class="fbg-page-btns">
                    <button class="fbg-page-nav" id="fbgLibPrevPage" ${_libPage <= 1 ? "disabled" : ""}>
                        <span class="material-icons">chevron_left</span>
                    </button>
                    ${pagesBtns}
                    <button class="fbg-page-nav" id="fbgLibNextPage" ${_libPage >= totalPages ? "disabled" : ""}>
                        <span class="material-icons">chevron_right</span>
                    </button>
                </div>
            </div>`);
        }
    }

    /** Returns page numbers/ellipsis for a compact pagination range */
    function _buildPageRange(current, total) {
        if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
        const pages = [1];
        if (current > 3) pages.push("...");
        for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) pages.push(p);
        if (current < total - 2) pages.push("...");
        pages.push(total);
        return pages;
    }

    function openLibraryPostModal(isEdit, post = null) {
        _libEditingPostId    = isEdit ? post.id : null;
        _libCurrentImagePath = isEdit ? (post.imagePath || null) : null;
        _libSaving           = false;

        $("#fbgLibPostModalTitle").text(isEdit ? t("fb_groups.edit_post", "Edit Post") : t("fb_groups.add_post", "Add Post"));
        $("#fbgLibPostText").val(isEdit ? (post.text || "") : "");
        $("#fbgLibPostUrl").val(isEdit ? (post.url || "") : "");
        $("#fbgLibPostImgUrl").val("");

        const $preview = $("#fbgLibPostImgPreview");
        const $clearBtn = $("#fbgLibPostClearImgBtn");
        if (_libCurrentImagePath) {
            $preview.html(`<img src="file://${_libCurrentImagePath.replace(/\\/g, "/")}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;">`);
            $clearBtn.show();
        } else {
            $preview.html(`<span class="material-icons" style="font-size:28px;color:var(--text-secondary);">image</span>`);
            $clearBtn.hide();
        }

        $("#fbgLibPostSaveBtn").text(isEdit ? t("fb_groups.save_changes", "Save Changes") : t("fb_groups.add_post", "Add Post"));
        $("#fbgLibPostBackdrop, #fbgLibPostModal").addClass("open");
        setTimeout(() => $("#fbgLibPostText").trigger("focus"), 120);
    }

    function closeLibraryPostModal() {
        $("#fbgLibPostBackdrop, #fbgLibPostModal").removeClass("open");
        _libEditingPostId    = null;
        _libCurrentImagePath = null;
        _libSaving           = false;
    }

    async function saveLibraryPost() {
        if (_libSaving) return;
        const text  = $("#fbgLibPostText").val().trim();
        const url   = $("#fbgLibPostUrl").val().trim();
        const imgUrl = $("#fbgLibPostImgUrl").val().trim();
        if (!text) { $("#fbgLibPostText").trigger("focus"); return; }

        _libSaving = true;
        $("#fbgLibPostSaveBtn").prop("disabled", true);

        // Resolve image: local path takes priority, then pasted URL (backend downloads it)
        const resolvedImagePath = _libCurrentImagePath || imgUrl || null;

        try {
            let res;
            if (_libEditingPostId) {
                res = await window.electronAPI.fbGroupsUpdateLibraryPost(
                    _libEditingPostId, text, text, resolvedImagePath, url || null
                ).catch(() => null);
            } else {
                res = await window.electronAPI.fbGroupsAddLibraryPost(
                    text, text, resolvedImagePath, url || null
                ).catch(() => null);
            }
            if (res?.success) {
                closeLibraryPostModal();
                await loadLibraryPosts();
            } else {
                console.error("[fbGroups] saveLibraryPost failed:", res?.error);
            }
        } finally {
            _libSaving = false;
            $("#fbgLibPostSaveBtn").prop("disabled", false);
        }
    }

    // ── CSV Import ────────────────────────────────────────────────────────────

    const EXAMPLE_CSV = `text,image_url,url\n"Check out this amazing deal!","https://example.com/image.jpg","https://example.com/deal"\n"Another great post","","https://example.com"`;

    let _csvParsedRows = [];

    function openCsvImportModal() {
        _csvParsedRows = [];
        $("#fbgCsvFileInput").val("");
        $("#fbgCsvDropzone").html(`<span class="material-icons" style="font-size:32px;color:var(--text-secondary);">upload_file</span><span>${t("fb_groups.csv_drop_hint","Drop a CSV file here or click to browse")}</span>`);
        $("#fbgCsvPreview").hide().html("");
        $("#fbgCsvImportStartBtn").prop("disabled", true);
        $("#fbgCsvImportBackdrop, #fbgCsvImportModal").addClass("open");
    }

    function closeCsvImportModal() {
        $("#fbgCsvImportBackdrop, #fbgCsvImportModal").removeClass("open");
        _csvParsedRows = [];
    }

    function parseCsvText(text) {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) return [];
        const header = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim().toLowerCase());
        const textIdx = header.indexOf("text");
        const imgIdx  = header.indexOf("image_url");
        const urlIdx  = header.indexOf("url");
        if (textIdx === -1) return [];
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            // naive CSV split — handles double-quoted fields
            const cols = lines[i].match(/("(?:[^"]|"")*"|[^,]*)/g).map(c => c.replace(/^"|"$/g, "").replace(/""/g, '"').trim());
            const t2 = cols[textIdx] || "";
            if (!t2) continue;
            rows.push({ text: t2, imageUrl: imgIdx >= 0 ? (cols[imgIdx] || "") : "", url: urlIdx >= 0 ? (cols[urlIdx] || "") : "" });
        }
        return rows;
    }

    function renderCsvPreview(rows) {
        const $preview = $("#fbgCsvPreview");
        if (!rows.length) { $preview.hide(); return; }
        const html = `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${rows.length} ${t("fb_groups.csv_rows_found","rows found")}</div>
        <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border-color);border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="background:var(--bg-secondary);">
                <th style="padding:5px 8px;text-align:left;">Text</th>
                <th style="padding:5px 8px;text-align:left;">Image URL</th>
                <th style="padding:5px 8px;text-align:left;">URL</th>
            </tr></thead>
            <tbody>${rows.slice(0, 20).map(r => `<tr style="border-top:1px solid var(--border-color);">
                <td style="padding:4px 8px;">${escapeHtml((r.text || "").slice(0, 60))}${r.text.length > 60 ? "…" : ""}</td>
                <td style="padding:4px 8px;">${escapeHtml((r.imageUrl || "").slice(0, 40))}${(r.imageUrl || "").length > 40 ? "…" : ""}</td>
                <td style="padding:4px 8px;">${escapeHtml((r.url || "").slice(0, 40))}${(r.url || "").length > 40 ? "…" : ""}</td>
            </tr>`).join("")}${rows.length > 20 ? `<tr><td colspan="3" style="padding:4px 8px;color:var(--text-secondary);">… and ${rows.length - 20} more</td></tr>` : ""}</tbody>
        </table></div>`;
        $preview.show().html(html);
    }

    async function runCsvImport() {
        if (!_csvParsedRows.length) return;
        const $btn = $("#fbgCsvImportStartBtn");
        $btn.prop("disabled", true).text(t("fb_groups.importing","Importing…"));
        let imported = 0;
        for (const row of _csvParsedRows) {
            const imageArg = row.imageUrl || null; // backend downloads URL to local path
            const res = await window.electronAPI.fbGroupsAddLibraryPost(
                row.text, row.text, imageArg, row.url || null
            ).catch(() => null);
            if (res?.success) imported++;
        }
        $btn.text(`${imported} ${t("fb_groups.imported","imported")}`);
        setTimeout(async () => {
            closeCsvImportModal();
            await loadLibraryPosts();
        }, 800);
    }

    // ════════════════════════════════════════════════════
    //  LIVE LOGS
    // ════════════════════════════════════════════════════

    function initLiveLogs() {
        // Global manager already owns the IPC listeners and the liveLogEntries buffer.
        // We just register page-scope callbacks so events update the DOM while we're here.
        if (window.fbGroupsManager) {
            window.fbGroupsManager.setPageCallbacks({
                onLog(entry) {
                    if (currentNavPage === "logs") appendLogEntry(entry);
                    // Badge counter for in-page navigation
                    const badge = parseInt($("#fbgLogBadge").text() || "0") + 1;
                    if (currentNavPage !== "logs") {
                        $("#fbgLogBadge").show().text(badge);
                    }
                },
                onViralAlert() {
                    if (currentNavPage === "dashboard") loadDashboardStats();
                    if (currentNavPage === "posts") loadPostsFeed();
                },
                onPostSent() {
                    if (currentNavPage === "dashboard") loadDashboardStats();
                    if (currentNavPage === "posts") {
                        // Delay first refresh — viral monitor is created after the post,
                        // so an immediate reload would show the card without monitor data.
                        setTimeout(() => loadPostsFeed(), 2000);
                        // Second refresh catches the monitor if it took a bit longer
                        setTimeout(() => loadPostsFeed(), 5000);
                    }
                },
                onWorkflowCompleted() {
                    loadWorkflows();
                    if (currentNavPage === "dashboard") loadDashboardStats();
                },
                onMonitorsExpired() {
                    // Posts surpassed the "stop monitoring after" window and were
                    // expired in the background (even while monitoring is paused).
                    // Refresh so they drop out of the monitoring view immediately.
                    if (currentNavPage === "posts") loadPostsFeed();
                    if (currentNavPage === "dashboard") loadDashboardStats();
                },
                onProfileActivity(data) {
                    if (currentNavPage === "profiles") updateProfileActivityLive(data);
                },
                onProfileFlagged(data) {
                    if (!data || !data.profileId) return;
                    const p = allProfiles.find(x => x.profileId === data.profileId);
                    if (p) {
                        if (data.loggedIn) {
                            // User cleared the flag — restore to "not scanned" / ok state
                            p.loggedIn      = 1;
                            p.scanError     = null;
                            p.lastScannedAt = data.timestamp || new Date().toISOString();
                            p.activity      = { profileId: data.profileId, status: "idle", detail: "" };
                        } else {
                            // Scheduler flagged this profile as disconnected
                            p.loggedIn      = 0;
                            p.scanError     = data.error || "Session expired";
                            p.lastScannedAt = data.timestamp || new Date().toISOString();
                            p.activity      = { profileId: data.profileId, status: "disconnected", detail: data.error || "Session expired" };
                        }
                    }
                    // Re-render the card live (works on any nav page, not just profiles)
                    const sel = (window.CSS && CSS.escape) ? CSS.escape(data.profileId) : data.profileId;
                    const $card = $(`.fbg-profile-card[data-profile-id="${sel}"]`);
                    if ($card.length && p) $card.replaceWith(buildProfileCardHtml(p));
                },
                onGroupScanned(data) {
                    if (!data || !data.groupId) return;
                    // Patch the in-memory cache + re-render the card live.
                    if (data.info) applyScannedInfoToGrid(data.groupId, data.info);
                    else if (currentNavPage === "groups") loadData();
                    // If the detail panel is open for this group, refresh it — but
                    // not while a manual scan result box is shown (would wipe it).
                    if (currentGroupId === data.groupId && !$("#fbgScanInfoResult").length) {
                        openDetailPanel(data.groupId);
                    }
                },
                onProfileScanned(data) {
                    if (!data || !data.profileId) return;
                    const scan = data.scan || {};
                    const sel = (window.CSS && CSS.escape) ? CSS.escape(data.profileId) : data.profileId;

                    // 1) Detail-panel chip (group view)
                    const $chip = $(`.profile-chip[data-profile="${sel}"]`);
                    if ($chip.length) {
                        const patched = {
                            profileId: data.profileId,
                            profileLabel: scan.profileLabel || "",
                            structureId: $chip.find(".profile-chip-structure").attr("title") || "",
                            structureLabel: "",
                            loggedIn: scan.loggedIn != null ? scan.loggedIn : 0,
                            scanInfo: scan.scanInfo || null,
                            lastScannedAt: scan.lastScannedAt || new Date().toISOString(),
                            scanError: scan.scanError || null,
                        };
                        const idx = $chip.index();
                        $chip.replaceWith(buildProfileChip(patched, idx >= 0 ? idx : 0));
                    }

                    // 2) Profiles-page card — patch the in-memory profile + re-render
                    const p = (typeof allProfiles !== "undefined" && allProfiles)
                        ? allProfiles.find(x => x.profileId === data.profileId) : null;
                    if (p) {
                        p.loggedIn      = scan.loggedIn != null ? scan.loggedIn : 0;
                        p.scanInfo      = scan.scanInfo || null;
                        p.scanError     = scan.scanError || null;
                        p.lastScannedAt = scan.lastScannedAt || new Date().toISOString();
                        // A confirmed login clears a stale "disconnected" status pill.
                        const isLoggedIn = p.loggedIn === 1 || p.loggedIn === true;
                        if (isLoggedIn && p.activity && p.activity.status === "disconnected") {
                            p.activity = { profileId: data.profileId, status: "idle", detail: "" };
                        }
                        const $card = $(`.fbg-profile-card[data-profile-id="${sel}"]`);
                        if ($card.length) $card.replaceWith(buildProfileCardHtml(p));
                    }
                }
            });
        }
        // Render any already-buffered log entries immediately
        if (currentNavPage === "logs") renderLiveLogs();
    }

    function renderLiveLogs() {
        const $c = $("#fbgLiveLogContainer");
        const entries = (window.fbGroupsManager && window.fbGroupsManager.liveLogEntries) || [];
        const filtered = entries.filter(e => liveLogFilter === "all" || e.level === liveLogFilter);
        if (!filtered.length) {
            $c.html(`<div class="fbg-log-empty-state" id="fbgLiveLogEmptyState">
                <span class="material-icons">receipt_long</span>
                <p>${t("fb_groups.logs_empty","No logs yet. Start a workflow to see activity here.")}</p>
            </div>`);
            return;
        }
        // Newest first
        $c.html([...filtered].reverse().map(e => buildLogEntryHtml(e)).join(""));
    }

    function appendLogEntry(entry) {
        if (liveLogFilter !== "all" && entry.level !== liveLogFilter) return;
        $("#fbgLiveLogEmptyState").remove();
        const $c  = $("#fbgLiveLogContainer");
        const $el = $(buildLogEntryHtml(entry));
        $c.prepend($el);
        // Evict oldest (now at bottom) if over limit
        const $entries = $c.find(".fbg-log-entry");
        if ($entries.length > MAX_LIVE_LOG_DOM) $entries.last().remove();
        // Clear badge when logs page is open
        if (currentNavPage === "logs") $("#fbgLogBadge").hide().text("0");
    }

    function buildLogEntryHtml(entry) {
        const cls     = `fbg-log-entry--${entry.level || "info"}`;
        const icon    = entry.level === "success" ? "check_circle" :
                        entry.level === "error"   ? "error" :
                        entry.level === "viral"   ? "local_fire_department" : "info";
        const time    = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString(undefined, {hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "";
        const msg     = escapeHtml(entry.message || "");
        const wfChip  = entry.workflowName ? `<span class="fbg-chip-small">${escapeHtml(entry.workflowName)}</span>` : "";
        const grpChip = entry.groupId      ? `<span class="fbg-chip-small">${escapeHtml(entry.groupId)}</span>` : "";
        return `<div class="fbg-log-entry ${cls}">
            <span class="fbg-log-time">${time}</span>
            <span class="fbg-log-icon material-icons">${icon}</span>
            <div class="fbg-log-msg">${msg}${(wfChip || grpChip) ? `<div class="fbg-log-chips">${wfChip}${grpChip}</div>` : ""}</div>
        </div>`;
    }

    // ════════════════════════════════════════════════════
    //  ANALYTICS
    // ════════════════════════════════════════════════════

    async function loadAnalytics() {
        try {
            const res = await window.electronAPI.fbGroupsGetAnalytics(analyticsRangeDays);
            if (!res.success || !res.data) return;
            const { postsByDay, topGroups, topWorkflows, viralStats } = res.data;
            renderPostsChart(postsByDay);
            renderTopGroupsTable(topGroups || []);
            renderViralTable(viralStats);
            renderWorkflowPerfTable(topWorkflows || []);
        } catch (e) {
            console.error("[fbGroups] loadAnalytics error:", e);
        }
    }

    function renderPostsChart(data) {
        const $c = $("#fbgChartPostsOverTime");
        if (!data || !data.length) {
            $c.html(`<div class="fbg-chart-empty">${t("fb_groups.no_data","No data yet")}</div>`);
            return;
        }
        const maxTotal = Math.max(...data.map(d => (d.success || 0) + (d.failed || 0)), 1);
        const chartH   = 120; // px height for bars
        const html = data.map(d => {
            const total   = (d.success || 0) + (d.failed || 0);
            const successH = Math.round(((d.success || 0) / maxTotal) * chartH);
            const failedH  = Math.round(((d.failed || 0)  / maxTotal) * chartH);
            const label    = (d.day || "").slice(5); // MM-DD
            return `<div class="fbg-chart-bar-wrap" title="${label}: ${d.success||0} sent, ${d.failed||0} failed">
                <div class="fbg-chart-bar-stack" style="height:${successH + failedH}px;">
                    <div class="fbg-chart-bar-success" style="height:${successH}px;"></div>
                    <div class="fbg-chart-bar-failed"  style="height:${failedH}px;"></div>
                </div>
                <div class="fbg-chart-day-label">${label}</div>
            </div>`;
        }).join("");
        $c.html(html);
    }

    function renderTopGroupsTable(groups) {
        const $tb = $("#fbgTopGroupsTable tbody");
        if (!groups.length) { $tb.html(`<tr><td colspan="3" class="fbg-table-empty">${t("fb_groups.no_data","No data yet")}</td></tr>`); return; }
        $tb.html(groups.map(g => {
            const rate = g.totalPosts > 0 ? Math.round((g.sentPosts / g.totalPosts) * 100) : 0;
            return `<tr><td>${escapeHtml(g.groupName || g.groupId)}</td><td>${g.sentPosts||0}</td><td>${rate}%</td></tr>`;
        }).join(""));
    }

    function renderViralTable(stats) {
        const $tb = $("#fbgViralTable tbody");
        if (!stats) { $tb.html(`<tr><td colspan="3" class="fbg-table-empty">${t("fb_groups.no_data","No data yet")}</td></tr>`); return; }
        const avgShares = stats.avgSharesAtTrigger ? Math.round(stats.avgSharesAtTrigger) : "—";
        $tb.html(`<tr><td>${stats.total||0}</td><td>${stats.triggered||0}</td><td>${avgShares}</td></tr>`);
    }

    function renderWorkflowPerfTable(workflows) {
        const $tb = $("#fbgWfPerfTable tbody");
        if (!workflows.length) { $tb.html(`<tr><td colspan="3" class="fbg-table-empty">${t("fb_groups.no_data","No data yet")}</td></tr>`); return; }
        $tb.html(workflows.map(wf => {
            const rate = wf.totalPosts > 0 ? Math.round((wf.sentPosts / wf.totalPosts) * 100) : 0;
            return `<tr><td>${escapeHtml(wf.workflowName || wf.workflowId)}</td><td>${wf.sentPosts||0}</td><td>${rate}%</td></tr>`;
        }).join(""));
    }

    // ════════════════════════════════════════════════════
    //  GROUP SETTINGS
    // ════════════════════════════════════════════════════

    async function loadGroupSettings() {
        try {
            const res = await window.electronAPI.fbGroupsGetSettings();
            const s = (res.success && res.data) ? res.data : {};
            $("#fbgCommentDelayMin").val(s.commentDelayMin ?? 60);
            $("#fbgCommentDelayMax").val(s.commentDelayMax ?? 180);
            $("#fbgDailyCapInput").val(s.dailyPostingCap ?? 8);
            $("#fbgMinProfileGapMin").val(s.minProfileGapMin ?? 30);
            $("#fbgMinProfileGapMax").val(s.minProfileGapMax ?? 90);
            $("#fbgWarmupEnabled").prop("checked", s.warmupEnabled !== false);
            $("#fbgContentVariationEnabled").prop("checked", s.contentVariationEnabled !== false);
            $("#fbgHumanMode").prop("checked", s.humanMode !== false);
            $("#fbgHumanModeWatch").prop("checked", s.humanModeWatch === true);
            $("#fbgViralExpiryHours").val(s.viralExpiryHours ?? 48);
            $("#fbgViralCheckMin").val(s.viralCheckIntervalMin ?? 30);
            $("#fbgAutoScanEnabled").prop("checked", s.autoScanEnabled !== false);
            $("#fbgAutoScanIntervalHours").val(s.autoScanIntervalHours ?? 24);
            _setViralMonitorPausedUI(!!s.viralMonitoringPaused);
        } catch (e) {
            console.error("[fbGroups] loadGroupSettings error:", e);
        }
        // Hide the diagnostics card in production builds
        try {
            const devMode = await window.electronAPI.isDev();
            $("#fbgTestDocIdsBtn").closest(".fbg-settings-card").toggle(!!devMode);
        } catch (_) {}
    }

    function _setViralMonitorPausedUI(paused) {
        _vmPaused = !!paused;
        // Settings page controls
        const $btn = $("#fbgViralMonitorToggleBtn");
        const $icon = $("#fbgViralMonitorToggleIcon");
        const $label = $("#fbgViralMonitorToggleLabel");
        const $banner = $("#fbgViralMonitorPausedBanner");
        // Posts page controls
        const $btn2 = $("#fbgPostsVmToggleBtn");
        const $icon2 = $("#fbgPostsVmToggleIcon");
        const $label2 = $("#fbgPostsVmToggleLabel");
        const $banner2 = $("#fbgPostsVmPausedBanner");
        if (paused) {
            $icon.text("play_circle");  $icon2.text("play_circle");
            $label.attr("data-i18n", "fb_groups.viral_monitor_resume").text(t("fb_groups.viral_monitor_resume", "Resume monitoring"));
            $label2.attr("data-i18n", "fb_groups.viral_monitor_resume").text(t("fb_groups.viral_monitor_resume", "Resume monitoring"));
            $btn.addClass("fbg-vm-toggle-paused");  $btn2.addClass("fbg-vm-toggle-paused");
            $banner.show();  $banner2.show();
            // Re-render the posts table so every row reflects the paused state.
            if (currentNavPage === "posts") loadPostsFeed();
        } else {
            $icon.text("pause_circle");  $icon2.text("pause_circle");
            $label.attr("data-i18n", "fb_groups.viral_monitor_pause").text(t("fb_groups.viral_monitor_pause", "Pause monitoring"));
            $label2.attr("data-i18n", "fb_groups.viral_monitor_pause").text(t("fb_groups.viral_monitor_pause", "Pause monitoring"));
            $btn.removeClass("fbg-vm-toggle-paused");  $btn2.removeClass("fbg-vm-toggle-paused");
            $banner.hide();  $banner2.hide();
            // Clear any stale auto-trigger guards and reload so cards show fresh
            // next-check countdowns again.
            _autoTriggeredStories.clear();
            if (currentNavPage === "posts") loadPostsFeed();
        }
    }

    // Diagnostics: gather all Facebook doc IDs and show a ✓/✗ report.
    async function testDocIds() {
        const $btn = $("#fbgTestDocIdsBtn");
        const $out = $("#fbgDocIdsResult");
        const orig = $btn.html();
        $btn.prop("disabled", true).html(`<span class="material-icons fbg-spin">progress_activity</span><span>${t("fb_groups.docids_testing","Gathering…")}</span>`);
        $out.show().html(`<div class="fbg-docids-loading">${t("fb_groups.docids_testing_hint","Opening a profile in the background and browsing Facebook — this can take up to a minute.")}</div>`);
        try {
            const res = await window.electronAPI.fbGroupsTestDocIds();
            if (!res || !res.success) {
                $out.html(`<div class="fbg-docids-error"><span class="material-icons">error</span>${escapeHtml((res && res.error) || t("fb_groups.docids_failed","Failed to gather doc IDs"))}</div>`);
                return;
            }
            const rows = (res.results || []).map(r => `
                <div class="fbg-docid-row ${r.gathered ? "ok" : (r.onDemand ? "ondemand" : "miss")}">
                    <span class="material-icons">${r.gathered ? "check_circle" : (r.onDemand ? "schedule" : "cancel")}</span>
                    <span class="fbg-docid-name">${escapeHtml(r.name)}</span>
                    <span class="fbg-docid-val">${r.onDemand && !r.gathered ? t("fb_groups.docids_ondemand","Captured on demand") : escapeHtml(r.docId || "—")}</span>
                </div>`).join("");
            const allOk = (res.results || []).every(r => r.gathered || r.onDemand);
            const summary = (t("fb_groups.docids_summary", "Gathered {{found}} of {{total}} query IDs") || "")
                .replace("{{found}}", res.foundCount).replace("{{total}}", res.total);
            $out.html(`
                <div class="fbg-docids-summary ${allOk ? "ok" : "warn"}">
                    <span class="material-icons">${allOk ? "verified" : "warning"}</span>
                    <span>${escapeHtml(summary)}</span>
                    <span class="fbg-docids-profile">${escapeHtml(res.profileLabel || "")}</span>
                </div>
                <div class="fbg-docids-list">${rows}</div>`);
        } catch (e) {
            console.error("[fbGroups] testDocIds error:", e);
            $out.html(`<div class="fbg-docids-error"><span class="material-icons">error</span>${escapeHtml(e.message || "Error")}</div>`);
        } finally {
            $btn.prop("disabled", false).html(orig);
        }
    }

    async function saveGroupSettings() {
        let minSec = parseInt($("#fbgCommentDelayMin").val());
        let maxSec = parseInt($("#fbgCommentDelayMax").val());
        if (!Number.isFinite(minSec) || minSec < 0) minSec = 60;
        if (!Number.isFinite(maxSec) || maxSec < 0) maxSec = 180;
        const cap    = parseInt($("#fbgDailyCapInput").val())   || 0;
        let gapMin = parseInt($("#fbgMinProfileGapMin").val());
        let gapMax = parseInt($("#fbgMinProfileGapMax").val());
        if (isNaN(gapMin) || gapMin < 0) gapMin = 0;
        if (isNaN(gapMax) || gapMax < 0) gapMax = 0;
        if (gapMax < gapMin) gapMax = gapMin;
        const warmupEnabled = $("#fbgWarmupEnabled").is(":checked");
        const contentVariationEnabled = $("#fbgContentVariationEnabled").is(":checked");
        const humanMode = $("#fbgHumanMode").is(":checked");
        const humanModeWatch = $("#fbgHumanModeWatch").is(":checked");
        let viralExpiryHours      = parseInt($("#fbgViralExpiryHours").val()) || 48;
        let viralCheckIntervalMin = parseInt($("#fbgViralCheckMin").val())   || 30;
        if (viralExpiryHours < 1) viralExpiryHours = 1;
        if (viralCheckIntervalMin < 1) viralCheckIntervalMin = 1;
        let autoScanIntervalHours = parseInt($("#fbgAutoScanIntervalHours").val()) || 24;
        if (autoScanIntervalHours < 1) autoScanIntervalHours = 1;
        const autoScanEnabled = $("#fbgAutoScanEnabled").is(":checked");
        // Both 0 = immediate (valid). Otherwise min must be <= max.
        if ((minSec > 0 || maxSec > 0) && minSec > maxSec) {
            alert(t("fb_groups.comment_delay_min_gt_max", "Minimum delay cannot be greater than maximum."));
            return;
        }
        try {
            const res = await window.electronAPI.fbGroupsSaveSettings({
                commentDelayMin: minSec,
                commentDelayMax: maxSec,
                dailyPostingCap: cap,
                minProfileGapMin: gapMin,
                minProfileGapMax: gapMax,
                warmupEnabled: warmupEnabled,
                contentVariationEnabled: contentVariationEnabled,
                humanMode: humanMode,
                humanModeWatch: humanModeWatch,
                viralExpiryHours: viralExpiryHours,
                viralCheckIntervalMin: viralCheckIntervalMin,
                autoScanEnabled: autoScanEnabled,
                autoScanIntervalHours: autoScanIntervalHours,
            });
            if (res.success) {
                const $btn = $("#fbgSaveGroupSettings");
                const origHtml = $btn.html();
                $btn.html(`<span class="material-icons">check</span><span>${t("fb_groups.saved", "Saved!")}</span>`);
                setTimeout(() => $btn.html(origHtml), 2000);
            }
        } catch (e) {
            console.error("[fbGroups] saveGroupSettings error:", e);
        }
    }

    // ════════════════════════════════════════════════════
    //  PROFILES
    // ════════════════════════════════════════════════════

    const PROFILE_STATUS_META = {
        posting:      { i18n: "fb_groups.profile_status_posting",      fallback: "Posting…",       cls: "posting" },
        commenting:   { i18n: "fb_groups.profile_status_commenting",   fallback: "Commenting…",    cls: "commenting" },
        viral_check:  { i18n: "fb_groups.profile_status_viral",        fallback: "Checking viral", cls: "viral" },
        viral_edit:   { i18n: "fb_groups.profile_status_viral",        fallback: "Checking viral", cls: "viral" },
        disconnected: { i18n: "fb_groups.profile_status_disconnected", fallback: "Disconnected",   cls: "disconnected" },
        idle:         { i18n: "fb_groups.profile_status_idle",         fallback: "Idle",           cls: "idle" },
    };

    function profileInitials(label) {
        const s = (label || "?").trim();
        const parts = s.split(/\s+/).filter(Boolean);
        if (parts.length === 0) return "?";
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function statusBadgeHtml(activity) {
        const status = (activity && activity.status) || "idle";
        const meta = PROFILE_STATUS_META[status] || PROFILE_STATUS_META.idle;
        const text = t(meta.i18n, meta.fallback);
        return `<span class="fbg-profile-status status-${meta.cls}"><span class="fbg-status-dot"></span><span class="fbg-status-text">${escapeHtml(text)}</span></span>`;
    }

    async function loadProfiles() {
        try {
            const res = await window.electronAPI.fbGroupsGetProfilesOverview();
            allProfiles = (res.success && Array.isArray(res.data)) ? res.data : [];
            // Merge any live activity already buffered by the global manager
            const buffered = (window.fbGroupsManager && window.fbGroupsManager.profileActivity) || {};
            allProfiles.forEach(p => { if (buffered[p.profileId]) p.activity = buffered[p.profileId]; });
            renderProfilesGrid();
        } catch (e) {
            console.error("[fbGroups] loadProfiles error:", e);
        }
    }

    // Scan a profile from the Profiles page card, update the card in place.
    async function scanProfileCard(profileId, profileLabel, btnEl) {
        const $btn = $(btnEl);
        const orig = $btn.html();
        $btn.prop("disabled", true).html(`<span class="material-icons fbg-spin">progress_activity</span>`);
        try {
            const res = await window.electronAPI.fbGroupsScanProfile(profileId, profileLabel || "");
            const scan = (res && res.scan) || {};
            // Patch the in-memory profile and re-render its card.
            const p = allProfiles.find(x => x.profileId === profileId);
            if (p) {
                p.loggedIn      = scan.loggedIn != null ? scan.loggedIn : (res && res.loggedIn ? 1 : 0);
                p.scanInfo      = scan.scanInfo || (res && res.info) || null;
                p.scanError     = scan.scanError || (res && !res.success ? res.error : null);
                p.lastScannedAt = scan.lastScannedAt || new Date().toISOString();
                // A confirmed login clears a stale "disconnected" status pill.
                const isLoggedIn = p.loggedIn === 1 || p.loggedIn === true;
                if (isLoggedIn && p.activity && p.activity.status === "disconnected") {
                    p.activity = { profileId, status: "idle", detail: "" };
                }
                const $card = $(`.fbg-profile-card[data-profile-id="${(window.CSS && CSS.escape) ? CSS.escape(profileId) : profileId}"]`);
                if ($card.length) $card.replaceWith(buildProfileCardHtml(p));
            }
            if (res && !res.success && res.error) {
                showAlert("error", res.error);
            } else if (res && res.loggedIn === false) {
                showAlert("warning", t("fb_groups.profile_logged_out", "Profile is logged out of Facebook"));
            } else if (res && res.loggedIn) {
                const nm = (res.info && res.info.name) || profileLabel || "";
                showAlert("success", t("fb_groups.profile_verified", "Profile is logged in") + (nm ? ` — ${nm}` : ""));
            }
        } catch (e) {
            console.error("[fbGroups] scanProfileCard error:", e);
            $btn.prop("disabled", false).html(orig);
        }
    }

    function getFilteredProfiles() {
        if (!profileSearchTerm) return allProfiles;
        const q = profileSearchTerm.toLowerCase();
        return allProfiles.filter(p =>
            (p.profileLabel || "").toLowerCase().includes(q) ||
            (p.structureLabel || "").toLowerCase().includes(q)
        );
    }

    function renderProfilesGrid() {
        const $grid = $("#fbgProfilesGrid");
        const $empty = $("#fbgProfilesEmpty");
        const list = getFilteredProfiles();
        if (list.length === 0) {
            $grid.hide().empty();
            $empty.show();
            return;
        }
        $empty.hide();
        $grid.show();
        $grid[0].innerHTML = list.map(buildProfileCardHtml).join("");
    }

    function buildProfileCardHtml(p) {
        const cap = p.dailyCap || 0;
        const used = p.sentToday || 0;
        const capText = cap > 0 ? `${used}/${cap}` : `${used}/∞`;
        const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
        const capCls = cap > 0 && used >= cap ? "full" : (pct >= 80 ? "high" : "");
        const total = (p.sentTotal || 0) + (p.failedTotal || 0);
        const rate = total > 0 ? Math.round((p.sentTotal / total) * 100) : null;
        const lastActive = p.lastPostedAt ? relativeTime(p.lastPostedAt) : t("fb_groups.no_posts_yet", "No posts yet");

        // ── Facebook scan (login health + identity) ──────────────────────
        const info = p.scanInfo || null;
        const scanned = !!p.lastScannedAt;
        const loggedIn = p.loggedIn === 1 || p.loggedIn === true;
        let healthCls = "unknown", healthIcon = "help", healthText = t("fb_groups.not_scanned", "Not scanned");
        if (scanned && loggedIn) { healthCls = "ok";  healthIcon = "verified"; healthText = t("fb_groups.logged_in", "Logged in"); }
        else if (scanned)        { healthCls = "bad"; healthIcon = "gpp_bad";  healthText = t("fb_groups.logged_out", "Logged out"); }

        // ── Warm-up badge: shown while the new-profile ramp is active ─────
        const warmupBadge = p.warmupActive
            ? `<span class="fbg-profile-warmup" title="${escapeHtml(t("fb_groups.warmup_badge_hint", "New profile — daily posting is reduced while it warms up"))}"><span class="material-icons">trending_up</span>${escapeHtml(t("fb_groups.warmup_badge", "Warming up"))}</span>`
            : "";

        // Avatar: real Facebook picture overlaid on the initials placeholder.
        // If the image is broken/blocked, onerror hides it, revealing the initials.
        const initials = escapeHtml(profileInitials(p.profileLabel));
        const avatar = info && info.profilePicture
            ? `<div class="fbg-profile-avatar"><span class="fbg-avatar-initials">${initials}</span><img class="fbg-profile-avatar-img" src="${escapeHtml(facebookImageSrc(info.profilePicture))}" referrerpolicy="no-referrer" alt="" onerror="this.style.display='none'"></div>`
            : `<div class="fbg-profile-avatar">${initials}</div>`;

        // Cover banner across the top of the card — show a styled placeholder
        // when no cover photo is available (so every card has a consistent header).
        const cover = info && info.coverImage
            ? `<div class="fbg-profile-cover" style="background-image:url('${escapeHtml(facebookImageSrc(info.coverImage))}')"></div>`
            : `<div class="fbg-profile-cover fbg-profile-cover-placeholder"><span class="material-icons">image</span></div>`;

        // Display name from the scan when available
        const displayName = (info && info.name) ? info.name : p.profileLabel;

        // Friends / followers line
        const social = info ? (info.friendsText || info.followersText || "") : "";
        const fbId = info ? (info.username ? "@" + info.username : (info.userId ? "ID " + info.userId : "")) : "";
        const scanAgo = scanned ? relativeTime(p.lastScannedAt) : "";

        return `
        <div class="fbg-profile-card ${cover ? "has-cover" : ""} health-${healthCls}" data-profile-id="${escapeHtml(p.profileId)}">
            ${cover}
            <div class="fbg-profile-head">
                ${avatar}
                <div class="fbg-profile-id">
                    <div class="fbg-profile-name" title="${escapeHtml(displayName)}">
                        ${escapeHtml(displayName)}
                        <span class="fbg-profile-health ${healthCls}" title="${escapeHtml(healthText)}"><span class="material-icons">${healthIcon}</span></span>
                    </div>
                    <div class="fbg-profile-struct" title="${escapeHtml(fbId || p.structureLabel)}">${escapeHtml(fbId || p.structureLabel || "—")}</div>
                </div>
                ${statusBadgeHtml(p.activity)}
            </div>
            ${warmupBadge}
            ${social ? `<div class="fbg-profile-social"><span class="material-icons">group</span>${escapeHtml(social)}</div>` : ""}
            <div class="fbg-cap-block">
                <div class="fbg-cap-bar-head">
                    <span data-i18n="fb_groups.profile_cap_usage">Daily usage</span>
                    <strong>${capText}</strong>
                </div>
                <div class="fbg-cap-bar"><div class="fbg-cap-fill ${capCls}" style="width:${pct}%"></div></div>
            </div>
            <div class="fbg-profile-stats-row">
                <div class="fbg-profile-stat"><span class="fbg-ps-val">${p.sentTotal || 0}</span><span class="fbg-ps-lbl" data-i18n="fb_groups.profile_sent">Sent</span></div>
                <div class="fbg-profile-stat"><span class="fbg-ps-val">${p.failedTotal || 0}</span><span class="fbg-ps-lbl" data-i18n="fb_groups.profile_failed">Failed</span></div>
                <div class="fbg-profile-stat"><span class="fbg-ps-val">${rate === null ? "—" : rate + "%"}</span><span class="fbg-ps-lbl" data-i18n="fb_groups.profile_success_rate">Success</span></div>
                <div class="fbg-profile-stat"><span class="fbg-ps-val">${p.groupCount || 0}</span><span class="fbg-ps-lbl" data-i18n="fb_groups.profile_groups">Groups</span></div>
            </div>
            <div class="fbg-profile-foot">
                <span class="fbg-profile-last" title="${scanAgo ? t("fb_groups.last_scanned","Last scanned") + " " + escapeHtml(scanAgo) : ""}">
                    <span class="material-icons">${scanned ? "fact_check" : "schedule"}</span>${escapeHtml(scanned ? scanAgo : lastActive)}
                </span>
                <span class="fbg-profile-foot-actions">
                    ${healthCls === "bad" ? `<button class="fbg-wf-action-btn fbg-profile-mark-working-btn" data-profile-id="${escapeHtml(p.profileId)}" title="${t("fb_groups.mark_profile_working","Mark as working")}"><span class="material-icons">check_circle</span></button>` : ""}
                    <button class="fbg-wf-action-btn fbg-profile-post-btn" data-profile-id="${escapeHtml(p.profileId)}" data-label="${escapeHtml(p.profileLabel || "")}" title="${t("fb_groups.post_from_profile","Create a post")}">
                        <span class="material-icons">post_add</span>
                    </button>
                    <button class="fbg-wf-action-btn fbg-profile-open-btn" data-profile-id="${escapeHtml(p.profileId)}" title="${t("fb_groups.open_profile_browser","Open in Browser")}">
                        <span class="material-icons">open_in_browser</span>
                    </button>
                    <button class="fbg-wf-action-btn fbg-profile-scan-btn" data-profile-id="${escapeHtml(p.profileId)}" data-label="${escapeHtml(p.profileLabel || "")}" title="${t("fb_groups.scan_profile","Verify / scan profile")}">
                        <span class="material-icons">person_search</span>
                    </button>
                    <button class="fbg-wf-action-btn fbg-profile-reset-stats-btn" data-profile-id="${escapeHtml(p.profileId)}" title="${t("fb_groups.reset_stats","Reset sent/failed stats")}">
                        <span class="material-icons">restart_alt</span>
                    </button>
                    <button class="fbg-wf-action-btn fbg-profile-history-btn" data-profile-id="${escapeHtml(p.profileId)}">
                        <span class="material-icons">history</span><span data-i18n="fb_groups.profile_view_history">History</span>
                    </button>
                </span>
            </div>
        </div>`;
    }

    // Live activity arriving from the scheduler — update the matching card in place
    function updateProfileActivityLive(data) {
        if (!data || !data.profileId) return;
        const p = allProfiles.find(x => x.profileId === data.profileId);
        if (p) p.activity = data;
        const $card = $(`.fbg-profile-card[data-profile-id="${data.profileId}"]`);
        if ($card.length) {
            $card.find(".fbg-profile-status").replaceWith(statusBadgeHtml(data));
        }
        // Update the open detail modal too
        if (pdCurrentProfileId === data.profileId) {
            $("#fbgPdStatus").replaceWith(statusBadgeHtml(data).replace('class="fbg-profile-status', 'id="fbgPdStatus" class="fbg-profile-status'));
            $("#fbgPdStatusDetail").text(data.detail || "");
        }
    }

    async function openProfileDetail(profileId) {
        pdCurrentProfileId = profileId;
        pdHistoryOffset = 0;
        const p = allProfiles.find(x => x.profileId === profileId);
        $("#fbgPdName").text(p ? p.profileLabel : profileId);
        $("#fbgPdStructure").text(p ? (p.structureLabel || "") : "");
        $("#fbgPdGroups").html(`<div class="fbg-pd-muted">${t("common.loading", "Loading…")}</div>`);
        $("#fbgPdHistory").html(`<div class="fbg-pd-muted">${t("common.loading", "Loading…")}</div>`);
        $("#fbgPdHistoryMore").hide();
        $("#fbgProfileDetailBackdrop").addClass("open");
        $("#fbgProfileDetailModal").addClass("open");
        try {
            const res = await window.electronAPI.fbGroupsGetProfileDetail(profileId);
            if (!res.success) return;
            const { stats, groups, history, activity } = res.data;
            // Status
            $("#fbgPdStatus").replaceWith(statusBadgeHtml(activity).replace('class="fbg-profile-status', 'id="fbgPdStatus" class="fbg-profile-status'));
            $("#fbgPdStatusDetail").text(activity && activity.detail ? activity.detail : "");
            // Stats
            const sent = stats.sentCount || 0;
            const failed = stats.failedCount || 0;
            const total = sent + failed;
            const rate = total > 0 ? Math.round((sent / total) * 100) : null;
            $("#fbgPdSentToday").text(p ? `${p.sentToday || 0}${p.dailyCap > 0 ? "/" + p.dailyCap : ""}` : "0");
            $("#fbgPdSent").text(sent);
            $("#fbgPdFailed").text(failed);
            $("#fbgPdRate").text(rate === null ? "—" : rate + "%");
            // Groups
            if (groups && groups.length) {
                $("#fbgPdGroups").html(groups.map(g =>
                    `<span class="fbg-pd-group-chip">${escapeHtml(g.groupName || g.groupId)}</span>`
                ).join(""));
            } else {
                $("#fbgPdGroups").html(`<div class="fbg-pd-muted">—</div>`);
            }
            // History
            renderProfileHistory(history, true);
        } catch (e) {
            console.error("[fbGroups] openProfileDetail error:", e);
        }
    }

    function renderProfileHistory(history, replace) {
        const rows = (history && history.rows) || [];
        const total = (history && history.total) || 0;
        const html = rows.map(r => {
            const statusCls = r.status === "sent" ? "ok" : (r.status === "failed" ? "err" : "");
            const msg = (r.message || "").slice(0, 120);
            return `
            <div class="fbg-pd-hist-row">
                <span class="fbg-pd-hist-status ${statusCls}">${escapeHtml(r.status || "")}</span>
                <div class="fbg-pd-hist-body">
                    <div class="fbg-pd-hist-group">${escapeHtml(r.groupName || r.groupId || "")}</div>
                    <div class="fbg-pd-hist-msg">${escapeHtml(msg)}</div>
                </div>
                <span class="fbg-pd-hist-time">${escapeHtml(relativeTime(r.postedAt))}</span>
            </div>`;
        }).join("");
        if (replace) {
            $("#fbgPdHistory").html(rows.length ? html : `<div class="fbg-pd-muted" data-i18n="fb_groups.profile_no_history">No history yet.</div>`);
        } else {
            $("#fbgPdHistory").append(html);
        }
        pdHistoryOffset += rows.length;
        $("#fbgPdHistoryMore").toggle(pdHistoryOffset < total);
    }

    async function loadMoreProfileHistory() {
        if (!pdCurrentProfileId) return;
        try {
            const res = await window.electronAPI.fbGroupsGetProfileHistory(pdCurrentProfileId, PD_HISTORY_PER_PAGE, pdHistoryOffset);
            if (res.success) renderProfileHistory(res.data, false);
        } catch (e) {
            console.error("[fbGroups] loadMoreProfileHistory error:", e);
        }
    }

    function closeProfileDetail() {
        pdCurrentProfileId = null;
        $("#fbgProfileDetailBackdrop").removeClass("open");
        $("#fbgProfileDetailModal").removeClass("open");
    }

    // ── Events ──────────────────────────────────────────────────
    function setupEvents() {
        // Always remove previous bindings first — guards against accidental double-init
        $(document).off(NS);

        // ── Navigation ───────────────────────────────────────────
        $(document).on("click" + NS, ".fbg-nav-item", function () {
            const page = $(this).data("page");
            if (!page) return;
            if (page === "logs") $("#fbgLogBadge").hide().text("0");
            switchPage(page);
        });

        // ── Day picker toggle (delegated) ────────────────────────────
        $(document).on("click" + NS, ".fbg-day-btn", function () {
            $(this).toggleClass("selected");
        });

        // ── Shared: randomness slider live label ─────────────────
        $(document).on("input" + NS, ".fbg-range", function () {
            const prefix = $(this).data("prefix");
            if (!prefix) return;
            const rawDelay = parseInt($(`#${prefix}Delay`).val()) || 30;
            const unit     = $(`#${prefix}DelayUnit`).val();
            const delayMin = unit === "hours" ? rawDelay * 60 : rawDelay;
            const pct      = parseInt($(this).val()) || 0;
            $(`#${prefix}RndVal`).text(buildRndLabel(delayMin, pct));
        });

        // ── Shared: delay input updates rnd label ────────────────
        $(document).on("input" + NS, ".fbg-delay-input", function () {
            const id     = $(this).attr("id");
            const prefix = id ? id.replace("Delay", "") : null;
            if (!prefix) return;
            const rawDelay = parseInt($(this).val()) || 30;
            const unit     = $(`#${prefix}DelayUnit`).val();
            const delayMin = unit === "hours" ? rawDelay * 60 : rawDelay;
            const pct      = parseInt($(`#${prefix}Randomness`).val()) || 0;
            $(`#${prefix}RndVal`).text(buildRndLabel(delayMin, pct));
        });

        // ── Group Settings ──────────────────────────────────────────
        $(document).on("click" + NS, "#fbgSaveGroupSettings", () => saveGroupSettings());
        $(document).on("click" + NS, "#fbgTestDocIdsBtn", () => testDocIds());

        // ── Viral monitoring pause / resume ──────────────────────────
        $(document).on("click" + NS, "#fbgViralMonitorToggleBtn", async function () {
            const isPaused = $(this).hasClass("fbg-vm-toggle-paused");
            if (!isPaused) {
                // Currently running → pause
                $(this).prop("disabled", true);
                try {
                    const res = await window.electronAPI.fbGroupsPauseMonitoring();
                    if (res && res.success) {
                        _setViralMonitorPausedUI(true);
                    } else {
                        showAlert("error", (res && res.error) || t("fb_groups.error_generic", "An error occurred"));
                    }
                } catch (e) {
                    showAlert("error", e.message);
                } finally {
                    $(this).prop("disabled", false);
                }
            } else {
                // Currently paused → open resume modal
                $("input[name='fbgResumeRange'][value='all']").prop("checked", true);
                $("#fbgResumeDaysInput").val(7);
                $("#fbgResumeMonitorModal, #fbgResumeMonitorBackdrop").addClass("open");
            }
        });
        // Posts page — same pause/resume behaviour as the Settings card button
        $(document).on("click" + NS, "#fbgPostsVmToggleBtn", async function () {
            const isPaused = $(this).hasClass("fbg-vm-toggle-paused");
            if (!isPaused) {
                $(this).prop("disabled", true);
                try {
                    const res = await window.electronAPI.fbGroupsPauseMonitoring();
                    if (res && res.success) {
                        _setViralMonitorPausedUI(true);
                    } else {
                        showAlert("error", (res && res.error) || t("fb_groups.error_generic", "An error occurred"));
                    }
                } catch (e) {
                    showAlert("error", e.message);
                } finally {
                    $(this).prop("disabled", false);
                }
            } else {
                $("input[name='fbgResumeRange'][value='all']").prop("checked", true);
                $("#fbgResumeDaysInput").val(7);
                $("#fbgResumeMonitorModal, #fbgResumeMonitorBackdrop").addClass("open");
            }
        });

        $(document).on("click" + NS, "#fbgResumeMonitorClose, #fbgResumeMonitorCancel, #fbgResumeMonitorBackdrop", () => {
            $("#fbgResumeMonitorModal, #fbgResumeMonitorBackdrop").removeClass("open");
        });
        $(document).on("click" + NS, "#fbgResumeMonitorConfirm", async function () {
            const $btn = $(this);
            $btn.prop("disabled", true);
            const range = $("input[name='fbgResumeRange']:checked").val();
            const daysAgo = range === "days" ? (parseInt($("#fbgResumeDaysInput").val()) || 7) : null;
            try {
                const res = await window.electronAPI.fbGroupsResumeMonitoring(daysAgo);
                if (res && res.success) {
                    _setViralMonitorPausedUI(false);
                    $("#fbgResumeMonitorModal, #fbgResumeMonitorBackdrop").removeClass("open");
                    const msg = daysAgo
                        ? (t("fb_groups.resume_monitor_success_days", "Monitoring resumed — {{count}} post(s) scheduled for recheck") || "").replace("{{count}}", res.resetCount ?? 0)
                        : (t("fb_groups.resume_monitor_success_all", "Monitoring resumed — {{count}} post(s) scheduled for recheck") || "").replace("{{count}}", res.resetCount ?? 0);
                    showAlert("success", msg || `Monitoring resumed — ${res.resetCount ?? 0} post(s) scheduled for recheck`);
                } else {
                    showAlert("error", (res && res.error) || t("fb_groups.error_generic", "An error occurred"));
                }
            } catch (e) {
                showAlert("error", e.message);
            } finally {
                $btn.prop("disabled", false);
            }
        });

        // ── Profiles ────────────────────────────────────────────────
        $(document).on("click" + NS, "#fbgProfilesRefresh", () => loadProfiles());
        $(document).on("input" + NS, "#fbgProfileSearch", function () {
            profileSearchTerm = $(this).val() || "";
            renderProfilesGrid();
        });
        $(document).on("click" + NS, ".fbg-profile-history-btn", function (e) {
            e.stopPropagation();
            const id = $(this).data("profile-id");
            if (id) openProfileDetail(String(id));
        });
        $(document).on("click" + NS, ".fbg-profile-scan-btn", function (e) {
            e.stopPropagation();
            $(document.activeElement).blur();
            const id = $(this).data("profile-id");
            const label = $(this).data("label") || "";
            if (id) scanProfileCard(String(id), String(label), this);
        });
        $(document).on("click" + NS, ".fbg-profile-post-btn", function (e) {
            e.stopPropagation();
            $(document.activeElement).blur();
            const id = $(this).data("profile-id");
            const label = $(this).data("label") || "";
            if (id) showProfilePostModal(String(id), String(label));
        });
        $(document).on("click" + NS, ".fbg-profile-reset-stats-btn", async function (e) {
            e.stopPropagation();
            $(document.activeElement).blur();
            const id = $(this).data("profile-id");
            if (!id) return;
            if (!await confirmPrompt(t("fb_groups.confirm_reset_stats", "Reset this profile's sent and failed totals? The current daily usage is kept. Post history is not deleted."))) return;
            $(this).prop("disabled", true);
            try {
                const res = await window.electronAPI.fbGroupsResetProfileStats(String(id));
                if (res && res.success) {
                    showAlert("success", t("fb_groups.stats_reset_done", "Profile stats reset"));
                    loadProfiles();
                } else {
                    showAlert("error", res?.error || t("fb_groups.error_generic", "An error occurred"));
                }
            } catch (err) {
                showAlert("error", err.message || t("fb_groups.error_generic", "An error occurred"));
            }
        });
        $(document).on("click" + NS, ".fbg-profile-mark-working-btn", async function (e) {
            e.stopPropagation();
            const id = $(this).data("profile-id");
            if (!id) return;
            $(this).prop("disabled", true);
            try {
                const res = await window.electronAPI.fbGroupsMarkProfileWorking(String(id));
                if (!res || !res.success) showAlert("error", res?.error || t("fb_groups.error_generic", "An error occurred"));
            } catch (err) {
                showAlert("error", err.message || t("fb_groups.error_generic", "An error occurred"));
            }
        });
        $(document).on("click" + NS, ".fbg-profile-open-btn", async function (e) {
            e.stopPropagation();
            const id = $(this).data("profile-id");
            if (!id) return;
            const $btn = $(this);
            if ($btn.prop("disabled")) return;
            const orig = $btn.html();
            $btn.prop("disabled", true).html(`<span class="material-icons fbg-spin">progress_activity</span>`);
            try {
                const result = await window.electronAPI.startStructureProfile(String(id), "https://www.facebook.com", null, null);
                if (result && result.success) {
                    $btn.html(`<span class="material-icons fbg-profile-open-success">check_circle</span>`);
                    setTimeout(() => $btn.html(orig).prop("disabled", false), 2500);
                } else {
                    $btn.html(orig).prop("disabled", false);
                    if (result && result.needsVCBrowser) {
                        showAlert("error", t("fb_groups.open_profile_no_vcbrowser", "VCBrowser is not installed. Please download it from Settings."));
                    } else {
                        showAlert("error", (result && result.error) || t("fb_groups.open_profile_failed", "Failed to open profile"));
                    }
                }
            } catch (err) {
                $btn.html(orig).prop("disabled", false);
                showAlert("error", err.message || t("fb_groups.open_profile_failed", "Failed to open profile"));
            }
        });
        $(document).on("click" + NS, ".fbg-profile-card", function () {
            const id = $(this).data("profile-id");
            if (id) openProfileDetail(String(id));
        });
        $(document).on("click" + NS, "#fbgProfileDetailClose, #fbgProfileDetailBackdrop", () => closeProfileDetail());
        $(document).on("click" + NS, "#fbgPdLoadMore", () => loadMoreProfileHistory());

        // ── Dashboard ────────────────────────────────────────────
        $(document).on("click" + NS, "#fbgDashImportBtn", () => openNewWfModal());
        $(document).on("click" + NS, "#fbgDashPauseAll", async () => {
            const wfs = allWorkflows.filter(w => w.status === "active");
            for (const wf of wfs) await window.electronAPI.fbGroupsSetWorkflowStatus(wf.workflowId, "paused").catch(() => {});
            await loadWorkflows(); await loadDashboardStats();
        });

        // ── Workflows ─────────────────────────────────────────────
        $(document).on("click" + NS, "#fbgWfImportBtn, #fbgWfEmptyImportBtn", () => openNewWfModal());
        $(document).on("input" + NS, "#fbgWfSearch", function () {
            const q = $(this).val().toLowerCase();
            $("#fbgWorkflowGrid .fbg-workflow-card").each(function () {
                $(this).toggle($(this).find(".fbg-wf-card-name").text().toLowerCase().includes(q));
            });
        });
        $(document).on("click" + NS, ".fbg-wf-action-btn[data-wf-action]", async function (e) {
            e.stopPropagation();
            const action = $(this).data("wf-action"), wfId = $(this).data("wf-id");
            if (!wfId) return;
            if (action === "toggle") {
                const wf = allWorkflows.find(w => w.workflowId === wfId);
                await window.electronAPI.fbGroupsSetWorkflowStatus(wfId, wf?.status === "active" ? "paused" : "active").catch(() => {});
                await loadWorkflows(); await loadDashboardStats();
            } else if (action === "restart") {
                const msg = t("fb_groups.confirm_restart_workflow",
                    "Restart this workflow? This will reset all post history and start posting immediately from the first post.");
                $(document.activeElement).blur();
                if (!await confirmPrompt(msg)) return;
                await window.electronAPI.fbGroupsRestartWorkflow(wfId).catch(() => {});
                await loadWorkflows(); await loadDashboardStats();
            } else if (action === "settings") {
                openWfSettingsPanel(wfId);
            } else if (action === "manage-posts") {
                const wfName = $(this).data("wf-name") || wfId;
                openAssignPostsModal(wfId, wfName);
            } else if (action === "remove") {
                $(document.activeElement).blur();
                if (!await confirmPrompt(t("fb_groups.confirm_remove_workflow","Remove this workflow from FB Groups automation? It will return to the Workflows page."))) return;
                await window.electronAPI.fbGroupsRemoveImportedWorkflow(wfId).catch(() => {});
                await loadWorkflows(); await loadDashboardStats();
            }
        });

        // ── Workflow settings panel ───────────────────────────────
        $(document).on("click" + NS, "#fbgWfPanelBack, #fbgWfOverlay", () => closeWfSettingsPanel());
        $(document).on("click" + NS, "#fbgWfSaveSettings", () => saveWfSettings());

        // ── Live Logs ─────────────────────────────────────────────
        $(document).on("click" + NS, ".fbg-log-filter", function () {
            $(".fbg-log-filter").removeClass("active");
            $(this).addClass("active");
            liveLogFilter = $(this).data("filter") || "all";
            renderLiveLogs();
        });
        $(document).on("click" + NS, "#fbgClearLogs", () => {
            if (window.fbGroupsManager) window.fbGroupsManager.liveLogEntries = [];
            renderLiveLogs();
        });

        // ── Analytics ─────────────────────────────────────────────
        $(document).on("click" + NS, ".fbg-range-btn", async function () {
            $(".fbg-range-btn").removeClass("active"); $(this).addClass("active");
            analyticsRangeDays = parseInt($(this).data("days")) || 7;
            await loadAnalytics();
        });

        // ── Posts Feed ────────────────────────────────────────────
        $(document).on("click" + NS, ".fbg-posts-view-btn", async function () {
            const view = $(this).data("view") || "active";
            if (view === postsView) return;
            $(".fbg-posts-view-btn").removeClass("active"); $(this).addClass("active");
            postsView = view;
            // The "All / Monitoring / Triggered" filters only apply to active posts.
            $("#fbgPostsFilterBtns").toggle(postsView === "active");
            await loadPostsFeed(1);
        });
        $(document).on("click" + NS, ".fbg-posts-filter-btn", async function () {
            $(".fbg-posts-filter-btn").removeClass("active"); $(this).addClass("active");
            postsFilter = $(this).data("filter") || "all";
            await loadPostsFeed(1);
        });
        $(document).on("click" + NS, "[data-posts-page]", async function () {
            await loadPostsFeed(parseInt($(this).data("posts-page")) || 1);
        });
        $(document).on("click" + NS, ".fbg-expired-check", async function (e) {
            e.stopPropagation();
            const storyId = $(this).data("story-id");
            if (!storyId) return;
            const $btn = $(this).prop("disabled", true);
            $btn.find(".material-icons").text("hourglass_top").addClass("fbg-spin");
            const res = await window.electronAPI.fbGroupsRefreshExpiredStats(storyId)
                .catch(err => ({ success: false, error: err.message }));
            $btn.prop("disabled", false).find(".material-icons").text("analytics").removeClass("fbg-spin");
            if (res.success) {
                // Update the row's count inline without a full reload.
                const $cell = $btn.closest("tr").find(".fbg-expired-metric-cell .fbg-expired-count");
                if ($cell.length) $cell.text(res.count);
                showAlert("success", t("fb_groups.expired_stats_updated", "Stats updated") +
                    `: ${res.count}/${res.target} ${res.metric || ""}`.trimEnd());
            } else {
                showAlert("error", t("fb_groups.expired_stats_failed", "Failed to check stats: ") + (res.error || "unknown error"));
            }
        });
        $(document).on("click" + NS, ".fbg-post-force-check", async function (e) {
            e.stopPropagation();
            const storyId = $(this).data("story-id");
            if (!storyId) return;
            if (_vmPaused) {
                showAlert("info", t("fb_groups.vm_paused_resume_hint", "Viral monitoring is paused. Resume it to check posts."));
                return;
            }
            const $btn = $(this);
            $btn.prop("disabled", true).find(".material-icons").text("hourglass_top");
            const res = await window.electronAPI.fbGroupsForceCheckMonitor(storyId).catch(err => ({ success: false, error: err.message }));
            if (res.success) {
                await loadPostsFeed();
                // Poll a couple more times to catch any post-action state changes (e.g. edit comment finishing)
                setTimeout(() => loadPostsFeed(), 3000);
                setTimeout(() => loadPostsFeed(), 9000);
            } else if (res.paused) {
                // Backend refused because monitoring is paused — sync UI to match
                _setViralMonitorPausedUI(true);
                $btn.prop("disabled", false).find(".material-icons").text("refresh");
            } else {
                $btn.prop("disabled", false).find(".material-icons").text("refresh");
                alert("Force check failed: " + (res.error || "unknown error"));
            }
        });

        $(document).on("click" + NS, ".fbg-post-action-stop", async function (e) {
            e.stopPropagation();
            const postId = $(this).data("post-id");
            if (!postId) return;
            const $btn = $(this).prop("disabled", true);
            const res = await window.electronAPI.fbGroupsStopMonitor(postId).catch(err => ({ success: false, error: err.message }));
            if (res.success) {
                await loadPostsFeed();
            } else {
                $btn.prop("disabled", false);
                alert(t("fb_groups.stop_monitor_error", "Failed to stop monitoring: ") + (res.error || "unknown error"));
            }
        });

        $(document).on("click" + NS, ".fbg-post-action-delete", async function (e) {
            e.stopPropagation();
            const postId = $(this).data("post-id");
            if (!postId) return;
            if (!confirm(t("fb_groups.confirm_delete_post", "Delete this post from history? This will also stop any active monitoring."))) return;
            const $btn = $(this).prop("disabled", true);
            const res = await window.electronAPI.fbGroupsDeletePost(postId).catch(err => ({ success: false, error: err.message }));
            if (res.success) {
                await loadPostsFeed();
            } else {
                $btn.prop("disabled", false);
                alert(t("fb_groups.delete_post_error", "Failed to delete post: ") + (res.error || "unknown error"));
            }
        });

        // ── Unified New Workflow Modal ────────────────────────────
        $(document).on("click" + NS, "#fbgNewWfClose, #fbgNewWfCancelBtn, #fbgNewWfBackdrop", closeNewWfModal);
        $(document).on("click" + NS, "#fbgNewWfConfirmBtn", confirmNewWorkflow);
        $(document).on("click" + NS, ".fbg-wf-type-tab", function () {
            setNewWfType($(this).data("type"));
        });
        $(document).on("input" + NS, "#fbgNWName", function () { _nwNameDirty = true; updateNewWfConfirmBtn(); });
        $(document).on("focus" + NS, ".fbg-group-target-profile, .fbg-nw-group-profile", function () {
            $(this).data("accountSelection", $(this).val() || [""]);
        });
        $(document).on("change" + NS, ".fbg-group-target-profile, .fbg-nw-group-profile", function () {
            const values = $(this).val() || [];
            const previous = $(this).data("accountSelection") || [""];
            const autoAdded = values.includes("") && !previous.includes("");
            const next = autoAdded || !values.length ? [""] : values.filter(Boolean);
            $(this).val(next.length ? next : [""]).data("accountSelection", next);
        });
        $(document).on("change" + NS, ".fbg-nw-group-cb", function () {
            const groupId = $(this).data("group-id");
            $(`.fbg-nw-group-profile[data-group-id="${groupId}"]`).prop("disabled", !$(this).is(":checked"));
            updateNewWfConfirmBtn();
        });
        $(document).on("click" + NS, ".fbg-nw-picker-item[data-wf-id]", function () {
            $(".fbg-nw-picker-item").removeClass("selected").find(".material-icons").text("radio_button_unchecked");
            $(this).addClass("selected").find(".material-icons").text("radio_button_checked");
            if (!_nwNameDirty) $("#fbgNWName").val($(this).data("wf-name") || "");
            updateNewWfConfirmBtn();
        });
        $(document).on("click" + NS, "#fbgNWUrlCommentToggle", function (e) {
            if ($(e.target).closest(".fbg-toggle-switch").length) return;
            const $cb = $("#fbgNWUrlComment");
            $cb.prop("checked", !$cb.is(":checked")).trigger("change");
        });
        $(document).on("click" + NS, "#fbgNWViralToggle", function (e) {
            if ($(e.target).closest(".fbg-toggle-switch").length) return;
            const $cb = $("#fbgNWViralEnabled");
            $cb.prop("checked", !$cb.is(":checked")).trigger("change");
        });
        $(document).on("change" + NS, "#fbgNWPostContentAsComment", syncNWInitialComment);
        $(document).on("change" + NS, "#fbgNWUrlComment", function () {
            const on = $(this).is(":checked");
            if (on) $("#fbgNWUrlCommentSection").slideDown(200); else $("#fbgNWUrlCommentSection").slideUp(150);
            syncNWEditCommentOption();
            syncNWInitialComment();
        });
        $(document).on("change" + NS, "#fbgNWViralEnabled", function () {
            const on = $(this).is(":checked");
            if (on) $("#fbgNWViralSection").slideDown(200); else $("#fbgNWViralSection").slideUp(150);
            if (on) {
                $("#fbgNWAiRewriteSection").slideDown(200);
                // Default to AI mode on first open
                if (!$("#fbgNWAiRewrite").is(":checked")) {
                    $("#fbgNWAiRewrite").prop("checked", true);
                    $("#fbgNWAiRewriteBody").show();
                    $("#fbgNWEditPostCustomBody").hide();
                    $("#fbgNWEditCommentCustomBody").hide();
                    loadConnectedAiProvidersInto("fbgNWAiProvider", "fbgNWAiModel").catch(() => {});
                }
                // Show comment text group if edit_comment is selected
                if ($("#fbgNWViralAction").val() === "edit_comment") {
                    $("#fbgNWEditCommentTextGroup").show();
                }
                _updateNWEditSectionLabel();
            } else {
                $("#fbgNWAiRewriteSection").slideUp(150);
                $("#fbgNWAiRewrite").prop("checked", false);
                $("#fbgNWAiRewriteBody").hide();
                $("#fbgNWEditPostCustomBody").hide();
                $("#fbgNWEditCommentCustomBody").hide();
                $("#fbgNWEditCommentTextGroup").hide();
            }
        });
        $(document).on("change" + NS, "#fbgNWViralAction", function () {
            const isEditPost = $(this).val() === "edit_post";
            const viralOn = $("#fbgNWViralEnabled").is(":checked");
            if (viralOn) {
                $("#fbgNWAiRewriteSection").slideDown(200);
                // Show/hide comment text group
                if (isEditPost) {
                    $("#fbgNWEditCommentTextGroup").hide();
                } else {
                    $("#fbgNWEditCommentTextGroup").show();
                }
                // Show correct custom body if custom mode active
                if (!$("#fbgNWAiRewrite").is(":checked")) {
                    $("#fbgNWEditPostCustomBody").toggle(isEditPost);
                    $("#fbgNWEditCommentCustomBody").toggle(!isEditPost);
                }
            }
            _updateNWEditSectionLabel();
            syncNWInitialComment();
        });
        // NW mode buttons (work for both actions)
        $(document).on("click" + NS, "#fbgNWEditModeAiBtn", function () {
            const isEditPost = $("#fbgNWViralAction").val() === "edit_post";
            $("#fbgNWAiRewrite").prop("checked", true);
            $("#fbgNWAiRewriteBody").slideDown(200);
            $("#fbgNWEditPostCustomBody").slideUp(150);
            $("#fbgNWEditCommentCustomBody").slideUp(150);
            // Comment text group stays visible for edit_comment
            if (!isEditPost) $("#fbgNWEditCommentTextGroup").show();
            $("#fbgNWEditModeAiBtn").css({ background: "var(--accent-color,#0d6efd)", color: "#fff" });
            $("#fbgNWEditModeCustomBtn").css({ background: "var(--bg-primary,#fff)", color: "var(--text-secondary,#6c757d)" });
            loadConnectedAiProvidersInto("fbgNWAiProvider", "fbgNWAiModel").catch(() => {});
        });
        $(document).on("click" + NS, "#fbgNWEditModeCustomBtn", function () {
            const isEditPost = $("#fbgNWViralAction").val() === "edit_post";
            $("#fbgNWAiRewrite").prop("checked", false);
            $("#fbgNWAiRewriteBody").slideUp(150);
            if (isEditPost) {
                $("#fbgNWEditPostCustomBody").slideDown(200);
                $("#fbgNWEditCommentCustomBody").hide();
            } else {
                $("#fbgNWEditCommentCustomBody").slideDown(200);
                $("#fbgNWEditPostCustomBody").hide();
                $("#fbgNWEditCommentTextGroup").show();
            }
            $("#fbgNWEditModeCustomBtn").css({ background: "var(--accent-color,#0d6efd)", color: "#fff" });
            $("#fbgNWEditModeAiBtn").css({ background: "var(--bg-primary,#fff)", color: "var(--text-secondary,#6c757d)" });
        });
        $(document).on("change" + NS, "#fbgNWEditPostKeepLinesEnabled", function () {
            $("#fbgNWEditPostKeepLines").prop("disabled", !$(this).is(":checked"));
        });
        $(document).on("change" + NS, "#fbgNWAiProvider", function () {
            const val = $(this).val();
            const $model = $("#fbgNWAiModel");
            const noModel = ["deepseekbrowser", "qwenbrowser"];
            if (val === "openai") {
                $model.val("gpt-4o-mini").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").show();
            } else if (noModel.includes(val)) {
                $model.val("").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").hide();
            } else {
                $model.prop("readonly", false).removeClass("fbg-input-locked").closest(".fbg-form-group").show();
            }
        });
        $(document).on("change" + NS, "#fbgNWViralAutoEnabled", function () {
            if ($(this).is(":checked")) $("#fbgNWViralAutoBody").slideDown(200); else $("#fbgNWViralAutoBody").slideUp(150);
        });
        $(document).on("change" + NS, "#fbgNWAiPromptPicker", function () {
            const selId = parseInt($(this).val());
            const found = (window._fbGroupsAiPrompts || []).find(p => p.id === selId);
            if (found) $("#fbgNWAiPrompt").val(found.text || found.promptText || "");
        });
        $(document).on("click" + NS, "#fbgNWAiPromptSaveBtn", async function () {
            const text = $("#fbgNWAiPrompt").val().trim();
            if (!text) return;
            const label = t("fb_groups.prompt_save_name", "Name for this prompt:");
            const result = await newPrompt([{ type: "text", name: label, required: true, default: text.slice(0, 40) }]);
            if (!result) return;
            const name = (result[label] || "").trim();
            if (!name) return;
            await window.electronAPI.fbGroupsSaveAiPrompt({ id: "p" + Date.now(), name, text }).catch(() => {});
            await loadNWAiPrompts();
        });
        $(document).on("click" + NS, "#fbgNWAiPromptDeleteBtn", async function () {
            const selId = parseInt($("#fbgNWAiPromptPicker").val());
            if (!selId) return;
            if (!await confirmPrompt(t("fb_groups.confirm_delete_prompt", "Delete this saved prompt?"))) return;
            await window.electronAPI.fbGroupsDeleteAiPrompt(selId).catch(() => {});
            await loadNWAiPrompts();
        });
        // NW Open picker button
        $(document).on("click" + NS, "#fbgNWOpenPickerBtn", () => openNWPickerModal());
        // NW picker modal: close / cancel / apply
        $(document).on("click" + NS, "#fbgNWPickerCloseBtn, #fbgNWPickerCancelBtn, #fbgNWPickerBackdrop", () => closeNWPickerModal(false));
        $(document).on("click" + NS, "#fbgNWPickerApplyBtn", () => closeNWPickerModal(true));
        // NW picker: filter chips
        $(document).on("click" + NS, "#fbgNWPickerModal .fbg-picker-filter-chip", function () {
            $(".fbg-picker-filter-chip").removeClass("active");
            $(this).addClass("active");
            _nwPickerFilter = $(this).data("filter");
            $("#fbgNWPickerDateRange").toggle(_nwPickerFilter === "range");
            _nwPickerPage = 1;
            _renderNWPickerList();
        });
        // NW picker: date range inputs
        $(document).on("change" + NS, "#fbgNWPickerDateFrom", function () {
            _nwPickerDateFrom = $(this).val();
            _nwPickerPage = 1;
            _renderNWPickerList();
        });
        $(document).on("change" + NS, "#fbgNWPickerDateTo", function () {
            _nwPickerDateTo = $(this).val();
            _nwPickerPage = 1;
            _renderNWPickerList();
        });
        // NW picker: search
        $(document).on("input" + NS, "#fbgNWPickerSearch", function () {
            _nwPickerSearch = $(this).val().trim();
            _nwPickerPage = 1;
            _renderNWPickerList();
        });
        // NW picker: select all filtered / clear all
        $(document).on("click" + NS, "#fbgNWPickerSelAllBtn", () => {
            _filterNWPickerPosts().forEach(p => _nwPickerTempIds.add(p.id));
            _renderNWPickerList();
        });
        $(document).on("click" + NS, "#fbgNWPickerClearBtn", () => {
            _nwPickerTempIds.clear();
            _renderNWPickerList();
        });
        // NW picker: checkbox (delegated)
        $(document).on("change" + NS, "#fbgNWPickerList .fbg-nw-picker-cb", function () {
            const postId = parseInt($(this).closest(".fbg-picker-post-row").data("post-id"));
            const checked = $(this).is(":checked");
            $(this).closest(".fbg-picker-post-row").toggleClass("selected", checked);
            if (checked) _nwPickerTempIds.add(postId); else _nwPickerTempIds.delete(postId);
            const n = _nwPickerTempIds.size;
            $("#fbgNWPickerCount").text(n > 0 ? `${n} post${n !== 1 ? "s" : ""} selected` : `${_nwLibAllPosts.length} posts in library`);
            $("#fbgNWPickerSelInfo").text(n > 0 ? `${n} post${n !== 1 ? "s" : ""} selected` : "No posts selected yet");
        });
        // NW picker: pagination
        $(document).on("click" + NS, "#fbgNWPickerPrev", () => {
            if (_nwPickerPage > 1) { _nwPickerPage--; _renderNWPickerList(); }
        });
        $(document).on("click" + NS, "#fbgNWPickerNext", () => {
            _nwPickerPage++; _renderNWPickerList();
        });
        $(document).on("click" + NS, ".fbg-nw-picker-pgbtn", function () {
            _nwPickerPage = parseInt($(this).data("pg"));
            _renderNWPickerList();
        });

        // ── Posts Library Page ────────────────────────────────────
        $(document).on("click" + NS, "#fbgLibAddBtn, #fbgLibEmptyAddBtn", () => openLibraryPostModal(false));
        $(document).on("click" + NS, "#fbgLibImportCsvBtn", () => openCsvImportModal());
        $(document).on("click" + NS, ".fbg-lib-edit-btn", async function () {
            const postId = parseInt($(this).data("post-id"));
            const res = await window.electronAPI.fbGroupsGetLibraryPosts().catch(() => null);
            const post = (res?.data || []).find(p => p.id === postId);
            if (post) openLibraryPostModal(true, post);
        });
        $(document).on("click" + NS, ".fbg-lib-delete-btn", async function () {
            $(this).blur();
            const postId = parseInt($(this).data("post-id"));
            if (!await confirmPrompt(t("fb_groups.confirm_delete_post","Delete this post?"))) return;
            await window.electronAPI.fbGroupsDeleteLibraryPost(postId).catch(() => {});
            await loadLibraryPosts();
        });
        $(document).on("input" + NS, "#fbgLibSearch", () => {
            _libPage = 1;
            renderLibraryPosts();
        });
        // Library pagination
        $(document).on("click" + NS, "#fbgLibPrevPage", () => {
            if (_libPage > 1) { _libPage--; renderLibraryPosts(); }
        });
        $(document).on("click" + NS, "#fbgLibNextPage", () => {
            _libPage++; renderLibraryPosts();
        });
        $(document).on("click" + NS, ".fbg-lib-pagination .fbg-page-btn", function () {
            _libPage = parseInt($(this).data("page"));
            renderLibraryPosts();
        });

        // ── Library Post Modal ────────────────────────────────────
        $(document).on("click" + NS, "#fbgLibPostModalClose, #fbgLibPostCancelBtn, #fbgLibPostBackdrop", closeLibraryPostModal);
        $(document).on("click" + NS, "#fbgLibPostSaveBtn", saveLibraryPost);
        $(document).on("click" + NS, "#fbgLibPostPickFileBtn", async (e) => {
            e.preventDefault();
            const $btn = $(e.currentTarget);
            if ($btn.data("picking")) return;
            $btn.data("picking", true);
            $btn.prop("disabled", true);
            try {
                const res = await window.electronAPI.fbGroupsPickLibraryPostImage().catch(() => null);
                if (!res?.success || !res.path) return;
                _libCurrentImagePath = res.path;
                $("#fbgLibPostImgUrl").val("");
                $("#fbgLibPostImgPreview").html(`<img src="file://${res.path.replace(/\\/g,'/')}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;">`);
                $("#fbgLibPostClearImgBtn").show();
            } finally {
                $btn.prop("disabled", false);
                setTimeout(() => $btn.data("picking", false), 500);
            }
        });
        $(document).on("click" + NS, "#fbgLibPostClearImgBtn", () => {
            _libCurrentImagePath = null;
            $("#fbgLibPostImgUrl").val("");
            $("#fbgLibPostImgPreview").html(`<span class="material-icons" style="font-size:28px;color:var(--text-secondary);">image</span>`);
            $("#fbgLibPostClearImgBtn").hide();
        });
        $(document).on("input" + NS + " paste" + NS, "#fbgLibPostImgUrl", function () {
            const val = $(this).val().trim();
            if (!val || !val.startsWith("http")) {
                if (!_libCurrentImagePath) {
                    $("#fbgLibPostImgPreview").html(`<span class="material-icons" style="font-size:28px;color:var(--text-secondary);">image</span>`);
                    $("#fbgLibPostClearImgBtn").hide();
                }
                return;
            }
            // Preview the URL directly in the modal image element
            _libCurrentImagePath = null; // URL takes priority; cleared on save replaced with local path
            $("#fbgLibPostImgPreview").html(`<img src="${val}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;" onerror="this.src='';this.style.display='none';">`);
            $("#fbgLibPostClearImgBtn").show();
        });

        // ── CSV Import Modal ──────────────────────────────────────
        $(document).on("click" + NS, "#fbgCsvImportClose, #fbgCsvImportCancelBtn, #fbgCsvImportBackdrop", closeCsvImportModal);
        $(document).on("click" + NS, "#fbgCsvImportStartBtn", runCsvImport);
        $(document).on("click" + NS, "#fbgCsvDownloadExample", () => {
            const blob = new Blob([EXAMPLE_CSV], { type: "text/csv;charset=utf-8;" });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement("a");
            a.href     = url;
            a.download = "posts-library-example.csv";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
        $(document).on("click" + NS, "#fbgCsvDropzone", () => $("#fbgCsvFileInput").trigger("click"));
        $(document).on("change" + NS, "#fbgCsvFileInput", function () {
            if (this.files && this.files[0]) csvSetFile(this.files[0]);
            this.value = "";
        });
        $(document).on("click" + NS, "#fbgCsvClearFile", () => {
            _csvFile = null;
            $("#fbgCsvFileInfo").hide();
            $("#fbgCsvFileName").text("");
            $("#fbgCsvImportStartBtn").prop("disabled", true);
        });
        // Drag-and-drop on the dropzone
        $(document).on("dragover" + NS, "#fbgCsvDropzone", (e) => {
            e.preventDefault(); e.stopPropagation();
            $("#fbgCsvDropzone").addClass("drag-over");
        });
        $(document).on("dragleave" + NS + " dragend" + NS, "#fbgCsvDropzone", () => {
            $("#fbgCsvDropzone").removeClass("drag-over");
        });
        $(document).on("drop" + NS, "#fbgCsvDropzone", (e) => {
            e.preventDefault(); e.stopPropagation();
            $("#fbgCsvDropzone").removeClass("drag-over");
            const file = e.originalEvent.dataTransfer.files[0];
            if (file) csvSetFile(file);
        });

        // ── Assign Posts to Workflow Modal ────────────────────────
        $(document).on("click" + NS, "#fbgAssignPostsCloseBtn, #fbgAssignPostsCancelBtn, #fbgAssignPostsBackdrop", closeAssignPostsModal);
        $(document).on("click" + NS, "#fbgAssignPostsSaveBtn", saveAssignPosts);
        $(document).on("click" + NS, "#fbgAssignGoLibraryBtn", () => {
            closeAssignPostsModal();
            switchPage("library");
        });
        // Assign modal: search
        $(document).on("input" + NS, "#fbgAssignLibSearch", function () {
            _assignLibSearch = $(this).val().trim();
            _assignLibPage = 1;
            _renderAssignLibList();
        });
        // Assign modal: clear search
        $(document).on("click" + NS, "#fbgAssignLibSearchClear", function () {
            $("#fbgAssignLibSearch").val("");
            _assignLibSearch = "";
            _assignLibPage = 1;
            _renderAssignLibList();
        });
        // Assign modal: add post from library to selected
        $(document).on("click" + NS, ".fbg-asgn-add-btn", function (e) {
            e.stopPropagation();
            const postId = parseInt($(this).data("post-id"));
            const post = _assignAllPosts.find(p => p.id === postId);
            if (!post) return;
            if (!_assignSelected.find(p => p.id === postId)) {
                _assignSelected.push(post);
                _renderAssignSelectedList();
                _renderAssignLibList(); // remove from available list
            }
        });
        // Assign modal: remove from selected
        $(document).on("click" + NS, ".fbg-asgn-remove-btn", function (e) {
            e.stopPropagation();
            const idx = parseInt($(this).data("sel-idx"));
            _assignSelected.splice(idx, 1);
            _renderAssignSelectedList();
            _renderAssignLibList(); // return to available list
        });
        // Assign modal: library pagination
        $(document).on("click" + NS, "#fbgAssignLibPrev", () => {
            if (_assignLibPage > 1) { _assignLibPage--; _renderAssignLibList(); }
        });
        $(document).on("click" + NS, "#fbgAssignLibNext", () => {
            _assignLibPage++; _renderAssignLibList();
        });
        $(document).on("click" + NS, "#fbgAssignLibPagination .fbg-page-btn", function () {
            _assignLibPage = parseInt($(this).data("apage"));
            _renderAssignLibList();
        });
        // Assign modal: Add all visible posts
        $(document).on("click" + NS, "#fbgAssignAddAllBtn", function () {
            const visible = _assignLibFiltered().slice(
                (_assignLibPage - 1) * ASSIGN_PAGE_SIZE,
                _assignLibPage * ASSIGN_PAGE_SIZE
            );
            const selectedIds = new Set(_assignSelected.map(p => p.id));
            for (const p of visible) {
                if (!selectedIds.has(p.id)) _assignSelected.push(p);
            }
            _renderAssignSelectedList();
            _renderAssignLibList();
        });
        // Assign modal: Clear all selected
        $(document).on("click" + NS, "#fbgAssignClearAllBtn", function () {
            if (!_assignSelected.length) return;
            _assignSelected = [];
            _renderAssignSelectedList();
            _renderAssignLibList();
        });
        // Assign modal: drag-to-reorder in selected list
        $(document).on("dragstart" + NS, ".fbg-asgn-sel-item", function (e) {
            _assignDragIdx = parseInt($(this).data("sel-idx"));
            $(this).addClass("fbg-asgn-dragging");
            e.originalEvent.dataTransfer.effectAllowed = "move";
        });
        $(document).on("dragend" + NS, ".fbg-asgn-sel-item", function () {
            $(this).removeClass("fbg-asgn-dragging");
            $("#fbgAssignSelList .fbg-asgn-sel-item").removeClass("fbg-asgn-drag-over");
        });
        $(document).on("dragover" + NS, ".fbg-asgn-sel-item", function (e) {
            e.preventDefault();
            e.originalEvent.dataTransfer.dropEffect = "move";
            $("#fbgAssignSelList .fbg-asgn-sel-item").removeClass("fbg-asgn-drag-over");
            $(this).addClass("fbg-asgn-drag-over");
        });
        $(document).on("drop" + NS, ".fbg-asgn-sel-item", function (e) {
            e.preventDefault();
            const toIdx = parseInt($(this).data("sel-idx"));
            if (_assignDragIdx === null || _assignDragIdx === toIdx) return;
            const moved = _assignSelected.splice(_assignDragIdx, 1)[0];
            _assignSelected.splice(toIdx, 0, moved);
            _assignDragIdx = null;
            _renderAssignSelectedList();
        });
        $(document).on("click" + NS, "#fbgUrlCommentToggle", function (e) {
            if ($(e.target).closest(".fbg-toggle-switch").length) return;
            const $cb = $("#fbgImportUrlComment");
            $cb.prop("checked", !$cb.is(":checked")).trigger("change");
        });
        $(document).on("click" + NS, "#fbgViralToggle", function (e) {
            if ($(e.target).closest(".fbg-toggle-switch").length) return;
            const $cb = $("#fbgImportViralEnabled");
            $cb.prop("checked", !$cb.is(":checked")).trigger("change");
        });

        // ── Manual Workflow: First Comment + Viral toggles ────────
        $(document).on("click" + NS, "#fbgManualUrlCommentToggle", function (e) {
            if ($(e.target).closest(".fbg-toggle-switch").length) return;
            const $cb = $("#fbgManualUrlComment");
            $cb.prop("checked", !$cb.is(":checked")).trigger("change");
        });
        $(document).on("click" + NS, "#fbgManualViralToggle", function (e) {
            if ($(e.target).closest(".fbg-toggle-switch").length) return;
            const $cb = $("#fbgManualViralEnabled");
            $cb.prop("checked", !$cb.is(":checked")).trigger("change");
        });
        $(document).on("change" + NS, "#fbgManualUrlComment", function () {
            $(this).is(":checked") ? $("#fbgManualUrlCommentSection").slideDown(150) : $("#fbgManualUrlCommentSection").slideUp(150);
            syncManualEditCommentOption();
            syncManualInitialComment();
        });
        $(document).on("change" + NS, "#fbgManualViralEnabled", function () {
            if ($(this).is(":checked")) {
                $("#fbgManualViralSection").slideDown(150);
                $("#fbgManualAiRewriteSection").slideDown(150);
            } else {
                $("#fbgManualViralSection").slideUp(150);
                $("#fbgManualAiRewriteSection").slideUp(150);
                $("#fbgManualAiRewrite").prop("checked", false);
                $("#fbgManualAiRewriteBody").hide();
            }
        });
        $(document).on("change" + NS, "#fbgManualViralAction", function () {
            if ($("#fbgManualViralEnabled").is(":checked")) {
                $("#fbgManualAiRewriteSection").slideDown(150);
            }
            syncManualInitialComment();
        });
        $(document).on("change" + NS, "#fbgManualAiRewrite", function () {
            if ($(this).is(":checked")) {
                $("#fbgManualAiRewriteBody").slideDown(150);
                loadConnectedAiProvidersInto("fbgManualAiProvider", "fbgManualAiModel");
            } else {
                $("#fbgManualAiRewriteBody").slideUp(150);
            }
        });
        $(document).on("change" + NS, "#fbgManualAiProvider", function () {
            const provider = $(this).val();
            const $model = $("#fbgManualAiModel");
            const noModel = ["deepseekbrowser","qwenbrowser"];
            if (provider === "openai") {
                $model.val("gpt-5-mini").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").show();
            } else if (noModel.includes(provider)) {
                $model.val("").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").hide();
            } else {
                $model.prop("readonly", false).removeClass("fbg-input-locked").closest(".fbg-form-group").show();
                if ($model.val() === "gpt-5-mini") $model.val("");
            }
        });

        $(document).on("change" + NS, "#fbgImportUrlComment", function () {
            $(this).is(":checked") ? $("#fbgUrlCommentSection").slideDown(150) : $("#fbgUrlCommentSection").slideUp(150);
            syncImportEditCommentOption();
            syncImportInitialComment();
        });
        $(document).on("change" + NS, "#fbgImportViralEnabled", function () {
            if ($(this).is(":checked")) {
                $("#fbgViralSection").slideDown(150);
                $("#fbgAiRewriteSection").slideDown(150);
            } else {
                $("#fbgViralSection").slideUp(150);
                $("#fbgAiRewriteSection").slideUp(150);
                $("#fbgImportAiRewrite").prop("checked", false);
                $("#fbgAiRewriteBody").hide();
            }
        });

        // Sync initial comment when First Comment toggle changes in settings panel
        $(document).on("change" + NS, "#fbgWfUrlComment, #fbgWfPostContentAsComment", syncWfInitialComment);

        // Show/hide AI Rewrite section based on action selection
        $(document).on("change" + NS, "#fbgImportViralAction", function () {
            if ($("#fbgImportViralEnabled").is(":checked")) {
                $("#fbgAiRewriteSection").slideDown(150);
            }
            syncImportInitialComment();
        });
        $(document).on("change" + NS, "#fbgWfViralAction", function () {
            const isEditPost = $(this).val() === 'edit_post';
            // Show/hide the always-visible comment text group
            if (isEditPost) {
                $("#fbgWfEditCommentTextGroup").hide();
            } else {
                $("#fbgWfEditCommentTextGroup").show();
            }
            // Show correct mode-dependent custom body
            if (!$("#fbgWfAiRewrite").is(":checked")) {
                $("#fbgWfEditPostCustomBody").toggle(isEditPost);
                $("#fbgWfEditCommentCustomBody").toggle(!isEditPost);
                $("#fbgWfAiRewriteBody").hide();
            } else {
                $("#fbgWfEditPostCustomBody").hide();
                $("#fbgWfEditCommentCustomBody").hide();
            }
            syncWfInitialComment();
        });

        // Viral automation for URL toggle (settings panel)
        $(document).on("change" + NS, "#fbgWfViralAutoEnabled", function () {
            if ($(this).is(":checked")) {
                $("#fbgWfViralAutoBody").slideDown(150);
            } else {
                $("#fbgWfViralAutoBody").slideUp(150);
            }
        });
        $(document).on("change" + NS, "#fbgWfViralEnabled", function () {
            if ($(this).is(":checked")) {
                $("#fbgWfAiRewriteSection").slideDown(150);
            } else {
                $("#fbgWfAiRewriteSection").slideUp(150);
                $("#fbgWfAiRewrite").prop("checked", false);
                $("#fbgWfAiRewriteBody").hide();
                $("#fbgWfEditPostCustomBody").hide();
                $("#fbgWfEditCommentCustomBody").hide();
                $("#fbgWfEditCommentTextGroup").hide();
            }
        });
        // Mode buttons (settings panel — work for both edit_post and edit_comment)
        $(document).on("click" + NS, "#fbgWfEditModeAiBtn", function () {
            const isEditPost = $("#fbgWfViralAction").val() === 'edit_post';
            $("#fbgWfAiRewrite").prop("checked", true);
            $("#fbgWfAiRewriteBody").slideDown(150);
            $("#fbgWfEditPostCustomBody").slideUp(150);
            $("#fbgWfEditCommentCustomBody").slideUp(150);
            // Comment text group stays visible for edit_comment
            if (!isEditPost) $("#fbgWfEditCommentTextGroup").show();
            $("#fbgWfEditModeAiBtn").css({ background: "var(--accent-color,#0d6efd)", color: "#fff" });
            $("#fbgWfEditModeCustomBtn").css({ background: "var(--bg-primary,#fff)", color: "var(--text-secondary,#6c757d)" });
            loadConnectedAiProvidersInto("fbgWfAiProvider", "fbgWfAiModel");
        });
        $(document).on("click" + NS, "#fbgWfEditModeCustomBtn", function () {
            const isEditPost = $("#fbgWfViralAction").val() === 'edit_post';
            $("#fbgWfAiRewrite").prop("checked", false);
            $("#fbgWfAiRewriteBody").slideUp(150);
            if (isEditPost) {
                $("#fbgWfEditPostCustomBody").slideDown(150);
                $("#fbgWfEditCommentCustomBody").hide();
            } else {
                $("#fbgWfEditCommentCustomBody").slideDown(150);
                $("#fbgWfEditPostCustomBody").hide();
                $("#fbgWfEditCommentTextGroup").show();
            }
            $("#fbgWfEditModeCustomBtn").css({ background: "var(--accent-color,#0d6efd)", color: "#fff" });
            $("#fbgWfEditModeAiBtn").css({ background: "var(--bg-primary,#fff)", color: "var(--text-secondary,#6c757d)" });
        });
        $(document).on("change" + NS, "#fbgWfEditPostKeepLinesEnabled", function () {
            $("#fbgWfEditPostKeepLines").prop("disabled", !$(this).is(":checked"));
        });
        $(document).on("change" + NS, "#fbgWfAiProvider", function () {
            const provider = $(this).val();
            const $model = $("#fbgWfAiModel");
            const noModel = ["deepseekbrowser","qwenbrowser"];
            if (provider === "openai") {
                $model.val("gpt-5-mini").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").show();
            } else if (noModel.includes(provider)) {
                $model.val("").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").hide();
            } else {
                $model.prop("readonly", false).removeClass("fbg-input-locked").closest(".fbg-form-group").show();
                if ($model.val() === "gpt-5-mini") $model.val("");
            }
        });
        $(document).on("change" + NS, "#fbgNWAiRewrite", function () {
            if ($(this).is(":checked")) {
                $("#fbgNWAiRewriteBody").slideDown(150);
                loadConnectedAiProvidersInto("fbgNWAiProvider", "fbgNWAiModel").catch(() => {});
            } else {
                $("#fbgNWAiRewriteBody").slideUp(150);
            }
        });

        // Viral automation for URL toggle
        $(document).on("change" + NS, "#fbgImportViralAutoEnabled", function () {
            if ($(this).is(":checked")) {
                $("#fbgImportViralAutoBody").slideDown(150);
            } else {
                $("#fbgImportViralAutoBody").slideUp(150);
            }
        });
        $(document).on("change" + NS, "#fbgManualViralAutoEnabled", function () {
            if ($(this).is(":checked")) {
                $("#fbgManualViralAutoBody").slideDown(150);
            } else {
                $("#fbgManualViralAutoBody").slideUp(150);
            }
        });

        // Lock / hide model field based on selected provider
        $(document).on("change" + NS, "#fbgImportAiProvider", function () {
            const provider = $(this).val();
            const $model = $("#fbgImportAiModel");
            const noModel = ["deepseekbrowser", "qwenbrowser"];
            if (provider === "openai") {
                $model.val("gpt-5-mini").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").show();
            } else if (noModel.includes(provider)) {
                $model.val("").prop("readonly", true).addClass("fbg-input-locked").closest(".fbg-form-group").hide();
            } else {
                $model.prop("readonly", false).removeClass("fbg-input-locked").closest(".fbg-form-group").show();
                if ($model.val() === "gpt-5-mini") $model.val("");
            }
        });

        // Prompt picker — load selected prompt text into textarea
        $(document).on("change" + NS, "#fbgAiPromptPicker", function () {
            const id = $(this).val();
            if (!id) { $("#fbgAiPromptDeleteBtn").hide(); return; }
            const prompt = (window._fbGroupsAiPrompts || []).find(p => p.id === id);
            if (prompt) {
                $("#fbgImportAiPrompt").val(prompt.text);
                $("#fbgAiPromptDeleteBtn").show();
            }
        });

        // Save prompt button
        $(document).on("click" + NS, "#fbgAiPromptSaveBtn", async function () {
            const text = $("#fbgImportAiPrompt").val().trim();
            if (!text) { alert("Enter a prompt text first."); return; }
            const existingId = $("#fbgAiPromptPicker").val();
            const existing   = existingId && (window._fbGroupsAiPrompts || []).find(p => p.id === existingId);
            let name;
            if (existing) {
                name = existing.name;
            } else {
                const label = t("fb_groups.prompt_save_name", "Name for this prompt:");
                const result = await newPrompt([{ type: "text", name: label, required: true }]);
                if (!result) return;
                name = (result[label] || "").trim();
            }
            if (!name) return;
            const id  = existing ? existing.id : ("p" + Date.now());
            const res = await window.electronAPI.fbGroupsSaveAiPrompt({ id, name, text }).catch(() => null);
            if (res?.success) {
                window._fbGroupsAiPrompts = res.data;
                refreshPromptPicker(id);
            }
        });

        // Delete prompt button
        $(document).on("click" + NS, "#fbgAiPromptDeleteBtn", async function () {
            const id = $("#fbgAiPromptPicker").val();
            if (!id) return;
            $(this).blur();
            if (!await confirmPrompt(t("fb_groups.confirm_delete_prompt","Delete this saved prompt?"))) return;
            const res = await window.electronAPI.fbGroupsDeleteAiPrompt(id).catch(() => null);
            if (res?.success) {
                window._fbGroupsAiPrompts = res.data;
                refreshPromptPicker("");
                $("#fbgImportAiPrompt").val("");
                $("#fbgAiPromptDeleteBtn").hide();
            }
        });
        $(document).on("click" + NS, ".fbg-picker-item[data-wf-id]", function () {
            $(".fbg-picker-item[data-wf-id]").removeClass("selected").find(".material-icons").text("radio_button_unchecked");
            $(this).addClass("selected").find(".material-icons").text("radio_button_checked");
            updateImportConfirmBtn();
        });
        $(document).on("change" + NS, ".fbg-group-target-cb", function () {
            const row = $(this).closest(".fbg-group-target-row");
            row.toggleClass("selected", $(this).is(":checked"));
            row.find(".fbg-group-target-profile").prop("disabled", !$(this).is(":checked"));
            updateImportConfirmBtn();
        });

        // Dashboard auto-refresh
        dashRefreshInterval = setInterval(async () => {
            if (currentNavPage === "dashboard") await loadDashboardStats();
        }, 30000);

        // New group button (header + empty state)
        $(document).on("click" + NS, "#fbgNewGroupBtn, #fbgEmptyNewBtn", () => showCreateModal());

        // Search input — debounced
        $(document).on("input" + NS, "#fbgSearch", function () {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => applySearch($(this).val()), 250);
        });

        // Card click → open detail
        $(document).on("click" + NS, ".group-card", function (e) {
            if ($(e.target).closest("[data-stop-propagation], [data-action], .group-card-url").length) return;
            const id = $(this).data("id");
            if (id) openDetailPanel(id);
        });

        // Card URL link → external
        $(document).on("click" + NS, ".group-card-url, [data-url]", function (e) {
            e.preventDefault();
            e.stopPropagation();
            const url = $(this).data("url");
            if (url) window.electronAPI.openExternal(url);
        });

        // Edit card button
        $(document).on("click" + NS, "[data-action='edit']", function (e) {
            e.stopPropagation();
            showEditModal($(this).data("id"));
        });

        // Delete card button
        $(document).on("click" + NS, "[data-action='delete']", function (e) {
            e.stopPropagation();
            deleteGroup($(this).data("id"));
        });

        // Pagination
        $(document).on("click" + NS, ".fbg-page-btn[data-page]", function () {
            if ($(this).hasClass("active")) return;
            currentPage = parseInt($(this).data("page"), 10);
            renderGrid();
            // Scroll content to top
            $("#fbgContent").scrollTop(0);
        });
        $(document).on("click" + NS, "#fbgPrevPage", function () {
            if (currentPage > 1) { currentPage--; renderGrid(); $("#fbgContent").scrollTop(0); }
        });
        $(document).on("click" + NS, "#fbgNextPage", function () {
            const totalPages = Math.ceil(filteredGroups.length / GROUPS_PER_PAGE);
            if (currentPage < totalPages) { currentPage++; renderGrid(); $("#fbgContent").scrollTop(0); }
        });

        // Close detail panel
        $(document).on("click" + NS, "#fbgPanelBack", closeDetailPanel);
        $(document).on("click" + NS, "#fbgOverlay", closeDetailPanel);

        // Edit from detail panel
        $(document).on("click" + NS, "#fbgPanelEditBtn", function () {
            if (currentGroupId) showEditModal(currentGroupId);
        });

        // New Post from detail panel
        $(document).on("click" + NS, "#fbgNewPostBtn", function () {
            if (currentGroupId) showNewPostModal(currentGroupId);
        });

        // Scan public group info (test) from detail panel
        $(document).on("click" + NS, "#fbgScanInfoBtn", function () {
            if (currentGroupId) scanGroupInfo(currentGroupId);
        });

        // Buttons removed from UI — functions still available: showAddCommentModal(groupId), showScanPostModal(groupId)
        // $(document).on("click" + NS, "#fbgCommentBtn",  function () { if (currentGroupId) showAddCommentModal(currentGroupId); });
        // $(document).on("click" + NS, "#fbgScanPostBtn", function () { if (currentGroupId) showScanPostModal(currentGroupId); });

        // Test Flow button — create post with image, then comment on it with same image
        // Add profile from detail panel
        $(document).on("click" + NS, "#fbgAddProfileBtn", function () {
            if (currentGroupId) showAddProfileModal(currentGroupId);
        });

        // Remove profile chip
        $(document).on("click" + NS, "[data-action='remove-profile']", async function (e) {
            e.stopPropagation();
            const groupId   = $(this).data("group");
            const profileId = $(this).data("profile");
            $(this).blur();
            const confirmed = await confirmPrompt(t("fb_groups.confirm_remove_profile", "Remove this profile from the group?"));
            if (!confirmed) return;
            const res = await window.electronAPI.fbGroupsRemoveProfile(groupId, profileId);
            if (res && res.success) {
                await loadPanelProfiles(groupId);
                await loadData();
            }
        });

        // Verify / scan a linked profile (login health + identity)
        $(document).on("click" + NS, "[data-action='scan-profile']", function (e) {
            e.stopPropagation();
            const profileId = $(this).data("profile");
            const profileLabel = $(this).data("label");
            $(this).blur();
            if (profileId) scanProfile(String(profileId), profileLabel != null ? String(profileLabel) : "");
        });

        // Post log pagination
        $(document).on("click" + NS, ".fbg-page-btn[data-log-page], .fbg-log-nav-btn[data-log-page]", function () {
            if ($(this).is(":disabled")) return;
            const p = parseInt($(this).data("log-page"), 10);
            if (!isNaN(p) && p > 0 && currentGroupId) {
                loadPanelLog(currentGroupId, p);
            }
        });

        // Post log action buttons: open in browser / copy link / set link
        $(document).on("click" + NS, ".fbg-log-action-btn[data-action='open']", function () {
            const url = $(this).data("post-url");
            if (url) window.electronAPI.openExternal(url);
        });

        $(document).on("click" + NS, ".fbg-log-action-btn[data-action='copy']", function () {
            const url = $(this).data("post-url");
            if (!url) return;
            navigator.clipboard.writeText(url).then(() => {
                const $btn = $(this);
                const $icon = $btn.find(".material-icons");
                $icon.text("check");
                $btn.addClass("copied");
                setTimeout(() => {
                    $icon.text("content_copy");
                    $btn.removeClass("copied");
                }, 1500);
            }).catch(() => {
                // Fallback for clipboard permission issues
                const ta = document.createElement("textarea");
                ta.value = url;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
            });
        });
    }

    // ── Cleanup on page navigation ───────────────────────────────
    // Called by app.js cleanupCurrentPage() when navigating away
    window.currentPageCleanup = function () {
        $(document).off(NS);
        if (dashRefreshInterval) { clearInterval(dashRefreshInterval); dashRefreshInterval = null; }
        if (postsRefreshInterval) { clearInterval(postsRefreshInterval); postsRefreshInterval = null; }
        if (workflowsRefreshInterval) { clearInterval(workflowsRefreshInterval); workflowsRefreshInterval = null; }
        if (workflowsCountdownInterval) { clearInterval(workflowsCountdownInterval); workflowsCountdownInterval = null; }
        if (profilesRefreshInterval) { clearInterval(profilesRefreshInterval); profilesRefreshInterval = null; }
        if (postsCountdownInterval) { clearInterval(postsCountdownInterval); postsCountdownInterval = null; }
        $("#fbgAddProfileModal").remove();
        // Unregister page callbacks — global manager keeps IPC listeners alive
        if (window.fbGroupsManager) window.fbGroupsManager.clearPageCallbacks();
    };

    // ── Kick off ────────────────────────────────────────────────
    init();
});
