// Translate a status string using common.* i18n keys
function translateStatus(status) {
    const key = `common.${status}`;
    const translated = window.I18n?.t(key);
    if (translated && translated !== key) return translated;
    return ucfirst(status);
}

// Language selection prompt for Google/OpenAI profile opening
async function showLanguageSelectionPrompt() {
    return new Promise(async (resolve) => {
        // Get available countries and detected country
        const countries = await window.electronAPI.getAvailableLocaleCountries();
        const detectedCountry = await window.electronAPI.getDetectedCountry();
        const savedCountry = await window.electronAPI.readKey('browserLanguageCountry');
        
        // Build options HTML
        let optionsHtml = '<option value="auto">Auto-detect from your location</option>';
        countries.forEach(country => {
            optionsHtml += `<option value="${country.code}">${country.name}</option>`;
        });
        
        // Determine default selection
        const defaultValue = savedCountry || 'auto';
        
        // Detected country info
        let detectedInfo = '';
        if (detectedCountry) {
            const countryInfo = countries.find(c => c.code === detectedCountry);
            const countryName = countryInfo ? countryInfo.name : detectedCountry;
            detectedInfo = `<p style="margin: 10px 0 0 0; font-size: 12px; color: #666;"><i class="material-icons" style="font-size: 14px; vertical-align: middle;">location_on</i> Detected: <strong>${countryName}</strong></p>`;
        }
        
        const html = `
            <div class="prompt-overlay" id="languagePromptOverlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center;">
                <div class="prompt-box" style="background: white; border-radius: 12px; padding: 25px; max-width: 400px; width: 90%; box-shadow: 0 10px 40px rgba(0,0,0,0.2);">
                    <h3 style="margin: 0 0 15px 0; display: flex; align-items: center; gap: 10px;">
                        <i class="material-icons" style="color: #4285f4;">language</i>
                        Select Browser Language
                    </h3>
                    <p style="margin: 0 0 15px 0; color: #666; font-size: 14px;">Choose the language Chrome will use when opening this profile:</p>
                    <select id="languagePromptSelect" class="form-control" style="width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px;">
                        ${optionsHtml}
                    </select>
                    ${detectedInfo}
                    <div style="display: flex; gap: 10px; margin-top: 20px; justify-content: flex-end;">
                        <button id="languagePromptCancel" class="btn-one" style="background: #6c757d;">
                            <span>Cancel</span>
                        </button>
                        <button id="languagePromptConfirm" class="btn-one success">
                            <i class="material-icons">check</i>
                            <span>Open Browser</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        $('body').append(html);
        $(`#languagePromptSelect`).val(defaultValue);
        
        $('#languagePromptCancel').on('click', function() {
            $('#languagePromptOverlay').remove();
            resolve(null);
        });
        
        $('#languagePromptConfirm').on('click', function() {
            const selectedValue = $('#languagePromptSelect').val();
            $('#languagePromptOverlay').remove();
            resolve(selectedValue);
        });
        
        // Close on overlay click
        $('#languagePromptOverlay').on('click', function(e) {
            if (e.target === this) {
                $('#languagePromptOverlay').remove();
                resolve(null);
            }
        });
    });
}

$(document).ready(function () {

    // Initialize tooltips for menu element badges (scoped to settings page only)
    $("#settings-section [data-tooltip]").each(function () {
        const el = this;
        // Check for i18n translation key first
        const i18nKey = $(this).attr("data-i18n-tooltip");
        let text = $(this).attr("data-tooltip");
        if (i18nKey && window.I18n) {
            const translated = window.I18n.t(i18nKey);
            if (translated) text = translated;
        }
        tippy(el, {
            content: text,
            animation: 'scale',
            theme: 'light',
            placement: 'right'
        });
    });

    // Handle menu clicks within grouped menu structure
    $(".settings-sidebar .menu .menu-element").click(function (e) {
        e.preventDefault();
        $(".settings-sidebar .menu .menu-element").removeClass("active");
        $(this).addClass("active");
        $(".section").hide();
        $(".section#" + $(this).attr("for")).show();
    });

    $("#newAccount").click(async function () {
        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const result = await newPrompt([{ type: "text", name: profileNameField, required: true }]);
        if (result) {
            const profileName = result[profileNameField];
            const profileID = generateRandomString(10);
            const profiles = await window.electronAPI.readKey("googleProfiles") || {};
            profiles[profileID] = {
                name: profileName,
                createdAt: new Date().toISOString(),
                status: "pending"
            };
            await window.electronAPI.updateData("googleProfiles", profiles);
            clearKeyCache("googleProfiles");
            updateGoogleProfiles();
        }
    });

    $("#newDiscord").click(async function () {
        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const result = await newPrompt([{ type: "text", name: profileNameField, required: true }]);
        if (result) {
            const profileName = result[profileNameField];
            const profileID = generateRandomString(10);
            const profiles = await window.electronAPI.readKey("discordProfiles") || {};
            profiles[profileID] = {
                name: profileName,
                createdAt: new Date().toISOString(),
                status: "pending"
            };
            await window.electronAPI.updateData("discordProfiles", profiles);
            clearKeyCache("discordProfiles");
            updateDiscordProfiles();
        }
    });

    $("#newOpenAIProfile").click(async function () {
        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const result = await newPrompt([{ type: "text", name: profileNameField, required: true }]);
        if (result) {
            const profileName = result[profileNameField];
            const profileID = generateRandomString(10);
            const profiles = await window.electronAPI.readKey("openaiProfiles") || {};
            profiles[profileID] = {
                name: profileName,
                createdAt: new Date().toISOString(),
                status: "pending",
                capabilities: ["image", "chat"]
            };
            await window.electronAPI.updateData("openaiProfiles", profiles);
            clearKeyCache("openaiProfiles");
            updateOpenAIProfiles();
        }
    });

    $("#newMetaAIProfile").click(async function () {
        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const result = await newPrompt([{ type: "text", name: profileNameField, required: true }]);
        if (result) {
            const profileName = result[profileNameField];
            const profileID = generateRandomString(10);
            const profiles = await window.electronAPI.readKey("metaaiProfiles") || {};
            profiles[profileID] = {
                name: profileName,
                createdAt: new Date().toISOString(),
                status: "pending"
            };
            await window.electronAPI.updateData("metaaiProfiles", profiles);
            clearKeyCache("metaaiProfiles");
            updateMetaAIProfiles();
        }
    });

    $("#newDeepSeekBrowserProfile").click(async function () {
        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const result = await newPrompt([{ type: "text", name: profileNameField, required: true }]);
        if (result) {
            const profileName = result[profileNameField];
            const profileID = generateRandomString(10);
            const profiles = await window.electronAPI.readKey("deepseekBrowserProfiles") || {};
            profiles[profileID] = {
                name: profileName,
                createdAt: new Date().toISOString(),
                status: "pending"
            };
            await window.electronAPI.updateData("deepseekBrowserProfiles", profiles);
            clearKeyCache("deepseekBrowserProfiles");
            updateDeepSeekBrowserProfiles();
        }
    });

    $("#newQwenBrowserProfile").click(async function () {
        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const result = await newPrompt([{ type: "text", name: profileNameField, required: true }]);
        if (result) {
            const profileName = result[profileNameField];
            const profileID = generateRandomString(10);
            const profiles = await window.electronAPI.readKey("qwenBrowserProfiles") || {};
            profiles[profileID] = {
                name: profileName,
                createdAt: new Date().toISOString(),
                status: "pending"
            };
            await window.electronAPI.updateData("qwenBrowserProfiles", profiles);
            clearKeyCache("qwenBrowserProfiles");
            updateQwenBrowserProfiles();
        }
    });

    $("#newTikTokAdsProfile").click(async function () {
        const profileNameField = window.I18n?.t('common.profile_name') || "Profile name";
        const result = await newPrompt([{ type: "text", name: profileNameField, required: true }]);
        if (result) {
            const profileName = result[profileNameField];
            const profileID = generateRandomString(10);
            const profiles = await window.electronAPI.readKey("tiktokAdsProfiles") || {};
            profiles[profileID] = {
                name: profileName,
                createdAt: new Date().toISOString(),
                status: "pending"
            };
            await window.electronAPI.updateData("tiktokAdsProfiles", profiles);
            clearKeyCache("tiktokAdsProfiles");
            updateTikTokAdsProfiles();
        }
    });

    $("#newOpenAI").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const apiKeyField = window.I18n?.t('common.api_key') || "API Key";
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            { type: "text", name: apiKeyField, required: true }
        ]);
        if (!result) return;
        showLoading("Checking api...");
        const label = result[labelField];
        const apiKey = result[apiKeyField];
        const isValid = await testOpenAIKey(apiKey);
        if (!isValid) {
            showAlert("error", window.I18n?.t('settings.alerts.invalid_openai_key') || "Invalid OpenAI API key. Please check and try again.")
            removeLoading();
            return;
        }
        const keys = await window.electronAPI.readKey("openaiKeys") || {};
        keys[apiKey] = {
            label,
            status: "active"
        };
        await window.electronAPI.updateData("openaiKeys", keys);
        removeLoading();
        clearKeyCache("openaiKeys");
        updateOpenAIKeys();
    });

    // OpenRouter API Key
    $("#newOpenRouter").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const apiKeyField = window.I18n?.t('common.api_key') || "API Key";
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            { type: "text", name: apiKeyField, required: true }
        ]);
        if (!result) return;
        showLoading("Checking OpenRouter API...");
        const label = result[labelField];
        const apiKey = result[apiKeyField];
        const isValid = await testOpenRouterKey(apiKey);
        if (!isValid) {
            showAlert("error", window.I18n?.t('settings.alerts.invalid_openrouter_key') || "Invalid OpenRouter API key. Please check and try again.");
            removeLoading();
            return;
        }
        const keys = await window.electronAPI.readKey("openrouterKeys") || {};
        keys[apiKey] = { label, status: "active" };
        await window.electronAPI.updateData("openrouterKeys", keys);
        removeLoading();
        clearKeyCache("openrouterKeys");
        updateOpenRouterKeys();
    });

    // Google AI API Key
    $("#newGoogleAI").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const apiKeyField = window.I18n?.t('common.api_key') || "API Key";
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            { type: "text", name: apiKeyField, required: true }
        ]);
        if (!result) return;
        showLoading("Checking Google AI API...");
        const label = result[labelField];
        const apiKey = result[apiKeyField];
        const isValid = await testGoogleAIKey(apiKey);
        if (!isValid) {
            showAlert("error", window.I18n?.t('settings.alerts.invalid_googleai_key') || "Invalid Google AI API key. Please check and try again.");
            removeLoading();
            return;
        }
        const keys = await window.electronAPI.readKey("googleaiKeys") || {};
        keys[apiKey] = { label, status: "active" };
        await window.electronAPI.updateData("googleaiKeys", keys);
        removeLoading();
        clearKeyCache("googleaiKeys");
        updateGoogleAIKeys();
    });

    // Anthropic API Key
    $("#newAnthropic").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const apiKeyField = window.I18n?.t('common.api_key') || "API Key";
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            { type: "text", name: apiKeyField, required: true }
        ]);
        if (!result) return;
        showLoading("Checking Anthropic API...");
        const label = result[labelField];
        const apiKey = result[apiKeyField];
        const isValid = await testAnthropicKey(apiKey);
        if (!isValid) {
            showAlert("error", window.I18n?.t('settings.alerts.invalid_anthropic_key') || "Invalid Anthropic API key. Please check and try again.");
            removeLoading();
            return;
        }
        const keys = await window.electronAPI.readKey("anthropicKeys") || {};
        keys[apiKey] = { label, status: "active" };
        await window.electronAPI.updateData("anthropicKeys", keys);
        removeLoading();
        clearKeyCache("anthropicKeys");
        updateAnthropicKeys();
    });

    // Chinese AI API Key
    $("#newChineseAI").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const providerField = window.I18n?.t('settings.chineseai_api.provider') || "Provider";
        const apiKeyField = window.I18n?.t('common.api_key') || "API Key";
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            { 
                type: "select", 
                name: providerField, 
                required: true,
                options: [
                    { value: "deepseek", label: window.I18n?.t('settings.chineseai_api.provider_deepseek') || "DeepSeek" },
                    { value: "qwen", label: window.I18n?.t('settings.chineseai_api.provider_qwen') || "Qwen (Alibaba)" },
                    { value: "zhipu", label: window.I18n?.t('settings.chineseai_api.provider_zhipu') || "Zhipu AI (GLM)" },
                    { value: "moonshot", label: window.I18n?.t('settings.chineseai_api.provider_moonshot') || "Moonshot" }
                ]
            },
            { type: "text", name: apiKeyField, required: true }
        ]);
        if (!result) return;
        showLoading("Checking Chinese AI API...");
        const label = result[labelField];
        const provider = result[providerField];
        const apiKey = result[apiKeyField];
        const isValid = await testChineseAIKey(apiKey, provider);
        if (!isValid) {
            showAlert("error", window.I18n?.t('settings.alerts.invalid_api_key') || "Invalid API key. Please check and try again.");
            removeLoading();
            return;
        }
        const keys = await window.electronAPI.readKey("chineseaiKeys") || {};
        keys[apiKey] = { label, provider, status: "active" };
        await window.electronAPI.updateData("chineseaiKeys", keys);
        removeLoading();
        clearKeyCache("chineseaiKeys");
        updateChineseAIKeys();
    });

    // SerpAPI Key
    $("#newSerpApi").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const apiKeyField = window.I18n?.t('common.api_key') || "API Key";
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            { type: "text", name: apiKeyField, required: true }
        ]);
        if (!result) return;
        showLoading(window.I18n?.t('settings.serpapi.checking') || "Checking SerpAPI key...");
        const label = result[labelField];
        const apiKey = result[apiKeyField];
        try {
            const testResult = await window.electronAPI.testSerpApiKey(apiKey);
            if (!testResult.success) {
                showAlert("error", testResult.error || "Invalid SerpAPI key.");
                removeLoading();
                return;
            }
            const keys = await window.electronAPI.readKey("serpapiKeys") || {};
            keys[apiKey] = {
                label,
                status: "active",
                planName: testResult.planName || "Unknown",
                searchesPerMonth: testResult.searchesPerMonth || 0,
                searchesLeft: testResult.searchesLeft || 0,
                lastChecked: Date.now()
            };
            await window.electronAPI.updateData("serpapiKeys", keys);
            removeLoading();
            clearKeyCache("serpapiKeys");
            updateSerpApiKeys();
            showAlert("success", window.I18n?.t('settings.serpapi.key_added', { plan: testResult.planName, left: testResult.searchesLeft }) || `SerpAPI key added! Plan: ${testResult.planName}, Searches left: ${testResult.searchesLeft}`);
        } catch (error) {
            removeLoading();
            showAlert("error", error.message || "Failed to test SerpAPI key.");
        }
    });

    // Refresh SerpAPI Usage
    $("#refreshSerpApiUsage").click(async function () {
        const btn = $(this);
        btn.prop('disabled', true);
        btn.find('.material-icons').addClass('spin-animation');
        try {
            const result = await window.electronAPI.refreshSerpApiUsage();
            if (result.success) {
                clearKeyCache("serpapiKeys");
                updateSerpApiKeys();
                showAlert("success", window.I18n?.t('settings.serpapi.usage_refreshed') || "SerpAPI usage data refreshed.");
            } else {
                showAlert("error", result.error || "Failed to refresh usage data.");
            }
        } catch (error) {
            showAlert("error", error.message || "Failed to refresh usage data.");
        } finally {
            btn.prop('disabled', false);
            btn.find('.material-icons').removeClass('spin-animation');
        }
    });

    $("#newPexels").click(async function () {
        const apiKeyField = window.I18n?.t('common.api_key') || "API Key";
        const result = await newPrompt([
            { type: "text", name: apiKeyField, required: true }
        ]);
        if (!result) return;
        showLoading("Testing Pexels API...");
        const apiKey = result[apiKeyField];
        
        // Test the API key by making a simple request
        try {
            const testResponse = await fetch('https://api.pexels.com/v1/curated?per_page=1&page=1', {
                headers: { Authorization: apiKey }
            });
            
            if (!testResponse.ok) {
                showAlert("error", window.I18n?.t('settings.alerts.invalid_pexels_key') || "Invalid Pexels API key. Please check and try again.");
                removeLoading();
                return;
            }
            
            // Store the API key
            await window.electronAPI.updateData("pexelsApi", apiKey);
            removeLoading();
            showAlert("success", window.I18n?.t('settings.alerts.pexels_connected') || "Pexels API key connected successfully!");
            updatePexelsStatus();
        } catch (error) {
            showAlert("error", window.I18n?.t('settings.alerts.pexels_verify_failed') || "Failed to verify Pexels API key. Please check your connection.");
            removeLoading();
        }
    });

    $("#newWordpress").click(async function () {
        const siteNameField = window.I18n?.t('common.site_name') || "Site Name";
        const siteUrlField = window.I18n?.t('common.site_url') || "Site URL";
        const usernameField = window.I18n?.t('common.username') || "Username";
        const appPasswordField = window.I18n?.t('common.app_password') || "App Password";
        const result = await newPrompt([
            { type: "text", name: siteNameField, required: true },
            { type: "text", name: siteUrlField, required: true },
            { type: "text", name: usernameField, required: true },
            { type: "password", name: appPasswordField, required: true }
        ]);
        if (!result) return;
        showLoading("Checking WordPress credentials...");
        const siteName = result[siteNameField];
        const siteURL = result[siteUrlField];
        const username = result[usernameField];
        const appPassword = result[appPasswordField];
        const isValid = await testWordpressSite({ url: siteURL, username, appPassword });
        removeLoading();
        if (!isValid) {
            showAlert("error", window.I18n?.t('settings.alerts.invalid_wordpress') || "Invalid WordPress credentials or URL. Please check and try again.");
            return;
        }
        const wordpressSites = await window.electronAPI.readKey("wordpressSites") || {};
        const siteID = generateRandomString(10);
        wordpressSites[siteID] = {
            name: siteName,
            url: siteURL,
            username,
            appPassword,
            createdAt: new Date().toISOString(),
            status: "active"
        };
        await window.electronAPI.updateData("wordpressSites", wordpressSites);
        clearKeyCache("wordpressSites");
        updateWordpressSites();
    });

    // Use class selector for provider dropdown to work with all languages (Provider/Fournisseur/etc)
    $(document).on("change", '.PROVIDER_SELECT select', function () {
        const provider = $(this).val();
        let inputs = [];
        if (provider == "imgbb") {
            $(".APIKEY_AREA").show();
            $(".tempInputs").remove();
            $(".APIKEY_AREA input").attr("required", "");
        } else {
            $(".APIKEY_AREA input").removeAttr("required");
            $(".APIKEY_AREA").hide();
            if (provider == "cloudinary") {
                inputs = ["Cloud name", "Api key", "Api secret", "Upload preset"];
            } else if (provider == "imagekit.io") {
                inputs = ["Public key", "Private key", "Url endpoint"];
            } else if (provider == "freeimage.host") {
                inputs = ["Api key"];
            } else if (provider == "cloudflare-r2") {
                inputs = ["Account ID", "Access key ID", "Secret access key", "Bucket name", {label: "Public base URL", placeholder: "https://pub-xxxx.r2.dev or https://cdn.yourdomain.com"}];
            }
            let HTML = "";
            for (var i = 0; i < inputs.length; i++) {
                const inp = inputs[i];
                const fieldLabel = typeof inp === 'object' ? inp.label : inp;
                const fieldPlaceholder = typeof inp === 'object' && inp.placeholder ? inp.placeholder : '';
                HTML += `<label style="display:block;margin-bottom:10px;">
                        <span>${fieldLabel} (*)</span>
                        <input type="text" name="imageupload" required placeholder="${fieldPlaceholder}" style="width:100%;padding: 10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                    </label>`;
            }
            if ($(".tempInputs").length > 0) {
                $(".tempInputs").html(HTML);
            } else {
                $(this).closest('.PROVIDER_SELECT').after(`<div class='tempInputs mt-2'>${HTML}</div>`);
            }
        }
    });

    $("#newIMGUPLOAD").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const providerField = window.I18n?.t('common.provider') || "Provider";
        const apiKeyFieldName = "Api key"; // Not translated, used as internal key
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            {
                type: "select", name: providerField, required: true, class: "PROVIDER_SELECT", options: [
                    { label: "Imgbb", value: "imgbb" },
                    { label: "Cloudinary", value: "cloudinary" },
                    { label: "Imagekit.io", value: "imagekit.io" },
                    { label: "Freeimage.host", value: "freeimage.host" },
                    { label: "Cloudflare R2", value: "cloudflare-r2" }
                ]
            },
            { type: "text", name: apiKeyFieldName, required: true, class: "APIKEY_AREA" }
        ]);
        if (!result) return;

        // Show loading message while testing API
        showLoading("Testing API credentials...");

        try {
            // Test the API before saving
            const testResult = await window.electronAPI.testImageUploadApi(
                result[providerField],
                result[apiKeyFieldName]
            );

            removeLoading();

            if (!testResult.success) {
                // Show error message if API test failed
                showAlert(window.I18n?.t('settings.alerts.api_test_failed') || "API Test Failed", window.I18n?.t('settings.alerts.api_credentials_invalid', { message: testResult.message }) || `The API credentials could not be verified: ${testResult.message}`);
                return;
            }

            // API test successful, proceed to save
            const imageUploadKeys = await window.electronAPI.readKey("imageUploadKeys") || {};
            imageUploadKeys[result[providerField]] = {
                label: result[labelField],
                apiKey: result[apiKeyFieldName],
                status: "active"
            };
            console.log(imageUploadKeys);
            await window.electronAPI.updateData("imageUploadKeys", imageUploadKeys);
            
            // Update all automation nodes that use this provider
            const newCredentials = `${result[providerField]}|${result[apiKeyFieldName]}`;
            const updateResult = await window.electronAPI.updateAutomationImageUploadNodes(result[providerField], newCredentials);
            
            if (updateResult.success && updateResult.updatedNodes > 0) {
                console.log(`✓ Updated ${updateResult.updatedNodes} node(s) across ${updateResult.updatedAutomations} automation(s)`);
            }
            
            clearKeyCache("imageUploadKeys");
            updateUploadKeys();
            await syncHostDropdowns();
            let successMessage = window.I18n?.t('settings.alerts.api_added_tested', { provider: result[providerField] }) || `${result[providerField]} API has been successfully added and tested!`;
            if (updateResult.success && updateResult.updatedNodes > 0) {
                successMessage += '\n\n✓ ' + (window.I18n?.t('settings.alerts.nodes_updated', { nodes: updateResult.updatedNodes, automations: updateResult.updatedAutomations }) || `Automatically updated ${updateResult.updatedNodes} image upload node(s) in ${updateResult.updatedAutomations} automation(s).`);
            }
            showAlert(window.I18n?.t('common.success') || "Success", successMessage);

        } catch (error) {
            removeLoading();
            console.error("API test error:", error);
            showAlert(window.I18n?.t('settings.alerts.api_test_error') || "API Test Error", window.I18n?.t('settings.alerts.api_test_failed_msg', { message: error.message || window.I18n?.t('common.unknown_error') || "Unknown error" }) || `Failed to test API: ${error.message || "Unknown error"}`);
        }
    });

    // Video Upload provider-specific input fields
    $(document).on("change", '.VIDEO_PROVIDER_SELECT select', function () {
        const provider = $(this).val();
        let inputs = [];
        $(".VIDEO_APIKEY_AREA input").removeAttr("required");
        $(".VIDEO_APIKEY_AREA").hide();
        if (provider == "cloudinary") {
            inputs = ["Cloud name", "Api key", "Api secret", "Upload preset"];
        } else if (provider == "imagekit.io") {
            inputs = ["Public key", "Private key", "Url endpoint"];
        } else if (provider == "streamable") {
            inputs = ["Email", "Password"];
        } else if (provider == "cloudflare-r2") {
            inputs = ["Account ID", "Access key ID", "Secret access key", "Bucket name", {label: "Public base URL", placeholder: "https://pub-xxxx.r2.dev or https://cdn.yourdomain.com"}];
        }
        let HTML = "";
        for (var i = 0; i < inputs.length; i++) {
            const inp = inputs[i];
            const fieldLabel = typeof inp === 'object' ? inp.label : inp;
            const fieldPlaceholder = typeof inp === 'object' && inp.placeholder ? inp.placeholder : '';
            HTML += `<label style="display:block;margin-bottom:10px;">
                    <span>${fieldLabel} (*)</span>
                    <input type="text" name="videoupload" required placeholder="${fieldPlaceholder}" style="width:100%;padding: 10px;border:1px solid #ccc;border-radius:5px;margin-top:5px;" />
                </label>`;
        }
        if ($(".videoTempInputs").length > 0) {
            $(".videoTempInputs").html(HTML);
        } else {
            $(this).closest('.VIDEO_PROVIDER_SELECT').after(`<div class='videoTempInputs mt-2'>${HTML}</div>`);
        }
    });

    $("#newVIDEOUPLOAD").click(async function () {
        const labelField = window.I18n?.t('common.label') || "Label";
        const providerField = window.I18n?.t('common.provider') || "Provider";
        const result = await newPrompt([
            { type: "text", name: labelField, required: true },
            {
                type: "select", name: providerField, required: true, class: "VIDEO_PROVIDER_SELECT", options: [
                    { label: "Cloudinary", value: "cloudinary" },
                    { label: "Imagekit.io", value: "imagekit.io" },
                    { label: "Streamable", value: "streamable" },
                    { label: "Cloudflare R2", value: "cloudflare-r2" }
                ]
            },
            { type: "text", name: "Api key", required: false, class: "VIDEO_APIKEY_AREA", style: "display:none" }
        ]);
        if (!result) return;

        showLoading(window.I18n?.t('settings.alerts.testing_api') || "Testing API credentials...");

        try {
            // Collect multi-field credentials
            let apiKeyValue;
            const videoInputs = document.querySelectorAll('input[name="videoupload"]');
            if (videoInputs.length > 0) {
                const values = Array.from(videoInputs).map(i => i.value.trim());
                if (values.some(v => !v)) {
                    removeLoading();
                    showAlert(window.I18n?.t('common.error') || "Error", window.I18n?.t('settings.alerts.fill_all_fields') || "Please fill all required fields");
                    return;
                }
                apiKeyValue = values.join('|');
            } else {
                apiKeyValue = result["Api key"];
            }

            const testResult = await window.electronAPI.testVideoUploadApi(
                result[providerField],
                apiKeyValue
            );

            removeLoading();

            if (!testResult.success) {
                showAlert(window.I18n?.t('settings.alerts.api_test_failed') || "API Test Failed", window.I18n?.t('settings.alerts.api_credentials_invalid', { message: testResult.message }) || `The API credentials could not be verified: ${testResult.message}`);
                return;
            }

            const videoUploadKeys = await window.electronAPI.readKey("videoUploadKeys") || {};
            videoUploadKeys[result[providerField]] = {
                label: result[labelField],
                apiKey: apiKeyValue,
                status: "active"
            };
            await window.electronAPI.updateData("videoUploadKeys", videoUploadKeys);

            const newCredentials = `${result[providerField]}|${apiKeyValue}`;
            const updateResult = await window.electronAPI.updateAutomationVideoUploadNodes(result[providerField], newCredentials);

            if (updateResult.success && updateResult.updatedNodes > 0) {
                console.log(`✓ Updated ${updateResult.updatedNodes} video upload node(s) across ${updateResult.updatedAutomations} automation(s)`);
            }

            clearKeyCache("videoUploadKeys");
            updateVideoUploadKeys();
            await syncHostDropdowns();

        } catch (error) {
            removeLoading();
            console.error("Video API test error:", error);
            showAlert(window.I18n?.t('settings.alerts.api_test_error') || "API Test Error", window.I18n?.t('settings.alerts.api_test_failed_msg', { message: error.message || window.I18n?.t('common.unknown_error') || "Unknown error" }) || `Failed to test API: ${error.message || "Unknown error"}`);
        }
    });

    // Compatible providers between image and video upload
    const SHARED_UPLOAD_PROVIDERS = ["cloudinary", "imagekit.io", "cloudflare-r2"];

    // Import from Video Upload → Image Upload
    $("#importFromVideoUpload").click(async function () {
        const videoUploadKeys = await window.electronAPI.readKey("videoUploadKeys") || {};
        const imageUploadKeys = await window.electronAPI.readKey("imageUploadKeys") || {};

        // Find compatible providers in video that aren't already in image
        const importable = Object.entries(videoUploadKeys).filter(
            ([provider]) => SHARED_UPLOAD_PROVIDERS.includes(provider) && !imageUploadKeys[provider]
        );

        if (importable.length === 0) {
            const msg = Object.entries(videoUploadKeys).some(([p]) => SHARED_UPLOAD_PROVIDERS.includes(p))
                ? (window.I18n?.t('settings.image_upload.already_imported') || "All compatible providers are already imported.")
                : (window.I18n?.t('settings.image_upload.no_compatible_video') || "No compatible video upload providers found (Cloudinary, ImageKit.io).");
            showAlert(window.I18n?.t('common.info') || "Info", msg);
            return;
        }

        const options = importable.map(([provider, data]) => ({
            label: `${data.label} (${provider})`,
            value: provider
        }));

        const result = await newPrompt([
            {
                type: "select", name: window.I18n?.t('common.provider') || "Provider", required: true, options
            }
        ]);
        if (!result) return;

        const selectedProvider = result[window.I18n?.t('common.provider') || "Provider"];
        const sourceData = videoUploadKeys[selectedProvider];

        imageUploadKeys[selectedProvider] = {
            label: sourceData.label,
            apiKey: sourceData.apiKey,
            status: "active"
        };
        await window.electronAPI.updateData("imageUploadKeys", imageUploadKeys);
        clearKeyCache("imageUploadKeys");
        updateUploadKeys();
        await syncHostDropdowns();

        showAlert(window.I18n?.t('common.success') || "Success",
            window.I18n?.t('settings.image_upload.imported_success', { provider: selectedProvider }) || `${selectedProvider} has been imported from Video Upload.`);
    });

    // Import from Image Upload → Video Upload
    $("#importFromImageUpload").click(async function () {
        const imageUploadKeys = await window.electronAPI.readKey("imageUploadKeys") || {};
        const videoUploadKeys = await window.electronAPI.readKey("videoUploadKeys") || {};

        // Find compatible providers in image that aren't already in video
        const importable = Object.entries(imageUploadKeys).filter(
            ([provider]) => SHARED_UPLOAD_PROVIDERS.includes(provider) && !videoUploadKeys[provider]
        );

        if (importable.length === 0) {
            const msg = Object.entries(imageUploadKeys).some(([p]) => SHARED_UPLOAD_PROVIDERS.includes(p))
                ? (window.I18n?.t('settings.video_upload.already_imported') || "All compatible providers are already imported.")
                : (window.I18n?.t('settings.video_upload.no_compatible_image') || "No compatible image upload providers found (Cloudinary, ImageKit.io).");
            showAlert(window.I18n?.t('common.info') || "Info", msg);
            return;
        }

        const options = importable.map(([provider, data]) => ({
            label: `${data.label} (${provider})`,
            value: provider
        }));

        const result = await newPrompt([
            {
                type: "select", name: window.I18n?.t('common.provider') || "Provider", required: true, options
            }
        ]);
        if (!result) return;

        const selectedProvider = result[window.I18n?.t('common.provider') || "Provider"];
        const sourceData = imageUploadKeys[selectedProvider];

        videoUploadKeys[selectedProvider] = {
            label: sourceData.label,
            apiKey: sourceData.apiKey,
            status: "active"
        };
        await window.electronAPI.updateData("videoUploadKeys", videoUploadKeys);
        clearKeyCache("videoUploadKeys");
        updateVideoUploadKeys();
        await syncHostDropdowns();

        showAlert(window.I18n?.t('common.success') || "Success",
            window.I18n?.t('settings.video_upload.imported_success', { provider: selectedProvider }) || `${selectedProvider} has been imported from Image Upload.`);
    });

    $('#settings-section').on('click', '[data-role="test-media-provider"]', async function () {
        const provider = $(this).attr('data-provider');
        const mediaType = $(this).attr('data-media-type');
        const keyName = mediaType === 'image' ? 'imageUploadKeys' : 'videoUploadKeys';
        const entries = await window.electronAPI.readKey(keyName) || {};
        const entry = entries[provider];
        if (!entry) return;
        showLoading(window.I18n?.t('settings.media_hosting.testing') || 'Testing provider credentials...');
        const result = mediaType === 'image'
            ? await window.electronAPI.testImageUploadApi(provider, entry.apiKey)
            : await window.electronAPI.testVideoUploadApi(provider, entry.apiKey);
        removeLoading();
        showAlert(result.success ? 'success' : 'error', result.message || (result.success ? 'Connection successful.' : 'Connection failed.'));
    });

    $('#settings-section').on('click', '[data-role="edit-media-provider"]', async function () {
        const provider = $(this).attr('data-provider');
        const mediaType = $(this).attr('data-media-type');
        const keyName = mediaType === 'image' ? 'imageUploadKeys' : 'videoUploadKeys';
        const entries = await window.electronAPI.readKey(keyName) || {};
        const entry = entries[provider];
        if (!entry) return;
        const labelName = window.I18n?.t('common.label') || 'Label';

        // Providers with multiple named fields use the same field set as the connect form.
        // The existing apiKey is already a pipe-joined string of those values.
        const multiFields = {
            'cloudinary':     ['Cloud name', 'Api key', 'Api secret', 'Upload preset'],
            'imagekit.io':    ['Public key', 'Private key', 'Url endpoint'],
            'streamable':     ['Email', 'Password'],
            'cloudflare-r2':  ['Account ID', 'Access key ID', 'Secret access key', 'Bucket name',
                               { label: 'Public base URL', placeholder: 'https://pub-xxxx.r2.dev or https://cdn.yourdomain.com' }],
        };

        let result;
        let apiKeyValue;

        if (multiFields[provider]) {
            const fieldDefs = multiFields[provider];
            const existingParts = (entry.apiKey || '').split('|');
            const promptInputs = [
                { type: 'text', name: labelName, required: true, value: entry.label },
                ...fieldDefs.map((f, i) => {
                    const fieldLabel = typeof f === 'object' ? f.label : f;
                    const placeholder = typeof f === 'object' && f.placeholder ? f.placeholder : '';
                    return { type: 'text', name: fieldLabel, required: true,
                             value: existingParts[i] || '', placeholder };
                })
            ];
            result = await newPrompt(promptInputs);
            if (!result) return;
            apiKeyValue = fieldDefs.map(f => {
                const key = typeof f === 'object' ? f.label : f;
                return (result[key] || '').trim();
            }).join('|');
        } else {
            const credentialsName = window.I18n?.t('settings.media_hosting.credentials') || 'Credentials (pipe-separated)';
            result = await newPrompt([
                { type: 'text', name: labelName, required: true, value: entry.label },
                { type: 'password', name: credentialsName, required: true, value: entry.apiKey }
            ]);
            if (!result) return;
            const credKey = window.I18n?.t('settings.media_hosting.credentials') || 'Credentials (pipe-separated)';
            apiKeyValue = result[credKey];
        }

        showLoading(window.I18n?.t('settings.media_hosting.testing') || 'Testing provider credentials...');
        const test = mediaType === 'image'
            ? await window.electronAPI.testImageUploadApi(provider, apiKeyValue)
            : await window.electronAPI.testVideoUploadApi(provider, apiKeyValue);
        removeLoading();
        if (!test.success) { showAlert('error', test.message || 'Connection failed.'); return; }
        entries[provider] = { ...entry, label: result[labelName], apiKey: apiKeyValue, status: 'active' };
        await window.electronAPI.updateData(keyName, entries);
        if (mediaType === 'image') await window.electronAPI.updateAutomationImageUploadNodes(provider, `${provider}|${apiKeyValue}`);
        else await window.electronAPI.updateAutomationVideoUploadNodes(provider, `${provider}|${apiKeyValue}`);
        clearKeyCache(keyName);
        mediaType === 'image' ? updateUploadKeys() : updateVideoUploadKeys();
        await syncHostDropdowns();
        showAlert('success', window.I18n?.t('settings.media_hosting.updated') || 'Provider updated and tested successfully.');
    });

    $('#settings-section').on("click", '[data-role="openProfile"]', async function () {
        const id = $(this).attr("data-id");
        const tableId = $(this).closest("table").attr("id");
        let type, url;
        if (tableId === "googleProfiles") {
            type = "google";
            url = "https://accounts.google.com";
        } else if (tableId === "openaiProfiles") {
            type = "openai";
            url = "https://chatgpt.com";
        } else if (tableId === "metaaiProfiles") {
            type = "metaai";
            url = "https://auth.meta.com/?redirect_uri=https%3A%2F%2Fauth.meta.com%2Foidc%2F%3Fapp_id%3D1522763855472543%26redirect_uri%3Dhttps%253A%252F%252Fauth.meta.ai%252Fecto%26response_type%3Dcode%26scope%3Dopenid%252Blinking%26state%3DeyJjc3JmX3Rva2VuIjoiUmFhR3JoemRJTGRmR3V4di1odjBha0FlTmY1bDRsWXdwYnZDM0luVVVpdyIsInJlZGlyZWN0X3RvIjoiaHR0cHM6Ly9tZXRhLmFpL29pZGMvY2FsbGJhY2sifQ%253D%253D&source_app_id=1522763855472543&force_reauth=0&rcs=ATrrk4pxNiMz-KnSwwEFZ6dBv5HK_g1z5ivtGlYyJ3Em7_Uoneaf2dVPQIIPeCek4MHgEKZeodj4MP274EeS8IM1Qd61apTIWNasL-qRsXn9wrq1MA_CfQvhZLKBN4skgd5veUvoHBPYrkZFa9hTaGcKji2oidf52fjZz7El2mst4vvSuDCmEyxffvE";
        } else if (tableId === "deepseekBrowserProfiles") {
            type = "deepseekbrowser";
            url = "https://chat.deepseek.com/sign_in";
        } else if (tableId === "qwenBrowserProfiles") {
            type = "qwenbrowser";
            url = "https://chat.qwen.ai";
        } else if (tableId === "tiktokAdsProfiles") {
            type = "tiktokads";
            url = "https://ads.tiktok.com/creative/creativestudio/image-to-video?subApp=CreativeStudio/ImageGeneration/I2VImageGeneration";
        } else {
            type = "discord";
            url = "https://discord.com/login";
        }
        
        // Show language selection for Google and OpenAI profiles
        if (type === "google" || type === "openai") {
            const selectedLanguage = await showLanguageSelectionPrompt();
            if (selectedLanguage === null) {
                // User cancelled
                return;
            }
            // Save the selected language preference
            await window.electronAPI.updateData('browserLanguageCountry', selectedLanguage);
        }
        
        window.electronAPI.openStealthProfile(id, url, null, type);
        $(this).addClass("disabled").attr("disabled", "");
    });

    $('#settings-section').on("click", '#deletePexelsApi', async function () {
        const confirmed = await confirmPrompt("Do you really want to remove the Pexels API key?");
        if (!confirmed) return;
        
        await window.electronAPI.updateData("pexelsApi", null);
        showAlert("success", window.I18n?.t('settings.alerts.pexels_removed') || "Pexels API key removed successfully!");
        updatePexelsStatus();
    });

    // Test OpenAI API key (validates key + billing)
    $('#settings-section').on("click", '[data-role="test-openai"]', async function () {
        const apiKey = $(this).attr("data-id");
        showLoading(window.I18n?.t('settings.openai_api.testing') || "Testing OpenAI API...");
        try {
            const result = await window.electronAPI.testOpenAIApi(apiKey);
            removeLoading();
            if (result.success) {
                showAlert("success", window.I18n?.t('settings.openai_api.test_success') || "API key is valid and billing is active!");
            } else if (result.keyValid && !result.billingOk) {
                showAlert("error", (window.I18n?.t('settings.openai_api.test_billing_issue') || "API key is valid but billing has an issue:") + " " + (result.error || ""));
            } else {
                showAlert("error", (window.I18n?.t('settings.openai_api.test_failed') || "API test failed:") + " " + (result.error || ""));
            }
        } catch (err) {
            removeLoading();
            showAlert("error", (window.I18n?.t('settings.openai_api.test_failed') || "API test failed:") + " " + (err.message || "Unknown error"));
        }
    });

    $('#settings-section').on("click", '[data-role="delete"]', async function () {
        const id = $(this).attr("data-id");
        const tableId = $(this).closest("table").attr("id");

        let key, updateFunction, confirmText, deleteProfile = false;

        if (tableId === "googleProfiles") {
            key = "googleProfiles";
            updateFunction = updateGoogleProfiles;
            confirmText = "Do you really want to delete this profile?";
            deleteProfile = true;
        } else if (tableId === "discordProfiles") {
            key = "discordProfiles";
            updateFunction = updateDiscordProfiles;
            confirmText = "Do you really want to delete this profile?";
            deleteProfile = true;
        } else if (tableId === "openaiProfiles") {
            key = "openaiProfiles";
            updateFunction = updateOpenAIProfiles;
            confirmText = "Do you really want to delete this ChatGPT profile?";
            deleteProfile = true;
        } else if (tableId === "openAIApis") {
            key = "openaiKeys";
            updateFunction = updateOpenAIKeys;
            confirmText = "Do you really want to delete this OpenAI key?";
        } else if (tableId === "wordpressWebsites") {
            key = "wordpressSites";
            updateFunction = updateWordpressSites;
            confirmText = "Do you really want to delete this WordPress site?";
        } else if (tableId === "imgUploadKeysApis") {
            key = "imageUploadKeys";
            updateFunction = updateUploadKeys;
            confirmText = window.I18n?.t('settings.media_hosting.delete_confirm') || "Delete this hosting provider? Existing workflows using it will require another provider.";
        } else if (tableId === "videoUploadKeysApis") {
            key = "videoUploadKeys";
            updateFunction = updateVideoUploadKeys;
            confirmText = window.I18n?.t('settings.media_hosting.delete_confirm') || "Delete this hosting provider? Existing workflows using it will require another provider.";
        } else if (tableId === "openRouterApis") {
            key = "openrouterKeys";
            updateFunction = updateOpenRouterKeys;
            confirmText = "Do you really want to delete this OpenRouter key?";
        } else if (tableId === "googleAIApis") {
            key = "googleaiKeys";
            updateFunction = updateGoogleAIKeys;
            confirmText = "Do you really want to delete this Google AI key?";
        } else if (tableId === "anthropicApis") {
            key = "anthropicKeys";
            updateFunction = updateAnthropicKeys;
            confirmText = "Do you really want to delete this Anthropic key?";
        } else if (tableId === "chineseAIApis") {
            key = "chineseaiKeys";
            updateFunction = updateChineseAIKeys;
            confirmText = "Do you really want to delete this Chinese AI key?";
        } else if (tableId === "serpApiKeys") {
            key = "serpapiKeys";
            updateFunction = updateSerpApiKeys;
            confirmText = "Do you really want to delete this SerpAPI key?";
        } else if (tableId === "metaaiProfiles") {
            key = "metaaiProfiles";
            updateFunction = updateMetaAIProfiles;
            confirmText = "Do you really want to delete this Meta AI profile?";
            deleteProfile = true;
        } else if (tableId === "deepseekBrowserProfiles") {
            key = "deepseekBrowserProfiles";
            updateFunction = updateDeepSeekBrowserProfiles;
            confirmText = "Do you really want to delete this DeepSeek profile?";
            deleteProfile = true;
        } else if (tableId === "qwenBrowserProfiles") {
            key = "qwenBrowserProfiles";
            updateFunction = updateQwenBrowserProfiles;
            confirmText = "Do you really want to delete this Qwen AI profile?";
            deleteProfile = true;
        } else if (tableId === "tiktokAdsProfiles") {
            key = "tiktokAdsProfiles";
            updateFunction = updateTikTokAdsProfiles;
            confirmText = "Do you really want to delete this TikTok Ads profile?";
            deleteProfile = true;
        } else {
            return;
        }

        const confirmed = await confirmPrompt(confirmText);
        if (!confirmed) return;

        const entries = await window.electronAPI.readKey(key) || {};
        delete entries[id];
        await window.electronAPI.updateData(key, entries);

        if (deleteProfile) {
            window.electronAPI.deleteProfile(id);
        }
        clearKeyCache(key); // Clear cache to force fresh data
        updateFunction();
        if (key === "imageUploadKeys" || key === "videoUploadKeys") {
            await syncHostDropdowns();
        }
    });

    $('#settings-section').on("click", '[data-role="testProfile"]', async function () {
        const id = $(this).attr("data-id");
        const type = $(this).attr("data-type");
        showLoading("Testing profile...");
        let result;
        if (type === 'deepseekbrowser') {
            result = await window.electronAPI.testDeepSeekBrowserProfile(id);
        } else if (type === 'qwenbrowser') {
            result = await window.electronAPI.testQwenBrowserProfile(id);
        } else if (type === 'tiktokads') {
            result = await window.electronAPI.testTikTokAdsProfile(id);
        }
        removeLoading();
        if (result && result.success) {
            if (type === 'tiktokads') {
                const count = Array.isArray(result.value) ? result.value.length : 1;
                showAlert("success", "TikTok Ads generated " + count + " test image(s) successfully.");
            } else {
                showAlert("success", (type === 'qwenbrowser' ? 'Qwen' : 'DeepSeek') + " says: " + result.value);
            }
        } else {
            showAlert("error", "Test failed: " + (result?.value || result?.error || "Unknown error"));
        }
    });

    // Test Qwen captcha solver (opens a visible browser and auto-drags the slider)
    $('#settings-section').on("click", '[data-role="testCaptcha"]', async function () {
        const id = $(this).attr("data-id");
        let unsubscribe = null;
        if (window.electronAPI.onQwenCaptchaLog) {
            unsubscribe = window.electronAPI.onQwenCaptchaLog((line) => console.log("[QwenCaptcha]", line));
        }
        showLoading("Opening browser — send a message in it to trigger the captcha...");
        let result;
        try {
            result = await window.electronAPI.testQwenBrowserCaptcha(id, {});
        } catch (e) {
            result = { success: false, error: e?.message };
        }
        if (typeof unsubscribe === 'function') unsubscribe();
        removeLoading();
        if (result && result.success) {
            showAlert("success", "Captcha solved successfully.");
        } else if (result && result.challengeSeen) {
            showAlert("error", "Captcha appeared but was not solved. See console for details.");
        } else {
            showAlert("error", result?.error || "No captcha appeared during the watch window.");
        }
    });

    // Duplicate ChatGPT profile for concurrent usage
    $('#settings-section').on("click", '[data-role="duplicateProfile"]', async function () {
        const id = $(this).attr("data-id");
        const originalName = $(this).attr("data-name");
        
        // Prompt for new profile name
        const newProfileNameField = window.I18n?.t('common.new_profile_name') || "New profile name";
        const result = await newPrompt([{ 
            type: "text", 
            name: newProfileNameField, 
            required: true,
            value: originalName + " (copy)"
        }]);
        
        if (!result) return;
        
        const newName = result[newProfileNameField];
        
        showLoading("Duplicating profile...");
        
        try {
            // Duplicate the browser profile folder (IPC handler pre-registers the profile)
            const duplicateResult = await window.electronAPI.duplicateProfile(id, 'openai', newName);
            
            if (!duplicateResult.success) {
                removeLoading();
                showAlert("error", window.I18n?.t('settings.alerts.profile_duplicate_failed', { error: duplicateResult.error }) || "Failed to duplicate profile: " + duplicateResult.error);
                return;
            }
            
            // Get updated profile count for success message
            const profiles = await window.electronAPI.readKey("openaiProfiles") || {};
            
            removeLoading();
            showAlert("success", window.I18n?.t('settings.alerts.profile_duplicated', { count: Object.keys(profiles).length }) || `Profile duplicated successfully! You now have ${Object.keys(profiles).length} ChatGPT profiles for concurrent image generation.`);
            clearKeyCache("openaiProfiles");
            updateOpenAIProfiles();
        } catch (error) {
            removeLoading();
            showAlert("error", window.I18n?.t('settings.alerts.profile_duplicate_failed', { error: error.message }) || "Failed to duplicate profile: " + error.message);
            console.error("Error duplicating profile:", error);
        }
    });

    // Initial data load
    updateAllData();
    $(".menu-element[for='imgbb-connect']").off("click.mediaHosting").on("click.mediaHosting", loadMediaHostingDashboard);
    $("#defaultImageHost, #defaultVideoHost").off("change.mediaHosting").on("change.mediaHosting", handleMediaDefaultChange);
    
    // Handle page visibility changes
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') {
            // Force refresh when page becomes visible
            cachedData = null;
            updateAllData();
        }
    });
});

