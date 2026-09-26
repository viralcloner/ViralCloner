(() => {
  const NS = ".mailboxes";
  const PAGE_SIZE = 50;
  const AUTO_REFRESH_STORAGE_KEY = "mailboxAutoRefreshMinutes";
  const state = {
    page: 1, total: 0, selected: new Set(), mailboxes: new Map(), tags: [],
    testToken: null, activeJobId: null, reader: null,
    outlookPollTimer: null, outlookPolling: false, outlookDone: false,
    autoRefreshMinutes: 0,
  };
  let moveFolderResolver = null;

  const t = (key, fallback, vars) => window.I18n?.t(`mailboxes.${key}`, vars) || fallback;
  const esc = (value) => $("<div>").text(value == null ? "" : String(value)).html();
  const showError = (message) => window.showAlert?.("error", message);
  const showSuccess = (message) => window.showAlert?.("success", message);
  const formatDate = (value) => value ? new Date(value).toLocaleString() : t("never", "Never");
  const statusText = (health) => ({ healthy: t("healthy", "Healthy"), error: t("error", "Error"), untested: t("untested", "Untested") }[health] || t("untested", "Untested"));

  function formatRelativeTime(value) {
    if (!value) return t("never", "Never");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("never", "Never");
    const diffMs = date.getTime() - Date.now();
    const absMs = Math.abs(diffMs);
    const locale = window.I18n?.getLocale?.() || "en";
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

    if (absMs < 60 * 1000) return rtf.format(Math.round(diffMs / 1000), "second");
    if (absMs < 60 * 60 * 1000) return rtf.format(Math.round(diffMs / (60 * 1000)), "minute");
    if (absMs < 24 * 60 * 60 * 1000) return rtf.format(Math.round(diffMs / (60 * 60 * 1000)), "hour");
    return rtf.format(Math.round(diffMs / (24 * 60 * 60 * 1000)), "day");
  }

  function setButtonLoading(target, loading = true) {
    const $button = target?.jquery ? target : $(target || []);
    if (!$button.length) return () => {};
    if (loading) {
      $button.each((_, button) => {
        const $item = $(button);
        $item.data("mailboxPreviousDisabled", $item.prop("disabled"));
        $item.prop("disabled", true).addClass("is-loading").attr("aria-busy", "true");
      });
      return () => setButtonLoading($button, false);
    }
    $button.each((_, button) => {
      const $item = $(button);
      $item.prop("disabled", Boolean($item.data("mailboxPreviousDisabled"))).removeClass("is-loading").removeAttr("aria-busy").removeData("mailboxPreviousDisabled");
    });
    return () => {};
  }

  async function withButtonLoading(target, operation) {
    const release = setButtonLoading(target);
    try { return await operation(); } finally { release(); }
  }

  async function result(call) {
    const response = await call;
    if (!response?.success) {
      const error = new Error(response?.error || t("operation_failed", "The operation could not be completed."));
      error.reason = response?.reason || null;
      throw error;
    }
    return response.data;
  }

  function renderAutoRefreshOptions() {
    const current = String(state.autoRefreshMinutes || 0);
    const options = [
      { value: 0, label: t("auto_refresh_off", "Off") },
      { value: 1, label: t("auto_refresh_every_minutes", "Every {{minutes}} min", { minutes: 1 }) },
      { value: 5, label: t("auto_refresh_every_minutes", "Every {{minutes}} min", { minutes: 5 }) },
      { value: 10, label: t("auto_refresh_every_minutes", "Every {{minutes}} min", { minutes: 10 }) },
      { value: 15, label: t("auto_refresh_every_minutes", "Every {{minutes}} min", { minutes: 15 }) },
      { value: 30, label: t("auto_refresh_every_minutes", "Every {{minutes}} min", { minutes: 30 }) },
      { value: 60, label: t("auto_refresh_every_minutes", "Every {{minutes}} min", { minutes: 60 }) },
    ];
    $("#mailboxAutoRefresh").html(options.map((option) => `<option value="${option.value}">${esc(option.label)}</option>`).join("")).val(current);
  }

  async function loadAutoRefreshPreference() {
    const stored = await window.electronAPI.readKey(AUTO_REFRESH_STORAGE_KEY);
    state.autoRefreshMinutes = stored == null || stored === "" ? 5 : ([0, 1, 5, 10, 15, 30, 60].includes(Number(stored)) ? Number(stored) : 5);
    renderAutoRefreshOptions();
    if (window.mailboxAutoRefreshManager) {
      const managerMinutes = window.mailboxAutoRefreshManager.getMinutes?.();
      if (Number(managerMinutes) !== Number(state.autoRefreshMinutes)) {
        state.autoRefreshMinutes = Number(managerMinutes) || state.autoRefreshMinutes;
        renderAutoRefreshOptions();
      }
    }
  }

  async function saveAutoRefreshPreference(minutes) {
    state.autoRefreshMinutes = [0, 1, 5, 10, 15, 30, 60].includes(Number(minutes)) ? Number(minutes) : 0;
    renderAutoRefreshOptions();
    if (window.mailboxAutoRefreshManager) {
      await window.mailboxAutoRefreshManager.setMinutes(state.autoRefreshMinutes);
    } else {
      await window.electronAPI.updateData(AUTO_REFRESH_STORAGE_KEY, state.autoRefreshMinutes);
    }
  }

  // Show the styled IMAP-enable help popup when a failure is the consumer
  // mailbox "authenticated but not connected" state; otherwise show the toast.
  function reportMailboxError(error) {
    if (error?.reason === "imap_not_connected") { showImapHelpModal(); return; }
    showError(error.message);
  }

  function queryOptions() {
    return {
      query: $("#mailboxSearch").val(), protocol: $("#mailboxProtocolFilter").val(), health: $("#mailboxHealthFilter").val(),
      tag: $("#mailboxTagFilter").val(), sort: $("#mailboxSort").val(), page: state.page, pageSize: PAGE_SIZE,
    };
  }

  function renderTagOptions(tags) {
    const selected = $("#mailboxTagFilter").val();
    const options = [`<option value="">${esc(t("all_tags", "All tags"))}</option>`]
      .concat(tags.map((tag) => `<option value="${esc(tag)}">${esc(tag)}</option>`));
    $("#mailboxTagFilter").html(options.join("")).val(selected);
  }

  function updateSummary(summary) {
    $("#mailboxTotal").text(summary.total || 0);
    $("#mailboxHealthy").text(summary.healthy || 0);
    $("#mailboxErrors").text(summary.error || 0);
    $("#mailboxUnread").text(summary.unread || 0);
  }

  function renderTable(items) {
    const $body = $("#mailboxTableBody").empty();
    state.mailboxes = new Map(items.map((mailbox) => [mailbox.id, mailbox]));
    const checked = (id) => state.selected.has(id) ? "checked" : "";
    items.forEach((mailbox) => {
      const tags = mailbox.tags?.length ? mailbox.tags.map((tag) => `<span class="mailbox-tag">${esc(tag)}</span>`).join("") : '<span class="text-muted">—</span>';
      const title = mailbox.healthMessage ? `title="${esc(mailbox.healthMessage)}"` : "";
      const suspensionBadge = mailbox.suspensionAlert ? `<span class="mailbox-warning-badge" title="${esc(t("account_suspension_warning", "This email may indicate your account has been suspended or locked. Review immediately and take any required actions."))}"><i class="material-icons">warning</i>${esc(`${mailbox.suspensionAlert.platform} ${t("account_alert", "Account Alert")}`)}</span>` : "";
      const newMailCount = window.mailboxNotificationManager?.getMailboxCount?.(mailbox.id) || 0;
      const unreadBadge = newMailCount > 0 ? `<span class="mailbox-row-unread-badge">${newMailCount}</span>` : "";
      $body.append(`<tr>
        <td><input type="checkbox" class="form-check-input mailbox-select" data-id="${mailbox.id}" ${checked(mailbox.id)} aria-label="Select ${esc(mailbox.label)}"></td>
        <td><div class="mailbox-address"><i class="material-icons">alternate_email</i><div><strong>${esc(mailbox.label)}</strong><small>${esc(mailbox.email)} · ${esc(mailbox.host)}</small>${suspensionBadge}</div></div></td>
        <td><span class="badge text-bg-light border">${mailbox.protocol === "pop3" ? "POP3" : "IMAP"}</span></td>
        <td>${tags}</td><td>${mailbox.unreadCount || 0}</td><td><small title="${esc(formatDate(mailbox.lastRefreshedAt))}">${esc(formatRelativeTime(mailbox.lastRefreshedAt))}</small></td>
        <td><span class="mailbox-health ${esc(mailbox.health)}" ${title}><span class="dot"></span>${esc(statusText(mailbox.health))}</span></td>
        <td><div class="mailbox-action-buttons"><div class="mailbox-open-button-wrapper"><button class="btn btn-sm btn-outline-primary" data-action="open" data-id="${mailbox.id}" title="${esc(t("open", "Open inbox"))}"><i class="material-icons">inbox</i></button>${unreadBadge}</div><button class="btn btn-sm btn-outline-secondary" data-action="refresh" data-id="${mailbox.id}" title="${esc(t("refresh", "Refresh"))}"><i class="material-icons">refresh</i></button><div class="mailbox-action-dropdown"><button class="btn btn-sm btn-outline-secondary mailbox-menu-toggle" data-id="${mailbox.id}" title="More actions"><i class="material-icons">more_vert</i></button><div class="mailbox-action-menu d-none"><button class="dropdown-item" data-action="retest" data-id="${mailbox.id}"><i class="material-icons">fact_check</i><span>${esc(t("retest", "Retest connection"))}</span></button><button class="dropdown-item" data-action="clear-cache" data-id="${mailbox.id}"><i class="material-icons">cleaning_services</i><span>${esc(t("clear_cache", "Clear cache"))}</span></button><button class="dropdown-item" data-action="edit" data-id="${mailbox.id}"><i class="material-icons">edit</i><span>${esc(t("edit", "Edit"))}</span></button><button class="dropdown-item dropdown-item-danger" data-action="delete-mailbox" data-id="${mailbox.id}"><i class="material-icons">delete</i><span>${esc(t("delete", "Delete"))}</span></button></div></div></div></td>
      </tr>`);
    });
    $("#mailboxEmpty").toggleClass("d-none", items.length !== 0);
    $(".mailbox-table").toggleClass("d-none", items.length === 0);
    $("#mailboxSelectAll").prop("checked", items.length > 0 && items.every((mailbox) => state.selected.has(mailbox.id)));
    renderSelection();
  }

  function renderSelection() {
    const count = state.selected.size;
    $("#mailboxSelectedCount").text(count);
    $("#mailboxBulkBar").toggleClass("d-none", !count);
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    $("#mailboxPageInfo").text(`${t("page", "Page")} ${state.page} / ${pages}`);
    $("#mailboxPrevPage").prop("disabled", state.page <= 1);
    $("#mailboxNextPage").prop("disabled", state.page >= pages);
  }

  async function loadMailboxes(resetPage = false) {
    if (resetPage) state.page = 1;
    try {
      const data = await result(window.electronAPI.mailboxesList(queryOptions()));
      state.total = data.total; state.tags = data.tags || [];
      updateSummary(data.summary || {});
      renderTagOptions(data.tags || []); renderTable(data.items || []); renderPagination();
    } catch (error) { showError(error.message); }
  }

  function formConfig() {
    return {
      label: $("#mailboxLabel").val(), email: $("#mailboxEmail").val(), username: $("#mailboxUsername").val(), password: $("#mailboxPassword").val(),
      protocol: $("#mailboxProtocol").val(), host: $("#mailboxHost").val(), port: $("#mailboxPort").val(), tlsMode: $("#mailboxTlsMode").val(),
      tags: $("#mailboxTags").val(), notes: $("#mailboxNotes").val(),
    };
  }

  function clearTestState() {
    state.testToken = null;
    $("#mailboxSaveBtn").prop("disabled", true);
    $("#mailboxTestStatus").text(t("test_required", "Test the connection before saving."));
  }

  function defaultsForProtocol() {
    const protocol = $("#mailboxProtocol").val();
    const tlsMode = $("#mailboxTlsMode").val();
    $("#mailboxHost").attr("placeholder", protocol === "imap" ? "imap.example.com" : "pop.example.com");
    $("#mailboxPort").val(tlsMode === "tls" ? (protocol === "imap" ? 993 : 995) : (protocol === "imap" ? 143 : 110));
  }

  function openMailboxModal(mailbox = null) {
    const editing = Boolean(mailbox);
    $("#mailboxForm")[0].reset();
    $("#mailboxFormError").addClass("d-none").text("");
    $("#mailboxEditId").val(mailbox?.id || "");
    $("#mailboxModalTitle").text(editing ? t("edit_mailbox", "Edit mailbox") : t("add", "Add mailbox"));
    if (mailbox) {
      $("#mailboxLabel").val(mailbox.label); $("#mailboxEmail").val(mailbox.email); $("#mailboxUsername").val("").prop("required", false).attr("placeholder", t("leave_username", "Leave blank to keep the saved username"));
      $("#mailboxPassword").val("").prop("required", false).attr("placeholder", t("leave_password", "Leave blank to keep the saved password"));
      $("#mailboxProtocol").val(mailbox.protocol); $("#mailboxHost").val(mailbox.host); $("#mailboxPort").val(mailbox.port);
      $("#mailboxTlsMode").val(mailbox.tlsMode); $("#mailboxTags").val((mailbox.tags || []).join(", ")); $("#mailboxNotes").val(mailbox.notes || "");
    } else {
      $("#mailboxUsername").prop("required", true).attr("placeholder", "");
      $("#mailboxPassword").prop("required", true).attr("placeholder", ""); defaultsForProtocol();
    }
    clearTestState();
    bootstrap.Modal.getOrCreateInstance(document.getElementById("mailboxModal")).show();
  }

  async function testMailboxForm() {
    const $button = $("#mailboxTestBtn");
    const releaseButton = setButtonLoading($button);
    const mailboxId = $("#mailboxEditId").val() || null;
    $("#mailboxFormError").addClass("d-none"); $("#mailboxTestStatus").text(t("testing", "Testing secure connection…"));
    try {
      const data = await result(window.electronAPI.mailboxesTest(formConfig(), mailboxId));
      state.testToken = data.testToken;
      $("#mailboxTestStatus").text(t("test_success", "Connection verified. Ready to save.")).removeClass("text-danger").addClass("text-success");
      $("#mailboxSaveBtn").prop("disabled", false);
    } catch (error) {
      state.testToken = null; $("#mailboxSaveBtn").prop("disabled", true);
      $("#mailboxFormError").removeClass("d-none").text(error.message);
      $("#mailboxTestStatus").text(t("test_failed", "Connection failed.")).removeClass("text-success").addClass("text-danger");
    } finally { releaseButton(); }
  }

  async function saveMailboxForm(event) {
    event.preventDefault();
    if (!state.testToken) return;
    const $button = $("#mailboxSaveBtn");
    const releaseButton = setButtonLoading($button);
    try {
      await result(window.electronAPI.mailboxesSave(formConfig(), state.testToken, $("#mailboxEditId").val() || null));
      bootstrap.Modal.getInstance(document.getElementById("mailboxModal")).hide();
      showSuccess(t("saved", "Mailbox saved.")); await loadMailboxes();
    } catch (error) { $("#mailboxFormError").removeClass("d-none").text(error.message); }
    finally { releaseButton(); }
  }

  async function withRowBusy(action, mailboxId, control = null) {
    const mailbox = state.mailboxes.get(mailboxId);
    if (!mailbox) return;
    if (action === "edit") return openMailboxModal(mailbox);
    if (action === "open") {
      window.mailboxNotificationManager?.clearMailboxCount?.(mailboxId);
      return openReader(mailbox, control);
    }
    if (action === "clear-cache" && !await confirmPrompt(t("clear_cache_confirm", "Clear the encrypted offline cache for this mailbox?"))) return;
    if (action === "delete-mailbox" && !await confirmPrompt(t("delete_mailbox_confirm", "Delete this mailbox and its encrypted cached mail?"))) return;
    const releaseButton = setButtonLoading(control);
    try {
      if (action === "refresh") {
        const refreshData = await result(window.electronAPI.mailboxesRefresh(mailboxId, { folderPath: "INBOX" }));
        const newMessages = Math.max(0, Number(refreshData?.newMessages) || 0);
        if (newMessages > 0) {
          window.mailboxNotificationManager?.applyRefreshResults?.({ [String(mailboxId)]: newMessages });
        }
        showSuccess(t("refresh_complete", "Inbox refreshed."));
      } else if (action === "retest") {
        await result(window.electronAPI.mailboxesTest({}, mailboxId));
        showSuccess(t("retest_success", "Connection verified."));
      } else if (action === "clear-cache") {
        await result(window.electronAPI.mailboxesClearCache(mailboxId));
        showSuccess(t("cache_cleared", "Mailbox cache cleared."));
      } else if (action === "delete-mailbox") {
        await result(window.electronAPI.mailboxesDelete(mailboxId)); state.selected.delete(mailboxId); showSuccess(t("mailbox_deleted", "Mailbox deleted."));
      }
      await loadMailboxes();
    } catch (error) { reportMailboxError(error); } finally { releaseButton(); }
  }

  function readerMessageIds() { return $(".mail-message-select:checked").map((_, el) => $(el).data("id")).get(); }
  function readerSupportsImap() { return state.reader?.mailbox?.protocol === "imap"; }

  function isRecentMailboxRefresh(mailbox, maxAgeMs = 3 * 60 * 1000) {
    const refreshedAt = Date.parse(mailbox?.lastRefreshedAt || "");
    return Number.isFinite(refreshedAt) && (Date.now() - refreshedAt) <= maxAgeMs;
  }

  async function openReader(mailbox, control = null) {
    state.reader = { mailbox, folderPath: "INBOX", folders: [], messages: [], messagePage: 1, selectedMessageId: null, oldest: null, loading: false };
    $("#mailboxManagerView").addClass("d-none"); $("#mailboxReaderView").removeClass("d-none");
    $("#mailReaderTitle").text(mailbox.label); $("#mailReaderMeta").text(`${mailbox.email} · ${mailbox.protocol === "imap" ? "IMAP" : "POP3"}`);
    try {
      await withButtonLoading(control, async () => {
        const useCache = isRecentMailboxRefresh(mailbox);
        await loadFolders(!useCache);
        if (useCache) await loadReaderMessages(); else await refreshReaderFolder();
      });
    } catch (error) { reportMailboxError(error); await loadReaderMessages(); }
  }

  async function loadFolders(refresh = false) {
    setFoldersLoading(true);
    try {
      const folders = await result(window.electronAPI.mailboxesFolders(state.reader.mailbox.id, refresh));
      state.reader.folders = folders; renderFolders();
    } finally { setFoldersLoading(false); }
  }

  function setFoldersLoading(loading) {
    $("#mailReaderFoldersLoading").toggleClass("d-none", !loading);
    $("#mailReaderFolderList").toggleClass("is-loading", Boolean(loading));
  }

  function renderFolders() {
    const $list = $("#mailReaderFolderList").empty();
    state.reader.folders.forEach((folder) => {
      const active = folder.path === state.reader.folderPath ? "active" : "";
      const icon = /trash/i.test(folder.specialUse || "") ? "delete_outline" : /sent/i.test(folder.specialUse || "") ? "send" : /draft/i.test(folder.specialUse || "") ? "drafts" : "folder";
      $list.append(`<button class="mail-folder-btn ${active}" data-path="${esc(folder.path)}"><i class="material-icons">${icon}</i><span>${esc(folder.name)}</span></button>`);
    });
  }

  async function refreshReaderFolder(options = {}, control = null) {
    if (!state.reader) return;
    setReaderLoading(true);
    try {
      await withButtonLoading(control, async () => {
        await result(window.electronAPI.mailboxesRefresh(state.reader.mailbox.id, { folderPath: state.reader.folderPath, ...options }));
        state.reader.messagePage = options.beforeUid ? state.reader.messagePage + 1 : 1;
        await loadReaderMessages(); await loadMailboxes();
      });
    } finally { setReaderLoading(false); }
  }

  function renderReaderMessageControls() {
    const selection = readerMessageIds();
    $("#mailReaderActions").toggleClass("d-none", selection.length === 0);
    $("#mailReaderActions [data-action]").prop("disabled", !readerSupportsImap());
    $("#mailReaderActions [data-action='delete']").prop("disabled", false);
  }

  function renderReaderMessages(data) {
    state.reader.messages = data.items || []; state.reader.oldest = data.oldest;
    const $list = $("#mailReaderMessageList").empty();
    if (!data.items?.length) $list.html(`<div class="p-4 text-center text-muted">${esc(t("no_messages", "No cached messages in this folder."))}</div>`);
    data.items.forEach((message) => {
      const active = message.id === state.reader.selectedMessageId ? "active" : "";
      $list.append(`<div class="mail-message-row ${message.unread ? "unread" : ""} ${active}" data-id="${message.id}"><input class="form-check-input mail-message-select" type="checkbox" data-id="${message.id}" aria-label="Select message"><div class="mail-message-head"><div class="mail-message-top"><span class="mail-message-from">${esc(message.from || t("unknown_sender", "Unknown sender"))}</span><span class="mail-message-date" title="${esc(formatDate(message.date))}">${esc(formatRelativeTime(message.date))}</span></div><div class="mail-message-subject">${esc(message.subject)}</div><div class="mail-message-preview">${esc(message.preview)}</div></div>${message.flagged ? '<i class="material-icons">star</i>' : message.hasAttachments ? '<i class="material-icons text-muted">attach_file</i>' : "<span></span>"}</div>`);
    });
    $("#mailReaderSelectAll").prop("checked", false); renderReaderMessageControls();
    $("#mailReaderLoadOlder").prop("disabled", !data.oldest).toggleClass("d-none", !data.oldest);
  }

  function setReaderLoading(loading) {
    if (state.reader) state.reader.loading = Boolean(loading);
    $("#mailReaderLoading").toggleClass("d-none", !loading);
    $("#mailReaderMessageList").toggleClass("is-loading", Boolean(loading));
  }

  async function loadReaderMessages() {
    if (!state.reader) return;
    const ownsLoadingState = !state.reader.loading;
    if (ownsLoadingState) setReaderLoading(true);
    try {
      const data = await result(window.electronAPI.mailboxesMessages(state.reader.mailbox.id, state.reader.folderPath, { page: state.reader.messagePage, pageSize: PAGE_SIZE }));
      renderReaderMessages(data);
    } catch (error) { reportMailboxError(error); } finally { if (ownsLoadingState) setReaderLoading(false); }
  }

  window.mailboxesRefreshVisible = async function () {
    await loadMailboxes();
    if (state.reader) await loadReaderMessages();
  };

  async function showMessage(messageId) {
    try {
      const message = await result(window.electronAPI.mailboxesMessage(state.reader.mailbox.id, messageId));
      state.reader.selectedMessageId = messageId;
      $("#mailPreviewEmpty").addClass("d-none"); $("#mailPreviewContent").removeClass("d-none");
      $("#mailPreviewSubject").text(message.subject); $("#mailPreviewFrom").text(`${t("from", "From")}: ${message.from || "—"}`); $("#mailPreviewTo").text(`${t("to", "To")}: ${message.to || "—"}`); $("#mailPreviewDate").text(formatRelativeTime(message.date)).attr("title", formatDate(message.date));
      const attachments = message.attachments || [];
      $("#mailPreviewAttachments").html(attachments.map((attachment, index) => `<button class="mail-attachment" data-attachment-index="${index}" data-message-id="${message.id}"><i class="material-icons">attach_file</i>${esc(attachment.filename)} <small>${Math.ceil((attachment.size || 0) / 1024)} KB</small></button>`).join(""));
      if (message.html) {
        const source = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; font-src 'none'; media-src 'none';"><style>body{font:14px Arial,sans-serif;color:#1f2937;line-height:1.5;overflow-wrap:anywhere;padding:4px}a{color:#2563eb}</style></head><body>${message.html}</body></html>`;
        $("#mailPreviewHtml").attr("srcdoc", source).removeClass("d-none"); $("#mailPreviewText").addClass("d-none");
      } else { $("#mailPreviewText").text(message.text || "").removeClass("d-none"); $("#mailPreviewHtml").addClass("d-none").attr("srcdoc", ""); }
      $(".mail-message-row").removeClass("active"); $(`.mail-message-row[data-id='${messageId}']`).addClass("active");
      if (message.unread && readerSupportsImap()) {
        window.electronAPI.mailboxesUpdateFlags(state.reader.mailbox.id, [messageId], { read: true }).then(() => loadReaderMessages()).catch(() => {});
      }
    } catch (error) { showError(error.message); }
  }

  async function readerAction(action, control = null) {
    const messageIds = readerMessageIds();
    if (!messageIds.length) return;
    let destination = null;
    if (action === "delete") {
      const popNotice = !readerSupportsImap() ? t("pop_delete_warning", "POP3 deletion is permanent. Continue?") : t("delete_message_confirm", "Move the selected messages to Trash?");
      if (!await confirmPrompt(popNotice)) return;
    } else if (action === "move") {
      const possible = state.reader.folders.filter((folder) => folder.path !== state.reader.folderPath);
      destination = await chooseMoveFolder(possible);
      if (!destination) return;
    }
    const releaseButton = setButtonLoading(control);
    try {
      if (action === "delete") {
        let response = await result(window.electronAPI.mailboxesDeleteMessages(state.reader.mailbox.id, messageIds, false));
        if (response?.requiresPermanentConfirmation && await confirmPrompt(t("permanent_delete_confirm", "No Trash folder is available. Permanently delete the selected messages?"))) {
          await result(window.electronAPI.mailboxesDeleteMessages(state.reader.mailbox.id, messageIds, true));
        }
      } else if (action === "move") {
        await result(window.electronAPI.mailboxesMove(state.reader.mailbox.id, messageIds, destination));
      } else if (action === "mark-read") await result(window.electronAPI.mailboxesUpdateFlags(state.reader.mailbox.id, messageIds, { read: true }));
      else if (action === "mark-unread") await result(window.electronAPI.mailboxesUpdateFlags(state.reader.mailbox.id, messageIds, { read: false }));
      else if (action === "flag") await result(window.electronAPI.mailboxesUpdateFlags(state.reader.mailbox.id, messageIds, { flagged: true }));
      else if (action === "unflag") await result(window.electronAPI.mailboxesUpdateFlags(state.reader.mailbox.id, messageIds, { flagged: false }));
      state.reader.selectedMessageId = null; $("#mailPreviewContent").addClass("d-none"); $("#mailPreviewEmpty").removeClass("d-none"); await loadReaderMessages();
    } catch (error) { showError(error.message); } finally { releaseButton(); }
  }

  function chooseMoveFolder(folders) {
    if (!folders.length) return Promise.resolve(null);
    $("#mailMoveDestination").html(folders.map((folder) => `<option value="${esc(folder.path)}">${esc(folder.name)}</option>`).join(""));
    bootstrap.Modal.getOrCreateInstance(document.getElementById("mailMoveModal")).show();
    return new Promise((resolve) => { moveFolderResolver = resolve; });
  }

  async function downloadAttachment(button) {
    const messageId = $(button).data("message-id"); const index = Number($(button).data("attachment-index"));
    const detail = await result(window.electronAPI.mailboxesMessage(state.reader.mailbox.id, messageId));
    const attachment = detail.attachments?.[index]; if (!attachment) return;
    const selection = await window.electronAPI.showSaveDialog({ defaultPath: attachment.filename, filters: [{ name: "All files", extensions: ["*"] }] });
    if (selection.canceled || !selection.filePath) return;
    try { await withButtonLoading(button, async () => { await result(window.electronAPI.mailboxesDownloadAttachment(state.reader.mailbox.id, messageId, index, selection.filePath)); showSuccess(t("attachment_saved", "Attachment saved.")); }); } catch (error) { showError(error.message); }
  }

  async function resetSelectedCounters(control = null) {
    if (!state.selected.size) { showError(t("no_selection", "Please select at least one mailbox.")); return; }
    try {
      await withButtonLoading(control, async () => {
        for (const mailboxId of state.selected) {
          window.mailboxNotificationManager?.clearMailboxCount?.(mailboxId);
          await result(window.electronAPI.mailboxesResetUnread(mailboxId));
        }
        state.selected.clear();
        await loadMailboxes();
        showSuccess(t("counters_reset", "Counters reset for selected mailboxes."));
      });
    } catch (error) { showError(error.message); }
  }

  async function startBatch(type, control = null) {
    try {
      await withButtonLoading(control, async () => {
        const data = await result(window.electronAPI.mailboxesStartBatch(type, Array.from(state.selected)));
        state.activeJobId = data.jobId; $("#mailboxJobProgress").removeClass("d-none"); $("#mailboxJobProgressText").text(`${t("batch_starting", "Starting batch job")} (0/${data.total})`);
      });
    } catch (error) { showError(error.message); }
  }

  async function connectOutlook() {
    if (state.outlookPollTimer) return;
    const $button = $("#mailboxOutlookConnectBtn");
    const releaseButton = setButtonLoading($button);
    state.outlookPolling = false;
    state.outlookDone = false;
    try {
      const started = await result(window.electronAPI.mailboxesOutlookStart());
      const deadline = Date.now() + ((Number(started.expiresIn) || 600) * 1000);
      showSuccess(t("outlook_browser_opened", "Complete Outlook sign-in in your browser. ViralCloner will continue automatically."));
      const stop = () => {
        if (state.outlookPollTimer) clearInterval(state.outlookPollTimer);
        state.outlookPollTimer = null;
        releaseButton();
      };
      const poll = async () => {
        // Saving a connected mailbox can take a few seconds (the backend retries
        // the IMAP attach). Never run two polls at once, and ignore any late tick
        // once the flow has already finished, so a finished sign-in cannot raise
        // a false "not connected" error.
        if (state.outlookPolling || state.outlookDone) return;
        state.outlookPolling = true;
        try {
          if (Date.now() >= deadline) { state.outlookDone = true; stop(); showError(t("outlook_timeout", "Outlook sign-in timed out. Please try again.")); return; }
          const response = await window.electronAPI.mailboxesOutlookPoll(started.pollToken);
          if (state.outlookDone) return;
          if (response?.success) {
            const status = response.data?.status;
            if (status === "complete") { state.outlookDone = true; stop(); showSuccess(t("outlook_connected", "Outlook mailbox connected.")); await loadMailboxes(); }
            // any other status (pending) keeps polling
          } else {
            state.outlookDone = true; stop();
            if (response?.reason === "imap_not_connected") showImapHelpModal();
            else showError(response?.error || t("outlook_failed", "Outlook sign-in was not completed. Please try again."));
          }
        } catch (error) {
          state.outlookDone = true; stop(); showError(error.message);
        } finally {
          state.outlookPolling = false;
        }
      };
      state.outlookPollTimer = setInterval(poll, 2500);
      poll();
    } catch (error) { showError(error.message); releaseButton(); }
  }

  // App-styled popup with the exact steps to turn on IMAP for a personal Outlook
  // mailbox. Shown when sign-in succeeded but the mailbox reported "authenticated
  // but not connected" (IMAP disabled in the account's own Outlook.com settings).
  function showImapHelpModal() {
    $(".mailbox-imap-help").remove();
    const steps = [
      t("imap_help_step1", "Open Outlook.com and sign in with the same account."),
      t("imap_help_step2", "Go to Settings (gear icon) → Mail → Sync email."),
      t("imap_help_step3", "Under POP and IMAP, turn on \"Let devices and apps use IMAP\"."),
      t("imap_help_step4", "Save, then come back here and choose Try again. (It can take a few minutes to apply.)"),
    ];
    const modal = $(`
      <div class="confirmModal mailbox-imap-help">
        <div class="confirm-modal-overlay"></div>
        <div class="confirm-modal-content" style="max-width:460px;text-align:left;">
          <div class="confirm-modal-icon" style="margin:0 auto 12px;"><i class="material-icons">mark_email_read</i></div>
          <p class="confirm-modal-message" style="text-align:center;font-weight:600;">${esc(t("imap_help_title", "Turn on IMAP for this mailbox"))}</p>
          <p style="text-align:center;color:var(--vc-text-secondary,#6c757d);margin:-6px 0 14px;font-size:13px;">${esc(t("imap_help_intro", "Outlook accepted the sign-in but IMAP is switched off for this account. Enable it in the account's own Outlook.com settings:"))}</p>
          <ol style="padding-left:20px;margin:0 0 8px;line-height:1.7;font-size:13.5px;">
            ${steps.map((step) => `<li>${esc(step)}</li>`).join("")}
          </ol>
          <div class="confirm-modal-actions" style="margin-top:18px;">
            <button class="confirm-modal-btn btn-cancel mailbox-imap-help-close">${esc(t("close", "Close"))}</button>
            <button class="confirm-modal-btn mailbox-imap-help-open" style="background:var(--vc-accent-color,#0d6efd);color:#fff;">${esc(t("imap_help_open", "Open Outlook settings"))}</button>
            <button class="confirm-modal-btn btn-confirm mailbox-imap-help-retry" autofocus>${esc(t("imap_help_retry", "Try again"))}</button>
          </div>
        </div>
      </div>
    `);
    $("body").append(modal);
    const close = () => { modal.addClass("closing"); setTimeout(() => modal.remove(), 200); };
    modal.find(".confirm-modal-overlay, .mailbox-imap-help-close").on("click", close);
    modal.find(".mailbox-imap-help-open").on("click", () => window.electronAPI.openExternal("https://outlook.live.com/mail/0/options/mail/accounts/popImap"));
    modal.find(".mailbox-imap-help-retry").on("click", () => { close(); connectOutlook(); });
    setTimeout(() => modal.find(".mailbox-imap-help-retry").focus(), 50);
  }

  // App-styled popup with Gmail app-password and IMAP setup steps.
  function showGmailHelpModal() {
    $(".mailbox-gmail-help").remove();
    const step1 = [
      t("gmail_help_step1_a", "Go to your Google Account Security Settings."),
      t("gmail_help_step1_b", "In \"How you sign in to Google\", open 2-Step Verification and turn it on."),
    ];
    const step2 = [
      t("gmail_help_step2_a", "Open myaccount.google.com/apppasswords."),
      t("gmail_help_step2_b", "Enter an app name (for example: ViralCloner)."),
      t("gmail_help_step2_c", "Click Create and copy the 16-character app password."),
      t("gmail_help_step2_d", "Use that 16-character app password in the Password field here."),
    ];
    const imap = [
      t("gmail_help_imap_a", "In Gmail, open Settings -> See all settings -> Forwarding and POP/IMAP."),
      t("gmail_help_imap_b", "Enable IMAP and save changes."),
      t("gmail_help_imap_c", "Use IMAP server: imap.gmail.com, Port: 993, Security: TLS/SSL."),
      t("gmail_help_imap_d", "Username: your full Gmail address. Password: your app password (not your normal Gmail password)."),
    ];
    const modal = $(`
      <div class="confirmModal mailbox-gmail-help">
        <div class="confirm-modal-overlay"></div>
        <div class="confirm-modal-content" style="max-width:560px;text-align:left;">
          <div class="confirm-modal-icon" style="margin:0 auto 12px;"><i class="material-icons">info</i></div>
          <p class="confirm-modal-message" style="text-align:center;font-weight:600;">${esc(t("gmail_help_title", "How to connect Gmail"))}</p>
          <p style="text-align:center;color:var(--vc-text-secondary,#6c757d);margin:-6px 0 14px;font-size:13px;">${esc(t("gmail_help_intro", "Use an app password and enable IMAP before testing the mailbox connection."))}</p>

          <p style="margin:0 0 6px;font-weight:600;">${esc(t("gmail_help_step1_title", "Step 1: Turn on 2-Step Verification (Required)"))}</p>
          <ol style="padding-left:20px;margin:0 0 10px;line-height:1.65;font-size:13.5px;">
            ${step1.map((item) => `<li>${esc(item)}</li>`).join("")}
          </ol>

          <p style="margin:0 0 6px;font-weight:600;">${esc(t("gmail_help_step2_title", "Step 2: Generate the App Password"))}</p>
          <ol style="padding-left:20px;margin:0 0 10px;line-height:1.65;font-size:13.5px;">
            ${step2.map((item) => `<li>${esc(item)}</li>`).join("")}
          </ol>

          <p style="margin:0 0 6px;font-weight:600;">${esc(t("gmail_help_imap_title", "Step 3: Enable IMAP and use these server settings"))}</p>
          <ul style="padding-left:20px;margin:0;line-height:1.65;font-size:13.5px;">
            ${imap.map((item) => `<li>${esc(item)}</li>`).join("")}
          </ul>

          <div class="confirm-modal-actions" style="margin-top:18px;">
            <button class="confirm-modal-btn btn-cancel mailbox-gmail-help-close">${esc(t("close", "Close"))}</button>
            <button class="confirm-modal-btn mailbox-gmail-help-security" style="background:var(--vc-accent-color,#0d6efd);color:#fff;">${esc(t("gmail_help_open_security", "Open Google Security"))}</button>
            <button class="confirm-modal-btn btn-confirm mailbox-gmail-help-app-passwords">${esc(t("gmail_help_open_apppasswords", "Open App passwords"))}</button>
          </div>
        </div>
      </div>
    `);
    $("body").append(modal);
    const close = () => { modal.addClass("closing"); setTimeout(() => modal.remove(), 200); };
    modal.find(".confirm-modal-overlay, .mailbox-gmail-help-close").on("click", close);
    modal.find(".mailbox-gmail-help-security").on("click", () => window.electronAPI.openExternal("https://myaccount.google.com/security"));
    modal.find(".mailbox-gmail-help-app-passwords").on("click", () => window.electronAPI.openExternal("https://myaccount.google.com/apppasswords"));
    setTimeout(() => modal.find(".mailbox-gmail-help-app-passwords").focus(), 50);
  }

  function handleJobProgress(progress) {
    if (progress.jobId !== state.activeJobId) return;
    $("#mailboxJobProgressText").text(`${progress.type === "test" ? t("testing_selected", "Testing mailboxes") : t("refreshing_selected", "Refreshing inboxes")} ${progress.completed}/${progress.total}`);
    if (progress.done) { state.activeJobId = null; $("#mailboxJobProgress").addClass("d-none"); loadMailboxes(); showSuccess(progress.cancelled ? t("batch_cancelled", "Batch job cancelled.") : t("batch_complete", "Batch job completed.")); }
  }

  function bindEvents() {
    $("#mailboxSearch").on("input" + NS, (() => { clearTimeout(bindEvents.searchTimer); bindEvents.searchTimer = setTimeout(() => loadMailboxes(true), 250); }));
    $("#mailboxProtocolFilter,#mailboxHealthFilter,#mailboxTagFilter,#mailboxSort").on("change" + NS, () => loadMailboxes(true));
    $("#mailboxAutoRefresh").on("change" + NS, function () { saveAutoRefreshPreference(Number($(this).val())).catch((error) => showError(error.message)); });
    $("#mailboxPrevPage").on("click" + NS, function () { state.page--; withButtonLoading(this, () => loadMailboxes()); }); $("#mailboxNextPage").on("click" + NS, function () { state.page++; withButtonLoading(this, () => loadMailboxes()); });
    $("#mailboxAddBtn").on("click" + NS, () => openMailboxModal()); $("#mailboxOutlookConnectBtn").on("click" + NS, connectOutlook); $("#mailboxForm").on("submit" + NS, saveMailboxForm); $("#mailboxTestBtn").on("click" + NS, testMailboxForm); $("#mailboxGmailHelpBtn").on("click" + NS, showGmailHelpModal);
    $("#mailMoveForm").on("submit" + NS, function (event) { event.preventDefault(); const destination = $("#mailMoveDestination").val(); bootstrap.Modal.getInstance(document.getElementById("mailMoveModal")).hide(); if (moveFolderResolver) { moveFolderResolver(destination); moveFolderResolver = null; } });
    $("#mailMoveModal").on("hidden.bs.modal" + NS, () => { if (moveFolderResolver) { moveFolderResolver(null); moveFolderResolver = null; } });
    $("#mailboxForm input,#mailboxForm select,#mailboxForm textarea").on("input" + NS + " change" + NS, clearTestState);
    $("#mailboxProtocol,#mailboxTlsMode").on("change" + NS, defaultsForProtocol);
    $("#mailboxSelectAll").on("change" + NS, function () { $(".mailbox-select").each((_, element) => this.checked ? state.selected.add($(element).data("id")) : state.selected.delete($(element).data("id"))); renderTable(Array.from(state.mailboxes.values())); });
    $("#mailboxTableBody").on("change" + NS, ".mailbox-select", function () { const mailboxId = $(this).data("id"); this.checked ? state.selected.add(mailboxId) : state.selected.delete(mailboxId); renderSelection(); });
    $(document).on("click" + NS, "#mailboxTableBody [data-action],#mailboxEmpty [data-action],#mailboxBulkBar [data-action]", function () { const action = $(this).data("action"); if (action === "add") openMailboxModal(); else if (action === "batch-test") startBatch("test", this); else if (action === "batch-refresh") startBatch("refresh", this); else if (action === "reset-counters") resetSelectedCounters(this); else if (action === "clear-selection") { state.selected.clear(); renderTable(Array.from(state.mailboxes.values())); } else withRowBusy(action, $(this).data("id"), this); });
    $(document).on("click" + NS, ".mailbox-menu-toggle", function (e) { e.stopPropagation(); const $menu = $(this).siblings(".mailbox-action-menu"); $(".mailbox-action-menu").not($menu).addClass("d-none"); $menu.toggleClass("d-none"); });
    $(document).on("click" + NS, ".mailbox-action-menu .dropdown-item", function () { const action = $(this).data("action"); const mailboxId = $(this).data("id"); $(this).closest(".mailbox-action-menu").addClass("d-none"); withRowBusy(action, mailboxId, this); });
    $(document).on("click" + NS, function (e) { if (!$(e.target).closest(".mailbox-action-dropdown, .mailbox-action-menu").length) { $(".mailbox-action-menu").addClass("d-none"); } });
    $("#mailboxCancelJob").on("click" + NS, function () { if (!state.activeJobId) return; withButtonLoading(this, async () => { await result(window.electronAPI.mailboxesCancelBatch(state.activeJobId)); }).catch((error) => showError(error.message)); });
    $("#mailReaderBack").on("click" + NS, function () { state.reader = null; $("#mailboxReaderView").addClass("d-none"); $("#mailboxManagerView").removeClass("d-none"); withButtonLoading(this, () => loadMailboxes()); });
    $("#mailReaderRefresh").on("click" + NS, function () { refreshReaderFolder({}, this).catch((error) => showError(error.message)); }); $("#mailReaderRefreshFolders").on("click" + NS, function () { withButtonLoading(this, () => loadFolders(true)).catch((error) => showError(error.message)); });
    $("#mailReaderFolderList").on("click" + NS, ".mail-folder-btn", function () { state.reader.folderPath = $(this).data("path"); state.reader.messagePage = 1; state.reader.selectedMessageId = null; renderFolders(); refreshReaderFolder({}, this).catch((error) => showError(error.message)); });
    $("#mailReaderMessageList").on("click" + NS, ".mail-message-row", function (event) { if ($(event.target).is("input")) return; showMessage($(this).data("id")); });
    $("#mailReaderMessageList").on("change" + NS, ".mail-message-select", renderReaderMessageControls); $("#mailReaderSelectAll").on("change" + NS, function () { $(".mail-message-select").prop("checked", this.checked); renderReaderMessageControls(); });
    $("#mailReaderActions").on("click" + NS, "[data-action]", function () { readerAction($(this).data("action"), this); }); $("#mailPreviewDelete").on("click" + NS, function () { if (state.reader?.selectedMessageId) { $(".mail-message-select").prop("checked", false); $(`.mail-message-select[data-id='${state.reader.selectedMessageId}']`).prop("checked", true); readerAction("delete", this); } });
    $("#mailReaderLoadOlder").on("click" + NS, function () { const oldest = state.reader.oldest; if (!oldest) return; refreshReaderFolder({ beforeUid: state.reader.mailbox.protocol === "pop3" ? oldest.serverSequence : oldest.serverUid }, this).catch((error) => showError(error.message)); });
    $("#mailPreviewAttachments").on("click" + NS, ".mail-attachment", function () { downloadAttachment(this).catch((error) => showError(error.message)); });
  }

  async function init() {
    bindEvents(); window.electronAPI.onMailboxesJobProgress(handleJobProgress); await loadAutoRefreshPreference(); await loadMailboxes();
    // Reset notification badge when entering the mailboxes page
    if (typeof window.mailboxNotificationManager?.resetOnPageEntry === "function") {
      await window.mailboxNotificationManager.resetOnPageEntry();
    }
  }

  window.currentPageCleanup = () => { if (state.outlookPollTimer) clearInterval(state.outlookPollTimer); delete window.mailboxesRefreshVisible; $(".mailbox-imap-help,.mailbox-gmail-help").remove(); $(document).off(NS); $("#mailboxes-container *").off(NS); window.electronAPI.removeMailboxesJobProgressListeners(); };
  init();
})();
