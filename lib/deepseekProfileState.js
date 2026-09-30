const { readKey, updateData } = require('./utils');

const PROFILE_KEY = 'deepseekBrowserProfiles';

function isExpired(status, body) {
  if (status === 401) return true;
  const message = body?.data?.biz_msg || body?.msg || body?.message || '';
  return /unauthori[sz]ed|not\s+(?:logged|signed)\s+in|log\s*in\s+again|invalid\s+(?:access\s+)?token|token\s+(?:is\s+)?expired|session\s+(?:is\s+)?expired|authentication\s+(?:failed|required)/i.test(message);
}

function available(profile, now = Date.now()) {
  return !!(profile?.token && profile.status === 'connected' &&
    !profile.muteUnknown && !(profile.muteUntil > now) && !(profile.retryAfter > now));
}

// Storage helpers are synchronous: keep read/modify/write together so responses
// from different accounts cannot overwrite each other's updates.
function observe(profileId, status, body, headers = {}, currentUser = false) {
  const profiles = readKey(PROFILE_KEY) || {};
  const profile = profiles[profileId];
  if (!profile) return;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString()); } catch (_) { body = {}; }
  }
  let changed = false;
  if (isExpired(status, body)) {
    profile.status = 'expired';
    changed = true;
  }
  const chat = body?.data?.biz_data?.chat;
  if (currentUser && status === 200 && body?.code === 0 && body?.data?.biz_code === 0 && chat) {
    const until = Number(chat.mute_until) * 1000;
    const muted = chat.is_muted === 1 || chat.is_muted === true;
    if (muted) {
      profile.muteUntil = Number.isFinite(until) && until > 0 ? Math.ceil(until) : null;
      profile.muteUnknown = !profile.muteUntil;
    } else if (chat.is_muted === 0 || chat.is_muted === false) {
      profile.muteUntil = null;
      profile.muteUnknown = false;
    }
    profile.statusCheckedAt = Date.now();
    changed = true;
  }
  if (status === 429) {
    const value = headers['retry-after'];
    const seconds = Number(value);
    const until = value && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value);
    profile.retryAfter = Math.max(profile.retryAfter || 0, Number.isFinite(until) ? until : Date.now() + 60000);
    changed = true;
  }
  if (changed) updateData(PROFILE_KEY, profiles);
  return profile;
}

function defer(profileId, until) {
  const profiles = readKey(PROFILE_KEY) || {};
  if (!profiles[profileId]) return;
  profiles[profileId].retryAfter = Math.max(profiles[profileId].retryAfter || 0, until);
  updateData(PROFILE_KEY, profiles);
}

module.exports = { available, observe, isExpired, defer };
