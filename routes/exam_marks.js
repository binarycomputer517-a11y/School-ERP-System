// routes/exam_marks.js - Handles Marks Entry, Status, and Transcripts (Mounted under /api/marks)

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Role Definitions ---
const MARK_MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
const MARK_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student']; 

// --- Table Constants ---
const EXAMS_TABLE = 'exams'; 
const SCHEDULES_TABLE = 'exam_schedules'; 
const MARKS_TABLE = 'marks';
const STUDENTS_TABLE = 'students';
const COURSES_TABLE = 'courses';
const SUBJECTS_TABLE = 'subjects';


// =========================================================
// HELPER: GRADE CALCULATION LOGIC 
// =========================================================

function calculateGrade(totalObtained, totalMax) {
    if (totalMax === 0 || totalMax === null || totalObtained === null) {
        return null; 
    }
    const obtained = Math.min(totalObtained, totalMax); 
    const percentage = (obtained / totalMax) * 100; 
    
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B+';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F'; 
}

// =======================================================================================
// 1. MARKS ENTRY/UPSERT ROUTE (POST /api/marks)
// =======================================================================================

/**
 * @route   POST /api/marks
 * @desc    Saves/Updates marks for multiple students using UPSERT.
 */
router.post('/', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    const { exam_id, subject_id, marks } = req.body;
    const entered_by = req.user.id; 

    // 🚨 Correct validation for Marks Entry (THIS MUST RUN on POST /api/marks)
    if (!exam_id || !subject_id || !Array.isArray(marks) || marks.length === 0) {
        return res.status(400).json({ message: 'Invalid or incomplete marks data. Requires exam_id, subject_id, and marks array.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); 

        // 1. Fetch Max Marks and course/batch from the schedule
        const scheduleQuery = `
            SELECT course_id, batch_id, max_marks
            FROM ${SCHEDULES_TABLE} 
            WHERE exam_id = $1 AND subject_id = $2
            LIMIT 1;
        `;
        const scheduleResult = await client.query(scheduleQuery, [exam_id, subject_id]);

        if (scheduleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Error: Max Marks info missing. Exam schedule is missing for this subject.' });
        }

        const { course_id, batch_id, max_marks } = scheduleResult.rows[0]; 
        const totalMaxPossible = parseFloat(max_marks) || 0;

        // 2. Prepare the UPSERT query
        const upsertQuery = `
            INSERT INTO ${MARKS_TABLE} (
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

        // 3. Execute UPSERT for each student
        for (const markEntry of marks) {
            const theoryMark = markEntry.marks_obtained_theory !== null ? parseFloat(markEntry.marks_obtained_theory) : null;
            const practicalMark = markEntry.marks_obtained_practical !== null ? parseFloat(markEntry.marks_obtained_practical) : null;
            const totalObtained = (theoryMark || 0) + (practicalMark || 0);
            const grade = calculateGrade(totalObtained, totalMaxPossible); 

            if (theoryMark !== null || practicalMark !== null) {
                await client.query(upsertQuery, [
                    markEntry.student_id, subject_id, exam_id, course_id, batch_id,
                    theoryMark, practicalMark, totalObtained, grade, entered_by
                ]);
            }
        }

        await client.query('COMMIT'); 
        res.status(200).json({ message: 'Marks saved successfully.' });

    } catch (error) {
        if (client) await client.query('ROLLBACK'); 
        console.error('Marks saving error:', error);
        res.status(500).json({ message: 'Failed to save marks due to a database error.' });
    } finally {
        if (client) client.release();
    }
});


// =======================================================================================
// 2. MARKS STATUS & FETCH ROUTES
// =======================================================================================

/**
 * @route   GET /api/marks/status
 * @desc    Get the marksheet generation status overview for all students.
 */
router.get('/status', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.enrollment_no, 
                s.first_name || ' ' || s.last_name AS student_name,
                c.course_name,
                CASE WHEN EXISTS (
                    SELECT 1 FROM ${MARKS_TABLE} m WHERE m.student_id = s.student_id
                ) THEN 'Generated' ELSE 'Pending' END AS marksheet_status,
                'Pending' AS certificate_status 
            FROM ${STUDENTS_TABLE} s
            JOIN ${COURSES_TABLE} c ON s.course_id = c.id 
            ORDER BY c.course_name, s.enrollment_no; 
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching marksheet status overview:', error.message);
        res.status(500).json({ message: 'Server error fetching marksheet status.' });
    }
});

/**
 * @route   GET /api/marks/:examId/:subjectId
 * @desc    Fetches existing marks for a specific exam and subject for the marks entry form.
 */
router.get('/:examId/:subjectId', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId, subjectId } = req.params;

        const result = await pool.query(
            `SELECT 
                student_id, 
                marks_obtained_theory,
                marks_obtained_practical
             FROM ${MARKS_TABLE} 
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
// 3. MARK SHEET VIEW ROUTE (FOR MODAL)
// =======================================================================================
/**
 * @route   GET /api/marks/marksheet/roll/:rollNumber
 * @desc    Generates and returns the complete marksheet for a specific student.
 */
router.get('/marksheet/roll/:rollNumber', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    const rollNumber = req.params.rollNumber;
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role;

    try {
        // 1. Fetch Student Details
        const studentQuery = `
            SELECT 
                s.student_id, s.first_name, s.last_name, s.enrollment_no, s.course_id, s.batch_id,
                c.course_name, b.batch_name
            FROM ${STUDENTS_TABLE} s
            JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            JOIN batches b ON s.batch_id = b.id
            WHERE s.enrollment_no = $1;
        `;
        const studentResult = await pool.query(studentQuery, [rollNumber]);
        const student = studentResult.rows[0];

        if (!student) {
            return res.status(404).json({ message: 'Student roll number not found.' });
        }
        
        // SECURITY CHECK: If the user is a Student, they can only view their own marksheet.
        if (currentUserRole === 'Student' && currentUserId !== student.student_id) {
             return res.status(403).json({ message: 'Forbidden: Students can only view their own marksheet.' });
        }

        // 2. Fetch All Marks for the Student
        const marksQuery = `
            SELECT 
                e.exam_name, 
                COALESCE(es.max_marks, 0) AS total_marks, 
                sub.subject_name, sub.subject_code,
                m.total_marks_obtained AS marks_obtained,
                m.grade
            FROM ${MARKS_TABLE} m
            JOIN ${EXAMS_TABLE} e ON m.exam_id = e.id
            LEFT JOIN ${SCHEDULES_TABLE} es ON e.id = es.exam_id AND m.subject_id = es.subject_id 
            JOIN ${SUBJECTS_TABLE} sub ON m.subject_id = sub.id
            WHERE m.student_id = $1
            ORDER BY e.exam_date, sub.subject_code;
        `;
        const marksResult = await pool.query(marksQuery, [student.student_id]);

        // 3. Consolidate Data 
        const marksheetData = {
            student_id: student.student_id,
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


module.exports = router;