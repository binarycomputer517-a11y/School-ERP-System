// routes/teachers.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const { authenticateToken, authorize } = require('../authMiddleware');

const TEACHERS_TABLE = 'teachers';
const USERS_TABLE = 'users';
const DEPARTMENTS_TABLE = 'hr_departments'; 
const BRANCHES_TABLE = 'branches'; // Assuming 'branches' table exists for user's branch

// --- Role Definitions ---
const CRUD_ROLES = ['Super Admin', 'Admin', 'HR'];
const LIST_ROLES = ['Super Admin', 'Admin', 'HR', 'Teacher', 'Coordinator']; 

// --- Helper: Get Configuration IDs from Request ---
function getConfigIds(req) {
    // This correctly gets branch_id from the LOGGED IN USER (for the users table)
    const branch_id = req.user.branch_id; 
    return { branch_id, created_by: req.user.id, updated_by: req.user.id };
}

// routes/teachers.js

// =========================================================
// 1. GET: Main List (Full Details for Table View) - FIXED
// =========================================================

/**
 * @route   GET /api/teachers
 * @desc    Get the full list of teachers for the Admin/Manager view table.
 * @access  Private (Admin, Super Admin, HR)
 */
router.get('/', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    try {
        // *** FIX: Corrected JOINs and added hd.description for payroll ***
        const query = `
            SELECT 
                t.id, 
                t.full_name, 
                t.employee_id, 
                t.designation, 
                t.email, 
                t.phone_number,
                t.date_of_birth, 
                t.hire_date, 
                t.is_active,
                t.address,
                t.department_id, -- This is needed by manage-payroll.html filters
                u.username, 
                u.role, 
                u.id AS user_id,

                -- Data from Department Table
                hd.name AS department_name, 
                hd.description AS department_description, -- *** THE FIX: This provides the Pay Grade JSON ***

                -- Data from User's Branch
                b.branch_name
            FROM ${TEACHERS_TABLE} t
            LEFT JOIN ${USERS_TABLE} u ON t.user_id = u.id
            LEFT JOIN ${DEPARTMENTS_TABLE} hd ON t.department_id = hd.id -- Correct JOIN for department
            LEFT JOIN branches b ON u.branch_id = b.id -- Correct JOIN for user's branch
            ORDER BY t.employee_id;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching full teachers list:', error);
        res.status(500).json({ message: 'Failed to retrieve teachers list.' });
    }
});

// =========================================================
// 2. GET: Dropdown List (This route was OK)
// =========================================================

/**
 * @route   GET /api/teachers/list
 * @desc    Get simplified list for dropdowns (Timetable/Assignment forms).
 * @access  Private (Manager/Teacher)
 */
router.get('/list', authenticateToken, authorize(LIST_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id AS teacher_id, 
                t.full_name, 
                u.id AS user_id,
                u.username,
                u.email
            FROM ${TEACHERS_TABLE} t
            JOIN ${USERS_TABLE} u ON t.user_id = u.id
            WHERE t.is_active = TRUE AND u.deleted_at IS NULL 
            ORDER BY t.full_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching simplified teachers list:', error); 
        res.status(500).json({ message: 'Failed to retrieve teacher details.' });
    }
});

// --- GET: Single Teacher Details - FIXED ---
/**
 * @route   GET /api/teachers/:id
 * @desc    Get details for a single teacher (Used for Edit form population).
 * @access  Private (Admin, Super Admin, HR)
 */
router.get('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const teacherId = req.params.id;
    try {
        // *** FIX: Removed reference to non-existent t.branch_id ***
        const query = `
            SELECT 
                t.*,
                u.username, u.role, 
                hd.name AS department_name
            FROM ${TEACHERS_TABLE} t
            LEFT JOIN ${USERS_TABLE} u ON t.user_id = u.id
            LEFT JOIN ${DEPARTMENTS_TABLE} hd ON t.department_id = hd.id
            WHERE t.id = $1;
        `;
        const result = await pool.query(query, [teacherId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Teacher not found in the database.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error(`Error fetching single teacher (${teacherId}):`, error);
        res.status(500).json({ message: 'Failed to retrieve teacher details.' });
    }
});


// =========================================================
// 3. POST: Create New Teacher (Includes User Creation) - FIXED
// =========================================================

/**
 * @route   POST /api/teachers
 * @desc    Create a new teacher and their linked user account (Transactional).
 * @access  Private (Admin, Super Admin, HR)
 */
router.post('/', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const {
        username, password, full_name, employee_id, designation, 
        email, phone_number, date_of_birth, address, hire_date,
        department_id, // This is the correct ID
        initial_role = 'Teacher'
    } = req.body;
    
    // branch_id comes from the logged-in user and is for the USERS table only
    const { branch_id, created_by } = getConfigIds(req); 

    if (!username || !password || !full_name || !employee_id || !email) {
        return res.status(400).json({ message: 'Missing required user/teacher fields.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        // 1. Hash Password
        const password_hash = await bcrypt.hash(password, saltRounds);

        // 2. Create User Account (user is associated with a branch)
        const userQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, email, phone_number, branch_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id;
        `;
        const userResult = await client.query(userQuery, [username, password_hash, initial_role, email, phone_number || null, branch_id]);
        const newUserId = userResult.rows[0].id;

        // 3. Create Teacher Profile 
        // *** FIX: Removed non-existent branch_id column from TEACHERS table insert ***
        const teacherQuery = `
            INSERT INTO ${TEACHERS_TABLE} (
                user_id, full_name, employee_id, designation, 
                email, phone_number, date_of_birth, address, hire_date, created_by,
                department_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, full_name, employee_id;
        `;
        const teacherResult = await client.query(teacherQuery, [
            newUserId, full_name, employee_id, designation || null, 
            email, phone_number || null, date_of_birth || null, address || null, hire_date || null, created_by,
            department_id || null 
        ]);

        await client.query('COMMIT'); 

        res.status(201).json({ 
            message: 'Teacher created successfully', 
            teacher: teacherResult.rows[0] 
        });

    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error('Teacher Creation Error:', error);
        
        let errorMessage = 'Failed to create teacher due to server error.';
        if (error.code === '23505') {
            errorMessage = 'Employee ID, Username, or Email already exists.';
            return res.status(409).json({ message: errorMessage });
        }
        res.status(500).json({ message: errorMessage });
    } finally {
        client.release();
    }
});


