const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

// File Upload Setup
const upload = multer({ dest: 'uploads/' });

/** * HELPER: Validate UUID Format */
const isValidUUID = (id) => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return id && uuidRegex.test(id);
};

// SQL Snippet for Dynamic Max Marks (DRY Principle)
const SQL_MAX_MARKS = `
    COALESCE((
        SELECT SUM(q.marks) 
        FROM quiz_questions q 
        JOIN quiz_question_links l ON q.question_id = l.question_id 
        WHERE l.quiz_id = oq.id
    ), 0)
`;

/** =================================================================
 * SECTION 1: QUIZ MANAGEMENT (Admin/Teacher Access)
 * =================================================================
 */

// Create Quiz
router.post('/quizzes', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { title, subject_id, course_id, time_limit, max_marks, assessment_type, status, start_time, end_time } = req.body;
    try {
        const safeSubjectId = isValidUUID(subject_id) ? subject_id : null;
        const safeCourseId = isValidUUID(course_id) ? course_id : null;
        
        let parsedTime = parseInt(time_limit);
        let parsedMarks = parseInt(max_marks);
        const safeTimeLimit = isNaN(parsedTime) ? 60 : parsedTime;
        const safeMaxMarks = isNaN(parsedMarks) ? 0 : parsedMarks;
        
        const result = await pool.query(
            `INSERT INTO online_quizzes 
            (title, subject_id, course_id, time_limit, max_marks, status, assessment_type, available_from, available_to) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
             RETURNING *`,
            [title, safeSubjectId, safeCourseId, safeTimeLimit, safeMaxMarks, status || 'Draft', assessment_type || 'Quiz', start_time || null, end_time || null]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) { 
        console.error("Quiz Creation Error:", err);
        res.status(500).json({ message: 'Error creating quiz: ' + err.message }); 
    }
});

