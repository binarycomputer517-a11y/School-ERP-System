const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const { toUUID } = require('../utils/helpers'); // Assuming helper import is fixed

// --- Configuration ---
const JOBS_TABLE = 'job_postings';
const COMPANIES_TABLE = 'companies';
const PLACEMENTS_TABLE = 'placements';
const STUDENTS_TABLE = 'students'; 

// Roles for management actions (lowercase for compatibility)
const MANAGEMENT_ROLES = ['super admin', 'admin', 'placement officer'];

// Roles for viewing data (All relevant parties)
const VIEWER_ROLES = [...MANAGEMENT_ROLES, 'student', 'teacher', 'coordinator'];


// =========================================================
// 1. COMPANY MANAGEMENT (CRUD)
// =========================================================

/**
 * @route POST /api/placements/companies - Create
 */
router.post('/companies', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
// ... (No change - Restricted to Management)
    const { company_name, industry, website, contact_person, contact_email } = req.body;
    if (!company_name) return res.status(400).json({ message: 'Company name is required.' });

    try {
        const query = `
            INSERT INTO ${COMPANIES_TABLE} (company_name, industry, website, contact_person, contact_email)
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id, company_name;
        `;
        const result = await pool.query(query, [company_name, industry, website, contact_person, contact_email]);
        res.status(201).json({ message: 'Company added successfully.', company: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'A company with this name already exists.' });
        console.error('Error adding company:', err);
        res.status(500).json({ message: 'Server error while adding company.' });
    }
});

/**
 * @route GET /api/placements/companies - Read All
 */
// FIX: Open to all viewer roles
router.get('/companies', authenticateToken, authorize(VIEWER_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, company_name, industry, website, contact_person, contact_email, created_at
            FROM ${COMPANIES_TABLE} ORDER BY company_name
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching companies:', err);
        res.status(500).json({ message: 'Server error while fetching companies.' });
    }
});

/**
 * @route PUT /api/placements/companies/:id - Update 
 */
router.put('/companies/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
// ... (No change - Restricted to Management)
    const companyId = toUUID(req.params.id);
    const { company_name, industry, website, contact_person, contact_email } = req.body;
    if (!companyId) return res.status(400).json({ message: 'Invalid Company ID.' });

    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (company_name) { fields.push(`company_name = $${paramIndex++}`); values.push(company_name); }
    if (industry) { fields.push(`industry = $${paramIndex++}`); values.push(industry); }
    if (website) { fields.push(`website = $${paramIndex++}`); values.push(website); }
    if (contact_person) { fields.push(`contact_person = $${paramIndex++}`); values.push(contact_person); }
    if (contact_email) { fields.push(`contact_email = $${paramIndex++}`); values.push(contact_email); }

    if (fields.length === 0) return res.status(400).json({ message: 'No fields provided for update.' });

    const query = `
        UPDATE ${COMPANIES_TABLE} SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramIndex}::uuid 
        RETURNING id, company_name;
    `;
    values.push(companyId);

    try {
        const result = await pool.query(query, values);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Company not found.' });
        res.status(200).json({ message: 'Company updated successfully.', company: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Duplicate company name.' });
        console.error('Error updating company:', err);
        res.status(500).json({ message: 'Server error during update.' });
    }
});

/**
 * @route DELETE /api/placements/companies/:id - Delete (Cascade Delete Jobs)
 */
router.delete('/companies/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
// ... (No change - Restricted to Management)
    const companyId = toUUID(req.params.id);
    if (!companyId) return res.status(400).json({ message: 'Invalid Company ID.' });

    try {
        // NOTE: ON DELETE CASCADE constraint on job_postings table handles associated jobs.
        const result = await pool.query(`DELETE FROM ${COMPANIES_TABLE} WHERE id = $1::uuid`, [companyId]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Company not found.' });
        res.status(200).json({ message: 'Company and associated jobs/records deleted successfully.' });
    } catch (err) {
        console.error('Error deleting company:', err);
        res.status(500).json({ message: 'Server error during deletion.' });
    }
});


// =========================================================
// 2. JOB POSTING MANAGEMENT (CRUD)
// =========================================================

/**
 * @route POST /api/placements/jobs - Create
 */
router.post('/jobs', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
// ... (No change - Restricted to Management)
    const { company_id, job_title, description, salary_package, drive_date, status = 'Open' } = req.body;

    if (!company_id || !job_title || !drive_date) {
        return res.status(400).json({ message: 'Company ID, job title, and drive date are required.' });
    }

    try {
        const query = `
            INSERT INTO ${JOBS_TABLE} (company_id, job_title, description, salary_package, drive_date, status)
            VALUES ($1::uuid, $2, $3, $4, $5::date, $6) 
            RETURNING id, job_title;
        `;
        const result = await pool.query(query, [toUUID(company_id), job_title, description, salary_package, drive_date, status]);
        
        res.status(201).json({ message: 'Job posting added successfully.', job: result.rows[0] });

    } catch (err) {
        console.error('Error adding job posting:', err);
        res.status(500).json({ message: 'Server error while adding job posting.' });
    }
});

