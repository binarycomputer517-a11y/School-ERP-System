// routes/transcript.js (UPDATED FINAL VERSION)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Constants (Ensure these names match your PostgreSQL schema) ---
const MARK_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student']; 
const EXAMS_TABLE = 'exams'; // 🚨 FIX 1: Use the correct table name 'exams'
const SCHEDULES_TABLE = 'exam_schedules'; // 🚨 FIX 2: Need schedules table to get max_marks reliably
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


// =========================================================
// GET: Transcript/Marksheet by Student ID
// =========================================================

router.get('/:studentId', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    const studentId = req.params.studentId;

    if (!studentId || studentId.length !== 36) {
        return res.status(400).json({ message: 'Invalid Student ID format.' });
    }
    
    try {
        // 1. Fetch Student Details (UNCHANGED)
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
                -- 🚨 FIX 3: Use e.exam_name from the 'exams' table
                COALESCE(e.exam_name, 'Exam Missing') AS exam_name, 
                
                -- 🚨 FIX 4: Join schedules table to get the max marks recorded during scheduling
                COALESCE(es.max_marks, 0) AS total_marks, 
                
                COALESCE(sub.subject_name, 'Subject Missing') AS subject_name, 
                sub.subject_code,
                m.total_marks_obtained AS marks_obtained,
                m.grade
            FROM ${MARKS_TABLE} m
            -- 🚨 FIX 5: Join with the correct EXAMS_TABLE ('exams') using INNER JOIN for reliable exam names
            JOIN ${EXAMS_TABLE} e ON m.exam_id = e.id
            
            -- 🚨 FIX 6: LEFT JOIN with SCHEDULES_TABLE to get max_marks for the subject in that exam
            LEFT JOIN ${SCHEDULES_TABLE} es ON e.id = es.exam_id AND m.subject_id = es.subject_id
            
            LEFT JOIN ${SUBJECTS_TABLE} sub ON m.subject_id = sub.id
            WHERE m.student_id = $1::uuid 
            ORDER BY e.exam_date, sub.subject_code; 
        `;
        const marksResult = await pool.query(marksQuery, [studentId]);

        // 3. Consolidate Data for Frontend (UNCHANGED)
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
        
        console.log("Marksheet Data Sent (Results Count):", marksheetData.results.length);

        res.status(200).json(marksheetData);

    } catch (error) {
        console.error(`Database Error retrieving marksheet for ${studentId}:`, error.message, error.stack);
        res.status(500).json({ message: 'Failed to fetch existing marks due to a database error.' });
    }
});


module.exports = router;