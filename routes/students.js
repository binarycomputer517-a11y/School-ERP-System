const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid'); 

// =========================================================
// CONSTANTS & CONFIGURATION
// =========================================================
const USERS_TABLE = 'users'; 
const STUDENTS_TABLE = 'students'; 

// FIXED: Table name must match your database (student_invoices)
const INVOICES_TABLE = 'student_invoices'; 
const PAYMENTS_TABLE = 'fee_payments';

// Define ALL roles that can manage records
const STUDENT_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff', 'Teacher', 'HR'];

// =========================================================
// 1. STUDENT CREATION (POST /) 
// =========================================================
router.post('/', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    
    const creatorUUID = req.user.id; 

    const {
        username, password,
        admission_id, admission_date, academic_session_id, branch_id,
        first_name, last_name, middle_name, course_id, batch_id,
        gender, dob, blood_group, permanent_address, email, phone_number,
        parent_first_name, parent_last_name, parent_phone_number, parent_email,
        profile_image_path,
        signature_path,
        parent_user_id 
    } = req.body;

    // Basic Input Validation
    if (!username || !password || !first_name || !last_name || !admission_id || !course_id || !batch_id || !dob || !academic_session_id) {
        return res.status(400).json({ message: 'Missing required student fields (username, password, name, IDs, or DOB).' });
    }
    
    if (!creatorUUID) { 
        return res.status(403).json({ message: 'Forbidden: Invalid Creator ID from token context.' });
    }
    
    const saltRounds = 10;
    let password_hash;
    try {
        password_hash = await bcrypt.hash(password, saltRounds);
    } catch (err) {
        console.error('Password Hashing Error:', err);
        return res.status(500).json({ message: 'Failed to process password.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // --- Step 1: Insert into 'users' ---
        const userInsertQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, branch_id)
            VALUES ($1, $2, 'Student', $3::uuid)
            RETURNING id;
        `;
        const userInsertResult = await client.query(userInsertQuery, [username, password_hash, branch_id]);
        const user_id = userInsertResult.rows[0].id;

        // --- Step 2: Generate Enrollment Number ---
        const datePart = new Date(admission_date || Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
        const timePart = new Date().getTime().toString().slice(-6);
        const enrollment_no = `${datePart}-${timePart}-${admission_id}`;

        // --- Step 3: Insert into 'students' ---
        // Handling NULLs for legacy Integer FKs if necessary
        const createdByNull = null; 
        
        let finalParentUserId = parent_user_id || null;
        if (finalParentUserId && isNaN(parseInt(finalParentUserId)) && finalParentUserId.length > 10) {
            finalParentUserId = null; 
        } else if (finalParentUserId) {
            finalParentUserId = parseInt(finalParentUserId); 
        } else if (parent_user_id && parent_user_id.length === 36) {
            finalParentUserId = parent_user_id;
        } else {
             finalParentUserId = null;
        }

        const studentInsertQuery = `
            INSERT INTO ${STUDENTS_TABLE} (
                user_id, admission_id, admission_date, academic_session_id, branch_id, 
                first_name, last_name, middle_name, course_id, batch_id, 
                gender, dob, email, phone_number, enrollment_no, permanent_address, 
                blood_group, created_by, parent_first_name, parent_last_name, 
                parent_phone_number, parent_email, profile_image_path, signature_path, parent_user_id
            )
            VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10::uuid, 
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 
                    $21, $22, $23, $24, $25)
            RETURNING student_id, enrollment_no;
        `;
        
        const studentInsertResult = await client.query(studentInsertQuery, [
            user_id, admission_id, admission_date || new Date().toISOString().slice(0, 10),
            academic_session_id, branch_id, first_name, last_name, middle_name,
            course_id, batch_id, gender, dob, email, phone_number, enrollment_no,
            permanent_address, blood_group, createdByNull, parent_first_name, parent_last_name,
            parent_phone_number, parent_email, profile_image_path || null, signature_path || null, finalParentUserId
        ]);

        await client.query('COMMIT'); 

        res.status(201).json({ 
            message: 'Student successfully enrolled.', 
            student_id: studentInsertResult.rows[0].student_id,
            enrollment_no: studentInsertResult.rows[0].enrollment_no
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Enrollment Transaction Failed:', error.message);
        
        let message = 'Failed to enroll student due to a server error.';
        if (error.code === '23505') message = 'Error: Admission ID or Username already exists.';
        else if (error.code === '23503') message = 'Error: Academic Session, Course, or Batch ID is invalid.';
        else if (error.code === '22P02') message = `Error: Invalid UUID format. Detail: ${error.message}`;
        
        res.status(500).json({ message: message, error: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. READ & LIST ROUTES (GET) 
// =========================================================

/**
 * @route   GET /api/students
 * @desc    Get a list of all enrolled students.
 */
router.get('/', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, s.admission_id, s.enrollment_no, s.first_name, s.last_name,
                s.gender, s.dob, s.admission_date, s.email, s.phone_number,
                u.username, s.course_id, s.batch_id, s.academic_session_id
            FROM ${STUDENTS_TABLE} s
            JOIN ${USERS_TABLE} u ON s.user_id = u.id 
            WHERE s.deleted_at IS NULL
            ORDER BY s.admission_id DESC;
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Fetch All Students Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student list.' });
    }
});

/**
 * @route   GET /api/students/refundable
 * @desc    Get a list of all students with a positive refundable balance (Fixes 500 Error).
 */
router.get('/refundable', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    try {
        // FIXED: Using correct table name (student_invoices) and dynamic calculation
        const query = `
            SELECT 
                s.student_id, 
                u.username AS student_name, -- Added username
                s.first_name, 
                s.last_name, 
                s.roll_number,
                u.phone_number,
                c.course_name,
                (
                    COALESCE((SELECT SUM(p.amount) 
                              FROM ${PAYMENTS_TABLE} p 
                              JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id 
                              WHERE i.student_id = s.student_id), 0)
                    - 
                    COALESCE((SELECT SUM(total_amount) 
                              FROM ${INVOICES_TABLE} 
                              WHERE student_id = s.student_id AND status != 'Waived'), 0)
                ) AS refundable_balance
            FROM students s
            JOIN users u ON s.user_id = u.id
            LEFT JOIN courses c ON s.course_id = c.id
            WHERE u.is_active = TRUE
            -- Filter logic can be done in DB or JS. Doing in DB is faster:
            AND (
                COALESCE((SELECT SUM(p.amount) FROM ${PAYMENTS_TABLE} p JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id WHERE i.student_id = s.student_id), 0)
                >
                COALESCE((SELECT SUM(total_amount) FROM ${INVOICES_TABLE} WHERE student_id = s.student_id AND status != 'Waived'), 0)
            )
        `;
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows);

    } catch (error) {
        console.error('Refundable Students Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve students eligible for refund.', error: error.message });
    }
});

/**
 * @route   GET /api/students/:studentId
 * @desc    Get detailed profile information.
 */
router.get('/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    const { role, id: currentUserId } = req.user;
    
    const authorizedRoles = STUDENT_MANAGEMENT_ROLES.map(r => r.toLowerCase());
    const isAuthorized = authorizedRoles.includes(role);

    try {
        const query = `
            SELECT s.*, u.username, u.is_active
            FROM ${STUDENTS_TABLE} s
            JOIN ${USERS_TABLE} u ON s.user_id = u.id
            WHERE s.student_id = $1::uuid AND s.deleted_at IS NULL; 
        `;
        
        const result = await pool.query(query, [studentId]);
        const student = result.rows[0];

        if (!student) return res.status(404).json({ message: 'Student not found.' });
        
        const isSelf = student.user_id === currentUserId;
        const isParent = student.parent_user_id === currentUserId;

        if (!isAuthorized && !isSelf && !isParent) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission.' });
        }

        res.status(200).json(student);

    } catch (error) {
        console.error('Fetch Single Student Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student profile.' });
    }
});

/**
 * @route   GET /api/students/course/:courseId/batch/:batchId
 */
router.get('/course/:courseId/batch/:batchId', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    const { courseId, batchId } = req.params;

    if (!courseId || !batchId) return res.status(400).json({ message: 'Course ID and Batch ID are required.' });

    try {
        const query = `
            SELECT s.student_id, s.enrollment_no, s.first_name, s.last_name, s.email, s.course_id, s.batch_id
            FROM ${STUDENTS_TABLE} s
            WHERE s.course_id = $1::uuid AND s.batch_id = $2::uuid AND s.deleted_at IS NULL
            ORDER BY s.enrollment_no;
        `;
        
        const result = await pool.query(query, [courseId, batchId]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Fetch Students by Course/Batch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve filtered student list.' });
    }
});

// =========================================================
// 3. UPDATE ROUTE (PUT) 
// =========================================================
router.put('/:studentId', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    const { studentId } = req.params;
    const updatedBy = req.user.id; 
    const { user_id, username, first_name, last_name } = req.body;
    const userIdStr = user_id; 

    if (!userIdStr || !studentId) return res.status(400).json({ message: 'Missing user ID or student ID.' });

    const newProfileImagePath = req.body.profile_image;
    const newSignaturePath = req.body.signature;

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        // 1. Update 'users' table
        if (username) {
            const userUpdateQuery = `
                UPDATE ${USERS_TABLE} SET username = $1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $2::uuid AND role = 'Student' RETURNING id;
            `;
            const userUpdateResult = await client.query(userUpdateQuery, [username, userIdStr]);
            if (userUpdateResult.rowCount === 0) throw new Error('User record not found.');
        }
        
        // Fetch serial_id for legacy integer audit columns
        const creatorIntIdRes = await client.query(`SELECT serial_id FROM ${USERS_TABLE} WHERE id = $1::uuid`, [updatedBy]);
        const updatedByIntId = creatorIntIdRes.rows[0]?.serial_id || null; 

        // 2. Build Student Update Query
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        const addField = (fieldName, value) => {
            if (value !== undefined) {
                updateFields.push(`${fieldName} = $${paramIndex++}`);
                updateValues.push(value === '' ? null : value);
            }
        };

        const studentBodyFields = req.body;
        const studentUpdatableKeys = [
            'admission_id', 'admission_date', 'academic_session_id', 'branch_id', 'first_name', 
            'last_name', 'middle_name', 'course_id', 'batch_id', 'gender', 'dob', 'permanent_address', 
            'email', 'phone_number', 'roll_number', 'enrollment_no', 'city', 'state', 'zip_code', 
            'country', 'nationality', 'caste_category', 'mother_tongue', 'aadhaar_number', 
            'parent_first_name', 'parent_last_name', 'parent_phone_number', 'parent_email', 
            'parent_occupation', 'parent_annual_income', 'guardian_relation', 'emergency_contact_name', 
            'emergency_contact_number', 'blood_group', 'religion', 'parent_user_id',
            'created_by', 'updated_by'
        ];

        studentUpdatableKeys.forEach(key => {
            if (['branch_id', 'course_id', 'batch_id', 'academic_session_id', 'parent_user_id'].includes(key) && studentBodyFields[key]) {
                 updateFields.push(`${key} = $${paramIndex++}::uuid`);
                 updateValues.push(studentBodyFields[key]);
            } else if (key === 'created_by' || key === 'updated_by') {
                 updateFields.push(`${key} = $${paramIndex++}`);
                 updateValues.push(updatedByIntId || null); 
            } else {
                 addField(key, studentBodyFields[key]);
            }
        });

        if (newProfileImagePath !== undefined) addField('profile_image_path', newProfileImagePath);
        if (newSignaturePath !== undefined) addField('signature_path', newSignaturePath);
        
        updateFields.push(`updated_by = $${paramIndex++}::uuid`); 
        updateValues.push(updatedBy);
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE}
            SET ${updateFields.join(', ')}
            WHERE student_id = $${paramIndex++}::uuid AND user_id = $${paramIndex++}::uuid
            RETURNING student_id;
        `;
        
        updateValues.push(studentId);
        updateValues.push(userIdStr);

        const studentUpdateResult = await client.query(studentUpdateQuery, updateValues);
        if (studentUpdateResult.rowCount === 0) throw new Error('Student profile not found.');

        await client.query('COMMIT'); 
        res.status(200).json({ message: 'Student profile updated.', student_id: studentId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update Failed:', error.message);
        res.status(500).json({ message: 'Failed to update student profile.', error: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 4. DELETE ROUTE (DELETE) 
// =========================================================
router.delete('/:studentId', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { studentId } = req.params; 
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const getUserIdQuery = `SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid;`;
        const studentResult = await client.query(getUserIdQuery, [studentId]);

        if (studentResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const user_id = studentResult.rows[0].user_id; 

        await client.query(`UPDATE ${STUDENTS_TABLE} SET deleted_at = CURRENT_TIMESTAMP WHERE student_id = $1::uuid;`, [studentId]);
        await client.query(`UPDATE ${USERS_TABLE} SET deleted_at = CURRENT_TIMESTAMP, is_active = FALSE WHERE id = $1::uuid AND role = 'Student';`, [user_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Student successfully deleted.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete Error:', error.message);
        res.status(500).json({ message: 'Failed to delete student.' });
    } finally {
        client.release();
    }
});

module.exports = router;