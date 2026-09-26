/**
 * Fingerprint Extension - Navigator and Screen Spoofing
 * 
 * This script overrides navigator and screen properties that CDP cannot handle.
 * CDP's Network.setUserAgentOverride only affects userAgent/userAgentData.
 * 
 * We MUST override via JavaScript:
 * - navigator.platform, language, languages
 * - navigator.hardwareConcurrency, deviceMemory
 * - screen.width, height, etc.
 * - navigator.webdriver
 * 
 * We do NOT override (CreepJS detects these):
 * - WebGL getParameter (prototype modification detected)
 * - Canvas toDataURL (noise detected)
 * - Audio context (modifications detected)
 */
(() => {
    'use strict';

    // Prevent double injection
    const injectionKey = Symbol.for('__fp_init__');
    if (window[injectionKey]) return;
    Object.defineProperty(window, injectionKey, {
        value: true,
        writable: false,
        enumerable: false,
        configurable: false
    });

    // Fingerprint config - replaced during extension preparation
    const EMBEDDED_FINGERPRINT = {
        "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        "platform": "Win32",
        "language": "en-US",
        "languages": ["en-US", "en"],
        "screenResolution": { "width": 1920, "height": 1080 },
        "hardwareConcurrency": 8,
        "deviceMemory": 8,
        "colorDepth": 24,
        "pixelDepth": 24,
        "timezone": "America/New_York",
        "doNotTrack": null,
        "cookieEnabled": true,
        "onLine": true
    };

    // Store originals for native-looking functions
    const origFunctionToString = Function.prototype.toString;
    
    // Make overridden functions look native
    const makeNative = (fn, original, name) => {
        const wrapped = function() { return fn.apply(this, arguments); };
        Object.defineProperty(wrapped, 'name', { value: name || original?.name || '' });
        Object.defineProperty(wrapped, 'length', { value: original?.length || 0 });
        Object.defineProperty(wrapped, 'toString', {
            value: function() { return origFunctionToString.call(original || function() {}); }
        });
        return wrapped;
    };

    // =====================================================
    // NAVIGATOR OVERRIDES - Required, CDP doesn't handle these
    // =====================================================
    
    const navigatorProps = {
        platform: EMBEDDED_FINGERPRINT.platform,
        language: EMBEDDED_FINGERPRINT.language,
        languages: Object.freeze([...EMBEDDED_FINGERPRINT.languages]),
        hardwareConcurrency: EMBEDDED_FINGERPRINT.hardwareConcurrency,
        deviceMemory: EMBEDDED_FINGERPRINT.deviceMemory,
        doNotTrack: EMBEDDED_FINGERPRINT.doNotTrack,
        cookieEnabled: EMBEDDED_FINGERPRINT.cookieEnabled,
        onLine: EMBEDDED_FINGERPRINT.onLine,
        maxTouchPoints: 0
    };

    for (const [key, value] of Object.entries(navigatorProps)) {
        try {
            Object.defineProperty(navigator, key, {
                get: function() { return value; },
                enumerable: true,
                configurable: true
            });
        } catch (e) {}
    }

    // =====================================================
    // WEBDRIVER REMOVAL - Critical
    // =====================================================
    
    try { delete Navigator.prototype.webdriver; } catch(e) {}
    try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
            get: function() { return undefined; },
            enumerable: false,
            configurable: true
        });
    } catch(e) {}
    try {
        Object.defineProperty(navigator, 'webdriver', {
            get: function() { return undefined; },
            enumerable: false,
            configurable: true
        });
    } catch(e) {}

    // =====================================================
    // SCREEN OVERRIDES - Required, CDP doesn't handle these
    // =====================================================
    
    const screenWidth = EMBEDDED_FINGERPRINT.screenResolution?.width || 1920;
    const screenHeight = EMBEDDED_FINGERPRINT.screenResolution?.height || 1080;
    const colorDepth = EMBEDDED_FINGERPRINT.colorDepth || 24;
    const pixelDepth = EMBEDDED_FINGERPRINT.pixelDepth || 24;

    const screenProps = {
        width: screenWidth,
        height: screenHeight,
        availWidth: screenWidth,
        availHeight: screenHeight - 40,
        availLeft: 0,
        availTop: 0,
        colorDepth: colorDepth,
        pixelDepth: pixelDepth
    };

    for (const [key, value] of Object.entries(screenProps)) {
        try {
            Object.defineProperty(screen, key, {
                get: function() { return value; },
                enumerable: true,
                configurable: true
            });
        } catch (e) {}
    }

    // Window outer dimensions
    try {
        Object.defineProperty(window, 'outerWidth', {
            get: function() { return screenWidth; },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(window, 'outerHeight', {
            get: function() { return screenHeight; },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(window, 'devicePixelRatio', {
            get: function() { return 1; },
            enumerable: true,
            configurable: true
        });
    } catch (e) {}

    // =====================================================
    // TIMEZONE OVERRIDE
    // =====================================================
    
    const targetTimezone = EMBEDDED_FINGERPRINT.timezone || 'America/New_York';
    
    // Calculate timezone offset
    const calculateOffset = (tz) => {
        try {
            const now = new Date();
            const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
            const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
            return Math.round((utcDate - tzDate) / 60000);
        } catch (e) {
            return 300; // Default EST
        }
    };
    
    const timezoneOffset = calculateOffset(targetTimezone);
    
    const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
        return timezoneOffset;
    };

    // Intl.DateTimeFormat override
    const OrigDTF = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locales, options = {}) {
        options = { ...options, timeZone: targetTimezone };
        return new OrigDTF(locales, options);
    };
    Intl.DateTimeFormat.prototype = OrigDTF.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = OrigDTF.supportedLocalesOf;

    const origResolvedOptions = OrigDTF.prototype.resolvedOptions;
    OrigDTF.prototype.resolvedOptions = function() {
        const result = origResolvedOptions.call(this);
        result.timeZone = targetTimezone;
        return result;
    };

    // =====================================================
    // CHROME OBJECT - Hide Extension
    // =====================================================
    
    if (window.chrome) {
        const cleanChrome = {
            app: {
                isInstalled: false,
                InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                getDetails: function() { return null; },
                getIsInstalled: function() { return false; },
                installState: function(cb) { if(cb) cb('not_installed'); },
                runningState: function() { return 'cannot_run'; }
            },
            csi: function() {
                return { pageT: performance.now(), startE: Date.now() - 500, onloadT: Date.now() - 200, tran: 15 };
            },
            loadTimes: function() {
                const navStart = performance.timing?.navigationStart || Date.now() - 1000;
                return {
                    commitLoadTime: navStart / 1000, connectionInfo: 'h2',
                    finishDocumentLoadTime: (navStart + 100) / 1000, finishLoadTime: (navStart + 500) / 1000,
                    firstPaintAfterLoadTime: 0, firstPaintTime: (navStart + 200) / 1000,
                    navigationType: 'navigate', npnNegotiatedProtocol: 'unknown',
                    requestTime: (navStart + 50) / 1000, startLoadTime: navStart / 1000,
                    wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true
                };
            }
        };
        
        try {
            Object.defineProperty(window, 'chrome', {
                get: () => cleanChrome,
                set: () => {},
                enumerable: true,
                configurable: true
            });
        } catch(e) {}
    }

    // =====================================================
    // PLUGINS - Empty but proper structure
    // =====================================================
    
    try {
        const fakePlugins = {
            length: 0,
            item: function(i) { return null; },
            namedItem: function(n) { return null; },
            refresh: function() {},
            [Symbol.iterator]: function*() {}
        };
        Object.setPrototypeOf(fakePlugins, PluginArray.prototype);
        
        Object.defineProperty(navigator, 'plugins', {
            get: function() { return fakePlugins; },
            enumerable: true,
            configurable: true
        });
    } catch (e) {}

    try {
        const fakeMimeTypes = {
            length: 0,
            item: function(i) { return null; },
            namedItem: function(n) { return null; },
            [Symbol.iterator]: function*() {}
        };
        Object.setPrototypeOf(fakeMimeTypes, MimeTypeArray.prototype);
        
        Object.defineProperty(navigator, 'mimeTypes', {
            get: function() { return fakeMimeTypes; },
            enumerable: true,
            configurable: true
        });
    } catch (e) {}

    // =====================================================
    // WEBRTC IP LEAK PREVENTION
    // =====================================================
    
    const OrigRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OrigRTC) {
        window.RTCPeerConnection = new Proxy(OrigRTC, {
            construct(target, args) {
                const config = args[0] || {};
                if (config.iceServers) {
                    config.iceServers = config.iceServers.filter(s => {
                        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
                        return urls.some(u => u && u.startsWith('turn:'));
                    });
                }
                config.iceCandidatePoolSize = 0;
                const pc = new target(config);
                const origAdd = pc.addIceCandidate.bind(pc);
                pc.addIceCandidate = function(c) {
                    if (c?.candidate?.includes('192.168.') || c?.candidate?.includes('10.')) {
                        return Promise.resolve();
                    }
                    return origAdd(c);
                };
                return pc;
            }
        });
        if (window.webkitRTCPeerConnection) {
            window.webkitRTCPeerConnection = window.RTCPeerConnection;
        }
    }

    // =====================================================
    // NOTE: We do NOT override WebGL/Canvas/Audio
    // CreepJS detects prototype modifications as "lies"
    // Those will show real hardware values
    // =====================================================

    console.log('[Fingerprint] Applied - navigator, screen, timezone spoofed');
})();
