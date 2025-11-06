// routes/clubsEvents.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// Define Admin/Management roles for consolidated authorization
const MANAGEMENT_ROLES = ['Admin', 'Teacher', 'Staff'];

// --- EVENT ROUTES ---

/**
 * @route   GET /api/activities/events
 * @desc    Get all events
 * @access  Private (Student, Teacher, Admin, Staff)
 */
router.get('/events', authenticateToken, authorize(['Student', ...MANAGEMENT_ROLES]), async (req, res) => {
    try {
        const query = `
            SELECT 
                id, event_name, event_date, description, location, budget, status
            FROM events 
            ORDER BY event_date DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('CRITICAL ERROR fetching events:', err);
        res.status(500).send('Server error: Failed to retrieve event data.');
    }
});

/**
 * @route   GET /api/activities/events/:id
 * @desc    Get a single event by ID
 * @access  Private (Admin, Teacher, Staff)
 */
router.get('/events/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query("SELECT id, event_name, description, event_date, location, budget, status FROM events WHERE id = $1", [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Event not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching single event:', err);
        res.status(500).json({ message: 'Server error retrieving event data.' });
    }
});

/**
 * @route   POST /api/activities/events
 * @desc    Create a new event
 * @access  Private (Admin, Teacher, Staff)
 */
router.post('/events', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { event_name, description, event_date, location, budget, status } = req.body; 
    
    // Server-side sanitization for optional numeric/string fields (FIXED budget issue)
    const finalBudget = (budget === '' || budget === undefined) ? null : parseFloat(budget);
    const finalLocation = (location === '' || location === undefined) ? null : location;

    if (!event_name || !event_date || !status) {
        return res.status(400).json({ message: 'Event name, date, and status are required fields.' });
    }

    try {
        await pool.query(
            "INSERT INTO events (event_name, description, event_date, location, budget, status) VALUES ($1, $2, $3, $4, $5, $6)",
            [event_name, description, event_date, finalLocation, finalBudget, status]
        );
        res.status(201).send('Event created successfully');
    } catch (err) {
        console.error('Error creating event:', err);
        res.status(500).json({ message: 'Server error: ' + err.message }); 
    }
});

/**
 * @route   PUT /api/activities/events/:id
 * @desc    Update an existing event
 * @access  Private (Admin, Teacher, Staff)
 */
router.put('/events/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { id } = req.params;
    const { event_name, description, event_date, location, budget, status } = req.body;
    
    if (!event_name || !event_date || !status) {
        return res.status(400).json({ message: 'Event name, date, and status are required fields.' });
    }
    const finalBudget = (budget === '' || budget === undefined) ? null : parseFloat(budget);
    const finalLocation = (location === '' || location === undefined) ? null : location;

    try {
        const result = await pool.query(
            "UPDATE events SET event_name = $1, description = $2, event_date = $3, location = $4, budget = $5, status = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *",
            [event_name, description, event_date, finalLocation, finalBudget, status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Event not found for update.' });
        }

        res.status(200).json({ message: 'Event updated successfully', event: result.rows[0] });

    } catch (err) {
        console.error('Error updating event:', err);
        res.status(500).json({ message: 'Server error during event update.' });
    }
});


// --- CLUB ROUTES ---

/**
 * @route   GET /api/activities/clubs
 * @desc    Get all clubs
 * @access  Private (Admin, Teacher, Staff)
 */
router.get('/clubs', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                c.id, c.club_name, c.description, c.status,
                t.username AS advisor_name,
                (SELECT COUNT(*) FROM club_members cm WHERE cm.club_id = c.id) AS member_count
            FROM clubs c 
            LEFT JOIN users t ON c.faculty_advisor_id = t.id 
            ORDER BY c.club_name;
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('CRITICAL ERROR fetching clubs:', err);
        res.status(500).send('Server error: Failed to retrieve club data.'); 
    }
});

/**
 * @route   GET /api/activities/clubs/:id
 * @desc    Get a single club by ID
 * @access  Private (Admin, Teacher, Staff)
 */
router.get('/clubs/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT id, club_name, description, faculty_advisor_id, status 
            FROM clubs 
            WHERE id = $1
        `;
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Club not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching single club:', err);
        res.status(500).json({ message: 'Server error retrieving club data.' });
    }
});