/**
 * @route GET /api/placements/jobs - Read All
 */
// FIX: Open to all viewer roles
router.get('/jobs', authenticateToken, authorize(VIEWER_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                j.id, j.job_title, j.description, j.salary_package, j.drive_date, j.status,
                c.company_name, c.id AS company_id
            FROM ${JOBS_TABLE} j
            JOIN ${COMPANIES_TABLE} c ON j.company_id = c.id
            ORDER BY j.drive_date DESC
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching jobs:', err);
        res.status(500).json({ message: 'Server error while fetching jobs.' });
    }
});

/**
 * @route PUT /api/placements/jobs/:id - Update
 */
router.put('/jobs/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
// ... (No change - Restricted to Management)
    const jobId = toUUID(req.params.id);
    const { company_id, job_title, description, salary_package, drive_date, status } = req.body;
    if (!jobId) return res.status(400).json({ message: 'Invalid Job ID.' });

    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (company_id) { fields.push(`company_id = $${paramIndex++}::uuid`); values.push(toUUID(company_id)); }
    if (job_title) { fields.push(`job_title = $${paramIndex++}`); values.push(job_title); }
    if (description) { fields.push(`description = $${paramIndex++}`); values.push(description); }
    if (salary_package) { fields.push(`salary_package = $${paramIndex++}`); values.push(salary_package); }
    if (drive_date) { fields.push(`drive_date = $${paramIndex++}::date`); values.push(drive_date); }
    if (status) { fields.push(`status = $${paramIndex++}`); values.push(status); }

    if (fields.length === 0) return res.status(400).json({ message: 'No fields provided for update.' });

    const query = `
        UPDATE ${JOBS_TABLE} SET ${fields.join(', ')}
        WHERE id = $${paramIndex}::uuid 
        RETURNING id, job_title;
    `;
    values.push(jobId);

    try {
        const result = await pool.query(query, values);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Job posting not found.' });
        res.status(200).json({ message: 'Job posting updated successfully.', job: result.rows[0] });
    } catch (err) {
        console.error('Error updating job posting:', err);
        res.status(500).json({ message: 'Server error during update.' });
    }
});

/**
 * @route DELETE /api/placements/jobs/:id - Delete
 */
router.delete('/jobs/:id', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
// ... (No change - Restricted to Management)
    const jobId = toUUID(req.params.id);
    if (!jobId) return res.status(400).json({ message: 'Invalid Job ID.' });

    try {
        // NOTE: This will cascade delete associated placement records due to FK constraints.
        const result = await pool.query(`DELETE FROM ${JOBS_TABLE} WHERE id = $1::uuid`, [jobId]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Job posting not found.' });
        res.status(200).json({ message: 'Job posting deleted successfully.' });
    } catch (err) {
        console.error('Error deleting job posting:', err);
        res.status(500).json({ message: 'Server error during deletion.' });
    }
});


// =========================================================
// 3. PLACEMENT RECORD MANAGEMENT (C-R)
// =========================================================

/**
 * @route POST /api/placements/record - Create/Update Record
 */
router.post('/record', authenticateToken, authorize(MANAGEMENT_ROLES), async (req, res) => {
// ... (No change - Restricted to Management)
    const { student_id, job_id, offer_status } = req.body;
    
    if (!student_id || !job_id || !offer_status) {
        return res.status(400).json({ message: 'Student ID, Job ID, and Offer Status are required.' });
    }

    try {
        const query = `
            INSERT INTO ${PLACEMENTS_TABLE} (student_id, job_id, offer_status) 
            VALUES ($1::uuid, $2::uuid, $3) 
            ON CONFLICT (student_id, job_id) 
            DO UPDATE SET 
                offer_status = EXCLUDED.offer_status,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, offer_status;
        `;
        const result = await pool.query(query, [toUUID(student_id), toUUID(job_id), offer_status]);
        
        res.status(201).json({ 
            message: 'Placement recorded successfully.',
            record: result.rows[0]
        });
    } catch (err) {
        if (err.code === '23503') return res.status(400).json({ message: 'Invalid Student ID or Job ID.' });
        console.error('Error recording placement:', err);
        res.status(500).json({ message: 'Server error while recording placement.' });
    }
});

/**
 * @route GET /api/placements/records - Read All Records
 */
// FIX: Open to all viewer roles
router.get('/records', authenticateToken, authorize(VIEWER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                p.offer_status,
                (s.first_name || ' ' || s.last_name) AS student_name,
                j.job_title,
                c.company_name
            FROM ${PLACEMENTS_TABLE} p
            JOIN ${STUDENTS_TABLE} s ON p.student_id = s.student_id
            JOIN ${JOBS_TABLE} j ON p.job_id = j.id
            JOIN ${COMPANIES_TABLE} c ON j.company_id = c.id
            ORDER BY p.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching placement records:', err);
        res.status(500).json({ message: 'Server error while fetching placement records.' });
    }
});

module.exports = router;