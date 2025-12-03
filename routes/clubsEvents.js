/**
 * routes/clubsEvents.js
 * ----------------------------------------------------
 * Enterprise Activity Management Module
 * Capabilities: 
 * 1. Event CRUD (Create, Read, Update, Delete)
 * 2. Club CRUD with Duplicate Checking
 * 3. Membership Management
 * 4. Advanced Reporting
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// =========================================================
// 1. EVENT ROUTES
// =========================================================

// GET ALL EVENTS
router.get('/events', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT id, title, description, event_date, location, organizer, status
            FROM events 
            ORDER BY event_date DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching events:", err.message);
        res.status(500).json({ message: "Server Error fetching events" });
    }
});

// GET SINGLE EVENT
router.get('/events/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Event not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CREATE EVENT
router.post('/events', authenticateToken, async (req, res) => {
    const { title, description, event_date, location, organizer, status } = req.body;
    
    if (!title || !event_date) {
        return res.status(400).json({ message: "Title and Event Date are required." });
    }

    try {
        const query = `
            INSERT INTO events (title, description, event_date, location, organizer, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;
        const result = await pool.query(query, [
            title, description || '', event_date, location || '', organizer || '', status || 'Upcoming'
        ]);
        res.status(201).json({ message: "Event created", event: result.rows[0] });
    } catch (err) {
        console.error("Error creating event:", err.message);
        res.status(500).json({ message: "Failed to create event" });
    }
});

// UPDATE EVENT
router.put('/events/:id', authenticateToken, async (req, res) => {
    const { title, description, event_date, location, organizer, status } = req.body;
    const { id } = req.params;

    try {
        const query = `
            UPDATE events 
            SET title = $1, description = $2, event_date = $3, location = $4, organizer = $5, status = $6
            WHERE id = $7
            RETURNING *;
        `;
        const result = await pool.query(query, [
            title, description, event_date, location, organizer, status, id
        ]);

        if (result.rowCount === 0) return res.status(404).json({ message: "Event not found" });
        res.json({ message: "Event updated", event: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE EVENT
router.delete('/events/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query("DELETE FROM events WHERE id = $1", [req.params.id]);
        res.json({ message: "Event deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// =========================================================
// 2. CLUB ROUTES
// =========================================================

// GET ALL CLUBS
router.get('/clubs', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM clubs ORDER BY club_name ASC");
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching clubs:", err.message);
        res.status(500).json({ message: "Server Error fetching clubs" });
    }
});

// GET SINGLE CLUB
router.get('/clubs/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM clubs WHERE id = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Club not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CREATE CLUB
router.post('/clubs', authenticateToken, async (req, res) => {
    // Handle potential variable names from frontend
    const { name, club_name, coordinator, coordinator_name, president, president_name, description } = req.body;
    
    // Normalize data
    const finalClubName = club_name || name;
    const finalCoordinator = coordinator_name || coordinator;
    const finalPresident = president_name || president;

    if (!finalClubName) return res.status(400).json({ message: "Club Name is required." });

    try {
        const query = `
            INSERT INTO clubs (club_name, coordinator_name, president_name, description)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;
        const result = await pool.query(query, [finalClubName, finalCoordinator, finalPresident, description]);
        res.status(201).json({ message: "Club registered", club: result.rows[0] });
    } catch (err) {
        // Handle Duplicate Name Error
        if (err.code === '23505') {
            return res.status(400).json({ message: "A club with this name already exists." });
        }
        console.error("Error creating club:", err.message);
        res.status(500).json({ message: "Failed to register club" });
    }
});

// UPDATE CLUB
router.put('/clubs/:id', authenticateToken, async (req, res) => {
    const { club_name, coordinator_name, president_name, description, status } = req.body;
    const { id } = req.params;

    try {
        const query = `
            UPDATE clubs 
            SET club_name = $1, coordinator_name = $2, president_name = $3, description = $4, status = $5
            WHERE id = $6
            RETURNING *;
        `;
        const result = await pool.query(query, [
            club_name, coordinator_name, president_name, description, status || 'Active', id
        ]);

        if (result.rowCount === 0) return res.status(404).json({ message: "Club not found" });
        res.json({ message: "Club updated", club: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE CLUB
router.delete('/clubs/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query("DELETE FROM clubs WHERE id = $1", [req.params.id]);
        res.json({ message: "Club deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// =========================================================
// 3. MEMBERSHIP
// =========================================================

// Add Member to Club
router.post('/members', authenticateToken, async (req, res) => {
    const { club_id, student_id } = req.body;
    try {
        // Check if table exists to avoid crash
        const checkTable = await pool.query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'club_members');
        `);
        
        if(!checkTable.rows[0].exists) {
            return res.status(500).json({ message: "Membership table not initialized in DB." });
        }

        await pool.query(
            "INSERT INTO club_members (club_id, student_id) VALUES ($1, $2)",
            [club_id, student_id]
        );
        res.status(201).json({ message: "Member added successfully" });
    } catch (err) {
        if(err.code === '23505') return res.status(400).json({ message: "Student already in this club" });
        res.status(500).json({ error: err.message });
    }
});


// =========================================================
// 4. REPORT ROUTES
// =========================================================

router.get('/reports', authenticateToken, async (req, res) => {
    const { type } = req.query; // ?type=event or ?type=club

    try {
        if (type === 'event') {
            const query = `SELECT title, event_date, location, status FROM events ORDER BY event_date ASC`;
            const result = await pool.query(query);
            res.json(result.rows);
        } 
        else if (type === 'club') {
            const query = `SELECT club_name, coordinator_name, status FROM clubs ORDER BY club_name ASC`;
            const result = await pool.query(query);
            res.json(result.rows);
        } 
        else {
            res.status(400).json({ message: "Invalid report type" });
        }
    } catch (err) {
        console.error("Report Error:", err);
        res.status(500).json({ message: "Error generating report" });
    }
});

module.exports = router;