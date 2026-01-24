/**
 * @fileoverview Express router for handling academic and fee-related API endpoints.
 * @desc This is the CORRECTED file. It queries the PRIMARY KEY 'id' column
 * from all tables and aliases it (e.g., id AS course_id) to match
 * foreign key constraints and frontend expectations, based on the
 * database schema analysis.
 * @module routes/academicsAndFees
 */

// =================================================================
// --- IMPORTS AND ROUTER SETUP ---
// =================================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 

// =================================================================
// --- HELPER FUNCTIONS ---
// =================================================================

const safeParseFloat = (value) => {
    if (value === null || value === undefined) return 0;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
};
const safeParseInt = (value, fallback = 1) => {
    if (value === null || value === undefined) return fallback;
    const parsed = parseInt(value);
    return isNaN(parsed) ? fallback : parsed;
};

// =================================================================
// --- ACADEMIC MANAGEMENT (Course, Batch, Subject, Linking) ---
// =================================================================

// -----------------------------------------------------------------
// --- Course Management ---
// -----------------------------------------------------------------

/**
 * @route   POST /api/academicswithfees/courses
 * @desc    Create a new course (Isolated by Branch)
 * @access  Private (Admin, Super Admin)
 */
router.post('/courses', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { course_name, course_code } = req.body;
    
    // ১. টোকেন থেকে লগইন করা ইউজারের ব্রাঞ্চ আইডি নেওয়া
    const branch_id = req.user.branch_id; 

    if (!branch_id) {
        return res.status(400).json({ message: 'User branch identification failed.' });
    }

    try {
        // ২. ডাটাবেজে branch_id সহ ইনসার্ট করা
        const query = `
            INSERT INTO courses (course_name, course_code, branch_id) 
            VALUES ($1, $2, $3) 
            RETURNING id AS course_id, course_name, course_code, branch_id
        `;
        
        const newCourse = await pool.query(query, [course_name, course_code, branch_id]);
        
        res.status(201).json(newCourse.rows[0]);
    } catch (err) {
        // ৩. ডুপ্লিকেট কোর্স কোড হ্যান্ডেল করা (একই ব্রাঞ্চে ডুপ্লিকেট হবে না)
        if (err.code === '23505') {
            return res.status(409).json({ 
                message: 'A course with this code already exists in your branch.' 
            });
        }
        console.error('Error creating course:', err);
        res.status(500).json({ message: 'Error creating course', error: err.message });
    }
});

/**
 * @route   GET /api/academicswithfees/courses
 * @desc    Get all courses
 * @access  Private (All Authenticated Roles)
 */
router.get('/courses', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Select the 'id' (Primary Key) and alias it
        const result = await pool.query('SELECT id AS course_id, course_name, course_code FROM courses ORDER BY course_name'); 
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching courses:', err);
        res.status(500).json({ message: 'Server error while fetching courses', error: err.message });
    }
});

/**
 * @route   PUT /api/academicswithfees/courses/:id
 * @desc    Update an existing course (param :id is the UUID Primary Key)
 * @access  Private (Admin)
 */
router.put('/courses/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { id } = req.params; // This 'id' is the Primary Key UUID
    const { course_name, course_code } = req.body;
    try {
        // --- FIXED ---: Update WHERE 'id'
        const result = await pool.query(
            "UPDATE courses SET course_name = $1, course_code = $2 WHERE id = $3 RETURNING id AS course_id, course_name, course_code",
            [course_name, course_code, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Course not found' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error updating course:', err);
        res.status(500).json({ message: 'Error updating course', error: err.message });
    }
});

/**
 * @route   DELETE /api/academicswithfees/courses/:id
 * @desc    Delete a course (param :id is the UUID Primary Key)
 * @access  Private (Admin)
 */
