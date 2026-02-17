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

const MESSAGING_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Parent', 'HR', 'Staff'];
// ---------------------------------------------------------
// 1. GET: Main List (Admin Only)
// ... (Remains the same)
// ---------------------------------------------------------
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
// ... (Remains the same)
// ---------------------------------------------------------
router.put('/change-password', authenticateToken, async (req, res) => {
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
// ... (Remains the same)
// ---------------------------------------------------------
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
// ... (Remains the same)
// ---------------------------------------------------------
router.delete('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
  const userIdToDelete = req.params.id;

  try {
    if (req.user.id == userIdToDelete) {
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
        return res.status(400).json({ error: 'Cannot delete user. They are still linked to student/teacher/staff records.' });
    }
    res.status(500).json({ error: 'Server error occurred while deleting the user.' });
  }
});

// ---------------------------------------------------------
// 5. GET: User Lookup (Staff/Student Directory)
// ... (Remains the same)
// ---------------------------------------------------------
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
// ... (Remains the same)
// ---------------------------------------------------------
router.get('/hosts', async (req, res) => {
    const query = req.query.query;
    if (!query || query.length < 3) {
        return res.status(200).json([]);
    }
    
    try {
        const searchPattern = `%${query.toLowerCase()}%`;
        
        const result = await pool.query(
            `SELECT 
                id, 
                username AS name, 
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
        
        res.status(200).json(result.rows);
        
    } catch (err) {
        console.error('Error fetching VMS host list (USERS_TABLE assumed):', err);
        res.status(500).json({ error: 'Server error fetching host list. Details: ' + err.message, details: err.message });
    }
});


// ---------------------------------------------------------
// 7. GET: Staff List for Assignment (FIX for Helpdesk)
// ... (Remains the same)
// ---------------------------------------------------------
router.get('/staff', authenticateToken, async (req, res) => {
    try {
        const STAFF_ROLES = ['Admin', 'Super Admin', 'HR', 'Teacher', 'Staff', 'Coordinator'];
        
        const query = `
            SELECT 
                u.id, 
                u.username, 
                u.email, 
                u.role,
                COALESCE(t.full_name, u.username) AS full_name
            FROM ${USERS_TABLE} u
            LEFT JOIN ${TEACHERS_TABLE} t ON u.id = t.user_id 
            WHERE u.role::text = ANY($1::text[]) AND u.is_active = TRUE AND u.deleted_at IS NULL
            ORDER BY full_name;
        `;
        
        const result = await pool.query(query, [STAFF_ROLES]);
        
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('SQL Error fetching staff list for assignment (500):', error);
        res.status(500).json({ message: 'Failed to retrieve assignable staff list due to a server error.', details: error.message });
    }
});

// ---------------------------------------------------------
// 8. PUT: Update User Details (Admin Only)
// ... (Remains the same)
// ---------------------------------------------------------
router.put('/:id', authenticateToken, authorize(['Admin', 'Super Admin', 'HR']), async (req, res) => {
    const userIdToUpdate = req.params.id;
    const { role, phone_number, is_active } = req.body;
    
    let fields = [];
    let values = [];
    let paramIndex = 1;

    if (role !== undefined) {
        fields.push(`role = $${paramIndex++}`);
        values.push(role);
    }
    if (phone_number !== undefined) {
        fields.push(`phone_number = $${paramIndex++}`);
        values.push(phone_number);
    }
    if (is_active !== undefined) {
        const isActiveBool = (is_active === 'true' || is_active === true);
        fields.push(`is_active = $${paramIndex++}`);
        values.push(isActiveBool);
    }

    if (fields.length === 0) {
        return res.status(400).json({ error: 'No update fields provided.' });
    }
    
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userIdToUpdate);

    try {
        const query = `
            UPDATE ${USERS_TABLE} SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, username, role, is_active
        `;
        
        const result = await pool.query(query, values);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.status(200).json({ 
            message: `User ${result.rows[0].username} updated successfully.`,
            user: result.rows[0]
        });

    } catch (err) {
        console.error('Error updating user details:', err);
        res.status(500).json({ error: 'Server error occurred while updating user details.' });
    }
});


// ---------------------------------------------------------
// 9. GET: User Lookup for Leave/Admin Search (NEW) 🎯
// ---------------------------------------------------------
/**
 * @route   GET /api/users/lookup/all
 * @desc    Get ID, Username, Role, and Email for all active users (for Autocomplete/Search).
 * @access  Private (Admin, Super Admin, Coordinator)
 */
router.get('/lookup/all', authenticateToken, authorize(['Admin', 'Super Admin', 'Coordinator']), async (req, res) => {
    try {
        const query = `
            SELECT 
                id, 
                username, 
                role,
                email
            FROM ${USERS_TABLE} 
            WHERE is_active = TRUE AND deleted_at IS NULL
            ORDER BY role, username;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching user lookup data for Admin search:', error);
        res.status(500).json({ message: 'Failed to retrieve user list for search.' });
    }
});

// routes/users.js (Add this search route)

/**
 * @route   GET /api/users/search
 * @desc    Searches users by full_name, username, or email.
 * @access  Private (Requires authentication, usually Admin/Staff)
 */
router.get('/search', authenticateToken, authorize(MESSAGING_ROLES), async (req, res) => {
    const searchQuery = req.query.q;

    if (!searchQuery || searchQuery.length < 3) {
        return res.status(200).json([]); // Return empty array for short queries
    }

    // Prepare search term for ILIKE (case-insensitive fuzzy search)
    const searchPattern = `%${searchQuery.toLowerCase()}%`;

    try {
        const result = await pool.query(
            `
            SELECT 
                id, 
                full_name, 
                username, 
                email, 
                role 
            FROM users
            WHERE 
                is_active = TRUE AND deleted_at IS NULL AND
                (
                    LOWER(full_name) ILIKE $1 OR 
                    LOWER(username) ILIKE $1 OR 
                    LOWER(email) ILIKE $1
                )
            ORDER BY full_name ASC
            LIMIT 20;
            `,
            [searchPattern]
        );

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('DB Error searching users:', error);
        res.status(500).json({ message: 'Failed to search users.' });
    }
});

// Remember to ensure 'authenticateToken' and 'authorize' middleware are available
// and 'MESSAGING_ROLES' is defined if you use it globally in users.js. 
// If not defined, use specific roles like ['Super Admin', 'Admin', 'Teacher'].

module.exports = router;