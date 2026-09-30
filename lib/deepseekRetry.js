const RETRY_DELAYS = [15000, 30000, 60000, 120000, 120000];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Workflow stopped by user'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

// Keep the profile's slot while waiting so queued jobs cannot race the retry.
async function retryRateLimited({ getProfile, defer, attempt, signal, wait = sleep, now = Date.now }) {
  for (let retry = 0; ; retry++) {
    while (true) {
      if (signal?.aborted) throw new Error('Workflow stopped by user');
      const profile = getProfile();
      if (!profile?.token || profile.status !== 'connected' || profile.muteUnknown || profile.muteUntil > now()) {
        return { success: false, value: 'DeepSeek account is restricted or logged out. Check Settings.' };
      }
      const remaining = (profile.retryAfter || 0) - now();
      if (remaining <= 0) break;
      // Recheck logout, profile removal, and restrictions during long waits.
      await wait(Math.min(remaining, 1000), signal);
    }

    let result;
    try {
      result = await attempt();
    } catch (error) {
      if (!(getProfile()?.retryAfter > now())) throw error;
      result = { success: false, rateLimited: true };
    }
    if (result.success) return result;
    if (!result.rateLimited && !(getProfile()?.retryAfter > now())) return result;

    // Persist even the final cooldown to protect subsequent jobs and restarts.
    defer(now() + RETRY_DELAYS[Math.min(retry, RETRY_DELAYS.length - 1)]);
    if (retry >= RETRY_DELAYS.length) {
      return { success: false, value: 'DeepSeek is still rate limited after 5 automatic retries. Please try again later.' };
    }
    console.log(`[DeepSeek Browser] Rate limited; waiting before retry ${retry + 1}/${RETRY_DELAYS.length}.`);
  }
}

module.exports = { retryRateLimited };
