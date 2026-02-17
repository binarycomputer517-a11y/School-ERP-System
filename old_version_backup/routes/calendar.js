// routes/calendar.js (FINALIZED & UPDATED VERSION)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Constants ---
const ACADEMIC_SESSIONS_TABLE = 'academic_sessions';
const EVENTS_TABLE = 'events'; 
const EXAMS_TABLE = 'exams'; 
const SCHEDULES_TABLE = 'exam_schedules';
const SUBJECTS_TABLE = 'subjects'; 

const CALENDAR_VIEWER_ROLES = ['Super Admin', 'Admin', 'Teacher', 'Coordinator', 'Student']; 
const CALENDAR_EDITOR_ROLES = ['Super Admin', 'Admin']; // Only Admins can add events

/**
 * @route   GET /api/calendar/events
 * @desc    Fetches all academic events, holidays, and exam schedules
 * @access  Private (All authenticated users)
 */
router.get('/events', authenticateToken, authorize(CALENDAR_VIEWER_ROLES), async (req, res) => {
    let currentSessionId = req.sessionId; 

    try {
        // 1. FALLBACK: Find the active session ID
        if (!currentSessionId) {
            const activeSessionResult = await pool.query(
                `SELECT id FROM ${ACADEMIC_SESSIONS_TABLE} WHERE is_active = TRUE LIMIT 1`
            );
            if (activeSessionResult.rows.length > 0) {
                currentSessionId = activeSessionResult.rows[0].id; 
            }
        }

        // 2. Fetch General Events
        // 🔥 FIX: Aliased 'event_date' as 'start_date' to match frontend JS
        const generalEventsQuery = `
            SELECT 
                id,
                event_date AS start_date,  
                title,               
                type
            FROM ${EVENTS_TABLE}
            ORDER BY event_date; 
        `;
        const generalEvents = await pool.query(generalEventsQuery);

        // 3. Fetch Exam Schedules (Using session ID)
        // 🔥 FIX: Aliased 'exam_date' as 'start_date' and set type as 'exam'
        const examsQuery = `
            SELECT 
                es.exam_date AS start_date,
                e.exam_name || ' (' || s.subject_code || ')' AS title,
                'exam' AS type
            FROM ${SCHEDULES_TABLE} es
            JOIN ${EXAMS_TABLE} e ON es.exam_id = e.id
            JOIN ${SUBJECTS_TABLE} s ON es.subject_id = s.id
            WHERE e.academic_session_id = $1::uuid
            ORDER BY es.exam_date;
        `;
        
        let exams = [];
        if (currentSessionId) {
            const examsResult = await pool.query(examsQuery, [currentSessionId]);
            exams = examsResult.rows;
        }

        // 4. Combine and return all events
        const allEvents = [
            ...generalEvents.rows, 
            ...exams
        ];

        res.status(200).json(allEvents);

    } catch (error) {
        console.error('Database Error fetching calendar events:', error.message);
        res.status(500).json({ message: 'Failed to fetch calendar data.' });
    }
});

/**
 * @route   POST /api/calendar/events
 * @desc    Add a new manual event (Holiday, Meeting, General)
 * @access  Private (Admins Only)
 */
router.post('/events', authenticateToken, authorize(CALENDAR_EDITOR_ROLES), async (req, res) => {
    const { title, start_date, type } = req.body;

    if (!title || !start_date || !type) {
        return res.status(400).json({ message: "Title, Date, and Type are required." });
    }

    try {
        // Insert into events table
        // Note: Assuming table columns are (title, event_date, type). Adjust if different.
        const insertQuery = `
            INSERT INTO ${EVENTS_TABLE} (title, event_date, type)
            VALUES ($1, $2, $3)
            RETURNING id, title, event_date AS start_date, type;
        `;
        
        const newEvent = await pool.query(insertQuery, [title, start_date, type]);
        
        res.status(201).json(newEvent.rows[0]);

    } catch (error) {
        console.error('Error adding event:', error.message);
        res.status(500).json({ message: 'Failed to add event.' });
    }
});

module.exports = router;