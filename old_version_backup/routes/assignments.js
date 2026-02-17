// routes/assignments.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Configuration for Roles ---
const MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator']; 
const VIEW_ROLES = [...MANAGER_ROLES, 'Student']; // Student needs view access to their assignments
const TEACHER_ROLES = ['Teacher', 'Coordinator'];

// ===================================
// Helper: Error Handler
// ===================================
const handleQueryError = (err, res, entity = 'item') => {
    console.error(`Error operating on ${entity}:`, err);
    if (err.code === '23505') {
        return res.status(409).json({ message: `This ${entity} already exists (name, code, or combination).` });
    }
    if (err.code === '23503') {
        return res.status(400).json({ message: `Cannot delete ${entity} as it is referenced by other data.` });
    }
    res.status(500).json({ message: 'Internal server error' });
};

// ===================================
// 1. GET Assignments for Manager Dashboard ( /api/assignments/manager )
// ===================================

router.get('/manager', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    try {
        const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = true LIMIT 1");
        if (sessionRes.rows.length === 0) {
            return res.status(200).json([]);
        }
        const activeSessionId = sessionRes.rows[0].id;

        const query = `
            SELECT 
                ha.id, ha.title, ha.due_date, 
                c.course_name, b.batch_name, s.subject_name,
                -- Count total submissions for this assignment (ASUB is the alias for assignment_submissions)
                (SELECT COUNT(*) FROM assignment_submissions AS ASUB WHERE ASUB.assignment_id = ha.id) AS total_submissions
            FROM homework_assignments ha
            JOIN courses c ON ha.course_id = c.id
            JOIN batches b ON ha.batch_id = b.id
            JOIN subjects s ON ha.subject_id = s.id
            WHERE ha.academic_session_id = $1
            ORDER BY ha.due_date DESC;
        `;
        const { rows } = await pool.query(query, [activeSessionId]);
        res.status(200).json(rows);
    } catch (err) {
        handleQueryError(err, res, 'assignments list');
    }
});

// ===================================
// 2. POST Create New Assignment ( /api/assignments )
// ===================================

router.post('/', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { 
        course_id, batch_id, subject_id, 
        title, instructions, due_date, max_marks
    } = req.body;
    
    // Assuming user info is on req.user
    const created_by = req.user ? req.user.id : null; 
    const branch_id = req.user ? req.user.branch_id : null; 

    if (!course_id || !batch_id || !subject_id || !title || !due_date) {
        return res.status(400).json({ message: "Missing required fields for assignment." });
    }

    try {
        const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = true LIMIT 1");
        if (sessionRes.rows.length === 0) {
            return res.status(400).json({ message: "No active academic session found. Cannot create assignment." });
        }
        const academic_session_id = sessionRes.rows[0].id;

        const query = `
            INSERT INTO homework_assignments (
                branch_id, academic_session_id, course_id, batch_id, subject_id, 
                title, instructions, due_date, max_marks, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, title, due_date;
        `;

        const { rows } = await pool.query(query, [
            branch_id, academic_session_id, course_id, batch_id, subject_id, 
            title, instructions, due_date, max_marks || 10, created_by
        ]);
        res.status(201).json(rows[0]);
    } catch (err) {
        handleQueryError(err, res, 'assignment creation');
    }
});

// ===================================
// 3. PUT Update Assignment ( /api/assignments/:id )
// ===================================

router.put('/:id', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    const { 
        course_id, batch_id, subject_id, 
        title, instructions, due_date, max_marks
    } = req.body;

    if (!course_id || !batch_id || !subject_id || !title || !due_date) {
        return res.status(400).json({ message: "Missing required fields for assignment update." });
    }

    try {
        const query = `
            UPDATE homework_assignments SET 
                course_id = $1, batch_id = $2, subject_id = $3, 
                title = $4, instructions = $5, due_date = $6, max_marks = $7,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $8
            RETURNING id, title, due_date;
        `;
        const { rows } = await pool.query(query, [
            course_id, batch_id, subject_id, title, instructions, due_date, max_marks || 10, id
        ]);

        if (rows.length === 0) return res.status(404).json({ message: 'Assignment not found' });
        res.status(200).json(rows[0]);
    } catch (err) {
        handleQueryError(err, res, 'assignment update');
    }
});

// ===================================
// 4. DELETE Assignment ( /api/assignments/:id )
// ===================================

router.delete('/:id', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const { rowCount } = await pool.query('DELETE FROM homework_assignments WHERE id = $1', [id]);
        if (rowCount === 0) return res.status(404).json({ message: 'Assignment not found' });
        res.status(200).json({ message: 'Assignment deleted successfully' });
    } catch (err) {
        handleQueryError(err, res, 'assignment deletion');
    }
});

// ===================================
// 5. GET Single Assignment Details ( /api/assignments/:id )
// ===================================

router.get('/:id', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                id, course_id, batch_id, subject_id, 
                title, instructions, due_date, max_marks
            FROM homework_assignments 
            WHERE id = $1;
        `;
        const { rows } = await pool.query(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Assignment not found' });
        }
        
        // Format due_date to fit the HTML datetime-local input type (YYYY-MM-DDTHH:MM)
        const assignment = rows[0];
        if (assignment.due_date) {
            // Converts the UTC timestamp to a local ISO format string, then trims to YYYY-MM-DDTHH:MM
            const date = new Date(assignment.due_date);
            assignment.due_date = date.toISOString().slice(0, 16);
        }

        res.status(200).json(assignment);
    } catch (err) {
        handleQueryError(err, res, 'single assignment lookup');
    }
});


module.exports = router;