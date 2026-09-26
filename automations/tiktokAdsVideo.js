/**
 * TikTok Ads Video Generation Module (Browser)
 *
 * Generates videos using the TikTok Ads Creative Studio "Reference to Video"
 * (Image-to-Video / R2V) mini-app via a real, logged-in VCBrowser session
 * (see Settings > TikTok Ads — profiles are shared with the TikTok Ads Image
 * node and stored under the `tiktokAdsProfiles` key).
 *
 * Because the requests must carry the account's signed cookies (sessionid,
 * msToken, csrftoken, etc.), all API calls are issued from INSIDE the logged-in
 * profile page via CDP Runtime.evaluate. A same-origin fetch on
 * ads.tiktok.com automatically attaches every required cookie/header, which is
 * what keeps TikTok from rejecting the request.
 *
 * Flow per request:
 *  1. Launch the connected profile browser (headless) at the Reference-to-Video
 *     page.
 *  2. (Optional) Upload a reference image (image-to-video).
 *  3. POST /api/cue/i2v/gen_r2v_video -> returns a taskId + draft placeholders.
 *  4. Poll /api/cue/generate-task/check until the draft has a rendered video
 *     (videoInfo.VideoInfos[].MainUrl).
 *  5. Download the rendered MP4 (signed TikTok CDN URL) and store it.
 *  6. Return the local video path.
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

const GENERATE_TIMEOUT_MS = 20 * 60 * 1000;
const PAGE_LOAD_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 5000;
const TEMP_DIR = path.join(app.getPath('userData'), 'Uploads', 'Temp');

const STUDIO_URL =
  'https://ads.tiktok.com/creative/creativestudio/image-to-video?subApp=CreativeStudio/ReferenceToVideo/ReferenceToVideo';
const STUDIO_URL_I2V =
  'https://ads.tiktok.com/creative/creativestudio/image-to-video?subApp=CreativeStudio/MiniApp/ImageToVideo';
const STUDIO_URL_T2V =
  'https://ads.tiktok.com/creative/creativestudio/image-to-video?subApp=CreativeStudio/MiniApp/TextToVideo';

// R2V (Reference to Video) model strategy id used by Creative Studio.
const R2V_MODEL = '2000003';
// I2V (Image/Text to Video) model strategy id used by Creative Studio.
const I2V_MODEL = '4000003';
// T2V (Text to Video) model strategy id used by Creative Studio.
const T2V_MODEL = '5000003';

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
  console.warn('[TikTok Ads Video] Page readyState timeout - proceeding anyway');
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
 * Uploads one or more local images into the TikTok Ads page by intercepting the
 * page's file chooser (CDP Page.fileChooserOpened + DOM.setFileInputFiles). The
 * page's BytePlus/ImageX upload SDK then performs the signed upload
 * (ApplyImageUpload -> bytes -> CommitImageUpload). We capture each resulting
 * StoreUri from the CommitImageUpload network response (and/or the rendered
 * preview URL) and return the public ibyteimg display URLs used by the
 * generation request. Images are uploaded sequentially so each one maps to its
 * own preview URL (Reference to Video accepts multiple images).
 *
 * @param {object} client     CDP client
 * @param {string[]} imagePaths  Local image paths to upload (in order)
 * @returns {Promise<string[]>} the display URLs of the uploaded images
 */