// List All Quizzes (Admin View) - UPDATED
router.get('/quizzes', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    try {
        const { course_id, subject_id } = req.query;
        let filterClause = '';
        const params = [];

        // ডাইনামিক ফিল্টারিং হ্যান্ডেল করা
        if (isValidUUID(course_id)) {
            params.push(course_id);
            filterClause += ` AND oq.course_id = $${params.length}`;
        }
        if (isValidUUID(subject_id)) {
            params.push(subject_id);
            filterClause += ` AND oq.subject_id = $${params.length}`;
        }

        const query = `
            SELECT 
                oq.id, 
                oq.title, 
                oq.assessment_type,
                oq.course_id,
                oq.subject_id,
                oq.time_limit, -- ডাটাবেস কলাম রিনেম অনুযায়ী আপডেট করা হয়েছে
                oq.status,
                oq.available_from,
                oq.available_to,
                oq.created_at,
                c.course_name, 
                s.subject_name,
                s.subject_code, -- সাবজেক্ট কোড এখন টেবিল থেকে আসবে
                (SELECT COUNT(*) FROM quiz_question_links l WHERE l.quiz_id = oq.id) as total_questions,
                ${SQL_MAX_MARKS} as dynamic_max_marks
            FROM online_quizzes oq
            LEFT JOIN courses c ON oq.course_id = c.id
            LEFT JOIN subjects s ON oq.subject_id = s.id
            WHERE 1=1 ${filterClause}
            ORDER BY oq.created_at DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error("Admin Quiz Fetch Error:", err);
        res.status(500).json({ message: 'Failed to load quiz list' });
    }
});

// Update Quiz
router.put('/quizzes/:id', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { id } = req.params;
    const { title, subject_id, course_id, time_limit, max_marks, status, assessment_type, start_time, end_time } = req.body;
    try {
        const safeSubjectId = isValidUUID(subject_id) ? subject_id : null;
        const safeCourseId = isValidUUID(course_id) ? course_id : null;
        let parsedTime = parseInt(time_limit);
        let parsedMarks = parseInt(max_marks);
        const safeTimeLimit = isNaN(parsedTime) ? 60 : parsedTime;
        const safeMaxMarks = isNaN(parsedMarks) ? 0 : parsedMarks;
        
        const query = `
            UPDATE online_quizzes 
            SET title = $1, 
                subject_id = $2, 
                course_id = $3, 
                time_limit = $4, 
                max_marks = $5, 
                status = $6,
                assessment_type = $7,
                available_from = $8,
                available_to = $9,
                updated_at = NOW()
            WHERE id::text = $10 RETURNING *`;
        
        const result = await pool.query(query, [title, safeSubjectId, safeCourseId, safeTimeLimit, safeMaxMarks, status, assessment_type, start_time || null, end_time || null, id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Quiz not found' });
        res.json({ success: true, message: 'Quiz updated successfully', data: result.rows[0] });
    } catch (err) {
        console.error("Quiz Update Error:", err);
        res.status(500).json({ message: 'Server error updating quiz: ' + err.message });
    }
});

// Delete Quiz
router.delete('/quizzes/:id', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM quiz_question_links WHERE quiz_id::text = $1', [id]); // Clean links first
        const result = await client.query('DELETE FROM online_quizzes WHERE id::text = $1', [id]);
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Quiz not found' });
        }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Quiz deleted successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Quiz Delete Error:", err);
        res.status(500).json({ message: 'Server error deleting quiz' });
    } finally {
        client.release();
    }
});

/** =================================================================
 * SECTION 2: STUDENT PORTAL (Exam & Grading)
 * =================================================================
 */

// Student Dashboard: List available quizzes
router.get('/student/:userId/quizzes', authenticateToken, async (req, res) => {
    const { userId } = req.params;
    try {
        const studentRes = await pool.query(
            'SELECT student_id, course_id FROM students WHERE user_id::text = $1 OR student_id::text = $1', 
            [userId]
        );
        if (studentRes.rowCount === 0) return res.status(404).json({ message: 'Profile not found' });

        const { student_id, course_id } = studentRes.rows[0];
        
        const quizzesQuery = `
            SELECT oq.id, oq.title, oq.time_limit, 
                   ${SQL_MAX_MARKS} as max_marks,
                   s.subject_name, oq.available_from, oq.available_to,
                   (SELECT status FROM student_exam_attempts 
                    WHERE quiz_id = oq.id AND student_id = $1 
                    ORDER BY end_time DESC LIMIT 1) as attempt_status
            FROM online_quizzes oq
            LEFT JOIN subjects s ON oq.subject_id = s.id
            WHERE (oq.course_id = $2 OR oq.course_id IS NULL) 
              AND oq.status = 'Published'
            ORDER BY oq.created_at DESC`;

        const quizzes = await pool.query(quizzesQuery, [student_id, course_id]);
        res.json(quizzes.rows);
    } catch (err) {
        console.error("Student Quiz Catalog Error:", err);
        res.status(500).json({ message: 'Catalog Unavailable' });
    }
});

// Student: Start/Load Attempt
router.get('/attempt/:quizId', authenticateToken, async (req, res) => {
    const { quizId } = req.params;
    const userId = req.user.id;
    try {
        const studentQuery = `
            SELECT s.student_id, s.first_name, s.last_name, s.roll_number, s.profile_image_path,
                   c.course_name, b.batch_name, sub.subject_name, oq.title, oq.time_limit
            FROM students s
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            CROSS JOIN online_quizzes oq
            LEFT JOIN subjects sub ON oq.subject_id = sub.id
            WHERE s.user_id::text = $1 AND oq.id::text = $2`;
        
        const studentRes = await pool.query(studentQuery, [userId, quizId]);
        if (studentRes.rowCount === 0) return res.status(404).json({ message: 'Profile mismatch' });

        const sId = studentRes.rows[0].student_id;
        const checkAttempt = await pool.query(
            `SELECT attempt_id FROM student_exam_attempts WHERE student_id = $1 AND quiz_id = $2`,
            [sId, quizId]
        );
        if (checkAttempt.rowCount > 0) return res.status(403).json({ message: 'You have already completed this exam' });

        // SECURITY: Correct Options REMOVED from selection
        const questionsRes = await pool.query(
            `SELECT q.question_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.marks 
             FROM quiz_questions q
             JOIN quiz_question_links l ON q.question_id = l.question_id
             WHERE l.quiz_id = $1 ORDER BY l.question_order ASC`, [quizId]
        );

        res.json({ 
            student: {
                name: `${studentRes.rows[0].first_name} ${studentRes.rows[0].last_name}`,
                roll: studentRes.rows[0].roll_number,
                photo: studentRes.rows[0].profile_image_path,
                course: studentRes.rows[0].course_name,
                batch: studentRes.rows[0].batch_name,
                subject: studentRes.rows[0].subject_name,
                timeLimit: studentRes.rows[0].time_limit
            }, 
            questions: questionsRes.rows 
        });
    } catch (err) { 
        console.error("Exam Hydration Error:", err);
        res.status(500).json({ message: 'Server error: ' + err.message }); 
    }
});

// Student: Submit Answers
router.post('/submit/:quizId', authenticateToken, async (req, res) => {
    const { quizId } = req.params;
    const { answers, violations } = req.body;
    const userId = req.user.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const sRes = await client.query('SELECT student_id FROM students WHERE user_id::text = $1', [userId]);
        const sId = sRes.rows[0].student_id;

        const qRes = await client.query(
            `SELECT q.question_id, q.correct_option, q.marks 
             FROM quiz_questions q 
             JOIN quiz_question_links l ON q.question_id = l.question_id 
             WHERE l.quiz_id = $1`, [quizId]
        );

        let totalScore = 0, correctCount = 0, incorrectCount = 0, unansweredCount = 0;
        const attemptRes = await client.query(
            `INSERT INTO student_exam_attempts (student_id, quiz_id, status, start_time, violation_count) 
             VALUES ($1, $2, 'Submitted', NOW(), $3) RETURNING attempt_id`, 
            [sId, quizId, violations || 0]
        );
        const attemptId = attemptRes.rows[0].attempt_id;

        for (const row of qRes.rows) {
            const studentAnsRaw = answers[row.question_id];
            const studentAns = studentAnsRaw ? studentAnsRaw.toString().toLowerCase().trim() : null;
            const officialAns = row.correct_option ? row.correct_option.toString().toLowerCase().trim() : null;

            let isCorrect = (studentAns !== null && studentAns === officialAns);
            let marksObtained = isCorrect ? row.marks : 0;

            if (!studentAns) unansweredCount++;
            else if (isCorrect) { correctCount++; totalScore += marksObtained; }
            else incorrectCount++;

            await client.query(
                `INSERT INTO student_quiz_results (attempt_id, question_id, student_answer, correct_answer, is_correct, marks_obtained) 
                 VALUES ($1, $2, $3, $4, $5, $6)`, 
                [attemptId, row.question_id, studentAns, officialAns, isCorrect, marksObtained]
            );
        }

        await client.query(
            `UPDATE student_exam_attempts 
             SET total_score = $1, correct_count = $2, incorrect_count = $3, unanswered_count = $4, end_time = NOW() 
             WHERE attempt_id = $5`, 
            [totalScore, correctCount, incorrectCount, unansweredCount, attemptId]
        );

        await client.query('COMMIT');
        res.json({ success: true, score: totalScore, correct: correctCount });
    } catch (e) { 
        await client.query('ROLLBACK'); 
        console.error("Submission Error:", e);
        res.status(500).json({ message: 'Submission failed' }); 
    } finally { client.release(); }
});

// Student Result Page (Single Result)
router.get('/results/:quizId', authenticateToken, async (req, res) => {
    const { quizId } = req.params;
    const userId = req.user.id;
    try {
        const summaryQuery = `
            SELECT sea.*, oq.title, 
                   ${SQL_MAX_MARKS} as max_marks,
                   s.first_name || ' ' || s.last_name AS student_name,
                   s.roll_number, s.profile_image_path AS profile_pic,
                   c.course_name, b.batch_name, sub.subject_name
            FROM student_exam_attempts sea
            JOIN online_quizzes oq ON sea.quiz_id = oq.id
            JOIN students s ON sea.student_id = s.student_id
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            LEFT JOIN subjects sub ON oq.subject_id = sub.id
            WHERE s.user_id::text = $1 AND sea.quiz_id::text = $2 
            ORDER BY sea.end_time DESC LIMIT 1`;
        
        const summary = await pool.query(summaryQuery, [userId, quizId]);
        if (summary.rowCount === 0) return res.status(404).json({ message: 'Result not found' });
        
        const details = await pool.query(
            `SELECT r.*, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.marks 
             FROM student_quiz_results r 
             JOIN quiz_questions q ON r.question_id = q.question_id 
             WHERE r.attempt_id = $1`, 
             [summary.rows[0].attempt_id]
        );

        res.json({ summary: summary.rows[0], details: details.rows });
    } catch (err) { 
        console.error("Results Fetch Error:", err);
        res.status(500).json({ message: 'Result not found' }); 
    }
});

// Admin: View all attempts for a quiz
router.get('/admin/quiz-attempts/:quizId', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { quizId } = req.params;
    try {
        const query = `
            SELECT sea.attempt_id, sea.student_id, sea.total_score, sea.status, sea.start_time, sea.end_time,
                   s.first_name, s.last_name, s.roll_number, s.profile_image_path,
                   oq.title, 
                   ${SQL_MAX_MARKS} as max_marks
            FROM student_exam_attempts sea
            JOIN students s ON sea.student_id = s.student_id
            JOIN online_quizzes oq ON sea.quiz_id = oq.id
            WHERE sea.quiz_id = $1
            ORDER BY sea.total_score DESC`;
            
        const result = await pool.query(query, [quizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Admin Result List Error:", err);
        res.status(500).json({ message: err.message });
    }
});

// Admin: View Specific Attempt Details (The Marksheet)
router.get('/admin/attempt/:attemptId', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { attemptId } = req.params;
    try {
        // 1. Fetch the attempt summary
        const summaryQuery = `
            SELECT sea.*, oq.title, 
                   COALESCE((SELECT SUM(q.marks) FROM quiz_questions q JOIN quiz_question_links l ON q.question_id = l.question_id WHERE l.quiz_id = oq.id), 0) as max_marks,
                   s.first_name || ' ' || s.last_name AS student_name,
                   s.roll_number, s.profile_image_path AS profile_pic,
                   c.course_name, b.batch_name, sub.subject_name, sub.subject_code
            FROM student_exam_attempts sea
            JOIN online_quizzes oq ON sea.quiz_id = oq.id
            JOIN students s ON sea.student_id = s.student_id
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            LEFT JOIN subjects sub ON oq.subject_id = sub.id
            WHERE sea.attempt_id::text = $1`; // Added ::text to handle various ID formats

        const summary = await pool.query(summaryQuery, [attemptId]);

        if (summary.rowCount === 0) {
            return res.status(404).json({ message: 'Attempt record not found in database' });
        }

        // 2. Fetch individual question results for this attempt
        const detailsQuery = `
            SELECT r.*, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.marks 
            FROM student_quiz_results r 
            JOIN quiz_questions q ON r.question_id = q.question_id 
            WHERE r.attempt_id::text = $1`;

        const details = await pool.query(detailsQuery, [attemptId]);

        res.json({ 
            summary: summary.rows[0], 
            details: details.rows 
        });
    } catch (err) { 
        console.error("Admin Marksheet Fetch Error:", err);
        res.status(500).json({ message: "Internal Server Error: " + err.message }); 
    }
});
/** =================================================================
 * SECTION 3: QUESTION BANK & LINKING (Admin/Teacher Access)
 * =================================================================
 */

// Upload CSV Questions
router.post('/question-bank/upload-csv', authenticateToken, authorize(['Admin', 'Teacher']), upload.single('file'), async (req, res) => {
    const results = [];
    if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                let count = 0;
                for (const row of results) {
                    if (row.question_text && row.correct_option) {
                        const safeSubjectId = isValidUUID(row.subject_id) ? row.subject_id : null;
                        await client.query(
                            `INSERT INTO quiz_questions (question_text, option_a, option_b, option_c, option_d, correct_option, marks, subject_id) 
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                            [row.question_text, row.option_a, row.option_b, row.option_c, row.option_d, row.correct_option.toLowerCase(), row.marks || 1, safeSubjectId]
                        );
                        count++;
                    }
                }
                await client.query('COMMIT');
                // Cleanup temp file
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                
                res.json({ success: true, message: `${count} questions imported!` });
            } catch (err) {
                await client.query('ROLLBACK');
                // Cleanup temp file
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                
                console.error(err);
                res.status(500).json({ message: 'CSV Error' });
            } finally { client.release(); }
        });
});

