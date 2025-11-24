// routes/fees.js
// TRUE FULL & FINAL VERSION (Includes ALL 17 Features & Sections)

// =========================================================
// SECTION 1: IMPORTS, CONSTANTS & CONFIGURATION
// =========================================================
const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');

// --- Database Table Constants ---
const DB = {
    ITEMS: 'invoice_items',
    PAYMENTS: 'fee_payments',
    USERS: 'users',
    STUDENTS: 'students',
    TRANSPORT: 'student_transport_assignments',
    ROUTES: 'transport_routes',
    COURSES: 'courses',
    BATCHES: 'batches',
    WAIVERS: 'fee_waiver_requests',
    FEE_STRUCT: 'fee_structures',
    DISCOUNTS: 'fee_discounts',
    HOSTEL: 'hostel_rates',
    LATE_FEE: 'late_fee_config',
    INVOICES: 'student_invoices',
    BUDGET_CATS: 'budget_categories',
    BUDGETS: 'annual_budgets',
    EXPENSES: 'expenses'
};

const BASE_TUITION_FEE = 5000.00; 
const FEE_ROLES = ['Admin', 'Staff', 'Super Admin', 'Finance'];

// --- Helper Functions ---
const generateInvoiceNumber = () => {
    return `INV-${moment().format('YYYYMMDD')}-${uuidv4().split('-')[0].toUpperCase().substring(0, 6)}`;
};

// =========================================================
// SECTION 2: CORE TRANSACTIONS (INVOICING, COLLECTION, REFUND)
// =========================================================

// =========================================================
// SECTION 2: CORE TRANSACTIONS (INVOICING, COLLECTION, REFUND)
// =========================================================

/**
 * 2.1 FULL COURSE INVOICE GENERATION (One-Time based on Structure)
 * This generates a single invoice comprising Tuition + Admission + Exam + Registration fees.
 */
router.post('/generate-structure-invoice', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const adminId = req.user.id;
    const issueDate = moment().format('YYYY-MM-DD'); // Today's date
    // Due date can be set to end of session or custom. Here set to 30 days.
    const dueDate = moment().add(30, 'days').format('YYYY-MM-DD'); 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Fetch Students linked with Fee Structure
        // We fetch ALL fee components
        const studentsRes = await client.query(`
            SELECT 
                s.student_id, 
                u.username, 
                fs.id AS fee_structure_id,
                fs.structure_name,
                COALESCE(fs.tuition_fee, 0) AS tuition,
                COALESCE(fs.admission_fee, 0) AS admission,
                COALESCE(fs.registration_fee, 0) AS registration,
                COALESCE(fs.exam_fee, 0) AS exam,
                COALESCE(fs.transport_fee, 0) AS transport_struct -- If transport is part of structure
            FROM ${DB.STUDENTS} s
            JOIN ${DB.USERS} u ON s.user_id = u.id
            JOIN ${DB.FEE_STRUCT} fs ON s.course_id = fs.course_id AND s.batch_id = fs.batch_id
            WHERE u.is_active = TRUE;
        `);

        let generatedCount = 0;
        let skippedCount = 0;

        for (const student of studentsRes.rows) {
            
            // 2. DUPLICATE CHECK: 
            // Check if an invoice for this specific Fee Structure ID already exists for this student.
            // This prevents generating the full course fee twice.
            const checkDuplicate = await client.query(`
                SELECT id FROM ${DB.INVOICES} 
                WHERE student_id = $1::uuid AND fee_structure_id = $2::uuid
            `, [student.student_id, student.fee_structure_id]);

            if (checkDuplicate.rowCount > 0) { 
                skippedCount++; 
                continue; 
            }

            // 3. Calculate Grand Total & Prepare Items
            let totalAmount = 0;
            const items = [];

            // Helper to add item
            const addItem = (desc, amount) => {
                const amt = parseFloat(amount);
                if (amt > 0) {
                    items.push({ description: desc, amount: amt });
                    totalAmount += amt;
                }
            };

            addItem('Tuition Fee (Total)', student.tuition);
            addItem('Admission Fee', student.admission);
            addItem('Registration Fee', student.registration);
            addItem('Examination Fee', student.exam);
            
            // Note: Transport is usually monthly, but if it's fixed package, add it here:
            // addItem('Transport Fee (Fixed)', student.transport_struct);

            if (totalAmount === 0) continue; // Skip if fee is 0

            // 4. Insert Invoice Header (With fee_structure_id)
            const invRes = await client.query(`
                INSERT INTO ${DB.INVOICES} 
                (student_id, invoice_number, issue_date, due_date, total_amount, status, created_by, fee_structure_id)
                VALUES ($1::uuid, $2, $3, $4, $5, 'Pending', $6::uuid, $7::uuid) 
                RETURNING id;
            `, [
                student.student_id, 
                generateInvoiceNumber(), 
                issueDate, 
                dueDate, 
                totalAmount, 
                adminId,
                student.fee_structure_id // Important for duplicate check
            ]);
            
            const invoiceId = invRes.rows[0].id;
            
            // 5. Insert Line Items
            if (items.length > 0) {
                const itemsValues = items.map(item => `('${invoiceId}', '${item.description}', ${item.amount})`).join(',');
                await client.query(`INSERT INTO ${DB.ITEMS} (invoice_id, description, amount) VALUES ${itemsValues};`);
            }
            
            generatedCount++;
        }

        await client.query('COMMIT');
        res.status(201).json({ message: `Structure Generation Complete. Generated: ${generatedCount}, Skipped (Already Assigned): ${skippedCount}` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Gen Error:", error);
        res.status(500).json({ message: 'Failed to generate structure invoices.' });
    } finally { client.release(); }
});
/**
 * 2.2 FEE COLLECTION
 */
