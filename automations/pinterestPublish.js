const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const { startVCBrowser, isVCBrowserInstalled } = require("../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../lib/cdpFingerprint");
const { readKey, findCleanProxy } = require("../lib/utils");

const MODULE = "[PinterestPublish]";

/**
 * Resolve the VCBrowser profile ID, proxy, and fingerprint from a Pinterest account.
 * @param {string} accountId
 * @returns {Promise<{profileId: string, proxy: object|null, fingerprint: object}>}
 */
async function resolveProfile(accountId) {
  const pinterestAccounts = (await readKey("pinterestAccounts")) || {};
  const account = pinterestAccounts[accountId];
  if (!account) {
    throw new Error(`Pinterest account ${accountId} not found`);
  }

  if (!account.linkedStructureId || !account.linkedProfileId) {
    throw new Error(`Pinterest account ${accountId} has no linked VCBrowser profile`);
  }

  const structures = (await readKey("structures")) || {};
  const structure = structures[account.linkedStructureId];
  if (!structure || !structure.profiles || !structure.profiles[account.linkedProfileId]) {
    throw new Error(`Linked VCBrowser profile not found for account ${accountId}`);
  }

  const profile = structure.profiles[account.linkedProfileId];
  const profileId = account.linkedProfileId;

  // Resolve proxy
  let proxy = null;
  if (profile.proxy && profile.proxy.ip && profile.proxy.ip !== "NULL") {
    proxy = profile.proxy;
  }

  // Resolve fingerprint
  let fingerprint = profile.fingerprint;
  if (!fingerprint || Object.keys(fingerprint).length === 0) {
    fingerprint = getConsistentFingerprintForProfile(profileId);
  }

  // Update Chrome version to match VCBrowser
  try {
    const vcVersion = getVCBrowserVersion();
    if (fingerprint.userAgent && vcVersion?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
    }
  } catch (e) { /* ignore */ }

  // Return saved cookies so they can be injected via CDP after launch
  const cookies = profile.cookies || [];

  return { profileId, proxy, fingerprint, cookies };
}

/**
 * Auto-publish pins to Pinterest by uploading a CSV file via the bulk-create page.
 * Uses VCBrowser headless to open the Pinterest profile, navigate to the bulk
 * create page, and upload the provided CSV content.
 *
 * @param {string} accountId - Pinterest account ID (key in pinterestAccounts storage)
 * @param {string} csvContent - Full CSV string (same format as the manual CSV export)
 * @param {function} [onProxyProgress] - Optional callback for proxy check progress updates
 * @returns {Promise<{success: boolean, value: string}>}
 */
// Helper: write CSV content to a unique temp file and return its path.
function writeCsvTempFile(accountId, csvContent) {
  const tmpDir = path.join(app.getPath("userData"), "Temp");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  // Include accountId + random suffix to guarantee uniqueness across concurrent publishes.
  // Date.now() alone can collide when multiple workflows start within the same millisecond,
  // causing one workflow to overwrite another's CSV file and publish the wrong pins.
  const rnd = Math.random().toString(36).slice(2, 8);
  const csvPath = path.join(tmpDir, `pinterest-autopublish-${accountId}-${Date.now()}-${rnd}.csv`);
  fs.writeFileSync(csvPath, csvContent, "utf8");
  return csvPath;
}

/**
 * Open a single VCBrowser session for a Pinterest account using ONE clean proxy IP.
 * The returned session (browser + proxy) can be reused to upload multiple CSV files
 * so the whole account stays on the SAME IP/session. Pinterest flags an account that
 * suddenly uploads from several different rotating IPs in quick succession, so when a
 * CSV is split into multiple files they MUST all go through this one shared session.
 *
 * @returns {Promise<{client, chromeProcess, error}>}
 */
