const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// =================================================================
// CONFIGURATION: ROLE CONSTANTS
// =================================================================
const MARKING_ROLES = ['super admin', 'admin', 'teacher', 'apiuser'];
const ROSTER_VIEW_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'apiuser', 'hr', 'staff'];
const REPORT_VIEW_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'hr', 'finance'];
const USER_REPORT_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'student', 'employee'];

// =================================================================
// 1. MARKING ATTENDANCE (UPSERT Logic - Fixed 500 Error)
// =================================================================
router.post('/mark', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { batch_id, subject_id, attendance_date, records, mark_method } = req.body;
    const marked_by_id = req.user.id; 

    if (!attendance_date || !records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ message: 'Invalid payload: Date and records are required.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        for (const record of records) {
            const { user_id, status, remarks } = record;
            if (!user_id || !status) continue;

            // প্রোফাইল খুঁজে বের করা (স্টুডেন্ট নাকি স্টাফ)
            const profileRes = await client.query(`
                SELECT student_id AS profile_id, 'student' AS role FROM students WHERE user_id = $1::uuid
                UNION ALL
                SELECT id AS profile_id, 'staff' AS role FROM teachers WHERE user_id = $1::uuid
                LIMIT 1
            `, [user_id]);

            const profile = profileRes.rows[0];
            if (!profile) continue;

            const isStudent = profile.role === 'student';
            
            // ডাটাবেস ইনডেক্সের সাথে হুবহু মিল রেখে conflict target নির্ধারণ
            const conflictTarget = isStudent 
                ? "(student_id, attendance_date, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))"
                : "(staff_id, attendance_date)";

            const upsertQuery = `
                INSERT INTO attendance (user_id, student_id, staff_id, batch_id, subject_id, attendance_date, status, remarks, marked_by, mark_method)
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10)
                ON CONFLICT ${conflictTarget} 
                DO UPDATE SET 
                    status = EXCLUDED.status, 
                    remarks = EXCLUDED.remarks, 
                    marked_by = EXCLUDED.marked_by, 
                    updated_at = CURRENT_TIMESTAMP;
            `;
            
            await client.query(upsertQuery, [
                user_id, 
                isStudent ? profile.profile_id : null, 
                isStudent ? null : profile.profile_id,
                batch_id || null, 
                subject_id || null, 
                attendance_date, 
                status, 
                remarks || null, 
                marked_by_id, 
                mark_method || 'manual'
            ]);
        }
        await client.query('COMMIT');
        res.status(201).json({ success: true, message: 'Attendance processed successfully.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Attendance Mark Error Details:', err.message);
        res.status(500).json({ error: 'Database error: ' + err.message });
    } finally { 
        if (client) client.release(); 
    }
});



