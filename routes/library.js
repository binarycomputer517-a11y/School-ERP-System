// routes/library.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment'); // Required for date calculations

// --- Table Constants ---
const CATALOG_TABLE = 'library_catalog';
const INVENTORY_TABLE = 'book_inventory';
const CIRCULATION_TABLE = 'book_circulation';
const CONFIG_TABLE = 'library_config';

// --- Role Definitions ---
const MANAGER_ROLES = ['Super Admin', 'Admin', 'Teacher'];
const ADMIN_ROLE = ['Super Admin', 'Admin'];

// =========================================================
// 1. CONFIGURATION & CATALOG MANAGEMENT 
// =========================================================

/**
 * @route   GET /api/library/config
 * @desc    Get library configuration settings.
 * @access  Private (Admin, Teacher, Student, Super Admin)
 */
router.get('/config', authenticateToken, async (req, res) => {
    // Allowing access to all authenticated users for simplicity
    try {
        const result = await pool.query(`SELECT config_key, config_value FROM ${CONFIG_TABLE}`);
        const config = result.rows.reduce((acc, row) => {
            acc[row.config_key] = row.config_value;
            return acc;
        }, {});
        res.json(config);
    } catch (error) {
        console.error('Error fetching library config:', error);
        res.status(500).json({ message: 'Failed to retrieve library configuration.' });
    }
});

/**
 * @route   PUT /api/library/config
 * @desc    Update library configuration settings (e.g., fine rate, max days).
 * @access  Private (Admin, Super Admin)
 */
