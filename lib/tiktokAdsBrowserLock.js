/**
 * TikTok Ads per-profile browser lock
 *
 * All TikTok Ads automation (image + video) launches a VCBrowser using the
 * SAME user-data-dir for a given profile (userData/profiles/{profileId}).
 * Chrome enforces a singleton lock on that directory, so launching two
 * browsers for the same profile concurrently makes them collide and share
 * session/cache state. The visible symptom is many concurrent generations
 * returning the SAME image because each in-page poller reads another task's
 * cached drafts.
 *
 * This module serializes work PER PROFILE: only one TikTok Ads browser task
 * runs at a time for a given profileId. Different profiles still run in
 * parallel. The image and video nodes MUST share this single lock because
 * they use the same profile directory.
 */

// profileId -> Promise representing the tail of the queued chain for that profile
const profileChains = new Map();

/**
 * Run `fn` exclusively for the given profileId. Calls for the same profileId
 * are queued and executed one after another; calls for different profileIds
 * run independently.
 *
 * @template T
 * @param {string} profileId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runWithProfileLock(profileId, fn) {
  if (!profileId) {
    // No profile to key on — just run it.
    return Promise.resolve().then(fn);
  }

  const previous = profileChains.get(profileId) || Promise.resolve();

  // Chain this task after the previous one, swallowing the previous result/error
  // so one failure does not break the queue for the rest.
  const run = previous.then(
    () => fn(),
    () => fn()
  );

  // The tail used for chaining must never reject; track it separately so the
  // queue keeps flowing regardless of individual task outcomes.
  const tail = run.then(
    () => {},
    () => {}
  );
  profileChains.set(profileId, tail);

  // Clean up the map entry once this is the last task in the chain.
  tail.finally(() => {
    if (profileChains.get(profileId) === tail) {
      profileChains.delete(profileId);
    }
  });

  return run;
}

module.exports = { runWithProfileLock };
