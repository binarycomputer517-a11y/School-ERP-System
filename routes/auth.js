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
// Ensure JWT_SECRET is loaded from env, provide a fallback only for development
const JWT_SECRET = process.env.JWT_SECRET || 'your_fallback_secret_for_dev_only';
const USERS_TABLE = 'users';

// Helper: Finds user by username or email and verifies password (UNCHANGED)
async function findUserAndVerifyPassword(loginInput, password) {
    const userResult = await pool.query(
        `SELECT id, username, password_hash, role, branch_id FROM ${USERS_TABLE} WHERE (username = $1 OR email = $1) AND is_active = TRUE`,
        [loginInput]
    );

    const user = userResult.rows[0];
    if (!user) return null;
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    return passwordMatch ? user : null;
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
        const user = await findUserAndVerifyPassword(loginInput, password);

        if (!user) return res.status(401).json({ message: 'Invalid username or password.' });
        
        let studentProfileId = null; // Variable to hold the actual student_id (UUID)
        
        // 🚀 CRITICAL FIX: Fetch Student's UUID from the students table
        if (user.role === 'Student') {
            const studentRes = await pool.query(
                `SELECT student_id FROM students WHERE user_id = $1`, 
                [user.id] // user.id is the UUID of the entry in the users table
            );
            // If found, use the student_id (which is the UUID of the student record)
            studentProfileId = studentRes.rows[0]?.student_id || null;
            
            if (!studentProfileId) {
                 console.warn(`Student login success but no student_id found for user ${user.id}`);
            }
        }
        
        // --- Fetch Active Session ---
        let activeSessionId = null;
        try {
            const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
            activeSessionId = sessionRes.rows[0]?.id || null;
        } catch (e) {
            console.warn("Active Session ID could not be retrieved.");
        }
        
        // --- Generate Token ---
        const tokenPayload = { 
            id: user.id, // The user's entry UUID in users table
            role: user.role, 
            branch_id: user.branch_id,
            // ✅ FIX 1: Add the actual studentProfileId to the JWT payload
            ...(user.role === 'Student' && { 
                student_id: studentProfileId
            }),
        };
        
        // JWT expires in 30 days
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '30d' }); 

        // --- Send Response ---
        const responsePayload = {
            token: token,
            role: user.role, 
            username: user.username,
            'user-id': user.id, 
            userBranchId: user.branch_id || '',
            activeSessionId: activeSessionId || '',
            // ✅ FIX 2: Send the student_id in the response body for localStorage setting
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
// 2. USER REGISTRATION ROUTE
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

        const query = `
            INSERT INTO ${USERS_TABLE} (username, email, password_hash, role, is_active, branch_id, created_at)
            VALUES ($1, $2, $3, $4, TRUE, $5, CURRENT_TIMESTAMP)
            RETURNING id, username, role;
        `;
        const { rows } = await pool.query(query, [username, email || null, passwordHash, role, defaultBranchId]);
        res.status(201).json({ message: 'User successfully registered.', user: rows[0] });

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
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3005'; 
    const TOKEN_EXPIRY_MINUTES = 60; 

    if (!email) return res.status(400).json({ message: 'Email address is required.' });
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        const result = await client.query(`SELECT id, email FROM ${USERS_TABLE} WHERE email = $1 AND is_active = TRUE`, [email]);
        const user = result.rows[0];

        if (!user) {
            // Security: Don't reveal if email exists
            await client.query('COMMIT');
            return res.json({ message: 'If a matching account was found, a password reset link has been sent to the associated email address.' });
        }

        // 2. JWT Reset Token
        const resetToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1h' }); 
        const expiryTime = moment().add(TOKEN_EXPIRY_MINUTES, 'minutes').toISOString();

        // 3. Store Token in Database 
        await client.query(
            `UPDATE ${USERS_TABLE} SET reset_password_token = $1, reset_token_expiry = $2 WHERE id = $3::uuid`,
            [resetToken, expiryTime, user.id]
        );
        
        // 4. Dispatch Email
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

        // 1. JWT Validation
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET); 
        } catch (jwtError) {
             await client.query('ROLLBACK');
             return res.status(400).json({ message: 'Error: The link has expired or is invalid.' });
        }

        // 2. Validate token against DB
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
        
        // 3. Hash New Password
        const saltRounds = parseInt(process.env.SALT_ROUNDS || 10);
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // 4. Update Password AND Revoke Token
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
        const user = await pool.query('SELECT id, username, role, email FROM users WHERE id = $1', [req.user.id]);
        if (user.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ user: user.rows[0] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;