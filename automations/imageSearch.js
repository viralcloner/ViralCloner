/**
 * Image Search Engines (ISE) Automation
 * Scrapes images from Google and Bing using VCBrowser (undetectable Chrome)
 */

const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const { startVCBrowser, isVCBrowserInstalled } = require("../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../lib/cdpFingerprint");
const { isIseImageHidden } = require("../lib/utils");

// Constants
const SEARCH_TIMEOUT = 30000;
const MAX_RESULTS_PER_ENGINE = 100;
const ISE_GOOGLE_PROFILE = "ise-google-search"; // Separate profile for Google
const ISE_BING_PROFILE = "ise-bing-search";     // Separate profile for Bing

/**
 * Get the user data path for storing browser profile
 */
function getUserDataPath() {
  return app.getPath("userData");
}

/**
 * Sleep utility for CDP-based waiting
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Search Google Images for a query
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum number of results (default 50)
 * @param {boolean} safeSearch - Enable safe search (default true)
 * @returns {Promise<{success: boolean, value: Array|string}>}
 */
async function searchGoogleImages(query, maxResults = 50, safeSearch = true) {
  let chromeProcess = null;
  let client = null;

  const cleanup = async () => {
    if (client) {
      try { await client.close(); } catch (e) {}
    }
    if (chromeProcess) {
      try { chromeProcess.kill(); } catch (e) {}
    }
  };

  try {
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return { success: false, value: "Invalid search query" };
    }

    // Check if VCBrowser is installed
    if (!isVCBrowserInstalled()) {
      return { success: false, value: "VCBrowser is not installed. Please download it from Settings." };
    }

    const cleanQuery = query.trim();
    maxResults = Math.min(Math.max(1, maxResults), MAX_RESULTS_PER_ENGINE);

    // Build Google Images URL
    const safeParam = safeSearch ? "&safe=active" : "&safe=off";
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(cleanQuery)}&tbm=isch${safeParam}`;

    console.log(`[ISE] Searching Google Images for: "${cleanQuery}"`);

    // Get fingerprint for Google profile (consistent across searches)
    const fingerprint = getConsistentFingerprintForProfile(ISE_GOOGLE_PROFILE);
    
    // Update to VCBrowser's actual version to avoid fingerprint detection
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
      }
    } catch (e) { /* use fallback */ }

    // Launch VCBrowser in headless mode with automation permissions
    const result = await startVCBrowser(
      ISE_GOOGLE_PROFILE,
      fingerprint,
      searchUrl,
      null,  // no proxy
      true,  // headless
      true   // automationMode
    );

    chromeProcess = result.chromeProcess;
    client = result.client;

    console.log(`[ISE] VCBrowser connected on port ${result.debuggingPort}`);

    const { Page, Runtime } = client;
    await Page.enable();

    // Wait for page to load
    await Page.loadEventFired();
    await sleep(2000);

    // Accept cookies if prompted (for EU users)
    try {
      await Runtime.evaluate({
        expression: `
          (function() {
            const btn = document.querySelector('button[id="L2AGLb"]');
            if (btn) btn.click();
          })()
        `
      });
      await sleep(1000);
    } catch (e) {
      // Cookies dialog may not appear
    }

    // Scroll to load more images if needed
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = Math.ceil(maxResults / 20);

    while (scrollAttempts < maxScrollAttempts) {
      // Scroll down
      await Runtime.evaluate({
        expression: `window.scrollTo(0, document.body.scrollHeight)`
      });
      await sleep(800);

      // Check if we can load more
      const heightResult = await Runtime.evaluate({
        expression: `document.body.scrollHeight`
      });
      const newHeight = heightResult.result.value || 0;
      
      if (newHeight === previousHeight) {
        // Try clicking "Show more results" button if available
        const clickResult = await Runtime.evaluate({
          expression: `
            (function() {
              const btn = document.querySelector('input[value="Show more results"]');
              if (btn) { btn.click(); return true; }
              return false;
            })()
          `
        });
        if (!clickResult.result.value) break;
        await sleep(1500);
      }
      previousHeight = newHeight;
      scrollAttempts++;
    }

    // Extract image data using CDP - look for full resolution URLs in Google's data
    const imagesResult = await Runtime.evaluate({
      expression: `
        (function() {
          const results = [];
          const limit = ${maxResults};
          const seenUrls = new Set();
          
          // Helper to unescape URL unicode sequences like \\u003d -> =
          function unescapeUrl(url) {
            try {
              return url
                .replace(/\\\\u003d/gi, '=')
                .replace(/\\\\u0026/gi, '&')
                .replace(/\\\\u002f/gi, '/')
                .replace(/\\\\u003c/gi, '<')
                .replace(/\\\\u003e/gi, '>')
                .replace(/\\\\x3d/gi, '=')
                .replace(/\\\\x26/gi, '&')
                .replace(/\\\\x2f/gi, '/')
                .replace(/\\\\\\\\/g, '');
            } catch (e) {
              return url;
            }
          }
          
          // Method 1: Look for image data arrays in scripts [url, width, height]
          const scripts = document.querySelectorAll('script');
          const urlPattern = /\\["(https?:[^"]+)",[0-9]+,[0-9]+\\]/gi;
          
          for (const script of scripts) {
            if (results.length >= limit) break;
            const content = script.textContent || '';
            if (!content.includes('http') || content.length < 100) continue;
            
            let match;
            while ((match = urlPattern.exec(content)) !== null && results.length < limit) {
              let url = unescapeUrl(match[1]);
              
              // Must be an image URL
              if (!url.match(/\\.(jpg|jpeg|png|gif|webp|bmp)/i)) continue;
              
              // Skip Google's own URLs and duplicates
              if (url.includes('google.com') || url.includes('gstatic.com') || url.includes('googleapis.com')) continue;
              if (url.includes('encrypted-tbn')) continue;
              if (seenUrls.has(url)) continue;
              
              seenUrls.add(url);
              results.push({
                id: "google_" + Date.now() + "_" + results.length,
                thumbnail: url,
                url: url,
                width: 0,
                height: 0,
                source: "google",
                sourceUrl: "",
                title: "",
              });
            }
          }
          
          // Method 2: If script extraction didn't work well, try clicking approach data
          if (results.length < 10) {
            // Look for image result containers with data attributes
            const containers = document.querySelectorAll('[data-tbnid], [data-id], .isv-r, .rg_i');
            
            for (const container of containers) {
              if (results.length >= limit) break;
              
              try {
                // Try to find data-ou (original URL) in nearby elements
                const dataOu = container.querySelector('[data-ou]');
                if (dataOu) {
                  const url = dataOu.getAttribute('data-ou');
                  if (url && !seenUrls.has(url) && !url.includes('google.com')) {
                    seenUrls.add(url);
                    results.push({
                      id: "google_" + Date.now() + "_" + results.length,
                      thumbnail: url,
                      url: url,
                      width: parseInt(dataOu.getAttribute('data-ow')) || 0,
                      height: parseInt(dataOu.getAttribute('data-oh')) || 0,
                      source: "google",
                      sourceUrl: dataOu.getAttribute('data-ru') || "",
                      title: dataOu.getAttribute('data-pt') || "",
                    });
                    continue;
                  }
                }
                
                // Try img with data-src that's a full URL
                const img = container.querySelector('img[data-src^="http"], img[src^="http"]');
                if (img) {
                  const url = img.dataset.src || img.src;
                  // Check if it's an encrypted_tbn URL (thumbnail) or real URL
                  if (url && !seenUrls.has(url) && !url.includes('encrypted-tbn') && !url.includes('google.com')) {
                    seenUrls.add(url);
                    results.push({
                      id: "google_" + Date.now() + "_" + results.length,
                      thumbnail: url,
                      url: url,
                      width: img.naturalWidth || 0,
                      height: img.naturalHeight || 0,
                      source: "google",
                      sourceUrl: "",
                      title: img.alt || "",
                    });
                  }
                }
              } catch (e) {}
            }
          }
          
          // Method 3: Final fallback - get thumbnail URLs but filter for larger ones
          if (results.length < 5) {
            const allImages = document.querySelectorAll('img[src^="http"], img[data-src^="http"]');
            for (const img of allImages) {
              if (results.length >= limit) break;
              const url = img.dataset.src || img.src;
              if (!url || seenUrls.has(url)) continue;
              if (url.includes('google.com/images/branding')) continue;
              // Accept encrypted-tbn as last resort but try to get larger size
              if (img.width < 50 && img.height < 50) continue;
              
              seenUrls.add(url);
              results.push({
                id: "google_" + Date.now() + "_" + results.length,
                thumbnail: url,
                url: url,
                width: img.naturalWidth || img.width || 0,
                height: img.naturalHeight || img.height || 0,
                source: "google",
                sourceUrl: "",
                title: img.alt || "",
              });
            }
          }
          
          return results;
        })()
      `,
      returnByValue: true
    });

    const images = imagesResult.result.value || [];
    console.log(`[ISE] Google extracted ${images.length} images from page`);

    // Skip the slow thumbnail clicking for now - just return the extracted images
    // The thumbnails are good enough for preview purposes
    await cleanup();

    console.log(`[ISE] Google Images found ${images.length} results`);
    return { success: true, value: images };
  } catch (error) {
    console.error("[ISE] Google Images search error:", error);
    await cleanup();
    return { success: false, value: error.message };
  }
}

/**
 * Search Bing Images for a query
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum number of results (default 50)
 * @param {boolean} safeSearch - Enable safe search (default true)
 * @returns {Promise<{success: boolean, value: Array|string}>}
 */
async function searchBingImages(query, maxResults = 50, safeSearch = true) {
  let chromeProcess = null;
  let client = null;

  const cleanup = async () => {
    if (client) {
      try { await client.close(); } catch (e) {}
    }
    if (chromeProcess) {
      try { chromeProcess.kill(); } catch (e) {}
    }
  };

  try {
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return { success: false, value: "Invalid search query" };
    }

    // Check if VCBrowser is installed
    if (!isVCBrowserInstalled()) {
      return { success: false, value: "VCBrowser is not installed. Please download it from Settings." };
    }

    const cleanQuery = query.trim();
    maxResults = Math.min(Math.max(1, maxResults), MAX_RESULTS_PER_ENGINE);

    // Build Bing Images URL
    const safeParam = safeSearch ? "&safeSearch=Strict" : "&safeSearch=Off";
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(cleanQuery)}${safeParam}&form=HDRSC2`;

    console.log(`[ISE] Searching Bing Images for: "${cleanQuery}"`);

    // Get fingerprint for Bing profile (separate from Google)
    const fingerprint = getConsistentFingerprintForProfile(ISE_BING_PROFILE);
    
    // Update to VCBrowser's actual version to avoid fingerprint detection
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
      }
    } catch (e) { /* use fallback */ }

    // Launch VCBrowser in headless mode
    const result = await startVCBrowser(
      ISE_BING_PROFILE,
      fingerprint,
      searchUrl,
      null,  // no proxy
      true,  // headless
      true   // automationMode
    );

    chromeProcess = result.chromeProcess;
    client = result.client;

    console.log(`[ISE] VCBrowser connected on port ${result.debuggingPort}`);

    const { Page, Runtime } = client;
    await Page.enable();

    // Wait for page to load
    await Page.loadEventFired();
    await sleep(2000);

    // Accept cookies if prompted
    try {
      await Runtime.evaluate({
        expression: `
          (function() {
            const btn = document.getElementById('bnp_btn_accept');
            if (btn) btn.click();
          })()
        `
      });
      await sleep(1000);
    } catch (e) {}

    // Scroll to load more images
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = Math.ceil(maxResults / 30);

    while (scrollAttempts < maxScrollAttempts) {
      await Runtime.evaluate({
        expression: `window.scrollTo(0, document.body.scrollHeight)`
      });
      await sleep(800);

      const heightResult = await Runtime.evaluate({
        expression: `document.body.scrollHeight`
      });
      const newHeight = heightResult.result.value || 0;

      if (newHeight === previousHeight) {
        // Try to click "See more images" button
        const clickResult = await Runtime.evaluate({
          expression: `
            (function() {
              const btn = document.querySelector('.btn_seemore');
              if (btn) { btn.click(); return true; }
              return false;
            })()
          `
        });
        if (!clickResult.result.value) break;
        await sleep(1500);
      }
      previousHeight = newHeight;
      scrollAttempts++;
    }

    // Extract image data from Bing using CDP
    const imagesResult = await Runtime.evaluate({
      expression: `
        (function() {
          const results = [];
          const limit = ${maxResults};
          const imageContainers = document.querySelectorAll(".iusc");

          for (const container of imageContainers) {
            if (results.length >= limit) break;

            try {
              const metaAttr = container.getAttribute("m");
              if (!metaAttr) continue;

              const meta = JSON.parse(metaAttr);
              const thumbnail = container.querySelector("img");

              results.push({
                id: "bing_" + Date.now() + "_" + results.length,
                thumbnail: meta.turl || (thumbnail ? thumbnail.src : ""),
                url: meta.murl || "",
                width: meta.pwidth || 0,
                height: meta.pheight || 0,
                source: "bing",
                sourceUrl: meta.purl || "",
                title: meta.t || (thumbnail ? thumbnail.alt : ""),
              });
            } catch (e) {}
          }
          return results;
        })()
      `,
      returnByValue: true
    });

    const images = imagesResult.result.value || [];

    await cleanup();

    console.log(`[ISE] Bing Images found ${images.length} results`);
    return { success: true, value: images };
  } catch (error) {
    console.error("[ISE] Bing Images search error:", error);
    await cleanup();
    return { success: false, value: error.message };
  }
}

