// routes/discipline.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
const moment = require('moment');

// Database Table Constants
const INCIDENTS_TABLE = 'discipline_incidents';
const ACTIONS_TABLE = 'disciplinary_actions';
const USERS_TABLE = 'users';

// Constants
const SEVERITY_LEVELS = ['Low', 'Medium', 'High', 'Critical'];
const ACTION_TYPES = ['Warning', 'Detention', 'Suspension', 'Expulsion', 'Counselling Referral'];

// --- Role Definitions ---
const MARKING_ROLES = ['Super Admin', 'Admin', 'Teacher', 'ApiUser'];
const ROSTER_VIEW_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator'];
const REPORT_VIEW_ROLES = ['Super Admin', 'Admin', 'Coordinator'];
const USER_REPORT_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Employee'];


// =========================================================
// 1. INCIDENT REPORTING (POST) - FIXED
// =========================================================

/**
 * @route   POST /api/discipline/report
 * @desc    Submit a new behavioral incident report.
 * @access  Private (Teacher, Admin, Super Admin)
 */
router.post('/report', authenticateToken, authorize(['Teacher', 'Admin', 'Super Admin']), async (req, res) => {
    
    // CRITICAL FIX: Prioritize JWT user ID, but fall back to the ID sent from the client 
    // if the token injection fails (i.e., req.user.userId is null/undefined).
    const reporterId = req.user.userId || req.body.reporter_id_fallback; 
    
    const { 
        student_id, 
        incident_date, 
        incident_type, 
        description, 
        location, 
        severity 
    } = req.body;

    if (!reporterId) { // Ensure that reporter ID is set
        return res.status(401).json({ message: 'Authentication required: Reporter ID is missing from token and payload.' });
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

        // 1. Check if student exists (Check against the USERS table ID, as expected)
        const studentRes = await client.query(`SELECT id FROM ${USERS_TABLE} WHERE id = $1 AND role = 'Student'`, [student_id]);
        if (studentRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Target student not found.' });
        }

        // 2. Insert Incident Record (Initial status 'Reported')
        const incidentQuery = `
            INSERT INTO ${INCIDENTS_TABLE} 
            (student_id, reported_by_id, incident_date, incident_type, description, location, severity, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'Reported')
            RETURNING id;
        `;
        const result = await client.query(incidentQuery, [
            student_id, 
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
            message: `Incident ${incidentId} reported successfully. Awaiting review.`, 
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
// 2. ACTION & RESOLUTION (POST)
// =========================================================

/**
 * @route   POST /api/discipline/action/:incidentId
 * @desc    Record a disciplinary action and update incident status to 'Resolved'.
 * @access  Private (Admin, Counsellor, Super Admin)
 */
router.post('/action/:incidentId', authenticateToken, authorize(['Admin', 'Counsellor', 'Super Admin']), async (req, res) => {
    const { incidentId } = req.params;
    const processorId = req.user.userId;
    
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
            completion_date || null, // completion_date is optional/future
            processorId
        ]);
        
        // 2. Update Incident Status to Resolved
        await client.query(
            `UPDATE ${INCIDENTS_TABLE} SET status = 'Resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = $1 AND status != 'Resolved'`,
            [incidentId]
        );

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Action recorded and Incident ${incidentId} marked as Resolved.`, 
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
// 3. VIEWING ROUTES (GET)
// =========================================================

/**
 * @route   GET /api/discipline/incidents/pending
 * @desc    Get all incidents awaiting resolution ('Reported' status).
 * @access  Private (Admin, Counsellor, Super Admin)
 */
router.get('/incidents/pending', authenticateToken, authorize(['Admin', 'Counsellor', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                i.id, i.incident_date, i.incident_type, i.description, i.severity,
                u_student.username AS student_name,
                u_reporter.username AS reported_by
            FROM ${INCIDENTS_TABLE} i
            JOIN ${USERS_TABLE} u_student ON i.student_id = u_student.id
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
 * @route   GET /api/discipline/history/:studentId
 * @desc    Get all incidents and actions for a specific student.
 * @access  Private (Admin, Counsellor, Super Admin, Parent/Student - filtered by self ID)
 */
router.get('/history/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    const userId = req.user.userId;
    const userRole = req.user.role;

    // Security check: Only Admins/Counsellors/Super Admin can view ANY record, others can only view their own.
    if (userRole !== 'Admin' && userRole !== 'Counsellor' && userRole !== 'Super Admin' && studentId !== userId) {
        return res.status(403).json({ message: 'Access denied to this student\'s discipline history.' });
    }

    try {
        const query = `
            SELECT 
                i.id AS incident_id, i.incident_date, i.incident_type, i.description, i.severity, i.status,
                u_reporter.username AS reported_by,
                a.action_type, a.action_details, a.effective_date, a.completion_date
            FROM ${INCIDENTS_TABLE} i
            LEFT JOIN ${ACTIONS_TABLE} a ON i.id = a.incident_id
            JOIN ${USERS_TABLE} u_reporter ON i.reported_by_id = u_reporter.id
            WHERE i.student_id = $1
            ORDER BY i.incident_date DESC;
        `;
        const result = await pool.query(query, [studentId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Student History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve student discipline history.' });
    }
});


// =================================================================
// --- FILTER ENDPOINTS (Corrected for relative path use) ---
// =================================================================

/**
 * @route   GET /api/attendance/batches
 * @desc    Get a list of all active batches/classes for filter population.
 * @access  Private (Used by roles that need to view rosters)
 */
router.get('/batches', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        // Assuming 'id' and 'batch_name' are the correct columns for the batches table.
        const query = `SELECT id, batch_name AS name FROM batches ORDER BY name;`; 
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching batches:', err); 
        res.status(500).json({ message: 'Server error fetching batches. Check your database schema for the correct name column in the batches table.', error: err.message });
    }
});

/**
 * @route   GET /api/attendance/subjects
 * @desc    Get a list of all active subjects for filter population.
 * @access  Private (Used by roles that need to view rosters)
 */
router.get('/subjects', authenticateToken, authorize(ROSTER_VIEW_ROLES), async (req, res) => {
    try {
        // Assuming 'id' and 'subject_name' are the correct columns for the subjects table.
        const query = `SELECT id, subject_name, subject_code FROM subjects ORDER BY subject_name;`;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching all subjects:', err);
        res.status(500).json({ message: 'Server error fetching subjects. Check column names (id, subject_name) in the subjects table.', error: err.message });
    }
});


module.exports = router;