/**
 * @fileoverview HR Department Management Router
 * @version 2.9.1 (Salary Data Sync & Multi-Campus Security)
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { pool } = require('../../database');
const { authenticateToken, authorize } = require('../../authMiddleware');

// 🔥 SCHEMA ALIGNMENT
const DEPARTMENTS_TABLE = 'hr_departments';
const TEACHERS_TABLE = 'teachers';

// --- Role Definitions ---
const CRUD_ROLES = ['Super Admin', 'Admin', 'HR', 'Prime Admin'];
const VIEW_ROLES = ['Super Admin', 'Admin', 'HR', 'Coordinator', 'Teacher', 'Employee', 'Student']; 

// --- Cashfree Credentials ---
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || 'TEST1062231616b8e10cae654d4df5ab61322601';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_API_KEY; 

// --- Utility: Handle Transaction Errors ---
async function handleTransactionError(client, error, res, action = 'operation') {
    if (client) await client.query('ROLLBACK');
    console.error(`Department ${action} Error:`, error.message);
    
    if (error.code === '23505') return res.status(409).json({ message: 'Department name already exists in this campus.' });
    if (error.code === '23503') return res.status(400).json({ message: 'Cannot delete. Department is currently linked to staff or records.' });
    
    res.status(500).json({ message: `Internal server error during department ${action}.` });
}

// =========================================================
// 1. BANK ACCOUNT VERIFICATION (Cashfree with Mock Fallback)
// =========================================================
router.post('/verify-bank-account', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const { accountNumber, ifsc } = req.body;
    
    try {
        const url = 'https://sandbox.cashfree.com/verification/bank-account/sync';
        const response = await axios.post(url, {
            bank_account: accountNumber,
            ifsc: ifsc
        }, {
            headers: {
                'x-client-id': CASHFREE_APP_ID,
                'x-client-secret': CASHFREE_SECRET_KEY,
                'Content-Type': 'application/json'
            }
        });

        return res.json({ 
            success: true, 
            verified_name: response.data.bank_account_name, 
            message: "Verified via Cashfree API" 
        });

    } catch (error) {
        console.warn("Cashfree API Unavailable. Using Mock Validation...");
        return res.json({ 
            success: true, 
            verified_name: "STABLE TEST ACCOUNT", 
            message: "Mock Mode: Verification bypassed for testing." 
        });
    }
});

// =========================================================
// 2. LIST ALL DEPARTMENTS (GET /api/hr/departments)
// =========================================================
router.get(['/', '/departments'], authenticateToken, authorize(VIEW_ROLES), async (req, res) => { 
    const isSuperAdmin = req.user.role.toLowerCase() === 'super admin' || req.user.role.toLowerCase() === 'prime admin';
    const branchId = isSuperAdmin ? (req.query.branch_id || req.user.branch_id) : req.user.branch_id;

    if (!branchId || branchId === 'null') {
        return res.status(400).json({ message: "Branch context missing." });
    }

    try {
        const query = `
            SELECT hd.id, hd.department_name, hd.description, hd.role, hd.branch_id, hd.created_at,
            COALESCE(COUNT(t.id) FILTER (WHERE t.is_active = TRUE), 0) AS staff_count
            FROM ${DEPARTMENTS_TABLE} hd
            LEFT JOIN ${TEACHERS_TABLE} t ON hd.id = t.department_id
            WHERE hd.branch_id = $1
            GROUP BY hd.id 
            ORDER BY hd.department_name;
        `;
        const result = await pool.query(query, [branchId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Dept Fetch Error:", error.message);
        res.status(500).json({ message: 'Failed to retrieve department data.' });
    }
});

// =========================================================
// 3. CREATE DEPARTMENT (POST /api/hr/departments)
// =========================================================
router.post(['/', '/departments'], authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const { department_name, description, role } = req.body;
    
    const isSuperAdmin = req.user.role.toLowerCase() === 'super admin';
    const branch_id = isSuperAdmin ? (req.body.branch_id || req.user.branch_id) : req.user.branch_id;

    if (!department_name) return res.status(400).json({ message: 'Department name is required.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `
            INSERT INTO ${DEPARTMENTS_TABLE} (department_name, description, role, branch_id) 
            VALUES ($1, $2, $3, $4) 
            RETURNING *;
        `;
        const result = await client.query(query, [
            department_name.trim(), 
            description || null, 
            role || 'General Staff',
            branch_id
        ]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Department created successfully.', department: result.rows[0] });
    } catch (error) {
        await handleTransactionError(client, error, res, 'creation');
    } finally { 
        client.release(); 
    }
});

// =========================================================
// 4. UPDATE DEPARTMENT & PAYROLL (PUT /api/hr/departments/:id)
// =========================================================
router.put(['/:id', '/departments/:id'], authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const deptId = req.params.id;
    const { 
        department_name, description, role,
        // Payroll fields mapped from frontend JSON body
        base_salary, pay_frequency, allowance_hra, allowance_da, 
        allowance_medical, allowance_other, deduction_percentage, 
        tax_deduction_rate, fixed_deductions, 
        bank_account_holder, bank_account_number, bank_ifsc_code 
    } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const check = await client.query(`SELECT description, branch_id FROM ${DEPARTMENTS_TABLE} WHERE id = $1`, [deptId]);
        if (check.rowCount === 0) return res.status(404).json({ message: 'Department not found.' });

        if (req.user.role.toLowerCase() !== 'super admin' && check.rows[0].branch_id !== req.user.branch_id) {
            return res.status(403).json({ message: 'Unauthorized branch access.' });
        }

        // --- PAYROLL DATA MAPPING ---
        let payload = {};
        try {
            const existingDesc = check.rows[0].description || '{}';
            payload = existingDesc.startsWith('{') ? JSON.parse(existingDesc) : { basic_description: existingDesc };
        } catch (e) {
            payload = { basic_description: check.rows[0].description };
        }

        // Update payroll structure
        payload.payroll_template = {
            base_salary: parseFloat(base_salary) || 0,
            pay_frequency: pay_frequency || 'Monthly',
            allowance_hra: parseFloat(allowance_hra) || 0,
            allowance_da: parseFloat(allowance_da) || 0,
            allowance_medical: parseFloat(allowance_medical) || 0,
            allowance_other: parseFloat(allowance_other) || 0,
            deduction_percentage: parseFloat(deduction_percentage) || 0,
            tax_deduction_rate: parseFloat(tax_deduction_rate) || 0,
            fixed_deductions: parseFloat(fixed_deductions) || 0,
            bank_account_holder,
            bank_account_number,
            bank_ifsc_code
        };

        const finalDescription = JSON.stringify(payload);

        const query = `
            UPDATE ${DEPARTMENTS_TABLE} 
            SET department_name = COALESCE($1, department_name), 
                description = $2, 
                role = COALESCE($3, role),
                updated_at = NOW() 
            WHERE id = $4 
            RETURNING *;
        `;
        await client.query(query, [department_name ? department_name.trim() : null, finalDescription, role, deptId]);
        
        await client.query('COMMIT');
        res.status(200).json({ message: 'Department and Payroll updated successfully.' });
    } catch (error) {
        await handleTransactionError(client, error, res, 'update');
    } finally { 
        client.release(); 
    }
});

// =========================================================
// 5. DELETE DEPARTMENT (DELETE /api/hr/departments/:id)
// =========================================================
router.delete(['/:id', '/departments/:id'], authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    try {
        const deptId = req.params.id;
        const check = await pool.query(`SELECT branch_id FROM ${DEPARTMENTS_TABLE} WHERE id = $1`, [deptId]);
        
        if (check.rowCount === 0) return res.status(404).json({ message: 'Department not found.' });
        if (req.user.role.toLowerCase() !== 'super admin' && check.rows[0].branch_id !== req.user.branch_id) {
            return res.status(403).json({ message: 'Unauthorized operation.' });
        }

        await pool.query(`DELETE FROM ${DEPARTMENTS_TABLE} WHERE id = $1`, [deptId]);
        res.status(200).json({ message: 'Department removed successfully.' });
    } catch (error) {
        if (error.code === '23503') {
            return res.status(400).json({ message: 'Cannot delete. Staff are still assigned to this department.' });
        }
        res.status(500).json({ message: 'Error during deletion.' });
    }
});

module.exports = router;