// routes/exams.js (FINALIZED BRANCH-AWARE & SESSION-SAFE VERSION WITH PARENT ACCESS)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Role Definitions ---
const EXAM_MANAGER_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
// 🔥 FIXED: Added 'Parent' to EXAM_VIEWER_ROLES to resolve 403 Forbidden errors in logs
const EXAM_VIEWER_ROLES = ['Super Admin', 'Admin', 'Coordinator', 'Teacher', 'Student', 'Parent'];

// =======================================================================================
// 1. EXAM CRUD ROUTES
// =======================================================================================

/**
 * @route   GET /api/exams/list
 * @desc    Fetches branch-isolated exams. Super Admin sees all.
 */
router.get('/list', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    const { branch_id, role } = req.user;

    try {
        let query = `
            SELECT 
                e.id AS exam_id, e.exam_name, e.exam_type, e.exam_date, e.course_id, e.batch_id,
                e.branch_id, c.course_name, b.batch_name, b.batch_code, br.branch_name,
                (COALESCE(e.max_theory_marks, 0) + COALESCE(e.max_practical_marks, 0)) AS total_marks,
                e.max_theory_marks, e.max_practical_marks
            FROM exams e
            LEFT JOIN courses c ON e.course_id = c.id
            LEFT JOIN batches b ON e.batch_id = b.id
            LEFT JOIN branches br ON e.branch_id = br.id
            WHERE 1=1
        `;
        
        const params = [];
        // Isolation logic: Super Admin sees everything, others are restricted to their branch
        if (role !== 'Super Admin' && branch_id) {
            query += ` AND e.branch_id = $1`;
            params.push(branch_id);
        }

        query += ` ORDER BY e.exam_date DESC, c.course_name`;
        
        const result = await pool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('List Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve exam list.' });
    }
});

/**
 * @route   POST /api/exams
 * @desc    Creates a new exam entry with Branch and Session safety.
 */
router.post('/', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { branch_id: user_branch, role } = req.user;
    let {
        exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id,
        course_id, batch_id, max_theory_marks, max_practical_marks, branch_id
    } = req.body;

    // Tactical branch determination
    const finalBranchId = (role === 'Super Admin' && branch_id) ? branch_id : user_branch;

    try {
        // 🔥 SELF-HEALING SESSION: Fetch active session if frontend sends dummy data
        if (!academic_session_id || academic_session_id.includes('00000000')) {
            const sessionRes = await pool.query(
                `SELECT academic_session_id FROM academic_sessions WHERE is_active = TRUE LIMIT 1`
            );
            if (sessionRes.rows.length === 0) {
                return res.status(400).json({ message: "No active academic session found." });
            }
            academic_session_id = sessionRes.rows[0].academic_session_id;
        }

        const query = `
            INSERT INTO exams (
                exam_name, exam_type, exam_date, is_midterm_assessment, academic_session_id,
                course_id, batch_id, branch_id, max_theory_marks, max_practical_marks
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id AS exam_id, exam_name;
        `;
        
        const result = await pool.query(query, [
            exam_name, exam_type, exam_date, is_midterm_assessment || false, academic_session_id,
            course_id, batch_id, finalBranchId, max_theory_marks || 100, max_practical_marks || 0
        ]);

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Exam Creation Error:', error.message);
        res.status(500).json({ message: 'Failed to create exam.' });
    }
});

/**
 * @route   DELETE /api/exams/:id
 */
router.delete('/:id', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { branch_id, role } = req.user;
    try {
        const { id } = req.params;
        // Branch Security check
        const check = await pool.query(`SELECT branch_id FROM exams WHERE id = $1`, [id]);
        if (check.rows.length > 0 && role !== 'Super Admin' && check.rows[0].branch_id !== branch_id) {
            return res.status(403).json({ message: "Unauthorized branch access." });
        }

        await pool.query('DELETE FROM exams WHERE id = $1', [id]); 
        res.status(200).json({ message: 'Exam deleted successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to delete exam.' });
    }
});

// =======================================================================================
// 2. EXAM SCHEDULE CRUD ROUTES
// =======================================================================================

/**
 * @route   GET /api/exams/schedule/:examId
 */
router.get('/schedule/:examId', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                es.id AS schedule_id, es.subject_id, s.subject_name, s.subject_code,
                es.exam_date, es.start_time, es.end_time, es.room_number, es.max_marks
            FROM exam_schedules es
            JOIN subjects s ON es.subject_id = s.id
            WHERE es.exam_id = $1::uuid
            ORDER BY es.exam_date, es.start_time;
        `;
        const result = await pool.query(query, [req.params.examId]);
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch schedule.' });
    }
});

/**
 * @route   POST /api/exams/schedule
 */
router.post('/schedule', authenticateToken, authorize(EXAM_MANAGER_ROLES), async (req, res) => {
    const { exam_id, course_id, batch_id, subject_id, exam_date, room_number, start_time, end_time } = req.body;

    if (!exam_id || !subject_id || !exam_date) {
        return res.status(400).json({ message: 'Missing required schedule fields.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); 

        // Inherit marks and branch context from parent exam
        const examQuery = `SELECT max_theory_marks, max_practical_marks, branch_id FROM exams WHERE id = $1::uuid`;
        const examRes = await client.query(examQuery, [exam_id]);

        if (examRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Exam not found.' });
        }

        const { max_theory_marks, max_practical_marks, branch_id: examBranchId } = examRes.rows[0];
        const derived_max_marks = (max_theory_marks || 0) + (max_practical_marks || 0);
        
        const query = `
            INSERT INTO exam_schedules (
                exam_id, course_id, batch_id, subject_id, exam_date,
                room_number, start_time, end_time, max_marks, branch_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id AS schedule_id;
        `;
        const newSchedule = await client.query(query, [
            exam_id, course_id, batch_id, subject_id, exam_date,
            room_number, start_time, end_time, derived_max_marks, examBranchId 
        ]);
        
        await client.query('COMMIT'); 
        res.status(201).json(newSchedule.rows[0]);

    } catch (error) {
        if (client) await client.query('ROLLBACK'); 
        console.error('Schedule Creation Error:', error.message);
        res.status(500).json({ message: 'Failed to create schedule entry.' });
    } finally {
        if (client) client.release();
    }
});

/**
 * @route   GET /api/exams/student/:sid/skills
 * @desc    Fetches radar data for student competency charts
 * @access  Private (Authorized for Viewer Roles to support Parent Dashboard)
 */
router.get('/student/:sid/skills', authenticateToken, authorize(EXAM_VIEWER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT s.subject_name as label, COALESCE(AVG(m.marks_obtained_theory + m.marks_obtained_practical), 0) as value
            FROM subjects s
            JOIN marks m ON s.id = m.subject_id
            WHERE m.student_id = $1::uuid
            GROUP BY s.subject_name LIMIT 6;
        `;
        const { rows } = await pool.query(query, [req.params.sid]);
        res.json({
            labels: rows.length ? rows.map(r => r.label) : ['Logic', 'Theory', 'Practical', 'Research', 'Viva', 'Ethics'],
            values: rows.length ? rows.map(r => Math.round(parseFloat(r.value))) : [0, 0, 0, 0, 0, 0]
        });
    } catch (err) {
        console.error('Skills Fetch Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch competency data' });
    }
});

module.exports = router;