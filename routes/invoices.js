const express = require('express');
const router = express.Router();
const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 
const { v4: uuidv4 } = require('uuid');

// Database Table Constants
const INVOICES_TABLE = 'student_invoices'; 
const STUDENTS_TABLE = 'students';
const COURSES_TABLE = 'courses';
const ITEMS_TABLE = 'invoice_items';
const USERS_TABLE = 'users';
const PAYMENTS_TABLE = 'fee_payments';

// Roles configuration
const INVOICE_GENERATION_ROLES = ['admin', 'super admin']; 
const INVOICE_VIEW_ROLES = ['admin', 'finance', 'super admin']; 

// =========================================================
// 1. BULK INVOICE GENERATION (POST)
// =========================================================
router.post('/bulk-generate', authenticateToken, authorize(INVOICE_GENERATION_ROLES), async (req, res) => {
    const { course_id, batch_id, due_date } = req.body;
    const adminId = req.user.id; 
    
    if (!course_id || !due_date) {
        return res.status(400).json({ message: 'Course ID and Due Date are required.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        let studentQuery = `
            SELECT user_id 
            FROM ${STUDENTS_TABLE} 
            WHERE course_id = $1::uuid
        `;
        
        const queryParams = [course_id];
        
        if (batch_id) {
            studentQuery += ` AND batch_id = $2::uuid`;
            queryParams.push(batch_id);
        }

        const studentsRes = await client.query(studentQuery, queryParams);
        
        if (studentsRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: 'No students found for criteria.', total_invoices: 0 });
        }

        const generatedInvoices = [];
        const totalAmount = 5000.00; // Placeholder amount
        const currentDate = new Date().toISOString().slice(0, 10);

        for (const student of studentsRes.rows) {
            const invoiceQuery = `
                INSERT INTO ${INVOICES_TABLE} (student_id, bill_date, due_date, total_amount, amount_paid, status, generated_by_id)
                VALUES ($1::uuid, $2, $3, $4, 0.00, 'Pending', $5::uuid) 
                RETURNING id;
            `;
            
            const invoiceResult = await client.query(invoiceQuery, [
                student.user_id, 
                currentDate, 
                due_date, 
                totalAmount, 
                adminId 
            ]);
            
            const invoiceId = invoiceResult.rows[0].id;
            
            await client.query(`
                INSERT INTO ${ITEMS_TABLE} (invoice_id, description, amount)
                VALUES ($1::uuid, 'Tuition Fee', $2);
            `, [invoiceId, totalAmount]);

            generatedInvoices.push(invoiceId);
        }

        await client.query('COMMIT');

        res.status(201).json({
            message: `Batch generation successful. Created ${generatedInvoices.length} invoices.`,
            total_invoices: generatedInvoices.length
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Bulk Invoice Generation Error:', error);
        res.status(500).json({ message: 'Failed to generate invoices.', error: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. INVOICE LIST VIEW (GET)
// =========================================================
router.get('/pending', authenticateToken, authorize(INVOICE_VIEW_ROLES), async (req, res) => {
    const { course_id, q } = req.query; 

    try {
        let query = `
            SELECT 
                i.id AS invoice_id,
                i.total_amount,
                COALESCE(i.amount_paid, 0) AS amount_paid,
                (i.total_amount - COALESCE(i.amount_paid, 0)) AS amount_due,
                i.bill_date, 
                i.due_date,
                i.status,
                COALESCE(u.full_name, s.first_name || ' ' || s.last_name) AS student_name,
                u.phone_number,
                s.roll_number,
                c.course_name
            FROM ${INVOICES_TABLE} i
            LEFT JOIN ${USERS_TABLE} u ON i.student_id = u.id
            LEFT JOIN ${STUDENTS_TABLE} s ON u.id = s.user_id
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            WHERE i.status = 'Pending' OR i.status = 'Partial'
        `;
        
        const params = [];
        let paramIndex = 1;

        if (course_id) {
            query += ` AND s.course_id = $${paramIndex++}::uuid`;
            params.push(course_id);
        }
        
        if (q) {
             query += ` AND (
                LOWER(COALESCE(u.full_name, '')) LIKE $${paramIndex} OR 
                LOWER(COALESCE(s.first_name, '')) LIKE $${paramIndex} OR 
                LOWER(COALESCE(s.roll_number, '')) LIKE $${paramIndex}
             )`;
             params.push(`%${q.toLowerCase()}%`);
        }
        
        query += ` ORDER BY i.due_date ASC`;
        
        const { rows } = await pool.query(query, params);
        res.status(200).json(rows);

    } catch (error) {
        console.error('Pending Invoice Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve pending invoice list.' });
    }
});

// =========================================================
// 3. INVOICE LINE ITEMS (GET)
// =========================================================
router.get('/invoice/:invoiceId/items', authenticateToken, authorize(INVOICE_VIEW_ROLES), async (req, res) => {
    const { invoiceId } = req.params;
    
    try {
        const query = `
            SELECT *
            FROM ${ITEMS_TABLE}
            WHERE invoice_id = $1::uuid
        `;
        const result = await pool.query(query, [invoiceId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Invoice Items Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve invoice items.' });
    }
});

// =========================================================
// 4. PROCESS PAYMENT (POST)
// =========================================================
router.post('/pay', authenticateToken, authorize(INVOICE_VIEW_ROLES), async (req, res) => {
    const { invoice_id, payment_amount, payment_method } = req.body;
    const collectedBy = req.user.id; 
    
    if (!invoice_id || !payment_amount) {
        return res.status(400).json({ message: 'Invoice ID and Amount are required.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const invQuery = `SELECT total_amount, amount_paid FROM ${INVOICES_TABLE} WHERE id = $1`;
        const invResult = await client.query(invQuery, [invoice_id]);
        
        if (invResult.rows.length === 0) {
            throw new Error('Invoice not found');
        }
        
        const invoice = invResult.rows[0];
        const currentPaid = parseFloat(invoice.amount_paid || 0);
        const total = parseFloat(invoice.total_amount);
        const amountToPay = parseFloat(payment_amount);
        const newAmountPaid = currentPaid + amountToPay;
        
        let newStatus = 'Pending';
        if (newAmountPaid >= total) {
            newStatus = 'Paid';
        } else if (newAmountPaid > 0) {
            newStatus = 'Partial';
        }

        await client.query(`
            UPDATE ${INVOICES_TABLE} 
            SET amount_paid = $1, status = $2
            WHERE id = $3
        `, [newAmountPaid, newStatus, invoice_id]);

        // Generate Transaction ID
        const transactionId = 'TXN-' + Date.now(); 
        
        const paymentQuery = `
            INSERT INTO ${PAYMENTS_TABLE} (invoice_id, transaction_id, amount, payment_date, payment_mode, collected_by, remarks)
            VALUES ($1::uuid, $2, $3, CURRENT_DATE, $4, $5::uuid, 'Manual Payment via Admin Panel')
            RETURNING id;
        `;
        
        await client.query(paymentQuery, [
            invoice_id, 
            transactionId,
            amountToPay, 
            payment_method || 'Cash', 
            collectedBy
        ]);

        await client.query('COMMIT');

        res.status(200).json({ 
            message: 'Payment recorded successfully', 
            new_status: newStatus,
            transaction_id: transactionId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Payment Error:', error);
        res.status(500).json({ message: 'Failed to record payment', error: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 5. GET SINGLE INVOICE DETAILS (GET)
// =========================================================
router.get('/:id/details', authenticateToken, authorize(INVOICE_VIEW_ROLES), async (req, res) => {
    const { id } = req.params;

    try {
        const invoiceQuery = `
            SELECT 
                i.id, 
                i.bill_date, 
                i.due_date, 
                i.status,
                i.total_amount, 
                i.amount_paid,
                COALESCE(u.full_name, s.first_name || ' ' || s.last_name) as student_name,
                u.email, 
                u.phone_number,
                s.roll_number,
                c.course_name
            FROM ${INVOICES_TABLE} i
            LEFT JOIN ${USERS_TABLE} u ON i.student_id = u.id
            LEFT JOIN ${STUDENTS_TABLE} s ON u.id = s.user_id
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            WHERE i.id = $1::uuid
        `;
        
        const invoiceRes = await pool.query(invoiceQuery, [id]);
        
        if (invoiceRes.rows.length === 0) {
            return res.status(404).json({ message: 'Invoice not found' });
        }

        const itemsQuery = `SELECT description, amount FROM ${ITEMS_TABLE} WHERE invoice_id = $1::uuid`;
        const itemsRes = await pool.query(itemsQuery, [id]);

        res.json({
            invoice: invoiceRes.rows[0],
            items: itemsRes.rows
        });

    } catch (error) {
        console.error('Error fetching invoice details:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// =========================================================
// 6. GET PAYMENT RECEIPT DETAILS (GET) <-- THIS WAS MISSING
// =========================================================
router.get('/payment/:transactionId', authenticateToken, authorize(INVOICE_VIEW_ROLES), async (req, res) => {
    const { transactionId } = req.params;

    try {
        const query = `
            SELECT 
                p.transaction_id, p.amount, p.payment_date, p.payment_mode,
                i.id as invoice_id, i.total_amount as invoice_total,
                COALESCE(u.full_name, s.first_name || ' ' || s.last_name) as student_name,
                s.roll_number,
                c.course_name,
                u.email
            FROM fee_payments p
            JOIN student_invoices i ON p.invoice_id = i.id
            JOIN users u ON i.student_id = u.id
            LEFT JOIN students s ON u.id = s.user_id
            LEFT JOIN courses c ON s.course_id = c.id
            WHERE p.transaction_id = $1
        `;

        const result = await pool.query(query, [transactionId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Receipt not found' });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error fetching receipt:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;