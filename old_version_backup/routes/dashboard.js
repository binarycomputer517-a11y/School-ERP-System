// routes/dashboard.js
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

router.get('/stats', authenticateToken, authorize(['Admin', 'HR', 'Coordinator']), async (req, res) => {
    try {
        const stats = {};
        // Extract branch context from the authenticated user object
        const branchId = req.user.userBranchId; 
        
        // Base where clause to ensure data isolation
        const branchFilter = branchId ? 'WHERE branch_id = $1' : 'WHERE 1=1';
        const params = branchId ? [branchId] : [];

        // 1. Total Students (Branch Specific)
        const students = await pool.query(`SELECT COUNT(*) FROM students ${branchFilter}`, params);
        stats.total_students = parseInt(students.rows[0].count) || 0;

        // 2. Total Staff/Teachers
        const teachers = await pool.query(`SELECT COUNT(*) FROM teachers ${branchFilter}`, params);
        stats.total_teachers = parseInt(teachers.rows[0].count) || 0;

        // 3. Total Fees Due (Calculated with Branch awareness)
        const feeQuery = `
            SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS fees_due 
            FROM fee_invoices 
            WHERE status != 'Paid' ${branchId ? 'AND branch_id = $1' : ''}
        `;
        const fees = await pool.query(feeQuery, params);
        stats.fees_due = parseFloat(fees.rows[0].fees_due) || 0;
        
        // 4. Overdue Library Books
        const libraryQuery = `
            SELECT COUNT(*) FROM book_issues 
            WHERE status = 'Issued' AND due_date < CURRENT_DATE 
            ${branchId ? 'AND branch_id = $1' : ''}
        `;
        const overdueBooks = await pool.query(libraryQuery, params);
        stats.overdue_books = parseInt(overdueBooks.rows[0].count) || 0;

        res.status(200).json(stats);

    } catch (error) {
        console.error('Database Error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});
module.exports = router;