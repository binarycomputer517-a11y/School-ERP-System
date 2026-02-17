// routes/auth.js
// Version 3.1.0 - Full Profile Sync & Branch Asset Integration
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../database'); 
const { authenticateToken } = require('../authMiddleware');
const { sendPasswordResetEmail } = require('../utils/notificationService');
const moment = require('moment'); 

const JWT_SECRET = process.env.JWT_SECRET || 'your_fallback_secret_for_dev_only';
const USERS_TABLE = 'users';

/**
 * Helper: Finds user and verifies access rights
 * DEEP CHECK UPDATE: Joined with 'branches' to fetch 'manager_photo' for the dashboard.
 */
async function findUserAndVerifyPassword(loginInput, password) {
    try {
        const userResult = await pool.query(
            `SELECT u.id, u.username, u.full_name, u.password_hash, u.role, u.branch_id, 
                    u.status, u.is_active, u.is_paid, b.manager_photo 
             FROM ${USERS_TABLE} u
             LEFT JOIN branches b ON u.branch_id = b.id
             WHERE (u.username = $1 OR u.email = $1)`,
            [loginInput]
        );

        const user = userResult.rows[0];
        if (!user) return { error: 'Invalid username or password.' };

        // 🛡️ Admin Deactivation Check
        if (user.is_active === false) {
            return { error: 'Your account is deactivated. Please contact the administrator.' };
        }

        // 🛡️ Registration/Payment Gatekeeper
        if (user.status === 'expired' && user.is_paid === false) {
            return { 
                error: 'Your profile is currently restricted. Please complete your Rs. 1,000 registration fee to unlock all portal features.' 
            };
        }
        
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) return { error: 'Invalid username or password.' };

        return { user };
    } catch (err) {
        console.error("Database Error in Auth Helper:", err);
        return { error: 'Internal server error.' };
    }
}

// =========================================================
// 1. LOGIN ROUTE (POST /api/auth/login)
// =========================================================
router.post('/login', async (req, res) => {
    const loginInput = req.body.username || req.body.email; 
    const password = req.body.password;
    
    if (!loginInput || !password) {
        return res.status(400).json({ message: 'Missing credentials.' });
    }

    try {
        const result = await findUserAndVerifyPassword(loginInput, password);
        if (result.error) return res.status(403).json({ message: result.error });

        const user = result.user;
        let studentProfileId = null; 
        
        if (user.role === 'Student') {
            const studentRes = await pool.query(`SELECT student_id FROM students WHERE user_id = $1`, [user.id]);
            studentProfileId = studentRes.rows[0]?.student_id || null;
        }
        
        const tokenPayload = { 
            id: user.id, 
            role: user.role, 
            branch_id: user.branch_id,
            ...(user.role === 'Student' && { student_id: studentProfileId }),
        };
        
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '30d' }); 
        
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1::uuid', [user.id]);
        
        // Return rich profile data to frontend
        return res.status(200).json({
            token,
            role: user.role, 
            username: user.username,
            fullName: user.full_name, // Synchronized Full Name
            photo: user.manager_photo || '/uploads/default-avatar.png', // Synchronized Photo
            'user-id': user.id, 
            userBranchId: user.branch_id,
            student_id: studentProfileId 
        });
        
    } catch (error) {
        console.error('Server Login Error:', error);
        res.status(500).json({ message: 'Internal Server Error.' });
    }
});

