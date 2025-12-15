const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Role Definitions ---
const EXAM_MANAGER_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
const EXAM_VIEWER_ROLES = ['Super Admin', 'Admin', 'Coordinator', 'Teacher', 'Student'];
const MARK_MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
const MARK_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student']; // Added Student for viewing marksheet

// =========================================================
// HELPER FUNCTIONS 
// =========================================================

/**
 * Calculates the final grade based on the percentage score.
 * @param {number|null} totalObtained - The total marks obtained.
 * @param {number|null} totalMax - The maximum possible marks.
 * @returns {string|null} The calculated letter grade or null.
 */
function calculateGrade(totalObtained, totalMax) {
    if (totalMax === 0 || totalMax === null || totalObtained === null) {
        return null; 
    }
    
    // Ensure totalObtained is not greater than totalMax due to data entry anomalies, although logic should prevent this
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
// 1. EXAM CRUD ROUTES (Mounted under /api/exams)
// =======================================================================================

/**
 * @route   GET /api/exams/list
 * @desc    Fetches a comprehensive list of all exams.
 */
router.get('/list', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                e.id AS exam_id, e.exam_name, e.exam_type, e.exam_date, e.course_id, e.batch_id,
                c.course_name, b.batch_name, b.batch_code,
                (e.max_theory_marks + e.max_practical_marks) AS total_marks,
                e.max_theory_marks, e.max_practical_marks -- Added for clarity in frontend logic
            FROM exams e
            LEFT JOIN courses c ON e.course_id = c.id
            LEFT JOIN batches b ON e.batch_id = b.id
            ORDER BY e.exam_date DESC, c.course_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching comprehensive exam list:', error);
        res.status(500).json({ message: 'Failed to retrieve combined exam list.' });
    }
});

/**
 * @route   POST /api/exams
 * @desc    Creates a new exam entry.
 */
router.post('/', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id,
        course_id, batch_id, max_theory_marks, max_practical_marks
    } = req.body;

    if (!exam_name || !exam_date || !course_id || !batch_id || !academic_session_id) {
        return res.status(400).json({ message: 'Missing required fields: name, date, course, batch, or session.' });
    }

    try {
        const query = `
            INSERT INTO exams (
                exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id,
                course_id, batch_id, max_theory_marks, max_practical_marks
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id AS exam_id, exam_name;
        `;
        
        const newExam = await pool.query(query, [
            exam_name, exam_type, exam_date, is_midterm_assessment || false, academic_session_id,
            course_id, batch_id, max_theory_marks || 100, max_practical_marks || 0
        ]);

        res.status(201).json(newExam.rows[0]);

    } catch (error) {
        console.error('Error creating exam:', error);
        res.status(500).json({ message: 'Failed to create exam.' });
    }
});

/**
 * @route   DELETE /api/exams/:id
 * @desc    Deletes an exam by its ID.
 */
router.delete('/:id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        // Note: Database should handle cascade deletion to exam_schedules and marks
        await pool.query('DELETE FROM exams WHERE id = $1', [id]); 
        res.status(200).json({ message: 'Exam deleted successfully.' });
    } catch (error) {
        console.error('Error deleting exam:', error);
        res.status(500).json({ message: 'Failed to delete exam.' });
    }
});

// =======================================================================================
// 2. EXAM SCHEDULE CRUD ROUTES (Mounted under /api/exams)
// =======================================================================================

/**
 * @route   GET /api/exams/schedule/:examId
 * @desc    Fetches the schedule for a specific exam.
 */
router.get('/schedule/:examId', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId } = req.params;
        const query = `
            SELECT 
                es.id AS schedule_id, es.subject_id, s.subject_name, s.subject_code,
                es.exam_date, es.start_time, es.end_time, es.room_number, es.max_marks
            FROM exam_schedules es
            JOIN subjects s ON es.subject_id = s.id
            WHERE es.exam_id = $1
            ORDER BY es.exam_date, es.start_time;
        `;
        const result = await pool.query(query, [examId]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching exam schedule:', error);
        res.status(500).json({ message: 'Failed to fetch exam schedule.' });
    }
});

/**
 * @route   POST /api/exams/schedule
 * @desc    Creates a new schedule entry for an exam subject.
 */
