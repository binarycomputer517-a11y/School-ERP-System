/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * Final Version: Fixed Token, Cache, and Recursion Errors.
 * This script runs on EVERY page load to apply settings globally.
 */

const SETTINGS_CACHE_KEY = 'erp_settings';
const GLOBAL_CONFIG_API = '/api/settings/config/current'; 
const MAX_CACHE_AGE_MS = 3600000; // 1 hour (3600 seconds * 1000 ms)

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
    if (!settings) {
        // Since /api/settings/config/current is now PUBLIC (403 fix)
        // We fetch it without relying on the JWT token.
        const token = localStorage.getItem('erp-token');
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        
        try {
            const res = await fetch(GLOBAL_CONFIG_API, { headers });

            if (!res.ok) {
                // ✅ FIX: Removed extra 'new' keyword to fix TypeError
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
            // Return null if fetch failed (use default UI state)
            return null; 
        }
    }

    // 3. Apply Settings to the UI and return the object
    if(settings) {
        applySettingsToUI(settings);
        return settings; // Expose settings globally via the return value
    }
    
    // If no settings are found or fetched, return null
    return null;
}

function applySettingsToUI(config) {
    
    // --- A. Branding (Logo & Favicon) ---
    if (config.school_logo_path) {
        document.querySelectorAll('.global-school-logo').forEach(img => {
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
    }

    // --- B. Currency Formatting (FIXED) ---
    // Determine the symbol and locale
    let symbol = '₹';
    let locale = 'en-IN'; // Defaulting to Indian locale for formatting

    switch (config.currency) {
        case 'USD':
            symbol = '$';
            locale = 'en-US';
            break;
        case 'EUR':
            symbol = '€';
            locale = 'de-DE'; // German locale often used for Euro formatting
            break;
        case 'INR':
        default:
            symbol = '₹';
            locale = 'en-IN'; // Indian numeral system (lakhs, crores)
            break;
    }
    
    // Globally define a currency formatter function for other scripts
    window.formatCurrency = (amount) => {
        if (amount === undefined || amount === null || isNaN(amount)) return `${symbol} 0.00`;
        
        // Convert to Number, fix to 2 decimal places (returns string), then apply locale formatting
        // ✅ FIX: Apply locale string formatting to the numerical value, using grouping and 2 decimal places.
        // Using Number.toFixed(2) + toLocaleString() is complex, better to use Intl.NumberFormat for clean display:
        
        const formatter = new Intl.NumberFormat(locale, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
            useGrouping: true // Crucial for number grouping (like 1,00,000 for en-IN)
        });
        
        const formattedAmount = formatter.format(Number(amount));

        return `${symbol} ${formattedAmount}`;
    };
    
    // Apply currency symbol to static elements
    document.querySelectorAll('.currency-symbol').forEach(el => {
        el.innerText = symbol;
    });

    // --- C. School Identity (Name, Address, Contact) ---
    const identityMap = {
        school_name: '.global-school-name',
        school_address: '.global-school-address',
        school_email: '.global-school-email',
        school_phone: '.global-school-phone'
    };
    
    for (const key in identityMap) {
        if (config[key]) {
            document.querySelectorAll(identityMap[key]).forEach(el => el.innerText = config[key]);
        }
    }
    
    // --- D. Global Footer Text ---
    if (config.email_global_footer) {
        const footerEl = document.getElementById('global-footer-text');
        if(footerEl) footerEl.textContent = config.email_global_footer; 
    }

    // --- E. Feature Toggles (Hide/Show Modules) ---
    if (config.multi_tenant_mode === false) {
        document.querySelectorAll('.module-tenant-switch').forEach(el => el.style.display = 'none');
    }
    if (!config.sms_provider) {
        document.querySelectorAll('.module-sms-panel').forEach(el => el.style.display = 'none');
    }

    // --- F. Theme Colors (Advanced CSS Variables) ---
    if (config.theme_primary_color) {
        document.documentElement.style.setProperty('--primary-color', config.theme_primary_color);
    }
    if (config.theme_secondary_color) {
        document.documentElement.style.setProperty('--classic-gold', config.theme_secondary_color);
    }
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