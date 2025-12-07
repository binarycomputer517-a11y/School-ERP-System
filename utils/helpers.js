// utils/helpers.js

/**
 * Safely Convert String to UUID or Null
 * @param {string} value - The string value to convert.
 * @returns {string|null} - Valid UUID string or null.
 */
function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    // Basic check for UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(value.trim())) {
        return value.trim();
    }
    return null; 
}

module.exports = {
    toUUID
};