// Background script for fingerprint spoofing extension
// Uses registerContentScripts for EARLIEST possible injection into MAIN world

// Register inject.js to run in MAIN world at document_start
// This is the fastest injection method in Manifest V3
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[FP] Extension installed, registering content scripts...');
    
    try {
        // Unregister any existing scripts first
        await chrome.scripting.unregisterContentScripts().catch(() => {});
        
        // Register inject.js to run in MAIN world at document_start
        await chrome.scripting.registerContentScripts([{
            id: 'fingerprint-main',
            matches: ['<all_urls>'],
            js: ['inject.js'],
            runAt: 'document_start',
            world: 'MAIN',
            allFrames: true,
            matchOriginAsFallback: true
        }]);
        
        console.log('[FP] Content script registered for MAIN world injection');
    } catch (e) {
        console.error('[FP] Failed to register content script:', e);
    }
});

// Also register on startup (in case extension was already installed)
chrome.runtime.onStartup.addListener(async () => {
    try {
        await chrome.scripting.unregisterContentScripts().catch(() => {});
        await chrome.scripting.registerContentScripts([{
            id: 'fingerprint-main',
            matches: ['<all_urls>'],
            js: ['inject.js'],
            runAt: 'document_start',
            world: 'MAIN',
            allFrames: true,
            matchOriginAsFallback: true
        }]);
        console.log('[FP] Content script re-registered on startup');
    } catch (e) {}
});

// Backup: Direct injection for tabs that might be missed
async function injectFingerprintScript(tabId, frameId = 0) {
    try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return;
        
        if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
            return;
        }

        await chrome.scripting.executeScript({
            target: { tabId: tabId, frameIds: [frameId] },
            files: ['inject.js'],
            world: 'MAIN',
            injectImmediately: true
        });
    } catch (error) {
        // Silent - expected for some pages
    }
}

// Backup injection via webNavigation
chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (!details.url || details.url.startsWith('chrome://') || details.url.startsWith('chrome-extension://') || details.url.startsWith('about:')) {
        return;
    }
    injectFingerprintScript(details.tabId, details.frameId);
});