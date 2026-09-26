/**
 * Image Downloader
 * 
 * Downloads an image from a URL and saves it locally.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { app } = require('electron');

/**
 * Downloads an image from a URL and saves it locally.
 * 
 * @param {string} imageUrl - The URL of the image to download
 * @param {number} [timeoutMs=30000] - Maximum time to wait for download
 * @returns {Promise<{success: boolean, value: string}>} - Result with local file path or error message
 */
async function downloadImage(imageUrl, timeoutMs = 30000) {
    console.log('[ImageDownloader] Downloading:', imageUrl);

    // Validate input
    if (!imageUrl) {
        return { success: false, value: "Image URL is required" };
    }

    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        return { success: false, value: "Invalid URL - must start with http:// or https://" };
    }

    // Create downloads directory
    const downloadsDir = path.join(app.getPath('userData'), 'Downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    
    // Try to extract extension from URL
    let extension = '.jpg';
    const urlPath = new URL(imageUrl).pathname;
    const extMatch = urlPath.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i);
    if (extMatch) {
        extension = extMatch[0].toLowerCase();
    }
    
    const filename = `img_${timestamp}_${randomStr}${extension}`;
    const filePath = path.join(downloadsDir, filename);

    return new Promise((resolve) => {
        const protocol = imageUrl.startsWith('https://') ? https : http;

        const timeoutId = setTimeout(() => {
            resolve({ success: false, value: `Download timed out after ${timeoutMs}ms` });
        }, timeoutMs);

        const request = protocol.get(imageUrl, {
            headers: {
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'max-age=0',
                'sec-ch-ua': '"Google Chrome";v="142", "Chromium";v="142", "Not A(Brand";v="24"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'image',
                'sec-fetch-mode': 'no-cors',
                'sec-fetch-site': 'cross-site',
                'upgrade-insecure-requests': '1',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
            }
        }, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                clearTimeout(timeoutId);
                console.log('[ImageDownloader] Following redirect to:', response.headers.location);
                downloadImage(response.headers.location, timeoutMs).then(resolve);
                return;
            }

            if (response.statusCode !== 200) {
                clearTimeout(timeoutId);
                resolve({ success: false, value: `HTTP error: ${response.statusCode}` });
                return;
            }

            const fileStream = fs.createWriteStream(filePath);
            
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                clearTimeout(timeoutId);
                fileStream.close();
                console.log('[ImageDownloader] Saved to:', filePath);
                resolve({ success: true, value: filePath });
            });

            fileStream.on('error', (err) => {
                clearTimeout(timeoutId);
                fs.unlink(filePath, () => {}); // Delete partial file
                resolve({ success: false, value: `File write error: ${err.message}` });
            });
        });

        request.on('error', (err) => {
            clearTimeout(timeoutId);
            resolve({ success: false, value: `Download error: ${err.message}` });
        });
    });
}

module.exports = { downloadImage };
