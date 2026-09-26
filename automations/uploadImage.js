const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');
const ImageKit = require("imagekit");
const { uploadToR2 } = require('../lib/r2Uploader');

// Timeout management removed - this node has sophisticated queue system with
// built-in retry logic, availability checking, and proper timeout handling

/* ---------------- Global Image Upload Concurrency Queue ---------------- */
let MAX_CONCURRENCY = 1; // Default fallback for image uploads specifically
let UPLOAD_TIMEOUT = 60; // Default timeout in seconds
let activeCount = 0;
const queue = [];

/* ---------------- Per-Workflow Upload Cache ---------------- */
// Cache structure: workflowId -> Map(cacheKey -> result)
// Prevents uploading the same image multiple times in a single workflow
const workflowUploadCache = new Map();

function getCacheKey(provider, filePath) {
    // Create unique key based on provider and file path
    return `${provider}|${filePath}`;
}

// Initialize the image upload concurrency limit from settings
async function initializeConcurrency() {
    try {
        const { readKey } = require('../lib/utils');
        const automationSettings = (await readKey('automationSettings')) || {};

        // Backward compatibility: use dedicated imageUploadMaxConcurrency if available,
        // otherwise default to 1 for safe bandwidth usage
        MAX_CONCURRENCY = automationSettings.imageUploadMaxConcurrency ?? 1;
        UPLOAD_TIMEOUT = automationSettings.imageUploadTimeout ?? 60;

        console.log(`Image Upload concurrency set to: ${MAX_CONCURRENCY} (dedicated setting)`);
        console.log(`Image Upload timeout set to: ${UPLOAD_TIMEOUT}s`);
    } catch (error) {
        console.error('Error loading image upload concurrency settings:', error);
        MAX_CONCURRENCY = 1; // Use safe default for image uploads
        UPLOAD_TIMEOUT = 60; // Use safe default timeout
    }
}

// Initialize on module load
initializeConcurrency();

/** Enqueue a function returning a promise; runs up to MAX_CONCURRENCY in parallel */
function enqueue(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        process.nextTick(runNext);
    });
}

function runNext() {
    if (activeCount >= MAX_CONCURRENCY) return;
    const next = queue.shift();
    if (!next) return;

    activeCount++;
    next.fn()
        .then(next.resolve)
        .catch(next.reject)
        .finally(() => {
            activeCount--;
            // drain as much as possible up to the concurrency cap
            if (queue.length) process.nextTick(runNext);
        });

    // If we still have capacity, spin additional tasks immediately
    while (activeCount < MAX_CONCURRENCY && queue.length) {
        const more = queue.shift();
        activeCount++;
        more.fn()
            .then(more.resolve)
            .catch(more.reject)
            .finally(() => {
                activeCount--;
                if (queue.length) process.nextTick(runNext);
            });
    }
}

/* ---------------- Small retry helper for flaky networks ---------------- */
async function withRetry(task, { retries = 3, baseDelayMs = 800 } = {}) {
    let attempt = 0, lastErr;
    while (attempt <= retries) {
        try {
            return await task();
        } catch (err) {
            lastErr = err;
            if (attempt === retries) break;
            const jitter = Math.floor(Math.random() * 300);
            const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
            await new Promise(r => setTimeout(r, delay));
            attempt++;
        }
    }
    throw lastErr;
}

