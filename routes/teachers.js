const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const bcrypt = require('bcryptjs');
const saltRounds = 10;
const { authenticateToken, authorize } = require('../authMiddleware');
const multer = require('multer'); 
const path = require('path');     
const fs = require('fs');         

const TEACHERS_TABLE = 'teachers';
const USERS_TABLE = 'users';
const DEPARTMENTS_TABLE = 'hr_departments'; 
const BRANCHES_TABLE = 'branches'; 

// --- Role Definitions ---
const CRUD_ROLES = ['Super Admin', 'Admin', 'HR'];
const LIST_ROLES = ['Super Admin', 'Admin', 'HR', 'Teacher', 'Coordinator']; 

// --- Helper: Get Configuration IDs from Request ---
function getConfigIds(req) {
    const branch_id = req.user.branch_id; 
    return { branch_id, created_by: req.user.id, updated_by: req.user.id };
}

// =========================================================
// MULTER CONFIGURATION FOR FILE UPLOADS
// =========================================================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = '';
        if (file.fieldname === 'profile_photo') {
            dir = 'uploads/teacher_photos/'; 
        } else if (file.fieldname === 'cv_file') {
            dir = 'uploads/teacher_cvs/';
        }
        // Synchronously ensure directory exists to prevent async module errors
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, 
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'profile_photo' && !file.mimetype.startsWith('image')) {
            return cb(new Error('Only image files are allowed for profile photo.'), false);
        }
        if (file.fieldname === 'cv_file' && !file.mimetype.includes('pdf') && !file.mimetype.includes('doc')) {
            return cb(new Error('Only PDF or Word documents are allowed for CV.'), false);
        }
        cb(null, true);
    }
});

const teacherUploadFields = upload.fields([
    { name: 'profile_photo', maxCount: 1 },
    { name: 'cv_file', maxCount: 1 }
]);

const cleanupFiles = (profilePhotoPath, cvFilePath) => {
    if (profilePhotoPath && fs.existsSync(profilePhotoPath)) fs.unlinkSync(profilePhotoPath);
    if (cvFilePath && fs.existsSync(cvFilePath)) fs.unlinkSync(cvFilePath);
};

