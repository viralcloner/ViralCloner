/**
 * Pinterest Analytics Collector
 * Launches headless VCBrowser sessions per Pinterest account,
 * extracts cookies/UA via CDP, then fetches analytics from
 * Pinterest's internal API and stores in pinterest.db.
 */

const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { readKey, updateData } = require("./utils");
const { startVCBrowser, isVCBrowserInstalled } = require("./VCBrowserManager");
const {
  getConsistentFingerprintForProfile,
  getVCBrowserVersion,
} = require("./cdpFingerprint");
const { getPinterestAnalyticsDatabase } = require("./pinterestAnalytics");
const { app, BrowserWindow } = require("electron");

const METRIC_TYPES = ["IMPRESSION", "ENGAGEMENT", "PIN_CLICK", "OUTBOUND_CLICK", "SAVE"];
const ANALYTICS_BASE_URL = "https://analytics.pinterest.com/resource/ApiResource/get/";
const MODULE = "[PinterestAnalytics]";



function sendLogToRenderer(type, message) {
  try {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      wins[0].webContents.send("pinterest-collection-log", { type, message, timestamp: new Date().toISOString() });
    }
  } catch (e) { /* ignore */ }
}

function sendAccountProgressToRenderer(data) {
  try {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send("pinterest-account-progress", data)
    );
  } catch (e) { /* ignore */ }
}

function log(...args) {
  const timestamp = new Date().toISOString();
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(...args);
  sendLogToRenderer("info", message);
}

function logError(...args) {
  const timestamp = new Date().toISOString();
  const message = args.map((a) => (typeof a === "string" ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(" ");
  console.error(...args);
  sendLogToRenderer("error", message);
}

function logWarn(...args) {
  const timestamp = new Date().toISOString();
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.warn(...args);
  sendLogToRenderer("warn", message);
}

let isCollecting = false;
let collectionProgress = { current: 0, total: 0 };

// ============================================================
// MAIN ENTRY POINT
// ============================================================

async function collectPinterestAnalytics(force = false, selectedAccounts = null) {
  if (isCollecting) {
    log(`${MODULE} Collection already in progress, skipping`);
    return { success: false, error: "Collection already in progress" };
  }

  if (!isVCBrowserInstalled()) {
    log(`${MODULE} VCBrowser not installed, skipping collection`);
    return { success: false, error: "VCBrowser not installed" };
  }

  isCollecting = true;
  const db = getPinterestAnalyticsDatabase();
  const results = [];

  try {
    const pinterestAccounts = (await readKey("pinterestAccounts")) || {};
    const structures = (await readKey("structures")) || {};

    let linkedAccounts = Object.entries(pinterestAccounts).filter(
      ([, acct]) => acct.linkedStructureId && acct.linkedProfileId
    );

    // Filter to selected accounts if specified (manual collect with selection)
    if (selectedAccounts && selectedAccounts.length > 0) {
      linkedAccounts = linkedAccounts.filter(([id]) => selectedAccounts.includes(id));
    }

    if (linkedAccounts.length === 0) {
      log(`${MODULE} No linked Pinterest accounts found`);
      return { success: true, message: "No linked accounts", results: [] };
    }

    log(`${MODULE} Starting collection for ${linkedAccounts.length} account(s)`);
    collectionProgress = { current: 0, total: linkedAccounts.length };
    sendAccountProgressToRenderer({ status: "start", accounts: linkedAccounts.map(([id]) => id) });

    const MAX_RETRIES = 3;
    // Use configured interval for skip guard so we don't re-collect too early
    let skipHours = 12;
    try {
      const collSettings = await readKey("pinterestCollectionSettings");
      if (collSettings && collSettings.intervalHours) {
        skipHours = Math.max(6, collSettings.intervalHours * 0.8); // 80% of interval as safety margin
      }
    } catch (e) { /* use default */ }
    const SKIP_IF_WITHIN_MS = skipHours * 60 * 60 * 1000;

    for (const [accountId, account] of linkedAccounts) {
      // Skip accounts that were successfully collected recently (unless force/manual trigger)
      if (!force) {
        const lastSuccess = db.getLastSuccessfulFetch(accountId);
        if (lastSuccess) {
          const elapsed = Date.now() - new Date(lastSuccess.fetched_at).getTime();
          if (elapsed < SKIP_IF_WITHIN_MS) {
            const minsAgo = Math.round(elapsed / 60000);
            log(`${MODULE} Skipping ${accountId} — last success ${minsAgo}m ago`);
            sendAccountProgressToRenderer({ status: "skipped", accountId });
            results.push({ accountId, success: true, skipped: true });
            continue;
          }
        }
      }

      sendAccountProgressToRenderer({ status: "processing", accountId });

      let succeeded = false;
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt === 1) {
            log(`${MODULE} Processing account: ${accountId}`);
          } else {
            log(`${MODULE} Retrying account ${accountId} (attempt ${attempt}/${MAX_RETRIES})...`);
          }
          const result = await collectForAccount(accountId, account, structures, db);
          sendAccountProgressToRenderer({ status: "success", accountId, metricsSaved: result.metricsSaved, pinsSaved: result.pinsSaved });
          results.push({ accountId, ...result });
          succeeded = true;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RETRIES) {
            logWarn(`${MODULE} Attempt ${attempt}/${MAX_RETRIES} failed for ${accountId}: ${err.message}. Retrying in 5s...`);
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }

      if (!succeeded) {
        logError(`${MODULE} All ${MAX_RETRIES} attempts failed for account ${accountId}:`, lastError.message);
        db.logFetch(accountId, "all", "error", lastError.message);
        sendAccountProgressToRenderer({ status: "error", accountId, error: lastError.message });
        results.push({ accountId, success: false, error: lastError.message });
      }
      collectionProgress.current++;
    }

    log(`${MODULE} Collection complete. ${results.filter((r) => r.success).length}/${results.length} succeeded`);
    return { success: true, results };
  } catch (err) {
    logError(`${MODULE} Fatal collection error:`, err.message);
    return { success: false, error: err.message };
  } finally {
    isCollecting = false;
    collectionProgress = { current: 0, total: 0 };
  }
}

