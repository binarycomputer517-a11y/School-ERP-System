// routes/dashboard.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); // Assuming database pool is available
const { authenticateToken, authorize } = require('../authMiddleware'); // For security

/**
 * @route GET /api/dashboard/stats
 * @desc Get core statistics for the admin dashboard
 * @access Private (Admin/HR)
 */
router.get('/stats', authenticateToken, authorize(['Admin', 'HR', 'Coordinator']), async (req, res) => {
    try {
        const stats = {};

        // 1. Total Students
        const students = await pool.query('SELECT COUNT(*) FROM students');
        stats.total_students = parseInt(students.rows[0].count) || 0;

        // 2. Total Staff/Teachers (FIXED: Querying 'teachers' table for a safer count)
        const teachers = await pool.query("SELECT COUNT(*) FROM teachers");
        stats.total_teachers = parseInt(teachers.rows[0].count) || 0;

        // 3. Total Fees Due (CRITICAL FIX: Replacing non-existent column 'amount_due' with calculation)
        const fees = await pool.query(`
            SELECT 
                -- Calculate outstanding balance: total_amount - (amount_paid or 0)
                COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS fees_due 
            FROM fee_invoices 
            WHERE status != 'Paid'
        `);
        stats.fees_due = parseFloat(fees.rows[0].fees_due) || 0;
        
        // 4. Overdue Library Books
        const overdueBooks = await pool.query(`
            SELECT COUNT(*) FROM book_issues 
            WHERE status = 'Issued' AND due_date < CURRENT_DATE
        `);
        stats.overdue_books = parseInt(overdueBooks.rows[0].count) || 0;

        res.status(200).json(stats);

    } catch (error) {
        console.error('Database Error fetching dashboard stats:', error);
        res.status(500).json({ message: 'Failed to fetch dashboard statistics due to a server error.' });
    }
});

module.exports = router;