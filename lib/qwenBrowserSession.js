/**
 * Qwen Browser Session Manager
 *
 * Runs Qwen chat requests through a real, logged-in VCBrowser session instead
 * of the third-party OpenAI proxy. Doing so means Alibaba's in-page anti-bot
 * SDK (baxia) is loaded and attaches valid `bx-ua` / `bx-umidtoken` headers to
 * the `chat.qwen.ai/api/v2/chat/completions` request automatically — which is
 * what actually prevents the WAF (`RGV587_ERROR` / `x5sec`) from challenging in
 * the first place. When a challenge does appear, the slider is solved inside the
 * same session (see qwenCaptchaSolver) and the request is retried.
 *
 * Sessions are persistent and reused per profile (started lazily, kept warm,
 * auto-closed after an idle period) so we don't pay the browser-launch cost on
 * every request. Requests to the same profile are serialised through a queue.
 */

const fs = require('fs');
const path = require('path');
const { readKey, updateData } = require('./utils');
const { createCaptchaController } = require('./qwenCaptchaSolver');

const QWEN_URL = 'https://chat.qwen.ai/';
const IDLE_CLOSE_MS = 2 * 60 * 1000; // close a session after 2 min idle
const GEN_TIMEOUT_MS = 3 * 60 * 1000; // max wait for one generation

// profileId -> { client, chromeProcess, debuggingPort, busy, queue, lastUsed, idleTimer, ready }
const sessions = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Session lifecycle ──────────────────────────────────────────────────────