var prevGoogleProfilesString = "";
var prevDiscordProfilesString = "";
var prevOpenAIProfilesString = "";
var prevOpenAIKeysString = "";
var prevWordpressSitesString = "";
var prevUploadKeysString = "";
var prevVideoUploadKeysString = "";
var prevOpenRouterKeysString = "";
var prevGoogleAIKeysString = "";
var prevAnthropicKeysString = "";
var prevChineseAIKeysString = "";
var prevSerpApiKeysString = "";
var prevMetaAIProfilesString = "";
var prevDeepSeekBrowserProfilesString = "";
var prevQwenBrowserProfilesString = "";
var prevTikTokAdsProfilesString = "";
var keyCache = {};
var updateInterval = null;

// Cache individual keys for 5 seconds to reduce API calls
async function getCachedKey(key) {
    const now = Date.now();
    if (!keyCache[key] || (now - keyCache[key].lastFetch) > 5000) {
        keyCache[key] = {
            data: await window.electronAPI.readKey(key),
            lastFetch: now
        };
    }
    return keyCache[key].data;
}

// Clear cache for specific key(s) to force fresh data on next read
function clearKeyCache(key) {
    if (key) {
        delete keyCache[key];
    } else {
        keyCache = {};
    }
}

// Start updates only when settings page is visible
function startDataUpdates() {
    if (updateInterval) return;
    updateInterval = setInterval(() => {
        if (document.visibilityState === 'visible') {
            updateAllData();
        }
    }, 5000);
}

// Stop updates when not needed
function stopDataUpdates() {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
}

function cleanupSettingsPage() {
    stopDataUpdates();
    if (window.currentPageCleanup === cleanupSettingsPage) {
        window.currentPageCleanup = null;
    }
}

async function updateAllData() {
    if (!document.getElementById('settings-section')) return;

    cachedData = null; // Force fresh data fetch

    // Fetch only the specific keys we need
    const [googleProfiles, discordProfiles, openaiProfiles, openaiKeys, wordpressSites, imageUploadKeys, videoUploadKeys, openrouterKeys, googleaiKeys, anthropicKeys, chineseaiKeys, serpapiKeys, metaaiProfiles, deepseekBrowserProfiles, qwenBrowserProfiles, tiktokAdsProfiles] = await Promise.all([
        getCachedKey('googleProfiles'),
        getCachedKey('discordProfiles'),
        getCachedKey('openaiProfiles'),
        getCachedKey('openaiKeys'),
        getCachedKey('wordpressSites'),
        getCachedKey('imageUploadKeys'),
        getCachedKey('videoUploadKeys'),
        getCachedKey('openrouterKeys'),
        getCachedKey('googleaiKeys'),
        getCachedKey('anthropicKeys'),
        getCachedKey('chineseaiKeys'),
        getCachedKey('serpapiKeys'),
        getCachedKey('metaaiProfiles'),
        getCachedKey('deepseekBrowserProfiles'),
        getCachedKey('qwenBrowserProfiles'),
        getCachedKey('tiktokAdsProfiles')
    ]);

    if (!document.getElementById('settings-section')) return;

    const data = {
        googleProfiles,
        discordProfiles,
        openaiProfiles,
        openaiKeys,
        wordpressSites,
        imageUploadKeys,
        videoUploadKeys,
        openrouterKeys,
        googleaiKeys,
        anthropicKeys,
        chineseaiKeys,
        serpapiKeys,
        metaaiProfiles,
        deepseekBrowserProfiles,
        qwenBrowserProfiles,
        tiktokAdsProfiles
    };

    updateGoogleProfilesFromData(data);
    updateDiscordProfilesFromData(data);
    updateOpenAIProfilesFromData(data);
    updateOpenAIKeysFromData(data);
    updateWordpressSitesFromData(data);
    updateUploadKeysFromData(data);
    updateVideoUploadKeysFromData(data);
    updatePexelsStatus();
    updateOpenRouterKeysFromData(data);
    updateGoogleAIKeysFromData(data);
    updateAnthropicKeysFromData(data);
    updateChineseAIKeysFromData(data);
    updateSerpApiKeysFromData(data);
    updateMetaAIProfilesFromData(data);
    updateDeepSeekBrowserProfilesFromData(data);
    updateQwenBrowserProfilesFromData(data);
    updateTikTokAdsProfilesFromData(data);
}

// Settings scripts can be evaluated more than once by the dynamic page loader.
// Use var so reloading Settings reuses this state instead of throwing on redeclaration.
var mediaHostingPreferences = null;

// Keep the default-host <select> dropdowns in sync whenever a provider is added, edited or removed.
async function syncHostDropdowns() {
    const [imageKeys, videoKeys, savedPreferences] = await Promise.all([
        window.electronAPI.readKey('imageUploadKeys'),
        window.electronAPI.readKey('videoUploadKeys'),
        window.electronAPI.readKey('mediaHostingPreferences')
    ]);
    const imageProviders = Object.keys(imageKeys || {});
    const videoProviders = Object.keys(videoKeys || {});
    const persistedPreferences = savedPreferences && typeof savedPreferences === 'object'
        ? savedPreferences
        : {};
    mediaHostingPreferences = mediaHostingPreferences && typeof mediaHostingPreferences === 'object'
        ? mediaHostingPreferences
        : { ...persistedPreferences };

    function rebuild($sel, providers) {
        const current = $sel.val();
        $sel.empty();
        providers.forEach(p => {
            $sel.append(`<option value="${p}">${mediaProviderLabel(p)}</option>`);
        });
        if (current && $sel.find(`option[value="${current}"]`).length) {
            $sel.val(current);
        } else {
            const first = providers[0] || '';
            $sel.val(first);
            if (mediaHostingPreferences) {
                const key = $sel.attr('id') === 'defaultImageHost' ? 'imageProvider' : 'videoProvider';
                mediaHostingPreferences[key] = first;
            }
        }
    }

    rebuild($("#defaultImageHost"), imageProviders);
    rebuild($("#defaultVideoHost"), videoProviders);

    // A select automatically displays its first option, but that does not emit a
    // change event. Persist the effective defaults so the main-process runner sees
    // the same providers that the Settings screen shows.
    if (JSON.stringify(mediaHostingPreferences) !== JSON.stringify(persistedPreferences)) {
        await window.electronAPI.updateData('mediaHostingPreferences', mediaHostingPreferences);
        clearKeyCache('mediaHostingPreferences');
    }
}

function mediaProviderLabel(provider) {
    const labels = { imgbb: 'ImgBB', cloudinary: 'Cloudinary', 'imagekit.io': 'ImageKit.io', 'freeimage.host': 'FreeImage.host', streamable: 'Streamable', 'cloudflare-r2': 'Cloudflare R2' };
    return labels[provider] || provider;
}

async function loadMediaHostingDashboard() {
    const dashboard = $("#mediaHostingDashboard");
    try {
        const [imageKeys, videoKeys, savedPreferences] = await Promise.all([
            window.electronAPI.readKey('imageUploadKeys'),
            window.electronAPI.readKey('videoUploadKeys'),
            window.electronAPI.readKey('mediaHostingPreferences')
        ]);
        const imageProviders = Object.keys(imageKeys || {});
        const videoProviders = Object.keys(videoKeys || {});
        const persistedPreferences = savedPreferences && typeof savedPreferences === 'object'
            ? savedPreferences
            : {};
        mediaHostingPreferences = { ...persistedPreferences };
        const buildOptions = (providers) => providers.map(provider => `<option value="${provider}">${mediaProviderLabel(provider)}</option>`).join('');
        $("#defaultImageHost").html(buildOptions(imageProviders));
        $("#defaultVideoHost").html(buildOptions(videoProviders));
        if (!$("#defaultImageHost option[value='" + mediaHostingPreferences.imageProvider + "']").length) mediaHostingPreferences.imageProvider = imageProviders[0] || '';
        if (!$("#defaultVideoHost option[value='" + mediaHostingPreferences.videoProvider + "']").length) mediaHostingPreferences.videoProvider = videoProviders[0] || '';
        $("#defaultImageHost").val(mediaHostingPreferences.imageProvider);
        $("#defaultVideoHost").val(mediaHostingPreferences.videoProvider);
        if (JSON.stringify(mediaHostingPreferences) !== JSON.stringify(persistedPreferences)) {
            await window.electronAPI.updateData('mediaHostingPreferences', mediaHostingPreferences);
            clearKeyCache('mediaHostingPreferences');
        }
        dashboard.show();
    } catch (error) {
        console.error('[MediaHosting] Failed to load providers:', error);
    }
}

async function handleMediaDefaultChange(event) {
    if (!mediaHostingPreferences) return;
    const isImage = event.target.id === 'defaultImageHost';
    const key = isImage ? 'imageProvider' : 'videoProvider';
    const selected = $(event.target).val();
    mediaHostingPreferences[key] = selected;
    await window.electronAPI.updateData('mediaHostingPreferences', mediaHostingPreferences);
    clearKeyCache('mediaHostingPreferences');
    showAlert('success', window.I18n?.t('settings.media_hosting.default_saved') || 'Default hosting provider saved. All upload nodes will use this provider.');
}

// Expose refresh function globally for external triggers (e.g., when stealth browser closes)
window.refreshSettingsData = function() {
    clearKeyCache(); // Clear all cache
    updateAllData(); // Refresh all data
};

