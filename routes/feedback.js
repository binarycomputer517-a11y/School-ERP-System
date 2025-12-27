const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// =========================================================
// 1. PUBLIC/USER ENDPOINTS
// =========================================================

/**
 * POST /api/feedback/submit
 * Allows any authenticated user to submit feedback.
 */
router.post('/submit', authenticateToken, async (req, res) => {
    const { subject, content, priority = 'Medium', category = 'Other' } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!subject || !content) {
        return res.status(400).json({ message: 'Subject and content are required.' });
    }

    try {
        const query = `
            INSERT INTO feedback (user_id, user_role, subject, content, priority, category)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
        const result = await pool.query(query, [userId, userRole, subject, content, priority, category]);
        
        res.status(201).json({ 
            success: true, 
            message: 'Feedback submitted successfully.', 
            id: result.rows[0].id 
        });
    } catch (error) {
        console.error('Submission Error:', error);
        res.status(500).json({ message: 'Error saving feedback to the database.' });
    }
});

/**
 * GET /api/feedback/my-submissions
 * Allows users to view their own feedback history.
 */
router.get('/my-submissions', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM feedback WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('History Fetch Error:', error);
        res.status(500).json({ message: 'Error fetching your feedback history.' });
    }
});

// =========================================================
// 2. ADMIN ENDPOINTS
// =========================================================

/**
 * GET /api/feedback/all
 * Admin access to view all feedback with Status and Category filters.
 */
router.get('/all', authenticateToken, async (req, res) => {
    try {
        const { status, category } = req.query;
        let query = `
            SELECT f.*, u.username AS user_name 
            FROM feedback f 
            JOIN users u ON f.user_id = u.id 
            WHERE 1=1`;
        let params = [];

        if (status && status !== 'all') {
            params.push(status);
            query += ` AND f.status = $${params.length}`;
        }
        if (category && category !== 'all') {
            params.push(category);
            query += ` AND f.category = $${params.length}`;
        }

        query += ` ORDER BY f.created_at DESC`;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Admin Fetch Error:', error);
        res.status(500).json({ message: 'Error loading the feedback list.' });
    }
});

/**
 * PUT /api/feedback/update/:id
 * Update feedback status, priority, and add admin notes.
 */
router.put('/update/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { status, admin_note, priority } = req.body;
    const adminId = req.user.id;

    try {
        // If status is set to Resolved, track the ID of the admin who resolved it
        const resolvedBy = (status === 'Resolved') ? adminId : null;
        
        const query = `
            UPDATE feedback 
            SET status = $1, admin_notes = $2, priority = $3, resolved_by_user_id = COALESCE($4, resolved_by_user_id) 
            WHERE id = $5 RETURNING id`;
        
        const result = await pool.query(query, [status, admin_note, priority, resolvedBy, id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Feedback record not found.' });
        }

        res.json({ success: true, message: 'Feedback record updated successfully.' });
    } catch (error) {
        console.error('Admin Update Error:', error);
        res.status(500).json({ message: 'Server-side update failed.' });
    }
});

/**
 * DELETE /api/feedback/delete/:id
 * Permanently delete an incorrect or spam feedback entry.
 */
router.delete('/delete/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM feedback WHERE id = $1', [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Feedback record not found.' });
        }
        res.json({ success: true, message: 'Feedback deleted successfully.' });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ message: 'Failed to delete feedback.' });
    }
});

module.exports = router;