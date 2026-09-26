/**
 * VCBrowser - Undetectable Browser Manager
 * Chrome-based browser with built-in fingerprint spoofing
 * Uses SunBrowser engine with custom fingerprint injection
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const CDP = require('chrome-remote-interface');
const { app } = require('electron');
const net = require('net');

// =========================================================================
// Global VCBrowser process registry
// Tracks every launched VCBrowser process keyed by profile name so that a
// profile's running browser (including headless automation browsers) can be
// found and killed before opening a fresh visible window. Without this, a
// second launch against the same locked user-data-dir silently fails.
// =========================================================================
const liveBrowsersByProfile = new Map(); // profileName -> Set<ChildProcess>

function _trackBrowserProcess(profileName, proc) {
    if (!profileName || !proc) return;
    let set = liveBrowsersByProfile.get(profileName);
    if (!set) { set = new Set(); liveBrowsersByProfile.set(profileName, set); }
    set.add(proc);
    proc.once('exit', () => {
        const s = liveBrowsersByProfile.get(profileName);
        if (s) {
            s.delete(proc);
            if (s.size === 0) liveBrowsersByProfile.delete(profileName);
        }
    });
}

function isProfileBrowserRunning(profileName) {
    const set = liveBrowsersByProfile.get(profileName);
    if (!set) return false;
    for (const proc of set) {
        if (proc && !proc.killed) return true;
    }
    return false;
}

/**
 * Kill any running VCBrowser process(es) for a profile (headless or visible).
 * Returns the number of processes a kill signal was sent to.
 */
function killBrowsersForProfile(profileName) {
    const set = liveBrowsersByProfile.get(profileName);
    if (!set || set.size === 0) return 0;
    let killed = 0;
    for (const proc of Array.from(set)) {
        if (proc && !proc.killed) {
            try {
                proc.kill();
                killed++;
            } catch (err) {
                console.error(`[VCBrowser] Failed to kill browser for ${profileName}: ${err.message}`);
            }
        }
        set.delete(proc);
    }
    liveBrowsersByProfile.delete(profileName);
    if (killed > 0) console.log(`[VCBrowser] Killed ${killed} running browser(s) for profile: ${profileName}`);
    return killed;
}

/**
 * Gracefully close a VCBrowser launched via startVCBrowser.
 *
 * CRITICAL for keeping Facebook (and any other) profiles logged in: the browser
 * runs on a PERSISTENT on-disk profile (`--user-data-dir`). While a session is
 * active Facebook rotates the `xs` session cookie (and refreshes fr/datr/sb) and
 * Chrome holds the new values in memory, only flushing them to the on-disk
 * Cookies database on a periodic timer OR on a clean shutdown. Terminating the
 * process with SIGKILL before that flush leaves the on-disk jar holding the OLD,
 * already-rotated-away cookies — so the next run reads a stale session and
 * Facebook reports the profile as logged out. An abrupt kill mid-write can also
 * corrupt the Cookies SQLite / Network LevelDB and wipe the session entirely.
 *
 * This helper asks Chrome to shut down cleanly (CDP `Browser.close`) so it
 * flushes its cookie jar, waits for the process to exit, and only falls back to
 * SIGKILL if the clean shutdown does not complete within `timeoutMs`.
 *
 * @param {object} client        - chrome-remote-interface client from startVCBrowser
 * @param {object} chromeProcess - the spawned child process from startVCBrowser
 * @param {number} [timeoutMs=6000]
 * @returns {Promise<void>} never rejects
 */
async function gracefulCloseVCBrowser(client, chromeProcess, timeoutMs = 6000) {
    // chrome-remote-interface uses `ws` internally. During Browser.close Chrome
    // can tear down the debugger transport before Node has finished processing
    // the close frame. Keep an error listener on both layers for that short
    // shutdown window so an expected reset cannot become an uncaught exception.
    const isExpectedCloseError = (error) => [
        'ECONNRESET',
        'ECONNABORTED',
        'EPIPE',
        'ERR_STREAM_PREMATURE_CLOSE'
    ].includes(error?.code);
    const absorbCloseError = (error) => {
        if (!isExpectedCloseError(error)) {
            console.warn(`[VCBrowser] Debug transport close warning: ${error?.message || error}`);
        }
    };
    const debugWebSocket = client?._ws;
    const debugSocket = debugWebSocket?._socket;
    global.__vcBrowserTransportResetUntil = Math.max(
        Number(global.__vcBrowserTransportResetUntil || 0),
        Date.now() + timeoutMs + 3000
    );
    try { debugWebSocket?.on('error', absorbCloseError); } catch (_) {}
    try { debugSocket?.on('error', absorbCloseError); } catch (_) {}

    // If the process is already gone, just tidy up the client and return.
    if (!chromeProcess || chromeProcess.killed || chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
        if (client) { try { await client.close(); } catch (_) {} }
        // CRI removes every WebSocket listener from its close callback. Restore
        // the shutdown guard in case the underlying socket reports a late reset.
        try { debugWebSocket?.on('error', absorbCloseError); } catch (_) {}
        return;
    }

    // Wait for the process to actually exit (resolves on its own clean exit, or
    // after we force-kill on timeout). This MUST be set up before we ask Chrome
    // to close so we don't miss the exit event.
    const exited = new Promise((resolve) => {
        let done = false;
        let timeout = null;
        const finish = () => {
            if (!done) {
                done = true;
                if (timeout) clearTimeout(timeout);
                resolve();
            }
        };
        try { chromeProcess.once('exit', finish); } catch (_) { finish(); return; }
        timeout = setTimeout(() => {
            try {
                if (chromeProcess && chromeProcess.exitCode === null && chromeProcess.signalCode === null) {
                    chromeProcess.kill('SIGKILL');
                }
            } catch (_) {}
            finish();
        }, timeoutMs);
        timeout.unref?.();
    });

    // Ask Chrome to shut down cleanly so it flushes cookies to the on-disk jar.
    try {
        if (client && client.Browser && typeof client.Browser.close === 'function') {
            await client.Browser.close();
        }
    } catch (_) { /* connection may already be tearing down */ }

    // Let Chrome finish closing before asking CRI to tidy its WebSocket. Calling
    // client.close() while Chrome is concurrently closing can remove the ws error
    // listener a moment before the TLS/TCP transport emits its final reset.
    await exited;

    // Close the CDP connection (best-effort; normally already closed by Chrome).
    try { if (client) await client.close(); } catch (_) {}
    try { debugWebSocket?.on('error', absorbCloseError); } catch (_) {}
    global.__vcBrowserTransportResetUntil = Math.max(
        Number(global.__vcBrowserTransportResetUntil || 0),
        Date.now() + 3000
    );
}

// Manual ICO creation with proper PNG embedding
function createIcoFromPngs(pngBuffersWithSizes) {
    const numImages = pngBuffersWithSizes.length;
    const headerSize = 6;
    const entrySize = 16;
    const directorySize = headerSize + (entrySize * numImages);
    
    // Calculate offsets
    let currentOffset = directorySize;
    const entries = pngBuffersWithSizes.map(({ buffer, size }) => {
        const entry = {
            width: size >= 256 ? 0 : size,  // 0 means 256
            height: size >= 256 ? 0 : size,
            offset: currentOffset,
            size: buffer.length
        };
        currentOffset += buffer.length;
        return entry;
    });
    
    // Build ICO file
    const totalSize = currentOffset;
    const ico = Buffer.alloc(totalSize);
    
    // Header
    ico.writeUInt16LE(0, 0);        // Reserved
    ico.writeUInt16LE(1, 2);        // Type: 1 = ICO
    ico.writeUInt16LE(numImages, 4); // Number of images
    
    // Directory entries
    entries.forEach((entry, i) => {
        const offset = headerSize + (i * entrySize);
        ico.writeUInt8(entry.width, offset);      // Width
        ico.writeUInt8(entry.height, offset + 1); // Height
        ico.writeUInt8(0, offset + 2);            // Color palette
        ico.writeUInt8(0, offset + 3);            // Reserved
        ico.writeUInt16LE(1, offset + 4);         // Color planes
        ico.writeUInt16LE(32, offset + 6);        // Bits per pixel
        ico.writeUInt32LE(entry.size, offset + 8);   // Image size
        ico.writeUInt32LE(entry.offset, offset + 12); // Image offset
    });
    
    // Image data
    pngBuffersWithSizes.forEach(({ buffer }, i) => {
        buffer.copy(ico, entries[i].offset);
    });
    
    return ico;
}

