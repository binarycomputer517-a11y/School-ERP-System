// routes/marks.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); // Your database connection pool
const { authenticateToken, authorize } = require('../authMiddleware'); // Your auth middleware

// --- Roles Configuration ---
const MARK_MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
const MARK_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];


// =========================================================
// HELPER: GRADE CALCULATION LOGIC
// =========================================================

/**
 * Calculates a grade based on obtained marks vs. total marks.
 */
function calculateGrade(totalObtained, totalMax) {
    // Cannot calculate grade if data is missing or invalid
    if (totalMax === 0 || totalMax === null || totalObtained === null) {
        return null; 
    }
    
    const percentage = (totalObtained / totalMax) * 100; 
    
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B+';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F'; // Fail
}

// =======================================================================================
// 1. MARKSHEET STATUS & MARKS ENTRY FETCH ROUTES 
// =======================================================================================

/**
 * @route   GET /api/marks/status
 * @desc    Get the marksheet generation status overview for all students.
 * @access  Private (MARK_MANAGER_ROLES)
 */
router.get('/status', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.enrollment_no, 
                s.first_name || ' ' || s.last_name AS student_name,
                c.course_name,
                -- Check if any marks exist for the student
                CASE WHEN EXISTS (
                    SELECT 1 FROM marks m WHERE m.student_id = s.student_id
                ) THEN 'Generated' ELSE 'Pending' END AS marksheet_status,
                'Pending' AS certificate_status 
            FROM students s
            JOIN courses c ON s.course_id = c.id 
            ORDER BY c.course_name, s.enrollment_no; 
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching marksheet status overview:', error);
        res.status(500).json({ message: 'Server error fetching marksheet status.' });
    }
});

/**
 * @route   GET /api/marks/:examId/:subjectId
 * @desc    Fetch existing student marks for the Marks Entry form.
 * @access  Private (MARK_VIEWER_ROLES)
 */
router.get('/:examId/:subjectId', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId, subjectId } = req.params;

        // --- ✅ FIX APPLIED ---
        // Your 'marks' table columns are 'marks_obtained_theory' and 'marks_obtained_practical'.
        // This query now uses the correct column names directly.
        const result = await pool.query(
            `SELECT 
                student_id, 
                marks_obtained_theory,
                marks_obtained_practical
             FROM marks 
             WHERE exam_id = $1 AND subject_id = $2
             ORDER BY student_id`,
            [examId, subjectId]
        );
        
        res.json(result.rows);

    } catch (error) {
        console.error('SQL Error fetching existing marks:', error.message); 
        res.status(500).json({ message: 'Failed to fetch existing marks due to a database error.' });
    }
});

// =======================================================================================
// 2. MARKS ENTRY/UPSERT ROUTE (Optimized)
// =======================================================================================

/**
 * @route   POST /api/marks
 * @desc    Save/Upsert marks for a batch of students. (Optimized to prevent N+1 queries)
 * @access  Private (MARK_MANAGER_ROLES)
 */
