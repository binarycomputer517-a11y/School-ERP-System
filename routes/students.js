const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid'); 

// Database Table Constants
const USERS_TABLE = 'users'; 
const STUDENTS_TABLE = 'students'; 

// Define ALL roles that can manage records. (Used for authorize middleware)
const STUDENT_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff', 'Teacher', 'HR'];


// =========================================================
// 1. STUDENT CREATION (POST /) 
// =========================================================

/**
 * @route   POST /api/students
 * @desc    Create a new user (role='Student') and insert the corresponding student record.
 * @access  Private (Admin, Staff, Super Admin, Teacher, HR)
 */
router.post('/', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    
    // req.user.id is the UUID PK
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

        // --- Step 1: Insert into the 'users' table (PK is UUID) ---
        const userInsertQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, branch_id)
            VALUES ($1, $2, 'Student', $3::uuid)
            RETURNING id;
        `;
        const userInsertResult = await client.query(userInsertQuery, 
            [username, password_hash, branch_id]
        );
        const user_id = userInsertResult.rows[0].id; // This is the new Student User UUID

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
                parent_phone_number, parent_email, profile_image_path, signature_path, parent_user_id
            )
            -- created_by is $18. We send NULL to bypass the INTEGER/UUID crash.
            VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10::uuid, 
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 
                    $21, $22, $23, $24, $25::uuid)
            RETURNING student_id, enrollment_no;
        `;
        
        // --- CRITICAL FIX: Send NULL for the INTEGER FK created_by field ($18) ---
        // This avoids the 'invalid input syntax for type integer' error.
        const createdByNull = null; 

        const studentInsertResult = await client.query(studentInsertQuery, [
            user_id, // $1 (UUID FK)
            admission_id, // $2
            admission_date || new Date().toISOString().slice(0, 10), // $3
            academic_session_id, // $4 (UUID)
            branch_id, // $5 (UUID)
            first_name, // $6
            last_name, // $7
            middle_name, // $8
            course_id, // $9 (UUID)
            batch_id, // $10 (UUID)
            gender, // $11
            dob, // $12
            email, // $13
            phone_number, // $14
            enrollment_no, // $15
            permanent_address, // $16
            blood_group, // $17
            createdByNull, // $18 (CRITICAL FIX: Insert NULL into the INTEGER created_by column)
            parent_first_name, // $19
            parent_last_name, // $20
            parent_phone_number, // $21
            parent_email, // $22
            profile_image_path || null, // $23
            signature_path || null, // $24
            parent_user_id || null // $25 (UUID or NULL)
        ]);

        await client.query('COMMIT'); 

        res.status(201).json({ 
            message: 'Student successfully enrolled.', 
            student_id: studentInsertResult.rows[0].student_id, // Student PK is UUID
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
        } else if (error.code === '22P02') {
             message = `Error: Invalid data format for a UUID column. Error detail: ${error.message}`;
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
    
    // 1. Get user IDs and Role (Role is lowercased by authMiddleware)
    const { role, id: currentUserId } = req.user; // currentUserId is the UUID PK
    
    // Create a lowercase list of authorized roles
    const authorizedRoles = STUDENT_MANAGEMENT_ROLES.map(r => r.toLowerCase());
    const isAuthorized = authorizedRoles.includes(role);

    try {
        // Query to fetch student data, joining by the user's UUID
        const query = `
            SELECT 
                s.*, u.username, u.is_active
            FROM 
                ${STUDENTS_TABLE} s
            JOIN 
                ${USERS_TABLE} u ON s.user_id = u.id
            WHERE 
                s.student_id = $1::uuid AND s.deleted_at IS NULL; 
        `;
        
        const result = await pool.query(query, [studentId]);
        const student = result.rows[0];

        if (!student) {
            return res.status(404).json({ message: 'Student not found.' });
        }
        
        // 2. Extract linking IDs 
        const studentUserId = student.user_id;       
        const studentParentUserId = student.parent_user_id; 

        // 3. Self/Parent Check (UUID-to-UUID comparison)
        const isSelf = studentUserId === currentUserId;
        const isParent = studentParentUserId === currentUserId;

        // --- Authorization Check ---
        if (!isAuthorized && !isSelf && !isParent) {
            // If not staff AND not requesting own data AND not requesting child's data
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this profile.' });
        }

        res.status(200).json(student);

    } catch (error) {
        console.error('Fetch Single Student Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student profile.' });
    }
});

/**
 * @route   GET /api/students/course/:courseId/batch/:batchId
 * @desc    Get a list of students filtered by specific course and batch IDs (Needed for Marks Entry).
 * @access  Private (Management Roles, Teachers)
 */