router.post('/collect', authenticateToken, authorize(['admin', 'teacher', 'staff', 'super admin']), async (req, res) => {
    const { student_id, amount_paid, payment_mode, notes } = req.body;
    const collectedBy = req.user.id;
    const payAmount = parseFloat(amount_paid);

    if (!student_id || !payAmount || payAmount <= 0) return res.status(400).json({ message: 'Invalid payment details.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const openInvoices = await client.query(`
            SELECT id, total_amount, paid_amount, (total_amount - paid_amount) AS balance_due
            FROM ${DB.INVOICES} WHERE student_id = $1::uuid AND status != 'Paid' AND status != 'Waived'
            ORDER BY due_date ASC;
        `, [student_id]);

        let totalDue = openInvoices.rows.reduce((acc, i) => acc + parseFloat(i.balance_due), 0);
        
        if (totalDue <= 0) throw new Error("No pending dues.");
        if (payAmount > (totalDue + 0.01)) throw new Error(`Overpayment detected. Total Due: ${totalDue.toFixed(2)}`);

        let remaining = payAmount;
        let paymentId = null;
        const batchRef = 'MANUAL-' + uuidv4().substring(0,8).toUpperCase();

        for (const inv of openInvoices.rows) {
            if (remaining <= 0) break;
            const due = parseFloat(inv.balance_due);
            const paying = Math.min(remaining, due);

            if (paying > 0) {
                const pRes = await client.query(`
                    INSERT INTO ${DB.PAYMENTS} (invoice_id, amount, payment_mode, transaction_id, collected_by, remarks) 
                    VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6) RETURNING id;
                `, [inv.id, paying, payment_mode, batchRef, collectedBy, notes]);
                
                if (!paymentId) paymentId = pRes.rows[0].id;

                const newPaid = parseFloat(inv.paid_amount) + paying;
                const newStatus = (newPaid >= (parseFloat(inv.total_amount) - 0.01)) ? 'Paid' : 'Partial';
                
                await client.query(`UPDATE ${DB.INVOICES} SET paid_amount = paid_amount + $1, status = $2 WHERE id = $3::uuid`, [paying, newStatus, inv.id]);
                remaining -= paying;
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ message: `Payment Recorded: ₹${payAmount}`, receipt_number: paymentId });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message || 'Payment Failed' });
    } finally { client.release(); }
});

/**
 * 2.3 REFUND MANAGEMENT
 */
router.get('/student-refund-info/:studentId', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    try {
        const q = `SELECT (COALESCE((SELECT SUM(amount) FROM ${DB.PAYMENTS} p JOIN ${DB.INVOICES} i ON p.invoice_id = i.id WHERE i.student_id = $1::uuid), 0) - COALESCE((SELECT SUM(total_amount) FROM ${DB.INVOICES} WHERE student_id = $1::uuid), 0)) AS refundable_balance`;
        const resData = await pool.query(q, [req.params.studentId]);
        res.status(200).json({ refundable_balance: parseFloat(resData.rows[0]?.refundable_balance || 0) });
    } catch (e) { res.status(500).json({ message: 'Error fetching info' }); }
});

router.post('/refund', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { student_id, amount, reason } = req.body;
    try {
        const creditNote = `CN-${uuidv4().substring(0,6)}`;
        await pool.query(`INSERT INTO ${DB.INVOICES} (student_id, invoice_number, total_amount, paid_amount, status, created_by) VALUES ($1::uuid, $2, $3, $3, 'Refunded', $4::uuid)`, [student_id, creditNote, -amount, req.user.id]);
        res.status(200).json({ message: "Refund processed.", credit_note: creditNote });
    } catch (e) { res.status(500).json({ message: "Refund failed." }); }
});

// =========================================================
// SECTION 3: STUDENT DATA & RECEIPTS
// =========================================================

// 3.1 VIEW INVOICES & ITEMS
router.get('/invoices/student/:studentId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT i.*, u.username FROM ${DB.INVOICES} i JOIN ${DB.STUDENTS} s ON i.student_id=s.student_id JOIN ${DB.USERS} u ON s.user_id=u.id WHERE i.student_id=$1::uuid ORDER BY i.issue_date DESC`, [req.params.studentId]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ message: 'Error' }); }
});

