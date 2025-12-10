// controllers/studentController.js
const { pool } = require('../database'); // Correctly using 'pool' for PostgreSQL operations
// NOTE: Assuming there's a students table in addition to the users table.

/**
 * Retrieves a single student's complete profile by their ID (UUID).
 * Route: GET /api/students/:id
 */
exports.getStudentProfileById = async (req, res) => {
    const studentId = req.params.id;
    
    if (!studentId) {
        return res.status(400).json({ message: 'Student ID is required.' });
    }

    const sqlQuery = `
        SELECT
            s.id, s.user_id, s.admission_id, s.enrollment_no, s.academic_session_id,
            s.course_id, s.batch_id, s.first_name, s.middle_name, s.last_name, s.dob,
            s.gender, s.blood_group, s.permanent_address, s.parent_first_name, 
            s.parent_last_name, s.parent_phone_number, s.parent_email,
            
            -- User/Contact details
            u.username, u.email, u.phone_number,

            -- Academic Name Lookups
            c.name AS course_name, -- Assuming 'name' is the column in courses
            c.course_code,
            b.name AS batch_name,  -- Assuming 'name' is the column in batches
            b.batch_code
            
        FROM
            students s
        LEFT JOIN 
            users u ON s.user_id = u.id
        LEFT JOIN
            courses c ON s.course_id = c.id
        LEFT JOIN
            batches b ON s.batch_id = b.id
        WHERE
            s.id = $1;
    `;

    try {
        // FIX: Use 'pool' instead of 'db'
        const result = await pool.query(sqlQuery, [studentId]); 
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found.' });
        }
        
        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error fetching student profile:', error);
        res.status(500).json({ message: 'Internal server error while retrieving student data.' });
    }
};

/**
 * Updates a student's profile (using a database transaction for integrity).
 * Route: PUT /api/students/:id
 */
exports.updateStudentProfile = async (req, res) => {
    const studentId = req.params.id;
    const { 
        user_id, first_name, middle_name, last_name, dob, gender, blood_group, 
        course_id, batch_id, permanent_address, parent_first_name, parent_last_name, 
        parent_phone_number, parent_email, username, email, phone_number, updated_by
    } = req.body;
    
    if (!studentId || !user_id || !first_name || !last_name || !course_id || !batch_id) {
        return res.status(400).json({ message: 'Missing required student/academic fields.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Start transaction

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
        const studentResult = await client.query(studentUpdateQuery, [
            first_name, middle_name, last_name, dob, gender, blood_group, course_id, batch_id, 
            permanent_address, parent_first_name, parent_last_name, parent_phone_number, parent_email, 
            updated_by, studentId
        ]);

        if (studentResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Student not found for update." });
        }

        // --- 2. Update the linked users table (for login/contact info) ---
        const userUpdateQuery = `
            UPDATE users
            SET 
                username = $1, email = $2, phone_number = $3, updated_at = NOW()
            WHERE id = $4;
        `;
        await client.query(userUpdateQuery, [username, email, phone_number, user_id]);

        await client.query('COMMIT'); // Commit transaction
        res.json({ message: 'Student profile and user account updated successfully.' });

    } catch (error) {
        await client.query('ROLLBACK'); // Rollback on any error
        console.error('Error updating student profile (Transaction rolled back):', error);
        res.status(500).json({ 
            message: 'Failed to update student profile due to server error or data constraint violation.' 
        });
    } finally {
        client.release(); // Release client back to the pool
    }
};

/**
 * Placeholder function for retrieving the list of all students.
 * Route: GET /api/students
 */
exports.getStudentList = async (req, res) => {
    const sqlQuery = `
        SELECT
            s.id AS student_id, s.enrollment_no, s.admission_id, s.first_name, s.last_name,
            s.course_id, s.batch_id, u.email, u.phone_number,
            c.name AS course_name, b.name AS batch_name
        FROM
            students s
        LEFT JOIN 
            users u ON s.user_id = u.id
        LEFT JOIN
            courses c ON s.course_id = c.id
        LEFT JOIN
            batches b ON s.batch_id = b.id
        WHERE
            u.is_active = TRUE 
        ORDER BY
            s.last_name, s.first_name;
    `;
    
    try {
        // FIX: Use 'pool' instead of 'db'
        const result = await pool.query(sqlQuery);
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
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Start transaction
        
        // 1. Soft-delete/Deactivate the student record
        const studentResult = await client.query(
            'UPDATE students SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING user_id', 
            [studentId]
        );
        
        if (studentResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found for deletion.' });
        }

        // 2. Deactivate the associated user login
        const userId = studentResult.rows[0].user_id;
        await client.query('UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [userId]);

        await client.query('COMMIT'); // Commit transaction
        res.status(200).json({ message: 'Student successfully deactivated.' });

    } catch (error) {
        await client.query('ROLLBACK'); // Rollback on any error
        console.error('Error deleting student (Transaction rolled back):', error);
        res.status(500).json({ message: 'Failed to deactivate student due to server error.' });
    } finally {
        client.release(); // Release client back to the pool
    }
};