// =========================================================
// 2. PROFILE SYNC (GET /api/auth/profile)
// =========================================================
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT u.id, u.username, u.full_name, u.role, u.branch_id, u.status, u.is_active, b.manager_photo 
            FROM ${USERS_TABLE} u
            LEFT JOIN branches b ON u.branch_id = b.id
            WHERE u.id = $1
        `;
        const result = await pool.query(query, [req.user.id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.status(403).json({ message: "Account is inactive." });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role,
                branch_id: user.branch_id,
                photo: user.manager_photo || '/uploads/default-avatar.png',
                status: user.status
            }
        });
    } catch (error) {
        console.error('Profile Route Error:', error);
        res.status(500).json({ message: 'Internal Server Error.' });
    }
});

// =========================================================
// 3. QUICK ACTIVATE STUDENT (POST /api/auth/activate-student)
// =========================================================
router.post('/activate-student', authenticateToken, async (req, res) => {
    const { username } = req.body;
    const userRole = (req.user.role || '').toLowerCase();
    const allowedRoles = ['admin', 'super admin', 'coordinator', 'superadmin'];

    if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({ message: "Forbidden: You do not have permission to activate accounts." });
    }

    try {
        const result = await pool.query(
            `UPDATE users 
             SET status = 'active', is_active = true, is_paid = true, updated_at = CURRENT_TIMESTAMP 
             WHERE username = $1 RETURNING id`,
            [username]
        );

        if (result.rowCount === 0) return res.status(404).json({ message: "User not found." });
        res.json({ success: true, message: `Account for ${username} has been successfully activated.` });
    } catch (err) {
        console.error("Activation Error:", err);
        res.status(500).json({ message: "Database update failed." });
    }
});

// =========================================================
// 4. REGISTRATION (POST /api/auth/register)
// =========================================================
router.post('/register', async (req, res) => {
    const { username, password, role, email } = req.body;
    try {
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const defaultBranchId = 'cc3caa3a-3d01-4300-b826-2df7eb671e10'; // Updated to valid system UUID

        const query = `
            INSERT INTO ${USERS_TABLE} (username, email, password_hash, role, is_active, status, is_paid, branch_id)
            VALUES ($1, $2, $3, $4, TRUE, 'active', FALSE, $5)
            RETURNING id, username;
        `;
        const { rows } = await pool.query(query, [username, email, passwordHash, role, defaultBranchId]);
        res.status(201).json({ message: 'User registered.', user: rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Username or Email already exists.' });
        res.status(500).json({ message: 'Registration failed.' });
    }
});

// =========================================================
// 5. FORGOT PASSWORD (POST /api/auth/forgot-password)
// =========================================================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const result = await pool.query(
            `SELECT id, email FROM users WHERE email = $1 AND is_active = TRUE`, 
            [email]
        );
        const user = result.rows[0];
        
        if (!user) return res.json({ message: 'If an account exists, a reset link has been sent.' });

        const resetToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1h' }); 
        
        await pool.query(
            `UPDATE users SET reset_password_token = $1, reset_token_expiry = $2 WHERE id = $3::uuid`,
            [resetToken, moment().add(60, 'minutes').toISOString(), user.id]
        );
        
        const protocol = req.protocol; 
        const host = req.get('host'); 
        const resetLink = `${protocol}://${host}/reset-password.html?token=${resetToken}`;
        
        sendPasswordResetEmail(user.email, resetLink).catch(err => console.error("Email Error:", err));
        
        res.json({ message: 'Reset email sent successfully.' });
    } catch (err) {
        console.error("Forgot Password Error:", err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// =========================================================
// 6. RESET PASSWORD (POST /api/auth/reset-password)
// =========================================================
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body; 
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const result = await pool.query(`
            UPDATE users 
            SET password_hash = $1, 
                reset_password_token = NULL, 
                reset_token_expiry = NULL 
            WHERE reset_password_token = $2 
              AND id = $3::uuid 
              AND reset_token_expiry > CURRENT_TIMESTAMP
        `, [hashedPassword, token, decoded.id]);

        if (result.rowCount === 0) {
            return res.status(400).json({ message: 'Invalid, used, or expired token.' });
        }

        res.json({ message: 'Password updated successfully. You can now log in.' });
    } catch (err) {
        console.error("Reset Password Error:", err);
        res.status(400).json({ message: 'Invalid or expired token. Please request a new link.' });
    }
});

// =========================================================
// 7. GET ME (BACKUP)
// =========================================================
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query(
            `SELECT u.id, u.username, u.role, u.email, u.status, u.is_active, u.branch_id, b.manager_photo 
             FROM users u 
             LEFT JOIN branches b ON u.branch_id = b.id 
             WHERE u.id = $1`, 
            [req.user.id]
        );
        if (user.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ user: user.rows[0] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;