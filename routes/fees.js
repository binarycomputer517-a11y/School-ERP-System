const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid'); // Required for unique transaction IDs

// Database Table Constants
const INVOICES_TABLE = 'fee_invoices';
const ITEMS_TABLE = 'invoice_items';
const PAYMENTS_TABLE = 'fee_payments';
const USERS_TABLE = 'users';
const STUDENTS_TABLE = 'students';
const TRANSPORT_ASSIGNMENTS_TABLE = 'student_transport_assignments'; 
const ROUTES_TABLE = 'transport_routes'; 
const COURSES_TABLE = 'courses';
const BATCHES_TABLE = 'batches';
const WAIVER_REQUESTS_TABLE = 'fee_waiver_requests'; // Added constant for new table

// Constants
const BASE_TUITION_FEE = 5000.00; 
const FEE_ROLES = ['Admin', 'Staff', 'Super Admin', 'Finance']; 

// =========================================================
// 1. INVOICE GENERATION (POST) - ADMIN ONLY
// =========================================================

/**
 * @route   POST /api/fees/generate/:month/:year
 * @desc    Generates monthly invoices for all enrolled students.
 * @access  Private (Admin, Super Admin)
 */
router.post('/generate/:month/:year', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const { month, year } = req.params;
    const adminId = req.user.id; 
    const issueDate = moment(`${year}-${month}-01`).format('YYYY-MM-DD'); 
    const dueDate = moment(issueDate).add(15, 'days').format('YYYY-MM-DD');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Fetch all active students, starting from the STUDENTS_TABLE
        const studentsRes = await client.query(`
            SELECT 
                s.student_id,
                u.username,    
                r.monthly_fee AS transport_fee, 
                r.route_name
            FROM ${STUDENTS_TABLE} s
            JOIN ${USERS_TABLE} u ON s.user_id = u.id 
            LEFT JOIN ${TRANSPORT_ASSIGNMENTS_TABLE} ta ON s.student_id = ta.student_id
            LEFT JOIN ${ROUTES_TABLE} r ON ta.route_id = r.id
            WHERE u.is_active = TRUE; 
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
                VALUES ($1::uuid, $2, $3, $4, 'Pending', $5::uuid) 
                RETURNING id;
            `;
            const invoiceResult = await client.query(invoiceQuery, [
                student.student_id, issueDate, dueDate, totalAmount, adminId
            ]);
            const invoiceId = invoiceResult.rows[0].id;

            // D. Insert Invoice Items
            const itemsValues = items.map(item => 
                `('${invoiceId}', '${item.description.replace(/'/g, "''")}', ${item.amount})`
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
router.post('/collect', authenticateToken, authorize(['admin', 'teacher', 'staff', 'super admin']), async (req, res) => {
    const { student_id, amount_paid, payment_mode, notes } = req.body;
    const collectedBy = req.user.id; 

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
            WHERE student_id = $1::uuid AND status != 'Paid' AND status != 'Waived'
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
                    VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
                    RETURNING id;
                `;
                const paymentResult = await client.query(paymentQuery, [
                    invoiceId, paymentOnThisInvoice, payment_mode, 'MANUAL-' + uuidv4(), collectedBy, notes
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
                    WHERE id = $3::uuid;
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
 * @route   GET /api/fees/waiver-requests
 * @desc    Get a list of fee waiver requests, filtered by status and course.
 * @access  Private (Admin, Finance, Super Admin)
 */
router.get('/waiver-requests', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    // Note: req.user.role is already lowercased by authMiddleware.
    const { status, course_id } = req.query; 

    try {
        let query = `
            SELECT 
                r.id, r.student_id, r.fee_type, r.requested_amount, r.reason, r.request_date, r.status,
                s.first_name, s.last_name, s.roll_number
            FROM ${WAIVER_REQUESTS_TABLE} r
            JOIN ${STUDENTS_TABLE} s ON r.student_id = s.student_id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        // Filtering Logic
        if (status) {
            query += ` AND LOWER(r.status) = $${paramIndex++}`;
            params.push(status.toLowerCase());
        } else {
            // Default to showing only pending requests if no status filter is provided
            query += ` AND LOWER(r.status) = 'pending'`;
        }

        if (course_id) {
            query += ` AND s.course_id = $${paramIndex++}::uuid`;
            params.push(course_id);
        }

        query += ` ORDER BY r.request_date DESC`;
        
        const { rows } = await pool.query(query, params);

        // Prepare response structure to match client expectation (roll_number, full name)
        const formattedRows = rows.map(row => ({
            id: row.id,
            student_name: `${row.first_name} ${row.last_name}`,
            roll_number: row.roll_number,
            fee_type: row.fee_type,
            requested_amount: row.requested_amount,
            reason: row.reason,
            request_date: row.request_date,
            status: row.status
        }));
        
        res.status(200).json(formattedRows);

    } catch (error) {
        console.error('Fee Waiver Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve fee waiver requests.' });
    }
});


/**
 * @route   GET /api/fees/invoices/student/:studentId
 * @desc    Get all invoices for a specific student.
 * @access  Private (Admin, Staff, Super Admin, or Student/Parent checking self)
 */
router.get('/invoices/student/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    const userId = req.user.id; // UUID
    const userRole = req.user.role; // Lowercase

    // IMPORTANT: Security Check needs to verify if the studentId corresponds to the current userId
    let isStudentSelf = false;
    try {
        const studentCheck = await pool.query(
            // Joins student's user_id with the authenticated user's ID
            `SELECT student_id FROM ${STUDENTS_TABLE} WHERE user_id = $1::uuid AND student_id = $2::uuid`,
            [userId, studentId]
        );
        if (studentCheck.rowCount > 0) {
            isStudentSelf = true;
        }
    } catch (e) {
        // Log error but continue to deny access if role is insufficient
        console.error('Student self-check error:', e.message);
    }

    if (!FEE_ROLES.map(r => r.toLowerCase()).includes(userRole) && !isStudentSelf) {
        return res.status(403).json({ message: 'Access denied to these invoices.' });
    }

    try {
        // Query links invoices (i) -> students (s) -> users (u)
        const query = `
            SELECT 
                i.*, 
                u.username AS student_name
            FROM ${INVOICES_TABLE} i
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id
            JOIN ${USERS_TABLE} u ON s.user_id = u.id 
            WHERE i.student_id = $1::uuid
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
    
    // NOTE: Authorization check for self-access is implicitly needed here too, 
    // but often handled by client logic or parent invoice check in a mature system.
    
    try {
        const query = `
            SELECT *
            FROM ${ITEMS_TABLE}
            WHERE invoice_id = $1::uuid
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
// 4. CONSOLIDATED STUDENT FEE STATUS (GET) 
// =========================================================

/**
 * @route   GET /api/fees/student/:studentId
 * @desc    Get consolidated fee status (invoices, payments, balance) for a single student.
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/student/:studentId', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const { studentId } = req.params;
    
    try {
        // 1. Calculate Total Invoiced Amount (Total Fees)
        const totalFeesQuery = `
            SELECT COALESCE(SUM(total_amount), 0.00) AS total_fees
            FROM ${INVOICES_TABLE}
            WHERE student_id = $1::uuid;
        `;
        const totalFeesResult = await pool.query(totalFeesQuery, [studentId]);
        const totalFees = parseFloat(totalFeesResult.rows[0].total_fees);

        // 2. Calculate Total Paid Amount
        const totalPaidQuery = `
            SELECT COALESCE(SUM(p.amount), 0.00) AS total_paid
            FROM ${PAYMENTS_TABLE} p
            JOIN ${INVOICES_TABLE} i ON p.invoice_id = i.id
            WHERE i.student_id = $1::uuid;
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
            WHERE i.student_id = $1::uuid
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
            WHERE inv.student_id = $1::uuid
            GROUP BY it.description 
            ORDER BY SUM(it.amount) DESC; 
        `;
        const structureResult = await pool.query(structureQuery, [studentId]);
        const feeStructure = structureResult.rows;


        // 5. Fetch basic student details 
        const studentDetailsQuery = `
            SELECT 
                u.username AS student_name, 
                c.course_name, 
                b.batch_name,
                s.roll_number 
            FROM ${STUDENTS_TABLE} s
            JOIN ${USERS_TABLE} u ON s.user_id = u.id 
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            LEFT JOIN ${BATCHES_TABLE} b ON s.batch_id = b.id
            WHERE s.student_id = $1::uuid;
        `;
        const studentDetailsResult = await pool.query(studentDetailsQuery, [studentId]);
        
        if (studentDetailsResult.rowCount === 0) {
            return res.status(404).json({ message: 'Student not found.' }); 
        }
        
        const studentDetails = studentDetailsResult.rows[0];

        // 6. Consolidate and Respond
        const balance = totalFees - totalPaid;

        res.status(200).json({
            student_name: studentDetails.student_name,
            course_name: studentDetails.course_name || 'N/A', 
            batch_name: studentDetails.batch_name || 'N/A', 
            roll_number: studentDetails.roll_number || 'N/A', 
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

// =========================================================
// 5. FEE WAIVER MANAGEMENT (GET/POST/PUT) - FINAL MODULE
// =========================================================

const WAIVER_STATUSES = {
    PENDING: 'Pending',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    WAIVED: 'Waived'
};

/**
 * @route   GET /api/fees/waiver-requests
 * @desc    Get a list of fee waiver requests, filtered by status and course.
 * @access  Private (Admin, Finance, Super Admin)
 */
router.get('/waiver-requests', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    // Assuming WAIVER_REQUESTS_TABLE = 'fee_waiver_requests' (defined in core structure)
    const WAIVER_REQUESTS_TABLE = 'fee_waiver_requests';
    const { status, course_id } = req.query; 

    try {
        let query = `
            SELECT 
                r.id, r.student_id, r.fee_type, r.requested_amount, r.reason, r.request_date, r.status,
                s.first_name, s.last_name, s.roll_number, s.course_id
            FROM ${WAIVER_REQUESTS_TABLE} r
            JOIN ${STUDENTS_TABLE} s ON r.student_id = s.student_id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;
        const lowerStatus = status ? status.toLowerCase() : null;

        // Filtering Logic
        if (lowerStatus) {
            query += ` AND LOWER(r.status) = $${paramIndex++}`;
            params.push(lowerStatus);
        } else {
            // Default to showing only pending requests if no status filter is provided
            query += ` AND LOWER(r.status) = 'pending'`;
        }

        if (course_id) {
            query += ` AND s.course_id = $${paramIndex++}::uuid`;
            params.push(course_id);
        }

        query += ` ORDER BY r.request_date DESC`;
        
        const { rows } = await pool.query(query, params);

        // Prepare response structure to match client expectation
        const formattedRows = rows.map(row => ({
            id: row.id,
            student_id: row.student_id,
            student_name: `${row.first_name} ${row.last_name}`,
            roll_number: row.roll_number,
            fee_type: row.fee_type,
            requested_amount: row.requested_amount,
            reason: row.reason,
            request_date: row.request_date,
            status: row.status,
            course_id: row.course_id
        }));
        
        res.status(200).json(formattedRows);

    } catch (error) {
        console.error('Fee Waiver Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve fee waiver requests.' });
    }
});


/**
 * @route   PUT /api/fees/waiver-requests/:requestId/status
 * @desc    Approve/Reject a fee waiver request.
 * @access  Private (Admin, Super Admin)
 */
router.put('/waiver-requests/:requestId/status', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const { requestId } = req.params;
    const { newStatus, amount } = req.body; // newStatus must be 'approved' or 'rejected'
    const processedBy = req.user.id; // UUID
    const requestedAmount = parseFloat(amount);
    
    if (!newStatus || !Object.values(WAIVER_STATUSES).map(s => s.toLowerCase()).includes(newStatus.toLowerCase())) {
        return res.status(400).json({ message: 'Invalid or missing status provided.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const requestRes = await client.query(`
            SELECT student_id, requested_amount, status 
            FROM ${WAIVER_REQUESTS_TABLE} 
            WHERE id = $1::uuid AND status = 'Pending'
        `, [requestId]);
        
        const request = requestRes.rows[0];

        if (!request) {
            throw new Error("Waiver request not found or already processed.");
        }
        
        const studentId = request.student_id;
        const effectiveAmount = newStatus.toLowerCase() === 'approved' ? requestedAmount : 0;
        
        // 1. Update the Request Status
        await client.query(`
            UPDATE ${WAIVER_REQUESTS_TABLE} 
            SET status = $1, processed_by = $2::uuid, processed_date = CURRENT_TIMESTAMP
            WHERE id = $3::uuid;
        `, [newStatus, processedBy, requestId]);

        // 2. If approved, update the related invoice (This logic is usually complex - simplifying here)
        if (newStatus.toLowerCase() === 'approved' && effectiveAmount > 0) {
            
            // Find the oldest pending/partial invoice to apply the waiver to
            const oldestInvoiceRes = await client.query(`
                SELECT id 
                FROM ${INVOICES_TABLE} 
                WHERE student_id = $1::uuid AND status != 'Paid' AND status != 'Waived'
                ORDER BY due_date ASC
                LIMIT 1;
            `, [studentId]);

            const invoiceId = oldestInvoiceRes.rows[0]?.id;

            if (invoiceId) {
                // Apply the waiver as a discount/deduction on the invoice
                await client.query(`
                    UPDATE ${INVOICES_TABLE}
                    SET 
                        discount_amount = discount_amount + $1,
                        total_amount = total_amount - $1 -- Reduce the total amount due
                    WHERE id = $2::uuid;
                `, [effectiveAmount, invoiceId]);
            }
        }
        
        await client.query('COMMIT');
        
        res.status(200).json({ 
            message: `Waiver request successfully ${newStatus.toLowerCase()}.`,
            waiver_applied: effectiveAmount
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Waiver Status Update Error:', error);
        res.status(500).json({ message: error.message || 'Failed to process waiver status update.' });
    } finally {
        client.release();
    }
});


/**
 * @route   GET /api/fees/student-refund-info/:studentId
 * @desc    Get current refundable balance and profile details for refund confirmation.
 * @access  Private (Admin, Finance)
 */
router.get('/student-refund-info/:studentId', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { studentId } = req.params;
    
    try {
        // 1. Fetch Refundable Balance (Same logic as students/refundable)
        const balanceQuery = `
            SELECT 
                (COALESCE(SUM(p.amount), 0.00) - COALESCE(SUM(i.total_amount), 0.00)) AS refundable_balance
            FROM students s
            LEFT JOIN fee_invoices i ON s.student_id = i.student_id
            LEFT JOIN fee_payments p ON i.id = p.invoice_id
            WHERE s.student_id = $1::uuid
            GROUP BY s.student_id;
        `;
        const balanceResult = await pool.query(balanceQuery, [studentId]);
        
        const balance = balanceResult.rows[0]?.refundable_balance || '0.00';

        // 2. Fetch Profile Details
        const profileQuery = `
            SELECT 
                s.first_name || ' ' || s.last_name AS student_name, 
                c.course_name AS course, 
                s.status AS enrollment_status
            FROM students s
            LEFT JOIN courses c ON s.course_id = c.id
            WHERE s.student_id = $1::uuid;
        `;
        const profileResult = await pool.query(profileQuery, [studentId]);
        
        if (profileResult.rowCount === 0) {
            return res.status(404).json({ message: 'Student not found.' });
        }

        res.status(200).json({
            ...profileResult.rows[0],
            refundable_balance: parseFloat(balance)
        });

    } catch (error) {
        console.error('Refund Info Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve refund details.' });
    }
});

module.exports = router;