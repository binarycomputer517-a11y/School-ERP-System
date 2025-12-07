const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
// Assuming you have centralized toUUID in utils/helpers
const { toUUID } = require('../utils/helpers'); 

// --- Configuration ---
const HEALTH_TABLE = 'student_health_records';
const STUDENTS_TABLE = 'students';
const AUTH_ROLES = ['super admin', 'admin', 'medical staff'];

// =================================================================
// POST /api/health-records - Create or update a health record (Upsert)
// =================================================================
/**
 * @route POST /api/health-records
 * @desc Create or update a health record (Upsert logic via ON CONFLICT).
 * @access Private (Super Admin, Admin, Medical Staff)
 */
router.post('/', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    // Includes all fields from the frontend form
    const { 
        student_id, blood_group, allergies, medical_conditions,
        general_notes, 
        emergency_contact_name, emergency_contact_phone
    } = req.body;
    
    const last_updated_by_uuid = req.user.id; 
    const safe_student_id = toUUID(student_id);

    if (!safe_student_id) {
        return res.status(400).json({ message: 'Invalid Student ID.' });
    }
    
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // --- Step 1: Upsert Health Record (Health-specific fields) ---
        const healthQuery = `
            INSERT INTO ${HEALTH_TABLE} (student_id, blood_group, allergies, medical_conditions, general_notes, last_updated_by)
            VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)
            ON CONFLICT (student_id) DO UPDATE SET 
                blood_group = EXCLUDED.blood_group, 
                allergies = EXCLUDED.allergies,
                medical_conditions = EXCLUDED.medical_conditions, 
                general_notes = EXCLUDED.general_notes,
                last_updated_by = EXCLUDED.last_updated_by,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id;
        `;
        await client.query(healthQuery, [
            safe_student_id, 
            blood_group || null, 
            allergies || null, 
            medical_conditions || null, 
            general_notes, 
            last_updated_by_uuid
        ]);

        // --- Step 2: Update Emergency Contact (Fields stored in Students table) ---
        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE} SET 
                emergency_contact_name = $1, 
                emergency_contact_number = $2, 
                updated_at = CURRENT_TIMESTAMP
            WHERE student_id = $3::uuid
        `;
        await client.query(studentUpdateQuery, [
            emergency_contact_name || null, 
            emergency_contact_phone || null, 
            safe_student_id
        ]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Health and emergency records saved successfully.' });
        
    } catch (err) { 
        await client.query('ROLLBACK');
        console.error('Error saving health record:', err);
        res.status(500).json({ message: 'Server error saving record. Check table constraints.' });
    } finally {
        client.release();
    }
});

// =================================================================
// GET /api/health-records/:studentId - Get health record for a student
// =================================================================
/**
 * @route GET /api/health-records/:studentId
 * @desc Get consolidated health and emergency contact data for a student.
 * @access Private (Super Admin, Admin, Medical Staff)
 */
router.get('/:studentId', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const { studentId } = req.params;
    const safe_student_id = toUUID(studentId);

    if (!safe_student_id) {
        return res.status(400).json({ message: 'Invalid Student ID.' });
    }
    
    try {
        // 🛑 FIX: Cleaned up and verified SQL query string (no stray characters).
        const query = `
            SELECT 
                COALESCE(hr.blood_group, s.blood_group) AS blood_group,
                hr.allergies, 
                hr.medical_conditions,
                hr.general_notes,
                s.emergency_contact_name,
                s.emergency_contact_number AS emergency_contact_phone
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${HEALTH_TABLE} hr ON s.student_id = hr.student_id
            WHERE s.student_id = $1::uuid
        `;
        const result = await pool.query(query, [safe_student_id]);
        
        if (result.rowCount === 0) {
            // Student not found at all
            return res.status(404).json({ message: 'Student not found in the database.' });
        }
        
        res.status(200).json(result.rows[0]); 
        
    } catch (err) { 
        console.error('Error fetching health record:', err);
        res.status(500).json({ message: 'Server error while fetching health record.' });
    }
});

// =================================================================
// GET /api/health-records - Get List of All Health Records (for Management Table)
// =================================================================
/**
 * @route GET /api/health-records
 * @desc Get list of all records for the management table.
 * @access Private (Super Admin, Admin, Medical Staff)
 */
router.get('/', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                hr.id, hr.checkup_date, hr.general_notes, hr.blood_group, hr.allergies,
                (s.first_name || ' ' || s.last_name) AS student_name,
                s.roll_number
            FROM ${HEALTH_TABLE} hr
            JOIN ${STUDENTS_TABLE} s ON hr.student_id = s.student_id
            ORDER BY hr.checkup_date DESC
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching health records list:', error);
        res.status(500).json({ message: 'Failed to retrieve health records list.' });
    }
});


module.exports = router;