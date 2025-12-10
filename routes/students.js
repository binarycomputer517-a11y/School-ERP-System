// routes/students.js
// TRUE FULL & FINAL VERSION WITH MULTER INTEGRATION

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const bcrypt = require('bcryptjs');
const saltRounds = 10;
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment'); 
const { getApp } = require('../utils/helpers'); // Assuming a helper to get app instance (or use req.app)

// --- Constants: Database Tables ---
const STUDENTS_TABLE = 'students';
const USERS_TABLE = 'users';
const BRANCHES_TABLE = 'branches';
const COURSES_TABLE = 'courses';
const BATCHES_TABLE = 'batches';
const FEE_STRUCTURES_TABLE = 'fee_structures'; 
const INVOICES_TABLE = 'student_invoices'; 
const PAYMENTS_TABLE = 'fee_payments';     

// --- Constants: Access Control ---
const CRUD_ROLES = ['Super Admin', 'Admin', 'HR', 'Registrar'];
const VIEW_ROLES = ['Super Admin', 'Admin', 'HR', 'Registrar', 'Teacher', 'Coordinator', 'Student'];

// --- Helper Functions (getConfigIds, toUUID, buildUpdateQuery remain the same) ---
function getConfigIds(req) {
    const branch_id = req.user.branch_id; 
    return { branch_id, created_by: req.user.id, updated_by: req.user.id };
}

function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    return value.trim();
}

function buildUpdateQuery(body, fieldDefinitions, updatedBy) {
    const updateFields = [];
    const updateValues = [];
    let paramIndex = 1;
    
    for (const field in fieldDefinitions) {
        if (body.hasOwnProperty(field)) {
            let value = body[field];
            const type = fieldDefinitions[field];
            
            if (value === null || value === '') {
                value = null;
            } else if (type === 'uuid') {
                value = toUUID(value);
            }
            
            const cast = type === 'uuid' ? '::uuid' : (type === 'date' ? '::date' : '');
            updateFields.push(`${field} = $${paramIndex++}${cast}`);
            updateValues.push(value);
        }
    }
    
    updateFields.push(`updated_by = $${paramIndex++}::uuid`);
    updateValues.push(toUUID(updatedBy));
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

    return { updateFields, updateValues };
}


// =========================================================
// 1. GET: Main Student List (Optimized for Dashboard)
// =========================================================
router.get('/', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, s.admission_id, s.enrollment_no, s.first_name, s.last_name, 
                s.email, s.phone_number, s.status, s.course_id, s.batch_id,
                u.username, u.role, u.id AS user_id,
                c.course_name, b.batch_name, br.branch_name,
                
                (
                    COALESCE(fs.admission_fee, 0) + COALESCE(fs.registration_fee, 0) + COALESCE(fs.examination_fee, 0)
                    +
                    (
                        (COALESCE(fs.transport_fee, 0) * COALESCE(fs.course_duration_months, 0)) 
                        + 
                        (COALESCE(fs.hostel_fee, 0) * COALESCE(fs.course_duration_months, 0))
                    )
                ) AS total_fees_due,
                fs.structure_name AS fee_structure_name
                
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${USERS_TABLE} u ON s.user_id = u.id
            LEFT JOIN ${COURSES_TABLE} c ON s.course_id = c.id
            LEFT JOIN ${BATCHES_TABLE} b ON s.batch_id = b.id
            LEFT JOIN ${BRANCHES_TABLE} br ON s.branch_id = br.id
            LEFT JOIN ${FEE_STRUCTURES_TABLE} fs ON fs.course_id = s.course_id AND fs.batch_id = s.batch_id
            
            WHERE u.deleted_at IS NULL
            ORDER BY s.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching students list:', error);
        res.status(500).json({ message: 'Failed to retrieve students list.' });
    }
});

