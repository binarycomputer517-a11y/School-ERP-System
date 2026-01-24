const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

const BRANCHES_TABLE = 'branches';
const USERS_TABLE = 'users';
const AUTH_ROLES = ['Super Admin', 'superadmin'];

// =========================================================
// ১. GET ALL BRANCHES (Statistics সহ)
// =========================================================
router.get('/', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                b.*,
                (SELECT COUNT(*) FROM students s WHERE s.branch_id = b.id) AS total_students
            FROM ${BRANCHES_TABLE} b
            ORDER BY b.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Fetch Branches Error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// =========================================================
// ২. FULL PROVISION (Transaction logic: Branch + Admin User)
// =========================================================
router.post('/full-provision', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const upload = req.app.get('upload').fields([
        { name: 'logo', maxCount: 1 },
        { name: 'photo', maxCount: 1 }
    ]);

    upload(req, res, async (err) => {
        if (err) return res.status(400).json({ message: 'File upload error', error: err });

        const client = await pool.connect();
        try {
            const branch = JSON.parse(req.body.branch_info);
            const user = JSON.parse(req.body.user_info);

            const logoPath = req.files['logo'] ? `/uploads/media/${req.files['logo'][0].filename}` : null;
            const photoPath = req.files['photo'] ? `/uploads/teacher_photos/${req.files['photo'][0].filename}` : null;

            await client.query('BEGIN'); // Database Transaction Start

            // ১. ব্রাঞ্চ ইনসার্ট (Infrastructure এবং GPS কলাম সহ)
            const branchQuery = `
                INSERT INTO ${BRANCHES_TABLE} (
                    branch_name, branch_code, address, email, 
                    pan_number, gst_number, branch_manager_name, 
                    bank_name, account_number, ifsc_code, 
                    pin_code, logo_url, manager_photo, is_active,
                    lab_count, class_capacity, faculty_count,
                    latitude, longitude
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14, $15, $16, $17, $18)
                RETURNING id;
            `;
            const branchRes = await client.query(branchQuery, [
                branch.branch_name, branch.branch_code, branch.address, branch.email,
                branch.pan_number, branch.gst_number, branch.branch_manager_name,
                branch.bank_name, branch.account_number, branch.ifsc_code,
                branch.pin_code, logoPath, photoPath,
                branch.lab_count || 0, branch.class_capacity || 0, branch.faculty_count || 0,
                branch.latitude || null, branch.longitude || null
            ]);

            const newBranchId = branchRes.rows[0].id;

            // ২. অ্যাডমিন ইউজার তৈরি
            const hashedPassword = await bcrypt.hash(user.password, 10);
            const userQuery = `
                INSERT INTO ${USERS_TABLE} (
                    username, password_hash, role, branch_id, 
                    full_name, status, is_active
                ) VALUES ($1, $2, $3, $4, $5, 'active', true);
            `;
            await client.query(userQuery, [
                user.username, hashedPassword, user.role, 
                newBranchId, branch.branch_manager_name
            ]);

            await client.query('COMMIT'); 
            res.status(201).json({ message: 'Branch Provisioning Successful' });

        } catch (error) {
            await client.query('ROLLBACK'); 
            console.error('Provisioning Error:', error);
            res.status(500).json({ message: 'Deployment Failed', error: error.message });
        } finally {
            client.release();
        }
    });
});

// =========================================================
// ৩. UPDATE BRANCH (Infrastructure এবং GPS Support সহ)
// =========================================================
router.put('/:id', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const upload = req.app.get('upload').fields([
        { name: 'logo', maxCount: 1 },
        { name: 'photo', maxCount: 1 }
    ]);

    upload(req, res, async (err) => {
        const branchId = req.params.id;
        try {
            const data = req.body.branch_info ? JSON.parse(req.body.branch_info) : req.body;
            
            const logoPath = req.files && req.files['logo'] ? `/uploads/media/${req.files['logo'][0].filename}` : data.logo_url;
            const photoPath = req.files && req.files['photo'] ? `/uploads/teacher_photos/${req.files['photo'][0].filename}` : data.manager_photo;

            const query = `
                UPDATE ${BRANCHES_TABLE}
                SET branch_name = COALESCE($1, branch_name),
                    branch_code = COALESCE($2, branch_code),
                    address = COALESCE($3, address),
                    email = COALESCE($4, email),
                    pan_number = COALESCE($5, pan_number),
                    gst_number = COALESCE($6, gst_number),
                    branch_manager_name = COALESCE($7, branch_manager_name),
                    bank_name = COALESCE($8, bank_name),
                    account_number = COALESCE($9, account_number),
                    pin_code = COALESCE($10, pin_code),
                    logo_url = COALESCE($11, logo_url),
                    manager_photo = COALESCE($12, manager_photo),
                    is_active = COALESCE($13, is_active),
                    lab_count = COALESCE($14, lab_count),
                    class_capacity = COALESCE($15, class_capacity),
                    faculty_count = COALESCE($16, faculty_count),
                    latitude = COALESCE($17, latitude),
                    longitude = COALESCE($18, longitude),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $19::uuid
                RETURNING *;
            `;
            
            const values = [
                data.branch_name, data.branch_code, data.address, data.email,
                data.pan_number, data.gst_number, data.branch_manager_name,
                data.bank_name, data.account_number, data.pin_code,
                logoPath, photoPath, data.is_active,
                data.lab_count, data.class_capacity, data.faculty_count,
                data.latitude, data.longitude,
                branchId
            ];

            const result = await pool.query(query, values);
            res.status(200).json({ message: 'Update Successful', branch: result.rows[0] });

        } catch (error) {
            console.error('Update Error:', error);
            res.status(500).json({ message: 'Update Failed' });
        }
    });
});

// =========================================================
// ৪. DELETE BRANCH
// =========================================================
router.delete('/:id', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const branchId = req.params.id;
    try {
        const result = await pool.query(`DELETE FROM ${BRANCHES_TABLE} WHERE id = $1::uuid`, [branchId]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Not Found' });
        res.status(200).json({ message: 'Purged' });
    } catch (error) {
        if (error.code === '23503') {
            return res.status(409).json({ message: 'Branch has active records and cannot be deleted.' });
        }
        res.status(500).json({ message: 'Purge Failed' });
    }
});

// =========================================================
// ৫. GET SINGLE BRANCH (Profile Preview এর জন্য)
// =========================================================
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const branchId = req.params.id;
        const query = `
            SELECT b.*, 
            (SELECT COUNT(*) FROM students s WHERE s.branch_id = b.id) AS total_students 
            FROM ${BRANCHES_TABLE} b 
            WHERE b.id = $1::uuid`;
        
        const result = await pool.query(query, [branchId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Branch not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Fetch branch by ID error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

module.exports = router;