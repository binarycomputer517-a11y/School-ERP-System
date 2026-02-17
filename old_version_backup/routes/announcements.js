// routes/announcements.js (FINAL & STABLE FIX for 42809 error)

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
    
    // CRITICAL FIX: Create an array containing the specific role and 'All'
    // This array is what we will compare against the visible_to_role array in the DB.
    const rolesToCheck = [roleName, 'All'];
    
    try {
        const query = `
            SELECT title, content, created_at
            FROM announcements
            WHERE 
                is_active = TRUE AND
                -- ✅ FINAL FIX: Use the '&&' (Overlap) operator.
                -- This checks if the two arrays (visible_to_role AND rolesToCheck) share any common element.
                -- We cast $1 to VARCHAR[] to ensure PostgreSQL treats the input correctly.
                visible_to_role && $1::VARCHAR[]
            ORDER BY created_at DESC
            LIMIT 5; 
        `;
        
        // Pass the rolesToCheck array as the first and only parameter
        const result = await pool.query(query, [rolesToCheck]); 
        res.json(result.rows);
        
    } catch (error) {
        console.error(`Error fetching announcements for role ${roleName}:`, error);
        res.status(500).json({ message: 'Server error while fetching announcements.' });
    }
});

module.exports = router;