// =========================================================
// 2. POST: Create New Student (CRITICAL FIX: Multer Integration)
// =========================================================
router.post('/', authenticateToken, authorize(CRUD_ROLES), (req, res, next) => {
    // 1. Get Multer instance from the Express app instance (attached in server.js)
    const upload = req.app.get('upload'); 

    if (!upload) {
        console.error("Multer instance not found. Cannot proceed with file upload.");
        return res.status(500).json({ message: "File upload service is unavailable. Check server config." });
    }
    
    // 2. Use Multer middleware for a single file upload
    // 'profile_image' is the expected field name from the frontend form (adjust if needed)
    upload.single('profile_image_path')(req, res, (err) => {
        if (err) {
            console.error('Multer Upload Error:', err);
            // Handle Multer limits (e.g., specific file size limits set in multerConfig.js)
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ message: 'The uploaded file exceeds the file size limit.' });
            }
            return res.status(500).json({ message: 'File upload failed: ' + err.message });
        }
        // Proceed to the next middleware (the asynchronous controller logic)
        next(); 
    });
}, async (req, res) => { // Actual controller logic
    let body = req.body;
    
    const { branch_id, created_by } = getConfigIds(req);

    // 🚨 Add uploaded file path to the body for database insertion
    if (req.file) {
        // req.file.path contains the path where Multer saved the file (e.g., 'uploads/...')
        body.profile_image_path = req.file.path; 
    }

    // Validation
    if (!body.username || !body.password || !body.first_name || !body.last_name || !body.course_id || !body.batch_id) {
        // NOTE: If file upload is successful, req.body contains text fields
        return res.status(400).json({ message: 'Missing required fields: Name, Login, Course, or Batch.' });
    }

    const client = await pool.connect();
    
    try {
        await client.query('BEGIN'); // Start Transaction

        // --- A. Auto-Generate Enrollment/Admission IDs ---
        if (!body.enrollment_no) {
            const year = new Date().getFullYear();
            const countRes = await client.query(`SELECT COUNT(*) FROM ${STUDENTS_TABLE}`);
            const nextNum = parseInt(countRes.rows[0].count) + 1;
            body.enrollment_no = `STU-${year}-${String(nextNum).padStart(4, '0')}`;
        }
        if (!body.admission_id) {
            const uniqueSuffix = Math.floor(Math.random() * 900000) + 100000;
            body.admission_id = `ADMN-${uniqueSuffix}`;
        }
        
        // --- B. Fetch Active Academic Session (Fallback safety) ---
        let academic_session_id = toUUID(body.academic_session_id);
        if (!academic_session_id) {
            const sessionRes = await client.query("SELECT id FROM academic_sessions WHERE is_active = TRUE LIMIT 1");
            if (sessionRes.rowCount > 0) {
                academic_session_id = sessionRes.rows[0].id;
            } else {
                const anySession = await client.query("SELECT id FROM academic_sessions LIMIT 1");
                academic_session_id = anySession.rowCount > 0 ? anySession.rows[0].id : null;
            }
        }

        // --- C. Create User Login ---
        const password_hash = await bcrypt.hash(body.password, saltRounds);
        const safeBranchId = toUUID(branch_id);

        const userQuery = `
            INSERT INTO ${USERS_TABLE} (username, password_hash, role, email, phone_number, branch_id)
            VALUES ($1, $2, 'Student', $3, $4, $5::uuid)
            RETURNING id;
        `;
        const userResult = await client.query(userQuery, [body.username, password_hash, body.email, body.phone_number || null, safeBranchId]);
        const newUserId = userResult.rows[0].id;

        // --- D. Create Student Profile ---
        const studentQuery = `
            INSERT INTO ${STUDENTS_TABLE} (
                user_id, first_name, last_name, middle_name, email, phone_number, 
                dob, gender, permanent_address, course_id, batch_id, branch_id,
                created_by, admission_id, academic_session_id, enrollment_no,
                profile_image_path, signature_path, id_document_path, aadhaar_number, nationality,
                city, state, zip_code, country, religion, blood_group, caste_category,
                parent_first_name, parent_last_name, parent_phone_number, parent_email, parent_occupation, guardian_relation,
                admission_date
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8, $9, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14, $15::uuid, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35::date)
            RETURNING student_id, first_name, last_name, enrollment_no;
        `;
        
        const studentResult = await client.query(studentQuery, [
            newUserId, body.first_name, body.last_name, body.middle_name || null, body.email, body.phone_number || null,
            body.dob || null, body.gender || null, body.permanent_address || null, toUUID(body.course_id), toUUID(body.batch_id), safeBranchId,
            toUUID(created_by), body.admission_id, academic_session_id, body.enrollment_no,
            body.profile_image_path || null, body.signature_path || null, body.id_document_path || null, body.aadhaar_number || null, body.nationality || null,
            body.city || null, body.state || null, body.zip_code || null, body.country || null, body.religion || null, body.blood_group || null, body.caste_category || null,
            body.parent_first_name || null, body.parent_last_name || null, body.parent_phone_number || null, body.parent_email || null, body.parent_occupation || null, body.guardian_relation || null,
            body.admission_date || moment().format('YYYY-MM-DD') // Default admission date
        ]);

        await client.query('COMMIT'); // Commit Transaction
        
        res.status(201).json({ 
            message: 'Student created successfully.', 
            student: studentResult.rows[0],
            admission_id: body.admission_id, 
            enrollment_no: body.enrollment_no
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Fail Safe
        console.error('Student Creation Error:', error);
        
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Duplicate Data: Username, Email, or Enrollment No already exists.' });
        }
        res.status(500).json({ message: 'Failed to create student profile.', error: error.message });
    } finally {
        client.release();
    }
});


