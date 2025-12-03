const express = require('express');
const router = express.Router();
const { pool } = require('../database'); // Ensure path is correct
const { authenticateToken, authorize } = require('../authMiddleware'); // Ensure path is correct

// =========================================================================
// 1. GET CANDIDATES
// Fetch students who are NOT yet in the alumni table.
// This populates the "Select Student" dropdown to prevent duplicates.
// =========================================================================
router.get('/candidates', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const query = `
            SELECT s.student_id, s.first_name, s.last_name, s.enrollment_no
            FROM students s
            WHERE s.student_id NOT IN (SELECT student_id FROM alumni)
            ORDER BY s.first_name ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching student candidates:', err);
        res.status(500).json({ error: 'Server error fetching candidates' });
    }
});

// =========================================================================
// 2. ADD ALUMNI
// Move a student to the alumni network with extended details.
// =========================================================================
router.post('/', authenticateToken, authorize('Admin'), async (req, res) => {
    // Destructure all potential fields from the frontend form
    const { 
        student_id, 
        passing_year, 
        current_profession, 
        current_company, 
        linkedin_profile, 
        contact_number, 
        email 
    } = req.body;
    
    // Basic validation
    if (!student_id || !passing_year) {
        return res.status(400).json({ error: 'Student and Passing Year are required' });
    }

    try {
        const query = `
            INSERT INTO alumni 
            (student_id, passing_year, current_profession, current_company, linkedin_profile, contact_number, email) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            ON CONFLICT (student_id) DO NOTHING
        `;
        
        await pool.query(query, [
            student_id, 
            passing_year, 
            current_profession, 
            current_company, 
            linkedin_profile, 
            contact_number, 
            email
        ]);
        
        res.status(201).json({ message: 'Alumni added successfully' });
    } catch (err) {
        console.error('Error adding to alumni:', err);
        res.status(500).json({ error: 'Server error adding alumni', details: err.message });
    }
});

// =========================================================================
// 3. GET ALL ALUMNI
// List existing alumni with Student Name joined from students table.
// =========================================================================
router.get('/', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id, 
                a.student_id,
                a.passing_year, 
                a.current_profession, 
                a.current_company,
                a.linkedin_profile,
                a.contact_number, 
                a.email,
                -- Concatenate first and last name from the students table
                s.first_name || ' ' || s.last_name AS student_name,
                s.enrollment_no
            FROM alumni a
            JOIN students s ON a.student_id = s.student_id
            ORDER BY a.passing_year DESC, s.first_name ASC
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching alumni:', err);
        res.status(500).json({ error: 'Server error fetching alumni', details: err.message });
    }
});

// =========================================================================
// 4. DELETE ALUMNI
// Remove a student from the alumni list.
// =========================================================================
router.delete('/:id', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM alumni WHERE id = $1', [req.params.id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Alumni record not found' });
        }
        
        res.json({ message: 'Alumni deleted successfully' });
    } catch (err) {
        console.error('Error deleting alumni:', err);
        res.status(500).json({ error: 'Server error deleting alumni' });
    }
});

module.exports = router;