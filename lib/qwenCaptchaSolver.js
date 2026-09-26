/**
 * Qwen (chat.qwen.ai) Captcha Solver
 *
 * chat.qwen.ai is protected by Alibaba's Baxia / NoCaptcha WAF. When a request
 * is flagged the API responds with:
 *
 *   { "ret": ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::SM::..."],
 *     "data": { "url": "https://chat.qwen.ai/.../_____tmd_____/punish?x5secdata=..." } }
 *
 * The Qwen frontend loads that `data.url` inside an iframe overlay and shows a
 * "slide to verify" slider. Sliding it to the end makes the in-page Alibaba JS
 * generate the `n` token and POST it to `.../_____tmd_____/slide`, which on
 * success returns `{ "code": 0, "success": true }` and whitelists the session.
 *
 * Because that token is bound to the exact browser session (cookies + IP +
 * fingerprint + in-page SDK state), the challenge can ONLY be cleared inside the
 * same logged-in browser. This module drives a chrome-remote-interface `client`
 * (Page / Runtime / Network / Input) to:
 *   1. detect the challenge (via the WAF JSON response, on the network layer)
 *   2. locate the slider (searching the top document + same-origin iframes)
 *   3. drag it to the end with human-like motion (CDP Input events)
 *   4. confirm success (the `/slide` response with code 0)
 *
 * No external captcha service is used.
 */

// ─── WAF response detection ─────────────────────────────────────────────────

/**
 * Returns the punish/captcha URL from a WAF challenge response body, or null.
 * @param {string} bodyText raw response body
 */