/**
 * @route   POST /api/activities/clubs
 * @desc    Create a new club
 * @access  Private (Admin, Teacher, Staff)
 */
router.post('/clubs', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { club_name, description, faculty_advisor_id, status } = req.body;
    
    if (!club_name || !faculty_advisor_id || !status) {
        return res.status(400).json({ message: 'Club name, advisor, and status are required fields.' });
    }
    
    try {
        await pool.query(
            "INSERT INTO clubs (club_name, description, faculty_advisor_id, status) VALUES ($1, $2, $3, $4)",
            [club_name, description, faculty_advisor_id, status]
        );
        res.status(201).send('Club created successfully');
    } catch (err) {
        console.error('Error creating club:', err);
        // Enhanced error handling for unique constraint violation (duplicate name)
        if (err.code === '23505') { 
             return res.status(400).json({ message: 'A club with this name already exists.' });
        }
        res.status(500).send('Server error');
    }
});

/**
 * @route   PUT /api/activities/clubs/:id
 * @desc    Update an existing club
 * @access  Private (Admin, Teacher, Staff)
 */
router.put('/clubs/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { id } = req.params;
    const { club_name, description, faculty_advisor_id, status } = req.body;
    
    if (!club_name || !faculty_advisor_id || !status) {
        return res.status(400).json({ message: 'Club name, advisor, and status are required fields.' });
    }

    try {
        const result = await pool.query(
            "UPDATE clubs SET club_name = $1, description = $2, faculty_advisor_id = $3, status = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *",
            [club_name, description, faculty_advisor_id, status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Club not found for update.' });
        }

        res.status(200).json({ message: 'Club updated successfully', club: result.rows[0] });

    } catch (err) {
        console.error('Error updating club:', err);
        if (err.code === '23505') { // Unique constraint violation (duplicate club name)
             return res.status(400).json({ message: 'A club with this name already exists.' });
        }
        if (err.code === '23503') { // Foreign key violation (invalid advisor ID)
             return res.status(400).json({ message: 'Invalid Faculty Advisor ID selected.' });
        }
        res.status(500).json({ message: 'Server error during club update.' });
    }
});

/**
 * @route   POST /api/activities/members
 * @desc    Add a student to a club
 * @access  Private (Admin, Teacher, Staff)
 */
router.post('/members', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { club_id, student_id } = req.body;
    try {
        await pool.query(
            "INSERT INTO club_members (club_id, student_id) VALUES ($1, $2) ON CONFLICT (club_id, student_id) DO NOTHING",
            [club_id, student_id]
        );
        res.status(201).send('Student enrolled in club successfully');
    } catch (err) {
        console.error('Error adding club member:', err);
        res.status(500).send('Server error');
    }
});


// =================================================================
// --- Activity Reports ---
// =================================================================

/**
 * @route   GET /api/activities/reports?type={event|club}
 * @desc    Generate reports for event attendance or club membership.
 * @access  Private (Admin, Teacher, Staff)
 */
router.get('/reports', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
    const { type } = req.query;

    try {
        let query;
        let result;

        if (type === 'event') {
            // FIX: Removed mock attendance. Only returns event name and date.
            query = `
                SELECT 
                    e.event_name AS name, 
                    e.event_date AS date
                FROM events e
                ORDER BY e.event_date DESC;
            `;
            result = await pool.query(query);
            return res.status(200).json(result.rows);

        } else if (type === 'club') {
            // Query for Club Membership Report
            query = `
                SELECT 
                    c.club_name AS name, 
                    u.username AS advisor, 
                    (SELECT COUNT(cm.student_id) FROM club_members cm WHERE cm.club_id = c.id) AS member_count
                FROM clubs c
                LEFT JOIN users u ON c.faculty_advisor_id = u.id
                ORDER BY c.club_name;
            `;
            result = await pool.query(query);
            return res.status(200).json(result.rows);

        } else {
            return res.status(400).json({ message: 'Invalid report type specified. Use "event" or "club".' });
        }
    } catch (err) {
        console.error('Error generating report:', err);
        if (err.code === '42P01') {
             // Handle missing table errors specifically
             return res.status(500).json({ message: 'Database Error: Missing required table (e.g., events, clubs, club_members).' });
        }
        res.status(500).json({ message: 'Server error during report generation.' });
    }
});


module.exports = router;