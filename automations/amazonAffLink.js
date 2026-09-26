/**
 * Amazon Affiliate Link Generator
 * 
 * Converts an Amazon product URL to an affiliate link with tracking ID.
 */

/**
 * Converts an Amazon product URL to an affiliate link.
 * 
 * @param {string} productUrl - The Amazon product URL
 * @param {string} trackingId - The Amazon Associates tracking ID (e.g., "mystore-20")
 * @returns {Promise<{success: boolean, value: string}>} - Result with affiliate URL or error message
 */
async function amazonAffLink(productUrl, trackingId) {
    console.log('[AmazonAffLink] Converting URL:', productUrl);
    console.log('[AmazonAffLink] Tracking ID:', trackingId);

    // Validate inputs
    if (!productUrl) {
        return { success: false, value: "Product URL is required" };
    }

    if (!trackingId || trackingId.trim() === '') {
        return { success: false, value: "Amazon tracking ID is required" };
    }

    // Validate it's an Amazon URL
    if (!productUrl.includes('amazon.')) {
        return { success: false, value: "Invalid Amazon URL" };
    }

    try {
        const url = new URL(productUrl);
        
        // Extract the ASIN from the URL
        // ASIN can be found in various URL patterns:
        // /dp/ASIN, /gp/product/ASIN, /product/ASIN, /gp/aw/d/ASIN
        let asin = null;
        
        const asinPatterns = [
            /\/dp\/([A-Z0-9]{10})/i,
            /\/gp\/product\/([A-Z0-9]{10})/i,
            /\/product\/([A-Z0-9]{10})/i,
            /\/gp\/aw\/d\/([A-Z0-9]{10})/i,
            /\/ASIN\/([A-Z0-9]{10})/i
        ];
        
        for (const pattern of asinPatterns) {
            const match = productUrl.match(pattern);
            if (match) {
                asin = match[1];
                break;
            }
        }
        
        if (!asin) {
            return { success: false, value: "Could not extract ASIN from Amazon URL" };
        }
        
        // Build the shortest possible URL: domain + /dp/ASIN + tag
        const affiliateUrl = `https://${url.hostname}/dp/${asin}?tag=${trackingId.trim()}`;
        console.log('[AmazonAffLink] Generated affiliate URL:', affiliateUrl);

        return { success: true, value: affiliateUrl };

    } catch (error) {
        console.error('[AmazonAffLink] Error:', error.message);
        return { success: false, value: `Error processing URL: ${error.message}` };
    }
}

module.exports = { amazonAffLink };