router.get('/invoice/:invoiceId/items', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${DB.ITEMS} WHERE invoice_id=$1::uuid ORDER BY created_at ASC`, [req.params.invoiceId]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ message: 'Error' }); }
});
// =========================================================
// 3.2 SMART STUDENT DASHBOARD (Auto-Generate with Schema Fixes)
// =========================================================
router.get('/student/:studentId', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const client = await pool.connect();
    try {
        const { studentId } = req.params;
        const adminId = req.user.id; 
        const issueDate = moment().format('YYYY-MM-DD');
        const dueDate = moment().add(30, 'days').format('YYYY-MM-DD');

        await client.query('BEGIN');

        // 1. Fetch Student, Structure, Duration AND Assignments
        // FIXED: Matched column names with your provided Schema
        const sRes = await client.query(`
            SELECT 
                s.student_id, 
                u.username, 
                s.roll_number,
                c.course_name, 
                b.batch_name,
                
                -- Fee Structure Info
                fs.id AS fee_structure_id,
                fs.structure_name,
                COALESCE(fs.course_duration_months, 12) AS duration,
                COALESCE(fs.tuition_fee, 0) AS monthly_tuition,
                COALESCE(fs.admission_fee, 0) AS admission,
                COALESCE(fs.registration_fee, 0) AS registration,
                COALESCE(fs.examination_fee, 0) AS exam,

                -- Transport Info (Checking is_active and taking fee from assignment)
                ta.monthly_fee AS transport_assigned_fee,
                r.monthly_fee AS route_base_fee,
                r.route_name,
                ta.is_active AS transport_active,

                -- Hostel Info (Fixed column 'hostel_rate_id')
                hr.room_fee AS hostel_monthly,
                hr.rate_name AS hostel_room_name

            FROM ${DB.STUDENTS} s 
            JOIN ${DB.USERS} u ON s.user_id=u.id 
            LEFT JOIN ${DB.COURSES} c ON s.course_id=c.id 
            LEFT JOIN ${DB.BATCHES} b ON s.batch_id = b.id
            
            -- Link Fee Structure
            LEFT JOIN ${DB.FEE_STRUCT} fs ON s.course_id = fs.course_id AND s.batch_id = fs.batch_id
            
            -- Link Transport (Schema Fixed: Added is_active check)
            LEFT JOIN student_transport_assignments ta ON s.student_id = ta.student_id AND ta.is_active = TRUE
            LEFT JOIN ${DB.ROUTES} r ON ta.route_id = r.id

            -- Link Hostel (Schema Fixed: Used 'hostel_rate_id')
            LEFT JOIN student_hostel_assignments ha ON s.student_id = ha.student_id
            LEFT JOIN ${DB.HOSTEL} hr ON ha.hostel_rate_id = hr.id

            WHERE s.student_id=$1::uuid
        `, [studentId]);

        if (!sRes.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({message: 'Student not found'});
        }
        
        const student = sRes.rows[0];

        // 2. CHECK & AUTO-GENERATE INVOICE LOGIC
        if (student.fee_structure_id) {
            
            const invCheck = await client.query(`
                SELECT id FROM ${DB.INVOICES} 
                WHERE student_id = $1::uuid AND fee_structure_id = $2::uuid
            `, [student.student_id, student.fee_structure_id]);

            if (invCheck.rowCount === 0) {
                console.log(`Auto-generating invoice for ${student.username}...`);
                
                const duration = parseInt(student.duration);

                // A. Base Course Fees
                const totalTuition = parseFloat(student.monthly_tuition) * duration;
                
                // B. Transport Calculation (Priority: Assignment Fee > Route Fee)
                let totalTransport = 0;
                let transportMonthly = 0;
                
                if (student.transport_active) {
                    // If assignment table has fee > 0, use it. Else use route fee.
                    transportMonthly = parseFloat(student.transport_assigned_fee) > 0 
                        ? parseFloat(student.transport_assigned_fee) 
                        : parseFloat(student.route_base_fee || 0);
                        
                    totalTransport = transportMonthly * duration;
                }

                // C. Hostel Calculation
                let totalHostel = 0;
                if (student.hostel_monthly) {
                    totalHostel = parseFloat(student.hostel_monthly) * duration;
                }

                // Grand Total
                let totalAmount = 
                    totalTuition + 
                    totalTransport +
                    totalHostel +
                    parseFloat(student.admission) + 
                    parseFloat(student.registration) + 
                    parseFloat(student.exam);

                if (totalAmount > 0) {
                    // Create Header
                    const invRes = await client.query(`
                        INSERT INTO ${DB.INVOICES} 
                        (student_id, invoice_number, issue_date, due_date, total_amount, status, created_by, fee_structure_id)
                        VALUES ($1::uuid, $2, $3, $4, $5, 'Pending', $6::uuid, $7::uuid) 
                        RETURNING id;
                    `, [student.student_id, generateInvoiceNumber(), issueDate, dueDate, totalAmount, adminId, student.fee_structure_id]);
                    
                    const newInvId = invRes.rows[0].id;

                    // Create Items List
                    const items = [
                        { d: `Tuition Fee (${duration} Months)`, a: totalTuition },
                        { d: 'Admission Fee', a: student.admission },
                        { d: 'Registration Fee', a: student.registration },
                        { d: 'Examination Fee', a: student.exam }
                    ];

                    if (totalTransport > 0) {
                        items.push({ 
                            d: `Transport Fee (${student.route_name || 'Assigned'} - ${duration} Months)`, 
                            a: totalTransport 
                        });
                    }

                    if (totalHostel > 0) {
                        items.push({ 
                            d: `Hostel Fee (${student.hostel_room_name} - ${duration} Months)`, 
                            a: totalHostel 
                        });
                    }

                    const finalItems = items.filter(i => parseFloat(i.a) > 0);
                    if (finalItems.length > 0) {
                        const itemsValues = finalItems.map(i => `('${newInvId}', '${i.d}', ${i.a})`).join(',');
                        await client.query(`INSERT INTO ${DB.ITEMS} (invoice_id, description, amount) VALUES ${itemsValues};`);
                    }
                }
            }
        }

        await client.query('COMMIT');

        // 3. FETCH FINAL TOTALS
        const invoiceStats = await pool.query(`
            SELECT 
                COALESCE(SUM(total_amount), 0) AS total_invoiced,
                COALESCE(SUM(paid_amount), 0) AS total_paid
            FROM ${DB.INVOICES} 
            WHERE student_id = $1::uuid AND status != 'Waived'
        `, [studentId]);

        const totalFees = parseFloat(invoiceStats.rows[0].total_invoiced);
        const totalPaid = parseFloat(invoiceStats.rows[0].total_paid);

        // 4. Fetch Payment History
        const history = await pool.query(`
            SELECT p.transaction_id AS receipt_number, p.amount AS amount_paid, p.payment_mode, p.payment_date, p.id AS paymentId 
            FROM ${DB.PAYMENTS} p 
            JOIN ${DB.INVOICES} i ON p.invoice_id=i.id 
            WHERE i.student_id=$1::uuid 
            ORDER BY p.payment_date DESC
        `, [studentId]);

        // 5. Send Response
        res.json({
            student_name: student.username,       
            course_name: student.course_name || 'N/A',
            roll_number: student.roll_number,
            batch_name: student.batch_name || 'N/A',
            
            total_fees: totalFees,                
            total_paid: totalPaid,                
            balance: totalFees - totalPaid,       
            
            payments: history.rows                
        });

    } catch (e) { 
        await client.query('ROLLBACK');
        console.error("Dashboard Error:", e);
        res.status(500).json({ message: 'Failed to fetch student status' }); 
    } finally {
        client.release();
    }
});


// =========================================================
// 3.3 RECEIPT GENERATION (PDF) - Supports UUID OR Transaction ID
// =========================================================
router.get('/receipt/:idOrTxn', authenticateToken, async (req, res) => {
    const { idOrTxn } = req.params;
    try {
        // 1. Determine if input is UUID or Transaction ID
        const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(idOrTxn);
        
        let whereClause = '';
        if (isUUID) {
            whereClause = `p.id = $1::uuid`;
        } else {
            whereClause = `p.transaction_id = $1`; // Search by TXN String
        }

        // 2. Fetch Payment Data
        const q = `
            SELECT p.*, i.invoice_number, u.username, s.roll_number, c.course_name 
            FROM ${DB.PAYMENTS} p 
            JOIN ${DB.INVOICES} i ON p.invoice_id=i.id 
            JOIN ${DB.STUDENTS} s ON i.student_id=s.student_id 
            JOIN ${DB.USERS} u ON s.user_id=u.id 
            LEFT JOIN ${DB.COURSES} c ON s.course_id=c.id 
            WHERE ${whereClause}
        `;
        
        const { rows } = await pool.query(q, [idOrTxn]);
        if (!rows[0]) return res.status(404).json({ message: 'Receipt Not Found' });
        const data = rows[0];

        // 3. Generate PDF
        const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 30 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Receipt-${data.transaction_id}.pdf`);
        doc.pipe(res);

        // Design
        doc.rect(20, 20, 555, 380).stroke();
        doc.font('Times-Bold').fontSize(16).text('SCHOOL NAME', { align: 'center' });
        doc.fontSize(12).text('Money Receipt', { align: 'center', underline: true });
        
        doc.moveDown();
        // Truncate TXN ID for display to prevent overlap if too long
        const displayTxn = data.transaction_id.length > 20 ? data.transaction_id.substring(0, 20) + '...' : data.transaction_id;
        
        doc.fontSize(10).text(`Receipt No: ${displayTxn}`, 400, 100);
        doc.text(`Date: ${moment(data.payment_date).format('DD/MM/YYYY')}`, 400, 115);
        
        doc.text(`Student: ${data.username}`, 40, 100);
        doc.text(`Roll: ${data.roll_number || '-'} | Class: ${data.course_name || '-'}`, 40, 120);

        const y = 160;
        doc.rect(40, y, 515, 25).fillAndStroke('#eee', '#000');
        doc.fillColor('black').text('Description', 50, y+8).text('Amount', 480, y+8);
        
        doc.rect(40, y+25, 515, 30).stroke();
        doc.text(`Fee Payment (${data.payment_mode})`, 50, y+35).text(parseFloat(data.amount).toFixed(2), 480, y+35);

        doc.end();

    } catch (e) { 
        console.error("Receipt Error:", e);
        res.status(500).json({ message: 'PDF Gen Failed' }); 
    }
});
// =========================================================
// SECTION 4: SETTINGS & CONFIGURATION (ADMIN CRUD)
// =========================================================

