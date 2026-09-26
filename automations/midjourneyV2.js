const axios = require('axios');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { app, BrowserWindow, ipcMain } = require('electron');
const WebSocket = require('ws');
const { readKey, moveMultipleToPermStorage } = require('../lib/utils');
const telegramNotifications = require('../lib/telegramNotifications');
const systemNotifications = require('../lib/systemNotifications');
const { openAi } = require('./openai');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes WebSocket idle timeout
const IMAGE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes max wait for image generation
const CAPTCHA_SOFT_TIMEOUT_MS = 90 * 1000; // 90 seconds - soft phase: check WS activity before assuming captcha
const CAPTCHA_HARD_TIMEOUT_MS = 150 * 1000; // 150 seconds - hard phase: if still no seed after soft + this, captcha confirmed
const CAPTCHA_POLL_INTERVAL_MS = 5 * 1000; // Poll for captcha solve status every 5 seconds
const MAX_CONCURRENT = 3; // Midjourney allows max 3 concurrent requests
const REQUEST_DELAY_MIN = 3 * 1000; // 3 seconds minimum between requests
const REQUEST_DELAY_MAX = 3 * 1000; // 3 seconds maximum between requests
const WS_RECONNECT_DELAY = 5000; // 5 seconds delay before auto-reconnect
const WS_MAX_RECONNECT_ATTEMPTS = 5; // Max reconnect attempts before giving up

// Temp directory for initial downloads (will be moved to permanent storage after processing)
const outputDir = path.join(app.getPath('userData'), 'Uploads', 'Temp');
fs.mkdirSync(outputDir, { recursive: true });

// Store WebSocket connections per profile
const connections = new Map();
// Store pending image requests waiting for completion
const pendingRequests = new Map();
// Track WebSocket reconnect attempts per profile (to prevent infinite loops)
const profileReconnectAttempts = new Map(); // profileId -> { count: number, lastAttempt: timestamp }
// Track last WebSocket activity per profile (any message = Discord is alive)
const wsLastActivity = new Map(); // profileId -> timestamp

// Store banned prompts in RAM and persist to disk
const bannedPromptsPath = path.join(app.getPath('userData'), 'banned-prompts.json');
let bannedPrompts = new Set();

// Load banned prompts from disk
try {
  if (fs.existsSync(bannedPromptsPath)) {
    const raw = fs.readFileSync(bannedPromptsPath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) bannedPrompts = new Set(arr);
  }
} catch (_) { }

// Captcha state management (for compatibility with old API)
const captchaState = new Map();
const waitingQueue = new Map();
const workflowQueues = new Map();

// Track active captcha timers so we can clear them all when needed
const activeCaptchaTimers = new Map(); // requestKey -> timerId

// Track stopped workflows to prevent processing images after workflow stop
// Cleaned up after 5 minutes to prevent memory leak
const stoppedWorkflows = new Set();

// Queue system per profile
const profileQueues = new Map(); // profileId -> { queue: [], activeCount: 0, lastRequestTime: 0, processing: false }

// Track banned prompt attempts for AI regeneration
const bannedPromptAttempts = new Map(); // originalPrompt -> { attempts: [prompt1, prompt2, ...], failCount: number }
const MAX_BANNED_PROMPT_RETRIES = 3; // Maximum number of AI regeneration attempts

// Persist banned prompts to disk
function persistBannedPrompts() {
  try {
    fs.writeFileSync(bannedPromptsPath, JSON.stringify([...bannedPrompts]), 'utf8');
  } catch (_) { }
}

// Generate alternative prompt using AI when original is banned
async function generateAlternativePrompt(originalPrompt, previousAttempts = []) {
  try {
    // Check if any OpenAI API keys are configured
    // Keys are stored in 'openaiKeys' as an object/map, not in automationSettings
    const openaiKeys = (await readKey('openaiKeys')) || {};
    const hasKeys = Object.keys(openaiKeys).length > 0;
    
    if (!hasKeys) {
      console.log('[MJ-V2] No OpenAI API keys configured, cannot generate alternative prompt');
      return null;
    }
    
    // Build the prompt for AI
    let aiPrompt;
    if (previousAttempts.length === 0) {
      aiPrompt = `The following image generation prompt was rejected by Midjourney's content policy:

"${originalPrompt}"

Please generate a similar prompt that:
1. Captures the same visual concept and mood
2. Avoids any potentially sensitive, violent, sexual, or controversial content
3. Uses safe, family-friendly language
4. Maintains the artistic intent while being policy-compliant

Return ONLY the new prompt text, nothing else. No explanations, no quotes, just the prompt.`;
    } else {
      const attemptsList = previousAttempts.map((p, i) => `Attempt ${i + 1}: "${p}"`).join('\n');
      aiPrompt = `I'm trying to generate an image with Midjourney but my prompts keep getting rejected by their content policy.

Original prompt: "${originalPrompt}"

Previous failed attempts:
${attemptsList}

Please generate a NEW alternative prompt that:
1. Captures the same visual concept and mood as the original
2. Is DIFFERENT from all previous attempts
3. Avoids any potentially sensitive, violent, sexual, or controversial content
4. Uses completely safe, family-friendly language
5. Maintains the artistic intent while being fully policy-compliant
6. Try a different approach or wording than the failed attempts

Return ONLY the new prompt text, nothing else. No explanations, no quotes, just the prompt.`;
    }
    
    console.log(`[MJ-V2] Requesting AI to generate alternative prompt (attempt ${previousAttempts.length + 1})...`);
    
    // apiKey parameter is ignored by openAi() - it uses the queue manager which handles key selection
    const result = await openAi(null, 'gpt-5-nano', aiPrompt, 0.8);
    
    if (result.success && result.value) {
      const newPrompt = result.value.trim();
      console.log(`[MJ-V2] AI generated alternative prompt: "${newPrompt.substring(0, 100)}..."`);
      return newPrompt;
    } else {
      console.error('[MJ-V2] AI failed to generate alternative prompt:', result.value);
      return null;
    }
  } catch (error) {
    console.error('[MJ-V2] Error generating alternative prompt:', error.message);
    return null;
  }
}

// Get or create banned prompt tracking for retries
function getBannedPromptTracker(originalPrompt) {
  const key = normalizePrompt(originalPrompt);
  if (!bannedPromptAttempts.has(key)) {
    bannedPromptAttempts.set(key, { attempts: [originalPrompt], failCount: 1 });
  }
  return bannedPromptAttempts.get(key);
}

// Clear banned prompt tracker after success or max retries
function clearBannedPromptTracker(originalPrompt) {
  const key = normalizePrompt(originalPrompt);
  bannedPromptAttempts.delete(key);
}

