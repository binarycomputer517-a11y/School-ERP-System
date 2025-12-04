const express = require('express');
const router = express.Router();
const { pool } = require('../database');

// ==================================================================
// PUBLIC VERIFICATION API
// Route: GET /api/public/verify/:uid
// Access: Public (No Login Required)
// ==================================================================
router.get('/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        // Fetch certificate details joined with student data
        const query = `
            SELECT 
                c.certificate_uid, 
                c.course_name, 
                c.issue_date, 
                c.status, 
                c.revoked_reason,
                s.first_name || ' ' || s.last_name as student_name 
            FROM certificates c
            JOIN students s ON c.student_id = s.student_id
            WHERE c.certificate_uid = $1
        `;
        
        const result = await pool.query(query, [uid]);
        
        if (result.rows.length > 0) {
            // Certificate Found -> Return Details
            res.json(result.rows[0]);
        } else {
            // Certificate Not Found -> Return 404
            res.status(404).json({ error: 'Certificate not found or invalid.' });
        }

    } catch (error) {
        console.error("Verification API Error:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;