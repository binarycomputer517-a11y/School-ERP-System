// routes/fees.js
// TRUE FULL & FINAL VERSION (Fixed Section 17 Defaulters Query)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');

// =========================================================
// CONSTANTS & CONFIGURATION
// =========================================================
const INVOICES_TABLE = 'fee_invoices';
const ITEMS_TABLE = 'invoice_items';
const PAYMENTS_TABLE = 'fee_payments';
const USERS_TABLE = 'users';
const STUDENTS_TABLE = 'students';
const TRANSPORT_ASSIGNMENTS_TABLE = 'student_transport_assignments';
const ROUTES_TABLE = 'transport_routes';
const COURSES_TABLE = 'courses';
const BATCHES_TABLE = 'batches';
const WAIVER_REQUESTS_TABLE = 'fee_waiver_requests';
const FEE_STRUCTURES_TABLE = 'fee_structures';
const DISCOUNTS_TABLE = 'fee_discounts';
const HOSTEL_RATES_TABLE = 'hostel_rates';
const LATE_FEE_CONFIG_TABLE = 'late_fee_config';

// Budget Tables
const BUDGET_CATEGORIES_TABLE = 'budget_categories';
const ANNUAL_BUDGETS_TABLE = 'annual_budgets';
const EXPENSES_TABLE = 'expenses';

const BASE_TUITION_FEE = 5000.00; 
const FEE_ROLES = ['Admin', 'Staff', 'Super Admin', 'Finance'];

// Helper: Generate Unique Invoice Number
const generateInvoiceNumber = () => {
    return `INV-${moment().format('YYYYMMDD')}-${uuidv4().split('-')[0].toUpperCase().substring(0, 6)}`;
};

// =========================================================
// 1. INVOICE GENERATION (POST)
// =========================================================
router.post('/generate/:month/:year', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const { month, year } = req.params;
    const adminId = req.user.id;
    const issueDate = moment(`${year}-${month}-01`).format('YYYY-MM-DD');
    const dueDate = moment(issueDate).add(15, 'days').format('YYYY-MM-DD');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const studentsRes = await client.query(`
            SELECT s.student_id, u.username, r.monthly_fee AS transport_fee, r.route_name
            FROM ${STUDENTS_TABLE} s
            JOIN ${USERS_TABLE} u ON s.user_id = u.id
            LEFT JOIN ${TRANSPORT_ASSIGNMENTS_TABLE} ta ON s.student_id = ta.student_id
            LEFT JOIN ${ROUTES_TABLE} r ON ta.route_id = r.id
            WHERE u.is_active = TRUE;
        `);

        const generatedInvoices = [];

        for (const student of studentsRes.rows) {
            let totalAmount = 0;
            const items = [];
            const invoiceNo = generateInvoiceNumber();

            items.push({ description: `Monthly Tuition Fee (${moment(issueDate).format('MMM YYYY')})`, amount: BASE_TUITION_FEE });
            totalAmount += BASE_TUITION_FEE;

            if (student.transport_fee) {
                const transportFee = parseFloat(student.transport_fee);
                items.push({ description: `Transport Fee (Route: ${student.route_name})`, amount: transportFee });
                totalAmount += transportFee;
            }

            const invoiceQuery = `
                INSERT INTO ${INVOICES_TABLE} (student_id, invoice_number, issue_date, due_date, total_amount, status, created_by)
                VALUES ($1::uuid, $2, $3, $4, $5, 'Pending', $6::uuid) RETURNING id;
            `;
            const invoiceResult = await client.query(invoiceQuery, [student.student_id, invoiceNo, issueDate, dueDate, totalAmount, adminId]);
            const invoiceId = invoiceResult.rows[0].id;

            const itemsValues = items.map(item => `('${invoiceId}', '${item.description.replace(/'/g, "''")}', ${item.amount})`).join(',');
            await client.query(`INSERT INTO ${ITEMS_TABLE} (invoice_id, description, amount) VALUES ${itemsValues};`);

            generatedInvoices.push({ invoiceId, invoiceNo, studentName: student.username, totalAmount });
        }

        await client.query('COMMIT');
        res.status(201).json({ message: `Successfully generated ${generatedInvoices.length} invoices.`, count: generatedInvoices.length });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Failed to generate invoices.' });
    } finally { client.release(); }
});