router.get('/question-bank', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM quiz_questions ORDER BY question_id DESC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({message: "Error loading questions"}); }
});

router.get('/quizzes/:quizId/links', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT q.*, l.question_order FROM quiz_questions q JOIN quiz_question_links l ON q.question_id = l.question_id WHERE l.quiz_id = $1 ORDER BY l.question_order ASC`, [req.params.quizId]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({message: "Error loading links"}); }
});

router.put('/quizzes/:quizId/link-questions', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { quizId } = req.params;
    const { questionIds } = req.body; 
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM quiz_question_links WHERE quiz_id = $1', [quizId]);
        if (Array.isArray(questionIds)) {
            for (let i = 0; i < questionIds.length; i++) {
                await client.query(`INSERT INTO quiz_question_links (quiz_id, question_id, question_order) VALUES ($1, $2, $3)`, [quizId, questionIds[i], i + 1]);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Link Error' });
    } finally { client.release(); }
});

router.post('/questions', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { question_text, subject_id, correct_option, marks, option_a, option_b, option_c, option_d } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO quiz_questions (question_text, subject_id, correct_option, marks, option_a, option_b, option_c, option_d) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [question_text, isValidUUID(subject_id) ? subject_id : null, correct_option, marks || 1, option_a, option_b, option_c, option_d]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (e) { res.status(500).json({ message: 'Add Error' }); }
});

// JSON Import (Alternative to CSV)
router.post('/question-bank/import', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    const { questions } = req.body;
    if (!questions || !Array.isArray(questions)) return res.status(400).json({ message: 'No questions provided' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const q of questions) {
            if (!q.Question_Text || !q.Correct_Option) continue;
            await client.query(
                `INSERT INTO quiz_questions (question_text, subject_id, correct_option, marks, option_a, option_b, option_c, option_d) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [q.Question_Text, isValidUUID(q.Subject_ID) ? q.Subject_ID : null, q.Correct_Option, q.Marks || 1, q.Option_A, q.Option_B, q.Option_C, q.Option_D]
            );
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Import failed' });
    } finally { client.release(); }
});

