const crypto = require('crypto')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { readKey, updateData, killProfileBrowser } = require("../lib/utils")
const { startVCBrowser, isVCBrowserInstalled } = require('../lib/VCBrowserManager')
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require('../lib/cdpFingerprint')

// Timeout error logging
const LOG_FILE = path.join(app.getPath('userData'), 'google-sites-timeouts.log')

// Debug video recording directory
const RECORDINGS_DIR = path.join(app.getPath('userData'), 'Recordings', 'GoogleSites')

// Ensure recordings directory exists
try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true })
} catch (err) {
    console.error('[Google Sites] Failed to create recordings directory:', err.message)
}

// ==================== SCREENSHOT RECORDING FOR TIMEOUT DEBUGGING ====================

class ScreenshotRecorder {
    constructor(client, profileId, sessionId) {
        this.client = client
        this.profileId = profileId
        this.sessionId = sessionId
        this.frames = []
        this.intervalId = null
        this.isRecording = false
        this.startTime = Date.now()
        this.frameCount = 0
        this.maxFrames = 300 // Max 5 minutes at 1fps
    }
    
    async start() {
        if (this.isRecording) return
        this.isRecording = true
        console.log(`[Google Sites] Starting screenshot recording for session ${this.sessionId}`)
        
        // Capture first frame immediately
        await this.captureFrame()
        
        // Then capture every 1 second
        this.intervalId = setInterval(async () => {
            if (this.isRecording && this.frameCount < this.maxFrames) {
                await this.captureFrame()
            }
        }, 1000)
    }
    
    async captureFrame() {
        try {
            if (!this.client || this.client._disconnected) {
                return
            }
            
            const { data } = await this.client.send('Page.captureScreenshot', {
                format: 'jpeg',
                quality: 60 // Lower quality for smaller files
            })
            
            this.frames.push({
                timestamp: Date.now() - this.startTime,
                data: data // Base64 encoded
            })
            this.frameCount++
        } catch (err) {
            // Silently ignore capture errors (browser might be busy)
        }
    }
    
    stop() {
        this.isRecording = false
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
        console.log(`[Google Sites] Stopped recording for session ${this.sessionId}, captured ${this.frameCount} frames`)
    }
    
    async saveAsVideo(reason, currentStep) {
        this.stop()
        
        if (this.frames.length === 0) {
            console.log('[Google Sites] No frames captured, skipping video save')
            return null
        }
        
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
            const videoDir = path.join(RECORDINGS_DIR, `${this.profileId}_${timestamp}`)
            fs.mkdirSync(videoDir, { recursive: true })
            
            console.log(`[Google Sites] Saving ${this.frames.length} frames to ${videoDir}`)
            
            // Save frames as individual images
            for (let i = 0; i < this.frames.length; i++) {
                const frame = this.frames[i]
                const frameNumber = String(i).padStart(5, '0')
                const framePath = path.join(videoDir, `frame_${frameNumber}.jpg`)
                fs.writeFileSync(framePath, Buffer.from(frame.data, 'base64'))
            }
            
            // Save metadata
            const metadata = {
                profileId: this.profileId,
                sessionId: this.sessionId,
                reason: reason,
                currentStep: currentStep,
                startTime: new Date(this.startTime).toISOString(),
                endTime: new Date().toISOString(),
                duration: Date.now() - this.startTime,
                frameCount: this.frames.length,
                frames: this.frames.map((f, i) => ({
                    index: i,
                    timestamp: f.timestamp
                }))
            }
            fs.writeFileSync(
                path.join(videoDir, 'metadata.json'),
                JSON.stringify(metadata, null, 2)
            )
            
            // Create HTML viewer for easy playback
            const htmlViewer = this.generateHtmlViewer(this.frames.length, reason, currentStep)
            fs.writeFileSync(path.join(videoDir, 'viewer.html'), htmlViewer)
            
            console.log(`[Google Sites] Recording saved: ${videoDir}`)
            console.log(`[Google Sites] Open viewer.html to play back the recording`)
            
            // Clear frames from memory
            this.frames = []
            
            return videoDir
        } catch (err) {
            console.error('[Google Sites] Failed to save recording:', err.message)
            return null
        }
    }
    
    generateHtmlViewer(frameCount, reason, currentStep) {
        return `<!DOCTYPE html>
<html>
<head>
    <title>Google Sites Timeout Recording - ${this.profileId}</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            background: #1a1a2e; 
            color: #fff; 
            margin: 0; 
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .header {
            text-align: center;
            margin-bottom: 20px;
        }
        .header h1 { color: #ff6b6b; margin: 0; }
        .header p { color: #aaa; margin: 5px 0; }
        .info-box {
            background: #252545;
            padding: 15px 25px;
            border-radius: 10px;
            margin-bottom: 20px;
            max-width: 800px;
        }
        .info-box p { margin: 5px 0; }
        .info-box strong { color: #ffc107; }
        .player {
            position: relative;
            background: #000;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        }
        #frame {
            max-width: 100%;
            max-height: 70vh;
            display: block;
        }
        .controls {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-top: 15px;
            background: #252545;
            padding: 15px 25px;
            border-radius: 10px;
        }
        button {
            background: #4caf50;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover { background: #66bb6a; }
        button:disabled { background: #555; cursor: not-allowed; }
        #playBtn { min-width: 80px; }
        input[type="range"] {
            flex: 1;
            min-width: 200px;
        }
        .frame-info {
            color: #aaa;
            min-width: 120px;
            text-align: right;
        }
        .speed-control {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .speed-control label { color: #aaa; }
        select {
            background: #333;
            color: #fff;
            border: 1px solid #555;
            padding: 5px;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔴 Google Sites Timeout Recording</h1>
        <p>Profile: ${this.profileId} | Session: ${this.sessionId}</p>
    </div>
    
    <div class="info-box">
        <p><strong>Reason:</strong> ${reason}</p>
        <p><strong>Last Step:</strong> ${currentStep}</p>
        <p><strong>Total Frames:</strong> ${frameCount} (${Math.round(frameCount)}s recording)</p>
    </div>
    
    <div class="player">
        <img id="frame" src="frame_00000.jpg" alt="Frame">
    </div>
    
    <div class="controls">
        <button id="playBtn" onclick="togglePlay()">▶ Play</button>
        <input type="range" id="slider" min="0" max="${frameCount - 1}" value="0" oninput="seekTo(this.value)">
        <span class="frame-info" id="frameInfo">Frame 1 / ${frameCount}</span>
        <div class="speed-control">
            <label>Speed:</label>
            <select id="speed" onchange="setSpeed(this.value)">
                <option value="0.5">0.5x</option>
                <option value="1" selected>1x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
            </select>
        </div>
    </div>
    
    <script>
        const totalFrames = ${frameCount};
        let currentFrame = 0;
        let isPlaying = false;
        let playInterval = null;
        let speed = 1;
        
        function updateFrame() {
            const frameNum = String(currentFrame).padStart(5, '0');
            document.getElementById('frame').src = 'frame_' + frameNum + '.jpg';
            document.getElementById('slider').value = currentFrame;
            document.getElementById('frameInfo').textContent = 'Frame ' + (currentFrame + 1) + ' / ' + totalFrames;
        }
        
        function togglePlay() {
            if (isPlaying) {
                pause();
            } else {
                play();
            }
        }
        
        function play() {
            if (currentFrame >= totalFrames - 1) currentFrame = 0;
            isPlaying = true;
            document.getElementById('playBtn').textContent = '⏸ Pause';
            playInterval = setInterval(() => {
                if (currentFrame < totalFrames - 1) {
                    currentFrame++;
                    updateFrame();
                } else {
                    pause();
                }
            }, 1000 / speed);
        }
        
        function pause() {
            isPlaying = false;
            document.getElementById('playBtn').textContent = '▶ Play';
            if (playInterval) {
                clearInterval(playInterval);
                playInterval = null;
            }
        }
        
        function seekTo(frame) {
            currentFrame = parseInt(frame);
            updateFrame();
        }
        
        function setSpeed(newSpeed) {
            speed = parseFloat(newSpeed);
            if (isPlaying) {
                pause();
                play();
            }
        }
        
        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
            if (e.code === 'ArrowLeft') { currentFrame = Math.max(0, currentFrame - 1); updateFrame(); }
            if (e.code === 'ArrowRight') { currentFrame = Math.min(totalFrames - 1, currentFrame + 1); updateFrame(); }
        });
    </script>
</body>
</html>`
    }
    
    discard() {
        this.stop()
        this.frames = []
        console.log(`[Google Sites] Discarded recording for session ${this.sessionId}`)
    }
}

