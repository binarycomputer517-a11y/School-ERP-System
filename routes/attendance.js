const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
// NOTE: authMiddleware now provides the role in **LOWERCASE** (e.g., 'admin', 'teacher')

// --- FIX: Role Definitions Must Be Lowercase ---
const MARKING_ROLES = ['super admin', 'admin', 'teacher', 'apiuser'];
const ROSTER_VIEW_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'apiuser'];
const REPORT_VIEW_ROLES = ['super admin', 'admin', 'coordinator'];
const USER_REPORT_ROLES = ['super admin', 'admin', 'teacher', 'coordinator', 'student', 'employee'];

// =================================================================
// 0. HELPER FUNCTION: Removed (UUID Mode now used via req.user.id)
// =================================================================
// NOTE: The function getMarkerIdAndType has been removed because 
// req.user.id now directly contains the user's UUID (users.id).

// =================================================================
// 1. MARKING ATTENDANCE (POST /mark)
// =================================================================

router.post('/mark', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { batch_id, subject_id, attendance_date, records, mark_method } = req.body;
    
    // UUID FIX: req.user.id is the UUID from the token payload (users.id)
    const marked_by_id = req.user.id; 

    if (!attendance_date || !records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ message: 'Missing required fields (date, records).' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const finalMarkMethod = mark_method || 'manual';

        for (const record of records) {
            const { user_id, status, remarks } = record; // user_id is UUID
            
            // Look up the profile ID (student_id or staff_id) linked to the user_id
            const profileQuery = await client.query(`
                SELECT student_id AS profile_id, 'student' AS role FROM students WHERE user_id = $1::uuid
                UNION ALL
                SELECT id AS profile_id, 'staff' AS role FROM teachers WHERE user_id = $1::uuid
                LIMIT 1
            `, [user_id]);

            const profile = profileQuery.rows[0];
            if (!profile) {
                 console.warn(`Profile not found for user_id: ${user_id}. Skipping record.`);
                 continue; 
            }
            
            // NOTE: profile.role here is either 'student' or 'staff' (lowercase from the query itself)
            const isStudent = profile.role === 'student';
            const profileId = profile.profile_id; // This is a UUID
            
            const conflictColumns = isStudent 
                ? 'student_id, subject_id, attendance_date' 
                : 'staff_id, attendance_date'; 
                
            // UUID FIX: marked_by is explicitly cast as ::uuid
            const upsertQuery = `
                INSERT INTO attendance (user_id, student_id, staff_id, batch_id, subject_id, attendance_date, status, remarks, marked_by, mark_method)
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10)
                ON CONFLICT (${conflictColumns}) 
                DO UPDATE SET status = EXCLUDED.status, remarks = EXCLUDED.remarks, marked_by = EXCLUDED.marked_by, mark_method = EXCLUDED.mark_method;
            `;
            
            // The final query execution
            await client.query(upsertQuery, [
                user_id, 
                isStudent ? profileId : null, 
                isStudent ? null : profileId,  
                batch_id || null, 
                subject_id || null, 
                attendance_date, 
                status, 
                remarks || null, 
                marked_by_id, // UUID used directly
                finalMarkMethod 
            ]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Attendance marked successfully.' });

    } catch (err) {
        await client.query('ROLLBACK');
        
        console.error('*** CRITICAL UPSERT ERROR ***');
        console.error('Error marking attendance (Transaction rolled back):', err.message);
        
        if (err.detail) {
            console.error('DB DETAIL:', err.detail);
        }
        if (err.constraint) {
            console.error('DB CONSTRAINT VIOLATION:', err.constraint);
        }
        console.error('******************************');
        
        res.status(500).json({ message: 'Server error while marking attendance. Transaction rolled back.', error: err.message });
    } finally {
        client.release();
    }
});

// =================================================================
// 2. REPORTING ENDPOINTS
// =================================================================

router.get('/report/roster/universal', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    const { role, filter_id, subject_id, date } = req.query;

    if (!role || !filter_id || !date) {
        return res.status(400).json({ message: 'Role, filter_id (batch/branch ID), and date are required query parameters.' });
    }

    try {
        let userSelectQuery = '';
        const params = [];
        let subjectCondition = '';
        let attendancePkColumn = '';
        
        let paramCounter = 1;
        params.push(filter_id); 
        
        // NOTE: role is already lowercase here due to authMiddleware
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
            
        } else if (role === 'employee') {
             userSelectQuery = `
                SELECT 
                    u.id::text AS user_id, 
                    u.username AS full_name, 
                    u.id::text AS user_identifier, 
                    u.id AS profile_pk_id, 
                    'user_id' AS profile_pk_column
                FROM users u
                WHERE u.role = 'Employee' AND u.branch_id = $1::uuid
            `;
            attendancePkColumn = 'user_id';
            
        } else {
            return res.status(400).json({ message: 'Invalid role specified.' });
        }
        
        paramCounter++;
        params.push(date); 
        const dateParamIndex = paramCounter;

        const attendanceJoinCondition = `
            LEFT JOIN attendance a ON u_list.profile_pk_id = a.${attendancePkColumn}
                ${subjectCondition} 
                AND a.attendance_date = $${dateParamIndex}
        `;
        
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
            ${attendanceJoinCondition}
            ORDER BY u_list.full_name;
        `;
        
        const { rows } = await pool.query(finalQuery, params);
        res.status(200).json(rows);

    } catch (err) {
        console.error('Error fetching universal attendance roster:', err);
        res.status(500).json({ 
            message: 'Server error fetching roster. Check the server console for exact SQL error.', 
            error: err.message 
        });
    }
});


router.get('/report/consolidated', authenticateToken, authorize(REPORT_VIEW_ROLES), async (req, res) => {
    const { role, month, year, optional_filter_id } = req.query;

    if (!role || !month || !year) {
        return res.status(400).json({ message: 'Role, month, and year are required query parameters.' });
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
                COALESCE(s.enrollment_no, t.employee_id, u.id::text) AS user_identifier,
                u.branch_id AS department_id_reference
            FROM users u
            LEFT JOIN students s ON u.id = s.user_id AND u.role = 'student' -- NOTE: Role check adjusted
            LEFT JOIN teachers t ON u.id = t.user_id AND u.role = 'teacher' -- NOTE: Role check adjusted
            WHERE LOWER(u.role) = $1
        `;

        const userParams = [role];

        if (optional_filter_id) {
            userQuery += ` AND u.branch_id = $2::uuid`; 
            userParams.push(optional_filter_id);
        }
        
        const userRes = await pool.query(userQuery, userParams);
        
        const userIds = userRes.rows.map(u => u.user_id); 
        
        if (userIds.length === 0) {
            return res.status(200).json({ users: [] });
        }

        const attendanceQuery = `
            SELECT user_id, attendance_date, status, subject_id, batch_id 
            FROM attendance
            WHERE user_id = ANY($1::uuid[])  
              AND attendance_date BETWEEN $2 AND $3
            ORDER BY attendance_date;
        `;
        const attendanceRes = await pool.query(attendanceQuery, [userIds, startDate, endDate]);

        const processedUsers = userRes.rows.map(user => {
            const userRecords = attendanceRes.rows.filter(r => r.user_id === user.user_id);
            return {
                ...user,
                attendance: userRecords,
            };
        });

        res.status(200).json({ users: processedUsers });

    } catch (err) {
        console.error('CRITICAL ERROR fetching consolidated attendance report:', err);
        res.status(500).json({ message: 'Server error fetching consolidated report. Data linking failed. Check DB table/column names in attendance.js.', error: err.message });
    }
});