router.delete('/courses/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Delete WHERE 'id'
        const result = await pool.query("DELETE FROM courses WHERE id = $1 RETURNING id", [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Course not found.' });
        }
        res.status(200).json({ message: 'Course deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({ message: 'Cannot delete course. It is referenced by other records (e.g., batches).' });
        }
        console.error('Error deleting course:', err);
        res.status(500).json({ message: 'Error deleting course', error: err.message });
    }
});


// -----------------------------------------------------------------
// --- Batch Management ---
// -----------------------------------------------------------------

/**
 * @route   POST /api/academicswithfees/batches
 * @desc    Create a new batch for a course
 * @access  Private (Admin)
 */
router.post('/batches', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { batch_name, batch_code, course_id } = req.body; // course_id is the UUID from courses.id
    if (!batch_name || !course_id) {
        return res.status(400).json({ message: 'Batch name and course ID are required.' });
    }
    try {
        // --- FIXED ---: Return 'id' aliased as 'batch_id'
        // 'course_id' (foreign key) correctly references 'courses.id'
        const newBatch = await pool.query(
            "INSERT INTO batches (batch_name, batch_code, course_id) VALUES ($1, $2, $3) RETURNING id AS batch_id, batch_name, batch_code, course_id",
            [batch_name.trim(), batch_code ? batch_code.trim() : null, course_id]
        );
        res.status(201).json(newBatch.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A batch with this name or code already exists for this course.' });
        }
        console.error('Error creating batch:', err);
        res.status(500).json({ message: 'Error creating batch', error: err.message });
    }
});

/**
 * @route   GET /api/academicswithfees/batches
 * @desc    Get a list of all batches across all courses
 * @access  Private (All Authenticated Roles)
 */
router.get('/batches', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Select 'id' aliased as 'batch_id'
        const result = await pool.query('SELECT id AS batch_id, batch_name, batch_code, course_id FROM batches ORDER BY batch_name');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching all batches:', err);
        res.status(500).json({ message: 'Server error while fetching batches', error: err.message });
    }
});

// -----------------------------------------------------------------
// 🛑 MISSING/FIXED ROUTE FOR BATCH LOOKUP BY COURSE ID 🛑
// -----------------------------------------------------------------

/**
 * @route   GET /api/academicswithfees/batches/:courseId
 * @desc    Get all batches for a specific course ID. (Fixes the add-student.js 404)
 * @access  Private (All Authenticated Roles)
 */