function normalizePrompt(prompt) {
  return (prompt || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isPromptBanned(prompt) {
  return bannedPrompts.has(normalizePrompt(prompt));
}

function addBannedPrompt(prompt) {
  const normalized = normalizePrompt(prompt);
  if (normalized && !bannedPrompts.has(normalized)) {
    bannedPrompts.add(normalized);
    persistBannedPrompts();
    console.log(`[MJ-V2] Added banned prompt to cache. Total cached: ${bannedPrompts.size}`);
  }
}

/**
 * Try to generate an AI alternative for a cached banned prompt
 * Returns { success: true, prompt: newPrompt } or { success: false, reason: string }
 */
async function tryAlternativeForCachedBannedPrompt(originalPrompt) {
  const tracker = getBannedPromptTracker(originalPrompt);
  
  console.log(`[MJ-V2] Cached banned prompt detected, attempting AI regeneration (attempt ${tracker.failCount}/${MAX_BANNED_PROMPT_RETRIES})...`);
  
  // Check if we've exceeded max retries
  if (tracker.failCount >= MAX_BANNED_PROMPT_RETRIES) {
    console.log(`[MJ-V2] Max retries (${MAX_BANNED_PROMPT_RETRIES}) already exceeded for this prompt`);
    clearBannedPromptTracker(originalPrompt);
    return { 
      success: false, 
      reason: `Prompt rejected ${tracker.failCount} times by Midjourney policy. Tried alternatives: ${tracker.attempts.slice(1).map(p => p.substring(0, 30) + '...').join(', ') || 'none'}`
    };
  }
  
  // Try to generate an alternative prompt using AI
  const alternativePrompt = await generateAlternativePrompt(originalPrompt, tracker.attempts);
  
  if (!alternativePrompt) {
    console.log('[MJ-V2] No AI key configured or AI failed to generate alternative');
    clearBannedPromptTracker(originalPrompt);
    return { 
      success: false, 
      reason: 'No AI model configured to generate alternative prompt. Please configure an OpenAI API key in Settings.'
    };
  }
  
  // Check if AI generated the same prompt or one that's also banned
  if (tracker.attempts.some(p => normalizePrompt(p) === normalizePrompt(alternativePrompt))) {
    console.log('[MJ-V2] AI generated a duplicate prompt');
    tracker.failCount++;
    // Try again recursively if we haven't exceeded max retries
    if (tracker.failCount < MAX_BANNED_PROMPT_RETRIES) {
      return tryAlternativeForCachedBannedPrompt(originalPrompt);
    }
    clearBannedPromptTracker(originalPrompt);
    return { 
      success: false, 
      reason: 'AI could not generate a unique alternative prompt'
    };
  }
  
  // Check if the new prompt is also banned in cache
  if (isPromptBanned(alternativePrompt)) {
    console.log('[MJ-V2] AI-generated alternative is also cached as banned, trying again...');
    tracker.attempts.push(alternativePrompt);
    tracker.failCount++;
    // Try again recursively if we haven't exceeded max retries
    if (tracker.failCount < MAX_BANNED_PROMPT_RETRIES) {
      return tryAlternativeForCachedBannedPrompt(originalPrompt);
    }
    clearBannedPromptTracker(originalPrompt);
    return { 
      success: false, 
      reason: 'All AI-generated alternatives were also banned'
    };
  }
  
  // Track this attempt for potential future retries
  tracker.attempts.push(alternativePrompt);
  tracker.failCount++;
  
  console.log(`[MJ-V2] AI generated alternative prompt: "${alternativePrompt.substring(0, 80)}..."`);
  
  return { 
    success: true, 
    prompt: alternativePrompt,
    originalPrompt: originalPrompt // Keep track for retry logic
  };
}

// Check if this is a test workflow (test IDs start with "test_")
// Tests should fail immediately on captcha instead of re-queuing
function isTestWorkflow(workflowId) {
  return workflowId && String(workflowId).startsWith('test_');
}

function cleanedPrompt(input) {
  const bannedWords = [
    "Blood", "Bloodbath", "Crucifixion", "Bloody", "Flesh", "Bruises", "Car crash", "Corpse", "Crucified",
    "Cutting", "Decapitate", "Infested", "Gruesome", "Kill", "Infected", "Sadist", "Slaughter", "Teratoma",
    "Tryphophobia", "Wound", "Cronenberg", "Khorne", "Cannibal", "Cannibalism", "Visceral", "Guts", "Bloodshot",
    "Gory", "Killing", "Surgery", "Vivisection", "Massacre", "Hemoglobin", "Suicide", "Female Body Parts",
    "ahegao", "pinup", "ballgag", "Playboy", "Bimbo", "pleasure", "pleasures", "bodily fluids", "boudoir",
    "rule34", "brothel", "seducing", "dominatrix", "seductive", "erotic seductive", "fuck", "sensual", "Hardcore",
    "sexy", "Hentai", "Shag", "horny", "shibari", "incest", "Smut", "jav", "succubus", "Jerk off king at pic",
    "thot", "kinbaku", "transparent", "submissive", "dominant", "nasty", "indecent", "legs spread", "cussing",
    "flashy", "twerk", "making love", "voluptuous", "naughty", "wincest", "orgy", "Sultry", "XXX", "Bondage",
    "Bdsm", "Dog collar", "Slavegirl", "Transparent and Translucent",
    "Arse", "Ass", "Big Ass", "Badonkers", "Booba", "Booty", "Bosom", "Breasts", "Busty", "Clunge", "Coochie",
    "Dick", "Engorged", "Girth", "Head", "Honkers", "Hooters", "Human centipede", "Knob", "Labia", "Mammaries",
    "Massive chests", "Melons", "Minge", "Mommy Milker", "Nipple", "Oppai", "Organs", "Ovaries", "Penis",
    "Phallus", "Seductress", "Shaft", "Skimpy", "Thick", "Veiny", "Vagina",
    "no clothes", "no shirt", "bare chest", "nude", "naked", "zero clothes", "without clothes on",
    "wearing nothing", "invisible clothes", "full frontal unclothed", "au naturale", "barely dressed", "bra",
    "risqué", "scantily clad", "cleavage", "stripped", "lingerie with no shirt", "negligee", "Speedo",
    "Taboo", "Fascist", "Nazi", "Prophet Mohammed", "Slave", "Coon", "Honkey", "Arrested", "Jail", "Handcuffs",
    "Drugs", "Cocaine", "Heroin", "Meth", "Crack",
    "Torture", "Disturbing", "Farts", "Fart", "Poop", "Warts", "Xi Jinping", "Shit", "Errect", "Big Black",
    "Brown pudding", "Bunghole", "Vomit", "Voluptuous", "Seductive", "Sperm", "Hot", "Sexy", "Plebeian",
    "Sensored", "Censored", "Uncouth", "Silenced", "Deepfake", "Inappropriate", "Pus", "Waifu", "mp5", "Succubus",
    "1488", "Surgery"
  ];
  
  // Valid Midjourney parameters that can follow "--"
  const validMjParams = new Set([
    'aspect', 'ar',
    'chaos', 'c',
    'oref',
    'no',
    'profile', 'p',
    'quality', 'q',
    'repeat', 'r',
    'seed',
    'stealth',
    'raw',
    'stylize', 's',
    'sref',
    'tile',
    'version', 'v',
    'draft',
    'weird', 'w',
    'fast',
    'iw',
    'relax',
    'turbo',
    'niji',
    'public',
    'motion',
    'loop',
    'end',
    'bs',
    'sw',
    'sv',
    'video',
    'cref', 'cw',
    'personalize',
    'stop', 'style',
    'hd', 'test', 'testp', 'creative'
  ]);
  
  let result = input || '';
  
  // Remove banned words
  for (const word of bannedWords) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    result = result.replace(pattern, "");
  }
  
  // Fix words that accidentally start with a single dash:
  //   "red -lamborghini" -> "red lamborghini"
  result = result.replace(/(^|\s)-([a-zA-Z][\w-]*)/g, '$1$2');
  
  // Fix invalid Midjourney-style double dash:
  //   "--lamborghini" -> "lamborghini"
  //   "--v"          -> "--v" (kept, valid param)
  result = result.replace(/--([a-zA-Z][\w-]*)/g, (match, param) => {
    return validMjParams.has(param.toLowerCase()) ? match : param;
  });
  
  // Collapse extra whitespace
  return result.replace(/\s+/g, ' ').trim();
}

function generateNonce() {
  const timestamp = BigInt(Date.now() - 1420070400000) << BigInt(22);
  const random = BigInt(Math.floor(Math.random() * 4194304));
  return (timestamp | random).toString();
}

function getRandomDelay() {
  return REQUEST_DELAY_MIN + Math.random() * (REQUEST_DELAY_MAX - REQUEST_DELAY_MIN);
}

function getProfileQueue(profileId) {
  if (!profileQueues.has(profileId)) {
    profileQueues.set(profileId, { queue: [], activeCount: 0, lastRequestTime: 0, processing: false });
  }
  return profileQueues.get(profileId);
}

async function processQueue(profileId) {
  const queueData = getProfileQueue(profileId);
  
  // Prevent concurrent processQueue executions for the same profile
  if (queueData.processing) return;
  
  // CRITICAL: Do not process ANY requests if profile is blocked by captcha
  if (isBlocked(profileId)) {
    console.log(`[MJ-V2] Queue processing blocked for profile ${profileId} - captcha pending. No requests will be sent.`);
    return;
  }
  
  queueData.processing = true;
  
  try {
    while (queueData.queue.length > 0 && queueData.activeCount < MAX_CONCURRENT) {
      // CRITICAL: Check captcha status before EACH request in the loop
      if (isBlocked(profileId)) {
        console.log(`[MJ-V2] Captcha detected during queue processing for profile ${profileId} - stopping immediately`);
        break;
      }
      const now = Date.now();
      const timeSinceLastRequest = now - queueData.lastRequestTime;
      const requiredDelay = getRandomDelay();
      
      // Wait if we need to respect the delay between requests
      if (queueData.lastRequestTime > 0 && timeSinceLastRequest < requiredDelay) {
        const waitTime = requiredDelay - timeSinceLastRequest;
        console.log(`[MJ-V2] Waiting ${Math.round(waitTime / 1000)}s before next request...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // CRITICAL: Re-check captcha status after waiting - it could have been detected during the delay
        if (isBlocked(profileId)) {
          console.log(`[MJ-V2] Captcha detected during delay wait for profile ${profileId} - stopping queue`);
          break;
        }
      }
      
      // Double-check we still have capacity after waiting
      if (queueData.activeCount >= MAX_CONCURRENT) break;
      
      const task = queueData.queue.shift();
      if (!task) break;
      
      queueData.activeCount++;
      queueData.lastRequestTime = Date.now();
      console.log(`[MJ-V2] Processing request. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
      
      // Execute the task (don't await - let it run in background)
      // Pass originalPromptForTracking if this is a retry with AI-generated prompt
      // Pass alreadySentSeed if this request was already sent to Discord (captcha re-queue)
      executeImagineRequest(task.profileId, task.prompt, task.workflowId, task.resolve, task.originalPromptForTracking, task.alreadySentSeed);
    }
  } finally {
    queueData.processing = false;
  }
}

function onRequestComplete(profileId) {
  const queueData = getProfileQueue(profileId);
  queueData.activeCount = Math.max(0, queueData.activeCount - 1);
  console.log(`[MJ-V2] Request complete. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
  // Process next in queue
  processQueue(profileId);
}

function isImageComplete(msg) {
  // Must be type 0 (regular message), have attachments, and content must indicate completion
  if (msg.type !== 0) return false;
  if (!msg.attachments?.length) return false;
  const content = msg.content || '';
  // Check for completion indicators: (fast), (relaxed), (turbo)
  if (!/\((fast|relaxed|turbo)\)/i.test(content)) return false;
  // Must have action buttons (U1, V1, etc.)
  if (!msg.components?.length) return false;
  return true;
}

function isBannedPromptMessage(msg) {
  // Banned prompts come with embeds containing title "Banned prompt detected"
  const embeds = msg.embeds || [];
  for (const embed of embeds) {
    const title = (embed?.title || '').toLowerCase();
    if (title === 'banned prompt detected') {
      return true;
    }
  }
  return false;
}

function extractSeedFromContent(content) {
  const m = content?.match(/--seed\s+(\d+)/);
  return m ? m[1] : null;
}

function extractSeedFromEmbed(msg) {
  const embeds = msg.embeds || [];
  for (const embed of embeds) {
    const footerText = embed?.footer?.text || '';
    const description = embed?.description || '';
    const seedMatch = extractSeedFromContent(footerText) || extractSeedFromContent(description);
    if (seedMatch) return seedMatch;
  }
  return null;
}

// Captcha management functions
function isBlocked(profileId) {
  return !!(captchaState.get(profileId)?.blocked);
}

function broadcastToRenderers(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send(channel, payload); } catch (_) { }
  }
}

async function registerCaptchaToken() { return null; }

async function checkCaptchaSolved() { return false; }

function startCaptchaPolling() { /* Solve CAPTCHA in the local browser. */ }

async function blockProfile(profileId, seed, prompt) {
  const prev = captchaState.get(profileId) || {};
  if (!prev.blocked) {
    // Register captcha token with server first
    console.log(`[MJ-V2] Registering captcha token for profile ${profileId}...`);
    const captchaToken = await registerCaptchaToken(profileId, seed);
    
    if (captchaToken) {
      console.log(`[MJ-V2] Captcha token registered successfully: ${captchaToken.substring(0, 16)}...`);
    } else {
      console.error(`[MJ-V2] Failed to register captcha token - Telegram link will not work!`);
    }
    
    captchaState.set(profileId, { blocked: true, since: Date.now(), lastSeed: seed, lastPrompt: prompt, captchaToken });
    broadcastToRenderers('midjourney-captcha-required', { profileId, seed, prompt });
    
    console.log(`[MJ-V2] Captcha detected for profile ${profileId}, sending Telegram notification with token: ${captchaToken ? 'YES' : 'NO'}...`);
    telegramNotifications.sendNotification('captchaDetected', { profileId, seed, prompt, captchaToken }).then(result => {
      if (result.success) {
        console.log(`[MJ-V2] Telegram notification sent successfully for captcha detection`);
      } else {
        console.error(`[MJ-V2] Telegram notification failed:`, result.reason || result.error);
      }
    }).catch(err => {
      console.error('[MJ-V2] Failed to send Telegram notification for captcha detection:', err);
    });

    // Send system notification for captcha detected
    systemNotifications.sendNotification('captchaDetected', { profileId, seed, prompt, captchaToken }).then(result => {
      if (result.success) {
        console.log(`[MJ-V2] System notification sent successfully for captcha detection`);
      } else {
        console.error(`[MJ-V2] System notification failed:`, result.reason || result.error);
      }
    }).catch(err => {
      console.error('[MJ-V2] Failed to send system notification for captcha detection:', err);
    });
    
    // Start polling for captcha solve status if we got a token
    if (captchaToken) {
      startCaptchaPolling(profileId, captchaToken);
    } else {
      console.warn(`[MJ-V2] No captcha token - user will need to manually unblock in the app`);
    }
  }
}

const FALSE_POSITIVE_THRESHOLD_MS = 45 * 1000; // 45 seconds - if auto-cleared within this time, it was likely a false positive

function unblockProfile(profileId, isAutoCleared = false) {
  const s = captchaState.get(profileId) || {};
  
  // Clear polling interval if exists
  if (s.pollInterval) {
    clearInterval(s.pollInterval);
  }
  
  // Clear ALL pending captcha timers for this profile to prevent re-triggering
  for (const [requestKey, timerId] of activeCaptchaTimers.entries()) {
    if (requestKey.startsWith(profileId + ':')) {
      clearTimeout(timerId);
      activeCaptchaTimers.delete(requestKey);
      console.log(`[MJ-V2] Cleared pending captcha timer for ${requestKey}`);
    }
  }
  
  // Check if this was a false positive (auto-cleared within 20 seconds of detection)
  const timeSinceDetection = s.since ? Date.now() - s.since : Infinity;
  const isFalsePositive = isAutoCleared && timeSinceDetection < FALSE_POSITIVE_THRESHOLD_MS;
  
  captchaState.set(profileId, { ...s, blocked: false, pollInterval: null });
  
  if (isFalsePositive) {
    // False positive - send apology notification instead of captcha cleared
    console.log(`[MJ-V2] Captcha auto-cleared within ${Math.round(timeSinceDetection / 1000)}s - likely a false positive due to slow response`);
    
    telegramNotifications.sendNotification('captchaFalsePositive', { profileId, timeSinceDetection }).catch(err => {
      console.error('Failed to send Telegram notification for captcha false positive:', err);
    });

    systemNotifications.sendNotification('captchaFalsePositive', { profileId, timeSinceDetection }).catch(err => {
      console.error('Failed to send system notification for captcha false positive:', err);
    });
  } else {
    // Regular captcha cleared
    const clearType = isAutoCleared ? 'auto' : 'manually';
    console.log(`[MJ-V2] Captcha ${clearType} cleared for profile ${profileId}, sending notifications...`);
    
    telegramNotifications.sendNotification('captchaCleared', { profileId }).catch(err => {
      console.error('Failed to send Telegram notification for captcha cleared:', err);
    });

    systemNotifications.sendNotification('captchaCleared', { profileId }).catch(err => {
      console.error('Failed to send system notification for captcha cleared:', err);
    });
  }
  
  broadcastToRenderers('midjourney-captcha-cleared', { profileId });
  
  // Clear alreadySentSeed from all queued items for this profile - ONLY on manual clear.
  //
  // Manual clear = user solved a real captcha → Discord rejected the original requests,
  //                so we must re-send them with fresh seeds.
  //
  // Auto clear  = a Midjourney message with a seed arrived while we thought the profile
  //                was blocked (i.e., the captcha block was a false positive). The original
  //                /imagine requests are still alive on Discord's side and will deliver
  //                images. Stripping alreadySentSeed here would cause duplicate /imagine
  //                calls (the original generates AND a fresh re-send generates), which
  //                surfaces as "prompts re-sending after a minute" with the workflow
  //                already complete.
  const queueData = profileQueues.get(profileId);
  if (queueData && queueData.queue.length > 0) {
    if (isAutoCleared) {
      const stillSentCount = queueData.queue.filter(t => t.alreadySentSeed).length;
      if (stillSentCount > 0) {
        console.log(`[MJ-V2] Auto-clear: keeping alreadySentSeed on ${stillSentCount} queued items - their original Discord requests are still alive`);
      }
    } else {
      let clearedCount = 0;
      for (const task of queueData.queue) {
        if (task.alreadySentSeed) {
          delete task.alreadySentSeed;
          clearedCount++;
        }
      }
      if (clearedCount > 0) {
        console.log(`[MJ-V2] Manual clear: cleared alreadySentSeed from ${clearedCount} queued items - they will be re-sent to Discord`);
      }
    }
  }
  
  // Resume queue processing now that captcha is solved
  console.log(`[MJ-V2] Resuming queue processing for profile ${profileId}...`);
  processQueue(profileId);
}

function getCaptchaStatus(profileId) {
  const s = captchaState.get(profileId);
  return s ? { ...s } : { blocked: false };
}

/**
 * Clear workflow state for rerun - clears stoppedWorkflows entry without adding or aborting
 * This prevents "Workflow stopped by user" errors on immediate reruns
 * @param {string} workflowId - The workflow ID to clear state for
 */
function clearWorkflowStateForRerun(workflowId) {
  console.log(`[MJ-V2] Clearing state for workflow ${workflowId} rerun...`);
  
  // Remove from stoppedWorkflows so new requests won't be rejected
  const wasInSet = stoppedWorkflows.delete(workflowId);
  if (wasInSet) {
    console.log(`[MJ-V2] Cleared stoppedWorkflows entry for workflow ${workflowId}`);
  }
  
  // Clear workflow tracking entries (don't resolve/abort - just remove tracking)
  if (workflowQueues.has(workflowId)) {
    workflowQueues.delete(workflowId);
    console.log(`[MJ-V2] Cleared workflowQueues entry for workflow ${workflowId}`);
  }
  
  // Clean up orphaned items in profileQueues for this workflow
  // These can linger from a previous run that was force-completed while captcha was active
  let removedFromQueue = 0;
  for (const [profileId, queueData] of profileQueues.entries()) {
    const itemsToRemove = queueData.queue.filter(item => item.workflowId === workflowId);
    if (itemsToRemove.length > 0) {
      queueData.queue = queueData.queue.filter(item => item.workflowId !== workflowId);
      removedFromQueue += itemsToRemove.length;
      // Resolve removed items so their promises don't hang forever
      for (const item of itemsToRemove) {
        try {
          item.resolve({
            success: false,
            code: 'WORKFLOW_RERUN',
            seed: null,
            value: 'Workflow rerun - clearing stale queue items',
            prompt: item.prompt
          });
        } catch (e) {
          console.warn(`[MJ-V2] Failed to resolve stale queue item during rerun cleanup:`, e.message);
        }
      }
    }
  }
  if (removedFromQueue > 0) {
    console.log(`[MJ-V2] Cleared ${removedFromQueue} orphaned queue items for workflow ${workflowId}`);
  }
  
  // Clean up orphaned pendingRequests for this workflow
  let removedPending = 0;
  for (const [requestKey, request] of pendingRequests.entries()) {
    if (request.workflowId === workflowId) {
      if (request.captchaTimer) {
        clearTimeout(request.captchaTimer);
        activeCaptchaTimers.delete(requestKey);
      }
      pendingRequests.delete(requestKey);
      removedPending++;
      
      // Decrement active count for the profile
      const profileId = requestKey.split(':')[0];
      const queueData = profileQueues.get(profileId);
      if (queueData) {
        queueData.activeCount = Math.max(0, queueData.activeCount - 1);
      }
    }
  }
  if (removedPending > 0) {
    console.log(`[MJ-V2] Cleared ${removedPending} orphaned pending requests for workflow ${workflowId}`);
  }
  
  // Clean up any captcha timers for this workflow
  for (const [timerKey, timerId] of activeCaptchaTimers.entries()) {
    // Timer keys contain the request key which starts with profileId
    // We can't directly map timer to workflow, but we cleared pendingRequests above
    // so timers will find no request and exit harmlessly
  }
}

function stopWorkflowQueues(workflowId) {
  console.log(`[MJ-V2] Stopping all queues for workflow ${workflowId}...`);
  let removedFromQueue = 0;
  let removedPending = 0;
  
  // Mark this workflow as stopped - this prevents any late-arriving WebSocket messages from being processed
  stoppedWorkflows.add(workflowId);
  
  // Clean up the stopped workflow set after 5 minutes to prevent memory leak
  setTimeout(() => {
    stoppedWorkflows.delete(workflowId);
  }, 5 * 60 * 1000);
  
  // Remove from profileQueues (items waiting in queue)
  for (const [profileId, queueData] of profileQueues.entries()) {
    const originalLength = queueData.queue.length;
    
    // Filter out items belonging to this workflow and resolve them as stopped
    const itemsToRemove = queueData.queue.filter(item => item.workflowId === workflowId);
    queueData.queue = queueData.queue.filter(item => item.workflowId !== workflowId);
    
    // Resolve removed items with workflow stopped error
    for (const item of itemsToRemove) {
      try {
        item.resolve({
          success: false,
          code: 'WORKFLOW_STOPPED',
          seed: null,
          value: 'Workflow stopped by user',
          prompt: item.prompt
        });
      } catch (e) {
        console.warn(`[MJ-V2] Failed to resolve stopped queue item:`, e.message);
      }
    }
    
    const removedCount = originalLength - queueData.queue.length;
    if (removedCount > 0) {
      removedFromQueue += removedCount;
      console.log(`[MJ-V2] Removed ${removedCount} queued requests for workflow ${workflowId} from profile ${profileId}`);
    }
  }
  
  // Cancel pending requests (items currently being processed/waiting for image)
  for (const [requestKey, request] of pendingRequests.entries()) {
    if (request.workflowId === workflowId) {
      // Clear captcha timer if exists
      if (request.captchaTimer) {
        clearTimeout(request.captchaTimer);
        activeCaptchaTimers.delete(requestKey);
      }
      
      // Mark as stopped BEFORE resolving to prevent race conditions
      // The WebSocket handler will check this flag before processing
      request.stopped = true;
      
      // Resolve the request as stopped
      try {
        request.resolve({
          success: false,
          code: 'WORKFLOW_STOPPED',
          seed: request.seedNum,
          value: 'Workflow stopped by user',
          prompt: request.originalPrompt || request.currentPrompt
        });
      } catch (e) {
        console.warn(`[MJ-V2] Failed to resolve stopped pending request:`, e.message);
      }
      
      // Don't delete immediately - keep for a short time so WebSocket handler can check stopped flag
      // Schedule deletion after 30 seconds to handle any in-flight messages
      setTimeout(() => {
        pendingRequests.delete(requestKey);
      }, 30000);
      
      removedPending++;
      
      // Decrement active count for the profile
      const profileId = requestKey.split(':')[0];
      const queueData = profileQueues.get(profileId);
      if (queueData) {
        queueData.activeCount = Math.max(0, queueData.activeCount - 1);
      }
    }
  }
  
  // Also clean up old workflowQueues/waitingQueue for backwards compatibility
  const wq = workflowQueues.get(workflowId) || [];
  for (const { profileId, queueItem } of wq) {
    const q = waitingQueue.get(profileId) || [];
    const idx = q.indexOf(queueItem);
    if (idx !== -1) {
      q.splice(idx, 1);
      waitingQueue.set(profileId, q);
      try {
        queueItem.reject(new Error('Workflow stopped by user'));
      } catch (e) {}
    }
  }
  workflowQueues.delete(workflowId);
  
  console.log(`[MJ-V2] Workflow ${workflowId} cleanup complete: removed ${removedFromQueue} queued + ${removedPending} pending requests`);
}

// IPC handler for captcha solved
ipcMain.on('midjourney-captcha-solved', (_e, profileId) => { unblockProfile(profileId); });

function handleMessage(profileId, msg) {
  const content = msg.content || '';
  
  // Extract seed from message content OR embeds (progress messages may have seed in embeds)
  const seedMatch = content.match(/--seed\s+(\d+)/);
  const messageSeedNum = seedMatch ? seedMatch[1] : extractSeedFromEmbed(msg);
  
  // If message contains ANY seed, auto-clear captcha - Midjourney is responding
  if (messageSeedNum && isBlocked(profileId)) {
    console.log(`[MJ-V2] Response with seed ${messageSeedNum} received while blocked - auto-clearing captcha for profile ${profileId}`);
    unblockProfile(profileId, true);
  }
  
  // If message contains a seed that matches a pending request, cancel its captcha timer
  // This is the key logic: first seed response = image started generating = no captcha
  if (messageSeedNum) {
    const requestKey = `${profileId}:${messageSeedNum}`;
    const request = pendingRequests.get(requestKey);
    
    if (request && !request.seedReceived) {
      // First response with this seed - cancel captcha timer immediately
      if (request.captchaTimer) {
        clearTimeout(request.captchaTimer);
        activeCaptchaTimers.delete(requestKey);
      }
      request.seedReceived = true;
      console.log(`[MJ-V2] First seed response received for ${requestKey}, captcha timer cancelled`);
    }
    
    // Check if this is a completed image
    // IMPORTANT: Check stopped flag AND stoppedWorkflows set to prevent processing images from stopped workflows
    const isWorkflowStopped = request?.stopped || (request?.workflowId && stoppedWorkflows.has(request.workflowId));
    
    if (request && isImageComplete(msg) && !isWorkflowStopped) {
      const imageUrl = msg.attachments[0]?.url;
      if (imageUrl) {
        clearBannedPromptTracker(request.originalPrompt);
        // Image has been delivered by Discord. Clear the generation-wait timeout NOW so the
        // (potentially slow) download + SEO metadata processing isn't killed by it. Without this,
        // a fast generation followed by slow post-processing (e.g. proxy issues) would still
        // fail the node with a false "generation timeout".
        if (request.generationTimeout) {
          clearTimeout(request.generationTimeout);
          request.generationTimeout = null;
        }
        // Delete from pendingRequests first so duplicate WS events are ignored
        pendingRequests.delete(requestKey);
        // Release the active slot immediately so the next queued request can start
        // while this request's download + SEO processing continues in the background
        request.releaseSlot?.();
        downloadAndSplitImage(imageUrl, request.seedNum, request.originalPrompt, request.resolve, request.workflowId);
      }
    } else if (request && isImageComplete(msg) && isWorkflowStopped) {
      // Log that we're ignoring a completed image from a stopped workflow
      console.log(`[MJ-V2] Ignoring completed image for stopped workflow. Seed: ${request.seedNum}, WorkflowId: ${request.workflowId}, RequestKey: ${requestKey}`);
      // Clean up the request
      pendingRequests.delete(requestKey);
    }
  }
  
  // Check for banned prompt message from Midjourney
  if (isBannedPromptMessage(msg)) {
    console.log('[MJ-V2] Banned prompt detected!');
    const bannedSeed = extractSeedFromContent(content) || extractSeedFromEmbed(msg);
    if (bannedSeed) {
      const requestKey = `${profileId}:${bannedSeed}`;
      const request = pendingRequests.get(requestKey);
      
      if (request) {
        // Check if workflow was stopped - don't retry banned prompts for stopped workflows
        const isWorkflowStopped = request.stopped || (request.workflowId && stoppedWorkflows.has(request.workflowId));
        
        if (request.captchaTimer) {
          clearTimeout(request.captchaTimer);
          activeCaptchaTimers.delete(requestKey);
        }
        
        // Add current prompt to banned cache
        addBannedPrompt(request.currentPrompt || request.originalPrompt);
        
        if (isWorkflowStopped) {
          // Workflow was stopped - just clean up, don't retry
          console.log(`[MJ-V2] Ignoring banned prompt retry for stopped workflow. Seed: ${request.seedNum}, WorkflowId: ${request.workflowId}`);
          pendingRequests.delete(requestKey);
        } else {
          // Handle AI retry logic for banned prompts
          handleBannedPromptWithRetry(profileId, request, requestKey);
        }
      }
    }
  }
}

// Handle banned prompt with AI retry logic
async function handleBannedPromptWithRetry(profileId, request, requestKey) {
  const originalPrompt = request.originalPrompt;
  const tracker = getBannedPromptTracker(originalPrompt);
  
  console.log(`[MJ-V2] Banned prompt retry ${tracker.failCount}/${MAX_BANNED_PROMPT_RETRIES} for: "${originalPrompt.substring(0, 50)}..."`);
  
  // Check if we've exceeded max retries
  if (tracker.failCount >= MAX_BANNED_PROMPT_RETRIES) {
    console.log(`[MJ-V2] Max retries (${MAX_BANNED_PROMPT_RETRIES}) exceeded for banned prompt, giving up`);
    clearBannedPromptTracker(originalPrompt);
    pendingRequests.delete(requestKey);
    request.resolve({ 
      success: false, 
      code: 'BANNED_PROMPT_MAX_RETRIES',
      seed: request.seedNum,
      value: `Prompt rejected ${tracker.failCount} times by Midjourney policy. Tried alternatives: ${tracker.attempts.slice(1).map(p => p.substring(0, 30) + '...').join(', ')}`,
      prompt: originalPrompt
    });
    onRequestComplete(profileId);
    return;
  }
  
  // Try to generate an alternative prompt using AI
  console.log(`[MJ-V2] Requesting AI to generate alternative prompt...`);
  const alternativePrompt = await generateAlternativePrompt(originalPrompt, tracker.attempts);
  
  if (!alternativePrompt) {
    console.log('[MJ-V2] Failed to generate alternative prompt, giving up');
    clearBannedPromptTracker(originalPrompt);
    pendingRequests.delete(requestKey);
    request.resolve({ 
      success: false, 
      code: 'BANNED_PROMPT_NO_ALTERNATIVE',
      seed: request.seedNum,
      value: 'Midjourney rejected the prompt and AI could not generate an alternative',
      prompt: originalPrompt
    });
    onRequestComplete(profileId);
    return;
  }
  
  // Check if AI generated the same prompt (shouldn't happen but just in case)
  if (tracker.attempts.some(p => normalizePrompt(p) === normalizePrompt(alternativePrompt))) {
    console.log('[MJ-V2] AI generated a duplicate prompt, giving up');
    clearBannedPromptTracker(originalPrompt);
    pendingRequests.delete(requestKey);
    request.resolve({ 
      success: false, 
      code: 'BANNED_PROMPT_DUPLICATE_ALTERNATIVE',
      seed: request.seedNum,
      value: 'AI could not generate a unique alternative prompt',
      prompt: originalPrompt
    });
    onRequestComplete(profileId);
    return;
  }
  
  // Track this new attempt
  tracker.attempts.push(alternativePrompt);
  tracker.failCount++;
  
  console.log(`[MJ-V2] Retrying with AI-generated prompt: "${alternativePrompt.substring(0, 80)}..."`);
  
  // Clean up the current pending request
  pendingRequests.delete(requestKey);
  
  // Release the active slot before re-queuing to prevent activeCount accumulation
  onRequestComplete(profileId);
  
  // Re-queue with the new prompt but keep the original prompt reference for tracking
  const queueData = getProfileQueue(profileId);
  queueData.queue.unshift({ 
    profileId, 
    prompt: alternativePrompt, 
    workflowId: request.workflowId,
    originalPromptForTracking: originalPrompt, // Keep track of original for retry logic
    resolve: request.queueResolve || request.resolve
  });
  
  // Process the queue to try the new prompt
  processQueue(profileId);
}

async function downloadAndSplitImage(imageUrl, seed, prompt, resolve, workflowId = null) {
  const originalImagePath = path.join(outputDir, `${seed}.jpg`);
  let tempFiles = [originalImagePath];

  const MAX_DOWNLOAD_RETRIES = 3;
  const RETRY_DELAY = 2000; // 2 seconds between retries

  try {
    // Download image with retry logic for ECONNRESET and other network errors
    let imgData = null;
    let lastError = null;
    
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
      try {
        console.log(`[MJ-V2] Downloading image (attempt ${attempt}/${MAX_DOWNLOAD_RETRIES}): ${imageUrl.substring(0, 80)}...`);
        imgData = await axios.get(imageUrl, { 
          responseType: 'arraybuffer', 
          timeout: 90000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/*,*/*',
            'Connection': 'keep-alive'
          }
        });
        console.log(`[MJ-V2] Image downloaded successfully on attempt ${attempt}`);
        break; // Success, exit retry loop
      } catch (downloadError) {
        lastError = downloadError;
        console.error(`[MJ-V2] Download attempt ${attempt} failed: ${downloadError.code || downloadError.message}`);
        
        if (attempt < MAX_DOWNLOAD_RETRIES) {
          // Wait before retrying with exponential backoff
          const delay = RETRY_DELAY * attempt;
          console.log(`[MJ-V2] Retrying download in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    
    if (!imgData) {
      throw new Error(`Failed to download after ${MAX_DOWNLOAD_RETRIES} attempts: ${lastError?.code || lastError?.message || 'Unknown error'}`);
    }
    
    fs.writeFileSync(originalImagePath, imgData.data);

    // Split into 4 parts
    const image = sharp(originalImagePath);
    const metadata = await image.metadata();

    const halfWidth = Math.floor(metadata.width / 2);
    const halfHeight = Math.floor(metadata.height / 2);
    const parts = [
      { left: 0, top: 0, width: halfWidth, height: halfHeight },
      { left: halfWidth, top: 0, width: halfWidth, height: halfHeight },
      { left: 0, top: halfHeight, width: halfWidth, height: halfHeight },
      { left: halfWidth, top: halfHeight, width: halfWidth, height: halfHeight },
    ];

    const splitPaths = [];
    for (let k = 0; k < parts.length; k++) {
      const partPath = path.join(outputDir, `${seed}_part${k + 1}.jpg`);
      await sharp(originalImagePath).extract(parts[k]).toFile(partPath);
      splitPaths.push(partPath);
      tempFiles.push(partPath);
    }

    // CRITICAL: Move split images to permanent storage to prevent cleanup deletion
    // This ensures workflow exports work even after 24+ hours
    // Pass all options for AI cleaning, fake device metadata, and SEO metadata
    const automationSettings = readKey('automationSettings') || {};
    const cleanAI = automationSettings.aiImageCleaning !== false;
    const imageMetadataSettings = readKey('imageMetadataSettings') || {};
    
    const moveResult = await moveMultipleToPermStorage(splitPaths, { 
      nodeType: 'midjourney', 
      workflowId,
      cleanAI,
      injectMetadata: imageMetadataSettings.enabled !== false ? imageMetadataSettings : null,
      prompt
    });
    const permanentPaths = moveResult.success ? moveResult.permanentPaths : splitPaths;
    
    if (moveResult.success) {
      console.log(`[MJ-V2] Moved ${permanentPaths.length} images to permanent storage`);
    } else {
      console.warn(`[MJ-V2] Failed to move some images to permanent storage: ${moveResult.errors?.join(', ')}`);
    }

    // Schedule cleanup of temp files after 2 hours (the permanent copies are safe)
    setTimeout(() => {
      for (const filePath of tempFiles) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { }
      }
    }, 2 * 60 * 60 * 1000); // 2 hours

    resolve({ success: true, code: 'OK', seed, value: permanentPaths });
  } catch (error) {
    // Cleanup on error
    for (const filePath of tempFiles) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { }
    }
    
    if (error.message?.includes('download') || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      resolve({ success: false, code: 'ERROR_DOWNLOAD', seed, value: `Failed to download image: ${error.message}`, prompt });
    } else {
      resolve({ success: false, code: 'ERROR_SHARP', seed, value: `Image processing failed: ${error.message}`, prompt });
    }
  }
}

async function ensureWebSocket(profileId, token, retryCount = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000; // 2 seconds between retries
  
  const existing = connections.get(profileId);
  
  // If connection exists and token matches, reset timer and return
  if (existing && existing.token === token && existing.ws?.readyState === WebSocket.OPEN) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => closeWebSocket(profileId), TIMEOUT_MS);
    return existing.ws;
  }
  
  // Close existing if token changed or connection is not open
  if (existing) closeWebSocket(profileId);
  
  try {
    const ws = await createWebSocketConnection(profileId, token);
    return ws;
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      console.log(`[MJ-V2] WebSocket connection failed, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return ensureWebSocket(profileId, token, retryCount + 1);
    }
    throw new Error(`WebSocket connection failed after ${MAX_RETRIES} retries: ${error.message}`);
  }
}

function createWebSocketConnection(profileId, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    let heartbeatInterval = null;
    let seq = null;
    let connectionTimeout = null;
    let resolved = false;
    
    const cleanup = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (connectionTimeout) clearTimeout(connectionTimeout);
    };
    
    // Auto-reconnect function for when connection drops after initial connect
    const attemptReconnect = async () => {
      // Only reconnect if there are pending requests for this profile
      const hasPendingRequests = [...pendingRequests.keys()].some(key => key.startsWith(profileId + ':'));
      if (!hasPendingRequests) {
        console.log(`[MJ-V2] WebSocket closed for profile ${profileId}, no pending requests - not reconnecting`);
        profileReconnectAttempts.delete(profileId);
        return;
      }
      
      // Get or initialize reconnect tracking for this profile
      let reconnectInfo = profileReconnectAttempts.get(profileId);
      const now = Date.now();
      
      // Reset counter if last attempt was more than 2 minutes ago (connection was stable)
      if (reconnectInfo && (now - reconnectInfo.lastAttempt) > 120000) {
        reconnectInfo = { count: 0, lastAttempt: now };
      }
      
      if (!reconnectInfo) {
        reconnectInfo = { count: 0, lastAttempt: now };
      }
      
      if (reconnectInfo.count >= WS_MAX_RECONNECT_ATTEMPTS) {
        console.error(`[MJ-V2] Max reconnect attempts (${WS_MAX_RECONNECT_ATTEMPTS}) reached for profile ${profileId}`);
        // Fail all pending requests for this profile
        for (const [key, request] of pendingRequests.entries()) {
          if (key.startsWith(profileId + ':')) {
            request.reject(new Error('WebSocket connection failed - max reconnect attempts reached'));
            pendingRequests.delete(key);
          }
        }
        profileReconnectAttempts.delete(profileId);
        return;
      }
      
      reconnectInfo.count++;
      reconnectInfo.lastAttempt = now;
      profileReconnectAttempts.set(profileId, reconnectInfo);
      
      console.log(`[MJ-V2] Auto-reconnecting WebSocket for profile ${profileId} (attempt ${reconnectInfo.count}/${WS_MAX_RECONNECT_ATTEMPTS})...`);
      
      await new Promise(r => setTimeout(r, WS_RECONNECT_DELAY));
      
      try {
        await ensureWebSocket(profileId, token);
        console.log(`[MJ-V2] WebSocket reconnected successfully for profile ${profileId}`);
        // Counter reset happens in HELLO handler
      } catch (err) {
        console.error(`[MJ-V2] WebSocket reconnect failed for profile ${profileId}:`, err.message);
        // Will try again on next message or request
      }
    };
    
    // Connection timeout - if we don't get HELLO within 30 seconds, fail
    connectionTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        try { ws.close(); } catch (_) {}
        reject(new Error('WebSocket connection timeout - no HELLO received'));
      }
    }, 30000);
    
    ws.on('open', () => {
      console.log(`[MJ-V2] WebSocket opened for profile ${profileId}, sending identify...`);
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token,
          capabilities: 61,
          properties: {
            os: 'Windows',
            browser: 'Chrome',
            device: '',
            system_locale: 'en-US',
            browser_user_agent: 'Mozilla/5.0',
            browser_version: '99.0.0.0',
            os_version: '10',
            referrer: '',
            referring_domain: '',
            release_channel: 'stable',
            client_build_number: 9999
          },
          presence: { status: 'online', since: 0, activities: [], afk: false },
          compress: false
        }
      }));
    });
    
    ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data);
        if (payload.s) seq = payload.s;
        
        // HELLO - start heartbeat
        if (payload.op === 10) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
          
          heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: seq }));
            }
          }, payload.d.heartbeat_interval);
          
          // Connection ready
          const timer = setTimeout(() => closeWebSocket(profileId), TIMEOUT_MS);
          connections.set(profileId, { ws, token, timer, cleanup: () => { if (heartbeatInterval) clearInterval(heartbeatInterval); } });
          
          // Reset reconnect counter on successful connection
          profileReconnectAttempts.delete(profileId);
          
          if (!resolved) {
            resolved = true;
            console.log(`[MJ-V2] WebSocket connected successfully for profile ${profileId}`);
            resolve(ws);
          }
        }
        
        // Track any dispatch event as WebSocket activity for this profile
        // This helps distinguish "Midjourney is slow" from "captcha blocked"
        if (payload.t) {
          wsLastActivity.set(profileId, Date.now());
        }
        
        // MESSAGE_CREATE or MESSAGE_UPDATE - check for completed/progress images
        // Midjourney sends progress updates (0%...20%...60%) as MESSAGE_UPDATE edits
        // Catching these early cancels the captcha timer before it can false-fire
        if ((payload.t === 'MESSAGE_CREATE' || payload.t === 'MESSAGE_UPDATE') && payload.d) {
          handleMessage(profileId, payload.d);
        }
      } catch (_) {}
    });
    
    ws.on('error', (err) => {
      console.error(`[MJ-V2] WebSocket error for profile ${profileId}:`, err.message);
      cleanup();
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    
    ws.on('close', (code, reason) => {
      console.log(`[MJ-V2] WebSocket closed for profile ${profileId}, code: ${code}, reason: ${reason || 'none'}`);
      cleanup();
      connections.delete(profileId);
      if (!resolved) {
        resolved = true;
        reject(new Error(`WebSocket closed unexpectedly with code ${code}`));
      } else {
        // Connection was established but then closed - attempt auto-reconnect
        attemptReconnect();
      }
    });
  });
}

function closeWebSocket(profileId) {
  const conn = connections.get(profileId);
  if (conn) {
    clearTimeout(conn.timer);
    conn.cleanup?.();
    try { conn.ws?.close(); } catch (_) {}
    connections.delete(profileId);
  }
}

async function startImageRequest(prompt, profileId, workflowId = null) {
  try {
    // Store original prompt for tracking before any modifications
    const originalPromptForTracking = prompt;
    
    // Clean the prompt first
    prompt = cleanedPrompt(prompt);
    
    // Limit prompt to 1500 characters max
    if (prompt.length > 1500) {
      prompt = prompt.substring(0, 1500);
      console.log('[MJ-V2] Prompt truncated to 1500 characters');
    }
    
    // Check if prompt is already known to be banned - try AI regeneration instead of failing
    if (isPromptBanned(prompt)) {
      console.log('[MJ-V2] Prompt is cached as banned, attempting AI regeneration...');
      
      const altResult = await tryAlternativeForCachedBannedPrompt(prompt);
      
      if (!altResult.success) {
        // AI regeneration failed - now we can fail
        return { 
          success: false, 
          code: 'BANNED_PROMPT_MAX_RETRIES',
          seed: null,
          value: altResult.reason,
          prompt: originalPromptForTracking
        };
      }
      
      // Use the AI-generated alternative
      console.log(`[MJ-V2] Using AI-generated alternative prompt instead of banned one`);
      prompt = altResult.prompt;
    }
    
    // Get profile connection info from database
    const discordProfiles = (await readKey('discordProfiles')) || {};
    
    // If no profileId provided or profile doesn't exist, find first connected profile
    if (!profileId || !discordProfiles[profileId]) {
      const connectedProfile = Object.keys(discordProfiles).find(id => 
        discordProfiles[id]?.status === 'connected' && discordProfiles[id]?.['connection-info']
      );
      if (connectedProfile) {
        profileId = connectedProfile;
        console.log(`[MJ-V2] Using profile: ${profileId}`);
      }
    }
    
    const profile = discordProfiles[profileId];
    const connectionInfo = profile?.['connection-info'];
    
    if (!connectionInfo) {
      console.log(`[MJ-V2] Available profiles:`, Object.keys(discordProfiles));
      return { 
        success: false, 
        code: 'ERROR1',
        seed: null,
        value: `No connection info for profile "${profileId}". Please open the Discord profile in Settings and run a /imagine command to refresh session data.`,
        prompt
      };
    }
    
    // Add to queue and return promise (timeout starts when actually processing, not when queued)
    return new Promise((resolve) => {
      const queueData = getProfileQueue(profileId);
      queueData.queue.push({ profileId, prompt, workflowId, resolve });
      
      if (isBlocked(profileId)) {
        console.log(`[MJ-V2] Request queued but profile is blocked by captcha. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
        // Don't process queue - it will resume when captcha is solved
      } else {
        console.log(`[MJ-V2] Request queued. Active: ${queueData.activeCount}/${MAX_CONCURRENT}, Queued: ${queueData.queue.length}`);
        processQueue(profileId);
      }
    });
  } catch (error) {
    return { 
      success: false, 
      code: 'MIDJOURNEY_ERROR',
      seed: null,
      value: `Midjourney error: ${error.message}`,
      prompt
    };
  }
}

