// controllers/studentController.js

// Assuming you have a PostgreSQL client module imported
const { pool } = require('../database');

/**
 * Retrieves a single student's complete profile by their ID (UUID).
 * This endpoint is used by view-fees.js and edit-student.js for loading data.
 * Route: GET /api/students/:id
 */
exports.getStudentProfileById = async (req, res) => {
    const studentId = req.params.id;
    
    if (!studentId) {
        return res.status(400).json({ message: 'Student ID is required.' });
    }

    // This comprehensive query joins students with academic tables (courses, batches) 
    // and the users table for contact details.
    const sqlQuery = `
        SELECT
            s.id,
            s.user_id,
            s.admission_id,
            s.enrollment_no,
            s.academic_session_id,
            s.course_id,
            s.batch_id,
            s.first_name,
            s.middle_name,
            s.last_name,
            s.dob,
            s.gender,
            s.blood_group,
            s.permanent_address,
            s.parent_first_name,
            s.parent_last_name,
            s.parent_phone_number, -- Added parent contact fields
            s.parent_email,        -- Added parent contact fields
            
            -- User/Contact details (linked to s.user_id)
            u.username,
            u.email,
            u.phone_number,

            -- Academic Name Lookups (CRITICAL for headers/forms)
            c.course_name,
            c.course_code,
            b.batch_name,
            b.batch_code
            
        FROM
            students s
        LEFT JOIN 
            users u ON s.user_id = u.id -- Join with users table for login/contact info
        LEFT JOIN
            courses c ON s.course_id = c.id
        LEFT JOIN
            batches b ON s.batch_id = b.id
        WHERE
            s.id = $1;
    `;

    try {
        const result = await db.query(sqlQuery, [studentId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found.' });
        }
        
        // Return the first (and only) row
        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error fetching student profile:', error);
        res.status(500).json({ message: 'Internal server error while retrieving student data.' });
    }
};

/**
 * Updates a student's profile.
 * Route: PUT /api/students/:id
 * NOTE: This function requires a transaction if both updates must succeed or fail together.
 */
exports.updateStudentProfile = async (req, res) => {
    const studentId = req.params.id;
    const { 
        user_id, first_name, middle_name, last_name, dob, gender, blood_group, 
        course_id, batch_id, permanent_address, parent_first_name, parent_last_name, 
        parent_phone_number, parent_email, username, email, phone_number, updated_by
    } = req.body;
    
    // Check required fields (basic validation)
    if (!studentId || !user_id || !first_name || !last_name || !course_id || !batch_id) {
        return res.status(400).json({ message: 'Missing required student/academic fields.' });
    }

    try {
        // --- 1. Update the students table ---
        const studentUpdateQuery = `
            UPDATE students
            SET 
                first_name = $1, middle_name = $2, last_name = $3, dob = $4, 
                gender = $5, blood_group = $6, course_id = $7, batch_id = $8, 
                permanent_address = $9, parent_first_name = $10, parent_last_name = $11, 
                parent_phone_number = $12, parent_email = $13,
                updated_at = NOW(), updated_by = $14
            WHERE id = $15;
        `;
        const studentResult = await db.query(studentUpdateQuery, [
            first_name, middle_name, last_name, dob, gender, blood_group, course_id, batch_id, 
            permanent_address, parent_first_name, parent_last_name, parent_phone_number, parent_email, 
            updated_by, studentId
        ]);

        if (studentResult.rowCount === 0) {
            return res.status(404).json({ message: "Student not found for update." });
        }

        // --- 2. Update the linked users table (for login/contact info) ---
        const userUpdateQuery = `
            UPDATE users
            SET 
                username = $1, email = $2, phone_number = $3, updated_at = NOW()
            WHERE id = $4;
        `;
        await db.query(userUpdateQuery, [username, email, phone_number, user_id]);

        res.json({ message: 'Student profile and user account updated successfully.' });

    } catch (error) {
        console.error('Error updating student profile:', error);
        res.status(500).json({ 
            message: 'Failed to update student profile due to server error. Check database constraint violations.' 
        });
    }
};

/**
 * Placeholder function for retrieving the list of all students (used by students-list.js).
 * Route: GET /api/students
 */
exports.getStudentList = async (req, res) => {
    // This is the function needed to fix the students-list.js page
    const sqlQuery = `
        SELECT
            s.id AS student_id,
            s.enrollment_no,
            s.admission_id,
            s.first_name,
            s.last_name,
            s.course_id,
            s.batch_id,
            u.email,
            u.phone_number,
            c.course_name,
            b.batch_name
        FROM
            students s
        LEFT JOIN 
            users u ON s.user_id = u.id
        LEFT JOIN
            courses c ON s.course_id = c.id
        LEFT JOIN
            batches b ON s.batch_id = b.id
        WHERE
            s.is_active = TRUE -- Assuming a soft-delete mechanism
        ORDER BY
            s.last_name, s.first_name;
    `;
    
    try {
        const result = await db.query(sqlQuery);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching student list:', error);
        res.status(500).json({ message: 'Internal server error while retrieving student list.' });
    }
};

/**
 * Placeholder function for soft-deleting a student.
 * Route: DELETE /api/students/:id
 */
exports.deleteStudent = async (req, res) => {
    const studentId = req.params.id;
    
    try {
        // Soft-delete the student
        const studentResult = await db.query(
            'UPDATE students SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING user_id', 
            [studentId]
        );
        
        if (studentResult.rowCount === 0) {
            return res.status(404).json({ message: 'Student not found for deletion.' });
        }

        // Deactivate the associated user login (optional but recommended)
        const userId = studentResult.rows[0].user_id;
        await db.query('UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [userId]);

        res.status(200).json({ message: 'Student successfully deactivated.' });

    } catch (error) {
        console.error('Error deleting student:', error);
        res.status(500).json({ message: 'Failed to deactivate student due to server error.' });
    }
};