async function startSession(profileId, opts = {}) {
  const { startVCBrowser } = require('./VCBrowserManager');
  const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('./cdpFingerprint');
  const log = opts.log || ((m) => console.log(`[QwenSession] ${m}`));

  const profiles = (await readKey('qwenBrowserProfiles')) || {};
  const profile = profiles[profileId];
  if (!profile) throw new Error(`Qwen profile "${profileId}" not found`);

  let fingerprint = getConsistentFingerprintForProfile(profileId);
  try {
    const v = getVCBrowserVersion();
    if (fingerprint.userAgent && v?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${v.full}`);
    }
  } catch (_) {}

  const proxy =
    profile.proxy && profile.proxy.ip && profile.proxy.ip !== 'NULL' ? profile.proxy : null;

  const headless = opts.visible ? false : true;
  log(`Starting ${headless ? 'headless' : 'visible'} session for "${profileId}"${proxy ? ' (proxy)' : ''}...`);

  const startResult = await startVCBrowser(
    profileId,
    fingerprint,
    QWEN_URL,
    proxy,
    headless,
    true, // automation mode (auto-grants permissions)
  );
  if (!startResult?.client) throw new Error('Failed to start browser (no CDP client)');

  const client = startResult.client;
  const { Page, Runtime, Network, DOM } = client;
  await Network.enable();
  try { await Page.enable(); } catch (_) {}
  try { await Runtime.enable(); } catch (_) {}
  try { await DOM.enable(); } catch (_) {}

  // Restore session cookies + auth token, then load the app.
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

  await Page.navigate({ url: QWEN_URL });
  await sleep(3500);

  if (profile.token) {
    try {
      await Runtime.evaluate({
        expression: `try{localStorage.setItem('token', ${JSON.stringify(profile.token)});}catch(e){}`,
      });
      await Page.navigate({ url: QWEN_URL });
      await sleep(3000);
    } catch (_) {}
  }

  const controller = createCaptchaController(client, { log });
  await controller.attach();

  const session = {
    profileId,
    client,
    chromeProcess: startResult.chromeProcess,
    debuggingPort: startResult.debuggingPort,
    controller,
    busy: false,
    queue: [],
    lastUsed: Date.now(),
    idleTimer: null,
    closed: false,
  };

  startResult.chromeProcess?.on?.('exit', () => {
    session.closed = true;
    sessions.delete(profileId);
    log(`Session for "${profileId}" exited.`);
  });

  sessions.set(profileId, session);
  scheduleIdleClose(session);
  log(`Session for "${profileId}" ready.`);
  return session;
}

function scheduleIdleClose(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (!session.busy && session.queue.length === 0) {
      closeSession(session.profileId);
    }
  }, IDLE_CLOSE_MS);
}

function closeSession(profileId) {
  const session = sessions.get(profileId);
  if (!session) return;
  session.closed = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try { session.client?.close?.(); } catch (_) {}
  try { if (session.chromeProcess && !session.chromeProcess.killed) session.chromeProcess.kill(); } catch (_) {}
  sessions.delete(profileId);
}

function closeAllSessions() {
  for (const id of Array.from(sessions.keys())) closeSession(id);
}

async function getSession(profileId, opts) {
  let session = sessions.get(profileId);
  if (session && !session.closed && session.chromeProcess && !session.chromeProcess.killed) {
    return session;
  }
  if (session) sessions.delete(profileId);
  return startSession(profileId, opts);
}

// ─── Per-profile request serialisation ───────────────────────────────────────

function runExclusive(session, fn) {
  return new Promise((resolve, reject) => {
    session.queue.push({ fn, resolve, reject });
    pump(session);
  });
}

async function pump(session) {
  if (session.busy) return;
  const job = session.queue.shift();
  if (!job) return;
  session.busy = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    const result = await job.fn();
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  } finally {
    session.busy = false;
    session.lastUsed = Date.now();
    scheduleIdleClose(session);
    pump(session);
  }
}

// ─── In-page composer helpers (run inside the page) ──────────────────────────

// Starts a brand-new chat so each request is isolated.
const NEW_CHAT_EXPRESSION = `(function () {
  try {
    var btn = document.querySelector('[data-testid="new-chat"], a[href="/"], .new-chat-button, button[class*="new-chat"]');
    if (btn) { btn.click(); return 'clicked'; }
  } catch (e) {}
  return 'none';
})()`;

function buildTypeAndSendExpression(text) {
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
    var btn = document.querySelector('.send-button') || document.querySelector('button[class*="send"]');
    if (btn && !btn.disabled) { btn.click(); return 'sent'; }
    var ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    ta.dispatchEvent(ev);
    return btn ? 'sent' : 'no-button';
  })()`;
}

// Opens the thinking-mode selector dropdown next to the composer.
// Ant Design's Select toggles on a full mouse sequence (mousedown), not a bare
// .click(), so dispatch real pointer/mouse events on the selector.
const OPEN_THINKING_DROPDOWN_EXPRESSION = `(function () {
  var label = document.querySelector('.qwen-select-thinking-label')
           || document.querySelector('.qwen-select-thinking-label-text');
  if (!label) return 'no-select';
  var target = label.closest('.ant-select') || label;
  function fireMouse(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  function firePointer(el, type) {
    try { el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
  }
  firePointer(target, 'pointerdown'); fireMouse(target, 'mousedown');
  firePointer(target, 'pointerup'); fireMouse(target, 'mouseup'); fireMouse(target, 'click');
  return 'opened';
})()`;

// Picks the thinking mode from the open dropdown.
// mode: 'auto' | 'thinking' | 'fast'. Matching is by localized label first,
// then falls back to option position (0=auto, 1=thinking, 2=fast).
function buildPickThinkingModeExpression(mode) {
  const labelMap = {
    auto: ['automatique', 'automatic', 'auto', 'تلقائي'],
    thinking: ['réflexion', 'reflexion', 'thinking', 'think', 'تفكير', 'reasoning'],
    fast: ['rapide', 'fast', 'quick', 'سريع', 'instant'],
  };
  const idxMap = { auto: 0, thinking: 1, fast: 2 };
  const wanted = JSON.stringify(labelMap[mode] || []);
  const wantedIdx = idxMap[mode] != null ? idxMap[mode] : 0;
  return `(function () {
    var opts = Array.prototype.slice.call(document.querySelectorAll('.ant-select-item-option'));
    if (!opts.length) return 'no-options';
    var wanted = ${wanted};
    function labelOf(o) {
      var t = (o.getAttribute('title') || o.textContent || '').trim().toLowerCase();
      return t;
    }
    var target = null;
    for (var i = 0; i < opts.length; i++) {
      var l = labelOf(opts[i]);
      for (var j = 0; j < wanted.length; j++) {
        if (l.indexOf(wanted[j]) !== -1) { target = opts[i]; break; }
      }
      if (target) break;
    }
    if (!target && opts[${wantedIdx}]) target = opts[${wantedIdx}];
    if (!target) return 'not-found';
    if (target.getAttribute('aria-selected') === 'true') return 'already';
    function fireMouse(el, type) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    function firePointer(el, type) {
      try { el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    }
    var clickTarget = target.querySelector('.ant-select-item-option-content') || target;
    firePointer(clickTarget, 'pointerdown'); fireMouse(clickTarget, 'mousedown');
    firePointer(clickTarget, 'pointerup'); fireMouse(clickTarget, 'mouseup'); fireMouse(clickTarget, 'click');
    return 'picked';
  })()`;
}

// ─── Native SSE parsing ───────────────────────────────────────────────────────

// Parses the chat.qwen.ai completions response body. The native stream uses
// OpenAI-style `data:` lines with `choices[].delta`, plus a `phase` field that
// distinguishes thinking ("think") from the real answer ("answer"). We keep only
// answer content and ignore reasoning/thinking.
//
// Qwen's A/B "arena" mode streams TWO candidate answers in the same response
// (each delta carries its own `index`), so we bucket content by choice index
// and return only the first candidate to avoid duplicated output.
function parseQwenStream(bodyText) {
  const answers = new Map(); // index -> answer text
  const thinks = new Map();  // index -> thinking text
  const lines = bodyText.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const raw = t.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let d;
    try { d = JSON.parse(raw); } catch (_) { continue; }
    const choice = d.choices?.[0];
    const delta = choice?.delta;
    if (!delta) continue;
    const idx = typeof choice.index === 'number' ? choice.index : 0;
    const phase = delta.phase || delta.status || '';
    if (typeof delta.reasoning_content === 'string') {
      thinks.set(idx, (thinks.get(idx) || '') + delta.reasoning_content);
      continue;
    }
    if (typeof delta.content === 'string') {
      if (/think/i.test(phase)) {
        thinks.set(idx, (thinks.get(idx) || '') + delta.content);
      } else {
        answers.set(idx, (answers.get(idx) || '') + delta.content);
      }
    }
  }
  // Pick the first candidate (lowest index) that has answer content.
  const keys = Array.from(answers.keys()).sort((a, b) => a - b);
  let answer = '';
  for (const k of keys) {
    if (answers.get(k) && answers.get(k).trim()) { answer = answers.get(k); break; }
  }
  const thinkKeys = Array.from(thinks.keys()).sort((a, b) => a - b);
  const think = thinkKeys.length ? (thinks.get(thinkKeys[0]) || '') : '';

  // Fallback: if phase filtering produced nothing but there was thinking text,
  // the model may not have tagged phases — return whatever content we saw.
  if (!answer && think && !/think/i.test(lines.join(' '))) answer = think;

  answer = answer.trim();
  // Safety net: if arena candidates streamed under the same index, the answer
  // can come out as an exact doubling (e.g. "Hi.Hi."). Collapse that.
  if (answer.length % 2 === 0) {
    const half = answer.slice(0, answer.length / 2);
    if (half && half === answer.slice(answer.length / 2)) answer = half;
  }
  return { answer, think: think.trim() };
}

// ─── Capture the next completions response after a send ──────────────────────

function captureNextCompletions(session, log, noRequestMs = 25000) {
  const { Network } = session.client;
  return new Promise((resolve) => {
    let done = false;
    let sawRequest = false;
    const finish = (val) => { if (!done) { done = true; cleanup(); resolve(val); } };

    const onReqSent = ({ requestId, request }) => {
      const url = request?.url || '';
      if (/\/api\/v2\/chat\/completions(\?|$)/.test(url) && !url.includes('_____tmd_____')) {
        sawRequest = true;
        session._pendingCompletionId = requestId;
        log && log('Completions request fired — awaiting response...');
        clearTimeout(noReqTimer);
      }
    };

    const onFinished = async ({ requestId }) => {
      if (requestId !== session._pendingCompletionId) return;
      try {
        const { body, base64Encoded } = await Network.getResponseBody({ requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        finish({ ok: true, body: text });
      } catch (e) {
        finish({ ok: false, error: e.message });
      }
    };

    const onFailed = ({ requestId }) => {
      if (requestId === session._pendingCompletionId) finish({ ok: false, error: 'request failed' });
    };

    function cleanup() {
      if (unReq) unReq();
      if (unFin) unFin();
      if (unFail) unFail();
      clearTimeout(noReqTimer);
      clearTimeout(timer);
    }

    const unReq = Network.requestWillBeSent(onReqSent);
    const unFin = Network.loadingFinished(onFinished);
    const unFail = Network.loadingFailed(onFailed);
    // If the send never produces a completions request, fail fast instead of
    // waiting out the full generation timeout (this is what made the test hang).
    const noReqTimer = setTimeout(() => {
      if (!sawRequest) finish({ ok: false, error: 'no-request' });
    }, noRequestMs);
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), GEN_TIMEOUT_MS);
  });
}

// ─── Refresh cookies/token after a solve ─────────────────────────────────────

async function refreshProfileSession(session) {
  const { Network, Runtime } = session.client;
  try {
    const ck = await Network.getCookies({ urls: ['https://chat.qwen.ai', 'https://chat.qwen.ai/'] });
    const cookies = ck?.cookies || [];
    if (!cookies.length) return;
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const extended = cookies.map((c) => {
      const cc = { ...c };
      if (!cc.expires || cc.expires === -1 || cc.expires === 0) {
        cc.expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
      }
      return cc;
    });
    let token = null;
    try {
      const t = await Runtime.evaluate({ expression: "localStorage.getItem('token')", returnByValue: true });
      if (t?.result?.value) token = t.result.value;
    } catch (_) {}

    const latest = (await readKey('qwenBrowserProfiles')) || {};
    if (latest[session.profileId]) {
      latest[session.profileId].cookies = cookieString;
      latest[session.profileId].cdpCookies = extended;
      if (token) latest[session.profileId].token = token;
      latest[session.profileId].status = 'connected';
      latest[session.profileId].updatedAt = new Date().toISOString();
      await updateData('qwenBrowserProfiles', latest);
    }
  } catch (_) {}
}

// ─── Wait for the chat composer to be ready ──────────────────────────────────

// Polls the page for the message textarea. Also reports if the page is showing
// a login wall (no composer + a visible sign-in control) so the caller can mark
// the profile expired instead of waiting forever.
const COMPOSER_STATE_EXPRESSION = `(function () {
  var ta = document.querySelector('.message-input-textarea')
        || document.querySelector('textarea[class*="message-input"]')
        || document.querySelector('textarea');
  var login = document.querySelector('input[type="password"], [href*="login"], [class*="login"]');
  if (ta) return 'ready';
  if (login) return 'login';
  return 'wait';
})()`;

async function waitForComposer(session, log, timeoutMs = 30000) {
  const { Runtime } = session.client;
  const start = Date.now();
  let loginSeen = false;
  while (Date.now() - start < timeoutMs) {
    let state = 'wait';
    try {
      const res = await Runtime.evaluate({ expression: COMPOSER_STATE_EXPRESSION, returnByValue: true });
      state = res?.result?.value || 'wait';
    } catch (_) {}
    if (state === 'ready') {
      log('Composer ready.');
      return { ready: true };
    }
    if (state === 'login') loginSeen = true;
    await sleep(1500);
  }
  log(`Composer not ready after ${Math.round(timeoutMs / 1000)}s (loginWall=${loginSeen}).`);
  return { ready: false, loginWall: loginSeen };
}

// ─── Thinking-mode selection ─────────────────────────────────────────────────

// Reads the currently-selected thinking-mode label (lowercased).
const CURRENT_THINKING_LABEL_EXPRESSION = `(function () {
  var el = document.querySelector('.qwen-select-thinking-label-text');
  return el ? (el.textContent || '').trim().toLowerCase() : '';
})()`;

// Sets the composer's thinking mode. `mode` is 'auto' | 'thinking' | 'fast'.
async function setThinkingMode(session, mode, log) {
  const { Runtime } = session.client;
  const labelMatchers = {
    auto: ['automatique', 'automatic', 'auto', 'تلقائي'],
    thinking: ['réflexion', 'reflexion', 'thinking', 'think', 'تفكير', 'reasoning'],
    fast: ['rapide', 'fast', 'quick', 'سريع', 'instant'],
  };
  const matches = (label) =>
    (labelMatchers[mode] || []).some((w) => label.indexOf(w) !== -1);

  const attempt = async () => {
    const opened = await Runtime.evaluate({ expression: OPEN_THINKING_DROPDOWN_EXPRESSION, returnByValue: true });
    if ((opened?.result?.value || '') === 'no-select') {
      log(`Thinking-mode selector not found — skipping (${mode}).`);
      return 'no-select';
    }
    await sleep(700); // let the dropdown render
    const picked = await Runtime.evaluate({
      expression: buildPickThinkingModeExpression(mode),
      returnByValue: true,
    });
    return picked?.result?.value || 'error';
  };

  try {
    let outcome = await attempt();
    if (outcome === 'no-select') return;
    await sleep(500);

    // Verify the visible label now reflects the requested mode; retry once.
    let cur = '';
    try {
      const r = await Runtime.evaluate({ expression: CURRENT_THINKING_LABEL_EXPRESSION, returnByValue: true });
      cur = r?.result?.value || '';
    } catch (_) {}

    if (!matches(cur) && outcome !== 'already') {
      log(`Thinking mode still "${cur}" (wanted ${mode}) — retrying.`);
      outcome = await attempt();
      await sleep(500);
      try {
        const r2 = await Runtime.evaluate({ expression: CURRENT_THINKING_LABEL_EXPRESSION, returnByValue: true });
        cur = r2?.result?.value || cur;
      } catch (_) {}
    }
    log(`Thinking mode "${mode}": ${outcome} (label="${cur}")`);
  } catch (e) {
    log(`Thinking-mode set failed: ${e.message}`);
  }
}

// ─── Image attachment ─────────────────────────────────────────────────────────

// Polls for evidence that an uploaded image is attached to the composer
// (a thumbnail/preview), so we don't send before the upload finishes.
// Qwen renders the attached image inside `.vision-item-content img`.
const UPLOAD_READY_EXPRESSION = `(function () {
  return document.querySelectorAll('.vision-item-content img').length > 0;
})()`;

// Builds an expression that reconstructs the image as a real File in the page
// and simulates a drag-and-drop onto the composer. The native file dialog / "+"
// menu is unreliable to drive, but Qwen's drop handler works perfectly, so we
// dispatch dragenter/dragover/drop with a DataTransfer carrying the File.
function buildDropImageExpression(base64, fileName, mimeType) {
  const safeName = JSON.stringify(fileName);
  const safeMime = JSON.stringify(mimeType);
  return `(function () {
  try {
    var b64 = ${JSON.stringify(base64)};
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    var file = new File([bytes], ${safeName}, { type: ${safeMime} });

    // Pick the drop target: the chat composer area, falling back to body.
    var target = document.querySelector('.chat-message-input')
      || document.querySelector('.message-input-textarea')
      || document.querySelector('[class*="chat-input"]')
      || document.querySelector('[class*="composer"]')
      || document.body;
    if (!target) return 'no-target';

    var dt = new DataTransfer();
    dt.items.add(file);

    function fire(type) {
      var ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true });
      // Some browsers make dataTransfer read-only on the constructed event, so
      // override it to carry our DataTransfer.
      try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch (e) {}
      target.dispatchEvent(ev);
    }

    fire('dragenter');
    fire('dragover');
    fire('drop');
    return 'dropped';
  } catch (e) {
    return 'error:' + (e && e.message ? e.message : e);
  }
})()`;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.svg': return 'image/svg+xml';
    case '.jpg':
    case '.jpeg':
    default: return 'image/jpeg';
  }
}

