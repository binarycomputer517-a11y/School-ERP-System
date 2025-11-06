// routes/settings.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Configuration ---
// Assuming settings are stored in a single row with ID '1'
// ⭐ CRITICAL FIX: Use the full UUID string to avoid SQL syntax errors.
const CONFIG_ID = '00000000-0000-0000-0000-000000000001'; 
const SETTINGS_TABLE = 'erp_settings'; 

// =========================================================
// Helper: Error Handling
// =========================================================
const handleSettingsError = (error, res, action) => {
    console.error(`Settings API Error (${action}):`, error);
    if (error.code === '42P01') { // undefined_table
        return res.status(500).json({ message: `Configuration table (${SETTINGS_TABLE}) missing or inaccessible.` });
    }
    res.status(500).json({ message: `Failed to ${action} settings due to a server error.` });
};


// =========================================================
// 1. DROPDOWN DATA ROUTES
// =========================================================

/**
 * @route   GET /api/settings/academic-sessions/all
 * @desc    Get all academic sessions for dropdown population.
 * @access  Private (Admin, Super Admin)
 */
router.get('/academic-sessions/all', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT id, session_name, start_date, end_date, is_active
            FROM academic_sessions 
            ORDER BY start_date DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        handleSettingsError(error, res, 'fetch academic sessions');
    }
});

/**
 * @route   GET /api/settings/branches/all
 * @desc    Get all branches for dropdown population.
 * @access  Private (Admin, Super Admin)
 */
router.get('/branches/all', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT id, branch_name 
            FROM branches 
            ORDER BY branch_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        handleSettingsError(error, res, 'fetch branches');
    }
});


// =========================================================
// 2. CONFIGURATION CRUD ROUTES
// =========================================================

/**
 * @route   GET /api/settings/config/current
 * @desc    Get the current single row of system configuration settings (ID 1).
 * @access  Private (Admin, Super Admin)
 */
router.get('/config/current', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `SELECT * FROM ${SETTINGS_TABLE} WHERE id = $1 LIMIT 1;`;
        const result = await pool.query(query, [CONFIG_ID]);

        if (result.rowCount === 0) {
            // If the row doesn't exist, return a default/empty structure
            return res.status(200).json({ 
                id: CONFIG_ID, 
                active_session_id: null,
                default_branch_id: null,
                library_fine_per_day: 5.00
            });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        handleSettingsError(error, res, 'fetch current settings');
    }
});


/**
 * @route   PUT /api/settings/config/1
 * @desc    Update the main system configuration record (ID 1).
 * @access  Private (Super Admin)
 */
router.put('/config/:id', authenticateToken, authorize(['Super Admin']), async (req, res) => {
    // Note: The front-end is hardcoded to PUT to /config/1
    // CRITICAL FIX: Ensure the ID matches the correct UUID
    if (req.params.id !== '1' && req.params.id !== CONFIG_ID) { 
        return res.status(400).json({ message: 'Configuration record ID mismatch.' });
    }
    
    const {
        active_session_id, default_branch_id, default_pay_frequency, library_fine_per_day,
        enable_self_registration, enforce_otp_login, allow_online_fee_payment
    } = req.body;

    const client = await pool.connect();
    try {
        // Attempt to update the existing record (ID 1)
        const updateQuery = `
            UPDATE ${SETTINGS_TABLE} SET
                active_session_id = $1, default_branch_id = $2, default_pay_frequency = $3, 
                library_fine_per_day = $4, enable_self_registration = $5, 
                enforce_otp_login = $6, allow_online_fee_payment = $7, updated_at = CURRENT_TIMESTAMP
            WHERE id = $8
            RETURNING *;
        `;
        const updateValues = [
            active_session_id, default_branch_id, default_pay_frequency, library_fine_per_day,
            enable_self_registration, enforce_otp_login, allow_online_fee_payment,
            CONFIG_ID
        ];

        let result = await client.query(updateQuery, updateValues);

        // If no rows were updated, INSERT the record (Upsert logic for ID 1)
        if (result.rowCount === 0) {
            const insertQuery = `
                INSERT INTO ${SETTINGS_TABLE} (
                    id, active_session_id, default_branch_id, default_pay_frequency, 
                    library_fine_per_day, enable_self_registration, enforce_otp_login, 
                    allow_online_fee_payment
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *;
            `;
            result = await client.query(insertQuery, [CONFIG_ID, ...updateValues.slice(0, 7)]);
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        handleSettingsError(error, res, 'update settings');
    } finally {
        client.release();
    }
});


module.exports = router;