const express = require('express');
const router = express.Router();
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
const PAYROLL_RUNS_TABLE = 'payroll_runs'; 
const PAYROLL_RUN_DETAILS_TABLE = 'payroll_run_details'; 

// Apply authentication to all payroll routes
router.use(authenticateToken);

// =========================================================
// === SECTION 1: MANUAL/AD-HOC PAYROLL (Manage Payroll) ===
// =========================================================

/**
 * @route   GET /api/payroll/run-history-list
 * @desc    Fetch list of saved ad-hoc runs for admin dropdown
 */
router.get('/run-history-list', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    try {
        const result = await dbQuery(
            `SELECT run_id, pay_period_start, pay_period_end, status, run_date 
             FROM ${PAYROLL_RUNS_TABLE} 
             ORDER BY pay_period_start DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching payroll run history:', error); 
        res.status(500).json({ message: 'Failed to fetch payroll run history' });
    }
});

/**
 * @route   GET /api/payroll/run-details/:run_id
 * @desc    Fetch specific ad-hoc run details and employee snapshots
 */
router.get('/run-details/:run_id', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    const { run_id } = req.params;
    try {
        const runResult = await dbQuery(`SELECT * FROM ${PAYROLL_RUNS_TABLE} WHERE run_id = $1`, [run_id]);
        if (runResult.rows.length === 0) {
            return res.status(404).json({ message: 'Payroll run not found' });
        }
        
        const detailsResult = await dbQuery(`SELECT * FROM ${PAYROLL_RUN_DETAILS_TABLE} WHERE run_id = $1`, [run_id]);
        
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
 * @desc    Saves ad-hoc payroll run (Snapshots employee data at time of freeze)
 */
router.post('/save-run', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    const { pay_period_start, pay_period_end, status, total_gross_pay, total_deductions, total_net_pay, run_details } = req.body;
    const run_by_user_id = req.user.id;
    
    if (!run_by_user_id) return res.status(401).json({ message: 'User not authenticated.' });

    let client;
    try {
        client = await dbConnect(); 
        await client.query('BEGIN'); 

        const runInsertQuery = `
            INSERT INTO ${PAYROLL_RUNS_TABLE} 
                (pay_period_start, pay_period_end, status, total_gross_pay, total_deductions, total_net_pay, run_by_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING run_id;
        `;
        
        const runValues = [pay_period_start, pay_period_end, status, total_gross_pay, total_deductions, total_net_pay, run_by_user_id];
        const runResult = await client.query(runInsertQuery, runValues);
        const newRunId = runResult.rows[0].run_id;

        for (const detail of run_details) {
            const detailInsertQuery = `
                INSERT INTO ${PAYROLL_RUN_DETAILS_TABLE}
                    (run_id, user_id, full_name, department_name, days_paid, gross_pay, deductions, net_pay, payslip_snapshot)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
            `;
            const detailValues = [
                newRunId, detail.user_id, detail.full_name, detail.department_name, 
                detail.days_paid, detail.gross_pay, detail.deductions, detail.net_pay, 
                JSON.stringify(detail.payslip_snapshot)
            ];
            await client.query(detailInsertQuery, detailValues);
        }

        await client.query('COMMIT'); 
        res.status(201).json({ message: 'Payroll run saved successfully', runId: newRunId });
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('Error in save-run:', error); 
        res.status(500).json({ message: 'Failed to save payroll run', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// =========================================================
// === SECTION 2: FORMAL PERIOD-BASED SYSTEM (Automation) ===
// =========================================================

/**
 * Helper: Core net pay calculation logic
 */
function calculateNetPay(grossSalary, totalDeductions, taxRate = 0.20) {
    const taxes = grossSalary * taxRate;
    const netPay = grossSalary - totalDeductions - taxes;
    return { 
        gross: grossSalary, 
        taxes: taxes, 
        deductions: totalDeductions, 
        net: Math.round(netPay * 100) / 100 
    };
}

/**
 * @route   POST /api/payroll/generate/:periodId
 * @desc    Auto-generates formal payroll records for a specific period
 */
router.post('/generate/:periodId', authorize(PAYROLL_ADMIN_ROLES), async (req, res) => {
    const { periodId } = req.params;
    const adminId = req.user.id;
    let client;

    try {
        client = await dbConnect();
        await client.query('BEGIN'); 

        const periodRes = await client.query(`SELECT status FROM ${PAY_PERIODS_TABLE} WHERE id = $1`, [periodId]);
        if (periodRes.rowCount === 0 || periodRes.rows[0].status !== 'Open') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Period not found or already processed.' });
        }

        const employeesRes = await client.query(
            `SELECT u.id, u.username, pd.base_salary, pd.fixed_deductions
             FROM ${USERS_TABLE} u
             JOIN ${PAY_DETAILS_TABLE} pd ON u.id = pd.user_id
             WHERE u.role IN ('Teacher', 'Admin')`
        );

        const generatedRecords = [];
        for (const employee of employeesRes.rows) {
            const payBreakdown = calculateNetPay(parseFloat(employee.base_salary) / 12, parseFloat(employee.fixed_deductions || 0));
            
            const recordQuery = `
                INSERT INTO ${PAYROLL_RECORDS_TABLE} 
                (user_id, period_id, gross_pay, net_pay, taxes, deductions, status, generated_by)
                VALUES ($1, $2, $3, $4, $5, $6, 'Generated', $7) RETURNING id;
            `;
            const recordResult = await client.query(recordQuery, [employee.id, periodId, payBreakdown.gross, payBreakdown.net, payBreakdown.taxes, payBreakdown.deductions, adminId]);
            generatedRecords.push({ user: employee.username, record_id: recordResult.rows[0].id });
        }

        await client.query(`UPDATE ${PAY_PERIODS_TABLE} SET status = 'Generated' WHERE id = $1`, [periodId]);
        await client.query('COMMIT'); 
        res.status(201).json({ message: `Successfully generated ${generatedRecords.length} records.`, records: generatedRecords });
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('Generation Error:', error);
        res.status(500).json({ message: 'Generation failed.' });
    } finally {
        if (client) client.release();
    }
});

/**
 * @route   GET /api/payroll/employees/details
 * @desc    Full employee payroll config for admin management
 */
router.get('/employees/details', authorize(PAYROLL_MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT u.id AS user_id, t.employee_id, t.full_name, hd.department_name AS department, 
                   pd.base_salary AS pay_grade, pd.fixed_deductions, pd.tax_deduction_rate, 
                   pd.bank_account_number, pd.allowance_hra, pd.allowance_da, pd.bonus_target
            FROM ${PAY_DETAILS_TABLE} pd
            JOIN ${USERS_TABLE} u ON pd.user_id = u.id
            LEFT JOIN ${TEACHERS_TABLE} t ON u.id = t.user_id
            LEFT JOIN ${DEPARTMENTS_TABLE} hd ON t.department_id = hd.id
            WHERE u.role != 'Student' ORDER BY t.full_name;
        `;
        const result = await dbQuery(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Fetch Details Error:', error);
        res.status(500).json({ message: 'Failed to retrieve configuration details.' });
    }
});

// =========================================================
// === SECTION 3: UNIFIED VIEWS (Self-Service Portal) ===
// =========================================================

/**
 * @route   GET /api/payroll/my-history
 * @desc    Get logged-in user's history from BOTH formal and manual systems.
 */
router.get('/my-history', async (req, res) => {
    const userId = req.user.id;
    try {
        const query = `
            -- PART 1: Formal System Records (payroll_records table)
            SELECT 
                pr.id::text, 
                pr.net_pay, 
                pr.gross_pay, 
                pr.status, 
                pp.start_date, 
                pp.end_date, 
                'formal' as source
            FROM ${PAYROLL_RECORDS_TABLE} pr
            JOIN ${PAY_PERIODS_TABLE} pp ON pr.period_id = pp.id
            WHERE pr.user_id = $1

            UNION ALL

            -- PART 2: Manual Run Snapshots (payroll_run_details table)
            -- এরর ফিক্স: prd.id এর বদলে prd.run_id ব্যবহার করা হয়েছে
            SELECT 
                prd.run_id::text as id, 
                prd.net_pay, 
                prd.gross_pay, 
                'Paid' as status, 
                pr.pay_period_start as start_date, 
                pr.pay_period_end as end_date, 
                'manual' as source
            FROM payroll_run_details prd
            JOIN ${PAYROLL_RUNS_TABLE} pr ON prd.run_id = pr.run_id
            WHERE prd.user_id = $1
            
            ORDER BY end_date DESC;
        `;
        const result = await dbQuery(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Unified History Error:', error);
        res.status(500).json({ message: 'Failed to retrieve payroll history.' });
    }
});

/**
 * @route   GET /api/payroll/payslip/:recordId
 * @desc    Generates a double-column payslip with QR code verification
 */
router.get('/payslip/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const userId = req.user.id;
    const isManager = PAYROLL_MANAGER_ROLES.includes(req.user.role);

    try {
        // 1. Fetch Salary Data
        const payrollQuery = `
            SELECT * FROM (
                SELECT pr.id::text, pr.gross_pay, pr.net_pay, pr.taxes, pr.deductions, pr.status, 
                       pp.start_date, pp.end_date, u.username as employee_name, pr.user_id
                FROM ${PAYROLL_RECORDS_TABLE} pr
                JOIN ${PAY_PERIODS_TABLE} pp ON pr.period_id = pp.id
                JOIN ${USERS_TABLE} u ON pr.user_id = u.id
                UNION ALL
                SELECT prd.run_id::text as id, prd.gross_pay, prd.net_pay, (prd.gross_pay - prd.net_pay) as taxes, 
                       prd.deductions, 'Paid' as status, pr.pay_period_start as start_date, 
                       pr.pay_period_end as end_date, prd.full_name as employee_name, prd.user_id
                FROM payroll_run_details prd
                JOIN ${PAYROLL_RUNS_TABLE} pr ON prd.run_id = pr.run_id
            ) combined WHERE id = $1 AND (user_id = $2 OR $3 = true);
        `;
        const payrollRes = await dbQuery(payrollQuery, [recordId, userId, isManager]);
        if (payrollRes.rowCount === 0) return res.status(404).send("Payslip not found.");
        const payslip = payrollRes.rows[0];

        // 2. Fetch Identity from erp_settings
        const settingsRes = await dbQuery(`
            SELECT school_name, school_logo_path, school_address, school_phone, school_email, 
                   board_name, iso_status, skill_india_nsdc_id 
            FROM erp_settings LIMIT 1
        `);
        const school = settingsRes.rows[0] || {};
        
        // 3. Generate Verification URL for QR Code
        // This URL points to the digital copy for verification
        const verifyUrl = `${req.protocol}://${req.get('host')}/api/payroll/payslip/${recordId}`;
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(verifyUrl)}`;

        const watermarkText = Array(360).fill(`<div class="wm">${school.school_name || 'ERP'}</div>`).join('');

        // 4. Construct HTML Template
        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
                body { font-family: 'Inter', sans-serif; background: #f1f5f9; padding: 40px; margin: 0; color: #1e293b; }
                .slip-card { background: #fff; max-width: 900px; margin: 0 auto; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); position: relative; overflow: hidden; }
                
                .watermark { position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex; flex-wrap: wrap; 
                              opacity: 0.03; transform: rotate(-35deg); pointer-events: none; z-index: 1; justify-content: space-around; }
                .wm { margin: 25px; font-weight: 800; font-size: 11px; text-transform: uppercase; }

                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; z-index: 5; position: relative; }
                .school-brand { display: flex; align-items: center; }
                .logo { width: 70px; height: 70px; border-radius: 8px; margin-right: 15px; object-fit: contain; }
                .school-info h1 { margin: 0; font-size: 20px; color: #4f46e5; }
                .school-info p { margin: 3px 0; font-size: 11px; color: #64748b; }
                
                .qr-box { text-align: center; border: 1px solid #e2e8f0; padding: 5px; border-radius: 8px; background: #fff; }
                .qr-box span { font-size: 9px; color: #94a3b8; display: block; margin-top: 4px; }

                .meta-section { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 30px 0; font-size: 13px; position: relative; z-index: 5; }
                .ledger-container { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #e2e8f0; position: relative; z-index: 5; }
                .column-header { background: #f8fafc; padding: 10px 15px; font-size: 11px; font-weight: 700; text-transform: uppercase; border-bottom: 1px solid #e2e8f0; }
                .ledger-row { display: flex; justify-content: space-between; padding: 12px 15px; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
                
                .summary-banner { background: #4f46e5; color: #fff; padding: 20px 30px; border-radius: 0 0 12px 12px; display: flex; justify-content: space-between; align-items: center; margin: 0 -40px -40px -40px; position: relative; z-index: 5; }
                .summary-value { font-size: 24px; font-weight: 700; }

                @media print { .no-print { display: none; } body { background: #fff; padding: 0; } }
            </style>
        </head>
        <body>
            <div class="watermark">${watermarkText}</div>
            <div class="no-print" style="text-align: center; margin-bottom: 20px;"><button onclick="window.print()" style="background:#4f46e5; color:#fff; border:none; padding:10px 25px; border-radius:6px; cursor:pointer;">Print Payslip</button></div>

            <div class="slip-card">
                <div class="header">
                    <div class="school-brand">
                        <img src="${school.school_logo_path || '/images/default-logo.png'}" class="logo">
                        <div class="school-info">
                            <h1>${school.school_name || 'ENTERPRISE ERP'}</h1>
                            <p>${school.school_address || ''}</p>
                            <p><strong>Board:</strong> ${school.board_name || 'N/A'} | <strong>ISO:</strong> ${school.iso_status}</p>
                        </div>
                    </div>
                    <div class="qr-box">
                        <img src="${qrCodeUrl}" alt="Verification QR">
                        <span>Scan to Verify</span>
                    </div>
                </div>

                <div class="meta-section">
                    <div>
                        <strong>Employee:</strong> ${payslip.employee_name}<br>
                        <span style="color:#64748b; font-size:11px;">ID: ${payslip.user_id.substring(0,8)}</span>
                    </div>
                    <div style="text-align: right;">
                        <strong>Period:</strong> ${new Date(payslip.start_date).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}<br>
                        <span style="color:#64748b; font-size:11px;">Ref: ${payslip.id.substring(0,12)}</span>
                    </div>
                </div>

                <div class="ledger-container">
                    <div class="column" style="border-right: 1px solid #e2e8f0;">
                        <div class="column-header">Earnings</div>
                        <div class="ledger-row"><span>Basic Salary</span><span style="color:#059669; font-weight:600;">₹${parseFloat(payslip.gross_pay).toLocaleString('en-IN')}</span></div>
                    </div>
                    <div class="column">
                        <div class="column-header">Deductions</div>
                        <div class="ledger-row"><span>Income Tax</span><span style="color:#dc2626; font-weight:600;">₹${parseFloat(payslip.taxes || 0).toLocaleString('en-IN')}</span></div>
                        <div class="ledger-row"><span>Other</span><span style="color:#dc2626; font-weight:600;">₹${parseFloat(payslip.deductions || 0).toLocaleString('en-IN')}</span></div>
                    </div>
                </div>

                <div class="summary-banner">
                    <div>
                        <div style="font-size: 11px; text-transform: uppercase;">Net Take-Home</div>
                        <div style="font-size: 10px; opacity: 0.8;">Status: ${payslip.status}</div>
                    </div>
                    <div class="summary-value">₹${parseFloat(payslip.net_pay).toLocaleString('en-IN')}</div>
                </div>

                <div class="footer" style="margin-top: 60px; text-align: center; font-size: 10px; color: #94a3b8;">
                    <p>NSDC ID: ${school.skill_india_nsdc_id || 'N/A'} | Generated: ${new Date().toLocaleString()}</p>
                    <p>This document is digitally verified via QR code. No physical signature required.</p>
                </div>
            </div>
        </body>
        </html>`;

        res.send(html);

    } catch (error) {
        console.error('Payslip Error:', error);
        res.status(500).send("Failed to generate secure payslip.");
    }
});
module.exports = router;