// routes/marks.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Roles Configuration ---
const MARK_MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
// CRITICAL FIX: Adding 'Student' role to MARK_VIEWER_ROLES
const MARK_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student']; 

// --- Table Constants (Using assumed names based on common ERP schemas) ---
const EXAMS_TABLE = 'online_quizzes'; // Assuming exam details are stored here
const SCHEDULES_TABLE = 'quiz_schedules'; // Assuming schedule details are stored here
const MARKS_TABLE = 'marks';
const STUDENTS_TABLE = 'students';
const COURSES_TABLE = 'courses';
const BATCHES_TABLE = 'batches';
const SUBJECTS_TABLE = 'subjects';


// =========================================================
// HELPER: GRADE CALCULATION LOGIC (UNCHANGED)
// =========================================================

function calculateGrade(totalObtained, totalMax) {
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
    return 'F'; 
}

// =======================================================================================
// 1. MARK SHEET VIEW ROUTE (CRITICAL FIX: RENAME AND TABLE NAMES)
// =======================================================================================
/**
 * @route   GET /api/marks/student-transcript/:studentId  <-- New Route Name
 * @desc    Get consolidated marksheet data for a single student by UUID.
 * @access  Private (MARK_VIEWER_ROLES)
 */
router.get('/student-transcript/:studentId', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    const studentId = req.params.studentId;

    if (!studentId || studentId.length !== 36) {
        return res.status(400).json({ message: 'Invalid Student ID format.' });
    }
    
    try {
        // 1. Fetch Student Details 
        const studentQuery = `
            SELECT 
                s.student_id, s.first_name, s.last_name, s.enrollment_no, s.roll_number,
                c.course_name, b.batch_name
            FROM ${STUDENTS_TABLE} s
            JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            JOIN ${BATCHES_TABLE} b ON s.batch_id = b.id
            WHERE s.student_id = $1::uuid; 
        `;
        const studentResult = await pool.query(studentQuery, [studentId]);
        const student = studentResult.rows[0];

        if (!student) {
            return res.status(404).json({ message: 'Student ID not found.' });
        }

        // 2. Fetch All Marks for the Student
        const marksQuery = `
            SELECT 
                e.title AS exam_name, -- Use 'title' from online_quizzes table
                COALESCE(es.max_marks, 0) AS total_marks, 
                sub.subject_name, sub.subject_code,
                m.total_marks_obtained AS marks_obtained,
                m.grade
            FROM ${MARKS_TABLE} m
            -- 🚨 FIX: Joining with online_quizzes table 
            JOIN ${EXAMS_TABLE} e ON m.exam_id = e.id
            -- 🚨 FIX: Joining with quiz_schedules table
            LEFT JOIN ${SCHEDULES_TABLE} es ON e.id = es.quiz_id AND m.subject_id = es.subject_id 
            JOIN ${SUBJECTS_TABLE} sub ON m.subject_id = sub.id
            WHERE m.student_id = $1::uuid 
            ORDER BY e.created_at, sub.subject_code; -- Ordering by quiz creation time
        `;
        const marksResult = await pool.query(marksQuery, [studentId]);

        // 3. Consolidate Data for Frontend
        const marksheetData = {
            student_info: {
                student_id: student.student_id,
                roll_number: student.roll_number || student.enrollment_no || 'N/A', 
                student_name: `${student.first_name} ${student.last_name}`,
                course_name: student.course_name,
                batch_name: student.batch_name,
            },
            results: marksResult.rows.map(mark => ({
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
        console.error(`Database Error retrieving marksheet for ${studentId}:`, error.message, error.stack);
        // Returning the friendly message expected by the frontend
        res.status(500).json({ message: 'Failed to fetch existing marks due to a database error.' });
    }
});


// =======================================================================================
// 2. MARKS ENTRY FETCH ROUTES (Temporarily DISABLED/MOVED LATER)
// =======================================================================================
/**
 * @route   GET /api/marks/:examId/:subjectId
 * @desc    Fetch existing student marks for the Marks Entry form.
 * @access  Private (MARK_VIEWER_ROLES)
 */
// This route is temporarily commented out to resolve the routing conflict. 
/*
router.get('/:examId/:subjectId', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId, subjectId } = req.params;

        const result = await pool.query(
            // ... (Your original query here)
            [examId, subjectId]
        );
        
        res.json(result.rows);

    } catch (error) {
        console.error('SQL Error fetching existing marks:', error.message); 
        res.status(500).json({ message: 'Failed to fetch existing marks due to a database error.' });
    }
});
*/

// =======================================================================================
// 3. MARKSHEET STATUS & MARKS ENTRY FETCH ROUTES (UNCHANGED)
// =======================================================================================

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
        console.error('Error fetching marksheet status overview:', error);
        res.status(500).json({ message: 'Server error fetching marksheet status.' });
    }
});


