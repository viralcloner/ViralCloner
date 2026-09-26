/**
 * Facebook Group Scan Info Automation
 *
 * Fetches public profile/stats information about a Facebook group from its ID.
 *
 * Fires two Relay persisted queries directly over HTTPS using the stored
 * cookies of a linked profile (no browser needed):
 *
 *   - CometGroupAboutRootQuery  (doc_id 26848302004827785)
 *       → created time, posts today / last month, total members text, growth,
 *         description, admin name, privacy.
 *   - CometGroupRootQuery       (doc_id 26835153426165001)
 *       → name, canonical url, cover image, profile picture, member count,
 *         privacy label, viewer join state, available tabs.
 *
 * The two responses are merged into a single flat `info` object.
 */

const { getFacebookSessionTokens, postGraphQL } = require("../../lib/facebookHttpSession");
const { getDocId, updateDocId, invalidateDocId, isDocIdError, isDefiniteDocIdError } = require("../../lib/facebookDocIds");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");

const MODULE = "[FbGroupScanInfo]";

const ABOUT_QUERY  = "CometGroupAboutRootQuery";
const ROOT_QUERY   = "CometGroupRootQuery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract basic group info (name, cover, profilePicture) directly from
 * the group page HTML body.  Used as a fallback when CometGroupRootQuery
 * has a stale doc_id and returns null.
 */
function parseHtmlGroupInfo(html) {
  if (!html) return {};

  // Group name — best source is the h1 tag(s) on the page.
  // We collect all h1 text content, strip tags, and pick the first one that
  // looks like a group name (not a generic Facebook phrase, not too short/long).
  let name = null;
  const skipPhrases = /^(facebook|log in|sign up|create account|groups|find new groups)$/i;
  const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
  for (const m of h1Matches) {
    // Strip inner HTML tags to get plain text, then decode common entities.
    const text = m[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .trim();
    if (text.length >= 2 && text.length <= 200 && !skipPhrases.test(text)) {
      name = text;
      break;
    }
  }

  // Fallback chain when h1 yields nothing useful.
  if (!name) {
    const namePatterns = [
      // JSON data blobs embedded in the page script
      /"groupName"\s*:\s*"([^"]{2,120})"/,
      /"group"\s*:\s*\{\s*"__typename"[^}]*"name"\s*:\s*"([^"]{2,120})"/,
      /og:title[^>]*content="([^"]{2,120})"/,
      /<title>([^<]{2,120})<\/title>/,
    ];
    for (const re of namePatterns) {
      const m = html.match(re);
      if (m && m[1] && !/facebook\.com/i.test(m[1]) && !skipPhrases.test(m[1].trim())) {
        name = m[1].trim();
        break;
      }
    }
  }

  // Cover image. Priority:
  // 1. og:image — Facebook sets this to the actual cover photo at a usable resolution.
  // 2. cover_photo_content → photo → image → uri in the JSON blob (highest-res in HTML).
  // 3. Any scontent fbcdn URL near "cover_renderer" in the JSON blob.
  let coverImage = null;

  // og:image (two attribute orderings)
  const ogM = html.match(/property="og:image"[^>]*content="(https:\/\/[^"]+)"/) ||
              html.match(/content="(https:\/\/[^"]+)"[^>]*property="og:image"/);
  if (ogM) coverImage = ogM[1];

  // JSON blob: cover_photo_content → photo → image → uri
  if (!coverImage) {
    const idx = html.indexOf('"cover_photo_content"');
    if (idx >= 0) {
      const ctx = html.slice(idx, idx + 800);
      const m = ctx.match(/"uri"\s*:\s*"(https:\\\/\\\/scontent[^"]+)"/);
      if (m) coverImage = m[1].replace(/\\\//g, "/");
    }
  }

  // Fallback: first scontent URL within cover_renderer block
  if (!coverImage) {
    const idx = html.indexOf('"cover_renderer"');
    if (idx >= 0) {
      const ctx = html.slice(idx, idx + 800);
      const m = ctx.match(/"uri"\s*:\s*"(https:\\\/\\\/scontent[^"]+)"/);
      if (m) coverImage = m[1].replace(/\\\//g, "/");
    }
  }

  // profilePicture is a small sticky-bar thumbnail — not useful as a cover.
  const profilePicture = null;

  return { name: name || null, coverImage: coverImage || null, profilePicture };
}
const dig = (obj, ...keys) => {
  let c = obj;
  for (const k of keys) { if (c == null) return null; c = c[k]; }
  return c;
};

/**
 * Extract the first integer from a localized count string.
 * "29 593 membres au total" -> 29593 ; "+ 6 000 la semaine" -> 6000
 */
