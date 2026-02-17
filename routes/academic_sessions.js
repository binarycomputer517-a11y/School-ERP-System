/**
 * routes/academic-sessions.js
 * -----------------------------
 * Institutional Cycle Management.
 * This route provides data for academic sessions to populate dropdowns 
 * and synchronize enrollment across the system.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');

/**
 * @route   GET /api/academic-sessions
 * @desc    Get all academic sessions for configuration and UI selection
 * @access  Private
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        // 
        
        // Fetches all sessions ordered by start date to populate system-wide dropdowns
        const query = 'SELECT * FROM academic_sessions ORDER BY start_date DESC';
        const result = await pool.query(query);
        
        // Return the resulting rows to the client
        res.status(200).json(result.rows);
    } catch (err) {
        // Log the error for internal debugging
        console.error('Error fetching academic sessions:', err);
        
        // Return a professional error response to the client
        res.status(500).json({ error: 'Server error: Failed to retrieve academic sessions' });
    }
});

module.exports = router;