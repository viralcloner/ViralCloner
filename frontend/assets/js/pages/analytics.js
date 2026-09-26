/**
 * Analytics Page JavaScript - V2 Comprehensive Analytics
 * Features: Persistent archive, cost tracking, error categorization, peak usage, platform stats
 */

(function () {
  const NS = '.analytics';
  
  // State
  let currentTimeRange = localStorage.getItem('vc.analytics.timeRange') || '24h';
  let currentAutomation = localStorage.getItem('vc.analytics.automation') || 'all';
  let currentErrorCategory = localStorage.getItem('vc.analytics.errorCategory') || 'all';
  
  let charts = {
    nodeSuccess: null,
    completionTrend: null,
    platform: null,
    costTrend: null,
    peakUsage: null,
    errorCategories: null,
    nodeDuration: null
  };
  
  let refreshInterval = null;
  let isLoading = false;
  let dashboardData = null;
  let knownLogTimestamps = new Set();

  // Chart color scheme
  const chartColors = {
    success: '#10b981',
    successLight: 'rgba(16, 185, 129, 0.2)',
    failed: '#ef4444',
    failedLight: 'rgba(239, 68, 68, 0.2)',
    pending: '#f59e0b',
    pendingLight: 'rgba(245, 158, 11, 0.2)',
    primary: '#6366f1',
    primaryLight: 'rgba(99, 102, 241, 0.2)',
    secondary: '#8b5cf6',
    secondaryLight: 'rgba(139, 92, 246, 0.2)',
    info: '#0ea5e9',
    infoLight: 'rgba(14, 165, 233, 0.2)',
    gray: '#94a3b8',
    grayLight: 'rgba(148, 163, 184, 0.2)',
    // Platform colors
    pinterest: '#e60023',
    tiktok: '#00f2ea',
    instagram: '#E4405F',
    facebook: '#1877F2',
    twitter: '#1DA1F2',
    youtube: '#FF0000',
    linkedin: '#0A66C2',
    other: '#64748b',
    // Error category colors
    timeout: '#f59e0b',
    rate_limit: '#ef4444',
    auth: '#8b5cf6',
    network: '#3b82f6',
    api_error: '#ec4899',
    invalid_input: '#6366f1',
    content_policy: '#14b8a6',
    resource: '#f97316',
    unknown: '#64748b'
  };

  // Time range options
  const timeRanges = {
    '1h': { hours: 1, label: '1h' },
    '24h': { hours: 24, label: '24h' },
    '7d': { hours: 168, label: '7d' },
    '30d': { hours: 720, label: '30d' },
    '1y': { hours: 8760, label: '1y' },
    'all': { hours: -1, label: 'All' }
  };

  // Chart defaults for dark/light theme
  function getChartDefaults() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      color: isDark ? '#e2e8f0' : '#334155',
      gridColor: isDark ? 'rgba(148, 163, 184, 0.1)' : 'rgba(148, 163, 184, 0.2)',
      backgroundColor: isDark ? '#1e293b' : '#ffffff'
    };
  }

  // Initialize page
  async function init() {
    console.log('[Analytics] Initializing V2 analytics');
    
    setupEventListeners();
    await loadAutomationsList();
    
    // Set initial states from localStorage
    document.querySelector('.time-range-btn[data-range="' + currentTimeRange + '"]')?.classList.add('active');
    document.getElementById('automation-filter')?.value && (document.getElementById('automation-filter').value = currentAutomation);
    document.getElementById('error-category-filter')?.value && (document.getElementById('error-category-filter').value = currentErrorCategory);
    
    await loadAllData();
    startAutoRefresh();
    subscribeToWorkflowEvents();
    startFailureLogWatcher();
    
    if (window.I18n) window.I18n.translatePage();
  }

  // Set up event listeners
  function setupEventListeners() {
    $(document).off(NS);
    
    // Time range selector
    $(document).on('click' + NS, '.time-range-btn', function () {
      const range = $(this).data('range');
      if (range !== currentTimeRange) {
        currentTimeRange = range;
        localStorage.setItem('vc.analytics.timeRange', range);
        $('.time-range-btn').removeClass('active');
        $(this).addClass('active');
        loadAllData();
      }
    });
    
    // Automation filter
    $(document).on('change' + NS, '#automation-filter', function () {
      currentAutomation = $(this).val();
      localStorage.setItem('vc.analytics.automation', currentAutomation);
      loadAllData();
    });
    
    // Error category filter
    $(document).on('change' + NS, '#error-category-filter', function () {
      currentErrorCategory = $(this).val();
      localStorage.setItem('vc.analytics.errorCategory', currentErrorCategory);
      loadFailureLogs();
    });
    
    // Refresh button
    $(document).on('click' + NS, '#refresh-analytics-btn', function () {
      const btn = this;
      btn.classList.add('spinning');
      loadAllData().finally(() => {
        setTimeout(() => btn.classList.remove('spinning'), 500);
      });
    });
    
    // Export button
    $(document).on('click' + NS, '#export-analytics-btn', function () {
      $('#export-modal').addClass('show');
    });
    
    // Reset analytics button
    $(document).on('click' + NS, '#reset-analytics-btn', async function () {
      const confirmMsg = window.I18n?.t('analytics.reset_confirm') || 'Are you sure you want to reset all analytics data? This action cannot be undone.';
      if (!confirm(confirmMsg)) return;
      
      try {
        const result = await window.electronAPI.resetAnalyticsData();
        if (result.success) {
          const successMsg = window.I18n?.t('analytics.reset_success') || 'Analytics data has been reset.';
          alert(successMsg);
          loadAllData();
        } else {
          alert('Error: ' + (result.error || 'Failed to reset analytics'));
        }
      } catch (error) {
        console.error('[Analytics] Error resetting data:', error);
        alert('Error resetting analytics data');
      }
    });
    
    // Export modal close
    $(document).on('click' + NS, '#export-modal .modal-close, #export-modal .modal-overlay', function () {
      $('#export-modal').removeClass('show');
    });
    
    // Export format buttons
    $(document).on('click' + NS, '.export-format-btn', async function () {
      const format = $(this).data('format');
      await exportAnalytics(format);
      $('#export-modal').removeClass('show');
    });
    
    // Clear all failure logs button
    $(document).on('click' + NS, '#clear-logs-btn', async function () {
      const confirmText = window.I18n?.t('analytics.confirm_clear_logs') || 'Clear all failure logs?';
      const confirmed = await confirmPrompt(confirmText);
      if (confirmed) {
        const result = await window.electronAPI.clearFailureLogs();
        if (result.success) {
          knownLogTimestamps.clear();
          renderFailureLogs([]);
        }
      }
    });
    
    // Delete individual failure log
    $(document).on('click' + NS, '.btn-delete-log', async function (e) {
      e.stopPropagation();
      const lineIndex = parseInt($(this).data('line-index'));
      const item = $(this).closest('.failure-log-item');
      item.css({ opacity: 0, transform: 'translateX(20px)', transition: 'all 0.3s ease' });
      
      const result = await window.electronAPI.deleteFailureLog(lineIndex);
      if (result.success) {
        setTimeout(() => {
          item.remove();
          if ($('#failure-logs-list .failure-log-item').length === 0) {
            $('#failure-logs-list').hide();
            $('#failure-logs-empty').show();
          }
        }, 300);
        loadFailureLogs();
      } else {
        item.css({ opacity: 1, transform: 'translateX(0)' });
      }
    });
    
    // Expand/collapse log stack trace
    $(document).on('click' + NS, '.failure-log-expand-btn', function () {
      $(this).toggleClass('expanded');
      $(this).siblings('.failure-log-stack').toggleClass('visible');
    });
    
    // Run cleanup manually
    $(document).on('click' + NS, '#run-cleanup-btn', async function () {
      const btn = this;
      btn.disabled = true;
      btn.innerHTML = '<i class="material-icons spinning">sync</i>';
      
      try {
        const result = await window.electronAPI.runAnalyticsCleanup();
        if (result.success) {
          showToast(window.I18n?.t('analytics.cleanup_success') || 'Cleanup completed', 'success');
          loadAllData();
        } else {
          showToast(result.error || 'Cleanup failed', 'error');
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="material-icons">cleaning_services</i>';
      }
    });
  }

  // Load automations list for filter dropdown
  async function loadAutomationsList() {
    try {
      const result = await window.electronAPI.getAutomationsList();
      if (!result.success) return;
      
      const select = document.getElementById('automation-filter');
      if (!select) return;
      
      select.innerHTML = '<option value="all" data-i18n="analytics.all_automations">All Automations</option>';
      
      (result.data || []).forEach(auto => {
        const option = document.createElement('option');
        option.value = auto.id;
        option.textContent = auto.name;
        select.appendChild(option);
      });
      
      select.value = currentAutomation;
    } catch (error) {
      console.error('[Analytics] Error loading automations list:', error);
    }
  }

  // Subscribe to workflow events for real-time updates
  function subscribeToWorkflowEvents() {
    if (window.electronAPI?.workflowStatusChanged) {
      window.electronAPI.workflowStatusChanged(() => loadActiveExecutions());
    }
  }

  // Start auto-refresh interval
  function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => loadActiveExecutions(), 5000);
  }

  // Stop auto-refresh
  function stopAutoRefresh() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  }

  // Get hours from time range
  function getHoursFromRange() {
    return timeRanges[currentTimeRange]?.hours || 24;
  }

  // Load all analytics data
  async function loadAllData() {
    if (isLoading) return;
    isLoading = true;
    
    try {
      const hours = getHoursFromRange();
      const automationType = currentAutomation === 'all' ? null : currentAutomation;
      
      // Load dashboard data first (contains summary)
      const dashResult = await window.electronAPI.getAnalyticsDashboard(hours, automationType);
      if (dashResult.success) {
        dashboardData = dashResult.data;
        renderDashboard(dashboardData);
      }
      
      // Load additional data in parallel
      await Promise.all([
        loadLifetimeStats(),
        loadNodeTypeAnalytics(),
        loadPlatformAnalytics(),
        loadErrorAnalytics(),
        loadCostAnalytics(),
        loadPeakUsage(),
        loadActiveExecutions(),
        loadRecentFailures(),
        loadFailureLogs()
      ]);
    } catch (error) {
      console.error('[Analytics] Error loading data:', error);
    } finally {
      isLoading = false;
    }
  }

  // Render main dashboard
  function renderDashboard(data) {
    if (!data) return;
    
    const summary = data.summary || {};
    
    // Summary cards - using nested structure from backend
    $('#total-workflows').text(formatNumber(summary.workflows?.total || 0));
    $('#completed-workflows').text(formatNumber(summary.workflows?.completed || 0));
    $('#total-posts').text(formatNumber(summary.posts?.total || 0));
    $('#posts-success-rate').text((summary.posts?.successRate || 0).toFixed(1) + '%');
    $('#total-nodes').text(formatNumber(summary.nodes?.total || 0));
    $('#nodes-success-rate').text((summary.nodes?.successRate || 0).toFixed(1) + '%');
    $('#avg-duration').text(formatDuration(summary.nodes?.avgDurationMs || 0));
    $('#total-cost').text('$' + (summary.cost?.total || 0).toFixed(2));
    
    // Platform outputs
    const pinterestOutputs = summary.platforms?.pinterest || 0;
    const facebookOutputs = summary.platforms?.facebook || 0;
    $('#total-outputs').text(formatNumber(pinterestOutputs + facebookOutputs));
    $('#pinterest-count').text(formatNumber(pinterestOutputs));
    $('#facebook-count').text(formatNumber(facebookOutputs));
    
    // Render sparklines
    if (data.sparklines) {
      renderSparklines(data.sparklines);
    }
    
    // Render completion trend chart
    if (data.completionTrend) {
      renderCompletionTrendChart(data.completionTrend);
    }
  }

  // Render sparklines in summary cards
  function renderSparklines(sparklines) {
    const sparklineContainers = {
      workflows: '#workflows-sparkline',
      posts: '#posts-sparkline',
      nodes: '#nodes-sparkline',
      cost: '#cost-sparkline'
    };
    
    Object.entries(sparklineContainers).forEach(([key, selector]) => {
      const container = document.querySelector(selector);
      if (!container || !sparklines[key]) return;
      
      const data = sparklines[key];
      const max = Math.max(...data, 1);
      const svg = createSparklineSVG(data, max);
      container.innerHTML = svg;
    });
  }

  // Create sparkline SVG
  function createSparklineSVG(data, max) {
    const width = 60;
    const height = 20;
    const points = data.map((val, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - (val / max) * height;
      return x + ',' + y;
    }).join(' ');
    
    return '<svg width="' + width + '" height="' + height + '" class="sparkline">' +
      '<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="' + points + '"/>' +
      '</svg>';
  }

  // Load lifetime stats
  async function loadLifetimeStats() {
    try {
      const result = await window.electronAPI.getLifetimeStats();
      if (!result.success) return;
      
      const data = result.data || {};
      
      $('#lifetime-workflows').text(formatNumber(data.totalWorkflows || 0));
      $('#lifetime-posts').text(formatNumber(data.totalPosts || 0));
      $('#lifetime-nodes').text(formatNumber(data.totalNodes || 0));
      $('#lifetime-cost').text('$' + (data.totalCost || 0).toFixed(2));
      $('#lifetime-success-rate').text((data.overallSuccessRate || 0).toFixed(1) + '%');
      $('#first-execution').text(data.firstExecution ? formatDate(data.firstExecution) : '-');
      
    } catch (error) {
      console.error('[Analytics] Error loading lifetime stats:', error);
    }
  }

  // Load node type analytics (for success rates and duration charts)
  async function loadNodeTypeAnalytics() {
    try {
      // Use node type stats from dashboard data (combines live + archived)
      const hours = getHoursFromRange();
      const result = await window.electronAPI.getNodeTypeAnalytics(hours);
      if (!result.success) return;
      
      renderNodeSuccessChart(result.data || []);
      renderNodeDurationChart(result.data || []);
    } catch (error) {
      console.error('[Analytics] Error loading node type analytics:', error);
    }
  }

  // Load platform analytics
  async function loadPlatformAnalytics() {
    try {
      const hours = getHoursFromRange();
      const result = await window.electronAPI.getPlatformAnalytics(hours);
      if (!result.success) return;
      
      renderPlatformChart(result.data || []);
    } catch (error) {
      console.error('[Analytics] Error loading platform analytics:', error);
    }
  }

  // Load error analytics
  async function loadErrorAnalytics() {
    try {
      const hours = getHoursFromRange();
      const result = await window.electronAPI.getErrorAnalytics(hours);
      if (!result.success) return;
      
      renderErrorCategoriesChart(result.data || []);
    } catch (error) {
      console.error('[Analytics] Error loading error analytics:', error);
    }
  }

  // Load cost analytics
  async function loadCostAnalytics() {
    try {
      const hours = getHoursFromRange();
      const result = await window.electronAPI.getCostAnalytics(hours);
      if (!result.success) return;
      
      renderCostTrendChart(result.data || []);
    } catch (error) {
      console.error('[Analytics] Error loading cost analytics:', error);
    }
  }

  // Load peak usage
  async function loadPeakUsage() {
    try {
      const result = await window.electronAPI.getPeakUsage();
      if (!result.success) return;
      
      renderPeakUsageHeatmap(result.data || []);
    } catch (error) {
      console.error('[Analytics] Error loading peak usage:', error);
    }
  }

  // Render node success chart
  function renderNodeSuccessChart(data) {
    const canvas = document.getElementById('nodeSuccessChart');
    const empty = document.getElementById('nodeChartEmpty');
    
    if (!data.length) {
      canvas && (canvas.style.display = 'none');
      empty && (empty.style.display = 'flex');
      return;
    }
    
    canvas && (canvas.style.display = 'block');
    empty && (empty.style.display = 'none');
    
    const labels = data.slice(0, 10).map(d => formatNodeType(d.nodeType));
    const successRates = data.slice(0, 10).map(d => d.successRate || 0);
    const failRates = data.slice(0, 10).map(d => d.failRate || 0);
    
    if (charts.nodeSuccess) charts.nodeSuccess.destroy();
    
    const defaults = getChartDefaults();
    const ctx = canvas.getContext('2d');
    
    charts.nodeSuccess = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: window.I18n?.t('analytics.success') || 'Success', data: successRates, backgroundColor: chartColors.success, borderRadius: 4 },
          { label: window.I18n?.t('analytics.failed') || 'Failed', data: failRates, backgroundColor: chartColors.failed, borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { stacked: true, max: 100, grid: { color: defaults.gridColor }, ticks: { color: defaults.color, callback: v => v + '%' } },
          y: { stacked: true, grid: { display: false }, ticks: { color: defaults.color } }
        },
        plugins: {
          legend: { labels: { color: defaults.color } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.raw.toFixed(1) + '%' } }
        }
      }
    });
  }

  // Render completion trend chart
  function renderCompletionTrendChart(data) {
    const canvas = document.getElementById('completionTrendChart');
    const empty = document.getElementById('trendChartEmpty');
    
    if (!data || !data.length) {
      canvas && (canvas.style.display = 'none');
      empty && (empty.style.display = 'flex');
      return;
    }
    
    canvas && (canvas.style.display = 'block');
    empty && (empty.style.display = 'none');
    
    const labels = data.map(d => formatTimeBucket(d.timeBucket || d.date));
    const completed = data.map(d => d.completed || d.success || 0);
    const failed = data.map(d => d.failed || 0);
    
    if (charts.completionTrend) charts.completionTrend.destroy();
    
    const defaults = getChartDefaults();
    const ctx = canvas.getContext('2d');
    
    charts.completionTrend = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: window.I18n?.t('analytics.completed') || 'Completed', data: completed, borderColor: chartColors.success, backgroundColor: chartColors.successLight, fill: true, tension: 0.3 },
          { label: window.I18n?.t('analytics.failed') || 'Failed', data: failed, borderColor: chartColors.failed, backgroundColor: chartColors.failedLight, fill: true, tension: 0.3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { color: defaults.gridColor }, ticks: { color: defaults.color, maxRotation: 45 } },
          y: { beginAtZero: true, grid: { color: defaults.gridColor }, ticks: { color: defaults.color, precision: 0 } }
        },
        plugins: { legend: { labels: { color: defaults.color } } },
        interaction: { intersect: false, mode: 'index' }
      }
    });
  }

  // Render platform distribution chart
  function renderPlatformChart(data) {
    const canvas = document.getElementById('platformChart');
    const empty = document.getElementById('platformChartEmpty');
    
    if (!data.length) {
      canvas && (canvas.style.display = 'none');
      empty && (empty.style.display = 'flex');
      return;
    }
    
    canvas && (canvas.style.display = 'block');
    empty && (empty.style.display = 'none');
    
    const labels = data.map(d => d.platform || 'Other');
    const counts = data.map(d => d.count || 0);
    const colors = data.map(d => chartColors[d.platform?.toLowerCase()] || chartColors.other);
    
    if (charts.platform) charts.platform.destroy();
    
    const defaults = getChartDefaults();
    const ctx = canvas.getContext('2d');
    
    charts.platform = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{ data: counts, backgroundColor: colors, borderWidth: 0 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: defaults.color, padding: 12 } },
          tooltip: { callbacks: { label: ctx => ctx.label + ': ' + formatNumber(ctx.raw) + ' posts' } }
        }
      }
    });
  }

  // Render cost trend chart
  function renderCostTrendChart(data) {
    const canvas = document.getElementById('costTrendChart');
    const empty = document.getElementById('costChartEmpty');
    
    if (!data || !data.length) {
      canvas && (canvas.style.display = 'none');
      empty && (empty.style.display = 'flex');
      return;
    }
    
    canvas && (canvas.style.display = 'block');
    empty && (empty.style.display = 'none');
    
    const labels = data.map(d => formatTimeBucket(d.date));
    const costs = data.map(d => d.totalCost || 0);
    
    if (charts.costTrend) charts.costTrend.destroy();
    
    const defaults = getChartDefaults();
    const ctx = canvas.getContext('2d');
    
    charts.costTrend = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ label: window.I18n?.t('analytics.cost') || 'Cost', data: costs, backgroundColor: chartColors.secondary, borderRadius: 4 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { color: defaults.color, maxRotation: 45 } },
          y: { beginAtZero: true, grid: { color: defaults.gridColor }, ticks: { color: defaults.color, callback: v => '$' + v.toFixed(2) } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => '$' + ctx.raw.toFixed(4) } }
        }
      }
    });
  }

  // Render error categories chart
  function renderErrorCategoriesChart(data) {
    const canvas = document.getElementById('errorCategoriesChart');
    const empty = document.getElementById('errorChartEmpty');
    
    if (!data.length) {
      canvas && (canvas.style.display = 'none');
      empty && (empty.style.display = 'flex');
      return;
    }
    
    canvas && (canvas.style.display = 'block');
    empty && (empty.style.display = 'none');
    
    const labels = data.map(d => formatErrorCategory(d.category));
    const counts = data.map(d => d.count || 0);
    const colors = data.map(d => chartColors[d.category] || chartColors.unknown);
    
    if (charts.errorCategories) charts.errorCategories.destroy();
    
    const defaults = getChartDefaults();
    const ctx = canvas.getContext('2d');
    
    charts.errorCategories = new Chart(ctx, {
      type: 'polarArea',
      data: {
        labels: labels,
        datasets: [{ data: counts, backgroundColor: colors.map(c => c + '80'), borderColor: colors, borderWidth: 2 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: defaults.color, padding: 8 } },
          tooltip: { callbacks: { label: ctx => ctx.label + ': ' + formatNumber(ctx.raw) } }
        },
        scales: { r: { ticks: { color: defaults.color }, grid: { color: defaults.gridColor } } }
      }
    });
  }

  // Render peak usage heatmap
  function renderPeakUsageHeatmap(data) {
    const container = document.getElementById('peakUsageHeatmap');
    const empty = document.getElementById('peakChartEmpty');
    
    if (!data.length) {
      container && (container.style.display = 'none');
      empty && (empty.style.display = 'flex');
      return;
    }
    
    container && (container.style.display = 'grid');
    empty && (empty.style.display = 'none');
    
    // Create heatmap grid (7 days x 24 hours)
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const heatmapData = {};
    let maxCount = 1;
    
    data.forEach(d => {
      const key = d.dayOfWeek + '-' + d.hourOfDay;
      heatmapData[key] = d.executionCount || 0;
      maxCount = Math.max(maxCount, d.executionCount || 0);
    });
    
    let html = '<div class="heatmap-header"></div>';
    for (let h = 0; h < 24; h += 3) {
      html += '<div class="heatmap-header">' + h + ':00</div>';
    }
    
    for (let d = 0; d < 7; d++) {
      html += '<div class="heatmap-day">' + dayNames[d] + '</div>';
      for (let h = 0; h < 24; h += 3) {
        let count = 0;
        for (let hh = h; hh < h + 3 && hh < 24; hh++) {
          count += heatmapData[d + '-' + hh] || 0;
        }
        const intensity = Math.min(count / maxCount, 1);
        const bgColor = 'rgba(99, 102, 241, ' + (0.1 + intensity * 0.8) + ')';
        html += '<div class="heatmap-cell" style="background:' + bgColor + '" title="' + dayNames[d] + ' ' + h + ':00-' + (h+3) + ':00: ' + count + ' executions"></div>';
      }
    }
    
    container.innerHTML = html;
  }

  // Render node duration chart
  function renderNodeDurationChart(data) {
    const canvas = document.getElementById('nodeDurationChart');
    const empty = document.getElementById('durationChartEmpty');
    
    if (!data.length) {
      canvas && (canvas.style.display = 'none');
      empty && (empty.style.display = 'flex');
      return;
    }
    
    canvas && (canvas.style.display = 'block');
    empty && (empty.style.display = 'none');
    
    const sorted = [...data].sort((a, b) => (b.avgDurationMs || 0) - (a.avgDurationMs || 0)).slice(0, 10);
    const labels = sorted.map(d => formatNodeType(d.nodeType));
    const avgDurations = sorted.map(d => (d.avgDurationMs || 0) / 1000);
    
    if (charts.nodeDuration) charts.nodeDuration.destroy();
    
    const defaults = getChartDefaults();
    const ctx = canvas.getContext('2d');
    
    charts.nodeDuration = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ label: window.I18n?.t('analytics.avg_time') || 'Avg Time', data: avgDurations, backgroundColor: chartColors.primary, borderRadius: 4 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { color: defaults.color } },
          y: { beginAtZero: true, grid: { color: defaults.gridColor }, ticks: { color: defaults.color, callback: v => v.toFixed(1) + 's' } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.raw.toFixed(2) + 's' } } }
      }
    });
  }

  // Export analytics
  async function exportAnalytics(format) {
    try {
      const hours = getHoursFromRange();
      const result = await window.electronAPI.exportAnalytics(format, hours);
      
      if (result.success) {
        showToast(window.I18n?.t('analytics.export_success') || 'Export saved to: ' + result.filePath, 'success');
      } else {
        showToast(result.error || 'Export failed', 'error');
      }
    } catch (error) {
      console.error('[Analytics] Export error:', error);
      showToast('Export failed', 'error');
    }
  }
  async function loadActiveExecutions() {
    try {
      const result = await window.electronAPI.getActiveExecutions();
      if (!result.success) {
        console.error('[Analytics] Failed to load active executions:', result.error);
        return;
      }
      
      const data = result.data;
      const workflows = data.workflows || [];
      const posts = data.posts || [];
      
      // Update count
      const activeCount = workflows.length;
      $('#live-count').html(`${activeCount} <span data-i18n="analytics.active">${window.I18n?.t('analytics.active') || 'active'}</span>`);
      
      // Update table
      const $tbody = $('#live-table-body');
      $tbody.empty();
      
      if (workflows.length === 0) {
        $('#live-table').hide();
        $('#live-empty').css('display', 'flex');
      } else {
        $('#live-table').show();
        $('#live-empty').hide();
        
        workflows.forEach(wf => {
          const statusClass = wf.status === 'queued' ? 'status-queued' : 'status-running';
          const statusText = wf.status === 'queued' 
            ? (window.I18n?.t('analytics.queued') || 'Queued')
            : (window.I18n?.t('analytics.running') || 'Running');
          const started = formatTimeAgo(wf.createdAt);
          
          $tbody.append(`
            <tr>
              <td class="workflow-name">${escapeHtml(wf.name || wf.workflowId)}</td>
              <td><span class="status-badge ${statusClass}">${statusText}</span></td>
              <td>
                <div class="progress-bar-container">
                  <div class="progress-bar">
                    <div class="progress-bar-fill" style="width: ${wf.progress || 0}%"></div>
                  </div>
                  <span class="progress-text">${wf.progress || 0}%</span>
                </div>
              </td>
              <td class="time-ago">${started}</td>
            </tr>
          `);
        });
      }
      
    } catch (error) {
      console.error('[Analytics] Error loading active executions:', error);
    }
  }

  // Load recent failures
  async function loadRecentFailures() {
    try {
      const result = await window.electronAPI.getRecentFailures(20);
      if (!result.success) {
        console.error('[Analytics] Failed to load failures:', result.error);
        return;
      }
      
      const data = result.data || [];
      const tbody = document.getElementById('failures-table-body');
      if (!tbody) return;
      
      tbody.innerHTML = '';
      
      if (data.length === 0) {
        document.getElementById('failures-table')?.style && (document.getElementById('failures-table').style.display = 'none');
        document.getElementById('failures-empty')?.style && (document.getElementById('failures-empty').style.display = 'flex');
      } else {
        document.getElementById('failures-table')?.style && (document.getElementById('failures-table').style.display = 'table');
        document.getElementById('failures-empty')?.style && (document.getElementById('failures-empty').style.display = 'none');
        
        data.forEach(failure => {
          const time = formatTimeAgo(failure.createdAt);
          const message = truncateText(failure.message || 'Unknown error', 60);
          const category = failure.errorCategory || 'unknown';
          const categoryDisplay = formatErrorCategory(category);
          const categoryColor = chartColors[category] || chartColors.unknown;
          const isDeleted = !failure.workflowName && failure.workflowId;
          const workflowDisplay = failure.workflowName || (failure.workflowId ? '(' + (window.I18n?.t('analytics.deleted') || 'Deleted') + ')' : '-');
          const workflowClass = isDeleted ? 'workflow-name workflow-deleted' : 'workflow-name';
          
          const tr = document.createElement('tr');
          tr.innerHTML = '<td><span class="node-type-badge">' + formatNodeType(failure.nodeType) + '</span></td>' +
            '<td><span class="error-category-badge" style="background:' + categoryColor + '20;color:' + categoryColor + '">' + categoryDisplay + '</span></td>' +
            '<td class="error-message" title="' + escapeHtml(failure.message || '') + '">' + escapeHtml(message) + '</td>' +
            '<td class="' + workflowClass + '">' + escapeHtml(workflowDisplay) + '</td>' +
            '<td class="time-ago">' + time + '</td>';
          tbody.appendChild(tr);
        });
      }
      
    } catch (error) {
      console.error('[Analytics] Error loading failures:', error);
    }
  }

  // Load failure logs from file
  async function loadFailureLogs() {
    try {
      const result = await window.electronAPI.getFailureLogs(50);
      if (!result.success) {
        console.error('[Analytics] Failed to load failure logs:', result.error);
        return;
      }
      
      const logs = result.data || [];
      
      // Track known timestamps
      knownLogTimestamps.clear();
      logs.forEach(log => {
        if (log.timestamp) knownLogTimestamps.add(log.timestamp);
      });
      
      renderFailureLogs(logs, false);
      
    } catch (error) {
      console.error('[Analytics] Error loading failure logs:', error);
    }
  }

  // Render failure logs
  function renderFailureLogs(logs, isNewLogs = false) {
    const $list = $('#failure-logs-list');
    const $empty = $('#failure-logs-empty');
    
    if (!isNewLogs) {
      $list.empty();
    }
    
    if (logs.length === 0 && !isNewLogs) {
      $list.hide();
      $empty.show();
      return;
    }
    
    $list.show();
    $empty.hide();
    
    const logsToRender = isNewLogs ? logs : logs;
    
    logsToRender.forEach((log, index) => {
      const isNew = isNewLogs;
      const html = createFailureLogItem(log, isNew);
      
      if (isNewLogs) {
        // Prepend new logs at the top
        $list.prepend(html);
      } else {
        $list.append(html);
      }
    });
  }

  // Create HTML for a single failure log item
  function createFailureLogItem(log, isNew = false) {
    const timestamp = log.timestamp ? formatTimeAgo(log.timestamp) : '-';
    const nodeType = formatNodeType(log.nodeType || 'unknown');
    const errorMessage = log.error?.message || log.error || 'Unknown error';
    const errorCategory = log.errorCategory || 'unknown';
    const categoryDisplay = formatErrorCategory(errorCategory);
    const categoryColor = chartColors[errorCategory] || chartColors.unknown;
    const workflowId = log.workflowId ? truncateText(log.workflowId, 12) : '-';
    const nodeId = log.nodeId || '-';
    const attempt = log.attempt || '-';
    const maxAttempts = log.maxAttempts || '-';
    const hasStack = log.error?.stack;
    const lineIndex = log._lineIndex;
    const newClass = isNew ? 'new-log' : '';
    
    // Apply category filter
    if (currentErrorCategory !== 'all' && errorCategory !== currentErrorCategory) {
      return '';
    }
    
    let detailsHtml = '<span class="failure-log-detail failure-log-category" style="color:' + categoryColor + '" title="' + (window.I18n?.t('analytics.error_category') || 'Error Category') + '">' +
      '<i class="material-icons">label</i>' + categoryDisplay + '</span>' +
      '<span class="failure-log-detail" title="' + (window.I18n?.t('analytics.workflow_id') || 'Workflow ID') + '">' +
      '<i class="material-icons">account_tree</i>' + escapeHtml(workflowId) + '</span>' +
      '<span class="failure-log-detail" title="' + (window.I18n?.t('analytics.node_id') || 'Node ID') + '">' +
      '<i class="material-icons">tag</i>#' + escapeHtml(nodeId) + '</span>';
    
    if (attempt !== '-' && maxAttempts !== '-') {
      detailsHtml += '<span class="failure-log-detail" title="' + (window.I18n?.t('analytics.attempts') || 'Attempts') + '">' +
        '<i class="material-icons">replay</i>' + attempt + '/' + maxAttempts + '</span>';
    }
    
    let expandableHtml = '';
    if (hasStack) {
      expandableHtml = '<div class="failure-log-expandable">' +
        '<button class="failure-log-expand-btn"><i class="material-icons">expand_more</i>' +
        '<span data-i18n="analytics.show_stack">' + (window.I18n?.t('analytics.show_stack') || 'Show Stack Trace') + '</span></button>' +
        '<pre class="failure-log-stack">' + escapeHtml(log.error.stack) + '</pre></div>';
    }
    
    return '<div class="failure-log-item ' + newClass + '" data-timestamp="' + escapeHtml(log.timestamp || '') + '" data-category="' + errorCategory + '">' +
      '<div class="failure-log-icon" style="color:' + categoryColor + '"><i class="material-icons">error</i></div>' +
      '<div class="failure-log-content">' +
      '<div class="failure-log-header"><span class="failure-log-node-type">' + nodeType + '</span>' +
      '<span class="failure-log-time">' + timestamp + '</span></div>' +
      '<div class="failure-log-message">' + escapeHtml(truncateText(errorMessage, 200)) + '</div>' +
      '<div class="failure-log-details">' + detailsHtml + '</div>' + expandableHtml + '</div>' +
      '<div class="failure-log-actions"><button class="btn-delete-log" data-line-index="' + lineIndex + '" title="' + (window.I18n?.t('analytics.delete_log') || 'Delete Log') + '">' +
      '<i class="material-icons">close</i></button></div></div>';
  }

  // Start failure log file watcher for live updates
  async function startFailureLogWatcher() {
    try {
      // Start watcher on main process
      const result = await window.electronAPI.startFailureLogWatcher();
      if (!result.success) {
        console.error('[Analytics] Failed to start log watcher:', result.error);
        return;
      }
      
      // Subscribe to updates
      window.electronAPI.onFailureLogUpdated((newLogs) => {
        console.log('[Analytics] Received new failure logs:', newLogs.length);
        
        // Filter out logs we already know about
        const trulyNewLogs = newLogs.filter(log => {
          if (!log.timestamp) return false;
          if (knownLogTimestamps.has(log.timestamp)) return false;
          knownLogTimestamps.add(log.timestamp);
          return true;
        });
        
        if (trulyNewLogs.length > 0) {
          renderFailureLogs(trulyNewLogs, true);
          
          // Also hide empty state if it was visible
          $('#failure-logs-empty').hide();
          $('#failure-logs-list').show();
        }
      });
      
      console.log('[Analytics] Failure log watcher started');
    } catch (error) {
      console.error('[Analytics] Error starting log watcher:', error);
    }
  }

  // Stop failure log watcher
  async function stopFailureLogWatcher() {
    try {
      await window.electronAPI.stopFailureLogWatcher();
      window.electronAPI.removeFailureLogUpdatedListeners();
      console.log('[Analytics] Failure log watcher stopped');
    } catch (error) {
      console.error('[Analytics] Error stopping log watcher:', error);
    }
  }

  // Helper: Format node type for display
  function formatNodeType(nodeType) {
    if (!nodeType) return 'Unknown';
    return nodeType
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/^\s/, '')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  // Helper: Format error category
  function formatErrorCategory(category) {
    if (!category) return 'Unknown';
    const categoryNames = {
      timeout: 'Timeout',
      rate_limit: 'Rate Limit',
      auth: 'Authentication',
      network: 'Network',
      api_error: 'API Error',
      invalid_input: 'Invalid Input',
      content_policy: 'Content Policy',
      resource: 'Resource',
      unknown: 'Unknown'
    };
    return categoryNames[category] || formatNodeType(category);
  }

  // Helper: Format number with K/M suffix
  function formatNumber(num) {
    if (!num || num < 1000) return String(num || 0);
    if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
    return (num / 1000000).toFixed(1) + 'M';
  }

  // Helper: Format date
  function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Helper: Format duration in ms to human readable
  function formatDuration(ms) {
    if (!ms || ms <= 0) return '-';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm';
    return (ms / 3600000).toFixed(1) + 'h';
  }

  // Helper: Format time bucket for chart labels
  function formatTimeBucket(bucket) {
    if (!bucket) return '';
    if (bucket.includes(' ')) {
      const time = bucket.split(' ')[1];
      return time || bucket;
    }
    const parts = bucket.split('-');
    if (parts.length === 3) {
      return parts[1] + '/' + parts[2];
    }
    return bucket;
  }

  // Helper: Format time ago
  function formatTimeAgo(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    
    if (diffSec < 60) return (window.I18n?.t('analytics.just_now') || 'Just now');
    if (diffMin < 60) return diffMin + 'm ' + (window.I18n?.t('analytics.ago') || 'ago');
    if (diffHour < 24) return diffHour + 'h ' + (window.I18n?.t('analytics.ago') || 'ago');
    return diffDay + 'd ' + (window.I18n?.t('analytics.ago') || 'ago');
  }

  // Helper: Escape HTML
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Helper: Truncate text
  function truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  // Helper: Show toast notification
  function showToast(message, type) {
    if (window.showToast) {
      window.showToast(message, type);
    } else {
      console.log('[Analytics Toast]', type, message);
    }
  }

  // Cleanup on page unload
  window.currentPageCleanup = function () {
    console.log('[Analytics] Cleaning up V2');
    $(document).off(NS);
    stopAutoRefresh();
    stopFailureLogWatcher();
    
    knownLogTimestamps.clear();
    
    // Destroy all charts
    Object.values(charts).forEach(chart => {
      if (chart) chart.destroy();
    });
    charts = {
      nodeSuccess: null,
      completionTrend: null,
      platform: null,
      costTrend: null,
      peakUsage: null,
      errorCategories: null,
      nodeDuration: null
    };
    
    if (window.electronAPI?.removeWorkflowStatusChangedListeners) {
      window.electronAPI.removeWorkflowStatusChangedListeners();
    }
  };

  // Initialize when DOM is ready
  $(document).ready(function () {
    init();
  });
})();
