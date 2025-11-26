// routes/students.js - FINAL CORRECTED VERSION

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const bcrypt = require('bcryptjs');
const saltRounds = 10;
const { authenticateToken, authorize } = require('../authMiddleware');

const STUDENTS_TABLE = 'students';
const USERS_TABLE = 'users';
const BRANCHES_TABLE = 'branches';
const COURSES_TABLE = 'courses';
const BATCHES_TABLE = 'batches';

// --- Role Definitions ---
const CRUD_ROLES = ['Super Admin', 'Admin', 'HR', 'Registrar'];
const VIEW_ROLES = ['Super Admin', 'Admin', 'HR', 'Registrar', 'Teacher', 'Coordinator'];

// --- Helper: Get Configuration IDs ---
function getConfigIds(req) {
    const branch_id = req.user.branch_id; 
    return { branch_id, created_by: req.user.id, updated_by: req.user.id };
}

// --- Helper: Safely Convert to UUID or Null ---
// This fixes the "invalid input syntax for type uuid: """ error
function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    return value.trim();
}

// =========================================================
// 1. GET: Main List (Full Details)
// =========================================================
router.get('/', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, 
                s.first_name, s.last_name, s.enrollment_no, 
                s.email, s.phone_number, s.gender, s.dob,
                s.status,
                u.username, u.role, u.id AS user_id,
                c.course_name, b.batch_name, br.branch_name
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
// 2. POST: Create New Student (Includes User Creation)
// =========================================================
router.post('/', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const {
        username, password, first_name, last_name, email, phone_number,
        dob, gender, address, course_id, batch_id,
        initial_role = 'Student'
    } = req.body;
    
    const { branch_id, created_by } = getConfigIds(req);

    if (!username || !password || !first_name || !last_name || !course_id || !batch_id) {
        return res.status(400).json({ message: 'Missing required student fields.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Hash Password
        const password_hash = await bcrypt.hash(password, saltRounds);

        // 2. Create User Account
        const safeBranchId = toUUID(branch_id);

        const userQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, email, phone_number, branch_id)
            VALUES ($1, $2, 'Student', $3, $4, $5::uuid)
            RETURNING id;
        `;
        const userResult = await client.query(userQuery, [username, password_hash, email, phone_number || null, safeBranchId]);
        const newUserId = userResult.rows[0].id;

        // 3. Create Student Profile
        const studentQuery = `
            INSERT INTO ${STUDENTS_TABLE} (
                user_id, first_name, last_name, email, phone_number, 
                dob, gender, permanent_address, course_id, batch_id, branch_id,
                created_by
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::uuid, $11::uuid, $12::uuid)
            RETURNING student_id, first_name, last_name;
        `;
        
        const studentResult = await client.query(studentQuery, [
            newUserId, first_name, last_name, email, phone_number || null,
            dob || null, gender || null, address || null, toUUID(course_id), toUUID(batch_id), safeBranchId,
            toUUID(created_by)
        ]);

        await client.query('COMMIT');
        res.status(201).json({ 
            message: 'Student created successfully', 
            student: studentResult.rows[0] 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Creation Error:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Username or Email already exists.' });
        }
        res.status(500).json({ message: 'Failed to create student profile.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 3. GET: Single Student Details
// =========================================================
router.get('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const studentId = req.params.id;
    
    const safeStudentId = toUUID(studentId);
    if (!safeStudentId) return res.status(400).json({ message: 'Invalid Student ID.' });

    try {
        const query = `
            SELECT s.*, u.username, u.role
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${USERS_TABLE} u ON s.user_id = u.id
            WHERE s.student_id = $1::uuid;
        `;
        const result = await pool.query(query, [safeStudentId]);

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
// 4. PUT: Update Student (FIXED: No duplicate assignments)
// =========================================================
router.put('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const studentId = req.params.id;
    const { updated_by } = getConfigIds(req);
    const {
        first_name, last_name, email, phone_number, dob, gender, 
        address, course_id, batch_id, status,
        user_id 
    } = req.body;

    const safeStudentId = toUUID(studentId);
    const safeUserId = toUUID(user_id);
    const safeUpdatedBy = toUUID(updated_by);

    if (!safeStudentId || !safeUserId) {
        return res.status(400).json({ message: 'Invalid Student ID or User ID.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Update 'users' table
        const userUpdateQuery = `
            UPDATE ${USERS_TABLE} SET 
                email = $1, 
                phone_number = $2, 
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = $3::uuid AND role = 'Student';
        `;
        await client.query(userUpdateQuery, [email, phone_number || null, safeUserId]);

        // 2. Update Student Profile
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        const addField = (field, value, cast = '') => {
             updateFields.push(`${field} = $${paramIndex++}${cast}`);
             updateValues.push(value);
        };

        // Basic fields
        addField('first_name', first_name);
        addField('last_name', last_name);
        addField('email', email);
        addField('phone_number', phone_number || null);
        addField('dob', dob || null);
        addField('gender', gender || null);
        addField('permanent_address', address || null);
        addField('status', status || 'Enrolled');
        
        // UUID fields (Sanitized)
        addField('course_id', toUUID(course_id), '::uuid');
        addField('batch_id', toUUID(batch_id), '::uuid');
        
        // Audit Fields (Manually added here to avoid duplication)
        addField('updated_by', safeUpdatedBy, '::uuid');
        
        // Add static timestamp
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE} SET
                ${updateFields.join(', ')}
            WHERE student_id = $${paramIndex++}::uuid
        `;
        
        updateValues.push(safeStudentId);

        await client.query(studentUpdateQuery, updateValues);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Student profile updated successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Update Error:', error);
        
        if (error.code === '22P02') {
             return res.status(400).json({ message: 'Invalid input format (e.g., invalid UUID).' });
        }
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

        // 1. Get user_id before deleting
        const getRes = await client.query(`SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid`, [safeStudentId]);
        if (getRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const userId = getRes.rows[0].user_id;

        // 2. Delete Student (Hard delete)
        await client.query(`DELETE FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid`, [safeStudentId]);

        // 3. Soft Delete User
        if (userId) {
            await client.query(`UPDATE ${USERS_TABLE} SET is_active = FALSE, deleted_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, [userId]);
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Student deleted successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Deletion Error:', error);
        res.status(500).json({ message: 'Failed to delete student.' });
    } finally {
        client.release();
    }
});

module.exports = router;