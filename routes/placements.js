const express = require('express');
const router = express.Router();
const pool = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// POST /api/placements/companies - Add a new company
router.post('/companies', authenticateToken, authorize('Admin'), async (req, res) => {
    const { company_name, industry, website, contact_person } = req.body;
    try {
        await pool.query(
            "INSERT INTO companies (company_name, industry, website, contact_person) VALUES ($1, $2, $3, $4)",
            [company_name, industry, website, contact_person]
        );
        res.status(201).send('Company added successfully');
    } catch (err) {
        console.error('Error adding company:', err);
        res.status(500).send('Server error');
    }
});

// GET /api/placements/companies - Get all companies
router.get('/companies', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM companies ORDER BY company_name');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching companies:', err);
        res.status(500).send('Server error');
    }
});

// POST /api/placements/jobs - Add a new job posting
router.post('/jobs', authenticateToken, authorize('Admin'), async (req, res) => {
    const { company_id, job_title, description, salary_package, drive_date } = req.body;
    try {
        await pool.query(
            "INSERT INTO job_postings (company_id, job_title, description, salary_package, drive_date) VALUES ($1, $2, $3, $4, $5)",
            [company_id, job_title, description, salary_package, drive_date]
        );
        res.status(201).send('Job posting added successfully');
    } catch (err) {
        console.error('Error adding job posting:', err);
        res.status(500).send('Server error');
    }
});

// GET /api/placements/jobs - Get all open job postings
router.get('/jobs', authenticateToken, authorize(['Admin', 'Teacher']), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT j.id, j.job_title, j.salary_package, j.drive_date, c.company_name 
            FROM job_postings j JOIN companies c ON j.company_id = c.id
            WHERE j.status = 'Open' ORDER BY j.drive_date DESC
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching jobs:', err);
        res.status(500).send('Server error');
    }
});

// POST /api/placements/record - Record or update a placement
router.post('/record', authenticateToken, authorize('Admin'), async (req, res) => {
    const { student_id, job_id, offer_status } = req.body;
    try {
        // Updated to change the status if the record already exists
        await pool.query(
            `INSERT INTO placements (student_id, job_id, offer_status) VALUES ($1, $2, $3) 
             ON CONFLICT (student_id, job_id) DO UPDATE SET offer_status = EXCLUDED.offer_status`,
            [student_id, job_id, offer_status]
        );
        res.status(201).send('Placement recorded successfully');
    } catch (err) {
        console.error('Error recording placement:', err);
        res.status(500).send('Server error');
    }
});

// GET /api/placements/records - Get all placement records
router.get('/records', authenticateToken, authorize('Admin'), async (req, res) => {
    try {
        const query = `
            SELECT 
                p.offer_status,
                (s.first_name || ' ' || s.last_name) AS student_name,
                j.job_title,
                c.company_name
            FROM placements p
            JOIN students s ON p.student_id = s.id
            JOIN job_postings j ON p.job_id = j.id
            JOIN companies c ON j.company_id = c.id
            ORDER BY p.created_at DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching placement records:', err);
        res.status(500).send('Server error');
    }
});

module.exports = router;