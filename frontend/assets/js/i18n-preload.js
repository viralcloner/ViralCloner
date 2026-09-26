/**
 * ViralCloner i18n Preload Module
 * 
 * Lightweight i18n initialization for login/precheck pages.
 * Works before the main app is loaded.
 * Uses localStorage as primary store (synced to electronAPI storage when available)
 */

const I18nPreload = {
    _locale: 'en',
    _translations: {},
    _ready: false,
    _supportedLocales: ['en', 'fr', 'ar'],
    _rtlLocales: ['ar'],
    _defaultLocale: 'en',
    _basePath: '',
    
    // Flag configuration for each locale
    _localeFlags: {
        'en': { flag: 'gb.svg', name: 'English' },
        'fr': { flag: 'fr.svg', name: 'Français' },
        'ar': { flag: 'sa.svg', name: 'العربية' }
    },

    /**
     * Initialize the i18n system for preload pages
     * @param {string} basePath - Base path to assets folder (e.g., '../../' for login subwindow)
     */
    async init(basePath = '') {
        this._basePath = basePath;
        
        try {
            // 1. Check localStorage first (fastest)
            let locale = localStorage.getItem('vc.language');

            // 2. If no localStorage, try electronAPI storage
            if (!locale && window.electronAPI?.readKey) {
                try {
                    locale = await window.electronAPI.readKey('appLanguage');
                } catch (e) {
                    console.warn('[I18N-Preload] Could not read from storage:', e);
                }
            }

            // 3. Fall back to system locale if no preference saved
            if (!locale && window.electronAPI?.getSystemLocale) {
                try {
                    const systemLocale = await window.electronAPI.getSystemLocale();
                    locale = systemLocale ? systemLocale.split('-')[0].toLowerCase() : null;
                } catch (e) {
                    console.warn('[I18N-Preload] Could not get system locale:', e);
                }
            }

            // 4. Validate against supported locales
            this._locale = this._supportedLocales.includes(locale) ? locale : this._defaultLocale;

            // 5. Cache in localStorage
            localStorage.setItem('vc.language', this._locale);

            // 6. Load translations
            await this._loadTranslations(basePath);

            // 7. Apply RTL if needed
            this._applyDirection();

            this._ready = true;
            console.log(`[I18N-Preload] Initialized with locale: ${this._locale}`);

            return this._locale;
        } catch (error) {
            console.error('[I18N-Preload] Initialization failed:', error);
            this._locale = this._defaultLocale;
            this._ready = true;
            return this._locale;
        }
    },

    async _loadTranslations(basePath) {
        try {
            const response = await fetch(`${basePath}locales/${this._locale}.json`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this._translations = await response.json();
        } catch (error) {
            console.error(`[I18N-Preload] Failed to load translations:`, error);
            if (this._locale !== this._defaultLocale) {
                try {
                    const fallback = await fetch(`${basePath}locales/${this._defaultLocale}.json`);
                    this._translations = await fallback.json();
                } catch (e) {
                    this._translations = {};
                }
            }
        }
    },

    t(key, replacements = {}) {
        if (!key) return '';
        
        const keys = key.split('.');
        let value = this._translations;
        
        for (const k of keys) {
            value = value?.[k];
            if (value === undefined) return key;
        }
        
        if (typeof value !== 'string') return key;
        
        if (Object.keys(replacements).length > 0) {
            value = value.replace(/\{\{(\w+)\}\}/g, (match, placeholder) => {
                return replacements[placeholder] !== undefined ? replacements[placeholder] : match;
            });
        }
        
        return value;
    },

    getLocale() {
        return this._locale;
    },

    getSupportedLocales() {
        return [...this._supportedLocales];
    },

    getLocaleInfo(locale) {
        return this._localeFlags[locale] || { flag: 'gb.svg', name: locale };
    },

    isRTL(locale = this._locale) {
        return this._rtlLocales.includes(locale);
    },

    _applyDirection() {
        const isRTL = this._rtlLocales.includes(this._locale);
        const html = document.documentElement;
        
        html.setAttribute('dir', isRTL ? 'rtl' : 'ltr');
        html.setAttribute('lang', this._locale);
        
        // Load RTL stylesheet if needed
        if (isRTL && !document.getElementById('rtl-stylesheet-preload')) {
            const link = document.createElement('link');
            link.id = 'rtl-stylesheet-preload';
            link.rel = 'stylesheet';
            link.href = `${this._basePath}assets/css/rtl.css`;
            document.head.appendChild(link);
        } else if (!isRTL) {
            // Remove RTL stylesheet if switching away from RTL
            const rtlLink = document.getElementById('rtl-stylesheet-preload');
            if (rtlLink) rtlLink.remove();
        }
    },

    /**
     * Change locale and reload the page
     * @param {string} locale - New locale code
     */
    async setLocaleAndReload(locale) {
        if (!this._supportedLocales.includes(locale)) {
            console.error(`[I18N-Preload] Unsupported locale: ${locale}`);
            return false;
        }

        if (locale === this._locale) return true;

        try {
            // Save to localStorage (immediate)
            localStorage.setItem('vc.language', locale);
            
            // Save to electronAPI storage (persistent)
            if (window.electronAPI?.updateData) {
                await window.electronAPI.updateData('appLanguage', locale);
            }

            // Reload the page to apply
            window.location.reload();
            return true;
        } catch (error) {
            console.error('[I18N-Preload] Failed to save locale:', error);
            return false;
        }
    },

    translatePage(container = document) {
        if (!this._ready) return;

        container.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) el.textContent = this.t(key);
        });

        container.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (key) el.placeholder = this.t(key);
        });

        container.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            if (key) el.title = this.t(key);
        });
    },

    /**
     * Create and inject the language selector dropdown
     * @param {string} containerId - ID of the container element
     * @param {string} flagsBasePath - Base path to flags folder
     */
    createLanguageSelector(containerId, flagsBasePath = '') {
        const container = document.getElementById(containerId);
        if (!container) {
            console.warn('[I18N-Preload] Language selector container not found:', containerId);
            return;
        }

        const currentLocale = this._locale;
        const currentInfo = this.getLocaleInfo(currentLocale);

        const html = `
            <div class="lang-selector">
                <button class="lang-selector-btn" id="langSelectorBtn">
                    <img src="${flagsBasePath}${currentInfo.flag}" alt="${currentInfo.name}" class="lang-flag">
                    <span class="lang-name">${currentInfo.name}</span>
                    <svg class="lang-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
                <div class="lang-dropdown" id="langDropdown">
                    ${this._supportedLocales.map(locale => {
                        const info = this.getLocaleInfo(locale);
                        const isActive = locale === currentLocale ? 'active' : '';
                        return `
                            <button class="lang-option ${isActive}" data-locale="${locale}">
                                <img src="${flagsBasePath}${info.flag}" alt="${info.name}" class="lang-flag">
                                <span>${info.name}</span>
                                ${isActive ? '<svg class="lang-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        container.innerHTML = html;

        // Add event listeners
        const btn = document.getElementById('langSelectorBtn');
        const dropdown = document.getElementById('langDropdown');

        btn?.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown?.classList.toggle('show');
        });

        document.addEventListener('click', () => {
            dropdown?.classList.remove('show');
        });

        container.querySelectorAll('.lang-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                const locale = option.dataset.locale;
                if (locale && locale !== currentLocale) {
                    this.setLocaleAndReload(locale);
                }
            });
        });
    }
};

// Make available globally
window.I18n = I18nPreload;
window.t = (key, replacements) => I18nPreload.t(key, replacements);
