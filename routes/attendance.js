const express = require('express');
const router = express.Router();

// ✅ Correct file paths
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// =================================================================
// CONFIGURATION: ROLES (Case-Insensitive Support)
// =================================================================
// ✅ FIX: Added lowercase versions to ensure "teacher" works as well as "Teacher"
const MARKING_ROLES = [
    'Super Admin', 'Admin', 'Teacher', 'ApiUser',
    'super admin', 'admin', 'teacher', 'apiuser' 
];

const ROSTER_VIEW_ROLES = [
    'Super Admin', 'Admin', 'Teacher', 'Coordinator', 'ApiUser', 'HR', 'Staff',
    'super admin', 'admin', 'teacher', 'coordinator', 'apiuser', 'hr', 'staff'
];

const REPORT_VIEW_ROLES = [
    'Super Admin', 'Admin', 'Coordinator', 'HR', 'Finance',
    'super admin', 'admin', 'coordinator', 'hr', 'finance'
];

const USER_REPORT_ROLES = [
    'Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Employee',
    'super admin', 'admin', 'teacher', 'coordinator', 'student', 'employee'
];

// =================================================================
// 1. MARKING ATTENDANCE (POST /mark)
// =================================================================
router.post('/mark', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { batch_id, subject_id, attendance_date, records, mark_method } = req.body;
    const marked_by_id = req.user ? req.user.id : null; 

    if (!attendance_date || !records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ message: 'Missing required fields (date, records).' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const finalMarkMethod = mark_method || 'manual';

        for (const record of records) {
            const { user_id, status, remarks } = record; 
            if (!status) continue; 

            // Look up profile (Student or Staff)
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
                finalMarkMethod 
            ]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Attendance marked successfully.' });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Mark Attendance Error:', err.message);
        res.status(500).json({ message: 'Server error while marking attendance.', error: err.message });
    } finally {
        if (client) client.release();
    }
});

// =================================================================
// 2. ROSTER VIEW (GET /report/roster/universal)
// =================================================================
router.get('/report/roster/universal', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    const role = req.query.role ? req.query.role.toLowerCase() : null;
    const { filter_id, subject_id, date } = req.query;

    if (!role || !filter_id || !date) {
        return res.status(400).json({ message: 'Role, filter_id, and date required.' });
    }

    try {
        let userSelectQuery = '';
        const params = [];
        let subjectCondition = '';
        let attendancePkColumn = '';
        
        let paramCounter = 1;
        params.push(filter_id); 
        
        if (role === 'student') {
            userSelectQuery = `
                SELECT 
                    u.id::text AS user_id, 
                    CONCAT(s.first_name, ' ', s.last_name) AS full_name, 
                    s.enrollment_no AS user_identifier,
                    s.student_id AS profile_pk_id, 
                    'student_id' AS profile_pk_column
                FROM students s
                JOIN users u ON s.user_id = u.id 
                WHERE s.batch_id = $1::uuid
            `;
            attendancePkColumn = 'student_id';
            
            if (subject_id) {
                paramCounter++;
                params.push(subject_id);
                subjectCondition = `AND a.subject_id = $${paramCounter}::uuid`;
            }

        } else if (role === 'teacher') {
            userSelectQuery = `
                SELECT 
                    u.id::text AS user_id, 
                    t.full_name, 
                    t.employee_id AS user_identifier,
                    t.id AS profile_pk_id, 
                    'staff_id' AS profile_pk_column
                FROM teachers t
                JOIN users u ON t.user_id = u.id 
                WHERE u.branch_id = $1::uuid
            `;
            attendancePkColumn = 'staff_id';
            
        } else {
             userSelectQuery = `
                SELECT 
                    u.id::text AS user_id, 
                    u.username AS full_name, 
                    u.id::text AS user_identifier, 
                    u.id AS profile_pk_id, 
                    'user_id' AS profile_pk_column
                FROM users u
                WHERE LOWER(u.role::text) = 'employee' AND u.branch_id = $1::uuid
            `;
            attendancePkColumn = 'user_id';
        }
        
        paramCounter++;
        params.push(date); 
        const dateParamIndex = paramCounter;

        const finalQuery = `
            WITH user_list AS (${userSelectQuery})
            SELECT 
                u_list.user_id, 
                u_list.full_name, 
                u_list.user_identifier, 
                COALESCE(a.status, 'unmarked') AS status,
                a.remarks,
                a.id AS attendance_id, 
                COALESCE(a.mark_method, 'manual') AS mark_method 
            FROM user_list u_list
            LEFT JOIN attendance a ON u_list.profile_pk_id = a.${attendancePkColumn}
                ${subjectCondition} 
                AND a.attendance_date = $${dateParamIndex}
            ORDER BY u_list.full_name;
        `;
        
        const { rows } = await pool.query(finalQuery, params);
        res.status(200).json(rows);

    } catch (err) {
        console.error('Roster Fetch Error:', err);
        res.status(500).json({ message: 'Server error fetching roster.', error: err.message });
    }
});

