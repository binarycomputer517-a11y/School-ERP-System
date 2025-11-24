const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// Roles allowed to view financial reports
const REPORT_VIEW_ROLES = ['admin', 'finance', 'super admin'];

// =========================================================
// 1. GET STUDENT DUES REPORT
// Route: /api/reports/student-dues
// FIXED: Changed i.amount_paid to i.paid_amount
// =========================================================
router.get('/student-dues', authenticateToken, authorize(REPORT_VIEW_ROLES), async (req, res) => {
    const { course_id, q } = req.query; 

    try {
        let query = `
            SELECT 
                s.roll_number,
                COALESCE(u.full_name, s.first_name || ' ' || s.last_name) as student_name,
                c.course_name,
                SUM(i.total_amount) as total_fees,
                SUM(COALESCE(i.paid_amount, 0)) as total_paid,
                (SUM(i.total_amount) - SUM(COALESCE(i.paid_amount, 0))) as balance_due,
                (
                    SELECT MAX(payment_date) 
                    FROM fee_payments fp 
                    JOIN student_invoices si ON fp.invoice_id = si.id 
                    WHERE si.student_id = u.id
                ) as last_payment_date
            FROM student_invoices i
            JOIN users u ON i.student_id = u.id
            JOIN students s ON u.id = s.user_id
            LEFT JOIN courses c ON s.course_id = c.id
            WHERE i.status != 'Waived'
        `;
        
        const params = [];
        let paramIndex = 1;

        if (course_id) {
            query += ` AND s.course_id = $${paramIndex++}::uuid`;
            params.push(course_id);
        }

        if (q) {
            query += ` AND (
                LOWER(u.full_name) LIKE $${paramIndex} OR 
                LOWER(s.roll_number) LIKE $${paramIndex}
            )`;
            params.push(`%${q.toLowerCase()}%`);
        }

        query += ` 
            GROUP BY s.roll_number, u.full_name, s.first_name, s.last_name, c.course_name, u.id
            HAVING (SUM(i.total_amount) - SUM(COALESCE(i.paid_amount, 0))) > 0
            ORDER BY balance_due DESC
        `;

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error('Error generating dues report:', error);
        res.status(500).json({ message: 'Server error generating report' });
    }
});

// =========================================================
// 2. GET TRANSACTION DAYBOOK
// Route: /api/reports/daybook
// =========================================================
router.get('/daybook', authenticateToken, authorize(REPORT_VIEW_ROLES), async (req, res) => {
    const { date, account } = req.query;

    if (!date) {
        return res.status(400).json({ message: 'Date is required' });
    }

    try {
        // Fetch Fee Collections (Income)
        let incomeQuery = `
            SELECT 
                fp.transaction_id as id,
                fp.payment_date,
                fp.amount,
                fp.payment_mode,
                'Income' as type,
                'Fee Collection' as category,
                COALESCE(u.full_name, s.first_name || ' ' || s.last_name) as payer_payee,
                fp.remarks
            FROM fee_payments fp
            LEFT JOIN student_invoices si ON fp.invoice_id = si.id
            LEFT JOIN users u ON si.student_id = u.id
            LEFT JOIN students s ON u.id = s.user_id
            WHERE fp.payment_date::date = $1::date
        `;
        
        const params = [date];
        
        if (account && account !== 'All') {
            incomeQuery += ` AND fp.payment_mode = $2`;
            params.push(account);
        }

        incomeQuery += ` ORDER BY fp.transaction_id DESC`;

        const result = await pool.query(incomeQuery, params);

        res.json(result.rows);

    } catch (error) {
        console.error('Error fetching daybook:', error);
        res.status(500).json({ message: 'Server error fetching daybook' });
    }
});

module.exports = router;