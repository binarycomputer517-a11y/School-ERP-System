const express = require('express');
const router = express.Router();
const { pool } = require('../database'); // Ensure this path is correct
const { authenticateToken } = require('../authMiddleware'); // Ensure this path is correct

// =========================================================================
// 1. GET ALL TICKETS
// Sorts by: Open tickets first > High Priority > Medium > Low > Date Created
// =========================================================================
router.get('/', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT * FROM helpdesk_tickets 
            ORDER BY 
                CASE WHEN status = 'Open' THEN 1 ELSE 2 END, -- Open tickets top
                CASE 
                    WHEN priority = 'High' THEN 1 
                    WHEN priority = 'Medium' THEN 2 
                    ELSE 3 
                END, -- High priority top
                created_at DESC -- Newest first
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching tickets:', err);
        res.status(500).json({ error: 'Server error fetching tickets' });
    }
});

// =========================================================================
// 2. CREATE NEW TICKET
// Generates a UUID automatically via database default
// =========================================================================
router.post('/', authenticateToken, async (req, res) => {
    const { category, priority, location, contact_number, description } = req.body;

    // Basic Validation
    if (!category || !location || !description) {
        return res.status(400).json({ error: 'Category, Location, and Description are required' });
    }

    try {
        const query = `
            INSERT INTO helpdesk_tickets 
            (category, priority, location, contact_number, description, status) 
            VALUES ($1, $2, $3, $4, $5, 'Open') 
            RETURNING id
        `;
        
        const result = await pool.query(query, [
            category, 
            priority, 
            location, 
            contact_number, 
            description
        ]);
        
        res.status(201).json({ 
            message: 'Ticket raised successfully', 
            ticketId: result.rows[0].id 
        });
    } catch (err) {
        console.error('Error creating ticket:', err);
        res.status(500).json({ error: 'Server error raising ticket' });
    }
});

// =========================================================================
// 3. RESOLVE TICKET
// Mark status as 'Closed' and update timestamp
// =========================================================================
router.patch('/:id/resolve', authenticateToken, async (req, res) => {
    const ticketId = req.params.id;

    try {
        const query = `
            UPDATE helpdesk_tickets 
            SET status = 'Closed', updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `;
        
        const result = await pool.query(query, [ticketId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        res.json({ message: 'Ticket marked as resolved' });
    } catch (err) {
        console.error('Error resolving ticket:', err);
        res.status(500).json({ error: 'Server error updating ticket' });
    }
});

// =========================================================================
// 4. DELETE TICKET
// Permanently remove a ticket record
// =========================================================================
router.delete('/:id', authenticateToken, async (req, res) => {
    const ticketId = req.params.id;

    try {
        const result = await pool.query('DELETE FROM helpdesk_tickets WHERE id = $1', [ticketId]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        res.json({ message: 'Ticket deleted successfully' });
    } catch (err) {
        console.error('Error deleting ticket:', err);
        res.status(500).json({ error: 'Server error deleting ticket' });
    }
});

module.exports = router;