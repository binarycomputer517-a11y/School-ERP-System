// routes/calendar.js (FINAL PRODUCTION VERSION - 2026)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Table Constants ---
const SESSIONS_TABLE = 'academic_sessions';
const EVENTS_TABLE = 'events'; 
const EXAMS_TABLE = 'exams'; 
const SCHEDULES_TABLE = 'exam_schedules';
const SUBJECTS_TABLE = 'subjects'; 

// 🔥 FIXED: Added 'Parent' to VIEW_ROLES to resolve the 403 Forbidden error in your logs
const VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student', 'Parent']; 
const EDITOR_ROLES = ['Super Admin', 'Admin'];

/**
 * @route   GET /api/calendar/events
 * @desc    Fetches branch-specific academic events and exam schedules for all roles
 */
router.get('/events', authenticateToken, authorize(VIEWER_ROLES), async (req, res) => {
    const { branch_id, role } = req.user;
    let currentSessionId = req.sessionId; 

    try {
        // 
        
        // 1. Session Fallback: Fixing the "id" column mismatch
        if (!currentSessionId) {
            // Using COALESCE to try common column names for the session ID
            const sessionRes = await pool.query(
                `SELECT academic_session_id AS id FROM ${SESSIONS_TABLE} WHERE is_active = TRUE LIMIT 1`
            );
            if (sessionRes.rows.length > 0) {
                currentSessionId = sessionRes.rows[0].id; 
            }
        }

        // 2. Fetch General Events (Filtered by Branch)
        let eventsQuery = `
            SELECT id::text, event_date AS start_date, title, type, description
            FROM ${EVENTS_TABLE}
            WHERE 1=1
        `;
        const eventParams = [];
        if (role !== 'Super Admin' && branch_id) {
            eventsQuery += ` AND branch_id = $1`;
            eventParams.push(branch_id);
        }
        const generalEvents = await pool.query(eventsQuery + ` ORDER BY event_date ASC`, eventParams);

        // 3. Fetch Exam Schedules (Filtered by Session & Branch)
        let exams = [];
        if (currentSessionId) {
            let examsQuery = `
                SELECT 
                    es.id::text AS id, 
                    es.exam_date AS start_date,
                    e.exam_name || ' - ' || s.subject_name AS title,
                    'exam' AS type
                FROM ${SCHEDULES_TABLE} es
                JOIN ${EXAMS_TABLE} e ON es.exam_id = e.id
                JOIN ${SUBJECTS_TABLE} s ON es.subject_id = s.id
                WHERE e.academic_session_id = $1::uuid
            `;
            const examParams = [currentSessionId];
            
            if (role !== 'Super Admin' && branch_id) {
                examsQuery += ` AND s.branch_id = $2`; 
                examParams.push(branch_id);
            }
            
            const examsRes = await pool.query(examsQuery, examParams);
            exams = examsRes.rows;
        }

        // 4. Combine and Return JSON response
        res.status(200).json([...generalEvents.rows, ...exams]);

    } catch (error) {
        console.error('Calendar Fetch Error:', error.message);
        res.status(500).json({ 
            message: 'Failed to fetch calendar data.',
            error: error.message 
        });
    }
});

/**
 * @route   POST /api/calendar/events
 * @desc    Add a new manual event linked to a specific branch (Admin/Super Admin only)
 */
router.post('/events', authenticateToken, authorize(EDITOR_ROLES), async (req, res) => {
    const { title, start_date, type, description, target_branch_id } = req.body;
    const { branch_id, role } = req.user;

    // Super Admins can choose the branch; others are locked to their own
    const finalBranchId = (role === 'Super Admin' && target_branch_id) ? target_branch_id : branch_id;

    if (!title || !start_date || !type || !finalBranchId) {
        return res.status(400).json({ message: "Required fields missing (Title, Date, Type, Branch)." });
    }

    try {
        // 
        const query = `
            INSERT INTO ${EVENTS_TABLE} (title, event_date, type, description, branch_id)
            VALUES ($1, $2, $3, $4, $5::uuid)
            RETURNING id::text, title, event_date AS start_date, type;
        `;
        const result = await pool.query(query, [title, start_date, type, description || null, finalBranchId]);
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Add Event Error:', error.message);
        res.status(500).json({ message: 'Failed to add event.' });
    }
});

module.exports = router;