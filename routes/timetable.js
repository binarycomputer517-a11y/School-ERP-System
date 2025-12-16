// routes/timetable.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

const TIMETABLE_TABLE = 'class_timetable';

// --- Day Mapping for Database Insertion/Sorting ---
const daysMap = {
    'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4,
    'Friday': 5, 'Saturday': 6, 'Sunday': 7
};

// --- Role Definitions ---
const MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher'];
const VIEW_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Student', 'Parent'];


// =========================================================
// Helpers
// =========================================================

function getDayAsNumber(dayStringOrNumber) {
    if (typeof dayStringOrNumber === 'number' && dayStringOrNumber >= 1 && dayStringOrNumber <= 7) {
        return dayStringOrNumber;
    }
    return daysMap[dayStringOrNumber] || null;
}

// Basic UUID/ID Validation
function isValidId(id) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Allowing numeric IDs as well, as per previous assumption, though UUID is preferred
    return uuidRegex.test(id) || (!isNaN(parseInt(id)) && isFinite(id)); 
}


// =========================================================
// 2. Student View Endpoint
// =========================================================

/**
 * @route   GET /api/timetable/student/me
 * @desc    Get the timetable for the logged-in student.
 * @access  Private (Student, Admin, Parent)
 */
router.get('/student/me', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const studentUserId = req.user.id; // User's UUID from the JWT

    try {
        const studentInfoQuery = `
            SELECT course_id, batch_id 
            FROM students 
            WHERE user_id = $1
            LIMIT 1
        `;
        const studentInfoResult = await pool.query(studentInfoQuery, [studentUserId]);
        
        if (studentInfoResult.rowCount === 0) {
            return res.status(404).json({ message: 'Student profile not found or user association is missing.' });
        }
        const { course_id, batch_id } = studentInfoResult.rows[0];
        
        const detailedQuery = `
            SELECT 
                ct.id, ct.day_of_week, ct.start_time, ct.end_time, ct.room_number,
                s.subject_name, s.subject_code,
                COALESCE(t.full_name, u.username) AS teacher_name,
                t.id AS teacher_reference_id
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            LEFT JOIN teachers t ON ct.teacher_id = t.id
            LEFT JOIN users u ON t.user_id = u.id
            WHERE ct.course_id = $1 AND ct.batch_id = $2 AND ct.is_active = TRUE
            ORDER BY ct.day_of_week, ct.start_time ASC;
        `;
        const result = await pool.query(detailedQuery, [course_id, batch_id]);
        
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Student Timetable Fetch Error:', error);
        res.status(500).json({ message: 'Internal Server Error: Failed to retrieve student timetable.' });
    }
});


// =========================================================
// 3. Teacher View Endpoint (MOVED UP FOR SAFE ROUTING)
// =========================================================

/**
 * @route   GET /api/timetable/teacher/me
 * @desc    Get the assigned weekly timetable for the logged-in teacher.
 * @access  Private (Teacher)
 */
router.get('/teacher/me', authenticateToken, authorize(['Teacher']), async (req, res) => {
    const teacherUserId = req.user.id; // User's UUID from the JWT

    try {
        // Step 1: Find the teacher's internal ID (t.id) using the User ID (u.id)
        const teacherIdQuery = `
            SELECT t.id 
            FROM teachers t
            WHERE t.user_id = $1
            LIMIT 1;
        `;
        const teacherIdResult = await pool.query(teacherIdQuery, [teacherUserId]);
        
        if (teacherIdResult.rowCount === 0) {
            // Returning 404 here, which is expected if the teacher has no profile
            return res.status(404).json({ message: 'Teacher profile not found or user association is missing.' });
        }
        
        const teacherReferenceId = teacherIdResult.rows[0].id;
        
        // Step 2: Fetch timetable slots assigned to this teacher reference ID
        const timetableQuery = `
            SELECT 
                ct.id, ct.day_of_week, ct.start_time, ct.end_time, ct.room_number,
                s.subject_name, s.subject_code,
                c.course_name, b.batch_name
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            LEFT JOIN courses c ON ct.course_id = c.id
            LEFT JOIN batches b ON ct.batch_id = b.id
            
            WHERE ct.teacher_id = $1 AND ct.is_active = TRUE
            ORDER BY 
                ct.day_of_week, 
                ct.start_time ASC;
        `;
        
        const result = await pool.query(timetableQuery, [teacherReferenceId]);
        
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Teacher Timetable Fetch Error:', error);
        // Logging database error detail (added in previous step)
        console.error('Database Error Detail:', error.detail); 
        res.status(500).json({ message: 'Internal Server Error: Failed to retrieve teacher timetable.' });
    }
});


// =========================================================
// 1. CRUD Routes (Admin/Teacher) - PARAMETER ROUTES LAST
// =========================================================