async function openPinterestSession(accountId, onProxyProgress) {
  // Resolve VCBrowser profile from the Pinterest account
  const { profileId, proxy, fingerprint, cookies } = await resolveProfile(accountId);

  console.log(`${MODULE} Opening session for account ${accountId}, profile: ${profileId}`);

  // If proxy is configured, check for clean IP via IPRegistry — ONCE per session so
  // every CSV batch uploaded on this session uses the exact same IP.
  let activeProxy = proxy;
  if (proxy) {
    const ipregistrySettings = (await readKey("ipregistrySettings")) || {};
    if (ipregistrySettings.enabled && ipregistrySettings.apiKey) {
      console.log(`${MODULE} IPRegistry enabled, checking for clean proxy IP...`);
      const cleanResult = await findCleanProxy(
        proxy,
        ipregistrySettings.apiKey,
        20,
        (attempt, max, currentProxy, checkResult) => {
          console.log(`${MODULE} Proxy check attempt ${attempt}/${max}: IP=${checkResult.ip}, clean=${checkResult.clean}`);
          if (onProxyProgress) {
            onProxyProgress({
              attempt,
              maxAttempts: max,
              ip: checkResult.ip,
              clean: checkResult.clean,
              flaggedReasons: checkResult.flaggedReasons || [],
              error: checkResult.error,
              location: checkResult.location,
            });
          }
        },
      );

      if (cleanResult.skipped) {
        console.log(`${MODULE} IPRegistry check skipped`);
      } else if (cleanResult.success) {
        console.log(`${MODULE} Clean proxy found: ${cleanResult.finalIp}`);
        activeProxy = cleanResult.proxyData;
      } else {
        // 551 geo-targeting error
        if (cleanResult.error && cleanResult.error.includes("551")) {
          return { error: "Proxy geo-targeting error (551): The proxy geo settings are not available. Please change the geo parameters in your proxy configuration." };
        }
        return { error: `Could not find a clean proxy IP after ${cleanResult.attempts || 10} attempts. Flagged reasons: ${(cleanResult.flaggedReasons || []).join(", ") || "unknown"}` };
      }
    }
  }

  // Start at about:blank so the page is idle before we inject cookies.
  // If we launch directly to pinterest.com, the page loads BEFORE cookie injection
  // runs (CDP connection takes ~2-5s), so Pinterest always sees an unauthenticated
  // request and serves the public homepage — cookies injected afterwards have no effect
  // on the already-loaded page.
  const result = await startVCBrowser(
    profileId,
    fingerprint,
    "about:blank",
    activeProxy,
    true,   // headless
    true    // automationMode
  );

  if (!result || !result.client) {
    return { error: "Failed to start VCBrowser" };
  }

  const client = result.client;
  const chromeProcess = result.chromeProcess;
  const { Network } = client;

  console.log(`${MODULE} VCBrowser connected on port: ${result.debuggingPort}`);

  // Inject stored cookies BEFORE navigating to Pinterest.
  // This mirrors what "Open Pinterest" (start-structure-profile) does.
  // Cookies live in ViralCloner storage, not in the Chrome profile folder on disk.
  if (cookies && cookies.length > 0) {
    try {
      await Network.enable();
      for (const cookie of cookies) {
        const cdpCookie = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || "/",
          secure: cookie.secure || false,
          httpOnly: cookie.httpOnly || false,
          sameSite:
            cookie.sameSite === "no_restriction" ? "None" :
            cookie.sameSite === "lax" ? "Lax" :
            cookie.sameSite === "strict" ? "Strict" : undefined,
        };
        if (cookie.expires) cdpCookie.expires = cookie.expires;
        try { await Network.setCookie(cdpCookie); } catch (e) { /* ignore individual failures */ }
      }
      console.log(`${MODULE} Injected ${cookies.length} stored cookies for profile ${profileId}`);
    } catch (e) {
      console.warn(`${MODULE} Cookie injection failed (will try with on-disk session):`, e.message);
    }
  } else {
    console.log(`${MODULE} No stored cookies found for profile ${profileId} — relying on on-disk session`);
  }

  return { client, chromeProcess, error: null };
}

/**
 * Close a session opened by openPinterestSession.
 */
async function closePinterestSession(session) {
  if (!session) return;
  if (session.client) {
    try { await session.client.close(); } catch (e) { /* ignore */ }
  }
  if (session.chromeProcess) {
    try { session.chromeProcess.kill(); } catch (e) { /* ignore */ }
  }
}

/**
 * Upload a single CSV file to the Pinterest bulk-create page on an ALREADY-OPEN session.
 * Navigates to the bulk-create page fresh each call (so multiple uploads work back-to-back
 * within one session), verifies the account is logged in, uploads the CSV and clicks publish.
 * The caller owns the session and temp file lifecycle.
 *
 * @returns {Promise<{success: boolean, value: string}>}
 */
