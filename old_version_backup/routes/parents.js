// routes/parents.js (Example route structure)

/**
 * @route   GET /api/parents/me/children
 * @desc    Fetches all students linked to the logged-in parent user.
 * @access  Private (Parent)
 */
router.get('/me/children', authenticateToken, authorize(['Parent']), async (req, res) => {
    const parentUserId = req.user.id; 
    
    try {
        const query = `
            SELECT 
                u.id AS student_user_id,
                u.full_name AS student_name,
                s.roll_number,
                c.id AS course_id,
                c.course_name,
                b.id AS batch_id,
                b.batch_name
            FROM students s
            JOIN users u ON s.user_id = u.id
            JOIN courses c ON s.course_id = c.id
            JOIN batches b ON s.batch_id = b.id
            -- CRITICAL JOIN: Link the student profile to the authenticated parent ID
            JOIN parent_student_links psl ON s.user_id = psl.student_user_id 
            WHERE psl.parent_user_id = $1 AND u.deleted_at IS NULL
            ORDER BY u.full_name;
        `;
        
        const result = await pool.query(query, [parentUserId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching parent\'s children:', error);
        res.status(500).json({ message: 'Failed to retrieve linked children data.' });
    }
});