// routes/fees.js (Advanced Fee Collection Module)

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');

// Database Table Constants
const INVOICES_TABLE = 'fee_invoices';
const ITEMS_TABLE = 'invoice_items';
const PAYMENTS_TABLE = 'fee_payments';
const USERS_TABLE = 'users';
const STUDENTS_TABLE = 'students'; // Added for clarity in the fix
const TRANSPORT_ASSIGNMENTS_TABLE = 'student_transport_assignments'; 
const ROUTES_TABLE = 'transport_routes'; 

// Constants
const BASE_TUITION_FEE = 5000.00; 
const FEE_STATUSES = ['Pending', 'Partial', 'Paid', 'Waived', 'Overdue'];

// =========================================================
// 1. INVOICE GENERATION (POST) - ADMIN ONLY
// =========================================================

/**
 * @route   POST /api/fees/generate/:month/:year
 * @desc    Generates monthly invoices for all enrolled students.
 * @access  Private (Admin, Super Admin)
 */
router.post('/generate/:month/:year', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { month, year } = req.params;
    const adminId = req.user.userId;
    const issueDate = moment(`${year}-${month}-01`).format('YYYY-MM-DD'); 
    const dueDate = moment(issueDate).add(15, 'days').format('YYYY-MM-DD');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Fetch all active students and their current transport assignment
        const studentsRes = await client.query(`
            SELECT 
                u.id AS student_id, u.username, 
                r.monthly_fee AS transport_fee, r.route_name
            FROM ${USERS_TABLE} u
            LEFT JOIN ${TRANSPORT_ASSIGNMENTS_TABLE} ta ON u.id = ta.student_id
            LEFT JOIN ${ROUTES_TABLE} r ON ta.route_id = r.id
            WHERE u.role = 'Student'
            AND u.is_active = TRUE; 
        `);
        
        const generatedInvoices = [];

        // 2. Loop through students and create invoices
        for (const student of studentsRes.rows) {
            let totalAmount = 0;
            const items = [];

            // A. Add Base Tuition Fee
            items.push({ 
                description: `Monthly Tuition Fee (${moment(issueDate).format('MMM YYYY')})`, 
                amount: BASE_TUITION_FEE 
            });
            totalAmount += BASE_TUITION_FEE;

            // B. Add Transport Fee (Integration Point)
            if (student.transport_fee) {
                const transportFee = parseFloat(student.transport_fee);
                items.push({
                    description: `Transport Fee (Route: ${student.route_name})`,
                    amount: transportFee
                });
                totalAmount += transportFee;
            }

            // C. Insert Invoice Record
            const invoiceQuery = `
                INSERT INTO ${INVOICES_TABLE} (student_id, issue_date, due_date, total_amount, status, created_by)
                VALUES ($1, $2, $3, $4, 'Pending', $5)
                RETURNING id;
            `;
            const invoiceResult = await client.query(invoiceQuery, [
                student.student_id, issueDate, dueDate, totalAmount, adminId
            ]);
            const invoiceId = invoiceResult.rows[0].id;

            // D. Insert Invoice Items
            const itemsValues = items.map(item => 
                `('${invoiceId}', '${item.description}', ${item.amount})`
            ).join(',');
            
            await client.query(`
                INSERT INTO ${ITEMS_TABLE} (invoice_id, description, amount)
                VALUES ${itemsValues};
            `);

            generatedInvoices.push({ invoiceId, studentName: student.username, totalAmount });
        }

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Successfully generated ${generatedInvoices.length} invoices for ${moment(issueDate).format('MMM YYYY')}.`,
            count: generatedInvoices.length
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Invoice Generation Error:', error);
        res.status(500).json({ message: 'Failed to generate invoices.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. MANUAL FEE COLLECTION (POST) 
// =========================================================

/**
 * @route   POST /api/fees/collect
 * @desc    Records a manual payment against outstanding invoices for a student.
 * @access  Private (Admin, Teacher, Staff, Super Admin)
 */
router.post('/collect', authenticateToken, authorize(['Admin', 'Teacher', 'Staff', 'Super Admin']), async (req, res) => {
    // student_id here is the UUID from the students table
    const { student_id, amount_paid, payment_mode, notes } = req.body;
    const collectedBy = req.user.userId; 

    if (!student_id || !amount_paid || !payment_mode || amount_paid <= 0) {
        return res.status(400).json({ message: 'Missing or invalid payment details.' });
    }

    let remainingAmount = parseFloat(amount_paid);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Get ALL open/pending invoices for the student (ordered by due date)
        const openInvoicesRes = await client.query(`
            SELECT 
                id, total_amount, paid_amount, (total_amount - paid_amount) AS balance_due
            FROM ${INVOICES_TABLE}
            WHERE student_id = $1 AND status != 'Paid' AND status != 'Waived'
            ORDER BY due_date ASC;
        `, [student_id]);
        
        let paymentId = null;

        // 2. Loop through invoices and apply payment
        for (const invoice of openInvoicesRes.rows) {
            const invoiceId = invoice.id;
            const balanceDue = parseFloat(invoice.balance_due);

            if (remainingAmount <= 0) break;

            const paymentOnThisInvoice = Math.min(remainingAmount, balanceDue);

            if (paymentOnThisInvoice > 0) {
                // A. Record Payment Transaction 
                const paymentQuery = `
                    INSERT INTO ${PAYMENTS_TABLE} (invoice_id, amount, payment_mode, transaction_id, collected_by, remarks)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id;
                `;
                const paymentResult = await client.query(paymentQuery, [
                    invoiceId, paymentOnThisInvoice, payment_mode, paymentId || 'TEMP-' + Math.random().toString(36).substring(2, 9), collectedBy, notes
                ]);
                
                if (paymentId === null) {
                    paymentId = paymentResult.rows[0].id; // Capture the first payment ID as the "Receipt No"
                }

                // B. Update Invoice Status
                const newAmountPaid = parseFloat(invoice.paid_amount) + paymentOnThisInvoice; 
                let newStatus = 'Partial';
                if (newAmountPaid >= invoice.total_amount) {
                    newStatus = 'Paid';
                }

                await client.query(`
                    UPDATE ${INVOICES_TABLE}
                    SET 
                        paid_amount = paid_amount + $1,
                        status = $2
                    WHERE id = $3;
                `, [paymentOnThisInvoice, newStatus, invoiceId]); 
                

                remainingAmount -= paymentOnThisInvoice;
            }
        }

        if (paymentId === null) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'No outstanding balance found to apply payment. Student may be fully paid.' });
        }

        await client.query('COMMIT');
        res.status(201).json({ 
            message: `Payment recorded successfully. ${amount_paid - remainingAmount} applied to invoices.`,
            receipt_number: paymentId,
            paymentId: paymentId 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Payment Collection Error:', error);
        res.status(500).json({ message: 'Failed to record payment.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 3. VIEWING & REPORTING (GET)
// =========================================================

/**
 * @route   GET /api/fees/invoices/student/:studentId
 * @desc    Get all invoices for a specific student.
 * @access  Private (Admin, Staff, Super Admin, or Student/Parent checking self)
 */
router.get('/invoices/student/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    const userId = req.user.userId;
    const userRole = req.user.role;

    if (userRole !== 'Admin' && userRole !== 'Staff' && userRole !== 'Super Admin' && studentId !== userId) {
        return res.status(403).json({ message: 'Access denied to these invoices.' });
    }

    try {
        const query = `
            SELECT 
                i.*, 
                u.username AS student_name
            FROM ${INVOICES_TABLE} i
            -- NOTE: If your student table is linked to users table, you might need a different join here
            -- The existing join is likely wrong as i.student_id is UUID from students table
            -- Assuming 'u' is the student's user record, this needs verification based on your schema.
            JOIN ${USERS_TABLE} u ON i.student_id = u.student_id 
            WHERE i.student_id = $1
            ORDER BY i.issue_date DESC; 
        `;
        const result = await pool.query(query, [studentId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Invoice Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve invoices.' });
    }
});

/**
 * @route   GET /api/fees/invoice/:invoiceId/items
 * @desc    Get detailed line items for a specific invoice.
 * @access  Private (Admin, Staff, Super Admin, Student/Parent checking self)
 */
router.get('/invoice/:invoiceId/items', authenticateToken, async (req, res) => {
    const { invoiceId } = req.params;
    
    try {
        const query = `
            SELECT *
            FROM ${ITEMS_TABLE}
            WHERE invoice_id = $1
            ORDER BY created_at ASC;
        `;
        const result = await pool.query(query, [invoiceId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Invoice Items Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve invoice items.' });
    }
});


// =========================================================
// 4. CONSOLIDATED STUDENT FEE STATUS (GET) - FIXED LOGIC
// =========================================================

/**
 * @route   GET /api/fees/student/:studentId
 * @desc    Get consolidated fee status (invoices, payments, balance) for a single student.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/student/:studentId', authenticateToken, authorize(['Admin', 'Staff', 'Super Admin']), async (req, res) => {
    // studentId here is the UUID from the students.id column
    const { studentId } = req.params;
    
    try {
        // 1. Calculate Total Invoiced Amount (Total Fees)
        const totalFeesQuery = `
            SELECT COALESCE(SUM(total_amount), 0.00) AS total_fees
            FROM ${INVOICES_TABLE}
            WHERE student_id = $1;
        `;
        const totalFeesResult = await pool.query(totalFeesQuery, [studentId]);
        const totalFees = parseFloat(totalFeesResult.rows[0].total_fees);

        // 2. Calculate Total Paid Amount
        const totalPaidQuery = `
            SELECT COALESCE(SUM(p.amount), 0.00) AS total_paid
            FROM ${PAYMENTS_TABLE} p
            JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id
            WHERE i.student_id = $1;
        `;
        const totalPaidResult = await pool.query(totalPaidQuery, [studentId]);
        const totalPaid = parseFloat(totalPaidResult.rows[0].total_paid);

        // 3. Get Payment History 
        const historyQuery = `
            SELECT 
                p.id AS paymentId,
                p.transaction_id AS receipt_number, 
                p.amount AS amount_paid,
                p.payment_mode AS payment_mode, 
                p.payment_date AS payment_date 
            FROM ${PAYMENTS_TABLE} p
            JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id
            WHERE i.student_id = $1
            ORDER BY p.payment_date DESC; 
        `;
        const historyResult = await pool.query(historyQuery, [studentId]);

        // 4. Get a Mock Fee Structure Breakdown
        const structureQuery = `
            SELECT 
                it.description AS fee_name, 
                SUM(it.amount) AS amount  
            FROM ${ITEMS_TABLE} it
            JOIN ${INVOICES_TABLE} inv ON it.invoice_id = inv.id
            WHERE inv.student_id = $1
            GROUP BY it.description 
            ORDER BY SUM(it.amount) DESC; 
        `;
        const structureResult = await pool.query(structureQuery, [studentId]);
        const feeStructure = structureResult.rows;


        // 5. Fetch basic student details (FIXED: Queries students table by student.id and joins to users)
        const studentDetailsQuery = `
            SELECT 
                u.username AS student_name, 
                c.course_name, 
                b.batch_name
            FROM ${STUDENTS_TABLE} s
            JOIN ${USERS_TABLE} u ON s.user_id = u.id -- Link student record to their user account
            -- Join to courses and batches tables for actual names (assuming they exist and are correctly named)
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            WHERE s.id = $1;
        `;
        const studentDetailsResult = await pool.query(studentDetailsQuery, [studentId]);
        
        if (studentDetailsResult.rowCount === 0) {
            // This is the correct check: if the student UUID doesn't exist in the students table
            return res.status(404).json({ message: 'Student not found.' }); 
        }
        
        const studentDetails = studentDetailsResult.rows[0];

        // 6. Consolidate and Respond
        const balance = totalFees - totalPaid;

        res.status(200).json({
            // Use actual names from the joined tables
            student_name: studentDetails.student_name,
            course_name: studentDetails.course_name || 'N/A', // Handle case where joins might fail
            batch_name: studentDetails.batch_name || 'N/A', // Handle case where joins might fail
            total_fees: totalFees,
            total_paid: totalPaid,
            balance: balance,
            fee_structure: feeStructure,
            payments: historyResult.rows
        });

    } catch (error) {
        console.error('Consolidated Fee Status Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve consolidated fee status.' });
    }
});


module.exports = router;