/**
 * @route   POST /api/timetable
 * @desc    Create a new timetable entry (class slot).
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.post('/', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { 
        course_id, batch_id, subject_id, teacher_id, day_of_week, 
        start_time, end_time, room_number
    } = req.body;

    if (!course_id || !batch_id || !subject_id || !day_of_week || !start_time || !end_time) {
        return res.status(400).json({ message: 'Missing required schedule fields.' });
    }
    
    // Validate IDs and Day
    if (!isValidId(course_id) || !isValidId(batch_id) || !isValidId(subject_id)) {
        return res.status(400).json({ message: 'Invalid ID format provided for Course, Batch, or Subject.' });
    }

    const dayAsNumber = getDayAsNumber(day_of_week);
    if (dayAsNumber === null) {
        return res.status(400).json({ message: 'Invalid day_of_week value.' });
    }

    try {
        const query = `
            INSERT INTO ${TIMETABLE_TABLE} (
                course_id, batch_id, subject_id, teacher_id, day_of_week, 
                start_time, end_time, room_number
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id;
        `;
        const values = [
            course_id, batch_id, subject_id, teacher_id || null, dayAsNumber,
            start_time, end_time, room_number || null
        ];
        
        const result = await pool.query(query, values);
        res.status(201).json({ message: 'Timetable slot created successfully', id: result.rows[0].id });

    } catch (error) {
        console.error('Timetable Creation Error:', error);
        
        if (error.code === '23505') { 
            return res.status(409).json({ message: 'Schedule conflict: An entry for this batch, day, and time already exists.' });
        }
        res.status(500).json({ message: 'Failed to create timetable slot due to server error.' });
    }
});


/**
 * @route   GET /api/timetable/:courseId/:batchId
 * @desc    Get the full weekly timetable for a specific Course and Batch.
 * @access  Private (Super Admin, Admin, Teacher, Student)
 */
router.get('/:courseId/:batchId', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const { courseId, batchId } = req.params;

    // SECURITY FIX: Input validation for URL parameters
    // This is the validation that was causing the error if the fixed route was hit instead
    if (!isValidId(courseId) || !isValidId(batchId)) {
        return res.status(400).json({ message: 'Invalid Course or Batch ID format.' });
    }

    try {
        const query = `
            SELECT 
                ct.id, ct.day_of_week, ct.start_time, ct.end_time, ct.room_number,
                s.subject_name, s.subject_code,
                COALESCE(t.full_name, u.username) AS teacher_name,
                t.id AS teacher_reference_id
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            LEFT JOIN teachers t ON ct.teacher_id = t.id
            LEFT JOIN users u ON t.user_id = u.id
            WHERE ct.course_id = $1 AND ct.batch_id = $2 AND ct.is_active = TRUE
            ORDER BY ct.day_of_week, ct.start_time ASC;
        `;
        const result = await pool.query(query, [courseId, batchId]);
        
        // Group the results by day
        const timetable = result.rows.reduce((acc, slot) => {
            const day = slot.day_of_week;
            if (!acc[day]) {
                acc[day] = [];
            }
            acc[day].push(slot);
            return acc;
        }, {});

        res.status(200).json(timetable);

    } catch (error) {
        console.error('Timetable Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve timetable.' });
    }
});


/**
 * @route   DELETE /api/timetable/:id
 * @desc    Delete a timetable slot.
 * @access  Private (Super Admin, Admin, Teacher)
 */
router.delete('/:id', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role;

    // SECURITY FIX: Input validation for ID format
     if (!isValidId(id)) {
        return res.status(400).json({ message: 'Invalid Timetable ID format.' });
    }

    try {
        // SECURITY FIX: Enhanced check for Teachers to prevent IDOR
        if (currentUserRole === 'Teacher') {
            const checkQuery = `
                SELECT ct.teacher_id 
                FROM ${TIMETABLE_TABLE} ct
                -- Join uses t.id, assuming it's the FK linked to ct.teacher_id
                JOIN teachers t ON ct.teacher_id = t.id 
                WHERE ct.id = $1 AND t.user_id = $2; 
            `;
            // Check if the slot exists AND belongs to the authenticated teacher (by user_id)
            const checkResult = await pool.query(checkQuery, [id, currentUserId]);

            if (checkResult.rowCount === 0) {
                // Return 403 if the slot doesn't exist OR the teacher doesn't own it
                return res.status(403).json({ message: 'Forbidden: You can only delete your own scheduled slots, or the slot was not found.' });
            }
        }

        // Proceed with deletion (Admin, Super Admin, or authorized Teacher)
        const deleteQuery = `DELETE FROM ${TIMETABLE_TABLE} WHERE id = $1 RETURNING id;`;
        const result = await pool.query(deleteQuery, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Timetable slot not found.' });
        }
        res.status(200).json({ message: 'Timetable slot deleted successfully.' });
    } catch (error) {
        console.error('Timetable Delete Error:', error);
        res.status(500).json({ message: 'Failed to delete timetable slot.' });
    }
});


module.exports = router;