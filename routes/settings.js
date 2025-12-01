/**
 * routes/settings.js
 * Full & Final Version for Enterprise ERP
 * Includes: Config Load/Save + Dropdown Helpers + JSONB Support
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

const CONFIG_ID = '00000000-0000-0000-0000-000000000001'; 
const SETTINGS_TABLE = 'erp_settings'; 

// =========================================================
// 1. HELPER ROUTES (For Dropdowns)
// =========================================================

// Get All Academic Sessions (To select active session)
router.get('/academic-sessions/all', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, session_name, start_date FROM academic_sessions ORDER BY start_date DESC`);
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to fetch sessions" });
    }
});

// Get All Branches (To select default branch)
router.get('/branches/all', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, branch_name FROM branches ORDER BY branch_name ASC`);
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to fetch branches" });
    }
});

// =========================================================
// 2. MAIN CONFIGURATION ROUTES
// =========================================================

// GET CURRENT SETTINGS
router.get('/config/current', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${SETTINGS_TABLE} LIMIT 1`);
        
        if (result.rowCount === 0) {
            // Return default structure if table is empty
            return res.json({ id: CONFIG_ID, currency: 'INR', module_config: {} });
        }
        
        const row = result.rows[0];
        // Merge structured columns + JSON config into one object
        // This makes frontend work easier (no need to parse JSON there)
        res.json({ 
            ...row, 
            ...(row.module_config || {}) 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// UPDATE SETTINGS (Dynamic JSONB Logic)
router.put('/config/:id', authenticateToken, authorize(['Super Admin', 'Admin']), async (req, res) => {
    
    // 1. Define columns that exist physically in the table
    const fixedCols = [
        'active_session_id', 'default_branch_id', 'default_pay_frequency', 
        'library_fine_per_day', 'enable_self_registration', 'enforce_otp_login', 
        'allow_online_fee_payment', 'currency', 'mail_driver', 'sms_provider', 
        'school_logo_path', 'school_signature_path'
    ];
    
    // 2. Separate incoming data
    const dbPayload = {};
    const jsonPayload = {};
    
    Object.keys(req.body).forEach(key => {
        if (fixedCols.includes(key)) {
            dbPayload[key] = req.body[key];
        } else if (key !== 'id' && key !== 'module_config') {
            // All extra fields go into JSON
            jsonPayload[key] = req.body[key];
        }
    });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 3. Ensure the config row exists (Upsert Logic)
        const check = await client.query(`SELECT id FROM ${SETTINGS_TABLE} LIMIT 1`);
        let targetId = CONFIG_ID;
        
        if (check.rowCount === 0) {
            await client.query(`INSERT INTO ${SETTINGS_TABLE} (id, module_config) VALUES ($1, '{}')`, [CONFIG_ID]);
        } else {
            targetId = check.rows[0].id;
        }

        // 4. Build Dynamic SQL Query
        const sets = [];
        const vals = [];
        let idx = 1;
        
        // Add fixed columns to query
        Object.keys(dbPayload).forEach(k => { 
            sets.push(`${k}=$${idx++}`); 
            vals.push(dbPayload[k]); 
        });

        // Add JSONB data (Merge with existing data)
        if (Object.keys(jsonPayload).length > 0) {
            sets.push(`module_config = COALESCE(module_config, '{}'::jsonb) || $${idx++}`);
            vals.push(JSON.stringify(jsonPayload));
        }
        
        sets.push(`updated_at = CURRENT_TIMESTAMP`);
        vals.push(targetId); // Add ID as the last parameter

        const query = `UPDATE ${SETTINGS_TABLE} SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`;
        const result = await client.query(query, vals);
        
        await client.query('COMMIT');
        res.json(result.rows[0]);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Settings Update Error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

module.exports = router;