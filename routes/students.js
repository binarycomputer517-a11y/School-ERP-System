// routes/students.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid'); 

// Database Table Constants
const USERS_TABLE = 'users'; 
const STUDENTS_TABLE = 'students'; 

// Define ALL non-Student roles that can manage records.
const STUDENT_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff', 'Teacher', 'HR'];


// =========================================================
// 1. STUDENT CREATION (POST /) 
// =========================================================

/**
 * @route   POST /api/students
 * @desc    Create a new user (role='student') and insert the corresponding student record.
 * @access  Private (Admin, Staff, Super Admin, Teacher, HR)
 */
router.post('/', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    
    // ⭐ FIX: Correctly retrieve the integer ID from the authenticated user object.
    const creatorId = req.user.userId; 

    const {
        username, password,
        admission_id, admission_date, academic_session_id, branch_id,
        first_name, last_name, middle_name, course_id, batch_id,
        gender, dob, blood_group, permanent_address, email, phone_number,
        parent_first_name, parent_last_name, parent_phone_number, parent_email,
        profile_image_path,
        signature_path
    } = req.body;

    // Basic Input Validation
    if (!username || !password || !first_name || !last_name || !admission_id || !course_id || !batch_id || !dob || !academic_session_id) {
        return res.status(400).json({ message: 'Missing required student fields (username, password, name, IDs, or DOB).' });
    }
    
    // This check should succeed with the authMiddleware fix.
    if (!creatorId) { 
        return res.status(403).json({ message: 'Forbidden: Invalid Creator ID from token context.' });
    }
    
    // Hash the password
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

        // --- Step 1: Insert into the 'users' table ---
        const userInsertQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, branch_id)
            VALUES ($1, $2, 'Student', $3)
            RETURNING id;
        `;
        const userInsertResult = await client.query(userInsertQuery, 
            [username, password_hash, branch_id]
        );
        const user_id = userInsertResult.rows[0].id; 

        // --- Step 2: Generate Enrollment Number ---
        const datePart = new Date(admission_date || Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
        const timePart = new Date().getTime().toString().slice(-6);
        const enrollment_no = `${datePart}-${timePart}-${admission_id}`;


        // --- Step 3: Insert into the 'students' table ---
        const studentInsertQuery = `
            INSERT INTO ${STUDENTS_TABLE} (
                user_id, admission_id, admission_date, academic_session_id, branch_id, 
                first_name, last_name, middle_name, course_id, batch_id, 
                gender, dob, email, phone_number, enrollment_no, permanent_address, 
                blood_group, created_by, parent_first_name, parent_last_name, 
                parent_phone_number, parent_email, profile_image_path, signature_path
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
            RETURNING student_id, enrollment_no;
        `;
        const studentInsertResult = await client.query(studentInsertQuery, [
            user_id, 
            admission_id,
            admission_date || new Date().toISOString().slice(0, 10),
            academic_session_id,
            branch_id,
            first_name,
            last_name,
            middle_name,
            course_id,
            batch_id,
            gender,
            dob,
            email,
            phone_number,
            enrollment_no,
            permanent_address,
            blood_group,
            creatorId, // INTEGER ID
            parent_first_name,
            parent_last_name,
            parent_phone_number,
            parent_email,
            profile_image_path || null, 
            signature_path || null
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
        if (error.code === '23505') { 
            message = 'Error: Admission ID or Username already exists.';
        } else if (error.code === '23503') { 
            message = 'Error: Academic Session, Course, or Batch ID is invalid.';
        }
        res.status(500).json({ message: message, error: error.message });

    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------------
// 2. READ & LIST ROUTES (GET) 
// -------------------------------------------------------------------------

/**
 * @route   GET /api/students
 * @desc    Get a list of all enrolled students for the management dashboard.
 * @access  Private (Admin, Staff, Super Admin, Teacher, HR)
 */
router.get('/', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, 
                s.admission_id,
                s.enrollment_no,
                s.first_name,
                s.last_name,
                s.gender,
                s.dob,
                s.admission_date,
                s.email,
                s.phone_number,
                u.username,
                s.course_id,
                s.batch_id,
                s.academic_session_id
            FROM 
                ${STUDENTS_TABLE} s
            JOIN 
                ${USERS_TABLE} u ON s.user_id = u.id 
            WHERE 
                s.deleted_at IS NULL
            ORDER BY 
                s.admission_id DESC;
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Fetch All Students Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student list.' });
    }
});

/**
 * @route   GET /api/students/:studentId
 * @desc    Get detailed profile information for a single student.
 * @access  Private (Management Roles, Student himself, or Parent)
 */
router.get('/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    const { role, userId: currentUserId } = req.user; 

    const isAuthorized = STUDENT_MANAGEMENT_ROLES.includes(role);

    try {
        const query = `
            SELECT 
                s.*, u.username, u.is_active
            FROM 
                ${STUDENTS_TABLE} s
            JOIN 
                ${USERS_TABLE} u ON s.user_id = u.id
            WHERE 
                s.student_id = $1 AND s.deleted_at IS NULL; 
        `;
        
        const result = await pool.query(query, [studentId]);
        const student = result.rows[0];

        if (!student) {
            return res.status(404).json({ message: 'Student not found.' });
        }
        
        const studentUserId = student.user_id; 
        const studentParentUserId = student.parent_user_id; 

        if (!isAuthorized && studentUserId !== currentUserId && studentParentUserId !== currentUserId) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this profile.' });
        }

        res.status(200).json(student);

    } catch (error) {
        console.error('Fetch Single Student Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student profile.' });
    }
});

// -------------------------------------------------------------------------
// 3. UPDATE ROUTE (PUT) 
// -------------------------------------------------------------------------

/**
 * @route   PUT /api/students/:studentId
 * @desc    Update an existing student's profile details.
 * @access  Private (Admin, Staff, Super Admin, Teacher, HR)
 */
router.put('/:studentId', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    const { studentId } = req.params;
    const updatedBy = req.user.userId; // Integer ID

    const { user_id, username } = req.body;
    const userIdStr = user_id; 

    if (!userIdStr || !studentId) {
        return res.status(400).json({ message: 'Missing user ID or student ID for update.' });
    }

    const newProfileImagePath = req.body.profile_image;
    const newSignaturePath = req.body.signature;

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        // 1. Update the 'users' table (Update username if provided)
        if (username) {
            const userUpdateQuery = `
                UPDATE ${USERS_TABLE}
                SET 
                    username = $1, 
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2 AND role = 'Student'
                RETURNING id;
            `;
            const userUpdateResult = await client.query(userUpdateQuery, [username, userIdStr]);

            if (userUpdateResult.rowCount === 0) {
                throw new Error('User record not found or not a student.');
            }
        }

        // 2. Dynamically build the Student Update Query
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
        
        // List of all updatable keys (for clarity and security)
        const studentUpdatableKeys = [
            'admission_id', 'admission_date', 'academic_session_id', 'branch_id', 'first_name', 
            'last_name', 'middle_name', 'course_id', 'batch_id', 'gender', 'dob', 'permanent_address', 
            'email', 'phone_number', 'roll_number', 'enrollment_no', 'city', 'state', 'zip_code', 
            'country', 'nationality', 'caste_category', 'mother_tongue', 'aadhaar_number', 
            'parent_first_name', 'parent_last_name', 'parent_phone_number', 'parent_email', 
            'parent_occupation', 'parent_annual_income', 'guardian_relation', 'emergency_contact_name', 
            'emergency_contact_number', 'blood_group', 'religion'
        ];

        studentUpdatableKeys.forEach(key => {
            addField(key, studentBodyFields[key]);
        });


        // --- File Path Updates (Conditional) ---
        if (newProfileImagePath !== undefined) {
            addField('profile_image_path', newProfileImagePath);
        }
        if (newSignaturePath !== undefined) {
            addField('signature_path', newSignaturePath);
        }
        
        // Ensure control fields are appended
        updateFields.push(`updated_by = $${paramIndex++}`);
        updateValues.push(updatedBy);
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);


        // Final Query Construction
        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE}
            SET ${updateFields.join(', ')}
            WHERE student_id = $${paramIndex++} AND user_id = $${paramIndex++}
            RETURNING student_id;
        `;
        
        updateValues.push(studentId); 
        updateValues.push(userIdStr);

        const studentUpdateResult = await client.query(studentUpdateQuery, updateValues);

        if (studentUpdateResult.rowCount === 0) {
            throw new Error('Student profile not found for update.');
        }

        await client.query('COMMIT'); 

        // 3. Send Success Response
        res.status(200).json({ 
            message: 'Student profile successfully updated.', 
            student_id: studentId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Profile Update Transaction Failed:', error.message);
        
        let message = 'Failed to update student profile due to a server error.';
        if (error.code === '23505') { 
            message = 'Error: Username already exists for another user or admission ID already exists.';
        } else if (error.code === '23503') { 
            message = 'Error: Academic Session, Course, or Batch ID is invalid.';
        }
        res.status(500).json({ message: message, error: error.message });

    } finally {
        client.release();
    }
});