// =========================================================
// 2. MANUAL FEE COLLECTION (POST)
// =========================================================
router.post('/collect', authenticateToken, authorize(['admin', 'teacher', 'staff', 'super admin']), async (req, res) => {
    const { student_id, amount_paid, payment_mode, notes } = req.body;
    const collectedBy = req.user.id;

    if (!student_id || !amount_paid || !payment_mode || amount_paid <= 0) {
        return res.status(400).json({ message: 'Missing or invalid payment details.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Calculate Real Due
        const studentRes = await client.query(`
            SELECT s.course_id, s.batch_id, r.monthly_fee AS transport_fee
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${TRANSPORT_ASSIGNMENTS_TABLE} ta ON s.student_id = ta.student_id
            LEFT JOIN ${ROUTES_TABLE} r ON ta.route_id = r.id
            WHERE s.student_id = $1::uuid
        `, [student_id]);

        if (studentRes.rowCount === 0) throw new Error("Student not found");
        const student = studentRes.rows[0];

        let structureTotal = 0;
        structureTotal += BASE_TUITION_FEE; 
        if (student.transport_fee) structureTotal += parseFloat(student.transport_fee);

        // 2. Process Payment
        const openInvoicesRes = await client.query(`
            SELECT id, total_amount, paid_amount, (total_amount - paid_amount) AS balance_due
            FROM ${INVOICES_TABLE}
            WHERE student_id = $1::uuid AND status != 'Paid' AND status != 'Waived'
            ORDER BY due_date ASC;
        `, [student_id]);

        let remainingAmount = parseFloat(amount_paid);
        let paymentId = null;

        if (openInvoicesRes.rowCount > 0) {
            for (const invoice of openInvoicesRes.rows) {
                if (remainingAmount <= 0) break;

                const invoiceId = invoice.id;
                const balanceDue = parseFloat(invoice.balance_due);
                const paymentOnThisInvoice = Math.min(remainingAmount, balanceDue);

                if (paymentOnThisInvoice > 0) {
                    const paymentQuery = `INSERT INTO ${PAYMENTS_TABLE} (invoice_id, amount, payment_mode, transaction_id, collected_by, remarks) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6) RETURNING id;`;
                    const paymentResult = await client.query(paymentQuery, [invoiceId, paymentOnThisInvoice, payment_mode, 'MANUAL-' + uuidv4(), collectedBy, notes]);
                    
                    if (paymentId === null) paymentId = paymentResult.rows[0].id;

                    const newAmountPaid = parseFloat(invoice.paid_amount) + paymentOnThisInvoice;
                    let newStatus = 'Partial';
                    if (newAmountPaid >= (parseFloat(invoice.total_amount) - 0.01)) {
                        newStatus = 'Paid';
                    }

                    await client.query(`UPDATE ${INVOICES_TABLE} SET paid_amount = paid_amount + $1, status = $2 WHERE id = $3::uuid;`, [paymentOnThisInvoice, newStatus, invoiceId]);
                    remainingAmount -= paymentOnThisInvoice;
                }
            }
        }

        // 3. Handle Surplus / Adhoc Payment
        if (remainingAmount > 0) {
            const invoiceNo = generateInvoiceNumber();
            const adhocInvoiceRes = await client.query(`
                INSERT INTO ${INVOICES_TABLE} (student_id, invoice_number, issue_date, due_date, total_amount, paid_amount, status, created_by)
                VALUES ($1::uuid, $2, NOW(), NOW(), $3, $3, 'Paid', $4::uuid) RETURNING id;
            `, [student_id, invoiceNo, remainingAmount, collectedBy]);

            const invoiceId = adhocInvoiceRes.rows[0].id;
            const desc = openInvoicesRes.rowCount > 0 ? `Fee Balance Payment` : `Fee Collection (${notes || ''})`;
            
            await client.query(`INSERT INTO ${ITEMS_TABLE} (invoice_id, description, amount) VALUES ($1::uuid, $2, $3)`, [invoiceId, desc, remainingAmount]);

            const paymentQuery = `INSERT INTO ${PAYMENTS_TABLE} (invoice_id, amount, payment_mode, transaction_id, collected_by, remarks) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6) RETURNING id;`;
            const paymentResult = await client.query(paymentQuery, [invoiceId, remainingAmount, payment_mode, 'INSTANT-' + uuidv4(), collectedBy, notes]);
            
            if (paymentId === null) paymentId = paymentResult.rows[0].id;
        }

        await client.query('COMMIT');
        res.status(201).json({ message: `Payment recorded successfully.`, receipt_number: paymentId, paymentId: paymentId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Collect Error:', error);
        res.status(500).json({ message: 'Failed to record payment.' });
    } finally { client.release(); }
});

// =========================================================
// 3. VIEW INVOICES & ITEMS
// =========================================================
router.get('/invoices/student/:studentId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.*, u.username AS student_name
            FROM ${INVOICES_TABLE} i
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id
            JOIN ${USERS_TABLE} u ON s.user_id = u.id 
            WHERE i.student_id = $1::uuid ORDER BY i.issue_date DESC; 
        `, [req.params.studentId]);
        res.status(200).json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Failed to get invoices.' }); }
});

router.get('/invoice/:invoiceId/items', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${ITEMS_TABLE} WHERE invoice_id = $1::uuid ORDER BY created_at ASC`, [req.params.invoiceId]);
        res.status(200).json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Failed to get items.' }); }
});

// =========================================================
// 4. CONSOLIDATED STUDENT FEE STATUS
// =========================================================
router.get('/student/:studentId', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const { studentId } = req.params;
    try {
        const studentRes = await pool.query(`
            SELECT s.course_id, s.batch_id, s.roll_number, u.username AS student_name, c.course_name, b.batch_name, r.route_name, r.monthly_fee AS transport_fee_assigned
            FROM ${STUDENTS_TABLE} s JOIN ${USERS_TABLE} u ON s.user_id = u.id 
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id LEFT JOIN ${BATCHES_TABLE} b ON s.batch_id = b.id
            LEFT JOIN ${TRANSPORT_ASSIGNMENTS_TABLE} ta ON s.student_id = ta.student_id LEFT JOIN ${ROUTES_TABLE} r ON ta.route_id = r.id
            WHERE s.student_id = $1::uuid;
        `, [studentId]);
        
        if (studentRes.rowCount === 0) return res.status(404).json({ message: 'Student not found.' }); 
        const student = studentRes.rows[0];

        const calculatedStructureFee = BASE_TUITION_FEE + (parseFloat(student.transport_fee_assigned || 0));
        const totalPaidRes = await pool.query(`SELECT COALESCE(SUM(p.amount), 0.00) AS val FROM ${PAYMENTS_TABLE} p JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id WHERE i.student_id = $1::uuid`, [studentId]);
        const totalPaid = parseFloat(totalPaidRes.rows[0].val);

        const historyRes = await pool.query(`SELECT p.transaction_id AS receipt_number, p.amount AS amount_paid, p.payment_mode, p.payment_date, p.id AS paymentId FROM ${PAYMENTS_TABLE} p JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id WHERE i.student_id = $1::uuid ORDER BY p.payment_date DESC;`, [studentId]);

        res.status(200).json({
            student_name: student.student_name, course_name: student.course_name, 
            total_fees: calculatedStructureFee, total_paid: totalPaid, balance: calculatedStructureFee - totalPaid,
            payments: historyRes.rows
        });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Failed.' }); }
});

// =========================================================
// 5. GLOBAL HISTORY REPORT
// =========================================================
router.get('/history', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('month').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('month').format('YYYY-MM-DD');

    try {
        const query = `
            SELECT p.id AS payment_id, p.payment_date, p.transaction_id AS receipt_number, p.amount, p.payment_mode,
                u.username AS student_name, c.course_name
            FROM ${PAYMENTS_TABLE} p
            JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id
            JOIN ${USERS_TABLE} u ON s.user_id = u.id
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2
            ORDER BY p.payment_date DESC
        `;
        const result = await pool.query(query, [start, end]);
        res.status(200).json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Failed to fetch history.' }); }
});

// =========================================================
// 6. RECEIPT GENERATION (PDF)
// =========================================================
router.get('/receipt/:paymentId', authenticateToken, async (req, res) => {
    const { paymentId } = req.params;
    try {
        const query = `
            SELECT p.id, p.amount, p.payment_date, p.payment_mode, COALESCE(p.transaction_id, 'N/A') AS receipt_number, 
                i.invoice_number, u.username AS student_name
            FROM ${PAYMENTS_TABLE} p 
            JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id 
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id 
            JOIN ${USERS_TABLE} u ON s.user_id = u.id 
            WHERE p.id = $1::uuid
        `;
        const result = await pool.query(query, [paymentId]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Receipt not found.' });
        
        const data = result.rows[0];
        const doc = new PDFDocument();
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=receipt-${data.receipt_number}.pdf`);
        doc.pipe(res);

        doc.fontSize(20).text('SCHOOL ERP - RECEIPT', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Receipt No: ${data.receipt_number}`);
        doc.text(`Student: ${data.student_name}`);
        doc.text(`Amount: INR ${parseFloat(data.amount).toFixed(2)}`);
        doc.text(`Mode: ${data.payment_mode}`);
        doc.end();
    } catch (error) { res.status(500).json({ message: 'Failed to generate receipt.' }); }
});

// =========================================================
// 7. WAIVER MANAGEMENT (GET & PUT)
// =========================================================
router.get('/waiver-requests', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM ${WAIVER_REQUESTS_TABLE} ORDER BY request_date DESC`);
        res.status(200).json(rows);
    } catch (error) { res.status(500).json({ message: 'Failed.' }); }
});

router.put('/waiver-requests/:requestId/status', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const { requestId } = req.params; const { newStatus, amount } = req.body; 
    if (!newStatus) return res.status(400).json({ message: 'Missing status.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const requestRes = await client.query(`SELECT * FROM ${WAIVER_REQUESTS_TABLE} WHERE id = $1::uuid`, [requestId]);
        if (!requestRes.rows[0]) throw new Error("Request not found.");
        
        await client.query(`UPDATE ${WAIVER_REQUESTS_TABLE} SET status = $1, processed_by = $2::uuid, processed_date = NOW() WHERE id = $3::uuid;`, [newStatus, req.user.id, requestId]);
        
        if (newStatus.toLowerCase() === 'approved' && amount > 0) {
            const invoiceRes = await client.query(`SELECT id FROM ${INVOICES_TABLE} WHERE student_id = $1::uuid AND status != 'Paid' LIMIT 1`, [requestRes.rows[0].student_id]);
            if (invoiceRes.rows[0]) await client.query(`UPDATE ${INVOICES_TABLE} SET total_amount = total_amount - $1, discount_amount = COALESCE(discount_amount,0) + $1 WHERE id = $2::uuid`, [amount, invoiceRes.rows[0].id]);
        }
        await client.query('COMMIT'); res.status(200).json({ message: `Waiver ${newStatus}` });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ message: error.message }); } finally { client.release(); }
});

// =========================================================
// 8. REFUND MANAGEMENT (INFO & PROCESS)
// =========================================================
router.get('/student-refund-info/:studentId', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { studentId } = req.params;
    try {
        const balanceQuery = `
            SELECT (COALESCE((SELECT SUM(p.amount) FROM ${PAYMENTS_TABLE} p JOIN ${INVOICES_TABLE} inv ON p.invoice_id = inv.id WHERE inv.student_id = $1::uuid), 0.00)
            - COALESCE((SELECT SUM(total_amount) FROM ${INVOICES_TABLE} WHERE student_id = $1::uuid), 0.00)) AS refundable_balance
        `;
        const balanceResult = await pool.query(balanceQuery, [studentId]);
        res.status(200).json({ refundable_balance: parseFloat(balanceResult.rows[0]?.refundable_balance || 0) });
    } catch (error) { res.status(500).json({ message: 'Failed.' }); }
});

router.post('/refund', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { student_id, amount, reason } = req.body;
    try {
        const creditNote = `CN-${uuidv4().substring(0,6)}`;
        await pool.query(`INSERT INTO ${INVOICES_TABLE} (student_id, invoice_number, total_amount, paid_amount, status, created_by) VALUES ($1::uuid, $2, $3, $3, 'Refunded', $4::uuid)`, [student_id, creditNote, -amount, req.user.id]);
        res.status(200).json({ message: "Refund processed.", credit_note: creditNote });
    } catch (error) { res.status(500).json({ message: "Failed to process refund." }); }
});

// =========================================================
// 9. DISCOUNT MANAGEMENT (CRUD)
// =========================================================
router.get('/discounts', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${DISCOUNTS_TABLE} ORDER BY created_at DESC`);
        res.status(200).json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Failed.' }); }
});

