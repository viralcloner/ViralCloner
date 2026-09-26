/**
 * Amazon Product Crawler
 * 
 * Opens an Amazon product page using headless VCBrowser via CDP (Chrome DevTools Protocol).
 */

const { spawn } = require('child_process');
const CDP = require('chrome-remote-interface');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager');
const { getConsistentFingerprintForProfile, getLatestChromeVersion } = require('../lib/cdpFingerprint');

/**
 * Semaphore to limit concurrent browser instances
 * This prevents system resource exhaustion when multiple posts run in parallel
 */
const MAX_CONCURRENT_BROWSER = 1;
let activeBrowser = 0;
const browserQueue = [];

function acquireBrowserLock() {
    return new Promise((resolve) => {
        if (activeBrowser < MAX_CONCURRENT_BROWSER) {
            activeBrowser++;
            console.log(`[AmazonCrawl] Browser lock acquired (${activeBrowser}/${MAX_CONCURRENT_BROWSER} active)`);
            resolve();
        } else {
            console.log(`[AmazonCrawl] Browser limit reached, queueing... (${browserQueue.length + 1} waiting)`);
            browserQueue.push(resolve);
        }
    });
}

function releaseBrowserLock() {
    if (browserQueue.length > 0) {
        const next = browserQueue.shift();
        console.log(`[AmazonCrawl] Browser lock passed to next in queue (${browserQueue.length} still waiting)`);
        next();
    } else {
        activeBrowser--;
        console.log(`[AmazonCrawl] Browser lock released (${activeBrowser}/${MAX_CONCURRENT_BROWSER} active)`);
    }
}

/**
 * Opens an Amazon product page using VCBrowser.
 * 
 * @param {string} productUrl - The Amazon product URL to open
 * @param {number} [timeoutMs=60000] - Maximum time to wait for page load
 * @returns {Promise<{success: boolean, value: string, productData?: object}>} - Result with product data or error message
 */
