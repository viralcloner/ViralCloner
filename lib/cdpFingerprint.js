/**
 * CDP-based Fingerprint Injection Module
 * 
 * Ported from test-spoofer.js - Uses CDP to inject fingerprint spoofing
 * including WebGL spoofing in Service Workers via Fetch interception.
 * 
 * This is the SINGLE SOURCE OF TRUTH for:
 * - All fingerprint operations
 * - All Target.attachedToTarget handling (to prevent race conditions)
 * - Chrome identity application (UA, locale, timezone)
 */

const fs = require('fs').promises;
const path = require('path');
const { app, screen } = require('electron');
const os = require('os');
const axios = require('axios');

// Cache for stable Chrome version to avoid repeated API calls
let cachedChromeVersion = null;
let cachedChromeVersionTimestamp = 0;
const CHROME_VERSION_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week

/**
 * Get the latest stable Chrome version from Google's public API
 * Results are cached for 6 hours to avoid excessive API calls
 */
async function getLatestChromeVersion() {
    // Return cached version if still valid
    if (cachedChromeVersion && (Date.now() - cachedChromeVersionTimestamp < CHROME_VERSION_CACHE_TTL)) {
        return cachedChromeVersion;
    }
    
    try {
        const { data } = await axios.get(
            "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json",
            { timeout: 7000 }
        );
        const full = data.channels.Stable.version;
        const major = String(full).split(".")[0] || "138";
        cachedChromeVersion = { major, full };
        cachedChromeVersionTimestamp = Date.now();
        console.log(`[CDP Fingerprint] Fetched latest Chrome version: ${full}`);
        return cachedChromeVersion;
    } catch (err) {
        console.warn(`[CDP Fingerprint] Failed to fetch Chrome version: ${err.message}, using fallback`);
        // Fallback to VCBrowser version
        return { major: "142", full: "142.0.0.0" };
    }
}

/**
 * Get the VCBrowser installed version from vcbrowser.env.json
 * This should be used for fingerprint spoofing to match the actual browser version
 * and avoid fingerprint detection (e.g., Iphey UA mismatch warnings)
 */
function getVCBrowserVersion() {
    try {
      const fs = require('fs'), path = require('path');
      const directory = require('./browserPaths').getVCBrowserDirectory();
      const full = fs.readdirSync(directory).find(name => /^\d+\.\d+\.\d+\.\d+$/.test(name));
      if (full) return { major: full.split('.')[0], full };
      const version = fs.readFileSync(path.join(directory, 'version.txt'), 'utf8').trim().replace(/^v/, '');
      if (/^\d+(?:\.\d+){0,3}$/.test(version)) return { major: version.split('.')[0], full: version.includes('.') ? version : version + '.0.0.0' };
    } catch (_) {}
    const version = require('../data/vcbrowser.env.json').VCBROWSER_VERSION;
    return { major: String(version), full: version + '.0.0.0' };
  }

// ============================================================================
// CHROME IDENTITY FUNCTIONS (moved from utils.js for unified target handling)
// ============================================================================

/**
 * Build Chrome Client Hints metadata
 */
function buildChromeCH(major, full) {
    return {
        brands: [
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major },
            { brand: 'Not)A;Brand', version: '99' }
        ],
        fullVersion: full,
        fullVersionList: [
            { brand: 'Chromium', version: full },
            { brand: 'Google Chrome', version: full },
            { brand: 'Not)A;Brand', version: '99.0.0.0' }
        ],
        platform: 'Windows',
        platformVersion: '10.0.0',
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false
    };
}

/**
 * Apply Chrome identity (UA, locale, timezone) to a CDP session
 * This sets Network.setUserAgentOverride and Emulation overrides
 */
async function applyChromeIdentityOnSession(client, sessionId, {
    major,
    full,
    locale,
    tz,
    acceptLanguage
} = {}) {
    if (!major || !full) return;
    
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
    try { await client.send('Network.enable', {}, sessionId); } catch { }
    try {
        await client.send('Network.setUserAgentOverride', {
            userAgent,
            acceptLanguage,
            platform: 'Windows',
            userAgentMetadata: buildChromeCH(major, full)
        }, sessionId);
    } catch { }
    try { await client.send('Emulation.setLocaleOverride', { locale }, sessionId); } catch { }
    try { await client.send('Emulation.setTimezoneOverride', { timezoneId: tz }, sessionId); } catch { }
}

// ============================================================================
// FINGERPRINT GENERATION FUNCTIONS
// ============================================================================

/**
 * Get real machine hardware info for fingerprint generation
 * Used when fingerprint is set to use real machine values
 */