// 4.1 DISCOUNT MANAGEMENT
router.get('/discounts', authenticateToken, async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM ${DB.DISCOUNTS} ORDER BY created_at DESC`); res.json(r.rows); } catch (e) { res.status(500).json({message:'Error'}); }
});
router.post('/discounts', authenticateToken, authorize(['admin']), async (req, res) => {
    try { const r = await pool.query(`INSERT INTO ${DB.DISCOUNTS} (name, type, value, description) VALUES ($1, $2, $3, $4) RETURNING *`, [req.body.name, req.body.type, req.body.value, req.body.description]); res.status(201).json(r.rows[0]); } catch (e) { res.status(500).json({message:'Error'}); }
});
router.delete('/discounts/:id', authenticateToken, authorize(['admin']), async (req, res) => {
    try { await pool.query(`DELETE FROM ${DB.DISCOUNTS} WHERE id=$1::uuid`, [req.params.id]); res.json({message:'Deleted'}); } catch (e) { res.status(500).json({message:'Error'}); }
});

// 4.2 HOSTEL RATES
router.get('/hostel/rates', authenticateToken, async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM ${DB.HOSTEL}`); res.json(r.rows); } catch (e) { res.status(500).json({message:'Error'}); }
});
router.post('/hostel/rates', authenticateToken, authorize(['admin']), async (req, res) => {
    try { const r = await pool.query(`INSERT INTO ${DB.HOSTEL} (rate_name, room_type, room_fee, meal_fee, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [req.body.rate_name, req.body.room_type, req.body.room_fee, req.body.meal_fee, req.body.notes]); res.status(201).json(r.rows[0]); } catch (e) { res.status(500).json({message:'Error'}); }
});
router.delete('/hostel/rates/:id', authenticateToken, authorize(['admin']), async (req, res) => {
    try { await pool.query(`DELETE FROM ${DB.HOSTEL} WHERE id=$1::uuid`, [req.params.id]); res.json({message:'Deleted'}); } catch (e) { res.status(500).json({message:'Error'}); }
});

// =========================================================
// 4.3 LATE FEE CONFIG (CRUD)
// =========================================================

router.get('/late-fee-config/current', authenticateToken, async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM ${DB.LATE_FEE} LIMIT 1`); res.json(r.rows[0] || {}); } catch (e) { res.status(500).json({message:'Error'}); }
});