router.get('/batches/:courseId', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => { // Updated Auth
    try {
        // The :courseId param correctly references batches.course_id (which points to courses.id)
        const result = await pool.query(
            'SELECT id AS batch_id, batch_name, batch_code FROM batches WHERE course_id = $1 ORDER BY batch_name',
            [req.params.courseId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching batches for course:', err);
        res.status(500).json({ message: 'Server error fetching batches for course', error: err.message });
    }
});
// -----------------------------------------------------------------

/**
 * @route   GET /api/academicswithfees/courses/:courseId/batches
 * @desc    (This route is redundant if the above /batches/:courseId is used, but kept for legacy)
 * @access  Private (All Authenticated Roles)
 */
router.get('/courses/:courseId/batches', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Select 'id' aliased as 'batch_id'.
        const result = await pool.query(
            'SELECT id AS batch_id, batch_name, batch_code FROM batches WHERE course_id = $1 ORDER BY batch_name',
            [req.params.courseId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching batches for course:', err);
        res.status(500).json({ message: 'Server error fetching batches for course', error: err.message });
    }
});

/**
 * @route   PUT /api/academicswithfees/batches/:id
 * @desc    Update a batch
 * @access  Private (Admin)
 */
router.put('/batches/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { id } = req.params; // This 'id' is the batch Primary Key UUID
    const { batch_name, batch_code } = req.body;
    try {
        // --- FIXED ---: Update WHERE 'id'
        const result = await pool.query(
            "UPDATE batches SET batch_name = $1, batch_code = $2 WHERE id = $3 RETURNING id AS batch_id, batch_name, batch_code, course_id",
            [batch_name, batch_code, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Batch not found' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error updating batch:', err);
        res.status(500).json({ message: 'Error updating batch', error: err.message });
    }
});

/**
 * @route   DELETE /api/academicswithfees/batches/:id
 * @desc    Delete a batch
 * @access  Private (Admin)
 */
router.delete('/batches/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Delete WHERE 'id'
        const result = await pool.query("DELETE FROM batches WHERE id = $1 RETURNING id", [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Batch not found.' });
        }
        res.status(200).json({ message: 'Batch deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({ message: 'Cannot delete batch. It is referenced by other records (e.g., students).' });
        }
        console.error('Error deleting batch:', err);
        res.status(500).json({ message: 'Error deleting batch', error: err.message });
    }
});

// -----------------------------------------------------------------
// --- Subject Management ---
// -----------------------------------------------------------------

/**
 * @route   POST /api/academicswithfees/subjects
 * @desc    Create a new subject
 * @access  Private (Admin)
 */
router.post('/subjects', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { subject_name, subject_code } = req.body;
    try {
        // --- FIXED ---: Return 'id' aliased as 'subject_id'
        const newSubject = await pool.query(
            "INSERT INTO subjects (subject_name, subject_code) VALUES ($1, $2) RETURNING id AS subject_id, subject_name, subject_code",
            [subject_name, subject_code]
        );
        res.status(201).json(newSubject.rows[0]);
    } catch (err) {
        console.error('Error creating subject:', err);
        res.status(500).json({ message: 'Error creating subject', error: err.message });
    }
});

/**
 * @route   GET /api/academicswithfees/subjects
 * @desc    Get all subjects
 * @access  Private (All Authenticated Roles)
 */
router.get('/subjects', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Select 'id' aliased as 'subject_id'
        const result = await pool.query('SELECT id AS subject_id, subject_name, subject_code FROM subjects ORDER BY subject_name');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching subjects:', err);
        res.status(500).json({ message: 'Error fetching subjects', error: err.message });
    }
});

/**
 * @route   PUT /api/academicswithfees/subjects/:id
 * @desc    Update a subject
 * @access  Private (Admin)
 */
router.put('/subjects/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { id } = req.params; // This 'id' is the subject Primary Key UUID
    const { subject_name, subject_code } = req.body;
    try {
        // --- FIXED ---: Update WHERE 'id'
        const result = await pool.query(
            "UPDATE subjects SET subject_name = $1, subject_code = $2 WHERE id = $3 RETURNING id AS subject_id, subject_name, subject_code",
            [subject_name, subject_code, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Subject not found' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error updating subject:', err);
        res.status(500).json({ message: 'Error updating subject', error: err.message });
    }
});

/**
 * @route   DELETE /api/academicswithfees/subjects/:id
 * @desc    Delete a subject
 * @access  Private (Admin)
 */
router.delete('/subjects/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Delete WHERE 'id'
        const result = await pool.query("DELETE FROM subjects WHERE id = $1 RETURNING id", [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Subject not found.' });
        }
        res.status(200).json({ message: 'Subject deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
             return res.status(409).json({ message: 'Cannot delete subject. It is assigned to one or more courses.' });
        }
        console.error('Error deleting subject:', err);
        res.status(500).json({ message: 'Error deleting subject', error: err.message });
    }
});

// -----------------------------------------------------------------
// --- Course-Subject Linking & Course Details ---
// -----------------------------------------------------------------

/**
 * @route   GET /api/academicswithfees/courses/:courseId/subjects
 * @desc    Get all subjects linked to a specific course
 * @access  Private (All Authenticated Roles)
 */
