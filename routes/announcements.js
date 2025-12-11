// routes/announcements.js (FINAL FIX)

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
                -- ✅ FIX: Use ANY to check if the roleName is present in the array
                ($1 = ANY (visible_to_role)) 
                OR 
                -- ✅ FIX: Use the special 'All' string to check if the announcement targets everyone
                ('All' = ANY (visible_to_role)) 
            ORDER BY created_at DESC
            LIMIT 5; -- Get the 5 most recent
        `;
        
        // Pass the roleName parameter to the query
        const result = await pool.query(query, [roleName]); 
        res.json(result.rows);
        
    } catch (error) {
        console.error(`Error fetching announcements for role ${roleName}:`, error);
        // If the error is still '42P01' (table missing), this will show a 500
        res.status(500).json({ message: 'Server error while fetching announcements.' });
    }
});

module.exports = router;