async function uploadCsvOnBulkPage(client, csvPath, csvContent) {
  try {
    const { Page, Runtime, DOM } = client;

    const isLoginPage = (u) => u.includes("/login") || u.includes("accounts.pinterest.com");

    // Now navigate to the bulk-create page. Cookies are already set so Pinterest
    // will receive them on this first request and serve the authenticated page.
    console.log(`${MODULE} Cookies injected, navigating to bulk-create-pins...`);
    await Page.navigate({ url: "https://www.pinterest.com/settings/bulk-create-pins/" });
    await new Promise((r) => setTimeout(r, 8000));

    // Check where we landed
    const settingsUrlResult = await Runtime.evaluate({
      expression: "window.location.href",
      returnByValue: true,
    });
    const settingsUrl = settingsUrlResult.result?.value || "";
    console.log(`${MODULE} Landed on: ${settingsUrl}`);

    if (isLoginPage(settingsUrl)) {
      return { success: false, value: "Pinterest account is not logged in on this machine. Please open the VCBrowser profile and log in to Pinterest manually first." };
    }

    // If we ended up on the public homepage the session is invalid
    const isPublicMarketingPage = (u) => /^https?:\/\/(www\.)?pinterest\.[^/]+(\/)?$/.test(u);
    if (isPublicMarketingPage(settingsUrl)) {
      return { success: false, value: "Pinterest account is not logged in on this machine. Please open the VCBrowser profile and log in to Pinterest manually first." };
    }

    // Dismiss any cookie consent / dialog overlays
    await Runtime.evaluate({
      expression: `
        (() => {
          const dismissSelectors = [
            '[data-test-id="gdpr-cookie-accept"]',
            'button[id*="cookie"]',
            'button[class*="cookie"]',
            '[aria-label="Close"]',
            '[data-test-id="closeup-close-button"]',
          ];
          for (const sel of dismissSelectors) {
            const btn = document.querySelector(sel);
            if (btn) { try { btn.click(); } catch(e) {} }
          }
        })()
      `,
      returnByValue: true,
    }).catch(() => {});

    // Wait for the bulk create page to fully load
    await new Promise((r) => setTimeout(r, 4000));

    /**
     * Helper: find a CSV file input using multiple strategies.
     * Returns the selector string if found, or null.
     */
    const findCsvInput = async () => {
      const result = await Runtime.evaluate({
        expression: `
          (() => {
            // Named/attributed selectors
            const selectors = [
              'input[data-test-id="csv-input"]',
              'input#csv-input',
              'input[accept=".csv"]',
              'input[accept=".csv,text/csv"]',
              'input[accept="text/csv"]',
              'input[type="file"][accept*="csv"]',
              'input[type="file"]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) return sel;
            }
            return null;
          })()
        `,
        returnByValue: true,
      });
      return result.result?.value || null;
    };

    /**
     * Helper: try to click an "Upload CSV" trigger button if the file input
     * is not yet in the DOM (Pinterest may hide it behind a button).
     */
    const clickUploadTrigger = async () => {
      await Runtime.evaluate({
        expression: `
          (() => {
            const triggerSelectors = [
              '[data-test-id="upload-csv-button"]',
              '[data-test-id="csv-upload-button"]',
              '[data-test-id="bulk-create-upload"]',
              'button[aria-label*="CSV"]',
              'button[aria-label*="csv"]',
              'a[href*="bulk-create"]',
            ];
            for (const sel of triggerSelectors) {
              const btn = document.querySelector(sel);
              if (btn) { try { btn.click(); } catch(e) {} return; }
            }
            // Broader: any button/link whose text mentions CSV or Upload
            const all = [...document.querySelectorAll('button, a[role="button"], [role="button"]')];
            for (const el of all) {
              const txt = (el.textContent || el.innerText || "").toLowerCase();
              if (txt.includes("csv") || txt.includes("upload") || txt.includes("bulk")) {
                try { el.click(); } catch(e) {}
                return;
              }
            }
          })()
        `,
        returnByValue: true,
      }).catch(() => {});
    };

    // First attempt: look for the CSV input
    let csvSelector = await findCsvInput();

    if (!csvSelector) {
      console.log(`${MODULE} CSV input not found, trying to click upload trigger...`);
      await clickUploadTrigger();
      await new Promise((r) => setTimeout(r, 3000));
      csvSelector = await findCsvInput();
    }

    if (!csvSelector) {
      // Navigate directly and retry
      console.log(`${MODULE} Retrying via direct navigation to bulk-create-pins...`);
      await Page.navigate({ url: "https://www.pinterest.com/settings/bulk-create-pins/" });
      await new Promise((r) => setTimeout(r, 8000));

      // Dismiss dialogs again after navigation
      await Runtime.evaluate({
        expression: `
          (() => {
            const dismissSelectors = [
              '[data-test-id="gdpr-cookie-accept"]',
              'button[id*="cookie"]',
              '[aria-label="Close"]',
            ];
            for (const sel of dismissSelectors) {
              const btn = document.querySelector(sel);
              if (btn) { try { btn.click(); } catch(e) {} }
            }
          })()
        `,
        returnByValue: true,
      }).catch(() => {});

      await new Promise((r) => setTimeout(r, 2000));
      csvSelector = await findCsvInput();

      if (!csvSelector) {
        await clickUploadTrigger();
        await new Promise((r) => setTimeout(r, 3000));
        csvSelector = await findCsvInput();
      }

      if (!csvSelector) {
        // Log the current URL and page title to help diagnose
        const diagResult = await Runtime.evaluate({
          expression: `JSON.stringify({ url: window.location.href, title: document.title, bodySnippet: document.body?.innerText?.slice(0, 300) || "" })`,
          returnByValue: true,
        }).catch(() => ({ result: { value: "{}" } }));
        let diagInfo = "";
        try { diagInfo = JSON.parse(diagResult.result?.value || "{}"); } catch(e) {}
        console.error(`${MODULE} Diagnostic - URL: ${diagInfo.url}, Title: ${diagInfo.title}`);
        console.error(`${MODULE} Diagnostic - Body snippet: ${diagInfo.bodySnippet}`);
        return { success: false, value: "Could not find CSV upload form on Pinterest bulk create page" };
      }
    }

    console.log(`${MODULE} Bulk create page loaded (selector: ${csvSelector}), uploading CSV...`);

    // Find the file input node via DOM
    const doc = await DOM.getDocument();
    let fileInputNode = null;

    for (const sel of [
      csvSelector,
      'input[data-test-id="csv-input"]',
      'input#csv-input',
      'input[accept=".csv"]',
      'input[accept=".csv,text/csv"]',
      'input[accept="text/csv"]',
      'input[type="file"][accept*="csv"]',
      'input[type="file"]',
    ]) {
      try {
        const node = await DOM.querySelector({ nodeId: doc.root.nodeId, selector: sel });
        if (node && node.nodeId) {
          fileInputNode = node;
          console.log(`${MODULE} File input found via selector: ${sel}`);
          break;
        }
      } catch (e) { /* try next */ }
    }

    if (!fileInputNode || !fileInputNode.nodeId) {
      return { success: false, value: "Could not find CSV file input on Pinterest page" };
    }

    // Upload the CSV file via CDP
    await DOM.setFileInputFiles({
      nodeId: fileInputNode.nodeId,
      files: [csvPath],
    });

    console.log(`${MODULE} CSV file uploaded, waiting for Pinterest to process...`);

    // Wait for Pinterest to process the uploaded CSV
    await new Promise((r) => setTimeout(r, 8000));

    // Check if upload was successful by looking for success indicators
    const uploadResult = await Runtime.evaluate({
      expression: `
        (() => {
          // Look for error messages
          const errors = document.querySelectorAll('[data-test-id="csv-error"]');
          for (const el of errors) {
            const text = el.textContent.trim();
            if (text && text.length > 0 && text.length < 500) {
              return { success: false, error: text };
            }
          }

          // Look for success indicators - pins created/preview
          const pinPreviews = document.querySelectorAll('[data-test-id="pin-draft-row"], [data-test-id="bulk-pin-item"], [data-test-id="pin-preview"]');
          if (pinPreviews.length > 0) {
            return { success: true, count: pinPreviews.length };
          }

          // Check for the publish/submit button appearing (means CSV was accepted)
          const publishBtn = document.querySelector('[data-test-id="bulk-create-submit"], button[data-test-id="publish-button"]');
          if (publishBtn) {
            return { success: true, hasPublishButton: true };
          }

          // Check for any table/list of pins
          const pinRows = document.querySelectorAll('tr, [role="row"]');
          if (pinRows.length > 1) {
            return { success: true, rows: pinRows.length };
          }

          return { success: null, message: "Upload processing - CSV accepted" };
        })()
      `,
      returnByValue: true,
    });

    const uploadStatus = uploadResult.result?.value;

    if (uploadStatus?.success === false) {
      return { success: false, value: `Pinterest CSV upload error: ${uploadStatus.error}` };
    }

    // Try to click the publish/submit button if it exists
    const clickResult = await Runtime.evaluate({
      expression: `
        (() => {
          // Look for publish/submit button
          const selectors = [
            '[data-test-id="bulk-create-submit"]',
            '[data-test-id="publish-button"]',
            'button[aria-label="Publish"]',
            'button[aria-label="Submit"]',
          ];
          for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled) {
              btn.click();
              return { clicked: true, selector: sel };
            }
          }
          return { clicked: false };
        })()
      `,
      returnByValue: true,
    });

    if (clickResult.result?.value?.clicked) {
      console.log(`${MODULE} Clicked publish button: ${clickResult.result.value.selector}`);
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      console.log(`${MODULE} No publish button found yet - CSV uploaded and queued`);
    }

    const pinCount = uploadStatus?.count || uploadStatus?.rows || Math.max(0, csvContent.trim().split("\n").length - 1);
    console.log(`${MODULE} Auto-publish completed successfully (${pinCount} pins)`);
    return { success: true, value: `CSV uploaded successfully with ${pinCount} pins` };

  } catch (error) {
    console.error(`${MODULE} Error:`, error.message);
    return { success: false, value: error.message };
  }
}