// ============================================================
// PER-ACCOUNT COLLECTION
// ============================================================

async function collectForAccount(accountId, account, structures, db) {
  const structure = structures[account.linkedStructureId];
  if (!structure || !structure.profiles || !structure.profiles[account.linkedProfileId]) {
    throw new Error("Linked profile not found in structures");
  }

  const profile = structure.profiles[account.linkedProfileId];
  const profileId = account.linkedProfileId;

  // Resolve proxy from profile
  const proxy = resolveProxy(profile);

  // Resolve fingerprint
  let fingerprint = profile.fingerprint;
  if (!fingerprint || Object.keys(fingerprint).length === 0) {
    fingerprint = getConsistentFingerprintForProfile(profileId);
  }

  // Update Chrome version in fingerprint to match VCBrowser
  try {
    const vcVersion = getVCBrowserVersion();
    if (fingerprint.userAgent && vcVersion?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
    }
  } catch (e) {
    // ignore
  }

  // Step 1: Launch headless browser, extract session data
  log(`${MODULE} [${accountId}] Launching headless browser (profile: ${profileId})`);
  const sessionData = await extractSessionData(profileId, fingerprint, proxy);

  // Step 2: Discover businessId if not cached
  let businessId = account.businessId;
  let ownedContentList = account.ownedContentList || ["other"];

  if (!businessId) {
    log(`${MODULE} [${accountId}] Discovering businessId from session data...`);
    const discovered = await discoverBusinessId(sessionData, proxy);
    businessId = discovered.businessId;
    ownedContentList = discovered.ownedContentList || ["other"];

    if (businessId) {
      // Cache on the account object
      const allAccounts = (await readKey("pinterestAccounts")) || {};
      if (allAccounts[accountId]) {
        allAccounts[accountId].businessId = businessId;
        allAccounts[accountId].ownedContentList = ownedContentList;
        await updateData("pinterestAccounts", allAccounts);
        log(`${MODULE} [${accountId}] Cached businessId: ${businessId}`);
      }
    }
  }

  if (!businessId) {
    throw new Error("Could not determine Pinterest businessId");
  }

  // Step 3: Build request config with exact Pinterest headers
  const requestConfig = buildRequestConfig(sessionData, proxy);

  // Step 4: Fetch metrics for all metric types
  const { startDate, endDate, startTimestamp, endTimestamp } = getDateRange90Days();
  const today = new Date().toISOString().split("T")[0];
  let totalMetricsSaved = 0;
  let totalPinsSaved = 0;
  const failedMetrics = [];

  for (const metricType of METRIC_TYPES) {
    try {
      // Fetch daily metrics
      const metricsData = await fetchMetrics(
        businessId, metricType, startDate, endDate, startTimestamp, endTimestamp,
        ownedContentList, requestConfig
      );

      if (metricsData?.resource_response?.data?.all) {
        const allData = metricsData.resource_response.data.all;

        // Store daily metrics
        if (allData.daily_metrics) {
          const saved = db.upsertDailyMetricsBatch(accountId, metricType, allData.daily_metrics);
          totalMetricsSaved += saved;
        }

        // Store summary metrics
        if (allData.summary_metrics && allData.summary_metrics[metricType] !== undefined) {
          db.upsertSummaryMetric(accountId, "last90d", metricType, allData.summary_metrics[metricType]);
        }
      }

      // Fetch top pins
      const topPinsData = await fetchTopPins(
        businessId, metricType, startDate, endDate, startTimestamp, endTimestamp,
        ownedContentList, requestConfig
      );

      if (topPinsData?.resource_response?.data?.[metricType]) {
        const pins = topPinsData.resource_response.data[metricType];
        const saved = db.upsertTopPinsBatch(accountId, today, metricType, pins);
        totalPinsSaved += saved;
      }

      log(`${MODULE} [${accountId}] ${metricType}: metrics + top pins fetched`);
    } catch (err) {
      logError(`${MODULE} [${accountId}] Error fetching ${metricType}:`, err.message);
      db.logFetch(accountId, metricType, "error", err.message);
      failedMetrics.push(metricType);
    }
  }

  // All 5 metric types must succeed for the account to be marked as collected
  if (failedMetrics.length > 0) {
    throw new Error(`Failed to collect metrics: ${failedMetrics.join(", ")}`);
  }

  db.logFetch(accountId, "all", "success", null, totalMetricsSaved, totalPinsSaved);
  log(`${MODULE} [${accountId}] Done: ${totalMetricsSaved} metrics, ${totalPinsSaved} pins saved`);

  return { success: true, metricsSaved: totalMetricsSaved, pinsSaved: totalPinsSaved };
}

