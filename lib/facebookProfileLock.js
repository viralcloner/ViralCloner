/**
 * facebookProfileLock.js
 *
 * Shared per-profile session mutex for ALL Facebook Groups operations
 * (posting, commenting, editing, post/group/profile scans, viral actions),
 * whether triggered by the scheduler or by manual UI actions via IPC.
 *
 * WHY: Facebook flags an account when it sees the SAME profile active in two
 * concurrent sessions (browser or HTTP) — this is the trigger behind the
 * "Vous ne pouvez pas créer plusieurs sessions" restriction and the selfie /
 * identity checkpoint. The scheduler used to serialize only scheduled *posts*;
 * comments, scans and manual UI actions ran outside that lock and could overlap
 * a live post/comment on the same profile.
 *
 * This module guarantees at most ONE live operation per profileId at any instant,
 * app-wide. Operations for the SAME profile queue and run one after another;
 * operations for DIFFERENT profiles run in parallel.
 *
 * The lock lives at the automation-entry layer (each facebookGroup*.js entry fn
 * runs its body inside runExclusive), so no caller can bypass it. It is
 * NON-REENTRANT: never nest two runExclusive() calls for the same profileId
 * (no automation entry fn calls another automation entry fn — verified).
 *
 * Modeled on lib/tiktokAdsBrowserLock.js.
 */

// profileId -> { count: number, tail: Promise } where count is queued+running tasks.
const _state = new Map();

/**
 * Returns true if a task for this profile is currently running or queued.
 * Used by the scheduler tick as a non-blocking pre-check so it can DEFER work
 * to the next tick instead of piling up a queue.
 * @param {string} profileId
 * @returns {boolean}
 */
function isBusy(profileId) {
  if (!profileId) return false;
  const s = _state.get(profileId);
  return !!(s && s.count > 0);
}

/**
 * Run `fn` exclusively for the given profileId. Calls for the same profileId are
 * queued and executed one after another; calls for different profileIds run
 * independently. Resolves/rejects with fn's own result/error.
 *
 * @template T
 * @param {string} profileId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runExclusive(profileId, fn) {
  if (!profileId) {
    // No profile to key on — just run it (nothing to serialize against).
    return Promise.resolve().then(fn);
  }

  let s = _state.get(profileId);
  if (!s) {
    s = { count: 0, tail: Promise.resolve() };
    _state.set(profileId, s);
  }

  s.count++;

  // Chain this task after the current tail, swallowing the previous result/error
  // so one failure does not break the queue for the rest.
  const previous = s.tail;
  const run = previous.then(
    () => fn(),
    () => fn()
  );

  // The tail used for chaining must never reject; track it separately so the
  // queue keeps flowing regardless of individual task outcomes. Decrement the
  // in-flight counter and drop the map entry once the chain fully drains.
  s.tail = run.then(
    () => { _release(profileId); },
    () => { _release(profileId); }
  );

  return run;
}

function _release(profileId) {
  const s = _state.get(profileId);
  if (!s) return;
  s.count--;
  if (s.count <= 0) _state.delete(profileId);
}

module.exports = { runExclusive, isBusy };
