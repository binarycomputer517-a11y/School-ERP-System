const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');

// আপনার সিস্টেমে যদি authorize মিডলওয়্যার থাকে তবে এটি আনকমেন্ট করুন
// const { authorize } = require('../authMiddleware'); 

/**
 * @route   GET /api/parents/me/children
 * @desc    Fetches all students linked to the logged-in parent user.
 * @access  Private (Parent)
 */
router.get('/me/children', authenticateToken, async (req, res) => {
    const parentUserId = req.user.id; 
    
    try {
        // আপনার ডাটাবেস স্কিমা অনুযায়ী 'parent_user_id' সরাসরি students টেবিলে আছে
        const query = `
            SELECT 
                s.student_id,
                u.id AS student_user_id,
                COALESCE(u.full_name, s.first_name || ' ' || s.last_name) AS student_name,
                s.roll_number,
                s.admission_id,
                c.course_name,
                b.batch_name,
                s.profile_image_path
            FROM students s
            LEFT JOIN users u ON s.user_id = u.id
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            WHERE s.parent_user_id = $1 AND (u.deleted_at IS NULL OR u.id IS NULL)
            ORDER BY s.first_name;
        `;
        
        const result = await pool.query(query, [parentUserId]);
        
        // যদি কোনো বাচ্চা খুঁজে না পায়
        if (result.rows.length === 0) {
            return res.status(200).json([]);
        }

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('❌ Parent Data Sync Error:', error.message);
        res.status(500).json({ message: 'Neural link failed: Unable to retrieve child data.' });
    }
});

module.exports = router;