// ... (Routes 3, 4, 5, 6, 7, 8, 9 remain exactly the same as they do not require file uploads) ...


// =========================================================
// 3. GET: Single Student Details (Smart Lookup)
// =========================================================
router.get('/:id', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const idParam = req.params.id;
    const safeId = toUUID(idParam);

    if (!safeId) return res.status(400).json({ message: 'Invalid ID format.' });

    try {
        const query = `
            SELECT s.*, u.username, u.role
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${USERS_TABLE} u ON s.user_id = u.id
            WHERE s.student_id = $1::uuid OR s.user_id = $1::uuid;
        `;
        const result = await pool.query(query, [safeId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching student details:', error);
        res.status(500).json({ message: 'Failed to retrieve student details.' });
    }
});

// =========================================================
// 4. PUT: Update Student (IMPROVED DYNAMIC UPDATE)
// =========================================================
router.put('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    // NOTE: If PUT includes file updates, you would need Multer here too, 
    // but the logic here assumes only standard form data update.
    const studentId = req.params.id;
    const body = req.body;
    const { updated_by } = getConfigIds(req);

    const safeStudentId = toUUID(studentId);
    const safeUpdatedBy = toUUID(updated_by);

    if (!safeStudentId) {
        return res.status(400).json({ message: 'Invalid Student ID format.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // --- Step 1: Update USERS table (for login/contact details) ---
        if (body.user_id) {
            const userId = toUUID(body.user_id);
            const userUpdateFields = [];
            const userUpdateValues = [];
            let userParamIndex = 1;

            if (body.email !== undefined) {
                 userUpdateFields.push(`email = $${userParamIndex++}`);
                 userUpdateValues.push(body.email);
            }
            if (body.phone_number !== undefined) {
                 userUpdateFields.push(`phone_number = $${userParamIndex++}`);
                 userUpdateValues.push(body.phone_number);
            }
            if (body.password) { // Only update password if a new one is provided
                 const password_hash = await bcrypt.hash(body.password, saltRounds);
                 userUpdateFields.push(`password_hash = $${userParamIndex++}`);
                 userUpdateValues.push(password_hash);
            }

            if (userUpdateFields.length > 0) {
                userUpdateFields.push(`updated_at = CURRENT_TIMESTAMP`);
                userUpdateValues.push(userId); 
                
                const userUpdateQuery = `
                    UPDATE ${USERS_TABLE} SET 
                        ${userUpdateFields.join(', ')} 
                    WHERE id = $${userParamIndex}::uuid AND role = 'Student'
                    RETURNING email;
                `;
                await client.query(userUpdateQuery, userUpdateValues);
            }
        }

        // --- Step 2: Update STUDENT Profile ---
        const studentFieldDefinitions = {
            first_name: 'text', last_name: 'text', middle_name: 'text', 
            dob: 'date', gender: 'text', blood_group: 'text', religion: 'text', mother_tongue: 'text',
            aadhaar_number: 'text', caste_category: 'text', nationality: 'text',
            permanent_address: 'text', city: 'text', state: 'text', zip_code: 'text', country: 'text', 
            enrollment_no: 'text', roll_number: 'text', status: 'text',
            academic_session_id: 'uuid', course_id: 'uuid', batch_id: 'uuid',
            parent_first_name: 'text', parent_last_name: 'text', parent_phone_number: 'text',
            parent_email: 'text', parent_occupation: 'text', guardian_relation: 'text',
            parent_annual_income: 'numeric',
            profile_image_path: 'text', signature_path: 'text', id_document_path: 'text', // Included for update
            location_coords: 'text',
            admission_date: 'date' 
        };
        
        const { updateFields, updateValues } = buildUpdateQuery(body, studentFieldDefinitions, safeUpdatedBy);

        if (updateFields.length === 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: 'No fields provided for update.' });
        }

        const paramIndexAfterFields = updateValues.length + 1;
        
        const studentUpdateQuery = `
            UPDATE ${STUDENTS_TABLE} SET
                ${updateFields.join(', ')}
            WHERE student_id = $${paramIndexAfterFields}::uuid
            RETURNING first_name, last_name, admission_id; 
        `;
        
        updateValues.push(safeStudentId);

        const result = await client.query(studentUpdateQuery, updateValues);

        if (result.rowCount === 0) {
             await client.query('ROLLBACK');
             return res.status(404).json({ message: 'Update failed: Student not found or no changes made.' });
        }

        await client.query('COMMIT');
        
        res.status(200).json({ 
            message: 'Student profile updated successfully.',
            first_name: result.rows[0].first_name, 
            data: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Update Error:', error);
        
        if (error.code === '23505') {
            return res.status(409).json({ message: 'Duplicate Data: Email, Phone, or Enrollment No already exists.' });
        }
        res.status(500).json({ message: 'Failed to update student profile.', error: error.message });
    } finally {
        client.release();
    }
});

// =========================================================
// 5. DELETE: Soft Delete Student
// =========================================================
router.delete('/:id', authenticateToken, authorize(CRUD_ROLES), async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) return res.status(400).json({ message: 'Invalid Student ID.' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if student exists
        const getRes = await client.query(`SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1::uuid`, [safeStudentId]);
        if (getRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Student not found.' });
        }
        const userId = getRes.rows[0].user_id;

        // Soft Delete Student
        await client.query(
            `UPDATE ${STUDENTS_TABLE} SET status = 'Inactive', deleted_at = CURRENT_TIMESTAMP WHERE student_id = $1::uuid`, 
            [safeStudentId]
        );

        // Soft Delete User Login
        if (userId) {
            await client.query(
                `UPDATE ${USERS_TABLE} SET is_active = FALSE, deleted_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`, 
                [userId]
            );
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Student deactivated successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Student Deletion Error:', error);
        res.status(500).json({ message: 'Failed to deactivate student.', error: error.message });
    } finally {
        client.release();
    }
});


// =========================================================
// 6. GET: Student Fee Records (FINAL FIX)
// =========================================================
router.get('/:id/fees', authenticateToken, async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) return res.status(400).json({ message: 'Invalid Student ID.' });

    try {
        // --- STEP 1: Fetch Summary Data (Total Billed / Paid / Due) ---
        const summaryQuery = `
            SELECT
                COALESCE(SUM(i.total_amount), 0) AS total_billed,
                COALESCE(SUM(i.paid_amount), 0) AS total_paid,
                (COALESCE(SUM(i.total_amount), 0) - COALESCE(SUM(i.paid_amount), 0)) AS balance_due
            FROM ${INVOICES_TABLE} i
            WHERE i.student_id = $1::uuid AND i.status != 'Waived';
        `;
        
        const summaryResult = await pool.query(summaryQuery, [safeStudentId]);
        let summary = summaryResult.rows[0] || { total_billed: 0, total_paid: 0, balance_due: 0 };

        // --- STEP 2: Fetch Detailed Payment History ---
        const historyQuery = `
            SELECT 
                p.id,
                p.amount,
                p.payment_date,
                p.payment_mode AS mode,
                p.transaction_id AS ref,
                pi.invoice_number,
                pi.due_date
            FROM ${PAYMENTS_TABLE} p
            JOIN ${INVOICES_TABLE} pi ON p.invoice_id = pi.id
            WHERE pi.student_id = $1::uuid
            ORDER BY p.payment_date DESC;
        `;
        
        const historyResult = await pool.query(historyQuery, [safeStudentId]);

        // --- STEP 3: Combine and Send Response ---
        const finalResponse = {
            ...summary,
            payment_history: historyResult.rows 
        };
        
        res.status(200).json(finalResponse);
        
    } catch (error) {
        console.error('Error fetching fees for profile:', error);
        res.status(500).json({ message: 'Failed to retrieve fee records for profile.' });
    }
});