function extractPunishUrl(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return null;
  if (!/FAIL_SYS_USER_VALIDATE|RGV587_ERROR|x5secdata/i.test(bodyText)) return null;
  try {
    const json = JSON.parse(bodyText);
    const url = json?.data?.url;
    if (typeof url === 'string' && url.includes('x5secdata')) return url;
  } catch (_) {
    // Fall back to a regex scan for the url field
    const m = bodyText.match(/"url"\s*:\s*"([^"]*x5secdata[^"]*)"/);
    if (m) return m[1].replace(/\\\//g, '/');
  }
  return null;
}

/** True if the body is a WAF challenge (whether or not a url was parsed). */
function isChallengeBody(bodyText) {
  return !!bodyText && /FAIL_SYS_USER_VALIDATE|RGV587_ERROR/i.test(bodyText);
}

// ─── Slider geometry lookup (runs inside the page) ──────────────────────────
//
// Returns viewport-absolute coordinates of the slider button and its track by
// recursively walking same-origin iframes. The punish page is served from the
// chat.qwen.ai origin (iframe #baxia-dialog-content), so its iframe is readable
// from the parent document.

const FIND_SLIDER_EXPRESSION = `(function () {
  var BTN_SELECTORS = [
    '#nc_1_n1z', '#nc_2_n1z', '#nc_3_n1z',
    'span[id^="nc_"][id$="_n1z"]',
    '.nc_iconfont.btn_slide',
    '.slidetounlock .btn_slide',
    '.btn_slide',
    '[class*="btn_slide"]'
  ];
  var TRACK_SELECTORS = [
    '.nc_scale', '.nc_wrapper', '.scale_text', '.nc-lang-cnt', '.slidetounlock'
  ];

  function find(doc, offX, offY) {
    if (!doc) return null;
    var btn = null, usedSel = '';
    for (var i = 0; i < BTN_SELECTORS.length; i++) {
      var el = doc.querySelector(BTN_SELECTORS[i]);
      if (el) {
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { btn = el; usedSel = BTN_SELECTORS[i]; break; }
      }
    }
    if (btn) {
      var br = btn.getBoundingClientRect();
      var track = null;
      for (var j = 0; j < TRACK_SELECTORS.length; j++) {
        var t = doc.querySelector(TRACK_SELECTORS[j]);
        if (t) { var tr0 = t.getBoundingClientRect(); if (tr0.width > br.width) { track = t; break; } }
      }
      if (!track) track = btn.parentElement;
      var tr = track ? track.getBoundingClientRect() : null;
      return {
        found: true,
        selector: usedSel,
        btn: { x: br.x + offX, y: br.y + offY, w: br.width, h: br.height },
        track: tr ? { x: tr.x + offX, y: tr.y + offY, w: tr.width, h: tr.height } : null
      };
    }
    // Recurse into same-origin iframes
    var frames = doc.querySelectorAll('iframe');
    for (var k = 0; k < frames.length; k++) {
      try {
        var fr = frames[k].getBoundingClientRect();
        var idoc = frames[k].contentDocument;
        if (idoc) {
          var res = find(idoc, offX + fr.x, offY + fr.y);
          if (res && res.found) return res;
        }
      } catch (e) { /* cross-origin frame, skip */ }
    }
    return null;
  }

  try { return JSON.stringify(find(document, 0, 0) || { found: false }); }
  catch (e) { return JSON.stringify({ found: false, error: String(e) }); }
})()`;

// Detects an in-page success/failure marker for the NoCaptcha widget.
const CHECK_STATE_EXPRESSION = `(function () {
  function scan(doc) {
    if (!doc) return null;
    if (doc.querySelector('.nc-container .icon_ok, .nc_iconfont.icon_ok, [class*="nc-success"], .btn_ok')) return 'success';
    var errEl = doc.querySelector('.nc_scale .scale_text, .nc-lang-cnt');
    if (errEl) {
      var t = (errEl.textContent || '').toLowerCase();
      if (/success|succès|réussi|verified|完成|通过/.test(t)) return 'success';
      if (/fail|error|échou|réessay|retry|重试|失败/.test(t)) return 'retry';
    }
    var frames = doc.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { var r = scan(frames[i].contentDocument); if (r) return r; } catch (e) {}
    }
    return null;
  }
  try { return scan(document) || ''; } catch (e) { return ''; }
})()`;

// Types a message into the Qwen composer and sends it, to provoke the WAF
// challenge. Returns 'sent', 'no-input', or 'no-button'. Uses the native value
// setter + input event so the (React/Vue-controlled) send button enables.
function buildSendMessageExpression(text) {
  const safe = JSON.stringify(text);
  return `(function () {
    var ta = document.querySelector('.message-input-textarea')
          || document.querySelector('textarea[class*="message-input"]')
          || document.querySelector('textarea');
    if (!ta) return 'no-input';
    ta.focus();
    try {
      var proto = ta.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(ta, ${safe});
    } catch (e) { ta.value = ${safe}; }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    var btn = document.querySelector('.send-button')
           || document.querySelector('button[class*="send"]');
    if (btn && !btn.disabled) { btn.click(); return 'sent'; }
    // Fallback: dispatch Enter key on the textarea
    var ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    ta.dispatchEvent(ev);
    return btn ? 'sent' : 'no-button';
  })()`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(base, spread) {
  return base + (Math.random() * 2 - 1) * spread;
}

/**
 * Build a list of {x, y, delay} drag waypoints from start to end.
 *
 * Baxia rejects mechanical drags (constant velocity / too few points / no
 * overshoot), which makes the slider snap back to the start. To pass, the path
 * models a human gesture: a quick acceleration, a slower approach near the
 * target, an overshoot a few px past the end, then a small pull-back, with
 * non-uniform timing and slight vertical wobble.
 */
function buildDragPath(startX, startY, endX) {
  const distance = endX - startX;
  const overshoot = Math.max(4, Math.min(14, distance * 0.06)); // px past the end
  const peakX = endX + overshoot;
  const points = [];

  // Phase 1: move from start to the overshoot peak with ease-out velocity
  const fwdSteps = 32 + Math.floor(Math.random() * 16);
  for (let i = 1; i <= fwdSteps; i++) {
    const p = i / fwdSteps;
    // ease-out quart: fast start, gentle finish (human flick + settle)
    const eased = 1 - Math.pow(1 - p, 4);
    const x = startX + (peakX - startX) * eased;
    const y = startY + Math.sin(p * Math.PI) * jitter(1.5, 1.0);
    // Slower near the end, plus occasional micro-pauses
    let delay = 8 + p * 22 + Math.random() * 8;
    if (Math.random() < 0.08) delay += jitter(40, 25); // hesitation
    points.push({ x, y, delay });
  }

  // Phase 2: small pull-back from the overshoot to the exact end
  const backSteps = 6 + Math.floor(Math.random() * 5);
  for (let i = 1; i <= backSteps; i++) {
    const p = i / backSteps;
    const x = peakX + (endX - peakX) * p;
    const y = startY + jitter(0, 0.8);
    points.push({ x, y, delay: 14 + Math.random() * 14 });
  }

  return points;
}

// ─── Core: perform one slider drag ──────────────────────────────────────────

async function dragSliderOnce(client, geom, log) {
  const { Input } = client;
  const btn = geom.btn;
  const startX = btn.x + btn.w / 2;
  const startY = btn.y + btn.h / 2;

  // Target: end of the track (or a large fixed distance as fallback)
  let endX;
  if (geom.track && geom.track.w > btn.w) {
    endX = geom.track.x + geom.track.w - btn.w / 2 - jitter(1, 0.5);
  } else {
    endX = startX + 300; // fallback distance
  }

  log(`Dragging slider "${geom.selector}" from x=${startX.toFixed(0)} to x=${endX.toFixed(0)}`);

  // Approach + hover the handle (a couple of small moves), then press.
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX - jitter(6, 3), y: startY - jitter(4, 2) });
  await sleep(jitter(50, 25));
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX, y: startY });
  await sleep(jitter(90, 40));
  await Input.dispatchMouseEvent({
    type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1,
  });
  // Brief hold + tiny tremor before the gesture starts (humans aren't instant).
  await sleep(jitter(120, 50));
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX + jitter(1, 0.8), y: startY + jitter(0.5, 0.5), button: 'left', buttons: 1 });
  await sleep(jitter(40, 20));

  const path = buildDragPath(startX, startY, endX);
  for (const pt of path) {
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: pt.x, y: pt.y, button: 'left', buttons: 1 });
    await sleep(pt.delay);
  }

  // Settle at the end with a tiny final adjustment, pause, then release.
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: endX, y: startY + jitter(0, 0.6), button: 'left', buttons: 1 });
  await sleep(jitter(160, 70));
  await Input.dispatchMouseEvent({
    type: 'mouseReleased', x: endX, y: startY, button: 'left', buttons: 0, clickCount: 1,
  });
}

