// routes/attendance.js

const express = require('express');
const router = express.Router();

// ✅ Database and Middleware Imports
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// =================================================================
// CONFIGURATION: ROLES (Normalized to Lowercase)
// =================================================================
const MARKING_ROLES = ['super admin', 'admin', 'teacher', 'apiuser'];
const ROSTER_VIEW_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'apiuser', 'hr', 'staff'];
const REPORT_VIEW_ROLES = ['super admin', 'admin', 'coordinator', 'hr', 'finance'];
const USER_REPORT_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'student', 'employee'];

// =================================================================
// 1. MARKING ATTENDANCE (POST /mark)
// =================================================================
router.post('/mark', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { batch_id, subject_id, attendance_date, records, mark_method } = req.body;
    const marked_by_id = req.user ? req.user.id : null; 

    if (!attendance_date || !records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ message: 'Date and student records are required.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        for (const record of records) {
            const { user_id, status, remarks } = record; 
            if (!status) continue; 

            // Find Profile (Student or Teacher)
            const profileQuery = await client.query(`
                SELECT student_id AS profile_id, 'student' AS role FROM students WHERE user_id = $1::uuid
                UNION ALL
                SELECT id AS profile_id, 'staff' AS role FROM teachers WHERE user_id = $1::uuid
                LIMIT 1
            `, [user_id]);

            const profile = profileQuery.rows[0];
            if (!profile) continue; 
            
            const isStudent = profile.role === 'student';
            const profileId = profile.profile_id; 
            
            const conflictColumns = isStudent 
                ? 'student_id, subject_id, attendance_date' 
                : 'staff_id, attendance_date'; 
                
            const upsertQuery = `
                INSERT INTO attendance (user_id, student_id, staff_id, batch_id, subject_id, attendance_date, status, remarks, marked_by, mark_method)
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10)
                ON CONFLICT (${conflictColumns}) 
                DO UPDATE SET status = EXCLUDED.status, remarks = EXCLUDED.remarks, marked_by = EXCLUDED.marked_by, mark_method = EXCLUDED.mark_method;
            `;
            
            await client.query(upsertQuery, [
                user_id, 
                isStudent ? profileId : null, 
                isStudent ? null : profileId,  
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
        res.status(201).json({ message: 'Attendance processed successfully.' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Mark Error:', err.message);
        res.status(500).json({ error: 'Server error marking attendance.' });
    } finally {
        if (client) client.release();
    }
});

// =================================================================
// 2. ROSTER VIEW (GET /report/roster/universal)
// =================================================================
router.get('/report/roster/universal', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    const role = req.query.role ? req.query.role.toLowerCase() : 'student';
    const { filter_id, subject_id, date } = req.query;

    if (!filter_id || !date) return res.status(400).json({ message: 'Filter ID and date required.' });

    try {
        let userSelectQuery = '';
        const params = [filter_id];
        let subjectCondition = '';
        let attendancePkColumn = '';
        
        if (role === 'student') {
            userSelectQuery = `
                SELECT u.id::text AS user_id, CONCAT(s.first_name, ' ', s.last_name) AS full_name, 
                s.enrollment_no AS user_identifier, s.student_id AS profile_pk_id
                FROM students s JOIN users u ON s.user_id = u.id WHERE s.batch_id = $1::uuid`;
            attendancePkColumn = 'student_id';
            if (subject_id) {
                params.push(subject_id);
                subjectCondition = `AND a.subject_id = $${params.length}::uuid`;
            }
        } else {
            userSelectQuery = `
                SELECT u.id::text AS user_id, t.full_name, t.employee_id AS user_identifier, t.id AS profile_pk_id
                FROM teachers t JOIN users u ON t.user_id = u.id WHERE t.department_id = $1::uuid`;
            attendancePkColumn = 'staff_id';
        }
        
        params.push(date);
        const finalQuery = `
            WITH user_list AS (${userSelectQuery})
            SELECT u_list.*, COALESCE(a.status, 'unmarked') AS status, a.remarks, a.id AS attendance_id
            FROM user_list u_list
            LEFT JOIN attendance a ON u_list.profile_pk_id = a.${attendancePkColumn}
                ${subjectCondition} AND a.attendance_date = $${params.length}
            ORDER BY u_list.full_name;`;
        
        const { rows } = await pool.query(finalQuery, params);
        res.status(200).json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =================================================================
// 3. CONSOLIDATED REPORT (Monthly)
// =================================================================
router.get('/report/consolidated', authenticateToken, authorize(REPORT_VIEW_ROLES), async (req, res) => {
    const { role, month, year, optional_filter_id } = req.query;
    if (!role || !month || !year) return res.status(400).json({ message: 'Month and Year required.' });

    try {
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        
        const userQuery = `
            SELECT u.id AS user_id, u.role,
            COALESCE(s.first_name || ' ' || s.last_name, t.full_name, u.username) AS full_name
            FROM users u
            LEFT JOIN students s ON u.id = s.user_id AND LOWER(u.role::text) = 'student'
            LEFT JOIN teachers t ON u.id = t.user_id AND LOWER(u.role::text) = 'teacher'
            WHERE LOWER(u.role::text) = $1`;

        const { rows: userRows } = await pool.query(userQuery, [role.toLowerCase()]);
        const userIds = userRows.map(u => u.user_id); 
        
        if (userIds.length === 0) return res.status(200).json({ users: [] });

        const attRes = await pool.query(`
            SELECT user_id, attendance_date, status FROM attendance
            WHERE user_id = ANY($1) AND attendance_date BETWEEN $2 AND $3`, [userIds, startDate, endDate]);

        const processed = userRows.map(u => ({
            ...u, attendance: attRes.rows.filter(r => r.user_id === u.user_id)
        }));
        res.status(200).json({ users: processed });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =================================================================
// 4. INDIVIDUAL USER REPORT (Full & Final Optimized Version)
// =================================================================
router.get('/report/user/:userId', authenticateToken, authorize(USER_REPORT_ROLES), async (req, res) => {
    const targetUserId = req.params.userId; 
    const { subject_id, start_date, end_date } = req.query;
    
    // রোলের নাম ছোট হাতের অক্ষরে রূপান্তর করে চেক করা (Case-insensitive support)
    const userRole = req.user.role ? req.user.role.toLowerCase() : '';
    
    // ইউজার কি নিজের রেকর্ড দেখছে নাকি অ্যাডমিন হিসেবে অন্যের রেকর্ড দেখছে?
    const isSelf = String(req.user.id) === targetUserId;
    const canViewOthers = ['super admin', 'admin', 'teacher', 'coordinator'].includes(userRole);

    if (!isSelf && !canViewOthers) {
        return res.status(403).json({ message: 'Forbidden: আপনি শুধুমাত্র নিজের রেকর্ড দেখার অনুমতিপ্রাপ্ত।' });
    }
      
    // ডাইনামিক কুয়েরি তৈরি: OR Logic ব্যবহার করে user_id এবং profile ID চেক করা
    let query = `
        SELECT a.id, a.attendance_date, a.status, a.remarks, a.mark_method, 
               COALESCE(s.subject_name, 'General') as subject_name 
        FROM attendance a
        LEFT JOIN subjects s ON a.subject_id = s.id 
        WHERE (a.user_id = $1::uuid OR a.student_id = $1::uuid OR a.staff_id = $1::uuid)
    `;
    
    const params = [targetUserId];
    
    // সাবজেক্ট ফিল্টার (যদি 'all' না হয় এবং বৈধ আইডি থাকে)
    if (subject_id && subject_id !== 'all' && subject_id !== '' && subject_id !== 'null') { 
        params.push(subject_id); 
        query += ` AND a.subject_id = $${params.length}::uuid`; 
    }
    
    // শুরুর তারিখ ফিল্টার
    if (start_date && start_date !== '') { 
        params.push(start_date); 
        query += ` AND a.attendance_date >= $${params.length}`; 
    }
    
    // শেষ তারিখ ফিল্টার
    if (end_date && end_date !== '') { 
        params.push(end_date); 
        query += ` AND a.attendance_date <= $${params.length}`; 
    }
    
    // তারিখ অনুযায়ী ডিসেন্ডিং অর্ডারে সাজানো
    query += ' ORDER BY a.attendance_date DESC;';

    try {
        const { rows } = await pool.query(query, params);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Individual Report Fetch Error:', err.message);
        res.status(500).json({ error: 'রিপোর্ট জেনারেট করতে সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।' });
    }
});

// =================================================================
// 5. UPDATE & DELETE
// =================================================================
router.put('/:attendanceId', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { status, remarks } = req.body;
    try {
        const query = `UPDATE attendance SET status = $1, remarks = $2 WHERE id = $3::uuid RETURNING *;`;
        const { rows } = await pool.query(query, [status, remarks, req.params.attendanceId]);
        res.status(200).json(rows[0]);
    } catch (err) { res.status(500).send(err.message); }
});

router.delete('/:attendanceId', authenticateToken, authorize(['super admin', 'admin']), async (req, res) => {
    try {
        await pool.query('DELETE FROM attendance WHERE id = $1::uuid', [req.params.attendanceId]);
        res.json({ message: 'Deleted successfully' });
    } catch (err) { res.status(500).send(err.message); }
});

// =================================================================
// 6. FILTER ENDPOINTS (Batches, Subjects, Departments)
// =================================================================
router.get('/departments', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id, department_name AS name FROM hr_departments ORDER BY name;`);
        res.json(rows);
    } catch (err) {
        const fallback = await pool.query(`SELECT id, branch_name AS name FROM branches ORDER BY name;`);
        res.json(fallback.rows);
    }
});

router.get('/batches', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id, batch_name AS name FROM batches ORDER BY name;`); 
        res.json(rows); 
    } catch (err) { res.status(500).send(err.message); }
});

router.get('/subjects', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id, subject_name FROM subjects ORDER BY subject_name;`);
        res.json(rows);
    } catch (err) { res.status(500).send(err.message); }
});

// =================================================================
// 7. DASHBOARD SUMMARY (Percentage Logic)
// =================================================================
router.get('/student/:sid/summary', authenticateToken, async (req, res) => {
    const { sid } = req.params;
    try {
        const query = `
            SELECT 
                COUNT(*) FILTER (WHERE LOWER(status::text) IN ('present', 'p')) as present,
                COUNT(*) FILTER (WHERE LOWER(status::text) IN ('late', 'l')) as late,
                COUNT(*) as total
            FROM attendance WHERE (student_id = $1::uuid OR user_id = $1::uuid);
        `;
        const { rows } = await pool.query(query, [sid]);
        const present = parseInt(rows[0].present || 0);
        const late = parseInt(rows[0].late || 0);
        const total = parseInt(rows[0].total || 0);

        if (total === 0) return res.json({ percentage: 0, present: 0, total: 0, status: 'No Data' });
        const pct = Math.round(((present + (late * 0.5)) / total) * 100);
        res.json({ percentage: pct, present, total, status: pct >= 75 ? 'Good' : 'Shortage' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;