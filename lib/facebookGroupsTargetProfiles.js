function getTargetProfileIds(target) {
  if (target.profileIds != null && !Array.isArray(target.profileIds)) {
    throw new TypeError('Profile selection must be an array');
  }
  const ids = target.profileIds != null ? target.profileIds : (target.profileId ? [target.profileId] : []);
  if (ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('Invalid profile selection');
  }
  return [...new Set(ids)];
}

function getTargetProfileCandidates(target, groupProfiles) {
  const ids = getTargetProfileIds(target);
  return ids.length ? groupProfiles.filter(p => ids.includes(p.profileId)) : groupProfiles;
}

module.exports = { getTargetProfileIds, getTargetProfileCandidates };
