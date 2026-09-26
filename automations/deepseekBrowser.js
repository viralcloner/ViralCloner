/**
 * DeepSeek (Browser) Automation Node
 *
 * Uses saved browser session credentials (token + cookies) to call
 * the DeepSeek chat API directly via HTTP. The bearer token and cookies
 * are captured once during the browser-based login flow in Settings.
 *
 * Flow per request:
 *  1. Load a connected profile (round-robin)
 *  2. Upload and process an optional image for vision
 *  3. Fetch and solve DeepSeek proof-of-work challenges
 *  4. POST to /api/v0/chat/completion with SSE streaming
 *  5. Collect only RESPONSE-type fragments (skip THINK fragments)
 *  6. Delete the conversation session
 *  7. Return the assembled text
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { solveDeepSeekPow: solveDeepSeekPowVM } = require('../lib/deepseek-pow');
const { readKey, updateData } = require('../lib/utils');

// ─── Per-profile concurrency control ────────────────────────────────────────
// Each connected profile can only handle one request at a time.
// Incoming requests wait in a queue and are dispatched to the next free profile.

// Map<profileId, boolean> – true when that profile is currently busy
const profileBusy = new Map();
// Queue of waiters: each entry is { resolve: (profileId) => void }
const waitQueue = [];

/**
 * Acquire a free profile. If all connected profiles are busy, waits until one
 * becomes free. Returns the profileId of the acquired profile.
 */
async function acquireProfile(connected) {
  // Find a free profile right now
  const free = connected.find((id) => !profileBusy.get(id));
  if (free) {
    profileBusy.set(free, true);
    return free;
  }
  // All busy – queue up and wait
  return new Promise((resolve) => waitQueue.push({ resolve, connected }));
}

/**
 * Release a profile back to the pool. Dispatches to the next waiter if any.
 */
