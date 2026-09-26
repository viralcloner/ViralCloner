const fetch = require('node-fetch');
const { readKey } = require('../lib/utils');
const crypto = require('crypto');

async function getTimeoutFromSettings(settingName, defaultSeconds) {
    try {
        const automationSettings = (await readKey('automationSettings')) || {};
        return (automationSettings[settingName] || defaultSeconds) * 1000; // Convert to milliseconds
    } catch (error) {
        console.error(`Error reading timeout setting ${settingName}:`, error);
        return defaultSeconds * 1000; // Return default in milliseconds
    }
}

function withNodeTimeout(promise, timeoutMs, nodeType) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${nodeType} operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        promise
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timer));
    });
}

function slugify(text) {
    return text
        .toString()
        .normalize("NFD")                   // normalize accents
        .replace(/[\u0300-\u036f]/g, "")    // remove diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')        // replace non-alphanumeric with -
        .replace(/^-+|-+$/g, '')            // trim -
        .substring(0, 50);                  // keep reasonable length
}

async function uploadImageToWP(apiUrl, auth, imageUrl, title) {
    try {
        const imgResponse = await fetch(imageUrl);
        if (!imgResponse.ok) return null;

        const buffer = await imgResponse.buffer();
        const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
        const ext = contentType.split("/")[1] || "jpg";

        const randomStr = crypto.randomBytes(3).toString("hex");
        const slug = slugify(title) || "image";
        const fileName = `${slug}-${randomStr}.${ext}`;

        const uploadResponse = await fetch(`${apiUrl}/media`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Content-Type': contentType
            },
            body: buffer
        });

        if (!uploadResponse.ok) return null;
        const uploaded = await uploadResponse.json();
        return { id: uploaded.id || null, url: uploaded.source_url || null };
    } catch {
        return null;
    }
}

async function uploadContentImages(apiUrl, auth, htmlContent, title) {
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const seen = new Map();
    let match;

    while ((match = imgRegex.exec(htmlContent)) !== null) {
        const originalUrl = match[1];
        if (!seen.has(originalUrl)) {
            seen.set(originalUrl, null);
        }
    }

    for (const [originalUrl] of seen) {
        const result = await uploadImageToWP(apiUrl, auth, originalUrl, title);
        if (result && result.url) {
            seen.set(originalUrl, result.url);
        }
    }

    let updatedContent = htmlContent;
    for (const [originalUrl, wpUrl] of seen) {
        if (wpUrl) {
            while (updatedContent.includes(originalUrl)) {
                updatedContent = updatedContent.replace(originalUrl, wpUrl);
            }
        }
    }

    return updatedContent;
}

async function wordPress(wordpressId, title, htmlContent, imageUrl = null, categoriesRaw = "") {
    const operation = async () => {
        const wordpressSites = (await readKey('wordpressSites')) || {};
        const wpCredentials = wordpressSites[wordpressId] || null;
        if (!wpCredentials) return false;

    const baseUrl = wpCredentials.url.replace(/\/$/, '');
    const apiUrl = `${baseUrl}/wp-json/wp/v2`;
    const auth = Buffer.from(`${wpCredentials.username}:${wpCredentials.appPassword}`).toString('base64');

    let featuredMediaId = null;
    if (imageUrl) {
        const featuredResult = await uploadImageToWP(apiUrl, auth, imageUrl, title);
        if (featuredResult) featuredMediaId = featuredResult.id;
    }

    // Parse category IDs from comma-separated string
    const categories = categoriesRaw
        ? categoriesRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0)
        : [];

    // Upload all images found in the HTML content to WordPress media library
    let finalContent = await uploadContentImages(apiUrl, auth, htmlContent, title);

    try {
        const response = await fetch(`${apiUrl}/posts`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: title,
                content: finalContent,
                status: 'publish',
                ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
                ...(categories.length > 0 ? { categories } : {})
            })
        });

        if (!response.ok) return false;
        const result = await response.json();
        if (result.link) {
            return { success: true, value: result.link };
        } else {
            return { success: false, value: "" };
        }
    } catch {
        return { success: false, value: "" };
    }
    };

    const timeoutMs = await getTimeoutFromSettings('wordpressTimeout', 600);
    return withNodeTimeout(operation(), timeoutMs, 'WordPress');
}

module.exports = { wordPress };