router.put('/config', authenticateToken, authorize(ADMIN_ROLE), async (req, res) => {
    const configData = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        for (const key in configData) {
            if (configData.hasOwnProperty(key)) {
                await client.query(
                    `INSERT INTO ${CONFIG_TABLE} (config_key, config_value) 
                    VALUES ($1, $2)
                    ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
                    [key, String(configData[key])]
                );
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'Configuration updated successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Configuration Update Error:', error);
        res.status(500).json({ message: 'Failed to update configuration.' });
    } finally {
        client.release();
    }
});


/**
 * @route   GET /api/library/catalog
 * @desc    Get full catalog list for admin view.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.get('/catalog', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                lc.*,
                (SELECT COUNT(id) FROM ${INVENTORY_TABLE} WHERE book_id = lc.id AND is_active = TRUE) AS total_copies,
                (SELECT COUNT(id) FROM ${INVENTORY_TABLE} WHERE book_id = lc.id AND status = 'Available' AND is_active = TRUE) AS available_copies
            FROM ${CATALOG_TABLE} lc
            ORDER BY lc.title;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching catalog:', error);
        res.status(500).json({ message: 'Failed to retrieve catalog.' });
    }
});

/**
 * @route   POST /api/library/catalog
 * @desc    Add a new book to the master catalog.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.post('/catalog', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { isbn, title, author, publisher, publication_year, edition, subject_area } = req.body;
    
    if (!isbn || !title || !author) {
        return res.status(400).json({ message: 'ISBN, title, and author are required.' });
    }
    
    try {
        const query = `
            INSERT INTO ${CATALOG_TABLE} (isbn, title, author, publisher, publication_year, edition, subject_area)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, title;
        `;
        const values = [
            isbn, title, author, publisher || null, publication_year || null, edition || null, subject_area || null
        ];
        
        const result = await pool.query(query, values);
        res.status(201).json({ 
            message: 'Book added to catalog successfully.', 
            book_id: result.rows[0].id 
        });

    } catch (error) {
        console.error('Catalog POST Error:', error);
        if (error.code === '23505') { // Unique constraint violation (ISBN)
            return res.status(409).json({ message: 'ISBN already exists in the catalog.' });
        }
        res.status(500).json({ message: 'Failed to add book to catalog.' });
    }
});

/**
 * @route   POST /api/library/inventory
 * @desc    Add a new book copy (physical inventory) to the system.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.post('/inventory', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { book_id, accession_number } = req.body;
    
    if (!book_id || !accession_number) {
        return res.status(400).json({ message: 'Missing book ID or accession number.' });
    }

    try {
        const query = `
            INSERT INTO ${INVENTORY_TABLE} (book_id, accession_number, status)
            VALUES ($1, $2, 'Available')
            RETURNING id, accession_number;
        `;
        const values = [book_id, accession_number];
        
        const result = await pool.query(query, values);
        res.status(201).json({ 
            message: `Copy ${result.rows[0].accession_number} added to inventory.`,
            inventory_id: result.rows[0].id
        });

    } catch (error) {
        console.error('Inventory Creation Error:', error);
        if (error.code === '23505') { // Unique constraint violation (Accession Number)
            return res.status(409).json({ message: 'Accession Number already exists.' });
        }
        res.status(500).json({ message: 'Failed to add copy to inventory.' });
    }
});


// =========================================================
// 2. CIRCULATION (ISSUE & RETURN)
// =========================================================

/**
 * @route   POST /api/library/issue
 * @desc    Issue a book copy to a student.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.post('/issue', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { accession_number, student_id } = req.body;
    
    if (!accession_number || !student_id) {
        return res.status(400).json({ message: 'Missing accession number or student ID.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Get Inventory ID and check status
        const inventoryRes = await client.query(`SELECT id, status FROM ${INVENTORY_TABLE} WHERE accession_number = $1 AND is_active = TRUE`, [accession_number]);
        const inventory = inventoryRes.rows[0];

        if (!inventory) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Book copy (Accession No.) not found or is inactive.' });
        }
        if (inventory.status !== 'Available') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: `Book copy is currently ${inventory.status.toLowerCase()}.` });
        }
        
        // 2. Get Config (Max Days)
        const configRes = await client.query(`SELECT config_value FROM ${CONFIG_TABLE} WHERE config_key = 'max_issue_days'`);
        const maxDays = parseInt(configRes.rows[0]?.config_value || '14', 10);
        const dueDate = moment().add(maxDays, 'days').format('YYYY-MM-DD');

        // 3. Create Circulation Record
        const issueQuery = `
            INSERT INTO ${CIRCULATION_TABLE} (inventory_id, student_id, issue_date, due_date)
            VALUES ($1, $2, CURRENT_DATE, $3)
            RETURNING id, due_date;
        `;
        const issueResult = await client.query(issueQuery, [inventory.id, student_id, dueDate]);

        // 4. Update Inventory Status
        await client.query(`UPDATE ${INVENTORY_TABLE} SET status = 'Issued' WHERE id = $1`, [inventory.id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Book issued successfully.', circulation_id: issueResult.rows[0].id, due_date: issueResult.rows[0].due_date });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Book Issue Error:', error);
        
        if (error.code === '23503') { // Foreign Key Violation (e.g., Invalid student_id)
            return res.status(400).json({ message: 'Invalid Student ID or system configuration error.' });
        }
        res.status(500).json({ message: 'Failed to issue book.' });
    } finally {
        client.release();
    }
});


/**
 * @route   POST /api/library/return
 * @desc    Return a book copy. Calculates fines.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.post('/return', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { accession_number } = req.body;
    
    if (!accession_number) {
        return res.status(400).json({ message: 'Missing accession number.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Find the active circulation record
        const circulationQuery = `
            SELECT 
                circ.id, circ.due_date, circ.inventory_id, 
                config.config_value AS daily_fine_rate
            FROM ${CIRCULATION_TABLE} circ
            JOIN ${INVENTORY_TABLE} inv ON circ.inventory_id = inv.id
            LEFT JOIN ${CONFIG_TABLE} config ON config.config_key = 'daily_fine_rate'
            WHERE inv.accession_number = $1 AND circ.is_returned = FALSE;
        `;
        const circRes = await client.query(circulationQuery, [accession_number]);
        const circRecord = circRes.rows[0];

        if (!circRecord) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'No active circulation record found for this book.' });
        }
        
        // 2. Calculate Fine
        const dueDate = moment(circRecord.due_date);
        const returnDate = moment();
        let fineAmount = 0.00;
        
        if (returnDate.isAfter(dueDate, 'day')) {
            const daysLate = returnDate.diff(dueDate, 'days');
            // Ensure dailyFine is treated as a number
            const dailyFine = parseFloat(circRecord.daily_fine_rate || '5.00'); 
            fineAmount = daysLate * dailyFine;
        }

        // 3. Update Circulation Record
        const returnQuery = `
            UPDATE ${CIRCULATION_TABLE} SET
                return_date = CURRENT_DATE,
                fine_amount = $1,
                is_returned = TRUE
            WHERE id = $2
            RETURNING fine_amount;
        `;
        const returnResult = await client.query(returnQuery, [fineAmount, circRecord.id]);

        // 4. Update Inventory Status
        await client.query(`UPDATE ${INVENTORY_TABLE} SET status = 'Available' WHERE id = $1`, [circRecord.inventory_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Book returned successfully.', fine_calculated: returnResult.rows[0].fine_amount });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Book Return Error:', error);
        res.status(500).json({ message: 'Failed to process book return.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 3. STUDENT VIEW (Dashboard Integration)
// =========================================================

/**
 * @route   GET /api/library/student/issued
 * @desc    Get all books currently issued to the logged-in student.
 * @access  Private (Student, Super Admin)
 */
router.get('/student/issued', authenticateToken, authorize(['Student', 'Super Admin']), async (req, res) => {
    const student_id = req.user.reference_id;
    
    if (!student_id) {
        return res.status(403).json({ message: 'Student ID not found.' });
    }

    try {
        const query = `
            SELECT
                circ.id AS circulation_id, circ.issue_date, circ.due_date, 
                lc.title, lc.author, bi.accession_number,
                -- Calculate if overdue (for display)
                (circ.due_date < CURRENT_DATE) AS is_overdue
            FROM ${CIRCULATION_TABLE} circ
            JOIN ${INVENTORY_TABLE} bi ON circ.inventory_id = bi.id
            JOIN ${CATALOG_TABLE} lc ON bi.book_id = lc.id
            WHERE circ.student_id = $1 AND circ.is_returned = FALSE
            ORDER BY circ.due_date;
        `;
        const result = await pool.query(query, [student_id]);
        
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Student Issued Books Error:', error);
        res.status(500).json({ message: 'Failed to retrieve issued books.' });
    }
});



// routes/library.js (add this block)

/**
 * @route   GET /api/library/history
 * @desc    Search and retrieve circulation history.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.get('/history', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { studentId, accessionNo } = req.query;

    let query = `
        SELECT
            circ.id, circ.student_id, circ.issue_date, circ.due_date, circ.return_date, circ.fine_amount,
            lc.title, bi.accession_number
        FROM ${CIRCULATION_TABLE} circ
        JOIN ${INVENTORY_TABLE} bi ON circ.inventory_id = bi.id
        JOIN ${CATALOG_TABLE} lc ON bi.book_id = lc.id
        WHERE 1=1 
    `;
    const values = [];
    let paramIndex = 1;

    if (studentId) {
        query += ` AND circ.student_id = $${paramIndex++}`;
        values.push(studentId);
    }
    if (accessionNo) {
        query += ` AND bi.accession_number = $${paramIndex++}`;
        values.push(accessionNo);
    }
    
    // Default: Show recent records if no search criteria are given
    if (!studentId && !accessionNo) {
        query += ` ORDER BY circ.issue_date DESC LIMIT 50`;
    } else {
        query += ` ORDER BY circ.issue_date DESC`;
    }

    try {
        const result = await pool.query(query, values);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('History Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve history records.' });
    }
});

// module.exports = router; // Ensure this is at the end of library.js
module.exports = router;