// Content script - Backup injection using script.src (CSP-safe)
// Primary injection is handled by background.js using registerContentScripts
(() => {
    'use strict';
    
    try {
        // Use script.src which is CSP-safe (no inline code)
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        script.async = false;
        
        // Insert as first child for earliest execution
        const target = document.documentElement || document.head || document.body;
        if (target) {
            target.insertBefore(script, target.firstChild);
            script.onload = () => script.remove();
            script.onerror = () => script.remove();
        }
    } catch (e) {
        // Silent failure
    }
})();