async function uploadAttachmentImages(client, imagePaths) {
  const { Runtime, DOM, Network, Page } = client;
  await DOM.enable().catch(() => {});

  // Collect every committed StoreUri across the whole session (deduped, ordered)
  const storeUris = [];
  const seenStoreUris = new Set();
  const commitRequestIds = new Set();

  Network.responseReceived(({ requestId, response }) => {
    try {
      const url = response?.url || '';
      if (url.includes('Action=CommitImageUpload')) {
        commitRequestIds.add(requestId);
      }
    } catch (_) {}
  });

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
      if (uri && !seenStoreUris.has(uri)) {
        seenStoreUris.add(uri);
        storeUris.push(uri);
      }
    } catch (_) {}
  });

  // The TikTok page has NO persistent <input type=file>; it creates a detached
  // input on demand and clicks it, opening the native picker. We intercept the
  // chooser at the CDP level and feed the backendNodeId to setFileInputFiles.
  // `currentImagePath` is swapped before each click sequence so the same handler
  // injects the right file for each image.
  let currentImagePath = null;
  let chooserHandled = false;

  const onFileChooser = async (params) => {
    if (chooserHandled) return;
    chooserHandled = true;
    const backendNodeId = params?.backendNodeId || null;
    try {
      if (backendNodeId && currentImagePath) {
        await DOM.setFileInputFiles({
          backendNodeId,
          files: [currentImagePath],
        });
        console.log('[TikTok Ads Video] File injected via intercepted chooser.');
      }
    } catch (e) {
      console.error('[TikTok Ads Video] setFileInputFiles failed:', e.message);
    }
  };

  Page.fileChooserOpened(onFileChooser);
  await Page.setInterceptFileChooserDialog({ enabled: true }).catch(() => {});

  // Step 1: click the Upload (+) button (lives in shadow DOM).
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

  // Step 2: click the "Upload image" menu item in the dropdown popover.
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

  async function snapshotIbyteimgUrls() {
    try {
      const ev = await Runtime.evaluate({
        expression: `JSON.stringify([...document.querySelectorAll('img')].map(i => i.src).filter(s => /ibyteimg/.test(s)))`,
        returnByValue: true,
      });
      return JSON.parse(ev.result.value || '[]');
    } catch (_) {
      return [];
    }
  }

  function storeUriToDisplayUrl(uri) {
    const m = uri.match(/-i-([a-z0-9]+)-/i);
    const serviceId = m ? m[1] : '';
    return `https://p19-creative-tool-sg.ibyteimg.com/${uri}~tplv-${serviceId}-webp:1280:1280.image`;
  }

  const uploadedUrls = [];

  for (let idx = 0; idx < imagePaths.length; idx++) {
    currentImagePath = imagePaths[idx];
    chooserHandled = false;
    const storeUrisBefore = storeUris.length;
    const beforeUrls = await snapshotIbyteimgUrls();

    // Drive the click sequence until the chooser fires (or we time out)
    const findStart = Date.now();
    let menuItemClicked = false;
    while (Date.now() - findStart < 30000) {
      if (chooserHandled) break;
      const openedMenu = await clickUploadButton();
      if (openedMenu) {
        for (let i = 0; i < 3 && !chooserHandled; i++) {
          await new Promise((r) => setTimeout(r, 400));
        }
        if (chooserHandled) break;
        const clicked = await clickUploadImageMenuItem();
        menuItemClicked = menuItemClicked || clicked;
      }
      for (let i = 0; i < 4 && !chooserHandled; i++) {
        await new Promise((r) => setTimeout(r, 750));
      }
    }

    if (!chooserHandled) {
      await Page.setInterceptFileChooserDialog({ enabled: false }).catch(() => {});
      throw new Error(
        menuItemClicked
          ? 'Clicked "Upload image" but the file chooser never opened'
          : 'Could not find the image upload control on the TikTok Ads page'
      );
    }

    console.log(
      `[TikTok Ads Video] Image ${idx + 1}/${imagePaths.length} injected, waiting for upload...`
    );

    // Wait for this image's upload to complete (network capture preferred, DOM fallback)
    let displayUrl = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 90000) {
      if (storeUris.length > storeUrisBefore) {
        displayUrl = storeUriToDisplayUrl(storeUris[storeUris.length - 1]);
        break;
      }
      const nowUrls = await snapshotIbyteimgUrls();
      const fresh = nowUrls.find((u) => !beforeUrls.includes(u));
      if (fresh) {
        displayUrl = fresh;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!displayUrl) {
      await Page.setInterceptFileChooserDialog({ enabled: false }).catch(() => {});
      throw new Error(`Image ${idx + 1} upload did not complete in time`);
    }

    uploadedUrls.push(displayUrl);
    console.log(`[TikTok Ads Video] Image ${idx + 1} uploaded: ${displayUrl.substring(0, 100)}`);
  }

  await Page.setInterceptFileChooserDialog({ enabled: false }).catch(() => {});

  if (uploadedUrls.length === 0) {
    throw new Error('No images were uploaded');
  }
  return uploadedUrls;
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

/**
 * Picks the highest-resolution playable URL from a VideoInfos array.
 */
