/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * File: public/js/global-config.js
 * Features: API-Driven, Persistent Caching, 360x Watermark, Identity Mapping.
 * description: This script runs on EVERY page load to apply settings globally.
 */

const SETTINGS_CACHE_KEY = 'erp_settings';
const GLOBAL_CONFIG_API = '/api/settings/config/current'; 
const MAX_CACHE_AGE_MS = 3600000; // 1 hour

// --- STATIC CLIENT-SIDE CONFIGURATION ---
const STATIC_CONFIG = {
    FEEDBACK_STATUSES: ['New', 'In Progress', 'Resolved', 'Closed'],
    FEEDBACK_PRIORITIES: ['Low', 'Medium', 'High', 'Urgent'],
    
    API_ENDPOINTS: {
        SUBMIT_FEEDBACK: '/api/feedback/submit',
        MY_SUBMISSIONS: '/api/feedback/my-submissions',
        ALL_FEEDBACK: '/api/feedback/all',
        UPDATE_STATUS: (id) => `/api/feedback/${id}/status`
    },
    
    FEEDBACK_STATUS_COLORS: {
        'New': '#3498db',
        'In Progress': '#f39c12',
        'Resolved': '#2ecc71',
        'Closed': '#95a5a6'
    }
};

window.erpSettings = null;

// --- AUTO INITIALIZATION ---
(async function() {
    window.erpSettings = await initGlobalSettings();
    // Custom Event for view-payroll.html
    const readyEvent = new CustomEvent('ERP_CONFIG_READY', { detail: window.erpSettings });
    document.dispatchEvent(readyEvent);
})();

async function initGlobalSettings() {
    let settingsData = localStorage.getItem(SETTINGS_CACHE_KEY);
    let settings = null;
    
    if (settingsData) {
        let cached = JSON.parse(settingsData);
        if (!isCacheExpired(cached)) {
            settings = cached.data;
        } else {
            localStorage.removeItem(SETTINGS_CACHE_KEY); 
        }
    }

    if (!settings) {
        const token = localStorage.getItem('erp-token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        
        try {
            const res = await fetch(GLOBAL_CONFIG_API, { headers });
            if (!res.ok) throw new Error(`Settings Fetch Failed: ${res.status}`);

            const data = await res.json();
            localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({
                data: data,
                timestamp: new Date().toISOString()
            }));
            settings = data;
        } catch (e) { 
            console.error("Global Config: Sync failed", e);
            return null; 
        }
    }

    if(settings) {
        Object.assign(settings, STATIC_CONFIG); 
        applySettingsToUI(settings);
        return settings;
    }
    return null;
}

function applySettingsToUI(config) {
    // A. School Identity & Watermark
    if (config.school_name) {
        document.querySelectorAll('.global-school-name, .school-name').forEach(el => el.innerText = config.school_name);
        localStorage.setItem('school-name', config.school_name);
        generateWatermark(config.school_name);
    }

    // B. Branding (Logo & Favicon)
    if (config.school_logo_path) {
        document.querySelectorAll('.global-school-logo, .school-logo, .watermark-logo').forEach(img => {
            img.src = config.school_logo_path;
            img.alt = config.school_name || "School Logo";
        });

        let link = document.querySelector("link[rel~='icon']") || document.createElement('link');
        link.rel = 'icon';
        link.href = config.school_logo_path;
        if (!document.head.contains(link)) document.head.appendChild(link);
        
        localStorage.setItem('school-logo-path', config.school_logo_path); 
    }

    // C. Currency Formatting Logic [Crucial for view-payroll]
    let symbol = '₹';
    let locale = 'en-IN'; 
    if (config.currency === 'USD') { symbol = '$'; locale = 'en-US'; }
    else if (config.currency === 'EUR') { symbol = '€'; locale = 'de-DE'; }

    window.formatCurrency = (amount) => {
        if (amount === undefined || amount === null || isNaN(amount)) return `${symbol} 0.00`;
        return new Intl.NumberFormat(locale, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
            useGrouping: true 
        }).format(Number(amount));
    };

    window.formatDate = (dateStr, type = 'short') => {
        if (!dateStr) return 'N/A';
        const date = new Date(dateStr);
        return date.toLocaleDateString(locale, {
            day: '2-digit', month: type === 'long' ? 'long' : 'short', year: 'numeric'
        });
    };

    document.querySelectorAll('.currency-symbol').forEach(el => el.innerText = symbol);

    // D. Identity Mapping (Address, Email, Phone)
    const identityMap = {
        school_address: '.global-school-address, .school-address',
        school_email: '.global-school-email',
        school_phone: '.global-school-phone'
    };
    
    for (const [key, selector] of Object.entries(identityMap)) {
        if (config[key]) {
            document.querySelectorAll(selector).forEach(el => el.innerText = config[key]);
        }
    }
    
    // E. Global Footer Text
    if (config.email_global_footer) {
        const footerEl = document.getElementById('global-footer-text');
        if(footerEl) footerEl.textContent = config.email_global_footer; 
    }

    // F. Feature Toggles (SMS Panel, Tenant Mode)
    if (config.multi_tenant_mode === false) {
        document.querySelectorAll('.module-tenant-switch').forEach(el => el.style.display = 'none');
    }
    if (!config.sms_provider) {
        document.querySelectorAll('.module-sms-panel').forEach(el => el.style.display = 'none');
    }

    // G. Theme Injection (CSS Variables)
    if (config.theme_primary_color) {
        document.documentElement.style.setProperty('--primary-color', config.theme_primary_color);
    }
    if (config.theme_secondary_color) {
        document.documentElement.style.setProperty('--secondary-color', config.theme_secondary_color);
        document.documentElement.style.setProperty('--classic-gold', config.theme_secondary_color);
    }
}

function generateWatermark(text) {
    const container = document.getElementById('bg-text-pattern');
    if (!container) return;
    container.innerHTML = Array(360).fill(`<div class="watermark-text">${text}</div>`).join('');
}

function isCacheExpired(cachedData) {
    if (!cachedData || !cachedData.timestamp) return true;
    return (Date.now() - new Date(cachedData.timestamp).getTime()) > MAX_CACHE_AGE_MS;
}

window.refreshGlobalSettings = () => {
    localStorage.removeItem(SETTINGS_CACHE_KEY);
    window.location.reload(); 
};