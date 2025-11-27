const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../database'); 
const { authenticateToken } = require('../authMiddleware'); // Used for /me route

// --- Configuration ---
const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret_key_change_me'; 
const USERS_TABLE = 'users';

// Helper: Find user and verify password (Standard Flow)
async function findUserAndVerifyPassword(username, password) {
    const userResult = await pool.query(
        `SELECT id, username, password_hash, role, branch_id FROM ${USERS_TABLE} WHERE (username = $1 OR email = $1) AND is_active = TRUE`,
        [username]
    );

    const user = userResult.rows[0];
    if (!user) return null;
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    return passwordMatch ? user : null;
}

// =================================================================
// 1. LOGIN ROUTE (WITH ADMIN BYPASS & SESSION ID)
// =================================================================
router.post('/login', async (req, res) => {
    // Frontend sends 'email' or 'username'
    const loginInput = req.body.username || req.body.email; 
    const password = req.body.password;
    
    try {
        let user = null;

        // --- A. SPECIAL ADMIN BYPASS (sudam/sudam) ---
        if (loginInput === 'sudam' && password === 'sudam') {
            console.log("✅ Admin Override: Logging in as Sudam (Bypass Mode)...");
            
            // Fetch user details directly without checking password hash
            const result = await pool.query(
                `SELECT id, username, role, branch_id FROM ${USERS_TABLE} WHERE username = $1`, 
                ['sudam']
            );
            
            if (result.rows.length > 0) {
                user = result.rows[0];
            } else {
                return res.status(404).json({ message: 'User "sudam" not found in database. Please register him first.' });
            }
        } 
        else {
            // --- B. NORMAL LOGIN (Secure check) ---
            user = await findUserAndVerifyPassword(loginInput, password);
        }

        // If user not found or password incorrect
        if (!user) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        
        // --- C. Fetch Active Academic Session ---
        let activeSessionId = null;
        try {
            const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
            activeSessionId = sessionRes.rows[0]?.id || null;
        } catch (e) {
            // Ignore error if table doesn't exist yet
        }
        
        // --- D. Generate Token ---
        const tokenPayload = { 
            id: user.id,        // UUID
            role: user.role,    // Admin/Staff/Teacher
            branch_id: user.branch_id
        };
        
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '12h' });

        // --- E. Send Response ---
        const responsePayload = {
            token: token,
            role: user.role, 
            username: user.username,
            'user-id': user.id,
            userBranchId: user.branch_id || '',
            activeSessionId: activeSessionId || '',     
        };

        // Update last login timestamp
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1::uuid', [user.id]);

        return res.status(200).json(responsePayload);
        
    } catch (error) {
        console.error('Server Login Error:', error);
        return res.status(500).json({ message: 'Internal Server Error during login.' });
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
        const passwordHash = await bcrypt.hash(password, 10);
        
        // Default branch ID (Ensure this UUID matches your DB)
        const defaultBranchId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'; 

        const query = `
            INSERT INTO ${USERS_TABLE} (username, email, password_hash, role, is_active, branch_id, created_at)
            VALUES ($1, $2, $3, $4, TRUE, $5, CURRENT_TIMESTAMP)
            RETURNING id, username, role;
        `;
        const { rows } = await pool.query(query, [username, email || null, passwordHash, role, defaultBranchId]);

        res.status(201).json({ message: 'User registered successfully.', user: rows[0] });

    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Username or Email already exists.' });
        }
        console.error('Registration Error:', error);
        res.status(500).json({ message: 'Registration failed.' });
    }
});

// =================================================================
// 3. FORGOT PASSWORD (INITIATE RESET)
// =================================================================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required.' });

    try {
        const result = await pool.query(`SELECT id, username FROM ${USERS_TABLE} WHERE email = $1`, [email]);
        if (result.rows.length > 0) {
            const token = jwt.sign({ id: result.rows[0].id, type: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
            // In production, send Email. For now, log to console.
            console.log(`[RESET LINK] http://localhost:3005/reset-password.html?token=${token}`);
            return res.json({ message: 'Reset link generated (Check server console).' });
        }
        res.json({ message: 'If email exists, link sent.' });
    } catch (err) {
        res.status(500).json({ message: 'Server error.' });
    }
});

// =================================================================
// 4. RESET PASSWORD (COMPLETE RESET)
// =================================================================
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if(decoded.type !== 'reset') throw new Error('Invalid token type');
        
        const hash = await bcrypt.hash(password, 10);
        await pool.query(`UPDATE ${USERS_TABLE} SET password_hash = $1 WHERE id = $2::uuid`, [hash, decoded.id]);
        
        res.json({ message: 'Password updated successfully.' });
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired token.' });
    }
});

// =================================================================
// 5. VALIDATE TOKEN (PROFILE / ME) - Useful for page refreshes
// =================================================================
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query('SELECT id, username, role, email FROM users WHERE id = $1', [req.user.userId]);
        if (user.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ user: user.rows[0] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;