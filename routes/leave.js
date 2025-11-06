// routes/leave.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment'); // Required for date calculations

const LEAVE_TYPES_TABLE = 'leave_types';
const LEAVE_BALANCE_TABLE = 'user_leave_balance';
const APPLICATIONS_TABLE = 'leave_applications';
const USERS_TABLE = 'users'; // Assuming user data is in a table named 'users'

// --- Role Definitions ---
const APPROVER_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
const VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Student', 'Coordinator'];


// Helper: Calculate number of working days between two dates (Simplistic: assumes Mon-Fri)
function calculateWorkingDays(startDate, endDate) {
    let start = moment(startDate);
    let end = moment(endDate);
    if (start.isAfter(end)) return 0;
    
    let workingDays = 0;
    let current = start;

    while (current.isSameOrBefore(end)) {
        // Exclude Saturday (6) and Sunday (0)
        if (current.day() !== 0 && current.day() !== 6) {
            workingDays++;
        }
        current.add(1, 'days');
    }
    return workingDays;
}


// =========================================================
// 1. LEAVE APPLICATION (POST)
// =========================================================

/**
 * @route   POST /api/leave/apply
 * @desc    Submit a new leave application (Staff/Student).
 * @access  Private (Teacher, Student, Super Admin, Admin)
 */