// Generate profile icon with ID text overlay
async function generateProfileIcon(profileName) {
    const userDataPath = app.getPath("userData");
    const iconsDir = path.join(userDataPath, "vcbrowser", "profile-icons");
    const iconPath = path.join(iconsDir, `${profileName}.ico`);
    
    // Return cached icon if exists
    if (fs.existsSync(iconPath)) {
        return iconPath;
    }
    
    // Use the original ICO as base fallback
    const baseIcoPath = path.join(__dirname, '..', 'frontend', 'assets', 'images', 'VCBrowser.ico');
    
    // Ensure icons directory exists
    fs.mkdirSync(iconsDir, { recursive: true });
    
    // Load base VCBrowser icon
    const basePngPath = path.join(__dirname, '..', 'frontend', 'assets', 'images', 'VCBrowser-large.png');
    const fallbackPngPath = path.join(__dirname, '..', 'frontend', 'assets', 'images', 'VCBrowser.png');
    const sourcePng = fs.existsSync(basePngPath) ? basePngPath : fallbackPngPath;
    
    if (!fs.existsSync(sourcePng)) {
        console.warn('[VCBrowser] No source PNG found for icon generation');
        // Return base icon directly without caching, so it retries generation next time
        if (fs.existsSync(baseIcoPath)) {
            return baseIcoPath;
        }
        return null;
    }
    
    try {
        const { createCanvas, loadImage } = require('canvas');
        const sharp = require('sharp');
        // Create at 512x512 for highest quality master image
        const size = 512;
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        
        // Canvas starts transparent - just draw base icon (preserves its transparency)
        const baseImage = await loadImage(sourcePng);
        ctx.drawImage(baseImage, 0, 0, size, size);
        
        // Show only first 2 chars, very large for visibility in taskbar
        const profileId = profileName.slice(0, 2).toUpperCase();
        const fontSize = 200;
        const padding = 28;
        
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Measure text
        const textMetrics = ctx.measureText(profileId);
        const textWidth = textMetrics.width + padding * 2;
        const textHeight = fontSize + padding;
        
        // Position at bottom center
        const bgX = (size - textWidth) / 2;
        const bgY = size - textHeight - 10;
        const textY = bgY + textHeight / 2;
        
        // Draw blue background pill for visibility
        ctx.beginPath();
        const radius = textHeight / 2;
        ctx.roundRect(bgX, bgY, textWidth, textHeight, radius);
        ctx.fillStyle = '#2563EB';
        ctx.fill();
        
        // Draw text
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(profileId, size / 2, textY);
        
        // Get high-quality PNG buffer (512x512 master)
        const pngMaster = canvas.toBuffer('image/png');
        
        // Create all sizes with sharp
        const icoSizes = [256, 128, 64, 48, 32, 24, 16];
        const pngBuffersWithSizes = [];
        
        for (const s of icoSizes) {
            const scaled = await sharp(pngMaster)
                .resize(s, s, { 
                    kernel: sharp.kernel.lanczos3,
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .png({ compressionLevel: 9 })
                .toBuffer();
            pngBuffersWithSizes.push({ buffer: scaled, size: s });
        }
        
        // Create ICO with manual builder (proper PNG embedding)
        const icoBuffer = createIcoFromPngs(pngBuffersWithSizes);
        fs.writeFileSync(iconPath, icoBuffer);
        
        console.log(`[VCBrowser] Generated profile icon for "${profileId}": ${iconPath} (${icoBuffer.length} bytes)`);
        return iconPath;
        
    } catch (err) {
        console.error('[VCBrowser] Failed to generate profile icon:', err.message);
        // Return base icon directly without caching, so it retries generation next time
        if (fs.existsSync(baseIcoPath)) {
            return baseIcoPath;
        }
        return null;
    }
}

// Apply custom icon to VCBrowser window via Win32 API (WM_SETICON)
// Uses EnumWindows to cover all browser windows across the process tree
async function applyWindowIcon(pid, iconPath) {
    if (!pid || !iconPath || !fs.existsSync(iconPath)) return false;
    
    // For PowerShell single-quoted strings only single quotes need escaping (backslashes are literal)
    const escapedPath = iconPath.replace(/'/g, "''");
    // Use a unique class name per call to avoid temp assembly file conflicts when
    // multiple PowerShell processes compile the same C# code concurrently.
    const className = `VCIcon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class ${className} {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr LoadImage(IntPtr hinst, string lpszName, uint uType, int cx, int cy, uint fuLoad);
    public static string Apply(uint pid, string ico) {
        IntPtr big = LoadImage(IntPtr.Zero, ico, 1, 32, 32, 0x10);
        IntPtr sm  = LoadImage(IntPtr.Zero, ico, 1, 16, 16, 0x10);
        if (big == IntPtr.Zero && sm == IntPtr.Zero) return "LOAD_FAILED";
        var pids = new HashSet<uint> { pid };
        foreach (var p in Process.GetProcesses()) {
            try {
                if (p.ProcessName.IndexOf("VCBrowser", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    p.ProcessName.IndexOf("SunBrowser", StringComparison.OrdinalIgnoreCase) >= 0) {
                    pids.Add((uint)p.Id);
                }
            } catch {}
        }
        int count = 0;
        EnumWindows((hWnd, lParam) => {
            uint wpid;
            GetWindowThreadProcessId(hWnd, out wpid);
            if (pids.Contains(wpid) && IsWindowVisible(hWnd)) {
                if (big != IntPtr.Zero) SendMessage(hWnd, 0x80, (IntPtr)1, big);
                if (sm  != IntPtr.Zero) SendMessage(hWnd, 0x80, IntPtr.Zero, sm);
                count++;
            }
            return true;
        }, IntPtr.Zero);
        return count > 0 ? ("OK:" + count) : "NO_WINDOW";
    }
}
'@ -ErrorAction SilentlyContinue
try { [${className}]::Apply(${pid}, '${escapedPath}') } catch { 'INVOKE_FAILED' }
`;
    return new Promise(resolve => {
        execFile('powershell.exe', [
            '-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-Command', script
        ], { timeout: 10000 }, (err, stdout) => {
            const result = (stdout || '').trim();
            resolve(result.startsWith('OK'));
        });
    });
}

// Get VCBrowser executable path
function getVCBrowserPath() { return require('./browserPaths').getVCBrowserPath(); }

// Check if VCBrowser is installed
function isVCBrowserInstalled() {
    return fs.existsSync(getVCBrowserPath());
}

// Clean up stale Chrome folders that block profile access
// These folders are created when Chrome crashes or is killed abruptly
function cleanupStaleProfileFolders(profileDir) {
    try {
        if (!fs.existsSync(profileDir)) return;
        
        const entries = fs.readdirSync(profileDir, { withFileTypes: true });
        for (const entry of entries) {
            // Look for folders ending with .CHROME_DELETE or similar stale patterns
            if (entry.isDirectory() && (
                entry.name.endsWith('.CHROME_DELETE') ||
                entry.name.endsWith('.CHROME_BAD') ||
                entry.name.includes('.CHROME_DELETE')
            )) {
                const stalePath = path.join(profileDir, entry.name);
                try {
                    fs.rmSync(stalePath, { recursive: true, force: true });
                    console.log(`[VCBrowser] Cleaned up stale folder: ${entry.name}`);
                } catch (rmErr) {
                    console.warn(`[VCBrowser] Could not remove stale folder ${entry.name}: ${rmErr.message}`);
                }
            }
        }
        
        // Also check for SingletonLock file that might block
        const singletonLock = path.join(profileDir, 'SingletonLock');
        if (fs.existsSync(singletonLock)) {
            try {
                fs.unlinkSync(singletonLock);
                console.log('[VCBrowser] Removed SingletonLock file');
            } catch (e) {
                console.warn('[VCBrowser] Could not remove SingletonLock:', e.message);
            }
        }
        
        // Clean up incompatible database files that cause version mismatch crashes
        // These occur when a profile was used with a different Chrome version
        const incompatiblePaths = [
            path.join(profileDir, 'Default', 'Web Data'),
            path.join(profileDir, 'Default', 'Web Data-journal'),
            path.join(profileDir, 'Default', 'Sync Data'),
            path.join(profileDir, 'Web Applications'),
        ];
        
        for (const dbPath of incompatiblePaths) {
            if (fs.existsSync(dbPath)) {
                try {
                    const stat = fs.statSync(dbPath);
                    if (stat.isDirectory()) {
                        fs.rmSync(dbPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(dbPath);
                    }
                    console.log(`[VCBrowser] Removed incompatible DB: ${path.basename(dbPath)}`);
                } catch (e) {
                    console.warn(`[VCBrowser] Could not remove ${path.basename(dbPath)}:`, e.message);
                }
            }
        }
    } catch (err) {
        console.warn('[VCBrowser] Error during cleanup:', err.message);
    }
}

// Find available port for CDP debugging
async function findAvailablePort(startPort = 9222) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(startPort, "127.0.0.1", () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', () => {
            resolve(findAvailablePort(startPort + 1));
        });
    });
}

