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
    // NOTE: This query now joins profiles to ensure data is available for JWT payload generation.
    const userResult = await pool.query(
        `
        SELECT 
            u.id, 
            u.username, 
            u.password_hash, 
            u.role, 
            u.branch_id,
            -- Fetch the profile's primary key (UUID) based on the user's role
            COALESCE(s.student_id::text, t.id::text) AS profile_reference_id 
        FROM ${USERS_TABLE} u
        LEFT JOIN students s ON u.id = s.user_id AND u.role = 'Student'
        LEFT JOIN teachers t ON u.id = t.user_id AND u.role = 'Teacher'
        WHERE u.username = $1 AND u.is_active = TRUE
        `,
        [username]
    );

    const user = userResult.rows[0];

    if (!user) {
        return null; // User not found or inactive
    }
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    return passwordMatch ? user : null;
}

// =================================================================
// --- USER REGISTRATION ROUTE (Unchanged) ---
// =================================================================

/**
 * @route POST /api/auth/register
 * @desc Creates a new user account with a hashed password.
 */
router.post('/register', async (req, res) => {
    const { username, password, role } = req.body;
    
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
// --- PUBLIC FORGOT PASSWORD INITIATION (Unchanged) ---
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
        const userResult = await pool.query(
            `SELECT id, username FROM ${USERS_TABLE} WHERE email = $1 AND is_active = TRUE`,
            [email]
        );
        const user = userResult.rows[0];

        let resetToken = 'DEBUG_TOKEN';

        if (user) {
            resetToken = jwt.sign(
                { id: user.id, type: 'password_reset' },
                JWT_SECRET,
                { expiresIn: '1h' }
            );
            
            const resetUrl = `http://localhost:3005/reset-password.html?token=${resetToken}`;
            console.log(`[AUTH] Password Reset Link for ${user.username}: ${resetUrl}`);
        }

        res.status(200).json({
            message: 'Password reset link sent successfully. Check your inbox (or server console for the link).',
            token: resetToken 
        });

    } catch (error) {
        console.error('Server Forgot Password Error:', error);
        res.status(500).json({ message: 'Internal server error during password recovery initiation.' });
    }
});


// =================================================================
// --- PUBLIC PASSWORD RESET (FORGOT PASSWORD) (Unchanged) ---
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
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id; 

        const saltRounds = 10;
        const newPasswordHash = await bcrypt.hash(password, saltRounds);

        const result = await pool.query(
            `UPDATE ${USERS_TABLE} SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id`,
            [newPasswordHash, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).send('User not found or password already reset.');
        }

        res.status(200).send('Password has been successfully reset.');

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).send('Error: The password reset link is invalid or expired. Please request a new link.');
        }
        console.error('Server Password Reset Error:', error);
        res.status(500).send('Internal server error during password reset.');
    }
});


// =================================================================
// --- LOGIN ROUTE (FINAL FIX) ---
// =================================================================

/**
 * @route POST /api/auth/login
 * @desc Authenticates user and returns JWT + Session Setup Data
 */
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        // findUserAndVerifyPassword now fetches the profile_reference_id
        const user = await findUserAndVerifyPassword(username, password);

        if (!user) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        
        // --- 1. Fetch Active Session ID (Unchanged) ---
        const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
        const activeSessionId = sessionRes.rows[0]?.id || null; 
        
        // --- 2. Generate Token (CRITICAL FIX) ---
        
        const generatedToken = jwt.sign(
            { 
                id: user.id, // CORE INTEGER ID
                role: user.role, 
                branch_id: user.branch_id,
                // THIS IS THE FIX: Include the Profile UUID/Text ID for middleware validation
                reference_id: user.profile_reference_id
            }, 
            JWT_SECRET, 
            { expiresIn: '8h' }
        );

        // --- 3. Construct Response Payload ---
        const responsePayload = {
            token: generatedToken,
            role: user.role,
            username: user.username,
            
            'user-id': user.id,           
            // Pass the reference_id back to the client for local storage access
            reference_id: user.profile_reference_id,           
            
            userBranchId: user.branch_id || '',
            activeSessionId: activeSessionId || '',     
        };

        // Update last login time
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);


        return res.status(200).json(responsePayload);
        
    } catch (error) {
        console.error('Server Login Error:', error);
        return res.status(500).json({ message: 'Authentication server failed. Please check database connectivity.' });
    }
});


module.exports = router;