// Create New Config (Overwrite existing)
router.post('/late-fee-config', authenticateToken, authorize(['admin']), async (req, res) => {
    try { 
        await pool.query(`DELETE FROM ${DB.LATE_FEE}`); 
        const r = await pool.query(`INSERT INTO ${DB.LATE_FEE} (grace_days, penalty_type, penalty_value, max_penalty_value, compounding_interval) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [req.body.grace_days, req.body.penalty_type, req.body.penalty_value, req.body.max_penalty_value, req.body.compounding_interval]); 
        res.json(r.rows[0]); 
    } catch (e) { res.status(500).json({message:'Error'}); }
});

// ✅ ADD THIS NEW ROUTE FOR UPDATE (PUT)
router.put('/late-fee-config/:id', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { id } = req.params;
    const { grace_days, penalty_type, penalty_value, max_penalty_value, compounding_interval } = req.body;

    try {
        const result = await pool.query(`
            UPDATE ${DB.LATE_FEE}
            SET grace_days = $1,
                penalty_type = $2,
                penalty_value = $3,
                max_penalty_value = $4,
                compounding_interval = $5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $6::uuid
            RETURNING *
        `, [grace_days, penalty_type, penalty_value, max_penalty_value, compounding_interval, id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Configuration ID not found.' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Late Fee Update Error:', error);
        res.status(500).json({ message: 'Failed to update configuration.' });
    }
});

// 4.4 BUDGET TARGET CONFIG
router.post('/budget-target', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { year, category_name, amount, type } = req.body;
    try {
        let catRes = await pool.query(`SELECT id FROM ${DB.BUDGET_CATS} WHERE name=$1`, [category_name]);
        let catId = catRes.rows[0]?.id;
        if (!catId) {
            const newCat = await pool.query(`INSERT INTO ${DB.BUDGET_CATS} (name, type) VALUES ($1, $2) RETURNING id`, [category_name, type || 'Expense']);
            catId = newCat.rows[0].id;
        }
        await pool.query(`INSERT INTO ${DB.BUDGETS} (fiscal_year, category_id, budget_amount) VALUES ($1, $2, $3) ON CONFLICT (fiscal_year, category_id) DO UPDATE SET budget_amount=$3`, [year, catId, amount]);
        res.json({ message: "Budget target updated." });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// =========================================================
// SECTION 5: ANALYTICS & REPORTS
// =========================================================

// =========================================================
// 5.1 GLOBAL TRANSACTION HISTORY (FIXED: Added payment_id)
// =========================================================
router.get('/history', authenticateToken, authorize(['admin', 'super admin', 'finance']), async (req, res) => {
    const { startDate, endDate } = req.query;
    const start = startDate || moment().startOf('month').format('YYYY-MM-DD');
    const end = endDate || moment().endOf('month').format('YYYY-MM-DD');

    try {
        // FIXED: Added 'p.id AS payment_id' so frontend gets the UUID
        const query = `
            SELECT 
                p.id AS payment_id,  -- This was missing!
                p.transaction_id, 
                p.amount, 
                p.payment_date, 
                p.payment_mode, 
                u.username AS student_name
            FROM ${DB.PAYMENTS} p 
            JOIN ${DB.INVOICES} i ON p.invoice_id = i.id 
            JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id 
            JOIN ${DB.USERS} u ON s.user_id = u.id
            WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2 
            ORDER BY p.payment_date DESC
        `;
        
        const result = await pool.query(query, [start, end]);
        res.status(200).json(result.rows);

    } catch (error) { 
        console.error("History Error:", error);
        res.status(500).json({ message: 'Failed to fetch history.' }); 
    }
});
// 5.2 REVENUE STREAM
router.get('/reports/revenue-stream', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { start_date, end_date } = req.query;
    const s = start_date || moment().startOf('month').format('YYYY-MM-DD');
    const e = end_date || moment().endOf('month').format('YYYY-MM-DD');
    try {
        const q = `SELECT SPLIT_PART(item.description, ' (', 1) AS category, SUM(item.amount) AS amount FROM ${DB.PAYMENTS} p JOIN ${DB.ITEMS} item ON p.invoice_id=item.invoice_id WHERE p.payment_date::date >= $1 AND p.payment_date::date <= $2 GROUP BY category`;
        const r = await pool.query(q, [s, e]);
        res.json({ breakdown: r.rows });
    } catch (err) { res.status(500).json({ message: 'Error' }); }
});

// 5.3 ANNUAL BUDGET REPORT
router.get('/reports/annual-budget', authenticateToken, async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const start = `${year}-04-01`; const end = `${year+1}-03-31`;
    try {
        const targets = await pool.query(`SELECT c.name, b.budget_amount, c.type FROM ${DB.BUDGETS} b JOIN ${DB.BUDGET_CATS} c ON b.category_id=c.id WHERE b.fiscal_year=$1`, [year]);
        const income = await pool.query(`SELECT SUM(amount) as val FROM ${DB.PAYMENTS} WHERE payment_date BETWEEN $1 AND $2`, [start, end]);
        const expense = await pool.query(`SELECT c.name, SUM(e.amount) as val FROM ${DB.EXPENSES} e JOIN ${DB.BUDGET_CATS} c ON e.category_id=c.id WHERE e.expense_date BETWEEN $1 AND $2 GROUP BY c.name`, [start, end]);

        const data = targets.rows.map(t => ({
            ...t,
            actual: (t.type==='Income') ? (income.rows[0].val||0) : (expense.rows.find(e=>e.name===t.name)?.val||0)
        }));
        res.json({ year, report: data });
    } catch (e) { res.status(500).json({ message: 'Error' }); }
});

// 5.4 EXPENSE RECORDING
router.post('/expenses', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    const { category_name, amount, description, date } = req.body;
    try {
        const cat = await pool.query(`SELECT id FROM ${DB.BUDGET_CATS} WHERE name=$1`, [category_name]);
        if (!cat.rows[0]) return res.status(404).json({message: "Category not found"});
        await pool.query(`INSERT INTO ${DB.EXPENSES} (category_id, amount, expense_date, description, recorded_by) VALUES ($1, $2, $3, $4, $5)`, [cat.rows[0].id, amount, date||new Date(), description, req.user.id]);
        res.status(201).json({message: "Recorded"});
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.5 REVENUE FORECAST
router.get('/reports/revenue-forecast', authenticateToken, async (req, res) => {
    try {
        const q = `SELECT TO_CHAR(due_date, 'Mon YYYY') as month, SUM(total_amount - paid_amount) as projected FROM ${DB.INVOICES} WHERE status IN ('Pending', 'Partial') AND due_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '6 months') GROUP BY month ORDER BY month`;
        const r = await pool.query(q);
        res.json(r.rows);
    } catch (e) { res.status(500).json({message: 'Error'}); }
});


// =========================================================
// 5.6 DASHBOARD QUICK STATS (New Route)
// =========================================================
router.get('/reports/dashboard-stats', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT 
                COUNT(id) AS unpaid_count,
                COALESCE(SUM(total_amount - paid_amount), 0) AS total_outstanding
            FROM ${DB.INVOICES}
            WHERE status != 'Paid' AND status != 'Waived'
        `;
        const result = await pool.query(query);
        res.json(result.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Stats error' });
    }
});
// =========================================================
// 5.7 STUDENT LEDGER REPORT (Merged Invoices & Payments)
// =========================================================
router.get('/ledger/:studentId', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    const { studentId } = req.params;
    
    try {
        // FIXED: Removed 'created_at' from the query because 'fee_payments' table 
        // does not have it. We use 'issue_date' and 'payment_date' for sorting.
        const query = `
            SELECT * FROM (
                -- 1. INVOICES (DEBIT)
                SELECT 
                    id,
                    issue_date AS date,
                    'Invoice' AS type,
                    invoice_number AS ref_no,
                    'Tuition & Fees Generated' AS description,
                    total_amount AS debit,
                    0.00 AS credit,
                    issue_date::timestamp AS sort_date -- Use issue_date for sorting
                FROM ${DB.INVOICES}
                WHERE student_id = $1::uuid AND status != 'Waived'

                UNION ALL

                -- 2. PAYMENTS (CREDIT)
                SELECT 
                    p.id,
                    p.payment_date AS date,
                    'Payment' AS type,
                    p.transaction_id AS ref_no,
                    'Fee Payment Received (' || p.payment_mode || ')' AS description,
                    0.00 AS debit,
                    p.amount AS credit,
                    p.payment_date::timestamp AS sort_date -- Use payment_date for sorting
                FROM ${DB.PAYMENTS} p
                JOIN ${DB.INVOICES} i ON p.invoice_id = i.id
                WHERE i.student_id = $1::uuid
            ) combined_data
            ORDER BY sort_date ASC; -- Sorted by date
        `;

        const result = await pool.query(query, [studentId]);
        
        // Fetch Student Basic Info for Header
        const studentInfo = await pool.query(`
            SELECT u.username, s.roll_number, c.course_name, b.batch_name 
            FROM ${DB.STUDENTS} s 
            JOIN ${DB.USERS} u ON s.user_id=u.id 
            LEFT JOIN ${DB.COURSES} c ON s.course_id=c.id 
            LEFT JOIN ${DB.BATCHES} b ON s.batch_id=b.id 
            WHERE s.student_id=$1::uuid
        `, [studentId]);

        if (studentInfo.rows.length === 0) {
            return res.status(404).json({ message: "Student not found" });
        }

        res.json({
            student: studentInfo.rows[0],
            ledger: result.rows
        });

    } catch (error) {
        console.error("Ledger Error:", error);
        res.status(500).json({ message: 'Failed to generate ledger.' });
    }
});

