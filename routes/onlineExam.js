// routes/onlineExam.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
// Ensure these middleware functions exist and are properly exported
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Constants ---
const QUIZZES_TABLE = 'online_quizzes';
const ATTEMPT_TABLE = 'student_exam_attempts'; 
const QUESTIONS_TABLE = 'quiz_questions';
const QUIZ_QUESTION_LINKS_TABLE = 'quiz_question_links';
const RESULTS_TABLE = 'student_quiz_results'; 

// --- UTILITY FUNCTIONS FOR SECURITY ---
async function checkAttemptOwnership(attemptId, studentId) {
    const result = await pool.query(
        // Assuming student_id in ATTEMPT_TABLE stores the user's UUID
        `SELECT student_id, quiz_id FROM ${ATTEMPT_TABLE} WHERE attempt_id = $1;`,
        [attemptId]
    );

    if (result.rowCount === 0) {
        console.error(`Attempt ownership check failed: Attempt ID ${attemptId} not found.`);
        const error = new Error('Attempt not found or unauthorized.');
        error.status = 404;
        throw error;
    }
    if (String(result.rows[0].student_id) !== String(studentId)) {
        console.error(`Attempt ownership check failed: Attempt ID ${attemptId} belongs to student ${result.rows[0].student_id}, but accessed by student ${studentId}.`);
        const error = new Error('Unauthorized access to this attempt.');
        error.status = 403;
        throw error;
    }
    return result.rows[0]; // Returns { student_id, quiz_id }
}


// =================================================================
// --- QUIZ MANAGER ROUTES (ADMIN VIEW) ---
// =================================================================