/**
 * Auto-publish a single CSV to Pinterest. Opens a session (one clean IP), uploads, closes.
 * @param {string} accountId
 * @param {string} csvContent
 * @param {function} [onProxyProgress]
 * @returns {Promise<{success: boolean, value: string}>}
 */
async function pinterestAutoPublish(accountId, csvContent, onProxyProgress) {
  if (!accountId) {
    return { success: false, value: "No Pinterest account ID provided" };
  }
  if (!csvContent || csvContent.trim().length === 0) {
    return { success: false, value: "No CSV content provided" };
  }
  if (!isVCBrowserInstalled()) {
    return { success: false, value: "VCBrowser is not installed. Please download it from Settings." };
  }

  let csvPath = null;
  let session = null;
  try {
    session = await openPinterestSession(accountId, onProxyProgress);
    if (session.error) {
      return { success: false, value: session.error };
    }
    csvPath = writeCsvTempFile(accountId, csvContent);
    console.log(`${MODULE} CSV written to: ${csvPath}`);
    return await uploadCsvOnBulkPage(session.client, csvPath, csvContent);
  } catch (error) {
    console.error(`${MODULE} Error:`, error.message);
    return { success: false, value: error.message };
  } finally {
    // Clean up temp CSV file
    if (csvPath) {
      try { fs.unlinkSync(csvPath); } catch (e) { /* ignore */ }
    }
    await closePinterestSession(session);
  }
}

