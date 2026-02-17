const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

const TIMETABLE_TABLE = 'class_timetable';

// =========================================================
// 1. Teacher's Personal View
// =========================================================
router.get('/teacher/me', authenticateToken, authorize(['Teacher', 'Admin', 'Super Admin']), async (req, res) => {
    const userId = req.user.id; 

    try {
        const teacherProfile = await pool.query(
            'SELECT id FROM teachers WHERE user_id = $1 LIMIT 1', 
            [userId]
        );
        
        if (teacherProfile.rowCount === 0) {
            return res.status(404).json({ message: 'Teacher profile not linked to this user account.' });
        }

        const teacherId = teacherProfile.rows[0].id;

        const result = await pool.query(`
            SELECT ct.*, s.subject_name, c.course_name, b.batch_name
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            JOIN courses c ON ct.course_id = c.id
            JOIN batches b ON ct.batch_id = b.id
            WHERE ct.teacher_id = $1 AND ct.is_active = TRUE
            ORDER BY 
                CASE day_of_week 
                    WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 
                    WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 
                END, ct.start_time ASC;
        `, [teacherId]);
        
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Teacher Timetable Fetch Error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// =========================================================
// 2. Student's Personal View
// =========================================================
router.get('/student/me', authenticateToken, async (req, res) => {
    try {
        const student = await pool.query(
            'SELECT course_id, batch_id FROM students WHERE user_id = $1 LIMIT 1', 
            [req.user.id]
        );
        
        if (student.rowCount === 0) {
            return res.status(404).json({ message: 'Student profile not linked to this account.' });
        }

        const { course_id, batch_id } = student.rows[0];

        const result = await pool.query(`
            SELECT ct.*, s.subject_name, t.full_name AS teacher_name
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            LEFT JOIN teachers t ON ct.teacher_id = t.id
            WHERE ct.course_id = $1 AND ct.batch_id = $2 AND ct.is_active = TRUE
            ORDER BY 
                CASE day_of_week 
                    WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 
                    WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 
                END, ct.start_time ASC;
        `, [course_id, batch_id]);
        
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Student Timetable Error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// =========================================================
// 3. Admin View (Batch-wise)
// =========================================================
router.get('/:courseId/:batchId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ct.*, s.subject_name, COALESCE(t.full_name, u.username) AS teacher_name
            FROM ${TIMETABLE_TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            LEFT JOIN teachers t ON ct.teacher_id = t.id
            LEFT JOIN users u ON t.user_id = u.id
            WHERE ct.course_id = $1 AND ct.batch_id = $2 AND ct.is_active = TRUE
            ORDER BY ct.start_time ASC;
        `, [req.params.courseId, req.params.batchId]);
        
        const grouped = result.rows.reduce((acc, slot) => {
            if (!acc[slot.day_of_week]) acc[slot.day_of_week] = [];
            acc[slot.day_of_week].push(slot);
            return acc;
        }, {});
        res.status(200).json(grouped);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving batch timetable.' });
    }
});

// =========================================================
// 4. Create/Save New Timetable Slot (Admin Only) - FIXED
// =========================================================
router.post('/', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { 
        course_id, batch_id, subject_id, teacher_id, 
        day_of_week, start_time, end_time, room_number 
    } = req.body;

    // ১. সার্ভার লগের এরর (UUID: "undefined") প্রতিরোধ করার জন্য কড়া ভ্যালিডেশন
    const idsToCheck = { course_id, batch_id, subject_id, teacher_id };
    for (const [key, value] of Object.entries(idsToCheck)) {
        if (!value || value === "undefined" || value === "") {
            return res.status(400).json({ message: `ত্রুটি: ${key} নির্বাচন করা হয়নি বা সঠিক নয়।` });
        }
    }

    if (!day_of_week || !start_time || !end_time) {
        return res.status(400).json({ message: 'দিন এবং সময় সম্পর্কিত তথ্যগুলো পূরণ করুন।' });
    }

    try {
        const query = `
            INSERT INTO ${TIMETABLE_TABLE} 
            (course_id, batch_id, subject_id, teacher_id, day_of_week, start_time, end_time, room_number, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
            RETURNING *;
        `;
        const values = [course_id, batch_id, subject_id, teacher_id, day_of_week, start_time, end_time, room_number || null];
        const result = await pool.query(query, values);

        res.status(201).json({ 
            message: 'টাইমটেবিল সফলভাবে সেভ করা হয়েছে।', 
            slot: result.rows[0] 
        });
    } catch (error) {
        console.error('Insert Timetable Error:', error.message);
        // ডাটাবেস লেভেলের সিনট্যাক্স এরর হ্যান্ডলিং
        if (error.code === '22P02') {
            return res.status(400).json({ message: 'ভুল ডাটা ফরম্যাট: নিশ্চিত করুন সব ড্রপডাউন সিলেক্ট করা হয়েছে।' });
        }
        res.status(500).json({ message: 'ডাটাবেসে টাইমটেবিল সেভ করতে ব্যর্থ হয়েছে।' });
    }
});

// =========================================================
// 5. Delete Timetable Slot (Admin Only)
// =========================================================
router.delete('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const slotId = req.params.id;

    try {
        const result = await pool.query(
            `DELETE FROM ${TIMETABLE_TABLE} WHERE id = $1 RETURNING *`, 
            [slotId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'এই ক্লাস স্লটটি খুঁজে পাওয়া যায়নি।' });
        }

        res.status(200).json({ message: 'ক্লাস স্লটটি সফলভাবে মুছে ফেলা হয়েছে।' });
    } catch (error) {
        console.error('Delete Timetable Error:', error);
        res.status(500).json({ message: 'সার্ভার ত্রুটি: স্লট মুছতে ব্যর্থ হয়েছে।' });
    }
});

// =========================================================
// 4. Create New Timetable Slot with Conflict Alert
// =========================================================
router.post('/', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { 
        course_id, batch_id, subject_id, teacher_id, 
        day_of_week, start_time, end_time, room_number 
    } = req.body;

    // Basic Validation
    if (!course_id || !batch_id || !subject_id || !teacher_id || !day_of_week || !start_time || !end_time) {
        return res.status(400).json({ message: 'All required fields must be filled.' });
    }

    try {
        // --- CONFLICT CHECK LOGIC ---
        // Check if the teacher is already assigned to ANY room during this time on this day
        const conflictCheck = await pool.query(`
            SELECT ct.*, s.subject_name, b.batch_name 
            FROM class_timetable ct
            JOIN subjects s ON ct.subject_id = s.id
            JOIN batches b ON ct.batch_id = b.id
            WHERE ct.teacher_id = $1 
            AND ct.day_of_week = $2 
            AND ct.is_active = TRUE
            AND (
                (ct.start_time, ct.end_time) OVERLAPS ($3::time, $4::time)
            )
        `, [teacher_id, day_of_week, start_time, end_time]);

        if (conflictCheck.rowCount > 0) {
            const conflict = conflictCheck.rows[0];
            return res.status(409).json({ 
                message: `Teacher Conflict! This faculty is already taking ${conflict.subject_name} for ${conflict.batch_name} from ${conflict.start_time} to ${conflict.end_time}.`,
                conflictDetails: conflict
            });
        }

        // No conflict found, proceed with insertion
        const query = `
            INSERT INTO class_timetable 
            (course_id, batch_id, subject_id, teacher_id, day_of_week, start_time, end_time, room_number, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
            RETURNING *;
        `;
        const values = [course_id, batch_id, subject_id, teacher_id, day_of_week, start_time, end_time, room_number];
        const result = await pool.query(query, values);

        res.status(201).json({ message: 'Slot saved successfully!', slot: result.rows[0] });

    } catch (error) {
        console.error('Insert Timetable Error:', error);
        res.status(500).json({ message: 'Database error while saving slot.' });
    }
});

module.exports = router;