/* ---------------- Your existing helpers ---------------- */
async function checkImageAvailability(url, maxWaitSeconds = null) {
    // Use configured timeout if maxWaitSeconds not provided
    const timeoutSeconds = maxWaitSeconds || UPLOAD_TIMEOUT;
    const startTime = Date.now();
    const timeout = timeoutSeconds * 1000;
    let attempt = 0;

    while (Date.now() - startTime < timeout) {
        attempt++;
        try {
            console.log(`[Upload] Checking image availability (attempt ${attempt}): ${url}`);

            // Use HEAD request first for faster checking
            try {
                const headRes = await axios.head(url, {
                    timeout: Math.min(UPLOAD_TIMEOUT * 1000, 8000),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
                    }
                });

                if (headRes.status === 200) {
                    const contentType = headRes.headers['content-type'];
                    // Accept if it's an image or if content-type is missing (some CDNs don't set it properly)
                    if (!contentType || contentType.startsWith('image/') || contentType.includes('octet-stream')) {
                        console.log(`[Upload] Image available via HEAD request: ${url}`);
                        return true;
                    }
                }
            } catch (headError) {
                // HEAD request failed, try GET with limited data
                console.log(`[Upload] HEAD request failed, trying GET request...`);
            }

            // Fallback to GET request with limited response size
            const res = await axios.get(url, {
                responseType: 'stream',
                timeout: Math.min(UPLOAD_TIMEOUT * 1000, 10000),
                maxContentLength: 1024 * 1024, // Limit to 1MB to avoid downloading huge files
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
                }
            });

            if (res.status === 200) {
                const contentType = res.headers['content-type'];
                // More permissive content-type checking
                if (!contentType || contentType.startsWith('image/') || contentType.includes('octet-stream') || contentType.includes('binary')) {
                    console.log(`[Upload] Image available via GET request: ${url}`);
                    // Destroy the stream to free up resources
                    res.data.destroy();
                    return true;
                }
            }
        } catch (error) {
            console.log(`[Upload] Attempt ${attempt} failed:`, error.message);
        }

        // Wait before retrying, with increasing delays
        const delay = Math.min(2000 + (attempt * 500), 5000); // Start at 2.5s, max 5s
        console.log(`[Upload] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    console.error(`[Upload] Image not available after ${maxWaitSeconds} seconds: ${url}`);
    return false;
}

/* ---------------- Core upload logic (unchanged behavior) ---------------- */
async function doUpload(provider, api, filePath) {
    const fileName = path.basename(filePath);

    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
        return { success: false, value: "Image path is empty or invalid" };
    }

    // Check if file exists before trying to read it
    if (!fs.existsSync(filePath)) {
        return { success: false, value: `File not found at path: ${filePath}` };
    }

    let imageUrl;

    if (provider === 'imgbb') {
        const [apiKey] = api.split('|');
        const form = new FormData();
        const fileBuffer = fs.readFileSync(filePath);
        form.append('image', fileBuffer.toString('base64'));
        form.append('name', fileName);

        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${apiKey}`, form, {
            headers: form.getHeaders(),
            timeout: UPLOAD_TIMEOUT * 1000,
        });

        imageUrl = response.data?.data?.url;

    } else if (provider === 'cloudinary') {
        const [cloudName, apiKey, apiSecret, uploadPreset] = api.split('|');
        
        console.log('[Cloudinary] Upload attempt:', {
            cloudName,
            apiKey: apiKey ? `${apiKey.substring(0, 6)}...` : 'missing',
            uploadPreset,
            fileName
        });

        // Try unsigned upload first (simpler, no signature needed)
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));
        form.append('upload_preset', uploadPreset);

        try {
            const response = await axios.post(
                `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
                form,
                { 
                    headers: form.getHeaders(), 
                    timeout: UPLOAD_TIMEOUT * 1000,
                    validateStatus: (status) => status < 500 // Don't throw on 4xx
                }
            );

            if (response.status === 200 || response.status === 201) {
                console.log('[Cloudinary] Unsigned upload successful');
                imageUrl = response.data?.secure_url;
            } else {
                // If unsigned fails, try signed upload
                console.log('[Cloudinary] Unsigned upload failed, trying signed upload...');
                throw new Error('Unsigned upload failed, will try signed');
            }
        } catch (unsignedError) {
            // Fallback to signed upload
            console.log('[Cloudinary] Attempting signed upload...');
            
            const timestamp = Math.floor(Date.now() / 1000);
            
            // Cloudinary requires params in alphabetical order
            const paramsToSign = `timestamp=${timestamp}&upload_preset=${uploadPreset}`;
            const signature = crypto.createHash('sha1').update(paramsToSign + apiSecret).digest('hex');

            const signedForm = new FormData();
            signedForm.append('file', fs.createReadStream(filePath));
            signedForm.append('api_key', apiKey);
            signedForm.append('timestamp', timestamp);
            signedForm.append('upload_preset', uploadPreset);
            signedForm.append('signature', signature);

            console.log('[Cloudinary] Signature params:', { timestamp, uploadPreset });

            const signedResponse = await axios.post(
                `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
                signedForm,
                { headers: signedForm.getHeaders(), timeout: UPLOAD_TIMEOUT * 1000 }
            );

            imageUrl = signedResponse.data?.secure_url;
            console.log('[Cloudinary] Signed upload successful');
        }

    } else if (provider === 'imagekit.io') {
        const [publicKey, privateKey, urlEndpoint] = api.split('|');

        const imagekit = new ImageKit({
            publicKey: publicKey,
            privateKey: privateKey,
            urlEndpoint: urlEndpoint
        });

        const fileBuffer = fs.readFileSync(filePath);

        const response = await imagekit.upload({
            file: fileBuffer,
            fileName: fileName
        });

        imageUrl = response.url;

    } else if (provider === 'freeimage.host') {
        const [apiKey] = api.split('|');

        const form = new FormData();
        form.append('key', apiKey);
        form.append('action', 'upload');
        form.append('source', fs.createReadStream(filePath));
        form.append('format', 'json');

        const response = await axios.post(
            `https://freeimage.host/api/1/upload`,
            form,
            { headers: form.getHeaders(), timeout: UPLOAD_TIMEOUT * 1000 }
        );

        imageUrl = response.data?.image?.display_url;

    } else if (provider === 'cloudflare-r2') {
        const r2Result = await uploadToR2(api, filePath, { timeoutMs: UPLOAD_TIMEOUT * 1000 });
        if (!r2Result.success) {
            return { success: false, value: r2Result.error || 'Cloudflare R2 upload failed' };
        }
        // R2 upload is confirmed synchronously by the SDK — skip availability polling.
        return { success: true, value: r2Result.url };

    } else {
        return { success: false, value: "Unsupported provider" };
    }

    const isAvailable = await checkImageAvailability(imageUrl);

    if (!isAvailable) {
        return { success: false, value: `Image not available at URL after ${UPLOAD_TIMEOUT} seconds: ${imageUrl}` };
    }

    return { success: true, value: imageUrl };
}

