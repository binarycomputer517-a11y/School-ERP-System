const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken } = require('../authMiddleware');

// Middleware to check if the user is a student
const isStudent = (req, res, next) => {
    if (req.user.role !== 'Student') {
        return res.status(403).send('Forbidden: Access is restricted to students.');
    }
    next();
};

// GET /api/student-portal/dashboard - Get dashboard data for the logged-in student
router.get('/dashboard', authenticateToken, isStudent, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Step 1: Use the userId to find the reference_id from the users table
        const userResult = await pool.query('SELECT reference_id FROM users WHERE id = $1', [userId]);

        if (userResult.rows.length === 0) {
            return res.status(404).send('User account not found.');
        }
        
        const studentId = userResult.rows[0].reference_id;

        if (!studentId) {
            return res.status(400).send('This student account is not linked to a student profile.');
        }

        // Step 2: Now use the correct studentId to fetch student-specific data
        const studentInfoQuery = "SELECT first_name, last_name, class_name, roll_number, photo_path FROM students WHERE id = $1";
        const studentResult = await pool.query(studentInfoQuery, [studentId]);
        
        if (studentResult.rows.length === 0) {
            return res.status(404).send('Student profile not found.');
        }
        const studentInfo = studentResult.rows[0];

        // Step 3: Fetch attendance summary for the last 30 days
        const attendanceQuery = `
            SELECT status, COUNT(*) as count 
            FROM attendance 
            WHERE student_id = $1 AND attendance_date >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY status;
        `;
        const attendanceResult = await pool.query(attendanceQuery, [studentId]);
        
        // Step 4: Fetch today's timetable for the student's class
        const today = new Date().toLocaleString('en-US', { weekday: 'long' }); // e.g., "Wednesday"
        const timetableQuery = `
            SELECT tt.period_number, s.subject_name, t.teacher_name
            FROM timetable tt
            JOIN subjects s ON tt.subject_id = s.id
            JOIN teachers t ON tt.teacher_id = t.id
            WHERE tt.class_name = $1 AND tt.day_of_week = $2
            ORDER BY tt.period_number;
        `;
        const timetableResult = await pool.query(timetableQuery, [studentInfo.class_name, today]);

        // Send the complete data as JSON
        res.json({
            student: studentInfo,
            attendanceSummary: attendanceResult.rows,
            todaysTimetable: timetableResult.rows
        });

    } catch (err) {
        console.error('Error fetching student dashboard data:', err);
        res.status(500).send('Server error');
    }
});

module.exports = router;