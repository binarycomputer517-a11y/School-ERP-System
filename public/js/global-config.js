/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * This script runs on EVERY page load.
 * It fetches settings from LocalStorage (fast) or Server (slow)
 * and applies branding, currency, and logic globally.
 */

const SETTINGS_CACHE_KEY = 'erp_settings';
const API_ENDPOINT = '/api/settings/config/current';

// Run immediately when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    await initGlobalSettings();
});

async function initGlobalSettings() {
    let settings = localStorage.getItem(SETTINGS_CACHE_KEY);
    
    // 1. If Cache Miss (First time load or Cache Cleared)
    if (!settings) {
        const token = localStorage.getItem('token');
        
        // Only fetch if user is logged in
        if (token) {
            try {
                const res = await fetch(API_ENDPOINT, { 
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (res.status === 401) {
                    // Token Expired - Redirect to Login
                    console.warn("Session expired");
                    // window.location.href = '/login.html'; // Uncomment for production
                    return;
                }

                const data = await res.json();
                
                // Save to Cache for faster load next time
                localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(data));
                settings = data;
                
            } catch (e) { 
                console.error("Global Config: Failed to fetch settings from server", e);
                return; 
            }
        }
    } else {
        // Load from Cache
        settings = JSON.parse(settings);
    }

    // 2. Apply Settings to the UI
    if(settings) {
        applySettingsToUI(settings);
    }
}

function applySettingsToUI(config) {
    
    // --- A. Branding (Logo & Favicon) ---
    if (config.school_logo_path) {
        // Update all logo images on the page
        document.querySelectorAll('.global-school-logo, #global-school-logo').forEach(img => {
            img.src = config.school_logo_path;
        });

        // Optional: Update Favicon dynamically
        /*
        let link = document.querySelector("link[rel~='icon']");
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.getElementsByTagName('head')[0].appendChild(link);
        }
        link.href = config.school_logo_path;
        */
    }

    // --- B. Currency Formatting ---
    const symbol = config.currency === 'USD' ? '$' : '₹';
    document.querySelectorAll('.currency-symbol').forEach(el => {
        el.innerText = symbol;
    });

    // --- C. School Name & Footer ---
    if (config.school_name) {
        document.querySelectorAll('.global-school-name').forEach(el => el.innerText = config.school_name);
    }
    
    if (config.email_global_footer) {
        // If you have a footer element
        const footerEl = document.getElementById('global-footer-text');
        if(footerEl) footerEl.innerHTML = config.email_global_footer;
    }

    // --- D. Feature Toggles (Hide/Show Modules) ---
    // Example: If 'Multi-Tenant' is OFF, hide tenant switcher
    if (config.multi_tenant_mode === false) {
        document.querySelectorAll('.module-tenant-switch').forEach(el => el.style.display = 'none');
    }

    // Example: Hide SMS Panel if provider is missing
    if (!config.sms_provider) {
        document.querySelectorAll('.module-sms-panel').forEach(el => el.style.display = 'none');
    }

    // --- E. Theme Colors (Advanced CSS Variables) ---
    // If you add a 'theme_color' field in DB later, this will work automatically
    if (config.theme_primary_color) {
        document.documentElement.style.setProperty('--primary-color', config.theme_primary_color);
        document.documentElement.style.setProperty('--classic-gold', config.theme_secondary_color);
    }
}

/**
 * Helper: Force Reload Settings
 * Call this function after saving settings in Admin Panel
 */
function refreshGlobalSettings() {
    localStorage.removeItem(SETTINGS_CACHE_KEY);
    initGlobalSettings();
}