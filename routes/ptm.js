// routes/ptm.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');

// Database Table Constants
const SCHEDULES_TABLE = 'ptm_schedules';
const FEEDBACK_TABLE = 'ptm_feedback';
const USERS_TABLE = 'users';

// Constants
const PTM_STATUSES = ['Scheduled', 'Completed', 'Canceled', 'Parent Absent'];

// =========================================================
// 1. SCHEDULING (POST/GET)
// =========================================================

/**
 * @route   POST /api/ptm/schedule
 * @desc    Admin/Teacher schedules a meeting slot for a specific student/parent.
 * @access  Private (Admin, Teacher)
 */
router.post('/schedule', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const schedulerId = req.user.userId; 
    
    const { 
        teacher_id, 
        student_id, 
        meeting_time, 
        duration_minutes,
        meeting_type 
    } = req.body;

    if (!teacher_id || !student_id || !meeting_time) {
        return res.status(400).json({ message: 'Missing teacher, student, or time.' });
    }
    
    // Calculate meeting end time for conflict detection
    const meetingStart = moment(meeting_time);
    const duration = duration_minutes || 15;
    const meetingEnd = meetingStart.add(duration, 'minutes').format();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Conflict Check (Ensure teacher is free)
        const conflictQuery = `
            SELECT id FROM ${SCHEDULES_TABLE}
            WHERE teacher_id = $1 AND status IN ('Scheduled')
            AND (
                ($2 >= meeting_time AND $2 < meeting_end_time) OR
                ($3 > meeting_time AND $3 <= meeting_end_time) OR
                (meeting_time >= $2 AND meeting_time < $3)
            );
        `;
        const conflictRes = await client.query(conflictQuery, [teacher_id, meeting_time, meetingEnd]);
        
        if (conflictRes.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Teacher already has a scheduled meeting during this slot.' });
        }

        // 2. Insert Schedule
        const scheduleQuery = `
            INSERT INTO ${SCHEDULES_TABLE} (
                teacher_id, student_id, meeting_time, duration_minutes, meeting_end_time,
                meeting_type, scheduled_by_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'Scheduled')
            RETURNING id;
        `;
        const result = await pool.query(scheduleQuery, [
            teacher_id, student_id, meeting_time, duration, meetingEnd,
            meeting_type || 'In-Person', schedulerId
        ]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Meeting scheduled successfully.', schedule_id: result.rows[0].id });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Scheduling Error:', error);
        res.status(500).json({ message: 'Failed to schedule meeting.' });
    } finally {
        client.release();
    }
});

/**
 * @route   GET /api/ptm/teacher/:teacherId/slots
 * @desc    Get all upcoming meeting slots for a teacher (Prep view).
 * @access  Private (Self, Admin)
 */
router.get('/teacher/:teacherId/slots', authenticateToken, async (req, res) => {
    const { teacherId } = req.params;
    const currentUserId = req.user.userId; 
    
    // Security Check
    if (req.user.role !== 'Admin' && currentUserId !== teacherId) {
        return res.status(403).json({ message: 'Forbidden: You can only view your own schedule.' });
    }

    try {
        const query = `
            SELECT 
                s.id, s.meeting_time, s.duration_minutes, s.status, s.meeting_type, s.meeting_end_time,
                u_student.username AS student_name,
                f.schedule_id IS NOT NULL AS has_feedback
            FROM ${SCHEDULES_TABLE} s
            JOIN ${USERS_TABLE} u_student ON s.student_id = u_student.id
            LEFT JOIN ${FEEDBACK_TABLE} f ON s.id = f.schedule_id 
            WHERE s.teacher_id = $1 AND s.meeting_time >= NOW() - INTERVAL '1 hour'
            ORDER BY s.meeting_time ASC;
        `;
        const result = await pool.query(query, [teacherId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Teacher Slots Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve meeting slots.' });
    }
});

// =========================================================
// 2. FEEDBACK & AUDIT (POST/GET)
// =========================================================

/**
 * @route   POST /api/ptm/feedback/:scheduleId
 * @desc    Teacher submits structured feedback after the meeting.
 * @access  Private (Teacher)
 */
router.post('/feedback/:scheduleId', authenticateToken, authorize(['Teacher']), async (req, res) => {
    const { scheduleId } = req.params;
    const teacherId = req.user.userId; 
    const { 
        meeting_status, 
        academic_score, 
        behavior_score, 
        goals_discussed, 
        parent_comments 
    } = req.body;

    if (!PTM_STATUSES.includes(meeting_status)) {
        return res.status(400).json({ message: 'Invalid meeting status.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Insert Feedback Record
        const feedbackQuery = `
            INSERT INTO ${FEEDBACK_TABLE} (
                schedule_id, teacher_id, academic_score, behavior_score, 
                goals_discussed, parent_comments, submitted_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            RETURNING id;
        `;
        await client.query(feedbackQuery, [
            scheduleId, teacherId, academic_score, behavior_score, 
            goals_discussed, parent_comments || null
        ]);

        // 2. Update Schedule status and set has_feedback flag
        await client.query(`
            UPDATE ${SCHEDULES_TABLE} 
            SET status = $1, has_feedback = TRUE, actual_end_time = CURRENT_TIMESTAMP 
            WHERE id = $2;
        `, [meeting_status, scheduleId]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Feedback submitted and meeting finalized.' });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Feedback Submission Error:', error);
        res.status(500).json({ message: 'Failed to submit feedback.' });
    } finally {
        client.release();
    }
});

/**
 * @route   GET /api/ptm/student/:studentId/report
 * @desc    Get complete PTM history/report for a student.
 * @access  Private (Admin, Teacher, Parent viewing self)
 */
router.get('/student/:studentId/report', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    const currentUserId = req.user.userId; 
    const currentUserRole = req.user.role;

    // Security Check
    if (currentUserRole !== 'Admin' && currentUserRole !== 'Teacher' && currentUserId !== studentId) {
        return res.status(403).json({ message: 'Forbidden: You are not authorized to view this report.' });
    }

    try {
        const query = `
            SELECT 
                s.meeting_time, s.status, s.meeting_type,
                u_teacher.username AS teacher_name,
                f.academic_score, f.behavior_score, f.goals_discussed, f.parent_comments, f.submitted_at,
                f.schedule_id IS NOT NULL AS has_feedback
            FROM ${SCHEDULES_TABLE} s
            LEFT JOIN ${FEEDBACK_TABLE} f ON s.id = f.schedule_id
            JOIN ${USERS_TABLE} u_teacher ON s.teacher_id = u_teacher.id
            WHERE s.student_id = $1
            ORDER BY s.meeting_time DESC;
        `;
        const result = await pool.query(query, [studentId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Student Report Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student PTM report.' });
    }
});


module.exports = router;