// =========================================================
// 1. GET: Logged-in Teacher's Profile Details
// =========================================================
router.get('/me/profile', authenticateToken, authorize(['Teacher']), async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id AS teacher_id, t.full_name, t.employee_id, t.designation, t.email, 
                t.phone_number, t.date_of_birth, t.hire_date, t.address,
                t.profile_image_path, 
                u.username, u.role, u.id AS user_id, u.created_at,
                hd.name AS department_name,
                b.branch_name
            FROM ${TEACHERS_TABLE} t
            JOIN ${USERS_TABLE} u ON t.user_id = u.id
            LEFT JOIN ${DEPARTMENTS_TABLE} hd ON t.department_id = hd.id 
            LEFT JOIN branches b ON u.branch_id = b.id 
            WHERE u.id = $1 AND u.deleted_at IS NULL;
        `;
        const result = await pool.query(query, [req.user.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Teacher profile not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching teacher profile:', error);
        res.status(500).json({ message: 'Failed to retrieve profile details.' });
    }
});

// =========================================================
// 2. GET: Main List (Full Details for Table View - Admin only) 
// =========================================================
router.get('/', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id AS teacher_id, t.full_name, t.employee_id, t.designation, t.email, 
                t.phone_number, t.date_of_birth, t.hire_date, t.is_active, t.address,
                t.department_id, t.profile_image_path, 
                u.username, u.role, u.id AS user_id,
                hd.name AS department_name, 
                hd.description AS department_description, 
                b.branch_name
            FROM ${TEACHERS_TABLE} t
            LEFT JOIN ${USERS_TABLE} u ON t.user_id = u.id
            LEFT JOIN ${DEPARTMENTS_TABLE} hd ON t.department_id = hd.id 
            LEFT JOIN branches b ON u.branch_id = b.id 
            WHERE u.deleted_at IS NULL
            ORDER BY t.employee_id;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching full teachers list:', error);
        res.status(500).json({ message: 'Failed to retrieve teachers list.' });
    }
});

// =========================================================
// 3. GET: Dropdown List
// =========================================================
router.get('/list', authenticateToken, authorize(LIST_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id AS teacher_id, t.full_name, u.id AS user_id,
                u.username, u.email
            FROM ${TEACHERS_TABLE} t
            JOIN ${USERS_TABLE} u ON t.user_id = u.id
            WHERE t.is_active = TRUE AND u.deleted_at IS NULL 
            ORDER BY t.full_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching simplified teachers list:', error); 
        res.status(500).json({ message: 'Failed to retrieve teacher details.' });
    }
});

// =========================================================
// 4. GET: Teacher's Assigned Students
// =========================================================
router.get('/me/students', authenticateToken, authorize(['Teacher']), async (req, res) => {
    const teacherUserId = req.user.id; 

    try {
        const teacherIdResult = await pool.query('SELECT id FROM teachers WHERE user_id = $1', [teacherUserId]);
        if (teacherIdResult.rowCount === 0) {
            return res.status(404).json({ message: 'Teacher profile not found or is not linked.' });
        }
        const teacherId = teacherIdResult.rows[0].id; 

        const query = `
            SELECT DISTINCT
                u.id AS student_user_id,          
                u.full_name AS student_full_name, 
                u.email,
                stu.roll_number,                  
                c.course_name,
                c.id AS course_id,
                b.batch_name,
                b.id AS batch_id,
                sub.subject_name,
                sub.id AS subject_id
            FROM students stu
            JOIN users u ON stu.user_id = u.id
            JOIN class_timetable ct 
                ON ct.course_id = stu.course_id 
                AND ct.batch_id = stu.batch_id
                AND ct.teacher_id = $1 
            LEFT JOIN courses c ON stu.course_id = c.id
            LEFT JOIN batches b ON stu.batch_id = b.id
            LEFT JOIN subjects sub ON ct.subject_id = sub.id
            WHERE u.deleted_at IS NULL AND u.is_active = TRUE
            ORDER BY u.full_name;
        `;

        const result = await pool.query(query, [teacherId]);
        res.status(200).json(result.rows);
        
    } catch (error) {
        console.error('Error fetching students for teacher:', error);
        res.status(500).json({ message: 'Failed to retrieve student list.' });
    }
});

// =========================================================
// 5. GET: Single Teacher Details (By ID)
// =========================================================
router.get('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const teacherId = req.params.id;
    try {
        const query = `
            SELECT 
                t.*,
                u.username, u.role, 
                hd.name AS department_name 
            FROM ${TEACHERS_TABLE} t
            LEFT JOIN ${USERS_TABLE} u ON t.user_id = u.id
            LEFT JOIN ${DEPARTMENTS_TABLE} hd ON t.department_id = hd.id
            WHERE t.id = $1; 
        `;
        const result = await pool.query(query, [teacherId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Teacher not found.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error(`Error fetching single teacher (${teacherId}):`, error);
        res.status(500).json({ message: 'Failed to retrieve teacher details.' });
    }
});

// =========================================================
// 6. POST: Create New Teacher
// =========================================================
router.post('/', authenticateToken, authorize(CRUD_ROLES), teacherUploadFields, async (req, res) => {
    const {
        username, password, full_name, employee_id, designation, 
        email, phone_number, date_of_birth, address, hire_date,
        department_id, 
        initial_role = 'Teacher'
    } = req.body;
    
    const profilePhotoPath = req.files && req.files.profile_photo ? req.files.profile_photo[0].path : null;
    const cvFilePath = req.files && req.files.cv_file ? req.files.cv_file[0].path : null;
    
    const { branch_id, created_by } = getConfigIds(req); 

    if (!username || !password || !full_name || !employee_id || !email) {
        cleanupFiles(profilePhotoPath, cvFilePath);
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 
        const password_hash = await bcrypt.hash(password, saltRounds);

        const userResult = await client.query(
            `INSERT INTO ${USERS_TABLE} (username, password_hash, role, email, phone_number, branch_id)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [username, password_hash, initial_role, email, phone_number || null, branch_id]
        );
        const newUserId = userResult.rows[0].id;

        await client.query(
            `INSERT INTO ${TEACHERS_TABLE} (
                user_id, full_name, employee_id, designation, 
                email, phone_number, date_of_birth, address, hire_date, created_by,
                department_id, profile_image_path, cv_resume_path      
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [newUserId, full_name, employee_id, designation || null, 
            email, phone_number || null, date_of_birth || null, address || null, hire_date || null, created_by,
            department_id || null, profilePhotoPath, cvFilePath]
        );

        await client.query('COMMIT'); 
        res.status(201).json({ message: 'Teacher created successfully' });
    } catch (error) {
        await client.query('ROLLBACK'); 
        cleanupFiles(profilePhotoPath, cvFilePath);
        res.status(500).json({ message: error.code === '23505' ? 'Employee ID, Username, or Email already exists.' : 'Failed to create teacher.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 7. PUT: Update Teacher Details
// =========================================================
router.put('/:id', authenticateToken, authorize(CRUD_ROLES), teacherUploadFields, async (req, res) => {
    const teacherId = req.params.id;
    const {
        full_name, designation, email, phone_number, date_of_birth, address, hire_date, is_active,
        department_id, new_role, password
    } = req.body;
    
    const newProfilePhotoPath = req.files && req.files.profile_photo ? req.files.profile_photo[0].path : null;
    const newCvFilePath = req.files && req.files.cv_file ? req.files.cv_file[0].path : null;

    const { updated_by } = getConfigIds(req);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const fetchRes = await client.query(`SELECT user_id, profile_image_path, cv_resume_path FROM ${TEACHERS_TABLE} WHERE id = $1`, [teacherId]);
        if (fetchRes.rowCount === 0) throw new Error('Teacher not found.');
        
        const { user_id, profile_image_path: oldProfile, cv_resume_path: oldCv } = fetchRes.rows[0];

        await client.query(
            `UPDATE ${TEACHERS_TABLE} SET
                full_name = $1, designation = $2, email = $3, phone_number = $4, 
                date_of_birth = $5, address = $6, hire_date = $7, is_active = $8,
                department_id = $9, profile_image_path = $10, cv_resume_path = $11, 
                updated_at = CURRENT_TIMESTAMP, updated_by = $12
            WHERE id = $13`,
            [full_name, designation, email, phone_number, date_of_birth, address, hire_date, is_active, 
            department_id, newProfilePhotoPath || oldProfile, newCvFilePath || oldCv, updated_by, teacherId]
        );

        if (password) {
            const hash = await bcrypt.hash(password, saltRounds);
            await client.query(`UPDATE ${USERS_TABLE} SET password_hash = $1 WHERE id = $2`, [hash, user_id]);
        }
        
        await client.query(`UPDATE ${USERS_TABLE} SET email = $1, role = COALESCE($2, role), is_active = $3 WHERE id = $4`, 
            [email, new_role, is_active, user_id]);

        await client.query('COMMIT');
        if (newProfilePhotoPath && oldProfile) cleanupFiles(oldProfile, null);
        if (newCvFilePath && oldCv) cleanupFiles(null, oldCv);

        res.status(200).json({ message: 'Teacher updated successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        cleanupFiles(newProfilePhotoPath, newCvFilePath);
        res.status(400).json({ message: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 8. DELETE: Soft Delete Teacher
// =========================================================
router.delete('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const teacherId = req.params.id; 
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE ${TEACHERS_TABLE} SET is_active = FALSE WHERE id = $1 RETURNING user_id`, [teacherId]);
        if (result.rowCount === 0) throw new Error('Teacher not found.');
        
        await client.query(`UPDATE ${USERS_TABLE} SET is_active = FALSE, deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [result.rows[0].user_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Teacher deactivated successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Failed to deactivate teacher.' });
    } finally {
        client.release();
    }
});

// =========================================================
// GET: Subjects assigned to the logged-in teacher
// =========================================================
router.get('/me/subjects', authenticateToken, authorize(['Teacher']), async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT s.id, s.subject_name 
            FROM subjects s
            JOIN class_timetable ct ON s.id = ct.subject_id
            JOIN teachers t ON t.id = ct.teacher_id
            WHERE t.user_id = $1 AND ct.is_active = true
            ORDER BY s.subject_name;
        `;
        const result = await pool.query(query, [req.user.id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching teacher subjects:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// =========================================================
// GET: Batches assigned to the logged-in teacher
// =========================================================
router.get('/me/batches', authenticateToken, authorize(['Teacher']), async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT b.id, b.batch_name 
            FROM batches b
            JOIN class_timetable ct ON b.id = ct.batch_id
            JOIN teachers t ON t.id = ct.teacher_id
            WHERE t.user_id = $1 AND ct.is_active = true
            ORDER BY b.batch_name;
        `;
        const result = await pool.query(query, [req.user.id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching teacher batches:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;