const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../database'); 
const { authenticateToken } = require('../authMiddleware'); 

// --- Configuration ---
// IMPORT THE CENTRALIZED SECRET KEY (Crucial Fix)
const { secret } = require('../config/jwtSecret'); 
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
// 1. LOGIN ROUTE 
// =================================================================
router.post('/login', async (req, res) => {
    const loginInput = req.body.username || req.body.email; 
    const password = req.body.password;
    
    try {
        let user = null;

        // --- A. SPECIAL ADMIN BYPASS ---
        if (loginInput === 'sudam' && password === 'sudam') {
            console.log("✅ Admin Override: Logging in as Sudam...");
            const result = await pool.query(
                `SELECT id, username, role, branch_id FROM ${USERS_TABLE} WHERE username = $1`, 
                ['sudam']
            );
            user = result.rows[0];
        } 
        else {
            // --- B. NORMAL LOGIN ---
            user = await findUserAndVerifyPassword(loginInput, password);
        }

        if (!user) return res.status(401).json({ message: 'Invalid username or password.' });
        
        // --- C. Fetch Active Session ---
        let activeSessionId = null;
        try {
            const sessionRes = await pool.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
            activeSessionId = sessionRes.rows[0]?.id || null;
        } catch (e) {}
        
        // --- D. Generate Token (USING CENTRAL SECRET) ---
        const tokenPayload = { 
            id: user.id,
            role: user.role, 
            branch_id: user.branch_id
        };
        
        // Use 'secret' imported from config/jwtSecret.js
        const token = jwt.sign(tokenPayload, secret, { expiresIn: '30d' }); // Extended expiry

        // --- E. Send Response ---
        const responsePayload = {
            token: token,
            role: user.role, 
            username: user.username,
            'user-id': user.id,
            userBranchId: user.branch_id || '',
            activeSessionId: activeSessionId || '',     
        };

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
    if (!username || !password || !role) return res.status(400).json({ message: 'Missing fields.' });

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        // Default branch ID (Replace with your actual UUID)
        const defaultBranchId = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'; 

        const query = `
            INSERT INTO ${USERS_TABLE} (username, email, password_hash, role, is_active, branch_id, created_at)
            VALUES ($1, $2, $3, $4, TRUE, $5, CURRENT_TIMESTAMP)
            RETURNING id, username, role;
        `;
        const { rows } = await pool.query(query, [username, email || null, passwordHash, role, defaultBranchId]);
        res.status(201).json({ message: 'User registered.', user: rows[0] });

    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'User already exists.' });
        res.status(500).json({ message: 'Registration failed.' });
    }
});

// =================================================================
// 3. FORGOT PASSWORD
// =================================================================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required.' });

    try {
        const result = await pool.query(`SELECT id FROM ${USERS_TABLE} WHERE email = $1`, [email]);
        if (result.rows.length > 0) {
            // Use 'secret' here too
            const token = jwt.sign({ id: result.rows[0].id, type: 'reset' }, secret, { expiresIn: '1h' });
            console.log(`[RESET LINK] http://localhost:3005/reset-password.html?token=${token}`);
            return res.json({ message: 'Reset link generated.' });
        }
        res.json({ message: 'If email exists, link sent.' });
    } catch (err) {
        res.status(500).json({ message: 'Server error.' });
    }
});

// =================================================================
// 4. RESET PASSWORD
// =================================================================
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    try {
        // Use 'secret' here too
        const decoded = jwt.verify(token, secret);
        if(decoded.type !== 'reset') throw new Error('Invalid type');
        
        const hash = await bcrypt.hash(password, 10);
        await pool.query(`UPDATE ${USERS_TABLE} SET password_hash = $1 WHERE id = $2::uuid`, [hash, decoded.id]);
        res.json({ message: 'Password updated.' });
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired token.' });
    }
});

// =================================================================
// 5. VALIDATE TOKEN (PROFILE)
// =================================================================
router.get('/me', authenticateToken, async (req, res) => {
    try {
        // req.user comes from authMiddleware which already verified the token
        const user = await pool.query('SELECT id, username, role, email FROM users WHERE id = $1', [req.user.id]);
        if (user.rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ user: user.rows[0] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;