// =======================================================================================
// 4. MARKS ENTRY/UPSERT ROUTE (UNCHANGED)
// =======================================================================================

router.post('/', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    const { exam_id, subject_id, marks } = req.body;
    const entered_by = req.user.userId; 

    if (!exam_id || !subject_id || !Array.isArray(marks) || marks.length === 0) {
        return res.status(400).json({ message: 'Invalid or incomplete marks data.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        const scheduleQuery = `
            SELECT course_id, batch_id, max_marks
            FROM ${SCHEDULES_TABLE}
            WHERE quiz_id = $1 AND subject_id = $2
            LIMIT 1;
        `;
        const scheduleResult = await client.query(scheduleQuery, [exam_id, subject_id]);

        if (scheduleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Error: Cannot find Max Marks. Exam schedule is missing for this subject.' });
        }

        const { course_id, batch_id, max_marks } = scheduleResult.rows[0]; 
        const totalMaxPossible = parseFloat(max_marks) || 0;

        if (!course_id || !batch_id) { 
             await client.query('ROLLBACK');
             return res.status(500).json({ message: 'Internal error: Retrieved course_id or batch_id is NULL from exam schedule.' }); 
        }

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

        for (const markEntry of marks) {
            const theoryMark = markEntry.marks_obtained_theory !== null ? parseFloat(markEntry.marks_obtained_theory) : null;
            const practicalMark = markEntry.marks_obtained_practical !== null ? parseFloat(markEntry.marks_obtained_practical) : null;
            const totalObtained = (theoryMark || 0) + (practicalMark || 0);
            const grade = calculateGrade(totalObtained, totalMaxPossible); 

            if (theoryMark !== null || practicalMark !== null) {
                await client.query(upsertQuery, [
                    markEntry.student_id, 
                    subject_id,           
                    exam_id,              
                    course_id,            
                    batch_id,             
                    theoryMark,           
                    practicalMark,        
                    totalObtained,        
                    grade,                
                    entered_by            
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
        if (client) client.release();
    }
});


// =======================================================================================
// 5. EXAM LIST FETCH ROUTE (UNCHANGED)
// =======================================================================================

router.get('/list', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                e.id AS exam_id,
                e.title AS exam_name, -- Use 'title' from online_quizzes
                e.available_from AS exam_date, -- Use appropriate date column from online_quizzes
                e.course_id,  
                e.subject_id, -- Using subject_id for consistency
                c.course_name,
                s.subject_name,
                e.max_marks AS total_marks -- Use 'max_marks' from online_quizzes
            FROM 
                ${EXAMS_TABLE} e
            LEFT JOIN 
                ${COURSES_TABLE} c ON e.course_id = c.id
            LEFT JOIN 
                ${SUBJECTS_TABLE} s ON e.subject_id = s.id
            ORDER BY
                e.available_from DESC, c.course_name;
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching comprehensive exam list for marks page:', error);
        res.status(500).json({ message: 'Failed to retrieve combined exam list.' });
    }
});


module.exports = router;