async function executeImagineRequest(profileId, prompt, workflowId, resolveQueue, originalPromptForTracking = null, alreadySentSeed = null) {
  let seed = alreadySentSeed;
  // Track the original prompt (for banned prompt retry logic)
  const trackingPrompt = originalPromptForTracking || prompt;

  // Idempotent slot release: called either early (from handleMessage on image arrival)
  // or late (from the await imagePromise path on timeout/error). Safe to call multiple times.
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      onRequestComplete(profileId);
    }
  };

  try {
    // CRITICAL: Check if profile is blocked by captcha BEFORE doing anything
    if (isBlocked(profileId)) {
      // For tests, fail immediately instead of re-queuing
      if (isTestWorkflow(workflowId)) {
        console.log(`[MJ-V2] Profile ${profileId} is blocked by captcha during test - failing immediately`);
        releaseSlot();
        resolveQueue({ 
          success: false, 
          code: 'CAPTCHA_BLOCKED',
          seed: null,
          value: 'Midjourney captcha verification required. Please solve the captcha in Settings > Discord Profiles before testing.',
          prompt
        });
        return;
      }
      console.log(`[MJ-V2] Profile ${profileId} is blocked by captcha, re-queuing request without sending to Discord`);
      const queueData = getProfileQueue(profileId);
      queueData.activeCount = Math.max(0, queueData.activeCount - 1);
      // Add back to front of queue so it's processed first after captcha is solved
      queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
      // Don't call onRequestComplete or resolveQueue - request stays pending
      return;
    }
    
    // Check again if prompt became banned while waiting in queue - try AI regeneration
    // Skip for already-sent requests (prompt was already accepted by Discord)
    if (!alreadySentSeed && isPromptBanned(prompt)) {
      console.log('[MJ-V2] Prompt is cached as banned (detected while in queue), attempting AI regeneration...');
      
      const altResult = await tryAlternativeForCachedBannedPrompt(prompt);
      
      if (!altResult.success) {
        // AI regeneration failed
        releaseSlot();
        resolveQueue({ 
          success: false, 
          code: 'BANNED_PROMPT_MAX_RETRIES',
          seed: null,
          value: altResult.reason,
          prompt: trackingPrompt
        });
        return;
      }
      
      // Use the AI-generated alternative
      console.log(`[MJ-V2] Using AI-generated alternative prompt instead of banned one`);
      prompt = altResult.prompt;
    }
    
    // Get profile connection info from database
    const discordProfiles = (await readKey('discordProfiles')) || {};
    const profile = discordProfiles[profileId];
    const connectionInfo = profile?.['connection-info'];
    
    const { APPLICATION_ID, GUILD_ID, CHANNEL_ID, SESSION_ID, DATA_VERSION, DATA_ID, AUTHORIZATION } = connectionInfo || {};
    
    const requiredFields = { APPLICATION_ID, CHANNEL_ID, SESSION_ID, DATA_VERSION, DATA_ID, AUTHORIZATION };
    const missingFields = Object.entries(requiredFields)
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missingFields.length > 0) {
      console.warn(`[MJ-V2] Profile ${profileId} has incomplete connection info: ${missingFields.join(', ')}`);
      releaseSlot();
      resolveQueue({ 
        success: false, 
        code: 'ERROR1',
        seed: null,
        value: `Missing required connection fields (${missingFields.join(', ')}). Open the Discord profile in Settings and submit one /imagine command to refresh session data.`,
        prompt
      });
      return;
    }
    
    // Double-check captcha status before WebSocket connection (in case it was set while we were getting profile data)
    if (isBlocked(profileId)) {
      // For tests, fail immediately instead of re-queuing
      if (isTestWorkflow(workflowId)) {
        console.log(`[MJ-V2] Captcha detected before WebSocket connection during test - failing immediately`);
        releaseSlot();
        resolveQueue({ 
          success: false, 
          code: 'CAPTCHA_BLOCKED',
          seed: null,
          value: 'Midjourney captcha verification required. Please solve the captcha in Settings > Discord Profiles before testing.',
          prompt
        });
        return;
      }
      console.log(`[MJ-V2] Captcha detected before WebSocket connection, re-queuing request`);
      const queueData = getProfileQueue(profileId);
      queueData.activeCount = Math.max(0, queueData.activeCount - 1);
      queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
      return;
    }
    
    // Ensure WebSocket is open (resets 10-min timer)
    await ensureWebSocket(profileId, AUTHORIZATION);
    
    // Triple-check captcha status before sending request to Discord
    if (isBlocked(profileId)) {
      // For tests, fail immediately instead of re-queuing
      if (isTestWorkflow(workflowId)) {
        console.log(`[MJ-V2] Captcha detected after WebSocket during test - failing immediately`);
        releaseSlot();
        resolveQueue({ 
          success: false, 
          code: 'CAPTCHA_BLOCKED',
          seed: null,
          value: 'Midjourney captcha verification required. Please solve the captcha in Settings > Discord Profiles before testing.',
          prompt
        });
        return;
      }
      console.log(`[MJ-V2] Captcha detected after WebSocket but before request, re-queuing`);
      const queueData = getProfileQueue(profileId);
      queueData.activeCount = Math.max(0, queueData.activeCount - 1);
      queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
      return;
    }
    
    // Generate seed and send /imagine only if not already sent (prevents duplicate requests after captcha re-queue)
    if (!alreadySentSeed) {
      seed = Math.floor(Math.random() * 4294967290);
      const promptWithSeed = `${prompt} --seed ${seed}`;
      
      // Build interaction payload
      const payload = {
        type: 2,
        application_id: APPLICATION_ID,
        guild_id: GUILD_ID || undefined,
        channel_id: CHANNEL_ID,
        session_id: SESSION_ID,
        data: {
          version: DATA_VERSION,
          id: DATA_ID,
          name: 'imagine',
          type: 1,
          options: [{ type: 3, name: 'prompt', value: promptWithSeed }],
          application_command: {
            id: DATA_ID,
            type: 1,
            application_id: APPLICATION_ID,
            version: DATA_VERSION,
            name: 'imagine',
            description: 'Create images with Midjourney',
            options: [{
              type: 3,
              name: 'prompt',
              description: 'The prompt to imagine',
              required: true
            }],
            dm_permission: true,
            contexts: [0, 1, 2],
            integration_types: [0, 1]
          },
          attachments: []
        },
        nonce: generateNonce(),
        analytics_location: 'slash_ui'
      };
      
      // Final captcha check right before the actual API call
      if (isBlocked(profileId)) {
        // For tests, fail immediately instead of re-queuing
        if (isTestWorkflow(workflowId)) {
          console.log(`[MJ-V2] Captcha detected right before API call during test - failing immediately`);
          releaseSlot();
          resolveQueue({ 
            success: false, 
            code: 'CAPTCHA_BLOCKED',
            seed: null,
            value: 'Midjourney captcha verification required. Please solve the captcha in Settings > Discord Profiles before testing.',
            prompt
          });
          return;
        }
        console.log(`[MJ-V2] Captcha detected right before API call, aborting and re-queuing`);
        const queueData = getProfileQueue(profileId);
        queueData.activeCount = Math.max(0, queueData.activeCount - 1);
        queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue });
        return;
      }
      
      // Send interaction request
      await axios.post('https://discord.com/api/v9/interactions', payload, {
        headers: { Authorization: AUTHORIZATION, 'Content-Type': 'application/json' }
      });
      
      console.log(`[MJ-V2] Imagine request sent. Seed: ${seed}`);
    } else {
      console.log(`[MJ-V2] Resuming already-sent request with seed ${seed}, skipping duplicate /imagine POST`);
    }
    
    // Create promise to wait for image completion (timeout starts NOW when actually processing)
    const requestKey = `${profileId}:${seed}`;
    const imagePromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestKey);
        resolve({ 
          success: false, 
          code: 'ERROR3',
          seed,
          value: `Image generation timeout after ${IMAGE_TIMEOUT_MS / 1000}s. Seed: ${seed}`,
          prompt
        });
      }, IMAGE_TIMEOUT_MS);
      
      const request = {
        seed: `--seed ${seed}`,
        seedNum: seed,
        originalPrompt: trackingPrompt, // Original prompt for retry tracking
        currentPrompt: prompt, // Current prompt being tried (may be AI-generated alternative)
        workflowId: workflowId,
        queueResolve: resolveQueue, // Store the queue resolver for retry logic
        generationTimeout: timeout, // Cleared as soon as Discord delivers the image
        seedReceived: false,
        captchaTimer: null, // Will be set after API call succeeds
        releaseSlot, // Called by handleMessage as soon as Discord delivers the image
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        }
      };
      
      pendingRequests.set(requestKey, request);
    });
    
    // TWO-PHASE CAPTCHA DETECTION
    // Phase 1 (soft, 90s): If no seed response, check if WebSocket is still active.
    //   - If WS has recent activity, Midjourney is likely just slow → extend to Phase 2.
    //   - If WS is dead AND network is down → extend timeout (not captcha).
    //   - If WS is dead AND network is fine → declare captcha.
    // Phase 2 (hard, +150s): If still no seed response after extension → declare captcha.
    const captchaTimerId = setTimeout(async () => {
      // Remove from active timers tracking
      activeCaptchaTimers.delete(requestKey);
      
      // Double-check the request still exists and seed wasn't received
      const currentRequest = pendingRequests.get(requestKey);
      if (!currentRequest) {
        console.log(`[MJ-V2] Captcha soft timer fired but request ${requestKey} already completed, ignoring`);
        return;
      }
      
      if (currentRequest.seedReceived) {
        console.log(`[MJ-V2] Captcha soft timer fired but seed already received for ${requestKey}, ignoring`);
        return;
      }
      
      // Check if profile is already blocked (another request may have triggered it)
      if (isBlocked(profileId)) {
        // For tests, fail immediately instead of re-queuing
        if (isTestWorkflow(workflowId)) {
          console.log(`[MJ-V2] Profile already blocked by captcha during test - failing immediately`);
          pendingRequests.delete(requestKey);
          releaseSlot();
          currentRequest.resolve({ 
            success: false, 
            code: 'CAPTCHA_BLOCKED',
            seed,
            value: 'Midjourney captcha verification required. Please solve the captcha in Settings > Discord Profiles before testing.',
            prompt
          });
          resolveQueue({ 
            success: false, 
            code: 'CAPTCHA_BLOCKED',
            seed,
            value: 'Midjourney captcha verification required. Please solve the captcha in Settings > Discord Profiles before testing.',
            prompt
          });
          return;
        }
        console.log(`[MJ-V2] Captcha soft timer fired but profile ${profileId} already blocked, re-queuing without duplicate notification`);
        pendingRequests.delete(requestKey);
        
        // Just re-queue, don't block again
        const queueData = getProfileQueue(profileId);
        queueData.activeCount = Math.max(0, queueData.activeCount - 1);
        queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
        currentRequest.resolve({ requeued: true });
        return;
      }
      
      // --- PHASE 1: Check WebSocket activity before assuming captcha ---
      const lastActivity = wsLastActivity.get(profileId) || 0;
      const timeSinceActivity = Date.now() - lastActivity;
      const wsIsActive = timeSinceActivity < CAPTCHA_SOFT_TIMEOUT_MS; // WS had activity within the soft timeout window
      
      if (wsIsActive) {
        // WebSocket is alive - Midjourney is likely just slow (peak hours, relax mode, etc.)
        console.log(`[MJ-V2] Soft timeout fired for ${requestKey} but WS active ${Math.round(timeSinceActivity / 1000)}s ago - extending to hard phase (${CAPTCHA_HARD_TIMEOUT_MS / 1000}s)`);
        const hardTimerId = setTimeout(async () => {
          activeCaptchaTimers.delete(requestKey + ':hard');
          const req = pendingRequests.get(requestKey);
          if (!req || req.seedReceived) return;
          if (isBlocked(profileId)) {
            pendingRequests.delete(requestKey);
            const queueData = getProfileQueue(profileId);
            queueData.activeCount = Math.max(0, queueData.activeCount - 1);
            queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
            req.resolve({ requeued: true });
            return;
          }
          
          // Check WS activity one more time - if still active, it's genuinely slow, not captcha
          const finalActivity = wsLastActivity.get(profileId) || 0;
          const finalTimeSince = Date.now() - finalActivity;
          if (finalTimeSince < 30000) {
            // WS had activity in last 30s even after hard timeout - very unlikely to be captcha
            console.log(`[MJ-V2] Hard timeout fired for ${requestKey} but WS still active ${Math.round(finalTimeSince / 1000)}s ago - NOT declaring captcha, waiting for image timeout`);
            return; // Let the IMAGE_TIMEOUT_MS handle it as a normal timeout, not captcha
          }
          
          console.log(`[MJ-V2] Hard captcha timeout confirmed for ${requestKey} - no seed response and WS inactive for ${Math.round(finalTimeSince / 1000)}s`);
          if (isTestWorkflow(workflowId)) {
            pendingRequests.delete(requestKey);
            releaseSlot();
            req.resolve({ success: false, code: 'CAPTCHA_DETECTED', seed, value: 'Midjourney captcha verification detected during test. Please solve the captcha and try again.', prompt });
            resolveQueue({ success: false, code: 'CAPTCHA_DETECTED', seed, value: 'Midjourney captcha verification detected during test. Please solve the captcha and try again.', prompt });
            return;
          }
          blockProfile(profileId, seed, prompt);
          pendingRequests.delete(requestKey);
          const queueData = getProfileQueue(profileId);
          queueData.activeCount = Math.max(0, queueData.activeCount - 1);
          queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
          req.resolve({ requeued: true });
        }, CAPTCHA_HARD_TIMEOUT_MS);
        activeCaptchaTimers.set(requestKey + ':hard', hardTimerId);
        return;
      }
      
      // WebSocket is NOT active - check network connectivity before assuming captcha
      try {
        await axios.get('https://discord.com/api/v9/gateway', { timeout: 10000 });
      } catch (networkError) {
        console.log(`[MJ-V2] Network error detected for ${requestKey}, extending timeout instead of blocking: ${networkError.message}`);
        // Network is down - don't treat as captcha, just extend the timeout
        const extendedTimer = setTimeout(() => {
          const req = pendingRequests.get(requestKey);
          if (req && !req.seedReceived && !isBlocked(profileId)) {
            console.log(`[MJ-V2] Extended timeout expired for ${requestKey}, now treating as captcha`);
            if (isTestWorkflow(workflowId)) {
              pendingRequests.delete(requestKey);
              releaseSlot();
              req.resolve({ success: false, code: 'CAPTCHA_DETECTED', seed, value: 'Midjourney captcha verification detected during test. Please solve the captcha and try again.', prompt });
              resolveQueue({ success: false, code: 'CAPTCHA_DETECTED', seed, value: 'Midjourney captcha verification detected during test. Please solve the captcha and try again.', prompt });
              return;
            }
            blockProfile(profileId, seed, prompt);
            pendingRequests.delete(requestKey);
            const queueData = getProfileQueue(profileId);
            queueData.activeCount = Math.max(0, queueData.activeCount - 1);
            queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
            req.resolve({ requeued: true });
          }
        }, CAPTCHA_HARD_TIMEOUT_MS); // Give another full hard timeout period
        activeCaptchaTimers.set(requestKey + ':extended', extendedTimer);
        return;
      }
      
      // Network is fine but WS is dead and no seed received → captcha
      console.log(`[MJ-V2] Captcha detected for ${requestKey} - no seed response within ${CAPTCHA_SOFT_TIMEOUT_MS / 1000}s, WS inactive for ${Math.round(timeSinceActivity / 1000)}s, network OK`);
      
      // For tests, fail immediately instead of blocking and re-queuing
      if (isTestWorkflow(workflowId)) {
        console.log(`[MJ-V2] Captcha detected during test - failing immediately`);
        pendingRequests.delete(requestKey);
        releaseSlot();
        currentRequest.resolve({ 
          success: false, 
          code: 'CAPTCHA_DETECTED',
          seed,
          value: 'Midjourney captcha verification detected during test. Please solve the captcha and try again.',
          prompt
        });
        resolveQueue({ 
          success: false, 
          code: 'CAPTCHA_DETECTED',
          seed,
          value: 'Midjourney captcha verification detected during test. Please solve the captcha and try again.',
          prompt
        });
        return;
      }
      
      pendingRequests.delete(requestKey);
      
      // Block profile and notify
      blockProfile(profileId, seed, prompt);
      
      // Re-queue the request so it will be processed after captcha is solved
      console.log('[MJ-V2] Re-queuing request to process after captcha is solved...');
      const queueData = getProfileQueue(profileId);
      queueData.activeCount = Math.max(0, queueData.activeCount - 1);
      // Add back to front of queue so it's processed first
      queueData.queue.unshift({ profileId, prompt, workflowId, resolve: resolveQueue, alreadySentSeed: seed });
      
      // Resolve the imagePromise but don't resolve the queue promise yet
      currentRequest.resolve({ requeued: true });
    }, CAPTCHA_SOFT_TIMEOUT_MS);
    
    // Track the timer so we can clear it when profile is unblocked
    activeCaptchaTimers.set(requestKey, captchaTimerId);
    
    // Update the pending request with the timer
    const pendingReq = pendingRequests.get(requestKey);
    if (pendingReq) {
      pendingReq.captchaTimer = captchaTimerId;
    };
    // Wait for image to complete
    const result = await imagePromise;
    
    // If request was requeued due to captcha, don't complete - it will be processed later
    if (result.requeued) {
      console.log('[MJ-V2] Request requeued, not completing yet');
      return;
    }
    
    // Release slot if not already released early (e.g. timeout path — image never arrived)
    releaseSlot();
    resolveQueue(result);
  } catch (error) {
    releaseSlot();
    resolveQueue({ 
      success: false, 
      code: 'MIDJOURNEY_ERROR',
      seed,
      value: `Midjourney error: ${error.message}`,
      prompt
    });
  }
}

