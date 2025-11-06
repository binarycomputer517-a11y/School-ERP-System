// /routes/payroll.js
const express = require('express');
const router = express.Router();
// CRITICAL FIX: Import the exported 'pool' property, and then destructure its query/connect methods.
// OR, simply rename it to 'db' for cleaner code if no other files require this destructuring:
const { pool } = require('../database'); 
const dbQuery = pool.query.bind(pool);
const dbConnect = pool.connect.bind(pool);

const { authenticateToken, authorize } = require('../authMiddleware'); 
const moment = require('moment');

// --- Role Definitions ---
const PAYROLL_MANAGER_ROLES = ['Super Admin', 'Admin', 'HR_STAFF', 'SENIOR_MGNT'];
const PAYROLL_ADMIN_ROLES = ['Super Admin', 'Admin'];

// --- Database Table Constants ---
const PAY_DETAILS_TABLE = 'employee_pay_details';
const PAY_PERIODS_TABLE = 'pay_periods';
const PAYROLL_RECORDS_TABLE = 'payroll_records';
const USERS_TABLE = 'users';
const TEACHERS_TABLE = 'teachers';
const DEPARTMENTS_TABLE = 'hr_departments';

// Use authenticateToken as the base middleware for all payroll routes
router.use(authenticateToken);

// =========================================================
// === Routes for Manual Payroll (manage-payroll.html) ===
// =========================================================

/**
 * @route   GET /api/payroll/run-history-list
 * @desc    Loads the list of saved ad-hoc runs (from payroll_runs) for the admin dropdown.
 * @access  Private (Managers)
 */
