// /routes/courses.js (This file replaces the content of the old classes.js)

const express = require('express');
const router = express.Router();
const pool = require('../database').pool;

// --- GET: সমস্ত কোর্সের তালিকা ---
// পাথ: GET /api/courses/
router.get('/', async (req, res) => {
    try {
        // Updated to select from the 'courses' table
        const query = `
            SELECT id, course_name, course_code 
            FROM courses 
            ORDER BY course_name;
        `;
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        // Changed log message to reflect the new route purpose
        console.error('Error fetching courses:', err); 
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;