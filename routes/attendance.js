/**
 * js/routes/attendance.js
 * -----------------------------
 * Comprehensive Attendance Management System.
 * Supports multi-branch marking, real-time automated email alerts, 
 * and advanced reporting for Students, Teachers, and Parents.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 
const { sendAbsentEmail } = require('../services/emailService');

// =================================================================
// CONFIGURATION: ACCESS CONTROL CONSTANTS
// =================================================================
const MARKING_ROLES = ['super admin', 'admin', 'teacher', 'apiuser'];
const ROSTER_VIEW_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'apiuser', 'hr', 'staff'];
const REPORT_VIEW_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'hr', 'finance'];

// 🛡️ ROLE INTEGRATION: Authorized Parent access for student reporting
const USER_REPORT_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'student', 'employee', 'parent'];

// =================================================================
// 1. MARKING ATTENDANCE (Multi-Branch & Real-time Alerts)
// =================================================================
router.post('/mark', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { batch_id, subject_id, attendance_date, records, mark_method, branch_id } = req.body;
    const marked_by_id = req.user.id; 

    if (!attendance_date || !records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ message: 'Invalid payload: Date and student records are required.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        for (const record of records) {
            const { user_id, status, remarks } = record;
            if (!user_id || !status) continue;

            // Resolve Profile Identity (Student vs Staff)
            const profileRes = await client.query(`
                SELECT student_id AS profile_id, 'student' AS role FROM students WHERE user_id = $1::uuid
                UNION ALL
                SELECT id AS profile_id, 'staff' AS role FROM teachers WHERE user_id = $1::uuid
                LIMIT 1
            `, [user_id]);

            const profile = profileRes.rows[0];
            if (!profile) continue;

            const isStudent = profile.role === 'student';
            
            // Define Unique Conflict Targets for UPSERT logic
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
                status.toLowerCase(), // Normalize for database consistency
                remarks || null, 
                marked_by_id, 
                mark_method || 'manual'
            ]);

            // 🔥 AUTOMATED ASYNC EMAIL DISPATCH (Non-blocking)
            if (isStudent && status.toLowerCase() === 'absent') {
                setImmediate(async () => {
                    try {
                        const studentData = await pool.query(
                            `SELECT (first_name || ' ' || last_name) as name, 
                             COALESCE(parent_email, guardian_email) as contact_email 
                             FROM students WHERE user_id = $1`, [user_id]
                        );
                        if (studentData.rows.length > 0 && studentData.rows[0].contact_email) {
                            await sendAbsentEmail(
                                studentData.rows[0].contact_email, 
                                studentData.rows[0].name, 
                                attendance_date
                            );
                        }
                    } catch (e) { console.error("Automated Alert Dispatch Failure:", e.message); }
                });
            }
        }
        await client.query('COMMIT');
        res.status(201).json({ success: true, message: 'Attendance records synchronized and alerts broadcasted.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        res.status(500).json({ error: 'System Registry Error: ' + err.message });
    } finally { 
        if (client) client.release(); 
    }
});

// =================================================================
// 2. CONSOLIDATED MONTHLY REPORTING
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
        const attRes = await pool.query(`
            SELECT user_id, attendance_date, status 
            FROM attendance 
            WHERE user_id = ANY($1) AND attendance_date BETWEEN $2 AND $3
        `, [userIds, startDate, endDate]);

        res.json({ users: users.map(u => ({ ...u, attendance: attRes.rows.filter(r => r.user_id === u.user_id) })) });
    } catch (err) { res.status(500).json({ error: 'Monthly report generation failed: ' + err.message }); }
});

// =================================================================
// 3. UNIVERSAL ROSTER VIEW (Classroom Monitoring)
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
    } catch (err) { res.status(500).json({ error: 'Roster synchronization failure: ' + err.message }); }
});

// =================================================================
// 4. INDIVIDUAL TELEMETRY REPORT (Parent & Student HUD)
// =================================================================
router.get('/report/user/:userId', authenticateToken, authorize(USER_REPORT_ROLES), async (req, res) => {
    const { subject_id, start_date, end_date } = req.query;
    const requestedId = req.params.userId === 'me' ? req.user.id : req.params.userId;

    // Security Guard: Prevent unauthorized access to cross-user telemetry
    if (req.user.role.toLowerCase() === 'student' && req.user.id !== requestedId) {
        return res.status(403).json({ message: 'Security Alert: Access to external telemetry denied.' });
    }

    try {
        let query = `
            SELECT a.*, COALESCE(s.subject_name, 'General Academic') as subject_name 
            FROM attendance a 
            LEFT JOIN subjects s ON a.subject_id = s.id 
            WHERE (a.user_id = $1::uuid OR a.student_id = $1::uuid)`;
        
        const params = [requestedId];
        let pIndex = 2;

        if (subject_id && !['all', '', 'null'].includes(subject_id)) { 
            query += ` AND a.subject_id = $${pIndex++}::uuid`; 
            params.push(subject_id);
        }
        if (start_date) { 
            query += ` AND a.attendance_date >= $${pIndex++}`; 
            params.push(start_date);
        }
        if (end_date) {
            query += ` AND a.attendance_date <= $${pIndex++}`;
            params.push(end_date);
        }

        query += ' ORDER BY a.attendance_date DESC';
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Telemetry retrieval failure: ' + err.message }); }
});

// =================================================================
// 5. REGISTRY UPDATES (Administrative Maintenance)
// =================================================================
router.put('/:id', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE attendance SET status = $1, remarks = $2, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $3::uuid RETURNING *`, 
            [req.body.status, req.body.remarks, req.params.id]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Registry update failure: ' + err.message }); }
});

router.delete('/:id', authenticateToken, authorize(['super admin', 'admin']), async (req, res) => {
    try {
        await pool.query(`DELETE FROM attendance WHERE id = $1::uuid`, [req.params.id]);
        res.json({ message: 'Log successfully removed from neural database.' });
    } catch (err) { res.status(500).json({ error: 'Registry deletion failure: ' + err.message }); }
});

// =================================================================
// 6. FILTER METADATA ENDPOINTS
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
// 7. DASHBOARD SUMMARY (Parent/Student HUD Synchronization)
// =================================================================
router.get('/student/:sid/summary', authenticateToken, authorize(USER_REPORT_ROLES), async (req, res) => {
    try {
        const targetSid = req.params.sid === 'me' ? req.user.id : req.params.sid;

        const summaryQuery = `
            SELECT 
                COUNT(*) FILTER (WHERE LOWER(status) = 'present') as present, 
                COUNT(*) FILTER (WHERE LOWER(status) = 'absent') as absent,
                COUNT(*) FILTER (WHERE LOWER(status) = 'late') as late,
                COUNT(*) as total 
            FROM attendance 
            WHERE student_id = $1::uuid OR user_id = $1::uuid`;
            
        const { rows } = await pool.query(summaryQuery, [targetSid]);
        const { present, absent, late, total } = rows[0];
        
        // Late counts as 0.5 presence per institutional metrics
        const pct = total > 0 ? Math.round(((parseInt(present) + (parseInt(late) * 0.5)) / total) * 100) : 0;
        
        res.json({ 
            percentage: pct, 
            present: parseInt(present),
            absent: parseInt(absent),
            late: parseInt(late),
            total: parseInt(total),
            status: pct >= 75 ? 'Optimal' : 'Shortage' 
        });
    } catch (err) { res.status(500).json({ error: 'Dashboard synchronization failure: ' + err.message }); }
});

// =================================================================
// 8. ADVANCED ACADEMIC ANALYTICS
// =================================================================
router.get('/analytics/shortage', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    try {
        const query = `
            SELECT s.student_id, (s.first_name || ' ' || s.last_name) as name, 
            ROUND((COUNT(a.id) FILTER (WHERE LOWER(a.status)='present')::numeric / NULLIF(COUNT(a.id), 0)::numeric) * 100, 2) as pct 
            FROM attendance a 
            JOIN students s ON a.student_id = s.student_id 
            GROUP BY s.student_id 
            HAVING (COUNT(a.id) FILTER (WHERE LOWER(a.status)='present')::numeric / NULLIF(COUNT(a.id), 0)::numeric) * 100 < 75`;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Analytical data processing failed: ' + err.message }); }
});

// Real-time Presence Telemetry
router.get('/stats/:id', authenticateToken, authorize(['student', 'parent', 'admin', 'teacher']), async (req, res) => {
    try {
        const targetId = req.params.id === 'me' ? req.user.id : req.params.id;
        const query = `
            SELECT ROUND((COUNT(CASE WHEN LOWER(status) = 'present' THEN 1 END) * 100.0) / NULLIF(COUNT(*), 0), 1) as percentage
            FROM attendance 
            WHERE student_id = $1::uuid OR user_id = $1::uuid;
        `;
        const result = await pool.query(query, [targetId]);
        res.json(result.rows[0] || { percentage: 0 });
    } catch (err) {
        res.status(500).json({ error: "Presence Telemetry Synchronization Failure" });
    }
});

module.exports = router;