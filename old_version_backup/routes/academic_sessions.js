const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');

// Get all academic sessions
router.get('/', authenticateToken, async (req, res) => {
    try {
        // Fetches sessions so the dropdown can populate
        const result = await pool.query('SELECT * FROM academic_sessions ORDER BY start_date DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching academic sessions:', err);
        res.status(500).json({ error: 'Server error fetching sessions' });
    }
});

module.exports = router;