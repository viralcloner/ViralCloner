/**
 * Google Trends Integration for ViralCloner
 * Fetches trending topics from Google Trends using VCBrowser for reliability
 * Scrapes the trending page directly to avoid API rate limits
 */

const { readKey, updateData } = require("../lib/utils");
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('../lib/cdpFingerprint');

// Cache duration: 6 hours (to avoid rate limits)
const TRENDS_CACHE_DURATION = 6 * 60 * 60 * 1000;

// Profile name for Google Trends scraping
const GTRENDS_PROFILE = 'gtrends_scraper';

// Time range options (hours)
const TIME_RANGES = {
  '4h': 4,
  '24h': 24,
  '48h': 48,
  '7d': 168,
};

// Google Trends category IDs (from Google Trends UI data-value attributes)
const CATEGORY_MAP = {
  all: 0,                    // All categories
  autos: 1,                  // Autos and Vehicles
  beauty: 2,                 // Beauty and Fashion
  business: 3,               // Business and Finance
  climate: 20,               // Climate
  entertainment: 4,          // Entertainment
  food: 5,                   // Food and Drink
  games: 6,                  // Games
  health: 7,                 // Health
  hobbies: 8,                // Hobbies and Leisure
  jobs: 9,                   // Jobs and Education
  law: 10,                   // Law and Government
  other: 11,                 // Other
  pets: 13,                  // Pets and Animals
  politics: 14,              // Politics
  science: 15,               // Science
  shopping: 16,              // Shopping
  sports: 17,                // Sports
  tech: 18,                  // Technology
  travel: 19,                // Travel and Transportation
};

// Region codes for Google Trends (using appropriate TLD)
const REGION_CODES = {
  worldwide: { code: "", tld: "com" },
  us: { code: "US", tld: "com" },
  uk: { code: "GB", tld: "co.uk" },
  canada: { code: "CA", tld: "ca" },
  australia: { code: "AU", tld: "com.au" },
  germany: { code: "DE", tld: "de" },
  france: { code: "FR", tld: "fr" },
  spain: { code: "ES", tld: "es" },
  italy: { code: "IT", tld: "it" },
  brazil: { code: "BR", tld: "com.br" },
  mexico: { code: "MX", tld: "com.mx" },
  india: { code: "IN", tld: "co.in" },
  japan: { code: "JP", tld: "co.jp" },
  south_korea: { code: "KR", tld: "co.kr" },
  netherlands: { code: "NL", tld: "nl" },
  belgium: { code: "BE", tld: "be" },
  switzerland: { code: "CH", tld: "ch" },
  austria: { code: "AT", tld: "at" },
  portugal: { code: "PT", tld: "pt" },
  poland: { code: "PL", tld: "pl" },
  sweden: { code: "SE", tld: "se" },
  norway: { code: "NO", tld: "no" },
  denmark: { code: "DK", tld: "dk" },
  finland: { code: "FI", tld: "fi" },
  ireland: { code: "IE", tld: "ie" },
  new_zealand: { code: "NZ", tld: "co.nz" },
  singapore: { code: "SG", tld: "com.sg" },
  uae: { code: "AE", tld: "ae" },
  saudi_arabia: { code: "SA", tld: "com.sa" },
  egypt: { code: "EG", tld: "com.eg" },
  south_africa: { code: "ZA", tld: "co.za" },
  morocco: { code: "MA", tld: "co.ma" },
  algeria: { code: "DZ", tld: "com" },
  tunisia: { code: "TN", tld: "tn" },
};

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get cached trends if available and not expired
 */
function getCachedTrends(cacheKey) {
  try {
    const cached = readKey(cacheKey);
    if (cached && cached.timestamp && cached.data) {
      const age = Date.now() - cached.timestamp;
      if (age < TRENDS_CACHE_DURATION) {
        console.log(`[GoogleTrends] Using cached data (age: ${Math.round(age / 60000)} minutes)`);
        return cached.data;
      }
    }
  } catch (error) {
    console.warn("[GoogleTrends] Cache read error:", error.message);
  }
  return null;
}

/**
 * Save trends to cache
 */
