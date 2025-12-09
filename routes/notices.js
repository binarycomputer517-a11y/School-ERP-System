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
// 1. NOTICE CREATION WITH TARGETING (POST) - UPDATED for Scheduling, Action, History
// =========================================================
router.post('/create', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const creatorId = req.user.id; 
    // Assuming req.user also has full_name or username
    const creatorName = req.user.full_name || req.user.username || 'System Admin'; 

    const { 
        title, content, target_role, expiry_date, delivery_channels = [],
        // NEW FIELDS from Frontend
        scheduled_at, required_action, notice_type 
    } = req.body;

    // Validation checks remain the same
    if (!title || !content || !TARGET_ROLES.includes(target_role)) {
        return res.status(400).json({ message: 'Missing title, content, or invalid target role.' });
    }
    if (delivery_channels.some(c => !DELIVERY_CHANNELS.includes(c))) {
        return res.status(400).json({ message: 'Invalid delivery channel specified.' });
    }

    const is_scheduled = !!scheduled_at; 
    // Set initial active status: Inactive if scheduled, Active if immediate
    const initial_active_status = !is_scheduled; 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Initial revision entry (JSONB array)
        const initialRevision = [{
            timestamp: new Date().toISOString(),
            user: creatorName,
            action: is_scheduled ? 'Scheduled' : 'Created',
            title: title,
            content: content
        }];

        // 1. Insert Notice (Content) - Using all new fields
        const noticeQuery = `
            INSERT INTO ${NOTICES_TABLE} (
                title, content, posted_by, target_role, expiry_date, 
                is_active, scheduled_at, required_action, notice_type, revision_history
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id;
        `;
        const noticeResult = await client.query(noticeQuery, [
            title, content, creatorId, target_role, expiry_date || null,
            initial_active_status, scheduled_at || null, required_action || null,
            notice_type || 'General', initialRevision 
        ]);
        const noticeId = noticeResult.rows[0].id;

        // 2. Identify Target Users (Only for immediate posting)
        if (!is_scheduled) {
            let targetUsersQuery = `SELECT id, email, phone_number FROM ${USERS_TABLE}`;
            if (target_role !== 'All') {
                targetUsersQuery += ` WHERE role = $1`;
            }
            
            const targetUsersRes = await pool.query(targetUsersQuery, target_role !== 'All' ? [target_role] : []);
            const targetUsers = targetUsersRes.rows;

            // 3. Log Initial Delivery Status 
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
            var message = `Notice posted and logged for ${targetUsers.length} users across ${delivery_channels.length} channels.`;
        } else {
            var message = `Notice successfully scheduled for ${new Date(scheduled_at).toLocaleString()}. Delivery log pending activation.`;
        }

        await client.query('COMMIT');
        res.status(201).json({ message, notice_id: noticeId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Notice Creation Error:', error);
        res.status(500).json({ message: 'Failed to create notice.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. TARGETED VIEWING (GET) - No change
// =========================================================

router.get('/my-feed', authenticateToken, async (req, res) => {
    const userRole = req.user.role;
    const userId = req.user.id;

    try {
        const query = `
            SELECT 
                n.id, n.title, n.content, n.created_at, n.expiry_date,
                (SELECT status FROM ${DELIVERY_LOG_TABLE} WHERE notice_id = n.id AND user_id = $1 AND channel = 'In-App') AS delivery_status
            FROM ${NOTICES_TABLE} n
            WHERE (n.target_role = $2 OR n.target_role = 'All')
            AND (n.expiry_date IS NULL OR n.expiry_date >= CURRENT_DATE)
            AND n.is_active = TRUE -- Only show active notices in the feed
            ORDER BY n.created_at DESC;
        `;
        const result = await pool.query(query, [userId, userRole]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('My Feed Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve notices feed.' });
    }
});

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
// 3. MANAGEMENT & AUDIT ROUTES - UPDATED for Read Rate, Schedule
// =========================================================

/**
 * @route   GET /api/notices/all-management
 * @desc    Get all notices for Admin dashboard, including Read Rate and Schedule Info.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/all-management', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    try {
        // Query to calculate Read Rate and Total Audience dynamically (Requires role::text casting fix)
        const query = `
            WITH TargetAudience AS (
                SELECT 
                    role, COUNT(id) AS total_users 
                FROM ${USERS_TABLE} 
                WHERE is_active = TRUE AND role::text != 'Parent' 
                GROUP BY role
            ),
            ReadCounts AS (
                SELECT 
                    notice_id, COUNT(user_id) AS read_count
                FROM ${DELIVERY_LOG_TABLE} 
                WHERE status = 'Read'
                GROUP BY notice_id
            )
            SELECT 
                n.id, n.title, n.content, n.created_at, n.target_role, n.is_active, 
                n.scheduled_at, n.required_action, n.notice_type, -- New fields
                COALESCE(rc.read_count, 0) AS read_rate,
                CASE n.target_role
                    WHEN 'All' THEN (SELECT SUM(total_users) FROM TargetAudience)
                    ELSE (SELECT total_users FROM TargetAudience WHERE TargetAudience.role::text = n.target_role)
                END AS total_users
            FROM ${NOTICES_TABLE} n
            LEFT JOIN ReadCounts rc ON n.id = rc.notice_id
            ORDER BY n.created_at DESC;
        `;
        const result = await pool.query(query);
        
        // Ensure total_users is not null
        const rows = result.rows.map(row => ({
            ...row,
            total_users: row.total_users || 0 
        }));

        res.status(200).json(rows);
    } catch (error) {
        console.error('All Management Notices Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve all notices for management.' });
    }
});

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
// 4. UTILITY ROUTES (Birthdays) - No change
// =========================================================

router.get('/birthdays/today', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const query = `
        -- 1. Get STUDENT Birthdays (from students table)
        SELECT 
            s.student_id::text AS entity_id, 
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
            u.role::text NOT IN ('Student', 'Parent') AND
            EXTRACT(MONTH FROM t.date_of_birth) = EXTRACT(MONTH FROM CURRENT_DATE) AND
            EXTRACT(DAY FROM t.date_of_birth) = EXTRACT(DAY FROM CURRENT_DATE)
        
        ORDER BY role, full_name;
    `;
    
    // ... (rest of the birthday route logic)
});


// =========================================================
// 5. GET SINGLE NOTICE DETAILS - Needs Update to select all fields
// =========================================================

router.get('/:noticeId', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const { noticeId } = req.params;
    try {
        const query = `
            SELECT 
                n.id, n.title, n.content, n.target_role, n.expiry_date, n.created_at, n.is_active, 
                n.scheduled_at, n.required_action, n.notice_type, n.revision_history, 
                u.username AS posted_by_user
            FROM ${NOTICES_TABLE} n
            JOIN ${USERS_TABLE} u ON n.posted_by = u.id
            WHERE n.id = $1;
        `;
        const result = await pool.query(query, [noticeId]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Notice not found.' });
        }
        
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Single Notice Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve single notice details.' });
    }
});


// =========================================================
// 6. DELETE NOTICE - No change
// =========================================================

router.delete('/:noticeId', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { noticeId } = req.params;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. Delete associated delivery logs
        await client.query(`DELETE FROM ${DELIVERY_LOG_TABLE} WHERE notice_id = $1;`, [noticeId]);
        
        // 2. Delete the main notice record
        const deleteNoticeResult = await client.query(`DELETE FROM ${NOTICES_TABLE} WHERE id = $1 RETURNING id;`, [noticeId]);
        
        if (deleteNoticeResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Notice not found.' });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: `Notice ${noticeId} and associated logs deleted successfully.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Notice Deletion Error:', error);
        res.status(500).json({ message: 'Failed to delete notice due to a server error.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 7. UPDATE NOTICE CONTENT (PATCH) - UPDATED for History and new fields
// =========================================================
/**
 * @route   PATCH /api/notices/:noticeId
 * @desc    Update the content, title, target, or expiry date of an existing notice.
 * @access  Private (Admin, Super Admin, Staff)
 */
router.patch('/:noticeId', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const { noticeId } = req.params;
    const { title, content, target_role, expiry_date, is_active } = req.body; 
    const updaterName = req.user.full_name || req.user.username || 'System Admin';
    
    let fields = [];
    let values = [];
    let paramIndex = 1;

    // Fields to update
    if (title !== undefined) fields.push(`title = $${paramIndex++}`); values.push(title);
    if (content !== undefined) fields.push(`content = $${paramIndex++}`); values.push(content);
    if (target_role !== undefined) {
        if (!TARGET_ROLES.includes(target_role)) return res.status(400).json({ message: 'Invalid target role provided.' });
        fields.push(`target_role = $${paramIndex++}`); values.push(target_role);
    }
    if (expiry_date !== undefined) {
        const dateValue = expiry_date === '' ? null : expiry_date;
        fields.push(`expiry_date = $${paramIndex++}`); values.push(dateValue);
    }
    if (is_active !== undefined) { 
        fields.push(`is_active = $${paramIndex++}`); values.push(is_active);
    }

    if (fields.length === 0) {
        return res.status(400).json({ message: 'No update fields provided.' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch current notice state (for history log)
        const currentNoticeRes = await client.query(`SELECT title, content, revision_history FROM ${NOTICES_TABLE} WHERE id = $1`, [noticeId]);
        if (currentNoticeRes.rowCount === 0) {
             await client.query('ROLLBACK');
             return res.status(404).json({ message: 'Notice not found.' });
        }
        const currentNotice = currentNoticeRes.rows[0];

        // 2. Create new revision entry
        const newRevision = {
            timestamp: new Date().toISOString(),
            user: updaterName,
            action: 'Updated',
            title: title || currentNotice.title,
            content: content || currentNotice.content
        };
        
        // 3. Append new revision to history array (JSONB concatenation)
        fields.push(`revision_history = revision_history || $${paramIndex++}::jsonb`);
        values.push(JSON.stringify(newRevision));
        
        values.push(noticeId); // Add noticeId for the WHERE clause

        // 4. Execute Update Query
        const updateQuery = `
            UPDATE ${NOTICES_TABLE} SET 
                ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
            WHERE id = $${paramIndex}
            RETURNING id, title, updated_at;
        `;
        
        const result = await client.query(updateQuery, values);

        await client.query('COMMIT');
        
        res.status(200).json({ 
            message: `Notice '${result.rows[0].title}' updated successfully.`,
            notice_id: result.rows[0].id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Notice Update Error:', error);
        res.status(500).json({ message: 'Failed to update notice.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 8. TOGGLE NOTICE ACTIVE STATUS (PATCH)
// =========================================================
/**
 * @route   PATCH /api/notices/:noticeId/status
 * @desc    Toggle the 'is_active' status of a notice.
 * @access  Private (Admin, Super Admin, Staff)
 */
router.patch('/:noticeId/status', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const { noticeId } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
        return res.status(400).json({ message: 'The field "is_active" must be a boolean.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const query = `
            UPDATE ${NOTICES_TABLE} SET is_active = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING id, is_active;
        `;
        const result = await client.query(query, [is_active, noticeId]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Notice not found.' });
        }
        
        // Optional: Log the status change in the revision history as well
        const updaterName = req.user.full_name || req.user.username || 'System Admin';
        const statusChangeRevision = {
            timestamp: new Date().toISOString(),
            user: updaterName,
            action: is_active ? 'Activated' : 'Deactivated',
            detail: `Status changed to ${is_active}`
        };
        
        await client.query(
            `UPDATE ${NOTICES_TABLE} SET revision_history = revision_history || $1::jsonb WHERE id = $2`,
            [JSON.stringify(statusChangeRevision), noticeId]
        );

        await client.query('COMMIT');
        res.status(200).json({ 
            message: `Notice status updated to ${is_active ? 'Active' : 'Inactive'}`,
            is_active: result.rows[0].is_active
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Toggle Status Error:', error);
        res.status(500).json({ message: 'Failed to update notice status.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 9. GET REVISION HISTORY (GET) - NEW ROUTE
// =========================================================
/**
 * @route   GET /api/notices/:noticeId/history
 * @desc    Get the revision history log for a specific notice.
 * @access  Private (Admin, Super Admin, Staff)
 */
router.get('/:noticeId/history', authenticateToken, authorize(NOTICE_MANAGEMENT_ROLES), async (req, res) => {
    const { noticeId } = req.params;

    try {
        const query = `
            SELECT revision_history 
            FROM ${NOTICES_TABLE} 
            WHERE id = $1;
        `;
        const result = await pool.query(query, [noticeId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Notice not found.' });
        }
        
        // Return the array of history objects
        const history = result.rows[0].revision_history || [];

        res.status(200).json(history); 

    } catch (error) {
        console.error('Get History Error:', error);
        res.status(500).json({ message: 'Failed to retrieve revision history.' });
    }
});


module.exports = router;