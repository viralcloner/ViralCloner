const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');
const ImageKit = require("imagekit");
const { uploadToR2 } = require('../lib/r2Uploader');

/* ---------------- Global Video Upload Concurrency Queue ---------------- */
let MAX_CONCURRENCY = 1;
let UPLOAD_TIMEOUT = 120; // Longer default for video
let activeCount = 0;
const queue = [];

/* ---------------- Per-Workflow Upload Cache ---------------- */
const workflowUploadCache = new Map();

function getCacheKey(provider, filePath) {
    return `${provider}|${filePath}`;
}

async function initializeConcurrency() {
    try {
        const { readKey } = require('../lib/utils');
        const automationSettings = (await readKey('automationSettings')) || {};
        MAX_CONCURRENCY = automationSettings.videoUploadMaxConcurrency ?? 1;
        UPLOAD_TIMEOUT = automationSettings.videoUploadTimeout ?? 120;
        console.log(`Video Upload concurrency set to: ${MAX_CONCURRENCY}`);
        console.log(`Video Upload timeout set to: ${UPLOAD_TIMEOUT}s`);
    } catch (error) {
        console.error('Error loading video upload concurrency settings:', error);
        MAX_CONCURRENCY = 1;
        UPLOAD_TIMEOUT = 120;
    }
}

initializeConcurrency();

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
            if (queue.length) process.nextTick(runNext);
        });

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

async function checkVideoAvailability(url, maxWaitSeconds = null) {
    const timeoutSeconds = maxWaitSeconds || UPLOAD_TIMEOUT;
    const startTime = Date.now();
    const timeout = timeoutSeconds * 1000;
    let attempt = 0;

    while (Date.now() - startTime < timeout) {
        attempt++;
        try {
            console.log(`[VideoUpload] Checking video availability (attempt ${attempt}): ${url}`);

            try {
                const headRes = await axios.head(url, {
                    timeout: Math.min(UPLOAD_TIMEOUT * 1000, 10000),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
                    }
                });
                if (headRes.status === 200) {
                    const contentType = headRes.headers['content-type'];
                    if (!contentType || contentType.startsWith('video/') || contentType.includes('octet-stream')) {
                        console.log(`[VideoUpload] Video available via HEAD request: ${url}`);
                        return true;
                    }
                }
            } catch (headError) {
                console.log(`[VideoUpload] HEAD request failed, trying GET request...`);
            }

            const res = await axios.get(url, {
                responseType: 'stream',
                timeout: Math.min(UPLOAD_TIMEOUT * 1000, 15000),
                maxContentLength: 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
                }
            });

            if (res.status === 200) {
                const contentType = res.headers['content-type'];
                if (!contentType || contentType.startsWith('video/') || contentType.includes('octet-stream') || contentType.includes('binary')) {
                    console.log(`[VideoUpload] Video available via GET request: ${url}`);
                    res.data.destroy();
                    return true;
                }
            }
        } catch (error) {
            console.log(`[VideoUpload] Attempt ${attempt} failed:`, error.message);
        }

        const delay = Math.min(3000 + (attempt * 1000), 8000);
        console.log(`[VideoUpload] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    console.error(`[VideoUpload] Video not available after ${timeoutSeconds} seconds: ${url}`);
    return false;
}

/* ---------------- Core upload logic ---------------- */
async function doUpload(provider, api, filePath) {
    const fileName = path.basename(filePath);

    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
        return { success: false, value: "Video path is empty or invalid" };
    }

    if (!fs.existsSync(filePath)) {
        return { success: false, value: `File not found at path: ${filePath}` };
    }

    let videoUrl;

    if (provider === 'cloudinary') {
        const [cloudName, apiKey, apiSecret, uploadPreset] = api.split('|');

        console.log('[Cloudinary Video] Upload attempt:', {
            cloudName,
            apiKey: apiKey ? `${apiKey.substring(0, 6)}...` : 'missing',
            uploadPreset,
            fileName
        });

        // Use /video/upload endpoint for Cloudinary
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));
        form.append('upload_preset', uploadPreset);
        form.append('resource_type', 'video');

        try {
            const response = await axios.post(
                `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
                form,
                {
                    headers: form.getHeaders(),
                    timeout: UPLOAD_TIMEOUT * 1000,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    validateStatus: (status) => status < 500
                }
            );

            if (response.status === 200 || response.status === 201) {
                console.log('[Cloudinary Video] Unsigned upload successful');
                videoUrl = response.data?.secure_url;
            } else {
                throw new Error('Unsigned upload failed, will try signed');
            }
        } catch (unsignedError) {
            console.log('[Cloudinary Video] Attempting signed upload...');

            const timestamp = Math.floor(Date.now() / 1000);
            const paramsToSign = `timestamp=${timestamp}&upload_preset=${uploadPreset}`;
            const signature = crypto.createHash('sha1').update(paramsToSign + apiSecret).digest('hex');

            const signedForm = new FormData();
            signedForm.append('file', fs.createReadStream(filePath));
            signedForm.append('api_key', apiKey);
            signedForm.append('timestamp', timestamp);
            signedForm.append('upload_preset', uploadPreset);
            signedForm.append('signature', signature);
            signedForm.append('resource_type', 'video');

            const signedResponse = await axios.post(
                `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
                signedForm,
                {
                    headers: signedForm.getHeaders(),
                    timeout: UPLOAD_TIMEOUT * 1000,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );

            videoUrl = signedResponse.data?.secure_url;
            console.log('[Cloudinary Video] Signed upload successful');
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
            fileName: fileName,
            tags: ["video"]
        });

        videoUrl = response.url;

    } else if (provider === 'streamable') {
        // Streamable - free video hosting with API
        // API key format: "email|password" (basic auth)
        const [email, password] = api.split('|');

        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));

        const response = await axios.post(
            'https://api.streamable.com/upload',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                },
                auth: { username: email, password: password },
                timeout: UPLOAD_TIMEOUT * 1000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        const shortcode = response.data?.shortcode;
        if (!shortcode) {
            return { success: false, value: "Streamable upload failed - no shortcode returned" };
        }

        // Wait for processing and get the video URL
        let processingAttempts = 0;
        const maxProcessingAttempts = Math.floor(UPLOAD_TIMEOUT / 3);
        while (processingAttempts < maxProcessingAttempts) {
            const statusRes = await axios.get(`https://api.streamable.com/videos/${shortcode}`, {
                auth: { username: email, password: password },
                timeout: 10000
            });

            if (statusRes.data?.status === 2) {
                // Status 2 = ready
                videoUrl = `https://streamable.com/${shortcode}`;
                const directUrl = statusRes.data?.files?.mp4?.url;
                if (directUrl) {
                    videoUrl = directUrl.startsWith('//') ? `https:${directUrl}` : directUrl;
                }
                break;
            } else if (statusRes.data?.status === 3) {
                return { success: false, value: "Streamable video processing failed" };
            }

            processingAttempts++;
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        if (!videoUrl) {
            return { success: false, value: "Streamable video processing timed out" };
        }

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

    const isAvailable = await checkVideoAvailability(videoUrl);

    if (!isAvailable) {
        return { success: false, value: `Video not available at URL after ${UPLOAD_TIMEOUT} seconds: ${videoUrl}` };
    }

    return { success: true, value: videoUrl };
}