// Wait for CDP to be ready
async function waitForCDP(port, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const client = await CDP({ port });
            return client;
        } catch (e) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw new Error(`CDP not ready after ${maxAttempts} attempts on port ${port}`);
}

// Custom Base64 encoding
const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ADS_B64 = 'hTy1bfRJz4nLPcBCO7WtmNIaGvVeul5Zo8kq32UxrYw_-0gsjp96SDFXQiEMKdHA';

const encode = (data) => {
    const b64 = Buffer.from(JSON.stringify(data)).toString('base64');
    return [...b64].map(c => STD_B64.includes(c) ? ADS_B64[STD_B64.indexOf(c)] : c).join('');
};

const hash = (s) => crypto.createHash('md5').update(s).digest('hex');

// Fetch geo data from ip-api.com (uses proxy if provided)
const fetchGeoData = (proxy = {}) => new Promise((resolve, reject) => {
    const url = 'http://ip-api.com/json/';
    const targetHost = 'ip-api.com';
    
    if (proxy.host && proxy.port && proxy.type !== 'socks5') {
        console.log(`[fetchGeoData] Using HTTP proxy: ${proxy.host}:${proxy.port} (auth: ${proxy.username ? 'yes' : 'no'})`);
        // HTTP proxy - send full URL as path with Host header
        const headers = {
            'Host': targetHost  // Required for HTTP proxy to know destination
        };
        if (proxy.username) {
            headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        }
        
        const proxyReq = http.request({
            host: proxy.host,
            port: parseInt(proxy.port, 10),  // Ensure port is a number
            method: 'GET',
            path: url,
            headers: headers
        }, (res) => {
            console.log(`[fetchGeoData] Proxy response status: ${res.statusCode}`);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`[fetchGeoData] Raw response data: ${data.substring(0, 500)}`);
                try { resolve(JSON.parse(data)); } 
                catch (e) { reject(new Error(`JSON parse failed: ${e.message}, data: ${data.substring(0, 200)}`)); }
            });
        });
        proxyReq.on('error', (err) => {
            console.log(`[fetchGeoData] Proxy request error: ${err.message}`);
            reject(err);
        });
        proxyReq.setTimeout(5000, () => { proxyReq.destroy(); reject(new Error('Proxy timeout')); });
        proxyReq.end();
    } else {
        // Direct request (no proxy or socks5 - fallback to direct)
        console.log(`[fetchGeoData] Making DIRECT request (no proxy) - THIS WILL RETURN YOUR REAL IP!`);
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    }
});

