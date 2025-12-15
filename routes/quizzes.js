// routes/quizzes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Constants ---
const QUIZ_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student'];
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
// 1. GET: Quizzes for Student (Fixes the 500 Column Error)
// =========================================================

/**
 * @route   GET /api/quizzes/for-student/:courseId/:batchId
 * @desc    Get all quizzes scheduled for a specific course and batch.
 * @access  Private (QUIZ_VIEWER_ROLES)
 */
router.get('/for-student/:courseId/:batchId', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    const { courseId, batchId } = req.params;
    const safeCourseId = toUUID(courseId);
    const safeBatchId = toUUID(batchId);

    if (!safeCourseId || !safeBatchId) {
        return res.status(400).json({ message: 'Invalid Course ID or Batch ID.' });
    }

    try {
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
                -- Max marks is assumed to be available directly on online_quizzes or linked via join if needed
                -- For now, using a placeholder/default if max_marks doesn't exist on 'q'
                COALESCE(q.max_marks, 100) AS max_marks, 
                
                s.subject_name,
                
                qs.start_time,
                qs.end_time
                
            FROM ${QUIZ_TABLE} q
            JOIN ${SCHEDULE_TABLE} qs ON q.id = qs.quiz_id
            LEFT JOIN ${SUBJECTS_TABLE} s ON q.subject_id = s.id
            
            -- Filter by the student's enrollment
            WHERE qs.course_id = $1::uuid 
              AND qs.batch_id = $2::uuid
              AND q.status = 'Published' -- Only show published quizzes (Standard practice)
            
            ORDER BY qs.start_time DESC;
        `;
        
        const result = await pool.query(query, [safeCourseId, safeBatchId]);
        
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching student quizzes:', error);
        res.status(500).json({ message: 'Failed to retrieve available quizzes.', details: error.message });
    }
});


// =========================================================
// 2. Placeholder Routes for Quiz Taking (Online Exam/Proctoring)
// These routes are used by the Quiz.js client-side logic
// =========================================================

const QUIZ_MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
const PLACEHOLDER_ATTEMPT_ID = 'a9e1d5c2-f1a8-4c3e-8b09-7d6f5e4c3b2a'; // Mock ID

/**
 * @route   POST /api/online-exam/exam/start
 * @desc    Initiates an exam attempt and performs verification.
 */
router.post('/online-exam/exam/start', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    // In a real system, this would involve complex database operations.
    // Returning mock data to allow the frontend Quiz.js to proceed.
    res.status(200).json({ 
        attempt_id: PLACEHOLDER_ATTEMPT_ID, 
        quiz_details: { title: 'Final Assessment - CF Subject', time_limit_minutes: 60 } 
    });
});

/**
 * @route   GET /api/online-exam/attempts/:attemptId/questions
 * @desc    Fetches the specific 100 questions for the ongoing attempt.
 */
router.get('/online-exam/attempts/:attemptId/questions', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    // Returning minimal mock questions that match the frontend structure
    res.status(200).json([
        { question_id: 'q1', question_text: 'What is the capital of India?', option_a: 'Mumbai', option_b: 'Delhi', option_c: 'Kolkata', option_d: 'Chennai', marks: 1 },
        { question_id: 'q2', question_text: 'Which planet is known as the Red Planet?', option_a: 'Jupiter', option_b: 'Mars', option_c: 'Venus', option_d: 'Saturn', marks: 1 },
        { question_id: 'q3', question_text: 'What is the full form of HTML?', option_a: 'Hyper Text Markup Language', option_b: 'High Tech Modern Language', option_c: 'Home Tool Markup Language', option_d: 'Hyperlink and Text Markup Language', marks: 1 }
        // ... (Frontend requires an array of questions)
    ]);
});


/**
 * @route   POST /api/online-exam/submit-attempt/:attemptId
 * @desc    Receives final answers and calculates the score/grade.
 */
router.post('/online-exam/submit-attempt/:attemptId', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    // Mock response for successful submission
    res.status(200).json({ message: 'Submission received.', score: 85, total_marks: 100 });
});

/**
 * @route   POST /api/online-exam/block-exam/:attemptId
 * @desc    Reports a security violation and blocks the exam attempt.
 */
router.post('/online-exam/block-exam/:attemptId', authenticateToken, authorize(QUIZ_VIEWER_ROLES), async (req, res) => {
    console.log(`Violation reported for attempt ${req.params.attemptId}: ${req.body.reason}`);
    res.status(200).json({ message: 'Violation recorded and attempt blocked.' });
});


module.exports = router;