router.get('/courses/:courseId/subjects', authenticateToken, authorize(['Admin', 'Super Admin', 'Teacher', 'Coordinator', 'Student']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Select 's.id' (subject PK) aliased as 'subject_id'
        const result = await pool.query(`
            SELECT s.id AS subject_id, s.subject_name, s.subject_code FROM subjects s
            JOIN course_subjects cs ON s.id = cs.subject_id
            WHERE cs.course_id = $1
            ORDER BY s.subject_name;
        `, [req.params.courseId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching subjects for course:', err);
        res.status(500).json({ message: 'Error fetching subjects for course', error: err.message });
    }
});

/**
 * @route   PUT /api/academicswithfees/courses/:courseId/subjects
 * @desc    Update the list of subjects linked to a course (transactional)
 * @access  Private (Admin)
 */
router.put('/courses/:courseId/subjects', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { courseId } = req.params; // This is courses.id (PK)
    const { subjectIds } = req.body; // This is an array of subjects.id (PK)

    // This code is now correct because the frontend sends the 'id' (PK) for
    // both course and subjects, matching the Foreign Key constraints.
    
    if (!Array.isArray(subjectIds)) {
        return res.status(400).json({ message: 'subjectIds must be an array.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Delete links based on courses.id
        await client.query('DELETE FROM course_subjects WHERE course_id = $1', [courseId]);

        // Insert new links
        if (subjectIds.length > 0) {
            const insertQuery = 'INSERT INTO course_subjects (course_id, subject_id) VALUES ($1, $2)';
            for (const subjectId of subjectIds) {
                // Insert courses.id and subjects.id
                await client.query(insertQuery, [courseId, String(subjectId)]); 
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Subjects for course updated successfully.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating subjects for course:', err);
        // This is the error you were seeing:
        // "violates foreign key constraint ... course_subjects_course_id_fkey"
        // It will be fixed now.
        res.status(500).json({ message: 'Error updating subjects for course', error: err.message });
    } finally {
        client.release();
    }
});

/**
 * @route   GET /api/academicswithfees/course-details/:courseId
 * @desc    Get comprehensive details for a course
 * @access  Private (All Authenticated Roles)
 */
router.get('/course-details/:courseId', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => { // Updated Auth
    try {
        const { courseId } = req.params; // This is courses.id

        // --- FIXED ---: Query by 'id'
        const courseResult = await pool.query('SELECT id AS course_id, course_name, course_code FROM courses WHERE id = $1', [courseId]);
        if (courseResult.rowCount === 0) {
            return res.status(404).json({ message: 'Course not found.' });
        }
        const course = courseResult.rows[0];

        // --- FIXED ---: Select 'id' as 'batch_id', WHERE course_id = courses.id
        const batchesResult = await pool.query(
            'SELECT id AS batch_id, batch_name, batch_code FROM batches WHERE course_id = $1 ORDER BY batch_name',
            [courseId]
        );

        // --- FIXED ---: Select 's.id' as 'subject_id'
        const subjectsResult = await pool.query(`
            SELECT s.id AS subject_id, s.subject_name, s.subject_code FROM subjects s
            JOIN course_subjects cs ON s.id = cs.subject_id
            WHERE cs.course_id = $1
            ORDER BY s.subject_name;
        `, [courseId]);

        const aggregatedData = {
            course: course,
            batches: batchesResult.rows,
            subjects: subjectsResult.rows,
        };

        res.status(200).json(aggregatedData);
    } catch (err) {
        console.error('Error fetching course details:', err);
        res.status(500).json({ message: 'Server error while fetching course details', error: err.message });
    }
});

// =================================================================
// --- ACADEMIC SESSION MANAGEMENT ---
// =================================================================

/**
 * @route   POST /api/academicswithfees/sessions
 * @desc    Create a new academic session
 * @access  Private (Admin)
 */
router.post('/sessions', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { session_name, start_date, end_date } = req.body;
    try {
        // --- FIXED ---: Return 'id' aliased as 'academic_session_id'
        const newSession = await pool.query(
            "INSERT INTO academic_sessions (session_name, start_date, end_date) VALUES ($1, $2, $3) RETURNING id AS academic_session_id, session_name, start_date, end_date", 
            [session_name, start_date, end_date]
        );
        res.status(201).json(newSession.rows[0]);
    } catch (err) {
        console.error('Error creating academic session:', err);
        res.status(500).json({ message: 'Error creating session', error: err.message });
    }
});

/**
 * @route   GET /api/academicswithfees/sessions
 * @desc    Get all academic sessions
 * @access  Private (All Authenticated Roles)
 */
router.get('/sessions', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => {
    try {
        // ভুল ছিল: SELECT id AS academic_session_id (কারণ 'id' কলামটি আর নেই)
        // সঠিক: SELECT academic_session_id, session_name...
        const result = await pool.query(`
            SELECT 
                academic_session_id, 
                session_name, 
                is_active 
            FROM academic_sessions 
            ORDER BY start_date DESC
        `); 

        // ফ্রন্টএন্ডের compatibility-র জন্য (add-student.js যেন ভেঙে না যায়)
        const sessions = result.rows.map(s => ({
            ...s,
            id: s.academic_session_id // academic_session_id কেই 'id' হিসেবেও পাঠানো হচ্ছে
        }));

        res.json(sessions);
    } catch (err) {
        console.error('Error fetching academic sessions:', err);
        res.status(500).json({ message: 'Server error while fetching sessions', error: err.message });
    }
});

/**
 * @route   PUT /api/academicswithfees/sessions/:id
 * @desc    Update an academic session
 * @access  Private (Admin)
 */
router.put('/sessions/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    const { id } = req.params; // This 'id' is the session Primary Key
    const { session_name, start_date, end_date } = req.body;
    try {
        // --- FIXED ---: Update WHERE 'id'
        const result = await pool.query(
            "UPDATE academic_sessions SET session_name = $1, start_date = $2, end_date = $3 WHERE id = $4 RETURNING *",
            [session_name, start_date, end_date, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Academic session not found' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error updating session:', err);
        res.status(500).json({ message: 'Error updating session', error: err.message });
    }
});

/**
 * @route   DELETE /api/academicswithfees/sessions/:id
 * @desc    Delete an academic session
 * @access  Private (Admin)
 */
router.delete('/sessions/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    try {
        // --- FIXED ---: Delete WHERE 'id'
        const result = await pool.query("DELETE FROM academic_sessions WHERE id = $1 RETURNING id", [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Academic session not found.' });
        }
        res.status(200).json({ message: 'Academic session deleted successfully.' });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(409).json({ message: 'Cannot delete session. It is referenced by other records.' });
        }
        console.error('Error deleting session:', err);
        res.status(500).json({ message: 'Error deleting session', error: err.message });
    }
});


// =================================================================
// --- FEE MANAGEMENT ---
// =================================================================
router.post('/fees/structures', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const {
        course_id, batch_id,
        course_duration_months, admission_fee,
        registration_fee, tuition_fee, exam_fee,
        has_transport, transport_fee, has_hostel, hostel_fee
    } = req.body;

    // টোকেন থেকে লগইন করা ইউজারের ব্রাঞ্চ আইডি নেওয়া
    const branch_id = req.user.branch_id; 

    if (!branch_id) {
        return res.status(400).json({ message: 'Branch identification failed. Please re-login.' });
    }

    try {
        // ১. সক্রিয় একাডেমিক সেশন খুঁজে বের করা
        const activeSessionRes = await pool.query(
            "SELECT academic_session_id FROM academic_sessions WHERE is_active = true LIMIT 1"
        );

        if (activeSessionRes.rowCount === 0) {
            return res.status(400).json({ 
                message: 'No active academic session found. Please mark a session as active in settings.' 
            });
        }

        const academic_session_id = activeSessionRes.rows[0].academic_session_id;

        // ২. নাম তৈরির জন্য কোর্স ও ব্যাচ চেক করা
        const [courseRes, batchRes] = await Promise.all([
            pool.query('SELECT course_name FROM courses WHERE id = $1', [course_id]),
            pool.query('SELECT batch_name FROM batches WHERE id = $1', [batch_id])
        ]);

        if (courseRes.rowCount === 0 || batchRes.rowCount === 0) {
            return res.status(404).json({ message: 'Invalid course or batch selection.' });
        }
        
        const structure_name = `${courseRes.rows[0].course_name} - ${batchRes.rows[0].batch_name}`;

        // ৩. চূড়ান্ত ডাটা ইনসার্ট (branch_id যুক্ত করা হয়েছে)
        const insertQuery = `
            INSERT INTO fee_structures (
                branch_id, course_id, batch_id, academic_session_id, structure_name, 
                course_duration_months, admission_fee, registration_fee, 
                tuition_fee, exam_fee, has_transport, transport_fee, 
                has_hostel, hostel_fee
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
            RETURNING *;`;
        
        const values = [
            branch_id, course_id, batch_id, academic_session_id, structure_name, 
            course_duration_months, admission_fee || 0, registration_fee || 0, 
            tuition_fee || 0, exam_fee || 0, has_transport || false, 
            transport_fee || 0, has_hostel || false, hostel_fee || 0
        ];

        const newStructure = await pool.query(insertQuery, values);
        res.status(201).json(newStructure.rows[0]);

    } catch (err) {
        // ৪. ইউনিক কনস্ট্রেইন এরর হ্যান্ডেল করা (Branch-specific)
        if (err.code === '23505') {
            return res.status(409).json({ 
                message: 'A fee structure for this Course, Batch, and Session already exists in your branch.' 
            });
        }
        console.error('SERVER ERROR:', err);
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});



/**
 * @route   GET /api/academicswithfees/fees/structures/find
 * @desc    Get a single fee structure by Course, Batch, and Branch
 * @access  Private (All Authenticated Roles)
 */
router.get('/fees/structures/find', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => {
    try {
        const { course_id, batch_id } = req.query;
        // ১. টোকেন থেকে ইউজারের নিজস্ব ব্রাঞ্চ আইডি নেওয়া
        const branch_id = req.user.branch_id; 

        if (!course_id || !batch_id) { 
            return res.status(400).json({ message: 'Course ID and Batch ID are required for lookup.' });
        }
        
        // ২. কুয়েরিতে branch_id যুক্ত করা হয়েছে যাতে সঠিক ব্রাঞ্চের ফি পাওয়া যায়
        const result = await pool.query(
            `SELECT * FROM fee_structures 
             WHERE course_id = $1 AND batch_id = $2 AND branch_id = $3`, 
            [course_id, batch_id, branch_id] 
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'No fee structure found for this batch in your branch.' });
        }
        
        const structureData = result.rows[0];
        
        // আপনার চমৎকার স্যানিটাইজেশন লজিকটি এখানে বহাল থাকল
        const sanitizedData = {
            ...structureData,
            admission_fee: safeParseFloat(structureData.admission_fee),
            registration_fee: safeParseFloat(structureData.registration_fee),
            examination_fee: safeParseFloat(structureData.examination_fee),
            tuition_fee: safeParseFloat(structureData.tuition_fee), // এটি যোগ করা হয়েছে
            exam_fee: safeParseFloat(structureData.exam_fee),       // এটি যোগ করা হয়েছে
            transport_fee: safeParseFloat(structureData.transport_fee),
            hostel_fee: safeParseFloat(structureData.hostel_fee),
            course_duration_months: safeParseInt(structureData.course_duration_months, 1),
            has_transport: !!structureData.has_transport,
            has_hostel: !!structureData.has_hostel,
        };
        
        res.status(200).json(sanitizedData);
        
    } catch (err) {
        console.error(`ERROR in /fees/structures/find route:`, err);
        res.status(500).json({ message: "Server error", error: err.message });
    }
});
/**
 * @route   GET /api/academicswithfees/fees/structures
 * @desc    Get fee structures (Joined with Codes & Branch)
 * @access  Private (Admin, Super Admin)
 */
