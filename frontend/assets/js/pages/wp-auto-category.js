(function () {
  const NS = ".wpAutoCategory";
  let wpSites = {};
  let fetchedPosts = [];
  let siteCategories = [];
  let selectedSiteId = null;

  // ── Init ──
  async function init() {
    await loadWordPressSites();
    bindEvents();
  }

  async function loadWordPressSites() {
    wpSites = (await window.electronAPI.readKey("wordpressSites")) || {};
    const $select = $("#wpacSiteSelect");
    $select.find("option:not(:first)").remove();
    for (const [id, site] of Object.entries(wpSites)) {
      $select.append(
        `<option value="${id}">${escapeHtml(site.name)} (${escapeHtml(site.url)})</option>`
      );
    }
  }

  function bindEvents() {
    $(document).on("change" + NS, "#wpacSiteSelect", function () {
      selectedSiteId = $(this).val();
      $("#wpacFetchBtn").prop("disabled", !selectedSiteId);
      resetUI();
    });

    $(document).on("click" + NS, "#wpacFetchBtn", fetchUncategorizedPosts);
    $(document).on("click" + NS, "#wpacCategorizeBtn", categorizeSelectedPosts);
    $(document).on("click" + NS, "#wpacSelectAll", toggleSelectAll);

    $(document).on("change" + NS, "#wpacCheckAll", function () {
      const checked = $(this).prop("checked");
      $(".wpac-post-check").prop("checked", checked);
      updateCategorizeButton();
    });

    $(document).on("change" + NS, ".wpac-post-check", updateCategorizeButton);
  }

  // ── Fetch Uncategorized Posts ──
  async function fetchUncategorizedPosts() {
    if (!selectedSiteId) return;
    resetUI();
    showStatus("hourglass_empty", window.I18n?.t("wp_auto_category.fetching_posts") || "Fetching uncategorized posts...", true);

    try {
      const result = await window.electronAPI.wpacFetchUncategorized(selectedSiteId);
      if (!result.success) {
        showStatus("error", result.error || "Failed to fetch posts", false);
        return;
      }

      fetchedPosts = result.posts || [];
      siteCategories = result.categories || [];

      if (fetchedPosts.length === 0) {
        showStatus("check_circle", window.I18n?.t("wp_auto_category.no_uncategorized") || "No uncategorized posts found!", false);
        return;
      }

      hideStatus();
      renderPostsTable();
    } catch (err) {
      console.error("[WP-AUTO-CAT] Fetch error:", err);
      showStatus("error", err.message || "An error occurred", false);
    }
  }

  // ── Render Posts Table ──
  function renderPostsTable() {
    const $body = $("#wpacPostsBody");
    $body.empty();

    for (const post of fetchedPosts) {
      const title = post.title?.rendered || post.title || "(No title)";
      $body.append(`
        <tr data-post-id="${post.id}">
          <td><input type="checkbox" class="wpac-post-check" data-id="${post.id}"></td>
          <td class="wpac-post-title">${escapeHtml(decodeEntities(title))}</td>
          <td class="wpac-current-cat">
            <span class="wpac-cat-tag wpac-cat-uncategorized">${window.I18n?.t("wp_auto_category.uncategorized") || "Uncategorized"}</span>
          </td>
          <td class="wpac-ai-suggestion" data-id="${post.id}">—</td>
          <td class="wpac-post-status" data-id="${post.id}">
            <span class="wpac-status-pending">${window.I18n?.t("wp_auto_category.pending") || "Pending"}</span>
          </td>
        </tr>
      `);
    }

    $("#wpacPostCount").text(fetchedPosts.length);
    $("#wpacPostsSection").show();
    if (window.I18n) window.I18n.translatePage(document.getElementById("wpacPostsSection"));
  }

  // ── Categorize Selected Posts ──
  async function categorizeSelectedPosts() {
    const selectedIds = getSelectedPostIds();
    if (selectedIds.length === 0) return;

    const postsToProcess = fetchedPosts.filter((p) => selectedIds.includes(String(p.id)));

    // Disable buttons during processing
    $("#wpacCategorizeBtn").prop("disabled", true).addClass("wpac-btn-loading");
    $("#wpacFetchBtn").prop("disabled", true);
    $(".wpac-post-check, #wpacCheckAll").prop("disabled", true);

    showStatus("auto_fix_high", window.I18n?.t("wp_auto_category.categorizing") || "Categorizing posts with AI...", true);

    let successCount = 0;
    let failCount = 0;
    let completedCount = 0;
    const CONCURRENCY = 5;

    // Mark all as processing
    for (const post of postsToProcess) {
      updatePostStatus(post.id, "processing");
    }

    async function processPost(post) {
      const title = post.title?.rendered || post.title || "";
      const postId = post.id;

      try {
        const result = await window.electronAPI.wpacCategorizePost(
          selectedSiteId,
          postId,
          decodeEntities(title),
          siteCategories
        );

        if (result.success) {
          successCount++;
          updatePostStatus(postId, "success", result.categoryName);
          updateAISuggestion(postId, result.categoryName);
        } else {
          failCount++;
          updatePostStatus(postId, "error", result.error);
        }
      } catch (err) {
        failCount++;
        updatePostStatus(postId, "error", err.message);
      }

      completedCount++;
      const pct = Math.round((completedCount / postsToProcess.length) * 100);
      updateProgress(pct, `${completedCount}/${postsToProcess.length}`);
    }

    // Process in concurrent batches
    const queue = [...postsToProcess];
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const post = queue.shift();
          await processPost(post);
        }
      })());
    }
    await Promise.all(workers);

    // Done
    hideStatus();
    showResults(successCount, failCount);

    // Re-enable UI
    $("#wpacCategorizeBtn").removeClass("wpac-btn-loading");
    $("#wpacFetchBtn").prop("disabled", false);
    $(".wpac-post-check, #wpacCheckAll").prop("disabled", false);
    updateCategorizeButton();
  }

  // ── UI Helpers ──
  function showStatus(icon, text, showProgress) {
    $("#wpacStatusIcon").text(icon);
    $("#wpacStatusText").text(text);
    if (showProgress) {
      $(".wpac-progress-wrap").show();
      updateProgress(0, "0%");
    } else {
      $(".wpac-progress-wrap").hide();
    }
    $("#wpacStatusBar").show();
  }

  function hideStatus() {
    $("#wpacStatusBar").hide();
  }

  function updateProgress(pct, label) {
    $("#wpacProgressFill").css("width", pct + "%");
    $("#wpacProgressLabel").text(label || pct + "%");
  }

  function updatePostStatus(postId, status, detail) {
    const $td = $(`.wpac-post-status[data-id="${postId}"]`);
    if (status === "processing") {
      $td.html('<span class="wpac-status-processing"><span class="wpac-spinner"></span> ' + (window.I18n?.t("wp_auto_category.processing") || "Processing...") + "</span>");
    } else if (status === "success") {
      $td.html('<span class="wpac-status-success"><span class="material-icons">check_circle</span> ' + (window.I18n?.t("wp_auto_category.done") || "Done") + "</span>");
    } else if (status === "error") {
      $td.html('<span class="wpac-status-error"><span class="material-icons">error</span> ' + escapeHtml(detail || "Error") + "</span>");
    }
  }

  function updateAISuggestion(postId, categoryName) {
    const $td = $(`.wpac-ai-suggestion[data-id="${postId}"]`);
    $td.html(`<span class="wpac-cat-tag wpac-cat-assigned">${escapeHtml(categoryName)}</span>`);
  }

  function showResults(success, fail) {
    $("#wpacSuccessCount").text(success);
    $("#wpacFailCount").text(fail);
    $("#wpacResultsSummary").show();
  }

  function resetUI() {
    fetchedPosts = [];
    siteCategories = [];
    $("#wpacPostsSection").hide();
    $("#wpacPostsBody").empty();
    $("#wpacResultsSummary").hide();
    hideStatus();
  }

  function getSelectedPostIds() {
    return $(".wpac-post-check:checked")
      .map(function () { return $(this).data("id").toString(); })
      .get();
  }

  function updateCategorizeButton() {
    const count = $(".wpac-post-check:checked").length;
    $("#wpacCategorizeBtn").prop("disabled", count === 0);
  }

  function toggleSelectAll() {
    const allChecked = $(".wpac-post-check").length === $(".wpac-post-check:checked").length;
    $(".wpac-post-check").prop("checked", !allChecked);
    $("#wpacCheckAll").prop("checked", !allChecked);
    updateCategorizeButton();
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function decodeEntities(str) {
    const txt = document.createElement("textarea");
    txt.innerHTML = str;
    return txt.value;
  }

  // ── Cleanup ──
  window.currentPageCleanup = function () {
    $(document).off(NS);
    $("#pagesContent").off(NS);
  };

  init();
})();
