const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware'); 
// Ensure these constants are available at the top of the file
const NOTICES_TABLE = 'notices'; 
const USERS_TABLE = 'users'; 

// =========================================================================
// 1. GET ALL TICKETS (No change)
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
// 2. CREATE NEW TICKET (UPDATED SECTION)
// =========================================================================
router.post('/', authenticateToken, async (req, res) => {
    const { category, priority, location, contact_number, description } = req.body;
    const creatorId = req.user.id; // User ID from the token (the requester)

    // Basic Validation
    if (!category || !location || !description) {
        return res.status(400).json({ error: 'Category, Location, and Description are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction

        // 1. Insert Ticket Record
        const ticketQuery = `
            INSERT INTO helpdesk_tickets 
            (category, priority, location, contact_number, description, status) 
            VALUES ($1, $2, $3, $4, $5, 'Open') 
            RETURNING id
        `;
        
        const ticketResult = await client.query(ticketQuery, [
            category, 
            priority || 'Medium', // Use default if priority is missing
            location, 
            contact_number, 
            description
        ]);
        
        const ticketId = ticketResult.rows[0].id;

        // 2. Insert Corresponding Notice for Management View
        const noticeTitle = `🚨 New Helpdesk Ticket: ${category} (${priority || 'Medium'})`;
        const noticeContent = `Location: ${location}. Contact: ${contact_number}. Description: ${description}. Ticket ID: ${ticketId.slice(0, 8)}...`;
        
        const noticeInsertQuery = `
            INSERT INTO ${NOTICES_TABLE} (title, content, posted_by, target_role)
            VALUES ($1, $2, $3, 'Admin') 
            RETURNING id;
        `;
        
        // Target role 'Admin' is typically used to notify management/staff
        await client.query(noticeInsertQuery, [
            noticeTitle, 
            noticeContent, 
            creatorId, 
        ]);
        
        await client.query('COMMIT'); // Commit transaction

        res.status(201).json({ 
            message: 'Ticket raised successfully and notification posted.', 
            ticketId: ticketId 
        });
    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error('Error creating ticket and posting notice:', err);
        res.status(500).json({ error: 'Server error raising ticket and notification' });
    } finally {
        client.release();
    }
});

// =========================================================================
// 3. RESOLVE TICKET (No change)
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
// 4. DELETE TICKET (No change)
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

// =========================================================================
// 5. GET SINGLE TICKET DETAILS (No change)
// =========================================================================
router.get('/:id', authenticateToken, async (req, res) => {
    const ticketId = req.params.id;
    try {
        const query = 'SELECT * FROM helpdesk_tickets WHERE id = $1';
        const result = await pool.query(query, [ticketId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching single ticket:', err);
        res.status(500).json({ error: 'Server error fetching ticket details' });
    }
});

// =========================================================================
// 6. ASSIGN TICKET (No change)
// =========================================================================
router.patch('/:id/assign', authenticateToken, async (req, res) => {
    const ticketId = req.params.id;
    // The staff member's user ID to whom the ticket will be assigned
    const { assigned_to_user_id } = req.body; 

    if (!assigned_to_user_id) {
        return res.status(400).json({ error: 'Assigned user ID is required' });
    }

    try {
        const query = `
            UPDATE helpdesk_tickets 
            SET assigned_to_user_id = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2 AND status != 'Closed'
            RETURNING id
        `;
        
        const result = await pool.query(query, [assigned_to_user_id, ticketId]);

        if (result.rowCount === 0) {
            // This happens if the ID is wrong or the ticket is already closed
            return res.status(404).json({ error: 'Ticket not found or already closed' });
        }

        res.json({ message: `Ticket ${ticketId} assigned to user ${assigned_to_user_id}` });
    } catch (err) {
        console.error('Error assigning ticket:', err);
        res.status(500).json({ error: 'Server error assigning ticket' });
    }
});

module.exports = router;