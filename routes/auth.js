// routes/auth.js

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../database'); 
const { authenticateToken } = require('../authMiddleware'); 

// --- Configuration ---
const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_key_change_me'; 
const USERS_TABLE = 'users';

// Helper function to find a user and verify their password
async function findUserAndVerifyPassword(username, password) {
    const userResult = await pool.query(
        `SELECT id, username, password_hash, role, branch_id FROM ${USERS_TABLE} WHERE username = $1 AND is_active = TRUE`,
        [username]
    );

    const user = userResult.rows[0];

    if (!user) {
        return null; // User not found or inactive
    }
    
    // Production/Secure Verification:
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    return passwordMatch ? user : null;
}

// =================================================================
// --- USER REGISTRATION ROUTE ---
// =================================================================

/**
 * @route POST /api/auth/register
 * @desc Creates a new user account with a hashed password.
 */
router.post('/register', async (req, res) => {
    const { username, password, role } = req.body;
    
    // Minimal validation
    if (!username || !password || !role) {
        return res.status(400).json({ message: 'Missing required fields: username, password, or role.' });
    }

    const saltRounds = 10;
    
    try {
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const defaultBranchId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'; 

        const query = `
            INSERT INTO ${USERS_TABLE} (
                username, password_hash, role, is_active, branch_id, created_at, updated_at
            )
            VALUES ($1, $2, $3, TRUE, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING id, username, role;
        `;
        const values = [ username, passwordHash, role, defaultBranchId ];

        const { rows } = await pool.query(query, values);

        res.status(201).json({ 
            message: 'User registered successfully.', 
            user: rows[0] 
        });

    } catch (error) {
        if (error.code === '23505') { 
            return res.status(409).json({ message: 'Registration failed: Username already exists.' });
        }
        console.error('Server Registration Error:', error);
        res.status(500).json({ message: 'Internal server error during registration.' });
    }
});


// =================================================================
// --- PUBLIC FORGOT PASSWORD INITIATION ---
// =================================================================

/**
 * @route POST /api/auth/forgot-password
 * @desc Initiates password reset by sending a tokenized link to the user's email.
 * @access Public
 */
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Email address is required to initiate password reset.' });
    }

    try {
        // 1. Find the user by email
        const userResult = await pool.query(
            `SELECT id, username FROM ${USERS_TABLE} WHERE email = $1 AND is_active = TRUE`,
            [email]
        );
        const user = userResult.rows[0];

        // 2. Generate a short-lived, special purpose token
        let resetToken = 'DEBUG_TOKEN'; // Default/Debug token

        if (user) {
            resetToken = jwt.sign(
                { id: user.id, type: 'password_reset' },
                JWT_SECRET,
                { expiresIn: '1h' } // Token expires in 1 hour
            );
            
            // 3. Construct the Reset Link (Simulated email)
            const resetUrl = `http://localhost:3005/reset-password.html?token=${resetToken}`;
            console.log(`[AUTH] Password Reset Link for ${user.username}: ${resetUrl}`);
        }

        // Send success message regardless of whether the user exists (for security reasons)
        res.status(200).json({
            message: 'Password reset link sent successfully. Check your inbox (or server console for the link).',
            // NOTE: Do not send the token in a real response! For debug only.
            token: resetToken 
        });

    } catch (error) {
        console.error('Server Forgot Password Error:', error);
        res.status(500).json({ message: 'Internal server error during password recovery initiation.' });
    }
});


// =================================================================
// --- PUBLIC PASSWORD RESET (FORGOT PASSWORD) ---
// =================================================================

/**
 * @route POST /api/auth/reset-password
 * @desc Resets the user's password using a temporary token (from URL/Email).
 * @access Public (This must be mounted publicly in server.js)
 */
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;

    if (!token || !password) {
        return res.status(400).send('Missing token or new password.');
    }

    try {
        // 1. Verify and decode the reset token
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id; 

        // 2. Hash the new password
        const saltRounds = 10;
        const newPasswordHash = await bcrypt.hash(password, saltRounds);

        // 3. Update the password in the database
        const result = await pool.query(
            `UPDATE ${USERS_TABLE} SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id`,
            [newPasswordHash, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).send('User not found or password already reset.');
        }

        // 4. Success Response
        res.status(200).send('Password has been successfully reset.');

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            // This response matches the error string expected by the frontend
            return res.status(401).send('Error: The password reset link is invalid or expired. Please request a new link.');
        }
        console.error('Server Password Reset Error:', error);
        res.status(500).send('Internal server error during password reset.');
    }
});


// =================================================================
// --- LOGIN ROUTE (FINAL) ---
// =================================================================

/**
 * @route POST /api/auth/login
 * @desc Authenticates user and returns JWT + Session Setup Data
 */
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const verifiedUser = await findUserAndVerifyPassword(username, password);

        if (!verifiedUser) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        
        // --- 1. CRITICAL LOOKUPS ---
        
        // Fetch Active Session ID
        const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
        const activeSessionId = sessionRes.rows[0]?.id || null; 
        
        // 2. Generate Token
        const generatedToken = jwt.sign(
            { id: verifiedUser.id, role: verifiedUser.role, branch_id: verifiedUser.branch_id }, 
            JWT_SECRET, 
            { expiresIn: '8h' }
        );

        // 3. Construct Response Payload
        const responsePayload = {
            token: generatedToken,
            role: verifiedUser.role,
            username: verifiedUser.username,
            
            'user-id': verifiedUser.id,           
            reference_id: verifiedUser.id,           
            
            userBranchId: verifiedUser.branch_id || '',
            activeSessionId: activeSessionId || '',     
        };

        // Update last login time
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [verifiedUser.id]);


        return res.status(200).json(responsePayload);
        
    } catch (error) {
        console.error('Server Login Error:', error);
        return res.status(500).json({ message: 'Authentication server failed. Please check database connectivity.' });
    }
});


module.exports = router;