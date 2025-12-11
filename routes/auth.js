const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // Used for generating reset tokens (Database mechanism)
const { pool } = require('../database'); // Database pool connection
const { authenticateToken } = require('../authMiddleware'); // For protected routes
const { sendPasswordResetEmail } = require('../utils/notificationService'); // Email sending utility

// --- Configuration Constants ---
const JWT_SECRET = process.env.JWT_SECRET;
const USERS_TABLE = 'users';

// Helper: Finds user by username or email and verifies password
async function findUserAndVerifyPassword(loginInput, password) {
    const userResult = await pool.query(
        // Searches by username OR email and ensures the user is active
        `SELECT id, username, password_hash, role, branch_id FROM ${USERS_TABLE} WHERE (username = $1 OR email = $1) AND is_active = TRUE`,
        [loginInput]
    );

    const user = userResult.rows[0];
    if (!user) return null;
    
    // Compares the provided password with the stored hash
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    return passwordMatch ? user : null;
}

// =================================================================
// 1. LOGIN ROUTE (POST /api/auth/login)
// =================================================================
router.post('/login', async (req, res) => {
    const loginInput = req.body.username || req.body.email; 
    const password = req.body.password;
    
    try {
        // --- A. NORMAL LOGIN ---
        const user = await findUserAndVerifyPassword(loginInput, password);

        if (!user) return res.status(401).json({ message: 'Invalid username or password.' });
        
        // --- B. Fetch Active Session (Necessary for frontend context) ---
        let activeSessionId = null;
        try {
            const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
            activeSessionId = sessionRes.rows[0]?.id || null;
        } catch (e) {
            // Log this, but don't fail login if the session table is missing
            console.warn("Active Session ID could not be retrieved.");
        }
        
        // --- C. Generate Token (Payload includes ID, Role, Branch) ---
        const tokenPayload = { 
            id: user.id,
            role: user.role, 
            branch_id: user.branch_id
        };
        
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '30d' });

        // --- D. Send Response ---
        const responsePayload = {
            token: token,
            role: user.role, 
            username: user.username,
            'user-id': user.id, // For frontend compatibility
            userBranchId: user.branch_id || '',
            activeSessionId: activeSessionId || '',     
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
// 2. USER REGISTRATION ROUTE (Placeholder - requires auth check for actual use)
// =================================================================
router.post('/register', async (req, res) => {
    const { username, password, role, email } = req.body;
    if (!username || !password || !role) return res.status(400).json({ message: 'Missing required fields.' });

    try {
        // Use SALT_ROUNDS from environment variables
        const saltRounds = parseInt(process.env.SALT_ROUNDS || 10);
        const passwordHash = await bcrypt.hash(password, saltRounds);
        
        // TODO: Replace with dynamic/configured default branch ID
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
// (Database Token Mechanism - Generates link and sends email)
// =================================================================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    const TOKEN_EXPIRY_MINUTES = 60; 
    // 🚨 IMPORTANT: Use the actual URL of your deployed frontend (e.g., https://erp.yourschool.com)
    const FRONTEND_URL = 'http://localhost:3005'; 

    if (!email) return res.status(400).json({ message: 'Email address is required.' });

    try {
        const result = await pool.query(`SELECT id, email FROM ${USERS_TABLE} WHERE email = $1 AND is_active = TRUE`, [email]);
        const user = result.rows[0];

        // 1. Safety Check (Always return a success message if the user is not found)
        if (!user) {
            // Prevents attackers from verifying valid email addresses
            return res.json({ message: 'If a matching account was found, a password reset link has been sent to the associated email address.' });
        }

        // 2. Generate Unique Token (using crypto, not JWT)
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiryTime = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000); 

        // 3. Store Token in Database (Revocable Token)
        await pool.query(
            `UPDATE ${USERS_TABLE} SET reset_password_token = $1, reset_token_expiry = $2 WHERE id = $3::uuid`,
            [resetToken, expiryTime, user.id]
        );
        
        // 4. Send Email
        const resetURL = `${FRONTEND_URL}/reset-password.html?token=${resetToken}`;
        await sendPasswordResetEmail(user.email, resetURL); 
        
        return res.json({ message: 'A password reset link has been sent to your registered email address.' });

    } catch (err) {
        console.error('Forgot Password Server Error:', err);
        // If email sending failed, inform the user about the internal error
        return res.status(500).json({ message: 'An internal error occurred during token generation or email dispatch.' });
    }
});

// =================================================================
// 4. RESET PASSWORD (POST /api/auth/reset-password)
// (Database Token Mechanism - Validates token and updates password)
// =================================================================
router.post('/reset-password', async (req, res) => {
    // Frontend sends 'token' and 'password' (newPassword is mapped to password in frontend JS)
    const { token, password } = req.body; 

    if (!token || !password) {
        return res.status(400).json({ message: 'Token and new password are required.' });
    }

    try {
        // 1. Validate Token and Expiry against Database (Check if token exists and is not expired)
        const userResult = await pool.query(
            `SELECT id FROM ${USERS_TABLE} WHERE reset_password_token = $1 AND reset_token_expiry > CURRENT_TIMESTAMP`,
            [token]
        );

        const user = userResult.rows[0];

        if (!user) {
            // Handles invalid, expired, or already-used tokens
            return res.status(400).json({ message: 'Invalid or expired password reset link. Please request a new one.' });
        }
        
        // 2. Hash New Password
        const saltRounds = parseInt(process.env.SALT_ROUNDS || 10);
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // 3. Update Password AND Revoke Token
        await pool.query(
            `UPDATE ${USERS_TABLE} 
             SET password_hash = $1, 
                 reset_password_token = NULL, 
                 reset_token_expiry = NULL, 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2::uuid`, 
            [hashedPassword, user.id]
        );

        res.json({ message: 'Password has been updated successfully.' });
        
    } catch (err) {
        console.error('Reset Password Server Error:', err);
        res.status(500).json({ message: 'An internal error occurred during password update.' });
    }
});

// =================================================================
// 5. VALIDATE TOKEN (PROFILE) (GET /api/auth/me)
// =================================================================
router.get('/me', authenticateToken, async (req, res) => {
    try {
        // req.user comes from authMiddleware which already verified the token payload
        const user = await pool.query('SELECT id, username, role, email FROM users WHERE id = $1', [req.user.id]);
        if (user.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ user: user.rows[0] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;