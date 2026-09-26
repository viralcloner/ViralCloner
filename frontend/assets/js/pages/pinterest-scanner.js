$(document).ready(async function () {
  const NS = '.pinterestScanner';
  $(document).off(NS);

  if (window._psScannerPageCleanup) {
    window._psScannerPageCleanup();
    window._psScannerPageCleanup = null;
  }

  // Remove any lingering progress listener from a previous page load
  if (window._psScanProgressCleanup) {
    window._psScanProgressCleanup();
    window._psScanProgressCleanup = null;
  }

  // Remove any body-level tooltip/listeners from a previous scanner instance.
  if (window._psFloatingTooltipCleanup) {
    window._psFloatingTooltipCleanup();
    window._psFloatingTooltipCleanup = null;
  }

  // ── State ────────────────────────────────────────────────
  let currentScanData  = null; // { profile, boards, pins }
  const PIN_BATCH      = 50;   // pins rendered per batch
  let allPinsData      = [];   // full flat array of pin data objects (never DOM)
  let filteredPins     = [];   // subset currently shown (after filter)
  let renderedCount    = 0;    // how many of filteredPins are in the DOM
  let boardMap         = {};   // board id → name
  let scrollObserver   = null; // IntersectionObserver for infinite scroll sentinel
  let activeBoardFilter = null; // board id being filtered, or null for all
  let floatingTooltipEl = null;
  let floatingTooltipTarget = null;
  let floatingTooltipHideTimer = null;
  let isPageActive = true;

  // ── DOM helpers ──────────────────────────────────────────
  function t(key, fallback) {
    return window.I18n?.t(key) || fallback;
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function tooltipAttr(text) {
    return text ? ` data-tooltip="${esc(text)}"` : '';
  }

  function ensureFloatingTooltip() {
    if (floatingTooltipEl) return floatingTooltipEl;
    floatingTooltipEl = document.createElement('div');
    floatingTooltipEl.className = 'ps-floating-tooltip';
    floatingTooltipEl.style.display = 'none';
    (document.body || document.documentElement).appendChild(floatingTooltipEl);
    return floatingTooltipEl;
  }

  function positionFloatingTooltip(target) {
    const tooltip = ensureFloatingTooltip();
    if (!target || tooltip.style.display === 'none') return;

    const rect = target.getBoundingClientRect();
    const padding = 10;
    const tipRect = tooltip.getBoundingClientRect();
    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    let top = rect.top - tipRect.height - 10;

    if (top < padding) top = rect.bottom + 10;
    if (left < padding) left = padding;
    if (left + tipRect.width > window.innerWidth - padding) {
      left = window.innerWidth - padding - tipRect.width;
    }

    tooltip.style.left = `${Math.max(padding, left)}px`;
    tooltip.style.top = `${Math.max(padding, top)}px`;
  }

  function showFloatingTooltip(target) {
    if (!target) return;
    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    const tooltip = ensureFloatingTooltip();
    tooltip.textContent = text;
    tooltip.style.display = 'block';
    floatingTooltipTarget = target;
    positionFloatingTooltip(target);
  }

  function hideFloatingTooltip() {
    if (!floatingTooltipEl) return;
    floatingTooltipEl.style.display = 'none';
    floatingTooltipTarget = null;
  }

  function scheduleHideFloatingTooltip() {
    window.clearTimeout(floatingTooltipHideTimer);
    floatingTooltipHideTimer = window.setTimeout(hideFloatingTooltip, 80);
  }

  function getFloatingTooltipTarget(event) {
    const target = event.target?.closest?.('[data-tooltip]');
    if (!target || !target.closest('.ps-container')) return null;
    return target;
  }

  function installFloatingTooltipManager() {
    const handlePointerOver = (event) => {
      const target = getFloatingTooltipTarget(event);
      if (!target) return;
      window.clearTimeout(floatingTooltipHideTimer);
      showFloatingTooltip(target);
    };

    const handlePointerOut = (event) => {
      const target = getFloatingTooltipTarget(event);
      if (!target) return;
      if (event.relatedTarget && target.contains(event.relatedTarget)) return;
      scheduleHideFloatingTooltip();
    };

    const handleFocusIn = (event) => {
      const target = getFloatingTooltipTarget(event);
      if (!target) return;
      window.clearTimeout(floatingTooltipHideTimer);
      showFloatingTooltip(target);
    };

    const handlePositionUpdate = () => {
      if (floatingTooltipTarget && floatingTooltipEl?.style.display !== 'none') {
        positionFloatingTooltip(floatingTooltipTarget);
      }
    };

    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('pointerout', handlePointerOut, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', scheduleHideFloatingTooltip, true);
    document.addEventListener('pointerdown', hideFloatingTooltip, true);
    document.addEventListener('scroll', handlePositionUpdate, true);
    document.addEventListener('pointermove', handlePositionUpdate, true);

    window._psFloatingTooltipCleanup = function () {
      document.removeEventListener('pointerover', handlePointerOver, true);
      document.removeEventListener('pointerout', handlePointerOut, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('focusout', scheduleHideFloatingTooltip, true);
      document.removeEventListener('pointerdown', hideFloatingTooltip, true);
      document.removeEventListener('scroll', handlePositionUpdate, true);
      document.removeEventListener('pointermove', handlePositionUpdate, true);
      window.clearTimeout(floatingTooltipHideTimer);
      hideFloatingTooltip();
      if (floatingTooltipEl) {
        floatingTooltipEl.remove();
        floatingTooltipEl = null;
      }
      floatingTooltipTarget = null;
    };
  }

  installFloatingTooltipManager();

  function fmt(n) {
    const num = parseInt(n) || 0;
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000)    return (num / 1000).toFixed(1) + 'k';
    return num.toLocaleString();
  }

  function statTooltip(label) {
    switch (String(label || '').toLowerCase()) {
      case 'pins':
        return 'Total pins on this profile.';
      case 'boards':
        return 'Total boards found on this profile.';
      case 'followers':
        return 'How many followers this profile has.';
      case 'following':
        return 'How many accounts this profile follows.';
      case 'monthly reach':
        return 'Estimated monthly audience reach.';
      case 'profile views':
        return 'How many times this profile was viewed.';
      case 'last pin':
        return 'When the latest pin on this profile was saved.';
      case 'member since':
        return 'When this Pinterest profile was created.';
      case 'avg / day':
        return 'Estimated pins posted per day since the profile was created.';
      case 'avg / week':
        return 'Estimated pins posted per week since the profile was created.';
      case 'avg / month':
        return 'Estimated pins posted per month since the profile was created.';
      case 'yesterday':
        return 'Pins posted yesterday.';
      case 'last 7 days':
        return 'Pins posted in the last 7 days.';
      case 'last 30 days':
        return 'Pins posted in the last 30 days.';
      case 'total saves':
        return 'Total saves collected across scanned pins.';
      case 'total reactions':
        return 'Total reactions collected across scanned pins.';
      case 'total repins':
        return 'Total repins collected across scanned pins.';
      case 'total shares':
        return 'Total shares collected across scanned pins.';
      case 'total comments':
        return 'Total comments collected across scanned pins.';
      case 'saves':
        return 'How many times this pin was saved.';
      case 'reactions':
        return 'Total reactions collected on this pin.';
      case 'repins':
        return 'How many times this pin was repinned.';
      case 'shares':
        return 'How many times this pin was shared.';
      case 'comments':
        return 'How many comments this pin received.';
      case 'board pins':
        return 'How many pins are inside this board.';
      default:
        return String(label || '');
    }
  }

  // Pinterest often reports a baseline self-save of 1 for newly created pins.
  // Normalize saves so user-facing metrics reflect external saves only.
  function normalizeSaveCount(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.floor(value) - 1);
  }

  // Safely extract string from a potentially-object Pinterest API field
  function strVal(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object' && typeof v.text === 'string') return v.text;
    return '';
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    if (isNaN(diff)) return '';
    const s = Math.floor(diff / 1000);
    if (s < 60)  return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)  return `${m}min ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30)  return `${d}d ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return url.slice(0, 40); }
  }

  function showError(msg) {
    $('#ps-error-text').text(msg);
    $('#ps-error').css('display', 'flex');
  }

  function hideError() {
    $('#ps-error').hide();
  }

  function setScanning(on) {
    const btn = $('#ps-scan-btn');
    if (on) {
      btn.addClass('scanning').prop('disabled', true);
      $('#ps-progress-wrap').show();
      $('#ps-progress-fill').css('width', '5%');
    } else {
      btn.removeClass('scanning').prop('disabled', false);
    }
  }

  function setProgressLabel(html) {
    $('#ps-progress-label').html(html);
  }

  function setProgressPct(pct) {
    $('#ps-progress-fill').css('width', Math.min(100, pct) + '%');
  }

  // ── Scan ─────────────────────────────────────────────────
  async function startScan() {
    const username = $('#ps-username-input').val().trim();
    if (!username) {
      $('#ps-username-input').css('border-color', '#e60023');
      setTimeout(() => $('#ps-username-input').css('border-color', ''), 1000);
      return;
    }

    hideError();
    $('#ps-results').hide();
    currentScanData = null;
    allPinsData = [];
    filteredPins = [];
    renderedCount = 0;
    boardMap = {};
    activeBoardFilter = null;
    destroyScrollObserver();
    setScanning(true);

    // Set up progress listener before invoking so we don't miss early events
    let totalBoards    = 0;
    let boardsDone     = 0;
    let totalPins      = 0;
    let enrichDone     = 0;
    let enrichTotal    = 0;

    function updatePinProgress() {
      // Show combined label once enrichment has started
      if (enrichTotal > 0) {
        const pct = 20 + Math.round((enrichDone / Math.max(enrichTotal, 1)) * 78);
        const boardPart = totalBoards > 0
          ? `Boards <strong>${boardsDone}/${totalBoards}</strong> · `
          : '';
        setProgressLabel(
          boardPart +
          `Enriching <strong>${fmt(enrichDone)} / ${fmt(enrichTotal)}</strong> ` +
          t('pinterestScanner.pins', 'pins')
        );
        setProgressPct(pct);
      } else {
        const pct = 20 + Math.round((boardsDone / Math.max(totalBoards, 1)) * 10);
        setProgressLabel(
          t('pinterestScanner.progress_pins', 'Scanning board') +
          ` (${boardsDone}/${totalBoards}) — ${fmt(totalPins)} ` +
          t('pinterestScanner.pins', 'pins')
        );
        setProgressPct(pct);
      }
    }

    const cleanup = window.electronAPI.onPinterestScanProgress((data) => {
      if (!isPageActive) return;
      if (data.stage === 'cookies') {
        setProgressLabel(t('pinterestScanner.progress_cookies', 'Fetching session…'));
        setProgressPct(5);
      } else if (data.stage === 'profile') {
        setProgressLabel(
          `<strong>${esc(data.profile?.full_name || username)}</strong> — ` +
          t('pinterestScanner.progress_profile', 'Profile loaded')
        );
        setProgressPct(10);
      } else if (data.stage === 'boards') {
        totalBoards = data.total || data.boards?.length || 0;
        setProgressLabel(
          t('pinterestScanner.progress_boards', 'Boards loaded') +
          `: <strong>${totalBoards}</strong>`
        );
        setProgressPct(20);
      } else if (data.stage === 'pins') {
        boardsDone = (data.boardIndex || 0) + 1;
        totalPins  = data.pinsScanned || 0;
        updatePinProgress();
      } else if (data.stage === 'enrich') {
        enrichDone  = data.enriched;
        enrichTotal = data.total;
        updatePinProgress();
      }
    });

    window._psScanProgressCleanup = cleanup;

    try {
      const result = await window.electronAPI.scanPinterestProfile(username);

      cleanup();
      window._psScanProgressCleanup = null;
      if (!isPageActive) return;

      if (!result.success) {
        showError(result.error || t('pinterestScanner.error_generic', 'Scan failed.'));
        setScanning(false);
        $('#ps-progress-wrap').hide();
        return;
      }

      currentScanData = result.data;
      setProgressPct(100);
      setTimeout(() => {
        if (!isPageActive) return;
        $('#ps-progress-wrap').hide();
        renderResults(result.data);
        setScanning(false);
      }, 300);

    } catch (err) {
      cleanup();
      window._psScanProgressCleanup = null;
      if (!isPageActive) return;
      showError(err.message || t('pinterestScanner.error_generic', 'Scan failed.'));
      setScanning(false);
      $('#ps-progress-wrap').hide();
    }
  }

  // ── Render ────────────────────────────────────────────────
  function renderResults(data) {
    // Reset tab to boards
    switchTab('boards');
    renderProfile(data.profile, data.boards, data.pins);
    renderBoards(data.boards);
    renderPins(data.pins, data.boards);
    $('#ps-results').css('display', 'block');
    if (window.I18n) window.I18n.translatePage();
  }

  function renderProfile(profile, boards, pins) {
    const name   = profile.full_name || profile.username || '';
    const handle = profile.username  || '';
    const bio    = profile.about || '';
    const avatar = profile.image_xlarge_url || profile.image_large_url || profile.image_medium_url || '';

    // Cover image
    const coverWrap = $('#ps-profile-cover-wrap');
    const coverUrl  = profile.profile_cover?.images?.['750x']?.url
      || profile.profile_cover?.images?.originals?.url || null;
    if (coverUrl) {
      coverWrap.html(`<img class="ps-profile-cover" src="${esc(coverUrl)}" alt="" loading="lazy" />`);
    } else {
      coverWrap.html(`<div class="ps-profile-cover-placeholder"></div>`);
    }

    // Avatar
    const avatarWrap = $('#ps-profile-avatar-wrap');
    if (avatar) {
      avatarWrap.html(`<img class="ps-profile-avatar" src="${esc(avatar)}" alt="" loading="lazy" />`);
    } else {
      const letter = (name || handle || '?')[0].toUpperCase();
      avatarWrap.html(`<div class="ps-profile-avatar-placeholder">${esc(letter)}</div>`);
    }

    // Verified badge
    const verifiedBadge = (profile.is_verified_merchant || profile.domain_verified)
      ? `<span class="ps-verified-badge" title="Verified"><span class="material-icons" style="font-size:12px;color:#fff">check</span></span>`
      : '';
    $('#ps-profile-name').html(esc(name) + verifiedBadge);
    $('#ps-profile-handle').text('@' + handle);
    $('#ps-profile-bio').text(bio);

    // Website
    if (profile.website_url) {
      $('#ps-profile-website').html(
        `<a class="ps-profile-website" href="${esc(profile.website_url)}" target="_blank" rel="noopener">${esc(profile.domain_url || profile.website_url)}</a>`
      );
    } else {
      $('#ps-profile-website').empty();
    }

    // Build stat groups
    const pinsArr = pins || [];
    const memberSince  = timeAgo(profile.created_at);
    const lastPinAgo   = timeAgo(profile.last_pin_save_time);
    const memberFull   = profile.created_at ? new Date(profile.created_at).toLocaleDateString() : '';
    const lastPinFull  = profile.last_pin_save_time ? new Date(profile.last_pin_save_time).toLocaleDateString() : '';

    // Posting frequency
    let perDay = null, perWeek = null, perMonth = null;
    if (profile.created_at && profile.pin_count > 0) {
      const days = Math.max(1, (Date.now() - new Date(profile.created_at).getTime()) / 86400000);
      perDay   = (profile.pin_count / days).toFixed(1);
      perWeek  = (profile.pin_count / (days / 7)).toFixed(1);
      perMonth = (profile.pin_count / (days / 30.44)).toFixed(1);
    }

    // Recent activity
    let cntYesterday = null, cntLastWeek = null, cntLastMonth = null;
    const pinsWithDate = pinsArr.filter(p => p.created_at);
    if (pinsWithDate.length > 0) {
      const now = Date.now(), msDay = 86400000;
      const startYest  = new Date(); startYest.setHours(0,0,0,0); startYest.setDate(startYest.getDate() - 1);
      const endYest    = new Date(); endYest.setHours(0,0,0,0);
      const startWeek  = now - 7 * msDay;
      const startMonth = now - 30 * msDay;
      cntYesterday = 0; cntLastWeek = 0; cntLastMonth = 0;
      pinsWithDate.forEach(pin => {
        const t2 = new Date(pin.created_at).getTime();
        if (isNaN(t2)) return;
        if (t2 >= startYest && t2 < endYest) cntYesterday++;
        if (t2 >= startWeek)  cntLastWeek++;
        if (t2 >= startMonth) cntLastMonth++;
      });
    }

    // Totals
    let totalSaves = 0, totalReactions = 0, totalRepins = 0, totalShares = 0, totalComments = 0;
    if (pinsArr.length > 0) {
      pinsArr.forEach(pin => {
        totalSaves     += normalizeSaveCount(pin.aggregated_pin_data?.aggregated_stats?.saves);
        totalReactions += Object.values(pin.reaction_counts || {}).reduce((s, v) => s + v, 0);
        totalRepins    += pin.repin_count ?? 0;
        totalShares    += pin.aggregated_pin_data?.aggregated_stats?.shares ?? pin.share_count ?? 0;
        totalComments  += pin.aggregated_pin_data?.aggregated_stats?.comments ?? pin.aggregated_pin_data?.comment_count ?? pin.comment_count ?? 0;
      });
    }

    const reach = profile.profile_reach ? fmt(profile.profile_reach) : null;
    const views = profile.profile_views ? fmt(profile.profile_views) : null;

    let statsHtml = `
      <div class="ps-stat-group">
        <div class="ps-stat"${tooltipAttr(statTooltip('Pins'))}><span class="ps-stat-value">${fmt(profile.pin_count)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.pins','Pins'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Boards'))}><span class="ps-stat-value">${fmt(boards?.length || 0)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.boards','Boards'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Followers'))}><span class="ps-stat-value">${fmt(profile.follower_count || 0)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.followers','Followers'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Following'))}><span class="ps-stat-value">${fmt(profile.following_count || 0)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.following','Following'))}</span></div>
        ${reach ? `<div class="ps-stat"${tooltipAttr(statTooltip('Monthly reach'))}><span class="ps-stat-value">${esc(reach)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.monthly_reach','Monthly reach'))}</span></div>` : ''}
        ${views ? `<div class="ps-stat"${tooltipAttr(statTooltip('Profile views'))}><span class="ps-stat-value">${esc(views)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.profile_views','Profile views'))}</span></div>` : ''}
        ${lastPinAgo ? `<div class="ps-stat"${tooltipAttr(`${statTooltip('Last pin')} ${lastPinFull ? ` ${lastPinFull}` : ''}`)}><span class="ps-stat-value">${esc(lastPinAgo)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.last_pin','Last pin'))}</span></div>` : ''}
        ${memberSince ? `<div class="ps-stat"${tooltipAttr(`${statTooltip('Member since')} ${memberFull ? ` ${memberFull}` : ''}`)}><span class="ps-stat-value">${esc(memberSince)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.member_since','Member since'))}</span></div>` : ''}
      </div>`;

    if (perDay !== null) {
      statsHtml += `
      <div class="ps-stat-group">
        <div class="ps-stat"${tooltipAttr(statTooltip('Avg / day'))}><span class="ps-stat-value ps-stat-accent">${esc(perDay)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.avg_day','Avg / day'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Avg / week'))}><span class="ps-stat-value ps-stat-accent">${esc(perWeek)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.avg_week','Avg / week'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Avg / month'))}><span class="ps-stat-value ps-stat-accent">${esc(perMonth)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.avg_month','Avg / month'))}</span></div>
      </div>`;
    }

    if (cntYesterday !== null) {
      statsHtml += `
      <div class="ps-stat-group">
        <div class="ps-stat"${tooltipAttr(statTooltip('Yesterday'))}><span class="ps-stat-value">${cntYesterday}</span><span class="ps-stat-label">${esc(t('pinterestScanner.yesterday','Yesterday'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Last 7 days'))}><span class="ps-stat-value">${cntLastWeek}</span><span class="ps-stat-label">${esc(t('pinterestScanner.last_7_days','Last 7 days'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Last 30 days'))}><span class="ps-stat-value">${cntLastMonth}</span><span class="ps-stat-label">${esc(t('pinterestScanner.last_30_days','Last 30 days'))}</span></div>
      </div>`;
    }

    if (pinsArr.length > 0) {
      statsHtml += `
      <div class="ps-stat-group">
        <div class="ps-stat"${tooltipAttr(statTooltip('Total saves'))}><span class="ps-stat-value ps-stat-accent">${fmt(totalSaves)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.total_saves','Total saves'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Total reactions'))}><span class="ps-stat-value ps-stat-accent">${fmt(totalReactions)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.total_reactions','Total reactions'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Total repins'))}><span class="ps-stat-value ps-stat-accent">${fmt(totalRepins)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.total_repins','Total repins'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Total shares'))}><span class="ps-stat-value ps-stat-accent">${fmt(totalShares)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.total_shares','Total shares'))}</span></div>
        <div class="ps-stat"${tooltipAttr(statTooltip('Total comments'))}><span class="ps-stat-value ps-stat-accent">${fmt(totalComments)}</span><span class="ps-stat-label">${esc(t('pinterestScanner.total_comments','Total comments'))}</span></div>
      </div>`;
    }

    $('#ps-profile-stats').html(statsHtml);
  }

  function renderBoards(boards) {
    $('#ps-boards-count').text(boards.length);
    const grid = $('#ps-boards-grid');
    grid.empty();

    boards.forEach(board => {
      const name     = board.name || '';
      const pinCount = board.pin_count || 0;
      // PHP project uses board.images['170x'] array — array of {url} objects
      const thumbArr = board.images?.['170x'] || [];
      const thumbs   = thumbArr.slice(0, 4);

      let thumbHtml;
      if (thumbs.length === 0) {
        // Fallback to old cover image approach
        const cover = board.image_cover_url
          || board.cover_images?.['236x']?.url
          || board.cover_images?.['400x300']?.url || '';
        if (cover) {
          thumbHtml = `<div class="ps-board-thumb ps-board-thumb-single"><img src="${esc(cover)}" loading="lazy" alt="" /></div>`;
        } else {
          thumbHtml = `<div class="ps-board-thumb"><div class="ps-board-thumb-placeholder"><span class="material-icons">dashboard</span></div></div>`;
        }
      } else {
        const imgs = thumbs.map(t2 => `<img src="${esc(t2.url)}" loading="lazy" alt="" />`).join('');
        thumbHtml = `<div class="ps-board-thumb${thumbs.length <= 1 ? ' ps-board-thumb-single' : ''}">${imgs}</div>`;
      }

      const cardHtml = `
        <div class="ps-board-card" data-board-id="${esc(board.id || '')}" data-board-name="${esc(name)}">
          ${thumbHtml}
          <div class="ps-board-info">
            <div class="ps-board-name" title="${esc(name)}">${esc(name)}</div>
            <div class="ps-board-meta"${tooltipAttr(`How many pins are inside this board.`)}>${fmt(pinCount)} ${esc(t('pinterestScanner.pins', 'pins'))}</div>
          </div>
        </div>`;
      grid.append(cardHtml);
    });
  }

  function renderPins(pins, boards) {
    $('#ps-pins-count').text(pins.length);
    $('#ps-pins-count-badge').text(fmt(pins.length) + ' pins');
    const grid = document.getElementById('ps-pins-grid');
    grid.innerHTML = '';
    destroyScrollObserver();

    // Build board map and store data (no DOM yet)
    boardMap = {};
    (boards || []).forEach(b => { boardMap[b.id] = b.name; });
    allPinsData = pins;
    filteredPins = pins;
    renderedCount = 0;
    activeBoardFilter = null;

    if (pins.length === 0) {
      grid.innerHTML = `<div class="ps-empty-pins">${esc(t('pinterestScanner.no_pins', 'No pins found.'))}</div>`;
      return;
    }

    renderNextBatch();
    attachScrollObserver();
  }

  // Build HTML string for one pin data object — rich card matching PHP reference
  function buildPinHtml(pin) {
    const title     = strVal(pin.title) || strVal(pin.grid_title) || '';
    const desc      = strVal(pin.description) || strVal(pin.unified_user_note) || '';
    const boardName = pin.board_id ? (boardMap[pin.board_id] || '') : (strVal(pin.board?.name) || '');
    const pinUrl    = `https://www.pinterest.com/pin/${pin.id}/`;
    const link      = pin.link || pin.utm_link || '';
    const domain    = pin.domain || (link ? domainOf(link) : '');
    const ago       = timeAgo(pin.created_at);

    // Image
    let img = null;
    if (pin.story_pin_data?.pages) {
      for (const page of pin.story_pin_data.pages) {
        const url = page?.image_signature?.url
          || page?.blocks?.[0]?.image?.images?.['736x']?.url
          || page?.blocks?.[0]?.image?.images?.originals?.url;
        if (url) { img = url; break; }
      }
    }
    if (!img) {
      img = pin.images?.['736x']?.url || pin.images?.originals?.url
        || pin.images?.['600x']?.url  || pin.images?.['564x']?.url
        || pin.images?.['236x']?.url  || pin.image_medium_url || null;
    }

    // Stats
    const saves     = normalizeSaveCount(pin.aggregated_pin_data?.aggregated_stats?.saves);
    const repins    = pin.repin_count ?? 0;
    const shares    = pin.aggregated_pin_data?.aggregated_stats?.shares ?? pin.share_count ?? 0;
    const comments  = pin.aggregated_pin_data?.aggregated_stats?.comments ?? pin.aggregated_pin_data?.comment_count ?? pin.comment_count ?? 0;
    const reactions = Object.values(pin.reaction_counts || {}).reduce((s, v) => s + v, 0);

    // Badges
    const isVideo   = pin.is_video === true;
    const isNative  = pin.is_native === true;
    const pageCount = pin.story_pin_data?.page_count ?? 0;
    const cookTime  = pin.rich_summary?.display_cook_time ?? null;
    const category  = pin.category || '';

    const badges = [];
    if (isNative && pageCount > 0) badges.push(`<span class="ps-pin-badge ps-pin-badge-story">Idea Pin</span>`);
    if (isVideo)   badges.push(`<span class="ps-pin-badge ps-pin-badge-video">Video</span>`);
    if (cookTime)  badges.push(`<span class="ps-pin-badge ps-pin-badge-recipe">${Math.round(cookTime / 60)} min</span>`);
    if (pageCount > 1) badges.push(`<span class="ps-pin-badge ps-pin-badge-pages">${pageCount}p</span>`);
    if (category)  badges.push(`<span class="ps-pin-badge ps-pin-badge-cat">${esc(category)}</span>`);

    // Stats row (over image)
    const statsHtml = [
      `<span class="ps-pin-stat"${tooltipAttr(statTooltip('Saves'))}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${fmt(saves)}</span>`,
      `<span class="ps-pin-stat"${tooltipAttr(statTooltip('Reactions'))}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>${fmt(reactions)}</span>`,
      `<span class="ps-pin-stat"${tooltipAttr(statTooltip('Repins'))}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>${fmt(repins)}</span>`,
      `<span class="ps-pin-stat"${tooltipAttr(statTooltip('Shares'))}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>${fmt(shares)}</span>`,
      `<span class="ps-pin-stat"${tooltipAttr(statTooltip('Comments'))}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${fmt(comments)}</span>`,
    ].join('');

    // Map-pin SVG for board chip
    const iconMapPin = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
    const iconExternal = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

    const imgSection = img ? `
      <div class="ps-pin-img-wrap">
        <img class="ps-pin-img" src="${esc(img)}" alt="${esc(title)}" loading="lazy" />
        <div class="ps-pin-overlay-top">
          ${boardName ? `<span class="ps-pin-board-chip">${iconMapPin} ${esc(boardName)}</span>` : '<span></span>'}
          <button class="ps-pin-open-btn" title="Open pin" data-pin-url="${esc(pinUrl)}">${iconExternal}</button>
        </div>
        <div class="ps-pin-overlay-bottom">
          <div class="ps-pin-overlay-row">
            <div class="ps-pin-stats">${statsHtml}</div>
          </div>
          ${(link || ago) ? `<div class="ps-pin-overlay-row">
            ${link ? `<a class="ps-pin-link" href="${esc(link)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>${esc(domain)}</a>` : ''}
            ${ago ? `<span class="ps-pin-ago">${esc(ago)}</span>` : ''}
          </div>` : ''}
        </div>
      </div>` : '';

    const bodySection = `
      <div class="ps-pin-body">
        ${badges.length ? `<div class="ps-pin-badges">${badges.join('')}</div>` : ''}
        ${title ? `<div class="ps-pin-title">${esc(title)}</div>` : ''}
        ${desc && desc !== title ? `<div class="ps-pin-desc">${esc(desc)}</div>` : ''}
      </div>`;

    return `<div class="ps-pin-card" data-pin-url="${esc(pinUrl)}">${imgSection}${bodySection}</div>`;
  }

  function renderNextBatch() {
    const grid     = document.getElementById('ps-pins-grid');
    const sentinel = document.getElementById('ps-pins-sentinel');
    if (sentinel) sentinel.remove();

    const batch = filteredPins.slice(renderedCount, renderedCount + PIN_BATCH);
    if (batch.length === 0) return;

    // Build all HTML at once — single innerHTML append per batch
    const fragment = document.createDocumentFragment();
    const tmp = document.createElement('div');
    tmp.innerHTML = batch.map(buildPinHtml).join('');
    while (tmp.firstChild) fragment.appendChild(tmp.firstChild);
    grid.appendChild(fragment);

    renderedCount += batch.length;

    // Add sentinel if more remain
    if (renderedCount < filteredPins.length) {
      const sentinel = document.createElement('div');
      sentinel.id = 'ps-pins-sentinel';
      sentinel.style.height = '1px';
      grid.appendChild(sentinel);
      attachScrollObserver();
    }

    updateHiddenMsg();
  }

  function destroyScrollObserver() {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    const sentinel = document.getElementById('ps-pins-sentinel');
    if (sentinel) sentinel.remove();
  }

  function attachScrollObserver() {
    destroyScrollObserver();
    const sentinel = document.getElementById('ps-pins-sentinel');
    if (!sentinel) return;
    scrollObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        renderNextBatch();
      }
    }, { rootMargin: '200px' });
    scrollObserver.observe(sentinel);
  }

  function updateHiddenMsg() {
    const total    = filteredPins.length;
    const allCount = allPinsData.length;
    const visible  = Math.min(renderedCount, total);

    // Update count badge
    $('#ps-pins-count-badge').text(fmt(total) + ' pins');

    if (total < allCount) {
      // Filter is active — show how many matched
      $('#ps-pins-hidden-msg')
        .text(`— ${allCount - total} ${t('pinterestScanner.hidden', 'hidden')}`)
        .show();
    } else if (visible < total) {
      // Some not yet rendered (lazy loaded)
      $('#ps-pins-hidden-msg')
        .text(`${visible} / ${total} ${t('pinterestScanner.loaded', 'loaded')}`)
        .show();
    } else {
      $('#ps-pins-hidden-msg').hide();
    }
  }

  // ── Tab switching ─────────────────────────────────────────
  function switchTab(tab) {
    $('.ps-tab').each(function () {
      $(this).toggleClass('active', $(this).data('tab') === tab);
    });
    if (tab === 'boards') {
      $('#ps-tab-boards').show();
      $('#ps-tab-pins').hide();
    } else {
      $('#ps-tab-boards').hide();
      $('#ps-tab-pins').show();
    }
  }

  // ── Board filter ──────────────────────────────────────────
  function filterByBoard(boardId, boardName) {
    activeBoardFilter = boardId;
    $('#ps-board-filter-name').text(boardName);
    $('#ps-board-filter-bar').css('display', 'flex');
    $('#ps-pins-filter').val('');
    switchTab('pins');
    applyFilters();
  }

  function clearBoardFilter() {
    activeBoardFilter = null;
    $('#ps-board-filter-bar').hide();
    applyFilters();
  }

  // ── Apply filters + sort ──────────────────────────────────
  function applyFilters() {
    destroyScrollObserver();
    const grid = document.getElementById('ps-pins-grid');
    grid.innerHTML = '';
    renderedCount = 0;

    const q    = ($('#ps-pins-filter').val() || '').trim().toLowerCase();
    const sort = $('#ps-pins-sort').val() || 'default';

    // Filter
    filteredPins = allPinsData.filter(pin => {
      const matchBoard = !activeBoardFilter || (pin.board_id === activeBoardFilter);
      if (!matchBoard) return false;
      if (!q) return true;
      const titleText = (strVal(pin.title) || strVal(pin.grid_title) || strVal(pin.description) || '').toLowerCase();
      const boardText  = (pin.board_id ? (boardMap[pin.board_id] || '') : (strVal(pin.board?.name) || '')).toLowerCase();
      return titleText.includes(q) || boardText.includes(q);
    });

    // Sort
    if (sort !== 'default') {
      filteredPins = [...filteredPins].sort((a, b) => {
        const aSaves     = a.aggregated_pin_data?.aggregated_stats?.saves ?? 0;
        const bSaves     = b.aggregated_pin_data?.aggregated_stats?.saves ?? 0;
        const aReactions = Object.values(a.reaction_counts || {}).reduce((s, v) => s + v, 0);
        const bReactions = Object.values(b.reaction_counts || {}).reduce((s, v) => s + v, 0);
        const aRepins    = a.repin_count ?? 0;
        const bRepins    = b.repin_count ?? 0;
        const aShares    = a.aggregated_pin_data?.aggregated_stats?.shares ?? a.share_count ?? 0;
        const bShares    = b.aggregated_pin_data?.aggregated_stats?.shares ?? b.share_count ?? 0;
        const aComments  = a.aggregated_pin_data?.aggregated_stats?.comments ?? a.aggregated_pin_data?.comment_count ?? a.comment_count ?? 0;
        const bComments  = b.aggregated_pin_data?.aggregated_stats?.comments ?? b.aggregated_pin_data?.comment_count ?? b.comment_count ?? 0;
        switch (sort) {
          case 'date_desc':      return (new Date(b.created_at || 0)) - (new Date(a.created_at || 0));
          case 'date_asc':       return (new Date(a.created_at || 0)) - (new Date(b.created_at || 0));
          case 'saves_desc':     return bSaves - aSaves;
          case 'saves_asc':      return aSaves - bSaves;
          case 'reactions_desc': return bReactions - aReactions;
          case 'reactions_asc':  return aReactions - bReactions;
          case 'repins_desc':    return bRepins - aRepins;
          case 'repins_asc':     return aRepins - bRepins;
          case 'shares_desc':    return bShares - aShares;
          case 'shares_asc':     return aShares - bShares;
          case 'comments_desc':  return bComments - aComments;
          case 'comments_asc':   return aComments - bComments;
          case 'title_asc':      return (strVal(a.title) || strVal(a.grid_title)).localeCompare(strVal(b.title) || strVal(b.grid_title));
          case 'title_desc':     return (strVal(b.title) || strVal(b.grid_title)).localeCompare(strVal(a.title) || strVal(a.grid_title));
          default: return 0;
        }
      });
    }

    if (filteredPins.length === 0) {
      grid.innerHTML = `<div class="ps-empty-pins">${esc(t('pinterestScanner.no_pins', 'No pins found.'))}</div>`;
      updateHiddenMsg();
      return;
    }

    renderNextBatch();
    updateHiddenMsg();
  }

  // ── Export JSON ───────────────────────────────────────────
  function exportJSON() {
    if (!currentScanData) return;
    const json = JSON.stringify(currentScanData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const username = currentScanData.profile?.username || 'pinterest-scan';
    a.href     = url;
    a.download = `${username}-scan.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Event listeners ───────────────────────────────────────
  $(document).on('click' + NS, '#ps-scan-btn', function () {
    startScan();
  });

  $(document).on('keydown' + NS, '#ps-username-input', function (e) {
    if (e.key === 'Enter') startScan();
  });

  $(document).on('click' + NS, '#ps-export-btn', function () {
    exportJSON();
  });

  $(document).on('click' + NS, '#ps-new-scan-btn', function () {
    destroyScrollObserver();
    $('#ps-results').hide();
    $('#ps-username-input').val('').focus();
    currentScanData = null;
    allPinsData = [];
    filteredPins = [];
    renderedCount = 0;
    boardMap = {};
    activeBoardFilter = null;
    hideError();
  });

  // Tab switching
  $(document).on('click' + NS, '.ps-tab', function () {
    switchTab($(this).data('tab'));
  });

  // Board card click → filter pins by board
  $(document).on('click' + NS, '.ps-board-card', function () {
    const boardId   = $(this).data('board-id');
    const boardName = $(this).data('board-name');
    if (boardId) filterByBoard(String(boardId), boardName || '');
  });

  // Board filter clear
  $(document).on('click' + NS, '#ps-board-filter-clear', function () {
    clearBoardFilter();
  });

  // Pin filter input
  $(document).on('input' + NS, '#ps-pins-filter', function () {
    applyFilters();
  });

  // Sort change
  $(document).on('change' + NS, '#ps-pins-sort', function () {
    applyFilters();
  });

  // Pin card click → open pin (delegate, ignore link/button clicks)
  $(document).on('click' + NS, '.ps-pin-card', function (e) {
    if ($(e.target).closest('a, button').length) return;
    const url = $(this).data('pin-url');
    if (url) window.open(url, '_blank', 'noopener');
  });

  // Pin open button click
  $(document).on('click' + NS, '.ps-pin-open-btn', function (e) {
    e.stopPropagation();
    const url = $(this).data('pin-url');
    if (url) window.open(url, '_blank', 'noopener');
  });

  function cleanupPinterestScannerPage() {
    isPageActive = false;
    $(document).off(NS);
    destroyScrollObserver();

    if (window._psScanProgressCleanup) {
      window._psScanProgressCleanup();
      window._psScanProgressCleanup = null;
    }

    if (window._psFloatingTooltipCleanup) {
      window._psFloatingTooltipCleanup();
      window._psFloatingTooltipCleanup = null;
    }

    if (window.currentPageCleanup === cleanupPinterestScannerPage) {
      window.currentPageCleanup = null;
    }
    if (window._psScannerPageCleanup === cleanupPinterestScannerPage) {
      window._psScannerPageCleanup = null;
    }
  }

  window.currentPageCleanup = cleanupPinterestScannerPage;
  window._psScannerPageCleanup = cleanupPinterestScannerPage;

  // Translate page
  if (window.I18n) window.I18n.translatePage();
});
