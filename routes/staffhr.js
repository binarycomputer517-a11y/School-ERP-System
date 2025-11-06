// routes/staffhr.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');

// Database Table Constants
const USERS_TABLE = 'users';
const DEPARTMENTS_TABLE = 'hr_departments'; 
const JOBS_TABLE = 'hr_job_postings'; 
const APPLICATIONS_TABLE = 'hr_job_applications'; 
const EMPLOYEE_DETAILS_TABLE = 'employee_pay_details'; 
const TEACHERS_TABLE = 'teachers'; 
const STAFF_TABLE = 'staff'; 

// Constants
const APPLICATION_STATUSES = ['Pending Review', 'Interview Scheduled', 'Offered', 'Hired', 'Rejected'];
const JOB_STATUSES = ['Open', 'Closed', 'Filled'];

// =========================================================
// 1. STAFF DIRECTORY & HR DETAILS (GET/PUT)
// =========================================================

/**
 * @route   GET /api/staffhr/directory
 * @desc    Get directory of all staff (Teachers & Admin).
 * @access  Private (Admin, HR)
 */
router.get('/directory', authenticateToken, authorize(['Admin', 'HR']), async (req, res) => {
    try {
        // FINAL FIX: COALESCE is used to prioritize the full name from Teacher/Staff tables, 
        // falling back to username for Admins/HR who may not have a linked profile table.
        const query = `
            SELECT 
                u.id, u.username, u.email, u.role, u.phone_number, u.department_id,
                d.name AS department_name,
                e.base_salary, e.pay_frequency,
                -- Prioritize full name from teachers, then staff, then user username
                COALESCE(t.full_name, s.first_name || ' ' || s.last_name, u.username) AS full_name_display 
            FROM ${USERS_TABLE} u
            LEFT JOIN ${DEPARTMENTS_TABLE} d ON u.department_id = d.id 
            LEFT JOIN ${EMPLOYEE_DETAILS_TABLE} e ON u.id = e.user_id
            LEFT JOIN ${TEACHERS_TABLE} t ON u.id = t.user_id 
            LEFT JOIN ${STAFF_TABLE} s ON u.id = s.user_id 
            WHERE u.role IN ('Teacher', 'Admin', 'Staff', 'HR') AND u.deleted_at IS NULL
            ORDER BY full_name_display;
        `;
        const result = await pool.query(query);
        
        // Map the result to use the correct 'full_name' key in the frontend
        const mappedResults = result.rows.map(row => ({
            ...row,
            username: row.username, 
            full_name: row.full_name_display // Frontend will use 'full_name'
        }));
        
        res.status(200).json(mappedResults);

    } catch (error) {
        console.error('Error fetching staff directory:', error);
        res.status(500).json({ message: 'Server error retrieving staff directory. Check database connection or the schema.' });
    }
});

/**
 * @route   PUT /api/staffhr/details/:userId
 * @desc    Update employee HR details (salary, department, role).
 * @access  Private (Admin, HR)
 */
