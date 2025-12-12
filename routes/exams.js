// routes/exams.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Roles Configuration ---
const EXAM_MANAGER_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
const EXAM_VIEWER_ROLES = ['Super Admin', 'Admin', 'Coordinator', 'Teacher', 'Student'];
// =======================================================================================
// 1. EXAM CRUD ROUTES
// =======================================================================================

/**
 * @route   GET /api/exams/list
 * @desc    Get a JOINED list of all exams linked to courses/batches.
 * @access  Private (EXAM_VIEWER_ROLES)
 */
//
// --- 🛑 THIS IS THE CRITICAL FIX 🛑 ---
//
// This route provides all the data (course_id, batch_id, total_marks)
// that your frontend `examCache` needs to avoid the "Course ID is missing" error.
// Your server.js routes `GET /api/exams/list` to this handler.
//
router.get('/list', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                e.id AS exam_id,
                e.exam_name,
                e.exam_date,
                e.course_id,  -- This data is now included
                e.batch_id,   -- This data is now included
                c.course_name,
                b.batch_name,
                (e.max_theory_marks + e.max_practical_marks) AS total_marks
            FROM 
                exams e
            LEFT JOIN 
                courses c ON e.course_id = c.id
            LEFT JOIN 
                batches b ON e.batch_id = b.id
            /* -- Optional: Filter by academic session
            WHERE
                e.academic_session_id = $1 
            */
            ORDER BY
                e.exam_date DESC, c.course_name;
        `;
        
        // If not filtering by session:
        const result = await pool.query(query);
        
        // This response will now have the course_id, batch_id, etc.
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching comprehensive exam list:', error);
        res.status(500).json({ message: 'Failed to retrieve combined exam list.' });
    }
});

/**
 * @route   POST /api/exams
 * @desc    Create a new exam (Handles Section 1 Form)
 * @access  Private (EXAM_MANAGER_ROLES)
 */
router.post('/', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_name,
        exam_type,
        exam_date,
        is_midterm_assessment,
        academic_session_id,
        course_id,
        batch_id,
        max_theory_marks,
        max_practical_marks
    } = req.body;

    // Validation
    if (!exam_name || !exam_date || !course_id || !batch_id || !academic_session_id) {
        return res.status(400).json({ message: 'Missing required fields: name, date, course, batch, or session.' });
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
            exam_name,
            exam_type,
            exam_date,
            is_midterm_assessment || false,
            academic_session_id,
            course_id,
            batch_id,
            max_theory_marks || 100,
            max_practical_marks || 0
        ]);

        res.status(201).json(newExam.rows[0]);

    } catch (error) {
        console.error('Error creating exam:', error);
        res.status(500).json({ message: 'Failed to create exam.' });
    }
});

/**
 * @route   DELETE /api/exams/:id
 * @desc    Delete an exam
 * @access  Private (EXAM_MANAGER_ROLES)
 */
router.delete('/:id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM exams WHERE id = $1', [id]);
        // ON DELETE CASCADE in your DB will handle deleting related schedules and marks.
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
 * @desc    Get all schedule entries for a specific exam
 * @access  Private (EXAM_VIEWER_ROLES)
 */
router.get('/schedule/:examId', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId } = req.params;
        const query = `
            SELECT 
                es.id AS schedule_id,
                es.subject_id,
                s.subject_name,
                s.subject_code,
                es.exam_date,
                es.start_time,
                es.end_time,
                es.room_number,
                es.max_marks
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
 * @desc    Create a new schedule entry (Handles Section 2 Form)
 * @access  Private (EXAM_MANAGER_ROLES)
 */
router.post('/schedule', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_id,
        course_id,
        batch_id,
        subject_id,
        exam_date,
        room_number,
        start_time,
        end_time,
        max_marks
    } = req.body;

    if (!exam_id || !course_id || !batch_id || !subject_id || !exam_date || !start_time || !end_time) {
        return res.status(400).json({ message: 'Missing required schedule fields.' });
    }

    try {
        const query = `
            INSERT INTO exam_schedules (
                exam_id, course_id, batch_id, subject_id, exam_date,
                room_number, start_time, end_time, max_marks
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id AS schedule_id;
        `;
        const newSchedule = await pool.query(query, [
            exam_id,
            course_id,
            batch_id,
            subject_id,
            exam_date,
            room_number,
            start_time,
            end_time,
            max_marks || 100 // Default to 100 if not provided
        ]);
        
        res.status(201).json(newSchedule.rows[0]);

    } catch (error) {
        if (error.code === '23505') { // unique_violation
            return res.status(409).json({ message: 'This subject is already scheduled for this exam and batch.' });
        }
        console.error('Error creating schedule entry:', error);
        res.status(500).json({ message: 'Failed to create schedule entry.' });
    }
});

/**
 * @route   PUT /api/exams/schedule/:scheduleId
 * @desc    Update an existing schedule entry
 * @access  Private (EXAM_MANAGER_ROLES)
 */
router.put('/schedule/:scheduleId', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { scheduleId } = req.params;
    const {
        subject_id,
        exam_date,
        room_number,
        start_time,
        end_time,
        max_marks
    } = req.body;

    try {
        const query = `
            UPDATE exam_schedules
            SET 
                subject_id = $1,
                exam_date = $2,
                room_number = $3,
                start_time = $4,
                end_time = $5,
                max_marks = $6,
                updated_at = NOW()
            WHERE id = $7
            RETURNING *;
        `;
        const updatedSchedule = await pool.query(query, [
            subject_id,
            exam_date,
            room_number,
            start_time,
            end_time,
            max_marks,
            scheduleId
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
 * @desc    Delete a specific schedule entry
 * @access  Private (EXAM_MANAGER_ROLES)
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

module.exports = router;