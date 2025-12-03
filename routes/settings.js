/**
 * routes/settings.js
 * ----------------------------------------------------
 * Enterprise ERP Settings Module
 * Features:
 * 1. Dynamic JSONB Storage for infinite settings.
 * 2. File Upload handling for Logos & Designs.
 * 3. Helper routes for dropdown population.
 */

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

// --- MULTER CONFIGURATION (For File Uploads) ---
// Ensure directory exists
const uploadDir = './public/uploads/designs';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Generate unique filename: fieldname-timestamp.ext
        // Example: school_logo-16788888.png
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

// Filter for images only
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

router.get('/academic-sessions/all', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, session_name AS name, start_date FROM academic_sessions ORDER BY start_date DESC`);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch sessions" });
    }
});

router.get('/branches/all', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, branch_name AS name FROM branches ORDER BY branch_name ASC`);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch branches" });
    }
});


// =========================================================
// 2. MAIN CONFIGURATION ROUTES
// =========================================================

// --- GET CURRENT SETTINGS ---
router.get('/config/current', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${SETTINGS_TABLE} LIMIT 1`);
        
        if (result.rowCount === 0) {
            // Default response if DB is empty
            return res.json({ id: CONFIG_ID, currency: 'INR', module_config: {} });
        }
        
        const row = result.rows[0];
        // Merge structured columns + JSON config into one flat object
        res.json({ 
            ...row, 
            ...(row.module_config || {}) 
        });
    } catch (e) {
        console.error("Settings Fetch Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- UPDATE SETTINGS (Supports Text + Files) ---
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
            // Construct public URL
            const fileUrl = `/uploads/designs/${file.filename}`;
            
            // Map specific files to fixed columns, others to JSON
            if (file.fieldname === 'school_logo') {
                dbPayload['school_logo_path'] = fileUrl;
            } else if (file.fieldname === 'school_signature') {
                dbPayload['school_signature_path'] = fileUrl;
            } else {
                // Backgrounds (ID card, Certificate etc.) go to JSON
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

module.exports = router;