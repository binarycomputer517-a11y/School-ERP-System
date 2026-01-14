// routes/auth.js

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../database'); 
const { authenticateToken } = require('../authMiddleware');
const { sendPasswordResetEmail } = require('../utils/notificationService');
const moment = require('moment'); 

// --- Configuration Constants ---
const JWT_SECRET = process.env.JWT_SECRET || 'your_fallback_secret_for_dev_only';
const USERS_TABLE = 'users';

/**
 * Helper: Finds user by username or email and verifies password
 * ✅ Updated to check for 'expired' status and 'is_active' flag
 */
async function findUserAndVerifyPassword(loginInput, password) {
    const userResult = await pool.query(
        `SELECT id, username, password_hash, role, branch_id, status, is_active FROM ${USERS_TABLE} 
         WHERE (username = $1 OR email = $1)`,
        [loginInput]
    );

    const user = userResult.rows[0];
    if (!user) return { error: 'Invalid username or password.' };

    // ❌ চেক: যদি আইডি এক্সপায়ার হয়ে থাকে বা ইন-অ্যাক্টিভ থাকে
    if (user.status === 'expired' || user.is_active === false) {
        return { error: 'Your account has expired. Please complete payment within 24 hours of registration or contact admin.' };
    }
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    return passwordMatch ? { user } : { error: 'Invalid username or password.' };
}

// =================================================================
// 1. LOGIN ROUTE (POST /api/auth/login)
// =================================================================
router.post('/login', async (req, res) => {
    const loginInput = req.body.username || req.body.email; 
    const password = req.body.password;
    
    if (!loginInput || !password) {
        return res.status(400).json({ message: 'Username/Email and password are required.' });
    }

    try {
        const result = await findUserAndVerifyPassword(loginInput, password);

        // যদি হেল্পার ফাংশন কোনো এরর রিটার্ন করে (ভুল পাসওয়ার্ড বা এক্সপায়ার আইডি)
        if (result.error) {
            return res.status(403).json({ message: result.error });
        }

        const user = result.user;
        let studentProfileId = null; 
        
        // Fetch Student's UUID from the students table
        if (user.role === 'Student') {
            const studentRes = await pool.query(
                `SELECT student_id FROM students WHERE user_id = $1`, 
                [user.id]
            );
            studentProfileId = studentRes.rows[0]?.student_id || null;
        }
        
        // --- Fetch Active Session ---
        let activeSessionId = null;
        try {
            const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
            activeSessionId = sessionRes.rows[0]?.id || null;
        } catch (e) {
            console.warn("Active Session ID could not be retrieved.");
        }
        
        // --- Generate Token Payload ---
        const tokenPayload = { 
            id: user.id, 
            role: user.role, 
            branch_id: user.branch_id,
            ...(user.role === 'Student' && { 
                student_id: studentProfileId
            }),
        };
        
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '30d' }); 

        // --- Send Response ---
        const responsePayload = {
            token: token,
            role: user.role, 
            username: user.username,
            'user-id': user.id, 
            userBranchId: user.branch_id || '',
            activeSessionId: activeSessionId || '',
            student_id: studentProfileId 
        };

        // Update last login timestamp
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1::uuid', [user.id]);
        
        return res.status(200).json(responsePayload);
        
    } catch (error) {
        console.error('Server Login Error:', error);
        return res.status(500).json({ message: 'Internal Server Error.' });
    }
});

// =================================================================
// 2. USER REGISTRATION ROUTE (POST /api/auth/register)
// =================================================================
router.post('/register', async (req, res) => {
    const { username, password, role, email } = req.body;

    if (!username || !password || !role) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    try {
        const saltRounds = parseInt(process.env.SALT_ROUNDS || 10);
        const passwordHash = await bcrypt.hash(password, saltRounds);
        
        // Default Branch Assignment
        const defaultBranchId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'; 

        /**
         * ✅ লজিক: নতুন স্টুডেন্ট রেজিস্ট্রেশনের সময়:
         * status = 'active', is_paid = false
         * এর ফলে cron job ২৪ ঘণ্টা পর এটিকে expired করতে পারবে যদি পেমেন্ট না হয়।
         */
        const query = `
            INSERT INTO ${USERS_TABLE} (username, email, password_hash, role, is_active, status, is_paid, branch_id, created_at)
            VALUES ($1, $2, $3, $4, TRUE, 'active', FALSE, $5, CURRENT_TIMESTAMP)
            RETURNING id, username, role;
        `;
        const { rows } = await pool.query(query, [username, email || null, passwordHash, role, defaultBranchId]);
        res.status(201).json({ 
            message: 'User registered. Please complete payment within 24 hours to keep the account active.', 
            user: rows[0] 
        });

    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Username or Email already exists.' });
        console.error('Registration Error:', error);
        res.status(500).json({ message: 'Registration failed due to server error.' });
    }
});

// =================================================================
// 3. FORGOT PASSWORD (POST /api/auth/forgot-password)
// =================================================================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://portal.bcsm.org.in'; 
    const TOKEN_EXPIRY_MINUTES = 60; 

    if (!email) return res.status(400).json({ message: 'Email address is required.' });
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        const result = await client.query(`SELECT id, email FROM ${USERS_TABLE} WHERE email = $1 AND is_active = TRUE`, [email]);
        const user = result.rows[0];

        if (!user) {
            await client.query('COMMIT');
            return res.json({ message: 'If a matching account was found, a reset link has been sent.' });
        }

        const resetToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1h' }); 
        const expiryTime = moment().add(TOKEN_EXPIRY_MINUTES, 'minutes').toISOString();

        await client.query(
            `UPDATE ${USERS_TABLE} SET reset_password_token = $1, reset_token_expiry = $2 WHERE id = $3::uuid`,
            [resetToken, expiryTime, user.id]
        );
        
        const resetURL = `${FRONTEND_URL}/reset-password.html?token=${resetToken}`;
        await sendPasswordResetEmail(user.email, resetURL); 
        
        await client.query('COMMIT');
        return res.json({ message: 'A password reset link has been sent to your registered email address.' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Forgot Password Server Error:', err);
        return res.status(500).json({ message: 'An internal error occurred.' });
    } finally {
        client.release(); 
    }
});

// =================================================================
// 4. RESET PASSWORD (POST /api/auth/reset-password)
// =================================================================
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body; 
    const client = await pool.connect();

    if (!token || !password) {
        return res.status(400).json({ message: 'Token and new password are required.' });
    }

    try {
        await client.query('BEGIN'); 

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET); 
        } catch (jwtError) {
             await client.query('ROLLBACK');
             return res.status(400).json({ message: 'Error: The link has expired or is invalid.' });
        }

        const userResult = await client.query(
            `SELECT id FROM ${USERS_TABLE} 
             WHERE reset_password_token = $1 AND id = $2::uuid`,
            [token, decoded.id] 
        );

        const user = userResult.rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Invalid password reset link.' });
        }
        
        const saltRounds = parseInt(process.env.SALT_ROUNDS || 10);
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        await client.query(`
            UPDATE ${USERS_TABLE} 
             SET password_hash = $1, 
                 reset_password_token = NULL, 
                 reset_token_expiry = NULL, 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2::uuid
        `, [hashedPassword, user.id]);

        await client.query('COMMIT');
        res.json({ message: 'Password has been updated successfully.' });
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Reset Password Server Error:', err);
        res.status(500).json({ message: 'Internal error occurred during update.' });
    } finally {
        client.release(); 
    }
});

// =================================================================
// 5. VALIDATE TOKEN (PROFILE) (GET /api/auth/me)
// =================================================================
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