// routes/users.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
const bcrypt = require('bcryptjs');
const SALT_ROUNDS = 10;
const USERS_TABLE = 'users';
const STUDENTS_TABLE = 'students';
const TEACHERS_TABLE = 'teachers';


// ---------------------------------------------------------
// 1. GET: Main List (Admin Only)
// ---------------------------------------------------------

/**
 * @route   GET /api/users
 * @desc    Get a list of all users (non-sensitive info)
 * @access  Private (Admin, Super Admin, HR)
 */
router.get('/', authenticateToken, authorize(['Admin', 'Super Admin', 'HR']), async (req, res) => {
    try {
        const query = `SELECT id, username, role, email, phone_number, is_active FROM ${USERS_TABLE} ORDER BY username`;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Server error occurred while fetching users.' });
    }
});


// ---------------------------------------------------------
// 2. PUT: Change Own Password
// ---------------------------------------------------------
/**
 * @route   PUT /api/users/change-password
 * @desc    Allow a logged-in user to change their own password.
 * @access  Private (Self-service for any logged-in user)
 */
router.put('/change-password', authenticateToken, async (req, res) => {
    // NOTE: Assuming req.user.id is correctly set by the middleware
    const userId = req.user.id; 
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Both current password and new password are required.' });
    }

    try {
        const result = await pool.query(`SELECT password_hash FROM ${USERS_TABLE} WHERE id = $1`, [userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const storedHash = result.rows[0].password_hash;
        const isMatch = await bcrypt.compare(currentPassword, storedHash);
        
        if (!isMatch) {
            return res.status(401).json({ error: 'Incorrect current password.' });
        }

        const newHashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await pool.query(`UPDATE ${USERS_TABLE} SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [newHashedPassword, userId]);

        res.status(200).json({ message: 'Password updated successfully. Please log in again.' });

    } catch (err) {
        console.error('Error changing password:', err);
        res.status(500).json({ error: 'Server error occurred while updating password.' });
    }
});

// ---------------------------------------------------------
// 3. POST: Admin/Teacher Reset Password
// ---------------------------------------------------------
/**
 * @route   POST /api/users/reset-password
 * @desc    Allow an Admin, HR, or Teacher to reset any user's password.
 * @access  Private (Admin, Super Admin, HR, Teacher)
 */
router.post('/reset-password', authenticateToken, authorize(['Admin', 'Super Admin', 'HR', 'Teacher']), async (req, res) => {
    const { userId, newPassword } = req.body;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!userId || !newPassword || !uuidRegex.test(userId)) {
        return res.status(400).json({ error: 'Invalid User ID or new password missing.' });
    }

    try {
        const newHashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

        const result = await pool.query(
            `UPDATE ${USERS_TABLE} SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, username`,
            [newHashedPassword, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.status(200).json({ message: `Password for user ${result.rows[0].username} (ID: ${userId}) updated successfully.` });

    } catch (err) {
        console.error('Error resetting password by admin:', err);
        res.status(500).json({ error: 'Server error occurred while updating password.' });
    }
});

// ---------------------------------------------------------
// 4. DELETE: Delete User
// ---------------------------------------------------------
/**
 * @route   DELETE /api/users/:id
 * @desc    Delete a user by their ID
 * @access  Private (Admin, Super Admin)
 */
router.delete('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
  const userIdToDelete = req.params.id;

  try {
    if (req.user.id == userIdToDelete) { // Check against req.user.id
      return res.status(400).json({ error: "Action not allowed: You cannot delete your own account." });
    }

    const deleteQuery = `DELETE FROM ${USERS_TABLE} WHERE id = $1 RETURNING id, username`;
    const result = await pool.query(deleteQuery, [userIdToDelete]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.status(200).json({ message: `User '${result.rows[0].username}' deleted successfully.` });

  } catch (err) {
    console.error('Error deleting user:', err);
    if (err.code === '23503') {
        // Foreign Key Violation
        return res.status(400).json({ error: 'Cannot delete user. They are still linked to student/teacher/staff records.' });
    }
    res.status(500).json({ error: 'Server error occurred while deleting the user.' });
  }
});

// ---------------------------------------------------------
// 5. GET: User Lookup (Staff/Student Directory)
// ---------------------------------------------------------
/**
 * @route   GET /api/users/all-staff-students
 * @desc    Get simplified list of all active Teachers and Students (for autofill/lookup in PTM).
 * @access  Private (Admin, Super Admin, HR, Teacher)
 */
router.get('/all-staff-students', authenticateToken, authorize(['Admin', 'Super Admin', 'HR', 'Teacher']), async (req, res) => {
    try {
        const query = `
            -- 1. Active Students
            SELECT 
                u.id AS id, 
                u.username,
                s.first_name || ' ' || s.last_name AS full_name, 
                u.role
            FROM ${USERS_TABLE} u
            JOIN ${STUDENTS_TABLE} s ON u.id = s.user_id
            WHERE u.role = 'Student' AND u.is_active = TRUE AND u.deleted_at IS NULL
            
            UNION ALL
            
            -- 2. Active Teachers
            SELECT 
                u.id AS id, 
                u.username,
                t.full_name AS full_name,
                u.role
            FROM ${USERS_TABLE} u
            JOIN ${TEACHERS_TABLE} t ON u.id = t.user_id
            WHERE u.role = 'Teacher' AND u.is_active = TRUE AND u.deleted_at IS NULL
            
            UNION ALL
            
            -- 3. Active Admins and HR
            SELECT 
                u.id AS id, 
                u.username,
                u.username AS full_name,
                u.role
            FROM ${USERS_TABLE} u
            WHERE u.role IN ('Admin', 'HR', 'Super Admin') AND u.is_active = TRUE AND u.deleted_at IS NULL
            
            ORDER BY full_name;
        `;

        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching user directory for lookup:', error);
        res.status(500).json({ message: 'Failed to retrieve user directory for lookup.' });
    }
});


// ---------------------------------------------------------
// 6. GET: VMS Host Lookup (Public Access)
// ---------------------------------------------------------
/**
 * @route   GET /api/users/hosts
 * @desc    Get simplified list of active staff users for VMS host selection (Autofill API).
 * @access  Public (Mounted before authenticateToken in server.js)
 */
router.get('/hosts', async (req, res) => { // <--- NO authenticateToken MIDDLEWARE
    const query = req.query.query;
    if (!query || query.length < 3) {
        return res.status(200).json([]);
    }
    
    try {
        const searchPattern = `%${query.toLowerCase()}%`;
        
        // FIX: Reverting to search and select only the reliable USERS_TABLE fields 
        // (username and email) to prevent crashes on missing columns/tables.
        const result = await pool.query(
            `SELECT 
                id, 
                username AS name, // Use username as the display name
                email
            FROM ${USERS_TABLE} 
            WHERE 
                (LOWER(username) LIKE $1 OR LOWER(email) LIKE $1)
                AND role IN ('Teacher', 'Admin', 'Super Admin', 'HR')
                AND is_active = TRUE AND deleted_at IS NULL
            ORDER BY name
            LIMIT 10`,
            [searchPattern]
        );
        
        // VMS frontend expects objects with {id, name, email}
        res.status(200).json(result.rows);
        
    } catch (err) {
        // This crash usually happens if the USERS_TABLE itself is missing, 
        // or a referenced column is missing.
        console.error('Error fetching VMS host list (USERS_TABLE assumed):', err);
        res.status(500).json({ error: 'Server error fetching host list. Details: ' + err.message, details: err.message });
    }
});


module.exports = router;