/**
 * Meta AI Image Generation Module
 *
 * Generates images using Meta AI via browser automation (VCBrowser + CDP).
 * Opens the connected Meta AI profile browser, navigates to meta.ai/create,
 * fills prompt / sets orientation / clicks send, then captures all
 * text/event-stream responses and writes them to the log file.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { app } = require('electron');


const { readKey, moveToPermStorage } = require('../lib/utils');
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('../lib/cdpFingerprint');

const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const PAGE_LOAD_TIMEOUT_MS = 30000;
const TEMP_DIR = path.join(app.getPath('userData'), 'Uploads', 'Temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const activeWorkflows = new Map();

async function waitForPageReady(Runtime, timeoutMs = PAGE_LOAD_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { result } = await Runtime.evaluate({
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (result.value === 'complete' || result.value === 'interactive') {
        await new Promise((r) => setTimeout(r, 3000));
        return;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn('[Meta AI Image] Page readyState timeout - proceeding anyway');
}

async function closeBrowser(browserResult) {
  if (!browserResult) return;

  try {
    if (browserResult.debuggingPort) {
      const WebSocket = require('ws');
      const debugUrl = `http://localhost:${browserResult.debuggingPort}/json/version`;
      const res = await fetch(debugUrl);
      const info = await res.json();
      const browserWsUrl = info.webSocketDebuggerUrl;

      if (browserWsUrl) {
        const ws = new WebSocket(browserWsUrl);
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
            setTimeout(() => {
              ws.close();
              resolve();
            }, 1000);
          });
          ws.on('error', reject);
          setTimeout(reject, 5000);
        });
        console.log('[Meta AI Image] Browser closed gracefully via CDP');
        return;
      }
    }
  } catch (closeErr) {
    console.warn('[Meta AI Image] Graceful close failed, using fallback:', closeErr.message);
  }

  try {
    if (browserResult.client) {
      await browserResult.client.close().catch(() => {});
    }
  } catch (_) {}
  try {
    if (browserResult.chromeProcess && !browserResult.chromeProcess.killed) {
      browserResult.chromeProcess.kill();
    }
  } catch (_) {}
}

async function metaaiImage(prompt, orientation, profileId, workflowId, attachmentImagePath) {
  if (!prompt) return { success: false, value: 'Prompt is required' };

  if (workflowId) {
    activeWorkflows.set(workflowId, { active: true });
  }

  let browserResult = null;

  try {
    const metaaiProfiles = (await readKey('metaaiProfiles')) || {};
    const profile = metaaiProfiles[profileId];

    if (!profile || profile.status !== 'connected') {
      return { success: false, value: `Meta AI profile "${profileId}" is not connected` };
    }

    if (!isVCBrowserInstalled()) {
      return { success: false, value: 'VCBrowser is not installed. Please download it from Settings.' };
    }

    console.log(`[Meta AI Image] Generating image with profile: ${profileId}`);
    console.log(`[Meta AI Image] Prompt: ${prompt.substring(0, 100)}...`);
    console.log(`[Meta AI Image] Orientation: ${orientation}`);

    // 1. Launch VCBrowser
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

    browserResult = await startVCBrowser(
      profileId,
      fingerprint,
      'https://www.meta.ai/create',
      null,
      false,
      true
    );

    if (!browserResult || !browserResult.client) {
      return { success: false, value: 'Failed to start VCBrowser or get CDP client' };
    }

    const client = browserResult.client;
    const { Runtime, Page, Network } = client;

    await Promise.all([
      Runtime.enable(),
      Page.enable(),
      Network.enable(),
    ]);

    // 2. Wait for page to load
    await waitForPageReady(Runtime);
    console.log('[Meta AI Image] Page loaded');

    function appendLog(msg) {}

    // 4. Set up CDP Network-level stream capture (protocol level — cannot be bypassed by page JS)
    //    Track text/event-stream responses and parse image URLs from the DONE event
    const streamRequestIds = new Set();
    let cdpImageUrls = [];
    let cdpStreamComplete = false;
    let cdpStreamChunks = 0;

    // Track event-stream responses by their requestId
    Network.responseReceived(({ requestId, response }) => {
      const ct = (response.headers['content-type'] || response.headers['Content-Type'] || '');
      if (ct.includes('text/event-stream')) {
        streamRequestIds.add(requestId);
        appendLog(`[CDP-STREAM] Detected event-stream response: requestId=${requestId} url=${response.url}`);
        console.log(`[Meta AI Image] CDP detected event-stream: ${response.url}`);
      }
    });

    // When an event-stream response finishes loading, get its full body and parse for images
    Network.loadingFinished(async ({ requestId }) => {
      if (!streamRequestIds.has(requestId)) return;
      try {
        const { body, base64Encoded } = await Network.getResponseBody({ requestId });
        const responseText = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
        appendLog(`[CDP-BODY] requestId=${requestId} length=${responseText.length}`);
        cdpStreamChunks++;

        // Parse SSE lines looking for the DONE event with images
        const lines = responseText.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const json = JSON.parse(line.substring(6));
              const msg = json?.data?.sendMessageStream;
              if (msg?.streamingState === 'DONE' && msg?.images?.length > 0) {
                cdpImageUrls = msg.images.map(img => img.url).filter(Boolean);
                appendLog(`[CDP-IMAGES] Found ${cdpImageUrls.length} image URLs from DONE event`);
                console.log(`[Meta AI Image] CDP found ${cdpImageUrls.length} image URLs`);
              }
            } catch (_) {}
          }
        }

        cdpStreamComplete = true;
      } catch (e) {
        appendLog(`[CDP-BODY-ERROR] requestId=${requestId} error=${e.message}`);
      }
    });

    // Also inject fetch interceptor as a fallback (in case CDP misses anything)
    await Runtime.evaluate({
      expression: `
        (() => {
          window.__metaStreams = [];
          window.__metaStreamsComplete = false;
          window.__metaImageUrls = [];
          const originalFetch = window.fetch;
          window.fetch = async function(...args) {
            const response = await originalFetch.apply(this, args);
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('text/event-stream')) {
              const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url || '';
              const cloned = response.clone();
              (async () => {
                try {
                  const reader = cloned.body.getReader();
                  const decoder = new TextDecoder();
                  let buffer = '';
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                      window.__metaStreams.push({ type: 'complete', url });
                      window.__metaStreamsComplete = true;
                      break;
                    }
                    const text = decoder.decode(value, { stream: true });
                    window.__metaStreams.push({ type: 'data', url, text });
                    buffer += text;
                    const lines = buffer.split('\\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                      if (line.startsWith('data: ')) {
                        try {
                          const json = JSON.parse(line.substring(6));
                          const msg = json?.data?.sendMessageStream;
                          if (msg?.streamingState === 'DONE' && msg?.images?.length > 0) {
                            window.__metaImageUrls = msg.images.map(img => img.url).filter(Boolean);
                          }
                        } catch (_) {}
                      }
                    }
                  }
                } catch (e) {
                  window.__metaStreams.push({ type: 'error', url, error: e.message });
                  window.__metaStreamsComplete = true;
                }
              })();
            }
            return response;
          };
        })()
      `,
      returnByValue: true,
    });

    appendLog('[INIT] CDP Network capture + fetch interceptor fallback ready');

    // 5. Wait for composer input
    console.log('[Meta AI Image] Waiting for composer...');

    const composerReady = await Runtime.evaluate({
      expression: `
        (async () => {
          for (let i = 0; i < 40; i++) {
            const editor = document.querySelector('[data-testid="composer-input"][contenteditable="true"]');
            if (editor) return { found: true };
            await new Promise(r => setTimeout(r, 500));
          }
          const anyEditable = document.querySelector('[contenteditable="true"]');
          if (anyEditable) return { found: true, fallback: true };
          return { found: false };
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    if (!composerReady.result?.value?.found) {
      return { success: false, value: 'Could not find Meta AI composer input' };
    }

    console.log('[Meta AI Image] Composer found, filling prompt...');

    // 6. Fill prompt
    const promptEscaped = prompt.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

    await Runtime.evaluate({
      expression: `
        (async () => {
          const editor = document.querySelector('[data-testid="composer-input"][contenteditable="true"]')
                      || document.querySelector('[contenteditable="true"]');
          if (!editor) return false;

          editor.focus();
          await new Promise(r => setTimeout(r, 200));

          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          sel.removeAllRanges();
          sel.addRange(range);

          document.execCommand('insertText', false, '${promptEscaped}');
          await new Promise(r => setTimeout(r, 500));
          return true;
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    console.log('[Meta AI Image] Prompt filled');

    // 7. Select orientation (default on Meta AI is 9:16 / VERTICAL)
    if (orientation && orientation !== 'VERTICAL') {
      const orientationMap = { 'VERTICAL': '9:16', 'HORIZONTAL': '16:9', 'SQUARE': '1:1' };
      const targetRatio = orientationMap[orientation];

      if (targetRatio) {
        await Runtime.evaluate({
          expression: `
            (async () => {
              const triggers = document.querySelectorAll('[data-slot="select-trigger"]');
              let aspectTrigger = null;
              for (const trigger of triggers) {
                const valueSpan = trigger.querySelector('[data-slot="select-value"]');
                const text = valueSpan?.textContent || '';
                if (text.match(/\\d+:\\d+/)) { aspectTrigger = trigger; break; }
              }
              if (!aspectTrigger) return false;
              aspectTrigger.click();
              await new Promise(r => setTimeout(r, 500));
              const options = document.querySelectorAll('[role="option"], [data-radix-collection-item]');
              for (const option of options) {
                if (option.textContent.includes('${targetRatio}')) {
                  option.click();
                  await new Promise(r => setTimeout(r, 300));
                  return true;
                }
              }
              document.body.click();
              return false;
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });
      }
    }

    // 8. Attach image if provided (via clipboard paste into composer)
    if (attachmentImagePath && fs.existsSync(attachmentImagePath)) {
      console.log(`[Meta AI Image] Attaching image via paste: ${attachmentImagePath}`);
      appendLog(`[ATTACH] ${attachmentImagePath}`);

      // Read image file as base64
      const imageBuffer = fs.readFileSync(attachmentImagePath);
      const base64Image = imageBuffer.toString('base64');
      const ext = path.extname(attachmentImagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

      // Paste image into the composer input via clipboard DataTransfer
      const pasteResult = await Runtime.evaluate({
        expression: `
          (async () => {
            try {
              const b64 = '${base64Image}';
              const byteChars = atob(b64);
              const byteArray = new Uint8Array(byteChars.length);
              for (let i = 0; i < byteChars.length; i++) {
                byteArray[i] = byteChars.charCodeAt(i);
              }
              const blob = new Blob([byteArray], { type: '${mimeType}' });
              const file = new File([blob], 'attachment${ext}', { type: '${mimeType}' });

              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(file);

              const composerInput = document.querySelector('[data-testid="composer-input"][contenteditable="true"]');
              if (!composerInput) return { ok: false, error: 'Composer input not found' };

              composerInput.focus();

              const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dataTransfer,
              });

              composerInput.dispatchEvent(pasteEvent);
              return { ok: true };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });

      const pasteInfo = pasteResult.result?.value;
      if (pasteInfo?.ok) {
        // Wait for the image to be processed/uploaded by Meta AI
        await new Promise((r) => setTimeout(r, 3000));
        console.log('[Meta AI Image] Image pasted successfully');
        appendLog('[ATTACH-OK]');
      } else {
        console.warn(`[Meta AI Image] Paste failed: ${pasteInfo?.error || 'unknown'}`);
        appendLog(`[ATTACH-FAIL] ${pasteInfo?.error || 'unknown'}`);
      }
    }

    // 9. Click send
    console.log('[Meta AI Image] Clicking send...');

    const sendClicked = await Runtime.evaluate({
      expression: `
        (async () => {
          for (let i = 0; i < 20; i++) {
            const sendBtn = document.querySelector('[data-testid="composer-send-button"]');
            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click();
              return true;
            }
            await new Promise(r => setTimeout(r, 300));
          }
          return false;
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    if (!sendClicked.result?.value) {
      return { success: false, value: 'Could not click send button (may be disabled - empty prompt?)' };
    }

    console.log('[Meta AI Image] Prompt sent, waiting for event-stream responses...');
    appendLog('[SENT] Prompt sent, waiting for event-stream data...');

    // 10. Wait for stream data from CDP Network events (primary) or fetch interceptor (fallback)
    const startTime = Date.now();
    let lastIndex = 0;

    while (Date.now() - startTime < IMAGE_TIMEOUT_MS) {
      if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
        return { success: false, value: 'Workflow was stopped' };
      }

      // Check CDP-level capture first (most reliable)
      if (cdpStreamComplete && cdpImageUrls.length > 0) {
        appendLog(`[CDP-DONE] Stream complete via CDP. ${cdpImageUrls.length} images found.`);
        console.log(`[Meta AI Image] CDP stream complete. ${cdpImageUrls.length} images.`);
        break;
      }

      // Also poll fetch interceptor fallback for logging
      const pollResult = await Runtime.evaluate({
        expression: `
          (() => {
            const streams = window.__metaStreams || [];
            const complete = window.__metaStreamsComplete || false;
            const imgUrls = window.__metaImageUrls || [];
            return { total: streams.length, complete, imgUrls, data: streams.slice(${lastIndex}) };
          })()
        `,
        returnByValue: true,
      });

      const poll = pollResult.result?.value;
      if (poll && poll.data && poll.data.length > 0) {
        for (const entry of poll.data) {
          if (entry.type === 'data') {
            appendLog(`[STREAM-DATA] url=${entry.url}`);
            appendLog(`[STREAM-CHUNK] ${entry.text}`);
          } else if (entry.type === 'complete') {
            appendLog(`[STREAM-COMPLETE] url=${entry.url}`);
          } else if (entry.type === 'error') {
            appendLog(`[STREAM-ERROR] url=${entry.url} error=${entry.error}`);
          }
        }
        lastIndex = poll.total;
        console.log(`[Meta AI Image] Stream data: ${poll.total} chunks so far, cdpComplete=${cdpStreamComplete}, fetchComplete=${poll.complete}`);
      }

      // If fetch interceptor completed and has image URLs (fallback)
      if (poll?.complete && poll?.imgUrls?.length > 0 && cdpImageUrls.length === 0) {
        cdpImageUrls = poll.imgUrls;
        appendLog(`[FALLBACK] Using fetch interceptor image URLs: ${cdpImageUrls.length}`);
        console.log(`[Meta AI Image] Using fetch interceptor fallback: ${cdpImageUrls.length} images`);
        break;
      }

      // If CDP has completed but no images found, check fetch interceptor too
      if (cdpStreamComplete && cdpImageUrls.length === 0 && poll?.imgUrls?.length > 0) {
        cdpImageUrls = poll.imgUrls;
        appendLog(`[FALLBACK] CDP had no images, fetch interceptor found: ${cdpImageUrls.length}`);
        break;
      }

      // Both completed with no images — keep waiting in case more streams come
      if (cdpStreamComplete && poll?.complete) {
        // Give it a few more seconds for any late-arriving streams
        await new Promise((r) => setTimeout(r, 3000));
        // Re-check CDP
        if (cdpImageUrls.length > 0) break;
        // Re-check fetch interceptor
        const recheck = await Runtime.evaluate({
          expression: `window.__metaImageUrls || []`,
          returnByValue: true,
        });
        if (recheck.result?.value?.length > 0) {
          cdpImageUrls = recheck.result.value;
          appendLog(`[LATE-FALLBACK] Found ${cdpImageUrls.length} images after extra wait`);
          break;
        }
        appendLog(`[DONE-NO-IMAGES] Both CDP and fetch interceptor completed with no images`);
        break;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (cdpImageUrls.length === 0 && lastIndex === 0 && !cdpStreamComplete) {
      appendLog('[TIMEOUT] No event-stream data received from either CDP or fetch interceptor');
      return { success: false, value: 'No event-stream data received (timeout)' };
    }

    appendLog(`\n=== SUMMARY ===`);
    appendLog(`CDP stream chunks: ${cdpStreamChunks}, Fetch interceptor chunks: ${lastIndex}`);

    // 11. Use the collected image URLs
    const imageUrls = cdpImageUrls;
    appendLog(`[IMAGES] Final: ${imageUrls.length} image URLs`);
    imageUrls.forEach((u, i) => appendLog(`[IMG-URL ${i}] ${u.substring(0, 180)}`));

    if (imageUrls.length === 0) {
      return { success: false, value: 'Stream completed but no image URLs found in response' };
    }

    console.log(`[Meta AI Image] Found ${imageUrls.length} image URLs, downloading via browser...`);

    // 12. Download images via in-browser fetch (fbcdn URLs require session cookies)
    const downloadedPaths = [];
    for (const url of imageUrls) {
      if (workflowId && activeWorkflows.get(workflowId)?.active === false) {
        return { success: false, value: 'Workflow was stopped' };
      }

      try {
        const b64Result = await Runtime.evaluate({
          expression: `
            (async () => {
              try {
                const resp = await fetch('${url.replace(/'/g, "\\'")}');
                if (!resp.ok) return { ok: false, status: resp.status };
                const blob = await resp.blob();
                return await new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve({ ok: true, data: reader.result });
                  reader.readAsDataURL(blob);
                });
              } catch (e) {
                return { ok: false, error: e.message };
              }
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });

        const b64Info = b64Result.result?.value;
        if (!b64Info?.ok || !b64Info?.data) {
          appendLog(`[DL-FAIL] ${JSON.stringify(b64Info)}`);
          continue;
        }

        const base64Data = b64Info.data.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        const tempFilename = `metaai_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
        const tempPath = path.join(TEMP_DIR, tempFilename);
        fs.writeFileSync(tempPath, buffer);

        const automationSettings = await readKey('automationSettings') || {};
        const cleanAI = automationSettings.aiImageCleaning !== false;
        const imageMetadataSettings = await readKey('imageMetadataSettings') || {};

        const moveResult = await moveToPermStorage(tempPath, {
          cleanAI,
          injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
          nodeType: 'metaaiimage',
          workflowId,
        });

        const finalPath = moveResult.success ? moveResult.permanentPath : tempPath;
        downloadedPaths.push(finalPath);
        appendLog(`[DOWNLOADED] ${finalPath}`);
        console.log(`[Meta AI Image] Downloaded: ${finalPath}`);
      } catch (dlErr) {
        appendLog(`[DL-ERROR] ${dlErr.message}`);
        console.warn(`[Meta AI Image] Failed to download: ${dlErr.message}`);
      }
    }

    if (downloadedPaths.length === 0) {
      return { success: false, value: 'Failed to download any generated images' };
    }

    console.log(`[Meta AI Image] Successfully generated ${downloadedPaths.length} image(s)`);
    return { success: true, value: downloadedPaths };
  } catch (error) {
    console.error(`[Meta AI Image] Error:`, error);
    return { success: false, value: error.message || 'Unknown error during Meta AI image generation' };
  } finally {
    // Browser close disabled for debugging
    // if (browserResult) {
    //   await closeBrowser(browserResult);
    //   console.log('[Meta AI Image] Browser closed');
    // }
    console.log('[Meta AI Image] Browser left open for debugging');
    if (workflowId) {
      activeWorkflows.delete(workflowId);
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
  metaaiImage,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
};