// =========================================================
// 7. GET: Library Books (Dashboard/Profile Support)
// =========================================================
router.get('/:id/library', authenticateToken, async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) return res.status(400).json({ message: 'Invalid Student ID.' });

    try {
        const query = `
            SELECT * FROM library_transactions 
            WHERE student_id = $1::uuid AND status = 'Issued'
            ORDER BY issue_date DESC;
        `;
        try {
            const result = await pool.query(query, [safeStudentId]);
            res.status(200).json(result.rows);
        } catch (dbError) {
            console.warn("Library table might not exist yet:", dbError.message);
            res.status(200).json([]); 
        }
    } catch (error) {
        console.error('Error fetching library books:', error);
        res.status(500).json({ message: 'Failed to retrieve library records.' });
    }
});

// =========================================================
// 8. GET: My Teachers (Dashboard/Profile Support)
// =========================================================
router.get('/:id/teachers', authenticateToken, authorize(VIEW_ROLES), async (req, res) => {
    const studentId = req.params.id;
    const safeStudentId = toUUID(studentId);

    try {
        const query = `
            SELECT 
                t.full_name, s.subject_name, t.email
            FROM teacher_allocations ta
            JOIN teachers t ON ta.teacher_id = t.id
            JOIN subjects s ON ta.subject_id = s.id
            JOIN students stu ON stu.batch_id = ta.batch_id
            WHERE stu.student_id = $1::uuid;
        `;
        try {
            const result = await pool.query(query, [safeStudentId]);
            res.status(200).json(result.rows);
        } catch (dbError) {
            console.warn("Teacher query failed:", dbError.message);
            res.status(200).json([]); 
        }
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ message: 'Failed to retrieve teachers.' });
    }
});

// =========================================================
// 9. GET: Student Lookup (FIXED SYNTAX)
// =========================================================

/**
 * @route GET /api/students/lookup/all
 */
router.get('/lookup/all', authenticateToken, authorize(['Admin', 'Super Admin', 'Teacher', 'Placement Officer']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                s.student_id AS id, 
                (s.first_name || ' ' || s.last_name) AS display_name,
                s.roll_number
            FROM students s
            WHERE s.status = 'Enrolled'
            ORDER BY s.last_name, s.first_name;
        `);
        
        res.status(200).json(result.rows);
    } catch (e) { 
        console.error('Error fetching student lookup data:', e);
        res.status(500).json({ message: 'Failed to retrieve student list for dropdowns.' });
    }
});

module.exports = router;