router.post('/discounts', authenticateToken, authorize(['admin']), async (req, res) => {
    const { name, type, value, description } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO ${DISCOUNTS_TABLE} (name, type, value, description) VALUES ($1, $2, $3, $4) RETURNING *`,
            [name, type, value, description]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) { res.status(500).json({ message: 'Failed to create discount.' }); }
});

router.delete('/discounts/:id', authenticateToken, authorize(['admin']), async (req, res) => {
    try {
        await pool.query(`DELETE FROM ${DISCOUNTS_TABLE} WHERE id = $1::uuid`, [req.params.id]);
        res.status(200).json({ message: 'Discount deleted successfully.' });
    } catch (error) { res.status(500).json({ message: 'Failed to delete discount.' }); }
});

// =========================================================
// 10. HOSTEL RATES (CRUD)
// =========================================================
router.get('/hostel/rates', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${HOSTEL_RATES_TABLE}`);
        res.status(200).json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Failed.' }); }
});

router.post('/hostel/rates', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { rate_name, room_type, room_fee, meal_fee, notes } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO ${HOSTEL_RATES_TABLE} (rate_name, room_type, room_fee, meal_fee, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [rate_name, room_type, room_fee, meal_fee, notes]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) { res.status(500).json({ message: 'Failed to create hostel rate.' }); }
});

