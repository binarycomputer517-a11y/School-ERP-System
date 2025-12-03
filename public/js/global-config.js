/**
 * Global Configuration Loader (Enterprise ERP)
 * ---------------------------------------------
 * Final Version: Fixed Token Key Mismatch ('erp-token')
 * This script runs on EVERY page load to apply settings globally.
 */

const SETTINGS_CACHE_KEY = 'erp_settings';
const GLOBAL_CONFIG_API = '/api/settings/config/current'; 

// Run immediately when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    await initGlobalSettings();
});

async function initGlobalSettings() {
    let settings = localStorage.getItem(SETTINGS_CACHE_KEY);
    
    // 1. If Cache Miss (First time load or Cache Cleared)
    if (!settings) {
        // FIX: Changed 'token' to 'erp-token' to match your Login System
        const token = localStorage.getItem('erp-token');
        
        // Only fetch if user is logged in
        if (token) {
            try {
                const res = await fetch(GLOBAL_CONFIG_API, { 
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                // --- SECURITY UPDATE: PREVENT AUTO LOGOUT ---
                if (res.status === 401) {
                    console.warn("Session warning: Server returned 401.");
                    // We DO NOT redirect here automatically to prevent issues during server restarts
                    // window.location.href = '/login.html'; 
                    return;
                }

                if (!res.ok) throw new Error("Failed to fetch settings");

                const data = await res.json();
                
                // Save to Cache for faster load next time
                localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(data));
                settings = data;
                
            } catch (e) { 
                console.error("Global Config: Failed to sync settings", e);
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
    const symbol = config.currency === 'USD' ? '$' : (config.currency === 'EUR' ? '€' : '₹');
    document.querySelectorAll('.currency-symbol').forEach(el => {
        el.innerText = symbol;
    });

    // --- C. School Identity (Name, Address, Contact) ---
    if (config.school_name) {
        document.querySelectorAll('.global-school-name').forEach(el => el.innerText = config.school_name);
    }
    if (config.school_address) {
        document.querySelectorAll('.global-school-address').forEach(el => el.innerText = config.school_address);
    }
    if (config.school_email) {
        document.querySelectorAll('.global-school-email').forEach(el => el.innerText = config.school_email);
    }
    if (config.school_phone) {
        document.querySelectorAll('.global-school-phone').forEach(el => el.innerText = config.school_phone);
    }
    
    // --- D. Global Footer Text ---
    if (config.email_global_footer) {
        const footerEl = document.getElementById('global-footer-text');
        if(footerEl) footerEl.innerHTML = config.email_global_footer;
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
        document.documentElement.style.setProperty('--classic-gold', config.theme_secondary_color);
    }
}

/**
 * Helper: Force Reload Settings
 */
function refreshGlobalSettings() {
    localStorage.removeItem(SETTINGS_CACHE_KEY);
    initGlobalSettings();
}