// Timezone offsets (minutes from UTC)
const TZ_OFFSETS = {
  'Africa/Abidjan': 0, 'Africa/Accra': 0, 'Africa/Addis_Ababa': 180, 'Africa/Algiers': 60, 'Africa/Asmara': 180, 'Africa/Bamako': 0, 'Africa/Bangui': 60, 'Africa/Banjul': 0, 'Africa/Bissau': 0, 'Africa/Blantyre': 120, 'Africa/Brazzaville': 60, 'Africa/Bujumbura': 120, 'Africa/Cairo': 120, 'Africa/Casablanca': 60, 'Africa/Ceuta': 60, 'Africa/Conakry': 0, 'Africa/Dakar': 0, 'Africa/Dar_es_Salaam': 180, 'Africa/Djibouti': 180, 'Africa/Douala': 60, 'Africa/El_Aaiun': 60, 'Africa/Freetown': 0, 'Africa/Gaborone': 120, 'Africa/Harare': 120, 'Africa/Johannesburg': 120, 'Africa/Juba': 120, 'Africa/Kampala': 180, 'Africa/Khartoum': 120, 'Africa/Kigali': 120, 'Africa/Kinshasa': 60, 'Africa/Lagos': 60, 'Africa/Libreville': 60, 'Africa/Lome': 0, 'Africa/Luanda': 60, 'Africa/Lubumbashi': 120, 'Africa/Lusaka': 120, 'Africa/Malabo': 60, 'Africa/Maputo': 120, 'Africa/Maseru': 120, 'Africa/Mbabane': 120, 'Africa/Mogadishu': 180, 'Africa/Monrovia': 0, 'Africa/Nairobi': 180, 'Africa/Ndjamena': 60, 'Africa/Niamey': 60, 'Africa/Nouakchott': 0, 'Africa/Ouagadougou': 0, 'Africa/Porto-Novo': 60, 'Africa/Sao_Tome': 0, 'Africa/Tripoli': 120, 'Africa/Tunis': 60, 'Africa/Windhoek': 120,
  'America/Adak': -600, 'America/Anchorage': -540, 'America/Anguilla': -240, 'America/Antigua': -240, 'America/Araguaina': -180, 'America/Argentina/Buenos_Aires': -180, 'America/Argentina/Catamarca': -180, 'America/Argentina/Cordoba': -180, 'America/Argentina/Jujuy': -180, 'America/Argentina/La_Rioja': -180, 'America/Argentina/Mendoza': -180, 'America/Argentina/Rio_Gallegos': -180, 'America/Argentina/Salta': -180, 'America/Argentina/San_Juan': -180, 'America/Argentina/San_Luis': -180, 'America/Argentina/Tucuman': -180, 'America/Argentina/Ushuaia': -180, 'America/Aruba': -240, 'America/Asuncion': -180, 'America/Atikokan': -300, 'America/Bahia': -180, 'America/Bahia_Banderas': -360, 'America/Barbados': -240, 'America/Belem': -180, 'America/Belize': -360, 'America/Blanc-Sablon': -240, 'America/Boa_Vista': -240, 'America/Bogota': -300, 'America/Boise': -420, 'America/Cambridge_Bay': -420, 'America/Campo_Grande': -240, 'America/Cancun': -300, 'America/Caracas': -240, 'America/Cayenne': -180, 'America/Cayman': -300, 'America/Chicago': -360, 'America/Chihuahua': -360, 'America/Ciudad_Juarez': -420, 'America/Costa_Rica': -360, 'America/Coyhaique': -180, 'America/Creston': -420, 'America/Cuiaba': -240, 'America/Curacao': -240, 'America/Danmarkshavn': 0, 'America/Dawson': -420, 'America/Dawson_Creek': -420, 'America/Denver': -420, 'America/Detroit': -300, 'America/Dominica': -240, 'America/Edmonton': -420, 'America/Eirunepe': -300, 'America/El_Salvador': -360, 'America/Fort_Nelson': -420, 'America/Fortaleza': -180, 'America/Glace_Bay': -240, 'America/Goose_Bay': -240, 'America/Grand_Turk': -300, 'America/Grenada': -240, 'America/Guadeloupe': -240, 'America/Guatemala': -360, 'America/Guayaquil': -300, 'America/Guyana': -240, 'America/Halifax': -240, 'America/Havana': -300, 'America/Hermosillo': -420, 'America/Indiana/Indianapolis': -300, 'America/Indiana/Knox': -360, 'America/Indiana/Marengo': -300, 'America/Indiana/Petersburg': -300, 'America/Indiana/Tell_City': -360, 'America/Indiana/Vevay': -300, 'America/Indiana/Vincennes': -300, 'America/Indiana/Winamac': -300, 'America/Inuvik': -420, 'America/Iqaluit': -300, 'America/Jamaica': -300, 'America/Juneau': -540, 'America/Kentucky/Louisville': -300, 'America/Kentucky/Monticello': -300, 'America/Kralendijk': -240, 'America/La_Paz': -240, 'America/Lima': -300, 'America/Los_Angeles': -480, 'America/Lower_Princes': -240, 'America/Maceio': -180, 'America/Managua': -360, 'America/Manaus': -240, 'America/Marigot': -240, 'America/Martinique': -240, 'America/Matamoros': -360, 'America/Mazatlan': -420, 'America/Menominee': -360, 'America/Merida': -360, 'America/Metlakatla': -540, 'America/Mexico_City': -360, 'America/Miquelon': -180, 'America/Moncton': -240, 'America/Monterrey': -360, 'America/Montevideo': -180, 'America/Montserrat': -240, 'America/Nassau': -300, 'America/New_York': -300, 'America/Nome': -540, 'America/Noronha': -120, 'America/North_Dakota/Beulah': -360, 'America/North_Dakota/Center': -360, 'America/North_Dakota/New_Salem': -360, 'America/Nuuk': -120, 'America/Ojinaga': -360, 'America/Panama': -300, 'America/Paramaribo': -180, 'America/Phoenix': -420, 'America/Port-au-Prince': -300, 'America/Port_of_Spain': -240, 'America/Porto_Velho': -240, 'America/Puerto_Rico': -240, 'America/Punta_Arenas': -180, 'America/Rankin_Inlet': -360, 'America/Recife': -180, 'America/Regina': -360, 'America/Resolute': -360, 'America/Rio_Branco': -300, 'America/Santarem': -180, 'America/Santiago': -180, 'America/Santo_Domingo': -240, 'America/Sao_Paulo': -180, 'America/Scoresbysund': -120, 'America/Sitka': -540, 'America/St_Barthelemy': -240, 'America/St_Johns': -210, 'America/St_Kitts': -240, 'America/St_Lucia': -240, 'America/St_Thomas': -240, 'America/St_Vincent': -240, 'America/Swift_Current': -360, 'America/Tegucigalpa': -360, 'America/Thule': -240, 'America/Tijuana': -480, 'America/Toronto': -300, 'America/Tortola': -240, 'America/Vancouver': -480, 'America/Whitehorse': -420, 'America/Winnipeg': -360, 'America/Yakutat': -540,
  'Antarctica/Casey': 480, 'Antarctica/Davis': 420, 'Antarctica/DumontDUrville': 600, 'Antarctica/Macquarie': 660, 'Antarctica/Mawson': 300, 'Antarctica/McMurdo': 780, 'Antarctica/Palmer': -180, 'Antarctica/Rothera': -180, 'Antarctica/Syowa': 180, 'Antarctica/Troll': 0, 'Antarctica/Vostok': 300,
  'Arctic/Longyearbyen': 60,
  'Asia/Aden': 180, 'Asia/Almaty': 300, 'Asia/Amman': 180, 'Asia/Anadyr': 720, 'Asia/Aqtau': 300, 'Asia/Aqtobe': 300, 'Asia/Ashgabat': 300, 'Asia/Atyrau': 300, 'Asia/Baghdad': 180, 'Asia/Bahrain': 180, 'Asia/Baku': 240, 'Asia/Bangkok': 420, 'Asia/Barnaul': 420, 'Asia/Beirut': 120, 'Asia/Bishkek': 360, 'Asia/Brunei': 480, 'Asia/Chita': 540, 'Asia/Colombo': 330, 'Asia/Damascus': 180, 'Asia/Dhaka': 360, 'Asia/Dili': 540, 'Asia/Dubai': 240, 'Asia/Dushanbe': 300, 'Asia/Famagusta': 120, 'Asia/Gaza': 120, 'Asia/Hebron': 120, 'Asia/Ho_Chi_Minh': 420, 'Asia/Hong_Kong': 480, 'Asia/Hovd': 420, 'Asia/Irkutsk': 480, 'Asia/Jakarta': 420, 'Asia/Jayapura': 540, 'Asia/Jerusalem': 120, 'Asia/Kabul': 270, 'Asia/Kamchatka': 720, 'Asia/Karachi': 300, 'Asia/Kathmandu': 345, 'Asia/Khandyga': 540, 'Asia/Kolkata': 330, 'Asia/Krasnoyarsk': 420, 'Asia/Kuala_Lumpur': 480, 'Asia/Kuching': 480, 'Asia/Kuwait': 180, 'Asia/Macau': 480, 'Asia/Magadan': 660, 'Asia/Makassar': 480, 'Asia/Manila': 480, 'Asia/Muscat': 240, 'Asia/Nicosia': 120, 'Asia/Novokuznetsk': 420, 'Asia/Novosibirsk': 420, 'Asia/Omsk': 360, 'Asia/Oral': 300, 'Asia/Phnom_Penh': 420, 'Asia/Pontianak': 420, 'Asia/Pyongyang': 540, 'Asia/Qatar': 180, 'Asia/Qostanay': 300, 'Asia/Qyzylorda': 300, 'Asia/Riyadh': 180, 'Asia/Sakhalin': 660, 'Asia/Samarkand': 300, 'Asia/Seoul': 540, 'Asia/Shanghai': 480, 'Asia/Singapore': 480, 'Asia/Srednekolymsk': 660, 'Asia/Taipei': 480, 'Asia/Tashkent': 300, 'Asia/Tbilisi': 240, 'Asia/Tehran': 210, 'Asia/Thimphu': 360, 'Asia/Tokyo': 540, 'Asia/Tomsk': 420, 'Asia/Ulaanbaatar': 480, 'Asia/Urumqi': 360, 'Asia/Ust-Nera': 600, 'Asia/Vientiane': 420, 'Asia/Vladivostok': 600, 'Asia/Yakutsk': 540, 'Asia/Yangon': 390, 'Asia/Yekaterinburg': 300, 'Asia/Yerevan': 240,
  'Atlantic/Azores': -60, 'Atlantic/Bermuda': -240, 'Atlantic/Canary': 0, 'Atlantic/Cape_Verde': -60, 'Atlantic/Faroe': 0, 'Atlantic/Madeira': 0, 'Atlantic/Reykjavik': 0, 'Atlantic/South_Georgia': -120, 'Atlantic/St_Helena': 0, 'Atlantic/Stanley': -180,
  'Australia/Adelaide': 630, 'Australia/Brisbane': 600, 'Australia/Broken_Hill': 630, 'Australia/Darwin': 570, 'Australia/Eucla': 525, 'Australia/Hobart': 660, 'Australia/Lindeman': 600, 'Australia/Lord_Howe': 660, 'Australia/Melbourne': 660, 'Australia/Perth': 480, 'Australia/Sydney': 660,
  'Europe/Amsterdam': 60, 'Europe/Andorra': 60, 'Europe/Astrakhan': 240, 'Europe/Athens': 120, 'Europe/Belgrade': 60, 'Europe/Berlin': 60, 'Europe/Bratislava': 60, 'Europe/Brussels': 60, 'Europe/Bucharest': 120, 'Europe/Budapest': 60, 'Europe/Busingen': 60, 'Europe/Chisinau': 120, 'Europe/Copenhagen': 60, 'Europe/Dublin': 0, 'Europe/Gibraltar': 60, 'Europe/Guernsey': 0, 'Europe/Helsinki': 120, 'Europe/Isle_of_Man': 0, 'Europe/Istanbul': 180, 'Europe/Jersey': 0, 'Europe/Kaliningrad': 120, 'Europe/Kirov': 180, 'Europe/Kyiv': 120, 'Europe/Lisbon': 0, 'Europe/Ljubljana': 60, 'Europe/London': 0, 'Europe/Luxembourg': 60, 'Europe/Madrid': 60, 'Europe/Malta': 60, 'Europe/Mariehamn': 120, 'Europe/Minsk': 180, 'Europe/Monaco': 60, 'Europe/Moscow': 180, 'Europe/Oslo': 60, 'Europe/Paris': 60, 'Europe/Podgorica': 60, 'Europe/Prague': 60, 'Europe/Riga': 120, 'Europe/Rome': 60, 'Europe/Samara': 240, 'Europe/San_Marino': 60, 'Europe/Sarajevo': 60, 'Europe/Saratov': 240, 'Europe/Simferopol': 180, 'Europe/Skopje': 60, 'Europe/Sofia': 120, 'Europe/Stockholm': 60, 'Europe/Tallinn': 120, 'Europe/Tirane': 60, 'Europe/Ulyanovsk': 240, 'Europe/Vaduz': 60, 'Europe/Vatican': 60, 'Europe/Vienna': 60, 'Europe/Vilnius': 120, 'Europe/Volgograd': 180, 'Europe/Warsaw': 60, 'Europe/Zagreb': 60, 'Europe/Zurich': 60,
  'Indian/Antananarivo': 180, 'Indian/Chagos': 360, 'Indian/Christmas': 420, 'Indian/Cocos': 390, 'Indian/Comoro': 180, 'Indian/Kerguelen': 300, 'Indian/Mahe': 240, 'Indian/Maldives': 300, 'Indian/Mauritius': 240, 'Indian/Mayotte': 180, 'Indian/Reunion': 240,
  'Pacific/Apia': 780, 'Pacific/Auckland': 780, 'Pacific/Bougainville': 660, 'Pacific/Chatham': 825, 'Pacific/Chuuk': 600, 'Pacific/Easter': -300, 'Pacific/Efate': 660, 'Pacific/Fakaofo': 780, 'Pacific/Fiji': 720, 'Pacific/Funafuti': 720, 'Pacific/Galapagos': -360, 'Pacific/Gambier': -540, 'Pacific/Guadalcanal': 660, 'Pacific/Guam': 600, 'Pacific/Honolulu': -600, 'Pacific/Kanton': 780, 'Pacific/Kiritimati': 840, 'Pacific/Kosrae': 660, 'Pacific/Kwajalein': 720, 'Pacific/Majuro': 720, 'Pacific/Marquesas': -570, 'Pacific/Midway': -660, 'Pacific/Nauru': 720, 'Pacific/Niue': -660, 'Pacific/Norfolk': 720, 'Pacific/Noumea': 660, 'Pacific/Pago_Pago': -660, 'Pacific/Palau': 540, 'Pacific/Pitcairn': -480, 'Pacific/Pohnpei': 660, 'Pacific/Port_Moresby': 600, 'Pacific/Rarotonga': -600, 'Pacific/Saipan': 600, 'Pacific/Tahiti': -600, 'Pacific/Tarawa': 720, 'Pacific/Tongatapu': 780, 'Pacific/Wake': 720, 'Pacific/Wallis': 720
};

