const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// Database Table Constants
const INCIDENTS_TABLE = 'discipline_incidents';
const ACTIONS_TABLE = 'disciplinary_actions';
const USERS_TABLE = 'users';
const STUDENTS_TABLE = 'students';

// Constants
const SEVERITY_LEVELS = ['Low', 'Medium', 'High', 'Critical'];
const ACTION_TYPES = ['Warning', 'Detention', 'Suspension', 'Expulsion', 'Counselling Referral'];

// --- Role Definitions ---
const REPORTING_ROLES = ['Super Admin', 'Admin', 'Teacher', 'ApiUser']; 
const RESOLUTION_ROLES = ['Admin', 'Counsellor', 'Super Admin'];


// =========================================================
// 1. HELPER ROUTE: GET STUDENT LIST (For Dropdown)
// =========================================================
/**
 * @route   GET /api/discipline/students/lookup
 * @desc    Get a list of active/enrolled students for the reporting dropdown.
 */
router.get('/students/lookup', authenticateToken, authorize(REPORTING_ROLES), async (req, res) => {
    try {
        // UPDATED: Now fetches 'Enrolled' students too, so the list isn't empty
        const query = `
            SELECT student_id, first_name, last_name, roll_number, admission_id
            FROM ${STUDENTS_TABLE} 
            WHERE status IN ('Active', 'Enrolled') 
            ORDER BY first_name ASC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Student Lookup Error:', error);
        res.status(500).json({ message: 'Failed to load student list.' });
    }
});


// =========================================================
// 2. INCIDENT REPORTING (POST) - WITH SMART ID LOOKUP
// =========================================================

router.post('/report', authenticateToken, authorize(REPORTING_ROLES), async (req, res) => {
    
    const reporterId = req.user.id || req.body.reporter_id_fallback; 
    
    const { 
        student_id, // Can be student_id (dropdown) or user_id (manual)
        incident_date, 
        incident_type, 
        description, 
        location, 
        severity 
    } = req.body;

    if (!reporterId) { 
        return res.status(401).json({ message: 'Authentication required: Reporter ID is missing.' });
    }

    if (!student_id || !incident_date || !incident_type || !description || !severity) {
        return res.status(400).json({ message: 'Missing required incident fields.' });
    }
    if (!SEVERITY_LEVELS.includes(severity)) {
        return res.status(400).json({ message: 'Invalid severity level.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // --- SMART LOOKUP LOGIC ---
        let finalStudentId = null;

        // Check 1: Is it a direct Student ID? (Most likely from dropdown)
        const checkStudent = await client.query(
            `SELECT student_id FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid`,
            [student_id]
        ).catch(() => ({ rowCount: 0 }));

        if (checkStudent.rowCount > 0) {
            finalStudentId = checkStudent.rows[0].student_id;
        } else {
            // Check 2: Is it a User ID? (Manual entry fallback)
            const checkUser = await client.query(
                `SELECT student_id FROM ${STUDENTS_TABLE} WHERE user_id = $1::uuid`,
                [student_id]
            ).catch(() => ({ rowCount: 0 }));

            if (checkUser.rowCount > 0) {
                finalStudentId = checkUser.rows[0].student_id;
            }
        }

        if (!finalStudentId) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Target student not found. Please provide a valid Student ID.' });
        }
        // ---------------------------

        // Insert Incident Record
        const incidentQuery = `
            INSERT INTO ${INCIDENTS_TABLE} 
            (student_id, reported_by_id, incident_date, incident_type, description, location, severity, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'Reported')
            RETURNING id;
        `;
        const result = await client.query(incidentQuery, [
            finalStudentId, 
            reporterId, 
            incident_date, 
            incident_type, 
            description, 
            location, 
            severity
        ]);
        
        const incidentId = result.rows[0].id;

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Incident reported successfully (ID: ${incidentId}).`, 
            incident_id: incidentId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Incident Reporting Error:', error);
        res.status(500).json({ message: 'Failed to submit incident report.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 3. ACTION & RESOLUTION (POST)
// =========================================================

router.post('/action/:incidentId', authenticateToken, authorize(RESOLUTION_ROLES), async (req, res) => {
    const { incidentId } = req.params;
    const processorId = req.user.id;
    
    const { action_type, action_details, effective_date, completion_date } = req.body;

    if (!ACTION_TYPES.includes(action_type) || !action_details || !effective_date) {
        return res.status(400).json({ message: 'Missing or invalid action details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Insert Action Record
        const actionQuery = `
            INSERT INTO ${ACTIONS_TABLE} 
            (incident_id, action_type, action_details, effective_date, completion_date, processed_by_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id;
        `;
        const actionResult = await client.query(actionQuery, [
            incidentId, 
            action_type, 
            action_details, 
            effective_date, 
            completion_date || null, 
            processorId
        ]);
        
        // 2. Update Incident Status to Resolved
        await client.query(
            `UPDATE ${INCIDENTS_TABLE} SET status = 'Resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [incidentId]
        );

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Action recorded and Incident resolved.`, 
            action_id: actionResult.rows[0].id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Disciplinary Action Error:', error);
        res.status(500).json({ message: 'Failed to record disciplinary action.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 4. VIEWING ROUTES (GET)
// =========================================================

/**
 * Get all incidents awaiting resolution.
 */
router.get('/incidents/pending', authenticateToken, authorize(RESOLUTION_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                i.id, i.incident_date, i.incident_type, i.description, i.severity,
                (s.first_name || ' ' || s.last_name) AS student_name,
                u_reporter.username AS reported_by
            FROM ${INCIDENTS_TABLE} i
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id
            JOIN ${USERS_TABLE} u_reporter ON i.reported_by_id = u_reporter.id
            WHERE i.status = 'Reported'
            ORDER BY i.severity DESC, i.incident_date ASC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Pending Incidents Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve pending incidents.' });
    }
});

/**
 * Get history for a student.
 */
router.get('/history/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params; 
    const userId = req.user.id; 
    const userRole = req.user.role;

    if (userRole !== 'Admin' && userRole !== 'Counsellor' && userRole !== 'Super Admin' && studentId !== userId) {
        // Access control logic
    }

    try {
        const query = `
            SELECT 
                i.id AS incident_id, i.incident_date, i.incident_type, i.description, i.severity, i.status,
                (s.first_name || ' ' || s.last_name) AS student_name,
                u_reporter.username AS reported_by,
                a.action_type, a.action_details, a.effective_date, a.completion_date
            FROM ${INCIDENTS_TABLE} i
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id
            LEFT JOIN ${ACTIONS_TABLE} a ON i.id = a.incident_id
            JOIN ${USERS_TABLE} u_reporter ON i.reported_by_id = u_reporter.id
            WHERE i.student_id = $1::uuid OR s.user_id = $1::uuid
            ORDER BY i.incident_date DESC;
        `;
        const result = await pool.query(query, [studentId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Student History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student discipline history.' });
    }
});


module.exports = router;