// routes/exams.js - Handles Exam and Schedule CRUD (Mounted under /api/exams)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Role Definitions ---
const EXAM_MANAGER_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
const EXAM_VIEWER_ROLES = ['Super Admin', 'Admin', 'Coordinator', 'Teacher', 'Student'];

// =======================================================================================
// 1. EXAM CRUD ROUTES
// =======================================================================================

/**
 * @route   GET /api/exams/list
 * @desc    Fetches a comprehensive list of all exams.
 */
router.get('/list', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                e.id AS exam_id, e.exam_name, e.exam_type, e.exam_date, e.course_id, e.batch_id,
                c.course_name, b.batch_name, b.batch_code,
                (e.max_theory_marks + e.max_practical_marks) AS total_marks,
                e.max_theory_marks, e.max_practical_marks
            FROM exams e
            LEFT JOIN courses c ON e.course_id = c.id
            LEFT JOIN batches b ON e.batch_id = b.id
            ORDER BY e.exam_date DESC, c.course_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching comprehensive exam list:', error);
        res.status(500).json({ message: 'Failed to retrieve combined exam list.' });
    }
});

/**
 * @route   POST /api/exams
 * @desc    Creates a new exam entry.
 * 🚨 This is the dedicated Exam Creation route.
 */
router.post('/', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id,
        course_id, batch_id, max_theory_marks, max_practical_marks
    } = req.body;

    // 🚨 This validation must ONLY run when creating an exam.
    if (!exam_name || !exam_date || !course_id || !batch_id || !academic_session_id) {
        return res.status(400).json({ message: 'Missing required fields for exam creation: name, date, course, batch, or session.' });
    }

    try {
        const query = `
            INSERT INTO exams (
                exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id,
                course_id, batch_id, max_theory_marks, max_practical_marks
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id AS exam_id, exam_name;
        `;
        
        const newExam = await pool.query(query, [
            exam_name, exam_type, exam_date, is_midterm_assessment || false, academic_session_id,
            course_id, batch_id, max_theory_marks || 100, max_practical_marks || 0
        ]);

        res.status(201).json(newExam.rows[0]);

    } catch (error) {
        console.error('Error creating exam:', error);
        res.status(500).json({ message: 'Failed to create exam.' });
    }
});

/**
 * @route   DELETE /api/exams/:id
 * @desc    Deletes an exam by its ID.
 */
router.delete('/:id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM exams WHERE id = $1', [id]); 
        res.status(200).json({ message: 'Exam deleted successfully.' });
    } catch (error) {
        console.error('Error deleting exam:', error);
        res.status(500).json({ message: 'Failed to delete exam.' });
    }
});

// =======================================================================================
// 2. EXAM SCHEDULE CRUD ROUTES
// =======================================================================================

/**
 * @route   GET /api/exams/schedule/:examId
 * @desc    Fetches the schedule for a specific exam.
 */
router.get('/schedule/:examId', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId } = req.params;
        const query = `
            SELECT 
                es.id AS schedule_id, es.subject_id, s.subject_name, s.subject_code,
                es.exam_date, es.start_time, es.end_time, es.room_number, es.max_marks
            FROM exam_schedules es
            JOIN subjects s ON es.subject_id = s.id
            WHERE es.exam_id = $1
            ORDER BY es.exam_date, es.start_time;
        `;
        const result = await pool.query(query, [examId]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching exam schedule:', error);
        res.status(500).json({ message: 'Failed to fetch exam schedule.' });
    }
});

/**
 * @route   POST /api/exams/schedule
 * @desc    Creates a new schedule entry for an exam subject.
 */
router.post('/schedule', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_id, course_id, batch_id, subject_id, exam_date,
        room_number, start_time, end_time
    } = req.body;

    if (!exam_id || !course_id || !batch_id || !subject_id || !exam_date || !start_time || !end_time) {
        return res.status(400).json({ message: 'Missing required schedule fields.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); 

        const marksQuery = `
            SELECT (max_theory_marks + max_practical_marks) AS derived_max_marks
            FROM exams
            WHERE id = $1::uuid;
        `;
        const marksResult = await client.query(marksQuery, [exam_id]);

        if (marksResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Associated Exam not found.' });
        }
        const derived_max_marks = marksResult.rows[0].derived_max_marks;
        
        const query = `
            INSERT INTO exam_schedules (
                exam_id, course_id, batch_id, subject_id, exam_date,
                room_number, start_time, end_time, max_marks
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id AS schedule_id;
        `;
        const newSchedule = await client.query(query, [
            exam_id, course_id, batch_id, subject_id, exam_date,
            room_number, start_time, end_time, derived_max_marks 
        ]);
        
        await client.query('COMMIT'); 
        res.status(201).json(newSchedule.rows[0]);

    } catch (error) {
        if (client) await client.query('ROLLBACK'); 
        if (error.code === '23505') {
            return res.status(409).json({ message: 'This subject is already scheduled for this exam and batch.' });
        }
        console.error('Error creating schedule entry:', error);
        res.status(500).json({ message: 'Failed to create schedule entry.', error: error.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * @route   PUT /api/exams/schedule/:scheduleId
 * @desc    Updates an existing schedule entry.
 */
router.put('/schedule/:scheduleId', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { scheduleId } = req.params;
    const { subject_id, exam_date, room_number, start_time, end_time } = req.body;

    try {
        const query = `
            UPDATE exam_schedules
            SET 
                subject_id = $1, exam_date = $2, room_number = $3,
                start_time = $4, end_time = $5, updated_at = NOW()
            WHERE id = $6
            RETURNING *;
        `;
        const updatedSchedule = await pool.query(query, [
            subject_id, exam_date, room_number, start_time, end_time, scheduleId
        ]);
        
        if (updatedSchedule.rows.length === 0) {
            return res.status(404).json({ message: 'Schedule entry not found.' });
        }
        res.status(200).json(updatedSchedule.rows[0]);

    } catch (error) {
        console.error('Error updating schedule entry:', error);
        res.status(500).json({ message: 'Failed to update schedule entry.' });
    }
});

/**
 * @route   DELETE /api/exams/schedule/:scheduleId
 * @desc    Deletes an existing schedule entry.
 */
router.delete('/schedule/:scheduleId', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { scheduleId } = req.params;
        await pool.query('DELETE FROM exam_schedules WHERE id = $1', [scheduleId]);
        res.status(200).json({ message: 'Schedule entry deleted successfully.' });
    } catch (error) {
        console.error('Error deleting schedule entry:', error);
        res.status(500).json({ message: 'Failed to delete schedule entry.' });
    }
});


router.get('/student/:sid/skills', authenticateToken, async (req, res) => {
    try {
        const { sid } = req.params;

        // Fetching real average marks per subject for the competency chart
        const query = `
            SELECT 
                s.subject_name as label,
                COALESCE(AVG(m.total_marks_obtained), 0) as value
            FROM subjects s
            JOIN marks m ON s.id = m.subject_id
            WHERE m.student_id = $1::uuid
            GROUP BY s.subject_name
            ORDER BY s.subject_name ASC
            LIMIT 6;
        `;

        const { rows } = await pool.query(query, [sid]);

        // Fallback labels if no marks are found yet
        if (rows.length === 0) {
            return res.json({
                labels: ['Logic', 'Theory', 'Practical', 'Research', 'Viva', 'Ethics'],
                values: [0, 0, 0, 0, 0, 0]
            });
        }

        res.json({
            labels: rows.map(r => r.label),
            values: rows.map(r => Math.round(parseFloat(r.value)))
        });

    } catch (err) {
        console.error('Skills Radar Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch competency data' });
    }
});
module.exports = router;