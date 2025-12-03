const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');

// GET /api/sections
// Fetches Courses and Batches to populate the "Class/Section" dropdown
router.get('/', authenticateToken, async (req, res) => {
    try {
        // We select the Batch ID as 'id' because that's what we need to filter students later.
        // We map 'course_name' to 'class_name' and 'batch_name' to 'section_name'
        // so the frontend javascript works without changes.
        const query = `
            SELECT 
                b.id, 
                c.course_name AS class_name, 
                b.batch_name AS section_name 
            FROM batches b
            JOIN courses c ON b.course_id = c.id
            ORDER BY c.course_name ASC, b.batch_name ASC
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching sections (batches):', err);
        res.status(500).json({ error: 'Server error fetching class data' });
    }
});

module.exports = router;