router.get('/run-history-list', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    try {
        // FIX APPLIED: Using dbQuery()
        const result = await dbQuery(
            `SELECT run_id, pay_period_start, pay_period_end, status, run_date 
             FROM payroll_runs 
             ORDER BY pay_period_start DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching payroll run history:', error);
        // CRITICAL FIX: The UI error shows this is failing.
        res.status(500).json({ message: 'Failed to fetch payroll run history' });
    }
});

/**
 * @route   GET /api/payroll/run-details/:run_id
 * @desc    Loads the detailed data for a specific ad-hoc run (from payroll_run_details).
 * @access  Private (Managers)
 */
router.get('/run-details/:run_id', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    const { run_id } = req.params;
    try {
        // FIX APPLIED: Using dbQuery()
        const runResult = await dbQuery('SELECT * FROM payroll_runs WHERE run_id = $1', [run_id]);
        if (runResult.rows.length === 0) {
            return res.status(404).json({ message: 'Payroll run not found' });
        }
        
        // FIX APPLIED: Using dbQuery()
        const detailsResult = await dbQuery('SELECT * FROM payroll_run_details WHERE run_id = $1', [run_id]);
        
        res.json({
            run_summary: runResult.rows[0],
            run_details: detailsResult.rows
        });

    } catch (error) {
        console.error('Error fetching payroll run details:', error);
        res.status(500).json({ message: 'Failed to fetch payroll run details' });
    }
});

/**
 * @route   POST /api/payroll/save-run
 * @desc    Saves a new ad-hoc run (from the Freeze button in manage-payroll.html).
 * @access  Private (Managers)
 */
router.post('/save-run', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    
    const {
        pay_period_start,
        pay_period_end,
        status,
        total_employees,
        total_gross_pay,
        total_deductions,
        total_net_pay,
        run_details
    } = req.body;
    
    const run_by_user_id = req.user.id;
    
    if (!run_by_user_id) {
        return res.status(401).json({ message: 'User not authenticated.' });
    }

    let client;
    try {
        // CRITICAL FIX: Using dbConnect()
        client = await dbConnect(); 
        await client.query('BEGIN'); // Start transaction on the client

        // 1. Save data to the main 'payroll_runs' table
        const runInsertQuery = `
            INSERT INTO payroll_runs 
                (pay_period_start, pay_period_end, status, total_employees, 
                 total_gross_pay, total_deductions, total_net_pay, run_by_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING run_id;
        `;
        
        const runValues = [
            pay_period_start, pay_period_end, status, total_employees,
            total_gross_pay, total_deductions, total_net_pay, run_by_user_id
        ];

        // Use client.query()
        const runResult = await client.query(runInsertQuery, runValues);
        const newRunId = runResult.rows[0].run_id;

        // 2. Save each employee's data to 'payroll_run_details'
        for (const detail of run_details) {
            const detailInsertQuery = `
                INSERT INTO payroll_run_details
                    (run_id, user_id, full_name, department_name, days_paid, 
                     gross_pay, deductions, net_pay, payslip_snapshot)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
            `;
            const detailValues = [
                newRunId,
                detail.user_id,
                detail.full_name,
                detail.department_name,
                detail.days_paid,
                detail.gross_pay,
                detail.deductions,
                detail.net_pay,
                JSON.stringify(detail.payslip_snapshot)
            ];
            
            // Use client.query()
            await client.query(detailInsertQuery, detailValues);
        }

        await client.query('COMMIT'); // Commit on the client
        
        res.status(201).json({
            message: 'Payroll run saved successfully',
            runId: newRunId
        });

    } catch (error) {
        // Ensure ROLLBACK is called on the client and the error is logged/handled.
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error('Error in /api/payroll/save-run:', error);
        res.status(500).json({ message: 'Failed to save payroll run', error: error.message });
    } finally {
        // CRITICAL FIX: Always release the client back to the pool
        if (client) {
            client.release();
        }
    }
});

// =========================================================
// === Routes for Formal, Period-Based Payroll System ===
// =========================================================

// --- Helper Functions ---
function calculateNetPay(grossSalary, totalDeductions, taxRate = 0.20) {
    const taxableIncome = grossSalary;
    const taxes = taxableIncome * taxRate;
    const netPay = grossSalary - totalDeductions - taxes;
    return { gross: grossSalary, taxes: taxes, deductions: totalDeductions, net: Math.round(netPay * 100) / 100 };
}

/**
 * @route   POST /api/payroll/generate/:periodId
 * @desc    Generates payroll for all eligible employees for a specific pay period.
 * @access  Private (Admin, Super Admin)
 */
router.post('/generate/:periodId', authorize(PAYROLL_ADMIN_ROLES), async (req, res) => {
    const { periodId } = req.params;
    const adminId = req.user.id;
    let client;

    try {
        // CRITICAL FIX: Using dbConnect()
        client = await dbConnect();
        await client.query('BEGIN'); // Start transaction on the client

        // 1. Fetch Pay Period Details
        const periodRes = await client.query(
            `SELECT start_date, end_date, status FROM ${PAY_PERIODS_TABLE} WHERE id = $1`,
            [periodId]
        );
        if (periodRes.rowCount === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ message: 'Pay period not found.' });
        }
        if (periodRes.rows[0].status !== 'Open') {
            await client.query('ROLLBACK');
            client.release();
            return res.status(400).json({ message: `Payroll generation failed: Period is already ${periodRes.rows[0].status}.` });
        }
        const period = periodRes.rows[0];

        // 2. Fetch all employees eligible for payroll
        const employeesRes = await client.query(
            `SELECT u.id, u.username, pd.base_salary, pd.fixed_deductions
             FROM ${USERS_TABLE} u
             JOIN ${PAY_DETAILS_TABLE} pd ON u.id = pd.user_id
             WHERE u.role = 'Teacher' OR u.role = 'Admin'`
        );

        if (employeesRes.rowCount === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ message: 'No eligible employees found for payroll generation.' });
        }

        const generatedRecords = [];

        // 3. Process Payroll for Each Employee
        for (const employee of employeesRes.rows) {
            const annualSalary = parseFloat(employee.base_salary);
            const monthlyGross = annualSalary / 12;
            const fixedDeductions = parseFloat(employee.fixed_deductions || 0);
            
            // Calculate Pay
            const payBreakdown = calculateNetPay(monthlyGross, fixedDeductions);
            
            const recordQuery = `
                INSERT INTO ${PAYROLL_RECORDS_TABLE} 
                (user_id, period_id, gross_pay, net_pay, taxes, deductions, status, generated_by)
                VALUES ($1, $2, $3, $4, $5, $6, 'Generated', $7)
                RETURNING id;
            `;
            const recordResult = await client.query(recordQuery, [
                employee.id,
                periodId,
                payBreakdown.gross,
                payBreakdown.net,
                payBreakdown.taxes,
                payBreakdown.deductions,
                adminId
            ]);
            generatedRecords.push({ user: employee.username, record_id: recordResult.rows[0].id, net: payBreakdown.net });
        }

        // 4. Update Pay Period Status
        await client.query(
            `UPDATE ${PAY_PERIODS_TABLE} SET status = 'Generated' WHERE id = $1`,
            [periodId]
        );

        await client.query('COMMIT'); 
        res.status(201).json({
            message: `Payroll successfully generated for ${generatedRecords.length} employees.`,
            records: generatedRecords
        });

    } catch (error) {
        if (client) {
            // Ensure ROLLBACK is called on the client
            await client.query('ROLLBACK');
        }
        console.error('Payroll Generation Error:', error);
        res.status(500).json({ message: 'Failed to generate payroll.' });
    } finally {
        // CRITICAL FIX: Always release the client back to the pool
        if (client) {
            client.release();
        }
    }
});


/**
 * @route   GET /api/payroll/employees/details
 * @desc    Get full details for all employees with payroll configuration, joined with teacher and dept info.
 * @access  Private (Admin, HR_STAFF, SENIOR_MGNT, Super Admin)
 */
router.get('/employees/details', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                u.id AS user_id,
                t.employee_id,
                t.full_name, 
                hd.name AS department,
                hd.id AS department_id, -- Added for front-end filter logic
                pd.base_salary AS pay_grade,
                pd.fixed_deductions,
                pd.tax_deduction_rate,
                pd.pay_frequency,
                pd.bank_account_number,
                pd.allowance_hra,
                pd.allowance_da,
                pd.allowance_other,
                pd.bonus_target
            FROM ${PAY_DETAILS_TABLE} pd
            JOIN ${USERS_TABLE} u ON pd.user_id = u.id
            LEFT JOIN ${TEACHERS_TABLE} t ON u.id = t.user_id
            LEFT JOIN ${DEPARTMENTS_TABLE} hd ON t.department_id = hd.id
            WHERE u.role != 'Student' 
            ORDER BY t.full_name;
        `;
        // FIX APPLIED: Using dbQuery()
        const result = await dbQuery(query); // Direct query

        // Map database fields to the structure expected by the frontend
        const mappedResults = result.rows.map(row => ({
            user_id: row.user_id,
            employee_id: row.employee_id || row.user_id,
            full_name: row.full_name,
            department: row.department || 'N/A',
            department_id: row.department_id, // Passed through to support front-end logic
            pay_grade: parseFloat(row.pay_grade),
            account_number: row.bank_account_number || 'N/A',
            fixed_deductions: parseFloat(row.fixed_deductions),
            tax_deduction_rate: parseFloat(row.tax_deduction_rate),
            
            // Pass allowance data
            allowance_hra: parseFloat(row.allowance_hra),
            allowance_da: parseFloat(row.allowance_da),
            allowance_other: parseFloat(row.allowance_other),
            bonus_target: parseFloat(row.bonus_target)
        }));

        res.status(200).json(mappedResults);
    } catch (error) {
        console.error('Employee Details Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve employee payroll configuration details.' });
    }
});


