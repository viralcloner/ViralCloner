/**
 * Facebook Group Edit Post Automation
 *
 * Opens a VCBrowser profile (non-headless), navigates to the group page,
 * captures session tokens via CDP Network interception, then executes
 * ComposerStoryEditMutation from inside the page context to edit an
 * existing Facebook group post.
 */

const { startVCBrowser, gracefulCloseVCBrowser } = require("../../lib/VCBrowserManager");
const { getConsistentFingerprintForProfile, getVCBrowserVersion } = require("../../lib/cdpFingerprint");
const { injectCookiesIfLoggedOut } = require("../../lib/facebookCookieStore");
const { dismissFacebookWarningDialog } = require("./fbDialogHelper");

const MODULE = "[FbGroupEditPost]";

// doc_id for ComposerStoryEditMutation
const EDIT_DOC_ID = "36595392723384893";

/**
 * Edit an existing Facebook group post.
 *
 * @param {object} opts
 * @param {string}  opts.storyId      - Base64-encoded Facebook story ID (postId from log)
 * @param {string}  opts.groupUrl     - Full group URL (used as referer)
 * @param {string}  opts.message      - New text message
 * @param {string}  opts.profileId    - VCBrowser profile name / ID
 * @param {object}  opts.profileData  - { proxy, fingerprint, cookies[] }
 * @returns {Promise<{success:boolean, storyId?:string, profileId:string, error?:string}>}
 */
