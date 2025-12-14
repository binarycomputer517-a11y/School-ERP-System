const express = require('express');
const router = express.Router();

// ✅ Corrected imports to match your project structure
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// =================================================================
// --- Subject Management Routes ---
// =================================================================

// 1. Get all subjects linked to a specific course ID.
router.get('/course/:courseId', authenticateToken, authorize(['Admin', 'Teacher', 'Super Admin']), async (req, res) => {
    const { courseId } = req.params;
    try {
        const result = await pool.query(`
            SELECT s.id, s.subject_name, s.subject_code 
            FROM subjects s
            JOIN course_subjects cs ON s.id = cs.subject_id 
            WHERE cs.course_id = $1
            ORDER BY s.subject_name;
        `, [courseId]);

        res.status(200).json(result.rows);
    } catch (err) {
        console.error(`Error fetching subjects for course ${courseId}:`, err);
        res.status(500).json({ message: 'Server error fetching subjects for course', error: err.message });
    }
});


// --- Standard CRUD for managing the master list of all subjects ---

// 2. GET all subjects
// DEFINITIVE FIX: Authorization list updated to include 'Super Admin'
// This should resolve the persistent 403 Forbidden error for the subject dropdown.
router.get('/', authenticateToken, authorize(['Admin', 'Teacher', 'Super Admin']), async (req, res) => {
    try {
        // Updated to order by 'id'
        const result = await pool.query('SELECT * FROM subjects ORDER BY id');
        res.json(result.rows);
    } catch (err) { 
        console.error('Error fetching all subjects:', err);
        res.status(500).json({ message: 'Error fetching subjects', error: err.message }); 
    }
});

// 3. POST a new subject
router.post('/', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { subject_name, subject_code } = req.body;
    try {
        const newSubject = await pool.query(
            "INSERT INTO subjects (subject_name, subject_code) VALUES ($1, $2) RETURNING *", 
            [subject_name, subject_code]
        );
        res.status(201).json(newSubject.rows[0]);
    } catch (err) { 
        res.status(500).json({ message: 'Error creating subject', error: err.message }); 
    }
});

// 4. PUT (Update) a subject by ID
router.put('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { subject_name, subject_code } = req.body;
    try {
        // Updated WHERE clause to use 'id'
        const result = await pool.query(
            "UPDATE subjects SET subject_name = $1, subject_code = $2 WHERE id = $3 RETURNING *",
            [subject_name, subject_code, req.params.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Subject not found' });
        res.status(200).json(result.rows[0]);
    } catch (err) { 
        res.status(500).json({ message: 'Error updating subject', error: err.message }); 
    }
});

// 5. DELETE a subject by ID
router.delete('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        // Updated WHERE clause to use 'id'
        const result = await pool.query("DELETE FROM subjects WHERE id = $1 RETURNING id", [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Subject not found.' });
        res.status(200).json({ message: 'Subject deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') { // Foreign key constraint error
             return res.status(409).json({ message: 'Cannot delete subject. It is still linked to other records (e.g., Exams or Courses).' });
        }
        res.status(500).json({ message: 'Error deleting subject', error: err.message });
    }
});

module.exports = router;