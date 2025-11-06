const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware'); 

/**
 * @route   GET /api/announcements/role/:roleName
 * @desc    Get announcements visible to a specific role (and 'All').
 * @access  Private
 */
router.get('/role/:roleName', authenticateToken, async (req, res) => {
    const { roleName } = req.params;
    
    try {
        const query = `
            SELECT title, content, created_at
            FROM announcements
            WHERE 
                -- Check for announcements for the specific role (e.g., 'Student')
                (visible_to_role ILIKE $1) 
                OR 
                -- Also include announcements for 'All'
                (visible_to_role ILIKE 'All')
            ORDER BY created_at DESC
            LIMIT 5; -- Get the 5 most recent
        `;
        
        const result = await pool.query(query, [roleName]);
        res.json(result.rows);
        
    } catch (error) {
        console.error(`Error fetching announcements for role ${roleName}:`, error);
        res.status(500).json({ message: 'Server error while fetching announcements.' });
    }
});

module.exports = router;