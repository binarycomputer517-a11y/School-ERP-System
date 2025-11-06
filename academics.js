const express = require('express');
const router = express.Router();
// Assuming fix: const { pool } = require('../database');
const { pool } = require('../database');

// --- Course Management ---
router.post('/courses', async (req, res) => {
    const { course_name, course_code } = req.body;
    try {
        const newCourse = await pool.query(
            "INSERT INTO courses (course_name, course_code) VALUES ($1, $2) RETURNING *",
            [course_name, course_code]
        );
        res.status(201).json(newCourse.rows[0]);
    } catch (err) { res.status(500).json({ message: 'Error creating course', error: err.message }); }
});

router.get('/courses', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses ORDER BY course_id');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching courses:', err);
        res.status(500).json({ message: 'Server error while fetching courses', error: err.message });
    }
});

router.put('/courses/:id', async (req, res) => {
    const { course_name, course_code } = req.body;
    const { id } = req.params;
    try {
        const result = await pool.query(
            "UPDATE courses SET course_name = $1, course_code = $2 WHERE course_id = $3 RETURNING *",
            [course_name, course_code, id]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Course not found' });
        res.status(200).json(result.rows[0]);
    } catch (err) { res.status(500).json({ message: 'Error updating course', error: err.message }); }
});

router.delete('/courses/:id', async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM courses WHERE course_id = $1 RETURNING course_id", [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Course not found.' });
        res.status(200).json({ message: 'Course deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({
                message: 'Cannot delete course. It is still referenced by other records (e.g., batches, students).'
            });
        }
        res.status(500).json({ message: 'Error deleting course', error: err.message });
    }
});


// --- Batch Management ---
router.post('/batches', async (req, res) => {
    const { batch_name, batch_code } = req.body;
    
    // 💡 FIX: Input Validation and Sanitization
    if (!batch_name || !batch_code || batch_name.trim() === '' || batch_code.trim() === '') {
        return res.status(400).json({ message: 'Batch name and code are required.' });
    }
    
    // 💡 DIAGNOSTIC LOGGING (To help check server input if 500 persists)
    console.log("Received Batches Data for POST:", req.body);

    try {
        const newBatch = await pool.query(
            "INSERT INTO batches (batch_name, batch_code) VALUES ($1, $2) RETURNING *",
            [batch_name.trim(), batch_code.trim()] // Trim whitespace for cleanliness
        );
        res.status(201).json(newBatch.rows[0]);
    } catch (err) { 
        // 💡 DIAGNOSTIC LOGGING (For detailed PostgreSQL error)
        console.error('PostgreSQL Error on Batch Creation:', err);
        // Check for specific unique violation (error code 23505)
        if (err.code === '23505') {
            return res.status(409).json({ message: 'Batch code already exists.' });
        }
        res.status(500).json({ message: 'Error creating batch', error: err.message }); 
    }
});

router.get('/batches', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM batches ORDER BY batch_id');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching batches:', err);
        res.status(500).json({ message: 'Server error while fetching batches', error: err.message });
    }
});

router.put('/batches/:id', async (req, res) => {
    const { batch_name, batch_code } = req.body;
    const { id } = req.params;
    try {
        const result = await pool.query(
            "UPDATE batches SET batch_name = $1, batch_code = $2 WHERE batch_id = $3 RETURNING *",
            [batch_name, batch_code, id]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Batch not found' });
        res.status(200).json(result.rows[0]);
    } catch (err) { res.status(500).json({ message: 'Error updating batch', error: err.message }); }
});

router.delete('/batches/:id', async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM batches WHERE batch_id = $1 RETURNING batch_id", [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Batch not found.' });
        res.status(200).json({ message: 'Batch deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({
                message: 'Cannot delete batch. It is still referenced by other records (like students).'
            });
        }
        console.error('Error deleting batch:', err);
        res.status(500).json({ message: 'Error deleting batch', error: err.message });
    }
});


