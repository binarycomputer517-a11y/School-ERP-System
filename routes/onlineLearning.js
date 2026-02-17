/**
 * @fileoverview Online Learning & Assignment Management Router
 * @version 2.6.0 (Enterprise Final - Super Admin Bypass & Schema Synchronized)
 * -------------------------------------------------------------
 * Features: Multi-branch Synchronization, Role-based Access Control,
 * Automated Audit Logging, and Schema-Validated File Management.
 */

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

// 🛡️ Standardized Roles
const ROLES = {
    MANAGERS: ['Super Admin', 'Admin', 'Teacher', 'Prime Admin'],
    STUDENTS: ['Student'],
    PARENTS: ['parent'], 
    SUPER_ADMIN: 'super admin' 
};

// --- Storage Configuration ---
const uploadDir = 'public/uploads/assignments';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `doc-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

/**
 * Audit Utility
 * Synchronizes institutional actions with the academic audit registry.
 */
async function logAction(userId, action, targetId, branchId, metadata = {}) {
    try {
        await pool.query(
            `INSERT INTO ${AUDIT_LOG_TABLE} (user_id, action_type, target_id, branch_id, metadata) 
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, action, targetId, branchId, JSON.stringify(metadata)]
        );
    } catch (e) { console.error('Institutional Audit Registry Failure:', e.message); }
}

// =========================================================
// 1. MODULE MANAGEMENT (CRUD)
// =========================================================

/**
 * @route   GET /api/online-learning/modules
 * @desc    Fetch Modules (Includes Global Batch visibility)
 */
router.get('/modules', authenticateToken, authorize([...ROLES.MANAGERS, ...ROLES.STUDENTS, ...ROLES.PARENTS]), async (req, res) => {
    const isSuperAdmin = req.user.role.toLowerCase() === ROLES.SUPER_ADMIN;
    const branchId = isSuperAdmin ? (req.query.branch_id || req.user.branch_id) : req.user.branch_id;

    if (!branchId) return res.status(400).json({ message: "Institutional branch context required." });

    try {
        let query;
        if (req.user.role.toLowerCase() === 'student' || req.user.role.toLowerCase() === 'parent') {
            query = `
                SELECT olm.*, s.subject_name, b.batch_name
                FROM ${MODULES_TABLE} olm
                LEFT JOIN subjects s ON olm.subject_id = s.id
                LEFT JOIN batches b ON olm.batch_id = b.id
                WHERE (olm.branch_id = $1 OR b.is_global = TRUE) 
                AND (olm.is_deleted = false)
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
                WHERE (olm.branch_id = $1 OR b.is_global = TRUE) 
                AND (olm.is_deleted = false)
                ORDER BY olm.created_at DESC;
            `;
        }
        const result = await pool.query(query, [branchId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: "Failed to synchronize learning modules: " + error.message }); }
});

/**
 * @route   GET /api/online-learning/modules/:id
 */
