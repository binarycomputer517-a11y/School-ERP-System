/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * File: public/js/global-config.js
 * Features: API-Driven, No Mock Data, 360x Watermark Generation.
 * This script runs on EVERY page load to apply settings globally.
 */

const SETTINGS_CACHE_KEY = 'erp_settings';
const GLOBAL_CONFIG_API = '/api/settings/config/current'; 
const MAX_CACHE_AGE_MS = 3600000; // 1 hour (3600 seconds * 1000 ms)

// --- STATIC CLIENT-SIDE CONFIGURATION ---
// These values are merged with the API response (settings).
const STATIC_CONFIG = {
    // --- Feedback Module Configuration ---
    FEEDBACK_STATUSES: ['New', 'In Progress', 'Resolved', 'Closed'],
    FEEDBACK_PRIORITIES: ['Low', 'Medium', 'High', 'Urgent'],
    
    // --- API Endpoints (Used by client-side JS) ---
    API_ENDPOINTS: {
        SUBMIT_FEEDBACK: '/api/feedback/submit',
        MY_SUBMISSIONS: '/api/feedback/my-submissions',
        ALL_FEEDBACK: '/api/feedback/all',
        // Example of a function endpoint
        UPDATE_STATUS: (id) => `/api/feedback/${id}/status`
    },
    
    // --- UI Styles for Feedback ---
    FEEDBACK_STATUS_COLORS: {
        'New': '#3498db',         // Blue
        'In Progress': '#f39c12', // Orange
        'Resolved': '#2ecc71',    // Green
        'Closed': '#95a5a6'       // Grey
    }
};

// Global exposure of settings and utilities
window.erpSettings = null;

// Run immediately when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    window.erpSettings = await initGlobalSettings();
});

// Helper function to check if the cached data is too old
function isCacheExpired(cachedData) {
    if (!cachedData || !cachedData.timestamp) return true;
    const cacheTime = new Date(cachedData.timestamp).getTime();
    return (Date.now() - cacheTime) > MAX_CACHE_AGE_MS;
}

async function initGlobalSettings() {
    let settingsData = localStorage.getItem(SETTINGS_CACHE_KEY);
    let settings = null;
    
    // 1. Load from Cache or Fetch
    if (settingsData) {
        let cached = JSON.parse(settingsData);
        if (!isCacheExpired(cached)) {
            settings = cached.data;
        } else {
            localStorage.removeItem(SETTINGS_CACHE_KEY); 
        }
    }

    // 2. Fetch from API if settings are null (cache miss or expired)
    // NO MOCK DATA FALLBACK
    if (!settings) {
        const token = localStorage.getItem('erp-token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        
        try {
            const res = await fetch(GLOBAL_CONFIG_API, { headers });

            if (!res.ok) {
                throw new Error(`Failed to fetch settings. Status: ${res.status}`);
            }

            const data = await res.json();
            
            // Save to Cache with timestamp
            localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({
                data: data,
                timestamp: new Date().toISOString()
            }));
            settings = data;
            
        } catch (e) { 
            console.error("Global Config: Failed to sync settings", e);
            return null; 
        }
    }

    // 3. Apply Settings to the UI and return the object
    if(settings) {
        // Merge API settings with static client-side configuration
        Object.assign(settings, STATIC_CONFIG); 
        
        applySettingsToUI(settings);
        return settings; // Expose settings globally via the return value
    }
    
    return null;
}

function applySettingsToUI(config) {
    
    // --- A. School Identity (Name, Watermark) ---
    if (config.school_name) {
        // Update text elements
        document.querySelectorAll('.global-school-name').forEach(el => el.innerText = config.school_name);
        document.querySelectorAll('.school-name').forEach(el => el.innerText = config.school_name);
        
        localStorage.setItem('school-name', config.school_name);
        
        // Generate 360x Watermark (If container exists)
        generateWatermark(config.school_name);
    }

    // --- B. Branding (Logo & Favicon) ---
    if (config.school_logo_path) {
        document.querySelectorAll('.global-school-logo, .school-logo, .watermark-logo').forEach(img => {
            img.src = config.school_logo_path;
            img.alt = config.school_name || "School Logo";
        });

        // Update Browser Tab Icon (Favicon)
        let link = document.querySelector("link[rel~='icon']");
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.getElementsByTagName('head')[0].appendChild(link);
        }
        link.href = config.school_logo_path;
        
        localStorage.setItem('school-logo-path', config.school_logo_path); 
    }

    // --- C. Currency Formatting ---
    let symbol = '₹';
    let locale = 'en-IN'; 

    switch (config.currency) {
        case 'USD':
            symbol = '$';
            locale = 'en-US';
            break;
        case 'EUR':
            symbol = '€';
            locale = 'de-DE'; 
            break;
        case 'INR':
        default:
            symbol = '₹';
            locale = 'en-IN'; 
            break;
    }
    
    // Globally define a currency formatter function for other scripts
    window.formatCurrency = (amount) => {
        if (amount === undefined || amount === null || isNaN(amount)) return `${symbol} 0.00`;
        
        const formatter = new Intl.NumberFormat(locale, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
            useGrouping: true 
        });
        
        const formattedAmount = formatter.format(Number(amount));

        return `${symbol} ${formattedAmount}`;
    };
    
    // Apply currency symbol to static elements
    document.querySelectorAll('.currency-symbol').forEach(el => {
        el.innerText = symbol;
    });

    // --- D. School Address & Contact ---
    const identityMap = {
        school_address: '.global-school-address',
        school_email: '.global-school-email',
        school_phone: '.global-school-phone'
    };
    
    for (const key in identityMap) {
        if (config[key]) {
            document.querySelectorAll(identityMap[key]).forEach(el => el.innerText = config[key]);
        }
    }
    
    // Update specific classes used in marksheet/admin pages if they differ
    if (config.school_address) {
        document.querySelectorAll('.school-address').forEach(el => el.innerText = config.school_address);
    }
    
    // --- E. Global Footer Text ---
    if (config.email_global_footer) {
        const footerEl = document.getElementById('global-footer-text');
        if(footerEl) footerEl.textContent = config.email_global_footer; 
    }

    // --- F. Feature Toggles (Hide/Show Modules) ---
    if (config.multi_tenant_mode === false) {
        document.querySelectorAll('.module-tenant-switch').forEach(el => el.style.display = 'none');
    }
    if (!config.sms_provider) {
        document.querySelectorAll('.module-sms-panel').forEach(el => el.style.display = 'none');
    }

    // --- G. Theme Colors (Advanced CSS Variables) ---
    if (config.theme_primary_color) {
        document.documentElement.style.setProperty('--primary-color', config.theme_primary_color);
    }
    if (config.theme_secondary_color) {
        document.documentElement.style.setProperty('--classic-gold', config.theme_secondary_color);
    }
}

/**
 * Generates the School Name 360 times for background patterns.
 * Looks for #bg-text-pattern container.
 */
function generateWatermark(text) {
    const container = document.getElementById('bg-text-pattern');
    if (!container) return; // Exit if page doesn't have watermark container

    let html = '';
    // Loop exactly 360 times
    for (let i = 0; i < 360; i++) {
        html += `<div class="watermark-text">${text}</div>`;
    }
    container.innerHTML = html;
}

/**
 * Helper: Force Reload Settings
 */
function refreshGlobalSettings() {
    localStorage.removeItem(SETTINGS_CACHE_KEY);
    window.location.reload(); 
}

// Optionally expose the refresh function globally
window.refreshGlobalSettings = refreshGlobalSettings;