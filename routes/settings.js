// routes/settings.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// --- CONSTANTS ---
const CONFIG_ID = '00000000-0000-0000-0000-000000000001'; 
const SETTINGS_TABLE = 'erp_settings'; 
const COMPLIANCE_ROLES = ['Super Admin', 'Prime Admin'];
const CRUD_ROLES = ['Super Admin', 'Admin'];


// --- MULTER CONFIGURATION (For File Uploads) ---
const uploadDir = './public/uploads/designs';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed!'), false);
    }
};
const upload = multer({ storage: storage, fileFilter: fileFilter });


// =========================================================
// 1. HELPER ROUTES (For Dropdowns)
// =========================================================
router.get('/academic-sessions/all', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, session_name AS name, start_date FROM academic_sessions ORDER BY start_date DESC`);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch sessions" });
    }
});

router.get('/branches/all', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, branch_name AS name FROM branches ORDER BY branch_name ASC`);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch branches" });
    }
});


// =========================================================
// 2. GLOBAL/DEFAULT SETTINGS ROUTES 
// =========================================================

/**
 * @route GET /api/settings/global
 * @desc Get high-level global settings (e.g., default branch ID).
 * @access Private (Admin or Super Admin)
 */
router.get('/global', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT default_branch_id, COALESCE(module_config, '{}'::jsonb) AS module_config
            FROM ${SETTINGS_TABLE} 
            LIMIT 1;
        `;
        const result = await pool.query(query);

        if (result.rows.length === 0) {
            return res.status(200).json({});
        }

        const settings = result.rows[0];
        
        res.status(200).json({
            default_branch_id: settings.default_branch_id || null, 
            currency: settings.module_config.currency || 'INR', 
        });

    } catch (error) {
        console.error('Error fetching global settings:', error);
        res.status(500).json({ message: 'Failed to retrieve global settings.' });
    }
});

/**
 * @route PUT /api/settings/global
 * @desc Update high-level global settings (e.g., set default branch ID).
 * @access Private (Super Admin)
 */
router.put('/global', authenticateToken, authorize(['Super Admin']), async (req, res) => {
    const { default_branch_id } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const check = await client.query(`SELECT id FROM ${SETTINGS_TABLE} LIMIT 1`);
        let targetId = CONFIG_ID;
        
        if (check.rowCount === 0) {
            await client.query(`INSERT INTO ${SETTINGS_TABLE} (id) VALUES ($1)`, [CONFIG_ID]);
        } else {
            targetId = check.rows[0].id;
        }

        const updateQuery = `
            UPDATE ${SETTINGS_TABLE}
            SET default_branch_id = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING default_branch_id;
        `;
        const result = await client.query(updateQuery, [default_branch_id, targetId]);
        
        await client.query('COMMIT');
        res.status(200).json({ 
            success: true, 
            message: "Global settings updated.",
            default_branch_id: result.rows[0]?.default_branch_id
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating global settings:', error);
        res.status(500).json({ message: 'Failed to update global settings.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 3. MAIN CONFIGURATION ROUTES (config/current & config/:id)
// =========================================================

/**
 * @route GET /api/settings/config/current
 * @desc Get ALL current settings (Public/Auth agnostic for global access)
 * @access PUBLIC ACCESS (Only needs DB to run) 🚨 FIX FOR 403 ERROR 🚨
 */
router.get('/config/current', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${SETTINGS_TABLE} LIMIT 1`);
        
        if (result.rowCount === 0) {
            return res.json({ id: CONFIG_ID, currency: 'INR', module_config: {} });
        }
        
        const row = result.rows[0];
        // Combine fixed columns and JSONB module_config properties
        res.json({ 
            ...row, 
            ...(row.module_config || {}) 
        });
    } catch (e) {
        console.error("Public Settings Fetch Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- UPDATE SETTINGS (config/:id) ---
router.put('/config/:id', authenticateToken, authorize(['Super Admin', 'Admin']), upload.any(), async (req, res) => {
    
    // 1. Define Fixed Columns (That exist in DB schema)
    const fixedCols = [
        'active_session_id', 'default_branch_id', 'default_pay_frequency', 
        'library_fine_per_day', 'enable_self_registration', 'enforce_otp_login', 
        'allow_online_fee_payment', 'currency', 'mail_driver', 'sms_provider', 
        'school_logo_path', 'school_signature_path'
    ];
    
    const dbPayload = {};
    const jsonPayload = {};
    
    // 2. Process Text Fields (req.body)
    Object.keys(req.body).forEach(key => {
        if (fixedCols.includes(key)) {
            dbPayload[key] = req.body[key];
        } else if (key !== 'id' && key !== 'module_config') {
            jsonPayload[key] = req.body[key];
        }
    });

    // 3. Process Uploaded Files (req.files)
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            const fileUrl = `/uploads/designs/${file.filename}`;
            
            if (file.fieldname === 'school_logo') {
                dbPayload['school_logo_path'] = fileUrl;
            } else if (file.fieldname === 'school_signature') {
                dbPayload['school_signature_path'] = fileUrl;
            } else {
                jsonPayload[file.fieldname] = fileUrl;
            }
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 4. Upsert Logic (Insert if not exists)
        const check = await client.query(`SELECT id FROM ${SETTINGS_TABLE} LIMIT 1`);
        let targetId = CONFIG_ID;
        
        if (check.rowCount === 0) {
            await client.query(`INSERT INTO ${SETTINGS_TABLE} (id, module_config) VALUES ($1, '{}')`, [CONFIG_ID]);
        } else {
            targetId = check.rows[0].id;
        }

        // 5. Build Dynamic SQL
        const sets = [];
        const vals = [];
        let idx = 1;
        
        // Add fixed columns
        Object.keys(dbPayload).forEach(k => { 
            sets.push(`${k}=$${idx++}`); 
            vals.push(dbPayload[k]); 
        });

        // Add JSONB data (Merge with existing)
        if (Object.keys(jsonPayload).length > 0) {
            sets.push(`module_config = COALESCE(module_config, '{}'::jsonb) || $${idx++}`);
            vals.push(JSON.stringify(jsonPayload));
        }
        
        sets.push(`updated_at = CURRENT_TIMESTAMP`);
        vals.push(targetId);

        // Execute Update
        const query = `UPDATE ${SETTINGS_TABLE} SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`;
        const result = await client.query(query, vals);
        
        await client.query('COMMIT');
        
        // Return merged data
        const row = result.rows[0];
        res.json({ 
            success: true, 
            settings: { ...row, ...(row.module_config || {}) } 
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Settings Update Error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});


// =========================================================
// 4. COMPLIANCE MANAGEMENT ROUTES
// =========================================================

/**
 * @route GET /api/settings/compliance
 * @desc Fetch current global compliance settings from JSONB module_config.
 * @access Private (Super Admin, Prime Admin)
 */
router.get('/compliance', authenticateToken, authorize(COMPLIANCE_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`SELECT module_config FROM ${SETTINGS_TABLE} LIMIT 1`);
        
        if (result.rowCount === 0) {
            return res.status(200).json({}); // Return empty object
        }
        
        // Extract compliance settings from the JSONB column
        const moduleConfig = result.rows[0].module_config || {};
        const complianceSettings = {
            gdpr_consent_required: moduleConfig.gdpr_consent_required || false,
            data_retention_days: moduleConfig.data_retention_days || 365,
            anonymize_after_retention: moduleConfig.anonymize_after_retention || false,
            audit_log_retention_days: moduleConfig.audit_log_retention_days || 180,
            force_mfa_admins: moduleConfig.force_mfa_admins || false,
        };
        
        res.json(complianceSettings);

    } catch (e) {
        console.error("Compliance Settings Fetch Error:", e);
        res.status(500).json({ message: "Failed to retrieve compliance settings." });
    }
});

/**
 * @route PUT /api/settings/compliance
 * @desc Update global compliance settings (stored in JSONB module_config).
 * @access Private (Super Admin)
 */
router.put('/compliance', authenticateToken, authorize(['Super Admin']), async (req, res) => {
    const newComplianceSettings = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Ensure the settings row exists (Upsert)
        const check = await client.query(`SELECT id FROM ${SETTINGS_TABLE} LIMIT 1`);
        if (check.rowCount === 0) {
            await client.query(`INSERT INTO ${SETTINGS_TABLE} (id) VALUES ($1)`, [CONFIG_ID]);
        }

        // 2. Build the JSONB payload
        const jsonPayload = JSON.stringify(newComplianceSettings);

        // 3. Update the module_config JSONB column, merging the new compliance settings
        const updateQuery = `
            UPDATE ${SETTINGS_TABLE}
            SET module_config = COALESCE(module_config, '{}'::jsonb) || $1::jsonb,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING *;
        `;
        await client.query(updateQuery, [jsonPayload, CONFIG_ID]);
        
        await client.query('COMMIT');
        res.status(200).json({ success: true, message: "Compliance settings saved." });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Compliance Settings Update Error:", e);
        res.status(500).json({ message: "Failed to update compliance settings." });
    } finally {
        client.release();
    }
});


module.exports = router;