// =========================================================
// SECTION 6: ADMIN UTILITIES (WAIVERS, DEFAULTERS)
// =========================================================

// 6.1 WAIVER REQUESTS
router.get('/waiver-requests', authenticateToken, authorize(FEE_ROLES), async (req, res) => {
    try { const r = await pool.query(`SELECT * FROM ${DB.WAIVERS} ORDER BY request_date DESC`); res.json(r.rows); } catch (e) { res.status(500).json({message:'Error'}); }
});

router.put('/waiver-requests/:requestId/status', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { requestId } = req.params; const { newStatus, amount } = req.body;
        await client.query(`UPDATE ${DB.WAIVERS} SET status=$1, processed_by=$2::uuid WHERE id=$3::uuid`, [newStatus, req.user.id, requestId]);
        
        if (newStatus === 'Approved' && amount > 0) {
            const wRes = await client.query(`SELECT student_id FROM ${DB.WAIVERS} WHERE id=$1::uuid`, [requestId]);
            const inv = await client.query(`SELECT id FROM ${DB.INVOICES} WHERE student_id=$1::uuid AND status!='Paid' LIMIT 1`, [wRes.rows[0].student_id]);
            if (inv.rows[0]) await client.query(`UPDATE ${DB.INVOICES} SET total_amount=total_amount-$1, discount_amount=COALESCE(discount_amount,0)+$1 WHERE id=$2::uuid`, [amount, inv.rows[0].id]);
        }
        await client.query('COMMIT'); res.json({message: `Waiver ${newStatus}`});
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({message: e.message}); } finally { client.release(); }
});

