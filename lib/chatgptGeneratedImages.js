// Self-contained DOM reader, serialized into the active ChatGPT browser page.
function collectGeneratedImages(excludedIds = [], excludedUrls = []) {
    const blockedIds = new Set(excludedIds);
    const blockedUrls = new Set(excludedUrls);
    const seen = new Set();
    const images = [];
    const containers = document.querySelectorAll('div[id^="image-"], [data-testid="generated-image-preview"]');
    for (const container of containers) {
        if (container.closest('[data-message-author-role="user"]')) continue;
        const preview = container.getAttribute('data-testid') === 'generated-image-preview';
        const message = container.closest('[data-message-id], [data-chatgpt-search-message-ids]');
        const messageId = message && (message.getAttribute('data-message-id') || message.getAttribute('data-chatgpt-search-message-ids'));
        const id = container.id || (messageId ? 'message:' + messageId : '');
        if (id && blockedIds.has(id)) continue;
        const candidates = container.querySelectorAll(preview ? 'img' : 'img[src*="estuary/content"]');
        for (const img of candidates) {
            const src = img.currentSrc || img.src || img.getAttribute('src') || '';
            if (!src || (!src.startsWith('blob:https://chatgpt.com/') &&
                !src.startsWith('https://') && !src.startsWith('data:image/'))) continue;
            if (blockedUrls.has(src) || seen.has(src)) continue;
            seen.add(src);
            images.push({
                src, id,
                complete: !!(img.complete && img.naturalWidth > 0 && img.naturalHeight > 0),
                hasOverlay: !preview && !!container.querySelector('[data-testid="image-gen-overlay-actions"]'),
            });
            break;
        }
    }
    const generating = Array.from(document.querySelectorAll(
        'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="stop"], button[aria-label*="Arr"]'
    )).some(button => button.offsetParent !== null);
    return { found: images.length > 0, count: images.length, images, generating };
}

module.exports = { collectGeneratedImages };
