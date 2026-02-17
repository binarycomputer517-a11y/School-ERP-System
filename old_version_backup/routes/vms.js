// routes/vms.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');

// ==========================================
// 1. PUBLIC: Host Lookup (Autocomplete)
// This is critical for the search bar to work
// ==========================================
router.get('/hosts', async (req, res) => {
    const searchQuery = req.query.query || '';

    // Don't search if the user hasn't typed enough characters
    if (searchQuery.length < 3) return res.json([]);

    try {
        // Search for Teachers, Admins, or Staff whose name matches the input
        // Returns ID (UUID), Name, and Email
        const query = `
            SELECT id, first_name || ' ' || last_name as name, email 
            FROM users 
            WHERE (role = 'Teacher' OR role = 'Admin' OR role = 'Staff')
            AND (first_name ILIKE $1 OR last_name ILIKE $1)
            LIMIT 5
        `;
        const result = await pool.query(query, [`%${searchQuery}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error('Host lookup error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// ==========================================
// 2. PUBLIC: Visitor Check-In
// ==========================================
router.post('/checkin', async (req, res) => {
    const { visitor_name, company, purpose, host_id, badge_type, scanned_id } = req.body;
    
    // Validation
    if (!visitor_name || !host_id || !purpose) {
        return res.status(400).json({ message: 'Missing required visitor information.' });
    }

    try {
        // Insert into visitor_log table
        await pool.query(
            `INSERT INTO visitor_log 
            (visitor_name, company, purpose, host_id, badge_type, scanned_id, check_in_time) 
            VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [visitor_name, company, purpose, host_id, badge_type, scanned_id]
        );

        console.log(`[VMS] Visitor Check-in: ${visitor_name} visiting Host ID ${host_id}`);

        res.status(200).json({ 
            message: 'Visitor successfully checked in and host notified.',
            visitor: visitor_name
        });

    } catch (err) {
        console.error('Error processing VMS check-in:', err);
        // Handle Invalid UUID error specific to Postgres
        if (err.code === '22P02') {
            return res.status(400).json({ 
                message: 'Invalid Host ID format. Please select a valid host from the list.',
                details: err.message 
            });
        }
        res.status(500).json({ message: 'Server error during check-in process.', details: err.message });
    }
});

module.exports = router;