// routes/onlineLearning.js

const express = require('express');
const router = express.Router();

const { pool } = require('../database'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 


const MODULES_TABLE = 'online_learning_modules';
const ASSIGNMENTS_CORE_TABLE = 'homework_assignments'; 
const SUBMISSIONS_TABLE = 'assignment_submissions';    
const MODULE_CONFIG_TABLE = 'online_module_configurations'; 

// --- Role Definitions ---
const MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher'];
const ADMIN_ONLY_ROLES = ['Super Admin', 'Admin'];

// =========================================================
// 1. GET LISTS & DETAILS
// =========================================================

/**
 * @route   GET /api/online-learning/modules
 * @desc    Get all learning modules for manager overview.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.get('/modules', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT
                olm.id, olm.title, olm.content_type, olm.content_url, olm.status, olm.course_id, olm.subject_id,
                c.course_name, s.subject_name
            FROM ${MODULES_TABLE} olm
            LEFT JOIN courses c ON olm.course_id = c.id
            LEFT JOIN subjects s ON olm.subject_id = s.id
            ORDER BY olm.title;
        `;
        const result = await pool.query(query); 
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching online modules:', error);
        res.status(500).json({ message: 'Failed to retrieve online learning content.' });
    }
});

/**
 * @route   GET /api/online-learning/modules/:id
 * @desc    Get a single module's details.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.get('/modules/:id', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `SELECT * FROM ${MODULES_TABLE} WHERE id = $1`;
        const result = await pool.query(query, [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Module not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching single module:', error);
        res.status(500).json({ message: 'Failed to retrieve module.' });
    }
});

/**
 * @route   GET /api/online-learning/assignments/student/:studentId
 * @desc    Get assigned modules and their status for a specific student.
 * @access  Private (Student, Admin, Super Admin)
 */
router.get('/assignments/student/:studentId', authenticateToken, authorize(['Student', 'Admin', 'Super Admin']), async (req, res) => {
    // The studentId parameter is the user_id (UUID)
    const { studentId } = req.params;

    try {
        const query = `
            SELECT
                ha.id AS assignment_id,
                ha.title, 
                ha.due_date,
                ha.instructions,
                s.subject_name,
                s.subject_code,
                ha.max_marks,
                -- ✅ FINAL FIX: Use the confirmed column names from the DB schema
                sub.submission_status, 
                sub.submitted_at AS completion_date, -- Use submitted_at for frontend consumption
                sub.marks_obtained,
                ha.created_at
            FROM ${ASSIGNMENTS_CORE_TABLE} ha
            
            -- 1. Get student's current enrollment details
            JOIN students stud ON stud.user_id = $1 
            
            -- 2. Get subject name
            LEFT JOIN subjects s ON ha.subject_id = s.id
            
            -- 3. Get submission status and completion date
            LEFT JOIN ${SUBMISSIONS_TABLE} sub 
                ON sub.assignment_id = ha.id 
                AND sub.student_id = $1 
            
            -- 4. Filter: Only show assignments published for the student's current course and batch
            WHERE ha.course_id = stud.course_id AND ha.batch_id = stud.batch_id
            
            ORDER BY ha.due_date DESC;
        `;
        const result = await pool.query(query, [studentId]); 
        
        res.status(200).json(result.rows);
    } catch (error) {
        // Log the actual error that caused the 500
        console.error(`Error fetching assignments for student ${studentId}:`, error);
        res.status(500).json({ message: 'Failed to retrieve student assignments.' });
    }
});


// =========================================================
// 2. CRUD OPERATIONS
// ... (Your other CRUD routes remain the same)
// =========================================================

/**
 * @route   POST /api/online-learning/modules
 * @desc    Create a new learning module.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.post('/modules', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { title, content_type, content_url, course_id, subject_id, status } = req.body;
    
    if (!title || !content_type || !content_url || !course_id || !subject_id) {
        return res.status(400).json({ message: 'Missing required module fields.' });
    }

    try {
        const query = `
            INSERT INTO ${MODULES_TABLE} (title, content_type, content_url, course_id, subject_id, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id;
        `;
        const values = [title, content_type, content_url, course_id, subject_id, status || 'Draft'];
        
        const result = await pool.query(query, values); 
        
        if (result.rowCount === 0 || !result.rows[0].id) {
            console.error('Module Creation Error: DB reported 0 rows inserted or missing ID.');
            return res.status(500).json({ message: 'Failed to confirm module creation in the database.' });
        }
        
        res.status(201).json({ message: 'Module created successfully!', id: result.rows[0].id });
        
    } catch (error) {
        console.error('Module Creation FAILED. Database Error Details:', error.message);
        res.status(500).json({ message: 'Database transaction failed.', error_detail: error.message });
    }
});

/**
 * @route   PUT /api/online-learning/modules/:id
 * @desc    Update an existing learning module.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.put('/modules/:id', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    const { title, content_type, content_url, course_id, subject_id, status } = req.body;

    if (!title || !content_type || !content_url || !course_id || !subject_id) {
        return res.status(400).json({ message: 'Missing required module fields.' });
    }

    try {
        const query = `
            UPDATE ${MODULES_TABLE} SET
                title = $1, content_type = $2, content_url = $3, course_id = $4, subject_id = $5, status = $6, updated_at = NOW()
            WHERE id = $7
            RETURNING id;
        `;
        const values = [title, content_type, content_url, course_id, subject_id, status || 'Draft', id];
        const result = await pool.query(query, values);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Module not found for update.' });
        }

        res.status(200).json({ message: `Module ${id} updated successfully.` });
    } catch (error) {
        console.error('Module Update Error:', error);
        res.status(500).json({ message: 'Failed to update module.' });
    }
});

/**
 * @route   DELETE /api/online-learning/modules/:id
 * @desc    Delete a learning module.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.delete('/modules/:id', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        // NOTE: Requires cascading deletes on related tables (e.g., assignments, progress) to prevent orphan records.
        const query = `DELETE FROM ${MODULES_TABLE} WHERE id = $1 RETURNING id;`;
        const result = await pool.query(query, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Module not found.' });
        }

        res.status(200).json({ message: `Module ${id} deleted successfully.` });
    } catch (error) {
        console.error('Module Delete Error:', error);
        res.status(500).json({ message: 'Failed to delete module.' });
    }
});


// =========================================================
// 3. FEATURE/BULK ROUTES 
// =========================================================

/**
 * @route   POST /api/online-learning/modules/bulk-status
 * @desc    Bulk update module status (F5).
 * @access  Private (Admin, Super Admin)
 */
router.post('/modules/bulk-status', authenticateToken, authorize(ADMIN_ONLY_ROLES), async (req, res) => {
    const { module_ids, action } = req.body;
    
    if (!Array.isArray(module_ids) || module_ids.length === 0 || !['Archive', 'Unpublish', 'Delete'].includes(action)) {
        return res.status(400).json({ message: 'Invalid module list or action for bulk status update.' });
    }

    try {
        let updatedCount = 0;
        let query;

        if (action === 'Delete') {
            query = `DELETE FROM ${MODULES_TABLE} WHERE id = ANY($1::text[])`;
            const result = await pool.query(query, [module_ids]);
            updatedCount = result.rowCount;
        } else {
            const status = action === 'Archive' ? 'Archived' : 'Draft';
            query = `UPDATE ${MODULES_TABLE} SET status = $1, updated_at = NOW() WHERE id = ANY($2::text[])`;
            const result = await pool.query(query, [status, module_ids]);
            updatedCount = result.rowCount;
        }

        res.status(200).json({ message: `Bulk status update successful.`, updated_count: updatedCount });
    } catch (error) {
        console.error('Bulk Status Update Error:', error);
        res.status(500).json({ message: 'Failed to perform bulk status update.' });
    }
});

/**
 * @route   PUT /api/online-learning/modules/:id/grading-config
 * @desc    Set automated grading configuration for a module (F8).
 * @access  Private (Admin, Super Admin)
 */
router.put('/modules/:id/grading-config', authenticateToken, authorize(ADMIN_ONLY_ROLES), async (req, res) => {
    const { id } = req.params;
    const { minimum_pass_score, auto_sync_grades } = req.body;

    if (minimum_pass_score === undefined || typeof auto_sync_grades !== 'boolean') {
        return res.status(400).json({ message: 'Missing pass score or auto-sync flag.' });
    }

    try {
        const config = JSON.stringify({ minimum_pass_score: parseFloat(minimum_pass_score), auto_sync_grades });
        const query = `
            INSERT INTO ${MODULE_CONFIG_TABLE} (module_id, config_key, config_value)
            VALUES ($1, 'grading_config', $2)
            ON CONFLICT (module_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
            RETURNING module_id;
        `;
        await pool.query(query, [id, config]);

        res.status(200).json({ message: `Grading configuration saved for module ${id}.` });
    } catch (error) {
        console.error('Grading Config Update Error:', error);
        res.status(500).json({ message: 'Failed to save grading configuration.' });
    }
});

/**
 * @route   PUT /api/online-learning/modules/:id/prerequisites
 * @desc    Set prerequisite configuration for a module (F11).
 * @access  Private (Admin, Super Admin)
 */
router.put('/modules/:id/prerequisites', authenticateToken, authorize(ADMIN_ONLY_ROLES), async (req, res) => {
    const { id } = req.params;
    const { prerequisite_subject_id, minimum_score } = req.body;
    
    if (!prerequisite_subject_id || minimum_score === undefined) {
        return res.status(400).json({ message: 'Missing prerequisite subject ID or minimum score.' });
    }

    try {
        const config = JSON.stringify({ prerequisite_subject_id, minimum_score: parseFloat(minimum_score) });
        const query = `
            INSERT INTO ${MODULE_CONFIG_TABLE} (module_id, config_key, config_value)
            VALUES ($1, 'prerequisites', $2)
            ON CONFLICT (module_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
            RETURNING module_id;
        `;
        await pool.query(query, [id, config]);

        res.status(200).json({ message: `Prerequisites set for module ${id}.` });
    } catch (error) {
        console.error('Prerequisites Update Error:', error);
        res.status(500).json({ message: 'Failed to set module prerequisites.' });
    }
});

/**
 * @route   PUT /api/online-learning/modules/:id/time-limit
 * @desc    Set time limit configuration for a module (F14).
 * @access  Private (Admin, Super Admin)
 */
router.put('/modules/:id/time-limit', authenticateToken, authorize(ADMIN_ONLY_ROLES), async (req, res) => {
    const { id } = req.params;
    const { limit_minutes, enforce_limit } = req.body;

    if (limit_minutes === undefined || typeof enforce_limit !== 'boolean') {
        return res.status(400).json({ message: 'Missing time limit minutes or enforcement flag.' });
    }

    try {
        const config = JSON.stringify({ limit_minutes: parseInt(limit_minutes, 10), enforce_limit });
        const query = `
            INSERT INTO ${MODULE_CONFIG_TABLE} (module_id, config_key, config_value)
            VALUES ($1, 'time_limit', $2)
            ON CONFLICT (module_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
            RETURNING module_id;
        `;
        await pool.query(query, [id, config]);

        res.status(200).json({ message: `Time limit set for module ${id}.` });
    } catch (error) {
        console.error('Time Limit Update Error:', error);
        res.status(500).json({ message: 'Failed to set module time limit.' });
    }
});

/**
 * @route   POST /api/online-learning/resources/download-bulk
 * @desc    Initiate bulk download job (F15).
 * @access  Private (Admin, Super Admin)
 */
router.post('/resources/download-bulk', authenticateToken, authorize(ADMIN_ONLY_ROLES), async (req, res) => {
    // In a production environment, this would queue a background job (e.g., using BullMQ/Kue).
    res.status(202).json({ 
        message: 'Bulk download job successfully queued. You will receive a notification when the file is ready.', 
        job_id: 'DOWNLOAD_' + Date.now() 
    });
});


/**
 * @route   POST /api/online-learning/modules/import
 * @desc    Bulk import module creation (F18).
 * @access  Private (Admin, Super Admin)
 */
router.post('/modules/import', authenticateToken, authorize(ADMIN_ONLY_ROLES), async (req, res) => {
    const { module_data } = req.body;

    if (!Array.isArray(module_data) || module_data.length === 0) {
        return res.status(400).json({ message: 'No module data provided for import.' });
    }
    
    try {
        let valuesPlaceholder = [];
        let valueList = [];
        let index = 1;

        // Prepare multi-row insert statement values
        module_data.forEach(m => {
             // Values: title, content_type, content_url, course_id, subject_id, status
             valuesPlaceholder.push(`($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, 'Draft')`);
             valueList.push(m.title, m.content_type || 'EXTERNAL', m.content_url, m.course_id, m.subject_id);
        });

        const query = `
            INSERT INTO ${MODULES_TABLE} (title, content_type, content_url, course_id, subject_id, status)
            VALUES ${valuesPlaceholder.join(', ')}
            ON CONFLICT DO NOTHING;
        `;
        const result = await pool.query(query, valueList);

        res.status(200).json({ 
            message: `Batch processing complete. Attempted to insert ${module_data.length} records.`, 
            imported_count: result.rowCount // Use the actual count of inserted rows
        });
    } catch (error) {
        console.error('Bulk Import Error:', error);
        res.status(500).json({ message: 'Failed to execute bulk import due to a database error.' });
    }
});

/**
 * @route   POST /api/online-learning/unassign
 * @desc    Bulk unassignment handler (F27).
 * @access  Private (Admin, Super Admin)
 */
router.post('/unassign', authenticateToken, authorize(ADMIN_ONLY_ROLES), async (req, res) => {
    const { module_id, target_type, target_batch_id, target_students } = req.body;
    
    if (!module_id) {
        return res.status(400).json({ message: 'Missing module ID for unassignment.' });
    }

    let query;
    let unassignedCount = 0;

    try {
        if (target_type === 'batch' && target_batch_id) {
            // Delete submissions for assignments related to the target batch
            query = `
                DELETE FROM ${SUBMISSIONS_TABLE} 
                WHERE assignment_id IN (
                    SELECT id FROM ${ASSIGNMENTS_CORE_TABLE} WHERE batch_id = $2 AND module_id = $1
                )
                AND student_id IN (
                    SELECT user_id FROM students WHERE batch_id = $2
                )
                RETURNING student_id;
            `;
            const result = await pool.query(query, [module_id, target_batch_id]);
            unassignedCount = result.rowCount;
        } else if (target_type === 'individual' && Array.isArray(target_students) && target_students.length > 0) {
            // Delete submissions for a list of individual students
            query = `
                DELETE FROM ${SUBMISSIONS_TABLE} 
                WHERE assignment_id IN (SELECT id FROM ${ASSIGNMENTS_CORE_TABLE} WHERE module_id = $1)
                AND student_id = ANY($2::text[])
                RETURNING student_id;
            `;
            const result = await pool.query(query, [module_id, target_students]);
            unassignedCount = result.rowCount;
        } else {
            return res.status(400).json({ message: 'Invalid unassignment target provided (must select batch or provide student IDs).' });
        }
    
        res.status(200).json({ 
            message: `Bulk unassignment executed successfully.`, 
            unassigned_count: unassignedCount 
        });
    } catch (error) {
        console.error('Bulk Unassign Error:', error);
        res.status(500).json({ message: 'Failed to execute bulk unassignment due to a database error.' });
    }
});


module.exports = router;