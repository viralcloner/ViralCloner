/**
 * ViralCloner Internationalization (i18n) Module
 * 
 * Provides multilanguage support with:
 * - Automatic system locale detection
 * - JSON-based translation files
 * - data-i18n attribute support for static HTML
 * - t() function for dynamic JS translations
 * - Easy language switching
 * 
 * Usage:
 *   HTML: <span data-i18n="nav.home">Home</span>
 *   JS:   const text = t('alerts.save_success');
 *   JS:   const text = t('home.welcome_user', { name: 'John' }); // Welcome, {{name}}!
 */

const I18n = {
    _locale: 'en',
    _translations: {},
    _ready: false,
    _supportedLocales: ['en', 'fr', 'ar'],
    _rtlLocales: ['ar'],
    _defaultLocale: 'en',
    _loadPromise: null,

    /**
     * Initialize the i18n system
     * Call this once at app startup before any translations are needed
     */
    async init() {
        if (this._loadPromise) {
            return this._loadPromise;
        }

        this._loadPromise = this._doInit();
        return this._loadPromise;
    },

    async _doInit() {
        try {
            // 1. Check for saved language preference
            let locale = await window.electronAPI.readKey('appLanguage');

            // 2. Fall back to system locale if no preference saved
            if (!locale) {
                try {
                    const systemLocale = await window.electronAPI.getSystemLocale();
                    // Extract language code: 'en-US' → 'en', 'fr-FR' → 'fr'
                    locale = systemLocale ? systemLocale.split('-')[0].toLowerCase() : null;
                } catch (e) {
                    console.warn('[I18N] Could not get system locale:', e);
                }
            }

            // 3. Validate against supported locales, default to English
            this._locale = this._supportedLocales.includes(locale) ? locale : this._defaultLocale;

            // 4. Load translation file
            await this._loadTranslations(this._locale);

            // 5. Apply RTL direction if needed
            this._applyDirection(this._locale);

            // 6. Cache locale in localStorage for fast initial load
            localStorage.setItem('vc.language', this._locale);

            this._ready = true;
            console.log(`[I18N] Initialized with locale: ${this._locale}`);

            return this._locale;
        } catch (error) {
            console.error('[I18N] Initialization failed:', error);
            // Fall back to English with empty translations
            this._locale = this._defaultLocale;
            this._ready = true;
            return this._locale;
        }
    },

    /**
     * Load translations for a specific locale
     */
    async _loadTranslations(locale) {
        try {
            const response = await fetch(`locales/${locale}.json`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            this._translations = await response.json();
        } catch (error) {
            console.error(`[I18N] Failed to load translations for '${locale}':`, error);
            // Try loading English as fallback
            if (locale !== this._defaultLocale) {
                console.log('[I18N] Falling back to English...');
                try {
                    const fallbackResponse = await fetch(`locales/${this._defaultLocale}.json`);
                    this._translations = await fallbackResponse.json();
                } catch (fallbackError) {
                    console.error('[I18N] Failed to load fallback translations:', fallbackError);
                    this._translations = {};
                }
            }
        }
    },

    /**
     * Get a translated string by key
     * Supports nested keys like 'nav.home' and placeholders like {{name}}
     * 
     * @param {string} key - Dot-separated translation key
     * @param {Object} replacements - Optional object with placeholder values
     * @returns {string} Translated string or the key if not found
     */
    t(key, replacements = {}) {
        if (!key) return '';

        // Navigate through nested keys
        const keys = key.split('.');
        let value = this._translations;

        for (const k of keys) {
            value = value?.[k];
            if (value === undefined) {
                // Key not found, return the key itself
                console.warn(`[I18N] Missing translation: ${key}`);
                return key;
            }
        }

        // If value is not a string (it's a nested object), return the key
        if (typeof value !== 'string') {
            console.warn(`[I18N] Invalid translation (not a string): ${key}`);
            return key;
        }

        // Replace {{placeholders}} with values
        if (Object.keys(replacements).length > 0) {
            value = value.replace(/\{\{(\w+)\}\}/g, (match, placeholder) => {
                return replacements[placeholder] !== undefined ? replacements[placeholder] : match;
            });
        }

        return value;
    },

    /**
     * Change the current locale
     * Saves preference to storage (requires app restart to apply)
     * 
     * @param {string} locale - Language code ('en', 'fr', etc.)
     * @returns {boolean} Success status
     */
    async setLocale(locale) {
        if (!this._supportedLocales.includes(locale)) {
            console.error(`[I18N] Unsupported locale: ${locale}`);
            return false;
        }

        if (locale === this._locale) {
            return true;
        }

        try {
            // Save preference (will be applied on next app start)
            await window.electronAPI.updateData('appLanguage', locale);
            localStorage.setItem('vc.language', locale);

            console.log(`[I18N] Locale preference saved: ${locale} (requires restart)`);

            // Dispatch event for components that want to show restart notification
            document.dispatchEvent(new CustomEvent('locale-changed', { detail: locale }));

            return true;
        } catch (error) {
            console.error('[I18N] Failed to save locale preference:', error);
            return false;
        }
    },

    /**
     * Get the current locale
     * @returns {string} Current locale code
     */
    getLocale() {
        return this._locale;
    },

    /**
     * Get list of supported locales
     * @returns {Array} Array of locale codes
     */
    getSupportedLocales() {
        return [...this._supportedLocales];
    },

    /**
     * Check if i18n is initialized
     * @returns {boolean}
     */
    isReady() {
        return this._ready;
    },

    /**
     * Translate all elements with data-i18n attribute in the given container
     * Also handles data-i18n-placeholder, data-i18n-title attributes
     * 
     * @param {Element} container - DOM element to translate (defaults to document)
     */
    translatePage(container = document) {
        if (!this._ready) {
            console.warn('[I18N] translatePage called before initialization');
            return;
        }

        // Translate text content (with optional data-i18n-options for placeholders)
        container.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) {
                let options = {};
                const optionsAttr = el.getAttribute('data-i18n-options');
                if (optionsAttr) {
                    try {
                        options = JSON.parse(optionsAttr);
                    } catch (e) {
                        console.warn(`[I18N] Invalid data-i18n-options JSON: ${optionsAttr}`);
                    }
                }
                el.textContent = this.t(key, options);
            }
        });

        // Translate placeholder attributes
        container.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (key) {
                el.placeholder = this.t(key);
            }
        });

        // Translate title/tooltip attributes
        container.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (key) {
                el.title = this.t(key);
            }
        });

        // Translate aria-label attributes
        container.querySelectorAll('[data-i18n-aria]').forEach(el => {
            const key = el.getAttribute('data-i18n-aria');
            if (key) {
                el.setAttribute('aria-label', this.t(key));
            }
        });

        // Translate data-tooltip attributes (used by Tippy.js)
        container.querySelectorAll('[data-i18n-tooltip]').forEach(el => {
            const key = el.getAttribute('data-i18n-tooltip');
            if (key) {
                const translatedText = this.t(key);
                el.setAttribute('data-tooltip', translatedText);
                // Update Tippy instance if it exists on this element
                if (el._tippy) {
                    el._tippy.setContent(translatedText);
                }
                // For menu categories, Tippy is on the header child element
                if (el.classList.contains('menu-category')) {
                    const header = el.querySelector('.menu-category-header');
                    if (header && header._tippy) {
                        header._tippy.setContent(translatedText);
                    }
                }
            }
        });
    },

    /**
     * Get locale display name
     * @param {string} locale - Locale code
     * @returns {string} Display name in native language
     */
    getLocaleDisplayName(locale) {
        const names = {
            'en': 'English',
            'fr': 'Français',
            'ar': 'العربية'
        };
        return names[locale] || locale;
    },

    /**
     * Check if a locale is RTL
     * @param {string} locale - Locale code
     * @returns {boolean}
     */
    isRTL(locale = this._locale) {
        return this._rtlLocales.includes(locale);
    },

    /**
     * Apply text direction and load RTL stylesheet if needed
     * @param {string} locale - Locale code
     */
    _applyDirection(locale) {
        const isRTL = this._rtlLocales.includes(locale);
        const html = document.documentElement;
        
        if (isRTL) {
            html.setAttribute('dir', 'rtl');
            html.setAttribute('lang', locale);
            this._loadRTLStyles();
        } else {
            html.setAttribute('dir', 'ltr');
            html.setAttribute('lang', locale);
            this._unloadRTLStyles();
        }
    },

    /**
     * Load RTL stylesheet
     */
    _loadRTLStyles() {
        if (document.getElementById('rtl-stylesheet')) return;
        
        const link = document.createElement('link');
        link.id = 'rtl-stylesheet';
        link.rel = 'stylesheet';
        link.href = 'assets/css/rtl.css';
        document.head.appendChild(link);
    },

    /**
     * Remove RTL stylesheet
     */
    _unloadRTLStyles() {
        const link = document.getElementById('rtl-stylesheet');
        if (link) {
            link.remove();
        }
    }
};

// Create global shorthand function
window.I18n = I18n;
window.t = (key, replacements) => I18n.t(key, replacements);

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { I18n };
}