// Start updates when page loads
window.currentPageCleanup = cleanupSettingsPage;
startDataUpdates();

async function testOpenAIKey(apiKey) {
    try {
        const response = await fetch("https://api.openai.com/v1/models", {
            headers: { "Authorization": `Bearer ${apiKey}` }
        });
        if (!response.ok) return false;
        const json = await response.json();
        return !!json.data;
    } catch (e) {
        return false;
    }
}

async function testOpenRouterKey(apiKey) {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { "Authorization": `Bearer ${apiKey}` }
        });
        if (!response.ok) return false;
        const json = await response.json();
        return !!json.data;
    } catch (e) {
        return false;
    }
}

async function testGoogleAIKey(apiKey) {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!response.ok) return false;
        const json = await response.json();
        return !!json.models;
    } catch (e) {
        return false;
    }
}

async function testAnthropicKey(apiKey) {
    try {
        // Anthropic doesn't have a simple models endpoint, so we test with a minimal request
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "claude-3-haiku-20240307",
                max_tokens: 1,
                messages: [{ role: "user", content: "hi" }]
            })
        });
        // A 200 or 400 (bad request for minimal tokens) means the key is valid
        // 401 means invalid key
        return response.status !== 401;
    } catch (e) {
        return false;
    }
}

async function testChineseAIKey(apiKey, provider) {
    try {
        const endpoints = {
            deepseek: "https://api.deepseek.com/v1/models",
            qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
            zhipu: "https://open.bigmodel.cn/api/paas/v4/models",
            moonshot: "https://api.moonshot.cn/v1/models"
        };
        const endpoint = endpoints[provider];
        if (!endpoint) return false;
        
        const response = await fetch(endpoint, {
            headers: { "Authorization": `Bearer ${apiKey}` }
        });
        if (!response.ok) return false;
        const json = await response.json();
        return !!json.data || !!json.models;
    } catch (e) {
        return false;
    }
}

async function checkImgBB(apiKey) {
    const url = "https://api.imgbb.com/1/upload";

    const dummyImage =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const formData = new FormData();
    formData.append("image", dummyImage);
    formData.append("key", apiKey);
    formData.append("name", "imgbb-api-check");

    try {
        const uploadRes = await fetch(url, {
            method: "POST",
            body: formData
        });
        const uploadData = await uploadRes.json();
        if (uploadRes.ok && uploadData.success) {
            const deleteUrl = uploadData.data.delete_url;
            await fetch(deleteUrl);
            return true;
        } else {
            return false;
        }
    } catch {
        return false;
    }
}