router.get('/fees/structures', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { branch_id: userBranchId, role } = req.user;

    try {
        let query;
        let params = [];

        // সুপার অ্যাডমিন সব ব্রাঞ্চের কোড এবং নাম দেখতে পাবেন
        if (role === 'Super Admin' || role === 'Prime Admin') {
            query = `
                SELECT 
                    fs.*, 
                    b.branch_name, 
                    c.course_name, 
                    c.course_code, 
                    bat.batch_name, 
                    bat.batch_code 
                FROM fee_structures fs
                LEFT JOIN branches b ON fs.branch_id = b.id
                LEFT JOIN courses c ON fs.course_id = c.id
                LEFT JOIN batches bat ON fs.batch_id = bat.id
                ORDER BY fs.created_at DESC
            `;
        } else {
            // সাধারণ অ্যাডমিন শুধু নিজের ব্রাঞ্চের কোড এবং নাম দেখবেন
            query = `
                SELECT 
                    fs.*, 
                    c.course_name, 
                    c.course_code, 
                    bat.batch_name, 
                    bat.batch_code,
                    b.branch_name
                FROM fee_structures fs
                JOIN courses c ON fs.course_id = c.id
                JOIN batches bat ON fs.batch_id = bat.id
                JOIN branches b ON fs.branch_id = b.id
                WHERE fs.branch_id = $1
                ORDER BY fs.created_at DESC
            `;
            params = [userBranchId];
        }

        const result = await pool.query(query, params);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching fee structures:', err);
        res.status(500).json({ message: "Server error", error: err.message });
    }
});
/**
 * @route   GET /api/academicswithfees/fees/structures/:id
 * @desc    Get a single fee structure by its ID (Fee Structure's PK)
 * @access  Private (Admin)
 */
