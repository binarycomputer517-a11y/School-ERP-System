// routes/timetable.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

const TIMETABLE_TABLE = 'class_timetable';

// --- Day Mapping for Database Insertion/Sorting ---
const daysMap = {
    'Monday': 1,
    'Tuesday': 2,
    'Wednesday': 3,
    'Thursday': 4,
    'Friday': 5,
    'Saturday': 6,
    'Sunday': 7
};

// --- Role Definitions ---
const MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher'];
const VIEW_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Student', 'Parent'];


// =========================================================
// Helper: Get Day as Number
// =========================================================

function getDayAsNumber(dayStringOrNumber) {
    if (typeof dayStringOrNumber === 'number' && dayStringOrNumber >= 1 && dayStringOrNumber <= 7) {
        return dayStringOrNumber;
    }
    // Convert string day name to integer (CRITICAL FIX)
    return daysMap[dayStringOrNumber] || null;
}


// =========================================================
// 2. Student View Endpoint (Simplified)
// =========================================================

/**
 * @route   GET /api/timetable/student/me
 * @desc    Get the timetable for the logged-in student.
 * @access  Private (Student, Admin, Parent)
 */
router.get('/student/me', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const studentUserId = req.user.id; 

    try {
        // 1. Get student's course and batch using the UUID from the JWT
        const studentInfoQuery = `
            SELECT course_id, batch_id 
            FROM students 
            WHERE user_id = $1 OR id = $1
            LIMIT 1
        `;
        const studentInfoResult = await pool.query(studentInfoQuery, [studentUserId]);
        
        if (studentInfoResult.rowCount === 0) {
            return res.status(404).json({ message: 'Student profile not found or user association is missing.' });
        }
        const { course_id, batch_id } = studentInfoResult.rows[0];
        
        // 2. Fetch timetable using the corrected JOIN logic
        const detailedQuery = `
            SELECT 
                ct.id, ct.day_of_week, ct.start_time, ct.end_time, ct.room_number,
                s.subject_name, s.subject_code,
                COALESCE(t.full_name, u.username) AS teacher_name,
                t.teacher_id AS teacher_reference_id -- Use teacher_id as reference
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            LEFT JOIN teachers t ON ct.teacher_id = t.teacher_id  -- CRITICAL FIX: Join on teacher_id
            LEFT JOIN users u ON t.user_id = u.id                 -- Fallback for username/user_id
            WHERE ct.course_id = $1 AND ct.batch_id = $2 AND ct.is_active = TRUE
            ORDER BY ct.day_of_week, ct.start_time ASC; -- Order by number, assuming DB fix applied
        `;
        const result = await pool.query(detailedQuery, [course_id, batch_id]);
        
        // Return the rows array directly
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Student Timetable Fetch Error:', error);
        res.status(500).json({ message: 'Internal Server Error: Failed to retrieve student timetable.' });
    }
});


// =========================================================
// 1. CRUD Routes (Admin/Teacher) - Remaining Routes
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

    // CRITICAL FIX: Convert day_of_week string (e.g., "Tuesday") to integer (2)
    const dayAsNumber = getDayAsNumber(day_of_week);
    if (dayAsNumber === null) {
        return res.status(400).json({ message: 'Invalid day_of_week value. Must be a valid day name (e.g., "Monday") or number (1-7).' });
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
            course_id, batch_id, subject_id, teacher_id || null, dayAsNumber, // <--- CHANGED: Use dayAsNumber
            start_time, end_time, room_number || null
        ];
        
        const result = await pool.query(query, values);
        res.status(201).json({ message: 'Timetable slot created successfully', id: result.rows[0].id });

    } catch (error) {
        console.error('Timetable Creation Error:', error);
        
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Schedule conflict: This subject is already scheduled at this time for this batch, or the time slot is already taken.' });
        }
        // Handle the data type error if it somehow persists
        if (error.code === '22P02') { 
            return res.status(400).json({ message: 'Data format error. Check day of week value.' });
        }
        res.status(500).json({ message: 'Failed to create timetable slot due to server error.' });
    }
});


/**
 * @route   GET /api/timetable/:courseId/:batchId
 * @desc    Get the full weekly timetable for a specific Course and Batch.
 * @access  Private (Super Admin, Admin, Teacher, Student)
 */
router.get('/:courseId/:batchId', authenticateToken, authorize(['Super Admin', 'Admin', 'Teacher', 'Student']), async (req, res) => {
    const { courseId, batchId } = req.params;

    try {
        const query = `
            SELECT 
                ct.id, ct.day_of_week, ct.start_time, ct.end_time, ct.room_number,
                s.subject_name, s.subject_code,
                COALESCE(t.full_name, u.username) AS teacher_name,  -- COALESCE সহ
                t.teacher_id AS teacher_reference_id                 -- Use teacher_id as reference
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            LEFT JOIN teachers t ON ct.teacher_id = t.teacher_id  -- CRITICAL FIX: Join on teacher_id
            LEFT JOIN users u ON t.user_id = u.id                -- Fallback for username/user_id
            WHERE ct.course_id = $1 AND ct.batch_id = $2 AND ct.is_active = TRUE
            ORDER BY ct.day_of_week, ct.start_time ASC;
        `;
        const result = await pool.query(query, [courseId, batchId]);
        
        // Group the results by day for cleaner client processing
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

    try {
        // Add security check for Teachers before deletion
        if (currentUserRole === 'Teacher') {
            const checkQuery = `SELECT teacher_id FROM ${TIMETABLE_TABLE} WHERE id = $1;`;
            const checkResult = await pool.query(checkQuery, [id]);

            if (checkResult.rowCount === 0) {
                return res.status(404).json({ message: 'Timetable slot not found.' });
            }

            const slotTeacherId = checkResult.rows[0].teacher_id;
            
            // Only allow deletion if the teacher scheduled the slot (Admin/Super Admin bypasses this)
            if (slotTeacherId !== currentUserId) {
                return res.status(403).json({ message: 'Forbidden: You can only delete your own scheduled slots.' });
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