// routes/students.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid'); // Still needed if other UUIDs (like course_id) are used

// Constants (Define roles that can manage students)
const STUDENT_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff'];

// Database Table Constants
const USERS_TABLE = 'users'; 
const STUDENTS_TABLE = 'students'; 

// =========================================================
// 1. STUDENT CREATION (POST /) - Optimized for INTEGER FKs
// =========================================================

/**
 * @route   POST /api/students
 * @desc    Create a new user (role='student') and insert the corresponding student record.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.post('/', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    // CRITICAL FIX: Ensure creatorId is an integer for SQL binding
    const creatorId = parseInt(req.user.id); 

    const {
        username, password,
        admission_id, admission_date, academic_session_id, branch_id,
        first_name, last_name, middle_name, course_id, batch_id,
        gender, dob, blood_group, permanent_address, email, phone_number,
        parent_first_name, parent_last_name, parent_phone_number, parent_email
    } = req.body;

    // Basic Input Validation
    if (!username || !password || !first_name || !last_name || !admission_id || !course_id || !batch_id || !dob || !academic_session_id) {
        return res.status(400).json({ message: 'Missing required student fields (username, password, name, IDs, or DOB).' });
    }
    if (isNaN(creatorId)) { // Validate creatorId after parsing
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
        await client.query('BEGIN'); // Start transaction

        // --- Step 1: Insert into the 'users' table (PK is INTEGER auto-increment) ---
        const userInsertQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, branch_id)
            VALUES ($1, $2, 'Student', $3)
            RETURNING id;
        `;
        const userInsertResult = await client.query(userInsertQuery, 
            [username, password_hash, branch_id]
        );
        // user_id is the INTEGER PK returned from the DB
        const user_id = userInsertResult.rows[0].id; 

        // --- Step 2: Generate Enrollment Number (Example) ---
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
                parent_phone_number, parent_email
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
            RETURNING student_id, enrollment_no;
        `;
        const studentInsertResult = await client.query(studentInsertQuery, [
            user_id, // INTEGER FK
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
            creatorId, // INTEGER FK
            parent_first_name,
            parent_last_name,
            parent_phone_number,
            parent_email
        ]);

        await client.query('COMMIT'); // Commit both operations if successful

        // --- Step 4: Send Success Response ---
        res.status(201).json({ 
            message: 'Student successfully enrolled.', 
            student_id: studentInsertResult.rows[0].student_id,
            enrollment_no: studentInsertResult.rows[0].enrollment_no
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Roll back changes if any step failed
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

// =========================================================
// 2. READ & LIST ROUTES (GET) - Corrected for Students PK
// =========================================================

/**
 * @route   GET /api/students
 * @desc    Get a list of all enrolled students for the management dashboard.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, -- Used student_id as PK name
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
                ${USERS_TABLE} u ON s.user_id = u.id -- u.id is INTEGER, s.user_id is INTEGER
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
 * @access  Private (Admin, Staff, Student himself/Parent)
 */
router.get('/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    const { role, id: currentUserId } = req.user;

    // Authorization Check: Must be management OR the student/parent user linked to this student ID
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
                s.student_id = $1 AND s.deleted_at IS NULL; -- Using student_id as PK
        `;
        
        const result = await pool.query(query, [studentId]);
        const student = result.rows[0];

        if (!student) {
            return res.status(404).json({ message: 'Student not found.' });
        }
        
        // CRITICAL FIX: Ensure user_id and currentUserId are comparable (both are integers)
        const studentUserId = student.user_id; 
        const studentParentUserId = student.parent_user_id;
        const currentUserIdInt = parseInt(currentUserId);


        // Check if the logged-in non-management user is the student or their parent
        if (!isAuthorized && studentUserId !== currentUserIdInt && studentParentUserId !== currentUserIdInt) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this profile.' });
        }

        res.status(200).json(student);

    } catch (error) {
        console.error('Fetch Single Student Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student profile.' });
    }
});


// =========================================================
// 3. UPDATE ROUTE (PUT) - Optimized for INTEGER FKs
// =========================================================

/**
 * @route   PUT /api/students/:studentId
 * @desc    Update an existing student's profile details.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.put('/:studentId', authenticateToken, authorize(STUDENT_MANAGEMENT_ROLES), async (req, res) => {
    const { studentId } = req.params;
    // CRITICAL FIX: Ensure updatedBy is an integer
    const updatedBy = parseInt(req.user.id); 

    const {
        user_id, // Mandatory to link for update
        username, email, phone_number,
        first_name, last_name, middle_name, 
        course_id, batch_id, gender, dob, 
        blood_group, permanent_address, 
        parent_first_name, parent_last_name, parent_phone_number, parent_email
    } = req.body;

    // CRITICAL FIX: Ensure user_id from body is an integer
    const userIdInt = parseInt(user_id); 

    if (!userIdInt || isNaN(userIdInt) || !first_name || !last_name || !course_id || !batch_id || !dob) {
        return res.status(400).json({ message: 'Missing required fields for update.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction

        // --- Step 1: Update the 'users' table (Only update username) ---
        const userUpdateQuery = `
            UPDATE ${USERS_TABLE}
            SET 
                username = $1, 
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND role = 'Student'
            RETURNING id;
        `;
        const userUpdateResult = await client.query(userUpdateQuery, 
            [username, userIdInt]
        );

        if (userUpdateResult.rowCount === 0) {
            throw new Error('User record not found or not a student.');
        }

        // --- Step 2: Update the 'students' table (All student details including email/phone) ---
        // $17 and $18 added for email and phone_number
        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE}
            SET 
                first_name = $1, last_name = $2, middle_name = $3, 
                course_id = $4, batch_id = $5, gender = $6, dob = $7, 
                blood_group = $8, permanent_address = $9, 
                parent_first_name = $10, parent_last_name = $11, 
                parent_phone_number = $12, parent_email = $13,
                updated_by = $14,
                email = $17,
                phone_number = $18,
                updated_at = CURRENT_TIMESTAMP
            WHERE student_id = $15 AND user_id = $16
            RETURNING student_id;
        `;
        const studentUpdateResult = await client.query(studentUpdateQuery, [
            first_name, last_name, middle_name, course_id, batch_id, gender, dob, 
            blood_group, permanent_address, parent_first_name, parent_last_name, 
            parent_phone_number, parent_email, 
            updatedBy, // INTEGER FK
            studentId, 
            userIdInt, // INTEGER FK
            email, phone_number
        ]);

        if (studentUpdateResult.rowCount === 0) {
            throw new Error('Student profile not found for update.');
        }

        await client.query('COMMIT'); 

        // --- Step 3: Send Success Response ---
        res.status(200).json({ 
            message: 'Student profile successfully updated.', 
            student_id: studentId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Profile Update Transaction Failed:', error.message);
        
        let message = 'Failed to update student profile due to a server error.';
        if (error.code === '23505') { 
            message = 'Error: Username already exists for another user.';
        }
        res.status(500).json({ message: message, error: error.message });

    } finally {
        client.release();
    }
});


// =========================================================
// 4. DELETE ROUTE (DELETE) - Optimized for INTEGER FKs
// =========================================================

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

        // 1. Get the user_id linked to the student (which is an INTEGER)
        const getUserIdQuery = `SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1;`;
        const studentResult = await client.query(getUserIdQuery, [studentId]);

        if (studentResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const user_id = studentResult.rows[0].user_id; // INTEGER ID

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
            WHERE id = $1 AND role = 'Student'; -- id is INTEGER
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