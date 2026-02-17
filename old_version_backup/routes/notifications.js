const express = require('express');
const router = express.Router(); // This line was missing!
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');

// Get notifications for the logged-in parent
// Note: Since we mount this at '/api/notifications' in server.js, 
// the path here should just be '/my-notifications'
router.get('/my-notifications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id; 

        const result = await pool.query(
            `SELECT id, title, message, is_read, created_at 
             FROM portal_notifications 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 20`,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching notifications:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Mark all as read
router.post('/mark-as-read', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            "UPDATE portal_notifications SET is_read = TRUE WHERE user_id = $1",
            [req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;