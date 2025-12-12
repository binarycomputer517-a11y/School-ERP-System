// routes/library.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment'); 
const { v4: uuidv4 } = require('uuid');
const fs = require('fs/promises'); // For file deletion logic (e.g., if needed in inventory/catalog)

// --- Table Constants ---
const CATALOG_TABLE = 'library_catalog';
const INVENTORY_TABLE = 'book_inventory';
const CIRCULATION_TABLE = 'book_circulation';
const CONFIG_TABLE = 'library_config';
const STUDENT_TABLE = 'students'; 
const USER_TABLE = 'users';

// --- Role Definitions ---
const MANAGER_ROLES = ['Super Admin', 'Admin', 'Librarian', 'Teacher'];
const ADMIN_ROLE = ['Super Admin', 'Admin'];
const LIBRARY_ROLES = ['Super Admin', 'Admin', 'Librarian', 'Teacher', 'Student', 'Staff']; 

// --- Helper: Get Fine Config ---
async function getFineConfig() {
    const configRes = await pool.query(`SELECT config_key, config_value FROM ${CONFIG_TABLE}`);
    const config = configRes.rows.reduce((acc, row) => {
        acc[row.config_key] = row.config_value;
        return acc;
    }, {});
    const maxDays = parseInt(config.max_issue_days || '14', 10);
    const dailyFine = parseFloat(config.daily_fine_rate || '5.00');
    return { maxDays, dailyFine };
}


// =========================================================
// 1. CONFIGURATION & CATALOG MANAGEMENT 
// =========================================================

/**
 * @route   GET /api/library/config
 * @desc    Get library configuration settings.
 * @access  Private (All authenticated users)
 */
router.get('/config', authenticateToken, async (req, res) => {
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
// 2. SEARCH & BROWSING (OPAC Functionality)
// =========================================================

/**
 * @route   GET /api/library/categories
 * @desc    Fetch a list of all library categories (subject areas).
 * @access  Private (All authenticated users)
 */
router.get('/categories', authenticateToken, authorize(LIBRARY_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT subject_area AS name, subject_area AS id 
            FROM ${CATALOG_TABLE}
            WHERE subject_area IS NOT NULL AND subject_area != ''
            ORDER BY subject_area;
        `;
        const { rows } = await pool.query(query);
        const categories = rows.map(row => ({ 
            id: row.id, 
            name: row.name 
        }));
        res.status(200).json(categories);
    } catch (err) {
        console.error('Error fetching library categories:', err);
        res.status(500).json([]); 
    }
});


/**
 * @route   GET /api/library/books
 * @desc    Search library books based on keywords or subject area.
 * @access  Private (All authenticated users)
 */
router.get('/books', authenticateToken, authorize(LIBRARY_ROLES), async (req, res) => {
    const { search, category_name } = req.query; 
    
    try {
        let query = `
            SELECT 
                lc.id, lc.title, lc.author, lc.isbn, lc.subject_area,
                (SELECT COUNT(id) FROM ${INVENTORY_TABLE} WHERE book_id = lc.id AND is_active = TRUE) AS total_copies,
                (SELECT COUNT(id) FROM ${INVENTORY_TABLE} WHERE book_id = lc.id AND status = 'Available' AND is_active = TRUE) AS available_copies
            FROM ${CATALOG_TABLE} lc
            WHERE 1 = 1
        `;
        
        const params = [];
        let paramIndex = 1;

        if (category_name) {
            query += ` AND lc.subject_area = $${paramIndex++}`;
            params.push(category_name);
        }

        if (search) {
            query += ` AND (LOWER(lc.title) LIKE $${paramIndex} OR LOWER(lc.author) LIKE $${paramIndex} OR lc.isbn LIKE $${paramIndex})`;
            params.push(`%${search.toLowerCase()}%`);
        }
        
        query += ` ORDER BY lc.title ASC`;

        const { rows } = await pool.query(query, params);
        
        res.status(200).json(rows); 

    } catch (err) {
        console.error('Error fetching library books:', err);
        res.status(500).json([]); 
    }
});


// =========================================================
// 3. CIRCULATION (ISSUE & RETURN) 
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
        const { maxDays } = await getFineConfig();
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
                circ.id, circ.due_date, circ.inventory_id
            FROM ${CIRCULATION_TABLE} circ
            JOIN ${INVENTORY_TABLE} inv ON circ.inventory_id = inv.id
            WHERE inv.accession_number = $1 AND circ.is_returned = FALSE;
        `;
        const circRes = await client.query(circulationQuery, [accession_number]);
        const circRecord = circRes.rows[0];

        if (!circRecord) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'No active circulation record found for this book.' });
        }
        
        // 2. Calculate Fine
        const { dailyFine } = await getFineConfig();
        const dueDate = moment(circRecord.due_date);
        const returnDate = moment();
        let fineAmount = 0.00;
        let daysLate = 0;
        
        if (returnDate.isAfter(dueDate, 'day')) {
            daysLate = returnDate.diff(dueDate, 'days');
            fineAmount = daysLate * dailyFine;
        }

        // 3. Update Circulation Record
        const returnQuery = `
            UPDATE ${CIRCULATION_TABLE} SET
                return_date = CURRENT_DATE,
                fine_amount = $1,
                is_returned = TRUE,
                payment_status = CASE WHEN $1 > 0 THEN 'Pending' ELSE 'Paid' END
            WHERE id = $2
            RETURNING fine_amount, payment_status;
        `;
        const returnResult = await client.query(returnQuery, [fineAmount, circRecord.id]);

        // 4. Update Inventory Status
        await client.query(`UPDATE ${INVENTORY_TABLE} SET status = 'Available' WHERE id = $1`, [circRecord.inventory_id]);

        await client.query('COMMIT');
        res.status(200).json({ 
            message: 'Book returned successfully.', 
            fine_calculated: returnResult.rows[0].fine_amount,
            status: returnResult.rows[0].payment_status
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Book Return Error:', error);
        res.status(500).json({ message: 'Failed to process book return.' });
    } finally {
        client.release();
    }
});