/**
 * Auto-publish MULTIPLE CSV batches for the SAME account within ONE browser session
 * and ONE clean proxy IP. When a large CSV is split into several files, every file MUST
 * be uploaded on the same session/IP — otherwise Pinterest sees the account uploading
 * from several different rotating IPs in quick succession and flags/bans it.
 *
 * @param {string} accountId
 * @param {string[]} csvContents - array of CSV strings, one per batch
 * @param {function} [onProxyProgress]
 * @param {function} [onBatchProgress] - called with { index, total } before each batch upload
 * @returns {Promise<{success: boolean, value: string, completedBatches: number}>}
 */
async function pinterestAutoPublishBatch(accountId, csvContents, onProxyProgress, onBatchProgress) {
  if (!accountId) {
    return { success: false, value: "No Pinterest account ID provided", completedBatches: 0 };
  }
  const batches = (csvContents || []).filter((c) => c && c.trim().length > 0);
  if (batches.length === 0) {
    return { success: false, value: "No CSV content provided", completedBatches: 0 };
  }
  if (!isVCBrowserInstalled()) {
    return { success: false, value: "VCBrowser is not installed. Please download it from Settings.", completedBatches: 0 };
  }

  let session = null;
  const csvPaths = [];
  try {
    // Open ONE session with ONE clean proxy IP for the whole account.
    session = await openPinterestSession(accountId, onProxyProgress);
    if (session.error) {
      return { success: false, value: session.error, completedBatches: 0 };
    }

    for (let i = 0; i < batches.length; i++) {
      if (onBatchProgress) {
        try { onBatchProgress({ index: i, total: batches.length }); } catch (e) { /* ignore */ }
      }
      const csvPath = writeCsvTempFile(accountId, batches[i]);
      csvPaths.push(csvPath);
      console.log(`${MODULE} Uploading batch ${i + 1}/${batches.length} on shared session: ${csvPath}`);

      const result = await uploadCsvOnBulkPage(session.client, csvPath, batches[i]);
      if (!result.success) {
        return {
          success: false,
          value: batches.length > 1
            ? `Batch ${i + 1}/${batches.length}: ${result.value || "Unknown error"}`
            : (result.value || "Unknown error"),
          completedBatches: i,
        };
      }
    }

    return {
      success: true,
      value: `Uploaded ${batches.length} CSV batch(es) on a single session`,
      completedBatches: batches.length,
    };
  } catch (error) {
    console.error(`${MODULE} Batch error:`, error.message);
    return { success: false, value: error.message, completedBatches: 0 };
  } finally {
    for (const p of csvPaths) {
      try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
    }
    await closePinterestSession(session);
  }
}

