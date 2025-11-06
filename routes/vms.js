// routes/vms.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');

// NOTE: This route assumes you have a 'visitor_log' table created in your database.

// Route for visitor check-in (POST /api/vms/checkin)
// This route is deliberately left PUBLIC in server.js for visitor access.
router.post('/checkin', async (req, res) => {
    const { visitor_name, company, purpose, host_id, badge_type, scanned_id } = req.body;
    
    // Validation: The frontend ensures host_id is a UUID, but we check if it's present.
    if (!visitor_name || !host_id || !purpose) {
        return res.status(400).json({ message: 'Missing required visitor information (name, host ID, purpose).' });
    }

    try {
        // Log the visitor check-in to the visitor_log table
        // This query expects host_id to be a valid UUID.
        await pool.query(
            `INSERT INTO visitor_log 
            (visitor_name, company, purpose, host_id, badge_type, scanned_id, check_in_time) 
            VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [visitor_name, company, purpose, host_id, badge_type, scanned_id]
        );

        console.log(`[VMS] Visitor Check-in: ${visitor_name} to see Host ID ${host_id}`);

        res.status(200).json({ 
            message: 'Visitor successfully checked in and host notified.',
            visitor: visitor_name
        });

    } catch (err) {
        console.error('Error processing VMS check-in:', err);
        // Respond with JSON error
        // The front-end expects a specific response if the host_id (UUID) is invalid.
        if (err.code === '22P02') {
            return res.status(400).json({ 
                message: 'Invalid Host ID format (must be UUID). Host selection may have failed.',
                details: err.message 
            });
        }
        res.status(500).json({ message: 'Server error during check-in process.', details: err.message });
    }
});

module.exports = router;