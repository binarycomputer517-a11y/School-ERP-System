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
                    -- FIX: Using confirmed PK s.student_id
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

        // Fetching split marks columns (using the marks_obtained columns for the frontend form)
        // FIX: Assumes marks_obtained_theory and marks_obtained_practical are the correct column names.
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
        // Includes grade calculation.
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
            const practicalMark = markEntry.marks_obtained_practical !== null ? parseInt(markEntry.marks
