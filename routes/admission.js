// routes/admission.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');

// Database Table Constants
const APPLICATIONS_TABLE = 'applications';
const APPLICATION_FEES_TABLE = 'application_fees';
const USERS_TABLE = 'users';
const COURSES_TABLE = 'courses'; // Needed for join
const BATCHES_TABLE = 'batches'; // Needed for join


// Constants
const APPLICATION_FEE_AMOUNT = 50.00; // Example fee
const APPLICATION_STATUSES = ['Draft', 'Submitted', 'Under Review', 'Accepted', 'Rejected', 'Enrolled'];
const APPROVER_ROLES = ['Super Admin', 'Admin', 'Coordinator', 'Registrar']; // Added Registrar/Coordinator for access


// =========================================================
// 1. APPLICATION SUBMISSION (POST)
// =========================================================
router.post('/apply', async (req, res) => {
    const { 
        applicant_name, applicant_email, course_id, dob, parent_name, parent_contact, batch_id // Include batch_id if mandatory
    } = req.body;

    if (!applicant_name || !applicant_email || !course_id || !dob || !parent_name) {
        return res.status(400).json({ message: 'Missing required applicant details (Name, Email, Course, DOB, Parent).' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Insert Application Record
        const applicationQuery = `
            INSERT INTO ${APPLICATIONS_TABLE} 
            (applicant_name, applicant_email, course_id, batch_id, dob, parent_name, parent_contact, status, application_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'Submitted', CURRENT_TIMESTAMP)
            RETURNING id;
        `;
        const result = await client.query(applicationQuery, [
            applicant_name, 
            applicant_email, 
            course_id, 
            batch_id || null, // Allow null if not strictly enforced at this stage
            dob, 
            parent_name, 
            parent_contact || null
        ]);
        
        const applicationId = result.rows[0].id;
        
        // 2. Insert Application Fee Requirement
        const feeQuery = `
            INSERT INTO ${APPLICATION_FEES_TABLE} 
            (application_id, amount, status)
            VALUES ($1, $2, 'Pending')
            RETURNING id AS fee_id;
        `;
        const feeResult = await client.query(feeQuery, [applicationId, APPLICATION_FEE_AMOUNT]);

        await client.query('COMMIT');
        res.status(201).json({ 
            message: 'Application submitted successfully. Fee payment is pending.', 
            application_id: applicationId,
            required_fee: APPLICATION_FEE_AMOUNT,
            fee_invoice_id: feeResult.rows[0].fee_id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Admission Application Error:', error);
        res.status(500).json({ message: 'Failed to submit application.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 2. FEE PAYMENT & STATUS UPDATE (PUT)
// =========================================================
router.put('/fee/:feeId/pay', async (req, res) => {
    const { feeId } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Update Fee Status
        const feeUpdateQuery = `
            UPDATE ${APPLICATION_FEES_TABLE} 
            SET status = 'Paid', payment_date = CURRENT_TIMESTAMP, transaction_id = $1
            WHERE id = $2 AND status = 'Pending'
            RETURNING application_id;
        `;
        const updateResult = await client.query(feeUpdateQuery, [
            req.body.transaction_id || `TRX-${new Date().getTime()}`, 
            feeId
        ]);

        if (updateResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Fee invoice not found or already paid.' });
        }
        
        const applicationId = updateResult.rows[0].application_id;

        // 2. Update Application Status
        await client.query(
            `UPDATE ${APPLICATIONS_TABLE} SET status = 'Under Review', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'Submitted'`,
            [applicationId]
        );

        await client.query('COMMIT');
        res.status(200).json({ 
            message: 'Fee payment successful. Application status updated to "Under Review".', 
            application_id: applicationId 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Fee Payment Error:', error);
        res.status(500).json({ message: 'Failed to process payment.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 3. ADMIN/COORDINATOR WORKFLOW (PUT)
// =========================================================
router.put('/review/:applicationId', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    const { applicationId } = req.params;
    const { new_status, reason } = req.body;
    // NOTE: This assumes the user ID in the token is the user_id (not userId)
    const adminId = req.user.id; 

    if (!APPLICATION_STATUSES.includes(new_status) || new_status === 'Submitted' || new_status === 'Draft') {
        return res.status(400).json({ message: 'Invalid or restricted status transition.' });
    }
    if (new_status === 'Rejected' && !reason) {
        return res.status(400).json({ message: 'Rejection reason is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch current application details
        const appRes = await client.query(
            `SELECT * FROM ${APPLICATIONS_TABLE} WHERE id = $1`, 
            [applicationId]
        );
        if (appRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Application not found.' });
        }
        const application = appRes.rows[0];

        // 2. Update Application Status
        const updateQuery = `
            UPDATE ${APPLICATIONS_TABLE} SET
                status = $1, review_notes = $2, reviewer_id = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $4 
            RETURNING applicant_name, applicant_email, status;
        `;
        const result = await client.query(updateQuery, [new_status, reason || null, adminId, applicationId]);

        // 3. SPECIAL CASE: Enrollment (Create Student/User)
        if (new_status === 'Enrolled' && application.status === 'Accepted') {
            // Check if user already exists (by email) to avoid duplicates
            let existingUser = await client.query(`SELECT id FROM ${USERS_TABLE} WHERE email = $1`, [application.applicant_email]);
            let newUserId;

            if (existingUser.rowCount === 0) {
                // Create a new User login (temporary username/password needed for Student creation)
                // NOTE: We need to use a strong default password and a generated username
                const defaultUsername = application.applicant_email.split('@')[0] + Math.floor(Math.random() * 100);
                const tempPasswordHash = '$2a$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // Placeholder hash for a temporary password

                const newUserQuery = `
                    INSERT INTO ${USERS_TABLE} (username, password_hash, email, role, date_of_birth)
                    VALUES ($1, $2, $3, 'Student', $4)
                    RETURNING id;
                `;
                const newUserResult = await client.query(newUserQuery, [
                    defaultUsername,
                    tempPasswordHash,
                    application.applicant_email,
                    application.dob
                ]);
                newUserId = newUserResult.rows[0].id;

            } else {
                newUserId = existingUser.rows[0].id;
            }
            
            // Link the user ID back to the application record and create student profile
            await client.query(`UPDATE ${APPLICATIONS_TABLE} SET user_id = $1 WHERE id = $2`, [newUserId, applicationId]);

            // *** CRITICAL STEP: Create the Student profile (assumes 'students' table is correct) ***
            // NOTE: A real Student INSERT needs many fields (roll_number, branch_id, etc.)
            await client.query(
                `INSERT INTO students (user_id, first_name, last_name, email, phone_number, dob, course_id, batch_id) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id) DO NOTHING`,
                [
                    newUserId, 
                    application.applicant_name.split(' ')[0], // First name approximation
                    application.applicant_name.split(' ').slice(-1).join(''), // Last name approximation
                    application.applicant_email,
                    application.parent_contact,
                    application.dob,
                    application.course_id,
                    application.batch_id
                ]
            );

        }


        await client.query('COMMIT');
        res.status(200).json({ 
            message: `Application status updated to "${new_status}".`, 
            application_id: applicationId,
            new_status: new_status
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Admission Review Error:', error);
        res.status(500).json({ message: 'Failed to update application status.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 4. VIEWING ROUTES (GET)
// =========================================================

/**
 * @route   GET /api/admission/applications/pending
 * @desc    Get all applications needing review ('Under Review' status).
 * @access  Private (Admin, Coordinator, Super Admin, Registrar)
 */
router.get('/applications/pending', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id, 
                a.applicant_name, 
                a.applicant_email AS contact_email,   /* Uses alias for the email expected by frontend */
                a.parent_contact AS contact_phone,   /* Uses alias for the phone expected by frontend */
                a.application_date,                  /* Column now exists in DB */
                a.status,
                a.dob,
                c.course_name,                       /* Result of join on courses */
                b.batch_name,                        /* Result of join on batches */
                af.status AS fee_status,
                af.amount AS fee_amount,
                af.id AS fee_id
            FROM ${APPLICATIONS_TABLE} a
            LEFT JOIN ${COURSES_TABLE} c ON a.course_id = c.id
            LEFT JOIN ${BATCHES_TABLE} b ON a.batch_id = b.id
            LEFT JOIN ${APPLICATION_FEES_TABLE} af ON a.id = af.application_id
            WHERE a.status IN ('Under Review', 'Submitted')
            ORDER BY a.application_date ASC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        // Log the actual SQL error for deep debugging if the crash continues
        console.error('CRASHING ADMISSION QUERY ERROR:', error);
        res.status(500).json({ message: 'Failed to retrieve pending applications.' });
    }
});

/**
 * @route   GET /api/admission/application/:applicationId
 * @desc    Get details of a specific application.
 * @access  Private (Admin, Coordinator, Super Admin, Registrar) or Public (Applicant via email token/ID)
 */
router.get('/application/:applicationId', async (req, res) => {
    const { applicationId } = req.params;
    
    // NOTE: In a secure implementation, non-admin users would need a validation token here.
    
    try {
        const query = `
            SELECT 
                a.*, 
                af.id AS fee_id,
                af.status AS fee_status,
                af.amount AS fee_amount,
                u.username AS reviewer_name
            FROM ${APPLICATIONS_TABLE} a
            LEFT JOIN ${APPLICATION_FEES_TABLE} af ON a.id = af.application_id
            LEFT JOIN ${USERS_TABLE} u ON a.reviewer_id = u.id
            WHERE a.id = $1;
        `;
        const result = await pool.query(query, [applicationId]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Application not found.' });
        }
        
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Application Details Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve application details.' });
    }
});

module.exports = router;