// Attaches a local image to the Qwen composer by simulating a drag-and-drop.
// We read the file in Node, base64-encode it, then rebuild it as a real File
// in the page and dispatch the drop sequence the composer listens for.
async function attachImage(session, imagePath, log) {
  const { Runtime } = session.client;

  let base64;
  try {
    base64 = fs.readFileSync(imagePath).toString('base64');
  } catch (e) {
    log(`Could not read image file "${imagePath}": ${e.message}`);
    return false;
  }

  const fileName = path.basename(imagePath) || 'image.jpg';
  const mimeType = guessMimeType(imagePath);

  try {
    const dropRes = await Runtime.evaluate({
      expression: buildDropImageExpression(base64, fileName, mimeType),
      returnByValue: true,
    });
    const outcome = dropRes?.result?.value || 'error';
    log(`Image drop outcome: ${outcome}`);
    if (outcome !== 'dropped') {
      log('Image attachment did not complete (drop not accepted).');
      return false;
    }
  } catch (e) {
    log(`Image drop failed: ${e.message}`);
    return false;
  }

  await waitForUpload(session, log);
  return true;
}

// Polls for the uploaded image preview to appear (upload finished).
async function waitForUpload(session, log, timeoutMs = 30000) {
  const { Runtime } = session.client;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await Runtime.evaluate({ expression: UPLOAD_READY_EXPRESSION, returnByValue: true });
      if (r?.result?.value === true) {
        log('Image upload preview detected.');
        await sleep(800); // small settle
        return true;
      }
    } catch (_) {}
    await sleep(700);
  }
  log(`Image upload preview not detected after ${Math.round(timeoutMs / 1000)}s — sending anyway.`);
  return false;
}

