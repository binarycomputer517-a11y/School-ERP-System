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

// Constants
const APPLICATION_FEE_AMOUNT = 50.00; // Example fee
const APPLICATION_STATUSES = ['Draft', 'Submitted', 'Under Review', 'Accepted', 'Rejected', 'Enrolled'];
const APPROVER_ROLES = ['Super Admin', 'Admin', 'Coordinator']; // Roles authorized for review/enrollment


// =========================================================
// 1. APPLICATION SUBMISSION (POST)
// =========================================================

/**
 * @route   POST /api/admission/apply
 * @desc    Submit a new admission application (Public/Guest or Student/Teacher for self-enrollment).
 * @access  Public (No authentication required for initial application)
 */
router.post('/apply', async (req, res) => {
    // Assuming the application can be submitted without a pre-existing user account,
    // only basic application data is required initially.
    const { 
        applicant_name, 
        applicant_email, 
        course_id, 
        dob, 
        parent_name, 
        parent_contact 
    } = req.body;

    if (!applicant_name || !applicant_email || !course_id || !dob || !parent_name) {
        return res.status(400).json({ message: 'Missing required applicant details.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Insert Application Record
        const applicationQuery = `
            INSERT INTO ${APPLICATIONS_TABLE} 
            (applicant_name, applicant_email, course_id, dob, parent_name, parent_contact, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'Submitted')
            RETURNING id;
        `;
        const result = await client.query(applicationQuery, [
            applicant_name, 
            applicant_email, 
            course_id, 
            dob, 
            parent_name, 
            parent_contact
        ]);
        
        const applicationId = result.rows[0].id;
        
        // 2. Insert Application Fee Requirement (Simulates an invoice/pending payment)
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

/**
 * @route   PUT /api/admission/fee/:feeId/pay
 * @desc    Simulate/Record successful payment of the application fee.
 * @access  Public (The payment gateway callback would hit this, or Admin manually marks it)
 */
router.put('/fee/:feeId/pay', async (req, res) => {
    const { feeId } = req.params;
    // In a real system, you would check req.body for payment gateway details (transaction ID, method, etc.)

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

        // 2. Update Application Status (e.g., to 'Under Review' once fee is processed)
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

/**
 * @route   PUT /api/admission/review/:applicationId
 * @desc    Change application status (Accept/Reject/Enroll).
 * @access  Private (Admin, Coordinator, Super Admin)
 */
router.put('/review/:applicationId', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    const { applicationId } = req.params;
    const { new_status, reason } = req.body;
    const adminId = req.user.userId;

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

        // 3. SPECIAL CASE: Enrollment (Acceptance to final user creation)
        if (new_status === 'Enrolled' && application.status === 'Accepted') {
            // This is the integration point: Create a new user account (student)
            // NOTE: In a real system, you would check for duplicates and set a temp password.
            const newUserQuery = `
                INSERT INTO ${USERS_TABLE} (username, email, role, date_of_birth, created_by)
                VALUES ($1, $2, 'Student', $3, $4)
                RETURNING id;
            `;
            const newUserResult = await client.query(newUserQuery, [
                application.applicant_name,
                application.applicant_email,
                application.dob,
                adminId
            ]);
            
            const newUserId = newUserResult.rows[0].id;
            
            // Link the new user ID back to the application record (optional but good practice)
            await client.query(`UPDATE ${APPLICATIONS_TABLE} SET user_id = $1 WHERE id = $2`, [newUserId, applicationId]);
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
 * @access  Private (Admin, Coordinator, Super Admin)
 */
router.get('/applications/pending', authenticateToken, authorize(APPROVER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id, a.applicant_name, a.applicant_email, a.course_id, a.dob, a.parent_name, 
                a.created_at, a.status, 
                af.status AS fee_status,
                af.amount AS fee_amount,
                af.id AS fee_id
            FROM ${APPLICATIONS_TABLE} a
            LEFT JOIN ${APPLICATION_FEES_TABLE} af ON a.id = af.application_id
            WHERE a.status IN ('Under Review', 'Submitted')
            ORDER BY a.created_at ASC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Pending Applications Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve pending applications.' });
    }
});

/**
 * @route   GET /api/admission/application/:applicationId
 * @desc    Get details of a specific application.
 * @access  Private (Admin, Coordinator, Super Admin) or Public (Applicant via email token/ID)
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