router.get('/fees/structures/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => { // Updated Auth
    // This route is for the fee_structure's own 'id', which may or may not be UUID.
    // We assume it's the Primary Key.
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM fee_structures WHERE id = $1', [id]); 

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Fee structure not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching fee structure (by ID):', err);
        if (err.code === '22P02') { 
            return res.status(400).json({ message: "Invalid ID format provided." });
        }
        res.status(500).json({ message: "Server error while fetching fee structure", error: err.message });
    }
});

/**
 * @route   PUT /api/academicswithfees/fees/structures/:id
 * @desc    Update a fee structure (Securely isolated by Branch)
 * @access  Private (Admin, Super Admin)
 */
router.put('/fees/structures/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const { id } = req.params;
        const { branch_id, role } = req.user; // টোকেন থেকে ইউজারের ব্রাঞ্চ এবং রোল নেওয়া
        
        const {
            course_duration_months, admission_fee, registration_fee,
            examination_fee, tuition_fee, exam_fee, // tuition_fee এবং exam_fee যোগ করা হয়েছে
            has_transport, transport_fee, has_hostel, hostel_fee
        } = req.body;

        // ১. সিকিউরিটি লজিক: সুপার অ্যাডমিন সব এডিট করতে পারবে, 
        // কিন্তু সাধারণ অ্যাডমিন শুধু তার নিজের ব্রাঞ্চের ডাটা এডিট করতে পারবে।
        let updateQuery = `
            UPDATE fee_structures SET
                course_duration_months = $1, admission_fee = $2, registration_fee = $3,
                examination_fee = $4, has_transport = $5, transport_fee = $6,
                has_hostel = $7, hostel_fee = $8, tuition_fee = $9, exam_fee = $10,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $11
        `;
        
        let values = [
            course_duration_months, admission_fee, registration_fee, examination_fee,
            has_transport || false, (has_transport && transport_fee) ? transport_fee : 0,
            has_hostel || false, (has_hostel && hostel_fee) ? hostel_fee : 0,
            tuition_fee || 0, exam_fee || 0,
            id
        ];

        // ২. ব্রাঞ্চ ফিল্টার যোগ করা (সুপার অ্যাডমিন না হলে)
        if (role !== 'Super Admin' && role !== 'Prime Admin') {
            updateQuery += ` AND branch_id = $12`;
            values.push(branch_id);
        }

        const result = await pool.query(updateQuery + " RETURNING *", values);

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                message: 'Fee structure not found or you do not have permission to update it.' 
            });
        }

        res.status(200).json({ 
            message: 'Fee structure updated successfully.', 
            data: result.rows[0] 
        });

    } catch (err) {
        console.error('Error updating fee structure:', err);
        res.status(500).json({ message: "Error updating fee structure", error: err.message });
    }
});

