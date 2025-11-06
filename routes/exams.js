const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Roles Configuration (UPDATED) ---
const EXAM_MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator']; 
const EXAM_CRUD_ROLES = ['Super Admin', 'Admin']; 
const EXAM_VIEW_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student'];

// =================================================================
// --- Exam Listing and Retrieval Routes (/api/exams/...) ---
// =================================================================

// GET all exams for the main list/dropdowns (Used by loadExams())
router.get('/list', authenticateToken, authorize(EXAM_VIEW_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`
            -- CTE to select ONE representative schedule detail (the earliest scheduled subject) per exam.
            WITH ExamDetails AS (
                SELECT DISTINCT ON (exam_id) 
                    exam_id,
                    max_marks AS total_marks,
                    c.course_name, 
                    b.batch_name,
                    sch.course_id, 
                    sch.batch_id   
                FROM exam_schedules sch
                LEFT JOIN courses c ON sch.course_id = c.id
                LEFT JOIN batches b ON sch.batch_id = b.id
                ORDER BY exam_id, sch.exam_date, sch.start_time 
            )
            SELECT 
                e.id AS exam_id, 
                e.exam_name, 
                e.exam_type, 
                e.exam_date, 
                e.academic_session_id,
                
                -- Attach details from the CTE (these are non-aggregated columns from the CTE)
                ed.total_marks,
                ed.course_name, 
                ed.batch_name,
                ed.course_id,
                ed.batch_id
            FROM exams e
            LEFT JOIN ExamDetails ed ON e.id = ed.exam_id
            ORDER BY e.exam_date DESC;
        `);
        
        res.json(result.rows);
    } catch (error) {
        console.error('CRITICAL SQL ERROR fetching exam list:', error);
        res.status(500).json({ message: 'Failed to fetch exams.' });
    }
});

