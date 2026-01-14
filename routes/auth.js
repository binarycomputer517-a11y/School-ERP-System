// routes/auth.js
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
 * Logic: Checks manual deactivation and payment-based restriction.
 */
async function findUserAndVerifyPassword(loginInput, password) {
    try {
        const userResult = await pool.query(
            `SELECT id, username, password_hash, role, branch_id, status, is_active, is_paid 
             FROM ${USERS_TABLE} 
             WHERE (username = $1 OR email = $1)`,
            [loginInput]
        );

        const user = userResult.rows[0];
        if (!user) return { error: 'Invalid username or password.' };

        // 🛡️ Admin Deactivation Check
        if (user.is_active === false) {
            return { error: 'Your account is deactivated. Please contact the administrator.' };
        }

        // 🛡️ Registration/Payment Gatekeeper
        // If status is 'expired' and they haven't paid, block access.
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

// 1. LOGIN ROUTE (POST /api/auth/login)
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
        
        // Fetch Student UUID if user is a student
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
        
        // Update last login timestamp
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1::uuid', [user.id]);
        
        return res.status(200).json({
            token,
            role: user.role, 
            username: user.username,
            'user-id': user.id, 
            userBranchId: user.branch_id,
            student_id: studentProfileId 
        });
        
    } catch (error) {
        console.error('Server Login Error:', error);
        res.status(500).json({ message: 'Internal Server Error.' });
    }
});

// 🚀 QUICK ACTIVATE STUDENT (One-Click Approval)
// Path: POST /api/auth/activate-student
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

// 2. REGISTRATION (POST /api/auth/register)
router.post('/register', async (req, res) => {
    const { username, password, role, email } = req.body;
    try {
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const defaultBranchId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'; 

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

// 3. FORGOT PASSWORD (POST /api/auth/forgot-password)
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const result = await pool.query(`SELECT id, email FROM users WHERE email = $1 AND is_active = TRUE`, [email]);
        const user = result.rows[0];
        
        // Always return success message for security to prevent email enumeration
        if (!user) return res.json({ message: 'If an account exists, a reset link has been sent.' });

        const resetToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1h' }); 
        await pool.query(
            `UPDATE users SET reset_password_token = $1, reset_token_expiry = $2 WHERE id = $3::uuid`,
            [resetToken, moment().add(60, 'minutes').toISOString(), user.id]
        );
        
        await sendPasswordResetEmail(user.email, `https://portal.bcsm.org.in/reset-password.html?token=${resetToken}`); 
        res.json({ message: 'Reset email sent.' });
    } catch (err) {
        res.status(500).json({ message: 'Error processing request.' });
    }
});

// 4. RESET PASSWORD (POST /api/auth/reset-password)
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body; 
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await pool.query(`
            UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_token_expiry = NULL 
            WHERE reset_password_token = $2 AND id = $3::uuid
        `, [hashedPassword, token, decoded.id]);

        if (result.rowCount === 0) return res.status(400).json({ message: 'Invalid or used token.' });
        res.json({ message: 'Password updated successfully.' });
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired token.' });
    }
});

// 5. GET ME (GET /api/auth/me)
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query('SELECT id, username, role, email, status, is_active FROM users WHERE id = $1', [req.user.id]);
        if (user.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ user: user.rows[0] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;