// =========================================================
// 6.2 DEFAULTERS LIST (FIXED: Correct Columns & Counts)
// =========================================================
router.get('/defaulters', authenticateToken, authorize(['admin', 'finance']), async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id, 
                u.username AS student_name,      -- Fixed: Alias for frontend display
                s.roll_number, 
                COALESCE(u.phone_number, 'N/A') AS parent_phone, -- Fixed: Fetch real phone
                c.course_name, 
                b.batch_name,                    -- Fixed: Added Batch Name
                COUNT(i.id) AS pending_invoices_count, -- Fixed: Added Invoice Count
                SUM(i.total_amount - i.paid_amount) AS total_due
            FROM ${DB.INVOICES} i
            JOIN ${DB.STUDENTS} s ON i.student_id = s.student_id
            JOIN ${DB.USERS} u ON s.user_id = u.id
            LEFT JOIN ${DB.COURSES} c ON s.course_id = c.id
            LEFT JOIN ${DB.BATCHES} b ON s.batch_id = b.id
            WHERE i.status NOT IN ('Paid', 'Waived')
            GROUP BY s.student_id, u.username, s.roll_number, u.phone_number, c.course_name, b.batch_name
            HAVING SUM(i.total_amount - i.paid_amount) > 0
            ORDER BY total_due DESC
        `;
        
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Defaulters Error:', error);
        res.status(500).json({ message: 'Failed to fetch defaulters list.' });
    }
});

router.post('/reminders/send', authenticateToken, async (req, res) => {
    // Simulating SMS Gateway
    const { students } = req.body;
    res.json({ message: `Simulated SMS sent to ${students?.length || 0} students.` });
});

module.exports = router;