// ==================== GOOGLE ACCOUNT DISCONNECTION MANAGEMENT ====================

// Track disconnected/blocked Google profiles (runtime state)
const googleDisconnectedState = new Map()  // profileId -> { blocked: boolean, since: timestamp }

// Queue of disconnected profiles for UI notification (show one at a time with count)
const disconnectedProfileQueue = []

// Broadcast event to all renderer windows
function broadcastToRenderers(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
        try { 
            if (!win.isDestroyed()) {
                win.webContents.send(channel, payload)
            }
        } catch (_) { }
    }
}

// Check if a Google profile is blocked due to disconnection
function isGoogleBlocked(profileId) {
    return !!(googleDisconnectedState.get(profileId)?.blocked)
}

// Get all currently blocked profile IDs
function getBlockedGoogleProfiles() {
    const blocked = []
    for (const [profileId, state] of googleDisconnectedState.entries()) {
        if (state.blocked) blocked.push(profileId)
    }
    return blocked
}

// Block a Google profile due to disconnection
async function blockGoogleProfile(profileId) {
    const prev = googleDisconnectedState.get(profileId) || {}
    if (!prev.blocked) {
        console.log(`[Google Sites] Blocking profile ${profileId} due to disconnection`)
        googleDisconnectedState.set(profileId, { blocked: true, since: Date.now() })
        // Kill any open non-headless browser window for this profile
        killProfileBrowser(profileId)
        
        // Update profile status in storage
        try {
            const googleProfiles = (await readKey('googleProfiles')) || {}
            if (googleProfiles[profileId]) {
                googleProfiles[profileId].status = 'disconnected'
                await updateData('googleProfiles', googleProfiles)
            }
        } catch (err) {
            console.error('[Google Sites] Failed to update profile status:', err.message)
        }
        
        // Add to queue if not already present
        if (!disconnectedProfileQueue.includes(profileId)) {
            disconnectedProfileQueue.push(profileId)
        }
        
        // Send notifications
        const blockedProfiles = getBlockedGoogleProfiles()
        const payload = { 
            profileId, 
            blockedCount: blockedProfiles.length,
            allBlockedProfiles: blockedProfiles
        }
        
        broadcastToRenderers('google-account-disconnected', payload)
        
        // Send system notification
        try {
            const systemNotifications = require('../lib/systemNotifications')
            systemNotifications.sendNotification('googleDisconnected', { profileId })
        } catch (err) {
            console.error('[Google Sites] Failed to send system notification:', err.message)
        }
        
        // Send Telegram notification
        try {
            const telegramNotifications = require('../lib/telegramNotifications')
            telegramNotifications.sendNotification('googleDisconnected', { profileId })
        } catch (err) {
            console.error('[Google Sites] Failed to send Telegram notification:', err.message)
        }
    }
}