router.get('/report/user/:userId', authenticateToken, authorize(USER_REPORT_ROLES), async (req, res) => {
    const targetUserId = req.params.userId; // This is the UUID from the URL
    
    // UUID FIX: req.user.id is the UUID from the token
    // Security check for self-service
    // The roles 'student' and 'employee' are now guaranteed lowercase.
    if (['student', 'employee'].includes(req.user.role)) {
        // Direct comparison of the target UUID with the authenticated user's UUID
        if (req.user.id !== targetUserId) { 
            return res.status(403).json({ message: 'Forbidden: You can only access your own records.' });
        }
    }
      
    const { subject_id, start_date, end_date } = req.query;
    
    let query = `
        SELECT a.id, a.attendance_date, a.status, a.remarks, a.mark_method, s.subject_name 
        FROM attendance a
        LEFT JOIN subjects s ON a.subject_id = s.id 
        WHERE a.user_id = $1::uuid
    `;
    const params = [targetUserId];
    let paramCounter = 1;
    
    if (subject_id) {
        paramCounter++;
        params.push(subject_id);
        query += ` AND a.subject_id = $${paramCounter}::uuid`; 
    }
    if (start_date) {
        paramCounter++;
        params.push(start_date);
        query += ` AND a.attendance_date >= $${paramCounter}`;
    }
    if (end_date) {
        paramCounter++;
        params.push(end_date);
        query += ` AND a.attendance_date <= $${paramCounter}`;
    }
    
    query += ' ORDER BY a.attendance_date DESC;';

    try {
        const { rows } = await pool.query(query, params);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching user attendance report:', err);
        res.status(500).json({ message: 'Server error fetching report', error: err.message });
    }
});