async function openAmazonProduct(productUrl, timeoutMs = 60000) {
    // Acquire semaphore to limit concurrent browser instances
    await acquireBrowserLock();
    
    console.log('[AmazonCrawl] Starting browser for:', productUrl);

    // Validate input
    if (!productUrl) {
        releaseBrowserLock();
        return { success: false, value: "Product URL is required" };
    }
    if (!productUrl.includes('amazon.com')) {
        releaseBrowserLock();
        return { success: false, value: "Invalid Amazon URL" };
    }

    let chromeProcess = null;
    let client = null;
    let lockReleased = false;

    const cleanup = async () => {
        try {
            if (client && !client._disconnected) {
                await client.close().catch(() => {});
            }
        } catch (e) {
            // Ignore cleanup errors
        }
        try {
            if (chromeProcess && !chromeProcess.killed) {
                chromeProcess.kill();
            }
        } catch (e) {
            // Ignore cleanup errors
        }
        // Release the browser semaphore
        if (!lockReleased) {
            lockReleased = true;
            releaseBrowserLock();
        }
    };

    // Safe CDP command execution with connection check
    const safeExecute = async (fn, fallback = null) => {
        try {
            if (!client || client._disconnected) {
                throw new Error('CDP connection lost');
            }
            return await fn();
        } catch (e) {
            if (e.message.includes('WebSocket') || e.message.includes('not open') || e.message.includes('CLOSED')) {
                throw new Error('Browser connection lost - browser may have crashed');
            }
            throw e;
        }
    };

    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const operation = async () => {
        try {
            // Check if VCBrowser is installed
            if (!isVCBrowserInstalled()) {
                await cleanup();
                return { success: false, value: "VCBrowser is not installed" };
            }

            // Generate a consistent fingerprint for Amazon crawling
            const profileName = `amazon_crawl_${Date.now()}`;
            const fingerprint = getConsistentFingerprintForProfile(profileName);
            
            // Update to latest Chrome version
            try {
              const latestVersion = await getLatestChromeVersion();
              if (fingerprint.userAgent && latestVersion?.full) {
                fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${latestVersion.full}`);
              }
            } catch (e) { /* use fallback */ }
            
            console.log('[AmazonCrawl] Launching VCBrowser...');
            
            // Use VCBrowser with headless mode (automationMode=true to auto-grant permissions)
            const result = await startVCBrowser(
                profileName,
                fingerprint,
                'about:blank',
                null,  // no proxy
                true,  // headless
                true   // automationMode - auto-grant permissions
            );
            
            chromeProcess = result.chromeProcess;
            client = result.client;
            const debuggingPort = result.debuggingPort;

            // Monitor browser process for unexpected exits
            chromeProcess.on('exit', (code) => {
                console.log('[AmazonCrawl] Browser process exited with code:', code);
            });

            console.log('[AmazonCrawl] Connected to VCBrowser on port', debuggingPort);

            const { Page, Runtime, Network } = client;
            await safeExecute(() => Page.enable());
            await safeExecute(() => Network.enable());

            // Set USD currency cookies
            console.log('[AmazonCrawl] Setting USD currency cookies...');
            await safeExecute(() => Network.setCookie({
                name: 'i18n-prefs',
                value: 'USD',
                domain: '.amazon.com',
                path: '/',
                secure: true
            }));
            await safeExecute(() => Network.setCookie({
                name: 'lc-main',
                value: 'en_US',
                domain: '.amazon.com',
                path: '/',
                secure: true
            }));

            // First navigate to amazon.com to establish session
            console.log('[AmazonCrawl] Establishing session...');
            await safeExecute(() => Page.navigate({ url: 'https://www.amazon.com/' }));
            await safeExecute(() => Page.loadEventFired());
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Change delivery location to US to ensure product availability
            console.log('[AmazonCrawl] Setting delivery location to US...');
            try {
                const addressChangeResult = await safeExecute(() => Runtime.evaluate({
                    expression: `
                        (async function() {
                            try {
                                const response = await fetch('https://www.amazon.com/portal-migration/hz/glow/address-change?actionSource=glow', {
                                    method: 'POST',
                                    headers: {
                                        'accept': 'text/html,*/*',
                                        'content-type': 'application/json',
                                        'x-requested-with': 'XMLHttpRequest'
                                    },
                                    body: JSON.stringify({
                                        "locationType": "COUNTRY",
                                        "district": "CA",
                                        "countryCode": "US",
                                        "deviceType": "web",
                                        "storeContext": "generic",
                                        "pageType": "Gateway",
                                        "actionSource": "glow"
                                    }),
                                    credentials: 'include'
                                });
                                return { success: response.ok, status: response.status };
                            } catch (e) {
                                return { success: false, error: e.message };
                            }
                        })()
                    `,
                    awaitPromise: true,
                    returnByValue: true
                }));
                console.log('[AmazonCrawl] Address change result:', addressChangeResult.result.value);
            } catch (e) {
                console.log('[AmazonCrawl] Address change failed (continuing):', e.message);
            }

            // Navigate to product URL
            console.log('[AmazonCrawl] Navigating to:', productUrl);
            await safeExecute(() => Page.navigate({ url: productUrl }));
            await safeExecute(() => Page.loadEventFired());

            // Wait for page content to render
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Get the page title to confirm we're on the right page
            const titleResult = await safeExecute(() => Runtime.evaluate({
                expression: 'document.title'
            }));

            const pageTitle = titleResult.result.value || 'Unknown';
            console.log('[AmazonCrawl] Page loaded:', pageTitle);

            // Check if product title is already visible (no popup needed)
            const productTitleCheck = await safeExecute(() => Runtime.evaluate({
                expression: `!!document.getElementById('productTitle')`
            }));
            
            let buttonClicked = false;
            
            // Only look for submit button if product title is not visible (likely a popup is blocking)
            if (!productTitleCheck.result.value) {
                console.log('[AmazonCrawl] Product title not visible, looking for submit button...');
                const maxAttempts = 10;
                const retryDelay = 500;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    const clickResult = await safeExecute(() => Runtime.evaluate({
                        expression: `
                            (function() {
                                // Find button with type="submit" and class "a-button-text"
                                const buttons = document.querySelectorAll('input[type="submit"].a-button-text, button[type="submit"].a-button-text');
                                if (buttons.length > 0) {
                                    buttons[0].click();
                                    return { found: true, text: buttons[0].innerText || buttons[0].value || 'submit button' };
                                }
                                // Also try finding span with class a-button-text inside a submit button
                                const spanButtons = document.querySelectorAll('span.a-button-text');
                                for (const span of spanButtons) {
                                    const parent = span.closest('span.a-button');
                                    if (parent && parent.querySelector('input[type="submit"]')) {
                                        span.click();
                                        return { found: true, text: span.innerText || 'submit button' };
                                    }
                                }
                                return { found: false };
                            })()
                        `
                    }));

                    const result = clickResult.result.value;
                    if (result && result.found) {
                        console.log(`[AmazonCrawl] Button clicked: "${result.text}" (attempt ${attempt})`);
                        buttonClicked = true;
                        break;
                    }

                    // Check if product title appeared (popup dismissed itself)
                    const titleNow = await safeExecute(() => Runtime.evaluate({
                        expression: `!!document.getElementById('productTitle')`
                    }));
                    if (titleNow.result.value) {
                        console.log('[AmazonCrawl] Product title now visible, continuing...');
                        break;
                    }

                    console.log(`[AmazonCrawl] Button not found, retrying... (attempt ${attempt}/${maxAttempts})`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            } else {
                console.log('[AmazonCrawl] Product page ready, no popup detected');
            }

            // Wait for the product page to fully load after clicking
            console.log('[AmazonCrawl] Waiting for product page to load...');
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Scrape product information
            console.log('[AmazonCrawl] Scraping product information...');
            const productInfo = await safeExecute(() => Runtime.evaluate({
                expression: `
                    (function() {
                        const info = {
                            title: '',
                            price: 0,
                            images: [],
                            description: '',
                            features: [],
                            availability: '',
                            rating: '',
                            reviewCount: ''
                        };

                        // Get product title
                        const titleEl = document.getElementById('productTitle') || document.querySelector('.product-title-word-break');
                        if (titleEl) {
                            info.title = titleEl.textContent.trim();
                        }

                        // Get price - try to build from parts first (most reliable)
                        const priceContainer = document.querySelector('.priceToPay, .apexPriceToPay, .reinventPricePriceToPayMargin');
                        if (priceContainer) {
                            const whole = priceContainer.querySelector('.a-price-whole');
                            const fraction = priceContainer.querySelector('.a-price-fraction');
                            if (whole) {
                                let priceStr = whole.textContent.replace(/[^0-9]/g, '').trim();
                                if (fraction) {
                                    priceStr += '.' + fraction.textContent.replace(/[^0-9]/g, '').trim();
                                }
                                info.price = parseFloat(priceStr) || 0;
                            }
                        }
                        
                        // Fallback to offscreen price if not found
                        if (!info.price) {
                            const priceSelectors = [
                                '.priceToPay .a-offscreen',
                                '.apexPriceToPay .a-offscreen',
                                '.reinventPricePriceToPayMargin .a-offscreen',
                                '#corePrice_feature_div .a-offscreen',
                                '#corePriceDisplay_desktop_feature_div .a-offscreen',
                                '.aok-offscreen',
                                '#priceblock_ourprice',
                                '#priceblock_dealprice',
                                '#priceblock_saleprice'
                            ];
                            for (const selector of priceSelectors) {
                                const el = document.querySelector(selector);
                                if (el) {
                                    let priceText = el.textContent.trim();
                                    // Extract only numbers and decimal point
                                    const priceMatch = priceText.match(/[0-9]+[.,]?[0-9]*/);
                                    if (priceMatch) {
                                        // Replace comma with dot for proper float parsing
                                        const priceStr = priceMatch[0].replace(',', '.');
                                        const price = parseFloat(priceStr);
                                        if (price > 0) {
                                            info.price = price;
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        // Get all high-res images from ImageBlockATF script data
                        const imagesFound = new Set();
                        
                        // Find the script containing colorImages data
                        const scripts = document.querySelectorAll('script[type="text/javascript"]');
                        for (const script of scripts) {
                            const content = script.textContent || '';
                            if (content.includes('ImageBlockATF') && content.includes('colorImages')) {
                                // Extract all hiRes URLs directly using regex
                                const hiResMatches = content.matchAll(/"hiRes"\\s*:\\s*"(https:\\/\\/[^"]+)"/g);
                                for (const match of hiResMatches) {
                                    if (match[1] && match[1].startsWith('http')) {
                                        imagesFound.add(match[1]);
                                    }
                                }
                                break;
                            }
                        }
                        
                        // Fallback: try data-old-hires if no images found from script
                        if (imagesFound.size === 0) {
                            const allImagesWithHighRes = document.querySelectorAll('img[data-old-hires]');
                            allImagesWithHighRes.forEach(img => {
                                const highRes = img.getAttribute('data-old-hires');
                                if (highRes && highRes.startsWith('http')) {
                                    imagesFound.add(highRes);
                                }
                            });
                        }
                        
                        info.images = Array.from(imagesFound);

                        // Get product description - try multiple locations
                        const descSelectors = [
                            '#aplus_feature_div',
                            '#productDescription',
                            '#aplus3p_feature_div',
                            '.aplus-v2'
                        ];
                        for (const selector of descSelectors) {
                            const descEl = document.querySelector(selector);
                            if (descEl) {
                                const text = descEl.textContent.trim().replace(/\\s+/g, ' ');
                                if (text.length > 10) {
                                    info.description = text;
                                    break;
                                }
                            }
                        }

                        // Get feature bullets - deduplicate
                        const featureBullets = document.querySelectorAll('#feature-bullets li, #feature-bullets .a-list-item');
                        const featuresSet = new Set();
                        featureBullets.forEach(li => {
                            const text = li.textContent.trim();
                            if (text && !text.includes('Make sure this fits') && text.length > 5) {
                                featuresSet.add(text);
                            }
                        });
                        info.features = Array.from(featuresSet);

                        // Get availability - clean up JSON artifacts
                        const availEl = document.getElementById('availability') || document.querySelector('.availability');
                        if (availEl) {
                            // Get only the text content, not data attributes
                            const availSpan = availEl.querySelector('span');
                            if (availSpan) {
                                info.availability = availSpan.textContent.trim().replace(/\\s+/g, ' ');
                            } else {
                                let availText = availEl.textContent.trim().replace(/\\s+/g, ' ');
                                // Remove any JSON that might be embedded
                                availText = availText.replace(/\\{.*\\}/g, '').trim();
                                info.availability = availText;
                            }
                        }

                        // Get rating
                        const ratingEl = document.querySelector('.a-icon-star .a-icon-alt, #acrPopover .a-icon-alt, .reviewCountTextLinkedHistogram .a-icon-alt');
                        if (ratingEl) {
                            info.rating = ratingEl.textContent.trim();
                        }

                        // Get review count from multiple possible locations
                        const reviewEl = document.getElementById('acrCustomerReviewText');
                        if (reviewEl) {
                            // Try aria-label first, then text content
                            const ariaLabel = reviewEl.getAttribute('aria-label');
                            if (ariaLabel) {
                                info.reviewCount = ariaLabel;
                            } else {
                                info.reviewCount = reviewEl.textContent.trim().replace(/[()]/g, '');
                            }
                        } else {
                            // Fallback to link
                            const reviewLink = document.getElementById('acrCustomerReviewLink');
                            if (reviewLink) {
                                const reviewSpan = reviewLink.querySelector('span');
                                if (reviewSpan) {
                                    const ariaLabel = reviewSpan.getAttribute('aria-label');
                                    info.reviewCount = ariaLabel || reviewSpan.textContent.trim().replace(/[()]/g, '');
                                }
                            }
                        }

                        return info;
                    })()
                `,
                returnByValue: true
            }));

            const scrapedData = productInfo.result.value || {};
            console.log('[AmazonCrawl] Scraped product data:', JSON.stringify(scrapedData, null, 2));

            // Cleanup
            await cleanup();

            return {
                success: true,
                value: `Successfully scraped Amazon product: ${scrapedData.title || pageTitle}`,
                productData: scrapedData
            };

        } catch (error) {
            console.error('[AmazonCrawl] Error:', error.message);
            await cleanup();
            return { success: false, value: `Error opening Amazon page: ${error.message}` };
        }
    };

    try {
        const result = await Promise.race([operation(), timeoutPromise]);
        return result;
    } catch (error) {
        console.error('[AmazonCrawl] Operation failed or timed out:', error.message);
        await cleanup();
        return { success: false, value: error.message };
    } finally {
        // Final safety net - ensure lock is always released
        if (!lockReleased) {
            console.log('[AmazonCrawl] Safety: releasing lock in finally block');
            lockReleased = true;
            releaseChromeLock();
        }
    }
}

module.exports = { openAmazonProduct };
