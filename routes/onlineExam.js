const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- টেবিল কনস্ট্যান্টস ---
const QUIZZES_TABLE = 'online_quizzes';
const ATTEMPT_TABLE = 'student_exam_attempts'; 
const QUESTIONS_TABLE = 'quiz_questions';
const QUIZ_QUESTION_LINKS_TABLE = 'quiz_question_links';
const RESULTS_TABLE = 'student_quiz_results'; 

// =================================================================
// --- ছাত্রের জন্য রুটসমূহ (STUDENT ROUTES) ---
// =================================================================

/**
 * @route   GET /api/online-exam/student/:studentId/quizzes
 * @desc    ছাত্রের কোর্স অনুযায়ী পাবলিশড কুইজ লিস্ট লোড করা
 */
router.get('/student/:studentId/quizzes', authenticateToken, async (req, res) => {
    const { studentId } = req.params; // এটি ইউজার আইডি হিসেবে আসে (যেমন: 6fd0e97a...)
    try {
        const studentRes = await pool.query(
            'SELECT course_id FROM students WHERE user_id = $1', [studentId]
        );
        if (studentRes.rowCount === 0) return res.status(404).json({ message: 'Course not found' });
        
        const courseId = studentRes.rows[0].course_id;
        const quizQuery = `
            SELECT oq.id, oq.title, oq.time_limit_minutes, oq.max_marks, s.subject_name
            FROM ${QUIZZES_TABLE} oq
            JOIN subjects s ON oq.subject_id = s.id
            WHERE oq.course_id = $1 AND oq.status = 'Published'
            ORDER BY oq.created_at DESC;
        `;
        const result = await pool.query(quizQuery, [courseId]);
        res.status(200).json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Error loading quizzes' }); }
});

/**
 * @route   GET /api/online-exam/attempt/:quizId
 * @desc    পরীক্ষার জন্য প্রশ্নপত্র লোড করা
 */
router.get('/attempt/:quizId', authenticateToken, async (req, res) => {
    const { quizId } = req.params;
    try {
        const quiz = await pool.query('SELECT title, time_limit_minutes FROM online_quizzes WHERE id = $1', [quizId]);
        const questions = await pool.query(`
            SELECT q.* FROM ${QUESTIONS_TABLE} q
            JOIN ${QUIZ_QUESTION_LINKS_TABLE} l ON q.question_id = l.question_id
            WHERE l.quiz_id = $1 ORDER BY l.question_order ASC;
        `, [quizId]);
        res.json({ title: quiz.rows[0].title, timeLimit: quiz.rows[0].time_limit_minutes, questions: questions.rows });
    } catch (err) { res.status(500).json({ message: 'Failed to load attempt' }); }
});

/**
 * @route   POST /api/online-exam/submit/:quizId
 * @desc    সঠিক student_id ব্যবহার করে উত্তর জমা দেওয়া (Fixes Foreign Key Error)
 */
router.post('/submit/:quizId', authenticateToken, async (req, res) => {
    const { quizId } = req.params;
    const { answers } = req.body; 
    const userId = req.user.id; 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ১. ছাত্রের মূল student_id খুঁজে বের করা
        const studentInfo = await client.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        if (studentInfo.rowCount === 0) throw new Error('Student profile not found.');
        const actualStudentId = studentInfo.rows[0].student_id; 

        // ২. এটেম্পট তৈরি
        const attemptRes = await client.query(
            `INSERT INTO ${ATTEMPT_TABLE} (student_id, quiz_id, start_time, status) 
             VALUES ($1, $2, NOW(), 'Submitted') RETURNING attempt_id`,
            [actualStudentId, quizId]
        );
        const attemptId = attemptRes.rows[0].attempt_id;

        // ৩. গ্রেডিং লজিক
        const questions = await client.query(
            `SELECT q.question_id, q.correct_option, q.marks FROM ${QUESTIONS_TABLE} q 
             JOIN ${QUIZ_QUESTION_LINKS_TABLE} l ON q.question_id = l.question_id WHERE l.quiz_id = $1`, [quizId]
        );

        let totalScore = 0;
        for (let q of questions.rows) {
            const studentAns = answers[q.question_id] || null;
            const isCorrect = (studentAns === q.correct_option);
            const marks = isCorrect ? q.marks : 0;
            if (isCorrect) totalScore += marks;

            await client.query(
                `INSERT INTO ${RESULTS_TABLE} (attempt_id, question_id, student_answer, correct_answer, is_correct, marks_obtained) 
                 VALUES ($1, $2, $3, $4, $5, $6)`, [attemptId, q.question_id, studentAns, q.correct_option, isCorrect, marks]
            );
        }

        await client.query(`UPDATE ${ATTEMPT_TABLE} SET total_score = $1, end_time = NOW() WHERE attempt_id = $2`, [totalScore, attemptId]);
        await client.query('COMMIT');
        res.status(200).json({ success: true, score: totalScore, attemptId: attemptId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Submission Error:', error.message);
        res.status(500).json({ message: 'Submission failed: ' + error.message });
    } finally { client.release(); }
});

/**
 * @route   GET /api/online-exam/results/:quizId
 * @desc    ছাত্রের কুইজ রেজাল্ট ও বিশ্লেষণ ফেচ করা
 */
router.get('/results/:quizId', authenticateToken, async (req, res) => {
    const { quizId } = req.params;
    const userId = req.user.id;
    try {
        const student = await pool.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        const attempt = await pool.query(
            `SELECT attempt_id, total_score FROM ${ATTEMPT_TABLE} WHERE student_id = $1 AND quiz_id = $2 ORDER BY end_time DESC LIMIT 1`,
            [student.rows[0].student_id, quizId]
        );
        const details = await pool.query(
            `SELECT r.*, q.question_text FROM ${RESULTS_TABLE} r JOIN ${QUESTIONS_TABLE} q ON r.question_id = q.question_id WHERE r.attempt_id = $1`, 
            [attempt.rows[0].attempt_id]
        );
        res.json({ score: attempt.rows[0].total_score, details: details.rows });
    } catch (err) { res.status(500).json({ message: 'Error fetching result' }); }
});

/**
 * @route   GET /api/online-exam/results/:quizId
 * @desc    ছাত্রের সর্বশেষ পরীক্ষার বিস্তারিত ফলাফল ও বিশ্লেষণ প্রদান
 */
router.get('/results/:quizId', authenticateToken, async (req, res) => {
    const { quizId } = req.params;
    const userId = req.user.id;

    try {
        // ১. ছাত্রের student_id খুঁজে বের করা
        const student = await pool.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        if (student.rowCount === 0) return res.status(404).json({ message: 'Student not found.' });
        const studentId = student.rows[0].student_id;

        // ২. ওই কুইজের জন্য সর্বশেষ এটেম্পট আইডি এবং স্কোর খুঁজে বের করা
        const attempt = await pool.query(
            `SELECT attempt_id, total_score FROM student_exam_attempts 
             WHERE student_id = $1 AND quiz_id = $2 
             ORDER BY end_time DESC LIMIT 1`, [studentId, quizId]
        );

        if (attempt.rowCount === 0) return res.status(404).json({ message: 'No record found.' });

        // ৩. বিস্তারিত প্রশ্ন-উত্তর বিশ্লেষণ নিয়ে আসা
        const details = await pool.query(
            `SELECT r.*, q.question_text 
             FROM student_quiz_results r 
             JOIN quiz_questions q ON r.question_id = q.question_id 
             WHERE r.attempt_id = $1`, [attempt.rows[0].attempt_id]
        );

        res.json({
            score: attempt.rows[0].total_score,
            details: details.rows
        });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching results' });
    }
});

module.exports = router;