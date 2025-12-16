// routes/exams.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Roles Configuration ---
// These roles define who can manage (create/edit/delete) and who can only view exam data.
const EXAM_MANAGER_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
const EXAM_VIEWER_ROLES = ['Super Admin', 'Admin', 'Coordinator', 'Teacher', 'Student'];

// =======================================================================================
// 1. EXAM CRUD ROUTES (Core Exam Entry Management)
// =======================================================================================

/**
 * @route   GET /api/exams/list
 * @desc    Get a JOINED list of all exams linked to courses/batches.
 * @access  Private (EXAM_VIEWER_ROLES)
 * * 🛑 CRITICAL FIX INCLUDED: This query ensures course_id and batch_id are returned,
 * which is essential for the frontend to filter exams relevant to the logged-in student.
 */
router.get('/list', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                e.id AS exam_id,
                e.exam_name,
                e.exam_type,
                e.exam_date,
                e.course_id,  -- IMPORTANT: Included for frontend filtering
                e.batch_id,   -- IMPORTANT: Included for frontend filtering
                c.course_name,
                b.batch_name,
                b.batch_code, -- Added batch_code for clearer display
                e.max_theory_marks,
                e.max_practical_marks,
                (e.max_theory_marks + e.max_practical_marks) AS total_marks
            FROM 
                exams e
            LEFT JOIN 
                courses c ON e.course_id = c.id
            LEFT JOIN 
                batches b ON e.batch_id = b.id
            ORDER BY
                e.exam_date DESC, c.course_name;
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
 * @desc    Create a new exam (Header for a series of subjects)
 * @access  Private (EXAM_MANAGER_ROLES)
 */
router.post('/', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id,
        course_id, batch_id, max_theory_marks, max_practical_marks
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
 * @desc    Delete an exam series.
 * @access  Private (EXAM_MANAGER_ROLES)
 */
router.delete('/:id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        // Assumes ON DELETE CASCADE is set up in the database to delete related schedules and marks.
        await pool.query('DELETE FROM exams WHERE id = $1', [id]);
        res.status(200).json({ message: 'Exam deleted successfully.' });
    } catch (error) {
        console.error('Error deleting exam:', error);
        res.status(500).json({ message: 'Failed to delete exam.' });
    }
});

// =======================================================================================
// 2. EXAM SCHEDULE CRUD ROUTES (Subject-specific Scheduling)
// =======================================================================================

/**
 * @route   GET /api/exams/schedule/:examId
 * @desc    Get all schedule entries (subjects, dates, times) for a specific exam series.
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
 * @desc    Create a new schedule entry (one subject for one exam)
 * @access  Private (EXAM_MANAGER_ROLES)
 */
router.post('/schedule', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_id, course_id, batch_id, subject_id, exam_date,
        room_number, start_time, end_time, max_marks // max_marks should ideally be derived from exam.js/exam_marks.js logic, but included here for direct entry capability
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
            exam_id, course_id, batch_id, subject_id, exam_date,
            room_number, start_time, end_time, max_marks || 100 // Default to 100 if not provided
        ]);
        
        res.status(201).json(newSchedule.rows[0]);

    } catch (error) {
        if (error.code === '23505') { // unique_violation: ensures a subject is scheduled only once per exam/batch
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
    const { subject_id, exam_date, room_number, start_time, end_time, max_marks } = req.body;

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
            subject_id, exam_date, room_number, start_time, end_time, max_marks, scheduleId
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

/**
 * @route   GET /api/transcript/:studentId
 * @desc    Generate a complete academic transcript/marksheet for a student.
 * @access  Private (Student, Admin, Teacher)
 */
router.get('/transcript/:studentId', authenticateToken, authorize(['Student', 'Admin', 'Teacher']), async (req, res) => {
    const { studentId } = req.params;

    try {
        const query = `
            SELECT
                m.exam_schedule_id,
                es.exam_name,
                s.subject_name,
                m.marks_obtained,
                m.max_marks,
                m.pass_marks,
                m.grade_achieved,
                m.created_at AS result_date
            FROM marks m
            
            -- 1. Get Exam Details
            JOIN exam_schedule es ON m.exam_schedule_id = es.id
            
            -- 2. Get Subject Name
            JOIN subjects s ON m.subject_id = s.id
            
            -- 3. Filter by Student (assuming 'marks' table uses student_id for the student's primary ID)
            WHERE m.student_id = $1
            
            ORDER BY es.exam_name, s.subject_name;
        `;
        
        const result = await pool.query(query, [studentId]);

        if (result.rowCount === 0) {
            return res.status(200).json({ message: 'No marksheet data found for this student.', transcript: [] });
        }
        
        // Grouping the results by exam for easy client-side rendering
        const transcript = result.rows.reduce((acc, row) => {
            const examId = row.exam_schedule_id;
            if (!acc[examId]) {
                acc[examId] = {
                    exam_name: row.exam_name,
                    results: []
                };
            }
            acc[examId].results.push(row);
            return acc;
        }, {});

        res.status(200).json({ transcript: Object.values(transcript) });

    } catch (error) {
        console.error(`Error generating transcript for student ${studentId}:`, error);
        res.status(500).json({ message: 'Failed to generate transcript due to a backend error.' });
    }
});

module.exports = router;