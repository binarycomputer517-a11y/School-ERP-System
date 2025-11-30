/**
 * @fileoverview Routes for managing Student profiles, including creation, retrieval, updates, and deletion.
 * Includes auto-generation for Enrollment Numbers and Admission IDs.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const bcrypt = require('bcryptjs');
const saltRounds = 10;
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Constants: Database Tables ---
const STUDENTS_TABLE = 'students';
const USERS_TABLE = 'users';
const BRANCHES_TABLE = 'branches';
const COURSES_TABLE = 'courses';
const BATCHES_TABLE = 'batches';

// --- Constants: Access Control ---
const CRUD_ROLES = ['Super Admin', 'Admin', 'HR', 'Registrar'];
const VIEW_ROLES = ['Super Admin', 'Admin', 'HR', 'Registrar', 'Teacher', 'Coordinator', 'Student'];

// --- Helper: Get Configuration IDs from Request ---
function getConfigIds(req) {
    const branch_id = req.user.branch_id; 
    return { branch_id, created_by: req.user.id, updated_by: req.user.id };
}

// --- Helper: Safely Convert String to UUID or Null ---
function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    return value.trim();
}

// =========================================================
// 1. GET: Main Student List (Optimized for Dashboard)
// =========================================================
router.get('/', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, 
                s.admission_id,
                s.enrollment_no,
                s.first_name, s.last_name, 
                s.email, s.phone_number, s.gender, s.dob,
                s.status,
                
                -- User Account Details
                u.username, u.role, u.id AS user_id,
                
                -- Academic & Fee Details (Prevents N/A on Frontend)
                c.course_name, 
                c.course_code AS subject,      -- Alias: subject
                c.total_fee AS fees_structure, -- Alias: fees_structure
                
                b.batch_name, 
                br.branch_name
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${USERS_TABLE} u ON s.user_id = u.id
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            LEFT JOIN ${BATCHES_TABLE} b ON s.batch_id = b.id
            LEFT JOIN ${BRANCHES_TABLE} br ON s.branch_id = br.id
            WHERE u.deleted_at IS NULL
            ORDER BY s.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching students list:', error);
        res.status(500).json({ message: 'Failed to retrieve students list.' });
    }
});

// =========================================================
// 2. POST: Create New Student (Auto-Generate IDs)
// =========================================================
router.post('/', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    let {
        username, password, first_name, last_name, email, phone_number,
        dob, gender, address, course_id, batch_id,
        enrollment_no, // Optional: System will generate if empty
        admission_id,  // Optional: System will generate if empty
        academic_session_id 
    } = req.body;
    
    const { branch_id, created_by } = getConfigIds(req);

    // Validation
    if (!username || !password || !first_name || !last_name || !course_id || !batch_id) {
        return res.status(400).json({ message: 'Missing required fields: Name, Login, Course, or Batch.' });
    }

    const client = await pool.connect();
    
    try {
        await client.query('BEGIN'); // Start Transaction

        // --- A. Auto-Generate Enrollment No (Format: STU-YYYY-001) ---
        if (!enrollment_no) {
            const year = new Date().getFullYear();
            // Count existing students to find the next sequence number
            const countRes = await client.query(`SELECT COUNT(*) FROM ${STUDENTS_TABLE}`);
            const nextNum = parseInt(countRes.rows[0].count) + 1;
            enrollment_no = `STU-${year}-${String(nextNum).padStart(3, '0')}`;
        }

        // --- B. Auto-Generate Admission ID (Format: ADMN-XXXXXX) ---
        if (!admission_id) {
            const uniqueSuffix = Date.now().toString().slice(-6);
            admission_id = `ADMN-${uniqueSuffix}`;
        }

        // --- C. Fetch Active Academic Session (Fallback safety) ---
        if (!academic_session_id) {
            const sessionRes = await client.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
            if (sessionRes.rowCount > 0) {
                academic_session_id = sessionRes.rows[0].id;
            } else {
                // If no active session, grab ANY session to prevent crash
                const anySession = await client.query("SELECT id FROM academic_sessions LIMIT 1");
                academic_session_id = anySession.rowCount > 0 ? anySession.rows[0].id : null;
            }
        }

        // --- D. Create User Login ---
        const password_hash = await bcrypt.hash(password, saltRounds);
        const safeBranchId = toUUID(branch_id);

        const userQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, email, phone_number, branch_id)
            VALUES ($1, $2, 'Student', $3, $4, $5::uuid)
            RETURNING id;
        `;
        const userResult = await client.query(userQuery, [username, password_hash, email, phone_number || null, safeBranchId]);
        const newUserId = userResult.rows[0].id;

        // --- E. Create Student Profile ---
        const studentQuery = `
            INSERT INTO ${STUDENTS_TABLE} (
                user_id, first_name, last_name, email, phone_number, 
                dob, gender, permanent_address, course_id, batch_id, branch_id,
                created_by, admission_id, academic_session_id, enrollment_no
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13, $14::uuid, $15)
            RETURNING student_id, first_name, last_name, enrollment_no;
        `;
        
        const studentResult = await client.query(studentQuery, [
            newUserId, first_name, last_name, email, phone_number || null,
            dob || null, gender || null, address || null, toUUID(course_id), toUUID(batch_id), safeBranchId,
            toUUID(created_by), admission_id, academic_session_id, enrollment_no
        ]);

        await client.query('COMMIT'); // Commit Transaction
        
        res.status(201).json({ 
            message: 'Student created successfully.', 
            student: studentResult.rows[0] 
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Fail Safe
        console.error('Student Creation Error:', error);
        
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Duplicate Data: Username, Email, or Enrollment No already exists.' });
        }
        res.status(500).json({ message: 'Failed to create student profile.', error: error.message });
    } finally {
        client.release();
    }
});
// =========================================================
// 3. GET: Single Student Details (Smart Lookup)
// =========================================================
router.get('/:id', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const idParam = req.params.id;
    const safeId = toUUID(idParam);

    if (!safeId) return res.status(400).json({ message: 'Invalid ID format.' });

    try {
        // FIX: Check BOTH student_id AND user_id columns
        // This ensures it works regardless of which ID the frontend sends
        const query = `
            SELECT s.*, u.username, u.role
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${USERS_TABLE} u ON s.user_id = u.id
            WHERE s.student_id = $1::uuid OR s.user_id = $1::uuid;
        `;
        const result = await pool.query(query, [safeId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching student details:', error);
        res.status(500).json({ message: 'Failed to retrieve student details.' });
    }
});

// =========================================================
// 4. PUT: Update Student
// =========================================================
router.put('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const studentId = req.params.id;
    const { updated_by } = getConfigIds(req);
    const {
        first_name, last_name, email, phone_number, dob, gender, 
        address, course_id, batch_id, status,
        user_id, enrollment_no
    } = req.body;

    const safeStudentId = toUUID(studentId);
    const safeUserId = toUUID(user_id);
    const safeUpdatedBy = toUUID(updated_by);

    if (!safeStudentId || !safeUserId) {
        return res.status(400).json({ message: 'Invalid ID format.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Update 'users' table
        const userUpdateQuery = `
            UPDATE ${USERS_TABLE} SET 
                email = $1, 
                phone_number = $2, 
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = $3::uuid AND role = 'Student';
        `;
        await client.query(userUpdateQuery, [email, phone_number || null, safeUserId]);

        // Update Student Profile
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        const addField = (field, value, cast = '') => {
             updateFields.push(`${field} = $${paramIndex++}${cast}`);
             updateValues.push(value);
        };

        addField('first_name', first_name);
        addField('last_name', last_name);
        addField('email', email);
        addField('phone_number', phone_number || null);
        addField('dob', dob || null);
        addField('gender', gender || null);
        addField('permanent_address', address || null);
        addField('status', status || 'Enrolled');
        
        addField('course_id', toUUID(course_id), '::uuid');
        addField('batch_id', toUUID(batch_id), '::uuid');
        addField('enrollment_no', enrollment_no || null);
        
        // Audit Fields
        addField('updated_by', safeUpdatedBy, '::uuid');
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE} SET
                ${updateFields.join(', ')}
            WHERE student_id = $${paramIndex++}::uuid
            RETURNING first_name, last_name; 
        `;
        
        updateValues.push(safeStudentId);

        const result = await client.query(studentUpdateQuery, updateValues);
        await client.query('COMMIT');
        
        res.status(200).json({ 
            message: 'Student profile updated successfully.',
            data: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Update Error:', error);
        res.status(500).json({ message: 'Failed to update student profile.', error: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 5. DELETE: Soft Delete Student
// =========================================================
router.delete('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) return res.status(400).json({ message: 'Invalid Student ID.' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if student exists
        const getRes = await client.query(`SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid`, [safeStudentId]);
        if (getRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const userId = getRes.rows[0].user_id;

        // Soft Delete Student
        await client.query(
            `UPDATE ${STUDENTS_TABLE} SET status = 'Inactive', deleted_at = CURRENT_TIMESTAMP WHERE student_id = $1::uuid`, 
            [safeStudentId]
        );

        // Soft Delete User Login
        if (userId) {
            await client.query(
                `UPDATE ${USERS_TABLE} SET is_active = FALSE, deleted_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, 
                [userId]
            );
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Student deactivated successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Deletion Error:', error);
        res.status(500).json({ message: 'Failed to deactivate student.', error: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 6. GET: Student Fee Records (Dashboard/Profile Support)
// =========================================================
router.get('/:id/fees', authenticateToken, async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) return res.status(400).json({ message: 'Invalid Student ID.' });

    try {
        const query = `
            SELECT * FROM fee_records 
            WHERE student_id = $1::uuid 
            ORDER BY due_date DESC;
        `;
        
        // Use nested try/catch to gracefully handle missing tables during setup
        try {
            const result = await pool.query(query, [safeStudentId]);
            res.status(200).json(result.rows);
        } catch (dbError) {
            console.warn("Fee table might not exist yet:", dbError.message);
            res.status(200).json([]); // Return empty list
        }
    } catch (error) {
        console.error('Error fetching fees:', error);
        res.status(500).json({ message: 'Failed to retrieve fee records.' });
    }
});

// =========================================================
// 7. GET: Library Books (Dashboard/Profile Support)
// =========================================================
router.get('/:id/library', authenticateToken, async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) return res.status(400).json({ message: 'Invalid Student ID.' });

    try {
        const query = `
            SELECT * FROM library_transactions 
            WHERE student_id = $1::uuid AND status = 'Issued'
            ORDER BY issue_date DESC;
        `;
        try {
            const result = await pool.query(query, [safeStudentId]);
            res.status(200).json(result.rows);
        } catch (dbError) {
            console.warn("Library table might not exist yet:", dbError.message);
            res.status(200).json([]); // Return empty list
        }
    } catch (error) {
        console.error('Error fetching library books:', error);
        res.status(500).json({ message: 'Failed to retrieve library records.' });
    }
});

// =========================================================
// 8. GET: My Teachers (Dashboard/Profile Support)
// =========================================================
router.get('/:id/teachers', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    try {
        const query = `
            SELECT 
                t.full_name, s.subject_name, t.email
            FROM teacher_allocations ta
            JOIN teachers t ON ta.teacher_id = t.id
            JOIN subjects s ON ta.subject_id = s.id
            JOIN students stu ON stu.batch_id = ta.batch_id
            WHERE stu.student_id = $1::uuid;
        `;
        try {
            const result = await pool.query(query, [safeStudentId]);
            res.status(200).json(result.rows);
        } catch (dbError) {
            console.warn("Teacher query failed:", dbError.message);
            res.status(200).json([]); // Return empty list
        }
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ message: 'Failed to retrieve teachers.' });
    }
});

module.exports = router;