// ─── Single chat turn inside a session ───────────────────────────────────────

async function doChatTurn(session, { prompt, imagePath, options, log }) {
  const { Page, Runtime } = session.client;

  // Start a fresh chat so context doesn't bleed across requests.
  await Page.navigate({ url: QWEN_URL });
  await sleep(2500);

  // The Qwen SPA loads asynchronously — wait for the composer before sending,
  // otherwise the send silently no-ops and we'd wait out the full timeout.
  const composerReady = await waitForComposer(session, log);
  if (!composerReady.ready) {
    if (composerReady.loginWall) {
      return { success: false, expired: true, value: 'Qwen session expired. Please reconnect this profile in Settings.' };
    }
    return { success: false, value: 'Qwen chat composer did not load (page may have failed to load).' };
  }

  // Set the thinking mode (Automatique / Réflexion / Rapide). `thinkingEnabled`
  // true -> "thinking", false -> "fast", undefined -> leave as "auto".
  if (options && typeof options.thinkingEnabled === 'boolean') {
    await setThinkingMode(session, options.thinkingEnabled ? 'thinking' : 'fast', log);
  } else if (options && options.thinkingMode) {
    await setThinkingMode(session, options.thinkingMode, log);
  }

  // Attach an image, if provided. Qwen uses a native file dialog, so this is
  // intercepted via CDP (see attachImage).
  if (imagePath) {
    await attachImage(session, imagePath, log);
  }

  const sendAndCapture = async () => {
    session._pendingCompletionId = null;
    const capturePromise = captureNextCompletions(session, log);
    const sendRes = await Runtime.evaluate({
      expression: buildTypeAndSendExpression(prompt || ''),
      returnByValue: true,
    });
    const outcome = sendRes?.result?.value || 'error';
    log(`Composer send outcome: ${outcome}`);
    return capturePromise;
  };

  let cap = await sendAndCapture();

  // Detect a WAF challenge from the captured body, then solve + retry once.
  const looksChallenged = (txt) =>
    !!txt && /FAIL_SYS_USER_VALIDATE|RGV587_ERROR|x5secdata|_____tmd_____|pureCaptcha/i.test(txt);

  let challenged = (cap.ok && looksChallenged(cap.body)) || session.controller.state.challengeSeen;
  // Also check the DOM for a visible slider (challenge may render without a
  // parseable completions body).
  if (!challenged) {
    try {
      const geom = await session.controller.findSlider();
      if (geom.found) challenged = true;
    } catch (_) {}
  }

  if (challenged) {
    log('WAF challenge detected — solving slider in-session...');
    // Attach the next-response capture BEFORE solving: once the slider passes,
    // Qwen automatically re-runs the original (blocked) request, so the answer
    // arrives without us re-typing. We must be listening before that happens.
    // Use a long no-request window since solving the slider can take ~20s+.
    session._pendingCompletionId = null;
    const postSolveCapture = captureNextCompletions(session, log, 90000);

    const solved = await session.controller.solveVisible({ maxAttempts: 4, waitForSliderMs: 20000 });
    if (!solved) {
      return { success: false, value: 'Qwen captcha could not be solved automatically. Please try again.' };
    }
    log('Captcha solved — waiting for the auto-retried response.');
    await refreshProfileSession(session);
    session.controller.state.solved = false;
    session.controller.state.challengeSeen = false;

    cap = await postSolveCapture;

    // If the page didn't auto-retry (no new completions request), send again.
    if (!cap.ok && cap.error === 'no-request') {
      log('No auto-retry detected — resending the prompt.');
      cap = await sendAndCapture();
    }
  }

  if (!cap.ok) {
    return { success: false, value: `Qwen request failed: ${cap.error || 'no response'}` };
  }

  const { answer } = parseQwenStream(cap.body);
  if (!answer) {
    // Could be a late challenge or an empty turn.
    if (looksChallenged(cap.body)) {
      return { success: false, value: 'Qwen captcha challenge detected (unsolved).' };
    }
    return { success: false, value: 'Qwen returned an empty response.' };
  }

  // Strip markdown code-fence wrappers, consistent with prior behaviour.
  const stripped = answer
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  return { success: true, value: stripped };
}