// -------------------------------------------------------------------------
// 4. DELETE ROUTE (DELETE) 
// -------------------------------------------------------------------------

/**
 * @route   DELETE /api/students/:studentId
 * @desc    Soft-delete a student and their user account (set deleted_at).
 * @access  Private (Admin, Super Admin)
 */
router.delete('/:studentId', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { studentId } = req.params; 
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Get the user_id linked to the student 
        const getUserIdQuery = `SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1;`;
        const studentResult = await client.query(getUserIdQuery, [studentId]);

        if (studentResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const user_id = studentResult.rows[0].user_id; 

        // 2. Soft-delete the student record
        const studentDeleteQuery = `
            UPDATE ${STUDENTS_TABLE} 
            SET deleted_at = CURRENT_TIMESTAMP 
            WHERE student_id = $1;
        `;
        await client.query(studentDeleteQuery, [studentId]);

        // 3. Soft-delete the associated user account
        const userDeleteQuery = `
            UPDATE ${USERS_TABLE} 
            SET deleted_at = CURRENT_TIMESTAMP, is_active = FALSE
            WHERE id = $1 AND role = 'Student'; 
        `;
        await client.query(userDeleteQuery, [user_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Student and associated user account successfully deactivated/deleted.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Deletion Error:', error.message);
        res.status(500).json({ message: 'Failed to delete student.' });
    } finally {
        client.release();
    }
});


module.exports = router;