// =================================================================
// 3. CONSOLIDATED REPORT
// =================================================================
router.get('/report/consolidated', authenticateToken, authorize(REPORT_VIEW_ROLES), async (req, res) => {
    const { role, month, year, optional_filter_id } = req.query;

    if (!role || !month || !year) {
        return res.status(400).json({ message: 'Role, month, and year required.' });
    }

    try {
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        
        let userQuery = `
            SELECT 
                u.id AS user_id, 
                u.role,
                COALESCE(s.first_name || ' ' || s.last_name, t.full_name, u.username) AS full_name,
                COALESCE(s.enrollment_no, t.employee_id, u.id::text) AS user_identifier
            FROM users u
            LEFT JOIN students s ON u.id = s.user_id AND LOWER(u.role::text) = 'student'
            LEFT JOIN teachers t ON u.id = t.user_id AND LOWER(u.role::text) = 'teacher'
            WHERE LOWER(u.role::text) = $1
        `;

        const userParams = [role.toLowerCase()];
        if (optional_filter_id) {
            userQuery += ` AND u.branch_id = $2::uuid`; 
            userParams.push(optional_filter_id);
        }
        
        const userRes = await pool.query(userQuery, userParams);
        const userIds = userRes.rows.map(u => u.user_id); 
        
        if (userIds.length === 0) return res.status(200).json({ users: [] });

        const attendanceQuery = `
            SELECT user_id, attendance_date, status, subject_id 
            FROM attendance
            WHERE user_id = ANY($1) 
              AND attendance_date BETWEEN $2 AND $3
            ORDER BY attendance_date;
        `;
        
        const attendanceRes = await pool.query(attendanceQuery, [userIds, startDate, endDate]);

        const processedUsers = userRes.rows.map(user => {
            const userRecords = attendanceRes.rows.filter(r => r.user_id === user.user_id);
            return { ...user, attendance: userRecords };
        });

        res.status(200).json({ users: processedUsers });

    } catch (err) {
        console.error('Consolidated Report Error:', err);
        res.status(500).json({ message: 'Error fetching report.', error: err.message });
    }
});

// =================================================================
// 4. INDIVIDUAL USER REPORT
// =================================================================
router.get('/report/user/:userId', authenticateToken, authorize(USER_REPORT_ROLES), async (req, res) => {
    const targetUserId = req.params.userId; 
    const { subject_id, start_date, end_date } = req.query;
    
    // Security check
    const isSelf = String(req.user.id) === targetUserId;
    // Allow admins/teachers to view others
    const canViewOthers = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'super admin', 'admin', 'teacher', 'coordinator'].includes(req.user.role);

    if (!isSelf && !canViewOthers) {
        return res.status(403).json({ message: 'Forbidden: Can only view own records.' });
    }
      
    let query = `
        SELECT a.id, a.attendance_date, a.status, a.remarks, a.mark_method, s.subject_name 
        FROM attendance a
        LEFT JOIN subjects s ON a.subject_id = s.id 
        WHERE a.user_id = $1
    `;
    const params = [targetUserId];
    let paramCounter = 1;
    
    if (subject_id) { paramCounter++; params.push(subject_id); query += ` AND a.subject_id = $${paramCounter}::uuid`; }
    if (start_date) { paramCounter++; params.push(start_date); query += ` AND a.attendance_date >= $${paramCounter}`; }
    if (end_date) { paramCounter++; params.push(end_date); query += ` AND a.attendance_date <= $${paramCounter}`; }
    
    query += ' ORDER BY a.attendance_date DESC;';

    try {
        const { rows } = await pool.query(query, params);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching user report', error: err.message });
    }
});

// =================================================================
// 5. UPDATE & DELETE
// =================================================================
router.put('/:attendanceId', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { attendanceId } = req.params;
    const { status, remarks } = req.body;
    const marked_by_id = req.user ? req.user.id : null; 

    try {
        const query = `UPDATE attendance SET status = $1, remarks = $2, marked_by = $3, mark_method = 'manual' WHERE id = $4::uuid RETURNING *;`;
        const { rows } = await pool.query(query, [status, remarks || null, marked_by_id, attendanceId]);
        if (rows.length === 0) return res.status(404).json({ message: 'Record not found.' });
        res.status(200).json({ message: 'Updated successfully.', record: rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Error updating.', error: err.message });
    }
});

router.delete('/:attendanceId', authenticateToken, authorize(['Super Admin', 'Admin']), async (req, res) => {
    const { attendanceId } = req.params;
    try {
        const result = await pool.query('DELETE FROM attendance WHERE id = $1::uuid RETURNING *', [attendanceId]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Record not found.' });
        res.status(200).json({ message: 'Deleted successfully.' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting.', error: err.message });
    }
});

// =================================================================
// 6. FILTER ENDPOINTS (Batches, Subjects, Departments)
// =================================================================
// ✅ FIX: Using ROSTER_VIEW_ROLES which now supports both "Teacher" and "teacher"

router.get('/departments', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        const query = `SELECT id, branch_name AS name FROM branches ORDER BY branch_name;`; 
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch departments.', error: err.message });
    }
});

router.get('/batches', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        const query = `SELECT id, batch_name AS name FROM batches ORDER BY batch_name;`; 
        const { rows } = await pool.query(query);
        res.status(200).json(rows); 
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch batches.', error: err.message });
    }
});

router.get('/subjects', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        const query = `SELECT id, subject_name, subject_code FROM subjects ORDER BY subject_name;`;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch subjects.', error: err.message });
    }
});

module.exports = router;