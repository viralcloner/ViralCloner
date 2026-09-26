/**
 * TikTok Ads Image Generation Module (Browser)
 *
 * Generates images using the TikTok Ads Creative Studio "Image Generation"
 * mini-app via a real, logged-in VCBrowser session (see Settings > TikTok Ads).
 *
 * Because the requests must carry the account's signed cookies (sessionid,
 * msToken, csrftoken, etc.), all API calls are issued from INSIDE the logged-in
 * profile page via CDP Runtime.evaluate. A same-origin fetch on
 * ads.tiktok.com automatically attaches every required cookie/header, which is
 * what keeps TikTok from rejecting the request.
 *
 * Flow per request:
 *  1. Launch the connected profile browser (headless) at the Creative Studio
 *     image-to-video page.
 *  2. POST /api/cue/i2v/gen_i2i_image -> returns a taskId + draft placeholders.
 *  3. Poll /api/cue/generate-task/check until every draft has a rendered image
 *     (imageSrcSet.origin).
 *  4. Download each origin image (signed TikTok CDN URL) and store it.
 *  5. Return the array of local image paths.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { app } = require('electron');

const { readKey, updateData, moveToPermStorage } = require('../lib/utils');
const { startVCBrowser, isVCBrowserInstalled, killBrowsersForProfile } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('../lib/cdpFingerprint');
const { runWithProfileLock } = require('../lib/tiktokAdsBrowserLock');

const GENERATE_TIMEOUT_MS = 4 * 60 * 1000;
const PAGE_LOAD_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 4000;
const TEMP_DIR = path.join(app.getPath('userData'), 'Uploads', 'Temp');

const STUDIO_URL =
  'https://ads.tiktok.com/creative/creativestudio/image-to-video?subApp=CreativeStudio/ImageGeneration/I2VImageGeneration';

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const activeWorkflows = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function markProfileExpired(profileId) {
  try {
    const profiles = (await readKey('tiktokAdsProfiles')) || {};
    if (profiles[profileId]) {
      profiles[profileId].status = 'expired';
      await updateData('tiktokAdsProfiles', profiles);
    }
  } catch (_) {}
}

async function waitForPageReady(Runtime, timeoutMs = PAGE_LOAD_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { result } = await Runtime.evaluate({
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (result.value === 'complete' || result.value === 'interactive') {
        await new Promise((r) => setTimeout(r, 2500));
        return;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn('[TikTok Ads Image] Page readyState timeout - proceeding anyway');
}

async function closeBrowser(browserResult) {
  if (!browserResult) return;
  try {
    if (browserResult.debuggingPort) {
      const WebSocket = require('ws');
      const res = await fetch(`http://localhost:${browserResult.debuggingPort}/json/version`);
      const info = await res.json();
      const browserWsUrl = info.webSocketDebuggerUrl;
      if (browserWsUrl) {
        const ws = new WebSocket(browserWsUrl);
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
  try {
    if (browserResult.client) await browserResult.client.close().catch(() => {});
  } catch (_) {}
  try {
    if (browserResult.chromeProcess && !browserResult.chromeProcess.killed) {
      browserResult.chromeProcess.kill();
    }
  } catch (_) {}
}

/**
 * Uploads a local image into the TikTok Ads page by injecting it into the
 * page's own file input (CDP DOM.setFileInputFiles). The page's BytePlus/ImageX
 * upload SDK then performs the signed upload (ApplyImageUpload -> bytes ->
 * CommitImageUpload). We capture the resulting StoreUri from the
 * CommitImageUpload network response (and/or the rendered preview URL) and
 * return the public ibyteimg display URL used by the generation request.
 *
 * @returns {Promise<string>} the display URL of the uploaded image
 */