/**
 * @route   GET /api/online-exam/quizzes
 * @desc    Get all quizzes and exams for the manager overview.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.get('/quizzes', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    try {
        const query = `
            SELECT
                oq.id, oq.title, oq.assessment_type, oq.time_limit_minutes AS time_limit,
                oq.status, c.course_name, s.subject_name,
                (SELECT COUNT(*) FROM ${QUIZ_QUESTION_LINKS_TABLE} qql WHERE qql.quiz_id = oq.id) AS total_questions
            FROM ${QUIZZES_TABLE} oq
            LEFT JOIN courses c ON oq.course_id = c.id     
            LEFT JOIN subjects s ON oq.subject_id = s.id    
            ORDER BY oq.available_from DESC;
        `;

        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching quizzes:', error);
        res.status(500).json({ message: 'Failed to retrieve assessment list.' });
    }
});

/**
 * @route   POST /api/online-exam/quizzes
 * @desc    Create a new quiz or assessment.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.post('/quizzes', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    const { title, type, course_id, subject_id, time_limit, start_time, end_time, status } = req.body;

    if (!title || !course_id || !subject_id) {
        return res.status(400).json({ message: 'Missing required fields (title, course, subject).' });
    }

    const safe_time_limit = Number.isInteger(Number(time_limit)) && Number(time_limit) > 0 ? Number(time_limit) : 60;

    try {
        const query = `
            INSERT INTO ${QUIZZES_TABLE} (title, assessment_type, course_id, subject_id, time_limit_minutes, available_from, available_to, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
        `;
        const values = [title, type, course_id, subject_id, safe_time_limit, start_time || null, end_time || null, status || 'Draft'];
        const result = await pool.query(query, values);

        res.status(201).json({ message: 'Quiz created successfully', id: result.rows[0].id });
    } catch (error) {
        console.error('Error creating quiz:', error);
        let errorMessage = 'Failed to create new quiz assessment.';
        if (error.code === '23503') { 
            errorMessage = 'Invalid Course ID or Subject ID. Please ensure they exist in the database.';
            return res.status(409).json({ message: errorMessage });
        } else if (error.code === '23502') {
            errorMessage = 'A required field is missing (NOT NULL constraint violation).';
            return res.status(400).json({ message: errorMessage });
        }
        res.status(500).json({ message: errorMessage });
    }
});

/**
 * @route   PUT /api/online-exam/quizzes/:id
 * @desc    Update an existing quiz configuration.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.put('/quizzes/:id', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    const { id } = req.params;
    const { title, type, course_id, subject_id, time_limit, start_time, end_time, status } = req.body;

    if (!title || !course_id || !subject_id) {
        return res.status(400).json({ message: 'Missing required fields (title, course, subject).' });
    }
    const safe_time_limit = Number.isInteger(Number(time_limit)) && Number(time_limit) > 0 ? Number(time_limit) : 60;

    try {
        const query = `
            UPDATE ${QUIZZES_TABLE} SET
                title = $1, assessment_type = $2, course_id = $3, subject_id = $4, time_limit_minutes = $5, available_from = $6, available_to = $7, status = $8
            WHERE id = $9
            RETURNING id;
        `;
        const values = [title, type, course_id, subject_id, safe_time_limit, start_time || null, end_time || null, status, id];
        const result = await pool.query(query, values);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Quiz not found.' });
        }
        res.status(200).json({ message: 'Quiz updated successfully' });
    } catch (error) {
        console.error('Error updating quiz:', error);
        let errorMessage = 'Failed to update quiz assessment.';
        if (error.code === '23503') {
            errorMessage = 'Invalid Course ID or Subject ID. Please ensure they exist in the database.';
            return res.status(409).json({ message: errorMessage });
        } else if (error.code === '23502') {
            errorMessage = 'A required field is missing (NOT NULL constraint violation).';
            return res.status(400).json({ message: errorMessage });
        }
        res.status(500).json({ message: errorMessage });
    }
});

/**
 * @route   DELETE /api/online-exam/quizzes/:id
 * @desc    Delete a specific quiz.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.delete('/quizzes/:id', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(`DELETE FROM ${QUIZZES_TABLE} WHERE id = $1 RETURNING id;`, [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Quiz not found.' });
        }
        res.status(200).json({ message: `Quiz ID ${id} deleted successfully.` });
    } catch (error) {
        console.error('Error deleting quiz:', error);
        res.status(500).json({ message: 'Failed to delete quiz assessment.' });
    }
});


// =================================================================
// --- QUESTION BANK IMPORT ROUTE ---
// =================================================================

/**
 * @route   POST /api/online-exam/question-bank/import
 * @desc    Handles bulk import of MCQs from CSV/JSON.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.post('/question-bank/import', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    const { questions } = req.body;
    
    if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ message: 'Invalid data format. Expected non-empty array of questions.' });
    }
    
    const validationError = questions.find(q => !q.Question_Text || !q.Subject_ID || !q.Correct_Option || !q.Option_A || !q.Option_B);
    if (validationError) {
        console.error("Bulk Import Validation Failed on question:", validationError);
        return res.status(400).json({ message: 'Missing critical question fields (Question_Text, Subject_ID, Correct_Option, Option_A, Option_B).' });
    }

    const client = await pool.connect();
    let importedCount = 0;

    try {
        await client.query('BEGIN');
        
        const insertQuery = `
            INSERT INTO ${QUESTIONS_TABLE} (
                question_text, subject_id, correct_option, marks, topic, 
                option_a, option_b, option_c, option_d, question_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (question_text) DO NOTHING;
        `;
        
        for (const q of questions) {
            const result = await client.query(insertQuery, [
                q.Question_Text, 
                q.Subject_ID, 
                q.Correct_Option, 
                parseInt(q.Marks) || 1, 
                q.Topic || null, 
                q.Option_A, 
                q.Option_B, 
                q.Option_C || null, 
                q.Option_D || null,
                'MCQ'
            ]);
            
            if (result.rowCount > 0) {
                importedCount++;
            }
        }
        
        await client.query('COMMIT');
        
        res.status(200).json({ message: `${importedCount} questions imported successfully. Duplicates skipped.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Bulk Import Error:', error);
        
        if (error.code === '23503') {
             return res.status(409).json({ message: 'Import failed: Invalid Subject ID used in the data.' });
        }
        res.status(500).json({ message: `Internal error during import: ${error.message}` });
    } finally {
        client.release();
    }
});


// =================================================================
// --- (NEW) QUESTION MANAGEMENT ROUTES (For question-management.html) ---
// =================================================================

/**
 * @route   GET /api/online-exam/question-bank
 * @desc    Get all questions from the central question bank.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.get('/question-bank', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM ${QUESTIONS_TABLE} ORDER BY question_id ASC`);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching question bank:', err.message);
        res.status(500).json({ message: 'Failed to fetch question bank' });
    }
});

/**
 * @route   GET /api/online-exam/quizzes/:id/links
 * @desc    Get all questions *linked* to a specific quiz.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.get('/quizzes/:id/links', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    const { id } = req.params; // This is the quiz UUID
    try {
        const queryText = `
            SELECT 
                qq.*, 
                qql.question_order
            FROM 
                ${QUESTIONS_TABLE} AS qq
            JOIN 
                ${QUIZ_QUESTION_LINKS_TABLE} AS qql ON qq.question_id = qql.question_id
            WHERE 
                qql.quiz_id = $1
            ORDER BY
                qql.question_order ASC;
        `;
        const { rows } = await pool.query(queryText, [id]);
        res.json(rows); 
    } catch (err) {
        console.error('Error fetching linked questions:', err.message);
        res.status(500).json({ message: 'Failed to fetch linked questions' });
    }
});

/**
 * @route   PUT /api/online-exam/quizzes/:id/link-questions
 * @desc    (Re)sets the full list of questions linked to a quiz.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.put('/quizzes/:id/link-questions', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher']), async (req, res) => {
    const { id: quiz_id } = req.params; // The quiz UUID
    const { links } = req.body; // The array: [{ question_id, question_order }, ...]

    if (!Array.isArray(links)) {
        return res.status(400).json({ message: 'Invalid data format. "links" array is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction

        // Step 1: Delete all *old* links for this quiz
        await client.query(`DELETE FROM ${QUIZ_QUESTION_LINKS_TABLE} WHERE quiz_id = $1`, [quiz_id]);

        // Step 2: Insert all *new* links from the array
        for (const link of links) {
            const { question_id, question_order } = link;
            if (question_id === undefined || question_order === undefined) {
                 throw new Error('Invalid link data: question_id and question_order are required.');
            }
            const insertQuery = `
                INSERT INTO ${QUIZ_QUESTION_LINKS_TABLE} (quiz_id, question_id, question_order)
                VALUES ($1, $2, $3)
            `;
            // Your schema uses INTEGER for question_id, so we parse it
            await client.query(insertQuery, [quiz_id, parseInt(question_id), parseInt(question_order)]);
        }

        await client.query('COMMIT'); // Commit transaction
        res.status(200).json({ message: 'Quiz links updated successfully.' });

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error('Error saving quiz links:', err.message);
        res.status(500).json({ message: 'Failed to save quiz links', error: err.message });
    } finally {
        client.release(); // Release client back to pool
    }
});


// =================================================================
// --- (FIXED) SECURE EXAM FLOW ROUTES (STUDENT) ---
// =================================================================

/**
 * @route   POST /api/online-exam/exam/start
 * @desc    VERIFIES student and INITIATES attempt. NOW RETURNS QUIZ DETAILS.
 * @access  Private (Student)
 */