// ─── Centralized request scheduler ───────────────────────────────────────────
//
// A single global FIFO queue feeds every Qwen request. Each connected profile
// can run ONE request at a time (a browser page can't truly parallelise a single
// chat), but requests are spread across ALL connected profiles concurrently, so
// throughput scales with the number of connected accounts. This lets us absorb
// hundreds of queued requests gracefully: jobs wait their turn and are handed to
// the next profile that frees up. Sessions open lazily and idle-close after
// IDLE_CLOSE_MS (2 min) of no activity.

const profileBusy = new Map(); // profileId -> bool (a request is in flight)
const pendingQueue = [];       // { pinnedProfileId, params, resolve }
let dispatching = false;
let dispatchAgain = false;

const defaultLog = (m) => console.log(`[QwenSession] ${m}`);

async function dispatch() {
  // Coalesce concurrent dispatch requests; if one arrives mid-pass, re-run.
  if (dispatching) { dispatchAgain = true; return; }
  dispatching = true;
  try {
    do {
      dispatchAgain = false;
      await dispatchPass();
    } while (dispatchAgain && pendingQueue.length);
  } finally {
    dispatching = false;
  }
}

async function dispatchPass() {
  if (!pendingQueue.length) return;

  const profiles = (await readKey('qwenBrowserProfiles')) || {};
  const connected = Object.keys(profiles).filter(
    (id) => profiles[id].status === 'connected',
  );

  // Walk the queue in FIFO order. A job is dispatched to the first free profile
  // in its eligible pool; if its pool has no free profile, we leave it queued
  // and try the next job (a pinned job may target a different profile).
  let i = 0;
  while (i < pendingQueue.length) {
    const job = pendingQueue[i];

    let pool;
    if (job.pinnedProfileId) {
      pool = connected.includes(job.pinnedProfileId) ? [job.pinnedProfileId] : [];
    } else {
      pool = connected;
    }

    if (!pool.length) {
      // No usable profile for this job (none connected / pinned not connected).
      // Fail it rather than blocking the queue forever.
      pendingQueue.splice(i, 1);
      job.resolve({
        success: false,
        value: 'No Qwen Browser profile connected. Please connect an account in Settings.',
      });
      continue;
    }

    const free = pool.find((id) => !profileBusy.get(id));
    if (free) {
      pendingQueue.splice(i, 1);
      profileBusy.set(free, true);
      runJob(free, job); // concurrent across profiles — intentionally not awaited
      continue;
    }

    // Every profile this job could use is busy; try the next queued job.
    i++;
  }
}

