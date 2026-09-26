/**
 * Meta AI Image & Video Generation Module
 *
 * Browser UI automation approach: launches VCBrowser, restores cookies,
 * navigates to meta.ai/create, submits the prompt, detects the new
 * conversation in the sidebar, navigates to it, and polls for generated media.
 *
 * Queue-based system: one generation at a time per profile, parallel across profiles.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { app } = require('electron');

const { readKey, updateData, moveToPermStorage } = require('../lib/utils');
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('../lib/cdpFingerprint');

const TEMP_DIR = path.join(app.getPath('userData'), 'Uploads', 'Temp');
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0';

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Workflow tracking (for stop/cancel support)
const activeWorkflows = new Map();
// Per-profile task queues: profileId → [{ type, params, resolve }]
const taskQueues = new Map();
// Per-profile processing flags
const processingFlags = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildCookieHeader(cdpCookies) {
  if (!cdpCookies || cdpCookies.length === 0) return null;
  return cdpCookies.map((c) => `${c.name}=${c.value}`).join('; ');
}


async function closeBrowserGracefully(browserResult) {
  try {
    if (browserResult.debuggingPort) {
      const WebSocket = require('ws');
      const res = await fetch(`http://localhost:${browserResult.debuggingPort}/json/version`);
      const info = await res.json();
      if (info.webSocketDebuggerUrl) {
        const ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            setTimeout(() => { ws.close(); resolve(); }, 1000);
          });
          ws.on('error', reject);
          setTimeout(reject, 5000);
        });
        return;
      }
    }
  } catch (_) {}
  try { if (browserResult.client) await browserResult.client.close().catch(() => {}); } catch (_) {}
  try { if (browserResult.chromeProcess && !browserResult.chromeProcess.killed) browserResult.chromeProcess.kill(); } catch (_) {}
}

async function markProfileExpired(profileId) {
  try {
    const metaaiProfiles = (await readKey('metaaiProfiles')) || {};
    if (metaaiProfiles[profileId]) {
      metaaiProfiles[profileId].status = 'expired';
      await updateData('metaaiProfiles', metaaiProfiles);
      console.warn(`[Meta AI] Profile ${profileId} marked as expired`);
    }
  } catch (err) {
    console.warn(`[Meta AI] Failed to mark profile expired:`, err.message);
  }
}

// ─── Browser-based Generation ──────────────────────────────────────────────────

async function executeBrowserGeneration(profileId, params, mediaType) {
  const { prompt, workflowId } = params;
  const label = mediaType === 'video' ? 'Video' : 'Image';

  if (!isVCBrowserInstalled()) {
    return { success: false, value: 'VCBrowser is not installed. Please install it in Settings.' };
  }

  const metaaiProfiles = (await readKey('metaaiProfiles')) || {};
  const profile = metaaiProfiles[profileId];
  if (!profile || profile.status !== 'connected') {
    return { success: false, value: `Meta AI session not available for profile "${profileId}". Please reconnect in Settings.` };
  }

  let browserResult = null;
  try {
    const fingerprint = getConsistentFingerprintForProfile(profileId);
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
      }
    } catch (_) {}

    browserResult = await startVCBrowser(profileId, fingerprint, 'about:blank', null, true, true);

    if (!browserResult?.client) {
      return { success: false, value: 'Failed to launch browser for generation' };
    }

    const { client } = browserResult;
    const Runtime = client.Runtime;
    const Page = client.Page;
    const Network = client.Network;

    await Promise.all([Runtime.enable(), Page.enable(), Network.enable()]);

    // Restore cookies
    const cookies = profile.cdpCookies || [];
    for (const cookie of cookies) {
      try {
        await Network.setCookie({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly || false,
          expires: (!cookie.expires || cookie.expires <= 0)
            ? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
            : cookie.expires,
        });
      } catch (_) {}
    }

    // Navigate to /create
    await Page.navigate({ url: 'https://www.meta.ai/create' });

    // Wait for page load + composer to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
        return { success: false, value: 'Workflow was stopped' };
      }
      try {
        const { result } = await Runtime.evaluate({
          expression: `!!document.querySelector('div[data-testid="composer-input"]')`,
          returnByValue: true,
        });
        if (result.value === true) break;
      } catch (_) {}
    }

    // Check for login redirect
    try {
      const { result } = await Runtime.evaluate({ expression: 'window.location.href', returnByValue: true });
      const url = result?.value || '';
      if (url.includes('auth.meta.com') || url.includes('facebook.com/login')) {
        await markProfileExpired(profileId);
        return { success: false, value: `Meta AI session expired for profile "${profileId}". Please reconnect in Settings.` };
      }
    } catch (_) {}

    // Wait a bit so any lazy-loaded existing media is already in the DOM
    await new Promise((r) => setTimeout(r, 3000));

    // Snapshot existing conversation hrefs in the sidebar BEFORE submitting
    const existingHrefsExpr = `
      JSON.stringify(Array.from(document.querySelectorAll('li[data-testid="conversation-item"] a[href^="/prompt/"]')).map(a => a.getAttribute('href')))
    `;
    let existingHrefs = new Set();
    try {
      const { result } = await Runtime.evaluate({ expression: existingHrefsExpr, returnByValue: true });
      existingHrefs = new Set(JSON.parse(result.value || '[]'));
    } catch (_) {}
    console.log(`[Meta AI ${label}] Snapshotted ${existingHrefs.size} existing conversation(s)`);

    // If there's an attachment image, paste it into the composer via a synthetic paste event
    const { attachmentImagePath } = params;
    if (attachmentImagePath) {
      try {
        const fs = require('fs');
        const path = require('path');
        const imgBuffer = fs.readFileSync(attachmentImagePath);
        const imgBase64 = imgBuffer.toString('base64');
        const ext = path.extname(attachmentImagePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

        // Inject image into composer via DataTransfer synthetic paste event
        const pasteExpr = `
          (async function(base64, mimeType) {
            const el = document.querySelector('div[data-testid="composer-input"]');
            if (!el) return false;
            el.focus();
            // Convert base64 to Blob
            const byteStr = atob(base64);
            const arr = new Uint8Array(byteStr.length);
            for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
            const blob = new Blob([arr], { type: mimeType });
            const file = new File([blob], 'image' + (mimeType === 'image/png' ? '.png' : '.jpg'), { type: mimeType });
            const dt = new DataTransfer();
            dt.items.add(file);
            const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            el.dispatchEvent(pasteEvent);
            return true;
          })(${JSON.stringify(imgBase64)}, ${JSON.stringify(mimeType)})
        `;
        const { result: pasteResult } = await Runtime.evaluate({ expression: pasteExpr, returnByValue: true, awaitPromise: true });
        if (pasteResult.value) {
          console.log(`[Meta AI ${label}] Image attached via paste event`);
          // Wait for the attachment to appear in the UI
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          console.warn(`[Meta AI ${label}] Could not find composer for image paste`);
        }
      } catch (err) {
        console.warn(`[Meta AI ${label}] Image attachment error: ${err.message}`);
      }
    }

    // Type prompt into composer
    // Focus the contenteditable, clear it, then insert text
    const typeExpr = `
      (function(text) {
        const el = document.querySelector('div[data-testid="composer-input"]');
        if (!el) return false;
        el.focus();
        // Clear existing content
        el.innerHTML = '';
        // Use execCommand to insert text so React state updates
        document.execCommand('insertText', false, text);
        return true;
      })(${JSON.stringify(prompt)})
    `;
    const { result: typeResult } = await Runtime.evaluate({ expression: typeExpr, returnByValue: true });
    if (!typeResult.value) {
      return { success: false, value: 'Could not find the composer input on the page' };
    }

    await new Promise((r) => setTimeout(r, 500));

    // Click submit button
    const clickExpr = `
      (function() {
        const btn = document.querySelector('button[data-testid="composer-send-button"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `;
    const { result: clickResult } = await Runtime.evaluate({ expression: clickExpr, returnByValue: true });
    if (!clickResult.value) {
      return { success: false, value: 'Could not find the send button on the page' };
    }

    console.log(`[Meta AI ${label}] Prompt submitted, waiting for new conversation in sidebar...`);

    // Wait for a new /prompt/{uuid} href to appear in the sidebar (new conversation = this generation)
    const sidebarWaitStart = Date.now();
    let newConversationHref = '';
    while (Date.now() - sidebarWaitStart < 30000) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const { result } = await Runtime.evaluate({ expression: existingHrefsExpr, returnByValue: true });
        const current = JSON.parse(result.value || '[]');
        const newOne = current.find((h) => !existingHrefs.has(h));
        if (newOne) { newConversationHref = newOne; break; }
      } catch (_) {}
    }

    if (!newConversationHref) {
      return { success: false, value: `${label}: new conversation did not appear in sidebar after submit` };
    }

    // Navigate to the new conversation page — it only contains this generation's content
    const fullConvUrl = `https://www.meta.ai${newConversationHref}`;
    console.log(`[Meta AI ${label}] Navigating to conversation: ${fullConvUrl}`);
    await Runtime.evaluate({ expression: `window.location.href = ${JSON.stringify(fullConvUrl)}`, returnByValue: true });

    // Wait for page to finish loading
    await new Promise((r) => setTimeout(r, 3000));
    const waitExpr2 = `document.readyState === 'complete'`;
    const waitPageStart = Date.now();
    while (Date.now() - waitPageStart < 15000) {
      try {
        const { result } = await Runtime.evaluate({ expression: waitExpr2, returnByValue: true });
        if (result.value === true) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 500));
    }

    // Poll for the generated media — all media on this page belongs to this generation
    const maxWaitMs = mediaType === 'video' ? 180000 : 90000;
    const pollIntervalMs = 3000;
    const startTime = Date.now();
    let newUrls = [];

    const pollExpr = `
      (function(mediaType) {
        const found = [];
        if (mediaType === 'video') {
          document.querySelectorAll('div[data-testid="generated-video"][data-video-url]').forEach(function(el) {
            const u = el.getAttribute('data-video-url');
            if (u) found.push(u);
          });
        } else {
          document.querySelectorAll('div[data-testid="generated-image"] img[src], img[data-testid="generated-image"]').forEach(function(el) {
            if (el.src && !el.src.startsWith('data:')) found.push(el.src);
          });
          if (found.length === 0) {
            document.querySelectorAll('img[src*="fbcdn.net"], img[src*="scontent"]').forEach(function(el) {
              if (el.src && !el.src.startsWith('data:')) found.push(el.src);
            });
          }
        }
        return JSON.stringify([...new Set(found)]);
      })(${JSON.stringify(mediaType)})
    `;

    while (Date.now() - startTime < maxWaitMs) {
      if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
        return { success: false, value: 'Workflow was stopped' };
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));

      try {
        const { result } = await Runtime.evaluate({ expression: pollExpr, returnByValue: true });
        const found = JSON.parse(result.value || '[]');
        if (found.length > 0) {
          // Wait 2s more to let all results load (e.g. 4 images at once)
          await new Promise((r) => setTimeout(r, 2000));
          const { result: result2 } = await Runtime.evaluate({ expression: pollExpr, returnByValue: true });
          newUrls = JSON.parse(result2.value || '[]');
          console.log(`[Meta AI ${label}] Found ${newUrls.length} ${mediaType}(s) on conversation page`);
          break;
        }

        // Refresh the conversation page to check for newly generated content
        console.log(`[Meta AI ${label}] No media yet, refreshing conversation page...`);
        await Runtime.evaluate({ expression: 'window.location.reload()', returnByValue: true });
        // Wait for page to reload
        await new Promise((r) => setTimeout(r, 4000));
        const reloadWaitStart = Date.now();
        while (Date.now() - reloadWaitStart < 10000) {
          try {
            const { result: rr } = await Runtime.evaluate({ expression: `document.readyState === 'complete'`, returnByValue: true });
            if (rr.value === true) break;
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        console.warn(`[Meta AI ${label}] Poll error: ${err.message}`);
      }
    }

    if (newUrls.length === 0) {
      return { success: false, value: `${label} generation timed out — no new media appeared in the page` };
    }

    // All URLs are direct CDN links (fbcdn.net) — download them normally
    const cookieHeader = buildCookieHeader(cookies);
    const downloadedPaths = await downloadMediaFiles(cookieHeader, newUrls, mediaType, workflowId);

    if (downloadedPaths.length === 0) {
      return { success: false, value: `${label} generation succeeded but failed to download media` };
    }

    console.log(`[Meta AI ${label}] Done — ${downloadedPaths.length} file(s)`);
    return { success: true, value: downloadedPaths };

  } catch (err) {
    console.error(`[Meta AI ${label}] Browser generation error:`, err.message);
    return { success: false, value: `Generation error: ${err.message}` };
  } finally {
    if (browserResult) {
      try { await closeBrowserGracefully(browserResult); } catch (_) {}
    }
  }
}

// ─── Generation Wrappers ───────────────────────────────────────────────────────

async function executeImageGeneration(profileId, params) {
  return executeBrowserGeneration(profileId, params, 'image');
}

async function executeVideoGeneration(profileId, params) {
  return executeBrowserGeneration(profileId, params, 'video');
}

// ─── Media Download Helper ─────────────────────────────────────────────────────

async function downloadMediaFiles(cookieHeader, urls, type, workflowId) {
  const downloadedPaths = [];

  for (const url of urls) {
    if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
      return downloadedPaths;
    }

    try {
      const response = await fetch(url, {
        headers: {
          'Cookie': cookieHeader,
          'User-Agent': DEFAULT_USER_AGENT,
          'Referer': 'https://www.meta.ai/',
        },
        timeout: 60000,
      });

      if (!response.ok) {
        console.warn(`[Meta AI ${type}] Download failed: HTTP ${response.status}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = type === 'video' ? '.mp4' : '.jpg';
      const prefix = type === 'video' ? 'metaai_vid' : 'metaai';
      const tempFilename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      const tempPath = path.join(TEMP_DIR, tempFilename);
      fs.writeFileSync(tempPath, buffer);

      const moveOptions = {
        cleanAI: false,
        injectMetadata: null,
        nodeType: type === 'video' ? 'metaaivideo' : 'metaaiimage',
        workflowId,
      };

      if (type === 'image') {
        const automationSettings = (await readKey('automationSettings')) || {};
        moveOptions.cleanAI = automationSettings.aiImageCleaning !== false;
        const imageMetadataSettings = (await readKey('imageMetadataSettings')) || {};
        moveOptions.injectMetadata = imageMetadataSettings.enabled !== false ? imageMetadataSettings : null;
      }

      const moveResult = await moveToPermStorage(tempPath, moveOptions);
      downloadedPaths.push(moveResult.success ? moveResult.permanentPath : tempPath);
    } catch (err) {
      console.warn(`[Meta AI ${type}] Download error: ${err.message}`);
    }
  }

  return downloadedPaths;
}

// ─── Queue System ─────────────────────────────────────────────────────────────

function enqueueTask(profileId, type, params) {
  return new Promise((resolve) => {
    if (!taskQueues.has(profileId)) taskQueues.set(profileId, []);
    taskQueues.get(profileId).push({ type, params, resolve });
    processQueue(profileId);
  });
}

async function processQueue(profileId) {
  if (processingFlags.get(profileId)) return;

  const queue = taskQueues.get(profileId);
  if (!queue || queue.length === 0) return;

  processingFlags.set(profileId, true);
  const task = queue.shift();

  try {
    let result;
    if (task.type === 'image') {
      result = await executeImageGeneration(profileId, task.params);
    } else {
      result = await executeVideoGeneration(profileId, task.params);
    }
    task.resolve(result);
  } catch (err) {
    console.error(`[Meta AI] Task error for profile ${profileId}:`, err.message);
    task.resolve({ success: false, value: err.message || 'Unknown error' });
  }

  processingFlags.set(profileId, false);
  processQueue(profileId);
}

// ─── Public API ────────────────────────────────────────────────────────────────

async function metaaiImage(prompt, orientation, profileId, workflowId, attachmentImagePath) {
  if (!prompt) return { success: false, value: 'Prompt is required' };
  if (workflowId) activeWorkflows.set(workflowId, { active: true });
  return enqueueTask(profileId, 'image', { prompt, orientation, profileId, workflowId, attachmentImagePath });
}

async function metaaiVideo(prompt, profileId, workflowId, attachmentImagePath) {
  if (!prompt) return { success: false, value: 'Prompt is required' };
  if (workflowId) activeWorkflows.set(workflowId, { active: true });
  // Append video generation hint so Meta AI creates a video instead of images
  const videoPrompt = /video/i.test(prompt) ? prompt : `${prompt}, create a video`;
  return enqueueTask(profileId, 'video', { prompt: videoPrompt, profileId, workflowId, attachmentImagePath });
}

function stopWorkflowQueues(workflowId) {
  if (workflowId && activeWorkflows.has(workflowId)) {
    activeWorkflows.get(workflowId).active = false;
  }
  for (const [, queue] of taskQueues.entries()) {
    const remaining = [];
    for (const task of queue) {
      if (task.params.workflowId === workflowId) {
        task.resolve({ success: false, value: 'Workflow was stopped' });
      } else {
        remaining.push(task);
      }
    }
    if (remaining.length !== queue.length) {
      queue.length = 0;
      remaining.forEach((t) => queue.push(t));
    }
  }
}

function clearWorkflowStateForRerun(workflowId) {
  if (workflowId) {
    activeWorkflows.delete(workflowId);
    for (const [, queue] of taskQueues.entries()) {
      const remaining = queue.filter((t) => t.params.workflowId !== workflowId);
      if (remaining.length !== queue.length) {
        queue.length = 0;
        remaining.forEach((t) => queue.push(t));
      }
    }
  }
}

function getProfileLoad(profileId) {
  const queueLen = (taskQueues.get(profileId) || []).length;
  const processing = processingFlags.get(profileId) ? 1 : 0;
  return queueLen + processing;
}

module.exports = {
  metaaiImage,
  metaaiVideo,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
  getProfileLoad,
};