/**
 * @route   PUT /api/attendance/:attendanceId
 * @desc    Update a single attendance record.
 * @access  Private
 */
router.put('/:attendanceId', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { attendanceId } = req.params; // attendance.id (UUID)
    const { status, remarks } = req.body;
    
    // UUID FIX: Retrieve the UUID directly from the token
    const marked_by_id = req.user.id; 

    if (!status) {
        return res.status(400).json({ message: 'Status is required.' });
    }

    try {
        // UUID FIX: marked_by is explicitly cast as ::uuid
        const query = `
            UPDATE attendance 
            SET status = $1, remarks = $2, marked_by = $3::uuid, mark_method = 'manual'
            WHERE id = $4::uuid 
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [status, remarks || null, marked_by_id, attendanceId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Attendance record not found.' });
        }
        
        res.status(200).json({ message: 'Attendance updated successfully.', record: rows[0] });
    } catch (err) {
        console.error('Error updating attendance:', err);
        res.status(500).json({ message: 'Server error updating attendance', error: err.message });
    }
});

/**
 * @route   DELETE /api/attendance/:attendanceId
 * @desc    Delete a single attendance record.
 * @access  Private (Admin, Super Admin)
 */
router.delete('/:attendanceId', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const { attendanceId } = req.params; // This is attendance.id (UUID)

    try {
        const result = await pool.query('DELETE FROM attendance WHERE id = $1::uuid RETURNING *', [attendanceId]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Attendance record not found.' });
        }
        
        res.status(200).json({ message: 'Attendance record deleted successfully.' });
    } catch (err) {
        console.error('Error deleting attendance:', err);
        res.status(500).json({ message: 'Server error deleting attendance', error: err.message });
    }
}
);

// =================================================================
// 4. FILTER ENDPOINTS
// =================================================================

/**
 * @route   GET /api/attendance/departments
 * @desc    Get a list of all active departments/branches for filter population.
 * @access  Private
 */
router.get('/departments', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        // NOTE: The previous schema output showed 'branches', but the code uses 'departments' 
        // linked to the 'hr_departments' table. This query uses 'branches' as per the schema suggestion in the error log.
        const query = `SELECT id, branch_name AS name FROM branches ORDER BY branch_name;`; 
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching departments/branches:', err);
        res.status(500).json({ message: 'Server error fetching departments. Check DB schema for the correct table and column names (e.g., branches table with id, branch_name).', error: err.message });
    }
});

/**
 * @route   GET /api/attendance/batches
 * @desc    Get a list of all active batches/classes for filter population.
 * @access  Private
 */
router.get('/batches', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        const query = `SELECT id, batch_name AS name FROM batches ORDER BY batch_name;`; 
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows); 
    } catch (err) {
        console.error('Error fetching batches:', err); 
        res.status(500).json({ message: 'Server error fetching batches. Check your database schema for the correct name column in the batches table (id, batch_name).', error: err.message });
    }
});

/**
 * @route   GET /api/attendance/subjects
 * @desc    Get a list of all active subjects for filter population.
 * @access  Private
 */
router.get('/subjects', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        const query = `SELECT id, subject_name, subject_code FROM subjects ORDER BY subject_name;`;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching all subjects:', err);
        res.status(500).json({ message: 'Server error fetching subjects. Check column names (id, subject_name) in the subjects table.', error: err.message });
    }
});


module.exports = router;