router.put('/details/:userId', authenticateToken, authorize(['Admin', 'HR']), async (req, res) => {
    const { userId } = req.params;
    const { base_salary, department_id, new_role, phone_number } = req.body;
    const client = await pool.connect();
    
    // CRITICAL FIX: Convert empty string UUIDs/strings to null for PostgreSQL compatibility
    const validated_department_id = department_id === "" ? null : department_id;
    const validated_phone_number = phone_number === "" ? null : phone_number;
    
    try {
        await client.query('BEGIN');

        // 1. Update core user data (role, phone, and department_id)
        await client.query(
            `UPDATE ${USERS_TABLE} SET role = $1, phone_number = $2, department_id = $3 WHERE id = $4`, 
            [new_role, validated_phone_number, validated_department_id, userId]
        );

        // 2. Update employee pay details (salary) - INSERT or UPDATE
        await client.query(`
            INSERT INTO ${EMPLOYEE_DETAILS_TABLE} (user_id, base_salary)
            VALUES ($1, $2)
            ON CONFLICT (user_id) DO UPDATE SET base_salary = $2;
        `, [userId, base_salary]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Employee details updated successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('HR Update Error:', error);
        res.status(500).json({ message: 'Failed to update employee details.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 2. RECRUITMENT & JOB POSTINGS (POST/GET)
// =========================================================

/**
 * @route   POST /api/staffhr/jobs
 * @desc    Create a new job posting.
 * @access  Private (Admin, HR)
 */
router.post('/jobs', authenticateToken, authorize(['Admin', 'HR']), async (req, res) => {
    const { title, department_id, description, salary_range, closing_date } = req.body;
    const created_by_id = req.user.userId;

    try {
        const query = `
            INSERT INTO ${JOBS_TABLE} (title, department_id, description, salary_range, closing_date, status, created_by_id)
            VALUES ($1, $2, $3, $4, $5, 'Open', $6)
            RETURNING id;
        `;
        const result = await pool.query(query, [
            title, department_id, description, salary_range, closing_date, created_by_id
        ]);
        res.status(201).json({ message: 'Job posting created.', job_id: result.rows[0].id });
    } catch (error) {
        console.error('Job Posting Error:', error);
        res.status(500).json({ message: 'Failed to create job posting.' });
    }
});

/**
 * @route   GET /api/staffhr/jobs/all
 * @desc    Get all job postings (for HR management view).
 * @access  Private (Admin, HR)
 */
router.get('/jobs/all', authenticateToken, authorize(['Admin', 'HR']), async (req, res) => {
    try {
        const query = `
            SELECT 
                j.id, j.title, j.description, j.salary_range, j.closing_date, j.status,
                d.name AS department_name
            FROM ${JOBS_TABLE} j
            JOIN ${DEPARTMENTS_TABLE} d ON j.department_id = d.id
            ORDER BY j.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('All Jobs Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve all job postings.' });
    }
});


/**
 * @route   GET /api/staffhr/jobs/open
 * @desc    Get all active job postings (public view).
 * @access  Public
 */
router.get('/jobs/open', async (req, res) => {
    try {
        const query = `
            SELECT 
                j.id, j.title, j.description, j.salary_range, j.closing_date, j.created_at,
                d.name AS department_name
            FROM ${JOBS_TABLE} j
            JOIN ${DEPARTMENTS_TABLE} d ON j.department_id = d.id
            WHERE j.status = 'Open' AND j.closing_date >= CURRENT_DATE
            ORDER BY j.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Open Jobs Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve open jobs.' });
    }
});

// =========================================================
// 3. APPLICANT MANAGEMENT (POST/GET/PUT)
// =========================================================

/**
 * @route   POST /api/staffhr/apply/:jobId
 * @desc    Submit an application for a specific job.
 * @access  Public
 */
router.post('/apply/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const { name, email, phone, resume_url, cover_letter } = req.body;
    
    if (!name || !email || !resume_url) {
        return res.status(400).json({ message: 'Missing name, email, or resume.' });
    }

    try {
        const query = `
            INSERT INTO ${APPLICATIONS_TABLE} (job_id, applicant_name, applicant_email, applicant_phone, resume_url, cover_letter, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'Pending Review')
            RETURNING id;
        `;
        const result = await pool.query(query, [
            jobId, name, email, phone, resume_url, cover_letter || null
        ]);
        res.status(201).json({ message: 'Application submitted successfully.', application_id: result.rows[0].id });
    } catch (error) {
        console.error('Application Submission Error:', error);
        res.status(500).json({ message: 'Failed to submit application.' });
    }
});

/**
 * @route   GET /api/staffhr/applicants/:jobId
 * @desc    Get all applicants for a specific job posting.
 * @access  Private (Admin, HR)
 */
router.get('/applicants/:jobId', authenticateToken, authorize(['Admin', 'HR']), async (req, res) => {
    const { jobId } = req.params;
    try {
        const query = `
            SELECT *
            FROM ${APPLICATIONS_TABLE}
            WHERE job_id = $1
            ORDER BY status, created_at DESC;
        `;
        const result = await pool.query(query, [jobId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Applicant Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve applicants.' });
    }
});

/**
 * @route   PUT /api/staffhr/applicants/:applicationId/status
 * @desc    Update an applicant's status.
 * @access  Private (Admin, HR)
 */
router.put('/applicants/:applicationId/status', authenticateToken, authorize(['Admin', 'HR']), async (req, res) => {
    const { applicationId } = req.params;
    const { new_status, notes } = req.body;

    if (!APPLICATION_STATUSES.includes(new_status)) {
         return res.status(400).json({ message: 'Invalid status provided.' });
    }

    try {
        const query = `
            UPDATE ${APPLICATIONS_TABLE} SET status = $1, notes = $2
            WHERE id = $3
            RETURNING id, status;
        `;
        const result = await pool.query(query, [new_status, notes || null, applicationId]);
        
        if (result.rowCount === 0) {
             return res.status(404).json({ message: 'Application not found.' });
        }
        res.status(200).json({ message: `Status updated to ${new_status}.`, new_status });

    } catch (error) {
        console.error('Applicant Status Update Error:', error);
        res.status(500).json({ message: 'Failed to update applicant status.' });
    }
});


// =========================================================
// 4. UTILITY ROUTES
// =========================================================

/**
 * @route   GET /api/staffhr/departments
 * @desc    Get list of all HR departments.
 * @access  Private (Admin, HR)
 */
router.get('/departments', authenticateToken, authorize(['Admin', 'HR']), async (req, res) => {
    try {
        const query = `SELECT id, name FROM ${DEPARTMENTS_TABLE} ORDER BY name;`;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Departments Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve department list.' });
    }
});


module.exports = router;