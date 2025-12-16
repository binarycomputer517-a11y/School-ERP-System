// routes/calendar.js (FINALIZED VERSION - Solves: column "academic_session_id" does not exist)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Constants (Using confirmed table names) ---
const ACADEMIC_SESSIONS_TABLE = 'academic_sessions';
const EVENTS_TABLE = 'events'; 
const EXAMS_TABLE = 'exams'; 
const SCHEDULES_TABLE = 'exam_schedules';
const SUBJECTS_TABLE = 'subjects'; 

const CALENDAR_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student']; 

/**
 * @route   GET /api/calendar/events
 * @desc    Fetches all academic events, holidays, and exam schedules
 * @access  Private (All authenticated users)
 */
router.get('/events', authenticateToken, authorize(CALENDAR_VIEWER_ROLES), async (req, res) => {
    let currentSessionId = req.sessionId; 

    try {
        // 1. FALLBACK: Find the active session ID (still needed for the Exams query)
        if (!currentSessionId) {
            console.warn("req.sessionId missing. Falling back to query active session from DB.");
            
            const activeSessionResult = await pool.query(
                `SELECT id FROM ${ACADEMIC_SESSIONS_TABLE} WHERE is_active = TRUE LIMIT 1`
            );

            if (activeSessionResult.rows.length === 0) {
                 return res.status(404).json({ message: 'No active academic session found in the database.' });
            }
            currentSessionId = activeSessionResult.rows[0].id; 
        }

        // --- Use currentSessionId (academic_sessions.id) for all filters ---

        // 2. Fetch General Events (Holidays, Meetings, etc.) from the 'events' table
        const generalEventsQuery = `
            SELECT 
                event_date AS date,  
                title,               
                'general_event' AS type
            FROM ${EVENTS_TABLE}
            -- 🔥 FIX: Removed the WHERE academic_session_id = $1::uuid clause 
            -- because the column does not exist in the 'events' table.
            ORDER BY event_date; 
        `;
        const generalEvents = await pool.query(generalEventsQuery); // Removed [currentSessionId]
        

        // 3. Fetch Exam Schedules (This query CAN use the session ID, as 'exams' FKs to 'academic_sessions')
        const examsQuery = `
            SELECT 
                es.exam_date AS date,
                e.exam_name || ' (' || s.subject_code || ')' AS title,
                'exam' AS type
            FROM ${SCHEDULES_TABLE} es
            JOIN ${EXAMS_TABLE} e ON es.exam_id = e.id
            JOIN ${SUBJECTS_TABLE} s ON es.subject_id = s.id
            WHERE e.academic_session_id = $1::uuid
            ORDER BY es.exam_date;
        `;
        const exams = await pool.query(examsQuery, [currentSessionId]);

        // 4. Combine and return all events
        const allEvents = [
            ...generalEvents.rows, 
            ...exams.rows
        ];

        console.log(`Calendar data retrieved for session ${currentSessionId}: ${allEvents.length} events found.`);
        res.status(200).json(allEvents);

    } catch (error) {
        // Log the error but indicate that the data is the issue, not the route
        console.error('Database Error fetching calendar events:', error.message, error.stack);
        res.status(500).json({ message: 'Failed to fetch calendar data due to a database error.' });
    }
});


module.exports = router;