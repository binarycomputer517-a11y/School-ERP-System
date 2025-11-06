// routes/attendance.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Role Definitions ---
const MARKING_ROLES = ['Super Admin', 'Admin', 'Teacher', 'ApiUser'];
const ROSTER_VIEW_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
const REPORT_VIEW_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
const USER_REPORT_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Employee'];


// =================================================================
// --- ATTENDANCE MANAGEMENT (GENERALIZED) ---
// =================================================================

/**
 * @route   POST /api/attendance/mark
 * @desc    Mark attendance for one or more users (Student, Teacher, Employee).
 * @access  Private (Admin, Teacher, ApiUser, Super Admin)
 */
router.post('/mark', authenticateToken, authorize(MARKING_ROLES), async (req, res) => {
    const { batch_id, subject_id, attendance_date, records, mark_method } = req.body; 
    const marked_by = req.user.userId;

    if (!attendance_date || !records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ message: 'Missing required fields (date, records).' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const finalMarkMethod = mark_method || 'manual';

        for (const record of records) {
            const { user_id, status, remarks } = record; 
            
            // --- STEP 1: Determine Profile Type and Get Profile ID (Profile's PK) ---
            const profileQuery = await client.query(`
                SELECT id AS profile_id, 'student' AS role FROM students WHERE user_id = $1
                UNION ALL
                SELECT id AS profile_id, 'teacher' AS role FROM teachers WHERE user_id = $1
                LIMIT 1
            `, [user_id]);

            const profile = profileQuery.rows[0];
            if (!profile) {
                 console.warn(`Profile not found for user_id: ${user_id}. Skipping record.`);
                 continue; 
            }
            
            const isStudent = profile.role === 'student';
            const profileId = profile.profile_id;
            
            // --- STEP 2: Define SQL Columns and Conflict Constraint ---
            
            // CRITICAL FIX: Build the ON CONFLICT string explicitly to match the table's unique index
            const conflictColumns = isStudent 
                ? 'student_id, subject_id, attendance_date' 
                : 'staff_id, attendance_date';
                
            const upsertQuery = `
                INSERT INTO attendance (user_id, student_id, staff_id, batch_id, subject_id, attendance_date, status, remarks, marked_by, mark_method)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (${conflictColumns}) 
                DO UPDATE SET status = EXCLUDED.status, remarks = EXCLUDED.remarks, marked_by = EXCLUDED.marked_by, mark_method = EXCLUDED.mark_method;
            `;

            await client.query(upsertQuery, [
                user_id, // $1: users.id
                isStudent ? profileId : null, // $2: student_id
                isStudent ? null : profileId, // $3: staff_id
                batch_id || null, 
                subject_id || null, 
                attendance_date,
                status,
                remarks || null,
                marked_by,
                finalMarkMethod
            ]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Attendance marked successfully.' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error marking attendance:', err);
        res.status(500).json({ message: 'Server error while marking attendance. Unique constraint error likely (42P10).', error: err.message });
    } finally {
        client.release();
    }
});


// =================================================================
// --- REPORTING ENDPOINTS (GENERALIZED) ---
// =================================================================

/**
 * @route   GET /api/attendance/report/roster/universal
 * @desc    Get daily attendance roster for any role (Student, Teacher, Employee) filtered by batch_id or branch_id.
 * @access  Private (Admin, Teacher, Coordinator, Super Admin)
 */
router.get('/report/roster/universal', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    const { role, filter_id, subject_id, date } = req.query;

    if (!role || !filter_id || !date) {
        return res.status(400).json({ message: 'Role, filter_id, and date are required query parameters.' });
    }

    try {
        let userSelectQuery = '';
        const params = [];
        let subjectCondition = '';
        let attendancePkColumn = ''; // Either student_id or staff_id
        
        // --- STEP 1: Build the Dynamic User List Query ---
        
        if (role === 'Student') {
            params.push(filter_id); // $1: batch_id
            userSelectQuery = `
                SELECT 
                    u.id AS user_id, 
                    CONCAT(s.first_name, ' ', s.last_name) AS full_name, 
                    s.enrollment_no AS user_identifier,
                    s.id AS profile_pk_id, 
                    'student_id' AS profile_pk_column
                FROM students s
                JOIN users u ON s.user_id = u.id 
                WHERE s.batch_id = $1::uuid 
            `;
            attendancePkColumn = 'student_id';
            if (subject_id) {
                params.push(subject_id); // $2: subject_id
                subjectCondition = `AND a.subject_id = $${params.length}::uuid`;
            }

        } else if (role === 'Teacher') {
            params.push(filter_id); // $1: branch_id
            userSelectQuery = `
                SELECT 
                    u.id AS user_id, 
                    t.full_name, 
                    t.employee_id AS user_identifier,
                    t.id AS profile_pk_id,
                    'staff_id' AS profile_pk_column
                FROM teachers t
                JOIN users u ON t.user_id = u.id
                WHERE u.branch_id = $1::uuid
            `;
            attendancePkColumn = 'staff_id';
            // Subject is generally ignored for daily teacher/employee roster
            
        } else if (role === 'Employee') {
             params.push(filter_id); // $1: branch_id
             userSelectQuery = `
                SELECT 
                    u.id AS user_id, 
                    u.username AS full_name, 
                    u.id::text AS user_identifier, -- Assuming no dedicated employee table, fallback to users table
                    u.id AS profile_pk_id,
                    'staff_id' AS profile_pk_column
                FROM users u
                WHERE u.role = 'Employee' AND u.branch_id = $1::uuid
            `;
            attendancePkColumn = 'staff_id';
            
        } else {
            return res.status(400).json({ message: 'Invalid role specified.' });
        }
        
        // --- STEP 2: Append Date and Finalize Attendance Join Condition ---
        params.push(date); // This will be the last parameter ($2 or $3, depending on subject_id)
        const dateParamIndex = params.length;

        const attendanceJoinCondition = `
            LEFT JOIN attendance a ON u_list.profile_pk_id = a.${attendancePkColumn}
                ${subjectCondition} 
                AND a.attendance_date = $${dateParamIndex}
        `;
        
        // --- STEP 3: Construct the Final Query ---
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


/**
 * @route   GET /api/attendance/report/roster
 * @desc    [DEPRECATED] Get daily attendance roster for a specific academic class. (Replaced by /universal)
 * @access  Private (Admin, Teacher, Coordinator, Super Admin)
 */
router.get('/report/roster', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    // This old route is now mostly redundant but kept for compatibility.
    // The client has been updated to use the /universal route.
    return res.status(501).json({ message: 'This endpoint is deprecated. Please use /api/attendance/report/roster/universal' });
});


/**
 * @route   GET /api/attendance/report/consolidated
 * @desc    Get a full monthly attendance report for a specific ROLE group (Student, Teacher, Employee).
 * @access  Private (Admin, Coordinator, Super Admin)
 */
router.get('/report/consolidated', authenticateToken, authorize(REPORT_VIEW_ROLES), async (req, res) => {
    const { role, month, year, optional_filter_id } = req.query;

    if (!role || !month || !year) {
        return res.status(400).json({ message: 'Role, month, and year are required query parameters.' });
    }

    try {
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        
        // FIX: Replaced error-prone subqueries with efficient LEFT JOINs
        let userQuery = `
            SELECT 
                u.id AS user_id, 
                u.role,
                -- Use COALESCE to select the name from the matching joined table, falling back to username
                COALESCE(
                    s.first_name || ' ' || s.last_name, 
                    t.full_name, 
                    u.username
                ) AS full_name,

                -- Use COALESCE to select the identifier from the matching joined table, falling back to user ID
                COALESCE(
                    s.enrollment_no, 
                    t.employee_id, 
                    u.id::text
                ) AS user_identifier,

                u.branch_id AS department_id_reference
            FROM users u
            -- Conditional LEFT JOINs ensure one-to-one mapping and better performance
            LEFT JOIN students s ON u.id = s.user_id AND u.role = 'Student'
            LEFT JOIN teachers t ON u.id = t.user_id AND u.role = 'Teacher'
            WHERE u.role = $1
        `;

        const userParams = [role];

        // Filter by optional ID (Batch ID or Department/Branch ID)
        if (optional_filter_id) {
            userQuery += ` AND u.branch_id = $2::uuid`; 
            userParams.push(optional_filter_id);
        }
        
        const userRes = await pool.query(userQuery, userParams);
        const userIds = userRes.rows.map(u => u.user_id);
        
        if (userIds.length === 0) {
            return res.status(200).json({ users: [] });
        }

        // 2. Get all attendance records
        const attendanceQuery = `
            SELECT user_id, attendance_date, status, subject_id, batch_id 
            FROM attendance
            WHERE user_id = ANY($1::uuid[]) 
              AND attendance_date BETWEEN $2 AND $3
            ORDER BY attendance_date;
        `;
        const attendanceRes = await pool.query(attendanceQuery, [userIds, startDate, endDate]);

        // 3. Process the data
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


/**
 * @route   GET /api/attendance/report/user/:userId
 * @desc    Get attendance report for a single user (Replaces /report/student/:studentId).
 * @access  Private (Admin, Teacher, Coordinator, Student, Employee, Super Admin)
 */
router.get('/report/user/:userId', authenticateToken, authorize(USER_REPORT_ROLES), async (req, res) => {
    const targetUserId = req.params.userId; // Expecting UUID string
    
    // Security check: Allow Admins/Teachers/Coordinators access, or self-service access.
    if (!['Admin', 'Teacher', 'Coordinator', 'Super Admin'].includes(req.user.role) && req.user.userId !== targetUserId) {
         return res.status(403).json({ message: 'Forbidden: You can only access your own records.' });
    }
     
    const { subject_id, start_date, end_date } = req.query;
    
    let query = `
        SELECT a.attendance_date, a.status, a.remarks, s.subject_name 
        FROM attendance a
        LEFT JOIN subjects s ON a.subject_id = s.id 
        WHERE a.user_id = $1::uuid 
    `;
    const params = [targetUserId];
    
    // Dynamic query building
    if (subject_id) {
        params.push(subject_id);
        query += ` AND a.subject_id = $${params.length}::uuid`; 
    }
    if (start_date) {
        params.push(start_date);
        query += ` AND a.attendance_date >= $${params.length}`;
    }
    if (end_date) {
        params.push(end_date);
        query += ` AND a.attendance_date <= $${params.length}`;
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
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.put('/:attendanceId', authenticateToken, authorize(['Admin', 'Teacher', 'Super Admin']), async (req, res) => {
    const { attendanceId } = req.params;
    const { status, remarks } = req.body;
    const marked_by = req.user.userId;

    if (!status) {
        return res.status(400).json({ message: 'Status is required.' });
    }

    try {
        const query = `
            UPDATE attendance 
            SET status = $1, remarks = $2, marked_by = $3, mark_method = 'manual'
            WHERE id = $4 
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [status, remarks || null, marked_by, attendanceId]);
        
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
router.delete('/:attendanceId', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { attendanceId } = req.params;

    try {
        const result = await pool.query('DELETE FROM attendance WHERE id = $1 RETURNING *', [attendanceId]);
        
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
// --- FILTER ENDPOINTS (Corrected for relative path use) ---
// =================================================================

/**
 * @route   GET /api/attendance/departments
 * @desc    Get a list of all active departments/branches for filter population.
 * @access  Private (Used by roles that need to view rosters)
 */
router.get('/departments', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        // FIX: Using 'branch_name' aliased to 'name'
        const query = `SELECT id, branch_name AS name FROM branches ORDER BY branch_name;`; 
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching departments/branches (Database Structure Error Likely):', err);
        res.status(500).json({ message: 'Server error fetching departments. Check DB schema for the correct table and column names (e.g., branches table with id, name).', error: err.message });
    }
});

/**
 * @route   GET /api/attendance/batches
 * @desc    Get a list of all active batches/classes for filter population.
 * @access  Private (Used by roles that need to view rosters)
 */
router.get('/batches', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        // Let's assume the name column is actually named 'batch_name' and alias it to 'name'
        const query = `SELECT id, batch_name AS name FROM batches ORDER BY batch_name;`; 
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching batches:', err); 
        res.status(500).json({ message: 'Server error fetching batches. Check your database schema for the correct name column in the batches table.', error: err.message });
    }
});

/**
 * @route   GET /api/attendance/subjects
 * @desc    Get a list of all active subjects for filter population.
 * @access  Private (Used by roles that need to view rosters)
 */
router.get('/subjects', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        // This query uses 'id' and 'subject_name' based on previous troubleshooting.
        const query = `SELECT id, subject_name, subject_code FROM subjects ORDER BY subject_name;`;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching all subjects:', err);
        res.status(500).json({ message: 'Server error fetching subjects. Check column names (id, subject_name) in the subjects table.', error: err.message });
    }
});


module.exports = router;