// =========================================================
// 4. PUT: Update Existing Teacher Details (This route was OK)
// =========================================================

/**
 * @route   PUT /api/teachers/:id
 * @desc    Update a teacher's profile and linked user account (Transactional).
 * @access  Private (Admin, Super Admin, HR)
 */
router.put('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const teacherId = req.params.id;
    const {
        full_name, designation, email, phone_number, date_of_birth, address, hire_date, is_active,
        department_id, new_role 
    } = req.body;
    const { updated_by } = getConfigIds(req);

    if (!full_name || !email) {
        return res.status(400).json({ message: 'Missing required fields (Name, Email).' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Update Teacher Profile 
        const teacherQuery = `
            UPDATE ${TEACHERS_TABLE} SET
                full_name = $1, designation = $2, email = $3, phone_number = $4, 
                date_of_birth = $5, address = $6, hire_date = $7, is_active = $8,
                department_id = $9, 
                updated_at = CURRENT_TIMESTAMP, updated_by = $10
            WHERE id = $11
            RETURNING user_id, full_name;
        `;
        const teacherResult = await client.query(teacherQuery, [
            full_name, designation || null, email, phone_number || null, date_of_birth || null, address || null, hire_date || null, is_active,
            department_id || null, 
            updated_by, teacherId
        ]);

        if (teacherResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Teacher not found.' });
        }

        const { user_id } = teacherResult.rows[0];

        // 2. Update Linked User Account
        if (user_id) {
            const userUpdateFields = ['email = $1', 'phone_number = $2', 'is_active = $3', 'updated_at = CURRENT_TIMESTAMP'];
            const userUpdateValues = [email, phone_number || null, is_active];
            let placeholderIndex = userUpdateValues.length + 1;

            if (new_role) {
                userUpdateFields.push(`role = $${placeholderIndex++}`);
                userUpdateValues.push(new_role);
            }
            userUpdateValues.push(user_id); 

            const userUpdateQuery = `
                UPDATE ${USERS_TABLE} SET 
                    ${userUpdateFields.join(', ')}
                 WHERE id = $${placeholderIndex}
            `;
            
            await client.query(userUpdateQuery, userUpdateValues);
        }

        await client.query('COMMIT');
        res.status(200).json({ message: `Teacher ${teacherResult.rows[0].full_name} updated successfully.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Teacher Update Error:', error);
        
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Email already exists for another user/teacher.' });
        }
        res.status(500).json({ message: 'Failed to update teacher profile.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 5. DELETE: Soft Delete Teacher (This route was OK)
// =========================================================

/**
 * @route   DELETE /api/teachers/:id
 * @desc    Soft deletes teacher profile and deactivates linked user account (Transactional).
 * @access  Private (Admin, Super Admin, HR)
 */
router.delete('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const teacherId = req.params.id;
    
    if (!teacherId || teacherId === 'undefined') {
        return res.status(400).json({ message: 'Invalid Teacher ID provided for deletion.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Soft Delete Teacher (Set is_active=false)
        const teacherUpdateQuery = `
            UPDATE ${TEACHERS_TABLE} SET 
                is_active = FALSE, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING user_id;
        `;
        const teacherResult = await pool.query(teacherUpdateQuery, [teacherId]);

        if (teacherResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Teacher not found.' });
        }

        const { user_id } = teacherResult.rows[0];

        // 2. Deactivate Linked User Account
        if (user_id) {
            await pool.query(
                `UPDATE ${USERS_TABLE} SET 
                    is_active = FALSE, deleted_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [user_id]
            );
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Teacher and linked user deactivated successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Teacher Deletion Error:', error);
        res.status(500).json({ message: 'Failed to deactivate teacher account.' });
    } finally {
        client.release();
    }
});


module.exports = router;