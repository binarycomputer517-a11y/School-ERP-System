// /routes/timetable.js (FINAL FIXED VERSION + Logging + Integer Parsing)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authorize } = require('../authMiddleware'); 

const TIMETABLE_ID_COLUMN = 'timetable_id'; 

// ===============================================
// 1. TIMETABLE CREATION & DELETION (Admin Only)
// ===============================================

// /routes/timetable.js (Enhanced Validation)

// ... (rest of the file remains the same) ...

/**
 * @route   POST /api/timetable
 * @desc    Add multiple new timetable slots for a class 
 * @access  Private (Admin)
 */
router.post('/', authorize(['Admin']), async (req, res) => {
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'Timetable entries must be a non-empty array.' });
    }

    const courseIdToDelete = entries[0]?.course_id; 
    if (!courseIdToDelete) {
        return res.status(400).json({ error: 'Course ID is missing in timetable entries.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Parse ID for deletion
        const parsedCourseIdToDelete = parseInt(courseIdToDelete, 10);
        if (isNaN(parsedCourseIdToDelete)) {
            throw new Error(`Invalid Course ID format received: ${courseIdToDelete}`);
        }
        await client.query('DELETE FROM timetable WHERE course_id = $1', [parsedCourseIdToDelete]); 

        const insertQuery = `
            INSERT INTO timetable (course_id, subject_id, teacher_id, day_of_week, period_number, start_time, end_time, room_number)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `;

        for (const entry of entries) {
            
            // --- ENHANCED VALIDATION FIX: Check for null, undefined, AND empty string ---
            // Helper to check if a value is effectively missing
            const isMissing = (val) => val === undefined || val === null || String(val).trim() === '';

            if (isMissing(entry.course_id) || isMissing(entry.subject_id) || isMissing(entry.day_of_week) || isMissing(entry.period_number) || isMissing(entry.start_time) || isMissing(entry.end_time)) {
                 console.warn("Skipping incomplete timetable entry. Missing one of: course_id, subject_id, day_of_week, period_number, start_time, end_time. Entry details:", entry);
                 return res.status(400).json({ error: 'Save failed: All timetable entries must be fully populated.' });
            }

            // --- CRITICAL FIX: Coerce IDs to Integers for PostgreSQL ---
            const courseId = parseInt(entry.course_id, 10); 
            const subjectId = parseInt(entry.subject_id, 10);
            const periodNumber = parseInt(entry.period_number, 10);
            const teacherId = entry.teacher_id ? parseInt(entry.teacher_id, 10) : null;
            
            // Safety Check: Reject if parsing failed (NaN) or resulted in 0 (which is an invalid ID in most cases)
            if (isNaN(courseId) || isNaN(subjectId) || isNaN(periodNumber) || courseId === 0 || subjectId === 0 || periodNumber === 0) {
                 console.error("Failed integer parsing for entry:", entry);
                 return res.status(400).json({ error: 'Save failed: Course, Subject, or Period ID is not a valid number (must be > 0).' });
            }
            
            // Note: Since entry.period_number is already checked for being non-empty/null above, this is safe.

            await client.query(insertQuery, [
                courseId,
                subjectId,
                teacherId,
                entry.day_of_week,
                periodNumber,
                entry.start_time,
                entry.end_time,
                entry.room_number || null
            ]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: `Timetable for course ID ${parsedCourseIdToDelete} saved successfully.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error saving timetable:', err);
        if (err.code === '23503') { 
             return res.status(400).json({ error: `Save failed: Invalid Subject ID or Teacher ID provided. Details: ${err.detail}` });
        } else if (err.code === '23505') {
             return res.status(400).json({ error: `Save failed: A class or teacher is already scheduled at this time. Details: ${err.detail}` });
        }
        res.status(500).json({ error: 'Server error during timetable save.' });
    } finally {
        client.release();
    }
});

// ... (rest of the file remains the same) ...


/**
 * @route   DELETE /api/timetable/:id
 * @desc    Delete a specific timetable slot by its unique ID
 * @access  Private (Admin)
 */
router.delete('/:id', authorize(['Admin']), async (req, res) => {
    const { id } = req.params;
    // Validate ID format
     if (isNaN(parseInt(id))) {
         return res.status(400).json({ error: 'Invalid timetable slot ID format.' });
     }

    try {
        const result = await pool.query(`DELETE FROM timetable WHERE ${TIMETABLE_ID_COLUMN} = $1 RETURNING ${TIMETABLE_ID_COLUMN}`, [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Timetable slot not found.' });
        }
        res.status(200).json({ message: 'Timetable slot deleted successfully.' }); 
    } catch (err) {
        console.error('Error deleting timetable slot:', err);
        res.status(500).json({ error: 'Server error during deletion.' }); 
    }
});


// ===============================================
// 2. TIMETABLE RETRIEVAL (GET)
// ===============================================

/**
 * @route   GET /api/timetable
 * @desc    Get the entire school timetable (Join data required) - Primarily for Admin view
 * @access  Private (Admin, Teacher - maybe restrict further based on needs)
 */
router.get('/', authorize(['Admin', 'Teacher']), async (req, res) => {
    try {
        // NOTE: Removed tt.period_number from SELECT to match table schema
        const sql = `
            SELECT
                tt.timetable_id, tt.day_of_week, tt.start_time, tt.end_time, tt.room_number,
                c.course_name, s.subject_name,
                t.full_name AS teacher_name,
                tt.course_id, tt.subject_id, tt.teacher_id
            FROM timetable tt
            LEFT JOIN courses c ON tt.course_id = c.course_id
            LEFT JOIN subjects s ON tt.subject_id = s.subject_id
            LEFT JOIN teachers t ON tt.teacher_id = t.teacher_id
            ORDER BY c.course_name,
                     CASE tt.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,
                     tt.start_time; 
        `;
        const result = await pool.query(sql);
        res.status(200).json(result.rows);
    } catch (err) {
        // NOTE: Check server log for the actual error here (e.g. if tt.period_number is still in ORDER BY)
        console.error('Error fetching full timetable:', err);
        res.status(500).json({ error: 'Server error fetching timetable data.' }); 
    }
});

/**
 * @route   GET /api/timetable/by-class/:courseId
 * @desc    Get timetable slots specifically for managing a single class/course grid
 * @access  Private (Admin) - Used by manage-timetable.html
 */
router.get('/by-class/:courseId', authorize(['Admin']), async (req, res) => {
    const { courseId } = req.params;
     // Validate ID
     if (isNaN(parseInt(courseId))) {
        return res.status(400).json({ error: 'Invalid Course ID format.' });
     }
    try {
        // NOTE: Added tt.period_number back to SELECT here as it IS required by the management grid frontend logic
        const sql = `
            SELECT
                tt.day_of_week, tt.period_number,
                tt.subject_id, tt.teacher_id
            FROM timetable tt
            WHERE tt.course_id = $1
            ORDER BY 
                CASE tt.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,
                tt.period_number;
        `;
        const result = await pool.query(sql, [courseId]);
        res.status(200).json(result.rows); 
    } catch (err) {
        console.error(`Error fetching timetable for course ${courseId}:`, err);
        res.status(500).json({ error: 'Server error fetching course timetable.' }); 
    }
});


// ===============================================
// 3. STUDENT'S WEEKLY TIMETABLE (GET)
// ===============================================

/**
 * @route   GET /api/timetable/student/me
 * @desc    Get the full weekly timetable for the logged-in student
 * @access  Private (Student) - Used by my-timetable.html
 */
router.get('/student/me', authorize(['Student']), async (req, res) => {
    const studentId = req.user.reference_id;

    console.log(`[Timetable /student/me] Received request for studentId from token (reference_id): ${studentId}`);

    if (!studentId || isNaN(parseInt(studentId))) {
        console.error(`[Timetable /student/me] Invalid studentId received: ${studentId}`);
        return res.status(403).json({ message: 'Forbidden: Invalid or missing Student ID in token.' });
    }

    try {
        // Step 1: Find the Course ID of the student
        const studentResult = await pool.query('SELECT course_id FROM students WHERE student_id = $1', [studentId]);

        console.log(`[Timetable /student/me] Result of finding course_id for student ${studentId}:`, studentResult.rows);

        // Step 2: Check if student exists and has a course assigned
        if (studentResult.rows.length === 0 || !studentResult.rows[0].course_id) {
            const reason = studentResult.rows.length === 0 ? `Student ${studentId} not found.` : `Student ${studentId} found but course_id is NULL.`;
            console.warn(`[Timetable /student/me] 404 Triggered: ${reason}`);
            return res.status(404).json({ message: 'Student course information not found.' });
        }
        const courseId = studentResult.rows[0].course_id;

        // Step 3: Fetch all timetable entries for that Course ID
        const query = `
            SELECT
                tt.day_of_week,
                tt.start_time,
                tt.end_time,
                s.subject_name,
                t.full_name AS teacher_name
            FROM timetable tt
            LEFT JOIN subjects s ON tt.subject_id = s.subject_id
            LEFT JOIN teachers t ON tt.teacher_id = t.teacher_id
            WHERE tt.course_id = $1
            ORDER BY
                CASE tt.day_of_week
                    WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
                    WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7
                END,
                tt.start_time;
        `;
        const result = await pool.query(query, [courseId]);

        res.status(200).json(result.rows);

    } catch (err) {
        console.error(`[Timetable /student/me] Error fetching timetable for student ${studentId}:`, err);
        res.status(500).json({ message: 'Server error fetching timetable.' }); 
    }
});


module.exports = router;