// ─── Captcha controller ─────────────────────────────────────────────────────
//
// Watches the network layer for the WAF challenge and the slide-success
// responses, so success can be confirmed independently of the (fragile) DOM.

function createCaptchaController(client, options = {}) {
  const { Network, Runtime } = client;
  const log = options.log || (() => {});

  const state = {
    challengeSeen: false,
    challengeUrl: null,
    solved: false,
    lastSlideCode: null,
    attached: false,
  };

  const reqUrlById = new Map();

  async function attach() {
    if (state.attached) return;
    state.attached = true;
    await Network.enable();

    Network.responseReceived(({ requestId, response }) => {
      if (response && response.url) reqUrlById.set(requestId, response.url);
    });

    Network.loadingFinished(async ({ requestId }) => {
      const url = reqUrlById.get(requestId);
      if (!url) return;
      const isCompletions = /\/api\/v2\/chat\/completions(\?|$)/.test(url) && !url.includes('_____tmd_____');
      const isSlide = url.includes('_____tmd_____/slide');
      if (!isCompletions && !isSlide) return;
      try {
        const { body, base64Encoded } = await Network.getResponseBody({ requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        if (isCompletions && isChallengeBody(text)) {
          const punishUrl = extractPunishUrl(text);
          state.challengeSeen = true;
          if (punishUrl) state.challengeUrl = punishUrl;
          log(`WAF challenge detected on completions response${punishUrl ? '' : ' (no url parsed)'}`);
        }
        if (isSlide) {
          try {
            const j = JSON.parse(text);
            state.lastSlideCode = j.code;
            if (j.code === 0 || j.success === true) {
              state.solved = true;
              log('Slide endpoint returned success (code 0).');
            } else {
              log(`Slide endpoint returned code=${j.code} dt=${j.dt || ''}`);
            }
          } catch (_) {}
        }
      } catch (_) {
        // Body may already be evicted; ignore.
      } finally {
        reqUrlById.delete(requestId);
      }
    });
  }

  /** Look for the slider in the page right now. */
  async function findSlider() {
    const res = await Runtime.evaluate({
      expression: FIND_SLIDER_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    });
    try { return JSON.parse(res?.result?.value || '{}'); } catch (_) { return { found: false }; }
  }

  async function checkDomState() {
    const res = await Runtime.evaluate({ expression: CHECK_STATE_EXPRESSION, returnByValue: true });
    return res?.result?.value || '';
  }

  /** Type a message into the composer and send it (to provoke the challenge). */
  async function sendChatMessage(text) {
    const res = await Runtime.evaluate({
      expression: buildSendMessageExpression(text),
      returnByValue: true,
    });
    const outcome = res?.result?.value || 'error';
    log(`Sent trigger message — composer result: ${outcome}`);
    return outcome;
  }

  /**
   * Attempt to solve a slider that is currently visible. Returns true on success.
   */
  async function solveVisible({ maxAttempts = 4, perAttemptTimeoutMs = 12000, waitForSliderMs = 15000 } = {}) {
    // The challenge overlay/iframe renders a beat after the WAF response is
    // received, so poll for the slider to appear before giving up.
    let firstGeom = await findSlider();
    if (!firstGeom.found) {
      const deadline = Date.now() + waitForSliderMs;
      while (Date.now() < deadline) {
        await sleep(700);
        firstGeom = await findSlider();
        if (firstGeom.found) break;
      }
    }
    if (!firstGeom.found) {
      log(`No slider element visible after waiting ${Math.round(waitForSliderMs / 1000)}s.`);
      return state.solved;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const geom = attempt === 1 ? firstGeom : await findSlider();
      if (!geom.found) {
        log('No slider element visible.');
        return state.solved;
      }
      log(`Slider found (attempt ${attempt}/${maxAttempts}).`);
      state.lastSlideCode = null;
      await dragSliderOnce(client, geom, log);

      const deadline = Date.now() + perAttemptTimeoutMs;
      while (Date.now() < deadline) {
        if (state.solved) return true;
        const dom = await checkDomState();
        if (dom === 'success') { log('DOM reports verification success.'); return true; }
        if (dom === 'retry') { log('DOM reports retry needed.'); break; }
        // If the slider disappeared and no failure was seen, treat as solved.
        const still = await findSlider();
        if (!still.found) {
          await sleep(500);
          if (state.solved) return true;
          // Slider gone with no explicit failure -> assume cleared.
          log('Slider disappeared after drag — assuming cleared.');
          return true;
        }
        await sleep(600);
      }
      log(`Attempt ${attempt} did not confirm success; retrying.`);
      await sleep(jitter(700, 300));
    }
    return state.solved;
  }

  return { state, attach, findSlider, checkDomState, sendChatMessage, solveVisible };
}

// ─── Reactive solve for a profile (used by the qwenBrowser automation) ───────
//
// When the proxy returns a WAF challenge for a profile, we open that profile's
// real browser session, solve the slider, then re-capture the cookies (Aliyun
// sets an `x5sec` whitelist cookie that is cookie-bound) and the auth token,
// saving them back to the profile so the proxy's next request uses the cleared
// session. A per-profile mutex guarantees at most one browser opens per profile.

const _solveInFlight = new Map(); // profileId -> Promise<boolean>

async function _doSolveForProfile(profileId, opts) {
  const { readKey, updateData } = require('./utils');
  const { startVCBrowser } = require('./VCBrowserManager');
  const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('./cdpFingerprint');

  const log = opts.log || ((m) => console.log(`[QwenCaptcha] ${m}`));
  const visible = opts.visible !== false; // default visible (proven to pass)
  const timeoutMs = Math.min(Math.max(parseInt(opts.timeoutMs) || 180000, 30000), 600000);

  let chromeProcess = null;
  let client = null;
  try {
    const profiles = (await readKey('qwenBrowserProfiles')) || {};
    const profile = profiles[profileId];
    if (!profile) {
      log(`Profile "${profileId}" not found.`);
      return false;
    }

    let fingerprint = getConsistentFingerprintForProfile(profileId);
    try {
      const v = getVCBrowserVersion();
      if (fingerprint.userAgent && v?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${v.full}`);
      }
    } catch (_) {}

    const proxy =
      profile.proxy && profile.proxy.ip && profile.proxy.ip !== 'NULL' ? profile.proxy : null;

    log(`Opening browser for profile "${profileId}" to solve captcha...`);
    const startResult = await startVCBrowser(
      profileId,
      fingerprint,
      'https://chat.qwen.ai/',
      proxy,
      !visible, // headless = !visible
      true, // automation mode
    );
    if (!startResult?.client) {
      log('Failed to start browser (no CDP client).');
      return false;
    }
    client = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;

    const controller = createCaptchaController(client, { log });
    await controller.attach();

    // Restore session cookies + token.
    try {
      for (const c of profile.cdpCookies || []) {
        const cc = {
          name: c.name,
          value: c.value,
          domain: c.domain || '.qwen.ai',
          path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: !!c.httpOnly,
        };
        if (c.expires && c.expires > 0) cc.expires = c.expires;
        try { await Network.setCookie(cc); } catch (_) {}
      }
    } catch (_) {}

    await Page.navigate({ url: 'https://chat.qwen.ai/' });
    await sleep(4000);

    if (profile.token) {
      try {
        await Runtime.evaluate({
          expression: `try{localStorage.setItem('token', ${JSON.stringify(profile.token)});}catch(e){}`,
        });
        await Page.navigate({ url: 'https://chat.qwen.ai/' });
        await sleep(3000);
      } catch (_) {}
    }

    // Send messages to provoke the challenge, then solve it.
    const deadline = Date.now() + timeoutMs;
    let solved = false;
    let lastSendAt = 0;
    let sendCount = 0;
    const maxSends = parseInt(opts.maxSends) || 5;

    while (Date.now() < deadline) {
      if (controller.state.solved) { solved = true; break; }
      const geom = await controller.findSlider();
      if (geom.found) {
        log('Captcha slider detected — solving...');
        solved = await controller.solveVisible({ maxAttempts: 4 });
        if (solved) { log('Captcha solved.'); break; }
      } else if (
        !controller.state.challengeSeen &&
        sendCount < maxSends &&
        Date.now() - lastSendAt > 8000
      ) {
        sendCount++;
        lastSendAt = Date.now();
        await controller.sendChatMessage(`hi ${sendCount}`);
      }
      if (chromeProcess && chromeProcess.killed) break;
      await sleep(1200);
    }

    // Re-capture cookies (including the x5sec whitelist) + token and persist.
    if (solved) {
      try {
        const ck = await Network.getCookies({ urls: ['https://chat.qwen.ai', 'https://chat.qwen.ai/'] });
        const cookies = ck?.cookies || [];
        if (cookies.length) {
          const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          const extended = cookies.map((c) => {
            const cc = { ...c };
            if (!cc.expires || cc.expires === -1 || cc.expires === 0) {
              cc.expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
            }
            return cc;
          });
          let token = profile.token;
          try {
            const t = await Runtime.evaluate({ expression: "localStorage.getItem('token')", returnByValue: true });
            if (t?.result?.value) token = t.result.value;
          } catch (_) {}

          const latest = (await readKey('qwenBrowserProfiles')) || {};
          if (latest[profileId]) {
            latest[profileId].cookies = cookieString;
            latest[profileId].cdpCookies = extended;
            latest[profileId].token = token;
            latest[profileId].status = 'connected';
            latest[profileId].updatedAt = new Date().toISOString();
            await updateData('qwenBrowserProfiles', latest);
            log('Refreshed cookies/token saved to profile.');
          }
        }
      } catch (e) {
        log(`Failed to re-capture cookies: ${e.message}`);
      }
    } else {
      log('Captcha was not solved within the time window.');
    }

    return solved;
  } catch (e) {
    log(`Reactive solve error: ${e.message}`);
    return false;
  } finally {
    try { if (chromeProcess && !chromeProcess.killed) chromeProcess.kill(); } catch (_) {}
  }
}

/**
 * Solve the Qwen WAF challenge for a profile, reusing an in-flight solve if one
 * is already running for the same profile (per-profile mutex).
 * @param {string} profileId
 * @param {object} [opts] { log, visible, timeoutMs, maxSends }
 * @returns {Promise<boolean>} whether the challenge was cleared
 */
function solveQwenChallengeForProfile(profileId, opts = {}) {
  if (_solveInFlight.has(profileId)) return _solveInFlight.get(profileId);
  const p = _doSolveForProfile(profileId, opts).finally(() => {
    _solveInFlight.delete(profileId);
  });
  _solveInFlight.set(profileId, p);
  return p;
}

module.exports = {
  extractPunishUrl,
  isChallengeBody,
  createCaptchaController,
  solveQwenChallengeForProfile,
};