function cacheTrends(cacheKey, data) {
  try {
    updateData(cacheKey, {
      timestamp: Date.now(),
      data: data,
    });
    console.log(`[GoogleTrends] Cached ${data.length} trends`);
  } catch (error) {
    console.warn("[GoogleTrends] Cache write error:", error.message);
  }
}

/**
 * Build Google Trends URL
 */
function buildTrendsUrl(region = "US", category = "all", hours = 168) {
  const regionKey = region.toLowerCase().replace(/\s+/g, '_');
  const regionConfig = REGION_CODES[regionKey] || REGION_CODES.us;
  const tld = regionConfig.tld;
  const geo = regionConfig.code;
  const cat = CATEGORY_MAP[category] ?? CATEGORY_MAP["all"];
  
  // Build URL: https://trends.google.fr/trending?geo=MX&hours=168&category=5
  let url = `https://trends.google.${tld}/trending?`;
  if (geo) url += `geo=${geo}&`;
  url += `hours=${hours}`;
  // Always include category parameter
  url += `&category=${cat}`;
  
  return url;
}

/**
 * Extract trends from page HTML using CDP
 */
async function extractTrendsFromPage(Runtime) {
  const extractionScript = `
    (function() {
      const trends = [];
      
      // Find all trend rows
      const rows = document.querySelectorAll('tr[jsname="oKdM2c"]');
      
      rows.forEach((row, index) => {
        try {
          // Get main trend title from mZ3RIc class
          const titleEl = row.querySelector('.mZ3RIc');
          const title = titleEl ? titleEl.textContent.trim() : '';
          
          if (!title) return;
          
          // Get search volume from lqv0Cb class
          const volumeEl = row.querySelector('.lqv0Cb');
          const volume = volumeEl ? volumeEl.textContent.trim() : '';
          
          // Get growth percentage from TXt85b class
          const growthEl = row.querySelector('.TXt85b');
          const growth = growthEl ? growthEl.textContent.trim() : '';
          
          // Get timing info from qNpYPd class (e.g., "10 k+ recherches")
          const searchCountEl = row.querySelector('.qNpYPd');
          const searchCount = searchCountEl ? searchCountEl.textContent.trim() : '';
          
          // Get when it started from vdw3Ld class
          const startedEl = row.querySelector('.vdw3Ld');
          const started = startedEl ? startedEl.textContent.trim() : '';
          
          // Get duration info
          const durationEl = row.querySelector('.FTOQPb div');
          const duration = durationEl ? durationEl.textContent.trim() : '';
          
          // Get related terms (composition) - buttons with data-term attribute
          const relatedTerms = [];
          const termButtons = row.querySelectorAll('[data-term]');
          termButtons.forEach(btn => {
            const term = btn.getAttribute('data-term');
            if (term && term !== title) {
              relatedTerms.push(term);
            }
          });
          
          // Get row ID for unique identification
          const rowId = row.getAttribute('data-row-id') || index;
          
          trends.push({
            id: 'trend_' + rowId,
            title: title,
            volume: volume,
            growth: growth,
            searchCount: searchCount,
            started: started,
            duration: duration,
            relatedTerms: relatedTerms,
            trendType: 'google_trends'
          });
        } catch (e) {
          console.error('Error extracting trend row:', e);
        }
      });
      
      return trends;
    })()
  `;
  
  try {
    const result = await Runtime.evaluate({
      expression: extractionScript,
      returnByValue: true
    });
    
    return result.result.value || [];
  } catch (error) {
    console.error('[GoogleTrends] Extraction error:', error.message);
    return [];
  }
}

/**
 * Check if page has captcha - uses strict checks to avoid false positives
 */
