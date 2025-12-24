const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Constants ---
const MODULES_TABLE = 'online_learning_modules';
const ASSIGNMENTS_CORE_TABLE = 'homework_assignments'; 
const SUBMISSIONS_TABLE = 'assignment_submissions';    
const AUDIT_LOG_TABLE = 'academic_audit_logs';

const ROLES = {
    MANAGERS: ['Super Admin', 'Admin', 'Teacher'],
    STUDENTS: ['Student']
};

// --- Storage Config ---
const uploadDir = 'public/uploads/assignments';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `doc-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage: storage });

// --- Audit Utility ---
async function logAction(userId, action, targetId, metadata = {}) {
    try {
        await pool.query(
            `INSERT INTO ${AUDIT_LOG_TABLE} (user_id, action_type, target_id, metadata) VALUES ($1, $2, $3, $4)`,
            [userId, action, targetId, JSON.stringify(metadata)]
        );
    } catch (e) { console.error('Audit Error:', e.message); }
}

// =========================================================
// 1. MODULE MANAGEMENT (CRUD)
// =========================================================

/**
 * @route   GET /api/online-learning/modules
 * @desc    Fetch Modules (Managers see all, Students see filtered syllabus)
 */
router.get('/modules', authenticateToken, authorize([...ROLES.MANAGERS, ...ROLES.STUDENTS]), async (req, res) => {
    try {
        let query;
        if (req.user.role === 'Student') {
            query = `
                SELECT olm.*, s.subject_name
                FROM ${MODULES_TABLE} olm
                LEFT JOIN subjects s ON olm.subject_id = s.id
                WHERE (olm.is_deleted = false OR olm.is_deleted IS NULL)
                AND (olm.publish_date <= NOW() OR olm.publish_date IS NULL)
                AND (olm.expiry_date > NOW() OR olm.expiry_date IS NULL)
                AND olm.status = 'Published'
                ORDER BY olm.publish_date DESC;
            `;
        } else {
            query = `
                SELECT olm.*, c.course_name, b.batch_name, s.subject_name
                FROM ${MODULES_TABLE} olm
                LEFT JOIN courses c ON olm.course_id = c.id
                LEFT JOIN batches b ON olm.batch_id = b.id
                LEFT JOIN subjects s ON olm.subject_id = s.id
                WHERE (olm.is_deleted = false OR olm.is_deleted IS NULL)
                ORDER BY olm.created_at DESC;
            `;
        }
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: error.message }); }
});

/**
 * @route   GET /api/online-learning/modules/:id
 * @desc    Fetch single module details (Allowed for both Managers & Students)
 */
router.get('/modules/:id', authenticateToken, authorize([...ROLES.MANAGERS, ...ROLES.STUDENTS]), async (req, res) => {
    try {
        const query = `
            SELECT olm.*, s.subject_name 
            FROM ${MODULES_TABLE} olm
            LEFT JOIN subjects s ON olm.subject_id = s.id
            WHERE olm.id = $1 AND (olm.is_deleted = false OR olm.is_deleted IS NULL)
        `;
        const result = await pool.query(query, [req.params.id]);
        
        if (result.rowCount === 0) return res.status(404).json({ message: 'Module not found' });
        
        const moduleData = result.rows[0];

        // Security check for Students
        if (req.user.role === 'Student') {
            const now = new Date();
            if (moduleData.status !== 'Published' || 
               (moduleData.publish_date && new Date(moduleData.publish_date) > now) ||
               (moduleData.expiry_date && new Date(moduleData.expiry_date) < now)) {
                return res.status(403).json({ message: 'Content is not accessible at this time.' });
            }
        }

        res.json(moduleData);
    } catch (error) { res.status(500).json({ message: error.message }); }
});

/**
 * @route   POST /api/online-learning/modules
 * @desc    Create a new module with Optional File Upload
 */
router.post('/modules', authenticateToken, authorize(ROLES.MANAGERS), upload.single('file'), async (req, res) => {
    const { title, content_type, content_url, course_id, subject_id, batch_id, due_date, max_marks, publish_date, expiry_date } = req.body;
    let finalUrl = content_url || '';

    if (req.file) finalUrl = `/uploads/assignments/${req.file.filename}`;

    try {
        const query = `
            INSERT INTO ${MODULES_TABLE} 
            (title, content_type, content_url, course_id, subject_id, batch_id, due_date, max_marks, publish_date, expiry_date, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Published') 
            RETURNING id;
        `;
        const result = await pool.query(query, [
            title, content_type || 'ASSIGNMENT', finalUrl, course_id, subject_id, batch_id || null, 
            due_date || null, max_marks || 0, publish_date || new Date(), expiry_date || null
        ]);

        await logAction(req.user.id, 'CREATE_MODULE', result.rows[0].id, { title });
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

/**
 * @route   PUT /api/online-learning/modules/:id
 * @desc    Update Module parameters
 */
router.put('/modules/:id', authenticateToken, authorize(ROLES.MANAGERS), upload.single('file'), async (req, res) => {
    const { title, course_id, subject_id, batch_id, due_date, max_marks, status, content_url, publish_date, expiry_date } = req.body;
    let finalUrl = content_url;

    if (req.file) finalUrl = `/uploads/assignments/${req.file.filename}`;

    try {
        const query = `
            UPDATE ${MODULES_TABLE} 
            SET title=$1, course_id=$2, subject_id=$3, batch_id=$4, due_date=$5, max_marks=$6, status=$7, content_url=$8, publish_date=$9, expiry_date=$10, updated_at=NOW() 
            WHERE id=$11 RETURNING id;
        `;
        await pool.query(query, [title, course_id, subject_id, batch_id, due_date, max_marks, status || 'Published', finalUrl, publish_date, expiry_date, req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

/**
 * @route   DELETE /api/online-learning/modules/:id
 * @desc    Soft Delete Module
 */
router.delete('/modules/:id', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    try {
        await pool.query(`UPDATE ${MODULES_TABLE} SET is_deleted = true WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// =========================================================
// 2. ASSIGNMENT SUBMISSION & STUDENT OPS
// =========================================================

/**
 * @route   GET /api/online-learning/assignments/student/:studentId
 */
router.get('/assignments/student/:studentId', authenticateToken, authorize(ROLES.STUDENTS), async (req, res) => {
    const { studentId } = req.params;
    if (!studentId || studentId === 'null') return res.status(400).json({ message: "Invalid Student ID" });

    try {
        const query = `
            SELECT sub.*, ha.title, ha.max_marks, olm.content_url
            FROM ${SUBMISSIONS_TABLE} sub
            JOIN ${ASSIGNMENTS_CORE_TABLE} ha ON sub.assignment_id = ha.id
            JOIN ${MODULES_TABLE} olm ON ha.module_id = olm.id
            WHERE sub.student_id = $1
            ORDER BY sub.submitted_at DESC NULLS LAST;
        `;
        const result = await pool.query(query, [studentId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: error.message }); }
});

/**
 * @route   POST /api/online-learning/assignments/submit
 */
router.post('/assignments/submit', authenticateToken, authorize(ROLES.STUDENTS), upload.single('submission_file'), async (req, res) => {
    const { submission_id, student_notes } = req.body;
    let filePath = req.file ? `/uploads/assignments/${req.file.filename}` : null;

    if (!filePath) return res.status(400).json({ message: "File required" });

    try {
        const result = await pool.query(
            `UPDATE ${SUBMISSIONS_TABLE} 
             SET submission_file_url = $1, student_notes = $2, submission_status = 'Pending Review', submitted_at = NOW()
             WHERE id = $3 AND (submission_status = 'Not Submitted' OR submission_status = 'Pending Review')
             RETURNING id`,
            [filePath, student_notes, submission_id]
        );
        if (result.rowCount === 0) return res.status(400).json({ message: "Update failed" });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

// =========================================================
// 3. SPECIAL FEATURES (QR & GRADING)
// =========================================================

router.get('/modules/:id/qr', authenticateToken, async (req, res) => {
    try {
        const qrUrl = `${req.protocol}://${req.get('host')}/view-module.html?id=${req.params.id}`;
        res.json({ success: true, qr_data: qrUrl });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

router.post('/submissions/grade', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    const { submission_id, marks, feedback } = req.body;
    try {
        await pool.query(
            `UPDATE ${SUBMISSIONS_TABLE} SET marks_obtained = $1, feedback = $2, submission_status = 'Graded', graded_by = $3, graded_at = NOW() WHERE id = $4`,
            [marks, feedback, req.user.id, submission_id]
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

/**
 * @route   GET /api/online-learning/submissions/pending
 * @desc    Fetch all pending assignments for teacher review
 */
router.get('/submissions/pending', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    try {
        const query = `
            SELECT sub.*, u.full_name as student_name, ha.title as assignment_title
            FROM ${SUBMISSIONS_TABLE} sub
            JOIN students s ON sub.student_id = s.student_id
            JOIN users u ON s.user_id = u.id
            JOIN ${ASSIGNMENTS_CORE_TABLE} ha ON sub.assignment_id = ha.id
            WHERE sub.submission_status = 'Pending Review'
            ORDER BY sub.submitted_at ASC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: "Review Fetch Error: " + error.message });
    }
});
module.exports = router;