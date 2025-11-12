// routes/notices.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment'); 

// Database Table Constants
const NOTICES_TABLE = 'notices'; 
const USERS_TABLE = 'users'; 
const DELIVERY_LOG_TABLE = 'notice_delivery_log'; 
const STUDENTS_TABLE = 'students';
const TEACHERS_TABLE = 'teachers';

// Constants
const TARGET_ROLES = ['All', 'Student', 'Teacher', 'Parent', 'Admin', 'Staff'];
const DELIVERY_CHANNELS = ['In-App', 'Email', 'SMS'];
const DELIVERY_STATUSES = ['Pending', 'Delivered', 'Failed', 'Read'];
const NOTICE_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff'];


// =========================================================
// 1. NOTICE CREATION WITH TARGETING (POST)
// =========================================================
router.post('/create', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const creatorId = req.user.id; 
    const { 
        title, 
        content, 
        target_role, 
        expiry_date, 
        delivery_channels = []
    } = req.body;

    if (!title || !content || !TARGET_ROLES.includes(target_role)) {
        return res.status(400).json({ message: 'Missing title, content, or invalid target role.' });
    }
    if (delivery_channels.some(c => !DELIVERY_CHANNELS.includes(c))) {
        return res.status(400).json({ message: 'Invalid delivery channel specified.' });
    }
    if (!creatorId) {
        return res.status(403).json({ message: 'Forbidden: Creator ID missing from token context.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Insert Notice (Content)
        // NOTE: Removed is_active from INSERT if it doesn't exist in the table.
        const noticeQuery = `
            INSERT INTO ${NOTICES_TABLE} (title, content, posted_by, target_role, expiry_date)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        const noticeResult = await pool.query(noticeQuery, [
            title, content, creatorId, target_role, expiry_date || null
        ]);
        const noticeId = noticeResult.rows[0].id;

        // 2. Identify Target Users
        let targetUsersQuery = `SELECT id, email, phone_number FROM ${USERS_TABLE}`;
        if (target_role !== 'All') {
            targetUsersQuery += ` WHERE role = $1`;
        }
        
        const targetUsersRes = await pool.query(targetUsersQuery, target_role !== 'All' ? [target_role] : []);
        const targetUsers = targetUsersRes.rows;

        // 3. Log Initial Delivery Status (Simulated delivery processing)
        if (targetUsers.length > 0 && delivery_channels.length > 0) {
            
            for (const user of targetUsers) {
                for (const channel of delivery_channels) {
                    const initialStatus = channel === 'In-App' ? 'Delivered' : 'Pending';
                    
                    await pool.query(`
                        INSERT INTO ${DELIVERY_LOG_TABLE} (notice_id, user_id, channel, status)
                        VALUES ($1, $2, $3, $4);
                    `, [noticeId, user.id, channel, initialStatus]);
                }
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Notice posted and logged for ${targetUsers.length} users across ${delivery_channels.length} channels.`, 
            notice_id: noticeId 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Notice Creation Error:', error);
        res.status(500).json({ message: 'Failed to create notice.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. TARGETED VIEWING (GET)
// =========================================================

/**
 * @route   GET /api/notices/my-feed
 * @desc    Get notices targeted specifically to the logged-in user's role.
 * @access  Private (All authenticated users)
 */
router.get('/my-feed', authenticateToken, async (req, res) => {
    const userRole = req.user.role;
    const userId = req.user.id;

    try {
        // NOTE: Removed n.is_active check from WHERE clause if column doesn't exist
        const query = `
            SELECT 
                n.id, n.title, n.content, n.created_at, n.expiry_date,
                (SELECT status FROM ${DELIVERY_LOG_TABLE} WHERE notice_id = n.id AND user_id = $1 AND channel = 'In-App') AS delivery_status
            FROM ${NOTICES_TABLE} n
            WHERE (n.target_role = $2 OR n.target_role = 'All')
            AND (n.expiry_date IS NULL OR n.expiry_date >= CURRENT_DATE)
            ORDER BY n.created_at DESC;
        `;
        const result = await pool.query(query, [userId, userRole]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('My Feed Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve notices feed.' });
    }
});

/**
 * @route   PUT /api/notices/mark-read/:noticeId
 * @desc    Update the delivery status for a notice to 'Read'.
 * @access  Private (All authenticated users)
 */
router.put('/mark-read/:noticeId', authenticateToken, async (req, res) => {
    const { noticeId } = req.params;
    const userId = req.user.id;
    
    try {
        const updateQuery = `
            UPDATE ${DELIVERY_LOG_TABLE} SET status = 'Read', read_at = CURRENT_TIMESTAMP
            WHERE notice_id = $1 AND user_id = $2 AND channel = 'In-App' AND status != 'Read'
            RETURNING id;
        `;
        const result = await pool.query(updateQuery, [noticeId, userId]);

        if (result.rowCount === 0) {
            return res.status(200).json({ message: 'Notice already marked as read or not found in feed.' });
        }
        res.status(200).json({ message: 'Notice marked as read.' });
    } catch (error) {
        console.error('Mark Read Error:', error);
        res.status(500).json({ message: 'Failed to mark notice as read.' });
    }
});


// =========================================================
// 3. MANAGEMENT & AUDIT ROUTES
// =========================================================

/**
 * @route   GET /api/notices/all-management
 * @desc    Get all notices for Admin dashboard.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/all-management', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    try {
        // FIX 1: Removed non-existent column is_active from SELECT list.
        const query = `
            SELECT 
                id, title, content, created_at, target_role
            FROM ${NOTICES_TABLE}
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('All Management Notices Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve all notices for management.' });
    }
});

/**
 * @route   GET /api/notices/log/:noticeId
 * @desc    Get detailed delivery audit log for a specific notice.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/log/:noticeId', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const { noticeId } = req.params;
    try {
        const query = `
            SELECT 
                dl.user_id, dl.channel, dl.status, dl.sent_at, dl.read_at
            FROM ${DELIVERY_LOG_TABLE} dl
            WHERE dl.notice_id = $1
            ORDER BY dl.channel, dl.status;
        `;
        const result = await pool.query(query, [noticeId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Delivery Log Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve delivery audit log.' });
    }
});


// =========================================================
// 4. UTILITY ROUTES (Birthdays)
// =========================================================

/**
 * @route   GET /api/notices/birthdays/today
 * @desc    Get a list of all users (students and staff) whose birthday is today.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/birthdays/today', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    try {
        // FIX 2: Cast u.id (integer) to TEXT to match s.student_id (uuid, returned as text) in UNION.
        const query = `
            -- 1. Get STUDENT Birthdays (from students table)
            SELECT 
                s.student_id AS entity_id, 
                s.first_name || ' ' || s.last_name AS full_name, 
                'Student' AS role, 
                s.dob AS dob_date
            FROM ${STUDENTS_TABLE} s
            WHERE 
                s.deleted_at IS NULL AND s.dob IS NOT NULL AND
                EXTRACT(MONTH FROM s.dob) = EXTRACT(MONTH FROM CURRENT_DATE) AND
                EXTRACT(DAY FROM s.dob) = EXTRACT(DAY FROM CURRENT_DATE)

            UNION ALL

            -- 2. Get STAFF/ADMIN Birthdays (Joining users and teachers table for DOB and Name)
            SELECT 
                u.id::text AS entity_id,             
                t.full_name,                        
                u.role, 
                t.date_of_birth AS dob_date         
            FROM ${USERS_TABLE} u
            JOIN ${TEACHERS_TABLE} t ON u.id = t.user_id     
            WHERE 
                u.deleted_at IS NULL AND
                t.date_of_birth IS NOT NULL AND
                u.role NOT IN ('Student', 'Parent') AND
                EXTRACT(MONTH FROM t.date_of_birth) = EXTRACT(MONTH FROM CURRENT_DATE) AND
                EXTRACT(DAY FROM t.date_of_birth) = EXTRACT(DAY FROM CURRENT_DATE)
            
            ORDER BY role, full_name;
        `;
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (error) {
        // Log the full error for debugging but send a clean response to the client
        console.error('Birthday Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve today\'s birthdays due to a server error.' });
    }
});

module.exports = router;