// ============================================================
// BROWSER SESSION EXTRACTION
// ============================================================

async function extractSessionData(profileId, fingerprint, proxy) {
  let chromeProcess = null;
  let client = null;

  try {
    const result = await startVCBrowser(
      profileId,
      fingerprint,
      "https://analytics.pinterest.com/overview/",
      proxy,
      true,   // headless
      false   // automationMode
    );

    chromeProcess = result.chromeProcess;
    client = result.client;

    // Enable CDP domains
    await Promise.all([
      client.send("Network.enable"),
      client.send("Page.enable"),
      client.send("Runtime.enable"),
    ]);

    // Block media/images/fonts/stylesheets to save proxy bandwidth
    // Only allow document, script, XHR, and fetch requests
    await client.send("Fetch.enable", {
      patterns: [{ requestStage: "Request" }],
    });

    const BLOCKED_RESOURCE_TYPES = new Set([
      "Image", "Media", "Font", "Stylesheet", "Manifest",
      "Ping", "Preflight", "TextTrack", "Prefetch",
    ]);

    // Also capture businessId from network responses during page load
    const discoveredData = { businessId: null, ownedContentList: null };

    client.on("Network.responseReceived", async ({ requestId, response }) => {
      try {
        if (discoveredData.businessId) return; // Already found
        const url = response.url || "";
        // Look for analytics API responses or user session responses that contain businessId
        if (url.includes("pinterest.com") && (
          url.includes("/resource/") || url.includes("/v3/") || url.includes("UserSession")
        )) {
          const { body } = await client.send("Network.getResponseBody", { requestId });
          if (body) {
            // Look for actingBusinessId or user ID patterns
            const bizMatch = body.match(/"actingBusinessId"\s*:\s*"?(\d+)"?/);
            if (bizMatch) {
              discoveredData.businessId = bizMatch[1];
              log(`${MODULE} Found businessId from network response: ${bizMatch[1]}`);
            }
            // Try user id pattern
            if (!discoveredData.businessId) {
              const userIdMatch = body.match(/"id"\s*:\s*"(\d{15,})"/) || body.match(/"user_id"\s*:\s*"?(\d{15,})"?/);
              if (userIdMatch) {
                discoveredData.businessId = userIdMatch[1];
                log(`${MODULE} Found userId from network response: ${userIdMatch[1]}`);
              }
            }
            // Try verified_user_websites
            if (discoveredData.businessId && !discoveredData.ownedContentList) {
              const websitesMatch = body.match(/"verified_user_websites"\s*:\s*(\[[^\]]*\])/);
              if (websitesMatch) {
                try {
                  const websites = JSON.parse(websitesMatch[1]);
                  discoveredData.ownedContentList = websites.map((w) => typeof w === "string" ? w : w.website || w).concat(["other"]);
                } catch (e) { /* ignore */ }
              }
            }
          }
        }
      } catch (e) {
        // Response body may not be available yet or request may have been aborted
      }
    });

    client.on("Fetch.requestPaused", async ({ requestId, resourceType, request }) => {
      try {
        if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
          await client.send("Fetch.failRequest", { requestId, errorReason: "Aborted" });
        } else {
          await client.send("Fetch.continueRequest", { requestId });
        }
      } catch (e) {
        // Browser may have closed
      }
    });

    // Wait for page to load
    await waitForPageLoad(client, 15000);

    // Extract cookies
    const { cookies: cookieArray } = await client.send("Network.getCookies", {
      urls: ["https://analytics.pinterest.com", "https://www.pinterest.com"],
    });

    const cookieString = cookieArray.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrftoken = cookieArray.find((c) => c.name === "csrftoken")?.value || "";

    // Extract User-Agent from browser
    const { result: uaResult } = await client.send("Runtime.evaluate", {
      expression: "navigator.userAgent",
    });
    const userAgent = uaResult.value || "";

    // Extract sec-ch-ua headers from browser
    const { result: brandResult } = await client.send("Runtime.evaluate", {
      expression: "navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : ''",
    });
    let secChUa = "";
    try {
      const brands = JSON.parse(brandResult.value || "[]");
      if (brands.length > 0) {
        secChUa = brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
      }
    } catch (e) {
      // Fallback: construct from user agent
    }

    // Primary: Extract from <script data-test-id="resource-response-data"> SSR tag
    let ssrResourceData = null;
    try {
      const { result: ssrResult } = await client.send("Runtime.evaluate", {
        expression: `
          (function() {
            try {
              var el = document.querySelector('script[data-test-id="resource-response-data"]');
              if (el && el.textContent) return el.textContent;
              return '';
            } catch(e) { return ''; }
          })()
        `,
      });
      if (ssrResult.value) {
        try {
          ssrResourceData = JSON.parse(ssrResult.value);
        } catch (e) { /* not valid JSON */ }
      }
    } catch (e) {
      // ignore
    }

    // Fallback: Try other page JS globals
    let pageData = null;
    try {
      const { result: pwsResult } = await client.send("Runtime.evaluate", {
        expression: `
          (function() {
            try {
              // Strategy 1: __PWS_DATA__ element
              var el = document.getElementById('__PWS_DATA__');
              if (el && el.textContent) return el.textContent;
              // Strategy 2: window.__PWS_DATA__
              if (window.__PWS_DATA__) return JSON.stringify(window.__PWS_DATA__);
              // Strategy 3: __NEXT_DATA__ (Next.js)
              var nd = document.getElementById('__NEXT_DATA__');
              if (nd && nd.textContent) return nd.textContent;
              // Strategy 4: window.__BOOTSTRAP_DATA__
              if (window.__BOOTSTRAP_DATA__) return JSON.stringify(window.__BOOTSTRAP_DATA__);
              // Strategy 5: Search all script tags for inline JSON containing actingBusinessId
              var scripts = document.querySelectorAll('script:not([src])');
              for (var i = 0; i < scripts.length; i++) {
                var t = scripts[i].textContent;
                if (t && t.indexOf('actingBusinessId') !== -1) return t;
                if (t && t.indexOf('businessProfileId') !== -1) return t;
              }
              return '';
            } catch(e) { return ''; }
          })()
        `,
      });
      if (pwsResult.value) {
        try {
          pageData = JSON.parse(pwsResult.value);
        } catch (e) {
          // May be raw script content, not JSON â€” try to extract businessId from it
          const bizMatch = pwsResult.value.match(/actingBusinessId[=:"]\s*(\d+)/);
          if (bizMatch) {
            pageData = { _extractedBusinessId: bizMatch[1] };
          }
        }
      }
    } catch (e) {
      // Will discover businessId via alternative method
    }

    // Also try direct JS evaluation for common Pinterest globals
    let jsBusinessId = null;
    try {
      const { result: jsResult } = await client.send("Runtime.evaluate", {
        expression: `
          (function() {
            try {
              // Try window.P or window.__ANALYTICS_STATE__
              if (window.P && window.P.context && window.P.context.user) return window.P.context.user.id || '';
              // Try Redux store
              if (window.__STORE__ && window.__STORE__.getState) {
                var state = window.__STORE__.getState();
                if (state.viewer && state.viewer.id) return state.viewer.id;
              }
              // Try meta tags
              var meta = document.querySelector('meta[name="pinterestapp:pinnerid"]');
              if (meta) return meta.content || '';
              // Try data attributes
              var el = document.querySelector('[data-business-id]');
              if (el) return el.getAttribute('data-business-id') || '';
              return '';
            } catch(e) { return ''; }
          })()
        `,
      });
      if (jsResult.value && /^\d+$/.test(jsResult.value)) {
        jsBusinessId = jsResult.value;
      }
    } catch (e) {
      // ignore
    }

    // Also try extracting from URL (Pinterest may redirect with actingBusinessId)
    let currentUrl = "";
    try {
      const { result: urlResult } = await client.send("Runtime.evaluate", {
        expression: "window.location.href",
      });
      currentUrl = urlResult.value || "";
    } catch (e) {
      // ignore
    }

    return {
      cookies: cookieString,
      csrftoken,
      userAgent,
      secChUa,
      ssrResourceData,
      pageData,
      currentUrl,
      discoveredData,
      jsBusinessId,
    };
  } finally {
    // Always close browser
    if (client) {
      try { await client.send("Browser.close"); } catch (e) { /* ignore */ }
    }
    if (chromeProcess) {
      try { chromeProcess.kill(); } catch (e) { /* ignore */ }
    }
  }
}