async function testWordpressSite({ url, username, appPassword }) {
    try {
        const endpoint = url.endsWith('/') ? url + 'wp-json/wp/v2/users/me' : url + '/wp-json/wp/v2/users/me';
        const response = await fetch(endpoint, {
            headers: {
                'Authorization': 'Basic ' + btoa(`${username}:${appPassword}`),
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) return false;
        const json = await response.json();
        return json.id !== undefined;
    } catch {
        return false;
    }
}

function updateUploadKeys() {
    (async function () {
        const data = await window.electronAPI.readKey("imageUploadKeys");
        updateUploadKeysFromData({ imageUploadKeys: data });
    })();
}

function updateUploadKeysFromData(data) {
    const uploadKeys = data.imageUploadKeys || {};
    const currentString = JSON.stringify(uploadKeys);
    if (prevUploadKeysString !== currentString) {
        const tbody = $("#imgUploadKeysApis tbody");
        tbody.empty();
        prevUploadKeysString = currentString;
        
        if (Object.keys(uploadKeys).length === 0) {
            $("#imgUploadKeysApis").hide();
        } else {
            $("#imgUploadKeysApis").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(uploadKeys).forEach(([provider, vl]) => {
                const credential = String(vl.apiKey || '');
                const masked = credential.length > 12 ? `${credential.slice(0, 6)}...${credential.slice(-4)}` : '••••••••';
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHtml(vl.label)}</td>
                    <td>${escapeHtml(mediaProviderLabel(provider))}</td>
                    <td>${escapeHtml(masked)}</td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="test-media-provider" data-provider="${escapeHtml(provider)}" data-media-type="image" class="action-dropdown-item"><i class="material-icons">verified</i><span>Retest</span></button>
                                <button data-role="edit-media-provider" data-provider="${escapeHtml(provider)}" data-media-type="image" class="action-dropdown-item"><i class="material-icons">edit</i><span>Edit</span></button>
                                <button data-role="delete" data-id="${provider}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

function updateVideoUploadKeys() {
    (async function () {
        const data = await window.electronAPI.readKey("videoUploadKeys");
        updateVideoUploadKeysFromData({ videoUploadKeys: data });
    })();
}

function updateVideoUploadKeysFromData(data) {
    const uploadKeys = data.videoUploadKeys || {};
    const currentString = JSON.stringify(uploadKeys);
    if (prevVideoUploadKeysString !== currentString) {
        const tbody = $("#videoUploadKeysApis tbody");
        tbody.empty();
        prevVideoUploadKeysString = currentString;
        
        if (Object.keys(uploadKeys).length === 0) {
            $("#videoUploadKeysApis").hide();
        } else {
            $("#videoUploadKeysApis").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(uploadKeys).forEach(([provider, vl]) => {
                const credential = String(vl.apiKey || '');
                const masked = credential.length > 12 ? `${credential.slice(0, 6)}...${credential.slice(-4)}` : '••••••••';
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHtml(vl.label)}</td>
                    <td>${escapeHtml(mediaProviderLabel(provider))}</td>
                    <td>${escapeHtml(masked)}</td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="test-media-provider" data-provider="${escapeHtml(provider)}" data-media-type="video" class="action-dropdown-item"><i class="material-icons">verified</i><span>Retest</span></button>
                                <button data-role="edit-media-provider" data-provider="${escapeHtml(provider)}" data-media-type="video" class="action-dropdown-item"><i class="material-icons">edit</i><span>Edit</span></button>
                                <button data-role="delete" data-id="${provider}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

function updateWordpressSites() {
    (async function () {
        const wordpressSites = await getCachedKey('wordpressSites');
        const data = { wordpressSites };
        updateWordpressSitesFromData(data);
    })();
}

function updateWordpressSitesFromData(data) {
    const sites = data.wordpressSites || {};
    const currentString = JSON.stringify(sites);
    if (prevWordpressSitesString !== currentString) {
        const tbody = $("#wordpressWebsites tbody");
        tbody.empty();
        prevWordpressSitesString = currentString;
        
        if (Object.keys(sites).length === 0) {
            $("#wordpressWebsites").hide();
        } else {
            $("#wordpressWebsites").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(sites).forEach(([siteID, site]) => {
                const row = document.createElement('tr');
                row.innerHTML = wordpressRow(siteID, site);
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

function wordpressRow(siteID, site) {
    return `<tr>
        <td>${site.name}</td>
        <td>${site.url}</td>
        <td>${site.username}</td>
        <td>
            <span class="status ${site.status === "pending" ? "danger" : "success"}"></span>
            ${translateStatus(site.status)}
        </td>
        <td>
            <div class="action-dropdown dropup">
                <button class="action-dropdown-toggle" title="Actions">
                    <i class="material-icons">more_vert</i>
                </button>
                <div class="action-dropdown-menu">
                    <button data-role="delete" data-id="${siteID}" class="action-dropdown-item item-danger">
                        <i class="material-icons">delete</i>
                        <span>Delete</span>
                    </button>
                </div>
            </div>
        </td>
    </tr>`;
}

function updateOpenAIKeys() {
    (async function () {
        const openaiKeys = await getCachedKey('openaiKeys');
        const data = { openaiKeys };
        updateOpenAIKeysFromData(data);
    })();
}

function updateOpenAIKeysFromData(data) {
    const keys = data.openaiKeys || {};
    const currentString = JSON.stringify(keys);
    if (prevOpenAIKeysString !== currentString) {
        const tbody = $("#openAIApis tbody");
        tbody.empty();
        prevOpenAIKeysString = currentString;
        
        if (Object.keys(keys).length === 0) {
            $("#openAIApis").hide();
        } else {
            $("#openAIApis").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(keys).forEach(([apiKey, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${vl.label}</td>
                    <td>${apiKey.slice(0, 10)}...${apiKey.slice(-10)}</td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="test-openai" data-id="${apiKey}" class="action-dropdown-item">
                                    <i class="material-icons">verified</i>
                                    <span>${window.I18n?.t('settings.openai_api.test_btn') || 'Test API'}</span>
                                </button>
                                <button data-role="delete" data-id="${apiKey}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

function updatePexelsStatus() {
    (async function () {
        const pexelsApi = await window.electronAPI.readKey('pexelsApi');
        const statusDiv = $("#pexelsStatus");
        
        if (!pexelsApi) {
            statusDiv.html('<p style="color: #999; font-style: italic;">No Pexels API key connected.</p>');
        } else {
            statusDiv.html(`
                <div style="padding: 15px; background: #e8f5e9; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <p style="margin: 0; font-weight: 500; color: #2e7d32;">
                            <span class="material-icons" style="vertical-align: middle; font-size: 20px; margin-right: 5px;">check_circle</span>
                            Pexels API ${translateStatus('connected')}
                        </p>
                        <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #555;">
                            API Key: ${pexelsApi.slice(0, 15)}...${pexelsApi.slice(-10)}
                        </p>
                    </div>
                    <button id="deletePexelsApi" class="btn-one danger">
                        <div class="material-icons">delete</div>
                        <span>Remove</span>
                    </button>
                </div>
            `);
        }
    })();
}

// ============================================
// OpenRouter API Keys
// ============================================

function updateOpenRouterKeys() {
    (async function () {
        const openrouterKeys = await getCachedKey('openrouterKeys');
        const data = { openrouterKeys };
        updateOpenRouterKeysFromData(data);
    })();
}

function updateOpenRouterKeysFromData(data) {
    const keys = data.openrouterKeys || {};
    const currentString = JSON.stringify(keys);
    if (prevOpenRouterKeysString !== currentString) {
        const tbody = $("#openRouterApis tbody");
        tbody.empty();
        prevOpenRouterKeysString = currentString;
        
        if (Object.keys(keys).length === 0) {
            $("#openRouterApis").hide();
        } else {
            $("#openRouterApis").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(keys).forEach(([apiKey, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${vl.label}</td>
                    <td>${apiKey.slice(0, 10)}...${apiKey.slice(-10)}</td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="delete" data-id="${apiKey}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

// ============================================
// Google AI API Keys
// ============================================

function updateGoogleAIKeys() {
    (async function () {
        const googleaiKeys = await getCachedKey('googleaiKeys');
        const data = { googleaiKeys };
        updateGoogleAIKeysFromData(data);
    })();
}

function updateGoogleAIKeysFromData(data) {
    const keys = data.googleaiKeys || {};
    const currentString = JSON.stringify(keys);
    if (prevGoogleAIKeysString !== currentString) {
        const tbody = $("#googleAIApis tbody");
        tbody.empty();
        prevGoogleAIKeysString = currentString;
        
        if (Object.keys(keys).length === 0) {
            $("#googleAIApis").hide();
        } else {
            $("#googleAIApis").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(keys).forEach(([apiKey, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${vl.label}</td>
                    <td>${apiKey.slice(0, 10)}...${apiKey.slice(-10)}</td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="delete" data-id="${apiKey}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

// ============================================
// Anthropic API Keys
// ============================================

function updateAnthropicKeys() {
    (async function () {
        const anthropicKeys = await getCachedKey('anthropicKeys');
        const data = { anthropicKeys };
        updateAnthropicKeysFromData(data);
    })();
}

function updateAnthropicKeysFromData(data) {
    const keys = data.anthropicKeys || {};
    const currentString = JSON.stringify(keys);
    if (prevAnthropicKeysString !== currentString) {
        const tbody = $("#anthropicApis tbody");
        tbody.empty();
        prevAnthropicKeysString = currentString;
        
        if (Object.keys(keys).length === 0) {
            $("#anthropicApis").hide();
        } else {
            $("#anthropicApis").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(keys).forEach(([apiKey, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${vl.label}</td>
                    <td>${apiKey.slice(0, 10)}...${apiKey.slice(-10)}</td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="delete" data-id="${apiKey}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

// ============================================
// Chinese AI API Keys
// ============================================

function updateChineseAIKeys() {
    (async function () {
        const chineseaiKeys = await getCachedKey('chineseaiKeys');
        const data = { chineseaiKeys };
        updateChineseAIKeysFromData(data);
    })();
}

function updateChineseAIKeysFromData(data) {
    const keys = data.chineseaiKeys || {};
    const currentString = JSON.stringify(keys);
    if (prevChineseAIKeysString !== currentString) {
        const tbody = $("#chineseAIApis tbody");
        tbody.empty();
        prevChineseAIKeysString = currentString;
        
        if (Object.keys(keys).length === 0) {
            $("#chineseAIApis").hide();
        } else {
            $("#chineseAIApis").show();
            const fragment = document.createDocumentFragment();
            
            const providerLabels = {
                deepseek: "DeepSeek",
                qwen: "Qwen",
                zhipu: "Zhipu GLM",
                moonshot: "Moonshot"
            };
            
            Object.entries(keys).forEach(([apiKey, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${vl.label}</td>
                    <td>${providerLabels[vl.provider] || vl.provider}</td>
                    <td>${apiKey.slice(0, 10)}...${apiKey.slice(-10)}</td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="delete" data-id="${apiKey}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

// ============================================
// SerpAPI Keys
// ============================================

function updateSerpApiKeys() {
    (async function () {
        const serpapiKeys = await getCachedKey('serpapiKeys');
        const data = { serpapiKeys };
        updateSerpApiKeysFromData(data);
    })();
}

function updateSerpApiKeysFromData(data) {
    const keys = data.serpapiKeys || {};
    const currentString = JSON.stringify(keys);
    if (prevSerpApiKeysString !== currentString) {
        const tbody = $("#serpApiKeys tbody");
        tbody.empty();
        prevSerpApiKeysString = currentString;
        
        if (Object.keys(keys).length === 0) {
            $("#serpApiKeys").hide();
        } else {
            $("#serpApiKeys").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(keys).forEach(([apiKey, vl]) => {
                const row = document.createElement('tr');
                const searchesLeft = vl.searchesLeft ?? 0;
                const searchesPerMonth = vl.searchesPerMonth ?? 0;
                const pct = searchesPerMonth > 0 ? Math.round((searchesLeft / searchesPerMonth) * 100) : 0;
                const barColor = pct > 50 ? '#28a745' : pct > 20 ? '#ffc107' : '#dc3545';
                const planName = vl.planName || 'Unknown';
                
                row.innerHTML = `
                    <td>${vl.label}</td>
                    <td>${apiKey.slice(0, 10)}...${apiKey.slice(-6)}</td>
                    <td>${planName}</td>
                    <td>
                        <div style="min-width: 120px;">
                            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
                                <span>${searchesLeft.toLocaleString()}</span>
                                <span style="color:var(--text-secondary)">/ ${searchesPerMonth.toLocaleString()}</span>
                            </div>
                            <div style="height:6px;background:var(--border-color);border-radius:3px;overflow:hidden;">
                                <div style="width:${pct}%;height:100%;background:${barColor};border-radius:3px;transition:width 0.3s;"></div>
                            </div>
                        </div>
                    </td>
                    <td>
                        <span class="status ${vl.status === "active" ? "success" : "danger"}"></span>
                        ${translateStatus(vl.status)}
                    </td>
                    <td>
                        <div class="action-dropdown dropup">
                            <button class="action-dropdown-toggle" title="Actions">
                                <i class="material-icons">more_vert</i>
                            </button>
                            <div class="action-dropdown-menu">
                                <button data-role="delete" data-id="${apiKey}" class="action-dropdown-item item-danger">
                                    <i class="material-icons">delete</i>
                                    <span>Delete</span>
                                </button>
                            </div>
                        </div>
                    </td>
                `;
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

function updateGoogleProfiles() {
    (async function () {
        const googleProfiles = await getCachedKey('googleProfiles');
        const data = { googleProfiles };
        updateGoogleProfilesFromData(data);
    })();
}

function updateGoogleProfilesFromData(data) {
    const profiles = data.googleProfiles || {};
    const currentString = JSON.stringify(profiles);
    if (prevGoogleProfilesString !== currentString) {
        const tbody = $("#googleProfiles tbody");
        tbody.empty();
        prevGoogleProfilesString = currentString;
        
        if (Object.keys(profiles).length === 0) {
            $("#googleProfiles").hide();
        } else {
            $("#googleProfiles").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(profiles).forEach(([profileID, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = profileRow(profileID, vl);
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
        
        // Also refresh Gemini Image profiles list if that section is visible
        if ($("#gemini-image-connect").is(":visible")) {
            loadGeminiImageProfileSettings();
        }
        // Also refresh Veo profiles list if that section is visible
        if ($("#veo-connect").is(":visible")) {
            loadVeoProfileSettings();
        }
    }
}

function updateDiscordProfiles() {
    (async function () {
        const discordProfiles = await getCachedKey('discordProfiles');
        const data = { discordProfiles };
        updateDiscordProfilesFromData(data);
    })();
}

function updateDiscordProfilesFromData(data) {
    const profiles = data.discordProfiles || {};
    const currentString = JSON.stringify(profiles);
    if (prevDiscordProfilesString !== currentString) {
        const tbody = $("#discordProfiles tbody");
        tbody.empty();
        prevDiscordProfilesString = currentString;
        
        if (Object.keys(profiles).length === 0) {
            $("#discordProfiles").hide();
        } else {
            $("#discordProfiles").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(profiles).forEach(([profileID, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = profileRow(profileID, vl);
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
        
        // Update the default Midjourney profile dropdown
        updateDefaultMidjourneyProfileDropdown(profiles);
    }
}

function updateOpenAIProfiles() {
    (async function () {
        const openaiProfiles = await getCachedKey('openaiProfiles');
        const data = { openaiProfiles };
        updateOpenAIProfilesFromData(data);
    })();
}

function updateOpenAIProfilesFromData(data) {
    const profiles = data.openaiProfiles || {};
    const currentString = JSON.stringify(profiles);
    if (prevOpenAIProfilesString !== currentString) {
        const tbody = $("#openaiProfiles tbody");
        tbody.empty();
        prevOpenAIProfilesString = currentString;
        
        if (Object.keys(profiles).length === 0) {
            $("#openaiProfiles").hide();
        } else {
            $("#openaiProfiles").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(profiles).forEach(([profileID, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = profileRow(profileID, vl, 'openai');
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
        
        // Also refresh Sora profiles list if that section is visible
        if ($("#sora-connect").is(":visible")) {
            loadSoraProfileSettings();
        }
    }

    refreshOpenAIImageBlockCountdowns();
}

function updateMetaAIProfiles() {
    (async function () {
        const metaaiProfiles = await getCachedKey('metaaiProfiles');
        const data = { metaaiProfiles };
        updateMetaAIProfilesFromData(data);
    })();
}

function updateMetaAIProfilesFromData(data) {
    const profiles = data.metaaiProfiles || {};
    const currentString = JSON.stringify(profiles);
    if (prevMetaAIProfilesString !== currentString) {
        const tbody = $("#metaaiProfiles tbody");
        tbody.empty();
        prevMetaAIProfilesString = currentString;
        
        if (Object.keys(profiles).length === 0) {
            $("#metaaiProfiles").hide();
        } else {
            $("#metaaiProfiles").show();
            const fragment = document.createDocumentFragment();
            
            Object.entries(profiles).forEach(([profileID, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = profileRow(profileID, vl);
                fragment.appendChild(row);
            });
            
            tbody[0].appendChild(fragment);
        }
    }
}

function updateDeepSeekBrowserProfiles() {
    (async function () {
        const deepseekBrowserProfiles = await getCachedKey('deepseekBrowserProfiles');
        const data = { deepseekBrowserProfiles };
        updateDeepSeekBrowserProfilesFromData(data);
    })();
}

function updateDeepSeekBrowserProfilesFromData(data) {
    const profiles = data.deepseekBrowserProfiles || {};
    const currentString = JSON.stringify(profiles);
    if (prevDeepSeekBrowserProfilesString !== currentString) {
        const tbody = $("#deepseekBrowserProfiles tbody");
        tbody.empty();
        prevDeepSeekBrowserProfilesString = currentString;

        if (Object.keys(profiles).length === 0) {
            $("#deepseekBrowserProfiles").hide();
        } else {
            $("#deepseekBrowserProfiles").show();
            const fragment = document.createDocumentFragment();

            Object.entries(profiles).forEach(([profileID, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = profileRow(profileID, vl, 'deepseekbrowser');
                fragment.appendChild(row);
            });

            tbody[0].appendChild(fragment);
        }
    }
}

function updateQwenBrowserProfiles() {
    (async function () {
        const qwenBrowserProfiles = await getCachedKey('qwenBrowserProfiles');
        const data = { qwenBrowserProfiles };
        updateQwenBrowserProfilesFromData(data);
    })();
}

function updateQwenBrowserProfilesFromData(data) {
    const profiles = data.qwenBrowserProfiles || {};
    const currentString = JSON.stringify(profiles);
    if (prevQwenBrowserProfilesString !== currentString) {
        const tbody = $("#qwenBrowserProfiles tbody");
        tbody.empty();
        prevQwenBrowserProfilesString = currentString;

        if (Object.keys(profiles).length === 0) {
            $("#qwenBrowserProfiles").hide();
        } else {
            $("#qwenBrowserProfiles").show();
            const fragment = document.createDocumentFragment();

            Object.entries(profiles).forEach(([profileID, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = profileRow(profileID, vl, 'qwenbrowser');
                fragment.appendChild(row);
            });

            tbody[0].appendChild(fragment);
        }
    }
}

function updateTikTokAdsProfiles() {
    (async function () {
        const tiktokAdsProfiles = await getCachedKey('tiktokAdsProfiles');
        const data = { tiktokAdsProfiles };
        updateTikTokAdsProfilesFromData(data);
    })();
}

function updateTikTokAdsProfilesFromData(data) {
    const profiles = data.tiktokAdsProfiles || {};
    const currentString = JSON.stringify(profiles);
    if (prevTikTokAdsProfilesString !== currentString) {
        const tbody = $("#tiktokAdsProfiles tbody");
        tbody.empty();
        prevTikTokAdsProfilesString = currentString;

        if (Object.keys(profiles).length === 0) {
            $("#tiktokAdsProfiles").hide();
        } else {
            $("#tiktokAdsProfiles").show();
            const fragment = document.createDocumentFragment();

            Object.entries(profiles).forEach(([profileID, vl]) => {
                const row = document.createElement('tr');
                row.innerHTML = profileRow(profileID, vl, 'tiktokads');
                fragment.appendChild(row);
            });

            tbody[0].appendChild(fragment);
        }
    }
}

async function updateDefaultMidjourneyProfileDropdown(profiles) {
// Update the default Midjourney profile dropdown
    const select = $("#defaultMidjourneyProfile");
    const currentValue = select.val();
    
    // Clear existing options except the first one
    select.find('option:not(:first)').remove();
    
    // Add connected profiles only
    Object.entries(profiles || {}).forEach(([profileID, profile]) => {
        if (profile.status === 'connected') {
            select.append(`<option value="${profileID}">${profile.name}</option>`);
        }
    });
    
    // Try to restore previous selection or load saved default
    const savedDefault = await window.electronAPI.readKey('defaultMidjourneyProfile');
    if (savedDefault && select.find(`option[value="${savedDefault}"]`).length > 0) {
        select.val(savedDefault);
    } else if (currentValue && select.find(`option[value="${currentValue}"]`).length > 0) {
        select.val(currentValue);
    }
}

// Save default Midjourney profile
$("#saveDefaultMidjourneyProfile").click(async function() {
    const profileId = $("#defaultMidjourneyProfile").val();
    
    if (!profileId) {
        showAlert("warning", window.I18n?.t('settings.alerts.select_profile_first') || "Please select a profile first");
        return;
    }
    
    try {
        await window.electronAPI.updateData('defaultMidjourneyProfile', profileId);
        showAlert("success", window.I18n?.t('settings.alerts.midjourney_profile_saved') || "Default Midjourney profile saved successfully");
    } catch (error) {
        console.error("Error saving default Midjourney profile:", error);
        showAlert("error", window.I18n?.t('settings.alerts.midjourney_profile_failed') || "Failed to save default Midjourney profile");
    }
});

// Load default Midjourney profile on page load
$(document).ready(async function() {
    // Load the dropdown after a short delay to ensure profiles are loaded
    setTimeout(async () => {
        const profiles = await window.electronAPI.readKey('discordProfiles') || {};
        await updateDefaultMidjourneyProfileDropdown(profiles);
    }, 500);
});

function formatImageBlockRemaining(blockedUntil) {
    const remainingMs = new Date(blockedUntil).getTime() - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';

    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const units = {
        day: window.I18n?.t('settings.chatgpt_profiles.day_short') || 'd',
        hour: window.I18n?.t('settings.chatgpt_profiles.hour_short') || 'h',
        minute: window.I18n?.t('settings.chatgpt_profiles.minute_short') || 'm'
    };
    const parts = [];

    if (days) parts.push(`${days}${units.day}`);
    if (hours && parts.length < 2) parts.push(`${hours}${units.hour}`);
    if (minutes && parts.length < 2) parts.push(`${minutes}${units.minute}`);
    if (!parts.length) parts.push(`1${units.minute}`);

    const time = parts.join(' ');
    return window.I18n?.t('settings.chatgpt_profiles.image_blocked_remaining', { time }) || `${time} left`;
}

function refreshOpenAIImageBlockCountdowns() {
    $('.profile-image-blocked[data-blocked-until]').each(function() {
        const remainingText = formatImageBlockRemaining($(this).attr('data-blocked-until'));
        if (!remainingText) {
            $(this).hide();
            return;
        }
        $(this).show().find('span').text(remainingText);
    });
}

function profileRow(profileID, vl, profileType = 'google') {
    const deepseekUntil = Math.max(Number(vl.muteUntil) || 0, Number(vl.retryAfter) || 0);
    const deepseekBlocked = profileType === 'deepseekbrowser' && (vl.muteUnknown || deepseekUntil > Date.now());
    const deepseekStatus = deepseekBlocked
        ? (vl.muteUnknown
            ? window.I18n?.t('settings.deepseek_restricted_unknown') || 'Restricted. Reopen the profile to check status.'
            : (window.I18n?.t('settings.deepseek_restricted_until') || 'Unavailable until') + ' ' + new Date(deepseekUntil).toLocaleString())
        : '';
    // Only show duplicate button for OpenAI profiles that are connected
    const showDuplicate = profileType === 'openai' && vl.status === 'connected';
    // Show test button for deepseek/qwen browser profiles that are connected
    const showTest = (profileType === 'deepseekbrowser' || profileType === 'qwenbrowser' || profileType === 'tiktokads') && vl.status === 'connected' && !deepseekBlocked;
    const imageBlockedUntil = profileType === 'openai' && vl.imageBlockedUntil
        ? new Date(vl.imageBlockedUntil)
        : null;
    const isImageBlocked = imageBlockedUntil && !Number.isNaN(imageBlockedUntil.getTime()) && imageBlockedUntil.getTime() > Date.now();
    const imageBlockedText = isImageBlocked
        ? formatImageBlockRemaining(vl.imageBlockedUntil)
        : '';
    
    // Get capabilities with backward compatibility (default to both enabled)
    const capabilities = vl.capabilities || ['image', 'chat'];
    const hasImage = capabilities.includes('image');
    const hasChat = capabilities.includes('chat');
    
    // Capabilities column HTML (only for OpenAI profiles)
    const capabilitiesHtml = profileType === 'openai' ? `
        <td class="profile-capabilities">
            <label class="capability-label" title="${window.I18n?.t('settings.chatgpt_profiles.capability_image') || 'Image Generation'}">
                <input type="checkbox" class="profile-capability" data-profile-id="${profileID}" data-capability="image" ${hasImage ? 'checked' : ''}>
                <i class="material-icons">image</i>
            </label>
            <label class="capability-label" title="${window.I18n?.t('settings.chatgpt_profiles.capability_chat') || 'Chat/Text'}">
                <input type="checkbox" class="profile-capability" data-profile-id="${profileID}" data-capability="chat" ${hasChat ? 'checked' : ''}>
                <i class="material-icons">chat</i>
            </label>
        </td>
    ` : '';
    
    return `<tr>
        <td>${vl.name}</td>
        <td>${formatReadableDate(vl.createdAt)}</td>
        <td>
            <div>
                <span class="status ${vl.status === "connected" ? "success" : vl.status === "expired" ? "warning" : "danger"}"></span>
                ${vl.status === "expired" ? (window.I18n?.t('settings.metaai_profiles.status_expired') || translateStatus('expired')) : translateStatus(vl.status)}
            </div>
            ${deepseekBlocked ? `<div>${$('<span>').text(deepseekStatus).html()}</div>` : ''}
            ${isImageBlocked ? `<div class="profile-image-blocked" data-blocked-until="${vl.imageBlockedUntil}"><i class="material-icons">schedule</i><span>${imageBlockedText}</span></div>` : ''}
        </td>
        ${capabilitiesHtml}
        <td>
            <div class="action-dropdown dropup">
                <button class="action-dropdown-toggle" title="Actions">
                    <i class="material-icons">more_vert</i>
                </button>
                <div class="action-dropdown-menu">
                    <button data-role="openProfile" data-id="${profileID}" class="action-dropdown-item item-primary">
                        <i class="material-icons">open_in_browser</i>
                        <span>${vl.status === "expired" ? (window.I18n?.t('settings.metaai_profiles.reconnect') || "Reconnect") : "Open"}</span>
                    </button>
                    ${vl.status === "connected" ? `<div class="action-dropdown-item" style="color: #28a745; cursor: default;">
                        <i class="material-icons">check</i>
                        <span>${translateStatus('connected')}</span>
                    </div>` : ``}
                    ${vl.status === "expired" ? `<div class="action-dropdown-item" style="color: #e6a817; cursor: default;">
                        <i class="material-icons">warning</i>
                        <span>${window.I18n?.t('settings.metaai_profiles.session_expired_hint') || "Session expired \u2014 please reconnect"}</span>
                    </div>` : ``}
                    ${showDuplicate ? `<button data-role="duplicateProfile" data-id="${profileID}" data-name="${vl.name}" class="action-dropdown-item item-info">
                        <i class="material-icons">content_copy</i>
                        <span>Duplicate</span>
                    </button>` : ``}
                    ${showTest ? `<button data-role="testProfile" data-id="${profileID}" data-type="${profileType}" class="action-dropdown-item item-info">
                        <i class="material-icons">science</i>
                        <span>Test</span>
                    </button>` : ``}
                    ${profileType === 'qwenbrowser' && vl.status === 'connected' ? `<button data-role="testCaptcha" data-id="${profileID}" class="action-dropdown-item item-info">
                        <i class="material-icons">verified_user</i>
                        <span>Test Captcha Solve</span>
                    </button>` : ``}
                    <div class="action-dropdown-divider"></div>
                    <button data-role="delete" data-id="${profileID}" class="action-dropdown-item item-danger">
                        <i class="material-icons">delete</i>
                        <span>Delete</span>
                    </button>
                </div>
            </div>
        </td>
    </tr>`;
}

// Handle capability checkbox changes for ChatGPT profiles
$(document).on('change', '.profile-capability', async function() {
    const profileId = $(this).data('profile-id');
    const capability = $(this).data('capability');
    const enabled = $(this).is(':checked');
    
    try {
        const profiles = await window.electronAPI.readKey('openaiProfiles') || {};
        
        if (!profiles[profileId]) {
            console.error('Profile not found:', profileId);
            return;
        }
        
        // Get current capabilities or default
        let capabilities = profiles[profileId].capabilities || ['image', 'chat'];
        
        if (enabled && !capabilities.includes(capability)) {
            capabilities.push(capability);
        } else if (!enabled) {
            capabilities = capabilities.filter(c => c !== capability);
        }
        
        // Ensure at least one capability is enabled
        if (capabilities.length === 0) {
            showAlert('warning', window.I18n?.t('settings.chatgpt_profiles.min_one_capability') || 'At least one feature must be enabled');
            $(this).prop('checked', true);
            return;
        }
        
        profiles[profileId].capabilities = capabilities;
        await window.electronAPI.updateData('openaiProfiles', profiles);
        clearKeyCache('openaiProfiles');
        
        console.log(`[Settings] Updated capabilities for ${profileId}: ${capabilities.join(', ')}`);
    } catch (error) {
        console.error('Error updating profile capabilities:', error);
        showAlert('error', window.I18n?.t('settings.alerts.capability_update_failed') || 'Failed to update profile capabilities');
        // Revert checkbox state
        $(this).prop('checked', !enabled);
    }
});

// Load automation settings when the section is shown
$(".menu-element[for='automation-settings']").click(function () {
    loadAutomationSettings();
});


// Load image processing settings when the section is shown
$(".menu-element[for='image-processing-settings']").click(function () {
    loadImageProcessingSettings();
});

async function loadImageProcessingSettings() {
    await loadImageMetadataSettings();
    await loadSeoMetadataSettings();
}

// ==================== AI Detection Settings ====================
$(".menu-element[for='recipe-detection-settings']").on("click.recipeSettings", async function () {
    await window.RecipeScreening.ready;
    $("#recipeDetectionEnabled").prop("checked", window.RecipeScreening.enabled).prop("disabled", false);
    $("#saveRecipeDetectionSettings").prop("disabled", false);
});

$("#saveRecipeDetectionSettings").on("click.recipeSettings", async function () {
    $(this).prop("disabled", true);
    try {
        await window.RecipeScreening.save($("#recipeDetectionEnabled").is(":checked"));
        showAlert("success", window.I18n?.t("settings.recipe_detection.saved") || "Halal Mode settings saved");
    } catch (error) {
        console.error("[Settings] Failed to save recipe detection settings:", error);
        showAlert("error", window.I18n?.t("settings.recipe_detection.save_failed") || "Failed to save Halal Mode settings");
    } finally {
        $(this).prop("disabled", false);
    }
});

$(".menu-element[for='ai-detection-settings']").click(function () {
    loadAiDetectionSettings();
});

async function loadAiDetectionSettings() {
    try {
        const settings = (await window.electronAPI.readKey("aiDetectionSettings")) || {};
        // Preserve the current behavior for existing users until they opt out.
        $("#showImageAiScores").prop("checked", settings.imageScoresEnabled !== false);
    } catch (error) {
        console.error("[Settings] Error loading AI detection settings:", error);
        $("#showImageAiScores").prop("checked", true);
    }
}

$("#saveAiDetectionSettings").click(async function () {
    try {
        await window.electronAPI.updateData("aiDetectionSettings", {
            imageScoresEnabled: $("#showImageAiScores").is(":checked"),
        });
        showAlert("success", window.I18n?.t("settings.ai_detection.saved") || "AI detection settings saved");
    } catch (error) {
        console.error("[Settings] Error saving AI detection settings:", error);
        showAlert("error", window.I18n?.t("settings.ai_detection.save_failed") || "Failed to save AI detection settings");
    }
});

// ==================== Sora Image Settings ====================
$(".menu-element[for='sora-connect']").click(async function () {
    await loadSoraProfileSettings();
});

async function loadSoraProfileSettings() {
    try {
        const profiles = (await window.electronAPI.readKey("openaiProfiles")) || {};
        const enabledProfiles = (await window.electronAPI.getEnabledSoraProfiles())?.profileIds || [];
        const container = $("#soraProfilesList");
        
        // Get connected profiles
        const connectedProfiles = Object.entries(profiles).filter(([_, p]) => p.status === "connected");
        
        if (connectedProfiles.length === 0) {
            container.html(`
                <div class="sora-no-profiles" data-i18n="settings.sora.no_profiles">
                    No connected OpenAI profiles found. Connect one in the ChatGPT section.
                </div>
            `);
            if (window.I18n) window.I18n.translatePage();
            return;
        }
        
        // Build toggle switch list
        let html = '';
        for (const [profileId, profile] of connectedProfiles) {
            // If no profiles are explicitly enabled yet, default to all enabled (backward compat)
            const isEnabled = enabledProfiles.length === 0 || enabledProfiles.includes(profileId);
            html += `
                <div class="sora-profile-item">
                    <div class="sora-profile-info">
                        <span class="sora-profile-name">${profile.name || profileId}</span>
                        <span class="sora-profile-status"><span class="status success"></span> ${translateStatus('connected')}</span>
                    </div>
                    <label class="settings-toggle">
                        <input type="checkbox" class="sora-profile-checkbox" data-profile-id="${profileId}" ${isEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            `;
        }
        
        container.html(html);
        
    } catch (error) {
        console.error("Error loading Sora profile settings:", error);
    }
}

// Handle individual Sora profile toggle change
$(document).on("change", ".sora-profile-checkbox", async function () {
    await saveSoraEnabledProfiles();
});

// Select all Sora profiles
$(document).on("click", "#soraSelectAll", async function () {
    $(".sora-profile-checkbox").prop("checked", true);
    await saveSoraEnabledProfiles();
});

// Deselect all Sora profiles
$(document).on("click", "#soraDeselectAll", async function () {
    $(".sora-profile-checkbox").prop("checked", false);
    await saveSoraEnabledProfiles();
});

// Save enabled Sora profiles to storage
async function saveSoraEnabledProfiles() {
    try {
        const enabledIds = [];
        $(".sora-profile-checkbox:checked").each(function () {
            enabledIds.push($(this).data("profile-id"));
        });
        
        await window.electronAPI.saveEnabledSoraProfiles(enabledIds);
        showAlert("success", window.I18n?.t('settings.alerts.sora_profiles_saved') || "Sora enabled profiles saved");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.sora_profiles_failed') || "Failed to save Sora profiles");
        console.error("Error saving enabled Sora profiles:", error);
    }
}

// ==================== Gemini Image Settings ====================
$(".menu-element[for='gemini-image-connect']").click(async function () {
    await loadGeminiImageProfileSettings();
});

async function loadGeminiImageProfileSettings() {
    try {
        const profiles = (await window.electronAPI.readKey("googleProfiles")) || {};
        const enabledProfiles = (await window.electronAPI.getEnabledGeminiImageProfiles())?.profileIds || [];
        const container = $("#geminiImageProfilesList");
        
        // Get connected profiles
        const connectedProfiles = Object.entries(profiles).filter(([_, p]) => p.status === "connected");
        
        if (connectedProfiles.length === 0) {
            container.html(`
                <div class="sora-no-profiles" data-i18n="settings.gemini_image.no_profiles">
                    No connected Google profiles found. Connect one in the Google Accounts section.
                </div>
            `);
            if (window.I18n) window.I18n.translatePage();
            return;
        }
        
        // Build toggle switch list
        let html = '';
        for (const [profileId, profile] of connectedProfiles) {
            // If no profiles are explicitly enabled yet, default to all enabled (backward compat)
            const isEnabled = enabledProfiles.length === 0 || enabledProfiles.includes(profileId);
            html += `
                <div class="sora-profile-item">
                    <div class="sora-profile-info">
                        <span class="sora-profile-name">${profile.name || profileId}</span>
                        <span class="sora-profile-status"><span class="status success"></span> ${translateStatus('connected')}</span>
                    </div>
                    <label class="settings-toggle">
                        <input type="checkbox" class="gemini-image-profile-checkbox" data-profile-id="${profileId}" ${isEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            `;
        }
        
        container.html(html);
        
    } catch (error) {
        console.error("Error loading Gemini Image profile settings:", error);
    }
}

// Handle individual Gemini Image profile toggle change
$(document).on("change", ".gemini-image-profile-checkbox", async function () {
    await saveGeminiImageEnabledProfiles();
});

// Select all Gemini Image profiles
$(document).on("click", "#geminiImageSelectAll", async function () {
    $(".gemini-image-profile-checkbox").prop("checked", true);
    await saveGeminiImageEnabledProfiles();
});

// Deselect all Gemini Image profiles
$(document).on("click", "#geminiImageDeselectAll", async function () {
    $(".gemini-image-profile-checkbox").prop("checked", false);
    await saveGeminiImageEnabledProfiles();
});

// Save enabled Gemini Image profiles to storage
async function saveGeminiImageEnabledProfiles() {
    try {
        const enabledIds = [];
        $(".gemini-image-profile-checkbox:checked").each(function () {
            enabledIds.push($(this).data("profile-id"));
        });
        
        await window.electronAPI.saveEnabledGeminiImageProfiles(enabledIds);
        showAlert("success", window.I18n?.t('settings.alerts.gemini_image_profiles_saved') || "Gemini Image enabled profiles saved");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.gemini_image_profiles_failed') || "Failed to save Gemini Image profiles");
        console.error("Error saving enabled Gemini Image profiles:", error);
    }
}

// ==================== Veo 3.1 Settings ====================
$(".menu-element[for='veo-connect']").click(async function () {
    await loadVeoProfileSettings();
});

async function loadVeoProfileSettings() {
    try {
        const profiles = (await window.electronAPI.readKey("googleProfiles")) || {};
        const enabledProfiles = (await window.electronAPI.getEnabledVeoProfiles())?.profileIds || [];
        const noAudioRetries = await window.electronAPI.readKey("veoNoAudioRetries");
        $("#veoNoAudioRetries").val(noAudioRetries != null ? noAudioRetries : 3);
        const container = $("#veoProfilesList");
        
        const connectedProfiles = Object.entries(profiles).filter(([_, p]) => p.status === "connected");
        
        if (connectedProfiles.length === 0) {
            container.html(`
                <div class="sora-no-profiles" data-i18n="settings.veo.no_profiles">
                    No connected Google profiles found. Connect one in the Google Accounts section.
                </div>
            `);
            if (window.I18n) window.I18n.translatePage();
            return;
        }
        
        let html = '';
        for (const [profileId, profile] of connectedProfiles) {
            const isEnabled = enabledProfiles.length === 0 || enabledProfiles.includes(profileId);
            html += `
                <div class="sora-profile-item">
                    <div class="sora-profile-info">
                        <span class="sora-profile-name">${profile.name || profileId}</span>
                        <span class="sora-profile-status"><span class="status success"></span> Connected</span>
                    </div>
                    <label class="settings-toggle">
                        <input type="checkbox" class="veo-profile-checkbox" data-profile-id="${profileId}" ${isEnabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            `;
        }
        
        container.html(html);
        
    } catch (error) {
        console.error("Error loading Veo 3.1 profile settings:", error);
    }
}

$(document).on("change", ".veo-profile-checkbox", async function () {
    await saveVeoEnabledProfiles();
});

$(document).on("click", "#veoSelectAll", async function () {
    $(".veo-profile-checkbox").prop("checked", true);
    await saveVeoEnabledProfiles();
});

$(document).on("click", "#veoDeselectAll", async function () {
    $(".veo-profile-checkbox").prop("checked", false);
    await saveVeoEnabledProfiles();
});

async function saveVeoEnabledProfiles() {
    try {
        const enabledIds = [];
        $(".veo-profile-checkbox:checked").each(function () {
            enabledIds.push($(this).data("profile-id"));
        });
        
        await window.electronAPI.saveEnabledVeoProfiles(enabledIds);
        showAlert("success", window.I18n?.t('settings.alerts.veo_profiles_saved') || "Veo 3.1 enabled profiles saved");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.veo_profiles_failed') || "Failed to save Veo 3.1 profiles");
        console.error("Error saving enabled Veo profiles:", error);
    }
}

$(document).on("change", "#veoNoAudioRetries", async function () {
    const val = Math.max(0, Math.min(10, parseInt($(this).val()) || 0));
    $(this).val(val);
    try {
        await window.electronAPI.updateData("veoNoAudioRetries", val);
        showAlert("success", window.I18n?.t('settings.alerts.veo_retries_saved') || "Veo 3.1 no-audio retries saved");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.veo_retries_failed') || "Failed to save Veo 3.1 retries setting");
    }
});

// Save automation settings
$("#saveAutomationSettings").click(async function () {
    const maxConcurrentWorkflows = parseInt($("#maxConcurrentWorkflows").val());
    const maxConcurrency = parseInt($("#maxConcurrency").val());
    const nodeRetryCount = parseInt($("#nodeRetryCount").val());
    const imageUploadMaxConcurrency = parseInt($("#imageUploadMaxConcurrency").val());
    const chatgptImageBatchSize = parseInt($("#chatgptImageBatchSize").val());
    const videoExportMaxConcurrent = parseInt($("#videoExportMaxConcurrent").val());

    // Get timeout values
    const wordpressTimeout = parseInt($("#wordpressTimeout").val());
    const openaiTimeout = parseInt($("#openaiTimeout").val());
    const openaiMaxConcurrent = parseInt($("#openaiMaxConcurrent").val());
    const googleSitesTimeout = parseInt($("#googleSitesTimeout").val());
    const googleSitesDelay = parseInt($("#googleSitesDelay").val());
    const imageUploadTimeout = parseInt($("#imageUploadTimeout").val());
    const midjourneyHttpTimeout = parseInt($("#midjourneyHttpTimeout").val());
    const soraMaxConcurrent = parseInt($("#soraMaxConcurrent").val());
    const soraTimeout = parseInt($("#soraTimeout").val());

    // Validate inputs
    if (isNaN(maxConcurrentWorkflows) || maxConcurrentWorkflows < 1 || maxConcurrentWorkflows > 10) {
        showAlert("error", window.I18n?.t('settings.alerts.max_concurrent_workflows_range') || "Maximum concurrent workflows must be between 1 and 10");
        return;
    }

    if (isNaN(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 50) {
        showAlert("error", window.I18n?.t('settings.alerts.max_concurrent_nodes_range') || "Maximum concurrent nodes must be between 1 and 50");
        return;
    }

    if (isNaN(nodeRetryCount) || nodeRetryCount < 0 || nodeRetryCount > 10) {
        showAlert("error", window.I18n?.t('settings.alerts.node_retry_range') || "Node retry count must be between 0 and 10");
        return;
    }

    if (isNaN(imageUploadMaxConcurrency) || imageUploadMaxConcurrency < 1 || imageUploadMaxConcurrency > 10) {
        showAlert("error", window.I18n?.t('settings.alerts.max_concurrent_uploads_range') || "Maximum concurrent image uploads must be between 1 and 10");
        return;
    }

    if (isNaN(chatgptImageBatchSize) || chatgptImageBatchSize < 1 || chatgptImageBatchSize > 5) {
        showAlert("error", window.I18n?.t('settings.alerts.chatgpt_batch_size_range') || "ChatGPT image batch size must be between 1 and 5");
        return;
    }

    if (isNaN(videoExportMaxConcurrent) || videoExportMaxConcurrent < 1 || videoExportMaxConcurrent > 5) {
        showAlert("error", window.I18n?.t('settings.alerts.video_export_max_concurrent_range') || "Video export max concurrent must be between 1 and 5");
        return;
    }

    // Validate timeout inputs
    if (isNaN(wordpressTimeout) || wordpressTimeout < 30 || wordpressTimeout > 1800) {
        showAlert("error", window.I18n?.t('settings.alerts.wordpress_timeout_range') || "WordPress timeout must be between 30 and 1800 seconds");
        return;
    }

    if (isNaN(openaiTimeout) || openaiTimeout < 30 || openaiTimeout > 1800) {
        showAlert("error", window.I18n?.t('settings.alerts.openai_timeout_range') || "OpenAI timeout must be between 30 and 1800 seconds");
        return;
    }

    if (isNaN(openaiMaxConcurrent) || openaiMaxConcurrent < 1 || openaiMaxConcurrent > 50) {
        showAlert("error", window.I18n?.t('settings.alerts.openai_max_concurrent_range') || "OpenAI max concurrent must be between 1 and 50");
        return;
    }

    if (isNaN(googleSitesTimeout) || googleSitesTimeout < 60 || googleSitesTimeout > 600) {
        showAlert("error", window.I18n?.t('settings.alerts.google_sites_timeout_range') || "Google Sites timeout must be between 60 and 600 seconds");
        return;
    }

    if (isNaN(googleSitesDelay) || googleSitesDelay < 0 || googleSitesDelay > 300) {
        showAlert("error", window.I18n?.t('settings.alerts.google_sites_delay_range') || "Google Sites delay must be between 0 and 300 seconds");
        return;
    }

    if (isNaN(imageUploadTimeout) || imageUploadTimeout < 10 || imageUploadTimeout > 300) {
        showAlert("error", window.I18n?.t('settings.alerts.image_upload_timeout_range') || "Image Upload timeout must be between 10 and 300 seconds");
        return;
    }

    if (isNaN(midjourneyHttpTimeout) || midjourneyHttpTimeout < 10 || midjourneyHttpTimeout > 300) {
        showAlert("error", window.I18n?.t('settings.alerts.midjourney_http_timeout_range') || "Midjourney HTTP timeout must be between 10 and 300 seconds");
        return;
    }

    if (isNaN(soraMaxConcurrent) || soraMaxConcurrent < 1 || soraMaxConcurrent > 10) {
        showAlert("error", window.I18n?.t('settings.alerts.sora_max_concurrent_range') || "Sora max concurrent must be between 1 and 10");
        return;
    }

    if (isNaN(soraTimeout) || soraTimeout < 60 || soraTimeout > 600) {
        showAlert("error", window.I18n?.t('settings.alerts.sora_timeout_range') || "Sora timeout must be between 60 and 600 seconds");
        return;
    }

    try {
        const automationSettings = {
            maxConcurrentWorkflows: maxConcurrentWorkflows,
            maxConcurrency: maxConcurrency,
            nodeRetryCount: nodeRetryCount,
            imageUploadMaxConcurrency: imageUploadMaxConcurrency,
            chatgptImageBatchSize: chatgptImageBatchSize,
            videoExportMaxConcurrent: videoExportMaxConcurrent,
            wordpressTimeout: wordpressTimeout,
            openaiTimeout: openaiTimeout,
            openaiMaxConcurrent: openaiMaxConcurrent,
            googleSitesTimeout: googleSitesTimeout,
            googleSitesDelay: googleSitesDelay,
            imageUploadTimeout: imageUploadTimeout,
            midjourneyHttpTimeout: midjourneyHttpTimeout,
            soraMaxConcurrent: soraMaxConcurrent,
            soraTimeout: soraTimeout,
            autoPolicyCheck: $("#autoPolicyCheck").is(":checked"),
            aiImageCleaning: $("#aiImageCleaning").is(":checked"),
            imageHumanize: $("#imageHumanize").is(":checked"),
            autoGenerateFacebookTitle: $("#autoGenerateFacebookTitle").is(":checked"),
            autoTitleProvider: $("#autoTitleProvider").val() || "",
            autoTitleModel: ($("#autoTitleModel").val() || "").trim(),
            useTitleSlugInImageName: $("#useTitleSlugInImageName").is(":checked")
        };

        await window.electronAPI.updateData("automationSettings", automationSettings);
        
        showAlert("success", window.I18n?.t('settings.alerts.automation_settings_saved') || "Automation settings saved successfully");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.automation_settings_failed') || "Failed to save automation settings");
        console.error("Error saving automation settings:", error);
    }
});

// Save Image Processing settings (Fake Device Metadata + SEO Metadata)
$("#saveImageProcessingSettings").click(async function () {
    try {
        // Save image metadata settings
        await saveImageMetadataSettings();
        
        // Save SEO metadata settings
        await saveSeoMetadataSettings();
        
        showAlert("success", window.I18n?.t('settings.alerts.image_processing_settings_saved') || "Image processing settings saved successfully");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.image_processing_settings_failed') || "Failed to save image processing settings");
        console.error("Error saving image processing settings:", error);
    }
});

// Reset Image Processing settings to defaults
$("#resetImageProcessingSettings").click(async function () {
    const confirmed = await confirmPrompt(window.I18n?.t('settings.alerts.confirm_reset_image_processing') || "Are you sure you want to reset all image processing settings to their default values?");
    if (confirmed) {
        try {
            // Reset image metadata settings
            const defaultMetadataSettings = {
                enabled: true,
                preset: 'iphone13promax',
                gpsEnabled: false,
                gpsCenter: null,
                gpsRadius: 1000,
                customFields: {}
            };
            await window.electronAPI.updateData("imageMetadataSettings", defaultMetadataSettings);
            
            // Reset SEO metadata settings
            const defaultSeoSettings = {
                enabled: false,
                nodeTypes: {
                    'chatgptimage': true,
                    'gptimage': true,
                    'soraimage': true,
                    'midjourney': true,
                    'googleaiimage': true
                },
                aiProvider: 'openai',
                proxyProfiles: [],
                automationProxies: {}
            };
            await window.electronAPI.saveSeoMetadataSettings(defaultSeoSettings);
            
            // Update metadata UI
            $("#injectFakeMetadata").prop("checked", true);
            $("#devicePreset").val('iphone13promax');
            $("#enableGpsMetadata").prop("checked", false);
            $("#gpsRadius").val(1000);
            $("#gpsMapContainer").hide();
            
            // Update SEO UI
            $("#enableSeoMetadata").prop("checked", false);
            $("#seoMetadataChatgptImage").prop("checked", true);
            $("#seoMetadataGptImage").prop("checked", true);
            $("#seoMetadataSoraImage").prop("checked", true);
            $("#seoMetadataMidjourney").prop("checked", true);
            $("#seoMetadataGoogleImage").prop("checked", true);
            renderSeoProxyProfiles([]);
            await renderSeoAutomationProxies([], {});
            await populateSeoAiProviderDropdown('openai');
            $("#seoMetadataOptions").hide();
            
            showAlert("success", window.I18n?.t('settings.alerts.image_processing_reset') || "Image processing settings reset to defaults");
        } catch (error) {
            showAlert("error", window.I18n?.t('settings.alerts.image_processing_reset_failed') || "Failed to reset image processing settings");
            console.error("Error resetting image processing settings:", error);
        }
    }
});

// Reset automation settings to defaults
$("#resetAutomationSettings").click(async function () {
    const confirmed = await confirmPrompt(window.I18n?.t('settings.alerts.confirm_reset_automation') || "Are you sure you want to reset all automation settings to their default values?");
    if (confirmed) {
        try {
            const defaultSettings = {
                maxConcurrentWorkflows: 2,
                maxConcurrency: 10,
                nodeRetryCount: 3,
                imageUploadMaxConcurrency: 1,
                chatgptImageBatchSize: 2,
                wordpressTimeout: 600,
                openaiTimeout: 600,
                openaiMaxConcurrent: 15,
                googleSitesTimeout: 180,
                googleSitesDelay: 90,
                imageUploadTimeout: 60,
                midjourneyHttpTimeout: 90,
                soraMaxConcurrent: 3,
                soraTimeout: 300,
                autoPolicyCheck: false,
                aiImageCleaning: true,
                imageHumanize: true,
                autoGenerateFacebookTitle: false,
                autoTitleProvider: "",
                autoTitleModel: "",
                useTitleSlugInImageName: false
            };

            // Update the form fields
            $("#maxConcurrentWorkflows").val(defaultSettings.maxConcurrentWorkflows);
            $("#maxConcurrency").val(defaultSettings.maxConcurrency);
            $("#nodeRetryCount").val(defaultSettings.nodeRetryCount);
            $("#imageUploadMaxConcurrency").val(defaultSettings.imageUploadMaxConcurrency);
            $("#chatgptImageBatchSize").val(defaultSettings.chatgptImageBatchSize);
            $("#videoExportMaxConcurrent").val(defaultSettings.videoExportMaxConcurrent);
            $("#wordpressTimeout").val(defaultSettings.wordpressTimeout);
            $("#openaiTimeout").val(defaultSettings.openaiTimeout);
            $("#openaiMaxConcurrent").val(defaultSettings.openaiMaxConcurrent);
            $("#googleSitesTimeout").val(defaultSettings.googleSitesTimeout);
            $("#googleSitesDelay").val(defaultSettings.googleSitesDelay);
            $("#imageUploadTimeout").val(defaultSettings.imageUploadTimeout);
            $("#midjourneyHttpTimeout").val(defaultSettings.midjourneyHttpTimeout);
            $("#soraMaxConcurrent").val(defaultSettings.soraMaxConcurrent);
            $("#soraTimeout").val(defaultSettings.soraTimeout);
            $("#autoPolicyCheck").prop("checked", defaultSettings.autoPolicyCheck);
            $("#aiImageCleaning").prop("checked", defaultSettings.aiImageCleaning);
            $("#imageHumanize").prop("checked", defaultSettings.imageHumanize);
            $("#autoGenerateFacebookTitle").prop("checked", defaultSettings.autoGenerateFacebookTitle);
            populateAutoTitleProviderDropdown("", "");
            $("#useTitleSlugInImageName").prop("checked", defaultSettings.useTitleSlugInImageName);
            $("#browserLanguageCountry").val('auto');

            // Save to storage
            await window.electronAPI.updateData("automationSettings", defaultSettings);
            await window.electronAPI.updateData("browserLanguageCountry", 'auto');
            
            showAlert("success", window.I18n?.t('settings.alerts.automation_settings_reset') || "Automation settings reset to defaults successfully");
        } catch (error) {
            showAlert("error", window.I18n?.t('settings.alerts.automation_settings_reset_failed') || "Failed to reset automation settings");
            console.error("Error resetting automation settings:", error);
        }
    }
});

// Browser Language Settings
async function loadBrowserLanguageSettings() {
    try {
        // Get available countries
        const countries = await window.electronAPI.getAvailableLocaleCountries();
        const select = $("#browserLanguageCountry");
        
        // Clear existing options except auto
        select.find('option:not([value="auto"])').remove();
        
        // Add country options
        countries.forEach(country => {
            select.append(`<option value="${country.code}">${country.name}</option>`);
        });
        
        // Load saved preference
        const savedCountry = await window.electronAPI.readKey('browserLanguageCountry');
        if (savedCountry) {
            select.val(savedCountry);
        }
        
        // Get detected country and update info text
        const detectedCountry = await window.electronAPI.getDetectedCountry();
        if (detectedCountry) {
            const countryInfo = countries.find(c => c.code === detectedCountry);
            const countryName = countryInfo ? countryInfo.name : detectedCountry;
            $("#detectedCountryInfo").html(`<i class="material-icons" style="font-size: 14px; vertical-align: middle;">location_on</i> Your detected location: <strong>${countryName}</strong>`);
        } else {
            $("#detectedCountryInfo").text('Could not detect your location. Using English (US) as fallback.');
        }
    } catch (error) {
        console.error('Error loading browser language settings:', error);
        $("#detectedCountryInfo").text('Error loading language settings');
    }
}

// Save browser language when changed
$(document).on('change', '#browserLanguageCountry', async function() {
    const selectedCountry = $(this).val();
    try {
        await window.electronAPI.updateData('browserLanguageCountry', selectedCountry);
        showAlert('success', window.I18n?.t('settings.alerts.language_saved') || 'Browser language preference saved');
    } catch (error) {
        console.error('Error saving browser language:', error);
        showAlert('error', window.I18n?.t('settings.alerts.language_save_failed') || 'Failed to save browser language preference');
    }
});

async function loadAutomationSettings() {
    try {
        // Load browser language settings
        await loadBrowserLanguageSettings();
        
        // Define defaults - merged with saved settings to handle missing keys from older versions
        const defaults = {
            maxConcurrentWorkflows: 2,
            maxConcurrency: 10,
            nodeRetryCount: 3,
            imageUploadMaxConcurrency: 1,
            chatgptImageBatchSize: 2,
            videoExportMaxConcurrent: 1,
            videoExportMaxConcurrent: 1,
            wordpressTimeout: 600,
            openaiTimeout: 600,
            openaiMaxConcurrent: 15,
            googleSitesTimeout: 180,
            googleSitesDelay: 90,
            imageUploadTimeout: 60,
            midjourneyHttpTimeout: 90,
            soraMaxConcurrent: 3,
            soraTimeout: 300,
            autoPolicyCheck: false,
            aiImageCleaning: true,
            imageHumanize: true
        };
        
        const savedSettings = (await window.electronAPI.readKey('automationSettings')) || {};
        const settings = { ...defaults, ...savedSettings };

        $("#maxConcurrentWorkflows").val(settings.maxConcurrentWorkflows || 2);
        $("#maxConcurrency").val(settings.maxConcurrency);
        $("#nodeRetryCount").val(settings.nodeRetryCount);
        $("#imageUploadMaxConcurrency").val(settings.imageUploadMaxConcurrency || 1);
        $("#chatgptImageBatchSize").val(settings.chatgptImageBatchSize || 2);
        $("#videoExportMaxConcurrent").val(settings.videoExportMaxConcurrent || 1);
        $("#wordpressTimeout").val(settings.wordpressTimeout || 600);
        $("#openaiTimeout").val(settings.openaiTimeout || 600);
        $("#openaiMaxConcurrent").val(settings.openaiMaxConcurrent || 15);
        $("#googleSitesTimeout").val(settings.googleSitesTimeout || 180);
        $("#googleSitesDelay").val(settings.googleSitesDelay ?? 90);
        $("#imageUploadTimeout").val(settings.imageUploadTimeout || 60);
        $("#midjourneyHttpTimeout").val(settings.midjourneyHttpTimeout || 90);
        $("#soraMaxConcurrent").val(settings.soraMaxConcurrent || 3);
        $("#soraTimeout").val(settings.soraTimeout || 300);
        $("#autoPolicyCheck").prop("checked", settings.autoPolicyCheck === true);
        $("#aiImageCleaning").prop("checked", settings.aiImageCleaning !== false); // Default true
        $("#imageHumanize").prop("checked", settings.imageHumanize !== false); // Default true
        $("#autoGenerateFacebookTitle").prop("checked", settings.autoGenerateFacebookTitle === true);
        populateAutoTitleProviderDropdown(settings.autoTitleProvider || "", settings.autoTitleModel || "");
        $("#useTitleSlugInImageName").prop("checked", settings.useTitleSlugInImageName === true);
    } catch (error) {
        console.error("Error loading automation settings:", error);
        // Set defaults if error
        $("#maxConcurrentWorkflows").val(2);
        $("#maxConcurrency").val(10);
        $("#nodeRetryCount").val(3);
        $("#imageUploadMaxConcurrency").val(1);
        $("#chatgptImageBatchSize").val(2);
        $("#videoExportMaxConcurrent").val(1);
        $("#wordpressTimeout").val(600);
        $("#openaiTimeout").val(600);
        $("#openaiMaxConcurrent").val(15);
        $("#googleSitesTimeout").val(180);
        $("#googleSitesDelay").val(90);
        $("#imageUploadTimeout").val(60);
        $("#midjourneyHttpTimeout").val(90);
        $("#soraMaxConcurrent").val(3);
        $("#soraTimeout").val(300);
        $("#aiImageCleaning").prop("checked", true); // Default enabled
        $("#imageHumanize").prop("checked", true); // Default enabled
    }
    
    // Load image metadata settings
    await loadImageMetadataSettings();
    
    // Load SEO metadata settings
    await loadSeoMetadataSettings();
}

// ==================== Image Metadata Settings ====================

// Use var instead of let to allow redeclaration on SPA page reload
var gpsMetadataMap = null;
var gpsCircle = null;
var gpsMarker = null;

/**
 * Load image metadata settings from storage
 */
async function loadImageMetadataSettings() {
    try {
        const defaults = {
            enabled: true,
            preset: 'iphone13promax',
            timestampDays: 7,
            gpsEnabled: false,
            gpsCenter: null,
            gpsRadius: 1000,
            customFields: {}
        };
        
        const savedSettings = (await window.electronAPI.readKey('imageMetadataSettings')) || {};
        const settings = { ...defaults, ...savedSettings };
        
        // Apply settings to UI
        $("#injectFakeMetadata").prop("checked", settings.enabled !== false);
        $("#devicePreset").val(settings.preset || 'iphone13promax');
        $("#timestampDays").val(settings.timestampDays || 7);
        $("#enableGpsMetadata").prop("checked", settings.gpsEnabled === true);
        $("#gpsRadius").val(settings.gpsRadius || 1000);
        
        // Custom fields
        if (settings.customFields) {
            $("#customMetaMake").val(settings.customFields.make || '');
            $("#customMetaModel").val(settings.customFields.model || '');
            $("#customMetaSoftware").val(settings.customFields.software || '');
            $("#customMetaLensMake").val(settings.customFields.lensMake || '');
            $("#customMetaLensModel").val(settings.customFields.lensModel || '');
            $("#customMetaLensInfo").val(settings.customFields.lensInfo || '');
        }
        
        // Update placeholders based on current preset
        updateMetadataPlaceholders(settings.preset || 'iphone13promax');
        
        // Show/hide GPS map container based on GPS toggle
        if (settings.gpsEnabled) {
            $("#gpsMapContainer").show();
            initGpsMetadataMap(settings.gpsCenter, settings.gpsRadius);
        } else {
            $("#gpsMapContainer").hide();
        }
        
        // Update GPS display
        if (settings.gpsCenter) {
            $("#gpsLatDisplay").text(settings.gpsCenter.lat.toFixed(6));
            $("#gpsLngDisplay").text(settings.gpsCenter.lng.toFixed(6));
        }
    } catch (error) {
        console.error("Error loading image metadata settings:", error);
        // Set defaults
        $("#injectFakeMetadata").prop("checked", true);
        $("#devicePreset").val('iphone13promax');
        $("#enableGpsMetadata").prop("checked", false);
        $("#gpsRadius").val(1000);
    }
}

/**
 * Save image metadata settings to storage
 */
async function saveImageMetadataSettings() {
    try {
        const customFields = {};
        const customMake = $("#customMetaMake").val().trim();
        const customModel = $("#customMetaModel").val().trim();
        const customSoftware = $("#customMetaSoftware").val().trim();
        const customLensMake = $("#customMetaLensMake").val().trim();
        const customLensModel = $("#customMetaLensModel").val().trim();
        const customLensInfo = $("#customMetaLensInfo").val().trim();
        
        if (customMake) customFields.make = customMake;
        if (customModel) customFields.model = customModel;
        if (customSoftware) customFields.software = customSoftware;
        if (customLensMake) customFields.lensMake = customLensMake;
        if (customLensModel) customFields.lensModel = customLensModel;
        if (customLensInfo) customFields.lensInfo = customLensInfo;
        
        // Get GPS center from the map marker if set
        let gpsCenter = null;
        if (gpsMarker) {
            const pos = gpsMarker.getLatLng();
            gpsCenter = { lat: pos.lat, lng: pos.lng };
        }
        
        const imageMetadataSettings = {
            enabled: $("#injectFakeMetadata").is(":checked"),
            preset: $("#devicePreset").val(),
            timestampDays: parseInt($("#timestampDays").val()) || 7,
            gpsEnabled: $("#enableGpsMetadata").is(":checked"),
            gpsCenter: gpsCenter,
            gpsRadius: parseInt($("#gpsRadius").val()) || 1000,
            customFields: customFields
        };
        
        await window.electronAPI.updateData("imageMetadataSettings", imageMetadataSettings);
        return true;
    } catch (error) {
        console.error("Error saving image metadata settings:", error);
        return false;
    }
}

// ==================== SEO Metadata Settings ====================

/**
 * Load SEO metadata settings from storage
 */
async function loadSeoMetadataSettings() {
    try {
        const result = await window.electronAPI.getSeoMetadataSettings();
        if (!result.success) {
            console.error("Failed to load SEO metadata settings:", result.error);
            return;
        }
        
        const settings = result.settings || {
            enabled: false,
            nodeTypes: {
                'chatgptimage': true,
                'gptimage': true,
                'soraimage': true,
                'midjourney': true,
                'googleaiimage': true,
                'minicanvas': true
            },
            aiProvider: 'openai',
            proxyProfiles: [],
            automationProxies: {}
        };
        
        // Populate AI provider dropdown with only connected APIs
        await populateSeoAiProviderDropdown(settings.aiProvider || 'openai');
        
        // Apply settings to UI
        $("#enableSeoMetadata").prop("checked", settings.enabled === true);
        $("#seoMetadataChatgptImage").prop("checked", settings.nodeTypes?.['chatgptimage'] !== false);
        $("#seoMetadataGptImage").prop("checked", settings.nodeTypes?.['gptimage'] !== false);
        $("#seoMetadataSoraImage").prop("checked", settings.nodeTypes?.['soraimage'] !== false);
        $("#seoMetadataMidjourney").prop("checked", settings.nodeTypes?.['midjourney'] !== false);
        $("#seoMetadataGoogleImage").prop("checked", settings.nodeTypes?.['googleaiimage'] !== false);
        $("#seoMetadataMiniCanvas").prop("checked", settings.nodeTypes?.['minicanvas'] !== false);
        
        // Render proxy profiles
        renderSeoProxyProfiles(settings.proxyProfiles || []);
        
        // Load automations and render with proxy assignments
        await renderSeoAutomationProxies(settings.proxyProfiles || [], settings.automationProxies || {});
        
        // Show/hide options based on enabled state
        if (settings.enabled) {
            $("#seoMetadataOptions").show();
        } else {
            $("#seoMetadataOptions").hide();
        }
    } catch (error) {
        console.error("Error loading SEO metadata settings:", error);
        // Set defaults
        $("#enableSeoMetadata").prop("checked", false);
        $("#seoMetadataChatgptImage").prop("checked", true);
        $("#seoMetadataGptImage").prop("checked", true);
        $("#seoMetadataSoraImage").prop("checked", true);
        $("#seoMetadataMidjourney").prop("checked", true);
        $("#seoMetadataGoogleImage").prop("checked", true);
        $("#seoMetadataMiniCanvas").prop("checked", true);
        renderSeoProxyProfiles([]);
        await renderSeoAutomationProxies([], {});
        await populateSeoAiProviderDropdown('openai');
        $("#seoMetadataOptions").hide();
    }
}

/**
 * Render proxy profiles list in the SEO settings
 */
function renderSeoProxyProfiles(profiles) {
    const $container = $("#seoProxyProfilesList");
    $container.empty();
    
    if (!profiles || profiles.length === 0) {
        $container.append(`
            <div class="seo-proxy-empty" style="color: var(--text-secondary); font-size: 13px; padding: 10px; text-align: center;">
                ${window.I18n?.t('settings.image_processing.seo_no_proxy_profiles') || 'No proxy profiles configured. Add one to use country-specific Google Suggestions.'}
            </div>
        `);
        return;
    }
    
    profiles.forEach((profile, index) => {
        const $profile = $(`
            <div class="seo-proxy-profile" data-index="${index}" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <input type="text" class="form-control seo-proxy-name" value="${escapeHtml(profile.name || '')}" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_name_placeholder') || 'Profile Name (e.g., US Proxy)'}" style="flex: 1; margin-right: 10px;">
                    <button type="button" class="btn-one seo-remove-proxy-profile" style="background-color: #dc3545; padding: 6px 12px;">
                        <i class="material-icons" style="font-size: 18px;">delete</i>
                    </button>
                </div>
                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px;">
                    <input type="text" class="form-control seo-proxy-ip" value="${escapeHtml(profile.ip || '')}" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_ip_placeholder') || 'IP Address'}">
                    <input type="text" class="form-control seo-proxy-port" value="${escapeHtml(profile.port || '')}" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_port_placeholder') || 'Port'}">
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
                    <input type="text" class="form-control seo-proxy-username" value="${escapeHtml(profile.username || '')}" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_username_placeholder') || 'Username (optional)'}">
                    <input type="password" class="form-control seo-proxy-password" value="${escapeHtml(profile.password || '')}" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_password_placeholder') || 'Password (optional)'}">
                </div>
            </div>
        `);
        $container.append($profile);
    });
    
    // Also update the "Set All" dropdown
    updateSetAllProxyDropdown(profiles);
}

/**
 * Update the "Set All" proxy dropdown with current profiles
 */
function updateSetAllProxyDropdown(proxyProfiles) {
    const $select = $("#seoSetAllProxySelect");
    $select.find("option:not(:first)").remove();
    
    if (proxyProfiles && proxyProfiles.length > 0) {
        proxyProfiles.forEach(p => {
            if (p.name) {
                $select.append(`<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`);
            }
        });
    }
}

/**
 * Render automation proxy assignments list
 */
async function renderSeoAutomationProxies(proxyProfiles, automationProxies) {
    const $container = $("#seoAutomationProxiesList");
    $container.empty();
    
    // Update the "Set All" dropdown
    updateSetAllProxyDropdown(proxyProfiles);
    
    try {
        const result = await window.electronAPI.getAutomationsList();
        if (!result.success || !result.data || result.data.length === 0) {
            $container.append(`
                <div style="color: var(--text-secondary); font-size: 13px; padding: 10px; text-align: center;">
                    ${window.I18n?.t('settings.image_processing.seo_no_automations') || 'No automations found. Create automations first to assign proxies.'}
                </div>
            `);
            $("#seoSetAllProxyContainer").hide();
            return;
        }
        
        $("#seoSetAllProxyContainer").show();
        const automations = result.data;
        
        automations.forEach(automation => {
            const selectedProxy = automationProxies[automation.id] || '';
            
            const $row = $(`
                <div class="seo-automation-proxy-row" data-automation-id="${automation.id}" style="display: flex; align-items: center; gap: 15px; padding: 10px; border-bottom: 1px solid var(--border-color);">
                    <span style="flex: 1; font-size: 14px; color: var(--text-primary);">${escapeHtml(automation.name)}</span>
                    <select class="form-control seo-automation-proxy-select" style="width: 200px;">
                        <option value="">${window.I18n?.t('settings.image_processing.seo_no_proxy') || 'No Proxy'}</option>
                        ${proxyProfiles.map(p => `<option value="${escapeHtml(p.name)}" ${selectedProxy === p.name ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                    </select>
                </div>
            `);
            $container.append($row);
        });
    } catch (error) {
        console.error("Error loading automations for proxy assignment:", error);
        $container.append(`
            <div style="color: #dc3545; font-size: 13px; padding: 10px; text-align: center;">
                ${window.I18n?.t('settings.image_processing.seo_automations_error') || 'Failed to load automations'}
            </div>
        `);
        $("#seoSetAllProxyContainer").hide();
    }
}

// ── Auto-Title provider/model selection ─────────────────────────────────────
/**
 * Show/hide and prefill the Auto-Title model field based on the chosen provider.
 * @param {string} modelValue - the saved model to prefill (empty → use default)
 */
function applyAutoTitleModelField(modelValue) {
    const AUTOTITLE_DEFAULT_MODELS = {
        openai:    "gpt-4o-mini",
        anthropic: "claude-3-5-haiku-20241022",
        googleai:  "gemini-2.0-flash",
        deepseek:  "deepseek-chat",
        qwen:      "qwen-plus",
        zhipu:     "glm-4-flash",
        moonshot:  "moonshot-v1-8k",
    };
    // Providers that need no model field (auto, VC AI, browser-based).
    const AUTOTITLE_NO_MODEL = ["", "vcai", "deepseekbrowser", "qwenbrowser"];
    const provider = $("#autoTitleProvider").val() || "";
    const $group = $("#autoTitleModelGroup");
    const $model = $("#autoTitleModel");
    if (AUTOTITLE_NO_MODEL.includes(provider)) {
        $group.hide();
        $model.val("");
        return;
    }
    $group.show();
    const def = AUTOTITLE_DEFAULT_MODELS[provider] || "";
    $model.val(modelValue || def);
}

/**
 * Populate the Auto-Title provider dropdown with VC AI + connected AI providers.
 * @param {string} selectedProvider
 * @param {string} selectedModel
 */
async function populateAutoTitleProviderDropdown(selectedProvider, selectedModel) {
    const AUTOTITLE_PROVIDER_LABELS = {
        vcai:            "ViralCloner AI",
        deepseek:        "DeepSeek",
        deepseekbrowser: "DeepSeek Browser",
        openai:          "OpenAI",
        anthropic:       "Anthropic",
        googleai:        "Google AI",
        openrouter:      "OpenRouter",
        qwen:            "Qwen",
        qwenbrowser:     "Qwen Browser",
        zhipu:           "Zhipu",
        moonshot:        "Moonshot",
    };
    const $sel = $("#autoTitleProvider");
    if (!$sel.length) return;
    // Keep the "Auto" option (value="") and rebuild the rest.
    $sel.find('option:not([value=""])').remove();
    try {
        const res = await window.electronAPI.fbGroupsGetConnectedAiProviders();
        const data = (res && res.success && res.data) ? res.data : {};
        Object.keys(AUTOTITLE_PROVIDER_LABELS).forEach((k) => {
            if (k === "vcai") return;
            if (data[k]) {
                $sel.append(`<option value="${k}">${AUTOTITLE_PROVIDER_LABELS[k]}</option>`);
            }
        });
    } catch (err) {
        console.error("Error loading AI providers for auto-title:", err);
    }
    // Restore the saved selection if still available, else fall back to Auto.
    if ($sel.find(`option[value="${selectedProvider}"]`).length > 0) {
        $sel.val(selectedProvider);
    } else {
        $sel.val("");
    }
    applyAutoTitleModelField(selectedModel);
    $sel.off("change.autoTitle").on("change.autoTitle", function () {
        applyAutoTitleModelField("");
    });
}

/**
 * Populate SEO AI provider dropdown with only connected APIs
 */
async function populateSeoAiProviderDropdown(selectedValue) {
    const $select = $("#seoMetadataAiProvider");
    $select.empty();
    
    // Helper to check if keys object/array has entries
    function hasKeys(keys) {
        if (!keys) return false;
        if (Array.isArray(keys)) return keys.length > 0;
        if (typeof keys === 'object') return Object.keys(keys).length > 0;
        return false;
    }
    
    try {
        // Clear cache to get fresh data
        clearKeyCache('openaiKeys');
        clearKeyCache('anthropicKeys');
        clearKeyCache('googleaiKeys');
        
        // Check which API keys are configured - use direct readKey to bypass cache
        const [openaiKeys, anthropicKeys, googleaiKeys] = await Promise.all([
            window.electronAPI.readKey('openaiKeys'),
            window.electronAPI.readKey('anthropicKeys'),
            window.electronAPI.readKey('googleaiKeys')
        ]);
        
        const hasOpenAI = hasKeys(openaiKeys);
        const hasAnthropic = hasKeys(anthropicKeys);
        const hasGoogleAI = hasKeys(googleaiKeys);
        

        // Add options for connected APIs only
        if (hasOpenAI) {
            $select.append('<option value="openai">OpenAI (GPT-5 Nano)</option>');
        }
        if (hasAnthropic) {
            $select.append('<option value="anthropic">Anthropic (Claude Haiku)</option>');
        }
        if (hasGoogleAI) {
            $select.append('<option value="googleai">Google AI (Gemini Flash)</option>');
        }
        
        // If no APIs connected, show a placeholder
        if (!hasOpenAI && !hasAnthropic && !hasGoogleAI) {
            $select.append('<option value="" disabled>No AI APIs configured</option>');
        }
        
        // Set the selected value if it exists in options
        if ($select.find(`option[value="${selectedValue}"]`).length > 0) {
            $select.val(selectedValue);
        } else {
            // Fall back to first available option
            $select.prop('selectedIndex', 0);
        }
    } catch (error) {
        console.error("Error populating SEO AI provider dropdown:", error);
        // Fallback: show all options
        $select.append('<option value="openai">OpenAI (GPT-5 Nano)</option>');
        $select.append('<option value="anthropic">Anthropic (Claude Haiku)</option>');
        $select.append('<option value="googleai">Google AI (Gemini Flash)</option>');
        $select.val(selectedValue);
    }
}

/**
 * Save SEO metadata settings to storage
 */
async function saveSeoMetadataSettings() {
    try {
        // Collect proxy profiles from UI
        const proxyProfiles = [];
        $("#seoProxyProfilesList .seo-proxy-profile").each(function() {
            const $profile = $(this);
            const name = $profile.find(".seo-proxy-name").val()?.trim();
            const ip = $profile.find(".seo-proxy-ip").val()?.trim();
            const port = $profile.find(".seo-proxy-port").val()?.trim();
            const username = $profile.find(".seo-proxy-username").val()?.trim() || null;
            const password = $profile.find(".seo-proxy-password").val()?.trim() || null;
            
            if (name && ip && port) {
                proxyProfiles.push({ name, ip, port, username, password });
            }
        });
        
        // Collect automation proxy assignments from UI
        const automationProxies = {};
        $("#seoAutomationProxiesList .seo-automation-proxy-row").each(function() {
            const $row = $(this);
            const automationId = $row.data("automation-id");
            const proxyName = $row.find(".seo-automation-proxy-select").val();
            if (automationId && proxyName) {
                automationProxies[automationId] = proxyName;
            }
        });

        const seoMetadataSettings = {
            enabled: $("#enableSeoMetadata").is(":checked"),
            nodeTypes: {
                'chatgptimage': $("#seoMetadataChatgptImage").is(":checked"),
                'gptimage': $("#seoMetadataGptImage").is(":checked"),
                'soraimage': $("#seoMetadataSoraImage").is(":checked"),
                'midjourney': $("#seoMetadataMidjourney").is(":checked"),
                'googleaiimage': $("#seoMetadataGoogleImage").is(":checked"),
                'minicanvas': $("#seoMetadataMiniCanvas").is(":checked")
            },
            aiProvider: $("#seoMetadataAiProvider").val() || 'openai',
            proxyProfiles: proxyProfiles,
            automationProxies: automationProxies
        };
        
        const result = await window.electronAPI.saveSeoMetadataSettings(seoMetadataSettings);
        if (!result.success) {
            console.error("Failed to save SEO metadata settings:", result.error);
            return false;
        }
        return true;
    } catch (error) {
        console.error("Error saving SEO metadata settings:", error);
        return false;
    }
}

// SEO Metadata toggle handler
$(document).on("change", "#enableSeoMetadata", function() {
    if ($(this).is(":checked")) {
        $("#seoMetadataOptions").slideDown(200);
    } else {
        $("#seoMetadataOptions").slideUp(200);
    }
});

// Add new proxy profile
$(document).on("click", "#addSeoProxyProfile", function() {
    const $container = $("#seoProxyProfilesList");
    
    // Remove "no profiles" message if present
    $container.find(".seo-proxy-empty").remove();
    
    const index = $container.find(".seo-proxy-profile").length;
    const $profile = $(`
        <div class="seo-proxy-profile" data-index="${index}" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <input type="text" class="form-control seo-proxy-name" value="" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_name_placeholder') || 'Profile Name (e.g., US Proxy)'}" style="flex: 1; margin-right: 10px;">
                <button type="button" class="btn-one seo-remove-proxy-profile" style="background-color: #dc3545; padding: 6px 12px;">
                    <i class="material-icons" style="font-size: 18px;">delete</i>
                </button>
            </div>
            <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px;">
                <input type="text" class="form-control seo-proxy-ip" value="" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_ip_placeholder') || 'IP Address'}">
                <input type="text" class="form-control seo-proxy-port" value="" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_port_placeholder') || 'Port'}">
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
                <input type="text" class="form-control seo-proxy-username" value="" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_username_placeholder') || 'Username (optional)'}">
                <input type="password" class="form-control seo-proxy-password" value="" placeholder="${window.I18n?.t('settings.image_processing.seo_proxy_password_placeholder') || 'Password (optional)'}">
            </div>
        </div>
    `);
    $container.append($profile);
    
    // Focus on the name field
    $profile.find(".seo-proxy-name").focus();
});

// Remove proxy profile
$(document).on("click", ".seo-remove-proxy-profile", function() {
    const $profile = $(this).closest(".seo-proxy-profile");
    const profileName = $profile.find(".seo-proxy-name").val();
    
    $profile.remove();
    
    // If no profiles left, show empty message
    if ($("#seoProxyProfilesList .seo-proxy-profile").length === 0) {
        $("#seoProxyProfilesList").append(`
            <div class="seo-proxy-empty" style="color: var(--text-secondary); font-size: 13px; padding: 10px; text-align: center;">
                ${window.I18n?.t('settings.image_processing.seo_no_proxy_profiles') || 'No proxy profiles configured. Add one to use country-specific Google Suggestions.'}
            </div>
        `);
    }
    
    // Update automation proxy dropdowns to remove deleted profile
    if (profileName) {
        $("#seoAutomationProxiesList .seo-automation-proxy-select").each(function() {
            const $select = $(this);
            $select.find(`option[value="${escapeHtml(profileName)}"]`).remove();
            // If this option was selected, revert to "No Proxy"
            if ($select.val() === profileName) {
                $select.val('');
            }
        });
    }
});

// Update automation dropdowns when proxy profile name changes
$(document).on("change", ".seo-proxy-name", async function() {
    // Collect current profiles from UI
    const proxyProfiles = [];
    $("#seoProxyProfilesList .seo-proxy-profile").each(function() {
        const name = $(this).find(".seo-proxy-name").val()?.trim();
        if (name) {
            proxyProfiles.push({ name });
        }
    });
    
    // Update all automation dropdowns
    $("#seoAutomationProxiesList .seo-automation-proxy-select").each(function() {
        const $select = $(this);
        const currentValue = $select.val();
        
        // Rebuild options
        $select.find("option:not(:first)").remove();
        proxyProfiles.forEach(p => {
            $select.append(`<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`);
        });
        
        // Restore selection if still valid
        if (proxyProfiles.some(p => p.name === currentValue)) {
            $select.val(currentValue);
        }
    });
    
    // Also update the "Set All" dropdown
    updateSetAllProxyDropdown(proxyProfiles);
});

// Apply proxy to all automations
$(document).on("click", "#seoApplyAllProxy", function() {
    const selectedProxy = $("#seoSetAllProxySelect").val();
    
    // Set all automation dropdowns to the selected proxy
    $("#seoAutomationProxiesList .seo-automation-proxy-select").each(function() {
        $(this).val(selectedProxy);
    });
    
    // Show brief feedback
    const $btn = $(this);
    const originalHtml = $btn.html();
    $btn.html('<i class="material-icons" style="font-size: 16px;">check</i> <span>' + (window.I18n?.t('settings.image_processing.seo_applied') || 'Applied!') + '</span>');
    setTimeout(() => {
        $btn.html(originalHtml);
    }, 1500);
});

/**
 * Initialize the GPS metadata map with Leaflet
 */
function initGpsMetadataMap(centerCoords, radius) {
    // Check if Leaflet is available
    if (typeof L === 'undefined') {
        console.error('[Settings] Leaflet not loaded');
        return;
    }
    
    // Default center (Europe - roughly central location)
    const defaultCenter = [48.8566, 2.3522]; // Paris
    const center = centerCoords ? [centerCoords.lat, centerCoords.lng] : defaultCenter;
    
    // If map already exists, just update it
    if (gpsMetadataMap) {
        gpsMetadataMap.setView(center, 10);
        updateGpsCircle(center, radius);
        return;
    }
    
    // Create map
    gpsMetadataMap = L.map('gpsMetadataMap').setView(center, 10);
    
    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 18
    }).addTo(gpsMetadataMap);
    
    // Add click handler to set location
    gpsMetadataMap.on('click', function(e) {
        const currentRadius = parseInt($("#gpsRadius").val()) || 1000;
        updateGpsCircle([e.latlng.lat, e.latlng.lng], currentRadius);
        
        // Update display
        $("#gpsLatDisplay").text(e.latlng.lat.toFixed(6));
        $("#gpsLngDisplay").text(e.latlng.lng.toFixed(6));
    });
    
    // If we have a saved center, add the circle and marker
    if (centerCoords) {
        updateGpsCircle(center, radius);
    }
    
    // Fix map rendering after container becomes visible
    setTimeout(() => {
        gpsMetadataMap.invalidateSize();
    }, 100);
}

/**
 * Update the GPS circle and marker on the map
 */
function updateGpsCircle(center, radius) {
    if (!gpsMetadataMap) return;
    
    // Remove existing circle and marker
    if (gpsCircle) {
        gpsMetadataMap.removeLayer(gpsCircle);
    }
    if (gpsMarker) {
        gpsMetadataMap.removeLayer(gpsMarker);
    }
    
    // Add new circle
    gpsCircle = L.circle(center, {
        color: '#0d6efd',
        fillColor: '#0d6efd',
        fillOpacity: 0.2,
        radius: radius
    }).addTo(gpsMetadataMap);
    
    // Add center marker
    gpsMarker = L.marker(center, {
        draggable: true
    }).addTo(gpsMetadataMap);
    
    // Handle marker drag
    gpsMarker.on('dragend', function(e) {
        const pos = e.target.getLatLng();
        const currentRadius = parseInt($("#gpsRadius").val()) || 1000;
        updateGpsCircle([pos.lat, pos.lng], currentRadius);
        
        // Update display
        $("#gpsLatDisplay").text(pos.lat.toFixed(6));
        $("#gpsLngDisplay").text(pos.lng.toFixed(6));
    });
}

// Toggle GPS map container visibility
$(document).on("change", "#enableGpsMetadata", function() {
    if ($(this).is(":checked")) {
        $("#gpsMapContainer").slideDown(200, function() {
            // Initialize map if not already done
            if (!gpsMetadataMap) {
                const radius = parseInt($("#gpsRadius").val()) || 1000;
                initGpsMetadataMap(null, radius);
            } else {
                gpsMetadataMap.invalidateSize();
            }
        });
    } else {
        $("#gpsMapContainer").slideUp(200);
    }
});

// Update circle radius when changed
$(document).on("change", "#gpsRadius", function() {
    if (gpsMarker) {
        const pos = gpsMarker.getLatLng();
        const newRadius = parseInt($(this).val()) || 1000;
        updateGpsCircle([pos.lat, pos.lng], newRadius);
    }
});

// Toggle advanced metadata fields
$(document).on("click", "#toggleAdvancedMetadata", function() {
    const $fields = $("#advancedMetadataFields");
    const $icon = $(this).find("i");
    
    if ($fields.is(":visible")) {
        $fields.slideUp(200);
        $icon.text("expand_more");
    } else {
        $fields.slideDown(200);
        $icon.text("expand_less");
    }
});

// Device preset placeholders data (use var to allow redeclaration on SPA page reload)
var DEVICE_PRESET_DATA = {
    iphone13promax: { make: 'Apple', model: 'iPhone 13 Pro Max', software: '18.6.2', lensMake: 'Apple', lensModel: 'iPhone 13 Pro Max back triple camera 5.7mm f/1.5', lensInfo: '1.570000052-9mm f/1.5-2.8' },
    iphone15pro: { make: 'Apple', model: 'iPhone 15 Pro', software: '18.6.2', lensMake: 'Apple', lensModel: 'iPhone 15 Pro back triple camera 6.765mm f/1.78', lensInfo: '2.220000029-9mm f/1.78-2.8' },
    iphone15promax: { make: 'Apple', model: 'iPhone 15 Pro Max', software: '18.6.2', lensMake: 'Apple', lensModel: 'iPhone 15 Pro Max back triple camera 6.765mm f/1.78', lensInfo: '2.220000029-9mm f/1.78-2.8' },
    iphone14: { make: 'Apple', model: 'iPhone 14', software: '18.6.2', lensMake: 'Apple', lensModel: 'iPhone 14 back dual wide camera 5.7mm f/1.5', lensInfo: '1.539999962-4.25mm f/1.5-2.4' },
    samsungs24ultra: { make: 'samsung', model: 'SM-S928B', software: 'S928BXXS3AXB1', lensMake: '', lensModel: '', lensInfo: '' },
    pixel8pro: { make: 'Google', model: 'Pixel 8 Pro', software: 'husky-user 15 AP4A.250305.002', lensMake: '', lensModel: '', lensInfo: '' },
    custom: { make: '', model: '', software: '', lensMake: '', lensModel: '', lensInfo: '' }
};

/**
 * Update placeholder text based on selected preset
 */
function updateMetadataPlaceholders(presetId) {
    const preset = DEVICE_PRESET_DATA[presetId] || DEVICE_PRESET_DATA.iphone13promax;
    $("#customMetaMake").attr("placeholder", preset.make || "Enter make...");
    $("#customMetaModel").attr("placeholder", preset.model || "Enter model...");
    $("#customMetaSoftware").attr("placeholder", preset.software || "Enter version...");
    $("#customMetaLensMake").attr("placeholder", preset.lensMake || "Enter lens make...");
    $("#customMetaLensModel").attr("placeholder", preset.lensModel || "Enter lens model...");
    $("#customMetaLensInfo").attr("placeholder", preset.lensInfo || "Enter lens info...");
}

// Update placeholders when preset changes
$(document).on("change", "#devicePreset", function() {
    const preset = $(this).val();
    updateMetadataPlaceholders(preset);
    
    // If switching away from custom and fields are filled, clear them (optional)
    // Or keep them - user might want to modify a preset
});

// Switch to Custom when any custom field is modified
$(document).on("input", "#customMetaMake, #customMetaModel, #customMetaSoftware, #customMetaLensMake, #customMetaLensModel, #customMetaLensInfo", function() {
    const hasCustomValue = 
        $("#customMetaMake").val().trim() ||
        $("#customMetaModel").val().trim() ||
        $("#customMetaSoftware").val().trim() ||
        $("#customMetaLensMake").val().trim() ||
        $("#customMetaLensModel").val().trim() ||
        $("#customMetaLensInfo").val().trim();
    
    if (hasCustomValue && $("#devicePreset").val() !== 'custom') {
        $("#devicePreset").val('custom');
        updateMetadataPlaceholders('custom');
    }
});

// ==================== Notifications Settings (Telegram + System) ====================

// Load all notification settings when the section is shown
$(".menu-element[for='notifications-settings']").click(async function () {
    await loadTelegramSettings();
    await loadSystemNotificationSettings();
    updateNotificationWarningBanner();
});

// Update the warning banner based on notification settings
function updateNotificationWarningBanner() {
    const systemEnabled = $("#systemNotificationsEnabled").is(":checked");
    const telegramEnabled = $("#telegramEnabled").is(":checked");
    
    const banner = $("#notificationWarningBanner");
    const title = $("#notificationWarningTitle");
    const text = $("#notificationWarningText");
    
    if (!systemEnabled && !telegramEnabled) {
        // Both disabled
        title.text("All Notifications Disabled");
        text.text("You don't have any notification channel enabled. We recommend enabling at least one notification method to stay informed about captcha alerts and workflow status.");
        banner.show();
    } else if (!systemEnabled && telegramEnabled) {
        // Only Telegram enabled
        title.text("System Notifications Disabled");
        text.text("System notifications are disabled. Consider enabling them for instant desktop alerts even when the app is minimized.");
        banner.show();
    } else if (systemEnabled && !telegramEnabled) {
        // Only System enabled
        title.text("Telegram Notifications Disabled");
        text.text("Telegram notifications are disabled. Consider enabling them to receive alerts on your phone when you're away from your computer.");
        banner.show();
    } else {
        // Both enabled
        banner.hide();
    }
}

// Listen for changes on the enable toggles to update banner in real-time
$("#systemNotificationsEnabled, #telegramEnabled").change(function() {
    updateNotificationWarningBanner();
});

// Toggle bot token visibility
$("#toggleBotTokenVisibility").click(function () {
    const input = $("#telegramBotToken");
    const icon = $(this).find("i");
    
    if (input.attr("type") === "password") {
        input.attr("type", "text");
        icon.text("visibility_off");
    } else {
        input.attr("type", "password");
        icon.text("visibility");
    }
});

// Validate Telegram bot token
$("#validateTelegramBot").click(async function () {
    const botToken = $("#telegramBotToken").val().trim();
    
    if (!botToken) {
        $("#botTokenStatus").html('<span style="color: #dc3545;">Please enter a bot token</span>');
        return;
    }
    
    const btn = $(this);
    const originalHtml = btn.html();
    btn.prop("disabled", true).html('<i class="material-icons rotating">refresh</i><span>Validating...</span>');
    $("#botTokenStatus").html('<span style="color: #0088cc;">Validating bot token...</span>');
    
    try {
        const result = await window.electronAPI.validateTelegramBot(botToken);
        
        if (result.success) {
            $("#botTokenStatus").html(`<span style="color: #28a745;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">check_circle</i> Valid! Bot: ${result.botInfo.first_name} (@${result.botInfo.username})</span>`);
            showAlert("success", window.I18n?.t('settings.alerts.bot_validated', { name: result.botInfo.first_name }) || `Bot validated successfully: ${result.botInfo.first_name}`);
        } else {
            $("#botTokenStatus").html(`<span style="color: #dc3545;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">error</i> Invalid token: ${result.error}</span>`);
            showAlert("error", window.I18n?.t('settings.alerts.bot_validation_failed', { error: result.error }) || `Bot validation failed: ${result.error}`);
        }
    } catch (error) {
        $("#botTokenStatus").html(`<span style="color: #dc3545;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">error</i> Error: ${error.message}</span>`);
        showAlert("error", window.I18n?.t('settings.alerts.bot_token_validation_failed') || "Failed to validate bot token");
        console.error("Error validating bot:", error);
    } finally {
        btn.prop("disabled", false).html(originalHtml);
    }
});

// Show chat ID instructions
$("#showChatIdInstructions").click(async function () {
    try {
        const instructions = await window.electronAPI.getTelegramChatIdInstructions();
        
        const message = `
            <div style="text-align: left; line-height: 1.8;">
                <h3 style="margin-top: 0;">How to Get Your Chat ID</h3>
                <ol style="padding-left: 20px;">
                    <li>Start a chat with your bot by searching for it in Telegram</li>
                    <li>Send any message to your bot (e.g., "/start")</li>
                    <li>Open this URL in your browser (replace YOUR_BOT_TOKEN):
                        <br><code style="background: #f0f0f0; padding: 5px; display: block; margin: 5px 0; word-break: break-all;">https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates</code>
                    </li>
                    <li>Look for <strong>"chat":{"id":123456789}</strong></li>
                    <li>Copy the ID number (e.g., 123456789)</li>
                </ol>
                
                <h4>For Group Chats:</h4>
                <ul style="padding-left: 20px;">
                    <li>Add your bot to the group</li>
                    <li>Send a message in the group</li>
                    <li>Use the same URL above to get updates</li>
                    <li>Group chat IDs are negative (e.g., -100123456789)</li>
                </ul>
                
                <p style="margin-top: 15px; padding: 10px; background: #fff3cd; border-radius: 5px; border-left: 4px solid #ffc107;">
                    <strong>Tip:</strong> You can use the bot <strong>@userinfobot</strong> on Telegram to quickly get your chat ID. Just forward a message from yourself or your group to this bot.
                </p>
            </div>
        `;
        
        await newPrompt([{ type: "html", content: message }]);
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.instructions_load_failed') || "Failed to load instructions");
        console.error("Error getting chat ID instructions:", error);
    }
});

// Send test Telegram notification
$("#testTelegramNotification").click(async function () {
    const botToken = $("#telegramBotToken").val().trim();
    const chatId = $("#telegramChatId").val().trim();
    
    if (!botToken || !chatId) {
        showAlert("error", window.I18n?.t('settings.alerts.bot_token_chatid_required') || "Please enter both bot token and chat ID");
        return;
    }
    
    const btn = $(this);
    const originalHtml = btn.html();
    btn.prop("disabled", true).html('<i class="material-icons rotating">refresh</i><span>Sending...</span>');
    
    try {
        const result = await window.electronAPI.sendTelegramTest(botToken, chatId);
        
        if (result.success) {
            showAlert("success", window.I18n?.t('settings.alerts.test_message_sent') || "Test message sent successfully! Check your Telegram.");
        } else {
            showAlert("error", window.I18n?.t('settings.alerts.test_message_failed', { error: result.error }) || `Failed to send test message: ${result.error}`);
        }
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.send_test_failed') || "Failed to send test message");
        console.error("Error sending test message:", error);
    } finally {
        btn.prop("disabled", false).html(originalHtml);
    }
});

// Save Telegram settings
$("#saveTelegramSettings").click(async function () {
    const botToken = $("#telegramBotToken").val().trim();
    const chatId = $("#telegramChatId").val().trim();
    const enabled = $("#telegramEnabled").is(":checked");
    
    console.log('[Telegram Settings] Saving with enabled:', enabled);
    
    // Get notification type toggles
    const notifyCaptchaDetected = $("#notifyCaptchaDetected").is(":checked");
    const notifyWorkflowCompleted = $("#notifyWorkflowCompleted").is(":checked");
    const notifyWorkflowFailed = $("#notifyWorkflowFailed").is(":checked");
    const notifyCaptchaCleared = $("#notifyCaptchaCleared").is(":checked");
    
    // Validate inputs
    if (enabled && (!botToken || !chatId)) {
        showAlert("error", window.I18n?.t('settings.alerts.telegram_required_enabled') || "Bot token and chat ID are required when notifications are enabled");
        return;
    }
    
    try {
        // Check if this is a new setup (previously not enabled)
        const previousSettings = await window.electronAPI.readKey('telegramSettings');
        const isNewSetup = enabled && (!previousSettings || !previousSettings.enabled);
        
        const telegramSettings = {
            botToken: botToken,
            chatId: chatId,
            enabled: enabled,
            notifications: {
                captchaDetected: notifyCaptchaDetected,
                workflowCompleted: notifyWorkflowCompleted,
                workflowFailed: notifyWorkflowFailed,
                captchaCleared: notifyCaptchaCleared
            }
        };
        
        console.log('[Telegram Settings] Saving settings:', telegramSettings);
        await window.electronAPI.updateData("telegramSettings", telegramSettings);
        console.log('[Telegram Settings] Settings saved successfully');
        
        // Initialize the Telegram notification system with new settings
        if (enabled) {
            await window.electronAPI.initializeTelegramNotifications();
            
            // Send welcome message if this is a new setup
            if (isNewSetup) {
                const welcomeResult = await window.electronAPI.sendTelegramWelcome(botToken, chatId);
                if (welcomeResult.success) {
                    showAlert("success", window.I18n?.t('settings.alerts.telegram_welcome_sent') || "Telegram settings saved! Welcome message sent to your Telegram.");
                } else {
                    showAlert("success", window.I18n?.t('settings.alerts.telegram_saved_initialized') || "Telegram settings saved and initialized successfully");
                }
            } else {
                showAlert("success", window.I18n?.t('settings.alerts.telegram_saved_initialized') || "Telegram settings saved and initialized successfully");
            }
        } else {
            showAlert("success", window.I18n?.t('settings.alerts.telegram_saved') || "Telegram settings saved successfully");
        }
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.telegram_save_failed') || "Failed to save Telegram settings");
        console.error("Error saving Telegram settings:", error);
    }
});

// Load Telegram settings
async function loadTelegramSettings() {
    try {
        const settings = (await window.electronAPI.readKey('telegramSettings')) || {
            botToken: '',
            chatId: '',
            enabled: false,
            notifications: {
                captchaDetected: true,
                workflowCompleted: true,
                workflowFailed: true,
                captchaCleared: false
            }
        };
        
        $("#telegramBotToken").val(settings.botToken || '');
        $("#telegramChatId").val(settings.chatId || '');
        $("#telegramEnabled").prop("checked", settings.enabled || false);
        
        // Load notification type toggles
        const notifications = settings.notifications || {};
        $("#notifyCaptchaDetected").prop("checked", notifications.captchaDetected !== false);
        $("#notifyWorkflowCompleted").prop("checked", notifications.workflowCompleted !== false);
        $("#notifyWorkflowFailed").prop("checked", notifications.workflowFailed !== false);
        $("#notifyCaptchaCleared").prop("checked", notifications.captchaCleared || false);
        
        // Clear status
        $("#botTokenStatus").html('');
    } catch (error) {
        console.error("Error loading Telegram settings:", error);
        // Set defaults if error
        $("#telegramBotToken").val('');
        $("#telegramChatId").val('');
        $("#telegramEnabled").prop("checked", false);
        $("#notifyCaptchaDetected").prop("checked", true);
        $("#notifyWorkflowCompleted").prop("checked", true);
        $("#notifyWorkflowFailed").prop("checked", true);
        $("#notifyCaptchaCleared").prop("checked", false);
        $("#botTokenStatus").html('');
    }
}

// ============================================
// System Notifications Settings
// ============================================

// Send test system notification
$("#testSystemNotification").click(async function () {
    const btn = $(this);
    const originalHtml = btn.html();
    btn.prop("disabled", true).html('<i class="material-icons rotating">refresh</i><span>Sending...</span>');
    
    try {
        const result = await window.electronAPI.sendSystemNotificationTest();
        
        if (result.success) {
            showAlert("success", window.I18n?.t('settings.alerts.system_test_sent') || "Test notification sent! Check your desktop notifications.");
        } else {
            showAlert("error", window.I18n?.t('settings.alerts.system_test_failed', { error: result.error }) || `Failed to send test notification: ${result.error}`);
        }
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.system_test_error') || "Failed to send test notification");
        console.error("Error sending test notification:", error);
    } finally {
        btn.prop("disabled", false).html(originalHtml);
    }
});

// Save System Notification settings
$("#saveSystemNotificationSettings").click(async function () {
    const enabled = $("#systemNotificationsEnabled").is(":checked");
    const playSound = $("#systemNotificationsSound").is(":checked");
    
    // Get notification type toggles
    const captchaDetected = $("#sysNotifyCaptchaDetected").is(":checked");
    const workflowCompleted = $("#sysNotifyWorkflowCompleted").is(":checked");
    const workflowFailed = $("#sysNotifyWorkflowFailed").is(":checked");
    const captchaCleared = $("#sysNotifyCaptchaCleared").is(":checked");
    
    try {
        const systemNotificationSettings = {
            enabled: enabled,
            playSound: playSound,
            notifications: {
                captchaDetected: captchaDetected,
                workflowCompleted: workflowCompleted,
                workflowFailed: workflowFailed,
                captchaCleared: captchaCleared
            }
        };
        
        console.log('[System Notifications] Saving settings:', systemNotificationSettings);
        await window.electronAPI.updateData("systemNotificationSettings", systemNotificationSettings);
        console.log('[System Notifications] Settings saved successfully');
        
        // Initialize the system notification system with new settings
        if (enabled) {
            await window.electronAPI.initializeSystemNotifications();
        }
        
        showAlert("success", window.I18n?.t('settings.alerts.system_settings_saved') || "System notification settings saved successfully");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.system_settings_failed') || "Failed to save system notification settings");
        console.error("Error saving system notification settings:", error);
    }
});

// Load System Notification settings
async function loadSystemNotificationSettings() {
    try {
        const settings = (await window.electronAPI.readKey('systemNotificationSettings')) || {
            enabled: false,
            playSound: true,
            notifications: {
                captchaDetected: true,
                workflowCompleted: true,
                workflowFailed: true,
                captchaCleared: false
            }
        };
        
        $("#systemNotificationsEnabled").prop("checked", settings.enabled || false);
        $("#systemNotificationsSound").prop("checked", settings.playSound !== false);
        
        // Load notification type toggles
        const notifications = settings.notifications || {};
        $("#sysNotifyCaptchaDetected").prop("checked", notifications.captchaDetected !== false);
        $("#sysNotifyWorkflowCompleted").prop("checked", notifications.workflowCompleted !== false);
        $("#sysNotifyWorkflowFailed").prop("checked", notifications.workflowFailed !== false);
        $("#sysNotifyCaptchaCleared").prop("checked", notifications.captchaCleared || false);
    } catch (error) {
        console.error("Error loading system notification settings:", error);
        // Set defaults if error
        $("#systemNotificationsEnabled").prop("checked", false);
        $("#systemNotificationsSound").prop("checked", true);
        $("#sysNotifyCaptchaDetected").prop("checked", true);
        $("#sysNotifyWorkflowCompleted").prop("checked", true);
        $("#sysNotifyWorkflowFailed").prop("checked", true);
        $("#sysNotifyCaptchaCleared").prop("checked", false);
    }
}

// ============================================
// Combined Save All Notification Settings
// ============================================

$("#saveNotificationSettings").click(async function () {
    const btn = $(this);
    const originalHtml = btn.html();
    btn.prop("disabled", true).html('<i class="material-icons rotating">refresh</i><span>Saving...</span>');
    
    try {
        // Save Telegram settings
        const botToken = $("#telegramBotToken").val().trim();
        const chatId = $("#telegramChatId").val().trim();
        const telegramEnabled = $("#telegramEnabled").is(":checked");
        
        // Validate Telegram inputs if enabled
        if (telegramEnabled && (!botToken || !chatId)) {
            showAlert("error", window.I18n?.t('settings.alerts.telegram_required_enabled') || "Bot token and chat ID are required when Telegram notifications are enabled");
            btn.prop("disabled", false).html(originalHtml);
            return;
        }
        
        // Check if this is a new Telegram setup
        const previousTelegramSettings = await window.electronAPI.readKey('telegramSettings');
        const isNewTelegramSetup = telegramEnabled && (!previousTelegramSettings || !previousTelegramSettings.enabled);
        
        const telegramSettings = {
            botToken: botToken,
            chatId: chatId,
            enabled: telegramEnabled,
            notifications: {
                captchaDetected: $("#notifyCaptchaDetected").is(":checked"),
                workflowCompleted: $("#notifyWorkflowCompleted").is(":checked"),
                workflowFailed: $("#notifyWorkflowFailed").is(":checked"),
                captchaCleared: $("#notifyCaptchaCleared").is(":checked")
            }
        };
        
        await window.electronAPI.updateData("telegramSettings", telegramSettings);
        
        if (telegramEnabled) {
            await window.electronAPI.initializeTelegramNotifications();
            if (isNewTelegramSetup) {
                await window.electronAPI.sendTelegramWelcome(botToken, chatId);
            }
        }
        
        // Save System Notification settings
        const systemNotificationSettings = {
            enabled: $("#systemNotificationsEnabled").is(":checked"),
            playSound: $("#systemNotificationsSound").is(":checked"),
            notifications: {
                captchaDetected: $("#sysNotifyCaptchaDetected").is(":checked"),
                workflowCompleted: $("#sysNotifyWorkflowCompleted").is(":checked"),
                workflowFailed: $("#sysNotifyWorkflowFailed").is(":checked"),
                captchaCleared: $("#sysNotifyCaptchaCleared").is(":checked")
            }
        };
        
        await window.electronAPI.updateData("systemNotificationSettings", systemNotificationSettings);
        
        if (systemNotificationSettings.enabled) {
            await window.electronAPI.initializeSystemNotifications();
        }
        
        console.log('[Notifications] All settings saved successfully');
        showAlert("success", window.I18n?.t('settings.alerts.all_notifications_saved') || "All notification settings saved successfully");
    } catch (error) {
        showAlert("error", window.I18n?.t('settings.alerts.notifications_failed') || "Failed to save notification settings");
        console.error("Error saving notification settings:", error);
    } finally {
        btn.prop("disabled", false).html(originalHtml);
    }
});

// ============================================
// Language Settings
// ============================================

// Initialize language settings when section is shown
$(".menu-element[for='language-settings']").click(function () {
    initLanguageSettings();
});

async function initLanguageSettings() {
    try {
        // Get current language from I18n module
        const currentLocale = window.I18n ? window.I18n.getLocale() : 'en';
        
        // Set dropdown to current language
        $("#appLanguageSelect").val(currentLocale);
    } catch (error) {
        console.error('[Settings] Error loading language settings:', error);
    }
}

// Handle language selection change
$("#appLanguageSelect").change(async function () {
    const newLocale = $(this).val();
    const currentLocale = window.I18n ? window.I18n.getLocale() : 'en';
    
    // Skip if same language selected
    if (newLocale === currentLocale) {
        return;
    }
    
    const dropdown = $(this);
    
    try {
        // Check for running workflows/spy processes before proceeding
        const statusResult = await window.electronAPI.getAppCloseStatus();
        const warnings = statusResult?.warnings || [];
        
        // Check for active spy sessions in spyManager (frontend state)
        if (window.spyManager && window.spyManager.hasActiveSessions && window.spyManager.hasActiveSessions()) {
            const sessionCount = window.spyManager.sessions.size;
            const hasBackendSpy = warnings.some(w => w.type === 'spy');
            if (!hasBackendSpy) {
                warnings.push({ type: 'spy', count: sessionCount });
            }
        }
        
        // If there are active processes, show warning modal first
        if (warnings.length > 0) {
            showLanguageWarningModal(newLocale, warnings, currentLocale, dropdown);
            return;
        }
        
        // No active processes, proceed with language change
        await saveAndShowLanguageModal(newLocale, currentLocale, dropdown);
        
    } catch (error) {
        console.error('[Settings] Error checking status or saving language preference:', error);
        const errorMsg = window.I18n?.t('alerts.language_save_error') || 'Failed to save language preference';
        showAlert("error", errorMsg);
        dropdown.val(currentLocale);
    }
});

// Save language preference and show the restart modal
async function saveAndShowLanguageModal(newLocale, currentLocale, dropdown) {
    try {
        if (window.I18n) {
            await window.I18n.setLocale(newLocale);
        } else {
            await window.electronAPI.updateData('appLanguage', newLocale);
        }
        showLanguageChangeModal(newLocale);
    } catch (error) {
        console.error('[Settings] Error saving language preference:', error);
        const errorMsg = window.I18n?.t('alerts.language_save_error') || 'Failed to save language preference';
        showAlert("error", errorMsg);
        dropdown.val(currentLocale);
    }
}

// Show warning modal when there are active processes
function showLanguageWarningModal(newLocale, warnings, currentLocale, dropdown) {
    $('#languageWarningModal').remove();
    
    // Get language display name
    const languageNames = {
        'en': 'English',
        'fr': 'Français',
        'ar': 'العربية'
    };
    const newLanguageName = languageNames[newLocale] || newLocale;
    
    // Build warning items
    const warningItems = [];
    for (const warning of warnings) {
        if (warning.type === 'workflows') {
            const statusText = warning.status === 'running' 
                ? (window.I18n?.t('exit_warning.running_workflows') || `{{count}} running workflow(s)`)
                : (window.I18n?.t('exit_warning.queued_workflows') || `{{count}} queued workflow(s)`);
            warningItems.push(statusText.replace('{{count}}', warning.count));
        } else if (warning.type === 'spy') {
            const spyText = window.I18n?.t('exit_warning.active_spy') || `{{count}} active spy session(s)`;
            warningItems.push(spyText.replace('{{count}}', warning.count));
        }
    }
    
    // Get translated strings
    const title = window.I18n?.t('settings.language_warning_title') || 'Active Processes Detected';
    const subtitle = window.I18n?.t('settings.language_warning_subtitle') || 'Changing language requires restarting the application. The following processes are still active:';
    const newLangLabel = window.I18n?.t('settings.new_language') || 'New language';
    const cancelText = window.I18n?.t('common.cancel') || 'Cancel';
    const restartAnywayText = window.I18n?.t('settings.restart_anyway') || 'Restart Anyway';
    
    const warningListHtml = warningItems.map(item => `
        <li style="margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
            <span class="material-icons" style="color: #f59e0b; font-size: 18px;">warning</span>
            <span>${item}</span>
        </li>
    `).join('');
    
    const modalHtml = `
        <div class="modal fade" id="languageWarningModal" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content" style="border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); overflow: hidden;">
                    <div class="modal-header" style="border-bottom: 1px solid rgba(255,255,255,0.1); padding: 24px 28px;">
                        <div style="display: flex; align-items: center; gap: 14px;">
                            <div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); display: flex; align-items: center; justify-content: center;">
                                <span class="material-icons" style="color: white; font-size: 26px;">warning</span>
                            </div>
                            <h5 class="modal-title" style="margin: 0; font-weight: 600; font-size: 1.25rem;">${title}</h5>
                        </div>
                    </div>
                    <div class="modal-body" style="padding: 28px;">
                        <p style="margin-bottom: 16px; font-size: 1rem; line-height: 1.5;">${subtitle}</p>
                        <ul style="list-style: none; padding: 0; margin: 0 0 20px 0; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 12px; padding: 16px;">
                            ${warningListHtml}
                        </ul>
                        <div style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 16px; display: flex; align-items: center; gap: 12px;">
                            <span class="material-icons" style="color: #8b5cf6; font-size: 24px;">language</span>
                            <div>
                                <div style="font-size: 0.85rem; color: #6366f1;">${newLangLabel}</div>
                                <div style="font-weight: 600; font-size: 1.1rem; color: #4f46e5;">${newLanguageName}</div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer" style="border-top: 1px solid rgba(255,255,255,0.1); padding: 20px 28px; gap: 12px;">
                        <button type="button" class="btn btn-secondary" id="langWarningCancelBtn" style="border-radius: 10px; padding: 12px 24px; font-weight: 500;">
                            ${cancelText}
                        </button>
                        <button type="button" class="btn btn-danger" id="langWarningRestartBtn" style="border-radius: 10px; padding: 12px 24px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); border: none; font-weight: 500;">
                            <span class="material-icons" style="font-size: 18px; vertical-align: middle; margin-right: 6px;">refresh</span>
                            ${restartAnywayText}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    $('body').append(modalHtml);
    
    const modal = new bootstrap.Modal(document.getElementById('languageWarningModal'));
    modal.show();
    
    // Handle restart anyway button
    $('#langWarningRestartBtn').on('click', async function() {
        modal.hide();
        // Save the language and restart
        try {
            if (window.I18n) {
                await window.I18n.setLocale(newLocale);
            } else {
                await window.electronAPI.updateData('appLanguage', newLocale);
            }
            window.electronAPI.reloadApp();
        } catch (error) {
            console.error('[Settings] Error saving language:', error);
            showAlert("error", "Failed to change language");
        }
    });
    
    // Handle cancel button - revert dropdown
    $('#langWarningCancelBtn').on('click', function() {
        modal.hide();
        dropdown.val(currentLocale);
    });
    
    // Cleanup on modal hidden
    $('#languageWarningModal').on('hidden.bs.modal', function() {
        $(this).remove();
    });
}

// Show language change confirmation modal
function showLanguageChangeModal(newLocale) {
    // Remove existing modal if any
    $('#languageChangeModal').remove();
    
    // Get language display name
    const languageNames = {
        'en': 'English',
        'fr': 'Français',
        'ar': 'العربية'
    };
    const newLanguageName = languageNames[newLocale] || newLocale;
    
    // Get translated strings
    const title = window.I18n?.t('settings.language_change_title') || 'Language Changed';
    const message = window.I18n?.t('settings.language_change_message') || 'The application needs to restart to apply the new language.';
    const newLangLabel = window.I18n?.t('settings.new_language') || 'New language';
    const restartNowText = window.I18n?.t('settings.restart_now') || 'Restart Now';
    const restartLaterText = window.I18n?.t('settings.restart_later') || 'Restart Later';
    
    const modalHtml = `
        <div class="modal fade" id="languageChangeModal" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content" style="border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); overflow: hidden;">
                    <div class="modal-header" style="border-bottom: 1px solid rgba(255,255,255,0.1); padding: 24px 28px;">
                        <div style="display: flex; align-items: center; gap: 14px;">
                            <div style="width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); display: flex; align-items: center; justify-content: center;">
                                <span class="material-icons" style="color: white; font-size: 26px;">translate</span>
                            </div>
                            <h5 class="modal-title" style="margin: 0; font-weight: 600; font-size: 1.25rem;">${title}</h5>
                        </div>
                    </div>
                    <div class="modal-body" style="padding: 28px;">
                        <p style="margin-bottom: 20px; font-size: 1rem; line-height: 1.6;">${message}</p>
                        <div style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 16px; display: flex; align-items: center; gap: 12px;">
                            <span class="material-icons" style="color: #8b5cf6; font-size: 24px;">language</span>
                            <div>
                                <div style="font-size: 0.85rem; color: #6366f1;">${newLangLabel}</div>
                                <div style="font-weight: 600; font-size: 1.1rem; color: #4f46e5;">${newLanguageName}</div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer" style="border-top: 1px solid rgba(255,255,255,0.1); padding: 20px 28px; gap: 12px;">
                        <button type="button" class="btn btn-secondary" id="restartLaterBtn" style="border-radius: 10px; padding: 12px 24px; font-weight: 500;">
                            ${restartLaterText}
                        </button>
                        <button type="button" class="btn btn-primary" id="restartNowBtn" style="border-radius: 10px; padding: 12px 24px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); border: none; font-weight: 500;">
                            <span class="material-icons" style="font-size: 18px; vertical-align: middle; margin-right: 6px;">refresh</span>
                            ${restartNowText}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    $('body').append(modalHtml);
    
    const modal = new bootstrap.Modal(document.getElementById('languageChangeModal'));
    modal.show();
    
    // Handle restart now button
    $('#restartNowBtn').on('click', function() {
        modal.hide();
        // Reload the application
        window.electronAPI.reloadApp();
    });
    
    // Handle restart later button
    $('#restartLaterBtn').on('click', function() {
        modal.hide();
    });
    
    // Cleanup on modal hidden
    $('#languageChangeModal').on('hidden.bs.modal', function() {
        $(this).remove();
    });
}

// ============================================
// Appearance Settings
// ============================================

$(".menu-element[for='appearance-settings']").click(function () {
    initAppearanceSettings();
});

function initAppearanceSettings() {
    // Highlight current mode (light/dark)
    const currentMode = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    $(".appearance-mode-btn").css({ borderColor: "var(--vc-border-color-lighter)", background: "var(--vc-bg-elevated)" });
    $(`.appearance-mode-btn[data-mode="${currentMode}"]`).css({ borderColor: "var(--vc-brand-primary)", background: "var(--vc-brand-primary-bg)" });

    // Highlight current template
    const linkEl = document.getElementById("vc-template-override");
    let currentTemplate = "default";
    try {
        const cached = localStorage.getItem("vc.template");
        if (cached) currentTemplate = cached;
    } catch (e) { /* ignore */ }

    $(".template-card").css({ borderColor: "var(--vc-border-color-lighter)" });
    $(".template-card .template-check").css("display", "none");
    $(`.template-card[data-template="${currentTemplate}"]`).css({ borderColor: "var(--vc-brand-primary)" });
    $(`.template-card[data-template="${currentTemplate}"] .template-check`).css("display", "flex");
}

// Mode toggle (light/dark)
$(document).on("click", ".appearance-mode-btn", function () {
    const mode = $(this).data("mode");
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    if (mode === current) return;

    window.toggleTheme();

    $(".appearance-mode-btn").css({ borderColor: "var(--vc-border-color-lighter)", background: "var(--vc-bg-elevated)" });
    $(this).css({ borderColor: "var(--vc-brand-primary)", background: "var(--vc-brand-primary-bg)" });
});

// Template card selection
$(document).on("click", ".template-card", function () {
    const templateId = $(this).data("template");

    window.setTemplate(templateId);

    $(".template-card").css({ borderColor: "var(--vc-border-color-lighter)" });
    $(".template-card .template-check").css("display", "none");
    $(this).css({ borderColor: "var(--vc-brand-primary)" });
    $(this).find(".template-check").css("display", "flex");
});

// ============================================
// 2Captcha Settings
// ============================================

// Load 2Captcha settings when the section is shown
$(".menu-element[for='twocaptcha-connect']").click(function () {
    loadTwoCaptchaSettings();
});

// Toggle API key visibility
$("#toggleTwoCaptchaKeyVisibility").click(function () {
    const input = $("#twocaptchaApiKey");
    const icon = $(this).find("i");
    
    if (input.attr("type") === "password") {
        input.attr("type", "text");
        icon.text("visibility_off");
    } else {
        input.attr("type", "password");
        icon.text("visibility");
    }
});

// Test 2Captcha API key
$("#testTwoCaptcha").click(async function () {
    const apiKey = $("#twocaptchaApiKey").val().trim();
    const status = $("#twocaptchaStatus");
    
    if (!apiKey) {
        status.html('<span style="color: #dc3545;"><i class="material-icons" style="font-size: 14px; vertical-align: middle;">error</i> Please enter an API key</span>');
        return;
    }
    
    const btn = $(this);
    btn.prop('disabled', true);
    status.html('<span style="color: #0088cc;"><i class="material-icons" style="font-size: 14px; vertical-align: middle;">sync</i> Testing API key...</span>');
    
    try {
        const result = await window.electronAPI.testTwoCaptchaKey(apiKey);
        
        if (result.success) {
            status.html(`<span style="color: #28a745;"><i class="material-icons" style="font-size: 14px; vertical-align: middle;">check_circle</i> Valid! Balance: $${result.balance}</span>`);
            showAlert("success", window.I18n?.t('settings.alerts.twocaptcha_valid', { balance: result.balance }) || `API key is valid! Current balance: $${result.balance}`);
            
            // Show balance card and update values
            $("#twocaptchaBalanceCard").show();
            $("#twocaptchaBalance").text(`$${result.balance}`);
            // Estimate ~333 solves per dollar (at $2.99/1000)
            const estimatedSolves = Math.floor(parseFloat(result.balance) * 333);
            $("#twocaptchaEstimatedSolves").text(`~${estimatedSolves}`);
        } else {
            status.html(`<span style="color: #dc3545;"><i class="material-icons" style="font-size: 14px; vertical-align: middle;">error</i> ${result.error}</span>`);
            showAlert("error", window.I18n?.t('settings.alerts.twocaptcha_test_failed', { error: result.error }) || `API key test failed: ${result.error}`);
            $("#twocaptchaBalanceCard").hide();
        }
    } catch (error) {
        console.error("Error testing 2Captcha API:", error);
        status.html(`<span style="color: #dc3545;"><i class="material-icons" style="font-size: 14px; vertical-align: middle;">error</i> ${error.message}</span>`);
        showAlert("error", window.I18n?.t('settings.alerts.twocaptcha_error', { message: error.message }) || `API test failed: ${error.message}`);
    } finally {
        btn.prop('disabled', false);
    }
});

// Save 2Captcha settings
$("#saveTwoCaptchaSettings").click(async function () {
    const btn = $(this);
    btn.prop('disabled', true);
    
    try {
        const twocaptchaConfig = {
            enabled: $("#twocaptchaEnabled").prop("checked"),
            apiKey: $("#twocaptchaApiKey").val().trim()
        };
        
        // Validate required fields if enabled
        if (twocaptchaConfig.enabled && !twocaptchaConfig.apiKey) {
            showAlert("warning", window.I18n?.t('settings.alerts.twocaptcha_key_required') || "API key is required when 2Captcha is enabled");
            btn.prop('disabled', false);
            return;
        }
        
        await window.electronAPI.updateData('twocaptchaSettings', twocaptchaConfig);
        
        showAlert("success", window.I18n?.t('settings.alerts.twocaptcha_saved') || "2Captcha settings saved successfully");
        
        // Show/hide balance card based on enabled status
        if (twocaptchaConfig.enabled && twocaptchaConfig.apiKey) {
            // Fetch balance to show the card
            const result = await window.electronAPI.testTwoCaptchaKey(twocaptchaConfig.apiKey);
            if (result.success) {
                $("#twocaptchaBalanceCard").show();
                $("#twocaptchaBalance").text(`$${result.balance}`);
                const estimatedSolves = Math.floor(parseFloat(result.balance) * 333);
                $("#twocaptchaEstimatedSolves").text(`~${estimatedSolves}`);
            }
        } else {
            $("#twocaptchaBalanceCard").hide();
        }
    } catch (error) {
        console.error("Error saving 2Captcha settings:", error);
        showAlert("error", window.I18n?.t('settings.alerts.twocaptcha_save_failed', { message: error.message }) || "Failed to save 2Captcha settings: " + error.message);
    } finally {
        btn.prop('disabled', false);
    }
});

// Refresh 2Captcha balance
$("#refreshTwoCaptchaBalance").click(async function () {
    const btn = $(this);
    btn.prop('disabled', true);
    
    try {
        const apiKey = $("#twocaptchaApiKey").val().trim();
        if (!apiKey) {
            showAlert("error", window.I18n?.t('settings.alerts.no_api_key') || "No API key configured");
            return;
        }
        
        const result = await window.electronAPI.testTwoCaptchaKey(apiKey);
        
        if (result.success) {
            $("#twocaptchaBalance").text(`$${result.balance}`);
            const estimatedSolves = Math.floor(parseFloat(result.balance) * 333);
            $("#twocaptchaEstimatedSolves").text(`~${estimatedSolves}`);
            showAlert("success", window.I18n?.t('settings.alerts.balance_updated', { balance: result.balance }) || `Balance updated: $${result.balance}`);
        } else {
            showAlert("error", window.I18n?.t('settings.alerts.balance_refresh_failed', { error: result.error }) || `Failed to refresh balance: ${result.error}`);
        }
    } catch (error) {
        console.error("Error refreshing balance:", error);
        showAlert("error", window.I18n?.t('settings.alerts.balance_refresh_error', { message: error.message }) || "Failed to refresh balance: " + error.message);
    } finally {
        setTimeout(() => {
            btn.prop('disabled', false);
        }, 1000);
    }
});

// Load 2Captcha settings
async function loadTwoCaptchaSettings() {
    try {
        const settings = (await window.electronAPI.readKey('twocaptchaSettings')) || {
            apiKey: '',
            enabled: false
        };
        
        $("#twocaptchaApiKey").val(settings.apiKey || '');
        $("#twocaptchaEnabled").prop("checked", settings.enabled || false);
        $("#twocaptchaStatus").html('');
        
        // If enabled and has API key, show balance card
        if (settings.enabled && settings.apiKey) {
            try {
                const result = await window.electronAPI.testTwoCaptchaKey(settings.apiKey);
                if (result.success) {
                    $("#twocaptchaBalanceCard").show();
                    $("#twocaptchaBalance").text(`$${result.balance}`);
                    const estimatedSolves = Math.floor(parseFloat(result.balance) * 333);
                    $("#twocaptchaEstimatedSolves").text(`~${estimatedSolves}`);
                } else {
                    $("#twocaptchaBalanceCard").hide();
                }
            } catch (e) {
                $("#twocaptchaBalanceCard").hide();
            }
        } else {
            $("#twocaptchaBalanceCard").hide();
        }
    } catch (error) {
        console.error("Error loading 2Captcha settings:", error);
        $("#twocaptchaApiKey").val('');
        $("#twocaptchaEnabled").prop("checked", false);
        $("#twocaptchaStatus").html('');
        $("#twocaptchaBalanceCard").hide();
    }
}

// =====================================================
// IPRegistry Integration
// =====================================================

// Load IPRegistry settings when section is opened
$(".menu-element[for='ipregistry-connect']").click(function () {
    loadIpregistrySettings();
});

// =====================================================
// VCBrowser Settings
// =====================================================

// Load VCBrowser settings when section is opened
$(".menu-element[for='vcbrowser-settings']").click(function () {
    checkVCBrowserInstallation();
});

// Check VCBrowser installation status
async function checkVCBrowserInstallation() {
    try {
        const result = await window.electronAPI.checkVCBrowser();
        
        if (result.installed) {
            // VCBrowser is installed
            $("#vcbrowser-status-icon").css('background', 'linear-gradient(135deg, #10b981 0%, #34d399 100%)');
            $("#vcbrowser-status-icon i").text('check_circle');
            $("#vcbrowser-status-text").text('VCBrowser is installed and ready');
            $("#vcbrowser-not-installed").hide();
            $("#vcbrowser-installed").show();
            $("#vcbrowser-path").text(result.path || 'Unknown path');
        } else {
            // VCBrowser is not installed
            $("#vcbrowser-status-icon").css('background', 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)');
            $("#vcbrowser-status-icon i").text('download');
            $("#vcbrowser-status-text").text('VCBrowser is not installed');
            $("#vcbrowser-not-installed").show();
            $("#vcbrowser-installed").hide();
        }
    } catch (error) {
        console.error('Error checking VCBrowser:', error);
        $("#vcbrowser-status-text").text('Error checking installation');
    }
}

// Download VCBrowser
async function downloadVCBrowser() {
    const btn = $("#download-vcbrowser-btn");
    const progressDiv = $("#vcbrowser-download-progress");
    const progressBar = $("#vcbrowser-progress-bar");
    const progressText = $("#vcbrowser-progress-text");
    
    btn.prop('disabled', true).hide();
    progressDiv.show();
    progressBar.css('width', '0%');
    progressText.text('Starting download...');
    
    // Listen for progress updates
    window.electronAPI.onVCBrowserDownloadProgress((data) => {
        if (data.stage === 'downloading') {
            progressText.text(`Downloading... ${data.percent}%`);
            progressBar.css('width', `${data.percent}%`);
        } else if (data.stage === 'extracting') {
            progressText.text('Extracting...');
            progressBar.css('width', '100%');
        }
    });
    
    try {
        const result = await window.electronAPI.downloadVCBrowser();
        
        if (result.success) {
            showAlert('success', window.I18n?.t('settings.alerts.vcbrowser_installed') || 'VCBrowser installed successfully!');
            checkVCBrowserInstallation();
        } else {
            showAlert('error', result.error || window.I18n?.t('settings.alerts.vcbrowser_download_failed') || 'Failed to download VCBrowser');
            progressDiv.hide();
            btn.show().prop('disabled', false);
        }
    } catch (error) {
        console.error('Error downloading VCBrowser:', error);
        showAlert('error', window.I18n?.t('settings.alerts.vcbrowser_download_error', { message: error.message }) || 'Failed to download VCBrowser: ' + error.message);
        progressDiv.hide();
        btn.show().prop('disabled', false);
    } finally {
        window.electronAPI.removeVCBrowserDownloadProgressListener();
    }
}

// Download button click handler
$("#download-vcbrowser-btn").click(function() {
    downloadVCBrowser();
});

// Toggle API key visibility
$("#toggleIpregistryKeyVisibility").click(function () {
    const input = $("#ipregistryApiKey");
    const icon = $(this).find("i");
    if (input.attr("type") === "password") {
        input.attr("type", "text");
        icon.text("visibility_off");
    } else {
        input.attr("type", "password");
        icon.text("visibility");
    }
});

// Test IPRegistry API key
$("#testIpregistry").click(async function () {
    const apiKey = $("#ipregistryApiKey").val().trim();
    const status = $("#ipregistryStatus");
    
    if (!apiKey) {
        status.html('<span style="color: #dc3545;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">error</i> Please enter an API key first</span>');
        return;
    }
    
    status.html('<span style="color: #6366f1;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">hourglass_empty</i> Testing API key...</span>');
    
    try {
        const result = await window.electronAPI.testIpregistryKey(apiKey);
        
        if (result.success) {
            status.html(`<span style="color: #28a745;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">check_circle</i> API key is valid! Your IP: ${result.ip} (${result.country})</span>`);
            
            // Show usage card with credits remaining
            $("#ipregistryUsageCard").show();
            $("#ipregistryCreditsRemaining").text(result.creditsRemaining ? parseInt(result.creditsRemaining).toLocaleString() : '-');
        } else {
            status.html(`<span style="color: #dc3545;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">error</i> ${result.error || 'Invalid API key'}</span>`);
            $("#ipregistryUsageCard").hide();
        }
    } catch (error) {
        console.error("Error testing IPRegistry key:", error);
        status.html(`<span style="color: #dc3545;"><i class="material-icons" style="font-size: 16px; vertical-align: middle;">error</i> Error: ${error.message}</span>`);
        $("#ipregistryUsageCard").hide();
    }
});

// Save IPRegistry settings
$("#saveIpregistrySettings").click(async function () {
    const btn = $(this);
    btn.prop('disabled', true);
    
    try {
        const ipregistryConfig = {
            enabled: $("#ipregistryEnabled").prop("checked"),
            apiKey: $("#ipregistryApiKey").val().trim()
        };
        
        // Validate required fields if enabled
        if (ipregistryConfig.enabled && !ipregistryConfig.apiKey) {
            showAlert("warning", window.I18n?.t('settings.alerts.ipregistry_key_required') || "API key is required when IPRegistry is enabled");
            btn.prop('disabled', false);
            return;
        }
        
        await window.electronAPI.updateData('ipregistrySettings', ipregistryConfig);
        
        showAlert("success", window.I18n?.t('settings.alerts.ipregistry_saved') || "IPRegistry settings saved successfully");
        
        // Show/hide usage card based on enabled status
        if (ipregistryConfig.enabled && ipregistryConfig.apiKey) {
            // Fetch usage to show the card
            const result = await window.electronAPI.testIpregistryKey(ipregistryConfig.apiKey);
            if (result.success) {
                $("#ipregistryUsageCard").show();
                $("#ipregistryCreditsRemaining").text(result.creditsRemaining ? parseInt(result.creditsRemaining).toLocaleString() : '-');
            }
        } else {
            $("#ipregistryUsageCard").hide();
        }
    } catch (error) {
        console.error("Error saving IPRegistry settings:", error);
        showAlert("error", window.I18n?.t('settings.alerts.ipregistry_save_failed', { message: error.message }) || "Failed to save IPRegistry settings: " + error.message);
    } finally {
        btn.prop('disabled', false);
    }
});

// Refresh IPRegistry usage
$("#refreshIpregistryUsage").click(async function () {
    const btn = $(this);
    btn.prop('disabled', true);
    
    try {
        const apiKey = $("#ipregistryApiKey").val().trim();
        if (!apiKey) {
            showAlert("error", window.I18n?.t('settings.alerts.no_api_key') || "No API key configured");
            return;
        }
        
        const result = await window.electronAPI.testIpregistryKey(apiKey);
        
        if (result.success) {
            $("#ipregistryCreditsRemaining").text(result.creditsRemaining ? parseInt(result.creditsRemaining).toLocaleString() : '-');
            showAlert("success", window.I18n?.t('settings.alerts.credits_remaining', { credits: result.creditsRemaining ? parseInt(result.creditsRemaining).toLocaleString() : '-' }) || `Credits remaining: ${result.creditsRemaining ? parseInt(result.creditsRemaining).toLocaleString() : '-'}`);
        } else {
            showAlert("error", window.I18n?.t('settings.alerts.ipregistry_refresh_failed', { error: result.error || window.I18n?.t('common.unknown_error') || 'Unknown error' }) || `Failed to refresh usage: ${result.error || 'Unknown error'}`);
        }
    } catch (error) {
        console.error("Error refreshing usage:", error);
        showAlert("error", window.I18n?.t('settings.alerts.ipregistry_refresh_error', { message: error.message }) || "Failed to refresh usage: " + error.message);
    } finally {
        setTimeout(() => {
            btn.prop('disabled', false);
        }, 1000);
    }
});

// Load IPRegistry settings
async function loadIpregistrySettings() {
    try {
        const settings = (await window.electronAPI.readKey('ipregistrySettings')) || {
            apiKey: '',
            enabled: false
        };
        
        $("#ipregistryApiKey").val(settings.apiKey || '');
        $("#ipregistryEnabled").prop("checked", settings.enabled || false);
        $("#ipregistryStatus").html('');
        
        // If enabled and has API key, show usage card
        if (settings.enabled && settings.apiKey) {
            try {
                const result = await window.electronAPI.testIpregistryKey(settings.apiKey);
                if (result.success) {
                    $("#ipregistryUsageCard").show();
                    $("#ipregistryCreditsRemaining").text(result.creditsRemaining ? parseInt(result.creditsRemaining).toLocaleString() : '-');
                } else {
                    $("#ipregistryUsageCard").hide();
                }
            } catch (e) {
                $("#ipregistryUsageCard").hide();
            }
        } else {
            $("#ipregistryUsageCard").hide();
        }
    } catch (error) {
        console.error("Error loading IPRegistry settings:", error);
        $("#ipregistryApiKey").val('');
        $("#ipregistryEnabled").prop("checked", false);
        $("#ipregistryStatus").html('');
        $("#ipregistryUsageCard").hide();
    }
}

// ============================================
// MiniCanvas Preview Settings
// ============================================

// Store preview images paths (use var to allow redeclaration on page reload)
var minicanvasPreviewImages = [null, null, null, null];

// Load MiniCanvas preview settings
async function loadMinicanvasPreviewSettings() {
    try {
        const settings = (await window.electronAPI.readKey('minicanvasPreviewSettings')) || {
            images: [],
            text1: '',
            text2: '',
            text3: '',
            text4: ''
        };
        
        // Load images
        minicanvasPreviewImages = settings.images || [null, null, null, null];
        updatePreviewImageSlots();
        
        // Load text values
        $("#preview-text-1").val(settings.text1 || '');
        $("#preview-text-2").val(settings.text2 || '');
        $("#preview-text-3").val(settings.text3 || '');
        $("#preview-text-4").val(settings.text4 || '');
    } catch (error) {
        console.error("Error loading MiniCanvas preview settings:", error);
    }
}

// Update the preview image slot UI
function updatePreviewImageSlots() {
    for (let i = 0; i < 4; i++) {
        const slot = $(`.preview-image-slot[data-index="${i}"]`);
        const imagePath = minicanvasPreviewImages[i];
        
        if (imagePath) {
            slot.html(`
                <img src="${imagePath}" style="width: 100%; height: 100%; object-fit: cover;">
                <button class="remove-preview-image" data-index="${i}" style="position: absolute; top: 5px; right: 5px; background: rgba(220, 53, 69, 0.9); border: none; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer;">
                    <i class="material-icons" style="font-size: 16px; color: white;">close</i>
                </button>
            `);
            slot.css('border', '2px solid #8b5cf6');
        } else {
            slot.html(`
                <i class="material-icons" style="font-size: 32px; color: #aaa;">add_photo_alternate</i>
                <span style="font-size: 12px; color: #888; margin-top: 5px;">Image ${i + 1}</span>
            `);
            slot.css('border', '2px dashed #ddd');
        }
    }
}

// Click on image slot to select image
$('#settings-section').on('click', '.preview-image-slot', async function (e) {
    // Don't trigger if clicking the remove button
    if ($(e.target).closest('.remove-preview-image').length) return;
    
    const index = parseInt($(this).attr('data-index'));
    const result = await window.electronAPI.selectPreviewImage();
    
    if (result && result.success && result.path) {
        minicanvasPreviewImages[index] = result.path;
        updatePreviewImageSlots();
    }
});

// Remove single image
$('#settings-section').on('click', '.remove-preview-image', function (e) {
    e.stopPropagation();
    const index = parseInt($(this).attr('data-index'));
    minicanvasPreviewImages[index] = null;
    updatePreviewImageSlots();
});

// Clear all preview images
$('#clear-preview-images').click(function () {
    minicanvasPreviewImages = [null, null, null, null];
    updatePreviewImageSlots();
});

// Save preview settings
$('#save-preview-settings').click(async function () {
    const btn = $(this);
    btn.prop('disabled', true);
    
    try {
        const settings = {
            images: minicanvasPreviewImages,
            text1: $("#preview-text-1").val().trim(),
            text2: $("#preview-text-2").val().trim(),
            text3: $("#preview-text-3").val().trim(),
            text4: $("#preview-text-4").val().trim()
        };
        
        await window.electronAPI.updateData('minicanvasPreviewSettings', settings);
        showAlert("success", window.I18n?.t('settings.alerts.minicanvas_saved') || "MiniCanvas preview settings saved successfully");
    } catch (error) {
        console.error("Error saving MiniCanvas preview settings:", error);
        showAlert("error", window.I18n?.t('settings.alerts.minicanvas_save_failed', { message: error.message }) || "Failed to save settings: " + error.message);
    } finally {
        btn.prop('disabled', false);
    }
});

// Reset to defaults
$('#reset-preview-settings').click(async function () {
    const confirmed = await confirmPrompt("Reset all preview settings to defaults?");
    if (!confirmed) return;
    
    minicanvasPreviewImages = [null, null, null, null];
    updatePreviewImageSlots();
    
    $("#preview-text-1").val('');
    $("#preview-text-2").val('');
    $("#preview-text-3").val('');
    $("#preview-text-4").val('');
    
    // Clear from storage
    await window.electronAPI.updateData('minicanvasPreviewSettings', {
        images: [],
        text1: '',
        text2: '',
        text3: '',
        text4: ''
    });
    
    showAlert("success", window.I18n?.t('settings.alerts.minicanvas_reset') || "Preview settings reset to defaults");
});

// Load settings when page loads
loadMinicanvasPreviewSettings();

// ===================== SPY SETTINGS =====================

// Load spy settings when section is shown
$(".menu-element[for='spy-settings']").click(function () {
    loadSpySettings();
    loadFeedSpySettings();
});

async function loadSpySettings() {
    try {
        const settings = await window.electronAPI.readKey("spySettings") || {};
        
        // Viral growth enabled (default: true)
        const enableViralGrowth = settings.enableViralGrowth !== false;
        $("#enableViralGrowth").prop("checked", enableViralGrowth);
        
        // Viral growth threshold (default: 10%)
        const threshold = settings.viralGrowthThreshold || 10;
        $("#viralGrowthThreshold").val(threshold);
        
        // Toggle threshold visibility based on enabled state
        updateViralGrowthThresholdVisibility();
    } catch (error) {
        console.error("Error loading spy settings:", error);
    }
}

function updateViralGrowthThresholdVisibility() {
    const enabled = $("#enableViralGrowth").is(":checked");
    if (enabled) {
        $("#viralGrowthThresholdGroup").slideDown(200);
    } else {
        $("#viralGrowthThresholdGroup").slideUp(200);
    }
}

// Toggle threshold visibility when checkbox changes
$(document).on("change", "#enableViralGrowth", function() {
    updateViralGrowthThresholdVisibility();
});

// Save spy settings
$("#saveSpySettings").click(async function () {
    const enableViralGrowth = $("#enableViralGrowth").is(":checked");
    const viralGrowthThreshold = parseInt($("#viralGrowthThreshold").val());

    // Validate
    if (enableViralGrowth && (isNaN(viralGrowthThreshold) || viralGrowthThreshold < 1 || viralGrowthThreshold > 100)) {
        showAlert("error", window.I18n?.t('settings.alerts.viral_threshold_range') || "Viral growth threshold must be between 1 and 100%");
        return;
    }

    try {
        await window.electronAPI.updateData("spySettings", {
            enableViralGrowth,
            viralGrowthThreshold: viralGrowthThreshold || 10
        });
        showAlert("success", window.I18n?.t('settings.alerts.spy_settings_saved') || "Spy settings saved successfully");
    } catch (error) {
        console.error("Error saving spy settings:", error);
        showAlert("error", window.I18n?.t('settings.alerts.spy_settings_failed') || "Failed to save spy settings");
    }
});

// Reset spy settings to defaults
$("#resetSpySettings").click(async function () {
    try {
        await window.electronAPI.updateData("spySettings", {
            enableViralGrowth: true,
            viralGrowthThreshold: 10
        });
        loadSpySettings();
        showAlert("success", window.I18n?.t('settings.alerts.spy_settings_reset') || "Spy settings reset to defaults");
    } catch (error) {
        console.error("Error resetting spy settings:", error);
        showAlert("error", window.I18n?.t('settings.alerts.spy_settings_reset_failed') || "Failed to reset spy settings");
    }
});

// ===================== FEEDSPY SETTINGS (Multi-Account) =====================

// Load and render FeedSpy accounts list
async function loadFeedSpySettings() {
    try {
        let accounts = await window.electronAPI.readKey("feedspyAccounts");

        // Migrate from old single-account format if needed
        if (!accounts || !Array.isArray(accounts)) {
            const oldSettings = await window.electronAPI.readKey("feedspySettings");
            if (oldSettings && oldSettings.email) {
                accounts = [{
                    id: Date.now().toString(),
                    email: oldSettings.email,
                    password: oldSettings.password,
                    session: oldSettings.session || null,
                    enabled: !!oldSettings.enabled,
                }];
                await window.electronAPI.updateData("feedspyAccounts", accounts);
            } else {
                accounts = [];
            }
        }

        renderFeedSpyAccounts(accounts);
    } catch (error) {
        console.error("Error loading FeedSpy settings:", error);
    }
}

function renderFeedSpyAccounts(accounts) {
    const $list = $("#feedspyAccountsList");
    if (!accounts || accounts.length === 0) {
        $list.html(
            '<p style="color: var(--text-secondary, #6c757d); font-size: 13px; margin: 0;">' +
            (window.I18n?.t('settings.spy_settings.feedspy_no_accounts') || 'No accounts added yet. Add a FeedSpy account to get started.') +
            '</p>'
        );
        return;
    }

    let html = '';
    accounts.forEach((acct, idx) => {
        const statusIcon = acct.session && acct.enabled
            ? '<i class="material-icons" style="font-size: 14px; vertical-align: middle; color: #28a745;">check_circle</i>'
            : acct.enabled
                ? '<i class="material-icons" style="font-size: 14px; vertical-align: middle; color: #ffc107;">warning</i>'
                : '<i class="material-icons" style="font-size: 14px; vertical-align: middle; color: #6c757d;">pause_circle</i>';
        const statusText = acct.session && acct.enabled
            ? (window.I18n?.t('settings.spy_settings.feedspy_connected') || 'Connected')
            : acct.enabled
                ? (window.I18n?.t('settings.spy_settings.feedspy_no_session') || 'Not tested')
                : (window.I18n?.t('settings.spy_settings.feedspy_disabled') || 'Disabled');

        html += `<div class="feedspy-account-row" data-account-id="${acct.id}" style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--bg-secondary, #f8f9fa); border-radius: 8px; border: 1px solid var(--border-color, #dee2e6); margin-bottom: 8px;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${$('<span>').text(acct.email).html()}</div>
                <div style="font-size: 12px; color: var(--text-secondary, #6c757d); margin-top: 2px;">${statusIcon} ${statusText}</div>
            </div>
            <label class="toggle-switch" style="margin: 0; flex-shrink: 0;">
                <input type="checkbox" class="feedspy-account-toggle" data-id="${acct.id}" ${acct.enabled ? 'checked' : ''}>
                <span class="slider"></span>
            </label>
            <button class="btn-one feedspy-test-account" data-id="${acct.id}" style="background-color: #4a6cf7; min-width: 36px; padding: 6px 8px;" title="${window.I18n?.t('settings.spy_settings.feedspy_test') || 'Test Connection'}">
                <i class="material-icons" style="font-size: 16px;">wifi_tethering</i>
            </button>
            <button class="btn-one feedspy-remove-account" data-id="${acct.id}" style="background-color: #dc3545; min-width: 36px; padding: 6px 8px;" title="${window.I18n?.t('settings.spy_settings.feedspy_remove') || 'Remove'}">
                <i class="material-icons" style="font-size: 16px;">delete</i>
            </button>
        </div>`;
    });

    $list.html(html);
}

// Toggle account enabled/disabled
$(document).on("change", ".feedspy-account-toggle", async function () {
    const id = $(this).data("id");
    const enabled = $(this).prop("checked");
    try {
        const accounts = await window.electronAPI.readKey("feedspyAccounts") || [];
        const acct = accounts.find(a => a.id === String(id) || a.id === id);
        if (acct) {
            acct.enabled = enabled;
            await window.electronAPI.updateData("feedspyAccounts", accounts);
            renderFeedSpyAccounts(accounts);
        }
    } catch (error) {
        console.error("Error toggling FeedSpy account:", error);
    }
});

// Remove account
$(document).on("click", ".feedspy-remove-account", async function () {
    const id = $(this).data("id");
    try {
        let accounts = await window.electronAPI.readKey("feedspyAccounts") || [];
        accounts = accounts.filter(a => a.id !== String(id) && a.id !== id);
        await window.electronAPI.updateData("feedspyAccounts", accounts);
        renderFeedSpyAccounts(accounts);
        showAlert("success", window.I18n?.t('settings.alerts.feedspy_account_removed') || "Account removed");
    } catch (error) {
        console.error("Error removing FeedSpy account:", error);
    }
});

// Test individual account
$(document).on("click", ".feedspy-test-account", async function () {
    const btn = $(this);
    const id = btn.data("id");
    btn.prop("disabled", true);
    try {
        const accounts = await window.electronAPI.readKey("feedspyAccounts") || [];
        const acct = accounts.find(a => a.id === String(id) || a.id === id);
        if (!acct) return;

        const result = await window.electronAPI.testFeedSpyLogin(acct.email, acct.password);
        if (result.success) {
            acct.session = result.session;
            acct.enabled = true;
            await window.electronAPI.updateData("feedspyAccounts", accounts);
            renderFeedSpyAccounts(accounts);
            showAlert("success", window.I18n?.t('settings.alerts.feedspy_valid') || "FeedSpy connection successful!");
        } else {
            acct.session = null;
            await window.electronAPI.updateData("feedspyAccounts", accounts);
            renderFeedSpyAccounts(accounts);
            showAlert("error", result.error || (window.I18n?.t('settings.alerts.feedspy_invalid') || "FeedSpy connection failed"));
        }
    } catch (error) {
        console.error("FeedSpy test error:", error);
    } finally {
        btn.prop("disabled", false);
    }
});

// Show add account form
$(document).on("click", "#feedspyShowAddForm", function () {
    $("#feedspyAddForm").show();
    $("#feedspyNewEmail").val("");
    $("#feedspyNewPassword").val("");
    $("#feedspyAddStatus").html("");
    $(this).hide();
});

// Cancel add form
$(document).on("click", "#feedspyCancelAdd", function () {
    $("#feedspyAddForm").hide();
    $("#feedspyShowAddForm").show();
});

// Password visibility toggle for add form
$(document).on("click", "#toggleFeedSpyNewPasswordVisibility", function () {
    const input = $("#feedspyNewPassword");
    const icon = $(this).find("i");
    if (input.attr("type") === "password") {
        input.attr("type", "text");
        icon.text("visibility_off");
    } else {
        input.attr("type", "password");
        icon.text("visibility");
    }
});

// Confirm add account (test + save)
$(document).on("click", "#feedspyConfirmAdd", async function () {
    const btn = $(this);
    const email = $("#feedspyNewEmail").val().trim();
    const password = $("#feedspyNewPassword").val().trim();

    if (!email || !password) {
        $("#feedspyAddStatus").html('<span style="color: #dc3545;">' +
            (window.I18n?.t('settings.alerts.feedspy_credentials_required') || 'Email and password are required') + '</span>');
        return;
    }

    btn.prop("disabled", true);
    $("#feedspyAddStatus").html('<span style="color: #6c757d;">' +
        (window.I18n?.t('settings.spy_settings.feedspy_testing') || 'Testing connection...') + '</span>');

    try {
        // Check for duplicate email
        const accounts = await window.electronAPI.readKey("feedspyAccounts") || [];
        if (accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) {
            $("#feedspyAddStatus").html('<span style="color: #dc3545;">' +
                (window.I18n?.t('settings.alerts.feedspy_duplicate') || 'This email is already added') + '</span>');
            btn.prop("disabled", false);
            return;
        }

        const result = await window.electronAPI.testFeedSpyLogin(email, password);
        if (result.success) {
            accounts.push({
                id: Date.now().toString(),
                email,
                password,
                session: result.session,
                enabled: true,
            });
            await window.electronAPI.updateData("feedspyAccounts", accounts);
            renderFeedSpyAccounts(accounts);
            $("#feedspyAddForm").hide();
            $("#feedspyShowAddForm").show();
            showAlert("success", window.I18n?.t('settings.alerts.feedspy_account_added') || "Account added successfully!");
        } else {
            $("#feedspyAddStatus").html('<span style="color: #dc3545;">' +
                (result.error || (window.I18n?.t('settings.alerts.feedspy_invalid') || 'Connection failed')) + '</span>');
        }
    } catch (error) {
        console.error("FeedSpy add error:", error);
        $("#feedspyAddStatus").html('<span style="color: #dc3545;">Connection error</span>');
    } finally {
        btn.prop("disabled", false);
    }
});

// ============================================
// Storage Settings
// ============================================

// Load storage settings when section is shown
$(".menu-element[for='storage-settings']").click(function () {
    loadStorageSettings();
    loadStorageStats();
});

async function loadStorageSettings() {
    try {
        const retentionDays = await window.electronAPI.readKey("tempFileRetentionDays");
        if (retentionDays) {
            $("#tempFileRetentionDays").val(retentionDays);
        }
    } catch (error) {
        console.error("[Settings] Error loading storage settings:", error);
    }
}

async function loadStorageStats() {
    try {
        $("#tempFilesCount").text("Loading...");
        $("#orphanedImagesCount").text("Loading...");
        $("#totalCleanableSize").text("Loading...");
        
        const status = await window.electronAPI.getCleanupStatus();
        
        if (status) {
            const tempCount = status.tempUploads?.count || 0;
            const tempSize = status.tempUploads?.formattedSize || "0 B";
            const orphanedCount = status.unreferencedImages?.count || 0;
            const orphanedSize = status.unreferencedImages?.formattedSize || "0 B";
            const totalSize = status.totalFormattedSize || "0 B";
            
            $("#tempFilesCount").text(`${tempCount} files (${tempSize})`);
            $("#orphanedImagesCount").text(`${orphanedCount} files (${orphanedSize})`);
            $("#totalCleanableSize").text(totalSize);
        }
    } catch (error) {
        console.error("[Settings] Error loading storage stats:", error);
        $("#tempFilesCount").text("Error");
        $("#orphanedImagesCount").text("Error");
        $("#totalCleanableSize").text("Error");
    }
}

// Handle retention period change
$("#tempFileRetentionDays").change(async function () {
    const retentionDays = parseInt($(this).val());
    
    try {
        await window.electronAPI.updateData("tempFileRetentionDays", retentionDays);
        const message = window.I18n?.t("settings.storage.retention_saved") || `Retention period set to ${retentionDays} days`;
        showAlert("success", message);
    } catch (error) {
        console.error("[Settings] Error saving retention period:", error);
        showAlert("error", window.I18n?.t('settings.alerts.retention_save_failed') || "Failed to save retention period");
    }
});

// Refresh storage stats
$("#refreshStorageStats").click(function () {
    loadStorageStats();
});

// Run manual cleanup
$("#runManualCleanup").click(async function () {
    const $btn = $(this);
    const originalText = $btn.html();
    
    // Confirm with user
    const confirmMsg = window.I18n?.t("settings.storage.cleanup_confirm") || "This will delete old temporary files and orphaned images. Continue?";
    const confirmed = await confirmPrompt(confirmMsg);
    if (!confirmed) {
        return;
    }
    
    try {
        $btn.prop("disabled", true).html('<i class="material-icons" style="font-size: 18px; vertical-align: middle;">hourglass_empty</i> Cleaning...');
        
        const result = await window.electronAPI.runCleanup();
        
        if (result && result.success !== false) {
            const totalRemoved = (result.profiles?.removed?.length || 0) + 
                                 (result.images?.removed?.length || 0) + 
                                 (result.tempUploads?.removed?.length || 0);
            const totalSize = result.totalFormattedSize || "0 B";
            
            const successMsg = window.I18n?.t("settings.storage.cleanup_success", { count: totalRemoved, size: totalSize }) || 
                              `Cleanup complete! Removed ${totalRemoved} items (${totalSize})`;
            showAlert("success", successMsg);
            
            // Refresh stats
            loadStorageStats();
        } else {
            showAlert("error", result?.error || window.I18n?.t('settings.alerts.cleanup_failed') || "Cleanup failed");
        }
    } catch (error) {
        console.error("[Settings] Error running cleanup:", error);
        showAlert("error", window.I18n?.t('settings.alerts.cleanup_error', { message: error.message }) || "Failed to run cleanup: " + error.message);
    } finally {
        $btn.prop("disabled", false).html(originalText);
    }
});


// ===================== PINTEREST COLLECTION SETTINGS =====================

var _pinterestStatusInterval = _pinterestStatusInterval || null;

// ===================== ACCOUNT TABLE =====================

async function loadPinterestAccountsTable() {
    const wrap = $("#pinterestAccountTable");
    wrap.html('<div class="pc-account-empty">Loading…</div>');
    try {
        const res = await window.electronAPI.getPinterestAccountsStatus();
        if (!res.success || !res.data) {
            wrap.html('<div class="pc-account-empty">Failed to load accounts.</div>');
            return;
        }
        const accounts = res.data;
        const settings = (await window.electronAPI.getPinterestCollectionSettings()).data || {};
        const savedSelected = settings.selectedAccounts || null; // null = all

        if (accounts.length === 0) {
            wrap.html('<div class="pc-account-empty">No Pinterest accounts found. Link accounts in Pinterest Accounts settings.</div>');
            return;
        }

        let html = '<table class="pc-account-table"><thead><tr>' +
            '<th style="width:36px;"></th>' +
            '<th>Account</th>' +
            '<th>Last Collected</th>' +
            '<th>Status</th>' +
            '</tr></thead><tbody>';

        accounts.forEach(acct => {
            const isLinked = acct.isLinked;
            const isChecked = !savedSelected || savedSelected.includes(acct.accountId);
            const lastFetch = acct.lastFetch ? pcRelativeTime(acct.lastFetch.fetched_at) : 'Never';
            const statusHtml = isLinked
                ? '<span class="pc-account-status-linked"><i class="material-icons" style="font-size:14px;vertical-align:-3px;">link</i> Linked</span>'
                : '<span class="pc-account-status-unlinked"><i class="material-icons" style="font-size:14px;vertical-align:-3px;">link_off</i> Not linked</span>';
            const emailHtml = acct.email
                ? `<div class="pc-account-email">${acct.email}</div>`
                : '';

            html += `<tr class="pc-account-row ${!isLinked ? 'pc-row-disabled' : ''}">` +
                `<td><input type="checkbox" class="pc-account-checkbox" data-id="${acct.accountId}" ${isChecked ? 'checked' : ''} ${!isLinked ? 'disabled' : ''}></td>` +
                `<td class="pc-account-id-cell" title="${acct.accountId}"><span class="pc-account-id-mono">${acct.accountId}</span>${emailHtml}</td>` +
                `<td class="pc-last-collect">${lastFetch}</td>` +
                `<td>${statusHtml}</td>` +
                `</tr>`;
        });
        html += '</tbody></table>';
        wrap.html(html);
    } catch (e) {
        wrap.html('<div class="pc-account-empty">Error loading accounts.</div>');
        console.error('[Settings] loadPinterestAccountsTable error:', e);
    }
}

function pcRelativeTime(isoString) {
    if (!isoString) return 'Never';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

function pcGetSelectedAccountIds() {
    const ids = [];
    $("#pinterestAccountTable .pc-account-checkbox:checked").each(function () {
        ids.push($(this).data('id'));
    });
    return ids;
}

async function pcSaveSelection() {
    const selected = pcGetSelectedAccountIds();
    try {
        await window.electronAPI.updatePinterestSelectedAccounts(selected);
    } catch (e) { /* ignore */ }
}

$(document).on('change', '.pc-account-checkbox', function () {
    pcSaveSelection();
});

$(document).on('click', '#pcSelectAll', function () {
    $("#pinterestAccountTable .pc-account-checkbox:not(:disabled)").prop('checked', true);
    pcSaveSelection();
});

$(document).on('click', '#pcDeselectAll', function () {
    $("#pinterestAccountTable .pc-account-checkbox:not(:disabled)").prop('checked', false);
    pcSaveSelection();
});

$(document).on('click', '#pcRefreshAccounts', function () {
    loadPinterestAccountsTable();
});

// ===================== ACCOUNT RESULT CARDS =====================

function pcInitAccountCards(accountIds) {
    const grid = $("#pinterestAccountGrid").empty();
    $("#pinterestAccountResultsCard").show();
    accountIds.forEach(id => {
        const card = $(`
            <div class="pc-account-card pc-state-pending" data-pc-id="${id}">
                <div class="pc-card-icon"><i class="material-icons pc-icon">schedule</i></div>
                <div class="pc-card-id" title="${id}">${id}</div>
                <div class="pc-card-badges">
                    <span class="pc-badge pc-metrics-badge" style="display:none;"></span>
                    <span class="pc-badge pc-pins-badge" style="display:none;"></span>
                </div>
                <div class="pc-card-error" style="display:none;"></div>
                <button class="pc-retry-btn" style="display:none;" data-pc-id="${id}">
                    <i class="material-icons" style="font-size:14px;vertical-align:-3px;">refresh</i> Retry
                </button>
            </div>
        `);
        grid.append(card);
    });
}

function pcUpdateAccountCard(accountId, status, data) {
    const card = $(`[data-pc-id="${accountId}"].pc-account-card`);
    if (!card.length) return;

    card.removeClass('pc-state-pending pc-state-processing pc-state-success pc-state-skipped pc-state-error');
    card.find('.pc-card-error').hide().text('');
    card.find('.pc-retry-btn').hide();
    card.find('.pc-metrics-badge, .pc-pins-badge').hide();

    switch (status) {
        case 'processing':
            card.addClass('pc-state-processing');
            card.find('.pc-icon').text('sync');
            break;
        case 'success':
            card.addClass('pc-state-success');
            card.find('.pc-icon').text('check_circle');
            if (data) {
                card.find('.pc-metrics-badge').text(`${data.metricsSaved ?? 0} metrics`).show();
                card.find('.pc-pins-badge').text(`${data.pinsSaved ?? 0} pins`).show();
            }
            break;
        case 'skipped':
            card.addClass('pc-state-skipped');
            card.find('.pc-icon').text('skip_next');
            card.find('.pc-metrics-badge').text('Skipped').show();
            break;
        case 'error':
            card.addClass('pc-state-error');
            card.find('.pc-icon').text('error');
            if (data && data.error) {
                card.find('.pc-card-error').text(data.error).show();
            }
            card.find('.pc-retry-btn').show();
            break;
        default:
            card.addClass('pc-state-pending');
            card.find('.pc-icon').text('schedule');
    }
}

function pcResetAccountCards() {
    $(".pc-account-card").each(function () {
        const id = $(this).data('pc-id');
        pcUpdateAccountCard(id, 'pending');
    });
}

// Retry button handler
$(document).on('click', '.pc-retry-btn', async function () {
    const accountId = $(this).data('pc-id');
    if (!accountId) return;
    $(this).prop('disabled', true);
    pcUpdateAccountCard(accountId, 'processing');
    try {
        const result = await window.electronAPI.retryPinterestAccount(accountId);
        if (result.success) {
            pcUpdateAccountCard(accountId, 'success', result);
        } else {
            pcUpdateAccountCard(accountId, 'error', { error: result.error || 'Unknown error' });
        }
    } catch (e) {
        pcUpdateAccountCard(accountId, 'error', { error: e.message });
    }
    $(this).prop('disabled', false);
});

// Account progress event handler
function pinterestAccountProgressHandler(data) {
    switch (data.status) {
        case 'start':
            pcInitAccountCards(data.accounts || []);
            break;
        case 'processing':
            pcUpdateAccountCard(data.accountId, 'processing');
            $("#pinterestProgressAccount").text(`Processing: ${data.accountId}`);
            break;
        case 'success':
            pcUpdateAccountCard(data.accountId, 'success', data);
            // Update the Last Collected cell in the account table live
            $("#pinterestAccountTable .pc-account-checkbox[data-id='" + data.accountId + "']")
                .closest('tr').find('.pc-last-collect').text('Just now');
            break;
        case 'skipped':
            pcUpdateAccountCard(data.accountId, 'skipped');
            break;
        case 'error':
            pcUpdateAccountCard(data.accountId, 'error', data);
            break;
    }
}

// ===================== LOAD SETTINGS =====================

async function loadPinterestCollectionSettings() {
    try {
        const res = await window.electronAPI.getPinterestCollectionSettings();
        if (res.success && res.data) {
            const s = res.data;
            $("#pinterestAutoCollectionToggle").prop("checked", s.enabled === true);
            $("#pinterestIntervalSelect").val(String(s.intervalHours || 24));
            updatePinterestToggleLabel(s.enabled !== false);
        }
    } catch (e) {
        console.error("[Settings] Error loading pinterest collection settings:", e);
    }
    await loadPinterestAccountsTable();
    await refreshPinterestStatus();
}

function updatePinterestToggleLabel(enabled) {
    const label = enabled
        ? (window.I18n?.t("settings.pinterest_collection.enabled") || "Enabled")
        : (window.I18n?.t("settings.pinterest_collection.disabled") || "Disabled");
    $("#pinterestAutoCollectionLabel").text(label);
}

async function refreshPinterestStatus() {
    try {
        const res = await window.electronAPI.getPinterestCollectionStatus();
        if (!res.success) return;
        const d = res.data;
        const badge = $("#pinterestCollectionStatusBadge");
        if (d.isCollecting) {
            badge.text(window.I18n?.t("settings.pinterest_collection.collecting") || "Collecting...");
            badge.removeClass("pinterest-status-idle").addClass("pinterest-status-collecting");
            $("#pinterestCollectNowBtn").prop("disabled", true);
            if (d.progress && d.progress.total > 0) {
                const pct = Math.round((d.progress.current / d.progress.total) * 100);
                $("#pinterestProgressContainer").show();
                $("#pinterestProgressText").text(`${d.progress.current} / ${d.progress.total}`);
                $("#pinterestProgressBar").css("width", pct + "%");
            }
        } else {
            badge.text(window.I18n?.t("settings.pinterest_collection.idle") || "Idle");
            badge.removeClass("pinterest-status-collecting").addClass("pinterest-status-idle");
            $("#pinterestCollectNowBtn").prop("disabled", false);
            $("#pinterestProgressContainer").hide();
            $("#pinterestProgressAccount").text('');
        }
        if (d.lastCollectionTime) {
            const dt = new Date(d.lastCollectionTime);
            $("#pinterestLastCollection").text(dt.toLocaleString());
        } else {
            $("#pinterestLastCollection").text("—");
        }
        if (d.nextScheduledTime) {
            const dt = new Date(d.nextScheduledTime);
            $("#pinterestNextRun").text(dt.toLocaleString());
        } else {
            $("#pinterestNextRun").text("—");
        }
    } catch (e) { /* ignore */ }
}

// Toggle auto collection
$("#pinterestAutoCollectionToggle").on("change", async function () {
    const enabled = $(this).is(":checked");
    const interval = parseInt($("#pinterestIntervalSelect").val()) || 24;
    updatePinterestToggleLabel(enabled);
    try {
        const res = await window.electronAPI.getPinterestCollectionSettings();
        const existing = (res.success && res.data) ? res.data : {};
        await window.electronAPI.updatePinterestCollectionSettings({ ...existing, enabled, intervalHours: interval });
    } catch (e) {
        console.error("[Settings] Error saving pinterest settings:", e);
    }
    setTimeout(refreshPinterestStatus, 1000);
});

// Change interval
$("#pinterestIntervalSelect").on("change", async function () {
    const enabled = $("#pinterestAutoCollectionToggle").is(":checked");
    const interval = parseInt($(this).val()) || 24;
    try {
        const res = await window.electronAPI.getPinterestCollectionSettings();
        const existing = (res.success && res.data) ? res.data : {};
        await window.electronAPI.updatePinterestCollectionSettings({ ...existing, enabled, intervalHours: interval });
    } catch (e) {
        console.error("[Settings] Error saving pinterest settings:", e);
    }
    setTimeout(refreshPinterestStatus, 1000);
});

// Collect Now button
$("#pinterestCollectNowBtn").on("click", async function () {
    $(this).prop("disabled", true);
    $("#pinterestCollectionStatusBadge")
        .text(window.I18n?.t("settings.pinterest_collection.collecting") || "Collecting...")
        .removeClass("pinterest-status-idle").addClass("pinterest-status-collecting");
    pcResetAccountCards();
    try {
        const selected = pcGetSelectedAccountIds();
        await window.electronAPI.triggerPinterestAnalyticsFetch(true, selected.length ? selected : null);
    } catch (e) {
        console.error("[Settings] Error triggering pinterest fetch:", e);
    }
    $(this).prop("disabled", false);
    refreshPinterestStatus();
    loadPinterestAccountsTable(); // refresh last-collect timestamps
});

// Clear logs
$("#pinterestClearLogsBtn").on("click", function () {
    const viewer = $("#pinterestLogViewer");
    viewer.html('<div class="pinterest-log-empty">' +
        (window.I18n?.t("settings.pinterest_collection.no_logs") || "No logs yet. Start a collection to see live activity.") +
        '</div>');
});

// Collapsible logs
$(document).on("click", "#pinterestLogsToggle", function () {
    const body = $("#pinterestLogsBody");
    const chevron = $("#pinterestLogsChevron");
    if (body.is(":visible")) {
        body.slideUp(200);
        chevron.text("chevron_right");
    } else {
        body.slideDown(200);
        chevron.text("expand_more");
    }
});

// Live log listener
function pinterestLogHandler(data) {
    const viewer = $("#pinterestLogViewer");
    if (!viewer.length) return;
    viewer.find(".pinterest-log-empty").remove();
    const typeClass = data.type === "error" ? "pinterest-log-error" :
                      data.type === "warn" ? "pinterest-log-warn" : "pinterest-log-info";
    const time = new Date(data.timestamp).toLocaleTimeString();
    const line = $('<div class="pinterest-log-line ' + typeClass + '"></div>');
    line.text("[" + time + "] " + data.message);
    viewer.append(line);
    const lines = viewer.children(".pinterest-log-line");
    if (lines.length > 500) lines.first().remove();
    viewer.scrollTop(viewer[0].scrollHeight);
}

// When Pinterest Collection section is shown, init
$(".menu-element[for='pinterest-collection']").click(function () {
    loadPinterestCollectionSettings();
    window.electronAPI.onPinterestCollectionLog(pinterestLogHandler);
    window.electronAPI.onPinterestAccountProgress(pinterestAccountProgressHandler);
    if (_pinterestStatusInterval) clearInterval(_pinterestStatusInterval);
    _pinterestStatusInterval = setInterval(refreshPinterestStatus, 5000);
});

// Cleanup when navigating away from settings section
$(".settings-sidebar .menu .menu-element").not("[for='pinterest-collection']").on("click", function () {
    if (_pinterestStatusInterval) { clearInterval(_pinterestStatusInterval); _pinterestStatusInterval = null; }
    window.electronAPI.offPinterestCollectionLog();
    window.electronAPI.offPinterestAccountProgress();
});