async function runJob(profileId, job) {
  const log = job.params.log || defaultLog;
  let result;
  try {
    const session = await getSession(profileId, { visible: job.params.visible, log });
    result = await runExclusive(session, async () => {
      try {
        return await doChatTurn(session, {
          prompt: job.params.prompt,
          imagePath: job.params.imagePath || null,
          options: job.params.options || {},
          log,
        });
      } catch (e) {
        // A broken session is discarded so the next request reopens cleanly.
        log(`Chat turn error: ${e.message} — closing session.`);
        closeSession(profileId);
        return { success: false, value: `Qwen session error: ${e.message}` };
      }
    });
  } catch (e) {
    result = { success: false, value: `Failed to open Qwen session: ${e.message}` };
  } finally {
    profileBusy.set(profileId, false);
    if (result && typeof result === 'object') result.profileId = profileId;
    job.resolve(result || { success: false, value: 'Qwen request failed.' });
    dispatch(); // a profile just freed — pull the next queued job
  }
}

// ─── Public entry ────────────────────────────────────────────────────────────

/**
 * Run a chat request through the Qwen browser-session scheduler.
 *
 * The request is queued and dispatched to the next free connected profile.
 * Pass a `pinnedProfileId` to force a specific profile (used by Settings test
 * calls); pass `null` to let the scheduler pick any free connected profile.
 *
 * @param {string|null} pinnedProfileId
 * @param {object} params { prompt, imagePath, options, visible, log }
 * @returns {Promise<{success:boolean, value:string, expired?:boolean}>}
 */
function chat(pinnedProfileId, params = {}) {
  return new Promise((resolve) => {
    pendingQueue.push({ pinnedProfileId: pinnedProfileId || null, params, resolve });
    dispatch();
  });
}

module.exports = {
  chat,
  closeSession,
  closeAllSessions,
  getSession,
  parseQwenStream,
};