/**
 * @route   GET /api/payroll/payslip/:recordId
 * @desc    View a specific payslip record (from the formal system).
 * @access  Private (Self/Admin/HR)
 */
router.get('/payslip/:recordId', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    const { recordId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    try {
        const query = `
            SELECT 
                pr.id, pr.gross_pay, pr.net_pay, pr.taxes, pr.deductions, pr.status, pr.created_at,
                pp.start_date, pp.end_date, 
                u.username AS employee_name
            FROM ${PAYROLL_RECORDS_TABLE} pr
            JOIN ${PAY_PERIODS_TABLE} pp ON pr.period_id = pp.id
            JOIN ${USERS_TABLE} u ON pr.user_id = u.id
            WHERE pr.id = $1 AND (pr.user_id = $2 OR $3 = ANY(ARRAY['Admin', 'Super Admin', 'HR_STAFF', 'SENIOR_MGNT']));
        `;
        // FIX APPLIED: Using dbQuery()
        const result = await dbQuery(query, [recordId, userId, userRole]); // Direct query

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Payslip record not found or access denied.' });
        }
        
        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error('Payslip Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve payslip.' });
    }
});

/**
 * @route   GET /api/payroll/my-history
 * @desc    Get the logged-in user's personal payroll history (from the formal system).
 * @access  Private (Any logged-in user)
 */
router.get('/my-history', async (req, res) => {
    const userId = req.user.id;

    try {
        const query = `
            SELECT 
                pr.id, pr.net_pay, pr.gross_pay, pr.status, pr.created_at,
                pp.start_date, pp.end_date
            FROM ${PAYROLL_RECORDS_TABLE} pr
            JOIN ${PAY_PERIODS_TABLE} pp ON pr.period_id = pp.id
            WHERE pr.user_id = $1
            ORDER BY pp.end_date DESC;
        `;
        // FIX APPLIED: Using dbQuery()
        const result = await dbQuery(query, [userId]); // Direct query
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Payroll History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve payroll history.' });
    }
});


module.exports = router;