router.get('/course/:courseId/batch/:batchId', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    const { courseId, batchId } = req.params;

    if (!courseId || !batchId) {
        return res.status(400).json({ message: 'Course ID and Batch ID are required parameters.' });
    }

    try {
        const query = `
            SELECT 
                s.student_id, 
                s.enrollment_no,
                s.first_name,
                s.last_name,
                s.email,
                s.course_id,
                s.batch_id
            FROM 
                ${STUDENTS_TABLE} s
            WHERE 
                s.course_id = $1::uuid AND s.batch_id = $2::uuid AND s.deleted_at IS NULL
            ORDER BY 
                s.enrollment_no;
        `;
        
        const result = await pool.query(query, [courseId, batchId]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Fetch Students by Course/Batch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve filtered student list.' });
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
    
    // req.user.id is the UUID PK
    const updatedBy = req.user.id; 

    const { user_id, username, first_name, last_name } = req.body;
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
                WHERE id = $2::uuid AND role = 'Student'
                RETURNING id;
            `;
            // user_id is UUID PK
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
        
        // List of all updatable keys 
        const studentUpdatableKeys = [
            'admission_id', 'admission_date', 'academic_session_id', 'branch_id', 'first_name', 
            'last_name', 'middle_name', 'course_id', 'batch_id', 'gender', 'dob', 'permanent_address', 
            'email', 'phone_number', 'roll_number', 'enrollment_no', 'city', 'state', 'zip_code', 
            'country', 'nationality', 'caste_category', 'mother_tongue', 'aadhaar_number', 
            'parent_first_name', 'parent_last_name', 'parent_phone_number', 'parent_email', 
            'parent_occupation', 'parent_annual_income', 'guardian_relation', 'emergency_contact_name', 
            'emergency_contact_number', 'blood_group', 'religion', 'parent_user_id',
            'created_by', 'updated_by' // Include audit columns for explicit handling
        ];

        studentUpdatableKeys.forEach(key => {
            // Special handling for UUID FKs
            if (['branch_id', 'course_id', 'batch_id', 'academic_session_id', 'parent_user_id'].includes(key) && studentBodyFields[key]) {
                 updateFields.push(`${key} = $${paramIndex++}::uuid`);
                 updateValues.push(studentBodyFields[key]);
            // Special handling for audit columns which are still INTEGER
            } else if (['created_by', 'updated_by'].includes(key) && studentBodyFields[key] !== undefined) {
                // If the code tries to update a value, we assume it's NULL or the correct INTEGER PK
                // This is a safety measure against UUID insertion here.
                updateFields.push(`${key} = $${paramIndex++}`);
                updateValues.push(studentBodyFields[key] || null); 
            } else {
                 addField(key, studentBodyFields[key]);
            }
        });


        // --- File Path Updates (Conditional) ---
        if (newProfileImagePath !== undefined) {
            addField('profile_image_path', newProfileImagePath);
        }
        if (newSignaturePath !== undefined) {
            addField('signature_path', newSignaturePath);
        }
        
        // Ensure control fields are appended (updated_by is UUID PK)
        updateFields.push(`updated_by = $${paramIndex++}::uuid`);
        updateValues.push(updatedBy);
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);


        // Final Query Construction
        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE}
            SET ${updateFields.join(', ')}
            WHERE student_id = $${paramIndex++}::uuid AND user_id = $${paramIndex++}::uuid
            RETURNING student_id;
        `;
        
        updateValues.push(studentId); // studentId is UUID
        updateValues.push(userIdStr); // userIdStr is UUID

        const studentUpdateResult = await client.query(studentUpdateQuery, updateValues);

        if (studentUpdateResult.rowCount === 0) {
            throw new Error('Student profile not found for update.');
        }

        await client.query('COMMIT'); 

        // 3. Send Success Response
        res.status(200).json({ 
            message: 'Student profile successfully updated.', 
            student_id: studentId,
            first_name: first_name, 
            last_name: last_name    
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Profile Update Transaction Failed:', error.message);
        
        let message = 'Failed to update student profile due to a server error.';
        if (error.code === '23505') { 
            message = 'Error: Username already exists for another user or admission ID already exists.';
        } else if (error.code === '23503') { 
            message = 'Error: Academic Session, Course, or Batch ID is invalid.';
        } else if (error.code === '22P02') {
             message = 'Error: Invalid data format for a UUID column. Check your input.';
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

        // 1. Get the user_id linked to the student (user_id is UUID FK)
        const getUserIdQuery = `SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid;`;
        const studentResult = await client.query(getUserIdQuery, [studentId]);

        if (studentResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const user_id = studentResult.rows[0].user_id; // UUID

        // 2. Soft-delete the student record
        const studentDeleteQuery = `
            UPDATE ${STUDENTS_TABLE} 
            SET deleted_at = CURRENT_TIMESTAMP 
            WHERE student_id = $1::uuid;
        `;
        await client.query(studentDeleteQuery, [studentId]);

        // 3. Soft-delete the associated user account (id is UUID PK)
        const userDeleteQuery = `
            UPDATE ${USERS_TABLE} 
            SET deleted_at = CURRENT_TIMESTAMP, is_active = FALSE
            WHERE id = $1::uuid AND role = 'Student'; 
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