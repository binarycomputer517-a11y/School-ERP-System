const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// Roles that can view payment history (Admin/Staff/Coordinator)
const PAYMENT_VIEW_ROLES = ['super admin', 'admin', 'staff', 'coordinator']; 

/**
 * @route   GET /api/payments/online-history
 * @desc    Get a list of all online payment transactions.
 * @access  Private (Management Roles)
 */
router.get('/online-history', authenticateToken, authorize(PAYMENT_VIEW_ROLES), async (req, res) => {
    
    // In a real system, you might filter by req.query (e.g., student_id, date range)
    
    try {
        // FIX: The SELECT list uses 'fp.amount' (actual DB column) and aliases it to 'amount_paid' (expected by client)
        // NOTE: The JOINs rely on the successful creation of fee_invoices and fee_payments tables.
        const query = `
            SELECT 
                fp.id, 
                fp.payment_date, 
                fp.amount AS amount_paid,  
                fp.payment_mode, 
                fp.transaction_id,
                s.enrollment_no,
                s.first_name,
                s.last_name
            FROM fee_payments fp
            JOIN fee_invoices fi ON fp.invoice_id = fi.id
            JOIN students s ON fi.student_id = s.student_id
            WHERE fp.payment_mode IN ('UPI', 'Card', 'Online Payment') -- Filter for online transactions
            ORDER BY fp.payment_date DESC;
        `;
        
        const { rows } = await pool.query(query);
        
        // This endpoint expects a JSON array of payments
        res.status(200).json(rows); 

    } catch (error) {
        console.error('Online Payment History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve online payment history.', error: error.message });
    }
});

module.exports = router;