// Unblock a Google profile after reconnection
async function unblockGoogleProfile(profileId) {
    const prev = googleDisconnectedState.get(profileId)
    if (prev?.blocked) {
        console.log(`[Google Sites] Unblocking profile ${profileId} - reconnected`)
        googleDisconnectedState.set(profileId, { blocked: false })
        
        // Update profile status in storage
        try {
            const googleProfiles = (await readKey('googleProfiles')) || {}
            if (googleProfiles[profileId]) {
                googleProfiles[profileId].status = 'connected'
                await updateData('googleProfiles', googleProfiles)
            }
        } catch (err) {
            console.error('[Google Sites] Failed to update profile status:', err.message)
        }
        
        // Remove from queue
        const queueIdx = disconnectedProfileQueue.indexOf(profileId)
        if (queueIdx !== -1) {
            disconnectedProfileQueue.splice(queueIdx, 1)
        }
        
        const blockedProfiles = getBlockedGoogleProfiles()
        const payload = { 
            profileId,
            blockedCount: blockedProfiles.length,
            allBlockedProfiles: blockedProfiles,
            // If more profiles need attention, send the next one
            nextProfileId: disconnectedProfileQueue.length > 0 ? disconnectedProfileQueue[0] : null
        }
        
        broadcastToRenderers('google-account-reconnected', payload)
        
        // Send system notification
        try {
            const systemNotifications = require('../lib/systemNotifications')
            systemNotifications.sendNotification('googleReconnected', { profileId })
        } catch (err) {
            console.error('[Google Sites] Failed to send system notification:', err.message)
        }
        
        // Send Telegram notification
        try {
            const telegramNotifications = require('../lib/telegramNotifications')
            telegramNotifications.sendNotification('googleReconnected', { profileId })
        } catch (err) {
            console.error('[Google Sites] Failed to send Telegram notification:', err.message)
        }
        
        // Resume queue processing
        processQueue()
    }
}

// Get count of remaining blocked profiles
function getBlockedProfileCount() {
    return getBlockedGoogleProfiles().length
}

// Check if ALL profiles are blocked (no available profiles to use)
async function areAllProfilesBlocked() {
    const connected = await getConnectedGoogleProfiles()
    if (connected.length === 0) return true
    
    for (const profileId of connected) {
        if (!isGoogleBlocked(profileId)) {
            return false
        }
    }
    return true
}

// ==================== ANTI-DETECTION UTILITIES ====================

// Profile tracking (cooldowns disabled for speed)
const profileLastUsed = new Map()

// Fast minimal delay - just enough for UI to respond
function fastDelay(ms = 50) {
    return new Promise(r => setTimeout(r, ms))
}

// Legacy function names kept for compatibility but made fast
function humanDelay(baseMs, variance = 0) {
    // Use minimal delay regardless of input
    return new Promise(r => setTimeout(r, Math.min(50, baseMs * 0.1)))
}

function microDelay() {
    return new Promise(r => setTimeout(r, 10))
}

async function maybeHesitate() {
    // No hesitation - speed mode
}

// Fast direct mouse move - no bezier curves
async function humanMouseMove(client, fromX, fromY, toX, toY) {
    // Direct move to target - no path animation
    await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: toX,
        y: toY
    })
}

// Fast direct click
async function humanClick(client, x, y, currentX = null, currentY = null) {
    // Direct click - no movement animation
    await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: x,
        y: y,
        button: 'left',
        clickCount: 1
    })
    
    await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x,
        y: y,
        button: 'left',
        clickCount: 1
    })
    
    return { x: x, y: y }
}

// Fast direct drag operation
async function humanDrag(client, startX, startY, endX, endY) {
    // Mouse down at start
    await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: startX,
        y: startY,
        button: 'left',
        clickCount: 1
    })
    
    // Move directly to end position
    await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: endX,
        y: endY,
        button: 'left'
    })
    
    // Release at end
    await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: endX,
        y: endY,
        button: 'left',
        clickCount: 1
    })
    
    await fastDelay(20)
}

// Fast direct text input - no character-by-character typing
async function humanType(client, Runtime, selector, text) {
    // Set value directly and dispatch events
    const safeText = JSON.stringify(text)
    await Runtime.evaluate({
        expression: `(() => {
            const el = document.querySelector('${selector}');
            if (el) {
                el.focus();
                el.value = ${safeText};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        })()`
    })
}

// Fast direct scroll
async function humanScroll(client, Runtime, scrollExpression, amount = 500) {
    await Runtime.evaluate({ expression: scrollExpression })
}

// No-op - global delay disabled for speed
async function enforceGlobalDelay(configuredDelayMs = 0) {
    // Disabled for maximum concurrency
}

// No-op - profile cooldown disabled for speed
async function enforceProfileCooldown(profileId) {
    // Disabled for maximum concurrency
}

// Mark profile as used
function markProfileUsed(profileId) {
    profileLastUsed.set(profileId, Date.now())
}

// Fast session - no random delays
function getSessionCharacteristics() {
    return {
        initialDelay: 0,
        speedMultiplier: 0.1, // 10% of normal delays
        hesitationProbability: 0
    }
}

function logTimeoutError(profileId, htmlPreview, errorDetails, duration, currentStep) {
    const timestamp = new Date().toISOString()
    const separator = '='.repeat(80)
    const logEntry = `
${separator}
GOOGLE SITES TIMEOUT ERROR
${separator}
Timestamp: ${timestamp}
Profile ID: ${profileId}
Duration before timeout: ${duration}ms
Last Step Reached: ${currentStep || 'Unknown'}
Error: ${errorDetails}

HTML Preview (first 500 chars):
${htmlPreview.substring(0, 500)}

HTML Length: ${htmlPreview.length} characters
${separator}

`
    try {
        fs.appendFileSync(LOG_FILE, logEntry, 'utf8')
        console.log(`[Google Sites] Timeout error logged to: ${LOG_FILE}`)
    } catch (err) {
        console.error('[Google Sites] Failed to write timeout log:', err.message)
    }
}