function pickBestVideoInfoUrl(videoInfos) {
  if (!Array.isArray(videoInfos)) return '';
  let bestUrl = '';
  let bestPixels = -1;
  for (const v of videoInfos) {
    const url = v?.MainUrl || v?.MainHTTPUrl || v?.BackupUrl || v?.BackupHTTPUrl || '';
    if (!url || !/^https?:\/\//.test(url)) continue;
    const w = parseInt(v?.VideoMeta?.Width, 10) || 0;
    const h = parseInt(v?.VideoMeta?.Height, 10) || 0;
    const pixels = w * h;
    if (pixels > bestPixels) {
      bestPixels = pixels;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/**
 * Inspects a check-task draft and reports its terminal state so the poller can
 * stop early instead of always waiting for the full timeout.
 *
 * @returns {{ url: string, failed: boolean, reason: string }}
 *   - url    : a playable rendered video URL (set => ready/success)
 *   - failed : true when the draft is in a terminal failure state
 *   - reason : human-readable failure reason (when failed)
 */
function inspectDraft(draft) {
  const out = { url: '', failed: false, reason: '' };
  if (!draft) return out;

  // `videoInfo` is sometimes returned as a JSON string instead of an object.
  let videoInfo = draft.videoInfo;
  if (typeof videoInfo === 'string') {
    try { videoInfo = JSON.parse(videoInfo); } catch (_) { videoInfo = null; }
  }

  // 1) Success: any playable URL wins, regardless of ambiguous status codes.
  let url = pickBestVideoInfoUrl(videoInfo?.VideoInfos);
  if (!url) {
    const orig = videoInfo?.OriginalVideoInfo;
    if (orig) {
      const u = orig.MainUrl || orig.MainHTTPUrl || orig.BackupUrl || orig.BackupHTTPUrl || '';
      if (u && /^https?:\/\//.test(u)) url = u;
    }
  }
  if (url) {
    out.url = url;
    return out;
  }

  // 2) Terminal failure: bail early so we don't wait out the whole timeout.
  //    TikTok reports a failed render with draftTaskStatus/renderTaskStatus = 3
  //    plus generateErrorCode/generateErrorMessage (e.g. "Input image empty
  //    error"). On success those status fields are 0 and a video URL is present.
  const explicitMsg =
    draft.generateErrorMessage || draft.generateErrorMsg ||
    draft.failReason || draft.failMsg || draft.errorMsg || draft.errMsg ||
    draft.fail_reason || draft.error_message || '';
  const errorCode = draft.generateErrorCode || draft.generate_error_code || '';
  const renderStatus = Number(draft.renderTaskStatus);
  const draftStatus = Number(draft.draftTaskStatus);
  const viMessage = String(videoInfo?.Message || '').trim();
  const viStatusRaw = videoInfo?.Status;

  // TikTok Cue task status 3 = failed (confirmed); negative values also fail.
  const FAILED_TASK_STATUS = 3;
  const hasExplicitFailure =
    !!(explicitMsg && String(explicitMsg).trim()) ||
    !!(errorCode && String(errorCode).trim() && String(errorCode).trim() !== '0');
  const hasFailedStatus =
    (Number.isFinite(renderStatus) && (renderStatus === FAILED_TASK_STATUS || renderStatus < 0)) ||
    (Number.isFinite(draftStatus) && (draftStatus === FAILED_TASK_STATUS || draftStatus < 0));
  // videoInfo present (render finished) but no playable URL and a non-success
  // message => the render produced an error.
  const hasFailedVideoInfo =
    videoInfo &&
    viStatusRaw !== undefined &&
    viMessage &&
    !/success/i.test(viMessage);

  if (hasExplicitFailure || hasFailedStatus || hasFailedVideoInfo) {
    out.failed = true;
    const reasonMsg = (explicitMsg && String(explicitMsg).trim()) || viMessage || '';
    out.reason =
      reasonMsg
        ? errorCode
          ? `${reasonMsg} (code ${String(errorCode).trim()})`
          : reasonMsg
        : `render status ${renderStatus}, draft status ${draftStatus}`;
  }
  return out;
}

// Backwards-compatible helper.
function extractVideoUrl(draft) {
  try {
    return inspectDraft(draft).url;
  } catch (_) {}
  return '';
}

// ─── Public Entry Point ─────────────────────────────────────────────────────

/**
 * TikTok Ads Video (Browser) node.
 *
 * @param {string} prompt     The final prompt text
 * @param {number|string} duration  Video duration in seconds
 * @param {string} mode       "reference" (Reference to Video), "image" (Image to Video)
 *        or "text" (Text to Video)
 * @param {string} profileId  Connected TikTok Ads profile id
 * @param {string|null} workflowId  Workflow id (for stop support)
 * @param {string|string[]|null} attachmentImagePath  Optional local image(s) to use as
 *        reference. Reference mode supports multiple images; Image mode uses the first only.
 * @returns {{ success: boolean, value: string }}
 */
async function tiktokAdsVideo(prompt, duration, mode, profileId, workflowId, attachmentImagePath) {
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
    // Chrome user-data-dir, so running them concurrently makes them collide.
    // Different profiles still run in parallel.
    return await runWithProfileLock(profileId, () =>
      _runTikTokAdsVideo(prompt, duration, mode, profileId, workflowId, attachmentImagePath)
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

async function _runTikTokAdsVideo(prompt, duration, mode, profileId, workflowId, attachmentImagePath) {
  // The node may have been stopped while queued behind another generation.
  if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
    return { success: false, value: 'Workflow was stopped' };
  }

  const videoMode =
    mode === 'image' ? 'image' : mode === 'text' ? 'text' : 'reference';
  const studioUrl =
    videoMode === 'image'
      ? STUDIO_URL_I2V
      : videoMode === 'text'
        ? STUDIO_URL_T2V
        : STUDIO_URL;
  const videoDuration = parseInt(duration, 10) > 0 ? parseInt(duration, 10) : 12;

  // Normalize attachment(s) to an array of existing local image paths.
  let attachmentImagePaths = Array.isArray(attachmentImagePath)
    ? attachmentImagePath
    : attachmentImagePath
      ? [attachmentImagePath]
      : [];
  attachmentImagePaths = attachmentImagePaths.filter(
    (p) => p && typeof p === 'string' && fs.existsSync(p)
  );
  // Image (image-to-video) mode only accepts a single image
  if (videoMode === 'image' && attachmentImagePaths.length > 1) {
    attachmentImagePaths = [attachmentImagePaths[0]];
  }
  // Text to Video mode does not use any image
  if (videoMode === 'text') {
    attachmentImagePaths = [];
  }

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

    console.log(`[TikTok Ads Video] Generating with profile ${profileId}, mode ${videoMode}, duration ${videoDuration}s`);
    console.log(`[TikTok Ads Video] Prompt: ${prompt.substring(0, 100)}`);

    // 1. Launch the logged-in profile browser at the Reference-to-Video page
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
      studioUrl,
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

    // 1b. Optionally upload reference image(s) (image-to-video / reference-to-video)
    let uploadedImageUrls = [];
    if (attachmentImagePaths.length > 0) {
      console.log(
        `[TikTok Ads Video] Uploading ${attachmentImagePaths.length} attachment image(s)`
      );
      try {
        uploadedImageUrls = await uploadAttachmentImages(client, attachmentImagePaths);
      } catch (uploadErr) {
        return { success: false, value: `Failed to upload attachment image: ${uploadErr.message}` };
      }
    }
    const primaryImageUrl = uploadedImageUrls[0] || null;

    // 2. Submit the video generation request (endpoint + body differ per mode)
    let submitEndpoint;
    let requestBody;

    if (videoMode === 'text') {
      // Text to Video — create_generate_task, gokuModel/model 5000003. No image.
      const textSettings = {
        aiModel: T2V_MODEL,
        duration: videoDuration,
        prompt,
        useEnhancePrompt: false,
        useReferencePrompt: false,
      };

      requestBody = {
        prompt,
        gokuModel: T2V_MODEL,
        model: T2V_MODEL,
        duration: videoDuration,
        settings: JSON.stringify(textSettings),
      };
      submitEndpoint =
        'https://ads.tiktok.com/creative_bff_i18n/api/cue/t2v/create_generate_task?aid=585599&app_name=creative_aio_client&device_platform=web';
    } else if (videoMode === 'image') {
      // Image to Video (Image/Text to Video) — create_generate_task, model 4000003.
      // With an image: animate it. Without an image: text-to-video.
      const imageSettings = primaryImageUrl
        ? {
            rawImage: primaryImageUrl,
            image: primaryImageUrl,
            images: [
              {
                id: crypto.randomUUID(),
                name: path.basename(attachmentImagePaths[0]),
                previewUrl: primaryImageUrl,
                fileType: 'image',
              },
            ],
            aiModel: I2V_MODEL,
            animationType: 'prompt',
            duration: videoDuration,
            isBgGenerated: false,
            prompt,
          }
        : {
            rawImage: '',
            image: '',
            images: [],
            aiModel: I2V_MODEL,
            animationType: 'prompt',
            duration: videoDuration,
            isBgGenerated: false,
            prompt,
          };

      requestBody = {
        image: primaryImageUrl || '',
        images: primaryImageUrl ? [primaryImageUrl] : [],
        prompt,
        duration: videoDuration,
        model: I2V_MODEL,
        settings: JSON.stringify(imageSettings),
      };
      submitEndpoint =
        'https://ads.tiktok.com/creative_bff_i18n/api/cue/i2v/create_generate_task?aid=585599&app_name=creative_aio_client&device_platform=web';
    } else {
      // Reference to Video — gen_r2v_video, model 2000003. Supports multiple images.
      const settingsImages = uploadedImageUrls.map((u, i) => ({
        id: crypto.randomUUID(),
        name: path.basename(attachmentImagePaths[i] || `image_${i + 1}`),
        previewUrl: u,
        fileType: 'image',
      }));

      const settingsObj = {
        images: settingsImages,
        prompt,
        aiModel: R2V_MODEL,
        duration: videoDuration,
      };

      requestBody = {
        image: '',
        images: uploadedImageUrls,
        prompt,
        duration: videoDuration,
        model: R2V_MODEL,
        settings: JSON.stringify(settingsObj),
        mentions: uploadedImageUrls.map((u) => ({ type: 1, id: u })),
      };
      submitEndpoint =
        'https://ads.tiktok.com/creative_bff_i18n/api/cue/i2v/gen_r2v_video?aid=585599&app_name=creative_aio_client&device_platform=web';
    }

    const submitResp = await inPageJsonFetch(Runtime, submitEndpoint, requestBody);

    if (!submitResp.ok) {
      return { success: false, value: `Failed to submit generation request: ${submitResp.error}` };
    }
    const submitJson = submitResp.json;
    const submittedTaskId = submitJson?.data?.task_id || submitJson?.data?.taskId || null;
    if (!submitJson || submitJson.code !== 0 || !submittedTaskId) {
      const msg = submitJson?.msg || submitJson?.message || `HTTP ${submitResp.status}`;
      if (/login|auth|session|cookie|csrf/i.test(String(msg))) {
        await markProfileExpired(profileId);
      }
      return { success: false, value: `TikTok Ads rejected the request: ${msg}` };
    }

    const taskId = submittedTaskId;
    console.log(`[TikTok Ads Video] Task ${taskId} created`);

    // 3. Poll until the video is rendered
    const startTime = Date.now();
    let videoUrl = '';

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

      let failureReason = '';
      for (const draft of drafts) {
        const state = inspectDraft(draft);
        if (state.url) { videoUrl = state.url; break; }
        if (state.failed && !failureReason) failureReason = state.reason;
      }
      if (videoUrl) break;

      // Stop early if TikTok reported the render terminally failed instead of
      // waiting out the whole timeout window.
      if (failureReason) {
        console.error(`[TikTok Ads Video] Render failed: ${failureReason}`);
        return { success: false, value: `TikTok Ads failed to render the video: ${failureReason}` };
      }

      console.log('[TikTok Ads Video] Waiting for render...');
    }

    if (!videoUrl) {
      return { success: false, value: 'Timed out waiting for TikTok Ads to render the video' };
    }

    console.log(`[TikTok Ads Video] Video ready, downloading: ${videoUrl.substring(0, 100)}`);

    // 4. Download the rendered MP4 (signed TikTok CDN URL is public)
    if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
      return { success: false, value: 'Workflow was stopped' };
    }

    const resp = await fetch(videoUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Referer': 'https://ads.tiktok.com/',
      },
      timeout: 120000,
    });
    if (!resp.ok) {
      return { success: false, value: `Failed to download generated video (HTTP ${resp.status})` };
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const tempFilename = `tiktokads_vid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`;
    const tempPath = path.join(TEMP_DIR, tempFilename);
    fs.writeFileSync(tempPath, buffer);

    const moveResult = await moveToPermStorage(tempPath, {
      cleanAI: false,
      injectMetadata: null,
      nodeType: 'tiktokadsvideo',
      workflowId,
    });

    const finalPath = moveResult.success ? moveResult.permanentPath : tempPath;
    console.log(`[TikTok Ads Video] Generated video: ${finalPath}`);
    return { success: true, value: finalPath };
  } catch (error) {
    console.error('[TikTok Ads Video] Error:', error);
    return { success: false, value: error.message || 'Unknown error during TikTok Ads video generation' };
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
  tiktokAdsVideo,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
};