async function checkForCaptcha(Runtime) {
  const captchaScript = `
    (function() {
      const url = document.location.href.toLowerCase();
      
      // Check for sorry/captcha redirect page (most reliable indicator)
      if (url.includes('/sorry/') || url.includes('google.com/sorry')) {
        return { hasCaptcha: true, type: 'sorry_page' };
      }
      
      // Check for reCAPTCHA iframe or elements
      if (document.querySelector('iframe[src*="recaptcha"]') || 
          document.querySelector('iframe[src*="google.com/recaptcha"]') ||
          document.querySelector('.g-recaptcha') ||
          document.querySelector('#recaptcha') ||
          document.querySelector('[data-sitekey]')) {
        return { hasCaptcha: true, type: 'recaptcha' };
      }
      
      // Check for specific captcha page elements (not generic body text)
      const captchaForm = document.querySelector('form[action*="sorry"]');
      if (captchaForm) {
        return { hasCaptcha: true, type: 'captcha_form' };
      }
      
      // Check for "unusual traffic" only if it's the main content (not a small warning)
      const mainContent = document.querySelector('#main, main, body');
      if (mainContent) {
        const text = mainContent.innerText || '';
        // Only trigger if "unusual traffic" appears prominently (likely a block page)
        if (text.includes('unusual traffic from your computer') ||
            text.includes('Our systems have detected unusual traffic')) {
          return { hasCaptcha: true, type: 'traffic_block' };
        }
      }
      
      return { hasCaptcha: false };
    })()
  `;
  
  try {
    const result = await Runtime.evaluate({
      expression: captchaScript,
      returnByValue: true
    });
    
    return result.result.value || { hasCaptcha: false };
  } catch (error) {
    return { hasCaptcha: false };
  }
}

/**
 * Wait for table to load
 */
async function waitForTable(Runtime, timeout = 15000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const result = await Runtime.evaluate({
        expression: `
          (function() {
            const table = document.querySelector('table.enOdEe-wZVHld-zg7Cn');
            const rows = document.querySelectorAll('tr[jsname="oKdM2c"]');
            return {
              hasTable: !!table,
              rowCount: rows.length
            };
          })()
        `,
        returnByValue: true
      });
      
      const info = result.result.value;
      if (info && info.hasTable && info.rowCount > 0) {
        console.log(`[GoogleTrends] Table loaded with ${info.rowCount} rows`);
        return true;
      }
    } catch (e) {}
    
    await sleep(500);
  }
  
  console.log('[GoogleTrends] Timeout waiting for table');
  return false;
}

/**
 * Get current page count and check if more pages exist
 */
async function getPageInfo(Runtime) {
  const pageInfoScript = `
    (function() {
      // Look for pagination info like "1-50 sur 123"
      const paginationEl = document.querySelector('.enOdEe-wZVHld-gruSEe-j4LONd [jsname="uEp2ad"]');
      const paginationText = paginationEl ? paginationEl.textContent : '';
      
      // Parse "1–5 sur 5" or "1-50 of 123"
      const match = paginationText.match(/(\\d+)[–-](\\d+)\\s+(?:sur|of|von|di|de)\\s+(\\d+)/i);
      
      if (match) {
        const currentEnd = parseInt(match[2]);
        const total = parseInt(match[3]);
        return {
          currentEnd: currentEnd,
          total: total,
          hasMore: currentEnd < total
        };
      }
      
      // Check if next button is enabled
      const nextButton = document.querySelector('[jsname="ViaHrd"]');
      const hasMore = nextButton && !nextButton.disabled;
      
      return {
        hasMore: hasMore,
        total: 0
      };
    })()
  `;
  
  try {
    const result = await Runtime.evaluate({
      expression: pageInfoScript,
      returnByValue: true
    });
    
    return result.result.value || { hasMore: false };
  } catch (error) {
    return { hasMore: false };
  }
}

/**
 * Click next page button
 */