// Geo coordinates for timezones (fallback if API fails)
const TZ_GEO = {
    'America/New_York': '40.7128,-74.0060,1000',
    'America/Los_Angeles': '34.0522,-118.2437,1000',
    'America/Chicago': '41.8781,-87.6298,1000',
    'Europe/London': '51.5074,-0.1278,1000',
    'Europe/Paris': '48.8566,2.3522,1000',
    'Europe/Berlin': '52.5200,13.4050,1000',
    'Asia/Tokyo': '35.6762,139.6503,1000',
    'Asia/Shanghai': '31.2304,121.4737,1000',
    'Asia/Dubai': '25.2048,55.2708,1000',
    'Australia/Sydney': '-33.8688,151.2093,1000',
    'Pacific/Auckland': '-36.8509,174.7645,1000'
};

// Profile ID counter (persisted per profilesPath)
const getNextProfileId = (profilesPath) => {
    const counterFile = path.join(profilesPath, '.profile_counter');
    let id = 1;
    if (fs.existsSync(counterFile)) {
        id = parseInt(fs.readFileSync(counterFile, 'utf8')) + 1;
    }
    fs.mkdirSync(profilesPath, { recursive: true });
    fs.writeFileSync(counterFile, id.toString());
    return id;
};

/**
 * Start VCBrowser with spoofed fingerprint and CDP connection
 * @param {string} profileName - Profile name (used as directory name)
 * @param {Object} fingerprint - Fingerprint object from cdpFingerprint.js
 * @param {string} [url] - URL to open (default: about:blank)
 * @param {Object} [proxy] - Proxy config {ip, port, username, password}
 * @param {boolean} [headless] - Run headless (default: false)
 * @param {boolean} [automationMode] - Auto-grant all permissions for automation (default: false)
 * @returns {Promise<Object>} {process, client, debuggingPort, profileDir, geoData}
 */