router.post('/apply', authenticateToken, authorize(['Teacher', 'Student', 'Super Admin', 'Admin']), async (req, res) => {
    const userId = req.user.userId;
    const userRole = req.user.role;
    
    const { leave_type_id, start_date, end_date, reason } = req.body;
    
    if (!leave_type_id || !start_date || !end_date || !reason) {
        return res.status(400).json({ message: 'Missing required fields (type, dates, reason).' });
    }

    const totalDays = calculateWorkingDays(start_date, end_date);
    if (totalDays <= 0) {
        return res.status(400).json({ message: 'Leave dates must span at least one working day.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Check current balance
        const balanceRes = await client.query(
            `SELECT ubl.balance_days FROM ${LEAVE_BALANCE_TABLE} ubl WHERE ubl.user_id = $1 AND ubl.leave_type_id = $2`,
            [userId, leave_type_id]
        );
        let currentBalance = balanceRes.rows[0]?.balance_days;

        if (currentBalance === undefined) {
             // Attempt to fetch default allowance if balance record doesn't exist
            const typeRes = await client.query(`SELECT days_per_year, applicable_to FROM ${LEAVE_TYPES_TABLE} WHERE id = $1`, [leave_type_id]);
            if (typeRes.rowCount === 0) {
                 await client.query('ROLLBACK');
                 return res.status(404).json({ message: 'Leave type not found.' });
            }
            if (typeRes.rows[0].applicable_to !== 'Both' && typeRes.rows[0].applicable_to !== userRole) {
                 await client.query('ROLLBACK');
                 return res.status(403).json({ message: `Leave type is not applicable for role: ${userRole}.` });
            }
            
            // Set balance to default for the first time
            const defaultDays = typeRes.rows[0].days_per_year;
            await client.query(
                `INSERT INTO ${LEAVE_BALANCE_TABLE} (user_id, leave_type_id, balance_days) VALUES ($1, $2, $3)`,
                [userId, leave_type_id, defaultDays]
            );
            currentBalance = defaultDays; // Use default for the check below
        }

        if (currentBalance < totalDays) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: `Insufficient balance. Available: ${currentBalance} days.` });
        }


        // 2. Create Application Record (Initial status 'Pending')
        const applicationQuery = `
            INSERT INTO ${APPLICATIONS_TABLE} (user_id, leave_type_id, start_date, end_date, total_days, reason, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'Pending')
            RETURNING id, total_days;
        `;
        const result = await client.query(applicationQuery, [userId, leave_type_id, start_date, end_date, totalDays, reason]);

        await client.query('COMMIT');
        res.status(201).json({ 
            message: 'Leave application submitted for approval.', 
            application_id: result.rows[0].id 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Leave Application Error:', error);
        res.status(500).json({ message: 'Failed to submit leave application.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 2. APPROVAL WORKFLOW (PUT)
// =========================================================

/**
 * @route   PUT /api/leave/approval/:applicationId
 * @desc    Approve or Reject a leave application.
 * @access  Private (Admin, Coordinator, Super Admin)
 */
router.put('/approval/:applicationId', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    const { applicationId } = req.params;
    const approverId = req.user.userId;
    const { status, rejection_reason } = req.body; // status must be 'Approved' or 'Rejected'

    if (status !== 'Approved' && status !== 'Rejected') {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }
    // Only require rejection reason if status is 'Rejected'
    if (status === 'Rejected' && !rejection_reason) {
        return res.status(400).json({ message: 'Rejection reason is required.' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Update Application Status
        const updateQuery = `
            UPDATE ${APPLICATIONS_TABLE} SET
                status = $1, approver_id = $2, rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $4 AND status = 'Pending'
            RETURNING user_id, leave_type_id, total_days;
        `;
        const result = await client.query(updateQuery, [status, approverId, rejection_reason || null, applicationId]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Application not found or already processed.' });
        }
        
        const { user_id, leave_type_id, total_days } = result.rows[0];

        // 2. If Approved, DECREMENT the user's leave balance
        if (status === 'Approved') {
            await client.query(
                `UPDATE ${LEAVE_BALANCE_TABLE} SET balance_days = balance_days - $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND leave_type_id = $3`,
                [total_days, user_id, leave_type_id]
            );
        }

        await client.query('COMMIT');
        res.status(200).json({ message: `Leave application successfully ${status.toLowerCase()}.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Leave Approval Error:', error);
        res.status(500).json({ message: 'Failed to process leave approval.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 3. VIEWING ROUTES
// =========================================================

/**
 * @route   GET /api/leave/types
 * @desc    Get all available leave types.
 * @access  Private (All Roles - for dropdown population)
 */
router.get('/types', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT id, name, code, days_per_year, applicable_to FROM ${LEAVE_TYPES_TABLE}
            ORDER BY name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Leave Types Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve leave types.' });
    }
});

/**
 * @route   GET /api/leave/balance
 * @desc    Get the logged-in user's current leave balances.
 * @access  Private (Teacher, Student, Admin, Super Admin)
 */
router.get('/balance', authenticateToken, authorize(VIEWER_ROLES), async (req, res) => {
    const userId = req.user.userId;

    try {
        const query = `
            SELECT 
                lt.name AS leave_type, 
                lt.code AS type_code, 
                lt.days_per_year AS allowance,
                COALESCE(ulb.balance_days, lt.days_per_year) AS current_balance,
                ulb.updated_at AS last_updated
            FROM ${LEAVE_TYPES_TABLE} lt
            LEFT JOIN ${LEAVE_BALANCE_TABLE} ulb ON ulb.leave_type_id = lt.id AND ulb.user_id = $1
            WHERE lt.applicable_to = $2 OR lt.applicable_to = 'Both'
            ORDER BY lt.name;
        `;
        const result = await pool.query(query, [userId, req.user.role]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Balance Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve leave balances.' });
    }
});


/**
 * @route   GET /api/leave/history
 * @desc    Get the logged-in user's application history.
 * @access  Private (Teacher, Student, Admin, Super Admin)
 */
router.get('/history', authenticateToken, authorize(VIEWER_ROLES), async (req, res) => {
    const userId = req.user.userId;

    try {
        const query = `
            SELECT 
                la.id, la.start_date, la.end_date, la.total_days, la.reason, la.status,
                lt.name AS leave_type,
                u_approver.username AS approver
            FROM ${APPLICATIONS_TABLE} la
            JOIN ${LEAVE_TYPES_TABLE} lt ON la.leave_type_id = lt.id
            LEFT JOIN users u_approver ON la.approver_id = u_approver.id
            WHERE la.user_id = $1
            ORDER BY la.created_at DESC;
        `;
        const result = await pool.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve application history.' });
    }
});

/**
 * @route   GET /api/leave/approvals/pending
 * @desc    Get all pending leave applications for approval view.
 * @access  Private (Admin, Coordinator, Super Admin)
 */
router.get('/approvals/pending', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                la.id, la.start_date, la.end_date, la.total_days, la.reason, la.status,
                lt.name AS leave_type,
                u.username AS applicant_name,
                u.role AS applicant_role
            FROM ${APPLICATIONS_TABLE} la
            JOIN ${LEAVE_TYPES_TABLE} lt ON la.leave_type_id = lt.id
            JOIN ${USERS_TABLE} u ON la.user_id = u.id
            WHERE la.status = 'Pending'
            ORDER BY la.created_at ASC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Pending Approvals Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve pending applications.' });
    }
});


module.exports = router;