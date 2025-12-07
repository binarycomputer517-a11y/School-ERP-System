// routes/feedback.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const { v4: uuidv4 } = require('uuid');

const FEEDBACK_TABLE = 'feedback_submissions'; 
const AUTH_ROLES = ['Super Admin', 'Admin', 'HR Staff'];

// =========================================================
// R: GET ALL FEEDBACK (Read)
// =========================================================
/**
 * @route GET /api/feedback
 * @desc Get filtered list of feedback submissions.
 * @access Private (Admin, HR Staff)
 */
router.get('/', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    // Filters match frontend: status, category, search (subject/message)
    const { status = '', category = '', search = '' } = req.query;

    try {
        let sql = `
            SELECT 
                id, 
                user_id,
                submitted_by, 
                user_role,
                category, 
                subject, 
                message, 
                status, 
                created_at,
                staff_response
            FROM ${FEEDBACK_TABLE}
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (status) {
            sql += ` AND status = $${paramIndex++}`;
            params.push(status);
        }
        
        if (category) {
            sql += ` AND category = $${paramIndex++}`;
            params.push(category);
        }

        if (search) {
            sql += ` AND (LOWER(subject) LIKE $${paramIndex} OR LOWER(message) LIKE $${paramIndex})`;
            params.push(`%${search.toLowerCase()}%`);
        }
        
        sql += ` ORDER BY created_at DESC;`;

        const result = await pool.query(sql, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching feedback:', error);
        // Assuming column name errors if the table is missing fields
        res.status(500).json({ message: 'Failed to retrieve feedback list. Check feedback_submissions table schema.' });
    }
});

// =========================================================
// U: UPDATE STATUS (Resolve)
// =========================================================
/**
 * @route PUT /api/feedback/:id
 * @desc Update the status of a feedback submission.
 * @access Private (Admin, HR Staff)
 */
router.put('/:id', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const feedbackId = req.params.id;
    const { status, staff_response } = req.body;

    if (!status) {
        return res.status(400).json({ message: 'New status is required.' });
    }

    try {
        let query = `
            UPDATE ${FEEDBACK_TABLE}
            SET status = $1,
                updated_at = CURRENT_TIMESTAMP
        `;
        const params = [status];
        let paramIndex = 2;
        
        // Allow staff response to be optionally updated
        if (staff_response) {
            query += `, staff_response = $${paramIndex++}`;
            params.push(staff_response);
        }

        query += ` WHERE id = $${paramIndex} RETURNING id, status;`;
        params.push(feedbackId);

        const result = await pool.query(query, params);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Feedback ID not found.' });
        }
        res.status(200).json({ message: 'Feedback status updated successfully.', feedback: result.rows[0] });
    } catch (error) {
        console.error('Feedback Update Error:', error);
        res.status(500).json({ message: 'Failed to update feedback status.' });
    }
});

// =========================================================
// C: POST NEW FEEDBACK (Submit) - (Optional Public Route)
// =========================================================
/**
 * @route POST /api/feedback
 * @desc Submit new feedback (Can be public or authenticated user).
 * @access Public/Private
 */
router.post('/', async (req, res) => {
    // Example fields for submission. Adjust based on your 'feedback_submissions' table.
    const { user_id, submitted_by, user_role, category, subject, message, contact_email } = req.body;
    
    if (!message) {
        return res.status(400).json({ message: 'Feedback message is required.' });
    }
    
    try {
        const query = `
            INSERT INTO ${FEEDBACK_TABLE} (user_id, submitted_by, user_role, category, subject, message, contact_email, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'New')
            RETURNING id;
        `;
        const result = await pool.query(query, [user_id, submitted_by, user_role, category, subject, message, contact_email]);
        
        res.status(201).json({ 
            message: 'Feedback submitted successfully. Thank you!', 
            id: result.rows[0].id 
        });
    } catch (error) {
        console.error('Feedback Submission Error:', error);
        res.status(500).json({ message: 'Failed to submit feedback.' });
    }
});


module.exports = router;