router.get('/modules/:id', authenticateToken, authorize([...ROLES.MANAGERS, ...ROLES.STUDENTS, ...ROLES.PARENTS]), async (req, res) => {
    try {
        const query = `
            SELECT olm.*, s.subject_name, b.is_global 
            FROM ${MODULES_TABLE} olm
            LEFT JOIN subjects s ON olm.subject_id = s.id
            LEFT JOIN batches b ON olm.batch_id = b.id
            WHERE olm.id = $1 AND (olm.is_deleted = false)
        `;
        const result = await pool.query(query, [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Target learning module not found.' });
        
        const moduleData = result.rows[0];
        const isSuperAdmin = req.user.role.toLowerCase() === ROLES.SUPER_ADMIN; 
        const isParent = req.user.role.toLowerCase() === 'parent';
        const isOwnBranch = String(moduleData.branch_id) === String(req.user.branch_id);
        const isGlobal = moduleData.is_global === true;

        if (!isSuperAdmin && !isOwnBranch && !isGlobal && !isParent) {
            return res.status(403).json({ message: 'Access Denied: Resource restricted to a different campus node.' });
        }

        res.json(moduleData);
    } catch (error) { res.status(500).json({ message: "Internal telemetry synchronization error." }); }
});

/**
 * @route   POST /api/online-learning/modules
 */
router.post('/modules', authenticateToken, authorize(ROLES.MANAGERS), upload.single('file'), async (req, res) => {
    const { title, content_type, content_url, course_id, subject_id, batch_id, due_date, max_marks, publish_date, expiry_date } = req.body;
    
    const isSuperAdmin = req.user.role.toLowerCase() === ROLES.SUPER_ADMIN;
    const branch_id = isSuperAdmin ? (req.body.branch_id || req.user.branch_id) : req.user.branch_id;

    let finalUrl = content_url || '';
    if (req.file) finalUrl = `/uploads/assignments/${req.file.filename}`;

    try {
        const query = `
            INSERT INTO ${MODULES_TABLE} 
            (title, content_type, content_url, course_id, subject_id, batch_id, due_date, max_marks, publish_date, expiry_date, status, branch_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Published', $11) 
            RETURNING id;
        `;
        const result = await pool.query(query, [
            title, content_type || 'VIDEO', finalUrl, course_id, subject_id, batch_id || null, 
            due_date || null, max_marks || 0, publish_date || new Date(), expiry_date || null, branch_id
        ]);

        await logAction(req.user.id, 'CREATE_MODULE', result.rows[0].id, branch_id, { title });
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (error) { res.status(500).json({ message: "Module provisioning failure: " + error.message }); }
});

/**
 * @route   PUT /api/online-learning/modules/:id
 */
router.put('/modules/:id', authenticateToken, authorize(ROLES.MANAGERS), upload.single('file'), async (req, res) => {
    const { title, course_id, subject_id, batch_id, due_date, max_marks, status, content_url, publish_date, expiry_date } = req.body;
    let finalUrl = content_url;

    if (req.file) finalUrl = `/uploads/assignments/${req.file.filename}`;

    try {
        const check = await pool.query(`SELECT branch_id FROM ${MODULES_TABLE} WHERE id = $1`, [req.params.id]);
        if (check.rowCount === 0) return res.status(404).json({ message: 'Target module not identified.' });

        const isSuperAdmin = req.user.role.toLowerCase() === ROLES.SUPER_ADMIN;
        const isOwnBranch = String(check.rows[0].branch_id) === String(req.user.branch_id);

        if (!isSuperAdmin && !isOwnBranch) {
            return res.status(403).json({ message: 'Security Violation: Unauthorized cross-branch data modification.' });
        }

        const query = `
            UPDATE ${MODULES_TABLE} 
            SET title=$1, course_id=$2, subject_id=$3, batch_id=$4, due_date=$5, max_marks=$6, status=$7, content_url=$8, publish_date=$9, expiry_date=$10, updated_at=NOW() 
            WHERE id=$11 AND is_deleted = false RETURNING id;
        `;
        await pool.query(query, [title, course_id, subject_id, batch_id, due_date, max_marks, status || 'Published', finalUrl, publish_date, expiry_date, req.params.id]);
        
        await logAction(req.user.id, 'UPDATE_MODULE', req.params.id, check.rows[0].branch_id, { title });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: "Failed to update learning module metadata: " + error.message }); }
});

/**
 * @route   DELETE /api/online-learning/modules/:id
 */
router.delete('/modules/:id', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    try {
        const check = await pool.query(`SELECT branch_id FROM ${MODULES_TABLE} WHERE id = $1`, [req.params.id]);
        if (check.rowCount === 0) return res.status(404).json({ message: 'Target module not identified.' });

        const isSuperAdmin = req.user.role.toLowerCase() === ROLES.SUPER_ADMIN;
        const isOwnBranch = String(check.rows[0].branch_id) === String(req.user.branch_id);

        if (!isSuperAdmin && !isOwnBranch) {
            return res.status(403).json({ message: 'Security Violation: Unauthorized cross-branch registry deletion.' });
        }

        await pool.query(`UPDATE ${MODULES_TABLE} SET is_deleted = true WHERE id = $1`, [req.params.id]);
        await logAction(req.user.id, 'DELETE_MODULE', req.params.id, check.rows[0].branch_id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: "De-provisioning failure: " + error.message }); }
});

// =========================================================
// 2. ASSIGNMENT SUBMISSION & STUDENT OPERATIONS
// =========================================================

/**
 * @route   GET /api/online-learning/assignments/student/:studentId
 */
