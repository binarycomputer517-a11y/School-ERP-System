/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * File: public/js/global-config.js
 * Version: 2.3.5 (English Standardized & Multi-Branch)
 * Features: API-Driven Branding, Persistent Caching, UI Injection, Centralized API Handling.
 */

(function() {
    "use strict";

    // --- 1. SERVER CONNECTION CONFIGURATION ---
const hostname = window.location.hostname;
const IS_LOCALHOST = hostname === 'localhost' || hostname === '127.0.0.1';

// Backend Port for Local Development
const BACKEND_PORT = 3005; 

/**
 * FIXED: Dynamic Base URL for Android & Web
 * This logic ensures the app connects to your live server or local IP.
 */
let API_BASE_URL;

if (IS_LOCALHOST) {
    API_BASE_URL = `http://localhost:${BACKEND_PORT}`;
} else {
    
    API_BASE_URL = 'http://72.61.140.252:3005'; 
}

console.log(`🚀 ERP System Initialized. Gateway: ${API_BASE_URL}`);

    // --- 2. CONFIGURATION CONSTANTS ---
    const SETTINGS_CACHE_KEY = 'erp_settings_v2';
    const MAX_CACHE_AGE_MS = 3600000; // 1 Hour Cache Persistence

    const STATIC_CONFIG = {
        API_BASE: API_BASE_URL,
        FEEDBACK_STATUSES: ['New', 'In Progress', 'Resolved', 'Closed'],
        FEEDBACK_PRIORITIES: ['Low', 'Medium', 'High', 'Urgent'],
        DEFAULT_THEME: {
            primary: '#1e3a8a',
            secondary: '#d97706',
            logo: '/images/default-logo.png',
            name: 'Enterprise ERP'
        }
    };

    window.erpSettings = null;

    // --- 3. GLOBAL FETCH HELPER (CENTRALIZED AUTH & BRANCH SYNC) ---
    /**
     * @function authFetch
     * @desc Custom fetch wrapper that injects Auth Tokens and Active Branch Context into every request.
     */
    window.authFetch = async (endpoint, options = {}) => {
        const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
        
        const token = localStorage.getItem('erp-token');
        
        // --- MULTI-BRANCH SYNCHRONIZATION ---
        // Retrieving branch context from storage to pass to the backend for row-level security.
        const userBranchId = localStorage.getItem('erp-branch-id'); 
        const activeBranchId = localStorage.getItem('active_branch_id'); 
        const targetBranch = (userBranchId && userBranchId !== 'null') ? userBranchId : activeBranchId;

        const headers = { 
            'Content-Type': 'application/json',
            'active-branch-id': targetBranch,
            ...options.headers 
        };
        
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch(url, { ...options, headers });

            // Global Handle for Session Expiry (401 Unauthorized)
            // FIXED: Only redirect if it's not a background config check
            if (response.status === 401 && !options.skipGlobalError) {
                console.warn("Session Expired or Unauthorized Access. Validating session...");
                
                if (!window.location.pathname.includes('login.html')) {
                    // Logic to prevent forced redirection if data is still locally available
                    console.error("Critical Auth Failure. Redirecting to login.");
                    localStorage.removeItem('erp-token');
                    window.location.href = '/login.html'; 
                }
            }
            
            return response;
        } catch (error) {
            console.error(`API Connectivity Failure [${url}]:`, error);
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

            // Apply configuration data to the User Interface
            applyBranding(window.erpSettings);
            applyIdentity(window.erpSettings);
            setupGlobalFormatters(window.erpSettings);
            handleFeatureToggles(window.erpSettings);

            // Broadcast readiness event to the page
            document.dispatchEvent(new CustomEvent('ERP_CONFIG_READY', { 
                detail: window.erpSettings 
            }));

        } catch (error) {
            console.error("System Configuration Failure:", error);
        }
    }

    /**
     * FETCH CONFIGURATION
     * Manages local caching and remote fetching of system settings.
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

        // 2. Fetch fresh config from API (Public route)
        try {
            const response = await window.authFetch('/api/settings/config/current', {
                skipGlobalError: true // Prevents redirection loop if config fails
            });
            
            if (!response.ok) {
                console.warn("Remote config inaccessible, using default template.");
                return STATIC_CONFIG.DEFAULT_THEME;
            }

            const remoteData = await response.json();
            
            localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({
                data: remoteData,
                timestamp: new Date().toISOString()
            }));

            return remoteData;
        } catch (err) {
            console.error("Config synchronization error, using fallbacks:", err);
            return STATIC_CONFIG.DEFAULT_THEME;
        }
    }

    /**
     * APPLY BRANDING
     * Sets CSS Variables, Logos, and Page Titles dynamically.
     */
    function applyBranding(config) {
        const root = document.documentElement;

        if (config.theme_primary_color) root.style.setProperty('--primary-color', config.theme_primary_color);
        if (config.theme_secondary_color) root.style.setProperty('--secondary-color', config.theme_secondary_color);

        const name = config.school_name || config.name || "Enterprise ERP";
        document.querySelectorAll('.global-school-name, .school-name').forEach(el => el.innerText = name);
        
        if(document.title === 'Document' || document.title.includes('ERP')) {
             document.title = `${name} | Academic Portal`;
        }

        // --- Logo Path Reconstruction ---
        let logoPath = config.school_logo_path || config.logo;
        if (logoPath && !logoPath.startsWith('http') && !logoPath.startsWith('data:')) {
            const baseUrl = API_BASE_URL.endsWith('/') ? API_BASE_URL : `${API_BASE_URL}/`;
            const cleanPath = logoPath.startsWith('/') ? logoPath.substring(1) : logoPath;
            logoPath = `${baseUrl}${cleanPath}`;
        }

        document.querySelectorAll('.global-school-logo, .school-logo').forEach(img => {
            img.src = logoPath;
            img.onerror = () => { img.src = 'https://placehold.co/100x100?text=ERP-LOGO'; };
        });

        updateFavicon(logoPath);
        generateWatermark(name);
    }

    /**
     * APPLY IDENTITY (Address, Contact info, Footers)
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
     * GLOBAL FORMATTERS (Currency and Date Localization)
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
     * FEATURE TOGGLES (Visibility based on subscription/settings)
     */
    function handleFeatureToggles(config) {
        if (config.multi_tenant_mode === false) {
            document.querySelectorAll('.module-tenant-switch').forEach(el => el.remove());
        }
    }

    /**
     * SECURE WATERMARK GENERATOR
     */
    function generateWatermark(text) {
        const container = document.getElementById('bg-text-pattern');
        if (!container) return;
        let html = '';
        for(let i = 0; i < 120; i++) {
            html += `<div class="watermark-text" style="transform: rotate(-30deg); opacity: 0.03; user-select: none; pointer-events: none;">${text}</div>`;
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

    /**
     * Utility to manually purge cache and refresh system state
     */
    window.refreshGlobalSettings = () => {
        localStorage.removeItem(SETTINGS_CACHE_KEY);
        window.location.reload();
    };

    init();

})();