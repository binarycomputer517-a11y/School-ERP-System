const express = require('express');
const router = express.Router();
const pool = require('../database');

/**
 * Helper function to extract fields for the 'users' table.
 * User data can come from the main student form submission.
 */
function extractUserFields(data) {
    return {
        username: data.username,
        password_hash: data.password_hash,
        email: data.email,
        phone_number: data.phone_number,
        dob: data.dob,
        role: 'student' // Fixed role for student accounts
        // Note: is_active and timestamps will use defaults from the DB schema
    };
}

/**
 * Helper function to extract fields for the 'students' table.
 * Requires the user_id (UUID) which is obtained after creating the user.
 */
function extractStudentFields(data, userId) {
    return {
        user_id: userId,
        admission_id: data.admission_id,
        admission_date: data.admission_date,
        academic_session_id: data.academic_session_id,
        branch_id: data.branch_id || null, // Allow null if not provided
        first_name: data.first_name,
        middle_name: data.middle_name || null,
        last_name: data.last_name,
        course_id: data.course_id,
        batch_id: data.batch_id,
        enrollment_no: data.enrollment_no || null,
        gender: data.gender || null,
        dob: data.dob,
        blood_group: data.blood_group || null,
        religion: data.religion || null,
        profile_image_path: data.profile_image_path || null,
        permanent_address: data.permanent_address || null,
        // created_by and updated_by logic is handled in the routes below
        email: data.email || null, // Duplicated from users, but present in student table schema
        phone_number: data.phone_number || null, // Duplicated from users
        parent_user_id: data.parent_user_id || null,
        roll_number: data.roll_number || null,
        city: data.city || null,
        state: data.state || null,
        zip_code: data.zip_code || null,
        country: data.country || null,
        nationality: data.nationality || null,
        caste_category: data.caste_category || null,
        mother_tongue: data.mother_tongue || null,
        aadhaar_number: data.aadhaar_number || null,
        parent_first_name: data.parent_first_name || null,
        parent_last_name: data.parent_last_name || null,
        parent_phone_number: data.parent_phone_number || null,
        parent_email: data.parent_email || null,
        parent_occupation: data.parent_occupation || null,
        parent_annual_income: data.parent_annual_income || null,
        guardian_relation: data.guardian_relation || null,
        signature_path: data.signature_path || null
    };
}

// --- API Endpoints ---

/**
 * POST /api/students/add
 * Creates a new user account and a linked student record.
 */
router.post('/add', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Prepare and insert data into the 'users' table
        const userData = extractUserFields(req.body);
        const userKeys = Object.keys(userData).join(', ');
        const userValues = Object.values(userData);
        const userPlaceholders = userValues.map((_, i) => `$${i + 1}`).join(', ');

        const userQuery = `
            INSERT INTO public.users (${userKeys}) 
            VALUES (${userPlaceholders}) 
            RETURNING id, username;
        `;
        const userResult = await client.query(userQuery, userValues);
        const newUserId = userResult.rows[0].id;
        
        // 2. Prepare and insert data into the 'students' table
        const studentData = extractStudentFields(req.body, newUserId);
        // The current logged-in user's ID should be available from the request context (e.g., req.user.id)
        const currentUserId = req.user ? req.user.id : null; // Assuming auth middleware sets req.user
        
        studentData.created_by = currentUserId;

        const studentKeys = Object.keys(studentData).join(', ');
        const studentValues = Object.values(studentData);
        const studentPlaceholders = studentValues.map((_, i) => `$${i + 1}`).join(', ');

        const studentQuery = `
            INSERT INTO public.students (${studentKeys}) 
            VALUES (${studentPlaceholders}) 
            RETURNING id, admission_id;
        `;
        const studentResult = await client.query(studentQuery, studentValues);

        await client.query('COMMIT');
        
        res.status(201).json({ 
            message: 'Student created successfully.', 
            student_id: studentResult.rows[0].id, 
            user_id: newUserId 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error creating student record:", err);
        // Check for unique constraint violations (e.g., admission_id, username)
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Duplicate entry: Admission ID, Username, Email, or Phone already exists.' });
        }
        res.status(500).json({ error: 'Server error during student creation.' });
    } finally {
        client.release();
    }
});


/**
 * GET /api/students/:id
 * Fetches complete details for a single student (joining students and users tables).
 */
router.get('/:id', async (req, res) => {
    const { id } = req.params; // The student's UUID (from the students table)

    try {
        const query = `
            SELECT 
                s.*, 
                u.username, u.role, u.is_active, u.last_login,
                p.first_name AS parent_user_first_name, p.last_name AS parent_user_last_name
            FROM public.students s
            LEFT JOIN public.users u ON s.user_id = u.id
            LEFT JOIN public.users p ON s.parent_user_id = p.id
            WHERE s.id = $1;
        `;
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Student not found.' });
        }

        res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error("Error fetching student details:", err);
        res.status(500).json({ error: 'Server error while fetching data.' });
    }
});


/**
 * PUT /api/students/:id
 * Updates an existing student's details, including linked user data.
 */
router.put('/:id', async (req, res) => {
    const { id } = req.params; // The student's UUID
    const client = await pool.connect();

    try {
        // First, fetch the existing student record to get the user_id
        const studentCheck = await client.query('SELECT user_id FROM public.students WHERE id = $1', [id]);
        if (studentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Student not found for update.' });
        }
        const userId = studentCheck.rows[0].user_id;

        await client.query('BEGIN');

        // 1. Update the 'users' table
        const userData = extractUserFields(req.body);
        const userUpdateSets = Object.keys(userData)
            .map((key, i) => `${key} = $${i + 1}`)
            .join(', ');
        
        // Add updated_at
        userData.updated_at = new Date();
        const userUpdateValues = [...Object.values(userData), userId];
        
        const userUpdateQuery = `
            UPDATE public.users 
            SET ${userUpdateSets}, updated_at = $${Object.keys(userData).length + 1}
            WHERE id = $${Object.keys(userData).length + 2};
        `;
        await client.query(userUpdateQuery, userUpdateValues);

        // 2. Update the 'students' table
        const studentData = extractStudentFields(req.body, userId);
        const currentUserId = req.user ? req.user.id : null; // From auth middleware

        studentData.updated_by = currentUserId;
        studentData.updated_at = new Date(); // Explicitly set update timestamp
        
        const studentUpdateKeys = Object.keys(studentData).filter(key => key !== 'user_id'); // Don't update user_id
        const studentUpdateSets = studentUpdateKeys
            .map((key, i) => `${key} = $${i + 1}`)
            .join(', ');
        const studentUpdateValues = studentUpdateKeys.map(key => studentData[key]);
        
        const studentUpdateQuery = `
            UPDATE public.students 
            SET ${studentUpdateSets}
            WHERE id = $${studentUpdateValues.length + 1};
        `;
        await client.query(studentUpdateQuery, [...studentUpdateValues, id]);

        await client.query('COMMIT');

        res.status(200).json({ message: 'Student details updated successfully.' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error updating student record:", err);
        res.status(500).json({ error: 'Server error during student update.' });
    } finally {
        client.release();
    }
});


module.exports = router;