const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// POST /api/health/records - Create or update a health record
router.post('/records', authenticateToken, authorize('Admin'), async (req, res) => {
    const { student_id, blood_group, allergies, medical_conditions, emergency_contact_name, emergency_contact_phone } = req.body;
    const last_updated_by = req.user.userId;
    const query = `
        INSERT INTO health_records (student_id, blood_group, allergies, medical_conditions, emergency_contact_name, emergency_contact_phone, last_updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (student_id) DO UPDATE SET 
            blood_group = EXCLUDED.blood_group, allergies = EXCLUDED.allergies,
            medical_conditions = EXCLUDED.medical_conditions, emergency_contact_name = EXCLUDED.emergency_contact_name,
            emergency_contact_phone = EXCLUDED.emergency_contact_phone, last_updated_by = EXCLUDED.last_updated_by,
            last_updated_on = CURRENT_TIMESTAMP;
    `;
    try {
        await pool.query(query, [student_id, blood_group, allergies, medical_conditions, emergency_contact_name, emergency_contact_phone, last_updated_by]);
        res.status(201).send('Health record saved successfully');
    } catch (err) { res.status(500).send('Server error'); }
});

// GET /api/health/records/:studentId - Get health record for a student
router.get('/records/:studentId', authenticateToken, authorize('Admin'), async (req, res) => {
    const { studentId } = req.params;
    try {
        const result = await pool.query("SELECT * FROM health_records WHERE student_id = $1", [studentId]);
        res.status(200).json(result.rows[0] || {});
    } catch (err) { res.status(500).send('Server error'); }
});

module.exports = router;