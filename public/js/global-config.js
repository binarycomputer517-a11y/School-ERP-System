/**
 * Global Configuration Loader (Enterprise ERP)
 * Updated to avoid variable naming conflicts
 */

const SETTINGS_CACHE_KEY = 'erp_settings';
// Renamed to avoid conflict with other scripts using 'API_ENDPOINT'
const GLOBAL_CONFIG_API = '/api/settings/config/current'; 

document.addEventListener('DOMContentLoaded', async () => {
    await initGlobalSettings();
});

async function initGlobalSettings() {
    let settings = localStorage.getItem(SETTINGS_CACHE_KEY);
    
    if (!settings) {
        const token = localStorage.getItem('token');
        if (token) {
            try {
                // Updated variable name here
                const res = await fetch(GLOBAL_CONFIG_API, { 
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (res.status === 401) {
                    console.warn("Session expired");
                    return;
                }

                const data = await res.json();
                localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(data));
                settings = data;
            } catch (e) { 
                console.error("Global Config: Failed to fetch settings", e);
                return; 
            }
        }
    } else {
        settings = JSON.parse(settings);
    }

    if(settings) {
        applySettingsToUI(settings);
    }
}

function applySettingsToUI(config) {
    // A. Branding
    if (config.school_logo_path) {
        document.querySelectorAll('.global-school-logo, #global-school-logo').forEach(img => {
            img.src = config.school_logo_path;
        });
    }

    // B. Currency
    const symbol = config.currency === 'USD' ? '$' : '₹';
    document.querySelectorAll('.currency-symbol').forEach(el => {
        el.innerText = symbol;
    });

    // C. School Name & Footer
    if (config.school_name) {
        document.querySelectorAll('.global-school-name').forEach(el => el.innerText = config.school_name);
    }
    
    if (config.email_global_footer) {
        const footerEl = document.getElementById('global-footer-text');
        if(footerEl) footerEl.innerHTML = config.email_global_footer;
    }

    // D. Feature Toggles
    if (config.multi_tenant_mode === false) {
        document.querySelectorAll('.module-tenant-switch').forEach(el => el.style.display = 'none');
    }
    if (!config.sms_provider) {
        document.querySelectorAll('.module-sms-panel').forEach(el => el.style.display = 'none');
    }

    // E. Theme Colors
    if (config.theme_primary_color) {
        document.documentElement.style.setProperty('--primary-color', config.theme_primary_color);
        document.documentElement.style.setProperty('--classic-gold', config.theme_secondary_color);
    }
}

function refreshGlobalSettings() {
    localStorage.removeItem(SETTINGS_CACHE_KEY);
    initGlobalSettings();
}