router.post('/exam/start', authenticateToken, authorize(['Student']), async (req, res) => {
    const student_id = req.user.student_id || req.user.id; // ✅ FIX: Use student_id from JWT payload
    const { quiz_id, live_image_data, room_number, system_id } = req.body;

    if (!student_id || !quiz_id) { 
        return res.status(400).json({ message: 'Missing Student ID or Quiz ID.' });
    }

    const studentIdStr = String(student_id); 
    const quizIdStr = String(quiz_id);

    // Use a client for two queries
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Step 1: Fetch Quiz Details (Title and Time)
        const quizDetailsQuery = `
            SELECT title, time_limit_minutes FROM ${QUIZZES_TABLE} 
            WHERE id = $1 AND status = 'Published'
        `;
        const quizResult = await client.query(quizDetailsQuery, [quizIdStr]);

        if (quizResult.rowCount === 0) {
            throw new Error('Quiz not found or is not published.', 404);
        }
        const quizDetails = quizResult.rows[0];

        // Step 2: Insert the attempt
        const attemptQuery = `
            INSERT INTO ${ATTEMPT_TABLE}
                (student_id, quiz_id, start_time, verification_image, room_number, system_id, status)
            VALUES ($1, $2, NOW(), $3, $4, $5, 'In Progress')
            RETURNING attempt_id;
        `;
        const values = [
            studentIdStr, 
            quizIdStr,    
            live_image_data || null, 
            room_number || null,
            system_id || null
        ];

        const attemptResult = await client.query(attemptQuery, values);
        const attempt_id = attemptResult.rows[0].attempt_id;

        await client.query('COMMIT');
        
        console.log(`Exam attempt started: Student ID ${studentIdStr}, Quiz ID ${quizIdStr}, Attempt ID ${attempt_id}`);
        
        // Step 3: Return both attempt_id AND quiz_details
        res.status(200).json({
            message: 'Verification successful. Attempt created.',
            attempt_id: attempt_id,
            quiz_details: {
                title: quizDetails.title,
                time_limit_minutes: quizDetails.time_limit_minutes
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Exam start error for Student ID ${student_id}, Quiz ID ${quiz_id}:`, error);
        
        if (error.status === 404) {
             return res.status(404).json({ message: error.message });
        }
        if (error.code === '23503') { // Foreign key violation
             return res.status(400).json({ message: `Invalid Student ID provided. Student not found.`});
        }
        res.status(500).json({ message: 'Internal server error during exam start process.' });
    } finally {
        client.release();
    }
});


/**
 * @route   GET /api/online-exam/attempts/:attemptId/questions
 * @desc    Retrieves the specific linked questions for the given attempt.
 * @access  Private (Student) - Requires attempt ownership check.
 */
router.get('/attempts/:attemptId/questions', authenticateToken, authorize(['Student']), async (req, res) => {
    const { attemptId } = req.params;
    const student_id = req.user.student_id || req.user.id; // ✅ FIX: Use student_id from JWT payload

    try {
        // 1. SECURITY CHECK: Ensure the student owns the attempt and get quiz_id
        const attemptDetails = await checkAttemptOwnership(attemptId, student_id);
        const quizId = attemptDetails.quiz_id;

        // 2. FETCH QUESTIONS: Use the found quizId to fetch questions
        const query = `
            SELECT
                qq.question_id,
                qq.question_text,
                qq.option_a,
                qq.option_b,
                qq.option_c,
                qq.option_d,
                qq.marks,
                qql.question_order
            FROM ${QUIZ_QUESTION_LINKS_TABLE} qql
            JOIN ${QUESTIONS_TABLE} qq ON qql.question_id = qq.question_id
            WHERE qql.quiz_id = $1 
            ORDER BY qql.question_order ASC;
        `;
        const result = await pool.query(query, [quizId]);

        res.status(200).json(result.rows);

    } catch (error) {
        console.error(`Error retrieving questions for Attempt ID ${attemptId}, Student ID ${student_id}:`, error.message);
        const status = error.status || (error.message.includes('Unauthorized') || error.message.includes('not found') ? 403 : 500);
        res.status(status).json({ message: 'Failed to load quiz questions.' });
    }
});


/**
 * @route   POST /api/online-exam/block-exam/:attemptId
 * @desc    Blocks the exam attempt due to a proctoring violation.
 * @access  Private (Student, Client-Side Logic) - Requires attempt ownership check.
 */
router.post('/block-exam/:attemptId', authenticateToken, authorize(['Student']), async (req, res) => {
    const { attemptId } = req.params;
    const student_id = req.user.student_id || req.user.id; // ✅ FIX: Use student_id from JWT payload
    const { reason } = req.body;

    try {
        // 1. SECURITY CHECK: Ensure the student owns the attempt
        await checkAttemptOwnership(attemptId, student_id);

        // 2. UPDATE STATUS
        const updateQuery = `
            UPDATE ${ATTEMPT_TABLE} SET
                status = 'Blocked', end_time = NOW()
            WHERE attempt_id = $1;
        `;
        await pool.query(updateQuery, [attemptId]);

        console.log(`Exam attempt blocked: Attempt ID ${attemptId}, Student ID ${student_id}, Reason: ${reason || 'N/A'}`);
        res.status(200).json({ message: `Attempt ${attemptId} blocked successfully.` });
    } catch (error) {
        console.error(`Error blocking exam for Attempt ID ${attemptId}, Student ID ${student_id}:`, error.message);
        const status = error.status || (error.message.includes('Unauthorized') || error.message.includes('not found') ? 403 : 500);
        res.status(status).json({ message: 'Failed to block exam.' });
    }
});


/**
 * @route   POST /api/online-exam/submit-attempt/:attemptId
 * @desc    Submits student answers for final grading and ends the attempt.
 * @access  Private (Student) - Requires attempt ownership check.
 */
router.post('/submit-attempt/:attemptId', authenticateToken, authorize(['Student']), async (req, res) => {
    const { attemptId } = req.params;
    const student_id = req.user.student_id || req.user.id; // ✅ FIX: Use student_id from JWT payload
    const { answers } = req.body; 

    if (!Array.isArray(answers)) {
        return res.status(400).json({ message: 'Invalid format for answers. Expected an array.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. SECURITY CHECK: Ensure the student owns the attempt AND get quiz_id
        const attemptDetails = await checkAttemptOwnership(attemptId, student_id);
        const quizId = attemptDetails.quiz_id;

        // --- START GRADING LOGIC ---
        
        // 2a. Fetch all correct answers & marks for this specific quiz
        const questionsQuery = `
            SELECT qq.question_id, qq.correct_option, qq.marks
            FROM ${QUESTIONS_TABLE} qq
            JOIN ${QUIZ_QUESTION_LINKS_TABLE} qql ON qq.question_id = qql.question_id
            WHERE qql.quiz_id = $1;
        `;
        const questionsResult = await client.query(questionsQuery, [quizId]);

        const answerKey = new Map();
        questionsResult.rows.forEach(row => {
            answerKey.set(Number(row.question_id), {
                correct_option: row.correct_option,
                marks: Number(row.marks) || 0 
            });
        });

        const studentAnswersMap = new Map(answers.map(a => [Number(a.question_id), a.answer]));

        let totalScore = 0;
        let correctCount = 0;
        let incorrectCount = 0;

        const insertResultQuery = `
            INSERT INTO ${RESULTS_TABLE}
                (attempt_id, question_id, student_answer, correct_answer, is_correct, marks_obtained)
            VALUES ($1, $2, $3, $4, $5, $6);
        `;

        // 2b. Loop through the *answer key* to grade.
        for (const [questionId, details] of answerKey.entries()) {
            const studentAnswer = studentAnswersMap.get(questionId) || null; 
            const correctAnswer = details.correct_option;
            const marks = details.marks;

            let isCorrect = false;
            let marksObtained = 0;

            if (studentAnswer !== null && studentAnswer === correctAnswer) {
                isCorrect = true;
                marksObtained = marks;
                totalScore += marks;
                correctCount++;
            } else if (studentAnswer !== null) {
                incorrectCount++;
            }

            await client.query(insertResultQuery, [
                attemptId,
                questionId,
                studentAnswer,
                correctAnswer,
                isCorrect,
                marksObtained
            ]);
        }

        const totalQuestions = answerKey.size;
        const unansweredCount = totalQuestions - correctCount - incorrectCount;

        // --- END GRADING LOGIC ---

        // 3. Update Attempt Status and Scores in the main attempt table
        const updateAttemptQuery = `
            UPDATE ${ATTEMPT_TABLE}
            SET
                status = 'Submitted',
                end_time = NOW(),
                total_score = $1,
                correct_count = $2,
                incorrect_count = $3,
                unanswered_count = $4
            WHERE attempt_id = $5;
        `;
        await client.query(updateAttemptQuery, [
            totalScore,
            correctCount,
            incorrectCount,
            unansweredCount,
            attemptId
        ]);

        await client.query('COMMIT');
        console.log(`Exam attempt submitted and graded: Attempt ID ${attemptId}, Student ID ${student_id}, Score ${totalScore}`);
        res.status(200).json({ message: 'Answers submitted successfully. Grading complete.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error submitting attempt ID ${attemptId} for Student ID ${student_id}:`, error.message);
        const status = error.status || (error.message.includes('Unauthorized') || error.message.includes('not found') ? 403 : 500);
        res.status(status).json({ message: 'Failed to submit answers.' });
    } finally {
        client.release();
    }
});


/**
 * @route   GET /api/online-exam/quizzes/student
 * @desc    Get available quizzes for the logged-in student based on their course.
 * @access  Private (Student)
 */
router.get('/quizzes/student', authenticateToken, authorize(['Student']), async (req, res) => {
    // This is the user UUID from the JWT payload
    const studentId = req.user.student_id; 

    if (!studentId) {
        // This is a safety check; should not happen with the fixed Auth middleware
        return res.status(403).json({ message: 'Forbidden: Student ID not found in token.' });
    }

    try {
        // Step 1: Find the student's course ID
        // FIX: The query now assumes students table links to users via user_id
        const studentInfoQuery = 'SELECT course_id FROM students WHERE user_id = $1'; 
        const studentInfoResult = await pool.query(studentInfoQuery, [studentId]);

        if (studentInfoResult.rows.length === 0) {
            return res.status(404).json({ message: 'Student profile not found.' });
        }
        const courseId = studentInfoResult.rows[0].course_id;

        // Step 2: Find available quizzes based on course
        const quizQuery = `
            SELECT 
                oq.id, 
                oq.title, 
                s.subject_name,
                oq.available_from,
                oq.available_to,
                oq.time_limit_minutes
            FROM ${QUIZZES_TABLE} oq
            LEFT JOIN subjects s ON oq.subject_id = s.id 
            WHERE oq.course_id = $1 
              AND oq.status = 'Published'
              AND (oq.available_from IS NULL OR oq.available_from <= NOW())
              AND (oq.available_to IS NULL OR oq.available_to >= NOW())
            ORDER BY oq.available_from DESC, oq.title ASC;
        `;
        
        const quizResult = await pool.query(quizQuery, [courseId]);
        
        res.status(200).json(quizResult.rows);

    } catch (error) {
        console.error(`Error fetching quizzes for student ${studentId}:`, error);
        res.status(500).json({ message: 'Failed to retrieve available quizzes.' });
    }
});


module.exports = router;