function waitForPageLoad(client, timeout = 15000) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, timeout);

    const handler = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        // Give extra time for JS to execute
        setTimeout(resolve, 3000);
      }
    };

    client.on("Page.loadEventFired", handler);
  });
}

// ============================================================
// BUSINESS ID DISCOVERY
// ============================================================

async function discoverBusinessId(sessionData, proxy) {
  let businessId = null;
  let ownedContentList = ["other"];

  // Strategy 0 (PRIMARY): From SSR <script data-test-id="resource-response-data"> tag
  if (sessionData.ssrResourceData) {
    try {
      const ssr = sessionData.ssrResourceData;
      // The tag contains {resource: {name, options}, resource_response: {data: {id, ...}}}
      const userData = ssr.resource_response?.data;
      if (userData?.id) {
        businessId = userData.id;
      } else if (ssr.resource?.options?.user_id) {
        businessId = ssr.resource.options.user_id;
      }
      if (userData?.verified_user_websites && userData.verified_user_websites.length > 0) {
        ownedContentList = userData.verified_user_websites
          .map((w) => (typeof w === "string" ? w : w.website || w))
          .concat(["other"]);
      } else if (userData?.verified_domains && userData.verified_domains.length > 0) {
        ownedContentList = userData.verified_domains.concat(["other"]);
      }
      if (businessId) log(`${MODULE} businessId from SSR resource-response-data: ${businessId}`);
    } catch (e) {
      // ignore parse errors
    }
  }

  // Strategy 1: From network interception during page load
  if (!businessId && sessionData.discoveredData?.businessId) {
    businessId = sessionData.discoveredData.businessId;
    if (sessionData.discoveredData.ownedContentList) {
      ownedContentList = sessionData.discoveredData.ownedContentList;
    }
    log(`${MODULE} businessId from network interception: ${businessId}`);
  }

  // Strategy 2: From JS evaluation of page globals
  if (!businessId && sessionData.jsBusinessId) {
    businessId = sessionData.jsBusinessId;
    log(`${MODULE} businessId from JS evaluation: ${businessId}`);
  }

  // Strategy 3: Extract from page data (__PWS_DATA__ / __NEXT_DATA__ / inline scripts)
  if (!businessId && sessionData.pageData) {
    try {
      const data = sessionData.pageData;
      // Direct extracted businessId from script content
      if (data._extractedBusinessId) {
        businessId = data._extractedBusinessId;
      } else if (data.props?.context?.actingBusinessId) {
        businessId = data.props.context.actingBusinessId;
      } else if (data.props?.initialReduxState?.viewer?.businessProfile?.id) {
        businessId = data.props.initialReduxState.viewer.businessProfile.id;
      } else if (data.props?.initialReduxState?.viewer?.id) {
        businessId = data.props.initialReduxState.viewer.id;
      } else if (data.props?.context?.user?.id) {
        businessId = data.props.context.user.id;
      }

      // Extract verified websites
      const user = data.props?.context?.user || data.props?.initialReduxState?.viewer;
      if (user?.verified_user_websites) {
        ownedContentList = user.verified_user_websites.map((w) => w.website || w).concat(["other"]);
      }

      if (businessId) log(`${MODULE} businessId from page data: ${businessId}`);
    } catch (e) {
      // ignore parse errors
    }
  }

  // Strategy 4: Extract from URL redirect (actingBusinessId in query string)
  if (!businessId && sessionData.currentUrl) {
    const match = sessionData.currentUrl.match(/actingBusinessId=(\d+)/);
    if (match) {
      businessId = match[1];
      log(`${MODULE} businessId from URL: ${businessId}`);
    }
  }

  // Strategy 5: Make a UserSessionResource call via analytics.pinterest.com with full headers + proxy
  if (!businessId && sessionData.cookies && sessionData.csrftoken) {
    try {
      const traceId = crypto.randomBytes(8).toString("hex");
      const reqConfig = {
        params: {
          data: JSON.stringify({ options: { field_set_key: "default" }, context: {} }),
          _: Date.now(),
        },
        headers: {
          accept: "application/json, text/javascript, */*, q=0.01",
          "accept-language": "en-US,en;q=0.9",
          cookie: sessionData.cookies,
          "x-csrftoken": sessionData.csrftoken,
          "x-requested-with": "XMLHttpRequest",
          "x-pinterest-appstate": "active",
          "x-app-version": "dc17062",
          "x-b3-traceid": traceId,
          "x-b3-spanid": crypto.randomBytes(8).toString("hex"),
          "x-b3-parentspanid": traceId,
          "x-b3-flags": "0",
          referer: "https://analytics.pinterest.com/",
          "user-agent": sessionData.userAgent,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        timeout: 15000,
      };

      // Route through same proxy
      const agent = buildProxyAgent(proxy);
      if (agent) reqConfig.httpsAgent = agent;

      const response = await axios.get(
        "https://analytics.pinterest.com/resource/UserSessionResource/get/",
        reqConfig
      );

      const userData = response.data?.resource_response?.data;
      if (userData?.id) {
        businessId = userData.id;
        log(`${MODULE} businessId from UserSessionResource: ${businessId}`);
      }
      if (userData?.verified_user_websites) {
        ownedContentList = userData.verified_user_websites
          .map((w) => (typeof w === "string" ? w : w.website || w))
          .concat(["other"]);
      }
    } catch (e) {
      logWarn(`${MODULE} UserSessionResource fallback failed:`, e.message);
    }
  }

  // Strategy 6: If still no luck, try the main pinterest.com with same-origin headers
  if (!businessId && sessionData.cookies && sessionData.csrftoken) {
    try {
      const reqConfig = {
        params: {
          data: JSON.stringify({ options: { field_set_key: "default" }, context: {} }),
          _: Date.now(),
        },
        headers: {
          accept: "application/json, text/javascript, */*, q=0.01",
          cookie: sessionData.cookies,
          "x-csrftoken": sessionData.csrftoken,
          "x-requested-with": "XMLHttpRequest",
          "user-agent": sessionData.userAgent,
          referer: "https://www.pinterest.com/",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        timeout: 15000,
      };

      const agent = buildProxyAgent(proxy);
      if (agent) reqConfig.httpsAgent = agent;

      const response = await axios.get(
        "https://www.pinterest.com/resource/UserSessionResource/get/",
        reqConfig
      );

      const userData = response.data?.resource_response?.data;
      if (userData?.id) {
        businessId = userData.id;
        log(`${MODULE} businessId from pinterest.com UserSessionResource: ${businessId}`);
      }
      if (userData?.verified_user_websites) {
        ownedContentList = userData.verified_user_websites
          .map((w) => (typeof w === "string" ? w : w.website || w))
          .concat(["other"]);
      }
    } catch (e) {
      logWarn(`${MODULE} pinterest.com UserSessionResource fallback failed:`, e.message);
    }
  }

  return { businessId, ownedContentList };
}

// ============================================================
// HTTP REQUEST CONSTRUCTION
// ============================================================

function resolveProxy(profile) {
  if (!profile.proxy || !profile.proxy.ip) return null;

  const p = profile.proxy;
  return {
    ip: p.ip.trim(),
    port: (p.port || "").toString().trim(),
    username: (p.username || "").trim(),
    password: (p.password || "").trim(),
  };
}

function buildProxyAgent(proxy) {
  if (!proxy || !proxy.ip || proxy.ip === "NULL") return undefined;

  const portNum = parseInt(proxy.port, 10) || 80;
  let proxyUrl;

  if (proxy.username && proxy.username !== "NULL") {
    proxyUrl = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.ip}:${portNum}`;
  } else {
    proxyUrl = `http://${proxy.ip}:${portNum}`;
  }

  return new HttpsProxyAgent(proxyUrl);
}

function buildRequestConfig(sessionData, proxy) {
  const traceId = crypto.randomBytes(8).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");

  const headers = {
    accept: "application/json, text/javascript, */*, q=0.01",
    "accept-language": "en-US,en;q=0.9",
    cookie: sessionData.cookies,
    "x-csrftoken": sessionData.csrftoken,
    "x-requested-with": "XMLHttpRequest",
    "x-pinterest-appstate": "active",
    "x-pinterest-pws-handler": "analytics/overview.js",
    "x-app-version": "dc17062",
    "x-b3-flags": "0",
    "x-b3-traceid": traceId,
    "x-b3-spanid": spanId,
    "x-b3-parentspanid": traceId,
    referer: "https://analytics.pinterest.com/",
    "screen-dpr": "1",
    "user-agent": sessionData.userAgent,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  // Add sec-ch-ua if we extracted it from the browser
  if (sessionData.secChUa) {
    headers["sec-ch-ua"] = sessionData.secChUa;
  }

  const config = { headers, timeout: 30000 };

  // Apply proxy agent if applicable
  const agent = buildProxyAgent(proxy);
  if (agent) {
    config.httpsAgent = agent;
  }

  return config;
}

function getDateRange90Days() {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 90);

  const startDate = start.toISOString().split("T")[0];
  const endDate = end.toISOString().split("T")[0];
  const startTimestamp = Math.floor(start.getTime() / 1000);
  const endTimestamp = Math.floor(now.getTime() / 1000);

  return { startDate, endDate, startTimestamp, endTimestamp };
}

// ============================================================
// PINTEREST API REQUESTS
// ============================================================

function buildMetricsSourceUrl(businessId, metricType) {
  return `/overview/?actingBusinessId=${businessId}&age=all&board_metric=${metricType}&board_id=&claimed_account_type=all&content_type=all&device_type=all&gender=all&include_curated=created&include_realtime=true&pin_format=all&pin_metric=${metricType}&primary_metric=${metricType}&recent_pins=false&selected_split=NO_SPLIT&source_type=all&aggregation=last90d`;
}

async function fetchMetrics(businessId, metricType, startDate, endDate, startTimestamp, endTimestamp, ownedContentList, requestConfig) {
  const dataPayload = {
    options: {
      url: `/v3/analytics/users/${businessId}/metrics/`,
      data: {
        start_date: startDate,
        end_date: endDate,
        app_types: "all",
        owned_content_list: ownedContentList,
        paid: "2",
        in_profile: "2",
        from_owned_content: "2",
        include_curated: "0",
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp,
        include_realtime_data: true,
        include_offline_data: true,
        use_daily_buckets: true,
        use_hourly_buckets: false,
        metric_types: [metricType],
        split_field: "NO_SPLIT",
        ages: "all",
        genders: "all",
      },
    },
    context: {},
  };

  const sourceUrl = buildMetricsSourceUrl(businessId, metricType);

  // Build fresh trace IDs per request
  const traceId = crypto.randomBytes(8).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");

  const config = {
    ...requestConfig,
    headers: {
      ...requestConfig.headers,
      "x-pinterest-source-url": sourceUrl,
      "x-b3-traceid": traceId,
      "x-b3-spanid": spanId,
      "x-b3-parentspanid": traceId,
    },
    params: {
      source_url: sourceUrl,
      data: JSON.stringify(dataPayload),
      _: Date.now(),
    },
  };

  const response = await axios.get(ANALYTICS_BASE_URL, config);
  return response.data;
}

async function fetchTopPins(businessId, metricType, startDate, endDate, startTimestamp, endTimestamp, ownedContentList, requestConfig) {
  const dataPayload = {
    options: {
      url: `/v3/analytics/users/${businessId}/pins/top/`,
      data: {
        start_date: startDate,
        end_date: endDate,
        user_id: businessId,
        metric_types: [metricType],
        sort_by_metrics: [metricType],
        paid: "2",
        in_profile: "2",
        from_owned_content: "2",
        app_types: "all",
        owned_content_list: ownedContentList,
        include_curated: "0",
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp,
        include_realtime_data: true,
        include_offline_data: true,
        num_of_pins: 50,
        created_in_last_n_days: null,
        ages: "all",
        genders: "all",
        fields: "pin.images,pin.grid_title,pin.title,pin.description,pin.id,pin.dominant_color,pin.pinner,pin.is_quick_promotable,pin.created_at,pin.link",
      },
    },
    context: {},
  };

  const sourceUrl = buildMetricsSourceUrl(businessId, metricType);

  // Build fresh trace IDs per request
  const traceId = crypto.randomBytes(8).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");

  const config = {
    ...requestConfig,
    headers: {
      ...requestConfig.headers,
      "x-pinterest-source-url": sourceUrl,
      "x-b3-traceid": traceId,
      "x-b3-spanid": spanId,
      "x-b3-parentspanid": traceId,
    },
    params: {
      source_url: sourceUrl,
      data: JSON.stringify(dataPayload),
      _: Date.now(),
    },
  };

  const response = await axios.get(ANALYTICS_BASE_URL, config);
  return response.data;
}

function getCollectionProgress() {
  return { ...collectionProgress };
}

// ============================================================
// SINGLE-ACCOUNT RETRY
// ============================================================

async function retrySingleAccount(accountId) {
  const pinterestAccounts = (await readKey("pinterestAccounts")) || {};
  const structures = (await readKey("structures")) || {};
  const account = pinterestAccounts[accountId];

  if (!account || !account.linkedStructureId || !account.linkedProfileId) {
    return { success: false, error: "Account not found or not linked" };
  }

  const db = getPinterestAnalyticsDatabase();
  const MAX_RETRIES = 3;

  sendAccountProgressToRenderer({ status: "processing", accountId });

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt === 1) {
        log(`${MODULE} Retrying account: ${accountId}`);
      } else {
        log(`${MODULE} Retry attempt ${attempt}/${MAX_RETRIES} for ${accountId}...`);
      }
      const result = await collectForAccount(accountId, account, structures, db);
      sendAccountProgressToRenderer({ status: "success", accountId, metricsSaved: result.metricsSaved, pinsSaved: result.pinsSaved });
      return { success: true, metricsSaved: result.metricsSaved, pinsSaved: result.pinsSaved };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        logWarn(`${MODULE} Retry attempt ${attempt}/${MAX_RETRIES} failed for ${accountId}: ${err.message}. Retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  logError(`${MODULE} All ${MAX_RETRIES} retry attempts failed for account ${accountId}:`, lastError.message);
  db.logFetch(accountId, "all", "error", lastError.message);
  sendAccountProgressToRenderer({ status: "error", accountId, error: lastError.message });
  return { success: false, error: lastError.message };
}

module.exports = {
  collectPinterestAnalytics,
  retrySingleAccount,
  getCollectionProgress,
  METRIC_TYPES,
};

