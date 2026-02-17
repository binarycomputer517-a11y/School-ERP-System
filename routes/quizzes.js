// routes/quizzes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Constants ---
// 🔥 FIXED: Added 'Parent' to QUIZ_VIEWER_ROLES to resolve 403 Forbidden errors found in logs
const QUIZ_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Parent'];
const QUIZ_TABLE = 'online_quizzes';
const SCHEDULE_TABLE = 'quiz_schedules';
const SUBJECTS_TABLE = 'subjects';

// --- Helper Functions ---
function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    return value.trim();
}

// =========================================================
// 1. GET: Quizzes for Student (Resolves Column Mapping Errors)
// =========================================================

/**
 * @route   GET /api/quizzes/for-student/:courseId/:batchId
 * @desc    Get all quizzes scheduled for a specific course and batch.
 * @access  Private (QUIZ_VIEWER_ROLES - Supports Student and Parent views)
 */
router.get('/for-student/:courseId/:batchId', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    const { courseId, batchId } = req.params;
    const safeCourseId = toUUID(courseId);
    const safeBatchId = toUUID(batchId);

    if (!safeCourseId || !safeBatchId) {
        return res.status(400).json({ message: 'Invalid Course ID or Batch ID.' });
    }

    try {
        // 
        // Query adjusted based on the actual online_quizzes table schema:
        // q.title is used instead of q.quiz_name
        // q.time_limit_minutes is used instead of q.duration_minutes
        const query = `
            SELECT 
                q.id AS quiz_id, 
                q.title AS quiz_name,    
                q.time_limit_minutes AS duration_minutes, 
                q.subject_id,
                q.assessment_type,
                COALESCE(q.max_marks, 100) AS max_marks, 
                s.subject_name,
                qs.start_time,
                qs.end_time
            FROM ${QUIZ_TABLE} q
            JOIN ${SCHEDULE_TABLE} qs ON q.id = qs.quiz_id
            LEFT JOIN ${SUBJECTS_TABLE} s ON q.subject_id = s.id
            WHERE qs.course_id = $1::uuid 
              AND qs.batch_id = $2::uuid
              AND q.status = 'Published'
            ORDER BY qs.start_time DESC;
        `;
        
        const result = await pool.query(query, [safeCourseId, safeBatchId]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching student quizzes:', error);
        res.status(500).json({ message: 'Failed to retrieve available quizzes.', details: error.message });
    }
});

/**
 * @route   GET /api/online-exam/results/:quizId
 * @desc    Fetch comprehensive quiz results for student/parent reporting
 */
router.get('/results/:quizId', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    const { quizId } = req.params;
    const { student_id: queryStudentId } = req.query; 
    const userId = req.user.id;
    
    try {
        // 
        
        // 1. Identity Resolution Logic (Student vs Parent)
        let filterValue = userId;
        let idColumn = 's.user_id'; 

        if (req.user.role.toLowerCase() === 'parent' && queryStudentId) {
            filterValue = queryStudentId;
            idColumn = 's.student_id'; 
        }

        // 2. Summary Query: Fetch master data from 'student_exam_attempts'
        const summaryQuery = `
            SELECT sea.attempt_id, sea.total_score, sea.status, sea.end_time,
                   sea.correct_count, sea.incorrect_count, sea.unanswered_count,
                   oq.title, oq.max_marks,
                   s.first_name || ' ' || s.last_name AS student_name,
                   s.roll_number, s.profile_image_path AS profile_pic,
                   c.course_name, b.batch_name, sub.subject_name
            FROM student_exam_attempts sea
            JOIN online_quizzes oq ON sea.quiz_id = oq.id
            JOIN students s ON sea.student_id = s.student_id
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            LEFT JOIN subjects sub ON oq.subject_id = sub.id
            WHERE ${idColumn}::uuid = $1::uuid 
              AND sea.quiz_id::uuid = $2::uuid 
            ORDER BY sea.end_time DESC LIMIT 1`;
        
        const summaryResult = await pool.query(summaryQuery, [filterValue, quizId]);
        
        if (summaryResult.rowCount === 0) {
            return res.status(404).json({ message: 'Result registry entry not found.' });
        }
        
        const summary = summaryResult.rows[0];

        // 3. Details Query: Fetch per-question data from 'student_quiz_results'
        const detailsQuery = `
            SELECT sqr.student_answer, sqr.correct_answer, sqr.is_correct, sqr.marks_obtained,
                   q.question_text, q.marks AS question_max_marks
            FROM student_quiz_results sqr
            JOIN quiz_questions q ON sqr.question_id = q.question_id 
            WHERE sqr.attempt_id = $1`; 

        const detailsResult = await pool.query(detailsQuery, [summary.attempt_id]);

        res.status(200).json({ 
            summary: summary, 
            details: detailsResult.rows 
        });

    } catch (err) { 
        console.error("🔥 Detailed Result Sync Error:", err.message);
        res.status(500).json({ message: 'Internal server error during result hydration.' }); 
    }
});

// =========================================================
// 2. Placeholder Routes for Quiz Taking (Online Exam/Proctoring)
// =========================================================

const PLACEHOLDER_ATTEMPT_ID = 'a9e1d5c2-f1a8-4c3e-8b09-7d6f5e4c3b2a';

/**
 * @route   POST /api/online-exam/exam/start
 * @desc    Initiates an exam attempt and performs verification.
 */
router.post('/online-exam/exam/start', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    res.status(200).json({ 
        attempt_id: PLACEHOLDER_ATTEMPT_ID, 
        quiz_details: { title: 'Final Assessment', time_limit_minutes: 60 } 
    });
});

/**
 * @route   GET /api/online-exam/attempts/:attemptId/questions
 * @desc    Fetches questions for the ongoing attempt.
 */
router.get('/online-exam/attempts/:attemptId/questions', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    res.status(200).json([
        { question_id: 'q1', question_text: 'Sample Question 1?', option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D', marks: 1 }
    ]);
});

/**
 * @route   POST /api/online-exam/submit-attempt/:attemptId
 * @desc    Receives final answers and calculates the score.
 */
router.post('/online-exam/submit-attempt/:attemptId', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    res.status(200).json({ message: 'Submission received.', score: 85, total_marks: 100 });
});

/**
 * @route   POST /api/online-exam/block-exam/:attemptId
 * @desc    Reports a security violation and blocks the attempt.
 */
router.post('/online-exam/block-exam/:attemptId', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    console.log(`Violation reported for attempt ${req.params.attemptId}: ${req.body.reason}`);
    res.status(200).json({ message: 'Violation recorded and attempt blocked.' });
});

module.exports = router;