function getRealMachineFingerprint(version = null) {
    // Get real system information
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const platform = os.platform();

    // Convert to browser-compatible values
    const hardwareConcurrency = cpus.length;
    // Round device memory to nearest power of 2 for consistency (common values: 4, 8, 16, 32)
    let deviceMemory = Math.round(totalMemory / (1024 * 1024 * 1024));
    const powerOf2 = [1, 2, 4, 8, 16, 32];
    deviceMemory = powerOf2.reduce((prev, curr) => (Math.abs(curr - deviceMemory) < Math.abs(prev - deviceMemory) ? curr : prev));

    // Get primary display resolution
    const primaryDisplay = screen.getPrimaryDisplay();
    const screenResolution = {
        width: primaryDisplay.bounds.width,
        height: primaryDisplay.bounds.height
    };

    // Determine platform string
    let browserPlatform = "Win32";
    if (platform === "darwin") browserPlatform = "MacIntel";
    else if (platform === "linux") browserPlatform = "Linux x86_64";

    // Standard WebGL renderer based on system - use consistent values
    let webglVendor = "Google Inc. (Intel)";
    let webglRenderer = "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";

    // Adjust based on hardware concurrency for more realistic WebGL values
    if (hardwareConcurrency >= 16) {
        webglVendor = "Google Inc. (NVIDIA)";
        webglRenderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    } else if (hardwareConcurrency >= 12) {
        webglVendor = "Google Inc. (NVIDIA)";
        webglRenderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    } else if (hardwareConcurrency >= 8) {
        webglVendor = "Google Inc. (Intel)";
        webglRenderer = "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    }

    // Platform-specific font lists
    let fontList;
    if (platform === "win32") {
        fontList = [
            "Arial", "Arial Black", "Calibri", "Cambria", "Comic Sans MS",
            "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console",
            "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"
        ];
    } else if (platform === "darwin") {
        fontList = [
            ".AppleSystemUIFont", "Arial", "Arial Black", "Courier", "Courier New",
            "Geneva", "Georgia", "Helvetica", "Helvetica Neue", "Monaco",
            "Palatino", "Times", "Times New Roman", "Verdana"
        ];
    } else {
        fontList = [
            "DejaVu Sans", "DejaVu Sans Mono", "DejaVu Serif", "FreeMono",
            "FreeSans", "FreeSerif", "Liberation Mono", "Liberation Sans", "Liberation Serif"
        ];
    }

    // Use the real machine's timezone for authentic fingerprinting
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Use consistent version with the browser (use cached version if available)
    const chromeVersion = version?.full || cachedChromeVersion?.full || '142.0.0.0';

    return {
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
        platform: browserPlatform,
        language: "en-US",
        languages: ["en-US", "en"],
        hardwareConcurrency: hardwareConcurrency,
        deviceMemory: deviceMemory,
        screenResolution: screenResolution,
        timezone: timezone,
        webgl: {
            vendor: webglVendor,
            renderer: webglRenderer
        },
        canvas: "REAL_MACHINE",
        audioContext: "REAL_MACHINE",
        fonts: fontList,
        plugins: [],
        cookieEnabled: true,
        onLine: true,
        colorDepth: primaryDisplay.colorDepth || 24,
        pixelDepth: primaryDisplay.colorDepth || 24,
        doNotTrack: null,
        maxTouchPoints: platform === "win32" ? 0 : 0
    };
}

/**
 * Generate a truly random but realistic fingerprint for a new profile
 * This creates diverse fingerprints that don't look spoofed
 * Each call generates a completely new fingerprint
 * 
 * Note: If version is not provided, uses cached Chrome version if available
 */
function generateRandomRealisticFingerprint(version = null) {
    // Use cached version if available and version not explicitly provided
    const chromeVersion = version?.full || cachedChromeVersion?.full || '142.0.0.0';
    const chromeMajor = chromeVersion.split('.')[0];
    
    // Realistic Windows desktop configurations (most common setups)
    const windowsConfigs = [
        // High-end gaming/workstation PCs
        { cpu: 16, mem: 32, screen: { width: 2560, height: 1440 }, gpu: 'nvidia-high' },
        { cpu: 12, mem: 32, screen: { width: 2560, height: 1440 }, gpu: 'nvidia-high' },
        { cpu: 8, mem: 32, screen: { width: 2560, height: 1440 }, gpu: 'nvidia-high' },
        { cpu: 16, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-high' },
        { cpu: 12, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-mid' },
        // Mid-range PCs
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-mid' },
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'amd-mid' },
        { cpu: 6, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-mid' },
        { cpu: 8, mem: 8, screen: { width: 1920, height: 1080 }, gpu: 'intel-integrated' },
        { cpu: 4, mem: 8, screen: { width: 1920, height: 1080 }, gpu: 'intel-integrated' },
        // Laptops
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-laptop' },
        { cpu: 8, mem: 8, screen: { width: 1920, height: 1080 }, gpu: 'intel-integrated' },
        { cpu: 4, mem: 8, screen: { width: 1366, height: 768 }, gpu: 'intel-integrated' },
        { cpu: 4, mem: 8, screen: { width: 1536, height: 864 }, gpu: 'intel-integrated' },
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1200 }, gpu: 'intel-integrated' },
        // Budget PCs
        { cpu: 4, mem: 4, screen: { width: 1366, height: 768 }, gpu: 'intel-old' },
        { cpu: 2, mem: 4, screen: { width: 1366, height: 768 }, gpu: 'intel-old' },
    ];
    
    // GPU configurations (realistic ANGLE strings)
    const gpuConfigs = {
        'nvidia-high': [
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'nvidia-mid': [
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Super Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'nvidia-laptop': [
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'amd-mid': [
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'intel-integrated': [
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'intel-old': [
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 530 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 4600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
    };
    
    // Windows font sets (realistic combinations)
    const fontSets = [
        // Standard Windows 10/11 fonts
        ["Arial", "Arial Black", "Calibri", "Cambria", "Cambria Math", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Microsoft Sans Serif", "Segoe UI", "Segoe UI Symbol", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Wingdings"],
        // Windows with Office installed
        ["Arial", "Arial Black", "Calibri", "Calibri Light", "Cambria", "Cambria Math", "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Franklin Gothic Medium", "Georgia", "Impact", "Lucida Console", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"],
        // Minimal Windows fonts
        ["Arial", "Calibri", "Consolas", "Courier New", "Georgia", "Segoe UI", "Tahoma", "Times New Roman", "Verdana"],
        // Windows with additional software
        ["Arial", "Arial Black", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings", "Wingdings 2", "Wingdings 3"],
    ];
    
    // Random selection helpers
    const randomPick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    
    // Select a random config
    const config = randomPick(windowsConfigs);
    const gpuOptions = gpuConfigs[config.gpu];
    const gpu = randomPick(gpuOptions);
    const fonts = randomPick(fontSets);
    
    // Generate a unique canvas fingerprint pattern (12 random bytes)
    const canvasPattern = Array.from({ length: 12 }, () => randomInt(0, 255));
    
    // Generate audio fingerprint noise
    const audioNoise = Math.random() * 0.0001;
    
    // User agent with current Chrome version
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    
    // Most users don't enable DoNotTrack (only ~5%)
    const doNotTrack = Math.random() > 0.95 ? "1" : null;
    
    // Touch support (rare on desktops, ~10% for touchscreen monitors)
    const maxTouchPoints = Math.random() > 0.9 ? 10 : 0;
    
    return {
        userAgent: userAgent,
        platform: "Win32",
        language: "en-US", // Will be overridden by user's language preference
        languages: ["en-US", "en"], // Will be overridden by user's language preference
        hardwareConcurrency: config.cpu,
        deviceMemory: config.mem,
        screenResolution: config.screen,
        timezone: "America/New_York", // Will be overridden by IP geolocation
        webgl: gpu,
        canvas: {
            pattern: canvasPattern,
            noise: "UNIQUE"
        },
        audioContext: {
            noise: audioNoise,
            type: "UNIQUE"
        },
        fonts: fonts,
        plugins: [],
        cookieEnabled: true,
        onLine: true,
        colorDepth: 24,
        pixelDepth: 24,
        doNotTrack: doNotTrack,
        maxTouchPoints: maxTouchPoints,
        // Additional fingerprint randomization
        clientRects: randomInt(1, 5),
        webglParams: {
            maxTextureSize: randomPick([8192, 16384, 32768]),
            maxViewportDims: randomPick([[16384, 16384], [32768, 32768]]),
            maxRenderbufferSize: randomPick([8192, 16384, 32768]),
            maxVertexAttribs: randomPick([16, 32]),
            maxVertexUniformVectors: randomPick([1024, 4096]),
            maxFragmentUniformVectors: randomPick([1024, 4096]),
            aliasedLineWidthRange: [1, 1],
            aliasedPointSizeRange: randomPick([[1, 1024], [1, 2048]]),
        }
    };
}

/**
 * Generate a consistent fingerprint for a profile based on profile name hash
 * This ensures the same profile always gets the same fingerprint
 * Uses the same realistic configurations as generateRandomRealisticFingerprint
 * but with deterministic selection based on profile name
 * 
 * Note: This is a sync function. If version is not provided, it uses the cached
 * Chrome version if available, otherwise falls back to 142.0.0.0
 */
function getConsistentFingerprintForProfile(profileName, version = null) {
    // Use cached version if available and version not explicitly provided
    const chromeVersion = version?.full || cachedChromeVersion?.full || '142.0.0.0';
    
    // Create a deterministic seed based on profile name
    let hash = 0;
    for (let i = 0; i < profileName.length; i++) {
        hash = ((hash << 5) - hash + profileName.charCodeAt(i)) & 0x7fffffff;
    }

    // Use hash to create a consistent pseudo-random generator
    const seedRandom = (seed) => {
        let state = seed % 2147483647;
        if (state <= 0) state += 2147483646;
        return () => {
            state = state * 16807 % 2147483647;
            return (state - 1) / 2147483646;
        };
    };

    const rng = seedRandom(hash);
    const seededPick = (arr) => arr[Math.floor(rng() * arr.length)];
    const seededInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
    
    // Same realistic configurations as generateRandomRealisticFingerprint
    const windowsConfigs = [
        { cpu: 16, mem: 32, screen: { width: 2560, height: 1440 }, gpu: 'nvidia-high' },
        { cpu: 12, mem: 32, screen: { width: 2560, height: 1440 }, gpu: 'nvidia-high' },
        { cpu: 8, mem: 32, screen: { width: 2560, height: 1440 }, gpu: 'nvidia-high' },
        { cpu: 16, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-high' },
        { cpu: 12, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-mid' },
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-mid' },
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'amd-mid' },
        { cpu: 6, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-mid' },
        { cpu: 8, mem: 8, screen: { width: 1920, height: 1080 }, gpu: 'intel-integrated' },
        { cpu: 4, mem: 8, screen: { width: 1920, height: 1080 }, gpu: 'intel-integrated' },
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1080 }, gpu: 'nvidia-laptop' },
        { cpu: 8, mem: 8, screen: { width: 1920, height: 1080 }, gpu: 'intel-integrated' },
        { cpu: 4, mem: 8, screen: { width: 1366, height: 768 }, gpu: 'intel-integrated' },
        { cpu: 4, mem: 8, screen: { width: 1536, height: 864 }, gpu: 'intel-integrated' },
        { cpu: 8, mem: 16, screen: { width: 1920, height: 1200 }, gpu: 'intel-integrated' },
        { cpu: 4, mem: 4, screen: { width: 1366, height: 768 }, gpu: 'intel-old' },
    ];
    
    const gpuConfigs = {
        'nvidia-high': [
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'nvidia-mid': [
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Super Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'nvidia-laptop': [
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'amd-mid': [
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'intel-integrated': [
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
        'intel-old': [
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 530 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
            { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 4600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
        ],
    };
    
    const fontSets = [
        ["Arial", "Arial Black", "Calibri", "Cambria", "Cambria Math", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Microsoft Sans Serif", "Segoe UI", "Segoe UI Symbol", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Wingdings"],
        ["Arial", "Arial Black", "Calibri", "Calibri Light", "Cambria", "Cambria Math", "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Franklin Gothic Medium", "Georgia", "Impact", "Lucida Console", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"],
        ["Arial", "Calibri", "Consolas", "Courier New", "Georgia", "Segoe UI", "Tahoma", "Times New Roman", "Verdana"],
        ["Arial", "Arial Black", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings", "Wingdings 2", "Wingdings 3"],
    ];
    
    // Deterministic selections based on profile hash
    const config = seededPick(windowsConfigs);
    const gpuOptions = gpuConfigs[config.gpu];
    const gpu = seededPick(gpuOptions);
    const fonts = seededPick(fontSets);
    
    // Generate deterministic canvas pattern
    const canvasPattern = Array.from({ length: 12 }, () => seededInt(0, 255));
    
    // Deterministic audio noise
    const audioNoise = rng() * 0.0001;
    
    // User agent with current Chrome version
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    
    // Deterministic doNotTrack (~5%)
    const doNotTrack = rng() > 0.95 ? "1" : null;
    
    // Deterministic touch support (~10%)
    const maxTouchPoints = rng() > 0.9 ? 10 : 0;

    return {
        userAgent: userAgent,
        platform: "Win32",
        language: "en-US",
        languages: ["en-US", "en"],
        hardwareConcurrency: config.cpu,
        deviceMemory: config.mem,
        screenResolution: config.screen,
        timezone: "America/New_York", // Will be overridden by IP geolocation
        webgl: gpu,
        canvas: {
            pattern: canvasPattern,
            noise: "UNIQUE"
        },
        audioContext: {
            noise: audioNoise,
            type: "UNIQUE"
        },
        fonts: fonts,
        plugins: [],
        cookieEnabled: true,
        onLine: true,
        colorDepth: 24,
        pixelDepth: 24,
        doNotTrack: doNotTrack,
        maxTouchPoints: maxTouchPoints,
        clientRects: seededInt(1, 5),
        webglParams: {
            maxTextureSize: seededPick([8192, 16384, 32768]),
            maxViewportDims: seededPick([[16384, 16384], [32768, 32768]]),
            maxRenderbufferSize: seededPick([8192, 16384, 32768]),
            maxVertexAttribs: seededPick([16, 32]),
            maxVertexUniformVectors: seededPick([1024, 4096]),
            maxFragmentUniformVectors: seededPick([1024, 4096]),
            aliasedLineWidthRange: [1, 1],
            aliasedPointSizeRange: seededPick([[1, 1024], [1, 2048]]),
        }
    };
}

/**
 * Get or create a fingerprint for a profile
 * This is the main entry point for getting a fingerprint
 * 
 * @param {string} profileName - Profile name/ID
 * @param {object} version - Chrome version info (optional, will fetch latest if not provided)
 * @returns {object} Fingerprint configuration
 */
async function getOrCreateFingerprint(profileName, version = null) {
    // Fetch latest Chrome version first (needed for both new and existing fingerprints)
    if (!version) {
        version = await getLatestChromeVersion();
    }
    
    // First, try to load existing fingerprint
    let fingerprint = await loadFingerprintForProfile(profileName);
    
    if (fingerprint) {
        console.log(`[CDP Fingerprint] Loaded existing fingerprint for: ${profileName}`);
        
        // Update the Chrome version in the user agent to the latest
        // This ensures existing profiles use the latest Chrome version
        if (fingerprint.userAgent && version?.full) {
            const oldUA = fingerprint.userAgent;
            const newUA = oldUA.replace(/Chrome\/[\d.]+/, `Chrome/${version.full}`);
            if (oldUA !== newUA) {
                fingerprint.userAgent = newUA;
                console.log(`[CDP Fingerprint] Updated Chrome version in UA from old to: Chrome/${version.full}`);
                
                // Save the updated fingerprint
                try {
                    const profilePath = path.join(app.getPath("userData"), "profiles", profileName);
                    await fs.writeFile(
                        path.join(profilePath, 'fingerprint.json'),
                        JSON.stringify(fingerprint, null, 2),
                        'utf8'
                    );
                } catch (e) {
                    // Non-critical, just log
                    console.log(`[CDP Fingerprint] Could not save updated fingerprint:`, e.message);
                }
            }
        }
        
        return fingerprint;
    }
    
    // Generate a new RANDOM realistic fingerprint for this profile
    // This ensures each new profile gets a unique, realistic fingerprint
    console.log(`[CDP Fingerprint] Generating new random realistic fingerprint for: ${profileName}`);
    fingerprint = generateRandomRealisticFingerprint(version);
    
    // Save to file for persistence (so the same profile always uses the same fingerprint)
    try {
        const profilePath = path.join(app.getPath("userData"), "profiles", profileName);
        await fs.mkdir(profilePath, { recursive: true });
        await fs.writeFile(
            path.join(profilePath, 'fingerprint.json'),
            JSON.stringify(fingerprint, null, 2),
            'utf8'
        );
        console.log(`[CDP Fingerprint] Saved unique fingerprint for: ${profileName}`);
    } catch (e) {
        console.log(`[CDP Fingerprint] Could not save fingerprint:`, e.message);
    }
    
    return fingerprint;
}

// ============================================================================
// SPOOFING SCRIPT GENERATORS
// ============================================================================

/**
 * Generate the main page spoofing script (copied from test-spoofer.js generateSpoofingScript)
 */
function generateMainSpoofScript(fp) {
    // Default values for missing properties
    const canvasPattern = fp.canvas?.pattern || [126, 199, 17, 90, 163, 236, 54, 127, 200, 18, 91, 164];
    const seed = canvasPattern.reduce((a, b) => a + b, 0);
    
    // WebGL values
    const webglVendor = fp.webgl?.vendor || 'Google Inc. (NVIDIA)';
    const webglRenderer = fp.webgl?.renderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const webglVersion = fp.webgl?.version || 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
    const webglShadingVersion = fp.webgl?.shadingLanguageVersion || 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
    
    return `
(function() {
    'use strict';
    
    if (window.__cdpFpApplied) return;
    window.__cdpFpApplied = true;

    // ========================================================================
    // UTILITY FUNCTIONS
    // ========================================================================
    const utils = {
        seededRandom: (function() {
            let seed = ${seed};
            return function() {
                seed = (seed * 9301 + 49297) % 233280;
                return seed / 233280;
            };
        })()
    };

    // ========================================================================
    // NAVIGATOR - Remove webdriver
    // ========================================================================
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
    try { Reflect.deleteProperty(Navigator.prototype, 'webdriver'); } catch(e) {}

    // maxTouchPoints
    try {
        Object.defineProperty(navigator, 'maxTouchPoints', {
            get: () => 0,
            configurable: true
        });
    } catch(e) {}

    // ========================================================================
    // CHROME OBJECT SPOOFING
    // ========================================================================
    const chromeObj = {
        app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            getDetails: function() { return null; },
            getIsInstalled: function() { return false; },
            installState: function(callback) { if (callback) callback('not_installed'); },
            runningState: function() { return 'cannot_run'; }
        },
        csi: function() {
            return {
                startE: Date.now() - Math.floor(utils.seededRandom() * 1000),
                onloadT: Date.now() - Math.floor(utils.seededRandom() * 500)
            };
        },
        loadTimes: function() {
            const now = Date.now() / 1000;
            return {
                commitLoadTime: now - utils.seededRandom() * 2,
                connectionInfo: 'h2',
                finishDocumentLoadTime: now - utils.seededRandom(),
                finishLoadTime: now - utils.seededRandom() * 0.5,
                firstPaintAfterLoadTime: 0,
                firstPaintTime: now - utils.seededRandom() * 0.3,
                navigationType: 'navigate',
                requestTime: now - utils.seededRandom() * 3,
                startLoadTime: now - utils.seededRandom() * 2.5
            };
        },
        runtime: {
            OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
            connect: function() { return { onMessage: { addListener: function(){} }, onDisconnect: { addListener: function(){} }, postMessage: function(){} }; },
            sendMessage: function() {},
            id: undefined
        }
    };
    
    if (!window.chrome) window.chrome = {};
    Object.assign(window.chrome, chromeObj);

    // ========================================================================
    // NOTIFICATION / PERMISSIONS CONSISTENCY
    // Headless + automation flags (e.g. --disable-notifications) force
    // Notification.permission to 'denied', which mismatches a normal user
    // session and is a classic automation tell. Normalize to a human-like,
    // self-consistent pair: Notification.permission='default' <-> the
    // Permissions API reports 'prompt' for notifications.
    // ========================================================================
    try {
        if (window.Notification) {
            Object.defineProperty(window.Notification, 'permission', {
                get: function() { return 'default'; },
                configurable: true
            });
        }
    } catch(e) {}
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const __origPermQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = function(parameters) {
                if (parameters && parameters.name === 'notifications') {
                    return Promise.resolve({
                        state: 'prompt',
                        name: 'notifications',
                        onchange: null,
                        addEventListener: function(){},
                        removeEventListener: function(){},
                        dispatchEvent: function(){ return false; }
                    });
                }
                return __origPermQuery(parameters);
            };
        }
    } catch(e) {}

    // ========================================================================
    // WORKER BLOCKING - Force sites to use main-thread fingerprinting
    // Instead of trying to spoof workers (which causes crashes), we block them
    // so sites fall back to main-thread execution where our spoofing works
    // ========================================================================
    
    // Block SharedWorker - throw error when trying to create one
    if (typeof SharedWorker !== 'undefined') {
        const OriginalSharedWorker = SharedWorker;
        window.SharedWorker = function(scriptURL, options) {
            console.log('[CDP Spoof] SharedWorker blocked:', scriptURL);
            throw new DOMException('SharedWorker is not supported in this context', 'NotSupportedError');
        };
        window.SharedWorker.prototype = OriginalSharedWorker.prototype;
        Object.defineProperty(window.SharedWorker, 'toString', {
            value: () => 'function SharedWorker() { [native code] }'
        });
    }
    
    // Block regular Worker
    if (typeof Worker !== 'undefined') {
        const OriginalWorker = Worker;
        window.Worker = function(scriptURL, options) {
            console.log('[CDP Spoof] Worker blocked:', scriptURL);
            throw new DOMException('Worker is not supported in this context', 'NotSupportedError');
        };
        window.Worker.prototype = OriginalWorker.prototype;
        Object.defineProperty(window.Worker, 'toString', {
            value: () => 'function Worker() { [native code] }'
        });
    }
    
    // Block ServiceWorker registration
    if (navigator.serviceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', {
            get: () => undefined,
            configurable: true
        });
    }
    
    console.log('[CDP Spoof] Workers blocked - sites will use main-thread fingerprinting');

    // ========================================================================
    // WEBRTC SPOOFING - Completely prevent IP leak
    // ========================================================================
    const OriginalRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    if (OriginalRTCPeerConnection) {
        const RTCHandler = {
            construct(target, args) {
                const config = args[0] || {};
                
                // Remove ALL ice servers (STUN servers leak your real IP)
                config.iceServers = [];
                config.iceCandidatePoolSize = 0;
                
                // Create the peer connection with sanitized config
                const pc = new target(config);
                
                // Block ALL ice candidates to prevent any IP leakage
                const originalAddIceCandidate = pc.addIceCandidate.bind(pc);
                pc.addIceCandidate = function(candidate) {
                    // Block all candidates - this prevents IP discovery entirely
                    if (candidate && candidate.candidate) {
                        console.log('[CDP Spoof] Blocked ICE candidate');
                        return Promise.resolve();
                    }
                    return originalAddIceCandidate(candidate);
                };
                
                // Override onicecandidate to filter out all IP-containing candidates
                let userOnIceCandidate = null;
                Object.defineProperty(pc, 'onicecandidate', {
                    get: () => userOnIceCandidate,
                    set: (handler) => {
                        userOnIceCandidate = handler;
                    },
                    configurable: true
                });
                
                // Intercept addEventListener for icecandidate events
                const originalAddEventListener = pc.addEventListener.bind(pc);
                pc.addEventListener = function(type, listener, options) {
                    if (type === 'icecandidate') {
                        const wrappedListener = (event) => {
                            // Only pass null candidates (end of gathering) or relay candidates
                            if (!event.candidate || 
                                (event.candidate.candidate && event.candidate.candidate.includes('relay'))) {
                                listener(event);
                            }
                        };
                        return originalAddEventListener(type, wrappedListener, options);
                    }
                    return originalAddEventListener(type, listener, options);
                };
                
                // Override localDescription getter to remove IP addresses from SDP
                const originalLocalDescriptionGetter = Object.getOwnPropertyDescriptor(
                    RTCPeerConnection.prototype, 'localDescription'
                )?.get;
                
                if (originalLocalDescriptionGetter) {
                    Object.defineProperty(pc, 'localDescription', {
                        get: function() {
                            const desc = originalLocalDescriptionGetter.call(this);
                            if (desc && desc.sdp) {
                                // Remove all candidate lines with IPs from SDP
                                const sanitizedSdp = desc.sdp
                                    .split('\\n')
                                    .filter(line => !line.startsWith('a=candidate:') || line.includes('relay'))
                                    .join('\\n');
                                return new RTCSessionDescription({
                                    type: desc.type,
                                    sdp: sanitizedSdp
                                });
                            }
                            return desc;
                        },
                        configurable: true
                    });
                }
                
                return pc;
            }
        };
        window.RTCPeerConnection = new Proxy(OriginalRTCPeerConnection, RTCHandler);
        try {
            Object.defineProperty(window.RTCPeerConnection, 'prototype', {
                value: OriginalRTCPeerConnection.prototype, writable: false, configurable: false
            });
        } catch(e) {}
        if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = window.RTCPeerConnection;
    }
    
    console.log('[CDP Spoof] WebRTC IP leak protection active');

    // ========================================================================
    // AUTOMATION DETECTION CLEANUP
    // ========================================================================
    delete window.__selenium_unwrapped;
    delete window.__selenium_evaluate;
    delete window.__webdriver_evaluate;
    delete window.__webdriver_script_function;
    delete window.__webdriver_script_func;
    delete window.__webdriver_script_fn;
    delete window.__fxdriver_evaluate;
    delete window.__driver_unwrapped;
    delete window.__webdriver_unwrapped;
    delete window.__driver_evaluate;
    delete window.__fxdriver_unwrapped;
    delete window._phantom;
    delete window.__nightmare;
    delete window.phantom;
    delete window.callPhantom;
    delete window.Buffer;
    delete window.emit;
    delete window.spawn;
    delete window.__playwright;
    delete window.__playwright__binding;
    delete window.__puppeteer_evaluation_script__;

    // ========================================================================
    // DOCUMENT VISIBILITY
    // ========================================================================
    try {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch(e) {}

    // Touch support consistency
    try {
        Object.defineProperty(window, 'ontouchstart', { get: () => undefined, configurable: true });
    } catch(e) {}

    // ========================================================================
    // WEBGL SPOOFING
    // ========================================================================
    const WEBGL_CONSTANTS = {
        UNMASKED_VENDOR_WEBGL: 0x9245,
        UNMASKED_RENDERER_WEBGL: 0x9246,
        VERSION: 0x1F02,
        SHADING_LANGUAGE_VERSION: 0x8B8C,
        VENDOR: 0x1F00,
        RENDERER: 0x1F01
    };
    
    const webglVendor = '${webglVendor}';
    const webglRenderer = '${webglRenderer}';
    const webglVersion = '${webglVersion}';
    const webglShadingVersion = '${webglShadingVersion}';
    
    // Patch WebGLRenderingContext
    if (typeof WebGLRenderingContext !== 'undefined') {
        const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL) return webglVendor;
            if (parameter === WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL) return webglRenderer;
            if (parameter === WEBGL_CONSTANTS.VERSION) return webglVersion;
            if (parameter === WEBGL_CONSTANTS.SHADING_LANGUAGE_VERSION) return webglShadingVersion;
            if (parameter === WEBGL_CONSTANTS.VENDOR) return 'WebKit';
            if (parameter === WEBGL_CONSTANTS.RENDERER) return 'WebKit WebGL';
            return originalGetParameter.call(this, parameter);
        };
        
        const originalGetExtension = WebGLRenderingContext.prototype.getExtension;
        WebGLRenderingContext.prototype.getExtension = function(name) {
            if (name === 'WEBGL_debug_renderer_info') {
                return {
                    UNMASKED_VENDOR_WEBGL: WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL,
                    UNMASKED_RENDERER_WEBGL: WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL
                };
            }
            return originalGetExtension.call(this, name);
        };
    }
    
    // Patch WebGL2RenderingContext
    if (typeof WebGL2RenderingContext !== 'undefined') {
        const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL) return webglVendor;
            if (parameter === WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL) return webglRenderer;
            if (parameter === WEBGL_CONSTANTS.VERSION) return 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
            if (parameter === WEBGL_CONSTANTS.SHADING_LANGUAGE_VERSION) return 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)';
            if (parameter === WEBGL_CONSTANTS.VENDOR) return 'WebKit';
            if (parameter === WEBGL_CONSTANTS.RENDERER) return 'WebKit WebGL';
            return originalGetParameter2.call(this, parameter);
        };
        
        const originalGetExtension2 = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function(name) {
            if (name === 'WEBGL_debug_renderer_info') {
                return {
                    UNMASKED_VENDOR_WEBGL: WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL,
                    UNMASKED_RENDERER_WEBGL: WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL
                };
            }
            return originalGetExtension2.call(this, name);
        };
    }

    console.log('[CDP Main Spoof] Applied with WebGL');
})();
`;
}

/**
 * Generate Service Worker spoofing script with WebGL (from test-spoofer.js generateServiceWorkerSpoofScript)
 */
function generateWorkerSpoofScript(fp) {
    const canvasPattern = fp.canvas?.pattern || [126, 199, 17, 90, 163, 236, 54, 127, 200, 18, 91, 164];
    const seed = canvasPattern.reduce((a, b) => a + b, 0);
    
    // WebGL values from fingerprint
    const webglVendor = fp.webgl?.vendor || 'Google Inc. (NVIDIA)';
    const webglRenderer = fp.webgl?.renderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const webglVersion = fp.webgl?.version || 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
    const webglShadingVersion = fp.webgl?.shadingLanguageVersion || 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
    
    // Chrome version from fingerprint or default
    const chromeVersion = fp.chrome?.runtime?.majorVersion || 140;
    
    return `
// Service Worker Fingerprint Spoofing - Ported from test-spoofer.js
(function() {
    'use strict';
    
    if (self.__fingerprintSpoofed) return;
    self.__fingerprintSpoofed = true;
    
    console.log('[SW Spoof] Initializing service worker fingerprint spoofing...');
    
    // Seeded random
    const seed = ${seed};
    let currentSeed = seed;
    function seededRandom() {
        currentSeed = (currentSeed * 9301 + 49297) % 233280;
        return currentSeed / 233280;
    }
    
    const spoofedNavigator = {
        userAgent: '${fp.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'}',
        platform: '${fp.platform || 'Win32'}',
        language: '${fp.language || 'en-US'}',
        languages: Object.freeze(${JSON.stringify(fp.languages || ['en-US', 'en'])}),
        hardwareConcurrency: ${fp.hardwareConcurrency || 8},
        deviceMemory: ${fp.deviceMemory || 8},
        onLine: ${fp.onLine !== false}
    };
    
    // Override self.navigator
    if (typeof self !== 'undefined' && self.navigator) {
        for (const [prop, value] of Object.entries(spoofedNavigator)) {
            try {
                Object.defineProperty(self.navigator, prop, {
                    get: () => value,
                    configurable: true
                });
            } catch(e) {}
        }
        
        // Remove webdriver
        try {
            Object.defineProperty(self.navigator, 'webdriver', {
                get: () => undefined,
                configurable: true
            });
        } catch(e) {}
        
        // Spoof userAgentData
        if (self.navigator.userAgentData) {
            const fakeUAData = {
                brands: [
                    { brand: 'Chromium', version: '${chromeVersion}' },
                    { brand: 'Google Chrome', version: '${chromeVersion}' },
                    { brand: 'Not_A Brand', version: '24' }
                ],
                mobile: false,
                platform: 'Windows',
                getHighEntropyValues: function(hints) {
                    return Promise.resolve({
                        brands: this.brands,
                        mobile: this.mobile,
                        platform: 'Windows',
                        platformVersion: '10.0.0',
                        architecture: 'x86',
                        bitness: '64',
                        model: '',
                        uaFullVersion: '${chromeVersion}.0.0.0',
                        fullVersionList: [
                            { brand: 'Chromium', version: '${chromeVersion}.0.0.0' },
                            { brand: 'Google Chrome', version: '${chromeVersion}.0.0.0' },
                            { brand: 'Not_A Brand', version: '24.0.0.0' }
                        ]
                    });
                },
                toJSON: function() {
                    return { brands: this.brands, mobile: this.mobile, platform: this.platform };
                }
            };
            
            try {
                Object.defineProperty(self.navigator, 'userAgentData', {
                    get: () => fakeUAData,
                    configurable: true
                });
                console.log('[SW Spoof] userAgentData spoofed');
            } catch(e) {}
        }
        
        console.log('[SW Spoof] Navigator spoofed');
    }
    
    // ========================================================================
    // WebGL CONSTANTS
    // ========================================================================
    const WEBGL_CONSTANTS = {
        UNMASKED_VENDOR_WEBGL: 0x9245,
        UNMASKED_RENDERER_WEBGL: 0x9246,
        VERSION: 0x1F02,
        SHADING_LANGUAGE_VERSION: 0x8B8C,
        VENDOR: 0x1F00,
        RENDERER: 0x1F01
    };
    
    const webglVendor = '${webglVendor}';
    const webglRenderer = '${webglRenderer}';
    const webglVersion = '${webglVersion}';
    const webglShadingVersion = '${webglShadingVersion}';
    
    // ========================================================================
    // PATCH WebGLRenderingContext PROTOTYPE
    // ========================================================================
    if (typeof WebGLRenderingContext !== 'undefined') {
        const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL) return webglVendor;
            if (parameter === WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL) return webglRenderer;
            if (parameter === WEBGL_CONSTANTS.VERSION) return webglVersion;
            if (parameter === WEBGL_CONSTANTS.SHADING_LANGUAGE_VERSION) return webglShadingVersion;
            if (parameter === WEBGL_CONSTANTS.VENDOR) return 'WebKit';
            if (parameter === WEBGL_CONSTANTS.RENDERER) return 'WebKit WebGL';
            return originalGetParameter.call(this, parameter);
        };
        
        const originalGetExtension = WebGLRenderingContext.prototype.getExtension;
        WebGLRenderingContext.prototype.getExtension = function(name) {
            if (name === 'WEBGL_debug_renderer_info') {
                return {
                    UNMASKED_VENDOR_WEBGL: WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL,
                    UNMASKED_RENDERER_WEBGL: WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL
                };
            }
            return originalGetExtension.call(this, name);
        };
        console.log('[SW Spoof] WebGLRenderingContext.prototype patched');
    }
    
    // ========================================================================
    // PATCH WebGL2RenderingContext PROTOTYPE
    // ========================================================================
    if (typeof WebGL2RenderingContext !== 'undefined') {
        const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL) return webglVendor;
            if (parameter === WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL) return webglRenderer;
            if (parameter === WEBGL_CONSTANTS.VERSION) return 'WebGL 2.0 (OpenGL ES 3.0 Chromium)';
            if (parameter === WEBGL_CONSTANTS.SHADING_LANGUAGE_VERSION) return 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)';
            if (parameter === WEBGL_CONSTANTS.VENDOR) return 'WebKit';
            if (parameter === WEBGL_CONSTANTS.RENDERER) return 'WebKit WebGL';
            return originalGetParameter2.call(this, parameter);
        };
        
        const originalGetExtension2 = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function(name) {
            if (name === 'WEBGL_debug_renderer_info') {
                return {
                    UNMASKED_VENDOR_WEBGL: WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL,
                    UNMASKED_RENDERER_WEBGL: WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL
                };
            }
            return originalGetExtension2.call(this, name);
        };
        console.log('[SW Spoof] WebGL2RenderingContext.prototype patched');
    }
    
    // ========================================================================
    // PATCH OffscreenCanvas
    // ========================================================================
    if (typeof OffscreenCanvas !== 'undefined') {
        const origGetContext = OffscreenCanvas.prototype.getContext;
        OffscreenCanvas.prototype.getContext = function(type, attributes) {
            const context = origGetContext.call(this, type, attributes);
            
            if (context && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
                const origGetParam = context.getParameter.bind(context);
                context.getParameter = function(param) {
                    if (param === WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL) return webglVendor;
                    if (param === WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL) return webglRenderer;
                    if (param === WEBGL_CONSTANTS.VERSION) return webglVersion;
                    if (param === WEBGL_CONSTANTS.SHADING_LANGUAGE_VERSION) return webglShadingVersion;
                    if (param === WEBGL_CONSTANTS.VENDOR) return 'WebKit';
                    if (param === WEBGL_CONSTANTS.RENDERER) return 'WebKit WebGL';
                    return origGetParam(param);
                };
                
                const origGetExt = context.getExtension.bind(context);
                context.getExtension = function(name) {
                    if (name === 'WEBGL_debug_renderer_info') {
                        return {
                            UNMASKED_VENDOR_WEBGL: WEBGL_CONSTANTS.UNMASKED_VENDOR_WEBGL,
                            UNMASKED_RENDERER_WEBGL: WEBGL_CONSTANTS.UNMASKED_RENDERER_WEBGL
                        };
                    }
                    return origGetExt(name);
                };
            }
            return context;
        };
        console.log('[SW Spoof] OffscreenCanvas.prototype.getContext patched');
    }
    
    console.log('[SW Fingerprint Spoofing] Applied in worker context');
    
    // ========================================================================
    // VERIFICATION - Test that patches are actually working
    // ========================================================================
    try {
        if (typeof OffscreenCanvas !== 'undefined') {
            const testCanvas = new OffscreenCanvas(16, 16);
            const testCtx = testCanvas.getContext('webgl');
            if (testCtx) {
                const ext = testCtx.getExtension('WEBGL_debug_renderer_info');
                if (ext) {
                    const testVendor = testCtx.getParameter(ext.UNMASKED_VENDOR_WEBGL);
                    const testRenderer = testCtx.getParameter(ext.UNMASKED_RENDERER_WEBGL);
                    console.log('[SW Spoof VERIFY] getParameter result - Vendor:', testVendor);
                    console.log('[SW Spoof VERIFY] getParameter result - Renderer:', testRenderer);
                    if (testRenderer === webglRenderer) {
                        console.log('[SW Spoof VERIFY] ✓ SUCCESS - Spoofing is working correctly!');
                    } else {
                        console.log('[SW Spoof VERIFY] ✗ FAILED - Expected:', webglRenderer, 'Got:', testRenderer);
                    }
                }
            }
        }
    } catch (verifyError) {
        console.log('[SW Spoof VERIFY] Error during verification:', verifyError.message);
    }
})();
`;
}

/**
 * Load fingerprint for a profile
 * Checks both structures data (primary) and fingerprint.json file (fallback)
 */
async function loadFingerprintForProfile(profileName) {
    let fingerprintConfig = null;
    
    // First try to get fingerprint from structures (where UI saves it)
    try {
        const { readKey } = require('./utils');
        const structures = await readKey('structures') || {};
        for (const structureId in structures) {
            const structure = structures[structureId];
            if (structure.profiles && structure.profiles[profileName]) {
                fingerprintConfig = structure.profiles[profileName].fingerprint;
                if (fingerprintConfig) {
                    console.log(`[CDP Fingerprint] Loaded fingerprint from structures for: ${profileName}`);
                    
                    // Also save to file for consistency
                    try {
                        const profilePath = path.join(app.getPath("userData"), "profiles", profileName);
                        await fs.mkdir(profilePath, { recursive: true });
                        await fs.writeFile(
                            path.join(profilePath, 'fingerprint.json'),
                            JSON.stringify(fingerprintConfig, null, 2),
                            'utf8'
                        );
                    } catch (saveErr) {
                        // Non-critical, just log
                        console.log(`[CDP Fingerprint] Could not sync to file:`, saveErr.message);
                    }
                    
                    return fingerprintConfig;
                }
                break;
            }
        }
    } catch (e) {
        console.log(`[CDP Fingerprint] Could not load from structures:`, e.message);
    }
    
    // Fallback: try fingerprint.json file
    const profilePath = path.join(app.getPath("userData"), "profiles", profileName);
    const fingerprintFile = path.join(profilePath, 'fingerprint.json');
    
    try {
        const data = await fs.readFile(fingerprintFile, 'utf8');
        fingerprintConfig = JSON.parse(data);
        console.log(`[CDP Fingerprint] Loaded fingerprint from file for: ${profileName}`);
        return fingerprintConfig;
    } catch (e) {
        console.log(`[CDP Fingerprint] No fingerprint found for ${profileName}`);
        return null;
    }
}

/**
 * Apply CDP fingerprint spoofing with Fetch interception for Service Workers
 * This is the main function - ported from test-spoofer.js
 * 
 * IMPORTANT: This function is the SINGLE handler for Target.attachedToTarget
 * to prevent race conditions and duplicate runIfWaitingForDebugger calls
 * 
 * @param {object} client - CDP client
 * @param {object} fingerprint - Fingerprint config
 * @param {string} sessionId - Session ID (undefined for main session)
 * @param {object} chromeIdentity - Optional Chrome identity config for new tabs
 */
async function applyCDPFingerprint(client, fingerprint, sessionId = undefined, chromeIdentity = null) {
    if (!fingerprint) {
        console.log('[CDP Fingerprint] No fingerprint provided, skipping');
        return;
    }

    try {
        const mainScript = generateMainSpoofScript(fingerprint);
        const workerScript = generateWorkerSpoofScript(fingerprint);

        // Enable only essential domains
        try { await client.send('Page.enable', {}, sessionId); } catch {}
        try { await client.send('Runtime.enable', {}, sessionId); } catch {}

        // =====================================================================
        // INJECT MAIN SCRIPT FOR NEW DOCUMENTS
        // =====================================================================
        try {
            await client.send('Page.addScriptToEvaluateOnNewDocument', {
                source: mainScript,
                worldName: '',
                runImmediately: true
            }, sessionId);
            console.log('[CDP Fingerprint] Main script registered');
        } catch (e) {
            console.error('[CDP Fingerprint] Failed to register main script:', e.message);
        }

        // NOTE: Worker script is NOT injected into pages via addScriptToEvaluateOnNewDocument
        // This was causing Chrome crashes on sites like pixelscan.net during fingerprint checks.
        // Worker spoofing is only applied directly to actual worker contexts via Runtime.evaluate.

        // Store scripts and chrome identity for reuse in child target handler
        if (!client.__cdpFpScripts) {
            client.__cdpFpScripts = { mainScript, workerScript };
        }
        // Store/update Chrome identity config (can be set after initial setup)
        if (chromeIdentity) {
            client.__cdpChromeIdentity = chromeIdentity;
        }

        // =====================================================================
        // SET UP TARGET HANDLERS (ONCE) - SINGLE HANDLER TO PREVENT RACE CONDITIONS
        // This is the ONLY Target.attachedToTarget handler - utils.js does NOT add one
        // =====================================================================
        if (!client.__cdpFpHandlers) {
            client.__cdpFpHandlers = true;
            
            // Track configured targets to avoid double-injection
            const configuredTargets = new Set();

            // Handle attached targets (new pages, workers, iframes)
            // THIS IS THE SINGLE HANDLER - no other code should register Target.attachedToTarget
            client.on('Target.attachedToTarget', async (evt) => {
                const { sessionId: childSid, targetInfo, waitingForDebugger } = evt;
                
                // Use a composite key for tracking
                const targetKey = `${targetInfo.targetId}_${childSid}`;
                
                // Skip if already configured - just resume if needed
                if (configuredTargets.has(targetKey)) {
                    if (waitingForDebugger) {
                        try { await client.send('Runtime.runIfWaitingForDebugger', {}, childSid); } catch {}
                    }
                    return;
                }
                configuredTargets.add(targetKey);

                // Workers - DO NOT INTERACT, just resume immediately
                // Any interaction with workers (Runtime.enable, Runtime.evaluate) causes Chrome crashes
                // on sites like pixelscan.net. The trade-off is that worker fingerprints won't be spoofed.
                if (targetInfo.type === 'service_worker' || targetInfo.type === 'worker' || targetInfo.type === 'shared_worker') {
                    console.log(`[CDP Fingerprint] Worker detected (${targetInfo.type}) - resuming without modification`);
                    if (waitingForDebugger) {
                        try { await client.send('Runtime.runIfWaitingForDebugger', {}, childSid); } catch {}
                    }
                    return;
                }

                // Handle pages and iframes - register scripts for new documents
                // ALSO apply Chrome identity here (unified handling)
                if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
                    try {
                        // 1. Enable essential domains FIRST
                        await client.send('Page.enable', {}, childSid);
                        await client.send('Runtime.enable', {}, childSid);
                        await client.send('Network.enable', {}, childSid);
                        
                        // 2. Apply Chrome identity (UA, locale, timezone) if configured
                        if (client.__cdpChromeIdentity) {
                            await applyChromeIdentityOnSession(client, childSid, client.__cdpChromeIdentity);
                        }
                        
                        // 3. Inject fingerprint scripts (main script only - worker script caused crashes)
                        await client.send('Page.addScriptToEvaluateOnNewDocument', {
                            source: client.__cdpFpScripts.mainScript,
                            worldName: '',
                            runImmediately: true
                        }, childSid);
                        
                        // NOTE: Worker script is NOT injected into pages - it caused Chrome crashes
                        // on sites like pixelscan.net during fingerprint checks. Worker script
                        // is only injected directly into actual worker contexts.
                        
                        console.log(`[CDP Fingerprint] ✓ Configured ${targetInfo.type}: ${targetInfo.url?.substring(0, 60) || 'about:blank'}`);
                    } catch (e) {
                        console.log(`[CDP Fingerprint] Page setup error: ${e.message}`);
                    }
                    
                    // 4. Resume the target LAST - after all configuration is done
                    if (waitingForDebugger) {
                        try { await client.send('Runtime.runIfWaitingForDebugger', {}, childSid); } catch {}
                    }
                }
            });
            
            // =====================================================================
            // HANDLE USER-OPENED TABS (Ctrl+T, clicking + button, etc.)
            // setAutoAttach only catches targets created by attached pages
            // We need setDiscoverTargets + targetCreated to catch ALL new tabs
            // =====================================================================
            
            // Enable target discovery
            try { await client.send('Target.setDiscoverTargets', { discover: true }); } catch {}
            
            // Listen for new targets being created by user
            client.on('Target.targetCreated', async ({ targetInfo }) => {
                // Only handle page targets (not workers, iframes handled by attachedToTarget)
                if (targetInfo.type !== 'page') return;
                
                // Skip if already configured
                if (configuredTargets.has(targetInfo.targetId)) return;
                
                console.log(`[CDP Fingerprint] New user tab detected: ${targetInfo.url || 'about:blank'}`);
                
                try {
                    // Attach to the new tab
                    const { sessionId: newSid } = await client.send('Target.attachToTarget', {
                        targetId: targetInfo.targetId,
                        flatten: true
                    });
                    
                    configuredTargets.add(targetInfo.targetId);
                    
                    // Enable domains
                    await client.send('Page.enable', {}, newSid);
                    await client.send('Runtime.enable', {}, newSid);
                    await client.send('Network.enable', {}, newSid);
                    
                    // Apply Chrome identity
                    if (client.__cdpChromeIdentity) {
                        await applyChromeIdentityOnSession(client, newSid, client.__cdpChromeIdentity);
                    }
                    
                    // Inject fingerprint script
                    await client.send('Page.addScriptToEvaluateOnNewDocument', {
                        source: client.__cdpFpScripts.mainScript,
                        worldName: '',
                        runImmediately: true
                    }, newSid);
                    
                    console.log(`[CDP Fingerprint] ✓ User tab configured: ${targetInfo.url?.substring(0, 60) || 'about:blank'}`);
                    
                } catch (e) {
                    // Target might already be attached via attachedToTarget
                    if (!e.message?.includes('already attached')) {
                        console.log(`[CDP Fingerprint] User tab config error: ${e.message}`);
                    }
                }
            });
        }

        console.log('[CDP Fingerprint] Setup complete');

    } catch (error) {
        console.error('[CDP Fingerprint] Error:', error.message);
    }
}

/**
 * Apply fingerprint to a specific target
 */
async function applyFingerprintToTarget(client, targetId, fingerprint) {
    try {
        const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
        await applyCDPFingerprint(client, fingerprint, sessionId);
    } catch (error) {
        console.error('[CDP Fingerprint] Target error:', error.message);
    }
}

/**
 * MAIN ENTRY POINT: Setup complete fingerprint spoofing for a browser session
 * 
 * This is the single function to call from startBrowser() - it handles EVERYTHING:
 * 1. Loads or creates fingerprint for the profile
 * 2. Applies CDP spoofing (script injection)
 * 3. Sets up THE ONLY Target.attachedToTarget handler for the session
 * 4. Applies Chrome identity (UA, locale, timezone) to all targets
 * 
 * CRITICAL: After calling this function, DO NOT register any other
 * Target.attachedToTarget handlers - this function handles all target events.
 * 
 * @param {object} client - CDP client from chrome-remote-interface
 * @param {string} profileName - Profile name/ID  
 * @param {object} version - Chrome version info (optional)
 * @param {object} chromeIdentity - Chrome identity config: { major, full, locale, tz, acceptLanguage }
 * @returns {object} The fingerprint that was applied (for reference)
 */
async function setupBrowserFingerprint(client, profileName, version = null, chromeIdentity = null) {
    try {
        console.log(`[CDP Fingerprint] Setting up fingerprint for profile: ${profileName}`);
        
        // Get or create fingerprint for this profile
        const fingerprint = await getOrCreateFingerprint(profileName, version);
        
        if (!fingerprint) {
            console.log('[CDP Fingerprint] No fingerprint available, skipping');
            return null;
        }
        
        // Apply the fingerprint to the main session
        // Also pass Chrome identity for use in child target handler
        await applyCDPFingerprint(client, fingerprint, undefined, chromeIdentity);
        
        console.log(`[CDP Fingerprint] Fingerprint applied for profile: ${profileName}`);
        return fingerprint;
        
    } catch (error) {
        console.error('[CDP Fingerprint] Setup error:', error.message);
        return null;
    }
}

/**
 * Set Chrome identity configuration for existing CDP client
 * Use this to set/update Chrome identity after setupBrowserFingerprint was called
 */
function setChromeIdentity(client, chromeIdentity) {
    if (chromeIdentity) {
        client.__cdpChromeIdentity = chromeIdentity;
    }
}

module.exports = {
    // Main entry point - use this from startBrowser()
    setupBrowserFingerprint,
    setChromeIdentity,
    
    // Chrome identity functions
    applyChromeIdentityOnSession,
    buildChromeCH,
    
    // Chrome version
    getLatestChromeVersion,
    getVCBrowserVersion,
    
    // Fingerprint generation/loading (for UI and settings)
    getOrCreateFingerprint,
    loadFingerprintForProfile,
    getConsistentFingerprintForProfile,
    generateRandomRealisticFingerprint,
    getRealMachineFingerprint,
    
    // Low-level functions (for advanced usage)
    generateMainSpoofScript,
    generateWorkerSpoofScript,
    applyCDPFingerprint,
    applyFingerprintToTarget
};
