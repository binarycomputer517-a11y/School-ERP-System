const express = require('express');
const router = express.Router();
const { pool } = require('../database'); // Ensure path is correct
const { authenticateToken, authorize } = require('../authMiddleware'); // Ensure path is correct
const { toUUID } = require('../utils/helpers'); // Assuming helper import is fixed

// --- Configuration ---
const STUDENTS_TABLE = 'students'; 

// Roles for management actions (lowercase for compatibility)
const ALUMNI_MANAGEMENT_ROLES = ['admin', 'super admin', 'coordinator'];
const ALL_AUTHENTICATED_ROLES = ['admin', 'super admin', 'teacher', 'coordinator', 'student'];

// =========================================================================
// 1. GET CANDIDATES (Students not yet added as Alumni)
// =========================================================================
router.get('/candidates', authenticateToken, authorize(ALUMNI_MANAGEMENT_ROLES), async (req, res) => {
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
// =========================================================================
router.post('/', authenticateToken, authorize(ALUMNI_MANAGEMENT_ROLES), async (req, res) => {
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
// 3. GET ALL ALUMNI (Including Photo Path and Enrollment No)
// =========================================================================
router.get('/', authenticateToken, authorize(ALL_AUTHENTICATED_ROLES), async (req, res) => {
    try {
        // --- FINALIZED QUERY ---: Includes profile_image_path and uses the correct s.phone_number column.
        const query = `
            SELECT 
                a.id, 
                a.student_id,
                a.passing_year, 
                a.current_profession, 
                a.current_company,
                a.linkedin_profile,
                a.contact_number AS alumni_contact, 
                a.email AS alumni_email,
                
                -- Student details from the joined table:
                s.first_name || ' ' || s.last_name AS student_name,
                s.enrollment_no, 
                s.phone_number AS student_contact, -- Corrected column name confirmed from schema
                s.profile_image_path -- NEW: Added for the ID Card feature
            FROM alumni a
            JOIN students s ON a.student_id = s.student_id
            ORDER BY a.passing_year DESC, s.last_name ASC
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
// =========================================================================
router.delete('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
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