// routes/hr/departments.js - (FINAL FIX: Maximized roles for viewing)

const express = require('express');
const router = express.Router();
const { pool } = require('../../database');
const { authenticateToken, authorize } = require('../../authMiddleware');

const DEPARTMENTS_TABLE = 'hr_departments';
const TEACHERS_TABLE = 'teachers';
const CRUD_ROLES = ['Super Admin', 'Admin', 'HR'];
// FINAL VITAL FIX: Added 'Employee' and 'Student' to cover common viewing roles.
const VIEW_ROLES = ['Super Admin', 'Admin', 'HR', 'Coordinator', 'Teacher', 'Employee', 'Student']; // <-- EXPANDED ROLES

// --- Utility: Handle Database Transaction Errors ---
async function handleTransactionError(client, error, res, action = 'operation') {
    await client.query('ROLLBACK');
    console.error(`Department ${action} Error:`, error);
    
    let errorMessage = `Failed to complete department ${action}.`;
    
    if (error.code === '23505') {
        errorMessage = 'A department with this name already exists.';
        return res.status(409).json({ message: errorMessage });
    }
    // Check for foreign key constraint (Prevents deleting a department referenced by an active job posting)
    if (error.code === '23503') { 
        errorMessage = 'Cannot delete this department. It is currently referenced by other records (e.g., job postings).';
        return res.status(400).json({ message: errorMessage });
    }
    res.status(500).json({ message: errorMessage });
}

// =========================================================
// 1. GET: List All Departments (Uses broader VIEW_ROLES)
// =========================================================
router.get('/', authenticateToken, authorize(VIEW_ROLES), async (req, res) => { 
    try {
        const query = `
            SELECT 
                hd.id, 
                hd.name, 
                hd.description, 
                hd.created_at, 
                hd.updated_at,
                COALESCE(COUNT(t.id) FILTER (WHERE t.is_active = TRUE), 0) AS staff_count
            FROM ${DEPARTMENTS_TABLE} hd
            LEFT JOIN ${TEACHERS_TABLE} t ON hd.id = t.department_id
            GROUP BY hd.id
            ORDER BY hd.name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching departments list:', error);
        res.status(500).json({ message: 'Failed to retrieve department data.' });
    }
});


// =========================================================
// 2. POST: Create New Department (Uses stricter CRUD_ROLES)
// =========================================================
router.post('/', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    // Collect 'name' and 'description'. All other fields are treated as payroll template data.
    const { name, description, ...payroll_template_data } = req.body;
    
    if (!name || name.trim() === '') {
        return res.status(400).json({ message: 'Department name is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Combine the basic description with the Payroll Template into a single JSON object.
        const department_description_payload = {
            basic_description: description || null,
            payroll_template: payroll_template_data // Stores all salary fields as a JSON object
        };

        const department_description_json = JSON.stringify(department_description_payload);
        
        const query = `
            INSERT INTO ${DEPARTMENTS_TABLE} (name, description)
            VALUES ($1, $2)
            RETURNING id, name;
        `;
        const result = await client.query(query, [name.trim(), department_description_json]);

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Department and default payroll template created successfully for ${name}.`,
            department: result.rows[0]
        });

    } catch (error) {
        handleTransactionError(client, error, res, 'creation');
    } finally {
        client.release();
    }
});


// =========================================================
// 3. PUT: Update Department Details (Uses stricter CRUD_ROLES)
// =========================================================
router.put('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const deptId = req.params.id;
    // Collect 'name' and 'description'. All other fields are treated as payroll template data.
    const { name, description, ...payroll_template_data } = req.body;

    if (!name || name.trim() === '') {
        return res.status(400).json({ message: 'Department name is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Re-package the payload before update
        const department_description_payload = {
            basic_description: description || null,
            payroll_template: payroll_template_data // Update/Preserve the template
        };
        const department_description_json = JSON.stringify(department_description_payload);

        const query = `
            UPDATE ${DEPARTMENTS_TABLE} SET
                name = $1, 
                description = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING id, name;
        `;
        const result = await client.query(query, [name.trim(), department_description_json, deptId]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Department not found.' });
        }

        await client.query('COMMIT');
        res.status(200).json({ 
            message: 'Department updated successfully.',
            department: result.rows[0]
        });

    } catch (error) {
        handleTransactionError(client, error, res, 'update');
    } finally {
        client.release();
    }
});


// =========================================================
// 4. DELETE: Delete Department (Uses stricter CRUD_ROLES)
// =========================================================
router.delete('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const deptId = req.params.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const query = `
            DELETE FROM ${DEPARTMENTS_TABLE}
            WHERE id = $1;
        `;
        const result = await client.query(query, [deptId]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Department not found.' });
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Department deleted successfully.' });

    } catch (error) {
        handleTransactionError(client, error, res, 'deletion');
    } finally {
        client.release();
    }
});

module.exports = router;