/* ---------------- Public API: queued + retried uploadVideo ---------------- */
async function uploadVideo(provider, api, filePath, workflowId = null) {
    if (workflowId) {
        const cacheKey = getCacheKey(provider, filePath);

        if (!workflowUploadCache.has(workflowId)) {
            workflowUploadCache.set(workflowId, new Map());
        }

        const cache = workflowUploadCache.get(workflowId);

        if (cache.has(cacheKey)) {
            const fileName = path.basename(filePath);
            console.log(`[VideoUpload] ✓ Using cached URL for ${fileName} (workflow: ${workflowId})`);
            return cache.get(cacheKey);
        }
    }

    const result = await enqueue(() =>
        withRetry(() => doUpload(provider, api, filePath), {
            retries: 2,
            baseDelayMs: 1500,
        })
    );

    if (workflowId && result.success) {
        const cacheKey = getCacheKey(provider, filePath);
        const cache = workflowUploadCache.get(workflowId);
        cache.set(cacheKey, result);

        const fileName = path.basename(filePath);
        console.log(`[VideoUpload] ✓ Cached URL for ${fileName} (workflow: ${workflowId})`);
    }

    return result;
}

function clearWorkflowCache(workflowId) {
    if (workflowUploadCache.has(workflowId)) {
        const cacheSize = workflowUploadCache.get(workflowId).size;
        workflowUploadCache.delete(workflowId);
        console.log(`[VideoUpload] ✓ Cleared cache for workflow ${workflowId} (${cacheSize} entries)`);
    }
}

module.exports = { uploadVideo, clearWorkflowCache };
