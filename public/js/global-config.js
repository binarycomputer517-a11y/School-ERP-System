/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * Final Version: Fixed Token Key Mismatch ('erp-token')
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
            // Load from non-expired cache
            settings = cached.data;
        } else {
            // Cache expired, needs refresh
            localStorage.removeItem(SETTINGS_CACHE_KEY); 
        }
    }

    // 2. Fetch from API if settings are null (cache miss or expired)
    if (!settings) {
        const token = localStorage.getItem('erp-token');
        
        if (token) {
            try {
                const res = await fetch(GLOBAL_CONFIG_API, { 
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (res.status === 401) {
                    // Log session warning but allow the page to load with default styles
                    console.warn("Session warning: Authentication required to fetch current settings.");
                    return null;
                }

                if (!res.ok) throw new new Error(`Failed to fetch settings. Status: ${res.status}`);

                const data = await res.json();
                
                // Save to Cache with timestamp
                localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({
                    data: data,
                    timestamp: new Date().toISOString()
                }));
                settings = data;
                
            } catch (e) { 
                console.error("Global Config: Failed to sync settings", e);
                // Return null if fetch failed
                return null; 
            }
        }
    }

    // 3. Apply Settings to the UI and return the object
    if(settings) {
        applySettingsToUI(settings);
        return settings; // Expose settings globally via the return value
    }
    return null;
}

function applySettingsToUI(config) {
    
    // --- A. Branding (Logo & Favicon) ---
    if (config.school_logo_path) {
        // Update all logo images on the page
        document.querySelectorAll('.global-school-logo').forEach(img => {
            img.src = config.school_logo_path;
            img.alt = config.school_name || "School Logo"; // Accessibility improvement
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

    // --- B. Currency Formatting ---
    const symbol = config.currency === 'USD' ? '$' : (config.currency === 'EUR' ? '€' : (config.currency === 'INR' ? '₹' : config.currency || '₹'));
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
        // Use textContent for safety unless rich HTML is expected
        if(footerEl) footerEl.textContent = config.email_global_footer; 
    }

    // --- E. Feature Toggles (Hide/Show Modules) ---
    // Hide Multi-Tenant fields if disabled
    if (config.multi_tenant_mode === false) {
        document.querySelectorAll('.module-tenant-switch').forEach(el => el.style.display = 'none');
    }
    // Hide SMS panel if no provider is configured
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
    // Reload the page to re-run the initialization logic
    window.location.reload(); 
}

// Optionally expose the refresh function globally
window.refreshGlobalSettings = refreshGlobalSettings;