/**
 * Fetch scheduled pins for a Pinterest account using VCBrowser headless.
 * @param {string} accountId
 * @returns {Promise<{success: boolean, value: string|object}>}
 */
async function getScheduledPins(accountId) {
  let client = null;
  let chromeProcess = null;

  try {
    if (!accountId) {
      return { success: false, value: "No account ID provided" };
    }

    if (!isVCBrowserInstalled()) {
      return { success: false, value: "VCBrowser is not installed" };
    }

    const { profileId, proxy, fingerprint, cookies } = await resolveProfile(accountId);
    console.log(`${MODULE} Fetching scheduled pins for account ${accountId}, profile ${profileId}`);

    // If proxy is configured, check for clean IP via IPRegistry
    let activeProxy = proxy;
    if (proxy) {
      const ipregistrySettings = (await readKey("ipregistrySettings")) || {};
      if (ipregistrySettings.enabled && ipregistrySettings.apiKey) {
        console.log(`${MODULE} IPRegistry enabled, checking for clean proxy IP...`);
        const cleanResult = await findCleanProxy(
          proxy,
          ipregistrySettings.apiKey,
          20,
          (attempt, max, currentProxy, checkResult) => {
            console.log(`${MODULE} Proxy check attempt ${attempt}/${max}: IP=${checkResult.ip}, clean=${checkResult.clean}`);
          },
        );

        if (cleanResult.skipped) {
          console.log(`${MODULE} IPRegistry check skipped`);
        } else if (cleanResult.success) {
          console.log(`${MODULE} Clean proxy found: ${cleanResult.finalIp}`);
          activeProxy = cleanResult.proxyData;
        } else {
          if (cleanResult.error && cleanResult.error.includes("551")) {
            return { success: false, value: "Proxy geo-targeting error (551) - check proxy location settings" };
          }
          return { success: false, value: `Could not find a clean proxy IP after ${cleanResult.attempts} attempts` };
        }
      }
    }

    // Start at about:blank so cookies can be injected before the first Pinterest request
    const browser = await startVCBrowser(profileId, fingerprint, "about:blank", activeProxy, true, true);
    client = browser.client;
    chromeProcess = browser.process || browser.chromeProcess;

    if (!client) {
      return { success: false, value: "Failed to start browser" };
    }

    // Inject stored cookies via CDP BEFORE navigating (same as "Open Pinterest" does)
    if (cookies && cookies.length > 0) {
      try {
        await client.send("Network.enable");
        for (const cookie of cookies) {
          const cdpCookie = {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || "/",
            secure: cookie.secure || false,
            httpOnly: cookie.httpOnly || false,
            sameSite:
              cookie.sameSite === "no_restriction" ? "None" :
              cookie.sameSite === "lax" ? "Lax" :
              cookie.sameSite === "strict" ? "Strict" : undefined,
          };
          if (cookie.expires) cdpCookie.expires = cookie.expires;
          try { await client.send("Network.setCookie", cdpCookie); } catch (e) { /* ignore individual failures */ }
        }
        console.log(`${MODULE} Injected ${cookies.length} stored cookies for profile ${profileId}`);
      } catch (e) {
        console.warn(`${MODULE} Cookie injection failed (will try with on-disk session):`, e.message);
      }
    }

    // Enable Page events BEFORE navigating — loadEventFired can fire before
    // the listener is registered if Page.enable comes after Page.navigate.
    await client.send("Page.enable");

    // Now navigate to /me which redirects to the actual profile URL
    await client.send("Page.navigate", { url: "https://www.pinterest.com/me/" });

    // Wait for /me redirect to resolve to the actual profile URL
    await new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(); }
      }, 15000);
      client.on("Page.loadEventFired", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          setTimeout(resolve, 3000);
        }
      });
    });

    // Get the redirected profile URL to extract username
    const { result: urlResult } = await client.send("Runtime.evaluate", {
      expression: "window.location.href",
    });
    const profileUrl = urlResult.value || "";
    const usernameMatch = profileUrl.match(/pinterest\.com\/([^/?#]+)/);
    const username = usernameMatch ? usernameMatch[1] : "";
    console.log(`${MODULE} Redirected to profile: ${profileUrl} (username: ${username})`);

    if (!username || username === "me") {
      return { success: false, value: "Could not resolve Pinterest username - may not be logged in" };
    }

    // Fetch scheduled pins directly from page context — the browser handles all auth
    const sourceUrl = `/${username}/`;
    const dataParam = encodeURIComponent(JSON.stringify({ options: {}, context: {} }));

    const fetchResult = await client.send("Runtime.evaluate", {
      expression: `
        (async () => {
          try {
            const csrftoken = document.cookie.split('; ').find(r => r.startsWith('csrftoken='))?.split('=')[1] || '';
            const url = '/resource/ScheduledPinsResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${dataParam}&_=' + Date.now();
            const resp = await fetch(url, {
              credentials: 'include',
              headers: {
                'Accept': 'application/json, text/javascript, */*, q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRFToken': csrftoken,
                'X-Pinterest-AppState': 'active',
                'X-Pinterest-Source-Url': '${sourceUrl}',
                'X-Pinterest-PWS-Handler': 'www/[username].js',
                'X-APP-VERSION': document.querySelector('script[src*="vendors-"]')?.src?.match(/\\/([a-f0-9]{7})/)?.[1] || '494174b',
                'screen-dpr': '1'
              }
            });
            const text = await resp.text();
            return JSON.stringify({ status: resp.status, body: text });
          } catch (e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const fetchData = JSON.parse(fetchResult.result?.value || "{}");

    if (fetchData.error) {
      return { success: false, value: fetchData.error };
    }

    if (fetchData.status !== 200) {
      console.error(`${MODULE} ScheduledPinsResource returned status ${fetchData.status}: ${(fetchData.body || "").substring(0, 200)}`);
      return { success: false, value: `Pinterest returned status ${fetchData.status}` };
    }

    const responseJson = JSON.parse(fetchData.body);
    const pins = responseJson.resource_response?.data || [];
    const totalCount = pins[0]?.user?.scheduled_pin_count || pins.length;

    console.log(`${MODULE} Fetched ${pins.length} scheduled pins (total: ${totalCount})`);
    return { success: true, data: pins, totalCount };

  } catch (error) {
    console.error(`${MODULE} getScheduledPins error:`, error.message);
    return { success: false, value: error.message };
  } finally {
    if (client) {
      try { await client.close(); } catch (e) { /* ignore */ }
    }
    if (chromeProcess) {
      try { chromeProcess.kill(); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { pinterestAutoPublish, pinterestAutoPublishBatch, getScheduledPins };