// --- Subject Management ---
router.post('/subjects', async (req, res) => {
    const { subject_name, subject_code } = req.body;
    try {
        const newSubject = await pool.query("INSERT INTO subjects (subject_name, subject_code) VALUES ($1, $2) RETURNING *", [subject_name, subject_code]);
        res.status(201).json(newSubject.rows[0]);
    } catch (err) { res.status(500).json({ message: 'Error creating subject', error: err.message }); }
});

router.get('/subjects', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM subjects ORDER BY subject_id');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Error fetching subjects', error: err.message }); }
});

router.put('/subjects/:id', async (req, res) => {
    const { subject_name, subject_code } = req.body;
    const { id } = req.params;
    try {
        const result = await pool.query(
            "UPDATE subjects SET subject_name = $1, subject_code = $2 WHERE subject_id = $3 RETURNING *",
            [subject_name, subject_code, id]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Subject not found' });
        res.status(200).json(result.rows[0]);
    } catch (err) { res.status(500).json({ message: 'Error updating subject', error: err.message }); }
});

router.delete('/subjects/:id', async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM subjects WHERE subject_id = $1 RETURNING subject_id", [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Subject not found.' });
        res.status(200).json({ message: 'Subject deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({
                message: 'Cannot delete subject. It is still referenced by other records (e.g., assignments, teachers).'
            });
        }
        res.status(500).json({ message: 'Error deleting subject', error: err.message });
    }
});

// --- Fee Structure Management ---
router.post('/fees/structures', async (req, res) => {
    // NOTE: This route assumes the client sends { fee_name, total_amount, description }
    const { fee_name, total_amount, description, ...other_fields } = req.body; 

    // To handle the many fields from the client, we need to adjust the server logic or the database.
    // Since the database only has fee_name, total_amount, description, we'll try to insert everything.
    // WARNING: This assumes your database structure was modified to include all fields!
    
    // For now, we will assume the client sends ALL fields, and we'll just insert the mandatory ones
    // which aligns with the simple fee_structures table created in database.js:
    
    try {
        // If your fee_structures table includes all fee breakdown fields, you MUST update this query.
        // Assuming the FE sends all fields for now, we'll just insert the basic three:
        
        const newFeeStructure = await pool.query(
            "INSERT INTO fee_structures (fee_name, total_amount, description) VALUES ($1, $2, $3) RETURNING *",
            [fee_name, total_amount, description]
        );
        res.status(201).json(newFeeStructure.rows[0]);
    } catch (err) {
        console.error('Error creating fee structure:', err);
        res.status(500).json({ message: 'Error creating fee structure', error: err.message });
    }
});

router.get('/fees/structures', async (req, res) => {
    // This GET must return all fields the client needs for display/edit (9+ fields).
    // It currently only returns the 3 fields from the database.
    // If your database structure only has 3 fields, the client will lack data for the fee breakdown.
    // We send what we have:
    try {
        const result = await pool.query('SELECT * FROM fee_structures ORDER BY fee_structure_id');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching fee structures:', err);
        res.status(500).json({ message: 'Server error while fetching fee structures', error: err.message });
    }
});

router.put('/fees/structures/:id', async (req, res) => {
    // Similar problem: PUT only updates 3 fields, but the client sends 9+ fields.
    const { fee_name, total_amount, description } = req.body;
    const { id } = req.params;
    try {
        const result = await pool.query(
            "UPDATE fee_structures SET fee_name = $1, total_amount = $2, description = $3 WHERE fee_structure_id = $4 RETURNING *",
            [fee_name, total_amount, description, id]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Fee structure not found' });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error updating fee structure:', err);
        res.status(500).json({ message: 'Error updating fee structure', error: err.message });
    }
});

router.delete('/fees/structures/:id', async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM fee_structures WHERE fee_structure_id = $1 RETURNING fee_structure_id", [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Fee structure not found.' });
        res.status(200).json({ message: 'Fee structure deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({
                message: 'Cannot delete fee structure. It is currently referenced by one or more batches.'
            });
        }
        console.error('Error deleting fee structure:', err);
        res.status(500).json({ message: 'Error deleting fee structure', error: err.message });
    }
});

module.exports = router;