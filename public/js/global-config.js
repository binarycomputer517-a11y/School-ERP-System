/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * File: public/js/global-config.js
 * Version: 2.3.0 (Login Loop Fixed & Port 3005)
 * Features: API-Driven Branding, Persistent Caching, UI Injection, Watermarking, Centralized API Handling.
 */

(function() {
    "use strict";

    // --- 1. SERVER CONNECTION CONFIGURATION ---
    const IS_LOCALHOST = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    // আপনার সার্ভার লগ অনুযায়ী পোর্ট 3005 সেট করা হলো
    const BACKEND_PORT = 3005; 
    
    // ডাইনামিক বেস URL নির্ধারণ
    const API_BASE_URL = IS_LOCALHOST 
        ? `http://localhost:${BACKEND_PORT}` 
        : window.location.origin;

    console.log(`🚀 ERP System Initialized. Connecting to: ${API_BASE_URL}`);

    // --- 2. CONFIGURATION CONSTANTS ---
    const SETTINGS_CACHE_KEY = 'erp_settings_v2';
    // const GLOBAL_CONFIG_API = ... (Not used directly anymore, using authFetch)
    const MAX_CACHE_AGE_MS = 3600000; // 1 Hour

    const STATIC_CONFIG = {
        API_BASE: API_BASE_URL,
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

    window.erpSettings = null;

    // --- 3. GLOBAL FETCH HELPER (CORE FIX) ---
    // options.skipGlobalError = true হলে 401 এরর এ লগআউট হবে না
    window.authFetch = async (endpoint, options = {}) => {
        const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
        
        const token = localStorage.getItem('erp-token');
        const headers = { 
            'Content-Type': 'application/json',
            ...options.headers 
        };
        
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch(url, { ...options, headers });

            // FIX: কনফিগারেশন API বা লগইন পেজে 401 আসলে লগআউট করাবো না
            // যদি skipGlobalError সত্য হয়, তবে আমরা গ্লোবাল লগআউট লজিক বাইপাস করব
            if (response.status === 401 && !options.skipGlobalError) {
                console.warn("Session Expired. Redirecting...");
                
                // লুপ এড়াতে চেক করুন আমরা ইতিমধ্যে লগইন পেজে আছি কি না
                if (!window.location.pathname.includes('login.html')) {
                    localStorage.removeItem('erp-token');
                    // window.location.href = '/login.html'; // Uncomment for prod
                }
            }
            
            return response;
        } catch (error) {
            console.error(`API Call Failed [${url}]:`, error);
            throw error;
        }
    };

    /**
     * MAIN INITIALIZER
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

            // Notify specific pages
            document.dispatchEvent(new CustomEvent('ERP_CONFIG_READY', { 
                detail: window.erpSettings 
            }));

        } catch (error) {
            console.error("ERP Global Config Failure:", error);
        }
    }

    /**
     * FETCH CONFIGURATION (FIXED)
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

        // 2. Fetch from API (Critical Fix: skipGlobalError: true)
        try {
            // এখানে skipGlobalError: true দেওয়া হলো যাতে 401 আসলেও লগআউট না হয়
            const response = await window.authFetch('/api/settings/config/current', {
                skipGlobalError: true 
            });
            
            if (!response.ok) {
                console.warn("Config fetch failed (likely 401), using default theme.");
                return STATIC_CONFIG.DEFAULT_THEME;
            }

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
     */
    function applyBranding(config) {
        const root = document.documentElement;

        if (config.theme_primary_color) root.style.setProperty('--primary-color', config.theme_primary_color);
        if (config.theme_secondary_color) root.style.setProperty('--secondary-color', config.theme_secondary_color);

        const name = config.school_name || config.name;
        document.querySelectorAll('.global-school-name, .school-name').forEach(el => el.innerText = name);
        if(document.title === 'Document' || document.title.includes('ERP')) {
             document.title = `${name} | Portal`;
        }

        // Logo Logic
        let logoPath = config.school_logo_path || config.logo;
        if (logoPath && !logoPath.startsWith('http') && !logoPath.startsWith('data:')) {
            logoPath = `${API_BASE_URL}${logoPath}`;
        }

        document.querySelectorAll('.global-school-logo, .school-logo').forEach(img => {
            img.src = logoPath;
            img.onerror = () => { 
                img.src = STATIC_CONFIG.DEFAULT_THEME.logo; 
            };
        });

        updateFavicon(logoPath);
        generateWatermark(name);
    }

    /**
     * APPLY IDENTITY
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

        document.querySelectorAll('.currency-symbol').forEach(el => el.innerText = symbol);
    }

    /**
     * FEATURE TOGGLES
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
     */
    function generateWatermark(text) {
        const container = document.getElementById('bg-text-pattern');
        if (!container) return;
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

    function updateFavicon(path) {
        let link = document.querySelector("link[rel*='icon']") || document.createElement('link');
        link.type = 'image/x-icon';
        link.rel = 'shortcut icon';
        link.href = path;
        document.getElementsByTagName('head')[0].appendChild(link);
    }

    window.refreshGlobalSettings = () => {
        localStorage.removeItem(SETTINGS_CACHE_KEY);
        window.location.reload();
    };

    // Execute
    init();

})();