// Timeout management removed - this node has sophisticated concurrency control
// and queue systems that manage execution timing internally

const queue = []
let activeCount = 0
let MAX_CONCURRENT = 5 // Default fallback

// Initialize the concurrency limit from settings
async function initializeConcurrency() {
    try {
        const automationSettings = (await readKey('automationSettings')) || {
            maxConcurrency: 10,
            nodeRetryCount: 3,
            imageUploadMaxConcurrency: 1
        }
        MAX_CONCURRENT = automationSettings.maxConcurrency
        console.log(`Google Sites concurrency set to: ${MAX_CONCURRENT}`)
    } catch (error) {
        console.error('Error loading concurrency settings:', error)
        MAX_CONCURRENT = 10 // Use default if error
    }
}

// Initialize on module load
initializeConcurrency()

const profileLocks = new Set()

function delay(ms) {
    return new Promise(r => setTimeout(r, ms))
}

async function acquireProfile(profileId) {
    while (profileLocks.has(profileId)) {
        await delay(250)
    }
    profileLocks.add(profileId)
    let released = false
    return () => {
        if (!released) {
            released = true
            profileLocks.delete(profileId)
        }
    }
}

async function pickRandomAvailableProfile(getListFn) {
    while (true) {
        const connected = await getListFn()
        if (!connected || connected.length === 0) {
            throw new Error("No connected Google profiles found")
        }
        // Filter out locked profiles AND blocked (disconnected) profiles
        const available = connected.filter(p => !profileLocks.has(p) && !isGoogleBlocked(p))
        if (available.length > 0) {
            // Prefer profiles that haven't been used recently (better for anti-detection)
            const now = Date.now()
            const sortedByLastUse = available.sort((a, b) => {
                const aLastUsed = profileLastUsed.get(a) || 0
                const bLastUsed = profileLastUsed.get(b) || 0
                return aLastUsed - bLastUsed // Oldest first
            })
            
            // Pick from the least recently used profiles with some randomness
            // Take top 50% least recently used and pick randomly from those
            const leastUsedPool = sortedByLastUse.slice(0, Math.max(1, Math.ceil(sortedByLastUse.length * 0.5)))
            const idx = Math.floor(Math.random() * leastUsedPool.length)
            return leastUsedPool[idx]
        }
        
        // Check if ALL profiles are blocked - if so, throw error to stop workflow
        if (await areAllProfilesBlocked()) {
            throw new Error("All Google profiles are disconnected. Please reconnect at least one profile.")
        }
        
        await delay(300)
    }
}

function generateRandomString(length = 30) {
    return crypto
        .randomBytes(length)
        .toString('base64')
        .replace(/[^a-zA-Z]/g, '')
        .substring(0, length)
}

