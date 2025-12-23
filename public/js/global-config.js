/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * File: public/js/global-config.js
 * Version: 2.1.0 (Full & Final)
 * Features: API-Driven Branding, Persistent Caching, UI Injection, Watermarking.
 */

(function() {
    "use strict";

    // --- CONFIGURATION CONSTANTS ---
    const SETTINGS_CACHE_KEY = 'erp_settings_v2';
    const GLOBAL_CONFIG_API = '/api/settings/config/current';
    const MAX_CACHE_AGE_MS = 3600000; // 1 Hour

    const STATIC_CONFIG = {
        FEEDBACK_STATUSES: ['New', 'In Progress', 'Resolved', 'Closed'],
        FEEDBACK_PRIORITIES: ['Low', 'Medium', 'High', 'Urgent'],
        DEFAULT_THEME: {
            primary: '#1e3a8a',
            secondary: '#d97706',
            logo: '/images/default-logo.png',
            name: 'Enterprise ERP'
        },
        API_ENDPOINTS: {
            SUBMIT_FEEDBACK: '/api/feedback/submit',
            MY_SUBMISSIONS: '/api/feedback/my-submissions',
            ALL_FEEDBACK: '/api/feedback/all',
            UPDATE_STATUS: (id) => `/api/feedback/${id}/status`
        }
    };

    // Global Namespace
    window.erpSettings = null;

    /**
     * MAIN INITIALIZER
     * Orchestrates the loading and application of settings.
     */
    async function init() {
        try {
            const settings = await fetchConfiguration();
            window.erpSettings = { ...settings, ...STATIC_CONFIG };

            // Apply to UI
            applyBranding(window.erpSettings);
            applyIdentity(window.erpSettings);
            setupGlobalFormatters(window.erpSettings);
            handleFeatureToggles(window.erpSettings);

            // Notify specific pages (like view-payroll.html) that config is ready
            document.dispatchEvent(new CustomEvent('ERP_CONFIG_READY', { 
                detail: window.erpSettings 
            }));

        } catch (error) {
            console.error("ERP Global Config Failure:", error);
        }
    }

    /**
     * FETCH CONFIGURATION
     * Checks LocalStorage first, falls back to API, then Hard-coded Defaults.
     */
    async function fetchConfiguration() {
        // 1. Check Local Cache
        const cached = localStorage.getItem(SETTINGS_CACHE_KEY);
        if (cached) {
            const { data, timestamp } = JSON.parse(cached);
            if (Date.now() - new Date(timestamp).getTime() < MAX_CACHE_AGE_MS) {
                return data;
            }
        }

        // 2. Fetch from API
        const token = localStorage.getItem('erp-token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        try {
            const response = await fetch(GLOBAL_CONFIG_API, { headers });
            
            if (response.status === 401) {
                console.warn("Unauthorized: Using public branding defaults.");
                return STATIC_CONFIG.DEFAULT_THEME;
            }

            if (!response.ok) throw new Error("API_ERROR");

            const remoteData = await response.json();
            
            // Update Cache
            localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({
                data: remoteData,
                timestamp: new Date().toISOString()
            }));

            return remoteData;
        } catch (err) {
            console.error("Config Fetch Error, using fallbacks:", err);
            return STATIC_CONFIG.DEFAULT_THEME;
        }
    }

    /**
     * APPLY BRANDING
     * Handles CSS Variables, Logos, and Watermarks.
     */
    function applyBranding(config) {
        const root = document.documentElement;

        // Colors
        if (config.theme_primary_color) root.style.setProperty('--primary-color', config.theme_primary_color);
        if (config.theme_secondary_color) root.style.setProperty('--secondary-color', config.theme_secondary_color);

        // School Name & Title
        const name = config.school_name || config.name;
        document.querySelectorAll('.global-school-name, .school-name').forEach(el => el.innerText = name);
        document.title = `${name} | Portal`;

        // Logo & Favicon
        const logo = config.school_logo_path || config.logo;
        document.querySelectorAll('.global-school-logo, .school-logo').forEach(img => {
            img.src = logo;
            img.onerror = () => { img.src = STATIC_CONFIG.DEFAULT_THEME.logo; };
        });

        updateFavicon(logo);
        generateWatermark(name);
    }

    /**
     * APPLY IDENTITY
     * Maps school contact info to UI elements.
     */
    function applyIdentity(config) {
        const map = {
            'school_address': '.global-school-address, .school-address',
            'school_email': '.global-school-email',
            'school_phone': '.global-school-phone',
            'email_global_footer': '#global-footer-text'
        };

        for (const [key, selector] of Object.entries(map)) {
            if (config[key]) {
                document.querySelectorAll(selector).forEach(el => el.innerText = config[key]);
            }
        }
    }

    /**
     * GLOBAL FORMATTERS
     * Sets up currency and date logic available in the window object.
     */
    function setupGlobalFormatters(config) {
        const currency = config.currency || 'INR';
        const locale = currency === 'USD' ? 'en-US' : 'en-IN';
        const symbol = currency === 'USD' ? '$' : '₹';

        window.formatCurrency = (amount) => {
            if (isNaN(amount) || amount === null) return `${symbol}0.00`;
            return new Intl.NumberFormat(locale, {
                style: 'currency',
                currency: currency,
                minimumFractionDigits: 2
            }).format(amount);
        };

        window.formatDate = (dateStr, long = false) => {
            if (!dateStr) return 'N/A';
            return new Date(dateStr).toLocaleDateString(locale, {
                day: '2-digit',
                month: long ? 'long' : 'short',
                year: 'numeric'
            });
        };

        // Update UI symbols
        document.querySelectorAll('.currency-symbol').forEach(el => el.innerText = symbol);
    }

    /**
     * FEATURE TOGGLES
     * Hides/Shows UI modules based on configuration.
     */
    function handleFeatureToggles(config) {
        if (config.multi_tenant_mode === false) {
            document.querySelectorAll('.module-tenant-switch').forEach(el => el.remove());
        }
        if (!config.sms_provider) {
            document.querySelectorAll('.module-sms-panel').forEach(el => el.style.opacity = '0.5');
        }
    }

    /**
     * WATERMARK GENERATOR
     * Creates a background pattern without lagging the browser.
     */
    function generateWatermark(text) {
        const container = document.getElementById('bg-text-pattern');
        if (!container) return;
        
        // Using a loop to create a grid of 120 nodes (optimized from 360)
        let html = '';
        for(let i = 0; i < 120; i++) {
            html += `<div class="watermark-text" style="
                transform: rotate(-30deg); 
                opacity: 0.03; 
                user-select: none;
                pointer-events: none;">${text}</div>`;
        }
        container.innerHTML = html;
    }

    /**
     * FAVICON UPDATER
     */
    function updateFavicon(path) {
        let link = document.querySelector("link[rel*='icon']") || document.createElement('link');
        link.type = 'image/x-icon';
        link.rel = 'shortcut icon';
        link.href = path;
        document.getElementsByTagName('head')[0].appendChild(link);
    }

    /**
     * PUBLIC UTILITY
     * Allows forcing a refresh of settings.
     */
    window.refreshGlobalSettings = () => {
        localStorage.removeItem(SETTINGS_CACHE_KEY);
        window.location.reload();
    };

    // Execute
    init();

})();