function releaseProfile(profileId) {
  // Check if there's a waiter that still has this profile in their connected list
  for (let i = 0; i < waitQueue.length; i++) {
    const waiter = waitQueue[i];
    if (waiter.connected.includes(profileId)) {
      waitQueue.splice(i, 1);
      profileBusy.set(profileId, true);
      waiter.resolve(profileId);
      return;
    }
  }
  // No matching waiter – mark free
  profileBusy.set(profileId, false);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DS_HOST = 'chat.deepseek.com';
const DS_ORIGIN = 'https://chat.deepseek.com';
const COMPLETION_TARGET = '/api/v0/chat/completion';
const UPLOAD_TARGET = '/api/v0/file/upload_file';

const SHARED_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  origin: DS_ORIGIN,
  referer: `${DS_ORIGIN}/`,
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'x-app-version': '2.0.0',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-locale': 'en',
  'x-client-platform': 'web',
  'x-client-version': '2.0.0',
  'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

/**
 * Simple HTTPS request helper (returns Buffer body + statusCode).
 */
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * HTTPS streaming request: resolves with Node.js IncomingMessage stream.
 */
function httpsStream(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => resolve(res));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function getDeepSeekErrorMessage(body) {
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  try {
    const parsed = JSON.parse(raw);
    const message =
      parsed?.data?.biz_msg ||
      parsed?.data?.biz_data?.message ||
      parsed?.msg ||
      parsed?.message ||
      raw;
    return typeof message === 'string' ? message : JSON.stringify(message);
  } catch (_) {
    return raw;
  }
}

/**
 * A temporary usage limit, capacity error, or anti-bot response must not
 * permanently disable a saved profile. Only classify a response as an expired
 * login when DeepSeek clearly reports an authentication failure.
 */
function isSessionExpiredResponse(status, body) {
  if (status === 401) return true;
  if (status !== 403) return false;

  const message = getDeepSeekErrorMessage(body).toLowerCase();
  if (!message) return false;
  if (/rate.?limit|too many|quota|capacity|busy|temporar|usage.?limit/.test(message)) {
    return false;
  }

  return /unauthori[sz]ed|not\s+(?:logged|signed)\s+in|log\s*in\s+again|invalid\s+(?:access\s+)?token|token\s+(?:is\s+)?expired|session\s+(?:is\s+)?expired|authentication\s+(?:fail(?:ed|s|ure)?|required)/.test(message);
}

// ─── Proof-of-Work ────────────────────────────────────────────────────────────

/**
 * Fetch a fresh PoW challenge for the given target path.
 * Endpoint: POST /api/v0/chat/create_pow_challenge
 */
async function fetchPowChallenge(token, cookieString, targetPath = COMPLETION_TARGET) {
  try {
    const body = JSON.stringify({ target_path: targetPath });
    const options = {
      hostname: DS_HOST,
      path: '/api/v0/chat/create_pow_challenge',
      method: 'POST',
      headers: {
        ...SHARED_HEADERS,
        authorization: token,
        cookie: cookieString,
        'content-type': 'application/json',
        referer: DS_ORIGIN + '/',
        'content-length': Buffer.byteLength(body),
      },
    };
    const res = await httpsRequest(options, body);
    if (res.status !== 200) {
      console.error('[DeepSeek Browser] PoW challenge body:', res.body.toString().slice(0, 500));
      return null;
    }
    const parsed = JSON.parse(res.body.toString());
    // DeepSeek wraps the challenge in { code, msg, data: { biz_code, biz_msg, biz_data: { challenge: {...} } } }
    const challenge =
      parsed?.data?.biz_data?.challenge ||
      parsed?.data?.challenge ||
      parsed?.challenge ||
      parsed;
    return challenge;
  } catch (err) {
    console.error('[DeepSeek Browser] PoW challenge error:', err.message);
    return null;
  }
}

/**
 * DeepSeekHashV1 PoW solver.
 *
 * Delegates to the bundled DeepSeek pow worker (lib/deepseek-pow), which
 * runs the actual web-app worker code (chunks 38401 + 60816) inside a
 * Node `vm` sandbox. The algorithm is a non-standard 23-round Keccak
 * variant DeepSeek calls "DeepSeekHashV1".
 */
async function solveDeepSeekPow(challengeData) {
  return solveDeepSeekPowVM(challengeData);
}

/**
 * Build the base64-encoded x-ds-pow-response header value.
 * Returns null if challenge fetch failed (header is omitted).
 */
async function buildPowHeader(token, cookieString, targetPath = COMPLETION_TARGET) {
  const challengeData = await fetchPowChallenge(token, cookieString, targetPath);
  if (!challengeData || !challengeData.challenge) {
    console.error('[DeepSeek Browser] No challenge data:', JSON.stringify(challengeData));
    return null;
  }

  const answer = await solveDeepSeekPow(challengeData);

  const powObj = {
    algorithm: challengeData.algorithm || 'DeepSeekHashV1',
    challenge: challengeData.challenge,
    salt: challengeData.salt,
    answer,
    signature: challengeData.signature,
    target_path: challengeData.target_path || targetPath,
  };
  return Buffer.from(JSON.stringify(powObj), 'utf8').toString('base64');
}

function getImageMimeType(filePath) {
  const mimeTypes = {
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.webp': 'image/webp',
  };
  return mimeTypes[path.extname(filePath).toLowerCase()] || 'image/png';
}

function sanitizeMultipartFilename(fileName) {
  return fileName.replace(/[\r\n"]/g, '_');
}

/**
 * Upload a local image to DeepSeek and return its reference file id.
 */
async function uploadImage(profile, imagePath) {
  const resolvedPath = path.resolve(String(imagePath).trim());
  let imageBuffer;
  try {
    imageBuffer = await fs.promises.readFile(resolvedPath);
  } catch (err) {
    throw new Error(`Could not read DeepSeek image input "${resolvedPath}": ${err.message}`);
  }

  const fileName = sanitizeMultipartFilename(path.basename(resolvedPath));
  const mimeType = getImageMimeType(resolvedPath);
  const boundary = `----ViralClonerDeepSeek${crypto.randomBytes(16).toString('hex')}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const requestBody = Buffer.concat([prefix, imageBuffer, suffix]);
  const powHeader = await buildPowHeader(
    profile.token,
    profile.cookies || '',
    UPLOAD_TARGET
  );

  const headers = {
    ...SHARED_HEADERS,
    authorization: profile.token,
    cookie: profile.cookies || '',
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': requestBody.length,
    'x-file-size': String(imageBuffer.length),
    'x-model-type': 'vision',
    'x-thinking-enabled': '1',
    referer: `${DS_ORIGIN}/`,
  };
  if (powHeader) headers['x-ds-pow-response'] = powHeader;

  const res = await httpsRequest(
    {
      hostname: DS_HOST,
      path: UPLOAD_TARGET,
      method: 'POST',
      headers,
    },
    requestBody
  );

  if (res.status !== 200) {
    throw new Error(
      `DeepSeek image upload failed (HTTP ${res.status}): ${res.body
        .toString('utf8')
        .slice(0, 200)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body.toString('utf8'));
  } catch (_) {
    throw new Error('DeepSeek returned an invalid image upload response.');
  }
  const fileId =
    parsed?.data?.biz_data?.id ||
    parsed?.data?.id ||
    parsed?.id ||
    null;
  if (!fileId) {
    throw new Error('DeepSeek did not return an uploaded file id.');
  }
  return fileId;
}

/**
 * DeepSeek parses vision uploads asynchronously, so wait until the file is ready.
 */
async function waitForImageProcessing(profile, fileId) {
  const deadline = Date.now() + 60_000;
  let pollDelay = 150;

  while (Date.now() < deadline) {
    const res = await httpsRequest({
      hostname: DS_HOST,
      path: `/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
      method: 'GET',
      headers: {
        ...SHARED_HEADERS,
        authorization: profile.token,
        cookie: profile.cookies || '',
        priority: 'u=1, i',
        referer: `${DS_ORIGIN}/`,
      },
    });

    if (res.status !== 200) {
      throw new Error(
        `DeepSeek image processing failed (HTTP ${res.status}): ${res.body
          .toString('utf8')
          .slice(0, 200)}`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body.toString('utf8'));
    } catch (_) {
      throw new Error('DeepSeek returned an invalid image processing response.');
    }
    const files = parsed?.data?.biz_data?.files || parsed?.data?.files || [];
    const uploadedFile = files.find((file) => String(file?.id) === String(fileId));
    const status = uploadedFile?.status;
    if (status === 'SUCCESS') return;
    if (['FAILED', 'FAIL', 'ERROR'].includes(status)) {
      throw new Error('DeepSeek could not process the uploaded image.');
    }

    await new Promise((resolve) => setTimeout(resolve, pollDelay));
    pollDelay = Math.min(Math.round(pollDelay * 1.4), 600);
  }

  throw new Error('DeepSeek image processing timed out after 60 seconds.');
}

// ─── SSE Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a DeepSeek SSE data line and update the accumulator state.
 * Handles multiple known DeepSeek web-app SSE formats.
 */
function processSSELine(line, state) {
  if (!line.startsWith('data: ')) return false;
  const raw = line.slice(6).trim();
  if (!raw) return false;

  let d;
  try {
    d = JSON.parse(raw);
  } catch (_) {
    return false;
  }

  // DeepSeek reports some request failures inside an HTTP-200 SSE hint event.
  // Preserve those failures instead of misreporting them as an empty response.
  if (d.type === 'error') {
    state.error = d.content || 'DeepSeek rejected the request.';
    state.finishReason = d.finish_reason || null;
    return false;
  }

  // Track all seen paths for diagnostics
  if (typeof d.p === 'string') state.seenPaths.add(d.p);

  // ── Completion signal ──
  if (
    d.p === 'response/status' &&
    d.o === 'SET' &&
    (d.v === 'FINISHED' || d.v === 'COMPLETE' || d.v === 'Success')
  ) {
    state.finished = true;
    return false;
  }

  // ── Format A: accumulated_output content (e.g. p="response/accumulated_output/content") ──
  // NOTE: must NOT match fragment content paths like "response/fragments/-1/content"
  if (typeof d.p === 'string' && d.p.endsWith('/content') && !d.p.includes('thinking') && !d.p.includes('fragments') && !d.p.includes('search') && typeof d.v === 'string') {
    state.text += d.v;
    state.currentType = 'RESPONSE';
    return false;
  }

  // ── Format A: accumulated_output thinking (skip) ──
  if (typeof d.p === 'string' && d.p.includes('thinking') && !d.p.includes('fragments') && typeof d.v === 'string') {
    state.currentType = 'THINK';
    return false;
  }

  // ── Format B: fragment content append with tracked type ──
  if (d.p === 'response/fragments/-1/content' && typeof d.v === 'string') {
    // Only skip if explicitly in a THINK or non-answer type; always collect RESPONSE
    if (state.currentType === 'RESPONSE') state.text += d.v;
    return false;
  }

  // ── Format B: new fragment appended (sets type) ──
  if (d.p === 'response/fragments' && d.o === 'APPEND') {
    const frags = Array.isArray(d.v) ? d.v : [d.v];
    // Iterate all appended fragments and collect any RESPONSE content
    for (const frag of frags) {
      if (!frag || !frag.type) continue;
      if (frag.type === 'RESPONSE') {
        state.currentType = 'RESPONSE';
        state.text += frag.content || '';
      } else {
        // Only update currentType to last non-RESPONSE fragment if no RESPONSE seen yet
        state.currentType = frag.type;
      }
    }
    // Always set currentType to the last fragment's type
    const last = frags[frags.length - 1];
    if (last && last.type) state.currentType = last.type;
    return false;
  }

  // ── Format B2: BATCH compound operations on "response" (used with web search) ──
  // e.g. {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[{...RESPONSE...}]},{"p":"has_pending_fragment","o":"SET","v":false}]}
  if (d.p === 'response' && d.o === 'BATCH' && Array.isArray(d.v)) {
    for (const op of d.v) {
      if (op.p === 'fragments' && op.o === 'APPEND') {
        const frags = Array.isArray(op.v) ? op.v : [op.v];
        for (const frag of frags) {
          if (!frag || !frag.type) continue;
          if (frag.type === 'RESPONSE') {
            state.currentType = 'RESPONSE';
            state.text += frag.content || '';
          } else {
            state.currentType = frag.type;
          }
        }
        const last = frags[frags.length - 1];
        if (last && last.type) state.currentType = last.type;
      }
    }
    return false;
  }

  // ── Format C: initial full response object ──
  if (d.v && typeof d.v === 'object') {
    const resp = d.v.response || d.v;

    // accumulated_output sub-object
    if (resp.accumulated_output) {
      const ao = resp.accumulated_output;
      if (typeof ao.content === 'string' && ao.content) {
        state.text += ao.content;
      }
      return false;
    }

    // fragments array — collect ALL RESPONSE-type fragments
    if (resp.fragments && Array.isArray(resp.fragments)) {
      for (const frag of resp.fragments) {
        if (frag && frag.type === 'RESPONSE' && frag.content) {
          state.text += frag.content;
        }
      }
      const last = resp.fragments[resp.fragments.length - 1];
      if (last && last.type) state.currentType = last.type;
      return false;
    }

    // OpenAI-like delta format
    const delta = d.v?.choices?.[0]?.delta;
    if (delta && typeof delta.content === 'string') {
      state.text += delta.content;
      return false;
    }

    return false;
  }

  // ── Format D: bare string value with no path (shorthand continuation) ──
  if (d.p === undefined && typeof d.v === 'string') {
    // Only accumulate when explicitly in RESPONSE mode
    if (state.currentType === 'RESPONSE') state.text += d.v;
    return false;
  }

  return false;
}

// ─── Main API Call ────────────────────────────────────────────────────────────

/**
 * Create a new chat session via /api/v0/chat_session/create.
 * Returns the session id plus enough failure detail to distinguish an expired
 * login from temporary account limits and service errors.
 */
async function createChatSession(token, cookieString) {
  try {
    const body = JSON.stringify({});
    const options = {
      hostname: DS_HOST,
      path: '/api/v0/chat_session/create',
      method: 'POST',
      headers: {
        ...SHARED_HEADERS,
        authorization: token,
        cookie: cookieString,
        'content-type': 'application/json',
        referer: `${DS_ORIGIN}/`,
        'content-length': Buffer.byteLength(body),
      },
    };
    const res = await httpsRequest(options, body);
    if (res.status !== 200) {
      const responseBody = res.body.toString('utf8');
      console.error('[DeepSeek Browser] Create session body:', responseBody.slice(0, 500));
      return {
        sessionId: null,
        status: res.status,
        message: getDeepSeekErrorMessage(responseBody),
        expired: isSessionExpiredResponse(res.status, responseBody),
      };
    }
    const parsed = JSON.parse(res.body.toString());
    const sessionId =
      parsed?.data?.biz_data?.chat_session?.id ||
      parsed?.data?.chat_session?.id ||
      null;
    return {
      sessionId,
      status: res.status,
      message: sessionId ? '' : getDeepSeekErrorMessage(res.body),
      expired: false,
    };
  } catch (err) {
    console.error('[DeepSeek Browser] Create session error:', err.message);
    return {
      sessionId: null,
      status: null,
      message: err.message,
      expired: false,
    };
  }
}

async function callDeepSeekAPI(profile, prompt, thinkingEnabled, searchEnabled, imagePath) {
  const token = profile.token;
  const cookieString = profile.cookies || '';

  const refFileIds = [];
  if (imagePath) {
    const fileId = await uploadImage(profile, imagePath);
    await waitForImageProcessing(profile, fileId);
    refFileIds.push(fileId);
  }

  // Create a real chat session (DeepSeek validates it exists)
  const createResult = await createChatSession(token, cookieString);
  const sessionId = createResult.sessionId;
  if (!sessionId) {
    const statusText = createResult.status ? ` (HTTP ${createResult.status})` : '';
    const detail = createResult.message ? `: ${createResult.message.slice(0, 200)}` : '';
    return {
      success: false,
      value: createResult.expired
        ? `DeepSeek session expired${statusText}. Please reconnect in Settings.`
        : `DeepSeek failed to create chat session${statusText}${detail}`,
      expired: createResult.expired,
    };
  }

  // Build PoW header (best-effort – omitted if challenge endpoint unavailable)
  const powHeader = await buildPowHeader(token, cookieString, COMPLETION_TARGET);

  const requestBody = JSON.stringify({
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: refFileIds.length > 0 ? 'vision' : 'default',
    prompt,
    ref_file_ids: refFileIds,
    thinking_enabled: !!thinkingEnabled,
    search_enabled: !!searchEnabled,
    action: null,
    preempt: false,
  });

  const reqHeaders = {
    ...SHARED_HEADERS,
    accept: 'text/event-stream',
    authorization: token,
    cookie: cookieString,
    'content-type': 'application/json',
    referer: `${DS_ORIGIN}/`,
    priority: 'u=1, i',
  };
  if (powHeader) reqHeaders['x-ds-pow-response'] = powHeader;

  const clientTimezoneOffset = String(new Date().getTimezoneOffset());
  reqHeaders['x-client-timezone-offset'] = clientTimezoneOffset;

  const options = {
    hostname: DS_HOST,
    path: '/api/v0/chat/completion',
    method: 'POST',
    headers: {
      ...reqHeaders,
      'content-length': Buffer.byteLength(requestBody),
    },
  };

  const stream = await httpsStream(options, requestBody);

  if (stream.statusCode !== 200) {
    // Capture the body for diagnostics
    const errChunks = [];
    stream.on('data', (c) => errChunks.push(c));
    await new Promise((res) => stream.on('end', res));
    const errBody = Buffer.concat(errChunks).toString('utf8').slice(0, 2000);
    console.error('[DeepSeek Browser] Non-200 body:', errBody);
    const expired = isSessionExpiredResponse(stream.statusCode, errBody);
    return {
      success: false,
      value: expired
        ? `DeepSeek session expired (HTTP ${stream.statusCode}). Please reconnect in Settings.`
        : `DeepSeek API error (HTTP ${stream.statusCode}): ${getDeepSeekErrorMessage(errBody).slice(0, 200)}`,
      expired,
      sessionId,
    };
  }

  // ── Parse SSE stream ──────────────────────────────────────────────────────
  const state = {
    text: '',
    currentType: null,
    finished: false,
    error: null,
    finishReason: null,
    seenPaths: new Set(),
  };
  let lineBuffer = '';
  let closed = false;
  let totalBytes = 0;
  const rawSample = [];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      closed = true;
      stream.destroy();
      resolve();
    }, 10 * 60 * 1000); // 10-minute timeout

    stream.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (rawSample.length < 5) rawSample.push(chunk.toString('utf8').slice(0, 500));
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // keep partial last line

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed === 'event: close') {
          closed = true;
          clearTimeout(timeout);
          stream.destroy();
          resolve();
          return;
        }
        processSSELine(trimmed, state);
      }
    });

    stream.on('end', () => {
      clearTimeout(timeout);
      resolve();
    });

    stream.on('error', (err) => {
      clearTimeout(timeout);
      // If the connection was aborted mid-stream but we already received text,
      // treat it as a successful (complete) response rather than a hard failure.
      if (state.text.length > 0) {
        console.warn('[DeepSeek Browser] Stream aborted with partial text, returning accumulated response:', err.message);
        resolve();
      } else {
        reject(err);
      }
    });
  });

  if (state.error) {
    const reason = state.finishReason ? ` (${state.finishReason})` : '';
    return {
      success: false,
      value: `DeepSeek error: ${state.error}${reason}`,
      sessionId,
    };
  }

  if (state.text.length === 0 && rawSample.length > 0) {
    console.error('[DeepSeek Browser] Empty response — seen paths:', [...state.seenPaths].join(', '));
    console.error('[DeepSeek Browser] Raw stream sample:', rawSample.join('\n---CHUNK---\n'));
  }

  return {
    success: true,
    value: state.text.trim(),
    sessionId,
  };
}

// ─── Delete Conversation ─────────────────────────────────────────────────────

async function deleteConversation(profile, sessionId) {
  try {
    const body = JSON.stringify({ chat_session_id: sessionId });
    const options = {
      hostname: DS_HOST,
      path: '/api/v0/chat_session/delete',
      method: 'POST',
      headers: {
        ...SHARED_HEADERS,
        authorization: profile.token,
        cookie: profile.cookies || '',
        'content-type': 'application/json',
        referer: `${DS_ORIGIN}/`,
        'content-length': Buffer.byteLength(body),
      },
    };
    await httpsRequest(options, body);
  } catch (err) {
    console.warn('[DeepSeek Browser] Failed to delete conversation:', err.message);
  }
}

// ─── Mark Profile Expired ─────────────────────────────────────────────────────

async function markProfileExpired(profileId) {
  try {
    const profiles = (await readKey('deepseekBrowserProfiles')) || {};
    if (profiles[profileId]) {
      profiles[profileId].status = 'expired';
      await updateData('deepseekBrowserProfiles', profiles);
    }
  } catch (_) {}
}

async function markProfileConnected(profileId) {
  try {
    const profiles = (await readKey('deepseekBrowserProfiles')) || {};
    if (profiles[profileId] && profiles[profileId].status !== 'connected') {
      profiles[profileId].status = 'connected';
      profiles[profileId].updatedAt = new Date().toISOString();
      await updateData('deepseekBrowserProfiles', profiles);
    }
  } catch (_) {}
}

// ─── Public Entry Point ───────────────────────────────────────────────────────

/**
 * DeepSeek (Browser) node
 * @param {string}  prompt          The prompt text
 * @param {boolean} thinkingEnabled Enable deep-think mode
 * @param {boolean} searchEnabled   Enable web search
 * @param {string|null} pinnedProfileId Force a specific profile for test calls
 * @param {string|null} imagePath   Optional local image file path
 * @returns {{ success: boolean, value: string }}
 */
async function deepseekBrowser(
  prompt,
  thinkingEnabled = false,
  searchEnabled = false,
  pinnedProfileId = null,
  imagePath = null
) {
  if ((!prompt || !prompt.trim()) && !imagePath) {
    return { success: false, value: 'Prompt is required' };
  }

  const profiles = (await readKey('deepseekBrowserProfiles')) || {};
  const connected = Object.keys(profiles).filter(
    (id) => profiles[id].status === 'connected'
  );

  // Older versions incorrectly marked temporary account limits as an expired
  // login. If no connected profile is available, retry one of those saved
  // profiles so it can recover automatically once the limit is lifted.
  const recoverable = Object.keys(profiles).filter(
    (id) =>
      profiles[id].status === 'expired' &&
      profiles[id].token &&
      profiles[id].cookies
  );
  const pinnedIsUsable = !!(
    pinnedProfileId &&
    profiles[pinnedProfileId]?.token &&
    profiles[pinnedProfileId]?.cookies
  );

  if (connected.length === 0 && recoverable.length === 0 && !pinnedIsUsable) {
    return {
      success: false,
      value:
        'No DeepSeek Browser profile connected. Please connect an account in Settings.',
    };
  }

  // If a specific profile is pinned, use only that one (for test calls)
  const pool = pinnedIsUsable
    ? [pinnedProfileId]
    : (connected.length > 0 ? connected : recoverable);

  // Acquire a free profile (waits if all are busy)
  const profileId = await acquireProfile(pool);
  const profile = profiles[profileId];

  let apiResult;
  try {
    apiResult = await callDeepSeekAPI(
      profile,
      prompt || '',
      thinkingEnabled,
      searchEnabled,
      imagePath
    );
  } catch (err) {
    releaseProfile(profileId);
    return {
      success: false,
      value: `DeepSeek Browser request failed: ${err.message}`,
    };
  }

  // Release the profile slot now that the API call is done
  releaseProfile(profileId);

  // Mark expired if session rejected
  if (apiResult.expired) {
    await markProfileExpired(profileId);
    return { success: false, value: apiResult.value };
  }

  // Creating a chat session proves the saved login is valid, even when the
  // completion itself is rejected by a temporary usage limit.
  if (profile.status !== 'connected' && apiResult.sessionId) {
    await markProfileConnected(profileId);
  }

  // Delete the conversation (fire-and-forget style)
  if (apiResult.sessionId) {
    deleteConversation(profile, apiResult.sessionId).catch(() => {});
  }

  if (!apiResult.success) {
    return { success: false, value: apiResult.value };
  }

  if (!apiResult.value) {
    return { success: false, value: 'DeepSeek returned an empty response' };
  }

  // Strip markdown code fence wrappers (e.g. ```html ... ``` or ``` ... ```)
  // Also strip DeepSeek web search citation markers like [citation:1]
  const stripped = apiResult.value
    .trim()
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/\[citation:\d+\]/g, '')
    .trim();

  return { success: true, value: stripped };
}

module.exports = { deepseekBrowser };