router.delete('/attempts/:attemptId', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    try {
        await pool.query('DELETE FROM student_quiz_results WHERE attempt_id = $1', [req.params.attemptId]);
        await pool.query('DELETE FROM student_exam_attempts WHERE attempt_id = $1', [req.params.attemptId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: 'Delete Error' }); }
});

// ==========================================
// GET: Consolidated Report Card (FINAL ALL-IN-ONE FIX)
// ==========================================
router.get('/student/consolidated-report', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Get Student Info
        const studentQuery = `
            SELECT s.first_name, s.last_name, s.roll_number, s.profile_image_path,
                   c.course_name, b.batch_name, s.student_id 
            FROM students s
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            WHERE s.user_id::text = $1`;
        
        const studentRes = await pool.query(studentQuery, [userId]);
        
        if (studentRes.rows.length === 0) {
            return res.status(404).json({ message: "Student profile not found" });
        }

        const studentData = studentRes.rows[0];
        const studentId = studentData.student_id;

        // 2. Fetch All Exam Results
        const resultsQuery = `
            SELECT 
                sub.subject_code,
                sub.subject_name,
                oq.title AS exam_title,
                
                -- Dynamic Max Marks (sum of linked questions)
                ${SQL_MAX_MARKS} as max_marks,

                -- Obtained Score
                COALESCE(sea.total_score, 0) as total_score,
                sea.end_time
            FROM student_exam_attempts sea
            JOIN online_quizzes oq ON sea.quiz_id = oq.id
            LEFT JOIN subjects sub ON oq.subject_id = sub.id
            WHERE sea.student_id = $1 
            AND sea.end_time IS NOT NULL
            ORDER BY sea.end_time DESC`;

        const resultsRes = await pool.query(resultsQuery, [studentId]);

        res.json({
            student: studentData,
            results: resultsRes.rows 
        });

    } catch (err) {
        console.error("Consolidated Report Error:", err);
        res.status(500).json({ message: "Server Error generating transcript" });
    }
});

// ==========================================
// GET: Student Exam Schedule (For Admit Card)
// ==========================================
router.get('/student/schedule', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Get Student's Course Info
        const studentRes = await pool.query(
            `SELECT course_id FROM students WHERE user_id::text = $1`, 
            [userId]
        );

        if (studentRes.rowCount === 0) {
            return res.status(404).json({ message: "Student profile not found" });
        }

        const { course_id } = studentRes.rows[0];

        // 2. Fetch Published Exams for this Course
        const query = `
            SELECT 
                oq.id,
                oq.title,
                oq.assessment_type,
                oq.time_limit,
                oq.available_from,
                oq.available_to,
                s.subject_name,
                s.subject_code,
                oq.id as assessment_code
            FROM online_quizzes oq
            LEFT JOIN subjects s ON oq.subject_id = s.id
            WHERE oq.course_id = $1 
            AND oq.status = 'Published'
            ORDER BY oq.available_from ASC`;

        const scheduleRes = await pool.query(query, [course_id]);
        
        res.json(scheduleRes.rows);

    } catch (err) {
        console.error("Schedule Fetch Error:", err);
        res.status(500).json({ message: "Error fetching schedule" });
    }
});
module.exports = router;