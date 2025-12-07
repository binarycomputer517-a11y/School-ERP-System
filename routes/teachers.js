// routes/teachers.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const bcrypt = require('bcryptjs');
const saltRounds = 10;
const { authenticateToken, authorize } = require('../authMiddleware');
const multer = require('multer'); // ADDED: Multer for file uploads
const path = require('path');     // ADDED: Path module
const fs = require('fs');         // ADDED: File System module for cleanup

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
    // Assuming req.user.id is the UUID of the user marking the record
    return { branch_id, created_by: req.user.id, updated_by: req.user.id };
}

// =========================================================
// MULTER CONFIGURATION FOR FILE UPLOADS (New Section)
// =========================================================

// Configure storage destination and filename
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // NOTE: Ensure this directory exists relative to your server's root
        if (file.fieldname === 'profile_photo') {
            cb(null, 'uploads/teacher_photos/'); 
        } else if (file.fieldname === 'cv_file') {
            cb(null, 'uploads/teacher_cvs/');
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB file limit
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

// Define the fields Multer should expect from the form
const teacherUploadFields = upload.fields([
    { name: 'profile_photo', maxCount: 1 },
    { name: 'cv_file', maxCount: 1 }
]);

// Helper to clean up files if transaction fails
const cleanupFiles = (profilePhotoPath, cvFilePath) => {
    if (profilePhotoPath && fs.existsSync(profilePhotoPath)) fs.unlinkSync(profilePhotoPath);
    if (cvFilePath && fs.existsSync(cvFilePath)) fs.unlinkSync(cvFilePath);
};

// =========================================================
// 1. GET: Main List (Full Details for Table View) 
// =========================================================

/**
 * @route   GET /api/teachers
 * @desc    Get the full list of teachers for the Admin/Manager view table.
 * @access  Private (Admin, Super Admin, HR)
 */
router.get('/', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id AS teacher_id,              /* Primary Key is 'id', aliased as 'teacher_id' */
                t.full_name, 
                t.employee_id, 
                t.designation, 
                t.email, 
                t.phone_number,
                t.date_of_birth, 
                t.hire_date, 
                t.is_active,
                t.address,
                t.department_id, 
                t.profile_image_path, /* ADDED: Fetch image path for FE display/ID card */
                u.username, 
                u.role, 
                u.id AS user_id,

                -- Data from Department Table (FIXED: hd.name is correct)
                hd.name AS department_name, 
                hd.description AS department_description, 

                -- Data from User's Branch
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
// 2. GET: Dropdown List (Omitted for brevity)
// =========================================================

/**
 * @route   GET /api/teachers/list
 * @desc    Get simplified list for dropdowns (Timetable/Assignment forms).
 * @access  Private (Manager/Teacher)
 */
router.get('/list', authenticateToken, authorize(LIST_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                t.id AS teacher_id, 
                t.full_name, 
                u.id AS user_id,
                u.username,
                u.email
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

// --- GET: Single Teacher Details (Updated to include file paths) ---
/**
 * @route   GET /api/teachers/:id
 * @desc    Get details for a single teacher (Used for Edit form population).
 * @access  Private (Admin, Super Admin, HR)
 */
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
            return res.status(404).json({ message: 'Teacher not found in the database.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error(`Error fetching single teacher (${teacherId}):`, error);
        res.status(500).json({ message: 'Failed to retrieve teacher details.' });
    }
});


// =========================================================
// 3. POST: Create New Teacher (CRITICALLY UPDATED FOR FILES)
// =========================================================

/**
 * @route   POST /api/teachers
 * @desc    Create a new teacher and their linked user account (Transactional).
 * @access  Private (Admin, Super Admin, HR)
 */
router.post('/', authenticateToken, authorize(CRUD_ROLES), teacherUploadFields, async (req, res) => {
    // req.body contains text fields; req.files contains file info
    const {
        username, password, full_name, employee_id, designation, 
        email, phone_number, date_of_birth, address, hire_date,
        department_id, 
        initial_role = 'Teacher'
    } = req.body;
    
    // Extract file paths from Multer results
    const profilePhotoPath = req.files.profile_photo ? req.files.profile_photo[0].path : null;
    const cvFilePath = req.files.cv_file ? req.files.cv_file[0].path : null;
    
    const { branch_id, created_by } = getConfigIds(req); 

    if (!username || !password || !full_name || !employee_id || !email) {
        // CRITICAL: Must clean up uploaded files if validation fails
        cleanupFiles(profilePhotoPath, cvFilePath);
        return res.status(400).json({ message: 'Missing required user/teacher fields.' });
    }
    if (password.length < 6) {
        cleanupFiles(profilePhotoPath, cvFilePath);
        return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        // 1. Hash Password
        const password_hash = await bcrypt.hash(password, saltRounds);

        // 2. Create User Account (user is associated with a branch)
        const userQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, email, phone_number, branch_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id;
        `;
        const userResult = await client.query(userQuery, [username, password_hash, initial_role, email, phone_number || null, branch_id]);
        const newUserId = userResult.rows[0].id;

        // 3. Create Teacher Profile (INCLUDING NEW PATHS)
        const teacherQuery = `
            INSERT INTO ${TEACHERS_TABLE} (
                user_id, full_name, employee_id, designation, 
                email, phone_number, date_of_birth, address, hire_date, created_by,
                department_id, 
                profile_image_path, /* NEW COLUMN */
                cv_resume_path      /* NEW COLUMN */
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id AS teacher_id, full_name, employee_id; 
        `;
        const teacherResult = await client.query(teacherQuery, [
            newUserId, full_name, employee_id, designation || null, 
            email, phone_number || null, date_of_birth || null, address || null, hire_date || null, created_by,
            department_id || null, 
            profilePhotoPath, // Path from Multer
            cvFilePath        // Path from Multer
        ]);

        await client.query('COMMIT'); 

        res.status(201).json({ 
            message: 'Teacher created successfully', 
            teacher: teacherResult.rows[0],
            profile_image_path: profilePhotoPath,
            cv_resume_path: cvFilePath
        });

    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error('Teacher Creation Error:', error);
        
        // CRITICAL: Clean up files if DB transaction fails
        cleanupFiles(profilePhotoPath, cvFilePath);
        
        let errorMessage = 'Failed to create teacher due to server error.';
        if (error.code === '23505') {
            errorMessage = 'Employee ID, Username, or Email already exists.';
            return res.status(409).json({ message: errorMessage });
        }
        res.status(500).json({ message: errorMessage });
    } finally {
        client.release();
    }
});


// =========================================================
// 4. PUT: Update Existing Teacher Details (CRITICALLY UPDATED FOR FILES/PASSWORD)
// =========================================================

/**
 * @route   PUT /api/teachers/:id
 * @desc    Update a teacher's profile and linked user account (Transactional).
 * @access  Private (Admin, Super Admin, HR)
 * * NOTE: Middleware `teacherUploadFields` processes files first, storing them in req.files
 */
router.put('/:id', authenticateToken, authorize(CRUD_ROLES), teacherUploadFields, async (req, res) => {
    // req.body contains text fields; req.files contains file info
    const teacherId = req.params.id;
    const {
        full_name, designation, email, phone_number, date_of_birth, address, hire_date, is_active,
        department_id, new_role, password
    } = req.body;
    
    // Extract NEW file paths from Multer results
    const newProfilePhotoPath = req.files.profile_photo ? req.files.profile_photo[0].path : null;
    const newCvFilePath = req.files.cv_file ? req.files.cv_file[0].path : null;

    const { updated_by } = getConfigIds(req);

    if (!full_name || !email) {
        cleanupFiles(newProfilePhotoPath, newCvFilePath);
        return res.status(400).json({ message: 'Missing required fields (Name, Email).' });
    }

    const client = await pool.connect();
    let oldProfilePath = null;
    let oldCvPath = null;

    try {
        await client.query('BEGIN');

        // 0. Fetch existing paths and user_id for updates/cleanup
        const fetchRes = await client.query(`SELECT user_id, profile_image_path, cv_resume_path FROM ${TEACHERS_TABLE} WHERE id = $1`, [teacherId]);
        if (fetchRes.rowCount === 0) {
            await client.query('ROLLBACK');
            cleanupFiles(newProfilePhotoPath, newCvFilePath);
            return res.status(404).json({ message: 'Teacher not found.' });
        }
        const { user_id } = fetchRes.rows[0];
        oldProfilePath = fetchRes.rows[0].profile_image_path;
        oldCvPath = fetchRes.rows[0].cv_resume_path;


        // 1. Update Teacher Profile 
        let teacherUpdateFields = [
            'full_name = $1', 'designation = $2', 'email = $3', 'phone_number = $4', 
            'date_of_birth = $5', 'address = $6', 'hire_date = $7', 'is_active = $8',
            'department_id = $9', 'updated_at = CURRENT_TIMESTAMP', 'updated_by = $10'
        ];
        let teacherUpdateValues = [
            full_name, designation || null, email, phone_number || null, date_of_birth || null, address || null, hire_date || null, is_active,
            department_id || null, updated_by
        ];
        let placeholderIndex = 11;

        // Conditionally update file paths (and track if successful for old file cleanup later)
        if (newProfilePhotoPath) {
            teacherUpdateFields.push(`profile_image_path = $${placeholderIndex++}`);
            teacherUpdateValues.push(newProfilePhotoPath);
        } else {
            // Retain the old path if no new file was uploaded
            teacherUpdateFields.push(`profile_image_path = $${placeholderIndex++}`);
            teacherUpdateValues.push(oldProfilePath);
        }

        if (newCvFilePath) {
            teacherUpdateFields.push(`cv_resume_path = $${placeholderIndex++}`);
            teacherUpdateValues.push(newCvFilePath);
        } else {
             // Retain the old path if no new file was uploaded
            teacherUpdateFields.push(`cv_resume_path = $${placeholderIndex++}`);
            teacherUpdateValues.push(oldCvPath);
        }
        
        // Finalize query parameters
        const teacherUpdateQuery = `
            UPDATE ${TEACHERS_TABLE} SET
                ${teacherUpdateFields.join(', ')}
            WHERE id = $${placeholderIndex++}
            RETURNING user_id, full_name, profile_image_path, cv_resume_path;
        `;
        teacherUpdateValues.push(teacherId); // The WHERE clause ID

        const teacherResult = await client.query(teacherUpdateQuery, teacherUpdateValues);
        
        // 2. Update Linked User Account (Email, Status, and OPTIONAL Password/Role)
        if (user_id) {
            const userUpdateFields = ['email = $1', 'is_active = $2', 'phone_number = $3', 'updated_at = CURRENT_TIMESTAMP'];
            const userUpdateValues = [email, is_active, phone_number || null];
            let userPlaceholderIndex = 4;

            if (new_role) {
                userUpdateFields.push(`role = $${userPlaceholderIndex++}`);
                userUpdateValues.push(new_role);
            }
            if (password) {
                if (password.length < 6) throw new Error('New password must be at least 6 characters long.');
                const password_hash = await bcrypt.hash(password, saltRounds);
                userUpdateFields.push(`password_hash = $${userPlaceholderIndex++}`);
                userUpdateValues.push(password_hash);
            }
            
            userUpdateValues.push(user_id); // The WHERE clause ID

            const userUpdateQuery = `
                UPDATE ${USERS_TABLE} SET 
                    ${userUpdateFields.join(', ')}
                 WHERE id = $${userPlaceholderIndex}
            `;
            
            await client.query(userUpdateQuery, userUpdateValues);
        }

        await client.query('COMMIT');
        
        // 3. Cleanup OLD files after successful COMMIT
        if (newProfilePhotoPath && oldProfilePath && fs.existsSync(oldProfilePath)) fs.unlinkSync(oldProfilePath);
        if (newCvFilePath && oldCvPath && fs.existsSync(oldCvPath)) fs.unlinkSync(oldCvPath);

        res.status(200).json({ message: `Teacher ${teacherResult.rows[0].full_name} updated successfully.` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Teacher Update Error:', error);
        
        // Cleanup NEW files if transaction fails
        cleanupFiles(newProfilePhotoPath, newCvFilePath);

        let errorMessage = 'Failed to update teacher profile.';
        if (error.code === '23505') {
            errorMessage = 'Email, Employee ID, or Username already exists.';
            return res.status(409).json({ message: errorMessage });
        }
        res.status(400).json({ message: error.message || 'Update failed due to a server error.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 5. DELETE: Soft Delete Teacher (Omitted for brevity)
// =========================================================

/**
 * @route   DELETE /api/teachers/:id
 * @desc    Soft deletes teacher profile and deactivates linked user account (Transactional).
 * @access  Private (Admin, Super Admin, HR)
 */
router.delete('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const teacherId = req.params.id; // This is t.id (UUID)
    
    if (!teacherId || teacherId === 'undefined') {
        return res.status(400).json({ message: 'Invalid Teacher ID provided for deletion.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Soft Delete Teacher (Set is_active=false)
        const teacherUpdateQuery = `
            UPDATE ${TEACHERS_TABLE} SET 
                is_active = FALSE, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 
            RETURNING user_id;
        `;
        const teacherResult = await pool.query(teacherUpdateQuery, [teacherId]);

        if (teacherResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Teacher not found.' });
        }

        const { user_id } = teacherResult.rows[0];

        // 2. Deactivate Linked User Account
        if (user_id) {
            await pool.query(
                `UPDATE ${USERS_TABLE} SET 
                    is_active = FALSE, deleted_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [user_id]
            );
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Teacher and linked user deactivated successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Teacher Deletion Error:', error);
        res.status(500).json({ message: 'Failed to deactivate teacher account.' });
    } finally {
        client.release();
    }
});


module.exports = router;