async function clickNextPage(Runtime) {
  const clickScript = `
    (function() {
      const nextButton = document.querySelector('[jsname="ViaHrd"]');
      if (nextButton && !nextButton.disabled) {
        nextButton.click();
        return true;
      }
      return false;
    })()
  `;
  
  try {
    const result = await Runtime.evaluate({
      expression: clickScript,
      returnByValue: true
    });
    
    if (result.result.value) {
      // Wait for page to load new content
      await sleep(2000);
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Main function to fetch Google Trends using VCBrowser
 */
async function fetchGoogleTrends(options = {}) {
  const {
    region = "US",
    category = "all",
    hours = 168,  // Default: 7 days
    forceRefresh = false,
    maxPages = 3,  // Maximum pages to scrape
    showBrowserOnCaptcha = true,  // Show browser if captcha detected
  } = options;
  
  let chromeProcess = null;
  let client = null;
  
  try {
    // Check cache first
    const cacheKey = `gtrends_${region}_${category}_${hours}`;
    
    if (!forceRefresh) {
      const cached = getCachedTrends(cacheKey);
      if (cached) {
        return { success: true, trends: cached, fromCache: true };
      }
    }
    
    // Check if VCBrowser is installed
    if (!isVCBrowserInstalled()) {
      console.error('[GoogleTrends] VCBrowser is not installed');
      return { 
        success: false, 
        error: 'VCBrowser is not installed. Please install it from Settings.',
        trends: [] 
      };
    }
    
    const url = buildTrendsUrl(region, category, hours);
    console.log(`[GoogleTrends] Fetching trends from: ${url}`);
    
    // Generate fingerprint for the scraper profile
    const fingerprint = getConsistentFingerprintForProfile(GTRENDS_PROFILE);
    
    // Update to VCBrowser's actual version to avoid fingerprint detection
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
      }
    } catch (e) { /* use fallback */ }
    
    // Start VCBrowser in headless mode initially
    let headless = true;
    const result = await startVCBrowser(
      GTRENDS_PROFILE,
      fingerprint,
      url,
      null,  // no proxy
      headless,
      true   // automationMode
    );
    
    chromeProcess = result.chromeProcess;
    client = result.client;
    const debuggingPort = result.debuggingPort;
    
    console.log('[GoogleTrends] Connected to VCBrowser on port', debuggingPort);
    
    const { Page, Runtime, Network } = client;
    await Page.enable();
    await Runtime.enable();
    await Network.enable();
    
    // Wait for page to load
    await Page.loadEventFired();
    console.log('[GoogleTrends] Page load event fired, waiting for content...');
    
    // Wait for table to load FIRST (longer timeout for slow connections)
    const tableLoaded = await waitForTable(Runtime, 20000);
    
    if (!tableLoaded) {
      // Table didn't load - NOW check if it's because of captcha
      console.log('[GoogleTrends] Table not found, checking for captcha...');
      const captchaCheck = await checkForCaptcha(Runtime);
      
      // Cleanup headless browser
      if (client) {
        try { await client.close(); } catch (e) {}
      }
      if (chromeProcess) {
        chromeProcess.kill();
        chromeProcess = null;
      }
      
      if (captchaCheck.hasCaptcha) {
        console.log('[GoogleTrends] Captcha detected! Type:', captchaCheck.type);
        
        if (showBrowserOnCaptcha) {
          console.log('[GoogleTrends] Reopening browser for captcha solving...');
          
          // Open visible browser for user to solve captcha (fire and forget)
          startVCBrowser(
            GTRENDS_PROFILE,
            fingerprint,
            url,
            null,
            false,  // NOT headless - show the browser
            true
          ).catch(err => console.error('[GoogleTrends] Error opening visible browser:', err));
          
          return {
            success: false,
            error: 'Captcha detected - browser opened for manual solving. Please solve the captcha and try again.',
            captchaDetected: true,
            captchaType: captchaCheck.type,
            browserOpened: true,
            trends: []
          };
        }
        
        return {
          success: false,
          error: 'Captcha detected - please try again later',
          captchaDetected: true,
          captchaType: captchaCheck.type,
          trends: []
        };
      }
      
      // No captcha, but table didn't load - page structure may have changed
      throw new Error('Failed to load trends table - page may have changed structure or is loading slowly. Try again.');
    }
    
    console.log('[GoogleTrends] Table loaded successfully, extracting trends...');
    
    // Extract trends from all pages
    const allTrends = [];
    const seenTitles = new Set();
    let currentPage = 1;
    
    while (currentPage <= maxPages) {
      console.log(`[GoogleTrends] Extracting page ${currentPage}...`);
      
      // Wait a bit for content to settle
      await sleep(1000);
      
      const trends = await extractTrendsFromPage(Runtime);
      console.log(`[GoogleTrends] Found ${trends.length} trends on page ${currentPage}`);
      
      // Add unique trends
      for (const trend of trends) {
        const normalizedTitle = trend.title.toLowerCase().trim();
        if (!seenTitles.has(normalizedTitle)) {
          seenTitles.add(normalizedTitle);
          trend.id = `trend_${allTrends.length}`;
          allTrends.push(trend);
        }
      }
      
      // Check if there are more pages
      const pageInfo = await getPageInfo(Runtime);
      
      if (!pageInfo.hasMore || currentPage >= maxPages) {
        break;
      }
      
      // Go to next page
      const navigated = await clickNextPage(Runtime);
      if (!navigated) {
        break;
      }
      
      // Wait for new content
      await waitForTable(Runtime);
      currentPage++;
    }
    
    console.log(`[GoogleTrends] Total unique trends: ${allTrends.length}`);
    
    // Cache results if we got any
    if (allTrends.length > 0) {
      cacheTrends(cacheKey, allTrends);
    }
    
    // Cleanup
    if (client) {
      try { await client.close(); } catch (e) {}
    }
    if (chromeProcess) {
      chromeProcess.kill();
    }
    
    return {
      success: true,
      trends: allTrends,
      fromCache: false,
      pagesScraped: currentPage,
    };
    
  } catch (error) {
    console.error("[GoogleTrends] Fetch error:", error);
    
    // Cleanup on error
    if (client) {
      try { await client.close(); } catch (e) {}
    }
    if (chromeProcess) {
      chromeProcess.kill();
    }
    
    return {
      success: false,
      error: error.message,
      trends: [],
    };
  }
}

/**
 * Fetch trends with browser visible (for manual interaction/captcha solving)
 */
async function fetchGoogleTrendsVisible(options = {}) {
  const {
    region = "US",
    category = "all",
    hours = 168,
  } = options;
  
  try {
    if (!isVCBrowserInstalled()) {
      return { 
        success: false, 
        error: 'VCBrowser is not installed',
        trends: [] 
      };
    }
    
    const url = buildTrendsUrl(region, category, hours);
    console.log(`[GoogleTrends] Opening browser for: ${url}`);
    
    const fingerprint = getConsistentFingerprintForProfile(GTRENDS_PROFILE);
    
    // Update to VCBrowser's actual version to avoid fingerprint detection
    try {
      const vcVersion = getVCBrowserVersion();
      if (fingerprint.userAgent && vcVersion?.full) {
        fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
      }
    } catch (e) { /* use fallback */ }
    
    // Start visible browser (fire and forget - user will interact manually)
    await startVCBrowser(
      GTRENDS_PROFILE,
      fingerprint,
      url,
      null,
      false,  // NOT headless
      true
    );
    
    // Return only serializable data - browser is open for user interaction
    return {
      success: true,
      browserOpened: true,
      message: 'Browser opened - solve captcha if needed, then use "Fetch Trends" to get data'
    };
    
  } catch (error) {
    console.error("[GoogleTrends] Error opening browser:", error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get available categories
 */
function getCategories() {
  // Proper display names for categories
  const categoryNames = {
    all: "All Categories",
    autos: "Autos & Vehicles",
    beauty: "Beauty & Fashion",
    business: "Business & Finance",
    climate: "Climate",
    entertainment: "Entertainment",
    food: "Food & Drink",
    games: "Games",
    health: "Health",
    hobbies: "Hobbies & Leisure",
    jobs: "Jobs & Education",
    law: "Law & Government",
    other: "Other",
    pets: "Pets & Animals",
    politics: "Politics",
    science: "Science",
    shopping: "Shopping",
    sports: "Sports",
    tech: "Technology",
    travel: "Travel & Transportation",
  };

  return Object.keys(CATEGORY_MAP).map(key => ({
    id: key,
    name: categoryNames[key] || key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
    code: CATEGORY_MAP[key],
  }));
}

/**
 * Get available regions
 */
function getRegions() {
  return Object.keys(REGION_CODES).map(key => ({
    id: key,
    name: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
    code: REGION_CODES[key].code,
  }));
}

/**
 * Get available time ranges
 */
function getTimeRanges() {
  return Object.keys(TIME_RANGES).map(key => ({
    id: key,
    name: key,
    hours: TIME_RANGES[key],
  }));
}

module.exports = {
  fetchGoogleTrends,
  fetchGoogleTrendsVisible,
  getCategories,
  getRegions,
  getTimeRanges,
  CATEGORY_MAP,
  REGION_CODES,
  TIME_RANGES,
};
