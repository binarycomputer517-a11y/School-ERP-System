const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// =================================================================
// --- Subject Management Routes ---
// =================================================================

// ⭐ FIXED: Get all subjects linked to a specific course ID.
router.get('/course/:courseId', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { courseId } = req.params;
    try {
        const result = await pool.query(`
            SELECT s.id, s.subject_name, s.subject_code 
            FROM subjects s
            JOIN course_subjects cs ON s.id = cs.subject_id -- FIX: s.subject_id changed to s.id
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

// GET all subjects
router.get('/', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator']), async (req, res) => {
    try {
        // FIX: ORDER BY subject_id changed to ORDER BY id
        const result = await pool.query('SELECT * FROM subjects ORDER BY id'); 
        res.json(result.rows);
    } catch (err) { 
        console.error('Error fetching all subjects:', err);
        res.status(500).json({ message: 'Error fetching subjects', error: err.message }); 
    }
});

// POST a new subject
router.post('/', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { subject_name, subject_code } = req.body;
    try {
        // This query is likely fine as 'id' should have a default UUID generator
        const newSubject = await pool.query(
            "INSERT INTO subjects (subject_name, subject_code) VALUES ($1, $2) RETURNING *", 
            [subject_name, subject_code]
        );
        res.status(201).json(newSubject.rows[0]);
    } catch (err) { 
        res.status(500).json({ message: 'Error creating subject', error: err.message }); 
    }
});

// PUT (Update) a subject by ID
router.put('/:id', authenticateToken, authorize(['Admin']), async (req, res) => {
    const { subject_name, subject_code } = req.body;
    try {
        // FIX: WHERE subject_id changed to WHERE id
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

// DELETE a subject by ID
router.delete('/:id', authenticateToken, authorize(['Admin']), async (req, res) => {
    try {
        // FIX: WHERE subject_id changed to WHERE id
        const result = await pool.query("DELETE FROM subjects WHERE id = $1 RETURNING id", [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Subject not found.' });
        res.status(200).json({ message: 'Subject deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') { // Foreign key constraint error
             return res.status(409).json({ message: 'Cannot delete subject. It is still linked to other records.' });
        }
        res.status(500).json({ message: 'Error deleting subject', error: err.message });
    }
});

module.exports = router;