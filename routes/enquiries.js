/**
 * @fileoverview Express router for handling enquiry-related API endpoints.
 * @module routes/enquiries
 */

// =================================================================
// --- IMPORTS AND ROUTER SETUP ---
// =================================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// Define all recognized authenticated roles for read access.
const ALL_AUTHENTICATED_ROLES = ['Admin', 'Super Admin', 'Teacher', 'Coordinator', 'Student'];


// ===============================================
// 1. POST /api/enquiries - Add a new enquiry
// ===============================================
/**
 * @route   POST /api/enquiries
 * @desc    Add a new enquiry (typically from a public form)
 * @access  Public (No Authentication required)
 */
// FIX: Removed authenticateToken and authorize middleware to allow public access.
router.post('/', async (req, res) => { 
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
/**
 * @route   GET /api/enquiries
 * @desc    Get all enquiries
 * @access  Private (All Authenticated Roles)
 */
// FIX: Updated authorize middleware to allow access for all authenticated users.
router.get('/', authenticateToken, authorize(ALL_AUTHENTICATED_ROLES), async (req, res) => {
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
/**
 * @route   GET /api/enquiries/:id
 * @desc    Get a single enquiry
 * @access  Private (All Authenticated Roles)
 */
// FIX: Updated authorize middleware to allow access for all authenticated users.
router.get('/:id', authenticateToken, authorize(ALL_AUTHENTICATED_ROLES), async (req, res) => {
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
/**
 * @route   PUT /api/enquiries/:id
 * @desc    Update an enquiry
 * @access  Private (Only Admins/Super Admins, as this is a sensitive operation)
 */
// NOTE: PUT operation remains restricted to 'Admin' and 'Super Admin'.
router.put('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const {
        prospect_name,
        parent_name,
        contact_number,
        email,
        class_applied_for,
        source,
        notes,
        status 
    } = req.body;

    try {
        const result = await pool.query(
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
/**
 * @route   DELETE /api/enquiries/:id
 * @desc    Delete an enquiry
 * @access  Private (Only Admins/Super Admins, as this is a sensitive operation)
 */
// NOTE: DELETE operation remains restricted to 'Admin' and 'Super Admin'.
router.delete('/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
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