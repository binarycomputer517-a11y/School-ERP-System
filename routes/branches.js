/**
 * @fileoverview Branches & Campus Provisioning Router
 * @version 2.9.5 (Final Production - Auto Email & ID Sync)
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const { sendManagerProvisionEmail } = require('../utils/mailer'); // 🎯 ইমেইল সার্ভিস ইম্পোর্ট

const BRANCHES_TABLE = 'branches';
const USERS_TABLE = 'users';
const AUTH_ROLES = ['Super Admin', 'superadmin', 'Prime Admin', 'Admin', 'admin'];

// =========================================================
// 1. GET ALL BRANCHES (With Manager ID Sync & Live Stats)
// =========================================================
router.get('/', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                b.*,
                u.id AS manager_user_id,
                (SELECT COUNT(*) FROM students s WHERE s.branch_id = b.id) AS total_students
            FROM ${BRANCHES_TABLE} b
            LEFT JOIN ${USERS_TABLE} u ON u.branch_id = b.id 
                AND u.role::text ILIKE 'admin'
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
// 2. FULL PROVISION (Transaction logic: Branch + Admin User + Email)
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

            let sanitizedRole = user.role || 'Admin';
            if (sanitizedRole.toLowerCase() === 'admin') sanitizedRole = 'Admin';

            // Atomic Transaction শুরু
            await client.query('BEGIN'); 

            // A. ব্রাঞ্চ তৈরি
            const branchQuery = `
                INSERT INTO ${BRANCHES_TABLE} (
                    branch_name, branch_code, address, email, 
                    branch_manager_name, logo_url, manager_photo, is_active,
                    lab_count, class_capacity, faculty_count
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10)
                RETURNING id;
            `;
            
            const branchRes = await client.query(branchQuery, [
                branch.branch_name, branch.branch_code, branch.address, branch.email,
                branch.branch_manager_name, logoPath, photoPath,
                branch.lab_count || 0, branch.class_capacity || 0, branch.faculty_count || 0
            ]);

            const newBranchId = branchRes.rows[0].id;

            // B. অ্যাডমিন ইউজার তৈরি
            const hashedPassword = await bcrypt.hash(user.password, 10);
            const userQuery = `
                INSERT INTO ${USERS_TABLE} (
                    username, password_hash, role, branch_id, email,
                    full_name, status, is_active
                ) VALUES ($1, $2, $3, $4, $5, $6, 'active', true)
                RETURNING id, email, full_name;
            `;
            
            const userRes = await client.query(userQuery, [
                user.username, hashedPassword, sanitizedRole, newBranchId, 
                branch.email, // ব্রাঞ্চ ইমেইল ইউজারের জন্য ব্যবহার করা হচ্ছে
                branch.branch_manager_name
            ]);

            const newManager = userRes.rows[0];

            // C. ট্রানজ্যাকশন সম্পন্ন
            await client.query('COMMIT'); 

            // 🎯 FEATURE: স্বয়ংক্রিয় ইমেইল পাঠানো
            // এটি COMMIT এর পরে করা হয়েছে যাতে ডাটাবেস নিশ্চিত হওয়ার পরই ইমেইল যায়
            await sendManagerProvisionEmail(
                newManager.email, 
                newManager.full_name, 
                newManager.id, 
                branch.branch_code
            );

            res.status(201).json({ 
                success: true,
                message: 'Branch Provisioned & Welcome Email Sent', 
                branch_id: newBranchId 
            });

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
// 3. UPDATE BRANCH (Infrastructure & Assets)
// =========================================================
router.put('/:id', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const upload = req.app.get('upload').fields([
        { name: 'logo', maxCount: 1 },
        { name: 'photo', maxCount: 1 }
    ]);

    upload(req, res, async (err) => {
        if (err) return res.status(400).json({ message: 'File upload failed' });

        const branchId = req.params.id;
        try {
            const rawData = req.body.branch_info ? JSON.parse(req.body.branch_info) : req.body;
            
            const logoPath = (req.files && req.files['logo']) 
                ? `/uploads/media/${req.files['logo'][0].filename}` 
                : (rawData.logo_url || null);

            const photoPath = (req.files && req.files['photo']) 
                ? `/uploads/teacher_photos/${req.files['photo'][0].filename}` 
                : (rawData.manager_photo || null);

            const query = `
                UPDATE ${BRANCHES_TABLE}
                SET branch_name = COALESCE($1, branch_name),
                    branch_code = COALESCE($2, branch_code),
                    address = COALESCE($3, address),
                    email = COALESCE($4, email),
                    branch_manager_name = COALESCE($5, branch_manager_name),
                    logo_url = COALESCE($6, logo_url),
                    manager_photo = COALESCE($7, manager_photo),
                    is_active = COALESCE($8, is_active),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $9::uuid
                RETURNING *;
            `;
            
            const values = [
                rawData.branch_name || null, rawData.branch_code || null, rawData.address || null, 
                rawData.email || null, rawData.branch_manager_name || null, 
                logoPath, photoPath, rawData.is_active, branchId
            ];

            const result = await pool.query(query, values);
            res.status(200).json({ message: 'Update Successful', branch: result.rows[0] });
        } catch (error) {
            console.error('Update Error:', error);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
});

// =========================================================
// 4. DELETE BRANCH (Safe Purge Logic)
// =========================================================
router.delete('/:id', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const branchId = req.params.id;
    try {
        await pool.query(`DELETE FROM ${BRANCHES_TABLE} WHERE id = $1::uuid`, [branchId]);
        res.status(200).json({ message: 'Branch purged from system records.' });
    } catch (error) {
        if (error.code === '23503') {
            return res.status(409).json({ message: 'Branch has active records and cannot be deleted.' });
        }
        res.status(500).json({ message: 'Purge Failed' });
    }
});

// =========================================================
// 5. GET SINGLE BRANCH (With Manager Link & Security)
// =========================================================
router.get('/:id', authenticateToken, async (req, res) => {
    const branchId = req.params.id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (branchId === 'null' || !uuidRegex.test(branchId)) {
        return res.status(400).json({ message: "Invalid Branch ID format." });
    }

    try {
        const query = `
            SELECT b.*, u.id AS manager_user_id,
            (SELECT COUNT(*) FROM students s WHERE s.branch_id = b.id) AS total_students 
            FROM ${BRANCHES_TABLE} b 
            LEFT JOIN ${USERS_TABLE} u ON u.branch_id = b.id AND u.role::text ILIKE 'admin'
            WHERE b.id = $1::uuid`;
        
        const result = await pool.query(query, [branchId]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Branch not found.' });

        // Security check
        const userRole = req.user.role.toLowerCase();
        const isSuperAdmin = AUTH_ROLES.some(r => r.toLowerCase() === userRole);
        if (!isSuperAdmin && String(result.rows[0].id) !== String(req.user.branch_id)) {
            return res.status(403).json({ message: 'Access Denied: Campus restricted.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

module.exports = router;