/**
 * Search both Google and Bing Images
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @param {number} options.maxResults - Max results per engine (default 50)
 * @param {boolean} options.safeSearch - Enable safe search (default true)
 * @param {Array<string>} options.engines - Which engines to use ['google', 'bing'] (default both)
 * @returns {Promise<{success: boolean, value: Array|string}>}
 */
async function searchImages(query, options = {}) {
  const {
    maxResults = 50,
    safeSearch = true,
    engines = ["google", "bing"],
  } = options;

  try {
    const results = [];
    const errors = [];

    // Search in parallel since we use separate profiles for each engine
    const searchPromises = [];

    if (engines.includes("google")) {
      console.log("[ISE] Starting Google Images search...");
      searchPromises.push(
        searchGoogleImages(query, maxResults, safeSearch)
          .then(result => ({ engine: "google", result }))
          .catch(err => ({ engine: "google", result: { success: false, value: err.message } }))
      );
    }

    if (engines.includes("bing")) {
      console.log("[ISE] Starting Bing Images search...");
      searchPromises.push(
        searchBingImages(query, maxResults, safeSearch)
          .then(result => ({ engine: "bing", result }))
          .catch(err => ({ engine: "bing", result: { success: false, value: err.message } }))
      );
    }

    const searchResults = await Promise.all(searchPromises);

    for (const { engine, result } of searchResults) {
      if (result.success) {
        console.log(`[ISE] ${engine} returned ${result.value.length} images`);
        results.push(...result.value);
      } else {
        console.error(`[ISE] ${engine} search failed: ${result.value}`);
        errors.push(`${engine}: ${result.value}`);
      }
    }

    if (results.length === 0 && errors.length > 0) {
      return { success: false, value: errors.join("; ") };
    }

    // Remove duplicates based on URL and filter hidden images
    const uniqueResults = [];
    const seenUrls = new Set();
    let hiddenCount = 0;

    for (const img of results) {
      if (img.url && !seenUrls.has(img.url)) {
        // Check if image is hidden before adding
        if (isIseImageHidden(img.url)) {
          hiddenCount++;
          continue;
        }
        seenUrls.add(img.url);
        uniqueResults.push(img);
      }
    }

    if (hiddenCount > 0) {
      console.log(`[ISE] Filtered out ${hiddenCount} hidden images`);
    }

    console.log(
      `[ISE] Combined search found ${uniqueResults.length} unique results`
    );
    return { success: true, value: uniqueResults };
  } catch (error) {
    console.error("[ISE] Combined search error:", error);
    return { success: false, value: error.message };
  }
}