/* ---------------- Public API: queued + retried uploadImage ---------------- */
async function uploadImage(provider, api, filePath, workflowId = null) {
    // Note: Concurrency settings are initialized on module load and don't need
    // to be refreshed on every call to avoid storage I/O during workflow execution

    // Check cache if workflowId provided
    if (workflowId) {
        const cacheKey = getCacheKey(provider, filePath);

        // Initialize cache for this workflow if it doesn't exist
        if (!workflowUploadCache.has(workflowId)) {
            workflowUploadCache.set(workflowId, new Map());
        }

        const cache = workflowUploadCache.get(workflowId);

        // Return cached result if available
        if (cache.has(cacheKey)) {
            const fileName = path.basename(filePath);
            console.log(`[Upload] ✓ Using cached URL for ${fileName} (workflow: ${workflowId})`);
            return cache.get(cacheKey);
        }
    }

    // Enqueue the whole upload with retries; returns a promise that resolves when its turn completes.
    const result = await enqueue(() =>
        withRetry(() => doUpload(provider, api, filePath), {
            retries: 2,          // total attempts = 3
            baseDelayMs: 1200,   // 1.2s, then ~2.4s (+ jitter)
        })
    );

    // Cache the result if workflowId provided and upload was successful
    if (workflowId && result.success) {
        const cacheKey = getCacheKey(provider, filePath);
        const cache = workflowUploadCache.get(workflowId);
        cache.set(cacheKey, result);

        const fileName = path.basename(filePath);
        console.log(`[Upload] ✓ Cached URL for ${fileName} (workflow: ${workflowId})`);
    }

    return result;
}

/* ---------------- Cache Management ---------------- */
function clearWorkflowCache(workflowId) {
    if (workflowUploadCache.has(workflowId)) {
        const cacheSize = workflowUploadCache.get(workflowId).size;
        workflowUploadCache.delete(workflowId);
        console.log(`[Upload] ✓ Cleared cache for workflow ${workflowId} (${cacheSize} entries)`);
    }
}

module.exports = { uploadImage, clearWorkflowCache };
