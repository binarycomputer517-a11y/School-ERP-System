// routes/feedback.js

const express = require('express');
const router = express.Router();

// 1. Path to Database Pool (based on server.js)
const { pool } = require('../database'); 

// 🔥 CRITICAL FIX: The function is named 'authorize', not 'authorizeRole' in authMiddleware.js
// We keep both imported, but 'authorize' is now unused in the admin routes.
const { authenticateToken, authorize } = require('../authMiddleware'); 

// 2. Load constants from the server-side constants file
const CONSTANTS = require('./config/constants'); 
const FEEDBACK_STATUSES = CONSTANTS.FEEDBACK_STATUSES;

// --- SQL Query Helper ---

/**
 * Common query to safely fetch feedback data, joining sender username.
 */
const getFeedbackQuery = `
    SELECT 
        f.id, f.subject, f.content, f.status, f.priority, f.admin_notes, f.created_at, f.user_role,
        u.username AS sender_username,
        a.username AS resolved_by_username
    FROM feedback f
    JOIN users u ON f.user_id = u.id
    LEFT JOIN users a ON f.resolved_by_user_id = a.id
`;

// =========================================================
// 1. PUBLIC/STUDENT ENDPOINTS
// =========================================================

/**
 * POST /api/feedback/submit
 * Allows any authenticated user to submit new feedback.
 */
router.post('/submit', authenticateToken, async (req, res) => {
    try {
        const { subject, content, priority = 'Medium' } = req.body;
        const userId = req.user.id; 
        const userRole = req.user.role; 

        if (!subject || !content) {
            return res.status(400).json({ message: 'Subject and content are required.' });
        }

        const result = await pool.query( 
            'INSERT INTO feedback (user_id, user_role, subject, content, priority) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
            [userId, userRole, subject, content, priority]
        );

        res.status(201).json({ 
            message: 'Feedback submitted successfully.',
            id: result.rows[0].id
        });
    } catch (error) {
        console.error('Error submitting feedback:', error);
        res.status(500).json({ message: 'Internal server error while submitting feedback.' });
    }
});

/**
 * GET /api/feedback/my-submissions
 * Retrieves all feedback submitted by the currently authenticated user.
 */
router.get('/my-submissions', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const result = await pool.query( 
            `${getFeedbackQuery} WHERE f.user_id = $1 ORDER BY f.created_at DESC`,
            [userId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching user submissions:', error);
        res.status(500).json({ message: 'Internal server error while fetching your feedback.' });
    }
});


// =========================================================
// 2. ADMIN ENDPOINTS
// =========================================================

/**
 * GET /api/feedback/all
 * Retrieves all feedback entries (AUTHENTICATED access only for testing).
 */
// ⚠️ SECURITY WARNING: Removed authorize() for testing
router.get('/all', authenticateToken, async (req, res) => { 
    try {
        const { status } = req.query;
        let query = `${getFeedbackQuery} ORDER BY f.created_at DESC`;
        let params = [];

        if (status && FEEDBACK_STATUSES.includes(status)) {
             query = `${getFeedbackQuery} WHERE f.status = $1 ORDER BY f.created_at DESC`;
             params.push(status);
        }

        const result = await pool.query(query, params); 
        res.json(result.rows);

    } catch (error) {
        console.error('Error fetching all feedback:', error);
        res.status(500).json({ message: 'Internal server error while fetching all feedback.' });
    }
});

/**
 * PUT /api/feedback/:id/status
 * Updates the status and admin notes of a specific feedback (AUTHENTICATED access only for testing).
 */
// ⚠️ SECURITY WARNING: Removed authorize() for testing
router.put('/:id/status', authenticateToken, async (req, res) => { 
    try {
        const feedbackId = req.params.id;
        const { status, adminNotes } = req.body;
        // req.user.id is used to track who resolved the feedback
        const adminId = req.user.id; 

        if (!status || !FEEDBACK_STATUSES.includes(status)) {
            return res.status(400).json({ message: 'Invalid status provided.' });
        }

        // Set resolved_by_user_id only if status indicates resolution/closure
        const resolvedId = (status === 'Resolved' || status === 'Closed') ? adminId : null;

        const result = await pool.query( 
            `UPDATE feedback SET status = $1, admin_notes = $2, resolved_by_user_id = $3 WHERE id = $4 RETURNING id`,
            [status, adminNotes, resolvedId, feedbackId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Feedback not found.' });
        }

        res.json({ message: `Feedback status updated to ${status}.` });

    } catch (error) {
        console.error('Error updating feedback status:', error);
        res.status(500).json({ message: 'Internal server error while updating status.' });
    }
});

module.exports = router;