async function uploadAttachmentImage(client, imagePath) {
  const { Runtime, DOM, Network, Page } = client;
  await DOM.enable().catch(() => {});

  const captured = { storeUri: null, displayUrl: null };
  const commitRequestIds = new Set();

  // Flag CommitImageUpload responses so we can read their body when finished
  Network.responseReceived(({ requestId, response }) => {
    try {
      const url = response?.url || '';
      if (url.includes('Action=CommitImageUpload')) {
        commitRequestIds.add(requestId);
      }
    } catch (_) {}
  });

  // Read the committed StoreUri once the response body is available
  Network.loadingFinished(async ({ requestId }) => {
    if (!commitRequestIds.has(requestId)) return;
    commitRequestIds.delete(requestId);
    try {
      const { body, base64Encoded } = await Network.getResponseBody({ requestId });
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
      const json = JSON.parse(text);
      const uri =
        json?.Result?.PluginResult?.[0]?.ImageUri ||
        json?.Result?.Results?.[0]?.Uri ||
        null;
      if (uri) captured.storeUri = uri;
    } catch (_) {}
  });

  // The TikTok page has NO <input type=file>; it opens the native OS picker
  // (showOpenFilePicker / programmatic chooser). We intercept that chooser at
  // the CDP level: when Page.fileChooserOpened fires we get a backendNodeId
  // which we feed straight to DOM.setFileInputFiles — this works for both
  // real file inputs and the File System Access API picker.
  let chooserBackendNodeId = null;
  let chooserHandled = false;

  const onFileChooser = async (params) => {
    if (chooserHandled) return;
    chooserHandled = true;
    chooserBackendNodeId = params?.backendNodeId || null;
    try {
      if (chooserBackendNodeId) {
        await DOM.setFileInputFiles({
          backendNodeId: chooserBackendNodeId,
          files: [imagePath],
        });
        console.log('[TikTok Ads Image] File injected via intercepted chooser.');
      }
    } catch (e) {
      console.error('[TikTok Ads Image] setFileInputFiles failed:', e.message);
    }
  };

  Page.fileChooserOpened(onFileChooser);
  // Intercepting prevents the real native dialog from blocking automation
  await Page.setInterceptFileChooserDialog({ enabled: true }).catch(() => {});

  // Step 1: click the Upload (+) button. It lives in shadow DOM, so we recurse
  // through every shadow root to find button[aria-label="Upload"].
  async function clickUploadButton() {
    try {
      const { result } = await Runtime.evaluate({
        returnByValue: true,
        userGesture: true,
        expression: `(() => {
          const deepAll = () => {
            const out = [];
            const walk = (root) => {
              root.querySelectorAll('*').forEach((e) => { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); });
            };
            walk(document);
            return out;
          };
          const btn = deepAll().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Upload');
          if (btn) { btn.click(); return true; }
          return false;
        })()`,
      });
      return !!(result && result.value);
    } catch (_) {
      return false;
    }
  }

  // Step 2: click the "Upload image" menu item in the dropdown popover. We
  // match the deepest element whose trimmed text is exactly "Upload image",
  // then click its clickable container (the page handler creates a detached
  // <input type=file> and clicks it, which fires Page.fileChooserOpened).
  async function clickUploadImageMenuItem() {
    try {
      const { result } = await Runtime.evaluate({
        returnByValue: true,
        userGesture: true,
        expression: `(() => {
          const deepAll = () => {
            const out = [];
            const walk = (root) => {
              root.querySelectorAll('*').forEach((e) => { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); });
            };
            walk(document);
            return out;
          };
          const all = deepAll();
          const matches = all.filter((e) => {
            const t = (e.textContent || '').trim();
            if (!/^upload image$/i.test(t)) return false;
            return ![...e.children].some((c) => /^upload image$/i.test((c.textContent || '').trim()));
          });
          const target = matches[0];
          if (!target) return false;
          const clickable = target.closest('li, [class*=dropdown-item], [class*=menu-item], [role=menuitem]') || target;
          clickable.click();
          return true;
        })()`,
      });
      return !!(result && result.value);
    } catch (_) {
      return false;
    }
  }

  // Drive the click sequence; retry until the chooser fires or we time out.
  const findStart = Date.now();
  let menuItemClicked = false;
  while (Date.now() - findStart < 30000) {
    if (chooserHandled) break;
    const openedMenu = await clickUploadButton();
    if (openedMenu) {
      // give the dropdown popover time to render
      for (let i = 0; i < 3 && !chooserHandled; i++) {
        await new Promise((r) => setTimeout(r, 400));
      }
      if (chooserHandled) break;
      const clicked = await clickUploadImageMenuItem();
      menuItemClicked = menuItemClicked || clicked;
    }
    // wait for the chooser event before retrying the whole sequence
    for (let i = 0; i < 4 && !chooserHandled; i++) {
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  await Page.setInterceptFileChooserDialog({ enabled: false }).catch(() => {});

  if (!chooserHandled) {
    throw new Error(
      menuItemClicked
        ? 'Clicked "Upload image" but the file chooser never opened'
        : 'Could not find the image upload control on the TikTok Ads page'
    );
  }

  // Snapshot existing preview URLs so we can detect the newly uploaded one
  let beforeUrls = [];
  try {
    const beforeEval = await Runtime.evaluate({
      expression: `JSON.stringify([...document.querySelectorAll('img')].map(i => i.src).filter(s => /ibyteimg/.test(s)))`,
      returnByValue: true,
    });
    beforeUrls = JSON.parse(beforeEval.result.value || '[]');
  } catch (_) {}

  console.log('[TikTok Ads Image] Image injected into page, waiting for upload...');

  // Wait for the upload to complete (network capture preferred, DOM fallback)
  const waitStart = Date.now();
  while (Date.now() - waitStart < 90000) {
    if (captured.storeUri) break;
    try {
      const ev = await Runtime.evaluate({
        expression: `JSON.stringify([...document.querySelectorAll('img')].map(i => i.src).filter(s => /ibyteimg/.test(s)))`,
        returnByValue: true,
      });
      const nowUrls = JSON.parse(ev.result.value || '[]');
      const fresh = nowUrls.find((u) => !beforeUrls.includes(u));
      if (fresh) {
        captured.displayUrl = fresh;
        break;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
  }

  let url = captured.displayUrl;
  if (!url && captured.storeUri) {
    const m = captured.storeUri.match(/-i-([a-z0-9]+)-/i);
    const serviceId = m ? m[1] : '';
    url = `https://p19-creative-tool-sg.ibyteimg.com/${captured.storeUri}~tplv-${serviceId}-webp:1280:1280.image`;
  }
  if (!url) {
    throw new Error('Image upload did not complete in time');
  }
  console.log(`[TikTok Ads Image] Image uploaded: ${url.substring(0, 100)}`);
  return url;
}

/**
 * Runs a same-origin fetch inside the TikTok Ads page and returns the parsed
 * JSON response (or an error descriptor).
 */
async function inPageJsonFetch(Runtime, url, bodyObj) {
  const expr = `
    (async () => {
      try {
        const m = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/);
        const csrf = m ? decodeURIComponent(m[1]) : '';
        const resp = await fetch(${JSON.stringify(url)}, {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'agw-js-conv': 'str',
            'content-type': 'application/json',
            'x-creative-source': 'CreativeStudio/MiniApp/ImageToVideo',
            'x-csrftoken': csrf
          },
          body: ${JSON.stringify(JSON.stringify(bodyObj))},
          credentials: 'include'
        });
        let json = null;
        try { json = await resp.json(); } catch (_) {}
        return { ok: true, status: resp.status, json };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })()
  `;
  const { result } = await Runtime.evaluate({
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.value || { ok: false, error: 'No response from page' };
}

// ─── Public Entry Point ─────────────────────────────────────────────────────

/**
 * TikTok Ads Image (Browser) node.
 *
 * @param {string} prompt     The final prompt text
 * @param {string} model      The AI model id (e.g. "gemini")
 * @param {string} profileId  Connected TikTok Ads profile id
 * @param {string|null} workflowId  Workflow id (for stop support)
 * @param {string|null} attachmentImagePath  Optional local image to use as reference
 * @returns {{ success: boolean, value: string[]|string }}
 */
async function tiktokAdsImage(prompt, model, profileId, workflowId, attachmentImagePath) {
  if (!prompt || !prompt.trim()) {
    return { success: false, value: 'Prompt is required' };
  }

  // Track this node as in-flight for the workflow with a reference count so a
  // stop request is honored while a node is still queued, and the entry is only
  // removed once every queued node for the workflow has finished.
  if (workflowId) {
    let st = activeWorkflows.get(workflowId);
    if (!st) {
      st = { active: true, refs: 0 };
      activeWorkflows.set(workflowId, st);
    }
    st.refs++;
  }

  try {
    // Serialize per profile: TikTok Ads browsers for one profile share a single
    // Chrome user-data-dir, so running them concurrently makes them collide and
    // return duplicate images. Different profiles still run in parallel.
    return await runWithProfileLock(profileId, () =>
      _runTikTokAdsImage(prompt, model, profileId, workflowId, attachmentImagePath)
    );
  } finally {
    if (workflowId) {
      const st = activeWorkflows.get(workflowId);
      if (st && --st.refs <= 0) {
        activeWorkflows.delete(workflowId);
      }
    }
  }
}

async function _runTikTokAdsImage(prompt, model, profileId, workflowId, attachmentImagePath) {
  // The node may have been stopped while queued behind another generation.
  if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
    return { success: false, value: 'Workflow was stopped' };
  }

  const aiModel = (model && String(model).trim()) || 'gemini';
  let browserResult = null;

  try {
    const profiles = (await readKey('tiktokAdsProfiles')) || {};
    const profile = profiles[profileId];

    if (!profile || profile.status !== 'connected') {
      return {
        success: false,
        value: `TikTok Ads profile "${profileId}" is not connected. Please connect it in Settings.`,
      };
    }

    if (!isVCBrowserInstalled()) {
      return { success: false, value: 'VCBrowser is not installed. Please download it from Settings.' };
    }

    console.log(`[TikTok Ads Image] Generating with profile ${profileId}, model ${aiModel}`);
    console.log(`[TikTok Ads Image] Prompt: ${prompt.substring(0, 100)}`);

    // 1. Launch the logged-in profile browser at the Creative Studio page
    const fingerprint = getConsistentFingerprintForProfile(profileId);
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(
          /Chrome\/[\d.]+/,
          `Chrome/${vcVersion.full}`
        );
      }
    } catch (_) {}

    // Defensive: ensure no stale/headless browser is still holding this
    // profile's user-data-dir lock before launching a fresh one.
    try {
      const killed = killBrowsersForProfile(profileId);
      if (killed > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (_) {}

    browserResult = await startVCBrowser(
      profileId,
      fingerprint,
      STUDIO_URL,
      null,
      true,  // headless
      true   // automationMode
    );

    if (!browserResult || !browserResult.client) {
      return { success: false, value: 'Failed to start VCBrowser or get CDP client' };
    }

    const client = browserResult.client;
    const { Runtime, Page, Network } = client;
    await Promise.all([Runtime.enable(), Page.enable(), Network.enable()]);

    await waitForPageReady(Runtime);

    // Guard: make sure we are not bounced to a login page
    const urlCheck = await Runtime.evaluate({
      expression: 'window.location.href',
      returnByValue: true,
    });
    const currentUrl = urlCheck.result?.value || '';
    if (/\/(login|signup|passport|account\/login)/i.test(currentUrl)) {
      await markProfileExpired(profileId);
      return { success: false, value: 'TikTok Ads session expired. Please reconnect the profile in Settings.' };
    }

    // 1b. Optionally upload a reference image (image-to-image)
    let uploadedImageUrl = null;
    if (attachmentImagePath && fs.existsSync(attachmentImagePath)) {
      console.log(`[TikTok Ads Image] Uploading attachment image: ${attachmentImagePath}`);
      try {
        uploadedImageUrl = await uploadAttachmentImage(client, attachmentImagePath);
      } catch (uploadErr) {
        return { success: false, value: `Failed to upload attachment image: ${uploadErr.message}` };
      }
    }

    // 2. Submit the image generation request
    const settingsObj = uploadedImageUrl
      ? {
          images: [
            {
              id: crypto.randomUUID(),
              name: path.basename(attachmentImagePath),
              previewUrl: uploadedImageUrl,
              url: uploadedImageUrl,
              fileType: 'image',
            },
          ],
          aiModel,
          prompt,
        }
      : { images: [], aiModel, prompt };

    const submitResp = await inPageJsonFetch(
      Runtime,
      'https://ads.tiktok.com/creative_bff_i18n/api/cue/i2v/gen_i2i_image?aid=585599&app_name=creative_aio_client&device_platform=web',
      {
        images: uploadedImageUrl ? [uploadedImageUrl] : [],
        prompt,
        model: aiModel,
        settings: JSON.stringify(settingsObj),
      }
    );

    if (!submitResp.ok) {
      return { success: false, value: `Failed to submit generation request: ${submitResp.error}` };
    }
    const submitJson = submitResp.json;
    if (!submitJson || submitJson.code !== 0 || !submitJson.data?.task_id) {
      const msg = submitJson?.msg || submitJson?.message || `HTTP ${submitResp.status}`;
      // A non-zero code with an auth hint means the session is no longer valid
      if (/login|auth|session|cookie|csrf/i.test(String(msg))) {
        await markProfileExpired(profileId);
      }
      return { success: false, value: `TikTok Ads rejected the request: ${msg}` };
    }

    const taskId = submitJson.data.task_id;
    const expectedCount = Array.isArray(submitJson.data.draft_infos)
      ? submitJson.data.draft_infos.length
      : 0;
    console.log(`[TikTok Ads Image] Task ${taskId} created (${expectedCount} drafts)`);

    // 3. Poll until the images are rendered
    const startTime = Date.now();
    let imageUrls = [];

    while (Date.now() - startTime < GENERATE_TIMEOUT_MS) {
      if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
        return { success: false, value: 'Workflow was stopped' };
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const checkResp = await inPageJsonFetch(
        Runtime,
        'https://ads.tiktok.com/creative_bff_i18n/api/cue/generate-task/check?aid=585599&app_name=creative_aio_client&device_platform=web',
        { taskId }
      );

      if (!checkResp.ok || !checkResp.json) continue;
      const drafts = checkResp.json.data?.draft_infos || [];
      if (drafts.length === 0) continue;

      const ready = drafts
        .map((d) => d?.imageSrcSet?.origin || d?.coverImage || '')
        .filter((u) => u && /^https?:\/\//.test(u));

      // All expected drafts have a rendered image — done
      const target = expectedCount > 0 ? expectedCount : drafts.length;
      if (ready.length >= target) {
        imageUrls = ready;
        break;
      }
      console.log(`[TikTok Ads Image] Waiting... ${ready.length}/${target} ready`);
    }

    if (imageUrls.length === 0) {
      return { success: false, value: 'Timed out waiting for TikTok Ads to render images' };
    }

    console.log(`[TikTok Ads Image] ${imageUrls.length} image(s) ready, downloading...`);

    // 4. Download each rendered image (signed TikTok CDN URLs are public)
    const automationSettings = (await readKey('automationSettings')) || {};
    const cleanAI = automationSettings.aiImageCleaning !== false;
    const imageMetadataSettings = (await readKey('imageMetadataSettings')) || {};

    const downloadedPaths = [];
    for (const url of imageUrls) {
      if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
        return { success: false, value: 'Workflow was stopped' };
      }
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          console.warn(`[TikTok Ads Image] Download failed (${resp.status}) for ${url.substring(0, 80)}`);
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const tempFilename = `tiktokads_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
        const tempPath = path.join(TEMP_DIR, tempFilename);
        fs.writeFileSync(tempPath, buffer);

        const moveResult = await moveToPermStorage(tempPath, {
          cleanAI,
          injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
          nodeType: 'tiktokadsimage',
          workflowId,
        });

        const finalPath = moveResult.success ? moveResult.permanentPath : tempPath;
        downloadedPaths.push(finalPath);
        console.log(`[TikTok Ads Image] Downloaded: ${finalPath}`);
      } catch (dlErr) {
        console.warn(`[TikTok Ads Image] Download error: ${dlErr.message}`);
      }
    }

    if (downloadedPaths.length === 0) {
      return { success: false, value: 'Failed to download any generated images' };
    }

    console.log(`[TikTok Ads Image] Generated ${downloadedPaths.length} image(s)`);
    return { success: true, value: downloadedPaths };
  } catch (error) {
    console.error('[TikTok Ads Image] Error:', error);
    return { success: false, value: error.message || 'Unknown error during TikTok Ads image generation' };
  } finally {
    if (browserResult) {
      await closeBrowser(browserResult);
    }
  }
}

function stopWorkflowQueues(workflowId) {
  if (workflowId && activeWorkflows.has(workflowId)) {
    activeWorkflows.get(workflowId).active = false;
  }
}

function clearWorkflowStateForRerun(workflowId) {
  if (workflowId) {
    activeWorkflows.delete(workflowId);
  }
}

module.exports = {
  tiktokAdsImage,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
};
