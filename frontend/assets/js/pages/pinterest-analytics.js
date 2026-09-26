// ===================== PINTEREST ANALYTICS PAGE =====================
(function () {
  const NS = ".pinterestAnalytics";
  const METRIC_TYPES = ["IMPRESSION", "ENGAGEMENT", "PIN_CLICK", "OUTBOUND_CLICK", "SAVE"];
  const METRIC_COLORS = {
    IMPRESSION: { bg: "rgba(59, 130, 246, 0.1)", border: "#3b82f6" },
    ENGAGEMENT: { bg: "rgba(16, 185, 129, 0.1)", border: "#10b981" },
    PIN_CLICK: { bg: "rgba(139, 92, 246, 0.1)", border: "#8b5cf6" },
    OUTBOUND_CLICK: { bg: "rgba(249, 115, 22, 0.1)", border: "#f97316" },
    SAVE: { bg: "rgba(236, 72, 153, 0.1)", border: "#ec4899" },
  };
  const METRIC_LABELS = {
    IMPRESSION: "Impressions",
    ENGAGEMENT: "Engagements",
    PIN_CLICK: "Pin Clicks",
    OUTBOUND_CLICK: "Outbound Clicks",
    SAVE: "Saves",
  };

  let charts = {};
  let currentAccountId = null;
  let currentDays = 7;
  let currentTopMetric = "IMPRESSION";

  // ---- Init ----
  async function init() {
    await loadAccounts();
    bindEvents();
    showEmptyState(true);
    await checkWarnings();
  }

  // ---- Check warnings (no accounts / collection disabled) ----
  async function checkWarnings() {
    try {
      const accounts = (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const hasAccounts = Object.values(accounts).some((a) => a && a.email);

      if (!hasAccounts) {
        $("#paWarningNoAccounts").show();
        $("#paWarningDisabled").hide();
        return;
      }
      $("#paWarningNoAccounts").hide();

      const res = await window.electronAPI.getPinterestCollectionSettings();
      if (res.success && res.data && res.data.enabled !== true) {
        $("#paWarningDisabled").show();
      } else {
        $("#paWarningDisabled").hide();
      }
    } catch (e) {
      console.error("[PinterestAnalytics] Error checking warnings:", e);
    }
  }

  // ---- Load Accounts ----
  async function loadAccounts() {
    try {
      const accounts = (await window.electronAPI.readKey("pinterestAccounts")) || {};
      const select = $("#paAccountSelect");
      select.find("option:not(:first)").remove();
      Object.entries(accounts).forEach(([id, acc]) => {
        if (acc && acc.email) {
          select.append($("<option>").val(id).text(acc.email));
        }
      });
    } catch (e) {
      console.error("[PinterestAnalytics] Error loading accounts:", e);
    }
  }

  // ---- Bind Events ----
  function bindEvents() {
    $(document).on("change" + NS, "#paAccountSelect", function () {
      currentAccountId = $(this).val();
      if (currentAccountId) {
        showEmptyState(false);
        loadAllData();
      } else {
        showEmptyState(true);
      }
    });

    $(document).on("click" + NS, ".pa-range-btn", function () {
      $(".pa-range-btn").removeClass("active");
      $(this).addClass("active");
      currentDays = parseInt($(this).data("days"));
      if (currentAccountId) {
        loadSummary();
        loadCharts();
      }
    });

    $(document).on("click" + NS, ".pa-metric-tab", function () {
      $(".pa-metric-tab").removeClass("active");
      $(this).addClass("active");
      currentTopMetric = $(this).data("metric");
      if (currentAccountId) loadTopPins();
    });

    $(document).on("click" + NS, "#paRefreshBtn", function () {
      if (currentAccountId) loadAllData();
    });

    // Warning button: go to Pinterest Accounts page
    $(document).on("click" + NS, "#paGoToAccounts", function () {
      $('a[href="#pinterest-accounts"]').click();
    });

    // Warning button: enable collection
    $(document).on("click" + NS, "#paEnableCollection", async function () {
      try {
        const res = await window.electronAPI.getPinterestCollectionSettings();
        const settings = (res.success && res.data) ? res.data : { intervalHours: 24 };
        settings.enabled = true;
        await window.electronAPI.updatePinterestCollectionSettings(settings);
        $("#paWarningDisabled").hide();
      } catch (e) {
        console.error("[PinterestAnalytics] Error enabling collection:", e);
      }
    });
  }

  function showEmptyState(show) {
    if (show) {
      $(".pa-summary-cards, .pa-charts-section, .pa-top-pins-section, .pa-fetch-history").hide();
      $("#paEmptyState").show();
    } else {
      $(".pa-summary-cards, .pa-charts-section, .pa-top-pins-section, .pa-fetch-history").show();
      $("#paEmptyState").hide();
    }
  }

  // ---- Load All Data ----
  async function loadAllData() {
    await Promise.all([loadSummary(), loadCharts(), loadTopPins(), loadFetchLog()]);
  }

  // ---- Summary Cards ----
  async function loadSummary() {
    try {
      const endDate = new Date().toISOString().split("T")[0];
      const startDate = new Date(Date.now() - currentDays * 86400000)
        .toISOString()
        .split("T")[0];
      const res = await window.electronAPI.getPinterestDailyMetrics(
        currentAccountId,
        null,
        startDate,
        endDate
      );
      if (!res.success || !res.data) return;
      const totals = {};
      res.data.forEach((r) => {
        totals[r.metric_type] = (totals[r.metric_type] || 0) + r.value;
      });
      $("#paSummaryImpression").text(formatNumber(totals.IMPRESSION || 0));
      $("#paSummaryEngagement").text(formatNumber(totals.ENGAGEMENT || 0));
      $("#paSummaryPinClick").text(formatNumber(totals.PIN_CLICK || 0));
      $("#paSummaryOutbound").text(formatNumber(totals.OUTBOUND_CLICK || 0));
      $("#paSummarySave").text(formatNumber(totals.SAVE || 0));
    } catch (e) {
      console.error("[PinterestAnalytics] Error loading summary:", e);
    }
  }

  // ---- Charts ----
  async function loadCharts() {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - currentDays * 86400000)
      .toISOString()
      .split("T")[0];

    try {
      const res = await window.electronAPI.getPinterestDailyMetrics(
        currentAccountId,
        null,
        startDate,
        endDate
      );
      if (!res.success || !res.data) return;

      // Group by metric_type
      const grouped = {};
      METRIC_TYPES.forEach((m) => (grouped[m] = []));
      res.data.forEach((r) => {
        if (grouped[r.metric_type]) {
          grouped[r.metric_type].push({ date: r.date, value: r.value });
        }
      });

      // Render each chart
      const chartMap = {
        IMPRESSION: "paChartImpression",
        ENGAGEMENT: "paChartEngagement",
        PIN_CLICK: "paChartPinClick",
        OUTBOUND_CLICK: "paChartOutbound",
        SAVE: "paChartSave",
      };

      Object.entries(chartMap).forEach(([metric, canvasId]) => {
        const data = grouped[metric] || [];
        renderChart(canvasId, metric, data);
      });
    } catch (e) {
      console.error("[PinterestAnalytics] Error loading charts:", e);
    }
  }

  function renderChart(canvasId, metric, data) {
    if (charts[canvasId]) {
      charts[canvasId].destroy();
      delete charts[canvasId];
    }
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const labels = data.map((d) => d.date);
    const values = data.map((d) => d.value);
    const colors = METRIC_COLORS[metric];

    charts[canvasId] = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: METRIC_LABELS[metric],
            data: values,
            borderColor: colors.border,
            backgroundColor: colors.bg,
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: data.length > 30 ? 0 : 3,
            pointHoverRadius: 5,
            pointBackgroundColor: colors.border,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(0,0,0,0.8)",
            titleFont: { size: 12 },
            bodyFont: { size: 13, weight: "bold" },
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (ctx) => formatNumber(ctx.raw),
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              font: { size: 11 },
              maxTicksLimit: 10,
              color: "#94a3b8",
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(0,0,0,0.04)" },
            ticks: {
              font: { size: 11 },
              color: "#94a3b8",
              callback: (v) => formatNumber(v),
            },
          },
        },
      },
    });
  }

  // ---- Top Pins ----
  async function loadTopPins() {
    try {
      const res = await window.electronAPI.getPinterestTopPins(
        currentAccountId,
        currentTopMetric,
        null
      );
      if (!res.success) return;
      const pins = res.data || [];
      const grid = $("#paTopPinsGrid");
      const empty = $("#paTopPinsEmpty");

      if (pins.length === 0) {
        grid.hide();
        empty.show();
        return;
      }
      empty.hide();
      grid.show().empty();

      pins.slice(0, 30).forEach((pin) => {
        const metricLabel =
          window.I18n?.t("pinterest_analytics." + currentTopMetric.toLowerCase()) ||
          METRIC_LABELS[currentTopMetric] ||
          currentTopMetric;
        const card = $('<div class="pa-pin-card"></div>');
        const imgSrc = pin.image_url || "";
        const title = pin.title || window.I18n?.t("pinterest_analytics.untitled") || "Untitled";
        const metricVal = formatNumber(pin.metric_value || 0);

        card.html(
          '<div class="pa-pin-thumb">' +
            (imgSrc
              ? '<img src="' + escapeHtml(imgSrc) + '" alt="" loading="lazy" />'
              : '<i class="material-icons">image</i>') +
            "</div>" +
            '<div class="pa-pin-info">' +
            '<div class="pa-pin-title">' + escapeHtml(title) + "</div>" +
            '<div class="pa-pin-metric">' +
            '<span class="pa-pin-metric-value">' + metricVal + "</span>" +
            '<span class="pa-pin-metric-label">' + escapeHtml(metricLabel) + "</span>" +
            "</div>" +
            "</div>"
        );
        grid.append(card);
      });
    } catch (e) {
      console.error("[PinterestAnalytics] Error loading top pins:", e);
    }
  }

  // ---- Fetch Log ----
  async function loadFetchLog() {
    try {
      const res = await window.electronAPI.getPinterestFetchLog(currentAccountId);
      if (!res.success) return;
      const logs = res.data || [];
      const tbody = $("#paFetchLogBody");
      tbody.empty();

      if (logs.length === 0) {
        tbody.append(
          '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px;">' +
            (window.I18n?.t("pinterest_analytics.no_history") || "No collection history yet") +
            "</td></tr>"
        );
        return;
      }

      logs.slice(0, 20).forEach((log) => {
        const statusClass =
          log.status === "success"
            ? "pa-status-success"
            : log.status === "error"
            ? "pa-status-error"
            : "pa-status-partial";
        const date = new Date(log.fetched_at).toLocaleString();
        const tr = $("<tr></tr>");
        tr.html(
          "<td>" + escapeHtml(date) + "</td>" +
          "<td>" + escapeHtml(log.fetch_type || "—") + "</td>" +
          '<td><span class="pa-status-badge ' + statusClass + '">' + escapeHtml(log.status) + "</span></td>" +
          "<td>" + (log.metrics_saved || 0) + "</td>" +
          "<td>" + (log.pins_saved || 0) + "</td>" +
          "<td>" + escapeHtml(log.error_message || "—") + "</td>"
        );
        tbody.append(tr);
      });
    } catch (e) {
      console.error("[PinterestAnalytics] Error loading fetch log:", e);
    }
  }

  // ---- Helpers ----
  function formatNumber(n) {
    if (n == null) return "—";
    n = Number(n);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return n.toLocaleString();
  }

  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ---- Cleanup ----
  function cleanup() {
    $(document).off(NS);
    Object.values(charts).forEach((c) => {
      try { c.destroy(); } catch (e) { /* ignore */ }
    });
    charts = {};
  }

  // Expose cleanup for SPA navigation
  window.currentPageCleanup = cleanup;

  // Init
  init();

  // Translate page when i18n is ready
  if (window.I18n) window.I18n.translatePage();
})();