module.exports = {
  startImageRequest,
  getCaptchaStatus,
  unblockProfile,
  stopWorkflowQueues,
  clearWorkflowStateForRerun,
  captchaState,
  waitingQueue,
  workflowQueues,
  detectMessageType,
  // Additional exports
  closeWebSocket,
  getQueueStatus,
  isWorkflowStopped: (workflowId) => stoppedWorkflows.has(workflowId)
};

// For compatibility - detectMessageType
function detectMessageType(messageData, embed) {
  const title = (embed?.title || '').trim().toLowerCase();
  const footerText = embed?.footer?.text || '';
  const messageContent = messageData?.content || '';
  
  if (title === 'banned prompt detected') {
    const seed = extractSeedFromContent(footerText) || extractSeedFromContent(messageContent);
    return { type: 'banned_prompt', seed, prompt: footerText || messageContent, confidence: 'high' };
  }
  
  return { type: 'unknown', seed: NaN, prompt: '', confidence: 'low' };
}

function getQueueStatus(profileId) {
  if (profileId) {
    const queueData = profileQueues.get(profileId);
    if (!queueData) return { activeCount: 0, queuedCount: 0 };
    return { activeCount: queueData.activeCount, queuedCount: queueData.queue.length };
  }
  // Return all profiles status
  const status = {};
  for (const [id, data] of profileQueues.entries()) {
    status[id] = { activeCount: data.activeCount, queuedCount: data.queue.length };
  }
  return status;
}
