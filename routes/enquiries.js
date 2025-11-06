const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// ===============================================
// 1. POST /api/enquiries - Add a new enquiry
// ===============================================
router.post('/', authenticateToken, authorize('Admin'), async (req, res) => {
    const {
        prospect_name,
        parent_name,
        contact_number,
        email,
        class_applied_for,
        source,
        notes
    } = req.body;

    try {
        // FIX: Explicitly set updated_at = NOW() upon creation, assuming created_at is defaulted by the DB.
        const newEnquiry = await pool.query(
            `INSERT INTO enquiries (prospect_name, parent_name, contact_number, email, class_applied_for, source, notes, status, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'New', NOW()) RETURNING *`,
            [prospect_name, parent_name, contact_number, email, class_applied_for, source, notes]
        );
        res.status(201).json(newEnquiry.rows[0]);
    } catch (err) {
        console.error('Error adding enquiry:', err);
        res.status(500).send('Server error');
    }
});

// ===============================================
// 2. GET /api/enquiries - Get all enquiries
// ===============================================
router.get('/', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const allEnquiries = await pool.query("SELECT * FROM enquiries ORDER BY created_at DESC");
        res.status(200).json(allEnquiries.rows);
    } catch (err) {
        console.error('Error fetching enquiries:', err);
        res.status(500).send('Server error');
    }
});

// ===============================================
// 3. GET /api/enquiries/:id - Get a single enquiry
// ===============================================
router.get('/:id', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query("SELECT * FROM enquiries WHERE id = $1", [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Enquiry not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(`Error fetching enquiry ID ${req.params.id}:`, err);
        res.status(500).send('Server error');
    }
});

// ===============================================
// 4. PUT /api/enquiries/:id - Update an enquiry
// ===============================================
router.put('/:id', authenticateToken, authorize('Admin'), async (req, res) => {
    const { id } = req.params;
    const {
        prospect_name,
        parent_name,
        contact_number,
        email,
        class_applied_for,
        source,
        notes,
        status // Include status for updates
    } = req.body;

    try {
        const result = await pool.query(
            // The updated_at column is now expected to exist in the database
            `UPDATE enquiries SET 
                prospect_name = $1, 
                parent_name = $2, 
                contact_number = $3, 
                email = $4, 
                class_applied_for = $5, 
                source = $6, 
                notes = $7, 
                status = $8,
                updated_at = NOW() 
             WHERE id = $9 RETURNING *`,
            [prospect_name, parent_name, contact_number, email, class_applied_for, source, notes, status, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Enquiry not found for update.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(`Error updating enquiry ID ${id}:`, err);
        res.status(500).send('Server error');
    }
});

// ===============================================
// 5. DELETE /api/enquiries/:id - Delete an enquiry
// ===============================================
router.delete('/:id', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query("DELETE FROM enquiries WHERE id = $1 RETURNING id", [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Enquiry not found for deletion.' });
        }
        res.status(200).json({ message: 'Enquiry deleted successfully.' });
    } catch (err) {
        console.error(`Error deleting enquiry ID ${req.params.id}:`, err);
        res.status(500).send('Server error');
    }
});

module.exports = router;