// GET a single exam by its ID (for the view/edit modal)
router.get('/:id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT 
                e.*, 
                -- Aggregating details from the first linked schedule item.
                COALESCE(MAX(sch.max_marks), 0) AS total_marks,
                MAX(c.course_name) AS course_name, 
                MAX(b.batch_name) AS batch_name,
                -- Safely fetching UUIDs via subquery
                (SELECT course_id FROM exam_schedules WHERE exam_id = e.id LIMIT 1) AS course_id, 
                (SELECT batch_id FROM exam_schedules WHERE exam_id = e.id LIMIT 1) AS batch_id
             FROM exams e
             LEFT JOIN exam_schedules sch ON e.id = sch.exam_id
             LEFT JOIN courses c ON sch.course_id = c.id
             LEFT JOIN batches b ON sch.batch_id = b.id
             WHERE e.id = $1
             GROUP BY e.id 
             LIMIT 1;`, [id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Exam not found.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching single exam:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// =================================================================
// --- Exam Schedule Routes (/api/exams/schedule/...) ---
// =================================================================

// GET exam schedules by exam ID
router.get('/schedule/:exam_id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { exam_id } = req.params;
        const result = await pool.query(
            `SELECT 
                es.id AS schedule_id, es.course_id, es.batch_id, es.subject_id,
                es.room_number, es.start_time, es.end_time, es.exam_date,
                s.subject_name, s.subject_code, 
                e.exam_name,
                es.max_marks /* Added max_marks to schedule response */
             FROM exam_schedules es
             JOIN subjects s ON es.subject_id = s.id 
             JOIN exams e ON es.exam_id = e.id 
             WHERE es.exam_id = $1
             ORDER BY es.exam_date, es.start_time`, 
             [exam_id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching exam schedule:', error);
        res.status(500).json({ message: 'Failed to fetch schedule.' });
    }
});

// CREATE a new exam schedule entry
router.post('/schedule', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { exam_id, course_id, batch_id, subject_id, exam_date, room_number, start_time, end_time, max_marks } = req.body;

    if (!exam_id || !subject_id || !course_id || !batch_id || !exam_date || !room_number || !start_time || !end_time) {
        return res.status(400).json({ message: 'Missing required fields for schedule creation.' });
    }

    try {
        const query = `
            INSERT INTO exam_schedules (exam_id, course_id, batch_id, subject_id, exam_date, room_number, start_time, end_time, max_marks)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id AS schedule_id;
        `;
        // Ensure max_marks is saved as a number, defaulting to 100 if missing or invalid
        const marks = (max_marks !== null && max_marks !== undefined && !isNaN(max_marks)) ? max_marks : 100;
        const values = [exam_id, course_id, batch_id, subject_id, exam_date, room_number, start_time, end_time, marks];
        const newSchedule = await pool.query(query, values);

        res.status(201).json(newSchedule.rows[0]);
    } catch (error) {
        console.error('Schedule creation error:', error);
        res.status(500).json({ message: 'Failed to create schedule entry due to a server error.' });
    }
});

// UPDATE an existing exam schedule entry
router.put('/schedule/:schedule_id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { schedule_id } = req.params;
        const { exam_id, course_id, batch_id, subject_id, exam_date, room_number, start_time, end_time, max_marks } = req.body;

        if (!exam_id || !subject_id || !course_id || !batch_id || !exam_date || !room_number || !start_time || !end_time) {
            return res.status(400).json({ message: 'Missing required fields for schedule update.' });
        }
        
        // Ensure max_marks is saved as a number, defaulting to 100 if missing or invalid
        const marks = (max_marks !== null && max_marks !== undefined && !isNaN(max_marks)) ? max_marks : 100;

        const result = await pool.query(
            `UPDATE exam_schedules SET 
                exam_id = $1, course_id = $2, batch_id = $3, subject_id = $4, exam_date = $5, room_number = $6, start_time = $7, end_time = $8, max_marks = $9
             WHERE id = $10 RETURNING *`,
            [exam_id, course_id, batch_id, subject_id, exam_date, room_number, start_time, end_time, marks, schedule_id]
        );
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Schedule entry not found.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating schedule:', error);
        res.status(500).json({ message: 'Server error while updating schedule.' });
    }
});

// DELETE an exam schedule entry
router.delete('/schedule/:schedule_id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { schedule_id } = req.params;
    
    try {
        // Check for linked marks *before* deleting the schedule (Prevents Foreign Key Violation on marks)
        const linkedMarks = await pool.query('SELECT 1 FROM marks m JOIN exam_schedules es ON m.exam_id = es.exam_id AND m.subject_id = es.subject_id WHERE es.id = $1 LIMIT 1', [schedule_id]);
        
        if (linkedMarks.rowCount > 0) {
            return res.status(409).json({ message: 'Cannot delete schedule. It has student marks associated with the exam/subject. You must delete marks first.' });
        }

        const result = await pool.query('DELETE FROM exam_schedules WHERE id = $1 RETURNING id', [schedule_id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Schedule entry not found.' });
        }

        res.status(200).json({ message: 'Schedule entry deleted successfully.' });

    } catch (error) {
        console.error('Error deleting schedule:', error);
        res.status(500).json({ message: 'Server error while deleting schedule.' });
    }
});

// =================================================================
// --- Main Exam CRUD Routes (/api/exams/...) ---
// =================================================================

// CREATE a new exam
router.post('/', authenticateToken, authorize(EXAM_CRUD_ROLES), async (req, res) => {
    const {
        exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id
    } = req.body;
    
    // Basic validation check on required fields
    if (!exam_name || !exam_date || !academic_session_id) {
        // Return 400 Bad Request if essential fields are missing
        return res.status(400).json({ message: 'Missing required fields for exam creation (Name, Date, or Session ID).' });
    }

    try {
        const query = `
            INSERT INTO exams (exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        const values = [
            exam_name, exam_type || 'General', exam_date, 
            is_midterm_assessment || false,
            academic_session_id
        ];
        const newExam = await pool.query(query, values);

        res.status(201).json(newExam.rows[0]);
    } catch (error) {
        console.error('Exam creation error:', error);
        res.status(500).json({ message: 'Failed to create exam due to a server error.' });
    }
});

// UPDATE an existing exam by its ID
router.put('/:id', authenticateToken, authorize(EXAM_CRUD_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        const { exam_name, exam_type, exam_date, is_midterm_assessment } = req.body;

        if (!exam_name || !exam_date) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        const result = await pool.query(
            `UPDATE exams SET 
                exam_name = $1, exam_type = $2, exam_date = $3, is_midterm_assessment = $4
             WHERE id = $5 RETURNING *`,
            [exam_name, exam_type || 'General', exam_date, is_midterm_assessment || false, id] 
        );
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Exam not found.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating exam:', error);
        res.status(500).json({ message: 'Server error while updating exam.' });
    }
});

// DELETE an exam by its ID (Includes integrity checks for 409 Conflict)
router.delete('/:id', authenticateToken, authorize(EXAM_CRUD_ROLES), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // CHECK 1: Check for linked student marks
        const linkedMarks = await client.query('SELECT 1 FROM marks WHERE exam_id = $1 LIMIT 1', [id]);
        if (linkedMarks.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Cannot delete exam. It has student marks associated with it. You must delete marks first.' });
        }
        
        // CHECK 2: Check for linked schedule entries
        const linkedSchedules = await client.query('SELECT 1 FROM exam_schedules WHERE exam_id = $1 LIMIT 1', [id]);
        if (linkedSchedules.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Cannot delete exam. It has schedule entries associated with it. Please delete the schedules first.' });
        }

        const result = await client.query('DELETE FROM exams WHERE id = $1 RETURNING id', [id]);
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Exam not found.' });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Exam deleted successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting exam:', error);
        res.status(500).json({ message: 'Server error while deleting exam.' });
    } finally {
        client.release();
    }
});

module.exports = router;