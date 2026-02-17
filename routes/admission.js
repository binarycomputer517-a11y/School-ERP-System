/**
 * js/routes/admission.js
 * -----------------------------
 * Manages the Student Admission Lifecycle.
 * Workflow: Submission -> Fee Payment -> Review -> Enrollment (Student Creation).
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// Database Table Constants
const APPLICATIONS_TABLE = 'applications';
const APPLICATION_FEES_TABLE = 'application_fees';
const USERS_TABLE = 'users';
const COURSES_TABLE = 'courses'; 
const BATCHES_TABLE = 'batches'; 
const STUDENTS_TABLE = 'students'; 

// Configuration Constants
const APPLICATION_FEE_AMOUNT = 50.00;
const APPLICATION_STATUSES = ['Draft', 'Submitted', 'Under Review', 'Accepted', 'Rejected', 'Enrolled'];
const APPROVER_ROLES = ['Super Admin', 'Admin', 'Coordinator', 'Registrar'];

// =========================================================
// 1. APPLICATION SUBMISSION (POST)
// =========================================================
router.post('/apply', async (req, res) => {
    const { 
        applicant_name, applicant_email, course_id, dob, parent_name, parent_contact, batch_id
    } = req.body;

    // Validate essential applicant data
    if (!applicant_name || !applicant_email || !course_id || !dob || !parent_name) {
        return res.status(400).json({ message: 'Missing required applicant details (Name, Email, Course, DOB, or Parent).' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Primary Application Record Entry
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
            batch_id || null, 
            dob, 
            parent_name, 
            parent_contact || null
        ]);
        
        const applicationId = result.rows[0].id;
        
        // 2. Generate Application Fee Invoice (Set to Pending)
        const feeQuery = `
            INSERT INTO ${APPLICATION_FEES_TABLE} 
            (application_id, amount, status)
            VALUES ($1, $2, 'Pending')
            RETURNING id AS fee_id;
        `;
        const feeResult = await client.query(feeQuery, [applicationId, APPLICATION_FEE_AMOUNT]);

        await client.query('COMMIT');
        res.status(201).json({ 
            message: 'Application submitted successfully. Processing fee is now pending.', 
            application_id: applicationId,
            required_fee: APPLICATION_FEE_AMOUNT,
            fee_invoice_id: feeResult.rows[0].fee_id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Admission Submission Registry Error:', error);
        res.status(500).json({ message: 'Failed to synchronize application with registry.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. FEE PAYMENT & STATUS SYNCHRONIZATION (PUT)
// =========================================================
router.put('/fee/:feeId/pay', async (req, res) => {
    const { feeId } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verify and Update Fee Ledger
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
            return res.status(404).json({ message: 'Fee invoice not found or already processed.' });
        }
        
        const applicationId = updateResult.rows[0].application_id;

        // 2. Escalate Application to "Under Review" post-payment
        await client.query(
            `UPDATE ${APPLICATIONS_TABLE} SET status = 'Under Review', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'Submitted'`,
            [applicationId]
        );

        await client.query('COMMIT');
        res.status(200).json({ 
            message: 'Fee payment verified. Application moved to institutional review.', 
            application_id: applicationId 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Payment Gateway Integration Error:', error);
        res.status(500).json({ message: 'Failed to process payment synchronization.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 3. ADMINISTRATIVE WORKFLOW & ENROLLMENT (PUT)
// =========================================================
router.put('/review/:applicationId', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    const { applicationId } = req.params;
    const { new_status, reason } = req.body;
    const adminId = req.user.id; 
    let newUserId = null; 

    // Validate state transition
    if (!APPLICATION_STATUSES.includes(new_status) || ['Submitted', 'Draft'].includes(new_status)) {
        return res.status(400).json({ message: 'Unauthorized or invalid status transition.' });
    }
    if (new_status === 'Rejected' && !reason) {
        return res.status(400).json({ message: 'A formal reason is required for application rejection.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const appRes = await client.query(`SELECT * FROM ${APPLICATIONS_TABLE} WHERE id = $1`, [applicationId]);
        if (appRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Target application not found in registry.' });
        }
        const application = appRes.rows[0];

        // 1. Update Decision Metadata
        const updateQuery = `
            UPDATE ${APPLICATIONS_TABLE} SET
                status = $1, review_notes = $2, reviewer_id = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $4 
            RETURNING applicant_name, applicant_email, status;
        `;
        await client.query(updateQuery, [new_status, reason || null, adminId, applicationId]);

        // 2. ENROLLMENT LOGIC: Automated Student & User Account Generation
        if (new_status === 'Enrolled' && application.status === 'Accepted') {
            
            // Validate Identity Uniqueness
            let existingUser = await client.query(`SELECT id FROM ${USERS_TABLE} WHERE email = $1`, [application.applicant_email]);
            
            if (existingUser.rowCount === 0) {
                const defaultUsername = application.applicant_email.split('@')[0] + Math.floor(Math.random() * 100);
                const tempPasswordHash = '$2a$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; 

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
            
            // Link Identity to Application
            await client.query(`UPDATE ${APPLICATIONS_TABLE} SET user_id = $1 WHERE id = $2`, [newUserId, applicationId]);

            // Synchronize Data with Students Profile Table
            await client.query(
                `INSERT INTO ${STUDENTS_TABLE} (user_id, first_name, last_name, email, phone_number, dob, course_id, batch_id) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id) DO NOTHING`,
                [
                    newUserId, 
                    application.applicant_name.split(' ')[0], 
                    application.applicant_name.split(' ').slice(-1).join(''), 
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
            message: `Application status finalized as "${new_status}".`, 
            application_id: applicationId,
            new_status: new_status,
            new_user_id: newUserId 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Institutional Review Registry Failure:', error);
        res.status(500).json({ message: 'Failed to process application status update.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 4. DATA RETRIEVAL ROUTES (GET)
// =========================================================

/**
 * Fetches all applications currently awaiting institutional review.
 */
router.get('/applications/pending', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id, 
                a.applicant_name, 
                a.applicant_email AS contact_email,   
                a.parent_contact AS contact_phone,   
                a.application_date,                  
                a.status,
                a.dob,
                c.course_name,                       
                b.batch_name,                        
                af.status AS fee_status,
                af.amount AS fee_amount,
                af.id AS fee_id
            FROM ${APPLICATIONS_TABLE} a
            /* CAST: Ensures UUID compatibility between application and reference tables */
            LEFT JOIN ${COURSES_TABLE} c ON a.course_id::uuid = c.id
            LEFT JOIN ${BATCHES_TABLE} b ON a.batch_id::uuid = b.id
            LEFT JOIN ${APPLICATION_FEES_TABLE} af ON a.id = af.application_id
            WHERE a.status IN ('Under Review', 'Submitted')
            ORDER BY a.application_date ASC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Pending Registry Retrieval Error:', error);
        res.status(500).json({ message: 'Failed to retrieve the pending application queue.' });
    }
});

/**
 * Fetches specific application details by unique identifier.
 */
router.get('/application/:applicationId', async (req, res) => {
    const { applicationId } = req.params;
    
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
            return res.status(404).json({ message: 'Application record not found.' });
        }
        
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Application Metadata Retrieval Failure:', error);
        res.status(500).json({ message: 'Failed to retrieve detailed application metadata.' });
    }
});

module.exports = router;