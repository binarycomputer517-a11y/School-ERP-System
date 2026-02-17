// routes/payments.js
// Handles payment history, receipt generation, and payment gateway interactions.

// =========================================================
// SECTION 1: IMPORTS, CONSTANTS & CONFIGURATION
// =========================================================
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
const { v4: uuidv4 } = require('uuid');
const fs = require('fs/promises'); // For actual PDF generation/handling if needed

// --- DB Tables ---
const DB = {
    PAYMENTS: 'fee_payments',
    INVOICES: 'fee_invoices',
    STUDENTS: 'students',
    USERS: 'users',
    SETTINGS: 'erp_settings'
};

// Roles that can view payment history
const PAYMENT_VIEW_ROLES = ['Super Admin', 'Admin', 'Staff', 'Finance', 'Coordinator']; 
const PAYMENT_COLLECTION_ROLES = ['Super Admin', 'Admin', 'Staff', 'Finance'];


// --- Helper: Receipt Generation Stub ---
// This function simulates the generation of a PDF receipt and returns a buffer.
async function generateReceiptPdf(transactionId) {
    // NOTE: In a real app, this function uses a PDF library (like pdfkit or html-pdf)
    // to fetch data, generate the layout, and return the PDF buffer.
    
    // For testing the download function on the client, we return a minimal PDF buffer.
    const PDF_PLACEHOLDER = `
        %PDF-1.4
        1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
        2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
        3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
        4 0 obj << /Length 55 >> stream
        BT /F1 24 Tf 100 700 Td (Payment Receipt Placeholder for Transaction: ${transactionId}) Tj ET
        endstream endobj
        xref
        0 5
        0000000000 65535 f
        0000000009 00000 n
        0000000056 00000 n
        0000000107 00000 n
        0000000216 00000 n
        trailer << /Size 5 /Root 1 0 R >> startxref 287 %%EOF
    `.trim().replace(/\s+/g, ' ');

    return Buffer.from(PDF_PLACEHOLDER, 'ascii'); 
}


// =========================================================
// SECTION 2: PAYMENT HISTORY AND REPORTS
// =========================================================

/**
 * 2.1 GET ALL ONLINE PAYMENT TRANSACTIONS (Read)
 * @route   GET /api/payments/online-history
 * @access  Private (Management Roles)
 */
router.get('/online-history', authenticateToken, authorize(PAYMENT_VIEW_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                fp.id AS payment_id, 
                fp.payment_date, 
                fp.amount AS amount_paid,  
                fp.payment_mode, 
                fp.transaction_id,
                s.roll_number,
                u.username AS student_name
            FROM ${DB.PAYMENTS} fp
            JOIN ${DB.INVOICES} fi ON fp.invoice_id = fi.id
            JOIN ${DB.STUDENTS} s ON fi.student_id = s.student_id
            JOIN ${DB.USERS} u ON s.user_id = u.id
            WHERE fp.payment_mode IN ('UPI', 'Card', 'Online Payment') 
            ORDER BY fp.payment_date DESC;
        `;
        
        const { rows } = await pool.query(query);
        res.status(200).json(rows); 

    } catch (error) {
        console.error('Online Payment History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve online payment history.', error: error.message });
    }
});


// =========================================================
// SECTION 3: RECEIPT GENERATION
// =========================================================

/**
 * 3.1 GENERATE RECEIPT PDF (Read/Export)
 * @route   GET /api/payments/receipt/:transactionId
 * @desc    Generates and returns a PDF receipt for a specific transaction.
 * @access  Private (Staff, Student)
 */
router.get('/receipt/:transactionId', authenticateToken, authorize([...PAYMENT_VIEW_ROLES, 'Student']), async (req, res) => {
    const { transactionId } = req.params;

    try {
        // 1. Basic validation (ensure transaction exists and get receipt number/ID)
        const paymentRes = await pool.query(
            // We search by transaction_id (external ref) OR id (internal ref) OR receipt_number
            `SELECT id, transaction_id, receipt_number FROM ${DB.PAYMENTS} 
            WHERE transaction_id = $1 OR id = $1::uuid OR receipt_number = $1`, 
            [transactionId]
        );

        if (paymentRes.rowCount === 0) {
            return res.status(404).json({ message: 'Transaction record not found.' });
        }
        
        // 2. Generate PDF Buffer (Using the helper stub)
        const pdfBuffer = await generateReceiptPdf(transactionId); 

        // 3. Send the PDF file
        res.setHeader('Content-Type', 'application/pdf');
        // Use the transaction ID for the filename
        res.setHeader('Content-Disposition', `attachment; filename=Receipt_${transactionId}.pdf`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Receipt Generation Error:', error);
        res.status(500).json({ message: 'Failed to generate receipt PDF.', error: error.message });
    }
});


// =========================================================
// SECTION 4: PAYMENT GATEWAY (STUBS)
// =========================================================

/**
 * 4.1 INITIATE ONLINE PAYMENT (Create)
 * @route   POST /api/payments/initiate
 * @desc    Creates a payment order and returns gateway link/token.
 * @access  Private (Student, Staff)
 */
router.post('/initiate', authenticateToken, authorize(['Student', 'Staff']), async (req, res) => {
    const { invoice_id, amount, return_url } = req.body;
    
    // Stubbed response for integration testing
    res.status(200).json({
        success: true,
        order_id: uuidv4(),
        gateway_url: `https://mock-gateway.com/pay/${uuidv4()}`,
        message: 'Payment initiation successful. Redirecting to gateway.'
    });
});

/**
 * 4.2 GATEWAY WEBHOOK/CALLBACK (Update)
 * @route   POST /api/payments/callback
 * @desc    Receives status update from payment gateway (SUCCESS/FAIL).
 * @access  Public (Webhook) - Auth skipped for simplicity, but real one needs validation.
 */
router.post('/callback', async (req, res) => {
    // In a real system:
    // 1. Validate the signature/secret provided by the gateway.
    // 2. Look up the order_id in the database.
    // 3. Check status (SUCCESS/FAILED/PENDING).
    // 4. If SUCCESS:
    //    a. Update fee_payments record.
    //    b. Mark invoice as Paid.
    
    const { order_id, transaction_status, gateway_ref } = req.body;

    if (transaction_status === 'SUCCESS') {
        // Notify student/staff via Socket.io 
        return res.status(200).json({ message: 'Payment recorded successfully.' });
    }
    
    res.status(200).json({ message: 'Payment processed, status is ' + transaction_status });
});


module.exports = router;