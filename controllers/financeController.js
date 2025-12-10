// controllers/financeController.js
const { pool } = require('../database');
const FEE_STRUCTURES_TABLE = 'fee_structures'; 
const INVOICES_TABLE = 'student_invoices'; 
const PAYMENTS_TABLE = 'fee_payments';
const STUDENTS_TABLE = 'students';

/**
 * Helper function to safely extract UUID from request or environment
 */
function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') return null;
    return value.trim();
}

// ==========================================================
// 1. Generate Invoice for a Single Student (POST /api/fees/generate)
// ==========================================================
exports.generateInvoice = async (req, res) => {
    const { student_id, fee_structure_id, invoice_date, due_date, description, created_by } = req.body;
    
    if (!student_id || !fee_structure_id || !due_date) {
        return res.status(400).json({ message: 'Missing required fields: Student ID, Structure ID, or Due Date.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start Transaction

        // --- A. Fetch Student & Structure Details ---
        const studentRes = await client.query(
            `SELECT course_id, batch_id FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid`, 
            [toUUID(student_id)]
        );
        if (studentRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const { course_id, batch_id } = studentRes.rows[0];

        const structureRes = await client.query(`SELECT * FROM ${FEE_STRUCTURES_TABLE} WHERE id = $1::uuid`, [toUUID(fee_structure_id)]);
        if (structureRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Fee Structure not found.' });
        }
        const structure = structureRes.rows[0];
        
        // --- B. Calculate Total Amount ---
        // CRITICAL: Sum up all fee components (One-time and Monthly)
        const total_amount = (
            structure.admission_fee + structure.registration_fee + structure.examination_fee +
            (structure.transport_fee * structure.course_duration_months) +
            (structure.hostel_fee * structure.course_duration_months) + 
            structure.miscellaneous_fee 
            // Add other component calculations here
        );

        // --- C. Insert Invoice Record ---
        const invoiceQuery = `
            INSERT INTO ${INVOICES_TABLE} (
                student_id, fee_structure_id, total_amount, balance_amount, paid_amount, 
                invoice_date, due_date, description, status, created_by
            )
            VALUES ($1::uuid, $2::uuid, $3, $3, 0, $4::date, $5::date, $6, 'Pending', $7::uuid)
            RETURNING id, invoice_number, total_amount, due_date;
        `;
        const invoiceRes = await client.query(invoiceQuery, [
            toUUID(student_id), toUUID(fee_structure_id), total_amount, 
            invoice_date || new Date().toISOString().split('T')[0], due_date, description || 'Standard Course Fee', 
            toUUID(created_by)
        ]);
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Invoice generated successfully.', invoice: invoiceRes.rows[0] });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Invoice Generation Error:', error);
        res.status(500).json({ message: 'Failed to generate invoice.', error: error.message });
    } finally {
        client.release();
    }
};

// ==========================================================
// 2. Record Payment (POST /api/fees/payment)
// ==========================================================
exports.recordPayment = async (req, res) => {
    const { invoice_id, amount, payment_mode, transaction_id, payment_date, collected_by } = req.body;
    
    if (!invoice_id || !amount || !payment_mode) {
        return res.status(400).json({ message: 'Missing required payment details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // --- A. Get Invoice Balance ---
        const invoiceRes = await client.query(
            `SELECT total_amount, paid_amount, balance_amount, status FROM ${INVOICES_TABLE} WHERE id = $1::uuid FOR UPDATE`, 
            [toUUID(invoice_id)]
        );
        if (invoiceRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Invoice not found.' });
        }
        const invoice = invoiceRes.rows[0];
        
        // Check if payment amount exceeds balance
        if (amount > invoice.balance_amount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Payment amount exceeds remaining balance of ${invoice.balance_amount}.` });
        }

        // --- B. Record Payment in Payments Table ---
        const paymentQuery = `
            INSERT INTO ${PAYMENTS_TABLE} (
                invoice_id, amount, payment_mode, transaction_id, payment_date, collected_by
            )
            VALUES ($1::uuid, $2, $3, $4, $5::date, $6::uuid)
            RETURNING id;
        `;
        const paymentRes = await client.query(paymentQuery, [
            toUUID(invoice_id), amount, payment_mode, transaction_id || null, payment_date || new Date().toISOString().split('T')[0], toUUID(collected_by)
        ]);

        // --- C. Update Invoice Totals ---
        const newPaidAmount = parseFloat(invoice.paid_amount) + parseFloat(amount);
        const newBalance = parseFloat(invoice.total_amount) - newPaidAmount;
        const newStatus = newBalance <= 0 ? 'Paid' : 'Partial';

        await client.query(
            `UPDATE ${INVOICES_TABLE} SET paid_amount = $1, balance_amount = $2, status = $3, updated_at = NOW() WHERE id = $4::uuid`,
            [newPaidAmount, newBalance, newStatus, toUUID(invoice_id)]
        );
        
        await client.query('COMMIT');
        res.status(200).json({ 
            message: `Payment of ${amount} recorded successfully.`, 
            payment_id: paymentRes.rows[0].id,
            invoice_status: newStatus 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Record Payment Error:', error);
        res.status(500).json({ message: 'Failed to record payment.', error: error.message });
    } finally {
        client.release();
    }
};

// ==========================================================
// 3. Get All Invoices (GET /api/fees/invoices)
// ==========================================================
exports.getAllInvoices = async (req, res) => {
    try {
        const query = `
            SELECT 
                i.id AS invoice_id, i.invoice_number, i.total_amount, i.paid_amount, i.balance_amount, i.status, i.due_date,
                s.enrollment_no, s.first_name, s.last_name,
                c.course_name, b.batch_name
            FROM ${INVOICES_TABLE} i
            JOIN ${STUDENTS_TABLE} s ON i.student_id = s.student_id
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            ORDER BY i.due_date DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({ message: 'Failed to retrieve invoice list.' });
    }
};

// ==========================================================
// 4. Get Invoice Payments History (GET /api/fees/invoices/:id/payments)
// ==========================================================
exports.getInvoicePayments = async (req, res) => {
    const invoiceId = req.params.id;
    if (!invoiceId) return res.status(400).json({ message: 'Invoice ID is required.' });

    try {
        const query = `
            SELECT 
                p.id AS payment_id, p.amount, p.payment_mode, p.payment_date, p.transaction_id,
                u.username AS collected_by_user
            FROM ${PAYMENTS_TABLE} p
            LEFT JOIN users u ON p.collected_by = u.id
            WHERE p.invoice_id = $1::uuid
            ORDER BY p.payment_date DESC;
        `;
        const result = await pool.query(query, [toUUID(invoiceId)]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching invoice payments:', error);
        res.status(500).json({ message: 'Failed to retrieve payment history.' });
    }
};