router.post('/schedule', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const {
        exam_id, course_id, batch_id, subject_id, exam_date,
        room_number, start_time, end_time
    } = req.body;

    if (!exam_id || !course_id || !batch_id || !subject_id || !exam_date || !start_time || !end_time) {
        return res.status(400).json({ message: 'Missing required schedule fields.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // Start Transaction

        // CRITICAL FIX: Fetch Max Marks from the authoritative exams table
        const marksQuery = `
            SELECT (max_theory_marks + max_practical_marks) AS derived_max_marks
            FROM exams
            WHERE id = $1::uuid;
        `;
        const marksResult = await client.query(marksQuery, [exam_id]);

        if (marksResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Associated Exam not found.' });
        }
        const derived_max_marks = marksResult.rows[0].derived_max_marks;
        
        const query = `
            INSERT INTO exam_schedules (
                exam_id, course_id, batch_id, subject_id, exam_date,
                room_number, start_time, end_time, max_marks
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id AS schedule_id;
        `;
        const newSchedule = await client.query(query, [
            exam_id, course_id, batch_id, subject_id, exam_date,
            room_number, start_time, end_time, derived_max_marks 
        ]);
        
        await client.query('COMMIT'); // Commit Transaction
        res.status(201).json(newSchedule.rows[0]);

    } catch (error) {
        if (client) await client.query('ROLLBACK'); // Rollback on error
        if (error.code === '23505') {
            return res.status(409).json({ message: 'This subject is already scheduled for this exam and batch.' });
        }
        console.error('Error creating schedule entry:', error);
        res.status(500).json({ message: 'Failed to create schedule entry.', error: error.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * @route   PUT /api/exams/schedule/:scheduleId
 * @desc    Updates an existing schedule entry.
 */
router.put('/schedule/:scheduleId', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { scheduleId } = req.params;
    const { subject_id, exam_date, room_number, start_time, end_time } = req.body;

    try {
        const query = `
            UPDATE exam_schedules
            SET 
                subject_id = $1, exam_date = $2, room_number = $3,
                start_time = $4, end_time = $5, updated_at = NOW()
            WHERE id = $6
            RETURNING *;
        `;
        const updatedSchedule = await pool.query(query, [
            subject_id, exam_date, room_number, start_time, end_time, scheduleId
        ]);
        
        if (updatedSchedule.rows.length === 0) {
            return res.status(404).json({ message: 'Schedule entry not found.' });
        }
        res.status(200).json(updatedSchedule.rows[0]);

    } catch (error) {
        console.error('Error updating schedule entry:', error);
        res.status(500).json({ message: 'Failed to update schedule entry.' });
    }
});

/**
 * @route   DELETE /api/exams/schedule/:scheduleId
 * @desc    Deletes an existing schedule entry.
 */
router.delete('/schedule/:scheduleId', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    try {
        const { scheduleId } = req.params;
        await pool.query('DELETE FROM exam_schedules WHERE id = $1', [scheduleId]);
        res.status(200).json({ message: 'Schedule entry deleted successfully.' });
    } catch (error) {
        console.error('Error deleting schedule entry:', error);
        res.status(500).json({ message: 'Failed to delete schedule entry.' });
    }
});

// =======================================================================================
// 3. MARKS ENTRY & STATUS ROUTES (Mounted under /api/marks)
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
                
                -- Check if any marks exist for the student
                CASE WHEN EXISTS (
                    SELECT 1 FROM marks m WHERE m.student_id = s.student_id
                ) THEN 'Generated' ELSE 'Pending' END AS marksheet_status,
                
                -- Simulate Certificate Status based on Marks completion
                CASE WHEN EXISTS (
                    SELECT 1 FROM marks m WHERE m.student_id = s.student_id
                ) THEN 'Ready for Issue' ELSE 'Pending' END AS certificate_status
                
            FROM students s
            JOIN courses c ON s.course_id = c.id 
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
 * @desc    Fetches existing marks for a specific exam and subject.
 */
router.get('/:examId/:subjectId', authenticateToken, authorize(MARK_VIEWER_ROLES), async (req, res) => {
    try {
        const { examId, subjectId } = req.params;

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

/**
 * @route   POST /api/marks
 * @desc    Saves/Updates marks for multiple students using UPSERT.
 */
router.post('/', authenticateToken, authorize(MARK_MANAGER_ROLES), async (req, res) => {
    const { exam_id, subject_id, marks } = req.body;
    const entered_by = req.user.id; 

    if (!exam_id || !subject_id || !Array.isArray(marks) || marks.length === 0) {
        return res.status(400).json({ message: 'Invalid or incomplete marks data.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // Start Transaction for atomic update

        // 1. Fetch Max Marks from the schedule (it was populated from exam table)
        const scheduleQuery = `
            SELECT course_id, batch_id, max_marks
            FROM exam_schedules 
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

        // 3. Execute UPSERT for each student
        for (const markEntry of marks) {
            const theoryMark = markEntry.marks_obtained_theory !== null ? parseFloat(markEntry.marks_obtained_theory) : null;
            const practicalMark = markEntry.marks_obtained_practical !== null ? parseFloat(markEntry.marks_obtained_practical) : null;
            const totalObtained = (theoryMark || 0) + (practicalMark || 0);
            const grade = calculateGrade(totalObtained, totalMaxPossible); 

            // Only insert/update if at least one mark type is provided
            if (theoryMark !== null || practicalMark !== null) {
                await client.query(upsertQuery, [
                    markEntry.student_id, subject_id, exam_id, course_id, batch_id,
                    theoryMark, practicalMark, totalObtained, grade, entered_by
                ]);
            }
        }

        await client.query('COMMIT'); // Commit Transaction
        res.status(200).json({ message: 'Marks saved successfully.' });

    } catch (error) {
        if (client) await client.query('ROLLBACK'); // Rollback on error
        console.error('Marks saving error:', error);
        res.status(500).json({ message: 'Failed to save marks due to a database error.' });
    } finally {
        if (client) client.release();
    }
});

// =======================================================================================
// 4. MARK SHEET VIEW ROUTE
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
        
        // SECURITY CHECK: If the user is a Student, they can only view their own marksheet.
        if (currentUserRole === 'Student' && currentUserId !== student.student_id) {
             return res.status(403).json({ message: 'Forbidden: Students can only view their own marksheet.' });
        }

        // 2. Fetch All Marks for the Student
        // NOTE: Uses LEFT JOIN on exam_schedules to ensure all marks entries (even if schedule is later deleted) are shown, 
        // but assumes max_marks will generally be available.
        const marksQuery = `
            SELECT 
                e.exam_name, 
                -- Use COALESCE to ensure total_marks is a number (defaults to 0 if max_marks is null)
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