router.delete('/hostel/rates/:id', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    try {
        await pool.query(`DELETE FROM ${HOSTEL_RATES_TABLE} WHERE id = $1::uuid`, [req.params.id]);
        res.status(200).json({ message: 'Rate deleted successfully.' });
    } catch (error) { res.status(500).json({ message: 'Failed to delete rate.' }); }
});

// =========================================================
// 11. LATE FEE CONFIG (CRUD)
// =========================================================
router.get('/late-fee-config/current', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${LATE_FEE_CONFIG_TABLE} LIMIT 1`);
        res.status(200).json(result.rows[0] || {});
    } catch (error) { res.status(500).json({ message: 'Failed.' }); }
});

router.post('/late-fee-config', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { grace_days, penalty_type, penalty_value, max_penalty_value, compounding_interval } = req.body;
    try {
        await pool.query('BEGIN');
        await pool.query(`DELETE FROM ${LATE_FEE_CONFIG_TABLE}`);
        const result = await pool.query(`
            INSERT INTO ${LATE_FEE_CONFIG_TABLE} (grace_days, penalty_type, penalty_value, max_penalty_value, compounding_interval)
            VALUES ($1, $2, $3, $4, $5) RETURNING *
        `, [grace_days, penalty_type, penalty_value, max_penalty_value, compounding_interval]);
        await pool.query('COMMIT');
        res.status(200).json(result.rows[0]);
    } catch (error) { await pool.query('ROLLBACK'); res.status(500).json({ message: 'Failed to update config.' }); }
});

// =========================================================
// 12. REVENUE STREAM ANALYSIS
// =========================================================
router.get('/reports/revenue-stream', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    const { start_date, end_date, group_by } = req.query;
    const start = start_date || moment().startOf('month').format('YYYY-MM-DD');
    const end = end_date || moment().endOf('month').format('YYYY-MM-DD');

    try {
        let query = '';
        if (group_by === 'course') {
            query = `
                SELECT c.course_name AS category_name, b.batch_name AS sub_group, SUM(p.amount) AS amount
                FROM ${PAYMENTS_TABLE} p JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id LEFT JOIN ${BATCHES_TABLE} b ON s.batch_id = b.id
                WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2 GROUP BY c.course_name, b.batch_name
            `;
        } else {
            query = `
                SELECT SPLIT_PART(item.description, ' (', 1) AS category_name, c.course_name AS sub_group, SUM(item.amount) AS amount
                FROM ${PAYMENTS_TABLE} p JOIN ${ITEMS_TABLE} item ON p.invoice_id = item.invoice_id JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
                WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2 GROUP BY category_name, c.course_name
            `;
        }
        const result = await pool.query(query, [start, end]);
        const grandTotal = result.rows.reduce((acc, row) => acc + parseFloat(row.amount), 0);
        res.status(200).json({ breakdown: result.rows, grand_total: grandTotal });
    } catch (error) { res.status(500).json({ message: 'Failed.' }); }
});

// =========================================================
// 13. ANNUAL BUDGET REPORT (REAL DB IMPL)
// =========================================================
router.get('/reports/annual-budget', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    const { year } = req.query;
    const selectedYear = parseInt(year) || new Date().getFullYear();
    const startDate = `${selectedYear}-04-01`;
    const endDate = `${selectedYear + 1}-03-31`;

    const client = await pool.connect();
    try {
        // 1. Fetch Defined Budget Targets
        const budgetTargetsRes = await client.query(`
            SELECT b.category_id, c.name, c.type, b.budget_amount
            FROM ${ANNUAL_BUDGETS_TABLE} b
            JOIN ${BUDGET_CATEGORIES_TABLE} c ON b.category_id = c.id
            WHERE b.fiscal_year = $1
        `, [selectedYear]);

        const categoriesMap = {};
        budgetTargetsRes.rows.forEach(row => {
            categoriesMap[row.name] = { category_name: row.name, type: row.type, budgeted: parseFloat(row.budget_amount), actual: 0 };
        });

        // 2. Calculate Actual INCOME
        const incomeRes = await client.query(`SELECT COALESCE(SUM(amount), 0) as total FROM ${PAYMENTS_TABLE} WHERE payment_date >= $1 AND payment_date <= $2`, [startDate, endDate]);
        
        if (categoriesMap['Tuition Fee Collection']) {
            categoriesMap['Tuition Fee Collection'].actual = parseFloat(incomeRes.rows[0].total);
        } else {
            categoriesMap['Tuition Fee Collection'] = { category_name: 'Tuition Fee Collection', type: 'Income', budgeted: 0, actual: parseFloat(incomeRes.rows[0].total) };
        }

        // 3. Calculate Actual EXPENSES
        const expensesRes = await client.query(`
            SELECT c.name, SUM(e.amount) as total_spent
            FROM ${EXPENSES_TABLE} e JOIN ${BUDGET_CATEGORIES_TABLE} c ON e.category_id = c.id
            WHERE e.expense_date >= $1 AND e.expense_date <= $2 GROUP BY c.name
        `, [startDate, endDate]);

        expensesRes.rows.forEach(row => {
            if (categoriesMap[row.name]) {
                categoriesMap[row.name].actual = parseFloat(row.total_spent);
            } else {
                categoriesMap[row.name] = { category_name: row.name, type: 'Expense', budgeted: 0, actual: parseFloat(row.total_spent) };
            }
        });

        const categoriesArray = Object.values(categoriesMap);
        const totalBudgetedExpense = categoriesArray.filter(c => c.type === 'Expense').reduce((sum, item) => sum + item.budgeted, 0);
        const totalActualExpense = categoriesArray.filter(c => c.type === 'Expense').reduce((sum, item) => sum + item.actual, 0);
        const totalActualIncome = categoriesArray.filter(c => c.type === 'Income').reduce((sum, item) => sum + item.actual, 0);

        res.status(200).json({
            year: selectedYear,
            total_budget: totalBudgetedExpense,
            actual_spend: totalActualExpense,
            net_surplus: totalActualIncome - totalActualExpense,
            categories: categoriesArray
        });
    } catch (error) { res.status(500).json({ message: 'Failed.' }); } finally { client.release(); }
});

// =========================================================
// 14. BUDGET CONFIGURATION (POST)
// =========================================================
router.post('/budget-target', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { year, category_name, amount, type } = req.body; 
    try {
        let catRes = await pool.query(`SELECT id FROM ${BUDGET_CATEGORIES_TABLE} WHERE name = $1`, [category_name]);
        let catId;
        
        if (catRes.rowCount === 0) {
            const newCat = await pool.query(`INSERT INTO ${BUDGET_CATEGORIES_TABLE} (name, type) VALUES ($1, $2) RETURNING id`, [category_name, type || 'Expense']);
            catId = newCat.rows[0].id;
        } else {
            catId = catRes.rows[0].id;
        }

        await pool.query(`
            INSERT INTO ${ANNUAL_BUDGETS_TABLE} (fiscal_year, category_id, budget_amount) VALUES ($1, $2, $3)
            ON CONFLICT (fiscal_year, category_id) DO UPDATE SET budget_amount = $3
        `, [year, catId, amount]);
        
        res.status(200).json({ message: "Budget target updated successfully." });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// =========================================================
// 15. EXPENSE RECORDING (POST)
// =========================================================
router.post('/expenses', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { category_name, amount, description, date } = req.body;
    try {
        const catRes = await pool.query(`SELECT id FROM ${BUDGET_CATEGORIES_TABLE} WHERE name = $1`, [category_name]);
        if (catRes.rowCount === 0) return res.status(404).json({ message: "Category not found. Please create it via Budget Config first." });
        
        await pool.query(
            `INSERT INTO ${EXPENSES_TABLE} (category_id, amount, expense_date, description, recorded_by) VALUES ($1, $2, $3, $4, $5)`,
            [catRes.rows[0].id, amount, date || new Date(), description, req.user.id]
        );
        res.status(201).json({ message: "Expense recorded successfully." });
    } catch (err) { res.status(500).json({ message: err.message }); }
});


// =========================================================
// 16. REVENUE FORECAST (GET)
// =========================================================
router.get('/reports/revenue-forecast', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    try {
        const horizon = 6; // Forecast for next 6 months
        
        const query = `
            SELECT 
                TO_CHAR(due_date, 'Mon YYYY') as month_label,
                TO_CHAR(due_date, 'YYYY-MM') as sort_key,
                SUM(total_amount - paid_amount) as projected_amount,
                COUNT(id) as invoice_count
            FROM ${INVOICES_TABLE}
            WHERE status IN ('Pending', 'Partial') 
            AND due_date >= CURRENT_DATE
            AND due_date <= (CURRENT_DATE + INTERVAL '${horizon} months')
            GROUP BY sort_key, month_label
            ORDER BY sort_key ASC
        `;
        
        const result = await pool.query(query);
        
        // Calculate totals
        const totalProjected = result.rows.reduce((acc, row) => acc + parseFloat(row.projected_amount), 0);
        
        res.status(200).json({
            forecast_data: result.rows,
            total_projected: totalProjected
        });
    } catch (error) {
        console.error('Forecast Error:', error);
        res.status(500).json({ message: 'Failed to generate forecast.' });
    }
});



// =========================================================
// 17. DUES REMINDER SYSTEM (GET & POST)
// =========================================================

// A. Get List of Defaulters (SAFE VERSION - No Phone Column Dependency)
router.get('/defaulters', authenticateToken, authorize(['admin', 'finance', 'super admin']), async (req, res) => {
    try {
        // FIX APPLIED: Replaced 'u.phone' with hardcoded string 'N/A' 
        // to prevent "Column does not exist" crash.
        const query = `
            SELECT 
                s.student_id, 
                u.username AS student_name, 
                s.roll_number, 
                'N/A' AS parent_phone, 
                c.course_name, 
                b.batch_name,
                SUM(i.total_amount - i.paid_amount) AS total_due,
                COUNT(i.id) as pending_invoices_count
            FROM ${INVOICES_TABLE} i
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id
            JOIN ${USERS_TABLE} u ON s.user_id = u.id
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            LEFT JOIN ${BATCHES_TABLE} b ON s.batch_id = b.id
            WHERE i.status != 'Paid' AND i.status != 'Waived'
            GROUP BY s.student_id, u.username, s.roll_number, c.course_name, b.batch_name
            HAVING SUM(i.total_amount - i.paid_amount) > 0
            ORDER BY total_due DESC
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Defaulters Error:', error);
        res.status(500).json({ message: 'Failed to fetch defaulters list.' });
    }
});

// B. Send Bulk SMS Reminders
router.post('/reminders/send', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { students } = req.body; 
    
    if (!students || students.length === 0) {
        return res.status(400).json({ message: "No students selected." });
    }

    try {
        let sentCount = 0;
        let failedCount = 0;

        for (const student of students) {
            // We verify amount > 0. We skip phone check since it is N/A for now.
            if (student.amount > 0) {
                console.log(`[SMS GATEWAY] To: ${student.phone || 'N/A'} | Msg: Dear Parent, outstanding fees of Rs.${student.amount} is due for ${student.name}. Please pay immediately.`);
                sentCount++;
            } else {
                failedCount++;
            }
        }

        res.status(200).json({ 
            message: `Processed. Sent (Simulated): ${sentCount}, Skipped: ${failedCount}`,
            status: 'success'
        });

    } catch (error) {
        res.status(500).json({ message: 'Failed to process SMS queue.' });
    }
});
module.exports = router;