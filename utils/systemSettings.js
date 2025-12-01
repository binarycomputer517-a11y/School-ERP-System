/**
 * utils/systemSettings.js
 * ------------------------------------------------------------------
 * Enterprise Configuration Loader with Caching
 * Purpose: Fetches settings from DB once and caches them to reduce server load.
 */

const { pool } = require('../database');

// --- In-Memory Cache Variables ---
let _settingsCache = null;      // Stores the settings in RAM
let _lastFetchTime = 0;         // Tracks when data was last fetched
const CACHE_TTL = 60 * 1000;    // Cache duration: 60 Seconds (1 Minute)

/**
 * Fetches merged system settings (Fixed Cols + JSON Config).
 * Uses caching to prevent hitting the database on every single request.
 * * @param {boolean} forceRefresh - If true, ignores cache and hits DB immediately.
 */
const getSystemSettings = async (forceRefresh = false) => {
    const now = Date.now();

    // 1. Check Cache: If data exists and is less than 60 seconds old, return it.
    if (!forceRefresh && _settingsCache && (now - _lastFetchTime < CACHE_TTL)) {
        return _settingsCache;
    }

    try {
        // 2. Hit Database (Only if cache is expired or empty)
        const result = await pool.query('SELECT * FROM erp_settings LIMIT 1');

        if (result.rowCount === 0) {
            // Default Fallback if DB is empty
            return { currency: 'INR', module_config: {} }; 
        }
        
        const row = result.rows[0];

        // 3. Merge & Flatten Data
        // Combines standard columns with the JSONB data into one flat object
        const mergedSettings = {
            ...row,
            ...(row.module_config || {}) 
        };

        // Optional: Remove the raw JSON object to keep the result clean
        delete mergedSettings.module_config;

        // 4. Update Cache
        _settingsCache = mergedSettings;
        _lastFetchTime = now;

        return mergedSettings;

    } catch (error) {
        console.error("CRITICAL: Error loading system settings:", error);
        // If DB fails, try to return old cache instead of crashing
        return _settingsCache || {};
    }
};

module.exports = { getSystemSettings };