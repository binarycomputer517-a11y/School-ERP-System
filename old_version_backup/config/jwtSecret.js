/**
 * config/jwtSecret.js
 * ----------------------------------------------
 * Centralized JWT Secret Configuration
 * Purpose: Ensures the same secret key is used across the entire application 
 * to prevent 'Auto Logout' issues when the server restarts.
 */

module.exports = {
    // 1. First, try to get the secret from the Server Environment (Best Security)
    // 2. If not found, use this Hardcoded String (Backup to prevent random generation)
    secret: process.env.JWT_SECRET || "MyFixed_Super_Secret_Key_2026_SchoolERP_Secure"
};