async function _googleSites(HTML, PROFILE_ID, resources, progressTracker) {
    const SLUG = generateRandomString()
    const URL = `https://sites.google.com/view/${SLUG}`
    const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    let chromeProcess, client
    let recorder = null
    
    // Get randomized session characteristics for this run
    const session = getSessionCharacteristics()
    let mouseX = 400, mouseY = 300 // Track mouse position for natural movement
    
    const setStep = (step) => {
        if (progressTracker) progressTracker.currentStep = step
        console.log(`[Google Sites] ${step}`)
    }
    
    try {
        setStep('1. Checking VCBrowser installation')
        // Check if VCBrowser is installed
        if (!isVCBrowserInstalled()) {
            return { success: false, value: "VCBrowser is not installed" }
        }
        
        // Profile cooldown is now enforced BEFORE the timeout starts (in googleSitesSingle)
        // This was moved to prevent the cooldown from consuming the timeout window
        
        setStep('2. Generating fingerprint')
        // Generate consistent fingerprint for the profile
        const fingerprint = getConsistentFingerprintForProfile(PROFILE_ID)
        
        // Update to VCBrowser's actual version to avoid fingerprint detection
        try {
          const vcVersion = getVCBrowserVersion()
          if (fingerprint.userAgent && vcVersion?.full) {
            fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`)
          }
        } catch (e) { /* use fallback */ }
        
        setStep('3. Starting VCBrowser')
        // Use VCBrowser for Google Sites (automationMode=true to auto-grant permissions)
        const browser = await startVCBrowser(
            PROFILE_ID,
            fingerprint,
            "https://sites.google.com/u/0/create?usp=sites_home&ths=true",
            null,  // no proxy
            true,  // headless
            true   // automationMode - auto-grant permissions
        )
        chromeProcess = browser.chromeProcess
        client = browser.client
        client.on('disconnect', () => {
            client._disconnected = true
        })
        resources.chromeProcess = chromeProcess
        resources.client = client
        const { Page, Runtime, DOM } = client
        
        setStep('4. Enabling CDP domains')
        await Promise.all([Page.enable(), Runtime.enable(), DOM.enable()])
        await client.send('Input.setIgnoreInputEvents', { ignore: false })
        
        // Start screenshot recording for timeout debugging
        recorder = new ScreenshotRecorder(client, PROFILE_ID, sessionId)
        resources.recorder = recorder
        await recorder.start()
        
        // Minimal delay for page to initialize
        await fastDelay(100)
        
        setStep('5. Waiting for page navigation')
        // Wait for navigation to actual URL (not about:blank)
        const targetUrl = 'sites.google.com'
        for (let i = 0; i < 60; i++) {
            const urlCheck = await Runtime.evaluate({ 
                expression: 'window.location.href',
                returnByValue: true 
            })
            const currentHref = urlCheck.result.value
            if (currentHref && currentHref.includes(targetUrl)) {
                setStep('5. Navigation complete - reached sites.google.com')
                break
            }
            if (i % 10 === 0) {
                setStep(`5. Waiting for navigation (attempt ${i}/60)... current: ${currentHref}`)
            }
            await fastDelay(200)
        }
        
        setStep('6. Waiting for document ready state')
        // Wait for document ready state to be complete
        for (let i = 0; i < 30; i++) {
            const readyState = await Runtime.evaluate({ 
                expression: 'document.readyState',
                returnByValue: true 
            })
            if (readyState.result.value === 'complete') {
                setStep('6. Document ready state: complete')
                break
            }
            await fastDelay(200)
        }
        
        // Quick pause for page to settle
        await fastDelay(300)
        
        setStep('7. Checking login status')
        const currentUrl = await Runtime.evaluate({ expression: 'window.location.href' })
        console.log('[Google Sites] Current URL:', currentUrl.result.value)
        if (currentUrl.result.value.includes("accounts.google.com")) {
            // Block this profile due to disconnection
            await blockGoogleProfile(PROFILE_ID)
            return { 
                success: false, 
                value: "Account disconnected - profile blocked",
                disconnected: true,
                profileId: PROFILE_ID
            }
        }
        
        setStep('8. Closing intro dialogs')
        while (true) {
            const count = await Runtime.evaluate({
                expression: 'document.querySelectorAll(\'[style*="background-image: url(https://ssl.gstatic.com/atari/images/simple-header-blended.png)"]\').length',
            })
            if (count.result.value === 0) break
            
            // Get button position for human-like click
            const btnPos = await Runtime.evaluate({
                expression: `(() => {
                    const btn = document.querySelectorAll("[data-tooltip-x-position][tabindex]")[1];
                    if (!btn) return null;
                    const rect = btn.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()`,
                returnByValue: true
            })
            
            if (btnPos.result.value) {
                const pos = await humanClick(client, btnPos.result.value.x, btnPos.result.value.y, mouseX, mouseY)
                mouseX = pos.x; mouseY = pos.y
            } else {
                await Runtime.evaluate({
                    expression: 'document.querySelectorAll("[data-tooltip-x-position][tabindex]")[1].click()',
                }).catch(() => { })
            }
            await fastDelay(300)
        }
        
        setStep('9. Opening Insert menu')
        // Get Insert menu position
        const insertMenuPos = await Runtime.evaluate({
            expression: `(() => {
                const menu = document.querySelectorAll('[role="menubar"] [role="menuitem"]')[4];
                if (!menu) return null;
                const rect = menu.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            })()`,
            returnByValue: true
        })
        
        if (insertMenuPos.result.value) {
            const pos = await humanClick(client, insertMenuPos.result.value.x, insertMenuPos.result.value.y, mouseX, mouseY)
            mouseX = pos.x; mouseY = pos.y
        } else {
            await Runtime.evaluate({
                expression: 'document.querySelectorAll(\'[role="menubar"] [role="menuitem"]\')[4].click()',
            })
        }
        
        await fastDelay(200)
        
        setStep('10. Switching to Embed tab')
        for (let i = 0; i < 3; i++) {
            const tabPos = await Runtime.evaluate({
                expression: `(() => {
                    const tab = document.querySelector('[data-background-click-cancel="false"] [role="tablist"]')
                        ?.querySelectorAll('[role="tab"]')[1];
                    if (!tab) return null;
                    const rect = tab.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()`,
                returnByValue: true
            })
            
            if (tabPos.result.value) {
                const pos = await humanClick(client, tabPos.result.value.x, tabPos.result.value.y, mouseX, mouseY)
                mouseX = pos.x; mouseY = pos.y
            } else {
                await Runtime.evaluate({
                    expression: `document.querySelector('[data-background-click-cancel="false"] [role="tablist"]')
                        ?.querySelectorAll('[role="tab"]')[1]?.click()`
                })
            }
            await fastDelay(150)
        }
        
        setStep('11. Inserting HTML content into textarea')
        // For large HTML, use clipboard-style paste (faster and more natural for large content)
        const safeHTML = JSON.stringify(HTML)
        
        // Focus textarea first
        await Runtime.evaluate({
            expression: `document.querySelector('[data-background-click-cancel="false"] textarea')?.focus()`
        })
        await fastDelay(50)
        
        // Simulate paste behavior (select all, then paste)
        await Runtime.evaluate({
            expression: `(() => {
                const html = ${safeHTML};
                const textarea = document.querySelector('[data-background-click-cancel="false"] textarea');
                if (!textarea) return;
                textarea.focus();
                textarea.select();
            })()`
        })
        await microDelay()
        
        // Small chunks insertion to simulate paste
        await Runtime.evaluate({
            expression: `(() => {
                const html = ${safeHTML};
                const textarea = document.querySelector('[data-background-click-cancel="false"] textarea');
                if (!textarea) return;
                textarea.value = html;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            })()`
        })
        
        await fastDelay(300)
        
        setStep('12. Waiting for embed preview (clicking Next)')
        let nextClickAttempts = 0
        while (nextClickAttempts < 20) {
            await fastDelay(1000)
            const count = await Runtime.evaluate({
                expression: 'document.querySelectorAll(\'[data-background-click-cancel="false"] div[role="button"]\').length',
            })
            if (count.result.value === 3) break
            
            // Get Next button position for human click
            const nextBtnPos = await Runtime.evaluate({
                expression: `(() => {
                    const btn = document.querySelectorAll('[data-background-click-cancel="false"] div[role="button"]')[1];
                    if (!btn) return null;
                    const rect = btn.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()`,
                returnByValue: true
            })
            
            if (nextBtnPos.result.value) {
                const pos = await humanClick(client, nextBtnPos.result.value.x, nextBtnPos.result.value.y, mouseX, mouseY)
                mouseX = pos.x; mouseY = pos.y
            } else {
                await Runtime.evaluate({
                    expression: 'document.querySelectorAll(\'[data-background-click-cancel="false"] div[role="button"]\')[1].click()',
                }).catch(() => { })
            }
            nextClickAttempts++
        }
        
        setStep('13. Inserting embed into page')
        let insertAttempts = 0
        while (insertAttempts < 20) {
            await fastDelay(1000)
            const count = await Runtime.evaluate({
                expression: 'document.querySelectorAll(\'[data-background-click-cancel]\').length',
            })
            if (count.result.value === 0) break
            
            // Get Insert button position
            const insertBtnPos = await Runtime.evaluate({
                expression: `(() => {
                    const btn = document.querySelectorAll('[data-background-click-cancel] div[role="button"]')[2];
                    if (!btn) return null;
                    const rect = btn.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()`,
                returnByValue: true
            })
            
            if (insertBtnPos.result.value) {
                const pos = await humanClick(client, insertBtnPos.result.value.x, insertBtnPos.result.value.y, mouseX, mouseY)
                mouseX = pos.x; mouseY = pos.y
            } else {
                await Runtime.evaluate({
                    expression: 'document.querySelectorAll(\'[data-background-click-cancel] div[role="button"]\')[2].click()',
                }).catch(() => { })
            }
            insertAttempts++
        }
        
        await fastDelay(200)
        
        setStep('14. Finding horizontal resize handle')
        const { result: horizontal } = await Runtime.evaluate({
            expression: `
                (function() {
                    const group = document.querySelectorAll('group');
                    if (!group.length) return null;
                    const el = group[group.length - 1].querySelector('[data-verticalbound="center"][data-horizontalbound="right"]');
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()
            `,
            returnByValue: true
        })
        if (!horizontal.value) throw new Error("Horizontal resize dot not found")
        
        setStep('15. Resizing embed horizontally')
        const { x: x1, y: y1 } = horizontal.value
        await humanDrag(client, x1, y1, x1 + 600, y1)
        mouseX = x1 + 600; mouseY = y1
        
        await fastDelay(100)
        
        // Fixed 10 vertical resize iterations for speed
        const verticalIterations = 10
        setStep(`16. Resizing embed vertically (${verticalIterations} iterations)`)
        
        for (let i = 0; i < verticalIterations; i++) {
            setStep(`16. Resizing embed vertically (iteration ${i + 1}/${verticalIterations})`)
            
            // Scroll to bottom
            await Runtime.evaluate({
                expression: `document.querySelector("[data-left-pinnable] [dir='ltr']").scrollTo(0, 99999999)`
            })
            await fastDelay(100)
            
            const { result: vertical } = await Runtime.evaluate({
                expression: `
                    (function() {
                        const group = document.querySelectorAll('group');
                        if (!group.length) return null;
                        const el = group[group.length - 1].querySelector('[data-verticalbound="bottom"][data-horizontalbound="center"]');
                        if (!el) return null;
                        const rect = el.getBoundingClientRect();
                        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                    })()
                `,
                returnByValue: true
            })
            if (!vertical.value) throw new Error("Vertical resize dot not found")
            
            const { x: x2, y: y2 } = vertical.value
            // Fixed drag distance for speed
            const dragDistance = 60
            await humanDrag(client, x2, y2, x2, y2 + dragDistance)
            mouseX = x2; mouseY = y2 + dragDistance
        }
        
        await fastDelay(100)
        
        setStep('17. Opening publish dialog')
        let publishDialogAttempts = 0
        while (publishDialogAttempts < 20) {
            const count = await Runtime.evaluate({
                expression: 'document.querySelectorAll(\'[data-background-click-cancel="false"]\').length',
            })
            if (count.result.value > 0) break
            
            // Get publish button position
            const publishBtnPos = await Runtime.evaluate({
                expression: `(() => {
                    const btn = document.querySelector('div[role="button"][guidedhelpid="at-appbar-publish"]');
                    if (!btn) return null;
                    const rect = btn.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()`,
                returnByValue: true
            })
            
            if (publishBtnPos.result.value) {
                const pos = await humanClick(client, publishBtnPos.result.value.x, publishBtnPos.result.value.y, mouseX, mouseY)
                mouseX = pos.x; mouseY = pos.y
            } else {
                await Runtime.evaluate({
                    expression: 'document.querySelector(\'div[role="button"][guidedhelpid="at-appbar-publish"]\').click()',
                }).catch(() => { })
            }
            await fastDelay(200)
            publishDialogAttempts++
        }
        
        await fastDelay(200)
        
        setStep('18. Setting site URL slug')
        // Fast input for slug
        const slugInputSelector = '[data-background-click-cancel="false"] input[type="text"]'
        
        // Click on input first
        const slugInputPos = await Runtime.evaluate({
            expression: `(() => {
                const input = document.querySelector('${slugInputSelector}');
                if (!input) return null;
                const rect = input.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            })()`,
            returnByValue: true
        })
        
        if (slugInputPos.result.value) {
            await humanClick(client, slugInputPos.result.value.x, slugInputPos.result.value.y, mouseX, mouseY)
        }
        
        await fastDelay(100)
        
        // Clear and set slug directly
        await Runtime.evaluate({
            expression: `(() => {
                const input = document.querySelector('${slugInputSelector}');
                if (input) {
                    input.select();
                    input.value = '';
                }
            })()`
        })
        await microDelay()
        
        // Type slug fast
        await humanType(client, Runtime, slugInputSelector, SLUG)
        
        await fastDelay(300)
        
        setStep('19. Confirming publish')
        let confirmAttempts = 0
        while (confirmAttempts < 20) {
            const count = await Runtime.evaluate({
                expression: 'document.querySelectorAll(\'[data-background-click-cancel="false"]\').length',
            })
            if (count.result.value === 0) break
            
            // Get confirm button position
            const confirmBtnPos = await Runtime.evaluate({
                expression: `(() => {
                    const btns = document.querySelectorAll('[data-background-click-cancel="false"] div[role="button"]');
                    const btn = btns[btns.length - 1];
                    if (!btn) return null;
                    const rect = btn.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()`,
                returnByValue: true
            })
            
            if (confirmBtnPos.result.value) {
                const pos = await humanClick(client, confirmBtnPos.result.value.x, confirmBtnPos.result.value.y, mouseX, mouseY)
                mouseX = pos.x; mouseY = pos.y
            } else {
                await Runtime.evaluate({
                    expression:
                        'document.querySelectorAll(\'[data-background-click-cancel="false"] div[role="button"]\')[document.querySelectorAll(\'[data-background-click-cancel="false"] div[role="button"]\').length - 1].click()',
                }).catch(() => { })
            }
            await fastDelay(200)
            confirmAttempts++
        }
        
        setStep('20. Closing post-publish dialogs')
        for (let i = 0; i < 5; i++) {
            await fastDelay(300)
            try {
                const closeBtnPos = await Runtime.evaluate({
                    expression: `(() => {
                        const btn = document.querySelectorAll('[guidedhelpid="at-appbar"] button')[5];
                        if (!btn) return null;
                        const rect = btn.getBoundingClientRect();
                        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                    })()`,
                    returnByValue: true
                })
                
                if (closeBtnPos.result.value) {
                    await humanClick(client, closeBtnPos.result.value.x, closeBtnPos.result.value.y, mouseX, mouseY)
                } else {
                    await Runtime.evaluate({
                        expression: 'document.querySelectorAll(\'[guidedhelpid="at-appbar"] button\')[5].click()',
                    })
                }
            } catch { }
            
            await fastDelay(200)
            
            try {
                await Runtime.evaluate({
                    expression:
                        'document.querySelectorAll(\'[isfullscreen] div[role="button"]\')[document.querySelectorAll(\'[isfullscreen] div[role="button"]\').length - 1].click()',
                })
            } catch { }
        }
        
        // Mark profile as used for cooldown tracking
        markProfileUsed(PROFILE_ID)
        
        setStep('22. Verifying published site is accessible')
        // Quick delay before verification
        await fastDelay(500)
        
        try {
            // Use VCBrowser's actual version for verification request
            let verifyUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
            try {
                const { getVCBrowserVersion } = require('../lib/cdpFingerprint');
                const vcVersion = getVCBrowserVersion();
                if (vcVersion?.full) {
                    verifyUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${vcVersion.full} Safari/537.36`;
                }
            } catch (e) { /* use fallback */ }
            const res = await axios.get(URL, {
                headers: {
                    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'accept-language': 'en-US,en;q=0.9',
                    'cache-control': 'max-age=0',
                    'user-agent': verifyUserAgent
                }
            })
            if (res.status === 200) {
                setStep('23. SUCCESS - Site published and verified')
                // Discard recording on success - we only want to save on timeout/failure
                if (recorder) recorder.discard()
                return { success: true, value: URL }
            } else {
                return { success: false, value: "Generated site not reachable" }
            }
        } catch (urlError) {
            console.error(`Failed to verify site ${URL}:`, urlError.message)
            return { success: false, value: "Generated site not reachable" }
        }
    } catch (error) {
        console.error(`Google Sites automation error:`, error.message)
        // Don't save recording here - timeout handler will do it if it's a timeout
        // For other errors, we also don't need the recording
        if (recorder) recorder.discard()
        return { success: false, value: error.stack || error.message || "Unknown error" }
    } finally {
        // Stop recording if still running
        if (recorder && recorder.isRecording) {
            recorder.stop()
        }
        if (!resources.cleaned) {
            resources.cleaned = true
            try {
                if (chromeProcess && !chromeProcess.killed)
                    chromeProcess.kill()
            } catch { }
            try {
                if (client && !client._disconnected)
                    await client.close()
            } catch { }
        }
    }
}

async function getConnectedGoogleProfiles() {
    const googleProfiles = readKey("googleProfiles") || {};
    const connectedProfiles = [];
    for (const [profileId, profile] of Object.entries(googleProfiles)) {
        if (profile.status === "connected") {
            connectedProfiles.push(profileId);
        }
    }
    return connectedProfiles;
}

async function googleSites(HTML, PROFILE_ID) {
    // Refresh concurrency settings on each call to ensure latest settings
    await initializeConcurrency()

    const id = (PROFILE_ID ?? '').trim()
    if (id && id !== 'all') {
        return googleSitesSingle(HTML, id)
    }
    const targetProfileId = await pickRandomAvailableProfile(getConnectedGoogleProfiles)
    return googleSitesSingle(HTML, targetProfileId)
}

async function googleSitesSingle(HTML, PROFILE_ID) {
    // Check if this specific profile is blocked (disconnected)
    if (isGoogleBlocked(PROFILE_ID)) {
        console.log(`[Google Sites] Profile ${PROFILE_ID} is blocked (disconnected), skipping`)
        return { 
            success: false, 
            value: "Profile is disconnected - please reconnect",
            disconnected: true,
            profileId: PROFILE_ID
        }
    }
    
    // Check if ALL profiles are blocked - if so, throw to stop workflow
    if (await areAllProfilesBlocked()) {
        console.log(`[Google Sites] All Google profiles are disconnected`)
        return { 
            success: false, 
            value: "All Google profiles are disconnected. Please reconnect at least one profile.",
            allDisconnected: true
        }
    }
    
    // Global rate limit disabled for maximum speed/concurrency
    
    return new Promise((resolve, reject) => {
        const executeTask = async () => {
            let releaseLock = null
            let timeoutId
            let isResolved = false
            const resources = { cleaned: false }
            
            const safeResolve = (result) => {
                if (!isResolved) {
                    isResolved = true
                    resolve(result)
                }
            }
            
            const safeReject = (error) => {
                if (!isResolved) {
                    isResolved = true
                    reject(error)
                }
            }
            
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId)
                activeCount--
                if (releaseLock) {
                    try {
                        releaseLock()
                    } catch (e) {
                        console.error('Error releasing profile lock:', e)
                    }
                    releaseLock = null
                }
                processQueue()
                
                // Ensure resources are cleaned up
                if (!resources.cleaned) {
                    resources.cleaned = true
                    if (resources.chromeProcess && !resources.chromeProcess.killed) {
                        try { 
                            resources.chromeProcess.kill('SIGKILL')
                            console.log(`Killed Chrome process for profile ${PROFILE_ID}`)
                        } catch (e) {
                            console.error('Error killing Chrome process:', e)
                        }
                    }
                    if (resources.client && !resources.client._disconnected) {
                        try { 
                            resources.client.close().catch(() => { })
                            console.log(`Closed Chrome client for profile ${PROFILE_ID}`)
                        } catch (e) {
                            console.error('Error closing Chrome client:', e)
                        }
                    }
                }
            }
            
            const startWork = async () => {
                activeCount++
                const startTime = Date.now()
                const progressTracker = { currentStep: 'Not started' }
                try {
                    console.log(`Starting Google Sites automation for profile ${PROFILE_ID}`)

                    // Get timeout from settings
                    const automationSettings = (await readKey('automationSettings')) || {};
                    const timeoutSeconds = automationSettings.googleSitesTimeout || 180;
                    const timeoutMs = timeoutSeconds * 1000;

                    const timeoutPromise = new Promise((_, rejectTimeout) => {
                        timeoutId = setTimeout(async () => {
                            const duration = Date.now() - startTime
                            const errorMsg = `Google Sites execution timed out (${timeoutSeconds} seconds)`
                            console.log(`Google Sites timeout reached for profile ${PROFILE_ID} (${timeoutSeconds}s)`)
                            
                            // Log timeout error to file for debugging with current step
                            logTimeoutError(PROFILE_ID, HTML, errorMsg, duration, progressTracker.currentStep)
                            
                            // Save the recording as video on timeout
                            if (resources.recorder) {
                                try {
                                    const videoPath = await resources.recorder.saveAsVideo(
                                        errorMsg,
                                        progressTracker.currentStep
                                    )
                                    if (videoPath) {
                                        console.log(`[Google Sites] Timeout recording saved to: ${videoPath}`)
                                    }
                                } catch (recErr) {
                                    console.error('[Google Sites] Failed to save timeout recording:', recErr.message)
                                }
                            }
                            
                            cleanup()
                            rejectTimeout(new Error(errorMsg))
                        }, timeoutMs)
                    })
                    
                    const taskPromise = _googleSites(HTML, PROFILE_ID, resources, progressTracker)
                    const result = await Promise.race([taskPromise, timeoutPromise])
                    
                    console.log(`Google Sites completed for profile ${PROFILE_ID}:`, result?.success ? 'SUCCESS' : 'FAILED')
                    cleanup()
                    safeResolve(result)
                } catch (err) {
                    console.error(`Google Sites error for profile ${PROFILE_ID}:`, err.message)
                    
                    // Save recording on timeout errors
                    if (err.message && err.message.includes('timed out')) {
                        const duration = Date.now() - startTime
                        logTimeoutError(PROFILE_ID, HTML, err.message, duration, progressTracker.currentStep)
                        
                        // Recording is already saved by timeout handler, just ensure it's stopped
                        if (resources.recorder && resources.recorder.isRecording) {
                            resources.recorder.stop()
                        }
                    } else {
                        // For non-timeout errors, discard the recording
                        if (resources.recorder) {
                            resources.recorder.discard()
                        }
                    }
                    
                    cleanup()
                    safeReject(err)
                }
            }
            
            try {
                console.log(`Acquiring profile lock for ${PROFILE_ID}`)
                releaseLock = await acquireProfile(PROFILE_ID)
                console.log(`Profile lock acquired for ${PROFILE_ID}, starting work`)
                
                if (activeCount < MAX_CONCURRENT) {
                    startWork()
                } else {
                    console.log(`Profile ${PROFILE_ID} queued, active count: ${activeCount}`)
                    queue.push(startWork)
                }
            } catch (e) {
                console.error(`Error acquiring profile lock for ${PROFILE_ID}:`, e)
                if (releaseLock) {
                    try {
                        releaseLock()
                    } catch (lockError) {
                        console.error('Error releasing lock after acquisition failure:', lockError)
                    }
                }
                safeReject(e)
            }
        }
        
        const processQueue = () => {
            while (activeCount < MAX_CONCURRENT && queue.length > 0) {
                const next = queue.shift()
                next()
            }
        }
        
        executeTask().catch(err => {
            console.error('Execute task failed:', err)
            safeReject(err)
        })
    })
}

function stopWorkflowQueues(workflowId) {
    // Clear any queued tasks for the workflow
    // Note: This is a placeholder - we don't track workflow-specific queues in Google Sites
    // but this prevents errors in the main execution system
    console.log(`Stopping Google Sites queues for workflow ${workflowId}`)
}

module.exports = { 
    googleSites, 
    stopWorkflowQueues,
    // Export for IPC handlers
    unblockGoogleProfile,
    isGoogleBlocked,
    getBlockedGoogleProfiles,
    getBlockedProfileCount
}

// ==================== IPC HANDLERS ====================

// Handle manual reconnection notification from frontend
ipcMain.on('google-account-reconnected-manual', (_e, profileId) => { 
    console.log(`[Google Sites] Manual reconnection notification for profile: ${profileId}`)
    unblockGoogleProfile(profileId)
})