// =================================================================
// 2. CONSOLIDATED MONTHLY REPORT (Heatmap Data)
// =================================================================
router.get('/report/consolidated', authenticateToken, authorize(REPORT_VIEW_ROLES), async (req, res) => {
    const { role, month, year, optional_filter_id } = req.query;
    try {
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 0).toISOString().split('T')[0];
        
        let userQuery = `
            SELECT u.id AS user_id, COALESCE(s.first_name || ' ' || s.last_name, t.full_name) AS full_name
            FROM users u
            LEFT JOIN students s ON u.id = s.user_id AND LOWER(u.role::text) = 'student'
            LEFT JOIN teachers t ON u.id = t.user_id AND LOWER(u.role::text) = 'teacher'
            WHERE LOWER(u.role::text) = $1`;

        const params = [role.toLowerCase()];
        if (optional_filter_id) {
            params.push(optional_filter_id);
            userQuery += (role === 'student' ? ` AND s.batch_id = $2::uuid` : ` AND t.department_id = $2::uuid`);
        }

        const { rows: users } = await pool.query(userQuery, params);
        if (users.length === 0) return res.json({ users: [] });

        const userIds = users.map(u => u.user_id);
        const attRes = await pool.query(`SELECT user_id, attendance_date, status FROM attendance WHERE user_id = ANY($1) AND attendance_date BETWEEN $2 AND $3`, [userIds, startDate, endDate]);

        res.json({ users: users.map(u => ({ ...u, attendance: attRes.rows.filter(r => r.user_id === u.user_id) })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});



// =================================================================
// 3. UNIVERSAL ROSTER VIEW (Live Marking List)
// =================================================================
router.get('/report/roster/universal', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    const { role, filter_id, subject_id, date } = req.query;
    try {
        let query = role === 'student' 
            ? `SELECT u.id::text AS user_id, (s.first_name || ' ' || s.last_name) AS full_name, s.enrollment_no AS user_identifier, s.student_id AS profile_pk_id, COALESCE(a.status, 'unmarked') AS status, a.remarks
               FROM students s JOIN users u ON s.user_id = u.id LEFT JOIN attendance a ON s.student_id = a.student_id AND a.attendance_date = $2 ${subject_id ? "AND a.subject_id = $3::uuid" : ""} WHERE s.batch_id = $1::uuid`
            : `SELECT u.id::text AS user_id, t.full_name, t.employee_id AS user_identifier, t.id AS profile_pk_id, COALESCE(a.status, 'unmarked') AS status, a.remarks
               FROM teachers t JOIN users u ON t.user_id = u.id LEFT JOIN attendance a ON t.id = a.staff_id AND a.attendance_date = $2 WHERE t.department_id = $1::uuid`;
        
        const params = (subject_id && role === 'student') ? [filter_id, date, subject_id] : [filter_id, date];
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =================================================================
// 4. INDIVIDUAL USER REPORT (Detailed History)
// =================================================================
router.get('/report/user/:userId', authenticateToken, authorize(USER_REPORT_ROLES), async (req, res) => {
    const { subject_id, start_date, end_date } = req.query;
    if (req.user.role.toLowerCase() === 'student' && req.user.id !== req.params.userId) return res.status(403).json({ message: 'Unauthorized' });

    try {
        let query = `SELECT a.*, COALESCE(s.subject_name, 'General') as subject_name FROM attendance a LEFT JOIN subjects s ON a.subject_id = s.id WHERE a.user_id = $1::uuid`;
        const params = [req.params.userId];
        if (subject_id && !['all', '', 'null'].includes(subject_id)) { params.push(subject_id); query += ` AND a.subject_id = $${params.length}::uuid`; }
        if (start_date) { params.push(start_date); query += ` AND a.attendance_date >= $${params.length}`; }
        query += ' ORDER BY a.attendance_date DESC';
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =================================================================
// 5. UPDATE & DELETE
// =================================================================
router.put('/:id', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    try {
        const { rows } = await pool.query(`UPDATE attendance SET status = $1, remarks = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3::uuid RETURNING *`, [req.body.status, req.body.remarks, req.params.id]);
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', authenticateToken, authorize(['super admin', 'admin']), async (req, res) => {
    try {
        await pool.query(`DELETE FROM attendance WHERE id = $1::uuid`, [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =================================================================
// 6. FILTER ENDPOINTS
// =================================================================
router.get('/batches', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id, batch_name AS name FROM batches ORDER BY name`);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/departments', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id, department_name AS name FROM hr_departments ORDER BY name`);
        res.json(rows);
    } catch (err) {
        const fallback = await pool.query(`SELECT id, branch_name AS name FROM branches ORDER BY name`);
        res.json(fallback.rows);
    }
});

router.get('/subjects', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id, subject_name FROM subjects ORDER BY subject_name`);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =================================================================
// 7. DASHBOARD SUMMARY
// =================================================================
router.get('/student/:sid/summary', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'present') as present, COUNT(*) as total FROM attendance WHERE student_id = $1::uuid OR user_id = $1::uuid`, [req.params.sid]);
        const { present, total } = rows[0];
        const pct = total > 0 ? Math.round((present / total) * 100) : 0;
        res.json({ percentage: pct, status: pct >= 75 ? 'Good' : 'Shortage' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =================================================================
// 8. ADVANCED ANALYTICS (Admin Tools)
// =================================================================
router.get('/analytics/shortage', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    try {
        const query = `
            SELECT s.student_id, (s.first_name || ' ' || s.last_name) as name, 
            ROUND((COUNT(a.id) FILTER (WHERE a.status='present')::numeric / NULLIF(COUNT(a.id), 0)::numeric) * 100, 2) as pct 
            FROM attendance a 
            JOIN students s ON a.student_id = s.student_id 
            GROUP BY s.student_id 
            HAVING (COUNT(a.id) FILTER (WHERE a.status='present')::numeric / NULLIF(COUNT(a.id), 0)::numeric) * 100 < 75`;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});



module.exports = router;