/**
 * @route   POST /api/library/renew
 * @desc    Renew a currently issued book. Extends due date.
 * @access  Private (Admin, Teacher, Super Admin)
 */
router.post('/renew', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { accession_number } = req.body;
    
    if (!accession_number) {
        return res.status(400).json({ message: 'Missing accession number.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Find the active circulation record
        const circulationQuery = `
            SELECT circ.id, circ.due_date, circ.inventory_id
            FROM ${CIRCULATION_TABLE} circ
            JOIN ${INVENTORY_TABLE} inv ON circ.inventory_id = inv.id
            WHERE inv.accession_number = $1 AND circ.is_returned = FALSE;
        `;
        const circRes = await client.query(circulationQuery, [accession_number]);
        const circRecord = circRes.rows[0];

        if (!circRecord) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Book not actively issued or Accession No. is wrong.' });
        }
        
        // 2. Check if overdue (renewal might be disallowed or incur fine if overdue)
        const dueDate = moment(circRecord.due_date);
        if (dueDate.isBefore(moment(), 'day')) {
             await client.query('ROLLBACK');
             return res.status(409).json({ message: 'Renewal failed: Book is currently overdue. Must be returned first.' });
        }

        // 3. Calculate New Due Date
        const { maxDays } = await getFineConfig();
        const newDueDate = moment().add(maxDays, 'days').format('YYYY-MM-DD');

        // 4. Update Circulation Record
        const renewalQuery = `
            UPDATE ${CIRCULATION_TABLE} SET
                due_date = $1,
                renewal_count = COALESCE(renewal_count, 0) + 1
            WHERE id = $2
            RETURNING due_date;
        `;
        const renewalResult = await client.query(renewalQuery, [newDueDate, circRecord.id]);

        await client.query('COMMIT');
        res.status(200).json({ 
            message: 'Book renewed successfully.', 
            new_due_date: renewalResult.rows[0].due_date 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Book Renewal Error:', error);
        res.status(500).json({ message: error.message || 'Failed to process book renewal.' });
    } finally {
        client.release();
    }
});


// =========================================================
// 4. STUDENT VIEW (Dashboard Integration) 
// =========================================================

/**
 * @route   GET /api/library/student/issued
 * @desc    Get all books currently issued to the logged-in student.
 * @access  Private (Student, Super Admin)
 */
router.get('/student/issued', authenticateToken, authorize(['Student', 'Super Admin']), async (req, res) => {
    // FIX: Using req.user.id (UUID) to fetch the linked student_id
    const userId = req.user.id; 
    
    // Get the linked student_id (Assuming students table links via user_id)
    const studentRes = await pool.query(`SELECT student_id FROM ${STUDENT_TABLE} WHERE user_id = $1::uuid`, [userId]);
    const studentId = studentRes.rows[0]?.student_id;

    if (!studentId) {
        return res.status(404).json({ message: 'Student profile not found.' });
    }

    try {
        const query = `
            SELECT
                circ.id AS circulation_id, circ.issue_date, circ.due_date, 
                lc.title, lc.author, bi.accession_number,
                (circ.due_date < CURRENT_DATE) AS is_overdue
            FROM ${CIRCULATION_TABLE} circ
            JOIN ${INVENTORY_TABLE} bi ON circ.inventory_id = bi.id
            JOIN ${CATALOG_TABLE} lc ON bi.book_id = lc.id
            WHERE circ.student_id = $1 AND circ.is_returned = FALSE
            ORDER BY circ.due_date;
        `;
        const result = await pool.query(query, [studentId]);
        
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Student Issued Books Error:', error);
        res.status(500).json({ message: 'Failed to retrieve issued books.' });
    }
});

/**
 * @route   GET /api/library/history
 * @desc    Search and retrieve circulation history. (Can be filtered by Student ID)
 * @access  Private (Admin, Teacher, Student)
 */
router.get('/history', authenticateToken, authorize(LIBRARY_ROLES), async (req, res) => {
    const { studentId, accessionNo } = req.query;
    const userId = req.user.id;
    const userRole = req.user.role;

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

    // --- Student Self-View Restriction ---
    if (userRole === 'Student' || userRole === 'student') {
        const studentRes = await pool.query(`SELECT student_id FROM ${STUDENT_TABLE} WHERE user_id = $1::uuid`, [userId]);
        const studentProfileId = studentRes.rows[0]?.student_id;

        if (!studentProfileId) {
            return res.status(404).json({ message: "Student profile ID not found." });
        }
        // Force filter by the logged-in student's ID
        query += ` AND circ.student_id = $${paramIndex++}`;
        values.push(studentProfileId);
    }
    // --- Admin/Teacher Filters ---
    else {
        if (studentId) {
            query += ` AND circ.student_id = $${paramIndex++}`;
            values.push(studentId);
        }
    }

    if (accessionNo) {
        query += ` AND bi.accession_number = $${paramIndex++}`;
        values.push(accessionNo);
    }
    
    // Default: Show recent records if no search criteria are given by admin roles
    if (!studentId && !accessionNo && userRole !== 'Student' && userRole !== 'student') {
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


// =========================================================
// 5. FINE MANAGEMENT (FIXED SQL CALCULATION)
// =========================================================

/**
 * @route   GET /api/library/fines/my-fines
 * @desc    Get all fine records (paid/unpaid) for the logged-in user.
 * @access  Private (Student, Staff)
 */
router.get('/fines/my-fines', authenticateToken, authorize(['Student', 'Staff']), async (req, res) => {
    const userId = req.user.id;
    
    // Get the linked student_id 
    const studentRes = await pool.query(`SELECT student_id FROM ${STUDENT_TABLE} WHERE user_id = $1::uuid`, [userId]);
    const profileIdColumn = studentRes.rows[0]?.student_id;
    
    if (!profileIdColumn) {
        return res.status(404).json({ message: "Profile ID not found for fine tracking." });
    }

    try {
        const query = `
            SELECT
                circ.id AS circulation_id, circ.due_date, circ.return_date, 
                circ.fine_amount, circ.payment_status,
                -- ✅ FIX: Calculate days late between return date and due date
                CASE
                    WHEN circ.return_date IS NOT NULL AND circ.return_date > circ.due_date
                    THEN (circ.return_date - circ.due_date)
                    ELSE 0
                END AS days_late,
                lc.title AS book_title
            FROM ${CIRCULATION_TABLE} circ
            JOIN ${INVENTORY_TABLE} bi ON circ.inventory_id = bi.id
            JOIN ${CATALOG_TABLE} lc ON bi.book_id = lc.id
            WHERE circ.student_id = $1::uuid AND (circ.fine_amount > 0 OR circ.payment_status = 'Paid' OR circ.payment_status = 'Waived')
            ORDER BY circ.issue_date DESC;
        `;
        const { rows } = await pool.query(query, [profileIdColumn]);

        res.status(200).json({ 
            records: rows,
            total_due: rows.reduce((acc, r) => acc + (r.payment_status === 'Pending' ? parseFloat(r.fine_amount || 0) : 0), 0)
        });

    } catch (error) {
        console.error('My Fines Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve fine records.' });
    }
});


/**
 * @route   GET /api/library/fines/all
 * @desc    Get all pending fine records for Admin/Librarian view.
 * @access  Private (Admin, Librarian)
 */
router.get('/fines/all', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { search, status } = req.query; 

    let query = `
        SELECT
            circ.id AS circulation_id, circ.due_date, circ.fine_amount, circ.payment_status,
            -- ✅ FIX: Calculate days late using date difference (CURRENT_DATE - circ.due_date)
            CASE 
                WHEN circ.is_returned = FALSE AND circ.due_date < CURRENT_DATE
                THEN (CURRENT_DATE - circ.due_date) 
                WHEN circ.return_date > circ.due_date AND circ.is_returned = TRUE
                THEN (circ.return_date - circ.due_date)
                ELSE 0 
            END AS days_late,
            lc.title AS book_title, bi.accession_number,
            u.username AS student_name, s.student_id
        FROM ${CIRCULATION_TABLE} circ
        JOIN ${INVENTORY_TABLE} bi ON circ.inventory_id = bi.id
        JOIN ${CATALOG_TABLE} lc ON bi.book_id = lc.id
        JOIN ${STUDENT_TABLE} s ON circ.student_id = s.student_id
        JOIN ${USER_TABLE} u ON s.user_id = u.id
        WHERE circ.fine_amount > 0 OR circ.is_returned = FALSE AND circ.due_date < CURRENT_DATE 
    `;
    
    const params = [];
    let paramIndex = 1;
    
    // Filter by payment status
    if (status && status !== 'All') {
        if (status === 'Pending' || status === 'Waived' || status === 'Paid') {
            query += ` AND circ.payment_status = $${paramIndex++}`;
            params.push(status);
        } else if (status === 'Overdue') {
             // Overdue books that are not yet returned and past due date
             query += ` AND circ.is_returned = FALSE AND circ.due_date < CURRENT_DATE`;
        }
    }
    
    // Search by student name or accession number
    if (search) {
        query += ` AND (LOWER(u.username) LIKE $${paramIndex} OR LOWER(bi.accession_number) LIKE $${paramIndex})`;
        params.push(`%${search.toLowerCase()}%`);
    }

    query += ` ORDER BY circ.due_date ASC`;

    try {
        const { rows } = await pool.query(query, params);
        res.status(200).json(rows);

    } catch (error) {
        console.error('All Fines Fetch Error:', error);
        res.status(500).json({ message: 'Failed to retrieve all fine records.' });
    }
});

/**
 * @route   PUT /api/library/fines/:circulationId/waive
 * @desc    Waive a pending fine record.
 * @access  Private (Admin, Librarian)
 */
router.put('/fines/:circulationId/waive', authenticateToken, authorize(MANAGER_ROLES), async (req, res) => {
    const { circulationId } = req.params;
    
    try {
        const result = await pool.query(`
            UPDATE ${CIRCULATION_TABLE} 
            SET fine_amount = 0, payment_status = 'Waived', processed_by = $1::uuid
            WHERE id = $2::uuid AND fine_amount > 0 AND payment_status != 'Paid'
            RETURNING id, fine_amount, payment_status;
        `, [req.user.id, circulationId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Active fine record not found or already processed.' });
        }
        
        res.status(200).json({ message: 'Fine successfully waived.', record: result.rows[0] });

    } catch (error) {
        console.error('Fine Waive Error:', error);
        res.status(500).json({ message: 'Failed to waive fine.' });
    }
});


/**
 * @route   POST /api/library/request
 * @desc    Handle request/issue of an available book.
 * @access  Private (Student, Staff)
 */
router.post('/request', authenticateToken, authorize(LIBRARY_ROLES), async (req, res) => {
    const { book_id } = req.body; // book_id is the catalog ID from the frontend
    const userId = req.user.id;
    
    // NOTE: This is a simplified stub. Real implementation requires checking user limits, 
    // finding an available inventory item, and creating a circulation record.

    try {
        // Step 1: Find the student's actual ID from the user ID
        const studentRes = await pool.query(`SELECT student_id FROM ${STUDENT_TABLE} WHERE user_id = $1::uuid`, [userId]);
        const studentProfileId = studentRes.rows[0]?.student_id;

        if (!studentProfileId) {
            return res.status(400).json({ message: "User profile not found." });
        }
        
        // Step 2: Find one available inventory item for this book_id
        const inventoryRes = await pool.query(
            `SELECT id, accession_number FROM ${INVENTORY_TABLE} WHERE book_id = $1 AND status = 'Available' LIMIT 1`, 
            [book_id]
        );

        if (inventoryRes.rows.length === 0) {
            // If none available, this should become a reservation instead
            return res.status(409).json({ message: "Book is currently unavailable for immediate issue. Try reserving." });
        }
        
        const inventoryId = inventoryRes.rows[0].id;
        
        // Step 3: Get config and calculate due date
        const { maxDays } = await getFineConfig();
        const dueDate = moment().add(maxDays, 'days').format('YYYY-MM-DD');

        // Step 4: Create Circulation Record
        const client = await pool.connect();
        await client.query('BEGIN');
        
        const issueQuery = `
            INSERT INTO ${CIRCULATION_TABLE} (inventory_id, student_id, issue_date, due_date)
            VALUES ($1, $2, CURRENT_DATE, $3)
            RETURNING id, due_date;
        `;
        const issueResult = await client.query(issueQuery, [inventoryId, studentProfileId, dueDate]);
        
        // Step 5: Update Inventory Status
        await client.query(`UPDATE ${INVENTORY_TABLE} SET status = 'Issued' WHERE id = $1`, [inventoryId]);
        await client.query('COMMIT');
        
        res.status(200).json({ 
            message: 'Book issued successfully.', 
            circulation_id: issueResult.rows[0].id, 
            due_date: issueResult.rows[0].due_date 
        });

    } catch (error) {
        // ... (error handling)
        res.status(500).json({ message: 'Failed to process request.', details: error.message });
    }
});

// =========================================================
// 6. RENEWAL/RESERVATION (Reservation Stubs)
// =========================================================

// Placeholder for POST /api/library/reserve

module.exports = router;