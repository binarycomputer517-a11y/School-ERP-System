// routes/timetable.js (FINALIZED PRODUCTION VERSION - ACADEMIC TIMETABLE)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// 🛑 Target the verified academic table name
const TABLE = 'class_timetable';

// =========================================================
// 🚀 NEW: Fetch Timetable for Student/Parent View
// Handles the "me" alias and resolves Batch IDs automatically.
// Target: GET /api/timetable/student/:id
// =========================================================
router.get('/student/:id', authenticateToken, async (req, res) => {
    let targetId = req.params.id;

    try {
        // 1. Resolve "me" to the logged-in user's UUID
        if (targetId === 'me') {
            targetId = req.user.id;
        }

        // 2. UUID Format Validation (Prevents 500 errors from invalid strings)
        const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        if (!uuidRegex.test(targetId)) {
            return res.status(400).json({ message: "Invalid Identifier Format. Expected UUID." });
        }

        // 3. Tactical Query: Find timetable based on the Student's Batch
        const query = `
            SELECT 
                ct.id, 
                ct.day_of_week, 
                ct.start_time::text, 
                ct.end_time::text, 
                ct.room_number,
                s.subject_name, 
                tea.full_name as teacher_name
            FROM ${TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            JOIN teachers tea ON ct.teacher_id = tea.id
            JOIN students stu ON ct.batch_id = stu.batch_id
            WHERE (stu.user_id = $1 OR stu.student_id = $1)
            AND ct.is_active = TRUE
            ORDER BY 
                CASE ct.day_of_week 
                    WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 
                    WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 
                    WHEN 'Sunday' THEN 7 
                END, ct.start_time;
        `;

        const result = await pool.query(query, [targetId]);

        // Formats data into Day-based arrays for the frontend grid
        const formattedData = result.rows.reduce((acc, row) => {
            if (!acc[row.day_of_week]) acc[row.day_of_week] = [];
            acc[row.day_of_week].push(row);
            return acc;
        }, {});

        res.status(200).json(formattedData);
    } catch (err) {
        console.error("❌ Neural Link Timetable Error:", err.message);
        res.status(500).json({ error: "Failed to resolve student timetable." });
    }
});

// =========================================================
// 1. Fetch Timetable (Batch-wise & Branch-isolated)
// =========================================================
router.get('/:courseId/:batchId', authenticateToken, async (req, res) => {
    const { batchId } = req.params;
    // Get branch context from query (Super Admin context) or token (Regular Admin)
    const branchId = req.query.branch_id || req.user.branch_id;

    // Strict validation to prevent UUID syntax errors in SQL
    if (!branchId || branchId === 'null' || branchId === 'undefined') {
        return res.status(400).json({ message: "Branch context is missing. Please select a branch." });
    }

    try {
        const query = `
            SELECT 
                ct.id, 
                ct.day_of_week, 
                ct.start_time::text, 
                ct.end_time::text, 
                ct.room_number,
                s.subject_name, 
                tea.full_name as teacher_name
            FROM ${TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            JOIN teachers tea ON ct.teacher_id = tea.id -- Corrected join to 'teachers'
            WHERE ct.batch_id = $1 AND ct.branch_id = $2 AND ct.is_active = TRUE
            ORDER BY 
                CASE ct.day_of_week 
                    WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 
                    WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 
                    WHEN 'Sunday' THEN 7 
                END, ct.start_time;
        `;
        const result = await pool.query(query, [batchId, branchId]);

        // Formats data into Day-based arrays for the frontend grid
        const formattedData = result.rows.reduce((acc, row) => {
            if (!acc[row.day_of_week]) acc[row.day_of_week] = [];
            acc[row.day_of_week].push(row);
            return acc;
        }, {});

        res.status(200).json(formattedData);
    } catch (err) {
        console.error("Timetable Fetch Error:", err.message);
        res.status(500).json({ error: "Internal server error while fetching timetable." });
    }
});

// =========================================================
// 2. Create New Slot (Branch Validated & Conflict Protected)
// =========================================================
router.post('/', authenticateToken, authorize(['Super Admin', 'Admin']), async (req, res) => {
    const { 
        branch_id, course_id, batch_id, subject_id, teacher_id, 
        day_of_week, start_time, end_time, room_number 
    } = req.body;

    // 🔥 PREVENT 400 ERRORS: Explicitly check for 'undefined' or empty strings for all UUIDs
    const requiredFields = { branch_id, course_id, batch_id, subject_id, teacher_id, day_of_week, start_time, end_time };
    
    for (const [key, value] of Object.entries(requiredFields)) {
        if (!value || value === 'undefined' || value === 'null' || value === '') {
            return res.status(400).json({ message: `Validation Error: ${key.replace('_', ' ')} is missing or invalid.` });
        }
    }

    try {
        // --- 1. Teacher Conflict Check (Using Postgres OVERLAPS for precision) ---
        const conflictCheck = await pool.query(`
            SELECT ct.id, s.subject_name 
            FROM ${TABLE} ct
            JOIN subjects s ON ct.subject_id = s.id
            WHERE ct.teacher_id = $1 
            AND ct.day_of_week = $2 
            AND ct.branch_id = $3
            AND ct.is_active = TRUE
            AND (ct.start_time, ct.end_time) OVERLAPS ($4::time, $5::time)
        `, [teacher_id, day_of_week, branch_id, start_time, end_time]);

        if (conflictCheck.rowCount > 0) {
            return res.status(409).json({ 
                message: `Teacher Conflict! Faculty is already assigned to ${conflictCheck.rows[0].subject_name} at this time in this branch.` 
            });
        }

        // --- 2. Insert record (Matches class_timetable columns exactly) ---
        const query = `
            INSERT INTO ${TABLE} (
                branch_id, course_id, batch_id, subject_id, teacher_id, 
                day_of_week, start_time, end_time, room_number, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
            RETURNING id;
        `;

        const values = [
            branch_id, course_id, batch_id, subject_id, teacher_id, 
            day_of_week, start_time, end_time, room_number || null
        ];
        
        await pool.query(query, values);

        res.status(201).json({ message: "Timetable slot successfully created!" });

    } catch (err) {
        console.error("Timetable Save Error:", err.message);
        if (err.code === '23505') {
            return res.status(409).json({ message: "Slot conflict: This time/batch combo already exists." });
        }
        res.status(500).json({ message: "Database rejected the request. Check your dropdown selections." });
    }
});

// =========================================================
// 3. Delete Slot (Branch Protected)
// =========================================================
router.delete('/:id', authenticateToken, authorize(['Super Admin', 'Admin']), async (req, res) => {
    const { branch_id, role } = req.user;
    try {
        // Security check: Branch Admins can only delete slots from their own campus
        const query = (role === 'Super Admin') 
            ? `DELETE FROM ${TABLE} WHERE id = $1 RETURNING *`
            : `DELETE FROM ${TABLE} WHERE id = $1 AND branch_id = $2 RETURNING *`;
        
        const params = (role === 'Super Admin') ? [req.params.id] : [req.params.id, branch_id];
        const result = await pool.query(query, params);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Slot not found or you don't have permission to delete it." });
        }
        
        res.status(200).json({ message: "Slot deleted successfully." });
    } catch (err) {
        console.error("Delete Error:", err.message);
        res.status(500).json({ message: "Delete operation failed." });
    }
});

module.exports = router;