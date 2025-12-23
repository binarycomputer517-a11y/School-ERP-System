const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// --- Enterprise Constants ---
const MODULES_TABLE = 'online_learning_modules';
const ASSIGNMENTS_CORE_TABLE = 'homework_assignments'; 
const SUBMISSIONS_TABLE = 'assignment_submissions';    
const MODULE_CONFIG_TABLE = 'online_module_configurations'; 
const AUDIT_LOG_TABLE = 'academic_audit_logs';

const ROLES = {
    ADMINS: ['Super Admin', 'Admin'],
    MANAGERS: ['Super Admin', 'Admin', 'Teacher'],
    STUDENTS: ['Student']
};

// =========================================================
// INTERNAL UTILITIES
// =========================================================

const uploadDir = 'public/uploads/assignments';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `student-${req.body.student_id || 'uuid'}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage: storage });

async function logAction(userId, action, targetId, metadata = {}) {
    try {
        await pool.query(
            `INSERT INTO ${AUDIT_LOG_TABLE} (user_id, action_type, target_id, metadata) VALUES ($1, $2, $3, $4)`,
            [userId, action, targetId, JSON.stringify(metadata)]
        );
    } catch (e) { console.error('Audit Error:', e.message); }
}

// =========================================================
// 1. MODULE & SYLLABUS DELIVERY
// =========================================================

/**
 * @route   GET /api/online-learning/modules/student/:studentId
 * @desc    Fetch student syllabus with submission status.
 */
router.get('/modules/student/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params; 
    try {
        const query = `
            SELECT
                olm.id AS module_id, olm.title, olm.content_type, olm.content_url,
                s.subject_name,
                COALESCE(sub.submission_status, 'Not Started') as current_status,
                sub.submitted_at as last_submission
            FROM ${MODULES_TABLE} olm
            JOIN students stud ON stud.user_id = $1  
            LEFT JOIN subjects s ON olm.subject_id = s.id
            LEFT JOIN ${ASSIGNMENTS_CORE_TABLE} ha ON ha.module_id = olm.id
            LEFT JOIN ${SUBMISSIONS_TABLE} sub 
                ON sub.assignment_id = ha.id AND sub.student_id = stud.student_id
            WHERE olm.course_id = stud.course_id 
              AND (olm.batch_id = stud.batch_id OR olm.batch_id IS NULL)
              AND olm.status = 'Published'
              AND (olm.is_deleted = false OR olm.is_deleted IS NULL)
            ORDER BY s.subject_name, olm.created_at;
        `;
        const result = await pool.query(query, [studentId]); 
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to sync syllabus.' });
    }
});

/**
 * @route   GET /api/online-learning/modules
 * @desc    Admin view of all modules.
 */
router.get('/modules', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    try {
        const query = `
            SELECT olm.*, c.course_name, s.subject_name
            FROM ${MODULES_TABLE} olm
            LEFT JOIN courses c ON olm.course_id = c.id
            LEFT JOIN subjects s ON olm.subject_id = s.id
            WHERE (olm.is_deleted = false OR olm.is_deleted IS NULL)
            ORDER BY olm.created_at DESC;
        `;
        const result = await pool.query(query); 
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to retrieve modules.' });
    }
});

// =========================================================
// 2. CRUD OPERATIONS (CREATE, UPDATE, DELETE)
// =========================================================

router.post('/modules', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    const { title, content_type, content_url, course_id, subject_id, status, batch_id } = req.body;
    try {
        const query = `
            INSERT INTO ${MODULES_TABLE} (title, content_type, content_url, course_id, subject_id, status, batch_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id;
        `;
        const result = await pool.query(query, [title, content_type, content_url, course_id, subject_id, status, batch_id]);
        await logAction(req.user.id, 'CREATE_MODULE', result.rows[0].id, { title });
        res.status(201).json({ message: 'Success', id: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ message: 'Insert failure.' });
    }
});

/**
 * @route   DELETE /api/online-learning/modules/:id
 * @desc    Delete module with cascade check.
 */
router.delete('/modules/:id', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(`DELETE FROM ${MODULES_TABLE} WHERE id = $1 RETURNING id`, [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Module not found or already deleted.' });
        }
        await logAction(req.user.id, 'DELETE_MODULE', id);
        res.status(200).json({ message: 'Deleted successfully.' });
    } catch (error) {
        console.error('Delete Error:', error.message);
        res.status(500).json({ message: 'Delete failed.' });
    }
});

// =========================================================
// 3. ASSIGNMENT SUBMISSION
// =========================================================

router.post('/assignments/submit', authenticateToken, upload.single('file'), async (req, res) => {
    const { module_id, student_id, comments } = req.body;
    const submission_path = req.file ? `/uploads/assignments/${req.file.filename}` : null;

    if (!module_id || !submission_path) {
        return res.status(400).json({ message: 'Missing module ID or file.' });
    }

    try {
        const assignmentRes = await pool.query(
            `SELECT id FROM ${ASSIGNMENTS_CORE_TABLE} WHERE module_id = $1 LIMIT 1`,
            [module_id]
        );

        if (assignmentRes.rowCount === 0) return res.status(404).json({ message: 'No assignment linked.' });

        const assignment_id = assignmentRes.rows[0].id;
        const query = `
            INSERT INTO ${SUBMISSIONS_TABLE} (assignment_id, student_id, submission_path, submission_text, submission_status, submitted_at)
            VALUES ($1, $2, $3, $4, 'Pending Review', NOW())
            ON CONFLICT (assignment_id, student_id) DO UPDATE SET 
            submission_path = EXCLUDED.submission_path, submitted_at = NOW(), submission_status = 'Pending Review'
            RETURNING id;
        `;
        await pool.query(query, [assignment_id, student_id, submission_path, comments || '']);
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ message: 'Submission failed.' });
    }
});

/**
 * @route   GET /assignments/student/:studentId
 * @desc    Get assigned homework and their current submission status for a student.
 */
router.get('/assignments/student/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;

    try {
        const query = `
            SELECT
                ha.id AS assignment_id,
                ha.title, 
                ha.due_date,
                ha.instructions,
                ha.max_marks,
                s.subject_name,
                s.subject_code,
                -- Get submission status from the submission table
                sub.submission_status, 
                sub.submitted_at AS completion_date
            FROM ${ASSIGNMENTS_CORE_TABLE} ha
            
            -- Join to ensure we are looking at the correct student
            JOIN students stud ON stud.user_id = $1 
            LEFT JOIN subjects s ON ha.subject_id = s.id
            
            -- Join submissions to see if the student has already uploaded something
            LEFT JOIN ${SUBMISSIONS_TABLE} sub 
                ON sub.assignment_id = ha.id 
                AND sub.student_id = stud.student_id 
            
            -- Filter by the student's actual enrollment
            WHERE ha.course_id = stud.course_id 
              AND ha.batch_id = stud.batch_id
            
            ORDER BY ha.due_date DESC;
        `;
        const result = await pool.query(query, [studentId]); 
        res.status(200).json(result.rows);
    } catch (error) {
        console.error(`Error fetching assignments:`, error);
        res.status(500).json({ message: 'Failed to retrieve student assignments.' });
    }
});

module.exports = router;