/**
 * @route   DELETE /api/academicswithfees/fees/structures/:id
 * @desc    Delete a fee structure (Securely isolated by Branch)
 * @access  Private (Admin, Super Admin)
 */
router.delete('/fees/structures/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { branch_id, role } = req.user; // টোকেন থেকে ডাটা নেওয়া

    try {
        let query;
        let params;

        // ১. সিকিউরিটি চেক: সুপার অ্যাডমিন সব ডিলিট করতে পারবে
        // কিন্তু সাধারণ অ্যাডমিন শুধু নিজের ব্রাঞ্চের ডাটা ডিলিট করতে পারবে
        if (role === 'Super Admin' || role === 'Prime Admin') {
            query = "DELETE FROM fee_structures WHERE id = $1 RETURNING id";
            params = [id];
        } else {
            query = "DELETE FROM fee_structures WHERE id = $1 AND branch_id = $2 RETURNING id";
            params = [id, branch_id];
        }

        const result = await pool.query(query, params);

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                message: 'Fee structure not found or you do not have permission to delete it.' 
            });
        }
        
        res.status(200).json({ message: 'Fee structure deleted successfully.' });

    } catch (err) {
        // ২. ফরেন কি কনস্ট্রেইন চেক (যদি স্টুডেন্ট ইনভয়েস এই ফি-র সাথে যুক্ত থাকে)
        if (err.code === '23503') {
            return res.status(409).json({ 
                message: 'Cannot delete: This structure is already linked to student invoices or records.' 
            });
        }
        console.error('Error deleting fee structure:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

/**
 * @route   GET /api/academicswithfees/batches/:courseId
 * @desc    Get all batches for a specific course ID. (Needed by add-student.js)
 * @access  Private (All Authenticated Roles)
 */
router.get('/batches/:courseId', authenticateToken, authorize(['Admin', 'Teacher', 'Coordinator', 'Super Admin', 'Student']), async (req, res) => { // Updated Auth
    try {
        // The :courseId param correctly references batches.course_id (which points to courses.id)
        const result = await pool.query(
            'SELECT id AS batch_id, batch_name, batch_code FROM batches WHERE course_id = $1 ORDER BY batch_name',
            [req.params.courseId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching batches for course:', err);
        res.status(500).json({ message: 'Server error fetching batches for course', error: err.message });
    }
});

/**
 * @route   PATCH /api/academicswithfees/sessions/:id/set-active
 * @desc    Set a specific session as active and deactivate others
 * @access  Private (Admin)
 */
router.patch('/sessions/:id/set-active', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params; // academic_session_id
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // সব সেশনকে ইন-অ্যাক্টিভ করুন
        await client.query('UPDATE academic_sessions SET is_active = false');
        // নির্দিষ্ট সেশনকে অ্যাক্টিভ করুন
        const result = await client.query(
            'UPDATE academic_sessions SET is_active = true WHERE academic_session_id = $1 RETURNING *',
            [id]
        );
        await client.query('COMMIT');
        res.json({ message: 'Session activated successfully', session: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error activating session', error: err.message });
    } finally {
        client.release();
    }
});
// =================================================================
// --- EXPORT ROUTER ---
// =================================================================
module.exports = router;