async function startVCBrowser(profileName, fingerprint, url = 'about:blank', proxy = null, headless = false, automationMode = false) {
    require("./networkPolicy").assertAllowedUrl(url);
    const vcBrowserPath = getVCBrowserPath();
    
    if (!isVCBrowserInstalled()) {
        throw new Error('VCBrowser is not installed. Please download it from Settings.');
    }
    
    // Use profile directory in userData/profiles (same as Chrome)
    const userDataPath = app.getPath("userData");
    const profileDir = path.join(userDataPath, "profiles", profileName);
    fs.mkdirSync(profileDir, { recursive: true });
    
    // Clean up any stale Chrome folders that might block access
    cleanupStaleProfileFolders(profileDir);
    
    const fp = fingerprint;

    console.log(`[FINGERPRINTS] ${JSON.stringify(fingerprint)}`);
    
    // Convert proxy format from ViralCloner format to VCBrowser format
    const vcProxy = proxy ? {
        host: proxy.ip,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        type: 'http'
    } : {};
    
    console.log(`[VCBrowser] Proxy config for GeoIP lookup:`, vcProxy.host ? `${vcProxy.host}:${vcProxy.port}` : 'NO PROXY (direct connection)');
    
    // Fetch geo data from API (uses proxy if provided for accurate location)
    let geoData = null;
    let tz, geo, tzOffset;
    let publicIP = ''; // Public IP for WebRTC (from proxy or real IP)
    
    try {
        geoData = await fetchGeoData(vcProxy);
        console.log(`[VCBrowser] Raw GeoIP API response:`, JSON.stringify(geoData));
        if (geoData.status === 'success') {
            tz = geoData.timezone || fp.timezone || 'America/New_York';
            geo = `${geoData.lat},${geoData.lon},1000`;
            tzOffset = TZ_OFFSETS[tz] || -300;
            publicIP = geoData.query || ''; // This is the actual public IP seen by the internet
            console.log(`[VCBrowser GeoIP] ${geoData.city}, ${geoData.country} (${tz}) - ${geoData.query}`);
            console.log(`[VCBrowser] TIMEZONE TO USE: ${tz} (offset: ${tzOffset})`);
        } else {
            throw new Error('API returned failure: ' + JSON.stringify(geoData));
        }
    } catch (e) {
        // Fallback to fingerprint timezone + hardcoded geo
        console.log(`[GeoIP] API failed, using fallback: ${e.message}`);
        tz = fp.timezone || 'America/New_York';
        geo = TZ_GEO[tz] || '40.7128,-74.0060,1000';
        tzOffset = TZ_OFFSETS[tz] || -300;
        // If we have a proxy but couldn't fetch geo, use proxy host as fallback
        publicIP = vcProxy.host || '';
        console.log(`[VCBrowser] FALLBACK TIMEZONE: ${tz} (offset: ${tzOffset})`);
    }
    
    const langs = fp.languages?.join(',') || 'en-US,en';
    const acceptLang = fp.languages?.map((l, i) => i === 0 ? l : `${l};q=${(0.9 - i * 0.1).toFixed(1)}`).join(',') || 'en-US,en;q=0.9';

    // Generate consistent hardware IDs based on profile name
    const profileHash = hash(profileName);
    const macParts = [];
    for (let i = 0; i < 6; i++) {
        macParts.push(((profileHash.charCodeAt(i % profileHash.length) + i * 37) % 256).toString(16).padStart(2, '0').toUpperCase());
    }
    const macAddress = macParts.join('-');
    const deviceName = 'PC-' + profileHash.substring(0, 7).toUpperCase();

    // StaticConfig - Complete with all AdsPower fields
    const staticConfig = {
        HardwareConcurrencyNum: fp.hardwareConcurrency || 8,
        DeviceMemoryNum: fp.deviceMemory || 8,
        PlatformName: fp.platform || 'Win32',
        ScreenWidth: fp.screenResolution?.width || 1920,
        ScreenHeight: fp.screenResolution?.height || 1080,
        ScreenColorDepth: fp.colorDepth || 24,
        ScreenPixelDepth: fp.pixelDepth || 24,
        WindowOuterWidth: fp.screenResolution?.width || 1920,
        WindowOuterHeight: (fp.screenResolution?.height || 1080) - 40,
        AvailWidth: fp.screenResolution?.width || 1920,
        AvailHeight: (fp.screenResolution?.height || 1080) - 40,
        AvailLeft: 0, AvailTop: 0, ScreenLeft: 0, ScreenTop: 0,
        PluginNum: fp.plugins?.length || 5,
        PluginInfo: '',
        JavaEnabled: false,
        JavaPlugins: '',
        TimezoneNum: tzOffset,
        ClientRectsFp: '-666',
        PdfViewerEnabled: true,
        AppMinorVersion: '',
        NavigatorBattery: true,
        ConnectionInfo: 'wifi',
        CSSMedia: '',
        DoNotTrack: fp.doNotTrack || '0',
        OpenGLVendor: fp.webgl?.vendor || 'Google Inc. (NVIDIA)',
        OpenGLRenderer: fp.webgl?.renderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        SpeechLangs: fp.languages || ['en-US'],
        IsTouchSupported: false,
        MaxTouchPoints: 0,
        MSCSSCheck: false,
        MediaEncoder: true,
        MediaDecoder: true,
        OfflineAudioCtxFp: Math.round(fp.audioContext?.entropy || 331974),
        NavigatorCookieEnabled: fp.cookieEnabled !== false,
        WebRtcLocalIPMask: '172.16.' + Math.floor(Math.random() * 255) + '.' + Math.floor(Math.random() * 255),
        CanvasBlurVal: fp.canvas?.noiseLevel || 0.00004893471661710536,
        
        // Additional AdsPower fields - CRITICAL for avoiding detection
        SecurePreferenceSync: true,
        RestoreLastSession: true,
        FoceSafeBrowsing: true,
        AutomationControlled: true,
        MacAddress: macAddress,
        ProductType: deviceName,
        DeviceName: deviceName,
        
        // MediaDevices - audio/video device fingerprint
        MediaDevices: [
            { kind: 'audioinput', label: 'Microphone (Realtek(R) Audio)', deviceId: hash('audioinput-' + profileName).substring(0, 44) },
            { kind: 'videoinput', label: 'USB Camera', deviceId: hash('videoinput-' + profileName).substring(0, 44) },
            { kind: 'audiooutput', label: 'Speaker (Realtek(R) Audio)', deviceId: hash('audiooutput-' + profileName).substring(0, 44) }
        ],
        
        // TTSEngines - Speech synthesis voices (sites check this!)
        TTSEngines: [
            { name: 'Microsoft David - English (United States)', lang: 'en-US', default: true, localService: true },
            { name: 'Microsoft Zira - English (United States)', lang: 'en-US', default: false, localService: true },
            { name: 'Microsoft Mark - English (United States)', lang: 'en-US', default: false, localService: true },
            { name: 'Google US English', lang: 'en-US', default: false, localService: false },
            { name: 'Google UK English Female', lang: 'en-GB', default: false, localService: false },
            { name: 'Google UK English Male', lang: 'en-GB', default: false, localService: false },
            { name: 'Google español', lang: 'es-ES', default: false, localService: false },
            { name: 'Google français', lang: 'fr-FR', default: false, localService: false },
            { name: 'Google Deutsch', lang: 'de-DE', default: false, localService: false },
            { name: 'Google italiano', lang: 'it-IT', default: false, localService: false },
            { name: 'Google português do Brasil', lang: 'pt-BR', default: false, localService: false },
            { name: 'Google 日本語', lang: 'ja-JP', default: false, localService: false },
            { name: 'Google 한국의', lang: 'ko-KR', default: false, localService: false },
            { name: 'Google 中文（普通话）', lang: 'zh-CN', default: false, localService: false }
        ],
        
        // UserAgentMetadata (Client Hints) - CRITICAL, modern sites check this!
        UserAgentMetadata: {
            platform: 'Windows',
            platformVersion: '15.0.0',
            architecture: 'x86',
            model: '',
            mobile: false,
            wow64: false,
            bitness: '64'
        }
    };

    // DynamicConfig - AdsPower format with Version/Domains structure
    const dynamicConfig = {
        BlockList: { Version: '1', Domains: [] },
        StrongBlockList: { Version: '1', Domains: [] },
        WebRTCAddress: publicIP, // Use actual public IP, not proxy host
        TimeZone: tz,
        Geoposition: geo
    };

    // WebGL Config - Full extension list from docs
    const webglConfig = {
        SupportedExtensions: [
            'ANGLE_instanced_arrays',
            'EXT_blend_minmax',
            'EXT_color_buffer_half_float',
            'EXT_float_blend',
            'EXT_frag_depth',
            'EXT_shader_texture_lod',
            'EXT_texture_compression_bptc',
            'EXT_texture_compression_rgtc',
            'EXT_texture_filter_anisotropic',
            'EXT_sRGB',
            'OES_element_index_uint',
            'OES_fbo_render_mipmap',
            'OES_standard_derivatives',
            'OES_texture_float',
            'OES_texture_float_linear',
            'OES_texture_half_float',
            'OES_texture_half_float_linear',
            'OES_vertex_array_object',
            'WEBGL_color_buffer_float',
            'WEBGL_compressed_texture_s3tc',
            'WEBGL_compressed_texture_s3tc_srgb',
            'WEBGL_debug_renderer_info',
            'WEBGL_debug_shaders',
            'WEBGL_depth_texture',
            'WEBGL_draw_buffers',
            'WEBGL_lose_context'
        ]
    };

    // WebGL config uses AdsPower format (NOT encoded, plain JSON)
    // Extract GPU info from renderer string for GPUAdapterInfo
    const rendererStr = fp.webgl?.renderer || '';
    let gpuVendor = 'unknown';
    let gpuArchitecture = 'unknown';
    
    if (rendererStr.toLowerCase().includes('nvidia')) {
        gpuVendor = 'nvidia';
        gpuArchitecture = 'ampere';
    } else if (rendererStr.toLowerCase().includes('intel')) {
        gpuVendor = 'intel';
        gpuArchitecture = 'gen-12';
    } else if (rendererStr.toLowerCase().includes('amd') || rendererStr.toLowerCase().includes('radeon')) {
        gpuVendor = 'amd';
        gpuArchitecture = 'rdna-2';
    }
    
    const webglConfigAdsPower = {
        UNMASKED_VENDOR_WEBGL: fp.webgl?.vendor || 'Google Inc. (NVIDIA)',
        UNMASKED_RENDERER_WEBGL: fp.webgl?.renderer || 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        GPUAdapterInfo: {
            vendor: gpuVendor,
            architecture: gpuArchitecture
        },
        SUPPORTED_EXTENSIONS: webglConfig.SupportedExtensions
    };

    // Write config files
    const configHash = hash(profileName);
    const staticPath = path.join(profileDir, hash('static' + configHash));
    const dynamicPath = path.join(profileDir, hash('dynamic' + configHash));
    const webglPath = path.join(profileDir, hash('webgl' + configHash) + '_Other');
    
    // StaticConfig and DynamicConfig are encoded, WebGL is plain JSON (AdsPower format)
    fs.writeFileSync(staticPath, encode(staticConfig));
    fs.writeFileSync(dynamicPath, encode(dynamicConfig));
    fs.writeFileSync(webglPath, JSON.stringify(webglConfigAdsPower));
    
    console.log(`[VCBrowser] Config files written (encoded) to ${profileDir}`);
    console.log(`[VCBrowser] WebGL Vendor: ${staticConfig.OpenGLVendor}`);
    console.log(`[VCBrowser] WebGL Renderer: ${staticConfig.OpenGLRenderer}`);

    const startTime = Math.floor(Date.now() / 1000);

    // Extended parameters - ALL fingerprint data goes here (NOT in --protected-* flags)
    // This is encoded with custom Base64 and passed via --extended-parameters only
    
    // Generate profile-specific icon with ID banner
    const vcBrowserDir = path.dirname(vcBrowserPath);
    let customIconPath = await generateProfileIcon(profileName);
    
    // Fallback to static icon if generation failed
    if (!customIconPath) {
        customIconPath = fs.existsSync(path.join(vcBrowserDir, 'VCBrowser.ico')) 
            ? path.join(vcBrowserDir, 'VCBrowser.ico')
            : path.join(__dirname, '..', 'frontend', 'assets', 'images', 'VCBrowser.ico');
    }
    
    console.log(`[VCBrowser] Using icon for profile "${profileName}": ${customIconPath}`);
    
    const extParams = {
        UserId: profileName,
        CustomIcon: customIconPath,
        WebGLFP: webglPath,
        AudioFp: staticConfig.OfflineAudioCtxFp,
        StartTime: startTime,
        AllowScanPorts: '',
        GeolocationSetting: 'ask',
        FlashPluginSetting: 'block',
        Platform: staticConfig.PlatformName,
        DisableBackgroundMode: true,
        DisableContainer: true,
        HardwareConcurrency: staticConfig.HardwareConcurrencyNum,
        DeviceMemory: staticConfig.DeviceMemoryNum,
        LoadExtensionErrorBox: false,
        ClientRectFp: -666,
        CookiesFile: '',
        ForceProcessExit: true,
        ProxyUser: vcProxy.username || '',
        ProxyPassword: vcProxy.password || '',
        WebRTCAddress: publicIP, // Use actual public IP for WebRTC
        WebRTCLocalAddress: '', // Empty to hide local IP completely
        Langs: langs,
        AcceptLang: acceptLang,
        TimeZone: tz,
        Geoposition: geo,
        DynamicConfig: dynamicPath,
        StaticConfig: staticPath
    };

    // Build command args - AdsPower style (NO --protected-* flags!)
    // All fingerprint data goes ONLY in --extended-parameters
    const args = [
        `--host-resolver-rules=${require("./networkPolicy").browserHostRules}`,
        // Use port 0 for random port (port 9222 is easily detected)
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        `--user-agent=${fp.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'}`,
        
        // Standard Chrome flags
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain',
        '--export-tagged-pdf',
        '--no-default-browser-check',
        '--window-position=0,0',
        '--disable-background-mode',
        '--disable-renderer-accessibility',
        '--disable-legacy-window',
        '--fake-variations-channel=stable',
        '--variations-server-url=https://clientservices.googleapis.com/chrome-variations/seed',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--component-updater=initial-delay=6e5',
        `--lang=${fp.language || fp.languages?.[0] || 'en-US'}`,
        
        // Feature flags (critical for avoiding detection)
        '--enable-features=NetworkService,NetworkServiceInProcess,LoadCryptoTokenExtension,PermuteTLSExtensions',
        '--disable-features=FlashDeprecationWarning,EnablePasswordsAccountStorage',
        '--enable-blink-features=IdleDetection,Fledge',
        
        // WebRTC: Force public interface only, hide local IP addresses
        '--force-webrtc-ip-handling-policy=default_public_interface_only',
        '--webrtc-ip-handling-policy=default_public_interface_only',
        
        // Unique AppUserModelID per profile so Windows taskbar shows separate buttons with profile icons
        `--app-user-model-id=VCBrowser.Profile.${profileName}`
        
        // NO --protected-* flags here! All data goes in extended-parameters only
    ];
    
    // Headless mode
    if (headless) {
        args.push('--headless=new', '--window-size=1920,1080');
    } else {
        args.push('--start-maximized');
    }

    // Automation mode - auto-grant all permissions (clipboard, notifications, etc.)
    if (automationMode) {
        args.push(
            '--disable-notifications',
            '--disable-popup-blocking',
            '--disable-infobars',
            '--disable-features=PermissionChip',
            '--auto-accept-camera-and-microphone-capture',
            // Unsafely treat insecure origin as secure (helps with some permission APIs)
            '--unsafely-treat-insecure-origin-as-secure=http://localhost'
        );
        console.log('[VCBrowser] Automation mode enabled - auto-granting permissions');
    }

    // Proxy (only --proxy-server flag, proxy auth goes in extended-parameters)
    if (vcProxy.host && vcProxy.port) {
        const proxyType = vcProxy.type || 'http';
        args.push(`--proxy-server=${proxyType}://${vcProxy.host}:${vcProxy.port}`);
        args.push(`--proxy-bypass-list=${require("./networkPolicy").browserProxyBypass}`);
    }

    // Extended parameters MUST be added before the URL
    args.push(`--extended-parameters=${encode(extParams)}`);
    
    // URL goes last
    args.push(url);

    console.log(`[VCBrowser] Launching with ${args.length} args for profile: ${profileName}`);
    console.log(`[VCBrowser] Extended params keys: ${Object.keys(extParams).join(', ')}`);
    
    // Browser launch with retry logic (helps recover after sleep/resume)
    const MAX_LAUNCH_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 2000;
    let vcProcess = null;
    let client = null;
    let detectedPort = null;
    let lastLaunchError = null;
    
    for (let launchAttempt = 1; launchAttempt <= MAX_LAUNCH_ATTEMPTS; launchAttempt++) {
        try {
            if (launchAttempt > 1) {
                console.log(`[VCBrowser] Retry attempt ${launchAttempt}/${MAX_LAUNCH_ATTEMPTS} - waiting ${RETRY_DELAY_MS}ms before retry...`);
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
            
            // Launch browser process
            vcProcess = spawn(vcBrowserPath, args, { 
                detached: false, 
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, TZ: tz } 
            });

            // Track in the global registry so this profile's browser can be
            // found and killed before opening a fresh window for the same profile.
            _trackBrowserProcess(profileName, vcProcess);
            
            // Track if process exited early
            let processExited = false;
            let exitCode = null;
            
            vcProcess.on('exit', (code) => {
                processExited = true;
                exitCode = code;
                console.log(`[VCBrowser] Process exited with code: ${code}`);
                try {
                    const { cleanProfileCacheAfterClose } = require('./utils');
                    cleanProfileCacheAfterClose(profileDir).catch(() => {});
                } catch (e) {}
            });
            
            vcProcess.on('error', (err) => {
                console.error(`[VCBrowser] Process spawn error:`, err);
            });
            
            // Log stderr for debugging and capture the actual debugging port
            let actualPort = null;
            let stderrBuffer = '';
            let stdoutBuffer = '';
            
            const portPromise = new Promise((resolve) => {
                const checkForPort = (msg) => {
                    // Parse the actual port from DevTools listening message
                    // Handle different possible formats
                    const portMatch = msg.match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i);
                    if (portMatch && !actualPort) {
                        actualPort = parseInt(portMatch[1], 10);
                        console.log(`[VCBrowser] DevTools listening on port ${actualPort}`);
                        resolve(actualPort);
                        return true;
                    }
                    return false;
                };
                
                vcProcess.stderr.on('data', (data) => {
                    const msg = data.toString();
                    stderrBuffer += msg;
                    
                    // Check line by line
                    const lines = stderrBuffer.split('\n');
                    stderrBuffer = lines.pop() || ''; // Keep incomplete line in buffer
                    
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed) {
                            if (!checkForPort(trimmed)) {
                                console.log(`[VCBrowser stderr] ${trimmed}`);
                            }
                        }
                    }
                });
                
                // Also check stdout just in case
                vcProcess.stdout.on('data', (data) => {
                    const msg = data.toString();
                    stdoutBuffer += msg;
                    
                    const lines = stdoutBuffer.split('\n');
                    stdoutBuffer = lines.pop() || '';
                    
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed) {
                            if (!checkForPort(trimmed)) {
                                console.log(`[VCBrowser stdout] ${trimmed}`);
                            }
                        }
                    }
                });
                
                // Timeout after 20 seconds per attempt (increased from 15)
                setTimeout(() => {
                    if (!actualPort) {
                        console.log(`[VCBrowser] Port detection timeout (attempt ${launchAttempt}). Process exited: ${processExited}, exit code: ${exitCode}`);
                        console.log(`[VCBrowser] Remaining stderr buffer: ${stderrBuffer}`);
                        console.log(`[VCBrowser] Remaining stdout buffer: ${stdoutBuffer}`);
                    }
                    resolve(null);
                }, 20000);
            });

            // Wait for the actual port
            console.log(`[VCBrowser] Waiting for DevTools port (attempt ${launchAttempt}/${MAX_LAUNCH_ATTEMPTS})...`);
            detectedPort = await portPromise;
            
            if (!detectedPort) {
                console.error(`[VCBrowser] Failed to detect DevTools port (attempt ${launchAttempt}/${MAX_LAUNCH_ATTEMPTS})`);
                if (!processExited) {
                    try { vcProcess.kill(); } catch (e) { /* ignore */ }
                }
                lastLaunchError = new Error('Failed to detect DevTools port');
                continue; // Try again
            }

            // Wait for CDP to be ready on the detected port
            console.log(`[VCBrowser] Connecting to CDP on port ${detectedPort}...`);
            try {
                client = await waitForCDP(detectedPort);
                await client.Network.enable();
                await client.Network.setBlockedURLs({ urls: require("./networkPolicy").browserBlockedUrls });
                console.log(`[VCBrowser] CDP connected on port ${detectedPort}`);
            } catch (e) {
                console.error(`[VCBrowser] CDP connection failed (attempt ${launchAttempt}/${MAX_LAUNCH_ATTEMPTS}):`, e.message);
                try { vcProcess.kill(); } catch (killErr) { /* ignore */ }
                lastLaunchError = e;
                continue; // Try again
            }
            
            // Success - break out of retry loop
            lastLaunchError = null;
            break;
            
        } catch (launchErr) {
            console.error(`[VCBrowser] Launch attempt ${launchAttempt} failed:`, launchErr.message);
            lastLaunchError = launchErr;
            if (vcProcess && !vcProcess.killed) {
                try { vcProcess.kill(); } catch (e) { /* ignore */ }
            }
        }
    }
    
    // If all attempts failed, throw the last error
    if (lastLaunchError || !client || !detectedPort) {
        throw lastLaunchError || new Error('Failed to launch VCBrowser after all retry attempts');
    }

    // Grant permissions via CDP for automation mode
    if (automationMode && client) {
        try {
            const { Browser } = client;
            // Grant all relevant permissions to avoid any permission modals
            const permissions = [
                'clipboardReadWrite',
                'clipboardSanitizedWrite',
                'geolocation',
                'notifications',
                'midi',
                'midiSysex',
                'sensors',
                'backgroundSync',
                'backgroundFetch',
                'paymentHandler',
                'idleDetection',
                'storageAccess',
                'topLevelStorageAccess',
                'windowManagement'
            ];
            
            // Grant permissions globally (without origin = applies to all)
            await Browser.grantPermissions({ permissions });
            console.log('[VCBrowser] Granted all permissions globally via CDP');
            
            // Also grant to specific automation origins
            const automationOrigins = [
                'https://chatgpt.com',
                'https://chat.openai.com',
                'https://sites.google.com',
                'https://www.facebook.com',
                'https://facebook.com',
                'https://www.amazon.com',
                'https://amazon.com',
                'https://www.pinterest.com',
                'https://pinterest.com'
            ];
            
            for (const origin of automationOrigins) {
                try {
                    await Browser.grantPermissions({ permissions, origin });
                } catch (e) {
                    // Ignore individual origin errors
                }
            }
            console.log('[VCBrowser] Granted permissions to automation origins');
        } catch (permErr) {
            // Some permissions may not be supported in all Chrome versions
            console.log(`[VCBrowser] Permission granting warning: ${permErr.message}`);
            
            // Try granting minimal essential permissions without origin
            try {
                const { Browser } = client;
                await Browser.grantPermissions({
                    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
                });
                console.log('[VCBrowser] Granted clipboard permissions via CDP');
            } catch (e) {
                console.log(`[VCBrowser] Could not grant clipboard permissions: ${e.message}`);
            }
        }
    }

    // Stealth consistency patch (automation pages only). VCBrowser fingerprints
    // natively, but automation flags (--disable-notifications) and the CDP
    // grantPermissions('notifications') above leave Notification.permission at a
    // non-human value ('granted'/'denied') instead of the 'default' a normal
    // fresh session reports — a classic automation tell that can drive Facebook's
    // "confirm you're a real person" / selfie checkpoint. We normalize it (and
    // keep the Permissions API self-consistent) ONLY for automation runs, so the
    // safe manual sessions stay completely untouched. The patch is intentionally
    // minimal — it must NOT re-spoof anything VCBrowser already handles natively
    // (WebGL/canvas/etc.) to avoid creating a double-spoof inconsistency.
    if (automationMode && client) {
        try {
            const stealthPatch = `(function(){
  try {
    if (window.Notification) {
      Object.defineProperty(window.Notification, 'permission', { get: function(){ return 'default'; }, configurable: true });
    }
  } catch (e) {}
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var __q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(p){
        if (p && p.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', name: 'notifications', onchange: null, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return false; } });
        }
        return __q(p);
      };
    }
  } catch (e) {}
})();`;
            await client.Page.enable();
            await client.Page.addScriptToEvaluateOnNewDocument({ source: stealthPatch });
            console.log('[VCBrowser] Injected notification-consistency stealth patch');
        } catch (patchErr) {
            console.log(`[VCBrowser] Stealth patch injection warning: ${patchErr.message}`);
        }
    }

    // Apply custom window icon via Win32 API (backup for taskbar icon)
    // Chrome resets the window icon on every page navigation (title bar update).
    // During long-lived sessions like Discord profile creation (5-30+ min),
    // we must keep re-applying at intervals for the duration of the session.
    if (vcProcess && vcProcess.pid && customIconPath) {
        let browserAlive = true;
        vcProcess.once('exit', () => { browserAlive = false; });

        // Early retries cover initial startup and first page load
        const earlyDelays = [2000, 4000, 7000, 12000];
        for (const delay of earlyDelays) {
            setTimeout(async () => {
                if (!browserAlive) return;
                try { await applyWindowIcon(vcProcess.pid, customIconPath); } catch (_) {}
            }, delay);
        }

        // Sustained retries cover long-lived sessions (Discord login, profile creation, etc.)
        // Re-apply every 20s for up to 10 minutes, stopping when the process exits
        let sustainedCount = 0;
        const MAX_SUSTAINED = 30; // 30 × 20s = 10 minutes
        const sustainedInterval = setInterval(async () => {
            sustainedCount++;
            if (!browserAlive || sustainedCount > MAX_SUSTAINED) {
                clearInterval(sustainedInterval);
                return;
            }
            try { await applyWindowIcon(vcProcess.pid, customIconPath); } catch (_) {}
        }, 20000);
    }

    return { 
        chromeProcess: vcProcess, 
        client, 
        debuggingPort: detectedPort, 
        profileDir, 
        geoData,
        browserType: 'vcbrowser'
    };
}

module.exports = { 
    startVCBrowser, 
    isVCBrowserInstalled, 
    getVCBrowserPath,
    encode, 
    fetchGeoData,
    killBrowsersForProfile,
    isProfileBrowserRunning,
    gracefulCloseVCBrowser
};
