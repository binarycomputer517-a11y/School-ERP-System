// routes/branches.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

const BRANCHES_TABLE = 'branches';
const AUTH_ROLES = ['Super Admin']; 

// =========================================================
// R: GET ALL BRANCHES (Read - Using Confirmed Schema)
// =========================================================
/**
 * @route GET /api/branches
 * @desc Get all configured branches.
 * @access Private (Super Admin)
 */
router.get('/', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                id, 
                branch_name, 
                branch_code, 
                COALESCE(address, 'N/A') AS address,       -- Use address instead of location
                COALESCE(email, 'N/A') AS email,           -- Use email instead of contact_email
                COALESCE(phone_number, 'N/A') AS phone_number,
                is_active, 
                created_at
            FROM ${BRANCHES_TABLE}
            ORDER BY branch_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching branches:', error);
        res.status(500).json({ message: 'Failed to retrieve branches list due to SQL error.' });
    }
});

// =========================================================
// C: POST NEW BRANCH (Create - Using Confirmed Schema)
// =========================================================
/**
 * @route POST /api/branches
 * @desc Create a new branch.
 * @access Private (Super Admin)
 */
router.post('/', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    // Note: The frontend needs to send branch_code, address, phone_number, and email 
    // to match the table structure, OR the frontend model must be simplified.
    // For now, we enforce branch_name and branch_code as required.
    const { branch_name, branch_code, address, phone_number, email, is_active = true } = req.body;
    
    if (!branch_name || !branch_code) {
        return res.status(400).json({ message: 'Branch Name and Code are required.' });
    }
    
    try {
        const query = `
            INSERT INTO ${BRANCHES_TABLE} (branch_name, branch_code, address, phone_number, email, is_active)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, branch_name, branch_code;
        `;
        const result = await pool.query(query, [branch_name, branch_code, address, phone_number, email, is_active]);
        
        res.status(201).json({ 
            message: 'Branch created successfully.', 
            branch: result.rows[0] 
        });
    } catch (error) {
        console.error('Branch Creation Error:', error);
        if (error.code === '23505') { 
             return res.status(409).json({ message: 'Branch code or name already exists.' });
        }
        res.status(500).json({ message: 'Failed to create branch.' });
    }
});


// =========================================================
// U: PUT UPDATE BRANCH (Update - Using Confirmed Schema)
// =========================================================
/**
 * @route PUT /api/branches/:id
 * @desc Update branch details.
 * @access Private (Super Admin)
 */
router.put('/:id', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const branchId = req.params.id;
    const { branch_name, branch_code, address, phone_number, email, is_active } = req.body;

    try {
        const query = `
            UPDATE ${BRANCHES_TABLE}
            SET branch_name = COALESCE($1, branch_name),
                branch_code = COALESCE($2, branch_code),
                address = COALESCE($3, address),
                phone_number = COALESCE($4, phone_number),
                email = COALESCE($5, email),
                is_active = COALESCE($6, is_active),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7::uuid
            RETURNING *;
        `;
        const result = await pool.query(query, [branch_name, branch_code, address, phone_number, email, is_active, branchId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Branch not found.' });
        }
        res.status(200).json({ message: 'Branch updated successfully.', branch: result.rows[0] });
    } catch (error) {
        console.error('Branch Update Error:', error);
        if (error.code === '23505') { 
            return res.status(409).json({ message: 'Branch code or name already exists.' });
        }
        res.status(500).json({ message: 'Failed to update branch.' });
    }
});

// =========================================================
// D: DELETE BRANCH (Delete)
// =========================================================
router.delete('/:id', authenticateToken, authorize(AUTH_ROLES), async (req, res) => {
    const branchId = req.params.id;
    try {
        const result = await pool.query(`DELETE FROM ${BRANCHES_TABLE} WHERE id = $1::uuid`, [branchId]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Branch not found.' });
        }
        res.status(200).json({ message: 'Branch successfully deleted.' });
    } catch (error) {
        // This catch block will trigger if the branch is referenced by other tables (Foreign Key Constraint)
        console.error('Branch Deletion Error (Referenced by other data):', error);
        if (error.code === '23503') { // PostgreSQL Foreign Key Violation Code
            return res.status(409).json({ message: 'Cannot delete branch. It is currently referenced by active students, courses, or users.' });
        }
        res.status(500).json({ message: 'Failed to delete branch.' });
    }
});

module.exports = router;