router.post('/', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    const { exam_id, subject_id, marks } = req.body;
    const entered_by = req.user.userId; // Assuming 'userId' comes from your authenticateToken

    if (!exam_id || !subject_id || !Array.isArray(marks) || marks.length === 0) {
        return res.status(400).json({ message: 'Invalid or incomplete marks data.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // === STEP 1: Fetch schedule details (Efficiently) ===
        // --- ✅ N+1 FIX APPLIED HERE ---
        // Get course_id, batch_id, and max_marks in ONE single query.
        const scheduleQuery = `
            SELECT course_id, batch_id, max_marks
            FROM exam_schedules 
            WHERE exam_id = $1 AND subject_id = $2
            LIMIT 1;
        `;
        const scheduleResult = await client.query(scheduleQuery, [exam_id, subject_id]);

        if (scheduleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Error: Cannot find Max Marks. Exam schedule is missing for this subject.' });
        }

        const { course_id, batch_id, max_marks } = scheduleResult.rows[0]; 
        const totalMaxPossible = parseFloat(max_marks) || 0;

        // Validate required foreign keys
        if (!course_id || !batch_id) { 
             await client.query('ROLLBACK');
             return res.status(500).json({ message: 'Internal error: Retrieved course_id or batch_id is NULL from exam schedule.' }); 
        }

        // === STEP 2: Prepare the UPSERT query ===
        // --- ✅ N+1 FIX APPLIED HERE ---
        // The slow subquery `(SELECT batch_id FROM ...)` is removed.
        // We now pass `batch_id` as parameter $5.
        const upsertQuery = `
            INSERT INTO marks (
                student_id, subject_id, exam_id, course_id, batch_id,
                marks_obtained_theory, marks_obtained_practical, 
                total_marks_obtained, grade, entered_by, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT (student_id, subject_id, exam_id) 
            DO UPDATE SET 
                marks_obtained_theory = EXCLUDED.marks_obtained_theory,
                marks_obtained_practical = EXCLUDED.marks_obtained_practical,
                total_marks_obtained = EXCLUDED.total_marks_obtained,
                grade = EXCLUDED.grade, 
                entered_by = EXCLUDED.entered_by,
                updated_at = NOW();
        `;

        // === STEP 3: Execute UPSERT for each student in the transaction ===
        for (const markEntry of marks) {
            const theoryMark = markEntry.marks_obtained_theory !== null ? parseFloat(markEntry.marks_obtained_theory) : null;
            const practicalMark = markEntry.marks_obtained_practical !== null ? parseFloat(markEntry.marks_obtained_practical) : null;
            const totalObtained = (theoryMark || 0) + (practicalMark || 0);
            const grade = calculateGrade(totalObtained, totalMaxPossible); 

            if (theoryMark !== null || practicalMark !== null) {
                // --- ✅ N+1 FIX APPLIED HERE ---
                // We pass the `batch_id` variable (as $5) instead of running a new query.
                await client.query(upsertQuery, [
                    markEntry.student_id, // $1
                    subject_id,           // $2
                    exam_id,              // $3
                    course_id,            // $4 (From schedule)
                    batch_id,             // $5 (From schedule - EFFICIENT)
                    theoryMark,           // $6
                    practicalMark,        // $7
                    totalObtained,        // $8
                    grade,                // $9
                    entered_by            // $10
                ]);
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Marks saved successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Marks saving error:', error);
        res.status(500).json({ message: 'Failed to save marks due to a database error.' });
    } finally {
        client.release();
    }
});


// =======================================================================================
// 3. MARK SHEET VIEW ROUTE 
// =======================================================================================
/**
 * @route   GET /api/marks/marksheet/roll/:rollNumber
 * @desc    Get consolidated marksheet data for a single student.
 * @access  Private (MARK_VIEWER_ROLES)
 */
router.get('/marksheet/roll/:rollNumber', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    const rollNumber = req.params.rollNumber;

    try {
        // 1. Fetch Student Details
        const studentQuery = `
            SELECT 
                s.student_id, s.first_name, s.last_name, s.enrollment_no,
                c.course_name, b.batch_name
            FROM students s
            JOIN courses c ON s.course_id = c.id
            JOIN batches b ON s.batch_id = b.id
            WHERE s.enrollment_no = $1;
        `;
        const studentResult = await pool.query(studentQuery, [rollNumber]);
        const student = studentResult.rows[0];

        if (!student) {
            return res.status(404).json({ message: 'Student roll number not found.' });
        }

        // 2. Fetch All Marks for the Student
        const marksQuery = `
            SELECT 
                e.exam_name, 
                COALESCE(es.max_marks, 0) AS total_marks, 
                sub.subject_name, sub.subject_code,
                m.total_marks_obtained AS marks_obtained,
                m.grade
            FROM marks m
            JOIN exams e ON m.exam_id = e.id
            LEFT JOIN exam_schedules es ON e.id = es.exam_id AND m.subject_id = es.subject_id 
            JOIN subjects sub ON m.subject_id = sub.id
            WHERE m.student_id = $1
            ORDER BY e.exam_date, sub.subject_code;
        `;
        const marksResult = await pool.query(marksQuery, [student.student_id]);

        // 3. Consolidate Data for Frontend
        const marksheetData = {
            roll_number: rollNumber,
            student_name: `${student.first_name} ${student.last_name}`,
            course_name: student.course_name,
            batch_name: student.batch_name,
            marks: marksResult.rows.map(mark => ({
                exam_name: mark.exam_name,
                subject_name: mark.subject_name,
                subject_code: mark.subject_code,
                marks_obtained: parseFloat(mark.marks_obtained) || 0,
                total_marks: parseFloat(mark.total_marks) || 0,
                grade: mark.grade
            }))
        };

        res.status(200).json(marksheetData);

    } catch (error) {
        console.error(`Error retrieving marksheet for ${rollNumber}:`, error);
        res.status(500).json({ message: 'Internal server error while retrieving marksheet.' });
    }
});

// =======================================================================================
// 4. EXAM LIST FETCH ROUTE (THE PRIMARY FIX FOR THE 404 ERROR)
// =======================================================================================

/**
 * @route   GET /api/marks/list
 * @desc    Get a JOINED list of all exams linked to courses/batches.
 * @access  Private (MARK_MANAGER_ROLES)
 */
// --- ✅ THIS IS THE FIX for the 404 Error and Cache Bug ---
// Your frontend (`exam-management.html`) calls `GET /api/marks/list`.
// This route handler provides all data (course_id, batch_id, total_marks)
// needed for the `examCache` to work correctly.
router.get('/list', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                e.id AS exam_id,
                e.exam_name,
                e.exam_date,
                e.course_id,
                e.batch_id,
                c.course_name,
                b.batch_name,
                -- Calculate total_marks directly from the 'exams' table
                (e.max_theory_marks + e.max_practical_marks) AS total_marks
            FROM 
                exams e
            -- LEFT JOIN to safely get course and batch names
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
        
        // Example if filtering by session:
        // const academicSessionId = req.user.academic_session_id; // Get from token
        // const result = await pool.query(query, [academicSessionId]);
        
        // If not filtering by session:
        const result = await pool.query(query);
        
        // This response now contains all the data the frontend needs.
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching comprehensive exam list:', error);
        res.status(500).json({ message: 'Failed to retrieve combined exam list.' });
    }
});


module.exports = router;