/**
 * Download an image from URL to local storage
 * @param {string} imageUrl - URL of the image to download
 * @param {string} outputDir - Directory to save the image
 * @returns {Promise<{success: boolean, value: string}>}
 */
async function downloadImage(imageUrl, outputDir = null) {
  try {
    if (!imageUrl || !imageUrl.startsWith("http")) {
      return { success: false, value: "Invalid image URL" };
    }

    const axios = require("axios");
    const userDataPath = getUserDataPath();
    const imagesDir = outputDir || path.join(userDataPath, "Images");

    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const extension = path.extname(new URL(imageUrl).pathname) || ".jpg";
    const filename = `ise_${timestamp}_${randomStr}${extension}`;
    const filePath = path.join(imagesDir, filename);

    // Download the image
    const response = await axios({
      method: "GET",
      url: imageUrl,
      responseType: "arraybuffer",
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://www.google.com/",
      },
    });

    fs.writeFileSync(filePath, response.data);

    console.log(`[ISE] Downloaded image to: ${filePath}`);
    return { success: true, value: filename };
  } catch (error) {
    console.error("[ISE] Image download error:", error.message);
    return { success: false, value: error.message };
  }
}

module.exports = {
  searchGoogleImages,
  searchBingImages,
  searchImages,
  downloadImage,
};
