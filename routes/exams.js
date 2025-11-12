// routes/marks.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');


// --- Roles Configuration (UPDATED) ---
const MARK_MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
const MARK_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];


// =========================================================
// HELPER: GRADE CALCULATION LOGIC
// =========================================================

function calculateGrade(totalObtained, totalMax) {
    if (totalMax === 0 || totalMax === null) return null; // Cannot divide by zero
    
    const percentage = (totalObtained / totalMax) * 100; 
    // Define a simple grading scale
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
 * @access  Private (Super Admin, Admin, Teacher, Coordinator)
 */
router.get('/status', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.enrollment_no, 
                s.first_name || ' ' || s.last_name AS student_name,
                c.course_name,
                -- Simplistic check: If any marks exist for the student, assume marksheet is 'Generated'
                CASE WHEN EXISTS (
                    -- FIX: Using confirmed student PK s.student_id
                    SELECT 1 FROM marks m WHERE m.student_id = s.student_id
                ) THEN 'Generated' ELSE 'Pending' END AS marksheet_status,
                'Pending' AS certificate_status 
            FROM students s
            /* Joining students to courses using the correct foreign key s.course_id and c.id */
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
 * @desc    Fetch existing student marks using the simple schema (for Marks Entry form).
 * @access  Private (Super Admin, Admin, Teacher, Coordinator)
 */
router.get('/:examId/:subjectId', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId, subjectId } = req.params;

        // Using standard column names as found in the INSERT/UPSERT section
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
        
        // Client expects { student_id, marks_obtained_theory, marks_obtained_practical }
        const marks = result.rows.map(row => ({
            student_id: row.student_id,
            marks_obtained_theory: row.marks_obtained_theory,
            marks_obtained_practical: row.marks_obtained_practical
        }));

        res.json(marks);
    } catch (error) {
        console.error('SQL Error fetching existing marks:', error.message); 
        // If this crashes, the column names above are definitively wrong in the marks table.
        res.status(500).json({ message: 'Failed to fetch existing marks due to a database error. Check your table and column names.' });
    }
});

// =======================================================================================
// 2. MARKS ENTRY/UPSERT ROUTE
// =======================================================================================

/**
 * @route   POST /api/marks
 * @desc    Save/Upsert marks for a batch of students.
 * @access  Private (Super Admin, Admin, Teacher, Coordinator)
 */
router.post('/', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    const { exam_id, subject_id, marks } = req.body;
    const entered_by = req.user.userId;

    if (!exam_id || !subject_id || !Array.isArray(marks)) {
        return res.status(400).json({ message: 'Invalid or incomplete marks data.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // === STEP 1: FETCH COURSE ID AND MAX MARKS (CRITICAL for NOT NULL and Grade Calc) ===
        // Fetch max_marks for percentage and grade calculation.
        const scheduleQuery = `
            SELECT course_id, max_marks
            FROM exam_schedules 
            WHERE exam_id = $1 AND subject_id = $2
            LIMIT 1;
        `;
        const scheduleResult = await client.query(scheduleQuery, [exam_id, subject_id]);

        if (scheduleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Error: Cannot find Max Marks. Exam schedule is missing for this subject.' });
        }

        const { course_id, max_marks } = scheduleResult.rows[0]; 
        const totalMaxPossible = parseFloat(max_marks) || 0; // Ensure max_marks is a float, default to 0

        if (!course_id) { 
             await client.query('ROLLBACK');
             return res.status(500).json({ message: 'Internal error: Retrieved course_id is NULL, violating marks table NOT NULL constraint.' }); 
        }

        // === STEP 2: PERFORM UPSERT ===
        // The column names in the INSERT/UPDATE section MUST match the schema exactly.
        const upsertQuery = `
            INSERT INTO marks (
                student_id, subject_id, exam_id, course_id, 
                marks_obtained_theory, marks_obtained_practical, 
                total_marks_obtained, grade, entered_by, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (student_id, subject_id, exam_id) 
            DO UPDATE SET 
                marks_obtained_theory = EXCLUDED.marks_obtained_theory,
                marks_obtained_practical = EXCLUDED.marks_obtained_practical,
                total_marks_obtained = EXCLUDED.total_marks_obtained,
                grade = EXCLUDED.grade, 
                entered_by = EXCLUDED.entered_by,
                updated_at = NOW();
        `;

        for (const markEntry of marks) {
            // Use NULL for SQL insertion if the mark was not provided/is an empty string (as the schema allows it)
            const theoryMark = markEntry.marks_obtained_theory !== null ? parseInt(markEntry.marks_obtained_theory) : null;
            const practicalMark = markEntry.marks_obtained_practical !== null ? parseInt(markEntry.marks_obtained_practical) : null;
            
            // Calculate total for NOT NULL column (treat NULL inputs as 0 for sum)
            const totalObtained = (theoryMark || 0) + (practicalMark || 0);

            // Determine the Grade
            // Ensure calculation happens only if totalMaxPossible is > 0
            const grade = totalMaxPossible > 0 ? calculateGrade(totalObtained, totalMaxPossible) : null; 

            // Only proceed if marks were actually entered (or if required fields were inserted)
            if (theoryMark !== null || practicalMark !== null) {
                await client.query(upsertQuery, [
                    markEntry.student_id, 
                    subject_id, 
                    exam_id, 
                    course_id,        // $4
                    theoryMark,       // $5 (NULL or integer)
                    practicalMark,    // $6 (NULL or integer)
                    totalObtained,    // $7: The calculated sum, required by NOT NULL constraint
                    grade,            // $8: The calculated grade (or NULL if max marks is 0)
                    entered_by        // $9
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
 * @access  Private (Super Admin, Admin, Teacher, Coordinator)
 */
router.get('/marksheet/roll/:rollNumber', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    const rollNumber = req.params.rollNumber;

    try {
        // 1. Fetch Student/Course/Batch Details
        const studentQuery = `
            SELECT 
                s.student_id AS student_id, s.first_name, s.last_name, s.enrollment_no, -- FIX: Using confirmed PK s.student_id
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
                -- Use LEFT JOIN and COALESCE to safely get max_marks (default to 0) 
                COALESCE(es.max_marks, 0) AS total_marks, 
                sub.subject_name, sub.subject_code,
                -- Use total_marks_obtained directly from the table (since it's now inserted)
                m.total_marks_obtained AS marks_obtained,
                m.grade /* Fetching the calculated grade */
            FROM marks m
            JOIN exams e ON m.exam_id = e.id
            -- Use LEFT JOIN here to prevent failure if schedule is missing
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
                grade: mark.grade // Include the grade for display
            }))
        };

        res.status(200).json(marksheetData);

    } catch (error) {
        console.error(`Error retrieving marksheet for ${rollNumber}:`, error);
        res.status(500).json({ message: 'Internal server error while retrieving marksheet.' });
    }
});
// routes/exams.js (Add this route)

/**
 * @route   GET /api/exams/list
 * @desc    Get a simplified list of all active exams (for dropdowns/filters).
 * @access  Private (Management Roles)
 */
router.get('/list', authenticateToken, authorize(EXAM_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                id, 
                exam_name, 
                exam_date
            FROM exams
            ORDER BY exam_date DESC;
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching exam list:', error);
        res.status(500).json({ message: 'Failed to retrieve exam list.' });
    }
});

module.exports = router;