router.get('/assignments/student/:studentId', authenticateToken, authorize([...ROLES.MANAGERS, ...ROLES.STUDENTS, ...ROLES.PARENTS]), async (req, res) => {
    try {
        const { studentId } = req.params;
        
        const query = `
            SELECT 
                ha.*, 
                s.subject_name,
                c.course_name,
                t.full_name as teacher_name,
                sub.submission_status,
                sub.marks_obtained,
                sub.submitted_at,
                sub.id as submission_id
            FROM ${ASSIGNMENTS_CORE_TABLE} ha
            JOIN students std ON ha.course_id = std.course_id
            LEFT JOIN subjects s ON ha.subject_id = s.id
            LEFT JOIN courses c ON ha.course_id = c.id
            LEFT JOIN users t ON ha.created_by = t.id
            LEFT JOIN ${SUBMISSIONS_TABLE} sub ON ha.id = sub.assignment_id AND sub.student_id = std.student_id
            WHERE std.student_id = $1::uuid
            ORDER BY ha.due_date ASC;
        `;

        const result = await pool.query(query, [studentId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Assignment Telemetry Fetch Failure:', error.message);
        res.status(500).json({ message: "Internal server error syncing student assignments." });
    }
});

/**
 * @route   POST /api/online-learning/assignments/submit
 * @desc    Submit Assignment (Synchronized with assignment_submissions schema)
 */
router.post('/assignments/submit', authenticateToken, authorize(ROLES.STUDENTS), upload.single('submission_file'), async (req, res) => {
    const { submission_id, submission_text } = req.body;
    const filePath = req.file ? `/uploads/assignments/${req.file.filename}` : null;
    if (!filePath && !submission_text) return res.status(400).json({ message: "Submission rejected: Assignment file or text content is required." });

    try {
        const result = await pool.query(
            `UPDATE ${SUBMISSIONS_TABLE} 
             SET submission_path = $1, submission_text = $2, submission_status = 'Pending Review', submitted_at = NOW()
             WHERE id = $3 AND student_id = (SELECT student_id FROM students WHERE user_id = $4)
             RETURNING id`,
            [filePath, submission_text, submission_id, req.user.id]
        );
        if (result.rowCount === 0) return res.status(400).json({ message: "Submission failure: Record not found or unauthorized access." });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: "Failed to synchronize submission with server: " + error.message }); }
});

/**
 * @route   GET /api/online-learning/submissions/pending
 * @desc    Fetch student submissions awaiting review (Schema Synchronized)
 */
router.get('/submissions/pending', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    const isSuperAdmin = req.user.role.toLowerCase() === ROLES.SUPER_ADMIN;
    const branchId = isSuperAdmin ? (req.query.branch_id || req.user.branch_id) : req.user.branch_id;

    if (!branchId) return res.status(400).json({ message: "Institutional branch context required." });

    try {
        const query = `
            SELECT 
                sub.id, sub.submitted_at, sub.submission_text, sub.submission_path,
                s.first_name || ' ' || s.last_name AS student_name,
                s.enrollment_no,
                ha.title AS assignment_title,
                ha.max_marks,
                subj.subject_name
            FROM ${SUBMISSIONS_TABLE} sub
            JOIN students s ON sub.student_id = s.student_id
            JOIN ${ASSIGNMENTS_CORE_TABLE} ha ON sub.assignment_id = ha.id
            LEFT JOIN subjects subj ON ha.subject_id = subj.id
            WHERE s.branch_id = $1::uuid 
            AND sub.submission_status = 'Pending Review'
            ORDER BY sub.submitted_at ASC;
        `;
        
        const result = await pool.query(query, [branchId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Pending Submissions Telemetry Failure:', error.message);
        res.status(500).json({ message: "Failed to retrieve pending submissions: " + error.message });
    }
});

/**
 * @route   POST /api/online-learning/submissions/grade
 */
router.post('/submissions/grade', authenticateToken, authorize(ROLES.MANAGERS), async (req, res) => {
    const { submission_id, marks, feedback } = req.body;
    try {
        await pool.query(
            `UPDATE ${SUBMISSIONS_TABLE} sub
             SET marks_obtained = $1, feedback = $2, submission_status = 'Graded', graded_by = $3, graded_at = NOW() 
             FROM ${ASSIGNMENTS_CORE_TABLE} ha 
             WHERE sub.id = $4 AND sub.assignment_id = ha.id`,
            [marks, feedback, req.user.id, submission_id]
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: "Evaluation registry error: " + error.message }); }
});

module.exports = router;