function intFromText(text) {
  if (text == null) return null;
  const digits = String(text).replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

// ---------------------------------------------------------------------------
// Parse CometGroupAboutRootQuery
// ---------------------------------------------------------------------------
function parseAbout(json) {
  const units = dig(json, "data", "group", "about_feed_units") || [];
  const findUnit = (typename) =>
    (units.find((u) => u && u.__typename === typename) || {}).group || {};

  const activity = findUnit("GroupsAboutFeedActivityCardUnit");
  const members  = findUnit("GroupsAboutFeedMembersCardUnit");
  const about    = findUnit("GroupsAboutFeedAboutCardUnit");

  const adminSentence = dig(members, "admin_and_moderator_social_sentence", "text");
  const g = dig(json, "data", "group") || {};

  return {
    name:                g.name || dig(g, "featurable_title", "text") || null,
    coverImage:          dig(g, "cover_renderer", "cover_photo_content", "photo", "image", "uri") || null,
    profilePicture:      dig(g, "profile_picture_for_sticky_bar", "uri")
                          || dig(g, "if_viewer_cannot_change_cover_photo", "profile_picture_120", "uri")
                          || null,
    createdTime:         activity.created_time ?? null,                 // unix seconds
    postsToday:          activity.number_of_posts_in_last_day ?? null,
    postsLastMonth:      activity.number_of_posts_in_last_month ?? null,
    membersTotalText:    activity.group_total_members_info_text || null,
    membersTotal:        intFromText(activity.group_total_members_info_text),
    newMembersText:      activity.group_new_members_info_text || null,
    membersFormatted:    dig(members, "group_member_profiles", "formatted_count_text") || null,
    adminCount:          dig(members, "facepile_admin_profiles", "count") ?? null,
    moderatorCount:      dig(members, "facepile_moderator_profiles", "count") ?? null,
    adminName:           adminSentence || null,
    description:         dig(about, "description_with_entities", "text") || null,
    privacyIcon:         dig(about, "about_info_items", 0, "group", "privacy_info", "icon_name") || null,
  };
}

// ---------------------------------------------------------------------------
// Parse CometGroupRootQuery
// ---------------------------------------------------------------------------
function parseRoot(json) {
  const g = dig(json, "data", "group", "profile_header_renderer", "group") || {};

  const tabs = (dig(g, "group_content_views", "edges") || [])
    .map((e) => dig(e, "node"))
    .filter(Boolean)
    .map((n) => ({
      title:     n.content_view_title || null,
      type:      n.content_view_type || null,
      uri:       n.content_view_uri || null,
      isDefault: !!n.is_default_selected_content_view,
    }));

  return {
    name:              g.name || dig(g, "featurable_title", "text") || null,
    url:               g.url || null,
    privacyLabel:      dig(g, "privacy_info", "title", "text") || null,
    privacyIcon:       dig(g, "privacy_info", "icon_name") || null,
    membersFormatted:  dig(g, "group_member_profiles", "formatted_count_text") || null,
    coverImage:        dig(g, "cover_renderer", "cover_photo_content", "photo", "image", "uri") || null,
    profilePicture:    dig(g, "profile_picture_for_sticky_bar", "uri")
                        || dig(g, "if_viewer_cannot_change_cover_photo", "profile_picture_120", "uri")
                        || null,
    viewerJoinState:   g.viewer_join_state || null,
    hasMembershipQuestions: g.has_membership_questions ?? null,
    themeColor:        dig(g, "if_viewer_can_see_expanded_color", "group_theme_color", "hexcolor") || null,
    tabs,
  };
}

// ---------------------------------------------------------------------------
// Fire one persisted query over HTTP
// ---------------------------------------------------------------------------
async function fireQuery({ friendlyName, variables, session, userAgent, referer }) {
  const { dtsg, lsd, uid, cookieHeader } = session;
  const docId = getDocId(friendlyName);
  if (!docId) {
    console.warn(`${MODULE} No doc_id known for ${friendlyName}`);
    return null;
  }

  let resp;
  try {
    resp = await postGraphQL({
      friendlyName, docId, variables,
      dtsg, lsd, uid, cookieHeader,
      referer, userAgent,
    });
  } catch (err) {
    console.warn(`${MODULE} ${friendlyName} request failed: ${err.message}`);
    return null;
  }

  if (!resp.ok || !resp.json) {
    console.warn(`${MODULE} ${friendlyName} HTTP ${resp.status || "?"} / unparsable body`);
    return null;
  }

  if (resp.json.errors && resp.json.errors.length) {
    const msg = resp.json.errors[0].message;
    if (isDocIdError(msg)) {
      console.warn(`${MODULE} ${friendlyName} doc_id appears stale: ${msg}`);
      if (isDefiniteDocIdError(msg)) invalidateDocId(friendlyName);
    } else {
      console.warn(`${MODULE} ${friendlyName} GraphQL error: ${msg}`);
    }
    return null;
  }

  updateDocId(friendlyName, docId); // confirm current doc_id is valid
  return resp.json;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function facebookGroupScanInfo({ groupId, groupUrl, profileId, profileData }) {
  if (!groupId) return { success: false, error: "Missing groupId" };
  if (!profileData) return { success: false, error: "Missing profile data" };

  const cookies = profileData.cookies || [];
  if (!cookies.length) {
    return { success: false, error: "Linked profile has no cookies — log it into Facebook first" };
  }

  // Resolve a realistic user agent (same logic as scan-post)
  let fingerprint = profileData.fingerprint;
  if (!fingerprint || Object.keys(fingerprint).length === 0) {
    fingerprint = getConsistentFingerprintForProfile(profileId);
  }
  try {
    const vcVersion = getVCBrowserVersion();
    if (fingerprint.userAgent && vcVersion?.full) {
      fingerprint.userAgent = fingerprint.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${vcVersion.full}`);
    }
  } catch (_) {}
  const userAgent = fingerprint.userAgent
    || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  const referer = groupUrl || `https://www.facebook.com/groups/${groupId}`;

  const session = await getFacebookSessionTokens(cookies, userAgent, referer);
  if (!session) {
    return { success: false, error: "Facebook session expired — re-login this profile" };
  }

  // Facebook's GraphQL groupID variable needs the NUMERIC id. The group may be
  // stored under a vanity slug (e.g. "myrecipes"), so resolve it to the numeric
  // id extracted from the group page HTML that the session fetch already loaded.
  let numericGroupId = String(groupId);
  if (!/^\d+$/.test(numericGroupId)) {
    if (session.pageGroupId && /^\d+$/.test(session.pageGroupId)) {
      numericGroupId = session.pageGroupId;
      console.log(`${MODULE} Resolved vanity "${groupId}" → numeric ${numericGroupId}`);
    } else {
      return {
        success: false,
        error: `Could not resolve numeric ID for group "${groupId}" — open the group once or store its numeric ID`,
      };
    }
  }

  // Variable shapes copied verbatim from the captured requests; only groupID changes.
  const aboutVars = { groupID: numericGroupId, scale: 1 };
  const rootVars  = {
    groupID: numericGroupId,
    inviteShortLinkKey: null,
    isChainingRecommendationUnit: false,
    scale: 1,
    "__relay_internal__pv__GroupsCometGroupChatLazyLoadLastMessageSnippetrelayprovider": false,
    "__relay_internal__pv__GroupsCometGYSJUnifiedUnitCardImageHeightrelayprovider": 150,
  };

  console.log(`${MODULE} Scanning group ${numericGroupId} via profile ${profileId}`);
  const [aboutJson, rootJson] = await Promise.all([
    fireQuery({ friendlyName: ABOUT_QUERY, variables: aboutVars, session, userAgent, referer }),
    fireQuery({ friendlyName: ROOT_QUERY,  variables: rootVars,  session, userAgent, referer }),
  ]);

  if (!aboutJson && !rootJson) {
    return { success: false, error: "Both group queries failed (stale doc_id or expired session)" };
  }

  const rootInfo  = rootJson  ? parseRoot(rootJson)   : {};
  const aboutInfo = aboutJson ? parseAbout(aboutJson) : {};
  // Last-resort: mine the group page HTML already fetched during session setup.
  const htmlInfo  = parseHtmlGroupInfo(session.pageBody || "");

  // Merge — root provides identity/branding, about provides stats, HTML is the fallback.
  const info = {
    groupId: numericGroupId,
    name:             rootInfo.name || aboutInfo.name || htmlInfo.name || null,
    url:              rootInfo.url || referer,
    privacyLabel:     rootInfo.privacyLabel || null,
    privacyIcon:      rootInfo.privacyIcon || aboutInfo.privacyIcon || null,
    coverImage:       rootInfo.coverImage || aboutInfo.coverImage || htmlInfo.coverImage || null,
    profilePicture:   rootInfo.profilePicture || aboutInfo.profilePicture || htmlInfo.profilePicture || null,
    themeColor:       rootInfo.themeColor || null,
    viewerJoinState:  rootInfo.viewerJoinState || null,
    hasMembershipQuestions: rootInfo.hasMembershipQuestions ?? null,
    tabs:             rootInfo.tabs || [],
    // Membership
    membersFormatted: rootInfo.membersFormatted || aboutInfo.membersFormatted || null,
    membersTotal:     aboutInfo.membersTotal ?? null,
    membersTotalText: aboutInfo.membersTotalText || null,
    newMembersText:   aboutInfo.newMembersText || null,
    adminCount:       aboutInfo.adminCount ?? null,
    moderatorCount:   aboutInfo.moderatorCount ?? null,
    adminName:        aboutInfo.adminName || null,
    description:      aboutInfo.description || null,
    // Activity
    createdTime:      aboutInfo.createdTime ?? null,
    postsToday:       aboutInfo.postsToday ?? null,
    postsLastMonth:   aboutInfo.postsLastMonth ?? null,
    scannedAt:        new Date().toISOString(),
  };

  console.log(`${MODULE} Scan OK — name="${info.name}" members=${info.membersFormatted} postsToday=${info.postsToday}`);
  return { success: true, info };
}

// Serialize through the shared per-profile session mutex (see facebookProfileLock).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookGroupScanInfo: (args) => _runProfileExclusive(args && args.profileId, () => facebookGroupScanInfo(args)),
  parseAbout,
  parseRoot,
};
