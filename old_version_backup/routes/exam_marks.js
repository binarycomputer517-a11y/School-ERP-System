const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');

// =======================================================================================
// 1. MARKS ENTRY ROUTE (POST /api/marks)
// =======================================================================================
router.post('/', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { exam_id, subject_id, marks } = req.body;
        const entered_by = req.user.id;

        if (!exam_id || !subject_id || !marks || !Array.isArray(marks)) {
            return res.status(400).json({ message: "Invalid data format." });
        }

        await client.query('BEGIN');

        // Get Course and Batch info from the first student
        const studentInfoQuery = `SELECT course_id, batch_id FROM students WHERE student_id = $1 LIMIT 1`;
        
        for (const mark of marks) {
            const { student_id, marks_obtained_theory, marks_obtained_practical } = mark;

            const studentInfoRes = await client.query(studentInfoQuery, [student_id]);
            const course_id = studentInfoRes.rows[0]?.course_id;
            const batch_id = studentInfoRes.rows[0]?.batch_id;

            const theory = parseFloat(marks_obtained_theory) || 0;
            const practical = parseFloat(marks_obtained_practical) || 0;
            const total = theory + practical;

            let grade = 'F';
            if (total >= 90) grade = 'A+';
            else if (total >= 80) grade = 'A';
            else if (total >= 70) grade = 'B+';
            else if (total >= 60) grade = 'B';
            else if (total >= 50) grade = 'C';
            else if (total >= 40) grade = 'D';

            const checkQuery = `
                SELECT id FROM marks 
                WHERE exam_id = $1 AND subject_id = $2 AND student_id = $3
            `;
            const checkRes = await client.query(checkQuery, [exam_id, subject_id, student_id]);

            if (checkRes.rows.length > 0) {
                const updateQuery = `
                    UPDATE marks 
                    SET marks_obtained_theory = $1, 
                        marks_obtained_practical = $2, 
                        total_marks_obtained = $3,
                        grade = $4,
                        updated_at = NOW(),
                        entered_by = $5
                    WHERE id = $6
                `;
                await client.query(updateQuery, [theory, practical, total, grade, entered_by, checkRes.rows[0].id]);
            } else {
                const insertQuery = `
                    INSERT INTO marks 
                    (exam_id, subject_id, student_id, course_id, batch_id, marks_obtained_theory, marks_obtained_practical, total_marks_obtained, grade, entered_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `;
                await client.query(insertQuery, [exam_id, subject_id, student_id, course_id, batch_id, theory, practical, total, grade, entered_by]);
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ message: "Marks saved successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error saving marks:", err);
        res.status(500).json({ message: "Internal Server Error: " + err.message });
    } finally {
        client.release();
    }
});

// =======================================================================================
// 2. GET STATUS ROUTE
// =======================================================================================
router.get('/status', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                s.enrollment_no, 
                s.first_name || ' ' || s.last_name as student_name,
                c.course_name,
                CASE 
                    WHEN EXISTS (SELECT 1 FROM marks em WHERE em.student_id = s.student_id) THEN 'Generated'
                    ELSE 'Pending'
                END as marksheet_status
            FROM students s
            JOIN courses c ON s.course_id = c.id
            ORDER BY s.enrollment_no
            LIMIT 50
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching status:", err);
        res.status(500).json({ message: "Error fetching status" });
    }
});

// =======================================================================================
// 3. GET EXISTING MARKS
// =======================================================================================
router.get('/:examId/:subjectId', authenticateToken, async (req, res) => {
    try {
        const { examId, subjectId } = req.params;
        const result = await pool.query(`
            SELECT student_id, marks_obtained_theory, marks_obtained_practical
            FROM marks
            WHERE exam_id = $1 AND subject_id = $2
        `, [examId, subjectId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching marks:", err);
        res.status(500).json({ message: "Error fetching marks" });
    }
});

// =======================================================================================
// 4. GET MARKSHEET DETAILS (FIXED SQL)
// =======================================================================================
router.get('/marksheet/roll/:rollNo', authenticateToken, async (req, res) => {
    try {
        const { rollNo } = req.params;
        
        // 1. Get Student Info
        const studentRes = await pool.query(`
            SELECT s.student_id as id, s.enrollment_no as roll_number, s.first_name || ' ' || s.last_name as student_name,
                   c.course_name, b.batch_name
            FROM students s
            JOIN courses c ON s.course_id = c.id
            JOIN batches b ON s.batch_id = b.id
            WHERE s.enrollment_no = $1
        `, [rollNo]);

        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const student = studentRes.rows[0];

        // 2. Get Marks (Fixed Total Calculation)
        // 🔥 FIX: (e.max_theory_marks + e.max_practical_marks) as total_marks
        const marksRes = await pool.query(`
            SELECT 
                sub.subject_name,
                e.exam_name,
                (COALESCE(e.max_theory_marks, 0) + COALESCE(e.max_practical_marks, 0)) as total_marks,
                m.total_marks_obtained as marks_obtained,
                m.grade
            FROM marks m
            JOIN exams e ON m.exam_id = e.id
            JOIN subjects sub ON m.subject_id = sub.id
            WHERE m.student_id = $1
        `, [student.id]);

        res.json({
            ...student,
            marks: marksRes.rows
        });

    } catch (err) {
        console.error("Error fetching marksheet:", err);
        res.status(500).json({ message: "Error fetching marksheet" });
    }
});

module.exports = router;