async function facebookGroupEditPost({ storyId, groupUrl, message, profileId, profileData }) {
  const cookies = profileData.cookies || [];
  const proxy   = profileData.proxy && profileData.proxy.ip && profileData.proxy.ip !== "NULL"
                    ? profileData.proxy : null;

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

  let client        = null;
  let chromeProcess = null;

  try {
    console.log(`${MODULE} Launching browser for profile: ${profileId}`);

    const startResult = await startVCBrowser(
      profileId,
      fingerprint,
      "about:blank",
      proxy,
      true,  // headless
      true   // automationMode
    );

    if (!startResult || !startResult.client) {
      return { success: false, error: "Failed to start VCBrowser", profileId };
    }

    client        = startResult.client;
    chromeProcess = startResult.chromeProcess;
    const { Page, Runtime, Network } = client;

    // ── Enable Network and capture session params BEFORE navigation ───────
    await Network.enable();

    const sessionParams = {};
    const SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs", "__hsdp", "__hblp", "__sjsp",
                          "__spin_r", "__spin_b", "__spin_t", "__crn"];

    Network.requestWillBeSent(({ request }) => {
      if (
        request.url &&
        request.url.includes("facebook.com/api/graphql") &&
        request.postData
      ) {
        try {
          const p = new URLSearchParams(request.postData);
          SESSION_KEYS.forEach(k => {
            const v = p.get(k);
            if (v && !sessionParams[k]) sessionParams[k] = v;
          });
        } catch (_) {}
      }
    });

    // ── Inject stored cookies (only if the live profile is logged out) ────
    await injectCookiesIfLoggedOut(Network, cookies, MODULE);

    // ── Navigate to group page ────────────────────────────────────────────
    console.log(`${MODULE} Navigating to ${groupUrl}`);
    await Page.navigate({ url: groupUrl });
    await new Promise(r => setTimeout(r, 8000));
    await dismissFacebookWarningDialog(Runtime);

    const urlEval = await Runtime.evaluate({ expression: "window.location.href", returnByValue: true });
    const currentUrl = urlEval.result?.value || "";
    console.log(`${MODULE} Landed on: ${currentUrl}`);

    if (currentUrl.includes("login") || currentUrl.includes("checkpoint")) {
      return {
        success: false,
        error: "Profile is not logged in to Facebook. Please open the profile and log in first.",
        profileId
      };
    }

    const capturedKeys = Object.keys(sessionParams);
    console.log(`${MODULE} Captured session params: ${capturedKeys.length > 0 ? capturedKeys.join(", ") : "(none)"}`);

    const sessionParamsSafe = JSON.stringify(sessionParams);
    const storyIdSafe       = JSON.stringify(String(storyId));
    const messageSafe       = JSON.stringify(String(message));
    const docIdSafe         = JSON.stringify(EDIT_DOC_ID);
    const groupUrlSafe      = JSON.stringify(String(groupUrl));

    const jsCode = `
(async function() {
  try {
    const capturedParams = ${sessionParamsSafe};

    const dtsg = (() => {
      try { const r = require("DTSGInitialData"); if (r && r.token) return r.token; } catch(_) {}
      try { const el = document.querySelector('input[name="fb_dtsg"]'); if (el && el.value) return el.value; } catch(_) {}
      return null;
    })();

    const lsdToken = (() => {
      try { const r = require("LSD"); if (r && r.token) return r.token; } catch(_) {}
      return capturedParams.__lsd || "";
    })();

    const uid = (() => {
      try { const r = require("CurrentUserInitialData"); if (r && r.USER_ID) return String(r.USER_ID); } catch(_) {}
      const m = document.cookie.match(/(?:^|;\\s*)c_user=([^;]+)/);
      return m ? m[1].trim() : null;
    })();

    if (!dtsg) return JSON.stringify({ error: "Could not extract fb_dtsg — is the profile logged into Facebook?" });
    if (!uid)  return JSON.stringify({ error: "Could not extract user ID — is the profile logged into Facebook?" });

    const jazoest = "2" + Array.from(dtsg).reduce((s, c) => s + c.charCodeAt(0), 0);

    const sessionId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });

    const storyId  = ${storyIdSafe};
    const msgText  = ${messageSafe};
    const groupUrl = ${groupUrlSafe};
    // Match the page's ACTUAL Facebook origin (www vs web.facebook.com) so the
    // request stays same-origin and the session cookies are sent (avoids 1357001).
    const fbOrigin = (typeof location !== "undefined" && location.origin && location.origin.indexOf("facebook.com") !== -1)
      ? location.origin : "https://www.facebook.com";

    const variables = {
      input: {
        composer_entry_point:    "inline_composer",
        composer_source_surface: "group",
        composer_type:           "edit",
        logging: { composer_session_id: sessionId },
        story_id:                storyId,
        with_tags_ids:           [],
        inline_activities:       [],
        text_format_preset_id:   "0",
        group_flair:             { flair_id: null },
        message:                 { ranges: [], text: msgText },
        // 'attachments' intentionally omitted — sending [] would clear the post image
        composed_text: {
          block_data:    ["{}"],
          block_depths:  [0],
          block_types:   [0],
          blocks:        [msgText],
          entities:      ["[]"],
          entity_map:    "{}",
          inline_styles: ["[]"]
        },
        editable_post_feature_capabilities: ["CONTAINED_LINK", "CONTAINED_MEDIA", "POLL"],
        actor_id:           uid,
        client_mutation_id: String(Math.floor(Math.random() * 9) + 1)
      },
      feedLocation:                  "GROUP",
      feedbackSource:                1,
      focusCommentID:                null,
      scale:                         1,
      privacySelectorRenderLocation: "COMET_STREAM",
      referringStoryRenderLocation:  null,
      renderLocation:                "group",
      useDefaultActor:               false,
      isGroupViewerContent:          false,
      isSocialLearning:              false,
      isWorkDraftFor:                false,
      "__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider":                false,
      "__relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider":                  false,
      "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
      "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider":               false,
      "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider":              false,
      "__relay_internal__pv__IsWorkUserrelayprovider":                                            false,
      "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider":                 true,
      "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider":                   false,
      "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider":         true,
      "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider":                          true,
      "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider":              true,
      "__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider":          false,
      "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider":             false,
      "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider":                         false,
      "__relay_internal__pv__IsMergQAPollsrelayprovider":                                         false,
      "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider":          true,
      "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider":                      false,
      "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider":                    "AUTO_TRANSLATE",
      "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider":                          true,
      "__relay_internal__pv__CometUFISingleLineUFIrelayprovider":                                 true,
      "__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider":               true,
      "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider":         true,
      "__relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider":                        false,
      "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider":             true,
      "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider":                         206,
      "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider":                        false,
      "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider":                           true
    };

    const bodyObj = {
      av:                        uid,
      __aaid:                    "0",
      __user:                    uid,
      __a:                       "1",
      __req:                     "1n",
      dpr:                       "1",
      __ccg:                     "EXCELLENT",
      __comet_req:               "15",
      fb_dtsg:                   dtsg,
      jazoest:                   jazoest,
      lsd:                       lsdToken,
      fb_api_caller_class:       "RelayModern",
      fb_api_req_friendly_name:  "ComposerStoryEditMutation",
      server_timestamps:         "true",
      variables:                 JSON.stringify(variables),
      doc_id:                    ${docIdSafe}
    };

    // Inject session params captured from Facebook's own requests
    const SESSION_KEYS = ["__rev", "__s", "__hsi", "__dyn", "__csr", "__hs",
                          "__hsdp", "__hblp", "__sjsp", "__spin_r", "__spin_b", "__spin_t", "__crn"];
    SESSION_KEYS.forEach(k => { if (capturedParams[k]) bodyObj[k] = capturedParams[k]; });

    const body = new URLSearchParams(bodyObj).toString();

    const resp = await fetch(fbOrigin + "/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type":       "application/x-www-form-urlencoded",
        "x-fb-lsd":           lsdToken,
        "x-fb-friendly-name": "ComposerStoryEditMutation",
        "x-asbd-id":          "359341",
        "origin":             fbOrigin,
        "referer":            groupUrl
      },
      body
    });

    const rawText = await resp.text();

    let parsed = null;
    for (const line of rawText.split("\\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { parsed = JSON.parse(trimmed); break; } catch(_) {}
    }

    if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return JSON.stringify({ error: "Facebook API error: " + JSON.stringify(parsed.errors) });
    }

    // Edit mutation returns the updated story
    const updatedStory = parsed?.data?.story_edit_mutation?.story
                      || parsed?.data?.story_edit?.story
                      || null;

    return JSON.stringify({ success: true, storyId: updatedStory?.id || storyId, uid });

  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
})()
`;

    console.log(`${MODULE} Executing edit mutation in browser context...`);
    const evalResult = await Runtime.evaluate({
      expression:    jsCode,
      awaitPromise:  true,
      returnByValue: true
    });

    let editResult;
    try {
      const raw = evalResult.result?.value;
      editResult = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    } catch (_) {
      editResult = { error: "Could not parse browser result: " + String(evalResult.result?.value) };
    }

    console.log(`${MODULE} Result:`, JSON.stringify(editResult));

    // Close gracefully so Chrome flushes any rotated cookies to the on-disk jar.
    await gracefulCloseVCBrowser(client, chromeProcess);
    client = null; chromeProcess = null;

    if (editResult?.error) {
      return { success: false, error: editResult.error, profileId };
    }

    return {
      success:  true,
      storyId:  editResult.storyId || storyId,
      userId:   editResult.uid     || null,
      profileId,
      message
    };

  } catch (err) {
    console.error(`${MODULE} Fatal error:`, err.message);
    return { success: false, error: err.message, profileId };
  } finally {
    await gracefulCloseVCBrowser(client, chromeProcess);
  }
}

// Serialize through the shared per-profile session mutex (see facebookProfileLock).
const { runExclusive: _runProfileExclusive } = require("../../lib/facebookProfileLock");
module.exports = {
  facebookGroupEditPost: (args) => _runProfileExclusive(args && args.profileId, () => facebookGroupEditPost(args)),
};
