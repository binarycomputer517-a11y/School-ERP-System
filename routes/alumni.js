// routes/alumni.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// Add Alumni
router.post('/', authenticateToken, authorize('Admin'), async (req, res) => {
    const { student_id, passing_year, current_profession, current_company, contact_number, email } = req.body;
    try {
        await pool.query(
            "INSERT INTO alumni (student_id, passing_year, current_profession, current_company, contact_number, email) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (student_id) DO NOTHING",
            [student_id, passing_year, current_profession, current_company, contact_number, email]
        );
        res.status(201).send('Student added to alumni successfully');
    } catch (err) {
        console.error('Error adding to alumni:', err);
        res.status(500).json({ error: 'Server error adding alumni', details: err.message });
    }
});

// Get All Alumni
router.get('/', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                a.id, 
                a.passing_year, 
                a.current_profession, 
                a.contact_number, 
                a.email,
                -- We concatenate first and last name from the students table
                s.first_name || ' ' || s.last_name AS student_name
            FROM alumni a
            JOIN students s ON a.student_id = s.student_id  -- FIXED: s.student_id, not s.id
            ORDER BY a.passing_year DESC, s.first_name;
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching alumni:', err);
        res.status(500).json({ error: 'Server error fetching alumni', details: err.message });
    }
});

module.exports = router;