/* global $ */
(function () {
  const NS = ".pinterestKeywords";

  // ── State ───────────────────────────────────────────────
  let relatedData    = [];
  let currentKeyword = "";
  let currentCountry = "US";
  let searchId       = 0;
  let abortSearch    = false; // set to true when a new search starts

  // ── DOM refs ────────────────────────────────────────────
  let kwInput, kwDropdown, kwCountry, kwBtn, kwPlaceholder, kwLoading, kwLoadingTxt, kwResults, kwCacheBar;

  // ── i18n helper ─────────────────────────────────────────
  const t = (key, vars) => window.I18n?.t(key, vars) || key;

  // ── Number formatting ────────────────────────────────────
  function fmtNum(n) {
    if (n == null || isNaN(n)) return "N/A";
    n = Math.round(n);
    if (n >= 1e6)  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3)  return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return n.toLocaleString();
  }

  // ── Opportunity score ────────────────────────────────────
  function oppScore(volume, kd) {
    if (volume == null || kd == null) return null;
    const volScore = Math.min(100, Math.log10(Math.max(1, volume) + 1) / Math.log10(500001) * 100);
    // KD is a multiplicative cap: KD=78 → ×0.10, KD=50 → ×0.35, KD=25 → ×0.65, KD=10 → ×0.86
    const kdFactor = Math.pow((100 - kd) / 100, 1.5);
    return Math.round(volScore * kdFactor);
  }

  function oppInfo(score) {
    if (score >= 70) return { label: "Goldmine",      css: "opp-great", color: "#15803d", desc: "High search volume with low competition. Prioritize this keyword — strong potential for organic reach." };
    if (score >= 50) return { label: "Great",         css: "opp-good",  color: "#1d4ed8", desc: "Good balance of volume and manageable competition. Worth creating dedicated content for." };
    if (score >= 30) return { label: "Worth Testing", css: "opp-fair",  color: "#92400e", desc: "Moderate potential. Could work well in combination with stronger keywords or long-tail variations." };
    return                 { label: "Tough to Rank",  css: "opp-tough", color: "#b91c1c", desc: "High competition makes this difficult to rank for. Consider targeting long-tail variations instead." };
  }

  // ── KD badge ─────────────────────────────────────────────
  function kdBadge(kd, source) {
    if (kd == null) return `<span class="kd-badge kd-none">N/A</span>`;
    const n = parseInt(kd);
    let cls, label;
    if (n <= 25)      { cls = "kd-easy";   label = `Easy (${n})`; }
    else if (n <= 50) { cls = "kd-medium"; label = `Medium (${n})`; }
    else if (n <= 75) { cls = "kd-hard";   label = `Hard (${n})`; }
    else              { cls = "kd-vhard";  label = `Very Hard (${n})`; }
    if (source === "short_keyword_estimate") cls = "kd-estimate";
    return `<span class="kd-badge ${cls}" title="Keyword difficulty: ${n}/100">${label}</span>`;
  }

  // ── Trend modal ───────────────────────────────────────────
  function buildTrendChart(counts, vol) {
    if (!counts || counts.length < 2) {
      return `<p style="padding:20px;color:var(--text-secondary);font-size:13px">No trend data available.</p>`;
    }
    // Scale index (0-100) to real weekly impressions when vol is known
    const avgIdx    = counts.reduce((a, b) => a + b, 0) / counts.length;
    const weeklyAvg = vol != null ? vol / 4.33 : null;
    const scale     = (weeklyAvg != null && avgIdx > 0) ? weeklyAvg / avgIdx : null;
    const real      = counts.map(c => scale != null ? Math.round(c * scale) : c);
    const isReal    = scale != null;

    const W = 600, H = 210;
    const PL = 60, PR = 20, PT = 16, PB = 34;
    const plotW = W - PL - PR, plotH = H - PT - PB;

    const maxVal = Math.max(...real, 1);
    const xOf    = i => PL + (i / (real.length - 1)) * plotW;
    const yOf    = v => PT + plotH - (v / maxVal) * plotH;

    // Y gridlines (5 steps)
    const ySteps   = 4;
    const yGrids   = Array.from({ length: ySteps + 1 }, (_, i) => {
      const v = Math.round((maxVal / ySteps) * i);
      return { v, y: yOf(v) };
    });

    // X month labels
    const now      = Date.now();
    const startMs  = now - (counts.length - 1) * 7 * 24 * 3600 * 1000;
    const months   = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const xLabels  = [];
    let lastMonth  = -1;
    counts.forEach((_, i) => {
      const m = new Date(startMs + i * 7 * 24 * 3600 * 1000).getMonth();
      if (m !== lastMonth) { xLabels.push({ i, label: months[m] }); lastMonth = m; }
    });

    const pts     = real.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
    const fillPts = `${xOf(0).toFixed(1)},${yOf(0).toFixed(1)} ${pts} ${xOf(real.length-1).toFixed(1)},${yOf(0).toFixed(1)}`;

    // Invisible wider hit-rects for tooltip
    const hitRects = real.map((v, i) => {
      const x   = xOf(i);
      const rectW = plotW / (real.length - 1);
      const val = isReal ? fmtNum(v) + "/wk" : `Index ${v}`;
      return `<rect class="trend-dot" x="${(x - rectW/2).toFixed(1)}" y="${PT}" width="${rectW.toFixed(1)}" height="${plotH}" fill="transparent"
        data-val="${val}" data-cx="${x.toFixed(1)}" data-cy="${yOf(v).toFixed(1)}"/>`;
    }).join("");

    const dots = real.map((v, i) =>
      `<circle class="trend-dot-circle" cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3" fill="#e60023" opacity="0" pointer-events="none"/>`
    ).join("");

    return `<div class="trend-chart-wrap">
      <svg class="trend-chart-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        ${ yGrids.map(({ v, y }) =>
          `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W-PR}" y2="${y.toFixed(1)}" stroke="var(--border-color)" stroke-width="1"/>
           <text x="${PL-6}" y="${(y+4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text-secondary)">${fmtNum(v)}</text>`
        ).join("") }
        ${ xLabels.map(({ i, label }) =>
          `<line x1="${xOf(i).toFixed(1)}" y1="${(H-PB+2).toFixed(1)}" x2="${xOf(i).toFixed(1)}" y2="${(H-PB+7).toFixed(1)}" stroke="var(--border-color)" stroke-width="1"/>
           <text x="${xOf(i).toFixed(1)}" y="${H-4}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">${label}</text>`
        ).join("") }
        <polygon points="${fillPts}" fill="rgba(230,0,35,.08)"/>
        <polyline points="${pts}" fill="none" stroke="#e60023" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${hitRects}
        <!-- crosshair line (hidden by default) -->
        <line id="kwTrendCross" x1="0" y1="${PT}" x2="0" y2="${H-PB}" stroke="#e60023" stroke-width="1" stroke-dasharray="4,3" opacity="0" pointer-events="none"/>
      </svg>
      <div class="trend-tooltip" id="kwTrendTooltip" style="display:none"></div>
    </div>`;
  }

  function showTrendModal(term, counts, vol) {
    const modal   = document.getElementById("kwTrendModal");
    const titleEl = document.getElementById("kwTrendModalTitle");
    const subEl   = document.getElementById("kwTrendModalSub");
    const content = document.getElementById("kwTrendModalContent");

    titleEl.textContent = term;
    subEl.textContent   = vol != null
      ? `~${fmtNum(vol)} monthly impressions · weekly trend over 52 weeks`
      : "Weekly trend over 52 weeks (relative index)";
    content.innerHTML   = buildTrendChart(counts, vol);
    modal.style.display = "flex";

    // Wire up hover tooltips
    const tip    = content.querySelector("#kwTrendTooltip");
    const cross  = content.querySelector("#kwTrendCross");
    const svgEl  = content.querySelector(".trend-chart-svg");
    content.querySelectorAll(".trend-dot").forEach((rect, i) => {
      const dotCircle = content.querySelectorAll(".trend-dot-circle")[i];
      rect.addEventListener("mouseenter", () => {
        const cx  = parseFloat(rect.dataset.cx);
        const cy  = parseFloat(rect.dataset.cy);
        const svgRect = svgEl.getBoundingClientRect();
        const scX = svgRect.width  / 600;
        const scY = svgRect.height / 210;
        const domX = cx * scX;
        const domY = cy * scY;
        tip.textContent  = rect.dataset.val;
        tip.style.display = "block";
        tip.style.left   = domX + "px";
        tip.style.top    = (domY - 38) + "px";
        if (cross)  { cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("opacity", "0.6"); }
        if (dotCircle) dotCircle.setAttribute("opacity", "1");
      });
      rect.addEventListener("mouseleave", () => {
        tip.style.display = "none";
        if (cross)     cross.setAttribute("opacity", "0");
        if (dotCircle) dotCircle.setAttribute("opacity", "0");
      });
    });
  }

  // ── SVG Sparkline ─────────────────────────────────────────
  function sparkline(counts, w = 80, h = 28) {
    if (!counts || counts.length < 2) return "";
    const max = Math.max(...counts, 1);
    const min = Math.min(...counts);
    const range = max - min || 1;
    const xs = counts.map((_, i) => (i / (counts.length - 1)) * w);
    const ys = counts.map(v => h - ((v - min) / range) * (h - 4) - 2);
    const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
    const fillPts = `0,${h} ${pts} ${w},${h}`;
    return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <polyline points="${fillPts}" fill="rgba(230,0,35,.1)" stroke="none"/>
      <polyline points="${pts}" fill="none" stroke="#e60023" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  // ── Escape HTML ───────────────────────────────────────────
  function esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ── Debounce ──────────────────────────────────────────────
  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  // ── Concurrency limiter ───────────────────────────────────
  async function runConcurrent(tasks, limit = 4) {
    const results = new Array(tasks.length);
    let idx = 0;
    async function worker() {
      while (idx < tasks.length) {
        const i = idx++;
        try { results[i] = await tasks[i](); } catch (e) { results[i] = null; }
      }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  // ── Server-side cache ────────────────────────────────────
  async function loadServerCache(kw, country) {
    try {
      const res = await window.electronAPI.pinterestKwCacheGet(kw, country);
      if (res?.ok && res.data) return res;
      return null;
    } catch (_) { return null; }
  }
  function saveServerCache(kw, country, data) {
    window.electronAPI.pinterestKwCacheSet(kw, country, data).catch(() => {});
  }

  // ── Cache indicator ───────────────────────────────────────
  function showCacheIndicator(cachedAt) { /* no-op */ }
  function hideCacheIndicator() { kwCacheBar.style.display = "none"; }

  // ── Render main stats ─────────────────────────────────────
  function renderMainStats(kd, kdSource, vol) {
    // Volume
    if (vol != null) {
      document.getElementById("kwVolValue").textContent = fmtNum(vol);
      document.getElementById("kwVolSub").textContent = `${fmtNum(Math.round(vol / 4))} / week`;
    } else {
      document.getElementById("kwVolValue").textContent = "N/A";
    }
    // KD
    document.getElementById("kwKdValue").innerHTML = kd != null ? kdBadge(kd, kdSource) : `<span style="color:var(--text-secondary)">N/A</span>`;
    if (kd != null) document.getElementById("kwKdSub").textContent = `Based on ${kdSource === "database" ? "scraped pins" : "estimate"}`;
    // Opportunity
    const score = oppScore(vol, kd);
    if (score != null) {
      const info = oppInfo(score);
      document.getElementById("kwOppValue").innerHTML = `<span class="kd-badge ${info.css}">${score}</span>`;
      document.getElementById("kwOppSub").textContent = info.label;
      renderOpportunity(score, info);
    }
  }

  function renderOpportunity(score, info) {
    const detail = document.getElementById("kwOppDetail");
    detail.style.display = "";
    const circle = document.getElementById("kwOppCircle");
    circle.style.color = info.color;
    document.getElementById("kwOppCircleNum").textContent = score;
    document.getElementById("kwOppTitle").textContent = info.label;
    document.getElementById("kwOppDesc").textContent = info.desc;
    document.getElementById("kwOppBarFill").style.color = info.color;
    document.getElementById("kwOppBarFill").style.width = score + "%";
  }

  // ── Autotype pills ────────────────────────────────────────
  function renderAutoType(suggestions) {
    const el = document.getElementById("kwAutoType");
    if (!suggestions || suggestions.length === 0) {
      el.innerHTML = `<span style="font-size:12px;color:var(--text-secondary)">No suggestions</span>`;
      return;
    }
    el.innerHTML = suggestions.map(s =>
      `<span class="kw-pill" data-term="${esc(s)}"><span class="material-icons">search</span>${esc(s)}</span>`
    ).join("");
    el.querySelectorAll(".kw-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        kwInput.value = pill.dataset.term;
        analyze(pill.dataset.term, currentCountry);
      });
    });
  }

  // ── Related keywords table ─────────────────────────────────
  // skipFetch=true → rows already have kd/vol/kd_source; render immediately, skip API calls.
  // Returns a Promise resolving to [{term,counts,kd,vol,kd_source}] for cache saving.
  function renderRelatedTable(suggestions, sid, skipFetch) {
    const tbody = document.getElementById("kwRelatedBody");
    if (!suggestions || suggestions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="kw-table-empty">No related keywords found.</td></tr>`;
      return Promise.resolve([]);
    }

    tbody.innerHTML = suggestions.map((item, i) => {
      const term    = typeof item === "string" ? item : (item.term || "");
      const cnts    = typeof item === "object" && item.counts ? item.counts : [];
      const hasCnts = cnts.length >= 2;
      let volHtml, kdHtml, oppHtml, volData;
      if (skipFetch) {
        const kd  = item.kd  !== undefined ? item.kd  : null;
        const vol = item.vol !== undefined ? item.vol : null;
        const ks  = item.kd_source || null;
        volData   = vol != null ? String(vol) : "";
        volHtml   = vol != null ? `<span class="vol-num">${fmtNum(vol)}</span>` : `<span class="vol-na">N/A</span>`;
        kdHtml    = kdBadge(kd, ks);
        const sc  = oppScore(vol, kd);
        oppHtml   = sc != null ? (() => { const inf = oppInfo(sc); return `<span class="kd-badge ${inf.css} opp-num" title="${inf.label}">${sc}</span>`; })() : "—";
      } else {
        volData = "";
        volHtml = `<span class="inline-spinner"></span>`;
        kdHtml  = `<span class="inline-spinner"></span>`;
        oppHtml = "—";
      }
      return `<tr id="kwRow${i}">
        <td><span class="rel-kw-term" data-term="${esc(term)}">${esc(term)}</span></td>
        <td class="kw-vol-cell-${i}">${volHtml}</td>
        <td class="kw-kd-cell-${i}">${kdHtml}</td>
        <td class="kw-opp-cell-${i}">${oppHtml}</td>
        <td class="trend-cell${hasCnts ? " trend-clickable" : ""}" data-term="${esc(term)}"
            data-counts="${hasCnts ? esc(JSON.stringify(cnts)) : ""}" data-vol="${volData}">${sparkline(cnts)}</td>
        <td class="demo-svg-cell kw-demo-cell-${i}"></td>
      </tr>`;
    }).join("");

    // Click to analyze
    tbody.querySelectorAll(".rel-kw-term").forEach(el => {
      el.addEventListener("click", () => {
        kwInput.value = el.dataset.term;
        analyze(el.dataset.term, currentCountry);
      });
    });

    // Click trend sparkline → open modal
    tbody.querySelectorAll(".trend-clickable").forEach(cell => {
      cell.addEventListener("click", () => {
        const t = cell.dataset.term;
        const c = JSON.parse(cell.dataset.counts || "[]");
        const v = cell.dataset.vol !== "" ? parseFloat(cell.dataset.vol) : null;
        showTrendModal(t, c, v);
      });
    });

    if (skipFetch) {
      return Promise.resolve(suggestions.map(item => ({
        term:      typeof item === "string" ? item : (item.term || ""),
        counts:    (typeof item === "object" && item.counts) ? item.counts : null,
        kd:        item.kd  !== undefined ? item.kd  : null,
        vol:       item.vol !== undefined ? item.vol : null,
        kd_source: item.kd_source || null,
      })));
    }

    // Concurrent fetch per row — collect results for server cache
    const resultsArr = suggestions.map(item => ({
      term:      typeof item === "string" ? item : (item.term || ""),
      counts:    (typeof item === "object" && item.counts) ? item.counts : null,
      kd: null, vol: null, kd_source: null,
    }));

    const tasks = suggestions.map((item, i) => async () => {
      if (abortSearch) return;
      const term = typeof item === "string" ? item : (item.term || "");
      const kwData = await window.electronAPI.pinterestKwData(term).catch(() => null);
      if (searchId !== sid) return;

      const kd  = kwData?.ok ? kwData.kd : null;
      const vol = kwData?.ok ? kwData.monthly_impressions : null;

      resultsArr[i].kd        = kd;
      resultsArr[i].vol       = vol;
      resultsArr[i].kd_source = kwData?.kd_source || null;

      const volCell   = tbody.querySelector(`.kw-vol-cell-${i}`);
      const kdCell    = tbody.querySelector(`.kw-kd-cell-${i}`);
      const oppCell   = tbody.querySelector(`.kw-opp-cell-${i}`);
      const trendCell = tbody.querySelector(`#kwRow${i} .trend-cell`);
      if (!volCell) return;

      if (trendCell && vol != null) trendCell.dataset.vol = vol;

      volCell.innerHTML = vol != null ? `<span class="vol-num">${fmtNum(vol)}</span>` : `<span class="vol-na">N/A</span>`;
      kdCell.innerHTML  = kdBadge(kd, kwData?.kd_source);

      const score = oppScore(vol, kd);
      if (score != null) {
        const info = oppInfo(score);
        oppCell.innerHTML = `<span class="kd-badge ${info.css} opp-num" title="${info.label}">${score}</span>`;
      }
    });

    return runConcurrent(tasks, 4).then(() => resultsArr);
  }

  // ── Demographics ──────────────────────────────────────────
  async function fetchDemographics(terms, country, sid) {
    try {
      const res = await window.electronAPI.pinterestKwDemographics(terms, country, 365);
      if (searchId !== sid || !res.ok) return;
      const dists = res.term_distributions || {};
      Object.entries(dists).forEach(([term, data]) => {
        addInlineDemographics(term, data);
      });
    } catch (_) {}
  }

  function addInlineDemographics(term, data) {
    if (!data) return;
    // Find the row for this term
    const tbody = document.getElementById("kwRelatedBody");
    if (!tbody) return;
    tbody.querySelectorAll(".rel-kw-term").forEach((el, i) => {
      if (el.dataset.term?.toLowerCase() !== term?.toLowerCase()) return;
      const cell = tbody.querySelector(`.kw-demo-cell-${i}`);
      if (!cell || cell.dataset.filled) return;
      cell.dataset.filled = "1";

      // Gender distribution
      const gender = data.gender_distribution || data.gender || {};
      const female = Math.round((gender.female || 0) * 100);
      const male   = Math.round((gender.male   || 0) * 100);

      // Age distribution (pick top 2)
      const age = data.age_distribution || data.age || {};
      const ageEntries = Object.entries(age).sort((a, b) => b[1] - a[1]).slice(0, 4);

      const agePills = ageEntries.map(([k, v]) =>
        `<span class="demo-age-pill">${k} <b>${Math.round(v*100)}%</b></span>`
      ).join("");

      cell.innerHTML = `
        <div class="demo-cell-wrap">
          <div class="demo-pills-row">
            <span class="demo-pill demo-pill-f">F ${female}%</span>
            <span class="demo-pill demo-pill-m">M ${male}%</span>
          </div>
          <div class="demo-pills-row">${agePills}</div>
        </div>`;
    });
  }

  // ── Top Pins ──────────────────────────────────────────────
  async function fetchTopPins(keyword, sid) {
    const container = document.getElementById("kwTopPins");
    container.innerHTML = `<div style="padding:20px;color:var(--text-secondary);font-size:13px"><span class="inline-spinner"></span> Loading top pins…</div>`;
    try {
      const res = await window.electronAPI.pinterestKwTopPins(keyword, 9);
      if (searchId !== sid) return;
      if (!res.ok || !res.pins?.length) {
        container.innerHTML = `<div style="padding:16px;color:var(--text-secondary);font-size:13px">No top pins found for this keyword.</div>`;
        return;
      }
      container.innerHTML = res.pins.map(pin => buildPinCard(pin)).join("");
      container.querySelectorAll(".pin-card[data-link]").forEach(el => {
        el.addEventListener("click", () => {
          const url = el.dataset.link;
          if (url) window.open(url, "_blank");
        });
      });
    } catch (_) {
      container.innerHTML = `<div style="padding:16px;color:var(--text-secondary);font-size:13px">Could not load top pins.</div>`;
    }
  }

  function buildPinCard(pin) {
    const imgHtml = pin.image_url
      ? `<img class="pin-card-img" src="${esc(pin.image_url)}" alt="${esc(pin.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="pin-card-img-placeholder" style="display:none"><span class="material-icons" style="font-size:36px;color:var(--text-secondary)">image</span></div>`
      : `<div class="pin-card-img-placeholder"><span class="material-icons" style="font-size:36px;color:var(--text-secondary)">image</span></div>`;
    const saves = pin.saves || 0;
    const pinner = pin.pinner?.username || "";
    const avatarHtml = pin.pinner?.avatar_url
      ? `<img class="pin-card-avatar" src="${esc(pin.pinner.avatar_url)}" alt="">`
      : "";

    return `<div class="pin-card" data-link="${esc(pin.link || `https://www.pinterest.com/pin/${esc(pin.id)}/`)}">
      ${imgHtml}
      <div class="pin-card-body">
        ${pin.title ? `<div class="pin-card-title">${esc(pin.title)}</div>` : ""}
        <div class="pin-card-meta">
          ${saves > 0 ? `<span class="pin-card-saves"><span class="material-icons">favorite</span>${fmtNum(saves)}</span>` : ""}
          ${pinner ? `<span class="pin-card-profile">${avatarHtml}@${esc(pinner)}</span>` : ""}
        </div>
      </div>
    </div>`;
  }

  // ── Main analyze flow ─────────────────────────────────────
  async function analyze(keyword, country, forceRefresh) {
    keyword = keyword.trim();
    if (!keyword) return;

    currentKeyword = keyword;
    currentCountry = country;
    abortSearch    = true;
    const sid      = ++searchId;
    abortSearch    = false;

    kwPlaceholder.style.display = "none";
    document.getElementById("kwResults").style.display = "none";
    hideCacheIndicator();
    kwLoading.style.display = "";
    kwLoadingTxt.textContent = t("pinterestKeywords.loading");
    kwBtn.disabled = true;

    // ── Check server cache ────────────────────────────────
    if (!forceRefresh) {
      try {
        const cacheRes = await loadServerCache(keyword, country);
        if (searchId !== sid) return;
        if (cacheRes?.ok && cacheRes.data) {
          const d = cacheRes.data;
          // Support both new format {vol,kd,auto,sugg,related} and old flat format
          const isNewFmt        = d.vol && typeof d.vol === "object";
          const kd              = isNewFmt ? (d.kd?.kd ?? null)              : (d.kd !== undefined ? d.kd : null);
          const kdSource        = isNewFmt ? (d.kd?.source || null)          : (d.kd_source || null);
          const vol             = isNewFmt ? (d.vol?.monthly_impressions ?? null) : (d.monthly_impressions ?? null);
          const autoSuggestions = isNewFmt ? (d.auto?.suggestions || [])    : (d.auto_suggestions || []);
          const suggestions     = isNewFmt ? (d.sugg?.suggestions || [])    : (Array.isArray(d.sugg_suggestions) ? d.sugg_suggestions : []);
          const related         = Array.isArray(d.related) && d.related.length ? d.related : [];
          const tableRows       = related.length ? related : suggestions;

          kwLoading.style.display = "none";
          kwBtn.disabled = false;
          document.getElementById("kwResults").style.display = "";
          renderMainStats(kd, kdSource, vol);
          renderRelatedTable(tableRows, sid, !!related.length);
          renderAutoType(autoSuggestions);
          fetchTopPins(keyword, sid);
          const demoTerms = [keyword, ...tableRows.slice(0, 9).map(s => typeof s === "string" ? s : s.term)];
          fetchDemographics(demoTerms, country, sid);
          showCacheIndicator(cacheRes.cached_at);
          return;
        }
      } catch (_) {}
    }

    try {
      // ── Parallel: keyword data + suggestions + autotype ────
      kwLoadingTxt.textContent = t("pinterestKeywords.loading_parallel");
      const [kwDataRes, suggRes, autoRes] = await Promise.all([
        window.electronAPI.pinterestKwData(keyword).catch(() => null),
        window.electronAPI.pinterestKwSuggestions(keyword, country).catch(() => null),
        window.electronAPI.pinterestKwAutotype(keyword, 8).catch(() => null),
      ]);
      if (searchId !== sid) return;

      const vol             = kwDataRes?.ok ? kwDataRes.monthly_impressions : null;
      const kd              = kwDataRes?.ok ? kwDataRes.kd : null;
      const kdSource        = kwDataRes?.kd_source || null;
      const suggestions     = suggRes?.ok ? (suggRes.suggestions || []) : [];
      const autoSuggestions = autoRes?.ok ? (autoRes.suggestions || []) : [];

      kwLoading.style.display = "none";
      kwBtn.disabled = false;
      document.getElementById("kwResults").style.display = "";
      renderMainStats(kd, kdSource, vol);
      const relatedPromise = renderRelatedTable(suggestions, sid);
      renderAutoType(autoSuggestions);

      // ── Async: top pins + demographics ────────────────
      fetchTopPins(keyword, sid);
      const demoTerms = [keyword, ...(suggestions.slice(0, 9).map(s => typeof s === "string" ? s : s.term))];
      fetchDemographics(demoTerms, country, sid);

      // ── Save to server cache after related rows resolve ─
      relatedPromise.then(relatedResults => {
        if (searchId !== sid) return;
        saveServerCache(keyword, country, {
          vol: {
            ok:                  kwDataRes?.ok || false,
            keyword,
            monthly_impressions: vol,
            weekly_lower:        kwDataRes?.weekly_lower ?? null,
            weekly_upper:        kwDataRes?.weekly_upper ?? null,
            fallback:            kwDataRes?.volume_fallback || false,
          },
          kd: {
            ok:     kwDataRes?.ok || false,
            keyword,
            kd,
            source: kdSource,
          },
          auto: autoRes || { ok: false, suggestions: [] },
          sugg: suggRes || { ok: false, suggestions: [] },
          related: (relatedResults || []).filter(r => r != null),
        });
      });

    } catch (err) {
      if (searchId !== sid) return;
      kwLoading.style.display = "none";
      kwBtn.disabled = false;
      kwPlaceholder.style.display = "";
      kwPlaceholder.querySelector("p").textContent = `Error: ${err.message}`;
    }
  }

  // ── Boot ──────────────────────────────────────────────────
  $(document).ready(function () {
    kwInput      = document.getElementById("kwInput");
    kwDropdown   = document.getElementById("kwDropdown");
    kwCountry    = document.getElementById("kwCountry");
    kwBtn        = document.getElementById("kwBtn");
    kwPlaceholder= document.getElementById("kwPlaceholder");
    kwLoading    = document.getElementById("kwLoading");
    kwLoadingTxt = document.getElementById("kwLoadingText");
    kwResults    = document.getElementById("kwResults");
    kwCacheBar   = document.getElementById("kwCacheBar");

    if (window.I18n) window.I18n.translatePage();

    // Autotype dropdown
    const handleAutotype = debounce(async () => {
      const term = kwInput.value.trim();
      if (term.length < 2) { kwDropdown.style.display = "none"; return; }
      try {
        const res = await window.electronAPI.pinterestKwAutotype(term, 8);
        if (!res.ok || !res.suggestions?.length) { kwDropdown.style.display = "none"; return; }
        kwDropdown.innerHTML = res.suggestions.map(s =>
          `<div class="kw-dropdown-item" data-term="${esc(s)}"><span class="material-icons">search</span>${esc(s)}</div>`
        ).join("");
        kwDropdown.style.display = "";
        kwDropdown.querySelectorAll(".kw-dropdown-item").forEach(el => {
          el.addEventListener("click", () => {
            kwInput.value = el.dataset.term;
            kwDropdown.style.display = "none";
            analyze(el.dataset.term, kwCountry.value);
          });
        });
      } catch (_) { kwDropdown.style.display = "none"; }
    }, 300);

    $(kwInput).on("input" + NS, handleAutotype);
    $(kwInput).on("keydown" + NS, e => {
      if (e.key === "Enter") { kwDropdown.style.display = "none"; analyze(kwInput.value, kwCountry.value); }
    });
    $(kwBtn).on("click" + NS, () => { kwDropdown.style.display = "none"; analyze(kwInput.value, kwCountry.value); });

    $(document).on("click" + NS, e => {
      if (!kwDropdown.contains(e.target) && e.target !== kwInput) kwDropdown.style.display = "none";
    });

    // Trend modal close
    const closeTrendModal = () => { document.getElementById("kwTrendModal").style.display = "none"; };
    document.getElementById("kwTrendModalClose")?.addEventListener("click", closeTrendModal);
    document.getElementById("kwTrendModalBg")?.addEventListener("click", closeTrendModal);
    $(document).on("keydown" + NS, e => { if (e.key === "Escape") closeTrendModal(); });

    // Cleanup on page unload
    $(window).on("beforeunload" + NS, () => { $(document).off(NS); $(window).off(NS); });
  });
})();
